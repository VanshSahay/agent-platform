> **Historical (pre-refactor, October 2026).** Describes the platform before the rebuild; kept for the record. The current design is in docs/refactor-design.md and the README.

# The family agent, on this platform

A plan for "an agent that helps your parents stay independent while keeping the family connected", built from what the
platform already does. Written 2026-10-07 against commit `baf58f3`.

## What exists today that this needs

| Family need | Platform piece | State |
|---|---|---|
| One agent in the family group *and* in each person's private chat | Rooms: one shared room per group chat, one private room per person; the same agent, separate memory and work per room | Built, tested over iMessage/Telegram/WhatsApp fakes |
| "Mom owns Mom's agent" | Every agent has an owner; each message is tagged owner / teammate / guest; a guest can't use the owner's accounts or money | Built |
| Private things stay private | Memory scopes: a person's private memory is used only for their own requests and never shown for someone else's, even in a group | Built this week |
| Coordination: who does what, by when | Tasks with owners, approvals that only the right person can give, waits, follow-ups that fire only if nobody replied | Built |
| Appointments, reminders, email, calendar | Google Calendar/Gmail tools, reminders in the person's time zone, follow-up reminders that check for a reply first | Built, live-tested |
| Rides, errands, decisions in a group | Polls, RSVPs, shared lists, group orders, "who hasn't answered" | Built |
| Proof that something happened | Job contracts and claims: every reported action must be backed by our own records | Built |
| Photos and voice notes from a phone | Described / transcribed on arrival, stored, readable later | Built (model needed) |
| Web and websites | Search with citations, page reading, a real browser for sites without APIs | Built, live-tested |
| Voice | Inbound phone turns only (Twilio) | Partial |
| Paperwork, doctor visits, daily check-in, weekly digest, story interviewer, friendship signal | Skills on Milo 1.5.0: docs.find, story.prompt, people.quiet plus procedures over existing tools | Built 2026-10-07 |

## What's missing, in build order

### 1. The sharing panel (built, AC-F2)
A per-person page, phone-sized, in plain words:

- Share my appointments with the family ✓
- Share my medication schedule with: Sarah ✓ · Tom ✕
- Let the agent tell Sarah if I miss something important ✓
- Share what I talk about with the agent ✕
- Share money matters ✕

Each line maps to a memory scope and an event rule the platform already enforces. The agent reads the panel before saying
anything in a group. Default: nothing shared until the person says so.

### 2. The private → shared bridge (built, AC-F1)
In Mom's private chat, when a task needs the family ("she'll need a ride"), the agent asks first:
"Want me to ask Sarah and Ellie who can drive you?" Only on yes does it post to the group, and only the agreed facts (day,
time, place), never the reason or the conversation. One new step in the planner: a `bridge` side effect that needs the owner's
OK and carries an explicit allow-list of facts.

### 3. Objectives with steps (built: objective.create / update / status, AC-F5)
Today a run is one request. "Mom needs cataract surgery" is weeks of steps: appointment → insurance → transport → pre-op →
surgery → pickup → follow-up. Build an objective record with ordered steps, each with owner, state, next action, wait and
escalation. The group sees progress; each step uses the tools that exist (calendar, email, reminders, polls, browser).
This is the Loopback-style coordination runtime, scoped to one family objective.

### 4. Social catalyst, carefully (built as the live-well skill: private chat only, a weekly standing job the person asks for, friends via the bridge)
Proactive suggestions to the older adult only, driven by their calendar, memory and the people they've mentioned:
"Linda and Mary are both free Saturday — lunch?" Rules: at most a few a week, never to the family without the person's say,
easy to say "less of this". The routines engine exists; the judgment layer (when a nudge is welcome) is new and should be
tested with real people before it goes wide.

### 5. Family story store (built: story.add / story.search, AC-F4)
Photos, voice notes and the stories around them, with who/when/where and provenance, searchable by whoever the owner allows.
Prompts like "Grandma, Ellie asked about Hangzhou — want to tell us?" come from the same routine engine. Media handling and
room-scoped files exist; the store, its permissions and the search over it are new.

### 6. Scam check (built: scam.check, AC-F3)
"Is this real?" for a text, a number or a link: look it up, apply simple rules (urgency, payment by gift card, caller ID
spoofing), give a plain verdict with reasons, and offer to alert a chosen family member. Untrusted-content handling exists; the
check flow and the alert rule are new.

### 7. Voice and calls
The older adult's main interface may be a phone call. Outbound calls on their behalf (pharmacy, insurer) and a voice loop on
the same agent are the largest technical gap, and should come after 1–3 prove the product.

## Social intelligence from 小红书
Reading posts (itineraries, tips, reviews) adds a layer of "what people actually do" to trip and local-life planning: the
`xhs.search` and `xhs.insights` tools pull posts through a logged-in account and distil consensus, warnings, must-book items
and hidden gems with sources. For families it's the trip-planning and "find Mom a mahjong group nearby" angle. Posting on a
person's behalf (e.g. asking for a reservation swap) is possible but goes through approval and carries account risk; it is
opt-in per person.

## How to validate without fooling ourselves
- One real family group over iMessage for two weeks, with a weekly check-in on three questions: did it save coordination time,
  did anyone feel watched, did it do anything wrong.
- Every reported action already has evidence in our records; the review looks at the misses and the near-misses, not at scores.
- No scenario evals written to pass. Real transcripts, read by a person.
