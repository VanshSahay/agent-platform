import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { App } from "../app.ts";
import type { Room } from "../core/types.ts";
import type { Delivery } from "../runtime/runtime.ts";

/**
 * iMessage through Photon Spectrum. Each iMessage chat (a DM or a group)
 * maps to one Room by its platform space id; each sender handle maps to one
 * Person. Guests are created on first message and served through the owner,
 * exactly as in the web channel. Outbound deliveries for an iMessage room go
 * back through the same space.
 *
 * Which agent a chat talks to: the first deployed agent (one agent per
 * deployment today). An owner is recognised by phone number or email on
 * their Person record; everyone else in a group is a guest until promoted.
 */
export interface IMessageHandle {
  phone?: string;
  stop(): Promise<void>;
}

export async function startIMessage(app: App, cfg: { projectId: string; projectSecret: string }): Promise<IMessageHandle> {
  const spectrum = await Spectrum({ projectId: cfg.projectId, projectSecret: cfg.projectSecret, providers: [imessage.config()] });
  const im = imessage(spectrum);
  const phone = (spectrum.config as { imessage?: { phone?: string } } | undefined)?.imessage?.phone;

  const agentFor = () => app.store.listAgents().find((a) => a.deployedAt) ?? app.store.listAgents()[0];

  const roomFor = (space: { id: string; type?: "dm" | "group" }, senderId: string): Room | undefined => {
    const existing = app.store.findRoomByExternal("imessage", space.id);
    if (existing) return existing;
    const agent = agentFor();
    if (!agent) return undefined;
    const kind = space.type === "group" ? "group" : "dm";
    const person = personFor(senderId);
    const room = app.rooms.createRoom({ agentId: agent.id, kind, channel: "imessage", externalId: space.id, name: kind === "dm" ? `${agent.name} & ${person.displayName}` : `iMessage group ${space.id.slice(0, 6)}` });
    app.rooms.addMember(room.id, person.id, person.id === agent.ownerId ? "owner" : kind === "dm" ? "member" : "guest", { consented: person.id === agent.ownerId });
    return room;
  };

  const personFor = (handle: string) => {
    const byPhone = app.store.findPersonByPhone(handle);
    if (byPhone) return byPhone;
    const mapped = app.store.getKv(`imessage:${handle}`);
    if (mapped) {
      const p = app.store.getPerson(mapped);
      if (p) return p;
    }
    const p = app.rooms.createPerson({ id: `per_im_${handle.replace(/[^a-z0-9]/gi, "").toLowerCase()}`, displayName: handle, timezone: "UTC", phoneE164: handle.startsWith("+") ? handle : undefined });
    app.store.setKv(`imessage:${handle}`, p.id);
    return p;
  };

  // Outbound: deliveries addressed to an iMessage room go back to its space.
  const unsubscribe = app.onDeliver(async (d: Delivery) => {
    if (d.kind === "progress") return;
    const room = app.store.getRoom(d.roomId);
    if (!room || room.channel !== "imessage" || !room.externalId) return;
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
        const room = roomFor(space as { id: string; type?: "dm" | "group" }, senderId);
        if (!room) continue;
        const person = personFor(senderId);
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
