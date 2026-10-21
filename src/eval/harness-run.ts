/**
 * `bun run harness [--only <name>] [--max-adoptions n] [--timeout ms]`
 *
 * One Harness² step over the skills folder with the configured model: reference run,
 * proposals for each failing scenario, probes, full-suite confirmation, then the adopted
 * files written into skills/ (review with git diff) and the lesson appended to
 * skills/EXPERIENCE.md. Spends money; the offline proof is test/harness-loop.test.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModel, modelConfig } from "../model/config.ts";
import { harnessLoop, modelProposer } from "./harness-loop.ts";
import { findScenarios } from "./scenarios.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = modelConfig();
const model = createModel(cfg);
if (!model) {
  console.error("No model credentials (OPENROUTER_API_KEY or ANTHROPIC_API_KEY).");
  process.exit(2);
}
const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const report = await harnessLoop({
  scenarios: findScenarios(flag("--only")),
  skillsDir,
  model,
  modelId: cfg.model,
  timeoutMs: Number(flag("--timeout") ?? 240_000),
  maxAdoptions: Number(flag("--max-adoptions") ?? 2),
  proposer: modelProposer(model, cfg.model),
  log: (l) => console.log(l),
});
console.log(`\nadopted ${report.adopted.length} of ${report.verdicts.length} candidates; flaky: ${report.flaky.join(", ") || "none"}`);
for (const v of report.verdicts) console.log(`  ${v.verdict.padEnd(14)} ${v.scenario} / ${v.candidate.kind} → ${v.candidate.file}: ${v.detail}`);
if (report.adopted.length) console.log("Review with: git diff skills/");
process.exit(0);
