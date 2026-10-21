import { askFirst, obj, s, str, type ToolContext, type ToolDef } from "../kit.ts";
import { clip, notConnected } from "./shared.ts";

/**
 * Fo's universal adapters: `mcp_call` reaches any MCP server a person connected, `connector_call`
 * any HTTP API described by an OpenAPI document. Both are stored per person in the vault as
 * `mcp:<name>` and `api:<name>` (URL plus token), so the model sees names only.
 */
export interface McpServerRecord {
  url: string;
  token?: string;
}
export interface ApiRecord {
  baseUrl: string;
  openapiUrl?: string;
  token?: string;
  /** Header name for the token; default Authorization: Bearer. */
  header?: string;
}

const service = (kind: "mcp" | "api", name: string) =>
  `${kind}:${name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")}`;
const listOf = (ctx: ToolContext, kind: "mcp" | "api") =>
  ctx.vault
    .services()
    .filter((x) => x.startsWith(`${kind}:`))
    .map((x) => x.slice(kind.length + 1));

/** Minimal MCP client over streamable HTTP (JSON-RPC). One session per call. No stdio: a command a member could register would run on this box. */
export class McpClient {
  private seq = 1;
  constructor(private rec: McpServerRecord) {}

  private async rpc(method: string, params: unknown, sessionId?: string): Promise<{ result?: unknown; error?: { message: string }; sessionId?: string }> {
    const body = { jsonrpc: "2.0", id: this.seq++, method, params };
    const res = await fetch(this.rec.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.rec.token ? { authorization: `Bearer ${this.rec.token}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`MCP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const sid = res.headers.get("mcp-session-id") ?? sessionId;
    const text = await res.text();
    // Streamable HTTP may answer as SSE; take the last data: line that parses.
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    const payload = lines.length
      ? lines
          .map((l) => l.slice(5).trim())
          .filter(Boolean)
          .at(-1)!
      : text;
    const parsed = JSON.parse(payload) as { result?: unknown; error?: { message: string } };
    return { ...parsed, sessionId: sid ?? undefined };
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    const init = await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "circle", version: "0.1" } });
    if (init.error) throw new Error(init.error.message);
    const r = await this.rpc("tools/list", {}, init.sessionId);
    if (r.error) throw new Error(r.error.message);
    return ((r.result as { tools?: { name: string; description?: string; inputSchema?: unknown }[] })?.tools ?? []).slice(0, 200);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const init = await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "circle", version: "0.1" } });
    if (init.error) throw new Error(init.error.message);
    const r = await this.rpc("tools/call", { name, arguments: args }, init.sessionId);
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }
}

/** A connector: an OpenAPI document indexed by operationId, called with a bearer token. */
interface Op {
  id: string;
  method: string;
  path: string;
  summary?: string;
  params?: string[];
}

export class OpenApiConnector {
  private ops?: Op[];
  constructor(private rec: ApiRecord) {}

  async operations() {
    if (this.ops) return this.ops;
    if (!this.rec.openapiUrl) {
      this.ops = [];
      return this.ops;
    }
    const res = await fetch(this.rec.openapiUrl, { headers: { accept: "application/json, text/plain" } });
    if (!res.ok) throw new Error(`OpenAPI ${res.status}`);
    const text = await res.text();
    const doc = JSON.parse(text) as { paths?: Record<string, Record<string, { operationId?: string; summary?: string; parameters?: { name: string }[] }>> };
    const ops: Op[] = [];
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        ops.push({ id: op.operationId ?? `${method}:${path}`, method: method.toUpperCase(), path, summary: op.summary, params: op.parameters?.map((p) => p.name) });
      }
    }
    this.ops = ops.slice(0, 500);
    return this.ops;
  }

  /** The method and path a call would use, resolved from the document when an operationId is given. */
  async resolve(input: { operationId?: string; method?: string; path?: string }): Promise<{ method: string; path: string }> {
    if (input.operationId) {
      const op = (await this.operations()).find((o) => o.id === input.operationId);
      if (!op) throw new Error(`no operation ${input.operationId}`);
      return { method: op.method, path: op.path };
    }
    const method = input.method?.toUpperCase();
    if (!method || !input.path) throw new Error("give operationId, or method and path");
    return { method, path: input.path };
  }

  async call(input: { operationId?: string; method?: string; path?: string; params?: Record<string, unknown>; body?: unknown }): Promise<unknown> {
    const { method, path: rawPath } = await this.resolve(input);
    let path = rawPath;
    const params = { ...(input.params ?? {}) } as Record<string, unknown>;
    path = path.replace(/\{(\w+)\}/g, (_m, k: string) => {
      const v = params[k];
      delete params[k];
      return encodeURIComponent(String(v ?? ""));
    });
    // Records are written only by the connections route, which checks the hosts are public.
    const base = new URL(this.rec.baseUrl);
    const url = new URL(path.replace(/^\//, ""), base.href.endsWith("/") ? base.href : `${base.href}/`);
    // The token goes to the API it was issued for, never to a host a path or document names.
    if (url.origin !== base.origin) throw new Error(`path leaves ${base.origin}`);
    if (method === "GET") for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (this.rec.token) headers[this.rec.header || "authorization"] = this.rec.header ? this.rec.token : `Bearer ${this.rec.token}`;
    const res = await fetch(url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(input.body ?? (Object.keys(params).length ? params : undefined)) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 20_000);
    }
  }
}

export const MCP_TOOLS: ToolDef[] = [
  {
    spec: {
      name: "mcp_call",
      description:
        "Call a tool on an MCP server the person connected in Settings (any app with an MCP endpoint: Linear, Notion, HubSpot, a device, a home-made server). Without `tool`, lists the server's tools. Without `server`, lists connected servers.",
      input_schema: obj({ server: str("Connected server name."), tool: str("Tool name on that server."), args: { type: "object", description: "Arguments for the tool." } }),
    },
    family: "mcp",
    labels: { running: "Calling MCP tools…", done: "Used MCP tools" },
    sideEffect: true,
    async run(input, ctx) {
      const servers = listOf(ctx, "mcp");
      if (!s(input.server)) return { ok: true, content: servers.length ? { servers } : "No MCP servers connected. Settings → Connections → Add MCP." };
      const key = service("mcp", s(input.server));
      if (!ctx.vault.has(key)) return notConnected(ctx, `MCP server "${s(input.server)}"`);
      // The record (URL and token) lives only inside this callback; the model sees names and results.
      const out = await ctx.vault.use(key, async (raw) => {
        const client = new McpClient(JSON.parse(raw) as McpServerRecord);
        try {
          if (!s(input.tool))
            return {
              ok: true,
              content: (await client.listTools()).map((t) => ({ name: t.name, description: clip(t.description ?? "", 300), inputSchema: t.inputSchema })),
              evidence: `mcp:${s(input.server)}:list`,
            };
          // A write on someone else's connection asks them; the person's own connection is theirs to use.
          if (ctx.requesterId !== ctx.accountOwnerId) {
            const gate = ctx.gate({
              kind: "action",
              title: `OK to use ${s(input.server)}: ${s(input.tool)}?`,
              detail: clip(JSON.stringify(input.args ?? {}), 600),
              key: ["mcp_call", s(input.server), s(input.tool), input.args],
            });
            const held = askFirst(gate, "Asked the connection's owner first.");
            if (held) return held;
          }
          const r = await client.callTool(s(input.tool), (input.args && typeof input.args === "object" ? input.args : {}) as Record<string, unknown>);
          const content = (r as { content?: { type: string; text?: string }[] })?.content;
          const text = Array.isArray(content) ? content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n") : JSON.stringify(r);
          return {
            ok: true,
            content: clip(text, 12_000),
            evidence: `mcp:${s(input.server)}:${s(input.tool)}`,
            label: `${s(input.server)} · ${s(input.tool).replace(/[_-]+/g, " ")}`,
          };
        } catch (e) {
          return { ok: false, content: `${s(input.server)} said: ${String((e as Error).message).slice(0, 300)}` };
        }
      });
      return out ?? notConnected(ctx, `MCP server "${s(input.server)}"`);
    },
  },
  {
    spec: {
      name: "connector_call",
      description:
        "Call an HTTP API the person connected in Settings (name, base URL, optional OpenAPI document, token). Without `operationId` or `path`, lists the API's operations. Without `connector`, lists connected APIs.",
      input_schema: obj({
        connector: str("Connected API name."),
        operationId: str("Operation from the OpenAPI document."),
        method: str("HTTP method when there is no OpenAPI document."),
        path: str("Path when there is no OpenAPI document."),
        params: { type: "object", description: "Path and query parameters." },
        body: { type: "object", description: "JSON body for writes." },
      }),
    },
    family: "mcp",
    labels: { running: "Calling an API…", done: "Called an API" },
    sideEffect: true,
    async run(input, ctx) {
      const apis = listOf(ctx, "api");
      if (!s(input.connector)) return { ok: true, content: apis.length ? { connectors: apis } : "No APIs connected. Settings → Connections → Add API." };
      const key = service("api", s(input.connector));
      if (!ctx.vault.has(key)) return notConnected(ctx, `API "${s(input.connector)}"`);
      const out = await ctx.vault.use(key, async (raw) => {
        const api = new OpenApiConnector(JSON.parse(raw) as ApiRecord);
        try {
          if (!s(input.operationId) && !s(input.path)) return { ok: true, content: (await api.operations()).slice(0, 100), evidence: `api:${s(input.connector)}:ops` };
          // Gate on what will actually be sent: an operationId's method comes from the document, not the model.
          const { method, path } = await api.resolve({ operationId: s(input.operationId) || undefined, method: s(input.method) || undefined, path: s(input.path) || undefined });
          if (ctx.requesterId !== ctx.accountOwnerId && method !== "GET") {
            const gate = ctx.gate({
              kind: "action",
              title: `OK to call ${s(input.connector)}?`,
              detail: clip(`${method} ${path} ${JSON.stringify(input.body ?? input.params ?? {})}`, 600),
              key: ["connector_call", s(input.connector), method, path, input.params, input.body],
            });
            const held = askFirst(gate, "Asked the connection's owner first.");
            if (held) return held;
          }
          const r = await api.call({
            operationId: s(input.operationId) || undefined,
            method: s(input.method) || undefined,
            path: s(input.path) || undefined,
            params: (input.params ?? {}) as Record<string, unknown>,
            body: input.body,
          });
          return {
            ok: true,
            content: typeof r === "string" ? r : clip(JSON.stringify(r), 12_000),
            evidence: `api:${s(input.connector)}:${s(input.operationId) || s(input.path)}`,
            label: `${s(input.connector)} · ${(s(input.operationId) || s(input.path)).replace(/[_-]+/g, " ").slice(0, 40)}`,
          };
        } catch (e) {
          return { ok: false, content: `${s(input.connector)} said: ${String((e as Error).message).slice(0, 300)}` };
        }
      });
      return out ?? notConnected(ctx, `API "${s(input.connector)}"`);
    },
  },
];
