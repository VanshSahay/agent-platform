// People are phone numbers (and web accounts). A room is one chat: private (one person and one of their agents) or
// group (one agent, acting for the group). Each room has the agent that answers in it.
import { sql, id, now, one } from "./db";
import { agentOf, defaultAgentOf } from "./agents";

export const normPhone = (p: string) => { const d = String(p).replace(/[^\d+]/g, ""); return d.startsWith("+") ? d : d.length === 10 ? `+1${d}` : `+${d}`; };
export const shortPhone = (p: string) => `…${p.replace(/\D/g, "").slice(-4)}`;

export async function userByPhone(phone: string, create = true) {
  phone = normPhone(phone);
  const u = await one(sql`select * from users where phone=${phone}`);
  if (u || !create) return u;
  const uid = id("usr");
  await sql`insert into users (id, phone, created_at) values (${uid}, ${phone}, ${now()})`;
  return one(sql`select * from users where id=${uid}`);
}
export const userById = (uid: string) => one(sql`select * from users where id=${uid}`);
export const displayName = (u: any) => u?.name ?? `someone (${shortPhone(u?.phone ?? "")})`;

/** The room behind a Photon space. A private room belongs to the sender and talks to their default agent; a group's
 *  owner is the first known user who speaks, and its agent is that owner's default until they say "@Name". */
export async function roomForSpace(spaceId: string, isGroup: boolean, sender: any) {
  let room = await one(sql`select * from rooms where space_id=${spaceId}`);
  if (!room) {
    const rid = id("room"), agent = await defaultAgentOf(sender);
    await sql`insert into rooms (id, kind, space_id, owner_id, agent_id, name, created_at) values (${rid}, ${isGroup ? "group" : "private"}, ${spaceId}, ${sender.id}, ${agent.id}, ${isGroup ? "Group chat" : null}, ${now()})`;
    room = await one(sql`select * from rooms where id=${rid}`);
  }
  await addMember(room, sender);
  return room;
}
export const privateRoomOf = (userId: string) => one(sql`select * from rooms where kind='private' and channel='imessage' and owner_id=${userId}`);
export async function createPrivateRoom(user: any, spaceId: string) {
  const rid = id("room"), agent = await defaultAgentOf(user);
  await sql`insert into rooms (id, kind, space_id, owner_id, agent_id, created_at) values (${rid}, 'private', ${spaceId}, ${user.id}, ${agent.id}, ${now()})`;
  await sql`insert into room_members (room_id, user_id, joined_at) values (${rid}, ${user.id}, ${now()}) on conflict do nothing`;
  return one(sql`select * from rooms where id=${rid}`);
}
/** The training chat for one agent on the web: no phone needed. */
export async function webRoomOf(user: any, agent: any) {
  const r = await one(sql`select * from rooms where kind='private' and channel='web' and agent_id=${agent.id}`);
  if (r) return r;
  const rid = id("room");
  await sql`insert into rooms (id, kind, channel, owner_id, agent_id, name, created_at) values (${rid}, 'private', 'web', ${user.id}, ${agent.id}, ${"Training: " + agent.name}, ${now()})`;
  await sql`insert into room_members (room_id, user_id, joined_at) values (${rid}, ${user.id}, ${now()}) on conflict do nothing`;
  return one(sql`select * from rooms where id=${rid}`);
}

/** A member appearing in a group after the conversation started marks last_join_at: pending replies are held. */
export async function addMember(room: any, user: any) {
  if (await one(sql`select 1 from room_members where room_id=${room.id} and user_id=${user.id}`)) return false;
  await sql`insert into room_members (room_id, user_id, joined_at) values (${room.id}, ${user.id}, ${now()})`;
  if (room.kind === "group" && (await one(sql`select 1 from messages where room_id=${room.id}`))) await sql`update rooms set last_join_at=${now()} where id=${room.id}`;
  return true;
}
export const members = (roomId: string) => sql`select u.*, m.joined_at, m.consent_at from room_members m join users u on u.id=m.user_id where m.room_id=${roomId} order by m.joined_at`;
export const hasConsent = async (roomId: string, userId: string) => !!(await one(sql`select 1 from room_members where room_id=${roomId} and user_id=${userId} and consent_at is not null`));
export const grantConsent = (roomId: string, userId: string) => sql`update room_members set consent_at=${now()} where room_id=${roomId} and user_id=${userId}`;
export const revokeConsent = (roomId: string, userId: string) => sql`update room_members set consent_at=null where room_id=${roomId} and user_id=${userId}`;

/** Inbound (dedupes on the provider id: false = seen before) and outbound messages. */
export async function storeMessage(m: { roomId: string; senderId: string | null; direction: "in" | "out"; text: string; externalId?: string | null; runId?: string | null }) {
  const r = await sql`insert into messages (id, room_id, sender_id, direction, text, external_id, run_id, created_at) values (${id("msg")}, ${m.roomId}, ${m.senderId}, ${m.direction}, ${m.text}, ${m.externalId ?? null}, ${m.runId ?? null}, ${now()}) on conflict (external_id) do nothing returning id`;
  return r.length > 0;
}
export const recentMessages = (roomId: string, limit = 30) =>
  sql`select m.*, u.name sender_name, u.phone sender_phone from (select * from messages where room_id=${roomId} order by created_at desc limit ${limit}) m left join users u on u.id=m.sender_id order by m.created_at`;

export const agentNameFor = async (room: any) => (await agentOf(room))?.name ?? "Assistant";
