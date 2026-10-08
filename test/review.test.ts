// From the 2026-10-07 review: the agent must keep an accurate model of the task and prove each promised outcome.
// A keyword plan never runs silently; a send is proven only by a send; tool calls are checked against the request's own
// people, dates and money; an unavailable judge proves nothing; playbooks are learned only from verified runs.
import { test, expect, beforeEach } from "bun:test";
import { one, exec, J, S } from "../src/db";
import * as rt from "../src/runtime";
import { decide, factsOf, plannerTier, planGaps } from "../src/intake";
import { verifyFacts } from "../src/jobs";
import { verifiedOutcome, recordPlaybook } from "../src/experience";
import { setup, user, workspace, installAgent, say, scriptModel, call, lastFrom, events, fakeGoogle, googleConnection, pendingApprovals } from "./helpers";

let ellie: string, ws: string, ava: any, room: any;
beforeEach(() => { setup(); fakeGoogle(); ellie = user("Ellie"); ws = workspace("Home", ellie); ava = installAgent("ava-executive-assistant", ws, ellie); googleConnection(ws, ellie, [ava.id]); room = rt.privateRoomFor(ellie, ava); });

test("AC-R1 the request's own facts are typed: people, addresses, dates, money, a price cap", () => {
  const f = factsOf("Email Dana at dana@example.com and Sam about Oct 20 — budget $450, nothing over $300 a night", Date.parse("2026-10-07T12:00:00Z"));
  expect(f).toMatchObject({ emails: ["dana@example.com"], people: ["Dana", "Sam"], amounts: [450, 300], max_price: 300 });
  expect(f.dates).toEqual(["2026-10-20"]);
});

test("AC-R2 a keyword plan that stands in for a failed model never runs silently: it is shown for confirmation", () => {
  const brief: any = { kind: "act", side_effects: ["Send email to dana@example.com"], questions: [], plan: [{ tool: "email.send" }], planner: "fallback" };
  expect(decide(brief, { mode: "auto", revised: false })).toBe("confirm");
  expect(decide({ ...brief, planner: "model" }, { mode: "auto", revised: false })).toBe("auto");          // one external write: its own approval card is the check
  expect(decide({ ...brief, side_effects: [], plan: [{ tool: "reminder.schedule" }] }, { mode: "auto", revised: false })).toBe("auto"); // internal-only work runs
  expect(decide({ ...brief, side_effects: [], plan: [], kind: "answer" }, { mode: "auto", revised: false })).toBe("skip");
});

test("AC-R3 an email sent to an address the request didn't name is caught: one chance to fix, then the person is told", async () => {
  scriptModel(call("email.send", { to: ["bob@example.com"], subject: "Next week", body: "Tuesday 2pm?" }), { text: "Sent — I've asked about Tuesday." }, { text: "Sent — I've asked about Tuesday." });
  await say(room.id, ellie, "send dana@example.com a note asking if Tuesday 2pm works");
  // The approval card itself carries the warning, before anyone can approve the wrong send
  expect(events("FACT_MISMATCH")).toHaveLength(1);
  expect(events("FACT_MISMATCH")[0].data.problems[0]).toBe("the email is addressed to bob@example.com, but the request named dana@example.com");
  expect(pendingApprovals(room.id)).toHaveLength(1);
  expect(lastFrom(room.id, ava.id)).toMatch(/^OK to go ahead\? Send email to bob@example\.com[\s\S]*⚠️ Heads up: the email is addressed to bob@example\.com, but the request named dana@example\.com\.$/);
});

test("AC-R4 'send' is proven only by a send: a successful draft is not evidence that the email went", async () => {
  scriptModel(call("email.draft", { to: ["dana@example.com"], subject: "Tuesday", body: "Does 2pm work?" }), { text: "Done — I've emailed Dana." }, { text: "Done — I've emailed Dana." });
  await say(room.id, ellie, "send dana@example.com an email asking if Tuesday 2pm works");
  expect(pendingApprovals(room.id)).toHaveLength(0);
  expect(events("JOB_OUTCOME").at(-1).data).toMatchObject({ job: "email", ok: false });
  expect(lastFrom(room.id, ava.id)).toMatch(/Heads up: I couldn't confirm this actually happened/);
  // ...while "draft" asked for is done by the draft
  scriptModel(call("email.draft", { to: ["dana@example.com"], subject: "Tuesday", body: "Does 2pm work?" }), { text: "Here's the draft." });
  await say(room.id, ellie, "draft a note to dana@example.com about Tuesday 2pm");
  expect(events("JOB_OUTCOME").at(-1).data).toMatchObject({ job: "email", ok: true });
});

test("AC-R5 a calendar look-up for the wrong week is caught against the request's date", async () => {
  const run = { id: "run_x", workspace_id: ws };
  exec("insert into runs (id, workspace_id, room_id, agent_id, requested_by, objective, status, created_at) values (?,?,?,?,?,?,?,?)", run.id, ws, room.id, ava.id, ellie, "am I free on Oct 20?", "running", Date.now());
  exec("insert into tool_executions (id, run_id, tool_id, fingerprint, status, input, result, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)", "tx1", run.id, "calendar.find_free_time", "fp1", "succeeded", S({ from: "2026-10-27", to: "2026-10-31" }), S({ slots: [] }), Date.now(), Date.now());
  const facts = factsOf("am I free on Oct 20?", Date.parse("2026-10-07T12:00:00Z"));
  expect(verifyFacts(run, facts)).toEqual(["the calendar was checked for 2026-10-27 to 2026-10-31, but the request was about 2026-10-20"]);
  exec("update tool_executions set input=? where id='tx1'", S({ from: "2026-10-19", to: "2026-10-25" }));
  expect(verifyFacts(run, facts)).toEqual([]);
});

test("AC-R6 an unavailable judge proves nothing, and playbooks are learned only from verified runs", () => {
  const mk = (id: string) => { exec("insert into runs (id, workspace_id, room_id, agent_id, requested_by, objective, status, kind, result, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?)", id, ws, room.id, ava.id, ellie, "compare hotels in Lisbon", "completed", "act", S({}), Date.now() - 5000, Date.now());
    for (const t of ["web.search", "web.fetch"]) for (const ty of ["TOOL_CALL_REQUESTED", "TOOL_CALL_COMPLETED"]) exec("insert into events (id, workspace_id, room_id, run_id, type, actor, data, ts) values (?,?,?,?,?,?,?,?)", `ev_${id}_${t}_${ty}`, ws, room.id, id, ty, ava.id, S({ tool: t, status: "SUCCEEDED", input: { query: "lisbon", url: "https://x.example/a" } }), Date.now());
    return one<any>("select * from runs where id=?", id); };
  const good = mk("run_good"), bad = mk("run_bad");
  exec("insert into events (id, workspace_id, room_id, run_id, type, actor, data, ts) values (?,?,?,?,?,?,?,?)", "ev_ju", ws, room.id, bad.id, "JUDGE_UNAVAILABLE", ava.id, S({ criteria: ["Three options with prices"] }), Date.now());
  expect(verifiedOutcome(good)).toBe(true);
  expect(verifiedOutcome(bad)).toBe(false);
  const playbooks = () => one<any>("select count(*) n from memories where kind='playbook'").n;
  recordPlaybook(bad); expect(playbooks()).toBe(0);
  recordPlaybook(good); expect(playbooks()).toBe(1);
  void J;
});

test("AC-R7 the planner tier follows the ask's shape, not a keyword: several actions, a correction, a person named without an address go to the judge tier; one lookup stays fast", () => {
  const q = (n: number) => ({ plan: Array.from({ length: n }, (_, i) => ({ text: `s${i}`, tool: "web.search", status: "todo" as const })) });
  expect(plannerTier("give your analysis of the stock market today", q(1))).toBe("fast");
  expect(plannerTier("find a time with Dana next week, email her the options, and remind me Friday if she hasn't replied", q(2))).toBe("judge"); // two writes
  expect(plannerTier("actually make it Wednesday instead", q(1))).toBe("judge");                                                                // refers back
  expect(plannerTier("email Dana about the offsite", q(1))).toBe("judge");                                                                      // named, no address
  expect(plannerTier("email dana@example.com about the offsite", q(1))).toBe("fast");
  expect(plannerTier("what's the weather tomorrow", q(1), true)).toBe("judge");                                                                 // a revision of a running plan
});

test("AC-R8 plan review: a job the request asks for that the plan leaves out is added, never silently dropped", () => {
  const tools = ["email.send", "email.draft", "email.search", "reminder.schedule", "calendar.find_free_time", "web.search"];
  const gaps = planGaps("email dana@example.com the times and remind me friday if she hasn't replied", [{ text: "Send the email", tool: "email.send", status: "todo" }], tools);
  expect(gaps).toEqual([{ job: "reminder", tool: "reminder.schedule", label: "set that reminder" }]);
  expect(planGaps("email dana@example.com the times", [{ text: "Send", tool: "email.send", status: "todo" }], tools)).toEqual([]);
  expect(planGaps("what's on my calendar tomorrow", [{ text: "Look", tool: "web.search", status: "todo" }], tools)).toEqual([{ job: "calendar", tool: "calendar.find_free_time", label: "check your calendar" }]);
  expect(planGaps("remind me at 5", [], ["web.search"])).toEqual([]); // an agent without the tool can't be asked to plan it
});
