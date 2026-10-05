// Point every channel at this deployment. Does what has an API (Telegram webhook); prints exact values for the dashboards that
// don't (Slack manifest, WhatsApp, Resend, Stripe, Google, Photon, Twilio). Safe to re-run.
//   PUBLIC_URL=https://your.domain bun --env-file=.env.production scripts/connect-channels.ts
const PUBLIC = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
if (!/^https:\/\//.test(PUBLIC)) { console.error("Set PUBLIC_URL to this server's public https URL first (a domain, or a tunnel like `cloudflared tunnel --url http://localhost:3000`)."); process.exit(1); }
const env = (k: string) => process.env[k] ?? "";
const real = (k: string) => !!env(k) && !/^(demo|0:demo|your|placeholder)/i.test(env(k));
const done: string[] = [], todo: string[] = [];

// Is the server reachable from the internet at all?
const health = await fetch(`${PUBLIC}/v1/health`).then((r) => r.ok).catch(() => false);
(health ? done : todo).push(health ? `server reachable at ${PUBLIC}` : `server NOT reachable at ${PUBLIC}/v1/health — start it / fix the tunnel before connecting channels`);

// Telegram: fully automatic
if (real("SHARED_TELEGRAM_BOT_TOKEN")) {
  const r: any = await (await fetch(`https://api.telegram.org/bot${env("SHARED_TELEGRAM_BOT_TOKEN")}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${PUBLIC}/v1/webhooks/telegram/chi_shared_telegram`, secret_token: env("SHARED_TELEGRAM_WEBHOOK_SECRET"), allowed_updates: ["message", "callback_query"] }) })).json().catch((e) => ({ description: e.message }));
  (r.ok ? done : todo).push(r.ok ? "Telegram webhook registered" : `Telegram: ${r.description}`);
} else todo.push("Telegram: create a bot with @BotFather, then set SHARED_TELEGRAM_BOT_TOKEN, SHARED_TELEGRAM_BOT_USERNAME and a random SHARED_TELEGRAM_WEBHOOK_SECRET; re-run");

// WhatsApp (Meta Cloud API)
todo.push(real("SHARED_WHATSAPP_ACCESS_TOKEN")
  ? `WhatsApp: Meta app → WhatsApp → Configuration → Webhook: Callback URL ${PUBLIC}/v1/webhooks/whatsapp/chi_shared_whatsapp, Verify token = SHARED_WHATSAPP_VERIFY_TOKEN; subscribe to "messages"`
  : "WhatsApp: create a Meta app with the WhatsApp product + a business number, then set SHARED_WHATSAPP_NUMBER, _PHONE_NUMBER_ID, _ACCESS_TOKEN (permanent system-user token), _APP_SECRET, _VERIFY_TOKEN; re-run");

// Slack: one app for every workspace, created from this manifest
const manifest = {
  display_information: { name: "Agents", description: "Your agents in Slack" },
  features: { bot_user: { display_name: "Agents", always_online: true } },
  oauth_config: { redirect_urls: [`${PUBLIC}/v1/slack/oauth/callback`],
    scopes: { bot: ["app_mentions:read", "channels:history", "channels:join", "channels:read", "chat:write", "groups:history", "groups:read", "im:history", "im:write", "users:read"] } },
  settings: { event_subscriptions: { request_url: `${PUBLIC}/v1/webhooks/slack/app`, bot_events: ["app_mention", "message.channels", "message.groups", "message.im"] },
    interactivity: { is_enabled: true, request_url: `${PUBLIC}/v1/webhooks/slack/app` }, org_deploy_enabled: false, socket_mode_enabled: false },
};
if (!real("SLACK_CLIENT_ID")) todo.push(`Slack: api.slack.com/apps → Create New App → From a manifest → paste:\n${JSON.stringify(manifest, null, 2)}\n  then set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET (Basic Information); re-run`);
else done.push("Slack app configured (if you changed PUBLIC_URL, update the app's URLs to match the manifest above)");

// Email (Resend)
todo.push(real("SHARED_EMAIL_DOMAIN")
  ? `Email: Resend → Domains → add ${env("SHARED_EMAIL_DOMAIN")} with receiving enabled (add the MX record it shows); Webhooks → ${PUBLIC}/v1/webhooks/email/chi_shared_email for email.received, email.bounced, email.complained; put its signing secret in RESEND_WEBHOOK_SECRET`
  : "Email: set SHARED_EMAIL_DOMAIN to a domain you control (e.g. agents.yourco.com), then re-run");

// Payments, Google, Photon, phone, sign-in
todo.push(real("STRIPE_SECRET_KEY") ? `Stripe: Developers → Webhooks → ${PUBLIC}/v1/webhooks/stripe, event checkout.session.completed; set STRIPE_WEBHOOK_SECRET` : "Stripe (credit top-ups): set STRIPE_SECRET_KEY, then re-run");
todo.push(real("GOOGLE_CLIENT_ID") ? `Google: Cloud Console → Credentials → your OAuth client → Authorized redirect URI ${PUBLIC}/v1/connections/google/callback`
  : `Google (Gmail/Calendar): Cloud Console → enable Gmail, Calendar, People, Drive APIs → OAuth consent screen → Web client with redirect ${PUBLIC}/v1/connections/google/callback; set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET`);
if (env("SPECTRUM_WEBHOOK_SECRET")) todo.push(`iMessage (Photon): dashboard → Webhooks → ${PUBLIC}/v1/webhooks/photon with the same SPECTRUM_WEBHOOK_SECRET`);
todo.push(`Clerk: production instance → Domains → ${new URL(PUBLIC).host}; set CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY to the live keys`);
todo.push(`Phone (optional): Twilio number → Voice webhook ${PUBLIC}/v1/webhooks/phone/<channel id shown on the agent's Deploy page>`);

console.log(`\n✓ done\n${done.map((x) => `  ✓ ${x}`).join("\n") || "  (nothing yet)"}\n\n→ to do\n${todo.map((x) => `  → ${x}`).join("\n")}\n`);
