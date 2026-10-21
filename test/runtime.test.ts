import { describe, expect, test } from "bun:test";
import { callTool, callTools, lastToolResult, lastUserText, reply, toolCallsSoFar } from "../src/model/scripted.ts";
import { groupWorld, noticesTo, repliesTo } from "./helpers.ts";
import { FakePhone, FakeSearch } from "../src/tools/hands.ts";
import { FakeBrowser } from "../src/tools/browser.ts";
import { buildFooter, integrityNote } from "../src/runtime/runtime.ts";
import { parseDecision } from "../src/runtime/decide.ts";
import { e164 } from "../src/tools/registry.ts";

describe("run loop", () => {
  test("a plain reply in a group only when the agent is named, with no footer when no tools ran", async () => {
    const w = groupWorld(() => reply("Hi Jo, I'm here."));
    expect(await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "jo", text: "lunch anyone?" })).toBeUndefined();
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "jo", text: "Pip, are you there?" });
    expect(run?.status).toBe("done");
    expect(repliesTo(w.deliveries, w.room.id)).toEqual(["Hi Jo, I'm here."]);
    const events = w.app.store.eventsForRun(run!.id).map((e) => e.type);
    expect(events[0]).toBe("started");
    expect(events).toContain("reply");
    expect(events.at(-2)).toBe("done");
  });

  test("tool calls are recorded with labels and evidence, and the footer is built from records", async () => {
    const search = new FakeSearch((q) => (q.includes("handyman") ? [{ title: "Lee's Repairs", url: "https://x", snippet: "Mandarin-speaking handyman" }] : []));
    const w = groupWorld(
      (req, i) => {
        if (i === 0) return callTool("web_search", { query: "Mandarin speaking handyman San Jose" });
        expect(lastToolResult(req)).toContain("Lee's Repairs");
        return reply("Found Lee's Repairs. Want me to call them?");
      },
      { search },
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a Mandarin speaking handyman" });
    const calls = w.app.store.toolCallsForRun(run!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("done");
    expect(calls[0]!.evidence).toBe("fake-search:1");
    expect(calls[0]!.labelDone).toMatch(/^Searched: /);
    expect(calls[0]!.fingerprint).toHaveLength(64);
    const text = repliesTo(w.deliveries, w.room.id)[0]!;
    expect(text).toContain("Found Lee's Repairs.");
    expect(text).toContain("— 1 step · 1 verified: Searched: ");
  });

  test("a reply that claims an action with no side-effect record is corrected", () => {
    expect(integrityNote("I booked the plumber for Tuesday.", [])).toContain("Correction");
    expect(integrityNote("Here are three options.", [])).toBe("");
    const call = (name: string) => ({ id: "c", runId: "r", name, input: "{}", status: "done", evidence: "x", labelRunning: "", labelDone: "", startedAt: 0 }) as never;
    // Any catalogue side effect with evidence backs a claim; a cleared budget alone does not.
    expect(integrityNote("I've emailed the clinic.", [call("send_agent_email")])).toBe("");
    expect(integrityNote("I've ordered the kettle.", [call("request_purchase")])).toContain("Correction");
    expect(buildFooter([])).toBe("");
  });

  test("steering: a message during a run is applied on the next model turn", async () => {
    const w = groupWorld((req, i) => {
      if (i === 0) return callTool("search_memory", { query: "plumber" });
      const t = JSON.stringify(req.messages);
      expect(t).toContain("[while you were working]");
      expect(t).toContain("actually make it Thursday");
      return reply("Thursday it is.");
    });
    // Queue a steer before the run starts by scripting it inside the first tool: simulate with a direct event.
    const p = w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip book a plumber for Tuesday" });
    // The run is synchronous up to the first await; queue the steer now.
    const run = w.app.store.listRuns({ roomId: w.room.id })[0]!;
    w.app.store.appendEvent({ runId: run.id, sessionId: run.sessionId, type: "steer_queued", at: w.clock.now(), data: { personId: "alex", text: "actually make it Thursday" } });
    const done = await p;
    expect(done?.status).toBe("done");
    expect(w.app.store.eventsForRun(run.id).some((e) => e.type === "steer_applied")).toBe(true);
  });

  test("dedup key prevents double runs", async () => {
    const w = groupWorld(() => reply("ok"));
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip hi", dedupKey: "m1" });
    const again = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip hi", dedupKey: "m1" });
    expect(again).toBeUndefined();
    expect(w.app.store.listRuns({ roomId: w.room.id })).toHaveLength(1);
  });
});

describe("gates and group serving", () => {
  test("a guest's request that needs the owner's accounts pauses, cards the owner, and resumes on yes", async () => {
    const phone = new FakePhone(() => ({ summary: "They can come Thursday 2pm, $120.", status: "completed" }));
    const w = groupWorld(
      (req, i) => {
        const call = () => callTool("place_call", { to: "+14085550100", who: "Lee's Repairs", objective: "Ask availability this week and price for a leaking tap." });
        if (i === 0) return call();
        const last = lastToolResult(req) ?? "";
        const t = JSON.stringify(req.messages);
        if (last.includes("Thursday 2pm")) return reply("Lee's can come Thursday 2pm for about $120.");
        if (t.includes("[APPROVED]")) return call();
        if (last.includes("Waiting for the owner")) return reply("Waiting on Alex.");
        return reply(`unexpected: ${last}`);
      },
      { phone },
    );

    // Riley is a guest: he never signed up, but he gets served.
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip can you get the tap fixed at Jo's?" });
    expect(run?.status).toBe("waiting");
    expect(phone.calls).toHaveLength(0);
    expect(noticesTo(w.deliveries, w.room.id)).toContain("I've asked Alex to OK that.");

    const open = w.app.attention.openFor("alex");
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("guest_request");
    expect(open[0]!.detail).toContain("Riley asked");
    // The card went to Alex's private chat with the agent.
    expect(w.deliveries.some((d) => d.roomId === w.ownerDm.id && d.kind === "card" && d.text.includes("OK to call Lee's Repairs?"))).toBe(true);

    // Alex answers in her DM; the run resumes and the call happens.
    const resumed = await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "yes go ahead" });
    expect(resumed?.id).toBe(run!.id);
    expect(resumed?.status).toBe("done");
    expect(phone.calls).toHaveLength(1);
    const final = repliesTo(w.deliveries, w.room.id).at(-1)!;
    expect(final).toContain("Thursday 2pm");
    expect(final).toContain("Made a call");
    const calls = w.app.store.toolCallsForRun(run!.id).filter((c) => c.name === "place_call");
    expect(calls).toHaveLength(2); // the gated attempt, then the approved one
    expect(calls[0]!.evidence).toBeUndefined();
    expect(calls[1]!.evidence).toBe("fake-phone:call_1");
  });

  test("a declined approval resumes with DECLINED and the agent does not retry", async () => {
    const phone = new FakePhone();
    const w = groupWorld(
      (req, i) => {
        if (i === 0) return callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Confirming Jo's appointment" });
        const t = JSON.stringify(req.messages);
        if (t.includes("[DECLINED]")) return reply("Understood, I won't text the clinic.");
        return reply("Waiting.");
      },
      { phone },
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "jo", text: "Pip please confirm my appointment" });
    expect(run?.status).toBe("waiting");
    // Jo has not consented to her own accounts being used, so the text goes through the owner, Alex.
    const item = w.app.attention.openFor("alex")[0]!;
    await w.app.runtime.answerAttention(item.id, "No", "alex");
    expect(phone.sms).toHaveLength(0);
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("won't text the clinic");
  });

  test("the owner's small purchase passes under the threshold; a guest's never does", async () => {
    const w = groupWorld((req, i) => {
      if (i === 0 || i === 2) return callTool("request_purchase", { amountUsd: 12, what: "batteries", where: "Walgreens" });
      return reply(lastToolResult(req) ?? "");
    });
    w.agent.trust.autoApproveUnderUsd = 20;
    w.app.store.putAgent(w.agent);
    const r1 = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip buy batteries" });
    expect(r1?.status).toBe("done");
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("Approved");
    const r2 = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip buy batteries" });
    expect(r2?.status).toBe("waiting");
  });

  test("outreach outside working hours is held, not sent", async () => {
    const phone = new FakePhone();
    const w = groupWorld(
      (req, i) => {
        if (i === 0) return callTool("place_call", { to: "+14085550100", who: "the pharmacy", objective: "refill" });
        return reply(lastToolResult(req) ?? "");
      },
      { phone },
    );
    w.clock.set(Date.UTC(2026, 9, 14, 5, 0, 0)); // 22:00 in Los Angeles
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip call the pharmacy" });
    expect(run?.status).toBe("done");
    expect(phone.calls).toHaveLength(0);
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("outside working hours");
  });

  test("ask_room pauses until any member answers in the room", async () => {
    const w = groupWorld((req, i) => {
      if (i === 0) return callTool("ask_room", { question: "Who can drive Jo on Thursday at 2?" });
      const t = JSON.stringify(req.messages);
      if ((lastToolResult(req) ?? "").includes("commitmentId")) return reply("Thanks Sam, you're down to drive.");
      if (t.includes("[ANSWERED]") && t.includes("I can"))
        return callTool("track_commitment", { title: "Drive Jo to Lee's visit", owner: "Sam", beneficiary: "Jo", dueAt: "2026-10-15T20:15:00Z" });
      return reply("Thanks Sam, you're down to drive.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip sort out a ride for Jo Thursday" });
    expect(run?.status).toBe("waiting");
    expect(noticesTo(w.deliveries, w.room.id)).toContain("Who can drive Jo on Thursday at 2?");
    // Sam answers without naming the agent: it is the pending group question.
    const resumed = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "I can" });
    expect(resumed?.status).toBe("done");
    const open = w.app.commitments.open(w.room.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.ownerId).toBe("sam");
    expect(open[0]!.beneficiaryId).toBe("jo");
  });
});

describe("answering on someone's behalf", () => {
  test("the owner can answer a decision that was put to a guest, in the group", async () => {
    const w = groupWorld((req, i) => {
      if (i === 0) return callTool("wait_for_user_input", { question: "Lin on Thursday or Great Wall next week?", kind: "decision", options: ["Lin", "Great Wall"] });
      const t = JSON.stringify(req.messages);
      if (t.includes("[ANSWERED]")) return reply("Lin it is.");
      return reply("Waiting.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip which one should we go with?" });
    expect(run?.status).toBe("waiting");
    // Jo (cared_for) cannot answer on Riley's behalf; her message is just chat.
    expect(await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "jo", text: "Lin" })).toBeUndefined();
    const resumed = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "Lin" });
    expect(resumed?.id).toBe(run!.id);
    expect(resumed?.status).toBe("done");
    const gated = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "wait_for_user_input")!;
    expect(gated.status).toBe("done");
    expect(gated.labelDone).toBe("Got Alex's answer");
    expect(w.app.store.listAttention({ roomId: w.room.id })[0]!.answeredBy).toBe("alex");
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("Lin it is.");
  });
});

describe("one ask, one card", () => {
  test("two people asking for the same gated action share one card, and one yes resumes both runs", async () => {
    const w = groupWorld((req, _i) => {
      const t = JSON.stringify(req.messages);
      const last = lastToolResult(req) ?? "";
      if (last.includes("summary")) return reply("Lee's can come Thursday.");
      if (t.includes("[APPROVED]") || !last) return callTool("place_call", { to: "+14085550100", who: "Lee's Repairs", objective: "Ask availability." });
      return reply("Waiting.");
    });
    w.app.rooms.createPerson({ id: "jo", displayName: "Jo", timezone: "America/Los_Angeles" });
    w.app.rooms.addMember(w.room.id, "jo", "guest");
    const a = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip get the tap fixed" });
    const b = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "jo", text: "Pip, can you get someone for the tap?" });
    expect(a?.status).toBe("waiting");
    expect(b?.status).toBe("waiting");
    expect(w.app.attention.openFor("alex")).toHaveLength(1);
    expect(noticesTo(w.deliveries, w.room.id).some((n) => n.includes("already been asked"))).toBe(true);
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "yes" });
    expect(w.app.store.getRun(a!.id)!.status).toBe("done");
    expect(w.app.store.getRun(b!.id)!.status).toBe("done");
    expect(w.hands.phone.calls).toHaveLength(2);
  });
});

describe("chatter is not an answer", () => {
  test("the owner's unrelated message does not resolve a question put to someone else", async () => {
    const w = groupWorld((_req, i) => {
      if (i === 0) return callTool("wait_for_user_input", { question: "Lin on Thursday or Great Wall next week?", kind: "decision", options: ["Lin", "Great Wall"] });
      return reply("ok");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip which one?" });
    expect(run?.status).toBe("waiting");
    expect(await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "Thanks everyone, Jo will be home all week." })).toBeUndefined();
    expect(w.app.store.getRun(run!.id)!.status).toBe("waiting");
    // Naming the agent in passing starts a new run; it does not answer the open question.
    const other = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "Thanks Pip, Jo will be home all week." });
    expect(other?.id).not.toBe(run!.id);
    expect(w.app.store.getRun(run!.id)!.status).toBe("waiting");
    // A real answer from the owner does count.
    const resumed = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "Great Wall" });
    expect(resumed?.id).toBe(run!.id);
    expect(w.app.store.listAttention({ roomId: w.room.id })[0]!.answer).toBe("Great Wall");
  });

  test("an unrelated message from the person who holds an open card neither answers nor declines it", async () => {
    const w = groupWorld((_req, i) => {
      if (i === 0) return callTool("request_purchase", { amount: 40, merchant: "argos.co.uk", item: "a kettle" });
      return reply("ok");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip get me a kettle" });
    expect(run?.status).toBe("waiting");
    // A new request that names the agent, in the group and in the DM, starts its own run.
    const plumber = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip also find me a plumber for Saturday" });
    expect(plumber?.id).not.toBe(run!.id);
    const reminder = await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "@pip remind me to call mum tomorrow" });
    expect(reminder?.id).not.toBe(run!.id);
    const item = w.app.store.listAttention({ roomId: w.room.id })[0]!;
    expect(item.status).toBe("open");
    expect(w.app.store.getRun(run!.id)!.status).toBe("waiting");
    // Chatter without the agent's name is chatter.
    expect(await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "Thanks everyone, Jo will be home all week." })).toBeUndefined();
    expect(w.app.store.getAttention(item.id)!.status).toBe("open");
    // A plain yes still approves it.
    const resumed = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "yes" });
    expect(resumed?.id).toBe(run!.id);
  });

  test("a US number without its country code still dials; a malformed one does not", () => {
    expect(e164("(408) 555-0100")).toBe("+14085550100");
    expect(e164("1-408-555-0100")).toBe("+14085550100");
    expect(e164("+44 20 7946 0958")).toBe("+442079460958");
    expect(e164("555-0100")).toBeUndefined();
  });

  test("a soft opener on a long message is not a yes", () => {
    expect(parseDecision("ok")).toEqual({ kind: "yes" });
    expect(parseDecision("ok, go ahead")).toEqual({ kind: "yes" });
    expect(parseDecision("ok, but first check the price with the other shop and tell me")).toBeUndefined();
    expect(parseDecision("yes, but first check the price with the other shop and tell me")).toEqual({ kind: "yes" });
    expect(parseDecision("please don't")).toEqual({ kind: "no" });
  });

  test("messages written in the same millisecond keep their order", async () => {
    const w = groupWorld(() => reply("ok"));
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip first" });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip second" });
    expect(w.app.store.messagesForRoom(w.room.id).map((m) => m.text.split("\n")[0])).toEqual(["@pip first", "ok", "@pip second", "ok"]);
  });
});

describe("planner", () => {
  test("a stalled approach switches to the next rung after two attempts and the model is told", async () => {
    const search = new FakeSearch(() => []);
    const w = groupWorld(
      (req, i) => {
        if (i === 0) return callTool("plan", { goal: "Find a Mandarin-speaking handyman", steps: [{ text: "Find candidates", approach: "search" }] });
        if (i === 1 || i === 2) return callTool("web_search", { query: "handyman mandarin" });
        const t = JSON.stringify(req.messages);
        expect(t).toContain('the plan now tries "browse"');
        return reply("Nothing online; I'll ask the group next.");
      },
      { search },
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a mandarin handyman" });
    const plan = w.app.planner.get(run!.id)!;
    expect(plan.steps[0]!.approach).toBe("browse");
    expect(plan.steps[0]!.attempts).toBe(0);
    expect(
      w.app.store
        .toolCallsForRun(run!.id)
        .filter((c) => c.name === "web_search")
        .every((c) => c.labelDone.includes("nothing yet")),
    ).toBe(true);
  });

  test("parallel tool calls are all answered in one user message", async () => {
    const w = groupWorld((req, i) => {
      if (i === 0)
        return callTools([
          { name: "search_memory", input: { query: "plumber" } },
          { name: "search_memory", input: { query: "vet" } },
        ]);
      const last = req.messages.at(-1)!;
      expect(Array.isArray(last.content) && last.content.filter((b) => b.type === "tool_result").length).toBe(2);
      return reply("ok");
    });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip check notes" });
  });
});

describe("hands", () => {
  test("browse_page reads a page through the browser hand and records evidence", async () => {
    const { FakeBrowser } = await import("../src/tools/browser.ts");
    const browser = new FakeBrowser((url) =>
      url.includes("lin-repair")
        ? { title: "Lin Home Repair", text: "Open Mon–Sat 8–6. Call 408-555-0142.", links: [{ text: "Book", href: "https://lin-repair.example/book" }] }
        : {},
    );
    const w = groupWorld(
      (req, i) => {
        if (i === 0) return callTool("browse_page", { url: "https://lin-repair.example" });
        const last = lastToolResult(req) ?? "";
        expect(last).toContain("408-555-0142");
        return reply("They're open Mon to Sat, 8 to 6.");
      },
      { browser },
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip when is Lin Home Repair open?" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    expect(call.name).toBe("browse_page");
    expect(call.evidence).toBe("fake-browser:1");
    expect(call.labelDone).toBe("Read lin-repair.example");
    expect(browser.visited).toEqual(["https://lin-repair.example"]);
  });

  test("model config picks OpenRouter with DeepSeek V4.1 Flash by default and maps Claude ids between doors", async () => {
    const { modelConfig, normalizeModelId } = await import("../src/model/config.ts");
    expect(modelConfig({ OPENROUTER_API_KEY: "x" })).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash-1017",
      smallModel: "deepseek/deepseek-v4.1-flash-1017",
    });
    // MODEL alone moves both; MODEL_SMALL splits the small calls off again.
    expect(modelConfig({ OPENROUTER_API_KEY: "x", MODEL: "anthropic/claude-opus-5.5" })).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-opus-5.5",
      smallModel: "anthropic/claude-opus-5.5",
    });
    expect(modelConfig({ OPENROUTER_API_KEY: "x", MODEL: "anthropic/claude-opus-5.5", MODEL_SMALL: "z-ai/glm-5.3-flash" }).smallModel).toBe("z-ai/glm-5.3-flash");
    expect(modelConfig({ ANTHROPIC_API_KEY: "x" })).toEqual({ provider: "anthropic", model: "claude-opus-5-5", smallModel: "claude-haiku-5-5" });
    expect(modelConfig({}).provider).toBe("none");
    expect(normalizeModelId("claude-opus-5-5", "openrouter")).toBe("anthropic/claude-opus-5.5");
    expect(normalizeModelId("anthropic/claude-haiku-5.5", "anthropic")).toBe("claude-haiku-5-5");
    expect(normalizeModelId("z-ai/glm-5.3", "openrouter")).toBe("z-ai/glm-5.3");
  });
});

describe("messages that arrive together", () => {
  test("a second message during the first run's start steers it instead of failing it as a restart", async () => {
    const seen: string[] = [];
    const w = groupWorld(
      (req) => {
        seen.push(JSON.stringify(req.messages));
        return reply("On it.");
      },
      { completer: () => "yes" },
    );
    const a = w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "Can someone find a plumber for Jo's leaking tap this week?" });
    const b = w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "Also ask them about the bathroom fan while they're there." });
    await Promise.all([a, b]);
    expect(w.app.store.listRuns({ roomId: w.room.id }).map((r) => r.status)).toEqual(["done"]);
    expect(seen.some((s) => s.includes("[while you were working] Sam"))).toBe(true);
    expect(repliesTo(w.deliveries, w.room.id)).toHaveLength(1);
  });

  test("un-named group messages are classified at most six times a minute per room", async () => {
    let checks = 0;
    const w = groupWorld(() => reply("ok"), {
      completer: () => {
        checks += 1;
        return "no";
      },
    });
    for (let i = 0; i < 10; i++) await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: `Chatter number ${i} that is long enough to be checked.` });
    expect(checks).toBe(6);
    w.clock.set(w.clock.now() + 61_000);
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "Another long enough message after a minute passed." });
    expect(checks).toBe(7);
  });
});

describe("a group of one", () => {
  test("in a group where you are the only person, the assistant answers without being named", async () => {
    const w = groupWorld(() => reply("Hi!"), { completer: () => "no" });
    const room = w.app.rooms.createRoom({ agentId: w.agent.id, kind: "group", channel: "web", name: "Group Buying" });
    w.app.rooms.addMember(room.id, w.alex.id, "owner");
    const run = await w.app.runtime.handleMessage({ roomId: room.id, personId: w.alex.id, text: "hey" });
    expect(run?.status).toBe("done");
    expect(repliesTo(w.deliveries, room.id)).toEqual(["Hi!"]);
  });
});

describe("search steps read like Fo's", () => {
  test("a search step is labelled with its query, a page read with its site, and the model's words between tool calls stay in the thread", async () => {
    const search = new FakeSearch(() => [{ title: "Lin Home Repair", url: "https://lin-repair.example", snippet: "Mandarin spoken" }]);
    const browser = new FakeBrowser(() => ({ text: "Open Mon to Sat, 8 to 6." }));
    const w = groupWorld(
      (_req, i) =>
        i === 0
          ? callTool("web_search", { query: "mandarin handyman san jose" }, "Nothing on file, so I'm searching the open web.")
          : i === 1
            ? callTool("browse_page", { url: "https://lin-repair.example/hours" })
            : reply("Lin Home Repair speaks Mandarin."),
      { search, browser },
    );
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a mandarin handyman" });
    const replies = repliesTo(w.deliveries, w.room.id);
    expect(replies[0]).toContain("— 2 steps · 2 verified: Searched: mandarin handyman san jose, Read lin-repair.example");
    expect(w.deliveries.filter((d) => d.kind === "progress").map((d) => d.text)).toEqual(["Nothing on file, so I'm searching the open web."]);
    const texts = w.app.store
      .messagesForRoom(w.room.id)
      .filter((m) => m.role === "assistant")
      .map((m) => [m.source, m.text.split("\n")[0]]);
    expect(texts).toEqual([
      ["narration", "Nothing on file, so I'm searching the open web."],
      [undefined, "Lin Home Repair speaks Mandarin."],
    ]);
  });
});

describe("people the assistant knows", () => {
  test("find_person matches members of its chats; a phone number is shown only to the owner or the person themselves", async () => {
    const w = groupWorld((req) => (toolCallsSoFar(req).some((c) => c.name === "find_person") ? reply("Found Sam.") : callTool("find_person", { query: "sam" })));
    const sam = w.app.store.getPerson("sam")!;
    sam.phoneE164 = "+14085550177";
    w.app.store.putPerson(sam);
    const asGuest = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip what's Sam's number?" });
    const seenByGuest = w.app.store.toolCallsForRun(asGuest!.id)[0]!.result as { id: string; name: string; rooms: string[]; phone?: string }[];
    expect(seenByGuest[0]).toEqual({ id: "sam", name: "Sam", rooms: ["Tahoe trip"] });
    const asOwner = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip what's Sam's number?" });
    const seenByOwner = w.app.store.toolCallsForRun(asOwner!.id)[0]!.result as { phone?: string }[];
    expect(seenByOwner[0]!.phone).toBe("+14085550177");
    expect(w.app.store.toolCallsForRun(asOwner!.id)[0]!.labelDone).toBe("Looked up: sam");
  });
});

describe("members from the chat", () => {
  test("the owner adds and removes people by asking; a member is told to ask the owner", async () => {
    const w = groupWorld((req) => {
      const t = lastUserText(req);
      if (/add my sister/i.test(t)) return toolCallsSoFar(req).length ? reply("Added Mia.") : callTool("add_member", { name: "Mia", phone: "+14155550101" });
      if (/remove riley/i.test(t)) return toolCallsSoFar(req).length ? reply("Done.") : callTool("remove_member", { name: "Riley" });
      return reply("ok");
    });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip add my sister Mia, +1 415 555 0101" });
    const mia = w.app.store.findPersonByPhone("+14155550101")!;
    expect(w.app.rooms.role(w.room.id, mia.id)).toBe("member");
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip remove riley from this chat" });
    expect(w.app.rooms.role(w.room.id, "riley")).toBe("guest"); // Sam may not
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip remove riley from this chat" });
    expect(w.app.rooms.role(w.room.id, "riley")).toBeUndefined();
  });
});
