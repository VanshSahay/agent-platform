// The web: the landing page (text your number, or sign in) and a small signed-in app: link your phone, read your
// chats, manage connections and reminders, see what the agent did. Everything the agent does still happens in iMessage.
import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useState, useRef, type ReactNode } from "react";
import { ClerkProvider, SignIn, useAuth, useClerk } from "@clerk/react";

let getToken: () => Promise<string | null> = async () => null;
async function api(path: string, body?: any, method?: string) {
  const token = await getToken();
  const r = await fetch(path, { method: method ?? (body ? "POST" : "GET"), headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}
function useHash() {
  const [h, set] = useState(location.hash.slice(1) || "/");
  useEffect(() => { const f = () => set(location.hash.slice(1) || "/"); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h;
}
const fmt = (ts: any) => new Date(Number(ts)).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ---------------- landing (the old look: letters become stickers, googly eyes, marker underlines) ----------------
type Kind = "imsg" | "stamp" | "tag" | "receipt" | "poll" | "note" | "app" | "tape" | "rosette" | "ticket";
function Sticker({ kind, ch }: { kind: Kind; ch: string }) {
  const L = (x: number, y: number, fill: string, font = "Arial Black, Arial, sans-serif", size = 62, extra: any = {}) =>
    <text x={x} y={y} fill={fill} fontFamily={font} fontSize={size} fontWeight={900} textAnchor="middle" dominantBaseline="central" {...extra}>{ch}</text>;
  const body: Record<Kind, ReactNode> = {
    imsg: <><path d="M16 10h68a12 12 0 0 1 12 12v52a12 12 0 0 1-12 12H40l-16 14 2-14h-10A12 12 0 0 1 4 74V22a12 12 0 0 1 12-12z" fill="#0a84ff" />{L(50, 48, "#fff")}</>,
    stamp: <><rect x="8" y="8" width="84" height="94" fill="#fff8ec" stroke="#fff8ec" strokeWidth="10" strokeDasharray="0.1 7.9" strokeLinecap="round" /><rect x="16" y="16" width="68" height="78" fill="#f6d6c9" stroke="#c2412d" strokeWidth="2.5" />{L(50, 52, "#c2412d", "Georgia, serif", 60)}</>,
    tag: <><path d="M50 4c-6 0-6 10 0 14" stroke="#8a6a3c" strokeWidth="2.5" fill="none" /><path d="M24 22h52l12 14v60a6 6 0 0 1-6 6H18a6 6 0 0 1-6-6V36z" fill="#d9b48a" stroke="#9b7448" strokeWidth="2" strokeDasharray="4 3" /><circle cx="50" cy="32" r="4.5" fill="#e8ece8" stroke="#8a6a3c" strokeWidth="2" />{L(50, 68, "#3d2a14", "Georgia, serif", 52)}</>,
    receipt: <><path d="M14 6h72v92l-6-5-6 5-6-5-6 5-6-5-6 5-6-5-6 5-6-5-6 5-6-5z" fill="#fffef8" stroke="#cfd5cc" strokeWidth="1.5" />{[16, 24].map((y) => <line key={y} x1="22" x2="78" y1={y} y2={y} stroke="#b7bfb4" strokeWidth="2" strokeDasharray="3 3" />)}{L(50, 56, "#1d2420", "Courier New, monospace", 58)}<text x="50" y="84" fontSize="8" textAnchor="middle" fill="#6b746c" fontFamily="Courier New">SPLIT 4 WAYS</text></>,
    poll: <><rect x="6" y="10" width="88" height="88" rx="14" fill="#fff" stroke="#d3d8d2" strokeWidth="2" />{[30, 50, 70].map((y, i) => <rect key={y} x="18" y={y - 5} width={[46, 64, 28][i]} height="10" rx="5" fill={["#c8c3ff", "#7a5cff", "#e3e0ff"][i]} />)}{L(78, 30, "#4533d6", "Arial Black, Arial", 34)}</>,
    note: <><g transform="rotate(-4 50 55)"><rect x="10" y="12" width="80" height="84" fill="#ffe86b" /><path d="M74 96l16-16v16z" fill="#e6c94a" /><rect x="38" y="6" width="26" height="12" fill="#ffffff99" />{L(48, 56, "#2b2a20", "Georgia, serif", 64, { fontStyle: "italic", fontWeight: 700 })}</g></>,
    app: <><rect x="8" y="12" width="84" height="84" rx="22" fill="url(#g)" /><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7a5cff" /><stop offset="1" stopColor="#2fa8ff" /></linearGradient></defs>{L(50, 56, "#fff")}<circle cx="86" cy="16" r="11" fill="#ff3b30" /><text x="86" y="17" fontSize="13" fill="#fff" textAnchor="middle" dominantBaseline="central" fontFamily="Arial" fontWeight="700">1</text></>,
    tape: <><rect x="4" y="30" width="92" height="50" rx="6" fill="#1d1f22" /><rect x="4" y="30" width="92" height="6" rx="3" fill="#3a3d42" />{L(50, 57, "#f4f4f2", "Courier New, monospace", 50, { letterSpacing: 2 })}</>,
    rosette: <><path d="M38 70l-12 34 14-8 8 12 6-36zM62 70l12 34-14-8-8 12-6-36z" fill="#2f6f5a" /><circle cx="50" cy="48" r="40" fill="#e0b84a" stroke="#c99a2a" strokeWidth="4" strokeDasharray="5 3" /><circle cx="50" cy="48" r="28" fill="#fffaf0" />{L(50, 49, "#2f6f5a", "Georgia, serif", 46)}</>,
    ticket: <><path d="M6 24h88v20a8 8 0 0 0 0 20v20H6V64a8 8 0 0 0 0-20z" fill="#ff8a65" /><line x1="72" x2="72" y1="28" y2="80" stroke="#fff" strokeWidth="2" strokeDasharray="4 4" />{L(38, 54, "#fff", "Arial Black, Arial", 52)}</>,
  };
  return <svg viewBox="0 0 100 110" aria-hidden>{body[kind]}</svg>;
}
const LOOKS: [Kind, Kind][] = [["imsg", "stamp"], ["note", "rosette"], ["tape", "ticket"], ["app", "receipt"], ["imsg", "tag"], ["poll", "note"], ["stamp", "app"], ["receipt", "imsg"], ["rosette", "poll"], ["tag", "tape"], ["ticket", "poll"]];
const spring = (angle: number, y: number) => Array.from({ length: 41 }, (_, i) => { const t = i / 40, v = i === 40 ? 1 : 1 - Math.exp(-7.2 * t) * (Math.cos(10.5 * t) + .24 * Math.sin(10.5 * t)); return { offset: t, transform: `translate(-50%, -50%) translateY(${y + 8 * (1 - v)}px) rotate(${angle - 8 * (1 - v)}deg) scale(${.35 + .65 * v})` }; });
function LetterHero({ text }: { text: string }) {
  const chars = Array.from(text), positions = chars.map((c, i) => c === " " ? -1 : chars.slice(0, i).filter((x) => x !== " ").length), n = chars.filter((c) => c !== " ").length;
  const [active, setActive] = useState<Record<number, Kind>>({});
  const last = useRef<Record<number, Kind>>({}), hovered = useRef<number | null>(null), timers = useRef<Record<number, any>>({});
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const show = (i: number, ms?: number) => { if (reduced) return; const [a, b] = LOOKS[i % LOOKS.length], kind = last.current[i] === a ? b : last.current[i] === b ? a : Math.random() < .5 ? a : b; last.current[i] = kind; clearTimeout(timers.current[i]); setActive((s) => ({ ...s, [i]: kind })); if (ms) timers.current[i] = setTimeout(() => hovered.current !== i && hide(i), ms); };
  const hide = (i: number) => { clearTimeout(timers.current[i]); setActive((s) => { const c = { ...s }; delete c[i]; return c; }); };
  useEffect(() => {
    if (reduced) return;
    const t: any[] = [];
    for (let i = 0; i < n; i++) t.push(setTimeout(() => show(i), i * 40));
    [...Array(n).keys()].sort(() => Math.random() - .5).forEach((i, k) => t.push(setTimeout(() => hide(i), 40 * n + 700 + 45 * k)));
    let auto: any; const loop = () => { auto = setTimeout(() => { if (hovered.current === null && !document.hidden) show(Math.floor(Math.random() * n), 1000); loop(); }, 1300 + Math.random() * 1500); };
    t.push(setTimeout(loop, 40 * n + 1500));
    return () => { t.forEach(clearTimeout); clearTimeout(auto); Object.values(timers.current).forEach(clearTimeout); };
  }, []);
  const point = (e: { clientX: number; clientY: number }) => { const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-pos]") as HTMLElement | null; const next = el ? Number(el.dataset.pos) : null; if (next === hovered.current) return; const old = hovered.current; hovered.current = next; if (old !== null) hide(old); if (next !== null) show(next); };
  const leave = () => { const old = hovered.current; hovered.current = null; if (old !== null) hide(old); };
  return <h1 className="ed-title" aria-label={text} onPointerMove={point} onPointerDown={point} onPointerLeave={leave} onPointerCancel={leave}>
    {text.split(" ").map((w, wi, ws) => { const start = ws.slice(0, wi).reduce((n, x) => n + x.length + 1, 0); return <span key={wi} className="ed-word">{Array.from(w).map((c, j) => <Letter key={j} ch={c} pos={positions[start + j]} kind={active[positions[start + j]]} />)}</span>; })}
  </h1>;
}
function Letter({ ch, pos, kind }: { ch: string; pos: number; kind?: Kind }) {
  const [shown, setShown] = useState<Kind | undefined>(kind), ref = useRef<HTMLSpanElement>(null), anim = useRef<Animation | null>(null);
  const angle = [-9, 7, -5, 8, -7, 6, -4][pos % 7], y = [3, -2, 2, -3, 1, 3, -1][pos % 7];
  useEffect(() => { if (kind) setShown(kind); }, [kind]);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    anim.current?.cancel();
    if (kind && shown === kind) anim.current = el.animate(spring(angle, y), { duration: 340, fill: "both" });
    else if (!kind && shown) { const a = el.animate([{ transform: `translate(-50%, -50%) rotate(${angle}deg) scale(1)`, opacity: 1 }, { transform: `translate(-50%, -50%) rotate(${angle}deg) scale(.35)`, opacity: 0 }], { duration: 520, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }); a.onfinish = () => setShown(undefined); anim.current = a; }
  }, [kind, shown]);
  return <span className={`ed-letter ${kind ? "on" : shown ? "returning" : ""}`} data-pos={pos}><span className="ed-char">{ch}</span>{shown && <span className="ed-sticker" ref={ref}><Sticker kind={shown} ch={ch} /></span>}</span>;
}
const Sparkle = ({ size = 26, style }: { size?: number; style?: any }) => <svg className="gm-doodle" width={size} height={size} viewBox="0 0 40 40" style={style} aria-hidden><path d="M20 2c1.6 9.6 8.4 16.4 18 18-9.6 1.6-16.4 8.4-18 18-1.6-9.6-8.4-16.4-18-18 9.6-1.6 16.4-8.4 18-18z" fill="#c6f432" stroke="#111" strokeWidth="2.2" strokeLinejoin="round" /></svg>;
function Eyes({ size = 46 }: { size?: number }) {
  const ref = useRef<HTMLSpanElement>(null), [p, setP] = useState({ x: 0, y: 0 });
  useEffect(() => { const move = (e: PointerEvent) => { const r = ref.current?.getBoundingClientRect(); if (!r) return; const a = Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2); setP({ x: Math.cos(a) * 4, y: Math.sin(a) * 4 }); }; addEventListener("pointermove", move); return () => removeEventListener("pointermove", move); }, []);
  return <span ref={ref} className="gm-eyes" aria-hidden>{[0, 1].map((i) => <svg key={i} width={size / 2} height={size / 2 * 1.15} viewBox="0 0 24 28"><ellipse cx="12" cy="14" rx="10.5" ry="12.5" fill="#fff" stroke="#111" strokeWidth="2.2" /><circle cx={12 + p.x} cy={15 + p.y} r="4.6" fill="#111" /><circle cx={13.6 + p.x} cy={13.4 + p.y} r="1.3" fill="#fff" /></svg>)}</span>;
}
const Circled = ({ children }: { children: ReactNode }) => <span className="gm-circled">{children}<svg viewBox="0 0 200 80" preserveAspectRatio="none" aria-hidden><path d="M30 14C80 2 170 4 190 30s-40 44-110 42S6 58 10 36 50 10 100 10" fill="none" stroke="#c6f432" strokeWidth="7" strokeLinecap="round" /></svg></span>;
function Rotator() {
  const words = ["yourself", "your group chat", "your family", "the trip"];
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % words.length), 2200); return () => clearInterval(t); }, []);
  return <span className="gm-rot" aria-live="polite"><span key={i} className="gm-rot-word" style={{ background: "#c6f432" }}>{words[i]}</span>,</span>;
}
const THREAD = [["Maya", "Pip, I paid $240 for the cabin 🏔"], ["Pip", "Got it: $240 split 4 ways, $60 each. Sam, Leo and Jess each owe Maya $60."], ["me", "Pip, dinner Friday or Saturday?"], ["Pip", "Dinner night? Reply 1 for Friday, 2 for Saturday."], ["Sam", "2"], ["Leo", "2!"], ["Maya", "saturday 🙌"], ["Pip", "Saturday it is, 3 votes to 0 🎉"]];
function PhoneMock() {
  const lastMine = THREAD.map((m) => m[0]).lastIndexOf("me");
  return <div className="phone ios" aria-hidden><div className="scr">
    <div className="ios-status"><span>9:41</span><i className="ios-island" /><span className="ios-icons"><span className="ios-batt"><i /></span></span></div>
    <div className="ios-hd"><span className="ios-back"><b>12</b></span><div className="ios-faces">{["M", "S", "L", "✦"].map((c) => <span key={c}>{c}</span>)}</div><div className="ios-name">Ski trip 🏔</div></div>
    <div className="ios-thread"><div className="ios-stamp"><b>iMessage</b><br />Today 7:41 PM</div>
      {THREAD.map(([from, text], i) => { const mine = from === "me", firstOfRun = i === 0 || THREAD[i - 1][0] !== from, lastOfRun = i === THREAD.length - 1 || THREAD[i + 1]?.[0] !== from;
        return <div key={i} className={`ios-row ${mine ? "me" : "them"}${lastOfRun ? " tail" : ""}`} style={{ animationDelay: `${i * .35}s` }}>
          {!mine && firstOfRun && <div className="ios-who">{from}</div>}
          <div className="ios-line">{!mine && <span className={`ios-av${lastOfRun ? "" : " ghost"}`}>{from === "Pip" ? "✦" : from[0]}</span>}<div className="ios-bub">{text}</div></div>
          {mine && i === lastMine && <div className="ios-receipt">Delivered</div>}
        </div>; })}
    </div>
    <div className="ios-compose"><span className="ios-plus">+</span><span className="ios-field">iMessage</span></div>
  </div></div>;
}

function Landing({ signedIn, clerk }: { signedIn: boolean; clerk: string | null }) {
  const [auth, setAuth] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && setAuth(false); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, []);
  useEffect(() => { if (signedIn && auth) { setAuth(false); location.hash = "/app"; } }, [signedIn]); // signed in from the modal: straight to the app
  const cta = signedIn ? <a className="gm-btn dark" href="#/app">Open your agent</a> : clerk ? <button className="gm-btn dark" onClick={() => setAuth(true)}>Train your agent</button> : null;
  return <div className="landing gm">
    <nav className="gm-nav"><div className="gm-logo">agents<Eyes size={26} /></div><div className="gm-links" />
      <div className="row" style={{ gap: 14 }}>{!signedIn && clerk && <button className="gm-link" onClick={() => setAuth(true)}>Sign in</button>}{cta}</div></nav>
    <section className="gm-hero">
      <Sparkle size={22} style={{ left: "12%", top: 70 }} />
      <p className="gm-hand">psst… hover the letters ↓</p>
      <div className="gm-title-wrap"><LetterHero text="train your agent" /></div>
      <p className="gm-for"><span>one for</span><Rotator /><span className="gm-anywhere">then text them.</span></p>
      <p className="gm-sub">Agents that are yours, one per job. Teach each one first: what to take off your plate, how you like things done, who and what matters. Then deploy it to iMessage, and into any group chat you add it to. It asks before it sends, books or pays, and it only says something is done when it is.</p>
      <div className="gm-ctas">{cta}</div>
      <p className="gm-fine">Nothing to install · it earns trust one action at a time</p>
    </section>
    <section className="gm-sec gm-split" style={{ paddingTop: 20 }}>
      <div className="gm-steps">
        {[["1", "Train it.", "Chat with it on the web. What you'd like to hand off, how you want it to behave, the people and routines that matter. It remembers, and you can see and fix what it kept.", "#c6f432"], ["2", "Deploy each to iMessage.", "When one knows enough, link your number. It texts you with everything you taught it. Add the number to a group and say @Name, and that agent works there.", "#ffe14d"], ["3", "Hand over more as it earns it.", "At first it suggests and you decide. Tick an action in Settings when it has earned it, and it runs that without asking.", "#9be7c4"]].map(([n, b, p, c]) =>
          <div key={n} className="gm-card" style={{ "--c": c } as any}><div className="gm-step"><span className="gm-num">{n}</span><div><b>{b}</b><p>{p}</p></div></div></div>)}
      </div>
      <PhoneMock />
    </section>
    <section className="gm-sec gm-end"><h2 className="gm-h2">Your group chat just got<br />a new <Circled>friend</Circled></h2>
      <div className="gm-ctas">{cta}</div>
      <p className="gm-fine">It asks before it sends, books or pays · Private chats stay private</p></section>
    {auth && clerk && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setAuth(false)}><div className="modal bare"><SignIn routing={"virtual" as any} withSignUp forceRedirectUrl="/#/app" signUpForceRedirectUrl="/#/app" /></div></div>}
  </div>;
}

// ---------------- the signed-in app ----------------
function Shell({ page, me, agent, children }: { page: string; me: any; agent?: any; children: ReactNode }) {
  const { signOut } = useClerk();
  const top: [string, string, string][] = [["/app", "🏠", "Home"], ["/app/agents", "🤖", "Agents"], ["/app/deploy", "📲", "Deploy"], ["/app/chats", "💬", "Chats"], ["/app/connections", "🔌", "Connections"], ["/app/reminders", "⏰", "Reminders"], ["/app/activity", "🧾", "Activity"], ["/app/settings", "⚙️", "You"]];
  const sub: [string, string, string][] = agent ? [[`/app/a/${agent.id}`, "🎓", "Train"], [`/app/a/${agent.id}/memory`, "🧠", "Memory"], [`/app/a/${agent.id}/settings`, "🎚️", "Trust & name"]] : [];
  return <div className="app"><nav className="rail"><a className="logo" href="#/"><i />agents</a>
    {top.slice(0, 2).map(([h, ic, l]) => <a key={h} href={`#${h}`} className={page === h ? "on" : ""}><span className="ic">{ic}</span>{l}</a>)}
    {agent && <>{sub.map(([h, ic, l]) => <a key={h} href={`#${h}`} className={page === h ? "on" : ""} style={{ paddingLeft: 24 }}><span className="ic">{ic}</span>{l} <span className="faint small">· {agent.name}</span></a>)}</>}
    {top.slice(2).map(([h, ic, l]) => <a key={h} href={`#${h}`} className={page === h ? "on" : ""}><span className="ic">{ic}</span>{l}</a>)}
    <div className="sep" /><a href="#/" onClick={() => signOut()}><span className="ic">↩</span>Sign out</a></nav>
    <main className="main"><div className="page">{children}</div></main></div>;
}

function Thread({ roomId, send: sendTo }: { roomId: string; send?: (text: string, fileIds: string[]) => Promise<any> }) {
  const [msgs, setMsgs] = useState<any[]>([]), [working, setWorking] = useState(false), [text, setText] = useState(""), [files, setFiles] = useState<{ file_id: string; name: string }[]>([]), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { let on = true; const load = () => api(`/v1/rooms/${roomId}/messages`).then((r) => { if (!on) return; setMsgs(r.messages); setWorking(r.working); }).catch(() => {}); load(); const t = setInterval(load, 2500); return () => { on = false; clearInterval(t); }; }, [roomId]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length, working]);
  const send = async (e: any) => { e.preventDefault(); if (!sendTo || (!text.trim() && !files.length)) return; setBusy(true); setErr(""); try { await sendTo(text, files.map((f) => f.file_id)); setText(""); setFiles([]); setWorking(true); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } };
  const upload = async (list: FileList | null) => { for (const f of Array.from(list ?? [])) { const fd = new FormData(); fd.append("file", f); const token = await getToken(); const r = await fetch("/v1/files", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: fd }); const d = await r.json(); if (!r.ok) { setErr(d.error); continue; } setFiles((x) => [...x, d]); } };
  return <div className="convo" style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--panel)", height: "68vh", minHeight: 420 }}>
    <div className="timeline">{msgs.map((m) => <div key={m.id} className={`msg ${m.direction === "out" ? "agent" : ""}`}><div className="body"><div className="who">{m.direction === "out" ? "Agent" : m.sender_name ?? "You"} <span className="faint small">{fmt(m.created_at)}</span></div><div className="text">{m.text}</div>{Array.isArray(m.steps) && m.steps.length > 0 && <Steps steps={m.steps} />}</div></div>)}
      {working && <div className="waiting"><span className="dots"><span /><span /><span /></span>working…</div>}
      {!msgs.length && !working && <div className="empty">Everything you tell it about yourself is training. Start with what you'd like to hand off, then how you want it to behave: when to ask, when to just do it, how to write. Add the people and routines that matter. Photos work too. Check Memory to see what it kept.</div>}
      <div ref={end} /></div>
    {sendTo && <form onSubmit={send} className="composer col" style={{ gap: 6 }}>
      {files.length > 0 && <div className="row wrap small muted">{files.map((f) => <span key={f.file_id} className="gm-chip">{f.name}</span>)}</div>}
      <div className="row"><textarea className="input grow" placeholder="Teach it something, ask it something, or send a photo…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e); } }} />
        <label className="btn" title="Attach photos or files">📷<input type="file" accept="image/*,.pdf,.txt,.csv" multiple style={{ display: "none" }} onChange={(e) => upload(e.target.files)} /></label>
        <button className="btn primary" disabled={busy}>Send</button></div>
      {err && <div className="small" style={{ color: "var(--bad)" }}>{err}</div>}
    </form>}
  </div>;
}
function Steps({ steps }: { steps: any[] }) {
  const [open, setOpen] = useState(false);
  return <div className="small mt8"><button className="btn ghost small" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} Completed {steps.length} step{steps.length === 1 ? "" : "s"}</button>
    {open && <div className="col" style={{ gap: 2, marginTop: 4 }}>{steps.map((s, i) => <div key={i} className={`step ${s.verified ? "ok" : s.status === "unknown" ? "warn" : s.status === "failed" ? "bad" : ""}`}>{s.label}</div>)}</div>}</div>;
}
const Ready = ({ r }: { r: any }) => <span className={`small ${r.ready ? "" : "muted"}`}>{r.ready ? "✅ ready to deploy" : `${r.named ? "✅" : "⬜️"} named · ${r.memories}/${r.min_memories} things learned`}</span>;

function Home({ me }: { me: any }) {
  const [d, setD] = useState<any>(null), [tab, setTab] = useState<"input" | "radar" | "activity">("input");
  const load = () => api("/v1/home").then(setD).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);
  if (!d) return null;
  const decide = async (id: string, decision: "approve" | "reject") => { await api(`/v1/approvals/${id}`, { decision }); load(); };
  const held = async (id: string, decision: "post" | "drop") => { await api(`/v1/runs/${id}/held`, { decision }); load(); };
  const where = (x: any) => x.channel === "web" ? "training" : x.room_kind === "group" ? x.room_name ?? "group" : "your chat";
  const tabs: [typeof tab, string, number][] = [["input", "Need your input", d.need_input.length], ["radar", "On radar", d.on_radar.schedules.length + d.on_radar.working.length], ["activity", "Last activity", d.activity.length]];
  return <div><h1>Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}{me.name ? `, ${me.name.split(" ")[0]}` : ""}.</h1>
    <div className="row mt16" style={{ gap: 6 }}>{tabs.map(([k, l, n]) => <button key={k} className={`btn ${tab === k ? "primary" : ""}`} onClick={() => setTab(k)}>{l}{n ? <span className="count" style={{ marginLeft: 6 }}>{n}</span> : null}</button>)}</div>
    {tab === "input" && <div className="list mt16">{d.need_input.map((x: any) => <div key={x.id} className="item"><div className="grow"><b>{x.type === "held" ? "Someone new joined while I was replying" : x.summary}</b><div className="small muted">{x.agent_name} · {where(x)}{x.requester_name ? ` · asked by ${x.requester_name}` : ""} · {fmt(x.created_at)}</div>{x.type === "held" && <pre className="code">{x.reply}</pre>}</div>
      {x.type === "held" ? <><button className="btn primary" onClick={() => held(x.id, "post")}>Post it</button><button className="btn" onClick={() => held(x.id, "drop")}>Drop</button></> : <><button className="btn primary" onClick={() => decide(x.id, "approve")}>Yes</button><button className="btn" onClick={() => decide(x.id, "reject")}>No</button></>}</div>)}
      {!d.need_input.length && <div className="empty">Nothing needs you right now. When an agent gets stuck on something only you can answer, it waits for you here.</div>}</div>}
    {tab === "radar" && <div className="mt16">{d.on_radar.working.length > 0 && <div className="list"><div className="item"><b>Working now</b></div>{d.on_radar.working.map((r: any) => <div key={r.id} className="item"><div className="grow">{r.request.slice(0, 120)}<div className="small muted">{r.agent_name} · {where(r)} · {r.status.replace("_", " ")}</div></div></div>)}</div>}
      <div className="list mt8">{d.on_radar.schedules.map((s: any) => <div key={s.id} className="item"><div className="grow"><b>{s.text}</b><div className="small muted">Next run: {s.next} · {s.agent_name} · {where(s)}{s.spec?.at ? "" : " · repeats"}</div></div><button className="btn" onClick={async () => { await api(`/v1/reminders/${s.id}`, undefined, "DELETE"); load(); }}>Cancel</button></div>)}{!d.on_radar.schedules.length && !d.on_radar.working.length && <div className="empty">Nothing scheduled. Ask an agent to do something later, or to check in on a repeat, and it lands here.</div>}</div></div>}
    {tab === "activity" && <div className="mt16">{d.activity.map((r: any) => <div key={r.id} className="card mt8"><div className="row between"><b>{r.request.slice(0, 120)}</b><span className="small faint">{r.agent_name} · {where(r)} · {r.status} · {fmt(r.updated_at)}</span></div>{r.reply && <div className="small mt8" style={{ whiteSpace: "pre-wrap" }}>{String(r.reply).slice(0, 400)}</div>}{Array.isArray(r.steps) && r.steps.length > 0 && <Steps steps={r.steps} />}</div>)}{!d.activity.length && <div className="empty">Nothing yet.</div>}</div>}
    <h2>Your agents</h2><div className="grid2">{me.agents.map((a: any) => <a key={a.id} className="card" href={`#/app/a/${a.id}`}><h3>{a.name}</h3><div className="small muted" style={{ margin: "4px 0 8px" }}>{a.purpose ?? "No purpose set yet"}</div><Ready r={a.readiness} /></a>)}</div></div>;
}
function Agents({ me, reload }: { me: any; reload: () => void }) {
  const [f, setF] = useState({ name: "", purpose: "" }), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const create = async (e: any) => { e.preventDefault(); setErr(""); setBusy(true); try { const a = await api("/v1/agents", f); setF({ name: "", purpose: "" }); reload(); location.hash = `/app/a/${a.id}`; } catch (x: any) { setErr(x.message); } finally { setBusy(false); } };
  return <div><h1>Your agents</h1><p className="muted">Each one is trained on its own and deployed where you choose: your own chat, the family group, the trip group. Its training follows it; what a group says stays in that group.</p>
    <div className="grid2 mt16">{me.agents.map((a: any) => <a key={a.id} className="card" href={`#/app/a/${a.id}`}><h3>{a.name}{a.id === me.default_agent_id && <span className="faint small"> · default</span>}</h3><div className="small muted" style={{ margin: "4px 0 8px" }}>{a.purpose ?? "No purpose set yet"}</div><Ready r={a.readiness} /></a>)}</div>
    <form onSubmit={create} className="card col mt16" style={{ maxWidth: 520 }}><b>New agent</b><input className="input" placeholder="Name, e.g. Carl" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /><textarea className="input" placeholder="What it's for, e.g. groceries and meal planning for the family" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} style={{ height: 70 }} />{err && <div className="small" style={{ color: "var(--bad)" }}>{err}</div>}<button className="btn primary" disabled={busy}>Create and train</button></form></div>;
}
function Train({ agent }: { agent: any }) {
  const [room, setRoom] = useState<any>(null);
  useEffect(() => { api(`/v1/agents/${agent.id}/room`).then(setRoom); }, [agent.id]);
  return <div><div className="row between"><div><h1>Train {agent.name}</h1><p className="muted">{agent.purpose ?? "Tell it what it's for."} <Ready r={agent.readiness} />{agent.readiness.ready && <> · <a href="#/app/deploy" style={{ textDecoration: "underline" }}>deploy</a></>}</p></div></div>
    <div className="mt16">{room ? <Thread roomId={room.id} send={(text, file_ids) => api(`/v1/agents/${agent.id}/chat`, { text, file_ids })} /> : null}</div></div>;
}
function Memory({ agent }: { agent: any }) {
  const [list, setList] = useState<any[]>([]), [text, setText] = useState(""), [kind, setKind] = useState("rule"), [err, setErr] = useState("");
  const KINDS = ["rule", "preference", "person", "schedule", "store", "inventory", "decision", "fact"];
  const load = () => api(`/v1/agents/${agent.id}/memories`).then(setList);
  useEffect(() => { load(); }, [agent.id]);
  const add = async (e: any) => { e.preventDefault(); setErr(""); try { await api(`/v1/agents/${agent.id}/memories`, { text, kind }); setText(""); load(); } catch (x: any) { setErr(x.message); } };
  return <div><h1>{agent.name}'s memory</h1><p className="muted">Everything it knows, dated. Rules are how you want it to behave; it follows them on every run, in every chat it's deployed to. Delete what's wrong; add what it should know.</p>
    <form onSubmit={add} className="card row mt16" style={{ gap: 8, alignItems: "stretch" }}><select className="input" style={{ width: "auto", flex: "0 0 auto" }} value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select><input className="input grow" placeholder="e.g. Ask me before emailing anyone at work · Uber Eats is 30% off on Tuesdays, so order then · My mom is Linda, in Boston" value={text} onChange={(e) => setText(e.target.value)} required /><button className="btn primary">Remember</button>{err && <span className="small" style={{ color: "var(--bad)" }}>{err}</span>}</form>
    {KINDS.filter((k) => list.some((m) => m.kind === k)).map((k) => <div key={k}><h2>{k}</h2><div className="list">{list.filter((m) => m.kind === k).map((m) => <div key={m.id} className="item"><div className="grow">{m.text}<div className="small faint">{fmt(m.created_at)}</div></div><button className="btn ghost" onClick={async () => { await api(`/v1/memories/${m.id}`, undefined, "DELETE"); load(); }}>Forget</button></div>)}</div></div>)}
    {!list.length && <div className="empty mt16">Nothing yet. Train it, or add a line above.</div>}</div>;
}
function AgentSettings({ agent, me, reload }: { agent: any; me: any; reload: () => void }) {
  const [f, setF] = useState({ name: agent.name, purpose: agent.purpose ?? "" }), [tools, setTools] = useState<{ id: string; description: string }[]>([]), [auto, setAuto] = useState<string[]>(agent.auto_tools ?? []), [saved, setSaved] = useState(""), [err, setErr] = useState("");
  useEffect(() => { api("/v1/tools").then(setTools); }, []);
  const save = async (e: any) => { e.preventDefault(); await api(`/v1/agents/${agent.id}`, { ...f, auto_tools: auto }, "PUT"); reload(); setSaved("Saved."); setTimeout(() => setSaved(""), 1500); };
  const toggle = (id: string) => setAuto((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const del = async () => { if (!confirm(`Delete ${agent.name} and everything it learned?`)) return; try { await api(`/v1/agents/${agent.id}`, undefined, "DELETE"); reload(); location.hash = "/app"; } catch (x: any) { setErr(x.message); } };
  return <div><h1>{agent.name}: trust & name</h1>
    <form onSubmit={save} className="card col mt16" style={{ maxWidth: 560 }}>
      <label className="small muted">Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <label className="small muted">What it's for</label><textarea className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} style={{ height: 70 }} />
      <h2>Trust</h2><p className="small muted" style={{ margin: 0 }}>Everything below asks you first. Tick an action once {agent.name} has earned it, and it runs without asking.</p>
      {tools.map((t) => <label key={t.id} className="check"><input type="checkbox" checked={auto.includes(t.id)} onChange={() => toggle(t.id)} /> <span><b className="mono">{t.id}</b> <span className="small muted">{t.description}</span></span></label>)}
      <div className="row"><button className="btn primary">Save</button><span className="small muted">{saved}</span></div></form>
    {me.agents.length > 1 && <div className="mt16"><button className="btn" onClick={del}>Delete {agent.name}</button>{err && <span className="small" style={{ color: "var(--bad)", marginLeft: 8 }}>{err}</span>}</div>}</div>;
}
function Deploy({ me, setMe }: { me: any; setMe: (u: any) => void }) {
  const [phone, setPhone] = useState(""), [code, setCode] = useState(""), [step, setStep] = useState<"phone" | "code">("phone"), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const d = me.agents.find((a: any) => a.id === me.default_agent_id) ?? me.agents[0];
  const go = async (e: any) => { e.preventDefault(); setErr(""); setBusy(true); try { if (step === "phone") { await api("/v1/me/phone", { phone }); setStep("code"); } else setMe(await api("/v1/me/phone/verify", { code })); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } };
  return <div><h1>Deploy</h1><p className="muted">Trained agents go to iMessage: your own chat, and any group chat you add the number to.</p>
    <div className="card mt16" style={{ maxWidth: 560 }}>{me.phone ? <><b>Linked to {me.phone}</b><div className="small muted">Your chat talks to {d?.name}. Say "@Name" to switch to another of your agents. In a group, add the number, then say "@Name" once; the owner can switch with "@Other".</div></>
      : <form onSubmit={go} className="col"><b>Link your iPhone</b><div className="small muted">{d ? <>Your default agent is {d.name}. <Ready r={d.readiness} /></> : "Create an agent first."}</div>
        {d?.readiness?.ready ? <>{step === "phone" ? <input className="input" type="tel" autoComplete="tel" placeholder="+1 555 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} required /> : <input className="input" inputMode="numeric" placeholder="6-digit code from the text" value={code} onChange={(e) => setCode(e.target.value)} required />}
          <button className="btn primary" disabled={busy}>{step === "phone" ? "Text me a code" : "Link"}</button></> : <div className="small muted">Train {d?.name ?? "it"} until it's ready, then come back. Change the default agent under You.</div>}
        {err && <div className="small" style={{ color: "var(--bad)" }}>{err}</div>}</form>}</div>
    <h2>Your agents</h2><div className="list">{me.agents.map((a: any) => <div key={a.id} className="item"><div className="grow"><b>{a.name}</b>{a.id === me.default_agent_id && <span className="faint small"> · default, answers your own chat</span>}<div><Ready r={a.readiness} /></div></div><a className="btn" href={`#/app/a/${a.id}`}>Train</a></div>)}</div></div>;
}
function You({ me, setMe }: { me: any; setMe: (u: any) => void }) {
  const [f, setF] = useState({ name: me.name ?? "", tz: me.tz ?? "", default_agent_id: me.default_agent_id }), [saved, setSaved] = useState("");
  const save = async (e: any) => { e.preventDefault(); setMe(await api("/v1/me/settings", f, "PUT")); setSaved("Saved."); setTimeout(() => setSaved(""), 1500); };
  return <div><h1>You</h1><form onSubmit={save} className="card col mt16" style={{ maxWidth: 560 }}>
    <label className="small muted">Your name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
    <label className="small muted">Time zone (IANA)</label><input className="input" value={f.tz} onChange={(e) => setF({ ...f, tz: e.target.value })} placeholder="America/New_York" />
    <label className="small muted">Default agent (answers your own chat)</label><select className="input" value={f.default_agent_id ?? ""} onChange={(e) => setF({ ...f, default_agent_id: e.target.value })}>{me.agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
    <div className="row"><button className="btn primary">Save</button><span className="small muted">{saved}</span></div></form></div>;
}
function Chats() {
  const [rooms, setRooms] = useState<any[]>([]), [open, setOpen] = useState<any>(null);
  useEffect(() => { api("/v1/rooms").then(setRooms); }, []);
  if (open) return <div><div className="row between"><div><h1>{open.name ?? (open.kind === "group" ? "Group chat" : "Your chat")} <span className="faint small">· {open.agent_name}</span></h1>{open.instructions && <p className="muted">{open.instructions}</p>}</div><button className="btn" onClick={() => setOpen(null)}>← All chats</button></div><div className="mt16"><Thread roomId={open.id} /></div></div>;
  return <div><h1>Chats</h1><p className="muted">Your iMessage conversations. Read here, talk in Messages.</p>
    <div className="list mt16">{rooms.map((r) => <a key={r.id} className="item" onClick={() => setOpen(r)}><div className="grow"><b>{r.name ?? (r.kind === "group" ? "Group chat" : "Your chat")}</b> <span className="faint small">· {r.agent_name}</span><div className="small muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.last_text}</div></div><span className="faint small">{r.last_at ? fmt(r.last_at) : ""}</span></a>)}{!rooms.length && <div className="empty">No iMessage chats yet. Deploy when an agent is ready.</div>}</div></div>;
}
function Connections() {
  const [list, setList] = useState<any[]>([]), [f, setF] = useState({ label: "", url: "", token: "" }), [err, setErr] = useState("");
  const load = () => api("/v1/connections").then(setList);
  useEffect(() => { load(); }, []);
  const google = list.find((c) => c.provider === "google"), devices = list.filter((c) => c.provider === "mcp"), logins = list.filter((c) => c.provider === "browser_login");
  const [site, setSite] = useState("");
  const signIn = async (e: any) => { e.preventDefault(); setErr(""); try { const { url } = await api("/v1/connections/browser/link", { site }); window.open(url, "_blank"); setSite(""); } catch (x: any) { setErr(x.message); } };
  const connectGoogle = async () => { const { url } = await api("/v1/connections/google/link", {}); location.href = url; };
  const drop = async (id: string) => { await api(`/v1/connections/${id}`, undefined, "DELETE"); load(); };
  const add = async (e: any) => { e.preventDefault(); setErr(""); try { await api("/v1/connections/mcp", f); setF({ label: "", url: "", token: "" }); load(); } catch (x: any) { setErr(x.message); } };
  return <div><h1>Connections</h1><p className="muted">Your accounts and devices. Your agents use them only when you ask, and in a group only after you say they may.</p>
    <h2>Google</h2><div className="card"><div className="row between"><div><b>Gmail, Calendar, Contacts, Drive</b><div className="small muted">{google ? `Connected as ${google.account}${google.status === "needs_reauth" ? " · needs reconnecting" : ""}` : "Not connected"}</div></div>
      <div className="row">{google && <button className="btn" onClick={() => drop(google.id)}>Disconnect</button>}<button className="btn primary" onClick={connectGoogle}>{google ? "Reconnect" : "Connect"}</button></div></div>
      {google && <label className="check mt8"><input type="checkbox" checked={!!google.send_as_me} onChange={async (e) => { await api(`/v1/connections/${google.id}/settings`, { send_as_me: e.target.checked }, "PUT"); load(); }} /> <span>Send email as me <span className="small muted">· off until you turn it on; each send still asks you first. When off, your agents leave drafts in your Gmail instead.</span></span></label>}</div>
    <h2>Site logins</h2><p className="small muted" style={{ marginTop: -6 }}>Sign in to a website yourself in a live browser. Your agents then use that site as you. Passwords never pass through here.</p>
    <div className="list">{logins.map((c) => <div key={c.id} className="item"><div className="grow"><b>{c.account}</b><div className="small muted">{c.status === "needs_reauth" ? "needs signing in again" : "signed in"}{c.last_used_at ? ` · used ${fmt(c.last_used_at)}` : ""}</div></div><button className="btn" onClick={() => drop(c.id)}>Sign out</button></div>)}{!logins.length && <div className="empty">No site logins yet.</div>}</div>
    <form onSubmit={signIn} className="row mt8" style={{ maxWidth: 520 }}><input className="input grow" placeholder="ubereats.com" value={site} onChange={(e) => setSite(e.target.value)} required /><button className="btn primary">Sign in</button></form>
    <h2>Devices</h2><div className="list">{devices.map((d) => <div key={d.id} className="item"><div className="grow"><b>{d.label}</b><div className="small muted">{d.account} · {d.tools} tools{d.last_used_at ? ` · used ${fmt(d.last_used_at)}` : ""}</div></div><button className="btn" onClick={() => drop(d.id)}>Remove</button></div>)}{!devices.length && <div className="empty">No devices. Run <a href="https://github.com/leeguooooo/iphone-use" style={{ textDecoration: "underline" }}>iphone-use</a> on your Mac, expose it through a tunnel, and add it below. Then your agents can use the apps on your phone.</div>}</div>
    <form onSubmit={add} className="card col mt16" style={{ maxWidth: 520 }}><b>Add a device (MCP server)</b><input className="input" placeholder="Name, e.g. My iPhone" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required /><input className="input" type="url" placeholder="https://…/mcp" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required /><input className="input" type="password" placeholder="Bearer token (if any)" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />{err && <div className="small" style={{ color: "var(--bad)" }}>{err}</div>}<button className="btn primary">Connect</button></form></div>;
}
function Reminders() {
  const [list, setList] = useState<any[]>([]);
  const load = () => api("/v1/reminders").then(setList);
  useEffect(() => { load(); }, []);
  return <div><h1>Reminders</h1><p className="muted">What your agents will do or say later. Set them in a training chat or in Messages ("every morning, update the grocery list").</p>
    <div className="list mt16">{list.map((s) => <div key={s.id} className="item"><div className="grow"><b>{s.text}</b><div className="small muted">{s.next} · {s.spec?.at ? "once" : "repeats"} · {s.agent_name} · {s.channel === "web" ? "training chat" : s.room_kind === "group" ? s.room_name ?? "group" : "your chat"}{s.kind === "task" ? " · a job" : ""}</div></div><button className="btn" onClick={async () => { await api(`/v1/reminders/${s.id}`, undefined, "DELETE"); load(); }}>Cancel</button></div>)}{!list.length && <div className="empty">No reminders.</div>}</div></div>;
}
function Activity() {
  const [runs, setRuns] = useState<any[]>([]);
  useEffect(() => { api("/v1/runs").then(setRuns); }, []);
  return <div><h1>Activity</h1><p className="muted">Every request, each tool call, and the proof behind each action.</p>
    {runs.map((r) => <div key={r.id} className="card mt16"><div className="row between"><b>{r.request.slice(0, 140)}</b><span className="small faint">{fmt(r.created_at)} · {r.agent_name} · {r.channel === "web" ? "training" : r.room_kind === "group" ? r.room_name ?? "group" : "your chat"} · {r.status} · {r.tier}{r.tier_reason ? ` (${r.tier_reason})` : ""} · ${Number(r.cost_usd).toFixed(4)}</span></div>
      {r.executions.map((e: any, i: number) => <div key={i} className={`step ${e.verified ? "ok" : e.status === "unknown" ? "warn" : e.status === "failed" ? "bad" : ""}`}><span className="mono">{e.tool}</span> <span className="small muted">{JSON.stringify(e.input).slice(0, 160)}</span>{e.provider_ref && <span className="small faint"> · proof {e.provider_ref}</span>}</div>)}
      {r.reply && <pre className="code">{r.reply}</pre>}</div>)}{!runs.length && <div className="empty">Nothing yet.</div>}</div>;
}
function Bridge({ onReady }: { onReady: (signedIn: boolean) => void }) {
  const { isLoaded, isSignedIn, getToken: gt } = useAuth();
  useEffect(() => { getToken = () => gt(); if (isLoaded) onReady(!!isSignedIn); }, [isLoaded, isSignedIn]);
  return null;
}
function App({ clerk }: { clerk: string | null }) {
  const hash = useHash(), [signedIn, setSignedIn] = useState<boolean | null>(clerk ? null : false), [me, setMe] = useState<any>(null);
  const reload = () => api("/v1/me").then(setMe).catch(() => setMe(null));
  useEffect(() => { if (signedIn) reload(); else setMe(null); }, [signedIn]);
  const page = hash.startsWith("/app") ? hash.replace(/\/$/, "") : "/";
  useEffect(() => { if (signedIn && !hash.startsWith("/app") && hash !== "/") location.hash = "/app"; }, [signedIn, hash]); // Clerk's steps (#/factor-one, #/sso-callback) end in the app
  const am = page.match(/^\/app\/a\/([^/]+)(?:\/(memory|settings))?$/), agent = am && me ? me.agents.find((a: any) => a.id === am[1]) : null;
  const body = !me ? null
    : agent ? (am![2] === "memory" ? <Memory agent={agent} /> : am![2] === "settings" ? <AgentSettings agent={agent} me={me} reload={reload} /> : <Train agent={agent} />)
    : ({ "/app": <Home me={me} />, "/app/agents": <Agents me={me} reload={reload} />, "/app/deploy": <Deploy me={me} setMe={setMe} />, "/app/chats": <Chats />, "/app/connections": <Connections />, "/app/reminders": <Reminders />, "/app/activity": <Activity />, "/app/settings": <You me={me} setMe={setMe} /> } as Record<string, ReactNode>)[page] ?? <Home me={me} />;
  return <>{clerk && <Bridge onReady={setSignedIn} />}
    {page === "/" ? <Landing signedIn={!!signedIn} clerk={clerk} />
      : signedIn === false ? <div className="auth">{clerk ? <SignIn routing={"virtual" as any} withSignUp forceRedirectUrl="/#/app" signUpForceRedirectUrl="/#/app" /> : <div className="card">Sign-in isn't set up on this server.</div>}</div>
      : !me ? null
      : <Shell page={page} me={me} agent={agent}>{body}</Shell>}
  </>;
}
fetch("/v1/config").then((r) => r.json()).then((c) => {
  const clerk = c.clerk ?? null;
  createRoot(document.getElementById("root")!).render(clerk
    ? <ClerkProvider publishableKey={clerk} afterSignOutUrl="/" appearance={{ variables: { colorPrimary: "#111", fontFamily: "Inter, -apple-system, sans-serif", borderRadius: "12px" }, elements: { cardBox: { border: "2px solid #111", boxShadow: "6px 6px 0 #c6f432" }, formButtonPrimary: { background: "#111", boxShadow: "0 3px 0 #c6f432", fontWeight: 700, textTransform: "none" } } } as any}><App clerk={clerk} /></ClerkProvider>
    : <App clerk={null} />);
});
