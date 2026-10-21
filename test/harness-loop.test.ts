import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessLoop } from "../src/eval/harness-loop.ts";
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
    expect(report.adopted.map((a) => a.candidate.kind)).toEqual(["invariant"]);
    expect(report.adopted[0]!.fixed).toContain("a watch was set");
    expect(readFileSync(join(skillsDir, "_core-rules.md"), "utf8")).toContain("ALWAYS SET A WATCH");
    expect(existsSync(join(skillsDir, "pharmacy.md"))).toBe(false);
    const experience = readFileSync(join(skillsDir, "EXPERIENCE.md"), "utf8");
    expect(experience).toContain("pharmacy-watch · invariant edit to _core-rules.md");
    expect(experience).toContain("promised instead of setting a watch");
    // One adoption per scenario per step: the domain candidate is not probed once the invariant one is in.
    expect(report.rejected).toEqual([]);
  });
});
