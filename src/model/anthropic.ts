import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../core/types.ts";
import type { ModelClient, ModelImage, ModelRequest, ModelTurn } from "./types.ts";

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
  private smallModel: string;
  private mapModel: (id: string) => string;
  constructor(client?: Anthropic, opts: { smallModel?: string; mapModel?: (id: string) => string } = {}) {
    this.client = client ?? new Anthropic();
    this.smallModel = opts.smallModel ?? SMALL_MODEL;
    this.mapModel = opts.mapModel ?? ((id) => id);
  }

  async turn(req: ModelRequest): Promise<ModelTurn> {
    const stream = this.client.messages.stream({
      model: this.mapModel(req.model),
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
    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
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

  async complete(opts: { system: string; prompt: string; effort?: Effort; maxTokens?: number; model?: string; images?: ModelImage[] }): Promise<string> {
    const content: Anthropic.ContentBlockParam[] = (opts.images ?? []).map((im) =>
      "url" in im ? { type: "image", source: { type: "url", url: im.url } } : { type: "image", source: { type: "base64", media_type: im.mediaType, data: im.base64 } },
    );
    content.push({ type: "text", text: opts.prompt });
    const res = await this.client.messages.create({
      model: this.mapModel(opts.model ?? this.smallModel),
      max_tokens: opts.maxTokens ?? 4000,
      output_config: { effort: opts.effort ?? "low" },
      system: opts.system,
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") return "";
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}
