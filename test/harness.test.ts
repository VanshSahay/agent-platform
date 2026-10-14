import { describe, expect, test } from "bun:test";
import { callTool, lastUserText, reply, toolCallsSoFar, transcriptHas } from "../src/model/scripted.ts";
import { familyWorld, noticesTo, repliesTo } from "./helpers.ts";
import { DAY, HOUR } from "../src/core/clock.ts";
import { Vault } from "../src/tools/vault.ts";

describe("silence is an outcome", () => {
  test("a heartbeat with nothing to say ends quiet: no delivery, a quiet run in the record", async () => {
    const w = familyWorld((req) => (lastUserText(req).includes("Heartbeat") ? callTool("stay_quiet", { reason: "nothing due this week" }) : reply("hi")));
    w.app.commitments.track({ roomId: w.family.id, agentId: w.agent.id, ownerId: "ben", title: "Drive Mum", dueAt: w.clock.now() + 5 * DAY });
    w.clock.set(w.clock.now() + DAY + 1);
    await w.app.scheduler.tick();
    const run = w.app.store.listRuns({ roomId: w.family.id })[0]!;
    expect(run.trigger).toBe("heartbeat");
    expect(run.status).toBe("done");
    expect(run.quiet).toBe(true);
    expect(run.outcome).toContain("nothing due this week");
    expect(w.deliveries.filter((d) => d.roomId === w.family.id)).toHaveLength(0);
  });

  test("the old '(nothing to report)' reply on a timer is swallowed, but a person's message always gets an answer", async () => {
    const w = familyWorld((req) => reply(lastUserText(req).includes("Heartbeat") ? "(nothing to report)" : "Nothing new, Ben."));
    w.app.commitments.track({ roomId: w.family.id, agentId: w.agent.id, ownerId: "ben", title: "Drive Mum", dueAt: w.clock.now() + 5 * DAY });
    w.clock.set(w.clock.now() + DAY + 1);
    await w.app.scheduler.tick();
    expect(w.deliveries.filter((d) => d.roomId === w.family.id)).toHaveLength(0);
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ben", text: "@pip anything new?" });
    expect(repliesTo(w.deliveries, w.family.id)).toHaveLength(1);
  });
});

describe("task agents", () => {
  test("long work is delegated: the room gets a one-line reply now, the task runs in its own session and reports once", async () => {
    const w = familyWorld((req, i) => {
      const t = lastUserText(req);
      if (t.includes("You are the task agent")) {
        if (!toolCallsSoFar(req).some((c) => c.name === "update_task")) return callTool("update_task", { progress: "Found two candidates" });
        return reply("Done: Lin Home Repair can come Thursday 2pm, $90–120.");
      }
      if (i === 0) return callTool("delegate_task", { title: "Find a Mandarin-speaking handyman", instructions: "Search, compare two or three, report with phone numbers. Do not book." });
      return reply("On it. I'll report back here when I have options.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "wei", text: "@pip find a handyman for Mum's tap" });
    expect(run?.status).toBe("done");
    expect(repliesTo(w.deliveries, w.family.id)).toEqual(["On it. I'll report back here when I have options.\n— 1 step · 1 verified: Handed off to a task"]);
    const task = w.app.tasks.inFlight(w.family.id)[0]!;
    expect(task.requesterId).toBe("wei");
    expect(task.sessionId).not.toBe(run!.sessionId);
    await w.app.runtime.settle();
    const done = w.app.store.getTask(task.id)!;
    expect(done.status).toBe("done");
    expect(done.progress).toContain("Done: Lin Home Repair");
    expect(done.delivered).toHaveLength(1);
    expect(repliesTo(w.deliveries, w.family.id).at(-1)).toContain("Lin Home Repair can come Thursday");
    // The task's own run carries the task id and ran in the task session, so the room session was never blocked.
    const taskRun = w.app.store.getRun(done.runId!)!;
    expect(taskRun.trigger).toBe("task");
    expect(taskRun.sessionId).toBe(task.sessionId);
  });

  test("a task that pauses on a gate resumes with its delivery log and does not repeat what the room already heard", async () => {
    const w = familyWorld((req, i) => {
      const t = lastUserText(req);
      if (i === 0) return callTool("delegate_task", { title: "Confirm with the clinic", instructions: "Text the clinic to confirm Thursday." });
      if (i === 1) return reply("On it.");
      const calls = toolCallsSoFar(req).map((c) => c.name);
      if (transcriptHas(req, "[APPROVED]")) {
        expect(t).toContain("Already told the room");
        return calls.filter((c) => c === "send_sms").length < 2 ? callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Confirming Thursday 2pm for Mum." }) : reply("Texted the clinic; they'll confirm by tonight.");
      }
      if (!calls.includes("update_task")) return callTool("update_task", { progress: "Drafted the text", tellRoom: true });
      return callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Confirming Thursday 2pm for Mum." });
    });
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip confirm Thursday with the clinic" });
    await w.app.runtime.settle();
    const task = w.app.store.listTasks({ roomId: w.family.id })[0]!;
    expect(task.status).toBe("waiting");
    expect(task.delivered.map((d) => d.text)).toEqual(["Drafted the text"]);
    expect(noticesTo(w.deliveries, w.family.id)).toContain("Drafted the text");
    const item = w.app.attention.openFor("ellie")[0]!;
    await w.app.runtime.answerAttention(item.id, "yes", "ellie");
    const after = w.app.store.getTask(task.id)!;
    expect(after.status).toBe("done");
    expect(after.delivered.map((d) => d.text.split("\n")[0])).toEqual(["Drafted the text", "Texted the clinic; they'll confirm by tonight."]);
  });

  test("while a task runs the room stays responsive, and a note can be steered into the task", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = familyWorld((req, i) => {
      const t = lastUserText(req);
      if (i === 0) return callTool("delegate_task", { title: "Compare dentists", instructions: "Compare three dentists near Mum." });
      if (i === 1) return reply("On it.");
      if (t.includes("You are the task agent") || t.includes("[while you were working]")) return gate.then(() => (transcriptHas(req, "while you were working") ? reply("Noted the budget; here are two under $200.") : callTool("search_memory", { query: "dentist" })));
      if (t.includes("under $200") && !toolCallsSoFar(req).some((c) => c.name === "steer_task")) return callTool("steer_task", { taskId: w.app.store.listTasks({ roomId: w.family.id })[0]!.id, note: "Budget is under $200." });
      return reply("Passed that on to the search.");
    });
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip compare dentists for Mum" });
    // The task is running (blocked on our gate); the room still answers and steers it.
    const second = await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip keep it under $200 please" });
    expect(second?.status).toBe("done");
    expect(repliesTo(w.deliveries, w.family.id).at(-1)).toContain("Passed that on");
    release();
    await w.app.runtime.settle();
    const task = w.app.store.listTasks({ roomId: w.family.id })[0]!;
    expect(task.status).toBe("done");
    expect(w.app.store.eventsForRun(task.runId!).some((e) => e.type === "steer_applied")).toBe(true);
  });
});

describe("watches", () => {
  test("watch_for checks every few hours, stays quiet until the condition holds, then reports once and stops", async () => {
    let confirmed = false;
    const w = familyWorld((req, i) => {
      const t = lastUserText(req);
      if (i === 0) return callTool("watch_for", { title: "Pharmacy confirmation", condition: "the pharmacy has confirmed Mum's prescription", action: "tell the room it is ready for pickup", everyHours: 4 });
      if (t.includes("Heartbeat")) return callTool("stay_quiet", { reason: "nothing new" });
      if (t.includes('Watch "Pharmacy confirmation"')) return confirmed ? reply("The pharmacy confirmed: Mum's prescription is ready for pickup.") : callTool("stay_quiet", { reason: "no confirmation yet" });
      return reply("Watching for the pharmacy's confirmation; I'll check every four hours.");
    });
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip tell us when the pharmacy confirms Mum's prescription" });
    const sched = w.app.store.listSchedules({ roomId: w.family.id })[0]!;
    expect(sched.watch?.condition).toContain("pharmacy has confirmed");
    expect(sched.calendar?.everyHours).toBe(4);
    expect(sched.nextRunAt).toBe(w.clock.now() + 4 * HOUR);
    w.clock.set(w.clock.now() + 4 * HOUR + 1);
    await w.app.scheduler.tick();
    expect(w.deliveries.filter((d) => d.roomId === w.family.id)).toHaveLength(1); // only the original reply
    expect(w.app.store.getSchedule(sched.id)!.paused).toBe(false);
    confirmed = true;
    w.clock.set(w.clock.now() + 4 * HOUR + 1);
    await w.app.scheduler.tick();
    expect(repliesTo(w.deliveries, w.family.id).at(-1)).toContain("ready for pickup");
    expect(w.app.store.getSchedule(sched.id)!.paused).toBe(true);
  });
});

describe("app events", () => {
  test("an email from a connected app wakes the agent; it acts when it matters and stays quiet otherwise", async () => {
    const w = familyWorld((req) => {
      const t = lastUserText(req);
      if (t.includes("Event from gmail") && t.includes("newsletter")) return callTool("stay_quiet", { reason: "a newsletter, nothing for the family" });
      if (t.includes("Event from gmail") && !toolCallsSoFar(req).some((c) => c.name === "update_commitment")) return callTool("update_commitment", { commitmentId: w.app.commitments.open(w.family.id)[0]!.id, status: "done", detail: "Clinic confirmed by email" });
      return reply("Mum's Thursday appointment is confirmed by the clinic.");
    });
    w.app.commitments.track({ roomId: w.family.id, agentId: w.agent.id, ownerId: w.agent.id, beneficiaryId: "mum", title: "Confirm Thursday with the clinic", dueAt: w.clock.now() + DAY });
    const quiet = await w.app.runtime.handleEvent({ roomId: w.family.id, source: "gmail", summary: "Weekly newsletter from the pharmacy", dedupKey: "mail:1" });
    expect(quiet?.quiet).toBe(true);
    expect(w.deliveries).toHaveLength(0);
    const acted = await w.app.runtime.handleEvent({ roomId: w.family.id, source: "gmail", summary: "Dr. Chen's office: appointment Thursday 2pm confirmed", dedupKey: "mail:2" });
    expect(acted?.trigger).toBe("event");
    expect(w.app.commitments.open(w.family.id)).toHaveLength(0);
    expect(repliesTo(w.deliveries, w.family.id).at(-1)).toContain("confirmed by the clinic");
    expect(await w.app.runtime.handleEvent({ roomId: w.family.id, source: "gmail", summary: "dup", dedupKey: "mail:2" })).toBeUndefined();
  });
});

describe("credential vault", () => {
  test("secrets round-trip encrypted, the prompt sees only service names, and the model never sees the secret", async () => {
    const w = familyWorld(() => reply("ok"));
    w.app.vault.put("ellie", "Gmail", "ya29.secret-token");
    expect(w.app.vault.services("ellie")).toEqual(["gmail"]);
    expect(w.app.vault.use("ellie", "gmail", (s) => s)).toBe("ya29.secret-token");
    expect(w.app.store.getCredential("ellie", "gmail")).not.toContain("secret-token");
    const other = new Vault(w.app.store, w.clock, "another-key");
    expect(() => other.use("ellie", "gmail", (s) => s)).toThrow();
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: "@pip hi" });
    const sys = w.model.calls.at(-1)!.system;
    expect(sys).toContain("Connected accounts for Ellie: gmail");
    expect(JSON.stringify(w.model.calls)).not.toContain("secret-token");
    // A guest's request uses the owner's accounts, so the owner's services are listed; a member with none sees nothing.
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "wei", text: "@pip hi" });
    expect(w.model.calls.at(-1)!.system).toContain("Connected accounts for Ellie: gmail");
    w.app.rooms.createPerson({ id: "jo", displayName: "Jo", timezone: "UTC" });
    w.app.rooms.addMember(w.family.id, "jo", "member", { consented: true });
    await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "jo", text: "@pip hi" });
    expect(w.model.calls.at(-1)!.system).not.toContain("Connected accounts");
  });
});

describe("compaction", () => {
  test("a long session is folded into a summary the prompt carries instead of the old messages", async () => {
    const w = familyWorld(() => reply("ok"), { completer: (system) => (system.includes("Fold a chat history") ? "Ellie asked about Mum's dentist (Dr. Nguyen, Willow Glen) on Oct 13; Ben drives Thursdays." : "") });
    for (let i = 0; i < 36; i++) await w.app.runtime.handleMessage({ roomId: w.family.id, personId: "ellie", text: `@pip note ${i}` });
    const session = w.app.store.latestSessionForRoom(w.family.id)!;
    expect(session.summary).toContain("Dr. Nguyen");
    const last = w.model.calls.at(-1)!;
    const first = last.messages[0]!;
    expect(typeof first.content === "string" ? first.content : "").toContain("[system:earlier in this chat]");
    expect(last.messages.length).toBeLessThan(40);
    expect(JSON.stringify(last.messages)).not.toContain("note 0");
    expect(JSON.stringify(last.messages)).toContain("note 35");
    expect(w.app.store.listMemories(w.agent.id, { scope: "room", scopeId: w.family.id }).some((m) => m.text.startsWith("Conversation summary through"))).toBe(true);
  });
});
