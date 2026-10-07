// What agents learn from doing, checked against our own records: playbooks per task shape, sites that keep failing, answers kept
// as preferences, group awareness (decisions, who hasn't replied), a person's private memory used silently in a group, run notes.
import { test, expect, beforeEach } from "bun:test";
import { one, all, J } from "../src/db";
import * as rt from "../src/runtime";
import { buildContext } from "../src/context";
import { hostBlocked } from "../src/experience";
import { getTool } from "../src/tools";
import { setup, user, workspace, customAgent, say, scriptModel, call, net, runsIn, lastFrom, events } from "./helpers";

let ellie: string, sam: string, ws: string;
beforeEach(() => { setup(); ellie = user("Ellie"); sam = user("Sam"); ws = workspace("Home", ellie, [[sam]]); });

test("AC-X1 a completed task leaves a playbook (what worked, what failed, how long); a similar request starts from it; repeats are counted, not duplicated", async () => {
  const a = customAgent(ws, ellie, ["web-research"], {}, "Scout");
  const room = rt.privateRoomFor(ellie, a);
  net.on(/dead\.example/, () => new Response("nope", { status: 403 }));
  scriptModel(call("web.search", { query: "hotels in Lisbon near Alfama" }), call("web.fetch", { url: "https://dead.example/x" }), { text: "Hotel One (https://hotel.example/one)." });
  await say(room.id, ellie, "find hotels in Lisbon near Alfama");
  const pb = one<any>("select * from memories where scope_type='agent' and scope_id=? and kind='playbook'", a.id);
  expect(pb.text).toMatch(/^Playbook \(done 1×, last \d+s\) for "find hotels in Lisbon near Alfama": search "hotels in Lisbon near Alfama" → read dead\.example ✗$/);
  // The next similar request sees it before its first model call
  const seen = scriptModel({ text: "Hotel One again (https://hotel.example/one)." });
  await say(room.id, ellie, "find hotels in Lisbon for next weekend");
  expect(seen[0].system).toMatch(/\[EXPERIENCE[^\]]*\]\n- Playbook \(done 1×/);
  // Same shape again → the count goes up, still one playbook
  scriptModel(call("web.search", { query: "hotels in Porto" }), call("web.fetch", { url: "https://hotel.example/one" }), { text: "Hotel Two (https://hotel.example/two)." });
  await say(room.id, ellie, "find hotels in Porto by the river");
  expect(all("select 1 from memories where scope_type='agent' and scope_id=? and kind='playbook'", a.id)).toHaveLength(1);
  expect(one<any>("select text from memories where scope_type='agent' and scope_id=? and kind='playbook'", a.id).text).toMatch(/done 2×/);
});

test("AC-X2 a site that failed three times this week is refused up front with the reason, saving the fourth call", async () => {
  const a = customAgent(ws, ellie, ["web-research"], {}, "Scout");
  const room = rt.privateRoomFor(ellie, a);
  net.on(/dead\.example/, () => new Response("nope", { status: 403 }));
  for (let i = 0; i < 3; i++) {
    scriptModel(call("web.fetch", { url: `https://dead.example/p${i}` }), { text: "Couldn't read it." });
    await say(room.id, ellie, `read https://dead.example/p${i}`);
  }
  expect(all("select 1 from memories where kind='site' and text like 'site:dead.example fetch failed%'")).toHaveLength(3);
  expect(hostBlocked(ws, "https://dead.example/p9")).toMatch(/dead\.example has blocked or failed 3 fetches this week/);
  const before = net.to(/dead\.example/).length;
  const seen = scriptModel(call("web.fetch", { url: "https://dead.example/p9" }), { text: "That site blocks me; here's what search shows." });
  await say(room.id, ellie, "read https://dead.example/p9");
  expect(net.to(/dead\.example/).length).toBe(before);                                           // no network call
  expect(seen.at(-1)!.messages.filter((m) => m.role === "tool").at(-1)!.content).toMatch(/has blocked or failed 3 fetches/);
  expect(hostBlocked(ws, "https://hotel.example/one")).toBeNull();
});

test("AC-X3 what a person answers when asked is kept as their preference and never asked again", async () => {
  const a = customAgent(ws, ellie, ["credential-followup"], {}, "Ava"); // can send email, has no contacts look-up
  const { googleConnection } = await import("./helpers");
  googleConnection(ws, ellie, [a.id]);
  const room = rt.privateRoomFor(ellie, a);
  await say(room.id, ellie, "Email Sam about the trip dates");
  expect(lastFrom(room.id, a.id)).toMatch(/What's Sam's email address\?/);
  scriptModel(call("email.send", { to: ["sam@example.com"], subject: "Trip dates", body: "Hi Sam" }), { text: "Draft ready." });
  await say(room.id, ellie, "sam@example.com");
  await say(room.id, ellie, "approve");
  expect(one<any>("select text from memories where scope_type='user_private' and scope_id=? and kind='preference'", ellie)?.text).toBe("Ellie: What's Sam's email address → sam@example.com");
  // Next time: no question, the memory carries the address
  scriptModel(call("email.send", { to: ["sam@example.com"], subject: "Dinner", body: "Dinner?" }), { text: "Draft ready." });
  await say(room.id, ellie, "Email Sam about dinner");
  expect(lastFrom(room.id, a.id)).not.toMatch(/email address\?/);
  expect(runsIn(room.id).at(-1).brief_status).not.toBe("clarifying");
});

test("AC-X4 in a group the agent knows what was decided and who hasn't answered; a member's private memory helps them silently and is shown for the requester only", async () => {
  const a = customAgent(ws, ellie, ["polls"], {}, "Pip");
  const room = rt.createRoom({ workspace_id: ws, name: "Trip", members: [{ id: ellie, kind: "human" }, { id: sam, kind: "human" }, { id: a.id, kind: "agent" }] });
  const { remember } = await import("../src/memory");
  remember({ room, scope: "room", kind: "decision", text: "Friday 7pm at Lupa", createdBy: ellie });
  remember({ room: rt.privateRoomFor(ellie, a), scope: "user_private", scopeId: ellie, kind: "preference", text: "Ellie: vegetarian", createdBy: ellie });
  rt.postMessage(room.id, { sender: a.id, text: "Does Friday work for everyone?" });
  rt.postMessage(room.id, { sender: ellie, text: "yes!" });
  const run = rt.createRun({ room, agent: a, objective: "pick a vegetarian-friendly place", requestedBy: ellie });
  const c = buildContext(run, a, room);
  expect(c.system).toMatch(/\[GROUP\]\n- decided: Friday 7pm at Lupa\n- haven't answered your last question yet: Sam/);
  expect(c.system).toMatch(/\[PRIVATE — known about Ellie[^\]]*never repeat it to the group\]\n- Ellie: vegetarian/);
  const run2 = rt.createRun({ room, agent: a, objective: "pick a vegetarian-friendly place", requestedBy: sam });
  expect(buildContext(run2, a, room).system).not.toMatch(/vegetarian/);                             // Sam's request never sees Ellie's private memory
});

test("AC-X5 exact arithmetic, currency conversion with the rate's date, and task notes that persist across steps", async () => {
  const calc = getTool("calc")!, money = getTool("money.convert")!;
  expect((await calc.execute({ expression: "(240 + 18) / 3; 15% * 0" }, {} as any)).output.results.map((r: any) => r.value)).toEqual([86, 0]);
  await expect(calc.execute({ expression: "process.exit(1)" }, {} as any)).rejects.toThrow(/not a plain arithmetic expression/);
  net.on(/api\.frankfurter\.app/, () => Response.json({ amount: 86, base: "GBP", date: "2026-10-06", rates: { USD: 112.38 } }));
  expect((await money.execute({ amount: 86, from: "gbp", to: "usd" }, {} as any)).output).toMatchObject({ converted: 112.38, as_of: "2026-10-06", from: "GBP", to: "USD" });
  const a = customAgent(ws, ellie, ["web-research"], {}, "Scout");
  const room = rt.privateRoomFor(ellie, a);
  const seen = scriptModel(call("notes.add", { text: "Hotel One: $129/night, Oct 9 only" }), call("web.search", { query: "x" }), { text: "Done (https://hotel.example/one)." });
  await say(room.id, ellie, "look into hotels");
  expect(seen.at(-1)!.system).toMatch(/\[NOTES — your own notes for this task\]\n1\. Hotel One: \$129\/night, Oct 9 only/);
});
