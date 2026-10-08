// Specialists: Ava splits independent look-ups into parallel child tasks, each limited to its kind's tools, returning typed
// findings; Ava checks them and answers. Children never gain access, can't write, and stop when the request changes.
import { test, expect, beforeEach } from "bun:test";
import { one, all, J } from "../src/db";
import * as rt from "../src/runtime";
import * as intake from "../src/intake";
import { setup, user, workspace, installAgent, googleConnection, scriptModel, call, net, say, runsIn, lastFrom, events } from "./helpers";

let ellie: string, ws: string, ava: any, room: any;
beforeEach(() => {
  setup(); ellie = user("Ellie"); ws = workspace("Home", ellie);
  ava = installAgent("ava-executive-assistant", ws, ellie); googleConnection(ws, ellie, [ava.id]);
  room = rt.privateRoomFor(ellie, ava);
  net.on(/calendar\/v3\/freeBusy/, () => Response.json({ calendars: { primary: { busy: [] } } }));
});
const isTask = (r: any, kind: string) => String(r.messages[0]?.content ?? "").includes(`[SPECIALIST_TASK — ${kind}]`);
const has = (r: any, s: string) => r.messages.some((m: any) => String(m.content ?? "").includes(s));

test("AC-SPC1 specialists run in parallel on their own tools only, can't write, return typed findings; Ava checks them and answers", async () => {
  const toolsSeen: Record<string, string[]> = {};
  const seen = scriptModel((r) => {
    if (isTask(r, "research")) { toolsSeen.research = (r.tools ?? []).map((t: any) => t.name);
      return r.messages.length === 1 ? call("web.search", { query: "dinner near Union Square" })
        : { text: JSON.stringify({ finding: "Hotel One has a quiet room for 6", sources: ["https://hotel.example/one"], proposed_actions: ["Book Hotel One for Thursday 7pm"], unresolved_questions: [] }) }; }
    if (isTask(r, "calendar")) { toolsSeen.calendar = (r.tools ?? []).map((t: any) => t.name);
      return r.messages.length === 1 ? call("email.send", { to: ["x@example.com"], subject: "hi", body: "hi" })     // not its tool: refused
        : r.messages.length === 3 ? call("calendar.find_free_time", { days: 7, duration_minutes: 90 })
        : { text: JSON.stringify({ finding: "Thursday 7–9pm is free", sources: ["calendar.find_free_time"], proposed_actions: [], unresolved_questions: ["Is Dana free too?"] }) }; }
    return has(r, "[SPECIALIST_RESULTS]") ? { text: "Thursday 7pm works for you, and Hotel One has a quiet room for 6 (hotel.example/one). Want me to book it? I couldn't check Dana's calendar." }
      : call("specialists.run", { tasks: [{ specialist: "research", objective: "Find a quiet dinner spot for 6 near Union Square" }, { specialist: "calendar", objective: "When am I free Thursday evening for 90 minutes?" }] });
  });
  await say(room.id, ellie, "Find a quiet dinner spot for 6 near Union Square and check when I'm free Thursday evening");

  const parent = runsIn(room.id).find((r: any) => !r.parent_run_id);
  const kids = all<any>("select * from runs where parent_run_id=? order by created_at", parent.id);
  expect(kids.map((k) => J(k.result).specialist)).toEqual(["research", "calendar"]);
  expect(kids.every((k) => k.status === "completed")).toBe(true);
  // Bounded: only its kind's tools (no send, no specialists of its own), no autonomous writes, a share of the budget
  expect(toolsSeen.research).toEqual(expect.arrayContaining(["web.search"]));
  expect(toolsSeen.research).not.toContain("calendar.find_free_time");
  expect(toolsSeen.calendar).toEqual(expect.arrayContaining(["calendar.find_free_time", "contacts.search", "email.search"]));
  for (const t of [...toolsSeen.research, ...toolsSeen.calendar]) expect(["email.send", "calendar.create_event", "specialists.run", "reminder.schedule"]).not.toContain(t);
  expect(J(kids[1].budget).maxAutonomousExternalWrites).toBe(0);
  expect(J(kids[0].budget).maxToolCalls).toBeLessThan(J(parent.budget).maxToolCalls);
  expect(one("select 1 from approvals")).toBeFalsy();                                                 // the refused send never became an approval
  expect(events("TOOL_CALL_COMPLETED").concat(events("TOOL_CALL_FAILED")).some((e) => e.data.tool === "email.send" && e.data.status === "SUCCEEDED")).toBe(false);
  // Typed results reach Ava together; the children's text isn't posted to the chat; Ava answers once
  expect(J(kids[0].result).output).toMatchObject({ finding: "Hotel One has a quiet room for 6", sources: ["https://hotel.example/one"], proposed_actions: ["Book Hotel One for Thursday 7pm"] });
  expect(J(kids[1].result).output.unresolved_questions).toEqual(["Is Dana free too?"]);
  // Typed output carries a stated confidence; the children's spend is on the parent's ledger too (one task, one budget)
  expect(J(kids[0].result).output).toMatchObject({ confidence: "medium", unknowns: [] });
  expect(J(kids[0].result).output.unverified).toBeUndefined();
  const ledger = J(one<any>("select spent from runs where id=?", parent.id).spent);
  expect(ledger.children.toolCalls).toBe(2);
  expect(rt.taskSpent(one<any>("select * from runs where id=?", parent.id)).toolCalls).toBe(ledger.toolCalls + 2);
  // Each specialist is held to its own discipline, not the parent's skill list
  expect(String(seen.find((r) => isTask(r, "research"))!.messages[0].content)).toMatch(/open the sources, don't answer from a snippet/);
  expect(String(seen.find((r) => isTask(r, "calendar"))!.messages[0].content)).toMatch(/read only\. State exactly which dates and time zone/);
  const final = seen.find((r) => !isTask(r, "research") && !isTask(r, "calendar") && has(r, "[SPECIALIST_RESULTS]"))!;
  expect(final).toBeTruthy();
  expect(lastFrom(room.id, ava.id)).toMatch(/^Thursday 7pm works/);
  expect(all<any>("select data from events where room_id=? and type='message' and actor=?", room.id, ava.id).some((e) => /finding/.test(e.data))).toBe(false);
  expect(parent.status).toBe("completed");
  // The calendar look-up a specialist did is evidence for Ava's calendar job
  expect(events("JOB_OUTCOME").at(-1).data).toMatchObject({ job: "calendar", ok: true, evidence: "calendar.find_free_time succeeded" });
});

test("AC-SPC2 a changed request stops the specialists working on the old one", async () => {
  scriptModel((r) => isTask(r, "research") ? call("web.search", { query: "q" })
    : call("specialists.run", { tasks: [{ specialist: "research", objective: "Find dinner spots in SoHo" }, { specialist: "research", objective: "Find dinner spots in Tribeca" }] }));
  await rt.ingestMessage({ roomId: room.id, senderId: ellie, text: "find dinner spots in SoHo and Tribeca", platform: "web" });
  await rt.tick(); // the parent starts both and waits
  const parent = runsIn(room.id).find((r: any) => !r.parent_run_id);
  expect(all("select 1 from runs where parent_run_id=? and status='queued'", parent.id)).toHaveLength(2);
  intake.reviseBrief(parent.id, ellie, "actually just the West Village");
  expect(all<any>("select status from runs where parent_run_id=?", parent.id).map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
  expect(rt.runSpecialists({ ...parent, parent_run_id: "x" }, [])).toHaveProperty("error");            // and a specialist can't start its own
});

test("AC-SPC3 any agent: whether to use specialists is decided at design time from its jobs (never light; deep work or mixed look-ups) and per request by the planner (only 2+ independent parts, never quick)", async () => {
  const { assessDepth } = await import("../src/depth");
  const { planWork } = await import("../src/intake");
  const { agentTools } = await import("../src/templates");
  const { customAgent } = await import("./helpers");
  const { exec } = await import("../src/db");
  // Design time
  expect(assessDepth(["Keep the shopping list", "Run polls"]).specialists).toBe(false);                     // light: never
  expect(assessDepth(["Draft emails for my approval"]).specialists).toBe(false);                            // one kind of look-up
  expect(assessDepth(["Find restaurants for team dinners", "Check everyone's calendar availability"]).specialists).toBe(true); // two kinds
  expect(assessDepth(["Research and compare vendors"]).specialists).toBe(true);                             // deep work
  const planner = customAgent(ws, ellie, ["web-research", "calendar"], {}, "Otto");
  const lister = customAgent(ws, ellie, ["web-research", "calendar"], {}, "Lia");
  exec("update agents set spec=? where id=?", JSON.stringify({ name: "Otto", jobs: ["Plan team offsites: research venues and find dates everyone is free"], depth: assessDepth(["Plan team offsites: research venues and find dates everyone is free"]) }), planner.id);
  exec("update agents set spec=? where id=?", JSON.stringify({ name: "Lia", jobs: ["Keep the list"], depth: assessDepth(["Keep the list"]) }), lister.id);
  const reload = (a: any) => one<any>("select * from agents where id=?", a.id);
  expect(agentTools(reload(planner)).has("specialists.run")).toBe(true);
  expect(agentTools(reload(lister)).has("specialists.run")).toBe(false);                                  // same tools, light jobs: no

  // Per request (planWork validates the planner's split against the agent's depth)
  const brief = (split: any[], effort = "standard") => ({ goal: "", deliverable: "", constraints: [], assumptions: [], questions: [], side_effects: [], done_when: [], kind: "act",
    plan: [{ text: "s", tool: "web.search" }, { text: "c", tool: "calendar.find_free_time" }], effort, split }) as any;
  const two = [{ specialist: "research", objective: "venues in Austin for 12" }, { specialist: "calendar", objective: "dates the team is free next month" }];
  const otto = J(reload(planner).spec).depth, lia = J(reload(lister).spec).depth;
  expect(planWork(brief(two), "offsite", otto).split).toHaveLength(2);
  expect(planWork(brief(two), "offsite", lia).split).toBeUndefined();                                     // agent not allowed
  expect(planWork(brief(two.slice(0, 1)), "offsite", otto).split).toBeUndefined();                        // one part isn't a split
  expect(planWork({ ...brief(two, "quick"), plan: [] }, "hi", otto).split).toBeUndefined();               // quick never splits
  expect(planWork(brief([{ specialist: "hacker", objective: "x" }, ...two.slice(0, 1)]), "x", otto).split).toBeUndefined(); // unknown kinds dropped

  // End to end on a non-Ava agent: the planner's split starts both specialists before the agent's first model call
  googleConnection(ws, ellie, [planner.id]);
  const room2 = rt.privateRoomFor(ellie, reload(planner));
  const seen = scriptModel((r) => isTask(r, "research") || isTask(r, "calendar")
    ? (r.messages.length === 1 ? (isTask(r, "research") ? call("web.search", { query: "Austin venue for 12" }) : call("calendar.find_free_time", { days: 30, duration_minutes: 480 }))
      : { text: JSON.stringify({ finding: isTask(r, "research") ? "Hotel One fits 12" : "Oct 14–15 free", sources: [isTask(r, "research") ? "https://hotel.example/one" : "calendar.find_free_time"], proposed_actions: [], unresolved_questions: [] }) })
    : { text: "Hotel One (https://hotel.example/one) on Oct 14–15 works for everyone." });
  await say(room2.id, ellie, "find a venue in Austin for 12 people and check when we're all free next month");
  const parent = runsIn(room2.id).find((r: any) => !r.parent_run_id);
expect(J(parent.brief).split.map((p: any) => p.specialist)).toEqual(["research", "calendar"]);
  expect(all<any>("select json_extract(result, '$.specialist') s from runs where parent_run_id=? order by created_at", parent.id).map((r) => r.s)).toEqual(["research", "calendar"]);
  expect(seen.filter((r) => !isTask(r, "research") && !isTask(r, "calendar"))).toHaveLength(1);          // the agent answered once, from both results
  expect(lastFrom(room2.id, planner.id)).toBe("Hotel One (https://hotel.example/one) on Oct 14–15 works for everyone.");
  // ...and a single look-up doesn't split
  scriptModel(call("web.search", { query: "austin venues" }), { text: "Venue A." });
  await say(room2.id, ellie, "find a venue in Austin");
  const last = runsIn(room2.id).filter((r: any) => !r.parent_run_id).at(-1);
  expect(J(last.brief).split ?? []).toHaveLength(0);
  expect(all("select 1 from runs where parent_run_id=?", last.id)).toHaveLength(0);
});

test("AC-SPC4 a specialist that answers in plain text is kept but marked unverified; a typed answer keeps its confidence and unknowns", () => {
  expect(rt.specialistOutput("Hotel One looks good, see https://hotel.example/one")).toMatchObject({ finding: "Hotel One looks good, see https://hotel.example/one", sources: ["https://hotel.example/one"], confidence: "low", unverified: true });
  expect(rt.specialistOutput(JSON.stringify({ finding: "Room free Thu", sources: ["calendar.find_free_time"], confidence: "high", unknowns: ["Dana's calendar"] }))).toMatchObject({ confidence: "high", unknowns: ["Dana's calendar"] });
  expect(rt.specialistOutput(JSON.stringify({ finding: "Probably fine" }))).toMatchObject({ confidence: "low", sources: [] });
});
