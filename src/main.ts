import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import type { ModelClient } from "./model/types.ts";
import { reply, ScriptedModel } from "./model/scripted.ts";
import { createModel, modelConfig } from "./model/config.ts";
import { authConfig } from "./channels/auth.ts";
import { startWebServer } from "./channels/web.ts";
import { startIMessage } from "./channels/imessage.ts";
import { seedDemoWorld } from "./demo-world.ts";
import { fakeHands, type Hands } from "./tools/hands.ts";
import { BrowserbaseBrowser } from "./tools/browser.ts";
import { createSearch } from "./tools/search.ts";
import { JinaReader } from "./tools/reach.ts";

/**
 * Boot. What is wired depends on what is configured:
 *  - model: OPENROUTER_API_KEY (GLM 5.3 by default) or ANTHROPIC_API_KEY; otherwise an offline stand-in
 *  - browser hand: BROWSERBASE_API_KEY; otherwise a fake
 *  - iMessage: PROJECT_ID + PROJECT_SECRET (Photon Spectrum); otherwise web only
 *  - sign-in: CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY; otherwise the UI trusts the "You" picker
 *  - listening: HOST and PORT; without Clerk the server binds to loopback only
 * Search, phone and community posting are still fakes; see src/tools/hands.ts.
 */
function pickModel(): ModelClient {
  const env = { ...process.env, ANTHROPIC_PROFILE_PRESENT: existsSync(join(homedir(), ".config", "anthropic")) ? "1" : "" };
  const cfg = modelConfig(env);
  const m = createModel(cfg, env);
  if (m) {
    console.log(`Model: ${cfg.model} (small: ${cfg.smallModel}) via ${cfg.provider}`);
    return m;
  }
  console.warn("No model credentials found. Running offline: the agent will only acknowledge messages. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY, then restart.");
  return new ScriptedModel(
    () => reply("I'm running without a model key, so I can only acknowledge this. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY and restart me."),
    () => "",
  );
}

function pickHands(): Hands {
  const hands: Hands = fakeHands();
  if (process.env.BROWSERBASE_API_KEY) {
    hands.browser = new BrowserbaseBrowser(process.env.BROWSERBASE_API_KEY, { projectId: process.env.BROWSERBASE_PROJECT_ID });
    console.log("Browser: Browserbase");
  } else {
    hands.browser = new JinaReader();
    console.log("Browser: Jina Reader (read-only pages; set BROWSERBASE_API_KEY for a real browser)");
  }
  const search = createSearch(process.env);
  hands.search = search;
  console.log(`Search: ${search.name === "brave" ? "Brave" : search.name === "exa" ? "Exa (keyless, via the Agent Reach channel)" : "DuckDuckGo (keyless)"}`);
  console.log("Phone, community: fakes (adapters in src/tools/hands.ts)");
  return hands;
}

const dbPath = process.env.DB_PATH ?? "data/circle.sqlite";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
if (!process.env.MASTER_KEY) console.log("Vault: MASTER_KEY not set; members' credentials are encrypted with a dev key (set MASTER_KEY in production)");
const app = createApp({ dbPath, model: pickModel(), hands: pickHands(), masterKey: process.env.MASTER_KEY });

if (process.env.SEED_DEMO === "1" && app.store.listAgents().length === 0) {
  const w = seedDemoWorld(app);
  app.store.setKv("claim-owner", w.agent.ownerId); // the first Clerk sign-in becomes this owner
  console.log(`Seeded demo world: agent ${w.agent.name} (${w.agent.id}), room ${w.family.name} (${w.family.id})`);
}

// Without sign-in the API trusts whoever it is talking to, so it may only talk to this machine.
const clerk = !!authConfig();
const host = process.env.HOST ?? (clerk ? "0.0.0.0" : "127.0.0.1");
const loopback = /^(127\.|localhost$|::1$)/.test(host);
if (!loopback && !clerk) {
  console.error(
    `Refusing to listen on ${host}: sign-in is off (set CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY), so anyone who can reach this port could act as anyone. Leave HOST unset to stay on 127.0.0.1.`,
  );
  process.exit(1);
}
if (!loopback && !process.env.MASTER_KEY) {
  console.error(
    `Refusing to listen on ${host}: MASTER_KEY is not set, so members' credentials would be encrypted with the dev key. Set MASTER_KEY, or leave HOST unset to stay on 127.0.0.1.`,
  );
  process.exit(1);
}
if (!process.env.EVENT_TOKEN)
  console.log(`Events: EVENT_TOKEN not set; POST /api/events and /api/tick accept only a signed-in agent owner${clerk ? "" : " (or anyone, since sign-in is off)"}`);
const server = startWebServer(app, { hostname: host, port: Number(process.env.PORT ?? 3000) });
console.log(`Circle listening on http://${host}:${server.port}${clerk ? " (Clerk sign-in on)" : ""}`);

if (process.env.PROJECT_ID && process.env.PROJECT_SECRET) {
  startIMessage(app, { projectId: process.env.PROJECT_ID, projectSecret: process.env.PROJECT_SECRET })
    .then((im) => console.log(`iMessage: connected${im.phone ? ` as ${im.phone}` : ""}`))
    .catch((e) => console.error("iMessage: failed to start", e));
} else console.log("iMessage: off (set PROJECT_ID and PROJECT_SECRET)");

setInterval(
  () => {
    app.scheduler.tick().catch((e) => console.error("tick failed", e));
  },
  Number(process.env.TICK_MS ?? 30_000),
);

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
