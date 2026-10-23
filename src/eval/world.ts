/**
 * The group every test and eval scenario runs in: Alex (owner), Sam (member
 * who consented to their own accounts being used), Jo (member, not comfortable
 * with technology), Riley (guest), and the agent Pip. The model is whatever the
 * caller passes (scripted offline, or the configured real one) and the hands are
 * fakes a scenario seeds before its turns.
 */
import { newAgent } from "../agent/spec.ts";
import { type App, createApp } from "../app.ts";
import { FakeClock } from "../core/clock.ts";
import type { AgentSpec, Person, Room } from "../core/types.ts";
import type { ModelClient } from "../model/types.ts";
import type { Delivery } from "../runtime/runtime.ts";
import { type FakeHands, fakeHands } from "../tools/hands.ts";

export interface EvalWorld {
  app: App;
  clock: FakeClock;
  agent: AgentSpec;
  room: Room;
  ownerDm: Room;
  samDm: Room;
  alex: Person;
  sam: Person;
  jo: Person;
  riley: Person;
  hands: FakeHands;
  deliveries: Delivery[];
  /** Resolve a scenario's room key to a room id; an unknown key is taken as a raw id. */
  roomId(key: RoomKey): string;
  /** Name a room a scenario created in setup, so its turns can use the name as a key. */
  alias(key: string, roomId: string): void;
  /** The key a room id was registered under, for readable turn records. */
  keyOf(roomId: string): string;
}

export type RoomKey = "room" | "ownerDm" | "samDm" | (string & {});

export interface WorldOptions {
  model: ModelClient;
  /** Overrides the agent's model id (what the runtime asks the client for). */
  modelId?: string;
  maxTurns?: number;
  /** Fakes to seed up front; a scenario may also swap them in setup(). */
  hands?: Partial<FakeHands>;
  /** Boot-level providers wired on the server. Default: every hand (the fakes are all "wired"). */
  providers?: string[];
  /** A different skills folder: the harness loop probes candidate rules and procedures this way. */
  skillsDir?: string;
}

/** 10:00 in Los Angeles on Tuesday 13 October 2026; every world starts here. */
export const WORLD_START = Date.UTC(2026, 9, 13, 17, 0, 0);

export function evalWorld(opts: WorldOptions): EvalWorld {
  const clock = new FakeClock(WORLD_START);
  const hands = fakeHands(opts.hands);
  // A day between heartbeats keeps the scheduler out of the way unless a test advances to it.
  const app = createApp({ clock, model: opts.model, hands, heartbeatEveryMs: 24 * 3600 * 1000, maxTurns: opts.maxTurns, providers: opts.providers, skillsDir: opts.skillsDir });
  const deliveries: Delivery[] = [];
  app.onDeliver((d) => deliveries.push(d));

  const alex = app.rooms.createPerson({ id: "alex", displayName: "Alex", timezone: "America/Los_Angeles", pronouns: "she/her" });
  const sam = app.rooms.createPerson({ id: "sam", displayName: "Sam", timezone: "America/Los_Angeles" });
  const jo = app.rooms.createPerson({ id: "jo", displayName: "Jo", timezone: "America/Los_Angeles", techComfort: "low" });
  const riley = app.rooms.createPerson({ id: "riley", displayName: "Riley", timezone: "America/Los_Angeles" });

  const agent = newAgent({ ownerId: alex.id, name: "Pip", model: opts.modelId, createdAt: clock.now() });
  app.store.putAgent(agent);
  app.memory.write({ agentId: agent.id, scope: "agent", scopeId: agent.id, type: "rule", text: "Ask before calling anyone; keep messages short." });
  app.memory.write({ agentId: agent.id, scope: "person", scopeId: alex.id, type: "preference", text: "Alex prefers morning appointments.", visibleToRooms: [] });

  const room = app.rooms.createRoom({
    agentId: agent.id,
    kind: "group",
    channel: "console",
    name: "Tahoe trip",
    focus: "The Tahoe trip in November: the cabin, who drives, splitting costs, and the odd repair at Jo's place.",
  });
  app.rooms.addMember(room.id, alex.id, "owner", { consented: true });
  app.rooms.addMember(room.id, sam.id, "member", { consented: true });
  app.rooms.addMember(room.id, jo.id, "member");
  app.rooms.addMember(room.id, riley.id, "guest");
  app.memory.write({
    agentId: agent.id,
    scope: "person",
    scopeId: jo.id,
    type: "person",
    text: "Jo speaks Mandarin and English; prefers Mandarin on the phone with strangers. Lives in San Jose.",
    visibleToRooms: [room.id],
  });

  const ownerDm = app.rooms.dmFor(agent, alex.id);
  const samDm = app.rooms.dmFor(agent, sam.id);
  const rooms: Record<string, string> = { room: room.id, ownerDm: ownerDm.id, samDm: samDm.id };

  return {
    app,
    clock,
    agent,
    room,
    ownerDm,
    samDm,
    alex,
    sam,
    jo,
    riley,
    hands,
    deliveries,
    roomId: (key) => rooms[key] ?? key,
    alias: (key, roomId) => {
      rooms[key] = roomId;
    },
    keyOf: (roomId) => Object.keys(rooms).find((k) => rooms[k] === roomId) ?? roomId,
  };
}
