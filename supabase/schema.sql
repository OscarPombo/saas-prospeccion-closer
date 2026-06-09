-- ============================================================
-- Schema completo — SaaS prospección closers
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- Catálogo fijo de los 50 nichos
CREATE TABLE IF NOT EXISTS niches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  category      text NOT NULL,
  default_mode  text CHECK (default_mode IN ('launch','evergreen','both'))
);

-- Closers (usuarios del SaaS)
CREATE TABLE IF NOT EXISTS closers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text UNIQUE NOT NULL,
  telegram_chat_id   text,
  stripe_customer_id text,
  selected_niches    uuid[] DEFAULT '{}',
  mode               text CHECK (mode IN ('launch','evergreen','both')),
  tone_profile       jsonb DEFAULT '{}',
  timezone           text DEFAULT 'Europe/Madrid',
  status             text CHECK (status IN ('onboarding','active','paused','cancelled')),
  created_at         timestamptz DEFAULT now()
);

-- Prospectos descubiertos en bruto (Meta Ads + Apify)
CREATE TABLE IF NOT EXISTS raw_prospects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text CHECK (source IN ('meta_ads','instagram','tiktok','youtube')),
  source_id     text NOT NULL,
  handle        text,
  url           text,
  raw_data      jsonb,
  discovered_at timestamptz DEFAULT now(),
  UNIQUE (source, source_id)
);

-- Prospectos que pasan filtros duros (followers, ads_count, idioma)
CREATE TABLE IF NOT EXISTS qualified_prospects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_prospect_id    uuid REFERENCES raw_prospects(id),
  handle             text,
  platform_links     jsonb,
  followers          int,
  ads_count          int,
  language           text,
  detected_niche_id  uuid REFERENCES niches(id),
  detected_mode      text,
  qualified_at       timestamptz DEFAULT now()
);

-- Análisis profundo cacheado (reutilizable 7 días entre closers)
CREATE TABLE IF NOT EXISTS prospect_analyses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id         uuid REFERENCES qualified_prospects(id),
  funnel_summary      text,
  vsl_transcript      text,
  creatives_analysis  jsonb,
  reels_summary       jsonb,
  value_opportunities jsonb,   -- núcleo: 2-4 oportunidades de valor
  launch_date         timestamptz,
  classification      text CHECK (classification IN ('launch','evergreen')),
  score               int,
  analyzed_at         timestamptz DEFAULT now()
);

-- Asignaciones con lock 24h
CREATE TABLE IF NOT EXISTS lead_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id  uuid REFERENCES qualified_prospects(id),
  closer_id    uuid REFERENCES closers(id),
  assigned_at  timestamptz DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  status       text CHECK (status IN ('pending','delivered','expired','used')) DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_assignments_active
  ON lead_assignments(prospect_id, expires_at, status);

-- Mensaje generado por (prospecto, closer)
CREATE TABLE IF NOT EXISTS generated_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id  uuid REFERENCES lead_assignments(id),
  message_text   text,
  value_point    text,
  generated_at   timestamptz DEFAULT now()
);

-- ============================================================
-- Seed: 50 nichos (§10 del brief)
-- ============================================================
INSERT INTO niches (slug, name, category, default_mode) VALUES
  ('agencias-marketing',         'Agencias de marketing digital',              'Negocios',        'both'),
  ('ecommerce-dropshipping',     'Ecommerce y dropshipping',                   'Negocios',        'both'),
  ('amazon-fba',                 'Amazon FBA / private label',                 'Negocios',        'both'),
  ('consultoria-b2b',            'Consultoría high-ticket B2B',                'Negocios',        'both'),
  ('formacion-closers',          'Formación para closers y setters',           'Negocios',        'both'),
  ('lanzamientos-plf',           'Lanzamientos digitales (PLF)',               'Negocios',        'launch'),
  ('micro-saas',                 'Micro-SaaS / indie hackers',                 'Negocios',        'both'),
  ('servicios-productizados',    'Servicios productizados (NaaS)',             'Negocios',        'both'),
  ('compra-venta-negocios',      'Compra-venta de negocios online',            'Negocios',        'both'),
  ('lifestyle-business',         'Lifestyle business / escapar del corporativo','Negocios',       'both'),
  ('copywriting',                'Copywriting de respuesta directa',           'Marketing',       'both'),
  ('meta-ads',                   'Meta Ads / publicidad pagada',               'Marketing',       'both'),
  ('email-newsletters',          'Email marketing y newsletters',              'Marketing',       'both'),
  ('growth-organico',            'TikTok / Instagram growth orgánico',         'Marketing',       'both'),
  ('funnels',                    'Embudos de venta',                           'Marketing',       'both'),
  ('ugc-creator',                'UGC creator',                                'Marketing',       'both'),
  ('youtube-monetizacion',       'YouTube monetización avanzada',              'Marketing',       'both'),
  ('seo-ia',                     'SEO con IA / contenido programático',        'Marketing',       'both'),
  ('trading',                    'Trading (forex, índices, futuros)',           'Finanzas',        'both'),
  ('inmobiliaria',               'Inversión inmobiliaria',                     'Finanzas',        'both'),
  ('crypto-web3',                'Crypto y Web3',                              'Finanzas',        'both'),
  ('libertad-financiera',        'Educación financiera / libertad',            'Finanzas',        'both'),
  ('bolsa-value',                'Bolsa / value investing',                    'Finanzas',        'both'),
  ('real-estate-internacional',  'Real estate internacional',                  'Finanzas',        'both'),
  ('inversion-angel',            'Inversión ángel y fundraising',              'Finanzas',        'both'),
  ('alto-rendimiento',           'Coaching alto rendimiento',                  'Desarrollo',      'both'),
  ('mindset-abundancia',         'Mentalidad y abundancia',                    'Desarrollo',      'both'),
  ('liderazgo',                  'Liderazgo y gestión de equipos',             'Desarrollo',      'both'),
  ('productividad',              'Productividad',                              'Desarrollo',      'both'),
  ('public-speaking',            'Public speaking y oratoria',                 'Desarrollo',      'both'),
  ('inteligencia-emocional',     'Inteligencia emocional aplicada',            'Desarrollo',      'both'),
  ('perdida-peso',               'Pérdida de peso premium',                    'Salud',           'both'),
  ('hipertrofia',                'Hipertrofia y culturismo natural',           'Salud',           'both'),
  ('biohacking-hormonal',        'Salud hormonal y biohacking',                'Salud',           'both'),
  ('salud-mental',               'Salud mental, ansiedad, burnout',            'Salud',           'both'),
  ('longevidad',                 'Longevidad y antiaging',                     'Salud',           'both'),
  ('seduccion-masculina',        'Seducción y atracción masculina',            'Relaciones',      'both'),
  ('coaching-mujeres',           'Coaching femenino (relaciones, autoestima)', 'Relaciones',      'both'),
  ('terapia-pareja',             'Terapia de pareja y sexualidad consciente',  'Relaciones',      'both'),
  ('coaching-transformacional',  'Coaching transformacional / Human Design',   'Espiritualidad',  'both'),
  ('mentoria-femenina',          'Mentoría espiritual femenina',               'Espiritualidad',  'both'),
  ('astrologia-pro',             'Astrología profesional',                     'Espiritualidad',  'both'),
  ('mentoria-inmobiliaria',      'Mentoría para agentes inmobiliarios',        'Skills',          'both'),
  ('coaches-cobrar-mas',         'Coaches que quieren cobrar más',             'Skills',          'both'),
  ('musica-produccion',          'Música y producción musical',                'Skills',          'both'),
  ('coaching-ejecutivo-c-level', 'Coaching ejecutivo C-level',                'Skills',          'both'),
  ('ia-negocios',                'IA aplicada a negocios',                     'IA',              'both'),
  ('automatizaciones',           'Automatizaciones (n8n, Make, agentes)',      'IA',              'both'),
  ('prompt-engineering',         'Prompt engineering / diseño con IA',         'IA',              'both'),
  ('agencias-ia',                'Agencias de IA / agentes verticales',        'IA',              'both')
ON CONFLICT (slug) DO NOTHING;
