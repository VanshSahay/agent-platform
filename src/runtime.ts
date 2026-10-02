// Agent runtime: Rooms, Runs, waits, approvals, schedules, delegation (plan §2.4, §2.8, §7, §16, §37).
// Durable by construction: every state change is a DB row, so a crashed process resumes from the last persisted step.
// ponytail: a SQLite-backed run queue + timer table instead of Temporal; one worker process. Move RunWorkflow/RoomWorkflow
// to Temporal when you need multiple workers or > ~50 runs/sec. The run/wait/step model below maps 1:1 onto workflow + signals.
import { all, one, exec, emit, id, now, S, J, tx } from "./db";
import { generate } from "./model";
import { buildContext } from "./context";
import { executeToolCall, TOOLS } from "./tools";
import { extractAfterTurn } from "./memory";
import { structured } from "./model";
import * as channels from "./channels";

export const DEFAULT_BUDGET = { maxModelCostUsd: 0.8, maxToolCalls: 25, maxBrowserMinutes: 10, maxWallClockSeconds: 7 * 86400, maxAutonomousExternalWrites: 3, maxModelCalls: 12 };
const WAIT_STATUS: Record<string, string> = { debounce: "scheduled", approval: "waiting_for_human", verify: "waiting_for_human", reconnect: "waiting_for_human",
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
export function createRoom(r: { workspace_id: string; name: string; kind?: "private" | "shared"; participation?: string; objective?: string; members?: { id: string; kind: "human" | "agent"; role?: string }[] }) {
  const rid = id("room");
  tx(() => {
    exec("insert into rooms (id, workspace_id, name, objective, kind, participation, created_at) values (?,?,?,?,?,?,?)",
      rid, r.workspace_id, r.name, r.objective ?? null, r.kind ?? "shared", r.participation ?? (r.kind === "private" ? "manager" : "mention_only"), now());
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
  const r = one<any>(`select r.* from rooms r where r.kind='private' and r.workspace_id=? and r.status='active'
    and exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?)
    and exists (select 1 from room_members m where m.room_id=r.id and m.principal_id=?)
    and (select count(*) from room_members m where m.room_id=r.id and m.kind='human')=1 order by r.created_at limit 1`, agent.workspace_id, userId, agent.id);
  return r ?? createRoom({ workspace_id: agent.workspace_id, name: `${nameOf(userId)} & ${agent.name}`, kind: "private", participation: "manager",
    members: [{ id: userId, kind: "human" }, { id: agent.id, kind: "agent" }] });
}

// ---------------- messages ----------------
export function postMessage(roomId: string, m: { sender: string; text: string; platform?: string; endpointId?: string | null; externalId?: string; runId?: string;
  approvalId?: string; untrusted?: boolean; targets?: string[] }) {
  const room = one<any>("select * from rooms where id=?", roomId);
  const eid = emit("message", { workspace_id: room.workspace_id, room_id: roomId, run_id: m.runId, actor: m.sender,
    data: { text: m.text, platform: m.platform ?? "web", endpoint_id: m.endpointId ?? null, external_id: m.externalId ?? null, approval_id: m.approvalId ?? null, untrusted: !!m.untrusted } });
  if (m.endpointId) exec("update room_endpoints set last_active_at=? where id=?", now(), m.endpointId);
  if (m.sender.startsWith("agt_")) {
    for (const ep of m.targets ?? []) channels.enqueue(ep, roomId, eid, { text: m.text, agentName: nameOf(m.sender), approvalId: m.approvalId });
    exec("insert into usage (workspace_id, agent_id, kind, qty, ts) values (?,?,?,?,?)", room.workspace_id, m.sender, "channel_messages", (m.targets ?? []).length, now());
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

  // 2. Runs waiting for a message in this room resume instead of starting fresh work.
  for (const w of all<any>("select * from waits where status='open' and wake_key='room_message' and room_id=?", room.id))
    resumeWait(w.id, `${nameOf(i.senderId)} replied: ${i.text}`);

  // 3. Participation policy (plan §15.2): who should respond?
  const agents = roomAgents(room.id);
  for (const a of agents) {
    let respond = false;
    if (room.participation === "manager" || (room.kind === "private" && agents.length === 1)) respond = true;
    else if (mentions(i.text, a.name)) respond = true;
    else if (room.participation === "relevant") {
      const r = await structured<{ relevant: boolean }>("fast", `Should ${a.name} (job: ${a.job}) respond to this group message? Only if it is clearly asking for or about its job. {"relevant": boolean}`,
        i.text, () => ({ relevant: a.job.toLowerCase().split(/\W+/).filter((w: string) => w.length > 4).some((w: string) => i.text.toLowerCase().includes(w)) }), room.workspace_id);
      respond = r.relevant;
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
    const run = createRun({ room, agent: a, objective: i.text, requestedBy: i.senderId, triggerEventId: eventId, originEndpointId: i.endpointId ?? "web", tainted: i.untrusted });
    if (burst) createWait(run, { kind: "debounce", reason: "collecting message burst", wake_at: now() + debounceMs });
    started.push(run.id);
  }

  // 4. Memory write pipeline (scoped, with provenance).
  await extractAfterTurn(room, { id: eventId, text: i.text, sender: i.senderId, senderName: nameOf(i.senderId) ?? "someone" }).catch(() => {});
  return { eventId, started };
}

// ---------------- runs ----------------
export function createRun(r: { room: any; agent: any; objective: string; requestedBy?: string | null; triggerEventId?: string | null; originEndpointId?: string | null;
  kind?: string; parentRunId?: string; budget?: Partial<typeof DEFAULT_BUDGET>; tainted?: boolean; result?: any }) {
  const rid = id("run");
  exec(`insert into runs (id, workspace_id, room_id, agent_id, objective, kind, status, requested_by, parent_run_id, trigger_event_id, origin_endpoint_id, budget, spent, tainted, result, created_at, updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, rid, r.room.workspace_id, r.room.id, r.agent.id, r.objective, r.kind ?? "respond", "queued", r.requestedBy ?? null,
    r.parentRunId ?? null, r.triggerEventId ?? null, r.originEndpointId ?? null, S({ ...DEFAULT_BUDGET, ...r.budget }), S({ cost: 0, toolCalls: 0, externalWrites: 0, modelCalls: 0 }),
    r.tainted ? 1 : 0, r.result ? S(r.result) : null, now(), now());
  emit("RUN_STARTED", { workspace_id: r.room.workspace_id, room_id: r.room.id, run_id: rid, actor: r.agent.id, data: { objective: r.objective, requested_by: r.requestedBy, kind: r.kind ?? "respond" } });
  return one<any>("select * from runs where id=?", rid);
}

export function addSpent(runId: string, d: { cost?: number; toolCalls?: number; externalWrites?: number; modelCalls?: number; tainted?: boolean }) {
  const r = one<any>("select spent, tainted from runs where id=?", runId);
  const s = J(r.spent, {});
  for (const k of ["cost", "toolCalls", "externalWrites", "modelCalls"] as const) s[k] = (s[k] ?? 0) + (d[k] ?? 0);
  exec("update runs set spent=?, tainted=?, updated_at=? where id=?", S(s), r.tainted || d.tainted ? 1 : 0, now(), runId);
}
const setStatus = (runId: string, status: string, extra: { error?: string; result?: any } = {}) => {
  exec("update runs set status=?, error=coalesce(?, error), result=coalesce(?, result), updated_at=?, completed_at=? where id=?",
    status, extra.error ?? null, extra.result ? S(extra.result) : null, now(), ["completed", "failed_terminal", "cancelled"].includes(status) ? now() : null, runId);
};
export const appendStep = (runId: string, type: string, data: any) => exec("insert into run_steps (run_id, type, data, ts) values (?,?,?,?)", runId, type, S(data), now());
export function appendToolResult(runId: string, call: { id: string; name: string }, content: string) {
  appendStep(runId, "tool_result", { callId: call.id, tool: call.name, content });
}

export function createWait(run: any, w: { kind: string; reason: string; owner?: string; wake_key?: string; wake_at?: number; timeout_at?: number; on_timeout?: string }) {
  const wid = id("wait");
  exec("insert into waits (id, run_id, room_id, kind, reason, owner, wake_key, wake_at, timeout_at, on_timeout, created_at) values (?,?,?,?,?,?,?,?,?,?,?)",
    wid, run.id, run.room_id, w.kind, w.reason, w.owner ?? null, w.wake_key ?? null, w.wake_at ?? null, w.timeout_at ?? null, w.on_timeout ?? "resume", now());
  setStatus(run.id, WAIT_STATUS[w.kind] ?? "waiting_for_external");
  emit("RUN_WAITING", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, data: { wait_id: wid, kind: w.kind, reason: w.reason, owner: w.owner } });
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

function pendingCalls(runId: string) {
  const last = one<any>("select data from run_steps where run_id=? and type='assistant' order by id desc limit 1", runId);
  if (!last) return [];
  const calls = J(last.data).toolCalls ?? [];
  const done = new Set(all<any>("select data from run_steps where run_id=? and type='tool_result'", runId).map((s) => J(s.data).callId));
  return calls.filter((c: any) => !done.has(c.id));
}

/** One durable step of the agent loop. Returns when the run completes, fails, or waits. */
export async function stepRun(runId: string) {
  const claimed = exec("update runs set status='running', updated_at=? where id=? and status='queued'", now(), runId);
  if (!claimed.changes) return; // someone else has it, or it's not runnable
  let run = one<any>("select * from runs where id=?", runId);
  const agent = one<any>("select * from agents where id=?", run.agent_id);
  const room = one<any>("select * from rooms where id=?", run.room_id);
  const budget = J(run.budget, DEFAULT_BUDGET);
  const base = { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: agent.id };
  if (agent.status !== "active") return fail(run, "agent is paused");
  if (now() - run.created_at > budget.maxWallClockSeconds * 1000) return fail(run, "run exceeded its wall-clock budget");

  const runCalls = async (calls: any[], allowed: Set<string>) => {
    for (const c of calls) {
      run = one<any>("select * from runs where id=?", runId);
      const r = await executeToolCall(run, agent, room, c, allowed);
      if (r.kind === "result") appendToolResult(run.id, c, r.content);
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
    let res;
    try {
      res = await generate({ profile: agent.model_profile, system: c.system, messages: c.messages, tools: c.tools,
        workspaceId: run.workspace_id, agentId: agent.id, runId: run.id, ctx: c.ctx, escalate: (spent.modelErrors ?? 0) > 0 || i >= budget.maxModelCalls - 2 });
    } catch (e: any) {
      const errs = (spent.modelErrors ?? 0) + 1;
      exec("update runs set spent=json_set(spent, '$.modelErrors', ?) where id=?", errs, run.id);
      emit("MODEL_CALL_FAILED", { ...base, data: { error: e.message, attempt: errs } });
      if (errs >= 3) return fail(run, `model unavailable: ${e.message}`);
      createWait(run, { kind: "retry", reason: "model call failed; retrying", wake_at: now() + 2 ** errs * 1000 });
      return;
    }
    addSpent(run.id, { cost: res.costUsd, modelCalls: 1 });
    appendStep(run.id, "assistant", { text: res.text, toolCalls: res.toolCalls, model: res.model, raw: res.raw });
    emit("MODEL_CALL", { ...base, data: { model: res.model, tool_calls: res.toolCalls.map((t) => t.name), usage: res.usage, cost_usd: res.costUsd } });
    if (!res.toolCalls.length) return complete(run, agent, room, res.text);
    if ((await runCalls(res.toolCalls, c.allowed)) === "wait") return;
  }
  return fail(run, "step limit reached without finishing");
}

/** Structured run classification (plan §7.4), derived from what the run actually did. */
function classify(runId: string, current: string) {
  if (current === "schedule" || current === "delegate") return current;
  const used = all<any>("select data from run_steps where run_id=? and type='assistant'", runId).flatMap((s) => (J(s.data).toolCalls ?? []).map((c: any) => c.name));
  return used.includes("agent.delegate") ? "delegate" : used.includes("reminder.schedule") ? "schedule"
    : used.includes("wait.for_reply") ? "task" : used.length ? "act" : "respond";
}

function complete(run: any, agent: any, room: any, text: string) {
  setStatus(run.id, "completed", { result: { text, ...(J(run.result, {}) ?? {}) } });
  exec("update runs set kind=? where id=?", classify(run.id, run.kind), run.id);
  emit("RUN_COMPLETED", { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: agent.id, data: { text: text.slice(0, 500) } });
  if (run.parent_run_id) {
    // Typed handoff back to the parent (plan §16.2); the child's text is not posted to the room.
    signalEvent(`run:${run.id}`, `${agent.name} finished the delegated task. Result: ${text}`);
    return;
  }
  if (text.trim()) postMessage(room.id, { sender: agent.id, text, runId: run.id, targets: replyTargets(room.id, run.origin_endpoint_id) });
}

function fail(run: any, reason: string) {
  setStatus(run.id, "failed_terminal", { error: reason });
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
  if (decision === "approve" && TOOLS[a.tool_id]?.defaultApproval === "first_time") exec("insert into grants values (?,?,?,?,?)", id("grt"), a.agent_id, a.tool_id, userId, now());
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
  addMember(room.id, to.id, "agent");
  const pb = J(parent.budget, DEFAULT_BUDGET);
  const child = createRun({ room, agent: to, objective, requestedBy: parent.requested_by, parentRunId: parent.id, kind: "delegate",
    budget: { maxModelCostUsd: pb.maxModelCostUsd / 2, maxToolCalls: Math.ceil(pb.maxToolCalls / 2), maxAutonomousExternalWrites: 0 }, result: { delegation_context: context ?? null } });
  emit("DELEGATION_CREATED", { workspace_id: parent.workspace_id, room_id: room.id, run_id: parent.id, actor: from.id,
    data: { from: from.id, to: to.id, objective, child_run_id: child.id, return_policy: "result" } });
  postMessage(room.id, { sender: from.id, text: `${from.name} → ${to.name}: ${objective}`, runId: parent.id });
  return { childRunId: child.id };
}

// ---------------- schedules / wake conditions (plan §37) ----------------
function nextRecurring(spec: { every: string; hour: number }, after: number) {
  const d = new Date(after); d.setMinutes(0, 0, 0); d.setHours(spec.hour);
  while (+d <= after || (spec.every === "weekdays" && (d.getDay() === 0 || d.getDay() === 6))) d.setDate(d.getDate() + 1);
  return +d;
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
export async function tick() {
  let n = await channels.processInbound();
  const t = now();
  for (const w of all<any>("select * from waits where status='open' and wake_at is not null and wake_at<=?", t)) n += +resumeWait(w.id);
  for (const w of all<any>("select * from waits where status='open' and timeout_at is not null and timeout_at<=?", t)) {
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
  for (const s of all<any>("select * from schedules where status='active' and next_at is not null and next_at<=?", t)) { fireSchedule(s); n++; }
  for (const r of all<any>("select id from runs where status='queued' order by created_at")) { await stepRun(r.id); n++; }
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
