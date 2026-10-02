# Acceptance criteria

Every row is checked automatically by `bun run criteria`: it runs the test suite (JUnit), the typecheck and the web bundle build, then marks each criterion **pass** only when every test tagged with that ID passed. Plan section numbers refer to `agent_platform_product_technical_plan.md`.

## Milestone "must prove" scenarios (§28, §29, §32, §33, §21.2)

| ID | Criterion | Plan |
|---|---|---|
| AC-M1 | A user creates Ava on web, connects Google, later texts Ava over iMessage, and Ava recognizes the ongoing task in the same Room and resumes it correctly (approval given from iMessage, reply delivered there). | §28 |
| AC-M2 | Three teammates interact with one agent in a Slack channel; mention-only participation; the work (tasks, owners, blocked items) is visible in the Room; a teammate continues from an iMessage group without losing state. | §29 |
| AC-M3 | Group trip request over iMessage is research-only (no booking), per-person preferences are remembered in Room scope, and a second person continues on web in the same Room. | §32 |
| AC-M4 | Recruiting: a human-claimed candidate is never contacted, outreach requires the right approver, a transient bounce is retried, the run waits for the candidate, and the next-day inbound email resumes that run — the email is sent exactly once. | §33 |
| AC-M5 | Instructions inside fetched web content cannot trigger an external write; tool output is labeled untrusted; the write requires human approval even if configured automatic. | §21.2 |

## End-user journeys (register → describe → test → one-click deploy → real work)

| ID | Criterion | Plan |
|---|---|---|
| AC-J1 | Personal: landing page → register → describe an agent → Test mode runs the full pipeline but sends/books nothing (unconnected accounts use sample data) → one tap opens Messages with a deploy code → the agent works over iMessage and on web in the same Room; strangers on the shared line get instructions, not an agent. | §3, §28 |
| AC-J2 | Team: create for a team → invite → Add to Slack (OAuth) → pick a channel → teammates use it in Slack and in an iMessage group (agent name prefixed on the shared line) → account overview shows what each agent does and where it's deployed; tasks are listed. | §29 |
| AC-J3 | Reservations: watch a hot spot, pre-approve limits once (strong confirmation), and the agent books within seconds of the drop and texts the confirmation; the standing approval is used up. | §17.3, §19 |
| AC-J4 | Reservations without pre-approval: a one-tap (strong, for deposits) card arrives the moment a table opens; if the table is gone the agent says so honestly and books nothing. | §35.3 |
| AC-J5 | Group buying in an iMessage group: open an order, members join without tagging, chatter is ignored, tally on request, organizer-only close, deadline reminder, auto-close with per-person totals and pay links, payments tracked after close. | §15 |
| AC-J6 | Memory at both levels: agent-level knowledge stays with that agent; account-level personal facts follow the user to all their agents, privately. | §9.2 |
| AC-J7 | Real-time group chats: replies sent while an order is still being opened aren't lost (per-conversation run ordering); short orders don't get an instant "24h left". | §5.2 |
| AC-MCP1 | Connecting an MCP server discovers its tools (risk from tool annotations); granted agents call them through policy, approvals and audit; the server's credentials never appear in events. | §10, §27 |
| AC-MCP2 | browser.task runs on a granted MCP browser server; stored website logins (OpenTable/Resy) are passed only to the HTTP browser runner, follow ownership rules, and never reach the model or the logs. | §11.2 |

## Requirement layer: brief → confirm → execute → verify

| ID | Criterion | Plan |
|---|---|---|
| AC-B1 | Every request gets a structured brief (goal, deliverable, constraints, assumptions, side effects, done-when, plan); chit-chat skips it; simple actions start immediately and the model executes against the brief. | §7.4 |
| AC-B2 | When essential information is missing (and can't be looked up), the agent asks one batched question and runs nothing until it's answered; the answer continues the same task. | §7.4 |
| AC-B3 | Multi-step tasks show the plan with Go/Cancel and wait; "go" starts it, "cancel" drops it. | §3.4, §3.7 |
| AC-B4 | A mid-flight change re-briefs with a visible diff, withdraws stale approvals, re-confirms, and only the new action is executed. | §32, §35 |
| AC-B5 | Results are checked against "done when" before reporting; gaps are retried once, then disclosed. | §35.3 |
| AC-B6 | Plan steps tick off as tools succeed; the agent can re-plan; long waits post one progress note instead of chat spam. | §3.3, §37 |
| AC-B7 | Brief cards work from channel buttons, scoped to their room. | §5.3 |
| AC-B8 | Confirmation is decided by a deterministic policy with a per-agent mode (smart / always / never); a single external write relies on its approval card instead of asking twice. | §19.3 |
| AC-B9 | Unanswered questions and unconfirmed plans expire after 72h instead of guessing. | §2.8 |
| AC-K1 | After the same kind of task succeeds 3 times, the agent offers once to save it as a skill; saved skills guide future runs; buttons are room-scoped. | §11.3 |
| AC-F1 | Files (text and PDF) uploaded into a room are readable by the agent; files are scoped to their room and workspace. | §17.2 |
| AC-O1 | Onboarding: empty workspaces offer one-click agents; agents come with starter prompts and a setup checklist (connect, reach from phone, first task). | §3.3, §38 |

## Permissions & policy (§19)

| ID | Criterion | Plan |
|---|---|---|
| AC-P1 | Risk classes (read, internal write, external write, destructive, financial) map to deterministic decisions; destructive always asks; financial needs strong confirmation. | §19.2 |
| AC-P2 | Per-agent permission modes (never / first-time / ask / always-ask / auto) and per-call prior approval are enforced; tools outside the agent's skills are denied. | §19.1, §19.3 |
| AC-P3 | Connections must exist, be granted to the agent and active; a private connection is unusable in a room its owner isn't in. | §2.6 |
| AC-P4 | Writes touching a human-owned (blocked) subject are denied even if approved; tainted runs and exhausted write budgets force approval. | §15, §21.2, §7.5 |

## Tool gateway & reliability (§10, §35)

| ID | Criterion | Plan |
|---|---|---|
| AC-T1 | Tool inputs are schema-validated; invalid or unknown calls never execute and the model is told why. | §10.2 |
| AC-T2 | Repeated identical external writes execute once (fingerprint idempotency). | §35.1 |
| AC-T3 | Retry taxonomy: RATE_LIMIT waits until retry-after, AUTH pauses and asks the owner to reconnect (resumes on reconnect), UNKNOWN_SIDE_EFFECT stops for human verification and never blindly resends. | §35.2 |
| AC-T4 | Web fetch refuses private-network targets (SSRF). | §21.1 |
| AC-T5 | After a crash mid-write, recovery re-queues the run and refuses to double-execute. | §7.2, §35.1 |
| AC-T6 | Decrypted credentials never reach the model, events, or traces; the audit records which connection was used. | §10.2, §21.3 |
| AC-T7 | Run budgets stop runaway agents and tell the room. | §7.5 |
| AC-T8 | Everyday tools work: free-time search across calendars, contact lookup feeding an email (instead of asking), Drive search/read. | §10.4 |

## Runtime: Rooms, Runs, waits, delegation (§2, §7, §15, §16, §37)

| ID | Criterion | Plan |
|---|---|---|
| AC-R1 | Every run leaves an append-only event trace (context → model → tool proposal → permission → execution → reply) and a deterministic "why did it send this" answer; runs are classified. | §21.5, §23.1, §24.1, §7.4 |
| AC-R2 | Approvals: rejection is relayed to the agent, approvals expire after 72h, only designated approvers may decide. | §3.7, §19 |
| AC-R3 | Financial actions require strong confirmation; first-time tools remember the grant. | §19.2 |
| AC-R4 | Group participation modes: mention-only, relevant, manager. | §15.2 |
| AC-R5 | Delegation is typed: child run sees only its objective, gets a smaller budget and no autonomous writes, and the parent resumes with the result. | §16 |
| AC-R6 | Wake conditions: time, recurring, timeout, event and state triggers create runs; proactive messages go to the last-used channel. | §37 |
| AC-R7 | One agent in many rooms: room memory and work state never cross rooms. | §41 B |
| AC-R8 | Model outage: retry with backoff, then fail terminally with a message. | §8.3 |
| AC-R10 | Platform-hosted inference stops at the plan's monthly allowance with a clear message; BYOK usage isn't counted. | §22 |
| AC-R9 | Cancelling a run cancels its waits and pending approvals. | §2.8 |

## Memory (§9, §15.4)

| ID | Criterion | Plan |
|---|---|---|
| AC-MEM1 | Private DM memory never enters a shared room's context; it is available in the DM; provenance is stored. | §9.2, §9.3 |
| AC-MEM2 | Private chats can't write team memory; shared rooms can, explicitly. | §15.4 |
| AC-MEM3 | Workspace knowledge is withheld when an outside guest is in the room. | §9.5 |
| AC-MEM4 | Extraction scopes by room type and dedupes repeats (merging provenance). | §9.4 |
| AC-MEM5 | Retrieval ranks relevant memories first and respects expiry. | §9.6 |

## Channels & identity (§5, §6, §20, §21.6)

| ID | Criterion | Plan |
|---|---|---|
| AC-C1 | Every webhook (Telegram, Slack, WhatsApp, Resend email, iMessage bridge, Twilio) verifies its signature; forged and replayed requests are rejected and logged. | §21.6 |
| AC-C2 | Provider retries are deduplicated; ingestion is separate from processing (no LLM call inside the webhook). | §5.2 |
| AC-C3 | WhatsApp subscription handshake, Slack URL verification, and Slack's duplicate message/app_mention events are handled. | §6.2, §6.4 |
| AC-C4 | Unknown senders become untrusted guests; linking is explicit and verified with single-use codes; the guest's DM moves into the user's own Room. | §20 |
| AC-C5 | Approval cards render natively (Telegram inline keyboard, Slack Block Kit, WhatsApp interactive buttons) and can be decided by button. | §3.7, §5.3 |
| AC-C6 | Agent-owned mailbox: inbound email maps to a Room, quoted text is stripped, replies thread by subject with an idempotency key. | §6.5 |
| AC-C7 | Phone: Twilio speech turns run through the same agent and Room; signatures are bound to the public URL. | §6.6 |
| AC-C8 | Failed deliveries retry and give up after 5 attempts without blocking the run. | §5.3 |
| AC-C9 | Rapid message bursts on a messaging channel are combined into a single run (debounce). | §5.2 |

## API, tenancy, public agents (§2.1, §18, §21.4, §22, §34, §38)

| ID | Criterion | Plan |
|---|---|---|
| AC-A1 | Auth: signup creates a personal workspace; bad credentials and anonymous calls are refused. | §2.1 |
| AC-A2 | Tenant isolation: other workspaces and other people's private rooms are invisible (even to co-admins). | §21.4 |
| AC-A3 | Create an agent from a natural-language description into a draft (job, skills, connections, permissions, channels) without seeing a prompt; edit permissions with validation. | §3.4 |
| AC-A4 | Web chat → approval card → Home "needs attention" → decision API → trace shows approver and connection used. | §3.3, §3.7, §34 |
| AC-A5 | BYOK keys and connection credentials are sealed at rest and never returned or logged; revoke wipes credentials and grants. | §8.4, §21.3 |
| AC-A6 | Invitations, roles and plan limits (agent count, channel availability) are enforced. | §22.1, §29 |
| AC-A7 | Audit export is admin-only; the usage ledger tracks raw resources independently of billing. | §21.5, §22.2 |
| AC-PUB1 | Discovery lists the curated first-party agents; install runs onboarding and requests only needed connections. | §17, §18.2 |
| AC-PUB2 | Fork copies configuration only; publishing is curated; risky manifests are flagged for review; invalid manifests are rejected. | §18.4, §18.5 |
| AC-PUB3 | Reviews require meaningful usage; creators see aggregates only. | §18.3, §30 |
| AC-PUB4 | Anonymous trial without an account, upsell after a few turns, hard limit, no external writes. | §38 |
| AC-PUB5 | Template upgrades change configuration but keep the instance's memory and connections. | §2.3 |

## Security hardening (from independent review)

| ID | Criterion | Plan |
|---|---|---|
| AC-S1 | Outside guests can't use workspace connections and can never approve their own actions (approval falls back to workspace admins). | §21.1, §19 |
| AC-S2 | A teammate's private connection needs its owner's approval for any use by someone else, including reads. | §2.6 |
| AC-S3 | Channel conversations can't be hijacked: only admins attach group conversations, DMs can't be attached, existing links are never re-pointed. | §20, §21.4 |
| AC-S4 | The approvals list never shows other people's private rooms. | §21.4 |
| AC-S5 | Only verify/reconnect waits can be resolved by hand, and only by their owner (no stuck runs from forced resumes). | §2.8 |
| AC-S6 | The agent can't lift a human's blocked guard or change a human-owned task. | §15, §33 |
| AC-S7 | Only a bare yes/no/approve/reject reply decides an approval. | §3.7 |
| AC-S8 | Web fetch re-checks every redirect hop and every resolved address (incl. IPv4-mapped IPv6) against private ranges. | §21.1 |
| AC-S9 | Link codes are 8 digits, single-use, and senders are locked out after 5 misses per hour. | §20.2 |
| AC-S10 | Rooms with outside guests and runs that read untrusted content can't write workspace memory. | §9.4, §21.2 |
| AC-S11 | Instances only upgrade to reviewed, published template versions; a version under review doesn't delist the live one. | §18.4, §30 |
| AC-S12 | Cross-workspace agents, drafting against another workspace's keys, and email header injection are refused. | §21.4, §8.4 |
| AC-S13 | Cancelling a task while the model is thinking is final: the late answer can't resurrect it or create approvals. | §2.8 |
| AC-S14 | A requirement change that lands mid-step wins: the stale step stops, approvals for the old requirement are withdrawn, and only the new action runs. | §35.1 |
| AC-S15 | Only the agent's owner or a workspace admin can save a learned skill; examples come only from that room's member-requested runs. | §18.3, §21.1 |
| AC-S16 | Messages addressed to another agent are never folded into someone else's pending task. | §15.2 |
| AC-S17 | Unicode file names download correctly; free-time search inputs are bounded; finished tasks can't be cancelled again. | §21 |
| AC-S18 | Deploy codes can't move a number that belongs to another real account; codes only work on the app and chat type they were issued for; posting a group code links nobody; codes can't be redeemed over (forgeable) email; attempts are rate-limited per sender and globally. | §20.2 |
| AC-S19 | On the shared email line the recipient alias picks the agent and each (sender, alias) is its own conversation, so one sender can't leak across workspaces. | §21.4 |
| AC-S20 | A pre-approval covers only bookings from its own watch, by the person who granted it, in the same conversation — never other venues, people or rooms. | §19 |
| AC-S21 | A watch offers each opening once and pauses after a "no" (resumable with "keep watching"); test mode creates no real watches or memories. | §37 |
| AC-S22 | A crash inside a run fails that run without blocking later messages in the conversation; stale 'running' runs are re-queued after a lease. | §7.2 |
| AC-S23 | Only one open group order per chat, opened by a recognized workspace member — no competing order with someone else's pay link. | §15 |
| AC-S24 | MCP requests re-validate the address on every call and refuse redirects (no SSRF via DNS changes or redirects). | §21.1 |
| AC-S25 | Re-installing Slack from another workspace can't take over an existing Slack connection. | §21.4 |

## Quality gates

| ID | Criterion | Plan |
|---|---|---|
| AC-EV1 | The versioned golden-task suite passes 100% on the offline baseline model across all platform dimensions (tool selection, approval, boundary, completion, response, memory, clarification). | §23.3, §23.4 |
| AC-EV2 | Any real run exports as a golden case (evals/cases/*.json) that replays and passes. | §23.4 |
| AC-Q1 | TypeScript typecheck passes with `strict`. | — |
| AC-UI1 | The web app bundles without errors (Home, Agents, Create Agent, Agent page tabs, Rooms with work panel, Discover/trial, Connections, Activity, Settings). | §3 |
