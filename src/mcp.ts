// Minimal MCP client (Streamable HTTP transport): initialize -> tools/list -> tools/call.
// Lets any MCP server (Browser Use, Browserbase, Playwright, a company's internal tools) become agent tools,
// still behind the Tool Gateway's policy, approvals and audit.
import { one, J } from "./db";

const PROTOCOL = "2025-06-18";
const sessions = new Map<string, string>(); // connection id -> Mcp-Session-Id
let seq = 1;

async function post(url: string, headers: Record<string, string>, body: any, session?: string) {
  const r = await fetch(url, {
    method: "POST", signal: AbortSignal.timeout(Number(process.env.MCP_TIMEOUT_MS ?? 120000)),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...headers, ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(body),
  });
  return r;
}

/** Read a JSON-RPC response that may arrive as JSON or as an SSE stream. */
async function readResponse(r: Response, id: number) {
  const ct = r.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    for (const line of (await r.text()).split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try { const m = JSON.parse(line.slice(5).trim()); if (m.id === id) return m; } catch {}
    }
    throw new Error("MCP stream ended without a response");
  }
  return r.json();
}

async function rpc(key: string, url: string, headers: Record<string, string>, method: string, params: any, retry = true): Promise<any> {
  if (!sessions.has(key)) {
    const id = seq++;
    const r = await post(url, headers, { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "agent-platform", version: "1.0" } } });
    if (!r.ok) throw new Error(`MCP initialize failed (${r.status})`);
    const m = await readResponse(r, id);
    if (m.error) throw new Error(`MCP initialize: ${m.error.message}`);
    sessions.set(key, r.headers.get("mcp-session-id") ?? "");
    await post(url, headers, { jsonrpc: "2.0", method: "notifications/initialized" }, sessions.get(key) || undefined).catch(() => {});
  }
  const id = seq++;
  const r = await post(url, headers, { jsonrpc: "2.0", id, method, params }, sessions.get(key) || undefined);
  if ((r.status === 404 || r.status === 400) && retry) { sessions.delete(key); return rpc(key, url, headers, method, params, false); } // session expired
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("MCP server rejected the credentials"), { auth: true });
  if (!r.ok) throw new Error(`MCP ${method} failed (${r.status})`);
  const m = await readResponse(r, id);
  if (m.error) throw new Error(`MCP ${method}: ${m.error.message}`);
  return m.result;
}

export interface McpTool { name: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } }

export async function listTools(key: string, url: string, headers: Record<string, string>): Promise<McpTool[]> {
  const out: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const r = await rpc(key, url, headers, "tools/list", cursor ? { cursor } : {});
    out.push(...(r.tools ?? []));
    cursor = r.nextCursor;
  } while (cursor && out.length < 500);
  return out;
}

export async function callTool(key: string, url: string, headers: Record<string, string>, name: string, args: any) {
  const r = await rpc(key, url, headers, "tools/call", { name, arguments: args ?? {} });
  const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "resource" ? c.resource?.text ?? "" : `[${c.type}]`)).join("\n");
  return { isError: !!r.isError, text, structured: r.structuredContent ?? null };
}

/** "Authorization: Bearer x" lines or a JSON object -> header map. */
export function parseHeaders(input: string | Record<string, string> | undefined): Record<string, string> {
  if (!input) return {};
  if (typeof input === "object") return input;
  try { return JSON.parse(input); } catch {}
  return Object.fromEntries(input.split(/\n/).map((l) => l.split(/:\s*/)).filter((p) => p.length >= 2 && p[0].trim()).map(([k, ...v]) => [k.trim(), v.join(":").trim()]));
}

/** Tool ids look like mcp.<6 chars of connection id>.<tool name>; Anthropic tool names allow [a-zA-Z0-9_-]. */
export const mcpToolId = (connId: string, name: string) => `mcp.${connId.slice(4, 10)}.${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}`;
export function connectionForToolId(toolId: string) {
  const short = toolId.split(".")[1];
  return one<any>("select * from connections where provider='mcp' and substr(id, 5, 6)=? and status!='revoked'", short);
}
export const toolsOf = (conn: any): McpTool[] => J(conn.config, {})?.tools ?? [];
