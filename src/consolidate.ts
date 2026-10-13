// The background memory pass. The agent writes memories instantly through `remember`; once a day, for each agent whose
// memory changed, one cheap model call merges duplicates, rewrites corrected facts with their date, drops what was
// retracted, and derives a short profile (who the owner is, how they want things done, how much to ask vs just do).
// Nothing the agent said is deleted silently: every change is a dated rewrite the Memory page shows.
import { sql, now, one, fmtLocal } from "./db";
import { structured } from "./model";

const DAY = 864e5;

export async function consolidateAgent(agent: any, owner: any) {
  const mems = await sql`select * from memories where scope_type='agent' and scope_id=${agent.id} order by created_at`;
  if (!mems.length) return { changed: 0 };
  const tz = owner?.tz ?? "America/New_York";
  const listing = mems.map((m: any) => `[${m.id}] (${m.kind}, ${fmtLocal(m.created_at, tz)}) ${m.text}`).join("\n");
  const d = await structured<{ profile: string; rewrite: { id: string; text: string; kind?: string }[]; delete: string[] }>("cheap",
    `You maintain the memory of a personal agent named ${agent.name}${agent.purpose ? ` (for: ${agent.purpose})` : ""}, owned by ${owner?.name ?? "its owner"}. Below are its memories with ids, kinds and dates. Produce:
- "profile": at most 120 words, plain, present tense: who the owner is and what matters to them, how they want ${agent.name} to behave (when to ask, when to just do it, tone), the people and routines that matter. Only from the memories; no guessing.
- "rewrite": memories to replace, each {"id","text","kind"}: merge duplicates into the newest one (the others go in "delete"), turn several examples into one trait, and when a newer memory contradicts an older one, rewrite the older as a dated correction ("Used to shop at X; since Oct 12 shops at Y"). Keep ids. Keep rules as kind "rule".
- "delete": ids made redundant by a rewrite, or explicitly retracted ("that's not happening anymore").
Change as little as possible. Never invent facts. Return {"profile","rewrite","delete"}.`, listing, owner?.id);
  let changed = 0;
  const ids = new Set(mems.map((m: any) => m.id));
  for (const r of d.rewrite ?? []) if (ids.has(r.id) && r.text?.trim()) { await sql`update memories set text=${String(r.text).slice(0, 500)}, kind=${r.kind && ["rule", "preference", "person", "schedule", "store", "inventory", "decision", "fact"].includes(r.kind) ? r.kind : sql`kind`}, created_at=${now()} where id=${r.id}`; changed++; }
  for (const did of d.delete ?? []) if (ids.has(did)) { await sql`delete from memories where id=${did}`; changed++; }
  await sql`update agents set profile=${d.profile ? String(d.profile).slice(0, 1200) : null}, profile_at=${now()}, consolidated_at=${now()} where id=${agent.id}`;
  return { changed, profile: d.profile };
}

/** Once a day per agent whose memory changed since the last pass. Called from the hourly tick. */
export async function consolidateDue(limit = 20) {
  const due = await sql`select a.*, u.name owner_name, u.tz owner_tz, u.id owner_id2 from agents a join users u on u.id=a.owner_id
    where exists (select 1 from memories m where m.scope_type='agent' and m.scope_id=a.id and m.created_at > coalesce(a.consolidated_at, 0))
      and coalesce(a.consolidated_at, 0) < ${now() - DAY} limit ${limit}`;
  let n = 0;
  for (const a of due) {
    try { await consolidateAgent(a, { id: a.owner_id, name: a.owner_name, tz: a.owner_tz }); n++; }
    catch (e: any) { console.warn(`[consolidate] ${a.id}: ${e.message}`); await sql`update agents set consolidated_at=${now()} where id=${a.id}`; }
  }
  return n;
}
export { one };
