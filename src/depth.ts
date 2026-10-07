// Depth: how hard an agent works, decided when it's designed — before it's deployed — from the jobs it will do.
// Each job gets an effort (quick / standard / deep); the agent gets a level (light / standard / deep) that caps every request:
// model tiers, tool calls, model calls, and whether it cross-checks sources, plus reply-time and
// cost-per-task estimate from real model prices. Internal: people aren't asked to tune it — the agent is set up to do its job.
// The per-request planner (intake.planWork) stays inside it.
import { priceOf, openDefault, MARKUP } from "./billing";
import type { Effort } from "./intake";

export type Level = "light" | "standard" | "deep";
/** Specialist kinds and the tools each may use. A specialist only ever gets the ones its agent already has. */
export const SPECIALISTS: Record<string, string[]> = {
  research: ["web.search", "web.fetch", "market.quote", "market.history", "weather.forecast", "sports.scores", "drive.search", "drive.read", "files.read"],
  calendar: ["calendar.list_events", "calendar.find_free_time", "contacts.search", "email.search"],
  browser: ["browser.task", "web.fetch"],
};
// Which kind of look-up a job involves — two different kinds, or deep work, is what makes parallel specialists worth it.
const KIND_OF: [string, RegExp][] = [
  ["research", /\b(research|compar|analy|find|search|look up|news|prices?|options|recommend|itinerar|trip|venues?|restaurants?|hotels?)/i],
  ["calendar", /\b(calendar|schedul|meetings?|availability|free time|a time|contacts?|inbox|e-?mails?)\b/i],
  ["browser", /\b(websites?|online|book(ing)?s?|reserv|forms?|portal|checkout|order)\b/i],
];
export interface JobDepth { job: string; effort: Effort; why: string }
export interface Depth {
  level: Level; jobs: JobDepth[]; why: string; overridden?: boolean;
  specialists: boolean;                 // may this agent split a request into parallel specialists? (each request still decides)
  max_tool_calls: number; max_model_calls: number; cross_check: boolean;
  models: Record<Effort, string>;
  est_cost_usd: Record<Effort, number>; reply_time: Record<Effort, string>;
}

export const LEVELS: Record<Level, { max_tool_calls: number; max_model_calls: number; cross_check: boolean; label: string; blurb: string }> = {
  light: { max_tool_calls: 4, max_model_calls: 8, cross_check: false, label: "Light", blurb: "Quick answers and simple actions. Never goes on long research runs." },
  standard: { max_tool_calls: 12, max_model_calls: 18, cross_check: false, label: "Standard", blurb: "Looks things up and takes a few actions per request." },
  deep: { max_tool_calls: 30, max_model_calls: 40, cross_check: true, label: "Deep", blurb: "Can research, compare and plan: reads several sources and cross-checks before answering." },
};
const RANK: Record<Effort, number> = { quick: 0, standard: 1, deep: 2 };
const LEVEL_OF: Record<Effort, Level> = { quick: "light", standard: "standard", deep: "deep" };

const DEEP = /\b(research|compar(e|ing|ison)|analy[sz]|investigat|due diligence|itinerar|plan (a|an|the|our|my)? ?(trip|vacation|holiday|wedding|event|party|launch)|recommend|find the best|evaluat|assess|deep dive|report on|brief(ing)? on|summari[sz]e (the|all|every)|why (it|they|did)|pros and cons|strateg)/i;
const QUICK = /\b(remind(ers?|s)?|lists?|grocer(y|ies)|shopping|to-?dos?|polls?|votes?|voting|rsvps?|split(s|ting)?|owes?|expenses?|tall(y|ies)|who'?s (in|bringing)|scores?|weather|forecasts?|price of|quotes?|check(s|ing)? off|counts?|track (who|what)|nudges?|logs?)\b/i;

/** Effort for one job, with the reason in plain words. */
export function classifyJob(job: string): JobDepth {
  if (DEEP.test(job)) return { job, effort: "deep", why: "needs research or comparison across sources" };
  if (QUICK.test(job)) return { job, effort: "quick", why: "a quick lookup or a simple update" };
  return { job, effort: "standard", why: "a few lookups or actions" };
}

// Rough per-task shape used for estimates: model calls and tokens per call (measured from live runs: 3–8 calls typical).
const SHAPE: Record<Effort, { calls: number; tin: number; tout: number }> = {
  quick: { calls: 2, tin: 3000, tout: 300 }, standard: { calls: 5, tin: 6000, tout: 600 }, deep: { calls: 14, tin: 12000, tout: 900 },
};
const TIER: Record<Effort, string> = { quick: "fast", standard: "standard", deep: "research-standard" };
function estimate(effort: Effort) {
  const p = priceOf(openDefault(TIER[effort])) ?? [0.3, 0.6];
  const s = SHAPE[effort];
  return Math.round(s.calls * ((s.tin * p[0] + s.tout * p[1]) / 1e6) * MARKUP() * 10000) / 10000;
}

/** Decide depth from the agent's jobs (and routines). `forced` keeps a level the person chose. */
export function assessDepth(jobs: string[], routines: { objective: string }[] = [], forced?: Level): Depth {
  const all = [...jobs, ...routines.map((r) => r.objective)].filter((x) => String(x ?? "").trim());
  const per = (all.length ? all : ["answer questions"]).map(classifyJob);
  const top = per.reduce<Effort>((m, j) => (RANK[j.effort] > RANK[m] ? j.effort : m), "quick");
  const level = forced ?? LEVEL_OF[top];
  const cap = LEVELS[level];
  const deepOnes = per.filter((j) => j.effort === "deep").map((j) => `“${j.job}”`);
  const why = forced ? `Set to ${cap.label} by you.`
    : top === "deep" ? `Most requests are quick, but ${deepOnes.slice(0, 2).join(" and ")} need${deepOnes.length === 1 ? "s" : ""} real research — so it can go deep when asked, and stays fast otherwise.`
    : top === "standard" ? "Its jobs need a few lookups or actions, but no long research runs."
    : "Everything it does is quick: lists, reminders, tallies and lookups. It answers in seconds and costs almost nothing.";
  // Parallel specialists cost more model calls; worth it only for deep work or jobs spanning different kinds of look-up. Never light.
  const kinds = new Set(all.flatMap((j) => KIND_OF.filter(([, re]) => re.test(j)).map(([k]) => k)));
  const specialists = level !== "light" && (level === "deep" || kinds.size >= 2);
  return {
    level, jobs: per, why, specialists, ...(forced ? { overridden: true } : {}),
    max_tool_calls: cap.max_tool_calls, max_model_calls: cap.max_model_calls, cross_check: cap.cross_check,
    models: { quick: "fast", standard: "standard", deep: level === "deep" ? "research-standard" : "standard" },
    est_cost_usd: { quick: estimate("quick"), standard: estimate("standard"), deep: estimate("deep") },
    reply_time: { quick: "a few seconds", standard: "under a minute", deep: "2–5 minutes (with an 'on it' first)" },
  };
}

/** The most a single request may do for this agent: deep requests on a light agent are capped, budgets stay within its level. */
export function clampEffort(effort: Effort, depth?: Depth | null): Effort {
  if (!depth) return effort;
  const ceiling: Effort = depth.level === "light" ? "quick" : depth.level === "standard" ? "standard" : "deep";
  // A light agent still gets "standard" for anything needing a tool or two — just never a deep run.
  const max = Math.max(RANK[ceiling], depth.level === "light" ? RANK.standard : 0);
  return RANK[effort] > max ? (Object.keys(RANK) as Effort[]).find((e) => RANK[e] === max)! : effort;
}

/** Standing guidance the agent reads, matching its level. */
export function depthInstructions(d: Depth) {
  return d.level === "deep"
    ? "How thorough to be: quick questions get quick answers. For research, comparisons or plans, work like an analyst: search more than once, read at least 3 good sources, cross-check key facts and numbers, and cite them. Say what you couldn't verify."
    : d.level === "standard" ? "How thorough to be: look things up when needed (one or two sources), then answer. Don't start long research runs; if something needs deep research, say so."
    : "How thorough to be: keep it quick — answer from what you have or one lookup. Don't research; if something needs real digging, say it's beyond what you're set up for.";
}
