// Stage 3: Análisis profundo con Claude (§8.1 funnel + §8.3 value_opportunities)
// Solo procesa prospectos sin análisis o con análisis >7 días.
// Guarda en prospect_analyses.

const axios = require('axios');
async function fetch(url, opts) {
  opts = opts || {};
  const r = await axios({ method: opts.method || 'GET', url, headers: opts.headers || {}, data: opts.body, validateStatus: () => true, responseType: 'text', transformResponse: [x => x] });
  const text = r.data || '';
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) };
}

const SUPABASE_URL = $env.SUPABASE_URL;
const SUPABASE_KEY = $env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = $env.ANTHROPIC_API_KEY;
const APIFY_TOKEN = $env.APIFY_TOKEN;
const META_ADS_TOKEN = $env.META_ADS_TOKEN || null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apifyRunAndWait(actorSlug, input, maxWaitMs = 180000) {
  const start = await fetch(
    `https://api.apify.com/v2/acts/${actorSlug}/runs?token=${APIFY_TOKEN}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
  );
  const startData = await start.json();
  if (!startData?.data?.id) throw new Error('Apify start: ' + JSON.stringify(startData));
  const runId = startData.data.id;
  const datasetId = startData.data.defaultDatasetId;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(6000);
    const info = await (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`)).json();
    const status = info.data?.status;
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'ABORTED') throw new Error(`Apify run ${status}`);
  }
  const items = await (await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=500`)).json();
  return Array.isArray(items) ? items : [];
}

const SB_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'apikey': SUPABASE_KEY,
};

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`sbGet: ${await r.text()}`);
  return r.json();
}

async function sbUpsert(table, rows, conflict) {
  if (!rows.length) return [];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`sbUpsert ${table}: ${await r.text()}`);
  return r.json();
}

async function claude(prompt, maxTokens = 1024) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Claude: ${await r.text()}`);
  const data = await r.json();
  const raw = data.content[0].text.trim();
  // Strip ALL markdown code fences
  const noFences = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(noFences); } catch {}
  // Fallback: find first balanced JSON array/object (string-aware bracket tracking)
  for (let i = 0; i < noFences.length; i++) {
    if (noFences[i] !== '[' && noFences[i] !== '{') continue;
    const open = noFences[i], close = open === '[' ? ']' : '}';
    let depth = 1, j = i + 1, inStr = false, esc = false;
    while (j < noFences.length && depth > 0) {
      const c = noFences[j];
      if (esc) { esc = false; }
      else if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      j++;
    }
    if (depth === 0) { try { return JSON.parse(noFences.slice(i, j)); } catch {} }
  }
  return { raw };
}

async function queryMetaAds(handle) {
  if (!META_ADS_TOKEN) return [];
  try {
    const countries = encodeURIComponent(JSON.stringify(['ES','MX','CO','AR','CL','PE','VE','EC','BO','UY','CR','PA','CU','DO']));
    const fields = 'ad_creative_bodies,ad_creative_link_titles,page_name';
    const url = `https://graph.facebook.com/v21.0/ads_archive?search_terms=${encodeURIComponent(handle)}&ad_type=ALL&ad_reached_countries=${countries}&fields=${fields}&limit=10&access_token=${META_ADS_TOKEN}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.data || []).slice(0, 8);
  } catch { return []; }
}

async function scrapeApifyTikTok(handle, maxItems = 5) {
  try {
    const profileUrl = `https://www.tiktok.com/@${handle}`;
    const items = await apifyRunAndWait('clockworks/free-tiktok-scraper', {
      profiles: [profileUrl],
      resultsPerPage: maxItems,
    }, 90000);
    return items.slice(0, maxItems).map(v => ({
      caption: (v.text || v.description || '').slice(0, 400),
      likes: v.diggCount || v.likes || 0,
      views: v.playCount || v.views || 0,
      type: 'Video',
      date: v.createTime ? new Date(v.createTime * 1000).toISOString().split('T')[0] : null,
    }));
  } catch (e) {
    console.log(`  TikTok scrape failed for @${handle}: ${e.message}`);
    return [];
  }
}

async function fetchLandingText(url) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' },
    });
    const html = await r.text();
    // Extraer texto legible (quitar tags HTML)
    return html.replace(/<script[\s\S]*?<\/script>/gi, '')
               .replace(/<style[\s\S]*?<\/style>/gi, '')
               .replace(/<[^>]+>/g, ' ')
               .replace(/\s+/g, ' ')
               .trim()
               .slice(0, 6000);
  } catch {
    return null;
  }
}

// Prospectos calificados sin análisis o con análisis >7 días
const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString();
const prospects = await sbGet(
  `qualified_prospects?select=id,handle,platform_links,followers&order=qualified_at.desc&limit=20`
);
const existingAnalyses = await sbGet(
  `prospect_analyses?analyzed_at=gte.${cutoff7d}&select=prospect_id`
);
const analyzedIds = new Set(existingAnalyses.map(a => a.prospect_id));

const toAnalyze = prospects.filter(p => !analyzedIds.has(p.id));
console.log(`Prospectos a analizar: ${toAnalyze.length}`);

// ── Batch fetch reels (una sola llamada Apify para todos los perfiles) ────────
const reelsByHandle = {};
if (toAnalyze.length > 0) {
  console.log('Scrapeando reels en batch...');
  try {
    const urls = [...new Set(toAnalyze.map(p => `https://www.instagram.com/${p.handle}/`))];
    const posts = await apifyRunAndWait('apify~instagram-scraper', {
      directUrls: urls,
      resultsType: 'posts',
      resultsLimit: 5,
    });
    for (const post of posts) {
      const h = post.ownerUsername;
      if (!h) continue;
      if (!reelsByHandle[h]) reelsByHandle[h] = [];
      if (reelsByHandle[h].length < 5) {
        reelsByHandle[h].push({
          caption: (post.caption || '').slice(0, 400),
          likes: post.likesCount || 0,
          views: post.videoViewCount || post.videoPlayCount || 0,
          type: post.type || 'Image',
          date: post.timestamp ? post.timestamp.split('T')[0] : null,
        });
      }
    }
    console.log(`Reels obtenidos: ${Object.keys(reelsByHandle).length} perfiles`);
  } catch (e) {
    console.log(`Reels batch falló (no bloqueante): ${e.message}`);
  }
}

const analyses = [];

for (const p of toAnalyze) {
  const landingUrl = p.platform_links?.landing;
  let landingText = '';
  if (landingUrl) {
    landingText = await fetchLandingText(landingUrl) || '';
    console.log(`  @${p.handle}: landing ${landingText ? 'OK' : 'no accesible'} (${landingUrl.slice(0, 60)})`);
  }

  // Meta Ads (requiere META_ADS_TOKEN — opcional, no bloquea)
  const ads = await queryMetaAds(p.handle);
  const adsText = ads.length > 0
    ? ads.map((ad, i) => {
        const body = (ad.ad_creative_bodies || []).join(' ') || '';
        const title = (ad.ad_creative_link_titles || []).join(' ') || '';
        return `Anuncio ${i+1}: ${title ? title + ' — ' : ''}${body}`.slice(0, 300);
      }).join('\n')
    : 'No disponibles (sin token Meta Ads o sin anuncios activos)';
  if (ads.length > 0) console.log(`  @${p.handle}: ${ads.length} anuncios Meta Ads encontrados`);

  // TikTok — busca handle en la bio/landing para intentar scraping
  const tiktokHandle = p.platform_links?.tiktok || null;
  let tiktokReels = [];
  if (tiktokHandle) {
    tiktokReels = await scrapeApifyTikTok(tiktokHandle);
    console.log(`  @${p.handle}: ${tiktokReels.length} vídeos TikTok`);
  }

  // Prompt §8.1 — análisis del embudo
  const funnelPrompt = `Eres un experto en embudos de venta de infoproductos en español.

Te paso el texto de la landing de un infoproductor. Analiza:
1. PROMESA principal (1 frase)
2. ESTRUCTURA: qué secciones tiene y en qué orden
3. PRUEBA SOCIAL: ¿hay? ¿dónde? ¿qué tipo?
4. CTA: ¿qué pide?
5. FRICCIONES: máximo 3 cosas que podrían bajar conversión
6. FORTALEZAS: máximo 2 cosas que están haciendo bien

Devuelve SOLO el JSON con esos 6 campos, sin texto adicional ni bloques de código markdown. Empieza directamente con {.

Handle: @${p.handle}
Followers: ${p.followers}
LANDING:
${landingText || '[No accesible — analiza solo con los datos del perfil de IG]'}`;

  const funnelAnalysis = await claude(funnelPrompt, 800);

  // Reels del perfil (si disponibles)
  const reels = reelsByHandle[p.handle] || [];
  const reelsCaptions = reels.length > 0
    ? reels.map((r, i) => {
        const ago = r.date ? Math.floor((Date.now() - new Date(r.date)) / 86400000) + 'd atrás' : '';
        const engagement = r.views > 0 ? `${(r.views/1000).toFixed(1)}K views` : `${r.likes} likes`;
        return `Reel ${i+1} (${ago}, ${engagement}): ${r.caption || '(sin caption)'}`;
      }).join('\n')
    : 'No disponibles';

  // Combinar reels IG + TikTok
  const allReels = [...reels, ...tiktokReels].slice(0, 8);
  const allReelsCaptions = allReels.length > 0
    ? allReels.map((r, i) => {
        const platform = i < reels.length ? 'IG' : 'TT';
        const ago = r.date ? Math.floor((Date.now() - new Date(r.date)) / 86400000) + 'd atrás' : '';
        const engagement = r.views > 0 ? `${(r.views/1000).toFixed(1)}K views` : `${r.likes} likes`;
        return `[${platform}] Reel ${i+1} (${ago}, ${engagement}): ${r.caption || '(sin caption)'}`;
      }).join('\n')
    : 'No disponibles';

  // Prompt §8.3 — value_opportunities (incluye reels + ads)
  const valuePrompt = `Eres consultor de marketing para infoproductos en español. Tu trabajo es identificar
oportunidades concretas donde alguien podría aportar valor a este infoproductor en un primer contacto.

Tienes:
- Análisis del embudo: ${JSON.stringify(funnelAnalysis)}
- Handle: @${p.handle} | Followers: ${p.followers}
- REELS RECIENTES IG+TikTok (${allReels.length}):
${allReelsCaptions}
- ANUNCIOS ACTIVOS META (${ads.length}):
${adsText}

Identifica 2-4 OPORTUNIDADES DE VALOR. Prioriza las que se basen en algo concreto y específico observado
(una frase del reel, una fricción del embudo, un patrón en sus posts). Cada oportunidad debe:
- Ser específica (citar algo concreto, no "mejorar copy")
- Basarse en lo que acabas de ver en el material
- Ser accionable en horas/días
- NO ser un pitch de "contrátame": es un insight gratis que demuestra que entiendes su negocio

Devuelve SOLO el JSON array, sin texto adicional, sin bloques de código markdown. Empieza con [ y acaba con ].
Formato: { "area": "Embudo"|"Reels"|"Posicionamiento"|"Oferta"|"Anuncios", "observation": "...", "suggested_value": "..." }`;

  const valueOpportunities = await claude(valuePrompt, 800);

  // Clasificación launch vs evergreen — combina landing + reels
  const launchPattern = /masterclass|directo\s+gratis|webinar|reto\s+gratis|día\s+\d|plazas|esta\s+semana|lunes|martes|miércoles|jueves|viernes|\d+\s+de\s+\w+|últimas\s+plazas|abre\s+(matrí|inscri)|cierra\s+(matrí|inscri)/i;
  const allText = landingText + ' ' + allReels.map(r => r.caption).join(' ') + ' ' + adsText;
  const hasLaunchSignals = launchPattern.test(allText);

  // Score: followers + landing + actividad reciente + señal de lanzamiento + anuncios
  const lastReelDays = allReels[0]?.date
    ? Math.floor((Date.now() - new Date(allReels[0].date)) / 86400000)
    : 999;
  const freshnessBonus = lastReelDays <= 3 ? 15 : lastReelDays <= 7 ? 10 : lastReelDays <= 14 ? 5 : 0;
  const launchBonus = hasLaunchSignals ? 20 : 0;
  const adsBonus = ads.length >= 3 ? 15 : ads.length >= 1 ? 8 : 0;
  const score = Math.min(100, Math.round(
    (p.followers / 1000) * 2
    + (landingText ? 20 : 0)
    + freshnessBonus
    + launchBonus
    + adsBonus
  ));

  analyses.push({
    prospect_id: p.id,
    funnel_summary: JSON.stringify(funnelAnalysis),
    vsl_transcript: null,
    creatives_analysis: ads.length > 0 ? ads : null,
    reels_summary: allReels.length > 0 ? allReels : null,
    value_opportunities: Array.isArray(valueOpportunities) ? valueOpportunities : [valueOpportunities],
    launch_date: null,
    classification: hasLaunchSignals ? 'launch' : 'evergreen',
    score,
    analyzed_at: new Date().toISOString(),
  });

  console.log(`  @${p.handle}: análisis OK — score ${analyses[analyses.length - 1].score}`);
}

await sbUpsert('prospect_analyses', analyses, 'prospect_id');
console.log(`prospect_analyses guardados: ${analyses.length}`);

return [{ json: { analyzed: analyses.length } }];
