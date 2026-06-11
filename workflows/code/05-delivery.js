// Stage 5 (Workflow 02): Delivery — envía los mensajes de hoy a Telegram
// Formatea cada lead como dossier + mensaje copiable y los envía al closer.

const axios = require('axios');
async function fetch(url, opts) {
  opts = opts || {};
  const r = await axios({ method: opts.method || 'GET', url, headers: opts.headers || {}, data: opts.body, validateStatus: () => true, responseType: 'text', transformResponse: [x => x] });
  const text = r.data || '';
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) };
}

function escMd(s) { return String(s || '').replace(/[_*`\[]/g, '\\$&'); }

const SUPABASE_URL = $env.SUPABASE_URL;
const SUPABASE_KEY = $env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = $env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = $env.CLOSER_TELEGRAM_CHAT_ID;

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

async function tgSend(text, replyMarkup = null) {
  const payload = { chat_id: CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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

  // Obtener mensaje generado, datos del prospecto y análisis
  const [msg] = await sbGet(`generated_messages?assignment_id=eq.${asgn.id}&select=id,message_text,value_point`);
  if (!msg) continue;

  const [qp] = await sbGet(`qualified_prospects?id=eq.${asgn.prospect_id}&select=handle,followers,platform_links`);
  if (!qp) continue;

  const [analysis] = await sbGet(
    `prospect_analyses?prospect_id=eq.${asgn.prospect_id}&select=funnel_summary,classification,value_opportunities`
  );

  // Parsear funnel summary para obtener promesa y fricciones
  let funnelPromise = '';
  let funnelFricciones = [];
  try {
    const fs = analysis?.funnel_summary ? JSON.parse(analysis.funnel_summary) : {};
    funnelPromise = fs.promesa || '';
    funnelFricciones = Array.isArray(fs.fricciones) ? fs.fricciones.slice(0, 2) : [];
  } catch {}

  const classLabel = analysis?.classification === 'launch' ? '🚀 Launch'
    : analysis?.classification === 'evergreen' ? '🔄 Evergreen'
    : '';

  // Mejor oportunidad disponible (prioriza value_point guardado, fallback al análisis)
  const voArr = Array.isArray(analysis?.value_opportunities) ? analysis.value_opportunities : [];
  const bestVo = voArr.find(o => o && typeof o.observation === 'string' && o.observation.trim());
  const opportunityArea = bestVo?.area || '';
  const opportunityText = (msg.value_point && msg.value_point !== 'null')
    ? msg.value_point
    : bestVo?.observation || null;

  const landing = qp.platform_links?.landing || '';
  const igUrl = `https://www.instagram.com/${qp.handle}/`;

  // Dossier del lead
  const lines = [
    `*Lead ${i + 1}/${assignments.length} — @${escMd(qp.handle)}*${classLabel ? ` · ${classLabel}` : ''}`,
    `👥 ${qp.followers?.toLocaleString('es-ES')} seguidores`,
    `🔗 [Instagram](${igUrl})${landing ? ` · [Landing](${landing})` : ''}`,
  ];

  if (funnelPromise) lines.push(`📊 ${escMd(funnelPromise)}`);
  if (funnelFricciones.length) lines.push(`⚡ *Fricción:* ${funnelFricciones.map(escMd).join(' · ')}`);

  // Actividad reciente de reels
  const reels = Array.isArray(analysis?.reels_summary) ? analysis.reels_summary : [];
  if (reels.length > 0 && reels[0].date) {
    const daysAgo = Math.floor((Date.now() - new Date(reels[0].date)) / 86400000);
    const views = reels[0].views > 0 ? ` · ${(reels[0].views/1000).toFixed(1)}K views` : '';
    lines.push(`🎬 Último reel: hace ${daysAgo}d${views}`);
  }

  if (opportunityText) {
    lines.push('');
    lines.push(`💡 *Oportunidad${opportunityArea ? ` (${escMd(opportunityArea)})` : ''}:*`);
    lines.push(escMd(opportunityText));
  }

  // Backticks en el mensaje romperían el bloque de código de Telegram
  const safeMsg = (msg.message_text?.trim() || '⚠️ Error: mensaje no generado').replace(/`/g, "'");
  lines.push('');
  lines.push('*Mensaje — copia en DM de Instagram:*');
  lines.push('```');
  lines.push(safeMsg);
  lines.push('```');

  const dossier = lines.join('\n');

  await tgSend(dossier);
  await sbPatch('lead_assignments', asgn.id, { status: 'delivered' });
  sent++;
  await sleep(800); // Evitar flood limit de Telegram
}

console.log(`Mensajes enviados: ${sent}`);
return [{ json: { sent } }];
