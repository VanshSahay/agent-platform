// One model gateway: OpenRouter chat completions. Cheap Chinese models by default; Sonnet only when a code rule fires
// (agent.ts decides the tier, this file only knows how to call). A hard daily cap, counted from OpenRouter's returned cost.
import { recordUsage, spentToday } from "./db";

export type Tier = "cheap" | "smart";
export const MODELS: Record<Tier, string[]> = {
  cheap: [process.env.MODEL_CHEAP ?? "deepseek/deepseek-v4-flash", process.env.MODEL_CHEAP_FALLBACK ?? "z-ai/glm-5.3-flash"],
  smart: [process.env.MODEL_SMART ?? "anthropic/claude-sonnet-5.5", process.env.MODEL_SMART_FALLBACK ?? "openai/gpt-6-sol"],
};
export const MODEL_CAP_USD = () => Number(process.env.MODEL_CAP_USD ?? 5);

export interface ToolCall { id: string; name: string; input: any }
export interface Msg { role: "system" | "user" | "assistant" | "tool"; content: string; toolCalls?: ToolCall[]; toolCallId?: string }
export interface ToolSpec { name: string; description: string; input_schema: any }
export interface Req { tier: Tier; messages: Msg[]; tools?: ToolSpec[]; maxTokens?: number; userId?: string | null; runId?: string | null }
export interface Res { text: string; toolCalls: ToolCall[]; model: string; costUsd: number }

export class CapReached extends Error { constructor() { super(`daily model budget ($${MODEL_CAP_USD()}) reached`); } }
/** Tests swap the model for a scripted one. */
export const hooks: { generate: null | ((req: Req) => Res | Promise<Res>) } = { generate: null };

const wire = (n: string) => n.replace(/\./g, "__"), unwire = (n: string) => n.replace(/__/g, ".");

async function call(model: string, req: Req): Promise<Res> {
  const messages = req.messages.map((m) => m.role === "tool" ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
    : m.role === "assistant" ? { role: "assistant", content: m.content || null, tool_calls: m.toolCalls?.length ? m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: wire(c.name), arguments: JSON.stringify(c.input) } })) : undefined }
    : { role: m.role, content: m.content });
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS ?? 90_000)),
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`, "content-type": "application/json", "x-title": "agent-platform" },
    // Cheap models think only when told to; the smart tier keeps its default (Sonnet refuses to turn reasoning off).
    body: JSON.stringify({ model, messages, max_tokens: req.maxTokens ?? 2000, usage: { include: true }, ...(req.tier === "cheap" ? { reasoning: { enabled: false } } : {}),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: wire(t.name), description: t.description, parameters: t.input_schema } })), provider: { require_parameters: true } } : {}) }),
  });
  if (!r.ok) throw new Error(`${model} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json(), msg = j.choices?.[0]?.message;
  if (!msg) throw new Error(`${model}: empty response`);
  return { text: msg.content ?? "", model, costUsd: Number(j.usage?.cost ?? 0),
    toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, name: unwire(c.function.name), input: JSON.parse(c.function.arguments || "{}") })) }; // a malformed call throws → next model
}

export async function generate(req: Req): Promise<Res> {
  if (hooks.generate) return hooks.generate(req);
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  if ((await spentToday("model")) >= MODEL_CAP_USD()) throw new CapReached();
  const errors: string[] = [];
  for (const model of MODELS[req.tier]) {
    try {
      const res = await call(model, req);
      await recordUsage({ user_id: req.userId, run_id: req.runId, kind: "model", qty: 1, cost_usd: res.costUsd, model });
      return res;
    } catch (e: any) { errors.push(e.message); }
  }
  throw new Error(`all ${req.tier} models failed: ${errors.join(" | ")}`);
}

/** Ask for one JSON object. Throws when the model gives none; callers decide what a failure means. */
export async function structured<T>(tier: Tier, instruction: string, input: string, userId?: string | null): Promise<T> {
  const r = await generate({ tier, userId, maxTokens: 800, messages: [{ role: "system", content: `${instruction}\nRespond with a single JSON object and nothing else.` }, { role: "user", content: input }] });
  const m = r.text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in the model's reply");
  return JSON.parse(m[0]);
}
