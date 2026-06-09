# DECISIONS.md — SaaS prospección closers

Registro de decisiones técnicas tomadas durante la construcción que matizan o concretan el brief (`brief-tecnico-saas-prospeccion.md`).

---

## 2026-06-08 — Nicho hardcoded para Sprint 1: `ia-negocios`

Se elige "IA aplicada a negocios" (#47 del §10) en lugar de `formacion-closers`.

**Por qué:** más volumen de anuncios y más infoproductores nuevos que aún no trabajan con un closer — mejor terreno para validar discovery y matching desde cero.

---

## 2026-06-08 — Apify entra en el Sprint 1 (no se difiere a semana 2)

El brief original (§11, semana 1) excluía Apify del primer sprint. Se decide incluirlo ya.

**Por qué:** sin Apify no hay `followers`, `bio` ni `reels`, y el filtro duro del §9.1 (5-100K seguidores) queda inservible. El founder asume el coste extra para no perder calidad de filtrado desde el día 1.

**Cómo se aplica:**
- El filtro duro de Sprint 1 mantiene las 3 condiciones del brief: followers 5-100K, ads_count 3-20, idioma ES.
- Discovery corre dos ramas en paralelo bajo el mismo cron de 06:00:
  - **Apify** → búsqueda IG por hashtags + bio search con keywords del nicho: "cursos de IA", "IA para negocios", "automatizar con IA", "agentes IA", "prompt engineering", "ChatGPT para empresas", "IA para emprendedores"
  - **Meta Ad Library** → keyword search en países hispanohablantes (ES, MX, AR, CO, CL, PE) con términos universales: "masterclass gratuita", "directo gratuito", "reto gratis", "agenda llamada"
- Ambas ramas escriben en `raw_prospects`.

---

## 2026-06-08 — Prioridad de landing URL para el análisis (§8.1)

Cuando se necesita una landing para analizar:
1. Link del bio (lo da Apify)
2. Si no hay → `destination URL` del anuncio de Meta Ad Library
3. Si tampoco hay → el análisis se apoya solo en el copy del anuncio (sin landing)

---

## 2026-06-08 — Desarrollo local-first para n8n, migración a Hetzner cuando esté verificado

La verificación de identidad de Hetzner tarda 24-48h. Para no bloquear el arranque del Sprint 1:

**Decisión:** levantar n8n en local vía Docker, construir y probar todos los workflows ahí. Cuando el VPS Hetzner esté verificado y desplegado (Docker + Caddy + HTTPS), migrar los workflows mediante export/import de JSON (soporte nativo de n8n).

**Riesgo abierto:** la entrega real de las 8:00 requiere n8n corriendo de forma persistente (no en local). Si la verificación de Hetzner se alarga, el hito "Día 7 a las 8:00" podría desplazarse uno o dos días. Pendiente de confirmar fecha real una vez llegue la verificación.

---

## 2026-06-09 — Despliegue de schema vía Postgres directo (no via REST API)

La `SUPABASE_SERVICE_KEY` en formato `sb_secret_...` devuelve 401 en la REST API de Supabase — el formato correcto es el JWT (`eyJ...`) que está en Dashboard → Settings → API → service_role secret. Pendiente que el founder lo actualice en `.env`.

**Workaround para schema:** conexión Postgres directa con `SUPABASE_DB_PASSWORD` vía librería `pg`. Creado `scripts/deploy-schema.js` y `scripts/seed-founder.js`.

---

## 2026-06-09 — Contraseñas con caracteres especiales en .env deben ir entre comillas

`SUPABASE_DB_PASSWORD=J#?/fHxD7_ZfuK9` → dotenv interpreta `#` como inicio de comentario y pasa solo `J` como contraseña.

**Fix aplicado:** `SUPABASE_DB_PASSWORD="J#?/fHxD7_ZfuK9"` (valor entre comillas dobles).

**Regla general:** cualquier valor en `.env` que contenga `#`, `=` o espacios debe ir entre comillas dobles.

---

## 2026-06-08 — Otras confirmaciones del founder (sin cambios sobre el brief)

- Telegram: vínculo 1:1 con el bot (no grupo/canal).
- Audios de tono: los 5 archivos `.m4a.ogg` en `audios-tono/` son los definitivos (la doble extensión es artefacto del export).
- Repo Next.js: se difiere a semana 3, tal como recomienda el plan — evita código sin uso durante el Sprint 1.
