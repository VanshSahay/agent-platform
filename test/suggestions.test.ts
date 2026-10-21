import { describe, expect, test } from "bun:test";
import { SuggestionService } from "../src/inbox/suggestions.ts";
import { reply } from "../src/model/scripted.ts";
import { groupWorld } from "./helpers.ts";

describe("room starters", () => {
  test("names come from what the assistant knows, skip chats that exist, are cached a day, and are absent for a stranger", async () => {
    const w = groupWorld(() => reply("ok"), { completer: (system) => (system.startsWith("Propose names") ? '["Mum\'s care circle", "Tahoe trip", "Sunday dinners"]' : "") });
    const svc = new SuggestionService(w.app.store, w.clock, w.app.commitments, w.model);
    w.app.memory.write({ agentId: w.agent.id, scope: "person", scopeId: "alex", type: "fact", text: "Alex organises her mother Jo's care with Sam." });
    const names = await svc.roomStarters(w.alex, w.agent);
    expect(names).toEqual(["Mum's care circle", "Sunday dinners"]); // "Tahoe trip" already exists
    await svc.roomStarters(w.alex, w.agent);
    expect(w.model.completions.filter((c) => c.system.startsWith("Propose names"))).toHaveLength(1);
    const stranger = w.app.rooms.createPerson({ id: "zed", displayName: "Zed", timezone: "UTC" });
    expect(await svc.roomStarters(stranger, w.agent)).toEqual([]);
    expect(w.model.completions.filter((c) => c.system.startsWith("Propose names"))).toHaveLength(1);
  });
});
