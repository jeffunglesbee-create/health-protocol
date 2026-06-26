#!/bin/bash
# health-protocol Worker deploy script
# Run from health-protocol repo root: bash scripts/deploy.sh
set -e

CLIENT_ID="261196"
CLIENT_SECRET="54de6106ebfb087d7d0c01a611c93788dc75d3ef"
REFRESH_TOKEN="71762cc472c4d80c5eb107d820e1fd193da91569"
# FIELD_PAT: substitute actual value from memory before running

echo "=== Step 1: install wrangler ==="
npm init -y 2>/dev/null || true
npm install wrangler --save-dev --silent

echo "=== Step 2: create KV namespace ==="
KV_RAW=$(npx wrangler kv namespace create hp-kv 2>&1)
echo "$KV_RAW"
KV_ID=$(echo "$KV_RAW" | grep -Eo '[a-f0-9]{32}' | head -1)
if [ -z "$KV_ID" ]; then
    KV_ID=$(npx wrangler kv namespace list 2>&1 | grep -A1 "hp-kv" | grep -Eo '[a-f0-9]{32}' | head -1)
fi
echo "KV_ID=$KV_ID"
[ -z "$KV_ID" ] && echo "ERROR: no KV_ID" && exit 1

echo "=== Step 3: write real wrangler.toml ==="
cat > wrangler.toml << EOF
name            = "health-protocol"
main            = "src/index.js"
compatibility_date = "2026-06-26"
account_id      = "b57e9af57ab46c52ca9215804e689c29"

[[kv_namespaces]]
binding = "HP_KV"
id      = "${KV_ID}"
EOF
cat wrangler.toml

echo "=== Step 4: deploy ==="
npx wrangler deploy

echo "=== Step 5: set secrets ==="
echo "${FIELD_PAT}"     | npx wrangler secret put GITHUB_PAT
echo "${CLIENT_ID}"     | npx wrangler secret put STRAVA_CLIENT_ID
echo "${CLIENT_SECRET}" | npx wrangler secret put STRAVA_CLIENT_SECRET

echo "=== Step 6: seed Strava tokens in KV ==="
npx wrangler kv key put \
    --namespace-id="${KV_ID}" \
    "strava:tokens" \
    "{\"access_token\":\"1974e6b574eda8fa16af67b1061005d8b067b0d7\",\"refresh_token\":\"${REFRESH_TOKEN}\",\"expires_at\":0}"

echo "=== Step 7: commit wrangler.toml with real KV ID ==="
git config user.email "github-actions@github.com"
git config user.name "Claude Code"
git add wrangler.toml
git commit -m "chore: update wrangler.toml with real KV namespace ID" || true
git push origin main

echo "=== Step 8: verify ==="
sleep 5
curl -s "https://health-protocol.jeffunglesbee.workers.dev/" | head -1

echo "=== DONE ==="
