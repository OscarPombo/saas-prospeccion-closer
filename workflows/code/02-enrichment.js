// Stage 2: Enriquecimiento y filtro duro
// Filtros: followers 5K-100K, externalUrl presente, biography en español
// Lee raw_prospects de las últimas 2h y guarda en qualified_prospects.

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

const SUPABASE_URL = $env.SUPABASE_URL;
const SUPABASE_KEY = $env.SUPABASE_SERVICE_KEY;

const SB_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'apikey': SUPABASE_KEY,
};

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`sbGet ${path}: ${await r.text()}`);
  return r.json();
}

async function sbInsert(table, rows) {
  if (!rows.length) return [];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`sbInsert ${table}: ${await r.text()}`);
  return r.json();
}

// Rechazar bios claramente en otro idioma (estrategia permisiva: solo bloquear lo obvio)
const NON_ES_HINTS = [
  // Inglés
  'i am ', 'i help ', 'i teach', 'follow me', 'dm for', 'i show', 'i share',
  'building', 'founder & ceo', 'speaker &',
  // Portugués (pt-BR) — expandido
  'sou ', 'meu ', 'nosso ', 'aprenda ', 'você ', 'negócios', 'ajudo ',
  'criador', 'conteúdo', 'somos um', 'somos uma', 'hub de', 'inovação',
  'tecnologia m', 'plataforma c', 'aprenda a', 'ajudamos',
  // Francés
  'je suis', 'je vous',
];

function looksSpanish(bio) {
  if (!bio) return true;  // Sin bio → no podemos saber, dejar pasar
  const b = bio.toLowerCase();
  // Rechazar solo si hay señales claras de otro idioma
  return !NON_ES_HINTS.some(h => b.includes(h));
}

// Obtener nicho ia-negocios
const [niche] = await sbGet(`niches?slug=eq.ia-negocios&select=id`);
if (!niche) throw new Error('Nicho ia-negocios no encontrado en BD');
const nicheId = niche.id;

// Leer raw_prospects de las últimas 3h sin qualified correspondiente
const cutoff = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
const rawProspects = await sbGet(
  `raw_prospects?source=eq.instagram&discovered_at=gte.${cutoff}&select=id,handle,raw_data`
);
console.log(`raw_prospects a evaluar: ${rawProspects.length}`);

const qualified = [];

for (const rp of rawProspects) {
  const p = rp.raw_data;
  const followers = p.followersCount || 0;
  const hasLanding = !!p.externalUrl;
  const spanishBio = looksSpanish(p.biography);

  // Filtros duros: followers, landing, idioma
  // Sprint 1: mínimo 3K (nicho IA con infoproductores más pequeños que otros nichos)
  if (followers < 3000 || followers > 100000) continue;
  if (!hasLanding) continue;
  if (!spanishBio) continue;

  qualified.push({
    raw_prospect_id: rp.id,
    handle: rp.handle,
    platform_links: {
      instagram: `https://www.instagram.com/${rp.handle}/`,
      landing: p.externalUrl,
    },
    followers,
    ads_count: 0,      // Se completará en sprint 2 con Meta Ads
    language: 'es',
    detected_niche_id: nicheId,
    detected_mode: 'both',
  });
}

console.log(`Calificados: ${qualified.length} de ${rawProspects.length}`);
await sbInsert('qualified_prospects', qualified);

return [{ json: { qualified: qualified.length, evaluated: rawProspects.length } }];
