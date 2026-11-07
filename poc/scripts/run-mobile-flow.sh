#!/usr/bin/env bash
# PoC only. Builds the backend (CommonJS output), migrates a LOCAL Community database, starts
# the server with COMMUNITY_MODE=internal and a test-only outbox email sink, then runs the Dart
# CLI client against it. Never point this at a shared, staging or production database.
#
# Required: COMMUNITY_OWNER_URL (migration owner) and COMMUNITY_APP_URL (runtime role), both
# local. A fresh random BETTER_AUTH_SECRET is generated per run and never written to disk.
set -euo pipefail
: "${COMMUNITY_OWNER_URL:?set COMMUNITY_OWNER_URL to a LOCAL database}"
: "${COMMUNITY_APP_URL:?set COMMUNITY_APP_URL to a LOCAL database}"
case "$COMMUNITY_OWNER_URL$COMMUNITY_APP_URL" in
  *127.0.0.1*|*localhost*) ;;
  *) echo "refusing: Community URLs must be local for this script" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-3100}"
WORK="$(mktemp -d)"
trap 'kill "${SERVER_PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

cd "$ROOT"
npm run build >/dev/null
COMMUNITY_DATABASE_URL="$COMMUNITY_OWNER_URL" node dist/community/migrate.js up

env NODE_ENV=development PORT="$PORT" DATABASE_ENABLED=false \
  ARTIFACT_BASE_URL=https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev \
  COMMUNITY_MODE=internal COMMUNITY_DATABASE_URL="$COMMUNITY_APP_URL" \
  BETTER_AUTH_SECRET="$(openssl rand -base64 48)" \
  COMMUNITY_BASE_URL="http://127.0.0.1:$PORT" \
  COMMUNITY_EMAIL_SINK=outbox-file COMMUNITY_EMAIL_OUTBOX_DIR="$WORK/outbox" \
  node dist/server.js >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 0.2
done
echo "server: $(node --version), pid $SERVER_PID, /health $(curl -s "http://127.0.0.1:$PORT/health")"

cd "$ROOT/poc/mobile_client"
dart run bin/client.dart --base "http://127.0.0.1:$PORT" \
  --outbox "$WORK/outbox/outbox.jsonl" --store "$WORK/token-store.json" \
  --email "poc.mobile.$(date +%s)@example.test"
