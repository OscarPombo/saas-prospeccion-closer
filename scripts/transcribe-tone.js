// Bloque B: transcribe los 5 audios de tono con Whisper y genera style_summary con Claude.
// Uso: node scripts/transcribe-tone.js
require('dotenv').config();

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai').default;
const Anthropic = require('@anthropic-ai/sdk').default;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CLOSER_EMAIL = 'opombo84@gmail.com';
const AUDIO_DIR = path.join(__dirname, '../audios-tono');

const QUESTIONS = [
  'Preséntate como si estuvieras conociendo a alguien en un evento de marketing.',
  'Imagínate que te cruzas con un infoproductor que te interesa y quieres romper el hielo en frío.',
  'Cuéntame un cierre del que estés orgulloso y por qué funcionó.',
  '¿Qué problema concreto crees que tienen los infoproductores que aún no han trabajado con un closer profesional?',
  '(Calibración casual) Cuéntame qué te gusta hacer fuera del trabajo, un domingo cualquiera.',
];

async function transcribeAudio(audioPath, questionIndex) {
  const { toFile } = await import('openai');
  const filename = path.basename(audioPath);
  const file = await toFile(fs.createReadStream(audioPath), filename, { type: 'audio/ogg' });

  const response = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'es',
    prompt: 'Conversación en español sobre ventas, marketing, closers, infoproductores y mentoría high ticket.',
  });

  return { question: questionIndex + 1, text: response.text };
}

async function generateStyleSummary(transcripts) {
  const transcriptBlocks = transcripts
    .map((t, i) => `TRANSCRIPCIÓN ${t.question} (${QUESTIONS[i]}):\n${t.text}`)
    .join('\n---\n');

  const prompt = `Eres lingüista experto en español hispanoamericano y peninsular.

Te paso 5 transcripciones de audio de la misma persona respondiendo distintas preguntas.

Extrae su perfil de habla:

1. spanish_variant: ej. "Argentino rioplatense", "Mexicano neutro", "Castellano de España"
2. register: descripción cualitativa (cercano, formal, técnico, etc.)
3. energy: nivel de energía (alto, medio, bajo) + descripción
4. uses_tuteo_or_voseo: "tuteo", "voseo", o "ustedeo"
5. characteristic_phrases: array de 5-10 frases o giros que repite
6. filler_words: array de muletillas
7. avg_sentence_length_words: número aproximado
8. typical_openers: cómo suele empezar a hablar/responder
9. formality_level: 1 (muy informal) a 5 (muy formal)

Devuelve JSON puro, sin markdown, sin explicaciones.

TRANSCRIPCIONES:
${transcriptBlocks}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text.trim();
  // Extraer JSON si viene con markdown fence
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : raw);
}

(async () => {
  const pgClient = new Client({
    host:     `db.${new URL(process.env.SUPABASE_URL).hostname.split('.')[0]}.supabase.co`,
    port:     5432,
    database: 'postgres',
    user:     'postgres',
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl:      { rejectUnauthorized: false },
  });

  try {
    await pgClient.connect();

    const audioFiles = fs.readdirSync(AUDIO_DIR)
      .filter(f => /\.(ogg|m4a|webm|mp3|wav)$/i.test(f))
      .sort()
      .slice(0, 5);

    if (audioFiles.length === 0) {
      throw new Error(`No se encontraron audios en ${AUDIO_DIR}`);
    }
    console.log(`Archivos (${audioFiles.length}):`, audioFiles.join(', '));

    console.log('\nTranscribiendo en paralelo con Whisper-1...');
    const transcripts = await Promise.all(
      audioFiles.map((f, i) => transcribeAudio(path.join(AUDIO_DIR, f), i))
    );
    transcripts.sort((a, b) => a.question - b.question);

    transcripts.forEach(t => {
      console.log(`\n--- Q${t.question} (${t.text.split(' ').length} palabras) ---`);
      console.log(t.text.slice(0, 300) + (t.text.length > 300 ? '...' : ''));
    });

    console.log('\nGenerando style_summary con Claude Sonnet 4.6...');
    const styleSummary = await generateStyleSummary(transcripts);
    console.log('\nStyle summary generado:');
    console.log(JSON.stringify(styleSummary, null, 2));

    const toneProfile = {
      audios: audioFiles.map((f, i) => ({
        question: i + 1,
        filename: f,
      })),
      transcripts,
      style_summary: styleSummary,
    };

    await pgClient.query(
      'UPDATE closers SET tone_profile = $1 WHERE email = $2',
      [JSON.stringify(toneProfile), CLOSER_EMAIL]
    );
    console.log('\ntone_profile guardado en Supabase ✓');

  } catch (err) {
    console.error('\nError:', err.message);
    process.exit(1);
  } finally {
    await pgClient.end();
  }
})();
