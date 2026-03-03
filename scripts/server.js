// server.js - HTTP API for n8n integration
// Exposes pipeline operations as endpoints that n8n can call via HTTP Request nodes
//
// Endpoints:
//   POST /pipeline/run          - run full pipeline (batch)
//   POST /pipeline/demo         - run Pipeline A only for a single account
//   POST /pipeline/onboarding   - run Pipeline B only for a single account
//   GET  /pipeline/status       - get all task statuses
//   GET  /pipeline/status/:id   - get status for a specific account
//   GET  /health                - health check

const http = require('http');
const fs = require('fs');
const path = require('path');
const { runAll, runPipelineA, runPipelineB } = require('./runPipeline');
const { extractFromTranscript, pickModel, slugify } = require('./extract');
const { generateAgentSpec } = require('./generateAgent');
const { mergeMemos } = require('./merge');
const { generateChangelog } = require('./diff');
const { getAllTasks, findTask, upsertTask, completeTask } = require('./taskTracker');
const logger = require('./logger');

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, '..');
const ACCOUNTS_DIR = path.join(ROOT, 'outputs', 'accounts');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Route: POST /pipeline/demo
// Body: { "account_id": "acme-fire", "transcript": "..." }
async function handleDemo(req, res) {
  try {
    const body = await parseBody(req);
    if (!body.transcript) {
      return sendJSON(res, 400, { error: 'Missing "transcript" in request body' });
    }

    const model = await pickModel();
    const memo = await extractFromTranscript(body.transcript, { model });
    const accountId = body.account_id || memo.account_id || slugify(memo.company_name);
    memo.account_id = accountId;

    const accountDir = path.join(ACCOUNTS_DIR, accountId);
    const v1Dir = path.join(accountDir, 'v1');

    writeJSON(path.join(v1Dir, 'memo.json'), memo);
    upsertTask(accountId, 'demo_extracted');

    const agentSpec = generateAgentSpec(memo, 'v1');
    writeJSON(path.join(v1Dir, 'agent.json'), agentSpec);
    upsertTask(accountId, 'agent_v1_generated');
    completeTask(accountId);

    sendJSON(res, 200, {
      status: 'success',
      account_id: accountId,
      memo,
      agent: agentSpec,
    });
  } catch (err) {
    logger.error(`/pipeline/demo error: ${err.message}`);
    sendJSON(res, 500, { error: err.message });
  }
}

// Route: POST /pipeline/onboarding
// Body: { "account_id": "acme-fire", "transcript": "..." }
async function handleOnboarding(req, res) {
  try {
    const body = await parseBody(req);
    if (!body.account_id) {
      return sendJSON(res, 400, { error: 'Missing "account_id" in request body' });
    }
    if (!body.transcript) {
      return sendJSON(res, 400, { error: 'Missing "transcript" in request body' });
    }

    const accountId = body.account_id;
    const model = await pickModel();

    // load v1 memo
    const v1Path = path.join(ACCOUNTS_DIR, accountId, 'v1', 'memo.json');
    let v1Memo;
    if (fs.existsSync(v1Path)) {
      v1Memo = JSON.parse(fs.readFileSync(v1Path, 'utf-8'));
    } else {
      v1Memo = {
        account_id: accountId, company_name: null,
        business_hours: { days: null, start: null, end: null, timezone: null },
        office_address: null, services_supported: [], emergency_definition: [],
        emergency_routing_rules: [], non_emergency_routing_rules: [],
        call_transfer_rules: [], integration_constraints: [],
        after_hours_flow_summary: null, office_hours_flow_summary: null,
        questions_or_unknowns: [], notes: '',
      };
    }

    const onboardingData = await extractFromTranscript(body.transcript, { model });
    onboardingData.account_id = accountId;
    upsertTask(accountId, 'onboarding_extracted');

    const { merged, conflicts } = mergeMemos(v1Memo, onboardingData);
    merged.account_id = accountId;

    const v2Dir = path.join(ACCOUNTS_DIR, accountId, 'v2');
    writeJSON(path.join(v2Dir, 'memo.json'), merged);
    upsertTask(accountId, 'merged');

    const agentSpec = generateAgentSpec(merged, 'v2');
    writeJSON(path.join(v2Dir, 'agent.json'), agentSpec);
    upsertTask(accountId, 'agent_v2_generated');

    const changelog = generateChangelog(v1Memo, merged, conflicts);
    writeJSON(path.join(ACCOUNTS_DIR, accountId, 'changes.json'), changelog);
    completeTask(accountId);

    sendJSON(res, 200, {
      status: 'success',
      account_id: accountId,
      memo: merged,
      agent: agentSpec,
      changelog,
    });
  } catch (err) {
    logger.error(`/pipeline/onboarding error: ${err.message}`);
    sendJSON(res, 500, { error: err.message });
  }
}

// Route: POST /pipeline/run
// Body: { "mode": "full" | "demo-only" | "onboard-only" } (optional)
async function handleBatchRun(req, res) {
  try {
    const body = await parseBody(req);
    const options = {
      demoOnly: body.mode === 'demo-only',
      onboardOnly: body.mode === 'onboard-only',
    };
    await runAll(options);

    const summaryPath = path.join(ROOT, 'outputs', 'batch_summary.json');
    const summary = fs.existsSync(summaryPath)
      ? JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
      : { status: 'completed' };

    sendJSON(res, 200, summary);
  } catch (err) {
    logger.error(`/pipeline/run error: ${err.message}`);
    sendJSON(res, 500, { error: err.message });
  }
}

// Route handler
async function handleRequest(req, res) {
  const url = req.url;
  const method = req.method;

  // CORS headers for n8n
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (url === '/health' && method === 'GET') {
    return sendJSON(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
  }

  if (url === '/pipeline/run' && method === 'POST') {
    return handleBatchRun(req, res);
  }

  if (url === '/pipeline/demo' && method === 'POST') {
    return handleDemo(req, res);
  }

  if (url === '/pipeline/onboarding' && method === 'POST') {
    return handleOnboarding(req, res);
  }

  if (url === '/pipeline/status' && method === 'GET') {
    return sendJSON(res, 200, getAllTasks());
  }

  if (url.startsWith('/pipeline/status/') && method === 'GET') {
    const accountId = url.split('/pipeline/status/')[1];
    const task = findTask(accountId);
    if (task) return sendJSON(res, 200, task);
    return sendJSON(res, 404, { error: `No task found for: ${accountId}` });
  }

  sendJSON(res, 404, { error: 'Not found' });
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  logger.info(`Pipeline API server running on http://localhost:${PORT}`);
  logger.info('Endpoints:');
  logger.info('  POST /pipeline/run          - batch run');
  logger.info('  POST /pipeline/demo         - single demo extraction');
  logger.info('  POST /pipeline/onboarding   - single onboarding merge');
  logger.info('  GET  /pipeline/status        - all task statuses');
  logger.info('  GET  /pipeline/status/:id    - account task status');
  logger.info('  GET  /health                 - health check');
});
