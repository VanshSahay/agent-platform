# Agent intelligence: implementation plan

**Baseline:** GitHub `main` at `3f7985e` (2026-10-07). **First release:** Ava in a 1:1 iMessage chat, with Google Calendar, Gmail, contacts, and reminders. Extend to Booker, Buyer, Milo, and other channels only after the same outcome gates pass. This plan builds on [the earlier transport and pilot plan](../REAL_AGENTS_PLAN.md).

## 0. Latency-first correction to this plan

The architecture below is a target, **not a prerequisite checklist for the first improvement**. The current path can make a separate model call to draft a brief, one or more calls to choose/use tools and compose the reply, and sometimes a judge call to check it. Adding an interpreter, plan review, action graph, specialist, and final judge to every message would make an already slow chat worse. Recent local work also addresses some baseline correctness problems; measure its effect before rebuilding those checks.

Ship this smaller sequence first:

1. **Measure before adding components.** Timestamp inbound receipt, queue, brief start/end, each model call, each tool call, gate, outbox and iMessage delivery. Report p50/p95 time to first useful reply and to verified completion, model-call count, tool-call count, cost, and failure rate by request class. Use 20–30 real or realistic Ava requests. No new model call for telemetry.
2. **Give simple requests a fast path.** For chat, one lookup, or one reminder with all required details, skip the separate model brief and judge. Use one model/tool loop or a validated deterministic action, existing policy/approval, and a deterministic result check. Ambiguous recipient, date, permission, or side effect exits the fast path. Never silently use a keyword fallback for a write.
3. **Keep the deliberate path for compound work.** Use an explicit brief and durable state only when the request has multiple dependent actions, waits for a person/provider, external writes, corrections, or uncertain results. Combine interpretation and plan in one model call. Run independent reads concurrently; ask a review model only when a concrete high-impact ambiguity remains. Do not spawn a specialist for a simple lookup.
4. **Fix false completion in place.** Bind requested recipient/date/action to existing `run_steps`, `tool_executions`, approvals and provider IDs. First implement Ava-specific checks for email send, calendar, and reminders inside the current run/gate path. Add new tables or a generic capability registry only when the Dana journey shows that existing `runs`, `brief`, waits and events cannot represent a required state cleanly.
5. **Release on both quality and speed.** Each change must reduce false completion without regressing p50/p95 latency for simple requests. Set numerical latency targets from the measured baseline and the owner's acceptable wait, then compare the same cases on the same model/provider. Give an immediate, useful acknowledgment for long work and a later completion message; an acknowledgment is not completion.

In this order, the first deliverable is a faster, more truthful Ava, not a new orchestration framework. The detailed PRs below are an expansion path; PRs 1–4 should be trimmed or deferred if the current run model can pass the same acceptance cases with less code and fewer serial calls.

## 1. The actual problem

The platform already has Rooms, durable Runs, tool policy, approvals, memory, a task brief, a completion gate, and parallel read specialists. It can execute many scripted journeys. The missing layer is a faithful, durable representation of **what the person meant and what would prove each requested outcome**. Today `src/intake.ts` reduces a request to a short brief and steps keyed mostly by tool name; `src/gate.ts` checks tool names, counts links/items, or asks a judge about the final reply. `src/jobs.ts` uses wording rules for six broad jobs. Consequently, a plausible plan and a successful tool call can still be the wrong task.

There are also secondary causes:

- At the baseline commit, `structured()` in `src/model.ts` discarded whether a model/JSON failure caused a heuristic result. Local uncommitted work now uses `structuredWith()` in the brief and judge paths; keep the failure status visible in the final outcome.
- The task classifier and follow-up router can misread ordinary language; the first detected job controls the missing-connection precheck.
- Tool evidence is not consistently bound to requested entities and constraints. At the baseline commit, `email.draft` could satisfy a send request; local uncommitted work adds a send-specific check and some fact matching. Extend those checks from observed failures before creating a new evidence system.
- At the baseline commit, the judge fallback in `src/gate.ts` returned `missing: []`, so an unavailable quality check could look like a pass. Local uncommitted work now records unavailable judgments explicitly; preserve that behavior with a regression case.
- The current specialists are child runs of the same agent with restricted tools. They provide parallel lookup, but no independent domain contract or verified output. Their costs are not yet charged against one atomic parent task budget.
- At the baseline commit, `src/experience.ts` could record playbooks for unverified outcomes. Local uncommitted work adds a verified-outcome guard; test it against each false-completion case.
- New catalog agents advertise far more jobs than have independent success cases. Milo has 21 skills and no listed evals in its manifest. Self-generated rehearsals are useful for onboarding, not proof of capability.

**Design rule:** models interpret, decide what evidence to gather, and explain results. Application code validates permissions, executes side effects, reconciles provider state, and decides whether a specific action is verified. An LLM judge can assess answer quality but cannot turn missing evidence into a completed action.

## 2. The first end-to-end target

Use one task that forces the architecture to work, not a larger catalog. Example:

> “Find two 30-minute times with Dana next week, email her the options, and remind me Friday if she hasn't replied.”

Expected behavior:

1. Resolve Dana from a granted contact source, or ask which Dana if ambiguous. Use the requester's time zone and working-hours preference.
2. Check the actual calendar for two free 30-minute slots next week. Do not create a calendar event merely because the user asked to propose times.
3. Compose an email naming those exact slots and Dana's resolved address. Ask for approval of the exact recipient, subject, and body.
4. Send once. Reconcile an uncertain Gmail response by stable message identity; record `verified_sent` only with provider evidence.
5. Track a reply to that message/thread through Friday. If a reply arrives, close the follow-up. If not, send a reminder to the same iMessage conversation once.
6. At every point, tell the person whether the task is **working**, **waiting for approval**, **waiting for Dana**, **verified done**, **blocked**, or **uncertain**. A draft or an approval request is never reported as “email sent.”
7. Survive a server restart, a duplicate webhook, a changed instruction (“make that Tuesday only”), and a revoked Google connection without a duplicate send or stale action.

This is the first acceptance journey. Keep the existing simple calendar, reminder, and email jobs as regression cases.

## 3. Target architecture

```text
iMessage event -> Room/identity -> Task interpreter -> durable Task + Action graph
                                             |                 |
                                  missing facts?         independent reads?
                                  ask one question       bounded specialists
                                             |                 |
                                             +---- executor ----+
                                                       |
                                        policy / approval / tool gateway
                                                       |
                                      provider evidence + action verifier
                                                       |
                                      replan, wait, or verified result
                                                       |
                                              one Ava reply in iMessage
```

### 3.1 Data model

Add additive tables to `src/db.ts`/`src/pg.ts`; keep existing Runs, events, approvals, waits, and `tool_executions` as the execution log. Do not overload the existing `tasks` table, which tracks human to-dos.

| Table | Key fields | Purpose |
|---|---|---|
| `agent_tasks` | `id`, `workspace_id`, `room_id`, `run_id`, `requester_id`, `revision`, `original_request`, `goal`, `status`, `created_at`, `updated_at` | Durable user request and visible state. |
| `task_actions` | `id`, `task_id`, `revision`, `kind`, `mode`, `target`, `inputs`, `constraints`, `depends_on`, `status`, `capability_version`, `approval_id`, `idempotency_key` | Each requested outcome, not just a tool name. |
| `action_evidence` | `id`, `action_id`, `run_id`, `tool_execution_id`, `type`, `provider_ref`, `facts`, `observed_at`, `verifier_version`, `verdict` | What proves or disproves an action. Store references and sanitized facts, not credentials. |
| `task_revisions` | `task_id`, `revision`, `message_event_id`, `change`, `created_at` | Append-only history of corrections and clarifications. |

Example action graph: `resolve_contact(Dana)` and `find_free_slots(next_week, 30m)` can run together; `compose_email` depends on both; `send_email` depends on an exact-draft approval; `watch_reply` depends on the sent message ID; `remind_if_no_reply` depends on the watch's Friday outcome. Each node is `not_started`, `running`, `waiting_human`, `waiting_external`, `verified`, `blocked`, `uncertain`, or `cancelled`. The parent task is `verified` only when all required terminal outcomes satisfy its success predicate.

Use a versioned capability registry (`src/capabilities/`) rather than free-text action kinds. Each capability defines a schema for required slots, allowed tools, connection scopes, approval rule, verifier, recovery procedure, user-visible failure, and fixture cases. Start with `contact.resolve`, `calendar.find_free_time`, `email.compose`, `email.send`, `email.wait_for_reply`, and `reminder.schedule`; map existing simple jobs to the same registry. Unsupported capabilities must be shown as unsupported at creation/deployment time.

### 3.2 Interpreter and planner

Create `src/intent/interpret.ts` and `src/intent/validate.ts`. Input: original request, requester, channel, relevant confirmed preferences, active-task state, and the capability registry. Output: a versioned task proposal containing actions, entities, constraints, dependencies, ambiguity, and explicit unanswered questions. Never let a planner invent a capability or connection.

- Route trivial, unambiguous requests cheaply. Use a stronger planning model for multiple actions, references to earlier messages, ambiguous people/dates, external writes, privacy boundaries, and anything that failed a first interpretation. Avoid classifying complexity solely by message length or keywords.
- Validate JSON against a strict schema and capability registry. On model/parse failure, record `interpretation_unavailable` and either retry with a configured model or ask for clarification. Preserve the offline heuristic only for demo/tests, with a visibly different status.
- Run a deterministic feasibility pass: required slots known, connection active, permission granted, dependent action present, no unauthorized side effect, and no contradictory constraints. The model may propose a question; code decides whether the plan is safe to run.
- Preserve both the person's original wording and the parsed slots. Corrections create a new revision; unaffected verified actions remain evidence, while stale pending approvals, tool calls, and specialist results are invalidated. Attach replies to a task by explicit wait/approval/thread identity where possible; use a model to resolve genuinely ambiguous follow-ups, never silently redirect a correction to a new task.
- Add a small plan-review call for high-impact multi-step tasks: compare the proposed actions to the original request and flag omitted actions, invented actions, and wrong people/dates. This is a planning check; it does not grant permission or prove completion.

### 3.3 Executor and provider evidence

Create `src/orchestrator/advance-task.ts` to choose runnable nodes from the graph. Reuse `src/runtime.ts` for durable runs/waits, `src/policy.ts` for permissions, and the existing tool gateway/idempotency fingerprints. The executor should:

1. Re-read the task revision and action status immediately before any tool call or approval. Reject stale work.
2. Start only nodes whose dependencies and required connection/permission checks pass.
3. Execute independent reads concurrently; serialize writes that could conflict. Charge all child work to one atomic task budget (model calls, cost, tool calls, browser minutes), not just separate per-run budgets.
4. Persist the tool input, result, provider ID, and relation to the action. A successful call must identify **which action and which slots** it addressed.
5. Distinguish `submitted`, `provider_accepted`, `verified`, and `uncertain`. Reconcile unknown side effects before retry; never infer delivery from the agent's words.
6. On tool failure, decide among retry, alternate tool, clarification, or blocked state. Replan only the unverified remainder; do not restart the entire task.

Implement deterministic verifiers in `src/capabilities/*/verify.ts`. Calendar read: date interval and zone of the provider response match the request, with cited event/slot IDs. Reminder: persisted schedule has the right text, local time, recurrence, destination and later delivery state. Email: recipient/subject/body hash matches the approved draft and the provider message ID is reconciled. Follow-up: the watch is tied to that message/thread, deadline and recipient, and fires only when no reply was observed. Booking and payment verifiers come later.

Update `src/gate.ts`: job/action evidence takes priority over reply phrasing. A pending approval produces `waiting_human`, never `done`; a draft cannot satisfy a send. Tool-name-only claims are allowed only for simple read steps where the returned scope and freshness are checked. Judge failures become `not_evaluated`; they never mean `missing: []`. The final reply is generated from task state and evidence, then checked for unsupported completion claims.

### 3.4 Specialists

Keep Ava as the only user-facing manager. Extend the existing `specialists.run` path rather than adding an unrestricted agent-to-agent chat. A specialist request must carry `task_id`, `action_ids`, objective, allowed context, allowed read tools, deadline, and budget slice. Its result must be schema-validated: `facts`, `sources/provider_refs`, `confidence/uncertainty`, `proposed_actions`, and `unresolved_questions`. A plain-text fallback is marked `unverified`.

Start with read-only `calendar/contacts`, `research`, and `browser lookup` specialists. Give each different instructions and tool descriptions, not merely the parent agent's full skill list. Their findings are evidence candidates; the parent checks consistency and decides next actions. Children cannot send messages, book, pay, or create a new delegation tree. Cancel them when the task revision changes. One task-level budget ledger atomically reserves and settles spend across parent and children.

Do **not** make every request multi-agent. Split only independent work that saves time or needs a genuinely different tool/context boundary. A simple reminder should stay one run.

### 3.5 Memory and learning

Separate four kinds of state: (1) user preferences with owner, source, confidence and expiry; (2) provider facts with timestamp and source; (3) open task/action state; (4) playbooks about how to perform a task. Conversation summaries help language continuity but are not evidence that an action happened.

Change `recordPlaybook` so only a **verified** task with no unresolved warning increments a successful playbook. Failed and uncertain tasks become failure examples with reason codes, not success instructions. Retrieval should show provenance and staleness to the planner. Cross-room and family sharing remains governed by the existing explicit boundary; a child specialist receives only facts the parent is authorized to pass. Add tests for stale facts, conflicting preferences, privacy, and correction of remembered information.

## 4. Delivery sequence (small reviewable PRs)

| PR | Work | Acceptance gate |
|---|---|---|
| 0 — Baseline | Freeze commit/model/provider settings for evaluation; instrument `intent_parse`, `plan_review`, `action_verdict`, `task_terminal`, and model fallback reasons; build a failure taxonomy from opt-in, redacted traces. | A trace shows original request → parsed actions → calls → provider evidence → final state, with model version and cost. No sensitive content in analytics. |
| 1 — Data layer | Add task/action/evidence/revision tables, migrations for SQLite and Postgres, typed interfaces, read APIs. Shadow-write task graphs beside legacy runs, with no behavior change. | Both dialects migrate an existing DB; old runs still work; a task can be replayed from its events. |
| 2 — Ava intent | Add strict schemas and feasibility checks for calendar, contacts, email, reminders and reply-watch; classify multi-action requests and corrections; explicit fallback status. | Held-out interpretation cases recover every requested action and constraint; wrong/ambiguous person or date blocks the write. |
| 3 — Ava outcomes | Bind tool executions and approvals to action IDs/inputs; implement provider verifiers and uncertain-write reconciliation; replace Ava's regex completion path. | Draft ≠ send; wrong recipient/time/body ≠ done; duplicate approval/webhook/restart causes at most one send; missing Google access gives a clear blocker. |
| 4 — Task loop | Execute the action graph across waits, approval, replies, restarts and revisions; expose concise task state in iMessage and the app. | The Dana journey succeeds through restart, changed instruction, expired connection, no reply, and reply-before-Friday variants. |
| 5 — Specialists | Schema-validated child outputs, scoped context/tools, parent join, cancellation, atomic task budget. | Independent reads run in parallel; one child failure is visible; parent cannot cite an unverified child claim as fact; aggregate cost stays within the task cap. |
| 6 — Learning | Verified-only playbooks, provenance-aware retrieval, correction/forget flow, failure examples. | A false or uncertain completion never becomes a successful playbook; private facts never appear in a group or sibling's context. |
| 7 — Builder/readiness | Show supported capabilities and required connections per agent; gate catalog claims by job-specific evidence; keep unproven jobs beta. | Users cannot deploy a spec promising an unavailable action as proven. Rehearsal reports `pass`, `fail`, or `not evaluated` honestly. |
| 8 — Pilot | Run model evals and real iMessage/Google tests on the exact release SHA; tune using failure cases, not the held-out set. | Release gates below pass and an operator can recover a stuck/uncertain task. |

Implement PRs 1–4 as the first vertical slice. Avoid a broad framework rewrite or a new agent SDK until this slice can complete the Dana journey; the current Bun/TypeScript runtime, Postgres, approvals and tools are reusable.

**Dependencies and sizing:** PR 0 precedes any metric claim. PR 1 precedes PRs 2–4; PR 2 and the provider verifier work in PR 3 may proceed in parallel after the schemas are fixed. PR 4 joins them. PR 5 depends on task-level budget accounting; PR 6 depends on verified task verdicts; PR 7 depends on the registry and per-capability eval results. For a focused team of two backend engineers plus part-time product/QA, budget roughly 2 weeks for PRs 0–2, 3–4 weeks for PRs 3–4 and the first live iMessage tests, then 3–5 weeks for PRs 5–8 and pilot hardening. These are planning estimates, not release dates; approval/provider edge cases may extend them. Keep a working deploy after every PR and add a feature flag to route only test users through the new task engine until the real-phone gate passes.

### After Ava: make the platform reusable

Use the same action/evidence contract to add domains one at a time. For each new capability, ship its input schema, permission and connection requirements, provider adapter, verifier, recovery rule, examples, and held-out eval cases together. A new persona or channel must not create a second planner or completion system.

| Order | Scope | Release proof |
|---|---|---|
| 1 | Research for Ava and Milo: replace the production dependence on keyless DuckDuckGo with a configured search provider; retain fallback only as degraded service. Add query reformulation, source opening, freshness/claim checks, and citation provenance. | Search outage is visible; the agent distinguishes a snippet from an opened source and cannot present an unverified price or availability as current. |
| 2 | Browser work: bounded sessions, explicit allowed sites/actions, screenshots or DOM evidence, safe resume after interruption, and a human handoff for login/CAPTCHA. | A browser task can be replayed and audited; uncertain submissions are reconciled before retry. |
| 3 | Booker/Buyer: availability and price checks, exact-item approval, reservation/purchase state, cancellation and refund state. | Domain-specific cases pass with real sandbox providers; no booking or payment is called complete on a submitted form alone. |
| 4 | Custom agent builder: capability selection and instruction templates backed by the registry, connection checks, policy limits, eval fixtures, and publish readiness. | A user can deploy only the actions that have working adapters and tests; unsupported requests produce an honest limitation. |
| 5 | Slack and WhatsApp: channel-specific identity, consent, threading, delivery receipts, retries, and attachment semantics feeding the same durable task engine. | The same task cases pass on each channel, including duplicates, edits, delivery failure, and handoff between channels where identity is confirmed. |

The current `web.search` tool already tries keyed providers before DuckDuckGo. The production issue is that the keyless fallback has no reliability guarantee, and research quality still depends on opening and verifying sources; swapping search vendors alone does not fix task understanding.

## 5. Evaluation and release gates

Build a private, versioned dataset from real phrasing, not generated only from template starters. For each Ava capability include direct requests, paraphrases, compound requests, ambiguous names/dates, missing connections, corrections, refusal/approval, time-zone changes, duplicate events, provider uncertainty, restart, and stale memory. Record expected **action graph and evidence**, not merely expected final text. Keep a held-out set that prompt authors do not inspect during tuning.

Run three layers:

1. **Deterministic tests:** schemas, routing, permissions, provider verifiers, idempotency, privacy and migrations. No model required; no unauthorized send, cross-user leak, or duplicate external write in the test set.
2. **Model-in-the-loop eval:** fixed model/config/commit, 30+ representative Ava tasks repeated three times, with simulated provider APIs but realistic data and failures. Score action extraction, slot accuracy, verified completion, false completion, needless clarification, cost and latency separately. A missing model or judge is `not evaluated`, never pass. Proposed gate: ≥95% verified task success on the release set and zero false completion/unsafe-action cases; report both pass@1 and all-three reliability.
3. **Real integration pilot:** two phones, the actual iMessage line, a Google test account, then 5–10 consenting users for 1–2 weeks. Inspect delivery receipts/unknown states, approval round trips, corrections and restarts. Prove the deployment actually used: `fly.toml` currently runs the built-in local engine on one always-on machine, with requeue-on-restart; exercise that path. Run Postgres tests and a restore drill. Move to Temporal when workload/availability requirements justify it, and rerun these gates after the move.

Require every published capability to have its own case set and verifier. Booker, Buyer and Milo can remain beta while Ava passes; their breadth does not become an Ava launch blocker. Do not claim live iMessage reliability from signed-webhook tests alone.

## 6. Additional decisions and owner inputs

The code and synthetic eval work can start without new secrets. Live gates need the following from the project owner, supplied through the existing secret store rather than this document:

- **Product scope:** confirm Ava's first release includes calendar lookup/free time, reminders, email drafting/sending and conditional follow-up; decide whether it may create calendar events in that release. The default here is **only when explicitly requested and approved**.
- **Examples:** 20–30 anonymized real requests, including at least five where a previous agent misunderstood the user, and examples of unacceptable outcomes. We can start with synthetic cases while waiting.
- **Models:** the production model/provider configuration and an evaluation budget. Keep a stable, capable model for the planner and executor during measurement; record the actual model on every step.
- **Integrations:** a Google test account/OAuth client, a working iMessage line and two test phones/numbers, permission to perform duplicate, outage, approval and restart tests, and later a small consenting pilot cohort.
- **Operations:** who receives incident alerts, the acceptable cost and latency per task, data-retention expectations, and whether the Fly single-machine engine is the pilot target.

## 7. Definition of “intelligent enough”

Do not use a subjective demo as the gate. For the first Ava release, the system is intelligent enough when it reliably extracts the whole request, asks only for consequential missing facts, chooses a feasible plan, changes course when evidence contradicts the plan, completes each permitted action exactly once, explains blockers and uncertainty, and never says a task is done without matching provider or database evidence. It should pass those checks on new wording from real people, not only the phrasing used to build it.
