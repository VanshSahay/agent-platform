import { FakeClock } from "../src/core/clock.ts";
import { createApp, type App } from "../src/app.ts";
import { ScriptedModel, type Script } from "../src/model/scripted.ts";
import { newAgent } from "../src/agent/spec.ts";
import { fakeHands, FakeCommunity, FakePhone, FakeSearch } from "../src/tools/hands.ts";
import type { FakeBrowser } from "../src/tools/browser.ts";
import type { Delivery } from "../src/runtime/runtime.ts";

/** A family circle: Ellie (owner), Ben (decider, sibling), Mum (cared for), Uncle Wei (guest). */
export function familyWorld(script: Script, opts: { completer?: (system: string, prompt: string) => string; search?: FakeSearch; phone?: FakePhone; community?: FakeCommunity; browser?: FakeBrowser } = {}) {
  const clock = new FakeClock(Date.UTC(2026, 9, 13, 17, 0, 0)); // 10:00 in Los Angeles
  const model = new ScriptedModel(script, opts.completer);
  const hands = fakeHands({ search: opts.search, phone: opts.phone, community: opts.community, browser: opts.browser });
  const app: App = createApp({ clock, model, hands, heartbeatEveryMs: 24 * 3600 * 1000 });
  const deliveries: Delivery[] = [];
  app.onDeliver((d) => deliveries.push(d));

  const ellie = app.rooms.createPerson({ id: "ellie", displayName: "Ellie", timezone: "America/Los_Angeles", pronouns: "she/her" });
  const ben = app.rooms.createPerson({ id: "ben", displayName: "Ben", timezone: "America/Los_Angeles" });
  const mum = app.rooms.createPerson({ id: "mum", displayName: "Mum", timezone: "America/Los_Angeles", techComfort: "low" });
  const wei = app.rooms.createPerson({ id: "wei", displayName: "Uncle Wei", timezone: "America/Los_Angeles" });

  const agent = newAgent({ ownerId: ellie.id, name: "Pip", purpose: "Keep the family organised: Mum's appointments, rides, repairs, and help her with her phone." });
  app.store.putAgent(agent);
  app.memory.write({ agentId: agent.id, scope: "agent", scopeId: agent.id, type: "rule", text: "Ask before calling anyone; keep messages short." });
  app.memory.write({ agentId: agent.id, scope: "person", scopeId: ellie.id, type: "preference", text: "Ellie prefers morning appointments for Mum.", visibleToRooms: [] });

  const family = app.rooms.createRoom({ agentId: agent.id, kind: "group", channel: "console", name: "Family" });
  app.rooms.addMember(family.id, ellie.id, "owner", { consented: true });
  app.rooms.addMember(family.id, ben.id, "decider", { consented: true });
  app.rooms.addMember(family.id, mum.id, "cared_for");
  app.rooms.addMember(family.id, wei.id, "guest");

  const ellieDm = app.rooms.dmFor(agent, ellie.id);

  return { app, clock, model, hands, deliveries, agent, family, ellieDm, ellie, ben, mum, wei };
}

export const repliesTo = (deliveries: Delivery[], roomId: string) => deliveries.filter((d) => d.roomId === roomId && d.kind === "reply").map((d) => d.text);
export const noticesTo = (deliveries: Delivery[], roomId: string) => deliveries.filter((d) => d.roomId === roomId && d.kind !== "reply").map((d) => d.text);
