import { describe, expect, test } from "bun:test";
import { callTool, lastToolResult, lastUserText, reply, ScriptedModel, toolCallsSoFar, transcriptHas } from "../src/model/scripted.ts";
import { runScenario, runScenarios } from "../src/eval/harness.ts";
import { findScenarios } from "../src/eval/scenarios.ts";

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

  if (!calls.length) return callTool("plan", { goal: "Find a Mandarin-speaking handyman for Mum's tap", steps: [{ text: "Find candidates", approach: "search" }] });
  if (n("web_search") < 2) return callTool("web_search", { query: "Mandarin speaking handyman San Jose", near: "San Jose, CA" });
  if (n("ask_room") === 0) return callTool("ask_room", { question: "Does anyone know a Mandarin-speaking handyman near Mum's?" });
  return reply("Asked the family.");
});

describe("eval harness", () => {
  test("grades the store after playing two scenarios through the real runtime", async () => {
    const results = await runScenarios(findScenarios("purchase").concat(findScenarios("stall")), { model: wellBehaved, timeoutMs: 5000 });
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
    expect(r.passed).toBe(0);
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
});
