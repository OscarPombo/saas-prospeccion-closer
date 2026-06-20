import type { APIRoute } from 'astro';
import OpenAI from 'openai';
import crypto from 'node:crypto';

const MAX_REQUESTS_PER_WINDOW = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB — Whisper rechaza por encima de 25 MB

export const POST: APIRoute = async ({ request, clientAddress }) => {
  try {
    const SUPABASE_URL = import.meta.env.SUPABASE_URL;
    const SB_HEADERS = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${import.meta.env.SUPABASE_SERVICE_KEY}`,
      'apikey': import.meta.env.SUPABASE_SERVICE_KEY,
    };

    // Rate limiting por IP — cada petición cuesta dinero real (Whisper + Claude). Sin esto,
    // cualquiera podría vaciar el presupuesto de API con un script simple. Se comprueba antes
    // de hacer ningún trabajo costoso.
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || clientAddress || 'unknown';
    const rateCutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const rateCheckRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rate_limits?identifier=eq.${encodeURIComponent(ip)}&endpoint=eq.onboarding&created_at=gte.${rateCutoff}&select=id`,
      { headers: SB_HEADERS }
    );
    const recentAttempts: { id: string }[] = rateCheckRes.ok ? await rateCheckRes.json() : [];
    if (recentAttempts.length >= MAX_REQUESTS_PER_WINDOW) {
      return new Response(JSON.stringify({ error: 'Demasiados intentos. Inténtalo de nuevo en una hora.' }), { status: 429 });
    }
    // Se registra el intento ya aquí (no solo si tiene éxito) para que los reintentos cuenten.
    await fetch(`${SUPABASE_URL}/rest/v1/rate_limits`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ identifier: ip, endpoint: 'onboarding' }),
    });

    const formData = await request.formData();
    const name = formData.get('name') as string;
    const email = formData.get('email') as string;
    const region = formData.get('region') as string;
    const nichesRaw = formData.get('niches') as string;
    const niches: string[] = nichesRaw ? JSON.parse(nichesRaw) : [];
    const audioFile = formData.get('audio') as File;

    if (!name || !email || !audioFile) {
      return new Response(JSON.stringify({ error: 'Faltan campos obligatorios' }), { status: 400 });
    }
    if (!niches.length) {
      return new Response(JSON.stringify({ error: 'Selecciona al menos un nicho' }), { status: 400 });
    }
    if (audioFile.size > MAX_AUDIO_BYTES) {
      return new Response(JSON.stringify({ error: 'El audio pesa demasiado (máximo 20 MB).' }), { status: 400 });
    }

    // Si ya existe una cuenta activa y vinculada con este email, no se permite sobrescribirla
    // sin verificación — evita que alguien que solo conoce el email de otro closer le robe
    // la cuenta re-registrándose con sus propios datos de Telegram.
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/closers?email=eq.${encodeURIComponent(email)}&select=id,telegram_chat_id`,
      { headers: SB_HEADERS }
    );
    const existing: { id: string; telegram_chat_id: string | null }[] = existingRes.ok ? await existingRes.json() : [];
    if (existing.length > 0 && existing[0].telegram_chat_id) {
      return new Response(JSON.stringify({ error: 'Ya existe una cuenta activa con este email. Si necesitas hacer cambios, escríbenos.' }), { status: 409 });
    }

    // 1. Transcribir audio con Whisper
    const openai = new OpenAI({ apiKey: import.meta.env.OPENAI_API_KEY });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'es',
    });
    const transcript = transcription.text;

    // 2. Extraer perfil de tono con Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': import.meta.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `Analiza esta transcripción de audio de un closer de ventas llamado ${name} y extrae su perfil de tono.

TRANSCRIPCIÓN:
${transcript}

Devuelve SOLO el JSON, sin texto adicional:
{
  "style_summary": {
    "spanish_variant": "Español peninsular|Español latinoamericano",
    "register": "descripción breve (ej: cercano, directo, conversacional)",
    "energy": "bajo|medio|medio-alto|alto",
    "characteristic_phrases": ["frase1", "frase2"],
    "filler_words": ["muletilla1", "muletilla2"],
    "typical_openers": ["apertura1", "apertura2"],
    "formality_level": 2
  },
  "transcripts": [{ "text": "${transcript.slice(0, 500).replace(/"/g, "'")}" }]
}`,
        }],
      }),
    });
    const claudeData = await claudeRes.json();
    let toneProfile: object = { style_summary: {}, transcripts: [{ text: transcript.slice(0, 500) }] };
    try {
      const raw = claudeData.content?.[0]?.text?.trim() || '{}';
      toneProfile = JSON.parse(raw.replace(/```json?\s*/gi, '').replace(/```/g, '').trim());
    } catch { /* usa el fallback */ }

    // 3. Convertir slugs de nichos a UUIDs — solo se aceptan slugs con formato válido
    // (defensa en profundidad: nunca interpolar entrada del usuario sin validar en un filtro)
    const validSlugs = niches.filter(s => /^[a-z0-9-]+$/.test(s));
    const nicheSlugs = validSlugs.join(',');
    const nichesRes = nicheSlugs
      ? await fetch(`${SUPABASE_URL}/rest/v1/niches?slug=in.(${nicheSlugs})&select=id`, { headers: SB_HEADERS })
      : null;
    const nicheRows: { id: string }[] = nichesRes?.ok ? await nichesRes.json() : [];
    const nicheIds = nicheRows.map(r => r.id);

    // 4. Generar token único de vinculación — el closer lo usa para conectar su Telegram
    // vía un enlace profundo (/start <token>) en vez de que el sistema confíe en un username
    // que cualquiera podría escribir.
    const linkToken = crypto.randomBytes(16).toString('hex');

    // 5. Crear/actualizar closer en Supabase
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/closers?on_conflict=email`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify({
        email,
        tone_profile: {
          ...toneProfile,
          region_preference: region,
          name,
        },
        status: 'active',
        timezone: 'Europe/Madrid',
        mode: 'both',
        selected_niches: nicheIds,
        link_token: linkToken,
      }),
    });

    if (!sbRes.ok) {
      console.error('Supabase onboarding error:', await sbRes.text());
      throw new Error('No se pudo completar el registro');
    }

    return new Response(JSON.stringify({ ok: true, linkToken }), { status: 200 });
  } catch (err: unknown) {
    console.error('Onboarding error:', err);
    return new Response(JSON.stringify({ error: 'Error interno, inténtalo de nuevo' }), { status: 500 });
  }
};
