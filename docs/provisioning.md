# Provisioning list

What the Company provides, per the agreement (§8: hosting, accounts and credentials are Company-side; operating charges are outside the development fee and identified here). Each row says what it unlocks, who acts, and the cost shape. Costs are order-of-magnitude for a family-scale deployment — confirm at signup; nothing here is purchased by the contractor.

Priority order matters: **1–4 gate Milestone 1** (deploy + real iMessage). The rest gate Milestone 2 capabilities and can arrive as they are ready.

| # | Item | Unlocks | Account to create / provide | Cost shape (confirm at signup) |
|---|---|---|---|---|
| 1 | **Hosting** | The deployed platform itself | Fly.io on the Company's account: one always-on machine (shared-cpu-1x, 512 MB) and a 1 GB volume for SQLite. `scripts/fly-setup.sh` creates both; operation is in [runbook.md](runbook.md). | About $3.50/month at that size |
| 2 | **Model API** | The agent's brain | An OpenRouter API key, default `deepseek/deepseek-v4.1-flash-1017` for every call. Over three trials on the seven hardest scenarios it beat Claude Opus 5.5, 12 of 21 vs 9 of 21 (run 11), at a fraction of the cost. The full suite is 20 of 23 scenarios passing all three trials (run 15). See [eval-harness.md](eval-harness.md). An Anthropic API key (Claude Opus 5.5 / Haiku 5.5) is the other supported door, not a recommendation. Key lives in `.env` on the host. | Usage-based; typically $20–150/month at family scale depending on model and volume |
| 3 | **iMessage transport** | The required launch channel: real iMessage groups | Photon Spectrum account (PROJECT_ID + PROJECT_SECRET). The free and Pro shared pool is one-to-one only; group chats need a dedicated Business line. The provider for groups is still being decided (cheaper options are being compared). One Photon project per running copy. | Shared pool free or $25/month; dedicated line $250/month per line (confirm with Photon) |
| 4 | **Web sign-in** | The owner UI on a public host | Clerk application (SECRET_KEY + PUBLISHABLE_KEY), production instance; add the deployed domain to authorized parties. | Free tier then ~$25/month |
| 5 | **Cloud browser** | Sign-in-as-person flows, subscription cancellations, returns, forms | Browserbase API key (+ project id). Persistent contexts keep members' logins; the password never reaches the agent. | Usage-based; free tier to start |
| 6 | **Google OAuth app** | Per-person Gmail + Calendar + Drive (authorized accounts family) | Google Cloud project → OAuth client (CLIENT_ID + CLIENT_SECRET), scopes gmail/calendar/drive; list the owner's accounts as test users while unverified. | Free |
| 7 | **Agent mailbox** | The agent's own email identity (send + receive, OTPs) | AgentMail API key + inbox (preferred: send and receive), or Resend API key + verified domain (send only). | Free tier to start |
| 8 | **Voice calls** | Real calls, incl. Mandarin-speaking outreach | Vapi API key + phone number (+ VAPI_PHONE_NUMBER_ID). Mandarin-capable voice. | ~$0.10–0.30/minute + ~$5/month number |
| 9 | **SMS** | Texts to vendors and clinics | Twilio account (SID + AUTH_TOKEN + FROM number). | ~$1/month number + ~$0.01/message |
| 10 | **Speech** | Voice notes, spoken replies | ElevenLabs API key + voice id. | $5–22/month |
| 11 | **Payments** | Approved checkouts with single-use cards | Stripe account → enable Issuing → create a cardholder (CARDHOLDER_ID) → STRIPE_SECRET_KEY. KYC lead time: start early. | Per virtual card (~$0.10) + possible monthly cardholder fee |
| 12 | **Domain** | PUBLIC_URL for pages, cards, OAuth redirects | One domain or subdomain pointing at the host. | ~$12/year |
| 13 | **Ops secrets** | Credential encryption, webhook auth | Generate MASTER_KEY (32+ random chars) and EVENT_TOKEN; give to the contractor for the host's `.env`. | Free |

Already working without keys (no action needed): web search (Exa keyless), page reading (Jina Reader keyless), the offline test suite, the full eval harness against fakes.

Not yet decided (contractor will propose, Company approves spend): the community-posting route (Reddit/Rednote need logged-in sessions — likely a browser-session approach through item 5); WhatsApp/Telegram/Slack channels beyond iMessage (Spectrum carries them; per-channel charges).

Send credentials through the agreed secure channel, never in plain chat or email bodies. Every key lands only in the host's `.env` (gitignored), never in code, docs, tests or commit messages.
