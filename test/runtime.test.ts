import * as billing from "../src/billing";
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
  expect(types).toEqual(["RUN_STARTED", "BRIEF_PROPOSED", "message", "MODEL_CALL", "TOOL_CALL_REQUESTED", "PERMISSION_DECISION", "TOOL_CALL_COMPLETED", "MODEL_CALL", "RESULT_CHECKED", "RUN_COMPLETED", "message"]);
  const reply = all<any>("select id from events where run_id=? and type='message'", run.id).at(-1); // [0] is the immediate "on it"
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
  advance(31 * 60e3); await rt.drain();
  expect(net.to(/api\.telegram\.org/).at(-1)!.body.text).toBe("⏰ call mom"); // delivered word for word (no model), to the chat it was asked in

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

test("AC-R10 hosted inference stops when the monthly allowance and credits run out; topping up resumes it", async () => {
  const a = customAgent(ws, ellie, ["web-research"]);
  const room = rt.privateRoomFor(ellie, a);
  exec("update workspaces set plan='free' where id=?", ws);
  scriptModel({ text: "fine" });
  await say(room.id, ellie, "hello");
  expect(lastFrom(room.id, a.id)).toBe("fine");
  billing.charge(ws, 2.5); // $2 allowance, then $0.50 into credits
  expect(billing.balance(ws)).toMatchObject({ allowance_left: 0, credits: -0.5 });
  await say(room.id, ellie, "hello again");
  expect(lastFrom(room.id, a.id)).toMatch(/out of AI credits/);
  billing.addCredits(ws, 10, "test", "ref-1");
  expect(billing.addCredits(ws, 10, "test", "ref-1")).toBe(false); // once per reference
  await say(room.id, ellie, "and again");
  expect(lastFrom(room.id, a.id)).toBe("fine");
});

test("AC-R11 a reply that promises an action without calling its tool is sent back once, on a stronger model, to actually do it", async () => {
  const a = customAgent(ws, ellie, ["task-tracking"], { "task.create": "always_ask" });
  const room = rt.privateRoomFor(ellie, a);
  const seen = scriptModel(
    { text: "I'll create that task for you. Reply \"approve\" to confirm." }, // the failure a live model showed: narrating, not acting
    call("task.create", { title: "BLS follow-ups", owner: "agent" }),
  );
  await say(room.id, ellie, "Take care of the BLS follow-ups");
  expect(events("UNBACKED_CLAIM")).toHaveLength(1);
  expect(seen.at(-1)!.escalate).toBe(true); // the retry goes to the stronger tier
  expect(seen.at(-1)!.messages.some((m) => m.content.includes("You described an action but didn't call a tool"))).toBe(true);
  expect(pendingApprovals(room.id)[0]).toMatchObject({ tool_id: "task.create" }); // a real approval now exists
  expect(messages(room.id).some((m) => /I'll create that task/.test(m.text ?? ""))).toBe(false); // the model's false promise never reached the user
});

test("AC-R12 with JEV configured, group relevance and unbacked claims are judged by JEV; failures fall back", async () => {
  process.env.JEV_API_KEY = "test";
  try {
    // JEV answers by keyword so the test controls each decision; "Done!" isn't caught by the regex, only by JEV.
    net.on(/typesafe\.ai/, (_r, b) => Response.json({ answers: { q: { type: "noul", noul: /hotels|Done!/.test(JSON.stringify(b.state)) ? 0.9 : 0.1 } } }));
    const a = customAgent(ws, ellie, ["task-tracking"], { "task.create": "always_ask" }, "Scout");
    const room = rt.createRoom({ workspace_id: ws, name: "G", participation: "relevant", members: [{ id: ellie, kind: "human" }, { id: sam, kind: "human" }, { id: a.id, kind: "agent" }] });
    scriptModel({ text: "Done! The task is created." }, call("task.create", { title: "Hotels", owner: "agent" }));
    await say(room.id, sam, "running late");
    expect(runsIn(room.id)).toHaveLength(0);
    await say(room.id, sam, "can someone sort out hotels?");
    expect(runsIn(room.id)).toHaveLength(1);
    expect(events("UNBACKED_CLAIM")).toHaveLength(1);
    expect(pendingApprovals(room.id)[0]).toMatchObject({ tool_id: "task.create" });
    net.on(/typesafe\.ai/, () => new Response("down", { status: 503 })); // JEV down: keyword fallback still gates
    await say(room.id, sam, "dinner at 8");
    expect(runsIn(room.id)).toHaveLength(1);
  } finally { delete process.env.JEV_API_KEY; }
});

test("AC-R13 a reply containing raw tool-call markup is never sent: one retry on a stronger model, else the markup is stripped", async () => {
  const a = customAgent(ws, ellie, ["web-research"]);
  const room = rt.privateRoomFor(ellie, a);
  const leak = '<｜DSML｜tool_calls> <｜DSML｜invoke name="web__search"> <｜DSML｜parameter name="query" string="true">madrid hotels</｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜tool_calls>';
  const seen = scriptModel({ text: leak }, { text: "Three Madrid hotels: Only YOU, Único, The Principal." });
  await say(room.id, ellie, "hi there, any good madrid hotels");
  expect(events("TOOL_MARKUP_LEAK")).toHaveLength(1);
  expect(seen.at(-1)!.escalate).toBe(true);
  const said = messages(room.id).filter((m) => m.actor === a.id).map((m) => m.text).join("\n");
  expect(said).toContain("Three Madrid hotels");
  expect(said).not.toMatch(/DSML|tool_calls/);
  // Still leaking after the retry: strip it rather than send it
  scriptModel({ text: leak }, { text: `Here you go. ${leak}` });
  await say(room.id, ellie, "and barcelona?");
  expect(messages(room.id).filter((m) => m.actor === a.id).map((m) => m.text).join("\n")).not.toMatch(/DSML/);
});

test("AC-R14 grounding: figures with no source get one 'cite or drop' retry; sourced and calculated figures pass; missing data is recorded", async () => {
  const a = customAgent(ws, ellie, ["web-research"]);
  const room = rt.privateRoomFor(ellie, a);
  // Made up: nothing in this conversation says $250 or 6.1%
  const seen = scriptModel({ text: "NVDA is at $250.10, up 6.1% today." }, call("data.missing", { need: "live NVDA price", category: "stocks" }), { text: "I can't check live prices yet — connect a market data source and I'll track it." });
  await say(room.id, ellie, "how's nvidia doing today");
  expect(events("UNGROUNDED_FIGURES")[0].data.figures).toEqual(["$250.10", "6.1%"]);
  expect(seen[1].messages.some((m) => m.content.includes("don't appear in any tool result"))).toBe(true);
  expect(events("DATA_GAP")[0].data).toMatchObject({ need: "live NVDA price", category: "stocks" });
  expect(lastFrom(room.id, a.id)).toMatch(/can't check live prices/);
  // Sourced from a tool result (within rounding), or given by the person: no retry
  expect(rt.ungroundedFigures({ id: "none", room_id: room.id, objective: "I paid $240 for the cabin", agent_id: a.id }, "You paid $240, so $60 each... wait")).toEqual(["$60"]);
  expect(rt.ungroundedFigures({ id: "none", room_id: room.id, objective: "I paid $240 for the cabin", agent_id: a.id }, "Got it: $240 for the cabin.")).toEqual([]);
});

test("AC-R15 sports scores come from the scoreboard feed: finals with scores, upcoming games without fake 0–0, team filter, in the person's time zone", async () => {
  const ev = (id: string, state: string, home: string, away: string, hs: string, as: string) => ({ id, name: `${away} at ${home}`, date: "2026-10-05T00:00Z",
    status: { type: { state, description: state === "post" ? "Final" : "Scheduled", shortDetail: state === "post" ? "Final" : "10/5 - 8:15 PM EDT" } },
    competitions: [{ competitors: [{ homeAway: "home", score: hs, team: { displayName: home, abbreviation: home.slice(0, 3).toUpperCase() } }, { homeAway: "away", score: as, team: { displayName: away, abbreviation: away.slice(0, 3).toUpperCase() } }], broadcasts: [{ names: ["ESPN"] }] }] });
  net.on(/site\.api\.espn\.com.*baseball\/mlb\/scoreboard/, (r) => { expect(r.headers.get("user-agent")).toContain("Mozilla"); return Response.json({ events: [ev("1", "post", "Brewers", "Padres", "4", "3"), ev("2", "pre", "Dodgers", "Braves", "0", "0")] }); });
  const out = (await TOOLS["sports.scores"].execute({ league: "mlb", date: "today" }, { run: { requested_by: ellie } } as any)).output;
  expect(out.games[0]).toMatchObject({ status: "Final", home: { team: "Brewers", score: "4" }, away: { score: "3" }, tv: "ESPN" });
  expect(out.games[1].home.score).toBeNull();
  const braves = (await TOOLS["sports.scores"].execute({ league: "mlb", team: "braves" }, { run: { requested_by: ellie } } as any)).output.games;
  expect(braves.map((g: any) => g.away.team)).toEqual(["Braves"]);
  await expect(TOOLS["sports.scores"].execute({ league: "cricket" }, { run: {} } as any)).rejects.toThrow(/unknown league/);
});

test("AC-JOB1 job contracts: a reminder 'done' with nothing behind it is sent back once, then flagged honestly; outcomes are recorded", async () => {
  const a = customAgent(ws, ellie, ["reminders"], {}, "Ollie");
  const room = rt.privateRoomFor(ellie, a);
  const seen = scriptModel({ text: "All set for 5pm!" }, { text: "All set for 5pm!" });
  await say(room.id, ellie, "remind me at 5pm to stretch");
  expect(seen[1].messages.some((m) => m.content.includes("nothing shows it was done"))).toBe(true);
  expect(lastFrom(room.id, a.id)).toMatch(/All set for 5pm![\s\S]*Heads up: I couldn't confirm this actually happened/);
  expect(events("JOB_OUTCOME").at(-1).data).toMatchObject({ job: "reminder", ok: false });
  expect(all("select 1 from schedules where room_id=?", room.id)).toHaveLength(0);
  // With the tool actually called, it's proven
  scriptModel(call("reminder.schedule", { text: "stretch", in_minutes: 60 }), { text: "Done — 5:00 PM." });
  await say(room.id, ellie, "remind me in an hour to stretch");
  expect(events("JOB_OUTCOME").at(-1).data).toMatchObject({ job: "reminder", ok: true, evidence: "reminder.schedule succeeded" });
});
