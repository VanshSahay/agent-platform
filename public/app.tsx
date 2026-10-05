import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useState, useCallback, useRef, createContext, useContext, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { Rich } from "./rich";
import { ClerkProvider, SignIn, useAuth } from "@clerk/react";

// Set at boot from /v1/auth/config: Clerk's publishable key when the server has Clerk on, else null (built-in sign-in).
let CLERK_KEY: string | null = null;

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

// ---------------- shell ----------------
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
function WaitCard({ w, onDone }: { w: any; onDone: () => void }) {
  const resolve = async (outcome: string) => { await api(`/v1/waits/${w.id}/resolve`, { outcome }); onDone(); };
  return <div className="card"><div className="row"><span className="pill warn">{w.kind === "verify" ? "Verify" : "Action needed"}</span><b>{w.agent_name}</b></div>
    <p className="mt8">{w.reason}</p>
    {w.kind === "verify" && <div className="row"><button className="btn" onClick={() => resolve("succeeded")}>It went through</button><button className="btn" onClick={() => resolve("retry")}>It didn't — retry</button></div>}
  </div>;
}

// ---------------- Agents ----------------
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

// Top-level so background refreshes don't remount them (which would swap buttons out from under the user).
function SetupChecklist({ a, onMessage }: { a: any; onMessage: () => void }) {
  const { ws } = useCtx();
  const needsGoogle = a.connections_needed.includes("google");
  const items = [
    needsGoogle && { done: a.connections.some((c: any) => c.provider === "google"), label: "Connect Gmail + Google Calendar", action: <a className="btn sm" href={`/v1/connections/google/start?workspace=${ws}&agent=${a.id}`}>Connect</a> },
    a.skills.includes("reservations") && { done: a.connections.some((c: any) => c.provider === "mcp"), label: "Connect a browser runner (Browser Use) for real Resy / OpenTable bookings — until then Reese uses sandbox restaurants", action: <a className="btn sm" href="#/connections">Connect</a> },
    a.skills.includes("reservations") && { done: a.connections.some((c: any) => c.provider === "site_login" || c.provider === "browser_login"), label: "Save your Resy / OpenTable login", action: <a className="btn sm" href="#/connections">Add login</a> },
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
      <a className="row small muted" style={{ padding: 6 }} href="#/rooms">+ New chat</a></div>}</div>;
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
    <div className="row between"><div><h1>Chats</h1><p className="muted">Every conversation your agents are in — web, iMessage, WhatsApp, Telegram, Slack. Same memory everywhere.</p></div><button className="btn primary" onClick={() => setF({ name: "", objective: "", agent_ids: [], member_ids: [], participation: "mention_only" })}>＋ New chat</button></div>
    {f && <div className="card col mt16">
      <input className="input" placeholder="Chat name (e.g. Trip to Japan)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <input className="input" placeholder="Objective (optional)" value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} />
      <div className="small muted">Agents</div><div className="row wrap">{agents?.map((a) => <label key={a.id} className="pill"><input type="checkbox" checked={f.agent_ids.includes(a.id)} onChange={(e) => setF({ ...f, agent_ids: e.target.checked ? [...f.agent_ids, a.id] : f.agent_ids.filter((x: string) => x !== a.id) })} />{a.name}</label>)}</div>
      <div className="small muted">People</div><div className="row wrap">{members?.map((m) => <label key={m.id} className="pill"><input type="checkbox" checked={f.member_ids.includes(m.id)} onChange={(e) => setF({ ...f, member_ids: e.target.checked ? [...f.member_ids, m.id] : f.member_ids.filter((x: string) => x !== m.id) })} />{m.name}</label>)}</div>
      <label className="field">Agents participate<select className="input" value={f.participation} onChange={(e) => setF({ ...f, participation: e.target.value })}><option value="mention_only">Only when mentioned</option><option value="relevant">When relevant</option><option value="manager">Proactively (manages the objective)</option></select></label>
      <div className="row"><button className="btn primary" disabled={!f.name} onClick={create}>Create chat</button><button className="btn" onClick={() => setF(null)}>Cancel</button></div></div>}
    <div className="list mt16">{rooms?.length ? rooms.map((r) => <a key={r.id} className="item" href={`#/rooms/${r.id}`}>
      <div className="avatar human">{r.kind === "private" ? "◉" : "◇"}</div>
      <div className="grow"><b>{r.name}</b>{r.objective && <span className="muted"> — {r.objective}</span>}<div className="small faint">{r.humans} {r.humans === 1 ? "person" : "people"} · {r.agents} AI{r.last_ts ? ` · ${ago(r.last_ts)}` : ""}</div></div>
      {r.pending > 0 && <span className="pill warn">{r.pending} approval{r.pending > 1 ? "s" : ""}</span>}</a>) : <div className="item muted">No chats yet — add an agent to a chat from its page.</div>}</div>
  </>;
}

function Room({ id, compact }: { id: string; compact?: boolean }) {
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
  return <div className={`room ${compact ? "compact" : ""}`}>
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
                : <><div className="text">{isAgent ? <Rich text={e.data.text} /> : fileLinks(e.data.text)}</div>
                  {e.data.buttons?.length > 0 && isAgent && <div className="row mt8">{e.data.buttons.map((b: any) => <button key={b.data} className="btn sm"
                    onClick={async () => { try { await api(`/v1/rooms/${id}/buttons`, { data: b.data }); load(); } catch (x: any) { toast(x.message); } }}>{b.label}</button>)}</div>}</>}
            </div></div>;
        })}
      </div>
      {data.starters?.length > 0 && events.filter((e) => e.type === "message").length < 4 && <div className="row wrap" style={{ padding: "8px 16px 0", gap: 6 }}>
        <span className="small faint">Try:</span>{data.starters.map((s: string) => <button key={s} className="pill" style={{ cursor: "pointer", border: 0 }} onClick={() => edit(s.replace(/…/g, "").replace(/\s+/g, " ").trim() + (s.includes("…") ? " " : ""))}>{s}</button>)}</div>}
      {data.runs.some((r: any) => ["queued", "running", "retrying"].includes(r.status)) && <div className="small muted working-line" style={{ padding: "4px 20px" }}>
        {data.runs.filter((r: any) => ["running", "retrying"].includes(r.status)).map((r: any) => <div key={r.id}><span className="dots" /> {r.agent_name} is {r.activity ?? "working"}…{r.steps > 2 ? ` · ${r.steps} steps` : ""}</div>)}
        {data.runs.filter((r: any) => r.status === "queued").map((r: any) => <div key={r.id} className="faint">Up next for {r.agent_name}: “{String(r.objective).slice(0, 70)}{String(r.objective).length > 70 ? "…" : ""}”</div>)}</div>}
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
/** What's happening while an agent is drafted (~5-10s), instead of a bare "Building…". */
function BuildingSteps() {
  const steps = ["Reading your request", "Figuring out its jobs", "Finding data sources", "Writing test scenarios"];
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => Math.min(x + 1, steps.length - 1)), 2200); return () => clearInterval(t); }, []);
  return <span>{steps[i]}…</span>;
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
// ---------------- Connections ----------------
function Connections() {
  const { ws, me, toast } = useCtx();
  const [conns, reload] = useApi<any[]>(`/v1/connections?workspace=${ws}`);
  const [sel, setSel] = useState<string | null>(null), [dev, setDev] = useState<any>(null), [form, setForm] = useState<any>(null);
  const live = conns?.filter((c) => c.status !== "pending") ?? []; // pending = a live-browser login that was never finished
  const mine = live.filter((c) => c.visibility === "private"), company = live.filter((c) => c.visibility === "workspace");
  const reconnectLive = (c: any) => setForm({ kind: "live", site: c.site, agents: c.agents?.map((a: any) => a.id) ?? [], autostart: true });
  const addDev = async () => { try { await api("/v1/connections", { workspace_id: ws, provider: dev.provider, account: dev.account, visibility: dev.visibility, credentials: { access_token: dev.token } }); setDev(null); reload(); } catch (e: any) { toast(e.message); } };
  const Row = (c: any) => <a key={c.id} className="item" style={{ cursor: "pointer" }} onClick={() => setSel(c.id)}><span className="pill">{c.provider === "mcp" ? `MCP · ${c.tool_count ?? 0} tools` : c.provider === "site_login" ? "site login" : c.provider === "browser_login" ? "live login" : c.provider}</span><b className="grow">{c.label}</b><span className="muted">{c.visibility === "workspace" ? "Company" : c.owner}</span><span className="muted">{c.account}</span>
    {c.provider === "browser_login" && c.status !== "active" && c.owner_id === me.user.id
      ? <button className="btn sm" onClick={(e) => { e.stopPropagation(); reconnectLive(c); }}>Reconnect</button>
      : <span className={`pill ${c.status === "active" ? "ok" : "warn"}`}>{c.status === "active" ? "Connected" : c.provider === "browser_login" ? "Needs reconnect" : "Reconnect"}</span>}</a>;
  return <>
    <div className="row between"><div><h1>Connections</h1><p className="muted">Access to your tools. Each connection has one owner; agents only use what they've been allowed.</p></div>
      <div className="row wrap"><a className="btn primary" href={`/v1/connections/google/start?workspace=${ws}`}>Connect Google</a>
        <button className="btn" onClick={() => setForm({ kind: "mcp", preset: "browserbase", url: MCP_PRESETS.browserbase.url, headers: MCP_PRESETS.browserbase.headers, label: "Browserbase", agents: [] })}>Add MCP server</button>
        <button className="btn" onClick={() => setForm({ kind: "live", site: "resy.com", agents: [] })}>Sign in with a live browser</button>
        <button className="btn" onClick={() => setForm({ kind: "site", site: "resy.com", username: "", password: "", agents: [] })}>Add site login</button>
        <button className="btn ghost" onClick={() => setDev({ provider: "google", account: me.user.email, token: "", visibility: "private" })}>Add token</button></div></div>
    {form && (form.kind === "live" ? <LiveLoginForm key={form.autostart ? `re-${form.site}` : "new"} form={form} setForm={setForm} onDone={() => { setForm(null); reload(); }} />
      : <ConnectForm form={form} setForm={setForm} onDone={() => { setForm(null); reload(); }} />)}
    {dev && <div className="card col mt16"><div className="small muted">Paste an OAuth access token (e.g. from the Google OAuth Playground) — useful in development.</div>
      <input className="input" placeholder="Account (email)" value={dev.account} onChange={(e) => setDev({ ...dev, account: e.target.value })} />
      <input className="input" placeholder="Access token" value={dev.token} onChange={(e) => setDev({ ...dev, token: e.target.value })} />
      <select className="input" value={dev.visibility} onChange={(e) => setDev({ ...dev, visibility: e.target.value })}><option value="private">Only me</option><option value="workspace">Whole workspace (admins)</option></select>
      <div className="row"><button className="btn primary" onClick={addDev}>Save</button><button className="btn" onClick={() => setDev(null)}>Cancel</button></div></div>}
    <h2>Your connections</h2><div className="list">{mine.length ? mine.map(Row) : <div className="item muted">None yet.</div>}</div>
    <h2>Company connections</h2><div className="list">{company.length ? company.map(Row) : <div className="item muted">None yet.</div>}</div>
    {sel && <ConnectionDrawer id={sel} onClose={() => { setSel(null); reload(); }} onReconnectLive={(c: any) => { setSel(null); reconnectLive(c); }} />}
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
/** The user logs into the site themselves inside a Browserbase session; we keep only the browser profile's id. */
function LiveLoginForm({ form, setForm, onDone }: { form: any; setForm: (f: any) => void; onDone: () => void }) {
  const { ws, toast } = useCtx();
  const [agents] = useApi<any[]>(`/v1/agents?workspace=${ws}`);
  const [s, setS] = useState<any>(null), [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const F = (k: string, v: any) => setForm({ ...form, [k]: v });
  const start = async () => {
    setBusy(true); setErr(null);
    try { setS(await api("/v1/browser-logins/start", { workspace_id: ws, site: form.site, agent_ids: form.agents })); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const finish = async () => {
    setBusy(true);
    try { await api("/v1/browser-logins/finish", { session_id: s.session_id, workspace_id: ws, site: form.site, agent_ids: form.agents }); toast(`Signed in to ${form.site}`); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const cancel = async () => { if (s) await api("/v1/browser-logins/cancel", { session_id: s.session_id }).catch(() => {}); setForm(null); };
  useEffect(() => { if (form.autostart) start(); }, []);
  return <div className="card col mt16">
    <h3>Sign in to {form.site || "a website"} with a live browser</h3>
    {!s ? <>
      <p className="small muted">A secure cloud browser opens right here. You log in yourself; agents then act on the site as you, without ever seeing your password.</p>
      <select className="input" value={["resy.com", "opentable.com", "linkedin.com"].includes(form.site) ? form.site : "other"} onChange={(e) => F("site", e.target.value === "other" ? "" : e.target.value)}>
        <option value="resy.com">Resy</option><option value="opentable.com">OpenTable</option><option value="linkedin.com">LinkedIn</option><option value="other">Other site…</option></select>
      {!["resy.com", "opentable.com", "linkedin.com"].includes(form.site) && <input className="input" placeholder="example.com" value={form.site} onChange={(e) => F("site", e.target.value)} />}
      <div className="small muted">Agents that can use it</div>
      <div className="row wrap">{agents?.map((a) => <label key={a.id} className="pill"><input type="checkbox" checked={form.agents.includes(a.id)} onChange={(e) => F("agents", e.target.checked ? [...form.agents, a.id] : form.agents.filter((x: string) => x !== a.id))} />{a.name}</label>)}</div>
      {err && <div className="small" style={{ color: "var(--bad)" }}>{err}</div>}
      <div className="row"><button className="btn primary" disabled={busy || !form.site} onClick={start}>{busy ? "Opening…" : "Open live browser"}</button><button className="btn" onClick={() => setForm(null)}>Cancel</button></div>
    </> : <>
      <p className="small"><b>Log in normally, including 2FA. We never see or store your password.</b> <span className="muted">If the page is blank, type {form.site} into the browser's address.</span></p>
      <iframe src={s.live_view_url} title={`${form.site} login`} sandbox="allow-same-origin allow-scripts allow-forms allow-popups" allow="clipboard-read; clipboard-write"
        style={{ width: "100%", maxWidth: 1024, aspectRatio: "1024 / 700", border: "1px solid var(--line)", borderRadius: 10, background: "#fff" }} />
      {err && <div className="small" style={{ color: "var(--bad)" }}>{err}</div>}
      <div className="row"><button className="btn primary" disabled={busy} onClick={finish}>{busy ? "Saving…" : "I'm logged in"}</button><button className="btn" disabled={busy} onClick={cancel}>Cancel</button></div>
    </>}
  </div>;
}
function ConnectionDrawer({ id, onClose, onReconnectLive }: { id: string; onClose: () => void; onReconnectLive: (c: any) => void }) {
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
      : c.provider === "browser_login" ? <div className="small muted">Site: <span className="mono">{c.config.site}</span> · signed in by you in a live browser. We keep only an encrypted browser profile at Browserbase — never your password.{c.status === "needs_reauth" && <b> The login expired; reconnect to keep using it.</b>}</div>
      : <div className="small muted">Scopes: <span className="mono">{c.scopes ?? "—"}</span></div>}<div className="small muted">Last used: {c.last_used_at ? ago(c.last_used_at) : "never"}</div>
    <h2>Agents with access</h2>{c.agents.length ? c.agents.map((a: any) => <div key={a.id} className="row between" style={{ padding: "4px 0" }}><span>{a.name}</span><button className="btn sm" onClick={async () => { await api(`/v1/connections/${id}/grants/${a.id}`, undefined, "DELETE"); reload(); }}>Remove</button></div>) : <div className="muted small">None</div>}
    <h2>Audit trail</h2>{c.audit.length ? c.audit.map((e: any, i: number) => <div key={i} className="small" style={{ padding: "3px 0" }}>{ago(e.ts)} · {e.agent} · <span className="mono">{e.tool}</span> · {e.status}</div>) : <div className="muted small">No activity yet.</div>}
    <div className="row mt16">{c.status !== "active" && (c.provider === "browser_login"
        ? <button className="btn" onClick={() => onReconnectLive({ site: c.config.site, agents: c.agents })}>Reconnect</button>
        : <a className="btn" href={`/v1/connections/google/start?workspace=${ws}&reconnect=${c.id}`}>Reconnect</a>)}
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
  const [invite, setInvite] = useState(""), [link, setLink] = useState(""), [newWs, setNewWs] = useState("");
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
    <h2>AI models & billing</h2>
    <AiSettings canEdit={role !== "member"} />
    <details className="mt8"><summary className="small muted">Platform fallback routing ▸</summary>
      <table className="t card mt8"><thead><tr><th>Profile</th><th>Primary</th><th>Fallback</th><th>Escalation</th><th>Max $/run</th></tr></thead><tbody>{s.model_profiles.map((p: any) => <tr key={p.name}><td>{p.name}</td><td className="mono">{p.primary_model}</td><td className="mono">{p.fallback_model}</td><td className="mono">{p.escalation_model ?? "—"}</td><td>{p.max_cost}</td></tr>)}</tbody></table></details>
    <h2>Usage</h2>
    {usage && <><div className="grid2">{[["Completed tasks", usage.metrics.completed_runs], ["Autonomous completion", usage.metrics.autonomous_completion_rate ?? "—"], ["Approval acceptance", usage.metrics.approval_acceptance_rate ?? "—"], ["Rooms used across channels", usage.metrics.cross_channel_rooms]].map(([l, v]) =>
      <div key={l as string} className="card"><div className="small muted">{l}</div><div style={{ fontSize: 22, fontWeight: 600 }}>{v}</div></div>)}</div>
      <table className="t card mt8"><thead><tr><th>Resource</th><th>Quantity</th><th>Cost</th></tr></thead><tbody>{usage.by_kind.map((k: any) => <tr key={k.kind}><td className="mono">{k.kind}</td><td>{k.qty}</td><td>${k.cost_usd}</td></tr>)}</tbody></table></>}
    <h2>Memory</h2><MemoryList />
    <h2>Workspaces</h2>
    <div className="row"><input className="input" placeholder="New team workspace name" value={newWs} onChange={(e) => setNewWs(e.target.value)} />
      <button className="btn" onClick={async () => { const w = await api("/v1/workspaces", { name: newWs }); setNewWs(""); reloadMe(); setWs(w.id); toast("Workspace created"); }}>Create</button></div>
    <div className="mt16"><button className="btn" onClick={async () => { await (window as any).Clerk?.signOut?.(); await api("/v1/auth/logout", {}); location.hash = "/"; location.reload(); }}>Sign out</button></div>
  </>;
}
const PROVIDER_LABEL: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", custom: "Self-hosted / other (OpenAI-compatible)" };
const PROFILES: [string, string, string][] = [["standard", "Everyday work", "What most agents use"], ["fast", "Quick steps", "Understanding requests, short replies, summaries"],
  ["research-standard", "Research", "Long multi-step research"], ["escalation", "Hard problems", "Used when a task gets stuck"]];
const usd = (x: number | null | undefined) => x == null ? "∞" : `$${x < 10 ? x.toFixed(2) : Math.round(x)}`;
function AiSettings({ canEdit }: { canEdit: boolean }) {
  const { ws, toast } = useCtx();
  const [ai, reload] = useApi<any>(`/v1/workspaces/${ws}/ai`);
  const [models] = useApi<any[]>(ai ? `/v1/models?workspace=${ws}&mode=${ai.mode}&k=${ai.byok.join(",")}` : null);
  const [key, setKey] = useState({ provider: "openrouter", key: "", base_url: "" }), [openOnly, setOpenOnly] = useState(true), [custom, setCustom] = useState<Record<string, string>>({});
  if (!ai) return null;
  const put = async (b: any) => { try { await api(`/v1/workspaces/${ws}/ai`, b, "PUT"); reload(); } catch (e: any) { toast(e.message); } };
  const saveKey = async () => { try { await api(`/v1/workspaces/${ws}/provider-keys/${key.provider}`, key.provider === "custom" ? { key: key.key, base_url: key.base_url } : { key: key.key }, "PUT"); setKey({ ...key, key: "" }); reload(); toast("Key saved — your agents now use it"); } catch (e: any) { toast(e.message); } };
  const topUp = async (amount: number) => { try { location.href = (await api(`/v1/workspaces/${ws}/credits/checkout`, { usd: amount })).url; } catch (e: any) { toast(e.message); } };
  const usable = (models ?? []).filter((m) => m.available && (!openOnly || m.open)).sort((a, b) => a.price_in_per_m + a.price_out_per_m - b.price_in_per_m - b.price_out_per_m);
  const b = ai.balance;
  return <div className="col" style={{ gap: 14 }}>
    <div className="aud" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }} role="radiogroup" aria-label="How agents pay for AI">
      <button role="radio" aria-checked={ai.mode === "credits"} disabled={!canEdit} className={ai.mode === "credits" ? "on" : ""} onClick={() => put({ mode: "credits" })}>
        <div className="e">⚡</div><b>Use our models</b><span>Pay as you go with credits. Open-source models cost a fraction of a cent per message.</span></button>
      <button role="radio" aria-checked={ai.mode === "byok"} disabled={!canEdit} className={ai.mode === "byok" ? "on" : ""} onClick={() => ai.byok.length ? put({ mode: "byok" }) : toast("Add a key below first")}>
        <div className="e">🔑</div><b>Bring your own key</b><span>Use your Anthropic, OpenAI, OpenRouter or self-hosted model. We never charge for AI.</span></button>
    </div>
    {ai.mode === "credits" ? <div className="card">
      <div className="row wrap between"><div><div className="small muted">Available</div><div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.02em" }}>{b.unlimited ? "Unlimited" : usd(b.available)}</div>
        <div className="small muted">{b.unlimited ? "Your plan has no AI cap." : <>{usd(b.allowance_left)} of this month's {usd(b.allowance)} plan allowance{b.credits ? <> + {usd(b.credits)} credits</> : null}</>} · {usd(ai.spent_this_month)} used this month</div></div>
        {canEdit && <div className="col" style={{ gap: 6 }}><span className="small muted">Add credits</span><div className="row">{[10, 25, 50].map((x) => <button key={x} className="btn" onClick={() => topUp(x)}>${x}</button>)}</div></div>}</div>
      {!ai.platform.length && <div className="pill warn mt8">No platform model keys on this server yet — agents use the offline fallback until an admin sets OPENROUTER_API_KEY (or Anthropic/OpenAI).</div>}
      <div className="small faint mt8">Prices include a {Math.round((ai.markup - 1) * 100)}% platform fee on the provider's cost.{!ai.payments && " Card payments aren't configured on this server (STRIPE_SECRET_KEY)."}</div>
    </div> : <div className="card col">
      <div className="row wrap" style={{ gap: 6 }}>{ai.byok.map((p: string) => <span key={p} className="pill ok">🔑 {PROVIDER_LABEL[p] ?? p}{canEdit && <a style={{ cursor: "pointer" }} aria-label={`Remove ${p} key`} onClick={async () => { await api(`/v1/workspaces/${ws}/provider-keys/${p}`, undefined, "DELETE"); reload(); }}> ✕</a>}</span>)}</div>
      <div className="small muted">Your keys are encrypted and never shown again. Agents only use providers you've added a key for.</div>
    </div>}
    {canEdit && (ai.mode === "byok" || !ai.byok.length) && <div className="card col">
      <b>{ai.byok.length ? "Add another key" : "Bring your own key"}</b>
      <div className="row wrap"><select className="input" style={{ width: 260 }} value={key.provider} onChange={(e) => setKey({ ...key, provider: e.target.value })}>{Object.entries(PROVIDER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {key.provider === "custom" && <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder="Base URL, e.g. https://api.together.xyz/v1" value={key.base_url} onChange={(e) => setKey({ ...key, base_url: e.target.value })} />}
        <input className="input" style={{ flex: 1, minWidth: 180 }} type="password" autoComplete="off" placeholder={key.provider === "custom" ? "API key (optional)" : key.provider === "openrouter" ? "sk-or-…" : "sk-…"} value={key.key} onChange={(e) => setKey({ ...key, key: e.target.value })} />
        <button className="btn primary" onClick={saveKey}>Save key</button></div>
      <div className="small faint">{key.provider === "openrouter" ? "One OpenRouter key unlocks hundreds of models, including open-source Llama, DeepSeek, Qwen and Mistral." : key.provider === "custom" ? "Works with Together, Groq, Fireworks, or your own vLLM / Ollama server — anything that speaks the OpenAI Chat Completions API." : ""}</div>
    </div>}
    <div className="card">
      <div className="row between wrap"><b>Which model your agents use</b><label className="row small muted"><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />Open-source only</label></div>
      {PROFILES.map(([p, label, hint], i) => { const cur = ai.models[p] ?? "";
        const inList = !cur || usable.some((m) => m.id === cur);
        return <div key={p} className="ability" style={i > 1 ? { opacity: .85 } : undefined}><span className="e">{["💬", "⚡", "🔎", "🧠"][i]}</span>
          <div className="grow"><div>{label}</div><div className="small faint">{hint}</div></div>
          <div className="col" style={{ gap: 4, width: "min(360px, 55%)" }}>
            <select className="input" disabled={!canEdit} value={cur} onChange={(e) => e.target.value === "__custom" ? setCustom({ ...custom, [p]: "custom:" }) : put({ models: { [p]: e.target.value } })}>
              <option value="">Recommended (automatic)</option>
              {!inList && <option value={cur}>{cur}</option>}
              {usable.map((m) => <option key={m.id} value={m.id}>{m.name} — ${m.price_in_per_m}/${m.price_out_per_m} per 1M{m.open ? " · open" : ""}</option>)}
              {ai.byok.includes("custom") && <option value="__custom">Self-hosted model…</option>}
            </select>
            {custom[p] !== undefined && <div className="row"><input className="input" placeholder="custom:llama3.1:8b" value={custom[p]} onChange={(e) => setCustom({ ...custom, [p]: e.target.value })} />
              <button className="btn sm" onClick={() => { put({ models: { [p]: custom[p] } }); const c = { ...custom }; delete c[p]; setCustom(c); }}>Use</button></div>}
          </div></div>; })}
      {models && !usable.length && <div className="small muted mt8">{ai.mode === "byok" ? "Add a key above to choose models." : "No models available on this server yet."}</div>}
    </div>
  </div>;
}
function AcceptInvite({ token }: { token: string }) {
  const { reloadMe, setWs, toast } = useCtx();
  return <div className="card"><h3>You've been invited to a workspace</h3><button className="btn primary mt16" onClick={async () => { try { const r = await api(`/v1/invitations/${token}/accept`, {}); reloadMe(); setWs(r.workspace_id); go("/"); } catch (e: any) { toast(e.message); } }}>Accept invitation</button></div>;
}

// ---------------- shared building blocks for the describe → try → add-to-chat flow ----------------
const SKILL_COPY: Record<string, [string, string]> = {
  "web-research": ["🔎", "Looks things up on the web and cites sources"], "source-verification": ["✅", "Double-checks facts against the source"],
  "monitor-topic": ["📡", "Watches topics and tells you what changed"], "email-triage": ["📥", "Sorts your inbox: needs reply, FYI, ignore"],
  "email-drafting": ["✉️", "Drafts emails in your voice — you approve sends"], calendar: ["📅", "Finds times and manages your calendar"],
  "meeting-prep": ["🗂️", "Preps you before meetings"], "follow-up-tracking": ["🔁", "Chases replies and nudges people"],
  reminders: ["⏰", "Reminds you or the group at the right time"], documents: ["📄", "Finds and reads your docs"],
  reservations: ["🍽️", "Finds and books tables, watches for openings"], "group-buying": ["🛒", "Runs group orders — tally, deadline, who paid"],
  browser: ["🧭", "Uses websites for you — forms and bookings"], "task-tracking": ["☑️", "Tracks who's doing what"],
  delegation: ["🤝", "Hands work to your other agents"], "travel-planning": ["🧳", "Plans trips around everyone's preferences"],
  "group-coordination": ["👥", "Keeps the group on track and sums up status"], "candidate-matching": ["🎯", "Matches candidates to roles"],
  "credential-followup": ["📋", "Chases missing documents"], polls: ["📊", "Runs polls and RSVPs right in the chat"],
  "expense-splitting": ["💸", "Splits costs and says who owes who"], "shared-lists": ["📝", "Keeps shared lists — groceries, packing, to-buy"],
};
const abilityOf = (s: any): [string, string] => SKILL_COPY[s?.id ?? s] ?? ["✨", s?.name ?? String(s)];
const titleOf = (a: any) => a.title ?? a.instructions?.match(/You are [^,]+, an? ([^.\n]+)\./)?.[1] ?? "";

const PICON: Record<string, ReactNode> = {
  imessage: <path d="M12 4C7 4 3 7.2 3 11.1c0 2.2 1.3 4.1 3.3 5.4L5.6 20l3.9-2.2c.8.2 1.6.3 2.5.3 5 0 9-3.2 9-7S17 4 12 4z" fill="currentColor" />,
  whatsapp: <><path d="M12 3.5a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.4-1.1A8.5 8.5 0 1 0 12 3.5z" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M9 8.5c.3 2.6 2.6 5.3 5.6 6.2l1.1-1.3-1.7-1-1 .8c-1-.5-2-1.5-2.4-2.4l.8-1-1-1.7z" fill="currentColor" /></>,
  telegram: <path d="M20.5 4.2 3.4 10.8c-.9.4-.9 1 0 1.3l4.3 1.4 1.7 5.1c.2.6.6.7 1 .3l2.4-2.2 4.6 3.4c.7.4 1.2.2 1.4-.7l2.9-13.6c.3-1.2-.4-1.7-1.2-1.4zM9 13.2l8.6-5.5-6.9 6.4-.3 3z" fill="currentColor" />,
  slack: <path d="M9 3.5v17M15 3.5v17M3.5 9h17M3.5 15h17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />,
  web: <><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" fill="none" stroke="currentColor" strokeWidth="1.6" /></>,
  mobile: <><rect x="7" y="3" width="10" height="18" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><circle cx="12" cy="17.5" r="1" fill="currentColor" /></>,
  email: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" strokeWidth="1.8" /></>,
};
const PMark = ({ p, size = "" }: { p: string; size?: string }) => <span className={`pmark ${size} p-${p}`} title={PLATFORM[p] ?? p}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>{PICON[p] ?? PICON.web}</svg></span>;

type Aud = "me" | "group" | "team";
const AUDIENCE: [Aud, string, string, string][] = [
  ["me", "🙋", "Just me", "A personal agent you text 1:1"], ["group", "💬", "A group chat", "Friends, family, a club or community"], ["team", "🏢", "My team", "Slack channels and shared work"]];
const EXAMPLES: Record<Aud, string[]> = {
  me: ["Grab me a table at the hottest new spots on Resy for Friday nights", "Every morning, brief me on my calendar and AI news", "Watch these sneakers and tell me when they drop under $120", "Quiz me on Spanish verbs every evening"],
  group: ["Split our ski trip costs and tell everyone who owes what", "Plan Maya's birthday — poll dates and track who brings what", "Run our building's bulk coffee order every month", "Keep our apartment grocery list and chore rotation"],
  team: ["Answer customer questions from our help docs and escalate the rest", "Run Monday standup in #eng and chase blockers", "Research inbound leads and draft first outreach emails", "Turn meeting notes into action items and follow up"],
};
const CAT_OF = (t: any): Aud => (t.manifest?.category === "personal" ? "me" : t.manifest?.category) ?? (/pool|group/.test(t.slug) ? "group" : /relay|recruit/.test(t.slug) ? "team" : "me");

function AudiencePicker({ value, onChange }: { value: Aud; onChange: (a: Aud) => void }) {
  return <div className="aud" role="radiogroup" aria-label="Who is it for">{AUDIENCE.map(([k, e, b, s]) =>
    <button key={k} role="radio" aria-checked={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}><div className="e">{e}</div><b>{b}</b><span>{s}</span></button>)}</div>;
}

function DescribeBox({ value, onChange, onSubmit, audience = "me", busy, cta = "Build my agent" }: { value: string; onChange: (s: string) => void; onSubmit: () => void; audience?: Aud; busy?: boolean; cta?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => x + 1), 3800); return () => clearInterval(t); }, []);
  const ex = EXAMPLES[audience][i % EXAMPLES[audience].length];
  return <div className="describe">
    <textarea value={value} aria-label="Describe what your agent should do" placeholder={ex} onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(); if (e.key === "Tab" && !value) { e.preventDefault(); onChange(ex); } }} />
    <div className="bar"><span className="small faint grow">{value ? "⌘↵ to build" : "Press Tab to use the example"}</span>
      <button className="btn grad lg" disabled={!value.trim() || busy} onClick={onSubmit}>{busy ? <BuildingSteps /> : cta} →</button></div>
  </div>;
}

function Stepper({ at, onPick }: { at: number; onPick?: (i: number) => void }) {
  const steps = ["Describe", "Understand", "Rehearse", "Add to a chat"];
  return <div className="stepper">{steps.map((s, i) => <span key={s} className="row" style={{ gap: 8 }}>
    {i > 0 && <span className="line" />}
    <span className={`s ${i === at ? "on" : i < at ? "done" : ""}`} style={{ cursor: onPick ? "pointer" : undefined }} onClick={() => onPick?.(i)}><i>{i < at ? "✓" : i + 1}</i><span>{s}</span></span></span>)}</div>;
}

function IdeaGallery({ cat: cat0 = "all", onPick, anonymous }: { cat?: Aud | "all"; onPick: (t: any) => void; anonymous?: boolean }) {
  const [list] = useApi<any[]>("/v1/agent-templates");
  const [cat, setCat] = useState<Aud | "all">(cat0);
  useEffect(() => setCat(cat0), [cat0]);
  const shown = (list ?? []).filter((t) => cat === "all" || CAT_OF(t) === cat);
  return <>
    <div className="seg" style={{ marginBottom: 14 }}>{([["all", "All"], ["me", "For you"], ["group", "For group chats"], ["team", "For teams"]] as const).map(([k, l]) =>
      <button key={k} className={cat === k ? "on" : ""} onClick={() => setCat(k)}>{l}</button>)}</div>
    <div className="grid3">{shown.map((t, i) => <div key={t.id} className="card hover idea rise" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
      <div className="top"><div className="avatar lg">{t.manifest.avatar ?? t.name[0]}</div><div className="grow"><h3>{t.name}</h3><div className="small muted">{t.manifest.title}</div></div></div>
      <div className="tag">{t.tagline}</div>
      <div className="row between"><div className="where">{(t.manifest.channels ?? ["web"]).filter((c: string) => PICON[c]).slice(0, 5).map((c: string) => <PMark key={c} p={c} size="sm" />)}</div>
        <div className="row" style={{ gap: 6 }}><a className="btn sm ghost" href={`#/discover/${t.slug}`}>Try</a><button className="btn sm primary" onClick={() => onPick(t)}>{anonymous ? "Use" : "Add"}</button></div></div>
    </div>)}</div>
    {list && !shown.length && <div className="empty">No agents here yet — describe your own above.</div>}
  </>;
}

// ---------------- landing ----------------
// ---------------- landing: editorial "letters become stickers" hero ----------------
// Interaction adapted from boknowsworld/boknows-text-image-template (MIT): letters swap to mixed-media stickers on hover,
// neighbours make room, stickers spring in and shrink out; idle letters cycle on their own. Stickers are drawn as SVG
// in chat/agent visual languages (bubbles, stamps, tags, receipts, polls, notes, app icons, label tape) — no image assets.
type Kind = "imsg" | "wa" | "stamp" | "tag" | "receipt" | "poll" | "note" | "app" | "tape" | "rosette" | "ticket";
function Sticker({ kind, ch }: { kind: Kind; ch: string }) {
  const L = (x: number, y: number, fill: string, font = "Arial Black, Arial, sans-serif", size = 62, extra: any = {}) =>
    <text x={x} y={y} fill={fill} fontFamily={font} fontSize={size} fontWeight={900} textAnchor="middle" dominantBaseline="central" {...extra}>{ch}</text>;
  const body: Record<Kind, ReactNode> = {
    imsg: <><path d="M16 10h68a12 12 0 0 1 12 12v52a12 12 0 0 1-12 12H40l-16 14 2-14h-10A12 12 0 0 1 4 74V22a12 12 0 0 1 12-12z" fill="#0a84ff" />{L(50, 48, "#fff")}</>,
    wa: <><path d="M84 10H16A12 12 0 0 0 4 22v52a12 12 0 0 0 12 12h56l18 12-4-16a12 12 0 0 0 8-8V22a12 12 0 0 0-12-12z" fill="#d9fdd3" stroke="#25d366" strokeWidth="3" />{L(48, 48, "#0b5e37")}<text x="80" y="80" fontSize="11" fill="#53bdeb" fontFamily="Arial">✓✓</text></>,
    stamp: <><rect x="8" y="8" width="84" height="94" fill="#fff8ec" stroke="#fff8ec" strokeWidth="10" strokeDasharray="0.1 7.9" strokeLinecap="round" />
      <rect x="16" y="16" width="68" height="78" fill="#f6d6c9" stroke="#c2412d" strokeWidth="2.5" />{L(50, 52, "#c2412d", "Georgia, serif", 60)}<text x="78" y="88" fontSize="9" textAnchor="end" fill="#c2412d" fontFamily="Courier New">2¢</text></>,
    tag: <><path d="M50 4c-6 0-6 10 0 14" stroke="#8a6a3c" strokeWidth="2.5" fill="none" /><path d="M24 22h52l12 14v60a6 6 0 0 1-6 6H18a6 6 0 0 1-6-6V36z" fill="#d9b48a" stroke="#9b7448" strokeWidth="2" strokeDasharray="4 3" />
      <circle cx="50" cy="32" r="4.5" fill="#e8ece8" stroke="#8a6a3c" strokeWidth="2" />{L(50, 68, "#3d2a14", "Georgia, serif", 52)}</>,
    receipt: <><path d="M14 6h72v92l-6-5-6 5-6-5-6 5-6-5-6 5-6-5-6 5-6-5-6 5-6-5z" fill="#fffef8" stroke="#cfd5cc" strokeWidth="1.5" />
      {[16, 24].map((y) => <line key={y} x1="22" x2="78" y1={y} y2={y} stroke="#b7bfb4" strokeWidth="2" strokeDasharray="3 3" />)}{L(50, 56, "#1d2420", "Courier New, monospace", 58)}<text x="50" y="84" fontSize="8" textAnchor="middle" fill="#6b746c" fontFamily="Courier New">SPLIT 4 WAYS</text></>,
    poll: <><rect x="6" y="10" width="88" height="88" rx="14" fill="#fff" stroke="#d3d8d2" strokeWidth="2" />{[30, 50, 70].map((y, i) => <rect key={y} x="18" y={y - 5} width={[46, 64, 28][i]} height="10" rx="5" fill={["#c8c3ff", "#7a5cff", "#e3e0ff"][i]} />)}
      {L(78, 30, "#4533d6", "Arial Black, Arial", 34)}<text x="18" y="90" fontSize="9" fill="#67646f" fontFamily="Arial">3 votes</text></>,
    note: <><g transform="rotate(-4 50 55)"><rect x="10" y="12" width="80" height="84" fill="#ffe86b" /><path d="M74 96l16-16v16z" fill="#e6c94a" /><rect x="38" y="6" width="26" height="12" fill="#ffffff99" />
      {L(48, 56, "#2b2a20", "Georgia, serif", 64, { fontStyle: "italic", fontWeight: 700 })}</g></>,
    app: <><rect x="8" y="12" width="84" height="84" rx="22" fill="url(#g)" /><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7a5cff" /><stop offset="1" stopColor="#2fa8ff" /></linearGradient></defs>
      {L(50, 56, "#fff")}<circle cx="86" cy="16" r="11" fill="#ff3b30" /><text x="86" y="17" fontSize="13" fill="#fff" textAnchor="middle" dominantBaseline="central" fontFamily="Arial" fontWeight="700">1</text></>,
    tape: <><rect x="4" y="30" width="92" height="50" rx="6" fill="#1d1f22" /><rect x="4" y="30" width="92" height="6" rx="3" fill="#3a3d42" />
      {L(50, 57, "#f4f4f2", "Courier New, monospace", 50, { letterSpacing: 2 })}</>,
    rosette: <><path d="M38 70l-12 34 14-8 8 12 6-36zM62 70l12 34-14-8-8 12-6-36z" fill="#2f6f5a" />
      <circle cx="50" cy="48" r="40" fill="#e0b84a" stroke="#c99a2a" strokeWidth="4" strokeDasharray="5 3" /><circle cx="50" cy="48" r="28" fill="#fffaf0" />{L(50, 49, "#2f6f5a", "Georgia, serif", 46)}</>,
    ticket: <><path d="M6 24h88v20a8 8 0 0 0 0 20v20H6V64a8 8 0 0 0 0-20z" fill="#ff8a65" /><line x1="72" x2="72" y1="28" y2="80" stroke="#fff" strokeWidth="2" strokeDasharray="4 4" />
      {L(38, 54, "#fff", "Arial Black, Arial", 52)}<text x="83" y="54" fontSize="9" fill="#fff" textAnchor="middle" dominantBaseline="central" fontFamily="Courier New" transform="rotate(90 83 54)">RSVP</text></>,
  };
  return <svg viewBox="0 0 100 110" aria-hidden>{body[kind]}</svg>;
}

const HERO = "text an agent";
// Two distinct visual languages per letter position (spaces excluded), so the same letter never repeats a look.
const LOOKS: [Kind, Kind][] = [["imsg", "stamp"], ["note", "rosette"], ["tape", "ticket"], ["app", "receipt"], ["wa", "tag"], ["poll", "note"],
  ["stamp", "app"], ["receipt", "imsg"], ["rosette", "wa"], ["tag", "tape"], ["ticket", "poll"]];
const spring = (angle: number, y: number) => Array.from({ length: 41 }, (_, i) => {
  const t = i / 40, v = i === 40 ? 1 : 1 - Math.exp(-7.2 * t) * (Math.cos(10.5 * t) + .24 * Math.sin(10.5 * t));
  return { offset: t, transform: `translate(-50%, -50%) translateY(${y + 8 * (1 - v)}px) rotate(${angle - 8 * (1 - v)}deg) scale(${.35 + .65 * v})` };
});

function LetterHero({ text = HERO, idle = true }: { text?: string; idle?: boolean }) {
  const chars = Array.from(text);
  const positions = chars.map((c, i) => c === " " ? -1 : chars.slice(0, i).filter((x) => x !== " ").length);
  const n = chars.filter((c) => c !== " ").length;
  const look = (i: number) => LOOKS[i % LOOKS.length]; // longer titles cycle through the looks
  const [active, setActive] = useState<Record<number, Kind>>({});
  const last = useRef<Record<number, Kind>>({}), hovered = useRef<number | null>(null), timers = useRef<Record<number, any>>({});
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const show = (i: number, ms?: number) => {
    if (reduced) return;
    const [a, b] = look(i), kind = last.current[i] === a ? b : last.current[i] === b ? a : Math.random() < .5 ? a : b;
    last.current[i] = kind; clearTimeout(timers.current[i]);
    setActive((s) => ({ ...s, [i]: kind }));
    if (ms) timers.current[i] = setTimeout(() => hovered.current !== i && hide(i), ms);
  };
  const hide = (i: number) => { clearTimeout(timers.current[i]); setActive((s) => { const c = { ...s }; delete c[i]; return c; }); };
  useEffect(() => {
    if (reduced || !idle) return;
    const t: any[] = [];
    for (let i = 0; i < n; i++) t.push(setTimeout(() => show(i), i * 40)); // opening: every letter becomes a sticker, then returns
    [...Array(n).keys()].sort(() => Math.random() - .5).forEach((i, k) => t.push(setTimeout(() => hide(i), 40 * n + 700 + 45 * k)));
    let auto: any;
    const loop = () => { auto = setTimeout(() => { if (hovered.current === null && !document.hidden) show(Math.floor(Math.random() * n), 1000); loop(); }, 1300 + Math.random() * 1500); };
    t.push(setTimeout(loop, 40 * n + 1500));
    return () => { t.forEach(clearTimeout); clearTimeout(auto); Object.values(timers.current).forEach(clearTimeout); };
  }, []);
  const point = (e: { clientX: number; clientY: number }) => {
    const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-pos]") as HTMLElement | null;
    const next = el ? Number(el.dataset.pos) : null;
    if (next === hovered.current) return;
    const old = hovered.current; hovered.current = next;
    if (old !== null) hide(old);
    if (next !== null) show(next);
  };
  const leave = () => { const old = hovered.current; hovered.current = null; if (old !== null) hide(old); };
  return <h1 className="ed-title" aria-label={text} onPointerMove={point} onPointerDown={point} onPointerLeave={leave} onPointerCancel={leave}>
    {/* letters grouped per word so narrow screens wrap between words, never inside one */}
    {text.split(" ").map((w, wi, ws) => { const start = ws.slice(0, wi).reduce((n, x) => n + x.length + 1, 0);
      return <span key={wi} className="ed-word">{Array.from(w).map((c, j) => <Letter key={j} ch={c} pos={positions[start + j]} kind={active[positions[start + j]]} />)}</span>; })}
  </h1>;
}
function Letter({ ch, pos, kind }: { ch: string; pos: number; kind?: Kind }) {
  const [shown, setShown] = useState<Kind | undefined>(kind), ref = useRef<HTMLSpanElement>(null), anim = useRef<Animation | null>(null);
  const angle = [-9, 7, -5, 8, -7, 6, -4][pos % 7], y = [3, -2, 2, -3, 1, 3, -1][pos % 7];
  useEffect(() => { if (kind) setShown(kind); }, [kind]);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    anim.current?.cancel(); // a cancelled exit never fires onfinish, so a quick re-hover keeps its sticker
    if (kind && shown === kind) anim.current = el.animate(spring(angle, y), { duration: 340, fill: "both" });
    else if (!kind && shown) {
      const a = el.animate([{ transform: `translate(-50%, -50%) rotate(${angle}deg) scale(1)`, opacity: 1 }, { transform: `translate(-50%, -50%) rotate(${angle}deg) scale(1.055)`, opacity: 1, offset: .2 },
        { transform: `translate(-50%, -50%) rotate(${angle}deg) scale(.7)`, opacity: .42, offset: .62 }, { transform: `translate(-50%, -50%) rotate(${angle}deg) scale(.35)`, opacity: 0 }], { duration: 620, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
      a.onfinish = () => setShown(undefined); anim.current = a;
    }
  }, [kind, shown]);
  return <span className={`ed-letter ${kind ? "on" : shown ? "returning" : ""}`} data-pos={pos}>
    <span className="ed-char">{ch}</span>
    {shown && <span className="ed-sticker" ref={ref}><Sticker kind={shown} ch={ch} /></span>}
  </span>;
}
function LocalClock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const i = setInterval(() => setT(new Date()), 10000); return () => clearInterval(i); }, []);
  return <time dateTime={t.toISOString()}>{t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</time>;
}

// ---------------- landing: playful line-doodle style ----------------
const Sparkle = ({ size = 26, color = "#c6f432", style }: { size?: number; color?: string; style?: any }) =>
  <svg className="gm-doodle" width={size} height={size} viewBox="0 0 40 40" style={style} aria-hidden><path d="M20 2c1.6 9.6 8.4 16.4 18 18-9.6 1.6-16.4 8.4-18 18-1.6-9.6-8.4-16.4-18-18 9.6-1.6 16.4-8.4 18-18z" fill={color} stroke="#111" strokeWidth="2.2" strokeLinejoin="round" /></svg>;
/** Googly eyes that follow the pointer. */
function Eyes({ size = 46, style, className = "" }: { size?: number; style?: any; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null), [p, setP] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const move = (e: PointerEvent) => { const r = ref.current?.getBoundingClientRect(); if (!r) return; const a = Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2); setP({ x: Math.cos(a) * 4, y: Math.sin(a) * 4 }); };
    addEventListener("pointermove", move); return () => removeEventListener("pointermove", move);
  }, []);
  return <span ref={ref} className={`gm-eyes ${className}`} style={style} aria-hidden>{[0, 1].map((i) => <svg key={i} width={size / 2} height={size / 2 * 1.15} viewBox="0 0 24 28">
    <ellipse cx="12" cy="14" rx="10.5" ry="12.5" fill="#fff" stroke="#111" strokeWidth="2.2" /><circle cx={12 + p.x} cy={15 + p.y} r="4.6" fill="#111" /><circle cx={13.6 + p.x} cy={13.4 + p.y} r="1.3" fill="#fff" /></svg>)}</span>;
}
/** A word circled with a lime marker. */
const Circled = ({ children }: { children: ReactNode }) => <span className="gm-circled">{children}<svg viewBox="0 0 200 80" preserveAspectRatio="none" aria-hidden>
  <path d="M30 14C80 2 170 4 190 30s-40 44-110 42S6 58 10 36 50 10 100 10" fill="none" stroke="#c6f432" strokeWidth="7" strokeLinecap="round" /></svg></span>;

/** "for yourself / your group chat / your team" — the audience word flips through, each in its own marker colour. */
function Rotator() {
  const words: [string, string][] = [["yourself", "#c6f432"], ["your group chat", "#c6f432"], ["your team", "#c6f432"]];
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % words.length), 2200); return () => clearInterval(t); }, []);
  return <span className="gm-rot" aria-live="polite"><span key={i} className="gm-rot-word" style={{ background: words[i][1] }}>{words[i][0]}</span>,</span>;
}
/** Every chat app is a chunky tilted tile with a sample message bobbing above it. */
function ChannelParade() {
  const ch: [string, string, string][] = [["imessage", "iMessage", "Reese, table for 4 Fri? 🍽️"], ["whatsapp", "WhatsApp", "Tab, who owes what? 🧾"], ["slack", "Slack", "@Max action items pls 📝"],
    ["telegram", "Telegram", "Plans, poll: Sat or Sun? 📊"], ["web", "Web & phone", "Dash, brief me ☀️"], ["email", "Email", "cc Leo on this 📈"]];
  return <div className="gm-parade" aria-label="Works in iMessage, WhatsApp, Slack, Telegram, the web and email">
    {ch.map(([p, name, msg], i) => <div key={p} className="gm-app" style={{ "--tilt": `${[-3, 2, -2, 3, -2, 2][i]}deg` } as any}>
      <span className="gm-say">{msg}</span>
      <span className={`gm-tile p-${p}`}><svg viewBox="0 0 24 24" width="34" height="34" aria-hidden>{PICON[p]}</svg></span>
      <span className="gm-app-name">{name}</span></div>)}
  </div>;
}

/** Fades its children up once they scroll into view. */
function Reveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), [on, setOn] = useState(false);
  useEffect(() => { const io = new IntersectionObserver(([e]) => e.isIntersecting && setOn(true), { threshold: .2 }); ref.current && io.observe(ref.current); return () => io.disconnect(); }, []);
  return <div ref={ref} className={`gm-reveal ${on ? "in" : ""}`}>{children}</div>;
}

/** Scroll progress (0..1) through a tall element, measured against its scrolling container. */
function useScrollProgress(ref: { current: HTMLElement | null }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const scroller: any = el.closest(".landing") ?? window;
    let raf = 0;
    const update = () => { raf = 0; const r = el.getBoundingClientRect(), vh = innerHeight; setP(Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - vh)))); };
    const on = () => { if (!raf) raf = requestAnimationFrame(update); };
    update(); scroller.addEventListener("scroll", on, { passive: true }); addEventListener("resize", on);
    return () => { scroller.removeEventListener("scroll", on); removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, []);
  return p;
}

// The storyline: a pinned stage plays one chapter per screen of scrolling, scrubbed by scroll position (nothing autoplays).
const CHAPTERS: [string, string, string][] = [
  ["01", "It starts with one sentence.", "Say what you need like you'd text a friend. No forms, no prompt engineering."],
  ["02", "We turn it into an agent.", "The right abilities and the right guardrails. It asks before it sends, books or pays."],
  ["03", "Try it where nothing can break.", "A sandbox chat runs the real tools, but nothing leaves until you're happy."],
  ["04", "Drop it into any chat.", "iMessage, WhatsApp, Telegram, Slack, the web or email: 1:1 or the whole group."],
  ["05", "And now it just… helps.", "Everyone asks it by name. Splits, polls, bookings, reminders, right where you already talk."],
];
const STORY_IDEA = "Split our ski trip costs and tell everyone who owes what";
function Story() {
  const ref = useRef<HTMLDivElement>(null), p = useScrollProgress(ref);
  const n = CHAPTERS.length, at = Math.min(n - 1, Math.floor(p * n)), local = Math.min(1, p * n - at); // chapter + progress inside it
  const reached = (x: number) => local >= x;
  const typed = STORY_IDEA.slice(0, Math.ceil(Math.min(1, local / .7) * STORY_IDEA.length));
  const fly = Math.min(1, local / .55); // chapter 4: the agent travels into the iMessage tile
  const stage = [
    <div key="d" className="st-card st-describe"><div className="small muted" style={{ marginBottom: 8 }}>What should your agent do?</div>
      <div className="st-typed">{typed}<span className="st-caret" /></div>
      <div className="row" style={{ justifyContent: "flex-end" }}><span className={`gm-btn ${typed.length === STORY_IDEA.length ? "dark" : ""}`} style={{ pointerEvents: "none" }}>Build my agent →</span></div></div>,
    <div key="b" className="st-card st-agent"><div className="row" style={{ gap: 12 }}><div className={`st-av ${reached(.05) ? "in" : ""}`}>🧾</div><div><h3 style={{ font: "800 22px Rubik, sans-serif" }}>Tab</h3><div className="small muted">Expense splitter</div></div></div>
      {[["💸", "Splits costs, to the cent", .2], ["📊", "Says who owes who", .4], ["⏰", "Nudges people to pay up", .6], ["✋", "Never moves money: you approve", .8]].map(([e, t, x]) =>
        <div key={t as string} className={`st-row ${reached(x as number) ? "in" : ""}`}><span>{e}</span>{t}<b>✓</b></div>)}</div>,
    <div key="t" className="st-card st-chat"><span className="st-test">🧪 Test mode</span>
      <div className={`bub me ${reached(.1) ? "" : "st-hidden"}`}>I paid $90 for gas</div>
      <div className={`bub bot ${reached(.4) ? "" : "st-hidden"}`}>💸 $90 split 3 ways: $30 each. Sam and Leo owe you $30.</div>
      <div className={`st-note ${reached(.7) ? "" : "st-hidden"}`}>Nothing was sent. Looks right? Ship it.</div></div>,
    <div key="c" className="st-deploy">
      <div className="st-fly" style={{ transform: `translate(${-104 * fly}px, ${97 * fly}px) scale(${1 - .3 * fly})`, opacity: fly >= 1 ? 0 : 1 }}>🧾</div>
      <div className="st-tiles">{["imessage", "whatsapp", "telegram", "slack", "web", "email"].map((x, i) =>
        <span key={x} className={`gm-tile p-${x} ${i === 0 && reached(.6) ? "st-live" : ""}`} style={{ "--tilt": "0deg" } as any}><svg viewBox="0 0 24 24" width="30" height="30" aria-hidden>{PICON[x]}</svg>{i === 0 && reached(.6) && <i>✓</i>}</span>)}</div>
      <div className={`st-note ${reached(.65) ? "" : "st-hidden"}`}>Tab joined “Ski trip 🏔”</div></div>,
    <PhoneMock key="l" count={Math.max(1, Math.ceil(local * (IM_THREAD.length + .5)))} />,
  ];
  return <div className="story" ref={ref} style={{ height: `${n * 85 + 15}vh` }}>
    <div className="story-pin">
      <div className="story-copy">
        <div className="story-dots">{CHAPTERS.map((_, i) => <span key={i} className={i === at ? "on" : i < at ? "done" : ""} />)}</div>
        <div key={at} className="story-text"><span className="story-num">{CHAPTERS[at][0]}</span><h2 className="gm-h2">{CHAPTERS[at][1]}</h2><p className="gm-p">{CHAPTERS[at][2]}</p></div>
      </div>
      <div className="story-stage"><div key={at} className="story-scene">{stage[at]}</div></div>
    </div>
  </div>;
}

// A faithful iMessage group chat. Agents reply from the shared line (saved as the "Agents" contact), so each message starts with
// the agent's name — exactly what people see on their phones.
type IMsg = { from: string; text: string; tapback?: string };
const IM_THREAD: IMsg[] = [
  { from: "Maya", text: "Tab, I paid $240 for the cabin 🏔" },
  { from: "Agents", text: "Tab: Got it — $240 split 4 ways, $60 each. Sam, Leo and Jess each owe Maya $60." },
  { from: "me", text: "Plans, poll: dinner Friday or Saturday?" },
  { from: "Agents", text: "Plans: 📊 Dinner night?\n1. Friday\n2. Saturday\nJust reply with a number." },
  { from: "Sam", text: "2" },
  { from: "Leo", text: "2!" },
  { from: "Maya", text: "saturday 🙌" },
  { from: "Agents", text: "Plans: Saturday it is — 3 votes to 0 🎉", tapback: "❤️" },
];
const IM_FACE: Record<string, string> = { Maya: "M", Sam: "S", Leo: "L", Agents: "✦" };
function PhoneMock({ count }: { count?: number }) {
  const shown = IM_THREAD.slice(0, count ?? IM_THREAD.length);
  const lastMine = shown.map((m) => m.from).lastIndexOf("me");
  return <div className="phone ios" aria-hidden><div className="scr">
    <div className="ios-status"><span>9:41</span><i className="ios-island" /><span className="ios-icons">
      <svg width="17" height="11" viewBox="0 0 17 11"><rect x="0" y="7" width="3" height="4" rx="1" /><rect x="4.5" y="5" width="3" height="6" rx="1" /><rect x="9" y="2.5" width="3" height="8.5" rx="1" /><rect x="13.5" y="0" width="3" height="11" rx="1" /></svg>
      <svg width="15" height="11" viewBox="0 0 15 11"><path d="M7.5 2.2c2.1 0 4 .8 5.4 2.2l1.1-1.1A9.2 9.2 0 0 0 7.5.6 9.2 9.2 0 0 0 1 3.3l1.1 1.1a7.6 7.6 0 0 1 5.4-2.2Zm0 3.2c1.2 0 2.3.5 3.1 1.3l1.1-1.1a5.9 5.9 0 0 0-8.4 0l1.1 1.1c.8-.8 1.9-1.3 3.1-1.3Zm0 3.2c-.4 0-.8.2-1.1.5L7.5 10.2 8.6 9.1a1.6 1.6 0 0 0-1.1-.5Z" /></svg>
      <span className="ios-batt"><i /></span></span></div>
    <div className="ios-hd">
      <span className="ios-back"><svg width="11" height="18" viewBox="0 0 11 18"><path d="M9.5 1.5 2 9l7.5 7.5" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg><b>12</b></span>
      <div className="ios-faces">{["M", "S", "L", "✦"].map((c) => <span key={c}>{c}</span>)}</div>
      <div className="ios-name">Ski trip 🏔 <svg width="6" height="10" viewBox="0 0 6 10"><path d="m1 1 4 4-4 4" fill="none" strokeWidth="1.5" strokeLinecap="round" /></svg></div>
    </div>
    <div className="ios-thread">
      <div className="ios-stamp"><b>iMessage</b><br />Today 7:41 PM</div>
      {shown.map((m, i) => {
        const mine = m.from === "me", firstOfRun = i === 0 || shown[i - 1].from !== m.from, lastOfRun = i === shown.length - 1 || shown[i + 1]?.from !== m.from;
        return <div key={i} className={`ios-row ${mine ? "me" : "them"}${lastOfRun ? " tail" : ""}`} style={{ animationDelay: count == null ? `${i * 0.35}s` : "0s" }}>
          {!mine && firstOfRun && <div className="ios-who">{m.from}</div>}
          <div className="ios-line">
            {!mine && <span className={`ios-av${lastOfRun ? "" : " ghost"}`}>{IM_FACE[m.from]}</span>}
            <div className="ios-bub">{m.text}{m.tapback && <span className="ios-tap">{m.tapback}</span>}</div>
          </div>
          {mine && i === lastMine && <div className="ios-receipt">Delivered</div>}
        </div>;
      })}
    </div>
    <div className="ios-compose"><span className="ios-plus">+</span><span className="ios-field">iMessage<svg width="12" height="16" viewBox="0 0 12 16"><rect x="3.5" y="1" width="5" height="9" rx="2.5" /><path d="M1 7.5a5 5 0 0 0 10 0M6 12.5V15" fill="none" strokeWidth="1.4" strokeLinecap="round" /></svg></span></div>
  </div></div>;
}

function Landing({ onDone }: { onDone: () => void }) {
  const [idea, setIdea] = useState(""), [aud, setAud] = useState<Aud>("group"), [auth, setAuth] = useState<null | "signup" | "login">(null);
  const save = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const ideas = useRef<HTMLElement>(null), how = useRef<HTMLElement>(null), describe = useRef<HTMLDivElement>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && setAuth(null); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, []);
  const go2 = (r: { current: HTMLElement | null }) => r.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  return <div className="landing gm">
    <nav className="gm-nav">
      <div className="gm-logo">agents<Eyes size={26} /></div>
      <div className="gm-links"><button onClick={() => go2(how)}>How it works</button><button onClick={() => go2(ideas)}>Agents</button><button onClick={() => describe.current?.querySelector("textarea")?.focus()}>Build one</button></div>
      <div className="row" style={{ gap: 14 }}><button className="gm-link" onClick={() => setAuth("login")}>Sign in</button><button className="gm-btn dark" onClick={() => setAuth("signup")}>Get started</button></div>
    </nav>

    <section className="gm-hero">
      <Sparkle size={22} style={{ left: "12%", top: 70 }} />
      <p className="gm-hand">psst… hover the letters ↓</p>
      <div className="gm-title-wrap"><LetterHero text="deploy your agent" idle={false} /></div>
      <p className="gm-for"><span>for</span><Rotator /><span className="gm-anywhere">anywhere.</span></p>
      <ChannelParade />
      <p className="gm-sub">Describe a helper in plain words, try it safely, then drop it into the chats you already use — 1:1, the group chat, or your team's channels. One agent, same memory everywhere.</p>
      <div className="gm-ctas"><button className="gm-btn dark" onClick={() => describe.current?.querySelector("textarea")?.focus()}>Build my agent</button>
        <button className="gm-btn" onClick={() => go2(ideas)}>Browse agents</button></div>
    </section>

    <section className="gm-sec gm-describe" ref={describe as any}>
      <div className="gm-bubble">
        <div className="gm-tabs" role="tablist" aria-label="Who is it for">{AUDIENCE.map(([k, e, l]) => <button key={k} role="tab" aria-selected={aud === k} className={aud === k ? "on" : ""} onClick={() => setAud(k)}>{e} {l}</button>)}</div>
        <DescribeBox value={idea} onChange={setIdea} audience={aud} onSubmit={() => { save("pendingIdea", { idea, aud }); setAuth("signup"); }} />
        <div className="row wrap mt16" style={{ gap: 8 }}>{EXAMPLES[aud].slice(0, 3).map((x) => <button key={x} className="gm-chip" onClick={() => setIdea(x)}>{x.length > 46 ? x.slice(0, 44) + "…" : x}</button>)}</div>
      </div>
    </section>

    <section ref={how}><Story /></section>

    <section className="gm-sec" ref={ideas}>
      <Reveal><h2 className="gm-h2" style={{ textAlign: "center" }}>Meet the crew</h2>
      <p className="gm-p" style={{ textAlign: "center", margin: "0 auto 26px" }}>20 agents people actually use. Try one, then add it in a click.</p></Reveal>
      <IdeaGallery cat="all" anonymous onPick={(t) => { save("pendingTemplate", t.slug); setAuth("signup"); }} />
    </section>

    <section className="gm-sec gm-end">
      <Reveal><h2 className="gm-h2">Your group chat just got<br />a new <Circled>friend</Circled></h2></Reveal>
      <div className="gm-ctas"><button className="gm-btn dark" onClick={() => setAuth("signup")}>Start for free</button></div>
      <p className="gm-fine">Agents ask before they send, book or pay · Your data stays in your workspace</p>
    </section>
    {auth && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setAuth(null)}><div className={CLERK_KEY ? "modal bare" : "modal"}><Auth initial={auth} onDone={onDone} /></div></div>}
  </div>;
}

const clerkLook = {
  variables: { colorPrimary: "#111", colorText: "#111", colorBackground: "#fff", fontFamily: "Inter, -apple-system, sans-serif", borderRadius: "12px" },
  elements: { cardBox: { border: "2px solid #111", boxShadow: "6px 6px 0 #c6f432" }, formButtonPrimary: { background: "#111", boxShadow: "0 3px 0 #c6f432", fontWeight: 700, textTransform: "none" } },
};
// Our words on Clerk's screens (the dashboard's application name still shows in Clerk's emails).
const clerkText = {
  signIn: { start: { title: "Sign in to agents", titleCombined: "Continue to agents", subtitle: "Build an agent, then drop it in your group chat.", subtitleCombined: "Build an agent, then drop it in your group chat." } },
  signUp: { start: { title: "Create your agents account", subtitle: "Takes a minute." } },
};
/** Clerk signed in but the API has no session yet (fresh sign-in, or back from a Google redirect): trade the Clerk token for one. */
function ClerkBridge({ need, onSynced }: { need: boolean; onSynced: () => void }) {
  const { isSignedIn, getToken } = useAuth();
  useEffect(() => {
    if (!need || !isSignedIn) return;
    getToken().then((token) => api("/v1/auth/clerk", { token })).then(onSynced).catch((e) => console.error("clerk sign-in", e));
  }, [need, isSignedIn]);
  return null;
}

function Auth({ onDone, initial = "signup" }: { onDone: () => void; initial?: "login" | "signup" }) {
  if (CLERK_KEY) return <SignIn routing={"virtual" as any} withSignUp />; // virtual: keeps Clerk off our #/ routes (runtime-supported, missing from the React types). One flow for both: new emails continue into sign-up; ClerkBridge finishes
  const [mode, setMode] = useState(initial), [f, setF] = useState({ name: "", email: "", password: "" }), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const submit = async (e: any) => { e.preventDefault(); setErr(""); setBusy(true); try { await api(`/v1/auth/${mode}`, f); onDone(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } };
  return <div>
    <div className="logo" style={{ padding: "0 0 14px" }}><i />agents</div>
    <h1>{mode === "signup" ? "Create your free account" : "Welcome back"}</h1>
    <p className="muted">{mode === "signup" ? "Then we'll build your agent — it takes a minute." : "Pick up where you left off."}</p>
    <form className="col mt16" onSubmit={submit}>
      {mode === "signup" && <input className="input" placeholder="Your name" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
      <input className="input" placeholder="Email" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <input className="input" placeholder="Password (8+ characters)" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      {err && <div className="pill bad">{err}</div>}
      <button className="btn grad lg" disabled={busy}>{mode === "signup" ? "Create account" : "Sign in"}</button>
      <button type="button" className="btn ghost small" onClick={() => setMode(mode === "login" ? "signup" : "login")}>{mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}</button>
    </form>
  </div>;
}

// ---------------- shell ----------------
function App() {
  const route = useHash();
  const [path, qs] = route.split("?");
  const [me, reloadMe, meErr] = useApi<any>("/v1/me");
  const [ws, setWsState] = useState<string>(() => localStorage.getItem("ws") ?? "");
  const [msg, setMsg] = useState("");
  const toast = (s: string) => { setMsg(s); setTimeout(() => setMsg(""), 2600); };
  const setWs = (w: string) => { localStorage.setItem("ws", w); setWsState(w); };
  useEffect(() => { if (me && !me.workspaces.find((w: any) => w.id === ws)) setWs(me.workspaces[0]?.id); }, [me]);
  // Reminders and "Saturday 7pm" happen in your zone: the browser knows it.
  useEffect(() => { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (me && tz && me.user.tz !== tz) api("/v1/me/tz", { tz }).catch(() => {}); }, [me?.user?.id]);
  const [home] = useApi<any>(me && ws ? `/v1/home?workspace=${ws}` : null, 5000);
  useEffect(() => { document.querySelector(".main")?.scrollTo(0, 0); }, [path]);
  // A template picked on the landing page before signing up gets installed right after.
  useEffect(() => {
    if (!me || !ws) return;
    let slug: string | null = null; try { slug = JSON.parse(localStorage.getItem("pendingTemplate") ?? "null"); localStorage.removeItem("pendingTemplate"); } catch {}
    if (slug) api(`/v1/agent-templates/${slug}/install`, { workspace_id: ws }).then((r) => go(`/agents/${r.agent.id}/launch`)).catch((e) => toast(e.message));
  }, [me?.user?.id, ws]);

  if (path.startsWith("/discover") && !me) return <div className="page"><Discover route={path} anonymous /></div>;
  const afterAuth = () => { reloadMe(); go(localStorage.getItem("pendingIdea") ? "/agents/new" : "/"); };
  if (meErr && !me) return <>{CLERK_KEY && <ClerkBridge need onSynced={afterAuth} />}<Landing onDone={afterAuth} /></>;
  if (!me || !ws || !me.workspaces.some((w: any) => w.id === ws)) return <div className="page muted">Loading…</div>; // stale ws from another session gets replaced first
  const attention = home ? home.needs_attention.approvals.length + home.needs_attention.waits.length + home.needs_attention.reconnect.length : 0;
  const nav = [["/", "Home", "⌂"], ["/agents", "Agents", "◎"], ["/rooms", "Chats", "◇"], ["/tasks", "Tasks", "☑"], ["/discover", "Ideas", "✦"], ["/connections", "Connections", "⟷"], ["/activity", "Activity", "≡"]];
  const on = (p: string) => (p === "/" ? path === "/" : path.startsWith(p) && !(p === "/agents" && path === "/agents/new"));
  const wide = /^\/rooms\/[^/]+$/.test(path);
  const seg = path.split("/");
  return <Ctx.Provider value={{ me, ws, setWs, toast, reloadMe }}>
    <div className="app">
      <nav className="rail" aria-label="Main">
        <div className="logo">agents<Eyes size={24} /></div>
        <a className="new" href="#/agents/new">＋ New agent</a>
        {me.workspaces.length > 1 && <select className="ws-switch" aria-label="Workspace" value={ws} onChange={(e) => { setWs(e.target.value); go("/"); }}>
          {me.workspaces.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}
        {nav.map(([p, l, i]) => <a key={p} href={`#${p}`} className={on(p) ? "on" : ""}><span className="ic">{i}</span>{l}{p === "/" && attention > 0 && <span className="count">{attention}</span>}</a>)}
        <div className="sep" />
        <a href="#/settings" className={on("/settings") ? "on" : ""}><span className="ic">⚙</span>Settings</a>
      </nav>
      <main className="main"><div key={path} className={`page ${wide ? "wide" : ""}`}>
        {path === "/" ? <Home /> : path === "/agents" ? <Agents /> : path === "/agents/new" ? <CreateAgent />
          : path.startsWith("/agents/") && seg[3] === "launch" ? <Launch id={seg[2]} aud={(new URLSearchParams(qs).get("aud") as Aud) ?? "me"} />
          : path.startsWith("/agents/") ? <AgentPage id={seg[2]} tab={seg[3]} />
          : path === "/rooms" ? <Rooms /> : path.startsWith("/rooms/") ? <Room id={seg[2]} /> : path.startsWith("/discover") ? <Discover route={path} />
          : path.startsWith("/connections") ? <Connections /> : path === "/activity" ? <Activity /> : path === "/tasks" ? <Tasks /> : path.startsWith("/settings") ? <Settings />
          : path.startsWith("/invite/") ? <AcceptInvite token={seg[2]} /> : <div className="empty">Not found</div>}
      </div></main>
    </div>
    {msg && <div className="toast" role="status">{msg}</div>}
  </Ctx.Provider>;
}

// ---------------- Home & Agents ----------------
function AgentCard({ a }: { a: any }) {
  const lives = (a.deployed ?? ["web"]).filter((p: string) => p !== "web");
  return <a className="card hover idea" href={`#/agents/${a.id}`}>
    <div className="top"><div className="avatar lg">{a.avatar}</div><div className="grow"><h3>{a.name}</h3><div className="small muted">{titleOf(a)}</div></div>
      {a.active_runs?.length || a.active_runs > 0 ? <span className="pill accent"><span className="dot live" />Working</span> : a.status !== "active" ? <span className="pill">Paused</span> : null}</div>
    <div className="tag" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{a.job}</div>
    <div className="row small muted">{lives.length ? <>{lives.map((p: string) => <PMark key={p} p={p} size="sm" />)}<span>Live in {lives.map((p: string) => PLATFORM[p] ?? p).join(", ")}</span></>
      : <span style={{ color: "var(--accent-text)", fontWeight: 560 }}>Add to a chat →</span>}</div>
  </a>;
}
const NewAgentCard = () => <a className="card hover" href="#/agents/new" style={{ display: "grid", placeItems: "center", borderStyle: "dashed", minHeight: 150, color: "var(--muted)", boxShadow: "none" }}>
  <div style={{ textAlign: "center" }}><div style={{ fontSize: 26 }}>＋</div><b>New agent</b><div className="small">Describe it in plain words</div></div></a>;

function Home() {
  const { ws, me } = useCtx();
  const [d, reload] = useApi<any>(`/v1/home?workspace=${ws}`, 4000);
  const [agents] = useApi<any[]>(`/v1/agents?workspace=${ws}`, 10000);
  const [idea, setIdea] = useState(""), [aud, setAud] = useState<Aud>("me");
  if (!d || !agents) return null;
  const hour = new Date().getHours(), att = d.needs_attention;
  const n = att.approvals.length + att.waits.length + att.reconnect.length;
  const build = () => { try { localStorage.setItem("pendingIdea", JSON.stringify({ idea, aud })); } catch {} go("/agents/new"); };
  const add = async (t: any) => { const r = await api(`/v1/agent-templates/${t.slug}/install`, { workspace_id: ws }); go(`/agents/${r.agent.id}/launch`); };
  if (!agents.length) return <>
    <h1>Hi {me.user.name.split(" ")[0]} — what should your first agent do?</h1>
    <p className="muted">Describe it in plain words. You'll try it, then add it to your chats.</p>
    <div className="mt16"><div className="seg" style={{ marginBottom: 12 }}>{AUDIENCE.map(([k, e, l]) => <button key={k} className={aud === k ? "on" : ""} onClick={() => setAud(k)}>{e} {l}</button>)}</div>
      <DescribeBox value={idea} onChange={setIdea} audience={aud} onSubmit={build} /></div>
    <h2>Or start from an idea</h2><IdeaGallery cat={aud} onPick={add} />
  </>;
  return <>
    <h1>Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}, {me.user.name.split(" ")[0]}</h1>
    <p className="muted">{n ? `${n} thing${n > 1 ? "s" : ""} need${n === 1 ? "s" : ""} you.` : "Nothing needs you right now."}</p>
    {n > 0 && <><h2>Needs you <span className="pill accent">{n}</span></h2><div className="col">
      {att.approvals.map((a: any) => <ApprovalCard key={a.id} a={a} onDone={reload} />)}
      {att.reconnect.map((c: any) => <div key={c.id} className="card row"><span className="pill warn">Reconnect</span><span className="grow">{c.provider} ({c.account}) needs to be reconnected; agent work is paused.</span><a className="btn" href={`/v1/connections/google/start?workspace=${ws}&reconnect=${c.id}`}>Reconnect</a></div>)}
      {att.waits.map((w: any) => <WaitCard key={w.id} w={w} onDone={reload} />)}</div></>}
    <h2>Your agents</h2>
    <div className="grid3">{agents.map((a) => <AgentCard key={a.id} a={a} />)}<NewAgentCard /></div>
    {agents.length < 4 && <><h2>More agents people love</h2><IdeaGallery onPick={add} /></>}
    {d.active.length > 0 && <><h2>Working on</h2><div className="list">{d.active.map((r: any) => <a key={r.id} className="item" href={`#/rooms/${r.room_id}`}>
      <div className="avatar">{r.agent_name?.[0]}</div>
      <div className="grow"><div><b>{r.agent_name}</b> <span className="muted">{r.waits[0]?.reason ?? r.objective}</span></div><div className="small faint">{r.room_name} · {ago(r.updated_at)}</div></div>
      <Status s={r.status} /></a>)}</div></>}
    {d.blocked.length > 0 && <><h2>Blocked</h2><div className="list">{d.blocked.map((t: any) => <a key={t.id} className="item" href={`#/rooms/${t.room_id}`}>
      <span className="pill bad">Blocked</span><span className="grow">{t.title}</span><span className="small muted">Owner: {t.owner_name} · {t.room_name}</span></a>)}</div></>}
    {d.completed.length > 0 && <><h2>Recently done</h2><div className="list">{d.completed.map((r: any) => <a key={r.id} className="item" href={`#/rooms/${r.room_id}`}>
      <span style={{ color: "var(--ok)" }}>✓</span><div className="grow"><div>{r.objective.slice(0, 90)}</div><div className="small faint">{r.agent_name} · {r.room_name} · {ago(r.completed_at)}</div></div></a>)}</div></>}
    {d.failed.length > 0 && <><h2>Failed</h2><div className="list">{d.failed.map((r: any) => <a key={r.id} className="item" href={`#/rooms/${r.room_id}`}><span className="pill bad">Failed</span><span className="grow">{r.objective.slice(0, 80)}</span><span className="small muted">{r.error}</span></a>)}</div></>}
  </>;
}

function Agents() {
  const { setWs } = useCtx();
  const [ov] = useApi<any[]>("/v1/overview", 8000);
  return <>
    <div className="row between wrap"><div><h1>Agents</h1><p className="muted">Everyone working for you, and where they live.</p></div>
      <div className="row"><a className="btn" href="#/discover">Browse ideas</a><a className="btn primary" href="#/agents/new">＋ New agent</a></div></div>
    {ov?.map((w) => <div key={w.workspace.id} onClick={() => setWs(w.workspace.id)}>{ov.length > 1 && <h2>{w.workspace.name}</h2>}
      <div className="grid3 mt16">{w.agents.map((a: any) => <AgentCard key={a.id} a={a} />)}<NewAgentCard /></div></div>)}
  </>;
}

// ---------------- builder: describe → review ----------------
function CreateAgent() {
  const { ws, me, setWs, toast, reloadMe } = useCtx();
  const [pending] = useState<any>(() => { try { const p = JSON.parse(localStorage.getItem("pendingIdea") ?? "null"); localStorage.removeItem("pendingIdea"); return p; } catch { return null; } });
  const teams = me.workspaces.filter((w: any) => w.kind === "team");
  const [aud, setAud] = useState<Aud>(pending?.aud ?? (me.workspaces.find((w: any) => w.id === ws)?.kind === "team" ? "team" : "me"));
  const [team, setTeam] = useState<string>(teams[0]?.id ?? "new"), [teamName, setTeamName] = useState("");
  const [desc, setDesc] = useState(pending?.idea ?? ""), [draft, setDraft] = useState<any>(null), [busy, setBusy] = useState(false);
  const [catalog] = useApi<any>("/v1/catalog");
  const personal = me.workspaces.find((w: any) => w.kind === "personal")?.id ?? ws;
  const target = async () => {
    if (aud !== "team") return personal;
    if (team !== "new") return team;
    const w = await api("/v1/workspaces", { name: teamName || "My team" }); reloadMe(); return w.id as string;
  };
  // Interpretation layer: the request becomes an explicit spec (understanding, jobs, routines, questions, boundaries) to confirm before anything exists.
  const propose = async () => {
    if (!desc.trim()) return; setBusy(true);
    try { const sp = await api("/v1/agents/interpret", { description: desc, audience: aud, workspace_id: ws }); setDraft({ ...sp, job: sp.understanding, permissions: [], answers: {} }); }
    catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { if (draft && catalog && !draft.permissions.length) setDraft((d: any) => ({ ...d, permissions: permsFor(d.skills, d) })); }, [!!draft, !!catalog]);
  useEffect(() => { if (pending?.idea) propose(); }, []);
  const permsFor = (skills: string[], d = draft) => {
    const tools = new Set(["memory.remember", "task.create", "task.update", ...skills.flatMap((k) => catalog?.skills.find((x: any) => x.id === k)?.tools ?? [])]);
    return (catalog?.tools ?? []).filter((t: any) => tools.has(t.id)).map((t: any) => d?.permissions?.find((p: any) => p.tool === t.id) ?? { tool: t.id, risk: t.risk, description: t.description,
      mode: t.risk === "financial" || t.risk === "destructive" ? "always_ask" : t.defaultApproval === "none" ? "auto" : t.defaultApproval === "first_time" ? "first_time" : "ask" });
  };
  const setSkills = (skills: string[]) => setDraft({ ...draft, skills, permissions: permsFor(skills),
    connections: [...new Set((catalog?.tools ?? []).filter((t: any) => skills.some((s) => catalog.skills.find((x: any) => x.id === s)?.tools.includes(t.id)) && t.requiresConnection).map((t: any) => t.requiresConnection))] });
  const create = async () => {
    setBusy(true);
    try {
      const w = await target();
      const { answers, permissions, job, ...sp } = draft;
      const a = await api("/v1/agents", { workspace_id: w, name: draft.name, title: draft.title, job: draft.understanding, skills: draft.skills, avatar: draft.avatar, spec: sp, answers,
        permissions: Object.fromEntries(draft.permissions.map((p: any) => [p.tool, p.mode])) });
      setWs(w); go(`/agents/${a.id}/launch?aud=${aud}`);
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const useTemplate = async (t: any) => { try { const w = await target(); const r = await api(`/v1/agent-templates/${t.slug}/install`, { workspace_id: w }); setWs(w); go(`/agents/${r.agent.id}/launch?aud=${aud}`); } catch (e: any) { toast(e.message); } };

  if (!draft) return <>
    <Stepper at={0} />
    <h1>What should your agent do?</h1>
    <p className="muted">Describe the job like you'd tell a friend. You can change anything later.</p>
    <div className="mt24"><div className="small muted" style={{ marginBottom: 8, fontWeight: 560 }}>Who is it for?</div><AudiencePicker value={aud} onChange={setAud} /></div>
    {aud === "team" && <div className="row wrap mt16"><span className="small muted">Team</span>
      <select className="input" style={{ width: 220 }} value={team} onChange={(e) => setTeam(e.target.value)}>{teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}<option value="new">A new team…</option></select>
      {team === "new" && <input className="input" style={{ width: 200 }} placeholder="Team name" value={teamName} onChange={(e) => setTeamName(e.target.value)} />}</div>}
    <div className="mt16"><DescribeBox value={desc} onChange={setDesc} onSubmit={propose} audience={aud} busy={busy} /></div>
    <div className="row wrap mt16" style={{ gap: 6 }}>{EXAMPLES[aud].map((x) => <button key={x} className="chip" onClick={() => setDesc(x)}>{x.length > 52 ? x.slice(0, 50) + "…" : x}</button>)}</div>
    <h2>Or start from a ready-made agent</h2>
    <IdeaGallery cat={aud} onPick={useTemplate} />
  </>;

  const unused = (catalog?.skills ?? []).filter((x: any) => !draft.skills.includes(x.id));
  const set = (k: string, v: any) => setDraft({ ...draft, [k]: v });
  const DAY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const when = (r: any) => `${r.every === "weekly" ? `Every ${DAY[r.day ?? 1].slice(0, -1)}` : r.every === "weekdays" ? "Weekdays" : "Every day"} at ${((r.hour + 11) % 12) + 1}${r.hour < 12 ? "am" : "pm"}`;
  return <>
    <Stepper at={1} onPick={(i) => i === 0 && setDraft(null)} />
    <div className="card profile rise">
      <div className="banner" />
      <div className="body">
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <div className="avatar xl">{draft.avatar}</div>
          <div className="grow" style={{ paddingTop: 2 }}>
            <input className="input" aria-label="Agent name" style={{ fontSize: 26, fontWeight: 700, border: 0, padding: 0, background: "transparent", boxShadow: "none", letterSpacing: "-.02em" }} value={draft.name} onChange={(e) => set("name", e.target.value)} />
            <div className="muted">{draft.title}</div></div></div>

        <div className="draft"><h4>Here's what I understood</h4></div>
        <textarea className="input" aria-label="What the agent should do" rows={2} value={draft.understanding} onChange={(e) => set("understanding", e.target.value)} />
        <div className="small faint mt8">Not quite? Edit it, or go back and add detail.</div>

        {draft.questions.length > 0 && <><div className="draft"><h4>A few quick questions</h4></div>
          <div className="col" style={{ gap: 10 }}>{draft.questions.map((q: any) => <label key={q.id} className="field">{q.q}
            <input className="input" placeholder={q.default ? `Default: ${q.default}` : "Your answer"} value={draft.answers[q.id] ?? ""} onChange={(e) => set("answers", { ...draft.answers, [q.id]: e.target.value })} />
            <span className="small faint" style={{ fontWeight: 400 }}>Why: {q.why}</span></label>)}</div></>}

        <div className="split mt16">
          <div><div className="draft"><h4>What {draft.name || "it"} will do</h4></div>
            {draft.jobs.map((j: string, i: number) => <div key={i} className="ability"><span className="e">✓</span><span className="grow">{j}</span></div>)}
            <div className="draft"><h4>On its own</h4></div>
            {draft.routines.length ? draft.routines.map((r: any, i: number) => <div key={i} className="ability"><span className="e">⏰</span><span className="grow"><b>{when(r)}</b><div className="small muted">{r.objective}</div></span>
              <button className="btn sm ghost" aria-label="Remove routine" onClick={() => set("routines", draft.routines.filter((_: any, k: number) => k !== i))}>✕</button></div>)
              : <div className="ability"><span className="e">💬</span><span className="grow muted">Only when someone asks. Say "every morning…" to give it a routine.</span></div>}
            <div className="draft"><h4>Abilities</h4></div>
            {draft.skills.map((x: string) => { const [e, t] = abilityOf(x); return <div key={x} className="ability"><span className="e">{e}</span><span className="grow">{t}</span>
              <button className="btn sm ghost" aria-label={`Remove ${t}`} onClick={() => setSkills(draft.skills.filter((y: string) => y !== x))}>✕</button></div>; })}
            {unused.length > 0 && <select className="input mt8" value="" onChange={(e) => e.target.value && setSkills([...draft.skills, e.target.value])}>
              <option value="">＋ Add an ability…</option>{unused.map((x: any) => <option key={x.id} value={x.id}>{abilityOf(x)[0]} {abilityOf(x)[1]}</option>)}</select>}</div>
          <div><div className="draft"><h4>Boundaries</h4></div>
            {draft.boundaries.map((b: string, i: number) => <div key={i} className="ability"><span className="e">✋</span><span className="grow">{b}</span></div>)}
            <div className="draft"><h4>You'll know it's working when</h4></div>
            {draft.success.map((b: string, i: number) => <div key={i} className="ability"><span className="e">🎯</span><span className="grow">{b}</span></div>)}
            {draft.data_needs?.length > 0 && <><div className="draft"><h4>Where its information comes from</h4></div>
              {draft.data_needs.map((d: any, i: number) => { const [e, l] = ({ "built-in": ["✅", "Built in"], connect: ["🔗", "Connect an account"], website: ["🧭", "Reads the website"], web: ["🔎", "Web search, cited"], ask: ["💬", "You'll tell it once"], none: ["⚠️", "No reliable source yet — it will say so, not guess"] } as any)[d.how] ?? ["•", d.how];
                return <div key={i} className="ability"><span className="e">{e}</span><span className="grow">{d.need}<div className="small muted">{l}{d.detail ? ` · ${d.detail}` : ""}</div></span></div>; })}</>}
            <div className="draft"><h4>Needs access to</h4></div>
            {draft.connections.length ? draft.connections.map((c: string) => <div key={c} className="ability"><span className="e">🔗</span><span className="grow">{c === "google" ? "Gmail + Google Calendar" : c}<div className="small faint">Connect after creating. Until then it rehearses with sample data.</div></span></div>)
              : <div className="ability"><span className="e">⚡</span><span className="grow muted">Nothing. It works right away.</span></div>}
            <div className="draft"><h4>We'll rehearse it with</h4></div>
            {draft.rehearsal.map((r: any, i: number) => <div key={i} className="ability"><span className="e">🧪</span><span className="grow">“{r.say}”</span></div>)}</div>
        </div>
        <details className="mt16"><summary className="small muted">Fine-tune permissions ▸</summary><div className="mt8"><PermissionRows rows={draft.permissions} onChange={(t, m) => setDraft({ ...draft, permissions: draft.permissions.map((p: any) => p.tool === t ? { ...p, mode: m } : p) })} /></div></details>
        <div className="row mt24"><button className="btn ghost" onClick={() => setDraft(null)}>← Edit description</button><div className="grow" />
          <button className="btn grad lg" disabled={busy || !draft.name.trim()} onClick={create}>{busy ? "Creating…" : `Looks right: create & rehearse`} →</button></div>
      </div>
    </div>
  </>;
}

// ---------------- launch: try it → add to a chat ----------------
function Launch({ id, aud }: { id: string; aud: Aud }) {
  const [a] = useApi<any>(`/v1/agents/${id}`);
  const [step, setStep] = useState(2);
  if (!a) return null;
  return <>
    <Stepper at={step} onPick={(i) => i >= 2 && setStep(i)} />
    <div className="row gap16 wrap" style={{ marginBottom: 18 }}><div className="avatar lg">{a.avatar}</div>
      <div className="grow"><h1>{step === 2 ? `Rehearsal: ${a.name}` : `Add ${a.name} to a chat`}</h1>
        <div className="muted">{step === 2 ? "We ran it through a few real requests in the sandbox. Nothing was sent, booked or paid." : "Pick where your people already talk. Takes about 20 seconds."}</div></div>
      {step === 2 ? <button className="btn grad lg" onClick={() => setStep(3)}>Add to a chat →</button> : <a className="btn" href={`#/agents/${id}`}>Done</a>}</div>
    {step === 2 ? <><Rehearsal a={a} /><h2>Try your own messages</h2><TestPanel a={a} /></> : <ChatPicker a={a} kind={aud === "group" ? "group" : "dm"} prefer={aud === "team" ? "slack" : "imessage"} />}
  </>;
}

/** Runs the spec's rehearsal scenarios in the sandbox and shows a verdict for each before the agent reaches a real chat. */
function Rehearsal({ a }: { a: any }) {
  const { toast } = useCtx();
  const [res, setRes] = useState<any[] | null>(null), [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setRes((await api(`/v1/agents/${a.id}/rehearse`, {})).results); } catch (e: any) { toast(e.message); } finally { setBusy(false); } };
  useEffect(() => { run(); }, [a.id]);
  const mark = { pass: ["✓", "ok"], warn: ["!", "warn"], fail: ["✕", "bad"] } as Record<string, [string, string]>;
  const passed = res?.filter((r) => r.verdict === "pass").length ?? 0;
  return <div className="card">
    <div className="row between"><b>{busy || !res ? "Rehearsing…" : `${passed} of ${res.length} went as expected`}</b><button className="btn sm" disabled={busy} onClick={run}>Run again</button></div>
    {busy && !res && <div className="waiting mt8"><span className="dot live" />Running each scenario in the sandbox<span className="dots"><span /><span /><span /></span></div>}
    {res?.map((r, i) => <div key={i} className="ability"><span className={`pill ${mark[r.verdict][1]}`} style={{ minWidth: 22, justifyContent: "center" }}>{mark[r.verdict][0]}</span>
      <div className="grow"><div><b>“{r.say}”</b></div><div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{r.reply ? r.reply.slice(0, 220) : "—"}</div><div className="small faint">{r.note}</div></div></div>)}
    {res && passed < res.length && <div className="small muted mt8">Not quite right? Go back to the agent's Abilities tab, or tell it in the chat below. It learns from corrections.</div>}
  </div>;
}

function TestPanel({ a }: { a: any }) {
  const { toast } = useCtx();
  const [room, setRoom] = useState<any>(null);
  useEffect(() => { api(`/v1/agents/${a.id}/test-room`, {}).then(setRoom).catch((e) => toast(e.message)); }, [a.id]);
  return <div>
    <div className="row small" style={{ marginBottom: 10, gap: 8 }}><span className="pill warn">🧪 Test mode</span><span className="muted">Tools run for real, but nothing leaves the platform. Unconnected accounts use sample data.</span></div>
    {room && <div className="chatframe"><Room id={room.id} compact /></div>}
  </div>;
}

const GROUPS_OK: Record<string, boolean> = { imessage: true, telegram: true, slack: true, whatsapp: false, web: false, email: false };
function ChatPicker({ a, kind: k0 = "dm", prefer }: { a: any; kind?: "dm" | "group"; prefer?: string }) {
  const { toast } = useCtx();
  const [d, reloadD] = useApi<any>(`/v1/agents/${a.id}/deploy`, 2500);
  const [kind, setKind] = useState<"dm" | "group">(k0), [p, setP] = useState<string | null>(null);
  const [code, setCode] = useState<any>(null), [base, setBase] = useState<number | null>(null), [err, setErr] = useState(""), [chans, setChans] = useState<any[] | null>(null), [adv, setAdv] = useState(false);
  const phone = /iPhone|Android|iPad/i.test(navigator.userAgent);
  const T = (x: string) => d?.targets.find((t: any) => t.platform === x) ?? { platform: x, available: false, connected: [] };
  const live = (x: string) => T(x).connected.filter((c: any) => !!c.is_group === (kind === "group")).length;
  useEffect(() => { if (d && !p) { const first = [prefer, "imessage", "telegram", "whatsapp", "slack", "web"].find((x) => x && T(x).available && (kind === "dm" || GROUPS_OK[x])); setP(first ?? "web"); } }, [d]);
  useEffect(() => {
    setCode(null); setErr(""); setBase(null);
    if (!d || !p || !["imessage", "whatsapp", "telegram"].includes(p) || !T(p).available || (kind === "group" && !GROUPS_OK[p])) return;
    api(`/v1/agents/${a.id}/deploy/${p}`, { kind }).then((r) => { setCode(r); setBase(live(p)); }).catch((e) => setErr(e.message));
  }, [p, kind, !!d]);
  if (!d || !p) return null;
  const opts = kind === "group" ? ["imessage", "whatsapp", "telegram", "slack"] : ["imessage", "whatsapp", "telegram", "slack", "web", "email"];
  const t = T(p), done = code && base !== null && live(p) > base;
  const name = a.name, addr = code?.address || t.address;
  const copy = (s: string) => { navigator.clipboard?.writeText(s); toast("Copied"); };
  const Code = () => code && <span className="code-pill">{code.message}<button className="btn sm ghost" onClick={() => copy(code.message)}>Copy</button></span>;
  const waiting = code && !done && <div className="waiting mt16"><span className="dot live" />Waiting for your message<span className="dots"><span /><span /><span /></span></div>;
  const steps: Record<string, ReactNode> = {
    imessage: kind === "dm" ? <><div>On your iPhone, tap <b>Open Messages</b>{!phone && " — or scan the code with your camera"}.</div><div>Send the message that's filled in: <Code /></div><div>{name} replies right away. Text it anytime, like a friend.</div></>
      : <><div>Open your group chat in Messages and add <b>{addr}</b> to the group.</div><div>Send this in the group: <Code /></div><div>Ask by name — “{name}, …” — and {name} answers everyone.</div></>,
    whatsapp: <><div>Tap <b>Open WhatsApp</b>{!phone && " — or scan the code with your phone"}.</div><div>Send the message that's filled in: <Code /></div><div>{name} replies right away.</div></>,
    telegram: kind === "dm" ? <><div>Tap <b>Open Telegram</b>{!phone && " — or scan the code"}.</div><div>Press <b>Start</b>.</div><div>{name} says hi. That's it.</div></>
      : <><div>Tap <b>Choose a group</b> — Telegram asks which one.</div><div>{name} joins and introduces itself.</div><div>Ask by name — “{name}, …”.</div></>,
  };
  return <div className="col" style={{ gap: 18 }}>
    <div className="row wrap between"><div className="seg">{(["dm", "group"] as const).map((k) => <button key={k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); if (k === "group" && !GROUPS_OK[p]) setP("imessage"); }}>{k === "dm" ? "🙋 Just me" : "💬 A group chat"}</button>)}</div>
      {d.targets.some((x: any) => x.connected?.length) && <div className="row wrap small muted" style={{ gap: 6 }}>Live in:{d.targets.flatMap((x: any) => (x.connected ?? []).map((c: any) =>
        <a key={x.platform + c.conv} className="pill ok" href={`#/rooms/${c.room_id}`}>{PLATFORM[x.platform] ?? x.platform} · {c.is_group ? "group" : "direct"}</a>))}</div>}</div>
    <div className="platforms">{opts.map((x) => { const ok = T(x).available && (kind === "dm" || GROUPS_OK[x]);
      return <button key={x} className={p === x ? "on" : ""} disabled={!ok && x !== "slack"} onClick={() => setP(x)}>
        <PMark p={x} size="lg" /><b>{PLATFORM[x] ?? x}</b><span className="small muted">{!T(x).available ? "Not set up yet" : kind === "group" && !GROUPS_OK[x] ? "1:1 only" : live(x) ? `Live · ${live(x)}` : kind === "group" ? "Add to a group" : x === "web" ? "Link & phone app" : "Text it"}</span>
        {live(x) > 0 && <span className="badge dot" />}</button>; })}</div>

    <div className="card rise" key={p + kind}>
      {done ? <div className="success"><div className="big">✓</div><h1>{name} is live{kind === "group" ? " in your group" : ""} 🎉</h1>
          <p className="muted">{kind === "group" ? `Ask “${name}, …” in the chat — it answers everyone.` : `Text ${name} anytime. It remembers you across every chat.`}</p>
          <div className="row mt16" style={{ justifyContent: "center" }}><a className="btn primary" href={`#/rooms/${T(p).connected.at(-1)?.room_id}`}>Open the conversation</a><button className="btn" onClick={() => { setCode(null); setBase(null); setKind(kind === "dm" ? "group" : "dm"); }}>Add to {kind === "dm" ? "a group" : "another chat"}</button></div></div>
        : !t.available && p !== "slack" ? <div className="col"><h3>{PLATFORM[p]} isn't set up on this server yet</h3>
          <p className="muted small">An admin connects the shared {PLATFORM[p]} line once (see README), and every agent can use it. Or connect your own bot or number below.</p>
          <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setAdv(!adv)}>{adv ? "Hide" : "Use my own"} {PLATFORM[p]} account</button>{adv && <ChannelsEditor a={a} reload={reloadD} />}</div>
        : p === "web" ? <div className="howto"><QR value={t.url} size={148} /><div className="steps"><div>Scan with your phone's camera to open {name}.</div><div>Tap Share → <b>Add to Home Screen</b> for an app icon.</div>
          <div className="row wrap"><a className="btn primary" href={t.url.replace(/^.*#/, "#")}>Open chat here</a><button className="btn" onClick={() => copy(t.url)}>Copy link</button></div></div></div>
        : p === "email" ? <div className="col"><h3>Give {name} an email address</h3><p className="muted small">Email it or CC it on threads; replies stay in the same conversation.</p>
          {t.address ? <span className="code-pill">{t.address}<button className="btn sm ghost" onClick={() => copy(t.address)}>Copy</button></span>
            : <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={async () => { try { await api(`/v1/agents/${a.id}/deploy/email`, {}); reloadD(); } catch (e: any) { toast(e.message); } }}>Create address</button>}</div>
        : p === "slack" ? <div className="col">
          {!t.available ? <><h3>Slack isn't set up on this server yet</h3><p className="muted small">An admin adds the Slack app credentials once (see README).</p></>
            : <><h3>{t.installed?.length ? `Pick a channel for ${name}` : `Add ${name} to your Slack`}</h3>
              {t.installed?.length ? (chans ? <div className="list">{chans.map((c) => <div key={c.id} className="item"><span className="grow">#{c.name}</span>
                <button className="btn sm primary" onClick={async () => { try { await api(`/v1/agents/${a.id}/slack/channels`, { identity: c.identity, channel_id: c.id, name: c.name }); toast(`${name} joined #${c.name}`); reloadD(); } catch (e: any) { toast(e.message); } }}>Add</button></div>)}</div>
                : <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={async () => setChans(await api(`/v1/agents/${a.id}/slack/channels`))}>Show channels</button>) : null}
              <a className={`btn ${t.installed?.length ? "" : "primary"}`} style={{ alignSelf: "flex-start" }} href={t.install_url}>{t.installed?.length ? "Add to another workspace" : "Add to Slack"}</a></>}</div>
        : err ? <div className="pill bad">{err}</div>
        : !code ? <div className="waiting">Getting your link…</div>
        : <div className="howto">{code.link && !phone && <QR value={code.link} size={148} />}
          <div><div className="steps">{steps[p]}</div>
            {code.link && <a className="btn grad lg mt16" href={code.link}>{p === "imessage" && kind === "dm" ? "Open Messages" : p === "whatsapp" ? "Open WhatsApp" : p === "telegram" ? (kind === "group" ? "Choose a group" : "Open Telegram") : "Open"} →</a>}
            {waiting}<div className="small faint mt8">Code expires in {code.expires_in_days} days.</div></div></div>}
    </div>
  </div>;
}

// ---------------- agent profile ----------------
function AgentPage({ id, tab = "overview" }: { id: string; tab?: string }) {
  const { toast } = useCtx();
  const [a, reload] = useApi<any>(`/v1/agents/${id}`, 6000);
  if (!a) return null;
  const tabs = [["overview", "Overview"], ["test", "Try it"], ["deploy", "Add to a chat"], ["skills", "Abilities"], ["memory", "Memory"], ["activity", "Activity"], ["settings", "Settings"]];
  const sect = ({ job: "skills", connections: "skills", permissions: "skills", channels: "deploy", schedule: "settings" } as any)[tab] ?? tab;
  const message = async () => { const r = await api(`/v1/agents/${id}/private-room`, {}); go(`/rooms/${r.id}`); };
  const patch = async (b: any) => { try { await api(`/v1/agents/${id}`, b, "PATCH"); toast("Saved"); reload(); } catch (e: any) { toast(e.message); } };
  const lives = a.deployed?.filter((p: string) => p !== "web") ?? [];
  return <>
    <div className="card profile">
      <div className="banner" />
      <div className="body"><div className="row wrap" style={{ alignItems: "flex-start", gap: 16 }}>
        <div className="avatar xl">{a.avatar}</div>
        <div className="grow" style={{ minWidth: 200 }}><h1 style={{ fontSize: 26 }}>{a.name}</h1><div className="row small muted"><span className={`dot ${a.status === "active" ? "" : "idle"}`} />{a.status === "active" ? "Active" : "Paused"}{titleOf(a) && <> · {titleOf(a)}</>}</div></div>
        <div className="row"><button className="btn" onClick={message}>Open chat</button><a className="btn grad" href={`#/agents/${id}/deploy`}>Add to a chat</a></div></div>
        <p className="mt16" style={{ marginBottom: 0 }}>{a.job}</p>
        <div className="row wrap small muted mt8">{lives.length ? <>Live in {lives.map((p: string) => <span key={p} className="row" style={{ gap: 5 }}><PMark p={p} size="sm" />{PLATFORM[p]}</span>)}</> : "Not in any chat yet."}</div>
      </div></div>
    <div className="tabs">{tabs.map(([t, l]) => <a key={t} className={t === sect ? "on" : ""} href={`#/agents/${id}/${t}`}>{l}</a>)}</div>
    {sect === "overview" && <><SetupChecklist a={a} onMessage={message} />
      {a.data_gaps?.length > 0 && <div className="card mt16"><h3 style={{ margin: 0 }}>Couldn't find data for</h3>
        <p className="small muted" style={{ margin: "4px 0 10px" }}>People asked {a.name} for these and it had no reliable source, so it said so instead of guessing. Connect a source (Connections → MCP) to cover them.</p>
        {a.data_gaps.map((g: any) => <div key={g.need} className="ability"><span className="e">⚠️</span><span className="grow">{g.need}<div className="small muted">{g.category} · asked {g.n}×</div></span></div>)}</div>}
      <div className="split">
        <div className="card"><div className="small muted">What it can do</div><div className="mt8">{a.skills.map((s: string) => { const [e, t] = abilityOf(s); return <div key={s} className="ability"><span className="e">{e}</span><span>{t}</span></div>; })}</div></div>
        <div className="col" style={{ gap: 12 }}>
          <div className="card"><div className="small muted">Doing now</div>{a.active_runs.length ? a.active_runs.map((r: any) => <a key={r.id} href={`#/rooms/${r.room_id}`} className="row mt8"><Status s={r.status} /><span className="grow">{r.objective.slice(0, 90)}</span></a>) : <div className="mt8 muted">Idle — {a.completed_runs} task{a.completed_runs === 1 ? "" : "s"} done so far.</div>}</div>
          <div className="card"><div className="small muted">Chats it's in</div><div className="mt8 col">{a.rooms.length ? a.rooms.map((r: any) => <a key={r.id} href={`#/rooms/${r.id}`}>{r.kind === "private" ? "🙋" : "💬"} {r.name}</a>) : <span className="muted">None yet</span>}</div></div>
          <div className="card"><div className="small muted">Can access</div><div className="mt8 col">{a.connections.length ? a.connections.map((c: any) => <div key={c.id}>🔗 {c.provider} · {c.account} <span className="faint">({c.owner})</span></div>) : <span className="muted">Nothing{a.connections_needed.length ? ` — wants ${a.connections_needed.join(", ")}` : ""}</span>}</div></div>
        </div></div></>}
    {sect === "test" && <TestPanel a={a} />}
    {sect === "deploy" && <ChatPicker a={a} />}
    {sect === "skills" && <><JobEditor a={a} patch={patch} /><h2>Abilities</h2><SkillsEditor a={a} patch={patch} /><h2>Accounts it can use</h2><AgentConnections a={a} reload={reload} />
      <h2>Permissions</h2><div className="card"><PermissionRows rows={a.permission_table} onChange={(t, m) => patch({ permissions: { [t]: m } })} /><p className="small faint mt8">Enforced by the platform before every action. The agent can't change them.</p></div></>}
    {sect === "memory" && <MemoryList agent={a.id} agentName={a.name} />}
    {sect === "activity" && <Activity agent={a.id} />}
    {sect === "settings" && <><div className="card col">
      <label className="field">Before starting work<select className="input" value={a.confirm_mode ?? "smart"} onChange={(e) => patch({ confirm_mode: e.target.value })}>
        <option value="smart">Smart — ask only when unclear, multi-step, or several external actions</option><option value="always">Always show the plan and wait for “go”</option><option value="never">Never — just start (approvals still apply)</option></select></label>
      <label className="field">Model profile<select className="input" value={a.model_profile} onChange={(e) => patch({ model_profile: e.target.value })}>{["fast", "standard", "research-standard", "escalation"].map((m) => <option key={m}>{m}</option>)}</select></label>
      <div className="row wrap"><button className="btn" onClick={() => patch({ status: a.status === "active" ? "paused" : "active" })}>{a.status === "active" ? "Pause agent" : "Resume agent"}</button>
        {a.template_id && <button className="btn" onClick={async () => { const r = await api(`/v1/agents/${id}/upgrade`, {}); toast(r.error ?? `Upgraded to ${r.version}`); reload(); }}>Upgrade to latest version</button>}</div></div>
      <h2>Schedules</h2><div className="list">{a.schedules.length ? a.schedules.map((s: any) => <div key={s.id} className="item"><span className="pill">{s.kind}</span><span className="grow">{s.objective}</span><span className="small muted">{s.next_at ? `next ${new Date(s.next_at).toLocaleString()}` : s.spec.wake_key}</span></div>) : <div className="item muted">No schedules. Ask it to “remind me…” or “every morning…”.</div>}</div></>}
  </>;
}

// ---------------- ideas ----------------
function Discover({ route, anonymous }: { route: string; anonymous?: boolean }) {
  const ctx = useContext(Ctx);
  const slug = route.split("/")[2];
  if (slug) return <TemplatePage slug={slug} anonymous={anonymous} />;
  const add = async (t: any) => {
    if (anonymous) { try { localStorage.setItem("pendingTemplate", JSON.stringify(t.slug)); } catch {} go("/"); return; }
    try { const r = await api(`/v1/agent-templates/${t.slug}/install`, { workspace_id: ctx!.ws }); go(`/agents/${r.agent.id}/launch?aud=${CAT_OF(t)}`); } catch (e: any) { ctx!.toast(e.message); }
  };
  return <>
    <div className="row between wrap"><div><h1>Agent ideas</h1><p className="muted">Ready-made agents people actually use. Try one, then add it in a click.</p></div>
      {!anonymous && <a className="btn primary" href="#/agents/new">＋ Describe your own</a>}</div>
    <div className="mt16"><IdeaGallery onPick={add} anonymous={anonymous} /></div>
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
  const ask = async (text = q) => { if (!text.trim()) return; setBusy(true); try { setTrial(await api(`/v1/agent-templates/${t.slug}/trial`, { text, trial_id: trial.trial_id })); setQ(""); } finally { setBusy(false); } };
  const install = async () => {
    if (anonymous) { try { localStorage.setItem("pendingTemplate", JSON.stringify(t.slug)); } catch {} go("/"); return; }
    if (m.onboarding?.length && !adding) { setAdding(true); return; }
    try { const r = await api(`/v1/agent-templates/${t.slug}/install`, { workspace_id: ctx!.ws, answers }); go(`/agents/${r.agent.id}/launch?aud=${CAT_OF(t)}`); } catch (e: any) { ctx!.toast(e.message); }
  };
  const fork = async () => { try { const r = await api(`/v1/agent-templates/${t.slug}/fork`, {}); ctx!.toast(`Forked as ${r.manifest.slug} (draft)`); } catch (e: any) { ctx!.toast(e.message); } };
  return <>
    <a className="small muted" href="#/discover">← All ideas</a>
    <div className="card profile mt16"><div className="banner" /><div className="body">
      <div className="row wrap" style={{ alignItems: "flex-start", gap: 16 }}><div className="avatar xl">{m.avatar ?? m.name[0]}</div>
        <div className="grow" style={{ minWidth: 200 }}><h1 style={{ fontSize: 26 }}>{m.name}</h1><div className="muted">{m.title}{t.installs ? ` · ${t.installs} using it` : ""}{t.rating ? ` · ★ ${t.rating.toFixed(1)}` : ""}</div></div>
        <div className="row">{!anonymous && <button className="btn ghost" onClick={fork}>Customize</button>}<button className="btn grad" onClick={install}>Use {m.name} →</button></div></div>
      <p className="mt16" style={{ marginBottom: 0 }}>{m.job}</p>
      <div className="row wrap small muted mt8">Works in {(m.channels ?? []).filter((c: string) => PICON[c]).map((c: string) => <span key={c} className="row" style={{ gap: 5 }}><PMark p={c} size="sm" />{PLATFORM[c]}</span>)}</div>
    </div></div>
    {adding && !anonymous && m.onboarding?.length > 0 && <div className="card col mt16"><h3>A couple of quick questions</h3>
      {m.onboarding.map((o: any) => <label key={o.id} className="field">{o.question}<input className="input" value={answers[o.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [o.id]: e.target.value })} /></label>)}
      <div><button className="btn primary" onClick={install}>Add {m.name}</button></div></div>}
    <div className="split mt16">
      <div className="card"><h3>Try {m.name}</h3><div className="small muted">No account needed.</div>
        <div className="col mt16" style={{ gap: 6 }}>{trial.messages.map((x: any, i: number) => <div key={i} className={`bub ${x.from === "you" ? "me" : "bot"}`}>{x.text}</div>)}
          {!trial.messages.length && <div className="row wrap" style={{ gap: 6 }}>{(m.starters ?? []).map((s: string) => <button key={s} className="chip" onClick={() => ask(s)}>{s.length > 50 ? s.slice(0, 48) + "…" : s}</button>)}</div>}</div>
        {trial.upsell && <div className="approval mt16"><b>{m.name} can keep this going for you.</b><div className="small muted">Add it to iMessage, WhatsApp, Telegram or Slack.</div><button className="btn primary mt8" onClick={install}>Use {m.name}</button></div>}
        {trial.limit_reached ? <div className="pill warn mt16">Trial limit reached — add {m.name} to keep going.</div> :
          <div className="row mt16"><input className="input" placeholder={`Ask ${m.name}…`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} /><button className="btn primary" disabled={busy} onClick={() => ask()}>{busy ? "…" : "Send"}</button></div>}
      </div>
      <div className="card"><h3>What it can do</h3><div className="mt8">{t.skills.map((s: any) => { const [e, x] = abilityOf(s); return <div key={s.id} className="ability"><span className="e">{e}</span><span>{x}</span></div>; })}</div>
        <details className="mt16"><summary className="small muted">Permissions & details ▸</summary><div className="mt8"><PermissionRows rows={t.permissions} /></div>
          <div className="small muted mt8">Network: {(m.network ?? []).join(", ") || "none"}{m.escalation && <> · Escalation: {m.escalation.join(" ")}</>}</div></details></div>
    </div>
    {t.reviews.length > 0 && <><h2>Reviews</h2>{t.reviews.map((r: any, i: number) => <div key={i} className="card">{"★".repeat(r.rating)} <span className="muted">{r.name}</span><div>{r.text}</div></div>)}</>}
  </>;
}

fetch("/v1/auth/config").then((r) => r.json()).catch(() => ({})).then((c: any) => {
  CLERK_KEY = c.clerk ?? null;
  createRoot(document.getElementById("root")!).render(CLERK_KEY
    ? <ClerkProvider publishableKey={CLERK_KEY} appearance={clerkLook as any} localization={clerkText as any} afterSignOutUrl="/"><App /></ClerkProvider> : <App />);
});
