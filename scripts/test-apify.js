// Prueba Apify Instagram Scraper y loguea la estructura de datos devuelta.
// Uso: node scripts/test-apify.js
// Corre un actor real con LIMIT=5 para entender los campos disponibles.
require('dotenv').config();
const https = require('https');

const TOKEN = process.env.APIFY_TOKEN;

function apifyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const sep = path.includes('?') ? '&' : '?';
    const fullPath = `/v2${path}${sep}token=${TOKEN}`;
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'api.apify.com',
      path: fullPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('=== Test Apify Instagram Scraper ===\n');

  // 1. Arrancar actor con un hashtag de prueba (límite muy bajo para test rápido)
  const input = {
    directUrls: ['https://www.instagram.com/explore/tags/ianegocios/'],
    resultsType: 'posts',
    resultsLimit: 5,
    // Pedimos también datos del perfil del autor
  };

  console.log('Iniciando actor apify/instagram-scraper...');
  const run = await apifyRequest('POST', '/acts/apify~instagram-scraper/runs', input);
  if (!run.body?.data?.id) {
    console.error('Error al iniciar actor:', JSON.stringify(run, null, 2));
    process.exit(1);
  }

  const runId = run.body.data.id;
  const datasetId = run.body.data.defaultDatasetId;
  console.log(`Run ID: ${runId}, Dataset: ${datasetId}`);
  console.log('Esperando resultados (polling cada 5s)...');

  // 2. Polling hasta que el run termine
  let status = 'RUNNING';
  let attempts = 0;
  while (status === 'RUNNING' || status === 'READY') {
    await sleep(5000);
    const info = await apifyRequest('GET', `/actor-runs/${runId}`);
    status = info.body?.data?.status;
    attempts++;
    process.stdout.write(`\r  [${attempts * 5}s] status: ${status}   `);
    if (attempts > 60) { console.log('\nTimeout'); process.exit(1); }
  }
  console.log(`\nRun finalizado con status: ${status}`);

  if (status !== 'SUCCEEDED') {
    console.error('Actor falló. Revisa Apify console.');
    process.exit(1);
  }

  // 3. Obtener resultados
  const items = await apifyRequest('GET', `/datasets/${datasetId}/items?limit=3`);
  const posts = items.body;

  if (!Array.isArray(posts) || posts.length === 0) {
    console.log('Sin resultados. Prueba con otro hashtag.');
    process.exit(0);
  }

  console.log(`\n=== ${posts.length} posts devueltos. Campos disponibles: ===`);
  const post = posts[0];
  console.log('Keys:', Object.keys(post).join(', '));

  console.log('\n=== Campos de perfil/autor (ownerXxx): ===');
  const ownerKeys = Object.keys(post).filter(k => k.toLowerCase().includes('owner') || k.toLowerCase().includes('user'));
  ownerKeys.forEach(k => console.log(`  ${k}: ${JSON.stringify(post[k])?.slice(0, 120)}`));

  console.log('\n=== Muestra post[0] (primeros 50 campos): ===');
  Object.entries(post).slice(0, 50).forEach(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v)?.slice(0, 80) : String(v)?.slice(0, 80);
    console.log(`  ${k}: ${val}`);
  });

})();
