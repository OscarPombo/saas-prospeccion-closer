// Webhook handler: procesa callback_query de Telegram (botón "Marcar como usado")
// Trigger: POST https://n8n.soplo.io/webhook/tg-callback

const axios = require('axios');
async function fetch(url, opts) {
  opts = opts || {};
  const r = await axios({ method: opts.method || 'GET', url, headers: opts.headers || {}, data: opts.body, validateStatus: () => true, responseType: 'text', transformResponse: [x => x] });
  const text = r.data || '';
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) };
}

const SUPABASE_URL = $env.SUPABASE_URL;
const SUPABASE_KEY = $env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = $env.TELEGRAM_BOT_TOKEN;

const body = $input.first().json.body;
const cbq = body?.callback_query;
const msg = body?.message;

const SB_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'apikey': SUPABASE_KEY,
};

async function tgSend(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

// ── /start: vincular telegram_chat_id al closer ───────────────────────────────
if (msg?.text?.startsWith('/start')) {
  const chatId = msg.chat.id;
  const tgUsername = (msg.from?.username || '').toLowerCase().replace(/^@/, '');

  // 1. Buscar por chat_id ya vinculado (cuentas antiguas o ya registradas)
  let closer = null;
  const byId = await (await fetch(
    `${SUPABASE_URL}/rest/v1/closers?telegram_chat_id=eq.${chatId}&select=id,email,telegram_chat_id&limit=1`,
    { headers: SB_HEADERS }
  )).json();
  if (Array.isArray(byId) && byId.length > 0) closer = byId[0];

  // 2. Si no, buscar por telegram_username del formulario de registro
  if (!closer && tgUsername) {
    for (const uname of [tgUsername, '@' + tgUsername]) {
      const rows = await (await fetch(
        `${SUPABASE_URL}/rest/v1/closers?tone_profile->>telegram_username=eq.${encodeURIComponent(uname)}&select=id,email,telegram_chat_id&limit=1`,
        { headers: SB_HEADERS }
      )).json();
      if (Array.isArray(rows) && rows.length > 0) { closer = rows[0]; break; }
    }
  }

  if (!closer && !tgUsername) {
    await tgSend(chatId, '⚠️ Tu cuenta de Telegram no tiene @username configurado. Ve a Ajustes → edita tu perfil y añade un nombre de usuario.');
    return [{ json: { ok: false, reason: 'no username' } }];
  }

  if (!closer) {
    await tgSend(chatId, '⚠️ No encontré tu registro. Asegúrate de haberte registrado primero en la web con el mismo @username de Telegram.');
    return [{ json: { ok: false, reason: 'closer not found', tgUsername } }];
  }

  if (closer.telegram_chat_id) {
    await tgSend(chatId, '✅ Tu cuenta ya estaba vinculada. Recibirás tus leads cada mañana a las 8:00.');
    return [{ json: { ok: true, already_linked: true } }];
  }

  // Guardar chat_id
  await fetch(`${SUPABASE_URL}/rest/v1/closers?id=eq.${closer.id}`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ telegram_chat_id: String(chatId) }),
  });

  await tgSend(chatId, `✅ *¡Cuenta vinculada!*\n\nPerfecto, ya está todo listo. Mañana a las *8:00* recibirás tus primeros 5 infoproductores cualificados con toda la información para entablar conversación.\n\nBienvenido a Soplo.`);
  console.log(`/start: closer ${closer.email} vinculado → chat_id ${chatId}`);
  return [{ json: { ok: true, linked: true, email: closer.email } }];
}

// Ignorar updates que no sean callback_query ni /start
if (!cbq) return [{ json: { skipped: true, reason: 'no callback_query' } }];

const callbackQueryId = cbq.id;
const assignmentId = cbq.data;
const chatId = cbq.message?.chat?.id;
const messageId = cbq.message?.message_id;

// Validar UUID
if (!assignmentId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignmentId)) {
  return [{ json: { skipped: true, reason: 'invalid callback_data' } }];
}

// Marcar como usado en BD
const patch = await fetch(`${SUPABASE_URL}/rest/v1/lead_assignments?id=eq.${assignmentId}`, {
  method: 'PATCH',
  headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
  body: JSON.stringify({ status: 'used' }),
});
const updated = patch.status === 204;

// Responder al callback (quita el spinner del botón inmediatamente)
await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    callback_query_id: callbackQueryId,
    text: updated ? '✅ Lead marcado como usado' : '⚠️ No se pudo actualizar',
    show_alert: false,
  }),
});

// Quitar el botón del mensaje original para evitar doble-click
if (chatId && messageId) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }),
  });
}

console.log(`Callback: assignment ${assignmentId} → ${updated ? 'used' : 'error'}`);
return [{ json: { updated, assignmentId } }];
