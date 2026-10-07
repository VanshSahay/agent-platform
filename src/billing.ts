// AI billing: each workspace either pays with platform credits (our keys, metered per call) or brings its own keys (never charged).
// Credits = this month's plan allowance first, then purchased credits. Top-ups go through Stripe Checkout when configured.
import { createHmac, timingSafeEqual } from "node:crypto";
import { one, exec, id, now, J, S, emit, usageHooks } from "./db";

// Plan limits (plan §22.1). ponytail: enforced here from the usage ledger; Stripe becomes a billing sink later.
// monthlyModelUsd caps platform-hosted inference; BYOK usage isn't counted.
export const PLANS: Record<string, { agents: number; channels: string[]; monthlyModelUsd: number | null }> = {
  free: { agents: 2, channels: ["web", "telegram"], monthlyModelUsd: 2 },
  personal: { agents: 5, channels: ["web", "telegram", "imessage", "email", "whatsapp"], monthlyModelUsd: 20 },
  pro: { agents: 20, channels: ["web", "telegram", "imessage", "email", "whatsapp", "phone"], monthlyModelUsd: 60 },
  team: { agents: 50, channels: ["web", "telegram", "imessage", "email", "whatsapp", "phone", "slack"], monthlyModelUsd: 250 },
  enterprise: { agents: 1000, channels: ["web", "telegram", "imessage", "email", "whatsapp", "phone", "slack"], monthlyModelUsd: null },
};

// Metered non-model usage, priced in credits (USD). Override any with PRICE_<KIND>=0.01. BYOK doesn't cover these: they're our infrastructure.
export const UNIT_PRICE: Record<string, number> = { search_calls: .005, browser_tasks: .05, channel_messages: .005, voice_turns: .02, photo_understanding: .002, voice_transcription: .003 };
const unitPrice = (kind: string) => Number(process.env[`PRICE_${kind.toUpperCase()}`] ?? UNIT_PRICE[kind] ?? 0);
usageHooks.price = (kind, qty) => unitPrice(kind) * qty;
usageHooks.charge = (ws, usd) => charge(ws, usd);

export const MARKUP = () => Number(process.env.CREDIT_MARKUP ?? 1.25); // platform price = provider cost × markup
const month = () => new Date(now()).toISOString().slice(0, 7);

export function aiSettings(ws: string) {
  const w = one<any>("select ai_mode, ai_models from workspaces where id=?", ws);
  return { mode: (w?.ai_mode ?? "credits") as "credits" | "byok", models: J(w?.ai_models, {}) as Record<string, string> };
}

/** Allowance resets monthly (no rollover); purchased credits persist. */
export function balance(ws: string) {
  const w = one<any>("select plan, credit_usd, allowance_month, allowance_used from workspaces where id=?", ws);
  const cap = PLANS[w?.plan ?? "free"]?.monthlyModelUsd ?? null;
  const used = w?.allowance_month === month() ? w.allowance_used ?? 0 : 0;
  const allowanceLeft = cap == null ? Infinity : Math.max(0, cap - used);
  const credits = w?.credit_usd ?? 0;
  return { allowance: cap, allowance_left: allowanceLeft === Infinity ? null : round(allowanceLeft), credits: round(credits), unlimited: cap == null,
    available: allowanceLeft === Infinity ? Infinity : allowanceLeft + credits };
}
const round = (x: number) => Math.round(x * 10000) / 10000;

export const canSpend = (ws: string) => aiSettings(ws).mode === "byok" || balance(ws).available > 0;

/** Deduct a platform-billed amount: allowance first, then credits (may dip just below zero; the next call is blocked). */
export function charge(ws: string, usd: number) {
  if (!(usd > 0)) return;
  const w = one<any>("select plan, allowance_month, allowance_used from workspaces where id=?", ws);
  const cap = PLANS[w?.plan ?? "free"]?.monthlyModelUsd ?? null;
  if (cap == null) return;
  const used = w.allowance_month === month() ? w.allowance_used ?? 0 : 0;
  const fromAllowance = Math.min(usd, Math.max(0, cap - used));
  exec("update workspaces set allowance_month=?, allowance_used=?, credit_usd=coalesce(credit_usd,0)-? where id=?", month(), used + fromAllowance, usd - fromAllowance, ws);
}

/** Add purchased or granted credits once per reference (Stripe session id, admin grant id). */
export function addCredits(ws: string, usd: number, reason: string, ref: string) {
  if (one("select 1 from credit_ledger where ref=?", ref)) return false;
  exec("insert into credit_ledger (id, workspace_id, delta_usd, reason, ref, ts) values (?,?,?,?,?,?)", id("crd"), ws, usd, reason, ref, now());
  exec("update workspaces set credit_usd=coalesce(credit_usd,0)+? where id=?", usd, ws);
  emit("CREDITS_ADDED", { workspace_id: ws, data: { usd, reason } });
  return true;
}

// ---------------- model catalog ----------------
export interface CatalogModel { id: string; name: string; provider: string; in_per_m: number; out_per_m: number; open: boolean; context?: number }
const DIRECT: CatalogModel[] = [
  { id: "anthropic:claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", in_per_m: 1, out_per_m: 5, open: false },
  { id: "anthropic:claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", in_per_m: 2, out_per_m: 10, open: false },
  { id: "anthropic:claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", in_per_m: 4, out_per_m: 20, open: false },
  { id: "openai:gpt-5-mini", name: "GPT-5 mini", provider: "openai", in_per_m: 0.25, out_per_m: 2, open: false },
  { id: "openai:gpt-5", name: "GPT-5", provider: "openai", in_per_m: 1.25, out_per_m: 10, open: false },
];
// ponytail: offline fallback when OpenRouter's public model list can't be fetched; the live list replaces it.
const OPEN_FALLBACK: CatalogModel[] = [
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 0.209, 0.418], ["qwen/qwen3.7-flash", "Qwen 3.7 Flash", 0.03, 0.13], ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", 2, 10],
  ["openai/gpt-oss-120b", "gpt-oss-120b", 0.037, 0.17], ["meta-llama/llama-4-maverick", "Llama 4 Maverick", 0.19, 0.65], ["meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B", 0.1, 0.32],
].map(([m, name, i, o]) => ({ id: `openrouter:${m}`, name: name as string, provider: "openrouter", in_per_m: i as number, out_per_m: o as number, open: true }));
const OPEN_WEIGHTS = /^(meta-llama|deepseek|qwen|mistralai|google\/gemma|openai\/gpt-oss|moonshotai|z-ai|thudm|nvidia|microsoft\/phi|nousresearch|allenai|ibm-granite)/;

let cache: { at: number; list: CatalogModel[] } | null = null;
/** OpenRouter's public model list (no key needed), filtered to models that support tool calling. Cached for an hour. */
export async function openRouterModels(): Promise<CatalogModel[]> {
  if (cache && now() - cache.at < 36e5) return cache.list;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    const list: CatalogModel[] = (j.data ?? []).filter((m: any) => (m.supported_parameters ?? []).includes("tools") && m.pricing && !/:batch$/.test(m.id)) // batch variants aren't for chat
      .map((m: any) => ({ id: `openrouter:${m.id}`, name: m.name ?? m.id, provider: "openrouter", in_per_m: round(Number(m.pricing.prompt) * 1e6), out_per_m: round(Number(m.pricing.completion) * 1e6),
        open: OPEN_WEIGHTS.test(m.id), context: m.context_length }))
      .filter((m: CatalogModel) => m.in_per_m >= 0 && m.out_per_m >= 0);
    if (list.length) cache = { at: now(), list };
  } catch {}
  return cache?.list ?? OPEN_FALLBACK;
}
export async function catalog() { return [...DIRECT, ...(await openRouterModels())]; }
export function priceOf(spec: string): [number, number] | null {
  const m = [...DIRECT, ...(cache?.list ?? OPEN_FALLBACK)].find((x) => x.id === spec);
  return m ? [m.in_per_m, m.out_per_m] : null;
}

// Platform-hosted open-model defaults used when no closed-model key is configured (override with env).
// Picked from live OpenRouter prices (2026-10): cheapest model that's good enough for each kind of step. Prices move; override per tier with
// OPENROUTER_MODEL_<FAST|STANDARD|RESEARCH_STANDARD|ESCALATION>=openrouter:<model-id>.
const OPEN_TIER: Record<string, string> = {
  fast: "openrouter:qwen/qwen3.7-flash",               // $0.03/$0.13 per 1M — intake, memory, grading, simple chat turns
  standard: "openrouter:deepseek/deepseek-v4-pro",     // $0.21/$0.42 — the agent's tool-calling loop
  "research-standard": "openrouter:deepseek/deepseek-v4-pro",
  escalation: "openrouter:anthropic/claude-sonnet-5.5", // $2/$10 — only when a task is stuck or failing
  judge: "openrouter:deepseek/deepseek-v4-pro",        // plans each request and checks results: the strongest open model, never the cheap one
};
export const openDefault = (profile: string) => process.env[`OPENROUTER_MODEL_${profile.toUpperCase().replace(/-/g, "_")}`]
  ?? (profile === "fast" ? process.env.OPENROUTER_FAST_MODEL : process.env.OPENROUTER_MODEL) ?? OPEN_TIER[profile] ?? OPEN_TIER.standard;

// ---------------- Stripe top-ups ----------------
export async function checkout(ws: string, usd: number, base: string) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const f = new URLSearchParams({
    mode: "payment", success_url: `${base}/#/settings?credits=added`, cancel_url: `${base}/#/settings`, client_reference_id: ws,
    "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(Math.round(usd * 100)),
    "line_items[0][price_data][product_data][name]": `AI credits ($${usd})`, "metadata[workspace_id]": ws,
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: f });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? `stripe ${r.status}`);
  return j.url as string;
}

/** Stripe-Signature: t=<ts>,v1=<hmac_sha256(secret, `${t}.${raw}`)>; 5-minute tolerance. Credits = amount actually paid. */
export function stripeWebhook(raw: string, sigHeader: string | null) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return { status: 401 };
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t), want = createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
  const sigs = sigHeader.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const ok = Math.abs(now() / 1000 - t) < 300 && sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), Buffer.from(want)));
  if (!ok) return { status: 401 };
  const e = JSON.parse(raw);
  if (e.type === "checkout.session.completed" && e.data?.object?.payment_status === "paid") {
    const s = e.data.object, ws = s.metadata?.workspace_id ?? s.client_reference_id;
    if (ws && one("select 1 from workspaces where id=?", ws)) addCredits(ws, (s.amount_total ?? 0) / 100, "stripe", s.id);
  }
  return { status: 200 };
}
