# Circle: design

A personal agent that lives in the group chats people already have. This note records what we took from Wajo's Fo and from Instinct, what we deliberately did differently, and how the pieces fit. It is the spec the code follows; [README.md](../README.md) is the status line.

## 1. The thesis

Fo and Instinct are personal agents: one person, one agent, one chat with it, with channels bolted on. We start from the other end. The unit is the **circle**: a couple, a group of friends, a trip chat, a family thread, a street. One person sets the agent up, invites the others, and everyone in the chat gets help without setting anything up. Two things have to be meaningfully better than a personal agent dropped into a group:

1. **Group workflows.** Looking after an aging parent is a coordination problem across people: appointments, rides, repairs, bills, and teaching them their phone, with decisions and approvals that belong to specific people and private information that must not leak. The agent's job is to carry the ledger of who does what by when, follow through, and involve the right person at the right moment.
2. **Resourcefulness.** Knowing when to search, when to ask the group, when to call a business, when to ask one person privately, and when (with permission) to ask a local community on Reddit or Rednote. "Find a Mandarin-speaking handyman" is the canonical errand: gather community suggestions, call candidates, compare availability and price, and let the requester choose.

So planning and tool orchestration are central, and so is the room model.

## 2. What we took from Fo

From the bundle reconstruction ([research/wajo-fo-build.md](research/wajo-fo-build.md)), the logged-in product map ([research/wajo-fo.md](research/wajo-fo.md)) and Alex's logged-in client report ([research/wajo-fo-client-report.md](research/wajo-fo-client-report.md)). The three agree on the object model (agent, session, run, event, attention item, schedule, artifact) and on the run mechanics; the client report adds the live schedule prompt with its authorisation preamble and the escalation service, which shaped sections 7 and 8 below.

- **Separate objects, separate contracts.** Agent, session, run, run event, tool call, attention item, schedule, artifact. The chat window is a view over them. We have the same split (`src/core/types.ts`), plus room, membership, commitment and memory.
- **Append-only events with a cursor.** Fo's watch endpoint resumes from `"<n>-<n>"` cursors; the client reconciles against the authoritative transcript on focus. Ours: `run_events(session_id, seq)`, `GET /api/sessions/:id/watch?after=N`, and the stored transcript per run that a resume reloads.
- **Waiting is an execution state.** `wait_for_user_input` is a running tool; the run pauses with `status: waiting` and resumes when the item is answered. We generalise it: every gate (approval, group question, private question) is an attention item, and the run's `waitingOn` points at it.
- **Approval is a transcript turn, not a widget.** Fo has no approve button; a tool result with `greenlight_verdict: "ask"` draws a held card and the user's next message is the decision. Ours: the gate returns `waitingOn`, the resume pushes `[APPROVED] Alex answered …`, the model re-issues the tool, and the gate honours the recorded yes. Every decision is in the run record.
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
Membership(role: owner | member | guest, consentedAt?)
```

- **owner**: set the assistant up; their accounts and money.
- **member**: signed up; after a one-time consent, their own accounts are used for their own requests.
- **guest**: never signed up; served through the owner. A guest's request that needs accounts or money becomes a `guest_request` card in the owner's own chat, the group hears "I've asked Alex to OK that", and the yes finishes the job in the group.

People join a room through an invite link the owner mints (`POST /api/rooms/:id/invites`); opening it signs them in as themselves and adds them as a member.

`RoomService.accountsFor(room, requesterId)` decides whose accounts a request may use and whether approval is needed. `approversFor(room)` decides who gets the card: the owner, whose money and accounts are at stake. The agent is one identity across rooms (its training follows it), with a DM room per person created on demand for cards and private questions.

**One general assistant; each chat sets its priorities.** The assistant is a general personal assistant for its owner (`GENERAL_PURPOSE` in `src/agent/spec.ts`; the owner may narrow it, but need not). When a circle adds it to a chat they say what they mostly need from it there (`Room.focus`, set on creation or by `PATCH /api/rooms/:id`). The prompt carries the room's priorities as what comes first and what it may step in on without being named, and says plainly that everything else people ask is still its job; the un-named-request classifier uses the same two facts. There is no training step and no deploy gate: the owner's private chat is an ordinary thread, every request is a run like any other, and what the owner says there (people, routines, stores, standing rules) becomes memory that applies in every chat. The assistant can be in any number of group chats; each room records its own priorities, and the Settings page lists them so the owner can see where it is and adjust what each chat gets.

**One human, one record (identity merge, multiplayer-spec §11).** A stranger who texts from iMessage gets a derived record; when the same number links by code — or its handle is claimed by a signed-in person — `rooms.mergePeople` folds the derived record into the surviving one: memberships move (a guest becomes a member — they signed up), person-scoped memories and profiles follow (including private-profile ids), the dropped record stays queryable for old messages but is marked `mergedInto`, and phone lookups follow the pointer. Nothing merges on a display name alone.

**Co-owners and per-person trust (multiplayer-spec §7.3).** A room owner may promote a member to co-owner; each owner carries their own `TrustPolicy` (`Person.trust`, the agent's being the default), and a purchase is routed by payer: a co-owner's buy follows their own threshold and the card goes to their own DM, not their partner's. Shared payment sources and member-owned cards land with the payments provider.

**Never a fake in front of a person.** Every tool whose provider is a boot-level hand carries `needs`; `main.ts` lists only what it really wired, the run offers only those tools, and the loop refuses any tool whose provider is missing even when the model names it unoffered. Without a phone vendor `place_call` answers "not available on this server" instead of the test fake's "they answered".

**Low tech comfort.** When the requester is marked as not comfortable with technology the prompt switches to one step at a time, no jargon, their words for things, "ask what they see before saying what to tap", and anything needing a password, a code or money goes to a named person.

## 5. A run

`Runtime.handleMessage` → is this an answer to something the agent asked this person here or in their DM? resolve and resume. Else is the agent addressed (named, or a DM), or, in a group, is the message a request within its purpose (one yes/no from the small model, skipped for messages under 20 characters)? Else ignore. If a run is in flight, the requester's own message queues as a steer. From anyone else, a cheap small-model check compares the message against the live run's errand: a contribution to it joins the run as an attributed steer (the record carries their name; the prompt says to confirm a change or cancel with the requester first), while a separate ask is queued as a run of its own — never folded into someone else's run — starting when the live run ends or pauses, with rapid messages from one person coalesced into one run. Otherwise start a run.

The loop (`Runtime.loop`): assemble the system prompt in a stable order (identity, soul, rules, skills index, room, accounts, profiles, matched skill bodies, dated memories, ledger, plan, situation) → model turn → record each tool call (`tool_start`), run it, record the result with evidence and a fingerprint (`tool_end`) → plan bookkeeping (a stall counts against the active step; two stalls switch to the next approach and the model is told) → if a tool opened a gate, set `waiting`, save the transcript, card the assignee, stop → otherwise loop. A final text turn becomes the reply with the footer from records. Limits: 24 model turns per run.

Resilience we copied: dedup keys on inbound messages and timer runs (recorded on arrival, so a redelivered answer never starts a second run); a transcript saved on every pause so a resume continues exactly, deleted when the run ends; pending tool records closed as `stopped` when a run ends without re-issuing; `max_tokens` continues; refusals fail the run honestly.

Lifecycle guarantees added after review: `stop` sets a cancel flag the loop checks between turns and tools, and a late reply cannot overwrite "stopped"; a message never steers into a run this process is not executing; queued messages are drained before every exit, and only message and task runs receive them; a dismissed or expired card ends the run that waited on it; a card with no run behind it (a stuck responsibility) starts a follow-up run carrying the answer; the scheduler isolates each item, never stacks a watch on a check still in flight, and its premise check fails open. A stop also posts a notice written by code from the run's tool records: the side-effect actions that had completed (not undone) or that nothing outside had happened, so a cancelled errand never leaves people guessing. An owner's off switch (`agent.paused`) stops the agent's live runs, records any new run as stopped without a model call, and holds its schedules, nudges and heartbeats due until it is back on. Operations (health, error log, backups) are in [runbook.md](runbook.md).

**Durable execution.** The transcript is saved after every model turn and every tool batch. At boot, a run left "running" by a crash resumes from it instead of failing: interrupted tool calls are closed as `stopped`, the model is told their effect is unknown and to check before repeating, and the loop continues where it stopped. A side-effect tool whose exact tool and input already completed in the same run returns the first result instead of acting again, so a resumed run cannot double-dial or double-send (`reconcile` and `bootResume` in `src/runtime/runtime.ts`, the guard in the tool loop).

## 6. Planning and resourcefulness

`Planner` keeps one plan per run: a goal and steps, each with an approach and an ordered list of alternatives. The default ladder is **search → ask the group → call → ask a community (needs a yes) → ask a specific person**, cheapest and least intrusive first. Tools declare which approach they embody; a tool result can say it stalled (no results, no answer, no reply yet). After two stalls on a step the next alternative is activated and the model gets a `[planner]` note saying so. When alternatives run out the step fails and the plan moves on. The plan is in the prompt every turn and visible through `GET /api/runs/:id`.

The procedures in `skills/` make the ladder concrete for the errands we care about: `find-a-vendor`, `appointments-and-rides`, `care-circle`, `tech-help`, `outreach-rules`, `group-chat-manners`. The agent sees an index of them every turn and the bodies of the ones that match.

## 7. Trust and gates

`Runtime.gate` is the single policy point:

1. Outreach outside the room's working hours is held (the tool tells the model to schedule it for the morning, naming the person as disclosed outreach).
2. A run fired by a schedule is granted outreach to anyone the schedule disclosed. Disclosure is an approval in advance, so a schedule or watch created by anyone but the owner that names someone to contact is gated first, entries are validated, and the owner is told what was pre-approved.
3. An approval is a record (`Approval`): the person's answer, read with negation first ("no, I don't approve" is a no), bound to the run that asked and to a gate key (the tool plus the payload that matters: number, text, amount, merchant). A yes is consumed by the first action it lets through; a different text or number asks again; a no sticks for the run. Open cards are matched by gate key, never by title.
4. The owner's purchases under `autoApproveUnderUsd` pass; `spendingPaused` blocks everything.
5. Communities in `communityPostingAllowed` pass; tools in `autoAllow` pass for the owner.
6. Otherwise an attention item opens for the owner, the group gets a one-line notice when the requester is not the owner, and the owner gets a card in their DM.

Every gate decision is in the records: the item, the `gate_opened` and `gate_resolved` events, and the two tool call records (the gated attempt and the approved one).

## 8. Following through

`CommitmentService` is the responsibilities ledger: owner, beneficiary, due time, status, nudges. The first nudge goes a day before due (or in two days with no due date), then daily while open, and after three overdue nudges the item is marked blocked. A blocked item is escalated once: a `decision` card ("X is stuck": reassign, drop, keep nudging) opens for the owner, and the nudging stops. `Scheduler.tick` turns due nudges into `follow_up` runs whose prompt tells the agent to do it (if it owns it) or check in with the owner in one line and update the ledger. The ledger is in every prompt for the room.

Timers in one tick, all idempotent by dedup key: due schedules (after the premise check), commitment nudges, attention expiry, and a heartbeat per room at most once a day when there is standing work.

## 8b. What we took from Instinct's harness

Supermemory's Instinct diagram (main harness → task agent → sandbox → reply / file / stay quiet, with saved task specs, a daily memory worker and compaction) gave us six mechanisms. All live in the run loop and the scheduler:

- **Silence is an outcome.** `stay_quiet(reason)` ends a run with `run.quiet` set and nothing delivered. Heartbeats, watches, follow-ups and app events are told silence is the default. A quiet run's trigger message is `folded` so it never returns in the next run's context. The old "(nothing to report)" reply on a timer is swallowed as a backstop.
- **Task agents.** `delegate_task` creates a `Task` with its own session; the delegating run replies to the room now and the task run starts once that reply is out (`Runtime.launchPending`, awaited by `settle()` in tests). The room session stays free, so new messages get answers while the task works, and `steer_task` passes a note into the running task.
- **Delivery state.** A task records every line it told the room (`task.delivered`). A resume after a gate carries that list into the transcript ("already told the room, do not repeat") and the final reply is logged once. The prompt lists the room's delegated tasks with progress and what was last said.
- **Alert rules.** `watch_for(condition, action, everyHours)` creates a schedule with a `watch` and an interval calendar. Each firing runs the check prompt; a quiet result keeps watching, a reply pauses the watch; `until` bounds it.
- **App events as triggers.** `Runtime.handleEvent` (and `POST /api/events`) enters like a message with trigger `event`: act if it concerns a responsibility, task or watch, else stay quiet. Gmail and Calendar adapters that call it are not written yet; the door is.
- **Signing in inside the chat.** When a site needs a member's login, `connect_account` opens a live browser (Browserbase session on a persistent context) and posts a card into the chat, visible only to the person whose account it is, with the live view embedded and "Done, I'm signed in" / "Cancel". Done ends the session, which writes the cookies into the context, and the context id goes into the vault under `browser:<site>` for that person; `browse_page` with `account: <site>` then browses as them inside `vault.use`. The model learns only that the site is connected; it never sees a password or the context id.
- **Credential vault.** `Vault` keeps members' own credentials encrypted with `MASTER_KEY` (AES-256-GCM, ciphertext in the `credentials` table). The prompt sees service names only ("Connected accounts for Alex: gmail"); a hand gets the secret inside `vault.use` and nothing else does. Which person's vault applies follows `accountsFor`, so a guest's request lists the owner's services.
- **Page edits are events.** A tick or claim on a published page leaves a snapshot in the store; the scheduler fires at most one `artifact_edit` run per page per burst, carrying the diff since the assistant last looked. The agent reads the page (`read_page`, which names the chat's people and their ids) and tracks claims as responsibilities — the bridge from the shared page to the ledger, per multiplayer-spec §10.3: "Sam claimed: bring the stove" is a commitment, while ticks need nothing.
- **Compaction.** When a session holds more than 30 messages past the last summary, the older ones are folded into `session.summary` by the small model (the newest 12 stay verbatim) and the summary is also written as a room observation for the nightly pass. The prompt carries the summary in place of the folded messages.

Not taken: files as an outcome (channels here are chat), and a leased sandbox per task (hands run in-process; the vault is the first step toward one).

## 9. Services wired, and what is deliberately not built yet

Wired through `.env` (see README): the model through OpenRouter (DeepSeek V4.1 Flash by default, `deepseek/deepseek-v4.1-flash-1017`; the OpenRouter door speaks the Anthropic Messages shape, so the same adapter serves Claude directly), iMessage through Photon Spectrum (`src/channels/imessage.ts`: one Spectrum space is one room, one sender handle is one person, the owner is recognised by phone number, deliveries go back through the space; on the free plan's shared pool there is no line of its own, so a person registers their handle and is texted first, one-to-one only), the browser hand through Browserbase (`src/tools/browser.ts`: a fresh cloud session per page read, released after), and Clerk sign-in on the web channel (`src/channels/auth.ts`: the bearer token maps to a person on first sight and the caller may only act as that person).

Not built yet:

- Channel adapters for WhatsApp, Telegram and Slack (Spectrum has providers for all three; the iMessage adapter is the template).
- Real hands for telephony (a voice vendor that can hold a call in Mandarin) and for Reddit and Rednote. Each is an interface with a fake. Search and page reading are real: `src/tools/reach.ts` carries two keyless channels borrowed from Agent Reach (Exa's public MCP endpoint for search, which returns local businesses with ratings and phone numbers, and Jina Reader for pages), with Brave and Browserbase behind keys. `skills/internet-reach.md` tells the agent how to use them and what it cannot reach.
- Payments. `request_purchase` enforces the budget policy; nothing charges a card.
- Embeddings for memory recall; a plan the person can edit before a long task runs.

Proactive suggestions (`src/inbox/suggestions.ts`, `GET /api/suggestions`) are mined from the ledger and the schedules first (overdue or blocked items, items due within two days, schedules firing today) and topped up with at most three ideas from the small model given the room's recent messages, ledger and notes; the home page and the empty thread show them as "want me to…" cards that prefill the composer.

## 9b. The catalogue

Fo's 80 tools, by family, live in `src/tools/catalog/` behind the same `ToolDef` contract as the core set (`src/tools/kit.ts`). Each family talks to a provider in `src/tools/hands.ts` with a fake, and a real adapter in `src/tools/providers/` when its key is set: Google (OAuth app, per-person refresh token in the vault, REST), the assistant's mailbox (AgentMail or Resend), Slack (per-person token), ElevenLabs, OpenRouter image models, Stripe Issuing, Vapi and Twilio. MCP servers and OpenAPI connectors are per person too (`mcp:<name>`, `api:<name>` in the vault). Artifacts (documents, dashboards, images, audio, files) are rows in `artifacts` served at `/d/:id`. The rule for approvals does not change: a write on the requester's own account runs; on anyone else's it asks them; anything that reaches a third party or spends money asks the owner.

**Context economics.** A tool whose family needs a boot-level provider (`needs` on the ToolDef: Google needs the OAuth app, shopping needs Stripe, the browser actor needs Browserbase, speech needs ElevenLabs) is only offered on runs when that provider is wired (`toolsForRun` in `src/tools/registry.ts`; `main.ts` reports what it wired). The list is chosen once per run and never changes mid-run, so the prefix caches; `search_tools` marks what is unavailable and why. The system prompt travels as two blocks — stable (identity, soul, owner instructions, how you work, room priorities, standing rules, skills index) is cached; volatile (who is being served, the room, profiles, matched skills, memories, ledger, plan, situation) follows it (`src/agent/prompt.ts`, `src/model/anthropic.ts`). A cache miss in the stable block is a bug.

## 10. Evidence this works

`bun test`: offline tests covering the run loop, footer and integrity note, steering, dedup, guest serving with the owner's card and resume on yes, declines, purchase thresholds, working-hours holds, group questions, the planner's approach switch, parallel tool results, memory privacy, rules versus observations, consolidation (promote, correct, retract, profile), schedules with disclosed outreach, premise failure pausing a schedule, calendar computation in the owner's zone, nudge cadence, heartbeat cadence, attention expiry, the search and reach adapters, and the eval harness grading the store (order judged by event `seq`, never by clock time). `bun run eval` plays the same scenarios against a real model. CI (`.github/workflows/ci.yml`) runs typecheck, Biome lint and the tests on every push and pull request.

The group model (roles, joining, gates across people, memory visibility, coordination primitives) is specified in more depth in [multiplayer-spec.md](multiplayer-spec.md).
