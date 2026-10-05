// Requirement layer: brief -> (clarify | confirm | auto) -> execute against the brief -> verify before "done".
// The model drafts the brief; whether to stop and ask is decided deterministically here, never by the model.
import { one, all, exec, emit, now, S, J, patchJson, clockLine, tzOf } from "./db";
import { clampEffort, assessDepth, type Depth } from "./depth";
import { structured, plan as heuristicPlan } from "./model";
import { TOOLS, getTool } from "./tools";
import { agentTools, SKILLS } from "./templates";
import { retrieve } from "./memory";
import * as rt from "./runtime";

export interface PlanStep { text: string; tool?: string; status: "todo" | "done" | "skipped" }
export interface Brief {
  version: number; goal: string; deliverable: string; constraints: string[]; assumptions: string[];
  questions: { q: string; default?: string }[]; side_effects: string[]; done_when: string[]; plan: PlanStep[];
  kind: "answer" | "act" | "task" | "schedule";
  // Planning layer: how much work this is, which model tier runs it, how many tool calls it deserves, and what to say right away.
  effort?: Effort; tool_budget?: number; profile?: string; ack?: string;
}
export type Effort = "quick" | "standard" | "deep";
const BUDGET: Record<Effort, [number, number]> = { quick: [1, 3], standard: [5, 10], deep: [8, 16] }; // [min, max] tool calls
const DEEP = /\b(research|compare|comparison|analy[sz]e|itinerary|plan (a|an|our|my|the) (trip|vacation|holiday|wedding|party|event)|deep dive|options for|best .* (for|in)|pros and cons)\b/i;
/** The agent's depth: decided when it was designed (spec), or — catalog/older agents — from its job and abilities. */
export function depthOf(agent: any): Depth {
  const saved = J(agent?.spec, null)?.depth;
  if (saved) return saved;
  const skills: string[] = J(agent?.skills, []);
  return assessDepth([String(agent?.job ?? ""), ...skills.map((k) => SKILLS[k]?.name ?? k)]);
}
/** When the planner didn't write one: never leave the chat silent while real work runs. */
export const defaultAck = (b: Pick<Brief, "effort">) => b.effort === "deep" ? "On it — this needs some digging. I'll send what I find in a couple of minutes." : "On it — back in a minute.";
/** Deterministic part of the plan: effort, tool budget and model tier from the drafted brief (the model's guess is a hint, clamped). */
export function planWork(b: Omit<Brief, "version">, objective: string, depth?: Depth | null): Pick<Brief, "effort" | "tool_budget" | "profile"> {
  const toolSteps = b.plan.filter((p) => p.tool).length;
  let effort: Effort = (["quick", "standard", "deep"] as Effort[]).includes(b.effort as Effort) ? b.effort! : b.kind === "answer" && !toolSteps ? "quick" : "standard";
  if (DEEP.test(objective) || toolSteps >= 4) effort = "deep";
  if (effort === "quick" && toolSteps > 1) effort = "standard";
  effort = clampEffort(effort, depth); // the agent's depth, decided before deploy, caps every request
  const [lo, hi0] = BUDGET[effort];
  const hi = depth ? (effort === "deep" && depth.level === "deep" ? depth.max_tool_calls : Math.min(hi0, depth.max_tool_calls)) : hi0;
  const tool_budget = Math.max(Math.min(lo, hi), Math.min(hi, Number(b.tool_budget) || (effort === "deep" ? 12 : effort === "standard" ? 6 : 2)));
  // The cheap model only answers; anything that may call tools runs on standard (a live test showed the cheap model narrating
  // "I'll book it" instead of calling the tool). Deep work gets the research tier. Failures escalate further at run time.
  const profile = effort === "quick" && !toolSteps && !b.side_effects.length ? "fast" : effort === "deep" ? (depth?.models.deep ?? "research-standard") : "standard";
  return { effort, tool_budget, profile };
}
export type Decision = "skip" | "auto" | "clarify" | "confirm";

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const WRITE_RISKS = ["write_external", "destructive", "financial"];
const STEP_TEXT: Record<string, (i: any) => string> = {
  "web.search": (i) => `Search the web for "${String(i.query).slice(0, 60)}"`, "web.fetch": (i) => `Read ${i.url}`,
  "email.search": () => "Check the inbox", "email.draft": (i) => `Draft an email to ${i.to?.join(", ")}`, "email.send": (i) => `Send an email to ${i.to?.join(", ")} (after your approval)`,
  "calendar.list_events": () => "Check the calendar", "calendar.find_free_time": () => "Find free time on the calendar", "calendar.create_event": (i) => `Add "${i.title}" to the calendar (after your approval)`,
  "reminder.schedule": (i) => `Schedule a reminder: ${i.text}`, "task.create": (i) => `Track "${i.title}"${i.agent_action === "blocked" ? " as yours (I won't act on it)" : ""}`,
  "memory.remember": (i) => `Remember: ${i.text}`, "agent.delegate": (i) => `Ask ${i.agent} to ${i.objective}`, "contacts.search": (i) => `Look up ${i.query} in contacts`,
  "drive.search": (i) => `Find "${i.query}" in Drive`, "browser.task": (i) => `Use the browser: ${i.task}`, "wait.for_reply": (i) => `Wait for ${i.from_email ?? "a reply"}`,
};
const DONE_TEXT: Record<string, (i: any) => string> = {
  "email.send": (i) => `Email to ${i.to?.join(", ")} sent`, "email.draft": () => "Draft ready for review", "reminder.schedule": () => "Reminder scheduled",
  "calendar.create_event": (i) => `"${i.title}" is on the calendar`, "task.create": (i) => `"${i.title}" tracked with an owner`, "web.search": () => "Answer backed by linked sources",
  "agent.delegate": (i) => `${i.agent} reported back`, "calendar.list_events": () => "Calendar summarized", "calendar.find_free_time": () => "Free slots listed",
};

/** Offline brief: deterministic, used without model keys and as the schema-complete fallback for model output. */
export function heuristicBrief(objective: string, c: { tools: string[]; agents: string[]; speaker?: string; agentName: string; memories: string[]; roomId?: string }): Omit<Brief, "version"> {
  const text = objective.replace(/^@?\w+[,:]\s+/, "");
  const steps = heuristicPlan(objective, c);
  const t = text.toLowerCase();
  const constraints = [
    ...(text.match(/(?:under|below|less than|at most|up to|max(?:imum)?|budget(?: of)?)\s*\$\s?\d[\d,.]*(?:\s*\/\s*\w+)?/gi) ?? []),
    ...(text.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:\s*[-–]\s*\d{1,2})?/gi) ?? []),
    ...(text.match(/\b(?:today|tonight|tomorrow|this week|next week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi) ?? []),
    ...(text.match(/\b(?:don'?t|do not|never|without)\b[^.,;!?]+/gi) ?? []).map((s) => s.trim()),
  ].map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  const words = new Set(t.match(/[a-z]{4,}/g) ?? []);
  const assumptions = c.memories.filter((m) => (m.toLowerCase().match(/[a-z]{4,}/g) ?? []).some((w) => words.has(w))).slice(0, 3).map((m) => `From memory: ${m}`);
  const questions: Brief["questions"] = [];
  const named = text.match(/\b(?:[Ee]-?mail|[Mm]essage|[Ww]rite to|[Ss]end (?:an? )?(?:email|note) to)\s+([A-Z][a-z]+)\b/);
  if (named && !/[\w.+-]+@[\w-]+\.[\w.]+/.test(text) && !c.tools.includes("contacts.search")
      && !c.memories.some((m) => m.toLowerCase().includes(named[1].toLowerCase()) && /@/.test(m)))
    questions.push({ q: `What's ${named[1]}'s email address?` });
  const count = t.match(/\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(options|choices|ideas|candidates|hotels|flights|restaurants|results|places)\b/);
  const done_when = [...new Set([
    ...(count ? [`${NUM[count[1]] ?? count[1]} ${count[2]} with links and trade-offs`] : []),
    ...steps.filter((s) => DONE_TEXT[s.name] && !(count && s.name === "web.search")).map((s) => DONE_TEXT[s.name](s.input)),
  ])];
  const plan: PlanStep[] = steps.map((s) => ({ text: STEP_TEXT[s.name]?.(s.input) ?? s.name, tool: s.name, status: "todo" }));
  const names = steps.map((s) => s.name);
  const kind = !steps.length ? "answer" : names.includes("wait.for_reply") || names.includes("agent.delegate") || steps.length >= 3 ? "task"
    : names.includes("reminder.schedule") ? "schedule" : "act";
  return {
    goal: text.split("\n")[0].split(/(?<=[.!?])\s/)[0].slice(0, 200), deliverable: done_when[0] ?? (kind === "answer" ? "A reply" : "The requested change"),
    constraints, assumptions, questions, done_when, plan, kind,
    side_effects: steps.filter((s) => { const d = getTool(s.name); return d && WRITE_RISKS.includes(d.riskOf?.(s.input) ?? d.risk); }).map((s) => getTool(s.name)!.summarize?.(s.input) ?? s.name),
  };
}

const BRIEF_INSTRUCTION = `You turn a request to an AI agent into a task brief before any work starts. Return JSON:
{"goal": one sentence, "deliverable": what the person gets, "constraints": [hard requirements incl. budgets, dates, people, "don't ..." rules],
 "assumptions": [gaps you will fill with stated defaults or remembered preferences], "questions": [{"q": question, "default": suggested answer or null}] — ONLY questions whose answer would change the outcome and that can't be safely assumed; usually none,
 "side_effects": [each action that reaches outside the platform: sending, booking, creating events, paying],
 "effort": "quick" (answer from what you know or one lookup) | "standard" (a few tool calls) | "deep" (research, comparisons, multi-step plans),
 "tool_budget": how many tool calls a careful person would need (quick 1-2, standard 3-6, deep 8-14),
 "ack": for standard/deep work, ONE short chat line sent immediately, in the agent's voice, saying what you're doing and any key assumption (e.g. "On it — looking at Lisbon hotels for Oct 10–12, I'll send 3 options in a minute."); "" for quick answers,
 "done_when": [2-4 checkable success criteria], "plan": [{"text": step in plain words the person would use — never tool names or ids, "tool": tool id or null}] (1-7 steps, using only the listed tools),
 "kind": "answer" (just reply) | "act" (a few tool actions) | "task" (multi-step, waits on people or days) | "schedule" (reminders/recurring)}`;

export async function buildBrief(run: any, agent: any, room: any, prev?: Brief): Promise<Brief> {
  // Tools whose connection isn't available can't be planned on (e.g. no contacts lookup without Google).
  const connected = new Set(all<any>("select c.provider from connections c join connection_grants g on g.connection_id=c.id where g.agent_id=? and c.status='active'", agent.id).map((r) => r.provider));
  const perms = J(agent.permissions, {});
  const tools = [...agentTools(agent)].filter((t) => perms[t] !== "never" && (!getTool(t)?.requiresConnection || getTool(t)!.connectionId || connected.has(getTool(t)!.requiresConnection!)));
  const memories = retrieve(room, agent.id, run.objective, run.requested_by, 6).map((m) => m.text);
  const ctx = { tools, agents: all<any>("select name from agents where workspace_id=? and status='active'", agent.workspace_id).map((a) => a.name),
    speaker: rt.nameOf(run.requested_by), agentName: agent.name, memories, roomId: room.id };
  const transcript = all<any>("select actor, data from events where room_id=? and type='message' order by seq desc limit 8", room.id).reverse()
    .map((e) => `[${rt.nameOf(e.actor)}] ${J(e.data).text}`).join("\n");
  const input = `${clockLine(undefined, tzOf(run.requested_by))}\nAgent: ${agent.name} — ${agent.job}\nTools: ${tools.filter((x) => getTool(x)).map((x) => `${x} (${getTool(x)!.risk})`).join(", ")}
Known about these people: ${memories.join(" | ") || "nothing"}\nRecent conversation:\n${transcript}\n${prev ? `Previous brief: ${S(prev)}\n` : ""}Request from ${ctx.speaker}: ${run.objective}`;
  // Short small talk with nothing actionable ("thanks!", "ok cool") doesn't need a model-drafted brief.
  const quick = heuristicBrief(run.objective, ctx);
  const smallTalk = !prev && quick.kind === "answer" && !quick.questions.length && run.objective.trim().split(/\s+/).length <= 4 && !run.objective.includes("?");
  const b = smallTalk ? quick : await structured<any>(String(run.objective ?? "").length < 160 ? "fast" : "standard", BRIEF_INSTRUCTION, input, () => quick, run.workspace_id); // short asks don't need the bigger model to brief
  const arr = (x: any) => (Array.isArray(x) ? x : []);
  // The model's own "side effects" list over-counts (it calls a to-do or a reminder a side effect). What needs a sign-off is
  // decided by the tools in the plan: only external writes (send, book, create events, pay) count.
  b.side_effects = sideEffects(arr(b.plan).map((p: any) => p?.tool).filter(Boolean), arr(b.side_effects));
  // Don't ask what a tool can look up: with contacts available, "what's Sam's email/number?" becomes a lookup step.
  if (tools.includes("contacts.search")) {
    const lookups = arr(b.questions).filter((q: any) => /\b(e-?mail|address|phone|number|contact)\b/i.test(String(q?.q ?? q)));
    if (lookups.length) {
      b.questions = arr(b.questions).filter((q: any) => !lookups.includes(q));
      if (!arr(b.plan).some((p: any) => p?.tool === "contacts.search")) b.plan = [{ text: "Look up the person in your contacts", tool: "contacts.search" }, ...arr(b.plan)];
    }
  }
  const draft = {
    version: (prev?.version ?? 0) + 1, goal: String(b.goal ?? run.objective), deliverable: String(b.deliverable ?? ""),
    constraints: arr(b.constraints).map(String), assumptions: arr(b.assumptions).map(String), side_effects: arr(b.side_effects).map(String),
    done_when: arr(b.done_when).map(String), kind: ["answer", "act", "task", "schedule"].includes(b.kind) ? b.kind : "act",
    questions: arr(b.questions).map((q: any) => (typeof q === "string" ? { q } : { q: String(q.q), default: q.default ?? undefined })).filter((q: any) => q.q),
    plan: arr(b.plan).map((p: any) => (typeof p === "string" ? { text: p, status: "todo" } : { text: String(p.text), tool: p.tool ?? undefined, status: "todo" })),
    effort: b.effort, tool_budget: b.tool_budget, ack: typeof b.ack === "string" ? b.ack.trim().slice(0, 240) : undefined,
  };
  return { ...draft, ...planWork(draft as Brief, String(run.objective ?? ""), depthOf(agent)) } as Brief;
}

/** Planned tools decide what counts as a side effect: none of them writes outside the platform → nothing to sign off. */
export function sideEffects(planTools: string[], claimed: any[]) {
  return planTools.length && !planTools.some((t) => WRITE_RISKS.includes(getTool(t)?.risk ?? "")) ? [] : claimed;
}

/** Deterministic confirmation policy. */
export function decide(b: Brief, o: { mode: string; revised: boolean }): Decision {
  if (b.questions.length && o.mode !== "never") return "clarify";
  if (b.kind === "answer" && !b.side_effects.length) return "skip";
  if (o.mode === "always") return "confirm";
  if (o.mode === "never") return "auto";
  if (o.revised && b.side_effects.length) return "confirm"; // requirement changed mid-flight: re-confirm before acting
  // A single external write is already gated by its own approval card (which shows the exact action); don't ask twice.
  // Multi-step work that reaches outside (external writes, other agents, waiting on people) shows the plan first;
  // internal-only work (to-dos, reminders, lists, notes) just happens.
  const involvesOthers = b.plan.some((p) => p.tool === "agent.delegate" || p.tool === "wait.for_reply");
  if (b.side_effects.length >= 2 || (b.kind === "task" && (b.side_effects.length || involvesOthers))) return "confirm";
  return "auto";
}

export function renderBrief(b: Brief, d: Decision, diff?: string[]) {
  const L = (label: string, xs: string[]) => (xs.length ? `\n${label}: ${xs.join("; ")}` : "");
  if (d === "clarify")
    return `Before I start — ${b.goal}\n${b.questions.map((q, i) => `${i + 1}. ${q.q}${q.default ? ` (default: ${q.default})` : ""}`).join("\n")}\n` +
      (b.questions.every((q) => q.default) ? `Reply with answers, or "go" to use the defaults.` : "Reply with the answers.");
  // Reads like a text from a person: what I'll do, what I'm assuming, what I'll check with you first. The full brief
  // (deliverable, constraints, done-when) still drives the run and shows in the app's run view.
  return `${diff?.length ? `Updated plan (${diff.join("; ")}).\n` : ""}${b.goal}` +
    (b.plan.length ? `\nPlan:\n${b.plan.map((p, i) => `${i + 1}. ${p.text}`).join("\n")}` : "") +
    L("Assuming", b.assumptions) + L("I'll check with you before", b.side_effects) + `\nReply "go" to start, or tell me what to change.`;
}

function diffBriefs(a: Brief | null, b: Brief) {
  if (!a) return [];
  const out: string[] = [];
  for (const k of ["constraints", "side_effects"] as const) {
    const added = b[k].filter((x) => !a[k].includes(x)), removed = a[k].filter((x) => !b[k].includes(x));
    if (added.length) out.push(`+ ${added.join(", ")}`);
    if (removed.length) out.push(`− ${removed.join(", ")}`);
  }
  if (a.goal !== b.goal) out.push(`goal: ${b.goal}`);
  return out;
}

const saveBrief = (runId: string, b: Brief, status: string) => exec("update runs set brief=?, brief_status=? where id=?", S(b), status, runId);

/** Runs at the start of stepRun while brief_status='pending'. Returns 'wait' if the run must stop for the human. */
export async function intake(run: any, agent: any, room: any, live: () => boolean = () => true): Promise<"continue" | "wait"> {
  const prev: Brief | null = J(run.brief);
  const b = await buildBrief(run, agent, room, prev ?? undefined);
  if (!live()) return "wait"; // superseded while drafting
  // Answering a clarifying question isn't a change; changing a plan that was proposed or already running is.
  const d = decide(b, { mode: agent.confirm_mode ?? "smart", revised: ["proposed", "auto", "confirmed"].includes((prev as any)?._revisedFrom) });
  const diff = (prev as any)?._revisedFrom === "clarifying" ? [] : diffBriefs(prev, b);
  emit("BRIEF_PROPOSED", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: agent.id, data: { brief: b, decision: d, diff } });
  if (d === "skip" || d === "auto") {
    saveBrief(run.id, b, d === "skip" ? "skipped" : "auto");
    // Anything beyond a quick answer gets a reply right away, so nobody stares at silence while the agent works.
    if (d === "auto" && b.effort !== "quick") rt.postMessage(room.id, { sender: agent.id, runId: run.id, text: b.ack || defaultAck(b), targets: rt.replyTargets(room.id, run.origin_endpoint_id) });
    return "continue";
  }
  saveBrief(run.id, b, d === "clarify" ? "clarifying" : "proposed");
  const buttons = d === "confirm" ? [{ label: "Go", data: `brf:${run.id}:go` }, { label: "Cancel", data: `brf:${run.id}:cancel` }]
    : b.questions.every((q) => q.default) ? [{ label: "Use defaults", data: `brf:${run.id}:go` }] : [];
  rt.postMessage(room.id, { sender: agent.id, runId: run.id, text: renderBrief(b, d, diff), buttons, brief: { run_id: run.id, decision: d, brief: b },
    targets: rt.replyTargets(room.id, run.origin_endpoint_id) });
  rt.createWait(run, { kind: d === "clarify" ? "clarify" : "confirm", reason: d === "clarify" ? "waiting for answers" : "waiting for you to confirm the plan",
    owner: run.requested_by ?? undefined, wake_key: `brief:${run.id}`, timeout_at: now() + 72 * 36e5 });
  return "wait";
}

function briefWait(runId: string) { return one<any>("select * from waits where run_id=? and status='open' and kind in ('clarify','confirm')", runId); }
const canDecide = (run: any, userId: string) => !run.requested_by || run.requested_by === userId;

export function confirmBrief(runId: string, userId: string, endpointId?: string | null) {
  const run = one<any>("select * from runs where id=?", runId);
  const w = run && briefWait(runId);
  if (!w) return { error: "nothing to confirm" };
  if (!canDecide(run, userId)) return { error: `only ${rt.nameOf(run.requested_by)} can confirm this` };
  const b: Brief = J(run.brief);
  exec("update runs set brief_status='confirmed' where id=?", runId);
  if (endpointId !== undefined) exec("update runs set origin_endpoint_id=? where id=?", endpointId ?? "web", runId);
  emit("BRIEF_CONFIRMED", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: runId, actor: userId, data: { version: b.version, defaults_used: w.kind === "clarify" } });
  rt.resumeWait(w.id, w.kind === "clarify" ? `${rt.nameOf(userId)} said to go ahead with the default answers: ${b.questions.map((q) => `${q.q} → ${q.default ?? "your best judgment"}`).join("; ")}` : undefined);
  return { ok: true };
}

/** A follow-up that changes the requirement: fold it into the objective, drop stale approvals, rebuild the brief. */
export function reviseBrief(runId: string, userId: string, text: string, endpointId?: string | null) {
  const run = one<any>("select * from runs where id=?", runId);
  if (!run || ["completed", "failed_terminal", "cancelled"].includes(run.status)) return { error: "that task is finished" };
  if (!canDecide(run, userId)) return { error: `only ${rt.nameOf(run.requested_by)} can change this task` };
  if (run.brief) patchJson("runs", "brief", runId, (b) => ({ ...b, _revisedFrom: run.brief_status }));
  exec("update runs set objective=objective || char(10) || ?, brief_status='pending', origin_endpoint_id=coalesce(?, origin_endpoint_id) where id=?",
    `${run.brief_status === "clarifying" ? "Answer" : "Change"} from ${rt.nameOf(userId)}: ${text}`, endpointId ?? null, runId);
  exec("update runs set rev=coalesce(rev, 0)+1 where id=?", runId);
  for (const a of all<any>("select id from approvals where run_id=? and status='pending'", runId)) exec("update approvals set status='expired' where id=?", a.id);
  // An approval for the old requirement that hasn't run yet must not carry over.
  exec("update approvals set status='superseded' where run_id=? and status='approved' and fingerprint not in (select fingerprint from tool_executions where run_id=?)", runId, runId);
  exec("update waits set status='superseded' where run_id=? and status='open'", runId);
  // Close out tool calls the old requirement asked for, then tell the model what changed.
  for (const c of rt.pendingCalls(runId)) rt.appendToolResult(runId, c, "SUPERSEDED: the requirement changed before this ran; follow the updated brief.");
  if (["auto", "confirmed"].includes(run.brief_status)) rt.appendStep(runId, "signal", { text: `Requirement changed by ${rt.nameOf(userId)}: ${text}` });
  rt.requeue(runId);
  emit("BRIEF_REVISED", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: runId, actor: userId, data: { text } });
  return { ok: true };
}

export function cancelBrief(runId: string, userId: string) {
  const run = one<any>("select * from runs where id=?", runId);
  if (!run) return { error: "no such task" };
  if (!canDecide(run, userId)) return { error: `only ${rt.nameOf(run.requested_by)} can cancel this` };
  if (!rt.cancelRun(runId, userId)) return { error: "that task already finished" };
  rt.postMessage(run.room_id, { sender: run.agent_id, runId, text: `Okay — dropped: ${J(run.brief)?.goal ?? run.objective}`, targets: rt.replyTargets(run.room_id, run.origin_endpoint_id) });
  return { ok: true };
}

const GO = /^(go|go ahead|yes|yep|yeah|ok|okay|sure|looks good|lgtm|sounds good|do it|confirm(ed)?|perfect|great|👍)[.!]*$/i;
const STOP = /^(cancel|stop|never ?mind|no|nope|forget it)[.!]*$/i;
const CHANGE = /^(actually|wait|instead|scratch that|change|make it|update|correction|oh,? (and|also)|also,?|and also|one more thing)\b|\binstead\b/i;

/** Route a human message that belongs to an existing task (answer, go, cancel, change). Returns true if consumed. */
export async function routeFollowup(room: any, senderId: string, text: string, endpointId?: string | null) {
  const t = text.trim();
  const agents = rt.roomAgents(room.id);
  const addressed = agents.filter((a) => new RegExp(`(^|[^\\w])@?${a.name.replace(/[^\w]/g, "")}\\b`, "i").test(t)).map((a) => a.id);
  const group = rt.roomHumanIds(room.id).length > 1 || agents.length > 1;
  // A message is about a task only if it isn't addressed to a different agent; in groups it must be a bare reply or address the task's agent.
  const fits = (run: any) => !addressed.some((x) => x !== run.agent_id) && (!group || addressed.includes(run.agent_id) || GO.test(t) || STOP.test(t));
  const waiting = one<any>(`select r.* from runs r join waits w on w.run_id=r.id where r.room_id=? and w.status='open' and w.kind in ('clarify','confirm')
    and (r.requested_by=? or r.requested_by is null) order by w.created_at desc limit 1`, room.id, senderId);
  if (waiting && fits(waiting)) {
    if (GO.test(t)) return !("error" in confirmBrief(waiting.id, senderId, endpointId));
    if (STOP.test(t)) return !("error" in cancelBrief(waiting.id, senderId));
    return !("error" in reviseBrief(waiting.id, senderId, t, endpointId)); // answers to questions, or edits to the plan
  }
  // Drift: the requester changes the requirement of work already in flight.
  const active = one<any>(`select * from runs where room_id=? and requested_by=? and parent_run_id is null and brief_status in ('auto','confirmed')
    and status not in ('completed','failed_terminal','cancelled') order by created_at desc limit 1`, room.id, senderId);
  if (!active || !fits(active)) return false;
  const r = await structured<{ is_change: boolean }>("fast", `An agent is working on: "${J(active.brief)?.goal}". Does this new message change or add to that same task's requirements (not a new, separate request)? {"is_change": boolean}`,
    t, () => ({ is_change: CHANGE.test(t) }), room.workspace_id);
  return r.is_change && !("error" in reviseBrief(active.id, senderId, t, endpointId));
}

// ---------------- execution against the brief ----------------
export function briefContext(run: any) {
  const b: Brief | null = J(run.brief);
  if (!b || !["confirmed", "auto"].includes(run.brief_status)) return "";
  return `[TASK_BRIEF v${b.version} — ${run.brief_status === "confirmed" ? "confirmed by the requester" : "auto-confirmed"}]
Goal: ${b.goal}\nDeliverable: ${b.deliverable}${b.constraints.length ? `\nConstraints (must hold): ${b.constraints.join("; ")}` : ""}${b.assumptions.length ? `\nAssumptions (state them in your reply): ${b.assumptions.join("; ")}` : ""}
Done when: ${b.done_when.join("; ") || "the request is answered"}\nPlan:\n${b.plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text}`).join("\n") || "(none)"}
Stay within this brief. Use plan.update to mark steps or re-plan when something fails. If the request can't be met, say exactly what's missing.`;
}

/** Tick off the first open plan step that used this tool. */
export function markStep(runId: string, tool: string) {
  const r = one<any>("select brief from runs where id=?", runId);
  const b: Brief | null = J(r?.brief);
  const step = b?.plan.find((p) => p.status === "todo" && p.tool === tool);
  if (!b || !step) return;
  step.status = "done";
  exec("update runs set brief=? where id=?", S(b), runId);
}

export function updatePlan(runId: string, u: { step?: number; status?: "done" | "skipped" | "todo"; replace_remaining?: string[] }) {
  const r = one<any>("select brief from runs where id=?", runId);
  const b: Brief | null = J(r?.brief);
  if (!b) return { error: "this task has no plan" };
  if (u.step !== undefined) { const p = b.plan[u.step - 1]; if (!p) return { error: `no step ${u.step}` }; if (u.status) p.status = u.status; }
  if (u.replace_remaining) b.plan = [...b.plan.filter((p) => p.status !== "todo"), ...u.replace_remaining.map((text) => ({ text, status: "todo" as const }))];
  exec("update runs set brief=? where id=?", S(b), runId);
  emit("PLAN_UPDATED", { run_id: runId, data: { plan: b.plan } });
  return { plan: b.plan };
}

const ACK_FAILURE = /\b(couldn'?t|could not|didn'?t run|wasn'?t approved|not approved|was not approved|denied|unable to|failed)\b/i;

/** Check the final answer against "done when" before telling anyone it's done. */
export async function verify(run: any, text: string): Promise<{ pass: boolean; missing: string[]; acknowledged: boolean }> {
  const b: Brief = J(run.brief);
  const ok = new Set(all<any>("select tool_id from tool_executions where run_id=? and status='succeeded'", run.id).map((x) => x.tool_id));
  const items = (text.match(/^\s*(?:\d+[.)]|[•\-*])\s+\S/gm) ?? []).length;
  const heuristic = () => ({
    missing: b.done_when.filter((c) => {
      const lc = c.toLowerCase();
      const n = lc.match(/^(\d+)\s/);
      if (n) return items < Number(n[1]);
      if (/^email to .* sent/.test(lc)) return !ok.has("email.send");
      if (/draft ready/.test(lc)) return !ok.has("email.draft");
      if (/reminder scheduled/.test(lc)) return !ok.has("reminder.schedule");
      if (/is on the calendar/.test(lc)) return !ok.has("calendar.create_event");
      if (/tracked with an owner/.test(lc)) return !ok.has("task.create");
      if (/linked sources|links/.test(lc)) return !/https?:\/\//.test(text);
      return false;
    }),
  });
  const r = await structured<{ missing: string[] }>("fast",
    `You check an AI agent's final reply against its success criteria. Tools that succeeded: ${[...ok].join(", ") || "none"}. Return {"missing": [criteria NOT met by the reply/tool results]} — empty if all are met.`,
    `Criteria:\n${b.done_when.map((c) => `- ${c}`).join("\n")}\n\nReply:\n${text}`, heuristic, run.workspace_id);
  const missing = (Array.isArray(r.missing) ? r.missing : []).map(String);
  return { pass: !missing.length, missing, acknowledged: ACK_FAILURE.test(text) };
}

/** One progress line when long work starts waiting on the outside world (instead of chat spam). */
export function progressNote(run: any, reason: string) {
  const b: Brief | null = J(run.brief);
  if (!b || run.parent_run_id) return;
  const done = b.plan.filter((p) => p.status === "done").length;
  rt.postMessage(run.room_id, { sender: run.agent_id, runId: run.id, text: `⏳ ${b.goal} — ${done}/${b.plan.length} steps done. ${reason.charAt(0).toUpperCase() + reason.slice(1)}; I'll pick this up when it arrives.`,
    targets: rt.replyTargets(run.room_id, run.origin_endpoint_id) });
}
