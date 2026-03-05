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
//
// Input formats:
//   JSON body: { "transcript": "...", "account_id": "..." }
//   Multipart: audio file (.m4a) with optional account_id field

const http = require('http');
const fs = require('fs');
const path = require('path');
const { runAll, runPipelineA, runPipelineB } = require('./runPipeline');
const { extractFromTranscript, pickModel, slugify } = require('./extract');
const { generateAgentSpec } = require('./generateAgent');
const { mergeMemos } = require('./merge');
const { generateChangelog } = require('./diff');
const { getAllTasks, findTask, upsertTask, completeTask } = require('./taskTracker');
const { isAudioFile, transcribeAudio, AUDIO_EXTENSIONS } = require('./transcribe');
const logger = require('./logger');

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, '..');
const ACCOUNTS_DIR = path.join(ROOT, 'outputs', 'accounts');
const DEMO_DIR = path.join(ROOT, 'inputs', 'demo');
const ONBOARDING_DIR = path.join(ROOT, 'inputs', 'onboarding');
const UPLOADS_DIR = path.join(ROOT, 'inputs', 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');

const pipelineControl = {
  busy: false,
  mode: null,
  started_at: null,
  stop_requested: false,
};

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(DEMO_DIR)) fs.mkdirSync(DEMO_DIR, { recursive: true });
if (!fs.existsSync(ONBOARDING_DIR)) fs.mkdirSync(ONBOARDING_DIR, { recursive: true });

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';

    // Handle multipart/form-data (audio file uploads)
    if (contentType.includes('multipart/form-data')) {
      return parseMultipart(req, contentType).then(resolve).catch(reject);
    }

    // Handle JSON body
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

// Simple multipart/form-data parser for audio uploads
function parseMultipart(req, contentType) {
  return new Promise((resolve, reject) => {
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('No boundary in multipart'));
    const boundary = boundaryMatch[1];

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const result = { _files: {} };
        const parts = splitMultipartBuffer(body, boundary);

        for (const part of parts) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;

          const headerStr = part.slice(0, headerEnd).toString();
          const content = part.slice(headerEnd + 4);

          const nameMatch = headerStr.match(/name="([^"]+)"/);
          if (!nameMatch) continue;
          const fieldName = nameMatch[1];

          const filenameMatch = headerStr.match(/filename="([^"]+)"/);
          if (filenameMatch) {
            const filename = filenameMatch[1];
            // Remove trailing \r\n from content
            const fileContent = content.slice(0, content.length - 2);
            result._files[fieldName] = { filename, data: fileContent };
          } else {
            result[fieldName] = content.toString().trim();
          }
        }

        resolve(result);
      } catch (err) {
        reject(new Error(`Failed to parse multipart: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function splitMultipartBuffer(body, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;

  while (true) {
    const idx = body.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    if (start > 0) {
      parts.push(body.slice(start, idx));
    }
    start = idx + boundaryBuf.length;
    // Skip \r\n after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    // Check for closing boundary --
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
  }

  return parts;
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

function sendFile(res, filePath, contentType = 'text/html; charset=utf-8') {
  if (!fs.existsSync(filePath)) {
    return sendJSON(res, 404, { error: 'File not found' });
  }
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(fs.readFileSync(filePath));
}

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || '').trim());
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getInputDirByType(type) {
  if (type === 'demo') return DEMO_DIR;
  if (type === 'onboarding') return ONBOARDING_DIR;
  return null;
}

function listInputFilesByType(type) {
  const dir = getInputDirByType(type);
  if (!dir) return null;
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((name) => {
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) return false;
      // Hide cached transcripts generated from audio in UI list.
      if (name.endsWith('.transcript.txt')) return false;
      return true;
    })
    .sort((a, b) => a.localeCompare(b));
}

function listAccounts() {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  return fs.readdirSync(ACCOUNTS_DIR)
    .filter((name) => {
      const full = path.join(ACCOUNTS_DIR, name);
      return fs.existsSync(full) && fs.statSync(full).isDirectory();
    })
    .sort((a, b) => a.localeCompare(b));
}

function readAccountDiff(accountId) {
  const safeId = sanitizeFilename(accountId);
  const diffPath = path.join(ACCOUNTS_DIR, safeId, 'changes.json');
  if (!fs.existsSync(diffPath)) return null;
  return JSON.parse(fs.readFileSync(diffPath, 'utf-8'));
}

// Helper: extract transcript from request body (handles both text and audio uploads)
async function getTranscriptFromBody(body) {
  if (body.transcript) {
    return { transcript: body.transcript, source: 'text' };
  }

  // If body has an uploaded audio file, transcribe it
  if (body._files) {
    const fileField = body._files.audio || body._files.file || Object.values(body._files)[0];
    if (fileField) {
      const ext = path.extname(fileField.filename).toLowerCase();
      if (!AUDIO_EXTENSIONS.includes(ext)) {
        throw new Error(`Unsupported audio format: ${ext}. Supported: ${AUDIO_EXTENSIONS.join(', ')}`);
      }

      const tmpPath = path.join(UPLOADS_DIR, `${Date.now()}-${fileField.filename}`);
      fs.writeFileSync(tmpPath, fileField.data);
      logger.info(`Saved uploaded audio: ${fileField.filename} (${fileField.data.length} bytes)`);

      try {
        const transcript = await transcribeAudio(tmpPath);
        return { transcript, source: 'audio', audioFile: fileField.filename };
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  }

  return { transcript: null, source: null };
}

// Route: POST /pipeline/demo
// Body: { "account_id": "acme-fire", "transcript": "..." }
// OR multipart with audio file (.m4a) and optional account_id field
async function handleDemo(req, res) {
  try {
    const body = await parseBody(req);
    const { transcript, source, audioFile } = await getTranscriptFromBody(body);

    if (!transcript) {
      return sendJSON(res, 400, {
        error: 'Missing input: provide either "transcript" (text) in JSON body, or upload an audio file (.m4a)',
      });
    }

    const model = await pickModel();
    const memo = await extractFromTranscript(transcript, { model });
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
      input_source: source,
      ...(audioFile ? { audio_file: audioFile } : {}),
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
// OR multipart with audio file (.m4a) and account_id field
async function handleOnboarding(req, res) {
  try {
    const body = await parseBody(req);
    if (!body.account_id) {
      return sendJSON(res, 400, { error: 'Missing "account_id" in request body' });
    }

    const { transcript, source, audioFile } = await getTranscriptFromBody(body);
    if (!transcript) {
      return sendJSON(res, 400, {
        error: 'Missing input: provide either "transcript" (text) in JSON body, or upload an audio file (.m4a)',
      });
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

    const onboardingData = await extractFromTranscript(transcript, { model });
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
      input_source: source,
      ...(audioFile ? { audio_file: audioFile } : {}),
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
  if (pipelineControl.busy) {
    return sendJSON(res, 409, {
      error: 'Another pipeline request is already running. Stop it first or wait for completion.',
      control: pipelineControl,
    });
  }

  try {
    const body = await parseBody(req);
    const options = {
      demoOnly: body.mode === 'demo-only',
      onboardOnly: body.mode === 'onboard-only',
      shouldStop: () => pipelineControl.stop_requested,
    };

    pipelineControl.busy = true;
    pipelineControl.mode = body.mode || 'full';
    pipelineControl.started_at = new Date().toISOString();
    pipelineControl.stop_requested = false;

    await runAll(options);

    const summaryPath = path.join(ROOT, 'outputs', 'batch_summary.json');
    const summary = fs.existsSync(summaryPath)
      ? JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
      : { status: 'completed' };

    sendJSON(res, 200, summary);
  } catch (err) {
    logger.error(`/pipeline/run error: ${err.message}`);
    sendJSON(res, 500, { error: err.message });
  } finally {
    pipelineControl.busy = false;
    pipelineControl.mode = null;
    pipelineControl.started_at = null;
    pipelineControl.stop_requested = false;
  }
}

// Route: POST /pipeline/stop
function handleStopPipeline(res) {
  if (!pipelineControl.busy) {
    return sendJSON(res, 200, {
      status: 'idle',
      message: 'No running batch pipeline to stop.',
      control: pipelineControl,
    });
  }

  pipelineControl.stop_requested = true;
  logger.warn('Stop requested by user for running batch pipeline');
  return sendJSON(res, 200, {
    status: 'stopping',
    message: 'Stop requested. Current in-flight step will finish, then run will halt.',
    control: pipelineControl,
  });
}

// Route: GET /pipeline/control
function handlePipelineControl(res) {
  return sendJSON(res, 200, pipelineControl);
}

// Route: GET /ui/data/files?type=demo|onboarding
function handleListFiles(reqUrl, res) {
  const type = reqUrl.searchParams.get('type');
  const files = listInputFilesByType(type);
  if (!files) return sendJSON(res, 400, { error: 'Invalid type. Use demo or onboarding.' });
  return sendJSON(res, 200, { type, files });
}

// Route: POST /ui/data/upload?type=demo|onboarding
async function handleUploadFile(req, reqUrl, res) {
  try {
    const type = reqUrl.searchParams.get('type');
    const targetDir = getInputDirByType(type);
    if (!targetDir) {
      return sendJSON(res, 400, { error: 'Invalid type. Use demo or onboarding.' });
    }

    const body = await parseBody(req);
    if (!body._files) {
      return sendJSON(res, 400, { error: 'Use multipart/form-data and attach a file.' });
    }

    const fileField = body._files.file || Object.values(body._files)[0];
    if (!fileField || !fileField.filename || !fileField.data) {
      return sendJSON(res, 400, { error: 'No file found in request.' });
    }

    const safeName = sanitizeFilename(fileField.filename);
    if (!safeName) {
      return sendJSON(res, 400, { error: 'Invalid filename.' });
    }

    const destPath = path.join(targetDir, safeName);
    fs.writeFileSync(destPath, fileField.data);

    logger.info('Uploaded input file', { type, filename: safeName, bytes: fileField.data.length });
    return sendJSON(res, 200, { status: 'success', type, filename: safeName });
  } catch (err) {
    logger.error(`/ui/data/upload error: ${err.message}`);
    return sendJSON(res, 500, { error: err.message });
  }
}

// Route: DELETE /ui/data/files?type=demo|onboarding&name=<filename>
function handleDeleteFile(reqUrl, res) {
  const type = reqUrl.searchParams.get('type');
  const name = reqUrl.searchParams.get('name');
  const targetDir = getInputDirByType(type);
  if (!targetDir) {
    return sendJSON(res, 400, { error: 'Invalid type. Use demo or onboarding.' });
  }

  const safeName = sanitizeFilename(name);
  if (!safeName) {
    return sendJSON(res, 400, { error: 'Invalid filename.' });
  }

  const fullPath = path.join(targetDir, safeName);
  if (!fs.existsSync(fullPath)) {
    return sendJSON(res, 404, { error: 'File not found.' });
  }

  fs.unlinkSync(fullPath);

  // Also cleanup cached transcript generated from audio for this file.
  const ext = path.extname(safeName);
  if (ext) {
    const base = safeName.slice(0, -ext.length);
    const cachedTranscript = path.join(targetDir, `${base}.transcript.txt`);
    if (fs.existsSync(cachedTranscript)) {
      try { fs.unlinkSync(cachedTranscript); } catch { /* ignore cleanup errors */ }
    }
  }

  logger.info('Deleted input file', { type, filename: safeName });
  return sendJSON(res, 200, { status: 'success', type, filename: safeName });
}

// Route: GET /ui/data/accounts
function handleListAccounts(res) {
  const accounts = listAccounts();
  return sendJSON(res, 200, { accounts });
}

// Route: GET /ui/data/diff/<account_id>
function handleGetDiff(pathname, res) {
  const accountId = decodeURIComponent(pathname.replace('/ui/data/diff/', ''));
  const diff = readAccountDiff(accountId);
  if (!diff) {
    return sendJSON(res, 404, { error: `changes.json not found for account: ${accountId}` });
  }
  return sendJSON(res, 200, diff);
}

// Route handler
async function handleRequest(req, res) {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const url = reqUrl.pathname;
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

  // Reject concurrent mutating requests while a batch run is active.
  const isMutating = method === 'POST' || method === 'DELETE';
  const allowsDuringRun = url === '/pipeline/stop' || url === '/pipeline/control';
  if (pipelineControl.busy && isMutating && !allowsDuringRun) {
    return sendJSON(res, 409, {
      error: 'A batch run is in progress. Stop it first or wait until it finishes.',
      control: pipelineControl,
    });
  }

  // UI routes
  if ((url === '/' || url === '/ui') && method === 'GET') {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  if (url === '/ui/data/files' && method === 'GET') {
    return handleListFiles(reqUrl, res);
  }

  if (url === '/ui/data/upload' && method === 'POST') {
    return handleUploadFile(req, reqUrl, res);
  }

  if (url === '/ui/data/files' && method === 'DELETE') {
    return handleDeleteFile(reqUrl, res);
  }

  if (url === '/ui/data/accounts' && method === 'GET') {
    return handleListAccounts(res);
  }

  if (url.startsWith('/ui/data/diff/') && method === 'GET') {
    return handleGetDiff(url, res);
  }

  if (url === '/pipeline/run' && method === 'POST') {
    return handleBatchRun(req, res);
  }

  if (url === '/pipeline/stop' && method === 'POST') {
    return handleStopPipeline(res);
  }

  if (url === '/pipeline/control' && method === 'GET') {
    return handlePipelineControl(res);
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
  logger.info('  GET  /                     - web dashboard');
  logger.info('  GET  /ui                  - web dashboard');
  logger.info('  GET  /ui/data/files       - list input files');
  logger.info('  POST /ui/data/upload      - upload input file');
  logger.info('  DELETE /ui/data/files     - delete input file');
  logger.info('  GET  /ui/data/accounts    - list processed accounts');
  logger.info('  GET  /ui/data/diff/:id    - read account changes');
  logger.info('  POST /pipeline/run          - batch run');
  logger.info('  POST /pipeline/stop         - stop running batch run');
  logger.info('  GET  /pipeline/control      - batch lock status');
  logger.info('  POST /pipeline/demo         - single demo extraction');
  logger.info('  POST /pipeline/onboarding   - single onboarding merge');
  logger.info('  GET  /pipeline/status        - all task statuses');
  logger.info('  GET  /pipeline/status/:id    - account task status');
  logger.info('  GET  /health                 - health check');
});
