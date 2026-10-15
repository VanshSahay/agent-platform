import { describe, expect, test } from "bun:test";
import { callTool, reply } from "../src/model/scripted.ts";
import { familyWorld, noticesTo } from "./helpers.ts";
import { DAY } from "../src/core/clock.ts";
import { deployAgent, deployCheck } from "../src/agent/deploy.ts";
import { SuggestionService } from "../src/inbox/suggestions.ts";

describe("one general assistant, priorities per chat", () => {
  test("while it has learned little, the owner's private chat is for getting to know them, and only there", async () => {
    const w = familyWorld(() => reply("What would you like to hand off first?"));
    // The shared world seeds three durable notes; forget one so the assistant still knows little.
    const mumFact = w.app.store.listMemories(w.agent.id).find((m) => m.text.includes("Mandarin"))!;
    w.app.memory.retract(mumFact.id);
    await w.app.runtime.handleMessage({ roomId: w.ellieDm.id, personId: "ellie", text: "hi" });
    expect(w.model.calls.at(-1)!.system).toContain("Getting to know Ellie");
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip hi" });
    expect(w.model.calls.at(-1)!.system).not.toContain("Getting to know");
    const benDm = w.app.rooms.dmFor(w.agent, "ben");
    await w.app.runtime.handleMessage({ roomId: benDm.id, personId: "ben", text: "hi" });
    expect(w.model.calls.at(-1)!.system).not.toContain("Getting to know");
    // Three durable things learned: the opening questions stop.
    w.app.memory.write({ agentId: w.agent.id, scope: "agent", scopeId: w.agent.id, type: "fact", text: "Ellie works from home on Fridays." });
    await w.app.runtime.handleMessage({ roomId: w.ellieDm.id, personId: "ellie", text: "hi again" });
    expect(w.model.calls.at(-1)!.system).not.toContain("Getting to know");
  });

  test("a chat's priorities come first there, the assistant stays general, and a name is all it needs to join", async () => {
    const w = familyWorld(() => reply("ok"));
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip hi" });
    const sys = w.model.calls.at(-1)!.system;
    expect(sys).toContain("Priorities in this chat: Mum's appointments");
    expect(sys).toContain("still a general assistant");
    expect(sys).toContain("personal assistant");
    await w.app.runtime.handleMessage({ roomId: w.ellieDm.id, personId: "ellie", text: "hi" });
    expect(w.model.calls.at(-1)!.system).not.toContain("Priorities in this chat");
    expect(deployCheck(w.app.store, w.agent)).toEqual({ ok: true, why: undefined });
    expect(deployAgent(w.app.store, w.clock, w.agent.id).ok).toBe(true);
    const nameless = { ...w.agent, id: "agt_bare", handle: "bare", name: " " };
    w.app.store.putAgent(nameless);
    expect(deployAgent(w.app.store, w.clock, "agt_bare")).toEqual({ ok: false, why: "needs a name" });
  });

  test("the un-named request check knows the chat's priorities and that the assistant is general", async () => {
    const seen: string[] = [];
    const w = familyWorld(() => reply("Sure."), {
      completer: (system) => {
        if (system.includes("Answer with exactly yes or no")) seen.push(system);
        return "yes";
      },
    });
    expect(await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ben", text: "Can someone find a good tax accountant near us?" })).toBeDefined();
    expect(seen[0]).toContain("general personal assistant");
    expect(seen[0]).toContain("priorities are: Mum's appointments");
  });
});

describe("looking after someone", () => {
  test("a cared-for person gets patient mode, and a care decision goes to the decider before the owner", async () => {
    const w = familyWorld((_req, i) => {
      if (i === 0) return callTool("send_sms", { to: "+14085550100", who: "Dr. Chen's office", text: "Confirming Mum's appointment Thursday 2pm." });
      return reply("I'll check with Ben.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "mum", text: "Pip, can you confirm my appointment with Dr. Chen?" });
    expect(w.model.calls[0]!.system).toContain("Patient mode");
    expect(run?.status).toBe("waiting");
    const item = w.app.store.getAttention(run!.waitingOn!)!;
    expect(item.assigneeId).toBe("ben");
    expect(noticesTo(w.deliveries, w.family.id)).toContain("I've asked Ben to OK that.");
  });

  test("money for a cared-for person's request still goes to the owner", async () => {
    const w = familyWorld((_req, i) => (i === 0 ? callTool("request_purchase", { amountUsd: 80, what: "new kettle", where: "Target" }) : reply("ok")));
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "mum", text: "Pip, order me a new kettle please" });
    expect(w.app.store.getAttention(run!.waitingOn!)!.assigneeId).toBe("ellie");
  });

  test("a stuck responsibility for the cared-for person escalates to the decider as a decision card, once", async () => {
    const w = familyWorld(() => reply("(nothing to report)"));
    const due = w.clock.now() + DAY;
    const c = w.app.commitments.track({ roomId: w.family.id, agentId: w.agent.id, ownerId: "wei", beneficiaryId: "mum", title: "Drive Mum to the dentist", dueAt: due });
    for (let day = 0; day < 6; day++) {
      w.clock.set(due + day * DAY + 1);
      await w.app.scheduler.tick();
    }
    expect(w.app.store.getCommitment(c.id)!.status).toBe("blocked");
    const cards = w.app.store.listAttention({ roomId: w.family.id, status: ["open"] }).filter((a) => a.title.includes("is stuck"));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.assigneeId).toBe("ben");
    expect(cards[0]!.options).toContain("Reassign to me");
  });
});

describe("answering without being named", () => {
  test("in a group, a message within the agent's purpose starts a run when the small model says so", async () => {
    const w = familyWorld(() => reply("I can look for one."), {
      completer: (system, prompt) => (system.includes("Answer with exactly yes or no") ? (prompt.includes("plumber") ? "yes" : "no") : ""),
    });
    expect(await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ben", text: "Does anyone know a good plumber near Mum's place?" })).toBeDefined();
    expect(await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ben", text: "Great match last night, did you watch it everyone?" })).toBeUndefined();
    expect(await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ben", text: "lol" })).toBeUndefined();
    expect(w.model.completions.filter((c) => c.system.includes("exactly yes or no"))).toHaveLength(2);
  });
});

describe("suggestions", () => {
  test("cards are mined from the ledger and schedules, with model ideas filling in", async () => {
    const w = familyWorld(() => reply("ok"), {
      completer: (system) => (system.includes("suggest things") ? '[{"title":"Book the boiler service","prompt":"Book the annual boiler service at Mum\'s."}]' : ""),
    });
    const svc = new SuggestionService(w.app.store, w.clock, w.app.commitments, w.model);
    w.app.commitments.track({ roomId: w.family.id, agentId: w.agent.id, ownerId: "ben", beneficiaryId: "mum", title: "Drive Mum to cardiology", dueAt: w.clock.now() + DAY });
    w.app.commitments.track({ roomId: w.family.id, agentId: w.agent.id, ownerId: "wei", title: "Fix the gate latch", dueAt: w.clock.now() - DAY });
    const cards = await svc.forHome(w.app.store.getPerson("ellie")!, w.agent);
    expect(cards.map((c) => c.category)).toEqual(["follow-up", "upcoming", "idea"]);
    expect(cards[1]!.prompt).toContain("Ben");
    expect(cards[2]!.title).toBe("Book the boiler service");
  });
});
