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

Token expired ~2.5h ago. The `/whoop/fetch` handler auto-refreshes on expiry — next dashboard load will trigger a refresh_token grant. If that call fails (refresh token also expired/revoked), re-auth via OAuth is required.

**Re-auth steps if auto-refresh fails:**
1. Open the WHOOP OAuth authorization URL for this app.
2. Approve — callback hits `/whoop/callback` and writes fresh tokens to `wc2026.whoop_tokens`.
3. Verify: probe `/health` (worker up), then open dashboard and confirm live WHOOP data loads.

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
            ├─ D1 wc2026: whoop_tokens → EXPIRED (auto-refresh on next call)
            └─ → recovery / cycle / sleep / workout / body / profile
                 └─ extractWhoop() → strain, avgHR, maxHR, prevStrain, weight

  └─ OURA_URL = jubilant-bassoon/outbox/oura-data.json (separate, not worker)
```

---

## Environment

| Binding | Value |
|---|---|
| `DB` | `wc2026` D1 database |
| `WHOOP_CLIENT_ID` | secret |
| `WHOOP_CLIENT_SECRET` | secret |
| `FIELD_MCP_SECRET` | secret (guards `/whoop/tokens`) |
