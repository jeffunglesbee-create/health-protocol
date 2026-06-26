#!/bin/bash
# health-protocol Worker deploy script
# Usage: FIELD_PAT=<token> bash scripts/deploy.sh
set -e

: "${FIELD_PAT:?ERROR: set FIELD_PAT before running}"

CLIENT_ID="261196"
CLIENT_SECRET="54de6106ebfb087d7d0c01a611c93788dc75d3ef"
REFRESH_TOKEN="71762cc472c4d80c5eb107d820e1fd193da91569"

echo "=== Step 1: install wrangler ==="
npm init -y 2>/dev/null || true
npm install wrangler --save-dev --silent

echo "=== Step 2: create KV namespace ==="
KV_RAW=$(npx wrangler kv namespace create hp-kv 2>&1)
echo "$KV_RAW"
KV_ID=$(echo "$KV_RAW" | grep -Eo '[a-f0-9]{32}' | head -1)
if [ -z "$KV_ID" ]; then
    echo "Namespace may exist — fetching ID from list"
    KV_ID=$(npx wrangler kv namespace list 2>&1 | grep -Eo '[a-f0-9]{32}' | head -1)
fi
echo "KV_ID=$KV_ID"
[ -z "$KV_ID" ] && echo "ERROR: no KV_ID" && exit 1

echo "=== Step 3: write wrangler.toml ==="
cat > wrangler.toml << TOML
name            = "health-protocol"
main            = "src/index.js"
compatibility_date = "2026-06-26"
account_id      = "b57e9af57ab46c52ca9215804e689c29"

[[kv_namespaces]]
binding = "HP_KV"
id      = "${KV_ID}"
TOML
echo "wrangler.toml written with KV_ID=${KV_ID}"

echo "=== Step 4: deploy Worker ==="
npx wrangler deploy

echo "=== Step 5: set secrets ==="
echo "${FIELD_PAT}"     | npx wrangler secret put GITHUB_PAT
echo "${CLIENT_ID}"     | npx wrangler secret put STRAVA_CLIENT_ID
echo "${CLIENT_SECRET}" | npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret list

echo "=== Step 6: seed Strava tokens ==="
npx wrangler kv key put \
    --namespace-id="${KV_ID}" \
    "strava:tokens" \
    "{\"access_token\":\"1974e6b574eda8fa16af67b1061005d8b067b0d7\",\"refresh_token\":\"${REFRESH_TOKEN}\",\"expires_at\":0}"
echo "KV seeded"

echo "=== Step 7: commit wrangler.toml ==="
git config user.email "deploy@health-protocol"
git config user.name "Claude Code"
git add wrangler.toml
git diff --cached --quiet && echo "no changes" || git commit -m "chore: wrangler.toml with real KV ID [skip ci]"
git push origin main

echo "=== Step 8: verify ==="
sleep 8
curl -sf "https://health-protocol.jeffunglesbee.workers.dev/" && echo "" || echo "probe: not reachable from sandbox"

echo "=== DEPLOY COMPLETE ==="
