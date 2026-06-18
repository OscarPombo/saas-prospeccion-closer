import type { APIRoute } from 'astro';
import OpenAI from 'openai';

export const POST: APIRoute = async ({ request }) => {
  try {
    const formData = await request.formData();
    const name = formData.get('name') as string;
    const email = formData.get('email') as string;
    const telegram = formData.get('telegram') as string;
    const region = formData.get('region') as string;
    const nichesRaw = formData.get('niches') as string;
    const niches: string[] = nichesRaw ? JSON.parse(nichesRaw) : ['ia-negocios'];
    const audioFile = formData.get('audio') as File;

    if (!name || !email || !telegram || !audioFile) {
      return new Response(JSON.stringify({ error: 'Faltan campos obligatorios' }), { status: 400 });
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

    // 3. Crear closer en Supabase
    const sbRes = await fetch(`${import.meta.env.SUPABASE_URL}/rest/v1/closers?on_conflict=email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${import.meta.env.SUPABASE_SERVICE_KEY}`,
        'apikey': import.meta.env.SUPABASE_SERVICE_KEY,
        'Prefer': 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify({
        email,
        tone_profile: {
          ...toneProfile,
          region_preference: region,
          name,
          telegram_username: telegram,
        },
        status: 'active',
        timezone: 'Europe/Madrid',
        mode: 'both',
        selected_niches: niches,
      }),
    });

    if (!sbRes.ok) {
      const err = await sbRes.text();
      throw new Error(`Supabase: ${err}`);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err: unknown) {
    console.error('Onboarding error:', err);
    const msg = err instanceof Error ? err.message : 'Error interno';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
};
