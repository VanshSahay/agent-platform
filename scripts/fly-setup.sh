#!/usr/bin/env bash
# One-time Fly.io setup for Circle: app, volume, secrets from .env, first deploy. Safe to re-run.
# Needs `fly auth login` on the account that will own the deployment, and a card on that account.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=${APP:-circle-agent}
REGION=${REGION:-sjc}
ORG=${ORG:-personal}
# Real errors (no card on the account, name taken by someone else) stop the script; "already exists" is fine.
fly status --app "$APP" >/dev/null 2>&1 || fly apps create "$APP" --org "$ORG"
fly volumes list --app "$APP" | grep -q "data" || fly volumes create data --app "$APP" --region "$REGION" --size 1 --yes
# Every secret the server reads, copied from .env when present, never printed.
vars=()
for k in OPENROUTER_API_KEY ANTHROPIC_API_KEY MODEL MODEL_SMALL IMAGE_MODEL \
  CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY CLERK_AUTHORIZED_PARTIES OWNER_EMAIL OPERATOR_EMAILS EVENT_TOKEN ASSISTANT_NAME \
  PROJECT_ID PROJECT_SECRET CHANNELS IMESSAGE_PHONE \
  BROWSERBASE_API_KEY BROWSERBASE_PROJECT_ID BROWSERBASE_SEARCH_MODE BROWSERBASE_USD_PER_HOUR \
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET AGENTMAIL_API_KEY AGENTMAIL_INBOX RESEND_API_KEY EMAIL_FROM \
  VAPI_API_KEY VAPI_PHONE_NUMBER_ID TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID \
  STRIPE_SECRET_KEY STRIPE_CARDHOLDER_ID BRAVE_API_KEY SEARCH \
  LITEAPI_API_KEY APIFY_TOKEN HOTEL_MARKUP_PCT HOTEL_SITE_URL PUBLIC_RATES PUBLIC_RATES_DAILY_CAP_USD FLY_USD_PER_MONTH BACKUPS_KEPT; do
  v=$(grep "^$k=" .env | head -1 | cut -d= -f2- || true)
  [ -n "$v" ] && vars+=("$k=$v")
done
# MASTER_KEY encrypts members' saved sign-ins. Mint it once; replacing it makes every saved credential unreadable.
if ! fly secrets list --app "$APP" | grep -qw MASTER_KEY; then
  vars+=("MASTER_KEY=$(openssl rand -hex 32)")
  echo "MASTER_KEY minted. Copy it somewhere safe now: fly ssh console --app $APP -C 'printenv MASTER_KEY' after the deploy."
fi
fly secrets set --app "$APP" --stage "${vars[@]}" >/dev/null
echo "secrets staged: ${#vars[@]}"
fly deploy --app "$APP" --ha=false
