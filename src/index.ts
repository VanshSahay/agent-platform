import { migrate } from "./db";
import { serve } from "./server";
import * as im from "./imessage";
import * as agent from "./agent";
import { tick } from "./schedules";
import { repliedSince } from "./tools/google";
import { userById } from "./rooms";
import { consolidateDue } from "./consolidate";

if (process.env.NODE_ENV === "production") {
  const missing = [!process.env.OPENROUTER_API_KEY && "OPENROUTER_API_KEY", !process.env.MASTER_KEY && "MASTER_KEY", !process.env.DATABASE_URL && "DATABASE_URL", !process.env.PUBLIC_URL && "PUBLIC_URL"].filter(Boolean);
  if (missing.length) { console.error(`[boot] not starting; production needs ${missing.join(", ")}`); process.exit(1); }
}
for (let attempt = 1; ; attempt++) { // the database may still be waking up
  try { await migrate(); break; }
  catch (e: any) { if (attempt >= 12) throw e; console.warn(`[boot] database not ready (${String(e.message).slice(0, 80)}); retrying in 5s`); await Bun.sleep(5000); }
}
im.onMessage((ev) => agent.onInbound(ev).catch((e) => console.error("[agent] inbound failed", e)));
const server = serve();
await im.start();
setInterval(() => tick(agent.fireSchedule, async (userId, from, since) => repliedSince(await userById(userId), from, since)).catch((e) => console.error("[schedules]", e.message)), 30_000);
setInterval(() => consolidateDue().then((n) => n && console.log(`[consolidate] ${n} agent(s)`)).catch((e) => console.error("[consolidate]", e.message)), 60 * 60_000); // the nightly memory pass, checked hourly
console.log(`agent-platform on ${server.url}`);
