import { test, expect, beforeEach } from "bun:test";
import { one, all, J } from "../src/db";
import * as rt from "../src/runtime";
import * as mem from "../src/memory";
import { setup, user, workspace, customAgent, say, scriptModel, call } from "./helpers";

let sarah: string, james: string, ws: string, agent: any, dm: any, team: any;
beforeEach(() => {
  setup();
  sarah = user("Sarah"); james = user("James"); ws = workspace("Acme", sarah, [[james]]);
  agent = customAgent(ws, sarah, ["group-coordination"], {}, "Relay");
  dm = rt.privateRoomFor(sarah, agent);
  team = rt.createRoom({ workspace_id: ws, name: "Team", participation: "manager", members: [{ id: sarah, kind: "human" }, { id: james, kind: "human" }, { id: agent.id, kind: "agent" }] });
});

test("AC-MEM1 private DM memory never enters a shared room's context", async () => {
  scriptModel({ text: "noted" });
  await say(dm.id, sarah, "I prefer to restructure the team so James reports to Maria");
  const priv = all<any>("select * from memories where scope_type='user_private'");
  expect(priv[0]).toMatchObject({ scope_id: sarah });
  expect(J(priv[0].source_event_ids)).toHaveLength(1); // provenance
  const seen = scriptModel({ text: "ok" });
  await say(team.id, james, "Relay, any thoughts on the team structure and reporting?");
  expect(seen[0].system).not.toContain("restructure");
  const seenDm = scriptModel({ text: "ok" });
  await say(dm.id, sarah, "what did I say about restructure plans?");
  expect(seenDm[0].system).toContain("restructure");
});

test("AC-MEM2 private chats can't write team memory; shared rooms can, explicitly", async () => {
  expect(mem.remember({ room: dm, text: "x", scope: "workspace", createdBy: agent.id })).toHaveProperty("error");
  expect(mem.remember({ room: team, text: "James owns ICU placements", scope: "workspace", createdBy: agent.id })).toHaveProperty("id");
  const seen = scriptModel(call("memory.remember", { text: "Reorg is secret", scope: "workspace" }), { text: "ok" });
  await say(dm.id, sarah, "remember for the team: reorg");
  expect(seen[1].messages.at(-1)!.content).toMatch(/FAILED: private conversations can't write team memory/);
});

test("AC-MEM3 workspace knowledge is withheld when an outside guest is in the room", async () => {
  mem.remember({ room: team, text: "Margin target is 22%", scope: "workspace", createdBy: sarah });
  const guest = rt.createRoom({ workspace_id: ws, name: "With vendor", participation: "manager", members: [{ id: sarah, kind: "human" }, { id: agent.id, kind: "agent" }] });
  const vendor = user("Vendor");
  rt.addMember(guest.id, vendor, "human");
  expect(mem.retrieve(guest, agent.id, "margin target").map((m) => m.text)).not.toContain("Margin target is 22%");
  expect(mem.retrieve(team, agent.id, "margin target").map((m) => m.text)).toContain("Margin target is 22%");
});

test("AC-MEM4 extraction scopes by room type and dedupes repeats", async () => {
  scriptModel({ text: "ok" });
  await say(team.id, sarah, "Starting today, James owns ICU placements.");
  await say(team.id, sarah, "Starting today, James owns ICU placements.");
  const rows = all<any>("select * from memories where scope_type='room' and scope_id=?", team.id);
  expect(rows).toHaveLength(1);
  expect(J(rows[0].source_event_ids)).toHaveLength(2);
  expect(rows[0].kind).toBe("decision");
});

test("AC-MEM5 retrieval ranks relevant memories first and respects expiry", () => {
  for (let i = 0; i < 12; i++) mem.remember({ room: team, text: `filler fact number ${i}`, scope: "room", createdBy: sarah });
  mem.remember({ room: team, text: "Chris's BLS card expires in March", scope: "room", createdBy: sarah });
  expect(mem.retrieve(team, agent.id, "when does the BLS card expire?")[0].text).toMatch(/BLS/);
  const { exec } = require("../src/db");
  exec("update memories set expires_at=1 where text like 'Chris%'");
  expect(mem.retrieve(team, agent.id, "BLS card").some((m) => /BLS/.test(m.text))).toBe(false);
});
