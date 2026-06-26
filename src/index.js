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
    strava_reauth: '/strava/callback',
    updated: new Date().toISOString(),
  });
}

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

async function handleStrava(env) {
  let { access_token, refresh_token, expires_at } =
    (await env.HP_KV.get('strava:tokens', 'json')) || {};
  if (!refresh_token)
    return json({ error: 'Strava not configured', setup: 'tokens not yet seeded in KV' }, 503);
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
    athlete: { id: athlete.id, firstname: athlete.firstname,
      lastname: athlete.lastname, city: athlete.city, country: athlete.country },
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

async function handleStravaCallback(url, env) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) return page(`<h1>Strava denied: ${error}</h1>`, 400);
  if (!code) return page('<h1>No code — tokens seeded via KV</h1>');
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET,
      code, grant_type: 'authorization_code',
    }),
  });
  const d = await r.json();
  if (!d.access_token) return page(`<h1>Failed</h1><pre>${JSON.stringify(d,null,2)}</pre>`, 502);
  await env.HP_KV.put('strava:tokens', JSON.stringify({
    access_token: d.access_token, refresh_token: d.refresh_token,
    expires_at: d.expires_at * 1000,
  }));
  const name = d.athlete ? `${d.athlete.firstname} ${d.athlete.lastname}` : 'Unknown';
  return page(`<h1 style="color:#22D3EE">&#10003; Strava Connected</h1>
    <p>${name}</p><p><a href="https://jeffunglesbee-create.github.io/health-protocol">&#8594; Dashboard</a></p>`);
}

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
