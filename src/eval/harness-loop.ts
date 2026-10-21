/**
 * Harness² for Circle (google-research/harness2, arXiv:2610.14224), sized to one process:
 * the harness is the markdown the agent reads (skills/_core-rules.md and skills/*.md),
 * the probe is the eval suite, and the composer is one rule rather than a judge.
 *
 *   reference   run the suite as it is; keep the failing scenarios
 *   propose     for each, an editor proposes two files: an invariant edit (core rules) and a domain edit (a skill)
 *   probe       each candidate replays that scenario from a temp copy of the skills folder
 *   compose     adopt a candidate only when a failed check now passes and, across the whole suite, nothing regresses
 *   reflect     adopted files land in skills/ for review in git; the lesson and its evidence go to skills/EXPERIENCE.md
 *
 * Nothing here touches production: the output is a diff and a note.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient } from "../model/types.ts";
import { loadSkills, matchSkills } from "../skills/skills.ts";
import { type RunOptions, runScenario, type Scenario, type ScenarioResult } from "./harness.ts";

export interface Candidate {
  kind: "invariant" | "domain";
  file: string;
  content: string;
  why: string;
}

/** The editor: sees the failure and the current files, returns two candidate files. Pluggable so the loop is testable offline. */
export type Proposer = (input: { scenario: Scenario; result: ScenarioResult; files: Record<string, string>; lessons: string }) => Promise<Candidate[]>;

export interface LoopOptions extends RunOptions {
  scenarios: Scenario[];
  skillsDir: string;
  proposer: Proposer;
  /** Adopt at most this many candidates per run; each costs a full-suite confirmation. */
  maxAdoptions?: number;
  log?: (line: string) => void;
}

export interface LoopReport {
  baseline: ScenarioResult[];
  adopted: { candidate: Candidate; scenario: string; fixed: string[] }[];
  rejected: { candidate: Candidate; scenario: string; reason: string }[];
}

const failedChecks = (r: ScenarioResult) => r.checks.filter((c) => !c.pass).map((c) => c.name);
const passedSet = (rs: ScenarioResult[]) => new Set(rs.flatMap((r) => r.checks.filter((c) => c.pass).map((c) => `${r.name}:${c.name}`)));

function readFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.endsWith(".md")) out[f] = readFileSync(join(dir, f), "utf8");
  return out;
}

/** A temp copy of the skills folder with one file replaced: what a candidate harness looks like on disk. */
function stage(skillsDir: string, candidate: Candidate): string {
  const dir = mkdtempSync(join(tmpdir(), "circle-harness-"));
  cpSync(skillsDir, dir, { recursive: true });
  writeFileSync(join(dir, candidate.file), candidate.content);
  return dir;
}

export async function harnessLoop(opts: LoopOptions): Promise<LoopReport> {
  const log = opts.log ?? (() => undefined);
  const run = (scenarios: Scenario[], skillsDir: string) => Promise.all(scenarios.map((s) => runScenario(s, { ...opts, skillsDir })));
  const baseline = await run(opts.scenarios, opts.skillsDir);
  const failing = baseline.filter((r) => failedChecks(r).length);
  log(`reference: ${baseline.length - failing.length}/${baseline.length} scenarios pass`);
  const report: LoopReport = { baseline, adopted: [], rejected: [] };
  let currentDir = opts.skillsDir;
  let passing = passedSet(baseline);
  const experiencePath = join(opts.skillsDir, "EXPERIENCE.md");
  const lessons = existsSync(experiencePath) ? readFileSync(experiencePath, "utf8") : "";

  for (const result of failing) {
    if (report.adopted.length >= (opts.maxAdoptions ?? 2)) break;
    const scenario = opts.scenarios.find((s) => s.name === result.name)!;
    const candidates = await opts.proposer({ scenario, result, files: readFiles(currentDir), lessons });
    for (const candidate of candidates.slice(0, 2)) {
      if (!candidate.file.endsWith(".md") || candidate.file.includes("/") || !candidate.content.trim()) {
        report.rejected.push({ candidate, scenario: scenario.name, reason: "not a markdown file in skills/" });
        continue;
      }
      // Probe: the failing scenario alone, from the candidate folder.
      const dir = stage(currentDir, candidate);
      const probe = await runScenario(scenario, { ...opts, skillsDir: dir });
      const fixed = failedChecks(result).filter((name) => probe.checks.find((c) => c.name === name)?.pass);
      if (!fixed.length) {
        report.rejected.push({ candidate, scenario: scenario.name, reason: "fixed nothing it was asked to fix" });
        log(`${scenario.name} / ${candidate.kind}: no fix`);
        continue;
      }
      // Compose: the whole suite from the candidate folder; a single regression rejects it.
      const full = await run(opts.scenarios, dir);
      let now = passedSet(full);
      let regressions = [...passing].filter((k) => !now.has(k));
      if (regressions.length) {
        // Executions are noisy (Harness² says so too): a regression counts only if it repeats on a second run of that scenario.
        const suspects = opts.scenarios.filter((sc) => regressions.some((k) => k.startsWith(`${sc.name}:`)));
        const again = passedSet(await run(suspects, dir));
        regressions = regressions.filter((k) => !again.has(k));
        now = new Set([...now, ...again]);
      }
      if (regressions.length) {
        report.rejected.push({ candidate, scenario: scenario.name, reason: `regressed ${regressions.join(", ")}` });
        log(`${scenario.name} / ${candidate.kind}: fixed ${fixed.join(", ")} but regressed ${regressions.length}`);
        continue;
      }
      currentDir = dir;
      passing = now;
      report.adopted.push({ candidate, scenario: scenario.name, fixed });
      log(`${scenario.name} / ${candidate.kind}: adopted (${fixed.join(", ")})`);
      // One adoption per scenario per step: a second candidate would be credited with fixes the first one made.
      break;
    }
  }

  // Reflect: adopted files into the real folder for review; the lesson and its evidence into EXPERIENCE.md.
  if (report.adopted.length) {
    for (const a of report.adopted) writeFileSync(join(opts.skillsDir, a.candidate.file), a.candidate.content);
    const date = new Date().toISOString().slice(0, 10);
    const entry = report.adopted
      .map(
        (a) =>
          `## ${date} · ${a.scenario} · ${a.candidate.kind} edit to ${a.candidate.file}\n${a.candidate.why.trim()}\nEvidence: checks "${a.fixed.join('", "')}" went from fail to pass; no check in the suite regressed.\n`,
      )
      .join("\n");
    writeFileSync(
      experiencePath,
      `${lessons.trimEnd()}${lessons ? "\n\n" : "# What the harness loop learned\n\nEvidence-backed lessons, newest last. Each entry is an adopted edit; the diff is in git.\n\n"}${entry}`,
    );
  }
  return report;
}

/** The editor prompt for a real model: two complete files, as JSON. */
export function modelProposer(model: ModelClient, modelId?: string): Proposer {
  return async ({ scenario, result, files, lessons }) => {
    const skills = loadSkills(stageless(files));
    const first = scenario.turns.find((t) => "text" in t) as { text: string } | undefined;
    // The domain file is the procedure that matched the request; the always-on manners file is not a procedure.
    const domain = matchSkills(skills, first?.text ?? "", { group: false })[0]?.name;
    const domainFile = domain ? `${domain}.md` : `${scenario.category}.md`;
    const raw = await model.complete({
      model: modelId,
      system:
        "You improve the instructions an assistant reads (its harness), not its code. Return only JSON: an array of two objects " +
        '{"kind":"invariant"|"domain","file":"<name>.md","content":"<the complete new file>","why":"<one sentence: which deficiency this addresses>"}. ' +
        "The invariant edit changes _core-rules.md: a general rule about planning, tool use, asking, delegating or reporting that would help in any chat. " +
        `The domain edit changes ${domainFile} (create it if missing, with the same frontmatter shape as the others): a procedure for this kind of errand. ` +
        "Keep every existing line unless it is the cause; add at most three lines per file; never weaken a rule about asking before spending, contacting anyone or using an account; never mention this scenario by name.",
      prompt: `Scenario "${scenario.name}" (${scenario.category}, ${scenario.shape}): ${scenario.description}\n\nFailed checks:\n${result.checks
        .filter((c) => !c.pass)
        .map((c) => `- ${c.name}: ${c.detail}`)
        .join(
          "\n",
        )}\n\nWhat the agent did (tools per turn):\n${result.turns.map((t) => `- ${t.tools.join(" > ") || "(no tools)"} → ${t.status ?? "?"}`).join("\n")}\n\nLessons already learned:\n${lessons.slice(-3000) || "(none)"}\n\nCurrent _core-rules.md:\n${files["_core-rules.md"] ?? "(missing)"}\n\nCurrent ${domainFile}:\n${files[domainFile] ?? "(missing)"}\n\nJSON:`,
      maxTokens: 6000,
    });
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    const parsed = start >= 0 && end > start ? (JSON.parse(raw.slice(start, end + 1)) as Partial<Candidate>[]) : [];
    return parsed
      .filter((c): c is Candidate => (c.kind === "invariant" || c.kind === "domain") && typeof c.file === "string" && typeof c.content === "string")
      .map((c) => ({ ...c, why: c.why ?? "" }));
  };
}

/** loadSkills reads a directory; the proposer already holds the files, so it writes them to a temp folder first. */
function stageless(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "circle-skills-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
