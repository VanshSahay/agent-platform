# Ship plan

How we deliver the contract: Milestone 1 (deployable infrastructure + working prototype, real iMessage) by **2026-11-02**, Milestone 2 (capable agents across the six families, breadth per [use-cases.md](use-cases.md)) by **2026-11-16**, then handover. The strategy, agreed with the owner: **make the brain strong first; tools are plug-and-play behind `src/tools/hands.ts`** — a real adapter must never require a brain change. What Ellie saw in Fo (an easy coffee order) is reasoning quality, not a tool list.

## Architecture verdict

Keep the architecture. One Bun process, one SQLite file (WAL), append-only run events, typed objects (agent/session/run/event/tool-call/attention/schedule/artifact), policy in data not prompts, one gate, hands interfaces with fakes. This matches what the Fo reconstruction found ("no inspected evidence requires a swarm of subagents") and what the harness review measured ([research/always-on-agents-talk.md](research/always-on-agents-talk.md)).

Not doing: Temporal (the loop is nearly activity-shaped; resume-in-place gives the behaviour on our own ledger), Postgres (SQLite on a volume serves one process at this scale; backup/restore goes in the runbook), per-agent VMs, agent swarms.

## The decisions, in order of leverage

| # | Decision | Why | Size |
|---|---|---|---|
| 1 | **Context economics.** Split the system prompt into a stable cached block (identity, soul, rules, skills index) and a volatile block; select tools per run (core set + catalogue tools whose provider is wired) instead of sending all 99 schemas (~11.9k tokens measured) every turn. Fixed within the run so the prefix caches. | The largest attention and cost tax on the brain; the cheapest big win | day |
| 2 | **Durable execution.** Boot resumes interrupted runs from the saved transcript instead of failing them; fingerprint idempotency guard on side-effect tools; delivery idempotency. | Contract §6: resume from a safe checkpoint, never blindly repeat an email or calendar write. The ledger already exists; only the resume is missing | day |
| 3 | **Message priority rules.** The requester steers or interrupts; another member's new request starts its own run; rapid messages coalesce. | Contract §6 group concurrency; [multiplayer-spec.md](multiplayer-spec.md) §8.2 | half day |
| 4 | **Task agents get a tool subset and higher effort; the main agent optimises for latency.** | Helpers do the grinding; the room gets speed | hour |
| 5 | **Post-run outcome summarisation** as a deferred sweep, feeding memory, the ledger and suggestions. | Fo's `SummarizeRunOutcome`; every run improves the long-term picture | half day |
| 6 | **Webhooks → `handleEvent`**: Vapi post-call, Gmail push. | Real always-on triggers for M2; each under 100 lines | half day each |
| 7 | **Per-agent workspace and `save_skill`** (the agent files its own procedures). | Learn-by-watching; after memory consolidation proves insufficient | day |
| 8 | **Store: SQLite stays.** Deploy as one process on a volume host; document backup/restore and rollback. | Resolves the spec's open store decision with the simplest thing that meets M1 | — |

Plus, already started: `revise_plan` (the model re-plans from what it learned; the ladder stays as the floor). The working rule from here on: **every bug becomes an eval**; the contract's §6.1 reliability matrix (restarts, duplicates, concurrency, cancellation, expired access) becomes offline tests and eval scenarios.

Shipped so far: items 1–3 (two-block cache + per-run tools; boot resume + side-effect idempotency; message priority rules), refined after merge — a member's contribution to a live errand joins it attributed; only a separate ask queues. Item 8 is decided and done: **Fly.io on the Company's account, SQLite on a volume** (it replaced the earlier Railway deploy; see [runbook.md](runbook.md)).

**Ellie's sweep (2026-10-21, merged 1ab1278)** absorbed and superseded parts of this plan: her Harness² loop over `skills/_core-rules.md` with the suite as judge is items 5 and 7's mechanism, built; her browser chain (Chrome → Browserbase → Jina) and task-note restarts extend item 2; DeepSeek V4.1 Flash is the default model; 18 eval scenarios with a strict contract (per-scenario script, noOpPasses labels, category/shape/cases) are the flywheel; her security audit fixed the privacy and authorisation holes with `docs/research/codebase-review-2026-10-21.md` recording what is left open on purpose.

**Open now, after the 22 October research verdict (three-agent audit: thesis, evidence-of-use, competitive):** on-thesis but misordered — the differentiators (identity, pages→ledger, couples) are spec'd, cheap, and unbuilt, while 5 of 7 flagship items were generic-agent infrastructure. The competitive window is ~one product cycle (OpenAI has committed to group chats for 2026; nobody verified does roles/consent/ledger inside an existing chat — Circle's room-scoped memory is a genuine differentiator vs Meta AI's non-E2E memory). Two docs premises drifted: Fo's group chats are now free (invite-only), not paid-tier; and "iMessage first" is the biggest execution risk (no bot API; every verified player went own-app or own-number) — a strategic bet Ellie owns knowingly, with the contract still pinning iMessage for M1.

**The reordered roadmap:**
1. **Oct 23–25 — the differentiators**: page-claim → commitment event (both auditors' #1; 37 use cases; ~80% of plumbing ships), identity merge (§11), co-owners / per-person money (§7.3).
2. **Oct 26 – Nov 2 — coordination set + M1 closeout**: find_time + polls with tally/deadline (calendar fixture added to the eval world), admin-surface audit against the M1 list, runbook assembly, real-group testing *gated on Ellie's Spectrum Business decision*.
3. **Nov 3–9 — live providers as keys arrive**: Google OAuth, Vapi/Twilio, AgentMail, Stripe (adapters written); webhooks → `handleEvent`; photo→dates; over-searching guard if traces show the budget-rule gap again.
4. **Nov 10–16 — handover**: split artifact + settle-up, eval expansion across all six families, reliability matrix, architecture overview, cost notes, walkthrough; then the 14-day defect window.

## The order, mapped to dates

**Now → Nov 2 (Milestone 1).** Items 1–3, which are the M1 reliability story: context economics, resume-in-place, message rules. Alongside: deploy the current build to Company hosting (see [provisioning.md](provisioning.md)), test iMessage end to end in real groups, complete the admin configuration surface, write the runbook.

**Nov 3–9.** Live providers for the six families (Google OAuth, agent mailbox, Vapi/Twilio, Browserbase sessions, Stripe Issuing), items 4–6, reliability-matrix tests, Mandarin-capable calls working end to end.

**Nov 10–14.** Remaining group primitives from the spec's "new" list (polls with tally, split artifact, `find_time`, page-edit events, photo-to-dates), item 7, eval expansion across all six families.

**Nov 15–16.** Handover package: architecture overview, deployment and rollback instructions, backup/restore, operating-cost notes, walkthrough. Then the 14-day defect window.

## Measuring the brain

`bun test` stays the offline gate. `bun run eval` (needs a model key) plays the scenarios against the real model and grades the store: course changes on evidence, approvals respected, nothing claimed without records, silence on timers. Scenario coverage target by Nov 10: every capability family and the messy paths (stalls, declines, substitutions, expired access), not just happy paths.
