import { test, expect, beforeEach } from "bun:test";
import { one, all, J, exec, advance, now } from "../src/db";
import * as rt from "../src/runtime";
import * as mem from "../src/memory";
import { TOOLS } from "../src/tools";
import { hooks } from "../src/model";
import { setup, user, workspace, customAgent, googleConnection, say, scriptModel, call, net, pendingApprovals, runsIn, events, lastFrom, messages, channel, deliver, tg, link } from "./helpers";

let ellie: string, sam: string, ws: string;
beforeEach(() => { setup(); ellie = user("Ellie"); sam = user("Sam"); ws = workspace("Household", ellie, [[sam]]); });

test("AC-R1 every run leaves an append-only, explainable trace", async () => {
  const a = customAgent(ws, ellie, ["web-research"]);
  const room = rt.privateRoomFor(ellie, a);
  scriptModel(call("web.search", { query: "miami hotels" }), { text: "Here are options: https://hotel.example/one" });
  await say(room.id, ellie, "find hotels");
  const run = runsIn(room.id)[0];
  const types = all<any>("select type from events where run_id=? order by seq", run.id).map((e) => e.type);
  expect(types).toEqual(["RUN_STARTED", "BRIEF_PROPOSED", "MODEL_CALL", "TOOL_CALL_REQUESTED", "PERMISSION_DECISION", "TOOL_CALL_COMPLETED", "MODEL_CALL", "RESULT_CHECKED", "RUN_COMPLETED", "message"]);
  const reply = all<any>("select id from events where run_id=? and type='message'", run.id)[0];
  const t = rt.trace(reply.id)!;
  expect(t.trigger).toMatchObject({ text: "find hotels", by: "Ellie" });
  expect(t.tool_executions[0].tool_id).toBe("web.search");
  expect(run.kind).toBe("act"); // structured run classification
});

test("AC-R2 approvals: reject tells the agent, expiry after 72h, only approvers may decide", async () => {
  const a = customAgent(ws, ellie, ["email-drafting"]);
  googleConnection(ws, ellie, [a.id]);
  const room = rt.createRoom({ workspace_id: ws, name: "Trip", members: [{ id: ellie, kind: "human" }, { id: sam, kind: "human" }, { id: a.id, kind: "agent" }], participation: "manager" });
  const seen = scriptModel(call("email.send", { to: ["x@y.test"], subject: "s", body: "b" }), { text: "ok, not sending" });
  await say(room.id, ellie, "send it");
  const apr = pendingApprovals(room.id)[0];
  expect(rt.decideApproval(apr.id, sam, "approve")).toHaveProperty("error"); // Ellie's private Gmail: only Ellie approves
  await say(room.id, ellie, "reject");
  expect(seen.at(-1)!.messages.at(-1)!.content).toMatch(/^REJECTED/);
  expect(net.to(/messages\/send/)).toHaveLength(0);

  scriptModel(call("email.send", { to: ["z@y.test"], subject: "s", body: "b" }), { text: "expired" });
  await say(room.id, ellie, "send another");
  advance(73 * 3600e3); await rt.drain();
  expect(one<any>("select status from approvals where tool_id='email.send' order by created_at desc").status).toBe("expired");
  expect(runsIn(room.id).at(-1).status).toBe("completed");
});

test("AC-R3 financial actions need strong confirmation; first_time tools remember the grant", async () => {
  TOOLS["test.pay"] = { id: "test.pay", description: "pay", risk: "financial", idempotency: "key_required", defaultApproval: "always",
    inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] }, execute: async (i) => ({ status: "SUCCEEDED", output: i }) };
  const { SKILLS } = await import("../src/templates");
  SKILLS["test-pay"] = { id: "test-pay", name: "pay", tools: ["test.pay"], procedure: "" };
  const a = customAgent(ws, ellie, ["test-pay", "browser"]);
  const room = rt.privateRoomFor(ellie, a);
  scriptModel(call("test.pay", { amount: 500 }), { text: "paid" });
  await say(room.id, ellie, "pay the hotel");
  const apr = pendingApprovals(room.id)[0];
  expect(apr.strong).toBe(1);
  await say(room.id, ellie, "approve");
  expect(lastFrom(room.id, a.id)).toMatch(/strong confirmation/);
  await say(room.id, ellie, `confirm ${apr.id.slice(-4)}`);
  expect(lastFrom(room.id, a.id)).toBe("paid");

  net.on(/browser/, () => Response.json({ status: "succeeded", output: "done" }));
  process.env.BROWSER_TASK_URL = "https://browser.test/run";
  scriptModel(call("browser.task", { task: "check in" }), { text: "done 1" });
  await say(room.id, ellie, "check in");
  await say(room.id, ellie, "approve");
  scriptModel(call("browser.task", { task: "check in again" }), { text: "done 2" });
  await say(room.id, ellie, "check in again");
  expect(lastFrom(room.id, a.id)).toBe("done 2"); // second use needed no approval
  expect(all("select * from approvals where tool_id='browser.task'")).toHaveLength(1);
  delete process.env.BROWSER_TASK_URL; delete TOOLS["test.pay"];
});

test("AC-R4 group participation modes: mention_only, relevant, manager", async () => {
  const a = customAgent(ws, ellie, ["travel-planning"], {}, "Scout");
  exec("update agents set job='plan travel and compare hotels' where id=?", a.id);
  const room = rt.createRoom({ workspace_id: ws, name: "G", members: [{ id: ellie, kind: "human" }, { id: sam, kind: "human" }, { id: a.id, kind: "agent" }] });
  scriptModel({ text: "hi" });
  await say(room.id, sam, "what time is dinner?");
  expect(runsIn(room.id)).toHaveLength(0);
  await say(room.id, sam, "@Scout hello");
  expect(runsIn(room.id)).toHaveLength(1);
  exec("update rooms set participation='relevant' where id=?", room.id);
  await say(room.id, sam, "dinner at 8");
  await say(room.id, sam, "should we compare hotels near the beach?");
  expect(runsIn(room.id)).toHaveLength(2);
  exec("update rooms set participation='manager' where id=?", room.id);
  await say(room.id, sam, "ok");
  expect(runsIn(room.id)).toHaveLength(3);
});

test("AC-R5 delegation is typed: child sees only its objective, parent resumes with the result", async () => {
  const recruiter = customAgent(ws, ellie, ["delegation", "task-tracking"], {}, "Recruiter");
  const cred = customAgent(ws, ellie, ["web-research"], {}, "Credentialing");
  const room = rt.createRoom({ workspace_id: ws, name: "ICU", participation: "manager", members: [{ id: ellie, kind: "human" }, { id: recruiter.id, kind: "agent" }] });
  await rt.ingestMessage({ roomId: room.id, senderId: ellie, text: "SECRET-PARENT-CONTEXT: Amanda's rate is $95/hr", platform: "web" });
  exec("delete from runs"); exec("delete from waits");
  const seen = scriptModel((r) => {
    if (r.messages[0].content.startsWith("[DELEGATED_TASK")) return { text: "All 4 can start Monday" };
    if (r.messages.some((m) => m.content.includes("finished the delegated task"))) return { text: "Credentialing says all 4 can start Monday." };
    return call("agent.delegate", { agent: "Credentialing", objective: "Check whether these 4 candidates can start by Monday" });
  });
  await say(room.id, ellie, "Can our 4 candidates start Monday?");
  const child = all<any>("select * from runs where parent_run_id is not null")[0];
  const childReq = seen.find((r) => r.messages[0].content.startsWith("[DELEGATED_TASK"))!;
  expect(childReq.messages[0].content).not.toContain("SECRET-PARENT-CONTEXT");
  expect(J(child.budget).maxAutonomousExternalWrites).toBe(0);
  expect(messages(room.id).map((m) => m.text)).toContain("Recruiter → Credentialing: Check whether these 4 candidates can start by Monday");
  expect(lastFrom(room.id, recruiter.id)).toBe("Credentialing says all 4 can start Monday.");
  expect(lastFrom(room.id, cred.id)).toBeUndefined(); // child result goes to the parent, not the chat
});

test("AC-R6 wake conditions: one-off reminders, recurring schedules, timeouts, state changes", async () => {
  const a = customAgent(ws, ellie, ["reminders", "follow-up-tracking"], {}, "Ava");
  const room = rt.privateRoomFor(ellie, a);
  const t = channel(a.id, "telegram", "ava_bot");
  link("telegram", "42", ellie);
  await deliver("telegram", t.id, tg(42, 42, "Ellie", "remind me to call mom in 30 minutes")); // offline heuristic model
  expect(lastFrom(room.id, a.id)).toMatch(/Reminder set/);
  scriptModel({ text: "Time to call mom!" });
  advance(31 * 60e3); await rt.drain();
  expect(net.to(/api\.telegram\.org/).at(-1)!.body.text).toBe("Time to call mom!"); // proactive message goes to the last-used channel

  rt.createSchedule({ agent_id: a.id, room_id: room.id, kind: "recurring", spec: { every: "daily", hour: 9 }, objective: "morning agenda", created_by: ellie });
  advance(25 * 3600e3); await rt.drain();
  const sch = one<any>("select * from schedules where objective='morning agenda'");
  expect(sch.next_at).toBeGreaterThan(now());
  expect(all("select * from runs where kind='schedule' and objective like 'morning agenda%'").length).toBeGreaterThanOrEqual(1);

  scriptModel(call("wait.for_reply", { from_email: "bob@x.test", timeout_hours: 1 }), (r) => ({ text: r.messages.some((m) => m.content.includes("Timed out")) ? "Bob never replied; nudging you." : "waiting" }));
  await say(room.id, ellie, "wait for bob");
  advance(2 * 3600e3); await rt.drain();
  expect(lastFrom(room.id, a.id)).toBe("Bob never replied; nudging you.");

  rt.createSchedule({ agent_id: a.id, room_id: room.id, kind: "event", spec: { wake_key: `task_blocked:${room.id}` }, objective: "Escalate blockers", created_by: ellie });
  const task = rt.createTask(room.id, { title: "Drug screen", owner: ellie });
  scriptModel({ text: "Heads up: Drug screen is blocked." });
  rt.updateTask(task.id, room.id, { status: "blocked" }); await rt.drain();
  expect(lastFrom(room.id, a.id)).toBe("Heads up: Drug screen is blocked.");
});

test("AC-R7 one agent, many rooms: room memory and work state don't cross rooms", async () => {
  const a = customAgent(ws, ellie, ["travel-planning"], {}, "Scout");
  const r1 = rt.createRoom({ workspace_id: ws, name: "Miami", participation: "manager", members: [{ id: ellie, kind: "human" }, { id: a.id, kind: "agent" }] });
  const r2 = rt.createRoom({ workspace_id: ws, name: "Tokyo", participation: "manager", members: [{ id: sam, kind: "human" }, { id: a.id, kind: "agent" }] });
  mem.remember({ room: r1, text: "Budget is $900 per night", scope: "room", createdBy: ellie });
  rt.createTask(r1.id, { title: "Compare Miami hotels", owner: a.id });
  const seen = scriptModel({ text: "ok" });
  await say(r2.id, sam, "what's our budget?");
  expect(seen[0].system).not.toContain("$900");
  expect(seen[0].system).not.toContain("Compare Miami hotels");
});

test("AC-R8 model outage: retries with backoff then fails terminally with a message", async () => {
  const a = customAgent(ws, ellie, ["web-research"]);
  const room = rt.privateRoomFor(ellie, a);
  hooks.model = () => { throw new Error("overloaded"); };
  await say(room.id, ellie, "hello");
  expect(runsIn(room.id)[0].status).toBe("retrying");
  advance(3000); await rt.drain(); advance(5000); await rt.drain();
  expect(runsIn(room.id)[0].status).toBe("failed_terminal");
  expect(lastFrom(room.id, a.id)).toMatch(/model unavailable/);
});

test("AC-R9 cancelling a run cancels its waits and pending approvals", async () => {
  const a = customAgent(ws, ellie, ["email-drafting"]);
  googleConnection(ws, ellie, [a.id]);
  const room = rt.privateRoomFor(ellie, a);
  scriptModel(call("email.send", { to: ["x@y.test"], subject: "s", body: "b" }));
  await say(room.id, ellie, "send");
  const run = runsIn(room.id)[0];
  expect(rt.cancelRun(run.id, ellie)).toBe(true);
  expect(one<any>("select status from runs where id=?", run.id).status).toBe("cancelled");
  expect(pendingApprovals(room.id)).toHaveLength(0);
});

test("AC-R10 hosted inference stops at the plan's monthly allowance (BYOK isn't counted)", async () => {
  const a = customAgent(ws, ellie, ["web-research"]);
  const room = rt.privateRoomFor(ellie, a);
  exec("update workspaces set plan='free' where id=?", ws);
  exec("insert into usage (workspace_id, kind, qty, cost_usd, byok, ts) values (?, 'model_input_tokens', 1, 5, 1, ?)", ws, now()); // BYOK: ignored
  scriptModel({ text: "fine" });
  await say(room.id, ellie, "hello");
  expect(lastFrom(room.id, a.id)).toBe("fine");
  exec("insert into usage (workspace_id, kind, qty, cost_usd, byok, ts) values (?, 'model_input_tokens', 1, 2.5, 0, ?)", ws, now());
  await say(room.id, ellie, "hello again");
  expect(lastFrom(room.id, a.id)).toMatch(/used its \$2 monthly AI allowance/);
});
