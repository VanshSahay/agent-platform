import type { ModelClient, ModelRequest, ModelTurn } from "./types.ts";

export type Script = (req: ModelRequest, callIndex: number) => ModelTurn | string | Promise<ModelTurn | string>;

/**
 * A model you program. Tests and the offline demo use it to drive the real
 * runtime without network access. A string result is a plain text reply.
 */
export class ScriptedModel implements ModelClient {
  public calls: ModelRequest[] = [];
  public completions: { system: string; prompt: string }[] = [];
  /**
   * The first error a script threw. The runtime catches model errors and
   * fails the run, so an expect() inside a script would otherwise vanish;
   * tests call rethrow() after the run to surface it.
   */
  public firstError: unknown;
  private ids = 0;
  constructor(
    private script: Script,
    private completer: (system: string, prompt: string) => string = () => "",
  ) {}

  async turn(req: ModelRequest): Promise<ModelTurn> {
    this.calls.push(req);
    let out: ModelTurn | string;
    try {
      out = await this.script(req, this.calls.length - 1);
    } catch (e) {
      this.firstError ??= e;
      throw e;
    }
    if (typeof out === "string") return reply(out);
    return this.reid(out);
  }

  async complete(opts: { system: string; prompt: string }): Promise<string> {
    this.completions.push(opts);
    try {
      return this.completer(opts.system, opts.prompt);
    } catch (e) {
      this.firstError ??= e;
      throw e;
    }
  }

  /** Throws the first error a script raised, if any. */
  rethrow() {
    if (this.firstError !== undefined) throw this.firstError;
  }

  /** Ids come from the helpers' module counter; re-minting them here keeps them unique per instance whatever else ran in the process. */
  private reid(turn: ModelTurn): ModelTurn {
    if (!turn.toolUses.length) return turn;
    const map = new Map<string, string>();
    for (const u of turn.toolUses) map.set(u.id, `toolu_${this.ids + map.size + 1}`);
    this.ids += map.size;
    return {
      ...turn,
      toolUses: turn.toolUses.map((u) => ({ ...u, id: map.get(u.id) ?? u.id })),
      content: typeof turn.content === "string" ? turn.content : turn.content.map((b) => (b.type === "tool_use" ? { ...b, id: map.get(b.id) ?? b.id } : b)),
    };
  }
}

export function reply(text: string): ModelTurn {
  return { text, toolUses: [], stopReason: "end_turn", content: [{ type: "text", text }] };
}

// Fallback counter for scripts used outside a ScriptedModel; the model re-ids tool uses per instance.
let counter = 0;
export function callTool(name: string, input: unknown, text = ""): ModelTurn {
  const id = `toolu_${++counter}`;
  const content: ModelTurn["content"] = [];
  if (text) content.push({ type: "text", text });
  content.push({ type: "tool_use", id, name, input: (input ?? {}) as Record<string, unknown> });
  return { text, toolUses: [{ id, name, input }], stopReason: "tool_use", content };
}

export function callTools(calls: { name: string; input: unknown }[], text = ""): ModelTurn {
  const content: ModelTurn["content"] = [];
  if (text) content.push({ type: "text", text });
  const toolUses = calls.map((c) => {
    const id = `toolu_${++counter}`;
    content.push({ type: "tool_use", id, name: c.name, input: (c.input ?? {}) as Record<string, unknown> });
    return { id, name: c.name, input: c.input };
  });
  return { text, toolUses, stopReason: "tool_use", content };
}

/** Helper for scripts: last tool_result text in the transcript, if any. */
export function lastToolResult(req: ModelRequest): string | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_result") {
        const c = block.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return c.map((b) => (b.type === "text" ? b.text : "")).join("");
      }
    }
  }
  return undefined;
}

/** Helper: the newest user text in the transcript. */
export function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return t.text;
  }
  return "";
}

/** Helper: every tool call the assistant has made so far in this transcript, oldest first. */
export function toolCallsSoFar(req: ModelRequest): { name: string; input: Record<string, unknown> }[] {
  const out: { name: string; input: Record<string, unknown> }[] = [];
  for (const m of req.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_use") out.push({ name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
  }
  return out;
}

/** Helper: true if the transcript contains a user turn whose text includes `needle` (not JSON-escaped). */
export function transcriptHas(req: ModelRequest, needle: string): boolean {
  for (const m of req.messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      if (m.content.includes(needle)) return true;
    } else for (const b of m.content) if (b.type === "text" && b.text.includes(needle)) return true;
  }
  return false;
}
