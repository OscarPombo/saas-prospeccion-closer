// Despliega supabase/schema.sql via conexión Postgres directa.
// Uso: node scripts/deploy-schema.js
require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');

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
    console.log('Conectado a Supabase Postgres');
    await client.query(sql);
    console.log('Schema desplegado OK (tablas + 50 nichos)');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
