// HTTP API (plan §34) + webhooks + web app.
import { all, one, exec, emit, id, now, S, J, seal, unseal, tx } from "./db";
import * as rt from "./runtime";
import * as ch from "./channels";
import * as tpl from "./templates";
import * as mem from "./memory";
import * as intake from "./intake";
import { TOOLS } from "./tools";
import app from "../public/index.html";

type Req = Request & { params: Record<string, string> };
const json = (d: any, status = 200) => Response.json(d, { status });
const err = (status: number, error: string) => json({ error }, status);
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };
const body = async (r: Request): Promise<any> => { try { return await r.json(); } catch { return {}; } };
const pub = () => process.env.PUBLIC_URL ?? "http://localhost:3000";
const admins = () => (process.env.PLATFORM_ADMINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// ---------------- auth ----------------
// ponytail: built-in email/password sessions; swap for Clerk/Better Auth (orgs, SSO) when enterprise lands.
function sessionUser(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? req.headers.get("cookie")?.match(/(?:^|; )sid=([^;]+)/)?.[1];
  if (!token) return null;
  return one<any>("select u.* from sessions s join users u on u.id=s.user_id where s.token=? and s.expires_at>?", token, now()) ?? null;
}
// ponytail: in-process limiter; move to Redis when there's more than one API process.
export const attempts = new Map<string, number[]>();
function limit(key: string, max: number, windowMs = 60_000) {
  const t = Date.now(), hits = (attempts.get(key) ?? []).filter((x) => t - x < windowMs);
  hits.push(t); attempts.set(key, hits);
  if (hits.length > max) fail(429, "too many attempts; try again in a minute");
}
const userOf = (req: Request) => sessionUser(req) ?? fail(401, "sign in required");
function startSession(userId: string, res: any) {
  const token = id("sid") + id("x");
  exec("insert into sessions values (?,?,?)", token, userId, now() + 30 * 864e5);
  return new Response(S({ ...res, token }), { headers: { "content-type": "application/json", "set-cookie": `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` } });
}
function member(wsId: string | null | undefined, userId: string, roles?: string[]) {
  const m = wsId ? one<any>("select * from memberships where workspace_id=? and user_id=?", wsId, userId) : null;
  if (!m) fail(404, "workspace not found");
  if (roles && !roles.includes(m.role)) fail(403, `requires ${roles.join("/")}`);
  return m;
}
function roomFor(roomId: string, userId: string) {
  const r = one<any>("select * from rooms where id=?", roomId) ?? fail(404, "room not found");
  const inRoom = one("select 1 from room_members where room_id=? and principal_id=?", roomId, userId);
  const m = one<any>("select role from memberships where workspace_id=? and user_id=?", r.workspace_id, userId);
  // Private rooms are visible only to their members (not to workspace admins).
  if (!inRoom && (!m || r.kind === "private")) fail(404, "room not found");
  return r;
}
const agentFor = (agentId: string, userId: string, wsId?: string) => {
  const a = one<any>("select * from agents where id=?", agentId) ?? fail(404, "agent not found");
  member(a.workspace_id, userId);
  if (wsId && a.workspace_id !== wsId) fail(400, "agent belongs to another workspace");
  return a;
};
/** Rooms the user may see: shared rooms of the workspace + private rooms they're in. */
const visibleRooms = (ws: string, userId: string) => new Set(all<any>("select r.id from rooms r where r.workspace_id=? and (r.kind!='private' or exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?))", ws, userId).map((r) => r.id as string));

function createWorkspace(name: string, kind: string, ownerId: string) {
  const wid = id("ws");
  exec("insert into workspaces (id, name, kind, plan, created_at) values (?,?,?,?,?)", wid, name, kind, kind === "team" ? "team" : "personal", now());
  exec("insert into memberships values (?,?,?,?)", wid, ownerId, "owner", null);
  return one<any>("select * from workspaces where id=?", wid);
}

// Plan limits (plan §22.1). ponytail: enforced counts only; Stripe is a billing sink fed from the usage ledger later.
const PLANS: Record<string, { agents: number; channels: string[] }> = {
  free: { agents: 2, channels: ["web", "telegram"] },
  personal: { agents: 5, channels: ["web", "telegram", "imessage", "email", "whatsapp"] },
  pro: { agents: 20, channels: ["web", "telegram", "imessage", "email", "whatsapp", "phone"] },
  team: { agents: 50, channels: ["web", "telegram", "imessage", "email", "whatsapp", "phone", "slack"] },
  enterprise: { agents: 1000, channels: ["web", "telegram", "imessage", "email", "whatsapp", "phone", "slack"] },
};

function agentView(a: any) {
  return {
    ...a, skills: J(a.skills, []), permissions: J(a.permissions, {}), onboarding: J(a.onboarding, {}),
    permission_table: tpl.permissionTable(J(a.skills, []), J(a.permissions, {})),
    channels: all<any>("select id, platform, address, config from channel_identities where agent_id=?", a.id).map((c) => ({ ...c, config: J(c.config, {}), webhook_url: `${pub()}/v1/webhooks/${c.platform}/${c.id}` })),
    connections_needed: tpl.connectionsNeeded(J(a.skills, [])),
    custom_skills: tpl.customSkills(a.id), starters: tpl.starters(a),
    completed_runs: one<any>("select count(*) n from runs where agent_id=? and status='completed' and parent_run_id is null", a.id).n,
    connections: all<any>("select c.id, c.provider, c.account, c.owner_id, c.visibility, c.status from connections c join connection_grants g on g.connection_id=c.id where g.agent_id=?", a.id)
      .map((c) => ({ ...c, owner: rt.nameOf(c.owner_id) })),
    rooms: all<any>("select r.id, r.name, r.kind from rooms r join room_members m on m.room_id=r.id where m.principal_id=? and r.status='active'", a.id),
    active_runs: all<any>("select id, objective, status, room_id, updated_at from runs where agent_id=? and status not in ('completed','failed_terminal','cancelled') order by updated_at desc", a.id),
    schedules: all<any>("select * from schedules where agent_id=? and status='active'", a.id).map((s) => ({ ...s, spec: J(s.spec) })),
  };
}

function roomView(r: any, after = 0) {
  const agents = all<any>("select a.* from agents a join room_members m on m.principal_id=a.id where m.room_id=? and coalesce(m.role,'')!='delegate'", r.id);
  return {
    room: r, starters: agents.length === 1 ? tpl.starters(agents[0]) : [],
    members: all<any>("select * from room_members where room_id=?", r.id).map((m) => ({ ...m, name: rt.nameOf(m.principal_id) })),
    endpoints: all<any>("select id, platform, external_conversation_id, is_group, last_active_at from room_endpoints where room_id=?", r.id),
    tasks: all<any>("select * from tasks where room_id=? order by status='done', created_at", r.id).map((t) => ({ ...t, owner_name: rt.nameOf(t.owner) })),
    approvals: all<any>("select * from approvals where room_id=? and status='pending' order by created_at", r.id).map((a) => ({ ...a, input: J(a.input), approvers: J(a.approvers, []).map((x: string) => ({ id: x, name: rt.nameOf(x) })), agent_name: rt.nameOf(a.agent_id) })),
    runs: all<any>("select * from runs where room_id=? and status not in ('completed','failed_terminal','cancelled') order by created_at", r.id).map((x) => ({ ...x, brief: J(x.brief), agent_name: rt.nameOf(x.agent_id),
      waits: all<any>("select kind, reason, owner from waits where run_id=? and status='open'", x.id).map((w) => ({ ...w, owner_name: rt.nameOf(w.owner) })) })),
    events: all<any>("select seq, id, type, actor, run_id, data, ts from events where room_id=? and seq>? order by seq limit 500", r.id, after).map((e) => ({ ...e, data: J(e.data), actor_name: rt.nameOf(e.actor) })),
  };
}

let kickTimer: any = null;
export const kick = () => { if (!kickTimer) kickTimer = setTimeout(async () => { kickTimer = null; await worker(); }, 10); };
let working = false;
export async function worker() {
  if (working) return; working = true;
  try { while (await rt.tick()) {} } catch (e) { console.error("[worker]", e); } finally { working = false; }
}

// ---------------- trial sessions (plan §38) ----------------
function trialAgent(slug: string, trialId: string | null) {
  let t = trialId ? one<any>("select * from workspaces where id=? and kind='trial'", trialId) : null;
  if (!t) {
    const guest = id("usr");
    exec("insert into users (id, name, guest, created_at) values (?,?,1,?)", guest, "You", now());
    t = createWorkspace("Trial", "trial", guest);
    exec("update workspaces set plan='free' where id=?", t.id);
  }
  const userId = one<any>("select user_id from memberships where workspace_id=?", t.id).user_id;
  let agent = one<any>("select a.* from agents a join templates tp on tp.id=a.template_id where a.workspace_id=? and tp.slug=?", t.id, slug);
  if (!agent) { const r = tpl.install(slug, t.id, userId); if ("error" in r) fail(404, r.error!); agent = (r as any).agent; }
  return { trialId: t.id, userId, agent };
}

// ---------------- routes ----------------
const h = (fn: (req: Req) => Promise<Response> | Response) => async (req: Req) => {
  try { return await fn(req); }
  catch (e: any) { if (e instanceof HttpError) return err(e.status, e.message); console.error(e); return err(500, "internal error"); }
};

export const routes: Record<string, any> = {
  "/v1/health": { GET: () => json({ ok: true }) },

  "/v1/auth/signup": { POST: h(async (req) => {
    const b = await body(req);
    limit(`signup:${req.headers.get("x-forwarded-for") ?? "local"}`, 20);
    if (!b.email || !b.password || b.password.length < 8 || !b.name) fail(400, "name, email and an 8+ character password are required");
    if (one("select 1 from users where email=?", b.email.toLowerCase())) fail(409, "email already registered");
    const uid = id("usr");
    tx(() => {
      exec("insert into users (id, email, name, password_hash, created_at) values (?,?,?,?,?)", uid, b.email.toLowerCase(), b.name, Bun.password.hashSync(b.password), now());
      createWorkspace(`${b.name} — Personal`, "personal", uid); // personal workspace automatically (plan §2.1)
    });
    return startSession(uid, { user: { id: uid, name: b.name, email: b.email } });
  }) },
  "/v1/auth/login": { POST: h(async (req) => {
    const b = await body(req);
    limit(`login:${String(b.email ?? "").toLowerCase()}`, 10);
    const u = one<any>("select * from users where email=?", String(b.email ?? "").toLowerCase());
    if (!u?.password_hash || !Bun.password.verifySync(b.password ?? "", u.password_hash)) fail(401, "wrong email or password");
    return startSession(u.id, { user: { id: u.id, name: u.name, email: u.email } });
  }) },
  "/v1/auth/logout": { POST: h((req) => {
    const t = req.headers.get("cookie")?.match(/sid=([^;]+)/)?.[1];
    if (t) exec("delete from sessions where token=?", t);
    return new Response("{}", { headers: { "set-cookie": "sid=; Path=/; Max-Age=0" } });
  }) },
  "/v1/me": { GET: h((req) => {
    const u = userOf(req);
    return json({ user: { id: u.id, name: u.name, email: u.email, platform_admin: admins().includes(u.email) },
      workspaces: all<any>("select w.*, m.role, m.title from workspaces w join memberships m on m.workspace_id=w.id where m.user_id=? and w.kind!='trial' order by w.created_at", u.id),
      identities: all<any>("select platform, external_user_id, verified, display_name from external_identities where user_id=?", u.id) });
  }) },

  "/v1/workspaces": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    if (!b.name) fail(400, "name required");
    return json(createWorkspace(b.name, "team", u.id));
  }) },
  "/v1/workspaces/:id/members": {
    GET: h((req) => { const u = userOf(req); member(req.params.id, u.id);
      return json(all<any>("select u.id, u.name, u.email, m.role, m.title from memberships m join users u on u.id=m.user_id where m.workspace_id=?", req.params.id)); }),
    PATCH: h(async (req) => { const u = userOf(req), b = await body(req); member(req.params.id, u.id, ["owner", "admin"]);
      exec("update memberships set role=coalesce(?, role), title=coalesce(?, title) where workspace_id=? and user_id=?", b.role ?? null, b.title ?? null, req.params.id, b.user_id);
      return json({ ok: true }); }),
  },
  "/v1/workspaces/:id/invitations": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req); member(req.params.id, u.id, ["owner", "admin"]);
    const token = id("inv");
    exec("insert into invitations values (?,?,?,?,?,?,?)", token, req.params.id, b.email ?? null, b.role ?? "member", u.id, null, now());
    return json({ token, url: `${pub()}/#/invite/${token}` });
  }) },
  "/v1/invitations/:token/accept": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    const inv = one<any>("select * from invitations where token=? and accepted_by is null", req.params.token) ?? fail(404, "invitation not found or used");
    if (inv.email && inv.email.toLowerCase() !== u.email) fail(403, "this invitation is for a different email");
    exec("insert or ignore into memberships values (?,?,?,?)", inv.workspace_id, u.id, inv.role, b.title ?? null);
    exec("update invitations set accepted_by=? where token=?", u.id, inv.token);
    return json({ workspace_id: inv.workspace_id });
  }) },
  "/v1/workspaces/:id/provider-keys/:provider": {
    PUT: h(async (req) => { const u = userOf(req), b = await body(req); member(req.params.id, u.id, ["owner", "admin"]);
      if (!["anthropic", "openai"].includes(req.params.provider) || !b.key) fail(400, "provider anthropic|openai and key required");
      exec("insert or replace into provider_keys values (?,?,?)", req.params.id, req.params.provider, seal(b.key));
      emit("BYOK_SET", { workspace_id: req.params.id, actor: u.id, data: { provider: req.params.provider } }); // never the key
      return json({ ok: true }); }),
    DELETE: h((req) => { const u = userOf(req); member(req.params.id, u.id, ["owner", "admin"]);
      exec("delete from provider_keys where workspace_id=? and provider=?", req.params.id, req.params.provider); return json({ ok: true }); }),
  },
  "/v1/workspaces/:id/settings": { GET: h((req) => { const u = userOf(req); member(req.params.id, u.id);
    return json({ workspace: one("select * from workspaces where id=?", req.params.id), plan: PLANS[one<any>("select plan from workspaces where id=?", req.params.id).plan],
      byok: all<any>("select provider from provider_keys where workspace_id=?", req.params.id).map((r) => r.provider),
      model_profiles: all("select * from model_profiles") }); }) },

  // ---- home ----
  "/v1/home": { GET: h((req) => {
    const u = userOf(req), ws = new URL(req.url).searchParams.get("workspace"); member(ws, u.id);
    const approvals = all<any>("select a.* from approvals a join rooms r on r.id=a.room_id where r.workspace_id=? and a.status='pending' order by a.created_at desc", ws)
      .filter((a) => rt.canApprove(a, u.id)).map((a) => ({ ...a, input: J(a.input), agent_name: rt.nameOf(a.agent_id), room_name: one<any>("select name from rooms where id=?", a.room_id)?.name }));
    const myWaits = all<any>("select w.*, r.agent_id, r.objective from waits w join runs r on r.id=w.run_id where r.workspace_id=? and w.status='open' and w.owner=? and w.kind in ('verify','reconnect')", ws, u.id)
      .map((w) => ({ ...w, agent_name: rt.nameOf(w.agent_id) }));
    const vis = visibleRooms(ws!, u.id);
    const runs = (sql: string) => all<any>(sql, ws).filter((r) => vis.has(r.room_id)).map((r) => ({ ...r, agent_name: rt.nameOf(r.agent_id), room_name: one<any>("select name from rooms where id=?", r.room_id)?.name,
      waits: all<any>("select kind, reason from waits where run_id=? and status='open'", r.id) }));
    return json({
      user: u.name, agent_count: one<any>("select count(*) n from agents where workspace_id=? and status!='deleted'", ws).n, needs_attention: { approvals, waits: myWaits, reconnect: all<any>("select id, provider, account from connections where workspace_id=? and owner_id=? and status='needs_reauth'", ws, u.id) },
      active: runs("select * from runs where workspace_id=? and status not in ('completed','failed_terminal','cancelled') order by updated_at desc limit 30"),
      completed: runs("select * from runs where workspace_id=? and status='completed' and parent_run_id is null order by completed_at desc limit 10").map((r) => ({ ...r, result: J(r.result) })),
      failed: runs("select * from runs where workspace_id=? and status='failed_terminal' order by completed_at desc limit 5"),
      blocked: all<any>("select t.*, r.name room_name from tasks t join rooms r on r.id=t.room_id where r.workspace_id=? and t.status='blocked'", ws).filter((t) => vis.has(t.room_id)).map((t) => ({ ...t, owner_name: rt.nameOf(t.owner) })),
    });
  }) },

  // ---- agents ----
  "/v1/agents/draft": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    if (!b.description) fail(400, "describe what the agent should do");
    if (b.workspace_id) member(b.workspace_id, u.id); // drafting can spend the workspace's BYOK key
    return json(await tpl.draftAgent(b.description, b.workspace_id));
  }) },
  "/v1/agents": {
    GET: h((req) => { const u = userOf(req), ws = new URL(req.url).searchParams.get("workspace"); member(ws, u.id);
      return json(all<any>("select * from agents where workspace_id=? and status!='deleted' order by created_at", ws).map(agentView)); }),
    POST: h(async (req) => {
      const u = userOf(req), b = await body(req); member(b.workspace_id, u.id, ["owner", "admin", "member"]);
      const plan = one<any>("select plan from workspaces where id=?", b.workspace_id).plan;
      if (one<any>("select count(*) n from agents where workspace_id=? and status!='deleted'", b.workspace_id).n >= PLANS[plan].agents) fail(402, `the ${plan} plan allows ${PLANS[plan].agents} agents`);
      if (!b.name || !b.job) fail(400, "name and job required");
      const skills = (b.skills ?? []).filter((s: string) => tpl.SKILLS[s]);
      const a = tpl.createAgent(b.workspace_id, u.id, { name: b.name, title: b.title, job: b.job, instructions: b.instructions, skills, permissions: b.permissions, model_profile: b.model_profile });
      rt.privateRoomFor(u.id, a); // a place to talk to it right away
      return json(agentView(a));
    }),
  },
  "/v1/agents/:id": {
    GET: h((req) => { const u = userOf(req); return json(agentView(agentFor(req.params.id, u.id))); }),
    PATCH: h(async (req) => {
      const u = userOf(req), a = agentFor(req.params.id, u.id), b = await body(req);
      if (b.confirm_mode && !["smart", "always", "never"].includes(b.confirm_mode)) fail(400, "confirm_mode must be smart, always or never");
      for (const k of ["name", "job", "instructions", "model_profile", "status", "avatar", "confirm_mode"]) if (b[k] !== undefined) exec(`update agents set ${k}=? where id=?`, b[k], a.id);
      if (b.skills) exec("update agents set skills=? where id=?", S(b.skills.filter((s: string) => tpl.SKILLS[s])), a.id);
      if (b.permissions) {
        for (const [t, m] of Object.entries(b.permissions)) if (!TOOLS[t] || !["auto", "first_time", "ask", "always_ask", "never"].includes(m as string)) fail(400, `bad permission ${t}=${m}`);
        exec("update agents set permissions=? where id=?", S({ ...J(a.permissions, {}), ...b.permissions }), a.id);
      }
      emit("AGENT_UPDATED", { workspace_id: a.workspace_id, actor: u.id, data: { agent_id: a.id, fields: Object.keys(b) } });
      return json(agentView(one("select * from agents where id=?", a.id)));
    }),
  },
  "/v1/agents/:id/upgrade": { POST: h((req) => { const u = userOf(req); agentFor(req.params.id, u.id); return json(tpl.upgradeInstance(req.params.id)); }) },
  "/v1/agents/:id/private-room": { POST: h((req) => { const u = userOf(req); const a = agentFor(req.params.id, u.id); return json(rt.privateRoomFor(u.id, a)); }) },
  "/v1/agents/:id/channels": { POST: h(async (req) => {
    const u = userOf(req), a = agentFor(req.params.id, u.id), b = await body(req);
    member(a.workspace_id, u.id, ["owner", "admin", "member"]);
    const plan = one<any>("select plan from workspaces where id=?", a.workspace_id).plan;
    if (!ch.ADAPTERS[b.platform]) fail(400, "unknown platform");
    if (!PLANS[plan].channels.includes(b.platform)) fail(402, `${b.platform} isn't included in the ${plan} plan`);
    const c = ch.addChannelIdentity(a.id, b.platform, b.address ?? "", b.secret ?? {}, b.config ?? {});
    return json({ ...c, webhook_url: `${pub()}/v1/webhooks/${b.platform}/${c.id}` });
  }) },
  "/v1/agents/:id/channels/:cid": { DELETE: h((req) => { const u = userOf(req); agentFor(req.params.id, u.id);
    exec("delete from channel_identities where id=? and agent_id=?", req.params.cid, req.params.id); return json({ ok: true }); }) },

  // ---- rooms ----
  "/v1/rooms": {
    GET: h((req) => { const u = userOf(req), ws = new URL(req.url).searchParams.get("workspace"); member(ws, u.id);
      return json(all<any>(`select r.*, (select count(*) from room_members m where m.room_id=r.id and m.kind='human') humans, (select count(*) from room_members m where m.room_id=r.id and m.kind='agent') agents,
        (select max(ts) from events e where e.room_id=r.id) last_ts, (select count(*) from approvals a where a.room_id=r.id and a.status='pending') pending
        from rooms r where r.workspace_id=? and r.status='active' and (r.kind!='private' or exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?)) order by last_ts desc`, ws, u.id)); }),
    POST: h(async (req) => {
      const u = userOf(req), b = await body(req); member(b.workspace_id, u.id);
      const members = [{ id: u.id, kind: "human" as const }, ...(b.agent_ids ?? []).map((x: string) => { agentFor(x, u.id, b.workspace_id); return { id: x, kind: "agent" as const }; }),
        ...(b.member_ids ?? []).filter((x: string) => one("select 1 from memberships where workspace_id=? and user_id=?", b.workspace_id, x)).map((x: string) => ({ id: x, kind: "human" as const }))];
      return json(rt.createRoom({ workspace_id: b.workspace_id, name: b.name ?? "New room", objective: b.objective, kind: "shared", participation: b.participation ?? "mention_only", members }));
    }),
  },
  "/v1/rooms/:id": {
    GET: h((req) => { const u = userOf(req); return json(roomView(roomFor(req.params.id, u.id), Number(new URL(req.url).searchParams.get("after") ?? 0))); }),
    PATCH: h(async (req) => { const u = userOf(req), r = roomFor(req.params.id, u.id), b = await body(req);
      if (b.participation && !["mention_only", "relevant", "manager"].includes(b.participation)) fail(400, "bad participation mode");
      for (const k of ["name", "objective", "participation", "status"]) if (b[k] !== undefined) exec(`update rooms set ${k}=? where id=?`, b[k], r.id);
      return json(one("select * from rooms where id=?", r.id)); }),
  },
  "/v1/rooms/:id/members": { POST: h(async (req) => {
    const u = userOf(req), r = roomFor(req.params.id, u.id), b = await body(req);
    if (r.kind === "private") fail(400, "private rooms are 1:1; create a shared room to invite people");
    if (b.agent_id) { agentFor(b.agent_id, u.id, r.workspace_id); rt.addMember(r.id, b.agent_id, "agent"); }
    if (b.user_id) { if (!one("select 1 from memberships where workspace_id=? and user_id=?", r.workspace_id, b.user_id)) fail(400, "invite them to the workspace first"); rt.addMember(r.id, b.user_id, "human"); }
    return json({ ok: true });
  }) },
  "/v1/rooms/:id/endpoints": { POST: h(async (req) => {
    // Point an existing external conversation (e.g. a Slack channel) at this room.
    // Admin-only, group conversations only, and never re-point an existing conversation (that would hijack someone's DM).
    const u = userOf(req), r = roomFor(req.params.id, u.id), b = await body(req);
    member(r.workspace_id, u.id, ["owner", "admin"]);
    if (r.kind !== "shared" || !b.is_group) fail(400, "only group conversations can be attached to shared rooms");
    const ci = one<any>("select ci.* from channel_identities ci join agents a on a.id=ci.agent_id where ci.id=? and a.workspace_id=?", b.channel_identity_id, r.workspace_id) ?? fail(400, "unknown channel identity");
    if (one("select 1 from room_endpoints where platform=? and channel_identity_id=? and external_conversation_id=?", ci.platform, ci.id, b.conversation_id)) fail(409, "that conversation is already linked to a room");
    return json(ch.attachEndpoint(r.id, ci.platform, b.conversation_id, ci.id, true));
  }) },
  "/v1/rooms/:id/messages": { POST: h(async (req) => {
    const u = userOf(req), r = roomFor(req.params.id, u.id), b = await body(req);
    if (!b.text?.trim()) fail(400, "text required");
    const res = await rt.ingestMessage({ roomId: r.id, senderId: u.id, text: b.text.trim(), platform: "web" });
    kick();
    return json(res);
  }) },
  "/v1/rooms/:id/buttons": { POST: h(async (req) => {
    const u = userOf(req), r = roomFor(req.params.id, u.id), b = await body(req);
    const res = await ch.pressButton(String(b.data ?? ""), u.id, r.id, null);
    if (res.error) fail(400, res.error);
    kick();
    return json(res);
  }) },
  "/v1/agents/:id/custom-skills/:sid": { DELETE: h((req) => { const u = userOf(req); agentFor(req.params.id, u.id);
    exec("delete from custom_skills where id=? and agent_id=?", req.params.sid, req.params.id); return json({ ok: true }); }) },
  "/v1/rooms/:id/runs": { POST: h(async (req) => {
    const u = userOf(req), r = roomFor(req.params.id, u.id), b = await body(req);
    const a = agentFor(b.agent_id, u.id, r.workspace_id);
    if (!one("select 1 from room_members where room_id=? and principal_id=?", r.id, a.id)) fail(400, "agent is not in this room");
    const run = rt.createRun({ room: r, agent: a, objective: b.objective, requestedBy: u.id, originEndpointId: "web", kind: "task" });
    kick();
    return json(run);
  }) },
  "/v1/rooms/:id/tasks": { POST: h(async (req) => {
    const u = userOf(req), r = roomFor(req.params.id, u.id), b = await body(req);
    return json(rt.createTask(r.id, { title: b.title, owner: b.owner ?? u.id, agent_action: b.agent_action, subject: b.subject, created_by: u.id }));
  }) },
  "/v1/tasks/:id": { PATCH: h(async (req) => {
    const u = userOf(req), t = one<any>("select * from tasks where id=?", req.params.id) ?? fail(404, "task not found"); roomFor(t.room_id, u.id);
    const b = await body(req);
    if (b.agent_action) exec("update tasks set agent_action=? where id=?", b.agent_action, t.id);
    kick();
    return json(rt.updateTask(t.id, t.room_id, b, u.id));
  }) },

  // ---- runs, waits, approvals ----
  "/v1/runs": { GET: h((req) => {
    const u = userOf(req), q = new URL(req.url).searchParams; member(q.get("workspace"), u.id);
    return json(all<any>(`select * from runs where workspace_id=? ${q.get("status") ? "and status=?" : ""} order by created_at desc limit 100`, q.get("workspace"), ...(q.get("status") ? [q.get("status")] : []))
      .filter((r) => { try { roomFor(r.room_id, u.id); return true; } catch { return false; } }).map((r) => ({ ...r, agent_name: rt.nameOf(r.agent_id), spent: J(r.spent) })));
  }) },
  "/v1/runs/:id": { GET: h((req) => { const u = userOf(req); const r = one<any>("select * from runs where id=?", req.params.id) ?? fail(404, "run not found"); roomFor(r.room_id, u.id); return json(rt.trace(r.id)); }) },
  "/v1/runs/:id/brief": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req), r = one<any>("select * from runs where id=?", req.params.id) ?? fail(404, "run not found");
    roomFor(r.room_id, u.id);
    const res = b.action === "go" ? intake.confirmBrief(r.id, u.id, null) : b.action === "cancel" ? intake.cancelBrief(r.id, u.id)
      : b.action === "revise" && b.text?.trim() ? intake.reviseBrief(r.id, u.id, b.text.trim(), "web") : fail(400, "action must be go, cancel or revise (with text)");
    if ("error" in res) fail(400, res.error!);
    kick();
    return json(res);
  }) },
  "/v1/runs/:id/cancel": { POST: h((req) => { const u = userOf(req); const r = one<any>("select * from runs where id=?", req.params.id) ?? fail(404, "run not found"); roomFor(r.room_id, u.id); return json({ ok: rt.cancelRun(r.id, u.id) }); }) },
  "/v1/waits/:id/resolve": { POST: h(async (req) => {
    // Human resolution of verify/reconnect waits: "it did go through" / "it didn't, retry".
    const u = userOf(req), w = one<any>("select * from waits where id=? and status='open'", req.params.id) ?? fail(404, "wait not found"), b = await body(req);
    roomFor(w.room_id, u.id);
    if (!["verify", "reconnect"].includes(w.kind)) fail(400, "only verification and reconnect waits can be resolved by hand");
    if (w.owner !== u.id) fail(403, `only ${rt.nameOf(w.owner) ?? "its owner"} can resolve this`);
    if (w.kind === "verify") {
      const ex = one<any>("select * from tool_executions where run_id=? and status='unknown' order by created_at desc limit 1", w.run_id);
      if (ex) b.outcome === "succeeded" ? exec("update tool_executions set status='succeeded', result=? where id=?", S({ verified_by: u.name, __status: "SUCCEEDED" }), ex.id) : exec("delete from tool_executions where id=?", ex.id);
    }
    emit("WAIT_RESOLVED", { room_id: w.room_id, run_id: w.run_id, actor: u.id, data: { wait_id: w.id, kind: w.kind, outcome: b.outcome } });
    rt.resumeWait(w.id, `${u.name} resolved "${w.reason}": ${b.outcome ?? "done"}`);
    kick();
    return json({ ok: true });
  }) },
  "/v1/approvals": { GET: h((req) => {
    const u = userOf(req), ws = new URL(req.url).searchParams.get("workspace"); member(ws, u.id);
    const vis = visibleRooms(ws!, u.id);
    return json(all<any>("select a.* from approvals a join rooms r on r.id=a.room_id where r.workspace_id=? order by a.created_at desc limit 200", ws).filter((a) => vis.has(a.room_id))
      .map((a) => ({ ...a, input: J(a.input), approvers: J(a.approvers), can_decide: a.status === "pending" && rt.canApprove(a, u.id), agent_name: rt.nameOf(a.agent_id) })));
  }) },
  "/v1/approvals/:id/decision": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    if (!["approve", "reject"].includes(b.decision)) fail(400, "decision must be approve or reject");
    const r = rt.decideApproval(req.params.id, u.id, b.decision, { ...(b.constraints ?? {}), confirm: !!b.confirm }, null);
    if ("error" in r) fail(400, r.error!);
    kick();
    return json(r);
  }) },

  // ---- connections (plan §2.6, §3.8) ----
  "/v1/connections": {
    GET: h((req) => { const u = userOf(req), ws = new URL(req.url).searchParams.get("workspace"); member(ws, u.id);
      return json(all<any>("select id, workspace_id, owner_id, visibility, provider, label, account, scopes, status, last_used_at, created_at from connections where workspace_id=? and status!='revoked' and (visibility='workspace' or owner_id=?)", ws, u.id)
        .map((c) => ({ ...c, owner: rt.nameOf(c.owner_id), agents: all<any>("select a.id, a.name from connection_grants g join agents a on a.id=g.agent_id where g.connection_id=?", c.id) }))); }),
    POST: h(async (req) => { // direct token / API-key connection (dev + providers without OAuth)
      const u = userOf(req), b = await body(req); member(b.workspace_id, u.id, b.visibility === "workspace" ? ["owner", "admin"] : undefined);
      if (!b.provider || !b.credentials) fail(400, "provider and credentials required");
      const cid = id("con");
      exec("insert into connections (id, workspace_id, owner_id, visibility, provider, label, account, scopes, cred_enc, created_at) values (?,?,?,?,?,?,?,?,?,?)",
        cid, b.workspace_id, u.id, b.visibility ?? "private", b.provider, b.label ?? b.provider, b.account ?? u.email, b.scopes ?? null, seal(b.credentials), now());
      for (const a of b.agent_ids ?? []) { agentFor(a, u.id, b.workspace_id); exec("insert or ignore into connection_grants values (?,?)", cid, a); }
      emit("CONNECTION_CREATED", { workspace_id: b.workspace_id, actor: u.id, data: { connection_id: cid, provider: b.provider } });
      return json({ id: cid });
    }),
  },
  "/v1/connections/:id": { GET: h((req) => {
    const u = userOf(req), c = one<any>("select * from connections where id=?", req.params.id) ?? fail(404, "not found"); member(c.workspace_id, u.id);
    if (c.visibility === "private" && c.owner_id !== u.id) fail(404, "not found");
    const { cred_enc, ...safe } = c;
    return json({ ...safe, owner: rt.nameOf(c.owner_id), agents: all<any>("select a.id, a.name from connection_grants g join agents a on a.id=g.agent_id where g.connection_id=?", c.id),
      audit: all<any>("select e.ts, e.type, e.run_id, e.actor, json_extract(e.data, '$.tool') tool, json_extract(e.data, '$.status') status from events e where e.type='TOOL_CALL_COMPLETED' and json_extract(e.data, '$.connection_id')=? order by e.seq desc limit 50", c.id)
        .map((e) => ({ ...e, agent: rt.nameOf(e.actor) })) });
  }) },
  "/v1/connections/:id/grants": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req), c = one<any>("select * from connections where id=?", req.params.id) ?? fail(404, "not found");
    if (c.owner_id !== u.id) member(c.workspace_id, u.id, ["owner", "admin"]);
    agentFor(b.agent_id, u.id, c.workspace_id);
    exec("insert or ignore into connection_grants values (?,?)", c.id, b.agent_id);
    return json({ ok: true });
  }) },
  "/v1/connections/:id/grants/:agent": { DELETE: h((req) => {
    const u = userOf(req), c = one<any>("select * from connections where id=?", req.params.id) ?? fail(404, "not found");
    if (c.owner_id !== u.id) member(c.workspace_id, u.id, ["owner", "admin"]);
    exec("delete from connection_grants where connection_id=? and agent_id=?", c.id, req.params.agent); return json({ ok: true });
  }) },
  "/v1/connections/:id/revoke": { POST: h((req) => {
    const u = userOf(req), c = one<any>("select * from connections where id=?", req.params.id) ?? fail(404, "not found");
    if (c.owner_id !== u.id) member(c.workspace_id, u.id, ["owner", "admin"]);
    exec("update connections set status='revoked', cred_enc=null where id=?", c.id);
    exec("delete from connection_grants where connection_id=?", c.id);
    emit("CONNECTION_REVOKED", { workspace_id: c.workspace_id, actor: u.id, data: { connection_id: c.id } });
    return json({ ok: true });
  }) },
  "/v1/connections/google/start": { GET: h((req) => {
    const u = userOf(req), q = new URL(req.url).searchParams; member(q.get("workspace"), u.id);
    if (!process.env.GOOGLE_CLIENT_ID) fail(501, "Google OAuth isn't configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), or add a token connection instead");
    const state = Buffer.from(seal({ ws: q.get("workspace"), user: u.id, visibility: q.get("visibility") ?? "private", agent: q.get("agent"), conn: q.get("reconnect"), exp: now() + 6e5 })).toString("base64url");
    const p = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: `${pub()}/v1/connections/google/callback`, response_type: "code", access_type: "offline", prompt: "consent", state,
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/contacts.readonly" });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
  }) },
  "/v1/connections/google/callback": { GET: h(async (req) => {
    const q = new URL(req.url).searchParams;
    const st = unseal<any>(Buffer.from(q.get("state") ?? "", "base64url").toString());
    if (!st || st.exp < now()) fail(400, "expired state");
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code: q.get("code") ?? "", client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${pub()}/v1/connections/google/callback`, grant_type: "authorization_code" }) });
    if (!r.ok) fail(400, "Google token exchange failed");
    const t: any = await r.json();
    const email = JSON.parse(Buffer.from(String(t.id_token).split(".")[1], "base64url").toString()).email; // id_token came straight from Google over TLS
    const cred = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now() + t.expires_in * 1000 };
    let cid = st.conn;
    if (cid) { exec("update connections set cred_enc=?, status='active' where id=? and owner_id=?", seal(cred), cid, st.user); rt.signalEvent(`connection:${cid}`, "connection restored"); kick(); }
    else {
      cid = id("con");
      exec("insert into connections (id, workspace_id, owner_id, visibility, provider, label, account, scopes, cred_enc, created_at) values (?,?,?,?,?,?,?,?,?,?)",
        cid, st.ws, st.user, st.visibility, "google", "Google (Gmail + Calendar)", email, t.scope, seal(cred), now());
      if (st.agent) exec("insert or ignore into connection_grants values (?,?)", cid, st.agent);
    }
    return Response.redirect(`${pub()}/#/connections`, 302);
  }) },

  // ---- memory ----
  "/v1/memory": {
    GET: h((req) => {
      const u = userOf(req), q = new URL(req.url).searchParams, ws = q.get("workspace"); member(ws, u.id);
      const rooms = new Set(all<any>("select r.id from rooms r where r.workspace_id=? and (r.kind!='private' or exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?))", ws, u.id).map((r) => r.id));
      const agentId = q.get("agent");
      return json(mem.listFor(ws!).filter((m) => (m.scope_type === "user_private" ? m.scope_id === u.id : m.scope_type === "room" ? rooms.has(m.scope_id) : true)
        && (!agentId || m.scope_type !== "agent" || m.scope_id === agentId)).map((m) => ({ ...m, scope_name: m.scope_type === "room" ? one<any>("select name from rooms where id=?", m.scope_id)?.name : m.scope_type === "agent" ? rt.nameOf(m.scope_id) : undefined })));
    }),
    POST: h(async (req) => { // explicit save, e.g. promoting a private note to workspace knowledge
      const u = userOf(req), b = await body(req); member(b.workspace_id, u.id);
      if (b.scope === "workspace") member(b.workspace_id, u.id, ["owner", "admin", "member"]);
      const room = b.room_id ? roomFor(b.room_id, u.id) : { id: null, workspace_id: b.workspace_id, kind: "shared" };
      if (b.scope === "room" && !b.room_id) fail(400, "room_id required");
      const r = mem.remember({ room, text: b.text, scope: b.scope, kind: b.kind, createdBy: u.id, scopeId: b.scope === "user_private" ? u.id : b.scope === "agent" ? b.agent_id : undefined, confidence: 1 });
      if ("error" in r) fail(400, r.error!);
      return json(r);
    }),
  },
  "/v1/memory/:id": { DELETE: h((req) => {
    const u = userOf(req), m = one<any>("select * from memories where id=?", req.params.id) ?? fail(404, "not found"); member(m.workspace_id, u.id);
    if (m.scope_type === "user_private" && m.scope_id !== u.id) fail(404, "not found");
    mem.forget(m.id); return json({ ok: true });
  }) },

  // ---- identity ----
  "/v1/identity/link-code": { POST: h((req) => { const u = userOf(req); return json({ code: ch.createLinkCode(u.id), expires_in: 600 }); }) },

  // ---- public agents (plan §18) ----
  "/v1/agent-templates": { GET: h((req) => {
    const u = sessionUser(req), status = new URL(req.url).searchParams.get("status") ?? "published";
    if (status !== "published" && !(u && admins().includes(u.email))) fail(403, "platform admins only");
    return json(tpl.listTemplates(status).map((t) => ({ ...t, manifest: tpl.getManifest(t.id) })));
  }) },
  "/v1/agent-templates/mine": { GET: h((req) => { const u = userOf(req);
    return json(all<any>("select t.* from templates t join publishers p on p.id=t.publisher_id where p.owner_user_id=?", u.id).map((t) => ({ ...t, manifest: tpl.getManifest(t.id), analytics: tpl.creatorAnalytics(t.id) }))); }) },
  "/v1/agent-templates/:slug": { GET: h((req) => {
    const t = one<any>("select t.*, p.name publisher, p.owner_user_id from templates t join publishers p on p.id=t.publisher_id where t.slug=?", req.params.slug) ?? fail(404, "not found");
    const viewer = sessionUser(req);
    const privileged = !!viewer && (viewer.id === t.owner_user_id || admins().includes(viewer.email));
    if (!t.published_version && !privileged) fail(404, "not found");
    const m = tpl.getManifest(t.id, privileged ? t.latest_version : undefined)!;
    return json({ ...t, manifest: m, permissions: tpl.permissionTable(m.skills, m.permissions), connections: tpl.connectionsNeeded(m.skills),
      skills: m.skills.map((s) => tpl.SKILLS[s]), reviews: all<any>("select r.rating, r.text, r.ts, u.name from reviews r join users u on u.id=r.user_id where r.template_id=? order by r.ts desc", t.id),
      versions: all<any>("select version, created_at from template_versions where template_id=? order by created_at desc", t.id) });
  }) },
  "/v1/agent-templates/:slug/install": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req); member(b.workspace_id, u.id);
    const r = tpl.install(req.params.slug, b.workspace_id, u.id, b.answers ?? {});
    if ("error" in r) fail(400, r.error!);
    rt.privateRoomFor(u.id, (r as any).agent);
    return json({ ...r, agent: agentView((r as any).agent) });
  }) },
  "/v1/agent-templates/:slug/fork": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    const r = tpl.fork(req.params.slug, u.id, b.slug ?? `${req.params.slug}-${u.id.slice(-4)}`);
    if ("error" in r) fail(400, r.error!);
    return json(r);
  }) },
  "/v1/agent-templates/:id/versions": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    const r = tpl.submitForReview(req.params.id, u.id, b.manifest);
    if ("error" in r) fail(400, r.error!);
    return json(r);
  }) },
  "/v1/agent-templates/:id/review": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    if (!admins().includes(u.email)) fail(403, "platform admins only");
    if (!["approve", "reject"].includes(b.decision)) fail(400, "decision must be approve or reject");
    const r = tpl.reviewTemplate(req.params.id, b.decision, u.id);
    if ("error" in r) fail(400, r.error!);
    return json(r);
  }) },
  "/v1/agent-templates/:slug/reviews": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    const r = tpl.addReview(req.params.slug, u.id, Number(b.rating), b.text ?? "");
    if ("error" in r) fail(400, r.error!);
    return json(r);
  }) },
  "/v1/agent-templates/:slug/trial": { POST: h(async (req) => {
    const b = await body(req);
    limit(`trial:${req.headers.get("x-forwarded-for") ?? "local"}`, 30);
    const { trialId, userId, agent } = trialAgent(req.params.slug, b.trial_id ?? null);
    const room = rt.privateRoomFor(userId, agent);
    const turns = one<any>("select count(*) n from events where room_id=? and type='message' and actor=?", room.id, userId).n;
    if (turns >= 6) return json({ trial_id: trialId, limit_reached: true, messages: [] });
    if (b.text) {
      const { eventId, started } = await rt.ingestMessage({ roomId: room.id, senderId: userId, text: String(b.text).slice(0, 2000), platform: "web" });
      for (const rid of started) exec("update runs set budget=? where id=?", S({ ...rt.DEFAULT_BUDGET, maxModelCostUsd: 0.1, maxToolCalls: 4, maxAutonomousExternalWrites: 0 }), rid);
      for (let i = 0; i < 8 && started.some((r) => one<any>("select status from runs where id=?", r)?.status === "queued"); i++) await rt.tick();
    }
    const messages = all<any>("select actor, data, ts from events where room_id=? and type='message' order by seq", room.id).map((e) => ({ from: e.actor === userId ? "you" : agent.name, text: J(e.data).text }));
    return json({ trial_id: trialId, messages, upsell: turns + 1 >= 3, limit_reached: false });
  }) },

  // ---- activity, audit, usage ----
  "/v1/activity": { GET: h((req) => {
    const u = userOf(req), q = new URL(req.url).searchParams, ws = q.get("workspace"); member(ws, u.id);
    const hidden = new Set(all<any>("select r.id from rooms r where r.workspace_id=? and r.kind='private' and not exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?)", ws, u.id).map((r) => r.id));
    return json(all<any>(`select * from events where workspace_id=? and type!='message' ${q.get("agent") ? "and actor=?" : ""} order by seq desc limit 200`, ws, ...(q.get("agent") ? [q.get("agent")] : []))
      .filter((e) => !hidden.has(e.room_id)).map((e) => ({ ...e, data: J(e.data), actor_name: rt.nameOf(e.actor), room_name: e.room_id ? one<any>("select name from rooms where id=?", e.room_id)?.name : null })));
  }) },
  "/v1/trace/:id": { GET: h((req) => {
    const u = userOf(req), t = rt.trace(req.params.id) ?? fail(404, "no run behind this message");
    roomFor(t.run.room_id, u.id); return json(t);
  }) },
  "/v1/audit/export": { GET: h((req) => {
    const u = userOf(req), ws = new URL(req.url).searchParams.get("workspace"); member(ws, u.id, ["owner", "admin"]);
    const lines = all<any>("select * from events where workspace_id=? and type!='message' order by seq", ws).map((e) => S({ ...e, data: J(e.data) })).join("\n");
    return new Response(lines, { headers: { "content-type": "application/x-ndjson", "content-disposition": `attachment; filename=audit-${ws}.jsonl` } });
  }) },
  "/v1/usage": { GET: h((req) => {
    const u = userOf(req), ws = new URL(req.url).searchParams.get("workspace"); member(ws, u.id);
    return json({
      by_kind: all<any>("select kind, sum(qty) qty, round(sum(cost_usd), 4) cost_usd, sum(byok) byok_events from usage where workspace_id=? group by kind", ws),
      by_agent: all<any>("select agent_id, round(sum(cost_usd), 4) cost_usd, count(*) events from usage where workspace_id=? and agent_id is not null group by agent_id", ws).map((r) => ({ ...r, agent: rt.nameOf(r.agent_id) })),
      metrics: {
        completed_runs: one<any>("select count(*) n from runs where workspace_id=? and status='completed'", ws).n,
        autonomous_completion_rate: one<any>(`select round(1.0 * sum(case when not exists (select 1 from approvals a where a.run_id=r.id) then 1 else 0 end) / max(count(*), 1), 2) v from runs r where r.workspace_id=? and r.status='completed'`, ws).v,
        approval_acceptance_rate: one<any>("select round(1.0 * sum(a.status='approved') / max(sum(a.status in ('approved','rejected')), 1), 2) v from approvals a join rooms r on r.id=a.room_id where r.workspace_id=?", ws).v,
        cross_channel_rooms: one<any>("select count(*) n from (select room_id from events where workspace_id=? and type='message' group by room_id having count(distinct json_extract(data, '$.platform')) > 1)", ws).n,
      },
    });
  }) },
  "/v1/model-profiles/:name": { PATCH: h(async (req) => {
    const u = userOf(req), b = await body(req);
    if (!admins().includes(u.email)) fail(403, "platform admins only");
    exec("update model_profiles set primary_model=coalesce(?, primary_model), fallback_model=coalesce(?, fallback_model), escalation_model=coalesce(?, escalation_model), max_cost=coalesce(?, max_cost) where name=?",
      b.primary_model ?? null, b.fallback_model ?? null, b.escalation_model ?? null, b.max_cost ?? null, req.params.name);
    return json(one("select * from model_profiles where name=?", req.params.name));
  }) },
  "/v1/catalog": { GET: () => json({ skills: Object.values(tpl.SKILLS), tools: Object.values(TOOLS).map(({ execute, summarize, ...t }) => t), plans: PLANS }) },

  "/v1/webhooks/:platform/:cid": h(async (req) => { const r = await ch.handleWebhook(req.params.platform, req.params.cid, req); kick(); return r; }),
  "/v1/*": () => err(404, "not found"),
  "/*": app,
};

export function serve(port = Number(process.env.PORT ?? 3000)) {
  return Bun.serve({ port, routes, development: process.env.NODE_ENV !== "production" && { hmr: false }, fetch: () => err(404, "not found") });
}
