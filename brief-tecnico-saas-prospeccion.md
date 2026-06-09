# Brief técnico — SaaS de prospección para closers

**Versión:** 0.1 (beta) · **Fecha:** Junio 2026 · **Lector objetivo:** dev que va a construir el MVP

---

## 1. Resumen ejecutivo

SaaS B2B que entrega cada mañana a las 8:00 un batch de 10 leads de infoproductores ultra-cualificados a closers de ventas, vía Telegram. Cada lead incluye un mini-dossier del infoproductor y un primer mensaje de prospección ya redactado en el tono personal del closer, cuyo objetivo es **aportar valor concreto** (no vender), comentando algo específico de su embudo, sus reels o su publicidad.

- **Mercado:** España + LATAM, infoproductos con ticket ≥1.000€
- **Beta de validación:** 5 closers conocidos del fundador, pago único 1€ vía Stripe
- **Objetivo de la beta:** validar que los leads y los mensajes son lo bastante buenos como para que un closer los use sin reescribir

---

## 2. Concepto del producto

### 2.1 Flujo del usuario

1. El closer descubre el SaaS, paga 1€ en checkout Stripe.
2. Onboarding (5–10 min): elige 5 nichos de los 50 disponibles, modalidad (lanzamiento / evergreen / ambos), graba 5 audios cortos respondiendo preguntas (para capturar tono), conecta su Telegram.
3. A partir de la mañana siguiente, recibe a las 8:00 (zona horaria configurable) un bloque de 10 leads en Telegram.
4. Cada lead incluye dossier + mensaje listo para copiar y pegar.
5. Cada lead asignado bloquea 24h de exclusividad para ese closer (lo use o no lo use). Durante esas 24h ningún otro closer recibe ese mismo infoproductor. Pasadas las 24h, el lead vuelve al pool y puede asignarse a otro closer — al closer que ya lo usó, no se le vuelve a mostrar durante 10 días (pasado ese cooldown, si el infoproductor sigue cualificando puede volver a recibirlo, típicamente útil en un nuevo lanzamiento).

### 2.2 El mensaje de valor (concepto clave)

El primer mensaje **NO** es un pitch de cierre. Es un mensaje que aporta valor genuino al infoproductor sobre algo concreto de su operación actual:

- Detecta una fricción en su embudo de captación
- Comenta un ángulo no explorado en sus anuncios
- Sugiere una mejora sobre un reel reciente
- Aporta un dato/insight relevante para su nicho

El objetivo es destacar entre los 50 DMs genéricos que recibe el infoproductor y abrir conversación. La venta viene en una segunda interacción, que ya es trabajo manual del closer.

El **tono** del closer (capturado por audio) es la voz con la que se entrega ese valor. El **contenido** sale del análisis IA del infoproductor.

### 2.3 Asignación 24h

Un mismo infoproductor solo se asigna a un closer durante 24h, **lo use o no lo use**. Durante esas 24h, ningún otro closer puede recibirlo. Pasadas las 24h vuelve al pool y puede asignarse a otro closer — excepto al que ya lo usó, que entra en cooldown de 10 días para ese infoproductor (después puede recibirlo de nuevo si vuelve a cualificar, p. ej. en un nuevo lanzamiento). Protege al infoproductor de recibir varios DMs el mismo día y aprovecha re-engagements en futuros lanzamientos.

---

## 3. Stack técnico

| Componente | Servicio | Coste mensual aprox. |
|---|---|---|
| Orquestación | n8n self-hosted en VPS Hetzner (CX22) | 4€ |
| Base de datos, auth, storage | Supabase (plan gratis al inicio) | 0€ |
| Scraping IG/TikTok/YouTube | Apify | 0–30€ |
| Anuncios FB/IG | Meta Ad Library API | 0€ |
| IA texto y visión | Claude API (Sonnet 4.6) | 30–60€ |
| Transcripción audio | OpenAI Whisper API | 5–10€ |
| Pasarela de pago | Stripe | comisión por transacción |
| Frontend dashboard | Next.js 14 + Tailwind + shadcn/ui en Vercel | 0€ |
| Entrega | Telegram Bot API | 0€ |
| Dominio | TLD a elegir | ~10€/año |

**Total estimado para beta de 5 closers: 40–80€/mes.**

### 3.1 Justificación de decisiones

- **n8n vs código puro:** acelera flujos batch (cron, scrapeos, llamadas a APIs encadenadas) sin sacrificar capacidad — soporta código JS cuando hace falta. Self-hosted en Hetzner es 4€/mes, sin vendor lock.
- **Supabase vs alternativas:** auth + Postgres + storage + edge functions en un solo servicio con plan gratuito generoso.
- **Claude Sonnet 4.6:** mejor calidad/precio para textos largos en español, soporte de visión nativo (para creatividades de anuncios), few-shot prompting muy eficaz para clonar tono.
- **Apify vs scraping propio:** gestiona rotación de IPs, captchas, evasión de detección. Construir esto desde cero son semanas de trabajo y mantenimiento continuo.

---

## 4. Modelo de datos (Postgres / Supabase)

```sql
-- Catálogo fijo de los 50 nichos (ver §10)
CREATE TABLE niches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  default_mode text CHECK (default_mode IN ('launch','evergreen','both'))
);

-- Closers (usuarios del SaaS)
CREATE TABLE closers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  telegram_chat_id text,
  stripe_customer_id text,
  selected_niches uuid[] DEFAULT '{}',
  mode text CHECK (mode IN ('launch','evergreen','both')),
  tone_profile jsonb DEFAULT '{}', -- ver §6.4
  timezone text DEFAULT 'Europe/Madrid',
  status text CHECK (status IN ('onboarding','active','paused','cancelled')),
  created_at timestamptz DEFAULT now()
);

-- Prospectos descubiertos en bruto
CREATE TABLE raw_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text CHECK (source IN ('meta_ads','instagram','tiktok','youtube')),
  source_id text NOT NULL,
  handle text,
  url text,
  raw_data jsonb,
  discovered_at timestamptz DEFAULT now(),
  UNIQUE (source, source_id)
);

-- Prospectos que pasan filtros duros
CREATE TABLE qualified_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_prospect_id uuid REFERENCES raw_prospects(id),
  handle text,
  platform_links jsonb,
  followers int,
  ads_count int,
  language text,
  detected_niche_id uuid REFERENCES niches(id),
  detected_mode text,
  qualified_at timestamptz DEFAULT now()
);

-- Análisis profundo cacheado (reutilizable entre closers)
CREATE TABLE prospect_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid REFERENCES qualified_prospects(id),
  funnel_summary text,
  vsl_transcript text,
  creatives_analysis jsonb,
  reels_summary jsonb,
  value_opportunities jsonb, -- núcleo: 2-4 oportunidades de valor
  launch_date timestamptz,
  classification text CHECK (classification IN ('launch','evergreen')),
  score int,
  analyzed_at timestamptz DEFAULT now()
);

-- Asignaciones con lock 24h
CREATE TABLE lead_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid REFERENCES qualified_prospects(id),
  closer_id uuid REFERENCES closers(id),
  assigned_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text CHECK (status IN ('pending','delivered','expired','used')) DEFAULT 'pending'
);
CREATE INDEX idx_assignments_active ON lead_assignments(prospect_id, expires_at, status);

-- Mensaje generado por (prospecto, closer)
CREATE TABLE generated_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid REFERENCES lead_assignments(id),
  message_text text,
  value_point text,
  generated_at timestamptz DEFAULT now()
);
```

---

## 5. Pipeline diario

Todo orquestado por n8n con cron. Times en zona horaria del closer (configurable, default Europe/Madrid).

| Hora | Workflow | Qué hace |
|---|---|---|
| 06:00 | Discovery | Workers paralelos: Meta Ad Library, Apify (IG/TikTok/YT) → `raw_prospects` |
| 06:30 | Enrichment | Extrae seguidores, ad count, idioma, links → cualificados → `qualified_prospects` |
| 07:00 | Deep analysis | Solo prospectos que matchean ≥1 closer activo y sin análisis <7 días → `prospect_analyses` |
| 07:30 | Matching | Por closer: filtrar nichos + modalidad, excluir locks, priorizar timing, top 10 → `lead_assignments` |
| 07:45 | Message generation | Por assignment: mensaje con tono del closer + punto de valor → `generated_messages` |
| 08:00 | Telegram delivery | Batch envía 10 mensajes/closer al chat de Telegram |

Re-análisis cada 7 días: datos como ad count o launch date cambian, el sistema re-analiza si el análisis tiene >7 días.

---

## 6. Onboarding del closer

### 6.1 Pasos

1. Landing → CTA "Empezar por 1€"
2. Checkout Stripe (1€)
3. Email magic link de Supabase para crear cuenta
4. Dashboard onboarding (4 pasos):
   - **Paso 1:** elegir 5 nichos de los 50
   - **Paso 2:** modalidad (lanzamiento / evergreen / ambos)
   - **Paso 3:** grabar 5 audios de tono (en navegador, MediaRecorder API)
   - **Paso 4:** vincular Telegram (deep link `https://t.me/[bot]?start=[user_id]`)

### 6.2 Las 5 preguntas para audio (tono)

Cada respuesta debe durar 30–90 segundos. UI con botones "Grabar / Parar / Repetir".

1. **Preséntate como si estuvieras conociendo a alguien en un evento de marketing.** Cómo te llamas, qué haces, cómo llegaste a ser closer.
2. **Imagínate que te cruzas con un infoproductor que te interesa y quieres romper el hielo en frío.** ¿Qué le dirías en los primeros 30 segundos para que te haga caso, sin pitch de venta, solo aportando valor?
3. **Cuéntame un cierre del que estés orgulloso y por qué funcionó.** Sin prisa, como si lo contaras a un colega tomando café.
4. **¿Qué problema concreto crees que tienen los infoproductores que aún no han trabajado con un closer profesional?** Explícalo como tú lo ves.
5. **(Calibración casual)** Cuéntame qué te gusta hacer fuera del trabajo, un domingo cualquiera.

### 6.3 Procesamiento post-grabación

Al terminar el paso 3, en background:

1. Cada audio se sube a Supabase Storage (bucket `tone-audios`, organizado por `closer_id/qN.webm`).
2. Whisper transcribe cada audio. Transcripciones se guardan en `closers.tone_profile.transcripts`.
3. Claude analiza las 5 transcripciones con el prompt §8.5 y devuelve `tone_profile.style_summary`.

### 6.4 Estructura de `tone_profile`

```json
{
  "audios": [
    {"question": 1, "url": "https://.../q1.webm", "duration_s": 67}
  ],
  "transcripts": [
    {"question": 1, "text": "Pues mira, yo soy fulanito, llevo..."}
  ],
  "style_summary": {
    "spanish_variant": "Mexicano neutro",
    "register": "Cercano, conversacional, sin formalismos",
    "energy": "Alto, entusiasta",
    "uses_tuteo_or_voseo": "Tuteo",
    "characteristic_phrases": ["a ver...", "mira, lo que pasa es que", "te lo digo de verdad"],
    "filler_words": ["o sea", "¿sabes?"],
    "avg_sentence_length_words": 14,
    "typical_openers": ["Oye, ", "Mira, "],
    "formality_level": 2
  }
}
```

---

## 7. Análisis profundo del infoproductor

Por cada prospecto cualificado que matchea con algún closer activo, se hace un análisis multi-fuente. Output cacheado en `prospect_analyses`.

### 7.1 Fuentes de análisis

| Fuente | Cómo se obtiene | Qué se extrae |
|---|---|---|
| Bio + perfil IG/TikTok | Apify | Posicionamiento, promesa, link bio |
| Landing del embudo | fetch HTML + Claude | Estructura, promesa, prueba social, CTA, fricciones |
| VSL (si hay) | Whisper transcribe | Estructura del pitch, argumentos, debilidades |
| Reels recientes (5 últimos) | Apify + Claude (captions + visión thumbs) | Temas, hooks, calidad |
| Creatividades de anuncios (5–10) | Meta Ad Library + Claude visión | Hook visual, claim, ángulo, oportunidades |

### 7.2 Output crítico: `value_opportunities`

Lista de 2–4 oportunidades concretas donde el closer podría aportar valor en su primer mensaje:

```json
"value_opportunities": [
  {
    "area": "Embudo",
    "observation": "La landing no tiene prueba social arriba del fold",
    "suggested_value": "Comentar que añadir 2-3 testimonios antes del CTA puede subir conversión 15-30%"
  },
  {
    "area": "Anuncios",
    "observation": "Los 7 anuncios activos usan el mismo hook (problema-solución)",
    "suggested_value": "Sugerir testear ángulo 'testimonio en primera persona' que funciona en su nicho"
  }
]
```

El generador de mensajes elige UNA de estas oportunidades para construir el mensaje del closer.

---

## 8. Prompts de IA críticos

Todos para Claude Sonnet 4.6. Se llaman desde n8n (HTTP request a la Anthropic API).

### 8.1 Análisis del embudo (landing)

```
Eres un experto en embudos de venta de infoproductos en español.

Te paso el HTML/texto de la landing de un infoproductor. Analiza:

1. PROMESA principal (1 frase)
2. ESTRUCTURA: qué secciones tiene y en qué orden
3. PRUEBA SOCIAL: ¿hay? ¿dónde? ¿qué tipo?
4. CTA: ¿qué pide? (webinar, llamada, masterclass)
5. FRICCIONES: máximo 3 cosas que podrían bajar conversión
6. FORTALEZAS: máximo 2 cosas que están haciendo bien

Devuelve JSON con esos 6 campos.

LANDING:
{landing_text}
```

### 8.2 Análisis de creatividades de anuncios (visión)

```
Eres analista de creatividades publicitarias en infoproductos en español.

Te paso N imágenes/videos de anuncios activos de un mismo infoproductor.

Para CADA anuncio analiza:
- HOOK: primera frase / imagen
- ÁNGULO: ¿problema-solución? ¿testimonio? ¿transformación? ¿curiosidad?
- CLAIM principal
- ELEMENTOS visuales destacables

Luego analiza el CONJUNTO:
- ¿Hay diversidad de ángulos o todos repiten el mismo?
- ¿Qué ángulo NO están explorando que podría funcionar en su nicho ({niche})?
- ¿Algún anuncio destaca por encima del resto?

Devuelve JSON con análisis por anuncio + análisis global.
```

### 8.3 Extracción de puntos de valor (el más importante del análisis)

```
Eres consultor de marketing para infoproductos en español. Tu trabajo es identificar
oportunidades concretas donde alguien podría aportar valor a este infoproductor en un
primer contacto.

Tienes:
- Análisis del embudo: {funnel_analysis}
- Análisis de anuncios: {ads_analysis}
- Resumen de reels recientes: {reels_summary}
- Transcripción de VSL (si hay): {vsl_transcript}

Identifica 2-4 OPORTUNIDADES DE VALOR. Cada una debe:
- Ser específica (no genérica tipo "mejorar copy")
- Basarse en algo concreto que has visto en el material
- Ser accionable: el infoproductor podría aplicarlo en horas/días
- NO ser un pitch de "contrátame": es un insight gratis

Para cada oportunidad devuelve:
{
  "area": "Embudo" | "Anuncios" | "Reels" | "Posicionamiento" | "Oferta",
  "observation": "lo que has visto, específico",
  "suggested_value": "qué valor podría aportar el closer comentándolo"
}
```

### 8.4 Generación del mensaje de prospección (el más importante del producto)

Usa few-shot con las transcripciones del closer.

```
Eres este closer escribiendo un mensaje de Instagram/email a un infoproductor.

PERFIL DEL CLOSER (cómo habla):
Variante de español: {spanish_variant}
Registro: {register}
Energía: {energy}
Frases típicas: {characteristic_phrases}
Muletillas: {filler_words}
Aperturas típicas: {typical_openers}
Formalidad: {formality_level}/5

EJEMPLOS DE CÓMO HABLA ESTE CLOSER (transcripciones de audio):
{transcript_1}
---
{transcript_2}
---
{transcript_3}
---

INFOPRODUCTOR DESTINATARIO:
Handle: @{handle}
Nicho: {niche}
Promesa: {promise}

PUNTO DE VALOR A APORTAR (úsalo como eje del mensaje):
Área: {value_opportunity.area}
Observación: {value_opportunity.observation}
Valor sugerido: {value_opportunity.suggested_value}

INSTRUCCIONES CRÍTICAS:
1. Escribe como esta persona HABLA, no como una persona escribe. Mantén su ritmo, sus muletillas si caben naturalmente.
2. El mensaje aporta valor genuino sobre el punto identificado. NO es un pitch de venta.
3. NO menciones que eres closer. NO ofrezcas servicios. NO pidas llamada.
4. Tono: como si fueras un colega del nicho que ha visto algo interesante y quiere compartirlo.
5. Longitud: 60-120 palabras.
6. Empieza llamándole por su @handle o nombre si lo conoces.
7. Cierra con una pregunta abierta o una observación que invite a respuesta natural, no con CTA.

Devuelve solo el texto del mensaje, sin comillas ni explicaciones.
```

### 8.5 Construcción del perfil de tono desde audios

```
Eres lingüista experto en español hispanoamericano y peninsular.

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

Devuelve JSON.

TRANSCRIPCIONES:
{transcript_1}
---
{transcript_2}
...
```

### 8.6 Clasificación lanzamiento vs evergreen + detección temporal

```
Lee el siguiente material de un infoproductor:

- Bio: {bio}
- Captions de últimos reels: {reels_captions}
- Copys de anuncios activos: {ads_copy}
- Landing: {landing_text}

Determina:

1. classification: "launch" si hay señales claras de lanzamiento en próximos 7-14 días
   (masterclass gratuita, directo gratuito, "vente a mi directo el día X", fechas específicas).
   "evergreen" si todo apunta a embudo permanente (agenda llamada, VSL, sin fechas).

2. launch_date: si es "launch" y hay fecha concreta, devuélvela en ISO 8601.
   Si hay urgencia sin fecha exacta ("esta semana", "el viernes"), estima.

3. confidence: 0-100, qué seguro estás.

4. evidence: cita las frases concretas del material que sustentan tu decisión.

Devuelve JSON.
```

---

## 9. Matching y lock 24h

### 9.1 Lógica de selección

```python
def select_leads_for_closer(closer):
    # 1. Candidatos: prospectos que matchean sus 5 nichos + modalidad
    candidates = query("""
        SELECT qp.*, pa.*
        FROM qualified_prospects qp
        JOIN prospect_analyses pa ON pa.prospect_id = qp.id
        WHERE qp.detected_niche_id = ANY(closer.selected_niches)
          AND (closer.mode = 'both' OR pa.classification = closer.mode)
          AND qp.language IN ('es', closer.preferred_languages)
    """)

    # 2. Excluir los que tienen lock activo de OTRO closer
    candidates = [c for c in candidates
                  if not has_active_lock_for_other_closer(c.id, closer.id)]

    # 3. Excluir los que el closer ya usó en los últimos 10 días
    candidates = [c for c in candidates
                  if not closer_used_within_cooldown(closer.id, c.id, days=10)]

    # 4. Priorización
    candidates.sort(key=lambda c: (
        urgency_score(c.launch_date),  # lanzamientos 3-7 días = top
        c.score,                        # calidad del lead
        recency(c.qualified_at)         # más recientes primero
    ), reverse=True)

    # 5. Top 10
    return candidates[:10]
```

### 9.2 Implementación del lock con `expires_at`

Al crear una `lead_assignment`, `expires_at = NOW() + interval '24 hours'`. La query de exclusividad:

```sql
SELECT 1 FROM lead_assignments
WHERE prospect_id = $1
  AND closer_id != $2
  AND expires_at > NOW()
  AND status != 'expired'
LIMIT 1;
```

Sin TTLs, sin colas: la expiración ocurre lógicamente. Job nightly opcional para pasar a `status='expired'` los vencidos y tener métricas limpias.

### 9.3 Marcar lead como "usado"

Cuando el closer interactúe con el bot (botón "Marcar como usado" en el mensaje de Telegram), `status='used'`.

**Importante:** marcar como usado NO libera el lock de 24h. El lock corre siempre desde `assigned_at` lo use o no lo use el closer. Pasadas las 24h, el lead vuelve al pool y puede asignarse a otros closers, pero el matching debe excluir al closer que ya lo usó durante un cooldown de 10 días. La query es:

```sql
SELECT 1 FROM lead_assignments
WHERE prospect_id = $1
  AND closer_id = $2
  AND status = 'used'
  AND assigned_at > NOW() - INTERVAL '10 days'
LIMIT 1;
```

Pasados los 10 días, el mismo closer puede volver a recibir ese infoproductor si vuelve a cualificar (típicamente porque arrancó un nuevo lanzamiento).

---

## 10. Los 50 nichos

| # | Categoría | Slug | Nombre |
|---|---|---|---|
| 1 | Negocios | agencias-marketing | Agencias de marketing digital |
| 2 | Negocios | ecommerce-dropshipping | Ecommerce y dropshipping |
| 3 | Negocios | amazon-fba | Amazon FBA / private label |
| 4 | Negocios | consultoria-b2b | Consultoría high-ticket B2B |
| 5 | Negocios | formacion-closers | Formación para closers y setters |
| 6 | Negocios | lanzamientos-plf | Lanzamientos digitales (PLF) |
| 7 | Negocios | micro-saas | Micro-SaaS / indie hackers |
| 8 | Negocios | servicios-productizados | Servicios productizados (NaaS) |
| 9 | Negocios | compra-venta-negocios | Compra-venta de negocios online |
| 10 | Negocios | lifestyle-business | Lifestyle business / escapar del corporativo |
| 11 | Marketing | copywriting | Copywriting de respuesta directa |
| 12 | Marketing | meta-ads | Meta Ads / publicidad pagada |
| 13 | Marketing | email-newsletters | Email marketing y newsletters |
| 14 | Marketing | growth-organico | TikTok / Instagram growth orgánico |
| 15 | Marketing | funnels | Embudos de venta |
| 16 | Marketing | ugc-creator | UGC creator |
| 17 | Marketing | youtube-monetizacion | YouTube monetización avanzada |
| 18 | Marketing | seo-ia | SEO con IA / contenido programático |
| 19 | Finanzas | trading | Trading (forex, índices, futuros) |
| 20 | Finanzas | inmobiliaria | Inversión inmobiliaria |
| 21 | Finanzas | crypto-web3 | Crypto y Web3 |
| 22 | Finanzas | libertad-financiera | Educación financiera / libertad |
| 23 | Finanzas | bolsa-value | Bolsa / value investing |
| 24 | Finanzas | real-estate-internacional | Real estate internacional |
| 25 | Finanzas | inversion-angel | Inversión ángel y fundraising |
| 26 | Desarrollo | alto-rendimiento | Coaching alto rendimiento |
| 27 | Desarrollo | mindset-abundancia | Mentalidad y abundancia |
| 28 | Desarrollo | liderazgo | Liderazgo y gestión de equipos |
| 29 | Desarrollo | productividad | Productividad |
| 30 | Desarrollo | public-speaking | Public speaking y oratoria |
| 31 | Desarrollo | inteligencia-emocional | Inteligencia emocional aplicada |
| 32 | Salud | perdida-peso | Pérdida de peso premium |
| 33 | Salud | hipertrofia | Hipertrofia y culturismo natural |
| 34 | Salud | biohacking-hormonal | Salud hormonal y biohacking |
| 35 | Salud | salud-mental | Salud mental, ansiedad, burnout |
| 36 | Salud | longevidad | Longevidad y antiaging |
| 37 | Relaciones | seduccion-masculina | Seducción y atracción masculina |
| 38 | Relaciones | coaching-mujeres | Coaching femenino (relaciones, autoestima) |
| 39 | Relaciones | terapia-pareja | Terapia de pareja y sexualidad consciente |
| 40 | Espiritualidad | coaching-transformacional | Coaching transformacional / Human Design |
| 41 | Espiritualidad | mentoria-femenina | Mentoría espiritual femenina |
| 42 | Espiritualidad | astrologia-pro | Astrología profesional |
| 43 | Skills | mentoria-inmobiliaria | Mentoría para agentes inmobiliarios |
| 44 | Skills | coaches-cobrar-mas | Coaches que quieren cobrar más |
| 45 | Skills | musica-produccion | Música y producción musical |
| 46 | Skills | coaching-ejecutivo-c-level | Coaching ejecutivo C-level |
| 47 | IA | ia-negocios | IA aplicada a negocios |
| 48 | IA | automatizaciones | Automatizaciones (n8n, Make, agentes) |
| 49 | IA | prompt-engineering | Prompt engineering / diseño con IA |
| 50 | IA | agencias-ia | Agencias de IA / agentes verticales |

Cada nicho tendrá asociadas en una tabla `niche_keywords` palabras clave para discovery. Se refina en sprint 2 con datos reales.

---

## 11. Roadmap por semanas (MVP a beta)

### Semana 1 — Esqueleto end-to-end con un solo closer (el fundador)

- Setup de cuentas: Anthropic API, OpenAI, Apify, Supabase, Stripe, Hetzner, Vercel, BotFather, dominio
- Repo Next.js inicializado + Supabase schema desplegado
- n8n self-hosted instalado en VPS Hetzner con HTTPS (Caddy + dominio)
- Pipeline mínimo: solo Meta Ad Library + análisis básico (sin VSL ni visión) + generación de mensaje + Telegram delivery a UN chat
- **Hito:** a las 8:00 del día 7, le llegan al fundador 3-5 leads al Telegram

### Semana 2 — Profundidad de análisis

- Lectura de landing (fetch + parsing)
- Transcripción Whisper de VSLs
- Análisis con visión IA de creatividades de anuncios
- Scrapeo IG y TikTok vía Apify (top 5 reels recientes)
- Implementar prompt §8.3 de "value opportunities" como pieza central
- Mejorar prompt de generación con few-shot
- **Hito:** los mensajes generados tienen un punto de valor concreto y específico identificable

### Semana 3 — Capa SaaS multi-closer

- Landing pública (Next.js) con copy de oferta beta 1€
- Stripe checkout integrado
- Dashboard de onboarding: 4 pasos (nichos / modalidad / audios / Telegram)
- MediaRecorder API para grabación de audios en navegador
- Whisper en background al terminar paso 3
- Lock 24h activado en matching
- Carga de los 50 nichos completos
- **Hito:** un closer beta puede registrarse, hacer onboarding completo, y empezar a recibir leads al día siguiente

### Semana 4 — Pruebas con 5 closers beta + iteración

- Reclutar a los 5 colegas closers del fundador
- Soporte 1-a-1 durante el onboarding (grupo Telegram)
- Observar uso real durante 5-7 días
- Iteración rápida sobre prompts según feedback (calidad de mensajes = lo crítico)
- Métricas: tasa de uso, tasa de respuesta, tasa de cierre eventual
- **Hito:** beta funcionando, datos para decidir si seguir invirtiendo o pivotar

---

## 12. Decisiones técnicas críticas

- **Tono: few-shot, no fine-tuning.** Meter las 5 transcripciones en el system prompt cada vez. Fine-tuning a esta escala es caro y rígido. Few-shot con Sonnet 4.6 funciona excelente.
- **Lock 24h con `expires_at`, no con TTLs ni colas.** Una columna timestamptz y query `WHERE expires_at > NOW()`. Simple, atómico, sin race conditions.
- **Análisis cacheado.** Palanca de coste más importante. Un análisis se reutiliza 7 días para todos los closers que reciban ese infoproductor. Solo el mensaje se regenera por (lead, closer).
- **Discovery offline.** Los workers de descubrimiento corren antes que el matching, no on-demand. Desacopla costes de scrapeo del número de closers.
- **Detección temporal como prioridad de cola.** Lanzamientos a 3-7 días saltan al top del batch. Es la feature que más diferencia al producto en uso real.
- **No reportar back resultados.** MVP solo requiere "usado / no usado" del closer. Nada más. Complejidad extra mata velocidad.

---

## 13. Métricas mínimas a trackear desde el día 1

| Métrica | Para qué |
|---|---|
| Leads generados/día/closer | Salud del pipeline |
| % leads "usados" | Calidad percibida |
| Coste IA por lead | Control de margen |
| Tiempo registro → primer lead | UX onboarding |
| Errores por workflow en n8n | Salud técnica |
| Conversión landing → pago | Producto-mercado |

Dashboard simple con Supabase + Metabase (o Retool) en sprint 2.

---

## 14. Consideraciones legales y de ToS

- **Meta Ad Library API:** pública y oficial. Sin problemas.
- **Apify (IG/TikTok/YT):** scraping en zona gris. Para beta de 5 usuarios el riesgo es bajo. Si crece, considerar fuentes oficiales o partners.
- **GDPR:** los infoproductores son creators públicos; los datos son públicos. Aun así: no almacenar más de lo necesario, política de privacidad clara, derecho de eliminación.
- **Datos del closer:** email, Stripe, audios. Política de privacidad en la landing. Audios procesados, transcritos, y borrables tras procesar el perfil de tono.

---

## 15. Checklist de arranque para el dev

Antes de picar código, validar que tenemos:

- [ ] Cuentas creadas: Anthropic, OpenAI (Whisper), Apify, Supabase, Stripe, Hetzner, Vercel, BotFather
- [ ] Dominio comprado y apuntando a Vercel + subdominio para n8n
- [ ] Acceso a este brief técnico
- [ ] Acceso a la lista de 50 nichos finalizada (§10)
- [ ] Acceso al fundador en Telegram para pruebas
- [ ] 5 grabaciones de tono del fundador hechas (para testear desde el día 1)
- [ ] Variables de entorno: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `APIFY_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`

---

**Documento vivo.** Cualquier decisión técnica durante construcción que modifique algo aquí, actualizar la sección correspondiente.
