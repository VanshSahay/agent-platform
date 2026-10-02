import { openDb } from "./db";
import { seedFirstParty } from "./templates";
import { recover } from "./runtime";
import { serve, worker } from "./server";

openDb();
seedFirstParty();
const recovered = recover();
if (recovered) console.log(`[boot] re-queued ${recovered} interrupted runs`);
const server = serve();
setInterval(worker, 1000); // timers, schedules, retries, outbox
console.log(`Agent platform running at ${server.url}`);
