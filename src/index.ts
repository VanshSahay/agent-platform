import { openDb, dialect } from "./db";
import { seedFirstParty } from "./templates";
import { recover, engine } from "./runtime";
import { serve, worker } from "./server";
import { ensureSharedIdentities } from "./channels";
import { startPhoton } from "./photon";

openDb();
seedFirstParty();
ensureSharedIdentities();
if (engine.temporal()) {
  // Production shape: runs are Temporal workflows stepped by `bun run worker` processes; this process serves the API,
  // channels and housekeeping. Workers and server must share Postgres.
  if (dialect !== "pg") throw new Error("ENGINE=temporal needs DATABASE_URL (Postgres)");
  const { connectTemporal, reconcile } = await import("./temporal/client");
  await connectTemporal();
  console.log(`[boot] temporal: ${await reconcile()} unfinished runs handed to workflows`);
} else {
  const recovered = recover();
  if (recovered) console.log(`[boot] re-queued ${recovered} interrupted runs`);
}
const server = serve();
await startPhoton();
setInterval(worker, 1000); // inbound, outbox, schedules, watches (and run steps, on the local engine)
console.log(`Agent platform running at ${server.url} (${dialect}, ${engine.temporal() ? "temporal" : "local"} engine)`);
