// MCP servers as tools (incl. browser agents) and website logins passed to the browser runner only.
import { test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { one, all, J, S } from "../src/db";
import * as rt from "../src/runtime";
import { serve, attempts } from "../src/server";
import { setup, realFetch, scriptModel, call, net, pendingApprovals, events, lastFrom } from "./helpers";

let server: ReturnType<typeof serve>;
beforeAll(() => { server = serve(0); });
afterAll(() => server.stop(true));
beforeEach(() => { setup(); attempts.clear(); fakeMcp(); });

const mcpCalls: any[] = [];
function fakeMcp() {
  mcpCalls.length = 0;
  net.on(/mcp\.example\/mcp/, (req, b) => {
    mcpCalls.push({ ...b, session: req.headers.get("mcp-session-id"), auth: req.headers.get("authorization") });
    const reply = (result: any, sse = false) => sse
      ? new Response(`event: message\ndata: ${S({ jsonrpc: "2.0", id: b.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ jsonrpc: "2.0", id: b.id, result }, { headers: { "mcp-session-id": "sess-1" } });
    if (b.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-browser" } });
    if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (b.method === "tools/list") return reply({ tools: [
      { name: "browser_task", description: "Run a browser agent task", inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } },
      { name: "get_page", description: "Read a page", inputSchema: { type: "object", properties: { url: { type: "string" } } }, annotations: { readOnlyHint: true } },
    ] });
    if (b.method === "tools/call") return reply({ content: [{ type: "text", text: b.params.name === "get_page" ? "Page text: Lilia, Brooklyn" : S({ status: "done", confirmation: "RSV-123" }) }] }, true);
    return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "nope" } });
  });
}
async function api(path: string, token: string, body?: any, method?: string) {
  const r = await realFetch(new URL(path, server.url), { method: method ?? (body ? "POST" : "GET"), headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function signup(name: string) {
  const r: any = await (await realFetch(new URL("/v1/auth/signup", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.com`, password: "password123" }) })).json();
  return { id: r.user.id as string, token: r.token as string, ws: one<any>("select workspace_id from memberships where user_id=?", r.user.id).workspace_id as string };
}

test("AC-MCP1 connecting an MCP server discovers its tools; granted agents call them through policy, approvals and audit", async () => {
  const e = await signup("Ellie");
  const ag = (await api("/v1/agents", e.token, { workspace_id: e.ws, name: "Reese", job: "reservations", skills: [] })).data;
  const c = await api("/v1/connections", e.token, { workspace_id: e.ws, provider: "mcp", url: "https://mcp.example/mcp", headers: "Authorization: Bearer bu-secret", label: "Browser Use", agent_ids: [ag.id] });
  expect(c.data.tools).toEqual([{ name: "browser_task", risk: "write_external" }, { name: "get_page", risk: "read" }]);
  const view = (await api(`/v1/agents/${ag.id}`, e.token)).data;
  const ids = view.permission_table.map((p: any) => p.tool).filter((t: string) => t.startsWith("mcp."));
  expect(ids).toHaveLength(2);
  const read = ids.find((t: string) => t.endsWith("get_page")), write = ids.find((t: string) => t.endsWith("browser_task"));
  const room = rt.privateRoomFor(e.id, one<any>("select * from agents where id=?", ag.id));
  scriptModel(call(read, { url: "https://resy.com/lilia" }), (r) => ({ text: r.messages.at(-1)!.content.includes("Lilia") ? "Read it." : "?" }));
  await rt.ingestMessage({ roomId: room.id, senderId: e.id, text: "read the page", platform: "web" }); await rt.drain();
  expect(lastFrom(room.id, ag.id)).toBe("Read it.");
  scriptModel(call(write, { task: "find a table" }), { text: "done" });
  await rt.ingestMessage({ roomId: room.id, senderId: e.id, text: "use the browser", platform: "web" }); await rt.drain();
  expect(pendingApprovals(room.id)[0].tool_id).toBe(write); // non-read MCP tools need approval the first time
  expect(mcpCalls.filter((m) => m.method === "tools/call")).toHaveLength(1);
  expect(mcpCalls.every((m) => m.method === "initialize" || m.auth === "Bearer bu-secret")).toBe(true);
  expect(S(all("select * from events"))).not.toContain("bu-secret");
});

test("AC-MCP2 browser.task runs on a granted MCP browser server; website logins go only to the HTTP runner and follow ownership rules", async () => {
  const e = await signup("Ellie"), m = await signup("Mia");
  const ag = (await api("/v1/agents", e.token, { workspace_id: e.ws, name: "Reese", job: "reservations", skills: ["browser"] })).data;
  await api("/v1/connections", e.token, { workspace_id: e.ws, provider: "mcp", url: "https://mcp.example/mcp", label: "Browser Use", agent_ids: [ag.id] });
  const room = rt.privateRoomFor(e.id, one<any>("select * from agents where id=?", ag.id));
  scriptModel(call("browser.task", { task: "book Lilia", start_url: "https://resy.com/lilia" }), (r) => ({ text: r.messages.at(-1)!.content }));
  await rt.ingestMessage({ roomId: room.id, senderId: e.id, text: "book it", platform: "web" }); await rt.drain();
  await rt.ingestMessage({ roomId: room.id, senderId: e.id, text: "approve", platform: "web" }); await rt.drain();
  expect(lastFrom(room.id, ag.id)).toContain("RSV-123");

  // HTTP runner path with a stored Resy login
  exec2(`delete from connection_grants`);
  process.env.BROWSER_TASK_URL = "https://runner.example/run";
  let sent: any = null;
  net.on(/runner\.example/, (_r, b) => { sent = b; return Response.json({ status: "succeeded", output: "booked" }); });
  const login = await api("/v1/connections", e.token, { workspace_id: e.ws, provider: "site_login", site: "https://www.resy.com/", username: "ellie@x.test", password: "hunter2-SECRET", agent_ids: [ag.id] });
  expect(one<any>("select config from connections where id=?", login.data.id).config).toBe(S({ site: "resy.com" }));
  scriptModel(call("browser.task", { task: "log in with {{username}} / {{password}} and book", site: "resy.com" }), { text: "ok" });
  await rt.ingestMessage({ roomId: room.id, senderId: e.id, text: "book on resy", platform: "web" }); await rt.drain();
  expect(sent.secrets).toEqual({ username: "ellie@x.test", password: "hunter2-SECRET" });
  expect(sent.allowed_domains).toEqual(["resy.com"]);
  expect(S(all("select * from events")) + S(all("select * from run_steps"))).not.toContain("hunter2-SECRET");
  delete process.env.BROWSER_TASK_URL;
});

const exec2 = (sql: string) => require("../src/db").exec(sql);
