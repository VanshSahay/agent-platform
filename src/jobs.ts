// Job contracts: what a deployable job needs, and what proves it was done. The model interprets and writes; these decide
// whether the job can start (connection present) and whether the run may claim it finished (evidence in our own records).
import { all, one, J, emit } from "./db";
import { agentTools } from "./templates";

export type JobKind = "calendar" | "reminder" | "email" | "expense" | "list" | "poll";
interface Contract {
  match: RegExp;                       // how the request reads
  tools: string[];                     // the agent must have at least one of these
  needs?: "google";                    // connection the job can't run without
  label: string;                       // for messages: "check your calendar"
  done: string[];                      // a SUCCEEDED call to one of these proves a change was made
  read: string[];                      // ...and one of these proves a look-up (only when the request was a question)
  pendingApproval?: string[];          // ...or an approval waiting for one of these
}
export const CONTRACTS: Record<JobKind, Contract> = {
  reminder: { match: /\b(remind(er|ers)?|nudge me|ping me|alarm|don'?t let me forget)\b/i, tools: ["reminder.schedule"], label: "set that reminder",
    done: ["reminder.schedule", "reminder.update", "reminder.cancel"], read: ["reminder.list"] },
  email: { match: /\b(e-?mails?|inbox|reply to .+@|draft (a|an|the)?\s*(note|message|reply)|send .+@)\b/i, tools: ["email.send", "email.draft", "email.search"], needs: "google", label: "handle that email",
    done: ["email.send", "email.draft"], read: ["email.search"], pendingApproval: ["email.send"] },
  calendar: { match: /\b(calendar|my (agenda|schedule)|my (day|week|morning|afternoon) (look|looking)|am i (free|busy)|free (time|slots?)|when am i free|(my|any) meetings? (today|tomorrow|this week)|what'?s on my (calendar|schedule|plate) (today|tomorrow|this week)|(schedule|book|set up) (a|an) (meeting|call))\b/i,
    tools: ["calendar.list_events", "calendar.find_free_time"], needs: "google", label: "check your calendar",
    done: ["calendar.create_event", "calendar.cancel_event"], read: ["calendar.list_events", "calendar.find_free_time"], pendingApproval: ["calendar.create_event", "calendar.cancel_event"] },
  // Group jobs: the outcome is the shared record itself (the ledger, the list, the poll).
  expense: { match: /\b(i paid|(he|she|they|\w+) paid|split (it|this|the)|split with|who owes|owes? (me|you|us)|settle(d)? up|balances?)\b/i, tools: ["expense.add"], label: "record that expense",
    done: ["expense.add", "expense.settle"], read: ["expense.balances"] },
  list: { match: /\b((add|put) .+ (to|on) (the|our|my) (\w+ )?list|(shopping|grocery|packing|to-?do) list|(check|cross) .+ off|what'?s on (the|our|my) (\w+ )?list|clear the list)\b/i, tools: ["list.add"], label: "update the list",
    done: ["list.add", "list.check", "list.clear"], read: ["list.show"] },
  poll: { match: /\b(poll|take a vote|let'?s vote|close the vote)\b/i, tools: ["poll.create"], label: "run that poll",
    done: ["poll.create", "poll.vote", "poll.close"], read: ["poll.results"] },
};

// Per job: does the request ask for a change, or only a look-up ("what's on tomorrow?", "any emails from Sam?", "what reminders
// do I have?")? A look-up is proven by a read; a change only by the change (or its pending approval).
// ponytail: wording heuristic; a model-written brief could tag each action instead if this misreads real requests.
const WRITE: Record<JobKind, RegExp> = {
  reminder: /\b(remind me|nudge me|ping me|set|cancel|delete|remove|stop|move|change|update|make (it|the))\b|don'?t let me forget/i,
  email: /\b(send|reply|draft|write (to|an?)|forward|e-?mail (him|her|them|\S+@|\w+ (that|about|to)))\b/i,
  calendar: /\b(schedule|book|set up|add|put|cancel|move|reschedule|decline)\b/i,
  expense: /\b(paid|split|settle|spent)\b/i,
  list: /\b(add|put|check|cross|clear|remove)\b/i,
  poll: /\b(make|create|start|run|set up|take|close|let'?s vote)\b/i,
};
export const wantsRead = (job: JobKind, text: string) => !WRITE[job].test(text);

/** Every contracted job a request contains ("check my calendar and remind me at 5" = calendar + reminder).
 *  "Remind me about my meeting" is a reminder only: calendar counts alongside a reminder only when the calendar is named. */
export function detectJobs(text: string): JobKind[] {
  const kinds = (Object.keys(CONTRACTS) as JobKind[]).filter((k) => CONTRACTS[k].match.test(text));
  return kinds.includes("reminder") && !/\b(calendar|am i (free|busy)|free (time|slots?))\b/i.test(text) ? kinds.filter((k) => k !== "calendar") : kinds;
}
export const detectJob = (text: string): JobKind | null => detectJobs(text)[0] ?? null;

/** Before work starts: if the job needs a connection this agent doesn't have, the honest answer is known now. */
export function missingConnection(agent: any, text: string, room?: any): { job: JobKind; message: string } | null {
  if (room?.mode === "test") return null; // test chats use sample data for unconnected accounts
  const job = detectJob(text);
  const c = job && CONTRACTS[job];
  if (!c?.needs) return null;
  const tools = agentTools(agent);
  if (!c.tools.some((t) => tools.has(t))) return null; // not this agent's job; its normal reply applies
  const connected = one("select 1 from connections c join connection_grants g on g.connection_id=c.id where g.agent_id=? and c.provider=? and c.status='active'", agent.id, c.needs);
  if (connected) return null;
  const expired = one("select 1 from connections c join connection_grants g on g.connection_id=c.id where g.agent_id=? and c.provider=? and c.status='needs_reauth'", agent.id, c.needs);
  const url = `${(process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "")}/#/connections`;
  return { job: job!, message: expired
    ? `I can't ${c.label} right now — your Google access expired. Reconnect it here and ask me again: ${url}`
    : `To ${c.label} I need access to your Google account (Gmail + Calendar). Connect it here — it takes a minute — then ask me again: ${url}` };
}

export type Status = "done" | "waiting" | "asked" | "failed";
export interface Outcome { job: JobKind | null; jobs?: { job: JobKind; status: Status; evidence: string; read?: boolean }[]; ok: boolean; status?: Status; evidence: string }

/** After the model says it's done: is there evidence for EACH requested job in our own records?
 *  done = the right tool succeeded · waiting = an approval for it is pending, or the run is waiting · asked = the reply is a
 *  question back (not done, not a failure; the answer's run inherits the job) · failed = none of these. */
export function outcome(run: any, reply: string): Outcome {
  const text = String(run.objective ?? "");
  let asks = detectJobs(text).map((job) => ({ job, read: wantsRead(job, text) }));
  if (!asks.length) { // the answer to our question ("6pm") carries the job it answered
    // ponytail: only the very last outcome in the room; a "thanks" right after a question also inherits it (sent back once).
    const prev = one<any>("select data from events where room_id=? and type='JOB_OUTCOME' order by seq desc limit 1", run.room_id);
    const d = J(prev?.data, {});
    if (d.status === "asked" && d.requested_by === run.requested_by) asks = (d.jobs ?? []).map((j: any) => ({ job: j.job, read: !!j.read }));
  }
  // Only jobs this agent is built for: a request outside its tools gets its normal reply, not a contract.
  const has = agentTools(one<any>("select * from agents where id=?", run.agent_id));
  asks = asks.filter((a) => [...CONTRACTS[a.job].done, ...CONTRACTS[a.job].read].some((t) => has.has(t)));
  const kinds = asks.map((a) => a.job);
  if (!kinds.length) return { job: null, ok: true, evidence: "" };
  const calls = all<any>("select data from events where run_id=? and type in ('TOOL_CALL_COMPLETED','TOOL_CALL_FAILED')", run.id).map((e) => J(e.data, {}));
  const waiting = !!one("select 1 from waits where run_id=? and status='open'", run.id);
  const asked = /\?\s*$/.test(reply.trim());
  const per = asks.map(({ job, read }) => {
    const c = CONTRACTS[job], ok = read ? [...c.done, ...c.read] : c.done;
    const hit = calls.find((d) => d.status === "SUCCEEDED" && ok.includes(d.tool));
    if (hit) return { job, status: "done" as Status, evidence: `${hit.tool} succeeded`, read };
    if (c.pendingApproval?.length && one(`select 1 from approvals where run_id=? and status='pending' and tool_id in (${c.pendingApproval.map(() => "?").join(",")})`, run.id, ...c.pendingApproval))
      return { job, status: "waiting" as Status, evidence: "waiting for approval", read };
    if (waiting) return { job, status: "waiting" as Status, evidence: "waiting on the person", read };
    if (asked) return { job, status: "asked" as Status, evidence: "asked the person a question", read };
    const failed = calls.find((d) => [...c.done, ...c.read].includes(d.tool));
    return { job, status: "failed" as Status, evidence: failed ? `${failed.tool} ${failed.status ?? "failed"}${failed.error ? `: ${failed.error}` : ""}` : `no ${(read ? c.read : c.done)[0]} call`, read };
  });
  const rank: Status[] = ["failed", "asked", "waiting", "done"];
  const status = rank.find((st) => per.some((p) => p.status === st))!;
  const evidence = per.length === 1 ? per[0].evidence : per.map((p) => `${p.job}: ${p.evidence}`).join("; ");
  return { job: per[0].job, jobs: per, ok: status === "done" || status === "waiting", status, evidence };
}
export const recordOutcome = (run: any, o: Outcome) =>
  o.job && emit("JOB_OUTCOME", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: run.agent_id,
    data: { job: o.job, ok: o.ok, status: o.status ?? (o.ok ? "done" : "failed"), evidence: o.evidence, jobs: o.jobs, requested_by: run.requested_by } });
