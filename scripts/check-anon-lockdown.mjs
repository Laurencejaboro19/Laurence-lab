#!/usr/bin/env node
// Probes a real Supabase project with the PUBLIC anon key and asserts that no
// business table is reachable through the Data API. Run after every deploy to a
// new Supabase project (staging, production) and in CI when the variables exist:
//
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=eyJ... node scripts/check-anon-lockdown.mjs
//
// Pass criteria: every probed table returns 401/403/404 (or an empty 200 with a
// PostgREST "schema not exposed" error). Any 200 with rows is a FAIL.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.log(
    'check-anon-lockdown: SUPABASE_URL / SUPABASE_ANON_KEY not set — skipping (nothing to probe).',
  );
  process.exit(0);
}

const TABLES = ['customers', 'orders', 'payments', 'audit_log', 'staff', 'settings', 'messages'];
let failed = false;
for (const table of TABLES) {
  // Try both the default (public) schema and an explicit app schema header.
  for (const headers of [{}, { 'Accept-Profile': 'app' }]) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers },
    });
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    let rows = null;
    try {
      rows = JSON.parse(body);
    } catch {
      /* not JSON */
    }
    const leaked = res.status === 200 && Array.isArray(rows);
    const label = headers['Accept-Profile'] ? `app.${table}` : table;
    console.log(`${leaked ? 'FAIL' : 'ok  '} ${label.padEnd(16)} HTTP ${res.status}`);
    if (leaked) failed = true;
  }
}
console.log(
  failed
    ? '\nRESULT: FAIL — the anon key can read business data. Fix before going live.'
    : '\nRESULT: PASS',
);
process.exit(failed ? 1 : 0);
