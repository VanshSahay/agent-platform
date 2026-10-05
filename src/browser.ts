// Live-browser website logins on Browserbase (lessons from Castellum). The user logs in themselves inside a Browserbase
// session shown in an iframe; we keep only the Context id (an opaque handle to an encrypted profile Browserbase holds).
// No password, cookie or token is ever stored here.
import { all, one, exec, emit, id, now, S, J } from "./db";
import * as rt from "./runtime";
import { assertPublicUrl } from "./tools";

const API = "https://api.browserbase.com/v1";

async function bbCall<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { "X-BB-API-Key": process.env.BROWSERBASE_API_KEY ?? "", "content-type": "application/json" }, signal: AbortSignal.timeout(20000) });
  // Browserbase's own message matters ("plan does not include keepAlive" vs "invalid uuid" need different fixes).
  if (!r.ok) throw new Error(`Browserbase ${init.method ?? "GET"} ${path} →${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

export const bb = {
  /** A fresh, empty encrypted profile. */
  createContext: async () => (await bbCall<{ id: string }>("/contexts", { method: "POST", body: "{}" })).id,
  createSession: async (o: { contextId: string; persist?: boolean; keepAlive?: boolean; timeoutSec?: number; viewport?: { width: number; height: number } }) =>
    (await bbCall<{ id: string }>("/sessions", { method: "POST", body: S({
      // ~1:1 with the embed: wide viewports shrink login fields to unusable inside the iframe.
      browserSettings: { context: { id: o.contextId, persist: o.persist ?? true }, viewport: o.viewport ?? { width: 1024, height: 700 } },
      keepAlive: o.keepAlive ?? false, timeout: o.timeoutSec ?? 900 }) })).id,
  liveViewUrl: async (sessionId: string) => (await bbCall<{ debuggerFullscreenUrl: string }>(`/sessions/${sessionId}/debug`)).debuggerFullscreenUrl,
  /** Ends the session: the Context is written back and billing stops. */
  releaseSession: (sessionId: string) => bbCall(`/sessions/${sessionId}`, { method: "POST", body: S({ status: "REQUEST_RELEASE" }) }),
  replayUrl: (sessionId: string) => `https://www.browserbase.com/sessions/${sessionId}`,
  /** Drop a replaced profile at Browserbase so a stale login can't be reused (best-effort). */
  deleteContext: (contextId: string) => bbCall(`/contexts/${contextId}`, { method: "DELETE" }).catch(() => null),
  /** Point the live session's tab at a URL over CDP: the fullscreen live view has no address bar. Only detaches afterwards —
   *  closing the browser would end the session (Castellum). Best-effort: false means the user sees a blank tab. */
  async openUrl(sessionId: string, url: string, timeoutMs = 10_000): Promise<boolean> {
    const ws: string | undefined = (await bbCall<any>(`/sessions/${sessionId}`).catch(() => null))?.connectUrl;
    if (!ws) return false;
    return new Promise((resolve) => {
      const sock = new WebSocket(ws); let seq = 0; const pending = new Map<number, (m: any) => void>();
      const done = (ok: boolean) => { clearTimeout(t); try { sock.close(); } catch {} resolve(ok); };
      const t = setTimeout(() => done(false), timeoutMs);
      const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => { const i = ++seq; pending.set(i, res); sock.send(S({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
      sock.onmessage = (ev) => { const m = J(String(ev.data), {}); pending.get(m.id)?.(m); pending.delete(m.id); };
      sock.onerror = () => done(false);
      sock.onopen = async () => {
        const page = (await send("Target.getTargets")).result?.targetInfos?.find((x: any) => x.type === "page");
        const target = page?.targetId ?? (await send("Target.createTarget", { url: "about:blank" })).result?.targetId;
        const sid = (await send("Target.attachToTarget", { targetId: target, flatten: true })).result?.sessionId;
        const nav = sid ? await send("Page.navigate", { url }, sid) : null;
        done(!!nav && !nav.error);
      };
    });
  },
};

/** One Browserbase session per login at a time. Held until the Context has synced after release: reusing it sooner opens a
 * half-written profile, which reads as logged out (Castellum). ponytail: in-process; a Postgres advisory lock when multi-instance. */
const locks = new Map<string, Promise<void>>();
export async function withLoginLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let done!: () => void;
  const tail = prev.then(() => new Promise<void>((r) => (done = r)));
  locks.set(key, tail);
  await prev;
  try { return await fn(); }
  finally {
    const ms = Number(process.env.BROWSERBASE_CONTEXT_SYNC_MS ?? 5000);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms)); // portable: also runs in the Node (Temporal) worker
    done();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** How to tell a login has expired: open probe_url, logged out if the final URL or title matches. Per-connection config wins. */
const PROBES: Record<string, { url: string; pattern: RegExp }> = {
  "resy.com": { url: "https://resy.com/account", pattern: /\/login|sign in|log in/i },
  "opentable.com": { url: "https://www.opentable.com/user/dining-dashboard", pattern: /\/login|\/signin|sign in|log in/i },
  "linkedin.com": { url: "https://www.linkedin.com/feed/", pattern: /\/login|\/authwall|sign in|join now/i },
};
export function loginProbe(site: string, config: any): { url: string; pattern: RegExp } | null {
  if (config?.probe_url && config?.logged_out_pattern) { try { return { url: config.probe_url, pattern: new RegExp(config.logged_out_pattern, "i") }; } catch {} }
  return PROBES[site] ?? PROBES[Object.keys(PROBES).find((k) => site.endsWith(`.${k}`)) ?? ""] ?? null;
}

export const normSite = (s: any) => String(s ?? "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[/?#:].*$/, "").toLowerCase();

// ---------------- HTTP routes (mounted by server.ts) ----------------
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };
// Same session lookup and membership checks as server.ts.
function userOf(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? req.headers.get("cookie")?.match(/(?:^|; )sid=([^;]+)/)?.[1];
  return (token && one<any>("select u.* from sessions s join users u on u.id=s.user_id where s.token=? and s.expires_at>?", token, now())) || fail(401, "sign in required");
}
function member(wsId: any, userId: string, roles?: string[]) {
  const m = wsId ? one<any>("select * from memberships where workspace_id=? and user_id=?", wsId, userId) : null;
  if (!m) fail(404, "workspace not found");
  if (roles && !roles.includes(m.role)) fail(403, `requires ${roles.join("/")}`);
  return m;
}
function checkAgents(ids: any, ws: string) {
  if (ids != null && !Array.isArray(ids)) fail(400, "agent_ids must be a list");
  for (const a of ids ?? []) if (!one("select 1 from agents where id=? and workspace_id=?", a, ws)) fail(400, "agent belongs to another workspace");
  return (ids ?? []) as string[];
}
/** The open login session this user started (its pending connection holds site + context id). */
function pendingLogin(sessionId: any, userId: string) {
  return one<any>(`select b.id bs_id, b.session_id, c.* from browser_sessions b join connections c on c.id=b.connection_id
    where b.session_id=? and b.purpose='login' and b.status='open' and c.owner_id=? and c.status='pending'`, String(sessionId ?? ""), userId) ?? fail(404, "no open login session; start again");
}

export async function startBrowserLogin(user: any, b: any) {
  member(b.workspace_id, user.id);
  if (!process.env.BROWSERBASE_API_KEY) fail(501, "Browserbase isn't set up on this server (BROWSERBASE_API_KEY)");
  const site = normSite(b.site);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) fail(400, "site must be a website address like resy.com");
  await assertPublicUrl(`https://${site}/`).catch((e: any) => fail(400, `site must be a public website (${e.message})`));
  const login_url = b.login_url ? (await assertPublicUrl(b.login_url).catch((e: any) => fail(400, `login_url: ${e.message}`))).toString() : `https://${site}/`;
  checkAgents(b.agent_ids, b.workspace_id);
  // Only one live login per site per person: abandon earlier unfinished ones.
  for (const p of all<any>(`select b.session_id, b.id, c.id cid from connections c join browser_sessions b on b.connection_id=c.id and b.status='open'
    where c.workspace_id=? and c.owner_id=? and c.provider='browser_login' and c.status='pending' and json_extract(c.config, '$.site')=?`, b.workspace_id, user.id, site)) {
    await bb.releaseSession(p.session_id).catch(() => {});
    exec("update browser_sessions set status='cancelled', ended_at=? where id=?", now(), p.id);
    exec("update connections set status='revoked' where id=?", p.cid);
  }
  const context_id = await bb.createContext().catch((e: any) => fail(502, e.message));
  const session_id = await bb.createSession({ contextId: context_id, persist: true, keepAlive: true, timeoutSec: 1800 }).catch((e: any) => fail(502, e.message)); // 30 min: password + 2FA, bounds a forgotten tab
  const opened = await bb.openUrl(session_id, login_url); // the live view has no address bar, so we open the login page for them
  const live_view_url = await bb.liveViewUrl(session_id).catch(async (e: any) => { await bb.releaseSession(session_id).catch(() => {}); return fail(502, e.message); });
  const cid = id("con");
  exec("insert into connections (id, workspace_id, owner_id, visibility, provider, label, account, cred_enc, config, status, created_at) values (?,?,?,?,?,?,?,?,?,?,?)",
    cid, b.workspace_id, user.id, "private", "browser_login", `${site} (live login)`, site, null, S({ site, context_id }), "pending", now());
  exec("insert into browser_sessions (id, connection_id, workspace_id, purpose, session_id, status, replay_url, run_id, created_at) values (?,?,?,?,?,?,?,?,?)",
    id("bbs"), cid, b.workspace_id, "login", session_id, "open", bb.replayUrl(session_id), null, now());
  return { session_id, live_view_url, context_id, login_url, opened };
}

export async function finishBrowserLogin(user: any, b: any) {
  const p = pendingLogin(b.session_id, user.id);
  if (b.workspace_id && b.workspace_id !== p.workspace_id) fail(400, "session belongs to another workspace");
  const visibility = b.visibility === "workspace" ? "workspace" : "private";
  member(p.workspace_id, user.id, visibility === "workspace" ? ["owner", "admin"] : undefined);
  const site = J(p.config, {}).site;
  if (b.site && normSite(b.site) !== site) fail(400, `this session is for ${site}`);
  const agents = checkAgents(b.agent_ids, p.workspace_id);
  await bb.releaseSession(p.session_id).catch((e: any) => fail(502, `couldn't save the login: ${e.message}`)); // release = Context persisted
  exec("update browser_sessions set status='completed', ended_at=? where id=?", now(), p.bs_id);
  // One active login per (workspace, owner, site): a reconnect replaces the old one and keeps its agents.
  const old = all<any>(`select id, config from connections where workspace_id=? and owner_id=? and provider='browser_login' and status in ('active','needs_reauth')
    and json_extract(config, '$.site')=?`, p.workspace_id, user.id, site);
  const keep = old.flatMap((o) => all<any>("select agent_id from connection_grants where connection_id=?", o.id).map((g) => g.agent_id as string));
  exec("update connections set status='active', visibility=?, account=?, label=? where id=?", visibility, String(b.account ?? "").slice(0, 200) || site, `${site} (live login)`, p.id);
  for (const a of new Set([...keep, ...agents])) exec("insert or ignore into connection_grants values (?,?)", p.id, a);
  for (const o of old) {
    exec("update connections set status='revoked', cred_enc=null where id=?", o.id);
    if (J(o.config, {}).context_id) await bb.deleteContext(J(o.config, {}).context_id);
    exec("delete from connection_grants where connection_id=?", o.id);
    emit("CONNECTION_REVOKED", { workspace_id: p.workspace_id, actor: user.id, data: { connection_id: o.id, replaced_by: p.id } });
    rt.signalEvent(`connection:${o.id}`, `${site} login reconnected`); // resumes runs parked on a reconnect
  }
  emit("CONNECTION_CREATED", { workspace_id: p.workspace_id, actor: user.id, data: { connection_id: p.id, provider: "browser_login", site } });
  return { id: p.id, site, status: "active", replaced: old.map((o) => o.id) };
}

export async function cancelBrowserLogin(user: any, b: any) {
  const p = pendingLogin(b.session_id, user.id);
  await bb.releaseSession(p.session_id).catch(() => {}); // already gone is fine
  exec("update browser_sessions set status='cancelled', ended_at=? where id=?", now(), p.bs_id);
  exec("update connections set status='revoked' where id=?", p.id);
  return { ok: true };
}

const route = (fn: (user: any, b: any) => Promise<any>) => async (req: Request) => {
  try { const b = await req.json().catch(() => ({})); return Response.json(await fn(userOf(req), b ?? {})); }
  catch (e: any) { if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status }); console.error(e); return Response.json({ error: "internal error" }, { status: 500 }); }
};
export const browserRoutes: Record<string, any> = {
  "/v1/browser-logins/start": { POST: route(startBrowserLogin) },
  "/v1/browser-logins/finish": { POST: route(finishBrowserLogin) },
  "/v1/browser-logins/cancel": { POST: route(cancelBrowserLogin) },
};
