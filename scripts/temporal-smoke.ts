// End-to-end check of the Temporal engine against a real Temporal server and Postgres (Node, via tsx):
//   DATABASE_URL=postgres://… bun run test:temporal      (needs `temporal server start-dev` running)
// Uses the offline model, so no API keys are needed.
import { Worker, NativeConnection } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
process.env.ENGINE = "temporal"; process.env.DEBOUNCE_MS = "0";
// Own task queue: a worker for another environment (e.g. a running dev stack) must never pick up the test's workflows.
process.env.TEMPORAL_TASK_QUEUE = `agent-runs-test-${process.pid}`;
const { setup, user, workspace, customAgent } = await import("../test/helpers");
const rt = await import("../src/runtime");
const { one, all } = await import("../src/db");
const activities = await import("../src/temporal/activities");
const { connectTemporal, TASK_QUEUE } = await import("../src/temporal/client");

if (!process.env.DATABASE_URL) throw new Error("set DATABASE_URL to a Postgres test database");
setup(); // fresh tables
const client = await connectTemporal();
const worker = await Worker.create({ connection: await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" }),
  taskQueue: TASK_QUEUE, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities });

const until = async (what: string, ok: () => boolean, ms = 20_000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 100)); } };
const status = (id: string) => one<any>("select status from runs where id=?", id)?.status;

await worker.runUntil(async () => {
  const u = user("Ellie"), ws = workspace("Team", u);
  // 1. A message becomes a workflow that completes the task.
  const a = customAgent(ws, u, ["reminders"]), room = rt.privateRoomFor(u, a);
  const { started: [r1] } = await rt.ingestMessage({ roomId: room.id, senderId: u, text: "remind me tomorrow to call mom", platform: "web" });
  await until("reminder run completes", () => status(r1) === "completed");
  assert.equal(await client.workflow.getHandle(`run-${r1}`).result(), "completed"); // the workflow itself finished, not just the DB row
  assert.ok(one("select 1 from schedules where agent_id=?", a.id), "reminder scheduled");
  console.log("✓ message → workflow → completed (reminder scheduled)");

  // 2. An approval parks the workflow durably; deciding it wakes the same workflow, which finishes the work.
  const b = customAgent(ws, u, ["task-tracking"], { "task.create": "always_ask" }, "Relay"), room2 = rt.privateRoomFor(u, b);
  const { started: [r2] } = await rt.ingestMessage({ roomId: room2.id, senderId: u, text: "Take care of the BLS follow-ups", platform: "web" });
  await until("run waits for approval", () => status(r2) === "waiting_for_human");
  assert.equal((await client.workflow.getHandle(`run-${r2}`).describe()).status.name, "RUNNING");
  const apr = one<any>("select id from approvals where run_id=? and status='pending'", r2);
  rt.decideApproval(apr.id, u, "approve");
  await until("approved run completes", () => status(r2) === "completed");
  assert.equal(await client.workflow.getHandle(`run-${r2}`).result(), "completed");
  assert.ok(one("select 1 from tasks where room_id=? and title like '%BLS%'", room2.id), "task created after approval");
  console.log("✓ approval parks the workflow; approving wakes it and the task is created");

  // 3. Requests in one conversation run in order, one at a time.
  const { started: [r3] } = await rt.ingestMessage({ roomId: room.id, senderId: u, text: "remind me in 2 hours to stretch", platform: "web" });
  const { started: [r4] } = await rt.ingestMessage({ roomId: room.id, senderId: u, text: "remind me in 3 hours to drink water", platform: "web" });
  await until("both complete", () => status(r3) === "completed" && status(r4) === "completed");
  const t3 = one<any>("select completed_at c from runs where id=?", r3).c, s4 = one<any>("select min(ts) t from run_steps where run_id=?", r4).t;
  assert.ok(s4 >= t3, "second request started only after the first finished");
  console.log("✓ same-conversation requests run in order");
});
console.log(`\nTemporal smoke: all checks passed (${all("select id from runs").length} runs)`);
process.exit(0);
