# Runbook

How to deploy, watch, stop, back up and restore Circle, and what it costs to keep running. Written for whoever operates the deployment, with no help from the person who built it. Commands assume the Fly CLI (`fly`) is installed and signed in to the account that owns the app, and that you are in the repository root.

## What runs where

One Bun process (`src/main.ts`) on one always-on Fly machine. It serves the web app and the API, keeps the chat channels connected (Photon Spectrum: iMessage and the others in `CHANNELS`), and runs three background loops in the same process:

| Loop | Every | Does |
|---|---|---|
| scheduler tick | `TICK_MS` (30 s) | fires due schedules and reminders, nudges responsibilities, turns page edits into events, expires stale questions, runs heartbeats, reads the assistant's inbox |
| backup | checks every 10 min, copies once a day | `VACUUM INTO /data/backups/`, keeps `BACKUPS_KEPT` (7) |
| memory pass | 03:00 in each owner's zone | promotes the day's observations into durable memory |

All state is one SQLite file on the Fly volume, `/data/circle.sqlite`, with daily copies in `/data/backups/`. Secrets live in Fly's secret store, never in the image or the repository.

## First deploy

1. Copy `.env.example` to `.env` and fill it in. Required: one model key (`OPENROUTER_API_KEY`, or `ANTHROPIC_API_KEY`), `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` (sign-in; the server refuses a public address without it), `PUBLIC_URL`. For iMessage: `PROJECT_ID`, `PROJECT_SECRET`, and `IMESSAGE_PHONE` on a dedicated line. Recommended: `OWNER_EMAIL` (only that address can claim the owner's seat), `OPERATOR_EMAILS` (who reads the error log), `EVENT_TOKEN` (for webhooks and an external cron). Everything else is optional; see [provisioning.md](provisioning.md) for what each unlocks.
2. Pick the app name and the Fly organisation that will own it (the Company's, so the deployment never depends on a personal account):
   ```bash
   APP=circle-agent ORG=<company-org> REGION=sjc scripts/fly-setup.sh
   ```
   It creates the app and a 1 GB volume, copies every key present in `.env` into Fly secrets, mints `MASTER_KEY` once (a re-run keeps the existing one), and deploys. If you change `APP`, change `app` and `PUBLIC_URL` in `fly.toml` to match.
3. **Save `MASTER_KEY` somewhere safe** (a password manager): `fly ssh console --app circle-agent -C 'printenv MASTER_KEY'`. It encrypts members' saved sign-ins. If it is lost or replaced, those sign-ins cannot be read and each person must sign in again. Nothing else is lost.
4. Add the Fly domain (or your own) to `CLERK_AUTHORIZED_PARTIES`: `fly secrets set CLERK_AUTHORIZED_PARTIES=https://circle-agent.fly.dev`.
5. Open `PUBLIC_URL`, sign in with `OWNER_EMAIL`, and check `https://<app>.fly.dev/health` returns `"ok": true`.

## Deploy an update

```bash
bun test && bun run typecheck                                       # offline, under two seconds
fly ssh console --app circle-agent -C 'bun run src/ops/backup.ts'   # a copy to roll back to; prints its path
fly deploy --app circle-agent
curl -s https://circle-agent.fly.dev/health
```

The deploy replaces the machine. Runs that were mid-flight resume from their saved transcript on boot; completed outside actions are never repeated (the idempotency guard refuses an exact repeat). Schedules, waiting approvals and reminders are rows in the database and survive.

Database changes are forward-only migrations that run at boot (`src/store/db.ts`). An older image can read a newer database only if no migration ran in between, so a rollback across a migration also means restoring the backup taken before the deploy.

## Roll back

```bash
fly releases --app circle-agent --image          # find the last good image
fly deploy --app circle-agent --image <registry.fly.io/circle-agent:deployment-...>
```

If the bad release migrated the database, restore the copy you took before it (below), then roll back the image.

## Restart

```bash
fly machine list --app circle-agent
fly machine restart <machine-id> --app circle-agent
```

What survives a restart: every conversation, task, schedule, reminder, waiting approval and memory. A run that was mid-flight resumes from its last saved step; one that cannot resume is marked failed with the reason and the chat is not left believing it finished. Delegated tasks with no live run are restarted.

## Health

`GET /health` is public and carries no private data:

```json
{ "ok": true, "db": true, "loops": { "scheduler": { "lastAt": 1761200000000, "ok": true } },
  "channels": { "imessage": { "state": "up", "since": 1761190000000 } }, "recentErrors": 0, "bootAt": 1761190000000, "auth": true }
```

- `ok` is false (HTTP 503) when the database cannot be read, or the scheduler has missed three beats (a tick stuck for over 20 minutes stops the beat). Fly checks `/health` every 30 seconds (`fly.toml`), stops routing to a failing machine, and shows it in `fly status`. **Fly does not restart a machine on a failing check.** Restart it yourself (above), and point an uptime monitor (any free one) at `/health` to be told.
- `channels.<name>.state` is `starting`, `up` or `down`. A channel that is down does not fail the check, because a restart does not fix the provider. Look at the error log, check the Photon dashboard, then restart.
- `recentErrors` is the count in the last hour.

## Error log

Errors from the loops, the channels and the web server go to two places: the process log (`fly logs --app circle-agent`) and a table in the database that survives restarts. It is pruned to the newest 1,000 entries. Anything shaped like a key, a bearer token or a `token=` value is removed before either is written.

Operators read it in a browser, signed in, at `/api/ops/errors` (`?since=<unix ms>&limit=<n>`, newest first, with the health report on top). The operators are the people whose sign-in emails are listed in `OPERATOR_EMAILS`. Without that setting, the owner of the oldest assistant is the operator.

## Inspect and stop

In the web app, signed in as the owner:

- **Home → On radar** lists everything in flight: errands working, waiting on someone (named), or **blocked** (waiting on a sign-in only that person can give, or a question that expired), plus background tasks with their progress. **Why?** opens a run's plan, every tool call with its evidence, and its events. **Stop** ends it. The person who asked, or the owner, may stop it.
- **Home → Last activity** lists finished runs. Filter by *Didn't finish*, *Stopped* or *Done*.
- **Settings → Assistant → Off switch** pauses an assistant entirely. It stops everything in flight, starts nothing new, and holds schedules and reminders until it is turned back on, when they fire. Messages that arrive while it is paused are kept.

Every stop posts a notice in the chat, written by code rather than the model, naming the request it stopped and which outside actions had already completed (`Stopped "text the clinic" (Alex). Already done before the stop, and not undone: Sent a text.`) or that nothing outside had been done.

The same through the API: `POST /api/runs/:id/stop`, `POST /api/tasks/:id/stop`, `PATCH /api/agents/:id {"paused": true}`; `GET /api/runs/:id` for the record.

## Backup and restore

There are two layers:

- **Daily copies on the volume**, `/data/backups/circle-<time>.sqlite`. The newest `BACKUPS_KEPT` (7) are kept. These protect against a bad migration or a corrupted file.
- **Fly volume snapshots**, taken daily by Fly and kept 5 days by default (`fly volumes snapshots list <volume-id>`). These protect against losing the volume. Copy a backup off the machine too, for anything you cannot afford to lose:
  ```bash
  fly ssh console --app circle-agent -C 'bun run src/ops/backup.ts'          # take one now; prints the path
  fly ssh sftp get /data/backups/<file> ./circle-backup.sqlite --app circle-agent
  ```

To restore, stage the file and restart. At boot the server checks the staged file's integrity and refuses a corrupt one. It then moves the current database to `/data/backups/pre-restore-<time>.sqlite`, so the restore itself can be undone, and puts the staged file in its place:

```bash
fly ssh sftp shell --app circle-agent
» put ./circle-backup.sqlite /data/restore.sqlite
fly machine restart <machine-id> --app circle-agent
fly logs --app circle-agent | grep Restored
```

To restore from a Fly snapshot instead, create a volume from it (`fly volumes create data --snapshot-id <id> --region sjc`), then move the machine onto it, or copy its file into `/data/restore.sqlite` as above.

## Several assistants

Settings → Assistant shows every assistant you own. **+ New assistant** makes another, and each has its own name, memory, chats, model (empty means the server's default), and the tool families and skills it may use. Planning, asking people, reminders, memory and staying quiet are always on.

**Answers on iMessage** picks which assistant a group gets when it adds the line. Chats already running keep theirs; **Who answers here**, under each chat, hands one to another of your assistants. The messages stay with the chat, and what the old assistant noted stays with it. No code changes per group, and members need no web sign-up to make a basic request.

## iMessage provisioning

Circle reaches iMessage through Photon Spectrum (`PROJECT_ID`, `PROJECT_SECRET` from the Photon dashboard).

- **Shared pool (Free and Pro):** one-to-one only. Each person registers the number they text from, under Settings → Channels. It cannot join group chats.
- **Dedicated line (Business, $250 a month per line at the time of writing, so confirm with Photon):** Circle has its own number. People add it to new or existing group chats like a friend. Set `IMESSAGE_PHONE` to the line's number. **Real group chats need this plan.**

- **Local mode (`IMESSAGE_MODE=local`, free):** iMessage through a Mac's own Messages app with Photon's open-source local provider, with no project credentials. The Apple ID signed into Messages is the agent's handle, and existing group chats work. It needs a Mac that stays on and Full Disk Access for the process. Setup is in [imessage-local.md](imessage-local.md). Good for testing real groups before a dedicated line exists; use a dedicated Apple ID, never a personal one.

**One Photon project per running copy.** Photon delivers each text to every server connected to the project, so a laptop and the deployment sharing one project both answer, the laptop without the deployment's history. Give local testing its own project.

After changing either: `fly secrets set PROJECT_ID=... PROJECT_SECRET=... IMESSAGE_PHONE=+1...`. Fly restarts the machine on a secret change. `/health` shows `channels.imessage.state` as `up` once connected.

## Secrets

Change one with `fly secrets set NAME=value --app circle-agent` (this restarts the machine), and list names with `fly secrets list`. Never change `MASTER_KEY` on a live database (see First deploy). To rotate a provider key, set the new one, check `/health` and the error log, then revoke the old one at the provider.

## Operating costs

Monthly, at the scale of a family or a small group. These are not purchases made by the developer, and every figure should be confirmed at signup. [provisioning.md](provisioning.md) has the full list by capability.

| Item | Cost shape |
|---|---|
| Fly machine (shared-cpu-1x, 512 MB) + 1 GB volume | about $3.50/month; snapshots beyond the free allowance are a few cents per GB |
| Model (OpenRouter, DeepSeek V4.1 Flash by default) | usage: $0.15 per million input tokens, $0.60 per million output; Claude Opus 5.5 direct is $4 / $20 |
| Photon Spectrum | shared pool free or Pro; a dedicated iMessage line (needed for groups) $250/month per line |
| Clerk sign-in | free tier, then about $25/month |
| Browserbase (cloud browser) | plan hours, then about $0.10–0.12 per session-hour |
| Optional hands | calls (Vapi), SMS (Twilio), voice (ElevenLabs), mailbox (AgentMail), hotel and public-rate lookups (LiteAPI, Apify): each costs only when keyed, see provisioning.md |

`bun run spend:prod` prints what the deployment actually spent today, this week and this month, per provider, with the dearest runs.
