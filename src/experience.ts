// What an agent learns from doing: how a kind of task went (a playbook), which sites waste calls, what each person answered when
// asked, and what a group has decided. All deterministic, from our own records — no model writes these. Read back into context
// so the next request starts from experience instead of from scratch.
import { all, one, exec, id, now, S, J, dialect } from "./db";
import { remember } from "./memory";

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const words = (t: string) => (t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w));
const STOP = new Set(["find", "please", "could", "would", "about", "with", "that", "this", "from", "have", "what", "when", "there", "some", "need", "want", "like", "just", "also", "into", "then"]);

/** The run's tool calls in order with their outcome: completions carry no call id, so each is paired with the earliest open request for that tool. */
function timeline(runId: string) {
  const out: { tool: string; input: any; status: string; error?: string }[] = [];
  const open: Record<string, number[]> = {};
  for (const e of all<any>("select type, data from events where run_id=? and type in ('TOOL_CALL_REQUESTED','TOOL_CALL_COMPLETED','TOOL_CALL_FAILED') order by seq", runId)) {
    const d = J(e.data, {});
    if (e.type === "TOOL_CALL_REQUESTED") { out.push({ tool: d.tool, input: d.input ?? {}, status: "running" }); (open[d.tool] ??= []).push(out.length - 1); continue; }
    const i = open[d.tool]?.shift(); if (i == null) continue;
    out[i].status = d.status ?? (e.type === "TOOL_CALL_FAILED" ? "FAILED" : "SUCCEEDED"); out[i].error = d.error;
  }
  return out;
}

/** After a run completes: a compact, factual record of how it went, kept per agent and task shape (latest wins, success count kept). */
/** Did this run end with every check passing? Flagged claims, a failed job contract, a fact mismatch or an unavailable judge all
 *  mean "we don't know it worked", and a playbook learned from that would teach the wrong thing. */
export function verifiedOutcome(run: any) {
  const checked = one<any>("select data from events where run_id=? and type='RESULT_CHECKED' order by seq desc limit 1", run.id);
  if (checked && J(checked.data, {}).pass === false) return false;
  const job = one<any>("select data from events where run_id=? and type='JOB_OUTCOME' order by seq desc limit 1", run.id);
  if (job && J(job.data, {}).ok === false) return false;
  if (one("select 1 from events where run_id=? and type in ('FACT_MISMATCH','JUDGE_UNAVAILABLE','UNBACKED_CLAIM')", run.id)) return false;
  return !J(run.result, {})?.unverified?.length;
}
export function recordPlaybook(run: any) {
  if (run.parent_run_id || run.kind === "schedule") return;
  if (!verifiedOutcome(run)) return; // learn only from runs that provably did the job
  const reqs = timeline(run.id).filter((r) => !/^(plan\.update|memory\.remember|notes\.add|specialists\.run)$/.test(r.tool));
  if (reqs.length < 2) return; // nothing worth remembering about a one-call answer
  const step = (r: any) => {
    const ok = r.status === "SUCCEEDED" || r.status === "PARTIAL";
    const what = r.tool === "web.search" ? `search "${String(r.input?.query ?? "").slice(0, 60)}"` : r.tool === "web.fetch" ? `read ${host(r.input?.url) || "page"}` : r.tool === "browser.task" ? `browser on ${r.input?.site ?? host(r.input?.start_url) ?? "site"}` : r.tool;
    return `${what}${ok ? "" : " ✗"}`;
  };
  const secs = Math.round(((run.updated_at ?? now()) - run.created_at) / 1000);
  const goal = String(J(run.brief, null)?.goal ?? run.objective ?? "").split("\n")[0].slice(0, 120);
  const sig = [...new Set(reqs.map((r) => r.tool))].sort().join("+"); // the task's shape: which tools it took, success or not
  const prior = one<any>("select * from memories where scope_type='agent' and scope_id=? and kind='playbook' and json_extract(source_event_ids, '$[0]')=?", run.agent_id, `sig:${sig}`);
  const times = (prior ? Number(prior.text.match(/done (\d+)×/)?.[1] ?? 1) : 0) + 1;
  const text = `Playbook (done ${times}×, last ${secs}s) for "${goal}": ${reqs.map(step).join(" → ")}`;
  if (prior) { exec("update memories set text=?, created_at=? where id=?", text, now(), prior.id); if (dialect === "sqlite") exec("update memories_fts set text=? where id=?", text, prior.id); return; }
  const mid = id("mem");
  exec("insert into memories (id, workspace_id, scope_type, scope_id, kind, text, source_event_ids, created_by, confidence, created_at) values (?,?,?,?,?,?,?,?,?,?)",
    mid, run.workspace_id, "agent", run.agent_id, "playbook", text, S([`sig:${sig}`, run.id]), "experience", 0.9, now());
  if (dialect === "sqlite") exec("insert into memories_fts (id, text) values (?, ?)", mid, text);
}

/** Sites that keep failing: remembered per workspace so no agent wastes calls on them. */
export function recordSiteFailures(run: any) {
  for (const f of timeline(run.id).filter((r) => r.tool === "web.fetch" && r.status === "FAILED")) {
    const h = host(f.input?.url ?? ""); if (!h) continue;
    exec("insert into memories (id, workspace_id, scope_type, scope_id, kind, text, source_event_ids, created_by, confidence, created_at) values (?,?,?,?,?,?,?,?,?,?)",
      id("mem"), run.workspace_id, "workspace", run.workspace_id, "site", `site:${h} fetch failed${f.error ? `: ${String(f.error).slice(0, 80)}` : ""}`, S([run.id]), "experience", 0.9, now());
  }
}
/** True when a host failed 3+ times in the last week with no success since: the fetch tool refuses up front and says why. */
export function hostBlocked(workspaceId: string, url: string): string | null {
  const h = host(url); if (!h) return null;
  const since = now() - 7 * 864e5;
  const fails = one<any>("select count(*) n, max(created_at) t from memories where workspace_id=? and kind='site' and text like ? and created_at>?", workspaceId, `site:${h} fetch failed%`, since);
  if (!fails || fails.n < 3) return null;
  const okAfter = one("select 1 from events where workspace_id=? and type='TOOL_CALL_COMPLETED' and json_extract(data, '$.tool')='web.fetch' and json_extract(data, '$.status')='SUCCEEDED' and ts>? and json_extract(data, '$.result_summary') like ?", workspaceId, fails.t, `%${h}%`);
  return okAfter ? null : `${h} has blocked or failed ${fails.n} fetches this week — don't retry it; use search snippets or another source.`;
}

/** What the person answered when the agent asked: kept as their preference so it's never asked again. */
export function recordAnswers(run: any, room: any) {
  const b = J(run.brief, null); if (!b || !run.requested_by) return;
  const answers = [...String(run.objective ?? "").matchAll(/^Answer from [^:]+: (.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  const asked: string[] = (b._askedQuestions ?? []);
  if (!answers.length || !asked.length) return;
  const name = one<any>("select name from users where id=?", run.requested_by)?.name ?? "They";
  asked.slice(0, answers.length).forEach((q, i) => remember({ run, room, scope: "user_private", scopeId: run.requested_by, kind: "preference", createdBy: "experience", confidence: 0.85,
    text: `${name}: ${q.replace(/\?\s*$/, "")} → ${answers[i]}` }));
}

/** Group awareness: decisions made here, and who hasn't answered the agent's last question. */
export function groupState(room: any, agentId: string) {
  if (room.kind === "private") return "";
  const decisions = all<any>("select text from memories where scope_type='room' and scope_id=? and kind='decision' order by created_at desc limit 5", room.id).map((m) => `- decided: ${m.text}`);
  const lastQ = one<any>("select seq, ts from events where room_id=? and type='message' and actor=? and json_extract(data, '$.text') like '%?' order by seq desc limit 1", room.id, agentId);
  let silent: string[] = [];
  if (lastQ) {
    const humans = all<any>("select principal_id from room_members where room_id=? and kind='human'", room.id).map((m) => m.principal_id);
    const spoke = new Set(all<any>("select distinct actor from events where room_id=? and type='message' and seq>?", room.id, lastQ.seq).map((e) => e.actor));
    silent = humans.filter((h) => !spoke.has(h)).map((h) => one<any>("select name from users where id=?", h)?.name ?? "someone");
  }
  const lines = [...decisions, silent.length ? `- haven't answered your last question yet: ${silent.join(", ")}` : ""].filter(Boolean);
  return lines.length ? `[GROUP]\n${lines.join("\n")}` : "";
}

/** The requester's own private memories, usable inside a group to help them — never to be repeated to the group. */
export function privateForRequester(room: any, requesterId: string | null | undefined, query: string) {
  if (!requesterId || room.kind === "private") return [];
  const terms = words(query).slice(0, 10);
  const rows = all<any>("select text from memories where scope_type='user_private' and scope_id=? and kind in ('preference','fact') order by created_at desc limit 40", requesterId);
  return rows.filter((m) => !terms.length || terms.some((t) => m.text.toLowerCase().includes(t))).slice(0, 5).map((m) => m.text);
}

/** Playbooks relevant to this request, most recent first. */
export function playbooksFor(agentId: string, objective: string) {
  const terms = words(objective);
  return all<any>("select text from memories where scope_type='agent' and scope_id=? and kind='playbook' order by created_at desc limit 30", agentId)
    .map((m) => m.text as string).filter((t) => terms.filter((w) => t.toLowerCase().includes(w)).length >= Math.min(2, terms.length)).slice(0, 3);
}
