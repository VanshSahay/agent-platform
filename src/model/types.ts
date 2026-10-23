import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../core/types.ts";

/** A tool as the model sees it. The runtime owns execution. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Anthropic.Tool["input_schema"];
}

export interface ModelRequest {
  model: string;
  effort: Effort;
  /**
   * The system prompt in two blocks: `stable` repeats on every turn and run
   * (identity, soul, rules, skills index) and is cached; `volatile` changes
   * (room, memories, ledger, plan, situation). A cache miss here is a bug.
   */
  system: { stable: string; volatile: string };
  messages: Anthropic.MessageParam[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** The run this call serves, so its cost can be charged to it. */
  runId?: string;
}

/** One assistant turn: text plus zero or more tool calls, plus why it stopped. */
export interface ModelTurn {
  text: string;
  toolUses: { id: string; name: string; input: unknown }[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  /** Raw content to append back to the transcript (keeps thinking blocks intact). */
  content: Anthropic.MessageParam["content"];
  usage?: { input: number; output: number };
}

/** An image for the model: a URL, or base64 bytes with their media type. */
export type ModelImage = { url: string } | { base64: string; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };

export interface ModelClient {
  turn(req: ModelRequest): Promise<ModelTurn>;
  /** Small structured call used by consolidation, premise checks and labels. With `images`, the model looks at them too. */
  complete(opts: { system: string; prompt: string; effort?: Effort; maxTokens?: number; model?: string; images?: ModelImage[]; runId?: string }): Promise<string>;
}
