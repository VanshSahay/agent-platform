// Memory is a tool the agent calls (remember). Scope agent = that agent's training; it follows the agent into every
// chat it is deployed to. Scope room = what was said in one chat; it stays there. Another agent's memory never shows.
// ponytail: Postgres full-text + recency; embeddings when paraphrase recall is the bottleneck.
import { sql, id, now } from "./db";

export type Scope = "agent" | "room";
export const KINDS = ["rule", "preference", "person", "schedule", "store", "inventory", "decision", "fact"] as const;

export async function remember(scope: Scope, scopeId: string, text: string, createdBy: string, kind = "fact") {
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const dup = (await sql`select id from memories where scope_type=${scope} and scope_id=${scopeId} and lower(regexp_replace(text, '[^[:alnum:] ]', '', 'g'))=${norm}`)[0];
  if (dup) { await sql`update memories set created_at=${now()}, kind=${kind} where id=${dup.id}`; return { id: dup.id, deduped: true }; }
  const mid = id("mem");
  await sql`insert into memories (id, scope_type, scope_id, text, kind, created_by, created_at) values (${mid}, ${scope}, ${scopeId}, ${text}, ${kind}, ${createdBy}, ${now()})`;
  return { id: mid };
}
export const forget = (mid: string) => sql`delete from memories where id=${mid}`;

const where = (room: { id: string; agent_id?: string | null }) => sql`((scope_type='room' and scope_id=${room.id}) or (scope_type='agent' and scope_id=${room.agent_id ?? ""}))`;
/** Standing instructions ("how I want you to behave"): every run sees all of them, not just the ones a query matches. */
export const rules = (room: { id: string; agent_id?: string | null }) => sql`select * from memories where kind='rule' and ${where(room)} order by created_at`;

export async function retrieve(room: { id: string; kind: string; agent_id?: string | null }, query: string, limit = room.kind === "private" ? 40 : 15) {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 12).join(" | ");
  const hits: any[] = terms
    ? await sql`select *, ts_rank(to_tsvector('simple', text), to_tsquery('simple', ${terms})) score from memories where to_tsvector('simple', text) @@ to_tsquery('simple', ${terms}) and ${where(room)} and kind!='rule' order by score desc limit ${limit}`
    : [];
  const recent: any[] = await sql`select * from memories where ${where(room)} and kind!='rule' order by created_at desc limit ${limit}`;
  const seen = new Set<string>(), out: any[] = [];
  for (const m of [...hits, ...recent]) if (!seen.has(m.id) && out.length < limit) { seen.add(m.id); out.push(m); }
  return out;
}
