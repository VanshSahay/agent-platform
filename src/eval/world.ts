/**
 * The family circle every eval scenario runs in: Ellie (owner), Ben
 * (decider), Mum (cared for), Uncle Wei (guest), and the agent Pip. Same
 * shape as test/helpers.ts, but the model is whatever the harness passes
 * (scripted offline, or the configured real one) and the hands are fakes a
 * scenario seeds before its turns.
 */
import { createApp, type App } from "../app.ts";
import { FakeClock } from "../core/clock.ts";
import type { AgentSpec, Person, Room } from "../core/types.ts";
import { newAgent } from "../agent/spec.ts";
import type { ModelClient } from "../model/types.ts";
import type { Delivery } from "../runtime/runtime.ts";
import { fakeHands, FakeCommunity, FakePhone, FakeSearch } from "../tools/hands.ts";
import type { FakeBrowser } from "../tools/browser.ts";

export interface EvalWorld {
  app: App;
  clock: FakeClock;
  agent: AgentSpec;
  family: Room;
  ellieDm: Room;
  benDm: Room;
  ellie: Person;
  ben: Person;
  mum: Person;
  wei: Person;
  hands: { search: FakeSearch; phone: FakePhone; community: FakeCommunity; browser: FakeBrowser };
  deliveries: Delivery[];
  /** Resolve a scenario's room key to a room id. */
  roomId(key: RoomKey): string;
}

export type RoomKey = "family" | "ellieDm" | "benDm" | (string & {});

export function evalWorld(opts: { model: ModelClient; modelId?: string; maxTurns?: number }): EvalWorld {
  const clock = new FakeClock(Date.UTC(2026, 9, 13, 17, 0, 0)); // 10:00 in Los Angeles, a Tuesday
  const hands = fakeHands();
  const app = createApp({ clock, model: opts.model, hands, heartbeatEveryMs: 24 * 3600 * 1000, maxTurns: opts.maxTurns });
  const deliveries: Delivery[] = [];
  app.onDeliver((d) => deliveries.push(d));

  const ellie = app.rooms.createPerson({ id: "ellie", displayName: "Ellie", timezone: "America/Los_Angeles", pronouns: "she/her" });
  const ben = app.rooms.createPerson({ id: "ben", displayName: "Ben", timezone: "America/Los_Angeles" });
  const mum = app.rooms.createPerson({ id: "mum", displayName: "Mum", timezone: "America/Los_Angeles", techComfort: "low" });
  const wei = app.rooms.createPerson({ id: "wei", displayName: "Uncle Wei", timezone: "America/Los_Angeles" });

  const agent = newAgent({
    ownerId: ellie.id,
    name: "Pip",
    purpose: "Keep the family organised: Mum's appointments, rides, repairs, and help her with her phone.",
    model: opts.modelId,
  });
  app.store.putAgent(agent);
  app.memory.write({ agentId: agent.id, scope: "agent", scopeId: agent.id, type: "rule", text: "Ask before calling anyone; keep messages short." });
  app.memory.write({ agentId: agent.id, scope: "person", scopeId: ellie.id, type: "preference", text: "Ellie prefers morning appointments for Mum.", visibleToRooms: [] });

  const family = app.rooms.createRoom({ agentId: agent.id, kind: "group", channel: "console", name: "Family" });
  app.rooms.addMember(family.id, ellie.id, "owner", { consented: true });
  app.rooms.addMember(family.id, ben.id, "decider", { consented: true });
  app.rooms.addMember(family.id, mum.id, "cared_for");
  app.rooms.addMember(family.id, wei.id, "guest");
  app.memory.write({ agentId: agent.id, scope: "person", scopeId: mum.id, type: "person", text: "Mum speaks Mandarin and English; prefers Mandarin on the phone with strangers. She lives in San Jose.", visibleToRooms: [family.id] });

  const ellieDm = app.rooms.dmFor(agent, ellie.id);
  const benDm = app.rooms.dmFor(agent, ben.id);
  const rooms: Record<string, string> = { family: family.id, ellieDm: ellieDm.id, benDm: benDm.id };

  return { app, clock, agent, family, ellieDm, benDm, ellie, ben, mum, wei, hands, deliveries, roomId: (key) => rooms[key] ?? key };
}
