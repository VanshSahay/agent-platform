// HTTP API: auth, tenancy, agent creation, approvals, connections, BYOK, public agents, trials.
import { test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { one, all, exec, J } from "../src/db";
import * as rt from "../src/runtime";
import { serve, worker, attempts } from "../src/server";
import { setup, realFetch, scriptModel, call, net } from "./helpers";

let server: ReturnType<typeof serve>;
beforeAll(() => { server = serve(0); });
afterAll(() => server.stop(true));
beforeEach(() => { setup(); attempts.clear(); process.env.PLATFORM_ADMINS = "admin@example.com"; });

async function api(path: string, opts: { method?: string; body?: any; token?: string } = {}) {
  const r = await realFetch(new URL(path, server.url), { method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await r.text();
  let data: any = text; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, headers: r.headers };
}
async function signup(name: string) {
  const r = await api("/v1/auth/signup", { body: { name, email: `${name.toLowerCase()}@example.com`, password: "password123" } });
  const me = await api("/v1/me", { token: r.data.token });
  return { token: r.data.token as string, id: r.data.user.id as string, ws: me.data.workspaces[0].id as string };
}
const settle = async () => { await worker(); await rt.drain(); };

test("AC-A1 auth: signup creates a personal workspace; bad credentials, brute force and anonymous calls are refused", async () => {
  const e = await signup("Ellie");
  const me = await api("/v1/me", { token: e.token });
  expect(me.data.workspaces[0]).toMatchObject({ kind: "personal", role: "owner" });
  expect((await api("/v1/auth/login", { body: { email: "ellie@example.com", password: "nope" } })).status).toBe(401);
  expect((await api("/v1/auth/login", { body: { email: "ellie@example.com", password: "password123" } })).status).toBe(200);
  expect((await api("/v1/me")).status).toBe(401);
  for (let i = 0; i < 9; i++) await api("/v1/auth/login", { body: { email: "ellie@example.com", password: "nope" } });
  expect((await api("/v1/auth/login", { body: { email: "ellie@example.com", password: "nope" } })).status).toBe(429); // brute-force limit
  expect((await api("/v1/auth/signup", { body: { name: "X", email: "ellie@example.com", password: "password123" } })).status).toBe(409);
});

test("AC-A2 tenant isolation: other workspaces and other people's private rooms are invisible", async () => {
  const e = await signup("Ellie"), m = await signup("Mallory");
  const a = await api("/v1/agents", { token: e.token, body: { workspace_id: e.ws, name: "Ava", job: "assist", skills: ["web-research"] } });
  const rooms = await api(`/v1/rooms?workspace=${e.ws}`, { token: e.token });
  const roomId = rooms.data[0].id;
  expect((await api(`/v1/agents/${a.data.id}`, { token: m.token })).status).toBe(404);
  expect((await api(`/v1/rooms/${roomId}`, { token: m.token })).status).toBe(404);
  expect((await api(`/v1/rooms?workspace=${e.ws}`, { token: m.token })).status).toBe(404);
  expect((await api(`/v1/rooms/${roomId}/messages`, { token: m.token, body: { text: "hi" } })).status).toBe(404);
  // Even a co-admin of a team workspace can't open someone's private DM room with an agent.
  const team = await api("/v1/workspaces", { token: e.token, body: { name: "Team" } });
  const inv = await api(`/v1/workspaces/${team.data.id}/invitations`, { token: e.token, body: { role: "admin" } });
  await api(`/v1/invitations/${inv.data.token}/accept`, { token: m.token, body: {} });
  const ta = await api("/v1/agents", { token: e.token, body: { workspace_id: team.data.id, name: "Relay", job: "ops", skills: [] } });
  const dm = await api(`/v1/agents/${ta.data.id}/private-room`, { token: e.token, body: {} });
  expect((await api(`/v1/rooms/${dm.data.id}`, { token: m.token })).status).toBe(404);
  expect((await api(`/v1/rooms?workspace=${team.data.id}`, { token: m.token })).data.find((r: any) => r.id === dm.data.id)).toBeUndefined();
});

test("AC-A3 create an agent from a description, without ever seeing a prompt", async () => {
  const e = await signup("Ellie");
  const d = await api("/v1/agents/draft", { token: e.token, body: { description: "I want an executive assistant that watches my email, prepares me for meetings, helps schedule things and reminds me when people haven't replied." } });
  expect(d.data.name).toBe("Ava");
  expect(d.data.skills).toEqual(expect.arrayContaining(["email-triage", "email-drafting", "calendar", "meeting-prep", "follow-up-tracking"]));
  expect(d.data.connections).toEqual(["google"]);
  expect(d.data.permissions.find((p: any) => p.tool === "email.send").mode).toBe("ask");
  expect(d.data.permissions.find((p: any) => p.tool === "calendar.cancel_event").mode).toBe("always_ask");
  const a = await api("/v1/agents", { token: e.token, body: { workspace_id: e.ws, ...d.data } });
  expect(a.data.rooms).toHaveLength(1);
  const p = await api(`/v1/agents/${a.data.id}`, { method: "PATCH", token: e.token, body: { permissions: { "email.send": "never" } } });
  expect(p.data.permissions["email.send"]).toBe("never");
  expect((await api(`/v1/agents/${a.data.id}`, { method: "PATCH", token: e.token, body: { permissions: { "email.send": "yolo" } } })).status).toBe(400);
});

test("AC-A4 web chat + approval card + Home 'needs attention' + decision API + 'why did it send this'", async () => {
  const e = await signup("Ellie");
  const inst = await api("/v1/agent-templates/ava-executive-assistant/install", { token: e.token, body: { workspace_id: e.ws, answers: { priorities: "my boss" } } });
  const agentId = inst.data.agent.id;
  await api("/v1/connections", { token: e.token, body: { workspace_id: e.ws, provider: "google", account: "ellie@gmail.test", credentials: { access_token: "tok" }, agent_ids: [agentId] } });
  const room = (await api(`/v1/rooms?workspace=${e.ws}`, { token: e.token })).data[0];
  await api(`/v1/rooms/${room.id}/messages`, { token: e.token, body: { text: "Email bob@corp.test about the board deck" } });
  await settle();
  const home = await api(`/v1/home?workspace=${e.ws}`, { token: e.token });
  expect(home.data.needs_attention.approvals).toHaveLength(1);
  expect(home.data.needs_attention.approvals[0].summary).toMatch(/Send email to bob@corp.test/);
  const apr = home.data.needs_attention.approvals[0];
  expect((await api(`/v1/approvals/${apr.id}/decision`, { token: e.token, body: { decision: "maybe" } })).status).toBe(400);
  await api(`/v1/approvals/${apr.id}/decision`, { token: e.token, body: { decision: "approve" } });
  await settle();
  const view = await api(`/v1/rooms/${room.id}`, { token: e.token });
  const sent = view.data.events.filter((x: any) => x.type === "message").at(-1);
  expect(sent.data.text).toMatch(/Sent the email/);
  const why = await api(`/v1/trace/${sent.id}`, { token: e.token });
  expect(why.data.approvals[0]).toMatchObject({ status: "approved", decided_by_name: "Ellie" });
  expect(why.data.steps.find((s: any) => s.type === "TOOL_CALL_COMPLETED").data.connection_account).toBe("ellie@gmail.test");
});

test("AC-A5 BYOK keys are sealed at rest and never returned; connections never expose credentials", async () => {
  const e = await signup("Ellie");
  await api(`/v1/workspaces/${e.ws}/provider-keys/anthropic`, { method: "PUT", token: e.token, body: { key: "sk-ant-SECRET" } });
  const s = await api(`/v1/workspaces/${e.ws}/settings`, { token: e.token });
  expect(s.data.byok).toEqual(["anthropic"]);
  expect(JSON.stringify(s.data)).not.toContain("SECRET");
  expect(one<any>("select key_enc from provider_keys").key_enc).not.toContain("SECRET");
  const c = await api("/v1/connections", { token: e.token, body: { workspace_id: e.ws, provider: "google", credentials: { access_token: "ya29.SECRET" } } });
  const detail = await api(`/v1/connections/${c.data.id}`, { token: e.token });
  expect(JSON.stringify(detail.data)).not.toContain("SECRET");
  expect(JSON.stringify(all("select * from events"))).not.toContain("SECRET");
  await api(`/v1/connections/${c.data.id}/revoke`, { token: e.token, body: {} });
  expect(one<any>("select status, cred_enc from connections where id=?", c.data.id)).toEqual({ status: "revoked", cred_enc: null });
});

test("AC-A6 invitations, roles, plan limits", async () => {
  const e = await signup("Ellie"), s = await signup("Sam"), x = await signup("Xavier");
  const team = await api("/v1/workspaces", { token: e.token, body: { name: "Acme" } });
  const inv = await api(`/v1/workspaces/${team.data.id}/invitations`, { token: e.token, body: { email: "sam@example.com" } });
  expect((await api(`/v1/invitations/${inv.data.token}/accept`, { token: x.token, body: {} })).status).toBe(403);
  expect((await api(`/v1/invitations/${inv.data.token}/accept`, { token: s.token, body: { title: "Recruiter" } })).status).toBe(200);
  expect((await api(`/v1/workspaces/${team.data.id}/invitations`, { token: s.token, body: {} })).status).toBe(403); // members can't invite
  const members = await api(`/v1/workspaces/${team.data.id}/members`, { token: s.token });
  expect(members.data.map((m: any) => m.name).sort()).toEqual(["Ellie", "Sam"]);
  exec("update workspaces set plan='free' where id=?", e.ws);
  for (const n of ["A", "B"]) await api("/v1/agents", { token: e.token, body: { workspace_id: e.ws, name: n, job: "j", skills: [] } });
  expect((await api("/v1/agents", { token: e.token, body: { workspace_id: e.ws, name: "C", job: "j", skills: [] } })).status).toBe(402);
  const ag = (await api(`/v1/agents?workspace=${e.ws}`, { token: e.token })).data[0];
  expect((await api(`/v1/agents/${ag.id}/channels`, { token: e.token, body: { platform: "slack", secret: {} } })).status).toBe(402); // Slack is a Team feature
  const tgc = await api(`/v1/agents/${ag.id}/channels`, { token: e.token, body: { platform: "telegram", secret: { bot_token: "t", webhook_secret: "s" } } });
  expect(tgc.data.webhook_url).toMatch(/\/v1\/webhooks\/telegram\/chi_/);
});

test("AC-PUB1 discovery lists curated first-party agents; install asks only for what's needed", async () => {
  const e = await signup("Ellie");
  const list = await api("/v1/agent-templates");
  expect(list.data.map((t: any) => t.slug).sort()).toEqual(["atlas-research", "ava-executive-assistant", "recruiter-healthcare", "relay-ops", "scout-travel"]);
  const atlas = await api("/v1/agent-templates/atlas-research");
  expect(atlas.data.connections).toEqual([]); // research needs no account access
  expect(atlas.data.manifest.evals).toContain("citation_coverage");
  const inst = await api("/v1/agent-templates/atlas-research/install", { token: e.token, body: { workspace_id: e.ws, answers: { research_style: "biotech" } } });
  expect(inst.data.agent.instructions).toContain("biotech");
  expect(inst.data.agent.template_version).toBe("1.4.3");
  const relay = await api("/v1/agent-templates/relay-ops/install", { token: e.token, body: { workspace_id: e.ws } });
  expect(relay.data.agent.schedules[0]).toMatchObject({ kind: "recurring", spec: { every: "weekdays", hour: 9 } }); // declared proactivity
});

test("AC-PUB2 fork copies configuration only; publishing is curated; risky manifests are flagged", async () => {
  const e = await signup("Ellie"), admin = await signup("Admin");
  const inst = await api("/v1/agent-templates/ava-executive-assistant/install", { token: e.token, body: { workspace_id: e.ws } });
  exec("insert into memories (id, workspace_id, scope_type, scope_id, text) values ('mem_x', ?, 'agent', ?, 'PRIVATE-USER-FACT')", e.ws, inst.data.agent.id);
  const f = await api("/v1/agent-templates/ava-executive-assistant/fork", { token: e.token, body: { slug: "ellie-ava" } });
  expect(f.data.status).toBe("draft");
  expect(JSON.stringify(f.data)).not.toContain("PRIVATE-USER-FACT");
  const manifest = { ...f.data.manifest, version: "0.2.0", permissions: { ...f.data.manifest.permissions, "email.send": "auto" } };
  const sub = await api(`/v1/agent-templates/${f.data.id}/versions`, { token: e.token, body: { manifest } });
  expect(sub.data).toMatchObject({ status: "in_review", flags: ["email.send set to auto (write_external)"] });
  expect((await api("/v1/agent-templates/ellie-ava")).status).toBe(404); // unpublished: invisible to the public
  expect((await api("/v1/agent-templates/ellie-ava", { token: e.token })).data.status).toBe("in_review");
  expect((await api("/v1/agent-templates/ellie-ava/install", { token: e.token, body: { workspace_id: e.ws } })).status).toBe(400);
  expect((await api(`/v1/agent-templates/${f.data.id}/review`, { token: e.token, body: { decision: "approve" } })).status).toBe(403);
  await api(`/v1/agent-templates/${f.data.id}/review`, { token: admin.token, body: { decision: "approve" } });
  expect((await api("/v1/agent-templates")).data.some((t: any) => t.slug === "ellie-ava")).toBe(true);
  const bad = await api(`/v1/agent-templates/${f.data.id}/versions`, { token: e.token, body: { manifest: { ...manifest, version: "0.3.0", skills: ["hacking"] } } });
  expect(bad.status).toBe(400);
});

test("AC-PUB3 reviews require meaningful usage; creators see aggregates only", async () => {
  const e = await signup("Ellie");
  const inst = await api("/v1/agent-templates/atlas-research/install", { token: e.token, body: { workspace_id: e.ws } });
  expect((await api("/v1/agent-templates/atlas-research/reviews", { token: e.token, body: { rating: 5, text: "great" } })).status).toBe(400);
  const room = rt.privateRoomFor(e.id, one("select * from agents where id=?", inst.data.agent.id));
  scriptModel({ text: "ok" });
  for (let i = 0; i < 3; i++) { await rt.ingestMessage({ roomId: room.id, senderId: e.id, text: `q${i}`, platform: "web" }); await rt.drain(); }
  expect((await api("/v1/agent-templates/atlas-research/reviews", { token: e.token, body: { rating: 5, text: "great" } })).status).toBe(200);
  const { creatorAnalytics } = await import("../src/templates");
  const a = creatorAnalytics(one<any>("select id from templates where slug='atlas-research'").id);
  expect(Object.keys(a).sort()).toEqual(["active_instances", "approvals_granted", "approvals_total", "avg_rating", "installs", "runs_completed", "runs_failed"]);
  expect(a.runs_completed).toBe(3);
});

test("AC-PUB4 anonymous trial: no account needed, upsell after a few turns, hard limit, no external writes", async () => {
  const t1 = await api("/v1/agent-templates/atlas-research/trial", { body: { text: "What's new in cancer vaccines?" } });
  expect(t1.data.messages.map((m: any) => m.from)).toEqual(["you", "Atlas"]);
  const trial = t1.data.trial_id;
  expect(J(one<any>("select budget from runs").budget).maxAutonomousExternalWrites).toBe(0);
  let r: any;
  for (let i = 0; i < 5; i++) r = await api("/v1/agent-templates/atlas-research/trial", { body: { text: `follow-up ${i}`, trial_id: trial } });
  expect(r.data.upsell).toBe(true);
  r = await api("/v1/agent-templates/atlas-research/trial", { body: { text: "one more", trial_id: trial } });
  expect(r.data.limit_reached).toBe(true);
  expect(net.calls.filter((c) => c.method === "POST" && !/duckduckgo|exa/.test(c.url))).toHaveLength(0);
});

test("AC-PUB5 template upgrades change configuration but keep the instance's memory and connections", async () => {
  const e = await signup("Ellie");
  const inst = await api("/v1/agent-templates/relay-ops/install", { token: e.token, body: { workspace_id: e.ws } });
  const agentId = inst.data.agent.id;
  exec("insert into memories (id, workspace_id, scope_type, scope_id, text) values ('mem_k', ?, 'agent', ?, 'keep me')", e.ws, agentId);
  const { publishVersion, getManifest } = await import("../src/templates");
  const t = one<any>("select * from templates where slug='relay-ops'");
  publishVersion({ ...getManifest(t.id)!, version: "1.1.0", job: "Keep the team moving, v1.1" }, t.publisher_id, { platform: true });
  await api(`/v1/agents/${agentId}/upgrade`, { token: e.token, body: {} });
  const a = (await api(`/v1/agents/${agentId}`, { token: e.token })).data;
  expect(a).toMatchObject({ template_version: "1.1.0", job: "Keep the team moving, v1.1" });
  expect(one("select * from memories where id='mem_k'")).toBeTruthy();
});

test("AC-A7 audit export is admin-only; usage ledger tracks raw resources independently of billing", async () => {
  const e = await signup("Ellie"), s = await signup("Sam");
  const team = await api("/v1/workspaces", { token: e.token, body: { name: "Acme" } });
  const inv = await api(`/v1/workspaces/${team.data.id}/invitations`, { token: e.token, body: {} });
  await api(`/v1/invitations/${inv.data.token}/accept`, { token: s.token, body: {} });
  const ag = await api("/v1/agents", { token: e.token, body: { workspace_id: team.data.id, name: "Atlas", job: "research", skills: ["web-research"] } });
  const room = await api(`/v1/agents/${ag.data.id}/private-room`, { token: e.token, body: {} });
  await api(`/v1/rooms/${room.data.id}/messages`, { token: e.token, body: { text: "search for miami hotels" } });
  await settle();
  expect((await api(`/v1/audit/export?workspace=${team.data.id}`, { token: s.token })).status).toBe(403);
  const exp = await api(`/v1/audit/export?workspace=${team.data.id}`, { token: e.token });
  expect(String(exp.data).split("\n").map((l) => JSON.parse(l).type)).toEqual(expect.arrayContaining(["RUN_STARTED", "TOOL_CALL_COMPLETED", "RUN_COMPLETED"]));
  const u = await api(`/v1/usage?workspace=${team.data.id}`, { token: e.token });
  expect(u.data.by_kind.find((k: any) => k.kind === "search_calls").qty).toBe(1);
  expect(u.data.metrics.completed_runs).toBe(1);
});
