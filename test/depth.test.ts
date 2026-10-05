// Depth is decided before deploy from the agent's jobs, shown with costs, overridable, and it caps every request at run time.
import { test, expect, beforeEach } from "bun:test";
import { one, all, J, exec } from "../src/db";
import * as rt from "../src/runtime";
import { assessDepth, classifyJob, clampEffort } from "../src/depth";
import { planWork } from "../src/intake";
import { setup, user, workspace, customAgent, say, scriptModel, call, runsIn, lastFrom } from "./helpers";

let ellie: string, ws: string;
beforeEach(() => { setup(); ellie = user("Ellie"); ws = workspace("Home", ellie); });

test("AC-DP1 depth from jobs: each job gets an effort with a reason; the agent's level is the deepest job; overrides stick; costs scale", () => {
  expect(classifyJob("Remind us when payments are due").effort).toBe("quick");
  expect(classifyJob("Keep the grocery list").effort).toBe("quick");
  expect(classifyJob("Draft emails for my approval").effort).toBe("standard");
  expect(classifyJob("Research a stock's news before alerting us").effort).toBe("deep");
  expect(classifyJob("Plan our trip to Lisbon").effort).toBe("deep");

  const mixed = assessDepth(["Track who owes what", "Remind us about rent", "Research why a stock moved before alerting us"]);
  expect(mixed.level).toBe("deep");
  expect(mixed.why).toMatch(/Most requests are quick, but “Research why a stock moved/);
  expect(mixed).toMatchObject({ max_tool_calls: 30, cross_check: true });
  const light = assessDepth(["Keep the shopping list", "Run polls"]);
  expect(light).toMatchObject({ level: "light", max_tool_calls: 4, cross_check: false });
  expect(light.why).toMatch(/answers in seconds/);
  const forced = assessDepth(["Keep the shopping list"], [], "deep");
  expect(forced).toMatchObject({ level: "deep", overridden: true });
  expect(mixed.est_cost_usd.quick).toBeLessThan(mixed.est_cost_usd.standard);
  expect(mixed.est_cost_usd.standard).toBeLessThan(mixed.est_cost_usd.deep);
});

test("AC-DP2 at run time the agent's depth caps every request: a light agent never runs deep; a deep agent gets the research tier and the big budget", async () => {
  const brief = { goal: "", deliverable: "", constraints: [], assumptions: [], questions: [], side_effects: [], done_when: [], kind: "act", plan: [{ text: "s", tool: "web.search" }] } as any;
  const light = assessDepth(["Keep the shopping list"]), deep = assessDepth(["Research and compare options"]);
  expect(clampEffort("deep", light)).toBe("standard");
  expect(planWork(brief, "compare the best hotels in Lisbon", light)).toMatchObject({ effort: "standard", profile: "standard" });
  expect(planWork(brief, "compare the best hotels in Lisbon", light).tool_budget).toBeLessThanOrEqual(4);
  expect(planWork({ ...brief, tool_budget: 40 }, "compare the best hotels in Lisbon", deep)).toMatchObject({ effort: "deep", profile: "research-standard", tool_budget: 30 });

  // Through a real run: the agent's saved depth sets the run's budget and the brief's effort
  const a = customAgent(ws, ellie, ["web-research"], {}, "Scout");
  exec("update agents set spec=? where id=?", JSON.stringify({ name: "Scout", jobs: ["Keep the list"], depth: light }), a.id);
  const room = rt.privateRoomFor(ellie, a);
  scriptModel({ text: "Here are a few." });
  await say(room.id, ellie, "research and compare the best hotels in Lisbon for next weekend");
  const run = runsIn(room.id).at(-1);
  expect(J(run.brief).effort).not.toBe("deep");
  expect(J(run.budget)).toMatchObject({ maxToolCalls: 4, maxModelCalls: 6 });
});

test("AC-DP3 at the agent's tool cap the run is told to answer and loses its tools — it answers instead of burning model calls on refused tools", async () => {
  const a = customAgent(ws, ellie, ["web-research"], {}, "Scout");
  exec("update agents set spec=? where id=?", JSON.stringify({ name: "Scout", jobs: ["Keep the list"], depth: assessDepth(["Keep the list"]) }), a.id);
  const room = rt.privateRoomFor(ellie, a);
  const seen = scriptModel((r) => r.tools?.length ? call("web.search", { query: `q${r.messages.length}` }) : { text: "Here's what I found so far." });
  await say(room.id, ellie, "find me news about the harbor festival");
  const run = runsIn(room.id).at(-1);
  expect(J(run.spent).toolCalls).toBe(4);                                         // light agent: cap of 4
  const final = seen.find((q) => !q.tools?.length)!;
  expect(final.messages.some((m) => m.content.includes("tools are off"))).toBe(true);
  expect(run.status).not.toBe("failed_terminal");
  expect(lastFrom(room.id, a.id)).toMatch(/^Here's what I found so far\.[\s\S]*Not fully done/);     // the answer, flagged — not "I couldn't finish"
  expect(J(run.spent).modelCalls).toBeLessThanOrEqual(6);
});
