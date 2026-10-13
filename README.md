# Agent Platform

Personal agents you train on the web, then deploy to iMessage, to your own chat and to any group chat you add them to. Built for the people around you: a friend or family member in the group never signs up, never learns any syntax, and gets the same help you do. Anything that uses your accounts or costs money goes through you. The agent only says something is done when its own records prove it.

Design decisions and their history: [docs/refactor-design.md](docs/refactor-design.md). Competitor research that shaped the last round: [docs/research/wajo-fo.md](docs/research/wajo-fo.md).

## What it does today

- **Train first.** Sign in (Clerk), create an agent with a name and one paragraph about what it's for. It drafts its purpose and starter rules and opens a training chat. Everything you tell it about yourself is training: rules for how it should behave, preferences, people, routines, stores, what's in the fridge. Photos work. The Memory page shows every memory, typed and dated, with a "Tidy up now" that merges duplicates and dates corrections. Once a day a background pass does the same and derives a short profile the agent reads first on every run.
- **Deploy to iMessage.** When an agent has a name and a few memories, link your number; it texts you a code. From then on your chat talks to your default agent, "@Name" switches to another, and in a group you add the number and say "@Name" once. The agent introduces itself in plain words, answers when named, and in groups never uses jargon.
- **Serve the group.** Anyone in the group can ask for reads: search, weather, a tally, the list. A guest's request that needs your accounts runs through you: the card lands in your own chat naming who asked and what, the group hears "I've asked Ellie to OK that", and your yes finishes the job in the group. A signed-up member's own accounts are used only for their own request, after a one-time consent in their own chat. A reply pending when someone new joins is held until you say go.
- **Trust, one notch at a time.** Every write asks first. Per agent you can tick actions it may run without asking, set a dollar amount under which it may buy, or pause spending. "Send email as me" is a separate switch per Google account, off by default; when off the agent leaves a real Gmail draft.
- **Hands.** Google (Gmail, Calendar, Contacts, Drive), the web, a Browserbase browser for sites that need clicking, site logins you perform yourself in a live browser (the agent inherits the session, never the password), any MCP server you connect, and your iPhone through [iphone-use](https://github.com/leeguooooo/iphone-use) for native apps. The planner's order: connected account, public API or web, browser, phone.
- **Outreach.** Contacting a third party is disclosed first: who, how, why. Approved outreach outside 8am to 8pm in your zone is held and sent the next morning as exactly that action.
- **Home.** Need your input (approvals, consents, held replies), On radar (scheduled jobs, runs in flight), Last activity (finished runs with their named steps). Cards are acted on from the web through the same paths as a "yes" in iMessage.
- **Proof.** Every tool call is stored with a fingerprint and marked verified from provider evidence (a message id, an event id, a schedule row, a replay). The reply's status footer is built from those records, not from the model's words, and a reply that claims an action without one gets corrected.

Not built yet: phone calls by the agent, inbox-mined suggestion cards, a human-assistant fallback, Telegram/Slack/WhatsApp. iMessage group chats need the Photon Business plan; the free pool is DM-only.

## How a message is handled

```
iMessage (Photon) or web chat
  → src/agent.ts: the room's agent, one run per message
      system prompt: who it is, its purpose, its profile of you, standing rules, skills index, memories (dated)
      model turn: z-ai/glm-5.3-flash; z-ai/glm-5.3 when the run writes, browses, uses the phone, has 3+ steps, or is a correction
      tool calls → src/tools/index.ts (the one permission rule, consent, approvals, trust dial, staged outreach, idempotency, verifiers)
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
