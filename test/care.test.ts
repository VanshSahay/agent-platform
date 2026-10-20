import { describe, expect, test } from "bun:test";
import { callTool, reply } from "../src/model/scripted.ts";
import { groupWorld, sysText } from "./helpers.ts";
import { DAY } from "../src/core/clock.ts";
import { SuggestionService } from "../src/inbox/suggestions.ts";

describe("one general assistant, priorities per chat", () => {
  test("the owner's private chat is an ordinary thread: no special mode, rules and notes apply everywhere", async () => {
    const w = groupWorld((_req, i) => (i === 0 ? callTool("remember", { type: "rule", text: "Never call anyone before 9am.", scope: "agent" }) : reply("Noted.")));
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "rule: never call anyone before 9am" });
    const sys = sysText(w.model.calls[0]!);
    expect(sys).not.toContain("Getting to know");
    expect(sys).not.toContain("Training");
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "@pip hi" });
    expect(sysText(w.model.calls.at(-1)!)).toContain("Never call anyone before 9am");
  });

  test("a chat's priorities come first there and the assistant stays general; it can be in several chats, each tracked", async () => {
    const w = groupWorld(() => reply("ok"));
    await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "alex", text: "@pip hi" });
    const sys = sysText(w.model.calls.at(-1)!);
    expect(sys).toContain("Priorities in this chat: The Tahoe trip");
    expect(sys).toContain("still a general assistant");
    expect(sys).toContain("personal assistant");
    await w.app.runtime.handleMessage({ roomId: w.ownerDm.id, personId: "alex", text: "hi" });
    expect(sysText(w.model.calls.at(-1)!)).not.toContain("Priorities in this chat");
    const street = w.app.rooms.createRoom({
      agentId: w.agent.id,
      kind: "group",
      channel: "web",
      name: "Maple Street",
      focus: "Shared tools, the street party, and who is away when.",
    });
    w.app.rooms.addMember(street.id, "alex", "owner", { consented: true });
    await w.app.runtime.handleMessage({ roomId: street.id, personId: "alex", text: "@pip hi" });
    expect(sysText(w.model.calls.at(-1)!)).toContain("Priorities in this chat: Shared tools");
    expect(sysText(w.model.calls.at(-1)!)).not.toContain("The Tahoe trip in November");
    const groups = w.app.store.listRooms(w.agent.id).filter((r) => r.kind === "group");
    expect(groups.map((r) => [r.name, r.focus?.slice(0, 12)])).toEqual([
      ["Tahoe trip", "The Tahoe tr"],
      ["Maple Street", "Shared tools"],
    ]);
  });

  test("the un-named request check knows the chat's priorities and that the assistant is general", async () => {
    const seen: string[] = [];
    const w = groupWorld(() => reply("Sure."), {
      completer: (system) => {
        if (system.includes("Answer with exactly yes or no")) seen.push(system);
        return "yes";
      },
    });
    expect(await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "Can someone find a good tax accountant near us?" })).toBeDefined();
    expect(seen[0]).toContain("general personal assistant");
    expect(seen[0]).toContain("priorities are: The Tahoe trip");
  });
});

describe("answering without being named", () => {
  test("in a group, a message within the agent's purpose starts a run when the small model says so", async () => {
    const w = groupWorld(() => reply("I can look for one."), {
      completer: (system, prompt) => (system.includes("Answer with exactly yes or no") ? (prompt.includes("plumber") ? "yes" : "no") : ""),
    });
    expect(await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "Does anyone know a good plumber near Jo's place?" })).toBeDefined();
    expect(await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "Great match last night, did you watch it everyone?" })).toBeUndefined();
    expect(await w.app.runtime.handleMessage({ roomId: w.room.id, personId: "sam", text: "lol" })).toBeUndefined();
    expect(w.model.completions.filter((c) => c.system.includes("exactly yes or no"))).toHaveLength(2);
  });
});

describe("suggestions", () => {
  test("cards are mined from the ledger and schedules, with model ideas filling in", async () => {
    const w = groupWorld(() => reply("ok"), {
      completer: (system) => (system.includes("suggest things") ? '[{"title":"Book the boiler service","prompt":"Book the annual boiler service at Jo\'s."}]' : ""),
    });
    const svc = new SuggestionService(w.app.store, w.clock, w.app.commitments, w.model);
    w.app.commitments.track({ roomId: w.room.id, agentId: w.agent.id, ownerId: "sam", beneficiaryId: "jo", title: "Drive Jo to cardiology", dueAt: w.clock.now() + DAY });
    w.app.commitments.track({ roomId: w.room.id, agentId: w.agent.id, ownerId: "riley", title: "Fix the gate latch", dueAt: w.clock.now() - DAY });
    const cards = await svc.forHome(w.app.store.getPerson("alex")!, w.agent);
    expect(cards.map((c) => c.category)).toEqual(["follow-up", "upcoming", "idea"]);
    expect(cards[1]!.prompt).toContain("Sam");
    expect(cards[2]!.title).toBe("Book the boiler service");
  });
});
