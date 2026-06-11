// Stage 1: Apify discovery — hashtag posts → profile scraping → raw_prospects

const _https = require('https'), _http = require('http'), _URL = require('url').URL;
function fetch(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new _URL(url);
    const lib = u.protocol === 'https:' ? _https : _http;
    const body = opts.body ? Buffer.from(opts.body) : null;
    const headers = { ...(opts.headers || {}) };
    if (body) headers['Content-Length'] = body.length;
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: opts.method || 'GET', headers },
      res => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const APIFY_TOKEN = $env.APIFY_TOKEN;
const SUPABASE_URL = $env.SUPABASE_URL;
const SUPABASE_KEY = $env.SUPABASE_SERVICE_KEY;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apifyRunAndWait(actorSlug, input, maxWaitMs = 240000) {
  const start = await fetch(
    `https://api.apify.com/v2/acts/${actorSlug}/runs?token=${APIFY_TOKEN}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
  );
  const startData = await start.json();
  if (!startData?.data?.id) throw new Error('Apify start failed: ' + JSON.stringify(startData));

  const runId = startData.data.id;
  const datasetId = startData.data.defaultDatasetId;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await sleep(6000);
    const info = await (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`)).json();
    const status = info.data?.status;
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'ABORTED') throw new Error(`Apify run ${status} — runId: ${runId}`);
  }

  const items = await (await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=200`)).json();
  return Array.isArray(items) ? items : [];
}

async function supabaseUpsert(table, rows) {
  if (!rows.length) return [];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=source,source_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Prefer': 'return=representation,resolution=ignore-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table}: ${await res.text()}`);
  return res.json();
}

// ── Hashtags para nicho ia-negocios ──────────────────────────────────────────
// Mix de hashtags grandes (infoproductores establecidos los usan) + específicos de IA
const HASHTAGS = [
  // Específicos IA en español
  'ianegocios', 'cursosdeia', 'iaparaemprendedores',
  'chatgptnegocios', 'automatizacionempresarial',
  // Infoproducción general (más cuentas establecidas)
  'infoproductor', 'negociosonline', 'cursosonline',
  'mentoriaonline', 'marketingdigital',
  // IA amplio (incluye cuentas grandes)
  'inteligenciaartificial',
];
const directUrls = HASHTAGS.map(h => `https://www.instagram.com/explore/tags/${h}/`);

// Step 1: hashtag posts
console.log('Discovery: arrancando hashtag scraper en', HASHTAGS.join(', '));
const posts = await apifyRunAndWait('apify~instagram-scraper', {
  directUrls,
  resultsType: 'posts',
  resultsLimit: 100,
});

// Step 2: usernames únicos de las últimas 72h
const cutoff = Date.now() - 72 * 3600 * 1000;
const recentPosts = posts.filter(p => p.timestamp && new Date(p.timestamp).getTime() > cutoff);
const usernameSet = new Set(recentPosts.map(p => p.ownerUsername).filter(Boolean));
const usernames = [...usernameSet].slice(0, 50);
console.log(`Posts recientes: ${recentPosts.length} — Usernames únicos: ${usernames.length}`);

if (!usernames.length) return [{ json: { discovered: 0, note: 'sin usernames' } }];

// Step 3: profile scraping
console.log('Scrapeando perfiles...');
const profiles = await apifyRunAndWait('apify~instagram-profile-scraper', { usernames }, 300000);
console.log(`Perfiles recibidos: ${profiles.length}`);

// Step 4: guardar raw_prospects
const rows = profiles
  .filter(p => p.username)
  .map(p => ({
    source: 'instagram',
    source_id: p.username,
    handle: p.username,
    url: `https://www.instagram.com/${p.username}/`,
    raw_data: p,
  }));

await supabaseUpsert('raw_prospects', rows);
console.log(`raw_prospects upserted: ${rows.length}`);

return [{ json: { discovered: rows.length, sample_usernames: usernames.slice(0, 5) } }];
