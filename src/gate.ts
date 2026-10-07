// The completion gate: every reply passes through here before a person sees it. One ordered list of checks, one retry
// ledger (runs.spent.gate), one rule for when a retry is still possible. A check accepts the reply, sends it back to the
// model once with a [CHECK] signal, or — when there's no room left to retry — amends the text with an honest flag.
//
//   leak      → raw tool-call markup in the text               (retry once, else strip)
//   grounding → figures that appear in no tool result/message  (retry once)
//   unbacked  → "I'll book it" with no tool call behind it     (retry once, on the stronger tier)
//   claims    → every claim the plan made, proven by evidence  (job contracts: retry once; plan claims: retry once; else flag)
//
// Claims make "done" checkable for every request, not only the six contracted job kinds: each `done when` line in the brief
// carries its proof — a tool that must have succeeded, N links, N items, or (only for answer quality) the judge model.
import { all, one, J, emit, patchJson } from "./db";
import { structured } from "./model";
import { retrieve } from "./memory";
import { getTool } from "./tools";
import * as jobs from "./jobs";
import * as jev from "./jev";

export interface Claim { text: string; proof: "tool" | "links" | "items" | "reply"; tool?: string; n?: number; soft?: boolean }
export type Verdict = { kind: "retry"; signal: string } | { kind: "deliver"; text: string };
const QUIET = " (This is an internal check — never mention it, apologize, or refer to an earlier attempt. Just reply as if this were your first answer.)";
interface Ledger { leak?: number; ground?: number; unbacked?: number; contract?: number; verify?: number }

const ledgerOf = (run: any): Ledger => J(run.spent, {}).gate ?? {};
const mark = (run: any, k: keyof Ledger) => patchJson("runs", "spent", run.id, (s) => ({ ...s, gate: { ...(s.gate ?? {}), [k]: ((s.gate ?? {})[k] ?? 0) + 1 } }));
/** Retries that mean the model got it wrong (not merely unfinished): the next call goes to the stronger tier. */
export const needsEscalation = (spent: any) => { const g = spent?.gate ?? {}; return !!(g.leak || g.ground || g.unbacked || g.contract); };

// ---------- leak ----------
export const TOOL_MARKUP = /<｜?DSML｜|<\/?tool_calls?>|<\|tool_calls?(_begin)?\|>|<function[=\s]|"tool_calls"\s*:/i;
const TOOL_MARKUP_BLOCK = /<｜?DSML｜tool_calls>[\s\S]*?(<\/｜?DSML｜tool_calls>|$)|<tool_calls?>[\s\S]*?(<\/tool_calls?>|$)|<\|tool_calls?_begin\|>[\s\S]*?(<\|tool_calls?_end\|>|$)|<function[=\s][\s\S]*?(<\/function>|$)/gi;

/** When the model can't write its answer, hand over what it found instead of "ask me again": titles and links from its results. */
function fromResults(run: any) {
  const found: { title?: string; url?: string; snippet?: string }[] = [];
  for (const s of all<any>("select data from run_steps where run_id in (select id from runs where id=? or parent_run_id=?) and type='tool_result' order by id desc", run.id, run.id)) {
    const d = J(s.data, {}); if (!/^web\.(search|fetch)$/.test(d.tool)) continue;
    try { const o = JSON.parse(String(d.content).replace(/^<untrusted[^>]*>\n?|\n?<\/untrusted>$/g, "")); for (const r of o.results ?? []) if (r.url && !found.some((f) => f.url === r.url)) found.push(r); } catch {}
    if (found.length >= 5) break;
  }
  return found.length ? `I ran out of room to write this up properly. What I found so far:\n${found.slice(0, 5).map((r) => `• ${r.title ?? r.url}${r.snippet ? ` — ${String(r.snippet).slice(0, 90)}` : ""}\n  ${r.url}`).join("\n")}\nWant me to go deeper on any of these?`
    : "I couldn't finish writing that up — ask me again and I'll send it.";
}

// ---------- grounding ----------
const FIGURE = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmMbB](?:n|illion)?)?)|(?:\d[\d,]*(?:\.\d+)?\s?%)|(?:\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)|(?:\b\d+\.\d{2,}\b)/g;
const num = (x: string) => { const n = parseFloat(x.replace(/[^\d.]/g, "")); const mult = /b(n|illion)?\b/i.test(x) ? 1e9 : /m(illion)?\b/i.test(x) && !/%/.test(x) ? 1e6 : /k\b/i.test(x) ? 1e3 : 1; return n * mult; };
/** Prices, percentages and amounts in the reply that no tool result, message, memory or the request itself contains (±1%). */
export function ungroundedFigures(run: any, text: string): string[] {
  const figs = [...new Set(String(text).match(FIGURE) ?? [])].filter((f) => num(f) > 0);
  if (!figs.length) return [];
  const seen = [
    ...all<any>("select data from run_steps where run_id in (select id from runs where id=? or parent_run_id=?) and type in ('tool_result','signal')", run.id, run.id).map((r) => J(r.data, {}).content ?? J(r.data, {}).text ?? ""),
    ...all<any>("select data from events where room_id=? and type='message' order by seq desc limit 40", run.room_id).map((r) => J(r.data, {}).text ?? ""),
    String(run.objective ?? ""), ...retrieve(one<any>("select * from rooms where id=?", run.room_id), run.agent_id, run.objective, run.requested_by, 20).map((m: any) => m.text),
  ].join(" ");
  const known = (seen.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => parseFloat(x.replace(/,/g, ""))).filter((n) => n > 0);
  return figs.filter((f) => { const v = num(f); return !known.some((k) => Math.abs(k - v) <= Math.max(0.011 * Math.abs(k), 0.006)); }).slice(0, 8);
}

// ---------- unbacked action ----------
const ACTION_CLAIM = /\b(I['’]ll|I will|I['’]m going to|I['’]ve|I have|going to)\s+(go ahead and\s+)?(book|send|schedule|reserve|create|add|cancel|email|text|order|buy|pay|post|invite)\b|\b(reply|respond|say)\s+["“']?approve\b/i;
// Asking the person to sign off in words ("once approved I'll send", "let me know and I'll send it") when no approval exists: the
// live failure that stranded a Dana email — the model drafted with email.draft, narrated an approval, and "approve" did nothing.
const APPROVAL_ASK = /\b(you can approve|approve (it|this|the draft|to send)|ready to send (when|once|whenever) you|once (you('ve| have)? )?approved?|if you('d| would) like( me)? to send|let me know (if|when|and) .{0,40}\bsend|say the word and|just (confirm|approve|say yes)|reply ["“']?(approve|yes|send)|awaiting your (approval|go-ahead|sign-off)|once you (confirm|give the go-ahead))\b/i;
async function claimsUnbackedAction(runId: string, text: string) {
  if (one("select 1 from approvals where run_id=? and status='pending'", runId)) return false;
  if (APPROVAL_ASK.test(text)) return true; // whatever else succeeded, the send/booking they're being asked to approve doesn't exist
  if (all<any>("select data from run_steps where run_id=? and type='tool_result'", runId).some((s) => {
    const d = J(s.data, {}); return getTool(d.tool)?.risk !== "read" && !/^(FAILED|DENIED|REJECTED|SUPERSEDED)/.test(String(d.content ?? ""));
  })) return false;
  // Nothing backs a claim, so judge the wording: JEV catches phrasings the regex misses ("Done! Invite's out"); regex if JEV is off.
  const p = await jev.noul({ reply: text.slice(0, 2000) }, "Does this reply claim or promise an action (booking, sending, scheduling, ordering, cancelling) as done or about to happen, or ask the user to reply 'approve'?",
    "Claims or promises an action", "Only information, options or questions");
  return p != null ? p >= 0.5 : ACTION_CLAIM.test(text);
}

// ---------- claims ----------
const ACK_FAILURE = /\b(couldn'?t|can'?t|unable|wasn'?t able|not able|didn'?t manage|no (results?|luck)|nothing (came up|found)|I could(n'?t| not) find)\b/i;
const linksIn = (t: string) => new Set(t.match(/https?:\/\/[^\s)\]>]+/g) ?? []).size;
const itemsIn = (t: string) => (t.match(/^\s*(?:\d+[.)]|[•\-*]|#{1,3})\s+\S/gm) ?? []).length;

/** What this run (and its specialists) actually did, from our own records. */
function evidence(run: any) {
  const succeeded = new Set(all<any>("select tool_id from tool_executions where run_id in (select id from runs where id=? or parent_run_id=?) and status='succeeded'", run.id, run.id).map((x) => x.tool_id as string));
  const pending = new Set(all<any>("select tool_id from approvals where run_id=? and status='pending'", run.id).map((x) => x.tool_id as string));
  return { succeeded, pending };
}

/** Each claim against the evidence. Deterministic for tools, links and items; the judge model only for answer-quality claims. */
export async function checkClaims(run: any, claims: Claim[], text: string): Promise<{ missing: Claim[]; judged: boolean }> {
  const ev = evidence(run);
  const missing: Claim[] = [];
  const forJudge: Claim[] = [];
  for (const c of claims) {
    if (c.proof === "tool") { if (!(c.tool && (ev.succeeded.has(c.tool) || ev.pending.has(c.tool)))) missing.push(c); }
    else if (c.proof === "links") { if (linksIn(text) < (c.n ?? 1)) missing.push(c); }
    else if (c.proof === "items") { if (itemsIn(text) < (c.n ?? 1)) missing.push(c); }
    else forJudge.push(c);
  }
  let judged = false;
  if (forJudge.length) {
    const r = await structured<{ missing: string[] }>("judge",
      `You check an AI agent's final reply against its success criteria. Tools that succeeded: ${[...ev.succeeded].join(", ") || "none"}. Return {"missing": [criteria NOT met by the reply]} — empty if all are met. Be strict about substance, not wording.`,
      `Criteria:\n${forJudge.map((c) => `- ${c.text}`).join("\n")}\n\nReply:\n${text}`, () => ({ missing: [] }), run.workspace_id);
    judged = true;
    for (const m of Array.isArray(r.missing) ? r.missing.map(String) : []) { const c = forJudge.find((x) => x.text === m) ?? { text: m, proof: "reply" as const }; missing.push(c); }
  }
  return { missing, judged };
}

// ---------- the gate ----------
/** Run every check on a final reply. `room.retry`: a model call is left (a rewrite is possible); `room.work`: tools are still on too
 *  (the model can still do something about a missing action). */
export async function check(run: any, agent: any, res: { text: string; model?: string }, claims: Claim[], room: { retry: boolean; work: boolean }, live: () => boolean): Promise<Verdict | null> {
  const base = { workspace_id: run.workspace_id, room_id: run.room_id, run_id: run.id, actor: agent.id };
  const g = ledgerOf(run);
  const canRetry = room.work;
  let text = res.text;

  // 1. leak: the model wrote its tool calls as text (seen live from DeepSeek once tools were withheld). Never send that to a person.
  if (TOOL_MARKUP.test(text)) {
    if (!g.leak && room.retry) {
      mark(run, "leak"); emit("TOOL_MARKUP_LEAK", { ...base, data: { model: res.model } });
      return { kind: "retry", signal: `[CHECK] Your last reply contained raw tool-call markup instead of an answer. Reply to the person in plain text with what you found.${QUIET}` };
    }
    text = text.replace(TOOL_MARKUP_BLOCK, "").trim();
    if (!text) { jobs.recordOutcome(run, jobs.outcome(run, "")); return { kind: "deliver", text: fromResults(run) }; } // our own words: nothing to check
  }
  // 2. grounding: figures that appear nowhere in this conversation's tool results, messages or memory — cite or drop.
  if (!g.ground && room.retry) {
    const loose = ungroundedFigures(run, text);
    if (loose.length) {
      mark(run, "ground"); emit("UNGROUNDED_FIGURES", { ...base, data: { figures: loose, model: res.model } });
      return { kind: "retry", signal: `[CHECK] These figures don't appear in any tool result, message or memory here: ${loose.join(", ")}. Get them with a tool and cite the source, or remove them. If you calculated one from sourced numbers, show the calculation in a few words. If you can't source something the person needs, say so plainly and call data.missing.${QUIET}` };
    }
  }
  // 3. unbacked: a reply that promises or claims an action with nothing behind it ("I'll book…", "reply approve").
  if (!g.unbacked && canRetry && await claimsUnbackedAction(run.id, text)) {
    if (!live()) return null;
    mark(run, "unbacked"); emit("UNBACKED_CLAIM", { ...base, data: { text: text.slice(0, 300), model: res.model } });
    return { kind: "retry", signal: `[CHECK] You described an action but didn't call a tool, so nothing happened. If the user asked for it, call the tool now — the platform requests approval automatically when needed (email.send shows them the exact draft and asks; a draft alone is never sent). Never ask the user to reply "approve" yourself. If you can't do it, say so plainly.${QUIET}` };
  }
  if (run.parent_run_id) return { kind: "deliver", text }; // a specialist's findings are checked by its parent

  // 4a. contracted jobs (calendar, reminder, email, …): each requested action must have evidence in our records.
  const job = jobs.outcome(run, text);
  if (job.status === "failed" && !g.contract && canRetry) {
    mark(run, "contract");
    const missing = (job.jobs ?? []).filter((j) => j.status === "failed").map((j) => `${j.job} (${j.evidence})`).join(", ");
    return { kind: "retry", signal: `[CHECK] This request needs ${missing}, but nothing shows it was done. Do each part with the right tool now, or if you can't, say plainly what stopped you — don't reply as if it's done.${QUIET}` };
  }
  jobs.recordOutcome(run, job);
  if (job.status === "failed" && !ACK_FAILURE.test(text)) text = `${text}\n\n(Heads up: I couldn't confirm this actually happened — ${job.evidence}.)`;

  // 4b. the plan's own claims: what "done" meant for this request, each with its proof.
  if (claims.length && ["confirmed", "auto"].includes(run.brief_status)) {
    const { missing } = await checkClaims(run, claims, text);
    if (!live()) return null;
    const acknowledged = ACK_FAILURE.test(text);
    const checks = (g.verify ?? 0) + 1; mark(run, "verify");
    emit("RESULT_CHECKED", { ...base, data: { pass: !missing.length, missing: missing.map((c) => c.text), acknowledged } });
    if (missing.length && !acknowledged) {
      if (checks < 2 && canRetry) return { kind: "retry", signal: `[CHECK] Not done yet. Still missing: ${missing.map((c) => c.text).join("; ")}. Keep working, or explain exactly what's blocking it.${QUIET}` };
      const hard = missing.filter((c) => !c.soft); // a skipped look-up isn't worth alarming the person over; a missing action is
      if (hard.length) text = `${text}\n\n⚠️ Not fully done — still missing: ${hard.map((c) => c.text).join("; ")}`;
    }
  }
  return { kind: "deliver", text };
}
