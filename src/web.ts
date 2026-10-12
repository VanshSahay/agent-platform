// The signed-in web app's API: train the agent in a web chat, see and edit its memory, set the trust dial, link a
// phone to deploy it to iMessage, and see chats, connections, reminders and what it did.
import { sql, now, one, J, fmtLocal } from "./db";
import { userOf, AuthError } from "./auth";
import { makeLink } from "./links";
import { normPhone, userByPhone, privateRoomOf, webRoomOf } from "./rooms";
import * as agent from "./agent";
import { addMcpConnection } from "./tools/mcp";
import { storeMedia } from "./media";
import { remember, forget, KINDS } from "./memory";
import { TOOLS } from "./tools/index";

const json = (d: any, status = 200) => Response.json(d, { status });
type H = (req: Request, user: any, params: Record<string, string>) => Promise<any>;
const h = (fn: H) => async (req: Request & { params?: Record<string, string> }) => {
  try { return json(await fn(req, await userOf(req), req.params ?? {})); }
  catch (e: any) { if (e instanceof AuthError) return json({ error: e.message }, 401); if (!e.status) console.error("[web]", e); return json({ error: e.message ?? "internal error" }, e.status ?? 400); }
};
const body = (r: Request) => r.json().catch(() => ({}));
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };

/** Step 1: the agent texts a 6-digit code to the number. Step 2: the person types it here; the web account and the
 *  phone's person become one row (the phone's row keeps its history). */
export async function linkPhoneStart(user: any, raw: string) {
  const r = await readiness(user);
  if (!r.ready) fail(403, `train it first: ${r.named ? "" : "give it a name, and "}teach it at least ${MIN_MEMORIES} things (it knows ${r.memories})`);
  const phone = normPhone(raw);
  if (!/^\+1\d{10}$/.test(phone)) fail(400, "US or Canada number, please");
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await sql`delete from links where user_id=${user.id} and purpose='phone'`;
  await makeLink(user.id, "phone", { code, phone }, 10 * 60_000);
  const target = await userByPhone(phone);
  const room = (await privateRoomOf(target.id)) ?? await agent.startConversation(phone);
  await agent.say(room, `Your sign-in code is ${code}. It expires in 10 minutes.`);
  return { sent: true };
}
export async function linkPhoneVerify(user: any, code: string) {
  const link = await one(sql`select * from links where user_id=${user.id} and purpose='phone' and expires_at>${now()}`);
  const st = J(link?.state, {});
  if (!link || String(st.code) !== String(code).trim()) fail(400, "that code is wrong or expired");
  await sql`delete from links where token=${link.token}`;
  const target = await userByPhone(st.phone);
  if (target.id === user.id) return user;
  if (target.clerk_id && target.clerk_id !== user.clerk_id) fail(409, "that number is already linked to another account");
  // The web account trained the agent first: its memories, web chat and settings move to the phone's row, which keeps its own history.
  await sql`delete from links where user_id=${user.id}`;
  await sql`update users set clerk_id=null where id=${user.id}`;
  await sql`update users set clerk_id=${user.clerk_id}, email=coalesce(email, ${user.email}), name=coalesce(name, ${user.name}), agent_name=coalesce(agent_name, ${user.agent_name}), tz=${user.tz}, auto_tools=${JSON.stringify(user.auto_tools ?? [])}::text::jsonb, onboarded=(onboarded or ${!!user.onboarded}) where id=${target.id}`;
  await sql`update memories set scope_id=${target.id} where scope_type='private' and scope_id=${user.id}`;
  await sql`update rooms set owner_id=${target.id} where owner_id=${user.id}`;
  await sql`update room_members set user_id=${target.id} where user_id=${user.id}`;
  await sql`update messages set sender_id=${target.id} where sender_id=${user.id}`;
  await sql`update runs set requester_id=${target.id} where requester_id=${user.id}`;
  await sql`update schedules set user_id=${target.id} where user_id=${user.id}`;
  await sql`update connections set user_id=${target.id} where user_id=${user.id}`;
  await sql`delete from users where id=${user.id} and phone is null`;
  const merged = await one(sql`select * from users where id=${target.id}`);
  const dm = await privateRoomOf(target.id);
  if (dm && merged.agent_name) await agent.say(dm, `Linked. I'm ${merged.agent_name} here too, with everything you taught me on the web.`);
  return merged;
}

export const MIN_MEMORIES = 3;
/** Trained enough to deploy: it has a name and has been taught a few things. */
export async function readiness(u: any) {
  const memories = Number((await one(sql`select count(*) n from memories where scope_type='private' and scope_id=${u.id}`))?.n ?? 0);
  return { named: !!u.agent_name, memories, min_memories: MIN_MEMORIES, ready: !!u.agent_name && memories >= MIN_MEMORIES };
}
const me = async (u: any) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, agent_name: u.agent_name, tz: u.tz, auto_tools: Array.isArray(u.auto_tools) ? u.auto_tools : [], readiness: await readiness(u) });
export const writeTools = () => Object.values(TOOLS).filter((t) => t.kind === "write" || t.kindOf).map((t) => ({ id: t.id, description: t.description.split(".")[0] }));

export const routes: Record<string, any> = {
  "/v1/me": { GET: h(async (_r, u) => me(u)) },  // includes readiness for "Deploy to iMessage"
  "/v1/me/settings": { PUT: h(async (r, u) => {
    const b = await body(r), tz = b.tz ? String(b.tz) : null;
    if (tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { fail(400, "unknown time zone"); } }
    const allowed = new Set(writeTools().map((t) => t.id)), auto = Array.isArray(b.auto_tools) ? b.auto_tools.filter((t: any) => allowed.has(String(t))) : null;
    await sql`update users set agent_name=coalesce(${b.agent_name ? String(b.agent_name).trim().slice(0, 30) : null}, agent_name), name=coalesce(${b.name ? String(b.name).trim().slice(0, 60) : null}, name), tz=coalesce(${tz}, tz), auto_tools=coalesce(${auto ? JSON.stringify(auto) : null}::text::jsonb, auto_tools), onboarded=true where id=${u.id}`;
    return me(await one(sql`select * from users where id=${u.id}`));
  }) },
  "/v1/tools": { GET: h(async () => writeTools()) },
  "/v1/me/phone": { POST: h(async (r, u) => linkPhoneStart(u, String((await body(r)).phone ?? ""))) },
  "/v1/me/phone/verify": { POST: h(async (r, u) => me(await linkPhoneVerify(u, String((await body(r)).code ?? "")))) },

  // Training chat: the message is stored and the run starts in the background; the page polls for the reply.
  "/v1/chat": { POST: h(async (r, u) => {
    const b = await body(r), room = await webRoomOf(u), text = String(b.text ?? "").trim(), files: string[] = Array.isArray(b.file_ids) ? b.file_ids.map(String) : [];
    if (!text && !files.length) fail(400, "say something");
    agent.handleMessage(room, u, text, files).catch((e) => console.error("[web chat]", e));
    return { room_id: room.id };
  }) },
  "/v1/files": { POST: h(async (r, u) => {
    const f = (await r.formData()).get("file");
    if (!(f instanceof File)) throw Object.assign(new Error("no file"), { status: 400 });
    if (f.size > 25 * 1024 * 1024) throw Object.assign(new Error("25 MB max"), { status: 413 });
    const fid = await storeMedia({ name: f.name, mime: f.type || "application/octet-stream", data: new Uint8Array(await f.arrayBuffer()) });
    await sql`update files set user_id=${u.id} where id=${fid}`;
    return { file_id: fid, name: f.name };
  }) },
  "/v1/rooms": { GET: h(async (_r, u) => { await webRoomOf(u); return sql`select r.id, r.kind, r.channel, r.name, r.instructions, (select text from messages m where m.room_id=r.id order by created_at desc limit 1) last_text, (select max(created_at) from messages m where m.room_id=r.id) last_at
    from rooms r join room_members rm on rm.room_id=r.id and rm.user_id=${u.id} order by (r.channel='web') desc, last_at desc nulls last`; }) },
  "/v1/rooms/:id/messages": { GET: h(async (_r, u, p) => {
    if (!(await one(sql`select 1 from room_members where room_id=${p.id} and user_id=${u.id}`))) fail(404, "no such chat");
    const messages = await sql`select m.id, m.direction, m.text, m.created_at, m.run_id, us.name sender_name from messages m left join users us on us.id=m.sender_id where m.room_id=${p.id} order by m.created_at desc limit 100`;
    return { messages: messages.reverse(), working: await agent.working(p.id) };
  }) },

  "/v1/memories": {
    GET: h(async (_r, u) => sql`select m.*, r.name room_name from memories m left join rooms r on r.id=m.scope_id where (m.scope_type='private' and m.scope_id=${u.id}) or (m.scope_type='room' and m.scope_id in (select room_id from room_members where user_id=${u.id})) order by m.created_at desc`),
    POST: h(async (r, u) => { const b = await body(r); const kind = (KINDS as readonly string[]).includes(b.kind) ? b.kind : "fact"; const text = String(b.text ?? "").trim(); if (!text) fail(400, "say what to remember"); return remember("private", u.id, text, u.id, kind); }),
  },
  "/v1/memories/:id": { DELETE: h(async (_r, u, p) => {
    const m = await one(sql`select * from memories where id=${p.id}`);
    if (!m || (m.scope_type === "private" ? m.scope_id !== u.id : !(await one(sql`select 1 from room_members where room_id=${m.scope_id} and user_id=${u.id}`)))) fail(404, "no such memory");
    await forget(p.id); return { ok: true };
  }) },

  "/v1/connections": { GET: h(async (_r, u) => sql`select id, provider, label, account, status, created_at, last_used_at, case when provider='mcp' then jsonb_array_length(coalesce(config->'tools','[]'::jsonb)) else null end tools from connections where user_id=${u.id} and status!='revoked' order by created_at`) },
  "/v1/connections/:id": { DELETE: h(async (_r, u, p) => { await sql`update connections set status='revoked', cred_enc=null where id=${p.id} and user_id=${u.id}`; return { ok: true }; }) },
  "/v1/connections/google/link": { POST: h(async (_r, u) => ({ url: await makeLink(u.id, "google") })) },
  "/v1/connections/mcp": { POST: h(async (r, u) => { const b = await body(r); return addMcpConnection(u.id, String(b.label ?? "Device").slice(0, 40), String(b.url ?? ""), String(b.token ?? "")); }) },
  "/v1/reminders": { GET: h(async (_r, u) => (await sql`select s.id, s.text, s.kind, s.next_at, s.spec, r.name room_name, r.kind room_kind, r.channel from schedules s join rooms r on r.id=s.room_id where s.user_id=${u.id} and s.status='active' order by s.next_at`).map((s: any) => ({ ...s, next: s.next_at ? fmtLocal(s.next_at, u.tz) : null }))) },
  "/v1/reminders/:id": { DELETE: h(async (_r, u, p) => { await sql`update schedules set status='cancelled' where id=${p.id} and user_id=${u.id}`; return { ok: true }; }) },
  "/v1/runs": { GET: h(async (_r, u) => {
    const runs = await sql`select r.id, r.request, r.status, r.tier, r.tier_reason, r.reply, r.cost_usd, r.created_at, ro.kind room_kind, ro.channel, ro.name room_name from runs r join rooms ro on ro.id=r.room_id where r.requester_id=${u.id} order by r.created_at desc limit 50`;
    const execs = runs.length ? await sql`select run_id, tool, status, verified, provider_ref, input, created_at from tool_executions where run_id in ${sql(runs.map((r: any) => r.id))} order by created_at` : [];
    return runs.map((r: any) => ({ ...r, executions: execs.filter((e: any) => e.run_id === r.id) }));
  }) },
};
