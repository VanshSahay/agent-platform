import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newAgent } from "../src/agent/spec.ts";
import { createApp } from "../src/app.ts";
import { FakeClock } from "../src/core/clock.ts";
import { callTool, reply, ScriptedModel, transcriptHas } from "../src/model/scripted.ts";
import { FakeSearch, fakeHands } from "../src/tools/hands.ts";

describe("restart", () => {
  test("a delegated task cut off by a restart starts again with its notes and still reports to the room", async () => {
    const dbPath = join(tmpdir(), `circle-restart-${Date.now()}.sqlite`);
    const model = new ScriptedModel((req) =>
      transcriptHas(req, "interrupted by a restart") ? reply("Shortlist: Mirador $65, Nason Moretti $124.") : callTool("web_search", { query: "wine glass" }),
    );
    const hands = fakeHands({ search: new FakeSearch(() => [{ title: "Mirador", url: "https://m.example", snippet: "$65" }]) });
    const clock = new FakeClock(Date.UTC(2026, 9, 20, 12));
    // First process: a task is mid-work when the process dies.
    const a = createApp({ dbPath, clock, model, hands });
    const alex = a.rooms.createPerson({ id: "alex", displayName: "Alex", timezone: "UTC" });
    const agent = newAgent({ ownerId: alex.id, name: "Pip" });
    a.store.putAgent(agent);
    const room = a.rooms.createRoom({ agentId: agent.id, kind: "dm", channel: "web", name: "Pip & Alex" });
    a.rooms.addMember(room.id, alex.id, "owner", { consented: true });
    const session = { id: "ses_1", roomId: room.id, agentId: agent.id, kind: "room" as const, createdAt: clock.now(), lastActivityAt: clock.now() };
    a.store.putSession(session);
    const task = a.tasks.create({ agentId: agent.id, roomId: room.id, requesterId: alex.id, title: "Price the glasses", instructions: "Find prices for unique red wine glasses." });
    a.store.putRun({
      id: "run_cut",
      sessionId: session.id,
      roomId: room.id,
      agentId: agent.id,
      trigger: "task",
      requesterId: alex.id,
      status: "running",
      taskId: task.id,
      startedAt: clock.now(),
    });
    a.tasks.update(task.id, { runId: "run_cut", status: "running", progress: "Found Mirador at $65." });

    // Second process over the same database: the cut run is failed, the task runs again and reports once.
    const b = createApp({ dbPath, clock, model, hands });
    const delivered: string[] = [];
    b.onDeliver((d) => {
      if (d.roomId === room.id && d.kind === "reply") delivered.push(d.text);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.store.getRun("run_cut")?.status).toBe("failed");
    const after = b.store.getTask(task.id)!;
    expect(after.status).toBe("done");
    expect(after.delivered.map((d) => d.text)).toEqual(["Shortlist: Mirador $65, Nason Moretti $124."]);
    expect(delivered[0]).toContain("Shortlist");
    expect(b.store.getRun(after.runId!)?.status).toBe("done");
  });

  test("a task an earlier boot already failed as interrupted gets one more run", async () => {
    const dbPath = join(tmpdir(), `circle-restart2-${Date.now()}.sqlite`);
    const model = new ScriptedModel((req) => (transcriptHas(req, "interrupted by a restart") ? reply("Done: three glasses priced.") : callTool("web_search", { query: "x" })));
    const clock = new FakeClock(Date.UTC(2026, 9, 20, 12));
    const a = createApp({ dbPath, clock, model, hands: fakeHands() });
    const alex = a.rooms.createPerson({ id: "alex", displayName: "Alex", timezone: "UTC" });
    const agent = newAgent({ ownerId: alex.id, name: "Pip" });
    a.store.putAgent(agent);
    const room = a.rooms.createRoom({ agentId: agent.id, kind: "dm", channel: "web", name: "Pip & Alex" });
    a.rooms.addMember(room.id, alex.id, "owner", { consented: true });
    a.store.putSession({ id: "ses_2", roomId: room.id, agentId: agent.id, kind: "room", createdAt: clock.now(), lastActivityAt: clock.now() });
    const task = a.tasks.create({ agentId: agent.id, roomId: room.id, requesterId: alex.id, title: "Price", instructions: "Price them." });
    a.tasks.update(task.id, { status: "failed", progress: "Interrupted by a restart." });
    const b = createApp({ dbPath, clock, model, hands: fakeHands() });
    await new Promise((r) => setTimeout(r, 100));
    const after = b.store.getTask(task.id)!;
    expect(after.status).toBe("done");
    expect(after.delivered.map((d) => d.text)).toEqual(["Done: three glasses priced."]);
    // Once finished for real, another boot leaves it alone.
    const c = createApp({ dbPath, clock, model, hands: fakeHands() });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.store.getTask(task.id)!.delivered).toHaveLength(1);
  });
});
