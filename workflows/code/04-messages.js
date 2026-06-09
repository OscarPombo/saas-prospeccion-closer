// Stage 4: Matching + generación de mensajes con Claude (§8.4)
// Selecciona top 5 prospectos para el founder, genera un mensaje por cada uno.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
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

// ── Candidatos: prospectos con análisis, sin asignación hoy ──────────────────
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

const analyses = await sbGet(
  `prospect_analyses?select=id,prospect_id,value_opportunities,classification,score,funnel_summary`
  + `&score=gte.0&order=score.desc&limit=30`
);

// Prospectos ya asignados hoy a este closer
const todayAssignments = await sbGet(
  `lead_assignments?closer_id=eq.${closer.id}&assigned_at=gte.${todayStart.toISOString()}&select=prospect_id`
);
const alreadyAssigned = new Set(todayAssignments.map(a => a.prospect_id));

// Deduplicar por handle (puede haber varias entradas del mismo infoproductor)
const seenHandles = new Set();
const dedupedCandidates = [];
for (const a of analyses) {
  const [qp] = await sbGet(`qualified_prospects?id=eq.${a.prospect_id}&select=handle`);
  if (qp && !seenHandles.has(qp.handle) && !alreadyAssigned.has(a.prospect_id)) {
    seenHandles.add(qp.handle);
    dedupedCandidates.push(a);
  }
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
  if (!opportunities.length) continue;

  // Elegir la mejor oportunidad (la más específica — la primera por ahora)
  const vo = opportunities[0];

  const userPrompt = `INFOPRODUCTOR DESTINATARIO:
Handle: @${qp.handle}
Nicho: IA aplicada a negocios
Seguidores: ${qp.followers}

PUNTO DE VALOR A APORTAR:
Área: ${vo.area}
Observación: ${vo.observation}
Valor sugerido: ${vo.suggested_value}

INSTRUCCIONES CRÍTICAS:
1. Escribe como esta persona HABLA, no como una persona escribe. Mantén su ritmo y muletillas si caben.
2. El mensaje aporta valor genuino sobre el punto identificado. NO es un pitch de venta.
3. NO menciones que eres closer. NO ofrezcas servicios. NO pidas llamada.
4. Tono: como si fueras un colega del nicho que ha visto algo interesante y quiere compartirlo.
5. Longitud: 60-120 palabras.
6. Empieza llamándole por su @handle.
7. Cierra con una pregunta abierta o una observación que invite a respuesta natural, no con CTA.

Devuelve solo el texto del mensaje, sin comillas ni explicaciones.`;

  const messageText = await claude(systemPrompt, userPrompt, 300);
  console.log(`  @${qp.handle}: mensaje generado (${messageText.split(' ').length} palabras)`);

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
