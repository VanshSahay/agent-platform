// Milo's REMEMBER and "is this real?" pieces, and group tallying that counts answers people already gave.
import { test, expect, beforeEach } from "bun:test";
import { one, exec } from "../src/db";
import * as rt from "../src/runtime";
import { checkScam } from "../src/scam";
import { setup, user, workspace, installAgent, say, scriptModel, call, lastFrom, messages } from "./helpers";

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
  scriptModel(call("story.search", { query: "Hangzhou" }), (r) => ({ text: `found ${JSON.parse(r.messages.at(-1)!.content.match(/\{[\s\S]*\}/)![0]).total}` }));
  await say(family.id, sarah, "@Milo any stories about Hangzhou?");
  expect(lastFrom(family.id, milo.id)).toBe("found 0");
  // A story told in the group is the family's; Mom sees both from her private chat
  scriptModel(call("story.add", { title: "Tom's pie", text: "The apple pie recipe from Aunt May: 6 Granny Smiths, cinnamon, never nutmeg.", people: ["Aunt May"] }), { text: "Kept it." });
  await say(family.id, tom, "@Milo save the recipe: Aunt May's apple pie, 6 Granny Smiths, cinnamon, never nutmeg");
  scriptModel(call("story.search", { query: "" }), (r) => ({ text: JSON.parse(r.messages.at(-1)!.content.match(/\{[\s\S]*\}/)![0]).stories.map((x: any) => `${x.title} (${x.told_by})`).join("; ") }));
  await say(dm.id, mom, "what stories do we have?");
  expect(lastFrom(dm.id, milo.id)).toBe("Tom's pie (Tom); Hangzhou, 1978 (Mom)");
});

test("AC-G5 a poll counts what people already answered in the chat; they aren't asked again", async () => {
  await say(family.id, sarah, "I can drive Thursday");          // answered before any poll existed
  await say(family.id, tom, "can't make it");
  scriptModel(call("poll.create", { question: "Who can take Dad to the cardiologist Thursday?", options: ["Yes", "No", "Maybe"] }),
    (r) => { const o = JSON.parse(r.messages.at(-1)!.content.match(/\{[\s\S]*\}/)![0]); return { text: `already: ${(o.already_answered ?? []).join(", ")}` }; });
  await say(family.id, mom, "@Milo poll everyone: who can take Dad to the cardiologist Thursday? yes/no/maybe");
  expect(lastFrom(family.id, milo.id)).toBe("already: Tom");   // Tom's "can't make it" is a No; Sarah's sentence isn't a vote — she is asked
  const p = one<any>("select * from polls where room_id=?", family.id);
  expect(one<any>("select option_ids from poll_votes where poll_id=? and user_id=?", p.id, tom)?.option_ids).toBe('["o2"]');
  expect(one<any>("select 1 from poll_votes where poll_id=? and user_id=?", p.id, sarah)).toBeFalsy();
  void exec; void messages;
});
