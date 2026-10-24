import { hourIn } from "./core/clock.ts";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { backup, restoreIfStaged } from "./ops/backup.ts";
import { createApp } from "./app.ts";
import type { ModelClient } from "./model/types.ts";
import { reply, ScriptedModel } from "./model/scripted.ts";
import { createModel, modelConfig } from "./model/config.ts";
import { AnthropicModel } from "./model/anthropic.ts";
import { SpendLog } from "./runtime/spend.ts";
import { authConfig } from "./channels/auth.ts";
import { startWebServer } from "./channels/web.ts";
import { SPECTRUM_CHANNELS, type SpectrumChannel, startChannel } from "./channels/imessage.ts";
import type { ChannelInfo } from "./channels/web.ts";
import { newAgent } from "./agent/spec.ts";
import { fakeHands, type Hands } from "./tools/hands.ts";
import { BrowserbaseBrowser, FallbackBrowser, LocalBrowser, localChromePath } from "./tools/browser.ts";
import { createSearch } from "./tools/search.ts";
import { JinaReader } from "./tools/reach.ts";
import { LiteApi, LiteApiFlights } from "./tools/providers/liteapi.ts";
import { ApifyFlights, publicRatesFrom } from "./tools/providers/public-rates.ts";
import { GoogleApi } from "./tools/providers/google.ts";
import { AgentMail, ResendMail } from "./tools/providers/email.ts";
import { ElevenLabsSpeech, OpenRouterImages, SlackApi, SmsOnlyPhone, StripeIssuing, TwilioSms, VapiPhone } from "./tools/providers/misc.ts";
import { FakeEmail } from "./tools/hands.ts";

/**
 * Boot. What is wired depends on what is configured:
 *  - model: OPENROUTER_API_KEY (GLM 5.3 by default) or ANTHROPIC_API_KEY; otherwise an offline stand-in
 *  - browser hand: BROWSERBASE_API_KEY; otherwise a fake
 *  - iMessage: PROJECT_ID + PROJECT_SECRET (Photon Spectrum); otherwise web only
 *  - sign-in: CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY; otherwise the UI trusts the "You" picker
 *  - listening: HOST and PORT; without Clerk the server binds to loopback only
 * Search, phone and community posting are still fakes; see src/tools/hands.ts.
 */
// LOCAL=1: a safe local run whatever else .env holds. Sign-in and iMessage off, loopback only, the "You" picker on.
if (process.env.LOCAL === "1") {
  for (const k of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "PROJECT_ID", "PROJECT_SECRET", "HOST", "PUBLIC_URL"]) delete process.env[k];
  console.log("LOCAL=1: sign-in and iMessage off, listening on loopback with the You picker");
}

// What each run costs: model calls, Apify runs, browser seconds. Hands are built before the database opens, so the log attaches later.
const spend = new SpendLog();

function pickModel(): ModelClient {
  const env = { ...process.env, ANTHROPIC_PROFILE_PRESENT: existsSync(join(homedir(), ".config", "anthropic")) ? "1" : "" };
  const cfg = modelConfig(env);
  const m = createModel(cfg, env);
  if (m) {
    console.log(`Model: ${cfg.model} (small: ${cfg.smallModel}) via ${cfg.provider}`);
    if (m instanceof AnthropicModel)
      m.onUsage = (u) =>
        spend.record({
          provider: "openrouter",
          usd: u.usd ?? 0,
          units: `${u.input} in / ${u.output} out tokens`,
          runId: u.runId,
          note: u.usd === undefined ? `${u.model}; no cost in response` : u.model,
        });
    return m;
  }
  console.warn("No model credentials found. Running offline: the agent will only acknowledge messages. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY, then restart.");
  return new ScriptedModel(
    () => reply("I'm running without a model key, so I can only acknowledge this. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY and restart me."),
    () => "",
  );
}

function pickHands(): { hands: Hands; providers: string[] } {
  const hands: Hands = fakeHands();
  const providers: string[] = [];
  const env = process.env;
  // Google Workspace: one OAuth app; each person connects their own account in Settings.
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    hands.google = new GoogleApi({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
    providers.push("google");
    console.log("Google: OAuth app configured (people connect under Settings)");
  } else console.log("Google: off (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)");
  if (env.AGENTMAIL_API_KEY && env.AGENTMAIL_INBOX) {
    hands.email = new AgentMail(env.AGENTMAIL_API_KEY, env.AGENTMAIL_INBOX);
    providers.push("email");
    console.log(`Email: AgentMail inbox ${env.AGENTMAIL_INBOX} (send and receive)`);
  } else if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    hands.email = new ResendMail(env.RESEND_API_KEY, env.EMAIL_FROM);
    providers.push("email");
    console.log(`Email: Resend from ${env.EMAIL_FROM} (send only)`);
  } else console.log("Email: fake (set AGENTMAIL_API_KEY + AGENTMAIL_INBOX, or RESEND_API_KEY + EMAIL_FROM)");
  hands.slack = new SlackApi(); // tokens are per person, in the vault
  if (env.ELEVENLABS_API_KEY) {
    hands.speech = new ElevenLabsSpeech(env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID);
    providers.push("speech");
  }
  if (env.OPENROUTER_API_KEY) {
    hands.images = new OpenRouterImages(env.OPENROUTER_API_KEY, env.IMAGE_MODEL);
    providers.push("images");
  }
  if (env.STRIPE_SECRET_KEY) {
    hands.payments = new StripeIssuing(env.STRIPE_SECRET_KEY, env.STRIPE_CARDHOLDER_ID);
    providers.push("payments");
  }
  const twilio =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM
      ? new TwilioSms({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM })
      : undefined;
  if (env.VAPI_API_KEY && env.VAPI_PHONE_NUMBER_ID) {
    hands.phone = new VapiPhone({ apiKey: env.VAPI_API_KEY, phoneNumberId: env.VAPI_PHONE_NUMBER_ID }, twilio);
    providers.push("phone");
  } else if (twilio) {
    hands.phone = new SmsOnlyPhone(twilio);
    providers.push("phone");
  }
  console.log(
    `Phone: ${env.VAPI_API_KEY ? "Vapi calls" : "no calls"}, ${twilio ? "Twilio SMS" : "no SMS"}; speech: ${env.ELEVENLABS_API_KEY ? "ElevenLabs" : "fake"}; images: ${env.OPENROUTER_API_KEY ? "OpenRouter" : "fake"}; cards: ${env.STRIPE_SECRET_KEY ? "Stripe Issuing" : "fake"}`,
  );
  // Browsers in the order to try: a local Chrome first when developing (free, instant), Browserbase for
  // signed-in contexts and the live sign-in view, Jina as the read-only floor so a page is never unreadable.
  const browsers: { name: string; browser: import("./tools/browser.ts").BrowserProvider }[] = [];
  const chrome = localChromePath();
  if (chrome && process.env.LOCAL === "1") browsers.push({ name: "chrome", browser: new LocalBrowser(chrome) });
  if (process.env.BROWSERBASE_API_KEY)
    browsers.push({ name: "browserbase", browser: new BrowserbaseBrowser(process.env.BROWSERBASE_API_KEY, { projectId: process.env.BROWSERBASE_PROJECT_ID, spend }) });
  if (chrome && process.env.LOCAL !== "1") browsers.push({ name: "chrome", browser: new LocalBrowser(chrome) });
  browsers.push({ name: "jina", browser: new JinaReader() });
  hands.browser = browsers.length === 1 ? browsers[0]!.browser : new FallbackBrowser(browsers);
  if (process.env.BROWSERBASE_API_KEY || chrome) providers.push("browser"); // a browser that can act, not just read
  console.log(`Browser: ${browsers.map((b) => b.name).join(" → ")}${browsers.some((b) => b.name === "browserbase") ? "" : " (set BROWSERBASE_API_KEY for sign-in cards)"}`);
  if (env.LITEAPI_API_KEY) {
    hands.hotels = new LiteApi(env.LITEAPI_API_KEY, spend);
    hands.flights = new LiteApiFlights(env.LITEAPI_API_KEY);
    providers.push("hotels", "flights"); // without the key the fakes' canned offers must never reach a real person
    console.log(`Hotels: LiteAPI${env.LITEAPI_API_KEY.startsWith("sand_") ? " sandbox (live rates, no booking)" : ""}`);
  } else console.log("Hotels: fake (set LITEAPI_API_KEY)");
  // Public prices to compare against: Booking.com by hotel name through Apify when keyed (PUBLIC_RATES=google for Google's ladder).
  const pubRates = publicRatesFrom(env, hands.browser, spend);
  hands.publicRates = pubRates.hand;
  // Without Apify there is no public flight price: an honest error, never the fake's canned fares.
  hands.publicFlights = env.APIFY_TOKEN
    ? new ApifyFlights(env.APIFY_TOKEN, undefined, spend)
    : {
        async search() {
          throw new Error("public flight prices are not configured (set APIFY_TOKEN)");
        },
      };
  console.log(`Public hotel prices: ${pubRates.label}; margin ${process.env.HOTEL_MARKUP_PCT ?? 0}%`);
  const search = createSearch(process.env);
  hands.search = search;
  console.log(
    `Search: ${
      search.name === "brave"
        ? "Brave"
        : search.name.startsWith("browserbase")
          ? `Browserbase Search (Parallel, ${process.env.BROWSERBASE_SEARCH_MODE === "fast" ? "fast" : "advanced"}) with Exa behind it`
          : search.name === "exa"
            ? "Exa (keyless, via the Agent Reach channel)"
            : "DuckDuckGo (keyless)"
    }`,
  );
  console.log("Community posting: fake (adapter in src/tools/hands.ts)");
  console.log(`Tool catalogue: ${providers.length ? `offering families for ${providers.join(", ")}` : "core set only (no providers wired)"}`);
  return { hands, providers };
}

// Bun before 1.4 checks a WebSocket's TLS certificate against the resolved IP, so every Browserbase session fails to connect.
if (process.env.BROWSERBASE_API_KEY && Bun.version.localeCompare("1.4.0", undefined, { numeric: true }) < 0)
  console.warn(`Bun ${Bun.version}: Browserbase sessions will fail to connect (TLS check on the IP); run \`bun upgrade\` to 1.4 or later.`);
const dbPath = process.env.DB_PATH ?? "data/circle.sqlite";
if (dbPath !== ":memory:") {
  mkdirSync(dirname(dbPath), { recursive: true });
  const kept = restoreIfStaged(dbPath);
  if (kept) console.log(`Restored the database from restore.sqlite; the one it replaced is ${kept}`);
}
if (!process.env.MASTER_KEY) console.log("Vault: MASTER_KEY not set; members' credentials are encrypted with a dev key (set MASTER_KEY in production)");
const wired = pickHands();
const app = createApp({
  dbPath,
  model: pickModel(),
  hands: wired.hands,
  providers: wired.providers,
  masterKey: process.env.MASTER_KEY,
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
});
spend.attach(app.store.db);

// First run: one assistant and the seat of its owner. With sign-in on, the first person to sign in takes the seat;
// without it, the seat is "You" in the picker. Everyone else arrives through an invite link or "+ Add".
if (app.store.listAgents().length === 0) {
  const you = app.rooms.createPerson({ displayName: "You", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  const agent = newAgent({ ownerId: you.id, name: process.env.ASSISTANT_NAME ?? "Pip" });
  app.store.putAgent(agent);
  app.rooms.dmFor(agent, you.id);
  app.store.setKv("claim-owner", you.id);
  console.log(`First run: created ${agent.name} and its owner's seat. Make a room, add people, or share an invite link.`);
}

// The deployment's model is the model: refresh what each agent record shows so Settings → Assistant does not name an old one.
// An agent whose owner chose a model keeps it.
for (const agent of app.store.listAgents()) {
  const want = modelConfig(process.env).model;
  if (!agent.modelPinned && agent.model !== want) app.store.putAgent({ ...agent, model: want });
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
const channels: ChannelInfo[] = [];
const server = startWebServer(app, { hostname: host, port: Number(process.env.PORT ?? 3000), channels });
console.log(`Circle listening on http://${host}:${server.port}${clerk ? " (Clerk sign-in on)" : ""}`);

// Chat channels through Photon Spectrum: CHANNELS lists which (default imessage); all share PROJECT_ID and PROJECT_SECRET.
// IMESSAGE_MODE=local runs iMessage through this Mac's own Messages app instead (no credentials; macOS only).
if (process.env.IMESSAGE_MODE === "local") {
  app.ops.channel("imessage", "starting");
  startChannel(app, { channel: "imessage", local: true })
    .then((h) => {
      channels.push({ channel: "imessage", phone: h.phone, mode: h.mode, handle: h });
      app.ops.channel("imessage", "up");
      console.log(
        `imessage: local mode, this Mac's Messages app${process.env.IMESSAGE_PHONE ? ` as ${process.env.IMESSAGE_PHONE}` : ""} (Full Disk Access needed to read chat.db)`,
      );
    })
    .catch((e) => {
      app.ops.channel("imessage", "down", (e as Error).message);
      app.ops.error("imessage local start", e);
    });
} else if (process.env.PROJECT_ID && process.env.PROJECT_SECRET) {
  const wanted = (process.env.CHANNELS ?? "imessage")
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is SpectrumChannel => x in SPECTRUM_CHANNELS);
  for (const channel of wanted) {
    app.ops.channel(channel, "starting");
    startChannel(app, { projectId: process.env.PROJECT_ID, projectSecret: process.env.PROJECT_SECRET, channel })
      .then((h) => {
        channels.push({ channel, phone: h.phone, mode: h.mode, handle: h });
        app.ops.channel(channel, "up");
        console.log(`${channel}: connected${h.phone ? ` as ${h.phone}` : h.mode === "shared" ? " (shared pool: each person gets a number once registered)" : ""}`);
      })
      .catch((e) => {
        app.ops.channel(channel, "down", (e as Error).message);
        app.ops.error(`${channel} start`, e);
      });
  }
} else console.log("Channels: off (set PROJECT_ID and PROJECT_SECRET, and CHANNELS=imessage,whatsapp,telegram,slack)");

let ticking = 0; // when the tick in progress started; 0 when none
const TICK_MS = Number(process.env.TICK_MS ?? 30_000);
const BEAT_MS = Math.max(TICK_MS, 60_000);
const STUCK_MS = 20 * 60_000;
app.ops.expect("scheduler", BEAT_MS);
setInterval(() => {
  // A firing can take minutes (it awaits the run); the next tick waits rather than piling up.
  // The loop is alive while ticks finish or one is still within reason; a tick stuck past that stops the beat.
  if (ticking) {
    if (Date.now() - ticking < STUCK_MS) app.ops.beat("scheduler", BEAT_MS);
    return;
  }
  app.ops.beat("scheduler", BEAT_MS);
  ticking = Date.now();
  app.scheduler
    .tick()
    .catch((e) => app.ops.error("tick", e))
    .finally(() => {
      ticking = 0;
    });
  // Mail that arrived in the assistant's own inbox enters like an app event, into the owner's chat.
  if (!(app.hands.email instanceof FakeEmail))
    app.hands.email
      .unprocessed()
      .then(async (msgs) => {
        for (const m of msgs.slice(0, 10)) {
          for (const agent of app.store.listAgents())
            await app.runtime.handleEvent({
              agentId: agent.id,
              source: "inbound_email",
              summary: `Email from ${m.from}: ${m.subject}`,
              detail: m.text,
              dedupKey: `email:${m.id}`,
            });
        }
        if (msgs.length) await app.hands.email.markProcessed(msgs.map((m) => m.id));
      })
      .catch((e) => app.ops.error("inbound email", e));
}, TICK_MS);

// A daily copy of the database beside it (docs/runbook.md: backup and restore).
const BACKUP_EVERY_MS = 24 * 3600 * 1000;
if (dbPath !== ":memory:")
  setInterval(
    () => {
      const last = Number(app.store.getKv("backup:last") ?? 0);
      if (Date.now() - last < BACKUP_EVERY_MS) return;
      try {
        backup(app.store.db, join(dirname(dbPath), "backups"), Date.now(), Number(process.env.BACKUPS_KEPT ?? 7));
        app.store.setKv("backup:last", String(Date.now()));
      } catch (e) {
        app.ops.error("backup", e);
      }
    },
    10 * 60 * 1000,
  );

// Nightly memory pass at 03:00 in each owner's zone.
setInterval(
  async () => {
    for (const agent of app.store.listAgents()) {
      if (hourIn(app.store.getPerson(agent.ownerId)?.timezone ?? "UTC", Date.now()) !== 3) continue;
      const last = Number(app.store.getKv(`consolidated:${agent.id}`) ?? 0);
      if (Date.now() - last < 20 * 3600 * 1000) continue;
      await app.consolidator.runFor(agent).catch((e) => app.ops.error("consolidate", e));
    }
  },
  10 * 60 * 1000,
);
