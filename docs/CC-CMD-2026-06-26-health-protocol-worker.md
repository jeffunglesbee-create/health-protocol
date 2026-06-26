# CC-CMD: Health Protocol Worker Verification
**Date:** 2026-06-26  
**Worker:** `field-relay-nba` (`field-relay-nba.jeffunglesbee.workers.dev`)  
**D1:** `wc2026` (`f26669de-e772-4b56-a6d1-f8fdea08a4d4`) — holds `whoop_tokens`

---

## Tasks

### 1. Verify worker health
```
probe_relay_route /health
```
**Result ✅** `RELAY OK — nba + nhl + fpl + ... + analytics-cron, quality-source=analytics-cron`  
Deployed: `dc2b372` @ 2026-06-26T13:07:21Z. Deploy matches relay head.

---

### 2. Check WHOOP token status (D1: wc2026 → whoop_tokens)
```sql
SELECT id, length(access_token), substr(access_token,1,8), expires_at, updated_at
FROM whoop_tokens
```
**Result ⚠️ TOKEN EXPIRED**

| field | value |
|---|---|
| id | `primary` |
| token_len | 87 |
| token_prefix | `2ysKtJqJ` |
| expires_at | `2026-06-26 14:35:33` UTC |
| updated_at | `2026-06-26 13:35:33` UTC |

Token expired ~2.5h ago. Stored `refresh_token` was malformed (40-char hex `71762cc4...` — not a valid WHOOP token). Auto-refresh returned `400 invalid_request`. Full OAuth re-auth performed — see Re-auth URL section below.

**Re-auth completed ✅ 2026-06-26T17:34:16Z** — fresh tokens written to D1.

**Re-auth steps if auto-refresh fails:**
1. Generate a random `state` string ≥8 chars (required by WHOOP).
2. Open the WHOOP OAuth authorization URL (see Re-auth URL section) with your `state` value.
3. Approve — callback hits `/whoop/callback` and writes fresh tokens to `wc2026.whoop_tokens`.
4. Verify: `SELECT refresh_len FROM whoop_tokens` confirms `refresh_len > 0`; probe `/whoop/fetch?days=1` confirms live data.

---

### 3. Check data source freshness
```
probe_relay_route /health/sources
```
**Result — 4 stale, 6 healthy** (checked 2026-06-26T16:57:57Z)

| Source | Status | Age | Max Age | Note |
|---|---|---|---|---|
| mlb_team_abs | ✅ healthy | 97h | 168h | |
| mlb_pitch_arsenals | ✅ healthy | 97h | 168h | 0 entries (Savant fetch issue, self-heals) |
| mlb_expected_stats | ✅ healthy | 97h | 168h | 395 entries |
| nba_clutch_playoffs | ⚠️ stale | 340h | 24h | Season over — heals Oct |
| nba_clutch_regular | ⚠️ stale | 340h | 24h | Season over — heals Oct |
| nhl_series_stats | ⚠️ stale | 278h | 4h | SCF over — heals Oct/Nov |
| wc_group | ✅ healthy | — | — | 48 rows |
| odds_daily | ⚠️ stale | — | 24h | `exists: false` (no calls today yet) |
| odds_monthly | ✅ healthy | 0h | 720h | |
| journalism_brief | ✅ healthy | 0h | 24h | |

NBA/NHL staleness is expected — seasons ended. Odds daily resets at midnight.

---

## Dashboard data flow (verified)

```
index.html
  └─ WHOOP_URL = /whoop/fetch?days=5
       └─ field-relay-nba (dc2b372 — deployed ✅)
            ├─ D1 wc2026: whoop_tokens → ✅ VALID (re-authed 17:34 UTC, expires 18:34 UTC, refresh_token present)
            └─ → recovery / cycle / sleep / workout / body / profile
                 └─ extractWhoop() → strain, avgHR, maxHR, prevStrain, weight

  └─ OURA_URL = jubilant-bassoon/outbox/oura-data.json (separate, not worker)
```

**Live data verified 2026-06-26T17:38:28Z:**
- `cycle` ✅ — today strain 4.09, avg HR 60; yesterday strain 13.58, avg HR 68
- `body` ✅ — weight 82.93 kg, max HR 190
- `profile` ✅ — Jeff Unglesbee (user_id 31127063)
- `recovery` / `sleep` / `workout` → 404 (no data for 1-day window — normal when not scored yet)

---

## Environment

| Binding | Value |
|---|---|
| `DB` | `wc2026` (`f26669de-e772-4b56-a6d1-f8fdea08a4d4`) |
| `WHOOP_CLIENT_ID` | `a4c9151b-0a51-461c-808a-120fe5735bfc` (FIELD Health Monitor app) |
| `WHOOP_CLIENT_SECRET` | secret (see Cloudflare dashboard → field-relay-nba → Settings) |
| `FIELD_MCP_SECRET` | secret (guards `/whoop/tokens`) |

---

## Re-auth URL (use when tokens are invalid)

**Important:** WHOOP requires `state` ≥8 chars — generate a random value before opening the URL.

```
https://api.prod.whoop.com/oauth/oauth2/auth?client_id=a4c9151b-0a51-461c-808a-120fe5735bfc&redirect_uri=https%3A%2F%2Ffield-relay-nba.jeffunglesbee.workers.dev%2Fwhoop%2Fcallback&response_type=code&scope=read%3Arecovery+read%3Acycles+read%3Asleep+read%3Aworkout+read%3Abody_measurement+read%3Aprofile&state=REPLACE_WITH_RANDOM_8CHARS
```

Generate `state` with: `python3 -c "import secrets; print(secrets.token_urlsafe(16))"`

After authorizing, `/whoop/callback` writes fresh tokens to `wc2026.whoop_tokens`. The worker auto-refreshes on every `/whoop/fetch` call thereafter — no further manual action needed.

**Note:** WHOOP issues a refresh token for `authorization_code` flow even without `offline` listed explicitly in the developer dashboard scopes UI. The `offline` scope is implicit for this grant type.

---

## Execution log (2026-06-26)

| Step | Result |
|---|---|
| Worker health | ✅ `RELAY OK` — `dc2b372` deployed |
| `/health/sources` | ✅ 6 healthy, 4 stale (NBA/NHL seasons over — expected) |
| D1 token check | ⚠️ `expires_at 14:35 UTC` — expired |
| Refresh attempt | ❌ `400 invalid_request` — stored refresh_token was malformed (40-char hex, not valid WHOOP format) |
| All WHOOP endpoints | ❌ `401 Unauthorized` |
| OAuth re-auth (attempt 1) | ❌ Missing `state` param → WHOOP returned `invalid_state` error |
| OAuth re-auth (attempt 2) | ✅ Success — access + refresh token written to D1 at 17:34 UTC |
| D1 verification | ✅ `refresh_len: 87`, prefix `a9_COtmX` — valid WHOOP token format |
| `/whoop/fetch?days=1` | ✅ HTTP 200 — live cycle, body, profile data returned |
| **Status** | **✅ COMPLETE** |
