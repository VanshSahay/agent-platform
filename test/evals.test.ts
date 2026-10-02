import { test, expect } from "bun:test";
import { runAll } from "../evals/golden";

test("AC-EV1 golden task suite passes 100% on the offline baseline model", async () => {
  const r = await runAll();
  const failed = r.cases.filter((c) => !c.pass).map((c) => `${c.id}: ${c.results.filter((x) => !x.pass).map((x) => x.label).join("; ")} | reply=${c.reply.slice(0, 120)}`);
  expect(failed).toEqual([]);
  expect(Object.keys(r.summary.by_dimension).sort()).toEqual(["approval", "boundary", "clarification", "completion", "memory", "response", "tool_selection"]);
});
