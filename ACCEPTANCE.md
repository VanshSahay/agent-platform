# Acceptance criteria

Every row is checked automatically by `bun run criteria`: it runs the test suite (JUnit), the typecheck and the web bundle build, then marks each criterion **pass** only when every test tagged with that ID passed. Plan section numbers refer to `agent_platform_product_technical_plan.md`.

## Milestone "must prove" scenarios (§28, §29, §32, §33, §21.2)

| ID | Criterion | Plan |
|---|---|---|
| AC-M1 | A user creates Ava on web, connects Google, later texts Ava over iMessage, and Ava recognizes the ongoing task in the same Room and resumes it correctly (approval given from iMessage, reply delivered there). | §28 |
| AC-M2 | Three teammates interact with one agent in a Slack channel; mention-only participation; the work (tasks, owners, blocked items) is visible in the Room; a teammate continues from an iMessage group without losing state. | §29 |
| AC-M3 | Group trip request over iMessage is research-only (no booking), per-person preferences are remembered in Room scope, and a second person continues on web in the same Room. | §32 |
| AC-M4 | Recruiting: a human-claimed candidate is never contacted, outreach requires the right approver, a transient bounce is retried, the run waits for the candidate, and the next-day inbound email resumes that run — the email is sent exactly once. | §33 |
| AC-M5 | Instructions inside fetched web content cannot trigger an external write; tool output is labeled untrusted; the write requires human approval even if configured automatic. | §21.2 |

## End-user journeys (register → describe → test → one-click deploy → real work)

| ID | Criterion | Plan |
|---|---|---|
| AC-J1 | Personal: landing page → register → describe an agent → Test mode runs the full pipeline but sends/books nothing (unconnected accounts use sample data) → one tap opens Messages with a deploy code → the agent works over iMessage and on web in the same Room; strangers on the shared line get instructions, not an agent. | §3, §28 |
| AC-J2 | Team: create for a team → invite → Add to Slack (OAuth) → pick a channel → teammates use it in Slack and in an iMessage group (agent name prefixed on the shared line) → account overview shows what each agent does and where it's deployed; tasks are listed. | §29 |
| AC-J3 | Reservations: watch a hot spot, pre-approve limits once (strong confirmation), and the agent books within seconds of the drop and texts the confirmation; the standing approval is used up. | §17.3, §19 |
| AC-J4 | Reservations without pre-approval: a one-tap (strong, for deposits) card arrives the moment a table opens; if the table is gone the agent says so honestly and books nothing. | §35.3 |
| AC-J5 | Group buying in an iMessage group: open an order, members join without tagging, chatter is ignored, tally on request, organizer-only close, deadline reminder, auto-close with per-person totals and pay links, payments tracked after close. | §15 |
| AC-J6 | Memory at both levels: agent-level knowledge stays with that agent; account-level personal facts follow the user to all their agents, privately. | §9.2 |
| AC-J7 | Real-time group chats: replies sent while an order is still being opened aren't lost (per-conversation run ordering); short orders don't get an instant "24h left". | §5.2 |
| AC-MCP1 | Connecting an MCP server discovers its tools (risk from tool annotations); granted agents call them through policy, approvals and audit; the server's credentials never appear in events. | §10, §27 |
| AC-MCP2 | browser.task runs on a granted MCP browser server; stored website logins (OpenTable/Resy) are passed only to the HTTP browser runner, follow ownership rules, and never reach the model or the logs. | §11.2 |
| AC-BR1 | A website login made in a live Browserbase session keeps only the Context id (no password, cookie or sealed secret); only its starter can finish it; cancel releases it; without BROWSERBASE_API_KEY the flow answers 501. | §11.2, §21.3 |
| AC-BR2 | One active live login per person and site: reconnecting revokes the old one, keeps its agents and resumes runs parked on the reconnect. | §11.2 |
| AC-BR3 | browser.task on a granted live login (preferred over a stored password) still needs approval, passes only the Browserbase context to the runner, and records the session with a replay link the agent and trace can show. | §10, §11.2 |
| AC-BR4 | A logged-out pre-flight marks the live login needs_reauth and does not run the task; later calls are denied until the owner reconnects. | §11.2, §35 |
| AC-BR5 | One Browserbase session per login at a time: a concurrent task starts only after the first session is released and the Context has synced. | §35 |
| AC-BR6 | Stored site logins work without a live login; MCP browser servers get the contextId; with no external runner the built-in runner drives the login's session over CDP (real clicks/typing, stays on the site, stops before irreversible steps, records a replay). | §29 |
| AC-BR7 | Starting a live login opens the site's login page in the live view over CDP (find the tab, attach, navigate, detach; never close the browser), since the fullscreen live view has no address bar. | §11.2 |

## Requirement layer: brief → confirm → execute → verify

| ID | Criterion | Plan |
|---|---|---|
| AC-B1 | Every request gets a structured brief (goal, deliverable, constraints, assumptions, side effects, done-when, plan); chit-chat skips it; simple actions start immediately and the model executes against the brief. | §7.4 |
| AC-B2 | When essential information is missing (and can't be looked up), the agent asks one batched question and runs nothing until it's answered; the answer continues the same task. | §7.4 |
| AC-B3 | Multi-step tasks show the plan with Go/Cancel and wait; "go" starts it, "cancel" drops it. | §3.4, §3.7 |
| AC-B4 | A mid-flight change re-briefs with a visible diff, withdraws stale approvals, re-confirms, and only the new action is executed. | §32, §35 |
| AC-B5 | Results are checked against "done when" before reporting; gaps are retried once, then disclosed. | §35.3 |
| AC-B6 | Plan steps tick off as tools succeed; the agent can re-plan; long waits post one progress note instead of chat spam. | §3.3, §37 |
| AC-B7 | Brief cards work from channel buttons, scoped to their room. | §5.3 |
| AC-B8 | Confirmation is decided by a deterministic policy with a per-agent mode (smart / always / never); a single external write relies on its approval card instead of asking twice. | §19.3 |
| AC-B9 | Unanswered questions and unconfirmed plans expire after 72h instead of guessing. | §2.8 |
| AC-B10 | Internal-only work (to-dos, reminders, lists) runs without asking "go"; plans that write outside, delegate or wait on people still show first. Every agent and brief prompt carries the current date, time and zone. | §3.4 |
| AC-B11 | Planning layer: every request gets an effort (quick/standard/deep), a model tier and a tool budget; real work gets an immediate reply; a request that has to wait is acknowledged at once; long runs post one progress note; past the budget the agent is told to wrap up, and past twice the budget (+2) it is told to answer and gets no tools. | §3.4, §7 |
| AC-DP1 | Depth is decided before deploy from the agent's jobs: each job gets an effort with a reason, the agent's level (light/standard/deep) is its deepest job, an override sticks, and cost estimates scale with depth. Internal: not shown to people. | §3.4 |
| AC-DP2 | At run time the agent's depth caps every request: a light agent never runs deep and stays within its tool/model budget; a deep agent gets the research tier and the larger budget. Catalog agents get a depth from their job and skills. | §3.4, §7.5 |
| AC-DP3 | At the agent's tool cap the run is told to answer and loses its tools; with no retry left, a failed check delivers the answer flagged instead of 'I couldn't finish'. Trial budgets are set when the run is created. | §7.5 |
| AC-GT1 | One completion gate checks every reply in order (tool-markup leak, ungrounded figures, unbacked action claims, job contracts, the plan's own claims) with one retry ledger; every request's "done when" is checkable: a planned action that never happened is nudged once then flagged honestly; a skipped look-up is nudged but never alarms the person. | §7, §7.4 |
| AC-GT2 | Claims carry their proof: a planned tool must succeed (or be waiting for approval), "N options" needs N items, "sources" needs a link; a model-given proof must name a planned tool; only answer-quality claims go to the judge model; bookkeeping tools are never claims. | §7.4 |
| AC-GT3 | Planning and checking run on the judge tier (the strongest open model), never the cheap one; the judge profile is added to databases seeded before it existed. | §8.3 |
| AC-GT4 | The context window is by size (not a fixed 30 messages) with a running summary of what scrolled out, refreshed after each completed task; older tool results are trimmed while the newest stay whole, so long runs never outgrow the model. | §9, §7.5 |
| AC-X1 | A completed task leaves a playbook per agent and task shape (which tools, what worked, what failed, how long); a similar request sees it before its first model call; repeats update the count instead of duplicating. | §9, §11.3 |
| AC-X2 | A site that failed three fetches this week with no success since is refused up front with the reason, so no fourth call is made. | §9 |
| AC-X3 | What a person answers when the agent asks is kept as their preference and is never asked again. | §9 |
| AC-X4 | In a group the agent is told what was decided and who hasn't answered its last question; a member's private memory is used silently for their own request only, never shown for someone else's. | §9.5, §15 |
| AC-X5 | Every agent has exact arithmetic (percentages included), currency conversion with the rate's date, and per-task notes that persist across steps. | §7 |
| AC-X6 | What someone says about themselves in a group is kept as their own memory too: used for their requests in their other chats and agents, never for someone else's. | §9.5 |
| AC-W1 | A website availability watch is set from chat (what, URL, when it opens, max price, quantity); it looks every 30s around the opening and at its cadence otherwise; a hit tells the person once with the link; over-cap prices don't count. | §7, §37 |
| AC-W2 | action='act' hands the agent a pre-planned browser step that needs approval; a rejection pauses the watch; it resumes by words; the window passing expires it with a message. | §7, §37 |
| AC-F1 | A person's private chat never reaches the family group except through family.share, which posts only the given text and only after the person's own yes in their own chat (not the model's claim, not someone else's yes); the private reason never leaves the chat; the sharing panel is shown to the agent in private chats. | §15, §21 |
| AC-F2 | Categories a person shares by default go straight to the family; other categories still ask; only the person can change their own sharing, from their own chat. | §15 |
| AC-F3 | "Is this real?": a deterministic verdict (likely a scam / suspicious / nothing obviously wrong) with the exact reasons from the message, never a number or link from the message to act on; benign messages pass. | §15 |
| AC-F4 | Stories are kept in the teller's words with who/when/where and provenance; a private story is invisible from the family group; the family group's stories are searchable from a member's private chat. | §15 |
| AC-F5 | An objective is an ordered list of steps with owner and due date; progress is one line; an overdue step gets one nudge to its owner and, two days later, one escalation to whoever set it up; a done step is never nudged. | §15 |
| AC-F6 | Story interviewer asks one unasked question at a time and keeps the answer as a story; a sent bill is findable with its amounts, dates and asks, and never from someone else's chat; the friendship signal names who the person mentions and who has gone quiet, in their private chat only. | §15 |
| AC-R1–R6 | Review 2026-10-07: the request's facts (people, addresses, dates, money, price cap) are typed into the brief; a keyword plan standing in for a failed model never runs an external write silently; a send is proven only by a send; an action that contradicts the request's facts is flagged on the approval card and the reply; an unavailable judge proves nothing; playbooks are learned only from verified runs. | §15 |
| AC-TG1–TG4 | Task graph: each planned (or unplanned) action is bound to its tool execution and evidence; an approval is waiting_human, never done; a send is verified only by a provider message id, a draft is only observed, a reminder by its persisted schedule; an unknown provider answer is uncertain and the reply says so; a changed instruction is a new revision keeping verified work and cancelling the rest; the trace shows the task state. | §15 |
| AC-G5 | A new poll counts answers people already gave in the chat (their own words, last 24h) and says who; they aren't asked again. | §15 |
| AC-K1 | After the same kind of task succeeds 3 times, the agent offers once to save it as a skill; saved skills guide future runs; buttons are room-scoped. | §11.3 |
| AC-F1 | Files (text and PDF) uploaded into a room are readable by the agent; files are scoped to their room and workspace. | §17.2 |
| AC-O1 | Onboarding: empty workspaces offer one-click agents; agents come with starter prompts and a setup checklist (connect, reach from phone, first task). | §3.3, §38 |

## Permissions & policy (§19)

| ID | Criterion | Plan |
|---|---|---|
| AC-P1 | Risk classes (read, internal write, external write, destructive, financial) map to deterministic decisions; destructive always asks; financial needs strong confirmation. | §19.2 |
| AC-P2 | Per-agent permission modes (never / first-time / ask / always-ask / auto) and per-call prior approval are enforced; tools outside the agent's skills are denied. | §19.1, §19.3 |
| AC-P3 | Connections must exist, be granted to the agent and active; a private connection is unusable in a room its owner isn't in. | §2.6 |
| AC-P4 | Writes touching a human-owned (blocked) subject are denied even if approved; tainted runs and exhausted write budgets force approval. | §15, §21.2, §7.5 |

## Tool gateway & reliability (§10, §35)

| ID | Criterion | Plan |
|---|---|---|
| AC-T1 | Tool inputs are schema-validated; invalid or unknown calls never execute and the model is told why. | §10.2 |
| AC-T2 | Repeated identical external writes execute once (fingerprint idempotency). | §35.1 |
| AC-T3 | Retry taxonomy: RATE_LIMIT waits until retry-after, AUTH pauses and asks the owner to reconnect (resumes on reconnect), UNKNOWN_SIDE_EFFECT stops for human verification and never blindly resends. | §35.2 |
| AC-T4 | Web fetch refuses private-network targets (SSRF). | §21.1 |
| AC-T5 | After a crash mid-write, recovery re-queues the run and refuses to double-execute. | §7.2, §35.1 |
| AC-T6 | Decrypted credentials never reach the model, events, or traces; the audit records which connection was used. | §10.2, §21.3 |
| AC-T7 | Run budgets stop runaway agents and tell the room. | §7.5 |
| AC-T8 | Everyday tools work: free-time search across calendars, contact lookup feeding an email (instead of asking), Drive search/read. | §10.4 |

## Runtime: Rooms, Runs, waits, delegation (§2, §7, §15, §16, §37)

| ID | Criterion | Plan |
|---|---|---|
| AC-R1 | Every run leaves an append-only event trace (context → model → tool proposal → permission → execution → reply) and a deterministic "why did it send this" answer; runs are classified. | §21.5, §23.1, §24.1, §7.4 |
| AC-R2 | Approvals: rejection is relayed to the agent, approvals expire after 72h, only designated approvers may decide. | §3.7, §19 |
| AC-R3 | Financial actions require strong confirmation; first-time tools remember the grant. | §19.2 |
| AC-R4 | Group participation modes: mention-only, relevant, manager. | §15.2 |
| AC-R5 | Delegation is typed: child run sees only its objective, gets a smaller budget and no autonomous writes, and the parent resumes with the result. | §16 |
| AC-R6 | Wake conditions: time, recurring, timeout, event and state triggers create runs; proactive messages go to the last-used channel. | §37 |
| AC-R7 | One agent in many rooms: room memory and work state never cross rooms. | §41 B |
| AC-R8 | Model outage: retry with backoff, then fail terminally with a message. | §8.3 |
| AC-R10 | Platform-hosted inference stops at the plan's monthly allowance with a clear message; BYOK usage isn't counted. | §22 |
| AC-R11 | A reply that promises or claims a side effect ("I'll book…", "reply approve") with no successful write and no pending approval behind it is sent back once, on the escalation tier, to call the tool; the false instruction never reaches the user. | §35.3 |
| AC-R12 | With `JEV_API_KEY` set, "relevant" group participation and the unbacked-claim check are judged by JEV (typed yes/no probability, threshold 0.5); when JEV errors or is unset, the previous model/keyword and regex checks still apply. | §35.3 |
| AC-R13 | A reply containing raw tool-call markup is never sent: one retry on a stronger model, else the markup is stripped. | §7 |
| AC-R14 | Grounding: money, percentages and precise figures in a reply must appear (±1%) in this conversation's tool results, messages or memory; otherwise one 'cite or drop' retry. Agents record data they can't source (data.missing) and the agent page lists those gaps, most requested first. | §7 |
| AC-R15 | Sports scores, results and schedules come from a live scoreboard feed (major US leagues, top European soccer, Champions League, F1): finals with scores, upcoming games with time and TV and no fake 0–0, team filter, in the person's time zone; unknown leagues are refused. Rally (catalog) uses it. | §7 |
| AC-AVA1 | Calendar job over iMessage: reads the connected calendar in the person's time zone (today = their midnight, past events marked); a reply without reading it is sent back once; no Google = honest connect link; expired access = reconnect link and the request waits. | Ava |
| AC-AVA2 | Reminder job over iMessage: set with the exact local time confirmed, list, change, cancel; plain reminders are delivered word for word to the same thread with no model; cancelled ones never fire; each delivery is recorded. | Ava |
| AC-AVA3 | Email job: the approval request shows the exact draft; approval is bound to that draft; sent once (a second approve does nothing); an unclear provider answer is reconciled by our Message-ID — found = sent, provably absent = safe retry, unknown = the person is asked to check and nothing is resent. | Ava |
| AC-AVA4 | The Dana journey over iMessage: finds Dana in contacts, reads free time, shows the exact email; a changed instruction replaces the draft (the old one can never be sent); the waiting run survives a restart; sends once; every reported action is proven; the Friday follow-up checks Gmail itself and fires only if Dana hasn't replied. | §7, §33 |
| AC-S31 | A number that belongs to another real account can't be taken over with a link code: refused before any write, owner unchanged; guests still fold in. | §20.2 |
| AC-JOB1 | Job contracts: calendar, reminder and email requests need evidence in our records (a succeeded tool, a pending approval, or a question back) before a run may present itself as done; outcomes are recorded per job. | §3 |
| AC-JOB2 | Job contracts check each requested action: calendar + reminder in one message must both be proven; a search doesn't prove a send; a question back is 'asked' (not done) and the answer's run carries the job; group expenses, lists and polls have their own contracts; contracts apply only to jobs the agent has tools for. | §7 |
| AC-SPC1 | Specialists run in parallel, each on its kind's tools only (a subset of the agent's), can't write or start specialists, get a share of the budget, and return typed findings {finding, sources, proposed_actions, unresolved_questions}; the agent gets all results together and answers once; specialists' reads count as evidence. | §16 |
| AC-SPC2 | A changed request (or a cancel) stops the specialists working on the old one. | §16 |
| AC-SPC3 | For any agent, specialists are decided twice: at design time from its jobs (never for light agents; only for deep work or jobs spanning different kinds of look-up), and per request by the planner (only 2–4 independent parts, never quick); a planned split starts before the agent's first model call. | §3.4, §16 |
| AC-OP1 | Operator health (admins only): iMessage line status, failed/unconfirmed messages, stuck queues, model failures (incl. out of credit) and job outcomes as alerts; alerts are emailed to ALERT_EMAIL at most hourly; the iMessage stream reconnects itself with backoff. People see plain failure messages, never provider internals. | ops |
| AC-ED1 | Agents are editable after creation: a plain-language change is previewed (nothing saved) and then saved; direct edits to name, emoji, job, tone, jobs, rules, routines, notes and data sources recompile instructions, skills and schedules; only the owner's workspace can edit. | §3 |
| AC-IM1 | Replies are shaped per app: plain text on iMessage/SMS/Telegram (no markdown symbols, tables become lines, links readable), WhatsApp `*bold*`, Slack mrkdwn; web unchanged. Long replies are split at paragraph/sentence boundaries into normal-sized texts. | §6 |
| AC-IM2 | People known only by phone number appear as "someone (…1234)" (never the full number) until they say their name ("I'm Maria"); the agent is told to ask once when it needs a name. | §20.2 |
| AC-IM3 | A 👍/❤️/‼️ tapback on an approval or plan message counts as its first button (approve/go), 👎 as the second; other tapbacks do nothing, and only people allowed to decide can. | §3.7, §6 |
| AC-IM4 | One 1:1 thread on a shared line can hold several of the person's agents: a second deploy code adds rather than replaces, "@Name" switches and sticks, "agents" lists them, and every agent's messages (reminders, results) still arrive in the thread, labeled. | §6 |
| AC-IM5 | Photos are described (text in them transcribed), voice notes transcribed and files read, then handled as ordinary messages; the bytes are kept for files.read; without a media model the agent says plainly it can't see/hear it. | §6 |
| AC-IM6 | The chat shows "…is typing" while the agent works (iMessage, Telegram), and a server restart doesn't strand replies: chats are looked up again by id. | §6 |
| AC-IM7 | Photon shared pool (Free/Pro, no fixed number): the agent texts the person first; only a YES from that same number connects it; STOP opts the number out and blocks new invites; iMessage groups say they need a dedicated line (Business). | §6 |
| AC-IM8 | One number for everything: a known person's first text finds their agent (@Name, or their only one, else it asks which); in a group, "@Pip …" from Pip's owner or a teammate brings Pip in with no code; a friend's own agent joins the same chat on its own Room; guests reach only agents already there; small talk before any agent is silent; the agent sees each speaker as owner / teammate / guest. | §21 |
| AC-SC1 | Recurring schedules support specific days, minutes, weekends and intervals (min 15 min), computed in the person's time zone and correct across daylight-saving changes. | §37 |
| AC-SC2 | Agents schedule in the requester's zone ("Mon/Wed/Fri 7:30", "every 3 hours", wall-clock times), confirm the exact next time, and learn a person's zone from chat (invalid zones refused); the web app sets it from the browser. | §37 |
| AC-R9 | Cancelling a run cancels its waits and pending approvals. | §2.8 |

## Memory (§9, §15.4)

| ID | Criterion | Plan |
|---|---|---|
| AC-MEM1 | Private DM memory never enters a shared room's context; it is available in the DM; provenance is stored. | §9.2, §9.3 |
| AC-MEM2 | Private chats can't write team memory; shared rooms can, explicitly. | §15.4 |
| AC-MEM3 | Workspace knowledge is withheld when an outside guest is in the room. | §9.5 |
| AC-MEM4 | Extraction scopes by room type and dedupes repeats (merging provenance). | §9.4 |
| AC-MEM5 | Retrieval ranks relevant memories first and respects expiry. | §9.6 |

## Channels & identity (§5, §6, §20, §21.6)

| ID | Criterion | Plan |
|---|---|---|
| AC-C1 | Every webhook (Telegram, Slack, WhatsApp, Resend email, iMessage bridge, Twilio) verifies its signature; forged and replayed requests are rejected and logged. | §21.6 |
| AC-C2 | Provider retries are deduplicated; ingestion is separate from processing (no LLM call inside the webhook). | §5.2 |
| AC-C3 | WhatsApp subscription handshake, Slack URL verification, and Slack's duplicate message/app_mention events are handled. | §6.2, §6.4 |
| AC-C4 | Unknown senders become untrusted guests; linking is explicit and verified with single-use codes; the guest's DM moves into the user's own Room. | §20 |
| AC-C5 | Approval cards render natively (Telegram inline keyboard, Slack Block Kit, WhatsApp interactive buttons) and can be decided by button. | §3.7, §5.3 |
| AC-C6 | Agent-owned mailbox: inbound email maps to a Room, quoted text is stripped, replies thread by subject with an idempotency key. | §6.5 |
| AC-C7 | Phone: Twilio speech turns run through the same agent and Room; signatures are bound to the public URL. | §6.6 |
| AC-C8 | Failed deliveries retry and give up after 5 attempts without blocking the run. | §5.3 |
| AC-C9 | Rapid message bursts on a messaging channel are combined into a single run (debounce). | §5.2 |

## API, tenancy, public agents (§2.1, §18, §21.4, §22, §34, §38)

| ID | Criterion | Plan |
|---|---|---|
| AC-A1 | Auth: signup creates a personal workspace; bad credentials and anonymous calls are refused. | §2.1 |
| AC-A2 | Tenant isolation: other workspaces and other people's private rooms are invisible (even to co-admins). | §21.4 |
| AC-A3 | Create an agent from a natural-language description into a draft (job, skills, connections, permissions, channels) without seeing a prompt; edit permissions with validation. | §3.4 |
| AC-A4 | Web chat → approval card → Home "needs attention" → decision API → trace shows approver and connection used. | §3.3, §3.7, §34 |
| AC-A5 | BYOK keys and connection credentials are sealed at rest and never returned or logged; revoke wipes credentials and grants. | §8.4, §21.3 |
| AC-A6 | Invitations, roles and plan limits (agent count, channel availability) are enforced. | §22.1, §29 |
| AC-A7 | Audit export is admin-only; the usage ledger tracks raw resources independently of billing. | §21.5, §22.2 |
| AC-A8 | With `CLERK_SECRET_KEY` set, sign-in is Clerk: the browser trades a verified Clerk session token for the app session; a forged token is refused, an unverified email is refused, an existing account with the same verified email is linked (not duplicated), a new user gets a personal workspace, and password sign-up/login are disabled. | §2.1 |
| AC-PUB1 | Discovery lists the curated first-party agents; install runs onboarding and requests only needed connections. | §17, §18.2 |
| AC-PUB2 | Fork copies configuration only; publishing is curated; risky manifests are flagged for review; invalid manifests are rejected. | §18.4, §18.5 |
| AC-PUB3 | Reviews require meaningful usage; creators see aggregates only. | §18.3, §30 |
| AC-PUB4 | Anonymous trial without an account, upsell after a few turns, hard limit, no external writes. | §38 |
| AC-PUB5 | Template upgrades change configuration but keep the instance's memory and connections. | §2.3 |

## Security hardening (from independent review)

| ID | Criterion | Plan |
|---|---|---|
| AC-S1 | Outside guests can't use workspace connections and can never approve their own actions (approval falls back to workspace admins). | §21.1, §19 |
| AC-S2 | A teammate's private connection needs its owner's approval for any use by someone else, including reads. | §2.6 |
| AC-S3 | Channel conversations can't be hijacked: only admins attach group conversations, DMs can't be attached, existing links are never re-pointed. | §20, §21.4 |
| AC-S4 | The approvals list never shows other people's private rooms. | §21.4 |
| AC-S5 | Only verify/reconnect waits can be resolved by hand, and only by their owner (no stuck runs from forced resumes). | §2.8 |
| AC-S6 | The agent can't lift a human's blocked guard or change a human-owned task. | §15, §33 |
| AC-S7 | Only a bare yes/no/approve/reject reply decides an approval. | §3.7 |
| AC-S8 | Web fetch re-checks every redirect hop and every resolved address (incl. IPv4-mapped IPv6) against private ranges. | §21.1 |
| AC-S9 | Link codes are 8 digits, single-use, and senders are locked out after 5 misses per hour. | §20.2 |
| AC-S10 | Rooms with outside guests and runs that read untrusted content can't write workspace memory. | §9.4, §21.2 |
| AC-S11 | Instances only upgrade to reviewed, published template versions; a version under review doesn't delist the live one. | §18.4, §30 |
| AC-S12 | Cross-workspace agents, drafting against another workspace's keys, and email header injection are refused. | §21.4, §8.4 |
| AC-S13 | Cancelling a task while the model is thinking is final: the late answer can't resurrect it or create approvals. | §2.8 |
| AC-S14 | A requirement change that lands mid-step wins: the stale step stops, approvals for the old requirement are withdrawn, and only the new action runs. | §35.1 |
| AC-S15 | Only the agent's owner or a workspace admin can save a learned skill; examples come only from that room's member-requested runs. | §18.3, §21.1 |
| AC-S16 | Messages addressed to another agent are never folded into someone else's pending task. | §15.2 |
| AC-S17 | Unicode file names download correctly; free-time search inputs are bounded; finished tasks can't be cancelled again. | §21 |
| AC-S18 | Deploy codes can't move a number that belongs to another real account; codes only work on the app and chat type they were issued for; posting a group code links nobody; codes can't be redeemed over (forgeable) email; attempts are rate-limited per sender and globally. | §20.2 |
| AC-S19 | On the shared email line the recipient alias picks the agent and each (sender, alias) is its own conversation, so one sender can't leak across workspaces. | §21.4 |
| AC-S20 | A pre-approval covers only bookings from its own watch, by the person who granted it, in the same conversation — never other venues, people or rooms. | §19 |
| AC-S21 | A watch offers each opening once and pauses after a "no" (resumable with "keep watching"); test mode creates no real watches or memories. | §37 |
| AC-S22 | A crash inside a run fails that run without blocking later messages in the conversation; stale 'running' runs are re-queued after a lease. | §7.2 |
| AC-S23 | Only one open group order per chat, opened by a recognized workspace member — no competing order with someone else's pay link. | §15 |
| AC-S24 | MCP requests re-validate the address on every call and refuse redirects (no SSRF via DNS changes or redirects). | §21.1 |
| AC-S25 | Re-installing Slack from another workspace can't take over an existing Slack connection. | §21.4 |

## Group-chat tools and the agent catalog

| ID | Criterion | Plan |
|---|---|---|
| AC-G1 | Polls & RSVPs in a group chat: numbered options; a bare number, option text, "I vote X" or "I'm in" counts as that person's own vote without tagging; re-votes replace; only the creator or an admin closes; polls close themselves at their deadline. | §15 |
| AC-G2 | Expense splitting: cent-exact splits (the payer absorbs leftover cents), the fewest "X pays Y" transfers, paybacks recorded only from the payer, only people in the chat. Never moves money. | §15 |
| AC-G3 | Shared lists: add with dedupe, check off, show, clear (all or checked-off only). | §15 |
| AC-G4 | Every first-party manifest is valid, categorized (personal / group / team) with an emoji avatar; each new agent's starters do real work on the offline model; plain-words ideas draft the matching agent. | §17, §3.4 |

## Agent interpretation (before deploy)

| ID | Criterion | Plan |
|---|---|---|
| AC-SP1 | A one-line request becomes an explicit Agent Spec the user confirms: a plain-words restatement ("you", not "me"), concrete jobs, gap questions only where the request is silent, boundaries (approvals, never moves money), success signs and rehearsal scenarios. | §3.4 |
| AC-SP2 | Routines stated in plain words ("every Friday at 10am", "weekdays at 7pm", "every morning") become recurring schedules, including weekly ones. | §37 |
| AC-SP3 | The confirmed spec and answers compile into the agent's standing instructions and schedules; rehearsal runs every scenario in the sandbox (nothing reaches a real channel) and grades each one before the agent is added to a chat. | §23 |
| AC-SP4 | The agent spec lists its data needs, each resolved to a real source (built-in tool, a connected account, a website, cited web search, ask the people once, or none = say so); only the catalog can call something built in, and built-in sources add their skill. Rehearsal samples contain no invented facts. | §3 |

## Email & delivery reliability

| ID | Criterion | Plan |
|---|---|---|
| AC-E1 | Agent emails carry a per-conversation Reply-To token (lowercase-safe); a reply or forward to it from any address lands in that same conversation. | §20 |
| AC-E2 | Metadata-only inbound webhooks fetch the message body; HTML-only mail becomes readable text with quoted history (blockquotes) dropped. | §20 |
| AC-E3 | Bounces and complaints mark the address undeliverable; queued messages to it are skipped, not retried. | §20 |
| AC-E4 | Outbound messages are claimed before sending and confirmed after; an interrupted send is parked as 'unconfirmed' and never resent automatically, while a provider refusal is retried normally. | §21.6 |
| AC-S30 | OAuth state is random, stored, single-use, short-lived and bound to the signed-in person who started it; Google uses PKCE (S256); disconnecting revokes the token at Google. | §21 |

## Models & AI billing

| ID | Criterion | Plan |
|---|---|---|
| AC-CR1 | Platform credits mode: open models via OpenRouter with the platform key (tiered defaults, see AC-CR8); OpenRouter's reported cost × markup is billed from the monthly plan allowance. | §8, §22.1 |
| AC-CR2 | A workspace picks its model per profile (any provider:model); a model that returns a malformed tool call falls through to the next in the chain. | §8.3 |
| AC-CR3 | Bring-your-own-key: the workspace's key is used and nothing is billed; keys are sealed and never shown or logged; BYOK never silently spends platform credits; removing the last key returns to credits. | §8, §22.1 |
| AC-CR4 | Any OpenAI-compatible server (Together, Groq, self-hosted Ollama/vLLM) works as a provider; its URL may not point into a private network; model ids with colons survive. | §8, §21 |
| AC-CR5 | When the allowance and credits run out, every platform model call stops (runs fail with a clear message); Stripe Checkout top-ups credit exactly the amount paid, once per session, only with a valid signature; platform admins can grant credits. | §22.1 |
| AC-CR6 | The model catalog lists tool-capable OpenRouter models (live, cached; offline fallback) with open-weight flags, availability for the workspace's mode, and marked-up prices in credits mode. | §8 |
| AC-CR7 | Non-model usage (web searches, browser tasks, platform chat-line messages, phone turns) is priced per unit (overridable) and charged from the same allowance/credits; pre-priced model usage is never charged twice. | §22.1 |
| AC-CR8 | Step-aware routing: short single-step asks run on the cheap tier, research or long plans on the research tier, scheduled work on standard, a pinned profile wins, and stuck tasks escalate to a frontier model (reachable via OpenRouter); every tier is overridable by env. OpenRouter only routes tool calls to providers that support them. | §8.3 |

## Quality gates

| ID | Criterion | Plan |
|---|---|---|
| AC-EV1 | The versioned golden-task suite passes 100% on the offline baseline model across all platform dimensions (tool selection, approval, boundary, completion, response, memory, clarification). | §23.3, §23.4 |
| AC-EV2 | Any real run exports as a golden case (evals/cases/*.json) that replays and passes. | §23.4 |
| AC-Q1 | TypeScript typecheck passes with `strict`. | — |
| AC-UI1 | The web app bundles without errors (Home, Agents, Create Agent, Agent page tabs, Rooms with work panel, Discover/trial, Connections, Activity, Settings). | §3 |
| AC-PG1 | The whole test suite passes on Postgres (DATABASE_URL) as well as SQLite: one SQLite-flavoured SQL source, translated for Postgres; full-text memory search via a GIN index. | §27 |
| AC-TP1 | Temporal engine end to end (real Temporal server + Postgres): a message becomes a workflow that completes; an approval parks the workflow durably and deciding it wakes the same workflow; requests in one conversation run in order. | §27, §37 |
