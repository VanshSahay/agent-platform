import type { ReactNode } from "react";

// ---------- agent message formatting ----------
// Agents write light markdown. Rendered to React elements directly (never innerHTML: model output is untrusted).
// Sections under a heading become cards; links become chips; tables become a compact grid.
const safeUrl = (u: string) => /^https?:\/\//i.test(u) ? u : null;
const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:[^)\s]+)\)|(https?:\/\/[^\s)<]+)|(?<![\w*])\*([^*\n]+)\*(?!\w)|📎 ([^\n]+?) \(file_id: (fil_\w+)\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[2]) out.push(<strong key={k}>{inline(m[2], i)}</strong>);
    else if (m[3]) out.push(<code key={k}>{m[3]}</code>);
    else if (m[4] && safeUrl(m[5])) out.push(<a key={k} className="lchip" href={m[5]} target="_blank" rel="noopener noreferrer">{/^(source|link|here|\d+)$/i.test(m[4].trim()) ? domainOf(m[5]) : m[4]} <span>↗</span></a>);
    else if (m[6]) { const u = m[6].replace(/[.,;:!?]+$/, ""); out.push(<a key={k} className="lchip" href={u} target="_blank" rel="noopener noreferrer">{domainOf(u)} <span>↗</span></a>); if (u.length < m[6].length) out.push(m[6].slice(u.length)); }
    else if (m[7]) out.push(<em key={k}>{m[7]}</em>);
    else if (m[8]) out.push(<a key={k} className="pill accent" href={`/v1/files/${m[9]}`}>📎 {m[8]}</a>);
    else out.push(m[0]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function Rich({ text }: { text: string }) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  type Block = { kind: "h" | "p" | "ul" | "ol" | "table"; level?: number; items: string[] };
  const blocks: Block[] = [];
  for (const raw of lines) {
    const l = raw.trimEnd(), t = l.trim(), prev = blocks.at(-1);
    if (!t) { blocks.push({ kind: "p", items: [] }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) continue; // dividers add noise; cards separate sections
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ kind: "h", level: h[1].length, items: [h[2].replace(/^\*\*(.*)\*\*$/, "$1")] }); continue; }
    if (/^\|.*\|$/.test(t)) { if (/^\|[\s:|-]+\|$/.test(t)) continue; if (prev?.kind === "table") prev.items.push(t); else blocks.push({ kind: "table", items: [t] }); continue; }
    const ul = t.match(/^[-*•]\s+(.*)$/), ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) { const kind = ul ? "ul" : "ol", item = (ul ?? ol)![1]; if (prev?.kind === kind) prev.items.push(item); else blocks.push({ kind, items: [item] }); continue; }
    if (prev?.kind === "p" && prev.items.length) prev.items.push(t); else blocks.push({ kind: "p", items: [t] });
  }
  const render = (b: Block, i: number): ReactNode => {
    if (b.kind === "p") return b.items.length ? <p key={i}>{b.items.flatMap((x, j) => j ? [<br key={`b${j}`} />, ...inline(x, j)] : inline(x, j))}</p> : null;
    if (b.kind === "ul") return <ul key={i}>{b.items.map((x, j) => <li key={j}>{inline(x, j)}</li>)}</ul>;
    if (b.kind === "ol") return <ol key={i}>{b.items.map((x, j) => <li key={j}>{inline(x, j)}</li>)}</ol>;
    if (b.kind === "table") {
      const rows = b.items.map((r) => r.slice(1, -1).split("|").map((c) => c.trim()));
      return <div key={i} className="rtable"><table><thead><tr>{rows[0].map((c, j) => <th key={j}>{inline(c, j)}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c, j)}</td>)}</tr>)}</tbody></table></div>;
    }
    return null;
  };
  // A heading starts a card that holds everything until the next heading of the same or higher level.
  const out: ReactNode[] = [];
  let card: { title: string; level: number; body: ReactNode[] } | null = null;
  const flush = () => { if (card) out.push(<div key={`c${out.length}`} className={`rcard l${card.level}`}><div className="rcard-t">{inline(card.title)}</div>{card.body}</div>); card = null; };
  blocks.forEach((b, i) => {
    if (b.kind === "h") { flush(); card = { title: b.items[0], level: b.level!, body: [] }; return; }
    const el = render(b, i); if (!el) return;
    if (card) card.body.push(el); else out.push(el);
  });
  flush();
  return <div className="rich">{out}</div>;
}

