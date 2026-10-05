// What people send besides text — photos, voice notes, files — turned into text an agent can work with.
// Photos are described (and any text in them transcribed: receipts, menus, screenshots), voice notes transcribed, files read.
// Uses one cheap multimodal model on the platform's OpenRouter key; without it, the agent gets an honest placeholder.
import { exec, one, id, now, recordUsage } from "./db";

export type Media = { kind: "photo" | "voice" | "file"; name: string; mime: string; data: Uint8Array };

/** Text for agents to read: PDFs via unpdf, text-like files as UTF-8; anything else is stored but unreadable. */
export async function extractText(name: string, mime: string, buf: Uint8Array) {
  try {
    if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
      const { extractText: pdf, getDocumentProxy } = await import("unpdf");
      const { text } = await pdf(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true }); // a copy: the parser detaches what it reads
      return String(text).slice(0, 500_000);
    }
    if (/^text\/|json|xml|csv|markdown/.test(mime) || /\.(txt|md|csv|json|html?|xml|ya?ml|log|tsv)$/i.test(name)) return new TextDecoder().decode(buf).slice(0, 500_000);
  } catch {}
  return null;
}

/** Keep the bytes (so files.read works later) before anyone has looked at them. Room/workspace are filled in once routed. */
export function storeMedia(m: Media) {
  const fid = id("fil");
  exec("insert into files (id, workspace_id, room_id, name, mime, size, data, text, uploaded_by, created_at) values (?,?,?,?,?,?,?,?,?,?)",
    fid, null, null, m.name, m.mime, m.data.byteLength, Buffer.from(m.data), null, null, now());
  return fid;
}

const AUDIO_FORMAT: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg",
  "audio/aac": "aac", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/flac": "flac", "audio/aiff": "aiff", "audio/webm": "webm" };

/** One line of text describing a stored attachment, ready to put in front of the agent. */
export async function describe(fileId: string, ctx: { workspaceId: string; roomId: string; userId: string; sender: string }) {
  exec("update files set workspace_id=?, room_id=?, uploaded_by=? where id=? and workspace_id is null", ctx.workspaceId, ctx.roomId, ctx.userId, fileId);
  const f = one<any>("select * from files where id=?", fileId);
  if (!f) return "";
  const data = new Uint8Array(f.data);
  const kind = /^image\//.test(f.mime) ? "photo" : /^audio\//.test(f.mime) ? "voice" : "file";
  if (kind === "file") {
    const text = await extractText(f.name, f.mime, data);
    if (text) exec("update files set text=? where id=?", text, fileId);
    return text ? `[${ctx.sender} sent a file "${f.name}" (file id ${fileId}): ${text.slice(0, 3000)}${text.length > 3000 ? " …(use files.read for the rest)" : ""}]`
      : `[${ctx.sender} sent a file "${f.name}" (${f.mime}) that I can't read]`;
  }
  const said = await understand(kind, f.mime, data, ctx.workspaceId);
  if (said) exec("update files set text=? where id=?", said, fileId);
  return kind === "photo"
    ? (said ? `[${ctx.sender} sent a photo: ${said}]` : `[${ctx.sender} sent a photo — I can't see photos right now; ask them to describe it if it matters]`)
    : (said ? `[${ctx.sender} sent a voice note: "${said}"]` : `[${ctx.sender} sent a voice note — I couldn't listen to it; ask them to type it]`);
}

async function understand(kind: "photo" | "voice", mime: string, data: Uint8Array, workspaceId: string): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || process.env.MEDIA_UNDERSTANDING === "off") return null;
  if (kind === "voice" && !AUDIO_FORMAT[mime]) { // e.g. iMessage .caf voice memos: no model accepts the container, so transcode
    const mp3 = await toMp3(data);
    if (!mp3) return null;
    data = mp3; mime = "audio/mpeg";
  }
  const b64 = Buffer.from(data).toString("base64");
  const part = kind === "photo"
    ? { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
    : { type: "input_audio", input_audio: { data: b64, format: AUDIO_FORMAT[mime] } };
  const ask = kind === "photo"
    ? "Describe this photo in 1-3 plain sentences for someone who can't see it. If it contains text (receipt, menu, screenshot, ticket, sign), transcribe the important text exactly, including amounts, dates and names."
    : "Transcribe this voice note exactly. Return only the transcript.";
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(45_000), headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.MEDIA_MODEL ?? "google/gemini-2.5-flash", max_tokens: 800, messages: [{ role: "user", content: [{ type: "text", text: ask }, part] }] }),
    });
    const j: any = await r.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    recordUsage({ workspace_id: workspaceId, kind: kind === "photo" ? "photo_understanding" : "voice_transcription", qty: 1 });
    return text.slice(0, 4000);
  } catch { return null; }
}

/** Any audio → 16 kHz mono MP3 via ffmpeg (installed in the server image). null when ffmpeg isn't available or fails. */
export async function toMp3(data: Uint8Array): Promise<Uint8Array | null> {
  if (!Bun.which("ffmpeg")) return null;
  const { tmpdir } = await import("node:os"), { join } = await import("node:path"), { rm } = await import("node:fs/promises");
  const src = join(tmpdir(), `${id("aud")}.in`), dst = `${src}.mp3`;
  try {
    await Bun.write(src, data);
    const p = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", "-f", "mp3", dst], { stdout: "ignore", stderr: "ignore" });
    if ((await p.exited) !== 0) return null;
    return new Uint8Array(await Bun.file(dst).arrayBuffer());
  } catch { return null; } finally { await rm(src, { force: true }); await rm(dst, { force: true }); }
}
