/**
 * Runs a scenario against the real runtime and grades the store, not the
 * prose. A scenario seeds fake hands and memories, sends turns in order
 * (answers to cards go in the approver's DM, like a real chat), and its
 * checks read runs, tool calls, attention items, commitments, memories and
 * deliveries to decide whether the agent behaved.
 */
import type { App } from "../app.ts";
import type { ModelClient, ModelRequest, ModelTurn } from "../model/types.ts";
import { evalWorld, type EvalWorld, type RoomKey } from "./world.ts";

export interface Turn {
  room: RoomKey;
  personId: string;
  text: string;
}

export interface Check {
  name: string;
  /** What a pass proves, in one sentence. */
  detail: string;
  pass(app: App, world: EvalWorld): boolean;
}

export interface Scenario {
  name: string;
  description: string;
  setup?(app: App, world: EvalWorld): void;
  turns: Turn[];
  checks: Check[];
}

export interface CheckResult {
  name: string;
  detail: string;
  pass: boolean;
  error?: string;
}

export interface ScenarioResult {
  name: string;
  checks: CheckResult[];
  passed: number;
  total: number;
  toolCalls: number;
  modelTurns: number;
  elapsedMs: number;
  tokens: { input: number; output: number };
  /** One entry per turn; `tools` lists the run's tool calls so far, a trailing + marking stored evidence. */
  turns: { room: string; personId: string; runId?: string; status?: string; tools: string[] }[];
  /** Set when the scenario could not finish (model error, timeout). Checks still run on whatever state exists. */
  error?: string;
}

/** Counts model turns and token usage without changing what the runtime sees. */
export class MeteredModel implements ModelClient {
  turns = 0;
  input = 0;
  output = 0;
  constructor(private inner: ModelClient) {}
  async turn(req: ModelRequest): Promise<ModelTurn> {
    this.turns += 1;
    const t = await this.inner.turn(req);
    if (t.usage) {
      this.input += t.usage.input;
      this.output += t.usage.output;
    }
    return t;
  }
  complete(opts: Parameters<ModelClient["complete"]>[0]) {
    return this.inner.complete(opts);
  }
}

export interface RunOptions {
  model: ModelClient;
  /** Overrides the agent's model id (what the runtime asks the client for). */
  modelId?: string;
  timeoutMs?: number;
  maxTurns?: number;
  onTurn?: (turn: Turn, result: { runId?: string; status?: string; tools: string[] }) => void;
}

export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<ScenarioResult> {
  const metered = new MeteredModel(opts.model);
  const world = evalWorld({ model: metered, modelId: opts.modelId, maxTurns: opts.maxTurns });
  const { app } = world;
  const started = Date.now();
  const turns: ScenarioResult["turns"] = [];
  let error: string | undefined;

  const play = async () => {
    scenario.setup?.(app, world);
    for (const t of scenario.turns) {
      const run = await app.runtime.handleMessage({ roomId: world.roomId(t.room), personId: t.personId, text: t.text });
      const tools = run ? app.store.toolCallsForRun(run.id).map((c) => `${c.name}${c.evidence ? "+" : ""}${c.status === "running" || c.status === "stopped" ? "?" : ""}`) : [];
      const rec = { room: t.room, personId: t.personId, runId: run?.id, status: run?.status, tools };
      turns.push(rec);
      opts.onTurn?.(t, rec);
      if (run?.status === "failed") throw new Error(`run ${run.id} failed: ${run.failureReason ?? "unknown"}`);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${opts.timeoutMs ?? 180_000}ms`)), opts.timeoutMs ?? 180_000);
  });
  try {
    await Promise.race([play(), timeout]);
  } catch (e) {
    error = String((e as Error).message ?? e);
  } finally {
    clearTimeout(timer);
  }

  const checks: CheckResult[] = scenario.checks.map((c) => {
    try {
      return { name: c.name, detail: c.detail, pass: c.pass(app, world) };
    } catch (e) {
      return { name: c.name, detail: c.detail, pass: false, error: String((e as Error).message ?? e) };
    }
  });
  const toolCalls = app.store.listRuns({ agentId: world.agent.id, limit: 200 }).reduce((n, r) => n + app.store.toolCallsForRun(r.id).length, 0);
  return {
    name: scenario.name,
    checks,
    passed: checks.filter((c) => c.pass).length,
    total: checks.length,
    toolCalls,
    modelTurns: metered.turns,
    elapsedMs: Date.now() - started,
    tokens: { input: metered.input, output: metered.output },
    turns,
    error,
  };
}

/** Sequential on purpose: one world at a time keeps token spend and logs readable. */
export async function runScenarios(scenarios: Scenario[], opts: RunOptions & { onResult?: (r: ScenarioResult) => void }): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const s of scenarios) {
    const r = await runScenario(s, opts);
    out.push(r);
    opts.onResult?.(r);
  }
  return out;
}
