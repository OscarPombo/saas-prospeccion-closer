// Stage 2: Enriquecimiento y filtro duro
// Filtros: followers 5K-100K, externalUrl presente, biography en español
// Lee raw_prospects de las últimas 2h y guarda en qualified_prospects.

const axios = require('axios');
async function fetch(url, opts) {
  opts = opts || {};
  const r = await axios({ method: opts.method || 'GET', url, headers: opts.headers || {}, data: opts.body, validateStatus: () => true, responseType: 'text', transformResponse: [x => x] });
  const text = r.data || '';
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) };
}

const SUPABASE_URL = $env.SUPABASE_URL;
const SUPABASE_KEY = $env.SUPABASE_SERVICE_KEY;

const SB_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'apikey': SUPABASE_KEY,
};

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`sbGet ${path}: ${await r.text()}`);
  return r.json();
}

async function sbInsert(table, rows) {
  if (!rows.length) return [];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`sbInsert ${table}: ${await r.text()}`);
  return r.json();
}

function detectRegion(profile) {
  // Padding con espacios al inicio/fin para que las señales con espacio de margen
  // también cacen al principio o final del texto concatenado.
  const text = (' ' + [
    profile.biography || '',
    profile.externalUrl || '',
    profile.location || '',
    profile.city || '',
    profile.country || '',
  ].join(' ') + ' ').toLowerCase();

  const spainSigns = [
    'españa', 'spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'bilbao',
    'zaragoza', 'málaga', 'alicante', 'murcia', 'galicia', 'asturias', 'canarias',
    '.es/', '+34', 'wa.me/34', '🇪🇸',
    // Modismos / vocabulario característico del español de España
    ' vosotros', ' vosotras', ' currar', ' curro ', ' tío ', ' tía ', ' flipa',
    ' mola ', ' chaval', ' móvil ', ' guay ',
  ];
  const latamSigns = [
    'mexico', 'méxico', 'colombia', 'argentina', 'peru', 'perú', 'chile',
    'venezuela', 'ecuador', 'bolivia', 'uruguay', 'paraguay', 'costa rica',
    'bogotá', 'medellín', 'cali', 'buenos aires', 'lima', 'santiago',
    'monterrey', 'guadalajara', 'cdmx', 'caracas', 'guayaquil', 'quito',
    '.mx/', '.co/', '.ar/', '.pe/', '.cl/', '.ve/', '.ec/', '.bo/', '.uy/',
    '+52', '+54', '+57', '+51', '+56', '+58',
    'wa.me/52', 'wa.me/54', 'wa.me/57', 'wa.me/51', 'wa.me/56', 'wa.me/58',
    '🇲🇽', '🇨🇴', '🇦🇷', '🇵🇪', '🇨🇱',
    // Modismos / vocabulario característico del español latinoamericano
    ' ustedes', ' platicar', ' chevere', ' celular', ' carro ', ' plata ',
    ' chido', ' bacán', ' parce', ' pana ',
  ];

  const spainCount = spainSigns.filter(s => text.includes(s)).length;
  const latamCount = latamSigns.filter(s => text.includes(s)).length;
  if (spainCount > 0 && spainCount >= latamCount) return 'spain';
  if (latamCount > 0) return 'latam';
  return 'unknown';
}

// Señales que identifican portugués — 'ção' solo ya caza el 90% de bios PT
const PT_HINTS = [
  'ção', 'ções', 'ção!', // sufijo exclusivo del portugués
  'você', 'voce ', 'nosso', 'nossa', 'nossas', 'nossos',
  'empreend', 'dinheiro', 'trabalho', 'fazendo', 'obrigad',
  'conteúdo', 'negócio', 'solução', 'criação', 'conexão',
  'sou ', 'meu ', 'minha', 'ajudo ', 'ajudar', 'aprenda ',
  'somos um', 'somos uma', 'criador de', 'inovação', 'ajudamos',
];

// Lista de inglés ampliada — la anterior solo cazaba frases de marketing concretas.
// Se añaden palabras función muy comunes en cualquier frase en inglés (con espacios de margen
// para evitar falsos positivos dentro de palabras en español).
const EN_HINTS = [
  'i am ', 'i help ', 'i teach', 'follow me', 'dm for', 'i show', 'i share',
  'building', 'founder & ceo', 'speaker &', 'coach for', 'helping you',
  ' the ', ' and ', ' with ', ' your ', ' you ', ' for ', ' this ', ' that ',
  ' from ', ' have ', " i'm ", " i've ", " don't ", " can't ", ' our ', ' are ',
  ' will ', ' just ', ' more ', ' than ', ' here ', ' there ', " let's ",
  'link in bio', 'click here', 'sign up', 'learn more', 'find out', 'check out',
  'book a call', 'book your', 'schedule a call', 'message me', 'reach out',
];

// Red de seguridad general: si el texto es razonablemente largo y no tiene NINGUNA señal
// positiva de español (palabras comunes, tildes, ñ), es sospechoso aunque no coincida con
// ningún idioma específico de la lista — cubre alemán, italiano, etc. sin necesidad de
// mantener una lista negra por cada idioma posible.
const SPANISH_POSITIVE_HINTS = [
  ' de ', ' que ', ' para ', ' con ', ' los ', ' las ', ' una ', ' esta ',
  ' soy ', ' mi ', ' tu ', ' te ', ' por ', ' del ', ' como ', ' más ',
  ' su ', ' sus ', ' al ', ' es ', 'ción', 'mente ', 'ando ', 'iendo ',
];

// Lista de palabras francesas ampliada — la anterior (3 frases) dejaba pasar bios en francés
const FR_HINTS = [
  'je suis', 'je vous', 'pour vous', 'nous sommes', 'mon métier', "je t'aide",
  'je vous aide', 'avec moi', "aujourd'hui", 'votre vie', 'notre équipe',
  'coach pour', 'entraîneur', 'formation en ligne', 'voici comment', 'suivez-moi',
  'abonnez-vous', 'rejoignez', 'cliquez ici', 'lien dans la bio', 'découvrez',
  'gratuitement', "c'est", "n'hésite", 'merci de', 'bonjour à', 'depuis que',
  'mes formations', 'mon programme', 'ma méthode', 'entrepreneure', 'créatrice de',
  'coach business', 'développement personnel',
];

// Caracteres exclusivos del francés (nunca aparecen en español) — detecta bios en francés
// aunque no usen ninguna de las frases de arriba. Señal mucho más fiable que el listado de palabras.
const FR_CHAR_PATTERN = /[àâèêëîïôûùÿœ]/;

// Caracteres exclusivos del portugués (nasal ã/õ, nunca en español) — refuerzo del filtro PT
const PT_CHAR_PATTERN = /[ãõ]/;

// Bios que indican que el infoproductor no es accesible directamente (tiene equipo/asistente)
const INACCESSIBLE_HINTS = [
  'escríbele a mi', 'escríbenos a', 'habla con mi asistente', 'habla con mi equipo',
  'dm a mi equipo', 'contacta con mi equipo', 'mensajea a mi equipo',
  'escribe a mi equipo', 'escribe a mi asistente', 'contacta a mi equipo',
  'habla con nuestro equipo', 'escribe a nuestro equipo',
];

function looksSpanish(bio) {
  if (!bio) return true;
  // Padding con espacios para que las señales con margen también cacen al inicio/fin del texto.
  const b = ' ' + bio.toLowerCase() + ' ';
  if (FR_CHAR_PATTERN.test(b)) return false;
  if (PT_CHAR_PATTERN.test(b)) return false;
  if (PT_HINTS.some(h => b.includes(h))) return false;
  if (EN_HINTS.some(h => b.includes(h))) return false;
  if (FR_HINTS.some(h => b.includes(h))) return false;

  // Red de seguridad general: texto razonablemente largo sin ninguna señal positiva de
  // español es sospechoso, sea cual sea el idioma exacto (alemán, italiano, etc.)
  if (b.trim().length >= 20) {
    const hasSpanishSignal = SPANISH_POSITIVE_HINTS.some(h => b.includes(h)) || /[áéíóúñ]/.test(b);
    if (!hasSpanishSignal) return false;
  }

  return true;
}

// Mapa slug → id para resolver el niche que discovery ya etiquetó en cada prospect
const allNiches = await sbGet(`niches?select=id,slug`);
const nicheIdBySlug = new Map(allNiches.map(n => [n.slug, n.id]));

// Leer raw_prospects de las últimas 3h sin qualified correspondiente
const cutoff = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
const rawProspects = await sbGet(
  `raw_prospects?source=eq.instagram&discovered_at=gte.${cutoff}&select=id,handle,raw_data`
);
console.log(`raw_prospects a evaluar: ${rawProspects.length}`);

const qualified = [];

for (const rp of rawProspects) {
  const p = rp.raw_data;
  const followers = p.followersCount || 0;
  const hasLanding = !!p.externalUrl;
  const spanishBio = looksSpanish(p.biography);

  // Filtros duros: followers, landing, idioma
  // 10K mínimo: autoridad suficiente para high ticket, max 100K para acceso directo al infoproductor
  if (followers < 10000 || followers > 100000) continue;
  if (!hasLanding) continue;
  if (!spanishBio) continue;
  // Filtrar cuentas donde el infoproductor no es accesible directamente
  if (INACCESSIBLE_HINTS.some(h => (p.biography || '').toLowerCase().includes(h))) continue;
  // Engagement rate: descartar audiencia muerta (< 0.5% likes/seguidores)
  // Usamos avgLikes si existe; si no hay dato, dejamos pasar (no penalizamos por ausencia de info)
  const avgLikes = p.avgLikes || p.likesCount || 0;
  if (avgLikes > 0 && followers > 0 && (avgLikes / followers) < 0.005) continue;

  // Niche de origen: lo etiquetó discovery según el hashtag donde se encontró el perfil
  const nicheId = nicheIdBySlug.get(p.__niche_slug);
  if (!nicheId) {
    console.log(`  @${rp.handle}: niche '${p.__niche_slug}' no resuelto — omitido`);
    continue;
  }

  qualified.push({
    raw_prospect_id: rp.id,
    handle: rp.handle,
    platform_links: {
      instagram: `https://www.instagram.com/${rp.handle}/`,
      landing: p.externalUrl,
      region: detectRegion(p),
    },
    followers,
    ads_count: 0,      // Se completará en sprint 2 con Meta Ads
    language: 'es',
    detected_niche_id: nicheId,
    detected_mode: 'both',
  });
}

console.log(`Calificados: ${qualified.length} de ${rawProspects.length}`);
await sbInsert('qualified_prospects', qualified);

return [{ json: { qualified: qualified.length, evaluated: rawProspects.length } }];
