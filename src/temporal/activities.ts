// Temporal activities: thin wrappers over the runtime, which already persists every step in Postgres.
import { openDb, dialect } from "../db";
import * as rt from "../runtime";

let ready = false;
function db() {
  if (ready) return;
  if (!process.env.DATABASE_URL) throw new Error("ENGINE=temporal needs DATABASE_URL (Postgres): workers and the server share one database");
  openDb(); ready = dialect === "pg";
}

export async function advanceRun(runId: string) {
  db();
  return rt.advanceRun(runId);
}
