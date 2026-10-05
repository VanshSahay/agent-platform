// Temporal worker (Node, via tsx — Temporal's SDK isn't supported on Bun). Run: bun run worker
// Scale by running more of these; they share Postgres and Temporal, and a run is only ever stepped by one of them.
import { Worker, NativeConnection } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import * as activities from "./activities";
import { connectTemporal, TASK_QUEUE } from "./client";

process.env.ENGINE = "temporal";
const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
await connectTemporal(); // runs created inside a step (delegation) start their own workflows
const worker = await Worker.create({
  connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default", taskQueue: TASK_QUEUE,
  workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)), activities,
  maxConcurrentActivityTaskExecutions: Number(process.env.WORKER_CONCURRENCY ?? 8),
});
console.log(`[temporal] worker on ${TASK_QUEUE}`);
await worker.run();
