import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../core/types.ts";
import type { ModelClient, ModelImage, ModelRequest, ModelTurn } from "./types.ts";

/** One call's tokens and, when the door reports it, its price. */
export interface ModelUsage {
  model: string;
  input: number;
  output: number;
  /** USD as the door reported it; undefined when the response carried no cost. */
  usd?: number;
  runId?: string;
}

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Cheap model for labels, premise checks and the nightly memory pass. */
export const SMALL_MODEL = "claude-haiku-5-5";

/**
 * Anthropic-backed model. Thinking is adaptive (the default on Opus 5.5);
 * depth is controlled with `output_config.effort`. The system prompt arrives
 * in two blocks: the stable one (identity, soul, rules, skills index) is
 * cached so it is read once across turns and runs; the volatile one is not.
 */
export class AnthropicModel implements ModelClient {
  private client: Anthropic;
  private smallModel: string;
  private mapModel: (id: string) => string;
  private includeUsage: boolean;
  /** Called after every call with its tokens and price; set by main so the spend log sees model calls. */
  public onUsage?: (u: ModelUsage) => void;
  constructor(client?: Anthropic, opts: { smallModel?: string; mapModel?: (id: string) => string; includeUsage?: boolean; onUsage?: (u: ModelUsage) => void } = {}) {
    this.client = client ?? new Anthropic();
    this.smallModel = opts.smallModel ?? SMALL_MODEL;
    this.mapModel = opts.mapModel ?? ((id) => id);
    this.includeUsage = opts.includeUsage ?? false;
    this.onUsage = opts.onUsage;
  }

  /**
   * OpenRouter prices every response in `usage.cost`; `usage: {include: true}` is the documented
   * (now deprecated, harmless) opt-in. The Anthropic API rejects unknown fields, so only the
   * OpenRouter door sends it.
   */
  private extra() {
    return this.includeUsage ? { usage: { include: true } } : {};
  }

  private report(model: string, usage: Anthropic.Usage | undefined, cost: number | undefined, runId?: string) {
    const u = usage as (Anthropic.Usage & { cost?: unknown }) | undefined;
    const usd = typeof cost === "number" ? cost : typeof u?.cost === "number" ? u.cost : undefined;
    try {
      this.onUsage?.({ model, input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, usd, runId });
    } catch {
      /* a broken sink must not fail the call */
    }
  }

  /**
   * A model turn has no side effects, so a stream that breaks mid-way (OpenRouter has sent events out of
   * order) or a server error is retried twice; a request the API rejects as malformed is not.
   */
  /** First retry delay; tests set it to 0. */
  static retryBaseMs = 1000;

  async turn(req: ModelRequest): Promise<ModelTurn> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.turnOnce(req);
      } catch (e) {
        const status = (e as { status?: number }).status;
        const fatal = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
        if (fatal || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, AnthropicModel.retryBaseMs * 3 ** attempt));
      }
    }
  }

  private async turnOnce(req: ModelRequest): Promise<ModelTurn> {
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: req.system.stable, cache_control: { type: "ephemeral" } }];
    if (req.system.volatile) system.push({ type: "text", text: req.system.volatile });
    const model = this.mapModel(req.model);
    const stream = this.client.messages.stream({
      model,
      max_tokens: req.maxTokens ?? 16000,
      output_config: { effort: req.effort },
      system,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: req.messages,
      ...this.extra(),
    } as Anthropic.MessageStreamParams);
    // The SDK's snapshot copies only the usage fields it knows; the price rides the last message_delta, so read it off the raw events.
    let cost: number | undefined;
    stream.on("streamEvent", (ev) => {
      const c = (ev as { usage?: { cost?: unknown } }).usage?.cost;
      if (typeof c === "number") cost = c;
    });
    const message = await stream.finalMessage();
    this.report(model, message.usage, cost, req.runId);
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

  async complete(opts: { system: string; prompt: string; effort?: Effort; maxTokens?: number; model?: string; images?: ModelImage[]; runId?: string }): Promise<string> {
    const content: Anthropic.ContentBlockParam[] = (opts.images ?? []).map((im) =>
      "url" in im ? { type: "image", source: { type: "url", url: im.url } } : { type: "image", source: { type: "base64", media_type: im.mediaType, data: im.base64 } },
    );
    content.push({ type: "text", text: opts.prompt });
    const model = this.mapModel(opts.model ?? this.smallModel);
    const res = await this.client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 4000,
      output_config: { effort: opts.effort ?? "low" },
      system: opts.system,
      messages: [{ role: "user", content }],
      ...this.extra(),
    } as Anthropic.MessageCreateParamsNonStreaming);
    this.report(model, res.usage, undefined, opts.runId);
    if (res.stop_reason === "refusal") return "";
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}
