// Webhook handler: procesa callback_query de Telegram (botón "Marcar como usado")
// Trigger: POST https://n8n.soplo.io/webhook/tg-callback

const _https = require('https'), _http = require('http'), _URL = require('url').URL;
function fetch(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new _URL(url);
    const lib = u.protocol === 'https:' ? _https : _http;
    const body = opts.body ? Buffer.from(opts.body) : null;
    const headers = { ...(opts.headers || {}) };
    if (body) headers['Content-Length'] = body.length;
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: opts.method || 'GET', headers },
      res => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const SUPABASE_URL = $env.SUPABASE_URL;
const SUPABASE_KEY = $env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = $env.TELEGRAM_BOT_TOKEN;

const body = $input.first().json.body;
const cbq = body?.callback_query;

// Ignorar updates que no sean callback_query (mensajes normales, etc.)
if (!cbq) return [{ json: { skipped: true, reason: 'no callback_query' } }];

const callbackQueryId = cbq.id;
const assignmentId = cbq.data;
const chatId = cbq.message?.chat?.id;
const messageId = cbq.message?.message_id;

// Validar UUID
if (!assignmentId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignmentId)) {
  return [{ json: { skipped: true, reason: 'invalid callback_data' } }];
}

const SB_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'apikey': SUPABASE_KEY,
};

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
