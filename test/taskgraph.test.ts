// The durable task graph (plan §3.1): each requested action bound to the execution that addressed it and the evidence that
// proves it; an approval is waiting_human, never done; a send is verified only by a provider message id; an unknown provider
// answer is uncertain and said so; a changed instruction is a new revision that keeps verified work and cancels the rest.
import { test, expect, beforeEach } from "bun:test";
import { one, all, J, S, exec } from "../src/db";
import * as rt from "../src/runtime";
import * as tg from "../src/taskgraph";
import { setup, user, workspace, installAgent, say, scriptModel, call, lastFrom, events, fakeGoogle, googleConnection, pendingApprovals, runsIn } from "./helpers";

let ellie: string, ws: string, ava: any, room: any;
beforeEach(() => { setup(); fakeGoogle(); ellie = user("Ellie"); ws = workspace("Home", ellie); ava = installAgent("ava-executive-assistant", ws, ellie); googleConnection(ws, ellie, [ava.id]); room = rt.privateRoomFor(ellie, ava); });

test("AC-TG1 a send: the action waits for the person, then is verified by the provider's message id; the trace shows the task state throughout", async () => {
  scriptModel(call("email.send", { to: ["dana@example.com"], subject: "Times next week", body: "Tue 2pm or Wed 10am?" }), { text: "Sent — I'll let you know when she replies." });
  await say(room.id, ellie, "send dana@example.com a note proposing Tue 2pm or Wed 10am");
  const run = runsIn(room.id)[0];
  expect(tg.view(run.id)).toMatchObject({ status: "waiting_human", state: expect.stringMatching(/^waiting for your OK/), actions: [{ target: "email.send", mode: "write", status: "waiting_human", inputs: { to: ["dana@example.com"] } }] });
  expect(pendingApprovals(room.id)).toHaveLength(1);
  await say(room.id, ellie, "approve");
  const t = tg.view(run.id);
  expect(t.status).toBe("verified");
  expect(t.state).toBe("done — verified");
  expect(t.actions[0]).toMatchObject({ status: "verified", evidence: [{ type: "tool_result", verdict: "verified", provider_ref: expect.stringMatching(/^gm_/), facts: { to: ["dana@example.com"], subject: "Times next week" } }] });
  expect(events("TASK_TERMINAL").at(-1).data).toMatchObject({ status: "verified", actions: [{ target: "email.send", status: "verified" }] });
  expect(rt.trace(run.id)!.task.state).toBe("done — verified");
});

test("AC-TG2 a draft is observed, never verified as sent; a reminder is verified by its persisted schedule", async () => {
  scriptModel(call("email.draft", { to: ["dana@example.com"], subject: "Hi", body: "…" }), call("reminder.schedule", { text: "Chase Dana", in_minutes: 120 }), { text: "Drafted, and I'll remind you in two hours." });
  await say(room.id, ellie, "draft a note to dana@example.com and remind me in 2 hours to chase her");
  const t = tg.view(runsIn(room.id)[0].id);
  expect(t.actions.map((a: any) => [a.target, a.status]).sort()).toEqual([["email.draft", "observed"], ["reminder.schedule", "verified"]]);
  expect(t.actions.find((a: any) => a.target === "reminder.schedule").evidence[0].provider_ref).toMatch(/^\w{6}$/);
  expect(t.status).toBe("verified"); // the only write (the reminder) is verified; the draft is a read-like step
});

test("AC-TG3 an unknown provider answer is uncertain: the task is not done and the reply says so", async () => {
  const run = { id: "run_u", workspace_id: ws, room_id: room.id, agent_id: ava.id, requested_by: ellie, objective: "send dana@example.com the times", trigger_event_id: null, brief: S({ facts: { emails: ["dana@example.com"], people: [], dates: [], amounts: [], max_price: null } }) };
  exec("insert into runs (id, workspace_id, room_id, agent_id, requested_by, objective, status, created_at) values (?,?,?,?,?,?,?,?)", run.id, ws, room.id, ava.id, ellie, run.objective, "running", Date.now());
  tg.fromBrief(run, { version: 1, goal: "Send Dana the times", deliverable: "", constraints: [], assumptions: [], questions: [], side_effects: ["Send email"], done_when: [], kind: "act", plan: [{ text: "Send the email", tool: "email.send", status: "todo" }] } as any);
  expect(tg.bind(run, "email.send", { id: "tex_u", input: { to: ["dana@example.com"], subject: "Times" }, result: { __status: "UNKNOWN" }, status: "UNKNOWN" })).toBe("uncertain");
  expect(tg.settle(run, true)).toBe("uncertain");
  expect(tg.stateLine(run.id)).toBe("uncertain — I can't confirm Send the email went through");
  expect(tg.uncertainWrites(run.id)).toHaveLength(1);
});

test("AC-TG4 a changed instruction is a new revision: verified work is kept, open actions are cancelled, the change is recorded", () => {
  const run = { id: "run_r", workspace_id: ws, room_id: room.id, agent_id: ava.id, requested_by: ellie, objective: "find a time with Dana and email her", trigger_event_id: "evt_1", brief: null };
  exec("insert into runs (id, workspace_id, room_id, agent_id, requested_by, objective, status, created_at) values (?,?,?,?,?,?,?,?)", run.id, ws, room.id, ava.id, ellie, run.objective, "running", Date.now());
  const brief: any = { version: 1, goal: "Find a time with Dana and email her", deliverable: "", constraints: [], assumptions: [], questions: [], side_effects: [], done_when: [], kind: "task",
    plan: [{ text: "Check the calendar", tool: "calendar.find_free_time", status: "todo" }, { text: "Email Dana", tool: "email.send", status: "todo" }] };
  tg.fromBrief(run, brief);
  tg.bind(run, "calendar.find_free_time", { id: "tex_c", input: { from: "2026-10-12", to: "2026-10-16" }, result: { slots: [{ start: "x" }] }, status: "SUCCEEDED" });
  tg.fromBrief(run, { ...brief, version: 2, goal: "Tuesday only" }, brief);
  const t = tg.view(run.id);
  expect(t.revision).toBe(2);
  expect(t.revisions.map((r: any) => r.change)).toEqual(["plan revised: Tuesday only"]);
  expect(all<any>("select target, status, revision from task_actions where task_id=? order by revision, n", t.id)).toEqual([
    { target: "calendar.find_free_time", status: "observed", revision: 1 }, { target: "email.send", status: "cancelled", revision: 1 }, { target: "email.send", status: "not_started", revision: 2 }]);
  void one; void J; void lastFrom;
});
