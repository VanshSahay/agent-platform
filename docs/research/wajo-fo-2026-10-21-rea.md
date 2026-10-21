# Fo (Wajo) through REA, 21 Oct 2026

Method: `rea capture-browser-scenario` (Playwright, local Chrome, headless) over wajo.ai/fo → /help → /user (signed out, so /user rendered the sign-in shell), network bodies retained; `rea export-web-scripts` gave 278 scripts (246 first-party chunks from assets.wajo.ai). Everything below is read from that bundle: the generated RPC access map (`rpc-access.gen`), the route tree and the help copy. No account was used. Earlier pass: `docs/research/wajo-fo.md` (12 Oct).

## 1. How Fo gets a phone number (the question of the week)

- Phone providers in the client: `PHONE_PROVIDER_PHOTON`, `PHONE_PROVIDER_LINQ`, `PHONE_PROVIDER_SENDBLUE`. Fo runs on Photon too.
- `agent-contact-line.queries`: the agent's contact line is the first of `ListAgentPhoneNumbers` whose provider is one of those three; **if the agent has no provisioned number, the client calls `ResolveOwnerTextLine` and shows the owner's text line instead.** That is exactly the shape Circle shipped today: a dedicated line when there is one, otherwise the number assigned to the person.
- Help copy: Fo's numbers are US numbers; when Fo texts a third party "it starts a group text with you in it"; up to 8 non-Wajo people per account, slots never reset; one phone per account, changed under Settings → General with a code to the new number (`StartPhoneVerification`); bigger groups go to Telegram (`StartTelegramLink`, `ListAgentTelegramBots`).
- Onboarding has a `PhoneStep`; the checklist is server-side (`GetMyChecklistStatus`).

## 2. The API surface (410 RPCs, five services)

| Service | What it covers | Notes for Circle |
|---|---|---|
| `agentnet` (175) | sessions (run, runLongRunning, stop, watch, pin/reorder, rename, search, `sessions:mineGroups`, `runs:mineChannels`), attention items (list mine, resolve, dismiss), **suggestion cards** (refresh, regenerate, reorder), artifacts and documents (signed URLs, `setSharing`, render), connectors and MCP servers (user-level `CreateMCPServer` allowed; org-level attach denied to individuals), skills (deny: operator-only), shopping basket (add/remove/checkout/**buy**, all deny for individuals), `ResolveOwnerTextLine`, `ResolveOwnerCallFrom`, agent setup activate/dismiss, telegram bots, public agents and handles, webhooks (entitlement `mcp`), social drafts, presence touch/release, **escalations** (`/v1/assist/...`: claim, askUser, progress notes, follow-ups, site-login save/reveal, purchase cards mint/reveal/confirm/charge/cancel/fail with a merchant reference, test mode, notification prefs) | Suggestion cards = our dynamic starters, but Fo lets the person reorder and regenerate them. Escalations are Fo's human-assist tier (a person claims the errand, gets a minted card and the site login); Circle's equivalent is `request_call` to the owner. `runs:mineChannels` suggests per-run channel routing. |
| `agentpay` (11) | `SaveMyAgentBudget`, balance, credits (`ClaimStarterCredit`), prepayments (start checkout, confirm), pending purchases, purchases, **`SettleMyDebt`** | Fo's money model: a prepaid balance and a budget, purchases drawn against it, debt settled later. Circle has the threshold and pause; no balance. |
| `cron` (21) | schedules (upsert, pause, resume, delete, completed list), jobs with per-user enrollment (`EnrollUser`, `SeedManagedSchedule`), campaigns (operator), `TriggerHeartbeatTick`, sweeps for goal reviews and a rating backstop, OAuth refresh enrollment | "Managed schedules" seeded from jobs = standing routines a person opts into. Goal reviews are a sweep, not a schedule. |
| `users` (170) | profile, addresses with a default, contacts (+import), secondary emails, **email aliases** (mint/revoke), CalDAV, OAuth grants, site logins and browser profiles and account secrets (save/reveal/delete), credentials, connected payment cards and Stripe Link wallet, billing (checkout, portal, upgrade, plan), invite codes (get, send, request more), badges and perks, **fo-links** (link two people's Fos: set, accept, decline, resolve tag, search tags), fo-follows, **fompts** (shareable prompts with likes and reshares), AI data consent, memory on/off, dictation, keybindings, push devices, chat flags, feedback portal, orgs and projects (members, roles, invites), workspace git token | Fo-links and fo tags are a people graph between assistants ("@tag"); Circle's rooms already connect people, but there is no way to link two circles. Email aliases per person are a cheap identity trick worth copying. |
| `voiceruntime` (12) | place call, hang up, app voice call, TTS, voice memo, greeting clip, scribe token, webhook | Same shape as our calls hand. |
| `slack` (6) | org-level Slack app and user link | Business tier. |

Access column: `allow` / `allow_individual` (free and Pro users) / `deny` (operators or orgs). Everything with `entitlement: mcp` (API keys, webhooks, assistant connections) is a paid capability; the client's capability flags are `canUseMCP`, `canManageAgentPermissions`, `canInviteFriends`, `canViewBadges`, `canDeleteAccount`, `canManageEmailAddresses`, `canAccessApiKeys`, `canInstallAgents`, `canManageWorkspaces`, `canSwitchAgents`, `canAccessDashboard`, `canAccessIntegrations`.

## 3. Routes

User: `/user/settings` (General), `/address`, `/apps`, `/billing`, `/connections`, `/invites`, `/keyboard`, `/notifications`, `/payments`, `/permissions`; `/user/integrations` (accounts, connections, MCP servers); `/user/api-keys`; `/user/social-drafts`; `/contacts`; `/members`; `/search`; `/fo` (index, dashboard, schedules, workflows). Agents: `/agents`, `/agents/new`, `/agents/$slug` (index, connect, context, dashboard, schedules, workflows), `/agent/$slug/c/$sessionId`. Orgs: `/orgs/$orgId/settings` (overview, members, teams, context, connections, integrations, MCP servers, Slack).

Compared with 12 Oct: `apps`, `keyboard` and `social-drafts` are new under the user; `workflows` and `dashboard` under each agent; the org tree (teams, context) is new.

## 4. What to take, ranked

1. **Owner text line fallback** — done today (shared pool: the person's assigned number).
2. **Suggestion cards you can reorder and regenerate** — our starters are already dynamic; add "another" and a dismiss. Small.
3. **A spending balance, not only a threshold** — `agentpay`: prepaid balance, purchases drawn against it, "settle debt". Decide when a real checkout hand exists; today Circle cannot buy.
4. **Per-person email alias** — `MintEmailAlias`: a forwarding address per person so mail to the assistant is attributable. Cheap with AgentMail.
5. **Fo-links / tags** — linking two people's assistants. Circle's rooms cover the family case; skip until there are many circles.
6. **Escalation tier** — a human claims an errand with a minted card and site login. Not for now; the honest `checkout_cart` ("order not placed") is the right placeholder.
7. **Managed schedules seeded from jobs** — standing routines a person enrols in (bins, meds). Our watches and schedules cover it; the "enrol in a routine" framing is a UI idea for the Radar tab.

Do not copy: fompts (prompt social network), badges and perks, chat flags, the operator-only agent builder.
