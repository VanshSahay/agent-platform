// Job contracts: what a deployable job needs, and what proves it was done. The model interprets and writes; these decide
// whether the job can start (connection present) and whether the run may claim it finished (evidence in our own records).
import { all, one, J, emit } from "./db";
import { agentTools } from "./templates";

export type JobKind = "calendar" | "reminder" | "email";
interface Contract {
  match: RegExp;                       // how the request reads
  tools: string[];                     // the agent must have at least one of these
  needs?: "google";                    // connection the job can't run without
  label: string;                       // for messages: "check your calendar"
  done: string[];                      // a SUCCEEDED call to one of these is evidence
  pendingApproval?: string[];          // ...or an approval waiting for one of these
}
export const CONTRACTS: Record<JobKind, Contract> = {
  reminder: { match: /\b(remind(er|ers)?|nudge me|ping me|alarm|don'?t let me forget)\b/i, tools: ["reminder.schedule"], label: "set that reminder",
    done: ["reminder.schedule", "reminder.update", "reminder.cancel", "reminder.list"] },
  email: { match: /\b(e-?mails?|inbox|reply to .+@|draft (a|an|the)?\s*(note|message|reply)|send .+@)\b/i, tools: ["email.send", "email.draft", "email.search"], needs: "google", label: "handle that email",
    done: ["email.send", "email.draft", "email.search"], pendingApproval: ["email.send"] },
  calendar: { match: /\b(calendar|my (agenda|schedule)|my (day|week|morning|afternoon) (look|looking)|am i (free|busy)|free (time|slots?)|when am i free|(my|any) meetings? (today|tomorrow|this week)|what'?s on my (calendar|schedule|plate) (today|tomorrow|this week))\b/i,
    tools: ["calendar.list_events", "calendar.find_free_time"], needs: "google", label: "check your calendar", done: ["calendar.list_events", "calendar.find_free_time", "calendar.create_event"], pendingApproval: ["calendar.create_event"] },
};

/** Which contracted job a request is (reminders first: "remind me about my meeting" is a reminder, not a calendar read). */
export function detectJob(text: string): JobKind | null {
  for (const k of ["reminder", "email", "calendar"] as JobKind[]) if (CONTRACTS[k].match.test(text)) return k;
  return null;
}

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

/** After the model says it's done: is there evidence the job happened? (A question back or a pending approval also counts.) */
export function outcome(run: any, reply: string): { job: JobKind | null; ok: boolean; evidence: string } {
  const job = detectJob(String(run.objective ?? ""));
  if (!job) return { job: null, ok: true, evidence: "" };
  const c = CONTRACTS[job];
  const succeeded = all<any>("select data from events where run_id=? and type='TOOL_CALL_COMPLETED'", run.id).map((e) => J(e.data, {}))
    .filter((d) => d.status === "SUCCEEDED" && c.done.includes(d.tool)).map((d) => d.tool);
  if (succeeded.length) return { job, ok: true, evidence: `${succeeded[0]} succeeded` };
  if (c.pendingApproval?.length && one(`select 1 from approvals where run_id=? and status='pending' and tool_id in (${c.pendingApproval.map(() => "?").join(",")})`, run.id, ...c.pendingApproval))
    return { job, ok: true, evidence: "waiting for approval" };
  if (/\?\s*$/.test(reply.trim()) || one("select 1 from waits where run_id=? and status='open'", run.id)) return { job, ok: true, evidence: "asked the person / waiting" };
  const failed = all<any>("select data from events where run_id=? and type in ('TOOL_CALL_COMPLETED','TOOL_CALL_FAILED')", run.id).map((e) => J(e.data, {})).find((d) => c.done.includes(d.tool));
  return { job, ok: false, evidence: failed ? `${failed.tool} ${failed.status ?? "failed"}${failed.error ? `: ${failed.error}` : ""}` : `no ${c.done[0]} call` };
}
export const recordOutcome = (run: any, o: ReturnType<typeof outcome>) =>
  o.job && emit("JOB_OUTCOME", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: run.agent_id, data: { job: o.job, ok: o.ok, evidence: o.evidence } });
