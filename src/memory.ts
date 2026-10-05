// Scoped memory (plan §9). Chat history is not memory; memory is selected, scoped, retrievable knowledge with provenance.
// ponytail: FTS5 keyword + recency ranking; add pgvector embeddings when recall on paraphrases becomes the bottleneck.
import { all, one, exec, id, now, S, J, patchJson, dialect } from "./db";
import { structured } from "./model";

export type Scope = "user_private" | "room" | "workspace" | "agent" | "entity";

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function humansOf(roomId: string) {
  return all<{ principal_id: string }>("select principal_id from room_members where room_id=? and kind='human'", roomId).map((r) => r.principal_id);
}
const isMember = (ws: string, u: string) => !!one("select 1 from memberships where workspace_id=? and user_id=?", ws, u);

/** Write a memory. Enforces scope rules deterministically: private-chat content cannot become workspace/room-shared knowledge implicitly. */
export function remember(a: { run?: any; room: any; text: string; scope: Scope; kind?: string; createdBy: string; sourceEventIds?: string[]; confidence?: number; sensitivity?: string; scopeId?: string }) {
  const humans = humansOf(a.room.id);
  let scopeId = a.scopeId;
  if (a.scope === "workspace") {
    if (a.room.kind === "private") return { error: "private conversations can't write team memory; say it in a shared room or save it to the workspace explicitly from the web app" };
    if (a.run?.tainted) return { error: "this task read untrusted content, so it can't write team memory" };
    if (a.room.id && humans.some((h) => !isMember(a.room.workspace_id, h))) return { error: "rooms with outside guests can't write team memory" };
    scopeId = a.room.workspace_id;
  } else if (a.scope === "room") scopeId = a.room.id;
  else if (a.scope === "user_private") {
    scopeId = a.scopeId ?? a.run?.requested_by ?? humans[0];
    if (!scopeId) return { error: "no user for private memory" };
  } else if (a.scope === "agent") scopeId = a.run?.agent_id ?? a.scopeId;
  if (!scopeId) return { error: "missing scope" };

  const existing = all<any>("select id, text from memories where scope_type=? and scope_id=?", a.scope, scopeId).find((m) => norm(m.text) === norm(a.text));
  if (existing) {
    patchJson("memories", "source_event_ids", existing.id, (ids) => [...(ids ?? []), a.sourceEventIds?.[0] ?? null], []);
    exec("update memories set created_at=? where id=?", now(), existing.id);
    return { id: existing.id, scope: a.scope, deduped: true };
  }
  const mid = id("mem");
  exec(`insert into memories (id, workspace_id, scope_type, scope_id, kind, text, source_event_ids, created_by, confidence, sensitivity, created_at)
    values (?,?,?,?,?,?,?,?,?,?,?)`, mid, a.room.workspace_id, a.scope, scopeId, a.kind ?? "fact", a.text, S(a.sourceEventIds ?? []), a.createdBy,
    a.confidence ?? 0.8, a.sensitivity ?? "normal", now());
  if (dialect === "sqlite") exec("insert into memories_fts (id, text) values (?, ?)", mid, a.text); // Postgres searches memories directly (GIN index)
  return { id: mid, scope: a.scope, text: a.text };
}

/** Which (scope_type, scope_id) pairs may enter context in this room. Filtering happens before anything reaches a prompt (plan §9.5). */
export function allowedScopes(room: any, agentId: string, requesterId?: string): [string, string][] {
  const humans = humansOf(room.id);
  const scopes: [string, string][] = [["room", room.id], ["agent", agentId]];
  if (humans.every((h) => isMember(room.workspace_id, h))) scopes.push(["workspace", room.workspace_id]);
  // Private memory only when the requester is the sole human here.
  if (requesterId && humans.length === 1 && humans[0] === requesterId) scopes.push(["user_private", requesterId]);
  return scopes;
}

export function retrieve(room: any, agentId: string, query: string, requesterId?: string, limit = 8) {
  const scopes = allowedScopes(room, agentId, requesterId);
  const where = scopes.map(() => "(m.scope_type=? and m.scope_id=?)").join(" or ");
  const params = scopes.flat();
  const terms = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, 12);
  let hits: any[] = [];
  if (terms.length) {
    hits = dialect === "pg"
      ? all<any>(`select m.*, ts_rank(to_tsvector('simple', m.text), to_tsquery('simple', ?)) score from memories m
          where to_tsvector('simple', m.text) @@ to_tsquery('simple', ?) and (${where}) and (m.expires_at is null or m.expires_at > ?) order by score desc limit ?`,
          ...[0, 1].map(() => terms.map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).join(" | ")), ...params, now(), limit)
      : all<any>(`select m.*, bm25(memories_fts) score from memories_fts f join memories m on m.id=f.id
          where memories_fts match ? and (${where}) and (m.expires_at is null or m.expires_at > ?) order by score limit ?`,
          terms.map((t) => `"${t}"`).join(" OR "), ...params, now(), limit);
  }
  const recent = all<any>(`select m.* from memories m where (${where}) and (m.expires_at is null or m.expires_at > ?) order by created_at desc limit ?`, ...params, now(), limit);
  const seen = new Set<string>(), out: any[] = [];
  for (const m of [...hits, ...recent]) if (!seen.has(m.id) && out.length < limit) { seen.add(m.id); out.push(m); }
  return out;
}

/** Memory write pipeline (plan §9.4): extract candidates -> scope -> policy -> dedupe -> write. */
export async function extractAfterTurn(room: any, message: { id: string; text: string; sender: string; senderName: string }) {
  const heuristic = () => {
    const c: { text: string; kind: string }[] = [];
    const t = message.text;
    for (const m of t.matchAll(/\b(?:I|we) (prefer|like|love|hate|always|never|want|care more about)\b([^.!?]+)/gi))
      c.push({ text: `${message.senderName} ${m[1].toLowerCase()}${m[2]}`.trim(), kind: "preference" });
    for (const m of t.matchAll(/\bstarting (?:today|now|monday|tomorrow),? ([^.!?]+)/gi)) c.push({ text: m[1].trim(), kind: "decision" });
    for (const m of t.matchAll(/\bmy ([a-z ]{2,30}) is ([^.!?,]+)/gi)) c.push({ text: `${message.senderName}'s ${m[1]} is ${m[2].trim()}`, kind: "fact" });
    return { memories: c };
  };
  const { memories } = await structured<{ memories: { text: string; kind: string }[] }>("fast",
    "Extract durable facts, preferences or decisions worth remembering from this chat message. Third person, one sentence each. Return {\"memories\": [{\"text\", \"kind\"}]}; empty list if nothing durable.",
    `[${message.senderName}]: ${message.text}`, heuristic, room.workspace_id);
  // Scope classifier: private chat -> user's private memory; shared room -> room memory. Never workspace implicitly (plan §15.4).
  const scope: Scope = room.kind === "private" ? "user_private" : "room";
  return memories.slice(0, 5).map((m) => remember({ room, text: m.text, kind: m.kind, scope, scopeId: scope === "user_private" ? message.sender : undefined,
    createdBy: "memory-extractor", sourceEventIds: [message.id], confidence: 0.6 }));
}

export function listFor(workspaceId: string, filter: { scope_type?: string; scope_id?: string } = {}) {
  return all<any>(`select * from memories where workspace_id=? ${filter.scope_type ? "and scope_type=?" : ""} ${filter.scope_id ? "and scope_id=?" : ""} order by created_at desc limit 200`,
    workspaceId, ...[filter.scope_type, filter.scope_id].filter(Boolean)).map((m) => ({ ...m, source_event_ids: J(m.source_event_ids, []) }));
}
export function forget(memId: string) { exec("delete from memories where id=?", memId); if (dialect === "sqlite") exec("delete from memories_fts where id=?", memId); }
