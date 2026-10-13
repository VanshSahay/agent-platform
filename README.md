# Agent Platform

Personal agents you train on the web and deploy into the chats you already have: your own iMessage, the family group, the trip group, the couple's thread. The people in those chats never sign up and never learn anything: they ask the agent by name and it does the job for them the way it does for you. Anything that uses your accounts or costs money goes through you. The agent only says something is done when its own records prove it.

This README is the spec: the ideal state of the product, section by section, with an honest status line for each. Decisions and their history live in [docs/refactor-design.md](docs/refactor-design.md); the competitor research that shaped it in [docs/research/wajo-fo.md](docs/research/wajo-fo.md).

## The ideal state

### 1. Training: the agent learns you before it works for anyone

You create an agent with a name and one paragraph about what it's for. It drafts its purpose and a few starter rules, then opens a training chat and asks what to hand off first and how you want it to behave. Everything you say about yourself is training: rules ("ask before emailing anyone at work", "keep it short"), preferences, people, routines, stores and deals, what's in the fridge from a photo. You can see all of it, typed and dated, on a Memory page, delete what's wrong and add what it should know. Once a day a background pass merges duplicates, turns examples into traits, rewrites corrected facts with their date and derives a short profile the agent reads first on every run. An agent can't be deployed until it has a name and has learned a few things.

**Status:** built. Nightly pass and profile built; "Tidy up now" runs it on demand.

### 2. Intelligent planning: one plan, cheap by default, proven at the end

A message becomes one run. The agent sees who it is, its purpose, its profile of you, your standing rules, an index of skills it can read, and dated memories matched to the request. It plans by calling tools; the model is cheap (GLM 5.3 flash) until the run writes, browses, uses the phone, needs three or more steps, or is a correction, when it moves to GLM 5.3. Skills are markdown procedures it reads when a task matches (reservations, tickets, customer service, group tallies, outreach, phone vs browser); users never see or choose them. Every tool call is stored with a fingerprint and marked verified from provider evidence. The reply's status footer and its named steps come from those records, not from the model's words; a reply that claims an action with no record is corrected. Scheduled work re-checks its premise before acting and tells you what it found instead of acting when the premise no longer holds.

**Status:** built. Planned: a true plan object the person can edit before a long task runs, and an eval loop that scores runs against outcomes.

### 3. Deploying: your chat, then any group chat

When an agent is ready, you link your number; it texts you a code. Your own chat talks to your default agent and "@Name" switches to another. In a group you add the number and say "@Name" once. The agent introduces itself in plain words, answers when named or when the message falls under what you asked it to do there, and never uses jargon. Guests, the people who never signed up, get served through you: a request that needs your accounts produces a card in your own chat naming who asked and what, the group hears "I've asked Ellie to OK that", and your yes finishes the job in the group. A signed-up member's own accounts are used only for their own request after a one-time consent. A reply pending when someone new joins is held until you say go.

**Status:** built for iMessage. The Photon shared pool is DM-only; group chats need the Photon Business line. Planned: Telegram and Slack through the same room model.

### 4. Trust: earned one notch at a time

Every write asks first. Per agent you tick actions it may run without asking, set a dollar amount under which it may buy, or pause spending. "Send email as me" is a separate switch per Google account, off by default; when off the agent leaves a real Gmail draft. Contacting a third party is disclosed first (who, how, why); approved outreach outside 8am to 8pm in your zone waits until the morning and goes out as exactly that action. A trace of every run, tool call and its proof is one link away.

**Status:** built. Planned: signed run attestations per agent key, and the agent's own email identity so "send from my own address and copy you" is the fallback when sending as you is off.

### 5. Hands: accounts, the web, a browser, your phone

In order of preference: a connected account (Google: Gmail, Calendar, Contacts, Drive), a public API or the web, a cloud browser for sites that need clicking (Browserbase), then your phone. Site logins you perform yourself in a live browser; the agent inherits the signed-in session and never the password. Your iPhone connects through [iphone-use](https://github.com/leeguooooo/iphone-use) on your Mac as an MCP device: the agent reads the screen as text and taps, for native apps and anything already signed in on the phone (Uber Eats, OpenTable, banking), and stops at any sign-in, passcode or payment for you to do. Any other MCP server you connect becomes tools the same way.

**Status:** Google, web, browser and MCP built; site logins built; iphone-use installed on the Mac and waiting on the phone setup. Planned: payments through single-use virtual cards so merchants never see your real card; a connector builder that turns an API's public docs into tools.

### 6. Multimodal and voice

Photos are described and read (receipts, menus, the fridge), voice notes are transcribed, files are read, all before the agent answers. Planned: the agent gets its own phone number and voice, so it can call a restaurant or a clinic, navigate the menu, wait on hold, and come back with a confirmation; every call gets a post-call analysis, and a call is outreach like any other, disclosed and approved first. Also planned: a voice conversation with the agent itself, and the agent seeing your screen when you ask.

**Status:** photos, voice notes and files built. Calls and voice chat not started; the largest gap against Fo.

### 7. Home: what needs you, what's on the radar, what happened

One page. Need your input: approval cards, consent questions, held replies, answered with a tap. On radar: scheduled jobs and runs in flight. Last activity: finished runs with their named steps. Planned: suggestion cards mined from your inbox and calendar ("reply to the renter inquiry", "the package is late, want me to chase it?"), and heartbeats: the agent waking on a schedule to check on standing work and messaging you only when something changed.

**Status:** the three tabs built. Suggestions and heartbeats planned.

### 8. Memory: the agent's, and the room's

An agent's training follows it into every chat it is deployed to. What a group says stays with that group. Another agent's memory never shows. Memories are typed (rule, preference, person, schedule, store, inventory, decision, fact) and dated, so newer wins and an inventory line is only as current as its date. Planned: embeddings when paraphrase recall becomes the bottleneck; today retrieval is full-text plus recency.

**Status:** built.

## Status at a glance

| Capability | State |
|---|---|
| Train on the web, typed dated memory, daily pass, profile | Built |
| Deploy to your iMessage chat; "@Name" switching | Built |
| Group chats: welcome, plain words, guests through the owner, consent, holds | Built; needs Photon Business for groups |
| Approvals, trust list, money threshold, pause, send-as-me | Built |
| Outreach disclosure and daytime staging | Built |
| Google, web, Browserbase browser, site logins, MCP devices | Built |
| iPhone through iphone-use | Installed, phone setup pending |
| Photos, voice notes, files | Built |
| Home tabs | Built |
| Google OAuth client configured | Pending (no client id yet) |
| Agent's own email and phone number | Planned |
| Calls and voice | Planned |
| Inbox-mined suggestions, heartbeats | Planned |
| Virtual cards for purchases | Planned |
| Telegram, Slack | Planned |

## Takeaways from Fo and Instinct

What we took from Wajo's Fo, learned from a logged-in walk-through, their public bundle and docs ([details](docs/research/wajo-fo.md)):

- **The three home tabs** and the "nothing needs you right now" idle state.
- **Named steps under every reply**, collapsed, with a proof line ("3 shops called · Thu 10:00 AM · 9 min").
- **The outreach disclosure rule**, written into every scheduled contact: disclosed to the user as who, how and why; re-verify the premise before acting; contact third parties only in working hours; anyone not named needs a fresh confirmation.
- **Send-as-you is a separate permission**, off by default, each send still asking; the fallback is a draft, and later the agent's own address with you copied.
- **A spending threshold and a pause switch**, with single-use cards as the planned next step.
- **Staged outreach as data**, delivered by a sweep inside daytime hours, not as a prompt hope.
- **An agent builder that starts from one paragraph.**
- **The agent's own identity** (email, number, cards) as the model for calls and payments.

What we took from Instinct:

- **A group agent is separate from personal accounts**; a member's own accounts enter a group only with that member's consent, once, revocable.
- **Replies pending when someone new joins are held** until the requester says go.

What we deliberately did not take: storing site passwords (a live login the agent inherits is enough), a human-assistant pool, Firebase auth. And from Instinct's memory design: a 24-hour ingestion lag the user can feel (our `remember` writes instantly; the daily pass only tidies) and grep as the only retrieval.

## How a message is handled

```
iMessage (Photon) or web chat
  → src/agent.ts: the room's agent, one run per message
      system prompt: who it is, its purpose, its profile of you, standing rules, skills index, memories (dated)
      model turn: z-ai/glm-5.3-flash; z-ai/glm-5.3 when the run writes, browses, uses the phone, has 3+ steps, or is a correction
      tool calls → src/tools/index.ts (whose accounts, consent, approvals, trust dial, staged outreach, idempotency, verifiers)
      reply + footer from verified executions + named steps
```

## Code map

| Area | Where |
|---|---|
| Run loop, approvals, consent, holds, welcome, prompts | `src/agent.ts` |
| Agents (owner, purpose, trust dial, profile), "@Name" switching | `src/agents.ts` |
| People, rooms, members, messages | `src/rooms.ts` |
| Memory (agent and room scopes, rules, retrieval) and the daily pass | `src/memory.ts`, `src/consolidate.ts` |
| Tool gateway and tools | `src/tools/index.ts`, `src/tools/{google,web,browser,mcp,core}.ts` |
| Skills the agent reads on demand | `skills/*.md` |
| Schedules, reminders, staged outreach | `src/schedules.ts` |
| iMessage transport (Photon) | `src/imessage.ts` |
| Models and daily caps | `src/model.ts`, `src/db.ts` |
| Web app and its API | `web/app.tsx`, `src/web.ts`, `src/auth.ts`, `src/server.ts` |
| Schema | `migrations/*.sql` |

## Run

```bash
bun install
cp .env.example .env      # DATABASE_URL, OPENROUTER_API_KEY, MASTER_KEY, PUBLIC_URL, Photon PROJECT_*, Clerk, Google OAuth, Browserbase
bun run start             # migrates, connects the iMessage line, serves http://localhost:3000
```

Models run on OpenRouter only, no Anthropic models by choice. Hard caps: $5 a day on models, 20 browser sessions a day, reset at midnight in `PLATFORM_TZ`.

## Test

```bash
bun test                  # 28 model-free tests on a local Postgres (agent_test): approvals, consent, guests, holds, scopes, trust, outreach, memory pass
bun run test:live         # 5 scenarios against the real model and tools, counted against the cap; TEST_PHONE=+1… also texts a real phone
bun run typecheck
```

## Deploy

Railway from this repo: `Dockerfile` and `railway.json` are picked up; add a Postgres service, set the variables from `.env.example`, point your domain or the Cloudflare Worker at it and set `PUBLIC_URL`. Google OAuth needs a client whose redirect is `${PUBLIC_URL}/connect/google/callback`.
