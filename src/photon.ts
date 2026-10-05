// Photon Spectrum bridge for the shared iMessage line: inbound messages go into inbound_events (same path as webhooks),
// outbound replies go back to the chat by its id — looked up again after a restart, so reminders and approvals still land.
// Two modes: a long-lived stream (one server), or with SPECTRUM_WEBHOOK_SECRET set, signed webhooks to POST /v1/webhooks/photon
// so any number of servers can sit behind a load balancer (sends never needed the stream: chats are looked up by id).
import { exec, id, now, S } from "./db";
import { SHARED_ENV } from "./channels";
import { storeMedia } from "./media";

let app: any = null, platform: any = null;
const spaces = new Map<string, any>(); // space id -> Spectrum Space seen this process (cache; space.get rebuilds it after a restart)

async function spaceFor(spaceId: string) {
  const cached = spaces.get(spaceId);
  if (cached) return cached;
  if (!platform) throw new Error("iMessage line isn't connected");
  const s = await platform.space.get(spaceId);
  spaces.set(spaceId, s);
  return s;
}
export const photonSend = async (spaceId: string, text: string) => (await (await spaceFor(spaceId)).send(text))?.id as string | undefined;
/** Shared-pool lines can't be texted first by people (each person gets a pool number), so the agent opens the DM. Returns the chat id. */
export async function photonStartDm(phone: string, text: string) {
  if (!platform) throw new Error("iMessage line isn't connected");
  const space = await platform.space.create(phone);
  spaces.set(space.id, space);
  await space.send(text);
  return space.id as string;
}
export const photonTyping = async (spaceId: string) => { await (await spaceFor(spaceId)).startTyping?.(); };
export const photonEnabled = () => !!(process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID);

/** Line health for the operator view: is the stream up, when did we last hear from it, how often has it dropped. */
export const photonStatus = { enabled: false, mode: "off" as "off" | "stream" | "webhook", connected: false, since: 0, last_event_at: 0, reconnects: 0, last_error: "" };

async function connect() {
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  const webhookSecret = process.env.SPECTRUM_WEBHOOK_SECRET;
  app = await Spectrum({ projectId: (process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID)!, projectSecret: (process.env.PHOTON_PROJECT_SECRET || process.env.PROJECT_SECRET)!,
    providers: [imessage.config()], ...(webhookSecret ? { webhookSecret } : {}) });
  platform = (imessage as any)(app);
  spaces.clear(); // rebuilt lazily by id (space.get) — old handles belong to the dead connection
  Object.assign(photonStatus, { connected: true, since: Date.now(), last_error: "" });
}

export async function startPhoton() {
  if (!photonEnabled()) return;
  photonStatus.enabled = true;
  photonStatus.mode = process.env.SPECTRUM_WEBHOOK_SECRET ? "webhook" : "stream";
  await connect();
  if (photonStatus.mode === "webhook") { console.log("[photon] iMessage line connected (webhook mode: POST /v1/webhooks/photon)"); return; }
  console.log("[photon] iMessage line connected (stream)");
  // The stream can end or throw (network blip, Photon deploy). Reconnect with backoff, forever; messages missed while down are
  // redelivered by Photon on reconnect, and inbound_events dedupes on the provider id.
  (async () => {
    for (let wait = 1000; ; wait = Math.min(wait * 2, 60_000)) {
      try { for await (const [space, m] of app.messages) { photonStatus.last_event_at = Date.now(); wait = 1000; await ingest(space, m); } photonStatus.last_error = "stream ended"; }
      catch (err: any) { photonStatus.last_error = String(err?.message ?? err).slice(0, 200); }
      photonStatus.connected = false;
      console.error(`[photon] stream down (${photonStatus.last_error}); reconnecting in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      try { await app?.stop?.(); } catch {}
      try { await connect(); photonStatus.reconnects++; console.log("[photon] reconnected"); }
      catch (err: any) { photonStatus.last_error = `reconnect failed: ${String(err?.message ?? err).slice(0, 160)}`; }
    }
  })();
}

/** Webhook mode: Spectrum verifies the signature (bad → 401); each message is stored once (dedupe on its id). */
export async function photonWebhook(req: Request) {
  if (!app || !process.env.SPECTRUM_WEBHOOK_SECRET) return new Response("iMessage webhooks aren't enabled", { status: 404 });
  return app.webhook(req, (space: any, m: any) => ingest(space, m));
}

async function ingest(space: any, m: any) {
  photonStatus.last_event_at = Date.now();
  if (m.direction !== "inbound" || !m.sender) return;
  spaces.set(space.id, space);
  const base = { provider: "imessage", providerEventId: m.id, conversationId: space.id, isGroup: space.type === "group", senderId: m.sender.id, senderName: m.sender.id, type: "message" };
  const e = await toEvent(m.content).catch(() => null);
  if (!e) return;
  exec("insert or ignore into inbound_events (id, provider, provider_event_id, channel_identity_id, raw, received_at) values (?,?,?,?,?,?)",
    id("inb"), "imessage", m.id, SHARED_ENV.imessage.id, S({ ...base, ...e }), now());
}

/** Spectrum content → the parts of an InboundEvent we use. Bytes are stored right away (inbound_events holds JSON only). */
async function toEvent(c: any): Promise<{ text: string; attachments?: string[]; reaction?: { emoji: string; targetId: string } } | null> {
  switch (c?.type) {
    case "text": return { text: c.text };
    case "richlink": return { text: c.url };
    case "reaction": return c.target?.id ? { text: "", reaction: { emoji: c.emoji, targetId: c.target.id } } : null;
    case "attachment": case "voice": {
      const data = new Uint8Array(await c.read());
      const mime = c.mimeType ?? "application/octet-stream";
      return { text: "", attachments: [storeMedia({ kind: c.type === "voice" || /^audio\//.test(mime) ? "voice" : /^image\//.test(mime) ? "photo" : "file", name: c.name ?? c.type, mime, data })] };
    }
    case "contact": {
      const n = c.name?.formatted ?? [c.name?.first, c.name?.last].filter(Boolean).join(" ");
      const phone = c.phones?.[0]?.value ?? c.phones?.[0]?.number ?? "";
      return { text: `[shared a contact: ${n || "unnamed"}${phone ? `, ${phone}` : ""}]` };
    }
    default: return null; // typing, reads, renames, polls: not messages to the agent
  }
}

/** The channel layer talks to Photon through this object (tests swap it for a fake line). */
export const photon = { enabled: photonEnabled, send: photonSend, typing: photonTyping, startDm: photonStartDm };
