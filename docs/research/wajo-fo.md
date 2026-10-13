# Wajo "Fo": what it is and what to take from it

Researched 2026-10-12 from Ellie's logged-in session (wajo.ai/fo, Chrome), the public JS bundle on assets.wajo.ai, and Wajo's public docs corpus (wajo.ai/llms-full.txt). No code or assets copied; this is a map of behaviour and structure.

## The product in one paragraph

Fo is a general action agent with its **own identity**: its own email (fo@wajo.ai), its own phone number, single-use virtual cards for purchases. You talk to it in a web chat, by texting or calling its number, by emailing it, or in Telegram/Slack. It does real-world tasks (calls businesses, waits on hold, sends email, shops with a cart and checkout, unsubscribes you from newsletters) and hands a task to a human assistant when it gets stuck. Free tier "Fo Mini" (1,000 tasks/day), invite-only "OG Fo" with group chats, paid Pro. Behind it is a general agent platform: agents are persisted specs (instructions, persona, model, capabilities), built by an Agent Builder agent, driven over MCP.

## Surface map (what a user sees)

- **Home**: greeting, "Ask Fo anything…" box (attach files, dictate), three suggested tasks mined from your inbox ("Reply to renter inquiry on 28K"), and three tabs: **Need your input** (things only you can answer), **On radar** (scheduled/pending work with next run time), **Last Activity** (finished runs, one line each with timestamp).
- **Chat**: each assistant message carries a collapsed "Completed N steps" expander with short human labels per step ("Uber link location checked", "Sign-in options lined up"). Cards inside chat for things that need you: **Login Required → Save Login**, **Needs your go-ahead** before a call is dialed, a schedule card ("Redial Graciela… Scheduled for 7:35 PM EDT"). Footer: "Wajo agents can make mistakes, so double-check."
- **Schedules**: everything the agent runs on its own (recurring, one-offs, their runs), with the full plan text visible.
- **Contacts**: people you and Fo mention together; auto-added from conversation, editable.
- **Getting started** checklist: first chat, connect Google, connect your phone, call Fo, email Fo, invite a friend.
- **Settings**: General (name, phone for calling/texting Fo, pronouns, timezone, birthday "to fill in forms", extra verified email addresses so mail from them reaches the agent), Address (checkout prefill; the agent can add addresses), Payments (Stripe card, "Ask before purchases over $X", pause spending, balance, transactions), Invites, Connections (Google connected; 1Password, Apple Calendar/CalDAV, Asana, GitHub, Granola, HubSpot, Linear, Luma, PostHog, Ramp, Replit, Robinhood Banking, ServiceTitan, Telegram, Zapier; **Add MCP**: "name the app to connect, or paste an MCP server URL"), Permissions (one toggle: "Send email from your Gmail, as you. Each send still needs your go-ahead. Off until you turn it on."), Notifications (browser alerts when a run finishes or stops needing you), Keyboard.

## Policies worth copying (seen verbatim in the product)

1. **Outreach disclosure rule** (from a schedule's plan text): "Outreach authorized when this was scheduled. Basis: user_requested. Disclosed to your user: Graciela restaurant (646) …, by phone, to retry the reservation… That disclosure authorizes this outreach; it does not decide whether it is still needed. Before contacting anyone, verify the premise this schedule rests on against the live thread, calendar, or ledger. If you cannot verify it, or it no longer holds, tell your user what you found instead of contacting them. Contact third parties only inside their working hours; outside them, hold the message, tell your user, and plant a one-time follow-up for their morning. Anyone the disclosure does not name was not disclosed, so the confirm-first outreach rule applies to them as usual."
2. **Send-as-you is off by default and still asks every time.** Without it, Fo sends from its own address with the user cc'd and offers to leave a draft instead. The chat said exactly that when Gmail send wasn't granted.
3. **Calls need an explicit go-ahead** ("Waiting for your go-ahead. Nothing has been dialed."), and a callback number is shared only if the user authorized it "in this conversation".
4. **Spending**: a dollar threshold under which the agent may buy without asking, a global pause, and single-use cards so merchants never see the real card.
5. **Site logins**: "Save your uber.com login through Wajo, outside chat." Credentials go to encrypted storage via a form the agent never sees; the agent then signs in as you. (We chose a different mechanism, Browserbase Contexts, with the same property: no password through the chat.)
6. **Premise re-check before every scheduled action**, and "tell your user what you found" instead of acting when the premise no longer holds.

## Architecture, from the bundle and docs

- Frontend: TanStack Start (server functions), React Query, PostHog, Stripe, Firebase Auth with Google/Microsoft sign-in, served from assets.wajo.ai; the app pages are server-rendered, so no JSON API calls show in the browser.
- REST surface (public endpoint map in `endpoints-*.js`): `agents` (handles, public directory, copy/move, collaborators, phone numbers, Telegram bots, setup activate/dismiss, `reportRuns`), `attention` (the Need-your-input queue: dismiss/resolve, suggestions refresh/reorder), `schedules` + `enrollments` (pause/resume), `sessions` (server-minted ids bound to one agent; run / runLongRunning / watch / events / stop / pin), `shoppingBasket` (addItem/removeItem/checkout/buy), `paymentCards` + agent budget/balance/purchases/debt, `site-logins/form`, `connector-credentials/form`, `mcp-servers` (build/validate/refresh), `webhooks`, `voices` + TTS + a scribe token (voice chat), `artifacts` and shareable `documents`, `org/knowledge` and `agents/$id/knowledge` (RAG per agent/org), `memories:getEnabled/setEnabled` (memory is a user-level toggle), `social-drafts`, `EA_TEST_MODE /assist/testmode` (the human "executive assistant" fallback has a test mode).
- Agent model (docs): an agent is a persisted spec (name, description, instruction body, typed "soul"/persona, provider+model, capabilities: system tools, connectors, MCP servers, skills, sub-agents). Created only by chatting with the Agent Builder agent. Connectors are "data, not code": point at an OpenAPI/Postman doc and the platform distills a typed endpoint catalog; credentials attached server-side after the agent produces the request. Sessions are server-minted and bound to one agent so a client can't re-point them. Webhooks (Standard Webhooks signing) for `conversation.reply`, `schedule.fired`, `message.proactive`.
- Public MCP server at mcp.api.wajo.ai with `build_agent`, `chat_agent`, `get_agent_reply` (poll while "working"), and a one-agent `/fo` profile (`ask_fo`, `get_fo_reply`, `list_fo_conversations`) for consumer hosts like ChatGPT apps.

## From REA static analysis of the public bundles (455 chunks)

REA (`analyze-javascript-application`, v6.4.0) parsed every chunk the entry bundle references: 1,408 graph nodes, 21,255 semantic nodes, 11,523 findings. The decisive artefact is `rpc-access.gen`, a generated client access table for their backend service `wajoai.agentnet.v1.AgentNetService`: 224 methods, each with a tier/entitlement rule (full table in `wajo-fo-rpc-catalog.md`). Tiers named in it: Fo mini, Fo Pro, Fo Ultra, OG Fo, OG Plus, Enterprise; entitlements `outbound_texting`, `beta_cohort`, `badge_founding`, `badge_pro`. What the method names reveal that the UI does not:

- **Human assistants are a first-class subsystem** (`assist/*`): escalations are claimed by an EA pool member (`ClaimEscalation`, `ExtendEscalationDeadline`, progress notes and follow-ups to the user), the EA can reveal a site login or mint and reveal a single-use purchase card per purchase (`MintEAPurchaseCard`, `RevealEAPurchaseCard`, `ChargeEAPurchase`, `ConfirmEAPurchase`), with evidence per card, a test mode, and notification prefs. The 71% "without human fallback" figure makes sense against this.
- **Heartbeats**: `ComputeHeartbeatTier`, `EvaluateHeartbeatTick`, `PrecheckHeartbeatDuty`. Agents wake on a schedule whose frequency is a tier; proactive messages (`message.proactive` webhook) come from here.
- **Staged outreach**: `DeliverStagedItem`, `ListDueStagedItems`. The "outside working hours, hold the message" rule is implemented as staged items delivered by a sweep, not as a prompt hope.
- **Inbox mining**: `EnsureGoogleWatches`, `ListGoogleWatchCandidates` (Gmail push), `RefreshMySuggestionCards`, `ReorderMySuggestionCards`: the three home suggestions are built from watched mail.
- **Calls**: `StartAppVoiceCall`, `MintVoiceSession`, `ResolveOwnerCallFrom`, `ReportOwnerCallAnswered`, `AnalyzePostCall`, `ExtractCallRecords`, `RunPostCallAnalysisTask`, `RateVoiceConversation`, `WriteVoiceCallMetrics`: every call gets a post-call analysis job.
- **Multi-channel threading**: `ResolveSessionByChannelThread`, `ResolveReplyByMessageId`, `ResolveReplyToken`, `ResolveSmsReplyBinding`, `RecordSmsGroupMembership`, `RecordGroupContextTurn`, `SendGroupOutsiderInvites`, `RecordOwnerDm`, `RevokeExternalReplyAccess`: one session spans chat, email (reply tokens), SMS and SMS groups, and third parties can be let into (and out of) a thread.
- **Run integrity**: `AttestAgentRun`, `GetAgentPublicKey`, `RotateAgentKey`: runs are signed per agent key.
- **Deferred model work**: `RunModelDeferralTask` keyed by a dedup key; sweeps for card reconciliation, escalations, goal reviews and a rating backstop; `SummarizeRunOutcome` as its own task.
- **Agent platform**: skills (`CreateSkill`, `AttachSkill`), a tool catalog, MCP servers attach/detach, connectors with secret status, publishing (`PublishAgent`, `LookupPublicAgent`, publisher origin, privacy posture), org installations, collaborators, a sandbox fork per agent (`SyncSandboxFork`), `ComputeAgentPerformance`, and `AnalyzeTaskValidationPatterns` / `GetTaskValidationMetrics` for their eval loop.
- **Content catalogs** (`errands.data`, `welcome.suggestions`): nine marketing errands with the exact prompt and the proof line shown afterwards ("4 calls · Thu 9–11 AM · 12 min"), and twelve starter prompts by category (subscriptions, delivery, schedule, home-services, government, gift, business, booking, email-reply, travel).

## Where we already match

Approval before writes; the agent has to show proof before saying done; MCP servers as connections; a per-agent trust list; schedules the agent sets itself; a Memory page; the web training chat polling while "working"; contacts learned from conversation (ours: `person` memories).

## What to take, ranked by value over effort

1. **The three home tabs.** "Need your input" / "On radar" / "Last activity" is the right shape for the app home and for the iMessage daily check-in. We have the data already (approvals pending, schedules, runs). Half a day.
2. **Named steps on every reply.** Our tool executions become a collapsed "Completed N steps" with a one-line label per step. Cheap: the label is `summarize()`; we already store every execution. Two hours.
3. **The outreach disclosure rule** as a standing rule in our skills: a scheduled or delegated contact must name who, how, and why in the plan; re-verify the premise before acting; working hours for third parties; confirm-first for anyone not named. One skill file, and one line in the system prompt. An hour.
4. **Send-as-you is a separate permission** from "Google connected", off by default, and the fallback is "send from the agent's own address, cc the owner". We don't have an agent email identity yet; AgentMail (already a connector in this session) gives one per agent. Half a day for the fallback.
5. **Spending threshold + pause + single-use cards.** Our trust list is per tool; theirs adds an amount. Add `max_usd_without_asking` to the agent and have purchase-shaped tools report an amount. Cards are a Stripe Issuing project; later.
6. **Suggestions mined from the inbox** (the three cards on home). A daily cheap-model pass over the last 24h of Gmail producing three "want me to…" cards. Moderate; needs the Google connection first.
7. **Calling.** Fo's own phone number and voice. Biggest gap vs Fo; Twilio plus a voice model. A real project, after the phone and group pilot.
8. **Agent Builder as an agent** ("describe it in one paragraph"). We removed templates deliberately; a builder that drafts purpose + first rules from one paragraph fits our Agents page and is one prompt. Two hours.
9. **Staged outreach as data, not prompt.** A `staged_items` table with a due time and a sweep that delivers inside working hours. Our schedules table already has the shape; add a `deliver_after` and the working-hours check. Two hours.
10. **"Proof line" after every task**, from the errand catalog: actions taken, when, time it took ("3 shops called · Thu 10:00 AM · 9 min"). We have the executions and timestamps; it's a footer format. An hour.

## What not to copy

- Storing site passwords, even encrypted. Browserbase Contexts give the same outcome without holding the secret.
- A human-assistant fallback. Right for Fo's business; out of scope for us.
- Firebase Auth. Clerk is already in.

## Sources

- Logged-in app: wajo.ai/fo, /fo/schedules, /contacts, /user, /user/connections, /user/permissions, /user/payments, /user/notifications, /user/address, /user/invites, three conversations.
- Public bundle: assets.wajo.ai/assets/endpoints-BTTBOVTN.js (endpoint map), index chunk (framework, analytics).
- Public docs: wajo.ai/llms.txt, wajo.ai/llms-full.txt, wajo.ai/.well-known/agents.json.
- Press: cryptobriefing.com (Khosla backing), kucoin.com news (71% task completion claim, self-reported), usecarly.com/blog/wajo-fo (review).
