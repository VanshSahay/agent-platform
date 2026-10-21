/**
 * Harness² for Circle (google-research/harness2, arXiv:2610.14224), sized to one process:
 * the harness is the markdown the agent reads (skills/_core-rules.md and skills/*.md),
 * the probe is the eval suite, and the composer is a rule rather than a judge.
 *
 *   reference   run the suite; a failure counts only when it repeats on a second run
 *   propose     two scoped editors: an invariant rule (core) and a domain procedure (a skill)
 *   validate    frontmatter, the procedure must match the request, rules cannot be weakened; one retry
 *   probe       replay the scenario from a temp copy of the folder; a fix must repeat
 *   compose     adopt only when nothing in the suite regresses (a regression must repeat too)
 *   reflect     adopted files land in skills/ for review; every verdict and its evidence go to EXPERIENCE.md
 *
 * What Harness² does with an LLM composer and selector, the suite does here. What transfers is the
 * editor's briefing (full trajectories, prior verdicts), candidate validation, and the record.
 * Nothing touches production: the output is a diff and a note.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient } from "../model/types.ts";
import { matchSkills, parseSkill } from "../skills/skills.ts";
import { type RunOptions, runScenario, type Scenario, type ScenarioResult } from "./harness.ts";

export interface Candidate {
  kind: "invariant" | "domain";
  file: string;
  content: string;
  why: string;
}
export type VerdictKind = "adopted" | "invalid" | "no change" | "no effect" | "did not repeat" | "hurt" | "not probed";
export interface Verdict {
  candidate: Candidate;
  scenario: string;
  verdict: VerdictKind;
  detail: string;
  fixed?: string[];
}

/** The editor: sees the failure, both reference trajectories, the files, prior verdicts; returns candidates. */
export type Proposer = (input: {
  scenario: Scenario;
  results: ScenarioResult[];
  files: Record<string, string>;
  lessons: string;
  prior: Verdict[];
  feedback?: string;
}) => Promise<Candidate[]>;

export interface LoopOptions extends RunOptions {
  scenarios: Scenario[];
  skillsDir: string;
  proposer: Proposer;
  /** Adopt at most this many candidates per step; each costs a full-suite confirmation. */
  maxAdoptions?: number;
  /** Proposal rounds per scenario; a second round sees the first round's verdicts. */
  rounds?: number;
  /**
   * Harness²'s composer, sized to one file: after a step that changed the core rules, a rewrite of
   * _core-rules.md as one coherent rulebook (no rule added or dropped). Adopted only when the whole
   * suite still passes everything it passed before.
   */
  composer?: (core: string, adopted: Verdict[]) => Promise<string | undefined>;
  log?: (line: string) => void;
}

export interface LoopReport {
  baseline: ScenarioResult[];
  flaky: string[];
  verdicts: Verdict[];
  adopted: Verdict[];
  /** What the composer did with the core rules this step, if it ran. */
  composed?: "adopted" | "rejected" | "unchanged";
}

const CORE = "_core-rules.md";
const failedChecks = (r: ScenarioResult) => r.checks.filter((c) => !c.pass).map((c) => c.name);
const passedSet = (rs: ScenarioResult[]) => new Set(rs.flatMap((r) => r.checks.filter((c) => c.pass).map((c) => `${r.name}:${c.name}`)));
const firstAsk = (s: Scenario) => (s.turns.find((t) => "text" in t) as { text: string } | undefined)?.text ?? "";
/** Rule lines that must never be dropped by an edit: anything about asking, approval, spending or contacting. */
const GUARD = /\b(ask|asks|approval|approve|gate|spend|money|contact|account)\b/i;

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

/** Why a candidate cannot be probed, or undefined when it can. Harness² found the untriggered procedure its most common invalid edit. */
export function validate(c: Candidate, scenario: Scenario, files: Record<string, string>, scenarioNames: string[]): string | undefined {
  if (!c.file.endsWith(".md") || c.file.includes("/") || !c.content.trim()) return "not a markdown file in skills/";
  if (c.kind === "invariant" && c.file !== CORE) return `an invariant edit changes ${CORE}, not ${c.file}`;
  if (c.kind === "domain" && (c.file === CORE || c.file === "EXPERIENCE.md")) return "a domain edit is a procedure file";
  const skill = parseSkill(c.content);
  if (!skill) return "missing frontmatter (name and when)";
  const lower = c.content.toLowerCase();
  const named = scenarioNames.find((n) => lower.includes(n.toLowerCase()));
  if (named) return `names the scenario "${named}"; rules must not know the test`;
  const current = files[c.file];
  if (current !== undefined && current.trim() === c.content.trim()) return "identical to the current file";
  if (c.kind === "invariant") {
    const before = (current ?? "").split("\n");
    const after = c.content.split("\n");
    if (after.length > before.length + 3) return `adds more than three lines (${after.length - before.length})`;
    const dropped = before.filter((l) => l.startsWith("- ") && GUARD.test(l) && !after.includes(l));
    if (dropped.length) return `removes or rewrites a guard rule: "${dropped[0]!.slice(0, 80)}"`;
  } else if (!skill.name.startsWith("_")) {
    const text = firstAsk(scenario);
    if (text && !matchSkills([skill], text, { group: scenario.shape !== "solo" }).length) return `its "when" line would not match the request, so it would never load`;
  }
  return undefined;
}

export async function harnessLoop(opts: LoopOptions): Promise<LoopReport> {
  const log = opts.log ?? (() => undefined);
  const names = opts.scenarios.map((s) => s.name);
  const run = (scenarios: Scenario[], skillsDir: string) => Promise.all(scenarios.map((s) => runScenario(s, { ...opts, skillsDir })));
  const baseline = await run(opts.scenarios, opts.skillsDir);
  const report: LoopReport = { baseline, flaky: [], verdicts: [], adopted: [] };
  // A failure that does not repeat is noise, not a deficiency; both references go to the editor.
  const failing: { scenario: Scenario; results: ScenarioResult[] }[] = [];
  for (const r of baseline.filter((r) => failedChecks(r).length)) {
    const scenario = opts.scenarios.find((s) => s.name === r.name)!;
    const again = await runScenario(scenario, opts);
    const repeated = failedChecks(r).filter((n) => failedChecks(again).includes(n));
    if (!repeated.length) {
      report.flaky.push(scenario.name);
      log(`${scenario.name}: failed once, passed on the second run; skipped`);
      continue;
    }
    failing.push({ scenario, results: [r, again] });
  }
  log(`reference: ${baseline.length - failing.length - report.flaky.length}/${baseline.length} pass, ${failing.length} to fix, ${report.flaky.length} flaky`);

  let currentDir = opts.skillsDir;
  let passing = passedSet(baseline);
  const experiencePath = join(opts.skillsDir, "EXPERIENCE.md");
  const experience = existsSync(experiencePath) ? readFileSync(experiencePath, "utf8") : "";

  for (const { scenario, results } of failing) {
    if (report.adopted.length >= (opts.maxAdoptions ?? 2)) break;
    const targets = failedChecks(results[0]!).filter((n) => failedChecks(results[1]!).includes(n));
    const prior: Verdict[] = [];
    let done = false;
    for (let round = 0; round < (opts.rounds ?? 2) && !done; round++) {
      const files = readFiles(currentDir);
      const lessons = lessonsFor(experience, scenario);
      let candidates = await opts.proposer({ scenario, results, files, lessons, prior });
      // Validate before spending a run; one retry with the validator's message, as Harness² does.
      const problems = candidates.map((c) => validate(c, scenario, files, names));
      if (problems.some(Boolean)) {
        const feedback = candidates
          .map((c, i) => (problems[i] ? `${c.kind} edit to ${c.file}: ${problems[i]}` : ""))
          .filter(Boolean)
          .join("; ");
        const retry = await opts.proposer({ scenario, results, files, lessons, prior, feedback });
        candidates = candidates.map((c, i) => (problems[i] ? (retry.find((r) => r.kind === c.kind) ?? c) : c));
      }
      for (const candidate of candidates.slice(0, 2)) {
        const problem = validate(candidate, scenario, files, names);
        if (problem) {
          prior.push(record(report, { candidate, scenario: scenario.name, verdict: problem.startsWith("identical") ? "no change" : "invalid", detail: problem }, log));
          continue;
        }
        const dir = stage(currentDir, candidate);
        const probe = await runScenario(scenario, { ...opts, skillsDir: dir });
        const fixed = targets.filter((name) => probe.checks.find((c) => c.name === name)?.pass);
        if (!fixed.length) {
          prior.push(record(report, { candidate, scenario: scenario.name, verdict: "no effect", detail: `still failing: ${failedChecks(probe).join(", ")}` }, log));
          continue;
        }
        // A fix that does not repeat is luck.
        const again = await runScenario(scenario, { ...opts, skillsDir: dir });
        const twice = fixed.filter((name) => again.checks.find((c) => c.name === name)?.pass);
        if (!twice.length) {
          prior.push(record(report, { candidate, scenario: scenario.name, verdict: "did not repeat", detail: `fixed ${fixed.join(", ")} once, not twice` }, log));
          continue;
        }
        // Compose: the whole suite; a regression counts only when it repeats.
        const full = await run(opts.scenarios, dir);
        let now = passedSet(full);
        let regressions = [...passing].filter((k) => !now.has(k));
        if (regressions.length) {
          const suspects = opts.scenarios.filter((sc) => regressions.some((k) => k.startsWith(`${sc.name}:`)));
          const recheck = passedSet(await run(suspects, dir));
          regressions = regressions.filter((k) => !recheck.has(k));
          now = new Set([...now, ...recheck]);
        }
        if (regressions.length) {
          prior.push(
            record(report, { candidate, scenario: scenario.name, verdict: "hurt", detail: `fixed ${twice.join(", ")} but regressed ${regressions.join(", ")}`, fixed: twice }, log),
          );
          continue;
        }
        currentDir = dir;
        passing = now;
        const v = record(report, { candidate, scenario: scenario.name, verdict: "adopted", detail: `fixed ${twice.join(", ")} twice; nothing regressed`, fixed: twice }, log);
        report.adopted.push(v);
        done = true; // one adoption per scenario per step: a second candidate would be credited with the first one's fixes
        break;
      }
    }
  }

  // Compose: adoptions land as appended lines; the composer folds them into one rulebook, and the suite judges the fold.
  if (opts.composer && report.adopted.some((a) => a.candidate.file === CORE)) {
    const current = readFiles(currentDir)[CORE] ?? "";
    const folded = await opts.composer(current, report.adopted).catch(() => undefined);
    const problem = folded ? validate({ kind: "invariant", file: CORE, content: folded, why: "composed" }, failing[0]!.scenario, readFiles(currentDir), names) : "no rewrite";
    if (!folded || problem) {
      report.composed = folded ? "rejected" : "unchanged";
      if (folded) log(`compose: ${problem}`);
    } else {
      const dir = stage(currentDir, { kind: "invariant", file: CORE, content: folded, why: "composed" });
      const now = passedSet(await run(opts.scenarios, dir));
      const regressions = [...passing].filter((k) => !now.has(k));
      if (regressions.length) {
        report.composed = "rejected";
        log(`compose: rejected, regressed ${regressions.join(", ")}`);
      } else {
        currentDir = dir;
        passing = now;
        report.composed = "adopted";
        const last = report.adopted.filter((a) => a.candidate.file === CORE).at(-1)!;
        last.candidate = { ...last.candidate, content: folded };
        log("compose: the core rules were folded into one rulebook; nothing regressed");
      }
    }
  }

  // Reflect: adopted files into the real folder for review; every verdict with its evidence into EXPERIENCE.md.
  if (report.verdicts.length) {
    for (const a of report.adopted) writeFileSync(join(opts.skillsDir, a.candidate.file), a.candidate.content);
    writeFileSync(
      experiencePath,
      `${experience.trimEnd()}${experience ? "\n\n" : "# What the harness loop learned\n\nEvidence-backed lessons, newest last. Adopted edits are in git; every candidate gets a row so the next proposal does not repeat it.\n\n"}${entry(report, opts.scenarios)}`,
    );
  }
  return report;
}

function record(report: LoopReport, v: Verdict, log: (l: string) => void): Verdict {
  report.verdicts.push(v);
  log(`${v.scenario} / ${v.candidate.kind}: ${v.verdict} (${v.detail})`);
  return v;
}

/** Lessons for this scenario's category first, then the rest, within a budget. */
function lessonsFor(experience: string, scenario: Scenario): string {
  const blocks = experience.split(/\n(?=## )/).filter((b) => b.startsWith("## "));
  const mine = blocks.filter((b) => b.includes(`category: ${scenario.category}`));
  const rest = blocks.filter((b) => !mine.includes(b)).reverse();
  return [...mine, ...rest].join("\n").slice(0, 4000);
}

function entry(report: LoopReport, scenarios: Scenario[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const byScenario = new Map<string, Verdict[]>();
  for (const v of report.verdicts) byScenario.set(v.scenario, [...(byScenario.get(v.scenario) ?? []), v]);
  return [...byScenario]
    .map(([name, vs]) => {
      const sc = scenarios.find((s) => s.name === name)!;
      const adopted = vs.find((v) => v.verdict === "adopted");
      const rows = vs.map((v) => `- ${v.candidate.kind} edit to ${v.candidate.file}: ${v.verdict}. ${v.detail}`).join("\n");
      const lesson = adopted ? `\nlesson: ${adopted.candidate.why.trim()}\nevidence: ${adopted.detail}` : "\nlesson: none adopted this step";
      return `## ${date} · ${name}\ncategory: ${sc.category} · shape: ${sc.shape}\ncue: ${firstAsk(sc).slice(0, 120)}${lesson}\n${rows}\n`;
    })
    .join("\n");
}

/** The composer for a real model: the same rules, written once, in order, with nothing added or dropped. */
export function modelComposer(model: ModelClient, modelId?: string): NonNullable<LoopOptions["composer"]> {
  return async (core, adopted) => {
    const out = await model.complete({
      model: modelId,
      system:
        "You edit a rulebook an assistant reads before every chat. Rewrite it so each rule appears once, grouped by topic, in the same plain register. Keep the frontmatter exactly. Do not add a rule, drop a rule, or weaken a rule about asking before spending, contacting anyone or using an account. Return only the file.",
      prompt: `${core}\n\nLines adopted this step (keep their meaning):\n${adopted.map((a) => a.candidate.why).join("\n")}`,
      maxTokens: 4000,
    });
    const text = out.trim();
    return text.startsWith("---") && text !== core.trim() ? `${text}\n` : undefined;
  };
}

/** Two scoped editors for a real model: each owns one file and is told what the other owns. */
export function modelProposer(model: ModelClient, modelId?: string): Proposer {
  const ask = async (system: string, prompt: string): Promise<Candidate | undefined> => {
    const raw = await model.complete({ model: modelId, system, prompt, maxTokens: 6000 });
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      const c = JSON.parse(raw.slice(start, end + 1)) as Partial<Candidate>;
      return typeof c.file === "string" && typeof c.content === "string"
        ? { kind: c.kind === "domain" ? "domain" : "invariant", file: c.file, content: c.content, why: c.why ?? "" }
        : undefined;
    } catch {
      return undefined;
    }
  };
  return async ({ scenario, results, files, lessons, prior, feedback }) => {
    const skills = Object.values(files)
      .map(parseSkill)
      .filter((s): s is NonNullable<typeof s> => !!s && !s.name.startsWith("_"));
    const text = firstAsk(scenario);
    const domain = matchSkills(skills, text, { group: scenario.shape !== "solo" })[0]?.name;
    const domainFile = domain ? `${domain}.md` : `${scenario.category}.md`;
    const failed = results[0]!.checks
      .filter((c) => !c.pass)
      .map((c) => `- ${c.name}: ${c.detail}`)
      .join("\n");
    const traces = results.map((r, i) => `Reference run ${i + 1}:\n${r.trace.join("\n").slice(0, 6000)}`).join("\n\n");
    const priors = prior.length
      ? `\n\nEarlier candidates this step (do not repeat them):\n${prior.map((v) => `- ${v.candidate.kind} edit to ${v.candidate.file}: ${v.verdict}. ${v.detail}\n  why it was proposed: ${v.candidate.why}`).join("\n")}`
      : "";
    const brief =
      `Scenario (${scenario.category}, ${scenario.shape}): ${scenario.description}\n\nFailed checks:\n${failed}\n\n${traces}${priors}` +
      `\n\nLessons already learned:\n${lessons || "(none)"}${feedback ? `\n\nYour previous proposal was rejected before probing: ${feedback}. Fix exactly that.` : ""}`;
    const common =
      'Return only JSON: {"kind":..., "file":"<name>.md","content":"<the complete new file>","why":"<one sentence: which moment in the trace this changes and how>"}. ' +
      "Every edit must trace to a moment in a reference run where the agent went wrong; if nothing in the file explains the failure, return the file unchanged. " +
      "Never weaken a rule about asking before spending, contacting anyone or using an account; never mention this scenario by name; keep every existing line unless it is the cause.";
    const invariant = ask(
      `You own ${CORE}: how the assistant works in any chat (planning, tool use, asking, delegating, reporting). You do not own procedures for kinds of errands. ` +
        `Add at most three lines; if you add a line, consider cutting one. kind is "invariant", file is "${CORE}". ${common}`,
      `${brief}\n\nCurrent ${CORE}:\n${files[CORE] ?? "(missing)"}\n\nJSON:`,
    );
    const domainEdit = ask(
      `You own ${domainFile}: the procedure for this kind of errand and its "when:" trigger line, which must contain words from the request so the file loads. You do not own general rules, and you never write task facts (names, prices, dates) into a procedure. ` +
        `kind is "domain", file is "${domainFile}"; keep the frontmatter shape (name, when) of the other files. ${common}`,
      `${brief}\n\nCurrent ${domainFile}:\n${files[domainFile] ?? "(missing: create it)"}\n\nAnother file for the frontmatter shape:\n${files["find-a-vendor.md"]?.slice(0, 400) ?? ""}\n\nJSON:`,
    );
    return (await Promise.all([invariant, domainEdit])).filter((c): c is Candidate => !!c);
  };
}
