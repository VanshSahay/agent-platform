// Agents: a person owns several, each named, trained on its own, and deployed to the chats they choose.
import { sql, id, now, one } from "./db";

export const MIN_MEMORIES = 3;
export const agentsOf = (ownerId: string) => sql`select * from agents where owner_id=${ownerId} order by created_at`;
export const agentById = (aid: string) => one(sql`select * from agents where id=${aid}`);

export async function createAgent(owner: any, name: string, purpose?: string | null) {
  const aid = id("agt");
  await sql`insert into agents (id, owner_id, name, purpose, created_at) values (${aid}, ${owner.id}, ${String(name).trim().slice(0, 30) || "Assistant"}, ${purpose ? String(purpose).slice(0, 500) : null}, ${now()})`;
  if (!owner.default_agent_id) await sql`update users set default_agent_id=${aid} where id=${owner.id} and default_agent_id is null`;
  return agentById(aid);
}
/** The agent a person's own chat talks to; made on first need. */
export async function defaultAgentOf(user: any) {
  const a = user.default_agent_id ? await agentById(user.default_agent_id) : null;
  if (a) return a;
  const first = (await agentsOf(user.id))[0];
  if (first) { await sql`update users set default_agent_id=${first.id} where id=${user.id}`; return first; }
  return createAgent(user, "Assistant");
}
/** The agent in a room: the room's own, else its owner's default. */
export async function agentOf(room: any) {
  const a = room.agent_id ? await agentById(room.agent_id) : null;
  if (a) return a;
  const owner = room.owner_id ? await one(sql`select * from users where id=${room.owner_id}`) : null;
  const d = owner ? await defaultAgentOf(owner) : null;
  if (d) await sql`update rooms set agent_id=${d.id} where id=${room.id} and agent_id is null`;
  return d;
}
/** Trained enough to deploy: a name of its own and a few things learned. */
export async function readiness(agent: any) {
  const memories = Number((await one(sql`select count(*) n from memories where scope_type='agent' and scope_id=${agent.id}`))?.n ?? 0);
  const named = !!agent.name && agent.name !== "Assistant";
  return { named, memories, min_memories: MIN_MEMORIES, ready: named && memories >= MIN_MEMORIES };
}
/** "@Carl …" from the owner switches a room to that agent. Returns the agent if it switched. */
export async function switchByMention(room: any, user: any, text: string) {
  const m = text.match(/^\s*@([\p{L}\p{N}][\p{L}\p{N} '-]{0,29}?)(?=[\s,.:!?]|$)/u);
  if (!m || (room.owner_id && room.owner_id !== user.id)) return null;
  const want = m[1].trim().toLowerCase();
  const target = (await agentsOf(user.id)).find((a: any) => a.name.toLowerCase() === want);
  if (!target || target.id === room.agent_id) return null;
  await sql`update rooms set agent_id=${target.id} where id=${room.id}`;
  room.agent_id = target.id;
  return target;
}
