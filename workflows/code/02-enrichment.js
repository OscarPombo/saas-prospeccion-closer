// Stage 2: Enriquecimiento y filtro duro
// Filtros: followers 5K-100K, externalUrl presente, biography en español
// Lee raw_prospects de las últimas 2h y guarda en qualified_prospects.

const axios = require('axios');
async function fetch(url, opts) {
  opts = opts || {};
  const r = await axios({ method: opts.method || 'GET', url, headers: opts.headers || {}, data: opts.body, validateStatus: () => true, responseType: 'text', transformResponse: [x => x] });
  const text = r.data || '';
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) };
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

function detectRegion(profile) {
  const text = [
    profile.biography || '',
    profile.externalUrl || '',
    profile.location || '',
    profile.city || '',
    profile.country || '',
  ].join(' ').toLowerCase();

  const spainSigns = [
    'españa', 'spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'bilbao',
    'zaragoza', 'málaga', 'alicante', 'murcia', 'galicia', 'asturias', 'canarias',
    '.es/', '+34', '🇪🇸',
  ];
  const latamSigns = [
    'mexico', 'méxico', 'colombia', 'argentina', 'peru', 'perú', 'chile',
    'venezuela', 'ecuador', 'bolivia', 'uruguay', 'paraguay', 'costa rica',
    'bogotá', 'medellín', 'cali', 'buenos aires', 'lima', 'santiago',
    'monterrey', 'guadalajara', 'cdmx', 'caracas', 'guayaquil', 'quito',
    '.mx/', '.co/', '.ar/', '.pe/', '.cl/', '.ve/', '.ec/', '.bo/', '.uy/',
    '+52', '+54', '+57', '+51', '+56', '+58', '🇲🇽', '🇨🇴', '🇦🇷', '🇵🇪', '🇨🇱',
  ];

  const spainCount = spainSigns.filter(s => text.includes(s)).length;
  const latamCount = latamSigns.filter(s => text.includes(s)).length;
  if (spainCount > 0 && spainCount >= latamCount) return 'spain';
  if (latamCount > 0) return 'latam';
  return 'unknown';
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
      region: detectRegion(p),
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
