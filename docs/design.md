# Circle: design

A personal agent that lives in the group chats people already have. This note records what we took from Wajo's Fo and from Instinct, what we deliberately did differently, and how the pieces fit. It is the spec the code follows; [README.md](../README.md) is the status line.

## 1. The thesis

Fo and Instinct are personal agents: one person, one agent, one chat with it, with channels bolted on. We start from the other end. The unit is the **circle**: a family thread, a friends' group, a neighbourhood chat. One person trains and deploys the agent, and everyone in the chat gets help without setting anything up. Two things have to be meaningfully better than a personal agent dropped into a group:

1. **Group workflows.** Looking after an aging parent is a coordination problem across people: appointments, rides, repairs, bills, and teaching them their phone, with decisions and approvals that belong to specific people and private information that must not leak. The agent's job is to carry the ledger of who does what by when, follow through, and involve the right person at the right moment.
2. **Resourcefulness.** Knowing when to search, when to ask the group, when to call a business, when to ask one person privately, and when (with permission) to ask a local community on Reddit or Rednote. "Find a Mandarin-speaking handyman" is the canonical errand: gather community suggestions, call candidates, compare availability and price, and let the requester choose.

So planning and tool orchestration are central, and so is the room model.

## 2. What we took from Fo

From the bundle reconstruction ([research/wajo-fo-build.md](research/wajo-fo-build.md)), the logged-in product map ([research/wajo-fo.md](research/wajo-fo.md)) and Ellie's logged-in client report ([research/wajo-fo-client-report.md](research/wajo-fo-client-report.md)). The three agree on the object model (agent, session, run, event, attention item, schedule, artifact) and on the run mechanics; the client report adds the live schedule prompt with its authorisation preamble and the escalation service, which shaped sections 7 and 8 below.

- **Separate objects, separate contracts.** Agent, session, run, run event, tool call, attention item, schedule, artifact. The chat window is a view over them. We have the same split (`src/core/types.ts`), plus room, membership, commitment and memory.
- **Append-only events with a cursor.** Fo's watch endpoint resumes from `"<n>-<n>"` cursors; the client reconciles against the authoritative transcript on focus. Ours: `run_events(session_id, seq)`, `GET /api/sessions/:id/watch?after=N`, and the stored transcript per run that a resume reloads.
- **Waiting is an execution state.** `wait_for_user_input` is a running tool; the run pauses with `status: waiting` and resumes when the item is answered. We generalise it: every gate (approval, group question, private question) is an attention item, and the run's `waitingOn` points at it.
- **Approval is a transcript turn, not a widget.** Fo has no approve button; a tool result with `greenlight_verdict: "ask"` draws a held card and the user's next message is the decision. Ours: the gate returns `waitingOn`, the resume pushes `[APPROVED] Ellie answered …`, the model re-issues the tool, and the gate honours the recorded yes. Every decision is in the run record.
- **Labels come from the server per call.** Fo sends `displayLabel` and `meta.{running, done, failed}` on `tool_start`; the client registry is a fallback. Ours: the registry carries labels and the runtime stores them on the tool call record; the footer is built from records (`buildFooter`), never from the model's words, and `integrityNote` corrects a reply that claims an action with no record.
- **The home is one inbox.** `kind ∈ attention | schedule | session`, `status ∈ needs_you | working | scheduled | done | didnt_finish`. Ours: `AttentionService.inbox()` returns the three tabs from one store.
- **Schedules carry their authorisation.** The stored prompt names who may be contacted, how, why, and the premise to re-check. Ours makes that a typed field (`Authorization`) that the gate reads, plus a cheap premise check that pauses the schedule when the premise no longer holds.
- **Steering.** A message during a run is queued and applied on the next model turn, not rejected.
- **Working hours.** Outreach outside 8am to 8pm is held, not sent.
- **Trust is a few numbers and switches.** A threshold under which purchases pass, a pause, per-tool allows, pre-approved communities.

What we left out: Deepgram-in-browser dictation, Live Voice as dictation plus TTS, Stripe-issued cards, the human-assistant fallback, Firebase. Payments are an interface (`request_purchase` gates the amount; no rail yet).

## 3. What we took from Instinct

From the public teardown of its memory:

- **The agent is read-only; a background writer consolidates.** During a run the agent can only write `observation` memories (via `remember`). The owner's rules are the one exception: they take effect at once. A daily pass (`Consolidator`) promotes observations into typed memories, merges duplicates, generalises repeated examples into traits, rewrites corrected facts with the date they changed, and retracts what was explicitly taken back (and anything that looks like a one-time code).
- **Aliases for keyword retrieval.** Recall is FTS5 over text plus aliases, newest first on ties; no vectors. Each memory gets automatic content-word aliases and the model can add more. Instinct's probe showed "pazta" and "Italian noodles" miss; we accept that for now and would add embeddings only when paraphrase recall becomes the bottleneck.
- **A profile is always-on context.** A short derived summary per person and per room goes into every prompt with its derivation date, so the agent can judge its freshness. Instinct's two-day lag is a known cost; ours re-derives on every consolidation and on "Tidy up now".
- **Dates on facts, versions kept.** Memories are superseded, never edited; `supersededBy` links the chain. Old versions stay queryable with `includeInactive`.
- **Explicit forgetting.** "That's not happening" retracts; it is not automatic decay.

What we added that Instinct lacks: **scope and visibility**. Every memory has `scope ∈ agent | person | room`, a `scopeId`, and `visibleToRooms`. The context assembler only includes what the current room may see; keyword recall is filtered the same way. What a group says stays with that group; what a person tells the agent privately never surfaces in a group unless they said it there (test: "what a person tells the agent privately does not surface in the group"). A `lesson` memory type records what was taught and where the person got stuck, so tech help starts from there next time.

## 4. The room model

```
Room(kind: dm | group, channel, outreachHours)
Membership(role: owner | decider | member | guest | cared_for, consentedAt?)
```

- **owner**: trained and deployed the agent; their accounts and money.
- **decider**: may approve care decisions on the owner's behalf (a sibling). Not money.
- **member**: signed up; after a one-time consent, their own accounts are used for their own requests.
- **guest**: never signed up; served through the owner. A guest's request that needs accounts or money becomes a `guest_request` card in the owner's own chat, the group hears "I've asked Ellie to OK that", and the yes finishes the job in the group.
- **cared_for**: the person the circle looks after; patient mode, their preferences consulted first, extra privacy, never discussed in the third person while present.

`RoomService.accountsFor(room, requesterId)` decides whose accounts a request may use and whether approval is needed. `approversFor(room, {money})` decides who gets the card. The agent is one identity across rooms (its training follows it), with a DM room per person created on demand for cards and private questions.

## 5. A run

`Runtime.handleMessage` → is this an answer to something the agent asked this person here or in their DM? resolve and resume. Else is the agent addressed (named, or a DM)? Else ignore. If a run is in flight, queue a steer. Otherwise start a run.

The loop (`Runtime.loop`): assemble the system prompt in a stable order (identity, soul, rules, skills index, room, accounts, profiles, matched skill bodies, dated memories, ledger, plan, situation) → model turn → record each tool call (`tool_start`), run it, record the result with evidence and a fingerprint (`tool_end`) → plan bookkeeping (a stall counts against the active step; two stalls switch to the next approach and the model is told) → if a tool opened a gate, set `waiting`, save the transcript, card the assignee, stop → otherwise loop. A final text turn becomes the reply with the footer from records. Limits: 24 model turns per run.

Resilience we copied: dedup keys on inbound messages and timer runs; a transcript saved on every pause so a resume continues exactly; pending tool records closed as `stopped` when a run ends without re-issuing; `max_tokens` continues; refusals fail the run honestly.

## 6. Planning and resourcefulness

`Planner` keeps one plan per run: a goal and steps, each with an approach and an ordered list of alternatives. The default ladder is **search → ask the group → call → ask a community (needs a yes) → ask a specific person**, cheapest and least intrusive first. Tools declare which approach they embody; a tool result can say it stalled (no results, no answer, no reply yet). After two stalls on a step the next alternative is activated and the model gets a `[planner]` note saying so. When alternatives run out the step fails and the plan moves on. The plan is in the prompt every turn and visible through `GET /api/runs/:id`.

The procedures in `skills/` make the ladder concrete for the errands we care about: `find-a-vendor`, `appointments-and-rides`, `care-circle`, `tech-help`, `outreach-rules`, `group-chat-manners`. The agent sees an index of them every turn and the bodies of the ones that match.

## 7. Trust and gates

`Runtime.gate` is the single policy point:

1. Outreach outside the room's working hours is held (the tool tells the model to schedule it for the morning, naming the person as disclosed outreach).
2. A run fired by a schedule is granted outreach to anyone the schedule disclosed.
3. An approval already recorded on this run for the same ask is granted; a decline is refused and the model is told not to retry.
4. The owner's purchases under `autoApproveUnderUsd` pass; `spendingPaused` blocks everything.
5. Communities in `communityPostingAllowed` pass; tools in `autoAllow` pass for the owner.
6. Otherwise an attention item opens for the right approver (money and accounts: the owner; care decisions: a decider if any), the group gets a one-line notice when the requester is not the approver, and the approver gets a card in their DM.

Every gate decision is in the records: the item, the `gate_opened` and `gate_resolved` events, and the two tool call records (the gated attempt and the approved one).

## 8. Following through

`CommitmentService` is the responsibilities ledger: owner, beneficiary, due time, status, nudges. The first nudge goes a day before due (or in two days with no due date), then daily while open, and after three overdue nudges the item is marked blocked for a person to decide. `Scheduler.tick` turns due nudges into `follow_up` runs whose prompt tells the agent to do it (if it owns it) or check in with the owner in one line and update the ledger. The ledger is in every prompt for the room.

Timers in one tick, all idempotent by dedup key: due schedules (after the premise check), staged outreach once working hours begin, commitment nudges, attention expiry, and a heartbeat per room at most once a day when there is standing work.

## 9. What is deliberately not built yet

- Channel adapters for iMessage, WhatsApp, Telegram and Slack. The room model is channel-agnostic (`Room.channel`, `externalId`, `Delivery`); an adapter maps a thread id to a room and a sender to a person, and subscribes to deliveries.
- Real hands: a search API, a telephony vendor that can hold a conversation in Mandarin, Reddit and Rednote clients, a browser. Each is an interface with a fake.
- Payments. `request_purchase` enforces the budget policy; nothing charges a card.
- Embeddings for memory recall; an eval loop that scores runs against outcomes; a plan the person can edit before a long task runs.

## 10. Evidence this works

`bun test`: 21 tests covering the run loop, footer and integrity note, steering, dedup, guest serving with the owner's card and resume on yes, declines, purchase thresholds, working-hours holds, group questions, the planner's approach switch, parallel tool results, memory privacy, rules versus observations, consolidation (promote, correct, retract, profile), schedules with disclosed outreach, premise failure pausing a schedule, calendar computation in the owner's zone, nudge cadence, heartbeat cadence, attention expiry. `bun run demo` plays the handyman errand end to end offline, including three approvals and the next-day nudge.
