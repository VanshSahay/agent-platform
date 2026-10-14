import { describe, expect, test } from "bun:test";
import { privateProfileId } from "../src/memory/consolidate.ts";
import { callTool, lastToolResult, reply } from "../src/model/scripted.ts";
import { familyWorld } from "./helpers.ts";
import { DAY, HOUR } from "../src/core/clock.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { FakePhone } from "../src/tools/hands.ts";

describe("memory", () => {
  test("what a person tells the agent privately does not surface in the group", async () => {
    const w = familyWorld(() => reply("ok"));
    const dm = w.app.rooms.dmFor(w.agent, "ben");
    w.app.memory.write({ agentId: w.agent.id, scope: "person", scopeId: "ben", type: "fact", text: "Ben is between jobs right now.", visibleToRooms: [dm.id] });
    const inGroup = w.app.memory.visibleIn(w.agent.id, w.family, w.app.rooms.memberIds(w.family.id));
    expect(inGroup.some((m) => m.text.includes("between jobs"))).toBe(false);
    const inDm = w.app.memory.visibleIn(w.agent.id, dm, ["ben"], { requesterId: "ben" });
    expect(inDm.some((m) => m.text.includes("between jobs"))).toBe(true);
    // Keyword recall respects the same boundary.
    expect(w.app.memory.recall(w.agent.id, w.family, w.app.rooms.memberIds(w.family.id), "jobs")).toHaveLength(0);
    expect(w.app.memory.recall(w.agent.id, dm, ["ben"], "jobs", 5).length).toBe(1);
  });

  test("remember writes observations; the owner's rules take effect at once", async () => {
    const w = familyWorld((_req, i) => {
      if (i === 0) return callTool("remember", { type: "rule", text: "Never text Mum after 9pm." });
      if (i === 1) return reply("Noted.");
      if (i === 2) return callTool("remember", { type: "preference", text: "Mum likes the Chinese pharmacy on 10th St.", about: "Mum" });
      return reply("Noted.");
    });
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip never text mum after 9pm" });
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ben", text: "@pip mum likes the chinese pharmacy on 10th" });
    const rules = w.app.store.listMemories(w.agent.id, { type: "rule" });
    expect(rules.some((r) => r.text.includes("after 9pm"))).toBe(true);
    const obs = w.app.store.listMemories(w.agent.id, { type: "observation" });
    expect(obs).toHaveLength(1);
    expect(obs[0]!.scope).toBe("person");
    expect(obs[0]!.scopeId).toBe("mum");
  });

  test("consolidation promotes, corrects with dates, retracts, and derives profiles", async () => {
    const completer = (system: string, prompt: string) => {
      if (system.startsWith("You maintain")) {
        const ids = [...prompt.matchAll(/^(mem_\S+) \|/gm)].map((m) => m[1]!);
        const obsIds: string[] = prompt.split("New observations:")[1]!.match(/mem_\S+/g) ?? [];
        const durableIds = ids.filter((id) => !obsIds.includes(id));
        const old = durableIds.find((id) => prompt.includes(`${id} | `) && prompt.includes("morning appointments"));
        return JSON.stringify([
          { op: "correct", old, id: obsIds[0], type: "preference", text: "Ellie now prefers afternoon appointments for Mum (changed 2026-10-13)." },
          { op: "retract", id: obsIds[1] },
        ]);
      }
      if (system.startsWith("Write a short profile")) return "Ellie organises Mum's care and prefers afternoon appointments (as of 2026-10-13).";
      return "";
    };
    const w = familyWorld(() => reply("ok"), { completer });
    const a = w.app.memory.write({
      agentId: w.agent.id,
      scope: "person",
      scopeId: "ellie",
      type: "observation",
      text: "[preference] Ellie said afternoons are better for Mum now.",
    });
    const b = w.app.memory.write({ agentId: w.agent.id, scope: "person", scopeId: "ellie", type: "observation", text: "[fact] The OTP was 442913." });
    const c = w.app.memory.write({ agentId: w.agent.id, scope: "person", scopeId: "ellie", type: "observation", text: "[store] Ellie uses Safeway on Main for groceries." });
    const stats = await w.app.consolidator.runFor(w.agent);
    expect(stats.retracted).toBe(1);
    expect(stats.superseded).toBe(1);
    expect(stats.promoted).toBe(1); // c, via the deterministic fallback
    const active = w.app.store.listMemories(w.agent.id, { scope: "person", scopeId: "ellie" });
    expect(active.some((m) => m.text.includes("afternoon"))).toBe(true);
    expect(active.some((m) => m.text.includes("morning appointments"))).toBe(false);
    expect(active.some((m) => m.text.includes("442913"))).toBe(false);
    expect(active.find((m) => m.type === "store")?.text).toBe("Ellie uses Safeway on Main for groceries.");
    expect(w.app.store.getMemory(a.id)?.supersededBy).toBeDefined();
    expect(w.app.store.getMemory(b.id)?.retractedAt).toBeDefined();
    expect(w.app.store.getMemory(c.id)?.supersededBy).toBeDefined();
    // These notes were told privately (no room may see them), so they shape Ellie's private profile only.
    expect(w.app.store.getProfile(w.agent.id, "person", "ellie")).toBeUndefined();
    expect(w.app.store.getProfile(w.agent.id, "person", privateProfileId("ellie"))?.text).toContain("afternoon");
  });
});

describe("timers", () => {
  test("a scheduled action fires with its authorisation, and disclosed outreach does not re-ask", async () => {
    const phone = new FakePhone(() => ({ summary: "Table for 4 at 7:15 confirmed." }));
    const w = familyWorld(
      (req) => {
        const t = JSON.stringify(req.messages);
        const last = lastToolResult(req) ?? "";
        if (last.includes("Table for 4")) return reply("Booked: table for 4 at 7:15.");
        if (t.includes("Retry Graciela")) return callTool("place_call", { to: "+16465550199", who: "Graciela", objective: "retry the reservation for 4 on Friday" });
        return reply("(nothing to report)");
      },
      { phone, completer: (s) => (s.includes("holds") ? '{"holds": true, "note": "still unconfirmed"}' : "") },
    );
    const session = { id: "ses_x", roomId: w.family.id, agentId: w.agent.id, kind: "room" as const, createdAt: w.clock.now(), lastActivityAt: w.clock.now() };
    w.app.store.putSession(session);
    const s = Scheduler.createSchedule(w.app.store, w.clock, {
      agentId: w.agent.id,
      roomId: w.family.id,
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
    expect(w.app.attention.openFor("ellie")).toHaveLength(0);
    const sched = w.app.store.getSchedule(s.id)!;
    expect(sched.numRuns).toBe(1);
    expect(sched.nextRunAt).toBeUndefined();
  });

  test("when the premise no longer holds, the schedule is paused and the agent reports instead of acting", async () => {
    const phone = new FakePhone();
    const w = familyWorld(
      (req) => {
        const t = JSON.stringify(req.messages);
        expect(t).toContain("no longer seems to hold");
        return reply("The reservation was already confirmed, so I didn't call.");
      },
      { phone, completer: (s) => (s.includes("holds") ? '{"holds": false, "note": "the ledger shows it confirmed"}' : "") },
    );
    const s = Scheduler.createSchedule(w.app.store, w.clock, {
      agentId: w.agent.id,
      roomId: w.family.id,
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
    const w = familyWorld(() => reply("ok"));
    const s = Scheduler.createSchedule(w.app.store, w.clock, {
      agentId: w.agent.id,
      roomId: w.family.id,
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
    const w = familyWorld((req) => {
      texts.push(JSON.stringify(req.messages.at(-1)?.content));
      return reply("(nothing to report)");
    });
    const due = w.clock.now() + 3 * DAY;
    const c = w.app.commitments.track({ roomId: w.family.id, agentId: w.agent.id, ownerId: "ben", beneficiaryId: "mum", title: "Drive Mum to cardiology", dueAt: due });
    expect(c.nextNudgeAt).toBe(due - DAY);
    expect((await w.app.scheduler.tick()).nudged).toBe(0);
    w.clock.set(due - DAY + 1);
    expect((await w.app.scheduler.tick()).nudged).toBe(1);
    expect(texts.some((x) => x.includes("Follow-up on responsibility") && x.includes("Drive Mum to cardiology"))).toBe(true);
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
    const w = familyWorld(() => {
      _runs++;
      return reply("(nothing to report)");
    });
    expect((await w.app.scheduler.tick()).heartbeats).toBe(0);
    w.app.commitments.track({ roomId: w.family.id, agentId: w.agent.id, ownerId: "ben", title: "Fix the gate" });
    w.clock.advance(DAY + 1);
    expect((await w.app.scheduler.tick()).heartbeats).toBe(1);
    expect((await w.app.scheduler.tick()).heartbeats).toBe(0);
  });

  test("attention items expire", () => {
    const w = familyWorld(() => reply("ok"));
    const item = w.app.attention.open({ agentId: w.agent.id, roomId: w.family.id, assigneeId: "ellie", kind: "decision", title: "t", detail: "d", ttlMs: HOUR });
    w.clock.advance(HOUR + 1);
    expect(w.app.attention.expireDue().map((i) => i.id)).toEqual([item.id]);
    expect(w.app.store.getAttention(item.id)!.status).toBe("expired");
  });
});
