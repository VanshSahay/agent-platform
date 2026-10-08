// The durable task graph (plan §3.1, PRs 1 and 3): what the person asked for as actions with slots, each bound to the tool
// execution that addressed it and to the evidence that proves it. Shadow-written beside the brief today; the trace, the
// approval card and the gate read it. ponytail: verifiers are a map keyed by tool, not a capability registry — promote to
// src/capabilities/ when a third domain (booking, payment) needs its own adapter.
import { all, one, exec, emit, id, now, S, J } from "./db";
import type { Brief, Facts } from "./intake";
import { getTool } from "./tools";

export type ActionStatus = "not_started" | "running" | "waiting_human" | "waiting_external" | "verified" | "observed" | "uncertain" | "blocked" | "cancelled";
export type TaskStatus = "working" | "waiting_human" | "waiting_external" | "verified" | "uncertain" | "blocked" | "cancelled" | "done";
const WRITE = ["write_internal", "write_external", "destructive"];

/** The evidence a tool execution gives for its action, judged by code, never by the model's words. */
const VERIFIERS: Record<string, (input: any, result: any, facts?: Facts) => { verdict: "verified" | "observed" | "uncertain"; provider_ref?: string; facts?: any; note?: string }> = {
  "email.send": (i, r) => r?.__status === "UNKNOWN" || !(r?.id || r?.message_id) ? { verdict: "uncertain", note: "no provider message id" } : { verdict: "verified", provider_ref: String(r.id ?? r.message_id), facts: { to: i.to, subject: i.subject } },
  "email.draft": (i, r) => ({ verdict: "observed", provider_ref: r?.draft_id ? String(r.draft_id) : undefined, facts: { to: i.to, subject: i.subject }, note: "a draft; nothing was sent" }),
  "calendar.create_event": (i, r) => r?.id || r?.event_id || r?.link ? { verdict: "verified", provider_ref: String(r.id ?? r.event_id ?? r.link), facts: { title: i.title, start: i.start ?? r?.start } } : { verdict: "uncertain", note: "no event id back from the provider" },
  "calendar.find_free_time": (i, r, f) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(i.from ?? "")) ? String(i.from) : null, to = /^\d{4}-\d{2}-\d{2}$/.test(String(i.to ?? "")) ? String(i.to) : null;
    const covers = !f?.dates?.length || !from || !to || f.dates.some((d) => d >= from && d <= to);
    return covers ? { verdict: "observed", facts: { from, to, slots: Array.isArray(r?.slots) ? r.slots.length : undefined } } : { verdict: "uncertain", note: `looked at ${from}–${to}, the request was about ${f!.dates[0]}` };
  },
  "reminder.schedule": (i, r) => r?.reminder_id ? { verdict: "verified", provider_ref: String(r.reminder_id), facts: { text: i.text, next: r.next, tz: r.time_zone } } : { verdict: "uncertain", note: "no schedule id" },
  "contacts.search": (_i, r) => (Array.isArray(r?.results ?? r?.contacts) ? (r.results ?? r.contacts).length : r?.email ? 1 : 0) > 0 ? { verdict: "observed", facts: { matches: (r.results ?? r.contacts ?? [r]).length } } : { verdict: "uncertain", note: "no contact matched" },
  "reservations.book": (_i, r) => r?.confirmation || r?.reservation_id ? { verdict: "verified", provider_ref: String(r.confirmation ?? r.reservation_id) } : { verdict: "uncertain", note: "no confirmation number" },
  "browser.task": (_i, r) => r?.confirmation || r?.order_id ? { verdict: "verified", provider_ref: String(r.confirmation ?? r.order_id) } : { verdict: "observed", note: "browser reported text, no confirmation reference" },
};
const VERIFIER_VERSION = 1;

/** Create (or revise) the task graph from a brief. Revision n+1 keeps verified actions, cancels the rest, records the change. */
export function fromBrief(run: any, b: Brief, prev?: Brief | null) {
  const existing = one<any>("select * from agent_tasks where run_id=?", run.id);
  const rev = existing ? existing.revision + 1 : 1;
  const tid = existing?.id ?? id("tsk");
  if (!existing) exec("insert into agent_tasks (id, workspace_id, room_id, run_id, requester_id, revision, original_request, goal, status, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?)",
    tid, run.workspace_id, run.room_id, run.id, run.requested_by ?? null, 1, String(run.objective ?? ""), b.goal, "working", now(), now());
  else {
    exec("update agent_tasks set revision=?, goal=?, updated_at=? where id=?", rev, b.goal, now(), tid);
    exec("update task_actions set status='cancelled' where task_id=? and status in ('not_started','running','waiting_human','waiting_external')", tid);
    exec("insert into task_revisions (task_id, revision, message_event_id, change, created_at) values (?,?,?,?,?)", tid, rev, run.trigger_event_id ?? null, prev ? `plan revised: ${b.goal}` : "revised", now());
  }
  const kept = new Set(all<any>("select target from task_actions where task_id=? and status in ('verified','observed')", tid).map((a) => a.target as string));
  let n = 0;
  for (const p of b.plan) {
    if (!p.tool || kept.has(p.tool)) continue;
    const d = getTool(p.tool), mode = d && WRITE.includes(d.risk) ? "write" : "read";
    n++;
    exec("insert into task_actions (id, task_id, revision, n, kind, mode, target, text, inputs, constraints, depends_on, status, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id("act"), tid, rev, n, p.tool, mode, p.tool, p.text, S(slotsFor(p.tool, b.facts)), S(b.constraints ?? []), S(n > 1 ? [n - 1] : []), p.status === "done" ? "observed" : "not_started", now());
  }
  emit("TASK_GRAPH", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: run.agent_id, data: { task_id: tid, revision: rev, actions: all<any>("select n, target, mode, status from task_actions where task_id=? and revision=? order by n", tid, rev) } });
  return tid;
}
function slotsFor(tool: string, f?: Facts) {
  if (!f) return {};
  if (/^email\./.test(tool)) return { to: f.emails, people: f.people };
  if (/^calendar\./.test(tool)) return { dates: f.dates, people: f.people };
  if (/^(reservations|browser|order|watch)\./.test(tool)) return { dates: f.dates, max_price: f.max_price, people: f.people };
  return {};
}

const openAction = (runId: string, tool: string) =>
  one<any>("select a.* from task_actions a join agent_tasks t on t.id=a.task_id where t.run_id=? and a.target=? and a.status in ('not_started','running','waiting_human','waiting_external') order by a.n limit 1", runId, tool);

/** A tool ran for this task: bind the execution to its action and let the verifier say what it proves. */
export function bind(run: any, tool: string, exec_: { id: string; input: any; result: any; status: string }) {
  let a = openAction(run.id, tool);
  if (!a) { // the model did something the plan didn't list: it still happened, so it is still an action with evidence
    const t = one<any>("select * from agent_tasks where run_id=?", run.id); if (!t || /^(plan\.update|memory\.remember|notes\.add|specialists\.run)$/.test(tool)) return null;
    const d = getTool(tool), n = (one<any>("select max(n) m from task_actions where task_id=? and revision=?", t.id, t.revision)?.m ?? 0) + 1;
    exec("insert into task_actions (id, task_id, revision, n, kind, mode, target, text, inputs, constraints, depends_on, status, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id("act"), t.id, t.revision, n, tool, d && WRITE.includes(d.risk) ? "write" : "read", tool, d?.summarize?.(exec_.input) ?? tool, S({ unplanned: true }), "[]", "[]", "running", now());
    a = openAction(run.id, tool)!;
  }
  const v = (VERIFIERS[tool] ?? ((_i: any, r: any) => (r?.__status === "UNKNOWN" ? { verdict: "uncertain" as const, note: "provider answer unknown" } : { verdict: "observed" as const })))(exec_.input, exec_.result, J(run.brief, null)?.facts);
  const verdict: ActionStatus = exec_.status === "FAILED" ? "blocked" : v.verdict;
  exec("update task_actions set status=?, tool_execution_id=?, updated_at=? where id=?", verdict, exec_.id, now(), a.id);
  exec("insert into action_evidence (id, action_id, run_id, tool_execution_id, type, provider_ref, facts, verdict, note, verifier_version, observed_at) values (?,?,?,?,?,?,?,?,?,?,?)",
    id("evd"), a.id, run.id, exec_.id, exec_.status === "FAILED" ? "tool_failure" : "tool_result", v.provider_ref ?? null, S(v.facts ?? {}), verdict, v.note ?? null, VERIFIER_VERSION, now());
  emit("ACTION_VERDICT", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: run.agent_id, data: { action: a.target, n: a.n, verdict, provider_ref: v.provider_ref ?? null, note: v.note ?? null } });
  return verdict;
}
/** An approval card is up for this action. */
export function waitingHuman(run: any, tool: string, approvalId: string) {
  const a = openAction(run.id, tool); if (!a) return;
  exec("update task_actions set status='waiting_human', approval_id=?, updated_at=? where id=?", approvalId, now(), a.id);
  settle(run);
}
/** The run is waiting on someone outside (a reply, a day). */
export function waitingExternal(runId: string, tool: string) {
  const a = openAction(runId, tool); if (!a) return;
  exec("update task_actions set status='waiting_external', updated_at=? where id=?", now(), a.id);
}

export function actions(runId: string) {
  return all<any>("select a.* from task_actions a join agent_tasks t on t.id=a.task_id where t.run_id=? and a.revision=t.revision order by a.n", runId)
    .map((a) => ({ ...a, inputs: J(a.inputs, {}), depends_on: J(a.depends_on, []), evidence: all<any>("select type, provider_ref, facts, verdict, note, observed_at from action_evidence where action_id=? order by observed_at", a.id).map((e) => ({ ...e, facts: J(e.facts, {}) })) }));
}
/** The task's state from its actions: the parent is verified only when every write is verified and nothing is open. */
export function settle(run: any, terminal = false): TaskStatus | null {
  const t = one<any>("select * from agent_tasks where run_id=?", run.id); if (!t) return null;
  const acts = actions(run.id);
  const st = (s: ActionStatus) => acts.filter((a) => a.status === s);
  let status: TaskStatus;
  if (st("waiting_human").length) status = "waiting_human";
  else if (st("waiting_external").length) status = "waiting_external";
  else if (st("blocked").length) status = "blocked";
  else if (acts.some((a) => a.mode === "write" && a.status === "uncertain")) status = "uncertain";
  else if (!terminal && (st("not_started").length || st("running").length)) status = "working";
  // A write counts when verified; a draft (an internal write whose verifier can only observe) counts when observed.
  else if (acts.some((a) => a.mode === "write")) status = acts.filter((a) => a.mode === "write" && a.status !== "cancelled").every((a) => a.status === "verified" || (a.status === "observed" && /\.draft$/.test(a.target))) ? "verified" : "uncertain";
  else status = acts.every((a) => ["observed", "verified", "cancelled"].includes(a.status)) ? "done" : "uncertain";
  exec("update agent_tasks set status=?, updated_at=? where id=?", status, now(), t.id);
  if (terminal) emit("TASK_TERMINAL", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: run.agent_id, data: { task_id: t.id, status, actions: acts.map((a) => ({ n: a.n, target: a.target, status: a.status })) } });
  return status;
}
/** What the person should be told about where things stand, in six words or so. */
export function stateLine(runId: string): string | null {
  const t = one<any>("select * from agent_tasks where run_id=?", runId); if (!t) return null;
  const acts = actions(runId);
  const open = acts.find((a) => ["waiting_human", "waiting_external", "uncertain", "blocked"].includes(a.status));
  switch (t.status as TaskStatus) {
    case "verified": return "done — verified";
    case "done": return "done";
    case "waiting_human": return `waiting for your OK${open ? ` (${open.text})` : ""}`;
    case "waiting_external": return `waiting on someone else${open ? ` (${open.text})` : ""}`;
    case "uncertain": return `uncertain — I can't confirm ${open?.text ?? "one step"} went through`;
    case "blocked": return `blocked at: ${open?.text ?? "one step"}`;
    case "cancelled": return "cancelled";
    default: return "working";
  }
}
/** Write actions whose outcome we cannot confirm: the reply must not say they happened. */
export const uncertainWrites = (runId: string) => actions(runId).filter((a) => a.mode === "write" && a.status === "uncertain");
export const view = (runId: string) => { const t = one<any>("select * from agent_tasks where run_id=?", runId); return t && { ...t, state: stateLine(runId), actions: actions(runId), revisions: all<any>("select * from task_revisions where task_id=? order by revision", t.id) }; };
