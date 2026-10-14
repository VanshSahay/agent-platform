import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { App } from "../app.ts";
import type { Person, Room } from "../core/types.ts";
import type { Delivery } from "../runtime/runtime.ts";
import { findPersonByEmail } from "../store/queries.ts";
import { HandleRateLimit, handleMatches, normaliseHandle, personIdForHandle, roleForNewcomer } from "./handles.ts";

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
  const spectrum = await Spectrum({ projectId: cfg.projectId, projectSecret: cfg.projectSecret, providers: [imessage.config()] });
  const im = imessage(spectrum);
  const phone = (spectrum.config as { imessage?: { phone?: string } } | undefined)?.imessage?.phone;
  const limiter = new HandleRateLimit();

  const agentFor = () => app.store.listAgents().find((a) => a.deployedAt) ?? app.store.listAgents()[0];

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
    const existing = app.store.findRoomByExternal("imessage", space.id);
    if (existing) return existing;
    const agent = agentFor();
    if (!agent) return undefined;
    const kind = space.type === "group" ? "group" : "dm";
    const isOwner = person.id === agent.ownerId;
    // An agent still in training stays in its owner's private chat; a group would let it loose on strangers.
    if (kind === "group" && !agent.deployedAt) {
      console.log(`iMessage: ignoring group ${space.id.slice(0, 6)} until ${agent.name} is deployed`);
      return undefined;
    }
    const room = app.rooms.createRoom({
      agentId: agent.id,
      kind,
      channel: "imessage",
      externalId: space.id,
      name: kind === "dm" ? `${agent.name} & ${person.displayName}` : `iMessage group ${space.id.slice(0, 6)}`,
    });
    app.rooms.addMember(room.id, person.id, roleForNewcomer({ isOwner, kind }), { consented: isOwner });
    return room;
  };

  // Outbound: deliveries addressed to an iMessage room go back to its space.
  const unsubscribe = app.onDeliver(async (d: Delivery) => {
    if (d.kind === "progress") return;
    const room = app.store.getRoom(d.roomId);
    if (room?.channel !== "imessage" || !room.externalId) return;
    try {
      const space = await im.space.get(room.externalId);
      await spectrum.send(space, d.text);
    } catch (e) {
      console.error("iMessage send failed", (e as Error).message);
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
          console.warn(`iMessage: rate limit for ${normaliseHandle(senderId).slice(0, 4)}…, dropping a message`);
          continue;
        }
        const person = personFor(senderId);
        const room = roomFor(space as { id: string; type?: "dm" | "group" }, person);
        if (!room) continue;
        if (!app.store.getMembership(room.id, person.id)) app.rooms.addMember(room.id, person.id, "guest");
        await spectrum.responding(space, () => app.runtime.handleMessage({ roomId: room.id, personId: person.id, text, dedupKey: `imessage:${message.id}` }));
      } catch (e) {
        console.error("iMessage inbound failed", (e as Error).message);
      }
    }
  })().catch((e) => console.error("iMessage stream ended", (e as Error).message));

  return {
    phone,
    async stop() {
      unsubscribe();
      await spectrum.stop();
    },
  };
}
