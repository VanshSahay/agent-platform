import { describe, expect, test } from "bun:test";
import { privateProfileId } from "../src/memory/consolidate.ts";
import { callTool, lastToolResult, reply, toolCallsSoFar } from "../src/model/scripted.ts";
import { groupWorld, sysText } from "./helpers.ts";
import { DAY, HOUR } from "../src/core/clock.ts";
import { pageDiff, Scheduler } from "../src/scheduler/scheduler.ts";
import { FakePhone } from "../src/tools/hands.ts";

describe("page edits become events", () => {
  test("a claim someone made for another member reads as an unconfirmed assignment, not a responsibility", () => {
    const diff = pageDiff(undefined, {
      checked: {},
      claimed: { "packing:stove": "Jo", "packing:tent": "Sam" },
      claimedBy: { "packing:stove": "Sam", "packing:tent": "Sam" },
      added: {},
    });
    expect(diff).toContain('Sam put Jo down for "packing:stove" (Jo has not confirmed)');
    expect(diff).toContain('Sam claimed "packing:tent"');
  });

  const seedPage = (w: ReturnType<typeof groupWorld>) => {
    const st = { checked: {}, claimed: { "packing:stove": "Sam" }, added: {} };
    w.app.store.putArtifact({
      id: "art_page",
      agentId: w.agent.id,
      roomId: w.room.id,
      kind: "document",
      title: "Packing list",
      data: { markdown: "# Packing\n- stove", state: st },
      share: "room",
      createdAt: w.clock.now(),
    });
    w.app.store.setKv("artedit:art_page", "1");
    w.app.store.setKv("artedit:art_page:1", JSON.stringify({ by: "Sam", state: st }));
    w.app.store.setKv("artedit:pending", JSON.stringify(["art_page"]));
    return st;
  };

  test("a tick on a page costs nothing: no run, the page leaves the queue, old snapshots are pruned", async () => {
    const w = groupWorld(() => reply("should not run"));
    const st = { checked: { "packing:boots": "Jo" }, claimed: {}, added: {} };
    w.app.store.putArtifact({
      id: "art_t",
      agentId: w.agent.id,
      roomId: w.room.id,
      kind: "document",
      title: "Packing",
      data: { markdown: "- boots", state: st },
      share: "room",
      createdAt: w.clock.now(),
    });
    w.app.store.setKv("artedit:art_t", "2");
    w.app.store.setKv("artedit:art_t:1", JSON.stringify({ by: "Jo", state: { checked: {}, claimed: {}, added: {} } }));
    w.app.store.setKv("artedit:art_t:2", JSON.stringify({ by: "Jo", state: st }));
    w.app.store.setKv("artedit:pending", JSON.stringify(["art_t"]));
    await w.app.scheduler.tick();
    expect(w.app.store.listRuns({ roomId: w.room.id })).toHaveLength(0);
    expect(JSON.parse(w.app.store.getKv("artedit:pending") ?? "[]")).toEqual([]);
    expect(w.app.store.getKv("artedit:art_t:1")).toBeUndefined();
    expect(w.app.store.getKv("artedit:art_t:2")).toBeDefined();
  });

  test("a tick turns a page claim into an event run, and the model tracks the responsibility", async () => {
    const w = groupWorld((req) => {
      const calls = toolCallsSoFar(req);
      if (!calls.some((c) => c.name === "read_page")) return callTool("read_page", { pageId: "Packing list" });
      if (!calls.some((c) => c.name === "track_commitment"))
        return callTool("track_commitment", { title: "Bring the stove", owner: "sam", detail: "Packing list: claimed the stove on the page" });
      return reply("Sam has the stove — it's in the ledger.");
    });
    const st = seedPage(w);
    void st;
    await w.app.scheduler.tick();
    await w.app.runtime.settle();
    // The event run fired once, named the claim, and the ledger now carries Sam's responsibility.
    const runs = w.app.store.listRuns({ roomId: w.room.id });
    const editRun = runs.find((r) => r.trigger === "event");
    expect(editRun).toBeDefined();
    expect(w.app.store.eventsForRun(editRun!.id)[0]!.type).toBe("started");
    expect(w.app.commitments.open(w.room.id).some((c) => c.ownerId === "sam" && /stove/i.test(c.title))).toBe(true);
    // A second tick with no new edits starts nothing: the burst is once per page.
    const before = runs.length;
    await w.app.scheduler.tick();
    expect(w.app.store.listRuns({ roomId: w.room.id })).toHaveLength(before);
  });
});

describe("memory", () => {
  test("what a person tells the agent privately does not surface in the group", async () => {
    const w = groupWorld(() => reply("ok"));
    const dm = w.app.rooms.dmFor(w.agent, "sam");
    w.app.memory.write({ agentId: w.agent.id, scope: "person", scopeId: "sam", type: "fact", text: "Sam is between jobs right now.", visibleToRooms: [dm.id] });
    const inGroup = w.app.memory.visibleIn(w.agent.id, w.room, w.app.rooms.memberIds(w.room.id));
    expect(inGroup.some((m) => m.text.includes("between jobs"))).toBe(false);
    const inDm = w.app.memory.visibleIn(w.agent.id, dm, ["sam"], { requesterId: "sam" });
    expect(inDm.some((m) => m.text.includes("between jobs"))).toBe(true);
    // Keyword recall respects the same boundary.
    expect(w.app.memory.recall(w.agent.id, w.room, w.app.rooms.memberIds(w.room.id), "jobs")).toHaveLength(0);
    expect(w.app.memory.recall(w.agent.id, dm, ["sam"], "jobs", 5).length).toBe(1);
  });

  test("a note told in a private chat shapes the person's private profile only, never a group prompt", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("remember", { type: "fact", text: "Alex is in debt and hiding it from Sam." }) : reply("ok")), {
      completer: (system, prompt) => (system.startsWith("Write a short profile") ? (prompt.split("\n").find((l) => l.includes("debt")) ?? "Alex.") : ""),
    });
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "@pip remember I'm in debt and hiding it from Sam" });
    await w.app.consolidator.runFor(w.agent);
    expect(w.app.store.getProfile(w.agent.id, "person", privateProfileId("alex"))?.text).toContain("debt");
    expect(w.app.store.getProfile(w.agent.id, "person", "alex")?.text ?? "").not.toContain("debt");
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip hi" });
    expect(sysText(w.model.calls.at(-1)!)).not.toContain("debt");
  });

  test("remember writes observations; the owner's rules take effect at once", async () => {
    const w = groupWorld((_req, i) => {
      if (i === 0) return callTool("remember", { type: "rule", text: "Never text Jo after 9pm." });
      if (i === 1) return reply("Noted.");
      if (i === 2) return callTool("remember", { type: "preference", text: "Jo likes the Chinese pharmacy on 10th St.", about: "Jo" });
      return reply("Noted.");
    });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip never text jo after 9pm" });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip jo likes the chinese pharmacy on 10th" });
    const rules = w.app.store.listMemories(w.agent.id, { type: "rule" });
    expect(rules.some((r) => r.text.includes("after 9pm"))).toBe(true);
    const obs = w.app.store.listMemories(w.agent.id, { type: "observation" });
    expect(obs).toHaveLength(1);
    expect(obs[0]!.scope).toBe("person");
    expect(obs[0]!.scopeId).toBe("jo");
  });

  test("consolidation promotes, corrects with dates, retracts, and derives profiles", async () => {
    const completer = (system: string, prompt: string) => {
      if (system.startsWith("You maintain")) {
        const ids = [...prompt.matchAll(/^(mem_\S+) \|/gm)].map((m) => m[1]!);
        const obsIds: string[] = prompt.split("New observations:")[1]!.match(/mem_\S+/g) ?? [];
        const durableIds = ids.filter((id) => !obsIds.includes(id));
        const old = durableIds.find((id) => prompt.includes(`${id} | `) && prompt.includes("morning appointments"));
        return JSON.stringify([
          { op: "correct", old, id: obsIds[0], type: "preference", text: "Alex now prefers afternoon appointments for Jo (changed 2026-10-13)." },
          { op: "retract", id: obsIds[1] },
        ]);
      }
      if (system.startsWith("Write a short profile")) return "Alex organises Jo's care and prefers afternoon appointments (as of 2026-10-13).";
      return "";
    };
    const w = groupWorld(() => reply("ok"), { completer });
    const a = w.app.memory.write({
      agentId: w.agent.id,
      scope: "person",
      scopeId: "alex",
      type: "observation",
      text: "[preference] Alex said afternoons are better for Jo now.",
    });
    const b = w.app.memory.write({ agentId: w.agent.id, scope: "person", scopeId: "alex", type: "observation", text: "[fact] The OTP was 442913." });
    const c = w.app.memory.write({ agentId: w.agent.id, scope: "person", scopeId: "alex", type: "observation", text: "[store] Alex uses Safeway on Main for groceries." });
    const stats = await w.app.consolidator.runFor(w.agent);
    expect(stats.retracted).toBe(1);
    expect(stats.superseded).toBe(1);
    expect(stats.promoted).toBe(1); // c, via the deterministic fallback
    const active = w.app.store.listMemories(w.agent.id, { scope: "person", scopeId: "alex" });
    expect(active.some((m) => m.text.includes("afternoon"))).toBe(true);
    expect(active.some((m) => m.text.includes("morning appointments"))).toBe(false);
    expect(active.some((m) => m.text.includes("442913"))).toBe(false);
    expect(active.find((m) => m.type === "store")?.text).toBe("Alex uses Safeway on Main for groceries.");
    expect(w.app.store.getMemory(a.id)?.supersededBy).toBeDefined();
    expect(w.app.store.getMemory(b.id)?.retractedAt).toBeDefined();
    expect(w.app.store.getMemory(c.id)?.supersededBy).toBeDefined();
    // These notes were told privately (no room may see them), so they shape Alex's private profile only.
    expect(w.app.store.getProfile(w.agent.id, "person", "alex")).toBeUndefined();
    expect(w.app.store.getProfile(w.agent.id, "person", privateProfileId("alex"))?.text).toContain("afternoon");
  });
});

describe("timers", () => {
  test("a scheduled action fires with its authorisation, and disclosed outreach does not re-ask", async () => {
    const phone = new FakePhone(() => ({ summary: "Table for 4 at 7:15 confirmed." }));
    const w = groupWorld(
      (req) => {
        const t = JSON.stringify(req.messages);
        const last = lastToolResult(req) ?? "";
        if (last.includes("Table for 4")) return reply("Booked: table for 4 at 7:15.");
        if (t.includes("Retry Graciela")) return callTool("place_call", { to: "+16465550199", who: "Graciela", objective: "retry the reservation for 4 on Friday" });
        return reply("(nothing to report)");
      },
      { phone, completer: (s) => (s.includes("holds") ? '{"holds": true, "note": "still unconfirmed"}' : "") },
    );
    const session = { id: "ses_x", roomId: w.room.id, agentId: w.agent.id, kind: "room" as const, createdAt: w.clock.now(), lastActivityAt: w.clock.now() };
    w.app.store.putSession(session);
    const s = Scheduler.createSchedule(w.app.store, w.clock, {
      agentId: w.agent.id,
      roomId: w.room.id,
      sessionId: session.id,
      title: "Retry Graciela",
      prompt: "Call Graciela and retry the reservation for 4 on Friday.",
      runAt: w.clock.now() + HOUR,
      authorization: {
        basis: "user_requested",
        disclosedOutreach: [{ who: "Graciela", how: "phone", why: "retry the reservation" }],
        premise: "the reservation is still unconfirmed",
      },
    });
    expect(s.nextRunAt).toBe(w.clock.now() + HOUR);
    expect((await w.app.scheduler.tick()).fired).toBe(0);
    w.clock.advance(HOUR + 1);
    const r = await w.app.scheduler.tick();
    expect(r.fired).toBe(1);
    expect(phone.calls).toHaveLength(1); // no approval gate: it was disclosed
    expect(w.app.attention.openFor("alex")).toHaveLength(0);
    const sched = w.app.store.getSchedule(s.id)!;
    expect(sched.numRuns).toBe(1);
    expect(sched.nextRunAt).toBeUndefined();
  });

  test("a disclosure binds to the first number used; the same name at another number asks again", async () => {
    const phone = new FakePhone(() => ({ summary: "ok" }));
    const dialed = () => phone.calls.map((c) => c.to);
    const w = groupWorld(
      (_req, i) => (i % 2 === 0 ? callTool("place_call", { to: i === 0 ? "+14085550100" : "+14085559999", who: "Graciela", objective: "retry" }) : reply("done")),
      { phone, completer: () => '{"holds": true}' },
    );
    const sched = Scheduler.createSchedule(w.app.store, w.clock, {
      agentId: w.agent.id,
      roomId: w.room.id,
      sessionId: w.app.store.latestSessionForRoom(w.room.id)?.id ?? "none",
      title: "Retry Graciela",
      prompt: "Call Graciela again.",
      runAt: w.clock.now() + HOUR,
      authorization: { basis: "user_requested", disclosedOutreach: [{ who: "Graciela", how: "phone", why: "retry" }], premise: "always" },
    });
    w.clock.advance(HOUR + 1);
    await w.app.scheduler.tick();
    expect(dialed()).toEqual(["+14085550100"]);
    expect(w.app.store.getSchedule(sched.id)!.authorization.disclosedOutreach[0]!.contact).toBe("+14085550100");
    // A second firing reaching a different number under the same name is not covered by the disclosure.
    const again = Scheduler.createSchedule(w.app.store, w.clock, {
      agentId: w.agent.id,
      roomId: w.room.id,
      sessionId: w.app.store.latestSessionForRoom(w.room.id)?.id ?? "none",
      title: "Retry Graciela 2",
      prompt: "Call Graciela again.",
      runAt: w.clock.now() + HOUR,
      authorization: { basis: "user_requested", disclosedOutreach: [{ who: "Graciela", how: "phone", why: "retry", contact: "+14085550100" }], premise: "always" },
    });
    w.clock.advance(HOUR + 1);
    await w.app.scheduler.tick();
    expect(dialed()).toEqual(["+14085550100"]);
    expect(w.app.store.listAttention({ roomId: w.room.id, status: ["open"] }).some((a) => a.kind === "outreach_approval")).toBe(true);
    void again;
  });

  test("when the premise no longer holds, the schedule is paused and the agent reports instead of acting", async () => {
    const phone = new FakePhone();
    const w = groupWorld(
      (req) => {
        const t = JSON.stringify(req.messages);
        expect(t).toContain("no longer seems to hold");
        return reply("The reservation was already confirmed, so I didn't call.");
      },
      { phone, completer: (s) => (s.includes("holds") ? '{"holds": false, "note": "the ledger shows it confirmed"}' : "") },
    );
    const s = Scheduler.createSchedule(w.app.store, w.clock, {
      agentId: w.agent.id,
      roomId: w.room.id,
      sessionId: "ses_y",
      title: "Retry",
      prompt: "Call",
      runAt: w.clock.now() - 1,
      authorization: { basis: "user_requested", disclosedOutreach: [], premise: "unconfirmed" },
    });
    await w.app.scheduler.tick();
    expect(phone.calls).toHaveLength(0);
    expect(w.app.store.getSchedule(s.id)!.paused).toBe(true);
  });

  test("recurring calendars compute the next run in the owner's zone", () => {
    const w = groupWorld(() => reply("ok"));
    const s = Scheduler.createSchedule(w.app.store, w.clock, {
      agentId: w.agent.id,
      roomId: w.room.id,
      sessionId: "s",
      title: "Morning check",
      prompt: "x",
      calendar: { hour: 9, minute: 0, timeZone: "America/Los_Angeles" },
      authorization: { basis: "standing_rule", disclosedOutreach: [], premise: "always" },
    });
    // Created at 10:00 LA time, so the next 9:00 is tomorrow.
    expect(s.nextRunAt).toBe(Date.UTC(2026, 9, 14, 16, 0, 0));
  });

  test("commitment nudges go out a day before due and stop after three overdue nudges", async () => {
    const texts: string[] = [];
    const w = groupWorld((req) => {
      texts.push(JSON.stringify(req.messages.at(-1)?.content));
      return reply("(nothing to report)");
    });
    const due = w.clock.now() + 3 * DAY;
    const c = w.app.commitments.track({ roomId: w.room.id, agentId: w.agent.id, ownerId: "sam", beneficiaryId: "jo", title: "Drive Jo to cardiology", dueAt: due });
    expect(c.nextNudgeAt).toBe(due - DAY);
    expect((await w.app.scheduler.tick()).nudged).toBe(0);
    w.clock.set(due - DAY + 1);
    expect((await w.app.scheduler.tick()).nudged).toBe(1);
    expect(texts.some((x) => x.includes("Follow-up on responsibility") && x.includes("Drive Jo to cardiology"))).toBe(true);
    // Past due: nudge daily, then block.
    w.clock.set(due + DAY + 1);
    await w.app.scheduler.tick();
    w.clock.advance(DAY + 1);
    await w.app.scheduler.tick();
    w.clock.advance(DAY + 1);
    expect((await w.app.scheduler.tick()).nudged).toBe(0);
    expect(w.app.store.getCommitment(c.id)!.status).toBe("blocked");
    expect(w.app.store.getCommitment(c.id)!.nudges).toBe(3);
  });

  test("heartbeat wakes the agent at most once a day per room and only when there is standing work", async () => {
    let _runs = 0;
    const w = groupWorld(() => {
      _runs++;
      return reply("(nothing to report)");
    });
    expect((await w.app.scheduler.tick()).heartbeats).toBe(0);
    w.app.commitments.track({ roomId: w.room.id, agentId: w.agent.id, ownerId: "sam", title: "Fix the gate" });
    w.clock.advance(DAY + 1);
    expect((await w.app.scheduler.tick()).heartbeats).toBe(1);
    expect((await w.app.scheduler.tick()).heartbeats).toBe(0);
  });

  test("attention items expire", () => {
    const w = groupWorld(() => reply("ok"));
    const item = w.app.attention.open({ agentId: w.agent.id, roomId: w.room.id, assigneeId: "alex", kind: "decision", title: "t", detail: "d", ttlMs: HOUR });
    w.clock.advance(HOUR + 1);
    expect(w.app.attention.expireDue().map((i) => i.id)).toEqual([item.id]);
    expect(w.app.store.getAttention(item.id)!.status).toBe("expired");
  });
});

describe("memory mining", () => {
  test("the consolidator reads a chat the agent took no notes in, and a private chat's notes stay private", async () => {
    const completer = (system: string, prompt: string) => {
      if (system.startsWith("Read a chat")) {
        if (prompt.includes("private chat")) return JSON.stringify([{ type: "fact", text: "Sam is between jobs and money is tight this month." }]);
        return JSON.stringify([
          { type: "person", text: "Sam drives and lives in Brooklyn.", about: "Sam" },
          { type: "decision", text: "The hike is Doodletown on Saturday, on the trail by 10am." },
        ]);
      }
      return "";
    };
    const w = groupWorld(() => reply("ok"), { completer });
    const say = (roomId: string, authorId: string, text: string) => {
      const session = { id: `ses_${roomId}`, roomId, agentId: w.agent.id, kind: "room" as const, createdAt: w.clock.now(), lastActivityAt: w.clock.now() };
      w.app.store.putSession(session);
      w.app.store.putMessage({ id: `msg_${Math.random().toString(36).slice(2)}`, sessionId: session.id, roomId, role: "user", authorId, text, visibleTo: [], at: w.clock.now() });
      w.clock.advance(1000);
    };
    say(w.room.id, "alex", "Doodletown on Saturday, three of us. Sam drives from Brooklyn, on the trail by 10.");
    say(w.samDm.id, "sam", "Between us: I'm between jobs and money is tight this month.");
    const stats = await w.app.consolidator.runFor(w.agent);
    expect(stats.mined).toBe(3);
    expect(stats.promoted).toBe(3);
    const sam = w.app.store.listMemories(w.agent.id, { scope: "person", scopeId: "sam" }).filter((m) => m.type !== "observation");
    expect(sam.map((m) => [m.type, m.text]).sort()).toEqual([
      ["fact", "Sam is between jobs and money is tight this month."],
      ["person", "Sam drives and lives in Brooklyn."],
    ]);
    const roomNotes = w.app.store.listMemories(w.agent.id, { scope: "room", scopeId: w.room.id }).filter((m) => m.type !== "observation");
    expect(roomNotes.map((m) => m.type)).toEqual(["decision"]);
    // What Sam said privately is scoped to his chat and never visible in the group.
    const inGroup = w.app.memory.visibleIn(w.agent.id, w.room, ["alex", "sam", "jo", "riley"]).map((m) => m.text);
    expect(inGroup).toContain("Sam drives and lives in Brooklyn.");
    expect(inGroup.some((t) => t.includes("money is tight"))).toBe(false);
    // The second pass starts where the first stopped: nothing new, nothing re-mined.
    const again = await w.app.consolidator.runFor(w.agent);
    expect(again.mined).toBe(0);
  });
});

test("in Sam's own chat, a note about Sam learned in a group Sam is in applies; one made in Alex's private chat does not", async () => {
  const { groupWorld } = await import("./helpers.ts");
  const { reply } = await import("../src/model/scripted.ts");
  const w = groupWorld(() => reply("ok"));
  const mem = w.app.memory;
  const fromGroup = mem.write({ agentId: w.agent.id, scope: "person", scopeId: "sam", type: "preference", text: "Sam is vegetarian", visibleToRooms: [w.room.id] });
  const fromAlexDm = mem.write({ agentId: w.agent.id, scope: "person", scopeId: "sam", type: "fact", text: "Sam is planning a surprise for Jo", visibleToRooms: [w.ownerDm.id] });
  const own = mem.write({ agentId: w.agent.id, scope: "person", scopeId: "sam", type: "preference", text: "Sam likes window seats" });
  const seen = mem.visibleIn(w.agent.id, w.samDm, w.app.rooms.memberIds(w.samDm.id), { requesterId: "sam" }).map((m) => m.id);
  expect(seen).toContain(fromGroup.id);
  expect(seen).toContain(own.id);
  expect(seen).not.toContain(fromAlexDm.id);
});
