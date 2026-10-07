// The completion gate: every request's "done when" is checkable (tools, links, items — the judge model only for substance),
// a skipped look-up is nudged but never alarms the person, a missing action is; the context window is by size with a running
// summary of older conversation; planning and checking run on the judge tier.
import { test, expect, beforeEach } from "bun:test";
import { one, all, J, exec, seedProfiles } from "../src/db";
import * as rt from "../src/runtime";
import { buildContext, foldHistory } from "../src/context";
import { claimsOf } from "../src/intake";
import { checkClaims } from "../src/gate";
import { openDefault } from "../src/billing";
import { setup, user, workspace, customAgent, installAgent, say, scriptModel, call, runsIn, lastFrom, events } from "./helpers";

let ellie: string, ws: string;
beforeEach(() => { setup(); ellie = user("Ellie"); ws = workspace("Home", ellie); });

test("AC-GT1 every request's 'done when' is checkable: a planned action that never happened is nudged once then flagged; a skipped look-up is nudged but never flagged", async () => {
  // Hard claim: the plan says task.create; the model only talks
  const a = customAgent(ws, ellie, ["task-tracking", "web-research"], {}, "Rex");
  const room = rt.privateRoomFor(ellie, a);
  const seen = scriptModel({ text: "Noted — I'll keep an eye on the BLS follow-ups." }, { text: "Noted, the BLS follow-ups are on my radar." }, { text: "Noted, the BLS follow-ups are on my radar." });
  await say(room.id, ellie, "Take care of the BLS follow-ups");
  const run = runsIn(room.id).at(-1);
  expect(J(run.brief).claims).toEqual(expect.arrayContaining([expect.objectContaining({ proof: "tool", tool: "task.create" })]));
  expect(seen.some((q) => q.messages.some((m) => /Not done yet\. Still missing: .*tracked with an owner/.test(m.content)))).toBe(true);
  expect(lastFrom(room.id, a.id)).toMatch(/⚠️ Not fully done — still missing: .*tracked with an owner/);
  expect(events("RESULT_CHECKED").map((e) => e.data.pass)).toEqual(expect.arrayContaining([false]));

  // Soft claim: the plan says search the web; the model answers with three linked options from memory
  const atlas = installAgent("atlas-research", ws, ellie);
  const room2 = rt.privateRoomFor(ellie, atlas);
  const list = "1. A https://a.example\n2. B https://b.example\n3. C https://c.example";
  const seen2 = scriptModel({ text: list }, { text: list });
  await say(room2.id, ellie, "Find three options for coworking spaces in Austin");
  const run2 = runsIn(room2.id).at(-1);
  expect(J(run2.brief).claims).toEqual(expect.arrayContaining([expect.objectContaining({ proof: "items", n: 3 }), expect.objectContaining({ proof: "tool", tool: "web.search", soft: true })]));
  expect(seen2.some((q) => q.messages.some((m) => /Not done yet\. Still missing: .*web\.search/.test(m.content)))).toBe(true); // nudged once
  expect(lastFrom(room2.id, atlas.id)).toBe(list);                                                                              // delivered clean: a look-up isn't worth alarming over
});

test("AC-GT2 claims carry their proof: planned tools, N items, links; a model-given proof must name a planned tool; answer-quality claims go to the judge", async () => {
  const b = { done_when: ["3 options with links and trade-offs", "Email to sam@example.com sent", "Answer backed by linked sources", "Sources are from this year", "Tone is friendly"],
    plan: [{ text: "s", tool: "web.search", status: "todo" }, { text: "e", tool: "email.send", status: "todo" }, { text: "m", tool: "memory.remember", status: "todo" }],
    claims: [{ text: "Sources are from this year", proof: "tool", tool: "web.search" }, { text: "Tone is friendly", proof: "tool", tool: "calendar.create_event" }] } as any;
  const claims = claimsOf(b);
  expect(claims).toEqual(expect.arrayContaining([
    { text: "3 options with links and trade-offs", proof: "items", n: 3 },
    { text: "Email to sam@example.com sent", proof: "tool", tool: "email.send" },
    { text: "Answer backed by linked sources", proof: "links", n: 1 },
    { text: "Sources are from this year", proof: "tool", tool: "web.search", soft: true },
    { text: "Tone is friendly", proof: "reply" },                                 // the model named a tool that isn't in the plan
  ]));
  expect(claims.some((c) => c.tool === "memory.remember")).toBe(false);          // bookkeeping tools are never claims
  // Evidence check is deterministic for tools/items/links
  const a = customAgent(ws, ellie, ["web-research"]);
  const room = rt.privateRoomFor(ellie, a);
  const run = rt.createRun({ room, agent: a, objective: "x" });
  const { missing } = await checkClaims(run, claims.filter((c) => c.proof !== "reply"), "1. A https://a.example\n2. B\n3. C");
  expect(missing.map((c) => c.text)).toEqual(["Email to sam@example.com sent", "Sources are from this year"]);
});

test("AC-GT3 planning and checking use the judge tier (never the cheap model); it falls back to the standard profile row when a workspace has none", () => {
  expect(openDefault("judge")).toBe("openrouter:deepseek/deepseek-v4-pro");
  expect(one<any>("select * from model_profiles where name='judge'")).toBeTruthy();
  exec("delete from model_profiles where name='judge'");                     // a database seeded before the judge tier existed
  seedProfiles();
  expect(one("select 1 from model_profiles where name='judge'")).toBeTruthy();
  expect(one<any>("select count(*) n from model_profiles").n).toBe(5);
});

test("AC-GT4 the context window is by size with a running summary of what scrolled out; old tool results are trimmed, the newest stay whole", async () => {
  const a = customAgent(ws, ellie, ["web-research"]);
  const room = rt.privateRoomFor(ellie, a);
  for (let i = 1; i <= 70; i++) rt.postMessage(room.id, { sender: ellie, text: `message ${i}: ${i === 3 ? "we decided on the Lisbon trip for May" : "x".repeat(300)}` });
  await foldHistory(room.id);
  const r = one<any>("select summary, summary_seq from rooms where id=?", room.id);
  expect(r.summary).toMatch(/message/);
  expect(r.summary.length).toBeLessThanOrEqual(1500);
  expect(r.summary_seq).toBeGreaterThan(0);
  const run = rt.createRun({ room, agent: a, objective: "what did we decide?" });
  for (let i = 1; i <= 5; i++) rt.appendToolResult(run.id, { id: `c${i}`, name: "web.search" }, `RESULT ${i} ` + "y".repeat(6000));
  const c = buildContext(run, a, room);
  const head = c.messages[0].content;
  expect(head).toMatch(/^\[EARLIER — the conversation before the messages below, summarized\]/);
  expect(head).toContain("message 70:");
  expect(head).not.toContain("message 1:");                                   // outside the 9k-character window
  expect(head.length).toBeLessThan(13_000);
  const results = c.messages.filter((m) => m.role === "tool").map((m) => m.content);
  expect(results.slice(0, 2).every((t) => /characters trimmed/.test(t) && t.length < 2600)).toBe(true);
  expect(results.slice(-3).every((t) => t.length > 6000)).toBe(true);
});
