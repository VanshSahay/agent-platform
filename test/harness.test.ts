import { describe, expect, test } from "bun:test";
import { callTool, lastUserText, reply, toolCallsSoFar, transcriptHas } from "../src/model/scripted.ts";
import { groupWorld, noticesTo, repliesTo, sysText } from "./helpers.ts";
import { DAY, HOUR } from "../src/core/clock.ts";
import { Vault } from "../src/tools/vault.ts";
import { parseDecision } from "../src/runtime/decide.ts";
import { stopNotice } from "../src/runtime/runtime.ts";
import { privateProfileId } from "../src/memory/consolidate.ts";

describe("silence is an outcome", () => {
  test("a heartbeat with nothing to say ends quiet: no delivery, a quiet run in the record", async () => {
    const w = groupWorld((req) => (lastUserText(req).includes("Heartbeat") ? callTool("stay_quiet", { reason: "nothing due this week" }) : reply("hi")));
    w.app.commitments.track({ roomId: w.room.id, agentId: w.agent.id, ownerId: "sam", title: "Drive Jo", dueAt: w.clock.now() + 5 * DAY });
    w.clock.set(w.clock.now() + DAY + 1);
    await w.app.scheduler.tick();
    const run = w.app.store.listRuns({ roomId: w.room.id })[0]!;
    expect(run.trigger).toBe("heartbeat");
    expect(run.status).toBe("done");
    expect(run.quiet).toBe(true);
    expect(run.outcome).toContain("nothing due this week");
    expect(w.deliveries.filter((d) => d.roomId === w.room.id)).toHaveLength(0);
  });

  test("the old '(nothing to report)' reply on a timer is swallowed, but a person's message always gets an answer", async () => {
    const w = groupWorld((req) => reply(lastUserText(req).includes("Heartbeat") ? "(nothing to report)" : "Nothing new, Sam."));
    w.app.commitments.track({ roomId: w.room.id, agentId: w.agent.id, ownerId: "sam", title: "Drive Jo", dueAt: w.clock.now() + 5 * DAY });
    w.clock.set(w.clock.now() + DAY + 1);
    await w.app.scheduler.tick();
    expect(w.deliveries.filter((d) => d.roomId === w.room.id)).toHaveLength(0);
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip anything new?" });
    expect(repliesTo(w.deliveries, w.room.id)).toHaveLength(1);
  });
});

describe("task agents", () => {
  test("long work is delegated: the room gets a one-line reply now, the task runs in its own session and reports once", async () => {
    const w = groupWorld((req, i) => {
      const t = lastUserText(req);
      if (t.includes("You are the task agent")) {
        if (!toolCallsSoFar(req).some((c) => c.name === "update_task")) return callTool("update_task", { progress: "Found two candidates" });
        return reply("Done: Lin Home Repair can come Thursday 2pm, $90–120.");
      }
      if (i === 0)
        return callTool("delegate_task", { title: "Find a Mandarin-speaking handyman", instructions: "Search, compare two or three, report with phone numbers. Do not book." });
      return reply("On it. I'll report back here when I have options.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip find a handyman for Jo's tap" });
    expect(run?.status).toBe("done");
    expect(repliesTo(w.deliveries, w.room.id)).toEqual(["On it. I'll report back here when I have options.\n— 1 step · 1 verified: Handed off to a task"]);
    const task = w.app.tasks.inFlight(w.room.id)[0]!;
    expect(task.requesterId).toBe("riley");
    expect(task.sessionId).not.toBe(run!.sessionId);
    await w.app.runtime.settle();
    const done = w.app.store.getTask(task.id)!;
    expect(done.status).toBe("done");
    expect(done.progress).toContain("Done: Lin Home Repair");
    expect(done.delivered).toHaveLength(1);
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("Lin Home Repair can come Thursday");
    // The task's own run carries the task id and ran in the task session, so the room session was never blocked.
    const taskRun = w.app.store.getRun(done.runId!)!;
    expect(taskRun.trigger).toBe("task");
    expect(taskRun.sessionId).toBe(task.sessionId);
  });

  test("a task that pauses on a gate resumes with its delivery log and does not repeat what the room already heard", async () => {
    const w = groupWorld((req, i) => {
      const t = lastUserText(req);
      if (i === 0) return callTool("delegate_task", { title: "Confirm with the clinic", instructions: "Text the clinic to confirm Thursday." });
      if (i === 1) return reply("On it.");
      const calls = toolCallsSoFar(req).map((c) => c.name);
      if (transcriptHas(req, "[APPROVED]")) {
        expect(t).toContain("Already told the room");
        return calls.filter((c) => c === "send_sms").length < 2
          ? callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Confirming Thursday 2pm for Jo." })
          : reply("Texted the clinic; they'll confirm by tonight.");
      }
      if (!calls.includes("update_task")) return callTool("update_task", { progress: "Drafted the text", tellRoom: true });
      return callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Confirming Thursday 2pm for Jo." });
    });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip confirm Thursday with the clinic" });
    await w.app.runtime.settle();
    const task = w.app.store.listTasks({ roomId: w.room.id })[0]!;
    expect(task.status).toBe("waiting");
    expect(task.delivered.map((d) => d.text)).toEqual(["Drafted the text"]);
    expect(noticesTo(w.deliveries, w.room.id)).toContain("Drafted the text");
    const item = w.app.attention.openFor("alex")[0]!;
    await w.app.runtime.answerAttention(item.id, "yes", "alex");
    const after = w.app.store.getTask(task.id)!;
    expect(after.status).toBe("done");
    expect(after.delivered.map((d) => d.text.split("\n")[0])).toEqual(["Drafted the text", "Texted the clinic; they'll confirm by tonight."]);
  });

  test("while a task runs the room stays responsive, and a note can be steered into the task", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = groupWorld((req, i) => {
      const t = lastUserText(req);
      if (i === 0) return callTool("delegate_task", { title: "Compare dentists", instructions: "Compare three dentists near Jo." });
      if (i === 1) return reply("On it.");
      if (t.includes("You are the task agent") || t.includes("[while you were working]"))
        return gate.then(() =>
          transcriptHas(req, "while you were working") ? reply("Noted the budget; here are two under $200.") : callTool("search_memory", { query: "dentist" }),
        );
      if (t.includes("under $200") && !toolCallsSoFar(req).some((c) => c.name === "steer_task"))
        return callTool("steer_task", { taskId: w.app.store.listTasks({ roomId: w.room.id })[0]!.id, note: "Budget is under $200." });
      return reply("Passed that on to the search.");
    });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip compare dentists for Jo" });
    // The task is running (blocked on our gate); the room still answers and steers it.
    const second = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip keep it under $200 please" });
    expect(second?.status).toBe("done");
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("Passed that on");
    release();
    await w.app.runtime.settle();
    const task = w.app.store.listTasks({ roomId: w.room.id })[0]!;
    expect(task.status).toBe("done");
    expect(w.app.store.eventsForRun(task.runId!).some((e) => e.type === "steer_applied")).toBe(true);
  });
});

describe("watches", () => {
  test("watch_for checks every few hours, stays quiet until the condition holds, then reports once and stops", async () => {
    let confirmed = false;
    const w = groupWorld((req, i) => {
      const t = lastUserText(req);
      if (i === 0)
        return callTool("watch_for", {
          title: "Pharmacy confirmation",
          condition: "the pharmacy has confirmed Jo's prescription",
          action: "tell the room it is ready for pickup",
          everyHours: 4,
        });
      if (t.includes("Heartbeat")) return callTool("stay_quiet", { reason: "nothing new" });
      if (t.includes('Watch "Pharmacy confirmation"'))
        return confirmed ? reply("The pharmacy confirmed: Jo's prescription is ready for pickup.") : callTool("stay_quiet", { reason: "no confirmation yet" });
      return reply("Watching for the pharmacy's confirmation; I'll check every four hours.");
    });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip tell us when the pharmacy confirms Jo's prescription" });
    const sched = w.app.store.listSchedules({ roomId: w.room.id })[0]!;
    expect(sched.watch?.condition).toContain("pharmacy has confirmed");
    expect(sched.calendar?.everyHours).toBe(4);
    expect(sched.nextRunAt).toBe(w.clock.now() + 4 * HOUR);
    w.clock.set(w.clock.now() + 4 * HOUR + 1);
    await w.app.scheduler.tick();
    expect(w.deliveries.filter((d) => d.roomId === w.room.id)).toHaveLength(1); // only the original reply
    expect(w.app.store.getSchedule(sched.id)!.paused).toBe(false);
    confirmed = true;
    w.clock.set(w.clock.now() + 4 * HOUR + 1);
    await w.app.scheduler.tick();
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("ready for pickup");
    expect(w.app.store.getSchedule(sched.id)!.paused).toBe(true);
  });
});

describe("app events", () => {
  test("an email from a connected app wakes the agent; it acts when it matters and stays quiet otherwise", async () => {
    const w = groupWorld((req) => {
      const t = lastUserText(req);
      if (t.includes("Event from gmail") && t.includes("newsletter")) return callTool("stay_quiet", { reason: "a newsletter, nothing for the group" });
      if (t.includes("Event from gmail") && !toolCallsSoFar(req).some((c) => c.name === "update_commitment"))
        return callTool("update_commitment", { commitmentId: w.app.commitments.open(w.room.id)[0]!.id, status: "done", detail: "Clinic confirmed by email" });
      return reply("Jo's Thursday appointment is confirmed by the clinic.");
    });
    w.app.commitments.track({
      roomId: w.room.id,
      agentId: w.agent.id,
      ownerId: w.agent.id,
      beneficiaryId: "jo",
      title: "Confirm Thursday with the clinic",
      dueAt: w.clock.now() + DAY,
    });
    const quiet = await w.app.runtime.handleEvent({ roomId: w.room.id, source: "gmail", summary: "Weekly newsletter from the pharmacy", dedupKey: "mail:1" });
    expect(quiet?.quiet).toBe(true);
    expect(w.deliveries).toHaveLength(0);
    const acted = await w.app.runtime.handleEvent({ roomId: w.room.id, source: "gmail", summary: "Dr. Chen's office: appointment Thursday 2pm confirmed", dedupKey: "mail:2" });
    expect(acted?.trigger).toBe("event");
    expect(w.app.commitments.open(w.room.id)).toHaveLength(0);
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("confirmed by the clinic");
    expect(await w.app.runtime.handleEvent({ roomId: w.room.id, source: "gmail", summary: "dup", dedupKey: "mail:2" })).toBeUndefined();
  });
});

describe("credential vault", () => {
  test("secrets round-trip encrypted, the prompt sees only service names, and the model never sees the secret", async () => {
    const w = groupWorld(() => reply("ok"));
    w.app.vault.put("alex", "Gmail", "ya29.secret-token");
    expect(w.app.vault.services("alex")).toEqual(["gmail"]);
    expect(w.app.vault.use("alex", "gmail", (s) => s)).toBe("ya29.secret-token");
    expect(w.app.store.getCredential("alex", "gmail")).not.toContain("secret-token");
    const other = new Vault(w.app.store, w.clock, "another-key");
    expect(() => other.use("alex", "gmail", (s) => s)).toThrow();
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip hi" });
    const sys = sysText(w.model.calls.at(-1)!);
    expect(sys).toContain("Connected accounts for Alex: gmail");
    expect(JSON.stringify(w.model.calls)).not.toContain("secret-token");
    // A guest's request uses the owner's accounts, so the owner's services are listed; a member with none sees nothing.
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip hi" });
    expect(sysText(w.model.calls.at(-1)!)).toContain("Connected accounts for Alex: gmail");
    w.app.rooms.createPerson({ id: "jo", displayName: "Jo", timezone: "UTC" });
    w.app.rooms.addMember(w.room.id, "jo", "member", { consented: true });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "jo", text: "@pip hi" });
    expect(sysText(w.model.calls.at(-1)!)).not.toContain("Connected accounts");
  });
});

describe("compaction", () => {
  test("a long session is folded into a summary the prompt carries instead of the old messages", async () => {
    const w = groupWorld(() => reply("ok"), {
      completer: (system) => (system.includes("Fold a chat history") ? "Alex asked about Jo's dentist (Dr. Nguyen, Willow Glen) on Oct 13; Sam drives Thursdays." : ""),
    });
    for (let i = 0; i < 36; i++) await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: `@pip note ${i}` });
    const session = w.app.store.latestSessionForRoom(w.room.id)!;
    expect(session.summary).toContain("Dr. Nguyen");
    const last = w.model.calls.at(-1)!;
    const first = last.messages[0]!;
    expect(typeof first.content === "string" ? first.content : "").toContain("[system:earlier in this chat]");
    expect(last.messages.length).toBeLessThan(40);
    expect(JSON.stringify(last.messages)).not.toContain("note 0");
    expect(JSON.stringify(last.messages)).toContain("note 35");
    expect(w.app.store.listMemories(w.agent.id, { scope: "room", scopeId: w.room.id }).some((m) => m.text.startsWith("Conversation summary through"))).toBe(true);
    // The clock is frozen, so every message shares a timestamp: the cut is by position, and the first kept message is still in the prompt.
    const all = w.app.store.messagesForSession(session.id, 500);
    const cut = all.findIndex((m) => m.id === session.summaryThroughId);
    expect(cut).toBeGreaterThan(0);
    const firstKept = all.slice(cut + 1).find((m) => m.role === "user")!;
    expect(firstKept.at).toBe(all[cut]!.at);
    expect(JSON.stringify(last.messages)).toContain(firstKept.text.split("\n")[0]!);
  });
});

describe("reading an answer", () => {
  test("negation wins, options are picks, chatter is not an answer", () => {
    expect(parseDecision("yes")).toEqual({ kind: "yes" });
    expect(parseDecision("Sure, go ahead")).toEqual({ kind: "yes" });
    expect(parseDecision("no, I do not approve")).toEqual({ kind: "no" });
    expect(parseDecision("No — don't go ahead")).toEqual({ kind: "no" });
    expect(parseDecision("please don't")).toEqual({ kind: "no" });
    expect(parseDecision("ok but not today")).toEqual({ kind: "no" });
    expect(parseDecision("Great Wall", ["Lin", "Great Wall"])).toEqual({ kind: "option", option: "Great Wall" });
    expect(parseDecision("Thanks everyone, Jo will be home all week.")).toBeUndefined();
  });

  test("'no, I don't approve' declines the gate instead of approving it", async () => {
    const w = groupWorld((req, i) =>
      i === 0
        ? callTool("request_purchase", { amountUsd: 180, what: "a new kettle", where: "Target" })
        : reply(transcriptHas(req, "[DECLINED]") ? "Understood, not buying it." : "Waiting."),
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip buy Jo a kettle, about $180" });
    expect(run?.status).toBe("waiting");
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "no, I don't approve that" });
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("not buying");
    expect(w.app.store.approvalsFor(w.room.id, w.app.store.getAttention(run!.waitingOn!)!.gateKey!)[0]!.decision).toBe("no");
  });
});

describe("approvals are records", () => {
  test("a yes covers exactly the approved text to the approved number, once; a different text asks again", async () => {
    const w = groupWorld((req, i) => {
      const sent = toolCallsSoFar(req).filter((c) => c.name === "send_sms").length;
      if (i === 0) return callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Confirming Thursday 2pm." });
      if (transcriptHas(req, "[APPROVED]") && sent === 1) return callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Confirming Thursday 2pm." });
      if (sent === 2 && !transcriptHas(req, "Nothing was sent"))
        return callTool("send_sms", { to: "+14085550100", who: "the clinic", text: "Also, can you call Sam instead of Alex?" });
      return reply("Texted the clinic.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip confirm Thursday with the clinic by text" });
    const item = w.app.store.getAttention(run!.waitingOn!)!;
    expect(item.gateKey).toBeDefined();
    await w.app.runtime.answerAttention(item.id, "yes", "alex");
    // The approved text went out once; the second, different text opened a new card instead of riding the first yes.
    expect(w.hands.phone.sms).toHaveLength(1);
    const after = w.app.store.getRun(run!.id)!;
    expect(after.status).toBe("waiting");
    expect(w.app.store.getAttention(after.waitingOn!)!.gateKey).not.toBe(item.gateKey);
    const approval = w.app.store.approvalsFor(w.room.id, item.gateKey!)[0]!;
    expect(approval.consumedAt).toBeDefined();
  });

  test("one person's approval does not leak to another run asking for a different amount", async () => {
    const w = groupWorld((_req, i) => {
      if (i === 0) return callTool("request_purchase", { amountUsd: 50, what: "flowers", where: "Trader Joe's" });
      if (i === 1) return callTool("request_purchase", { amountUsd: 50, what: "a lamp", where: "IKEA" });
      return reply("ok");
    });
    const a = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip get flowers for Jo, $50" });
    const b = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "jo", text: "Pip, order me a lamp please, about $50" });
    expect(a?.status).toBe("waiting");
    expect(b?.status).toBe("waiting");
    expect(w.app.store.getAttention(a!.waitingOn!)!.gateKey).not.toBe(w.app.store.getAttention(b!.waitingOn!)!.gateKey);
  });
});

describe("stopping and restarting", () => {
  test("stop ends a run between turns: no further tools run and 'stopped' is not overwritten by 'done'", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = groupWorld(async (_req, i) => {
      if (i === 0) return callTool("search_memory", { query: "plumber" });
      await gate;
      return callTool("search_memory", { query: "again" });
    });
    const p = w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip find a plumber" });
    const run = w.app.store.listRuns({ roomId: w.room.id })[0]!;
    // Let the first tool finish, then stop while the second model turn is in flight.
    while (!w.app.store.toolCallsForRun(run.id).some((c) => c.status === "done")) await new Promise((r) => setTimeout(r, 1));
    await w.app.runtime.stop(run.id);
    release();
    const done = await p;
    expect(done?.status).toBe("stopped");
    expect(w.app.store.toolCallsForRun(run.id).filter((c) => c.status === "done")).toHaveLength(1);
    expect(w.app.store.toolCallsForRun(run.id)).toHaveLength(1);
    expect(repliesTo(w.deliveries, w.room.id)).toHaveLength(0);
    // The room is told, by code and from the records, that nothing outside had happened.
    expect(noticesTo(w.deliveries, w.room.id)).toContain('Stopped "@pip find a plumber" (a person). Nothing outside had been done for it yet.');
  });

  test("a stop names the outside actions that already completed, and only those", () => {
    const at = 0;
    const rec = (name: string, status: "done" | "failed", labelDone: string) => ({ id: name, runId: "r", name, input: {}, status, labelRunning: "", labelDone, startedAt: at });
    const text = stopNotice(
      "Alex",
      [rec("send_sms", "done", "Sent a text"), rec("place_call", "failed", "Made a call"), rec("search_memory", "done", "Searched memory")] as never,
      "text the clinic",
    );
    expect(text).toBe('Stopped "text the clinic" (Alex). Already done before the stop, and not undone: Sent a text.');
  });

  test("a run left running by a crash is failed at boot, and a message to its session gets a fresh run", async () => {
    const w = groupWorld(() => reply("hi"));
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip hi" });
    const session = w.app.store.latestSessionForRoom(w.room.id)!;
    w.app.store.putRun({ id: "run_dead", sessionId: session.id, roomId: w.room.id, agentId: w.agent.id, trigger: "message", status: "running", startedAt: w.clock.now() });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip are you there?" });
    expect(run?.id).not.toBe("run_dead");
    expect(run?.status).toBe("done");
    expect(w.app.store.getRun("run_dead")!.status).toBe("failed");
  });
});

describe("cards and runs move together", () => {
  test("an expired question ends the run that waited on it", async () => {
    const w = groupWorld((_req, i) =>
      i === 0 ? callTool("ask_person", { person: "Sam", question: "Can you drive Thursday?", kind: "decision", options: ["Yes", "No"] }) : reply("ok"),
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip ask Sam about Thursday" });
    expect(run?.status).toBe("waiting");
    w.clock.set(w.clock.now() + 4 * DAY);
    await w.app.scheduler.tick();
    expect(w.app.store.getRun(run!.id)!.status).toBe("stopped");
  });

  test("answering a card that has no run behind it starts a follow-up run carrying the answer", async () => {
    const w = groupWorld((req) =>
      lastUserText(req).includes('answered "')
        ? callTool("update_commitment", { commitmentId: w.app.store.listCommitments({ roomId: w.room.id })[0]!.id, status: "dropped" })
        : reply("Dropped it, as Alex asked."),
    );
    const due = w.clock.now() + DAY;
    w.app.commitments.track({ roomId: w.room.id, agentId: w.agent.id, ownerId: "riley", beneficiaryId: "jo", title: "Drive Jo to the dentist", dueAt: due });
    for (let day = 0; day < 6; day++) {
      w.clock.set(due + day * DAY + 1);
      await w.app.scheduler.tick();
    }
    const card = w.app.attention.openFor("alex").find((a) => a.title.includes("is stuck"))!;
    const run = await w.app.runtime.answerAttention(card.id, "Drop it", "alex");
    expect(run?.trigger).toBe("follow_up");
    expect(w.app.store.listCommitments({ roomId: w.room.id })[0]!.status).toBe("dropped");
  });

  test("reopening a blocked responsibility restarts its reminders", () => {
    const w = groupWorld(() => reply("ok"));
    const c = w.app.commitments.track({ roomId: w.room.id, agentId: w.agent.id, ownerId: "riley", title: "Fix the gate", dueAt: w.clock.now() + DAY });
    w.app.commitments.update(c.id, { status: "blocked" });
    expect(w.app.store.getCommitment(c.id)!.nextNudgeAt).toBeUndefined();
    w.app.commitments.update(c.id, { status: "open" });
    const again = w.app.store.getCommitment(c.id)!;
    expect(again.nudges).toBe(0);
    expect(again.nextNudgeAt).toBeDefined();
  });
});

describe("disclosed outreach is an approval in advance", () => {
  test("a decider's schedule that names someone to contact asks the owner first", async () => {
    const w = groupWorld((_req, i) =>
      i === 0
        ? callTool("schedule_action", {
            title: "Call the clinic",
            prompt: "Call the clinic and confirm.",
            runAt: new Date(w.clock.now() + DAY).toISOString(),
            premise: "still unconfirmed",
            disclosedOutreach: [{ who: "the clinic", how: "phone", why: "confirm" }],
          })
        : reply("Asked Alex first."),
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip call the clinic tomorrow to confirm" });
    expect(run?.status).toBe("waiting");
    const item = w.app.store.getAttention(run!.waitingOn!)!;
    // A decider acts through the owner's accounts, so the card is the owner's "guest request" form of an outreach approval.
    expect(["outreach_approval", "guest_request"]).toContain(item.kind);
    expect(item.gateKey).toBeDefined();
    expect(item.assigneeId).toBe("alex");
    expect(w.app.store.listSchedules({ roomId: w.room.id })).toHaveLength(0);
  });

  test("malformed outreach entries from the model are dropped, so nothing is pre-approved by accident", async () => {
    const w = groupWorld((_req, i) =>
      i === 0
        ? callTool("schedule_action", {
            title: "Sunday rundown",
            prompt: "List the week.",
            calendar: { hour: 18, minute: 0, dayOfWeek: [0] },
            premise: "always",
            disclosedOutreach: [{ who: 42 }, "the clinic", { who: "Lin", how: "fax", why: "x" }],
          })
        : reply("Scheduled."),
    );
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip every Sunday list the week" });
    expect(w.app.store.listSchedules({ roomId: w.room.id })[0]!.authorization.disclosedOutreach).toEqual([]);
  });
});

describe("private notes stay private", () => {
  test("a person's private profile is used in their own chat and never in a group", async () => {
    const w = groupWorld(() => reply("ok"));
    w.app.store.putProfile({ agentId: w.agent.id, scope: "person", scopeId: "sam", text: "Sam can drive Thursdays.", derivedAt: w.clock.now() });
    w.app.store.putProfile({ agentId: w.agent.id, scope: "person", scopeId: privateProfileId("sam"), text: "Sam is between jobs and money is tight.", derivedAt: w.clock.now() });
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip hi" });
    expect(sysText(w.model.calls.at(-1)!)).toContain("drive Thursdays");
    expect(sysText(w.model.calls.at(-1)!)).not.toContain("money is tight");
    const dm = w.app.rooms.dmFor(w.agent, "sam");
    await w.app.runtime.handleMessage({ roomId: dm.id, personId: "sam", text: "hi" });
    expect(sysText(w.model.calls.at(-1)!)).toContain("money is tight");
  });

  test("the consolidator ignores memory ids outside the scope it is working on", async () => {
    const w = groupWorld(() => reply("ok"), {
      completer: (system, prompt) =>
        system.startsWith("You maintain")
          ? JSON.stringify([
              { op: "retract", id: "mem_elsewhere" },
              { op: "retract", id: (prompt.match(/mem_\S+/) ?? [""])[0] },
            ])
          : "",
    });
    const foreign = w.app.memory.write({ agentId: "agt_other", scope: "agent", scopeId: "agt_other", type: "rule", text: "Other agent's rule." });
    w.app.store.putMemory({ ...foreign, id: "mem_elsewhere" });
    w.app.memory.write({ agentId: w.agent.id, scope: "room", scopeId: w.room.id, type: "observation", text: "[fact] Something observed." });
    await w.app.consolidator.runFor(w.agent);
    expect(w.app.store.getMemory("mem_elsewhere")!.retractedAt).toBeUndefined();
  });
});

describe("signing in inside the chat", () => {
  test("connect_account shows a private sign-in card in the chat, Done keeps the signed-in browser for that person, and browse_page uses it", async () => {
    const w = groupWorld((req, i) => {
      if (i === 0) return callTool("connect_account", { site: "https://www.ubereats.com/", why: "order Jo's groceries" });
      if (transcriptHas(req, "[CONNECTED]") && !toolCallsSoFar(req).some((c) => c.name === "browse_page"))
        return callTool("browse_page", { url: "https://www.ubereats.com/orders", account: "ubereats.com" });
      if (transcriptHas(req, "[CONNECTED]")) return reply("Order placed from your account.");
      return reply("Waiting for you to sign in.");
    });
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip order Jo's groceries on Uber Eats" });
    expect(run?.status).toBe("waiting");
    const item = w.app.store.getAttention(run!.waitingOn!)!;
    expect(item.kind).toBe("connect_account");
    expect(item.card).toMatchObject({ kind: "connect_account", site: "ubereats.com", status: "open" });
    // The card sits in the group chat, visible to Alex only, and in her private chat.
    const inRoom = w.app.store.messagesForRoom(w.room.id).find((m) => m.card?.itemId === item.id)!;
    expect(inRoom.visibleTo).toEqual(["alex"]);
    expect(w.hands.browser.signIns[0]!.site).toBe("ubereats.com");
    expect(JSON.stringify(w.model.calls)).not.toContain(w.hands.browser.signIns[0]!.sessionId);
    // A message written while the card is open is a new request, not an answer: the card stays open.
    const dm = w.app.rooms.dmFor(w.app.store.listAgents("alex")[0]!, "alex");
    const other = await w.app.runtime.handleMessage({ roomId: dm.id, personId: "alex", text: "book me a flight to NYC on Dec 6" });
    expect(other?.id).not.toBe(run!.id);
    expect(w.app.store.getAttention(item.id)!.status).toBe("open");
    await w.app.runtime.answerAttention(item.id, "done", "alex");
    expect(w.app.vault.has("alex", "browser:ubereats.com")).toBe(true);
    expect(w.hands.browser.signIns[0]!.kept).toBe(true);
    expect(w.app.store.messagesForRoom(w.room.id).find((m) => m.card?.itemId === item.id)!.card!.status).toBe("done");
    expect(w.app.store.getRun(run!.id)!.status).toBe("done");
    // The page was read with the signed-in context, and the context id never reached the model.
    const used = w.hands.browser.visitedWith.find((v) => v.url.includes("ubereats.com/orders"))!;
    expect(used.contextId).toBe("ctx_ubereats.com_1");
    expect(JSON.stringify(w.model.calls)).not.toContain("ctx_ubereats.com_1");
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("Order placed");
  });

  test("a guest's request routes the sign-in card to the owner; Cancel connects nothing", async () => {
    const w = groupWorld((req, i) =>
      i === 0
        ? callTool("connect_account", { site: "ubereats.com", why: "order for Jo" })
        : reply(transcriptHas(req, "[DECLINED]") ? "No problem, I won't use Uber Eats." : "Waiting."),
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "riley", text: "@pip order Jo dinner on Uber Eats" });
    const item = w.app.store.getAttention(run!.waitingOn!)!;
    expect(item.assigneeId).toBe("alex");
    expect(noticesTo(w.deliveries, w.room.id)).toContain("I've asked Alex to sign in to ubereats.com.");
    await w.app.runtime.answerAttention(item.id, "cancel", "alex");
    expect(w.app.vault.has("alex", "browser:ubereats.com")).toBe(false);
    expect(w.hands.browser.signIns[0]!.kept).toBe(false);
    expect(repliesTo(w.deliveries, w.room.id).at(-1)).toContain("won't use Uber Eats");
  });

  test("browse_page with an unconnected account asks for connect_account first", async () => {
    const w = groupWorld((_req, i) =>
      i === 0 ? callTool("browse_page", { url: "https://www.ubereats.com/orders", account: "ubereats.com" }) : reply("I need you to sign in first."),
    );
    const run = await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip check my Uber Eats orders" });
    const call = w.app.store.toolCallsForRun(run!.id)[0]!;
    expect(call.status).toBe("failed");
    expect(String(call.result)).toContain("connect_account");
    expect(w.hands.browser.visitedWith).toHaveLength(0);
  });
});
