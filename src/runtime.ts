// Agent runtime: Rooms, Runs, waits, approvals, schedules, delegation (plan §2.4, §2.8, §7, §16, §37).
// Durable by construction: every state change is a DB row, so a crashed process resumes from the last persisted step.
// ponytail: a SQLite-backed run queue + timer table instead of Temporal; one worker process. Move RunWorkflow/RoomWorkflow
// to Temporal when you need multiple workers or > ~50 runs/sec. The run/wait/step model below maps 1:1 onto workflow + signals.
import * as billing from "./billing";
import { all, one, exec, emit, id, now, S, J, tx, recordUsage, patchJson, serverTz, zoned, fromZoned } from "./db";
import { generate } from "./model";
import { runSignature, maybeSuggestSkill, PLANS } from "./templates";
import { buildContext } from "./context";
import { executeToolCall, TOOLS, getTool } from "./tools";
import { extractAfterTurn } from "./memory";
import { structured } from "./model";
import * as channels from "./channels";
import * as intake from "./intake";
import * as reservations from "./reservations";
import * as orders from "./orders";
import * as groupkit from "./groupkit";
import * as jev from "./jev";

export const DEFAULT_BUDGET = { maxModelCostUsd: 0.8, maxToolCalls: 25, maxBrowserMinutes: 10, maxWallClockSeconds: 7 * 86400, maxAutonomousExternalWrites: 3, maxModelCalls: 12 };
const WAIT_STATUS: Record<string, string> = { debounce: "scheduled", clarify: "waiting_for_human", confirm: "waiting_for_human", approval: "waiting_for_human", verify: "waiting_for_human", reconnect: "waiting_for_human",
  event: "waiting_for_external", agent: "waiting_for_agent", time: "scheduled", retry: "retrying" };

// ---------------- principals ----------------
export function nameOf(pid?: string | null): string | undefined {
  if (!pid) return undefined;
  if (pid === "agent") return "agent";
  return pid.startsWith("agt_") ? one<any>("select name from agents where id=?", pid)?.name : one<any>("select name from users where id=?", pid)?.name;
}
export function roleOf(roomId: string, pid?: string | null) {
  if (!pid) return undefined;
  const m = one<any>("select role from room_members where room_id=? and principal_id=?", roomId, pid);
  return m?.role ?? undefined;
}
export const roomHumanIds = (roomId: string) => all<any>("select principal_id from room_members where room_id=? and kind='human'", roomId).map((r) => r.principal_id as string);
export const roomAgents = (roomId: string) => all<any>("select a.* from agents a join room_members m on m.principal_id=a.id where m.room_id=? and a.status='active'", roomId);
export const blockedSubjects = (roomId: string) =>
  all<any>("select subject, title from tasks where room_id=? and agent_action='blocked' and status!='done'", roomId).map((t) => t.subject ?? t.title);

/** Map a free-text owner ("James", "agent", "me") to a principal in the room. */
export function resolveOwner(roomId: string, owner: string | undefined, agentId: string) {
  if (!owner || /^(agent|me|you|ai|self)$/i.test(owner)) return agentId;
  const m = all<any>("select principal_id from room_members where room_id=?", roomId).find((x) => nameOf(x.principal_id)?.toLowerCase() === owner.toLowerCase());
  return m?.principal_id ?? owner;
}

// ---------------- rooms ----------------
export function createRoom(r: { workspace_id: string; name: string; kind?: "private" | "shared"; participation?: string; objective?: string; mode?: "live" | "test"; members?: { id: string; kind: "human" | "agent"; role?: string }[] }) {
  const rid = id("room");
  tx(() => {
    exec("insert into rooms (id, workspace_id, name, objective, kind, participation, mode, created_at) values (?,?,?,?,?,?,?,?)",
      rid, r.workspace_id, r.name, r.objective ?? null, r.kind ?? "shared", r.participation ?? (r.kind === "private" ? "manager" : "mention_only"), r.mode ?? "live", now());
    for (const m of r.members ?? []) addMember(rid, m.id, m.kind, m.role);
  });
  emit("ROOM_CREATED", { workspace_id: r.workspace_id, room_id: rid, data: { name: r.name } });
  return one<any>("select * from rooms where id=?", rid);
}
export function addMember(roomId: string, principalId: string, kind: "human" | "agent", role?: string) {
  const room = one<any>("select workspace_id from rooms where id=?", roomId);
  const title = kind === "human" ? (one<any>("select title from memberships where workspace_id=? and user_id=?", room?.workspace_id, principalId)?.title
    ?? (one<any>("select 1 from memberships where workspace_id=? and user_id=?", room?.workspace_id, principalId) ? undefined : "guest")) : undefined;
  const r = exec("insert or ignore into room_members (room_id, principal_id, kind, role) values (?,?,?,?)", roomId, principalId, kind, role ?? title ?? null);
  if (r.changes) emit("MEMBER_JOINED", { room_id: roomId, actor: principalId, data: { kind } });
}
/** The private Room for (user, agent): every channel's DM with that agent lands here, so work follows the person (plan §2.4). */
export function privateRoomFor(userId: string, agent: any) {
  const r = one<any>(`select r.* from rooms r where r.kind='private' and r.workspace_id=? and r.status='active' and coalesce(r.mode,'live')='live'
    and exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?)
    and exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?)
    and (select count(*) from room_members m where m.room_id=r.id and m.kind='human')=1 order by r.created_at limit 1`, agent.workspace_id, userId, agent.id);
  return r ?? createRoom({ workspace_id: agent.workspace_id, name: `${nameOf(userId)} & ${agent.name}`, kind: "private", participation: "manager",
    members: [{ id: userId, kind: "human" }, { id: agent.id, kind: "agent" }] });
}

// ---------------- messages ----------------
export function postMessage(roomId: string, m: { sender: string; text: string; platform?: string; endpointId?: string | null; externalId?: string; runId?: string;
  approvalId?: string; untrusted?: boolean; targets?: string[]; buttons?: { label: string; data: string }[]; brief?: any }) {
  const room = one<any>("select * from rooms where id=?", roomId);
  const eid = emit("message", { workspace_id: room.workspace_id, room_id: roomId, run_id: m.runId, actor: m.sender,
    data: { text: m.text, platform: m.platform ?? "web", endpoint_id: m.endpointId ?? null, external_id: m.externalId ?? null, approval_id: m.approvalId ?? null, untrusted: !!m.untrusted,
      ...(m.buttons?.length ? { buttons: m.buttons } : {}), ...(m.brief ? { brief: m.brief } : {}) } });
  if (m.endpointId) exec("update room_endpoints set last_active_at=? where id=?", now(), m.endpointId);
  if (m.sender.startsWith("agt_")) {
    for (const ep of m.targets ?? []) channels.enqueue(ep, roomId, eid, { text: m.text, agentName: nameOf(m.sender), buttons: m.buttons });
    if (m.sender?.startsWith("agt_") && (m.targets ?? []).length) recordUsage({ workspace_id: room.workspace_id, agent_id: m.sender, kind: "channel_messages", qty: (m.targets ?? []).length });
  }
  return eid;
}

/** Where an agent's reply should go: the endpoint the request came from, else the Room's most recently active external endpoint. Web always sees everything. */
export function replyTargets(roomId: string, originEndpointId?: string | null) {
  if (originEndpointId === "web") return []; // asked on web, answered on web (web shows every room event)
  if (originEndpointId) return [originEndpointId];
  const ep = one<any>("select id from room_endpoints where room_id=? order by last_active_at desc limit 1", roomId);
  return ep ? [ep.id] : [];
}

const mentions = (text: string, name: string) => new RegExp(`(^|[^\\w])@?${name.replace(/[^\w]/g, "")}\\b`, "i").test(text);

/** Inbound pipeline after normalization + resolution (plan §5.2): persist, route approvals/signals, decide who responds, start runs. */
export async function ingestMessage(i: { roomId: string; senderId: string; text: string; platform?: string; endpointId?: string | null; externalId?: string; untrusted?: boolean }) {
  const room = one<any>("select * from rooms where id=?", i.roomId);
  if (!room) throw new Error("no such room");
  addMember(room.id, i.senderId, "human");
  const eventId = postMessage(room.id, { sender: i.senderId, text: i.text, platform: i.platform, endpointId: i.endpointId, externalId: i.externalId, untrusted: i.untrusted });
  const started: string[] = [];
  // Memory write pipeline (scoped, with provenance).
  if (room.mode !== "test") await extractAfterTurn(room, { id: eventId, text: i.text, sender: i.senderId, senderName: nameOf(i.senderId) ?? "someone" }).catch(() => {});

  // 1. Text approvals ("approve", "yes", "confirm 1a2b") for the sender's pending approvals in this room.
  // Only a bare decision counts: "yes but send it to Dana instead" is a new request, not an approval.
  const approvalReply = i.text.trim().match(/^(approve|approved|yes|yep|go ahead|ok|confirm(?: (\w{4}))?|reject|no|deny|don'?t)[.!]?$/i);
  if (approvalReply) {
    const pending = all<any>("select * from approvals where room_id=? and status='pending' order by created_at desc", room.id).filter((a) => canApprove(a, i.senderId));
    if (pending.length) {
      const approve = !/^(reject|no|deny|don'?t)/i.test(approvalReply[1]);
      const target = approvalReply[2] ? pending.find((a) => a.id.endsWith(approvalReply[2].toLowerCase())) : pending[0];
      if (target) {
        const r = decideApproval(target.id, i.senderId, approve ? "approve" : "reject", { confirm: !!approvalReply[2] }, i.endpointId ?? null);
        if ("error" in r) postMessage(room.id, { sender: target.agent_id, text: r.error!, targets: replyTargets(room.id, i.endpointId ?? "web") });
        return { eventId, started };
      }
    }
  }

  // 2. Messages that belong to an existing task: answers to questions, "go", edits, or mid-flight changes.
  if (await intake.routeFollowup(room, i.senderId, i.text, i.endpointId ?? "web")) return { eventId, started };

  // 3. Runs waiting for a message in this room resume instead of starting fresh work.
  for (const w of all<any>("select * from waits where status='open' and wake_key='room_message' and room_id=?", room.id))
    resumeWait(w.id, `${nameOf(i.senderId)} replied: ${i.text}`);

  // 4. Participation policy (plan §15.2): who should respond?
  const agents = roomAgents(room.id);
  // "in for 2" in a chat with an open group order, "2" / "Saturday" in a chat with an open poll
  const orderAgent = orders.orderAgentFor(room.id, i.text) ?? groupkit.pollAgentFor(room.id, i.text);
  for (const a of agents) {
    let respond = false;
    if (orderAgent) respond = orderAgent === a.id;
    else if (roleOf(room.id, a.id) === "delegate") respond = new RegExp(`@${a.name.replace(/[^\w]/g, "")}\\b`, "i").test(i.text);
    else if (room.participation === "manager" || (room.kind === "private" && agents.length === 1)) respond = true;
    else if (mentions(i.text, a.name)) respond = true;
    else if (room.participation === "relevant") {
      const p = await jev.noul({ agent: a.name, agent_job: a.job, message: i.text }, `Should ${a.name} reply to this group-chat message?`,
        "Addressed to the agent or asks for something within its job", "Chatter between people; the agent should stay quiet");
      if (p != null) { respond = p >= 0.5; if (!respond) continue; }
      else {
      const r = await structured<{ relevant: boolean }>("fast", `Should ${a.name} (job: ${a.job}) respond to this group message? Only if it is clearly asking for or about its job. {"relevant": boolean}`,
        i.text, () => ({ relevant: a.job.toLowerCase().split(/\W+/).filter((w: string) => w.length > 4).some((w: string) => i.text.toLowerCase().includes(w)) }), room.workspace_id);
      respond = r.relevant;
      }
    }
    if (!respond) continue;
    // Burst combining (plan §5.2): people text in bursts on messaging channels; fold them into one run.
    const debounceMs = Number(process.env.DEBOUNCE_MS ?? 1500);
    const burst = debounceMs > 0 && i.platform && !["web", "phone"].includes(i.platform);
    const open = burst ? one<any>(`select w.id, w.run_id from waits w join runs r on r.id=w.run_id where w.kind='debounce' and w.status='open'
      and r.room_id=? and r.agent_id=? and r.requested_by=?`, room.id, a.id, i.senderId) : null;
    if (open) {
      exec("update runs set objective=objective || char(10) || ? where id=?", i.text, open.run_id);
      exec("update waits set wake_at=? where id=?", now() + debounceMs, open.id);
      continue;
    }
    const busy = one<any>("select objective from runs where room_id=? and agent_id=? and status in ('queued','running','retrying') order by created_at limit 1", room.id, a.id);
    const run = createRun({ room, agent: a, objective: i.text, requestedBy: i.senderId, triggerEventId: eventId, originEndpointId: i.endpointId ?? "web", tainted: i.untrusted, intake: true });
    // Already working on something in this chat: say so now instead of going silent until it's this request's turn.
    if (busy) postMessage(room.id, { sender: a.id, runId: run.id, text: `Got it — I'll get to that right after “${String(busy.objective).split("\n")[0].slice(0, 60)}”.`, targets: replyTargets(room.id, i.endpointId ?? "web") });
    if (burst) createWait(run, { kind: "debounce", reason: "collecting message burst", wake_at: now() + debounceMs });
    started.push(run.id);
  }
  return { eventId, started };
}

// ---------------- runs ----------------
// ---------------- execution engine ----------------
// "local": this process steps runs in tick() (tests, single-box dev). "temporal": each run is a Temporal workflow that calls
// advanceRun(); anything that makes a run runnable notifies it (start-or-wake), and Temporal owns retries, timers and history.
const TERMINAL = ["completed", "failed_terminal", "cancelled"];
export const engine = { temporal: () => process.env.ENGINE === "temporal", onQueued: null as null | ((runId: string) => void) };
function notifyQueued(runId: string) { if (engine.temporal()) engine.onQueued?.(runId); }
/** A run became runnable again (resumed, revised, retried). */
export function requeue(runId: string) { setStatus(runId, "queued"); }

export function createRun(r: { room: any; agent: any; objective: string; requestedBy?: string | null; triggerEventId?: string | null; originEndpointId?: string | null;
  kind?: string; parentRunId?: string; budget?: Partial<typeof DEFAULT_BUDGET>; tainted?: boolean; result?: any; intake?: boolean }) {
  const rid = id("run");
  exec(`insert into runs (id, workspace_id, room_id, agent_id, objective, kind, status, requested_by, parent_run_id, trigger_event_id, origin_endpoint_id, budget, spent, tainted, result, created_at, updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, rid, r.room.workspace_id, r.room.id, r.agent.id, r.objective, r.kind ?? "respond", "queued", r.requestedBy ?? null,
    r.parentRunId ?? null, r.triggerEventId ?? null, r.originEndpointId ?? null, S({ ...DEFAULT_BUDGET, ...r.budget }), S({ cost: 0, toolCalls: 0, externalWrites: 0, modelCalls: 0 }),
    r.tainted ? 1 : 0, r.result ? S(r.result) : null, now(), now());
  if (r.intake) exec("update runs set brief_status='pending' where id=?", rid);
  emit("RUN_STARTED", { workspace_id: r.room.workspace_id, room_id: r.room.id, run_id: rid, actor: r.agent.id, data: { objective: r.objective, requested_by: r.requestedBy, kind: r.kind ?? "respond" } });
  notifyQueued(rid);
  return one<any>("select * from runs where id=?", rid);
}

export function addSpent(runId: string, d: { cost?: number; toolCalls?: number; externalWrites?: number; modelCalls?: number; tainted?: boolean }) {
  const r = one<any>("select spent, tainted from runs where id=?", runId);
  const s = J(r.spent, {});
  for (const k of ["cost", "toolCalls", "externalWrites", "modelCalls"] as const) s[k] = (s[k] ?? 0) + (d[k] ?? 0);
  exec("update runs set spent=?, tainted=?, updated_at=? where id=?", S(s), r.tainted || d.tainted ? 1 : 0, now(), runId);
}
const setStatus = (runId: string, status: string, extra: { error?: string; result?: any } = {}) => {
  // A finished run stays finished: late writers (an in-flight model call after a cancel) can't resurrect it.
  const changed = exec(`update runs set status=?, error=coalesce(?, error), result=coalesce(?, result), updated_at=?, completed_at=? where id=? and status not in ('completed','failed_terminal','cancelled')`,
    status, extra.error ?? null, extra.result ? S(extra.result) : null, now(), TERMINAL.includes(status) ? now() : null, runId).changes > 0;
  if (changed && status === "queued") notifyQueued(runId);
  if (changed && TERMINAL.includes(status) && engine.temporal()) { // the next request in this conversation may have been waiting its turn
    const r = one<any>("select agent_id, room_id from runs where id=?", runId);
    const next = r && one<any>("select id from runs where agent_id=? and room_id=? and status='queued' order by created_at limit 1", r.agent_id, r.room_id);
    if (next) notifyQueued(next.id);
  }
  return changed;
};
export const appendStep = (runId: string, type: string, data: any) => exec("insert into run_steps (run_id, type, data, ts) values (?,?,?,?)", runId, type, S(data), now());
export function appendToolResult(runId: string, call: { id: string; name: string }, content: string) {
  appendStep(runId, "tool_result", { callId: call.id, tool: call.name, content });
}

export const isFinished = (runId: string) => ["completed", "failed_terminal", "cancelled"].includes(one<any>("select status from runs where id=?", runId)?.status);
export function createWait(run: any, w: { kind: string; reason: string; owner?: string; wake_key?: string; wake_at?: number; timeout_at?: number; on_timeout?: string }) {
  if (isFinished(run.id)) return undefined;
  const wid = id("wait");
  exec("insert into waits (id, run_id, room_id, kind, reason, owner, wake_key, wake_at, timeout_at, on_timeout, created_at) values (?,?,?,?,?,?,?,?,?,?,?)",
    wid, run.id, run.room_id, w.kind, w.reason, w.owner ?? null, w.wake_key ?? null, w.wake_at ?? null, w.timeout_at ?? null, w.on_timeout ?? "resume", now());
  setStatus(run.id, WAIT_STATUS[w.kind] ?? "waiting_for_external");
  emit("RUN_WAITING", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, data: { wait_id: wid, kind: w.kind, reason: w.reason, owner: w.owner } });
  if (w.kind === "event") intake.progressNote(one<any>("select * from runs where id=?", run.id), w.reason);
  return wid;
}

export function resumeWait(waitId: string, signal?: string) {
  const w = one<any>("select * from waits where id=? and status='open'", waitId);
  if (!w) return false;
  exec("update waits set status='done' where id=?", waitId);
  if (signal) appendStep(w.run_id, "signal", { text: signal, wait_kind: w.kind });
  const r = one<any>("select * from runs where id=?", w.run_id);
  if (r && !["completed", "failed_terminal", "cancelled"].includes(r.status) && !one("select 1 from waits where run_id=? and status='open'", r.id)) {
    setStatus(r.id, "queued");
    emit("RUN_RESUMED", { workspace_id: r.workspace_id, room_id: r.room_id, run_id: r.id, data: { wait_id: waitId, kind: w.kind } });
  }
  return true;
}

/** Signal every wait/trigger keyed on an external event (inbound email, task state, connection restored...). */
export function signalEvent(key: string, text: string) {
  let n = 0;
  for (const w of all<any>("select id from waits where status='open' and wake_key=?", key)) n += +resumeWait(w.id, text);
  for (const s of all<any>("select * from schedules where status='active' and kind='event' and json_extract(spec, '$.wake_key')=?", key)) { fireSchedule(s, text); n++; }
  return n;
}

export function pendingCalls(runId: string) {
  const last = one<any>("select data from run_steps where run_id=? and type='assistant' order by id desc limit 1", runId);
  if (!last) return [];
  const calls = J(last.data).toolCalls ?? [];
  const done = new Set(all<any>("select data from run_steps where run_id=? and type='tool_result'", runId).map((s) => J(s.data).callId));
  return calls.filter((c: any) => !done.has(c.id));
}

/** One durable step of the agent loop. Returns when the run completes, fails, or waits. A crash fails the run instead of
 * leaving it 'running' (which would block the conversation behind it). */
export async function stepRun(runId: string) {
  try { await stepRunInner(runId); }
  catch (e: any) {
    console.error("[run]", runId, e);
    const r = one<any>("select * from runs where id=?", runId);
    if (r && r.status === "running") fail(r, "something went wrong on our side");
  }
}
async function stepRunInner(runId: string) {
  const claimed = exec("update runs set status='running', updated_at=? where id=? and status='queued'", now(), runId);
  if (!claimed.changes) return; // someone else has it, or it's not runnable
  let run = one<any>("select * from runs where id=?", runId);
  // After every await: if the run was cancelled or its requirement revised meanwhile, this step is stale — stop without writing.
  const rev0 = run.rev ?? 0;
  const live = () => { const r = one<any>("select status, rev from runs where id=?", runId); return r?.status === "running" && (r.rev ?? 0) === rev0; };
  const agent = one<any>("select * from agents where id=?", run.agent_id);
  const room = one<any>("select * from rooms where id=?", run.room_id);
  const budget = J(run.budget, DEFAULT_BUDGET);
  const base = { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: agent.id };
  if (agent.status !== "active") return fail(run, "agent is paused");
  if (now() - run.created_at > budget.maxWallClockSeconds * 1000) return fail(run, "run exceeded its wall-clock budget");
  // Requirement layer: brief -> clarify/confirm/auto before any tool runs.
  if (run.brief_status === "pending") {
    if ((await intake.intake(run, agent, room, live)) === "wait" || !live()) return;
    run = one<any>("select * from runs where id=?", runId);
  }

  const runCalls = async (calls: any[], allowed: Set<string>) => {
    for (const c of calls) {
      run = one<any>("select * from runs where id=?", runId);
      if (!live()) return "wait";
      const r = await executeToolCall(run, agent, room, c, allowed);
      if (r.kind === "result" && !live()) return "wait"; // keep the audit trail, but don't continue a stale plan
      if (r.kind === "result") { appendToolResult(run.id, c, r.content); if (r.status === "SUCCEEDED") intake.markStep(run.id, c.name); }
      else if (r.kind === "wait") return "wait";
      else { createWait(run, { kind: "retry", reason: `retrying ${c.name}: ${r.reason}`, wake_at: now() + r.delayMs }); return "wait"; }
    }
    return "ok";
  };

  const pending = pendingCalls(run.id);
  if (pending.length && (await runCalls(pending, buildContext(run, agent, room).allowed)) === "wait") return;

  for (let i = 0; i < budget.maxModelCalls; i++) {
    run = one<any>("select * from runs where id=?", runId);
    const spent = J(run.spent, {});
    if (spent.modelCalls >= budget.maxModelCalls) break;
    if (spent.cost >= budget.maxModelCostUsd) return fail(run, `model cost budget ($${budget.maxModelCostUsd}) exhausted`);
    const c = buildContext(run, agent, room);
    if (!billing.canSpend(run.workspace_id))
      return fail(run, "this workspace is out of AI credits — add credits or your own model key in Settings → AI");
    let res;
    try {
      channels.typing(run.origin_endpoint_id); // "…is typing" in the chat this came from while the model works
      // Past twice the plan's tool budget the model gets no tools: it has to answer with what it has.
      const overBudget = (spent.toolCalls ?? 0) >= toolBudget(run.id) * 2;
      progressNote(run, agent, room);
      res = await generate({ profile: routeProfile(agent, run), system: c.system, messages: c.messages, tools: overBudget ? [] : c.tools,
        workspaceId: run.workspace_id, agentId: agent.id, runId: run.id, ctx: c.ctx, escalate: (spent.modelErrors ?? 0) > 0 || !!spent.unbackedRetries || i >= budget.maxModelCalls - 2 });
    } catch (e: any) {
      const errs = (spent.modelErrors ?? 0) + 1;
      patchJson("runs", "spent", run.id, (s) => ({ ...s, modelErrors: errs }));
      emit("MODEL_CALL_FAILED", { ...base, data: { error: e.message, attempt: errs } });
      if (errs >= 3) return fail(run, `model unavailable: ${e.message}`);
      createWait(run, { kind: "retry", reason: "model call failed; retrying", wake_at: now() + 2 ** errs * 1000 });
      return;
    }
    addSpent(run.id, { cost: res.costUsd, modelCalls: 1 });
    if (!live()) return; // cancelled or revised while the model was thinking: drop this answer
    appendStep(run.id, "assistant", { text: res.text, toolCalls: res.toolCalls, model: res.model, raw: res.raw });
    emit("MODEL_CALL", { ...base, data: { model: res.model, tool_calls: res.toolCalls.map((t) => t.name), usage: res.usage, cost_usd: res.costUsd } });
    if (!res.toolCalls.length) {
      // A reply that promises or claims an action with nothing behind it ("I'll book…", "reply approve") gets one corrective
      // retry on a stronger model — live models do this, and it leaves the user waiting on an approval that doesn't exist.
      if (!spent.unbackedRetries && await claimsUnbackedAction(run.id, res.text)) {
        patchJson("runs", "spent", run.id, (s) => ({ ...s, unbackedRetries: 1 }));
        emit("UNBACKED_CLAIM", { ...base, data: { text: res.text.slice(0, 300), model: res.model } });
        appendStep(run.id, "signal", { text: `[CHECK] You described an action but didn't call a tool, so nothing happened. If the user asked for it, call the tool now — the platform requests approval automatically when needed. Never ask the user to reply "approve" yourself. If you can't do it, say so plainly.` });
        continue;
      }
      // Don't claim "done" until the result is checked against the brief's success criteria.
      const b = J(run.brief);
      if (b?.done_when?.length && ["confirmed", "auto"].includes(run.brief_status) && !run.parent_run_id) {
        const v = await intake.verify(run, res.text);
        if (!live()) return;
        const checks = (spent.verifications ?? 0) + 1;
        patchJson("runs", "spent", run.id, (s) => ({ ...s, verifications: checks }));
        emit("RESULT_CHECKED", { ...base, data: { pass: v.pass, missing: v.missing, acknowledged: v.acknowledged } });
        if (!v.pass && !v.acknowledged && checks < 2) {
          appendStep(run.id, "signal", { text: `[CHECK] Not done yet. Still missing: ${v.missing.join("; ")}. Keep working, or explain exactly what's blocking it.` });
          continue;
        }
        if (!v.pass && !v.acknowledged) return complete(run, agent, room, `${res.text}\n\n⚠️ Not fully done — still missing: ${v.missing.join("; ")}`);
      }
      return complete(run, agent, room, res.text);
    }
    if ((await runCalls(res.toolCalls, c.allowed)) === "wait") return;
    wrapUpNudge(run.id);
  }
  return fail(run, "step limit reached without finishing");
}

/** Long work gets one "still on it" with what's been done so far, so a chat never just goes quiet. */
function progressNote(run: any, agent: any, room: any) {
  const spent = J(run.spent, {});
  if (spent.progressNoted || run.parent_run_id || now() - run.created_at < Number(process.env.PROGRESS_NOTE_MS ?? 75_000)) return;
  patchJson("runs", "spent", run.id, (x) => ({ ...x, progressNoted: 1 }));
  const tools = all<any>("select json_extract(data, '$.tool') t from events where run_id=? and type='TOOL_CALL_REQUESTED'", run.id).map((r) => r.t);
  const n = (t: string) => tools.filter((x) => x === t).length;
  const did = [n("web.search") && `${n("web.search")} searches`, n("web.fetch") && `${n("web.fetch")} pages read`, n("browser.task") && "a site checked"].filter(Boolean).join(", ");
  postMessage(room.id, { sender: agent.id, runId: run.id, text: `Still on it${did ? ` — ${did} so far` : ""}. Wrapping up shortly.`, targets: replyTargets(room.id, run.origin_endpoint_id) });
}

/** The plan's tool budget for this run (intake.planWork), else a default. */
function toolBudget(runId: string) { return Number(J(one<any>("select brief from runs where id=?", runId)?.brief, {})?.tool_budget) || Number(process.env.WRAP_UP_TOOL_CALLS ?? 12); }

/** Keeps research from spiralling (a live run made 20+ searches for "three hotel options"): once, after WRAP_UP_TOOL_CALLS tool
 *  calls, tell the model to answer with what it has; and when search keeps coming back empty, say so instead of letting it retry. */
function wrapUpNudge(runId: string) {
  const spent = J(one<any>("select spent from runs where id=?", runId).spent, {});
  const results = all<any>("select data from run_steps where run_id=? and type='tool_result' order by id desc limit 3", runId).map((r) => J(r.data, {}));
  const searchDown = results.length === 3 && results.every((r) => r.tool === "web.search" && /"results":\s*\[\]/.test(String(r.content)));
  if (searchDown && !spent.searchDownNoted) {
    patchJson("runs", "spent", runId, (x) => ({ ...x, searchDownNoted: 1 }));
    appendStep(runId, "signal", { text: "[CHECK] Web search isn't returning results right now. Don't keep searching: answer from what you already found (open pages you have links for if needed) and say what you couldn't verify." });
  } else if ((spent.toolCalls ?? 0) >= toolBudget(runId) && !spent.wrapUpNoted) {
    patchJson("runs", "spent", runId, (x) => ({ ...x, wrapUpNoted: 1 }));
    appendStep(runId, "signal", { text: "[CHECK] You've gathered plenty. Stop researching and answer now with the best of what you have — concrete options with links — and say plainly what's unverified (e.g. live prices)." });
  }
}

const ACTION_CLAIM = /\b(I['’]ll|I will|I['’]m going to|I['’]ve|I have|going to)\s+(go ahead and\s+)?(book|send|schedule|reserve|create|add|cancel|email|text|order|buy|pay|post|invite)\b|\b(reply|respond|say)\s+["“']?approve\b/i;
/** The reply promises/claims a side effect, yet this run has no successful write and no pending approval to show for it. */
async function claimsUnbackedAction(runId: string, text: string) {
  if (one("select 1 from approvals where run_id=? and status='pending'", runId)) return false;
  if (all<any>("select data from run_steps where run_id=? and type='tool_result'", runId).some((s) => {
    const d = J(s.data, {}); return getTool(d.tool)?.risk !== "read" && !/^(FAILED|DENIED|REJECTED|SUPERSEDED)/.test(String(d.content ?? ""));
  })) return false;
  // Nothing backs a claim, so judge the wording: JEV catches phrasings the regex misses ("Done! Invite's out"); regex if JEV is off.
  const p = await jev.noul({ reply: text.slice(0, 2000) }, "Does this reply claim or promise an action (booking, sending, scheduling, ordering, cancelling) as done or about to happen, or ask the user to reply 'approve'?",
    "Claims or promises an action", "Only information, options or questions");
  return p != null ? p >= 0.5 : ACTION_CLAIM.test(text);
}

/** Structured run classification (plan §7.4), derived from what the run actually did. */
function classify(runId: string, current: string) {
  if (current === "schedule" || current === "delegate") return current;
  const used = all<any>("select data from run_steps where run_id=? and type='assistant'", runId).flatMap((s) => (J(s.data).toolCalls ?? []).map((c: any) => c.name));
  return used.includes("agent.delegate") ? "delegate" : used.includes("reminder.schedule") ? "schedule"
    : used.includes("wait.for_reply") ? "task" : used.length ? "act" : "respond";
}

function complete(run: any, agent: any, room: any, text: string) {
  if (!setStatus(run.id, "completed", { result: { text, ...(J(run.result, {}) ?? {}) } })) return;
  exec("update runs set kind=? where id=?", classify(run.id, run.kind), run.id);
  const used = all<any>("select tool_id from tool_executions where run_id=? and status='succeeded' order by created_at", run.id).map((x) => x.tool_id);
  exec("update runs set signature=? where id=?", runSignature(used) || null, run.id);
  emit("RUN_COMPLETED", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: agent.id, data: { text: text.slice(0, 500) } });
  if (run.parent_run_id) {
    // Typed handoff back to the parent (plan §16.2); the child's text is not posted to the room.
    signalEvent(`run:${run.id}`, `${agent.name} finished the delegated task. Result: ${text}`);
    return;
  }
  if (text.trim()) postMessage(room.id, { sender: agent.id, text, runId: run.id, targets: replyTargets(room.id, run.origin_endpoint_id) });
  if (maybeSuggestSkill(one<any>("select * from runs where id=?", run.id)))
    postMessage(room.id, { sender: agent.id, runId: run.id, targets: replyTargets(room.id, run.origin_endpoint_id),
      text: `I've done this kind of task ${3} times now. Save it as a skill so I do it the same way every time?`,
      buttons: [{ label: "Save as skill", data: `skl:${run.id}:save` }, { label: "Not now", data: `skl:${run.id}:no` }] });
}

function fail(run: any, reason: string) {
  if (!setStatus(run.id, "failed_terminal", { error: reason })) return;
  emit("RUN_FAILED", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: run.agent_id, data: { reason } });
  if (run.parent_run_id) signalEvent(`run:${run.id}`, `${nameOf(run.agent_id)} could not finish: ${reason}`);
  else postMessage(run.room_id, { sender: run.agent_id, text: `I couldn't finish that: ${reason}.`, runId: run.id, targets: replyTargets(run.room_id, run.origin_endpoint_id) });
}

export function cancelRun(runId: string, by: string) {
  const r = one<any>("select * from runs where id=?", runId);
  if (!r || ["completed", "failed_terminal", "cancelled"].includes(r.status)) return false;
  exec("update waits set status='cancelled' where run_id=? and status='open'", runId);
  exec("update approvals set status='expired' where run_id=? and status='pending'", runId);
  setStatus(runId, "cancelled");
  emit("RUN_CANCELLED", { workspace_id: r.workspace_id, room_id: r.room_id, run_id: runId, actor: by });
  return true;
}

// ---------------- approvals (plan §3.7, §19) ----------------
export function canApprove(a: any, userId: string) {
  const approvers: string[] = J(a.approvers, []);
  if (approvers.length) return approvers.includes(userId);
  const ws = one<any>("select workspace_id from rooms where id=?", a.room_id)?.workspace_id;
  return !!one("select 1 from memberships where workspace_id=? and user_id=? and role in ('owner','admin')", ws, userId);
}

export function requestApproval(run: any, agent: any, d: any, input: any, fp: string, strong: boolean, reason: string, conn: any) {
  if (isFinished(run.id)) return undefined;
  const existing = one<any>("select * from approvals where run_id=? and fingerprint=? and status='pending'", run.id, fp);
  if (existing) return one<any>("select id from waits where wake_key=? and status='open'", `approval:${existing.id}`)?.id
    ?? createWait(run, { kind: "approval", reason: `approval: ${existing.summary}`, owner: J(existing.approvers, [])[0], wake_key: `approval:${existing.id}`, timeout_at: now() + 72 * 36e5, on_timeout: "expire" });
  // Approver: the credential owner for private connections, else the requester — but never an outside guest
  // (empty list = workspace owners/admins decide).
  const member = (u?: string | null) => !!u && !!one("select 1 from memberships where workspace_id=? and user_id=?", run.workspace_id, u);
  const approvers = conn?.visibility === "private" ? [conn.owner_id] : member(run.requested_by) ? [run.requested_by] : [];
  const aid = id("apr");
  const summary = d.summarize ? d.summarize(input) : `${d.id} ${JSON.stringify(input).slice(0, 120)}`;
  exec(`insert into approvals (id, run_id, room_id, agent_id, tool_id, input, fingerprint, summary, risk, approvers, strong, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    aid, run.id, run.room_id, agent.id, d.id, S(input), fp, summary, d.risk, S(approvers), strong ? 1 : 0, now());
  emit("APPROVAL_REQUESTED", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: agent.id, data: { approval_id: aid, tool: d.id, summary, reason, approvers, connection: conn?.account } });
  const wid = createWait(run, { kind: "approval", reason: `approval: ${summary}`, owner: approvers[0], wake_key: `approval:${aid}`, timeout_at: now() + 72 * 36e5, on_timeout: "expire" });
  const who = approvers.map(nameOf).join(" or ");
  postMessage(run.room_id, { sender: agent.id, runId: run.id, approvalId: aid, targets: replyTargets(run.room_id, run.origin_endpoint_id),
    buttons: [{ label: strong ? "Confirm" : "Approve", data: `apr:${aid}:approve` }, { label: "Reject", data: `apr:${aid}:reject` }],
    text: `${agent.name} wants to: ${summary}${conn ? ` (from ${conn.account})` : ""}.\n${strong ? `This needs strong confirmation — reply "confirm ${aid.slice(-4)}".` : `${who}: reply "approve" or "reject".`}` });
  return wid;
}

export function decideApproval(approvalId: string, userId: string, decision: "approve" | "reject", constraints: { confirm?: boolean; [k: string]: any } = {}, fromEndpointId?: string | null) {
  const a = one<any>("select * from approvals where id=?", approvalId);
  if (!a) return { error: "no such approval" };
  if (a.status !== "pending") return { error: `already ${a.status}` };
  if (!canApprove(a, userId)) return { error: `${nameOf(userId)} can't approve this; it needs ${J(a.approvers, []).map(nameOf).join(" or ")}` };
  if (decision === "approve" && a.strong && !constraints.confirm) return { error: `This needs strong confirmation — reply "confirm ${a.id.slice(-4)}".` };
  exec("update approvals set status=?, decided_by=?, decided_at=?, constraints=? where id=?", decision === "approve" ? "approved" : "rejected", userId, now(), S(constraints), a.id);
  if (decision === "approve" && getTool(a.tool_id)?.defaultApproval === "first_time") exec("insert into grants values (?,?,?,?,?)", id("grt"), a.agent_id, a.tool_id, userId, now());
  emit(decision === "approve" ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED", { room_id: a.room_id, run_id: a.run_id, actor: userId, data: { approval_id: a.id, tool: a.tool_id, constraints } });
  // The run continues where the human answered (e.g. asked on web, approved from iMessage).
  if (fromEndpointId !== undefined) exec("update runs set origin_endpoint_id=? where id=?", fromEndpointId ?? "web", a.run_id);
  const w = one<any>("select id from waits where wake_key=? and status='open'", `approval:${a.id}`);
  if (w) resumeWait(w.id);
  return { ok: true, status: decision === "approve" ? "approved" : "rejected" };
}

// ---------------- tasks (room work state) ----------------
export function createTask(roomId: string, t: { title: string; owner?: string; agent_action?: string; subject?: string; due_at?: number | null; created_by?: string }) {
  const tid = id("task");
  exec("insert into tasks (id, room_id, title, owner, agent_action, subject, due_at, created_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)",
    tid, roomId, t.title, t.owner ?? null, t.agent_action ?? "allowed", t.subject ?? null, t.due_at ?? null, t.created_by ?? null, now(), now());
  emit("TASK_CREATED", { room_id: roomId, actor: t.created_by, data: { task_id: tid, ...t } });
  // DEADLINE wake condition: 24h before due (plan §37).
  if (t.due_at && t.owner?.startsWith("agt_")) createSchedule({ agent_id: t.owner, room_id: roomId, kind: "time", spec: { at: Math.max(now(), t.due_at - 864e5) }, objective: `Deadline approaching for task "${t.title}". Check status and nudge the owner if needed.`, created_by: t.created_by });
  return one<any>("select * from tasks where id=?", tid);
}
export function updateTask(taskId: string, roomId: string, u: { status?: string; notes?: string; owner?: string }, actor?: string) {
  const t = one<any>("select * from tasks where id=? and room_id=?", taskId, roomId);
  if (!t) return null;
  exec("update tasks set status=coalesce(?, status), notes=coalesce(?, notes), owner=coalesce(?, owner), updated_at=? where id=?", u.status ?? null, u.notes ?? null, u.owner ?? null, now(), taskId);
  emit("TASK_UPDATED", { room_id: roomId, actor, data: { task_id: taskId, ...u } });
  if (u.status && u.status !== t.status) signalEvent(`task_${u.status}:${roomId}`, `Task "${t.title}" is now ${u.status}${u.notes ? `: ${u.notes}` : ""}`); // STATE wake
  return one<any>("select * from tasks where id=?", taskId);
}

// ---------------- delegation (plan §16) ----------------
export function delegate(parent: any, agentName: string, objective: string, context?: string) {
  const from = one<any>("select * from agents where id=?", parent.agent_id);
  const to = one<any>("select * from agents where workspace_id=? and lower(name)=lower(?) and status='active'", parent.workspace_id, agentName);
  if (!to) return { error: `no agent named ${agentName} in this workspace` };
  if (to.id === from.id) return { error: "can't delegate to yourself" };
  if (parent.parent_run_id) return { error: "delegated runs can't delegate further" };
  const room = one<any>("select * from rooms where id=?", parent.room_id);
  addMember(room.id, to.id, "agent", "delegate"); // present for the handoff; speaks only when @-mentioned
  const pb = J(parent.budget, DEFAULT_BUDGET);
  const child = createRun({ room, agent: to, objective, requestedBy: parent.requested_by, parentRunId: parent.id, kind: "delegate",
    budget: { maxModelCostUsd: pb.maxModelCostUsd / 2, maxToolCalls: Math.ceil(pb.maxToolCalls / 2), maxAutonomousExternalWrites: 0 }, result: { delegation_context: context ?? null } });
  emit("DELEGATION_CREATED", { workspace_id: parent.workspace_id, room_id: room.id, run_id: parent.id, actor: from.id,
    data: { from: from.id, to: to.id, objective, child_run_id: child.id, return_policy: "result" } });
  postMessage(room.id, { sender: from.id, text: `${from.name} → ${to.name}: ${objective}`, runId: parent.id });
  return { childRunId: child.id };
}

/** Step-aware model routing: a short single-step message runs on the cheap tier, research or long plans on the research tier,
 *  everything else on standard; failures escalate (see generate). An agent pinned to a non-default profile keeps it. */
export function routeProfile(agent: any, run: any) {
  if (agent.model_profile && agent.model_profile !== "standard") return agent.model_profile;
  const brief = J(run.brief, null), steps = brief?.plan?.length ?? 0, o = String(run.objective ?? "");
  if (brief?.profile && run.kind !== "schedule") return brief.profile; // the planning layer already chose (intake.planWork)
  if (brief?.kind === "research" || steps >= 4 || /\b(research|compare|analy[sz]e|itinerary|plan (a|our|my) trip|deep dive)\b/i.test(o)) return "research-standard";
  // The cheap tier only answers small talk; anything that may call tools runs on standard (a live test showed the cheap
  // model narrating "I'll book it, reply approve" instead of calling the tool).
  if (brief && !(brief.plan ?? []).some((p: any) => p.tool) && !(brief.side_effects ?? []).length && o.length < 160 && run.kind !== "schedule") return "fast";
  return "standard";
}

// ---------------- schedules / wake conditions (plan §37) ----------------
const DAYS: Record<string, number[]> = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };
/** Next fire time after `after`. spec: {interval_minutes} | {every: daily|weekdays|weekends|weekly, days?: [0-6], day?, hour, minute?, tz?}. */
export function nextRecurring(spec: { every?: string; hour?: number; minute?: number; day?: number; days?: number[]; interval_minutes?: number; tz?: string }, after: number) {
  if (spec.interval_minutes) return after + Math.max(15, spec.interval_minutes) * 6e4;
  const tz = spec.tz ?? serverTz(), days = spec.days?.length ? spec.days : spec.every === "weekly" ? [spec.day ?? 1] : DAYS[spec.every ?? "daily"] ?? DAYS.daily;
  const z = zoned(after, tz);
  for (let k = 0; k < 8; k++) {
    const t = fromZoned(z.y, z.mo, z.d + k, spec.hour ?? 9, spec.minute ?? 0, tz);
    if (t > after && days.includes(zoned(t, tz).dow)) return t;
  }
  return after + 864e5;
}
export function createSchedule(s: { agent_id: string; room_id: string; kind: string; spec: any; objective: string; created_by?: string | null }) {
  const sid = id("sch");
  const next_at = s.kind === "time" ? s.spec.at : s.kind === "recurring" ? nextRecurring(s.spec, now()) : null;
  exec("insert into schedules (id, agent_id, room_id, kind, spec, objective, next_at, created_by, created_at) values (?,?,?,?,?,?,?,?,?)",
    sid, s.agent_id, s.room_id, s.kind, S(s.spec), s.objective, next_at, s.created_by ?? null, now());
  emit("SCHEDULE_CREATED", { room_id: s.room_id, actor: s.agent_id, data: { schedule_id: sid, kind: s.kind, next_at, objective: s.objective } });
  return one<any>("select * from schedules where id=?", sid);
}
function fireSchedule(s: any, eventText?: string) {
  const room = one<any>("select * from rooms where id=?", s.room_id), agent = one<any>("select * from agents where id=?", s.agent_id);
  if (!room || !agent || agent.status !== "active") return;
  createRun({ room, agent, objective: eventText ? `${s.objective}\n(Triggered by: ${eventText})` : s.objective, requestedBy: s.created_by, kind: "schedule" });
  if (s.kind === "recurring") exec("update schedules set next_at=? where id=?", nextRecurring(J(s.spec), now()), s.id);
  else if (s.kind === "time") exec("update schedules set status='done' where id=?", s.id);
}

// ---------------- worker ----------------
/** One pass of the worker. Returns how much work it did; tests call drain() to run to quiescence. */
/** Fire due timers and timeouts (all runs, or one run's). */
export function processDueWaits(runId?: string) {
  let n = 0;
  const t = now(), only = runId ? " and run_id=?" : "", p = runId ? [runId] : [];
  for (const w of all<any>(`select * from waits where status='open' and wake_at is not null and wake_at<=?${only}`, t, ...p)) n += +resumeWait(w.id);
  for (const w of all<any>(`select * from waits where status='open' and timeout_at is not null and timeout_at<=?${only}`, t, ...p)) {
    if (w.kind === "clarify" || w.kind === "confirm") { // no answer in 72h: drop it rather than guess
      const r = one<any>("select * from runs where id=?", w.run_id);
      cancelRun(w.run_id, "system");
      postMessage(w.room_id, { sender: r.agent_id, runId: r.id, text: `I didn't hear back, so I've set aside: ${J(r.brief)?.goal ?? r.objective}. Just ask again when you're ready.`, targets: replyTargets(w.room_id, r.origin_endpoint_id) });
      n++; continue;
    }
    if (w.kind === "approval") {
      exec("update approvals set status='expired' where id=?", w.wake_key.slice(9));
      emit("APPROVAL_EXPIRED", { room_id: w.room_id, run_id: w.run_id, data: { approval_id: w.wake_key.slice(9) } });
    }
    exec("update waits set status='expired' where id=?", w.id);
    appendStep(w.run_id, "signal", { text: `Timed out: ${w.reason}. Decide what to do next (escalate to the owner if needed).` });
    const r = one<any>("select * from runs where id=?", w.run_id);
    if (r && !one("select 1 from waits where run_id=? and status='open'", r.id)) setStatus(r.id, "queued");
    n++;
  }
  return n;
}

/** One workflow step (Temporal activity body): fire this run's due timers, then step it if it's its turn in the conversation.
 *  Returns what the workflow needs to decide whether to loop, sleep until a timer, or wait for a wake signal. */
export async function advanceRun(runId: string) {
  processDueWaits(runId);
  let r = one<any>("select * from runs where id=?", runId);
  if (!r) return { done: true, status: "missing" };
  if (r.status === "running" && r.updated_at < now() - 15 * 6e4) setStatus(runId, "queued"); // a worker died mid-step: Temporal retried us
  r = one<any>("select * from runs where id=?", runId);
  const busy = r.status === "queued" && one("select 1 from runs where agent_id=? and room_id=? and status='running' and id<>?", r.agent_id, r.room_id, r.id)
    || one("select 1 from runs where agent_id=? and room_id=? and status='queued' and created_at<? and id<>?", r.agent_id, r.room_id, r.created_at, r.id);
  if (r.status === "queued" && !busy) await stepRun(runId);
  r = one<any>("select * from runs where id=?", runId);
  const next = one<any>("select min(coalesce(wake_at, timeout_at)) t from waits where run_id=? and status='open'", runId)?.t ?? null;
  return { done: TERMINAL.includes(r.status), status: r.status as string, blocked: !!busy, nextWakeAt: next as number | null };
}

export async function tick() {
  let n = await channels.processInbound();
  const t = now();
  n += processDueWaits();
  for (const s of all<any>("select * from schedules where status='active' and next_at is not null and next_at<=?", t)) { fireSchedule(s); n++; }
  n += await reservations.checkWatches();
  n += await orders.checkOrders();
  n += await groupkit.checkPolls();
  if (engine.temporal()) return n + (await channels.flushOutbox()); // Temporal workers step the runs
  // Runs step concurrently (a slow model call shouldn't block everyone); stepRun's atomic claim makes this safe.
  // Lease: a run 'running' for 15+ minutes belongs to a dead worker — requeue it (tool fingerprints prevent double writes).
  exec("update runs set status='queued' where status='running' and updated_at<?", t - 15 * 6e4);
  // One run at a time per agent per conversation, in arrival order (a reply can't overtake the request it depends on).
  const busy = new Set(all<any>("select agent_id || room_id k from runs where status='running'").map((r) => r.k));
  const queued = all<any>("select id, agent_id || room_id k from runs where status='queued' order by created_at").filter((r) => !busy.has(r.k) && busy.add(r.k));
  const width = Number(process.env.WORKER_CONCURRENCY ?? 4);
  for (let i = 0; i < queued.length; i += width) await Promise.all(queued.slice(i, i + width).map((r) => stepRun(r.id)));
  n += queued.length;
  n += await channels.flushOutbox();
  return n;
}
export async function drain(max = 50) {
  for (let i = 0; i < max; i++) if (!(await tick())) return i;
  return max;
}
/** Crash recovery: runs left 'running' by a dead process go back to the queue; their tool fingerprints prevent double writes. */
export function recover() {
  const r = exec("update runs set status='queued' where status='running'");
  return r.changes;
}

/** "Why did the agent send this?" — deterministic trace for a message or run (plan §21.5). */
export function trace(eventOrRunId: string) {
  const ev = one<any>("select * from events where id=?", eventOrRunId);
  const runId = ev?.run_id ?? eventOrRunId;
  const run = one<any>("select * from runs where id=?", runId);
  if (!run) return null;
  const events = all<any>("select * from events where run_id=? order by seq", runId).map((e) => ({ ...e, data: J(e.data), actor_name: nameOf(e.actor) }));
  const trigger = run.trigger_event_id ? one<any>("select * from events where id=?", run.trigger_event_id) : null;
  return {
    run: { ...run, budget: J(run.budget), spent: J(run.spent), result: J(run.result) }, agent: nameOf(run.agent_id), requested_by: nameOf(run.requested_by),
    trigger: trigger && { text: J(trigger.data).text, platform: J(trigger.data).platform, by: nameOf(trigger.actor) },
    steps: events,
    approvals: all<any>("select * from approvals where run_id=?", runId).map((a) => ({ ...a, input: J(a.input), decided_by_name: nameOf(a.decided_by) })),
    tool_executions: all<any>("select * from tool_executions where run_id=?", runId).map((x) => ({ ...x, input: J(x.input), result: J(x.result) })),
    children: all<any>("select id, agent_id, objective, status from runs where parent_run_id=?", runId).map((c) => ({ ...c, agent: nameOf(c.agent_id) })),
  };
}
