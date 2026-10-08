// Objectives with steps: weeks-long things ("Mom's cataract surgery") as an ordered list of steps, each with an owner, a state,
// a due date and a note. The group sees progress in one line; the worker nudges the owner once when a step is overdue and
// escalates to whoever set it up two days later. Steps are done by the tools that already exist — this is only the ledger.
import { all, one, exec, emit, id, now, tzOf, fmtLocal } from "./db";
import * as rt from "./runtime";
import { parseDeadline } from "./orders";
import type { ToolDef } from "./tools";

export const STATES = ["todo", "doing", "waiting", "done", "blocked"] as const;
export interface Objective { id: string; workspace_id: string; room_id: string; agent_id: string; created_by: string; title: string; status: string; created_at: number }
export interface Step { id: string; objective_id: string; n: number; title: string; owner: string | null; status: string; due_at: number | null; note: string | null; nudged_at: number | null; escalated_at: number | null; updated_at: number }

const steps = (oid: string) => all<Step>("select * from objective_steps where objective_id=? order by n", oid);
const openIn = (roomId: string) => all<Objective>("select * from objectives where room_id=? and status='open' order by created_at desc", roomId);
const ESCALATE_AFTER = 2 * 864e5;
const fmtDay = (t: number, tz: string) => new Date(t).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });

/** One line the group can read: 3/7 done · now: Insurance pre-auth (Sarah, due Fri Oct 10) · next: Book transport. */
export function progress(o: Objective, tz: string) {
  const s = steps(o.id), done = s.filter((x) => x.status === "done").length, cur = s.find((x) => x.status !== "done"), next = s.find((x) => x !== cur && x.status !== "done" && x.n > (cur?.n ?? 0));
  const line = (x: Step) => `${x.title}${x.owner ? ` (${rt.nameOf(x.owner)}${x.due_at ? `, due ${fmtDay(x.due_at, tz)}` : ""})` : x.due_at ? ` (due ${fmtLocal(x.due_at, tz)})` : ""}${x.status === "waiting" ? " — waiting" : x.status === "blocked" ? " — blocked" : ""}`;
  return `${o.title}: ${done}/${s.length} done${cur ? ` · now: ${line(cur)}` : " · all done"}${next ? ` · next: ${next.title}` : ""}`;
}
export function view(o: Objective, tz: string) {
  return { id: o.id.slice(-6), title: o.title, status: o.status, progress: progress(o, tz),
    steps: steps(o.id).map((x) => ({ n: x.n, title: x.title, owner: x.owner ? rt.nameOf(x.owner) : null, status: x.status, due: x.due_at ? fmtLocal(x.due_at, tz) : null, note: x.note })) };
}
function find(roomId: string, ref: string | undefined) {
  const list = openIn(roomId);
  if (!ref) return list[0] ?? null;
  const r = String(ref).toLowerCase();
  return list.find((o) => o.id.endsWith(r)) ?? list.find((o) => o.title.toLowerCase().includes(r)) ?? null;
}
/** "me" is the person speaking (not the agent, as task owners default); names resolve to people in the chat. */
const ownerOf = (ctx: any, o: string) => /^(me|myself|i)$/i.test(o) ? ctx.run.requested_by : rt.resolveOwner(ctx.room.id, o, ctx.agent.id);
function findStep(o: Objective, ref: string | number) {
  const s = steps(o.id), r = String(ref).toLowerCase().trim();
  return (/^\d+$/.test(r) ? s.find((x) => x.n === Number(r)) : null) ?? s.find((x) => x.title.toLowerCase() === r) ?? s.find((x) => x.title.toLowerCase().includes(r)) ?? null;
}

/** Worker tick: nudge the owner once when a step is overdue; two days later, tell whoever set the objective up. */
export function checkObjectives() {
  let n = 0;
  for (const o of all<Objective>("select * from objectives where status='open'")) {
    const cur = steps(o.id).find((x) => x.status !== "done");
    if (!cur || !cur.due_at || now() < cur.due_at) continue;
    const tz = tzOf(o.created_by), who = cur.owner ? rt.nameOf(cur.owner) : "whoever has it";
    if (!cur.nudged_at) {
      exec("update objective_steps set nudged_at=? where id=?", now(), cur.id); n++;
      rt.postMessage(o.room_id, { sender: o.agent_id, text: `${o.title} — "${cur.title}" was due ${fmtLocal(cur.due_at, tz)}. ${who}, how's it going? Say "done" or "need help" and I'll update it.`, targets: rt.replyTargets(o.room_id, null) });
    } else if (!cur.escalated_at && now() >= cur.due_at + ESCALATE_AFTER) {
      exec("update objective_steps set escalated_at=? where id=?", now(), cur.id); n++;
      rt.postMessage(o.room_id, { sender: o.agent_id, text: `${rt.nameOf(o.created_by)}, "${cur.title}" (${o.title}) is two days past due and I haven't heard back from ${who}. Want to reassign it or push the date?`, targets: rt.replyTargets(o.room_id, null) });
      emit("OBJECTIVE_ESCALATED", { workspace_id: o.workspace_id, room_id: o.room_id, actor: o.agent_id, data: { objective_id: o.id, step: cur.n } });
    }
  }
  return n;
}

export function registerObjectiveTools(def: (d: ToolDef) => void) {
  const obj = (p: any, required: string[] = []) => ({ type: "object", properties: p, required, additionalProperties: false });
  const stepSchema = obj({ title: { type: "string" }, owner: { type: "string", description: "a person in this chat, 'me', or 'agent'" }, due: { type: "string", description: "ISO or natural ('next Friday', 'Oct 20')" } }, ["title"]);
  def({
    id: "objective.create", description: "Start a multi-step objective (a surgery, a move, a trip, an insurance claim) as an ordered list of steps, each with an owner and a due date where known. Use it for things that take days or weeks and involve several people; a single to-do is task.create. The chat sees progress in one line.",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ title: { type: "string" }, steps: { type: "array", items: stepSchema, minItems: 1 } }, ["title", "steps"]),
    async execute(i, ctx) {
      const o: Objective = { id: id("obj"), workspace_id: ctx.run.workspace_id, room_id: ctx.room.id, agent_id: ctx.agent.id, created_by: ctx.run.requested_by, title: String(i.title).slice(0, 120), status: "open", created_at: now() };
      exec("insert into objectives (id, workspace_id, room_id, agent_id, created_by, title, status, created_at) values (?,?,?,?,?,?,?,?)", o.id, o.workspace_id, o.room_id, o.agent_id, o.created_by, o.title, o.status, o.created_at);
      (i.steps as any[]).slice(0, 30).forEach((s, k) => {
        const due = s.due ? parseDeadline(String(s.due)) : null;
        if (s.due && due == null) throw new Error(`couldn't read the date "${s.due}" for step ${k + 1}`);
        exec("insert into objective_steps (id, objective_id, n, title, owner, status, due_at, note, nudged_at, escalated_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?)",
          id("stp"), o.id, k + 1, String(s.title).slice(0, 120), s.owner ? ownerOf(ctx, String(s.owner)) : null, "todo", due, null, null, null, now());
      });
      emit("OBJECTIVE_CREATED", { workspace_id: o.workspace_id, room_id: o.room_id, run_id: ctx.run.id, actor: ctx.agent.id, data: { objective_id: o.id, steps: i.steps.length } });
      return { status: "SUCCEEDED", output: view(o, tzOf(ctx.run.requested_by)) };
    },
  });
  def({
    id: "objective.update", description: "Move a step of an objective: status (todo, doing, waiting, done, blocked), owner, due date or a note. Refer to the step by number or words; the objective by words if there are several. Mark a step done only when it actually happened.",
    risk: "write_internal", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ objective: { type: "string" }, step: { type: "string" }, status: { type: "string", enum: [...STATES] }, owner: { type: "string" }, due: { type: "string" }, note: { type: "string" } }, ["step"]),
    async execute(i, ctx) {
      const o = find(ctx.room.id, i.objective); if (!o) throw new Error("no open objective in this chat");
      const s = findStep(o, i.step); if (!s) throw new Error(`no step "${i.step}" in ${o.title}; steps: ${steps(o.id).map((x) => `${x.n}. ${x.title}`).join(", ")}`);
      const due = i.due ? parseDeadline(String(i.due)) : undefined; if (i.due && due == null) throw new Error(`couldn't read the date "${i.due}"`);
      exec("update objective_steps set status=coalesce(?, status), owner=coalesce(?, owner), due_at=coalesce(?, due_at), note=coalesce(?, note), nudged_at=case when ? is null then nudged_at else null end, escalated_at=case when ? is null then escalated_at else null end, updated_at=? where id=?",
        i.status ?? null, i.owner ? ownerOf(ctx, String(i.owner)) : null, due ?? null, i.note ? String(i.note).slice(0, 500) : null, due ?? null, due ?? null, now(), s.id);
      if (steps(o.id).every((x) => x.status === "done")) exec("update objectives set status='done' where id=?", o.id);
      return { status: "SUCCEEDED", output: view({ ...o, status: one<any>("select status from objectives where id=?", o.id).status }, tzOf(ctx.run.requested_by)) };
    },
  });
  def({
    id: "objective.status", description: "Where an objective stands: steps, owners, what's due, what's next. Lists all open objectives in this chat if none is named.", risk: "read", idempotency: "safe", defaultApproval: "none",
    inputSchema: obj({ objective: { type: "string" } }),
    async execute({ objective }, ctx) {
      const tz = tzOf(ctx.run.requested_by);
      if (objective) { const o = find(ctx.room.id, objective); if (!o) throw new Error("no such open objective here"); return { status: "SUCCEEDED", output: view(o, tz) }; }
      return { status: "SUCCEEDED", output: { objectives: openIn(ctx.room.id).map((o) => view(o, tz)) } };
    },
  });
}
