// HTTP API (plan §34) + webhooks + web app.
import { randomBytes, createHash } from "node:crypto";
import { all, one, exec, emit, id, now, S, J, seal, unseal, tx, patchJson, setTz, tzOf } from "./db";
import * as rt from "./runtime";
import * as ch from "./channels";
import * as tpl from "./templates";
import { PLANS } from "./templates";
import * as mem from "./memory";
import * as intake from "./intake";
import * as billing from "./billing";
import { extractText } from "./media";
import { assessDepth } from "./depth";
import * as spec from "./spec";
import { browserRoutes, bb } from "./browser";
import { PROVIDERS, platformKey } from "./model";
import { TOOLS, getTool, assertPublicUrl } from "./tools";
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
// Sign-in: Clerk when CLERK_SECRET_KEY is set (the browser trades its Clerk session token for our session cookie at
// /v1/auth/clerk), otherwise built-in email/password. Either way the rest of the API sees the same `sid` session.
const clerkOn = () => !!process.env.CLERK_SECRET_KEY;
const clerkPublishableKey = () => process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY ?? null;
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


/** OAuth state: random, stored, single-use, short-lived and bound to the browser session that started it (stops replay and
 *  login-CSRF, i.e. someone tricking you into connecting *their* account). Optional PKCE verifier for providers that support it. */
function issueState(provider: string, userId: string, payload: any, pkce = false) {
  const state = randomBytes(24).toString("base64url"), verifier = pkce ? randomBytes(32).toString("base64url") : null;
  exec("insert into oauth_states (state, provider, workspace_id, user_id, verifier, payload, expires_at) values (?,?,?,?,?,?,?)", state, provider, payload.ws ?? null, userId, verifier, S(payload), now() + 6e5);
  return { state, challenge: verifier ? createHash("sha256").update(verifier).digest("base64url") : null };
}
function takeState(req: Request, provider: string, state: string | null) {
  const row = one<any>("select * from oauth_states where state=? and provider=?", state ?? "", provider);
  if (!row || row.used_at || row.expires_at < now()) fail(400, "This sign-in link expired or was already used. Start again from the app.");
  if (sessionUser(req)?.id !== row.user_id) fail(403, "Finish connecting in the same browser you started from, signed in as the same person.");
  exec("update oauth_states set used_at=? where state=?", now(), row.state);
  return { ...J(row.payload), user: row.user_id, verifier: row.verifier };
}

/** The user's sandbox room with an agent: tools run in test mode, nothing leaves the platform. */
function testRoom(userId: string, a: any) {
  return one<any>(`select r.* from rooms r join room_members m on m.room_id=r.id where r.mode='test' and r.status='active' and m.principal_id=? and exists
      (select 1 from room_members x where x.room_id=r.id and x.principal_id=?)`, userId, a.id)
    ?? rt.createRoom({ workspace_id: a.workspace_id, name: `Test · ${a.name}`, kind: "private", participation: "manager", mode: "test",
      members: [{ id: userId, kind: "human" }, { id: a.id, kind: "agent" }, ...sampleFriends(a)] });
}

/** What's stuck or failed right now (operator view + alerter). */
export async function healthReport() {
    const { photonStatus } = await import("./photon");
    const count = (sql: string, ...p: any[]) => one<any>(sql, ...p)?.n ?? 0;
    const oldestQueued = one<any>("select min(created_at) t from runs where status='queued'")?.t;
    const problems = all<any>("select o.id, o.status, o.error, o.attempts, o.created_at, e.platform, e.external_conversation_id conv from outbox o left join room_endpoints e on e.id=o.endpoint_id where o.status in ('failed','unconfirmed') order by o.created_at desc limit 20");
    const report = {
      imessage: photonStatus,
      outbox: { queued: count("select count(*) n from outbox where status='queued'"), sending: count("select count(*) n from outbox where status='sending'"),
        failed: count("select count(*) n from outbox where status='failed'"), unconfirmed: count("select count(*) n from outbox where status='unconfirmed'") },
      inbound: { queued: count("select count(*) n from inbound_events where status='queued'"), errors_24h: count("select count(*) n from inbound_events where status='error' and received_at>?", now() - 864e5) },
      runs: { queued: count("select count(*) n from runs where status='queued'"), oldest_queued_s: oldestQueued ? Math.round((now() - oldestQueued) / 1000) : 0,
        running: count("select count(*) n from runs where status='running'"), failed_24h: count("select count(*) n from runs where status='failed_terminal' and updated_at>?", now() - 864e5),
        waiting_on_people: count("select count(*) n from runs where status='waiting_for_human'") },
      models: (() => { const f = all<any>("select data from events where type='MODEL_CALL_FAILED' and ts>?", now() - 36e5).map((e) => String(J(e.data, {}).error ?? ""));
        return { failures_1h: f.length, out_of_credit: f.some((x) => /\b402\b/.test(x)) }; })(),
      jobs_24h: all<any>("select json_extract(data, '$.job') job, sum(case when cast(json_extract(data, '$.ok') as text) in ('1','true') then 1 else 0 end) ok, count(*) n from events where type='JOB_OUTCOME' and ts>? group by 1", now() - 864e5),
      problems,
    };
    const alerts = [
      report.imessage.enabled && !report.imessage.connected && "iMessage line is disconnected",
      report.imessage.enabled && report.imessage.mode === "stream" && report.imessage.last_event_at && now() - report.imessage.last_event_at > 6 * 36e5 && "no iMessage traffic for 6h — check the line",
      report.outbox.failed + report.outbox.unconfirmed > 0 && `${report.outbox.failed + report.outbox.unconfirmed} outgoing messages failed or unconfirmed`,
      report.runs.oldest_queued_s > 120 && `requests waiting ${report.runs.oldest_queued_s}s to start — is the worker running?`,
      report.inbound.errors_24h > 0 && `${report.inbound.errors_24h} inbound messages failed to process (24h)`,
      report.models.failures_1h > 0 && `AI model calls failing (${report.models.failures_1h} in the last hour${report.models.out_of_credit ? ", provider says OUT OF CREDIT" : ""})`,
    ].filter(Boolean);
    return { ok: !alerts.length, alerts, ...report };
}

// Alerts reach a person: every 5 minutes, a new alert (not one already sent in the last hour) is emailed to ALERT_EMAIL via Resend.
const alerted = new Map<string, number>();
export async function checkAlerts() {
  const r = await healthReport();
  const fresh = r.alerts.filter((a: any) => Date.now() - (alerted.get(String(a).replace(/\d+/g, "#")) ?? 0) > 36e5) as string[];
  if (!fresh.length) return;
  for (const a of fresh) alerted.set(a.replace(/\d+/g, "#"), Date.now());
  console.error(`[alert] ${fresh.join(" | ")}`);
  if (process.env.ALERT_EMAIL && process.env.RESEND_API_KEY)
    await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: S({ from: process.env.ALERT_FROM ?? "onboarding@resend.dev", to: process.env.ALERT_EMAIL, subject: `[agents] ${fresh[0]}`, text: `${fresh.join("\n")}\n\n${pub()}/v1/admin/health` }) }).catch(() => {});
}

/** What a running agent is doing right now, in words ("searching “Lisbon hotels”", "reading booking.com"). */
/** One line per step, the way a person would say it ("searching “fall hikes”", "reading wpdh.com"). */
function stepLine(tool: string, input: any = {}) {
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "a page"; } };
  if (tool === "web.search") return `searching “${String(input.query ?? "").slice(0, 60)}”`;
  if (tool === "web.fetch") return `reading ${host(input.url)}`;
  if (tool === "browser.task") return `using a browser${input.site ? ` on ${input.site}` : ""}`;
  if (tool === "plan.update") return "planning";
  if (tool === "specialists.run") return `splitting the work (${(input.tasks ?? []).length} parts)`;
  const d = getTool(tool);
  return d?.summarize ? d.summarize(input).charAt(0).toLowerCase() + d.summarize(input).slice(1) : tool.replace(/[._]/g, " ");
}
/** The run's recent steps with their outcome, newest last — the web chat shows these live under "…is working". */
function stepsOf(runId: string, n = 6) {
  const done = new Map(all<any>("select data from events where run_id=? and type in ('TOOL_CALL_COMPLETED','TOOL_CALL_FAILED')", runId).map((e) => { const d = J(e.data, {}); return [d.call_id ?? `${d.tool}`, d.status ?? "FAILED"]; }));
  return all<any>("select data from events where run_id=? and type='TOOL_CALL_REQUESTED' order by seq desc limit ?", runId, n).reverse()
    .map((e) => { const d = J(e.data, {}); return { text: stepLine(d.tool, d.input), status: done.get(d.call_id) ?? done.get(d.tool) ?? "running" }; });
}
function activityOf(runId: string) {
  const e = one<any>("select data from events where run_id=? and type='TOOL_CALL_REQUESTED' order by seq desc limit 1", runId);
  if (!e) return "thinking";
  const { tool, input = {} } = J(e.data, {});
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "a page"; } };
  if (tool === "web.search") return `searching “${String(input.query ?? "").slice(0, 60)}”`;
  if (tool === "web.fetch") return `reading ${host(input.url)}`;
  if (tool === "browser.task") return `using a browser${input.site ? ` on ${input.site}` : ""}`;
  if (tool === "plan.update") return "planning";
  return (getTool(tool)?.summarize?.(input) ?? tool ?? "working").toString().replace(/^./, (c: string) => c.toLowerCase()).slice(0, 80);
}

/** Group agents rehearse in a chat with a couple of sample friends, so "split it with everyone" or "poll the group" can really work. */
function sampleFriends(a: any): { id: string; kind: "human" }[] {
  const group = J(a.spec, {})?.audience === "group" || one<any>("select 1 from installs i join template_versions tv on tv.template_id=i.template_id and tv.version=i.version where i.agent_id=? and json_extract(tv.manifest, '$.category')='group'", a.id);
  if (!group) return [];
  return ["Sam", "Leo"].map((name) => { const uid = id("usr"); exec("insert into users (id, name, guest, created_at) values (?,?,1,?)", uid, `${name} (sample)`, now()); return { id: uid, kind: "human" as const }; });
}

function aiView(ws: string) {
  const b = billing.balance(ws), d = new Date(now()), monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return { ...billing.aiSettings(ws), balance: { ...b, available: b.available === Infinity ? null : Math.round(b.available * 100) / 100 },
    byok: all<any>("select provider from provider_keys where workspace_id=?", ws).map((r) => r.provider),
    platform: PROVIDERS.filter((p) => platformKey(p)), markup: billing.MARKUP(), payments: !!process.env.STRIPE_SECRET_KEY,
    spent_this_month: one<any>("select round(coalesce(sum(cost_usd),0), 4) s from usage where workspace_id=? and byok=0 and ts>=?", ws, monthStart).s,
    ledger: all<any>("select delta_usd, reason, ts from credit_ledger where workspace_id=? order by ts desc limit 10", ws) };
}

function agentView(a: any) {
  return {
    ...a, skills: J(a.skills, []), permissions: J(a.permissions, {}), onboarding: J(a.onboarding, {}), spec: J(a.spec, null),
    // What people asked for that this agent couldn't source (data.missing), most requested first: the list of sources to add next.
    data_gaps: all<any>("select json_extract(data, '$.need') need, json_extract(data, '$.category') category, count(*) n, max(ts) last from events where type='DATA_GAP' and actor=? group by 1, 2 order by n desc, last desc limit 8", a.id),
    permission_table: tpl.permissionTable(J(a.skills, []), J(a.permissions, {}), a.id),
    channels: all<any>("select id, platform, address, config from channel_identities where agent_id=?", a.id).map((c) => ({ ...c, config: J(c.config, {}), webhook_url: `${pub()}/v1/webhooks/${c.platform}/${c.id}` })),
    connections_needed: tpl.connectionsNeeded(J(a.skills, [])),
    custom_skills: tpl.customSkills(a.id), starters: tpl.starters(a),
    deployed: [...new Set(["web", ...all<any>("select e.platform from room_endpoints e join rooms r on r.id=e.room_id where (e.agent_id=? or e.room_id in (select room_id from room_members where principal_id=?)) and r.status='active'", a.id, a.id).map((x) => x.platform)])],
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
      activity: x.status === "running" ? activityOf(x.id) : null, steps: J(x.spent, {}).toolCalls ?? 0, step_list: stepsOf(x.id),
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
  ...browserRoutes, // live-browser website logins (src/browser.ts)
  "/v1/health": { GET: () => json({ ok: true }) },
  // Operator view: what's stuck or failed right now. Platform admins only (it shows cross-workspace counts).
  "/v1/admin/health": { GET: h(async (req) => {
    const u = userOf(req); if (!admins().includes(String(u.email).toLowerCase())) fail(403, "platform admins only");
    return json(await healthReport());
  }) },

  "/v1/webhooks/photon": { POST: async (req: Request) => (await import("./photon")).photonWebhook(req) },
  "/v1/me/tz": { POST: h(async (req) => { const u = userOf(req), b = await body(req); if (!setTz(u.id, String(b.tz ?? ""))) fail(400, "unknown time zone"); return json({ tz: b.tz }); }) },
  "/v1/auth/config": { GET: h(() => json({ clerk: clerkOn() ? clerkPublishableKey() : null })) },
  "/v1/auth/clerk": { POST: h(async (req) => {
    if (!clerkOn()) fail(404, "Clerk sign-in is not enabled");
    limit(`clerk:${req.headers.get("x-forwarded-for") ?? "local"}`, 30);
    const b = await body(req);
    const { verifyToken, createClerkClient } = await import("@clerk/backend");
    const parties = [new URL(pub()).origin, ...(process.env.CLERK_AUTHORIZED_PARTIES ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
    const claims = await verifyToken(String(b.token ?? ""), { secretKey: process.env.CLERK_SECRET_KEY!, authorizedParties: parties }).catch(() => fail(401, "Clerk session is invalid or expired"));
    const cu = await createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! }).users.getUser(claims.sub);
    const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId);
    if (!primary || primary.verification?.status !== "verified") fail(403, "verify your email with Clerk first");
    const email = primary!.emailAddress.toLowerCase(), name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || cu.username || email.split("@")[0];
    // Same person = same Clerk id, or (first Clerk sign-in) the same verified email as an existing account.
    let u = one<any>("select * from users where clerk_id=?", cu.id) ?? one<any>("select * from users where email=? and clerk_id is null", email);
    if (u) { if (!u.clerk_id) exec("update users set clerk_id=? where id=?", cu.id, u.id); }
    else {
      const uid = id("usr");
      tx(() => {
        exec("insert into users (id, email, name, clerk_id, created_at) values (?,?,?,?,?)", uid, email, name, cu.id, now());
        createWorkspace(`${name} — Personal`, "personal", uid);
      });
      u = { id: uid, name, email };
    }
    return startSession(u.id, { user: { id: u.id, name: u.name, email: u.email } });
  }) },
  "/v1/auth/signup": { POST: h(async (req) => {
    if (clerkOn()) fail(404, "sign up with Clerk");
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
    if (clerkOn()) fail(404, "sign in with Clerk");
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
    return json({ user: { id: u.id, name: u.name, email: u.email, tz: u.tz ?? null, platform_admin: admins().includes(u.email) },
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
    PUT: h(async (req) => { const u = userOf(req), b = await body(req), p = req.params.provider; member(req.params.id, u.id, ["owner", "admin"]);
      if (!(PROVIDERS as readonly string[]).includes(p)) fail(400, `provider must be one of ${PROVIDERS.join(", ")}`);
      if (p === "custom") { // any OpenAI-compatible server (Together, Groq, Fireworks, self-hosted Ollama / vLLM)
        if (!/^https?:\/\/[^\s]+$/.test(b.base_url ?? "")) fail(400, "base_url required, e.g. https://api.together.xyz/v1");
        if (!process.env.ALLOW_PRIVATE_MODEL_URLS) await assertPublicUrl(b.base_url).catch(() => fail(400, "that URL points at a private network"));
      } else if (!b.key) fail(400, "key required");
      exec("insert or replace into provider_keys values (?,?,?)", req.params.id, p, seal(p === "custom" ? { key: b.key ?? "", base_url: b.base_url } : b.key));
      exec("update workspaces set ai_mode='byok' where id=?", req.params.id); // adding your key means you want to use it
      emit("BYOK_SET", { workspace_id: req.params.id, actor: u.id, data: { provider: p } }); // never the key
      return json({ ok: true, mode: "byok" }); }),
    DELETE: h((req) => { const u = userOf(req); member(req.params.id, u.id, ["owner", "admin"]);
      exec("delete from provider_keys where workspace_id=? and provider=?", req.params.id, req.params.provider);
      if (!one("select 1 from provider_keys where workspace_id=?", req.params.id)) exec("update workspaces set ai_mode='credits' where id=?", req.params.id);
      return json({ ok: true }); }),
  },
  "/v1/workspaces/:id/ai": {
    GET: h((req) => { const u = userOf(req); member(req.params.id, u.id); return json(aiView(req.params.id)); }),
    PUT: h(async (req) => { const u = userOf(req), b = await body(req); member(req.params.id, u.id, ["owner", "admin"]);
      if (b.mode !== undefined) {
        if (!["credits", "byok"].includes(b.mode)) fail(400, "mode must be credits or byok");
        if (b.mode === "byok" && !one("select 1 from provider_keys where workspace_id=?", req.params.id)) fail(400, "add a model key first");
        exec("update workspaces set ai_mode=? where id=?", b.mode, req.params.id);
      }
      if (b.models) {
        const models = billing.aiSettings(req.params.id).models;
        for (const [profile, spec] of Object.entries<any>(b.models)) {
          if (!one("select 1 from model_profiles where name=?", profile)) fail(400, `unknown profile ${profile}`);
          if (!spec) { delete models[profile]; continue; }
          if (typeof spec !== "string" || !(PROVIDERS as readonly string[]).includes(spec.split(":")[0]) || spec.indexOf(":") < 2 || spec.length > 200) fail(400, "model must look like provider:model-id");
          models[profile] = spec;
        }
        exec("update workspaces set ai_models=? where id=?", S(models), req.params.id);
      }
      emit("AI_SETTINGS_CHANGED", { workspace_id: req.params.id, actor: u.id, data: { mode: b.mode, models: b.models } });
      return json(aiView(req.params.id)); }),
  },
  "/v1/models": { GET: h(async (req) => {
    const u = userOf(req), ws = new URL(req.url).searchParams.get("workspace"); member(ws, u.id);
    const { mode } = billing.aiSettings(ws!), keys = all<any>("select provider from provider_keys where workspace_id=?", ws).map((r) => r.provider);
    return json((await billing.catalog()).map((m) => ({ ...m, available: mode === "byok" ? keys.includes(m.provider) : !!platformKey(m.provider),
      price_in_per_m: mode === "byok" ? m.in_per_m : Math.round(m.in_per_m * billing.MARKUP() * 1000) / 1000, price_out_per_m: mode === "byok" ? m.out_per_m : Math.round(m.out_per_m * billing.MARKUP() * 1000) / 1000 })));
  }) },
  "/v1/workspaces/:id/credits/checkout": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req); member(req.params.id, u.id, ["owner", "admin"]);
    const usd = Number(b.usd); if (!(usd >= 5 && usd <= 1000)) fail(400, "top-ups are $5–$1000");
    const url = await billing.checkout(req.params.id, usd, pub());
    if (!url) fail(501, "payments aren't configured on this server (STRIPE_SECRET_KEY)");
    return json({ url });
  }) },
  "/v1/webhooks/stripe": { POST: async (req: Request) => { const r = billing.stripeWebhook(await req.text(), req.headers.get("stripe-signature")); return new Response(r.status === 200 ? "ok" : "bad signature", { status: r.status }); } },
  "/v1/admin/credits": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    if (!admins().includes(u.email)) fail(403, "platform admins only");
    if (!one("select 1 from workspaces where id=?", b.workspace_id) || !(Number(b.usd) > 0)) fail(400, "workspace_id and positive usd required");
    billing.addCredits(b.workspace_id, Number(b.usd), b.reason ?? "grant", id("grant"));
    return json(billing.balance(b.workspace_id));
  }) },
  "/v1/workspaces/:id/settings": { GET: h((req) => { const u = userOf(req); member(req.params.id, u.id);
    return json({ workspace: one("select * from workspaces where id=?", req.params.id), plan: PLANS[one<any>("select plan from workspaces where id=?", req.params.id).plan],
      byok: all<any>("select provider from provider_keys where workspace_id=?", req.params.id).map((r) => r.provider), ai: aiView(req.params.id),
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
      // A confirmed Agent Spec compiles into standing instructions; its routines become schedules.
      const sp: spec.AgentSpec | null = b.spec && typeof b.spec === "object"
        ? { ...b.spec, skills, depth: assessDepth(b.spec.jobs ?? [], b.spec.routines ?? [], b.spec.depth?.overridden ? b.spec.depth.level : undefined) } : null;
      const answers = Object.fromEntries(Object.entries(b.answers ?? {}).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v).slice(0, 300)]));
      const a = tpl.createAgent(b.workspace_id, u.id, { name: b.name, title: b.title, job: b.job, instructions: sp ? spec.compile(sp, answers) : b.instructions, skills, permissions: b.permissions, model_profile: b.model_profile,
        avatar: typeof b.avatar === "string" && [...b.avatar].length <= 4 ? b.avatar : undefined });
      const room = rt.privateRoomFor(u.id, a); // a place to talk to it right away
      if (sp) {
        exec("update agents set spec=? where id=?", S({ ...sp, answers }), a.id);
        for (const r of (sp.routines ?? []).filter((r) => ["daily", "weekdays", "weekly"].includes(r.every) && r.hour >= 0 && r.hour < 24 && r.objective).slice(0, 3))
          rt.createSchedule({ agent_id: a.id, room_id: room.id, kind: "recurring", spec: { every: r.every, hour: r.hour, ...(r.every === "weekly" ? { day: r.day ?? 1 } : {}) }, objective: String(r.objective).slice(0, 500), created_by: u.id });
      }
      return json(agentView(one<any>("select * from agents where id=?", a.id)));
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
        for (const [t, m] of Object.entries(b.permissions)) if (!getTool(t) || !["auto", "first_time", "ask", "always_ask", "never"].includes(m as string)) fail(400, `bad permission ${t}=${m}`);
        exec("update agents set permissions=? where id=?", S({ ...J(a.permissions, {}), ...b.permissions }), a.id);
      }
      emit("AGENT_UPDATED", { workspace_id: a.workspace_id, actor: u.id, data: { agent_id: a.id, fields: Object.keys(b) } });
      return json(agentView(one("select * from agents where id=?", a.id)));
    }),
  },
  "/v1/agents/:id/upgrade": { POST: h((req) => { const u = userOf(req); agentFor(req.params.id, u.id); return json(tpl.upgradeInstance(req.params.id)); }) },
  "/v1/agents/:id/test-room": { POST: h((req) => { const u = userOf(req); return json(testRoom(u.id, agentFor(req.params.id, u.id))); }) },
  "/v1/agents/interpret": { POST: h(async (req) => {
    const u = userOf(req), b = await body(req);
    if (!b.description?.trim()) fail(400, "describe what the agent should do");
    if (b.workspace_id) member(b.workspace_id, u.id);
    limit(`interpret:${u.id}`, 20);
    return json(await spec.interpret(String(b.description).slice(0, 2000), ["me", "group", "team"].includes(b.audience) ? b.audience : "me", b.workspace_id));
  }) },
  // Edit how an agent behaves after it exists: read its spec, preview a plain-language change, save (recompiles everything).
  "/v1/agents/:id/spec": {
    GET: h((req) => { const u = userOf(req), a = agentFor(req.params.id, u.id); return json(spec.fromAgent(a)); }),
    PUT: h(async (req) => {
      const u = userOf(req), a = agentFor(req.params.id, u.id), b = await body(req);
      if (!b.spec || typeof b.spec !== "object") fail(400, "spec required");
      const sp = spec.sanitize({ ...spec.fromAgent(a), ...b.spec });
      exec("update agents set name=?, avatar=?, job=?, instructions=?, skills=?, spec=? where id=?", sp.name, sp.avatar, sp.understanding || a.job, spec.compile(sp, sp.answers ?? {}), S(sp.skills), S(sp), a.id);
      // Routines are the agent's own recurring work (not people's reminders): replace them with the edited list.
      exec("update schedules set status='cancelled' where agent_id=? and kind='recurring' and status='active' and json_extract(spec, '$.deliver') is null", a.id);
      const room = rt.privateRoomFor(u.id, a);
      for (const r of sp.routines) rt.createSchedule({ agent_id: a.id, room_id: room.id, kind: "recurring", spec: { every: r.every, hour: r.hour, ...(r.every === "weekly" ? { day: r.day ?? 1 } : {}), tz: tzOf(u.id) }, objective: r.objective, created_by: u.id });
      emit("AGENT_EDITED", { workspace_id: a.workspace_id, actor: u.id, data: { agent_id: a.id, summary: Array.isArray(b.summary) ? b.summary.slice(0, 8) : [] } });
      return json(agentView(one<any>("select * from agents where id=?", a.id)));
    }),
  },
  "/v1/agents/:id/revise": { POST: h(async (req) => {
    const u = userOf(req), a = agentFor(req.params.id, u.id), b = await body(req);
    if (!String(b.change ?? "").trim()) fail(400, "say what to change");
    limit(`revise:${u.id}`, 30);
    return json(await spec.revise(b.spec && typeof b.spec === "object" ? spec.sanitize(b.spec) : spec.fromAgent(a), String(b.change).slice(0, 1000), a.workspace_id));
  }) },
  "/v1/agents/:id/rehearse": { POST: h(async (req) => {
    const u = userOf(req), a = agentFor(req.params.id, u.id);
    limit(`rehearse:${u.id}`, 10);
    return json({ results: await spec.rehearse(a, u.id, testRoom(u.id, a)) });
  }) },
  "/v1/agents/:id/deploy": { GET: h((req) => {
    const u = userOf(req), a = agentFor(req.params.id, u.id);
    const dm = rt.privateRoomFor(u.id, a);
    const connected = all<any>(`select e.platform, e.external_conversation_id conv, e.is_group, r.name room, r.id room_id from room_endpoints e join rooms r on r.id=e.room_id
      where (e.agent_id=? or exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?)) and r.status='active' and (r.kind!='private' or exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?))`, a.id, a.id, u.id);
    const slackTeams = all<any>("select id, json_extract(config, '$.team_name') team from channel_identities where platform='slack' and agent_id is null and json_extract(config, '$.workspace_id')=?", a.workspace_id);
    const t = (platform: string, extra: any = {}) => ({ platform, connected: connected.filter((c) => c.platform === platform), ...extra });
    return json({ targets: [
      t("web", { available: true, url: `${pub()}/#/rooms/${dm.id}` }),
      t("mobile", { available: true, url: `${pub()}/#/rooms/${dm.id}`, hint: "Open on your phone and choose Share → Add to Home Screen." }),
      ...["imessage", "whatsapp", "telegram"].map((p) => t(p, { available: !!ch.sharedIdentity(p), address: ch.sharedIdentity(p)?.address, groups: p !== "whatsapp" })),
      t("slack", { available: !!process.env.SLACK_CLIENT_ID, installed: slackTeams, install_url: `/v1/slack/install?agent=${a.id}` }),
      t("email", { available: !!ch.sharedIdentity("email"), address: a.email_alias && process.env.SHARED_EMAIL_DOMAIN ? `${a.email_alias}@${process.env.SHARED_EMAIL_DOMAIN}` : null }),
    ], advanced: agentView(a).channels });
  }) },
  "/v1/agents/:id/deploy/:platform": { POST: h(async (req) => {
    const u = userOf(req), a = agentFor(req.params.id, u.id), b = await body(req), p = req.params.platform, kind = b.kind === "group" ? "group" : "dm";
    member(a.workspace_id, u.id);
    const plan = one<any>("select plan from workspaces where id=?", a.workspace_id).plan;
    if (!PLANS[plan].channels.includes(p)) fail(402, `${p} isn't included in the ${plan} plan`);
    if (p === "email") {
      if (!ch.sharedIdentity("email")) fail(501, "agent email isn't configured on this platform (SHARED_EMAIL_DOMAIN)");
      const alias = a.email_alias ?? `${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}-${a.id.slice(-4)}`;
      exec("update agents set email_alias=? where id=?", alias, a.id);
      return json({ address: `${alias}@${process.env.SHARED_EMAIL_DOMAIN}`, instructions: `Email or CC ${alias}@${process.env.SHARED_EMAIL_DOMAIN}; replies thread by subject.` });
    }
    if (!["imessage", "whatsapp", "telegram", "slack"].includes(p)) fail(400, "unknown platform");
    if (p === "imessage" && ch.imessagePoolMode()) {
      // Photon Free/Pro: no fixed number — the agent texts you first, and groups need a dedicated line.
      if (kind === "group") fail(501, "iMessage group chats need a dedicated number (Photon Business plan). Use WhatsApp or Telegram for groups for now.");
      if (!b.phone) return json({ mode: "pool", needs_phone: true, instructions: `Enter your iPhone number — ${a.name} will text you. Reply YES to start.` });
      limit(`invite:${u.id}`, 10);
      const r = await ch.inviteByText(a, u.id, String(b.phone));
      if ("error" in r) fail(400, r.error!);
      return json({ mode: "pool", sent: true, code: r.code, instructions: `${a.name} just texted you. Reply YES on your iPhone to start.`, expires_in_days: 7 });
    }
    const ident = p === "slack" ? null : ch.sharedIdentity(p) ?? fail(501, `${p} isn't set up on this platform yet`);
    // A line people can't text is worse than none: refuse a placeholder instead of handing out a broken "Open Messages" link.
    const reachable = /^\+?[1-9]\d{7,14}$/.test(String(ident?.address ?? "").replace(/[\s()-]/g, "")) || (p === "imessage" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(ident?.address ?? ""))); // iMessage accounts can be an email
    if ((p === "imessage" || p === "whatsapp") && !reachable)
      fail(501, `the ${p === "imessage" ? "iMessage" : "WhatsApp"} line's phone number isn't set (SHARED_${p.toUpperCase()}_${p === "imessage" ? "LINE" : "NUMBER"} must be a real number like +14155550123)`);
    const code = ch.createDeployCode(a.id, u.id, p, kind);
    const addr = ident?.address ?? "";
    const msg = `${kind === "group" ? "join" : "start"} ${code}`;
    const link = p === "imessage" && kind === "dm" ? `sms:${addr}?&body=${encodeURIComponent(msg)}`
      : p === "whatsapp" ? `https://wa.me/${addr.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`
      : p === "telegram" ? `https://t.me/${addr}?${kind === "group" ? "startgroup" : "start"}=${code}` : null;
    const instructions = kind === "dm" ? `Tap the button on your phone (or send "${msg}" to ${addr || "the bot"}).`
      : p === "imessage" ? `Add ${addr} to your group chat, then send "${msg}" in the group.`
      : p === "telegram" ? `Tap the button to pick a group — ${a.name} joins automatically.` : `In the Slack channel, send "@${a.name} ${msg}".`;
    return json({ code, message: msg, link, address: addr, instructions, expires_in_days: 7 });
  }) },
  "/v1/slack/install": { GET: h((req) => {
    const u = userOf(req), agentId = new URL(req.url).searchParams.get("agent") ?? "", a = agentFor(agentId, u.id);
    if (!process.env.SLACK_CLIENT_ID) fail(501, "Slack isn't configured (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET)");
    const { state } = issueState("slack", u.id, { ws: a.workspace_id, agent: a.id });
    const p = new URLSearchParams({ client_id: process.env.SLACK_CLIENT_ID!, redirect_uri: `${pub()}/v1/slack/oauth/callback`, state,
      scope: "app_mentions:read,channels:history,channels:join,channels:read,chat:write,groups:history,groups:read,im:history,im:write,users:read" });
    return Response.redirect(`https://slack.com/oauth/v2/authorize?${p}`, 302);
  }) },
  "/v1/slack/oauth/callback": { GET: h(async (req) => {
    const q = new URL(req.url).searchParams;
    const st = takeState(req, "slack", q.get("state"));
    const r: any = await (await fetch("https://slack.com/api/oauth.v2.access", { method: "POST", body: new URLSearchParams({ code: q.get("code") ?? "",
      client_id: process.env.SLACK_CLIENT_ID!, client_secret: process.env.SLACK_CLIENT_SECRET!, redirect_uri: `${pub()}/v1/slack/oauth/callback` }) })).json();
    if (!r.ok) fail(400, `Slack install failed: ${r.error}`);
    const prior = one<any>("select json_extract(config, '$.workspace_id') ws from channel_identities where id=?", `chi_slack_${r.team.id}`);
    if (prior?.ws && prior.ws !== st.ws) fail(409, "This Slack workspace is already connected to another workspace on this platform");
    exec(`insert into channel_identities (id, agent_id, platform, address, secret_enc, config, created_at) values (?, null, 'slack', ?, ?, ?, ?)
      on conflict(id) do update set secret_enc=excluded.secret_enc, config=excluded.config`, `chi_slack_${r.team.id}`, r.team.name,
      seal({ bot_token: r.access_token, signing_secret: process.env.SLACK_SIGNING_SECRET }), S({ team_id: r.team.id, team_name: r.team.name, bot_user_id: r.bot_user_id, workspace_id: st.ws, shared: true }), now());
    emit("SLACK_INSTALLED", { workspace_id: st.ws, actor: st.user, data: { team: r.team.name } });
    return Response.redirect(`${pub()}/#/agents/${st.agent}/deploy`, 302);
  }) },
  "/v1/agents/:id/slack/channels": {
    GET: h(async (req) => {
      const u = userOf(req), a = agentFor(req.params.id, u.id);
      const out: any[] = [];
      for (const ci of all<any>("select * from channel_identities where platform='slack' and agent_id is null and json_extract(config, '$.workspace_id')=?", a.workspace_id)) {
        const r: any = await (await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200", { headers: { authorization: `Bearer ${unseal<any>(ci.secret_enc).bot_token}` } })).json();
        for (const c of r.channels ?? []) out.push({ identity: ci.id, team: J(ci.config).team_name, id: c.id, name: c.name, private: c.is_private });
      }
      return json(out);
    }),
    POST: h(async (req) => {
      const u = userOf(req), a = agentFor(req.params.id, u.id), b = await body(req);
      const ci = one<any>("select * from channel_identities where id=? and platform='slack' and json_extract(config, '$.workspace_id')=?", b.identity, a.workspace_id) ?? fail(400, "Slack isn't installed for this workspace");
      if (one("select 1 from room_endpoints where channel_identity_id=? and external_conversation_id=?", ci.id, b.channel_id)) fail(409, "that channel is already connected");
      await fetch("https://slack.com/api/conversations.join", { method: "POST", headers: { authorization: `Bearer ${unseal<any>(ci.secret_enc).bot_token}`, "content-type": "application/json" }, body: S({ channel: b.channel_id }) });
      const room = rt.createRoom({ workspace_id: a.workspace_id, name: `#${b.name ?? b.channel_id}`, kind: "shared", participation: "mention_only", members: [{ id: u.id, kind: "human" }, { id: a.id, kind: "agent" }] });
      ch.attachEndpoint(room.id, "slack", b.channel_id, ci.id, true, a.id);
      return json({ room_id: room.id });
    }),
  },
  "/v1/overview": { GET: h((req) => {
    // Account level: every agent across the user's workspaces — what it does, where it lives, what it's working on.
    const u = userOf(req), d = new Date(now()), month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return json(all<any>("select w.id, w.name, m.role from workspaces w join memberships m on m.workspace_id=w.id where m.user_id=? and w.kind!='trial'", u.id).map((w) => ({
      workspace: w, agents: all<any>("select * from agents where workspace_id=? and status!='deleted'", w.id).map((a) => ({
        id: a.id, name: a.name, avatar: a.avatar, job: a.job, status: a.status, skills: J(a.skills, []),
        deployed: [...new Set(["web", ...all<any>(`select e.platform from room_endpoints e where e.agent_id=? or e.room_id in (select room_id from room_members where principal_id=?)`, a.id, a.id).map((x) => x.platform)])],
        connections: all<any>("select c.provider, c.account from connections c join connection_grants g on g.connection_id=c.id where g.agent_id=? and c.status='active'", a.id),
        open_tasks: one<any>("select count(*) n from tasks t join room_members m on m.room_id=t.room_id where m.principal_id=? and t.status!='done'", a.id).n,
        active_runs: one<any>("select count(*) n from runs where agent_id=? and status not in ('completed','failed_terminal','cancelled')", a.id).n,
        completed_this_month: one<any>("select count(*) n from runs where agent_id=? and status='completed' and completed_at>=?", a.id, month).n,
        memories: one<any>("select count(*) n from memories where scope_type='agent' and scope_id=?", a.id).n,
        spend_this_month: one<any>("select round(coalesce(sum(cost_usd),0), 2) s from usage where agent_id=? and ts>=?", a.id, month).s,
        last_active: one<any>("select max(ts) t from events where actor=?", a.id).t,
      })),
    })));
  }) },
  "/v1/tasks": { GET: h((req) => {
    const u = userOf(req), q = new URL(req.url).searchParams, ws = q.get("workspace"); member(ws, u.id);
    const vis = visibleRooms(ws!, u.id);
    return json(all<any>("select t.*, r.name room_name from tasks t join rooms r on r.id=t.room_id where r.workspace_id=? and coalesce(r.mode,'live')='live' order by t.status='done', t.updated_at desc limit 300", ws)
      .filter((t) => vis.has(t.room_id) && (q.get("mine") !== "1" || t.owner === u.id)).map((t) => ({ ...t, owner_name: rt.nameOf(t.owner), agent: rt.roomAgents(t.room_id)[0]?.name })));
  }) },
  "/v1/work": { GET: h(async (req) => {
    // Everything agents are tracking in this workspace that the user may see: tasks, reservation watches, group orders.
    const u = userOf(req), ws = new URL(req.url).searchParams.get("workspace"); member(ws, u.id);
    const vis = visibleRooms(ws!, u.id);
    const orders = (await import("./orders"));
    return json({
      watches: all<any>("select w.*, r.name room_name from reservation_watches w join rooms r on r.id=w.room_id where w.workspace_id=? order by w.created_at desc limit 50", ws)
        .filter((w) => vis.has(w.room_id)).map((w) => ({ ...w, criteria: J(w.criteria), agent: rt.nameOf(w.agent_id) })),
      reservations: all<any>("select * from reservations where workspace_id=? and user_id=? and status='booked' order by date, time", ws, u.id),
      orders: all<any>("select o.*, r.name room_name from group_orders o join rooms r on r.id=o.room_id where o.workspace_id=? order by o.created_at desc limit 30", ws)
        .filter((o) => vis.has(o.room_id)).map((o) => ({ ...orders.tally(o), room_id: o.room_id, room_name: o.room_name, agent: rt.nameOf(o.agent_id), organizer: rt.nameOf(o.organizer_id) })),
    });
  }) },
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
        from rooms r where r.workspace_id=? and r.status='active' and coalesce(r.mode,'live')='live' and (r.kind!='private' or exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?)) order by last_ts desc`, ws, u.id)); }),
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
  "/v1/rooms/:id/files": { POST: h(async (req) => {
    const u = userOf(req), r = roomFor(req.params.id, u.id);
    const form = await req.formData().catch(() => fail(400, "multipart form with a file is required"));
    const f = form.get("file") as File | null;
    if (!f || typeof f === "string") fail(400, "file required");
    if (f!.size > 15 * 1024 * 1024) fail(413, "files up to 15 MB");
    const buf = new Uint8Array(await f!.arrayBuffer());
    const fid = id("fil");
    exec("insert into files values (?,?,?,?,?,?,?,?,?,?)", fid, r.workspace_id, r.id, f!.name, f!.type || "application/octet-stream", f!.size, buf, await extractText(f!.name, f!.type, new Uint8Array(buf)), u.id, now()); // a copy: the PDF parser detaches the buffer it reads
    const note = String(form.get("text") ?? "").trim();
    const res = await rt.ingestMessage({ roomId: r.id, senderId: u.id, text: `${note || "Here's a file."}\n📎 ${f!.name} (file_id: ${fid})`, platform: "web" });
    kick();
    return json({ file_id: fid, ...res });
  }) },
  "/v1/files/:id": { GET: h((req) => {
    const u = userOf(req), f = one<any>("select * from files where id=?", req.params.id) ?? fail(404, "not found");
    roomFor(f.room_id, u.id);
    const ascii = String(f.name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
    return new Response(f.data, { headers: { "content-type": f.mime, "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`, "x-content-type-options": "nosniff" } });
  }) },
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
  "/v1/runs/:id/eval-case": { GET: h((req) => {
    // Turn a real run into a golden case (evals/cases/*.json). Review the expectations before committing it.
    const u = userOf(req), r = one<any>("select * from runs where id=?", req.params.id) ?? fail(404, "run not found");
    roomFor(r.room_id, u.id);
    const slug = one<any>("select t.slug from agents a join templates t on t.id=a.template_id where a.id=?", r.agent_id)?.slug;
    const ev = (type: string) => all<any>("select data from events where run_id=? and type=? order by seq", r.id, type).map((e) => J(e.data));
    const first = J(one<any>("select data from events where id=?", r.trigger_event_id)?.data)?.text ?? r.objective.split("\n")[0];
    const decision = ev("BRIEF_PROPOSED")[0]?.decision;
    const wrote = all<any>("select tool_id from tool_executions where run_id=? and status='succeeded'", r.id).some((x) => ["write_external", "destructive", "financial"].includes(getTool(x.tool_id)?.risk as string));
    return json({
      id: `case-${r.id.slice(4, 12)}`, suite: "cases", agent: slug ?? "(custom agent: replace with a template slug)",
      group: rt.roomHumanIds(r.room_id).length > 1, connection: all("select 1 from connection_grants where agent_id=?", r.agent_id).length > 0,
      turns: [["Ellie", first], ...ev("BRIEF_REVISED").map((d) => ["Ellie", d.text])],
      expect: { called: [...new Set(ev("TOOL_CALL_REQUESTED").map((d) => d.tool))], approval_for: [...new Set(ev("APPROVAL_REQUESTED").map((d) => d.tool))],
        brief_status: ({ auto: "auto", confirm: "proposed", clarify: "clarifying", skip: "skipped" } as any)[decision], no_external_write: !wrote || undefined },
      _review: "Generated from a real run. Keep only expectations that define correct behavior, then save as evals/cases/<id>.json.",
    });
  }) },
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
      return json(all<any>("select id, workspace_id, owner_id, visibility, provider, label, account, scopes, status, last_used_at, created_at, json_extract(config, '$.site') site, json_array_length(json_extract(config, '$.tools')) tool_count from connections where workspace_id=? and status not in ('revoked','pending') and (visibility='workspace' or owner_id=?)", ws, u.id)
        .map((c) => ({ ...c, owner: rt.nameOf(c.owner_id), agents: all<any>("select a.id, a.name from connection_grants g join agents a on a.id=g.agent_id where g.connection_id=?", c.id) }))); }),
    POST: h(async (req) => { // direct token / API-key connection (dev + providers without OAuth)
      const u = userOf(req), b = await body(req); member(b.workspace_id, u.id, b.visibility === "workspace" ? ["owner", "admin"] : undefined);
      let config: any = {}, account = b.account ?? u.email, label = b.label ?? b.provider, creds = b.credentials;
      if (b.provider === "mcp") {
        // MCP server: discover its tools now so agents can be granted them.
        if (!b.url) fail(400, "MCP server URL required");
        if (!process.env.ALLOW_PRIVATE_MCP) await assertPublicUrl(b.url).catch((e: any) => fail(400, e.message));
        const { listTools, parseHeaders } = await import("./mcp");
        const headers = parseHeaders(b.headers);
        const tools = await listTools(`probe-${id("x")}`, b.url, headers).catch((e: any) => fail(400, `couldn't reach the MCP server: ${e.message}`));
        config = { url: b.url, tools: tools.map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) };
        creds = { headers }; account = new URL(b.url).host; label = b.label ?? new URL(b.url).host;
      } else if (b.provider === "site_login") {
        // Website login (OpenTable, Resy...): used by the browser runner only, never shown to a model.
        if (!b.site || !b.username || !b.password) fail(400, "site, username and password required");
        config = { site: String(b.site).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase() };
        creds = { username: b.username, password: b.password }; account = b.username; label = b.label ?? `${config.site} login`;
      } else if (!b.provider || !b.credentials) fail(400, "provider and credentials required");
      const cid = id("con");
      exec("insert into connections (id, workspace_id, owner_id, visibility, provider, label, account, scopes, cred_enc, config, created_at) values (?,?,?,?,?,?,?,?,?,?,?)",
        cid, b.workspace_id, u.id, b.visibility ?? "private", b.provider, label, account, b.scopes ?? null, seal(creds), S(config), now());
      for (const a of b.agent_ids ?? []) { agentFor(a, u.id, b.workspace_id); exec("insert or ignore into connection_grants values (?,?)", cid, a); }
      emit("CONNECTION_CREATED", { workspace_id: b.workspace_id, actor: u.id, data: { connection_id: cid, provider: b.provider } });
      return json({ id: cid, tools: config.tools?.map((t: any) => ({ name: t.name, risk: t.annotations?.readOnlyHint ? "read" : t.annotations?.destructiveHint ? "destructive" : "write_external" })) });
    }),
  },
  "/v1/connections/:id/refresh": { POST: h(async (req) => {
    const u = userOf(req), c = one<any>("select * from connections where id=? and provider='mcp'", req.params.id) ?? fail(404, "not found");
    if (c.owner_id !== u.id) member(c.workspace_id, u.id, ["owner", "admin"]);
    const { listTools, parseHeaders } = await import("./mcp");
    const tools = await listTools(c.id, J(c.config).url, parseHeaders(unseal<any>(c.cred_enc)?.headers)).catch((e: any) => fail(400, e.message));
    patchJson("connections", "config", c.id, (cfg) => ({ ...cfg, tools: tools.map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) }));
    return json({ tools: tools.length });
  }) },
  "/v1/connections/:id": { GET: h((req) => {
    const u = userOf(req), c = one<any>("select * from connections where id=?", req.params.id) ?? fail(404, "not found"); member(c.workspace_id, u.id);
    if (c.visibility === "private" && c.owner_id !== u.id) fail(404, "not found");
    const { cred_enc, ...safe } = c;
    safe.config = J(c.config, {});
    if (safe.config.tools) safe.config.tools = safe.config.tools.map((t: any) => ({ name: t.name, description: t.description, risk: t.annotations?.readOnlyHint ? "read" : t.annotations?.destructiveHint ? "destructive" : "write_external" }));
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
  "/v1/connections/:id/revoke": { POST: h(async (req) => {
    const u = userOf(req), c = one<any>("select * from connections where id=?", req.params.id) ?? fail(404, "not found");
    if (c.owner_id !== u.id) member(c.workspace_id, u.id, ["owner", "admin"]);
    // Disconnecting also revokes the token at the provider, so a leaked copy is useless (best-effort; local revocation always happens).
    const cred = c.cred_enc ? unseal<any>(c.cred_enc) : null;
    if (c.provider === "browser_login" && J(c.config, {}).context_id) await bb.deleteContext(J(c.config, {}).context_id);
    if (c.provider === "google" && (cred?.refresh_token || cred?.access_token))
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(cred.refresh_token ?? cred.access_token)}`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => {});
    exec("update connections set status='revoked', cred_enc=null where id=?", c.id);
    exec("delete from connection_grants where connection_id=?", c.id);
    emit("CONNECTION_REVOKED", { workspace_id: c.workspace_id, actor: u.id, data: { connection_id: c.id } });
    return json({ ok: true });
  }) },
  "/v1/connections/google/start": { GET: h((req) => {
    const u = userOf(req), q = new URL(req.url).searchParams; member(q.get("workspace"), u.id);
    if (!process.env.GOOGLE_CLIENT_ID) fail(501, "Google OAuth isn't configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), or add a token connection instead");
    const { state, challenge } = issueState("google", u.id, { ws: q.get("workspace"), visibility: q.get("visibility") ?? "private", agent: q.get("agent"), conn: q.get("reconnect") }, true);
    const p = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: `${pub()}/v1/connections/google/callback`, response_type: "code", access_type: "offline", prompt: "consent", state,
      code_challenge: challenge!, code_challenge_method: "S256",
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/contacts.readonly" });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
  }) },
  "/v1/connections/google/callback": { GET: h(async (req) => {
    const q = new URL(req.url).searchParams;
    const st = takeState(req, "google", q.get("state"));
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code: q.get("code") ?? "", client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${pub()}/v1/connections/google/callback`, grant_type: "authorization_code", code_verifier: st.verifier }) });
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
        approval_acceptance_rate: one<any>("select round(1.0 * sum(case when a.status='approved' then 1 else 0 end) / max(sum(case when a.status in ('approved','rejected') then 1 else 0 end), 1), 2) v from approvals a join rooms r on r.id=a.room_id where r.workspace_id=?", ws).v,
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

  "/v1/webhooks/slack/app": h(async (req) => { const r = await ch.handleSlackApp(req); kick(); return r; }),
  "/v1/webhooks/:platform/:cid": h(async (req) => { const r = await ch.handleWebhook(req.params.platform, req.params.cid, req); kick(); return r; }),
  "/v1/*": () => err(404, "not found"),
  "/manifest.webmanifest": () => new Response(Bun.file(new URL("../public/manifest.webmanifest", import.meta.url)), { headers: { "content-type": "application/manifest+json" } }),
  "/icon.svg": () => new Response(Bun.file(new URL("../public/icon.svg", import.meta.url)), { headers: { "content-type": "image/svg+xml" } }),
  "/*": app,
};

export function serve(port = Number(process.env.PORT ?? 3000)) {
  return Bun.serve({ port, routes, development: process.env.NODE_ENV !== "production" && { hmr: false }, fetch: () => err(404, "not found") });
}
