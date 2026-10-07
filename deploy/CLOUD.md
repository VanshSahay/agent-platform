# Running in the cloud (Fly.io + Postgres)

The app runs as one always-on machine on Fly.io with a Postgres database. No Temporal, no Docker on your laptop: Fly builds the
image. The permanent public link (the Cloudflare Worker) is pointed at the Fly app, so nothing you've shared changes.

## One-time, by the account owner (about 5 minutes)
1. Install the CLI: `brew install flyctl`
2. Sign in (opens a browser; create the account there if you don't have one, a card is required for anything beyond the trial):
   `fly auth login`

That's all that needs you. Everything below is scripted.

## Deploy (run from the repo root)
```bash
fly launch --no-deploy --copy-config --name agent-platform-ellie --region ewr   # creates the app from fly.toml
fly postgres create --name agent-platform-ellie-db --region ewr --vm-size shared-cpu-1x --initial-cluster-size 1 --volume-size 3
fly postgres attach agent-platform-ellie-db --app agent-platform                # sets DATABASE_URL
fly secrets set --app agent-platform MASTER_KEY=$(openssl rand -base64 32) OPENROUTER_API_KEY=… BROWSERBASE_API_KEY=… RESEND_API_KEY=… CLERK_SECRET_KEY=… \
  CLERK_PUBLISHABLE_KEY=… ALERT_EMAIL=… PUBLIC_URL=https://agent-platform.abhinav-679.workers.dev   # values from .env.local / .env.clerk
fly deploy --remote-only
fly status
```
Then point the permanent link at it:
```bash
cd deploy/edge && npx wrangler deploy --var ORIGIN:https://agent-platform-ellie.fly.dev
```

## iMessage once the app is in the cloud
The cloud can't use this Mac's Messages app. Pick one:
- **Photon shared pool** (free/pro, the current choice): DMs only, the agent texts first and the person replies YES. Set on Fly:
  `PROJECT_ID` and `PROJECT_SECRET` (from `agent/.env`, the Photon project), `SHARED_IMESSAGE_LINE=pool`, and leave `IMESSAGE_MODE` unset.
  One machine keeps a stream open to Photon, so no webhook needs registering.
- **Photon Business**: a dedicated number, groups work. Same secrets.
- **Keep this Mac as a relay only**: run just the iMessage bridge here against the cloud database
  (`IMESSAGE_MODE=local DATABASE_URL=<the Fly Postgres URL> bun run src/index.ts` on a different port). When the Mac sleeps,
  only iMessage pauses; everything else keeps running in the cloud.

MASTER_KEY is 32 random bytes in base64 (the command above makes one). Keep it somewhere safe: it encrypts every stored
credential, and losing it means reconnecting every account.

## Moving existing data
`pg_dump` the local database and `pg_restore` into the Fly database (`fly postgres connect` gives a psql shell; `fly proxy 5432`
exposes it locally). Credentials stored by the app are encrypted with MASTER_KEY, so the same MASTER_KEY must be set on Fly.

## Backups
Fly Postgres takes daily snapshots of the volume (restore with `fly volumes snapshots`). `deploy/restore-check.sh` is the
compose-flavoured restore drill; the equivalent on Fly is restoring a snapshot into a scratch database.
