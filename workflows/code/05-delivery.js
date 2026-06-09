// Stage 5 (Workflow 02): Delivery — envía los mensajes de hoy a Telegram
// Formatea cada lead como dossier + mensaje copiable y los envía al closer.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CLOSER_TELEGRAM_CHAT_ID;

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

async function sbPatch(table, id, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`sbPatch: ${await r.text()}`);
}

async function tgSend(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram: ${await r.text()}`);
  return r.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Assignments pendientes de hoy
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

const assignments = await sbGet(
  `lead_assignments?status=eq.pending&assigned_at=gte.${todayStart.toISOString()}&select=id,prospect_id`
);
console.log(`Assignments pendientes: ${assignments.length}`);

if (!assignments.length) {
  await tgSend('⚠️ *Pipeline Sprint 1*\nNo hay leads pendientes para hoy.');
  return [{ json: { sent: 0 } }];
}

// Header del batch
await tgSend(`📋 *Tus leads de hoy — ${new Date().toLocaleDateString('es-ES')}*\n_(${assignments.length} infoproductores cualificados)_`);
await sleep(500);

let sent = 0;

for (let i = 0; i < assignments.length; i++) {
  const asgn = assignments[i];

  // Obtener mensaje generado
  const [msg] = await sbGet(`generated_messages?assignment_id=eq.${asgn.id}&select=id,message_text,value_point`);
  if (!msg) continue;

  // Obtener datos del prospecto
  const [qp] = await sbGet(`qualified_prospects?id=eq.${asgn.prospect_id}&select=handle,followers,platform_links`);
  if (!qp) continue;

  const landing = qp.platform_links?.landing || '';
  const igUrl = `https://www.instagram.com/${qp.handle}/`;

  // Dossier del lead
  const dossier = [
    `*Lead ${i + 1}/${assignments.length} — @${qp.handle}*`,
    `👥 ${qp.followers?.toLocaleString('es-ES')} seguidores`,
    `🔗 [Instagram](${igUrl})${landing ? ` · [Landing](${landing})` : ''}`,
    `💡 *Oportunidad:* ${msg.value_point}`,
    ``,
    `*Mensaje listo (copia y pega):*`,
    `\`\`\``,
    msg.message_text,
    `\`\`\``,
  ].join('\n');

  await tgSend(dossier);
  await sbPatch('lead_assignments', asgn.id, { status: 'delivered' });
  sent++;
  await sleep(800); // Evitar flood limit de Telegram
}

console.log(`Mensajes enviados: ${sent}`);
return [{ json: { sent } }];
