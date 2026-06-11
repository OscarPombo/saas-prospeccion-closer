// Stage 4: Matching + generación de mensajes con Claude (§8.4)
// Selecciona top 5 prospectos para el founder, genera un mensaje por cada uno.

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
const CLOSER_EMAIL = 'opombo84@gmail.com';

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

async function sbPatch(table, id, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`sbPatch ${table}: ${await r.text()}`);
}

async function claude(system, user, maxTokens = 400) {
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
}

// ── Obtener closer (founder) ──────────────────────────────────────────────────
const [closer] = await sbGet(`closers?email=eq.${CLOSER_EMAIL}&select=id,tone_profile,selected_niches`);
if (!closer) throw new Error('Closer no encontrado: ' + CLOSER_EMAIL);

const tp = closer.tone_profile;
const ss = tp?.style_summary || {};
const transcripts = tp?.transcripts || [];
const regionPref = tp?.region_preference || 'both'; // 'spain' | 'latam' | 'both'

// ── Candidatos: prospectos con análisis, sin asignación hoy ──────────────────
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

const analyses = await sbGet(
  `prospect_analyses?select=id,prospect_id,value_opportunities,classification,score,funnel_summary`
  + `&score=gte.0&order=score.desc&limit=30`
);

// Prospectos ya asignados en los últimos 30 días a este closer
const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString();
const todayAssignments = await sbGet(
  `lead_assignments?closer_id=eq.${closer.id}&assigned_at=gte.${cutoff30d}&select=prospect_id`
);
const alreadyAssigned = new Set(todayAssignments.map(a => a.prospect_id));

// Deduplicar por handle (puede haber varias entradas del mismo infoproductor)
const seenHandles = new Set();
const dedupedCandidates = [];
for (const a of analyses) {
  const [qp] = await sbGet(`qualified_prospects?id=eq.${a.prospect_id}&select=handle,platform_links`);
  if (!qp || seenHandles.has(qp.handle) || alreadyAssigned.has(a.prospect_id)) continue;
  // Filtro de región
  if (regionPref !== 'both') {
    const prospectRegion = qp.platform_links?.region || 'unknown';
    if (prospectRegion !== 'unknown' && prospectRegion !== regionPref) continue;
  }
  seenHandles.add(qp.handle);
  dedupedCandidates.push(a);
}
const candidates = dedupedCandidates;
const top = candidates.slice(0, 5);
console.log(`Candidatos: ${candidates.length} — Seleccionados: ${top.length}`);

if (!top.length) return [{ json: { messages: 0, note: 'sin candidatos nuevos' } }];

// ── System prompt de tono del closer ─────────────────────────────────────────
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

// ── Generar mensajes ──────────────────────────────────────────────────────────
const messages = [];
const now = new Date();
const expires = new Date(now.getTime() + 24 * 3600 * 1000);

for (const analysis of top) {
  // Obtener datos del prospecto
  const [qp] = await sbGet(`qualified_prospects?id=eq.${analysis.prospect_id}&select=handle,platform_links,followers`);
  if (!qp) continue;

  const opportunities = Array.isArray(analysis.value_opportunities)
    ? analysis.value_opportunities
    : [];

  // Buscar la primera oportunidad con observación válida (JSON bien formado)
  const vo = opportunities.find(o => o && typeof o.observation === 'string' && o.observation.trim());
  if (!vo) {
    console.log(`  @${qp?.handle || '?'}: sin oportunidades válidas — omitido`);
    continue;
  }

  // Donde se observó: landing, reel, linktree, etc.
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

  // Crear lead_assignment
  const [assignment] = await sbInsert('lead_assignments', [{
    prospect_id: analysis.prospect_id,
    closer_id: closer.id,
    assigned_at: now.toISOString(),
    expires_at: expires.toISOString(),
    status: 'pending',
  }]);

  // Guardar mensaje generado
  if (assignment?.id) {
    await sbInsert('generated_messages', [{
      assignment_id: assignment.id,
      message_text: messageText,
      value_point: vo.observation,
    }]);
    messages.push({ handle: qp.handle, message: messageText.slice(0, 80) + '...' });
  }
}

console.log(`Mensajes generados: ${messages.length}`);
return [{ json: { messages: messages.length, preview: messages } }];
