// Ava's three release jobs, end to end over the shared iMessage line: calendar answer, reminder, email.
// Completion is proved by our own records (tool results, schedules, approvals, provider calls) — not by the reply text.
import { test, expect, beforeEach } from "bun:test";
import { one, all, J, advance, now, setTz, zoned, exec } from "../src/db";
import * as rt from "../src/runtime";
import * as ch from "../src/channels";
import { setup, user, workspace, installAgent, googleConnection, scriptModel, call, net, deliver, imsg, SECRETS, events } from "./helpers";

let ellie: string, ws: string, ava: any;
const LINE = "chi_shared_imessage", CHAT = "chat-ellie", PHONE = "+15551110000";
beforeEach(async () => {
  setup();
  Object.assign(process.env, { SHARED_IMESSAGE_LINE: "+15550001000", SHARED_IMESSAGE_API_URL: "https://photon.test", SHARED_IMESSAGE_API_KEY: "ph", SHARED_IMESSAGE_WEBHOOK_SECRET: SECRETS.imessage.webhook_secret });
  ch.ensureSharedIdentities();
  ellie = user("Ellie"); ws = workspace("Home", ellie); setTz(ellie, "America/New_York");
  ava = installAgent("ava-executive-assistant", ws, ellie);
  await text(`start ${ch.createDeployCode(ava.id, ellie, "imessage", "dm")}`);
});
let n = 0;
const text = (body: string, extra: any = {}) => deliver("imessage", LINE, { ...imsg(CHAT, PHONE, "", body), id: `m${++n}`, ...extra });
const sent = () => net.to(/photon\.test\/messages/).map((c) => c.body.text as string);
const outcomes = () => events("JOB_OUTCOME").map((e) => e.data);

test("AC-AVA1 calendar: reads the real calendar in the person's zone; a reply without reading it is sent back; no Google = honest connect link; expired = reconnect", async () => {
  // No Google yet: says so with a link, does nothing else
  await text("what's my day look like?");
  expect(sent().at(-1)).toMatch(/need access to your Google account[\s\S]*Connect it here/);
  expect(outcomes().at(-1)).toMatchObject({ job: "calendar", ok: false, evidence: "missing connection" });

  googleConnection(ws, ellie, [ava.id]);
  let calQuery = "";
  net.on(/calendar\/v3\/calendars\/primary\/events\?/, (r) => { calQuery = r.url; return Response.json({ items: [{ id: "e1", summary: "Board meeting", start: { dateTime: new Date(now() + 3 * 36e5).toISOString() }, end: { dateTime: new Date(now() + 4 * 36e5).toISOString() } }] }); });
  const seen = scriptModel(
    { text: "You have a board meeting this afternoon." },                       // claims without reading: not accepted
    call("calendar.list_events", { from: "today" }),
    (r) => ({ text: `Today: ${JSON.parse(r.messages.at(-1)!.content.match(/\{[\s\S]*\}/)![0]).events[0].summary} at ${JSON.parse(r.messages.at(-1)!.content.match(/\{[\s\S]*\}/)![0]).events[0].start}` }));
  await text("what's my day look like?");
  expect(seen.some((q) => q.messages.some((m) => m.content.includes("nothing shows it was done")))).toBe(true);
  expect(calQuery).toContain("timeMin=");
  const start = new Date(decodeURIComponent(calQuery.match(/timeMin=([^&]+)/)![1]));
  expect(zoned(+start, "America/New_York")).toMatchObject({ h: 0, mi: 0 }); // "today" = her midnight, not the server's or "right now"
  expect(sent().at(-1)).toMatch(/Today: Board meeting at \w{3}, \w{3} \d+,? (at )?\d+:\d\d (AM|PM)/);
  expect(outcomes().at(-1)).toMatchObject({ job: "calendar", ok: true, evidence: "calendar.list_events succeeded" });

  // Google says 401 mid-request: she's told, with a link, and the request waits for the reconnect
  net.on(/calendar\/v3\/calendars\/primary\/events\?/, () => new Response("unauthorized", { status: 401 }));
  scriptModel(call("calendar.list_events", { from: "tomorrow" }), { text: "ok" });
  await text("what about tomorrow?");
  expect(sent().at(-1)).toMatch(/can't reach your Google account[\s\S]*Reconnect/);
  expect(one<any>("select status from connections where provider='google'").status).toBe("needs_reauth");
  expect(one<any>("select kind from waits where status='open'").kind).toBe("reconnect");
});

test("AC-AVA2 reminders over iMessage: set (exact time back), list, change, cancel; delivered word for word to the same thread; cancelled never fires", async () => {
  scriptModel(call("reminder.schedule", { text: "call the dentist", time: "15:00" }), (r) => ({ text: `Done — ${JSON.parse(r.messages.at(-1)!.content.match(/\{[\s\S]*\}/)![0]).next}` }));
  await text("remind me at 3pm to call the dentist");
  const r1 = one<any>("select * from schedules where objective='call the dentist'");
  expect(zoned(r1.next_at, "America/New_York")).toMatchObject({ h: 15, mi: 0 });
  expect(sent().at(-1)).toMatch(/Done — \w{3}, \w{3} \d+,? (at )?3:00 PM/);
  scriptModel(call("reminder.schedule", { text: "water the plants", recurring: "daily", time: "08:00" }), { text: "Daily at 8am." });
  await text("remind me every day at 8am to water the plants");

  scriptModel(call("reminder.list", {}), (r) => ({ text: r.messages.at(-1)!.content.match(/"reminders":\[.*\]/)![0] }));
  await text("what reminders do I have?");
  expect(sent().at(-1)).toMatch(/call the dentist/);
  expect(sent().at(-1)).toMatch(/water the plants[^}]*daily at 8:00/);

  scriptModel(call("reminder.update", { reminder: "dentist", time: "16:30" }), { text: "Moved to 4:30pm." });
  await text("actually make the dentist one 4:30");
  expect(zoned(one<any>("select next_at from schedules where id=?", r1.id).next_at, "America/New_York")).toMatchObject({ h: 16, mi: 30 });

  scriptModel(call("reminder.cancel", { reminder: "plants" }), { text: "Cancelled the plants reminder." });
  await text("cancel the plants one");
  expect(one<any>("select status from schedules where objective='water the plants'").status).toBe("cancelled");
  expect(outcomes().slice(-4).every((o: any) => o.job === "reminder" && o.ok)).toBe(true);

  const before = sent().length;
  advance(26 * 3600e3); await rt.drain(); await rt.drain();
  const fired = sent().slice(before);
  expect(fired).toContain("⏰ call the dentist");                       // word for word, same iMessage thread, no model
  expect(fired.some((t) => /plants/.test(t))).toBe(false);              // cancelled
  expect(events("REMINDER_SENT")).toHaveLength(1);
  expect(one<any>("select status from schedules where id=?", r1.id).status).toBe("done");
});

test("AC-AVA3 email: exact draft shown, approval bound to that exact draft, sent once, provider result reported; an uncertain send is never retried blindly", async () => {
  googleConnection(ws, ellie, [ava.id]);
  const gmail: any[] = [];
  net.on(/gmail\.googleapis\.com\/.*\/messages\/send/, (_r, b) => { gmail.push(b); return Response.json({ id: `gm${gmail.length}` }); });
  scriptModel(call("email.send", { to: ["sam@example.com"], subject: "Friday", body: "Can we do Thursday 2pm instead?" }), (r) => ({ text: `Sent: ${r.messages.at(-1)!.content.slice(0, 60)}` }));
  await text("email sam@example.com that I can do Thursday 2pm instead of Friday");
  const apr = one<any>("select * from approvals where status='pending'");
  expect(apr.tool_id).toBe("email.send");
  expect(sent().some((t) => /sam@example\.com/.test(t) && /Thursday 2pm/.test(t))).toBe(true); // she sees the exact draft
  expect(gmail).toHaveLength(0);
  expect(one<any>("select status from runs where id=?", apr.run_id).status).toBe("waiting_for_human");

  await text("approve");
  expect(gmail).toHaveLength(1);
  expect(outcomes().at(-1)).toMatchObject({ job: "email", ok: true, evidence: "email.send succeeded" });
  expect(Buffer.from(gmail[0].raw, "base64url").toString()).toContain("Can we do Thursday 2pm instead?"); // exactly what was approved
  await text("approve"); await rt.drain();
  expect(gmail).toHaveLength(1); // never twice

  // A changed draft needs its own approval: approving draft A never sends draft B
  scriptModel(call("email.send", { to: ["sam@example.com"], subject: "Lunch", body: "Lunch at noon?" }), { text: "Draft ready." });
  await text("email sam@example.com about lunch at noon");
  const a2 = one<any>("select * from approvals where status='pending'");
  expect(J(a2.input).body).toBe("Lunch at noon?");
  expect(rt.decideApproval(apr.id, ellie, "approve", { confirm: true }, null)).toHaveProperty("error"); // the old, already-used approval can't be reused

  // Provider doesn't answer cleanly → reconcile by our Message-ID instead of guessing:
  // (a) it's in the mailbox: report it sent, never send again
  let found = true, searches = 0;
  net.on(/gmail\.googleapis\.com\/.*\/messages\/send/, (_r, b) => { gmail.push(b); return new Response("upstream timeout", { status: 503 }); });
  net.on(/messages\?q=rfc822msgid/, (r) => { searches++; expect(decodeURIComponent(r.url)).toMatch(/rfc822msgid:<[\w.-]+@agents\.mail>/); return found ? Response.json({ messages: [{ id: "gm-found" }] }) : new Response("backend error", { status: 500 }); });
  await text("approve"); await rt.drain();
  expect(gmail).toHaveLength(2);
  expect(searches).toBe(1);
  expect(outcomes().at(-1)).toMatchObject({ job: "email", ok: true, evidence: "email.send succeeded" });
  expect(J(one<any>("select result from tool_executions where tool_id='email.send' order by created_at desc").result).output?.id ?? J(one<any>("select result from tool_executions where tool_id='email.send' order by created_at desc").result).id).toBe("gm-found");

  // (b) Gmail can't even be asked: she's told to check, and nothing is retried
  found = false;
  scriptModel(call("email.send", { to: ["sam@example.com"], subject: "Dinner", body: "Dinner Saturday?" }), { text: "Draft ready." });
  await text("email sam@example.com about dinner saturday");
  await text("approve");
  await rt.drain(); advance(60e3); await rt.drain();
  expect(gmail).toHaveLength(3); // one attempt, no blind retry
  expect(sent().at(-1)).toMatch(/not sure that went through[\s\S]*check/);
  expect(one<any>("select status from tool_executions where tool_id='email.send' order by created_at desc").status).toBe("unknown");
});
