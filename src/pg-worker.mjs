// Runs Postgres queries for the synchronous bridge in pg.ts. Plain JS so it loads in Bun and Node workers alike.
import { parentPort, workerData } from "node:worker_threads";
import postgres from "postgres";

const num = { to: 0, from: [20, 1700], serialize: String, parse: Number }; // int8 + numeric as JS numbers (counts, sums, ms timestamps)
const sql = postgres(workerData.url, { max: 1, onnotice: () => {}, types: { num }, connection: { application_name: "agents" } });

parentPort.on("message", async ({ q, params, port, flag }) => {
  let out;
  try {
    const r = await sql.unsafe(q, params.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : p)));
    out = { rows: [...r], count: r.count ?? 0 };
  } catch (e) { out = { error: e.message, code: e.code }; }
  port.postMessage(out);
  const f = new Int32Array(flag); Atomics.store(f, 0, 1); Atomics.notify(f, 0);
});
