import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessLoop, validate } from "../src/eval/harness-loop.ts";
import { findScenarios } from "../src/eval/scenarios.ts";
import { callTool, reply, ScriptedModel, toolCallsSoFar } from "../src/model/scripted.ts";

const repoSkills = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

describe("harness loop", () => {
  test("a candidate rule that fixes the failing check without regressions is adopted, written to skills/, and recorded as a lesson", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "circle-harness-test-"));
    cpSync(repoSkills, skillsDir, { recursive: true });
    // An agent that only sets a watch when the rules say the magic words; otherwise it just talks.
    const model = new ScriptedModel(
      (req) => {
        if (/heartbeat/i.test(JSON.stringify(req.messages))) return callTool("stay_quiet", { reason: "nothing" });
        if (/pharmacy|metformin/i.test(JSON.stringify(req.messages)) && /ALWAYS SET A WATCH/.test(req.system)) {
          if (toolCallsSoFar(req).some((c) => c.name === "watch_for")) return reply("Watching.");
          if (/Check whether this holds/.test(JSON.stringify(req.messages))) return callTool("stay_quiet", { reason: "nothing yet" });
          if (/Event from/.test(JSON.stringify(req.messages))) return reply("Walgreens says Jo's metformin is ready for pickup.");
          return callTool("watch_for", { title: "Pharmacy", condition: "the pharmacy confirmed", action: "tell the room", everyHours: 6 });
        }
        if (/heartbeat|Check whether this holds/i.test(JSON.stringify(req.messages))) return callTool("stay_quiet", { reason: "nothing" });
        return reply("I'll keep an eye out.");
      },
      (system) => (system.includes("holds") ? '{"holds": true, "note": "ok"}' : ""),
    );
    const scenarios = findScenarios("pharmacy");
    const proposer = async ({ files }: { files: Record<string, string> }) => [
      {
        kind: "invariant" as const,
        file: "_core-rules.md",
        content: `${files["_core-rules.md"]}\n- ALWAYS SET A WATCH when asked to watch for something.\n`,
        why: "The agent promised instead of setting a watch.",
      },
      { kind: "domain" as const, file: "pharmacy.md", content: "---\nname: pharmacy\nwhen: pharmacy refills\n---\nNothing useful.\n", why: "A procedure that changes nothing." },
    ];
    const report = await harnessLoop({ scenarios, skillsDir, model, proposer, timeoutMs: 5000, maxAdoptions: 2 });
    expect(report.baseline[0]!.checks.some((c) => !c.pass)).toBe(true);
    expect(report.flaky).toEqual([]);
    expect(report.adopted.map((a) => a.candidate.kind)).toEqual(["invariant"]);
    expect(report.adopted[0]!.fixed).toContain("a watch was set");
    expect(readFileSync(join(skillsDir, "_core-rules.md"), "utf8")).toContain("ALWAYS SET A WATCH");
    expect(existsSync(join(skillsDir, "pharmacy.md"))).toBe(false);
    const experience = readFileSync(join(skillsDir, "EXPERIENCE.md"), "utf8");
    expect(experience).toContain("- invariant edit to _core-rules.md: adopted");
    expect(experience).toContain("promised instead of setting a watch");
    // One adoption per scenario per step, and the editor's trace carried the moment the agent went wrong.
    expect(report.verdicts.map((v) => v.verdict)).toEqual(["adopted"]);
    expect(report.baseline[0]!.trace.some((l) => l.startsWith("[REPLY] I'll keep an eye out"))).toBe(true);
    expect(experience).toContain("category: doctor");
  });

  test("a candidate that would never load, names the test, or drops a guard rule is refused before any run", async () => {
    const files = {
      "_core-rules.md": "---\nname: _core-rules\nwhen: core\n---\n- Anything that spends money asks first.\n- Reply in plain words.\n",
      "find-a-vendor.md": "---\nname: find-a-vendor\nwhen: handyman plumber repair\n---\nsteps\n",
    };
    const scenario = findScenarios("pharmacy")[0]!;
    const names = ["pharmacy-watch"];
    expect(validate({ kind: "domain", file: "x.md", content: "---\nname: x\nwhen: totally unrelated words\n---\nbody", why: "" }, scenario, files, names)).toContain(
      "would not match",
    );
    expect(
      validate({ kind: "invariant", file: "_core-rules.md", content: "---\nname: _core-rules\nwhen: core\n---\n- Reply in plain words.\n", why: "" }, scenario, files, names),
    ).toContain("guard rule");
    expect(validate({ kind: "invariant", file: "_core-rules.md", content: files["_core-rules.md"], why: "" }, scenario, files, names)).toContain("identical");
    expect(
      validate({ kind: "domain", file: "p.md", content: "---\nname: p\nwhen: pharmacy metformin refill\n---\nfor pharmacy-watch do x", why: "" }, scenario, files, names),
    ).toContain("names the scenario");
    expect(validate({ kind: "domain", file: "p.md", content: "---\nname: p\nwhen: pharmacy metformin confirmation\n---\nsteps", why: "" }, scenario, files, names)).toBeUndefined();
  });
});
