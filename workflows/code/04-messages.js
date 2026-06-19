// Stage 4: Matching + generación de mensajes con Claude
// Itera sobre todos los closers activos. Cada uno recibe sus propios candidatos.

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

async function sbInsert(table, rows) {
  if (!rows.length) return [];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`sbInsert ${table}: ${await r.text()}`);
  return r.json();
}

async function claude(system, user, maxTokens = 400, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
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
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!r.ok) throw new Error(`Claude: ${await r.text()}`);
      const data = await r.json();
      return data.content[0].text.trim();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) { console.log(`  Claude reintento ${attempt + 1}/${retries}: ${e.message}`); await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); }
    }
  }
  throw lastErr;
}

// Veredicto de oportunidad — nunca se inventa un beneficio. Se basa solo en señales reales
// ya analizadas (anuncios, lanzamiento con evidencia, alto ticket confirmado por Claude, fricción
// real detectada). 'confirmado' = señal fuerte, 'dudoso' = señal débil (se entrega marcado),
// 'sin_beneficio' = ninguna señal real (no se entrega, no cuenta como una de las 5 plazas).
function computeOpportunityVerdict(a) {
  let fs = {};
  try { fs = a.funnel_summary ? JSON.parse(a.funnel_summary) : {}; } catch {}
  const adsCount = Array.isArray(a.creatives_analysis) ? a.creatives_analysis.length : 0;
  const altoTicket = String(fs.alto_ticket || 'desconocido').toLowerCase();
  const launchEvidence = fs.launch_evidence || null;
  const friccion = Array.isArray(fs.fricciones) ? fs.fricciones[0] : null;

  if (adsCount >= 3 || launchEvidence?.snippet || altoTicket === 'si') return 'confirmado';
  if (adsCount > 0 || friccion) return 'dudoso';
  return 'sin_beneficio';
}

// ── Todos los closers activos ─────────────────────────────────────────────────
const closers = await sbGet(`closers?status=eq.active&select=id,email,tone_profile,selected_niches`);
console.log(`Closers activos: ${closers.length}`);
if (!closers.length) return [{ json: { messages: 0, note: 'sin closers activos' } }];

// Fairness: cuando varios closers comparten un niche con poca oferta, sin esto los primeros
// de la lista (por antigüedad de registro) siempre "ganarían" y los últimos se quedarían
// sistemáticamente sin leads. Se prioriza a quien menos leads ha recibido en los últimos 7 días.
const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString();
const recentAssignments = await sbGet(`lead_assignments?assigned_at=gte.${cutoff7d}&select=closer_id`);
const assignmentCounts = new Map();
for (const a of recentAssignments) {
  assignmentCounts.set(a.closer_id, (assignmentCounts.get(a.closer_id) || 0) + 1);
}
closers.sort((a, b) => (assignmentCounts.get(a.id) || 0) - (assignmentCounts.get(b.id) || 0));

// ── Pool de análisis compartido (se consulta una vez para todos) ──────────────
// Límite ampliado: con varios niches activos, el pool necesita cubrir 5 análisis por niche
const analyses = await sbGet(
  `prospect_analyses?select=id,prospect_id,value_opportunities,classification,score,funnel_summary,creatives_analysis`
  + `&score=gte.0&order=score.desc&limit=100`
);

const now = new Date();
const expires = new Date(now.getTime() + 24 * 3600 * 1000);
const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString();

// Exclusividad global: prospects ya asignados a cualquier closer en 30 días
// Se actualiza durante la ejecución para que los closers procesados primero no solapeen con los siguientes
const allAssigned = await sbGet(
  `lead_assignments?assigned_at=gte.${cutoff30d}&select=prospect_id`
);
const globallyAssigned = new Set(allAssigned.map(a => a.prospect_id));

// Categoría de cada niche — permite el fallback "misma categoría" cuando el niche exacto
// elegido por el closer no tiene oferta ese día (ej. eligió crypto-web3 → cae en Finanzas)
const allNichesMeta = await sbGet(`niches?select=id,category`);
const categoryByNicheId = new Map(allNichesMeta.map(n => [n.id, n.category]));

let totalMessages = 0;
const allPreviews = [];

for (const closer of closers) {
  try {
  const tp = closer.tone_profile || {};
  const ss = tp.style_summary || {};
  const transcripts = tp.transcripts || [];
  const regionPref = tp.region_preference || 'both';
  const closerNiches = closer.selected_niches || [];
  const closerCategories = new Set(closerNiches.map(id => categoryByNicheId.get(id)).filter(Boolean));

  // Candidatos válidos: exclusividad global + región. El routing por niche se resuelve
  // en 3 niveles de prioridad para garantizar las 5 plazas sin inventar oferta que no existe:
  //   Nivel 1: niche exacto elegido por el closer
  //   Nivel 2: misma categoría que alguno de sus niches (ej. eligió crypto-web3 → cae en Finanzas)
  //   Nivel 3: cualquier niche (última red de seguridad, solo si 1 y 2 no llenan las 5 plazas)
  const seenHandles = new Set();
  const candidatesByTier = { 1: [], 2: [], 3: [] };
  for (const a of analyses) {
    const [qp] = await sbGet(`qualified_prospects?id=eq.${a.prospect_id}&select=handle,platform_links,detected_niche_id`);
    if (!qp || globallyAssigned.has(a.prospect_id)) continue;

    // Región: la región opuesta a la elegida NUNCA se muestra, sin excepción (ej. closer
    // pidió España, jamás recibe LATAM). "unknown" (sin señales claras en el perfil) se
    // permite solo como último recurso — nunca tiene prioridad sobre un match exacto.
    const prospectRegion = qp.platform_links?.region || 'unknown';
    let regionRank = 2; // 2 = coincide o sin preferencia de región, 1 = unknown (último recurso)
    if (regionPref !== 'both') {
      const oppositeRegion = regionPref === 'spain' ? 'latam' : 'spain';
      if (prospectRegion === oppositeRegion) continue; // exclusión dura, sin excepción
      regionRank = prospectRegion === regionPref ? 2 : 1;
    }

    if (seenHandles.has(qp.handle)) continue;
    seenHandles.add(qp.handle);

    // Sin beneficio real detectado: no se entrega, no ocupa una de las 5 plazas del día.
    // Se filtra aquí (antes de elegir los 5 finales) para no reducir la cuota del closer.
    const verdict = computeOpportunityVerdict(a);
    if (verdict === 'sin_beneficio') continue;

    const prospectNicheId = qp.detected_niche_id || null;
    const prospectCategory = prospectNicheId ? categoryByNicheId.get(prospectNicheId) : null;
    let tier;
    if (closerNiches.length === 0 || !prospectNicheId) tier = 1;
    else if (closerNiches.includes(prospectNicheId)) tier = 1;
    else if (prospectCategory && closerCategories.has(prospectCategory)) tier = 2;
    else tier = 3;

    candidatesByTier[tier].push({ ...a, _nicheId: prospectNicheId || 'unknown', _regionRank: regionRank, _verdict: verdict });
  }

  // Región exacta primero, luego anuncios activos (mejor score primero)
  const adsFirst = (a, b) => {
    if (a._regionRank !== b._regionRank) return b._regionRank - a._regionRank;
    const aAds = Array.isArray(a.creatives_analysis) && a.creatives_analysis.length > 0 ? 1 : 0;
    const bAds = Array.isArray(b.creatives_analysis) && b.creatives_analysis.length > 0 ? 1 : 0;
    return bAds - aAds;
  };
  candidatesByTier[1].sort(adsFirst);
  candidatesByTier[2].sort(adsFirst);
  candidatesByTier[3].sort(adsFirst);

  // Reparto equilibrado dentro de un nivel: cada niche con candidatos aporta al menos 1 lead
  // antes de que el niche con más volumen se quede con todos los slots.
  function balancedPick(list, slotsNeeded) {
    const byNiche = new Map();
    for (const c of list) {
      if (!byNiche.has(c._nicheId)) byNiche.set(c._nicheId, []);
      byNiche.get(c._nicheId).push(c);
    }
    const groups = [...byNiche.values()];
    const picked = [];
    let round = 0;
    while (picked.length < slotsNeeded && groups.some(g => g.length > round)) {
      for (const group of groups) {
        if (picked.length >= slotsNeeded) break;
        if (group.length > round) picked.push(group[round]);
      }
      round++;
    }
    return picked;
  }

  let top = balancedPick(candidatesByTier[1], 5);
  let usedTier2 = false, usedTier3 = false;
  if (top.length < 5) { usedTier2 = candidatesByTier[2].length > 0; top = top.concat(balancedPick(candidatesByTier[2], 5 - top.length)); }
  if (top.length < 5) { usedTier3 = candidatesByTier[3].length > 0; top = top.concat(balancedPick(candidatesByTier[3], 5 - top.length)); }

  const tierNote = usedTier3 ? ' (con fallback a cualquier niche)' : usedTier2 ? ' (con fallback a misma categoría)' : '';
  console.log(`[${closer.email}] Candidatos: niche=${candidatesByTier[1].length} categoría=${candidatesByTier[2].length} otros=${candidatesByTier[3].length} → seleccionados: ${top.length}${tierNote}`);
  if (!top.length) continue;

  // System prompt con el tono de este closer
  const systemPrompt = `Eres este closer escribiendo un mensaje de Instagram a un infoproductor.

PERFIL DEL CLOSER (cómo habla):
Variante de español: ${ss.spanish_variant || 'Español peninsular'}
Registro: ${ss.register || 'Cercano, conversacional'}
Energía: ${ss.energy || 'medio-alto'}
Frases características: ${(ss.characteristic_phrases || []).join(', ')}
Muletillas: ${(ss.filler_words || []).join(', ')}
Aperturas típicas: ${(ss.typical_openers || []).join(', ')}
Formalidad: ${ss.formality_level || 2}/5

EJEMPLOS DE CÓMO HABLA ESTE CLOSER:
${transcripts.slice(0, 3).map(t => t.text?.slice(0, 400)).join('\n---\n')}`;

  for (const analysis of top) {
    try {
    const [qp] = await sbGet(`qualified_prospects?id=eq.${analysis.prospect_id}&select=handle,platform_links,followers`);
    if (!qp) continue;

    const opportunities = Array.isArray(analysis.value_opportunities) ? analysis.value_opportunities : [];
    let vo = opportunities.find(o => o && typeof o.observation === 'string' && o.observation.trim());

    // Fallback: construir vo desde funnel_summary si no hay value_opportunities
    if (!vo) {
      try {
        const fs = analysis.funnel_summary ? JSON.parse(analysis.funnel_summary) : {};
        const friction = Array.isArray(fs.fricciones) ? fs.fricciones[0] : null;
        const strength = Array.isArray(fs.fortalezas) ? fs.fortalezas[0] : null;
        if (friction || fs.promesa) {
          vo = {
            area: 'Embudo',
            observation: friction || fs.promesa || 'Tiene landing activa',
            suggested_value: strength ? `Reforzar ${strength.toLowerCase()}` : 'Mejorar conversión del embudo',
          };
        }
      } catch {}
    }

    if (!vo) {
      console.log(`  @${qp?.handle || '?'}: sin datos suficientes para mensaje — omitido`);
      continue;
    }

    const sourceLabel = vo.area === 'Reels' ? 'reel' : vo.area === 'Embudo' ? 'landing' : vo.area?.toLowerCase() || 'perfil';

    const userPrompt = `INFOPRODUCTOR: @${qp.handle}

LO QUE HAS OBSERVADO (no lo reveles del todo — úsalo para crear curiosidad):
Área: ${vo.area} (${sourceLabel})
Observación: ${vo.observation}
Valor que aportarías: ${vo.suggested_value}

ESTRUCTURA OBLIGATORIA DEL MENSAJE (3 partes):
1. TRIGGER: menciona dónde lo viste de forma específica. Ej: "Estaba mirando tu landing", "He visto tu reel de ayer", "Estaba leyendo tu página de X".
2. TEASER: di que viste algo que podría [beneficio vago relacionado con el valor]. NO expliques el qué todavía. Crea curiosidad.
3. SOFT CLOSE: "Si te interesa te cuento" / "Si quieres te comento" / "Me dices y te explico". NUNCA una pregunta abierta, NUNCA un CTA de venta.

EJEMPLOS DE REFERENCIA de esta estructura (adapta el TONO al closer, no copies el contenido):
Ejemplo A: "Estaba mirando tu linktr.ee y he visto algo que podría ahorrarte tiempo y filtraría mejor a los que quieren trabajar contigo. Si te interesa, me dices y te explico."
Ejemplo B: "He estado leyendo la estrategia que ofreces gratuita y al final en agendar llamada, he visto un pequeño detalle en el calendario que podría mejorar mucho el cierre cuando te agenden llamada. Si quieres te comento."

INSTRUCCIONES CRÍTICAS:
- Escribe en el tono exacto del closer (sus muletillas, su ritmo, sus aperturas).
- MÁXIMO 40 palabras. Menos es más.
- NO expliques el insight en el mensaje. Solo insinúalo.
- PROHIBIDO: adulación de cualquier tipo, preguntas abiertas al final, "te llevo siguiendo".
- Empieza por el trigger, no por el @handle ni por "Hola".

Devuelve SOLO el texto del mensaje. Sin comillas, sin explicaciones.`;

    const messageText = await claude(systemPrompt, userPrompt, 200);
    if (!messageText || messageText.trim().length < 10) {
      console.log(`  @${qp.handle}: Claude devolvió mensaje vacío — omitido`);
      continue;
    }
    console.log(`  @${qp.handle}: mensaje generado (${messageText.trim().split(/\s+/).length} palabras)`);

    const [assignment] = await sbInsert('lead_assignments', [{
      prospect_id: analysis.prospect_id,
      closer_id: closer.id,
      assigned_at: now.toISOString(),
      expires_at: expires.toISOString(),
      status: 'pending',
    }]);

    if (assignment?.id) {
      await sbInsert('generated_messages', [{
        assignment_id: assignment.id,
        message_text: messageText,
        value_point: vo.observation,
      }]);
      globallyAssigned.add(analysis.prospect_id); // evita que este prospect vaya a otro closer en esta misma ejecución
      allPreviews.push({ closer: closer.email, handle: qp.handle, message: messageText.slice(0, 80) + '...' });
      totalMessages++;
    }
    } catch (e) {
      // Aislado: un fallo generando este mensaje no debe impedir los demás leads del mismo closer
      console.log(`  [${closer.email}] candidato falló (no bloqueante): ${e.message}`);
    }
  }

  console.log(`[${closer.email}] Mensajes generados: ${top.length}`);
  } catch (e) {
    // Aislado: un fallo con este closer no debe impedir que los demás closers reciban sus leads
    console.log(`[${closer.email}] Procesamiento falló (no bloqueante): ${e.message}`);
  }
}

console.log(`Total mensajes generados: ${totalMessages}`);
return [{ json: { messages: totalMessages, preview: allPreviews } }];
