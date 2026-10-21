# Codebase review, 2026-10-21

> **Applied the same day** (commits 6df8cb5 … 7a3da3b on `claude/confident-hopper-02ytur`): C1, C2, C3, H1, H2, H3 (via H5's projection), H4 (not a real race: `startRun` registers the run synchronously after the classifier, so a second message always sees it; the existing test covers it), H5, H6, H7, H8, M1, M3, M4, M5, M7, M8, M9, M10, M11 (Clerk session cookie on GET), M13, L1, L2, L4, L5, L13, L15, L16; T-C1 (tool removed), T-C2 (stdio removed, URLs checked), T-C3, T-C4, T-C5, T-H1, T-H2, T-H3, T-H4 (`publicUrl()` at the connections route and in `browser_use`; no DNS resolution yet), T-H5, T-H6, T-H7 (a generic read gate in the runtime), T-M1, T-M4, T-M9; the four twins; the catalogue re-exports and the dead-code table; W-M1, W-M2, W-M3 (global handler), W-M5, W-L8, W-L9. Each fix carries a test.
>
> **Applied later the same day:** M2 (a disclosure binds to a contact), M6 (the owner's Memory view keeps other members' private notes out), M12 and W-M4 (patch-by-id thread, stale-room guards), W-M6 (labels, dialog, tab and toggle states), T-M3, T-M5, T-M6, the limit clamps, refactor 12 (`askFirst()`), refactor 14 (`gtool()` and the google/ split).
>
> **Left open, on purpose:** W-L1–L7, T-M2, T-M7, T-M8, T-M10, T-M11, the low catalogue items, refactors 9 and 10, `readTranscript()`, and L17 (the suite takes ~1.4s; CLAUDE.md still says under a second).


Read-only review of `src/` and `web/app.js` against `CLAUDE.md` and `docs/design.md`, at commit `dc5c3e6`. Every finding below was verified by reading the code path named; the four runtime claims marked **(proved)** were also reproduced with an offline scripted-model test (scratch file, not committed; the scenarios are written out under each finding so they can be turned into regression tests).

Baseline at the time of review: `bun test` 132 pass in 1.4s (CLAUDE.md asks for under a second), `bun run typecheck` clean, `bun run lint` clean.

Line numbers refer to the working tree at `dc5c3e6`. `web/app.js` was being edited while the review ran (1663 → 1696 lines); its line numbers are for the newer file.

## Summary

The architecture does what the spec says: runs are append-only event streams, every tool call is a record, footers come from records, gates are one function, memory reads go through `MemoryService`, secrets live in the vault. The store is clean. The failures are at the seams:

1. **A person's private notes reach every group through the "public" person profile** (`consolidate.ts:225`). The profile filter treats "visible to some room" as "safe anywhere", and a DM is a room. The spec's headline privacy promise ("what a person tells the agent privately never surfaces in a group") holds for `visibleIn` and fails for profiles.
2. **Any message from someone who holds an open card is taken as their answer** (`runtime.ts:379-380`). "@pip also find a plumber" from the owner while a purchase card is open declines the purchase and the plumber request is dropped. This is the most user-visible bug in the repo.
3. **The iMessage channel processes inbound messages one at a time, awaiting the whole run** (`imessage.ts:140`). One long errand blocks every other iMessage chat, and steering (a spec feature) can never happen from iMessage.
4. **The integrity check uses a hard-coded five-tool list instead of `ToolDef.sideEffect`** (`runtime.ts:1116`). Real emails get a "(Correction: no outside action was actually taken)" and "I've ordered it" after only a budget approval passes.
5. **The web API hands every member the full `Person` record of every co-member** (`/api/state`, `/api/people`): phone, email, saved delivery addresses, `sendAsMe`. A member who joined via an invite link gets the owner's home address.
6. **The catalogue has three ways off the box and two ungated account actions.** `run_javascript` (`operator.ts:196-207`) removes five globals but not `import()` or `process`, and runs in the server's cwd next to `.env`; the MCP stdio `command` any signed-in person can register (`web.ts:606-612` → `mcp.ts:69`) is `Bun.spawn` with the server's environment; `connector_call` (`mcp.ts:150`) sends the member's bearer token to any absolute URL the model names, ungated for GET. `browser_use` (`operator.ts:374-431`) clicks and fills inside a member's signed-in browser context with no `ctx.gate`, so a guest can act on the owner's accounts; `checkout_cart` (`shopping.ts:132-151`) mints a live single-use card, waits half a second, screenshots, wipes the cart and reports a verified "Checkout at …" with nothing bought.

Plus a run-concurrency race in group rooms, several web routes that let any member mutate or read more than their role should, a working-hours "staging" subsystem nobody calls, a dozen twin tools, and a handful of dead exports.

What is good and should not be touched is listed at the end.

---

## Critical

### C1. Private DM notes leak into group prompts through the public person profile (proved)

- **Where:** `src/memory/consolidate.ts:218-231` (`deriveProfile`), with `src/tools/registry.ts:522` (`remember` writes `visibleToRooms: [ctx.room.id]` in a DM) and `src/memory/consolidate.ts:106` (`mineRoom` does the same for every DM). Consumer: `src/runtime/runtime.ts:689-698` puts the owner's and the requester's public profile into the prompt of every run in every room.
- **What is wrong:** `deriveProfile` builds the "public" person profile from `all.filter((m) => m.visibleToRooms.length > 0)` on the theory that a memory shared with a room is safe wherever the person is a member. But both writers tag DM-origin memories with the DM room's id, so the list is never empty, and the filter passes everything. The private profile (`#private`) is therefore identical to the public one.
- **Failure scenario:** Alex tells the agent in their private chat "I'm in debt and hiding it from Sam". The nightly pass promotes it (verbatim, via the deterministic fallback) and writes it into `profile(person, alex)`. Sam asks the group "@pip hi"; the system prompt now contains "About Alex: … in debt and hiding it from Sam". The existing test (`memory-and-timers.test.ts:77-79`) only covers memories written with `visibleToRooms: []`, which no production path produces.
- **Reproduction (offline):** `remember` from `ownerDm` with any text → `consolidator.runFor` with a completer that echoes memories → `getProfile(agent, "person", "alex").text` contains the note → a group message from Sam → `model.calls.at(-1).system` contains the note.
- **Fix (minimal):** classify by room kind, not by list length. In `deriveProfile`:
  ```ts
  const shared = (m: Memory) => m.visibleToRooms.some((rid) => this.store.getRoom(rid)?.kind === "group");
  await this.writeProfile(agent, scope, scopeId, all.filter(shared));
  ```
  and add the regression test above. Consider also making `remember`'s `private` flag mean something (it is a no-op today, see D7).

### C2. Any message from a card's assignee resolves the card, whether or not it is an answer (proved)

- **Where:** `src/runtime/runtime.ts:378-393` (`pendingItemFor`), called at `:160-164`.
- **What is wrong:** For items assigned to the sender (`mine`), the function returns the newest one unconditionally; the `answers(text, options)` guard at `:392` applies only to the owner-answering-for-others path. In a DM room the filter is `a.roomId === room.id || room.kind === "dm"`, so an owner's DM swallows cards opened in any group. `handleMessage` then calls `attention.resolve(pending.id, input.text)` and returns the resumed run (`:163`), so the new message never becomes a request.
- **Failure scenario (proved both ways):** Alex asks for a kettle; a purchase card opens for Alex. Alex writes "@pip also find me a plumber for Saturday" in the group, or "remind me to call mum tomorrow" in their DM. Either way the card is resolved with that text, `isYes` says no, an approval `decision: "no"` is recorded (sticks for the run), the kettle run resumes with `[DECLINED]`, and the plumber/reminder request starts no run. The owner is left with a declined purchase and a lost request and no idea why.
- **Fix (minimal):** apply the same `answers()` gate to `mine`, and treat a message that names the agent as a new request:
  ```ts
  const mine = this.d.attention.openFor(personId).filter((a) => a.roomId === room.id || room.kind === "dm");
  const hit = mine.length ? mine[mine.length - 1] : undefined;
  if (hit && answers(text, hit.options) && !this.addressed(room, agent, text)) return hit;
  ```
  For `information`/`action` kinds where free text is the answer, keep the current behaviour but only when the text does not name the agent and the item was opened in this room. Remove the `void agent;` at `:391` once `agent` is used.

### C3. iMessage inbound is serial: one run blocks every chat, and steering can never happen from iMessage

- **Where:** `src/channels/imessage.ts:106-140`: `for await (const [space, message] of im.messages) { … await spectrum.responding(space, () => app.runtime.handleMessage(...)) }`. `handleMessage` → `startRun` → `await this.loop(...)` returns only when the run ends or pauses (`runtime.ts:468`).
- **What is wrong:** a run can take minutes (24 model turns, calls through `hands.phone.call` that "return when the call ends"). While it runs, no other iMessage message on this line is read: other rooms wait, and a second message from the same person cannot reach `handleMessage` to be queued as a `steer_queued` event, so the steering path the spec describes (§2 "Steering") is unreachable from the one real channel. The `HandleRateLimit` timestamps are taken only when the message is finally read, so the limiter is also wrong under backlog.
- **Fix:** do not await the run inside the stream loop. Keep the typing indicator for the first delivery, not for the run:
  ```ts
  void app.runtime.handleMessage({ ... }).catch((e) => console.error(`${channel} run failed`, e));
  ```
  and move `spectrum.responding` (if it is only a typing indicator) to wrap a promise that resolves on the first `deliver` for that room, or drop it. Add a test with a scripted model that blocks the first run and checks a second room's message gets a run before the first finishes.

---

## High

### H1. `integrityNote` uses a hard-coded tool list instead of `ToolDef.sideEffect` (proved)

- **Where:** `src/runtime/runtime.ts:1115-1123`; `ToolDef.sideEffect` at `src/tools/kit.ts:109` is never read by the runtime.
- **What is wrong:** `SIDE_EFFECT = {place_call, send_sms, post_community, schedule_action, request_purchase}`. The catalogue adds `send_agent_email`, `send_email_as_user`, `create_event`, `checkout_cart`, `share`, `mcp_call`, `connector_call`, `place_vendor_call` and more, all `sideEffect: true`, none in the set. Conversely `request_purchase` is in the set although it only clears a budget.
- **Failure scenarios:** (a) the agent sends a real email via `send_agent_email` (evidence `fake-email:mail_1`) and replies "I've emailed the clinic"; the reply gets "(Correction: no outside action was actually taken in this step.)" appended; the group reads that the agent lied when it did not. (b) the agent calls `request_purchase` (evidence `purchase-approved:40`), never calls `checkout_cart`, and replies "I've ordered the kettle"; no correction. Both reproduced.
- **Fix:** `const acted = calls.some((c) => c.status === "done" && c.evidence && TOOL_INDEX.get(c.name)?.sideEffect && c.name !== "request_purchase")`, and set `sideEffect: false` on `request_purchase` (it is a policy check, not an effect). Extend the CLAIM regex with `shared|added to the calendar|put on the calendar|placed`.

### H2. Full `Person` records (addresses, phone, email, `sendAsMe`) go to every co-member and guest

- **Where:** `src/channels/web.ts:246-248` (`GET /api/state` → `people` and `rooms[].members[].person`), `:253` (`GET /api/people`), `src/store/queries.ts:20-24` (`peopleVisibleTo` returns whole records). `Person` carries `addresses: Address[]`, `phoneE164`, `email`, `sendAsMe`, `techComfort` (`src/core/types.ts:10-24`).
- **Failure scenario:** the owner saves a delivery address for checkout. Anyone who opens an invite link (`POST /api/invites/:token/accept`, member role) calls `/api/state` and reads the owner's street address, phone and email, and the same for every other member. A guest promoted to member via `POST /rooms/:id/members` gets the same.
- **Fix:** project non-self people to `{id, displayName, pronouns, timezone, techComfort}` in `peopleVisibleTo`/`/api/state`; return the full record only for `me`. `find_person` (`registry.ts:177`) already does this distinction for the model; the API should match.

### H3. `find_person` reveals which other circles a person is in

- **Where:** `src/tools/registry.ts:167-183`: iterates every room of the agent and pushes `room.name` for every group the match belongs to, regardless of whether the requester is in that room. The description promises "which chats you share".
- **Failure scenario:** Riley (guest in "Tahoe trip") asks "@pip who is Sam?"; the result lists "Family care", "Street WhatsApp" and any other group Sam is in. Combined with `GET /api/runs/:id` (H5) the tool result is readable by every room member.
- **Fix:** `if (room.kind === "group" && (!ctx.requesterId || memberIds.includes(ctx.requesterId))) hit.rooms.push(room.name)` using the member list already fetched; or only list rooms that contain `ctx.requesterId`.

### H4. Two runs can start in one session when the group classifier is in flight

- **Where:** `src/runtime/runtime.ts:167` (`await this.impliedRequest(...)`, a model call) happens before the active-run check at `:171`. `startRun` registers the run synchronously only after that await.
- **Failure scenario:** two unaddressed messages (≥20 chars) arrive within the classifier's latency (~1s on a busy group). Both see no active run, both start a run in the same session, both reply; `activeRunForSession` returns only the latest so a third message steers one and not the other; both transcripts miss each other's message. Also each costs a model call per message, bounded only by `IMPLIED_PER_MINUTE`.
- **Fix:** re-check `store.activeRunForSession(session.id)` after the classifier returns (move the block at `:171-178` below the `impliedRequest` await, or wrap `handleMessage` per session in a small promise chain so one session is handled one message at a time).

### H5. `GET /api/runs/:id` returns raw tool inputs and results to any room member

- **Where:** `src/channels/web.ts:890-900`, access `roomMember`. `toolCallsForRun` records carry `input` and `result` verbatim (`runtime.ts:837,860`).
- **Failure scenario:** a guest in the group opens the "Why?" drawer for any run and reads the full `browse_page` text of the owner's signed-in Uber Eats page, the `find_person` result with phone numbers (H3), the `send_email_as_user` body, the `email_load_unprocessed` inbox dump. None of these were meant for the room; the chat only ever showed the reply and the footer.
- **Fix:** return `{name, labelRunning, labelDone, status, verified: !!evidence, startedAt, endedAt}` plus a 120-char input summary; keep full records for the agent owner (`agentOwner` access, or a `?full=1` the owner may use). The UI (`app.js`) only renders labels.

### H6. Any room member can stop any run and rewrite any commitment

- **Where:** `src/channels/web.ts:901-911` (`POST /api/runs/:id/stop`, `roomMember`), `:1011-1025` (`POST /api/commitments/:id`, `roomMember`, with unvalidated `ownerId`).
- **Failure scenario:** a guest stops the owner's delegated task mid-call (the task is marked `stopped`, the call record `stopped`, the transcript deleted); or marks the owner's "pay Jo's rent" responsibility `done` so the nudges stop and the ledger lies. The design gives approvals and money to the owner; stopping and closing their work should follow the same rule, or at least be limited to the requester of the run / owner of the commitment.
- **Fix:** `stop`: allow `run.requesterId === me` or room owner. `commitments`: allow `c.ownerId === me` or room owner; validate `ownerId` is a member of the room.

### H7. `POST /api/files` lets any signed-in person write a 10 MB artifact into any room

- **Where:** `src/channels/web.ts:727-759`, access `signedIn`; `roomId` comes from the form and is never checked against `me`'s memberships; `agentId` falls back to the first agent.
- **Failure scenario:** a signed-in stranger (anyone with a Clerk account on a public deployment) uploads files that appear in `GET /api/artifacts` for that room's members, and fills SQLite at 10 MB base64 per call.
- **Fix:** require `roomId`, check `isMember(roomId, me)`, derive `agentId` from the room.

### H8. The working-hours "staging" subsystem is dead code that the spec and README describe as working

- **Where:** `src/scheduler/scheduler.ts:89-104` (sweep), `:261-266` (`stage`), `src/store/repos.ts:368-385` (`putStaged`, `dueStaged`, `listStaged`), `src/core/types.ts:443-454` (`StagedItem`), the `staged` table. `grep '\.stage('` across `src/` and `test/` finds no caller; the gate returns `held` and tells the model to `schedule_action` instead (`gate.ts:34`).
- **Why it matters:** `docs/design.md` §8 lists "staged outreach once working hours begin" as a timer, and `README.md` must "stay honest". The sweep runs every tick over an always-empty table, and the model is told two different stories (held → schedule it yourself). Either wire it (the gate stages the payload and returns `held`) or delete it and fix the docs.
- **Fix:** delete `StagedItem`, `stage`, the three store methods, the table creation and the sweep (≈45 lines), and reword design §8 and the README line.

---

## Medium

### M1. Compaction hides the kept recent messages when timestamps collide

- **Where:** `src/runtime/runtime.ts:509` sets `summaryThroughAt = old.at(-1)!.at`; `history()` at `:585` and `compact()` at `:483` keep `m.at > summaryThroughAt`.
- **Failure:** two messages written in the same millisecond (the system trigger message and the reply, or two web posts under load) straddle the cut: the first "kept" message has the same `at` as the last folded one and is dropped from the model's history. With a frozen test clock every message shares `at`, so the existing compaction test (`harness.test.ts:205`) passes only because the newest message arrives after the summary is written. Fix: use `>=` with an exclusive id cut (store `summaryThroughId`) or compare on `(at, rowid)`.

### M2. Scheduled-outreach disclosure matches on a name only

- **Where:** `src/runtime/gate.ts:40-44` compares `disclosed.who` to `g.outreach.who` case-insensitively; `place_call`'s gate key is the number (`registry.ts:364`), but the disclosure check ignores it.
- **Failure:** a schedule discloses "Dr. Lee's office by phone". A later run (or an injected page the model read) names any number as "Dr. Lee's office" and the call goes out without a yes. Fix: when the disclosure was made, store the number/address alongside `who` where known (`place_call` and `send_sms` inputs have it) and require a match on it when present.

### M3. `trust.autoAllow` and `communityPostingAllowed` are only partly honoured

- `gate.ts:69-72` only consults `autoAllow` for `place_call`/`send_sms`; `web.ts:74` restricts the setting to those two. Fine today, but `TrustPolicy.autoAllow` is documented as "tool names that may run without asking" (`types.ts:101`) and the catalogue's side-effect tools never look at it. Either rename the setting (`autoAllowOutreach`) or check `agent.trust.autoAllow.includes(toolName)` generically in `decideGate` for the owner.
- `gate.ts:66` matches `communityPostingAllowed` case-sensitively while `:42` lowercases. Normalise both.

### M4. Scheduler and inbound-email ticks are not re-entrancy guarded and run agent runs inline

- **Where:** `src/main.ts:167-190` fires `tick()` every 30s and awaits nothing; `scheduler.ts:82,96,108,125` await full agent runs inside the tick.
- **Failure:** a schedule whose run takes two minutes means the next four ticks overlap it. Dedup keys make schedule, heartbeat and nudge firings idempotent (`fire` bumps `numRuns` before awaiting; `takeDueNudges` advances the clock first), so no double firing, but `expireDue` and heartbeats are delayed by the inline run and `console.error` lines interleave. Fix: `let ticking = false; if (ticking) return;` around the interval body, and start runs with `void` inside the tick (the run already records everything) so one slow firing does not hold the sweep.

### M5. Card deliveries ignore `visibleTo`; private cards reach every live listener

- **Where:** `runtime.ts:963` delivers a `connect_account` card to the room with no `visibleTo` while storing the message with `visibleTo: [assignee]` (`:959`); no `deliver()` call anywhere sets `visibleTo`, so the filter at `web.ts:181` and the `Delivery.visibleTo` field are dead. iMessage (`imessage.ts:90-102`) ignores `visibleTo` entirely.
- **Failure:** in a group, "Sign in to a site: Sign in to ubereats.com … order Jo's groceries" is pushed to every member's live stream (web) and, when the room is an iMessage group, into the group chat itself, although the stored message is marked for the assignee only. Fix: pass `visibleTo: [paused.assigneeId]` at `:963`; in iMessage, skip deliveries with a `visibleTo` that excludes the group (they already go to the DM at `:966-979`).

### M6. `GET /api/memory` shows the owner every member's private notes

- **Where:** `src/channels/web.ts:1046-1060` returns `listMemories(agentId)` unfiltered; the comment acknowledges it. `GET /api/profiles` (`:1028-1045`) likewise lists every person's public profile.
- **Why it matters:** the spec promises members that "what a person tells the agent privately never surfaces". It does surface, to the owner, in the Memory tab. This is a product decision, but it should be made deliberately: either exclude `scope: person` memories whose `visibleToRooms` contain only DM rooms of people other than the owner, or state in the README/consent copy that the owner can read all notes.

### M7. The first Clerk sign-in on a fresh deployment claims the owner seat

- **Where:** `src/channels/auth.ts:90-101` with `main.ts:126` (`claim-owner`).
- **Failure:** a deployment goes live before the owner signs in; whoever signs in first (anyone with a Clerk account, since sign-up is open) becomes the owner of the seeded agent and its vault. Fix: gate the claim on `OWNER_EMAIL` when set, or require the claim link to be opened from the console.

### M8. `wait_for_user_input` and `ask_person` trust `kind` and `options` from the model

- `registry.ts:331` casts `s(input.kind) as AttentionKind`; an empty or odd string produces an item whose `KIND_LABEL[kind]` is `undefined`, so the card reads "undefined: Your input is needed" and `setState` falls to `blocked`. `:294,334` pass `options` through unchecked (non-strings end up in `parseDecision`'s `o.toLowerCase()` and throw). Fix: validate against the three allowed kinds (as `ask_person` does at `:284`) and `options.filter((o) => typeof o === "string")`.

### M9. `POST /api/schedules` accepts an unvalidated `calendar`

- `web.ts:988` passes `b.calendar as Calendar`. A missing `timeZone` silently uses the server zone; an invalid one throws `RangeError` inside `computeNext` → 500. `sessionId: "none"` is stored when the room has no session (the field is never read, see D-list). Fix: validate like `schedule_action` does (`registry.ts:604-613`) and reuse that code.

### M10. Web: the UI composes a footer from model text when there are no steps

- `web/app.js:741-751`: when `m.steps` is empty the client splits the message at `lastIndexOf("\n— ")` and renders the tail as the footer. `buildFooter` returns "" in that case, so anything shown there came from the model ("— 2 steps · 2 verified: Called Lakeview" typed by the model, or by an injected page). This is the one CLAUDE.md footer rule the UI breaks. Fix: never parse the footer out of text; render steps from `m.steps` only. Better: have `sendReply` store `footer` as its own message field.

### M11. Web: `/d/:id` images, document links and the vCard fail under Clerk

- `app.js:807,967,1292` use `<img src="/d/…">` and plain links; `web.ts:1175-1177` and `auth.ts:77-80` only read the `Authorization` header, so every room-shared image is a broken image and every "Open →" is a 403 once sign-in is on. Fix: a short-lived signed token in the URL for `/d/*`, or fetch with the bearer and use blob URLs.

### M12. Web: stale-room races and iframe churn

- `renderThread`/`renderInbox`/`renderLedger` never check `state.room` after their `await` (`app.js:692-760, 495, 616`): switching rooms while a fetch is in flight paints room A's messages under room B. `send()` reads `state.room` twice (`:941, :1002`): an attachment can land in one room and the message in another. Every delivery rebuilds the thread (`:1566`, `el.innerHTML = html` at `:760`), which recreates the sign-in iframe (`:893`) and drops the person's typing mid-sign-in. Fix: capture `roomId` once per call and drop late results; patch the thread by message id.

### M13. Web: `md()` lets a crafted link set attributes on an anchor

- `app.js:839-840`: the bare-URL pass runs after the markdown-link pass and its class allows `"`, so `[x](https://a.com/(https://e.com/a/style=position:fixed;inset:0)` yields an `<a>` with an attacker `style` (CSP allows inline styles). Fix: exclude `"` and `(` from both URL classes and run the bare-URL pass only on text nodes.

---

## Low

- **L1.** `decide.ts:10`: `YES` matches "ok" and "please" at the start, so "ok, but first check the price" is a yes (NEGATED only catches "not/don't/never…"). Combined with C2 this is how a casual message approves a purchase. Tighten: treat "ok"/"please" as yes only when the message is short (≤ 6 words) or ends there.
- **L2.** `runtime.ts:1052`: `live` keeps a waiting run's id until `finish`, and `closeRunsWaitingOn`/`resumeWaitingOn` use `listRuns` with the default `limit: 50`; a room with more than 50 waiting runs would silently skip some. Pass `limit: 500`.
- **L3.** `runtime.ts:299-327`: a `connect_account` card that expires or is dismissed is never cleaned up: the Browserbase session stays open (CDP held in `BrowserbaseBrowser.live`) and `connect:<item>` stays in kv. Hook `finishConnect(item)` into `closeRunsWaitingOn`.
- **L4.** `handles.ts:78`: link codes come from `Math.random()`; use `randomInt(100000, 1000000)`.
- **L5.** `ids.ts:10`: `randomBytes(8)` feeds a 10-char id (`r[i % 8]`), so two characters repeat; use `randomBytes(10)`. The comment ("8 hex ms timestamp chars") does not match the base-36 code.
- **L6.** `web.ts:884`: the deliveries stream's `cancel()` does not remove the socket; it is only dropped on the next failed enqueue. Same for the per-session watch interval (`:855-865`), which polls SQLite every second per open tab until a write fails.
- **L7.** `web.ts:678-708`: `PATCH /api/artifacts/:id/state` refuses non-members even for `share: "link"` documents, while `GET` allows them; a link-shared checklist cannot be ticked by the people it was shared with.
- **L8.** `web.ts:1160-1164`: the Google callback stores `{ refresh_token: undefined }` when Google omits the token (re-consent); later `GoogleApi` fails opaquely. Return an error page asking to revoke and reconnect when `refresh_token` is missing.
- **L9.** `web.ts:329-342`: any signed-in person can `POST /api/agents` and thereby become `anyAgentOwner`, which unlocks `POST /api/tick`. Harmless (tick is idempotent) but should be owner-only or removed.
- **L10.** `scheduler.ts:89-104`: the staged sweep has no try/catch, unlike the other three loops (moot if H8 deletes it).
- **L11.** `scheduler.ts:201`: a watch that paused on a gate (`status: "waiting"`) and later replied is not paused; the pause check only sees the synchronous result.
- **L12.** `rooms.ts:89-94` `consent()` has no caller: there is no route or tool through which a member can consent. Consent is set only by the owner (`POST /rooms/:id/members` body `consented`, room creation). The spec's "after a one-time consent, their own accounts are used" is therefore owner-granted, and per-room (a member consented in the group is not consented in their DM, so their DM requests use the owner's accounts and ask the owner). Decide: owner-granted-per-room (then document it) or a `POST /api/rooms/:id/consent` for `self`.
- **L13.** `remember` (`registry.ts:522`): `visibleToRooms: input.private ? [ctx.room.id] : [ctx.room.id]`; the `private` input does nothing.
- **L14.** `registry.ts:712` duplicates the `spendingPaused` check that `gate.ts:62` already makes.
- **L15.** `runtime.ts:290` wraps `detail` as untrusted but not `summary`, which comes from the same webhook. Wrap both, and cap `summary` in `handleEvent` too (the route caps it; `main.ts:180` does not).
- **L16.** `main.ts:193-203`: the nightly pass runs when `getHours() === 3` in server time, not the owner's zone; the kv guard makes it at most daily. Use `hourIn(owner.timezone, now)`.
- **L17.** `bun test` takes 1.4s; CLAUDE.md asks for under a second. `web.test.ts` boots real servers; `catalog.test.ts` starts HTTP servers too. Probably fine to relax the rule in CLAUDE.md rather than the tests.

---

## Tools catalogue (`src/tools/catalog/**`, `src/tools/providers/**`)

Context for everything below: every gate is answered by the agent's owner (`gate.ts:75`); `accountOwnerId` is the requester only for a consented member, otherwise the owner (`rooms.ts:127-133`), so for a guest "the account" is the owner's; the runtime never gates generically on `sideEffect`, so each tool must call `ctx.gate` itself (CLAUDE.md rule 2).

### Critical

**T-C1. `run_javascript` is not sandboxed** (`operator.ts:196-207`). The prelude sets `fetch`, `Bun`, `require`, `WebSocket`, `XMLHttpRequest` to `undefined`; `import()` is syntax, not a global, so `await import("node:fs")`, `node:https`, `node:child_process` all load; `process` is untouched; `Bun.spawn` has no `cwd`, so the child starts where `.env` and `data/circle.sqlite` live; `PATH: ""` does not stop absolute-path spawns. The description promises "No network, no files". A page or email that talks the model into "a quick calculation" `console.log((await import("node:fs")).readFileSync(".env","utf8"))` puts `MASTER_KEY` and every vendor key into the tool result, the transcript and the room. Fix: remove the tool until there is a real isolate; failing that, `cwd` an empty temp dir, `env: {}`, and reject `import(`/`process` tokens as a stopgap. The only test (`catalog.test.ts:257-261`) checks arithmetic and spawns a real process.

**T-C2. MCP stdio `command` is remote code execution for any signed-in user** (`web.ts:606-612` accepts `command` verbatim under `access: "self"`; `mcp.ts:69` runs `Bun.spawn(this.rec.command!)` with no `env`, so it inherits `process.env`). Anyone with a Clerk account posts `{kind:"mcp", name:"x", command:"sh -c …"}` to their own connections, then says "@pip use x". Fix: drop stdio from the per-person API; if a local server is wanted, allow-list commands in server config, owner only, and spawn with `env: {}` and an empty `cwd`.

**T-C3. `connector_call` sends the member's token to any host, and GET is never gated** (`mcp.ts:150-153`, `:246`). `new URL(path, baseUrl)` with an absolute `path` (`https://attacker.example/x`, or `\\attacker.example`) ignores the base; the `Authorization: Bearer <token>` header is attached regardless; only non-GET calls from a non-owner are gated. Fix: `if (url.origin !== new URL(rec.baseUrl).origin) throw`, same for `op.path` from the OpenAPI document; see T-H1 for the gate.

**T-C4. `browser_use` acts inside a signed-in context with no gate** (`operator.ts:374-431`, `sideEffect: false`, `vault.use` at `:406`). Click/fill/press steps with `account: "ubereats.com"` place orders and submit forms as the account owner, who is the owner for any guest. "@pip reorder my usual" from a guest clicks "Place order" on the owner's account and nothing asks. `capture_and_analyze` (`knowledge.ts:57-62`) has the same hole on the read side (a guest screenshots the owner's signed-in bank page). Fix: when `steps` contain click/fill/press, or whenever `site` is set and `ctx.requesterId !== ctx.accountOwnerId`, `ctx.gate({ kind: "action", title: "OK to act on <site>?", detail: <steps>, key: ["browser_use", url, site, steps] })` and return `waitingOn`.

**T-C5. `checkout_cart` claims a verified checkout and buys nothing** (`shopping.ts:132-151`). It mints a card (`issueCard`), stores the PAN in the vault, runs the browser with `[{waitMs: 500}, {screenshot: true}]` inside a `vault.use` whose callback ignores the secret, wipes the cart, and returns `label: "Checkout at <merchant>: $X"` with `evidence: card.evidence`, so the footer counts it as a verified step. No code reads `card:*`; `cancelCard` is never called anywhere. With Stripe Issuing configured a live card with a $X limit stays open forever and the room reads "Checkout at walgreens.com: $40.00". `catalog.test.ts:161-181` locks this in. Fix: until a checkout hand exists, do not mint; return `held` ("card ready, order not placed"), label it so, keep the cart, cancel on failure. CLAUDE.md rule 1 ("never claims an action without evidence") is violated in spirit: the evidence is for the card, the label is for the order.

### High

- **T-H1. `connector_call` gate bypass via `operationId`, and a gate key without method or params** (`mcp.ts:245-251` vs `:135-141`). The decision uses `s(input.method) || "GET"`, but `api.call` takes the method from the OpenAPI operation, so `{operationId: "deletePet"}` with no `method` looks like GET and runs as DELETE unasked. The key omits method and `params` (which become the body for non-GET). Fix: resolve the operation first, gate on its method, key on `[connector, method, path, params, body]`.
- **T-H2. `send_email_as_user`: cc unvalidated and outside the approval, header injection, MIME separator dropped** (`google.ts:574-595`). `cc` is only `trim().filter(Boolean)` and is absent from title, `outreach.who` and `key`, so the owner approves "email bob as you" and the mail also goes to anyone in cc; an interior CRLF in a cc entry adds a hidden `Bcc:`; `.filter((l) => l !== "")` removes the blank line between headers and body, so a body whose first line looks like a header is swallowed, and "Bcc: x@y" as a first line becomes a real header. Fix: validate cc with the `to` regex, add cc to title/outreach/key, build as `[...headers.filter(Boolean), "", text].join("\r\n")`. No test.
- **T-H3. `send_agent_email`: cc and `replyToMessageId` outside the approval** (`people.ts:195-201`). Same fix.
- **T-H4. SSRF from member-supplied URLs.** `McpServerRecord.url`, `ApiRecord.baseUrl`/`openapiUrl` (`mcp.ts:42,119,154`) are fetched server-side with no host check, and error bodies go back to the model; `web_scrape`, `capture_and_analyze`, `browser_use` only check `^https?://`, and `main.ts:83-88` always puts a local headless Chrome in the chain, so `http://169.254.169.254/…` and `http://127.0.0.1:3000/api/…` are readable through the server. Fix: one `publicUrl()` check in `kit.ts` (resolve the host; reject loopback, link-local, RFC1918, `file:`, `data:`) used by every fetch and URL input in the catalogue.
- **T-H5. `add_contact` writes a durable memory during a run** (`people.ts:46-54`, `type: "person"`). CLAUDE.md: only `observation` during a run. Fix: write `[person] …` as an observation.
- **T-H6. Transcript readers break their own promise.** `get_session_transcript` (`operator.ts:141-153`) says "private chats of other people are never readable", but `readableRooms` (`shared.ts:25`) returns every room to the owner, including other members' DMs with the agent: "@pip what did Riley tell you privately?" from the owner in a group reads Riley's DM into the group. `whatsapp_load_recent/_conversation/_get_summary` (`knowledge.ts:184-228`) apply no `visibleTo` filter at all. Fix: exclude DMs the requester is not in, owner included; route all readers through one `readTranscript(ctx, room, limit)` that filters `visibleTo`.
- **T-H7. Guests read the owner's accounts with no gate, into the group transcript**: `search_emails`, `get_email_content` (`google.ts:416-490`), `list_events` (`:105`), `find_files`/`get_metadata`/`get_spreadsheet` (`:609-806`), the `slack_*` tools (`knowledge.ts:106-166`), `list_saved_addresses` (`shopping.ts:197-203`). Design §9b gates writes only, and `skills/connected-apps.md:8` says reading Gmail "needs no approval"; but a non-consented guest's `accountOwnerId` is the owner, so "@pip search Alex's email for 'bank'" quotes the owner's mail into a shared room. This needs a product decision; the cheap mechanism is a `readsOtherAccount(ctx)` helper that gates (kind `action`) or refuses when `requesterId !== accountOwnerId`.

### Medium

- **T-M1.** `remove_email_label` (`google.ts:539-549`) is the one Gmail write with no `guard`; `label_email` and `archive_email` have it.
- **T-M2.** `share` (`google.ts:706-722`): the `message` Google emails to the third party is outside the detail and key; `role` not restricted to the enum.
- **T-M3.** Shopping writes on someone else's profile are unguarded (`add_to_cart`, `remove_from_cart`, `save_address`, `delete_saved_address`, `shopping.ts:56-99,158-216`), and the checkout gate's detail/key carry no address (`:121-123`): a guest saves an address, then `checkout_cart {addressId}`; the owner approves "$X at merchant" and the goods go to the guest.
- **T-M4.** `add_to_cart` (`shopping.ts:66-73`) accepts zero/negative prices (so $500 + −$490 gates as $10, under the auto-approve threshold) and any URL scheme (`file:///` reaches LocalBrowser at checkout).
- **T-M5.** MCP and API credentials leave `vault.use`: `mcp.ts:181,240` do `vault.use(key, raw => JSON.parse(raw))` and use the token outside the callback. Fix: run the client inside the callback.
- **T-M6.** `vault.put("card:<id>")` makes card ids appear in `vault.services()`, which the prompt prints as "Connected accounts for Alex: google, card:card_1, …" (`prompt.ts:116`) and `load_workspace_context` returns; PAN+CVC stay encrypted forever; `cancelCard` is dead.
- **T-M7.** Cross-room reads: `list_sms_groups` (`people.ts:108-111`) lists every chat room and its members to any requester; `read_dashboard` (`operator.ts:293`), `present_files` (`:310`), `analyze_image` (`:352`) match by title/id across all rooms with no membership check.
- **T-M8.** `get_connect_link` (`operator.ts:446-450`) turns "my bank" into `mybank.com` and opens a live sign-in on the guessed domain, calling `connect_account.run` directly so the record says "Made a connect link" while a sign-in card is actually open.
- **T-M9.** Google writes (`create_calendar`, `update_event`, `delete_event`, `move_events`, label/archive, `update_spreadsheet`, slides, `create_form`) are flagged `sideEffect: false`, so once H1 is fixed they still will not count; mark every write `true`.
- **T-M10.** The assistant's inbox: `email_load_unprocessed` (`knowledge.ts:89-92`) marks mail processed before the run acts on it (a failed run loses it); `AgentMail.seen` is in memory only (`providers/email.ts:9,84-86`), so a restart replays the last 50 as new (the `email:<id>` dedup key in `main.ts:182` saves the event path but not the tool path); any member of any room can read the whole inbox.
- **T-M11.** `mcp_call` on one's own connection is never gated (`mcp.ts:192`), even when the remote tool sends messages to third parties; §9b says anything reaching a third party asks. At minimum gate tools the server marks non-`readOnlyHint`/`destructiveHint`, or whose names match send/post/create/delete/pay/invite.

### Low

- `update_spreadsheet` uses `valueInputOption: USER_ENTERED` (`google.ts:836`); injected `=IMPORTXML(...)` formulas exfiltrate on open. Use `RAW` unless asked.
- `find_files`/`search_user_spreadsheets` (`google.ts:620,852`) escape `'` but not `\`.
- Unbounded limits: `search_emails.maxResults` (`:431`), `list_past_sessions`/`get_session_transcript` (`operator.ts:128,152`), the WhatsApp and Slack `limit`/`count`. Clamp each.
- `create_event` attendees are not checked as email addresses (`google.ts:278`).
- `place_vendor_call`: `maxMinutes` is prose only; `VapiPhone.call` blocks the room session for up to 20 minutes (`providers/misc.ts:140`); Vapi's `voicemail` end reason with a non-zero duration reports "completed", and the `/no-answer|busy/` regex misses `customer-did-not-answer` (`:155-161`).
- `register_pronunciations` (`people.ts:85`) says it applies to calls; no call path reads `pronunciations:*`; ElevenLabs substring replacement turns "Ann" into "Annual" (`misc.ts:23`).
- `McpClient` over HTTP never sends `notifications/initialized` (`mcp.ts:84-94`); the stdio path spawns two processes per call; `connector_call` asks for YAML then `JSON.parse`s (`mcp.ts:119-122`).

### Twins and duplication

Only `skills/connected-apps.md:13-14` steers the model to the catalogue twins; every other skill names the core tool (`browse_page`, `place_call`). The eval harness already maps them (`harness.ts:162`). Decisions:

| Twin | Keep | Remove | Note |
|---|---|---|---|
| `web_scrape` (`knowledge.ts:15-41`) vs `browse_page` | `browse_page` | `web_scrape` | Bodies identical; `web_scrape`'s own description says "use either". Fix `connected-apps.md:14`. |
| `browser_use`, `capture_and_analyze` vs `browse_page` | one "act" tool (`browser_use` with the T-C4 gate), or `browse_page` with `steps`+`lookFor` | `capture_and_analyze` | `capture_and_analyze` is `browser_use` with `[{screenshot}]` + a question that `lookFor` already covers (`operator.ts:410-419`). |
| `place_vendor_call` (`people.ts:115-172`) vs `place_call` | `place_call` | `place_vendor_call` | They have diverged: only the vendor twin validates E.164; keys differ (`[to]` vs `[to, objective]`); only `place_call` triggers `setState("calling")` and counts in `integrityNote`. Move the E.164 check into `place_call`; fix `connected-apps.md:13`. |
| `search_contacts` (`people.ts:7-20`) vs `find_person` | `find_person` | `search_contacts` | Literal alias. |
| `whatsapp_load_conversation`/`_recent`, `list_sms_groups` vs `get_session_transcript`/`list_past_sessions` | the two core readers with an optional `channel` | the three | And they lose the `visibleTo` filter (T-H6). |
| `search_user_spreadsheets` vs `find_files`; `check_availability` vs `find_mutual_availability` | one each | the narrower | Mime filter / single-email special cases. |
| `checkout_cart` vs `request_purchase` | decide once T-C5 is resolved | | Skills split: travel/shopping/government use `request_purchase`, connected-apps uses `checkout_cart`. |
| `search_products` vs `web_search` | acceptable | | `web_search` + " buy price" + price parsing. |

Copied helpers: `list` schema helper twice (`operator.ts:9`, `google.ts:17`) → `kit.ts`; `merchantOf` (`shopping.ts:23-27`) re-implements `siteOf`; `who()` (`google.ts:25`) repeats `notConnected`'s lookup (`shared.ts:34`); the gate boilerplate (`if (!gate.granted) { if ("held" in gate) …; return { waitingOn, roomNotice } }`) appears 15 times (google 4, people 2, mcp 2, shopping 1, registry 6) and should be one `askFirst(ctx, g, waitingText): ToolResult | undefined` in `kit.ts`; `String((e as Error).message).slice(0, 200)` about 12 times → `errText(e)`.

`McpClient` and `OpenApiConnector` (`mcp.ts:35-163`) call `fetch`/`Bun.spawn` from inside the catalogue with no interface in `hands.ts` and no fake, which is why `catalog.test.ts:199-255` starts real `Bun.serve` sockets. Move them to `providers/mcp.ts` behind `McpProvider`/`ApiProvider` with fakes.

`google.ts` (1029 lines): 26 copies of `if (!connected(ctx)) return notConnected(ctx, "Google")`, 25 `try { … } catch (e) { return fail(e) }`, 13 hand-written guard calls, the createSlide request built twice (`:927-938`, `:982-993`), the presentation URL five times. A `gtool({name, schema, labels, write?, call})` factory absorbs all three wrappers, after which the file splits naturally into `calendar.ts`, `gmail.ts`, `drive.ts`, `slides.ts` (~150 lines each). `search_emails` fetches each message twice (`:435-444`, the `format=metadata` call is redundant).

### Catalogue dead code

- Re-exports that exist only to silence unused imports: `operator.ts:494` (`_newId`, `_Id`, `_notConnected`), `people.ts:228` (`_newId`, `_nc`), `mcp.ts:278` (`_n`). Delete the imports and the re-exports.
- `PaymentProvider.cancelCard` (`hands.ts:92`): never called. `GoogleProvider.request({ raw })` (`hands.ts:58`, `providers/google.ts:68,79`): never passed. `googleExchange`'s `access_token` is ignored by its caller (`web.ts:1163`).
- Exported but file-local: `GOOGLE_SCOPES`, `CartItem`, `McpServerRecord`, `ApiRecord`, `McpClient`, `OpenApiConnector`.

### Catalogue test gaps

No offline test for: `browser_use` gating and the account path (T-C4); `run_javascript` isolation (T-C1); `connector_call` origin check, `operationId` bypass and key contents (T-C3, T-H1); `mcp_call` on another person's connection; the stdio path; `send_email_as_user` (sendAsMe refusal, gate, MIME output) (T-H2); cc on `send_agent_email` (T-H3); `create_event` with attendees (gate and `held`); `share`'s gate; `place_vendor_call`'s gate and E.164; `remove_email_label` (T-M1); guest `save_address`/`delete_saved_address`/checkout with another address (T-M3); negative price / non-https URL in `add_to_cart` (T-M4); `get_session_transcript` on another person's DM and the WhatsApp tools' `visibleTo` (T-H6, T-M7); `add_contact`'s memory type (T-H5); `email_load_unprocessed` after a failed run. Weak tests: `catalog.test.ts:15-103` checks only that names exist; `:115-128` covers `guard` for `create_event` without attendees only; `:161-181` asserts the false checkout claim; `:199-255` use real sockets; `:257-261` spawns a real process.

### Catalogue: what is good

Google, Slack and browser-context credentials are handed over inside `vault.use` (`google.ts:20`, `knowledge.ts:119`, `operator.ts:406`) and the refresh token never reaches the model; the OAuth callback stores only `{refresh_token, email}`. Gate keys bind the payload that matters in most places (`send_agent_email`: to/subject/text; checkout: merchant/amount/item ids; `update_event`: the whole input) and the "Nothing was sent / nothing has been dialed" wording is honest. `held` is handled uniformly and never reported as done. `to` is regex-validated in both email tools; Subject CRLF is stripped; `place_vendor_call` checks E.164; `browser_use` refuses password and card fills; every URL tool checks the scheme; `notConnected` is a consistent dead-end; `freeSlots` is pure and tested; `readableRooms` + the `visibleTo` filter in `get_session_transcript` are the right shape to reuse; `cancel_scheduled_action` checks who is asking (`operator.ts:110`); the checkout test asserts the card number never appears in the transcript; the providers are small and plain and truncate errors.

---

## Web UI (`web/app.js`, `web/index.html`) beyond M10-M13

Every `fetch` path, method, body and response field matches a route in `web.ts` and the types in `core/types.ts`; all `$("#id")` targets exist; `esc()` is used consistently; handlers are assigned on freshly rendered nodes so listeners do not pile up; the Why? drawer renders steps from records. Remaining issues:

- **W-M1.** `#status` (`index.html:26`) has no `aria-live` and is `display: none` on phones (`styles.css` phone query), so send failures, "over 10 MB", "Sign in required." and invite-copy errors are invisible on a phone and never announced. Add `role="status" aria-live="polite"` and a toast on narrow screens.
- **W-M2.** After a dropped deliveries stream (`app.js:1540-1576`) the first line `{ping:0, boot}` only triggers a reload when the boot id changed; messages delivered during a laptop sleep or a network blip stay invisible until the next delivery. Call `load()` on every reconnect.
- **W-M3.** Unhandled rejections: `load()` (`:160`) uses `Promise.all`, so one failed request skips `renderNav` and settings, and every `load()` call site ignores the rejection; `dismiss` (`:545`), `pause` (`:577`), `forget` (`:1522`), `disconnect` (`:1467`), address add/remove (`:1222,1231`), `renderSearch` (`:370`) have no catch; the sendAsMe switch (`:1328-1333`) flips before the request and never flips back; `renderMemory` (`:1494`) calls the owner-only `/api/memory` for every member and gets a blank page plus a 403. One `guard(fn)` that calls `status(e.message, true)`, and `Promise.allSettled` in `load()`.
- **W-M4.** Background re-renders wipe input: `renderInbox` ends with `renderNav()` (`:597`), rebuilding the Add-member form (`:311`) on every delivery; the inbox "Reply…" form (`:533`) is wiped by the next `renderInbox`; Permissions toggles call `load()` and drop unsaved community chips (`:1340`); `settingsAddress` renders twice (`:1223-1224,1233-1234`). Skip regions containing the focused element (as `renderSettings` already does) and do not call `renderNav` from `renderInbox`.
- **W-M5.** Controls shown to people the server will refuse: the Memory tab (owner-only route), the Spending/Permissions/Assistant forms (`PATCH /api/agents` is `agentOwner`), Radar "Pause" (`:569`, `roomOwner`), and "+ New room" which uses `state.agents[0]` (`:404`), someone else's agent for a member and the wrong one with several agents. Gate on `agent.ownerId === state.me` / room role and use `agentFor(state.room)`.
- **W-M6.** Accessibility: settings and `personForm` labels sit beside inputs with no `for`/`id` (`:458-462,1193-1198,1392-1395`); the `.switch` buttons (`:1242,1323,1373`) have no accessible name; the composer `#text` (`index.html:44`) and the add-member, address, connections, reply and community inputs have placeholders only; the drawer (`index.html:69`, `app.js:1063`) has no `role="dialog"`/`aria-modal` and does not move or return focus; room status dots (`:258`) are colour-only; tabs have no `aria-selected`/`aria-current`; `#homeToggle` has no `aria-expanded`.
- **W-L1.** Search results can arrive out of order (`:362-381`); check `q === $("#search").value.trim()` after the await.
- **W-L2.** `scheduleWords` (`:128-139`) ignores `Calendar.everyHours`, so watches read "Scheduled"/"Every day at…"; `triggerWords` (`:600-608`) has no wording for `task` or `event`.
- **W-L3.** Dead/stale: `_isPhone` (`:125`); the `system`-role branches (`:737-738`) cannot run because `:694` filters system messages; `data.messages ?? data` (`:694`) is unreachable; `eventWords(_run)`; `.memrow select` CSS; `#nav`/`#center`/`#home` ids unreferenced.
- **W-L4.** Duplication: `renderNav` runs twice per `load()` (`:161,597`); the open-room sequence is copied five times (`:264-275,382-392,436-441,550-558`, `route()`) → `openRoom(id)`; `row()` defined twice (`:1216,1442`); the `state.me ? "&personId=…" : ""` fragment rebuilt ~12 times.
- **W-L5.** `URL.createObjectURL` in `renderPending` (`:906`) is never revoked.
- **W-L6.** "is linked" (`:1294`) and the new checklist (`:1631`) key off `person.phoneE164`, which anyone can type in Settings → General, so "linked" does not mean the link code was used.
- **W-L7.** `personForm` (`:469`) drops empty fields so a field cannot be cleared there; Settings → General sends "" and can.
- **W-L8.** Signed out, `route()` (`:198`) still runs after `:72` replaced `#app`, so `#signin`→`#signup` throws on `$("#pageChat")`; the Clerk token refresh interval (`:91-93`) has no catch.
- **W-L9.** The code added in `dc5c3e6`: `gettingStarted` reads `x.lastMessageAt`, which no `Room` has, so that check is always false; it mixes in `state.lastMsgCount` (per open room, reset to −1 on navigation); it uses `state.agents[0]`; `loadReach` adds two requests to every `load()`.
- Routes the UI never calls: `/api/runs/:id/stop` (no Stop button next to the working indicator), `/api/tasks`, GET/POST `/api/schedules`, the three credential routes, member-role PATCH, the `/api/artifacts` list, POST `/api/memory`, POST `/api/agents`, GET `/api/people`, events, tick. Either build the UI for them or drop the routes.

---

## Dead code list

Verified by grep over `src/`, `test/` and `web/`:

| Item | Where | Note |
|---|---|---|
| `StagedItem`, `Scheduler.stage`, `Store.putStaged/dueStaged/listStaged`, `staged` table, tick sweep | `types.ts:443`, `scheduler.ts:89-104,261-266`, `repos.ts:368-385`, `db.ts:80-82` | No caller of `stage()` anywhere (H8). |
| `AgentSpec.rules` | `types.ts:122`, `spec.ts:53` | Initialised to `[]`, never read or written; rules live in memory. |
| `approachOfTool` | `planner.ts:136` | Exported, never imported; the runtime uses `result.approach`. |
| `markdownToHtml` | `artifacts.ts:6` | Exported, never called (the document page re-implements inline rendering in the client script). |
| `buildSystemPrompt` `readOnly`, `extra` | `prompt.ts:28,37,125-126` | Never passed by any caller. |
| `Store.getAgentByHandle`, `Store.listStaged` | `repos.ts:54,380` | No callers. |
| `TaskService.inFlight` | `tasks.ts:61` | Only used by a test. |
| `Delivery.visibleTo` | `runtime.ts:27`, `web.ts:181` | Never set by any `deliver()` call (M5): the filter is dead until it is. |
| `remember.private` input | `registry.ts:497,522` | Both branches identical (L13). |
| `void agent` in `pendingItemFor` | `runtime.ts:391` | Parameter kept only to silence lint. |
| `DEFAULT_MODEL`, `SMALL_MODEL` exports | `anthropic.ts:5-7` | Used only as internal defaults; `config.ts` carries the real defaults. |
| `rooms.consent` | `rooms.ts:89` | No route or tool calls it (L12). |
| `MAX_ATTEMPTS_PER_STEP`, `APPROACH_LABEL`, `DEFAULT_LADDER` exports | `planner.ts:17-29` | Internal use only; drop `export`. |
| `web/app.js`: `_isPhone` (:125), system-role branches (:737-738), `data.messages ?? data` fallback (:694), `eventWords(_run)`, `.memrow select` CSS, `#nav`/`#center`/`#home` ids | see M10-M13 section source | Reported by the UI pass. |

`Plan.auto` (`types.ts:504`) is **not** dead: `planner.complete` reads it to keep an automatic one-step plan open. Keep it.

## Suggested refactors, with effort

1. **Gate on `ToolDef.sideEffect`, not a list** (H1). Half a day: change `integrityNote` to take `TOOL_INDEX`, flip `request_purchase` to `sideEffect: false`, extend CLAIM, add two tests (email claim with evidence passes; "ordered" after budget-only is corrected).
2. **One `pendingItemFor` rule** (C2, L1). Half a day: the item must be assigned to the sender or the group, the text must `answers()` it (or be free text for `information`/`action` kinds), and a message that names the agent is never an answer. Four tests: unrelated message in group, unrelated message in DM, real yes, option pick.
3. **Profile privacy by room kind** (C1). Two hours: the filter plus the regression test above. While there, make `remember.private` write `visibleToRooms: []` for person scope so the note never leaves the DM at all.
4. **Fire-and-forget channel inbound** (C3). Two hours in `imessage.ts`, plus a test with a blocking scripted run.
5. **API projections** (H2, H5). Half a day: `publicPerson()` in `queries.ts`; `toolCallSummary()` used by `/api/rooms/:id/messages` (already does this at `web.ts:534`) and `/api/runs/:id`; `/api/state` and `/api/people` return projections for anyone but `me`.
6. **Delete staging** (H8). One hour, plus doc edits.
7. **Serialise `handleMessage` per session** (H4). One hour: a `Map<sessionId, Promise>` chain in `Runtime`, or move the classifier call under the active-run check.
8. **Role checks on stop/commitments/files** (H6, H7). One hour.
9. **Collapse the duplicated `schedule_action`/`watch_for` gate-and-create code** into one helper (`registry.ts:572-623, 849-886`): the role check, gate, owner DM and `Scheduler.createSchedule` call are the same twice. One hour.
10. **`web/app.js`**: one `openRoom(id)`, one `row()` helper, one `guard()` for fetch errors, a `me` query fragment helper, and patch-by-id thread rendering. One day; it also fixes M12.
11. **Catalogue containment** (T-C1..T-C5). One day: delete `run_javascript` and the stdio MCP path, origin-pin `connector_call`, gate `browser_use` on action steps and foreign accounts, make `checkout_cart` honest. These are the ones to do before any public deployment.
12. **`askFirst()` + `publicUrl()` + `readTranscript()` in `kit.ts`/`shared.ts`** (T-H4, T-H6, duplication). Half a day; removes ~15 copies of the gate boilerplate and gives every URL input one SSRF check.
13. **Remove the twins** (`web_scrape`, `capture_and_analyze`, `place_vendor_call`, `search_contacts`, the three WhatsApp readers) and fix `skills/connected-apps.md:13-14`. Half a day; the harness's `TWINS` map becomes empty.
14. **`gtool()` factory and split `google.ts`** by product. One day; mechanical.

## Test gaps

Behaviours with no offline test, in priority order:

1. A DM note never appears in a group prompt after consolidation (C1).
2. An assignee's unrelated message does not resolve their own open card, in the group and in the DM (C2). The existing test covers only "a question put to someone else".
3. A claim after a real catalogue side effect (email, calendar) gets no correction; a claim after `request_purchase` alone does (H1).
4. Two unaddressed group messages within the classifier's latency produce one run, not two (H4).
5. `/api/state` and `/api/people` do not return another member's `addresses`/`phoneE164` (H2); `/api/runs/:id` does not return raw tool results to a guest (H5); a guest cannot stop the owner's run or close the owner's commitment (H6); `/api/files` rejects a non-member's room (H7).
6. Compaction keeps the newest 12 messages even when `at` values collide (M1): advance the fake clock by 0 between messages and assert `note 24` is present.
7. A card delivery for one member is not pushed to another member's `/api/deliveries/watch` (M5).
8. iMessage inbound: a second room's message starts a run while the first room's run is still blocked (C3).
9. Scheduler tick overlap: two concurrent `tick()` calls fire a due schedule once (M4).
10. `wait_for_user_input` with a bad `kind` does not produce an "undefined:" card (M8).
11. The catalogue gaps listed under "Catalogue test gaps", starting with `browser_use` on a foreign account, `connector_call` to an off-origin path, and `checkout_cart` not reporting a checkout.

Tests that pass trivially or test the wrong thing: `memory-and-timers.test.ts:77-79` asserts the public profile is undefined for notes with `visibleToRooms: []`, which no production writer produces; `harness.test.ts:205` (compaction) passes with a frozen clock only because the final message is written after the fold; `test/web.test.ts:44-58` checks the 401/403 matrix on 15 routes but not the data shape of the 200s (which is where H2/H5 live).

## What is good (do not touch)

- **Store** (`repos.ts`, `db.ts`): events are append-only with a per-session `seq` computed in a transaction, there is no update or delete path for `run_events`, `listMemories`/`searchMemories` filter superseded and retracted rows in SQL, `runs.dedup_key` is a partial unique index, migrations are versioned and the base schema is idempotent.
- **Gate** (`gate.ts`): one function, approvals are records bound to run and gate key, a yes is consumed once, a no sticks, twins are matched by gate key, working hours are checked before anything else. The eleven approval tests in `harness.test.ts` are the best tests in the repo.
- **Vault** (`vault.ts`): AES-256-GCM with a random IV, secrets only inside `use`, names only on the way out; `browse_page` and `connect_account` honour it (`registry.ts:88-91,143-144`); the model never sees a context id. `web.ts` returns service names only.
- **Runtime honesty**: `buildFooter` and `integrityNote` are pure and record-driven (modulo H1), gated tools are closed as `stopped` on finish, `stop` cannot be overwritten by a late done, refusals fail the run, `stay_quiet` folds the trigger message, `NOTHING` backstop.
- **`decideGate` + `resumeWaitingOn`** handle two runs waiting on one card correctly, and the owner-answers-on-behalf path does check `answers()`.
- **Memory service**: `visibleIn`/`recall`/`rulesFor` are the only read paths and every caller in `src/` goes through them (the admin route is explicitly the owner's view); the agent writes only `observation` during a run except the owner's rules; durable writes are confined to `Consolidator` (plus the owner's `POST /api/memory`, a human, not the agent). The consolidator validates ids against its own scope.
- **Web policy table**: declaring `access` per route and running `permit` before the handler is the right shape; the token/`orToken` path with constant-time compare is correct; CSP is strict (no inline script, hashed boot script, `frame-src` limited to Browserbase); `readBody` enforces JSON content type; `main.ts` refuses to bind off-loopback without Clerk and `MASTER_KEY`.
- **Channel mapping** (`handles.ts`): pure, tested, normalised handles, derived ids that cannot collide, rate limit per handle, link codes consumed on first use.
- **Search/reach adapters**: defensive (bad status → no results, never throw), bounded output, parsed with tests.
- **Scheduler**: per-item try/catch, premise check fails open, watches never stack, `computeNext` is zone-correct and tested.
- **Repo style**: short files, plain names, comments that say why. Keep it.
