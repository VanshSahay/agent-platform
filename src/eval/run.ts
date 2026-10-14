/**
 * `bun run eval [--model <id>] [--only <name>] [--json] [--timeout <ms>]`
 *
 * Plays each scenario through the real runtime with the configured model and
 * fake hands, grades the store, prints a table, and exits non-zero when any
 * check fails. Needs model credentials (OPENROUTER_API_KEY or
 * ANTHROPIC_API_KEY); the offline proof that the graders work is
 * `bun test test/eval.test.ts`.
 */
import { createModel, modelConfig } from "../model/config.ts";
import { runScenarios, type ScenarioResult } from "./harness.ts";
import { findScenarios, SCENARIOS } from "./scenarios.ts";

function parseArgs(argv: string[]) {
  const out: { model?: string; only?: string; json: boolean; timeout: number } = { json: false, timeout: 180_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--only") out.only = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(`usage: bun run eval [--model <id>] [--only <name>] [--json] [--timeout <ms>]\nscenarios: ${SCENARIOS.map((s) => s.name).join(", ")}`);
      process.exit(0);
    } else {
      console.error(`unknown argument ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function table(results: ScenarioResult[]): string {
  const rows = results.map((r) => [
    r.name,
    `${r.passed}/${r.total}${r.error ? " !" : ""}`,
    String(r.toolCalls),
    String(r.modelTurns),
    `${(r.elapsedMs / 1000).toFixed(1)}s`,
    `${r.tokens.input + r.tokens.output} (${r.tokens.input} in, ${r.tokens.output} out)`,
  ]);
  const head = ["scenario", "checks", "tools", "turns", "elapsed", "tokens (est.)"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

const args = parseArgs(process.argv.slice(2));
const cfg = modelConfig();
const model = createModel(cfg);
if (!model) {
  console.error("No model credentials (OPENROUTER_API_KEY or ANTHROPIC_API_KEY). The offline check is `bun test test/eval.test.ts`.");
  process.exit(2);
}
const modelId = args.model ?? cfg.model;
const scenarios = findScenarios(args.only);
if (!scenarios.length) {
  console.error(`No scenario matches "${args.only}". Known: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(2);
}
if (!args.json) console.log(`Eval: ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"} on ${modelId} via ${cfg.provider}\n`);

const results = await runScenarios(scenarios, {
  model,
  modelId,
  timeoutMs: args.timeout,
  onTurn: args.json
    ? undefined
    : (t, r) =>
        console.log(
          `  [${t.room}] ${t.personId}: ${t.text.slice(0, 70)}${t.text.length > 70 ? "…" : ""}  →  ${r.status ?? "ignored"}${r.tools.length ? `  [${r.tools.join(", ")}]` : ""}`,
        ),
  onResult: args.json
    ? undefined
    : (r) => {
        for (const c of r.checks) console.log(`  ${c.pass ? "pass" : "FAIL"}  ${c.name}${c.pass ? "" : ` — ${c.detail}${c.error ? ` (${c.error})` : ""}`}`);
        if (r.error) console.log(`  error: ${r.error}`);
        console.log("");
      },
});

if (args.json) console.log(JSON.stringify({ model: modelId, provider: cfg.provider, results }, null, 2));
else console.log(table(results));

const failed = results.filter((r) => r.passed < r.total || r.error);
if (!args.json) console.log(`\n${results.length - failed.length}/${results.length} scenarios fully passed.`);
process.exit(failed.length ? 1 : 0);
