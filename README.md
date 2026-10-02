# Agent Platform

Create an agent by describing what you need, give it tools, memory and permissions, then talk to the same persistent agent from web, iMessage, Telegram, Slack, WhatsApp, email and phone — privately, in groups, or alongside other agents.

Built from `agent_platform_product_technical_plan.md`. The five primitives — **Workspace, Agent, Room, Connection, Run** — are first-class, and external chats are interfaces into a Room, never the source of truth.

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
bun test                 # 51 tests: scenarios, policy, tools, runtime, memory, channels, API, evals
bun run criteria         # checks every criterion in ACCEPTANCE.md (tests + typecheck + UI bundle)
bun run eval             # golden tasks against whatever model is configured; writes reports/eval-*.json
bun run eval scout --min=0.9
```

- **`ACCEPTANCE.md`** — 53 criteria, each traced to a plan section and to the tests that prove it (test names start with the criterion ID).
- **`test/scenarios.test.ts`** — the plan's "must prove" milestones, end to end through signed webhooks, the durable runtime and the fake network.
- **`test/helpers.ts`** — the harness: in-memory DB, controllable clock (`advance()`), fake network (`net.on/net.to`), scripted model (`scriptModel`), signed webhook builders for every provider.
- **`evals/golden.ts`** — versioned golden tasks scored on the plan's §23.3 dimensions (tool selection, approval, boundary, completion, response, memory). Run before changing prompts, models, tools, retrieval or routing.

## Where things live

| Plan concept | Code |
|---|---|
| Workspace, members, invitations, plans, BYOK, API (§2.1, §22, §34) | `src/server.ts` |
| Agent Templates / Instances, skills, manifests, install / fork / publish / review, NL agent drafts (§2.3, §2.7, §3.4, §18) | `src/templates.ts`, `agents/*.json` |
| Room, Run, waits, approvals, tasks, delegation, schedules & wake conditions, worker, trace (§2.4, §2.8, §7, §16, §37) | `src/runtime.ts` |
| Context assembly with origin labels and permission filtering (§9.5, §15.3, §21.2) | `src/context.ts` |
| Policy engine (§19) | `src/policy.ts` |
| Tool contract, Tool Gateway, idempotency, retry taxonomy, tools (§10, §35) | `src/tools.ts` |
| Scoped memory, write pipeline, retrieval (§9) | `src/memory.ts` |
| ModelGateway, routing profiles, BYOK, offline model (§8) | `src/model.ts` |
| Channel adapters, webhook verification, identity linking, outbox, phone (§5, §6, §20) | `src/channels.ts` |
| Append-only events (= audit log), envelope encryption, usage ledger (§21, §22.2, §24) | `src/db.ts` |
| Web app (§3) | `public/app.tsx`, `public/styles.css` |

## Deliberate simplifications (swap points)

Each is marked with a `ponytail:` comment in the code naming the ceiling and the upgrade path.

- **Durability**: SQLite-backed run queue + timer table in one worker process instead of Temporal. Runs/waits/steps map 1:1 onto workflows + signals; move when you need multiple workers.
- **Database**: SQLite + FTS5 instead of Postgres + pgvector + RLS. Every table carries `workspace_id` or hangs off one; tenancy is enforced in the API layer.
- **Auth**: built-in email/password sessions instead of Clerk / Better Auth (no SSO/SCIM — enterprise milestone).
- **Integrations**: direct Google OAuth instead of Nango; one Google connection covers Gmail + Calendar.
- **iMessage**: generic signed-webhook bridge for a Photon Spectrum sidecar; Slack/Telegram/WhatsApp/Resend/Twilio use their native APIs.
- **Voice**: Twilio `<Gather>` speech turns instead of LiveKit realtime.
- **Browser / search / sandbox**: `browser.task` is a provider seam (Browser Use / Stagehand); search uses Exa or DuckDuckGo; no code sandbox (E2B) yet.
- **Observability & billing**: the append-only event log is the trace + audit store and the usage ledger is the billing source; OTel/Langfuse/Sentry/PostHog exporters and the Stripe sink are not wired.
- **Not built (plan §40/§31)**: visual workflow canvas, arbitrary creator code, autonomous payments, SSO/SCIM/DLP/data residency, mobile app.
