// Any MCP server a person connects becomes their tools: today that is iphone-use on their Mac (phone_* tools).
// Streamable HTTP transport: initialize → tools/list → tools/call. Still behind the gateway (consent, audit).
import { sql, seal, unseal, id, now, J } from "../db";
import { ToolError, type ToolDef } from "./index";
import { assertPublicUrl } from "./web";

const PROTOCOL = "2025-06-18";
const sessions = new Map<string, string>();
let seq = 1;

async function post(url: string, headers: Record<string, string>, body: any, session?: string) {
  if (!process.env.ALLOW_PRIVATE_MCP) await assertPublicUrl(url);
  return fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(Number(process.env.MCP_TIMEOUT_MS ?? 120_000)),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...headers, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
}
async function read(r: Response, rid: number) {
  if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of (await r.text()).split(/\r?\n/)) if (line.startsWith("data:")) { try { const m = JSON.parse(line.slice(5).trim()); if (m.id === rid) return m; } catch {} }
    throw new Error("MCP stream ended without a response");
  }
  return r.json();
}
async function rpc(key: string, url: string, headers: Record<string, string>, method: string, params: any, retry = true): Promise<any> {
  if (!sessions.has(key)) {
    const rid = seq++;
    const r = await post(url, headers, { jsonrpc: "2.0", id: rid, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "agent-platform", version: "2.0" } } });
    if (!r.ok) throw new Error(`MCP initialize failed (${r.status})`);
    const m: any = await read(r, rid);
    if (m.error) throw new Error(`MCP initialize: ${m.error.message}`);
    sessions.set(key, r.headers.get("mcp-session-id") ?? "");
    await post(url, headers, { jsonrpc: "2.0", method: "notifications/initialized" }, sessions.get(key) || undefined).catch(() => {});
  }
  const rid = seq++;
  const r = await post(url, headers, { jsonrpc: "2.0", id: rid, method, params }, sessions.get(key) || undefined);
  if ((r.status === 404 || r.status === 400) && retry) { sessions.delete(key); return rpc(key, url, headers, method, params, false); }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("the device rejected the credentials"), { auth: true });
  if (!r.ok) throw new Error(`MCP ${method} failed (${r.status})`);
  const m: any = await read(r, rid);
  if (m.error) throw new Error(`MCP ${method}: ${m.error.message}`);
  return m.result;
}

export interface McpTool { name: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
export async function listTools(key: string, url: string, headers: Record<string, string>): Promise<McpTool[]> {
  const out: McpTool[] = []; let cursor: string | undefined;
  do { const r = await rpc(key, url, headers, "tools/list", cursor ? { cursor } : {}); out.push(...(r.tools ?? []).filter((t: any) => typeof t?.name === "string")); cursor = r.nextCursor; } while (cursor && out.length < 300);
  return out;
}
export async function callTool(key: string, url: string, headers: Record<string, string>, name: string, args: any) {
  const r = await rpc(key, url, headers, "tools/call", { name, arguments: args ?? {} });
  const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "resource" ? c.resource?.text ?? "" : `[${c.type}]`)).join("\n");
  return { isError: !!r.isError, text, structured: r.structuredContent ?? null };
}

/** Save a device (MCP server) for a person: lists its tools once and keeps them in config. */
export async function addMcpConnection(userId: string, label: string, url: string, token: string) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const tools = await listTools(`probe:${url}`, url, headers);
  const cid = id("con");
  await sql`insert into connections (id, user_id, provider, label, account, cred_enc, config, status, created_at) values (${cid}, ${userId}, 'mcp', ${label}, ${new URL(url).host}, ${seal({ headers })}, ${JSON.stringify({ url, tools })}::text::jsonb, 'active', ${now()})`;
  return { id: cid, tools: tools.length };
}

/** The person's MCP tools as gateway tools: mcp.<connection id>.<tool>. Reads unless the server marks a tool destructive.
 *  ponytail: iphone-use taps are not "writes" needing a yes each; the device has its own blocked-apps and action caps. */
export async function mcpToolsFor(userId: string): Promise<ToolDef[]> {
  const conns = await sql`select * from connections where user_id=${userId} and provider='mcp' and status='active'`;
  return conns.flatMap((c: any) => (J(c.config, {}).tools ?? []).map((t: McpTool): ToolDef => ({
    id: `mcp.${c.id}.${t.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}`,
    description: `[${c.label}] ${t.description ?? t.name}`.slice(0, 1000),
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    kind: t.annotations?.destructiveHint ? "write" : "read", connection: "mcp",
    summarize: (i) => `${t.name} on ${c.label}: ${JSON.stringify(i).slice(0, 80)}`,
    verify: (o) => (o && !o.isError ? `${c.label}:${t.name}` : null),
    async execute(input, ctx) {
      const cfg = J(ctx.connection.config, {}), headers = unseal<any>(ctx.connection.cred_enc)?.headers ?? {};
      const r = await callTool(ctx.connection.id, cfg.url, headers, t.name, input).catch((e: any) => { throw new ToolError(e.auth ? "AUTH" : "TRANSIENT", e.message); });
      return { status: r.isError ? "FAILED" : "SUCCEEDED", untrusted: true, output: { text: r.text.slice(0, 20_000), structured: r.structured, isError: r.isError } };
    },
  })));
}
