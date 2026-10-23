/**
 * `bun run eval [--model <id>] [--only <name>] [--category <c>] [--shape <s>] [--trials <k>] [--list] [--json] [--timeout <ms>]`
 *
 * Plays each scenario through the real runtime with the configured model and
 * fake hands, grades the store, prints a table, and exits non-zero when any
 * check fails in any trial. `--trials k` plays every scenario k times on
 * fresh worlds and reports pass^k (τ-bench: a scenario counts only when all k
 * pass). `--list` prints coverage without spending anything. Needs model
 * credentials (OPENROUTER_API_KEY or ANTHROPIC_API_KEY); the offline proof
 * that the graders work is `bun test test/eval.test.ts`.
 */
import { createModel, modelConfig } from "../model/config.ts";
import { CATEGORIES, coverage, runScenario, type Scenario, type ScenarioResult, SHAPES, type Turn } from "./harness.ts";
import { findScenarios, SCENARIOS } from "./scenarios.ts";

interface Args {
  model?: string;
  only?: string;
  category?: string;
  shape?: string;
  trials: number;
  list: boolean;
  json: boolean;
  timeout: number;
}

const USAGE = `usage: bun run eval [--model <id>] [--only <name>] [--category <c>] [--shape <s>] [--trials <k>] [--list] [--json] [--timeout <ms>]
scenarios: ${SCENARIOS.map((s) => s.name).join(", ")}
categories: ${CATEGORIES.join(", ")}
shapes: ${SHAPES.join(", ")}`;

function parseArgs(argv: string[]): Args {
  const out: Args = { trials: 1, list: false, json: false, timeout: 180_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--list") out.list = true;
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--only") out.only = argv[++i];
    else if (a === "--category") out.category = argv[++i];
    else if (a === "--shape") out.shape = argv[++i];
    else if (a === "--trials") out.trials = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown argument ${a}\n${USAGE}`);
      process.exit(2);
    }
  }
  return out;
}

function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function listing(scenarios: Scenario[]): string {
  const c = coverage(scenarios);
  const rows = scenarios.map((s) => [s.name, s.category, s.shape, (s.cases ?? []).join(", ")]);
  const cats = Object.entries(c.categories).map(([name, n]) => [name, String(n)]);
  const shapes = Object.entries(c.shapes).map(([name, n]) => [name, String(n)]);
  const uncovered = Object.entries(c.categories)
    .filter(([, n]) => n === 0)
    .map(([name]) => name);
  return [
    `${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}\n`,
    table(["scenario", "category", "shape", "cases"], rows),
    "",
    table(["category", "scenarios"], cats),
    "",
    table(["shape", "scenarios"], shapes),
    "",
    `cases covered (${c.cases.length}): ${c.cases.join(", ") || "none"}`,
    `categories not covered: ${uncovered.join(", ") || "none"}`,
  ].join("\n");
}

/** Per-scenario summary over k trials: passes out of k, the worst trial's checks, and sums. */
function summarize(name: string, trials: ScenarioResult[]) {
  const passes = trials.filter((r) => r.passed === r.total && !r.error).length;
  const worst = trials.reduce((a, b) => (b.passed - (b.error ? 1 : 0) < a.passed - (a.error ? 1 : 0) ? b : a));
  const sum = (f: (r: ScenarioResult) => number) => trials.reduce((n, r) => n + f(r), 0);
  return {
    name,
    passes,
    worst,
    toolCalls: sum((r) => r.toolCalls),
    modelTurns: sum((r) => r.modelTurns),
    elapsedMs: sum((r) => r.elapsedMs),
    tokens: { input: sum((r) => r.tokens.input), output: sum((r) => r.tokens.output) },
  };
}

function describeTurn(t: Turn): string {
  if ("tick" in t) return `[clock] +${(t.tick / 3_600_000).toFixed(1)}h`;
  if ("event" in t) return `[${t.event.room}] event:${t.event.source}: ${t.event.summary.slice(0, 60)}`;
  if ("answer" in t) return `[inbox] ${t.answer.personId}: ${t.answer.text}${(t.answer.taps ?? 1) > 1 ? ` (x${t.answer.taps})` : ""}`;
  return `[${t.room}] ${t.personId}: ${t.text.slice(0, 70)}${t.text.length > 70 ? "…" : ""}`;
}

const args = parseArgs(process.argv.slice(2));
const scenarios = findScenarios(args.only, { category: args.category, shape: args.shape });
if (!scenarios.length) {
  console.error(`No scenario matches. Known: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(2);
}
if (args.list) {
  console.log(listing(scenarios));
  process.exit(0);
}

const cfg = modelConfig();
const model = createModel(cfg);
if (!model) {
  console.error("No model credentials (OPENROUTER_API_KEY or ANTHROPIC_API_KEY). The offline check is `bun test test/eval.test.ts`; `--list` needs none.");
  process.exit(2);
}
const modelId = args.model ?? cfg.model;
const k = args.trials;
if (!args.json) console.log(`Eval: ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"} × ${k} trial${k === 1 ? "" : "s"} on ${modelId} via ${cfg.provider}\n`);

const all: { scenario: string; trials: ScenarioResult[] }[] = [];
for (const s of scenarios) {
  const trials: ScenarioResult[] = [];
  for (let i = 0; i < k; i++) {
    if (!args.json) console.log(`${s.name}${k > 1 ? ` (trial ${i + 1}/${k})` : ""}`);
    const r = await runScenario(s, {
      model,
      modelId,
      timeoutMs: args.timeout,
      onTurn: args.json
        ? undefined
        : (t, rec) =>
            console.log(
              `  ${describeTurn(t)}  →  ${rec.status ?? "ignored"}${rec.trigger && rec.kind !== "message" ? ` (${rec.trigger})` : ""}${rec.tools.length ? `  [${rec.tools.join(", ")}]` : ""}`,
            ),
    });
    trials.push(r);
    if (!args.json) {
      for (const c of r.checks) console.log(`  ${c.pass ? "pass" : "FAIL"}  ${c.name}${c.pass ? "" : ` — ${c.detail}${c.error ? ` (${c.error})` : ""}`}`);
      if (r.error) console.log(`  error: ${r.error}`);
      console.log("");
    }
  }
  all.push({ scenario: s.name, trials });
}

const summaries = all.map((a) => summarize(a.scenario, a.trials));
const solid = summaries.filter((s) => s.passes === k).length;
if (args.json) {
  console.log(JSON.stringify({ model: modelId, provider: cfg.provider, trials: k, passK: solid / summaries.length, results: all }, null, 2));
} else {
  const head = ["scenario", ...(k > 1 ? ["passes"] : []), "checks", "tools", "turns", "elapsed", "tokens (est.)"];
  const rows = summaries.map((s) => [
    s.name,
    ...(k > 1 ? [`${s.passes}/${k}`] : []),
    `${s.worst.passed}/${s.worst.total}${s.worst.error ? " !" : ""}${k > 1 ? " (worst)" : ""}`,
    String(s.toolCalls),
    String(s.modelTurns),
    `${(s.elapsedMs / 1000).toFixed(1)}s`,
    `${s.tokens.input + s.tokens.output} (${s.tokens.input} in, ${s.tokens.output} out)`,
  ]);
  console.log(table(head, rows));
  console.log(`\n${solid}/${summaries.length} scenarios fully passed${k > 1 ? ` in all ${k} trials (pass^${k} = ${(solid / summaries.length).toFixed(2)})` : ""}.`);
}
process.exit(solid === summaries.length ? 0 : 1);
