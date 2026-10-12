# Agent Platform

One assistant per person, living in iMessage. It works for you in your own chat and in any group chat you add it to, and it only says something is done when its own records prove it.

Design and the decisions behind it: [docs/refactor-design.md](docs/refactor-design.md).

## How it works

```
iMessage (Photon)  →  src/imessage.ts  →  src/agent.ts: one run per message
                                             ├─ system prompt: who, where, skills, memories
                                             ├─ model turn (GLM flash by default, GLM 5.3 on a code rule; no Anthropic models)
                                             ├─ tool calls through src/tools/index.ts
                                             │    reads for anyone · a person's accounts only for them (consent once in a group)
                                             │    writes wait for that person's "yes" (reply or 👍) · every execution stored + verified
                                             └─ reply + status footer built from verified executions, never from the model's words
```

- **People** are phone numbers. **Rooms** are chats: private (you and your agent) or group (the group's agent, no one's accounts).
- **Tools**: Google (Gmail, Calendar, Contacts, Drive), the web, a Browserbase browser, reminders, memory, and any MCP server you connect (iphone-use on your Mac gives it your phone).
- **Skills** (`skills/*.md`) are internal procedures the agent reads when a task matches; users never pick them.
- **Models** (OpenRouter): `z-ai/glm-5.3-flash` by default; `z-ai/glm-5.3` when a run has a write, a browser or phone step, three or more tool calls, or is a correction. Hard caps: $5/day model, 20 browser sessions/day.
- **Web** (`web/`): the landing page, and a signed-in app (Clerk) where you train the agent before it texts anyone: a web chat with photo upload, a Memory page (typed, dated, editable), a trust dial for actions it may do without asking, connections, reminders, activity with proof, and "Deploy to iMessage", which links your phone with a texted code. Google and device connect pages are also reachable by personal links the agent texts.

## Run

```bash
bun install
cp .env.example .env      # fill in DATABASE_URL, OPENROUTER_API_KEY, PROJECT_ID/PROJECT_SECRET (Photon), GOOGLE_*, BROWSERBASE_API_KEY
bun run start             # migrates, connects the iMessage line, serves http://localhost:3000
```

## Test

```bash
bun test                  # model-free logic on local Postgres (agent_test): approvals, consent, holds, scopes, routing, dedupe
bun run test:live         # real model + tools, counted against the daily cap; TEST_PHONE=+1… also texts a real phone
bun run typecheck
```

## Deploy

Railway from this repo: the `Dockerfile` and `railway.json` are picked up; add a Postgres service and set the variables from `.env.example`. Point the public domain (or the Cloudflare Worker) at it and set `PUBLIC_URL`.
