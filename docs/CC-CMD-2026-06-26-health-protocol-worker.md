# Health Protocol Worker — `field-relay-nba`

**Worker URL:** `https://field-relay-nba.jeffunglesbee.workers.dev`  
**Dashboard consumer:** `index.html` → `WHOOP_URL` constant

---

## What this worker does for the health dashboard

The `field-relay-nba` Cloudflare Worker is a multi-sport relay that also hosts the WHOOP OAuth integration and data proxy used by this health protocol dashboard. The dashboard fetches live biometric data from:

```
GET /whoop/fetch?days=5
```

---

## WHOOP endpoints

### `GET /whoop/fetch?days=N`

Primary endpoint used by the dashboard. Returns up to N days of WHOOP biometric data. Automatically refreshes the OAuth token if expired.

**Response shape:**

```json
{
  "fetched_at": "2026-06-26T13:00:00.000Z",
  "days": 5,
  "recovery":  { "status": 200, "data": { "records": [...] } },
  "cycle":     { "status": 200, "data": { "records": [...] } },
  "sleep":     { "status": 200, "data": { "records": [...] } },
  "workout":   { "status": 200, "data": { "records": [...] } },
  "body":      { "status": 200, "data": { ... } },
  "profile":   { "status": 200, "data": { ... } },
  "_debug": {
    "has_client_id": true,
    "has_client_secret": true,
    "token_len": 512,
    "token_prefix": "eyJ...",
    "was_refreshed": false,
    "expires_at": "2026-06-27T01:00:00",
    "now": "2026-06-26T13:00:00.000Z"
  }
}
```

Dashboard reads `_debug.cycle.data.records[0]` for current day strain/HR and `_debug.body.data.weight_kilogram` for body weight.

### `GET /whoop/callback?code=<oauth_code>`

OAuth 2.0 authorization code callback. Exchanges the code for access + refresh tokens and stores them in D1 (`whoop_tokens` table, row `id = "primary"`). Returns an HTML confirmation page.

**Redirect URI registered with WHOOP:**  
`https://field-relay-nba.jeffunglesbee.workers.dev/whoop/callback`

### `GET /whoop/tokens`

Returns the stored token row. Requires `Authorization: Bearer <FIELD_MCP_SECRET>`.

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": "2026-06-27T01:00:00",
  "updated_at": "2026-06-26T12:00:00"
}
```

---

## How token refresh works

The `/whoop/fetch` handler:

1. Reads the stored token from D1.
2. If `expires_at` is in the past, POSTs to `https://api.prod.whoop.com/oauth/oauth2/token` with `grant_type=refresh_token`.
3. On success, updates D1 with the new access + refresh tokens and new expiry.
4. Falls through to fetching all endpoints with the (possibly refreshed) token.

If refresh fails (e.g. refresh token revoked), the `_debug.refresh_result` field in the response will contain the error body. Re-run OAuth to fix.

---

## Worker health endpoints

### `GET /health`

Returns a plain-text `RELAY OK` string listing all active integrations. No auth required.

### `GET /health/sources`

Returns JSON with freshness checks for all data sources.

---

## Re-authorizing WHOOP (if tokens are revoked)

1. Go to the WHOOP developer dashboard and generate a new authorization URL for the app.
2. Authorize the app — the callback redirects to `/whoop/callback` and stores new tokens.
3. Verify with `curl https://field-relay-nba.jeffunglesbee.workers.dev/whoop/fetch?days=1` — expect `"status": 200` on all endpoints.

---

## Environment variables (Cloudflare secrets)

| Variable | Purpose |
|---|---|
| `WHOOP_CLIENT_ID` | WHOOP OAuth app client ID |
| `WHOOP_CLIENT_SECRET` | WHOOP OAuth app client secret |
| `FIELD_MCP_SECRET` | Bearer token for protected admin routes |
| `DB` | D1 binding — stores `whoop_tokens` |

---

## Dashboard data flow

```
index.html
  └─ fetch(WHOOP_URL)  → GET /whoop/fetch?days=5
       └─ field-relay-nba worker
            ├─ D1: read whoop_tokens
            ├─ (if expired) refresh via WHOOP OAuth
            └─ parallel fetch: recovery, cycle, sleep, workout, body, profile
                 └─ returns JSON → extractWhoop() in App component
                      └─ strain, avgHR, maxHR, prevStrain, weight, fetchedAt
```

Oura data is separate — fetched directly from GitHub raw:  
`https://raw.githubusercontent.com/jeffunglesbee-create/jubilant-bassoon/main/outbox/oura-data.json`
