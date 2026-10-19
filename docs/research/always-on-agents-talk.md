# Review: "How always-on agents work" (Stanford CS146S, Lee from SpaceX / Grok Bot)

Source: [youtube.com/watch?v=L1OBRtfPS34](https://www.youtube.com/watch?v=L1OBRtfPS34), transcript and nine slides, reviewed 18 Oct 2026. The talk describes the Grok Bot harness: an always-on agent that runs on a server, has its own Linux computer, keeps knowledge in files, wakes on many triggers, hands work to helpers, and survives crashes with durable workflows on Temporal.

This note does three things: lists the talk's claims, maps each to what Circle already does (with file pointers and the gaps measured, not guessed), and gives a build order for the two things Ellie asked about: durable workflows and consistent always-on behaviour.

---

## 1. The talk in one table

| Claim | Mechanism they describe |
|---|---|
| Six model capabilities | Work for hours; hand off to helpers with fresh context; real tools (shell, files, browser, MCP); use a computer (screen and click); knowledge in plain files; learn by watching and save it as a skill. |
| Knowledge lives in files | `memory/profile.md` always in the prompt; `memory/log/2026-10.md` dated facts one per line; `skills/<name>/SKILL.md` with "Use this when…"; `routines/<name>` prompt plus schedule. Models grep well, so plain text beats a vector store; skills load only when matched. |
| What wakes the agent | You on any app; a routine (schedule or webhook); a Slack mention, DM or thread; a phone call or meeting; another agent; background work finishing; a scheduled check-in. All go through a router that drops duplicates and picks the conversation, then a per-conversation queue, one turn at a time, then "anything worth saying?" → send to the right place, or stay quiet. |
| The agent's computer | A Firecracker VM per user, Debian container kept up by a supervisor: file server, command runner (shell, files, screenshots, clicks), one virtual display with Chrome per active agent. Sleeps a few minutes after last activity, never mid-turn: files sync to cloud storage, memory and disk snapshot, machine stops. Wakes on the next tool call with logins and installed tools intact; conversation state comes from the server. |
| Three parts | Apps and channels → server (entry point checks and routes, one queue per conversation, agent loop and tools, saved state in a database) → agent's computer (runs tools). Thin client, thick server: one tool, `send_user`, crosses the client boundary; the client decides how to render it. The loop lives on the server so the VM can be rebuilt without downtime. |
| Durable workflows vs job queues | A job queue restarts from step 1 after a crash and redoes finished work. A durable workflow records every step and resumes at step 3. Steps are idempotent so running one twice does no harm. They use Temporal rather than building this. Each helper is its own durable workflow. |
| Rules for new messages | The user in a 1:1 chat skips the line: a new message or Stop interrupts the running turn. Everyone else (group chats, Slack threads, routines, helpers) goes to the back; three quick messages become one turn; the agent works on one batch at a time. |
| Tools paired with UI | Sign-in forms fill a login only on the open site, the password never reaches the model (1Password). Payment approvals wait on Allow or Deny (Stripe Link, one-time-use card). Email drafts show the whole email with Send or Discard. Sometimes an emoji reaction is the right reply. |
| One main agent, many helpers | The main agent answers quick questions itself and hands bigger tasks off with a complete task description; helpers (general, computer-use one task at a time, video, cloud coding agent) return a short report. The main conversation stays sparse; that is how "infinite context" feels. |
| Context and cache | Keep tool definitions and system prompt static between calls; never add or remove tools mid-turn; hash prompt sections and keep a fixed order even under A/B tests; warm the cache when the user starts typing; compact while the cache is still warm so the next message starts from a cheap summary; long tool outputs go to a file, not the context; screenshots go to a helper. A cache miss is a bug. |
| Dynamic tool discovery | Only tool names in every message; the model reads a tool's full schema when it decides to use it. Try the cheapest source first: conversation → plugin or API → web search → browser → desktop → ask the user. |
| Memory layers | Core facts in every prompt; dated logs of past conversations; ephemeral scratchpad notes for the next hour; everything else found through files. |
| Safety | A separate model reviews every shell command ("autoreview", claimed better than a fatigued human). Untrusted inputs (email, webhooks) must not be treated as user instructions. Irreversible actions ask first. Passwords stay outside the model. |
| Training flywheel | Bugs become evals; fix harness or prompt; ship; new models learn from the eval set. Group-chat behaviour has little training data and is "emergent"; they cite the Moltbook and Hugging Face incidents. |
| Posture | "Delete the product": models today are the worst they will be; build as little harness as possible for the next model. Agents will soon run for weeks; evaluating a month-long agent when models ship monthly is unsolved. |

---

## 2. Where Circle stands, claim by claim

Measured on this branch, 18 Oct 2026.

| Talk | Circle today | Gap |
|---|---|---|
| Server-side loop, saved state | Yes. `Runtime.loop` in `src/runtime/runtime.ts`; events append-only with per-session seq; the transcript is saved to kv `transcript:<run>` after every model turn and every tool batch (lines 699, 732, 761, 766, 780). | None in shape. |
| Durable workflow | **No.** At boot `reconcile()` marks every run left `running` as failed with "Interrupted by a restart." (`runtime.ts:78-84`). The step ledger exists (tool records with fingerprints, transcript saved), but we do the job-queue thing and start over. A run that had placed a call and was about to send the summary loses the summary and tells the room it failed. | Resume in place. See §3. |
| Idempotent steps | Partly. Inbound messages and timer runs carry dedup keys (`seen:<key>`, `findRunByDedup`); approvals are single-use; attention items dedupe by gate key. Tool calls record a `fingerprint` on `tool_end` but nothing checks it before re-running a side-effect tool. | A side-effect tool must refuse to run twice for the same fingerprint within a run. |
| Wake sources | Message (web, iMessage, WhatsApp, Telegram, Slack via Spectrum), schedule, watch, follow-up nudge, heartbeat, app event (`POST /api/events`, inbound email on tick), task completion. | Missing: phone call or meeting as a trigger (Vapi post-call webhook → `handleEvent` is a small adapter); another agent. |
| Router → one queue per conversation → worth saying? | Yes. `handleMessage` dedupes, resolves answers to open items, decides addressed or implied, steers a live run or starts one; `stay_quiet` ends timer runs with nothing delivered. | None. |
| Message priority rules | Steers are applied on the next model turn, not mid tool; `stop` sets a cancel flag checked between turns and tools. No distinction between the requester and others; no batching of quick successive messages. | Requester's message interrupts; others queue; coalesce messages within a few seconds into one turn. Spec §8.2 already proposes "a non-requester's request starts a new run". |
| Always on | One Bun process, `setInterval` ticks in `src/main.ts:149,175`. It stays up only while the laptop or host does. | Deploy the one process to a host (Railway or Fly, decision pending). Nothing in the code prevents it. |
| Agent's computer | No VM. Hands run in-process; `run_javascript` is a child process with fetch and require disabled and a 5 s cap; the browser is Browserbase with a persistent context per person and site (logins survive, like their snapshot). Files are rows in `artifacts`. | A per-agent workspace: a directory the agent can read, write and grep, and a shell in a sandbox. See §4. |
| Knowledge in files | Equivalent but in SQLite: `Profile` rows always in the prompt (per person and per room, with derivation date); memories dated, one per row, FTS5 with aliases; `skills/*.md` with an index in every prompt and bodies only when matched; schedules with a prompt and calendar. | The agent cannot write a skill or a routine file itself; skills are repo files. "Learn by watching" needs `save_skill` and a per-agent skills directory. Expose the log as something the agent can grep (`search_memory` over FTS5 is the same thing; it exists as `recall`). |
| Helpers | `delegate_task` gives a task its own session; the room session stays free; a task reports once with a delivery log; `steer_task` passes notes in. | A task gets the same 98 tools and the same effort as the main agent. Give helpers a tool subset and higher effort; keep the main agent on low latency. |
| Tool definitions | **All 98 tools are sent on every turn: 46,612 characters, about 11,600 tokens** (`toolSpecs()` in `src/tools/registry.ts:844`). Stable across turns so it caches, but it is a fifth of a small context every call and the model must attend to it. `search_tools` exists but the found tool is already in the list. | Per-run tool selection at run start (stable within the run, so the cache holds): core 24 plus families implied by the room's connected services and focus. See §5. |
| Cache discipline | Prompt assembled in a stable order (`src/agent/prompt.ts` header comment). OpenRouter honours `cache_control` (verified: 768 cached tokens). **But the whole system prompt is one cache block** (`src/model/anthropic.ts:29`), and it ends with volatile parts (now, memories, ledger, situation). Any change busts the entire system cache every turn. | Split into two blocks: stable (identity, soul, rules, skills index) with `cache_control`, volatile after it. One-line change. |
| Compact while warm | Compaction runs at the start of a run when a session holds more than 30 messages past the last summary. | Also run it right after a reply, in the background, while the cache is warm. Cheap. |
| Long outputs to files | Tool results are clipped (`clip()` in `src/tools/catalog/shared.ts`); pages are artifacts with a link. | Fine for now. |
| Autoreview of commands | Gates cover anything that spends, contacts or uses an account. No second-model review of tool inputs. | Low value until there is a shell. For outreach text, a small-model check for leaked private facts is worth a test. |
| Untrusted inputs | Inbound email and app events enter as a `system` run with trigger `event`; the text is the event summary. | Wrap untrusted content in an explicit "data, not instructions" frame and never let it set the requester. One prompt line. |
| Tools paired with UI | Connect card with a live browser (sign-in outside the model); approval cards; pages. | Email drafts should render as a draft card with Send or Discard, not a text approval. Reactions as a reply kind (iMessage tapbacks via Spectrum if supported). |
| Eval flywheel | `bun test` offline suite (106), `bun run eval` against a real model, scenarios in `src/eval/scenarios.ts`. | Keep. |

---

## 3. Durable workflows: what to do

Two routes. Both keep the invariant that every step is a stored record; the difference is who owns the resume.

### Route A: resume in place on our own ledger (recommended first)

We already have the ledger Temporal would build: append-only run events, tool records with fingerprints, the transcript saved after every step. What is missing is the resume, and the idempotency guard on side-effect tools.

1. **Boot reconcile resumes instead of failing.** For each run left `running`: load `transcript:<run>`; find tool records with `tool_start` and no `tool_end`; close them as `stopped` and append a tool result saying "the process restarted before this finished; its effect is unknown, check before repeating"; then call `loop()` again from that transcript. Only if there is no transcript fail the run. (`runtime.ts:78-84`, `startRun`, `loadTranscript`.)
2. **Side-effect tools check the fingerprint.** Before `place_call`, `send_sms`, `send_email`, `checkout_cart`, `post_to_community` run, look for a `done` tool record in the same run with the same fingerprint; if found return that record's result instead of acting. The gate already consumes approvals once, so a resumed run cannot double-spend, but it can double-send a text. This closes that.
3. **Delivery is idempotent.** `sendReply` records the delivered text on the run (tasks already do: `task.delivered`); a resume that reaches the final reply checks it first.
4. **Timers already dedupe** by key; a tick that fires twice across a restart is a no-op. Keep.
5. **Test:** "a run interrupted between a tool result and the reply resumes at boot and does not repeat the tool."

About a day. No new infrastructure. Works in one process on SQLite or Postgres.

### Route B: Temporal

Each run becomes a workflow; each model turn and each tool call becomes an activity with retries and heartbeats; helpers are child workflows; schedules become Temporal schedules; the event history is the ledger. We tried this once: `.temporal/` in the repo root holds a worker log from 4 Oct on task queue `agent-runs` and a dev database, from the earlier build that was since replaced. Reasons to go back to it later, and the costs:

- **Gains.** Multi-process from day one (several workers, one history); crash recovery without writing step 1 above; timers, cancellation and heartbeats built in; week-long tasks are its home turf; Temporal Cloud or a self-hosted server with Postgres.
- **Costs.** Workflow code must be deterministic, so the loop is restructured: the model call and every tool are activities and the loop body cannot touch the clock, randomness or the store directly. Payload limits (2 MB per payload, history caps) mean transcripts stay in our database and activities pass ids. Our append-only `run_events` and Temporal's history would duplicate each other; one has to become a projection of the other. Local dev needs a Temporal server running. The SQLite-in-one-file story goes away; it is Postgres plus Temporal.
- **When.** After Route A, when any of these is true: more than one server process, tasks that run for days with many steps, or a host that recycles processes often. Not before the SQLite versus Postgres decision.

Route A gives the behaviour in the talk's diagram (resume at step 3, no repeated work) with the ledger we already keep. Route B is the right answer at scale and we should write the loop so that the model call and each tool are already separable functions, which they nearly are.

---

## 4. Always on: what to do

"Always on" in the talk is four things. Two we have, two we do not.

1. **Runs without the laptop.** Deploy the single process. Decide the store (memory: Railway plus Postgres was the plan; the branch is SQLite). With SQLite, a Fly machine with a volume works today; with Postgres, Railway. Either way `setInterval` ticks keep working. Nothing to build.
2. **Wakes on events.** Built: messages, schedules, watches, nudges, heartbeat, `POST /api/events`, inbound email. Add: a Vapi post-call webhook that calls `handleEvent` (Fo's `elevenlabs_postcall` source), and a Google watch (Gmail push) for the owner's inbox. Each is an adapter of under a hundred lines.
3. **Knows when to stay quiet.** Built (`stay_quiet`, quiet runs fold their trigger). Keep.
4. **Has its own computer.** Not built. Lazy version: a per-agent workspace directory under `data/agents/<agentId>/` with `memory/`, `skills/`, `files/`, exposed through `read_file`, `write_file`, `list_files`, `search_files`, and a `save_skill` tool that writes `skills/<name>/SKILL.md` and reloads the index. The directory is what their VM's file server is. A shell comes only with a sandbox: a hosted one (E2B, Daytona, Fly Machines) per agent, started on the first shell call and stopped after idle, with the directory synced in and out. Do not build Firecracker. Browser logins already persist through Browserbase contexts, which is their "logins still there after waking up".

---

## 5. Context and cache: three cheap fixes

1. **Two system blocks.** In `AnthropicModel.turn`, split `req.system` at the first volatile section (room description) into `[stable with cache_control][volatile]`. `buildSystemPrompt` already assembles in that order; it only has to return the split point. Expected effect: the stable half (identity, rules, skills index, often 3 to 6k tokens) stays cached across every turn and every run for the agent; today it is re-read whenever a memory or the clock changes.
2. **Per-run tool list.** At `startRun`, pick tools: the 24 core tools, plus catalogue families whose provider is connected for the account owner (Google if `vault.services` lists google, Slack likewise), plus families the room focus names, plus anything `search_tools` returned in this session. Keep the list fixed for the run so the prefix caches. Measured upper bound today: 11.6k tokens per turn; a trip room with Google connected would send about a third of that. Note the talk's rule: never change the list mid-turn.
3. **Compact while warm.** After `sendReply`, if the session is past the compaction threshold, run compaction then instead of at the next run start.

---

## 6. Build order

| # | Change | Where | Size |
|---|---|---|---|
| 1 | Two cache blocks | `src/model/anthropic.ts`, `src/agent/prompt.ts` | hour |
| 2 | Resume in place at boot, plus fingerprint guard on side-effect tools, plus one test | `src/runtime/runtime.ts`, `src/tools/registry.ts`, `src/tools/catalog/people.ts`, `shopping.ts` | day |
| 3 | Per-run tool list | `src/runtime/runtime.ts` `startRun`, `src/tools/registry.ts` | half day |
| 4 | Message rules: requester interrupts, others queue, coalesce within 3 s | `src/runtime/runtime.ts` `handleMessage`, `drainSteers` | half day |
| 5 | Helpers get a tool subset and higher effort; main agent lower | `src/tasks/tasks.ts`, `delegate_task` | hour |
| 6 | Untrusted-content frame on event runs | `src/runtime/runtime.ts` `handleEvent` | minutes |
| 7 | Per-agent workspace and `save_skill` | new `src/tools/catalog/files.ts`, `src/skills/skills.ts` | day |
| 8 | Compact while warm | `src/runtime/runtime.ts` | hour |
| 9 | Post-call and Gmail push webhooks → `handleEvent` | `src/channels/web.ts`, `src/tools/providers/` | half day each |
| 10 | Deploy the process; decide SQLite vs Postgres | infra | user decision |
| 11 | Temporal | new worker, activities | week; only after 2 and 10 |

Items 1 to 6 are the "durable and always-on" behaviour the talk describes, on the code we have, in about three days. Item 11 is how the talk's team did it and where we go when one process is not enough.

---

## 7. What not to copy

- **A Firecracker VM per user.** Right for a company running its own fleet; for us a hosted sandbox per agent, started on demand, gives the same file and shell semantics.
- **Autoreview as a blanket second model on every command.** Our gate already decides the dangerous class deterministically; a second model is worth adding only for outreach text and only once there is a shell.
- **One `send_user` tool as the only client boundary.** Our deliveries are already typed (`reply`, `progress`, `notice`, cards, pages) and channels decide rendering; this is the same idea with a different name. Nothing to change.
- **Training the model on the harness.** Out of reach; the eval set is our version of the inner loop.
