/**
 * Runs a scenario against the real runtime and grades the store, not the
 * prose. A scenario seeds fake hands and memories, plays turns in order
 * (messages in a room, clock ticks that run the scheduler, app events), and
 * its checks read runs, tool calls, attention items, commitments, memories
 * and deliveries to decide whether the agent behaved. A scenario that
 * declares `expects` also gets a generic "nothing else changed" check: the
 * store is counted before and after, and anything the scenario did not
 * declare fails it.
 */
import type { App } from "../app.ts";
import type { Script } from "../model/scripted.ts";
import type { ModelClient, ModelRequest, ModelTurn } from "../model/types.ts";
import { TOOL_INDEX } from "../tools/registry.ts";
import { evalWorld, type EvalWorld, type RoomKey } from "./world.ts";

/** Fo's 21 task categories plus privacy, which Fo has no doodle for and we grade on. */
export const CATEGORIES = [
  "booking",
  "business",
  "children",
  "delivery",
  "doctor",
  "email-reply",
  "email-send",
  "events",
  "finance",
  "gift",
  "government",
  "groceries",
  "haircut",
  "home-services",
  "insurance",
  "personal-care",
  "pets",
  "refunds",
  "schedule",
  "subscriptions",
  "travel",
  "privacy",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SHAPES = ["solo", "couple", "family", "care", "friends", "housemates"] as const;
export type Shape = (typeof SHAPES)[number];

export interface MessageTurn {
  room: RoomKey;
  personId: string;
  text: string;
}
/** Advance the clock by `tick` ms and run one scheduler tick (schedules, watches, nudges, heartbeats). */
export interface TickTurn {
  tick: number;
}
/** Deliver an app event the way POST /api/events does. */
export interface EventTurn {
  event: { room: RoomKey; source: string; summary: string; detail?: string };
}
/** Answer the person's open question from the app's inbox (not the chat); `taps` > 1 sends it that many times at once, like a double tap. */
export interface AnswerTurn {
  answer: { personId: string; text: string; taps?: number };
}
export type Turn = MessageTurn | TickTurn | EventTurn | AnswerTurn;

export interface Check {
  name: string;
  /** What a pass proves, in one sentence. */
  detail: string;
  /** True when a model that only chats passes this check anyway (a "no outreach" check, say). The offline test verifies the label. */
  noOpPasses?: true;
  pass(app: App, world: EvalWorld): boolean;
}

/** What the scenario is allowed to leave behind. Counts are new rows; outreach lists evidenced calls by tool name, one entry per call. */
export interface Expects {
  commitments?: number;
  schedules?: number;
  memories?: number;
  attention?: number;
  outreach?: string[];
}

export interface Scenario {
  name: string;
  description: string;
  category: Category;
  shape: Shape;
  /** Rows of docs/use-cases.md §3 this scenario stands for. */
  cases?: number[];
  setup?(app: App, world: EvalWorld): void;
  turns: Turn[];
  checks: Check[];
  /** The well-behaved scripted model for this scenario; the offline test plays it and expects every check to pass. */
  script?: Script;
  expects?: Expects;
}

export interface CheckResult {
  name: string;
  detail: string;
  pass: boolean;
  noOpPasses?: true;
  error?: string;
}

/** One record per run a turn produced (a tick may fire several, or none). `tools` lists the run's tool calls, a trailing + marking stored evidence. */
export interface TurnRecord {
  kind: "message" | "tick" | "event" | "answer";
  room: string;
  personId: string;
  runId?: string;
  status?: string;
  trigger?: string;
  tools: string[];
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
  turns: TurnRecord[];
  /** What happened, run by run, as an editor would read it: [USER] [ACTION] [OBSERVATION] [GATE] [REPLY] [QUIET]. */
  trace: string[];
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
  skillsDir?: string;
  onTurn?: (turn: Turn, result: TurnRecord) => void;
}

/**
 * The catalogue carries twins of some core tools (a business call, a page read by another name).
 * Graders judge the action, so a twin counts as the tool it mirrors.
 */
const TWINS: Record<string, string> = { browser_use: "browse_page" };
export const canonical = (tool: string) => TWINS[tool] ?? tool;

/** Side-effect tools that reach a third party; evidenced calls to these are what `expects.outreach` declares. */
export const OUTREACH_TOOLS = ["place_call", "send_sms", "post_community", "send_agent_email"];

interface Counts {
  memories: Record<string, number>;
  commitments: number;
  schedules: number;
  attention: number;
  /** Evidenced side-effect calls by tool name. */
  effects: Record<string, number>;
}

function count(app: App, w: EvalWorld): Counts {
  const memories: Record<string, number> = {};
  for (const m of app.store.listMemories(w.agent.id)) memories[m.scope] = (memories[m.scope] ?? 0) + 1;
  const effects: Record<string, number> = {};
  for (const r of app.store.listRuns({ agentId: w.agent.id, limit: 200 }))
    for (const c of app.store.toolCallsForRun(r.id)) if (c.evidence && TOOL_INDEX.get(c.name)?.sideEffect) effects[canonical(c.name)] = (effects[canonical(c.name)] ?? 0) + 1;
  return {
    memories,
    commitments: app.store.listCommitments().length,
    schedules: app.store.listSchedules({ agentId: w.agent.id }).length,
    attention: app.store.listAttention({ agentId: w.agent.id }).length,
    effects,
  };
}

/** Everything that grew past what `expects` allows, as readable fragments; empty means nothing else changed. */
function surplus(before: Counts, after: Counts, expects: Expects): string[] {
  const out: string[] = [];
  const over = (label: string, grew: number, allowed: number) => {
    if (grew > allowed) out.push(`${label} +${grew} (expected ${allowed})`);
  };
  // Notes and ledger entries are the agent's own bookkeeping and reach nobody, so they never fail the diff;
  // what a scenario declares for them is documentation. Schedules fire later and cards ask people: those count.
  over("schedules", after.schedules - before.schedules, expects.schedules ?? 0);
  over("attention items", after.attention - before.attention, expects.attention ?? 0);
  for (const name of OUTREACH_TOOLS) {
    const grew = (after.effects[name] ?? 0) - (before.effects[name] ?? 0);
    const allowed = (expects.outreach ?? []).filter((n) => n === name).length;
    if (grew > allowed) out.push(`outreach ${name} ×${grew} (expected ${allowed})`);
  }
  return out;
}

const toolList = (app: App, runId: string) =>
  app.store.toolCallsForRun(runId).map((c) => `${c.name}${c.evidence ? "+" : ""}${c.status === "running" || c.status === "stopped" ? "?" : ""}`);

export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<ScenarioResult> {
  const metered = new MeteredModel(opts.model);
  const world = evalWorld({ model: metered, modelId: opts.modelId, maxTurns: opts.maxTurns, skillsDir: opts.skillsDir });
  const { app } = world;
  const started = Date.now();
  const turns: TurnRecord[] = [];
  let before: Counts | undefined;
  let error: string | undefined;

  const record = (turn: Turn, rec: TurnRecord) => {
    turns.push(rec);
    opts.onTurn?.(turn, rec);
    if (rec.status === "failed") throw new Error(`run ${rec.runId} failed: ${app.store.getRun(rec.runId ?? "")?.failureReason ?? "unknown"}`);
  };
  const runIds = () => new Set(app.store.listRuns({ agentId: world.agent.id, limit: 200 }).map((r) => r.id));

  const play = async () => {
    scenario.setup?.(app, world);
    before = count(app, world);
    let first = true;
    for (const t of scenario.turns) {
      if ("tick" in t) {
        const known = runIds();
        world.clock.tick(t.tick);
        await app.scheduler.tick();
        const fired = app.store
          .listRuns({ agentId: world.agent.id, limit: 200 })
          .filter((r) => !known.has(r.id))
          .reverse();
        if (!fired.length) record(t, { kind: "tick", room: "", personId: "clock", status: "idle", tools: [] });
        for (const r of fired)
          record(t, { kind: "tick", room: world.keyOf(r.roomId), personId: "clock", runId: r.id, status: r.status, trigger: r.trigger, tools: toolList(app, r.id) });
        continue;
      }
      // A second between message turns so "after" checks compare real order, not a frozen clock.
      if (!first) world.clock.tick(1000);
      first = false;
      if ("event" in t) {
        const run = await app.runtime.handleEvent({ roomId: world.roomId(t.event.room), source: t.event.source, summary: t.event.summary, detail: t.event.detail });
        record(t, {
          kind: "event",
          room: t.event.room,
          personId: `event:${t.event.source}`,
          runId: run?.id,
          status: run?.status,
          trigger: run?.trigger,
          tools: run ? toolList(app, run.id) : [],
        });
        continue;
      }
      if ("answer" in t) {
        const item = app.attention.openFor(t.answer.personId).find((a) => a.agentId === world.agent.id && a.kind !== "connect_account");
        const runs = item ? await Promise.all(Array.from({ length: t.answer.taps ?? 1 }, () => app.runtime.answerAttention(item.id, t.answer.text, t.answer.personId))) : [];
        const run = runs.find(Boolean);
        record(t, {
          kind: "answer",
          room: item ? world.keyOf(item.roomId) : "",
          personId: t.answer.personId,
          runId: run?.id,
          status: run?.status,
          trigger: run?.trigger,
          tools: run ? toolList(app, run.id) : [],
        });
        continue;
      }
      const run = await app.runtime.handleMessage({ roomId: world.roomId(t.room), personId: t.personId, text: t.text });
      record(t, { kind: "message", room: t.room, personId: t.personId, runId: run?.id, status: run?.status, trigger: run?.trigger, tools: run ? toolList(app, run.id) : [] });
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
  // Setup may launch work of its own (a group-join introduction); let it finish before grading.
  await app.runtime.settle();

  const checks = grade(scenario.checks, app, world);
  if (scenario.expects) {
    // The snapshot is taken after setup; a scenario that broke before its turns is graded against the world as it was built.
    const extra = surplus(before ?? count(app, world), count(app, world), scenario.expects);
    checks.push({
      name: "nothing else changed",
      detail: extra.length
        ? `Beyond what the scenario declared: ${extra.join("; ")}.`
        : "Memories, commitments, schedules, attention items and evidenced outreach grew by no more than the scenario declared.",
      noOpPasses: true,
      pass: extra.length === 0,
    });
  }
  return finish(scenario, checks, app, world, metered, started, turns, error);
}

function grade(checks: Check[], app: App, world: EvalWorld): CheckResult[] {
  return checks.map((c) => {
    try {
      return { name: c.name, detail: c.detail, noOpPasses: c.noOpPasses, pass: c.pass(app, world) };
    } catch (e) {
      return { name: c.name, detail: c.detail, noOpPasses: c.noOpPasses, pass: false, error: String((e as Error).message ?? e) };
    }
  });
}

function finish(
  scenario: Scenario,
  checks: CheckResult[],
  app: App,
  world: EvalWorld,
  metered: MeteredModel,
  started: number,
  turns: TurnRecord[],
  error?: string,
): ScenarioResult {
  const runs = app.store.listRuns({ agentId: world.agent.id, limit: 200 }).reverse();
  const toolCalls = runs.reduce((n, r) => n + app.store.toolCallsForRun(r.id).length, 0);
  const clip = (v: unknown, n: number) => {
    const t = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const trace: string[] = [];
  for (const run of runs) {
    const roomName = world.keyOf?.(run.roomId) ?? run.roomId;
    const ask = app.store
      .messagesForRoom(run.roomId)
      .filter((m) => m.role === "user" && m.at <= run.startedAt)
      .at(-1);
    trace.push(`[RUN ${run.trigger} in ${roomName}]${ask ? ` [USER] ${clip(ask.text, 240)}` : ""}`);
    for (const c of app.store.toolCallsForRun(run.id)) {
      trace.push(`[ACTION] ${c.name}(${clip(c.input, 200)})`);
      trace.push(`[OBSERVATION] ${c.status}${c.evidence ? " with evidence" : ""}: ${clip(c.result, 300)}`);
    }
    for (const e of app.store.eventsForRun(run.id)) {
      if (e.type === "gate_opened") trace.push(`[GATE] ${String(e.data.kind)} for ${String(e.data.assigneeId)}: ${clip(e.data.title, 120)}`);
      if (e.type === "gate_resolved") trace.push(`[GATE] resolved: ${clip(e.data.answer ?? e.data.kind, 80)}`);
    }
    const reply = app.store
      .messagesForRoom(run.roomId)
      .filter((m) => m.runId === run.id && m.role === "assistant" && !m.source)
      .at(-1);
    if (run.quiet) trace.push(`[QUIET] ${clip(run.outcome, 120)}`);
    else if (reply) trace.push(`[REPLY] ${clip(reply.text, 400)}`);
    else trace.push(`[END] ${run.status}${run.failureReason ? `: ${clip(run.failureReason, 120)}` : ""}`);
  }
  return {
    name: scenario.name,
    trace,
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

/** How many scenarios stand for each category and shape (zeros included), and which use-case rows they cover. */
export function coverage(scenarios: Scenario[]): { categories: Record<Category, number>; shapes: Record<Shape, number>; cases: number[] } {
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const shapes = Object.fromEntries(SHAPES.map((s) => [s, 0])) as Record<Shape, number>;
  const cases = new Set<number>();
  for (const s of scenarios) {
    categories[s.category] += 1;
    shapes[s.shape] += 1;
    for (const c of s.cases ?? []) cases.add(c);
  }
  return { categories, shapes, cases: [...cases].sort((a, b) => a - b) };
}
