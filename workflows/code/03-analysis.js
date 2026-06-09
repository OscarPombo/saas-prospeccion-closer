// Stage 3: Análisis profundo con Claude (§8.1 funnel + §8.3 value_opportunities)
// Solo procesa prospectos sin análisis o con análisis >7 días.
// Guarda en prospect_analyses.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  try { return JSON.parse(match ? match[0] : raw); }
  catch { return { raw }; }
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

const analyses = [];

for (const p of toAnalyze) {
  const landingUrl = p.platform_links?.landing;
  let landingText = '';
  if (landingUrl) {
    landingText = await fetchLandingText(landingUrl) || '';
    console.log(`  @${p.handle}: landing ${landingText ? 'OK' : 'no accesible'} (${landingUrl.slice(0, 60)})`);
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

Devuelve JSON con esos 6 campos.

Handle: @${p.handle}
Followers: ${p.followers}
LANDING:
${landingText || '[No accesible — analiza solo con los datos del perfil de IG]'}`;

  const funnelAnalysis = await claude(funnelPrompt, 800);

  // Prompt §8.3 — value_opportunities
  const valuePrompt = `Eres consultor de marketing para infoproductos en español. Tu trabajo es identificar
oportunidades concretas donde alguien podría aportar valor a este infoproductor en un primer contacto.

Tienes:
- Análisis del embudo: ${JSON.stringify(funnelAnalysis)}
- Handle: @${p.handle}
- Followers: ${p.followers}

Identifica 2-4 OPORTUNIDADES DE VALOR. Cada una debe:
- Ser específica (no genérica tipo "mejorar copy")
- Basarse en algo concreto observado
- Ser accionable en horas/días
- NO ser un pitch de "contrátame": es un insight gratis

Devuelve JSON array con objetos: { "area": "Embudo"|"Anuncios"|"Reels"|"Posicionamiento"|"Oferta", "observation": "...", "suggested_value": "..." }`;

  const valueOpportunities = await claude(valuePrompt, 800);

  // Clasificación sencilla launch vs evergreen basada en texto del landing
  const hasLaunchSignals = /masterclass|directo|webinar|reto|día \d|plaza|esta semana/i.test(landingText);

  analyses.push({
    prospect_id: p.id,
    funnel_summary: JSON.stringify(funnelAnalysis),
    vsl_transcript: null,
    creatives_analysis: null,
    reels_summary: null,
    value_opportunities: Array.isArray(valueOpportunities) ? valueOpportunities : [valueOpportunities],
    launch_date: null,
    classification: hasLaunchSignals ? 'launch' : 'evergreen',
    score: Math.min(100, Math.round((p.followers / 1000) * 2 + (landingText ? 20 : 0))),
    analyzed_at: new Date().toISOString(),
  });

  console.log(`  @${p.handle}: análisis OK — score ${analyses[analyses.length - 1].score}`);
}

await sbUpsert('prospect_analyses', analyses, 'prospect_id');
console.log(`prospect_analyses guardados: ${analyses.length}`);

return [{ json: { analyzed: analyses.length } }];
