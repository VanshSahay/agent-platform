// Milo's REMEMBER and "is this real?" pieces, and group tallying that counts answers people already gave.
import { test, expect, beforeEach } from "bun:test";
import { one, exec } from "../src/db";
import * as rt from "../src/runtime";
import { checkScam } from "../src/scam";
import { setup, user, workspace, installAgent, say, scriptModel, call, lastFrom, messages } from "./helpers";

/** The last tool result's JSON, however the context wraps it. */
const lastJson = (r: any) => { for (const m of [...r.messages].reverse()) { const c = String(m.content ?? ""), a = c.indexOf("{"), b = c.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch {} } } return {}; };
let mom: string, sarah: string, tom: string, ws: string, milo: any, family: any, dm: any;
beforeEach(() => {
  setup(); mom = user("Mom"); sarah = user("Sarah"); tom = user("Tom"); ws = workspace("Family", mom, [[sarah], [tom]]);
  milo = installAgent("milo-family", ws, mom);
  family = rt.createRoom({ workspace_id: ws, name: "Family", members: [{ id: mom, kind: "human" }, { id: sarah, kind: "human" }, { id: tom, kind: "human" }, { id: milo.id, kind: "agent" }] });
  dm = rt.privateRoomFor(mom, milo);
});

test("AC-F3 scam check: a plain verdict with the reasons, from the message itself; benign messages pass", () => {
  const r = checkScam('Your Amazon account is locked. Verify your card within 24 hours: amaz0n-secure.xyz', { kind: "text" });
  expect(r.verdict).toBe("likely a scam");
  expect(r.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/pressures you to act right now/), expect.stringMatching(/verify/), expect.stringMatching(/amaz0n-secure\.xyz isn't amazon's real website/)]));
  expect(r.what_to_do[0]).toMatch(/Don't reply, don't click/);
  expect(checkScam("Grandma it's me, I'm in jail and need bail money, please don't tell mom").verdict).toBe("likely a scam");
  expect(checkScam("This is the IRS. You owe back taxes; pay with gift cards today or face arrest.").score).toBeGreaterThanOrEqual(10);
  expect(checkScam("Hi Mom, dinner's at 6 on Sunday, Tom's bringing the pie.").verdict).toBe("nothing obviously wrong");
  expect(checkScam("Your dentist appointment is Tuesday at 2pm. Reply C to confirm.", { from: "noreply@smiledental.com" }).verdict).toBe("nothing obviously wrong");
  const fromDomain = checkScam("Chase: suspicious charge of $480 on your card. Confirm your account now.", { from: "alerts@chase-verify.net" });
  expect(fromDomain.reasons).toContain("sent from chase-verify.net, not from chase");
});

test("AC-F3 'is this real?' in chat runs the check and the reply carries the verdict and reasons", async () => {
  await say(dm.id, mom, 'Is this real? "USPS: your package is held. Pay a small redelivery fee at usps-redeliver.top"');
  const reply = lastFrom(dm.id, milo.id) ?? "";
  expect(reply).toMatch(/likely a scam/);
  expect(reply).toMatch(/package held for a small fee/);
});

test("AC-F4 stories: kept in the teller's words with provenance; private stays private, the family's are searchable from a private chat too", async () => {
  // Mom tells a story privately
  scriptModel(call("story.add", { title: "Hangzhou, 1978", text: "We rode bikes around West Lake every Sunday. Your grandfather bought lotus seeds from the same old man each week.", people: ["Grandpa"], when: "summer 1978", where: "Hangzhou" }), { text: "Kept it." });
  await say(dm.id, mom, "keep this story: We rode bikes around West Lake every Sunday...");
  const s = one<any>("select * from stories where room_id=?", dm.id);
  expect(s).toMatchObject({ told_by: mom, title: "Hangzhou, 1978", when_text: "summer 1978", where_text: "Hangzhou" });
  // Sarah searching in the family group doesn't see Mom's private story
  scriptModel(call("story.search", { query: "Hangzhou" }), (r) => ({ text: `found ${lastJson(r).total}` }));
  await say(family.id, sarah, "@Milo any stories about Hangzhou?");
  expect(lastFrom(family.id, milo.id)).toBe("found 0");
  // A story told in the group is the family's; Mom sees both from her private chat
  scriptModel(call("story.add", { title: "Tom's pie", text: "The apple pie recipe from Aunt May: 6 Granny Smiths, cinnamon, never nutmeg.", people: ["Aunt May"] }), { text: "Kept it." });
  await say(family.id, tom, "@Milo save the recipe: Aunt May's apple pie, 6 Granny Smiths, cinnamon, never nutmeg");
  scriptModel(call("story.search", { query: "" }), (r) => ({ text: lastJson(r).stories.map((x: any) => `${x.title} (${x.told_by})`).join("; ") }));
  await say(dm.id, mom, "what stories do we have?");
  expect(lastFrom(dm.id, milo.id)).toBe("Tom's pie (Tom); Hangzhou, 1978 (Mom)");
});

test("AC-G5 a poll counts what people already answered in the chat; they aren't asked again", async () => {
  await say(family.id, sarah, "I can drive Thursday");          // answered before any poll existed
  await say(family.id, tom, "can't make it");
  scriptModel(call("poll.create", { question: "Who can take Dad to the cardiologist Thursday?", options: ["Yes", "No", "Maybe"] }),
    (r) => { const o = lastJson(r); return { text: `already: ${(o.already_answered ?? []).join(", ")}` }; });
  await say(family.id, mom, "@Milo poll everyone: who can take Dad to the cardiologist Thursday? yes/no/maybe");
  expect(lastFrom(family.id, milo.id)).toBe("already: Tom");   // Tom's "can't make it" is a No; Sarah's sentence isn't a vote — she is asked
  const p = one<any>("select * from polls where room_id=?", family.id);
  expect(one<any>("select option_ids from poll_votes where poll_id=? and user_id=?", p.id, tom)?.option_ids).toBe('["o2"]');
  expect(one<any>("select 1 from poll_votes where poll_id=? and user_id=?", p.id, sarah)).toBeFalsy();
  void exec; void messages;
});

test("AC-F5 objectives with steps: owners and due dates, one-line progress, a single overdue nudge, escalation to the person who set it up two days later", async () => {
  const { advance } = await import("../src/db");
  const { checkObjectives } = await import("../src/objectives");
  const due = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  scriptModel(call("objective.create", { title: "Mom's cataract surgery", steps: [{ title: "Pre-op appointment", owner: "Sarah", due }, { title: "Insurance pre-auth", owner: "Tom" }, { title: "Ride home after surgery", owner: "me" }] }),
    (r) => ({ text: lastJson(r).progress }));
  await say(family.id, mom, "@Milo plan: Mom's cataract surgery — pre-op appointment; insurance pre-auth; ride home after surgery");
  expect(lastFrom(family.id, milo.id)).toMatch(/^Mom's cataract surgery: 0\/3 done · now: Pre-op appointment \(Sarah, due \w{3}, \w{3} \d+\) · next: Insurance pre-auth$/);
  const o = one<any>("select * from objectives where room_id=?", family.id);
  expect(one<any>("select owner from objective_steps where objective_id=? and n=3", o.id).owner).toBe(mom);
  // Nothing before the due date
  expect(checkObjectives()).toBe(0);
  // Overdue: one nudge to the owner, not two
  advance(2 * 864e5 + 3600e3);
  expect(checkObjectives()).toBe(1); expect(checkObjectives()).toBe(0);
  expect(lastFrom(family.id, milo.id)).toMatch(/"Pre-op appointment" was due .*Sarah, how's it going\?/);
  // Two days later with no update: escalate to Mom, once
  advance(2 * 864e5);
  expect(checkObjectives()).toBe(1); expect(checkObjectives()).toBe(0);
  expect(lastFrom(family.id, milo.id)).toMatch(/^Mom, "Pre-op appointment" \(Mom's cataract surgery\) is two days past due/);
  // Sarah reports it done → progress moves on; a done step is never nudged
  scriptModel(call("objective.update", { step: "pre-op", status: "done" }), (r) => ({ text: lastJson(r).progress }));
  await say(family.id, sarah, "@Milo pre-op is done");
  expect(lastFrom(family.id, milo.id)).toBe("Mom's cataract surgery: 1/3 done · now: Insurance pre-auth (Tom) · next: Ride home after surgery");
  expect(checkObjectives()).toBe(0);
});

test("a new first-party template version reaches existing installs: new skills added, owner's own permission choices kept", async () => {
  const { seedFirstParty, getManifest } = await import("../src/templates");
  const { exec, S, J } = await import("../src/db");
  // Pretend Milo was installed from an older version with fewer skills and one permission the owner changed
  exec("update agents set skills=?, permissions=?, template_version='0.9.0' where id=?", S(["family-bridge", "calendar"]), S({ "email.send": "always" }), milo.id);
  exec("update templates set latest_version='0.9.0' where slug='milo-family'");
  exec("delete from template_versions where version=? and template_id=(select id from templates where slug='milo-family')", getManifest("milo-family")!.version);
  seedFirstParty();
  const a = one<any>("select * from agents where id=?", milo.id), m = getManifest("milo-family")!;
  expect(a.template_version).toBe(m.version);
  expect(J(a.skills, [])).toEqual(expect.arrayContaining(["family-bridge", "calendar", "scam-check", "family-stories", "objectives"]));
  expect(J(a.permissions, {})["email.send"]).toBe("always");
});

test("AC-F6 story interviewer: one unasked question at a time, the answer kept as a story; paperwork: a sent bill is findable with what it asks; friendship: who's gone quiet, private only", async () => {
  const { exec, S } = await import("../src/db");
  const { whatItAsks } = await import("../src/paperwork");
  const { mentions } = await import("../src/people");
  // Interviewer: the planner asks the first question, then the next one, never repeating
  scriptModel(call("story.prompt", {}), (r) => ({ text: lastJson(r).question }));
  await say(dm.id, mom, "ask me one question about my life");
  expect(lastFrom(dm.id, milo.id)).toBe("Where did you grow up, and what did your street look like?");
  scriptModel(call("story.prompt", {}), (r) => ({ text: lastJson(r).question }));
  await say(dm.id, mom, "next question");
  expect(lastFrom(dm.id, milo.id)).toBe("What's the first meal you remember loving, and who made it?");
  // Paperwork: a bill arrives as a file; docs.find returns it with amounts, dates and asks
  exec("insert into files (id, workspace_id, room_id, name, mime, size, data, text, uploaded_by, created_at) values (?,?,?,?,?,?,?,?,?,?)", "fil_bill1", ws, dm.id, "ConEd-March.pdf", "application/pdf", 10, null,
    "Con Edison statement. Amount due: $142.17. Payment due by April 15, 2026. Call 1-800-752-6633 with questions.", mom, Date.now());
  expect(whatItAsks("Amount due: $142.17. Payment due by April 15, 2026.")).toMatchObject({ amounts: ["$142.17"], dates: ["April 15, 2026"], actions: [expect.stringMatching(/^due: \$142/), expect.stringMatching(/^Payment due by April 15/)] });
  scriptModel(call("docs.find", { query: "con edison bill" }), (r) => { const o = lastJson(r); return { text: `${o.total}: ${o.documents[0].name} asks ${o.documents[0].asks.amounts[0]} by ${o.documents[0].asks.dates[0]}` }; });
  await say(dm.id, mom, "find my last con edison bill");
  expect(lastFrom(dm.id, milo.id)).toBe("1: ConEd-March.pdf asks $142.17 by April 15, 2026");
  // Sarah can't find Mom's private bill from the group
  scriptModel(call("docs.find", { query: "con edison" }), (r) => ({ text: `${lastJson(r).total}` }));
  await say(family.id, sarah, "@Milo where's the con edison bill?");
  expect(lastFrom(family.id, milo.id)).toBe("0");
  // Friendship: names Mom mentions in her own chat; Linda has gone quiet
  const old = Date.now() - 45 * 864e5;
  for (const [t, txt] of [[old, "Had lunch with Linda today"], [old + 864e5, "Linda and I went to the market"], [old + 2 * 864e5, "Linda called about mahjong"], [Date.now() - 2 * 864e5, "Mary is coming Saturday"], [Date.now() - 864e5, "Mary brought pie"]] as [number, string][])
    exec("insert into events (id, workspace_id, room_id, type, actor, data, ts) values (?,?,?,?,?,?,?)", `evt_${t}_${txt.length}`, ws, dm.id, "message", mom, S({ text: txt }), t);
  const m = mentions(dm.id, mom, milo.id);
  expect(m.map((p) => p.name)).toEqual(["Linda", "Mary"]);
  scriptModel(call("people.quiet", {}), (r) => ({ text: lastJson(r).quiet.map((p: any) => p.name).join(",") }));
  await say(dm.id, mom, "who have I lost touch with?");
  expect(lastFrom(dm.id, milo.id)).toBe("Linda");
  void S;
});
