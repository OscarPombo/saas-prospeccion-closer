require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/seed_founder.sql'), 'utf8');

const client = new Client({
  host:     `db.${new URL(process.env.SUPABASE_URL).hostname.split('.')[0]}.supabase.co`,
  port:     5432,
  database: 'postgres',
  user:     'postgres',
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
});

(async () => {
  try {
    await client.connect();
    await client.query(sql);
    console.log('Founder insertado OK');

    // Verifica el estado de las tablas
    const { rows } = await client.query(`
      SELECT
        (SELECT count(*) FROM niches)              AS niches,
        (SELECT count(*) FROM closers)             AS closers,
        (SELECT count(*) FROM raw_prospects)       AS raw_prospects,
        (SELECT count(*) FROM qualified_prospects) AS qualified,
        (SELECT count(*) FROM prospect_analyses)   AS analyses,
        (SELECT count(*) FROM lead_assignments)    AS assignments,
        (SELECT count(*) FROM generated_messages)  AS messages;
    `);
    console.log('Filas por tabla:', rows[0]);

    const { rows: niche } = await client.query(
      `SELECT id, slug FROM niches WHERE slug = 'ia-negocios'`
    );
    console.log('Niche ia-negocios:', niche[0]);

    const { rows: closer } = await client.query(
      `SELECT id, email, telegram_chat_id, status, selected_niches FROM closers`
    );
    console.log('Closer founder:', closer[0]);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
