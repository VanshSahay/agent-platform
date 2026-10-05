// Start-or-wake a run's workflow. Used by the API server (inbound messages, approvals) and by workers (runs created inside
// a step, e.g. delegation), so every path that makes a run runnable reaches Temporal.
import { Client, Connection } from "@temporalio/client";
import { all } from "../db";
import * as rt from "../runtime";

export const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "agent-runs";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
let client: Client | null = null;

export async function connectTemporal() {
  if (client) return client;
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
  client = new Client({ connection, namespace: NAMESPACE });
  rt.engine.onQueued = (runId) => { wakeRun(runId).catch((e) => console.error("[temporal] wake failed", runId, e.message)); };
  return client;
}

export function wakeRun(runId: string) {
  // signalWithStart: starts the workflow if it isn't running, otherwise just signals it. Idempotent by workflow id.
  return client!.workflow.signalWithStart("agentRun", { workflowId: `run-${runId}`, taskQueue: TASK_QUEUE, args: [runId], signal: "wake", signalArgs: [] });
}

/** On boot: every unfinished run gets (or keeps) its workflow — covers anything created while Temporal was unreachable. */
export async function reconcile() {
  const open = all<any>("select id from runs where status not in ('completed','failed_terminal','cancelled')");
  for (const r of open) await wakeRun(r.id).catch((e) => console.error("[temporal] reconcile", r.id, e.message));
  return open.length;
}
