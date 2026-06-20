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
const WEBHOOK_SECRET = $env.TELEGRAM_WEBHOOK_SECRET;

// Validar que la petición viene realmente de Telegram (no falsificada por un tercero que
// conozca la URL del webhook). Telegram envía este header en cada llamada cuando el webhook
// se registró con secret_token vía setWebhook — sin esto, cualquiera podría simular un
// mensaje de Telegram con un POST directo a esta URL.
const incomingHeaders = $input.first().json.headers || {};
const incomingSecret = incomingHeaders['x-telegram-bot-api-secret-token'] || incomingHeaders['X-Telegram-Bot-Api-Secret-Token'];
if (!WEBHOOK_SECRET || incomingSecret !== WEBHOOK_SECRET) {
  console.log('Webhook rechazado: secret_token ausente o inválido');
  return [{ json: { ok: false, reason: 'invalid secret token' } }];
}

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

// ── /start <token>: vincular telegram_chat_id al closer mediante token único ──────────
// El token se genera en el registro web y llega aquí vía enlace profundo
// (https://t.me/bot?start=TOKEN). Ya no se vincula por @username — cualquiera podía
// escribir el username de otro closer en el formulario y robarle la cuenta.
if (msg?.text?.startsWith('/start')) {
  const chatId = msg.chat.id;
  const token = msg.text.trim().split(/\s+/)[1] || null;

  // 1. Si este chat ya está vinculado a un closer, no hace falta nada más
  const byId = await (await fetch(
    `${SUPABASE_URL}/rest/v1/closers?telegram_chat_id=eq.${chatId}&select=id,email&limit=1`,
    { headers: SB_HEADERS }
  )).json();
  if (Array.isArray(byId) && byId.length > 0) {
    await tgSend(chatId, '✅ Tu cuenta ya estaba vinculada. Recibirás tus leads cada mañana a las 8:00.');
    return [{ json: { ok: true, already_linked: true } }];
  }

  if (!token) {
    await tgSend(chatId, '⚠️ Para vincular tu cuenta, usa el botón "Abrir Telegram y vincular" de la página de registro en la web — no escribas /start manualmente.');
    return [{ json: { ok: false, reason: 'no token' } }];
  }

  // 2. Vincular por token único (de uso único — se anula tras vincular)
  const rows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/closers?link_token=eq.${encodeURIComponent(token)}&select=id,email&limit=1`,
    { headers: SB_HEADERS }
  )).json();
  const closer = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

  if (!closer) {
    await tgSend(chatId, '⚠️ Este enlace de vinculación no es válido o ya se usó. Vuelve a registrarte en la web para generar uno nuevo.');
    return [{ json: { ok: false, reason: 'invalid token' } }];
  }

  // Guardar chat_id y anular el token (uso único, no se puede reutilizar ni compartir)
  await fetch(`${SUPABASE_URL}/rest/v1/closers?id=eq.${closer.id}`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ telegram_chat_id: String(chatId), link_token: null }),
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
