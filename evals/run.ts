// bun run eval [suite|case-prefix] [--min=0.9]                 golden tasks (platform behaviors)
// bun run eval:live [suite|id-prefix] [--repeat=3] [--jobs=6]   real-usage scenarios over real channels, LLM-judged
// Real models when keys are set (OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY), offline heuristic otherwise.
// Writes reports/eval-*.json and exits 1 below --min (case pass rate).
process.env.KEEP_MODEL_KEYS = "1";
const { mkdirSync, writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const filter = args.find((a) => !a.startsWith("--"));
const min = Number(opt("min", "1"));
const save = (kind: string, r: any) => {
  mkdirSync("reports", { recursive: true });
  const file = `reports/${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(r, null, 2)); console.log(`report: ${file}`);
};

if (args.includes("--live")) {
  process.env.EVAL_LIVE_WEB = "1";
  const { SCENARIOS, runScenario, SCENARIO_VERSION } = await import("./scenarios");
  const one = opt("one", "");
  if (one) { // worker mode: run one scenario in this process (each gets its own in-memory DB) and print JSON
    const r = await runScenario(SCENARIOS.find((s) => s.id === one)!);
    process.stdout.write("\n@@RESULT@@" + JSON.stringify(r) + "\n"); process.exit(0);
  }
  const picked = SCENARIOS.filter((s) => !filter || s.id.startsWith(filter) || s.suite === filter || s.agent.startsWith(filter));
  const repeat = Number(opt("repeat", "1")), jobs = Number(opt("jobs", "6"));
  const queue = picked.flatMap((s) => Array.from({ length: repeat }, (_, i) => ({ s, i })));
  const runs: any[] = [];
  console.log(`${picked.length} scenarios × ${repeat} = ${queue.length} runs, ${jobs} at a time`);
  await Promise.all(Array.from({ length: jobs }, async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const p = Bun.spawn(["bun", "--env-file=.env.local", import.meta.path, "--live", `--one=${q.s.id}`], { stdout: "pipe", stderr: "pipe", env: process.env });
      const out = await new Response(p.stdout).text(); await p.exited;
      const m = out.split("@@RESULT@@")[1];
      const r = m ? JSON.parse(m) : { id: q.s.id, suite: q.s.suite, agent: q.s.agent, channel: q.s.channel, pass: false, crashed: true, results: [{ kind: "check", label: "scenario crashed", pass: false }], transcript: (await new Response(p.stderr).text()).slice(-800), tools: [], cost_usd: 0, seconds: 0 };
      runs.push(r);
      console.log(`${r.status === "pass" ? "✓" : r.status === "not_evaluated" ? "?" : "✗"} ${r.id}${repeat > 1 ? ` #${q.i + 1}` : ""}  (${r.seconds}s, $${r.cost_usd})${r.status === "not_evaluated" ? "  checks passed, NOT EVALUATED by the judge" : ""}`);
      if (r.infra) console.log(`    ⚠ ${r.infra}`);
      for (const x of r.results.filter((x: any) => x.kind === "not_evaluated")) console.log(`    ? ${x.label}: ${x.why}`);
      for (const x of r.results.filter((x: any) => !x.pass && x.kind !== "not_evaluated")) console.log(`    ✗ [${x.kind}] ${x.label}${x.why ? ` — ${x.why}` : ""}`);
      if (!r.pass && args.includes("--show")) console.log("    ┄ " + (r.transcript || "(no messages)").replace(/\n/g, "\n    ┄ ").slice(0, 1500) + `\n    ┄ tools: ${r.tools.join(", ") || "none"}`);
    }
  }));
  // Per scenario: pass@1 (share of attempts that passed) and pass^k (every attempt passed = reliable).
  const ids = [...new Set(runs.map((r) => r.id))];
  const per = ids.map((id) => { const rs = runs.filter((r) => r.id === id); return { id, suite: rs[0].suite, agent: rs[0].agent, channel: rs[0].channel,
    pass_rate: rs.filter((r) => r.pass).length / rs.length, reliable: rs.every((r) => r.pass), not_evaluated: rs.filter((r) => r.status === "not_evaluated").length }; });
  const crit = runs.flatMap((r) => r.results);
  const rate = (xs: any[], f: (x: any) => boolean) => (xs.length ? +(xs.filter(f).length / xs.length).toFixed(3) : 1);
  const groupBy = (k: string) => Object.fromEntries([...new Set(per.map((p: any) => p[k]))].map((v) => [v, rate(per.filter((p: any) => p[k] === v), (p) => p.reliable)]));
  const judged = runs.filter((r) => r.status !== "not_evaluated");
  const summary = { dataset: SCENARIO_VERSION, scenarios: per.length, runs: runs.length,
    passed: runs.filter((r) => r.status === "pass").length, failed: runs.filter((r) => r.status === "fail").length, not_evaluated: runs.length - judged.length,
    pass_at_1_of_evaluated: judged.length ? rate(judged, (r) => r.pass) : null, reliable: rate(per.filter((p) => !p.not_evaluated), (p) => p.reliable),
    checks: rate(crit.filter((c: any) => c.kind === "check"), (c) => c.pass), judge: crit.some((c: any) => c.kind === "judge") ? rate(crit.filter((c: any) => c.kind === "judge"), (c) => c.pass) : "not evaluated",
    infra_problems: runs.filter((r) => r.infra).length,
    by_suite: groupBy("suite"), by_channel: groupBy("channel"),
    cost_usd: +runs.reduce((a, r) => a + r.cost_usd, 0).toFixed(4), avg_seconds: Math.round(runs.reduce((a, r) => a + r.seconds, 0) / Math.max(1, runs.length)) };
  console.log("\n", JSON.stringify(summary, null, 2));
  save("eval-live", { summary, per, runs });
  // Not-evaluated runs don't pass a release gate: exit non-zero unless every run was judged and the rate clears --min.
  process.exit(summary.not_evaluated === 0 && (summary.pass_at_1_of_evaluated ?? 0) >= min ? 0 : 1);
}

const { runAll } = await import("./golden");
const r = await runAll(filter);
for (const c of r.cases) {
  console.log(`${c.pass ? "✓" : "✗"} ${c.id}`);
  for (const x of c.results.filter((x) => !x.pass)) console.log(`    ✗ [${x.dim}] ${x.label}\n      tools: ${c.tools.join(", ") || "none"}\n      reply: ${c.reply.replace(/\n/g, " ").slice(0, 160)}`);
}
console.log("\n", JSON.stringify(r.summary, null, 2));
save("eval", r);
process.exit(r.summary.case_pass_rate >= min ? 0 : 1);
