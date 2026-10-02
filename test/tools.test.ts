import { test, expect, beforeEach } from "bun:test";
import { one, all, J, S, exec, advance } from "../src/db";
import * as rt from "../src/runtime";
import { validate, TOOLS } from "../src/tools";
import { setup, user, workspace, customAgent, googleConnection, say, scriptModel, call, net, pendingApprovals, runsIn, events, lastFrom } from "./helpers";

let ellie: string, ws: string, agent: any, room: any, conn: string;
beforeEach(() => {
  setup();
  ellie = user("Ellie"); ws = workspace("WS", ellie);
  agent = customAgent(ws, ellie, ["email-drafting", "web-research", "calendar", "follow-up-tracking"], { "email.send": "auto" });
  conn = googleConnection(ws, ellie, [agent.id]);
  room = rt.privateRoomFor(ellie, agent);
});
const send = { to: ["bob@x.test"], subject: "Hi", body: "Hello" };

test("AC-T1 schema validation and unknown tools never execute", async () => {
  expect(validate(TOOLS["email.send"].inputSchema, { to: "bob", subject: "s", body: "b" })).toMatch(/must be an array/);
  expect(validate(TOOLS["email.send"].inputSchema, { ...send, extra: 1 })).toMatch(/not allowed/);
  const seen = scriptModel(call("email.send", { to: "bob" }), call("shell.exec", { cmd: "rm -rf /" }), { text: "ok" });
  await say(room.id, ellie, "go");
  expect(seen[1].messages.at(-1)!.content).toMatch(/FAILED: invalid input/);
  expect(seen[2].messages.at(-1)!.content).toMatch(/DENIED: unknown tool/);
  expect(net.to(/messages\/send/)).toHaveLength(0);
});

test("AC-T2 idempotency: a repeated identical write executes once", async () => {
  scriptModel(call("email.send", send, "c1"), call("email.send", send, "c2"), { text: "done" });
  await say(room.id, ellie, "send it twice");
  expect(net.to(/messages\/send/)).toHaveLength(1);
  expect(all("select * from tool_executions where tool_id='email.send'")).toHaveLength(1);
});

test("AC-T3 retry taxonomy: transient, rate limit, auth, unknown side effect", async () => {
  // RATE_LIMIT waits until retry-after
  let n = 0;
  net.on(/messages\/send/, () => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "30" } }) : Response.json({ id: "ok" })));
  scriptModel(call("email.send", send), { text: "sent" });
  await say(room.id, ellie, "send");
  let run = runsIn(room.id).at(-1);
  expect(run.status).toBe("retrying");
  advance(10_000); await rt.drain(); expect(n).toBe(1);
  advance(25_000); await rt.drain(); expect(n).toBe(2);
  expect(one<any>("select status from runs where id=?", run.id).status).toBe("completed");

  // AUTH pauses and asks the connection owner to reconnect; reconnect resumes the run
  net.on(/messages\/send/, () => new Response("nope", { status: 401 }));
  scriptModel(call("email.send", { ...send, subject: "auth" }), { text: "sent after reconnect" });
  await say(room.id, ellie, "send again");
  run = runsIn(room.id).at(-1);
  expect(run.status).toBe("waiting_for_human");
  expect(one<any>("select status from connections where id=?", conn).status).toBe("needs_reauth");
  expect(one<any>("select * from waits where run_id=? and status='open'", run.id)).toMatchObject({ kind: "reconnect", owner: ellie });
  net.on(/messages\/send/, () => Response.json({ id: "ok2" }));
  exec("update connections set status='active' where id=?", conn);
  rt.signalEvent(`connection:${conn}`, "connection restored"); await rt.drain();
  expect(one<any>("select status from runs where id=?", run.id).status).toBe("completed");

  // UNKNOWN_SIDE_EFFECT on a write stops for human verification and never blindly resends
  let sends = 0;
  net.on(/messages\/send/, () => { sends++; return new Response("boom", { status: 500 }); });
  scriptModel(call("email.send", { ...send, subject: "unknown" }), { text: "ok" });
  await say(room.id, ellie, "send a third");
  run = runsIn(room.id).at(-1);
  const w = one<any>("select * from waits where run_id=? and status='open'", run.id);
  expect(w.kind).toBe("verify");
  rt.resumeWait(w.id, "verified"); await rt.drain(); // resuming without resolution re-hits the unknown fingerprint
  expect(sends).toBe(1);
  expect(one<any>("select * from waits where run_id=? and status='open'", run.id).kind).toBe("verify");
});

test("AC-T4 web.fetch refuses private network targets (SSRF)", async () => {
  const seen = scriptModel(call("web.fetch", { url: "http://169.254.169.254/latest/meta-data" }), call("web.fetch", { url: "http://localhost:3000/v1/me" }), { text: "ok" });
  await say(room.id, ellie, "fetch");
  expect(seen[1].messages.at(-1)!.content).toMatch(/only public/);
  expect(seen[2].messages.at(-1)!.content).toMatch(/only public/);
  expect(net.to(/169\.254|localhost/)).toHaveLength(0);
});

test("AC-T5 crash mid-write: recovery re-queues the run and refuses to double-execute", async () => {
  scriptModel(call("email.send", send, "c1"), { text: "done" });
  await rt.ingestMessage({ roomId: room.id, senderId: ellie, text: "send", platform: "web" });
  const run = runsIn(room.id)[0];
  // Simulate: process died after persisting the fingerprint but before recording the result.
  rt.appendStep(run.id, "assistant", { text: "", toolCalls: [{ id: "c1", name: "email.send", input: send }] });
  const { fingerprint } = await import("../src/tools");
  exec("insert into tool_executions (id, run_id, tool_id, fingerprint, status, input, created_at) values ('tex_x', ?, 'email.send', ?, 'started', ?, 0)", run.id, fingerprint(run.id, "email.send", send), S(send));
  exec("update runs set status='running' where id=?", run.id);
  expect(rt.recover()).toBe(1);
  await rt.drain();
  expect(net.to(/messages\/send/)).toHaveLength(0);
  expect(one<any>("select status from runs where id=?", run.id).status).toBe("waiting_for_human");
  expect(one<any>("select kind from waits where run_id=? and status='open'", run.id).kind).toBe("verify");
});

test("AC-T6 credentials never reach the model, events or the trace", async () => {
  const seen = scriptModel(call("calendar.list_events", { days: 3 }), { text: "ok" });
  await say(room.id, ellie, "what's on my calendar");
  const blob = S(seen) + S(all("select * from events")) + S(rt.trace(runsIn(room.id)[0].id));
  expect(blob).not.toContain('"tok"');
  expect(net.to(/calendar\/v3/)[0].headers.authorization).toBe("Bearer tok"); // but the tool did authenticate
  expect(events("TOOL_CALL_COMPLETED")[0].data.connection_id).toBe(conn); // audit records which connection was used
});

test("AC-T7 run budgets stop runaway agents", async () => {
  exec("update agents set permissions='{}' where id=?", agent.id);
  scriptModel((r) => call("web.search", { query: `q${r.messages.length}` }));
  await say(room.id, ellie, "search forever");
  const run = runsIn(room.id)[0];
  expect(run.status).toBe("failed_terminal");
  expect(J(run.spent).modelCalls).toBeLessThanOrEqual(12);
  expect(lastFrom(room.id, agent.id)).toMatch(/couldn't finish/);
});

test("AC-T8 everyday tools: free-time search, contact lookup feeding an email, Drive search", async () => {
  const { freeSlots } = await import("../src/tools");
  const mon9 = new Date(2026, 9, 5, 9, 0).getTime(); // Monday 9:00 local
  const slots = freeSlots([{ start: mon9, end: mon9 + 2 * 36e5 }], mon9, mon9 + 864e5, 60, 9, 18, 3);
  expect(slots.map((s) => new Date(s.start).getHours())).toEqual([11, 12, 13]); // skips the busy 9-11 block
  expect(freeSlots([], new Date(2026, 9, 3, 9).getTime(), new Date(2026, 9, 3, 18).getTime(), 30)).toEqual([]); // Saturday

  const ava = customAgent(ws, ellie, ["email-drafting", "calendar", "documents"], {}, "Ava");
  googleConnection(ws, ellie, [ava.id]);
  const room2 = rt.privateRoomFor(ellie, ava);
  net.on(/people\.googleapis\.com/, () => Response.json({ results: [{ person: { names: [{ displayName: "Sam Lee" }], emailAddresses: [{ value: "sam.lee@corp.test" }] } }] }));
  net.on(/calendar\/v3\/freeBusy/, () => Response.json({ calendars: { primary: { busy: [] } } }));
  net.on(/drive\/v3\/files\?q=/, () => Response.json({ files: [{ id: "f1", name: "Q3 board deck", webViewLink: "https://docs.test/f1" }] }));

  await say(room2.id, ellie, "Email Sam about the offsite agenda");
  expect(pendingApprovals(room2.id)[0].summary).toMatch(/Send email to sam\.lee@corp\.test/); // looked up instead of asking
  await say(room2.id, ellie, "reject");
  await say(room2.id, ellie, "When am I free for a 45 min call this week?");
  expect(lastFrom(room2.id, ava.id)).toMatch(/Open 45-minute slots/);
  await say(room2.id, ellie, "Find the Q3 board deck");
  expect(lastFrom(room2.id, ava.id)).toMatch(/Q3 board deck — https:\/\/docs\.test\/f1/);
});
