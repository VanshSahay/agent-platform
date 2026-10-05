// Live-browser website logins on Browserbase: only a Context id is kept; tasks run on it one at a time, with a logged-out pre-flight and a replay.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { one, all, exec, id, now, S, J, seal } from "../src/db";
import * as rt from "../src/runtime";
import { TOOLS } from "../src/tools";
import { browserRoutes, startBrowserLogin, finishBrowserLogin } from "../src/browser";
import { setup, user, workspace, customAgent, scriptModel, call, net, say, pendingApprovals, lastFrom, events } from "./helpers";

let ellie: string, ws: string, agent: any, room: any, token: string;
const log: { what: string; at: number }[] = [];
let cdpUrl: string | null = null; // tests that care point this at a fake CDP server
const ENV = ["BROWSERBASE_API_KEY", "BROWSERBASE_CONTEXT_SYNC_MS", "BROWSER_TASK_URL"];
beforeEach(() => {
  setup(); log.length = 0; cdpUrl = null;
  Object.assign(process.env, { BROWSERBASE_API_KEY: "bb_live_test_key", BROWSERBASE_CONTEXT_SYNC_MS: "0", BROWSER_TASK_URL: "https://runner.example/run" });
  ellie = user("Ellie"); ws = workspace("WS", ellie);
  agent = customAgent(ws, ellie, ["browser"], { "browser.task": "auto" });
  room = rt.privateRoomFor(ellie, agent);
  token = id("tok"); exec("insert into sessions values (?,?,?)", token, ellie, now() + 864e5);
  let n = 0;
  const bb = /^https:\/\/api\.browserbase\.com\/v1/;
  net.on(new RegExp(bb.source + "/contexts$"), () => Response.json({ id: `ctx-${++n}` }));
  net.on(new RegExp(bb.source + "/sessions$"), () => { const sid = `sess-${++n}`; log.push({ what: `create ${sid}`, at: Date.now() }); return Response.json({ id: sid, connectUrl: "wss://connect.example" }); });
  net.on(new RegExp(bb.source + "/sessions/[^/]+/debug$"), (r) => Response.json({ debuggerFullscreenUrl: `https://www.browserbase.com/devtools-fullscreen/inspector.html?s=${r.url.split("/")[5]}` }));
  net.on(new RegExp(bb.source + "/sessions/[^/]+$"), (r) => {
    if (r.method === "GET") return Response.json({ id: r.url.split("/").at(-1), connectUrl: cdpUrl }); // session details (CDP address)
    log.push({ what: `release ${r.url.split("/").at(-1)}`, at: Date.now() }); return Response.json({ status: "COMPLETED" }); });
  runner(() => Response.json({ status: "succeeded", output: { confirmation: "RSV-9" } }));
});
afterEach(() => { for (const k of ENV) delete process.env[k]; });

const runnerCalls = () => net.to(/runner\.example/).map((c) => c.body);
function runner(onTask: (b: any) => Response | Promise<Response>, probe = { url: "https://resy.com/account", title: "Your account" }) {
  net.on(/runner\.example/, async (_r, b) => {
    if (b.probe) return Response.json(probe);
    log.push({ what: `run ${b.browserbase?.session_id}`, at: Date.now() });
    return onTask(b);
  });
}
async function post(path: string, body: any, tok = token) {
  const r: Response = await browserRoutes[path].POST(new Request(`http://local${path}`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: S(body) }));
  return { status: r.status, data: await r.json() as any };
}
async function liveLogin(site = "resy.com", agentIds = [agent.id]) {
  const u = one<any>("select * from users where id=?", ellie);
  const s = await startBrowserLogin(u, { workspace_id: ws, site });
  return finishBrowserLogin(u, { session_id: s.session_id, workspace_id: ws, site, agent_ids: agentIds });
}

test("AC-BR1 live-browser login keeps only a Browserbase Context id — no password anywhere; 501 without Browserbase", async () => {
  delete process.env.BROWSERBASE_API_KEY;
  expect((await post("/v1/browser-logins/start", { workspace_id: ws, site: "resy.com" })).status).toBe(501);
  process.env.BROWSERBASE_API_KEY = "bb_live_test_key";
  expect((await post("/v1/browser-logins/start", { workspace_id: ws, site: "resy.com" }, "nope")).status).toBe(401);
  expect((await post("/v1/browser-logins/start", { workspace_id: ws, site: "admin.internal.test" })).status).toBe(400); // public sites only

  const s = await post("/v1/browser-logins/start", { workspace_id: ws, site: "https://www.Resy.com/", agent_ids: [agent.id] });
  expect(s.status).toBe(200);
  expect(s.data).toMatchObject({ session_id: "sess-2", context_id: "ctx-1", login_url: "https://resy.com/" });
  expect(s.data.live_view_url).toContain("browserbase.com");
  const created = net.to(/browserbase\.com\/v1\/sessions$/)[0];
  expect(created.headers["x-bb-api-key"]).toBe("bb_live_test_key");
  expect(created.body).toEqual({ browserSettings: { context: { id: "ctx-1", persist: true }, viewport: { width: 1024, height: 700 } }, keepAlive: true, timeout: 1800 });
  // Someone else can't finish my login session.
  const mia = user("Mia"); exec("insert into memberships values (?,?,?,?)", ws, mia, "member", null);
  const miaTok = id("tok"); exec("insert into sessions values (?,?,?)", miaTok, mia, now() + 864e5);
  expect((await post("/v1/browser-logins/finish", { session_id: s.data.session_id, workspace_id: ws, site: "resy.com" }, miaTok)).status).toBe(404);

  const f = await post("/v1/browser-logins/finish", { session_id: s.data.session_id, workspace_id: ws, site: "resy.com", agent_ids: [agent.id] });
  expect(f.status).toBe(200);
  expect(log.map((l) => l.what)).toEqual(["create sess-2", "release sess-2"]); // released = Context saved, billing stopped
  const c = one<any>("select * from connections where id=?", f.data.id);
  expect(c).toMatchObject({ provider: "browser_login", status: "active", owner_id: ellie, cred_enc: null });
  expect(J(c.config)).toEqual({ site: "resy.com", context_id: "ctx-1" });
  expect(one("select 1 from connection_grants where connection_id=? and agent_id=?", c.id, agent.id)).toBeTruthy();
  expect(one<any>("select * from browser_sessions where session_id='sess-2'")).toMatchObject({ purpose: "login", status: "completed", connection_id: c.id });
  // Nothing secret was ever stored: no sealed blob, no password-like field in any connection or event.
  expect(all("select * from connections where cred_enc is not null")).toHaveLength(0);
  expect(S(all("select * from connections")) + S(all("select * from events"))).not.toMatch(/password|secret|cookie/i);

  // Cancel releases an abandoned login and leaves nothing usable behind.
  const s2 = await post("/v1/browser-logins/start", { workspace_id: ws, site: "opentable.com" });
  expect((await post("/v1/browser-logins/cancel", { session_id: s2.data.session_id })).data).toEqual({ ok: true });
  expect(log.at(-1)!.what).toBe(`release ${s2.data.session_id}`);
  expect(one<any>("select status from connections where json_extract(config, '$.site')='opentable.com'").status).toBe("revoked");
});

test("AC-BR2 reconnecting a site replaces the old login (one active per person and site), keeps its agents and resumes parked runs", async () => {
  const first = await liveLogin("resy.com");
  exec("update connections set status='needs_reauth' where id=?", first.id);
  const run = rt.createRun({ room, agent, objective: "book", requestedBy: ellie });
  rt.createWait(run, { kind: "reconnect", reason: "resy login expired", owner: ellie, wake_key: `connection:${first.id}` });
  const second = await liveLogin("resy.com", []); // the reconnect form doesn't re-pick agents
  expect(second.replaced).toEqual([first.id]);
  expect(one<any>("select status from connections where id=?", first.id).status).toBe("revoked");
  expect(all<any>("select id from connections where provider='browser_login' and status='active'").map((c) => c.id)).toEqual([second.id]);
  expect(one("select 1 from connection_grants where connection_id=? and agent_id=?", second.id, agent.id)).toBeTruthy();
  expect(one<any>("select status from waits where run_id=?", run.id).status).not.toBe("open");
});

test("AC-BR3 browser.task with a granted live login runs on its Browserbase Context: approval first, no secrets to the runner, replay recorded", async () => {
  exec("update agents set permissions='{}' where id=?", agent.id); // default: first use needs approval
  const login = await liveLogin("resy.com");
  // A stored password for the same site also exists; the live login is preferred and the password never leaves.
  const pw = id("con");
  exec("insert into connections (id, workspace_id, owner_id, visibility, provider, label, account, cred_enc, config, created_at) values (?,?,?,?,?,?,?,?,?,?)",
    pw, ws, ellie, "private", "site_login", "resy login", "ellie@x.test", seal({ username: "ellie@x.test", password: "hunter2-SECRET" }), S({ site: "resy.com" }), now());
  exec("insert into connection_grants values (?,?)", pw, agent.id);
  log.length = 0;
  scriptModel(call("browser.task", { task: "book Lilia for 2 at 7pm", site: "resy.com" }), (r) => ({ text: r.messages.at(-1)!.content }));
  await say(room.id, ellie, "book lilia");
  const apr = pendingApprovals(room.id)[0];
  expect(apr.tool_id).toBe("browser.task");
  expect(log).toHaveLength(0); // nothing touched the browser before a human approved
  rt.decideApproval(apr.id, ellie, "approve"); await rt.drain();

  const task = runnerCalls().find((b) => b.task)!;
  expect(task.browserbase).toEqual({ context_id: "ctx-1", session_id: "sess-3" });
  expect(task.secrets).toBeUndefined();
  expect(task.allowed_domains).toEqual(["resy.com"]);
  expect(runnerCalls()[0].probe).toEqual({ url: "https://resy.com/account" }); // pre-flight ran first, on the same session
  expect(log.map((l) => l.what)).toEqual(["create sess-3", "run sess-3", "release sess-3"]);
  expect(net.to(/browserbase\.com\/v1\/sessions$/)[0].body).toMatchObject({ browserSettings: { context: { id: "ctx-1", persist: true } } });
  expect(S(net.calls)).not.toContain("hunter2-SECRET");
  const replay = "https://www.browserbase.com/sessions/sess-3";
  expect(lastFrom(room.id, agent.id)).toContain(replay); // the agent can share it
  expect(events("TOOL_CALL_COMPLETED").at(-1).data).toMatchObject({ connection_id: login.id }); // and it's in the trace
  expect(events("TOOL_CALL_COMPLETED").at(-1).data.result_summary).toContain(replay);
  const run = all<any>("select id from runs where room_id=?", room.id).at(-1);
  expect(one<any>("select * from browser_sessions where purpose='task'")).toMatchObject({ connection_id: login.id, session_id: "sess-3", run_id: run.id, replay_url: replay, status: "completed" });
});

test("AC-BR4 logged-out pre-flight marks the login needs_reauth and never runs the task; the next try asks the owner to reconnect", async () => {
  const login = await liveLogin("resy.com");
  runner(() => Response.json({ status: "succeeded" }), { url: "https://resy.com/login?next=/account", title: "Log in" });
  log.length = 0;
  scriptModel(call("browser.task", { task: "book Lilia", site: "resy.com" }), (r) => ({ text: r.messages.at(-1)!.content }));
  await say(room.id, ellie, "book lilia");
  expect(runnerCalls().filter((b) => b.task)).toHaveLength(0);
  expect(lastFrom(room.id, agent.id)).toMatch(/FAILED: the resy\.com login has expired.*reconnect/i);
  expect(one<any>("select status from connections where id=?", login.id).status).toBe("needs_reauth");
  expect(log.map((l) => l.what)).toEqual(["create sess-3", "release sess-3"]);
  expect(one<any>("select status from browser_sessions where purpose='task'").status).toBe("logged_out");

  net.calls.length = 0;
  scriptModel(call("browser.task", { task: "book Lilia again", site: "resy.com" }), (r) => ({ text: r.messages.at(-1)!.content }));
  await say(room.id, ellie, "try again");
  expect(lastFrom(room.id, agent.id)).toMatch(/DENIED: connection is needs_reauth; owner must reconnect/);
  expect(net.to(/browserbase|runner/)).toHaveLength(0);
});

test("AC-BR5 one Browserbase session per login: concurrent tasks wait until the first session is released and its Context has synced", async () => {
  process.env.BROWSERBASE_CONTEXT_SYNC_MS = "60";
  const login = await liveLogin("shop.example.com"); // no known probe: no pre-flight
  runner(async () => { await Bun.sleep(30); return Response.json({ status: "succeeded" }); });
  log.length = 0;
  const cfg = J(one<any>("select config from connections where id=?", login.id).config);
  const ctx = (n: string) => ({ run: { id: `run_${n}`, workspace_id: ws, room_id: room.id }, agent, room, idempotencyKey: `k${n}`,
    browserLogin: { id: login.id, site: cfg.site, context_id: cfg.context_id, config: cfg } });
  const [a, b] = await Promise.all([TOOLS["browser.task"].execute({ task: "one" }, ctx("a")), TOOLS["browser.task"].execute({ task: "two" }, ctx("b"))]);
  expect([a.status, b.status]).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  expect(log.map((l) => l.what.split(" ")[0])).toEqual(["create", "run", "release", "create", "run", "release"]);
  expect(log[3].at - log[2].at).toBeGreaterThanOrEqual(50); // second session opened only after the context sync window
  expect(net.to(/browserbase\.com\/v1\/sessions$/)[1].body.keepAlive).toBe(false);
});

test("AC-BR6 stored site logins still work when there's no live login; MCP browser servers get the contextId; no runner is a clear failure", async () => {
  // site_login fallback: secrets to the HTTP runner, no Browserbase
  const pw = id("con");
  exec("insert into connections (id, workspace_id, owner_id, visibility, provider, label, account, cred_enc, config, created_at) values (?,?,?,?,?,?,?,?,?,?)",
    pw, ws, ellie, "private", "site_login", "resy login", "ellie@x.test", seal({ username: "ellie@x.test", password: "hunter2-SECRET" }), S({ site: "resy.com" }), now());
  exec("insert into connection_grants values (?,?)", pw, agent.id);
  scriptModel(call("browser.task", { task: "log in with {{username}} / {{password}}", site: "resy.com" }), { text: "ok" });
  await say(room.id, ellie, "book on resy");
  expect(runnerCalls()[0]).toMatchObject({ secrets: { username: "ellie@x.test", password: "hunter2-SECRET" }, allowed_domains: ["resy.com"] });
  expect(runnerCalls()[0].browserbase).toBeUndefined();
  expect(net.to(/browserbase/)).toHaveLength(0);

  // A live login with an MCP browser server whose tool takes contextId
  const login = await liveLogin("opentable.com");
  const mcp = id("con"), args: any[] = [];
  exec("insert into connections (id, workspace_id, owner_id, visibility, provider, label, account, cred_enc, config, created_at) values (?,?,?,?,?,?,?,?,?,?)",
    mcp, ws, ellie, "private", "mcp", "Browserbase", "mcp.example", seal({ headers: {} }), S({ url: "https://mcp.example/mcp", tools: [{ name: "browser_task", description: "Run a browser task",
      inputSchema: { type: "object", properties: { task: { type: "string" }, contextId: { type: "string" } }, required: ["task"] } }] }), now());
  exec("insert into connection_grants values (?,?)", mcp, agent.id);
  net.on(/mcp\.example\/mcp/, (_r, b) => {
    if (b.method === "tools/call") args.push(b.params.arguments);
    if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: b.id, result: b.method === "tools/call" ? { content: [{ type: "text", text: S({ status: "booked", confirmation: "OT-1" }) }] } : { protocolVersion: "2025-06-18", capabilities: {} } });
  });
  scriptModel(call("browser.task", { task: "book on opentable", site: "opentable.com" }), (r) => ({ text: r.messages.at(-1)!.content }));
  await say(room.id, ellie, "book on opentable");
  expect(args).toEqual([{ task: "book on opentable", contextId: "ctx-1" }]);
  expect(lastFrom(room.id, agent.id)).toContain("OT-1");
  expect(one<any>("select * from browser_sessions where purpose='task'")).toMatchObject({ connection_id: login.id, status: "completed" });

  // No runner at all: a clear failure, not a signed-out read-only fallback
  exec("delete from connection_grants where connection_id=?", mcp); delete process.env.BROWSER_TASK_URL;
  scriptModel(call("browser.task", { task: "book again", site: "opentable.com", start_url: "https://opentable.com/" }), (r) => ({ text: r.messages.at(-1)!.content }));
  await say(room.id, ellie, "again");
  expect(lastFrom(room.id, agent.id)).toMatch(/FAILED: connect a browser runner/);
});

test("AC-BR7 the live view opens the site's login page for the user (CDP: find the tab, attach, navigate, detach; never close the browser)", async () => {
  const seen: string[] = [];
  const cdp = Bun.serve({ port: 0, fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no"); }, websocket: { message(w, raw) {
    const m = JSON.parse(String(raw)); seen.push(m.method);
    const result = m.method === "Target.getTargets" ? { targetInfos: [{ type: "page", targetId: "T1" }] } : m.method === "Target.attachToTarget" ? { sessionId: "S1" } : m.method === "Page.navigate" ? { frameId: "F1" } : {};
    if (m.method === "Page.navigate") seen.push(`${m.sessionId} -> ${m.params.url}`);
    w.send(JSON.stringify({ id: m.id, result }));
  } } });
  cdpUrl = `ws://localhost:${cdp.port}`;
  const s = await post("/v1/browser-logins/start", { workspace_id: ws, site: "resy.com", login_url: "https://resy.com/login" });
  expect(s.data.opened).toBe(true);
  expect(seen).toEqual(["Target.getTargets", "Target.attachToTarget", "Page.navigate", "S1 -> https://resy.com/login"]);
  cdp.stop(true);
});
