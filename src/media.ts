// Photos, voice notes and files people send, turned into text the agent can read. One cheap multimodal model via OpenRouter.
import { sql, id, now, one, recordUsage } from "./db";

export async function storeMedia(m: { name: string; mime: string; data: Uint8Array }) {
  const fid = id("fil");
  await sql`insert into files (id, name, mime, data, created_at) values (${fid}, ${m.name}, ${m.mime}, ${Buffer.from(m.data)}, ${now()})`;
  return fid;
}
export async function extractText(name: string, mime: string, buf: Uint8Array) {
  try {
    if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
      const { extractText: pdf, getDocumentProxy } = await import("unpdf");
      const { text } = await pdf(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true });
      return String(text).slice(0, 500_000);
    }
    if (/^text\/|json|xml|csv|markdown/.test(mime) || /\.(txt|md|csv|json|html?|xml|ya?ml|log|tsv)$/i.test(name)) return new TextDecoder().decode(buf).slice(0, 500_000);
  } catch {}
  return null;
}
const AUDIO: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/flac": "flac", "audio/webm": "webm" };

/** One line describing a stored attachment, ready to put in front of the agent. */
export async function describe(fileId: string, room: any, user: any) {
  await sql`update files set room_id=${room.id}, user_id=${user.id} where id=${fileId} and room_id is null`;
  const f = await one(sql`select * from files where id=${fileId}`);
  if (!f) return "";
  const data = new Uint8Array(f.data), who = user.name ?? "they", kind = /^image\//.test(f.mime) ? "photo" : /^audio\//.test(f.mime) ? "voice" : "file";
  if (kind === "file") {
    const text = await extractText(f.name, f.mime, data);
    if (text) await sql`update files set text=${text} where id=${fileId}`;
    return text ? `[${who} sent a file "${f.name}" (file id ${fileId}): ${text.slice(0, 3000)}${text.length > 3000 ? " …(files.read for the rest)" : ""}]` : `[${who} sent a file "${f.name}" (${f.mime}) I can't read]`;
  }
  const said = await understand(kind, f.mime, data, user.id);
  if (said) await sql`update files set text=${said} where id=${fileId}`;
  return kind === "photo" ? (said ? `[${who} sent a photo: ${said}]` : `[${who} sent a photo I can't see right now]`) : (said ? `[${who} sent a voice note: "${said}"]` : `[${who} sent a voice note I couldn't listen to]`);
}

async function understand(kind: "photo" | "voice", mime: string, data: Uint8Array, userId: string): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  if (kind === "voice" && !AUDIO[mime]) { const mp3 = await toMp3(data); if (!mp3) return null; data = mp3; mime = "audio/mpeg"; }
  const b64 = Buffer.from(data).toString("base64");
  const part = kind === "photo" ? { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } } : { type: "input_audio", input_audio: { data: b64, format: AUDIO[mime] } };
  const ask = kind === "photo" ? "Describe this photo in 1-3 plain sentences. If it contains text (receipt, menu, screenshot, ticket), transcribe the important text exactly, including amounts, dates and names." : "Transcribe this voice note exactly. Return only the transcript.";
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(45_000), headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.MEDIA_MODEL ?? "google/gemini-2.5-flash", max_tokens: 800, usage: { include: true }, messages: [{ role: "user", content: [{ type: "text", text: ask }, part] }] }) });
    const j: any = await r.json(), text = j.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    await recordUsage({ user_id: userId, kind: "media", qty: 1, cost_usd: Number(j.usage?.cost ?? 0) });
    return text.slice(0, 4000);
  } catch { return null; }
}
async function toMp3(data: Uint8Array): Promise<Uint8Array | null> {
  if (!Bun.which("ffmpeg")) return null;
  const { tmpdir } = await import("node:os"), { join } = await import("node:path"), { rm } = await import("node:fs/promises");
  const src = join(tmpdir(), `${id("aud")}.in`), dst = `${src}.mp3`;
  try {
    await Bun.write(src, data);
    if ((await Bun.spawn(["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", "-f", "mp3", dst], { stdout: "ignore", stderr: "ignore" }).exited) !== 0) return null;
    return new Uint8Array(await Bun.file(dst).arrayBuffer());
  } catch { return null; } finally { await rm(src, { force: true }); await rm(dst, { force: true }); }
}
