// Tool contract + Tool Gateway (plan §10). Every call: schema validation -> policy -> approval -> credential resolution -> idempotent execute -> audit.
import { all, one, exec, emit, id, now, S, J, sha, seal, unseal, recordUsage, tzOf, setTz, zoned, fromZoned, fmtLocal } from "./db";
import { evaluatePolicy, type Risk } from "./policy";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as rt from "./runtime";
import { bb, withLoginLock, loginProbe } from "./browser";

export type ErrKind = "TRANSIENT" | "AUTH" | "RATE_LIMIT" | "BUSINESS_RULE" | "PERMISSION" | "UNKNOWN_SIDE_EFFECT";
export class ToolError extends Error { constructor(public kind: ErrKind, msg: string, public retryAfterMs = 0) { super(msg); } }

export interface ToolCtx { run: any; agent: any; room: any; connection?: { id: string; cred: any; account: string }; idempotencyKey: string; siteLogin?: { username: string; password: string; site: string }
  browserLogin?: BrowserLogin }
/** A website login the user made in a live Browserbase session: only a Context id, no secrets. */
export interface BrowserLogin { id: string; site: string; context_id: string; config: any }
export interface ToolOutcome { status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "PARTIAL"; output: any; untrusted?: boolean; wait?: { kind: string; reason: string; wake_key?: string; owner?: string; timeout_at?: number } }
export interface ToolDef {
  id: string; description: string; inputSchema: any; risk: Risk;
  idempotency: "safe" | "key_required" | "unsafe"; requiresConnection?: string; defaultApproval: "none" | "first_time" | "always";
  connectionId?: string;                              // MCP tools: bound to one specific connection
  riskOf?: (input: any) => Risk;                      // input-dependent risk (e.g. a booking with a deposit is financial)
  siteLogin?: (input: any) => string | undefined;     // which website login (host) this call would use
  siteLoginRequired?: boolean;
  preApproved?: (input: any, run: any) => string | null; // id of a standing approval whose limits cover this exact call
  testSimulate?: boolean;                             // internal write that must not leave real state behind in test mode
  normalize?: (input: any, ctx: { run: any; agent: any; room: any }) => any; // resolve references ("latest") in the caller's scope
  summarize?: (input: any) => string; // human-readable approval card line
  execute: (input: any, ctx: ToolCtx) => Promise<ToolOutcome>;
}

const obj = (props: Record<string, any>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description?: string) => ({ type: "string", description });
const num = (description?: string) => ({ type: "number", description });

// ---------- outbound HTTP with retry taxonomy ----------
async function call(url: string, init: RequestInit & { write?: boolean; timeoutMs?: number } = {}) {
  let r: Response;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20000) }); }
  catch (e: any) { throw new ToolError(init.write ? "UNKNOWN_SIDE_EFFECT" : "TRANSIENT", `network error: ${e.message}`); }
  if (r.status === 401 || r.status === 403) throw new ToolError("AUTH", `provider rejected credentials (${r.status})`);
  if (r.status === 429) throw new ToolError("RATE_LIMIT", "rate limited", Number(r.headers.get("retry-after") ?? 30) * 1000);
  if (r.status === 502 || r.status === 503) throw new ToolError("TRANSIENT", `provider unavailable (${r.status})`, 5000);
  if (r.status >= 500) throw new ToolError(init.write ? "UNKNOWN_SIDE_EFFECT" : "TRANSIENT", `provider error ${r.status}`, 5000);
  if (!r.ok && !(r.status >= 300 && r.status < 400)) throw new ToolError("BUSINESS_RULE", `provider returned ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}

const BROWSER_TIMEOUT = () => Number(process.env.BROWSER_TASK_TIMEOUT_MS ?? 300_000); // real bookings take minutes, not 20s
const refreshing = new Map<string, Promise<void>>();
/** Google access token with refresh. One refresh per connection at a time (concurrent runs would race and, with rotating refresh
 *  tokens, invalidate each other); a failed refresh marks the connection needs_reauth via the AUTH error path.
 *  ponytail: direct Google OAuth, in-process lock; put Nango in front when there are >5 providers. */
async function googleToken(ctx: ToolCtx) {
  const c = ctx.connection!;
  if (refreshing.has(c.id)) { await refreshing.get(c.id)!.catch(() => {}); c.cred = unseal(one<any>("select cred_enc from connections where id=?", c.id)?.cred_enc) ?? c.cred; }
  if (c.cred.expires_at && c.cred.expires_at < now() + 60000 && c.cred.refresh_token) {
    const p = refreshGoogle(c); refreshing.set(c.id, p);
    try { await p; } finally { refreshing.delete(c.id); }
  }
  return { authorization: `Bearer ${c.cred.access_token}`, "content-type": "application/json" };
}
async function refreshGoogle(c: any) {
  {
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: c.cred.refresh_token, grant_type: "refresh_token" }) });
    if (!r.ok) throw new ToolError("AUTH", "token refresh failed");
    const t: any = await r.json();
    c.cred = { ...c.cred, access_token: t.access_token, refresh_token: t.refresh_token ?? c.cred.refresh_token, expires_at: now() + t.expires_in * 1000 }; // keep the old refresh token if none came back
    exec("update connections set cred_enc=? where id=?", seal(c.cred), c.id);
  }
}

export const resolver = { lookup: (host: string) => dnsLookup(host, { all: true }) as Promise<{ address: string }[]> };
function isPrivateIp(ip: string) {
  const v4 = ip.replace(/^::ffff:/i, "").match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) { const [a, b] = [Number(v4[1]), Number(v4[2])]; return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || a >= 224; }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("::ffff:");
}
/** Public http(s) only: checks the literal host and every address it resolves to. */
export async function assertPublicUrl(raw: string) {
  let u: URL; try { u = new URL(raw); } catch { throw new ToolError("BUSINESS_RULE", "invalid URL"); }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!/^https?:$/.test(u.protocol) || /^(localhost|.*\.(internal|local|localhost))$/i.test(host)) throw new ToolError("PERMISSION", "only public http(s) URLs are allowed");
  const addrs = isIP(host) ? [{ address: host }] : await resolver.lookup(host).catch(() => { throw new ToolError("BUSINESS_RULE", `can't resolve ${host}`); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new ToolError("PERMISSION", "only public http(s) URLs are allowed");
  return u;
}
// ponytail: resolve-then-fetch leaves a DNS-rebinding window; pin the resolved IP via a custom agent if that matters.
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return undefined; } };

/** Browser runner seam, in order: an MCP browser server granted to the agent (Browser Use, Browserbase...), then an HTTP
 * runner (BROWSER_TASK_URL: {task, start_url, secrets} -> {status, output}). Site logins go only to the HTTP runner, which
 * substitutes {{username}}/{{password}} itself; MCP browser servers should use a saved browser profile instead.
 * A live-browser login (browser_login) instead runs on its Browserbase Context and never sends secrets. */
export async function runBrowser(task: string, start_url: string | undefined, ctx: ToolCtx): Promise<any | null> {
  if (ctx.browserLogin) return runOnLogin(task, start_url, ctx, ctx.browserLogin);
  const m = browserMcp(ctx.agent.id);
  if (m) {
    const { callTool, parseHeaders } = await import("./mcp");
    const r = await callTool(m.conn.id, J(m.conn.config).url, parseHeaders(unseal<any>(m.conn.cred_enc)?.headers), m.tool, { task: start_url ? `${task}\nStart at ${start_url}` : task })
      .catch((e: any) => { throw new ToolError(e.auth ? "AUTH" : "UNKNOWN_SIDE_EFFECT", e.message); });
    let parsed: any = null; try { parsed = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? ""); } catch {}
    return { status: r.isError ? "failed" : "succeeded", output: parsed ?? r.text.slice(0, 20000), via: m.conn.label };
  }
  if (!process.env.BROWSER_TASK_URL && process.env.BROWSERBASE_API_KEY) { // built-in runner (src/browser-agent.ts)
    const { runBrowserTask } = await import("./browser-agent");
    recordUsage({ workspace_id: ctx.run.workspace_id, agent_id: ctx.agent.id, run_id: ctx.run.id, kind: "browser_tasks", qty: 1 });
    const site = ctx.siteLogin?.site;
    const r = await runBrowserTask({ task, startUrl: start_url ?? (site ? `https://${site}` : undefined), workspaceId: ctx.run.workspace_id, agentId: ctx.agent.id, runId: ctx.run.id,
      allowedDomains: site ? [site] : undefined, secrets: ctx.siteLogin ? { username: ctx.siteLogin.username, password: ctx.siteLogin.password } : undefined, deadlineMs: BROWSER_TIMEOUT() - 20_000 });
    return { ...r, output: r.result };
  }
  if (process.env.BROWSER_TASK_URL) {
    const r = await call(process.env.BROWSER_TASK_URL, { method: "POST", write: true, timeoutMs: BROWSER_TIMEOUT(), headers: { "content-type": "application/json", "idempotency-key": ctx.idempotencyKey,
      authorization: `Bearer ${process.env.BROWSER_TASK_KEY ?? ""}` }, body: S({ task, start_url, secrets: ctx.siteLogin ? { username: ctx.siteLogin.username, password: ctx.siteLogin.password } : undefined,
        allowed_domains: ctx.siteLogin ? [ctx.siteLogin.site] : undefined }) });
    return r.json();
  }
  return null;
}

/** Runs a browser task signed in as the user via their Browserbase Context: one session per login at a time, a logged-out
 * pre-flight, and a recorded replay. Runners get the Context (HTTP: `browserbase: {context_id, session_id}`; MCP: `contextId`). */
async function runOnLogin(task: string, start_url: string | undefined, ctx: ToolCtx, login: BrowserLogin) {
  const m = browserMcp(ctx.agent.id), mcpProps = m && (J(m.conn.config, {}).tools ?? []).find((t: any) => t.name === m.tool)?.inputSchema?.properties;
  const useMcp = !!mcpProps?.contextId, http = process.env.BROWSER_TASK_URL;
  if (!useMcp && !process.env.BROWSERBASE_API_KEY) throw new ToolError("BUSINESS_RULE", "Browserbase isn't set up on this server (BROWSERBASE_API_KEY)");
  const record = (session_id: string | null, status: string) => {
    const bid = id("bbs");
    exec("insert into browser_sessions (id, connection_id, workspace_id, purpose, session_id, status, replay_url, run_id, created_at) values (?,?,?,?,?,?,?,?,?)",
      bid, login.id, ctx.run.workspace_id, "task", session_id, status, session_id ? bb.replayUrl(session_id) : null, ctx.run.id, now());
    return (s: string) => exec("update browser_sessions set status=?, ended_at=? where id=?", s, now(), bid);
  };
  return withLoginLock(login.id, async () => {
    if (useMcp) {
      // The MCP server opens its own session on the Context. ponytail: no pre-flight here — a free-text agent reply can't be matched reliably.
      const end = record(null, "running");
      const { callTool, parseHeaders } = await import("./mcp");
      const r = await callTool(m!.conn.id, J(m!.conn.config).url, parseHeaders(unseal<any>(m!.conn.cred_enc)?.headers), m!.tool,
        { task: start_url ? `${task}\nStart at ${start_url}` : task, contextId: login.context_id, ...(mcpProps.persist ? { persist: true } : {}) })
        .catch((e: any) => { end("failed"); throw new ToolError(e.auth ? "AUTH" : "UNKNOWN_SIDE_EFFECT", e.message); });
      end(r.isError ? "failed" : "completed");
      let parsed: any = null; try { parsed = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? ""); } catch {}
      return { status: r.isError ? "failed" : "succeeded", output: parsed ?? r.text.slice(0, 20000), via: m!.conn.label };
    }
    const probe = loginProbe(login.site, login.config);
    // keepAlive only when an HTTP runner's probe and task use separate connections; otherwise the session ends on disconnect.
    const session_id = await bb.createSession({ contextId: login.context_id, persist: true, keepAlive: !!probe && !!http, timeoutSec: 900 })
      .catch((e: any) => { throw new ToolError("BUSINESS_RULE", `couldn't start a browser session: ${e.message}`); });
    const replay_url = bb.replayUrl(session_id), end = record(session_id, "running"), browserbase = { context_id: login.context_id, session_id };
    // Built-in runner unless an HTTP runner is configured: same probe → task flow, on this session.
    // (The built-in runner does the logged-out pre-flight on the task's own connection: sessions without keepAlive end on disconnect.)
    const builtin = async (body: any) => {
      const { runBrowserTask } = await import("./browser-agent");
      const r = await runBrowserTask({ task: body.task, startUrl: body.start_url ?? `https://${login.site}`, sessionId: session_id, allowedDomains: [login.site], probe: probe ?? undefined,
        workspaceId: ctx.run.workspace_id, agentId: ctx.agent.id, runId: ctx.run.id, deadlineMs: BROWSER_TIMEOUT() - 20_000 });
      return { ...r, output: r.result };
    };
    const runner = async (body: any, key: string, write: boolean) => !http ? builtin(body) : (await call(http!, { method: "POST", write, timeoutMs: BROWSER_TIMEOUT(), headers: { "content-type": "application/json", "idempotency-key": key,
      authorization: `Bearer ${process.env.BROWSER_TASK_KEY ?? ""}` }, body: S({ ...body, allowed_domains: [login.site], browserbase }) })).json();
    let status = "failed";
    try {
      const expired = () => {
        status = "logged_out";
        exec("update connections set status='needs_reauth' where id=?", login.id);
        emit("CONNECTION_NEEDS_REAUTH", { workspace_id: ctx.run.workspace_id, room_id: ctx.run.room_id, run_id: ctx.run.id, data: { connection_id: login.id, site: login.site, replay_url } });
        return new ToolError("BUSINESS_RULE", `the ${login.site} login has expired. The owner needs to reconnect it (Connections → ${login.site} → Reconnect); the task was not run. Replay: ${replay_url}`);
      };
      if (probe && http) { // pre-flight: the runner opens probe.url and reports where it landed ({url, title}); we never attempt a login
        const p: any = await runner({ probe: { url: probe.url } }, `${ctx.idempotencyKey}:probe`, false);
        if (probe.pattern.test(`${p?.url ?? p?.output?.url ?? ""} ${p?.title ?? p?.output?.title ?? ""}`)) throw expired();
      }
      const j: any = await runner({ task, start_url }, ctx.idempotencyKey, true);
      if (j?.status === "logged_out") throw expired(); // built-in runner: same check, on the task's own connection
      status = j?.status === "succeeded" ? "completed" : j?.status ?? "unknown";
      return { ...j, replay_url };
    } catch (e: any) {
      if (e instanceof ToolError && !e.message.includes(replay_url)) e.message += ` (replay: ${replay_url})`;
      throw e;
    } finally {
      await bb.releaseSession(session_id).catch(() => {}); // persists the Context; a lost release ends at the session timeout
      end(status);
    }
  });
}
/** An MCP connection granted to this agent whose tool takes a natural-language `task` (how browser agents expose themselves). */
export function browserMcp(agentId: string): { conn: any; tool: string } | null {
  for (const c of all<any>("select c.* from connections c join connection_grants g on g.connection_id=c.id where g.agent_id=? and c.provider='mcp' and c.status='active'", agentId)) {
    const t = (J(c.config, {}).tools ?? []).find((x: any) => x.inputSchema?.properties?.task && /browser|task|web/i.test(`${x.name} ${x.description ?? ""} ${c.label}`));
    if (t) return { conn: c, tool: t.name };
  }
  return null;
}

/** Static tools plus MCP tools discovered from connected servers. */
export function getTool(id: string): ToolDef | undefined {
  if (TOOLS[id]) return TOOLS[id];
  if (!id.startsWith("mcp.")) return undefined;
  const conn = one<any>("select * from connections where provider='mcp' and substr(id, 5, 6)=? and status!='revoked'", id.split(".")[1]);
  const cfg = J(conn?.config, {});
  const t = (cfg.tools ?? []).find((x: any) => `mcp.${conn.id.slice(4, 10)}.${x.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}` === id);
  if (!t) return undefined;
  const risk: Risk = t.annotations?.readOnlyHint ? "read" : t.annotations?.destructiveHint ? "destructive" : "write_external";
  const schema = t.inputSchema?.type === "object" ? t.inputSchema : { type: "object", properties: {} };
  return {
    id, description: `[${conn.label}] ${t.description ?? t.name}`.slice(0, 1000), inputSchema: schema, risk, idempotency: "unsafe", requiresConnection: "mcp", connectionId: conn.id,
    defaultApproval: risk === "read" ? "none" : risk === "destructive" ? "always" : "first_time",
    summarize: (i) => `${conn.label} → ${t.annotations?.title ?? t.name} ${JSON.stringify(i).slice(0, 100)}`,
    async execute(input) {
      const { callTool, parseHeaders } = await import("./mcp");
      const r = await callTool(conn.id, cfg.url, parseHeaders(unseal<any>(conn.cred_enc)?.headers), t.name, input)
        .catch((e: any) => { throw new ToolError(e.auth ? "AUTH" : risk === "read" ? "TRANSIENT" : "UNKNOWN_SIDE_EFFECT", e.message); });
      if (r.isError) throw new ToolError("BUSINESS_RULE", r.text.slice(0, 500) || "the MCP tool reported an error");
      return { status: "SUCCEEDED", untrusted: true, output: { text: r.text.slice(0, 20000), structured: r.structured } };
    },
  };
}

const ENT: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const stripHtml = (h: string) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ")
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)
  .replace(/\s+/g, " ").trim();
const b64url = (s: string) => Buffer.from(s).toString("base64url");

export const TOOLS: Record<string, ToolDef> = {};
const def = (d: ToolDef) => { TOOLS[d.id] = d; };

def({
  id: "web.search", description: "Search the web. Returns titles, URLs and snippets.", risk: "read", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ query: str("search query") }, ["query"]),
  async execute({ query }) {
    // First configured provider that answers wins: Exa (built for agents), Brave (independent index), Serper (Google's results),
    // Tavily; then keyless DuckDuckGo (no SLA, and it bot-checks automated traffic: set a key for real use). Each failure falls through, so one outage doesn't blind every agent.
    const tried: string[] = [];
    for (const [name, run] of SEARCH_PROVIDERS) {
      if (!run.enabled()) continue;
      try { const results = await run.search(query); if (results.length) return { status: "SUCCEEDED", untrusted: true, output: { results: results.slice(0, 6), via: name } }; tried.push(`${name}: no results`); }
      catch (e: any) { tried.push(`${name}: ${e.message?.slice(0, 80)}`); }
    }
    return { status: "SUCCEEDED", untrusted: true, output: { results: [], note: `no results (${tried.join("; ")})` } };
  },
});

type Hit = { title: string; url: string; snippet: string };
// DuckDuckGo starts returning nothing after a burst from one IP: pace requests and reuse recent answers.
const ddgCache = new Map<string, { at: number; hits: Hit[] }>();
let ddgNext = 0;
const ddg = async (url: string, re: RegExp) => {
  const pace = Number(process.env.DDG_PACE_MS ?? 1500); // tests set 0 (no pacing, no cache)
  const cached = pace ? ddgCache.get(url) : undefined;
  if (cached && Date.now() - cached.at < 10 * 6e4) return cached.hits;
  const wait = Math.max(0, ddgNext - Date.now()); ddgNext = Math.max(Date.now(), ddgNext) + pace;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const hits = await ddgFetch(url, re);
  if (hits.length && pace) ddgCache.set(url, { at: Date.now(), hits });
  return hits;
};
const ddgFetch = async (url: string, re: RegExp) => {
  const r = await call(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" } });
  const html = await r.text(), out: Hit[] = [];
  for (const m of html.matchAll(re)) {
    let u = m[1]; const x = u.match(/uddg=([^&]+)/); if (x) u = decodeURIComponent(x[1]);
    if (/^https?:/.test(u)) out.push({ title: stripHtml(m[2]), url: u, snippet: stripHtml(m[3] ?? "") });
  }
  return out;
};
const SEARCH_PROVIDERS: [string, { enabled: () => boolean; search: (q: string) => Promise<Hit[]> }][] = [
  ["exa", { enabled: () => !!process.env.EXA_API_KEY, search: async (q) => {
    const j: any = await (await call("https://api.exa.ai/search", { method: "POST", headers: { "x-api-key": process.env.EXA_API_KEY!, "content-type": "application/json" },
      body: S({ query: q, numResults: 6, contents: { text: { maxCharacters: 600 } } }) })).json();
    return (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.text })); } }],
  ["brave", { enabled: () => !!process.env.BRAVE_API_KEY, search: async (q) => {
    const j: any = await (await call(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6`, { headers: { "x-subscription-token": process.env.BRAVE_API_KEY!, accept: "application/json" } })).json();
    return (j.web?.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: stripHtml(x.description ?? "") })); } }],
  ["serper", { enabled: () => !!process.env.SERPER_API_KEY, search: async (q) => {
    const j: any = await (await call("https://google.serper.dev/search", { method: "POST", headers: { "x-api-key": process.env.SERPER_API_KEY!, "content-type": "application/json" }, body: S({ q, num: 6 }) })).json();
    return (j.organic ?? []).map((x: any) => ({ title: x.title, url: x.link, snippet: x.snippet ?? "" })); } }],
  ["tavily", { enabled: () => !!process.env.TAVILY_API_KEY, search: async (q) => {
    const j: any = await (await call("https://api.tavily.com/search", { method: "POST", headers: { authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "content-type": "application/json" }, body: S({ query: q, max_results: 6 }) })).json();
    return (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? "" })); } }],
  ["duckduckgo", { enabled: () => true, search: (q) => ddg(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g) }],
];

def({
  id: "web.fetch", description: "Fetch a public web page and return its readable text.", risk: "read", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ url: str() }, ["url"]),
  async execute({ url }) {
    let u = await assertPublicUrl(url), r: Response | undefined;
    for (let hop = 0; hop < 5; hop++) { // follow redirects ourselves so every hop is re-checked
      r = await call(u.toString(), { headers: { "user-agent": "Mozilla/5.0 agent-platform" }, redirect: "manual" });
      const loc = r.status >= 300 && r.status < 400 && r.headers.get("location");
      if (!loc) break;
      u = await assertPublicUrl(new URL(loc, u).toString());
    }
    if (!r || (r.status >= 300 && r.status < 400)) throw new ToolError("BUSINESS_RULE", "too many redirects");
    const text = stripHtml(await r!.text()).slice(0, 8000);
    return { status: "SUCCEEDED", untrusted: true, output: { url, text } };
  },
});

def({
  id: "browser.task", description: "Operate a website in a cloud browser for tasks that need interaction (forms, logins, bookings). If the user connected that site, the browser is already signed in, or (for a saved password) reference it as {{username}} / {{password}} and the platform fills them in; you never see them. Share the replay_url from the result when useful.",
  risk: "write_external", idempotency: "unsafe", defaultApproval: "first_time", inputSchema: obj({ task: str(), start_url: str(), site: str("e.g. resy.com") }, ["task"]),
  summarize: (i) => `Use a browser: ${i.task}`,
  siteLogin: (i) => i.site ?? (i.start_url ? hostOf(i.start_url) : undefined),
  async execute({ task, start_url }, ctx) {
    const j = await runBrowser(task, start_url, ctx);
    if (j) return { status: j.status === "succeeded" ? "SUCCEEDED" : ["partial", "needs_confirmation", "blocked"].includes(j.status) ? "PARTIAL" : j.status === "failed" ? "FAILED" : "UNKNOWN", untrusted: true, output: j };
    if (!start_url) throw new ToolError("BUSINESS_RULE", "browser runtime not configured; provide start_url for read-only mode");
    const out = await TOOLS["web.fetch"].execute({ url: start_url }, { ...ctx, siteLogin: undefined });
    return { ...out, status: "PARTIAL", output: { note: "read-only browser fallback", ...out.output } };
  },
});

def({
  id: "email.search", description: "Search the connected Gmail inbox (Gmail query syntax).", risk: "read", idempotency: "safe", defaultApproval: "none",
  requiresConnection: "google", inputSchema: obj({ query: str("e.g. is:unread newer_than:2d"), max: num() }, ["query"]),
  async execute({ query, max = 10 }, ctx) {
    const h = await googleToken(ctx);
    const list: any = await (await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`, { headers: h })).json();
    const messages = [];
    for (const m of list.messages ?? []) {
      const g: any = await (await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: h })).json();
      const hd = Object.fromEntries((g.payload?.headers ?? []).map((x: any) => [x.name.toLowerCase(), x.value]));
      messages.push({ id: m.id, threadId: g.threadId, from: hd.from, subject: hd.subject, date: hd.date, snippet: g.snippet });
    }
    return { status: "SUCCEEDED", untrusted: true, output: { messages } };
  },
});

def({
  id: "email.draft", description: "Draft an email for review. Does not send.", risk: "write_internal", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ to: { type: "array", items: str() }, subject: str(), body: str() }, ["to", "subject", "body"]),
  async execute(input, ctx) {
    emit("DRAFT_CREATED", { workspace_id: ctx.run.workspace_id, room_id: ctx.run.room_id, run_id: ctx.run.id, actor: ctx.agent.id, data: input });
    return { status: "SUCCEEDED", output: { drafted: true, ...input } };
  },
});

def({
  id: "email.send", description: "Send an email from the connected Gmail account.", risk: "write_external", idempotency: "key_required", defaultApproval: "always",
  requiresConnection: "google", inputSchema: obj({ to: { type: "array", items: str() }, subject: str(), body: str(), thread_id: str() }, ["to", "subject", "body"]),
  summarize: (i) => `Send email to ${i.to.join(", ")}: "${i.subject}"`,
  async execute({ to, subject, body, thread_id }, ctx) {
    if (to.some((a: string) => !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a))) throw new ToolError("BUSINESS_RULE", "invalid recipient address");
    subject = subject.replace(/[\r\n]+/g, " "); // no header injection (e.g. a smuggled Bcc:)
    const raw = b64url(`To: ${to.join(", ")}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
    const r: any = await (await call("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", write: true, headers: await googleToken(ctx), body: S({ raw, threadId: thread_id }) })).json();
    if (!r.id) return { status: "UNKNOWN", output: r };
    recordUsage({ workspace_id: ctx.run.workspace_id, agent_id: ctx.agent.id, run_id: ctx.run.id, kind: "emails_sent", qty: to.length });
    return { status: "SUCCEEDED", output: { id: r.id, to, subject, from: ctx.connection!.account } };
  },
});

def({
  id: "calendar.list_events", description: "List upcoming calendar events.", risk: "read", idempotency: "safe", defaultApproval: "none",
  requiresConnection: "google", inputSchema: obj({ days: num() }),
  async execute({ days = 7 }, ctx) {
    const qs = new URLSearchParams({ timeMin: new Date(now()).toISOString(), timeMax: new Date(now() + days * 864e5).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "25" });
    const j: any = await (await call(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${qs}`, { headers: await googleToken(ctx) })).json();
    return { status: "SUCCEEDED", untrusted: true, output: { events: (j.items ?? []).map((e: any) => ({ id: e.id, summary: e.summary, start: e.start?.dateTime ?? e.start?.date, attendees: e.attendees?.map((a: any) => a.email) })) } };
  },
});

def({
  id: "calendar.create_event", description: "Create a calendar event.", risk: "write_external", idempotency: "key_required", defaultApproval: "always",
  requiresConnection: "google", inputSchema: obj({ title: str(), start: str("ISO datetime"), start_in_hours: num(), duration_minutes: num(), attendees: { type: "array", items: str() } }, ["title"]),
  summarize: (i) => `Create event "${i.title}"${i.start ? ` at ${i.start}` : ""}`,
  async execute({ title, start, start_in_hours = 24, duration_minutes = 30, attendees = [] }, ctx) {
    const s = start ? new Date(start) : new Date(now() + start_in_hours * 36e5);
    const body = { summary: title, start: { dateTime: s.toISOString() }, end: { dateTime: new Date(+s + duration_minutes * 6e4).toISOString() },
      attendees: attendees.map((email: string) => ({ email })), id: ctx.idempotencyKey.replace(/[^a-v0-9]/g, "").slice(0, 32) }; // event id = idempotency key
    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", { method: "POST", headers: await googleToken(ctx), body: S(body) });
    if (r.status === 409) return { status: "SUCCEEDED", output: { id: body.id, title, deduped: true } }; // already created by an earlier attempt
    if (!r.ok) throw new ToolError(r.status === 401 ? "AUTH" : r.status >= 500 ? "UNKNOWN_SIDE_EFFECT" : "BUSINESS_RULE", `calendar ${r.status}`);
    const j: any = await r.json();
    return { status: "SUCCEEDED", output: { id: j.id, title, start: j.start?.dateTime, link: j.htmlLink } };
  },
});

def({
  id: "calendar.cancel_event", description: "Cancel (delete) a calendar event.", risk: "destructive", idempotency: "safe", defaultApproval: "always",
  requiresConnection: "google", inputSchema: obj({ event_id: str() }, ["event_id"]), summarize: (i) => `Cancel calendar event ${i.event_id}`,
  async execute({ event_id }, ctx) {
    await call(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(event_id)}`, { method: "DELETE", write: true, headers: await googleToken(ctx) });
    return { status: "SUCCEEDED", output: { cancelled: event_id } };
  },
});

/** Free slots between busy intervals, inside working hours, for a meeting of `minutes`. Pure, so it's unit-tested. */
export function freeSlots(busy: { start: number; end: number }[], from: number, to: number, minutes: number, workStart = 9, workEnd = 18, max = 5) {
  const out: { start: string; end: string }[] = [], step = 30 * 6e4, len = minutes * 6e4;
  const b = [...busy].sort((x, y) => x.start - y.start);
  for (let t = Math.ceil(from / step) * step; t + len <= to && out.length < max; t += step) {
    const d = new Date(t), h = d.getHours() + d.getMinutes() / 60, end = new Date(t + len), he = end.getHours() + end.getMinutes() / 60;
    if (d.getDay() === 0 || d.getDay() === 6 || h < workStart || he > workEnd || end.getDate() !== d.getDate()) continue;
    if (b.some((x) => x.start < t + len && x.end > t)) continue;
    out.push({ start: d.toISOString(), end: end.toISOString() });
    t += len - step; // don't offer overlapping slots
  }
  return out;
}

def({
  id: "calendar.find_free_time", description: "Find open meeting slots in working hours over the next days, optionally across attendees' calendars.", risk: "read", idempotency: "safe",
  defaultApproval: "none", requiresConnection: "google", inputSchema: obj({ days: num(), duration_minutes: num(), attendees: { type: "array", items: str() } }),
  async execute(i, ctx) {
    const days = Math.min(60, Math.max(1, Math.round(i.days ?? 5))), duration_minutes = Math.min(480, Math.max(5, Math.round(i.duration_minutes ?? 30)));
    const attendees: string[] = (i.attendees ?? []).slice(0, 20);
    const timeMin = new Date(now()).toISOString(), timeMax = new Date(now() + days * 864e5).toISOString();
    const j: any = await (await call("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", headers: await googleToken(ctx),
      body: S({ timeMin, timeMax, items: [{ id: "primary" }, ...attendees.map((id: string) => ({ id }))] }) })).json();
    const busy = Object.values(j.calendars ?? {}).flatMap((c: any) => (c.busy ?? []).map((x: any) => ({ start: Date.parse(x.start), end: Date.parse(x.end) })));
    return { status: "SUCCEEDED", output: { slots: freeSlots(busy, now(), now() + days * 864e5, duration_minutes), duration_minutes } };
  },
});

def({
  id: "contacts.search", description: "Look up people in the user's Google contacts by name or email.", risk: "read", idempotency: "safe", defaultApproval: "none",
  requiresConnection: "google", inputSchema: obj({ query: str() }, ["query"]),
  async execute({ query }, ctx) {
    const j: any = await (await call(`https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(query)}&readMask=names,emailAddresses,phoneNumbers&pageSize=5`, { headers: await googleToken(ctx) })).json();
    const people = (j.results ?? []).map((r: any) => ({ name: r.person?.names?.[0]?.displayName, emails: (r.person?.emailAddresses ?? []).map((e: any) => e.value), phones: (r.person?.phoneNumbers ?? []).map((p: any) => p.value) }));
    return { status: "SUCCEEDED", untrusted: true, output: { people } };
  },
});

def({
  id: "drive.search", description: "Search the user's Google Drive (Docs, Sheets, PDFs) by text.", risk: "read", idempotency: "safe", defaultApproval: "none",
  requiresConnection: "google", inputSchema: obj({ query: str() }, ["query"]),
  async execute({ query }, ctx) {
    const q = encodeURIComponent(`fullText contains '${String(query).replace(/['\\]/g, "")}' and trashed=false`);
    const j: any = await (await call(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=8&fields=files(id,name,mimeType,modifiedTime,webViewLink)`, { headers: await googleToken(ctx) })).json();
    return { status: "SUCCEEDED", untrusted: true, output: { files: j.files ?? [] } };
  },
});

def({
  id: "drive.read", description: "Read the text of a Drive file (Google Docs are exported as plain text).", risk: "read", idempotency: "safe", defaultApproval: "none",
  requiresConnection: "google", inputSchema: obj({ file_id: str() }, ["file_id"]),
  async execute({ file_id }, ctx) {
    const h = await googleToken(ctx), id = encodeURIComponent(file_id);
    const meta: any = await (await call(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,webViewLink`, { headers: h })).json();
    const url = meta.mimeType?.startsWith("application/vnd.google-apps.") ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain` : `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
    const text = (await (await call(url, { headers: h })).text()).slice(0, 20000);
    return { status: "SUCCEEDED", untrusted: true, output: { name: meta.name, link: meta.webViewLink, text } };
  },
});

def({
  id: "reminder.schedule", description: "Schedule a one-off reminder or a recurring wake-up for this room, in the requester's time zone. The agent wakes then with the text as its objective. One-off: in_minutes or at. Recurring: recurring (daily|weekdays|weekends|weekly) or days (e.g. [\"mon\",\"wed\",\"fri\"]) plus time \"HH:MM\"; or every_minutes for intervals (e.g. 180 = every 3 hours). Confirm the returned next time back to the person.",
  risk: "write_internal", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ text: str(), in_minutes: num(), at: str("ISO datetime, with offset if known"), recurring: { type: "string", enum: ["daily", "weekdays", "weekends", "weekly"] },
    days: { type: "array", items: { type: "string", enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] } }, time: str("HH:MM, 24h, local"), hour: num("hour of day (if no time)"), every_minutes: num("repeat interval, minimum 15") }, ["text"]),
  async execute(i, ctx) {
    const tz = tzOf(ctx.run.requested_by);
    const [hh, mm] = String(i.time ?? "").match(/^(\d{1,2}):(\d{2})$/)?.slice(1).map(Number) ?? [i.hour ?? 9, 0];
    const days = (i.days ?? []).map((d: string) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(String(d).slice(0, 3).toLowerCase())).filter((d: number) => d >= 0);
    const recurring = !!(i.recurring || days.length || i.every_minutes);
    // "at" without an offset is wall-clock time in the person's zone, not the server's.
    const at = i.at ? (/[zZ]|[+-]\d\d:?\d\d$/.test(i.at) ? Date.parse(i.at) : (() => { const m = String(i.at).match(/(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/); return m ? fromZoned(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], tz) : Date.parse(i.at); })()) : now() + (i.in_minutes ?? 60) * 6e4;
    if (!recurring && !(at > now())) throw new ToolError("BUSINESS_RULE", "that time is in the past; pick a future time");
    const spec = i.every_minutes ? { interval_minutes: Math.max(15, Number(i.every_minutes)) }
      : recurring ? { every: i.recurring ?? "daily", ...(days.length ? { days } : {}), ...(i.recurring === "weekly" && !days.length ? { day: zoned(now(), tz).dow } : {}), hour: hh, minute: mm, tz }
      : { at };
    const s = rt.createSchedule({ agent_id: ctx.agent.id, room_id: ctx.room.id, created_by: ctx.run.requested_by, objective: i.text, kind: recurring ? "recurring" : "time", spec });
    return { status: "SUCCEEDED", output: { schedule_id: s.id, next: fmtLocal(s.next_at, tz), time_zone: tz, repeats: recurring, text: i.text } };
  },
});

def({
  id: "settings.timezone", description: "Set the requester's time zone (IANA name, e.g. America/Los_Angeles) when they tell you where they are or which zone they're in. Reminders and times use it.",
  risk: "write_internal", idempotency: "safe", defaultApproval: "none", inputSchema: obj({ tz: str("IANA zone, e.g. America/New_York") }, ["tz"]),
  async execute({ tz }, ctx) {
    if (!ctx.run.requested_by || !setTz(ctx.run.requested_by, tz)) throw new ToolError("BUSINESS_RULE", `unknown time zone "${tz}"; use an IANA name like America/Chicago`);
    return { status: "SUCCEEDED", output: { tz, now_there: fmtLocal(now(), tz) } };
  },
});

def({
  id: "task.create", description: "Track a piece of work in this room. owner is a participant name or 'agent'. agent_action=blocked means the agent must not act on it (a human owns it).",
  risk: "write_internal", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ title: str(), owner: str(), agent_action: { type: "string", enum: ["allowed", "blocked"] }, subject: str("person/entity the task is about"), due_in_hours: num() }, ["title"]),
  async execute(i, ctx) {
    const t = rt.createTask(ctx.room.id, { title: i.title, owner: rt.resolveOwner(ctx.room.id, i.owner, ctx.agent.id), agent_action: i.agent_action ?? "allowed",
      subject: i.subject, due_at: i.due_in_hours ? now() + i.due_in_hours * 36e5 : null, created_by: ctx.agent.id });
    return { status: "SUCCEEDED", output: { ...t, owner: rt.nameOf(t.owner) } };
  },
});

def({
  id: "task.update", description: "Update a tracked task's status (open, waiting, blocked, done) or notes.", risk: "write_internal", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ task_id: str(), status: { type: "string", enum: ["open", "waiting", "blocked", "done"] }, notes: str() }, ["task_id"]),
  async execute(i, ctx) {
    const cur = one<any>("select * from tasks where id=? and room_id=?", i.task_id, ctx.room.id);
    if (!cur) throw new ToolError("BUSINESS_RULE", "no such task in this room");
    // Agents can't lift a human's guard or change a human's task (only humans do that, from the room).
    if (cur.agent_action === "blocked" || (cur.owner && !cur.owner.startsWith("agt_")))
      throw new ToolError("PERMISSION", `"${cur.title}" is owned by ${rt.nameOf(cur.owner) ?? "a human"}; only they can change it`);
    const t = rt.updateTask(i.task_id, ctx.room.id, i, ctx.agent.id);
    return { status: "SUCCEEDED", output: t };
  },
});

def({
  id: "memory.remember", testSimulate: true, description: "Save a durable fact/preference/decision. scope: room (participants of this room) or workspace (whole team; not allowed from private chats).",
  risk: "write_internal", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ text: str(), scope: { type: "string", enum: ["room", "workspace", "user_private"] }, kind: { type: "string", enum: ["fact", "preference", "decision", "relationship", "procedure"] } }, ["text"]),
  async execute(i, ctx) {
    const m = await import("./memory");
    const r = m.remember({ run: ctx.run, room: ctx.room, text: i.text, scope: i.scope ?? "room", kind: i.kind ?? "fact", createdBy: ctx.agent.id });
    if ("error" in r) throw new ToolError("PERMISSION", r.error!);
    return { status: "SUCCEEDED", output: r };
  },
});

def({
  id: "files.read", description: "Read the text of a file attached in this room (by file_id). Use offset to page through long files.", risk: "read",
  idempotency: "safe", defaultApproval: "none", inputSchema: obj({ file_id: str(), offset: num("character offset") }, ["file_id"]),
  async execute({ file_id, offset = 0 }, ctx) {
    const f = one<any>("select name, mime, text from files where id=? and room_id=?", file_id, ctx.room.id);
    if (!f) throw new ToolError("PERMISSION", "no such file in this room");
    if (!f.text) throw new ToolError("BUSINESS_RULE", `can't read ${f.mime} files yet`);
    const chunk = f.text.slice(offset, offset + 15000);
    return { status: "SUCCEEDED", untrusted: true, output: { name: f.name, text: chunk, offset, total: f.text.length, more: offset + 15000 < f.text.length } };
  },
});

def({
  id: "plan.update", description: "Update this task's plan: mark a step (1-based) done/skipped, or replace the remaining steps when the plan needs to change.",
  risk: "write_internal", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ step: num("1-based step number"), status: { type: "string", enum: ["done", "skipped", "todo"] }, replace_remaining: { type: "array", items: str() } }),
  async execute(i, ctx) {
    const r = (await import("./intake")).updatePlan(ctx.run.id, i);
    if ("error" in r) throw new ToolError("BUSINESS_RULE", r.error!);
    return { status: "SUCCEEDED", output: r };
  },
});

def({
  id: "agent.delegate", description: "Hand part of the work to another agent in this workspace. It receives only the objective you give it, not this conversation.",
  risk: "write_internal", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ agent: str("agent name"), objective: str(), context: str("only what the other agent needs") }, ["agent", "objective"]),
  async execute(i, ctx) {
    const d = rt.delegate(ctx.run, i.agent, i.objective, i.context);
    if ("error" in d) throw new ToolError("BUSINESS_RULE", d.error!);
    return { status: "SUCCEEDED", output: { agent: i.agent, child_run_id: d.childRunId }, wait: { kind: "agent", reason: `waiting for ${i.agent}`, wake_key: `run:${d.childRunId}` } };
  },
});

def({
  id: "wait.for_reply", description: "Pause this task until an email arrives from an address (or any new message in this room), with a timeout.",
  risk: "write_internal", idempotency: "safe", defaultApproval: "none",
  inputSchema: obj({ from_email: str(), timeout_hours: num() }),
  async execute(i, ctx) {
    const key = i.from_email ? `email:${ctx.run.workspace_id}:${i.from_email.toLowerCase()}` : "room_message";
    return { status: "SUCCEEDED", output: { waiting_for: key }, wait: { kind: "event", reason: `waiting for ${i.from_email ?? "a reply"}`, wake_key: key, timeout_at: now() + (i.timeout_hours ?? 48) * 36e5 } };
  },
});

// ---------- schema validation ----------
export function validate(schema: any, v: any, path = "input"): string | null {
  if (schema.type === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return `${path} must be an object`;
    for (const k of schema.required ?? []) if (v[k] === undefined) return `${path}.${k} is required`;
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (!schema.properties?.[k]) { if (schema.additionalProperties === false) return `${path}.${k} is not allowed`; continue; }
      const e = validate(schema.properties[k], val, `${path}.${k}`); if (e) return e;
    }
    return null;
  }
  if (schema.type === "array") return Array.isArray(v) ? v.map((x, i) => validate(schema.items ?? {}, x, `${path}[${i}]`)).find(Boolean) ?? null : `${path} must be an array`;
  if (schema.type === "string") return typeof v !== "string" ? `${path} must be a string` : schema.enum && !schema.enum.includes(v) ? `${path} must be one of ${schema.enum}` : null;
  if (schema.type === "number") return typeof v === "number" ? null : `${path} must be a number`;
  return null;
}

const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${k}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);
export const fingerprint = (runId: string, toolId: string, input: any) => sha(`${runId}|${toolId}|${canon(input)}`);
const flatten = (v: any): string => typeof v === "string" ? v : v && typeof v === "object" ? Object.values(v).map(flatten).join(" ") : String(v ?? "");

/** Pick the connection this agent should use in this room: requester's own, then workspace-shared, then any granted owned by a room member. */
export function resolveConnection(provider: string, agentId: string, run: any, roomHumans: string[]) {
  const rows = all<any>(`select c.*, (g.agent_id is not null) granted from connections c left join connection_grants g on g.connection_id=c.id and g.agent_id=?
    where c.workspace_id=? and c.provider=? and c.status!='revoked'`, agentId, run.workspace_id, provider);
  const score = (c: any) => (c.granted ? 8 : 0) + (c.owner_id === run.requested_by ? 4 : 0) + (c.visibility === "workspace" ? 2 : 0) + (roomHumans.includes(c.owner_id) ? 1 : 0);
  return rows.sort((a, b) => score(b) - score(a))[0] ?? null;
}

export type GatewayResult =
  | { kind: "result"; content: string; status: string }
  | { kind: "wait"; waitId?: string }
  | { kind: "retry"; delayMs: number; reason: string };

export async function executeToolCall(run: any, agent: any, room: any, call: { id: string; name: string; input: any }, allowedTools: Set<string>): Promise<GatewayResult> {
  // (call may be rebound below when a tool normalizes its input)
  const base = { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: agent.id };
  const d0 = getTool(call.name);
  const d = d0 && d0.riskOf ? { ...d0, risk: d0.riskOf(call.input ?? {}) } : d0;
  if (d?.normalize) call = { ...call, input: d.normalize(call.input ?? {}, { run, agent, room }) };
  emit("TOOL_CALL_REQUESTED", { ...base, data: { tool: call.name, input: call.input, call_id: call.id } });
  if (!d) return { kind: "result", status: "FAILED", content: `DENIED: unknown tool ${call.name}` };
  const bad = validate(d.inputSchema, call.input ?? {});
  if (bad) return { kind: "result", status: "FAILED", content: `FAILED: invalid input — ${bad}` };

  const humans = rt.roomHumanIds(room.id);
  let conn = d.connectionId
    ? one<any>("select c.*, (g.agent_id is not null) granted from connections c left join connection_grants g on g.connection_id=c.id and g.agent_id=? where c.id=?", agent.id, d.connectionId)
    : d.requiresConnection ? resolveConnection(d.requiresConnection, agent.id, run, humans) : null;
  // Website logins (OpenTable, Resy...) are credentials too: same ownership rules, passed to the browser runner only.
  const site = d.siteLogin?.(call.input ?? {});
  const login = site ? resolveSiteLogin(site, agent.id, run, humans) : null;
  if (site && !login && d.siteLoginRequired && room.mode !== "test") return { kind: "result", status: "FAILED", content: `DENIED: connect your ${site} login first (Connections → Add site login)` };
  if (login && !conn) conn = login;
  // Test mode: the full pipeline runs (policy, approvals, trace), but nothing leaves the platform.
  const testMode = room.mode === "test";
  const simulateWrite = testMode && (["write_external", "destructive", "financial"].includes(d.risk) || d.id.startsWith("mcp.") || !!d.testSimulate);
  const simulateRead = testMode && !!d.requiresConnection && (!conn || conn.status !== "active");
  if (simulateRead) conn = { id: "sim", owner_id: run.requested_by, visibility: "workspace", status: "active", granted: 1, account: "sample data" };
  const fp = fingerprint(run.id, call.name, call.input);
  const standing = d.preApproved?.(call.input ?? {}, run) ?? null; // pre-authorized within limits the human set earlier
  const spent = J(run.spent, {}), budget = J(run.budget, {});
  if ((spent.toolCalls ?? 0) >= (budget.maxToolCalls ?? 25)) return { kind: "result", status: "FAILED", content: "FAILED: tool call budget for this run is exhausted" };

  const perms = J(agent.permissions, {});
  const { decision, reason } = evaluatePolicy({
    toolId: d.id, risk: d.risk, defaultApproval: d.defaultApproval, agentMode: perms[d.id], toolAllowed: allowedTools.has(d.id),
    requiresConnection: d.requiresConnection ?? (login ? "site_login" : undefined),
    connection: conn && { ownerId: conn.owner_id, visibility: conn.visibility, status: conn.status, granted: !!conn.granted },
    roomHumanIds: humans, blockedSubjects: rt.blockedSubjects(room.id), inputText: flatten(call.input),
    priorApproval: !!one("select 1 from approvals where run_id=? and fingerprint=? and status='approved'", run.id, fp) || !!standing,
    standingGrant: !!one("select 1 from grants where agent_id=? and tool_id=?", agent.id, d.id),
    tainted: !!run.tainted, requesterId: run.requested_by,
    requesterIsMember: !!run.requested_by && !!one("select 1 from memberships where workspace_id=? and user_id=?", run.workspace_id, run.requested_by),
    externalWritesSoFar: spent.externalWrites ?? 0, maxAutonomousExternalWrites: budget.maxAutonomousExternalWrites ?? 3,
  });
  emit("PERMISSION_DECISION", { ...base, data: { tool: d.id, decision, reason: standing && decision === "ALLOW" ? `pre-approved within your limits (${standing})` : reason, fingerprint: fp, connection_id: conn?.id ?? null } });

  if (decision === "DENY") return { kind: "result", status: "FAILED", content: `DENIED: ${reason}` };
  if (decision !== "ALLOW") {
    const rejected = one<any>("select * from approvals where run_id=? and fingerprint=? and status in ('rejected','expired')", run.id, fp);
    if (rejected) return { kind: "result", status: "FAILED", content: `REJECTED: ${rt.nameOf(rejected.decided_by) ?? "approver"} declined this action` };
    const waitId = rt.requestApproval(run, agent, d, call.input, fp, decision === "REQUIRE_STRONG_CONFIRMATION", reason, conn);
    return { kind: "wait", waitId };
  }

  // Idempotency: persist the fingerprint before the side effect (plan §35.1). The worst failure is executing a write twice.
  const prev = one<any>("select * from tool_executions where fingerprint=?", fp);
  if (prev?.status === "succeeded") return { kind: "result", status: "SUCCEEDED", content: wrap(d, prev.result, !!J(prev.result)?.__untrusted) };
  if (prev?.status === "started" || prev?.status === "unknown") {
    exec("update tool_executions set status='unknown' where id=?", prev.id);
    const w = rt.createWait(run, { kind: "verify", reason: `${d.id} may have run already; a human must verify before retrying`, owner: run.requested_by });
    return { kind: "wait", waitId: w };
  }
  const exId = id("tex");
  exec("insert into tool_executions (id, run_id, tool_id, fingerprint, status, input, connection_id, created_at) values (?,?,?,?,?,?,?,?)",
    exId, run.id, d.id, fp, "started", S(call.input), conn?.id ?? null, now());
  const ctx: ToolCtx = { run, agent, room, idempotencyKey: fp, connection: conn && conn !== login ? { id: conn.id, cred: unseal(conn.cred_enc), account: conn.account } : undefined,
    siteLogin: login && login.provider !== "browser_login" ? { ...unseal<any>(login.cred_enc), site } : undefined,
    browserLogin: login?.provider === "browser_login" ? ((config) => ({ id: login.id, site: config.site, context_id: config.context_id, config }))(J(login.config, {})) : undefined };
  try {
    const out = simulateWrite || simulateRead ? simulate(d, call.input, simulateRead) : await d.execute(call.input, ctx);
    const stored = { ...out.output, __untrusted: !!out.untrusted, __status: out.status };
    exec("update tool_executions set status=?, result=?, updated_at=? where id=?", out.status === "UNKNOWN" ? "unknown" : "succeeded", S(stored), now(), exId);
    if (standing && out.status === "SUCCEEDED") exec("update standing_approvals set uses=uses+1, status=case when uses+1>=max_uses then 'used' else status end where id=?", standing);
    if (conn) exec("update connections set last_used_at=? where id=?", now(), conn.id);
    rt.addSpent(run.id, { toolCalls: 1, externalWrites: d.risk === "write_external" || d.risk === "destructive" ? 1 : 0, tainted: !!out.untrusted });
    if (d.id.startsWith("web.") || d.id === "browser.task") recordUsage({ workspace_id: run.workspace_id, agent_id: agent.id, run_id: run.id, kind: d.id === "browser.task" ? "browser_tasks" : "search_calls", qty: 1 });
    emit("TOOL_CALL_COMPLETED", { ...base, data: { tool: d.id, status: out.status, connection_id: conn?.id ?? null, connection_account: conn?.account ?? null, result_summary: S(out.output).slice(0, 300) } });
    if (out.status === "UNKNOWN") {
      const w = rt.createWait(run, { kind: "verify", reason: `${d.id} returned an unknown status; verify before retrying`, owner: run.requested_by });
      return { kind: "wait", waitId: w };
    }
    if (out.wait) {
      const w = rt.createWait(run, { ...out.wait, owner: out.wait.owner ?? agent.id });
      rt.appendToolResult(run.id, call, wrap(d, S(stored), !!out.untrusted));
      return { kind: "wait", waitId: w };
    }
    return { kind: "result", status: out.status, content: wrap(d, S(stored), !!out.untrusted) };
  } catch (e: any) {
    const k: ErrKind = e instanceof ToolError ? e.kind : "UNKNOWN_SIDE_EFFECT";
    emit("TOOL_CALL_FAILED", { ...base, data: { tool: d.id, error_kind: k, error: e.message } });
    if (k === "TRANSIENT" || k === "RATE_LIMIT") {
      exec("delete from tool_executions where id=?", exId); // known not applied: safe to retry
      return { kind: "retry", delayMs: e.retryAfterMs || 5000, reason: e.message };
    }
    if (k === "AUTH" && conn) {
      exec("delete from tool_executions where id=?", exId);
      exec("update connections set status='needs_reauth' where id=?", conn.id);
      const w = rt.createWait(run, { kind: "reconnect", reason: `${d.requiresConnection} connection needs to be reconnected`, owner: conn.owner_id, wake_key: `connection:${conn.id}` });
      return { kind: "wait", waitId: w };
    }
    if (k === "UNKNOWN_SIDE_EFFECT" && d.risk !== "read") {
      exec("update tool_executions set status='unknown', result=? where id=?", S({ error: e.message }), exId);
      const w = rt.createWait(run, { kind: "verify", reason: `${d.id} failed mid-flight (${e.message}); verify before retrying`, owner: run.requested_by });
      return { kind: "wait", waitId: w };
    }
    exec("delete from tool_executions where id=?", exId);
    return { kind: "result", status: "FAILED", content: `FAILED: ${e.message}` };
  }
}

const SAMPLES: Record<string, (i: any) => any> = {
  "calendar.list_events": () => ({ events: [{ summary: "Team sync (sample)", start: new Date(now() + 864e5).toISOString() }, { summary: "Dinner (sample)", start: new Date(now() + 2 * 864e5).toISOString() }] }),
  "calendar.find_free_time": (i) => ({ slots: [1, 2, 3].map((d) => ({ start: new Date(now() + d * 864e5).toISOString() })), duration_minutes: i.duration_minutes ?? 30 }),
  "email.search": () => ({ messages: [{ from: "sam@example.com (sample)", subject: "Re: plans", snippet: "Sounds good — Friday works." }] }),
  "contacts.search": (i) => ({ people: [{ name: `${i.query} (sample)`, emails: [`${String(i.query).toLowerCase()}@example.com`] }] }),
  "drive.search": (i) => ({ files: [{ id: "sample", name: `${i.query} (sample)`, webViewLink: "https://example.com/doc" }] }),
};
/** Test-mode result: what would have happened, without doing it. */
function simulate(d: ToolDef, input: any, sampleRead: boolean): ToolOutcome {
  if (sampleRead) return { status: "SUCCEEDED", output: { ...(SAMPLES[d.id]?.(input) ?? { note: "sample result" }), sample: "test mode: sample data, connect the account for real results" } };
  return { status: "SUCCEEDED", output: { simulated: true, would: d.summarize?.(input) ?? `${d.id} ${JSON.stringify(input).slice(0, 120)}`, note: "test mode — nothing was sent or booked" } };
}

/** Label tool output by origin so the model treats it as data, never instructions (plan §21.2). */
function wrap(d: ToolDef, stored: string, untrusted: boolean) {
  const clean = J(stored, {}); delete clean.__untrusted; delete clean.__status;
  return untrusted ? `<untrusted origin="TOOL_RESULT_UNTRUSTED" tool="${d.id}">\n${S(clean)}\n</untrusted>` : S(clean);
}

export const toolSpecs = (ids: Iterable<string>) => [...ids].map(getTool).filter(Boolean).map((t) => ({ name: t!.id, description: t!.description, input_schema: t!.inputSchema }));

/** Stored login (site_login) or live-browser login (browser_login) for a site. An expired browser_login is still returned when
 * nothing usable is, so policy tells the owner to reconnect instead of the task silently running signed out. */
export function resolveSiteLogin(site: string, agentId: string, run: any, roomHumans: string[]) {
  const rows = all<any>(`select c.*, (g.agent_id is not null) granted from connections c left join connection_grants g on g.connection_id=c.id and g.agent_id=?
    where c.workspace_id=? and (c.provider='site_login' and c.status='active' or c.provider='browser_login' and c.status in ('active','needs_reauth'))
    and (json_extract(c.config, '$.site')=? or ? like '%.' || json_extract(c.config, '$.site'))`, agentId, run.workspace_id, site, site);
  // Ownership ranks first; a live-browser login beats a stored password only between otherwise equal candidates.
  const score = (c: any) => (c.status === "active" ? 16 : 0) + (c.granted ? 8 : 0) + (c.owner_id === run.requested_by ? 4 : 0) + (roomHumans.includes(c.owner_id) ? 1 : 0) + (c.provider === "browser_login" ? 0.5 : 0);
  return rows.sort((a, b) => score(b) - score(a))[0] ?? null;
}

// Domain tool packs (registered after the core tools exist).
import { registerReservationTools } from "./reservations";
import { registerOrderTools } from "./orders";
import { registerGroupTools } from "./groupkit";
registerReservationTools(def);
registerOrderTools(def);
registerGroupTools(def);
