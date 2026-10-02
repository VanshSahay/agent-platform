// Regression tests for the security review findings (one per finding).
import { test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { one, all, J, exec } from "../src/db";
import * as rt from "../src/runtime";
import * as mem from "../src/memory";
import { createLinkCode } from "../src/channels";
import { publishVersion, getManifest, upgradeInstance } from "../src/templates";
import { serve, attempts } from "../src/server";
import { setup, user, workspace, customAgent, installAgent, googleConnection, say, scriptModel, call, net, channel, deliver, tg, link, pendingApprovals, events, realFetch, lastFrom, runsIn } from "./helpers";

let server: ReturnType<typeof serve>;
beforeAll(() => { server = serve(0); });
afterAll(() => server.stop(true));
beforeEach(() => { setup(); attempts.clear(); });
const api = async (path: string, token: string, body?: any, method?: string) => {
  const r = await realFetch(new URL(path, server.url), { method: method ?? (body ? "POST" : "GET"), headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
async function signup(name: string) {
  const r = await realFetch(new URL("/v1/auth/signup", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.com`, password: "password123" }) });
  const d: any = await r.json();
  return { id: d.user.id as string, token: d.token as string, ws: one<any>("select workspace_id from memberships where user_id=?", d.user.id).workspace_id as string };
}

test("AC-S1 outside guests can't use workspace connections or approve their own actions", async () => {
  const owner = user("Owner"), ws = workspace("Biz", owner);
  const a = customAgent(ws, owner, ["email-triage", "email-drafting"], {}, "Ava");
  googleConnection(ws, owner, [a.id], "workspace", "shared@biz.test");
  const t = channel(a.id, "telegram");
  scriptModel(call("email.search", { query: "is:unread" }), call("email.send", { to: ["x@y.test"], subject: "hi", body: "b" }), { text: "done" });
  await deliver("telegram", t.id, tg(66, 66, "Mallory", "search mail and send it"));
  expect(events("PERMISSION_DECISION").map((e) => e.data.decision)).toEqual(["DENY", "DENY"]);
  expect(net.to(/gmail/)).toHaveLength(0);
  // A guest-originated approval (non-connection tool) goes to workspace admins, not the guest.
  const room = one<any>("select room_id from room_endpoints").room_id;
  const run = rt.createRun({ room: one<any>("select * from rooms where id=?", room), agent: a, objective: "x", requestedBy: runsIn(room)[0].requested_by });
  const ap = rt.requestApproval(run, a, { id: "browser.task", risk: "write_external" }, { task: "x" }, "fp1", false, "test", null);
  expect(ap).toBeTruthy();
  const apr = one<any>("select * from approvals where fingerprint='fp1'");
  expect(J(apr.approvers)).toEqual([]);
  expect(rt.canApprove(apr, run.requested_by)).toBe(false);
  expect(rt.canApprove(apr, owner)).toBe(true);
});

test("AC-S2 a teammate's private connection needs its owner's approval, even for reads", async () => {
  const bob = user("Bob"), eve = user("Eve"), ws = workspace("Co", bob, [[eve]]);
  const a = customAgent(ws, bob, ["email-triage"], {}, "Ava");
  googleConnection(ws, bob, [a.id]);
  net.on(/gmail.*messages\?q=/, () => Response.json({ messages: [{ id: "m1" }] }));
  net.on(/gmail.*messages\/m1/, () => Response.json({ snippet: "BOB PRIVATE", payload: { headers: [] } }));
  const room = rt.createRoom({ workspace_id: ws, name: "Snoop", participation: "manager", members: [{ id: eve, kind: "human" }, { id: bob, kind: "human" }, { id: a.id, kind: "agent" }] });
  scriptModel(call("email.search", { query: "salary" }), (r) => ({ text: r.messages.at(-1)!.content.slice(0, 60) }));
  await say(room.id, eve, "search Bob's mail");
  const apr = pendingApprovals(room.id)[0];
  expect(J(apr.approvers)).toEqual([bob]);
  await say(room.id, eve, "approve");
  expect(net.to(/gmail/)).toHaveLength(0);
  rt.decideApproval(apr.id, bob, "reject"); await rt.drain();
  expect(lastFrom(room.id, a.id)).toMatch(/REJECTED/);
  expect(JSON.stringify(all("select * from events"))).not.toContain("BOB PRIVATE");
});

test("AC-S3 conversations can't be hijacked by re-pointing endpoints", async () => {
  const admin = await signup("Admin"), m = await signup("Member");
  const team = await api("/v1/workspaces", admin.token, { name: "T" });
  const inv = await api(`/v1/workspaces/${team.data.id}/invitations`, admin.token, {});
  await api(`/v1/invitations/${inv.data.token}/accept`, m.token, {});
  const ag = await api("/v1/agents", admin.token, { workspace_id: team.data.id, name: "Ava", job: "j", skills: [] });
  const ci = await api(`/v1/agents/${ag.data.id}/channels`, admin.token, { platform: "email", address: "ava@agents.test", secret: { webhook_secret: "whsec_eA==" } });
  const room = await api("/v1/rooms", m.token, { workspace_id: team.data.id, name: "Mine", agent_ids: [ag.data.id] });
  const attach = (tok: string, conv: string, is_group = true) => api(`/v1/rooms/${room.data.id}/endpoints`, tok, { channel_identity_id: ci.data.id, conversation_id: conv, is_group });
  expect((await attach(m.token, "grp-1")).status).toBe(403);            // members can't
  expect((await attach(admin.token, "bob@example.com", false)).status).toBe(400); // DMs can't be attached
  expect((await attach(admin.token, "grp-1")).status).toBe(200);
  expect((await attach(admin.token, "grp-1")).status).toBe(409);        // never re-point
});

test("AC-S4 the approvals list never shows other people's private rooms", async () => {
  const bob = await signup("Bob"), eve = await signup("Eve");
  const team = await api("/v1/workspaces", bob.token, { name: "T" });
  const inv = await api(`/v1/workspaces/${team.data.id}/invitations`, bob.token, { role: "admin" });
  await api(`/v1/invitations/${inv.data.token}/accept`, eve.token, {});
  const ag = await api("/v1/agents", bob.token, { workspace_id: team.data.id, name: "Ava", job: "j", skills: ["email-drafting"] });
  googleConnection(team.data.id, bob.id, [ag.data.id]);
  const dm = await api(`/v1/agents/${ag.data.id}/private-room`, bob.token, {});
  scriptModel(call("email.send", { to: ["doc@x.test"], subject: "my diagnosis", body: "b" }));
  await rt.ingestMessage({ roomId: dm.data.id, senderId: bob.id, text: "send", platform: "web" }); await rt.drain();
  expect((await api(`/v1/approvals?workspace=${team.data.id}`, bob.token)).data).toHaveLength(1);
  expect((await api(`/v1/approvals?workspace=${team.data.id}`, eve.token)).data).toHaveLength(0);
});

test("AC-S5 only verify/reconnect waits can be resolved by hand, and only by their owner", async () => {
  const bob = await signup("Bob");
  const ag = await api("/v1/agents", bob.token, { workspace_id: bob.ws, name: "Ava", job: "j", skills: ["email-drafting"] });
  googleConnection(bob.ws, bob.id, [ag.data.id]);
  const dm = await api(`/v1/agents/${ag.data.id}/private-room`, bob.token, {});
  scriptModel(call("email.send", { to: ["a@b.test"], subject: "s", body: "b" }), { text: "ok" });
  await rt.ingestMessage({ roomId: dm.data.id, senderId: bob.id, text: "send", platform: "web" }); await rt.drain();
  const w = one<any>("select * from waits where status='open' and kind='approval'");
  expect((await api(`/v1/waits/${w.id}/resolve`, bob.token, { outcome: "done" })).status).toBe(400);
  exec("insert into waits (id, run_id, room_id, kind, reason, owner, status, created_at) values ('wait_v', ?, ?, 'verify', 'check', 'someone_else', 'open', 0)", w.run_id, w.room_id);
  expect((await api(`/v1/waits/wait_v/resolve`, bob.token, { outcome: "succeeded" })).status).toBe(403);
});

test("AC-S6 the agent can't lift a human's blocked guard or change a human's task", async () => {
  const sarah = user("Sarah"), ws = workspace("W", sarah);
  const a = customAgent(ws, sarah, ["task-tracking"], {}, "Relay");
  const room = rt.privateRoomFor(sarah, a);
  const t = rt.createTask(room.id, { title: "Amanda follow-up", owner: sarah, agent_action: "blocked", subject: "Amanda" });
  const seen = scriptModel(call("task.update", { task_id: t.id, status: "done" }), { text: "ok" });
  await say(room.id, sarah, "tidy up");
  expect(seen[1].messages.at(-1)!.content).toMatch(/FAILED: "Amanda follow-up" is owned by Sarah/);
  expect(one<any>("select status from tasks where id=?", t.id).status).toBe("open");
  expect(rt.blockedSubjects(room.id)).toEqual(["Amanda"]);
});

test("AC-S7 only a bare yes/no decides an approval", async () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const a = customAgent(ws, ellie, ["email-drafting"], {}, "Ava");
  googleConnection(ws, ellie, [a.id]);
  const room = rt.privateRoomFor(ellie, a);
  scriptModel(call("email.send", { to: ["sam@x.test"], subject: "s", body: "b" }), { text: "ok" });
  await say(room.id, ellie, "send to sam");
  scriptModel({ text: "Noted — want me to change the recipient?" });
  await say(room.id, ellie, "yes but send it to dana@x.test instead");
  expect(pendingApprovals(room.id)).toHaveLength(1);
  expect(net.to(/messages\/send/)).toHaveLength(0);
  await say(room.id, ellie, "No.");
  expect(pendingApprovals(room.id)).toHaveLength(0);
});

test("AC-S8 web.fetch re-checks redirects and resolved addresses (SSRF)", async () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const a = customAgent(ws, ellie, ["web-research"], {}, "Atlas");
  const room = rt.privateRoomFor(ellie, a);
  net.on(/public\.example/, () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
  const seen = scriptModel(call("web.fetch", { url: "https://public.example/r" }), call("web.fetch", { url: "https://db.internal.test/" }),
    call("web.fetch", { url: "http://[::ffff:7f00:1]/" }), { text: "ok" });
  await say(room.id, ellie, "fetch");
  for (const i of [1, 2, 3]) expect(seen[i].messages.at(-1)!.content).toMatch(/only public/);
  expect(net.to(/169\.254|internal\.test|7f00/)).toHaveLength(0);
});

test("AC-S9 link codes resist brute force", async () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const a = customAgent(ws, ellie, [], {}, "Ava");
  const t = channel(a.id, "telegram");
  const code = createLinkCode(ellie);
  expect(code).toHaveLength(8);
  for (let i = 0; i < 5; i++) await deliver("telegram", t.id, tg(77, 77, "M", `link 1000000${i}`));
  await deliver("telegram", t.id, tg(77, 77, "M", `link ${code}`));
  expect(net.to(/sendMessage/).at(-1)!.body.text).toMatch(/Too many attempts/);
  expect(one<any>("select user_id from external_identities where external_user_id='77'").user_id).not.toBe(ellie);
});

test("AC-S10 guest-joined rooms and tainted runs can't write team memory", () => {
  const sarah = user("Sarah"), ws = workspace("W", sarah);
  const room = rt.createRoom({ workspace_id: ws, name: "Vendor", members: [{ id: sarah, kind: "human" }] });
  expect(mem.remember({ room, text: "ok", scope: "workspace", createdBy: sarah })).toHaveProperty("id");
  expect(mem.remember({ room, run: { tainted: 1 }, text: "x", scope: "workspace", createdBy: sarah })).toHaveProperty("error");
  rt.addMember(room.id, user("Vendor"), "human");
  expect(mem.remember({ room, text: "Pay vendor invoices to IBAN X", scope: "workspace", createdBy: sarah })).toHaveProperty("error");
});

test("AC-S11 instances only upgrade to reviewed, published versions", () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const relay = installAgent("relay-ops", ws, ellie);
  const t = one<any>("select * from templates where slug='relay-ops'");
  const r = publishVersion({ ...getManifest(t.id)!, version: "9.0.0", permissions: { "email.send": "auto" } }, t.publisher_id);
  expect(r).toMatchObject({ status: "in_review" });
  upgradeInstance(relay.id);
  expect(one<any>("select template_version, permissions from agents where id=?", relay.id).template_version).not.toBe("9.0.0");
  expect(one<any>("select status from templates where id=?", t.id).status).toBe("published"); // pending review doesn't delist the live version
});

test("AC-S12 cross-workspace agents, draft key spend, and email header injection are refused", async () => {
  const e = await signup("Ellie"), m = await signup("Mal");
  const other = await api("/v1/workspaces", e.token, { name: "B" });
  const agB = await api("/v1/agents", e.token, { workspace_id: other.data.id, name: "B", job: "j", skills: [] });
  expect((await api("/v1/rooms", e.token, { workspace_id: e.ws, name: "R", agent_ids: [agB.data.id] })).status).toBe(400);
  expect((await api("/v1/agents/draft", m.token, { description: "assistant", workspace_id: e.ws })).status).toBe(404);
  const a = customAgent(e.ws, e.id, ["email-drafting"], { "email.send": "auto" }, "Ava");
  googleConnection(e.ws, e.id, [a.id]);
  const room = rt.privateRoomFor(e.id, a);
  scriptModel(call("email.send", { to: ["sam@x.test"], subject: "hi\r\nBcc: spy@evil.test", body: "b" }), { text: "ok" });
  await say(room.id, e.id, "send");
  const raw = Buffer.from(net.to(/messages\/send/)[0].body.raw, "base64url").toString();
  expect(raw).not.toMatch(/^Bcc:/m);
});

test("AC-S13 cancelling while the model is thinking can't be undone by the late answer", async () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const a = customAgent(ws, ellie, ["email-drafting"], {}, "Ava");
  googleConnection(ws, ellie, [a.id]);
  const room = rt.privateRoomFor(ellie, a);
  const { cancelBrief } = await import("../src/intake");
  scriptModel((r) => { cancelBrief(r.runId!, ellie); return call("email.send", { to: ["sam@example.com"], subject: "s", body: "b" }); });
  await say(room.id, ellie, "send sam@example.com the notes");
  const run = runsIn(room.id)[0];
  expect(one<any>("select status from runs where id=?", run.id).status).toBe("cancelled");
  expect(pendingApprovals(room.id)).toHaveLength(0);
  await say(room.id, ellie, "approve");
  expect(net.to(/messages\/send/)).toHaveLength(0);
});

test("AC-S14 a change that lands mid-model-call wins: the stale action never runs", async () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const a = customAgent(ws, ellie, ["email-drafting"], {}, "Ava");
  googleConnection(ws, ellie, [a.id]);
  const room = rt.privateRoomFor(ellie, a);
  const { reviseBrief } = await import("../src/intake");
  let first = true;
  scriptModel((r) => {
    if (first) { first = false; reviseBrief(r.runId!, ellie, "actually send it to dana@example.com instead", "web"); return call("email.send", { to: ["sam@example.com"], subject: "s", body: "b" }); }
    return r.messages.some((m) => m.role === "tool") ? { text: "Sent to Dana." } : call("email.send", { to: ["dana@example.com"], subject: "s", body: "b" });
  });
  await say(room.id, ellie, "send sam@example.com the notes");
  expect(all<any>("select input from approvals").map((x) => J(x.input).to[0])).not.toContain("sam@example.com");
  await say(room.id, ellie, "go");
  await say(room.id, ellie, "approve");
  const to = net.to(/messages\/send/).map((c) => Buffer.from(c.body.raw, "base64url").toString().match(/^To: (.*)$/m)![1]);
  expect(to).toEqual(["dana@example.com"]);
});

test("AC-S15 only the agent's owner or an admin can save a learned skill", async () => {
  const owner = user("Owner"), member = user("Member"), ws = workspace("W", owner, [[member]]);
  const atlas = installAgent("atlas-research", ws, owner);
  const room = rt.createRoom({ workspace_id: ws, name: "Team", participation: "manager", members: [{ id: owner, kind: "human" }, { id: member, kind: "human" }, { id: atlas.id, kind: "agent" }] });
  for (const t of ["solar", "wind", "hydro"]) await say(room.id, member, `Search for the latest news on ${t}`);
  const offer = all<any>("select data from events where room_id=? and type='message'", room.id).map((e) => J(e.data)).find((d) => d.buttons?.[0]?.data.startsWith("skl:"));
  const { pressButton } = await import("../src/channels");
  expect(await pressButton(offer.buttons[0].data, member, room.id, null)).toHaveProperty("error");
  expect(all("select * from custom_skills")).toHaveLength(0);
  expect(await pressButton(offer.buttons[0].data, owner, room.id, null)).toEqual({ ok: true });
  expect(await pressButton("brf:" + offer.buttons[0].data.split(":")[1] + ":bogus", owner, room.id, null)).toHaveProperty("error");
});

test("AC-S16 a message addressed to another agent is never folded into someone else's pending task", async () => {
  const ellie = user("Ellie"), ws = workspace("W", ellie);
  const rec = customAgent(ws, ellie, ["delegation", "reminders"], {}, "Recruiter");
  const scout = customAgent(ws, ellie, ["web-research"], {}, "Scout");
  customAgent(ws, ellie, ["web-research"], {}, "Credentialing");
  const room = rt.createRoom({ workspace_id: ws, name: "G", members: [{ id: ellie, kind: "human" }, { id: rec.id, kind: "agent" }, { id: scout.id, kind: "agent" }] });
  await say(room.id, ellie, "@Recruiter ask Credentialing to check BLS and remind me in 2 hours");
  expect(runsIn(room.id)[0].brief_status).toBe("proposed");
  await say(room.id, ellie, "@Scout search for the latest news on nurse staffing");
  expect(runsIn(room.id)[0].objective).not.toContain("Scout");
  expect(runsIn(room.id).some((r) => r.agent_id === scout.id)).toBe(true);
});

test("AC-S17 unicode file names download; free-time search inputs are bounded; finished tasks can't be 'cancelled' again", async () => {
  const e = await signup("Ellie");
  const ag = await api("/v1/agents", e.token, { workspace_id: e.ws, name: "Ava", job: "j", skills: [] });
  const room = (await api(`/v1/agents/${ag.data.id}/private-room`, e.token, {})).data;
  const fd = new FormData(); fd.append("file", new File(["hi"], "简历.txt", { type: "text/plain" }));
  const up: any = await (await realFetch(new URL(`/v1/rooms/${room.id}/files`, server.url), { method: "POST", headers: { authorization: `Bearer ${e.token}` }, body: fd })).json();
  const dl = await realFetch(new URL(`/v1/files/${up.file_id}`, server.url), { headers: { authorization: `Bearer ${e.token}` } });
  expect(dl.status).toBe(200);
  expect(dl.headers.get("content-disposition")).toContain("filename*=UTF-8''%E7%AE%80%E5%8E%86.txt");
  const { TOOLS } = await import("../src/tools");
  net.on(/freeBusy/, () => Response.json({ calendars: {} }));
  const t0 = Date.now();
  const out = await TOOLS["calendar.find_free_time"].execute({ days: 1e7, duration_minutes: 100000 }, { connection: { id: "c", cred: { access_token: "t" }, account: "a" } } as any);
  expect(Date.now() - t0).toBeLessThan(500);
  expect(out.output.duration_minutes).toBe(480);
  const { cancelBrief } = await import("../src/intake");
  const run = one<any>("select * from runs limit 1");
  exec("update runs set status='completed' where id=?", run.id);
  expect(cancelBrief(run.id, run.requested_by)).toHaveProperty("error");
});
