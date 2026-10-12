// Live scenarios: the real model on OpenRouter (counted against the daily cap), real tools, and, with TEST_PHONE set,
// a real iMessage to that phone. Run on demand: bun run test:live
import { test, expect, beforeAll } from "bun:test";
import { sql, migrate, spentToday } from "../src/db";
import * as im from "../src/imessage";
import * as agent from "../src/agent";

const live = process.env.LIVE === "1" && !!process.env.OPENROUTER_API_KEY;
const sent: { space: string; text: string }[] = [];
let n = 0;
if (!process.env.TEST_PHONE) { im.hooks.send = async (space, text) => { sent.push({ space, text }); return `out_${++n}`; }; im.hooks.startDm = async (phone, text) => { sent.push({ space: `dm_${phone}`, text }); return `dm_${phone}`; }; }
const phone = process.env.TEST_PHONE ?? "+15559990001";
const say = (text: string, space = `dm_${phone}`, isGroup = false, from = phone) => agent.onInbound({ spaceId: space, isGroup, phone: from, text, externalId: `live_${Date.now()}_${++n}` });
const last = (space = `dm_${phone}`) => sent.filter((s) => s.space === space).at(-1)?.text ?? "";

beforeAll(async () => { await migrate(); for (const t of ["approvals", "tool_executions", "runs", "messages", "schedules", "memories", "links", "room_members", "rooms", "users"]) await sql.unsafe(`delete from ${t}`); });

test.skipIf(!live)("onboarding: the agent introduces itself and asks for a name", async () => {
  await say("hi");
  expect(last().length).toBeGreaterThan(20);
  await say("call yourself Pip. I'm Ellie, in New York.");
  const u = (await sql`select * from users where phone=${phone}`)[0];
  expect(u.agent_name).toBe("Pip");
}, 120_000);

test.skipIf(!live)("a lookup uses the web and claims nothing", async () => {
  await say("what's the weather in Lisbon tomorrow? one line");
  const run = (await sql`select * from runs order by created_at desc limit 1`)[0];
  expect(run.status).toBe("done");
  expect((await sql`select tool from tool_executions where run_id=${run.id}`).map((r: any) => r.tool)).toContain("web.search");
  expect(last()).not.toContain("✓");
}, 120_000);

test.skipIf(!live)("a reminder is a write: card, yes, verified footer", async () => {
  await say("remind me in 45 minutes to call mom");
  expect(last()).toContain('Reply "yes"');
  for (let i = 0; i < 3 && last().includes('Reply "yes"'); i++) await say("yes"); // a model may get the time wrong once and ask again
  expect(last()).toContain("✓ Reminder");
  expect((await sql`select count(*) n from schedules where status='active'`)[0].n).toBe("1");
}, 180_000);

test.skipIf(!live)("a group split comes back right, on the cheap tier", async () => {
  await say("Pip, the Airbnb is $1,284 for the four of us, how much each?", "grp_live", true);
  const run = (await sql`select * from runs order by created_at desc limit 1`)[0];
  expect(last("grp_live")).toMatch(/321/);
  expect(run.tier).toBe("cheap");
}, 120_000);

test.skipIf(!live)("spend stays well under the cap", async () => {
  expect(await spentToday("model")).toBeLessThan(1);
});
