import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { slack } from "spectrum-ts/providers/slack";
import { telegram } from "spectrum-ts/providers/telegram";
import { whatsappBusiness } from "spectrum-ts/providers/whatsapp-business";
import type { ChannelKind } from "../core/types.ts";

/** The channels Photon Spectrum can carry. Each one is the same loop: a space is a room, a sender is a person. */
export const SPECTRUM_CHANNELS = {
  imessage: imessage,
  whatsapp: whatsappBusiness,
  telegram: telegram,
  slack: slack,
} as const;
export type SpectrumChannel = keyof typeof SPECTRUM_CHANNELS;
import type { App } from "../app.ts";
import type { Person, Room } from "../core/types.ts";
import type { Delivery } from "../runtime/runtime.ts";
import { findPersonByEmail } from "../store/queries.ts";
import { claimLinkCode, HandleRateLimit, handleMatches, normaliseHandle, personIdForHandle, plainText, roleForNewcomer } from "./handles.ts";

/**
 * iMessage through Photon Spectrum. Each iMessage chat (a DM or a group)
 * maps to one Room by its platform space id; each sender handle maps to one
 * Person. Strangers are guests, in a DM as much as in a group: served through
 * the owner until the owner promotes them. Outbound deliveries for an
 * iMessage room go back through the same space.
 *
 * Which agent a chat talks to: the first deployed agent (one agent per
 * deployment today). An owner is recognised by the phone number or email on
 * their Person record.
 */
export interface IMessageHandle {
  phone?: string;
  stop(): Promise<void>;
}

export async function startIMessage(app: App, cfg: { projectId: string; projectSecret: string }): Promise<IMessageHandle> {
  return startChannel(app, { ...cfg, channel: "imessage" });
}

/** One Spectrum provider as a channel: iMessage, WhatsApp Business, Telegram or Slack. */
export async function startChannel(app: App, cfg: { projectId: string; projectSecret: string; channel: SpectrumChannel }): Promise<IMessageHandle> {
  const provider = SPECTRUM_CHANNELS[cfg.channel] as unknown as typeof imessage;
  const channel: ChannelKind = cfg.channel;
  const spectrum = await Spectrum({ projectId: cfg.projectId, projectSecret: cfg.projectSecret, providers: [provider.config()] });
  const im = provider(spectrum);
  const phone = (spectrum.config as { imessage?: { phone?: string } } | undefined)?.imessage?.phone;
  const limiter = new HandleRateLimit();

  const agentFor = () => app.store.listAgents()[0];

  // The owner's own phone or email wins (compared normalised, so spacing never hides them); then any
  // person record carrying the handle; then the handle's derived id; then a fresh record. An existing
  // record is never overwritten: a derived id that already exists is simply reused.
  const personFor = (handle: string): Person => {
    const h = normaliseHandle(handle);
    for (const a of app.store.listAgents()) {
      const owner = app.store.getPerson(a.ownerId);
      if (owner && handleMatches(owner, h)) return owner;
    }
    const known = app.store.findPersonByPhone(h) ?? (h.includes("@") ? findPersonByEmail(app.store, h) : undefined);
    if (known) return known;
    const id = personIdForHandle(h);
    const existing = app.store.getPerson(id);
    if (existing) return existing;
    return app.rooms.createPerson({ id, displayName: h, timezone: "UTC", phoneE164: h.startsWith("+") ? h : undefined, email: h.includes("@") ? h : undefined });
  };

  const roomFor = (space: { id: string; type?: "dm" | "group" }, person: Person): Room | undefined => {
    const existing = app.store.findRoomByExternal(channel, space.id);
    if (existing) return existing;
    const agent = agentFor();
    if (!agent) return undefined;
    const kind = space.type === "group" ? "group" : "dm";
    const isOwner = person.id === agent.ownerId;
    const room = app.rooms.createRoom({
      agentId: agent.id,
      kind,
      channel,
      externalId: space.id,
      name: kind === "dm" ? `${agent.name} & ${person.displayName}` : `${channel} group ${space.id.slice(0, 6)}`,
    });
    app.rooms.addMember(room.id, person.id, roleForNewcomer({ isOwner, kind }), { consented: isOwner });
    return room;
  };

  // Outbound: deliveries addressed to an iMessage room go back to its space.
  const unsubscribe = app.onDeliver(async (d: Delivery) => {
    if (d.kind === "progress") return;
    const room = app.store.getRoom(d.roomId);
    if (room?.channel !== channel || !room.externalId) return;
    try {
      const space = await im.space.get(room.externalId);
      await spectrum.send(space, plainText(d.text));
    } catch (e) {
      console.error(`${channel} send failed`, (e as Error).message);
    }
  });

  // Inbound: one run per text message.
  (async () => {
    for await (const [space, message] of im.messages) {
      try {
        if (message.direction !== "inbound") continue;
        const content = message.content as { type: string; text?: string; markdown?: string };
        const text = content.type === "text" ? (content.text ?? "") : content.type === "markdown" ? (content.markdown ?? "") : "";
        if (!text.trim()) continue;
        const senderId = message.sender?.id;
        if (!senderId) continue;
        if (!limiter.allow(senderId)) {
          console.warn(`${channel}: rate limit for ${normaliseHandle(senderId).slice(0, 4)}…, dropping a message`);
          continue;
        }
        // A six-digit code from Settings links this handle to the signed-in person; no run starts.
        const linked = claimLinkCode(app.store, text, senderId, app.clock.now());
        if (linked) {
          await spectrum
            .send(space, plainText(`Linked: this number is now ${linked.displayName}'s. Text me here any time, or add me to a group chat and I'll be there too.`))
            .catch(() => undefined);
          continue;
        }
        const person = personFor(senderId);
        const room = roomFor(space as { id: string; type?: "dm" | "group" }, person);
        if (!room) continue;
        if (!app.store.getMembership(room.id, person.id)) app.rooms.addMember(room.id, person.id, "guest");
        await spectrum.responding(space, () => app.runtime.handleMessage({ roomId: room.id, personId: person.id, text, dedupKey: `${channel}:${message.id}` }));
      } catch (e) {
        console.error(`${channel} inbound failed`, (e as Error).message);
      }
    }
  })().catch((e) => console.error(`${channel} stream ended`, (e as Error).message));

  return {
    phone,
    async stop() {
      unsubscribe();
      await spectrum.stop();
    },
  };
}
