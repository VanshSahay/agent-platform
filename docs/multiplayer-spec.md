# Circle: multiplayer coordination spec

How one assistant joins a group of people (a couple, a friend group, a trip chat, a family thread, a street) and works for all of them at once. This note is the spec for that one area. It records what the current branch already does (with file pointers), what Fo and Instinct do that we should copy or avoid, and the build order we would follow starting from scratch. [design.md](design.md) stays the general spec; this one goes deeper on the group model and is the source of truth where the two differ.

Status words used throughout: **built** (in the branch, tested), **partial** (code exists, gap named), **new** (proposed here, not written).

---

## 1. Thesis

Fo and Instinct are single-player products. One person signs up, gets one agent, and talks to it in one chat; other people and channels are bolted on afterwards. Fo's group chats are a paid-tier feature on top of a personal agent, and Instinct's memory has one owner and no notion of who may see what.

We start from the group. The unit is a **room**: a chat that already exists between people who already coordinate. One person sets the assistant up and invites the others, or adds it to a chat they already have. Everyone in the room gets help without setting anything up. The assistant has to be better than a personal agent dropped into a group in exactly these ways:

1. **It knows who is who.** Each message has a requester with a role, consent state and connected accounts. Whose account a tool uses, who gets asked for approval, and whose memory a fact belongs to all follow from that.
2. **It carries the ledger.** Who agreed to do what by when, nudged and escalated without anyone chasing.
3. **It keeps private things private.** What is said in a DM never surfaces in the group. What one group says does not leak into another, even though it is the same assistant.
4. **It behaves in a group.** One message per turn, speaks when named or when a message plainly concerns what it was added for, otherwise stays quiet. Silence is an outcome.
5. **It makes shared things.** A packing list, a who-brings-what, a plan for Saturday, a cost split: a page the whole room ticks, claims and adds to, not a wall of text.

And one thing it must not lose by being multiplayer: **it is still a personal assistant.** The person who sets it up is usually the most tech-comfortable one in their circle, and they want Fo for themselves: their inbox, their calendar, their errands, their subscriptions, in a private chat, with their own accounts and no approvals. Groups are rooms they add on top of that. A solo user is a room of one, and the whole product has to work with zero other people in it. The group machinery (roles, consent, cards to other people) must cost a solo user nothing: no consent step, no "I've asked X", no roles to understand.

Everything below serves those five.

---

## 2. Evidence from Fo

Sources: [research/wajo-fo.md](research/wajo-fo.md), [research/wajo-fo-build.md](research/wajo-fo-build.md), [research/wajo-fo-client-report.md](research/wajo-fo-client-report.md), [research/wajo-fo-rpc-catalog.md](research/wajo-fo-rpc-catalog.md), [research/wajo-fo-search.md](research/wajo-fo-search.md). Observations are from the client bundle and the generated RPC access table (224 methods of `wajoai.agentnet.v1.AgentNetService`); nothing here claims to have seen Fo's server.

### 2.1 What Fo has for groups

| Observed | Where | What it tells us |
|---|---|---|
| Group chats are an entitlement: "unlock unlimited Fo asks, unlimited calling time, and group chats" | build.md §plans | Groups are an upsell on a personal agent, not the base unit. |
| `ListMyGroupSessions` (allowed), `RecordSmsGroupMembership`, `RecordGroupContextTurn`, `SendGroupOutsiderInvites`, `RecordOwnerDm`, `RevokeExternalReplyAccess` (all server-only) | rpc-catalog | A group is a session with recorded membership. Non-members who show up in a thread (an SMS group) can be invited in and later revoked. The owner has a private DM alongside the group, recorded separately. Group turns are recorded as "context" (the agent hears without being addressed). |
| `ResolveSessionByChannelThread`, `ResolveReplyByMessageId`, `ResolveReplyToken`, `ResolveSmsReplyBinding` | rpc-catalog | One session spans web, email (reply tokens), SMS and SMS groups. The thread, not the channel, is the identity. |
| Agent `visibility ∈ PRIVATE | PROJECT | ORG | PUBLIC` ("Only you and explicit collaborators" / "You and members of the agent's project" / "Everyone in your workspace") | build.md | Sharing an agent is by scope, with collaborators as the smallest unit. |
| Org roles `OWNER | ADMIN | MEMBER`; owners assign any role, admins assign member/admin; workspace instructions need admin, deletion needs owner | build.md | A three-level role ladder with asymmetric rights. Ours collapses to owner / member / guest because a household is not an org. |
| Invites: "Invite friends to Fo Mini … One invite is used when they join." "Out of invites? Ask Fo for five more." `/orgs/invites/$token` | build.md | Invite links as tokens; the agent itself can mint invites in conversation. |
| Approval is a transcript turn: tool result `greenlight_verdict: "ask"` draws a held card; the user's next message is the decision. No approve button. | design.md §2, build.md | Every decision is in the run record. We keep this and add: the card goes to the **right person's** DM, not the room. |
| Schedules carry an authorisation preamble naming who may be contacted, how, why, and the premise | client-report | Disclosure is approval in advance. Essential in a group, where the person who created the schedule may not be the owner. |
| Working hours: outreach outside 8am to 8pm is staged (`DeliverStagedItem`, `ListDueStagedItems`) | wajo-fo.md | A rule implemented as data and a sweep, not a prompt hope. |
| Trust: "Ask before purchases over $X", pause spending, per-tool allows, pre-approved communities | wajo-fo.md | Trust is a few numbers and switches. In a group these are per account owner, not per room. |
| Permission toggle: "Send email from your Gmail, as you. Each send still needs your go-ahead. Off until you turn it on." | wajo-fo.md | Send-as-me is a separate permission from connecting the account, and still gates each send. |
| Agent identity: own email, own phone number, own minted card | wajo-fo.md | The assistant acts in the world as itself, so it can act for a guest without touching anyone's account. The owner's card funds it. |
| Named steps with server-sent labels; "Completed N steps · 1 failed" | build.md | In a group, people who did not ask need to see what was done on whose behalf. |
| `wait_for_user_input` is a running tool; the run pauses in `waiting` | design.md §2 | Waiting on a person is an execution state, so a room with three open questions is three paused runs, not one confused thread. |
| Heartbeat tiers (`ComputeHeartbeatTier`, `EvaluateHeartbeatTick`), `message.proactive` | wajo-fo.md | Proactive messages come from a scheduled wake, rate-limited by tier. In a group, one heartbeat per room, not per person. |
| Human assistant fallback (`assist/*`) with revealed logins and minted cards | wajo-fo.md | Not taken. A stuck errand in a group goes back to the group, which is itself a pool of humans. |
| Attention inbox: `kind ∈ attention | schedule | session`, `status ∈ needs_you | working | scheduled | done | didnt_finish` | build.md | One list for "what needs me". In a group each member's inbox is filtered to items assigned to them. |

### 2.2 What Fo lacks that a group needs

Fo is the bar for the solo case; nothing below says otherwise. The personal chat in §6.0 has to match it: own accounts, no approvals within trust, the whole tool catalogue, schedules, calls, email, shopping.

- **Roles inside a chat.** Fo's SMS group members are recorded but there is no evidence of per-member rights; the agent is still one person's. We need owner / member / guest with different account and approval paths.
- **Whose account.** Fo's tools use the signed-in user's connections. In a group, a member's own Gmail must be used for their own request and nobody else's.
- **Memory with visibility.** Fo's `search_memory` has no scope. A group assistant must filter recall by room.
- **A ledger across people.** Fo tracks its own tasks; it does not track that Sam said he would book the cabin by Friday.
- **Shared artifacts with state.** Fo's documents are shared read-only ("Only me" / "Anyone with the link"). Ours are small apps the room edits.

---

## 3. Evidence from Instinct

Source: the public teardown of Instinct's memory and Supermemory's harness diagram, as recorded in [design.md §3 and §8b](design.md). We did not analyse an Instinct binary; these are the mechanisms the teardown described.

| Instinct mechanism | What we took | What we changed for groups |
|---|---|---|
| The agent is read-only during a run; a daily worker consolidates | **built**: `remember` writes only `observation`; `Consolidator` promotes, merges, generalises, retracts (`src/memory/consolidate.ts`) | Consolidation runs **per scope**: person observations become person memories, room observations become room memories. A fact never changes scope during consolidation. |
| Keyword recall over text plus aliases, newest wins | **built**: FTS5 with automatic content-word aliases | Recall is filtered by `visibleIn(room)` before ranking, so the group never sees a DM fact. |
| A short profile is always-on context | **built**: one per person and one per room, with a derivation date | In a group prompt both the room profile and the requester's profile are present; other members' profiles are summarised to one line each. |
| Dated facts, versions kept, explicit forgetting | **built**: `supersededBy`, `retractedAt`, `includeInactive` | "Forget that" from the subject of a fact retracts it even if the owner said it. |
| Main harness → task agent → reply / file / stay quiet | **built**: `delegate_task`, `stay_quiet`, `watch_for`, compaction, app events | Task agents report back to the room that asked, once, with a delivery log so a resume never repeats itself. |
| Two-day profile lag | accepted cost; ours re-derives on every consolidation and on "Tidy up now" | |
| No scope, no visibility, one owner | **added**: `scope ∈ agent | person | room`, `scopeId`, `visibleToRooms`, `subjectPersonId` | This is the whole difference. See §9. |

---

## 4. The object model

All types live in `src/core/types.ts`. Only the fields that matter to coordination are listed.

```
Agent        id, ownerId, name, soul, instructions, trust: TrustPolicy
Person       id, displayName, pronouns?, timezone, phoneE164?, email?, techComfort?, addresses?, sendAsMe?
Room         id, agentId, kind: dm | group, channel, externalId?, name, focus?, outreachHours, readOnly?
Membership   roomId, personId, role: owner | member | guest, consentedAt?, joinedAt
Invite       token → { roomId, createdBy, createdAt }            (kv today; a table when it needs expiry and single use)
Session      one per room; the thread the runs belong to
Run          sessionId, roomId, requesterId?, status, waitingOn?, scheduleId?
AttentionItem roomId, runId?, assigneeId, requesterId?, kind, gateKey?, title, detail, options?, status, answer?, answeredBy?, expiresAt?
Approval     runId, itemId, gateKey, decision, decidedBy, consumedAt?
Commitment   roomId, ownerId (person or agent), beneficiaryId?, title, dueAt?, status, nudges, nextNudgeAt?
Schedule     roomId, prompt, calendar | runAt, authorization: { basis, disclosedOutreach[], premise }, watch?
Memory       scope, scopeId, type, subjectPersonId?, visibleToRooms[], text, aliases, statedAt, supersededBy?, retractedAt?
Profile      scope, scopeId, text, derivedAt
Artifact     roomId, kind: document | dashboard | image | audio | file, state: DocState { checked, claimed, added }
Task         roomId, sessionId, requesterId?, status, progress, delivered[]
```

Three identities the model keeps separate, and why:

- **The agent** is one identity across every room it is in. Its memory, rules and skills follow it. Its own email, phone number and card (when wired) are its own, so it can act for a guest without using anyone's account.
- **A person** is one record across channels. The same human on iMessage, in the web app and by email is one `Person`, matched by phone, email or sign-in. Everything about rights and memory hangs off `Person.id`, never off a handle.
- **A room** is one thread on one channel. The same three friends on WhatsApp and in a web room are two rooms. What is said in one stays in it unless a person is in both and the fact is about them (§9).

### 4.1 Where this sits in the code

| Concern | File |
|---|---|
| Roles, consent, whose account, who approves, DM per person, room description for the prompt | `src/rooms/rooms.ts` |
| Single gate policy | `src/runtime/gate.ts` (`decideGate`) |
| Addressing, steering, run loop, resume on answer | `src/runtime/runtime.ts` |
| Invites and join | `src/channels/web.ts` (`/api/rooms/:id/invites`, `/api/invites/:token`, `/api/invites/:token/accept`) |
| First run: agent plus owner seat | `src/main.ts` |
| Memory scope and recall | `src/memory/memory.ts` |
| Ledger and nudges | `src/care/commitments.ts`, `src/scheduler/scheduler.ts` |
| Shared pages | `src/channels/artifacts.ts`, `PATCH /api/artifacts/:id/state` |
| Channel adapters | `src/channels/imessage.ts` (generalised to whatsapp, telegram, slack via `CHANNELS`) |
| Group behaviour procedures | `skills/group-chat-manners.md`, `skills/outreach-rules.md` |

---

## 5. Roles

Three roles, chosen so that a household never has to learn the word "admin".

| | owner | member | guest |
|---|---|---|---|
| Who | Set the assistant up. Their accounts and money by default. | Joined through an invite or sign-in. Has a seat and may connect their own accounts. | Never signed up. In the chat because the chat already existed (an iMessage group, a WhatsApp thread). |
| Can ask for anything | yes | yes | yes |
| Own accounts used for own requests | yes | after one-time consent | no account |
| Whose account otherwise | own | owner's, with owner's OK | owner's, with owner's OK |
| Approves purchases and outreach | yes, for own money | for own money only (new, §7.3) | never |
| Sets standing rules the agent follows everywhere | yes | about themselves only (new) | no |
| Mints invites | yes | yes, if the room allows it (new, default on for groups) | no |
| Sets room focus, outreach hours, read-only | yes | no | no |
| Removes people, deletes the room | yes | may leave | may be removed |
| Receives cards | in DM | in DM | in the group (they have no DM) or via the owner |
| Gets a profile and memory | yes | yes | yes, person-scoped, visible only in rooms they are in |

Mapping to code: `MemberRole = owner | member | guest` (built), `RoomService.accountsFor` (built), `approversFor` (built, returns owners), member-as-approver for own money (new), member rules about themselves (new), member-minted invites (partial: the route accepts any signed-in member today, no room switch).

**Why no admin.** Fo's `OWNER | ADMIN | MEMBER` exists because an org has IT. A couple does not. The one thing a second owner is needed for, a couple where both pay, is handled by co-owners (§7.3), not a new role.

---

## 6. Joining: how the assistant gets into a group

Five shapes, one mechanism each. All end in a `Room` with memberships.

### 6.0 Solo: the owner's own chat (built)

Before any group exists, the owner has a DM with the assistant and it is a complete personal assistant there. This is the Fo case and it is the base everything else sits on.

- The DM is an ordinary room of kind `dm` with one owner membership, created on demand (`RoomService.dmFor`). A group with one person in it is treated the same way: the agent is always addressed (`Runtime.addressed`).
- `accountsFor` returns the owner's own accounts with `needsApproval: false`. The gate still runs, so trust applies (threshold, pause, allow list), but there is no second person to ask: a purchase over the threshold opens a card in the same chat, and the owner's next message is the decision, exactly as in Fo.
- Everything the owner says there (people, routines, stores, rules) becomes person-scoped memory for them and agent-scoped rules, which follow the assistant into every room it is later added to. There is no training step; the DM is where the assistant gets to know them.
- The full catalogue is available: Gmail, Calendar, Drive, Sheets, Slack, the browser, shopping with a single-use card, calls, voice notes, documents and dashboards, MCP servers. Connections made here are the owner's and are what a guest's request later borrows.
- Schedules, watches, delegated tasks and the inbox all work with one person. The heartbeat is per room, so a solo user gets at most one proactive wake a day.
- No group vocabulary leaks in. The prompt's "Accounts:" line says the request may use their own accounts; no "I've asked X to OK that" is ever generated when requester and approver are the same person (`notice` is undefined in that branch of `decideGate`).

What a group adds for this person: their personal chat stays exactly as it was, and now also carries cards and private answers from the groups they are in (§8.5). Their inbox is one list across the DM and every group.

Gap (new): the web onboarding should start in the DM ("Hey, what should I call you, and what do you want help with?") and offer "add it to a chat" only after the first solo request has been answered. Today the first screen is the room list.


### 6.1 First run (built)

Boot with no agent creates the agent and one owner seat. In `LOCAL=1` the seat is "You" with no sign-in; with Clerk the first signed-in person claims it (`claim-owner` kv). There is no demo content, no sample room, no family. The owner's DM is created on demand the first time a card needs to go there.

### 6.2 Web room with an invite link (built)

Owner creates a room, states its focus in a sentence ("our Tahoe trip; keep the list and the money straight"), and mints a link: `POST /api/rooms/:id/invites` → `/#join=<token>`. Opening the link signs the person in as themselves (Clerk) or picks a local seat, and `POST /api/invites/:token/accept` adds them as a **member**. The join is handled both at boot and on hash change so a link pasted into an open tab works.

Gaps (new): tokens never expire and are reusable; there is no "who joined through this link" view; a token should carry an optional role (member by default, guest for a view-only share) and a use count.

### 6.3 Added to an existing chat on a channel (built for the transport, partial for identity)

On iMessage, WhatsApp, Telegram and Slack one Spectrum space is one room and one sender handle is one person (`src/channels/imessage.ts`, `startChannel`). The owner is recognised by phone number. Any other handle creates a `Person` with no sign-in and a **guest** membership. If that handle later signs up on the web with the same phone or email, the two records merge into one person and the membership becomes **member** (new: today they would be two people).

The first message the assistant sends in a new group is an introduction in plain words, generated from the room focus and the roles: who it works for, what it will do here, that it asks before spending or contacting anyone, and that anyone can ask it. `skills/group-chat-manners.md` carries the wording rules. Nothing else is posted until someone addresses it or a message plainly concerns the focus.

### 6.4 A couple (new flow on built parts)

Two people, both of whose money is at stake. Owner invites the partner; the partner accepts and is a member. Either can promote the other to **co-owner** from Settings (new). From then on each approves their own card and accounts, either may approve the shared pot if one is configured (§7.3), and both receive escalations. Rules set by either apply everywhere.

### 6.5 Family with someone who finds phones hard (built)

A member or guest marked `techComfort: low` switches the prompt for messages from them: one step at a time, their words for things, "ask what they see before saying what to tap", and anything needing a password, code or money is routed to a named person instead of being asked of them. Their cards never go to them; they go to the owner. This is the only place the product treats people differently, and it is per person, never per room kind.

### 6.6 Leaving and removing (partial)

A person who leaves or is removed keeps their person-scoped memory (it is about them) but loses visibility: `visibleToRooms` on anything they wrote in that room is unchanged, their membership is deleted, and any open card assigned to them in that room is dismissed, which ends the run that waited on it (built for dismissal, new for the removal route). Fo's `RevokeExternalReplyAccess` is the analogue.

---

## 7. Gates in a group

One policy point, `decideGate` in `src/runtime/gate.ts`. Every tool that contacts a third party, spends money or uses an account calls `ctx.gate` and returns `waitingOn` when not granted. Nothing else may decide.

### 7.1 Order of checks (built)

1. **Working hours.** Outreach (phone, sms, email) outside the room's hours in the owner's zone is held with an instruction to schedule it for the morning, naming the person as disclosed outreach. Community posts are exempt.
2. **Scheduled authorisation.** A run fired by a schedule is granted outreach to anyone the schedule's `disclosedOutreach` names, by name and method. Schedules created by anyone but the owner that disclose outreach are themselves gated first.
3. **Recorded approval.** Match on `sha256(gateKey)` bound to this run. A yes is consumed by the first action it lets through; a no sticks for the run. The gate key is the tool plus the payload that matters (number, text, amount, merchant), so a different text or amount asks again.
4. **Trust shortcuts, owner only.** Spending paused blocks all purchases. Purchases at or under `autoApproveUnderUsd` pass. Communities in `communityPostingAllowed` pass. `place_call` / `send_sms` on `autoAllow` pass.
5. **Open an item.** Assignee is the approver; kind is `guest_request` when the requester is not the approver and the request needs the approver's accounts. An identical open item (same gate key, same assignee) is reused, never duplicated. The group hears one line: "I've asked Alex to OK that." The approver gets a card in their DM. Items expire in three days.

### 7.2 Who approves what (built, with the new rows marked)

| Requester | Action | Account used | Approver | Where the card goes |
|---|---|---|---|---|
| owner | purchase ≤ threshold | owner's card | nobody | |
| owner | purchase > threshold, call, email to third party | owner's | owner | owner's DM (the gate still opens an item so the record exists) |
| member, consented | read own Gmail / calendar | own | nobody | |
| member, consented | send email as themselves | own, needs `sendAsMe` | the member | member's DM |
| member, consented | purchase | own card if connected, else owner's | whose card it is (new: today always owner) | that person's DM |
| member, not consented | anything needing an account | owner's | owner | owner's DM, group notice |
| guest | anything needing an account or money | owner's | owner | owner's DM, group notice |
| anyone | read another member's calendar for a shared plan | that member's | that member (`guard()` in `src/tools/catalog/google.ts`) | that member's DM |
| anyone | post to a community | agent's | owner, unless pre-approved | owner's DM |
| schedule | disclosed outreach | as disclosed | pre-approved | |
| schedule | undisclosed outreach | | owner | owner's DM |

### 7.3 Co-owners and shared money (new)

Today `approversFor` returns every owner and the gate takes the first. For a couple this is wrong in both directions: one partner's purchase should not need the other's yes, and a shared expense should be approvable by either.

- A room may have more than one `owner` membership.
- `TrustPolicy` moves from the agent to **per person**: each owner has their own threshold, pause and allow list. The agent-level policy becomes the default for the first owner only.
- A payment source is a vault entry owned by a person (`card:<id>`), or marked **shared** with a list of approver ids. `checkout_cart` picks the requester's own source if they have one, else the shared one, else the first owner's.
- The approver for a gated purchase is the owner of the payment source; for a shared source, any listed approver, first answer wins, and the twin-item check is by gate key across assignees so two cards resolve together.
- Escalations ("Sam's cabin booking is stuck") go to every owner; the first answer resolves.

### 7.4 What a yes means (built)

One action, exactly as asked. The approval record is bound to the run and the gate key. The resume pushes `[APPROVED] Alex answered yes` into the transcript, the model re-issues the same tool, and the gate honours the record once. Doing it twice, or changing the amount, asks again. The prompt tells the model never to say that no new permission is needed.

### 7.5 Declines (built)

A no sticks for the run. The tool result says so and tells the model to try another approach or stop. The group is told in one line without the reason unless the approver gave one.

---

## 8. Turn-taking in a group

Who the assistant answers, when, and how much.

### 8.1 Is this message for me (built)

`Runtime.handleMessage` in order:

1. Is it an answer to an open item assigned to this person, here or in their DM? Resolve the item and resume that run. Negation is read first ("no, I don't approve" is a no).
2. Is the agent addressed: named, a DM, or a group with one member? Yes → run.
3. In a group, is the message a request within the room's focus or the agent's purpose? One yes/no from the small model, skipped under 20 characters. Yes → run.
4. Otherwise record it as context and do nothing. The message is in the session so the next run sees it.

Fo's `RecordGroupContextTurn` is step 4. Instinct does not have groups.

### 8.2 Concurrency (built)

One session per room, one live run at a time. A message during a run is queued as a steer and applied on the next model turn, never rejected. Long work goes to `delegate_task`, which replies now and works in its own session, so the room stays free. A task reports to the room once when done and logs every line it told the room so a resume never repeats itself.

New: when two different people ask two unrelated things while a run is live, the second should start its own run once the first ends rather than being folded into the first as a steer. Rule: a steer from the **requester** of the live run steers; a message from anyone else that is itself a request is queued as a new run.

### 8.3 How it speaks (built, in the prompt and `skills/group-chat-manners.md`)

- One message per turn in a group. Address the requester by name when more than one person has spoken since the last reply.
- Plain words, short. Use the person's words for things.
- When waiting on an approval: one line, then stop.
- When a page was made: one line plus the link, never the content again.
- Never post "(nothing to report)". Timer, watch, heartbeat and event runs end with `stay_quiet` when nothing changed.
- Private answers go to the DM: anything about one person's accounts, money, health or a card they must answer.

### 8.4 Stepping in unasked (built)

If the room has a focus, the assistant may answer an un-named message that plainly concerns it. Outside the focus it waits to be named. A heartbeat per room runs at most once a day when there is standing work (open commitments, a due schedule), and stays quiet otherwise.

### 8.5 Personal requests in a group (partial)

People ask the assistant personal things wherever it happens to be. "Pip, what time is my dentist tomorrow?" in the trip chat is a request about the asker's own calendar. Rules:

- The request is served with the **asker's** accounts, by `accountsFor`, never the room's or the owner's (built).
- If the answer is about the asker alone and the room is a group, the assistant answers in the asker's DM and says one line in the group ("Sent that to you directly"). The prompt's "Private things stay in the room or chat where they were said" is the current rule; the new rule is the stronger one: **anything about one person's accounts, calendar, mail, money or health goes to their DM even when asked in a group**, unless they say "here is fine" (new; today the model decides).
- A member without a DM on that channel (a guest on iMessage who has never texted the agent's number) gets the answer in the group with the private parts left out, and an offer to text them directly (new).
- Memory written from a personal request made in a group is person-scoped and visible in the asker's DM and that room (§9.2), so the fact that they asked is not hidden from the group, but the content of their calendar never becomes room memory.
- The owner's own personal requests in a group follow the same rule. Being the owner does not make their mail public to the room.


---

## 9. Memory and privacy across people and rooms

The whole reason a group assistant is different. Rules, in order of precedence.

### 9.1 Scope (built)

Every memory has `scope ∈ agent | person | room` and `scopeId`.

- **agent**: the owner's standing rules and anything true everywhere ("always use metric").
- **person**: a fact about one person, `subjectPersonId` set ("Sam is vegetarian", "Jo finds Face ID confusing").
- **room**: a fact about the group ("the Tahoe trip is 14 to 17 Nov", "the house rule is shoes off").

### 9.2 Visibility (built)

`visibleToRooms` lists the rooms that may see a memory. The context assembler and keyword recall both filter by it (`MemoryService.visibleIn`, `recall`); there is no other read path.

Defaults when a memory is written:

| Said where | Scope | Visible in |
|---|---|---|
| In a group | room | that room |
| In a group, about a person | person | that room, plus the person's DM |
| In a DM | person | that DM only |
| In a DM, by the owner, as a rule | agent | every room |
| Derived by consolidation | same scope as its sources | union of its sources, never wider |

New: a person-scoped fact learned in one room becomes visible in another room only when the **subject** is in both and the fact is of a type the subject marked portable (dietary, accessibility, timezone, pronouns, addresses) or they say so. Default is not portable. This replaces today's all-or-nothing.

### 9.3 Who may write what (built, with the new row)

| Writer | During a run | Effect |
|---|---|---|
| anyone | `remember` as `observation` | raw, dated, consolidated nightly |
| owner | `remember` as `rule` | takes effect at once, every room |
| member about themselves (new) | `remember` as `rule` with `subjectPersonId = self` | takes effect at once, visible where they are a member |
| the subject of a fact | "forget that" | `retractedAt` set, even if someone else stated it |
| `Consolidator` | nightly | promote, merge, generalise, correct with date, retract one-time codes |

### 9.4 Profiles (built)

One profile per person and per room, re-derived on consolidation and on demand. A group prompt carries the room profile, the requester's profile and one line per other member. A member's profile is derived only from memories visible in rooms they are in, so a group profile never contains a DM fact.

### 9.5 Guests (built)

### 9.4b The owner's DM is the richest scope (built)

Most of what the assistant knows about the owner it learns in their DM, where it is person-scoped and visible there only, plus agent-scoped rules visible everywhere. When the owner adds a group, nothing about them moves into the group automatically. The group learns about the owner only from what the owner says in the group, from portable facts (§9.2), and from rules, which are behaviour, not facts. This is what makes it safe for the most active user to also be the most exposed one.


A guest has person-scoped memory like anyone else. It is visible in the rooms they are in and nowhere else. If they later sign up and merge (§6.3), nothing changes about visibility; they simply gain a DM.

### 9.6 Tests that pin this (built)

"What a person tells the agent privately does not surface in the group." "Rules take effect at once; observations wait for consolidation." "Consolidation promotes, corrects with date, retracts, and derives a profile." These stay green or the build is wrong.

---

## 10. Coordination primitives

What the assistant actually does for a group, as tools with records.

### 10.1 The ledger (built)

`track_commitment(owner, beneficiary?, title, due?)`. First nudge a day before due (two days out with no date), then daily, blocked after three overdue nudges, then one `decision` card to the owner: reassign, drop, keep nudging. Nudges are `follow_up` runs that either do the thing (if the agent owns it) or check in with the person in one line. The ledger is in every prompt for the room.

New: a nudge to a member goes to their DM, not the group, unless they have no DM (guest), in which case it is one line in the group naming them.

### 10.2 Questions (built)

`ask_room(question, options?)` opens an item assigned to nobody in particular; the first answer from any member resolves it. `ask_person(person, question)` opens an item in that person's DM. Both pause the run (`waiting`). The prompt forbids using these to ask for permission; action tools gate themselves.

New: `ask_room` with options becomes a poll when more than two members: each member's answer is recorded, the run resumes when all have answered or after a deadline, and the result is the tally.

### 10.3 Shared pages (built)

`write_document` with list lines produces a page at `/d/:id` that the room ticks, claims (per-person colour), adds to and filters, with progress and a done stamp; state is `DocState {checked, claimed, added}` on the artifact, patched by whoever is signed in. `publish_dashboard` for numbers that change. The prompt's rule: make a page when the chat will act on it over time or when the content is for someone outside the message; stay in the chat for an answer. The chat shows a preview card for any `/d/` link.

New: page edits are events. A claim or tick posts an `event` run with the change; the assistant updates the ledger when a claim is a commitment ("Sam claimed: bring the stove") and otherwise stays quiet.

### 10.4 Calendars across people (built)

Google tools use `vault.use("google")` for the account owner decided by `accountsFor`; reading another member's calendar asks them (`guard()`); `freeSlots()` is a pure function over the returned busy blocks. New: `find_time(people[], window)` as one tool that asks each member for read access once, then proposes slots to the room.

### 10.5 Money (partial)

`checkout_cart` gates by amount against the payer's trust, mints a single-use card via the payments provider into the vault, and records the purchase. A cost split is a page today (a list with amounts). New: a `split` artifact kind with who paid, who owes, and settle-up lines, updated by `record_expense`; a dashboard view of the running total.

### 10.6 Schedules and watches (built)

`schedule_action` with `authorization.disclosedOutreach` and `premise`; `watch_for(condition, action, everyHours)`. A schedule made by a member that discloses outreach is gated to the owner first. A premise check pauses a schedule when the premise no longer holds. Timer runs stay quiet unless something changed.

### 10.7 Delegated tasks (built)

`delegate_task(title, instructions)` for anything with many searches or calls. The room gets an answer now; the task reports once; `steer_task` passes a note in. Tasks are listed in the prompt with progress and what was last said.

---

## 11. Channels

One room is one thread on one channel; one person is one record across channels.

- **Web** (built): rooms, DMs, invites, pages, Settings. Deliveries stream over `/api/deliveries/watch` with a boot id so stale tabs reload.
- **iMessage, WhatsApp, Telegram, Slack** (built via Spectrum, `CHANNELS` env): a space is a room, a handle is a person, outbound text is flattened by `plainText()`; pages are sent as links. Cards for guests are one line in the group ("Alex, OK for me to call the plumber? yes/no") because there is no DM on these channels unless the person has one with the agent's number.
- **Email** (partial): the agent's own mailbox (AgentMail or Resend) receives on tick; a reply token in the subject maps a reply to a room (new; Fo's `ResolveReplyToken`).
- **Phone** (partial): Vapi for calls, Twilio for SMS, both as the agent's own number. A call summary is posted to the room that asked.

Identity merge (new): a person with the same E.164 phone or email on two channels is one person. Merge keeps the oldest id, repoints memberships and memories, and logs an `identity_merged` event. Nothing merges on display name alone.

---

## 12. The assistant's own identity

Taken from Fo: the assistant has its own email, phone number and payment card, funded by the owner. This is what lets it serve a guest without using anyone's account, and what lets a vendor reply to it. Rules:

- Email from the assistant comes from its own address and says so. Email as a member comes from their Gmail only with `sendAsMe` on, and still asks per send.
- Calls and texts come from the assistant's number, disclosed as the assistant working for the owner (`skills/outreach-rules.md`).
- Purchases use a single-use card per purchase; the funding source is the payer's.
- Credentials never enter a prompt, a transcript, an event or an API response. Hands get them inside `vault.use` only. The prompt sees service names.

---

## 13. Settings surface

What each person sees and may change. Built unless marked.

| Scope | Setting | Who |
|---|---|---|
| Agent | name, soul, instructions | owner |
| Agent (→ per person, §7.3) | spending threshold, pause, auto-allow tools, pre-approved communities | each owner for their own |
| Person | pronouns, timezone, addresses, tech comfort, `sendAsMe`, connected services, MCP servers and connectors | that person |
| Room | name, focus, outreach hours, read-only, who may mint invites (new), co-owners (new) | owner |
| Membership | consent to use own accounts | that person, once |
| Inbox | Need your input / On radar / Last activity, filtered to items assigned to me | each person |

---

## 14. Invariants

These are the rules from `CLAUDE.md` restated for the group case. A change that breaks one is a bug, not a trade-off.

1. No claimed action without a stored tool call with evidence. Footers from `buildFooter`; `integrityNote` corrects a reply that claims otherwise.
2. Every third-party contact, spend or account use goes through `Runtime.gate`. The approver is decided by the gate from roles and account ownership, never by the model.
3. An approval is one action, bound to a run and a gate key, consumed once.
4. Memory is read only through `visibleIn` or `recall`. Scope never widens in consolidation.
5. The agent writes only observations during a run; rules from the owner (and members about themselves) are the exception.
6. Events are append-only with a per-session seq.
7. Silence is an outcome. No timer run posts when nothing changed.
8. Credentials never leave the vault except inside `vault.use`.
9. A DM fact never appears in a group. A group fact never appears in another group.
10. A low-tech-comfort person is never asked for a password, code or money.

---

## 15. Building it from scratch

If the branch did not exist, this is the order, with what to reuse from it. Each milestone is shippable to one real group.

**M0: a personal assistant for one person (1 week).** Person, Room (a DM), Session, Run, append-only events, scripted-model tests, the gate with trust for one owner, web chat. This is Fo's shape and it must be good on its own; a solo user should never notice that groups exist. Reuse: `src/core/types.ts`, `src/runtime/runtime.ts` loop, `src/runtime/gate.ts`, `src/store`. Skip: everything with a key.

**M1: a second person (1 week).** Group rooms, `accountsFor`, `approversFor`, attention items assigned to someone else, DM per person, guest flow through the owner, the group notice line, personal requests in a group routed to the asker's DM. Tests: guest served with the owner's card and resume on yes; a different amount asks again; a no sticks. Reuse as is.

**M2: invites and channels (1 week).** Invite tokens with role, expiry and use count. Spectrum adapter with handle → person and the identity merge. The introduction message. Reuse: `src/channels/web.ts` invite routes, `src/channels/imessage.ts`; add the merge.

**M3: memory with scope (1 week).** FTS5, aliases, scope and visibility, `remember`, nightly consolidation, profiles, "forget that". Tests from §9.6. Reuse: `src/memory/*` as is; add portable types.

**M4: coordination (2 weeks).** Ledger with nudges and escalation, `ask_room` / `ask_person`, polls, shared pages with state and page-edit events, schedules with disclosed outreach, watches, heartbeat, delegated tasks. Reuse: `src/care/commitments.ts`, `src/scheduler/scheduler.ts`, `src/tasks/tasks.ts`, `src/channels/artifacts.ts`, `src/runtime` task code.

**M5: the agent's own hands (ongoing, keyed).** Own email, own number, single-use card, Google per person, MCP per person. Reuse: `src/tools/catalog/*`, `src/tools/providers/*`, `src/tools/hands.ts` fakes so everything stays testable offline.

**M6: couples (1 week).** Co-owners, per-person trust, shared payment source, first-answer-wins approvals. New code, mostly in `rooms.ts`, `gate.ts`, `shopping.ts`.

What we would not build again: family-specific roles (decider, cared_for, patient mode), a seeded demo world, a training step, an approve button. What we would build differently from day one: trust per person rather than per agent, and the identity merge before the first channel adapter.

---

## 16. Test scenarios

Each is one sentence a test asserts. Built ones are in `test/`; new ones follow the same `groupWorld` fixture (Alex owner, Sam member consented, Jo member low tech, Riley guest, room "Tahoe trip").

Built:
- A guest's request that needs the owner's card opens a card in Alex's DM, the group hears one line, and the yes finishes the job in the group.
- A consented member's own request uses their own account and asks nobody.
- A second message during a live run steers it instead of failing it.
- An approval for one amount does not cover a different amount.
- "No, I don't approve" is a no.
- Outreach at 11pm is held and scheduled for the morning as disclosed outreach.
- A schedule made by a member that names someone to call is gated to the owner first.
- What Jo tells the agent in her DM does not appear in the Tahoe trip room.
- A rule from Alex applies at once in every room; an observation waits for consolidation.
- A timer run with nothing new stays quiet and delivers nothing.
- A delegated task replies to the room once and a resume does not repeat what was already said.
- A list document is a tickable page whose state is shared.
- Low tech comfort switches the prompt to one step at a time and routes anything needing a code to a named person.

New:
- Two owners: Sam's purchase on Sam's card asks Sam, not Alex.
- Solo: with no group rooms, Alex's purchase over the threshold opens a card in Alex's own chat and Alex's next message decides it; no notice mentions anyone else.
- Solo: a rule Alex sets in the DM before any group exists applies in the first group created afterwards; a fact Alex stated in the DM does not.
- Sam asks "what's on my calendar tomorrow" in the trip room: the answer goes to Sam's DM using Sam's account, the group hears one line, and no calendar content is written as room memory.
- The owner asking about their own mail in a group gets the same DM routing as anyone else.
- A shared payment source: either owner's yes resolves both cards.
- Riley texts from a number that later signs up with the same number: one person, one DM, role becomes member.
- A fact Sam marks portable in the trip room is visible in the dinner room; an unmarked one is not.
- Sam says "forget that" about a fact Alex stated about Sam: it is retracted everywhere.
- A poll with three options resolves when all four members answer or at the deadline, with a tally.
- Sam claims "bring the stove" on the packing page: a commitment appears in the ledger with Sam as owner; ticking an item posts nothing.
- A request from Jo while Alex's run is live starts a new run after, not a steer into Alex's.
- Removing Riley dismisses Riley's open card and ends the run that waited on it.
- A member with no consent asking to read their own calendar gets the consent question, once.

---

## 17. Open decisions

- **Store.** The branch is SQLite in one file; the deployed service was Postgres. The model above is store-agnostic; pick before M2 because channel adapters make the service long-running on a host.
- **Multiple assistants in one room.** Today a room has one agent. If two members each have their own, the room's agent is the one that was added and the other stays in its owner's DM. Agent-to-agent handoff is out of scope until a real group asks for it.
- **Embeddings.** Keyword recall misses paraphrase (Instinct's "pazta" probe). Add embeddings only when a real group hits it.
- **Sandbox per task.** Hands run in-process. Instinct leases a sandbox per task; ours would be the vault boundary first, a process boundary second.
- **Guest cards on channels.** A guest on iMessage has no DM with the agent unless they text its number. Until the agent has a number, guest approvals that need the guest (rare) go in the group.
- **Where onboarding starts.** Proposed: in the owner's DM, solo, with "add it to a chat" offered after the first answered request. The alternative is a room-first screen, which is what the branch has today and which makes the product look like a group tool to a person who came for themselves.

A list of 100 use cases by group shape, each tied to the primitive it exercises, is in [use-cases.md](use-cases.md).

Use cases and narrated scenarios per group shape, with the evidence behind each, are in [use-cases.md](use-cases.md).
