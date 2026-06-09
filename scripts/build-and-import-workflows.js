// Lee los .js de workflows/code/, construye los n8n workflow JSONs y los importa
// via docker CLI (docker cp + n8n import:workflow).
// Uso: node scripts/build-and-import-workflows.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CODE_DIR = path.join(__dirname, '../workflows/code');
const OUT_DIR  = path.join(__dirname, '../workflows');

function readCode(file) {
  return fs.readFileSync(path.join(CODE_DIR, file), 'utf8');
}

function makeCodeNode(id, name, jsCode, x, y) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [x, y],
    parameters: { jsCode },
  };
}

function makeScheduleTrigger(id, name, cronExpr, x, y) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [x, y],
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: cronExpr }] },
    },
  };
}

function makeConnections(nodeNames) {
  const connections = {};
  for (let i = 0; i < nodeNames.length - 1; i++) {
    connections[nodeNames[i]] = {
      main: [[{ node: nodeNames[i + 1], type: 'main', index: 0 }]],
    };
  }
  return connections;
}

// ── Workflow 01: Pipeline (06:00) ─────────────────────────────────────────────
const pipelineNodes = [
  makeScheduleTrigger('cron-pipeline', 'Cron 06:00', '0 6 * * *', 250, 300),
  makeCodeNode('discovery',   'Discovery Apify',       readCode('01-discovery.js'),   500, 300),
  makeCodeNode('enrichment',  'Enrichment + Filter',   readCode('02-enrichment.js'),  750, 300),
  makeCodeNode('analysis',    'Deep Analysis Claude',  readCode('03-analysis.js'),   1000, 300),
  makeCodeNode('messages',    'Matching + Mensajes',   readCode('04-messages.js'),   1250, 300),
];

const workflow01 = {
  id: 'sprint1-pipeline',
  name: '01 Pipeline Sprint 1 (06:00)',
  nodes: pipelineNodes,
  connections: makeConnections(pipelineNodes.map(n => n.name)),
  active: false,
  settings: { timezone: 'Europe/Madrid', saveExecutionProgress: true },
};

// ── Workflow 02: Delivery (08:00) ──────────────────────────────────────────────
const deliveryNodes = [
  makeScheduleTrigger('cron-delivery', 'Cron 08:00', '0 8 * * *', 250, 300),
  makeCodeNode('delivery', 'Delivery Telegram', readCode('05-delivery.js'), 500, 300),
];

const workflow02 = {
  id: 'sprint1-delivery',
  name: '02 Delivery Sprint 1 (08:00)',
  nodes: deliveryNodes,
  connections: makeConnections(deliveryNodes.map(n => n.name)),
  active: false,
  settings: { timezone: 'Europe/Madrid', saveExecutionProgress: true },
};

// ── Escribir JSONs ─────────────────────────────────────────────────────────────
const file01 = path.join(OUT_DIR, '01-pipeline.json');
const file02 = path.join(OUT_DIR, '02-delivery.json');
fs.writeFileSync(file01, JSON.stringify(workflow01, null, 2));
fs.writeFileSync(file02, JSON.stringify(workflow02, null, 2));
console.log('Workflows JSON escritos.');

// ── Importar en n8n via Docker ─────────────────────────────────────────────────
const CONTAINER = 'saasprospeccioncloser-n8n-1';

function importWorkflow(localFile, containerFile) {
  const filename = path.basename(localFile);
  try {
    execSync(`docker cp "${localFile}" ${CONTAINER}:/tmp/${filename}`, { stdio: 'inherit' });
    execSync(`docker exec ${CONTAINER} n8n import:workflow --input=/tmp/${filename}`, { stdio: 'inherit' });
    console.log(`✓ Importado: ${filename}`);
  } catch (e) {
    console.error(`✗ Error importando ${filename}:`, e.message);
  }
}

importWorkflow(file01);
importWorkflow(file02);

console.log('\nAbre http://localhost:5678 para ver los workflows.');
console.log('Para activarlos: Settings → toggle Active en cada workflow.');
console.log('Para testear manualmente: click en "Execute Workflow" (triángulo).');
