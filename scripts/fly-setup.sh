#!/usr/bin/env bash
# One-time Fly.io setup for Circle: app, volume, secrets from .env, first deploy. Needs `fly auth login` and a card on the Fly account.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=${APP:-circle-agent}
REGION=${REGION:-sjc}
fly apps create "$APP" --org personal 2>/dev/null || true
fly volumes create data --app "$APP" --region "$REGION" --size 1 --yes 2>/dev/null || true
# Every secret production needs, read from .env without printing; MASTER_KEY is minted fresh for the new database.
vars=()
for k in OPENROUTER_API_KEY BROWSERBASE_API_KEY BROWSERBASE_PROJECT_ID CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY CLERK_AUTHORIZED_PARTIES PROJECT_ID PROJECT_SECRET LITEAPI_API_KEY APIFY_TOKEN HOTEL_MARKUP_PCT HOTEL_SITE_URL; do
  v=$(grep "^$k=" .env | head -1 | cut -d= -f2- || true)
  [ -n "$v" ] && vars+=("$k=$v")
done
vars+=("MASTER_KEY=$(openssl rand -hex 32)")
fly secrets set --app "$APP" --stage "${vars[@]}" >/dev/null
echo "secrets staged: ${#vars[@]}"
fly deploy --app "$APP" --ha=false
