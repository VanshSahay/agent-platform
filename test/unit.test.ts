// Model-free logic on a real local Postgres (agent_test): dedupe, approvals, consent, holds, scopes, routing, the claims guard.
import { test, expect, beforeAll, beforeEach } from "bun:test";
import { sql, migrate } from "../src/db";
import * as im from "../src/imessage";
import * as model from "../src/model";
import * as agent from "../src/agent";
import * as rooms from "../src/rooms";
import { remember, retrieve } from "../src/memory";
import { fingerprint, def, obj, TOOLS, prune } from "../src/tools/index";
import { createSchedule } from "../src/schedules";
import { linkPhoneStart, linkPhoneVerify } from "../src/web";
import { createAgent, defaultAgentOf, agentsOf } from "../src/agents";
import { seal } from "../src/db";

const sent: { space: string; text: string }[] = [];
let n = 0;
im.hooks.send = async (space, text) => { sent.push({ space, text }); return `out_${++n}`; };
im.hooks.startDm = async (phone, text) => { const space = `dm_${phone}`; sent.push({ space, text }); return space; };
const lastTo = (space: string) => sent.filter((s) => s.space === space).at(-1)?.text ?? "";

/** A scripted model: tool call first, then a text reply once a tool result is in the transcript. */
const script = (call: model.ToolCall | null, reply: string) => { model.hooks.generate = async (req) => (call && !req.messages.some((m) => m.role === "tool") ? { text: "", toolCalls: [{ ...call, id: `c${++n}` }], model: `fake-${req.tier}`, costUsd: 0.001 } : { text: reply, toolCalls: [], model: `fake-${req.tier}`, costUsd: 0.001 }); };
const say = (phone: string, text: string, space = `dm_${phone}`, isGroup = false) => agent.onInbound({ spaceId: space, isGroup, phone, text, externalId: `in_${++n}` });
/** Most tests talk to a deployed (trained) agent: its owner is a web account. */
const trained = async (phone: string, name = "Pip") => { const u = await rooms.userByPhone(phone); await sql`update users set clerk_id=${"clerk_" + phone} where id=${u.id}`; const a = await defaultAgentOf(u); await sql`update agents set name=${name} where id=${a.id}`; return rooms.userById(u.id); };

beforeAll(async () => { await migrate(); });
beforeEach(async () => {
  for (const t of ["approvals", "tool_executions", "runs", "messages", "schedules", "memories", "links", "connections", "room_members", "rooms", "agents", "users", "usage"]) await sql.unsafe(`delete from ${t}`);
  sent.length = 0; script(null, "ok");
});

test("a duplicate inbound message is stored once and answered once", async () => {
  script(null, "Hi there.");
  await trained("+15550000001");
  await agent.onInbound({ spaceId: "dm_+15550000001", isGroup: false, phone: "+15550000001", text: "hello", externalId: "same" });
  await agent.onInbound({ spaceId: "dm_+15550000001", isGroup: false, phone: "+15550000001", text: "hello", externalId: "same" });
  expect((await sql`select count(*) n from messages where direction='in'`)[0].n).toBe("1");
  expect(sent.filter((s) => s.text === "Hi there.").length).toBe(1);
});

test("a write waits for yes, runs on the smart tier, and the reply footer shows the verified action", async () => {
  script({ id: "", name: "reminder.schedule", input: { text: "stretch", in_minutes: 30 } }, "Set.");
  await trained("+15550000002");
  await say("+15550000002", "remind me in 30 min to stretch");
  const run = (await sql`select * from runs`)[0];
  expect(run.status).toBe("waiting_approval");
  expect(run.tier).toBe("smart");
  expect(lastTo("dm_+15550000002")).toContain('Reply "yes"');
  await say("+15550000002", "yes");
  const done = (await sql`select * from runs`)[0];
  expect(done.status).toBe("done");
  expect(lastTo("dm_+15550000002")).toContain("✓ Reminder");
  expect((await sql`select verified from tool_executions`)[0].verified).toBe(true);
  expect((await sql`select count(*) n from schedules where status='active'`)[0].n).toBe("1");
});

test("no skips the write and nothing is scheduled", async () => {
  script({ id: "", name: "reminder.schedule", input: { text: "stretch", in_minutes: 30 } }, "Skipped it.");
  await trained("+15550000003");
  await say("+15550000003", "remind me in 30 min to stretch");
  await say("+15550000003", "no");
  expect((await sql`select count(*) n from schedules`)[0].n).toBe("0");
  expect(lastTo("dm_+15550000003")).toBe("Skipped it.");
});

test("a 👍 tapback on the card approves it", async () => {
  script({ id: "", name: "reminder.schedule", input: { text: "water", in_minutes: 5 } }, "Done.");
  await trained("+15550000004");
  await say("+15550000004", "remind me to water in 5");
  const card = (await sql`select out_message_id from approvals`)[0].out_message_id;
  await agent.onInbound({ spaceId: "dm_+15550000004", isGroup: false, phone: "+15550000004", text: "", externalId: `r${++n}`, reaction: { emoji: "👍", targetId: card } });
  expect((await sql`select status from approvals`)[0].status).toBe("approved");
  expect((await sql`select status from runs`)[0].status).toBe("done");
});

test("in a group the agent stays quiet unless named", async () => {
  await trained("+15550000010");
  await trained("+15550000010", "Pip");
  script(null, "Here!");
  await say("+15550000010", "anyone up for dinner?", "grp1", true);
  expect(sent.length).toBe(0);
  await say("+15550000011", "Pip, find a place", "grp1", true);
  expect(lastTo("grp1")).toBe("Here!");
});

test("an account tool without a connection is denied with a personal connect link", async () => {
  script({ id: "", name: "calendar.list_events", input: { from: "today" } }, "You'll need to connect Google first.");
  await trained("+15550000019");
  await say("+15550000019", "what's on my calendar");
  const tool = (await sql`select content from (select transcript from runs) r, jsonb_to_recordset(r.transcript) as x(role text, content text) where role='tool'`)[0];
  expect(tool.content).toContain("DENIED");
  expect(tool.content).toContain("/connect/google?t=");
});

test("a member's accounts in a group need their consent once, asked in their DM", async () => {
  def({ id: "fake.account", kind: "read", connection: "google", description: "test", inputSchema: obj({}), async execute() { return { status: "SUCCEEDED", output: { ok: true } }; } });
  await trained("+15550000020");
  await rooms.userByPhone("+15550000020");
  const member = await trained("+15550000021"); // first to speak in grp2, so its owner; a web account
  await sql`insert into connections (id, user_id, provider, cred_enc, created_at) values ('con_test', ${member.id}, 'google', ${seal({ access_token: "x" })}, 0)`;
  script({ id: "", name: "fake.account", input: {} }, "Nothing today.");
  await say("+15550000021", "Pip, what's on my calendar", "grp2", true);
  expect((await sql`select status from runs`)[0].status).toBe("waiting_consent");
  expect(lastTo("dm_+15550000021")).toContain("OK to use your accounts");
  await say("+15550000021", "yes");
  expect((await sql`select consent_at from room_members where user_id=${member.id} and room_id=(select id from rooms where space_id='grp2')`)[0].consent_at).not.toBeNull();
  expect((await sql`select status, verified from tool_executions`)[0]).toMatchObject({ status: "succeeded", verified: true });
  expect(lastTo("grp2")).toBe("Nothing today.");
  // The second time in the same group there is no question.
  script({ id: "", name: "fake.account", input: { again: true } }, "Still nothing.");
  await say("+15550000021", "Pip, check again", "grp2", true);
  expect(lastTo("grp2")).toBe("Still nothing.");
  delete TOOLS["fake.account"];
});

test("an agent's training follows it into its rooms; another agent's never shows; a room's stays there", async () => {
  const u = await trained("+15550000030", "Carl");
  const carl = await defaultAgentOf(u), max = await createAgent(u, "Max");
  const dm = await rooms.roomForSpace("dm_x", false, u), grp = await rooms.roomForSpace("grp3", true, u);
  await remember("agent", carl.id, "Order groceries on Tuesdays", u.id, "store");
  await remember("agent", max.id, "The ski cabin sleeps six", u.id, "fact");
  await remember("room", grp.id, "The trip is the weekend of Nov 7", u.id);
  expect((await retrieve(dm, "groceries")).map((m) => m.text)).toContain("Order groceries on Tuesdays");
  expect((await retrieve(grp, "groceries")).map((m) => m.text)).toContain("Order groceries on Tuesdays"); // Carl is this group's agent too
  expect((await retrieve(grp, "cabin")).map((m) => m.text)).not.toContain("The ski cabin sleeps six");
  expect((await retrieve(dm, "trip")).map((m) => m.text)).not.toContain("The trip is the weekend of Nov 7");
});

test("'@Max' from the owner switches the room to that agent, with its own memory", async () => {
  const u = await trained("+15550000031", "Carl");
  const max = await createAgent(u, "Max");
  await remember("agent", max.id, "The ski cabin sleeps six", u.id, "fact");
  model.hooks.generate = async (req) => ({ text: req.messages[1].content.includes("sleeps six") ? "Six beds." : "No idea.", toolCalls: [], model: "fake", costUsd: 0 });
  await say("+15550000031", "how many beds at the cabin?");
  expect(lastTo("dm_+15550000031")).toBe("No idea.");
  await say("+15550000031", "@Max how many beds at the cabin?");
  expect(lastTo("dm_+15550000031")).toBe("Six beds.");
  expect((await sql`select agent_id from rooms where space_id='dm_+15550000031'`)[0].agent_id).toBe(max.id);
});

test("a reply that claims an action without a verified write gets corrected", async () => {
  script(null, "Sent it to Dana!");
  await trained("+15550000040");
  await say("+15550000040", "email dana");
  expect(lastTo("dm_+15550000040")).toContain("nothing has actually been sent");
});

test("a reply pending when someone new joins a group is held and offered in the requester's DM", async () => {
  await trained("+15550000050");
  await trained("+15550000050", "Pip");
  await say("+15550000050", "hi all", "grp5", true); // the room now has history
  model.hooks.generate = async () => { await say("+15550000059", "hey, new here", "grp5", true); return { text: "Dinner is at 7.", toolCalls: [], model: "fake", costUsd: 0 }; };
  await say("+15550000050", "Pip when is dinner", "grp5", true);
  expect((await sql`select status from runs where request like 'Pip when%'`)[0].status).toBe("held");
  expect(lastTo("dm_+15550000050")).toContain('Say "go"');
  await say("+15550000050", "go");
  expect(lastTo("grp5")).toBe("Dinner is at 7.");
});

test("a correction starts on the smart tier; a lookup stays cheap", async () => {
  script(null, "ok");
  await trained("+15550000060");
  await say("+15550000060", "what's the weather tomorrow");
  await say("+15550000060", "no, I meant Thursday");
  const tiers = (await sql`select request, tier from runs order by created_at`).map((r: any) => r.tier);
  expect(tiers).toEqual(["cheap", "smart"]);
});

test("the daily cap stops the model and the agent says so", async () => {
  model.hooks.generate = null;
  process.env.MODEL_CAP_USD = "0"; process.env.OPENROUTER_API_KEY ||= "x";
  await trained("+15550000070");
  await say("+15550000070", "hello");
  expect(lastTo("dm_+15550000070")).toContain("today's budget");
  delete process.env.MODEL_CAP_USD;
});

test("empty optional fields a model fills in are dropped, and a concrete time beats a stray 'every'", async () => {
  expect(prune({ text: "x", at: "", days: [], every: "daily", in_minutes: 45 })).toEqual({ text: "x", every: "daily", in_minutes: 45 });
  const u = await trained("+15550000080"), room = await rooms.roomForSpace("dm_s", false, u);
  const s = await createSchedule({ roomId: room.id, userId: u.id, text: "call mom", kind: "message", when: { every: "daily", in_minutes: 45 }, tz: "America/New_York" });
  expect(s.spec.at).toBeGreaterThan(Date.now() + 44 * 60_000);
  expect(s.spec.every).toBeUndefined();
});

test("a web account links to the phone's person with a texted code, keeping the phone's history", async () => {
  const phoneUser = await rooms.userByPhone("+15550000090");
  await sql`update agents set name='Pip' where id=${(await defaultAgentOf(phoneUser)).id}`;
  await sql`insert into users (id, email, name, clerk_id, created_at) values ('usr_web', 'e@x.com', 'Ellie', 'clerk_1', 0)`;
  let web = (await sql`select * from users where id='usr_web'`)[0];
  const pip = await createAgent(web, "Pip"); web = (await sql`select * from users where id='usr_web'`)[0];
  await expect(linkPhoneStart(web, "+1 (555) 000-0090")).rejects.toThrow(/train Pip first/);
  for (const t of ["Likes pasta", "Shops on Tuesdays", "Two kids"]) await remember("agent", pip.id, t, web.id, "preference");
  await linkPhoneStart(web, "+1 (555) 000-0090");
  const texted = lastTo("dm_+15550000090");
  const code = texted.match(/\b(\d{6})\b/)![1];
  expect(texted).toContain("sign-in code");
  await expect(linkPhoneVerify(web, "000000")).rejects.toThrow(/wrong or expired/);
  const merged = await linkPhoneVerify(web, code);
  expect(merged.id).toBe(phoneUser.id);
  expect(merged.clerk_id).toBe("clerk_1");
  expect((await defaultAgentOf(merged)).name).toBe("Pip");
  expect(await sql`select 1 from users where id='usr_web'`).toHaveLength(0);
});

test("training in the web chat: no phone, replies are stored, memories carry a kind and reach iMessage later", async () => {
  await sql`insert into users (id, email, name, clerk_id, created_at) values ('usr_w2', 'w@x.com', 'Ellie', 'clerk_2', 0)`;
  let web = (await sql`select * from users where id='usr_w2'`)[0];
  const carl = await createAgent(web, "Carl"); web = (await sql`select * from users where id='usr_w2'`)[0];
  const room = await rooms.webRoomOf(web, carl);
  script({ id: "", name: "remember", input: { text: "Uber Eats members get 30% off every Tuesday; groceries are ordered on Tuesdays", kind: "store" } }, "Noted: Tuesdays it is.");
  await agent.handleMessage(room, web, "we always shop on Tuesdays because Uber Eats gives members 30% off");
  expect(sent.length).toBe(0); // nothing goes over the iMessage line
  const out = (await sql`select text from messages where room_id=${room.id} and direction='out'`)[0];
  expect(out.text).toBe("Noted: Tuesdays it is.");
  expect((await sql`select kind, scope_type, scope_id from memories`)[0]).toMatchObject({ kind: "store", scope_type: "agent", scope_id: carl.id });
  // Deploy to iMessage once trained: the phone's row takes over the agent and its memories.
  for (const t of ["Kids like noodles", "Busy Thursdays"]) await remember("agent", carl.id, t, web.id, "fact");
  await linkPhoneStart(web, "+15550000091");
  const code = lastTo("dm_+15550000091").match(/\b(\d{6})\b/)![1];
  const merged = await linkPhoneVerify(web, code);
  expect((await agentsOf(merged.id)).map((a: any) => a.name)).toContain("Carl");
  expect((await sql`select count(*) n from memories where scope_type='agent' and scope_id=${carl.id}`)[0].n).toBe("3");
  expect(await rooms.webRoomOf(merged, carl)).toMatchObject({ owner_id: merged.id });
});

test("a text from a number that isn't a trained account gets one pointer, not a conversation", async () => {
  script(null, "should not be called");
  await say("+15550000099", "hello?");
  expect(lastTo("dm_+15550000099")).toContain("Train yours first");
  await say("+15550000099", "hello??");
  expect(sent.filter((s) => s.space === "dm_+15550000099").length).toBe(1);
  expect((await sql`select count(*) n from runs`)[0].n).toBe("0");
});

test("the trust list lets a write run without a card", async () => {
  await trained("+15550000095");
  const u = await trained("+15550000095");
  await sql`update agents set auto_tools='["reminder.schedule"]'::jsonb where id=${(await defaultAgentOf(u)).id}`;
  script({ id: "", name: "reminder.schedule", input: { text: "water", in_minutes: 5 } }, "Set.");
  await say("+15550000095", "remind me to water in 5");
  expect((await sql`select count(*) n from approvals`)[0].n).toBe("0");
  expect(lastTo("dm_+15550000095")).toContain("✓ Reminder");
});

test("fingerprints ignore key order", () => {
  expect(fingerprint("r", "t", { a: 1, b: [1, 2] })).toBe(fingerprint("r", "t", { b: [1, 2], a: 1 }));
  expect(fingerprint("r", "t", { a: 1 })).not.toBe(fingerprint("r", "t", { a: 2 }));
});
