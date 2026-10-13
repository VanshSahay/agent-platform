// The signed-in web app's API: your agents, each trained in its own web chat with its own memory and trust list;
// link a phone to deploy them to iMessage; see chats, connections, reminders and what they did.
import { sql, now, one, J, fmtLocal } from "./db";
import { userOf, AuthError } from "./auth";
import { makeLink } from "./links";
import { normPhone, userByPhone, privateRoomOf, webRoomOf } from "./rooms";
import * as agent from "./agent";
import * as agent_ from "./agent";
import { structured } from "./model";
import { consolidateAgent } from "./consolidate";
import { agentsOf, agentById, createAgent, defaultAgentOf, readiness, MIN_MEMORIES } from "./agents";
import { addMcpConnection } from "./tools/mcp";
import { normSite } from "./tools/browser";
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
async function ownAgent(u: any, aid: string) { const a = await agentById(aid); if (!a || a.owner_id !== u.id) fail(404, "no such agent"); return a; }
const withReadiness = async (a: any) => ({ id: a.id, name: a.name, purpose: a.purpose, profile: a.profile, profile_at: a.profile_at, auto_tools: Array.isArray(a.auto_tools) ? a.auto_tools : [], max_usd_without_asking: a.max_usd_without_asking, spending_paused: !!a.spending_paused, created_at: a.created_at, readiness: await readiness(a) });

/** One paragraph in, a drafted purpose and starter rules out, saved as the agent's first memories; the training chat opens
 *  with what it understood and what it wants to know. Best-effort: no model, no draft. */
export async function draftFromBrief(user: any, agent: any, brief: string) {
  if (!brief?.trim()) return;
  try {
    const d = await structured<{ purpose: string; rules: string[]; questions: string[] }>("cheap", `Someone is creating a personal agent and wrote one paragraph about what it's for. Draft: "purpose" (one plain sentence, what the agent takes off their plate), "rules" (3 to 5 one-line standing rules in second person about how it should behave, inferred from the brief: when to ask, what never to do, tone), "questions" (2 short questions the agent should ask first to do the job well). Plain words, no jargon. Return {"purpose","rules","questions"}.`, brief, user.id);
    if (d.purpose) await sql`update agents set purpose=${String(d.purpose).slice(0, 500)} where id=${agent.id}`;
    for (const r of (d.rules ?? []).slice(0, 5)) await remember("agent", agent.id, String(r).slice(0, 300), user.id, "rule");
    const room = await webRoomOf(user, agent);
    await agent_.say(room, `I'm ${agent.name}. From what you wrote, I'll ${String(d.purpose ?? brief).replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/\.$/, "")}. I've noted ${(d.rules ?? []).length} rules for myself; you can see and change them under Memory.${d.questions?.length ? ` To do this well: ${d.questions.slice(0, 2).join(" ")}` : ""}`);
  } catch (e: any) { console.warn("[builder]", e.message); }
}

/** Step 1: the agent texts a 6-digit code to the number. Step 2: the person types it here; the web account and the
 *  phone's person become one row (the phone's row keeps its history, the web account's agents move over). */
export async function linkPhoneStart(user: any, raw: string) {
  const d = await defaultAgentOf(user), r = await readiness(d);
  if (!r.ready) fail(403, `train ${d.name} first: ${r.named ? "" : "give it a name, and "}teach it at least ${MIN_MEMORIES} things (it knows ${r.memories})`);
  const phone = normPhone(raw);
  if (!/^\+1\d{10}$/.test(phone)) fail(400, "US or Canada number, please");
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await sql`delete from links where user_id=${user.id} and purpose='phone'`;
  await makeLink(user.id, "phone", { code, phone }, 10 * 60_000);
  const target = await userByPhone(phone);
  if (target.id !== user.id) { // the phone's row answers with the web account's default agent from now on
    await sql`update agents set owner_id=${target.id} where id=${d.id}`;
    await sql`update users set default_agent_id=${d.id} where id=${target.id}`;
    await sql`update rooms set agent_id=${d.id} where owner_id=${target.id} and kind='private' and channel='imessage'`;
  }
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
  await sql`delete from links where user_id=${user.id}`;
  await sql`update users set clerk_id=null where id=${user.id}`;
  await sql`update users set clerk_id=${user.clerk_id}, email=coalesce(email, ${user.email}), name=coalesce(name, ${user.name}), tz=${user.tz}, default_agent_id=coalesce(${user.default_agent_id}, default_agent_id), onboarded=(onboarded or ${!!user.onboarded}) where id=${target.id}`;
  await sql`update agents set owner_id=${target.id} where owner_id=${user.id}`;
  await sql`update rooms set owner_id=${target.id} where owner_id=${user.id}`;
  await sql`update room_members set user_id=${target.id} where user_id=${user.id}`;
  await sql`update messages set sender_id=${target.id} where sender_id=${user.id}`;
  await sql`update runs set requester_id=${target.id} where requester_id=${user.id}`;
  await sql`update schedules set user_id=${target.id} where user_id=${user.id}`;
  await sql`update connections set user_id=${target.id} where user_id=${user.id}`;
  await sql`delete from users where id=${user.id} and phone is null`;
  const merged = await one(sql`select * from users where id=${target.id}`), d = await defaultAgentOf(merged);
  const dm = await privateRoomOf(target.id);
  if (dm) { await sql`update rooms set agent_id=${d.id} where id=${dm.id}`; await agent.say(dm, `Linked. I'm ${d.name} here too, with everything you taught me.`); }
  return merged;
}

/** The home: what needs you, what's on the radar, what happened. */
export async function homeData(u: any) {
  const need = await sql`select a.id, a.kind, a.summary, a.created_at, a.requester_id, r.name room_name, r.kind room_kind, r.channel, ag.name agent_name, rq.name requester_name
    from approvals a left join rooms r on r.id=a.room_id left join agents ag on ag.id=r.agent_id left join users rq on rq.id=a.requester_id where a.user_id=${u.id} and a.status='pending' order by a.created_at desc`;
  const held = await sql`select ru.id, ru.reply, ru.created_at, r.name room_name, ag.name agent_name from runs ru join rooms r on r.id=ru.room_id left join agents ag on ag.id=r.agent_id where ru.requester_id=${u.id} and ru.status='held' order by ru.created_at desc`;
  const radar = await sql`select s.id, s.text, s.kind, s.next_at, s.spec, r.name room_name, r.kind room_kind, r.channel, ag.name agent_name from schedules s join rooms r on r.id=s.room_id left join agents ag on ag.id=r.agent_id where s.user_id=${u.id} and s.status='active' order by s.next_at`;
  const working = await sql`select ru.id, ru.request, ru.status, ru.created_at, r.name room_name, r.channel, ag.name agent_name from runs ru join rooms r on r.id=ru.room_id left join agents ag on ag.id=r.agent_id where ru.requester_id=${u.id} and ru.status in ('running','waiting_approval','waiting_consent') order by ru.created_at desc limit 20`;
  const activity = await sql`select ru.id, ru.request, ru.status, ru.reply, ru.steps, ru.cost_usd, ru.updated_at, r.name room_name, r.kind room_kind, r.channel, ag.name agent_name from runs ru join rooms r on r.id=ru.room_id left join agents ag on ag.id=r.agent_id where ru.requester_id=${u.id} and ru.status in ('done','failed') order by ru.updated_at desc limit 30`;
  return { need_input: [...need.map((a: any) => ({ type: a.kind === "consent" ? "consent" : "approval", ...a })), ...held.map((h: any) => ({ type: "held", ...h }))],
    on_radar: { schedules: radar.map((s: any) => ({ ...s, next: s.next_at ? fmtLocal(s.next_at, u.tz) : null })), working },
    activity };
}

const me = async (u: any) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, tz: u.tz, default_agent_id: (await defaultAgentOf(u)).id, agents: await Promise.all((await agentsOf(u.id)).map(withReadiness)) });
export const writeTools = () => Object.values(TOOLS).filter((t) => t.kind === "write" || t.kindOf).map((t) => ({ id: t.id, description: t.description.split(".")[0] }));
const memoryVisible = async (u: any, m: any) => m.scope_type === "agent" ? (await agentById(m.scope_id))?.owner_id === u.id : !!(await one(sql`select 1 from room_members where room_id=${m.scope_id} and user_id=${u.id}`));

export const routes: Record<string, any> = {
  "/v1/me": { GET: h(async (_r, u) => me(u)) },
  "/v1/me/settings": { PUT: h(async (r, u) => {
    const b = await body(r), tz = b.tz ? String(b.tz) : null;
    if (tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { fail(400, "unknown time zone"); } }
    if (b.default_agent_id) await ownAgent(u, String(b.default_agent_id));
    await sql`update users set name=coalesce(${b.name ? String(b.name).trim().slice(0, 60) : null}, name), tz=coalesce(${tz}, tz), default_agent_id=coalesce(${b.default_agent_id ? String(b.default_agent_id) : null}, default_agent_id), onboarded=true where id=${u.id}`;
    return me(await one(sql`select * from users where id=${u.id}`));
  }) },
  "/v1/tools": { GET: h(async () => writeTools()) },
  "/v1/home": { GET: h(async (_r, u) => homeData(u)) },
  "/v1/approvals/:id": { POST: h(async (r, u, p) => {
    const a = await one(sql`select * from approvals where id=${p.id} and user_id=${u.id} and status='pending'`);
    if (!a) fail(404, "nothing to decide");
    const yes = (await body(r)).decision === "approve";
    agent.decide(a, yes).catch((e) => console.error("[web approve]", e));
    return { ok: true };
  }) },
  "/v1/runs/:id/held": { POST: h(async (r, u, p) => {
    const run = await one(sql`select * from runs where id=${p.id} and requester_id=${u.id} and status='held'`);
    if (!run) fail(404, "nothing held");
    if ((await body(r)).decision === "post") await agent.releaseHeld(run); else await sql`update runs set status='done', updated_at=${now()} where id=${run.id}`;
    return { ok: true };
  }) },
  "/v1/connections/:id/settings": { PUT: h(async (r, u, p) => {
    const c = await one(sql`select * from connections where id=${p.id} and user_id=${u.id}`); if (!c) fail(404, "no such connection");
    const b = await body(r), cfg = { ...J(c.config, {}), ...(typeof b.send_as_me === "boolean" ? { send_as_me: b.send_as_me } : {}) };
    await sql`update connections set config=${JSON.stringify(cfg)}::text::jsonb where id=${c.id}`;
    return { ok: true, send_as_me: !!cfg.send_as_me };
  }) },
  "/v1/me/phone": { POST: h(async (r, u) => linkPhoneStart(u, String((await body(r)).phone ?? ""))) },
  "/v1/me/phone/verify": { POST: h(async (r, u) => me(await linkPhoneVerify(u, String((await body(r)).code ?? "")))) },

  "/v1/agents": {
    GET: h(async (_r, u) => Promise.all((await agentsOf(u.id)).map(withReadiness))),
    POST: h(async (r, u) => { const b = await body(r); if (!String(b.name ?? "").trim()) fail(400, "give it a name"); const a = await createAgent(u, b.name, b.purpose); draftFromBrief(u, a, String(b.purpose ?? "")).catch(() => {}); return withReadiness(a); }),
  },
  "/v1/agents/:id": {
    GET: h(async (_r, u, p) => withReadiness(await ownAgent(u, p.id))),
    PUT: h(async (r, u, p) => {
      const a = await ownAgent(u, p.id), b = await body(r), allowed = new Set(writeTools().map((t) => t.id));
      const auto = Array.isArray(b.auto_tools) ? b.auto_tools.filter((t: any) => allowed.has(String(t))) : null;
      const maxUsd = b.max_usd_without_asking === null || b.max_usd_without_asking === "" ? null : b.max_usd_without_asking != null ? Math.max(0, Number(b.max_usd_without_asking)) : undefined;
      await sql`update agents set name=coalesce(${b.name ? String(b.name).trim().slice(0, 30) : null}, name), purpose=coalesce(${b.purpose != null ? String(b.purpose).slice(0, 500) : null}, purpose), auto_tools=coalesce(${auto ? JSON.stringify(auto) : null}::text::jsonb, auto_tools), max_usd_without_asking=${maxUsd === undefined ? sql`max_usd_without_asking` : maxUsd}, spending_paused=coalesce(${typeof b.spending_paused === "boolean" ? b.spending_paused : null}, spending_paused) where id=${a.id}`;
      return withReadiness(await agentById(a.id));
    }),
    DELETE: h(async (_r, u, p) => {
      const a = await ownAgent(u, p.id);
      if ((await defaultAgentOf(u)).id === a.id) fail(400, "that's your default agent; pick another default first");
      await sql`delete from memories where scope_type='agent' and scope_id=${a.id}`;
      await sql`update rooms set agent_id=${u.default_agent_id} where agent_id=${a.id} and channel!='web'`;
      await sql`delete from messages where room_id in (select id from rooms where agent_id=${a.id} and channel='web')`;
      await sql`delete from room_members where room_id in (select id from rooms where agent_id=${a.id} and channel='web')`;
      await sql`update runs set room_id=null where room_id in (select id from rooms where agent_id=${a.id} and channel='web')`;
      await sql`delete from rooms where agent_id=${a.id} and channel='web'`;
      await sql`delete from agents where id=${a.id}`;
      return { ok: true };
    }),
  },
  "/v1/agents/:id/consolidate": { POST: h(async (_r, u, p) => { const a = await ownAgent(u, p.id); return consolidateAgent(a, u); }) },
  "/v1/agents/:id/room": { GET: h(async (_r, u, p) => webRoomOf(u, await ownAgent(u, p.id))) },
  "/v1/agents/:id/chat": { POST: h(async (r, u, p) => {
    const a = await ownAgent(u, p.id), b = await body(r), room = await webRoomOf(u, a), text = String(b.text ?? "").trim(), files: string[] = Array.isArray(b.file_ids) ? b.file_ids.map(String) : [];
    if (!text && !files.length) fail(400, "say something");
    agent.handleMessage(room, u, text, files).catch((e) => console.error("[web chat]", e));
    return { room_id: room.id };
  }) },
  "/v1/agents/:id/memories": {
    GET: h(async (_r, u, p) => { const a = await ownAgent(u, p.id); return sql`select * from memories where scope_type='agent' and scope_id=${a.id} order by created_at desc`; }),
    POST: h(async (r, u, p) => { const a = await ownAgent(u, p.id), b = await body(r); const kind = (KINDS as readonly string[]).includes(b.kind) ? b.kind : "fact"; const text = String(b.text ?? "").trim(); if (!text) fail(400, "say what to remember"); return remember("agent", a.id, text, u.id, kind); }),
  },
  "/v1/memories/:id": { DELETE: h(async (_r, u, p) => { const m = await one(sql`select * from memories where id=${p.id}`); if (!m || !(await memoryVisible(u, m))) fail(404, "no such memory"); await forget(p.id); return { ok: true }; }) },
  "/v1/files": { POST: h(async (r, u) => {
    const f = (await r.formData()).get("file");
    if (!(f instanceof File)) throw Object.assign(new Error("no file"), { status: 400 });
    if (f.size > 25 * 1024 * 1024) throw Object.assign(new Error("25 MB max"), { status: 413 });
    const fid = await storeMedia({ name: f.name, mime: f.type || "application/octet-stream", data: new Uint8Array(await f.arrayBuffer()) });
    await sql`update files set user_id=${u.id} where id=${fid}`;
    return { file_id: fid, name: f.name };
  }) },

  "/v1/rooms": { GET: h(async (_r, u) => sql`select r.id, r.kind, r.channel, r.name, r.instructions, a.name agent_name, (select text from messages m where m.room_id=r.id order by created_at desc limit 1) last_text, (select max(created_at) from messages m where m.room_id=r.id) last_at
    from rooms r join room_members rm on rm.room_id=r.id and rm.user_id=${u.id} left join agents a on a.id=r.agent_id where r.channel!='web' order by last_at desc nulls last`) },
  "/v1/rooms/:id/messages": { GET: h(async (_r, u, p) => {
    if (!(await one(sql`select 1 from room_members where room_id=${p.id} and user_id=${u.id}`))) fail(404, "no such chat");
    const messages = await sql`select m.id, m.direction, m.text, m.created_at, m.run_id, us.name sender_name, r.steps from messages m left join users us on us.id=m.sender_id left join runs r on r.id=m.run_id and m.direction='out' where m.room_id=${p.id} order by m.created_at desc limit 100`;
    return { messages: messages.reverse(), working: await agent.working(p.id) };
  }) },
  "/v1/connections": { GET: h(async (_r, u) => sql`select id, provider, label, account, status, created_at, last_used_at, coalesce((config->>'send_as_me')::boolean, false) send_as_me, case when provider='mcp' then jsonb_array_length(coalesce(config->'tools','[]'::jsonb)) else null end tools from connections where user_id=${u.id} and status not in ('revoked','pending') order by created_at`) },
  "/v1/connections/:id": { DELETE: h(async (_r, u, p) => { await sql`update connections set status='revoked', cred_enc=null where id=${p.id} and user_id=${u.id}`; return { ok: true }; }) },
  "/v1/connections/google/link": { POST: h(async (_r, u) => ({ url: await makeLink(u.id, "google") })) },
  "/v1/connections/browser/link": { POST: h(async (r, u) => { const site = normSite((await body(r)).site); if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) fail(400, "a website address like ubereats.com"); return { url: await makeLink(u.id, "browser", { site }) }; }) },
  "/v1/connections/mcp": { POST: h(async (r, u) => { const b = await body(r); return addMcpConnection(u.id, String(b.label ?? "Device").slice(0, 40), String(b.url ?? ""), String(b.token ?? "")); }) },
  "/v1/reminders": { GET: h(async (_r, u) => (await sql`select s.id, s.text, s.kind, s.next_at, s.spec, r.name room_name, r.kind room_kind, r.channel, a.name agent_name from schedules s join rooms r on r.id=s.room_id left join agents a on a.id=r.agent_id where s.user_id=${u.id} and s.status='active' order by s.next_at`).map((s: any) => ({ ...s, next: s.next_at ? fmtLocal(s.next_at, u.tz) : null }))) },
  "/v1/reminders/:id": { DELETE: h(async (_r, u, p) => { await sql`update schedules set status='cancelled' where id=${p.id} and user_id=${u.id}`; return { ok: true }; }) },
  "/v1/runs": { GET: h(async (_r, u) => {
    const runs = await sql`select r.id, r.request, r.status, r.tier, r.tier_reason, r.reply, r.cost_usd, r.created_at, ro.kind room_kind, ro.channel, ro.name room_name, a.name agent_name from runs r left join rooms ro on ro.id=r.room_id left join agents a on a.id=ro.agent_id where r.requester_id=${u.id} order by r.created_at desc limit 50`;
    const execs = runs.length ? await sql`select run_id, tool, status, verified, provider_ref, input, created_at from tool_executions where run_id in ${sql(runs.map((r: any) => r.id))} order by created_at` : [];
    return runs.map((r: any) => ({ ...r, executions: execs.filter((e: any) => e.run_id === r.id) }));
  }) },
};
