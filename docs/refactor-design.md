# Refactor design (agreed 2026-10-12)

One general agent per person, living in iMessage, deployable into any group chat the owner adds it to.
Decisions below came out of a three-round design review; each line is a settled choice, not a proposal.

## Product

- **Channel:** iMessage only. Photon shared pool for DMs during the refactor; Photon Business (dedicated line, groups) switched on for the first real group pilot. Telegram, Slack, WhatsApp, email, phone adapters are deleted; the `verify/parse/send` adapter interface stays.
- **Agent:** exactly one per person, named by the owner. No skills, no templates, no marketplace. Per-room instructions, given in conversation, are what make it "the family helper" in one group and "work assistant" in another. The old featured agents become example sentences on the landing page.
- **Identity:** the phone number is the person in iMessage. Web sign-in is Clerk (reinstated 2026-10-12 after Ellie saw the plain page): a signed-in web account links to the phone with a code the agent texts, then shows that person's chats (read-only), connections (Google, devices), reminders and activity with proof. Google and device connect pages stay reachable by personal links the agent texts. The landing page keeps the old visual identity (sticker letters, googly eyes, marker underlines).
- **First contact:** agent texts who it is, asks what to call it and what to help with first. Google access is requested the moment a task needs it. No questionnaire, no starters.
- **Deploying into a group:** owner adds the number to the group. Agent says one line and takes instructions from the owner in the group or the DM. In a group it answers when named, replied to, or on an owner-set topic. No deploy/join codes.
- **Groups (Instinct model):** in a group room the agent acts as the group's agent: room memory and room instructions only, no one's accounts. Any member who is a user can ask it to use their own accounts; the first time in a given group the agent asks that member in their DM once, revocably. A reply pending when a new member joins is held until the requester says go. Approvals for a member's writes come from that member alone ("yes" reply or tapback). Guests who are not users get reads only (search, weather, tally, summary).
- **Tool order (planner guidance):** connector first, public API with the person's credentials second, browser last, phone only for native apps or things already signed in on the phone.
- **Hands:** Browserbase `browser.task` is the default for the public web. iphone-use is an MCP connection (tunnel URL + token) whose `phone_*` tools appear alongside; the planner chooses from the tool descriptions plus one line: phone for native apps and things already signed in on the phone, browser for the public web. Zero phone-specific platform code. Blocked apps by default: Wallet, Passwords, banking.

- **Train first, then deploy (2026-10-12, Ellie's grocery example):** a signed-in person trains the agent in a web chat before it ever texts: household rhythm, preferences and restrictions per person, stores and recurring deals, inventory from fridge and pantry photos. Memories are typed (preference, person, schedule, store, inventory, decision, fact) and dated, visible and editable on a Memory page. A trust dial in Settings lists the write actions the agent may run without asking, all off during the warm-up; the gateway enforces it. "Deploy to iMessage" is the phone-link step; the phone's row inherits everything learned on the web. Store logins for online ordering are not in this pass: ordering goes through the person's phone (iphone-use), where they are already signed in.

## Engine

- **Pipeline:** one planning step. The model emits the plan as structured output; simple messages are one model turn (possibly with tool calls) plus the reply. Intake, task graph, job contracts, gate, judge, claims extractor, regex facts: all deleted.
- **Proof:** `runs` (request, plan, status, cost) and `tool_executions` (input, output, provider_ref, `verified`). Per-tool verifiers: send → provider message id, calendar → event id, reminder → schedule row, browser/phone → the tool's applied result. One deterministic check before reply: any claimed action must have a verified execution, otherwise the reply says waiting / not done.
- **Memory:** `remember` tool, scoped private or room; the separate extraction pass is deleted. Retrieval unchanged: private only for the person's own requests, room for everyone in the room. The private→group sharing rule survives as that scope, not a module.
- **Models (OpenRouter):** default `z-ai/glm-5.3-flash`, fallback `deepseek/deepseek-v4-flash`. Smart tier `z-ai/glm-5.3` (no Anthropic models, by Ellie's instruction) only when a code rule fires: plan has ≥3 steps, any external write, a browser or phone task, or a correction of an earlier result. Never on the model's own request. Rule result logged per run.
- **Budgets:** model spend capped at $5/day from OpenRouter's returned usage; Browserbase capped at 20 sessions/day; both in one `usage` table, reset at midnight in the owner's time zone; the agent says when a cap is hit.
- **Tools:** flat registry, one file per provider under `src/tools/`. No plugin interface, no tick hooks, no registration ceremony.
- **Skills (internal):** markdown procedures under `skills/` in the Agent Skills format (one `SKILL.md` each: reservations, ticket booking, talking to customer service, group tally, phone-vs-browser). The agent loads one when a task matches its description. Users never see or choose them. Users say what they want the agent to do before adding it to a group; that becomes the room's instructions.

## Infrastructure

- **Hosting:** Railway (service + Postgres) deployed from GitHub; the Cloudflare Worker stays as the permanent link. Fly app and database deleted once Railway is live. Fresh database, no migration of old data.
- **Database:** Postgres via Bun's built-in client, every call awaited, numbered SQL migration files. No SQLite, no pg.ts bridge, no Temporal.
- **Tests:** a fast deterministic suite for model-free logic (routing, dedupe, approvals, policy, memory scopes) and a live suite of ~15 scenarios against the real model, Ellie's Google account and her own phone via Photon, run on demand and counted against the cap. The offline keyword planner is deleted.
- **Device:** iphone-use on this Mac (stays on, iPhone plugged in), exposed to the server through a Cloudflare Tunnel, registered as Ellie's device connection.

## Deleted

Domain modules (reservations, orders, groupkit polls/splits/lists, watches, objectives, stories, scam, paperwork, people, social, family), marketplace tables and code, Temporal, pg.ts, offline planner, `agent/`, `reports/`, tracked `.env.demo` and `.env.stack`, WhatsApp groups, synchronous phone handler, fake `email.draft`, all channel adapters except iMessage. (Clerk and a small React app came back the same day; the old agent builder, templates and deploy panel did not.)

## Reference products

Meta Muse (per-user cloud VM with its own browser, a Sentinel agent gating every outbound action, a credential vault the agent cannot read, connectors → API → browser) and Instinct (text or call it, separate group agent, consent before connecting a personal agent to a group). REA is used only when a specific feature question comes up, never to reproduce their code.

## Method

Refactor in place on this repo, on a branch, in reviewable PRs. First PR is deletion only.
