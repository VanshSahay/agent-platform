// Requirement layer: brief -> clarify/confirm/auto -> execute against the brief -> verify.
import { test, expect, beforeEach } from "bun:test";
import { one, all, J, exec, advance, patchJson } from "../src/db";
import * as rt from "../src/runtime";
import { decide, heuristicBrief, sideEffects } from "../src/intake";
import { setup, user, workspace, customAgent, installAgent, googleConnection, say, scriptModel, call, net, pendingApprovals, runsIn, lastFrom, messages, channel, deliver, tg, link, events } from "./helpers";

let ellie: string, ws: string;
beforeEach(() => { setup(); ellie = user("Ellie"); ws = workspace("Personal", ellie); });
const brief = (runId: string) => J(one<any>("select brief from runs where id=?", runId).brief);

test("AC-B1 every request gets a brief; chit-chat skips it, simple actions auto-start with stated assumptions", async () => {
  const ava = installAgent("ava-executive-assistant", ws, ellie);
  const room = rt.privateRoomFor(ellie, ava);
  await say(room.id, ellie, "thanks!");
  expect(runsIn(room.id)[0].brief_status).toBe("skipped");
  const seen = scriptModel(call("web.search", { query: "x" }), { text: "1. A https://a.example\n2. B https://b.example\n3. C https://c.example" });
  await say(room.id, ellie, "Find three options for a dentist near me under $200");
  const run = runsIn(room.id).at(-1);
  expect(run.brief_status).toBe("auto");
  expect(brief(run.id)).toMatchObject({ kind: "act", constraints: ["Under $200"], done_when: ["3 options with links and trade-offs"] });
  expect(seen[0].system).toContain("[TASK_BRIEF v1");
  expect(seen[0].system).toContain("Done when: 3 options with links and trade-offs");
  expect(messages(room.id).filter((m) => m.brief)).toHaveLength(0); // no card for auto
});

test("AC-B2 missing essentials trigger one batched question; nothing runs until it's answered", async () => {
  const ava = installAgent("ava-executive-assistant", ws, ellie);
  googleConnection(ws, ellie, [ava.id]);
  patchJson("agents", "permissions", ava.id, (p) => ({ ...p, "contacts.search": "never" })); // no lookup -> must ask
  const room = rt.privateRoomFor(ellie, ava);
  await say(room.id, ellie, "Email Sam about moving our dinner to Friday");
  const run = runsIn(room.id)[0];
  expect(run.brief_status).toBe("clarifying");
  expect(lastFrom(room.id, ava.id)).toMatch(/Before I start[\s\S]*What's Sam's email address\?/);
  expect(all("select * from events where type='TOOL_CALL_REQUESTED'")).toHaveLength(0);
  await say(room.id, ellie, "sam@example.com");
  expect(runsIn(room.id)).toHaveLength(1); // the answer continues the same task
  expect(pendingApprovals(room.id)[0].summary).toMatch(/Send email to sam@example.com/);
});

test("AC-B3 multi-step tasks show the plan and wait for 'go'; 'cancel' drops it", async () => {
  const rec = customAgent(ws, ellie, ["delegation", "reminders", "task-tracking"], {}, "Recruiter");
  customAgent(ws, ellie, ["web-research"], {}, "Credentialing");
  const room = rt.privateRoomFor(ellie, rec);
  await say(room.id, ellie, "Ask Credentialing to check Chris's BLS status and remind me to call him in 2 hours");
  const run = runsIn(room.id)[0];
  expect(run.brief_status).toBe("proposed");
  const card = messages(room.id).find((m) => m.brief);
  expect(card.buttons.map((b: any) => b.label)).toEqual(["Go", "Cancel"]);
  expect(card.text).toMatch(/Plan:\n1\. Ask Credentialing to check Chris's BLS status[\s\S]*Schedule a reminder/);
  expect(all("select * from runs where parent_run_id is not null")).toHaveLength(0);
  await say(room.id, ellie, "go");
  expect(one<any>("select brief_status from runs where id=?", run.id).brief_status).toBe("confirmed");
  expect(all("select * from runs where parent_run_id is not null")).toHaveLength(1);

  await say(room.id, ellie, "Ask Credentialing to audit everyone and remind me in 3 hours");
  const r2 = runsIn(room.id).filter((r) => r.objective.includes("audit everyone"))[0];
  await say(room.id, ellie, "cancel");
  expect(one<any>("select status from runs where id=?", r2.id).status).toBe("cancelled");
  expect(lastFrom(room.id, rec.id)).toMatch(/dropped/);
});

test("AC-B4 a mid-flight change re-briefs with a diff, drops stale approvals, and only the new action happens", async () => {
  const ava = installAgent("ava-executive-assistant", ws, ellie);
  googleConnection(ws, ellie, [ava.id]);
  const room = rt.privateRoomFor(ellie, ava);
  await say(room.id, ellie, "Email sam@example.com about the trip dates");
  const old = pendingApprovals(room.id)[0];
  await say(room.id, ellie, "actually send it to dana@example.com instead");
  expect(one<any>("select status from approvals where id=?", old.id).status).toBe("expired");
  expect(runsIn(room.id)).toHaveLength(1);
  const card = messages(room.id).filter((m) => m.brief).at(-1);
  expect(card.text).toMatch(/^Updated plan \(\+ Send email to dana@example.com: "the trip dates"; − Send email to sam@example.com: "the trip dates"\)/);
  await say(room.id, ellie, "go");
  await say(room.id, ellie, "approve");
  const sent = net.to(/messages\/send/);
  expect(sent).toHaveLength(1);
  expect(Buffer.from(sent[0].body.raw, "base64url").toString()).toContain("To: dana@example.com");
  expect(events("BRIEF_REVISED")).toHaveLength(1);
});

test("AC-B5 results are checked against 'done when' before reporting; gaps are retried or disclosed", async () => {
  const atlas = installAgent("atlas-research", ws, ellie);
  const room = rt.privateRoomFor(ellie, atlas);
  scriptModel(call("web.search", { query: "q" }), { text: "1. Only one https://a.example" }, { text: "1. A https://a.example\n2. B https://b.example\n3. C https://c.example" });
  await say(room.id, ellie, "Find three options for coworking spaces in Austin");
  expect(events("RESULT_CHECKED").map((e) => e.data.pass)).toEqual([false, true]);
  expect(lastFrom(room.id, atlas.id)).toMatch(/3\. C/);

  scriptModel(call("web.search", { query: "q" }), { text: "1. Only one https://a.example" });
  await say(room.id, ellie, "Find four options for climbing gyms in Austin");
  expect(lastFrom(room.id, atlas.id)).toMatch(/⚠️ Not fully done — still missing: 4 options/);
});

test("AC-B6 plan steps tick off as tools succeed; plan.update re-plans; long waits post one progress note", async () => {
  const rec = customAgent(ws, ellie, ["follow-up-tracking", "delegation"], { }, "Relay");
  exec("update agents set confirm_mode='never' where id=?", rec.id);
  const room = rt.privateRoomFor(ellie, rec);
  scriptModel(call("task.create", { title: "Chris BLS" }), call("plan.update", { replace_remaining: ["Wait for Chris", "Report back"] }),
    call("wait.for_reply", { from_email: "chris@x.test" }), { text: "waiting" });
  await say(room.id, ellie, "Take care of the follow-up with Chris and wait for chris@x.test to reply");
  const run = runsIn(room.id)[0];
  const b = brief(run.id);
  expect(b.plan.some((p: any) => p.status === "done" && p.tool === "task.create")).toBe(true);
  expect(b.plan.slice(-2).map((p: any) => p.text)).toEqual(["Wait for Chris", "Report back"]);
  expect(lastFrom(room.id, rec.id)).toMatch(/^⏳ .* steps done\. Waiting for chris@x.test; I'll pick this up when it arrives\.$/);
});

test("AC-B7 brief cards work from channel buttons, scoped to their room", async () => {
  const rec = customAgent(ws, ellie, ["delegation", "reminders"], {}, "Recruiter");
  customAgent(ws, ellie, ["web-research"], {}, "Credentialing");
  const t = channel(rec.id, "telegram");
  link("telegram", "9", ellie);
  await deliver("telegram", t.id, tg(9, 9, "Ellie", "Ask Credentialing to check BLS and remind me in 2 hours"));
  const out = net.to(/sendMessage/).at(-1)!.body;
  expect(out.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["Go", "Cancel"]);
  await deliver("telegram", t.id, { update_id: 500, callback_query: { id: "c", data: out.reply_markup.inline_keyboard[0][0].callback_data, from: { id: 9, first_name: "Ellie" }, message: { chat: { id: 9, type: "private" } } } });
  expect(all<any>("select brief_status from runs where parent_run_id is null")[0].brief_status).toBe("confirmed");
});

test("AC-B8 per-agent confirmation mode (always / never) and the deterministic policy", () => {
  const b = { ...heuristicBrief("Search for the best pizza", { tools: ["web.search"], agents: [], agentName: "A", memories: [] }), version: 1 };
  expect(decide(b, { mode: "smart", revised: false })).toBe("auto");
  expect(decide(b, { mode: "always", revised: false })).toBe("confirm");
  const q = { ...b, questions: [{ q: "Which city?" }] };
  expect(decide(q, { mode: "smart", revised: false })).toBe("clarify");
  expect(decide(q, { mode: "never", revised: false })).toBe("auto");
  const two = { ...b, side_effects: ["send", "book"] };
  expect(decide(two, { mode: "smart", revised: false })).toBe("confirm");
  expect(decide({ ...b, side_effects: ["send"] }, { mode: "smart", revised: false })).toBe("auto"); // approval card covers a single write
  expect(decide({ ...b, side_effects: ["send"] }, { mode: "smart", revised: true })).toBe("confirm");
});

test("AC-B9 unanswered questions expire after 72h instead of guessing", async () => {
  const ava = installAgent("ava-executive-assistant", ws, ellie);
  const room = rt.privateRoomFor(ellie, ava);
  await say(room.id, ellie, "Email Sam about Friday");
  advance(73 * 3600e3); await rt.drain();
  expect(runsIn(room.id)[0].status).toBe("cancelled");
  expect(lastFrom(room.id, ava.id)).toMatch(/didn't hear back/);
});

test("AC-K1 repeated successful work is offered as a reusable skill once, and saved skills guide future runs", async () => {
  const atlas = installAgent("atlas-research", ws, ellie);
  const room = rt.privateRoomFor(ellie, atlas);
  for (const topic of ["solar", "batteries", "hydrogen"]) await say(room.id, ellie, `Search for the latest news on ${topic}`);
  const offer = messages(room.id).filter((m) => m.buttons?.some((b: any) => b.data.startsWith("skl:")));
  expect(offer).toHaveLength(1);
  const { pressButton } = await import("../src/channels");
  expect(await pressButton(offer[0].buttons[0].data, ellie, room.id, null)).toEqual({ ok: true });
  expect(all("select * from custom_skills")).toHaveLength(1);
  await say(room.id, ellie, "Search for the latest news on wind");
  expect(messages(room.id).filter((m) => m.buttons?.some((b: any) => b.data.startsWith("skl:")))).toHaveLength(1); // not offered again
  const seen = scriptModel({ text: "ok" });
  await say(room.id, ellie, "Search for the latest news on fusion");
  expect(seen[0].system).toContain("[LEARNED_PROCEDURES");
  expect(await pressButton(offer[0].buttons[0].data, ellie, rt.privateRoomFor(user("Other"), atlas).id, null)).toHaveProperty("error"); // room-scoped
});

test("AC-B10 internal-only work (to-dos, reminders, lists) just runs; outside work and other people still get a plan; the agent knows today's date", async () => {
  // The brief model calls a to-do and a reminder "side effects"; the planned tools say otherwise.
  expect(sideEffects(["task.create", "reminder.schedule"], ["Adding a task", "Sending a notification"])).toEqual([]);
  expect(sideEffects(["email.send", "calendar.create_event"], ["Email Sam", "Add event"])).toHaveLength(2);
  const b = (plan: string[], side_effects: string[] = []) => ({ kind: "task", questions: [], side_effects, plan: plan.map((tool) => ({ text: tool, tool, status: "todo" })) } as any);
  expect(decide(b(["task.create", "reminder.schedule", "list.add"]), { mode: "smart", revised: false })).toBe("auto");
  expect(decide(b(["agent.delegate", "reminder.schedule"]), { mode: "smart", revised: false })).toBe("confirm");
  expect(decide(b(["email.send", "calendar.create_event"], ["Email Sam", "Add event"]), { mode: "smart", revised: false })).toBe("confirm");
  const ava = installAgent("ava-executive-assistant", ws, ellie);
  const seen = scriptModel({ text: "ok" });
  await say(rt.privateRoomFor(ellie, ava).id, ellie, "what day is it?");
  expect(seen[0].system).toMatch(/\[CLOCK\]\nNow: \w+day, \w+ \d+, \d{4}/);
});
