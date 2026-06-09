// Prueba el código de 05-delivery.js en Node.js directamente.
// Si funciona aquí, funciona igual en el Code node de n8n.
require('dotenv').config();

(async () => {
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

  async function tgSend(text) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
    if (!r.ok) throw new Error(`Telegram: ${await r.text()}`);
    return r.json();
  }

  // Test 1: fetch disponible
  console.log('fetch disponible:', typeof fetch === 'function' ? '✓' : '✗');

  // Test 2: Supabase REST con JWT
  const niches = await sbGet('niches?slug=eq.ia-negocios&select=slug,name');
  console.log('Supabase REST:', niches[0]?.slug === 'ia-negocios' ? '✓' : '✗', niches[0]);

  // Test 3: Assignments pendientes (vacío esperado — pipeline no ha corrido)
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const assignments = await sbGet(
    `lead_assignments?status=eq.pending&assigned_at=gte.${todayStart.toISOString()}&select=id`
  );
  console.log('Assignments pendientes hoy:', assignments.length);

  // Test 4: Enviar mensaje de prueba a Telegram
  const msg = await tgSend('✅ *Test delivery* — fetch + Supabase + Telegram OK. Pipeline listo para arrancar.');
  console.log('Telegram:', msg.ok ? '✓ enviado' : '✗');

})().catch(e => { console.error('Error:', e.message); process.exit(1); });
