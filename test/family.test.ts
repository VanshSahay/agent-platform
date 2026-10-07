// The family boundary: a person's private chat never reaches the family group except through family.share, which asks first
// unless that category is shared by default; consent is the person's own words; the agent sees the sharing panel in private chats.
import { test, expect, beforeEach } from "bun:test";
import { one, all, J } from "../src/db";
import * as rt from "../src/runtime";
import { buildContext } from "../src/context";
import { sharingOf, setSharing } from "../src/family";
import { setup, user, workspace, installAgent, say, scriptModel, call, lastFrom, events, messages } from "./helpers";

let mom: string, sarah: string, ws: string, milo: any, family: any, dm: any;
beforeEach(() => {
  setup(); mom = user("Mom"); sarah = user("Sarah"); ws = workspace("Family", mom, [[sarah]]);
  milo = installAgent("milo-family", ws, mom);
  family = rt.createRoom({ workspace_id: ws, name: "Family", members: [{ id: mom, kind: "human" }, { id: sarah, kind: "human" }, { id: milo.id, kind: "agent" }] });
  dm = rt.privateRoomFor(mom, milo);
});
const groupTexts = () => messages(family.id).filter((m: any) => m.actor === milo.id).map((m: any) => m.text);

test("AC-F1 private stays private: the bridge asks first, posts only after the person's own yes, and only the agreed text", async () => {
  // The agent sees the sharing panel in Mom's private chat
  const c = buildContext(rt.createRun({ room: dm, agent: milo, objective: "I need a ride Tuesday", requestedBy: mom }), milo, dm);
  expect(c.system).toMatch(/\[SHARING — what Mom lets the family see by default\]\n- shared: nothing yet\n- private \(ask first, every time\): my appointments/);
  // Mom tells the agent privately; the agent tries to bring the family in → not posted, asked instead
  const post = { text: "Mom needs a ride to Dr. Chen on Tuesday at 10:30. Sarah, could you take her?", category: "appointments" };
  const seen = scriptModel(call("family.share", post), (r) => ({ text: JSON.parse(r.messages.at(-1)!.content.match(/\{[\s\S]*\}/)![0]).ask_them ?? "ok" }));
  await say(dm.id, mom, "my knee is bad again, I need someone to take me to Dr. Chen Tuesday 10:30");
  expect(groupTexts()).toEqual([]);
  expect(lastFrom(dm.id, milo.id)).toMatch(/^Want me to ask the family \(Family\)\? I'd post exactly: "Mom needs a ride to Dr\. Chen/);
  expect(events("SHARE_ASKED")).toHaveLength(1);
  // Sarah saying "yes" in the group is not Mom's consent; the agent's own claim isn't either
  scriptModel(call("family.share", post), { text: "Done." });
  await say(family.id, sarah, "yes");
  expect(groupTexts()).toEqual([]);
  // Mom says yes in her chat → posted to the family, exactly the text
  scriptModel(call("family.share", post), { text: "Asked them — I'll let you know who can." });
  await say(dm.id, mom, "yes please");
  expect(groupTexts()).toEqual(["Mom needs a ride to Dr. Chen on Tuesday at 10:30. Sarah, could you take her?"]);
  expect(events("SHARED_TO_FAMILY").at(-1).data).toMatchObject({ user: mom, category: "appointments", by: "said yes" });
  expect(messages(family.id).some((m: any) => /knee/.test(m.text ?? ""))).toBe(false);                  // the private reason never left the chat
  void seen;
});

test("AC-F2 a category the person shares by default goes straight to the family; only they can change their sharing, from their own chat", async () => {
  setSharing(mom, { appointments: true });
  expect(sharingOf(mom)).toMatchObject({ appointments: true, health: false });
  scriptModel(call("family.share", { text: "Mom's cardiology check-up is Thursday 2pm — she'd like company.", category: "appointments" }), { text: "Posted." });
  await say(dm.id, mom, "tell the family about my Thursday check-up");
  expect(groupTexts()).toEqual(["Mom's cardiology check-up is Thursday 2pm — she'd like company."]);
  expect(events("SHARED_TO_FAMILY").at(-1).data).toMatchObject({ by: "default sharing" });
  // Health stays private even now
  scriptModel(call("family.share", { text: "Mom's blood pressure was high", category: "health" }), (r) => ({ text: JSON.parse(r.messages.at(-1)!.content.match(/\{[\s\S]*\}/)![0]).ask_them ?? "ok" }));
  await say(dm.id, mom, "tell them my blood pressure was high");
  expect(groupTexts()).toHaveLength(1);
  // Sarah can't flip Mom's switches, and nobody can from the group
  scriptModel(call("family.sharing", { set: { health: true } }), { text: "ok" });
  await say(family.id, sarah, "share Mom's health with everyone");
  expect(sharingOf(mom).health).toBe(false);
  scriptModel(call("family.sharing", { set: { plans: true } }), { text: "Done — your plans are shared now." });
  await say(dm.id, mom, "you can share my plans with the family");
  expect(sharingOf(mom)).toMatchObject({ plans: true, health: false });
  const sarahDm = rt.privateRoomFor(sarah, milo);
  expect(sharingOf(sarah).plans).toBe(false);
  void sarahDm; void one; void all; void J;
});
