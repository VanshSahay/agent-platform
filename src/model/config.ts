import Anthropic from "@anthropic-ai/sdk";
import { AnthropicModel } from "./anthropic.ts";
import type { ModelClient } from "./types.ts";

/**
 * Which model, through which door. Two doors, one adapter: both the Anthropic
 * API and OpenRouter speak the Messages shape (tools, effort, caching
 * included), so the Anthropic SDK talks to either by base URL.
 *
 *  - OPENROUTER_API_KEY: default agent model deepseek/deepseek-v4.1-flash-1017 for every call
 *    (17/17 on three live scenarios on 21 Oct 2026, 2–3× faster than GLM 5.3 at
 *    $0.15/$0.60 per million). Override with MODEL and MODEL_SMALL.
 *
 * The deployment's model wins over the id stored on an agent record: one model
 * per deployment is how Circle is run, and a stored id must not pin an old
 * model after the default changes.
 *  - ANTHROPIC_API_KEY (or an `ant auth login` profile): claude-opus-5-5 and
 *    claude-haiku-5-5.
 */
export interface ModelConfig {
  provider: "openrouter" | "anthropic" | "none";
  model: string;
  smallModel: string;
}

export function modelConfig(env: Record<string, string | undefined> = process.env): ModelConfig {
  if (env.OPENROUTER_API_KEY) {
    return { provider: "openrouter", model: env.MODEL ?? "deepseek/deepseek-v4.1-flash-1017", smallModel: env.MODEL_SMALL ?? env.MODEL ?? "deepseek/deepseek-v4.1-flash-1017" };
  }
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_FEDERATION_RULE_ID || env.ANTHROPIC_PROFILE_PRESENT === "1") {
    return { provider: "anthropic", model: env.MODEL ?? "claude-opus-5-5", smallModel: env.MODEL_SMALL ?? "claude-haiku-5-5" };
  }
  return { provider: "none", model: env.MODEL ?? "deepseek/deepseek-v4.1-flash-1017", smallModel: env.MODEL_SMALL ?? env.MODEL ?? "deepseek/deepseek-v4.1-flash-1017" };
}

/** Agents store a model id; translate between the two doors' naming when needed. */
export function normalizeModelId(id: string, provider: ModelConfig["provider"]): string {
  const direct: Record<string, string> = {
    "claude-opus-5-5": "anthropic/claude-opus-5.5",
    "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
    "claude-haiku-5-5": "anthropic/claude-haiku-5.5",
    "claude-opus-5": "anthropic/claude-opus-5",
    "claude-sonnet-5": "anthropic/claude-sonnet-5",
  };
  if (provider === "openrouter") return direct[id] ?? id;
  if (provider === "anthropic") {
    const back = Object.entries(direct).find(([, v]) => v === id)?.[0];
    return back ?? id;
  }
  return id;
}

export function createModel(cfg: ModelConfig, env: Record<string, string | undefined> = process.env): ModelClient | undefined {
  if (cfg.provider === "openrouter") {
    // A hung upstream call must not hold a run for twenty minutes: three minutes, then the SDK retries twice.
    const client = new Anthropic({
      authToken: env.OPENROUTER_API_KEY,
      apiKey: null,
      baseURL: "https://openrouter.ai/api",
      timeout: 180_000,
      maxRetries: 2,
      defaultHeaders: { "HTTP-Referer": env.PUBLIC_URL ?? "http://localhost:3000", "X-Title": "Circle" },
    });
    return new AnthropicModel(client, { smallModel: cfg.smallModel, includeUsage: true, mapModel: (id) => normalizeModelId(id === cfg.smallModel ? id : cfg.model, "openrouter") });
  }
  if (cfg.provider === "anthropic")
    return new AnthropicModel(new Anthropic({ timeout: 180_000, maxRetries: 2 }), {
      smallModel: cfg.smallModel,
      mapModel: (id) => normalizeModelId(id === cfg.smallModel ? id : cfg.model, "anthropic"),
    });
  return undefined;
}
