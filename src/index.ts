import { openDb, dialect } from "./db";
import { seedFirstParty } from "./templates";
import { recover, engine } from "./runtime";
import { serve, worker, checkAlerts } from "./server";
import { ensureSharedIdentities } from "./channels";
import { startPhoton } from "./photon";

// Production readiness: refuse to start half-configured rather than serve fake agents or lose secrets.
if (process.env.NODE_ENV === "production" || process.env.PRODUCTION === "1") {
  const missing = [
    !(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) && "a model key (OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY)",
    !process.env.MASTER_KEY && "MASTER_KEY (encrypts stored credentials)",
    !process.env.DATABASE_URL && "DATABASE_URL (Postgres)",
    !process.env.PUBLIC_URL && "PUBLIC_URL (public https address for webhooks and sign-in)",
  ].filter(Boolean);
  if (missing.length) { console.error(`[boot] not starting — production needs:\n  - ${missing.join("\n  - ")}`); process.exit(1); }
}
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
setInterval(() => checkAlerts().catch((e) => console.error("[alert] check failed", e.message)), 5 * 60_000);
console.log(`Agent platform running at ${server.url} (${dialect}, ${engine.temporal() ? "temporal" : "local"} engine)`);
