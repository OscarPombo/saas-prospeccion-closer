// Stage 1: Apify discovery — hashtag posts → profile scraping → raw_prospects
// Dinámico por niche: solo descubre en los niches que tienen al menos un closer activo,
// y etiqueta cada prospecto con el niche exacto en el que se encontró (sin ambigüedad).

const axios = require('axios');
async function fetch(url, opts) {
  opts = opts || {};
  const r = await axios({ method: opts.method || 'GET', url, headers: opts.headers || {}, data: opts.body, validateStatus: () => true, responseType: 'text', transformResponse: [x => x] });
  const text = r.data || '';
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) };
}

const APIFY_TOKEN = $env.APIFY_TOKEN;
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
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table}: ${await res.text()}`);
  return res.json();
}

// Hashtags por niche fusionado — 22 niches (de los 50 originales), cobertura del onboarding actual
const NICHE_HASHTAGS = {
  // Desarrollo
  'mentalidad-liderazgo': ['altorendimiento', 'mentalidadabundancia', 'liderazgo', 'inteligenciaemocional', 'coachingejecutivo', 'leydeatraccion'],
  'productividad-oratoria': ['productividad', 'oratoria', 'gestiondeltiempo', 'hablarenpublico', 'habitossaludables', 'comunicacionefectiva'],
  // Espiritualidad
  'coaching-espiritual': ['humandesign', 'astrologia', 'mentoriaespiritual', 'coachingtransformacional', 'cartaastral', 'despertarfemenino'],
  // Finanzas
  'trading-bolsa': ['trading', 'bolsa', 'tradingforex', 'valueinvesting', 'inversiones', 'inversionenbolsa'],
  'inversion-inmobiliaria': ['inversioninmobiliaria', 'realestate', 'mentoriainmobiliaria', 'bienesraices', 'inversioninternacional', 'agenteinmobiliario'],
  'finanzas-alternativas': ['libertadfinanciera', 'criptomonedas', 'inversionangel', 'educacionfinanciera', 'web3', 'startups'],
  // IA
  'ia-aplicada': ['ianegocios', 'agenciadeia', 'promptengineering', 'automatizaciones', 'infoproductor', 'agentesdeia'],
  // Marketing
  'funnels-copywriting': ['embudosdeventa', 'copywriting', 'funnels', 'redaccionpublicitaria', 'marketingdigital', 'copywriter'],
  'trafico-pagado-seo': ['metaads', 'seo', 'publicidadfacebook', 'seoconia', 'anunciosfacebook', 'posicionamientoweb'],
  'contenido-organico': ['crecimientoorganico', 'ugccreator', 'youtuber', 'emailmarketing', 'tiktokgrowth', 'contentcreator'],
  // Negocios
  'ecommerce-saas': ['ecommerce', 'microsaas', 'amazonfba', 'dropshipping', 'indiehacker', 'privatelabel'],
  'agencias-consultoria-b2b': ['consultoriab2b', 'agenciamarketing', 'serviciosproductizados', 'consultorianegocios', 'agenciadigital', 'naas'],
  'closers-lanzamientos': ['closerdeventas', 'lanzamientodigital', 'formacioncloser', 'lanzamientoonline', 'ventashightickets', 'plflaunch'],
  'compra-venta-lifestyle': ['compraventadenegocios', 'lifestylebusiness', 'adquisiciondenegocios', 'negociodigital', 'comprarunempresa', 'libertadgeografica'],
  // Relaciones
  'relaciones-bienestar': ['coachingdemujeres', 'terapiadepareja', 'empoderamientofemenino', 'sexualidadconsciente', 'autoestimamujer', 'relacionessanas'],
  'seduccion-masculina': ['seduccion', 'atraccionmasculina', 'hombresalfa', 'seductormasculino', 'desarrollomasculino'],
  // Salud
  'fitness-composicion': ['perdidadepeso', 'hipertrofia', 'bajardepeso', 'culturismo', 'transformacionfisica', 'ganarmusculo'],
  'longevidad-biohacking': ['longevidad', 'biohacking', 'antiaging', 'saludhormonal', 'saludylongevidad', 'optimizacionhormonal'],
  'salud-mental': ['saludmental', 'ansiedad', 'burnout', 'bienestarmental', 'psicologiapositiva'],
  // Skills
  'coaches-cobrar-mas': ['coachesquecobranmas', 'preciosaltos', 'hightickets', 'coachingrentable', 'cobrarmasporloqueeres'],
  'musica-produccion': ['produccionmusical', 'musicaproduccion', 'beatmaker', 'productormusical', 'estudiodegrabacion'],
  'coaching-ejecutivo-c-level': ['coachingejecutivo', 'clevelcoaching', 'liderazgoejecutivo', 'coachexecutivo', 'altadireccion'],
};

// ── Determinar qué niches necesitan discovery hoy (closers activos) ────────────
const activeClosers = await sbGet(`closers?status=eq.active&select=id,selected_niches`);
const neededNicheIdSet = new Set();
for (const c of activeClosers) {
  (c.selected_niches || []).forEach(id => neededNicheIdSet.add(id));
}

if (neededNicheIdSet.size === 0) {
  console.log('Sin closers activos con niches seleccionados — nada que descubrir');
  return [{ json: { discovered: 0, note: 'sin niches activos' } }];
}

const allNiches = await sbGet(`niches?select=id,slug`);
const nicheSlugById = new Map(allNiches.map(n => [n.id, n.slug]));

// ── Control de coste: solo se descubre en niches con poco inventario disponible ────────────
// Discovery es lo más caro en Apify. Si un niche ya tiene suficientes prospectos cualificados
// sin usar (no asignados aún a ningún closer), no hace falta gastar más en buscar — se reutiliza
// el inventario acumulado de días anteriores. Esto evita rastrear los 10 niches todos los días
// cuando solo unos pocos realmente lo necesitan.
const MIN_BUFFER_PER_NICHE = 25;
const cutoff30dBuffer = new Date(Date.now() - 30 * 86400000).toISOString();
const [allQualified, recentAssignmentsBuffer] = await Promise.all([
  sbGet(`qualified_prospects?select=id,detected_niche_id`),
  sbGet(`lead_assignments?assigned_at=gte.${cutoff30dBuffer}&select=prospect_id`),
]);
const assignedSetBuffer = new Set(recentAssignmentsBuffer.map(a => a.prospect_id));
const bufferByNicheId = new Map();
for (const q of allQualified) {
  if (assignedSetBuffer.has(q.id)) continue; // ya usado, no cuenta como inventario disponible
  bufferByNicheId.set(q.detected_niche_id, (bufferByNicheId.get(q.detected_niche_id) || 0) + 1);
}

const allActiveSlugs = [...neededNicheIdSet].map(id => nicheSlugById.get(id)).filter(Boolean);
const bufferBySlug = new Map();
const activeSlugs = [...neededNicheIdSet]
  .filter(id => {
    const buffer = bufferByNicheId.get(id) || 0;
    const slug = nicheSlugById.get(id) || id;
    bufferBySlug.set(slug, buffer);
    if (buffer >= MIN_BUFFER_PER_NICHE) {
      console.log(`  [${slug}] buffer suficiente (${buffer} disponibles) — se omite discovery hoy, ahorro de coste`);
      return false;
    }
    return true;
  })
  .map(id => nicheSlugById.get(id))
  .filter(Boolean);

console.log(`Niches totales activos: ${allActiveSlugs.length} — necesitan discovery hoy: ${activeSlugs.length} (${activeSlugs.join(', ') || 'ninguno'})`);

if (activeSlugs.length === 0) {
  console.log('Todos los niches activos tienen buffer suficiente — discovery omitido por completo hoy');
  return [{ json: { discovered: 0, note: 'buffer suficiente en todos los niches', niches_con_buffer: allActiveSlugs } }];
}

// ── Por cada niche activo: hashtag scraping independiente (sin ambigüedad de origen) ──
// Se procesan en lotes en paralelo (no secuencial) para no acumular tiempo de ejecución
// del nodo — con muchos niches activos, hacerlo uno a uno supera el timeout del Task Runner de n8n.
const usernameToNiche = new Map(); // username -> primer niche donde se encontró

// Volumen de búsqueda escalado según el buffer real del niche — no es lo mismo "ya tiene algo
// de colchón, solo hay que reponer" que "está completamente vacío, hay que sembrarlo fuerte".
// Aplicar el mismo recorte a ambos casos podría dejar a un niche recién elegido por un closer
// sin suficientes leads el primer día. El ahorro de coste sigue viniendo del buffer-skip arriba;
// esto solo evita que el recorte sea demasiado agresivo cuando el niche arranca de cero.
const CRITICAL_BUFFER_THRESHOLD = 5;
function volumeFor(slug) {
  const buffer = bufferBySlug.get(slug) || 0;
  if (buffer < CRITICAL_BUFFER_THRESHOLD) {
    return { hashtags: 6, resultsLimit: 40, usernames: 35 }; // niche vacío: volumen completo
  }
  return { hashtags: 4, resultsLimit: 30, usernames: 25 }; // ya tiene algo de colchón: recorte moderado
}

async function discoverNiche(slug) {
  const vol = volumeFor(slug);
  const hashtags = (NICHE_HASHTAGS[slug] || []).slice(0, vol.hashtags);
  if (!hashtags.length) {
    console.log(`  [${slug}] sin hashtags mapeados — omitido`);
    return [];
  }
  const directUrls = hashtags.map(h => `https://www.instagram.com/explore/tags/${h}/`);
  console.log(`  [${slug}] discovery con hashtags (buffer=${bufferBySlug.get(slug) || 0}): ${hashtags.join(', ')}`);
  try {
    const posts = await apifyRunAndWait('apify~instagram-scraper', {
      directUrls,
      resultsType: 'posts',
      resultsLimit: vol.resultsLimit,
    }, 120000);

    const cutoff = Date.now() - 72 * 3600 * 1000;
    const recentPosts = posts.filter(p => p.timestamp && new Date(p.timestamp).getTime() > cutoff);
    const usernames = [...new Set(recentPosts.map(p => p.ownerUsername).filter(Boolean))].slice(0, vol.usernames);
    console.log(`  [${slug}] posts recientes: ${recentPosts.length} — usernames: ${usernames.length}`);
    return usernames;
  } catch (e) {
    console.log(`  [${slug}] discovery falló (no bloqueante): ${e.message}`);
    return [];
  }
}

const NICHE_CONCURRENCY = 8; // niches procesados a la vez — equilibrio entre velocidad y límites de Apify
for (let i = 0; i < activeSlugs.length; i += NICHE_CONCURRENCY) {
  const batch = activeSlugs.slice(i, i + NICHE_CONCURRENCY);
  const results = await Promise.all(batch.map(slug => discoverNiche(slug).then(usernames => ({ slug, usernames }))));
  for (const { slug, usernames } of results) {
    for (const u of usernames) {
      if (!usernameToNiche.has(u)) usernameToNiche.set(u, slug);
    }
  }
}

const rawUsernames = [...usernameToNiche.keys()];
console.log(`Usernames únicos encontrados: ${rawUsernames.length}`);

if (!rawUsernames.length) return [{ json: { discovered: 0, note: 'sin usernames' } }];

// ── Evitar re-scrapear perfiles que ya tenemos frescos — ahorro directo de Apify ────────
// Si un username se repite en hashtags de varios días (común), no hace falta pagar otra vez
// por su perfil si ya lo tenemos de los últimos 5 días.
const cutoff5dProfiles = new Date(Date.now() - 5 * 86400000).toISOString();
const recentlyScraped = await sbGet(`raw_prospects?source=eq.instagram&discovered_at=gte.${cutoff5dProfiles}&select=handle`);
const recentlyScrapedSet = new Set(recentlyScraped.map(r => r.handle));
const allUsernames = rawUsernames.filter(u => !recentlyScrapedSet.has(u));
const skipped = rawUsernames.length - allUsernames.length;
if (skipped > 0) console.log(`Perfiles omitidos por ya estar frescos (<5 días): ${skipped}`);

if (!allUsernames.length) return [{ json: { discovered: 0, note: 'todos los perfiles ya estaban frescos' } }];

// ── Profile scraping combinado — un solo apify call para todos los niches ──────
console.log('Scrapeando perfiles...');
const profiles = await apifyRunAndWait('apify~instagram-profile-scraper', { usernames: allUsernames }, 300000);
console.log(`Perfiles recibidos: ${profiles.length}`);

// ── Guardar raw_prospects con el niche de origen incluido ───────────────────────
const rows = profiles
  .filter(p => p.username)
  .map(p => ({
    source: 'instagram',
    source_id: p.username,
    handle: p.username,
    url: `https://www.instagram.com/${p.username}/`,
    raw_data: { ...p, __niche_slug: usernameToNiche.get(p.username) || null },
  }));

await supabaseUpsert('raw_prospects', rows);
console.log(`raw_prospects upserted: ${rows.length}`);

return [{ json: { discovered: rows.length, niches: activeSlugs } }];
