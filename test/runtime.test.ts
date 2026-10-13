import { describe, expect, test } from "bun:test";
import { callTool, callTools, lastToolResult, reply } from "../src/model/scripted.ts";
import { familyWorld, noticesTo, repliesTo } from "./helpers.ts";
import { FakePhone, FakeSearch } from "../src/tools/hands.ts";
import type { FakeBrowser } from "../src/tools/browser.ts";
import { buildFooter, integrityNote } from "../src/runtime/runtime.ts";

describe("run loop", () => {
  test("a plain reply in a group only when the agent is named, with no footer when no tools ran", async () => {
    const w = familyWorld(() => reply("Hi Mum, I'm here."));
    expect(await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "mum", text: "lunch anyone?" })).toBeUndefined();
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "mum", text: "Pip, are you there?" });
    expect(run?.status).toBe("done");
    expect(repliesTo(w.deliveries, w.family.id)).toEqual(["Hi Mum, I'm here."]);
    const events = w.app.store.eventsForRun(run!.id).map((e) => e.type);
    expect(events[0]).toBe("started");
    expect(events).toContain("reply");
    expect(events.at(-2)).toBe("done");
  });

  test("tool calls are recorded with labels and evidence, and the footer is built from records", async () => {
    const search = new FakeSearch((q) => (q.includes("handyman") ? [{ title: "Lee's Repairs", url: "https://x", snippet: "Mandarin-speaking handyman" }] : []));
    const w = familyWorld((req, i) => {
      if (i === 0) return callTool("web_search", { query: "Mandarin speaking handyman San Jose" });
      expect(lastToolResult(req)).toContain("Lee's Repairs");
      return reply("Found Lee's Repairs. Want me to call them?");
    }, { search });
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip find a Mandarin speaking handyman" });
    const calls = w.app.store.toolCallsForRun(run!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("done");
    expect(calls[0]!.evidence).toBe("fake-search:1");
    expect(calls[0]!.labelDone).toBe("Searched the web");
    expect(calls[0]!.fingerprint).toHaveLength(64);
    const text = repliesTo(w.deliveries, w.family.id)[0]!;
    expect(text).toContain("Found Lee's Repairs.");
    expect(text).toContain("— 1 step · 1 verified: Searched the web");
  });

  test("a reply that claims an action with no side-effect record is corrected", () => {
    expect(integrityNote("I booked the plumber for Tuesday.", [])).toContain("Correction");
    expect(integrityNote("Here are three options.", [])).toBe("");
    expect(buildFooter([])).toBe("");
  });

  test("steering: a message during a run is applied on the next model turn", async () => {
    const w = familyWorld((req, i) => {
      if (i === 0) return callTool("search_memory", { query: "plumber" });
      const t = JSON.stringify(req.messages);
      expect(t).toContain("[while you were working]");
      expect(t).toContain("actually make it Thursday");
      return reply("Thursday it is.");
    });
    // Queue a steer before the run starts by scripting it inside the first tool: simulate with a direct event.
    const p = w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip book a plumber for Tuesday" });
    // The run is synchronous up to the first await; queue the steer now.
    const run = w.app.store.listRuns({ roomId: w.family.id })[0]!;
    w.app.store.appendEvent({ runId: run.id, sessionId: run.sessionId, type: "steer_queued", at: w.clock.now(), data: { personId: "ellie", text: "actually make it Thursday" } });
    const done = await p;
    expect(done?.status).toBe("done");
    expect(w.app.store.eventsForRun(run.id).some((e) => e.type === "steer_applied")).toBe(true);
  });

  test("dedup key prevents double runs", async () => {
    const w = familyWorld(() => reply("ok"));
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip hi", dedupKey: "m1" });
    const again = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip hi", dedupKey: "m1" });
    expect(again).toBeUndefined();
    expect(w.app.store.listRuns({ roomId: w.family.id })).toHaveLength(1);
  });
});

describe("gates and group serving", () => {
  test("a guest's request that needs the owner's accounts pauses, cards the owner, and resumes on yes", async () => {
    const phone = new FakePhone(() => ({ summary: "They can come Thursday 2pm, $120.", status: "completed" }));
    const w = familyWorld((req, i) => {
      const call = () => callTool("place_call", { to: "+14085550100", who: "Lee's Repairs", objective: "Ask availability this week and price for a leaking tap." });
      if (i === 0) return call();
      const last = lastToolResult(req) ?? "";
      const t = JSON.stringify(req.messages);
      if (last.includes("Thursday 2pm")) return reply("Lee's can come Thursday 2pm for about $120.");
      if (t.includes("[APPROVED]")) return call();
      if (last.includes("Waiting for the owner")) return reply("Waiting on Ellie.");
      return reply(`unexpected: ${last}`);
    }, { phone });

    // Uncle Wei is a guest: he never signed up, but he gets served.
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "wei", text: "@pip can you get the tap fixed at Mum's?" });
    expect(run?.status).toBe("waiting");
    expect(phone.calls).toHaveLength(0);
    expect(noticesTo(w.deliveries, w.family.id)).toContain("I've asked Ellie to OK that.");

    const open = w.app.attention.openFor("ellie");
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("guest_request");
    expect(open[0]!.detail).toContain("Uncle Wei asked");
    // The card went to Ellie's private chat with the agent.
    expect(w.deliveries.some((d) => d.roomId === w.ellieDm.id && d.kind === "card" && d.text.includes("OK to call Lee's Repairs?"))).toBe(true);

    // Ellie answers in her DM; the run resumes and the call happens.
    const resumed = await w.app.runtime.handleMessage({ roomId: w.ellieDm.id, personId: "ellie", text: "yes go ahead" });
    expect(resumed?.id).toBe(run!.id);
    expect(resumed?.status).toBe("done");
    expect(phone.calls).toHaveLength(1);
    const final = repliesTo(w.deliveries, w.family.id).at(-1)!;
    expect(final).toContain("Thursday 2pm");
    expect(final).toContain("Made a call");
    const calls = w.app.store.toolCallsForRun(run!.id).filter((c) => c.name === "place_call");
    expect(calls).toHaveLength(2); // the gated attempt, then the approved one
    expect(calls[0]!.evidence).toBeUndefined();
    expect(calls[1]!.evidence).toBe("fake-phone:call_1");
  });

  test("a declined approval resumes with DECLINED and the agent does not retry", async () => {
    const phone = new FakePhone();
    const w = familyWorld((req, i) => {
      if (i === 0) return callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Confirming Mum's appointment" });
      const t = JSON.stringify(req.messages);
      if (t.includes("[DECLINED]")) return reply("Understood, I won't text the clinic.");
      return reply("Waiting.");
    }, { phone });
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "mum", text: "Pip please confirm my appointment" });
    expect(run?.status).toBe("waiting");
    const item = w.app.attention.openFor("ellie")[0]!;
    await w.app.runtime.answerAttention(item.id, "No");
    expect(phone.sms).toHaveLength(0);
    expect(repliesTo(w.deliveries, w.family.id).at(-1)).toContain("won't text the clinic");
  });

  test("the owner's small purchase passes under the threshold; a guest's never does", async () => {
    const w = familyWorld((req, i) => {
      if (i === 0 || i === 2) return callTool("request_purchase", { amountUsd: 12, what: "batteries", where: "Walgreens" });
      return reply(lastToolResult(req) ?? "");
    });
    w.agent.trust.autoApproveUnderUsd = 20;
    w.app.store.putAgent(w.agent);
    const r1 = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip buy batteries" });
    expect(r1?.status).toBe("done");
    expect(repliesTo(w.deliveries, w.family.id).at(-1)).toContain("Approved");
    const r2 = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "wei", text: "@pip buy batteries" });
    expect(r2?.status).toBe("waiting");
  });

  test("outreach outside working hours is held, not sent", async () => {
    const phone = new FakePhone();
    const w = familyWorld((req, i) => {
      if (i === 0) return callTool("place_call", { to: "+1", who: "the pharmacy", objective: "refill" });
      return reply(lastToolResult(req) ?? "");
    }, { phone });
    w.clock.set(Date.UTC(2026, 9, 14, 5, 0, 0)); // 22:00 in Los Angeles
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip call the pharmacy" });
    expect(run?.status).toBe("done");
    expect(phone.calls).toHaveLength(0);
    expect(repliesTo(w.deliveries, w.family.id).at(-1)).toContain("outside working hours");
  });

  test("ask_room pauses until any member answers in the room", async () => {
    const w = familyWorld((req, i) => {
      if (i === 0) return callTool("ask_room", { question: "Who can drive Mum on Thursday at 2?" });
      const t = JSON.stringify(req.messages);
      if ((lastToolResult(req) ?? "").includes("commitmentId")) return reply("Thanks Ben, you're down to drive.");
      if (t.includes("[ANSWERED]") && t.includes("I can")) return callTool("track_commitment", { title: "Drive Mum to Lee's visit", owner: "Ben", beneficiary: "Mum", dueAt: "2026-10-15T20:15:00Z" });
      return reply("Thanks Ben, you're down to drive.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip sort out a ride for Mum Thursday" });
    expect(run?.status).toBe("waiting");
    expect(noticesTo(w.deliveries, w.family.id)).toContain("Who can drive Mum on Thursday at 2?");
    // Ben answers without naming the agent: it is the pending group question.
    const resumed = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ben", text: "I can" });
    expect(resumed?.status).toBe("done");
    const open = w.app.commitments.open(w.family.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.ownerId).toBe("ben");
    expect(open[0]!.beneficiaryId).toBe("mum");
  });
});

describe("answering on someone's behalf", () => {
  test("the owner can answer a decision that was put to a guest, in the group", async () => {
    const w = familyWorld((req, i) => {
      if (i === 0) return callTool("wait_for_user_input", { question: "Lin on Thursday or Great Wall next week?", kind: "decision", options: ["Lin", "Great Wall"] });
      const t = JSON.stringify(req.messages);
      if (t.includes("[ANSWERED]")) return reply("Lin it is.");
      return reply("Waiting.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "wei", text: "@pip which one should we go with?" });
    expect(run?.status).toBe("waiting");
    // Mum (cared_for) cannot answer on Wei's behalf; her message is just chat.
    expect(await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "mum", text: "Lin" })).toBeUndefined();
    const resumed = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "Lin" });
    expect(resumed?.id).toBe(run!.id);
    expect(resumed?.status).toBe("done");
    const gated = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "wait_for_user_input")!;
    expect(gated.status).toBe("done");
    expect(gated.labelDone).toBe("Got Ellie's answer");
    expect(w.app.store.listAttention({ roomId: w.family.id })[0]!.answeredBy).toBe("ellie");
    expect(repliesTo(w.deliveries, w.family.id).at(-1)).toContain("Lin it is.");
  });
});

describe("planner", () => {
  test("a stalled approach switches to the next rung after two attempts and the model is told", async () => {
    const search = new FakeSearch(() => []);
    const w = familyWorld((req, i) => {
      if (i === 0) return callTool("plan", { goal: "Find a Mandarin-speaking handyman", steps: [{ text: "Find candidates", approach: "search" }] });
      if (i === 1 || i === 2) return callTool("web_search", { query: "handyman mandarin" });
      const t = JSON.stringify(req.messages);
      expect(t).toContain('the plan now tries "ask_room"');
      return reply("Nothing online; I'll ask the group next.");
    }, { search });
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip find a mandarin handyman" });
    const plan = w.app.planner.get(run!.id)!;
    expect(plan.steps[0]!.approach).toBe("ask_room");
    expect(plan.steps[0]!.attempts).toBe(0);
    expect(w.app.store.toolCallsForRun(run!.id).filter((c) => c.name === "web_search").every((c) => c.labelDone.includes("nothing yet"))).toBe(true);
  });

  test("parallel tool calls are all answered in one user message", async () => {
    const w = familyWorld((req, i) => {
      if (i === 0) return callTools([{ name: "search_memory", input: { query: "plumber" } }, { name: "search_memory", input: { query: "vet" } }]);
      const last = req.messages.at(-1)!;
      expect(Array.isArray(last.content) && last.content.filter((b) => b.type === "tool_result").length).toBe(2);
      return reply("ok");
    });
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip check notes" });
  });
});

describe("hands", () => {
  test("browse_page reads a page through the browser hand and records evidence", async () => {
    const { FakeBrowser } = await import("../src/tools/browser.ts");
    const browser = new FakeBrowser((url) => (url.includes("lin-repair") ? { title: "Lin Home Repair", text: "Open Mon–Sat 8–6. Call 408-555-0142.", links: [{ text: "Book", href: "https://lin-repair.example/book" }] } : {}));
    const w = familyWorld((req, i) => {
      if (i === 0) return callTool("browse_page", { url: "https://lin-repair.example" });
      const last = lastToolResult(req) ?? "";
      expect(last).toContain("408-555-0142");
      return reply("They're open Mon to Sat, 8 to 6.");
    }, { browser });
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip when is Lin Home Repair open?" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    expect(call.name).toBe("browse_page");
    expect(call.evidence).toBe("fake-browser:1");
    expect(call.labelDone).toBe("Read a web page");
    expect(browser.visited).toEqual(["https://lin-repair.example"]);
  });

  test("model config picks OpenRouter with GLM 5.3 by default and maps Claude ids between doors", async () => {
    const { modelConfig, normalizeModelId } = await import("../src/model/config.ts");
    expect(modelConfig({ OPENROUTER_API_KEY: "x" })).toEqual({ provider: "openrouter", model: "z-ai/glm-5.3", smallModel: "z-ai/glm-5.3-flash" });
    expect(modelConfig({ OPENROUTER_API_KEY: "x", MODEL: "anthropic/claude-opus-5.5" }).model).toBe("anthropic/claude-opus-5.5");
    expect(modelConfig({ ANTHROPIC_API_KEY: "x" })).toEqual({ provider: "anthropic", model: "claude-opus-5-5", smallModel: "claude-haiku-5-5" });
    expect(modelConfig({}).provider).toBe("none");
    expect(normalizeModelId("claude-opus-5-5", "openrouter")).toBe("anthropic/claude-opus-5.5");
    expect(normalizeModelId("anthropic/claude-haiku-5.5", "anthropic")).toBe("claude-haiku-5-5");
    expect(normalizeModelId("z-ai/glm-5.3", "openrouter")).toBe("z-ai/glm-5.3");
  });
});
