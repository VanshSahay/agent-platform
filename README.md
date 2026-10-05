# Agent Platform

Create an agent by describing what you need, give it tools, memory and permissions, then talk to the same persistent agent from web, iMessage, Telegram, Slack, WhatsApp, email and phone — privately, in groups, or alongside other agents.

Built from `agent_platform_product_technical_plan.md`. The five primitives — **Workspace, Agent, Room, Connection, Run** — are first-class, and external chats are interfaces into a Room, never the source of truth.

## The user journey

1. **Land, sign up.** The landing page explains the product, lists ready-made agents and offers a no-account trial.
2. **Describe the agent**, for yourself or for a team (pick an existing team or create one inline). The draft shows the job, skills, connections needed and default permissions.
3. **Test it** (Agent → Test). A live chat in test mode: plans, approvals and tools all run, but nothing leaves the platform. Emails aren't sent, tables aren't booked, and accounts you haven't connected return sample data.
4. **Deploy in one tap** (Agent → Deploy):
   - **iMessage**, DM or group: "Text Ava from my iPhone" opens Messages with `start 12345678` prefilled; for groups, add the line and send `join 12345678`.
   - **WhatsApp:** a `wa.me` link.
   - **Telegram:** a `t.me` deep link, for DMs or groups.
   - **Slack:** "Add to Slack" (OAuth), then pick channels.
   - **Email:** an address on the platform domain.
   - **Phone:** an installable PWA, via QR code.
   - On desktop, scan the QR code with your phone.
   - Every channel reaches the same agent, memory and work.
5. **It works where people talk**, and the account-level **Agents** page shows what every agent does, where it's deployed, what it's working on and what it costs. **Tasks** lists tasks, reservation watches and group orders.

### Platform channel configuration (shared lines)

One-tap deploy uses platform-owned lines; set whichever you have. Each enables its Deploy button.

| Channel | Env | Webhook to register with the provider |
|---|---|---|
| iMessage (Photon) | `SHARED_IMESSAGE_LINE`, `SHARED_IMESSAGE_API_URL`, `SHARED_IMESSAGE_API_KEY`, `SHARED_IMESSAGE_WEBHOOK_SECRET` | `/v1/webhooks/imessage/chi_shared_imessage` |
| WhatsApp (Meta Cloud API) | `SHARED_WHATSAPP_NUMBER`, `SHARED_WHATSAPP_PHONE_NUMBER_ID`, `SHARED_WHATSAPP_ACCESS_TOKEN`, `SHARED_WHATSAPP_APP_SECRET`, `SHARED_WHATSAPP_VERIFY_TOKEN` | `/v1/webhooks/whatsapp/chi_shared_whatsapp` |
| Telegram | `SHARED_TELEGRAM_BOT_USERNAME`, `SHARED_TELEGRAM_BOT_TOKEN`, `SHARED_TELEGRAM_WEBHOOK_SECRET` | `/v1/webhooks/telegram/chi_shared_telegram` |
| Email (Resend inbound) | `SHARED_EMAIL_DOMAIN`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | `/v1/webhooks/email/chi_shared_email` |
| Slack app | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | Events + Interactivity: `/v1/webhooks/slack/app`; OAuth redirect: `/v1/slack/oauth/callback` |

`.env.demo` holds placeholder values so the Deploy page renders locally (`bun --env-file=.env.demo run src/index.ts`). Teams can still bring their own bot or number under Deploy → Advanced.

## Ready-made agents

Twenty first-party agents (`agents/*.json`), each tagged with a `category`:

- **Personal**
  - 💼 Ava: inbox, calendar, meeting prep and follow-ups.
  - 🍽️ Reese: grabs hard-to-get Resy/OpenTable tables the moment they open.
  - ✈️ Scout: plans trips, compares options, coordinates travelers.
  - 🔭 Atlas: research briefs with citations; monitors topics.
  - ☀️ Dash: a weekday morning briefing with your calendar plus the news you follow.
  - 🦅 Hawk: watches for price drops and restocks.
  - 🗂️ Ollie: life admin (bills, renewals, appointments, paperwork deadlines).
  - 🦉 Sage: study buddy; explains, quizzes, keeps you on your study plan.
  - 💪 Coach: habit and workout accountability, one-on-one or in a group.
- **Group** (work untagged in group chats)
  - 🛒 Pool: group buying with a tally, deadline and pay links.
  - 🧾 Tab: splits expenses; who owes whom, to the cent, in the fewest payments.
  - 🎉 Plans: polls, RSVPs and the who-brings-what list.
  - 🏠 Roomie: shared groceries, chores with owners, split bills.
  - 🍳 Chef: meal plans, recipes and one shared grocery list.
- **Team**
  - 📋 Relay: team ops; owners, follow-ups, blockers.
  - 🩺 Recruiter: healthcare staffing; matching and credential chasing.
  - 💬 Juno: answers support questions from your docs; escalates the rest.
  - 📈 Leo: prospect research and outreach drafts.
  - 📝 Max: meeting notes, action items and follow-ups.
  - 📣 Echo: social and content drafts from what's happening in your space.

Group-chat tool packs (`src/groupkit.ts`): **polls** (`poll.create/vote/results/close`; a bare "2", "Saturday" or "I'm in" counts as that person's vote without tagging), **expense splitting** (`expense.add/balances/settle`; cent-exact, fewest transfers, never moves money) and **shared lists** (`list.add/check/show/clear`).

| Agent | What it does |
|---|---|
| **Reese**, reservations | Searches and books Resy/OpenTable tables. **Watches** hot spots and polls every 5 seconds around release time. Books instantly within limits you **pre-approve once** (strong confirmation); otherwise it texts a one-tap card the moment a table opens. Without a browser runner it uses **sandbox** restaurants (fictional venues with scheduled releases) so the whole flow is testable. |
| **Pool**, group buying | Runs a group order in an iMessage/WhatsApp/Slack/Telegram group. People reply "in for 2" without tagging. Keeps the tally, reminds before the deadline, and closes with per-person totals, a shipping split and Venmo/PayPal/Cash App links. Never moves money. |

## Run it on Postgres + Temporal (production shape)

Locally, the platform runs as one Bun process on SQLite. In production it's three pieces sharing one Postgres database:
- **API server** (`bun run src/index.ts`, `ENGINE=temporal`): web app, API, channel webhooks, Photon, outbox, schedules and watches.
- **Temporal worker** (`bun run worker`, which runs on Node via tsx): each agent run is one `agentRun` workflow. Each step is an `advanceRun` activity over the same runtime code. Between steps the workflow sleeps durably until a wake signal (approval, reply, "go", reconnect, its turn in the conversation) or its next timer.
- **Temporal + Postgres**.

```
DATABASE_URL=postgres://agents@localhost:5433/agents ENGINE=temporal bun run src/index.ts   # server
DATABASE_URL=postgres://agents@localhost:5433/agents bun run worker                          # worker (run several)
temporal server start-dev                                                                     # local Temporal (UI on :8233)
```

- Give each environment its own `TEMPORAL_TASK_QUEUE` (or namespace): a worker only knows its own database, so a shared queue would hand it another environment's runs.
- `deploy/docker-compose.yml` runs the whole stack: Postgres, Temporal, Temporal UI, the server, and 2 workers.
- Move existing data across with `DATABASE_URL=… bun scripts/sqlite-to-pg.ts data.sqlite`.
- SQL is written once (SQLite-flavoured) and translated for Postgres in `src/pg.ts`. The whole test suite runs on both:
  - `TEST_DATABASE_URL=… bun run criteria` adds the Postgres gate (AC-PG1) and the end-to-end Temporal gate (AC-TP1, `bun run test:temporal`).
- ponytail: Postgres is reached through a synchronous one-connection bridge (`src/pg.ts`), the same blocking model as bun:sqlite. Move hot paths to an async pool when load needs it.

## AI models & billing

Each workspace chooses how its agents pay for AI (Settings → AI models & billing):

- **Use our models (credits).** Agents run on the platform's keys. Each call is billed at the provider's cost × `CREDIT_MARKUP` (default 1.25): first from the plan's monthly allowance (free $2, personal $20, pro $60, team $250), then from purchased credits. When both run out, model calls stop with a clear message. Top-ups go through Stripe Checkout; credits are added only from the signed `checkout.session.completed` webhook, exactly the amount paid, once.
- **Bring your own key.** Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible server (Together, Groq, Fireworks, self-hosted vLLM/Ollama). Nothing is billed, and a BYOK workspace never falls back to platform keys. Keys are sealed and never shown again.

Per workspace you can pick the model for each profile (everyday work, quick steps, research, hard problems) from the live OpenRouter catalog: about 400 tool-capable models, with an "open-source only" filter. Each step is routed to a tier: quick single-step asks, intake briefs, memory and grading use `qwen/qwen3.7-flash`; the agent's tool loop and research use `deepseek/deepseek-v4-pro`; a task that keeps failing escalates to `anthropic/claude-sonnet-5.5`, all through one OpenRouter key. Override any tier with `OPENROUTER_MODEL_<FAST|STANDARD|RESEARCH_STANDARD|ESCALATION>`. If a model returns a malformed tool call, the next model in the chain takes over.

| Env | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Platform key for open-source models (credits mode) |
| `JEV_API_KEY` | Optional. TypeSafe JEV for fast yes/no gates: group "relevant" replies and the unbacked-claim check (~150ms each; falls back without it) |
| `EXA_API_KEY` / `BRAVE_API_KEY` / `SERPER_API_KEY` / `TAVILY_API_KEY` | Web search for agents; first one set wins, falling through on failure. Serper = Google's results. Without any, a keyless DuckDuckGo fallback (unreliable, bot-checked) |
| `MEDIA_MODEL` | Optional. Multimodal model (OpenRouter) that describes photos and transcribes voice notes people send; default `google/gemini-2.5-flash`. `MEDIA_UNDERSTANDING=off` disables |
| `SPECTRUM_WEBHOOK_SECRET` | iMessage (Photon) webhook mode: Photon POSTs to `/v1/webhooks/photon` instead of a per-server stream, so several servers can run. Set the same secret in Photon's dashboard |
| `DEFAULT_TZ` | Time zone agents use for "today", "Saturday 7pm" (default: the server's) |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Optional. Clerk sign-in (Google, email codes, phone) instead of built-in email/password. `clerk link --app <id> && clerk env pull --file .env.clerk` fills them. `CLERK_AUTHORIZED_PARTIES` adds extra allowed origins besides `PUBLIC_URL` |
| `OPENROUTER_MODEL`, `OPENROUTER_FAST_MODEL` | Override the open-model defaults (`openrouter:<model-id>`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Optional platform keys for closed models |
| `CREDIT_MARKUP` | Platform price multiplier on provider cost |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Credit top-ups; point Stripe at `POST /v1/webhooks/stripe` |
| `PLATFORM_ADMINS` | Emails that may grant credits (`POST /v1/admin/credits`) |
| `ALLOW_PRIVATE_MODEL_URLS` | Allow BYOK base URLs on private networks (self-hosting only; off on a shared server) |

## Browser automation and MCP

- **Any MCP server is a connection** (Connections → Add MCP server). Its tools are discovered and granted per agent, risk-classified from MCP tool annotations (read-only → automatic; others → approval first; destructive → always), and run through the same policy, approvals and audit as built-in tools.
- Hosted presets: Browserbase and Browserless (verified endpoints). Browser Use: run its MCP server and paste the URL (API key header `X-Browser-Use-API-Key`).
- `browser.task` (and Reese's real bookings) run on a granted MCP browser server whose tool takes a `task`, or on an HTTP runner (`BROWSER_TASK_URL`: `{task, start_url, secrets, allowed_domains} → {status, output}`).
- **Website logins** (Connections → Add site login) are sealed and handed only to the HTTP runner, which substitutes `{{username}}`/`{{password}}`. They follow the same ownership rules as any credential, and never reach a model, event or log. MCP browser servers should use a saved browser profile instead.

### Live-browser logins (Browserbase) — no stored passwords

Connections → **Sign in with a live browser**: the user logs into the site (including 2FA) inside a Browserbase session embedded in the page. On "I'm logged in" the session is released, which saves the browser profile at Browserbase; the platform keeps only its Context id (`provider='browser_login'`, `config={site, context_id}`, no `cred_enc`). One active login per person and site; reconnecting replaces the old one and keeps its agents. Routes: `POST /v1/browser-logins/{start,finish,cancel}` (`src/browser.ts`).

- `browser.task` (and bookings) prefer a granted live login over a stored password. They run one session per login at a time (in-process lock held until `BROWSERBASE_CONTEXT_SYNC_MS`, default 5000, after release — reusing a Context before it syncs reads as logged out) and record each run in `browser_sessions` with a replay link returned to the agent.
- HTTP runner contract with a live login: `{task, start_url, allowed_domains, browserbase: {context_id, session_id}}` (never `secrets`); connect to that existing session. A pre-flight first sends `{probe: {url}, browserbase}` and expects `{url, title}` back; a logged-out match (config `probe_url`/`logged_out_pattern`, or built-ins for resy.com, opentable.com, linkedin.com) marks the login `needs_reauth` and the task is not run. MCP browser servers get `contextId` when their tool accepts it (no pre-flight there).
- Env: `BROWSERBASE_API_KEY` (no project id needed). Without it, live logins answer 501.

## How a request is handled

Every message an agent acts on goes through a requirement layer before any tool runs (`src/intake.ts`):

1. **Brief.** The request plus room context and remembered preferences become a structured brief: goal, deliverable, constraints, assumptions, side effects, *done when*, and a plan. With a model key the model drafts it; offline, a deterministic planner does.
2. **Decide** (fixed rules, not the model):
   - **Clarify** when something essential is missing and can't be looked up. One batched question, with suggested defaults.
   - **Confirm** multi-step tasks and plans with 2+ external actions, using a plan card with Go / Edit / Cancel.
   - **Auto-start** simple work. A single send/book is gated by its own approval card, so you're not asked twice.
   - Per agent: Settings → "Before starting work" (smart / always / never).
3. **Execute against the brief.** The brief is injected as `[TASK_BRIEF]`, plan steps tick off as tools succeed, and the agent can re-plan with `plan.update`. A follow-up like "actually send it to Dana instead" re-briefs the same task with a diff, withdraws stale approvals, and re-confirms.
4. **Verify.** The final answer is checked against *done when*. Gaps are retried once, then disclosed ("⚠️ Not fully done — still missing: …").

Long waits post one progress line. Unanswered questions expire after 72h. After the same kind of task succeeds 3 times, the agent offers to save it as a **learned skill**.

## Run it

```bash
bun install
bun run start            # http://localhost:3000
```

No API keys needed to try it: without model keys the platform runs an offline heuristic model (keyword planner) so every flow works end-to-end. Add keys for real judgment:

| Env | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Platform-hosted inference (workspaces can also bring their own keys in Settings) |
| `MASTER_KEY` | base64 32-byte key wrapping per-secret data keys (required when `NODE_ENV=production`) |
| `PUBLIC_URL` | Public base URL for webhooks and OAuth redirects |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail + Calendar OAuth (or paste a token under Connections → Add token) |
| `EXA_API_KEY` | Production web search (falls back to DuckDuckGo HTML) |
| `BROWSER_TASK_URL` / `BROWSER_TASK_KEY` | Browser Use / Stagehand runner for `browser.task` |
| `PLATFORM_ADMINS` | Comma-separated emails allowed to review public templates and edit model routing |
| `DB_PATH` | SQLite file (default `data.sqlite`) |

Channels are added per agent (Agent → Channels). Each gives you a webhook URL `…/v1/webhooks/<platform>/<id>` to paste into Telegram `setWebhook`, Slack Events + Interactivity, Meta WhatsApp, Resend inbound, your Photon iMessage bridge, or a Twilio voice number. To make an agent recognize you on a channel, get a link code (Agent → Channels) and text `link 12345678` to it.

## Test it

```bash
bun test                 # 93 tests: user journeys, scenarios, intake, MCP, policy, tools, runtime, memory, channels, API, security, evals
bun run criteria         # checks every criterion in ACCEPTANCE.md (tests + typecheck + UI bundle)
bun run eval             # golden tasks against whatever model is configured; writes reports/eval-*.json
bun run eval scout --min=0.9
bun run eval:live                      # 24 real-usage scenarios: every catalog agent over iMessage/WhatsApp/Telegram/Slack/email/web,
bun run eval:live group --repeat=3     #   group chats with chatter, wrong-person approvals, follow-ups; hard checks + LLM judge
bun run eval:live reese --show         #   (judge: EVAL_JUDGE_MODEL, default anthropic/claude-sonnet-5.5; EVAL_JUDGE=off to skip)
```

- **`test/journey.test.ts`**: end-user journeys driven like a person would: HTTP API for the web app, signed webhooks for phones and Slack.
- **`ACCEPTANCE.md`** — 95 criteria, each traced to a plan section and to the tests that prove it (test names start with the criterion ID).
- **`test/scenarios.test.ts`** — the plan's "must prove" milestones, end to end through signed webhooks, the durable runtime and the fake network.
- **`test/intake.test.ts`**: the requirement layer (clarify, confirm, revise, verify, plan progress, learned skills).
- **`evals/cases/*.json`**: data-driven golden cases. Any real run can be exported from its trace ("Save as eval case" / `GET /v1/runs/:id/eval-case`), reviewed, and dropped here to become a regression test.
- **`test/helpers.ts`** — the harness: in-memory DB, controllable clock (`advance()`), fake network (`net.on/net.to`), scripted model (`scriptModel`), signed webhook builders for every provider.
- **`evals/golden.ts`** — versioned golden tasks scored on the plan's §23.3 dimensions (tool selection, approval, boundary, completion, response, memory). Run before changing prompts, models, tools, retrieval or routing.

## Where things live

| Plan concept | Code |
|---|---|
| Workspace, members, invitations, plans, BYOK, API (§2.1, §22, §34) | `src/server.ts` |
| Agent Templates / Instances, skills, manifests, install / fork / publish / review, NL agent drafts (§2.3, §2.7, §3.4, §18) | `src/templates.ts`, `agents/*.json` |
| Room, Run, waits, approvals, tasks, delegation, schedules & wake conditions, worker, trace (§2.4, §2.8, §7, §16, §37) | `src/runtime.ts` |
| Requirement layer: briefs, clarify/confirm policy, revisions, plan progress, result checks (§7.4) | `src/intake.ts` |
| Context assembly with origin labels and permission filtering (§9.5, §15.3, §21.2) | `src/context.ts` |
| Policy engine (§19) | `src/policy.ts` |
| Tool contract, Tool Gateway, idempotency, retry taxonomy, tools (§10, §35) | `src/tools.ts` |
| Scoped memory, write pipeline, retrieval (§9) | `src/memory.ts` |
| ModelGateway, routing profiles, BYOK, offline model + planner extension hooks (§8) | `src/model.ts` |
| MCP client (Streamable HTTP, SSE responses, sessions) | `src/mcp.ts` |
| Reservation agent: search, book, watches, pre-approved limits, sandbox + browser providers | `src/reservations.ts` |
| Group buying: orders, tally, deadlines, pay links | `src/orders.ts` |
| Channel adapters, webhook verification, identity linking, outbox, phone (§5, §6, §20) | `src/channels.ts` |
| Append-only events (= audit log), envelope encryption, usage ledger (§21, §22.2, §24) | `src/db.ts` |
| Web app (§3), incl. plan cards, setup checklist, starter prompts, file uploads | `public/app.tsx`, `public/styles.css` |

**Tools:**
- **Web:** search, fetch.
- **Google** (one OAuth connection): Gmail search/draft/send, Calendar list/free-time/create/cancel, Contacts lookup, Drive search/read.
- **Workspace:** reminders and recurring schedules, tasks, memory, files in the room (text and PDF), delegation to other agents, waiting for a reply.
- **Browser:** a provider seam for an external runner.

**Plans:** free / personal / pro / team / enterprise limit agent count, channels, and the monthly platform-hosted AI allowance. BYOK usage doesn't count against the allowance.

## Deliberate simplifications (swap points)

Each is marked with a `ponytail:` comment in the code naming the ceiling and the upgrade path.

- **Durability**: SQLite-backed run queue + timer table in one worker process instead of Temporal. Runs/waits/steps map 1:1 onto workflows + signals; move when you need multiple workers.
- **Database**: SQLite + FTS5 instead of Postgres + pgvector + RLS. Every table carries `workspace_id` or hangs off one; tenancy is enforced in the API layer.
- **Auth**: built-in email/password sessions instead of Clerk / Better Auth (no SSO/SCIM — enterprise milestone).
- **Integrations**: direct Google OAuth instead of Nango; one Google connection covers Gmail + Calendar.
- **iMessage**: generic signed-webhook bridge for a Photon Spectrum sidecar; Slack/Telegram/WhatsApp/Resend/Twilio use their native APIs.
- **Voice**: Twilio `<Gather>` speech turns instead of LiveKit realtime.
- **Files from channels**: uploads work on web; attachments sent via Telegram/Slack/WhatsApp aren't ingested yet.
- **Browser / search / sandbox**: `browser.task` is a provider seam (Browser Use / Stagehand); search uses Exa or DuckDuckGo; no code sandbox (E2B) yet.
- **Observability & billing**: the append-only event log is the trace + audit store and the usage ledger is the billing source; OTel/Langfuse/Sentry/PostHog exporters and the Stripe sink are not wired.
- **Not built (plan §40/§31)**: visual workflow canvas, arbitrary creator code, autonomous payments, SSO/SCIM/DLP/data residency, mobile app.
