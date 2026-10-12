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
  const [phone, setPhone] = useState(""), [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle"), [err, setErr] = useState(""), [auth, setAuth] = useState(false);
  const submit = async (e: any) => { e.preventDefault(); setState("busy"); try { await api("/start", { phone }); setState("sent"); } catch (x: any) { setErr(x.message); setState("error"); } };
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && setAuth(false); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, []);
  return <div className="landing gm">
    <nav className="gm-nav"><div className="gm-logo">agents<Eyes size={26} /></div><div className="gm-links" />
      <div className="row" style={{ gap: 14 }}>{signedIn ? <a className="gm-btn dark" href="#/app">Open app</a> : clerk ? <><button className="gm-link" onClick={() => setAuth(true)}>Sign in</button><button className="gm-btn dark" onClick={() => setAuth(true)}>Get started</button></> : null}</div></nav>
    <section className="gm-hero">
      <Sparkle size={22} style={{ left: "12%", top: 70 }} />
      <p className="gm-hand">psst… hover the letters ↓</p>
      <div className="gm-title-wrap"><LetterHero text="text your agent" /></div>
      <p className="gm-for"><span>for</span><Rotator /><span className="gm-anywhere">in iMessage.</span></p>
      <p className="gm-sub">One assistant that's yours. It works for you in your own chat, and in any group chat you add it to: the trip, dinner, the family's week, a group order. It asks before it sends, books or pays, and it only says something is done when it is.</p>
      <div className="gm-bubble" style={{ marginTop: 26 }}>
        {state === "sent" ? <div><h3 style={{ font: "800 22px Rubik, sans-serif" }}>Check your messages.</h3><p className="gm-p" style={{ margin: "8px auto 0" }}>Your assistant just texted you. Reply there; the rest happens in iMessage.</p></div>
          : <form onSubmit={submit} className="row wrap" style={{ gap: 10, justifyContent: "center" }}>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" autoComplete="tel" placeholder="Your iPhone number" required style={{ flex: 1, minWidth: 220, border: "2px solid #111", borderRadius: 14, padding: "11px 14px", fontSize: 17, background: "#fff", color: "#111" }} />
            <button className="gm-btn dark" disabled={state === "busy"}>{state === "busy" ? "Texting…" : "Text me"}</button>
            {state === "error" && <div className="small" style={{ width: "100%", color: "#b42318" }}>{err}</div>}
            <div className="gm-fine" style={{ width: "100%", marginTop: 8 }}>US and Canada numbers · nothing to install</div>
          </form>}
      </div>
    </section>
    <section className="gm-sec gm-split" style={{ paddingTop: 20 }}>
      <div className="gm-steps">
        {[["1", "Text it what you need.", "Like you'd text a friend. It remembers what matters to you.", "#c6f432"], ["2", "It does the work.", "Calendar, email, the web, a real browser, even your phone. It asks before anything goes out.", "#ffe14d"], ["3", "Add it to any group chat.", "Trips, dinners, the family. It acts for the group, and never touches anyone's accounts without their say.", "#9be7c4"]].map(([n, b, p, c]) =>
          <div key={n} className="gm-card" style={{ "--c": c } as any}><div className="gm-step"><span className="gm-num">{n}</span><div><b>{b}</b><p>{p}</p></div></div></div>)}
      </div>
      <PhoneMock />
    </section>
    <section className="gm-sec gm-end"><h2 className="gm-h2">Your group chat just got<br />a new <Circled>friend</Circled></h2>
      <div className="gm-ctas"><a className="gm-btn dark" href="#top" onClick={(e) => { e.preventDefault(); scrollTo({ top: 0, behavior: "smooth" }); }}>Text me</a></div>
      <p className="gm-fine">It asks before it sends, books or pays · Private chats stay private</p></section>
    {auth && clerk && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setAuth(false)}><div className="modal bare"><SignIn routing={"virtual" as any} withSignUp /></div></div>}
  </div>;
}

// ---------------- the signed-in app ----------------
function Shell({ page, children }: { page: string; children: ReactNode }) {
  const { signOut } = useClerk();
  const links: [string, string, string][] = [["/app", "💬", "Chats"], ["/app/connections", "🔌", "Connections"], ["/app/reminders", "⏰", "Reminders"], ["/app/activity", "🧾", "Activity"]];
  return <div className="app"><nav className="rail"><a className="logo" href="#/"><i />agents</a>
    {links.map(([h, ic, l]) => <a key={h} href={`#${h}`} className={page === h ? "on" : ""}><span className="ic">{ic}</span>{l}</a>)}
    <div className="sep" /><a href="#/" onClick={() => signOut()}><span className="ic">↩</span>Sign out</a></nav>
    <main className="main"><div className="page">{children}</div></main></div>;
}
function PhoneGate({ me, onLinked }: { me: any; onLinked: (u: any) => void }) {
  const [phone, setPhone] = useState(""), [code, setCode] = useState(""), [step, setStep] = useState<"phone" | "code">("phone"), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const go = async (e: any) => { e.preventDefault(); setErr(""); setBusy(true); try { if (step === "phone") { await api("/v1/me/phone", { phone }); setStep("code"); } else onLinked(await api("/v1/me/phone/verify", { code })); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } };
  return <div className="card" style={{ maxWidth: 480 }}><h1>Link your iPhone</h1><p className="muted">Hi {me.name ?? me.email}. Your assistant lives in iMessage; this page shows what it's doing. Enter your number and we'll text you a code.</p>
    <form onSubmit={go} className="col mt16">
      {step === "phone" ? <input className="input" type="tel" autoComplete="tel" placeholder="+1 555 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} required /> : <input className="input" inputMode="numeric" placeholder="6-digit code from the text" value={code} onChange={(e) => setCode(e.target.value)} required />}
      {err && <div className="small" style={{ color: "var(--bad)" }}>{err}</div>}
      <button className="btn primary" disabled={busy}>{step === "phone" ? "Text me a code" : "Link"}</button>
    </form></div>;
}
function Chats() {
  const [rooms, setRooms] = useState<any[]>([]), [open, setOpen] = useState<any>(null), [msgs, setMsgs] = useState<any[]>([]);
  useEffect(() => { api("/v1/rooms").then(setRooms); }, []);
  useEffect(() => { if (!open) return; let on = true; const load = () => api(`/v1/rooms/${open.id}/messages`).then((m) => on && setMsgs(m.reverse())); load(); const t = setInterval(load, 5000); return () => { on = false; clearInterval(t); }; }, [open]);
  if (open) return <div><div className="row between"><div><h1>{open.name ?? (open.kind === "group" ? "Group chat" : "Your chat")}</h1>{open.instructions && <p className="muted">{open.instructions}</p>}</div><button className="btn" onClick={() => setOpen(null)}>← All chats</button></div>
    <div className="timeline mt16" style={{ padding: 0 }}>{msgs.map((m) => <div key={m.id} className={`msg ${m.direction === "out" ? "agent" : ""}`}><div className="body"><div className="who">{m.direction === "out" ? "Assistant" : m.sender_name ?? "someone"} <span className="faint small">{fmt(m.created_at)}</span></div><div className="text">{m.text}</div></div></div>)}{!msgs.length && <div className="empty">Nothing here yet.</div>}</div></div>;
  return <div><h1>Chats</h1><p className="muted">Every conversation your assistant is in. Read here, talk in iMessage.</p>
    <div className="list mt16">{rooms.map((r) => <a key={r.id} className="item" onClick={() => setOpen(r)}><div className="grow"><b>{r.name ?? (r.kind === "group" ? "Group chat" : "Your chat")}</b><div className="small muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.last_text}</div></div><span className="faint small">{r.last_at ? fmt(r.last_at) : ""}</span></a>)}{!rooms.length && <div className="empty">No chats yet. Text your assistant first.</div>}</div></div>;
}
function Connections() {
  const [list, setList] = useState<any[]>([]), [f, setF] = useState({ label: "", url: "", token: "" }), [err, setErr] = useState("");
  const load = () => api("/v1/connections").then(setList);
  useEffect(() => { load(); }, []);
  const google = list.find((c) => c.provider === "google"), devices = list.filter((c) => c.provider === "mcp");
  const connectGoogle = async () => { const { url } = await api("/v1/connections/google/link", {}); location.href = url; };
  const drop = async (id: string) => { await api(`/v1/connections/${id}`, undefined, "DELETE"); load(); };
  const add = async (e: any) => { e.preventDefault(); setErr(""); try { await api("/v1/connections/mcp", f); setF({ label: "", url: "", token: "" }); load(); } catch (x: any) { setErr(x.message); } };
  return <div><h1>Connections</h1><p className="muted">Your accounts and devices. Your assistant uses them only when you ask, and in a group only after you say it may.</p>
    <h2>Google</h2><div className="card row between"><div><b>Gmail, Calendar, Contacts, Drive</b><div className="small muted">{google ? `Connected as ${google.account}${google.status === "needs_reauth" ? " · needs reconnecting" : ""}` : "Not connected"}</div></div>
      <div className="row">{google && <button className="btn" onClick={() => drop(google.id)}>Disconnect</button>}<button className="btn primary" onClick={connectGoogle}>{google ? "Reconnect" : "Connect"}</button></div></div>
    <h2>Devices</h2><div className="list">{devices.map((d) => <div key={d.id} className="item"><div className="grow"><b>{d.label}</b><div className="small muted">{d.account} · {d.tools} tools{d.last_used_at ? ` · used ${fmt(d.last_used_at)}` : ""}</div></div><button className="btn" onClick={() => drop(d.id)}>Remove</button></div>)}{!devices.length && <div className="empty">No devices. Run <a href="https://github.com/leeguooooo/iphone-use" style={{ textDecoration: "underline" }}>iphone-use</a> on your Mac, expose it through a tunnel, and add it below.</div>}</div>
    <form onSubmit={add} className="card col mt16" style={{ maxWidth: 520 }}><b>Add a device (MCP server)</b><input className="input" placeholder="Name, e.g. My iPhone" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required /><input className="input" type="url" placeholder="https://…/mcp" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required /><input className="input" type="password" placeholder="Bearer token (if any)" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />{err && <div className="small" style={{ color: "var(--bad)" }}>{err}</div>}<button className="btn primary">Connect</button></form></div>;
}
function Reminders() {
  const [list, setList] = useState<any[]>([]);
  const load = () => api("/v1/reminders").then(setList);
  useEffect(() => { load(); }, []);
  return <div><h1>Reminders</h1><p className="muted">What your assistant will do or say later. Set them in iMessage.</p>
    <div className="list mt16">{list.map((s) => <div key={s.id} className="item"><div className="grow"><b>{s.text}</b><div className="small muted">{s.next} · {s.spec?.at ? "once" : "repeats"} · {s.room_kind === "group" ? s.room_name ?? "group" : "your chat"}{s.kind === "task" ? " · a job" : ""}</div></div><button className="btn" onClick={async () => { await api(`/v1/reminders/${s.id}`, undefined, "DELETE"); load(); }}>Cancel</button></div>)}{!list.length && <div className="empty">No reminders.</div>}</div></div>;
}
function Activity() {
  const [runs, setRuns] = useState<any[]>([]);
  useEffect(() => { api("/v1/runs").then(setRuns); }, []);
  return <div><h1>Activity</h1><p className="muted">Every request, each tool call, and the proof behind each action.</p>
    {runs.map((r) => <div key={r.id} className="card mt16"><div className="row between"><b>{r.request.slice(0, 140)}</b><span className="small faint">{fmt(r.created_at)} · {r.room_kind === "group" ? r.room_name ?? "group" : "your chat"} · {r.status} · {r.tier}{r.tier_reason ? ` (${r.tier_reason})` : ""} · ${Number(r.cost_usd).toFixed(4)}</span></div>
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
  useEffect(() => { if (signedIn) api("/v1/me").then(setMe).catch(() => setMe(null)); else setMe(null); }, [signedIn]);
  const page = hash.startsWith("/app") ? hash.replace(/\/$/, "") : "/";
  return <>{clerk && <Bridge onReady={setSignedIn} />}
    {page === "/" ? <Landing signedIn={!!signedIn} clerk={clerk} />
      : signedIn === false ? <div className="auth">{clerk ? <SignIn routing={"virtual" as any} withSignUp /> : <div className="card">Sign-in isn't set up on this server.</div>}</div>
      : !me ? null
      : !me.phone ? <Shell page={page}><PhoneGate me={me} onLinked={(u) => setMe({ ...me, ...u })} /></Shell>
      : <Shell page={page}>{page === "/app" ? <Chats /> : page === "/app/connections" ? <Connections /> : page === "/app/reminders" ? <Reminders /> : page === "/app/activity" ? <Activity /> : <Chats />}</Shell>}
  </>;
}
fetch("/v1/config").then((r) => r.json()).then((c) => {
  const clerk = c.clerk ?? null;
  createRoot(document.getElementById("root")!).render(clerk
    ? <ClerkProvider publishableKey={clerk} afterSignOutUrl="/" appearance={{ variables: { colorPrimary: "#111", fontFamily: "Inter, -apple-system, sans-serif", borderRadius: "12px" }, elements: { cardBox: { border: "2px solid #111", boxShadow: "6px 6px 0 #c6f432" }, formButtonPrimary: { background: "#111", boxShadow: "0 3px 0 #c6f432", fontWeight: 700, textTransform: "none" } } } as any}><App clerk={clerk} /></ClerkProvider>
    : <App clerk={null} />);
});
