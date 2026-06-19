// Stage 5 (Workflow 02): Delivery — envía los mensajes de hoy a Telegram
// Itera sobre todos los closers activos y envía a cada uno sus leads pendientes.

const axios = require('axios');
async function fetch(url, opts) {
  opts = opts || {};
  const r = await axios({ method: opts.method || 'GET', url, headers: opts.headers || {}, data: opts.body, validateStatus: () => true, responseType: 'text', transformResponse: [x => x] });
  const text = r.data || '';
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) };
}

function escMd(s) { return String(s || '').replace(/[_*`\[]/g, '\\$&'); }

// Mismo criterio que en la asignación (04-messages.js): nunca se inventa un beneficio.
// 'confirmado' = señal fuerte real, 'dudoso' = señal débil (se marca para que decida el closer).
function computeOpportunityVerdict(adsCount, altoTicket, launchEvidence, friccion) {
  if (adsCount >= 3 || launchEvidence?.snippet || altoTicket === 'si') return 'confirmado';
  if (adsCount > 0 || friccion) return 'dudoso';
  return 'sin_beneficio';
}

const SUPABASE_URL = $env.SUPABASE_URL;
const SUPABASE_KEY = $env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = $env.TELEGRAM_BOT_TOKEN;

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

async function tgSend(chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true };
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

const SELLING_PLATFORMS = [
  { name: 'Hotmart', patterns: ['hotmart.com'] },
  { name: 'Kajabi', patterns: ['kajabi.com', 'mykajabi.com'] },
  { name: 'Teachable', patterns: ['teachable.com'] },
  { name: 'Systeme.io', patterns: ['systeme.io'] },
  { name: 'ThriveCart', patterns: ['thrivecart.com'] },
  { name: 'Stan Store', patterns: ['stan.store', 'stanwith.me'] },
  { name: 'Podia', patterns: ['podia.com'] },
  { name: 'Gumroad', patterns: ['gumroad.com'] },
  { name: 'ClickFunnels', patterns: ['clickfunnels.com'] },
  { name: 'Kartra', patterns: ['kartra.com'] },
  { name: 'LearnWorlds', patterns: ['learnworlds.com'] },
  { name: 'Udemy', patterns: ['udemy.com'] },
];

function detectPlatform(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  for (const pl of SELLING_PLATFORMS) {
    if (pl.patterns.some(pat => u.includes(pat))) return pl.name;
  }
  return null;
}

// ── Todos los closers activos con telegram_chat_id ────────────────────────────
const closers = await sbGet(`closers?status=eq.active&select=id,email,telegram_chat_id`);
console.log(`Closers activos: ${closers.length}`);

const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

let totalSent = 0;

for (const closer of closers) {
  if (!closer.telegram_chat_id) {
    console.log(`[${closer.email}] Sin telegram_chat_id — omitido`);
    continue;
  }

  const chatId = closer.telegram_chat_id;

  const assignments = await sbGet(
    `lead_assignments?status=eq.pending&closer_id=eq.${closer.id}&assigned_at=gte.${todayStart.toISOString()}&select=id,prospect_id`
  );
  console.log(`[${closer.email}] Assignments pendientes: ${assignments.length}`);

  if (!assignments.length) {
    await tgSend(chatId, '⚠️ *Pipeline Soplo*\nNo hay leads pendientes para hoy.');
    continue;
  }

  // Header del batch
  await tgSend(chatId, `📋 *Tus leads de hoy — ${new Date().toLocaleDateString('es-ES')}*\n_(${assignments.length} infoproductores cualificados)_`);
  await sleep(500);

  let sent = 0;

  for (let i = 0; i < assignments.length; i++) {
    const asgn = assignments[i];

    const [msg] = await sbGet(`generated_messages?assignment_id=eq.${asgn.id}&select=id,message_text,value_point`);
    if (!msg) continue;

    const [qp] = await sbGet(`qualified_prospects?id=eq.${asgn.prospect_id}&select=handle,followers,platform_links`);
    if (!qp) continue;

    const [analysis] = await sbGet(
      `prospect_analyses?prospect_id=eq.${asgn.prospect_id}&select=funnel_summary,classification,value_opportunities,creatives_analysis`
    );

    let funnelPromise = '';
    let funnelFricciones = [];
    let altoTicket = 'desconocido';
    let altoTicketRazon = '';
    let launchEvidence = null;
    try {
      const fs = analysis?.funnel_summary ? JSON.parse(analysis.funnel_summary) : {};
      funnelPromise = fs.promesa || '';
      funnelFricciones = Array.isArray(fs.fricciones) ? fs.fricciones.slice(0, 2) : [];
      altoTicket = String(fs.alto_ticket || 'desconocido').toLowerCase();
      altoTicketRazon = fs.alto_ticket_razon || '';
      launchEvidence = fs.launch_evidence || null;
    } catch {}

    const classLabel = analysis?.classification === 'launch' ? '🚀 Launch'
      : analysis?.classification === 'evergreen' ? '🔄 Evergreen'
      : '';

    const voArr = Array.isArray(analysis?.value_opportunities) ? analysis.value_opportunities : [];
    const bestVo = voArr.find(o => o && typeof o.observation === 'string' && o.observation.trim());
    const opportunityArea = bestVo?.area || '';
    const opportunityText = (msg.value_point && msg.value_point !== 'null')
      ? msg.value_point
      : bestVo?.observation || null;

    const landing = qp.platform_links?.landing || '';
    const igUrl = `https://www.instagram.com/${qp.handle}/`;
    const adsCount = Array.isArray(analysis?.creatives_analysis) ? analysis.creatives_analysis.length : 0;
    const sellingPlatform = detectPlatform(landing);

    // Dossier del lead — @handle es link clickable a Instagram
    const lines = [
      `*Lead ${i + 1}/${assignments.length} —* [@${qp.handle}](${igUrl})${classLabel ? ` · ${classLabel}` : ''}`,
      `👥 ${qp.followers?.toLocaleString('es-ES')} seguidores`,
    ];
    if (adsCount > 0) lines.push(`📢 *Publicidad activa:* ${adsCount} anuncio${adsCount > 1 ? 's' : ''} Meta Ads`);
    if (landing) lines.push(`🌐 [Landing](${landing})${sellingPlatform ? ` · ${sellingPlatform}` : ''}`);

    if (funnelPromise) lines.push(`📊 ${escMd(funnelPromise)}`);
    if (funnelFricciones.length) lines.push(`⚡ *Fricción:* ${funnelFricciones.map(escMd).join(' · ')}`);

    const reels = Array.isArray(analysis?.reels_summary) ? analysis.reels_summary : [];
    if (reels.length > 0 && reels[0].date) {
      const daysAgo = Math.floor((Date.now() - new Date(reels[0].date)) / 86400000);
      const views = reels[0].views > 0 ? ` · ${(reels[0].views/1000).toFixed(1)}K views` : '';
      lines.push(`🎬 Último reel: hace ${daysAgo}d${views}`);
    }

    // Razonamiento — por qué la app lo recomienda. Cada razón lleva su evidencia concreta
    // (la frase exacta, la fuente) en vez de una etiqueta a ciegas, para que el closer confíe en el dato.
    const reasons = [];
    if (adsCount >= 3) reasons.push(`📢 ${adsCount} anuncios activos en Meta — invirtiendo para cerrar`);
    else if (adsCount > 0) reasons.push(`📢 Publicidad activa en Meta`);
    if (analysis?.classification === 'launch') {
      if (launchEvidence?.snippet) {
        reasons.push(`🚀 Lanzamiento detectado en ${launchEvidence.source}: "${launchEvidence.snippet}"`);
      } else {
        reasons.push('🚀 Lanzamiento activo detectado');
      }
    }
    if (reels.length > 0 && reels[0].date) {
      const daysAgo = Math.floor((Date.now() - new Date(reels[0].date)) / 86400000);
      if (daysAgo <= 7) {
        const views = reels[0].views > 0 ? ` · ${(reels[0].views/1000).toFixed(1)}K views` : '';
        reasons.push(`🎬 Publicó hace ${daysAgo}d${views}`);
      }
    }
    if (altoTicket === 'si') {
      reasons.push(altoTicketRazon ? `💎 Alto ticket: ${altoTicketRazon}` : '💎 Oferta de alto ticket confirmada por Soplo');
    }
    if (sellingPlatform) reasons.push(`🛒 Vende en ${sellingPlatform}`);
    if (funnelFricciones[0]) reasons.push(`⚡ Fricción que podrías ayudar a resolver: "${funnelFricciones[0]}"`);

    const verdict = computeOpportunityVerdict(adsCount, altoTicket, launchEvidence, funnelFricciones[0] || null);
    if (reasons.length > 0) {
      lines.push('');
      if (verdict === 'confirmado') {
        lines.push('🎯 *Por qué contactar:*');
      } else {
        lines.push('⚠️ *Señal dudosa — valora tú si merece la pena:*');
      }
      reasons.forEach(r => lines.push(`· ${escMd(r)}`));
    }

    if (opportunityText) {
      lines.push('');
      lines.push(`💡 *Oportunidad${opportunityArea ? ` (${escMd(opportunityArea)})` : ''}:*`);
      lines.push(escMd(opportunityText));
    }

    await tgSend(chatId, lines.join('\n'));
    await sleep(300);

    // Mensaje como code block independiente — botón 📋 para copiar de un toque en Telegram mobile
    const safeMsg = (msg.message_text?.trim() || '⚠️ Error: mensaje no generado').replace(/`/g, "'");
    await tgSend(chatId, '```\n' + safeMsg + '\n```');

    await sbPatch('lead_assignments', asgn.id, { status: 'delivered' });
    sent++;
    totalSent++;
    await sleep(600);
  }

  console.log(`[${closer.email}] Enviados: ${sent}`);
}

console.log(`Total enviados: ${totalSent}`);
return [{ json: { sent: totalSent } }];
