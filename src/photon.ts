// Photon Spectrum bridge for the shared iMessage line: inbound messages go into inbound_events (same path as webhooks),
// outbound replies go back to the chat by its id — looked up again after a restart, so reminders and approvals still land.
// ponytail: long-lived stream in-process; switch to app.webhook() + SPECTRUM_WEBHOOK_SECRET when running more than one server.
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
export const photonTyping = async (spaceId: string) => { await (await spaceFor(spaceId)).startTyping?.(); };
export const photonEnabled = () => !!(process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID);

export async function startPhoton() {
  if (!photonEnabled()) return;
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  app = await Spectrum({ projectId: (process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID)!, projectSecret: (process.env.PHOTON_PROJECT_SECRET || process.env.PROJECT_SECRET)!, providers: [imessage.config()] });
  platform = (imessage as any)(app);
  console.log("[photon] iMessage line connected");
  (async () => {
    for await (const [space, m] of app.messages) {
      if (m.direction !== "inbound" || !m.sender) continue;
      spaces.set(space.id, space);
      const base = { provider: "imessage", providerEventId: m.id, conversationId: space.id, isGroup: (space as any).type === "group",
        senderId: m.sender.id, senderName: m.sender.id, type: "message" };
      const e = await toEvent(m.content).catch(() => null);
      if (!e) continue;
      exec("insert or ignore into inbound_events (id, provider, provider_event_id, channel_identity_id, raw, received_at) values (?,?,?,?,?,?)",
        id("inb"), "imessage", m.id, SHARED_ENV.imessage.id, S({ ...base, ...e }), now());
    }
  })().catch((err) => console.error("[photon] stream stopped:", err?.message));
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
