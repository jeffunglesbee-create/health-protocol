// health-protocol Worker — personal biometric API
// Completely separate from FIELD. Added: 2026-06-26. Fixed: exception handling.
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

// Safe JSON parse — never throws. Returns null if non-JSON response.
async function safeJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { return { _raw: text.slice(0, 300), _status: response.status }; }
}

export default {
  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const pathname = url.pathname;
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });
    try {
      if (pathname === '/')                return handleRoot(env);
      if (pathname === '/oura')            return handleOura(env);
      if (pathname === '/strava')          return handleStrava(env);
      if (pathname === '/strava/callback') return handleStravaCallback(url, env);
      if (pathname === '/whoop')           return handleWhoop();
      return new Response('Not found', { status: 404, headers: CORS });
    } catch (err) {
      return json({ error: err.message, stack: err.stack?.slice(0, 300) }, 500);
    }
  },
};

function handleRoot(env) {
  return json({
    name: 'health-protocol', version: '1.1.0',
    endpoints: ['/oura', '/strava', '/whoop'],
    env_check: {
      kv: !!env.HP_KV,
      strava_id: !!env.STRAVA_CLIENT_ID,
      strava_secret: !!env.STRAVA_CLIENT_SECRET,
      github_pat: !!env.GITHUB_PAT,
    },
    updated: new Date().toISOString(),
  });
}

async function handleOura(env) {
  if (!env.GITHUB_PAT) return json({ error: 'GITHUB_PAT secret not set' }, 503);
  try {
    const r = await fetch(
      'https://raw.githubusercontent.com/jeffunglesbee-create/jubilant-bassoon/main/outbox/oura-data.json',
      { headers: { Authorization: `token ${env.GITHUB_PAT}`, Accept: 'application/json' } }
    );
    if (!r.ok) return json({ error: `oura upstream ${r.status}` }, r.status);
    return new Response(await r.text(), {
      headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=300' },
    });
  } catch (err) {
    return json({ error: `oura fetch failed: ${err.message}` }, 502);
  }
}

async function handleStrava(env) {
  // Env checks
  if (!env.HP_KV)
    return json({ error: 'HP_KV binding missing — check wrangler.toml KV namespace ID' }, 503);
  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET)
    return json({ error: 'STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET not set as Worker secrets' }, 503);

  let tokens;
  try {
    tokens = (await env.HP_KV.get('strava:tokens', 'json')) || {};
  } catch (err) {
    return json({ error: `KV read failed: ${err.message}` }, 503);
  }

  let { access_token, refresh_token, expires_at } = tokens;

  if (!refresh_token)
    return json({ error: 'Strava not configured — refresh_token missing from KV', kv_keys: Object.keys(tokens) }, 503);

  // Refresh if expired or expires_at=0 (initial seed)
  if (!access_token || !expires_at || Date.now() > expires_at - 60_000) {
    try {
      const r = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     env.STRAVA_CLIENT_ID,
          client_secret: env.STRAVA_CLIENT_SECRET,
          refresh_token,
          grant_type:    'refresh_token',
        }),
      });
      const d = await safeJson(r);
      if (!d.access_token) {
        return json({ error: 'Strava refresh failed', status: r.status, detail: d }, 502);
      }
      access_token  = d.access_token;
      refresh_token = d.refresh_token;
      expires_at    = d.expires_at * 1000;
      await env.HP_KV.put('strava:tokens',
        JSON.stringify({ access_token, refresh_token, expires_at }));
    } catch (err) {
      return json({ error: `Strava refresh threw: ${err.message}` }, 502);
    }
  }

  try {
    const auth = { Authorization: `Bearer ${access_token}` };
    const [actResp, athResp] = await Promise.all([
      fetch('https://www.strava.com/api/v3/athlete/activities?per_page=15', { headers: auth }),
      fetch('https://www.strava.com/api/v3/athlete', { headers: auth }),
    ]);

    const [activities, athlete] = await Promise.all([
      safeJson(actResp),
      safeJson(athResp),
    ]);

    // Check for Strava API errors
    if (activities.errors || activities.message) {
      return json({ error: 'Strava activities API error', detail: activities }, 502);
    }

    return json({
      fetched_at: new Date().toISOString(),
      athlete: {
        id: athlete.id, firstname: athlete.firstname,
        lastname: athlete.lastname, city: athlete.city, country: athlete.country,
      },
      activities: Array.isArray(activities) ? activities.map(a => ({
        id: a.id, name: a.name, sport_type: a.sport_type,
        start_local: a.start_date_local, distance: a.distance,
        moving_time: a.moving_time, elapsed_time: a.elapsed_time,
        elevation: a.total_elevation_gain, avg_speed: a.average_speed,
        max_speed: a.max_speed, avg_hr: a.average_heartrate,
        max_hr: a.max_heartrate, avg_cadence: a.average_cadence,
        calories: a.calories, achievement_count: a.achievement_count,
        pr_count: a.pr_count,
      })) : [],
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    return json({ error: `Strava fetch threw: ${err.message}` }, 502);
  }
}

async function handleStravaCallback(url, env) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) return page(`<h1>Strava denied: ${error}</h1>`, 400);
  if (!code) return page('<h1>No code — tokens seeded via KV</h1>');
  try {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET,
        code, grant_type: 'authorization_code',
      }),
    });
    const d = await safeJson(r);
    if (!d.access_token) return page(`<h1>Failed</h1><pre>${JSON.stringify(d,null,2)}</pre>`, 502);
    await env.HP_KV.put('strava:tokens', JSON.stringify({
      access_token: d.access_token, refresh_token: d.refresh_token,
      expires_at: d.expires_at * 1000,
    }));
    const name = d.athlete ? `${d.athlete.firstname} ${d.athlete.lastname}` : 'Unknown';
    return page(`<h1 style="color:#22D3EE">&#10003; Strava Connected</h1>
      <p>${name}</p><p><a href="https://jeffunglesbee-create.github.io/health-protocol">&#8594; Dashboard</a></p>`);
  } catch (err) {
    return page(`<h1>Error: ${err.message}</h1>`, 500);
  }
}

async function handleWhoop() {
  // Proxies to field-relay-nba which manages Whoop OAuth + D1 cache
  try {
    const r = await fetch('https://field-relay-nba.jeffunglesbee.workers.dev/whoop/fetch?days=5');
    if (!r.ok) return json({ error: `whoop upstream ${r.status}` }, r.status);
    return new Response(await r.text(), {
      headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=60' },
    });
  } catch (err) {
    return json({ error: `whoop fetch failed: ${err.message}` }, 502);
  }
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
