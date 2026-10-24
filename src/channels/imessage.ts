import { Spectrum } from "spectrum-ts";
import { localIMessage } from "@spectrum-ts/imessage-local";
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
import { agentForChannel } from "../agent/routing.ts";
import { claimLinkCode, groupRoomName, HandleRateLimit, handleMatches, isDefaultRoomName, normaliseHandle, personIdForHandle, plainText, roleForNewcomer } from "./handles.ts";

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
  /** The line's number on a dedicated line; "shared" on the free and Pro plans, where each person gets their own number from a pool. */
  phone?: string;
  mode: "dedicated" | "shared";
  /** Shared pool: register a person's iMessage handle with Photon and learn the number the pool assigned them. */
  register(phone: string, name: string): Promise<{ assignedPhone: string }>;
  /** Shared pool: the number already assigned to this handle, if registered. */
  assigned(phone: string): Promise<string | undefined>;
  /** Open (or reuse) a one-to-one chat with a handle and send one text, so the person has the number in Messages. */
  textFirst(phone: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Photon's Spectrum REST API for the project's users (the allowlist of the shared pool). Basic auth with the
 * project's own credentials, which never leave the server. On the free plan a line cannot be bought
 * (business plan only), so this is how a person gets a number to text: register, then text them first.
 */
function spectrumUsers(cfg: { projectId: string; projectSecret: string }) {
  const base = `https://spectrum.photon.codes/projects/${encodeURIComponent(cfg.projectId)}/users/`;
  const headers = { authorization: `Basic ${Buffer.from(`${cfg.projectId}:${cfg.projectSecret}`).toString("base64")}`, "content-type": "application/json" };
  type User = { id: string; phoneNumber?: string; email?: string; assignedPhoneNumber?: string };
  const find = async (phone: string): Promise<User | undefined> => {
    const res = await fetch(`${base}?type=shared&search=${encodeURIComponent(phone)}&limit=50`, { headers });
    if (!res.ok) throw new Error(`Photon users ${res.status}`);
    const body = (await res.json()) as { data?: { users?: User[] } };
    return (body.data?.users ?? []).find((u) => normaliseHandle(u.phoneNumber ?? "") === normaliseHandle(phone));
  };
  return {
    find,
    async create(phone: string, name: string): Promise<User> {
      const [firstName, ...rest] = name.trim().split(/\s+/);
      const res = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "shared", phoneNumber: phone, firstName: firstName || undefined, lastName: rest.join(" ") || undefined }),
      });
      if (!res.ok) throw new Error(`Photon could not register that number (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data?: User };
      return body.data ?? ((await find(phone)) as User);
    },
  };
}

export async function startIMessage(app: App, cfg: { projectId: string; projectSecret: string }): Promise<IMessageHandle> {
  return startChannel(app, { ...cfg, channel: "imessage" });
}

/**
 * One Spectrum provider as a channel: iMessage, WhatsApp Business, Telegram or Slack. With `local: true` the
 * iMessage provider is this Mac's own Messages app (Photon's open-source local mode): no project credentials,
 * the Apple ID signed into Messages is the agent's handle, existing group chats work, no reactions or typing.
 */
export async function startChannel(app: App, cfg: { projectId?: string; projectSecret?: string; channel: SpectrumChannel; local?: boolean }): Promise<IMessageHandle> {
  const local = !!cfg.local && cfg.channel === "imessage";
  const provider = (local ? localIMessage : SPECTRUM_CHANNELS[cfg.channel]) as unknown as typeof imessage;
  const channel: ChannelKind = cfg.channel;
  const spectrum = local
    ? await Spectrum({ providers: [provider.config()] })
    : await Spectrum({ projectId: cfg.projectId ?? "", projectSecret: cfg.projectSecret ?? "", providers: [provider.config()] });
  const im = provider(spectrum);
  // Spectrum does not always report the line's number; IMESSAGE_PHONE (from the Photon dashboard, or the Apple ID
  // signed into Messages in local mode) fills it in for Settings.
  const phone = ((spectrum as { config?: { imessage?: { phone?: string } } }).config?.imessage?.phone ?? process.env.IMESSAGE_PHONE) || (local ? "this Mac's Messages" : undefined);
  const limiter = new HandleRateLimit();

  const agentFor = () => agentForChannel(app.store, channel);

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

  const roomFor = (space: { id: string; type?: "dm" | "group" }, person: Person): { room: Room; created: boolean } | undefined => {
    const existing = app.store.findRoomByExternal(channel, space.id);
    if (existing) return { room: existing, created: false };
    const agent = agentFor();
    if (!agent) return undefined;
    const kind = space.type === "group" ? "group" : "dm";
    const isOwner = person.id === agent.ownerId;
    const room = app.rooms.createRoom({
      agentId: agent.id,
      kind,
      channel,
      externalId: space.id,
      name: kind === "dm" ? `${agent.name} & ${person.displayName}` : groupRoomName(channel, [person.displayName]),
    });
    app.rooms.addMember(room.id, person.id, roleForNewcomer({ isOwner, kind }), { consented: isOwner });
    return { room, created: true };
  };

  // Outbound: deliveries addressed to an iMessage room go back to its space.
  const unsubscribe = app.onDeliver(async (d: Delivery) => {
    if (d.kind === "progress") return; // narration stays in the app; the "on it" ack does go out
    const room = app.store.getRoom(d.roomId);
    if (room?.channel !== channel || !room.externalId) return;
    // A card for one person (a sign-in, an approval) goes to their own chat with the assistant, not the group thread.
    if (d.visibleTo?.length && room.kind === "group") return;
    try {
      const space = await im.space.get(room.externalId);
      // A card in Messages is plain text; the app has the buttons and the sign-in browser, so link it.
      const link = d.kind === "card" && process.env.PUBLIC_URL ? `\n\nOr open it in the app: ${process.env.PUBLIC_URL}/#room=${room.id}` : "";
      await spectrum.send(space, plainText(d.text) + link);
    } catch (e) {
      app.ops.error(`${channel} send`, e);
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
        // An eight-digit code from Settings links this handle to the signed-in person; no run starts.
        const linked = claimLinkCode(app.store, text, senderId, app.clock.now());
        if (linked) {
          // The handle's derived record (a stranger who texted before signing up) is the same
          // human: memberships, memories and profiles move onto the signed-in person.
          const derived = app.store.getPerson(personIdForHandle(normaliseHandle(senderId)));
          if (derived && derived.id !== linked.id && !derived.mergedInto) app.rooms.mergePeople(linked.id, derived.id);
          // Tell the person on their own chat, so a link they did not make is seen the same day.
          const agent = agentFor();
          if (agent)
            app.runtime.notify(
              agent,
              linked.id,
              `${normaliseHandle(senderId)} was just linked to your account by texting your code. If that wasn't you, remove it under Settings → Channels.`,
            );
          await spectrum
            .send(space, plainText(`Linked: this number is now ${linked.displayName}'s. Text me here any time, or add me to a group chat and I'll be there too.`))
            .catch(() => undefined);
          continue;
        }
        const person = personFor(senderId);
        const found = roomFor(space as { id: string; type?: "dm" | "group" }, person);
        if (!found) continue;
        const { room, created } = found;
        if (!app.store.getMembership(room.id, person.id)) {
          app.rooms.addMember(room.id, person.id, "guest");
          // Until the owner names the group, its name is who is in it.
          if (room.kind === "group" && isDefaultRoomName(room.name)) {
            room.name = groupRoomName(
              channel,
              app.rooms.memberIds(room.id).map((id) => app.store.getPerson(id)?.displayName ?? id),
            );
            app.store.putRoom(room);
          }
        }
        // First contact with a new group: introduce the agent once and tell the owner. The first
        // message waits for the introduction, so two runs never race in one new chat.
        const joined = created && room.kind === "group" ? app.runtime.groupJoined(room, person).catch((e) => app.ops.error(`${channel} group join`, e)) : Promise.resolve();
        // Not awaited: a run can take minutes, and the next text (another chat, or a steer
        // for this one) must be read while it runs.
        void joined
          .then(() => spectrum.responding(space, () => app.runtime.handleMessage({ roomId: room.id, personId: person.id, text, dedupKey: `${channel}:${message.id}` })))
          .catch((e) => app.ops.error(`${channel} run`, e));
      } catch (e) {
        app.ops.error(`${channel} inbound`, e);
      }
    }
  })()
    // The loop only ends when the provider drops us; say so on /health instead of answering nobody quietly.
    .then(() => app.ops.channel(channel, "down", "stream ended"))
    .catch((e) => {
      app.ops.channel(channel, "down", (e as Error).message);
      app.ops.error(`${channel} stream`, e);
    });

  // Local mode has no pool: anyone can text the Mac's handle or add it to a group, so register is a no-op.
  const users = local
    ? { find: async () => undefined, create: async (phone: string) => ({ id: phone, phoneNumber: phone, assignedPhoneNumber: phone }) }
    : spectrumUsers({ projectId: cfg.projectId ?? "", projectSecret: cfg.projectSecret ?? "" });
  const mode = phone && phone !== "shared" ? "dedicated" : "shared";
  return {
    phone: mode === "dedicated" ? phone : undefined,
    mode,
    async register(handle, name) {
      const u = (await users.find(handle)) ?? (await users.create(handle, name));
      if (!u.assignedPhoneNumber) throw new Error("Photon registered the number but assigned no line yet; try again in a minute.");
      return { assignedPhone: u.assignedPhoneNumber };
    },
    async assigned(handle) {
      return (await users.find(handle).catch(() => undefined))?.assignedPhoneNumber;
    },
    async textFirst(handle, text) {
      const space = await im.space.create(handle);
      await spectrum.send(space, plainText(text));
    },
    async stop() {
      unsubscribe();
      await spectrum.stop();
    },
  };
}
