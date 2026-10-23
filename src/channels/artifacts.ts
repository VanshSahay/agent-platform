import type { Artifact } from "../core/types.ts";

const esc = (x: unknown) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A document as sections: each heading opens one; list lines become items; other lines become notes. */
export interface DocSection {
  key: string;
  title: string;
  level: number;
  items: { key: string; text: string }[];
  notes: string[];
}
export function parseDocument(md: string, title: string): DocSection[] {
  const sections: DocSection[] = [];
  const slug = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  let cur: DocSection | undefined;
  const open = (t: string, level: number) => {
    cur = { key: `${sections.length}-${slug(t) || "s"}`, title: t, level, items: [], notes: [] };
    sections.push(cur);
    return cur;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      if (sections.length === 0 && h[1]!.length === 1 && h[2]!.trim().toLowerCase() === title.trim().toLowerCase()) continue; // the title itself
      open(h[2]!.trim(), h[1]!.length);
      continue;
    }
    const li = line.match(/^(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/);
    const sec = cur ?? open("", 2);
    if (li) sec.items.push({ key: `${sec.key}:${sec.items.length}-${slug(li[1]!)}`, text: li[1]!.trim() });
    else sec.notes.push(line);
  }
  return sections;
}

/** Shared state on a document: who ticked what, who claimed what, what was added. */
export interface DocState {
  checked: Record<string, string>; // item key -> who ticked it
  claimed: Record<string, string>; // item key -> who will bring it
  /** item key -> who set that claim; differs from `claimed` when someone put another member down. */
  claimedBy?: Record<string, string>;
  added: Record<string, { key: string; text: string; by: string }[]>; // section key -> items added on the page
}
export const emptyState = (): DocState => ({ checked: {}, claimed: {}, added: {} });

interface Dash {
  title: string;
  subtitle?: string;
  kpis?: { label: string; value: string; delta?: string; trend?: string }[];
  charts?: { type: string; title: string; labels: string[]; series: { name: string; data: number[] }[]; unit?: string }[];
}

const COLORS = ["#111", "#c6f432", "#ff7a45", "#3b82f6", "#9be7c4", "#ffe14d"];

function chartSvg(c: Dash["charts"] extends (infer T)[] | undefined ? T : never): string {
  const W = 560;
  const H = 240;
  const pad = 36;
  const labels = c.labels ?? [];
  const series = (c.series ?? []).slice(0, 6);
  const max = Math.max(1, ...series.flatMap((s) => s.data));
  if (c.type === "pie") {
    const data = series[0]?.data ?? [];
    const total = data.reduce((a, b) => a + b, 0) || 1;
    let angle = -Math.PI / 2;
    const slices = data.map((v, i) => {
      const a0 = angle;
      angle += (v / total) * Math.PI * 2;
      const a1 = angle;
      const r = 90;
      const cx = 140;
      const cy = 120;
      const p = (a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
      return `<path d="M${cx} ${cy} L${p(a0)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)} Z" fill="${COLORS[i % COLORS.length]}" stroke="#fff" stroke-width="2"/>`;
    });
    const legend = labels.map(
      (l, i) =>
        `<g transform="translate(260 ${40 + i * 22})"><rect width="12" height="12" fill="${COLORS[i % COLORS.length]}"/><text x="18" y="11" font-size="12">${esc(l)}: ${data[i] ?? 0}${esc(c.unit ?? "")}</text></g>`,
    );
    return `<svg viewBox="0 0 ${W} ${H}" width="100%">${slices.join("")}${legend.join("")}</svg>`;
  }
  const n = Math.max(1, labels.length);
  const x = (i: number) => pad + ((W - 2 * pad) * (i + 0.5)) / n;
  const y = (v: number) => H - pad - ((H - 2 * pad) * v) / max;
  const axes = `<line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#111" stroke-width="2"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#111" stroke-width="2"/>`;
  const xl = labels.map((l, i) => `<text x="${x(i)}" y="${H - pad + 16}" font-size="11" text-anchor="middle">${esc(l)}</text>`).join("");
  const yl = `<text x="${pad - 6}" y="${pad + 4}" font-size="11" text-anchor="end">${max}${esc(c.unit ?? "")}</text>`;
  let body = "";
  if (c.type === "line") {
    body = series
      .map((s, si) => `<polyline fill="none" stroke="${COLORS[si % COLORS.length]}" stroke-width="2.5" points="${s.data.map((v, i) => `${x(i)},${y(v)}`).join(" ")}"/>`)
      .join("");
  } else {
    const bw = (((W - 2 * pad) / n) * 0.7) / Math.max(1, series.length);
    body = series
      .map((s, si) =>
        s.data
          .map(
            (v, i) =>
              `<rect x="${x(i) - (bw * series.length) / 2 + si * bw}" y="${y(v)}" width="${bw}" height="${H - pad - y(v)}" fill="${COLORS[si % COLORS.length]}" stroke="#111"/>`,
          )
          .join(""),
      )
      .join("");
  }
  const legend =
    series.length > 1
      ? series
          .map(
            (s, i) =>
              `<g transform="translate(${pad + i * 120} 12)"><rect width="12" height="12" fill="${COLORS[i % COLORS.length]}"/><text x="18" y="11" font-size="12">${esc(s.name)}</text></g>`,
          )
          .join("")
      : "";
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${axes}${body}${xl}${yl}${legend}</svg>`;
}

const SHELL = (
  title: string,
  body: string,
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Rubik:wght@800&display=swap" rel="stylesheet">
<style>body{margin:0;background:#fbfbf8;color:#111;font:15.5px/1.6 Inter,system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:40px 20px 80px}h1{font:800 32px/1.1 Rubik,Inter,sans-serif;letter-spacing:-.03em;margin:0 0 6px}h2{font-size:20px;margin:28px 0 8px}h3{font-size:17px}.sub{color:#55554f;margin:0 0 24px}.card{background:#fff;border:2px solid #111;border-radius:16px;box-shadow:3px 3px 0 #111;padding:16px 18px;margin:14px 0}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.kpi .v{font:800 28px/1 Rubik,Inter,sans-serif}.kpi .l{color:#55554f;font-size:13px}.kpi .d{font-size:12px}.up{color:#16865a}.down{color:#c3352b}code{background:#f3f3ee;padding:1px 5px;border-radius:5px}img,audio{max-width:100%}a{color:#111}.foot{color:#8a8a83;font-size:12px;margin-top:40px}</style></head><body><main>${body}</main></body></html>`;

/** The page at /d/:id for whatever the agent made. */
/** Who is looking: a member of the chat may share the page; anyone else came in by a shared link. */
export interface Viewer {
  member: boolean;
}

export function artifactPage(a: Artifact, raw: boolean, viewer: Viewer = { member: true }): Response {
  const res = render(a, raw);
  if (typeof res !== "string") return res;
  // ponytail: the bar is spliced in before </main>, which every page shell has exactly once
  return html(res.replace("</main>", `${shareBar(a, viewer)}</main>`));
}

/** A member can open the page to anyone with the link; a visitor sees who made it and where to get one. */
function shareBar(a: Artifact, viewer: Viewer): string {
  if (!viewer.member)
    return `<aside class="sharebar cta"><span>Made with <strong>Circle</strong>, an assistant that lives in your group chat.</span><a class="sharebtn" href="/welcome">Get yours</a></aside><style>${SHARE_CSS}</style>`;
  const open = a.share === "link";
  return `<aside class="sharebar"><span id="shareNote">${open ? "Anyone with the link can open this page." : "Only members of the chat can open this page."}</span><button class="sharebtn" id="shareBtn" type="button">${open ? "Copy link" : "Share this page"}</button></aside><style>${SHARE_CSS}</style>
<script>(()=>{const b=document.getElementById("shareBtn"),n=document.getElementById("shareNote"),url=location.origin+location.pathname;let open=${open};b.onclick=async()=>{if(!open){try{const r=await fetch("/api/artifacts/${a.id}/share",{method:"PATCH",headers:{"content-type":"application/json","x-requested-with":"circle"},body:JSON.stringify({share:"link"})});if(!r.ok)throw new Error();open=true;n.textContent="Anyone with the link can open this page.";}catch{b.textContent="Could not share";return;}}
if(navigator.share){try{await navigator.share({title:document.title,url});return;}catch{}}
try{await navigator.clipboard.writeText(url);b.textContent="Link copied";}catch{n.textContent="Anyone with the link can open this page: "+url;b.textContent="Copy link";}};})();</script>`;
}
const SHARE_CSS =
  ".sharebar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:28px 0 0;padding:12px 16px;border:2px solid #111;border-radius:14px;background:#fff;font-size:14px}.sharebar.cta{background:#fff7d6}.sharebtn{font:600 14px Inter,system-ui,sans-serif;color:#fff;background:#111;border:0;border-radius:999px;padding:8px 14px;text-decoration:none;white-space:nowrap;cursor:pointer}";

/** The 403 for a page that is not shared: a page, not JSON, since the link was tapped by a person. */
export function privatePage(clerk?: { publishableKey: string; frontendApi: string }): Response {
  // The session cookie lives sixty seconds and only an open Circle tab refreshes it, so a link opened on its own
  // often arrives stale. Load Clerk here once, let it write a fresh cookie, and reload; a second miss stays put.
  const refresh = clerk
    ? `<script>(async()=>{if(sessionStorage.getItem("ret")===location.pathname)return;await new Promise((ok,no)=>{const s=document.createElement("script");s.src="https://${esc(clerk.frontendApi)}/npm/@clerk/clerk-js@5/dist/clerk.browser.js";s.setAttribute("data-clerk-publishable-key",${JSON.stringify(clerk.publishableKey)});s.async=true;s.crossOrigin="anonymous";s.onload=ok;s.onerror=no;document.head.appendChild(s);}).catch(()=>null);if(!window.Clerk)return;await Clerk.load();if(!Clerk.session)return;await Clerk.session.getToken();sessionStorage.setItem("ret",location.pathname);location.reload();})();</script>`
    : "";
  return new Response(
    SHELL(
      "Private page",
      `${refresh}<h1>This page is private</h1><p class="sub">It was made inside a chat. Sign in as a member of that chat to open it, or ask whoever sent it to share the page.</p><p><a class="sharebtn" href="/#signin">Sign in</a></p><aside class="sharebar cta"><span>Made with <strong>Circle</strong>, an assistant that lives in your group chat.</span><a class="sharebtn" href="/welcome">Get yours</a></aside><style>${SHARE_CSS}</style>`,
    ),
    { status: 403, headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" } },
  );
}

function render(a: Artifact, raw: boolean): Response | string {
  const d = a.data as Record<string, unknown>;
  const made = `<p class="foot">Made by the assistant on ${new Date(a.createdAt).toISOString().slice(0, 10)}.</p>`;
  if (a.kind === "document") {
    if (raw) return new Response(String(d.markdown ?? ""), { headers: { "content-type": "text/markdown; charset=utf-8" } });
    return documentApp(a);
  }
  if (a.kind === "hotels") return hotelsPage(a);
  if (a.kind === "flights") return flightsPage(a);
  if (a.kind === "dashboard") {
    const spec = d as unknown as Dash;
    const kpis = (spec.kpis ?? [])
      .map(
        (k) =>
          `<div class="card kpi"><div class="v">${esc(k.value)}</div><div class="l">${esc(k.label)}</div>${k.delta ? `<div class="d ${k.trend === "up" ? "up" : k.trend === "down" ? "down" : ""}">${esc(k.delta)}</div>` : ""}</div>`,
      )
      .join("");
    const charts = (spec.charts ?? []).map((c) => `<div class="card"><h3>${esc(c.title)}</h3>${chartSvg(c)}</div>`).join("");
    return SHELL(a.title, `<h1>${esc(spec.title)}</h1>${spec.subtitle ? `<p class="sub">${esc(spec.subtitle)}</p>` : ""}<div class="kpis">${kpis}</div>${charts}${made}`);
  }
  const mime = String(d.mimeType ?? "application/octet-stream");
  const bytes = Buffer.from(String(d.base64 ?? ""), "base64");
  if (raw || a.kind === "file")
    return new Response(bytes, {
      headers: { "content-type": mime, "content-disposition": a.kind === "file" ? `attachment; filename="${a.title.replace(/[^\w.-]+/g, "_")}"` : "inline" },
    });
  const media = a.kind === "image" ? `<img src="?raw=1" alt="${esc(a.title)}">` : `<audio controls src="?raw=1"></audio>`;
  return SHELL(
    a.title,
    `<h1>${esc(a.title)}</h1><div class="card">${media}</div>${d.prompt ? `<p class="sub">${esc(String(d.prompt))}</p>` : ""}${d.text ? `<p>${esc(String(d.text))}</p>` : ""}${made}`,
  );
}

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" } });

/**
 * The document as a small app: sections, tappable items, shared ticks and claims, a progress bar,
 * add-an-item, a copy link. State lives on the artifact (PATCH /api/artifacts/:id/state) so the
 * whole chat sees the same list; who you are comes from sign-in, or a picker when sign-in is off.
 */
function documentApp(a: Artifact): string {
  const sections = parseDocument(String((a.data as { markdown?: string }).markdown ?? ""), a.title);
  const boot = JSON.stringify({ id: a.id, title: a.title, sections, createdAt: a.createdAt });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${esc(a.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Rubik:wght@800;900&family=Caveat:wght@600&display=swap" rel="stylesheet">
<style>
:root{--ink:#111;--paper:#fff;--bg:#fbfbf8;--bg2:#f3f3ee;--muted:#55554f;--faint:#8a8a83;--line:#e2e2dc;--lime:#c6f432;--sun:#ffe14d;--tang:#ff7a45;--mint:#9be7c4;--display:Rubik,Inter,sans-serif;--hand:Caveat,cursive;color-scheme:light}
:root[data-theme="dark"]{--ink:#f2f2ec;--paper:#17171a;--bg:#101012;--bg2:#1f1f23;--muted:#b0b0a8;--faint:#77776f;--line:#2c2c31;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:15.5px/1.5 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding-block:0 80px}
main{max-width:720px;margin:0 auto;padding:28px 16px 0}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
h1{font:900 clamp(30px,2rem + 2vw,44px)/1.05 var(--display);letter-spacing:-.035em;margin:0 0 4px;text-wrap:balance}
.eyebrow{font:600 20px var(--hand);color:var(--muted);transform:rotate(-1.5deg);display:inline-block;margin-bottom:4px}
.tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{border:2px solid var(--ink);border-radius:12px;background:var(--paper);color:var(--ink);font:650 13.5px Inter,sans-serif;padding:7px 12px;cursor:pointer;box-shadow:0 3px 0 var(--ink);transition:transform .12s,box-shadow .12s}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 0 var(--ink)}.btn:active{transform:translateY(2px);box-shadow:0 1px 0 var(--ink)}
.btn.primary{background:var(--ink);color:var(--paper);box-shadow:inset 0 0 0 2px var(--paper),0 3px 0 var(--ink)}
select.who{border:2px solid var(--ink);border-radius:12px;padding:7px 10px;background:var(--paper);color:var(--ink);font:650 13.5px Inter,sans-serif;box-shadow:0 3px 0 var(--ink)}
.progress{margin:18px 0 6px;border:2px solid var(--ink);border-radius:999px;height:22px;background:var(--paper);overflow:hidden;position:relative;box-shadow:3px 3px 0 var(--ink)}
.progress i{display:block;height:100%;background:var(--lime);width:0;transition:width .5s cubic-bezier(.22,1,.36,1);background-image:repeating-linear-gradient(135deg,transparent 0 10px,rgba(17,17,17,.08) 10px 20px)}
.progress.done i{background:var(--mint)}
.count{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:13px;color:var(--muted);margin-bottom:22px;flex-wrap:wrap}
.count b{font:900 22px var(--display);color:var(--ink);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.people{display:flex;gap:6px;flex-wrap:wrap}.people span{display:inline-flex;align-items:center;gap:6px;border:1.5px solid var(--ink);border-radius:999px;padding:2px 9px 2px 3px;font-size:12px;background:var(--paper)}
.av{width:20px;height:20px;border-radius:50%;background:var(--c,var(--sun));border:1.5px solid var(--ink);display:inline-grid;place-items:center;font:800 10px var(--display);color:#111;flex:none}
.filters{display:flex;gap:6px;margin:0 0 16px;flex-wrap:wrap}.filters button{border:2px solid var(--ink);background:var(--paper);color:var(--ink);border-radius:999px;padding:4px 12px;font:700 12.5px Inter;cursor:pointer}.filters button.on{background:var(--ink);color:var(--paper)}
.caption{font:600 21px var(--hand);color:var(--muted);transform:rotate(-1deg);display:inline-block}
.stamp{position:fixed;right:18px;top:18px;z-index:8;border:4px solid var(--tang);color:var(--tang);font:900 22px var(--display);letter-spacing:.08em;padding:6px 14px;border-radius:10px;transform:rotate(-12deg) scale(.4);opacity:0;transition:transform .45s cubic-bezier(.34,1.56,.64,1),opacity .2s;pointer-events:none;background:var(--paper)}
.stamp.on{transform:rotate(-12deg) scale(1);opacity:1}
.eyes{display:inline-flex;gap:2px;vertical-align:-6px;margin-left:6px}.eyes svg{width:22px;height:26px}
.item{position:relative}.item.pop{animation:pop .4s cubic-bezier(.34,1.56,.64,1)}@keyframes pop{30%{transform:translateX(4px) rotate(.6deg)}60%{transform:translateX(-2px)}}
.plus1{position:absolute;left:44px;top:-6px;font:700 13px var(--hand);color:#16865a;animation:rise .9s ease-out forwards;pointer-events:none}@keyframes rise{to{transform:translateY(-22px);opacity:0}}
.item.hidden{display:none}
section{background:var(--paper);border:2.5px solid var(--ink);border-radius:18px;box-shadow:8px 8px 0 -2px var(--sheet),8px 8px 0 0 var(--ink);margin:0 0 20px;overflow:hidden;--sheet:var(--lime)}
section:nth-child(4n+2){--sheet:var(--sun)}section:nth-child(4n+3){--sheet:var(--mint)}section:nth-child(4n+4){--sheet:var(--tang)}
section>header .n{background:var(--sheet);border:1.5px solid var(--ink);border-radius:999px;padding:1px 9px;color:#111}
section>header{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;user-select:none}
section>header h2{margin:0;font:800 18px var(--display);letter-spacing:-.02em;flex:1}
section>header .n{font:600 12px Inter;color:var(--muted);font-variant-numeric:tabular-nums}
section>header .chev{transition:transform .25s}section.closed>header .chev{transform:rotate(-90deg)}
section.closed .body{display:none}
section.alldone>header h2::after{content:" ✓";color:#16865a}
.body{border-top:2px solid var(--ink);padding:6px 10px 10px}
.note{color:var(--ink);font-size:15px;padding:4px 8px;line-height:1.55}.note a{color:var(--ink);text-decoration:underline wavy var(--lime) 2px;text-underline-offset:3px}.note code{background:var(--bg2);padding:1px 5px;border-radius:5px;font-size:13px}
body.prose section{box-shadow:4px 4px 0 var(--ink)}body.prose .progress,body.prose #count,body.prose #filters,body.prose #hint,body.prose section>header .n,body.prose #who{display:none}
section.untitled>header{display:none}section.untitled .body{border-top:0}
.item{display:flex;align-items:center;gap:12px;padding:8px 8px;border-radius:12px;transition:background .15s}
.item:hover{background:var(--bg2)}
.box{width:26px;height:26px;border:2px solid var(--ink);border-radius:8px;background:var(--paper);flex:none;display:grid;place-items:center;cursor:pointer;transition:transform .15s cubic-bezier(.34,1.56,.64,1),background .15s}
.box svg{width:16px;height:16px;stroke:#111;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:24;stroke-dashoffset:24;transition:stroke-dashoffset .25s ease .05s}
.item.done .box{background:var(--lime);transform:rotate(-6deg) scale(1.06)}.item.done .box svg{stroke-dashoffset:0}
.item .t{flex:1;min-width:0;cursor:pointer;line-height:1.35}
.item.done .txt{color:var(--faint);text-decoration:line-through;text-decoration-thickness:2px;text-decoration-color:var(--ink)}
.item .by{font-size:11px;color:var(--faint);display:block}
.claim{border:1.5px dashed var(--faint);border-radius:999px;width:28px;height:28px;display:grid;place-items:center;background:transparent;cursor:pointer;color:var(--faint);font:800 12px var(--display);flex:none;padding:0}
.claim.has{border-style:solid;border-color:var(--ink);background:var(--sun);color:#111}
.menu{position:absolute;z-index:5;background:var(--paper);border:2px solid var(--ink);border-radius:12px;box-shadow:4px 4px 0 var(--ink);padding:6px;display:flex;flex-direction:column;gap:2px;min-width:160px}
.menu button{border:0;background:none;text-align:left;padding:7px 10px;border-radius:8px;font:500 14px Inter;color:var(--ink);cursor:pointer;display:flex;gap:8px;align-items:center}.menu button:hover{background:var(--lime);color:#111}
.add{display:flex;gap:8px;padding:6px 8px 2px}.add input{flex:1;min-width:0;border:2px dashed var(--faint);border-radius:10px;padding:7px 10px;background:transparent;color:var(--ink);font:inherit}.add input:focus{outline:0;border:2px solid var(--ink);box-shadow:0 0 0 3px var(--lime)}
.foot{color:var(--faint);font-size:12px;margin-top:28px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);background:var(--ink);color:var(--paper);padding:9px 14px;border-radius:12px;font-weight:600;opacity:0;transition:.25s;pointer-events:none}.toast.on{opacity:1;transform:translate(-50%,0)}
canvas#confetti{position:fixed;inset:0;pointer-events:none;z-index:9}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<main>
  <div class="top"><div><span class="eyebrow" id="eyebrow">from the chat ✦</span><h1 id="title"><span id="ttl"></span><span class="eyes" id="eyes" aria-hidden="true"><svg viewBox="0 0 24 28"><ellipse cx="12" cy="14" rx="10.5" ry="12.5" fill="#fff" stroke="#111" stroke-width="2.2"/><circle class="pupil" cx="12" cy="15" r="4.6" fill="#111"/></svg><svg viewBox="0 0 24 28"><ellipse cx="12" cy="14" rx="10.5" ry="12.5" fill="#fff" stroke="#111" stroke-width="2.2"/><circle class="pupil" cx="12" cy="15" r="4.6" fill="#111"/></svg></span></h1></div>
  <div class="tools"><button class="btn" id="copy">Copy link</button><button class="btn" id="theme">Dark</button><select class="who" id="who" aria-label="Who are you"></select></div></div>
  <div class="progress" id="bar"><i></i></div>
  <div class="count" id="count"><div><b id="num">0 of 0</b> done <span class="caption" id="caption"></span></div><div class="people" id="people"></div></div>
  <div class="filters" id="filters"><button class="on" data-f="all">Everything</button><button data-f="left">Still to do</button><button data-f="mine">Mine</button></div>
  <div class="stamp" id="stamp">DONE</div>
  <div id="sections"></div>
  <div class="foot"><span id="made"></span><span id="hint">Tap an item to tick it off. The circle marks who takes it. Everyone sees the same page.</span></div>
</main>
<div class="toast" id="toast"></div><canvas id="confetti"></canvas>
<script>
const BOOT=${boot};
const $=(s)=>document.querySelector(s);const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
let state={checked:{},claimed:{},added:{}},members=[],me="",closed=new Set(),celebrated=false;
const api=async(path,body,method)=>{const r=await fetch(path,{method:method??(body?"PATCH":"GET"),headers:body?{"content-type":"application/json"}:{},body:body?JSON.stringify(body):undefined});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error??r.status);return r.json()};
const initials=(n)=>n.split(/\\s+/).map((x)=>x[0]).join("").slice(0,2).toUpperCase();
const PAL=["#c6f432","#ffe14d","#ff7a45","#9be7c4","#b9b0ff","#ffb3c7"];const colour=(n)=>{let h=0;for(const c of n)h=(h*31+c.charCodeAt(0))>>>0;return PAL[h%PAL.length]};
const av=(n)=>'<i class="av" style="--c:'+colour(n)+'">'+esc(initials(n))+'</i>';
let filter="all",justTicked=null;
const captionFor=(d,t)=>t===0?"":d===0?"nothing ticked yet…":d===t?"all done!":d/t<.34?"a start":d/t<.67?"getting there":d/t<1?"nearly there":"";
const inline=(t)=>esc(t).replace(/\x60([^\x60]+)\x60/g,"<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>").replace(/(^|[^*\\w])\\*([^*\\n]+)\\*(?!\\w)/g,"$1<em>$2</em>").replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/(^|[\\s(])(https?:\\/\\/[^\\s<)]+)/g,'$1<a href="$2" target="_blank" rel="noopener">$2</a>');
const toast=(t)=>{const el=$("#toast");el.textContent=t;el.classList.add("on");setTimeout(()=>el.classList.remove("on"),1600)};
const allItems=()=>BOOT.sections.flatMap((s)=>[...s.items,...(state.added[s.key]??[])]);
function render(){
  $("#ttl").textContent=BOOT.title;
  const isList=allItems().length>0;document.body.classList.toggle("prose",!isList);$("#eyebrow").textContent=isList?"a list for the chat ✦":"a note from the chat ✦";
  $("#made").textContent="Made by the assistant on "+new Date(BOOT.createdAt).toLocaleDateString([], {month:"short",day:"numeric",year:"numeric"});
  const items=allItems(),done=items.filter((i)=>state.checked[i.key]).length;
  $("#num").textContent=done+" of "+items.length;$("#bar").querySelector("i").style.width=(items.length?done/items.length*100:0)+"%";$("#bar").classList.toggle("done",items.length>0&&done===items.length);
  $("#caption").textContent=captionFor(done,items.length);$("#stamp").classList.toggle("on",items.length>0&&done===items.length);
  document.querySelectorAll("#eyes .pupil").forEach((p)=>{p.setAttribute("r",String(3.6+ (items.length?done/items.length:0)*2.2))});
  const byPerson={};for(const k of Object.keys(state.checked)){byPerson[state.checked[k]]=(byPerson[state.checked[k]]??0)+1}
  $("#people").innerHTML=Object.entries(byPerson).map(([n,c])=>'<span>'+av(n)+esc(n)+' · '+c+'</span>').join("");
  $("#sections").innerHTML=BOOT.sections.map((s)=>{const its=[...s.items,...(state.added[s.key]??[])];const d=its.filter((i)=>state.checked[i.key]).length;
    return '<section data-key="'+esc(s.key)+'" class="'+(closed.has(s.key)?"closed ":"")+(s.title?"":"untitled ")+(its.length&&d===its.length?"alldone":"")+'"><header><svg class="chev" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 8l5 5 5-5"/></svg><h2>'+esc(s.title||"Items")+'</h2><span class="n">'+d+'/'+its.length+'</span></header><div class="body">'
      +s.notes.map((n)=>'<p class="note">'+inline(n)+'</p>').join("")
      +its.map((i)=>{const who=state.checked[i.key],cl=state.claimed[i.key];const hide=(filter==="left"&&who)||(filter==="mine"&&cl!==me&&who!==me);return '<div class="item '+(who?"done ":"")+(hide?"hidden ":"")+(justTicked===i.key?"pop":"")+'" data-key="'+esc(i.key)+'"><div class="box" role="checkbox" aria-checked="'+(who?"true":"false")+'" tabindex="0"><svg viewBox="0 0 20 20"><path d="M4 10.5l4 4 8-9"/></svg></div><div class="t"><span class="txt">'+inline(i.text)+'</span>'+(who?'<span class="by">ticked by '+esc(who)+'</span>':cl?'<span class="by">'+esc(cl)+' brings it</span>':i.by?'<span class="by">added by '+esc(i.by)+'</span>':"")+'</div><button class="claim '+(cl?"has":"")+'" style="'+(cl?"background:"+colour(cl):"")+'" title="'+esc(cl?cl+" brings this":"Who brings this?")+'">'+(cl?esc(initials(cl)):"+")+'</button>'+(justTicked===i.key&&who?'<span class="plus1">+1 packed</span>':"")+'</div>'}).join("")
      +(isList||its.length?'<form class="add"><input placeholder="Add something to '+esc(s.title||"the list")+'…" aria-label="Add an item" /></form>':"")+'</div></section>'}).join("");
  if(items.length&&done===items.length&&!celebrated){celebrated=true;confetti()}
  if(done<items.length)celebrated=false;
}
async function save(patch){try{state=await api("/api/artifacts/"+BOOT.id+"/state",{...patch,me})}catch(e){toast(String(e.message||e))}render()}
async function load(){try{const r=await api("/api/artifacts/"+BOOT.id);state=r.state;members=r.members;const w=$("#who");const stored=(()=>{try{return localStorage.getItem("circle.docme")}catch{return null}})();me=r.me||stored||members[0]||"";w.innerHTML=members.map((m)=>'<option '+(m===me?"selected":"")+'>'+esc(m)+'</option>').join("")+(members.includes(me)||!me?"":'<option selected>'+esc(me)+'</option>');if(r.me){w.disabled=true}}catch(e){toast("Could not load: "+e.message)}render()}
document.addEventListener("click",(e)=>{
  const box=e.target.closest(".box"),t=e.target.closest(".t"),claim=e.target.closest(".claim"),head=e.target.closest("section>header");
  $(".menu")?.remove();
  if(box||t){const key=e.target.closest(".item").dataset.key;const checked={...state.checked};if(checked[key])delete checked[key];else checked[key]=me||"someone";state.checked=checked;justTicked=checked[key]?key:null;render();setTimeout(()=>{justTicked=null},900);save({checked:{[key]:checked[key]??null}});return}
  const fb=e.target.closest("#filters button");if(fb){filter=fb.dataset.f;document.querySelectorAll("#filters button").forEach((b)=>b.classList.toggle("on",b===fb));render();return}
  if(claim){const item=claim.closest(".item"),key=item.dataset.key,r=claim.getBoundingClientRect();const m=document.createElement("div");m.className="menu";m.style.left=Math.min(r.left,innerWidth-180)+"px";m.style.top=(r.bottom+scrollY+6)+"px";
    m.innerHTML=members.map((n)=>'<button data-n="'+esc(n)+'">'+av(n)+esc(n)+'</button>').join("")+'<button data-n="">Nobody yet</button>';document.body.appendChild(m);
    m.onclick=(ev)=>{const b=ev.target.closest("button");if(!b)return;const claimed={...state.claimed};if(b.dataset.n)claimed[key]=b.dataset.n;else delete claimed[key];state.claimed=claimed;m.remove();render();save({claimed:{[key]:b.dataset.n||null}})};return}
  if(head){const k=head.parentElement.dataset.key;closed.has(k)?closed.delete(k):closed.add(k);render()}
});
document.addEventListener("keydown",(e)=>{if((e.key===" "||e.key==="Enter")&&e.target.classList?.contains("box")){e.preventDefault();e.target.click()}});
document.addEventListener("submit",(e)=>{const f=e.target.closest("form.add");if(!f)return;e.preventDefault();const text=f.querySelector("input").value.trim();if(!text)return;const sk=f.closest("section").dataset.key;save({add:{section:sk,text}});f.querySelector("input").value=""});
$("#who").onchange=(e)=>{me=e.target.value;try{localStorage.setItem("circle.docme",me)}catch{}};
$("#copy").onclick=async()=>{try{await navigator.clipboard.writeText(location.href);toast("Link copied")}catch{toast(location.href)}};
$("#theme").onclick=()=>{const d=document.documentElement.dataset.theme==="dark";document.documentElement.dataset.theme=d?"light":"dark";$("#theme").textContent=d?"Dark":"Light";try{localStorage.setItem("circle.doctheme",d?"light":"dark")}catch{}};
try{const th=localStorage.getItem("circle.doctheme");if(th){document.documentElement.dataset.theme=th;$("#theme").textContent=th==="dark"?"Light":"Dark"}}catch{}
function confetti(){if(matchMedia("(prefers-reduced-motion: reduce)").matches)return;const c=$("#confetti"),x=c.getContext("2d");c.width=innerWidth;c.height=innerHeight;const ps=Array.from({length:140},()=>({x:innerWidth/2,y:innerHeight/3,vx:(Math.random()-.5)*14,vy:Math.random()*-12-4,r:Math.random()*6+4,c:["#c6f432","#ffe14d","#ff7a45","#9be7c4","#111"][Math.random()*5|0],a:Math.random()*6}));let n=0;(function tick(){x.clearRect(0,0,c.width,c.height);for(const p of ps){p.x+=p.vx;p.y+=p.vy;p.vy+=.45;p.a+=.1;x.save();x.translate(p.x,p.y);x.rotate(p.a);x.fillStyle=p.c;x.fillRect(-p.r/2,-p.r/2,p.r,p.r*.6);x.restore()}if(++n<90)requestAnimationFrame(tick);else x.clearRect(0,0,c.width,c.height)})()}
addEventListener("pointermove",(e)=>{document.querySelectorAll("#eyes svg").forEach((sv)=>{const r=sv.getBoundingClientRect();const a=Math.atan2(e.clientY-r.top-r.height/2,e.clientX-r.left-r.width/2);const p=sv.querySelector(".pupil");p.setAttribute("cx",String(12+Math.cos(a)*4));p.setAttribute("cy",String(15+Math.sin(a)*4))})},{passive:true});
load();setInterval(()=>{if(!document.hidden)api("/api/artifacts/"+BOOT.id).then((r)=>{state=r.state;render()}).catch(()=>{})},4000);
</script></body></html>`;
}

/** The hotel comparison: one card per hotel, our price against the cheapest public one, a book button. */
export interface HotelsData {
  city: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  stars?: number;
  publicSource: string;
  bookUrl?: string;
  rows: {
    name: string;
    stars?: number;
    rating?: number;
    address?: string;
    photo?: string;
    room: string;
    board: string;
    refundable: boolean;
    feesAtHotelUsd: number;
    oursUsd: number;
    pub?: {
      totalUsd: number;
      seller: string;
      refundable: boolean;
      url: string;
      allIn?: boolean;
      taxesEstimated?: boolean;
      room?: string;
      listedBelow?: { seller: string; totalUsd: number; url: string };
    };
  }[];
}
const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
function hotelsPage(a: Artifact): string {
  const d = a.data as HotelsData;
  const cheaper = d.rows.filter((r) => r.pub && r.pub.totalUsd > r.oursUsd);
  const best = cheaper.map((r) => r.pub!.totalUsd - r.oursUsd).sort((x, y) => y - x)[0];
  const cards = d.rows
    .map((r) => {
      const save = r.pub ? r.pub.totalUsd - r.oursUsd : undefined;
      const badge =
        save === undefined
          ? `<span class="badge none">no public price found</span>`
          : save > 0
            ? `<span class="badge save">save ${money(save)} · ${Math.round((save / r.pub!.totalUsd) * 100)}%</span>`
            : `<span class="badge lose">${money(-save)} cheaper on ${esc(r.pub!.seller)}</span>`;
      const photo = r.photo && /^https:\/\//.test(r.photo) ? `<img src="${esc(r.photo)}" alt="" loading="lazy">` : `<div class="nophoto"></div>`;
      return `<article class="hotel">${photo}<div class="body"><h2>${esc(r.name)}</h2><p class="meta">${r.stars ? `${"★".repeat(r.stars)} · ` : ""}${r.rating ? `${r.rating}/10 · ` : ""}${esc(r.address ?? "")}</p><p class="room">${esc(r.room)}${r.board ? ` · ${esc(r.board)}` : ""} · ${r.refundable ? "free cancellation" : "non-refundable"}${r.feesAtHotelUsd ? ` · ${money(r.feesAtHotelUsd)} paid at the hotel` : ""}</p><div class="prices"><div class="ours"><span class="l">Through us</span><span class="v">${money(r.oursUsd)}</span><span class="n">${d.nights} nights, taxes in</span></div><div class="pub"><span class="l">${r.pub && !r.pub.allIn ? "Public, before taxes & fees" : "Cheapest public, all-in"}</span>${r.pub ? `<span class="v">${money(r.pub.totalUsd)}</span><span class="n">on <a href="${esc(r.pub.url)}" rel="noopener" target="_blank">${esc(r.pub.seller)}</a>${r.pub.taxesEstimated ? ", taxes estimated" : ""}${r.pub.refundable ? ", free cancellation" : ""}${r.pub.room ? `<br>${esc(r.pub.room)}` : ""}${r.pub.listedBelow ? `<br><a href="${esc(r.pub.listedBelow.url)}" rel="noopener" target="_blank">${esc(r.pub.listedBelow.seller)}</a> lists ${money(r.pub.listedBelow.totalUsd)} before taxes & fees` : ""}</span>` : `<span class="v dim">—</span><span class="n">not listed for these dates</span>`}</div></div>${badge}${d.bookUrl ? `<a class="book" href="${esc(d.bookUrl)}" target="_blank" rel="noopener">Book through us →</a>` : ""}</div></article>`;
    })
    .join("");
  const summary = `${d.rows.length} hotels · ${cheaper.length} cheaper through us${best ? ` · best saving ${money(best)}` : ""} · public prices from ${esc(d.publicSource)}`;
  return SHELL(
    a.title,
    `<h1>${esc(d.city)}</h1><p class="sub">${esc(d.checkIn)} to ${esc(d.checkOut)} · ${d.nights} nights · ${d.adults} adults${d.stars ? ` · ${d.stars}★` : ""}</p><p class="summary">${summary}</p>${d.bookUrl ? "" : `<p class="note">Booking through us is not set up on this server yet, so this page compares only.</p>`}${cards}<p class="foot">Made by the assistant on ${new Date(a.createdAt).toISOString().slice(0, 10)}. "Through us" is our price for the whole stay with taxes included. ${
      d.publicSource === "Booking.com"
        ? "The public price is Booking.com's total for its cheapest room for the dates, with the taxes and fees Booking lists at checkout added, so it is what you would pay there."
        : `The public price is the lowest total on ${esc(d.publicSource)} from a major seller (the hotel's own site, Booking.com, Expedia, Hotels.com), made all-in: Google lists most sellers before tax, so where it says "taxes estimated" Google's own tax-and-fee estimate for that hotel was added (checked against Expedia's checkout within $11). Discount resellers' checkouts add more than taxes, so their lower figures are shown but not counted.`
    } Each side is its cheapest room for the dates, so the rooms can differ.</p>
<style>.summary{font-weight:600;margin:0 0 18px}.note{color:#8a4b00;background:#fff4e0;border-radius:10px;padding:8px 12px}.hotel{display:grid;grid-template-columns:200px 1fr;gap:0;background:#fff;border:2px solid #111;border-radius:16px;box-shadow:3px 3px 0 #111;margin:16px 0;overflow:hidden}.hotel img,.nophoto{width:100%;height:100%;min-height:170px;object-fit:cover;background:#eee}.hotel .body{padding:14px 18px 16px;position:relative}.hotel h2{margin:0 0 2px;font-size:20px}.hotel .meta,.hotel .room{margin:0;color:#55554f;font-size:13px}.hotel .room{margin:6px 0 10px;color:#111}.prices{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0}.prices .l{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#55554f}.prices .v{display:block;font:800 26px/1.1 Rubik,Inter,sans-serif}.prices .v.dim{color:#aaa}.prices .n{display:block;font-size:12px;color:#55554f}.ours{border-left:4px solid #16865a;padding-left:10px}.badge{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:3px 10px;margin:4px 0}.badge.save{background:#e2f7ec;color:#16865a}.badge.lose{background:#fde8e6;color:#c3352b}.badge.none{background:#f3f3ee;color:#55554f}.book{display:inline-block;margin:6px 0 0 8px;background:#111;color:#fff;text-decoration:none;font-weight:600;font-size:13px;border-radius:999px;padding:7px 14px}@media(max-width:600px){.hotel{grid-template-columns:1fr}.hotel img,.nophoto{max-height:180px}}</style>`,
  );
}

/** The flight comparison: one card per itinerary, our fare against the public one, matched by flight numbers. */
export interface FlightsData {
  origin: string;
  destination: string;
  date: string;
  returnDate?: string;
  adults: number;
  cabin: string;
  publicSource: string;
  rows: {
    airline: string;
    flights: string[];
    departAt: string;
    arriveAt: string;
    durationMin: number;
    returnDurationMin?: number;
    stops: number;
    ours?: { totalUsd: number; cabin: string; refundable: boolean; changeable: boolean; checkedBag: boolean };
    pub?: { totalUsd: number; seller: string; url: string };
  }[];
}
function flightsPage(a: Artifact): string {
  const d = a.data as FlightsData;
  const hhmm = (iso: string) => iso.slice(11, 16);
  const dur = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  const cheaper = d.rows.filter((r) => r.ours && r.pub && r.pub.totalUsd > r.ours.totalUsd + 1).length;
  const cards = d.rows
    .map((r) => {
      const badge = !r.ours
        ? `<span class="badge none">not in our inventory</span>`
        : !r.pub
          ? `<span class="badge none">no public price</span>`
          : r.pub.totalUsd > r.ours.totalUsd + 1
            ? `<span class="badge save">save ${money(r.pub.totalUsd - r.ours.totalUsd)} with us</span>`
            : r.ours.totalUsd > r.pub.totalUsd + 1
              ? `<span class="badge lose">${money(r.ours.totalUsd - r.pub.totalUsd)} cheaper on ${esc(r.pub.seller)}</span>`
              : `<span class="badge none">same price</span>`;
      return `<article class="hotel flight"><div class="body"><h2>${esc(r.airline)} <small>${esc(r.flights.join(" › "))}</small></h2><p class="meta">${esc(d.origin)} ${hhmm(r.departAt)} → ${esc(d.destination)} ${hhmm(r.arriveAt)} · ${r.returnDurationMin !== undefined ? `${dur(r.durationMin)} out, ${dur(r.returnDurationMin)} back` : dur(r.durationMin)} · ${r.stops ? `${r.stops} stop${r.stops > 1 ? "s" : ""}${r.returnDurationMin !== undefined ? " each way at most" : ""}` : "nonstop"}${r.ours ? ` · ${esc(r.ours.cabin)}${r.ours.refundable ? " · refundable" : ""}${r.ours.checkedBag ? " · bag included" : ""}` : ""}</p><div class="prices"><div class="ours"><span class="l">Through us</span>${r.ours ? `<span class="v">${money(r.ours.totalUsd)}</span><span class="n">all in, ${d.adults} adult${d.adults > 1 ? "s" : ""}</span>` : `<span class="v dim">—</span><span class="n">not offered by our source</span>`}</div><div class="pub"><span class="l">Public</span>${r.pub ? `<span class="v">${money(r.pub.totalUsd)}</span><span class="n">on <a href="${esc(r.pub.url)}" rel="noopener" target="_blank">${esc(r.pub.seller)}</a></span>` : `<span class="v dim">—</span><span class="n">not listed</span>`}</div></div>${badge}</div></article>`;
    })
    .join("");
  const summary = `${d.rows.length} itineraries · ${cheaper} cheaper through us · public prices from ${esc(d.publicSource)}`;
  return SHELL(
    a.title,
    `<h1>${esc(d.origin)} → ${esc(d.destination)}</h1><p class="sub">${esc(d.date)}${d.returnDate ? ` to ${esc(d.returnDate)}` : ", one way"} · ${d.adults} adult${d.adults > 1 ? "s" : ""} · ${esc(d.cabin.replace("_", " "))}</p><p class="summary">${summary}</p><p class="note">Booking through us is not set up on this server yet, so this page compares only.</p>${cards}<p class="foot">Made by the assistant on ${new Date(a.createdAt).toISOString().slice(0, 10)}. "Through us" is our fare with taxes and fees; the public price is the lowest total found on ${esc(d.publicSource)} for the same flights.</p>
<style>.summary{font-weight:600;margin:0 0 18px}.note{color:#8a4b00;background:#fff4e0;border-radius:10px;padding:8px 12px}.hotel{background:#fff;border:2px solid #111;border-radius:16px;box-shadow:3px 3px 0 #111;margin:16px 0;overflow:hidden}.hotel .body{padding:14px 18px 16px}.hotel h2{margin:0 0 2px;font-size:20px}.hotel h2 small{font-weight:500;color:#55554f;font-size:13px;margin-left:6px}.hotel .meta{margin:0 0 8px;color:#55554f;font-size:13px}.prices{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0}.prices .l{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#55554f}.prices .v{display:block;font:800 26px/1.1 Rubik,Inter,sans-serif}.prices .v.dim{color:#aaa}.prices .n{display:block;font-size:12px;color:#55554f}.ours{border-left:4px solid #16865a;padding-left:10px}.badge{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:3px 10px;margin:4px 0}.badge.save{background:#e2f7ec;color:#16865a}.badge.lose{background:#fde8e6;color:#c3352b}.badge.none{background:#f3f3ee;color:#55554f}</style>`,
  );
}
