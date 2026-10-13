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
- Model: `claude-opus-5-5` through the Anthropic SDK (`src/model/anthropic.ts`); thinking is adaptive, depth via `output_config.effort`. Do not add other providers or shims.

## Where things live

`src/runtime/runtime.ts` is the run loop and the single gate policy. `src/tools/registry.ts` lists every tool with its labels and family. `src/tools/hands.ts` holds the external capability interfaces and their fakes; real adapters implement those interfaces and are injected in `src/main.ts`. `skills/*.md` are procedures the agent reads when a task matches; edit them like prompts.

## Style

Short files, plain names, no frameworks. Comments explain why, not what. Tests describe behaviour in a sentence.
