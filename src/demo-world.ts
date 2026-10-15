import type { App } from "./app.ts";
import { newAgent } from "./agent/spec.ts";

/** A family circle you can poke at in the web UI or the offline demo. */
export function seedDemoWorld(app: App) {
  const ellie = app.rooms.createPerson({ id: "ellie", displayName: "Ellie", timezone: "America/Los_Angeles", pronouns: "she/her" });
  const ben = app.rooms.createPerson({ id: "ben", displayName: "Ben", timezone: "America/Los_Angeles" });
  const mum = app.rooms.createPerson({ id: "mum", displayName: "Mum", timezone: "America/Los_Angeles", techComfort: "low" });
  const wei = app.rooms.createPerson({ id: "wei", displayName: "Uncle Wei", timezone: "America/Los_Angeles" });

  const agent = newAgent({
    ownerId: ellie.id,
    name: "Pip",
    trust: { autoApproveUnderUsd: 25 },
  });
  app.store.putAgent(agent);

  app.memory.write({ agentId: agent.id, scope: "agent", scopeId: agent.id, type: "rule", text: "Ask before calling or texting anyone outside the family." });
  app.memory.write({ agentId: agent.id, scope: "agent", scopeId: agent.id, type: "rule", text: "Keep messages short; one question at a time with Mum." });
  app.memory.write({
    agentId: agent.id,
    scope: "person",
    scopeId: ellie.id,
    type: "preference",
    text: "Ellie prefers Mum's appointments in the morning and wants to be cc'd on anything medical.",
  });
  app.memory.write({
    agentId: agent.id,
    scope: "person",
    scopeId: mum.id,
    type: "person",
    text: "Mum speaks Mandarin and English; prefers Mandarin on the phone with strangers.",
    visibleToRooms: [],
  });
  app.memory.write({
    agentId: agent.id,
    scope: "person",
    scopeId: mum.id,
    type: "lesson",
    text: "Taught Mum to send a photo in iMessage on 2026-10-02; she can find the camera button but gets stuck choosing from the library.",
    visibleToRooms: [],
  });

  const family = app.rooms.createRoom({
    agentId: agent.id,
    kind: "group",
    channel: "web",
    name: "Family",
    focus: "Mum's appointments and rides, repairs at her place, bills, and patient help with her phone.",
    outreachHours: { start: 8, end: 20 },
  });
  app.rooms.addMember(family.id, ellie.id, "owner", { consented: true });
  app.rooms.addMember(family.id, ben.id, "decider", { consented: true });
  app.rooms.addMember(family.id, mum.id, "cared_for");
  app.rooms.addMember(family.id, wei.id, "guest");
  // Mum's memories are visible in the family room (she is a member there).
  for (const m of app.store.listMemories(agent.id, { scope: "person", scopeId: mum.id })) {
    m.visibleToRooms = [family.id];
    app.store.putMemory(m);
  }
  const ellieDm = app.rooms.dmFor(agent, ellie.id);
  agent.deployedAt = app.clock.now();
  app.store.putAgent(agent);
  return { agent, family, ellieDm, ellie, ben, mum, wei };
}
