import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { callTool, callTools, lastToolResult, lastUserText, reply, toolCallsSoFar, ScriptedModel, transcriptHas } from "../src/model/scripted.ts";
import { groupWorld, noticesTo, repliesTo } from "./helpers.ts";
import { claimLinkCode, mintLinkCode, personIdForHandle } from "../src/channels/handles.ts";
import { FakePhone, FakeSearch } from "../src/tools/hands.ts";
import { FakeBrowser } from "../src/tools/browser.ts";
import { TOOLS, toolsForRun } from "../src/tools/registry.ts";
import { createApp } from "../src/app.ts";
import { newAgent } from "../src/agent/spec.ts";
import { newId } from "../src/core/ids.ts";
import type { Run, ToolCallRecord } from "../src/core/types.ts";
import type { Delivery } from "../src/runtime/runtime.ts";
import { buildFooter, estimateFor, integrityNote } from "../src/runtime/runtime.ts";
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

  test("a chat in Messages gets an 'on it' with an estimate at the first tool call; the web chat does not", async () => {
    const search = new FakeSearch(() => [{ title: "Lee's Repairs", url: "https://x", snippet: "handyman" }]);
    const w = groupWorld((_req, i) => (i === 0 ? callTool("web_search", { query: "handyman" }) : reply("Found Lee's Repairs.")), { search });
    w.app.store.putRoom({ ...w.room, channel: "imessage" });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a handyman" });
    const kinds = w.deliveries.filter((d) => d.roomId === w.room.id).map((d) => [d.kind, d.text.split("\n")[0]]);
    expect(kinds[0]).toEqual(["ack", "On it — about a minute."]);
    expect(kinds.at(-1)![0]).toBe("reply");
    expect(estimateFor("hotel_compare", {})).toBe("give me 2 or 3 minutes");
    expect(estimateFor("plan", { steps: [{ text: "compare hotels" }, { text: "compare flights" }] })).toBe("give me 3 to 5 minutes");
  });

  test("tool calls are recorded with labels and evidence, and the footer is built from records", async () => {
    const search = new FakeSearch((q) => (q.includes("handyman") ? [{ title: "Lee's Repairs", url: "https://x", snippet: "Mandarin-speaking handyman" }] : []));
    const w = groupWorld(
      (req, i) => {
        if (i === 0) return callTool("web_search", { query: "Mandarin speaking handyman San Jose" });
        expect(lastToolResult(req)).toContain("Lee's Repairs");
        // A footer the model copied from an earlier reply is dropped; only the records' footer stays.
        return reply("Found Lee's Repairs. Want me to call them?\n— 3 steps · 2 verified: Made a call");
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
    expect(text).not.toContain("Made a call");
    expect(text.split("\n").filter((l) => l.startsWith("— "))).toHaveLength(1);
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

  test("a tool that fails twice the same way earns a note telling the model to stop calling it", async () => {
    const w = groupWorld(
      (req, i) => {
        if (i < 3) return callTool("browse_page", { url: "https://down.example/" });
        const t = JSON.stringify(req.messages);
        expect(t).toContain("failed twice in a row");
        return reply("The page is down; I'll try later.");
      },
      {
        browser: new FakeBrowser(() => {
          throw new Error("connectOverCDP: Timeout 30000ms exceeded");
        }),
      },
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip read down.example" });
    expect(run?.status).toBe("done");
    expect(w.app.store.toolCallsForRun(run!.id).filter((c) => c.status === "failed").length).toBeGreaterThanOrEqual(2);
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

describe("context economics", () => {
  test("the system prompt arrives in two blocks: identity and priorities stable, the room and ledger volatile", async () => {
    const w = groupWorld(() => reply("ok"));
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip hi" });
    const call = w.model.calls[0]!;
    expect(call.system.stable).toContain("How you work");
    expect(call.system.stable).toContain("Priorities in this chat: The Tahoe trip");
    expect(call.system.stable).not.toContain("Where you are");
    expect(call.system.volatile).toContain("Where you are");
    expect(call.system.volatile).toContain("Responsibilities ledger for this room");
    expect(call.system.volatile).toContain("Now:");
  });

  test("the run's tool list follows the wired providers and is fixed across turns", async () => {
    const seen: string[][] = [];
    const w = groupWorld(
      (req) => {
        seen.push(req.tools.map((t) => t.name));
        return reply("ok");
      },
      { providers: [] },
    );
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip hi" });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip hi again" });
    expect(seen[0]).toContain("web_search");
    expect(seen[0]).not.toContain("text_to_speech"); // needs the speech provider, which is not wired
    expect(seen[0]).toEqual(seen[1]); // stable so the prefix caches
  });

  test("with every provider wired the whole catalogue is offered; with none, only ungated tools", () => {
    const none = toolsForRun(new Set());
    const all = toolsForRun(new Set(["google", "email", "slack", "speech", "images", "payments", "phone", "browser", "hotels", "flights", "community"]));
    expect(none).toContainEqual(expect.objectContaining({ name: "web_search" }));
    expect(none.find((t) => t.name === "text_to_speech")).toBeUndefined();
    expect(all.map((t) => t.name)).toEqual(TOOLS.map((t) => t.spec.name));
  });
});

describe("durable execution", () => {
  test("a run interrupted mid-action resumes at boot, is told the restart happened, and does not lose the run", async () => {
    const db = join(tmpdir(), `circle-resume-${Math.random().toString(36).slice(2)}.sqlite`);
    try {
      // First process: a run whose place_call never finished (the process died inside it).
      const a1 = createApp({ dbPath: db, model: new ScriptedModel(() => reply("unreachable")) });
      const alex = a1.rooms.createPerson({ displayName: "Alex", timezone: "UTC" });
      const agent = newAgent({ ownerId: alex.id, name: "Pip" });
      a1.store.putAgent(agent);
      const room = a1.rooms.dmFor(agent, alex.id);
      const session = { id: newId("ses"), roomId: room.id, agentId: agent.id, kind: "room" as const, createdAt: a1.clock.now(), lastActivityAt: a1.clock.now() };
      a1.store.putSession(session);
      const run: Run = {
        id: newId("run"),
        sessionId: session.id,
        roomId: room.id,
        agentId: agent.id,
        trigger: "message",
        requesterId: alex.id,
        status: "running",
        startedAt: a1.clock.now(),
      };
      a1.store.putRun(run);
      const rec: ToolCallRecord = {
        id: newId("tc"),
        runId: run.id,
        name: "place_call",
        family: "calls",
        status: "running",
        input: { to: "+14085550100", who: "Lee's Repairs", objective: "book Thursday" },
        labelRunning: "On a call…",
        labelDone: "Made a call",
        fingerprint: "",
        startedAt: a1.clock.now(),
      };
      a1.store.putToolCall(rec);
      a1.store.setKv(
        `transcript:${run.id}`,
        JSON.stringify([
          { role: "user", content: "Alex: @pip call Lee's Repairs and book Thursday" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_crash", name: "place_call", input: rec.input }] },
        ]),
      );

      // Second process, same database: the boot resume continues the run.
      let saw: string | undefined;
      const a2 = createApp({
        dbPath: db,
        model: new ScriptedModel((req) => {
          saw = JSON.stringify(req.messages);
          return reply("Lee's can do Thursday 2pm, about $120.");
        }),
      });
      const deliveries: Delivery[] = [];
      a2.onDeliver((d) => deliveries.push(d));
      await a2.runtime.settle();

      const after = a2.store.getRun(run.id)!;
      expect(after.status).toBe("done");
      expect(saw).toContain("restarted"); // the model is told the effect is unknown
      expect(a2.store.toolCallsForRun(run.id).filter((c) => c.name === "place_call")).toHaveLength(1); // nothing re-dialled
      expect(a2.store.eventsForRun(run.id).some((e) => e.type === "resumed")).toBe(true);
      expect(deliveries.some((d) => d.roomId === room.id && d.text.includes("Thursday 2pm"))).toBe(true);
    } finally {
      rmSync(db, { force: true });
      rmSync(`${db}-wal`, { force: true });
      rmSync(`${db}-shm`, { force: true });
    }
  });

  test("an exact repeat of a completed side effect returns the first result instead of acting twice", async () => {
    const phone = new FakePhone(() => ({ status: "completed", summary: "Thursday 2pm works, about $120." }));
    const w = groupWorld(
      (req, i) => {
        if (i === 0) return callTool("place_call", { to: "+14085550100", who: "Lee's Repairs", objective: "book Thursday" });
        if (i === 1) {
          // A resumed run re-issues its last action; the runtime must not dial twice.
          expect(JSON.stringify(req.messages)).not.toContain("restarted");
          return callTool("place_call", { to: "+14085550100", who: "Lee's Repairs", objective: "book Thursday" });
        }
        return reply("Booked: Thursday 2pm, about $120.");
      },
      { phone },
    );
    w.agent.trust.autoAllow = ["place_call"];
    w.app.store.putAgent(w.agent);
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip call Lee's Repairs and book Thursday" });
    expect(w.hands.phone.calls).toHaveLength(1); // dialled once
    const calls = w.app.store.toolCallsForRun(run!.id).filter((c) => c.name === "place_call");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.labelDone).toContain("already done");
    expect(calls[1]!.evidence).toBe(calls[0]!.evidence);
  });
});

describe("group join", () => {
  test("first contact with a group introduces the agent once and notices the owner", async () => {
    const w = groupWorld(
      (req, i) => {
        if (i === 0) {
          expect(lastUserText(req)).toContain("Introduce yourself");
          return reply("Hi, I'm Pip — Alex's assistant for finding, booking and reminders. I ask before contacting anyone or spending money.");
        }
        return reply("ok");
      },
      { completer: () => "no" },
    );
    const street = w.app.rooms.createRoom({ agentId: w.agent.id, kind: "group", channel: "imessage", name: "Maple Street" });
    const riley = w.app.rooms.createPerson({ id: "newcomer", displayName: "Riley", timezone: "UTC" });
    const run = await w.app.runtime.groupJoined(street, riley);
    await w.app.runtime.settle();
    expect(run?.status).toBe("done");
    // The introduction was delivered to the group exactly once.
    expect(repliesTo(w.deliveries, street.id)).toHaveLength(1);
    const events = w.app.store.eventsForRun(run!.id).map((e) => e.type);
    expect(events[0]).toBe("started");
    // The owner heard about it deterministically: no model call involved in the notice.
    const notice = w.app.store.messagesForRoom(w.ownerDm.id).find((m) => m.source === "notice");
    expect(notice?.text).toContain("Maple Street");
    expect(notice?.text).toContain("Riley");
    // Second contact (a redeployed channel, a replay) starts no second introduction.
    const again = await w.app.runtime.groupJoined(street, riley);
    expect(again).toBeUndefined();
    expect(w.app.store.listRuns({ roomId: street.id })).toHaveLength(1);
  });

  test("the introduction is a request to the model, but silence on it would be recorded, not crash", async () => {
    const w = groupWorld(() => reply("(nothing to report)"), { completer: () => "no" });
    const street = w.app.rooms.createRoom({ agentId: w.agent.id, kind: "group", channel: "imessage", name: "Maple Street" });
    const riley = w.app.rooms.createPerson({ id: "newcomer", displayName: "Riley", timezone: "UTC" });
    const run = await w.app.runtime.groupJoined(street, riley);
    await w.app.runtime.settle();
    expect(run?.status).toBe("done");
    expect(run?.quiet).toBe(true); // silence is an outcome, even on a join
    expect(repliesTo(w.deliveries, street.id)).toHaveLength(0);
  });
});

describe("the budget fence", () => {
  test("after the budget answers, the open web is refused even in the same parallel batch; the shopping path is not", async () => {
    const w = groupWorld(
      (req, i) => {
        if (i === 0)
          return callTools([
            { name: "request_purchase", input: { amountUsd: 12, what: "AA batteries", where: "Walgreens" } },
            { name: "web_search", input: { query: "AA batteries cheapest" } },
          ]);
        const t = JSON.stringify(req.messages);
        expect(t).toContain("The budget already answered");
        return reply("Cleared for $12 — the order itself has to be placed by hand.");
      },
      { completer: () => "no" },
    );
    w.agent.trust.autoApproveUnderUsd = 25;
    w.app.store.putAgent(w.agent);
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip order Jo batteries, about $12" });
    const calls = w.app.store.toolCallsForRun(run!.id);
    const buy = calls.find((c) => c.name === "request_purchase")!;
    expect(buy.status).toBe("done");
    expect(buy.evidence).toContain("purchase-approved");
    const shop = calls.filter((c) => c.name === "web_search");
    expect(shop).toHaveLength(1);
    expect(shop[0]!.status).toBe("failed");
    expect(String(shop[0]!.result)).toContain("budget already answered");
    expect(run?.status).toBe("done");
    expect(repliesTo(w.deliveries, w.room.id)).toHaveLength(1);
  });

  test("a connected checkout still runs after the verdict", async () => {
    const w = groupWorld((req, i) => {
      if (i === 0) return callTool("request_purchase", { amountUsd: 12, what: "AA batteries", where: "Walgreens" });
      if (i === 1)
        return callTools([
          { name: "add_to_cart", input: { title: "AA batteries 12-pack", url: "https://www.walgreens.com/batteries", priceUsd: 11.99, quantity: 1 } },
          { name: "checkout_cart", input: {} },
        ]);
      const last = lastToolResult(req) ?? "";
      expect(last).not.toContain("budget already answered");
      return reply("Budget cleared at Walgreens: $11.99. Nothing was ordered — here are the links to finish.");
    }, {});
    w.agent.trust.autoApproveUnderUsd = 25;
    w.alex.addresses = [{ id: "addr1", label: "Home", line1: "1 Maple St", city: "San Jose", region: "CA", postalCode: "95101", country: "US" }];
    w.app.store.putPerson(w.alex);
    w.app.store.putAgent(w.agent);
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip order Jo batteries, about $12" });
    const calls = w.app.store.toolCallsForRun(run!.id).filter((c) => ["checkout_cart", "add_to_cart"].includes(c.name));
    expect(calls.length).toBe(2);
    expect(calls.every((c) => !String(c.result).includes("budget already answered"))).toBe(true);
    const checkout = calls.find((c) => c.name === "checkout_cart")!;
    expect(checkout.status).toBe("done");
    expect(String((checkout.result as { note?: string }).note)).toContain("NOT placed"); // an approval is not a purchase
    expect(run?.status).toBe("done");
  });

  test("a declined budget fences too, including after the resume", async () => {
    const w = groupWorld(
      (req, i) => {
        const t = JSON.stringify(req.messages);
        if (i === 0) return callTool("request_purchase", { amountUsd: 80, what: "blood pressure monitor", where: "Walgreens" });
        if (t.includes("[DECLINED]")) return callTool("web_search", { query: "cheaper blood pressure monitors" });
        return reply("Waiting for the OK on $80.");
      },
      { completer: () => "no" },
    );
    const first = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip buy Jo the $80 monitor" });
    expect(first?.status).toBe("waiting");
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "no" });
    await w.app.runtime.settle();
    const run = w.app.store.listRuns({ roomId: w.room.id })[0]!;
    expect(run.status).toBe("done");
    const search = w.app.store.toolCallsForRun(run.id).find((c) => c.name === "web_search");
    expect(search?.status).toBe("failed");
    expect(String(search?.result)).toContain("budget already answered");
  });
});

describe("identity merge", () => {
  test("a stranger who later signs up becomes one person: memberships move, the guest becomes a member, history stays attributed", async () => {
    const w = groupWorld(() => reply("ok"));
    const handle = "+14085550123";
    const derivedId = personIdForHandle(handle);
    // The stranger texted first: a derived record with their phone, a guest membership, a message, a memory about them.
    w.app.rooms.createPerson({ id: derivedId, displayName: handle, timezone: "UTC", phoneE164: handle });
    w.app.rooms.addMember(w.room.id, derivedId, "guest");
    w.app.memory.write({
      agentId: w.agent.id,
      scope: "person",
      scopeId: derivedId,
      type: "observation",
      text: "Speaks Mandarin with the plumber",
      subjectPersonId: derivedId,
      visibleToRooms: [w.room.id],
    });
    const signedUp = w.app.rooms.createPerson({ displayName: "Riley", timezone: "UTC", email: "riley@example.com" });
    // They sign up; the merge folds the derived record into the signed-up one.
    const kept = w.app.rooms.mergePeople(signedUp.id, derivedId)!;
    expect(kept.id).toBe(signedUp.id);
    expect(kept.mergedFrom).toContain(derivedId);
    // The room membership moved and became a member; the old record is out of the room.
    expect(w.app.rooms.memberIds(w.room.id)).toContain(signedUp.id);
    expect(w.app.rooms.memberIds(w.room.id)).not.toContain(derivedId);
    expect(w.app.rooms.role(w.room.id, signedUp.id)).toBe("member");
    // The dropped record still answers for history, and points at the survivor.
    const old = w.app.store.getPerson(derivedId)!;
    expect(old.mergedInto).toBe(signedUp.id);
    // Phone lookups follow the pointer: the next text lands on the signed-up person.
    expect(w.app.store.findPersonByPhone(handle)?.id).toBe(signedUp.id);
    // The memory about them followed, and recall for the new person finds it.
    const recalled = w.app.memory.recall(w.agent.id, w.room, w.app.rooms.memberIds(w.room.id), "Mandarin plumber");
    expect(recalled.some((m) => m.text.includes("Mandarin") && m.scopeId === signedUp.id)).toBe(true);
  });

  test("the link-code flow merges the derived record into the signed-in person", async () => {
    const w = groupWorld(() => reply("ok"));
    const handle = "+14085550187";
    const derivedId = personIdForHandle(handle);
    w.app.rooms.createPerson({ id: derivedId, displayName: handle, timezone: "UTC", phoneE164: handle });
    w.app.rooms.addMember(w.room.id, derivedId, "guest");
    const signedIn = w.app.rooms.createPerson({ displayName: "Riley", timezone: "UTC" });
    const code = mintLinkCode(w.app.store, signedIn.id, w.clock.now());
    const linked = claimLinkCode(w.app.store, code, handle, w.clock.now())!;
    expect(linked.id).toBe(signedIn.id);
    // The caller's merge (as the channel does it) folds the stranger record in.
    const derived = w.app.store.getPerson(derivedId)!;
    if (derived.id !== linked.id && !derived.mergedInto) w.app.rooms.mergePeople(linked.id, derived.id);
    expect(w.app.rooms.role(w.room.id, signedIn.id)).toBe("member");
    expect(w.app.store.getPerson(derivedId)!.mergedInto).toBe(signedIn.id);
  });
});

describe("co-owners", () => {
  const trustOf = (autoApproveUnderUsd: number) => ({ autoApproveUnderUsd, spendingPaused: false, autoAllow: [], communityPostingAllowed: [] });

  test("a room owner promotes a member to co-owner; guests and owners are refused", () => {
    const w = groupWorld(() => reply("ok"));
    expect(w.app.rooms.promoteOwner(w.room.id, "sam")!.role).toBe("owner");
    expect(w.app.rooms.promoteOwner(w.room.id, "sam")).toBeUndefined(); // already an owner
    expect(w.app.rooms.promoteOwner(w.room.id, "riley")).toBeUndefined(); // a guest becomes a member first
    expect(w.app.rooms.promoteOwner(w.room.id, "alex")).toBeUndefined(); // the owner seat is not demotable here
    expect(w.app.rooms.role(w.room.id, "sam")).toBe("owner");
  });

  test("a co-owner's purchase above their own threshold cards them, not the other owner", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("request_purchase", { amountUsd: 12, what: "batteries", where: "Walgreens" }) : reply("ok")));
    w.app.rooms.promoteOwner(w.room.id, "sam");
    w.app.store.putPerson({ ...w.app.store.getPerson("sam")!, trust: trustOf(10) });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip buy Jo the $12 batteries" });
    const item = w.app.store.listAttention({ roomId: w.room.id }).find((a) => a.kind === "purchase_approval");
    expect(item?.assigneeId).toBe("sam"); // Sam's card goes to Sam's own DM
    expect(run?.status).toBe("waiting");
    const calls = w.app.store.toolCallsForRun(run!.id).filter((c) => c.name === "request_purchase");
    expect(calls.every((c) => !c.evidence)).toBe(true); // nothing bought before the yes
  });

  test("a co-owner's small purchase passes under their own threshold, whatever the other owner allows", async () => {
    const w = groupWorld((_req, i) => {
      if (i === 0) return callTool("request_purchase", { amountUsd: 8, what: "AA batteries", where: "Walgreens" });
      return reply("Cleared for $8 — the order has to be placed by hand.");
    });
    w.app.rooms.promoteOwner(w.room.id, "sam");
    w.app.store.putPerson({ ...w.app.store.getPerson("sam")!, trust: trustOf(10) });
    w.agent.trust.autoApproveUnderUsd = 5; // Alex allows less; Sam's own trust is what counts for Sam
    w.app.store.putAgent(w.agent);
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip buy Jo batteries, about $8" });
    expect(run?.status).toBe("done");
    const buy = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "request_purchase")!;
    expect(buy.evidence).toContain("purchase-approved");
    expect(String(buy.result)).toContain("under Sam's $10 threshold"); // Sam's trust, not Alex's
    expect(w.app.store.listAttention({ roomId: w.room.id })).toHaveLength(0);
  });

  test("the agent owner's own purchases still follow the agent trust", async () => {
    const w = groupWorld((_req, i) => {
      if (i === 0) return callTool("request_purchase", { amountUsd: 12, what: "AA batteries", where: "Walgreens" });
      return reply("Cleared for $12.");
    });
    w.agent.trust.autoApproveUnderUsd = 25;
    w.app.store.putAgent(w.agent);
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip order Jo batteries, about $12" });
    const buy = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "request_purchase")!;
    expect(buy.evidence).toContain("purchase-approved");
    expect(String(buy.result)).toContain("under Alex's $25 threshold");
  });
});

describe("audit fixes, 23 October", () => {
  test("a merge carries the stranger's open card, credential and responsibility to the signed-up person", async () => {
    const w = groupWorld(() => reply("ok"));
    const handle = "+14085550144";
    const derivedId = personIdForHandle(handle);
    w.app.rooms.createPerson({ id: derivedId, displayName: handle, timezone: "UTC", phoneE164: handle });
    w.app.rooms.addMember(w.room.id, derivedId, "guest");
    const card = w.app.attention.open({
      agentId: w.agent.id,
      roomId: w.room.id,
      assigneeId: derivedId,
      kind: "decision",
      title: "Which day?",
      detail: "Thursday or Friday",
      ttlMs: 86_400_000,
    });
    w.app.vault.put(derivedId, "gmail", "secret-token");
    const job = w.app.commitments.track({ roomId: w.room.id, agentId: w.agent.id, ownerId: derivedId, title: "Bring chairs" });
    const riley = w.app.rooms.createPerson({ displayName: "Riley", timezone: "UTC" });
    w.app.rooms.mergePeople(riley.id, derivedId);
    expect(w.app.attention.openFor(riley.id).map((a) => a.id)).toContain(card.id); // their answer will find it
    expect(w.app.vault.has(riley.id, "gmail")).toBe(true);
    expect(w.app.vault.has(derivedId, "gmail")).toBe(false);
    expect(w.app.store.getCommitment(job.id)!.ownerId).toBe(riley.id);
  });

  test("what Alex tells the agent privately about Sam never reaches Sam's own chat", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("remember", { type: "fact", text: "Sam is hiding his debts from Alex.", about: "Sam" }) : reply("Noted.")));
    w.app.rooms.addMember(w.ownerDm.id, "sam", "guest"); // findMember resolves Sam from Alex's chat
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "remember Sam is hiding his debts from me" });
    w.app.rooms.removeMember(w.ownerDm.id, "sam");
    const note = w.app.store.listMemories(w.agent.id, { includeInactive: true }).find((m) => m.text.includes("debts"))!;
    expect(note.scopeId).toBe("sam");
    expect(note.visibleToRooms).toEqual([w.ownerDm.id]);
    const sam = w.app.memory.visibleIn(w.agent.id, w.samDm, ["sam"], { requesterId: "sam" });
    expect(sam.some((m) => m.text.includes("debts"))).toBe(false);
    // Sam's own private notes still reach him in his chat.
    w.app.memory.write({ agentId: w.agent.id, scope: "person", scopeId: "sam", type: "preference", text: "Sam prefers mornings." });
    expect(w.app.memory.visibleIn(w.agent.id, w.samDm, ["sam"], { requesterId: "sam" }).some((m) => m.text.includes("mornings"))).toBe(true);
  });

  test("a responsibility due in the past is refused with today's date, so a wrong year never nudges at once", async () => {
    const w = groupWorld((req, i) => {
      if (i === 0) return callTool("track_commitment", { title: "Cook Thursday", owner: "Sam", dueAt: "2025-10-15T19:00:00-07:00" });
      expect(lastToolResult(req)).toContain("in the past");
      if (i === 1) return callTool("track_commitment", { title: "Cook Thursday", owner: "Sam", dueAt: "2026-10-15T19:00:00-07:00" });
      return reply("Tracked.");
    });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip I'll cook Thursday" });
    const open = w.app.commitments.open(w.room.id);
    expect(open).toHaveLength(1);
    expect(new Date(open[0]!.dueAt!).getUTCFullYear()).toBe(2026);
  });

  test("something already owed ('since Monday') is tracked when flagged overdue, and nudged in an hour rather than at once", async () => {
    const w = groupWorld((_req, i) => {
      if (i === 0) return callTool("track_commitment", { title: "Pay Alex back for the groceries", owner: "Sam", dueAt: "2026-10-12T09:00:00-07:00", overdue: true });
      return reply("Tracked.");
    });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip Sam has owed me $40 for groceries since Monday" });
    const [c] = w.app.commitments.open(w.room.id);
    expect(c?.dueAt).toBeLessThan(w.clock.now());
    expect(c!.nextNudgeAt! - w.clock.now()).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1);
    expect(w.app.store.toolCallsForRun(w.app.store.listRuns({ roomId: w.room.id })[0]!.id)[0]!.result).toMatchObject({ overdue: true });
  });

  test("a run that chooses silence on a texting channel sends no 'on it'", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("stay_quiet", { reason: "chatter" }) : reply("ok")), { completer: () => "yes" });
    const chat = w.app.rooms.createRoom({ agentId: w.agent.id, kind: "group", channel: "imessage", name: "Street" });
    w.app.rooms.addMember(chat.id, "alex", "owner", { consented: true });
    w.app.rooms.addMember(chat.id, "sam", "member");
    await w.app.runtime.handleMessage({ roomId: chat.id, personId: "sam", text: "@pip anyone around this weekend?" });
    expect(w.deliveries.filter((d) => d.roomId === chat.id && d.kind === "ack")).toHaveLength(0);
  });

  test("a task delegated just before a crash starts again at the next boot", async () => {
    const db = join(tmpdir(), `circle-task-${Math.random().toString(36).slice(2)}.sqlite`);
    try {
      const a1 = createApp({ dbPath: db, model: new ScriptedModel(() => reply("unreachable")) });
      const alex = a1.rooms.createPerson({ displayName: "Alex", timezone: "UTC" });
      const agent = newAgent({ ownerId: alex.id, name: "Pip" });
      a1.store.putAgent(agent);
      const room = a1.rooms.dmFor(agent, alex.id);
      // The task row exists and says running, but the process died before its run launched.
      const task = a1.tasks.create({ agentId: agent.id, roomId: room.id, requesterId: alex.id, title: "Find a repairer", instructions: "Search and report one name." });
      const a2 = createApp({ dbPath: db, model: new ScriptedModel(() => reply("Done: Lin Home Repair, (408) 555-0100.")) });
      await new Promise((r) => setTimeout(r, 0)); // reconcile schedules restarts after listeners attach
      await a2.runtime.settle();
      expect(a2.store.getTask(task.id)!.status).toBe("done");
    } finally {
      for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    }
  });

  test("an abandoned sign-in card ends its live browser session without saving it", async () => {
    const browser = new FakeBrowser();
    const w = groupWorld((_req, i) => (i === 0 ? callTool("connect_account", { site: "walgreens.com", why: "order batteries" }) : reply("Waiting for the sign-in.")), { browser });
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "order batteries from walgreens" });
    const item = w.app.store.listAttention({ roomId: w.ownerDm.id, status: ["open"] }).find((a) => a.kind === "connect_account")!;
    w.app.attention.dismiss(item.id);
    expect(browser.signIns[0]!.finished).toBe(true);
    expect(browser.signIns[0]!.kept).toBe(false);
    expect(w.app.vault.has("alex", "browser:walgreens.com")).toBe(false);
  });

  test("after a yes the approved call must run before anything else, and a reply that skips it is sent back once", async () => {
    const buy = { amountUsd: 80, what: "Omron blood pressure monitor", where: "Walgreens" };
    const w = groupWorld((req) => {
      const last = lastToolResult(req) ?? "";
      if (last.startsWith("Approved")) return reply("Cleared $80 for the monitor.");
      if (transcriptHas(req, "[check] The request_purchase call was approved")) return callTool("request_purchase", buy);
      if (last.includes("was approved and has not run yet")) return reply("All set.");
      if (transcriptHas(req, "[APPROVED]")) return callTool("search_products", { query: "Omron monitor" });
      if (last.includes("Waiting for approval")) return reply("Asked Alex.");
      return callTool("request_purchase", buy);
    });
    w.agent.trust.autoApproveUnderUsd = 25;
    w.app.store.putAgent(w.agent);
    const run = await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "buy Jo the Omron monitor from Walgreens, $80" });
    const item = w.app.attention.openFor("alex").find((a) => a.kind === "purchase_approval")!;
    await w.app.runtime.answerAttention(item.id, "yes", "alex");
    const calls = w.app.store.toolCallsForRun(run!.id);
    expect(calls.find((c) => c.name === "search_products")?.result).toContain("has not run yet");
    expect(calls.filter((c) => c.name === "request_purchase" && c.evidence)).toHaveLength(1);
    expect(w.app.store.getRun(run!.id)!.status).toBe("done");
  });

  test("an approval the requester must give themselves is put to them in the chat, so a text thread does not go silent", async () => {
    const phone = new FakePhone();
    const w = groupWorld((_req, i) => (i === 0 ? callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Can we move to Thursday?" }) : reply("ok")), { phone });
    const run = await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "text the clinic to move my appointment to Thursday" });
    expect(run?.status).toBe("waiting");
    expect(phone.sms).toHaveLength(0);
    const asked = w.deliveries.filter((d) => d.roomId === w.ownerDm.id && d.kind !== "reply").map((d) => d.text);
    expect(asked.some((t) => t.includes("OK to text the clinic?") && t.includes("Reply here"))).toBe(true);
  });

  test("'just signed in' while the sign-in card is still open points at the card and starts no second run", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("connect_account", { site: "swiggy.com", why: "book the table" }) : reply("Waiting for the sign-in.")), {
      browser: new FakeBrowser(),
    });
    const first = await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "book Hauz Khas Social for Sunday 8pm" });
    const calls = w.model.calls.length;
    const back = await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "Just signed in" });
    expect(back?.id).toBe(first!.id);
    expect(w.app.store.listRuns({ roomId: w.ownerDm.id })).toHaveLength(1);
    expect(w.model.calls.length).toBe(calls);
    expect(noticesTo(w.deliveries, w.ownerDm.id).at(-1)).toContain("has not reached me yet");
  });

  test("a run waiting on a sign-in shows as blocked on the radar, naming who must sign in", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("connect_account", { site: "walgreens.com", why: "order batteries" }) : reply("Waiting for the sign-in.")), {
      browser: new FakeBrowser(),
    });
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "order batteries from walgreens" });
    const [run] = w.app.attention.inbox("alex", w.agent.id).inFlight;
    expect(run?.state).toBe("blocked");
    expect(run?.waitingFor?.assigneeId).toBe("alex");
  });

  test("a call on a server with no phone provider is refused: nothing dialled, nothing claimed", async () => {
    const phone = new FakePhone();
    const w = groupWorld(
      (_req, i) => (i === 0 ? callTool("place_call", { to: "+14085550100", who: "the clinic", objective: "confirm Thursday" }) : reply("I can't place calls on this server yet.")),
      { phone, providers: [] },
    );
    w.agent.trust.autoAllow = ["place_call"];
    w.app.store.putAgent(w.agent);
    const run = await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "call the clinic" });
    const call = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "place_call")!;
    expect(call.status).toBe("failed");
    expect(call.evidence).toBeUndefined();
    expect(String(call.result)).toContain("not available on this server");
    expect(phone.calls).toHaveLength(0);
    expect(repliesTo(w.deliveries, w.ownerDm.id).at(-1)).not.toContain("Made a call");
  });

  test("a tool the run was not offered is refused even when the model names it", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("hotel_compare", { city: "Paris", checkIn: "2026-12-01", checkOut: "2026-12-03" }) : reply("ok")), { providers: [] });
    const run = await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "hotels in Paris" });
    const call = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "hotel_compare")!;
    expect(call.status).toBe("failed");
    expect(call.evidence).toBeUndefined();
    expect(String(call.result)).toContain("needs the hotels provider");
  });

  test("a co-owner whose id sorts first still leaves the agent owner as the approver for guests", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("send_sms", { to: "+14085550100", who: "the plumber", text: "Can you come Thursday?" }) : reply("Asked.")));
    w.app.rooms.createPerson({ id: "aaron", displayName: "Aaron", timezone: "UTC" });
    w.app.rooms.addMember(w.room.id, "aaron", "member");
    w.app.rooms.promoteOwner(w.room.id, "aaron"); // "aaron" sorts before "alex"
    expect(w.app.rooms.owner(w.room)!.id).toBe("alex");
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip text the plumber about Thursday" });
    const item = w.app.store.listAttention({ roomId: w.room.id }).find((a) => a.kind === "guest_request");
    expect(item?.assigneeId).toBe("alex");
  });

  test("a co-owner never borrows the agent owner's trust or accounts", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("request_purchase", { amountUsd: 12, what: "batteries", where: "Walgreens" }) : reply("ok")));
    w.agent.trust.autoApproveUnderUsd = 25; // Alex's default
    w.agent.trust.autoAllow = ["send_sms"];
    w.app.store.putAgent(w.agent);
    w.app.rooms.promoteOwner(w.room.id, "sam"); // Sam set no trust of his own
    expect(w.app.rooms.accountsFor(w.room, "sam")).toEqual({ accountOwnerId: "sam", needsApproval: false });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip buy Jo the $12 batteries" });
    const buy = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "request_purchase")!;
    expect(buy.evidence).toBeUndefined(); // Alex's $25 does not cover Sam
    const item = w.app.store.listAttention({ roomId: w.room.id }).find((a) => a.kind === "purchase_approval");
    expect(item?.assigneeId).toBe("sam");
  });

  test("read_page only sees pages made in this chat", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("read_page", { pageId: "Medication" }) : reply("ok")));
    w.app.store.putArtifact({
      id: "art_private",
      agentId: w.agent.id,
      roomId: w.ownerDm.id,
      kind: "document",
      title: "Medication",
      data: { markdown: "# Medication\n- metformin" },
      share: "link",
      createdAt: w.clock.now(),
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip read the medication page" });
    const call = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "read_page")!;
    expect(call.status).toBe("failed");
    expect(JSON.stringify(call.result)).not.toContain("metformin");
  });
});

describe("an agent's own tools and skills", () => {
  test("an agent with a tool list is offered only those (and the coordination core), and a named outsider is refused", async () => {
    const seen: string[][] = [];
    const w = groupWorld((req, i) => {
      seen.push(req.tools.map((t) => t.name));
      return i === 0 ? callTool("place_call", { to: "+14085550100", who: "the clinic", objective: "confirm" }) : reply("I can't call from here.");
    });
    w.app.store.putAgent({ ...w.agent, tools: ["search"] }); // the web-search family only
    const run = await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "call the clinic" });
    expect(seen[0]).toContain("web_search");
    expect(seen[0]).toContain("track_commitment"); // core stays
    expect(seen[0]).not.toContain("place_call");
    const call = w.app.store.toolCallsForRun(run!.id).find((c) => c.name === "place_call")!;
    expect(call.status).toBe("failed");
    expect(String(call.result)).toContain("not one of Pip's tools");
  });

  test("an agent with a skills list sees only those procedures, and the core rules still apply", async () => {
    const w = groupWorld(() => reply("ok"));
    w.app.store.putAgent({ ...w.agent, skills: ["tech-help"] });
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "hi" });
    const stable = w.model.calls[0]!.system.stable;
    expect(stable).toContain("tech-help");
    expect(stable).not.toContain("find-a-vendor");
    expect(stable).toContain("never ask for permission yourself"); // _core-rules
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

  test("the model revises the plan from what it learned; done steps stay, the rest is replaced", async () => {
    const search = new FakeSearch(() => []);
    const w = groupWorld(
      (req, i) => {
        if (i === 0)
          return callTool("plan", {
            goal: "Find a Mandarin-speaking handyman",
            steps: [
              { text: "Find candidates", approach: "search" },
              { text: "Pick one and book", approach: "call" },
            ],
          });
        if (i === 1) return callTool("web_search", { query: "handyman mandarin" });
        if (i === 2) {
          expect(JSON.stringify(req.messages)).toContain("revise_plan");
          return callTool("revise_plan", {
            evidence: "search returns only paid directories, none confirm Mandarin; the Chinese community forum is the reliable source",
            steps: [{ text: "Ask the Chinese community for confirmed Mandarin-speaking handymen", approach: "community_post" }],
          });
        }
        expect(JSON.stringify(req.messages)).toContain("Ask the Chinese community");
        return reply("On it — the community forum is the better source.");
      },
      { search },
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a mandarin handyman" });
    const plan = w.app.planner.get(run!.id)!;
    expect(plan.revisions).toBe(1);
    expect(plan.steps.map((s) => s.status)).toEqual(["skipped", "active"]);
    expect(plan.steps[0]!.evidence).toContain("directories");
    expect(plan.steps[1]!.approach).toBe("community_post");
    expect(plan.steps[1]!.alternatives).toEqual(["ask_person"]); // the ladder still backs the new step up
  });

  test("revise_plan with no plan says so instead of failing the run", async () => {
    const w = groupWorld((req, i) => {
      if (i === 0) return callTool("revise_plan", { evidence: "nothing yet", steps: [{ text: "Ask the group", approach: "ask_room" }] });
      expect(lastToolResult(req)).toContain("no plan to revise");
      return reply("ok");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find someone" });
    expect(run?.status).toBe("done");
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
  test("a member's contribution to a live errand joins the run, attributed", async () => {
    const seen: string[] = [];
    const w = groupWorld(
      (req, i) => {
        seen.push(JSON.stringify(req.messages));
        return i === 0 ? callTool("search_memory", { query: "plumber" }) : reply("Plumber found; I'll ask about the fan too.");
      },
      { completer: () => "yes" },
    );
    const a = w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "Can someone find a plumber for Jo's leaking tap this week?" });
    const b = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "Also ask them about the bathroom fan while they're there." });
    const done = await a;
    expect(b?.id).toBe(done!.id); // Sam joined Riley's run; no second run
    expect(w.app.store.listRuns({ roomId: w.room.id })).toHaveLength(1);
    expect(repliesTo(w.deliveries, w.room.id)).toHaveLength(1);
    expect(seen.some((s) => s.includes("[while you were working] Sam"))).toBe(true);
    expect(seen.some((s) => s.includes("bathroom fan"))).toBe(true);
    expect(done!.requesterId).toBe("riley"); // the errand is still Riley's
  });

  test("a member's separate ask during another person's run queues its own run instead of steering theirs", async () => {
    const seen: string[] = [];
    const w = groupWorld(
      (req, i) => {
        seen.push(JSON.stringify(req.messages));
        return i === 0 ? callTool("search_memory", { query: "plumber" }) : reply("On it.");
      },
      { completer: (system) => (/errand so far/i.test(system) ? "no" : "yes") },
    );
    const a = w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "Can someone find a plumber for Jo's leaking tap this week?" });
    const b = w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "Also order Jo's AA batteries from Walgreens." });
    expect(await b).toBeUndefined(); // queued behind Riley's run, not folded into it
    await a;
    await w.app.runtime.settle();
    const runs = w.app.store.listRuns({ roomId: w.room.id });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "done")).toBe(true);
    expect(runs[0]!.requesterId).toBe("sam"); // newest first: Sam's ask ran as its own run
    expect(seen.some((s) => s.includes("[while you were working] Sam"))).toBe(false);
    expect(repliesTo(w.deliveries, w.room.id)).toHaveLength(2);
  });

  test("rapid messages from one person during a run coalesce into one queued run", async () => {
    const seen: string[] = [];
    const w = groupWorld((req, i) => {
      seen.push(lastUserText(req));
      return i < 2 ? callTool("search_memory", { query: `plumber ${i}` }) : reply("On it.");
    });
    const a = w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a plumber" });
    // Jo queues two quick messages while Alex's run is live; both are named, so no implied-request call.
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "jo", text: "@pip also ask about rates" });
    w.clock.advance(1000);
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "jo", text: "@pip prefer someone who speaks Mandarin" });
    await a;
    await w.app.runtime.settle();
    const runs = w.app.store.listRuns({ roomId: w.room.id });
    expect(runs).toHaveLength(2); // one queued run, not two
    expect(runs[0]!.requesterId).toBe("jo");
    expect(seen).toContain("@pip also ask about rates\n@pip prefer someone who speaks Mandarin");
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

test("the prompt names today's weekday and year and spells out the coming two weeks, so weekdays are looked up", async () => {
  const { nowLine, comingDays } = await import("../src/agent/prompt.ts");
  const at = Date.UTC(2026, 9, 13, 17, 0, 0); // the eval world's start
  expect(nowLine(at, "America/Los_Angeles")).toBe("Tuesday, Oct 13, 2026, 10:00 AM");
  const days = comingDays(at, "America/Los_Angeles").split(", ");
  expect(days[1]).toBe("Thu Oct 15");
  expect(days).toContain("Sun Oct 25");
  expect(days).toHaveLength(14);
});
