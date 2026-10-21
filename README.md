# Circle

A personal assistant that lives in the chats people already have: you and your partner, a group of friends, the trip chat, the family thread, the people on your street. One person sets it up and everyone they bring in gets help without signing up for anything. It coordinates, follows through, and asks the right person when a decision, an approval or a private detail is needed.

This is a from-scratch build. Its design comes from three sources: a reverse engineering of Wajo's Fo ([docs/research/wajo-fo-build.md](docs/research/wajo-fo-build.md), [docs/research/wajo-fo.md](docs/research/wajo-fo.md), [docs/research/wajo-fo-client-report.md](docs/research/wajo-fo-client-report.md), [docs/research/wajo-fo-search.md](docs/research/wajo-fo-search.md)), the public teardown of Instinct's memory, and what we wanted that neither does. The design note is [docs/design.md](docs/design.md).

## What it does

**One assistant, general by default, for you and the people around you.** It is the owner's personal assistant: finding, booking, fixing, reminding, coordinating, looking things up, device help. Each chat it is added to says what it mostly needs from it there (the trip, the flat, the dinner rota); those priorities come first in that chat and it may step in on them without being named, while everything else people ask stays its job. There is no training step: the owner's private chat is an ordinary thread, and whatever they tell it there (people, routines, stores, standing rules) is noted and applies everywhere. Settings shows every chat it is in with that chat's priorities.

**Multiplayer.** A room is a chat with people in it. The owner makes one and shares an invite link; whoever opens it joins as a member with their own identity, their own private chat with the assistant, and, once they say so, their own accounts for their own requests. People who never signed up are guests: they ask by name and get served through the owner. Anything that needs the owner's accounts or money produces a card in the owner's own chat ("Riley asked in Tahoe trip… OK to call Lakeview?"), the group hears "I've asked Alex to OK that", and the owner's yes finishes the job in the group. What a group says stays with that group; what someone tells the assistant privately never surfaces in a group.

**Keeps the ledger.** Every real-world item becomes a tracked responsibility with an owner and a time: who books the cabin, who drives, who lets the plumber in. The assistant nudges owners the day before, reports in one line when things close or slip, and after three unanswered reminders escalates once as a decision card for the owner (reassign, drop, keep nudging). With someone who is not comfortable with technology it goes one step at a time, in their words, and remembers where they got stuck last time.

**Is resourceful.** For "find a plumber who speaks Mandarin" it keeps a plan with an approach ladder: search, ask the group, call candidates, ask a local community (Reddit or Rednote, only with a yes to the exact text), ask a specific person. When an approach stalls twice the next one is activated and the agent is told. Search steps are labelled with their query, the model's one-line narration between steps stays in the thread, and it compares what it found and lets the requester choose before booking.

**Earns trust one notch at a time.** Every write asks first. The owner can allow specific tools, set a dollar amount under which purchases pass, pause spending, and pre-approve communities. Contacting a third party is disclosed (who, how, why); outside 8am to 8pm it is held until morning. Scheduled work carries the authorisation it was given and re-checks its premise before acting. Every tool call is stored with evidence; the reply's footer ("— 3 steps · 2 verified: Searched: plumber mandarin san jose, Made a call") comes from those records, and a reply that claims an action with no record is corrected. An approval covers one exact action; doing it again asks again.

**Knows when to say nothing, and hands off long work.** On a timer, a watch or an app event the agent stays quiet unless something changed; silence is a recorded outcome, not a message. Long errands go to a task agent in its own session, so the chat answers now and the task reports once when done. Alert rules ("tell us when the host confirms") check every few hours and speak only when the condition holds. When a site needs someone's login, a sign-in card with a real browser opens inside the chat for that person; they sign in, press Done, and the assistant browses that site as them from then on. Members' credentials sit in an encrypted vault the model never sees. Long chats are folded into a running summary, and the chat search finds any room by what was said in it.

**Remembers the right things in the right places.** The agent only writes dated observations during a run; a background pass promotes them into typed memories, merges duplicates, rewrites corrected facts with their date, retracts what was taken back, and derives a short profile the agent reads first.

## The tools

Eighty tools, the same catalogue Fo's client knows, each recorded with evidence and gated the same way as everything else (anything that contacts someone, spends money or uses another person's account asks first):

| Family | Tools |
|---|---|
| core | plan, web_search, browse_page, connect_account, find_person, ask_room, ask_person, wait_for_user_input, place_call, send_sms, post_community, read_community_replies, compare_options, remember, search_memory, schedule_action, track_commitment, update_commitment, request_purchase, stay_quiet, delegate_task, update_task, steer_task, watch_for |
| google | list_events, create_calendar, check_availability, find_mutual_availability, create_event, update_event, delete_event, move_events, search_emails, get_email_content, label_email, archive_email, remove_email_label, send_email_as_user, find_files, list_in_folder, get_metadata, share, create_form, get_spreadsheet, update_spreadsheet, search_user_spreadsheets, get_slide_thumbnail, append_slides, replace_slide, delete_slide |
| operator | get_connect_link, request_call, list_tasks, get_task, list_scheduled_actions, cancel_scheduled_action, update_task_status, browser_use, connector_call, get_current_time, search_tools, publish_dashboard, read_dashboard, list_past_sessions, get_session_transcript, load_workspace_context, present_files, write_document, generate_image, analyze_image |
| knowledge | load_soul_document, email_load_unprocessed, email_load_thread, slack_load_recent, slack_load_aggregates, slack_search_messages, whatsapp_load_recent, whatsapp_load_conversation, whatsapp_get_summary |
| shopping | search_products, add_to_cart, view_cart, remove_from_cart, checkout_cart, save_address, list_saved_addresses, delete_saved_address |
| voice, calls, contacts, email, mcp | text_to_speech, register_pronunciations, list_sms_groups, add_contact, send_agent_email, mcp_call |

What each needs: Google tools need `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server and each person connecting their account under Settings → Connections; the assistant's own mailbox needs AgentMail (send and receive) or Resend (send only); Slack a token per person; MCP servers and HTTP APIs are added per person in Settings; calls need Vapi and SMS Twilio; voice notes ElevenLabs; images any OpenRouter image model; checkout cards Stripe Issuing. Without a service, its tools say so and the agent hands out a connect link. Documents, dashboards, images and voice notes open at `/d/:id`. A document is a small shared app, not a static page: every list line is a tappable item, ticks and "who brings it" are shared with the whole chat, anyone can add a line, and the page keeps the product's look with a progress bar, filters and a stamp when everything is done.

## Run it

```bash
bun install
cp .env.example .env     # add OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) and whatever services you have
bun run local            # sign-in off, loopback only
# open http://localhost:3000
```

On the first run it creates the assistant (`ASSISTANT_NAME`, default Pip) and the seat of its owner. Make a room, then copy its invite link from the Rooms list or Settings and send it to the others; each person who opens it joins as themselves.

Testing it locally, two ways:

- **Without sign-in (quickest).** `bun run local` (sets `LOCAL=1`, which blanks the Clerk, iMessage and `HOST` settings for that process whatever `.env` holds). The server binds `127.0.0.1` and the top-right "You" picker lets you act as anyone in the database: start as You, add people with "+ Add" or open an invite link in the same browser and give a name, then switch between them to play both sides of a conversation.
- **With Clerk.** Set the Clerk keys and `MASTER_KEY`, add `http://localhost:3000` to `CLERK_AUTHORIZED_PARTIES`, start, and sign in. The first account to sign in becomes the owner; everyone else arrives through an invite link and signs in as themselves.

The landing page is at `/welcome`; with sign-in on, signed-out visitors are sent there and its button opens sign-in.

The database is one file at `DB_PATH` (default `data/circle.sqlite`); delete it to start over.

What gets wired depends on `.env`:

| Setting | What it turns on |
|---|---|
| `OPENROUTER_API_KEY` | The model, through OpenRouter: `z-ai/glm-5.3` for the agent and `z-ai/glm-5.3-flash` for labels, premise checks and the memory pass. Override with `MODEL` and `MODEL_SMALL` (Claude ids work too: `anthropic/claude-opus-5.5`). |
| `ANTHROPIC_API_KEY` | The model directly from Anthropic: Claude Opus 5.5 and Haiku 5.5. |
| `PROJECT_ID`, `PROJECT_SECRET`, `CHANNELS` | Chat channels through Photon Spectrum: `imessage` (default), `whatsapp`, `telegram`, `slack`, comma-separated. Each chat becomes a room; senders become people; the owner is recognised by the phone number or email on their person record (`PATCH /api/people/:id {phoneE164}`). |
| `BROWSERBASE_API_KEY` | The `browse_page` tool runs in a cloud browser. Without it, pages are read as text through Jina Reader. |
| `BRAVE_API_KEY`, `SEARCH` | `web_search` uses Exa's public endpoint by default (no key; the channel [Agent Reach](https://github.com/Panniantong/agent-reach) recommends, and it answers "Mandarin-speaking handyman San Jose" with names and phone numbers). A Brave key switches to Brave; `SEARCH=duckduckgo` uses the keyless scrape. |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Sign-in on the owner UI; every API call is made as the signed-in person, and each route checks that person against the room, agent or item it touches (see the API section). Without these the API trusts the "You" picker, so the server binds to loopback only. |
| `HOST`, `PORT` | Where to listen. `HOST` defaults to `127.0.0.1` without Clerk and `0.0.0.0` with it; a non-loopback host is refused unless Clerk and `MASTER_KEY` are both set. |
| `MASTER_KEY` | Encrypts members' credentials in the vault. Required off loopback. |
| `EVENT_TOKEN` | Shared secret for `POST /api/events` and `POST /api/tick` (`Authorization: Bearer …`). Without it, only a signed-in agent owner may call them. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google OAuth app behind the 26 Google tools (redirect URI `<PUBLIC_URL>/oauth/google/callback`). People connect their own accounts in Settings. |
| `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX` or `RESEND_API_KEY`, `EMAIL_FROM` | The assistant's own mailbox. AgentMail reads and sends; inbound mail enters as an app event. Resend sends only. |
| `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `TWILIO_*` | Phone calls through Vapi; SMS through Twilio. |
| `ELEVENLABS_API_KEY`, `IMAGE_MODEL`, `STRIPE_SECRET_KEY`, `STRIPE_CARDHOLDER_ID` | Voice notes, generated images (through OpenRouter), single-use cards for checkout. |

Without a model key the server still boots and the agent only acknowledges messages, so the UI can be explored.

Offline, with no key, the whole runtime runs against a scripted model in a test group (Alex the owner, Sam and Jo as members, Riley as a guest, in a room called Tahoe trip):

```bash
bun test        # offline tests across the run loop, gates, ledger, planner, memory, timers, hands, web api, channels, eval
bun run harness # one Harness² step: propose edits to skills/ for failing scenarios, probe them, adopt what fixes without regressing, note the lesson in skills/EXPERIENCE.md
bun run eval    # sixteen errands played against the configured model, graded on stored state; --list for coverage, --trials k for pass^k
bun run typecheck
```

## On iMessage

Most people meet Circle in Messages, not in the web app. Which way in depends on the Photon plan:

- **Free and Pro (the shared pool).** Circle has no number of its own. Under Settings → Channels a person gives the number they iMessage from; the server registers it with Photon (`POST /api/channels/register`), Photon assigns that person a number from its pool, and Circle texts them first so the number is in their Messages. One-to-one only: the pool cannot sit in a group chat. Groups live on the web with invite links, and Circle still texts each member privately for approvals.
- **Business (a dedicated line, $250 a month per line).** Circle gets its own number; people add it to groups the way they would add a friend, and link their phone by texting a code.

What differs from the web app:

- **Joining** is adding the number. The group appears in the owner's Rooms as "iMessage · Sam, Riley & 2 more" until the owner names it; each person who writes gets a seat (as a guest until the owner adds them, then a member).
- **Approvals are text.** "OK to spend $80?" arrives in the person's own thread with the line; "yes" or "no" is the answer. Anything that needs buttons or a browser (signing in to a site, an embedded page) comes with a link into the app that opens that chat.
- **Pages open from their link** with no sign-in, since the link was posted in that chat.
- **Everything is mirrored.** The web app shows the same chats, members and cards; replies sent from either side land in both.
- **The owner's phone** is linked once: on the shared pool, by registering it (above); on a dedicated line, Settings → Channels → Link my phone (a code texted to the line), or the phone field under General.

## Deploy

Production runs on Railway as one always-on container with SQLite on a volume. `Dockerfile`, `railway.json` and `.railwayignore` are checked in; nothing else is needed on the host.

```bash
npx @railway/cli login          # once; opens a pairing link in your browser
npx @railway/cli link           # pick the project and environment
npx @railway/cli up --detach    # upload this folder, build the image, roll it out
```

The service needs a volume mounted at `/data` and the variables from `.env.example` set in Railway (a fresh `MASTER_KEY` per deployment; `HOST=0.0.0.0`; `PUBLIC_URL` and `CLERK_AUTHORIZED_PARTIES` set to the Railway domain). One thing to know: the uploader honours `.git/info/exclude` with gitignore semantics, so a line like `agent/` there silently drops `src/agent` from the image; anchor such lines with a leading slash.

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
src/scheduler   schedules with authorisation and premise checks, heartbeat
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
POST /api/rooms/:id/invites          -> {token, url}               an invite link; POST /api/invites/:token/accept joins the room
GET  /api/search?q=                  rooms you are in, by what was said, with a snippet
GET  /api/connections/info           what the caller has connected; GET /api/connections/google/link starts Google OAuth
POST /api/people/:id/connections     {kind: slack|mcp|api, name, url|baseUrl, token…}  DELETE /api/people/:id/connections/:service
GET  /api/artifacts?agentId          documents, dashboards, images, audio and files the assistant made; POST /api/files uploads one; /d/:id opens one
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
room owner     POST /api/rooms/:id/members, /api/rooms/:id/invites, POST /api/schedules, /api/schedules/:id/pause
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

Built: the tool catalogue (above; Fo's names less four twins of core tools and an unsandboxed code runner); Settings → Channels that tells the truth per Photon plan (shared pool: register the number you iMessage from and get texted first, one-to-one; dedicated line: the assistant's number, a one-text phone link as Fo verifies a phone, and the way into group chats); the core rules as skills/_core-rules.md and a Harness² loop (`bun run harness`) that proposes, probes and adopts edits to the skills folder with the eval as the judge, recording evidence-backed lessons; a browser chain (local Chrome in local mode, Browserbase, Jina as the read-only floor) so a page is never unreadable; resourcefulness guards in the run loop (a plan opens on the first search whether or not the model wrote one, more than three searches in a row count as stalls, long work is pushed to a task, a reply after real work is checked once against the request's constraints); transcript mining in the consolidator so memory fills from the chats even when the agent took no notes; procedures for shopping and shipping, research and compare, travel, subscriptions and refunds, and government forms; one general assistant with per-chat priorities; rooms with owner, member and guest roles, invite links and guest serving; the responsibilities ledger with nudges and escalation; proactive suggestions; the run loop with gates, steering and resume; approvals as single-use records; quiet outcomes; task agents with delivery state; watches (alert rules); app events as triggers; an encrypted credential vault; sign-in cards inside the chat (Browserbase live view); session compaction; plans with the approach ladder; schedules with authorisation, premise re-check and working-hours holds; memory with scopes, privacy and consolidation; chat search; search steps labelled by query and narration kept in the thread; a people lookup across the chats it is in; the owner UI with Clerk sign-in and a landing page; iMessage, WhatsApp Business, Telegram and Slack channels through Photon Spectrum; the browser hand through Browserbase; the model through OpenRouter (GLM 5.3) or Anthropic; web search through Exa and page reading through Jina Reader; an eval harness.

Internet reach: `web_search` and `browse_page` are real (Browserbase Search on the Parallel engine when the browser key is set, with Exa behind it; Exa and Jina Reader keyless; Brave when keyed; pages go through local Chrome first in local mode, then Browserbase when keyed, then Jina, and a bot wall on one provider falls through to the next). The agent follows `skills/internet-reach.md`, adapted from Agent Reach's skill to the two tools it has; it says plainly which platforms it cannot read yet.

Needs an account to go live: calls (Vapi), SMS (Twilio), the assistant's mailbox (AgentMail), checkout cards (Stripe Issuing), voice notes (ElevenLabs), Google (an OAuth app). Each tool runs against a fake until its key is set and says so to the person. Not yet: reading or posting on Reddit and Rednote (both need a logged-in session); voice chat in the browser. Postgres is not used: the store is one SQLite file.
