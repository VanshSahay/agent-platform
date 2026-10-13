# Working in this repo

Circle is a personal agent that lives in group chats. Read `docs/design.md` before changing behaviour; it is the spec. `README.md` carries the status line per capability and must stay honest.

## Commands

- `bun test` runs the offline suite (scripted model, fake hands). Keep it under a second.
- `bun run typecheck` must pass; `strict` and `noUncheckedIndexedAccess` are on.
- `bun run demo` plays the handyman errand end to end offline; run it after touching the runtime, gates or planner.
- `SEED_DEMO=1 bun run start` boots the web UI on port 3000; without credentials the model is an offline stand-in.

## Rules that are not negotiable

- The agent never claims an action without a stored tool call with evidence. Footers come from `buildFooter`, never from model text.
- Anything that contacts a third party, spends money or uses an account goes through `Runtime.gate`. New side-effect tools call `ctx.gate` and return `waitingOn` when not granted.
- The agent writes only `observation` memories during a run (owner rules excepted). Durable memory is written by `Consolidator`.
- Memory and messages carry scope and visibility; context assembly filters by room. Do not add a code path that reads memory without going through `MemoryService.visibleIn` or `recall`.
- Events are append-only with a per-session `seq`. Never update or delete a run event.
- Model: the Anthropic SDK (`src/model/anthropic.ts`) through one of two doors chosen in `src/model/config.ts`: OpenRouter (default `z-ai/glm-5.3`, small `z-ai/glm-5.3-flash`) or Anthropic directly (Claude Opus 5.5 / Haiku 5.5). Both speak the Messages shape with tools and effort. Do not add OpenAI-style adapters; change `MODEL` instead.
- Secrets live only in `.env` (gitignored). Never write a key into code, docs, tests or commit messages.

## Where things live

`src/runtime/runtime.ts` is the run loop and the single gate policy. `src/tools/registry.ts` lists every tool with its labels and family. `src/tools/hands.ts` holds the external capability interfaces and their fakes; real adapters implement those interfaces and are injected in `src/main.ts`. `skills/*.md` are procedures the agent reads when a task matches; edit them like prompts.

## Style

Short files, plain names, no frameworks. Comments explain why, not what. Tests describe behaviour in a sentence.
