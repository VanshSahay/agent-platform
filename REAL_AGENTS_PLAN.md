# Plan: agents that finish real work over iMessage

## Target for the first release

A new user can create Ava, connect Google, add Ava to a 1:1 iMessage thread, and reliably complete three jobs:

1. **Calendar answer:** Ask what is on the calendar or when they are free. Ava reads the connected calendar, gives the relevant events or slots with the correct time zone, and says when access is missing or stale.
2. **Reminder:** Ask for a one-time or recurring reminder. Ava confirms the interpreted time, persists the schedule, and sends the reminder to the same iMessage thread when due. The user can list, change, and cancel it.
3. **Email:** Ask Ava to draft or send an email. Ava resolves the recipient, shows the exact draft, obtains approval for sending, sends once, and reports the provider's result. If the provider result is uncertain, Ava says so and does not retry blindly.

This is a product slice, not a claim that Ava can handle every personal-assistant task. Additional jobs become available only after they pass the same gates.

## Principle: a job is more than a prompt

Keep the model for interpreting natural language, resolving ambiguity, selecting evidence, and writing concise replies. Use typed application state and deterministic checks for side effects and completion.

Each deployable job needs a versioned contract:

| Field | Meaning |
|---|---|
| Capability and examples | Requests it accepts, including follow-ups and corrections |
| Required data and permissions | Which connection, scope, tool, and approval are needed |
| Inputs and clarification | Values that must be known before action; allowed defaults |
| State | Durable records the job creates or updates |
| Steps and retries | Tool sequence, idempotency key, timeout, and recovery behavior |
| Outcome predicate | Database/provider evidence that proves completion |
| Failure response | What the user sees when a connection, model, provider, or delivery fails |
| Tests | Offline contract tests plus real-provider and real-channel cases |

The agent creator should compile a request to *available job contracts*. It should show unsupported jobs and missing connections before deployment. Names, tone, schedules, and preferences can customize an agent; they must not imply an unavailable capability.

## Work plan and release gates

### 0. Establish a trustworthy baseline

**Build**

- Fix the external-identity reassignment bug in `src/channels.ts`: reject an ownership conflict before writing, inside a transaction; add a test that verifies both the return value and unchanged database owner.
- Add `.dockerignore` so local `.env*`, databases, reports, and `node_modules` cannot enter production image layers. Audit tracked example env files for real credentials.
- Pin a stable branch or worktree for the release while other feature work continues. Record exact test and build results for that revision.
- Separate demo mode from production mode. Production startup must fail clearly when a real model or required channel/provider credential is absent; never silently advertise a heuristic or sample data as a live agent.

**Gate:** identity cannot move across accounts on a rejected link; a built image contains no local secrets or database files; production readiness checks identify missing dependencies.

### 1. Make iMessage a dependable transport

**Build**

- Choose and document one Photon/Spectrum integration path for production. Ensure the inbound stream or webhook reconnects after disconnects and restarts; verify shared-line routing, 1:1 and group identity, media, reactions, and duplicate events.
- Persist inbound receipt, processing state, outbound attempt, and provider message ID. Expose `received`, `working`, `waiting for approval`, `sent`, `failed`, and `unconfirmed` to the operator and user where appropriate.
- Preserve per-conversation ordering, enforce idempotency, and reconcile interrupted sends without double-sending. Alert on a stopped stream, webhook rejection, growing queue, or failed outbox item.
- Exercise real phones and the actual bridge: first deploy, reply, approval tapback, long-running task, scheduled message, media, group mention, app restart, bridge outage, and reconnection.

**Gate:** a two-phone test run completes every scripted transport case; no duplicate action or message after replay/restart; failed or uncertain delivery is visible and actionable. Do not call a provider-accepted message `delivered` unless the bridge supplies a delivery receipt.

### 2. Implement the three Ava job contracts

**Build**

- Define a `JobContract` interface and durable job records. Connect the existing tool gateway, policy engine, approvals, and Temporal runs to contract steps and outcome predicates.
- Calendar: validate Google access and time zone, distinguish past from upcoming events, handle no results and expired OAuth, and cite the event IDs/times used internally.
- Reminder: store the interpreted local time, time zone, recurrence, next fire time, target conversation, and delivery state. Support list/change/cancel and daylight-saving transitions.
- Email: resolve recipient identity, keep a stable draft, bind approval to exact recipient/content, send with an idempotency key where supported, and reconcile ambiguous provider results.
- Make failures explicit: no connected account, no permission, unclear recipient/time, stale calendar event, provider outage, or task timeout. Never convert these into a cheerful completion message.

**Gate:** each job's completion is proved by state/provider evidence, not by the final reply or a model judge. An approval for one draft cannot authorize a changed draft.

### 3. Replace the agent-readiness gate

**Build**

- Replace the current rehearsal rule (`reply` or `tool attempted` often passes) with contract checks: required connection present, required action executed or correctly awaiting approval, outcome predicate true, and no unsupported claim.
- Give every advertised job positive, negative, ambiguous, failure, follow-up, and restart cases. Use real model calls for a separate eval gate; keep deterministic unit tests for protocol and policy.
- Replay opt-in, redacted pilot transcripts as regression cases. Measure task success, wrong action, false completion, unnecessary question, time to first useful reply, delivery failure, and cost.
- Do not score an unavailable judge as a pass. Report `not evaluated` separately from `passed`.

**Gate:** for the three Ava jobs, at least 95% of a fixed set of 30 representative requests pass across three model runs each; all safety and cross-account isolation cases pass; every failed request has an honest user-visible state. These are release targets, not current results.

### 4. Closed pilot, then self-service release

**Build**

- Run Postgres and Temporal acceptance gates on the release revision. Add database migrations, backups and restore drill, shared rate limiting, secret management, error monitoring, queue metrics, and an operator view for failed/unconfirmed work.
- Pilot with 5–10 consenting users over the real iMessage line for at least one week. Review failures daily and turn them into tests. Include users with different time zones and connected Google accounts.
- Make onboarding show exactly what Ava can do, which connections are needed, what actions need approval, and whether iMessage is healthy. Hide or clearly label incomplete catalog agents.

**Gate:** the pilot meets the job and delivery targets without manual intervention for normal cases; recovery and support procedures are exercised; users can see and revoke connections and stop schedules.

### 5. Expand by proven jobs, then channels

Add new contracts one at a time: meeting preparation, follow-up tracking, research, product watching, and reservations are distinct jobs with different data and recovery needs. Promote a catalog agent only when all of its advertised jobs pass the readiness gate. Reuse the same job records and outcome checks on Slack, Telegram, WhatsApp, and email; add each channel's own delivery and policy tests before release.

## What the project owner needs to supply

Nothing is needed to complete stage 0 or to build most contract and test scaffolding. Real integration and pilot gates need:

1. **iMessage:** a dedicated test line and Photon/Spectrum project access, two test phones/numbers, and permission to run restart/outage tests against that line.
2. **Google and models:** a Google OAuth test app/account with calendar and mail test data, plus a real model key stored in the deployment secret store. A production search API key is needed when adding research jobs.
3. **Product decisions:** confirm Ava's first three jobs, the approval rule for email, desired reminder behavior, supported time zones, and what Ava should say when an action is impossible.
4. **Examples:** 10–20 anonymized requests per job, including corrections, ambiguous asks, and examples of an unacceptable outcome. These become the fixed eval set.
5. **Operations:** a public HTTPS domain, deployment target, who receives incident alerts, pilot users, and acceptable spend/latency limits.

Provide secrets through a local env file or secret manager, not in this plan. The repository is actively changing, so stage 0 should establish a stable release revision before measuring progress.
