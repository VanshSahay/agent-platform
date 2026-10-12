// The signed-in web app's API: link a phone, see chats, connections, reminders and what the agent did.
import { sql, now, one, J, fmtLocal } from "./db";
import { userOf, AuthError } from "./auth";
import { makeLink } from "./links";
import { normPhone, userByPhone, privateRoomOf } from "./rooms";
import * as agent from "./agent";
import { addMcpConnection } from "./tools/mcp";

const json = (d: any, status = 200) => Response.json(d, { status });
type H = (req: Request, user: any, params: Record<string, string>) => Promise<any>;
const h = (fn: H) => async (req: Request & { params?: Record<string, string> }) => {
  try { return json(await fn(req, await userOf(req), req.params ?? {})); }
  catch (e: any) { if (e instanceof AuthError) return json({ error: e.message }, 401); console.error("[web]", e); return json({ error: e.message ?? "internal error" }, e.status ?? 400); }
};
const body = (r: Request) => r.json().catch(() => ({}));
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };

/** Step 1: the agent texts a 6-digit code to the number. Step 2: the person types it here; the web account and the
 *  phone's person become one row (the phone's row keeps its history). */
export async function linkPhoneStart(user: any, raw: string) {
  const phone = normPhone(raw);
  if (!/^\+1\d{10}$/.test(phone)) fail(400, "US or Canada number, please");
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await sql`delete from links where user_id=${user.id} and purpose='phone'`;
  await makeLink(user.id, "phone" as any, { code, phone }, 10 * 60_000);
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
  // The phone's row is the real person (chats, memories, runs); the web-only row has nothing yet.
  await sql`delete from links where user_id=${user.id}`;
  await sql`update users set clerk_id=null where id=${user.id}`;
  await sql`update users set clerk_id=${user.clerk_id}, email=coalesce(email, ${user.email}), name=coalesce(name, ${user.name}) where id=${target.id}`;
  await sql`delete from users where id=${user.id} and phone is null`;
  return one(sql`select * from users where id=${target.id}`);
}

export const routes: Record<string, any> = {
  "/v1/me": { GET: h(async (_r, u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, agent_name: u.agent_name, tz: u.tz })) },
  "/v1/me/phone": { POST: h(async (r, u) => linkPhoneStart(u, String((await body(r)).phone ?? ""))) },
  "/v1/me/phone/verify": { POST: h(async (r, u) => { const nu = await linkPhoneVerify(u, String((await body(r)).code ?? "")); return { id: nu.id, phone: nu.phone, agent_name: nu.agent_name }; }) },
  "/v1/rooms": { GET: h(async (_r, u) => sql`select r.id, r.kind, r.name, r.instructions, (select text from messages m where m.room_id=r.id order by created_at desc limit 1) last_text, (select max(created_at) from messages m where m.room_id=r.id) last_at
    from rooms r join room_members rm on rm.room_id=r.id and rm.user_id=${u.id} order by last_at desc nulls last`) },
  "/v1/rooms/:id/messages": { GET: h(async (_r, u, p) => {
    if (!(await one(sql`select 1 from room_members where room_id=${p.id} and user_id=${u.id}`))) fail(404, "no such chat");
    return sql`select m.id, m.direction, m.text, m.created_at, m.run_id, us.name sender_name from messages m left join users us on us.id=m.sender_id where m.room_id=${p.id} order by m.created_at desc limit 100`;
  }) },
  "/v1/connections": { GET: h(async (_r, u) => sql`select id, provider, label, account, status, created_at, last_used_at, case when provider='mcp' then jsonb_array_length(coalesce(config->'tools','[]'::jsonb)) else null end tools from connections where user_id=${u.id} and status!='revoked' order by created_at`) },
  "/v1/connections/:id": { DELETE: h(async (_r, u, p) => { await sql`update connections set status='revoked', cred_enc=null where id=${p.id} and user_id=${u.id}`; return { ok: true }; }) },
  "/v1/connections/google/link": { POST: h(async (_r, u) => ({ url: await makeLink(u.id, "google") })) },
  "/v1/connections/mcp": { POST: h(async (r, u) => { const b = await body(r); return addMcpConnection(u.id, String(b.label ?? "Device").slice(0, 40), String(b.url ?? ""), String(b.token ?? "")); }) },
  "/v1/reminders": { GET: h(async (_r, u) => (await sql`select s.id, s.text, s.kind, s.next_at, s.spec, r.name room_name, r.kind room_kind from schedules s join rooms r on r.id=s.room_id where s.user_id=${u.id} and s.status='active' order by s.next_at`).map((s: any) => ({ ...s, next: s.next_at ? fmtLocal(s.next_at, u.tz) : null }))) },
  "/v1/reminders/:id": { DELETE: h(async (_r, u, p) => { await sql`update schedules set status='cancelled' where id=${p.id} and user_id=${u.id}`; return { ok: true }; }) },
  "/v1/runs": { GET: h(async (_r, u) => {
    const runs = await sql`select r.id, r.request, r.status, r.tier, r.tier_reason, r.reply, r.cost_usd, r.created_at, ro.kind room_kind, ro.name room_name from runs r join rooms ro on ro.id=r.room_id where r.requester_id=${u.id} order by r.created_at desc limit 50`;
    const execs = runs.length ? await sql`select run_id, tool, status, verified, provider_ref, input, created_at from tool_executions where run_id in ${sql(runs.map((r: any) => r.id))} order by created_at` : [];
    return runs.map((r: any) => ({ ...r, executions: execs.filter((e: any) => e.run_id === r.id) }));
  }) },
};
