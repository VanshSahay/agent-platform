// Provider-neutral ModelGateway (plan §8). Canonical history is our normalized Msg[]; provider payloads are built per call.
import Anthropic from "@anthropic-ai/sdk";
import { one, unseal, recordUsage } from "./db";

export interface ToolCall { id: string; name: string; input: any }
export interface Msg { role: "user" | "assistant" | "tool"; content: string; toolCalls?: ToolCall[]; toolCallId?: string; toolName?: string; raw?: any; model?: string }
export interface ToolSpec { name: string; description: string; input_schema: any }
export interface ModelRequest {
  profile: string; system: string; messages: Msg[]; tools?: ToolSpec[];
  workspaceId?: string; agentId?: string; runId?: string; escalate?: boolean; maxTokens?: number;
  ctx?: LocalCtx; // structured context, used by the offline heuristic model
}
export interface ModelResult { text: string; toolCalls: ToolCall[]; model: string; usage: { input: number; output: number }; costUsd: number; byok: boolean; raw?: any }

// Tests swap the model for a scripted one.
export const hooks: { model: null | ((req: ModelRequest) => Partial<ModelResult>) } = { model: null };

const PRICE: Record<string, [number, number]> = { // $ per 1M tokens in/out
  "claude-haiku-4-5": [1, 5], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20], "claude-fable-5-1": [10, 50],
};
const wire = (n: string) => n.replace(/\./g, "__");
const unwire = (n: string) => n.replace(/__/g, ".");

function keyFor(provider: string, workspaceId?: string): { key: string; byok: boolean } | null {
  if (workspaceId) {
    const row = one<{ key_enc: string }>("select key_enc from provider_keys where workspace_id=? and provider=?", workspaceId, provider);
    if (row) return { key: unseal<string>(row.key_enc)!, byok: true };
  }
  const env = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY }[provider];
  return env ? { key: env, byok: false } : null;
}

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

async function callOpenAI(model: string, key: string, req: ModelRequest) {
  const messages: any[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "tool") messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content || null,
      tool_calls: m.toolCalls?.length ? m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: wire(c.name), arguments: JSON.stringify(c.input) } })) : undefined });
    else messages.push({ role: "user", content: m.content });
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools: req.tools?.map((t) => ({ type: "function", function: { name: wire(t.name), description: t.description, parameters: t.input_schema } })) }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${await r.text()}`);
  const j: any = await r.json(), msg = j.choices[0].message;
  return {
    text: msg.content ?? "", usage: { input: j.usage.prompt_tokens, output: j.usage.completion_tokens }, costUsd: 0,
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
  const chain = [req.escalate && p.escalation_model, p.primary_model, p.fallback_model].filter(Boolean) as string[];
  const errors: string[] = [];
  for (const spec of chain) {
    const [provider, model] = spec.split(":");
    const k = keyFor(provider, req.workspaceId);
    if (!k) continue;
    try {
      const r = provider === "anthropic" ? await callAnthropic(model, k.key, req) : await callOpenAI(model, k.key, req);
      const out = { ...r, model: spec, byok: k.byok };
      if (req.workspaceId) {
        recordUsage({ workspace_id: req.workspaceId, agent_id: req.agentId, run_id: req.runId, kind: "model_input_tokens", qty: r.usage.input, cost_usd: k.byok ? 0 : r.costUsd, byok: k.byok });
        recordUsage({ workspace_id: req.workspaceId, agent_id: req.agentId, run_id: req.runId, kind: "model_output_tokens", qty: r.usage.output, byok: k.byok });
      }
      return out;
    } catch (e: any) { errors.push(`${spec}: ${e.message}`); }
  }
  if (errors.length) throw new Error(`all models failed: ${errors.join("; ")}`);
  if (!warned) { console.warn("[model] no provider keys configured; using offline heuristic model"); warned = true; }
  return { ...localAgent(req), model: "local:heuristic", usage: { input: 0, output: 0 }, costUsd: 0, byok: false };
}

/** Ask a model for JSON; fall back to a deterministic heuristic offline or on parse failure. */
export async function structured<T>(profile: string, instruction: string, input: string, fallback: () => T, workspaceId?: string): Promise<T> {
  if (hooks.model || !(keyFor("anthropic", workspaceId) || keyFor("openai", workspaceId))) return fallback();
  try {
    const r = await generate({ profile, workspaceId, system: `${instruction}\nRespond with a single JSON object and nothing else.`, messages: [{ role: "user", content: input }], maxTokens: 2000 });
    const m = r.text.match(/\{[\s\S]*\}/);
    return m ? { ...fallback(), ...JSON.parse(m[0]) } : fallback();
  } catch { return fallback(); }
}

// ---------------- offline heuristic model ----------------
// ponytail: keyword planner so the product works end-to-end with no API key (demo, CI, evals baseline). Real judgment needs a real model.
export interface LocalCtx {
  agentName: string; speaker?: string; objective: string; tools: string[];
  agents: string[]; openTasks: { title: string; owner: string; status: string }[]; recentAgentReplies: string[]; memories: string[];
}

export function plan(text: string, c: Pick<LocalCtx, "tools" | "agents" | "speaker" | "agentName">) {
  const t = text.toLowerCase(), has = (n: string) => c.tools.includes(n), out: { name: string; input: any }[] = [];
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)?.at(-1); // latest wins (follow-up corrections append)
  const subjectOf = () => text.match(/about ([^.,!?\n]+)/i)?.[1]?.trim() ?? "Quick follow-up";
  const dontContact = text.match(/(?:don'?t|do not) (?:contact|email|message|text|reach out to) ([A-Z][a-z]+)/);
  const ask = text.match(/\bask (\w+) to ([^.!?]+)/i);
  const delegateTo = ask && c.agents.find((a) => a.toLowerCase() === ask[1].toLowerCase() && a !== c.agentName);

  if (dontContact && has("task.create"))
    out.push({ name: "task.create", input: { title: `${dontContact[1]} follow-up`, owner: c.speaker ?? "human", agent_action: "blocked", subject: dontContact[1] } });
  const fu = text.match(/take care of (?:the )?([^,.]+?follow-ups?)/i) ?? text.match(/\b(follow up (?:with|on) [^,.]+)/i);
  if (fu && has("task.create")) out.push({ name: "task.create", input: { title: fu[1].trim(), owner: "agent" } });
  if (delegateTo && has("agent.delegate")) out.push({ name: "agent.delegate", input: { agent: delegateTo, objective: ask![2].trim() } });

  const rem = t.match(/remind (?:me|us)(?: to)? (.+?)(?: in (\d+) (minute|hour|day)s?| tomorrow|$)/);
  const daily = t.match(/every (?:day|morning|weekday)(?: at (\d{1,2}))?/);
  if ((rem || daily) && has("reminder.schedule")) {
    const unit = { minute: 1, hour: 60, day: 1440 }[rem?.[3] as "minute"] ?? 0;
    out.push({ name: "reminder.schedule", input: daily
      ? { text: rem?.[1] ?? text, recurring: "daily", hour: Number(daily[1] ?? 9) }
      : { text: rem![1], in_minutes: rem![2] ? Number(rem![2]) * unit : t.includes("tomorrow") ? 1440 : 60 } });
  }
  const remember = text.match(/^(?:please )?(?:remember|note)(?: that)? (.+)/i);
  if (remember && has("memory.remember"))
    out.push({ name: "memory.remember", input: { text: remember[1], scope: /\b(team|everyone|workspace)\b/i.test(text) ? "workspace" : "room" } });

  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (url && has("web.fetch")) out.push({ name: "web.fetch", input: { url } });
  else if (/\b(search|find|research|look up|compare|options?|hotels?|flights?|prices?|latest|news)\b/.test(t) && !rem && has("web.search"))
    out.push({ name: "web.search", input: { query: text.replace(/^@?\w+[,:]\s*/, "").slice(0, 200) } });

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
  return out;
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
  if (last?.toolName === "contacts.search" && c.tools.includes("email.send") && /\b(email|send|write|message)\b/.test(t)) {
    const addr = last.content.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
    if (addr) return { text: "", toolCalls: [{ id: `call_${done.length}_email`, name: /\bdraft\b/.test(t) ? "email.draft" : "email.send",
      input: { to: [addr], subject: c.objective.match(/about ([^.,!?\n]+)/i)?.[1]?.trim() ?? "Quick follow-up", body: c.objective } }] };
  }
  if (done.length) {
    const lines = done.map((m) => {
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
    if (tool === "web.search" && Array.isArray(j.results))
      return `Here are the top results:\n${j.results.slice(0, 3).map((r: any, i: number) => `${i + 1}. ${r.title} — ${r.url}`).join("\n")}`;
    if (tool === "calendar.find_free_time" && Array.isArray(j.slots))
      return j.slots.length ? `Open ${j.duration_minutes}-minute slots:\n${j.slots.map((s: any) => `• ${new Date(s.start).toLocaleString()}`).join("\n")}` : "No open slots in working hours.";
    if (tool === "contacts.search" && Array.isArray(j.people)) return j.people.length ? `Found: ${j.people.map((p: any) => `${p.name} <${p.emails[0] ?? "no email"}>`).join(", ")}` : "No matching contacts.";
    if (tool === "drive.search" && Array.isArray(j.files)) return j.files.length ? `Found in Drive:\n${j.files.map((f: any) => `• ${f.name} — ${f.webViewLink}`).join("\n")}` : "Nothing matching in Drive.";
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
