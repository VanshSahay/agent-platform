# Circle

A personal agent that lives in the group chats people already have: the family thread, the friends' group, the neighbourhood chat. One person trains and deploys it; everyone in the chat gets help without signing up for anything. It coordinates, follows through, and asks the right person when a decision, an approval or a private detail is needed.

This is a from-scratch build. Its design comes from three sources: a reverse engineering of Wajo's Fo ([docs/research/wajo-fo-build.md](docs/research/wajo-fo-build.md), [docs/research/wajo-fo.md](docs/research/wajo-fo.md), [docs/research/wajo-fo-client-report.md](docs/research/wajo-fo-client-report.md)), the public teardown of Instinct's memory, and what we wanted that neither does. The design note is [docs/design.md](docs/design.md).

## What it does

**One assistant, general by default.** It is the owner's personal assistant: finding, booking, fixing, reminding, coordinating, looking things up, device help. When a circle adds it to a chat they say what they mostly need from it there; those priorities come first in that chat and it may step in on them without being named, while everything else people ask stays its job. There is no training step: the owner's private chat is an ordinary thread, and whatever they tell it there (people, routines, stores, standing rules) is noted and applies everywhere. Settings shows every chat it is in with that chat's priorities.

**Lives in the group.** The agent is added to an existing chat and answers when named, when a message is plainly a request within its purpose (a cheap yes/no from the small model), or when a question it asked is answered. People who never signed up are guests: they ask by name and get served; anything that needs the owner's accounts or money produces a card in the owner's own chat ("Uncle Wei asked in Family… OK to call Lee's Repairs?"), the group hears "I've asked Ellie to OK that", and the owner's yes finishes the job in the group.

**Looks after someone, as a group.** A room can mark a member as cared for and others as deciders. Every real-world item becomes a tracked responsibility with an owner and a time: the appointment, the ride, the repair visit, the prescription. The agent nudges owners the day before, reports in one line when things close or slip, and routes care decisions (including a call or text on the cared-for person's behalf) to a decider before the owner; money always stays with the owner. A responsibility nobody confirms after three reminders is escalated once as a decision card (reassign, drop, keep nudging). When the cared-for person asks directly, the agent switches to patient mode: one step at a time, their words, and it says who it will ask before asking. It teaches technology one step at a time and remembers where the person got stuck last time.

**Is resourceful.** For "find a Mandarin-speaking handyman" it keeps a plan with an approach ladder: search, ask the group, call candidates, ask a local community (Reddit or Rednote, only with a yes to the exact text), ask a specific person. When an approach stalls twice the next one is activated and the agent is told. It compares what it found and lets the requester choose before booking.

**Earns trust one notch at a time.** Every write asks first. The owner can allow specific tools, set a dollar amount under which purchases pass, pause spending, and pre-approve communities. Contacting a third party is disclosed (who, how, why); outside 8am to 8pm it is held until morning. Scheduled work carries the authorisation it was given and re-checks its premise before acting. Every tool call is stored with evidence; the reply's footer ("— 3 steps · 2 verified: Searched the web, Made a call") comes from those records, and a reply that claims an action with no record is corrected.

**Knows when to say nothing, and hands off long work.** On a timer, a watch or an app event the agent stays quiet unless something changed; silence is a recorded outcome, not a message. Long errands go to a task agent in its own session, so the chat answers now and the task reports once when done. Alert rules ("tell us when the pharmacy confirms") check every few hours and speak only when the condition holds. When a site needs someone's login, a sign-in card with a real browser opens inside the chat for that person; they sign in, press Done, and the assistant browses that site as them from then on. Members' credentials sit in an encrypted vault the model never sees. Long chats are folded into a running summary.

**Remembers the right things in the right places.** The agent only writes dated observations during a run; a background pass promotes them into typed memories, merges duplicates, rewrites corrected facts with their date, retracts what was taken back, and derives a short profile the agent reads first. What a group says stays with that group. What someone tells the agent privately never surfaces in a group.

## What it looks like

| | |
|---|---|
| ![Empty thread with the composer centred and one card mined from the ledger](docs/screens/empty-light.png) | ![A thread with the Why? drawer showing the plan, tool records and timeline](docs/screens/family-why.png) |
| ![Settings with trust controls and the chats it is in](docs/screens/settings.png) | ![Memory page with derived profiles and grouped notes](docs/screens/memory.png) |

## Run it

```bash
bun install
cp .env.example .env     # add OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) and whatever services you have
SEED_DEMO=1 bun run start
# open http://localhost:3000
```

Testing it locally, two ways:

- **Without sign-in (quickest).** Leave `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` empty. The server binds `127.0.0.1` and the top-right "You" picker lets you act as any seeded person: Ellie (owner), Ben (can decide), Mum (cared for), Uncle Wei (guest). Ask Pip for something in Family as Wei, then switch to Ellie to answer the card.
- **With Clerk.** Set the Clerk keys and `MASTER_KEY`, add `http://localhost:3000` to `CLERK_AUTHORIZED_PARTIES`, start with `SEED_DEMO=1`, and sign in. The first account to sign in becomes the owner of the seeded circle (Ellie's seat), so the family is yours. Later sign-ins become new people you can add to rooms.

The database is one file at `DB_PATH` (default `data/circle.sqlite`); delete it to start over.

What gets wired depends on `.env`:

| Setting | What it turns on |
|---|---|
| `OPENROUTER_API_KEY` | The model, through OpenRouter: `z-ai/glm-5.3` for the agent and `z-ai/glm-5.3-flash` for labels, premise checks and the memory pass. Override with `MODEL` and `MODEL_SMALL` (Claude ids work too: `anthropic/claude-opus-5.5`). |
| `ANTHROPIC_API_KEY` | The model directly from Anthropic: Claude Opus 5.5 and Haiku 5.5. |
| `PROJECT_ID`, `PROJECT_SECRET` | iMessage through Photon Spectrum. Each iMessage chat becomes a room; senders become people; the owner is recognised by the phone number on their person record (`PATCH /api/people/:id {phoneE164}`). |
| `BROWSERBASE_API_KEY` | The `browse_page` tool runs in a cloud browser. Without it, pages are read as text through Jina Reader. |
| `BRAVE_API_KEY`, `SEARCH` | `web_search` uses Exa's public endpoint by default (no key; the channel [Agent Reach](https://github.com/Panniantong/agent-reach) recommends, and it answers "Mandarin-speaking handyman San Jose" with names and phone numbers). A Brave key switches to Brave; `SEARCH=duckduckgo` uses the keyless scrape. |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Sign-in on the owner UI; every API call is made as the signed-in person, and each route checks that person against the room, agent or item it touches (see the API section). Without these the API trusts the "You" picker, so the server binds to loopback only. |
| `HOST`, `PORT` | Where to listen. `HOST` defaults to `127.0.0.1` without Clerk and `0.0.0.0` with it; a non-loopback host is refused unless Clerk and `MASTER_KEY` are both set. |
| `MASTER_KEY` | Encrypts members' credentials in the vault. Required off loopback. |
| `EVENT_TOKEN` | Shared secret for `POST /api/events` and `POST /api/tick` (`Authorization: Bearer …`). Without it, only a signed-in agent owner may call them. |

Without a model key the server still boots and the agent only acknowledges messages, so the UI can be explored.

Offline, with no key, the whole runtime runs against a scripted model:

```bash
bun run demo    # the handyman errand in a family chat, end to end
bun test        # 85 tests across the run loop, gates, care, planner, memory, timers, hands, web api, channels, eval
bun run eval    # six family errands played against the configured model, graded on stored state
bun run typecheck
```

## Layout

```
src/core        types, ids, clock
src/store       SQLite schema and repositories (bun:sqlite, FTS5 for memory)
src/model       ModelClient; Anthropic adapter; scripted model for tests
src/agent       agent spec defaults; system prompt assembly
src/memory      memory service (scopes, visibility, recall); nightly consolidation
src/rooms       rooms, members, roles, whose accounts a request may use
src/inbox       attention items (needs you) and the three home tabs
src/care        the responsibilities ledger and its nudges
src/planning    plans with an approach ladder and stall handling
src/tools       the tool registry (labels, gates) and the "hands" interfaces with fakes
src/runtime     the run loop: events with cursors, steering, gates, resume, footer
src/scheduler   schedules with authorisation and premise checks, staged outreach, heartbeat
src/channels    web server: JSON API, watch stream, owner UI
skills/         markdown procedures the agent reads when a task matches
web/            the owner's page: inbox, chat, memory, ledger
test/           offline tests with a scripted model and fake hands
```

## API in one screen

```
POST /api/rooms/:id/messages        {personId, text, dedupKey}   -> {run, session}
GET  /api/sessions/:id/watch?after=N  NDJSON: {event} lines, then {ping} with the cursor
GET  /api/inbox?personId&agentId     {needsYou, radar, inFlight, activity}
POST /api/attention/:id/resolve     {answer}                     resumes the waiting run
GET  /api/schedules | POST /api/schedules | POST /api/schedules/:id/pause
GET  /api/commitments?roomId
GET  /api/memory?agentId | POST /api/memory | DELETE /api/memory/:id | POST /api/memory/consolidate
PATCH /api/rooms/:id                 {focus, name, outreachHours}  the chat's priorities for the assistant
GET  /api/suggestions?agentId        "want me to…" cards mined from the ledger and schedules
POST /api/commitments/:id            {status}                     mark a responsibility done, dropped, blocked
GET  /api/profiles?agentId           derived summaries per scope
GET  /api/tasks?roomId               delegated tasks with progress and what they told the room
POST /api/events                     {source, summary, detail?, roomId|agentId, dedupKey}  a connected app's event
GET|POST /api/people/:id/credentials {service, secret}  own credentials into the vault (names only come back)
POST /api/tick                       run the scheduler once
```

Who may call what, when sign-in is on (every route is denied unless a rule allows it):

```
public         /, /health, static files, /api/me (null when signed out)
signed in      /api/state (only the rooms, agents and people you share a room with), GET/POST /api/people, POST /api/agents
self           PATCH /api/people/:id, /api/people/:id/credentials
room member    messages, sessions (events, watch), runs (get, stop), POST /api/commitments/:id;
               /api/tasks, /api/schedules, /api/commitments lists are filtered to your rooms
room owner     POST /api/rooms/:id/members, POST /api/schedules, /api/schedules/:id/pause
agent owner    PATCH /api/agents/:id, POST /api/rooms, /api/memory (all), /api/profiles
agent reach    /api/inbox, /api/suggestions (owner or a member of one of its rooms; radar and activity filtered to your rooms)
assignee       /api/attention/:id/resolve, /dismiss
machines       POST /api/events and /api/tick: `Authorization: Bearer <EVENT_TOKEN>`, or a signed-in agent owner
```

`POST /api/people` always assigns the id; `POST /api/schedules` always records `user_requested` with no disclosed outreach. Bodies must be JSON objects sent as `application/json`.

## Starting a fresh repository

This tree shares no code with what came before it. To move it into a brand-new repository with clean history:

```bash
git checkout --orphan main && git commit -m "Circle" && git remote set-url origin <new-repo-url> && git push -u origin main
```

## Status

Built: one general assistant with per-chat priorities; rooms with roles and guest serving; patient mode and decider-first care approvals; escalation of stuck responsibilities; proactive suggestions; the run loop with gates, steering and resume; quiet outcomes; task agents with delivery state; watches (alert rules); app events as triggers; an encrypted credential vault; sign-in cards inside the chat (Browserbase live view); session compaction; plans with the approach ladder; the responsibilities ledger with nudges; schedules with authorisation, premise re-check and working-hours holds; memory with scopes, privacy and consolidation; the owner UI with Clerk sign-in; the iMessage channel through Photon Spectrum; the browser hand through Browserbase; the model through OpenRouter (GLM 5.3) or Anthropic; web search through Exa and page reading through Jina Reader; an eval harness.

Internet reach: `web_search` and `browse_page` are real (Exa and Jina Reader, both keyless; Brave and Browserbase when keyed). The agent follows `skills/internet-reach.md`, adapted from Agent Reach's skill to the two tools it has; it says plainly which platforms it cannot read yet.

Not yet: telephony (calls in Mandarin need a voice vendor), reading or posting on Reddit and Rednote (both need a logged-in session); WhatsApp and Telegram channels; payments; voice chat. Each is an interface in `src/tools/hands.ts` or `src/channels/` with a fake you can swap. Postgres is not used: the store is one SQLite file.
