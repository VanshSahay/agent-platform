import { createRoot } from "react-dom/client";
import { useEffect, useState, useCallback, useRef, createContext, useContext, type ReactNode } from "react";
import qrcode from "qrcode-generator";

// PWA: installable on phones (added at runtime so the HTML bundler doesn't try to resolve them).
for (const [rel, href] of [["manifest", "/manifest.webmanifest"], ["icon", "/icon.svg"], ["apple-touch-icon", "/icon.svg"]]) {
  const l = document.createElement("link"); l.rel = rel; l.href = href; document.head.appendChild(l);
}

// ---------------- plumbing ----------------
async function api(path: string, body?: any, method?: string) {
  const r = await fetch(path, { method: method ?? (body ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}
function useHash() {
  const [h, set] = useState(location.hash.slice(1) || "/");
  useEffect(() => { const f = () => set(location.hash.slice(1) || "/"); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h;
}
const go = (p: string) => { location.hash = p; };
function useApi<T = any>(path: string | null, poll = 0): [T | null, () => void, string | null] {
  const [d, setD] = useState<T | null>(null), [e, setE] = useState<string | null>(null), [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () => api(path).then((x) => live && (setD(x), setE(null))).catch((x) => live && setE(x.message));
    load();
    const t = poll ? setInterval(load, poll) : null;
    return () => { live = false; if (t) clearInterval(t); };
  }, [path, n, poll]);
  return [d, () => setN((x) => x + 1), e];
}
const Ctx = createContext<{ me: any; ws: string; setWs: (w: string) => void; toast: (s: string) => void; reloadMe: () => void }>(null as any);
const useCtx = () => useContext(Ctx);
const ago = (ts: number) => { const s = (Date.now() - ts) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(ts).toLocaleDateString(); };
const STATUS: Record<string, [string, string]> = {
  queued: ["Queued", ""], running: ["Working", "accent"], waiting_for_human: ["Needs a human", "warn"], waiting_for_external: ["Waiting", ""],
  waiting_for_agent: ["Waiting on agent", ""], scheduled: ["Scheduled", ""], retrying: ["Retrying", "warn"], completed: ["Done", "ok"], failed_terminal: ["Failed", "bad"], cancelled: ["Cancelled", ""],
};
const Status = ({ s }: { s: string }) => <span className={`pill ${STATUS[s]?.[1] ?? ""}`}>{STATUS[s]?.[0] ?? s}</span>;
const MODES = ["auto", "first_time", "ask", "always_ask", "never"];
const MODE_LABEL: Record<string, string> = { auto: "Automatic", first_time: "Ask first time", ask: "Ask first", always_ask: "Always ask", never: "Never" };
const PLATFORM: Record<string, string> = { web: "Web", imessage: "iMessage", telegram: "Telegram", slack: "Slack", whatsapp: "WhatsApp", email: "Email", phone: "Phone" };

// ---------------- auth ----------------
function QR({ value, size = 168 }: { value: string; size?: number }) {
  const q = qrcode(0, "M"); q.addData(value); q.make();
  const cell = Math.max(2, Math.floor(size / q.getModuleCount()));
  return <div style={{ display: "inline-block", flexShrink: 0, lineHeight: 0, background: "#fff", padding: 8, borderRadius: 10 }} dangerouslySetInnerHTML={{ __html: q.createSvgTag(cell, 0) }} />;
}

function Landing({ onDone }: { onDone: () => void }) {
  const [list] = useApi<any[]>("/v1/agent-templates");
  return <div className="landing">
    <div className="landing-hero">
      <div>
        <div className="pill accent">Agents that live where you talk</div>
        <h1 style={{ fontSize: 40, lineHeight: 1.1, margin: "14px 0" }}>Describe an agent.<br />Test it. Text it.</h1>
        <p className="muted" style={{ fontSize: 17 }}>Create an agent for yourself or your team in plain words, try it safely, then deploy it in one tap to iMessage, WhatsApp, Slack, Telegram or the web — where it actually does the work.</p>
        <div className="row wrap mt16" style={{ gap: 18 }}>{[["1", "Describe", "“Grab me a table at the hottest spots on Resy”"], ["2", "Test", "Dry-run it — nothing is sent or booked"], ["3", "Deploy", "Text it from your phone or add it to a group"]].map(([n, h, d]) =>
          <div key={n} style={{ maxWidth: 190 }}><div className="avatar">{n}</div><b className="mt8" style={{ display: "block" }}>{h}</b><div className="small muted">{d}</div></div>)}</div>
      </div>
      <Auth onDone={onDone} />
    </div>
    <h2 style={{ maxWidth: 1040, margin: "40px auto 12px", padding: "0 24px" }}>Ready-made agents</h2>
    <div className="grid2" style={{ maxWidth: 1040, margin: "0 auto", padding: "0 24px 60px" }}>{list?.map((t) => <a key={t.id} className="card" href={`#/discover/${t.slug}`}>
      <div className="row"><div className="avatar">{t.manifest.avatar ?? t.name[0]}</div><b>{t.name}</b><span className="muted small">{t.manifest.title}</span></div>
      <div className="small muted mt8">{t.tagline}</div><div className="small mt8" style={{ color: "var(--accent-text)" }}>Try it →</div></a>)}</div>
  </div>;
}

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("signup"), [f, setF] = useState({ name: "", email: "", password: "" }), [err, setErr] = useState("");
  const submit = async (e: any) => { e.preventDefault(); setErr(""); try { await api(`/v1/auth/${mode}`, f); onDone(); } catch (x: any) { setErr(x.message); } };
  return <div className="auth card">
    <h1>{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
    <p className="muted">Persistent agents that work wherever you already talk.</p>
    <form className="col mt16" onSubmit={submit}>
      {mode === "signup" && <input className="input" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
      <input className="input" placeholder="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <input className="input" placeholder="Password (8+ characters)" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      {err && <div className="pill bad">{err}</div>}
      <button className="btn primary">{mode === "signup" ? "Sign up" : "Sign in"}</button>
      <a className="small muted" href="#" onClick={(e) => { e.preventDefault(); setMode(mode === "login" ? "signup" : "login"); }}>{mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}</a>
    </form>
    <p className="small faint mt16">Or <a href="#/discover" style={{ textDecoration: "underline" }}>try a public agent</a> without an account.</p>
  </div>;
}

// ---------------- shell ----------------
function App() {
  const route = useHash();
  const [me, reloadMe, meErr] = useApi<any>("/v1/me");
  const [ws, setWsState] = useState<string>(() => localStorage.getItem("ws") ?? "");
  const [msg, setMsg] = useState("");
  const toast = (s: string) => { setMsg(s); setTimeout(() => setMsg(""), 2500); };
  const setWs = (w: string) => { localStorage.setItem("ws", w); setWsState(w); };
  useEffect(() => { if (me && !me.workspaces.find((w: any) => w.id === ws)) setWs(me.workspaces[0]?.id); }, [me]);
  const [home] = useApi<any>(me && ws ? `/v1/home?workspace=${ws}` : null, 5000);
  useEffect(() => { document.querySelector(".main")?.scrollTo(0, 0); }, [route]);

  if (route.startsWith("/discover") && !me) return <div className="page"><Discover route={route} anonymous /></div>;
  if (meErr && !me) return <Landing onDone={() => { reloadMe(); go("/agents/new"); }} />;
  if (!me || !ws) return <div className="page muted">Loading…</div>;
  const attention = home ? home.needs_attention.approvals.length + home.needs_attention.waits.length + home.needs_attention.reconnect.length : 0;
  const nav = [["/", "Home", "⌂"], ["/agents", "Agents", "◎"], ["/rooms", "Rooms", "◇"], ["/tasks", "Tasks", "☑"], ["/discover", "Discover", "✦"], ["/connections", "Connections", "⟷"], ["/activity", "Activity", "≡"]];
  const on = (p: string) => (p === "/" ? route === "/" : route.startsWith(p));
  const wide = /^\/rooms\/[^/]+$/.test(route);
  return <Ctx.Provider value={{ me, ws, setWs, toast, reloadMe }}>
    <div className="app">
      <nav className="rail">
        <select className="ws-switch" value={ws} onChange={(e) => { setWs(e.target.value); go("/"); }}>
          {me.workspaces.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        {nav.map(([p, l, i]) => <a key={p} href={`#${p}`} className={on(p) ? "on" : ""}><span style={{ width: 16, textAlign: "center" }}>{i}</span>{l}{p === "/" && attention > 0 && <span className="count">{attention}</span>}</a>)}
        <div className="sep" />
        <a href="#/settings" className={on("/settings") ? "on" : ""}><span style={{ width: 16, textAlign: "center" }}>⚙</span>Settings</a>
      </nav>
      <main className="main"><div className={`page ${wide ? "wide" : ""}`}>
        {route === "/" ? <Home /> : route === "/agents" ? <Agents /> : route === "/agents/new" ? <CreateAgent /> : route.startsWith("/agents/") ? <AgentPage id={route.split("/")[2]} tab={route.split("/")[3]} />
          : route === "/rooms" ? <Rooms /> : route.startsWith("/rooms/") ? <Room id={route.split("/")[2]} /> : route.startsWith("/discover") ? <Discover route={route} />
          : route.startsWith("/connections") ? <Connections /> : route === "/activity" ? <Activity /> : route === "/tasks" ? <Tasks /> : route.startsWith("/settings") ? <Settings />
          : route.startsWith("/invite/") ? <AcceptInvite token={route.split("/")[2]} /> : <div className="empty">Not found</div>}
      </div></main>
    </div>
    {msg && <div className="toast">{msg}</div>}
  </Ctx.Provider>;
}

// ---------------- Home ----------------
function ApprovalCard({ a, onDone }: { a: any; onDone: () => void }) {
  const { toast } = useCtx();
  const [busy, setBusy] = useState(false);
  const decide = async (decision: string) => {
    setBusy(true);
    try { await api(`/v1/approvals/${a.id}/decision`, { decision, confirm: !!a.strong }); toast(decision === "approve" ? "Approved" : "Rejected"); onDone(); }
    catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const input = typeof a.input === "string" ? JSON.parse(a.input) : a.input;
  return <div className="approval">
    <div className="small muted">{a.agent_name} wants to:</div>
    <div className="what mt8">{a.summary}</div>
    <div className="small muted mt8">{a.room_name && <>In {a.room_name} · </>}Risk: {a.risk.replace("_", " ")}{a.strong ? " · strong confirmation" : ""}</div>
    <details className="mt8"><summary className="small muted" style={{ cursor: "pointer" }}>Preview</summary><pre className="code">{JSON.stringify(input, null, 2)}</pre></details>
    <div className="row mt8 between"><button className="btn" disabled={busy} onClick={() => decide("reject")}>Reject</button>
      <button className="btn primary" disabled={busy} onClick={() => decide("approve")}>{a.strong ? "Confirm" : "Approve once"}</button></div>
  </div>;
}
function Home() {
  const { ws, me } = useCtx();
  const [d, reload] = useApi<any>(`/v1/home?workspace=${ws}`, 4000);
  if (!d) return null;
  const hour = new Date().getHours();
  const att = d.needs_attention;
  const n = att.approvals.length + att.waits.length + att.reconnect.length;
  return <>
    <h1>Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}, {me.user.name.split(" ")[0]}</h1>
    {d.agent_count === 0 && <QuickStart />}
    <p className="muted">{n ? `${n} thing${n > 1 ? "s" : ""} need${n === 1 ? "s" : ""} your attention.` : "Nothing needs you right now."}</p>
    <h2>Needs your attention {n > 0 && <span className="pill accent">{n}</span>}</h2>
    {!n && <div className="empty">You're all caught up.</div>}
    <div className="col">
      {att.approvals.map((a: any) => <ApprovalCard key={a.id} a={a} onDone={reload} />)}
      {att.reconnect.map((c: any) => <div key={c.id} className="card row"><span className="pill warn">Reconnect</span><span className="grow">{c.provider} ({c.account}) needs to be reconnected; agent work is paused.</span><a className="btn" href={`/v1/connections/google/start?workspace=${ws}&reconnect=${c.id}`}>Reconnect</a></div>)}
      {att.waits.map((w: any) => <WaitCard key={w.id} w={w} onDone={reload} />)}
    </div>
    <h2>Active</h2>
    {d.active.length ? <div className="list">{d.active.map((r: any) => <a key={r.id} className="item" href={`#/rooms/${r.room_id}`}>
      <div className="avatar">{r.agent_name?.[0]}</div>
      <div className="grow"><div><b>{r.agent_name}</b> <span className="muted">{r.waits[0]?.reason ?? r.objective}</span></div><div className="small faint">{r.room_name} · {ago(r.updated_at)}</div></div>
      <Status s={r.status} /></a>)}</div> : <div className="empty">No agents are working on anything right now.</div>}
    {d.blocked.length > 0 && <><h2>Blocked</h2><div className="list">{d.blocked.map((t: any) => <a key={t.id} className="item" href={`#/rooms/${t.room_id}`}>
      <span className="pill bad">Blocked</span><span className="grow">{t.title}</span><span className="small muted">Owner: {t.owner_name} · {t.room_name}</span></a>)}</div></>}
    <h2>Recently completed</h2>
    {d.completed.length ? <div className="list">{d.completed.map((r: any) => <a key={r.id} className="item" href={`#/rooms/${r.room_id}`}>
      <span style={{ color: "var(--ok)" }}>✓</span><div className="grow"><div>{r.objective.slice(0, 90)}</div><div className="small faint">{r.agent_name} · {r.room_name} · {ago(r.completed_at)}</div></div></a>)}</div> : <div className="empty">Finished work will show up here.</div>}
    {d.failed.length > 0 && <><h2>Failed</h2><div className="list">{d.failed.map((r: any) => <a key={r.id} className="item" href={`#/rooms/${r.room_id}`}><span className="pill bad">Failed</span><span className="grow">{r.objective.slice(0, 80)}</span><span className="small muted">{r.error}</span></a>)}</div></>}
  </>;
}
function BriefCard({ b, live, onDone, onEdit }: { b: any; live: any; onDone: () => void; onEdit: (prefill: string) => void }) {
  const { toast } = useCtx();
  const brief = b.brief, clarify = b.decision === "clarify";
  const act = async (action: string) => { try { await api(`/v1/runs/${b.run_id}/brief`, { action }); onDone(); } catch (e: any) { toast(e.message); } };
  const Sec = ({ label, xs }: { label: string; xs: string[] }) => xs?.length ? <div className="mt8"><div className="what">{label}</div>{xs.map((x, i) => <div key={i}>• {x}</div>)}</div> : null;
  return <div className="approval">
    <div className="small muted">{clarify ? "Before I start" : `Plan v${brief.version}`}</div>
    <div style={{ fontWeight: 600, marginTop: 4 }}>{brief.goal}</div>
    {clarify ? <div className="mt8">{brief.questions.map((q: any, i: number) => <div key={i}>{i + 1}. {q.q}{q.default && <span className="muted"> (default: {q.default})</span>}</div>)}</div> : <>
      {brief.deliverable && <Sec label="Deliverable" xs={[brief.deliverable]} />}
      <Sec label="Constraints" xs={brief.constraints} /><Sec label="Assuming" xs={brief.assumptions} />
      <Sec label="Will do (each needs approval)" xs={brief.side_effects} /><Sec label="Done when" xs={brief.done_when} />
      {brief.plan?.length > 0 && <div className="mt8"><div className="what">Plan</div>{brief.plan.map((p: any, i: number) => <div key={i}>{i + 1}. {p.text}</div>)}</div>}</>}
    {live && <div className="row mt8 between"><div className="row">
        <button className="btn" onClick={() => onEdit(clarify ? "" : "Change: ")}>{clarify ? "Answer" : "Edit"}</button>
        <button className="btn ghost" onClick={() => act("cancel")}>Cancel</button></div>
      {(!clarify || brief.questions.every((q: any) => q.default)) && <button className="btn primary" onClick={() => act("go")}>{clarify ? "Use defaults" : "Go"}</button>}</div>}
  </div>;
}
function QuickStart() {
  const { ws, toast } = useCtx();
  const [list] = useApi<any[]>("/v1/agent-templates");
  const add = async (slug: string) => { try { const r = await api(`/v1/agent-templates/${slug}/install`, { workspace_id: ws }); go(`/agents/${r.agent.id}`); } catch (e: any) { toast(e.message); } };
  return <div className="card mt16"><h3>Start with an agent</h3><p className="muted small">Pick one to add in one click, or <a href="#/agents/new" style={{ textDecoration: "underline" }}>describe your own</a>.</p>
    <div className="col mt8">{list?.map((t) => <div key={t.id} className="row"><div className="avatar">{t.manifest.avatar ?? t.name[0]}</div><div className="grow"><b>{t.name}</b> <span className="muted small">{t.tagline}</span></div><button className="btn sm primary" onClick={() => add(t.slug)}>Add</button></div>)}</div></div>;
}
function WaitCard({ w, onDone }: { w: any; onDone: () => void }) {
  const resolve = async (outcome: string) => { await api(`/v1/waits/${w.id}/resolve`, { outcome }); onDone(); };
  return <div className="card"><div className="row"><span className="pill warn">{w.kind === "verify" ? "Verify" : "Action needed"}</span><b>{w.agent_name}</b></div>
    <p className="mt8">{w.reason}</p>
    {w.kind === "verify" && <div className="row"><button className="btn" onClick={() => resolve("succeeded")}>It went through</button><button className="btn" onClick={() => resolve("retry")}>It didn't — retry</button></div>}
  </div>;
}

// ---------------- Agents ----------------
function Agents() {
  const { setWs } = useCtx();
  const [ov] = useApi<any[]>("/v1/overview", 8000);
  return <>
    <div className="row between"><div><h1>Agents</h1><p className="muted">Everything your agents do, across all your workspaces.</p></div>
      <div className="row"><a className="btn" href="#/discover">Browse agents</a><a className="btn primary" href="#/agents/new">New agent</a></div></div>
    {ov?.map((w) => <div key={w.workspace.id}><h2>{w.workspace.name}</h2>
      {w.agents.length ? <div className="list">{w.agents.map((a: any) => <a key={a.id} className="item" href={`#/agents/${a.id}`} onClick={() => setWs(w.workspace.id)}>
        <div className="avatar">{a.avatar}</div>
        <div className="grow"><div><b>{a.name}</b> <span className="muted">— {a.job}</span></div>
          <div className="row wrap small mt8" style={{ gap: 4 }}>{a.deployed.map((p: string) => <span key={p} className="pill accent">{PLATFORM[p] ?? p}</span>)}
            {a.connections.map((c: any, i: number) => <span key={i} className="pill">{c.provider === "site_login" ? c.account : c.provider}</span>)}</div></div>
        <div className="small muted" style={{ textAlign: "right", minWidth: 140 }}>{a.active_runs ? <span className="pill accent">{a.active_runs} in progress</span> : <span className="row" style={{ justifyContent: "flex-end" }}><span className={`dot ${a.status === "active" ? "" : "idle"}`} />{a.status === "active" ? "Active" : "Paused"}</span>}
          <div className="mt8">{a.completed_this_month} done this month · {a.open_tasks} open</div><div>{a.memories} memories · ${a.spend_this_month}</div></div>
      </a>)}</div> : <div className="empty">No agents in this workspace yet.</div>}</div>)}
  </>;
}

function Tasks() {
  const { ws, toast } = useCtx();
  const [mine, setMine] = useState(false);
  const [tasks, reload] = useApi<any[]>(`/v1/tasks?workspace=${ws}${mine ? "&mine=1" : ""}`, 6000);
  const [work] = useApi<any>(`/v1/work?workspace=${ws}`, 6000);
  const set = async (t: any, status: string) => { try { await api(`/v1/tasks/${t.id}`, { status }, "PATCH"); reload(); } catch (e: any) { toast(e.message); } };
  return <>
    <div className="row between"><div><h1>Tasks</h1><p className="muted">What your agents and your team are tracking.</p></div>
      <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />Only mine</label></div>
    <div className="list mt16">{tasks?.length ? tasks.map((t) => <div key={t.id} className="item">
      <input type="checkbox" checked={t.status === "done"} onChange={() => set(t, t.status === "done" ? "open" : "done")} />
      <div className="grow"><span className={t.status === "done" ? "faint" : ""}>{t.title}</span><div className="small faint">{t.room_name}{t.agent ? ` · ${t.agent}` : ""}</div></div>
      {t.agent_action === "blocked" && <span className="pill">human-owned</span>}
      <span className={`pill ${t.status === "blocked" ? "bad" : t.status === "waiting" ? "warn" : t.status === "done" ? "ok" : ""}`}>{t.status}</span>
      <span className="small muted" style={{ minWidth: 80, textAlign: "right" }}>{t.owner_name ?? "—"}</span></div>) : <div className="item muted">No tasks yet.</div>}</div>
    {work?.watches?.length > 0 && <><h2>Reservation watches</h2><div className="list">{work.watches.map((w: any) => <a key={w.id} className="item" href={`#/rooms/${w.room_id}`}>
      <span className={`pill ${w.status === "booked" ? "ok" : w.status === "active" ? "accent" : ""}`}>{w.status}</span>
      <div className="grow">{w.criteria.query} · {w.criteria.dates.join(", ")} · {w.criteria.time_from}–{w.criteria.time_to} · {w.criteria.party_size} people<div className="small faint">{w.agent} · {w.checks} checks{w.auto_book ? " · auto-book on" : ""}{w.release_at ? ` · drops ${new Date(w.release_at).toLocaleString()}` : ""}</div></div></a>)}</div></>}
    {work?.reservations?.length > 0 && <><h2>Your reservations</h2><div className="list">{work.reservations.map((r: any) => <div key={r.id} className="item"><b className="grow">{r.venue}</b><span>{r.date} {r.time}</span><span className="muted">{r.party_size} people</span><span className="mono">{r.confirmation}</span></div>)}</div></>}
    {work?.orders?.length > 0 && <><h2>Group orders</h2><div className="list">{work.orders.map((o: any) => <a key={o.order_id} className="item" href={`#/rooms/${o.room_id}`}>
      <span className={`pill ${o.status === "open" ? "accent" : ""}`}>{o.status}</span><div className="grow">{o.title}<div className="small faint">{o.room_name} · organizer {o.organizer} · {o.perPerson.length} people · {o.perPerson.filter((p: any) => p.paid).length} paid</div></div>
      <span>{o.totalQty}{o.min ? `/${o.min}` : ""}</span></a>)}</div></>}
  </>;
}

function PermissionRows({ rows, onChange }: { rows: any[]; onChange?: (tool: string, mode: string) => void }) {
  return <table className="t"><tbody>{rows.map((p) => <tr key={p.tool}>
    <td>{p.description.split(".")[0]}<div className="small faint mono">{p.tool}</div></td>
    <td><span className={`pill ${p.risk === "read" ? "" : p.risk === "write_internal" ? "" : p.risk === "write_external" ? "warn" : "bad"}`}>{p.risk.replace("_", " ")}</span></td>
    <td style={{ width: 170 }}>{onChange ? <select className="input" value={p.mode} onChange={(e) => onChange(p.tool, e.target.value)}>{MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select> : MODE_LABEL[p.mode]}</td>
  </tr>)}</tbody></table>;
}

function CreateAgent() {
  const { ws, me, setWs, toast, reloadMe } = useCtx();
  const teams = me.workspaces.filter((w: any) => w.kind === "team");
  const [forWho, setForWho] = useState<string>(me.workspaces.find((w: any) => w.id === ws)?.kind === "team" ? ws : "me"), [teamName, setTeamName] = useState("");
  const [desc, setDesc] = useState(""), [draft, setDraft] = useState<any>(null), [busy, setBusy] = useState(false), [custom, setCustom] = useState(false);
  const [catalog] = useApi<any>("/v1/catalog");
  const propose = async () => { setBusy(true); try { setDraft(await api("/v1/agents/draft", { description: desc, workspace_id: ws })); } catch (e: any) { toast(e.message); } finally { setBusy(false); } };
  const create = async () => {
    setBusy(true);
    try {
      const perms = Object.fromEntries(draft.permissions.map((p: any) => [p.tool, p.mode]));
      // Who it's for decides the workspace: your personal one, an existing team, or a new team.
      let target = forWho === "me" ? me.workspaces.find((w: any) => w.kind === "personal")?.id ?? ws : forWho;
      if (forWho === "new") { const w = await api("/v1/workspaces", { name: teamName || "My team" }); target = w.id; reloadMe(); }
      const a = await api("/v1/agents", { workspace_id: target, name: draft.name, title: draft.title, job: draft.job, skills: draft.skills, permissions: perms });
      setWs(target);
      go(`/agents/${a.id}/test`);
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const toggleSkill = async (s: string) => {
    const skills = draft.skills.includes(s) ? draft.skills.filter((x: string) => x !== s) : [...draft.skills, s];
    const tools = new Set(["memory.remember", "task.create", "task.update", ...skills.flatMap((k: string) => catalog.skills.find((x: any) => x.id === k)?.tools ?? [])]);
    const perms = catalog.tools.filter((t: any) => tools.has(t.id)).map((t: any) => draft.permissions.find((p: any) => p.tool === t.id) ?? { tool: t.id, risk: t.risk, description: t.description,
      mode: t.risk === "financial" || t.risk === "destructive" ? "always_ask" : t.defaultApproval === "none" ? "auto" : t.defaultApproval === "first_time" ? "first_time" : "ask" });
    setDraft({ ...draft, skills, permissions: perms, connections: [...new Set(catalog.tools.filter((t: any) => tools.has(t.id) && t.requiresConnection).map((t: any) => t.requiresConnection))] });
  };
  return <>
    <h1>New agent</h1>
    <p className="muted">Describe the job. You can adjust everything after.</p>
    <div className="mt16"><textarea className="input hero-input" autoFocus placeholder="What do you want this agent to do?  e.g. “An executive assistant that watches my email, prepares me for meetings, helps schedule things and reminds me when people haven't replied.”" value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) propose(); }} /></div>
    <div className="row wrap mt8"><span className="small muted">For</span>
      <select className="input" style={{ width: 220 }} value={forWho} onChange={(e) => setForWho(e.target.value)}>
        <option value="me">Just me (personal)</option>{teams.map((t: any) => <option key={t.id} value={t.id}>My team: {t.name}</option>)}<option value="new">A new team…</option></select>
      {forWho === "new" && <input className="input" style={{ width: 200 }} placeholder="Team name" value={teamName} onChange={(e) => setTeamName(e.target.value)} />}</div>
    <div className="row mt8"><button className="btn primary" disabled={!desc.trim() || busy} onClick={propose}>{busy && !draft ? "Thinking…" : draft ? "Re-propose" : "Propose agent"}</button><span className="small faint">⌘↵</span></div>
    {draft && <div className="card mt16 draft">
      <div className="row gap16"><div className="avatar lg">{draft.name[0]}</div>
        {custom ? <div className="col grow"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /><input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
          : <div><h3 style={{ fontSize: 20 }}>{draft.name}</h3><div className="muted">{draft.title}</div></div>}</div>
      <h4>JOB</h4>{custom ? <textarea className="input" value={draft.job} onChange={(e) => setDraft({ ...draft, job: e.target.value })} /> : <div>{draft.job}</div>}
      <h4>SKILLS</h4>
      {(custom ? catalog?.skills ?? [] : draft.skillDetails).map((s: any) => <label key={s.id} className="check"><input type="checkbox" checked={draft.skills.includes(s.id)} disabled={!custom} onChange={() => toggleSkill(s.id)} />{s.name}</label>)}
      <h4>CONNECTIONS NEEDED</h4>{draft.connections.length ? draft.connections.map((c: string) => <div key={c} className="check">○ {c === "google" ? "Gmail + Google Calendar" : c}</div>) : <div className="muted">None</div>}
      <h4>DEFAULT PERMISSIONS</h4><PermissionRows rows={draft.permissions} onChange={custom ? (t, m) => setDraft({ ...draft, permissions: draft.permissions.map((p: any) => p.tool === t ? { ...p, mode: m } : p) }) : undefined} />
      <h4>CHANNELS</h4><div className="row wrap">{draft.channels.map((c: string) => <span key={c} className="pill">○ {PLATFORM[c]}</span>)}</div>
      <div className="row mt16"><button className="btn primary" disabled={busy || !draft.name} onClick={create}>Create &amp; test it</button><button className="btn" onClick={() => setCustom(!custom)}>{custom ? "Done customizing" : "Customize"}</button></div>
    </div>}
  </>;
}

function AgentPage({ id, tab = "overview" }: { id: string; tab?: string }) {
  const { ws, toast } = useCtx();
  const [a, reload] = useApi<any>(`/v1/agents/${id}`, 6000);
  if (!a) return null;
  const tabs = ["overview", "test", "deploy", "job", "skills", "connections", "memory", "permissions", "schedule", "activity", "settings"];
  const message = async () => { const r = await api(`/v1/agents/${id}/private-room`, {}); go(`/rooms/${r.id}`); };
  const patch = async (b: any) => { try { await api(`/v1/agents/${id}`, b, "PATCH"); toast("Saved"); reload(); } catch (e: any) { toast(e.message); } };
  return <>
    <div className="row gap16"><div className="avatar lg">{a.avatar}</div>
      <div className="grow"><h1>{a.name}</h1><div className="row small"><span className={`dot ${a.status === "active" ? "" : "idle"}`} /><span className="muted">{a.status === "active" ? "Active" : "Paused"}</span>{a.template_version && <span className="pill">v{a.template_version}</span>}</div></div>
      <button className="btn primary" onClick={message}>Message</button><AddTo agent={a} /></div>
    <div className="tabs">{tabs.map((t) => <a key={t} className={t === tab ? "on" : ""} href={`#/agents/${id}/${t}`}>{t[0].toUpperCase() + t.slice(1)}</a>)}</div>
    {tab === "overview" && <SetupChecklist a={a} onMessage={message} />}
    {tab === "overview" && <div className="grid2">
      <div className="card"><div className="small muted">What it does</div><div className="mt8">{a.job}</div></div>
      <div className="card"><div className="small muted">Where it lives</div><div className="mt8 row wrap"><span className="pill">Web</span>{a.deployed?.filter((p: string) => p !== "web").map((p: string) => <span key={p} className="pill accent">{PLATFORM[p]}</span>)}</div><a className="small mt8" style={{ display: "block", color: "var(--accent-text)" }} href={`#/agents/${a.id}/deploy`}>Deploy somewhere →</a></div>
      <div className="card"><div className="small muted">Who it works with</div><div className="mt8 col">{a.rooms.map((r: any) => <a key={r.id} href={`#/rooms/${r.id}`}>◇ {r.name}</a>)}</div></div>
      <div className="card"><div className="small muted">What it can access</div><div className="mt8 col">{a.connections.length ? a.connections.map((c: any) => <div key={c.id}>{c.provider} · {c.account} <span className="faint">({c.owner})</span></div>) : <span className="muted">No connections{a.connections_needed.length ? ` — needs ${a.connections_needed.join(", ")}` : ""}</span>}</div></div>
      <div className="card" style={{ gridColumn: "1 / -1" }}><div className="small muted">What it's doing</div>{a.active_runs.length ? a.active_runs.map((r: any) => <a key={r.id} href={`#/rooms/${r.room_id}`} className="row mt8"><Status s={r.status} /><span>{r.objective.slice(0, 100)}</span></a>) : <div className="mt8 muted">Idle</div>}</div>
    </div>}
    {tab === "job" && <JobEditor a={a} patch={patch} />}
    {tab === "skills" && <SkillsEditor a={a} patch={patch} />}
    {tab === "connections" && <AgentConnections a={a} reload={reload} />}
    {tab === "memory" && <MemoryList agent={a.id} agentName={a.name} />}
    {tab === "test" && <TestPanel a={a} />}
    {tab === "deploy" && <Deploy a={a} reload={reload} />}
    {tab === "channels" && <ChannelsEditor a={a} reload={reload} />}
    {tab === "permissions" && <div className="card"><PermissionRows rows={a.permission_table} onChange={(t, m) => patch({ permissions: { [t]: m } })} /><p className="small faint mt8">Permissions are enforced by the platform before every action. The agent can't change them.</p></div>}
    {tab === "schedule" && <div className="list">{a.schedules.length ? a.schedules.map((s: any) => <div key={s.id} className="item"><span className="pill">{s.kind}</span><span className="grow">{s.objective}</span><span className="small muted">{s.next_at ? `next ${new Date(s.next_at).toLocaleString()}` : s.spec.wake_key}</span></div>) : <div className="item muted">No schedules. Ask the agent to “remind me…” or “every morning…”.</div>}</div>}
    {tab === "activity" && <Activity agent={a.id} />}
    {tab === "settings" && <div className="card col">
      <label className="field">Before starting work<select className="input" value={a.confirm_mode ?? "smart"} onChange={(e) => patch({ confirm_mode: e.target.value })}>
        <option value="smart">Smart — ask only when unclear, multi-step, or several external actions</option><option value="always">Always show the plan and wait for “go”</option><option value="never">Never — just start (approvals still apply)</option></select></label>
      <label className="field">Model profile<select className="input" value={a.model_profile} onChange={(e) => patch({ model_profile: e.target.value })}>{["fast", "standard", "research-standard", "escalation"].map((m) => <option key={m}>{m}</option>)}</select></label>
      <div className="row"><button className="btn" onClick={() => patch({ status: a.status === "active" ? "paused" : "active" })}>{a.status === "active" ? "Pause agent" : "Resume agent"}</button>
        {a.template_id && <button className="btn" onClick={async () => { const r = await api(`/v1/agents/${id}/upgrade`, {}); toast(r.error ?? `Upgraded to ${r.version}`); reload(); }}>Upgrade to latest version</button>}</div>
    </div>}
  </>;
}
function TestPanel({ a }: { a: any }) {
  const { toast } = useCtx();
  const [room, setRoom] = useState<any>(null);
  useEffect(() => { api(`/v1/agents/${a.id}/test-room`, {}).then(setRoom).catch((e) => toast(e.message)); }, [a.id]);
  return <div>
    <div className="card" style={{ marginBottom: 12, background: "var(--warn-soft)", borderColor: "transparent" }}>
      <b>Test mode.</b> <span className="small">Plans, approvals and tools all run — but nothing leaves the platform: no emails sent, no tables booked, no posts. Accounts you haven't connected use sample data.</span></div>
    {room && <div style={{ height: "64vh", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}><Room id={room.id} /></div>}
    <div className="row mt16"><span className="muted grow">Happy with how it behaves?</span><a className="btn primary" href={`#/agents/${a.id}/deploy`}>Deploy {a.name} →</a></div>
  </div>;
}

const PLATFORM_ICON: Record<string, string> = { web: "🌐", mobile: "📱", imessage: "💬", whatsapp: "🟢", telegram: "✈️", slack: "#", email: "✉️" };
function Deploy({ a }: { a: any; reload: () => void }) {
  const { toast } = useCtx();
  const [d, reloadD] = useApi<any>(`/v1/agents/${a.id}/deploy`, 8000);
  const [codes, setCodes] = useState<Record<string, any>>({}), [chans, setChans] = useState<any[] | null>(null), [adv, setAdv] = useState(false);
  const phone = /iPhone|Android|iPad/i.test(navigator.userAgent);
  const get = async (p: string, kind: string) => {
    try { const r = await api(`/v1/agents/${a.id}/deploy/${p}`, { kind }); setCodes((c) => ({ ...c, [`${p}:${kind}`]: r })); if (phone && r.link) location.href = r.link; reloadD(); }
    catch (e: any) { toast(e.message); }
  };
  if (!d) return null;
  const T = (p: string) => d.targets.find((t: any) => t.platform === p);
  const unavailable = <div className="small muted mt8">Not configured on this platform yet. An admin can add the shared line, or use your own account under Advanced.</div>;
  return <>
    <p className="muted">One tap puts {a.name} where you already talk. Every channel reaches the same agent, memory and work.</p>
    <div className="grid2">
      <DeployCard p="web" title="Web" t={T("web")}><div className="small muted mt8">Always on.</div><div className="row mt8"><a className="btn sm" href={T("web").url.replace(/^.*#/, "#")}>Open chat</a>
        <button className="btn sm ghost" onClick={() => { navigator.clipboard?.writeText(T("web").url); toast("Link copied"); }}>Copy link</button></div></DeployCard>
      <DeployCard p="mobile" title="Phone app" t={T("mobile")}><div className="row mt8" style={{ gap: 14, alignItems: "flex-start" }}><QR value={T("mobile").url} size={112} /><div className="small muted">Scan to open {a.name} on your phone, then Share → <b>Add to Home Screen</b> for an app icon.</div></div></DeployCard>
      <DeployCard p="imessage" title="iMessage" t={T("imessage")}>{T("imessage").available ? <><div className="row wrap mt8"><button className="btn sm primary" onClick={() => get("imessage", "dm")}>Text {a.name} from my iPhone</button>
        <button className="btn sm" onClick={() => get("imessage", "group")}>Add to a group chat</button></div><CodeBox r={codes["imessage:dm"]} /><CodeBox r={codes["imessage:group"]} /></> : unavailable}</DeployCard>
      <DeployCard p="whatsapp" title="WhatsApp" t={T("whatsapp")}>{T("whatsapp").available ? <><div className="row wrap mt8"><button className="btn sm primary" onClick={() => get("whatsapp", "dm")}>Chat on WhatsApp</button></div><CodeBox r={codes["whatsapp:dm"]} /></> : unavailable}</DeployCard>
      <DeployCard p="telegram" title="Telegram" t={T("telegram")}>{T("telegram").available ? <><div className="row wrap mt8"><button className="btn sm primary" onClick={() => get("telegram", "dm")}>Open in Telegram</button>
        <button className="btn sm" onClick={() => get("telegram", "group")}>Add to a group</button></div><CodeBox r={codes["telegram:dm"]} /><CodeBox r={codes["telegram:group"]} /></> : unavailable}</DeployCard>
      <DeployCard p="slack" title="Slack" t={T("slack")}>{T("slack").available ? <div className="col mt8">
        {T("slack").installed.length ? <><div className="small muted">Installed in {T("slack").installed.map((x: any) => x.team).join(", ")}.</div>
          {chans ? <div className="col">{chans.map((c) => <div key={c.id} className="row"><span className="grow">#{c.name}</span>
            <button className="btn sm" onClick={async () => { try { await api(`/v1/agents/${a.id}/slack/channels`, { identity: c.identity, channel_id: c.id, name: c.name }); toast(`${a.name} joined #${c.name}`); reloadD(); } catch (e: any) { toast(e.message); } }}>Add</button></div>)}</div>
            : <button className="btn sm" onClick={async () => setChans(await api(`/v1/agents/${a.id}/slack/channels`))}>Pick channels…</button>}</> : null}
        <a className="btn sm primary" style={{ alignSelf: "flex-start" }} href={T("slack").install_url}>{T("slack").installed.length ? "Add to another Slack" : "Add to Slack"}</a></div> : unavailable}</DeployCard>
      <DeployCard p="email" title="Email" t={T("email")}>{T("email").available ? <div className="mt8">{T("email").address ? <div className="mono">{T("email").address}</div>
        : <button className="btn sm primary" onClick={async () => { try { await api(`/v1/agents/${a.id}/deploy/email`, {}); reloadD(); } catch (e: any) { toast(e.message); } }}>Give {a.name} an email address</button>}</div> : unavailable}</DeployCard>
    </div>
    <h2 style={{ cursor: "pointer" }} onClick={() => setAdv(!adv)}>{adv ? "▾" : "▸"} Advanced: use your own bot, number or line</h2>
    {adv && <ChannelsEditor a={a} reload={reloadD} />}
  </>;
}

// Top-level so background refreshes don't remount them (which would swap buttons out from under the user).
function DeployCard({ p, title, t, children }: { p: string; title: string; t: any; children: ReactNode }) {
  return <div className="card">
    <div className="row between"><div className="row"><span style={{ fontSize: 20 }}>{PLATFORM_ICON[p]}</span><b>{title}</b></div>
      {t.connected?.length ? <span className="pill ok">Live · {t.connected.length}</span> : t.available ? <span className="pill">Ready</span> : <span className="pill">Not set up</span>}</div>
    {children}
    {t.connected?.length ? <div className="small mt8">{t.connected.map((c: any) => <div key={c.room_id + c.conv}>✓ {c.is_group ? "Group" : "Direct"} · <a href={`#/rooms/${c.room_id}`} style={{ textDecoration: "underline" }}>{c.room}</a></div>)}</div> : null}
  </div>;
}
function CodeBox({ r }: { r: any }) {
  if (!r) return null;
  return <div className="row mt8" style={{ alignItems: "flex-start", gap: 14 }}>{r.link && <QR value={r.link} size={132} />}<div className="col" style={{ gap: 6 }}>
    <div className="small">{r.instructions}</div><div className="mono" style={{ fontSize: 14 }}>{r.message ?? r.address}</div>
    {r.link && <a className="btn sm primary" href={r.link}>Open on this device</a>}{r.link && <div className="small faint">Or scan with your phone's camera.</div>}</div></div>;
}
function SetupChecklist({ a, onMessage }: { a: any; onMessage: () => void }) {
  const { ws } = useCtx();
  const needsGoogle = a.connections_needed.includes("google");
  const items = [
    needsGoogle && { done: a.connections.some((c: any) => c.provider === "google"), label: "Connect Gmail + Google Calendar", action: <a className="btn sm" href={`/v1/connections/google/start?workspace=${ws}&agent=${a.id}`}>Connect</a> },
    a.skills.includes("reservations") && { done: a.connections.some((c: any) => c.provider === "mcp"), label: "Connect a browser runner (Browser Use) for real Resy / OpenTable bookings — until then Reese uses sandbox restaurants", action: <a className="btn sm" href="#/connections">Connect</a> },
    a.skills.includes("reservations") && { done: a.connections.some((c: any) => c.provider === "site_login"), label: "Save your Resy / OpenTable login", action: <a className="btn sm" href="#/connections">Add login</a> },
    { done: a.deployed?.some((p: string) => p !== "web"), label: `Reach ${a.name} from your phone or group chats (iMessage, WhatsApp, Slack…)`, action: <a className="btn sm" href={`#/agents/${a.id}/deploy`}>Deploy</a> },
    { done: a.completed_runs > 0, label: "Give it a first task", action: <button className="btn sm primary" onClick={onMessage}>Start</button> },
  ].filter(Boolean) as any[];
  if (items.every((i) => i.done)) return null;
  return <div className="card" style={{ marginBottom: 12 }}><div className="row between"><h3>Get {a.name} working</h3><span className="small muted">{items.filter((i) => i.done).length}/{items.length}</span></div>
    {items.map((i, k) => <div key={k} className="row mt8"><span style={{ color: i.done ? "var(--ok)" : "var(--faint)" }}>{i.done ? "✓" : "○"}</span><span className={`grow ${i.done ? "faint" : ""}`}>{i.label}</span>{!i.done && i.action}</div>)}</div>;
}
function AddTo({ agent }: { agent: any }) {
  const { ws, toast } = useCtx();
  const [open, setOpen] = useState(false);
  const [rooms] = useApi<any[]>(open ? `/v1/rooms?workspace=${ws}` : null);
  return <div style={{ position: "relative" }}><button className="btn" onClick={() => setOpen(!open)}>Add to…</button>
    {open && <div className="card" style={{ position: "absolute", right: 0, top: 36, width: 260, zIndex: 5 }}>
      {rooms?.filter((r) => r.kind === "shared").map((r) => <a key={r.id} className="row" style={{ padding: 6, cursor: "pointer" }} onClick={async () => { await api(`/v1/rooms/${r.id}/members`, { agent_id: agent.id }); toast(`Added to ${r.name}`); setOpen(false); }}>◇ {r.name}</a>)}
      <a className="row small muted" style={{ padding: 6 }} href="#/rooms">+ New room</a></div>}</div>;
}
function JobEditor({ a, patch }: any) {
  const [f, setF] = useState({ name: a.name, job: a.job, instructions: a.instructions ?? "" });
  return <div className="card col">
    <label className="field">Name<input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
    <label className="field">Job<textarea className="input" rows={2} value={f.job} onChange={(e) => setF({ ...f, job: e.target.value })} /></label>
    <label className="field">Boundaries & preferences<textarea className="input" rows={6} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></label>
    <div><button className="btn primary" onClick={() => patch(f)}>Save</button></div></div>;
}
function SkillsEditor({ a, patch }: any) {
  const [cat] = useApi<any>("/v1/catalog");
  if (!cat) return null;
  return <>{a.custom_skills.length > 0 && <><h2>Learned from your tasks</h2><div className="list">{a.custom_skills.map((s: any) => <div key={s.id} className="item">
      <div className="grow"><b>{s.name}</b><div className="small muted">{s.procedure}</div><div className="small faint mono">{s.tools.join(" → ")}</div></div>
      <button className="btn sm ghost" onClick={async () => { await api(`/v1/agents/${a.id}/custom-skills/${s.id}`, undefined, "DELETE"); patch({}); }}>Remove</button></div>)}</div><h2>Built-in skills</h2></>}
    <div className="list">{cat.skills.map((s: any) => <label key={s.id} className="item" style={{ cursor: "pointer" }}>
    <input type="checkbox" checked={a.skills.includes(s.id)} onChange={() => patch({ skills: a.skills.includes(s.id) ? a.skills.filter((x: string) => x !== s.id) : [...a.skills, s.id] })} />
    <div className="grow"><b>{s.name}</b><div className="small muted">{s.procedure}</div><div className="small faint mono">{s.tools.join(" · ")}</div></div></label>)}</div></>;
}
function AgentConnections({ a, reload }: any) {
  const { ws, toast } = useCtx();
  const [conns] = useApi<any[]>(`/v1/connections?workspace=${ws}`);
  const granted = new Set(a.connections.map((c: any) => c.id));
  return <div className="col">
    {a.connections_needed.length > 0 && <p className="muted">This agent's skills use: {a.connections_needed.join(", ")}.</p>}
    <div className="list">{conns?.length ? conns.map((c) => <div key={c.id} className="item"><div className="grow"><b>{c.label}</b> <span className="muted">{c.account}</span><div className="small faint">{c.visibility === "workspace" ? "Company connection" : `${c.owner}'s connection`}</div></div>
      {granted.has(c.id) ? <button className="btn sm" onClick={async () => { await api(`/v1/connections/${c.id}/grants/${a.id}`, undefined, "DELETE"); reload(); }}>Remove access</button>
        : <button className="btn sm primary" onClick={async () => { try { await api(`/v1/connections/${c.id}/grants`, { agent_id: a.id }); reload(); } catch (e: any) { toast(e.message); } }}>Allow</button>}</div>)
      : <div className="item muted">No connections yet.</div>}</div>
    <div><a className="btn" href={`/v1/connections/google/start?workspace=${ws}&agent=${a.id}`}>Connect Google (Gmail + Calendar)</a> <a className="btn ghost" href="#/connections">Manage connections</a></div>
  </div>;
}
const CHANNEL_FIELDS: Record<string, [string, string][]> = {
  telegram: [["secret.bot_token", "Bot token"], ["secret.webhook_secret", "Webhook secret"], ["config.username", "Bot username"]],
  slack: [["secret.bot_token", "Bot token (xoxb-…)"], ["secret.signing_secret", "Signing secret"], ["config.bot_user_id", "Bot user ID"]],
  whatsapp: [["secret.access_token", "Access token"], ["secret.app_secret", "App secret"], ["secret.verify_token", "Verify token"], ["config.phone_number_id", "Phone number ID"]],
  email: [["address", "Agent address (ava@agents.yourdomain.com)"], ["secret.resend_api_key", "Resend API key"], ["secret.webhook_secret", "Resend webhook secret (whsec_…)"]],
  imessage: [["address", "iMessage number"], ["secret.api_url", "Photon bridge URL"], ["secret.api_key", "Photon API key"], ["secret.webhook_secret", "Webhook secret"]],
  phone: [["address", "Phone number"], ["secret.auth_token", "Twilio auth token"], ["config.public_url", "Public webhook URL (for signature checks)"]],
};
function ChannelsEditor({ a, reload }: any) {
  const { toast, me } = useCtx();
  const [platform, setPlatform] = useState(""), [f, setF] = useState<Record<string, string>>({}), [code, setCode] = useState("");
  const add = async () => {
    const b: any = { platform, secret: {}, config: {} };
    for (const [k, v] of Object.entries(f)) { const [g, n] = k.split("."); if (n) b[g][n] = v; else b[g] = v; }
    try { const r = await api(`/v1/agents/${a.id}/channels`, b); toast("Channel added"); setPlatform(""); setF({}); reload(); navigator.clipboard?.writeText(r.webhook_url); } catch (e: any) { toast(e.message); }
  };
  return <div className="col">
    <div className="list"><div className="item"><span className="pill accent">Web</span><span className="grow">Always on</span></div>
      {a.channels.map((c: any) => <div key={c.id} className="item"><span className="pill accent">{PLATFORM[c.platform]}</span><div className="grow">{c.address || c.config.username || ""}<div className="small faint mono">{c.webhook_url}</div></div>
        <button className="btn sm danger" onClick={async () => { await api(`/v1/agents/${a.id}/channels/${c.id}`, undefined, "DELETE"); reload(); }}>Remove</button></div>)}</div>
    <div className="card col"><h3>Add a channel</h3>
      <select className="input" value={platform} onChange={(e) => { setPlatform(e.target.value); setF({}); }}><option value="">Choose…</option>{Object.keys(CHANNEL_FIELDS).map((p) => <option key={p} value={p}>{PLATFORM[p]}</option>)}</select>
      {platform && CHANNEL_FIELDS[platform].map(([k, l]) => <label key={k} className="field">{l}<input className="input" value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}
      {platform && <div><button className="btn primary" onClick={add}>Add {PLATFORM[platform]}</button> <span className="small faint">You'll get a webhook URL to paste into the provider.</span></div>}
    </div>
    <div className="card"><h3>Talk to {a.name} from your phone</h3><p className="muted small">Text <span className="mono">link {code || "12345678"}</span> to {a.name} on any connected channel so it knows it's you. Codes expire in 10 minutes.</p>
      <button className="btn" onClick={async () => setCode((await api("/v1/identity/link-code", {})).code)}>{code ? `Your code: ${code}` : "Get a link code"}</button>
      {me.identities.length > 0 && <div className="small muted mt8">Linked: {me.identities.map((i: any) => `${PLATFORM[i.platform]} ${i.display_name ?? i.external_user_id}`).join(", ")}</div>}</div>
  </div>;
}

// ---------------- Rooms ----------------
function Rooms() {
  const { ws, toast } = useCtx();
  const [rooms] = useApi<any[]>(`/v1/rooms?workspace=${ws}`, 5000);
  const [agents] = useApi<any[]>(`/v1/agents?workspace=${ws}`);
  const [members] = useApi<any[]>(`/v1/workspaces/${ws}/members`);
  const [f, setF] = useState<any>(null);
  const create = async () => { try { const r = await api("/v1/rooms", { workspace_id: ws, ...f }); go(`/rooms/${r.id}`); } catch (e: any) { toast(e.message); } };
  return <>
    <div className="row between"><div><h1>Rooms</h1><p className="muted">Shared context and objectives. Every channel points into a Room.</p></div><button className="btn primary" onClick={() => setF({ name: "", objective: "", agent_ids: [], member_ids: [], participation: "mention_only" })}>New room</button></div>
    {f && <div className="card col mt16">
      <input className="input" placeholder="Room name (e.g. Trip to Japan)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <input className="input" placeholder="Objective (optional)" value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} />
      <div className="small muted">Agents</div><div className="row wrap">{agents?.map((a) => <label key={a.id} className="pill"><input type="checkbox" checked={f.agent_ids.includes(a.id)} onChange={(e) => setF({ ...f, agent_ids: e.target.checked ? [...f.agent_ids, a.id] : f.agent_ids.filter((x: string) => x !== a.id) })} />{a.name}</label>)}</div>
      <div className="small muted">People</div><div className="row wrap">{members?.map((m) => <label key={m.id} className="pill"><input type="checkbox" checked={f.member_ids.includes(m.id)} onChange={(e) => setF({ ...f, member_ids: e.target.checked ? [...f.member_ids, m.id] : f.member_ids.filter((x: string) => x !== m.id) })} />{m.name}</label>)}</div>
      <label className="field">Agents participate<select className="input" value={f.participation} onChange={(e) => setF({ ...f, participation: e.target.value })}><option value="mention_only">Only when mentioned</option><option value="relevant">When relevant</option><option value="manager">Proactively (manages the objective)</option></select></label>
      <div className="row"><button className="btn primary" disabled={!f.name} onClick={create}>Create room</button><button className="btn" onClick={() => setF(null)}>Cancel</button></div></div>}
    <div className="list mt16">{rooms?.length ? rooms.map((r) => <a key={r.id} className="item" href={`#/rooms/${r.id}`}>
      <div className="avatar human">{r.kind === "private" ? "◉" : "◇"}</div>
      <div className="grow"><b>{r.name}</b>{r.objective && <span className="muted"> — {r.objective}</span>}<div className="small faint">{r.humans} {r.humans === 1 ? "person" : "people"} · {r.agents} AI{r.last_ts ? ` · ${ago(r.last_ts)}` : ""}</div></div>
      {r.pending > 0 && <span className="pill warn">{r.pending} approval{r.pending > 1 ? "s" : ""}</span>}</a>) : <div className="item muted">No rooms yet.</div>}</div>
  </>;
}

function Room({ id }: { id: string }) {
  const { me, toast } = useCtx();
  const [data, setData] = useState<any>(null), [events, setEvents] = useState<any[]>([]), [text, setText] = useState(""), [trace, setTrace] = useState<string | null>(null);
  const after = useRef(0), tl = useRef<HTMLDivElement>(null), box = useRef<HTMLTextAreaElement>(null);
  const edit = (prefill: string) => { setText(prefill); setTimeout(() => box.current?.focus(), 0); };
  const load = useCallback(async () => {
    try {
      const d = await api(`/v1/rooms/${id}?after=${after.current}`);
      if (d.events.length) { after.current = d.events.at(-1).seq; setEvents((e) => [...e, ...d.events]); setTimeout(() => tl.current?.scrollTo(0, 1e9), 30); }
      setData(d);
    } catch (e: any) { toast(e.message); }
  }, [id]);
  useEffect(() => { after.current = 0; setEvents([]); load(); const t = setInterval(load, 1500); return () => clearInterval(t); }, [id]);
  if (!data) return null;
  const send = async () => { if (!text.trim()) return; const t = text; setText(""); try { await api(`/v1/rooms/${id}/messages`, { text: t }); load(); } catch (e: any) { toast(e.message); setText(t); } };
  const humans = data.members.filter((m: any) => m.kind === "human"), agents = data.members.filter((m: any) => m.kind === "agent");
  const approvalsById = Object.fromEntries(data.approvals.map((a: any) => [a.id, a]));
  const shown = events.filter((e) => e.type === "message" || ["APPROVAL_GRANTED", "APPROVAL_REJECTED", "BRIEF_CONFIRMED", "BRIEF_REVISED", "MEMBER_JOINED", "DELEGATION_CREATED", "TASK_CREATED", "RUN_FAILED", "ENDPOINT_LINKED"].includes(e.type));
  return <div className="room">
    <div className="convo">
      <div className="room-head"><div className="grow"><h3>{data.room.name}</h3><div className="small muted">{humans.length} {humans.length === 1 ? "person" : "people"} · {agents.length} AI{data.room.objective ? ` · ${data.room.objective}` : ""}</div></div>
        <div className="row small">{data.endpoints.map((e: any) => <span key={e.id} className="pill">{PLATFORM[e.platform]}</span>)}<span className="pill">Web</span></div>
        {data.room.kind === "shared" && <select className="input" style={{ width: 170 }} value={data.room.participation} onChange={async (e) => { await api(`/v1/rooms/${id}`, { participation: e.target.value }, "PATCH"); load(); }}>
          <option value="mention_only">Agents: when mentioned</option><option value="relevant">Agents: when relevant</option><option value="manager">Agents: proactive</option></select>}</div>
      <div className="timeline" ref={tl}>
        {!shown.length && <div className="sys">This is the start of {data.room.name}. Everything said here, or in any linked channel, is shared context.</div>}
        {shown.map((e) => {
          if (e.type !== "message") return <div key={e.seq} className="sys">{sysText(e)}</div>;
          const isAgent = e.actor?.startsWith("agt_"), mine = e.actor === me.user.id;
          const apr = e.data.approval_id && approvalsById[e.data.approval_id];
          return <div key={e.seq} className={`msg ${isAgent ? "agent" : ""}`}>
            <div className={`avatar ${isAgent ? "" : "human"}`}>{e.actor_name?.[0] ?? "?"}</div>
            <div className="body"><div className="who">{mine ? "You" : e.actor_name}{e.data.platform && e.data.platform !== "web" && <span className="pill">via {PLATFORM[e.data.platform]}</span>}<span className="faint small" style={{ fontWeight: 400 }}>{ago(e.ts)}</span>
              {isAgent && e.run_id && <a className="small faint" style={{ fontWeight: 400, cursor: "pointer" }} onClick={() => setTrace(e.id)}>Why?</a>}</div>
              {apr ? <ApprovalCard a={{ ...apr, room_name: null }} onDone={load} />
                : e.data.brief ? <BriefCard b={e.data.brief} onDone={load} onEdit={edit}
                    live={data.runs.find((r: any) => r.id === e.data.brief.run_id && ["proposed", "clarifying"].includes(r.brief_status) && r.brief?.version === e.data.brief.brief.version)} />
                : <><div className="text">{fileLinks(e.data.text)}</div>
                  {e.data.buttons?.length > 0 && isAgent && <div className="row mt8">{e.data.buttons.map((b: any) => <button key={b.data} className="btn sm"
                    onClick={async () => { try { await api(`/v1/rooms/${id}/buttons`, { data: b.data }); load(); } catch (x: any) { toast(x.message); } }}>{b.label}</button>)}</div>}</>}
            </div></div>;
        })}
      </div>
      {data.starters?.length > 0 && events.filter((e) => e.type === "message").length < 4 && <div className="row wrap" style={{ padding: "8px 16px 0", gap: 6 }}>
        <span className="small faint">Try:</span>{data.starters.map((s: string) => <button key={s} className="pill" style={{ cursor: "pointer", border: 0 }} onClick={() => edit(s.replace(/…/g, "").replace(/\s+/g, " ").trim() + (s.includes("…") ? " " : ""))}>{s}</button>)}</div>}
      {data.runs.some((r: any) => ["queued", "running", "retrying"].includes(r.status)) && <div className="small muted" style={{ padding: "4px 20px" }}>
        {data.runs.filter((r: any) => ["queued", "running", "retrying"].includes(r.status)).map((r: any) => r.agent_name).join(", ")} is working…</div>}
      <div className="composer"><label className="btn ghost" title="Attach a file" style={{ alignSelf: "center" }}>📎<input type="file" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; if (!f) return;
          const fd = new FormData(); fd.append("file", f); fd.append("text", text); setText("");
          const r = await fetch(`/v1/rooms/${id}/files`, { method: "POST", body: fd }); if (!r.ok) toast((await r.json()).error ?? "upload failed"); load(); e.target.value = ""; }} /></label>
        <textarea ref={box} className="input" placeholder={agents.length > 1 || data.room.participation === "mention_only" && data.room.kind === "shared" ? `Message everyone… (mention ${agents.map((a: any) => "@" + a.name).join(", ")} to ask an agent)` : "Message…"} value={text}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} /><button className="btn primary" onClick={send}>Send</button></div>
    </div>
    <aside className="side">
      <h2>Current work</h2>
      {data.runs.length === 0 && data.tasks.filter((t: any) => t.status !== "done").length === 0 && <div className="small faint">Nothing in progress.</div>}
      {data.runs.map((r: any) => <div key={r.id} className="work"><div className="row between"><b>{r.agent_name}</b><Status s={r.status} /></div><div className="small mt8">{(r.brief?.goal ?? r.objective).slice(0, 120)}</div>
        {r.brief?.plan?.length > 0 && <div className="small mt8">{r.brief.plan.map((p: any, i: number) => <div key={i} className={p.status === "done" ? "faint" : ""}>{p.status === "done" ? "✓" : p.status === "skipped" ? "–" : "○"} {p.text}</div>)}</div>}
        {r.waits.map((w: any, i: number) => <div key={i} className="small muted mt8">⏸ {w.reason}{w.owner_name ? ` · Owner: ${w.owner_name}` : ""}</div>)}
        <div className="row mt8"><a className="small faint" style={{ cursor: "pointer" }} onClick={() => setTrace(r.id)}>Trace</a><a className="small faint" style={{ cursor: "pointer" }} onClick={async () => { await api(`/v1/runs/${r.id}/cancel`, {}); load(); }}>Cancel</a></div></div>)}
      {data.tasks.filter((t: any) => t.status !== "done").map((t: any) => <div key={t.id} className="work">
        <div className="row between"><b>{t.title}</b><span className={`pill ${t.status === "blocked" ? "bad" : t.status === "waiting" ? "warn" : ""}`}>{t.status}</span></div>
        <div className="small muted mt8">Owner: {t.owner_name ?? "—"}{t.agent_action === "blocked" && <span className="pill bad" style={{ marginLeft: 6 }}>agent hands off</span>}</div>
        <div className="row mt8"><a className="small faint" style={{ cursor: "pointer" }} onClick={async () => { await api(`/v1/tasks/${t.id}`, { status: "done" }, "PATCH"); load(); }}>Mark done</a>
          {t.status !== "blocked" && <a className="small faint" style={{ cursor: "pointer" }} onClick={async () => { await api(`/v1/tasks/${t.id}`, { status: "blocked" }, "PATCH"); load(); }}>Blocked</a>}</div></div>)}
      <h2>Approvals {data.approvals.length > 0 && <span className="pill warn">{data.approvals.length}</span>}</h2>
      {data.approvals.length ? data.approvals.map((a: any) => <div key={a.id} className="work"><b>{a.agent_name}</b>: {a.summary}<div className="small muted mt8">Waiting on {a.approvers.map((x: any) => x.name).join(" or ")}</div></div>) : <div className="small faint">None pending.</div>}
      <h2>People & agents</h2>
      {data.members.map((m: any) => <div key={m.principal_id} className="row small" style={{ padding: "3px 0" }}><div className={`avatar ${m.kind === "agent" ? "" : "human"}`} style={{ width: 22, height: 22, fontSize: 11 }}>{m.name?.[0]}</div>{m.name}{m.role && <span className="faint">· {m.role}</span>}</div>)}
      <AddPeople room={data.room} onDone={load} />
    </aside>
    {trace && <Trace id={trace} onClose={() => setTrace(null)} />}
  </div>;
}
function fileLinks(text: string) {
  const parts = text.split(/(📎 [^\n]+ \(file_id: fil_\w+\))/);
  return parts.map((p, i) => { const m = p.match(/^📎 (.+) \(file_id: (fil_\w+)\)$/); return m ? <a key={i} className="pill accent" href={`/v1/files/${m[2]}`}>📎 {m[1]}</a> : p; });
}
function sysText(e: any) {
  const d = e.data;
  switch (e.type) {
    case "APPROVAL_GRANTED": return `✓ ${e.actor_name} approved`;
    case "APPROVAL_REJECTED": return `✕ ${e.actor_name} rejected`;
    case "MEMBER_JOINED": return `${e.actor_name} joined`;
    case "TASK_CREATED": return `Task: ${d.title}`;
    case "RUN_FAILED": return `Run failed: ${d.reason}`;
    case "BRIEF_CONFIRMED": return `✓ ${e.actor_name} confirmed the plan`;
    case "BRIEF_REVISED": return `${e.actor_name} changed the request`;
    case "ENDPOINT_LINKED": return `Linked ${PLATFORM[d.platform] ?? d.platform} conversation`;
    default: return e.type;
  }
}
function AddPeople({ room, onDone }: any) {
  const { ws, toast } = useCtx();
  const [open, setOpen] = useState(false);
  const [members] = useApi<any[]>(open ? `/v1/workspaces/${ws}/members` : null);
  const [agents] = useApi<any[]>(open ? `/v1/agents?workspace=${ws}` : null);
  if (room.kind !== "shared") return null;
  const add = async (b: any) => { try { await api(`/v1/rooms/${room.id}/members`, b); onDone(); } catch (e: any) { toast(e.message); } };
  return <div className="mt8">{open ? <div className="col">{members?.map((m) => <a key={m.id} className="small" style={{ cursor: "pointer" }} onClick={() => add({ user_id: m.id })}>+ {m.name}</a>)}
    {agents?.map((a) => <a key={a.id} className="small" style={{ cursor: "pointer" }} onClick={() => add({ agent_id: a.id })}>+ {a.name} (agent)</a>)}</div>
    : <button className="btn sm" onClick={() => setOpen(true)}>Invite people or agents</button>}</div>;
}

function Trace({ id, onClose }: { id: string; onClose: () => void }) {
  const [t, , err] = useApi<any>(`/v1/trace/${id}`);
  const label = (s: any) => {
    const d = s.data;
    switch (s.type) {
      case "RUN_STARTED": return ["Run started", `${d.objective}`, ""];
      case "BRIEF_PROPOSED": return ["Brief", `${d.brief.goal} → ${d.decision}${d.diff?.length ? ` (${d.diff.join("; ")})` : ""}`, d.decision === "auto" || d.decision === "skip" ? "ok" : "warn"];
      case "BRIEF_CONFIRMED": return ["Plan confirmed", `by ${s.actor_name}`, "ok"];
      case "BRIEF_REVISED": return ["Requirement changed", d.text, "warn"];
      case "RESULT_CHECKED": return ["Result check", d.pass ? "all success criteria met" : `missing: ${d.missing.join("; ")}`, d.pass ? "ok" : "warn"];
      case "PLAN_UPDATED": return ["Plan updated", d.plan.map((p: any) => `${p.status === "done" ? "✓" : "○"} ${p.text}`).join(" · "), ""];
      case "MODEL_CALL": return ["Model call", `${d.model}${d.tool_calls.length ? ` → proposed ${d.tool_calls.join(", ")}` : " → answered"}${d.cost_usd ? ` · $${d.cost_usd.toFixed(4)}` : ""}`, ""];
      case "TOOL_CALL_REQUESTED": return ["Tool proposed", `${d.tool} ${JSON.stringify(d.input).slice(0, 160)}`, ""];
      case "PERMISSION_DECISION": return ["Permission", `${d.decision} — ${d.reason}`, d.decision === "ALLOW" ? "ok" : d.decision === "DENY" ? "bad" : "warn"];
      case "APPROVAL_REQUESTED": return ["Approval requested", `${d.summary} — ${d.reason}`, "warn"];
      case "APPROVAL_GRANTED": return ["Approved", `by ${s.actor_name}`, "ok"];
      case "APPROVAL_REJECTED": return ["Rejected", `by ${s.actor_name}`, "bad"];
      case "TOOL_CALL_COMPLETED": return ["Tool executed", `${d.tool} → ${d.status}${d.connection_account ? ` using ${d.connection_account}` : ""}`, "ok"];
      case "TOOL_CALL_FAILED": return ["Tool failed", `${d.tool}: ${d.error_kind} — ${d.error}`, "bad"];
      case "RUN_WAITING": return ["Waiting", d.reason, "warn"];
      case "RUN_RESUMED": return ["Resumed", d.kind, ""];
      case "DELEGATION_CREATED": return ["Delegated", d.objective, ""];
      case "RUN_COMPLETED": return ["Completed", d.text, "ok"];
      case "RUN_FAILED": return ["Failed", d.reason, "bad"];
      case "message": return ["Sent to room", d.text?.slice(0, 200), ""];
      default: return [s.type, JSON.stringify(d).slice(0, 160), ""];
    }
  };
  return <><div className="drawer-bg" onClick={onClose} /><div className="drawer">
    <div className="row between"><h1>Why?</h1><button className="btn ghost" onClick={onClose}>✕</button></div>
    {err && <div className="muted">{err}</div>}
    {t && <><p className="muted">{t.agent} ran this {t.trigger ? <>because <b>{t.trigger.by}</b> said “{t.trigger.text}”{t.trigger.platform !== "web" ? ` via ${PLATFORM[t.trigger.platform]}` : ""}</> : t.run.kind === "schedule" ? "on a schedule" : `for ${t.requested_by ?? "the room"}`}.</p>
      <div className="row small muted"><Status s={t.run.status} /> · {t.run.spent.modelCalls} model calls · {t.run.spent.toolCalls} tool calls · ${(t.run.spent.cost ?? 0).toFixed(4)}</div>
      <div className="mt16">{t.steps.map((s: any) => { const [h, d, c] = label(s); return <div key={s.seq} className={`step ${c}`}><b className="small">{h}</b><div className="small muted">{d}</div></div>; })}</div>
      <div className="mt16"><a className="btn sm" href={`/v1/runs/${t.run.id}/eval-case`} download={`case-${t.run.id}.json`}>Save as eval case</a></div>
      {t.children.length > 0 && <><h2>Delegated</h2>{t.children.map((c: any) => <div key={c.id} className="small">{c.agent}: {c.objective} — <Status s={c.status} /></div>)}</>}</>}
  </div></>;
}

// ---------------- Discover ----------------
function Discover({ route, anonymous }: { route: string; anonymous?: boolean }) {
  const slug = route.split("/")[2];
  const [list] = useApi<any[]>(slug ? null : "/v1/agent-templates");
  if (slug) return <TemplatePage slug={slug} anonymous={anonymous} />;
  return <>
    <h1>Discover</h1><p className="muted">A small set of agents that are genuinely useful. Try one before you add it.</p>
    <h2>Featured</h2>
    <div className="list">{list?.map((t) => <div key={t.id} className="item"><div className="avatar">{t.manifest.avatar ?? t.name[0]}</div>
      <div className="grow"><b>{t.name} — {t.manifest.title}</b><div className="muted small">{t.tagline}</div><div className="small faint">by {t.publisher}{t.installs ? ` · ${t.installs} installs` : ""}{t.rating ? ` · ★ ${t.rating.toFixed(1)}` : ""}</div></div>
      <a className="btn" href={`#/discover/${t.slug}`}>Try</a>{!anonymous && <a className="btn primary" href={`#/discover/${t.slug}?add=1`}>Add agent</a>}</div>)}</div>
    {anonymous && <p className="mt16"><a className="btn" href="#/">Sign in</a></p>}
  </>;
}
function TemplatePage({ slug, anonymous }: { slug: string; anonymous?: boolean }) {
  const ctx = useContext(Ctx);
  const [t] = useApi<any>(`/v1/agent-templates/${slug.split("?")[0]}`);
  const [trial, setTrial] = useState<any>({ messages: [] }), [q, setQ] = useState(""), [busy, setBusy] = useState(false), [answers, setAnswers] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(location.hash.includes("add=1"));
  if (!t) return null;
  const m = t.manifest;
  const ask = async () => { if (!q.trim()) return; setBusy(true); try { setTrial(await api(`/v1/agent-templates/${t.slug}/trial`, { text: q, trial_id: trial.trial_id })); setQ(""); } finally { setBusy(false); } };
  const install = async () => { try { const r = await api(`/v1/agent-templates/${t.slug}/install`, { workspace_id: ctx!.ws, answers }); go(`/agents/${r.agent.id}/connections`); } catch (e: any) { ctx!.toast(e.message); } };
  const fork = async () => { try { const r = await api(`/v1/agent-templates/${t.slug}/fork`, {}); ctx!.toast(`Forked as ${r.manifest.slug} (draft)`); } catch (e: any) { ctx!.toast(e.message); } };
  return <>
    <a className="small muted" href="#/discover">← Discover</a>
    <div className="row gap16 mt16"><div className="avatar lg">{m.avatar ?? m.name[0]}</div><div className="grow"><h1>{m.name}</h1><div className="muted">{m.title} · by {t.publisher} · v{t.latest_version}</div></div>
      {!anonymous && <><button className="btn" onClick={fork}>Fork / Customize</button><button className="btn primary" onClick={() => setAdding(true)}>Add agent</button></>}</div>
    <p className="mt16">{m.job}</p>
    {adding && !anonymous && <div className="card col mt16"><h3>Add {m.name}</h3>
      {(m.onboarding ?? []).map((o: any) => <label key={o.id} className="field">{o.question}<input className="input" value={answers[o.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [o.id]: e.target.value })} /></label>)}
      <div className="small muted">Needs: {t.connections.length ? t.connections.map((c: string) => c === "google" ? "Gmail + Google Calendar" : c).join(", ") : "no account access"}</div>
      <div><button className="btn primary" onClick={install}>Add to workspace</button></div></div>}
    <h2>Try {m.name}</h2>
    <div className="card">
      <div className="col">{trial.messages.map((x: any, i: number) => <div key={i} className={`msg ${x.from === "you" ? "" : "agent"}`}><div className={`avatar ${x.from === "you" ? "human" : ""}`}>{x.from[0].toUpperCase()}</div><div className="body"><div className="who">{x.from === "you" ? "You" : x.from}</div><div className="text">{x.text}</div></div></div>)}
        {!trial.messages.length && <div className="muted">Ask {m.name} anything — no account needed.</div>}</div>
      {trial.upsell && <div className="approval mt16"><b>{m.name} can keep this going for you.</b><div className="small muted">Add {m.name} to: Telegram · iMessage · Slack · Web</div>{anonymous ? <a className="btn primary mt8" href="#/">Create an account</a> : <button className="btn primary mt8" onClick={() => setAdding(true)}>Add {m.name}</button>}</div>}
      {trial.limit_reached ? <div className="pill warn mt16">Trial limit reached — create an account to continue.</div> :
        <div className="row mt16"><input className="input" placeholder={`Ask ${m.name}…`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} /><button className="btn primary" disabled={busy} onClick={ask}>{busy ? "…" : "Ask"}</button></div>}
    </div>
    <h2>Skills</h2><div className="grid2">{t.skills.map((s: any) => <div key={s.id} className="card"><b>{s.name}</b><div className="small muted mt8">{s.procedure}</div></div>)}</div>
    <h2>Permissions</h2><div className="card"><PermissionRows rows={t.permissions} /></div>
    <h2>Declared</h2><div className="card small col"><div>Network: {(m.network ?? []).join(", ") || "none"}</div><div>Channels: {(m.channels ?? []).map((c: string) => PLATFORM[c]).join(", ")}</div><div>Evals: {(m.evals ?? []).join(", ")}</div>
      {m.escalation && <div>Escalation: {m.escalation.join(" ")}</div>}</div>
    {t.reviews.length > 0 && <><h2>Reviews</h2>{t.reviews.map((r: any, i: number) => <div key={i} className="card">{"★".repeat(r.rating)} <span className="muted">{r.name}</span><div>{r.text}</div></div>)}</>}
  </>;
}

// ---------------- Connections ----------------
function Connections() {
  const { ws, me, toast } = useCtx();
  const [conns, reload] = useApi<any[]>(`/v1/connections?workspace=${ws}`);
  const [sel, setSel] = useState<string | null>(null), [dev, setDev] = useState<any>(null), [form, setForm] = useState<any>(null);
  const mine = conns?.filter((c) => c.visibility === "private") ?? [], company = conns?.filter((c) => c.visibility === "workspace") ?? [];
  const addDev = async () => { try { await api("/v1/connections", { workspace_id: ws, provider: dev.provider, account: dev.account, visibility: dev.visibility, credentials: { access_token: dev.token } }); setDev(null); reload(); } catch (e: any) { toast(e.message); } };
  const Row = (c: any) => <a key={c.id} className="item" style={{ cursor: "pointer" }} onClick={() => setSel(c.id)}><span className="pill">{c.provider === "mcp" ? `MCP · ${c.tool_count ?? 0} tools` : c.provider === "site_login" ? "site login" : c.provider}</span><b className="grow">{c.label}</b><span className="muted">{c.visibility === "workspace" ? "Company" : c.owner}</span><span className="muted">{c.account}</span>
    <span className={`pill ${c.status === "active" ? "ok" : "warn"}`}>{c.status === "active" ? "Connected" : "Reconnect"}</span></a>;
  return <>
    <div className="row between"><div><h1>Connections</h1><p className="muted">Access to your tools. Each connection has one owner; agents only use what they've been allowed.</p></div>
      <div className="row wrap"><a className="btn primary" href={`/v1/connections/google/start?workspace=${ws}`}>Connect Google</a>
        <button className="btn" onClick={() => setForm({ kind: "mcp", preset: "browserbase", url: MCP_PRESETS.browserbase.url, headers: MCP_PRESETS.browserbase.headers, label: "Browserbase", agents: [] })}>Add MCP server</button>
        <button className="btn" onClick={() => setForm({ kind: "site", site: "resy.com", username: "", password: "", agents: [] })}>Add site login</button>
        <button className="btn ghost" onClick={() => setDev({ provider: "google", account: me.user.email, token: "", visibility: "private" })}>Add token</button></div></div>
    {form && <ConnectForm form={form} setForm={setForm} onDone={() => { setForm(null); reload(); }} />}
    {dev && <div className="card col mt16"><div className="small muted">Paste an OAuth access token (e.g. from the Google OAuth Playground) — useful in development.</div>
      <input className="input" placeholder="Account (email)" value={dev.account} onChange={(e) => setDev({ ...dev, account: e.target.value })} />
      <input className="input" placeholder="Access token" value={dev.token} onChange={(e) => setDev({ ...dev, token: e.target.value })} />
      <select className="input" value={dev.visibility} onChange={(e) => setDev({ ...dev, visibility: e.target.value })}><option value="private">Only me</option><option value="workspace">Whole workspace (admins)</option></select>
      <div className="row"><button className="btn primary" onClick={addDev}>Save</button><button className="btn" onClick={() => setDev(null)}>Cancel</button></div></div>}
    <h2>Your connections</h2><div className="list">{mine.length ? mine.map(Row) : <div className="item muted">None yet.</div>}</div>
    <h2>Company connections</h2><div className="list">{company.length ? company.map(Row) : <div className="item muted">None yet.</div>}</div>
    {sel && <ConnectionDrawer id={sel} onClose={() => { setSel(null); reload(); }} />}
  </>;
}
// Hosted endpoints verified Oct 2026 (Browserbase, Browserless). Browser Use: run its MCP server and paste that URL.
const MCP_PRESETS: Record<string, { label: string; url: string; headers: string }> = {
  browserbase: { label: "Browserbase / Stagehand (hosted)", url: "https://mcp.browserbase.com/mcp", headers: "Authorization: Bearer " },
  browserless: { label: "Browserless (hosted)", url: "https://mcp.browserless.io/mcp", headers: "Authorization: Bearer " },
  "browser-use": { label: "Browser Use (your MCP server)", url: "https://your-browser-use-mcp-host/mcp", headers: "X-Browser-Use-API-Key: " },
  custom: { label: "Any MCP server", url: "https://", headers: "Authorization: Bearer " },
};
function ConnectForm({ form, setForm, onDone }: { form: any; setForm: (f: any) => void; onDone: () => void }) {
  const { ws, toast } = useCtx();
  const [agents] = useApi<any[]>(`/v1/agents?workspace=${ws}`);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = form.kind === "mcp"
        ? await api("/v1/connections", { workspace_id: ws, provider: "mcp", url: form.url, headers: form.headers, label: form.label, agent_ids: form.agents, visibility: form.visibility ?? "private" })
        : await api("/v1/connections", { workspace_id: ws, provider: "site_login", site: form.site, username: form.username, password: form.password, agent_ids: form.agents });
      toast(form.kind === "mcp" ? `Connected — ${r.tools?.length ?? 0} tools found` : "Login saved"); onDone();
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const F = (k: string, v: any) => setForm({ ...form, [k]: v });
  return <div className="card col mt16">
    {form.kind === "mcp" ? <>
      <h3>Add an MCP server</h3><p className="small muted">Its tools become available to the agents you pick, with the same approvals and audit as built-in tools. Browser agents (Browser Use, Browserbase) power browser tasks like booking.</p>
      <select className="input" value={form.preset} onChange={(e) => setForm({ ...form, preset: e.target.value, url: MCP_PRESETS[e.target.value].url, headers: MCP_PRESETS[e.target.value].headers, label: MCP_PRESETS[e.target.value].label.split(" (")[0] })}>
        {Object.entries(MCP_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select>
      <label className="field">Server URL<input className="input" value={form.url} onChange={(e) => F("url", e.target.value)} /></label>
      <label className="field">Auth header (stored encrypted)<input className="input mono" value={form.headers} onChange={(e) => F("headers", e.target.value)} /></label>
      <label className="field">Name<input className="input" value={form.label} onChange={(e) => F("label", e.target.value)} /></label>
    </> : <>
      <h3>Add a website login</h3><p className="small muted">For sites without an API (OpenTable, Resy…). Used only by the browser runner when an agent acts on that site — the agent itself never sees it.</p>
      <select className="input" value={["resy.com", "opentable.com"].includes(form.site) ? form.site : "other"} onChange={(e) => F("site", e.target.value === "other" ? "" : e.target.value)}>
        <option value="resy.com">Resy</option><option value="opentable.com">OpenTable</option><option value="other">Other site…</option></select>
      {!["resy.com", "opentable.com"].includes(form.site) && <input className="input" placeholder="example.com" value={form.site} onChange={(e) => F("site", e.target.value)} />}
      <input className="input" placeholder="Username or email" value={form.username} onChange={(e) => F("username", e.target.value)} />
      <input className="input" type="password" placeholder="Password" value={form.password} onChange={(e) => F("password", e.target.value)} />
    </>}
    <div className="small muted">Agents that can use it</div>
    <div className="row wrap">{agents?.map((a) => <label key={a.id} className="pill"><input type="checkbox" checked={form.agents.includes(a.id)} onChange={(e) => F("agents", e.target.checked ? [...form.agents, a.id] : form.agents.filter((x: string) => x !== a.id))} />{a.name}</label>)}</div>
    <div className="row"><button className="btn primary" disabled={busy} onClick={save}>{busy ? "Connecting…" : "Save"}</button><button className="btn" onClick={() => setForm(null)}>Cancel</button></div>
  </div>;
}
function ConnectionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { ws } = useCtx();
  const [c, reload] = useApi<any>(`/v1/connections/${id}`);
  if (!c) return null;
  return <><div className="drawer-bg" onClick={onClose} /><div className="drawer">
    <div className="row between"><h1>{c.label}</h1><button className="btn ghost" onClick={onClose}>✕</button></div>
    <p className="muted">{c.account} · owned by {c.owner} · {c.visibility === "workspace" ? "shared with the workspace" : "private"}</p>
    {c.provider === "mcp" ? <><div className="small muted">Server: <span className="mono">{c.config.url}</span></div>
      <h2>Tools <button className="btn sm" onClick={async () => { await api(`/v1/connections/${id}/refresh`, {}); reload(); }}>Refresh</button></h2>
      {(c.config.tools ?? []).map((t: any) => <div key={t.name} className="row small" style={{ padding: "3px 0" }}><span className={`pill ${t.risk === "read" ? "" : t.risk === "destructive" ? "bad" : "warn"}`}>{t.risk.replace("_", " ")}</span><span className="mono">{t.name}</span><span className="faint grow">{t.description?.slice(0, 80)}</span></div>)}</>
      : c.provider === "site_login" ? <div className="small muted">Site: <span className="mono">{c.config.site}</span> · password stored encrypted, never shown to agents</div>
      : <div className="small muted">Scopes: <span className="mono">{c.scopes ?? "—"}</span></div>}<div className="small muted">Last used: {c.last_used_at ? ago(c.last_used_at) : "never"}</div>
    <h2>Agents with access</h2>{c.agents.length ? c.agents.map((a: any) => <div key={a.id} className="row between" style={{ padding: "4px 0" }}><span>{a.name}</span><button className="btn sm" onClick={async () => { await api(`/v1/connections/${id}/grants/${a.id}`, undefined, "DELETE"); reload(); }}>Remove</button></div>) : <div className="muted small">None</div>}
    <h2>Audit trail</h2>{c.audit.length ? c.audit.map((e: any, i: number) => <div key={i} className="small" style={{ padding: "3px 0" }}>{ago(e.ts)} · {e.agent} · <span className="mono">{e.tool}</span> · {e.status}</div>) : <div className="muted small">No activity yet.</div>}
    <div className="row mt16">{c.status !== "active" && <a className="btn" href={`/v1/connections/google/start?workspace=${ws}&reconnect=${c.id}`}>Reconnect</a>}
      <button className="btn danger" onClick={async () => { if (confirm("Revoke this connection? Agents lose access immediately.")) { await api(`/v1/connections/${id}/revoke`, {}); onClose(); } }}>Revoke</button></div>
  </div></>;
}

// ---------------- Memory ----------------
function MemoryList({ agent, agentName }: { agent?: string; agentName?: string }) {
  const { ws, toast } = useCtx();
  const [mem, reload] = useApi<any[]>(`/v1/memory?workspace=${ws}${agent ? `&agent=${agent}` : ""}`);
  const [text, setText] = useState(""), [scope, setScope] = useState(agent ? "agent" : "user_private");
  const save = async () => { try { await api("/v1/memory", { workspace_id: ws, text, scope, agent_id: agent }); setText(""); reload(); } catch (e: any) { toast(e.message); } };
  return <div className="col">
    <div className="row"><select className="input" style={{ width: 210 }} value={scope} onChange={(e) => setScope(e.target.value)}>
        {agent && <option value="agent">Only {agentName} knows this</option>}<option value="user_private">About me (all my agents, private)</option><option value="workspace">Whole workspace (shared)</option></select>
      <input className="input" placeholder={scope === "agent" ? `Teach ${agentName} something…` : scope === "user_private" ? "Something all your agents should know about you…" : "Something the whole team should know…"} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text && save()} />
      <button className="btn" disabled={!text} onClick={save}>Save</button></div>
    <div className="list">{mem?.length ? mem.map((m) => <div key={m.id} className="item"><span className={`pill ${m.scope_type === "user_private" ? "warn" : m.scope_type === "workspace" ? "accent" : ""}`}>{m.scope_type === "user_private" ? "private" : m.scope_type}{m.scope_name ? `: ${m.scope_name}` : ""}</span>
      <div className="grow">{m.text}<div className="small faint">{m.kind} · confidence {m.confidence} · {m.source_event_ids.length} source{m.source_event_ids.length === 1 ? "" : "s"} · {ago(m.created_at)}</div></div>
      <button className="btn sm ghost" onClick={async () => { await api(`/v1/memory/${m.id}`, undefined, "DELETE"); reload(); }}>Forget</button></div>) : <div className="item muted">Nothing remembered yet.</div>}</div>
  </div>;
}

// ---------------- Activity ----------------
function Activity({ agent }: { agent?: string }) {
  const { ws } = useCtx();
  const [ev] = useApi<any[]>(`/v1/activity?workspace=${ws}${agent ? `&agent=${agent}` : ""}`, 5000);
  const [trace, setTrace] = useState<string | null>(null);
  return <>
    {!agent && <div className="row between"><div><h1>Activity</h1><p className="muted">Every meaningful action, append-only.</p></div><a className="btn" href={`/v1/audit/export?workspace=${ws}`}>Export audit log</a></div>}
    <div className="list mt16">{ev?.map((e) => <div key={e.seq} className="item small">
      <span className="faint" style={{ width: 70 }}>{ago(e.ts)}</span><span className="mono" style={{ width: 190 }}>{e.type}</span>
      <span className="grow">{e.actor_name && <b>{e.actor_name} </b>}{describe(e)}{e.room_name && <span className="faint"> · {e.room_name}</span>}</span>
      {e.run_id && <a className="faint" style={{ cursor: "pointer" }} onClick={() => setTrace(e.run_id)}>trace</a>}</div>)}</div>
    {trace && <Trace id={trace} onClose={() => setTrace(null)} />}
  </>;
}
function describe(e: any) {
  const d = e.data ?? {};
  return d.objective ?? d.summary ?? (d.tool ? `${d.tool}${d.decision ? ` → ${d.decision}` : ""}${d.status ? ` → ${d.status}` : ""}` : null) ?? d.reason ?? d.text ?? d.name ?? d.title ?? "";
}

// ---------------- Settings ----------------
function Settings() {
  const { ws, me, toast, reloadMe, setWs } = useCtx();
  const [s, reload] = useApi<any>(`/v1/workspaces/${ws}/settings`);
  const [members, reloadMembers] = useApi<any[]>(`/v1/workspaces/${ws}/members`);
  const [usage] = useApi<any>(`/v1/usage?workspace=${ws}`);
  const [invite, setInvite] = useState(""), [link, setLink] = useState(""), [key, setKey] = useState({ provider: "anthropic", key: "" }), [newWs, setNewWs] = useState("");
  const role = me.workspaces.find((w: any) => w.id === ws)?.role;
  if (!s) return null;
  return <>
    <h1>Settings</h1><p className="muted">{s.workspace.name} · {s.workspace.plan} plan · you are {role}</p>
    <h2>Members</h2>
    <div className="list">{members?.map((m) => <div key={m.id} className="item"><div className="avatar human">{m.name[0]}</div><div className="grow">{m.name}<div className="small faint">{m.email}</div></div>
      {role !== "member" ? <input className="input" style={{ width: 160 }} placeholder="Title (e.g. Recruiter)" defaultValue={m.title ?? ""} onBlur={async (e) => { await api(`/v1/workspaces/${ws}/members`, { user_id: m.id, title: e.target.value }, "PATCH"); reloadMembers(); }} /> : <span className="muted">{m.title}</span>}
      <span className="pill">{m.role}</span></div>)}</div>
    {role !== "member" && s.workspace.kind === "team" && <div className="row mt8"><input className="input" placeholder="Email to invite (optional)" value={invite} onChange={(e) => setInvite(e.target.value)} />
      <button className="btn" onClick={async () => { const r = await api(`/v1/workspaces/${ws}/invitations`, { email: invite || undefined }); setLink(r.url); }}>Create invite link</button></div>}
    {link && <div className="card mt8 mono">{link}</div>}
    <h2>Model keys (BYOK)</h2>
    <p className="small muted">Use your own provider keys; inference is billed to you, the platform meters everything else. Keys are encrypted and never shown again.</p>
    <div className="row"><select className="input" style={{ width: 140 }} value={key.provider} onChange={(e) => setKey({ ...key, provider: e.target.value })}><option>anthropic</option><option>openai</option></select>
      <input className="input" type="password" placeholder="sk-…" value={key.key} onChange={(e) => setKey({ ...key, key: e.target.value })} />
      <button className="btn" onClick={async () => { try { await api(`/v1/workspaces/${ws}/provider-keys/${key.provider}`, { key: key.key }, "PUT"); setKey({ ...key, key: "" }); reload(); toast("Saved"); } catch (e: any) { toast(e.message); } }}>Save</button></div>
    <div className="row mt8 wrap">{s.byok.map((p: string) => <span key={p} className="pill ok">{p} key set <a style={{ cursor: "pointer" }} onClick={async () => { await api(`/v1/workspaces/${ws}/provider-keys/${p}`, undefined, "DELETE"); reload(); }}>✕</a></span>)}</div>
    <h2>Model routing</h2>
    <table className="t card"><thead><tr><th>Profile</th><th>Primary</th><th>Fallback</th><th>Escalation</th><th>Max $/run</th></tr></thead><tbody>{s.model_profiles.map((p: any) => <tr key={p.name}><td>{p.name}</td><td className="mono">{p.primary_model}</td><td className="mono">{p.fallback_model}</td><td className="mono">{p.escalation_model ?? "—"}</td><td>{p.max_cost}</td></tr>)}</tbody></table>
    <h2>Usage</h2>
    {usage && <><div className="grid2">{[["Completed tasks", usage.metrics.completed_runs], ["Autonomous completion", usage.metrics.autonomous_completion_rate ?? "—"], ["Approval acceptance", usage.metrics.approval_acceptance_rate ?? "—"], ["Rooms used across channels", usage.metrics.cross_channel_rooms]].map(([l, v]) =>
      <div key={l as string} className="card"><div className="small muted">{l}</div><div style={{ fontSize: 22, fontWeight: 600 }}>{v}</div></div>)}</div>
      <table className="t card mt8"><thead><tr><th>Resource</th><th>Quantity</th><th>Cost</th></tr></thead><tbody>{usage.by_kind.map((k: any) => <tr key={k.kind}><td className="mono">{k.kind}</td><td>{k.qty}</td><td>${k.cost_usd}</td></tr>)}</tbody></table></>}
    <h2>Memory</h2><MemoryList />
    <h2>Workspaces</h2>
    <div className="row"><input className="input" placeholder="New team workspace name" value={newWs} onChange={(e) => setNewWs(e.target.value)} />
      <button className="btn" onClick={async () => { const w = await api("/v1/workspaces", { name: newWs }); setNewWs(""); reloadMe(); setWs(w.id); toast("Workspace created"); }}>Create</button></div>
    <div className="mt16"><button className="btn" onClick={async () => { await api("/v1/auth/logout", {}); location.hash = "/"; location.reload(); }}>Sign out</button></div>
  </>;
}
function AcceptInvite({ token }: { token: string }) {
  const { reloadMe, setWs, toast } = useCtx();
  return <div className="card"><h3>You've been invited to a workspace</h3><button className="btn primary mt16" onClick={async () => { try { const r = await api(`/v1/invitations/${token}/accept`, {}); reloadMe(); setWs(r.workspace_id); go("/"); } catch (e: any) { toast(e.message); } }}>Accept invitation</button></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
