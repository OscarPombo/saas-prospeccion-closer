-- Registro del founder para Sprint 1.
-- Ejecutar DESPUÉS de schema.sql.
-- tone_profile se completa en el Bloque B (Whisper + Claude).

INSERT INTO closers (
  email,
  telegram_chat_id,
  selected_niches,
  mode,
  timezone,
  status,
  tone_profile
)
VALUES (
  'opombo84@gmail.com',
  '915072751',
  ARRAY[(SELECT id FROM niches WHERE slug = 'ia-negocios')],
  'both',
  'Europe/Madrid',
  'active',
  '{}'::jsonb
)
ON CONFLICT (email) DO UPDATE SET
  telegram_chat_id = EXCLUDED.telegram_chat_id,
  selected_niches  = EXCLUDED.selected_niches,
  status           = EXCLUDED.status;
