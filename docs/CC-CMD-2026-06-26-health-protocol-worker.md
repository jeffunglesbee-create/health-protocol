# CC-CMD: Health Protocol — Standalone Cloudflare Worker
**Date:** 2026-06-26
**Repos:** health-protocol (primary) + field-relay-nba (Courier ALLOWED_REPOS only)
**Supersedes:** CC-CMD-2026-06-26-health-protocol-relay.md (DO NOT RUN that one)
**Rule 87:** Self-completing. No carry-forwards. Zero manual steps. All terminal work automated.

---

## CREDENTIALS (from conversation — set as variables immediately)

```bash
CLIENT_ID="261196"
CLIENT_SECRET="54de6106ebfb087d7d0c01a611c93788dc75d3ef"
REFRESH_TOKEN="71762cc472c4d80c5eb107d820e1fd193da91569"
CF_ACCOUNT_ID="b57e9af57ab46c52ca9215804e689c29"
# FIELD_PAT: use value from memory (ghp_ prefixed, May 2027 expiry)
# This is needed both for git clone and for PyNaCl secret setting
```

---

## PROBE BLOCK

```bash
cd /home/claude
git clone https://${FIELD_PAT}@github.com/jeffunglesbee-create/health-protocol.git
cd health-protocol
HP_HEAD=$(git rev-parse HEAD)
echo "HP_HEAD: $HP_HEAD"

# 1. Confirm no src/ or wrangler.toml yet
ls src/ 2>/dev/null && echo "WARN: src EXISTS" || echo "OK: src missing"
ls wrangler.toml 2>/dev/null && echo "WARN: wrangler.toml EXISTS" || echo "OK: wrangler.toml missing"

# 2. Verify wrangler auth
npx wrangler whoami 2>&1 | head -5
# Expected: authenticated account — if not, CF_TOKEN env may not be set

# 3. Confirm index.html needs URL update
grep "OURA_URL\|STRAVA_URL\|WHOOP_URL" index.html | head -5

# 4. Create KV namespace
KV_RAW=$(npx wrangler kv namespace create hp-kv 2>&1)
echo "$KV_RAW"
KV_ID=$(echo "$KV_RAW" | grep -Eo '[a-f0-9]{32}' | head -1)

# If already exists, fetch existing ID
if [ -z "$KV_ID" ]; then
    echo "hp-kv may exist — listing namespaces"
    KV_ID=$(npx wrangler kv namespace list 2>&1 | python3 -c "
import json,sys,re
raw=sys.stdin.read()
match=re.search(r'\[.*\]',raw,re.DOTALL)
if match:
    for ns in json.loads(match.group()):
        if 'hp-kv' in ns.get('title',''):
            print(ns['id']); break
")
fi

echo "KV_ID=${KV_ID}"
[ -z "$KV_ID" ] && echo "ERROR: KV_ID empty — cannot continue" && exit 1

# 5. Extract CF API token for later PyNaCl step
CF_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$CF_API_TOKEN" ]; then
    CF_API_TOKEN=$(python3 -c "
import os,re
for path in [os.path.expanduser('~/.wrangler/config/default.toml'),
             os.path.expanduser('~/.cloudflare/config.toml')]:
    if os.path.exists(path):
        m=re.search(r'api_token\s*=\s*[\"\'](.*?)[\"\'']',open(path).read())
        if m: print(m.group(1)); break
" 2>/dev/null || true)
fi
echo "CF_API_TOKEN found: $([ -n "$CF_API_TOKEN" ] && echo YES len=${#CF_API_TOKEN} || echo NO)"
```

Stop if KV_ID is empty or wrangler auth fails.

---

## TASK 1 — Create src/index.js

```bash
mkdir -p /home/claude/health-protocol/src
cat > /home/claude/health-protocol/src/index.js << 'JSEOF'
// health-protocol Worker — personal biometric API
// Completely separate from FIELD. Added: 2026-06-26.
// Endpoints: / /oura /strava /strava/callback /whoop

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const pathname = url.pathname;
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });
    try {
      if (pathname === '/')                return handleRoot();
      if (pathname === '/oura')            return handleOura(env);
      if (pathname === '/strava')          return handleStrava(env);
      if (pathname === '/strava/callback') return handleStravaCallback(url, env);
      if (pathname === '/whoop')           return handleWhoop();
      return new Response('Not found', { status: 404, headers: CORS });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};

function handleRoot() {
  return json({
    name: 'health-protocol', version: '1.0.0',
    endpoints: ['/oura', '/strava', '/whoop'],
    strava_reauth: '/strava/callback (OAuth callback if tokens expire)',
    updated: new Date().toISOString(),
  });
}

// /oura — reads jubilant-bassoon private outbox via GITHUB_PAT secret
async function handleOura(env) {
  const r = await fetch(
    'https://raw.githubusercontent.com/jeffunglesbee-create/jubilant-bassoon/main/outbox/oura-data.json',
    { headers: { Authorization: `token ${env.GITHUB_PAT}`, Accept: 'application/json' } }
  );
  if (!r.ok) return json({ error: `oura upstream ${r.status}` }, r.status);
  return new Response(await r.text(), {
    headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=300' },
  });
}

// /strava — live Strava API, tokens in HP_KV, auto-refreshes on expiry
async function handleStrava(env) {
  let { access_token, refresh_token, expires_at } =
    (await env.HP_KV.get('strava:tokens', 'json')) || {};
  if (!refresh_token)
    return json({ error: 'Strava not configured', setup: 'tokens not yet seeded in KV' }, 503);

  // expires_at=0 → always refresh on first call (initial seed pattern)
  if (!access_token || Date.now() > expires_at - 60_000) {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET,
        refresh_token, grant_type: 'refresh_token',
      }),
    });
    const d = await r.json();
    if (!d.access_token) return json({ error: 'Strava refresh failed', detail: d }, 502);
    access_token  = d.access_token;
    refresh_token = d.refresh_token;
    expires_at    = d.expires_at * 1000;
    await env.HP_KV.put('strava:tokens',
      JSON.stringify({ access_token, refresh_token, expires_at }));
  }

  const auth = { Authorization: `Bearer ${access_token}` };
  const [actResp, athResp] = await Promise.all([
    fetch('https://www.strava.com/api/v3/athlete/activities?per_page=15', { headers: auth }),
    fetch('https://www.strava.com/api/v3/athlete', { headers: auth }),
  ]);
  const [activities, athlete] = await Promise.all([actResp.json(), athResp.json()]);

  return json({
    fetched_at: new Date().toISOString(),
    athlete: {
      id: athlete.id, firstname: athlete.firstname,
      lastname: athlete.lastname, city: athlete.city, country: athlete.country,
    },
    activities: activities.map(a => ({
      id: a.id, name: a.name, sport_type: a.sport_type,
      start_local: a.start_date_local, distance: a.distance,
      moving_time: a.moving_time, elapsed_time: a.elapsed_time,
      elevation: a.total_elevation_gain, avg_speed: a.average_speed,
      max_speed: a.max_speed, avg_hr: a.average_heartrate,
      max_hr: a.max_heartrate, avg_cadence: a.average_cadence,
      calories: a.calories, achievement_count: a.achievement_count,
      pr_count: a.pr_count,
    })),
  }, 200, { 'Cache-Control': 'public, max-age=300' });
}

// /strava/callback — OAuth re-auth if refresh token ever expires
async function handleStravaCallback(url, env) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) return page(`<h1>Strava denied: ${error}</h1>`, 400);
  if (!code) return page('<h1>No code — tokens seeded directly via KV</h1>');
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET,
      code, grant_type: 'authorization_code',
    }),
  });
  const d = await r.json();
  if (!d.access_token) return page(`<h1>Token exchange failed</h1><pre>${JSON.stringify(d,null,2)}</pre>`, 502);
  await env.HP_KV.put('strava:tokens', JSON.stringify({
    access_token: d.access_token, refresh_token: d.refresh_token,
    expires_at: d.expires_at * 1000,
  }));
  const name = d.athlete ? `${d.athlete.firstname} ${d.athlete.lastname}` : 'Unknown';
  return page(`<h1 style="color:#22D3EE">&#10003; Strava Reconnected</h1>
    <p>Athlete: <strong>${name}</strong></p>
    <p><a href="https://jeffunglesbee-create.github.io/health-protocol">&#8594; Dashboard</a></p>`);
}

// /whoop — read-only URL proxy to field-relay-nba (no code import)
async function handleWhoop() {
  const r = await fetch('https://field-relay-nba.jeffunglesbee.workers.dev/whoop/fetch?days=5');
  if (!r.ok) return json({ error: `whoop upstream ${r.status}` }, r.status);
  return new Response(await r.text(), {
    headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=60' },
  });
}

function page(body, status = 200) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="UTF-8">
     <style>body{background:#0A1628;color:#fff;font-family:monospace;
     padding:40px;text-align:center}a{color:#22D3EE}</style></head>
     <body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html' } }
  );
}
JSEOF
echo "src/index.js: $(wc -l src/index.js) lines"
```

---

## TASK 2 — Create wrangler.toml

```bash
cd /home/claude/health-protocol
cat > wrangler.toml << EOF
name            = "health-protocol"
main            = "src/index.js"
compatibility_date = "2026-06-26"
account_id      = "b57e9af57ab46c52ca9215804e689c29"

[[kv_namespaces]]
binding = "HP_KV"
id      = "${KV_ID}"

# Secrets (set in Task 7):
#   GITHUB_PAT, STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
EOF

grep "REPLACE_WITH" wrangler.toml && echo "ERROR: placeholder remains" || echo "OK: wrangler.toml clean"
grep "id" wrangler.toml | tail -1
```

---

## TASK 3 — Create worker-deploy.yml (Courier OIDC pattern)

Uses Courier v4 (`field-deploy.jeffunglesbee.workers.dev/secret`) to receive
`CLOUDFLARE_API_TOKEN` from Courier on deploy — zero stored credentials.
Requires Task 4 (Courier ALLOWED_REPOS) to be deployed first.

```bash
mkdir -p /home/claude/health-protocol/.github/workflows
cat > /home/claude/health-protocol/.github/workflows/worker-deploy.yml << 'YMLEOF'
name: Deploy Health Protocol Worker

on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'wrangler.toml'
  workflow_dispatch:

permissions:
  contents: read
  id-token: write   # enables OIDC token generation (no config needed)

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Get CLOUDFLARE_API_TOKEN via Courier OIDC
        id: courier
        run: |
          # Generate OIDC token (automatic — requires id-token: write above)
          OIDC_TOKEN=$(curl -sH "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=field-deploy" | jq -r .value)

          # Ask Courier to reveal CF_TOKEN (Courier verifies OIDC cryptographically)
          RESULT=$(curl -s -X POST https://field-deploy.jeffunglesbee.workers.dev/reveal \
            -H "Authorization: Bearer $OIDC_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"secret":"CLOUDFLARE_API_TOKEN"}')

          CF_TOKEN=$(echo "$RESULT" | jq -r '.value // empty')

          if [ -z "$CF_TOKEN" ]; then
            echo "Courier reveal failed: $RESULT"
            echo "Falling back to CLOUDFLARE_API_TOKEN secret if set"
            CF_TOKEN="${{ secrets.CLOUDFLARE_API_TOKEN }}"
          fi

          echo "cf_token=$CF_TOKEN" >> $GITHUB_OUTPUT

      - name: Deploy Worker
        run: |
          npm install wrangler --save-dev --silent
          npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ steps.courier.outputs.cf_token }}
          CLOUDFLARE_ACCOUNT_ID: b57e9af57ab46c52ca9215804e689c29
YMLEOF
echo "worker-deploy.yml written"
```

---

## TASK 4 — Add health-protocol to Courier ALLOWED_REPOS

Courier v4 source: `field-relay-nba/workers/field-deploy/src/index.js`
Current ALLOWED_REPOS (line 29-32):
```
'jeffunglesbee-create/field-relay-nba',
'jeffunglesbee-create/jubilant-bassoon',
```

Also adds a `/reveal` endpoint so health-protocol CI can receive CF_TOKEN via OIDC.

```bash
cd /home/claude
git clone https://${FIELD_PAT}@github.com/jeffunglesbee-create/field-relay-nba.git
cd field-relay-nba

# Get current SHA of Courier source
COURIER_SHA=$(curl -s \
  -H "Authorization: token ${FIELD_PAT}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/jeffunglesbee-create/field-relay-nba/contents/workers/field-deploy/src/index.js" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")
echo "Courier SHA: $COURIER_SHA"

# Read current content
curl -s \
  -H "Authorization: token ${FIELD_PAT}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/jeffunglesbee-create/field-relay-nba/contents/workers/field-deploy/src/index.js" \
  | python3 -c "import json,sys,base64; print(base64.b64decode(json.load(sys.stdin)['content']).decode())" \
  > /tmp/courier_current.js

# Patch 1: Add health-protocol to ALLOWED_REPOS
python3 << 'PYEOF'
with open('/tmp/courier_current.js') as f:
    content = f.read()

old = """const ALLOWED_REPOS = [
  'jeffunglesbee-create/field-relay-nba',
  'jeffunglesbee-create/jubilant-bassoon',  // Layer 2 AI screenshot review
];"""

new = """const ALLOWED_REPOS = [
  'jeffunglesbee-create/field-relay-nba',
  'jeffunglesbee-create/jubilant-bassoon',  // Layer 2 AI screenshot review
  'jeffunglesbee-create/health-protocol',   // Health Protocol Worker auto-deploy
];"""

if old in content:
    content = content.replace(old, new)
    print("ALLOWED_REPOS: health-protocol added")
else:
    print("ERROR: ALLOWED_REPOS pattern not found — check Courier source")
    exit(1)

# Patch 2: Add /reveal endpoint after /secret handler
# Find insertion point: after the /secret if-block closes, before /layer2
reveal_block = """
    if (url.pathname === '/reveal') {
      // Returns a stored Worker secret value to authenticated CI workflows.
      // OIDC-verified — only allowed repos can call this endpoint.
      // Used by health-protocol worker-deploy.yml to get CLOUDFLARE_API_TOKEN.
      const { secret } = body;
      if (!secret) return jr({ok:false,error:'Missing secret name'},400);
      const val = env[secret];
      if (!val) return jr({ok:false,error:`Secret ${secret} not found in Worker env`},404);
      return jr({ok:true,value:val,secret,repo:oidc.repository});
    }

"""

insert_before = "    if (url.pathname === '/layer2') {"
if insert_before in content and '/reveal' not in content:
    content = content.replace(insert_before, reveal_block + insert_before)
    print("/reveal endpoint: added")
elif '/reveal' in content:
    print("/reveal endpoint: already exists")
else:
    print("WARN: /layer2 insertion point not found — /reveal not added")

with open('/tmp/courier_patched.js', 'w') as f:
    f.write(content)
print("Courier patched successfully")
PYEOF

# Push patched Courier via GitHub Contents API
python3 << PYEOF
import base64, json, urllib.request
import os

with open('/tmp/courier_patched.js', 'rb') as f:
    content = base64.b64encode(f.read()).decode()

PAT = os.environ.get('FIELD_PAT', '')
SHA = "$COURIER_SHA"

payload = json.dumps({
    "message": "feat(courier): add health-protocol to ALLOWED_REPOS + /reveal endpoint [skip ci]",
    "content": content,
    "sha": SHA
}).encode()

req = urllib.request.Request(
    "https://api.github.com/repos/jeffunglesbee-create/field-relay-nba/contents/workers/field-deploy/src/index.js",
    data=payload,
    headers={
        "Authorization": f"token {PAT}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    },
    method="PUT"
)
with urllib.request.urlopen(req) as r:
    d = json.loads(r.read())
    print(f"Courier pushed: {d['commit']['sha'][:12]} — {d['content']['path']}")
PYEOF

# Deploy Courier (so ALLOWED_REPOS change takes effect immediately)
cd /home/claude/field-relay-nba/workers/field-deploy
npm install --silent 2>/dev/null || true
npx wrangler deploy 2>&1 | tail -5
echo "Courier deploy: $?"
```

---

## TASK 5 — Update index.html

Find the URL constants near top of script tag. Replace:

```
const WHOOP_URL = 'https://field-relay-nba.jeffunglesbee.workers.dev/whoop/fetch?days=5';
const OURA_URL = 'https://raw.githubusercontent.com/jeffunglesbee-create/jubilant-bassoon/main/outbox/oura-data.json';
```

With:

```javascript
const WHOOP_URL  = 'https://health-protocol.jeffunglesbee.workers.dev/whoop';
const OURA_URL   = 'https://health-protocol.jeffunglesbee.workers.dev/oura';
const STRAVA_URL = 'https://health-protocol.jeffunglesbee.workers.dev/strava';
```

Find Promise.all block and replace:

```javascript
    Promise.all([
      fetch(WHOOP_URL).then(r=>r.json()).catch(()=>null),
      fetch(OURA_URL).then(r=>r.json()).catch(()=>null),
    ]).then(([w, o]) => {
      setWhoop(w ? extractWhoop(w) : null);
      setOura(o ? extractOura(o) : null);
      setLoading(false);
    })
```

With:

```javascript
    Promise.all([
      fetch(WHOOP_URL).then(r=>r.json()).catch(()=>null),
      fetch(OURA_URL).then(r=>r.json()).catch(()=>null),
      fetch(STRAVA_URL).then(r=>r.json()).catch(()=>null),
    ]).then(([w, o, s]) => {
      setWhoop(w ? extractWhoop(w) : null);
      setOura(o ? extractOura(o) : null);
      setStrava(s?.activities?.length ? s : null);
      setLoading(false);
    })
```

Add `const [strava, setStrava] = useState(null);` with other useState calls.

Add Strava panel in JSX after Whoop panel:

```jsx
{!loading && strava && (
  <div className="rounded-2xl p-4 mb-4 bg-white" style={{border:'1px solid #E5E7EB'}}>
    <div className="font-black mb-3" style={{color:'#0A1628',fontSize:10,letterSpacing:'0.15em'}}>
      STRAVA · {strava.fetched_at ? new Date(strava.fetched_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—'}
    </div>
    {strava.activities.slice(0, 5).map((a, i) => (
      <div key={a.id||i} className="flex justify-between items-center py-1.5 border-b" style={{borderColor:'#F3F4F6'}}>
        <div>
          <span className="font-semibold text-sm" style={{color:'#0A1628'}}>{a.name}</span>
          <span className="text-xs ml-2" style={{color:'#6B7280'}}>{a.sport_type}</span>
        </div>
        <div className="text-right">
          <span className="font-mono font-bold text-sm" style={{color:'#7C3AED'}}>
            {a.distance ? (a.distance/1000).toFixed(1)+'km' : '—'}
          </span>
          {a.pr_count > 0 && (
            <span className="ml-1 text-xs font-bold" style={{color:'#C2410C'}}>{a.pr_count}PR</span>
          )}
        </div>
      </div>
    ))}
  </div>
)}
```

Verify:
```bash
grep -c "health-protocol.jeffunglesbee.workers.dev" index.html
# Expected: 3
grep "setStrava" index.html | wc -l
# Expected: 2+
```

---

## TASK 6 — npm install

```bash
cd /home/claude/health-protocol
npm init -y 2>/dev/null || true
npm install wrangler --save-dev --silent
echo "wrangler: $(npx wrangler --version)"
```

---

## TASK 7 — Deploy Worker

```bash
cd /home/claude/health-protocol
npx wrangler deploy 2>&1
sleep 8
WORKER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://health-protocol.jeffunglesbee.workers.dev/")
echo "Worker root: HTTP $WORKER_STATUS"
[ "$WORKER_STATUS" = "200" ] || echo "WARN: check deploy output above"
```

---

## TASK 8 — Set Worker secrets

```bash
cd /home/claude/health-protocol

echo "${FIELD_PAT}"      | npx wrangler secret put GITHUB_PAT
echo "${CLIENT_ID}"      | npx wrangler secret put STRAVA_CLIENT_ID
echo "${CLIENT_SECRET}"  | npx wrangler secret put STRAVA_CLIENT_SECRET

npx wrangler secret list 2>&1
# Expected: GITHUB_PAT, STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
```

---

## TASK 9 — Seed Strava tokens in KV

```bash
cd /home/claude/health-protocol

# expires_at=0 forces immediate refresh on first /strava call
# The Worker refreshes using STRAVA_CLIENT_SECRET + REFRESH_TOKEN automatically
STRAVA_TOKENS=$(python3 -c "
import json
print(json.dumps({
    'access_token': '1974e6b574eda8fa16af67b1061005d8b067b0d7',
    'refresh_token': '${REFRESH_TOKEN}',
    'expires_at': 0
}))
")

npx wrangler kv key put \
    --namespace-id="${KV_ID}" \
    "strava:tokens" \
    "${STRAVA_TOKENS}"

echo "KV seed: $?"
npx wrangler kv key get --namespace-id="${KV_ID}" "strava:tokens" 2>&1 | head -1
```

---

## TASK 10 — Set CLOUDFLARE_API_TOKEN in health-protocol GitHub secrets (PyNaCl)

This eliminates the last manual step. Extracts CF_API_TOKEN from the wrangler
environment (set during Task 7 deploy) and stores it in health-protocol GitHub
secrets via PyNaCl — same pattern used in STAT sessions.

```bash
pip install pynacl --break-system-packages -q 2>/dev/null || true

python3 << PYEOF
import urllib.request, json, base64, os, sys
from nacl.public import SealedBox, PublicKey
from nacl.encoding import Base64Encoder

PAT         = os.environ.get('FIELD_PAT', '')
CF_TOKEN    = os.environ.get('CF_API_TOKEN', '')
REPO        = "jeffunglesbee-create/health-protocol"
SECRET_NAME = "CLOUDFLARE_API_TOKEN"

if not PAT:
    print("ERROR: FIELD_PAT not in environment"); sys.exit(1)
if not CF_TOKEN:
    print("CF_API_TOKEN not found in environment — checking wrangler config")
    import re
    for path in [os.path.expanduser('~/.wrangler/config/default.toml'),
                 os.path.expanduser('~/.cloudflare/config.toml')]:
        if os.path.exists(path):
            m = re.search(r'api_token\s*=\s*[\"\'](.*?)[\"\'']', open(path).read())
            if m: CF_TOKEN = m.group(1); break
    if not CF_TOKEN:
        print("CF_API_TOKEN not found — worker-deploy.yml will use Courier OIDC fallback"); sys.exit(0)

headers = {"Authorization": f"token {PAT}", "Accept": "application/vnd.github+json",
           "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"}

# Get repo public key
req = urllib.request.Request(
    f"https://api.github.com/repos/{REPO}/actions/secrets/public-key", headers=headers)
with urllib.request.urlopen(req) as r:
    pk_data = json.loads(r.read())

# Encrypt with PyNaCl SealedBox (identical to STAT pattern)
pk  = PublicKey(pk_data["key"], encoder=Base64Encoder)
enc = base64.b64encode(SealedBox(pk).encrypt(CF_TOKEN.encode())).decode()

# PUT secret
payload = json.dumps({"encrypted_value": enc, "key_id": pk_data["key_id"]}).encode()
req = urllib.request.Request(
    f"https://api.github.com/repos/{REPO}/actions/secrets/{SECRET_NAME}",
    data=payload, headers=headers, method="PUT"
)
with urllib.request.urlopen(req) as r:
    print(f"CLOUDFLARE_API_TOKEN set in health-protocol: HTTP {r.status}")
    print("Future src/ pushes → worker-deploy.yml auto-deploys via this secret")
    print("Courier OIDC /reveal provides additional fallback if secret ever clears")
PYEOF
```

---

## TASK 11 — Commit and push health-protocol

```bash
cd /home/claude/health-protocol
git config user.email "github-actions@github.com"
git config user.name "Claude Code"
git add src/index.js wrangler.toml .github/workflows/worker-deploy.yml index.html
git commit -m "feat: standalone health-protocol Worker + Oura/Strava/Whoop live endpoints"
git push origin main
echo "Push: $?"
```

---

## TASK 12 — Endpoint smoke test

```bash
BASE="https://health-protocol.jeffunglesbee.workers.dev"

# Root
curl -s "${BASE}/" | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert d['name']=='health-protocol', f'Bad root: {d}'
print('OK: / →', d['endpoints'])"

# Strava (should auto-refresh and return activities)
curl -s "${BASE}/strava" | python3 -c "
import json,sys; d=json.load(sys.stdin)
if 'activities' in d:
    print(f'OK: /strava → {len(d[\"activities\"])} activities, athlete: {d[\"athlete\"][\"firstname\"]}')
elif 'error' in d:
    print(f'WARN: /strava error: {d[\"error\"]}')
"

# Oura
OURA_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/oura")
python3 -c "assert '${OURA_CODE}'!='404','FAIL: /oura 404'; print(f'OK: /oura HTTP ${OURA_CODE}')"

# Whoop
WHOOP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/whoop")
python3 -c "assert '${WHOOP_CODE}'=='200','FAIL: /whoop'; print('OK: /whoop 200')"

# Strava callback (no code param)
CB=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/strava/callback")
echo "OK: /strava/callback → HTTP $CB (200 expected)"

# FIELD relay untouched
curl -s "https://field-relay-nba.jeffunglesbee.workers.dev/health" | grep -q "RELAY OK" && \
  echo "OK: FIELD relay unchanged" || echo "WARN: FIELD relay unexpected"

# index.html uses Worker URLs
N=$(grep -c "health-protocol.jeffunglesbee.workers.dev" /home/claude/health-protocol/index.html)
python3 -c "assert $N>=3,f'Only {$N} Worker URLs'; print(f'OK: {$N} Worker URLs in index.html')"

echo "=== All smoke checks complete ==="
```

---

## DONE CONDITIONS

```
[ ] Worker root: {"name":"health-protocol","endpoints":["/oura","/strava","/whoop"]}
[ ] /strava: returns activities array (auto-refresh worked)
[ ] /oura: HTTP 200 or 401 (not 404 — route exists)
[ ] /whoop: HTTP 200 (field relay proxied)
[ ] /strava/callback: HTTP 200 (no code param case)
[ ] index.html: 3+ health-protocol.jeffunglesbee.workers.dev references
[ ] wrangler.toml: real KV ID, no REPLACE_WITH placeholder
[ ] Worker secrets: GITHUB_PAT + STRAVA_CLIENT_ID + STRAVA_CLIENT_SECRET listed
[ ] KV strava:tokens: seeded
[ ] CLOUDFLARE_API_TOKEN: set in health-protocol GitHub secrets (Task 10)
[ ] Courier ALLOWED_REPOS: health-protocol added + deployed (Task 4)
[ ] FIELD relay /health: "RELAY OK" unchanged
[ ] health-protocol main: commit pushed, GitHub Pages redeploys
```

---

## OUT OF SCOPE

- field-relay-nba src/index.js routes: zero changes (Courier only)
- jubilant-bassoon: zero changes
- FIELD smoke tests: not applicable
- Strava OAuth callback flow: tokens seeded directly via KV (Task 9)
- GitHub Actions Strava workflow: not needed (Worker handles token refresh in KV)
- Manual steps: none — all automated
