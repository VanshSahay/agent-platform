# Provisioning list

What the Company provides, per the agreement (§8: hosting, accounts and credentials are Company-side; operating charges are outside the development fee and identified here). Each row says what it unlocks, who acts, and the cost shape. Costs are order-of-magnitude for a family-scale deployment — confirm at signup; nothing here is purchased by the contractor.

Priority order matters: **1–4 gate Milestone 1** (deploy + real iMessage). The rest gate Milestone 2 capabilities and can arrive as they are ready.

| # | Item | Unlocks | Account to create / provide | Cost shape (confirm at signup) |
|---|---|---|---|---|
| 1 | **Hosting** | The deployed platform itself | Any host that runs one Bun/Node process with a persistent volume: Fly.io machine + volume, Railway, or a small VPS. Debian/Ubuntu, 1 vCPU / 1 GB is enough to start. | ~$5–20/month |
| 2 | **Model API** | The agent's brain | An OpenRouter API key (GLM 5.3 / 5.3-flash), or an Anthropic API key (Claude Opus 5.5 / Haiku 5.5 — recommended for the strongest reasoning). Key lives in `.env` on the host. | Usage-based; typically $20–150/month at family scale depending on model and volume |
| 3 | **iMessage transport** | The required launch channel: real iMessage groups | Photon Spectrum account (PROJECT_ID + PROJECT_SECRET), iMessage provider enabled per their provisioning steps. Note their hardware/Apple-ID requirements and supported group types for the runbook. | Subscription + per-message; confirm with Spectrum |
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
