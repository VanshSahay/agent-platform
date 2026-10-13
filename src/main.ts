import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import { AnthropicModel } from "./model/anthropic.ts";
import type { ModelClient } from "./model/types.ts";
import { reply, ScriptedModel } from "./model/scripted.ts";
import { startWebServer } from "./channels/web.ts";
import { seedDemoWorld } from "./demo-world.ts";

/**
 * Boot: SQLite file, Anthropic model (or an offline stand-in when no
 * credentials are configured), fake hands unless real adapters are wired,
 * the web server, and a scheduler tick every 30 seconds.
 */
function pickModel(): ModelClient {
  // The SDK resolves credentials lazily (env key, auth token, or an `ant auth login` profile), so check up front.
  const hasCreds =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.ANTHROPIC_AUTH_TOKEN ||
    !!process.env.ANTHROPIC_FEDERATION_RULE_ID ||
    existsSync(join(homedir(), ".config", "anthropic"));
  if (hasCreds) return new AnthropicModel();
  console.warn("No model credentials found. Running offline: the agent will only acknowledge messages. Set ANTHROPIC_API_KEY or run `ant auth login`, then restart.");
  return new ScriptedModel(() => reply("I'm running without a model key, so I can only acknowledge this. Set ANTHROPIC_API_KEY and restart me."), () => "");
}

const dbPath = process.env.DB_PATH ?? "data/circle.sqlite";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const app = createApp({ dbPath, model: pickModel() });

if (process.env.SEED_DEMO === "1" && app.store.listAgents().length === 0) {
  const w = seedDemoWorld(app);
  console.log(`Seeded demo world: agent ${w.agent.name} (${w.agent.id}), room ${w.family.name} (${w.family.id})`);
}

const server = startWebServer(app);
console.log(`Circle listening on http://localhost:${server.port}`);

setInterval(() => {
  app.scheduler.tick().catch((e) => console.error("tick failed", e));
}, Number(process.env.TICK_MS ?? 30_000));

// Nightly memory pass at 03:00 server time.
setInterval(
  async () => {
    const h = new Date().getHours();
    if (h !== 3) return;
    for (const agent of app.store.listAgents()) {
      const last = Number(app.store.getKv(`consolidated:${agent.id}`) ?? 0);
      if (Date.now() - last < 20 * 3600 * 1000) continue;
      await app.consolidator.runFor(agent).catch((e) => console.error("consolidate failed", e));
    }
  },
  10 * 60 * 1000,
);
