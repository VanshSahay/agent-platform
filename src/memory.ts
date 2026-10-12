// Memory is a tool the agent calls (remember), scoped private (one person) or room (everyone in that chat).
// Retrieval: private memories only in the person's own DM; a group sees only its room's memories.
// ponytail: Postgres full-text + recency; embeddings when paraphrase recall is the bottleneck.
import { sql, id, now } from "./db";

export type Scope = "private" | "room";

export async function remember(scope: Scope, scopeId: string, text: string, createdBy: string) {
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const dup = (await sql`select id from memories where scope_type=${scope} and scope_id=${scopeId} and lower(regexp_replace(text, '[^[:alnum:] ]', '', 'g'))=${norm}`)[0];
  if (dup) { await sql`update memories set created_at=${now()} where id=${dup.id}`; return { id: dup.id, deduped: true }; }
  const mid = id("mem");
  await sql`insert into memories (id, scope_type, scope_id, text, created_by, created_at) values (${mid}, ${scope}, ${scopeId}, ${text}, ${createdBy}, ${now()})`;
  return { id: mid };
}

export const forget = (mid: string) => sql`delete from memories where id=${mid}`;

/** What this room may see: its own memories, plus the requester's private ones only in their own DM. */
export function scopesFor(room: { id: string; kind: string }, requesterId?: string | null): [Scope, string][] {
  const s: [Scope, string][] = [["room", room.id]];
  if (room.kind === "private" && requesterId) s.push(["private", requesterId]);
  return s;
}

export async function retrieve(room: { id: string; kind: string }, requesterId: string | null, query: string, limit = 10) {
  const priv = scopesFor(room, requesterId).find(([s]) => s === "private")?.[1] ?? ""; // "" never matches a private scope
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 12).join(" | ");
  const where = sql`((scope_type='room' and scope_id=${room.id}) or (scope_type='private' and scope_id=${priv}))`;
  const hits: any[] = terms
    ? await sql`select *, ts_rank(to_tsvector('simple', text), to_tsquery('simple', ${terms})) score from memories where to_tsvector('simple', text) @@ to_tsquery('simple', ${terms}) and ${where} order by score desc limit ${limit}`
    : [];
  const recent: any[] = await sql`select * from memories where ${where} order by created_at desc limit ${limit}`;
  const seen = new Set<string>(), out: any[] = [];
  for (const m of [...hits, ...recent]) if (!seen.has(m.id) && out.length < limit) { seen.add(m.id); out.push(m); }
  return out;
}
