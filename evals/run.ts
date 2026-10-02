// bun run eval [suite|case-prefix] [--min=0.9]
// Runs golden tasks against whatever model the profiles resolve to (offline heuristic without keys; real models with
// ANTHROPIC_API_KEY / OPENAI_API_KEY). Writes reports/eval-<timestamp>.json and exits 1 below the threshold.
process.env.KEEP_MODEL_KEYS = "1";
const { runAll } = await import("./golden");
const { mkdirSync, writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
const min = Number(args.find((a) => a.startsWith("--min="))?.slice(6) ?? 1);
const r = await runAll(args.find((a) => !a.startsWith("--")));
for (const c of r.cases) {
  console.log(`${c.pass ? "✓" : "✗"} ${c.id}`);
  for (const x of c.results.filter((x) => !x.pass)) console.log(`    ✗ [${x.dim}] ${x.label}\n      tools: ${c.tools.join(", ") || "none"}\n      reply: ${c.reply.replace(/\n/g, " ").slice(0, 160)}`);
}
console.log("\n", JSON.stringify(r.summary, null, 2));
mkdirSync("reports", { recursive: true });
const file = `reports/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(r, null, 2));
console.log(`report: ${file}`);
process.exit(r.summary.case_pass_rate >= min ? 0 : 1);
