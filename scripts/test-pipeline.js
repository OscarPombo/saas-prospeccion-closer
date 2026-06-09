// Corre cada etapa del pipeline secuencialmente fuera de n8n.
// Usa el mismo código que los Code nodes (fetch + process.env).
// Uso: node scripts/test-pipeline.js [stage]
//   stage: all | discovery | enrichment | analysis | messages | delivery
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const CODE = path.join(__dirname, '../workflows/code');

// Ejecuta un .js de etapa como función async (el código usa top-level await
// que n8n maneja nativamente; aquí lo envolvemos en AsyncFunction).
async function runStage(filename, stageName) {
  const code = fs.readFileSync(path.join(CODE, filename), 'utf8');
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`▶ Stage: ${stageName}`);
  console.log(`${'─'.repeat(60)}`);
  const t0 = Date.now();
  try {
    // AsyncFunction tiene acceso a globals: fetch, process, console
    const fn = new (Object.getPrototypeOf(async function(){}).constructor)(code);
    const result = await fn();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✓ ${stageName} completado en ${elapsed}s`);
    if (result) console.log('  Output:', JSON.stringify(result).slice(0, 200));
    return result;
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`✗ ${stageName} falló en ${elapsed}s: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(0,5).join('\n'));
    return null;
  }
}

const stage = process.argv[2] || 'all';

(async () => {
  switch (stage) {
    case 'discovery':
      await runStage('01-discovery.js', 'Discovery Apify');
      break;
    case 'enrichment':
      await runStage('02-enrichment.js', 'Enrichment + Filter');
      break;
    case 'analysis':
      await runStage('03-analysis.js', 'Deep Analysis Claude');
      break;
    case 'messages':
      await runStage('04-messages.js', 'Matching + Mensajes');
      break;
    case 'delivery':
      await runStage('05-delivery.js', 'Delivery Telegram');
      break;
    case 'all':
    default:
      await runStage('01-discovery.js',  'Discovery Apify');
      await runStage('02-enrichment.js', 'Enrichment + Filter');
      await runStage('03-analysis.js',   'Deep Analysis Claude');
      await runStage('04-messages.js',   'Matching + Mensajes');
      // Delivery solo si hay mensajes generados
      await runStage('05-delivery.js',   'Delivery Telegram');
      break;
  }
  console.log('\n✅ Pipeline test finalizado.');
})();
