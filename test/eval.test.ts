import { describe, expect, test } from "bun:test";
import { callTool, lastToolResult, lastUserText, reply, ScriptedModel, toolCallsSoFar, transcriptHas } from "../src/model/scripted.ts";
import { coverage, runScenario, runScenarios } from "../src/eval/harness.ts";
import { after, findScenarios, SCENARIOS } from "../src/eval/scenarios.ts";
import { groupWorld } from "./helpers.ts";
import type { RunEvent } from "../src/core/types.ts";

/** A model that behaves: pays under the threshold, asks over it, re-issues after a yes; searches twice then asks the group. */
const wellBehaved = new ScriptedModel((req) => {
  const calls = toolCallsSoFar(req);
  const n = (name: string) => calls.filter((c) => c.name === name).length;
  const text = lastUserText(req);
  const last = lastToolResult(req) ?? "";

  if (/batteries|monitor/i.test(text) || transcriptHas(req, "[APPROVED]")) {
    if (last.startsWith("Approved")) return reply("Done, that's ordered.");
    if (transcriptHas(req, "[APPROVED]")) {
      const prev = calls.filter((c) => c.name === "request_purchase").at(-1)!;
      return callTool("request_purchase", prev.input);
    }
    if (last.includes("Waiting for approval")) return reply("I've asked for the OK on that.");
    const monitor = /monitor/i.test(text);
    return callTool("request_purchase", { amountUsd: monitor ? 80 : 12, what: monitor ? "Omron blood pressure monitor" : "AA batteries", where: "Walgreens" });
  }

  if (!calls.length) return callTool("plan", { goal: "Find a Mandarin-speaking handyman for Jo's tap", steps: [{ text: "Find candidates", approach: "search" }] });
  if (n("web_search") < 2) return callTool("web_search", { query: "Mandarin speaking handyman San Jose", near: "San Jose, CA" });
  if (n("ask_room") === 0) return callTool("ask_room", { question: "Does anyone know a Mandarin-speaking handyman near Jo's?" });
  return reply("Asked the group.");
});

/** The scheduler's premise re-check asks the small model; a fired reminder is still wanted. */
const premiseHolds = (system: string) => (system.includes("holds") ? '{"holds": true, "note": "still wanted"}' : "");
const doNothing = () => new ScriptedModel(() => reply("Sure, I'll look into it."), premiseHolds);

describe("eval harness", () => {
  test("grades the store after playing two scenarios through the real runtime", async () => {
    const results = await runScenarios(findScenarios("purchase").concat(findScenarios("stall-ladder")), { model: wellBehaved, timeoutMs: 5000 });
    expect(results.map((r) => r.name)).toEqual(["purchase-threshold", "search-stall-ladder"]);
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(r.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual([]);
      expect(r.passed).toBe(r.total);
    }
    const purchase = results[0]!;
    expect(purchase.turns.map((t) => t.status)).toEqual(["done", "waiting", "done"]);
    expect(purchase.turns.map((t) => t.tools)).toEqual([["request_purchase+"], ["request_purchase?"], ["request_purchase", "request_purchase+"]]);
    expect(purchase.toolCalls).toBe(3); // $12 passes, $80 gated, $80 re-issued
    expect(purchase.modelTurns).toBeGreaterThanOrEqual(5);
    const stall = results[1]!;
    expect(stall.turns[0]!.status).toBe("waiting");
    expect(stall.toolCalls).toBe(4); // plan, two searches, ask_room
  });

  test("every scenario passes all its checks under its own well-behaved script", async () => {
    const scripted = SCENARIOS.filter((s) => s.script);
    expect(scripted.length).toBe(SCENARIOS.length);
    for (const s of scripted) {
      const model = new ScriptedModel(s.script!, premiseHolds);
      const r = await runScenario(s, { model, timeoutMs: 5000 });
      model.rethrow();
      expect(r.error, s.name).toBeUndefined();
      expect(r.checks.filter((c) => !c.pass).map((c) => `${s.name}: ${c.name} — ${c.detail}${c.error ? ` (${c.error})` : ""}`)).toEqual([]);
    }
  });

  test("ordering crosses from a delegating session into the task's session", async () => {
    const w = groupWorld((req, i) => {
      if (lastUserText(req).includes("You are the task agent")) return reply("Done: Lin Home Repair, (408) 555-0100.");
      if (i === 0) return callTool("delegate_task", { title: "Find a repairer", instructions: "Search and report one name." });
      return reply("On it. I'll report back when I have a name.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a repairer for Jo's oven" });
    await w.app.runtime.settle();
    const taskRunId = w.app.store.getTask(w.app.store.listTasks({ roomId: w.room.id })[0]!.id)!.runId!;
    const roomReply = w.app.store.eventsForRun(run!.id).find((e: RunEvent) => e.type === "reply")!;
    const taskReply = w.app.store.eventsForRun(taskRunId).find((e: RunEvent) => e.type === "reply")!;
    expect(after(w.app, w.world, taskReply, roomReply)).toBe(true); // the task reported after the room was answered
    expect(after(w.app, w.world, roomReply, taskReply)).toBe(false);
  });

  test("the do-nothing model fails every scenario, and each check's noOpPasses label is right", async () => {
    for (const s of SCENARIOS) {
      const r = await runScenario(s, { model: doNothing(), timeoutMs: 5000 });
      expect(r.passed, s.name).toBeLessThan(r.total);
      expect(r.checks.filter((c) => c.pass !== !!c.noOpPasses).map((c) => `${s.name}: ${c.name} ${c.pass ? "passed" : "failed"} under the do-nothing model`)).toEqual([]);
    }
  });

  test("tick and event turns record the runs they fire, without the one-second step message turns get", async () => {
    const watch = findScenarios("pharmacy")[0]!;
    const r = await runScenario(watch, { model: new ScriptedModel(watch.script!, premiseHolds), timeoutMs: 5000 });
    expect(r.error).toBeUndefined();
    const kinds = r.turns.map((t) => `${t.kind}:${t.trigger ?? "-"}:${t.tools.join("+")}`);
    expect(kinds[0]).toBe("message:message:watch_for+");
    expect(kinds.filter((k) => k.startsWith("tick:"))).toContain("tick:scheduled_action:stay_quiet");
    expect(kinds.at(-1)).toBe("event:event:");
    const bins = findScenarios("bins")[0]!;
    const b = await runScenario(bins, { model: new ScriptedModel(bins.script!, premiseHolds), timeoutMs: 5000 });
    expect(b.turns.filter((t) => t.kind === "tick" && t.trigger === "scheduled_action")).toHaveLength(1);
  });

  test("a model that just chats fails the checks instead of passing by accident", async () => {
    const chatty = new ScriptedModel(() => reply("Sure, I'll look into it."));
    const r = await runScenario(findScenarios("stall")[0]!, { model: chatty, timeoutMs: 5000 });
    expect(r.passed).toBeLessThan(r.total);
    expect(r.checks.find((c) => c.name === "did not give up")!.pass).toBe(false);
    expect(r.modelTurns).toBe(1);
  });

  test("a model error is reported, not thrown, and the checks still run", async () => {
    const broken = new ScriptedModel(() => {
      throw new Error("boom");
    });
    const r = await runScenario(findScenarios("purchase")[0]!, { model: broken, timeoutMs: 5000 });
    expect(r.error).toContain("failed");
    expect(r.total).toBeGreaterThan(0);
    expect(r.checks.filter((c) => c.name !== "nothing else changed").every((c) => !c.pass)).toBe(true);
  });

  test("an assertion inside a script surfaces through rethrow(), even though the runtime swallows model errors", async () => {
    const m = new ScriptedModel((req) => {
      expect(req.model).toBe("something-else");
      return reply("ok");
    });
    const r = await runScenario(findScenarios("privacy")[0]!, { model: m, timeoutMs: 5000 });
    expect(r.error).toContain("failed");
    expect(m.firstError).toBeDefined();
    expect(() => m.rethrow()).toThrow();
  });

  test("--model sets the agent's model id, and usage is summed from model turns", async () => {
    let seen = "";
    const m = new ScriptedModel((req) => {
      seen = req.model;
      return { ...reply("ok"), usage: { input: 100, output: 7 } };
    });
    const r = await runScenario(findScenarios("privacy")[0]!, { model: m, modelId: "eval/test-model", timeoutMs: 5000 });
    expect(seen).toBe("eval/test-model");
    expect(r.tokens).toEqual({ input: 200, output: 14 });
    expect(r.modelTurns).toBe(2);
  });

  test("coverage counts every category and shape, zeros included, and the use-case rows covered", () => {
    const c = coverage(SCENARIOS);
    expect(Object.keys(c.categories)).toHaveLength(22);
    expect(c.categories.booking).toBe(0);
    expect(c.categories["home-services"]).toBe(4);
    expect(Object.values(c.shapes).every((n) => n > 0)).toBe(true);
    expect(c.cases).toContain(72);
    expect(findScenarios(undefined, { shape: "couple" }).map((s) => s.name)).toEqual(["meal-plan-claims"]);
  });
});
