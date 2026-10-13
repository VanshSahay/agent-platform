// iMessage through Photon Spectrum. Inbound messages go to the agent; outbound replies go back to the chat by its id
// (looked up again after a restart, so reminders and approvals still land). Stream by default; signed webhooks with
// SPECTRUM_WEBHOOK_SECRET set.
import { storeMedia } from "./media";

export interface Inbound { spaceId: string; isGroup: boolean; phone: string; text: string; externalId: string; reaction?: { emoji: string; targetId: string }; attachments?: string[] }

let app: any = null, platform: any = null;
const spaces = new Map<string, any>();
export const status = { enabled: false, connected: false, since: 0, last_event_at: 0, reconnects: 0, last_error: "" };
export const enabled = () => !!(process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID);
/** Tests swap the line for a fake. */
export const hooks: { send: null | ((spaceId: string, text: string) => Promise<string | undefined>); startDm: null | ((phone: string, text: string) => Promise<string>) } = { send: null, startDm: null };
let onInbound: (ev: Inbound) => Promise<unknown> = async () => {};
export const onMessage = (fn: typeof onInbound) => { onInbound = fn; };

async function spaceFor(spaceId: string) {
  if (spaces.has(spaceId)) return spaces.get(spaceId);
  if (!platform) throw new Error("iMessage line isn't connected");
  const s = await platform.space.get(spaceId);
  spaces.set(spaceId, s);
  return s;
}
export async function send(spaceId: string, text: string): Promise<string | undefined> {
  if (hooks.send) return hooks.send(spaceId, text);
  return (await (await spaceFor(spaceId)).send(text))?.id;
}
/** Shared-pool lines can't be texted first by people, so the agent opens the DM. Returns the chat id. */
export async function startDm(phone: string, text: string): Promise<string> {
  if (hooks.startDm) return hooks.startDm(phone, text);
  if (!platform) throw new Error("iMessage line isn't connected");
  const space = await platform.space.create(phone);
  spaces.set(space.id, space);
  await space.send(text);
  return space.id;
}
export const typing = async (spaceId: string) => { if (!hooks.send) await (await spaceFor(spaceId)).startTyping?.().catch(() => {}); };

async function connect() {
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  const webhookSecret = process.env.SPECTRUM_WEBHOOK_SECRET;
  app = await Spectrum({ projectId: (process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID)!, projectSecret: (process.env.PHOTON_PROJECT_SECRET || process.env.PROJECT_SECRET)!, providers: [imessage.config()], ...(webhookSecret ? { webhookSecret } : {}) });
  platform = (imessage as any)(app);
  spaces.clear();
  Object.assign(status, { connected: true, since: Date.now(), last_error: "" });
}

export async function start() {
  if (!enabled()) { console.warn("[imessage] no Photon project configured; the line is off"); return; }
  status.enabled = true;
  await connect();
  if (process.env.SPECTRUM_WEBHOOK_SECRET) { console.log("[imessage] connected (webhook mode: POST /webhooks/photon)"); return; }
  console.log("[imessage] connected (stream)");
  (async () => {
    for (let wait = 1000; ; wait = Math.min(wait * 2, 60_000)) {
      try { for await (const [space, m] of app.messages) { status.last_event_at = Date.now(); wait = 1000; await ingest(space, m).catch((e) => console.error("[imessage] inbound failed", e)); } status.last_error = "stream ended"; }
      catch (err: any) { status.last_error = String(err?.message ?? err).slice(0, 200); }
      status.connected = false;
      console.error(`[imessage] stream down (${status.last_error}); reconnecting in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      try { await app?.stop?.(); } catch {}
      try { await connect(); status.reconnects++; console.log("[imessage] reconnected"); } catch (err: any) { status.last_error = `reconnect failed: ${String(err?.message ?? err).slice(0, 160)}`; }
    }
  })();
}
export async function webhook(req: Request) {
  if (!app || !process.env.SPECTRUM_WEBHOOK_SECRET) return new Response("iMessage webhooks aren't enabled", { status: 404 });
  return app.webhook(req, (space: any, m: any) => ingest(space, m));
}

async function ingest(space: any, m: any) {
  if (m.direction !== "inbound" || !m.sender) return;
  spaces.set(space.id, space);
  const c = m.content, base = { spaceId: space.id, isGroup: space.type === "group", phone: String(m.sender.id), externalId: String(m.id) };
  switch (c?.type) {
    case "text": return onInbound({ ...base, text: c.text ?? "" });
    case "richlink": return onInbound({ ...base, text: c.url ?? "" });
    case "reaction": return c.target?.id ? onInbound({ ...base, text: "", reaction: { emoji: c.emoji, targetId: String(c.target.id) } }) : undefined;
    case "attachment": case "voice": {
      const data = new Uint8Array(await c.read()), mime = c.mimeType ?? "application/octet-stream";
      return onInbound({ ...base, text: "", attachments: [await storeMedia({ name: c.name ?? c.type, mime, data })] });
    }
    case "contact": return onInbound({ ...base, text: `[shared a contact: ${c.name?.formatted ?? ([c.name?.first, c.name?.last].filter(Boolean).join(" ") || "unnamed")}${c.phones?.[0]?.value ? `, ${c.phones[0].value}` : ""}]` });
    default: return; // typing, reads, renames: not messages to the agent
  }
}
