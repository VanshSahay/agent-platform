// Group-chat packs (polls, expenses, lists) end to end through the offline planner, plus the first-party agent catalog.
import { test, expect, beforeEach } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { all, one, advance } from "../src/db";
import * as rt from "../src/runtime";
import { ledger } from "../src/groupkit";
import { validateManifest, draftAgent, type Manifest } from "../src/templates";
import { setup, user, workspace, installAgent, say, lastFrom, runsIn } from "./helpers";

beforeEach(setup);

function group(slug: string) {
  const ellie = user("Ellie"), maria = user("Maria"), sam = user("Sam");
  const ws = workspace("Friends", ellie, [[maria], [sam]]);
  const agent = installAgent(slug, ws, ellie);
  const room = rt.createRoom({ workspace_id: ws, name: "Group", members: [
    { id: ellie, kind: "human" }, { id: maria, kind: "human" }, { id: sam, kind: "human" }, { id: agent.id, kind: "agent" }] });
  return { ellie, maria, sam, agent, room, last: () => lastFrom(room.id, agent.id) };
}

test("AC-G1 polls: numbered options, untagged votes from each person, re-votes replace, creator/admin-only close", async () => {
  const { ellie, maria, sam, room, last } = group("plans-party-planner");
  await say(room.id, maria, "@Plans poll: Friday or Saturday for the party?");
  expect(last()).toMatch(/📊 Friday or Saturday for the party\?\n1\. Friday\n2\. Saturday\nReply with a number/);
  await say(room.id, ellie, "2");
  expect(last()).toMatch(/✓ Ellie: Saturday/);
  await say(room.id, sam, "friday!");
  expect(last()).toMatch(/✓ Sam: Friday/);
  await say(room.id, ellie, "I vote 1"); // changes her vote
  const quiet = runsIn(room.id).length;
  await say(room.id, sam, "lol can't wait"); // chatter isn't a vote: nobody answers
  expect(runsIn(room.id)).toHaveLength(quiet);
  await say(room.id, sam, "@Plans results");
  expect(last()).toMatch(/1\. Friday — 2 \((Sam, Ellie|Ellie, Sam)\)\n2\. Saturday\n2 voted · leading: Friday/);
  expect(one<any>("select count(*) n from poll_votes").n).toBe(2);
  await say(room.id, sam, "@Plans close the poll");
  expect(last()).toMatch(/only Maria \(who started the poll\) can close it/);
  await say(room.id, maria, "@Plans close the poll");
  expect(last()).toMatch(/🔒 Poll closed: Friday or Saturday[\s\S]*Winner: Friday/);
  const after = runsIn(room.id).length;
  await say(room.id, sam, "2"); // no open poll: just a message
  expect(runsIn(room.id)).toHaveLength(after);
  expect(all("select * from runs where status='failed_terminal'")).toHaveLength(0);
});

test("AC-G1 RSVPs in plain words; a poll closes itself at its deadline and announces the result", async () => {
  const { ellie, maria, sam, room, last } = group("plans-party-planner");
  await say(room.id, ellie, "@Plans who's coming to the BBQ on Saturday? RSVP, closes tomorrow 6pm");
  expect(last()).toMatch(/📊 Who's coming to the BBQ on Saturday\?\n1\. Yes\n2\. No\n3\. Maybe\nVoting closes/);
  await say(room.id, sam, "I'm in");
  expect(last()).toMatch(/✓ Sam: Yes/);
  await say(room.id, maria, "can't make it");
  expect(last()).toMatch(/✓ Maria: No/);
  await say(room.id, ellie, "yes");
  advance(2 * 864e5); await rt.drain();
  expect(last()).toMatch(/🔒 Poll closed[\s\S]*1\. Yes — 2 \((Sam, Ellie|Ellie, Sam)\)\n2\. No — 1 \(Maria\)[\s\S]*Winner: Yes/);
  expect(one<any>("select status from polls").status).toBe("closed");
});

test("AC-G2 expense splitting: cent-exact 3-way splits, fewest transfers, paybacks, never outsiders", async () => {
  const { ellie, maria, sam, room, last } = group("tab-split-expenses");
  await say(room.id, ellie, "@Tab I paid $100 for dinner");
  expect(last()).toMatch(/💸 Ellie paid \$100 for dinner — split 3 ways \(Ellie \$33\.34, (Maria|Sam) \$33\.33, (Maria|Sam) \$33\.33\)\./);
  await say(room.id, sam, "@Tab Maria paid $45.50 for gas, split with me");
  expect(last()).toMatch(/Maria paid \$45\.50 for gas — split 2 ways \(\$22\.75 each: Maria, Sam\)/);
  expect([...ledger(room.id).values()].reduce((s, c) => s + c, 0)).toBe(0); // nobody gains or loses a cent
  await say(room.id, maria, "@Tab who owes what?");
  expect(last()).toMatch(/Ellie is owed \$66\.66[\s\S]*To settle up:\n• Sam pays Ellie \$56\.08\n• Maria pays Ellie \$10\.58$/);
  await say(room.id, sam, "@Tab I paid Ellie back $56.08");
  expect(last()).toMatch(/✓ Recorded: Sam paid Ellie \$56\.08\.\nTo settle up:\n• Maria pays Ellie \$10\.58$/);
  await say(room.id, maria, "@Tab settled up with Ellie"); // amount defaults to what she owes
  expect(last()).toMatch(/Maria paid Ellie \$10\.58\.\nAll settled up ✅/);
  await say(room.id, ellie, "@Tab I paid $30 for snacks split with Bob");
  expect(last()).toMatch(/I don't see Bob in this chat/);
  await say(room.id, ellie, "@Tab I paid $20 for tickets split between Maria and Sam"); // payer not included
  await say(room.id, sam, "@Tab balances");
  expect(last()).toMatch(/Maria pays Ellie \$10\n• Sam pays Ellie \$10|Sam pays Ellie \$10\n• Maria pays Ellie \$10/);
  expect(all("select * from expenses")).toHaveLength(3);
});

test("AC-G3 shared lists: add with dedupe, check off, show, clear", async () => {
  const { ellie, maria, sam, room, last } = group("roomie-household");
  await say(room.id, ellie, "@Roomie add milk, eggs and bread to the grocery list");
  expect(last()).toMatch(/Added milk, eggs, bread\. The grocery list has 3 items/);
  await say(room.id, maria, "@Roomie add eggs and coffee to the grocery list");
  expect(last()).toMatch(/Added coffee \(already on it: eggs\)\. The grocery list has 4 items/);
  await say(room.id, sam, "@Roomie got the eggs");
  expect(last()).toMatch(/✓ Checked off eggs\. Still need: milk, bread, coffee/);
  await say(room.id, sam, "@Roomie what's on the grocery list?");
  expect(last()).toBe("📝 The grocery list:\n• milk\n• bread\n• coffee\n✓ eggs");
  await say(room.id, ellie, "@Roomie add sunscreen to the packing list");
  await say(room.id, maria, "@Roomie bought milk and bread");
  expect(last()).toMatch(/Checked off milk, bread\. Still need: coffee/);
  await say(room.id, maria, "@Roomie clear the checked items");
  expect(last()).toMatch(/🧹 Cleared 3 checked-off items/);
  await say(room.id, sam, "@Roomie clear the packing list");
  expect(last()).toMatch(/Cleared 1 item\. The packing list is empty/);
  await say(room.id, sam, "@Roomie what's on the list?");
  expect(last()).toBe("📝 The grocery list:\n• coffee\n\nThe packing list is empty.");
});

const manifests = readdirSync("agents").map((f) => JSON.parse(readFileSync(`agents/${f}`, "utf8")) as Manifest);
const ORIGINAL = ["ava-executive-assistant", "reese-reservations", "scout-travel", "atlas-research", "pool-group-buying", "relay-ops", "recruiter-healthcare"];

test("AC-G4 the catalog: every manifest is valid, categorized and has an emoji avatar", () => {
  expect(manifests.length).toBe(24);
  for (const m of manifests) {
    expect({ slug: m.slug, errors: validateManifest(m) }).toEqual({ slug: m.slug, errors: [] });
    expect(["personal", "group", "team"]).toContain(m.category!);
    expect(m.avatar).toMatch(/^\p{Extended_Pictographic}️?$/u);
    expect(m.starters!.length).toBeGreaterThanOrEqual(3);
  }
});

test("AC-G4 each new agent's starters do real work on the offline model", async () => {
  for (const m of manifests.filter((x) => !ORIGINAL.includes(x.slug))) for (const s of m.starters!) {
    setup();
    const g = group(m.slug);
    const room = m.category === "group" ? g.room : rt.privateRoomFor(g.ellie, g.agent);
    await say(room.id, g.ellie, m.category === "group" ? `@${m.name} ${s}` : s);
    const tools = all<any>("select json_extract(data, '$.tool') t from events where room_id=? and type='TOOL_CALL_REQUESTED'", room.id).map((r) => r.t);
    const reply = lastFrom(room.id, g.agent.id) ?? "";
    // Real work, or (no account connected in this sandbox) an honest "connect it here" — never a made-up answer.
    const worked = (tools.length > 0 && !!reply && !/FAILED/.test(reply)) || /Connect it here/.test(reply);
    expect({ agent: m.name, starter: s, worked }).toEqual({ agent: m.name, starter: s, worked: true });
    expect(all("select * from runs where status='failed_terminal'")).toHaveLength(0);
  }
}, 30_000); // 39 conversations end to end: give Postgres room beyond the 5s default

test("AC-G4 describing an idea in plain words drafts the matching agent", async () => {
  const cases: [string, string, string?][] = [
    ["help us split expenses on our trip", "Tab", "expense-splitting"], ["plan a party and poll the group", "Plans", "polls"],
    ["a grocery list for our apartment", "Roomie", "shared-lists"], ["tell me about price drops and restocks", "Hawk"],
    ["a morning briefing with my calendar", "Dash"], ["answer customer support questions from our FAQ", "Juno"],
    ["find sales leads and prospects", "Leo"], ["take meeting notes and track action items", "Max"],
    ["help me study and quiz me", "Sage"], ["workout and habit accountability", "Coach"],
    ["keep track of bills, renewals and life admin", "Ollie"], ["draft social posts and content", "Echo"],
    ["meal plans and a shared grocery list", "Chef", "shared-lists"],
  ];
  for (const [d, name, skill] of cases) {
    const r = await draftAgent(d);
    expect({ d, name: r.name, skill: skill && r.skills.includes(skill) }).toEqual({ d, name, skill: skill && true });
  }
});
