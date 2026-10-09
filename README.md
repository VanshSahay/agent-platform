# Agent Platform

Describe an agent in a sentence, and talk to it where you already talk: iMessage first, also Telegram, WhatsApp, Slack, email and the web. The same agent, with the same memory and the same unfinished work, in a private chat and in a group. It keeps a durable record of what you asked for and proves each outcome from its own records before it says "done".

Four agents are on the front page, each a bundle of skills rather than a separate product:

| Agent | Lives | Does |
|---|---|---|
| **Ava** | your 1:1 chat | Inbox, calendar, meeting prep, emails with approval, follow-ups that fire only if nobody replied |
| **Booker** | 1:1 | Every kind of booking: restaurant tables, tickets, hotel rooms, class spots. Watches a page and acts the moment something opens |
| **Buyer** | a group chat | Quotes across the internet, then runs the group order, the tally, the split and the chasing |
| **Milo** | a family group and each member's own chat | LIVE / MANAGE / HEALTH / FAMILY / REMEMBER: things to do, paperwork, doctor visits, rides, stories. Private by default; the family sees only what each person shares |

Twenty more specialists (`agents/*.json`) stay installable but unfeatured.

> **Status, honestly.** Everything below is proven by 204 deterministic tests on a fake network and a scripted model, and by job contracts that check every reported action against the platform's own records. What is *not* proven: a clean model-in-the-loop run on the current commit, and real phones over iMessage (the shared Photon pool is wired and was live; the Fly trial has since ended, so the deployment is down until a card is added). Free OpenRouter models are used for all testing; they are slow (10–30 s a call) and capped at 50 requests a day.

## How a request is handled

```
message on any channel
   │
   ▼
Room (one per private chat, one per group) ── identity, membership, sharing boundary
   │
   ▼
Intake (src/intake.ts)        the request becomes a brief: goal, constraints, plan, "done when",
   │                          typed facts (people, addresses, dates, money, price cap), claims
   │                          ── fast or judge tier by the ask's shape; a failed model is marked,
   │                             never silently replaced; a plan review adds any job left out
   ▼
Task graph (src/taskgraph.ts) agent_tasks → task_actions → action_evidence, revisions on change
   │
   ▼
Decide                        skip / auto / confirm the plan / ask one batched question
   │
   ▼
Run loop (src/runtime.ts)     model turn → tool calls through policy + approvals + idempotency
   │                          (src/policy.ts, src/tools.ts) → each execution bound to its action
   │                          and judged by a deterministic verifier; specialists for parallel reads
   ▼
Gate (src/gate.ts)            leak · ungrounded figures · unbacked claims · job contracts ·
   │                          fact mismatches (wrong recipient, week, budget) · claims with proof ·
   │                          judge only for answer quality, and it fails closed
   ▼
Reply, then Experience        one message per channel; playbooks learned only from verified runs
```

What "proven" means here: a send is proven by the provider's message id, a draft is only ever "observed", a reminder by its persisted schedule, a calendar read only if it covered the request's dates, a booking by a confirmation number. An approval card is "waiting for your OK", never done. An unknown provider answer is "uncertain" and the reply says so. The trace of any run (`/v1/trace/:id`, or "Why?" in the app) shows the task's actions, evidence and state.

## Architecture

```
┌───────────── channels (src/channels.ts, src/photon.ts) ─────────────┐
│ iMessage (Photon pool / Business / this Mac)  Telegram  WhatsApp     │
│ Slack  Email (Resend)  Phone (Twilio)  Web (public/app.tsx, React)   │
│ signed webhooks in · outbox with delivery state out                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌──────────────────────── core (Bun + TypeScript) ────────────────────┐
│ Workspaces · Agents · Rooms · Connections · Runs   (src/db.ts)       │
│ runtime: durable runs, waits, approvals, schedules, specialists      │
│ intake · task graph · gate · jobs · experience · memory · context    │
│ model gateway (src/model.ts): OpenRouter / Anthropic / OpenAI / BYOK │
│   tiers fast · standard · research · judge · escalation; offline     │
│   keyword planner for demo and tests                                 │
│ tool gateway (src/tools.ts): risk classes, approvals, fingerprints,  │
│   repeated-call guard, untrusted-content marking                     │
└───────┬───────────────┬─────────────────┬───────────────────────────┘
        ▼               ▼                 ▼
  Postgres (prod)   providers          browser
  SQLite (dev/test) Google (Gmail,     Browserbase live logins,
  one SQL dialect,  Calendar, Contacts,  browser.task runner,
  translated in     Drive), web search,  MCP servers as connections
  src/pg.ts         market, weather,     (src/mcp.ts, src/browser.ts)
                    sports, 小红书 (MCP)
```

Deployment today: one always-on Fly.io machine (`fly.toml`, `ENGINE=local`) with Fly Postgres, behind a Cloudflare Worker that gives the permanent link; see `deploy/CLOUD.md`. Temporal is optional (`ENGINE=temporal`, `deploy/docker-compose.yml`) for many workers.

### Module map

| Area | Code |
|---|---|
| API, web app routes, ops report, deploy codes, sharing panel | `src/server.ts`, `public/app.tsx` |
| Rooms, runs, waits, approvals, schedules, specialists, delegation, trace | `src/runtime.ts` |
| Brief, facts, planner tier, plan review, clarify/confirm, revisions | `src/intake.ts` |
| Durable task graph and verifiers | `src/taskgraph.ts` |
| Completion gate | `src/gate.ts` · job contracts and fact checks in `src/jobs.ts` |
| Context window, running summary, origin labels, specialist rules | `src/context.ts` |
| Depth (light / standard / deep) and specialist tool sets | `src/depth.ts` |
| Experience: playbooks (verified runs only), site failures, answers | `src/experience.ts` |
| Memory scopes and retrieval | `src/memory.ts` |
| Tools and the gateway | `src/tools.ts` plus `src/groupkit.ts` (polls, splits, lists), `src/orders.ts`, `src/reservations.ts`, `src/watches.ts`, `src/family.ts`, `src/stories.ts`, `src/objectives.ts`, `src/paperwork.ts`, `src/people.ts`, `src/scam.ts`, `src/social.ts` |
| Models, billing, templates, catalog | `src/model.ts`, `src/billing.ts`, `src/templates.ts`, `src/spec.ts`, `agents/*.json` |
| Channels, media, photos and voice notes | `src/channels.ts`, `src/photon.ts`, `src/media.ts` |
| Database, schema, encryption, Postgres bridge | `src/db.ts`, `src/pg.ts`, `src/pg-worker.mjs` |

### The family boundary

Each person owns what Milo knows about them. A sharing panel (appointments, plans, health, money, conversations) says what may reach the family by default. The only way a private-chat fact gets into the group is `family.share`, which asks first unless the category is shared, checks consent against the person's own words, and posts only the agreed text. Stories, bills and the friendship signal follow the same rule: visible to the person, and to the family only if told in the group.

## What has been built so far

- **Agents consolidated** from twenty-one front-page agents to four super agents with skills; installed agents are upgraded in place when a first-party manifest version is bumped.
- **Milo**: sharing panel and private→family bridge; scam check ("is this real?") with the reasons; story store with provenance and a story interviewer; objectives with steps, owners, one nudge and one escalation; paperwork search over bills and letters sent as photos or PDFs (free vision model); doctor-visit prep without diagnosis; daily check-in that is not monitoring; weekly digest; polls that count answers people already gave.
- **Booker**: availability watches on any website, fast around the opening, offered once, paused on a no.
- **Task understanding** (from the October review): typed facts, planner routing by the ask's shape, deterministic plan review, draft ≠ send, fact mismatches warned on the approval card, judge fails closed, uncertain writes never reported done, playbooks only from verified runs, specialists with typed output, confidence and one shared budget.
- **Speed and operations**: parallel builder calls, elapsed-time honesty in the UI, boot that waits for Postgres, free vision model for photos, ops report with the failure taxonomy (`tasks_24h`).

`ACCEPTANCE.md` lists 189 criteria, each tied to the tests that prove it. `docs/agent-intelligence-implementation-plan.md` records which parts of the intelligence plan are built, partial or open. `docs/family-agent-plan.md` is the Milo plan.

## Run it

```bash
bun install
bun run start            # http://localhost:3000, SQLite, offline keyword planner — every flow works without keys
```

Add keys for real judgment and real work (all optional; see `deploy/CLOUD.md` for the cloud set):

| Env | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Models. `OPENROUTER_MODEL_<FAST\|STANDARD\|RESEARCH_STANDARD\|JUDGE\|ESCALATION>` pins each tier (`openrouter:<id>`) |
| `MASTER_KEY`, `PUBLIC_URL`, `DATABASE_URL` | Required in production: credential encryption, public address, Postgres |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail, Calendar, Contacts, Drive |
| `BROWSERBASE_API_KEY` | Live-browser logins and `browser.task` |
| `EXA_API_KEY` / `BRAVE_API_KEY` / `SERPER_API_KEY` / `TAVILY_API_KEY` | Web search; without any, a keyless DuckDuckGo fallback |
| `MEDIA_MODEL`, `MEDIA_UNDERSTANDING` | Photos and voice notes; a free Nemotron omni model works |
| `XHS_MCP_URL`, `XHS_MCP_TOKEN` | 小红书 through a local `xiaohongshu-mcp` (needs a QR login) |
| `SHARED_IMESSAGE_*`, `SHARED_TELEGRAM_*`, `SHARED_WHATSAPP_*`, `SLACK_*`, `RESEND_*` | One-tap deploy lines per channel |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Clerk sign-in instead of built-in email/password |

## Test it

```bash
bun test                 # 204 tests on an in-memory DB, controllable clock, fake network, scripted model
bun run typecheck
bun run criteria         # every criterion in ACCEPTANCE.md: tests + typecheck + UI bundle
bun run eval             # golden tasks against the configured model (spends model credit; ask first)
```

Rules the tests keep: no unauthorized send, no cross-person leak, no duplicate external write, no "done" without evidence. Evals that the agent is meant to pass by itself are not written; real transcripts, read by a person, are the bar.

## Deliberate simplifications

Each is marked `ponytail:` in the code with its ceiling and upgrade path. The verifier map in `src/taskgraph.ts` becomes a capability registry when a third domain (payments) needs its own adapter. Postgres is reached through a synchronous one-connection bridge. The friendship signal and the facts extractor use a capitalised-word heuristic. Voice is inbound Twilio turns only; outbound calls are the largest remaining gap and come after a real family has used the rest.
