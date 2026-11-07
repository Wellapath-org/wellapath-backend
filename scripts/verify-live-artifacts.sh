#!/usr/bin/env bash
# Verifies that every artifact named by a live /config is reachable and that its
# sha256 matches the hash /config publishes. Read-only. Exit 1 on any mismatch.
# Usage: scripts/verify-live-artifacts.sh [config_url]
set -euo pipefail
CONFIG_URL="${1:-https://api.wellapath.org/config}"
MAX_SECONDS="${MAX_SECONDS:-20}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsS --max-time "$MAX_SECONDS" "$CONFIG_URL" -o "$tmp/config.json"
echo "config sha256: $(sha256sum "$tmp/config.json" | cut -d' ' -f1)"
fail=0
for key in $(jq -r '.artifacts | keys[]' "$tmp/config.json"); do
  url=$(jq -r --arg k "$key" '.artifacts[$k].url' "$tmp/config.json")
  want=$(jq -r --arg k "$key" '.artifacts[$k].hash' "$tmp/config.json" | sed 's/^sha256://')
  ver=$(jq -r --arg k "$key" '.artifacts[$k].version' "$tmp/config.json")
  if [ -z "$want" ] || [ "$want" = null ] || [ -z "$ver" ] || [ "$ver" = null ]; then
    echo "FAIL $key: missing hash or version in /config"; fail=1; continue
  fi
  start=$(date +%s%N)
  code=$(curl -sS --max-time "$MAX_SECONDS" -o "$tmp/$key" -w '%{http_code}' "$url" || echo 000)
  ms=$(( ($(date +%s%N) - start) / 1000000 ))
  if [ "$code" != 200 ]; then echo "FAIL $key v$ver: HTTP $code from $url"; fail=1; continue; fi
  got=$(sha256sum "$tmp/$key" | cut -d' ' -f1)
  if [ "$got" = "$want" ]; then echo "OK   $key v$ver ${ms}ms $(stat -c%s "$tmp/$key" 2>/dev/null || wc -c <"$tmp/$key") bytes"
  else echo "FAIL $key v$ver: sha256 mismatch"; fail=1; fi
done
exit $fail
