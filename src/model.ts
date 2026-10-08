// Provider-neutral ModelGateway (plan §8). Canonical history is our normalized Msg[]; provider payloads are built per call.
import Anthropic from "@anthropic-ai/sdk";
import { one, unseal, recordUsage } from "./db";
import * as billing from "./billing";

export interface ToolCall { id: string; name: string; input: any }
export interface Msg { role: "user" | "assistant" | "tool"; content: string; toolCalls?: ToolCall[]; toolCallId?: string; toolName?: string; raw?: any; model?: string }
export interface ToolSpec { name: string; description: string; input_schema: any }
export interface ModelRequest {
  profile: string; system: string; messages: Msg[]; tools?: ToolSpec[];
  workspaceId?: string; agentId?: string; runId?: string; escalate?: boolean; maxTokens?: number;
  reasoning?: "off" | "low" | "default"; // hidden "thinking": off for planning/quick answers (10x faster), low for routine tool use
  ctx?: LocalCtx; // structured context, used by the offline heuristic model
}
export interface ModelResult { text: string; toolCalls: ToolCall[]; model: string; usage: { input: number; output: number }; costUsd: number; byok: boolean; raw?: any }

export const isProduction = () => process.env.NODE_ENV === "production" || process.env.PRODUCTION === "1";
// Tests swap the model for a scripted one.
export const hooks: { model: null | ((req: ModelRequest) => Partial<ModelResult>) } = { model: null };

const PRICE: Record<string, [number, number]> = { // $ per 1M tokens in/out
  "claude-haiku-4-5": [1, 5], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20], "claude-fable-5-1": [10, 50],
};
const wire = (n: string) => n.replace(/\./g, "__");
const unwire = (n: string) => n.replace(/__/g, ".");

export const PROVIDERS = ["anthropic", "openai", "openrouter", "custom"] as const;
const BASE: Record<string, string> = { openai: "https://api.openai.com/v1", openrouter: "https://openrouter.ai/api/v1" };
export const platformKey = (provider: string) => ({ anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, openrouter: process.env.OPENROUTER_API_KEY }as Record<string, string | undefined>)[provider];

/** Credits mode uses only platform keys (billed); BYOK mode uses only the workspace's own keys (never billed). */
function keyFor(provider: string, workspaceId?: string): { key: string; base?: string; byok: boolean } | null {
  const mode = workspaceId ? billing.aiSettings(workspaceId).mode : "credits";
  if (mode === "byok") {
    const row = one<{ key_enc: string }>("select key_enc from provider_keys where workspace_id=? and provider=?", workspaceId, provider);
    if (!row) return null;
    const v = unseal<any>(row.key_enc);
    return typeof v === "string" ? { key: v, byok: true } : { key: v.key ?? "", base: v.base_url, byok: true };
  }
  const env = platformKey(provider);
  return env ? { key: env, byok: false } : null;
}
export const hasAnyModel = (workspaceId?: string) => PROVIDERS.some((p) => keyFor(p, workspaceId));

async function callAnthropic(model: string, key: string, req: ModelRequest) {
  const client = new Anthropic({ apiKey: key });
  const messages: any[] = [];
  const push = (role: string, block: any) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(block); else messages.push({ role, content: [block] });
  };
  for (const m of req.messages) {
    if (m.role === "user") push("user", { type: "text", text: m.content });
    else if (m.role === "tool") push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
    else if (m.raw && m.model === `anthropic:${model}`) messages.push({ role: "assistant", content: m.raw }); // replay unchanged (preserved thinking)
    else {
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: wire(c.name), input: c.input });
      messages.push({ role: "assistant", content });
    }
  }
  const haiku = model.startsWith("claude-haiku");
  const res: any = await client.beta.messages.create({
    model, max_tokens: req.maxTokens ?? 16000, system: req.system, messages,
    tools: req.tools?.map((t) => ({ name: wire(t.name), description: t.description, input_schema: t.input_schema })),
    ...(haiku ? {} : { output_config: { effort: "medium" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
  } as any);
  if (res.stop_reason === "refusal") throw new Error(`model refused (${res.stop_details?.category ?? "unknown"})`);
  const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const toolCalls = res.stop_reason === "max_tokens" ? [] : res.content.filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ id: b.id, name: unwire(b.name), input: b.input }));
  const [pi, po] = PRICE[model] ?? [3, 15];
  const usage = { input: res.usage.input_tokens, output: res.usage.output_tokens };
  return { text, toolCalls, usage, costUsd: (usage.input * pi + usage.output * po) / 1e6, raw: res.content };
}

/** Any OpenAI-compatible Chat Completions API: OpenAI, OpenRouter (open-source models), Together, Groq, Ollama, vLLM… */
/** Reasoning per tier (measured: the fast model took 11s and ~1,100 tokens to plan one request with thinking on, 1.6s and ~110 off).
 *  Escalations keep the model's default: that's when thinking pays for itself. */
function thinking(req: ModelRequest) {
  const mode = req.reasoning ?? (req.escalate ? "default" : req.profile === "fast" ? "off" : req.profile === "standard" ? "low" : "default");
  return mode === "off" ? { reasoning: { enabled: false } } : mode === "low" ? { reasoning: { effort: "low" } } : {};
}
async function callOpenAI(provider: string, model: string, k: { key: string; base?: string }, req: ModelRequest) {
  const base = (k.base ?? BASE[provider]).replace(/\/$/, "");
  if (provider === "custom" && !process.env.ALLOW_PRIVATE_MODEL_URLS) await (await import("./tools")).assertPublicUrl(base); // admin-supplied URL: no SSRF into our network
  const messages: any[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "tool") messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content || null,
      tool_calls: m.toolCalls?.length ? m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: wire(c.name), arguments: JSON.stringify(c.input) } })) : undefined });
    else messages.push({ role: "user", content: m.content });
  }
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS ?? 120000)),
    headers: { ...(k.key ? { authorization: `Bearer ${k.key}` } : {}), "content-type": "application/json", ...(provider === "openrouter" ? { "x-title": "agents" } : {}) },
    body: JSON.stringify({ model, messages, max_tokens: req.maxTokens ?? 4096, ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: wire(t.name), description: t.description, parameters: t.input_schema } })) } : {}),
      // OpenRouter: report real cost, and only route to providers that support every parameter we send (tool calling).
      ...(provider === "openrouter" ? { usage: { include: true }, ...(req.tools?.length ? { provider: { require_parameters: true } } : {}), ...thinking(req) } : {}) }),
  });
  if (!r.ok) throw new Error(`${provider} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j: any = await r.json(), msg = j.choices?.[0]?.message;
  if (!msg) throw new Error(`${provider}: empty response`);
  const usage = { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 };
  const [pi, po] = billing.priceOf(`${provider}:${model}`) ?? [0, 0];
  return {
    text: msg.content ?? "", usage, costUsd: typeof j.usage?.cost === "number" ? j.usage.cost : (usage.input * pi + usage.output * po) / 1e6,
    // A malformed tool call from a smaller open model throws here, so the next model in the chain gets a turn.
    toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, name: unwire(c.function.name), input: JSON.parse(c.function.arguments || "{}") })),
  };
}

let warned = false;
export async function generate(req: ModelRequest): Promise<ModelResult> {
  if (hooks.model) {
    const r = hooks.model(req);
    return { text: "", toolCalls: [], model: "test", usage: { input: 0, output: 0 }, costUsd: 0, byok: false, ...r };
  }
  const p = one<any>("select * from model_profiles where name=?", req.profile) ?? one<any>("select * from model_profiles where name='standard'");
  // The workspace's own pick for this profile goes first; open models on OpenRouter are the last resort.
  const picked = req.workspaceId ? billing.aiSettings(req.workspaceId).models[p.name] : undefined;
  const chain = [...new Set([picked, req.escalate && p.escalation_model, req.escalate && billing.openDefault("escalation"), p.primary_model, p.fallback_model, billing.openDefault(req.profile), billing.openDefault(p.name)].filter(Boolean) as string[])];
  const errors: string[] = [];
  for (const spec of chain) {
    const i = spec.indexOf(":"), provider = spec.slice(0, i), model = spec.slice(i + 1); // model ids may contain ':' (llama3.1:8b)
    const k = keyFor(provider, req.workspaceId);
    if (!k) continue;
    if (!k.byok && req.workspaceId && !billing.canSpend(req.workspaceId)) { errors.push("out of AI credits"); break; } // every caller, not just runs
    try {
      const r = provider === "anthropic" ? await callAnthropic(model, k.key, req) : await callOpenAI(provider, model, k, req);
      const out = { ...r, model: spec, byok: k.byok };
      if (req.workspaceId) {
        const billed = k.byok ? 0 : r.costUsd * billing.MARKUP();
        billing.charge(req.workspaceId, billed);
        recordUsage({ workspace_id: req.workspaceId, agent_id: req.agentId, run_id: req.runId, kind: "model_input_tokens", qty: r.usage.input, cost_usd: billed, byok: k.byok });
        recordUsage({ workspace_id: req.workspaceId, agent_id: req.agentId, run_id: req.runId, kind: "model_output_tokens", qty: r.usage.output, byok: k.byok });
      }
      return out;
    } catch (e: any) { errors.push(`${spec}: ${e.message}`); }
  }
  if (errors.length) throw new Error(`all models failed: ${errors.join("; ")}`);
  if (req.workspaceId && billing.aiSettings(req.workspaceId).mode === "byok") throw new Error("no model key for this workspace — add one in Settings → AI, or switch to platform credits");
  // Production never passes the offline keyword planner off as an agent: fail loudly instead (demo/dev/tests keep it).
  if (isProduction()) throw new Error("no AI model is configured (set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY)");
  if (!warned) { console.warn("[model] no provider keys configured; using offline heuristic model"); warned = true; }
  return { ...localAgent(req), model: "local:heuristic", usage: { input: 0, output: 0 }, costUsd: 0, byok: false };
}

/** Ask a model for JSON; fall back to a deterministic heuristic offline or on parse failure. */
export async function structured<T>(profile: string, instruction: string, input: string, fallback: () => T, workspaceId?: string): Promise<T> {
  return (await structuredWith(profile, instruction, input, fallback, workspaceId)).value;
}
/** Same, but says whether the model answered ("model"), nothing is configured ("offline"), or the model failed and the
 *  keyword fallback stood in ("fallback") — callers that decide things (plans, verdicts) must not treat the last as the first. */
export async function structuredWith<T>(profile: string, instruction: string, input: string, fallback: () => T, workspaceId?: string): Promise<{ value: T; source: "model" | "offline" | "fallback"; error?: string }> {
  if (hooks.model || !hasAnyModel(workspaceId)) return { value: fallback(), source: "offline" };
  try {
    const r = await generate({ profile, workspaceId, system: `${instruction}\nRespond with a single JSON object and nothing else.`, messages: [{ role: "user", content: input }], maxTokens: 2000, reasoning: "off" });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return { value: fallback(), source: "fallback", error: "no JSON in the model's reply" };
    return { value: { ...fallback(), ...JSON.parse(m[0]) }, source: "model" };
  } catch (e: any) { console.warn(`[model] structured call failed (${profile}): ${String(e.message).slice(0, 160)}`); return { value: fallback(), source: "fallback", error: String(e.message).slice(0, 200) }; }
}

// ---------------- offline heuristic model ----------------
// ponytail: keyword planner so the product works end-to-end with no API key (demo, CI, evals baseline). Real judgment needs a real model.
export interface LocalCtx {
  agentName: string; speaker?: string; objective: string; tools: string[]; roomId?: string;
  agents: string[]; openTasks: { title: string; owner: string; status: string }[]; recentAgentReplies: string[]; memories: string[];
}

// Domain modules (reservations, group orders...) plug their own intents into the offline planner.
export type Step = { name: string; input: any };
export const extraPlanners: ((text: string, c: Pick<LocalCtx, "tools" | "agents" | "speaker" | "agentName" | "roomId">) => { steps: Step[]; exclusive?: boolean })[] = [];
export const extraChains: ((objective: string, last: Msg, c: LocalCtx) => Step | null)[] = [];
export const extraSummaries: Record<string, (j: any) => string> = {};

export function plan(text: string, c: Pick<LocalCtx, "tools" | "agents" | "speaker" | "agentName" | "roomId">) {
  for (const p of extraPlanners) { const r = p(text, c); if (r.exclusive && r.steps.length) return r.steps; }
  // One line: a follow-up correction is appended on a new line, and "$"-anchored patterns (reminders) must still see the whole ask.
  const t = text.toLowerCase().replace(/\s*\n+\s*/g, " "), has = (n: string) => c.tools.includes(n), out: { name: string; input: any }[] = [];
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)?.at(-1); // latest wins (follow-up corrections append)
  const subjectOf = () => text.match(/about (.+?)(?=\s+(?:and|then|on my|to my|in my|by|before|after|for)\b|[.,!?\n]|$)/i)?.[1]?.trim() ?? "Quick follow-up";
  const dontContact = text.match(/(?:don'?t|do not) (?:contact|email|message|text|reach out to) ([A-Z][a-z]+)/);
  const ask = text.match(/\bask (\w+) to ([^.!?]+)/i);
  const delegateTo = ask && c.agents.find((a) => a.toLowerCase() === ask[1].toLowerCase() && a !== c.agentName);

  if (dontContact && has("task.create"))
    out.push({ name: "task.create", input: { title: `${dontContact[1]} follow-up`, owner: c.speaker ?? "human", agent_action: "blocked", subject: dontContact[1] } });
  const fu = text.match(/take care of (?:the )?([^,.]+?follow-ups?)/i) ?? text.match(/\b(follow up (?:with|on) [^,.]+)/i);
  if (fu && has("task.create")) out.push({ name: "task.create", input: { title: fu[1].trim(), owner: "agent" } });
  if (delegateTo && has("agent.delegate")) out.push({ name: "agent.delegate", input: { agent: delegateTo, objective: ask![2].trim() } });

  const watch = t.match(/\bwatch\s+(?:for\s+)?([a-z0-9.-]+\.(?:com|net|org|co|io|app)|ticketmaster|stubhub|booking|airbnb|resy|opentable)\b\s*(?:for\s+)?(.+)/);
  if (watch && has("watch.site") && !/\b(table|restaurant)\b/.test(watch[2])) {
    const site = watch[1].includes(".") ? watch[1] : `${watch[1]}.com`;
    const what = watch[2].split(/[,—–-]|\bopens\b|\btell me\b/)[0].trim();
    const price = t.match(/under \$?(\d+)/)?.[1], qty = t.match(/\b(\d+)\s+(?:tickets?|seats?|rooms?|spots?)\b/)?.[1] ?? t.match(/\b(\d+)\s+under\b/)?.[1];
    out.push({ name: "watch.site", input: { what, url: `https://www.${site}/`, ...(price ? { max_price: Number(price) } : {}), ...(qty ? { quantity: Number(qty) } : {}), action: /\b(book|buy|grab|get) (it|them)\b/.test(t) ? "act" : "notify" } });
  }
  const planM = text.match(/^(?:plan|objective)(?: for)?[:\s]+([^:\n]+?)\s*[:\u2014-]\s*(.+)$/is);
  if (planM && has("objective.create")) out.push({ name: "objective.create", input: { title: planM[1].trim(), steps: planM[2].split(/\s*(?:;|\bthen\b|\d+\.)\s*/).map((x) => x.trim()).filter(Boolean).map((x) => ({ title: x.replace(/[.,]+$/, "") })) } });
  else if (/\bwhere are we\b|\bstatus of the plan\b/i.test(text) && has("objective.status")) out.push({ name: "objective.status", input: {} });
  const scam = text.match(/\b(?:is this (?:real|legit|a scam)|scam\??|real or (?:a )?scam)\b[\s:?-]*(.*)$/is);
  if (scam && has("scam.check")) out.push({ name: "scam.check", input: { text: (scam[1] || text).replace(/^["\u201c]|["\u201d]$/g, "").trim() || text } });
  if (/\b(ask me (?:one|a) question about my life|interview me|story prompt|next (?:story )?question)\b/i.test(text) && has("story.prompt")) out.push({ name: "story.prompt", input: {} });
  if (/\b(haven'?t heard from|gone quiet|lost touch|who should i (?:call|reach out to)|friends i'?ve (?:lost|not))\b/i.test(text) && has("people.quiet")) out.push({ name: "people.quiet", input: {} });
  if (/\b(bills?|letters?|statements?|invoices?|paperwork|medication list)\b/i.test(text) && /\b(find|where|show|what did|look up|last)\b/i.test(text) && has("docs.find")) out.push({ name: "docs.find", input: { query: text.replace(/^.*?\b(find|show|where'?s|look up)\b\s*/i, "").replace(/[?.!]+$/, "").slice(0, 80) } });
  const story = text.match(/^(?:keep|save|remember) (?:this|the) (?:story|recipe|memory)[:\s-]+(.+)/is);
  if (story && has("story.add")) out.push({ name: "story.add", input: { title: story[1].split(/[.\n]/)[0].slice(0, 60), text: story[1].trim() } });
  else if (/\b(?:stor(?:y|ies)|recipe|memor(?:y|ies)) (?:about|of|from)\b/i.test(text) && has("story.search")) out.push({ name: "story.search", input: { query: text.replace(/.*\b(?:about|of|from)\s+/i, "").replace(/[?.!]+$/, "") } });
  const rem = t.match(/remind (?:me|us)(?: to)? (.+?)(?: in (\d+) (minute|hour|day)s?| tomorrow|$)/);
  const daily = t.match(/every (?:day|morning|weekday)(?: at (\d{1,2}))?/);
  const weekly = t.match(/every (sun|mon|tue|wed|thu|fri|sat)[a-z]*(?: (morning|evening|night))?(?: at (\d{1,2}))?(?:,|\s)\s*(.+)/);
  if ((rem || daily || weekly) && has("reminder.schedule")) {
    const unit = { minute: 1, hour: 60, day: 1440 }[rem?.[3] as "minute"] ?? 0;
    const work = /\b(suggest|find|check|look|search|summar|tell me|what)/.test(t); // a standing job the agent does, not a line it repeats
    out.push({ name: "reminder.schedule", input: weekly && !rem
      ? { text: weekly[4].trim(), recurring: "weekly", days: [weekly[1]], hour: Number(weekly[3] ?? (weekly[2] === "evening" || weekly[2] === "night" ? 18 : 9)), ...(work ? { deliver: "task" } : {}) }
      : daily
      ? { text: rem?.[1] ?? text, recurring: "daily", hour: Number(daily[1] ?? 9), ...(work && !rem ? { deliver: "task" } : {}) }
      : { text: rem![1], in_minutes: rem![2] ? Number(rem![2]) * unit : t.includes("tomorrow") ? 1440 : 60 } });
  }
  const remember = text.match(/^(?:please )?(?:remember|note)(?: that)? (.+)/i) ?? text.match(/\b((?:we|i) (?:follow|root for|support|cheer for) .+)/i);
  if (remember && has("memory.remember"))
    out.push({ name: "memory.remember", input: { text: remember[1], scope: /\b(team|everyone|workspace)\b/i.test(text) ? "workspace" : "room" } });

  const file = text.match(/\(file_id: (fil_\w+)\)/)?.[1];
  if (file && has("files.read")) out.push({ name: "files.read", input: { file_id: file } });
  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (url && has("web.fetch")) out.push({ name: "web.fetch", input: { url } });
  else if (/\b(search|find|research|look up|compare|options?|hotels?|flights?|prices?|latest|news)\b/.test(t) && !/\bfind (a )?time\b/.test(t) && !(has("docs.find") && /\b(bills?|letters?|statements?|invoices?|paperwork|medication list)\b/.test(t)) && !(has("story.search") && /\b(stor(?:y|ies)|recipes?) (about|of|from)\b/.test(t)) && !rem && has("web.search"))
    out.push({ name: "web.search", input: { query: text.replace(/^@?\w+[,:]\s*/, "").slice(0, 200) } });

  // Live data tools (sports, markets, weather): the offline planner picks the obvious call.
  const LEAGUE_OF: [RegExp, string][] = [[/\b(nba|lakers|warriors|celtics|knicks|bulls|heat|nets|suns|bucks)\b/, "nba"], [/\b(mlb|dodgers|yankees|mets|braves|red sox|cubs|giants|padres)\b/, "mlb"],
    [/\b(nfl|chiefs|eagles|cowboys|saints|niners|49ers|packers|bills)\b/, "nfl"], [/\b(nhl|rangers|bruins|maple leafs|lightning|flyers)\b/, "nhl"],
    [/\b(premier league|epl|arsenal|chelsea|liverpool|man(chester)? (city|united)|tottenham)\b/, "epl"], [/\b(champions league|ucl)\b/, "ucl"], [/\b(mls|inter miami|lafc)\b/, "mls"], [/\b(f1|formula 1|grand prix)\b/, "f1"]];
  const league = LEAGUE_OF.find(([re]) => re.test(t))?.[1];
  if (league && has("sports.scores") && /\b(scores?|win|won|lose|lost|beat|game|play|playing|match|next|when|watch|result)\b/.test(t) && !remember) {
    const team = t.match(LEAGUE_OF.find(([, l]) => l === league)![0])?.[0];
    out.push({ name: "sports.scores", input: { league, ...(team && team !== league ? { team } : {}), date: /\b(last night|yesterday)\b/.test(t) ? "yesterday" : "today", days: /\b(next|when|upcoming)\b/.test(t) ? 10 : 1 } });
  }
  const tickers = [...new Set(text.match(/\b[A-Z]{2,5}(?:-USD)?\b/g) ?? [])].filter((x) => !["I", "AM", "PM", "OK", "US", "USA", "ET", "TV", "NBA", "NFL", "MLB", "NHL"].includes(x));
  if (has("market.quote") && (tickers.length || /\b(stocks?|portfolio|market)\b/.test(t)) && /\b(price|doing|up|down|quote|stocks?|portfolio|market|today)\b/.test(t))
    out.push({ name: "market.quote", input: { symbols: tickers.length ? tickers.slice(0, 10) : ["^GSPC"] } });
  const wx = text.match(/\b(?:weather|rain|forecast|snow)\b.*?\bin ([A-Z][\w .'-]+?)(?:[?.!,]|$| this| next| on| tomorrow)/i);
  if (has("weather.forecast") && /\b(weather|rain|forecast|snow|temperature)\b/.test(t)) out.push({ name: "weather.forecast", input: { place: wx?.[1]?.trim() ?? "New York", days: 5 } });

  if (/\b(calendar|agenda|meetings?)\b/.test(t) && !rem) {
    if (/\b(book|create|add|set up|schedule)\b/.test(t) && has("calendar.create_event"))
      out.push({ name: "calendar.create_event", input: { title: subjectOf(), start_in_hours: 24, duration_minutes: 30 } });
    else if (has("calendar.list_events")) out.push({ name: "calendar.list_events", input: { days: 7 } });
  }
  if (/\b(free|availability|available|find a time|when can (we|i)|open slots?)\b/.test(t) && has("calendar.find_free_time"))
    out.push({ name: "calendar.find_free_time", input: { days: 5, duration_minutes: Number(t.match(/(\d+)[- ]?min/)?.[1] ?? 30) } });
  const doc = text.match(/\b(?:find|look for|search for|pull up|open|read)\s+(?:the |my |our )?(.+?)\s+(?:doc|document|file|notes|deck|spreadsheet)\b/i);
  if (doc && has("drive.search")) out.push({ name: "drive.search", input: { query: doc[1].replace(/^(a|an)\s+/i, "") } });
  const named = text.match(/\b(?:[Ee]-?mail|[Mm]essage|[Ww]rite to)\s+([A-Z][a-z]+)\b/)?.[1];
  if (!email && named && has("contacts.search") && /\b(email|send|write|message)\b/.test(t)) out.push({ name: "contacts.search", input: { query: named } });
  if (email && /\b(email|send|write|reply|message)\b/.test(t)) {
    const draft = /\bdraft\b/.test(t);
    const tool = draft ? "email.draft" : "email.send";
    if (has(tool)) out.push({ name: tool, input: { to: [email], subject: subjectOf(), body: text } });
  }
  return [...out, ...extraPlanners.flatMap((p) => { const r = p(text, c); return r.exclusive ? [] : r.steps; })];
}

function localAgent(req: ModelRequest): Pick<ModelResult, "text" | "toolCalls"> {
  const c = req.ctx ?? { agentName: "Agent", objective: req.messages.find((m) => m.role === "user")?.content ?? "", tools: req.tools?.map((t) => t.name) ?? [], agents: [], openTasks: [], recentAgentReplies: [], memories: [] };
  const steps = plan(c.objective, c);
  // Work done since the requirement last changed (a revision restarts the plan).
  const lastChange = req.messages.map((m) => m.role === "user" && m.content.startsWith("[EVENT] Requirement changed")).lastIndexOf(true);
  const done = req.messages.slice(lastChange + 1).filter((m) => m.role === "tool");
  if (done.length < steps.length) {
    const s = steps[done.length];
    return { text: "", toolCalls: [{ id: `call_${done.length}_${s.name}`, name: s.name, input: s.input }] };
  }
  const t = c.objective.toLowerCase();
  // Chain a contacts lookup into the email it was for.
  const last = done.at(-1);
  for (const chain of extraChains) {
    const next = last && done.length < 6 ? chain(c.objective, last, c) : null;
    if (next) return { text: "", toolCalls: [{ id: `call_${done.length}_${next.name}`, name: next.name, input: next.input }] };
  }
  if (last?.toolName === "contacts.search" && c.tools.includes("email.send") && /\b(email|send|write|message)\b/.test(t)) {
    const addr = last.content.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
    if (addr) return { text: "", toolCalls: [{ id: `call_${done.length}_email`, name: /\bdraft\b/.test(t) ? "email.draft" : "email.send",
      input: { to: [addr], subject: c.objective.match(/about ([^.,!?\n]+)/i)?.[1]?.trim() ?? "Quick follow-up", body: c.objective } }] };
  }
  if (done.length) {
    // Once something was actually done (sent, booked...), report that — not the lookups that led to it.
    const isRead = (n?: string) => !!n && (/^(web|contacts|drive)\./.test(n) || /\.(search|list|status|read|list_events|find_free_time)$/.test(n));
    const acted = done.filter((m) => !isRead(m.toolName) && !m.content.startsWith("DENIED"));
    const lines = (acted.length && acted.length < done.length ? acted : done).map((m) => {
      if (m.content.startsWith("DENIED")) return `I didn't run ${m.toolName}: ${m.content.slice(8)}`;
      if (m.content.startsWith("REJECTED")) return `${m.toolName} was not approved, so I didn't do it.`;
      return summarize(m.toolName!, m.content);
    });
    return { text: lines.join("\n"), toolCalls: [] };
  }
  if (/\b(update|status|where are we|what'?s next|resume|continue|any news|progress)\b/.test(t)) {
    const parts = [];
    if (c.openTasks.length) parts.push("Open work:\n" + c.openTasks.map((x) => `• ${x.title} — ${x.status} (owner: ${x.owner})`).join("\n"));
    if (c.recentAgentReplies.length) parts.push(`Last update: ${c.recentAgentReplies.at(-1)!.slice(0, 400)}`);
    return { text: parts.length ? `Picking up where we left off.\n${parts.join("\n")}` : "Nothing is in progress right now.", toolCalls: [] };
  }
  const mem = c.memories.length ? ` I remember: ${c.memories.slice(0, 2).join("; ")}.` : "";
  return { text: `Got it${c.speaker ? `, ${c.speaker}` : ""}.${mem}`, toolCalls: [] };
}

function summarize(tool: string, content: string) {
  const body = content.replace(/^<untrusted[^>]*>\n?|\n?<\/untrusted>$/g, "");
  try {
    const j = JSON.parse(body);
    if (j.simulated) return `🧪 Test mode — would ${String(j.would).charAt(0).toLowerCase()}${String(j.would).slice(1)}. Nothing was sent or booked.`;
    if (extraSummaries[tool]) return extraSummaries[tool](j);
    if (tool === "web.search" && Array.isArray(j.results))
      return `Here are the top results:\n${j.results.slice(0, 3).map((r: any, i: number) => `${i + 1}. ${r.title} — ${r.url}`).join("\n")}`;
    if (tool === "calendar.find_free_time" && Array.isArray(j.slots))
      return j.slots.length ? `Open ${j.duration_minutes}-minute slots:\n${j.slots.map((s: any) => `• ${new Date(s.start).toLocaleString()}`).join("\n")}` : "No open slots in working hours.";
    if (tool === "contacts.search" && Array.isArray(j.people)) return j.people.length ? `Found: ${j.people.map((p: any) => `${p.name} <${p.emails[0] ?? "no email"}>`).join(", ")}` : "No matching contacts.";
    if (tool === "drive.search" && Array.isArray(j.files)) return j.files.length ? `Found in Drive:\n${j.files.map((f: any) => `• ${f.name} — ${f.webViewLink}`).join("\n")}` : "Nothing matching in Drive.";
    if (tool === "files.read") return `${j.name}: ${String(j.text).replace(/\s+/g, " ").slice(0, 700)}${j.more ? " …" : ""}`;
    if (tool === "drive.read") return `${j.name} (${j.link}):\n${String(j.text).slice(0, 600)}`;
    if (tool === "calendar.list_events" && Array.isArray(j.events))
      return j.events.length ? `Your upcoming events:\n${j.events.map((e: any) => `• ${e.summary} (${e.start})`).join("\n")}` : "Your calendar is clear.";
    if (tool === "email.send") return `Sent the email to ${[].concat(j.to ?? []).join(", ")}.`;
    if (tool === "email.draft") return `Drafted the email to ${[].concat(j.to ?? []).join(", ")} — say "send it" when ready.`;
    if (tool === "reminder.schedule") return `Reminder set for ${new Date(j.next_at).toLocaleString()}.`;
    if (tool === "task.create") return j.agent_action === "blocked" ? `Understood — I won't contact ${j.subject}; ${j.owner} owns that.` : `Tracking task: ${j.title}.`;
    if (tool === "memory.remember") return `Noted (${j.scope} memory).`;
    if (tool === "agent.delegate") return `Handed off to ${j.agent}.`;
    if (j.result) return `${j.agent ?? "Delegate"} reported: ${String(j.result).slice(0, 500)}`;
    return `${tool}: ${body.slice(0, 300)}`;
  } catch { return `${tool}: ${body.slice(0, 300)}`; }
}
