// Temporal workflow: one per agent run. Deterministic orchestration only — all I/O happens in the advanceRun activity.
// The run's state lives in Postgres; the workflow decides when to step it: now, at its next timer, or when woken
// (approval decided, reply arrived, "go", connection restored, its turn in the conversation).
import { proxyActivities, defineSignal, setHandler, condition, continueAsNew } from "@temporalio/workflow";
import type * as activities from "./activities";

const { advanceRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: "15 minutes", // a step = model call + tool calls (browser tasks can take minutes)
  retry: { initialInterval: "2s", backoffCoefficient: 2, maximumInterval: "1 minute", maximumAttempts: 5 },
});

export const wake = defineSignal("wake");

export async function agentRun(runId: string): Promise<string> {
  let woke = false;
  setHandler(wake, () => { woke = true; });
  for (let i = 0; i < 500; i++) {
    woke = false; // a wake that lands while the step runs is kept, so we loop again instead of sleeping through it
    const s = await advanceRun(runId);
    if (s.done) return s.status;
    if (s.status === "queued" && !s.blocked) continue;
    if (s.blocked) await condition(() => woke, "2 seconds"); // another request in this conversation goes first
    else if (s.nextWakeAt != null) await condition(() => woke, Math.max(1000, s.nextWakeAt - Date.now()));
    else await condition(() => woke); // waiting on a person or an external event
  }
  return continueAsNew<typeof agentRun>(runId); // keep event history bounded for very long-lived runs
}
