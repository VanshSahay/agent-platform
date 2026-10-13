import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../core/types.ts";
import type { ModelClient, ModelRequest, ModelTurn } from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Cheap model for labels, premise checks and the nightly memory pass. */
export const SMALL_MODEL = "claude-haiku-5-5";

/**
 * Anthropic-backed model. Thinking is adaptive (the default on Opus 5.5);
 * depth is controlled with `output_config.effort`. The system prompt is cached
 * because the stable part (identity, soul, profile) repeats on every turn.
 */
export class AnthropicModel implements ModelClient {
  private client: Anthropic;
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async turn(req: ModelRequest): Promise<ModelTurn> {
    const stream = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      output_config: { effort: req.effort },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: req.messages,
    });
    const message = await stream.finalMessage();
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolUses = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const stop = message.stop_reason;
    const stopReason: ModelTurn["stopReason"] =
      stop === "end_turn" ? "end_turn" : stop === "tool_use" ? "tool_use" : stop === "max_tokens" ? "max_tokens" : stop === "refusal" ? "refusal" : "other";
    return {
      text,
      toolUses: stopReason === "refusal" ? [] : toolUses,
      stopReason,
      content: message.content,
      usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
    };
  }

  async complete(opts: { system: string; prompt: string; effort?: Effort; maxTokens?: number; model?: string }): Promise<string> {
    const res = await this.client.messages.create({
      model: opts.model ?? SMALL_MODEL,
      max_tokens: opts.maxTokens ?? 4000,
      output_config: { effort: opts.effort ?? "low" },
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    });
    if (res.stop_reason === "refusal") return "";
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}
