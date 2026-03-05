// runPipeline.js - Main pipeline runner
// Usage:
//   node scripts/runPipeline.js              (full pipeline)
//   node scripts/runPipeline.js --demo-only   (Pipeline A only)
//   node scripts/runPipeline.js --onboard-only (Pipeline B only)

const fs = require('fs');
const path = require('path');
const { extractFromTranscript, slugify } = require('./extract');
const { generateAgentSpec } = require('./generateAgent');
const { mergeMemos } = require('./merge');
const { generateChangelog } = require('./diff');
const { upsertTask, completeTask, startNewRun } = require('./taskTracker');
const { isAudioFile, readInputWithTranscription, AUDIO_EXTENSIONS } = require('./transcribe');
const logger = require('./logger');

const ROOT = path.resolve(__dirname, '..');
const INPUTS_DIR = path.join(ROOT, 'inputs');
const DEMO_DIR = path.join(INPUTS_DIR, 'demo');
const ONBOARDING_DIR = path.join(INPUTS_DIR, 'onboarding');
const MAPPING_FILE = path.join(INPUTS_DIR, 'mapping.json');
const OUTPUTS_DIR = path.join(ROOT, 'outputs');
const ACCOUNTS_DIR = path.join(OUTPUTS_DIR, 'accounts');
const SUMMARY_FILE = path.join(OUTPUTS_DIR, 'batch_summary.json');
const ACCOUNT_MAX_RETRIES = parseInt(process.env.ACCOUNT_MAX_RETRIES, 10) || 1;

// Supported input extensions: .txt, .json (text), .m4a, .mp3, .wav, .webm, .ogg, .flac (audio)
const SUPPORTED_EXTENSIONS = ['.txt', '.json', ...AUDIO_EXTENSIONS];

function listInputFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const allFiles = fs.readdirSync(dir);

  // Build a set of base names that have a .txt transcript (not .transcript.txt)
  const txtBases = new Set();
  for (const f of allFiles) {
    if (f.endsWith('.transcript.txt')) continue;
    if (f.toLowerCase().endsWith('.txt')) {
      const base = path.basename(f, '.txt').toLowerCase();
      txtBases.add(base);
    }
  }

  return allFiles
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      // Skip cached transcript files generated from audio
      if (f.endsWith('.transcript.txt')) return false;
      if (!SUPPORTED_EXTENSIONS.includes(ext)) return false;
      // If a .txt transcript exists for this base name, skip the audio file
      if (AUDIO_EXTENSIONS.includes(ext)) {
        const base = path.basename(f, ext).toLowerCase();
        if (txtBases.has(base)) {
          logger.info(`Skipping audio file ${f} — text transcript already exists`);
          return false;
        }
      }
      return true;
    })
    .map((f) => path.join(dir, f));
}

// Read a text input file (.txt or .json). For audio files, use readInputAuto instead.
function readInput(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    try {
      const form = JSON.parse(raw);
      return formToTranscript(form);
    } catch {
      return raw; // not valid JSON, treat as text
    }
  }
  return raw;
}

// Read input that may be a text file or an audio file (.m4a, etc.)
// Audio files are transcribed to text automatically.
async function readInputAuto(filePath) {
  if (isAudioFile(filePath)) {
    const transcript = await readInputWithTranscription(filePath);
    if (transcript) return transcript;
    // Fallback: should not happen, but just in case
    throw new Error(`Failed to transcribe audio file: ${filePath}`);
  }
  return readInput(filePath);
}

// Convert form JSON into text format the LLM can extract from
function formToTranscript(form) {
  const lines = ['Onboarding Form Submission:'];
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === 'object' && value !== null) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

function loadMapping() {
  if (fs.existsSync(MAPPING_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
      logger.info('Loaded mapping file', { entries: data.length });
      return data;
    } catch (err) {
      logger.warn(`Failed to parse mapping file: ${err.message}`);
    }
  }
  return null;
}

// Match demo <-> onboarding files by stripping common suffixes and comparing
function autoMapByFilename(demoFiles, onboardingFiles) {
  const mapping = [];

  for (const demoFile of demoFiles) {
    const demoBase = path.basename(demoFile, path.extname(demoFile));
    const demoCore = demoBase
      .replace(/[-_]?(demo|call|recording|transcript|audio)[-_]?/gi, '')
      .replace(/^-|-$/g, '')
      .toLowerCase();

    let matchedOnboarding = null;

    for (const obFile of onboardingFiles) {
      const obBase = path.basename(obFile, path.extname(obFile));
      const obCore = obBase
        .replace(/[-_]?(onboarding|onboard|form|call|recording|transcript|audio)[-_]?/gi, '')
        .replace(/[-_]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();

      if (demoCore && obCore && demoCore === obCore) {
        matchedOnboarding = obFile;
        break;
      }
    }

    mapping.push({
      account_id: demoCore || slugify(demoBase),
      demo_file: demoFile,
      onboarding_file: matchedOnboarding,
    });
  }

  // add unmatched onboarding files
  const matchedObs = new Set(mapping.filter((m) => m.onboarding_file).map((m) => m.onboarding_file));
  for (const obFile of onboardingFiles) {
    if (!matchedObs.has(obFile)) {
      const obBase = path.basename(obFile, path.extname(obFile));
      const obCore = obBase
        .replace(/[-_]?(onboarding|onboard|form|call|recording|transcript|audio)[-_]?/gi, '')
        .replace(/[-_]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();

      mapping.push({
        account_id: obCore || slugify(obBase),
        demo_file: null,
        onboarding_file: obFile,
      });
    }
  }

  return mapping;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function runPipelineA(accountId, demoFilePath, model) {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`Pipeline A: ${accountId} -- Demo -> v1`);
  logger.info(`${'='.repeat(60)}`);

  const accountDir = path.join(ACCOUNTS_DIR, accountId);
  const v1Dir = path.join(accountDir, 'v1');

  startNewRun(accountId, isAudioFile(demoFilePath) ? 'demo_transcribing' : 'demo_extracting', { file: demoFilePath });

  const isAudio = isAudioFile(demoFilePath);
  if (isAudio) {
    logger.info(`Audio file detected, transcribing: ${path.basename(demoFilePath)}`);
  }
  const transcript = await readInputAuto(demoFilePath);
  logger.info(`Read transcript: ${path.basename(demoFilePath)} (${transcript.length} chars)`);
  upsertTask(accountId, 'demo_extracting', { file: demoFilePath });

  const memo = await extractFromTranscript(transcript, { model });
  memo.account_id = accountId;

  writeJSON(path.join(v1Dir, 'memo.json'), memo);
  logger.info(`Saved v1 memo: ${path.join(v1Dir, 'memo.json')}`);
  upsertTask(accountId, 'demo_extracted', { memo_fields: Object.keys(memo).length });

  const agentSpec = generateAgentSpec(memo, 'v1');
  writeJSON(path.join(v1Dir, 'agent.json'), agentSpec);
  logger.info(`Saved v1 agent spec: ${path.join(v1Dir, 'agent.json')}`);
  upsertTask(accountId, 'agent_v1_generated', { agent_name: agentSpec.agent_name });

  return memo;
}

async function runPipelineB(accountId, onboardingFilePath, v1Memo, model) {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`Pipeline B: ${accountId} -- Onboarding -> v2`);
  logger.info(`${'='.repeat(60)}`);

  const accountDir = path.join(ACCOUNTS_DIR, accountId);
  const v1Dir = path.join(accountDir, 'v1');
  const v2Dir = path.join(accountDir, 'v2');

  if (!v1Memo) {
    const v1MemoPath = path.join(v1Dir, 'memo.json');
    if (fs.existsSync(v1MemoPath)) {
      v1Memo = JSON.parse(fs.readFileSync(v1MemoPath, 'utf-8'));
      logger.info('Loaded existing v1 memo from disk');
    } else {
      logger.warn('No v1 memo found, creating empty baseline');
      v1Memo = createEmptyMemo(accountId);
      writeJSON(path.join(v1Dir, 'memo.json'), v1Memo);
      const v1Agent = generateAgentSpec(v1Memo, 'v1');
      writeJSON(path.join(v1Dir, 'agent.json'), v1Agent);
    }
  }

  const isAudio = isAudioFile(onboardingFilePath);
  upsertTask(accountId, isAudio ? 'onboarding_transcribing' : 'onboarding_extracting', { file: onboardingFilePath });
  if (isAudio) {
    logger.info(`Audio file detected, transcribing: ${path.basename(onboardingFilePath)}`);
  }
  const transcript = await readInputAuto(onboardingFilePath);
  logger.info(`Read onboarding: ${path.basename(onboardingFilePath)} (${transcript.length} chars)`);
  upsertTask(accountId, 'onboarding_extracting', { file: onboardingFilePath });

  const onboardingData = await extractFromTranscript(transcript, { model });
  onboardingData.account_id = accountId;
  upsertTask(accountId, 'onboarding_extracted');

  const { merged, conflicts } = mergeMemos(v1Memo, onboardingData);
  merged.account_id = accountId;

  writeJSON(path.join(v2Dir, 'memo.json'), merged);
  logger.info(`Saved v2 memo: ${path.join(v2Dir, 'memo.json')}`);
  upsertTask(accountId, 'merged', { conflicts: conflicts.length });

  const agentSpec = generateAgentSpec(merged, 'v2');
  writeJSON(path.join(v2Dir, 'agent.json'), agentSpec);
  logger.info(`Saved v2 agent spec: ${path.join(v2Dir, 'agent.json')}`);
  upsertTask(accountId, 'agent_v2_generated', { agent_name: agentSpec.agent_name });

  const changelog = generateChangelog(v1Memo, merged, conflicts);
  writeJSON(path.join(accountDir, 'changes.json'), changelog);
  logger.info(`Saved changelog: ${path.join(accountDir, 'changes.json')}`);

  // Mark complete
  completeTask(accountId);

  return merged;
}

function assertNotStopped(shouldStop, stage) {
  if (typeof shouldStop === 'function' && shouldStop()) {
    throw new Error(`Run stopped by user during ${stage}`);
  }
}

function createEmptyMemo(accountId) {
  return {
    account_id: accountId,
    company_name: null,
    business_hours: { days: null, start: null, end: null, timezone: null },
    office_address: null,
    services_supported: [],
    emergency_definition: [],
    emergency_routing_rules: [],
    non_emergency_routing_rules: [],
    call_transfer_rules: [],
    integration_constraints: [],
    after_hours_flow_summary: null,
    office_hours_flow_summary: null,
    questions_or_unknowns: [
      'Business hours not specified',
      'Emergency definition not provided',
      'Emergency routing rules not specified',
      'Services supported not listed',
      'Non-emergency routing rules not specified',
      'Call transfer rules not specified',
    ],
    notes: '',
  };
}

async function runAll(options = {}) {
  const startTime = Date.now();
  const demoOnly = options.demoOnly || false;
  const onboardOnly = options.onboardOnly || false;
  const shouldStop = options.shouldStop;

  logger.info('=== Clara AI Pipeline - Batch Run ===');
  logger.info(`Mode: ${demoOnly ? 'Demo Only' : onboardOnly ? 'Onboarding Only' : 'Full Pipeline'}`);

  // Ensure output dirs exist
  ensureDir(ACCOUNTS_DIR);

  // Discover input files
  const demoFiles = listInputFiles(DEMO_DIR);
  const onboardingFiles = listInputFiles(ONBOARDING_DIR);

  logger.info(`Found ${demoFiles.length} demo file(s), ${onboardingFiles.length} onboarding file(s)`);

  if (demoFiles.length === 0 && onboardingFiles.length === 0) {
    logger.warn('No input files found. Place transcripts in inputs/demo/ and inputs/onboarding/');
    return;
  }

  // Build account mapping
  const explicitMapping = loadMapping();
  let mapping;

  if (explicitMapping) {
    // Resolve relative paths in explicit mapping
    mapping = explicitMapping.map((m) => ({
      account_id: m.account_id,
      demo_file: m.demo_file ? path.resolve(INPUTS_DIR, m.demo_file) : null,
      onboarding_file: m.onboarding_file ? path.resolve(INPUTS_DIR, m.onboarding_file) : null,
    }));
  } else {
    mapping = autoMapByFilename(demoFiles, onboardingFiles);
  }

  logger.info(`Account mapping: ${mapping.length} account(s)`);
  for (const m of mapping) {
    logger.info(`  ${m.account_id}: demo=${m.demo_file ? path.basename(m.demo_file) : 'none'}, onboarding=${m.onboarding_file ? path.basename(m.onboarding_file) : 'none'}`);
  }

  // Pick model once for the whole batch
  const { pickModel } = require('./extract');
  // Pre-check Ollama connectivity with retries
  let model;
  for (let i = 0; i < 3; i++) {
    try {
      model = await pickModel();
      break;
    } catch (err) {
      if (i < 2) {
        logger.warn(`Ollama not ready (attempt ${i + 1}/3), retrying in ${3 * (i + 1)}s: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
      } else {
        logger.error(`Cannot connect to Ollama after 3 attempts: ${err.message}`);
        logger.error('Make sure Ollama is running: ollama serve');
        process.exit(1);
      }
    }
  }

  const results = {
    start_time: new Date(startTime).toISOString(),
    model_used: model,
    accounts_processed: 0,
    v1_generated: 0,
    v2_generated: 0,
    errors: [],
  };

  for (const entry of mapping) {
    assertNotStopped(shouldStop, 'batch loop');

    const { account_id, demo_file, onboarding_file } = entry;
    let v1Memo = null;

    for (let attempt = 0; attempt <= ACCOUNT_MAX_RETRIES; attempt++) {
      try {
        assertNotStopped(shouldStop, `account ${account_id}`);

        if (attempt > 0) {
          const delay = 3000 * attempt;
          logger.warn(`Retrying account ${account_id} (attempt ${attempt}/${ACCOUNT_MAX_RETRIES}) after ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }

        assertNotStopped(shouldStop, `account ${account_id} after retry delay`);

        // Pipeline A: Demo → v1
        if (demo_file && !onboardOnly) {
          if (!fs.existsSync(demo_file)) {
            logger.warn(`Demo file not found: ${demo_file}`);
            results.errors.push({ account_id, stage: 'demo', error: 'File not found' });
          } else {
            assertNotStopped(shouldStop, `account ${account_id} before pipeline A`);
            v1Memo = await runPipelineA(account_id, demo_file, model);
            results.v1_generated++;
          }
        }

        // Pipeline B: Onboarding → v2
        if (onboarding_file && !demoOnly) {
          if (!fs.existsSync(onboarding_file)) {
            logger.warn(`Onboarding file not found: ${onboarding_file}`);
            results.errors.push({ account_id, stage: 'onboarding', error: 'File not found' });
          } else {
            assertNotStopped(shouldStop, `account ${account_id} before pipeline B`);
            await runPipelineB(account_id, onboarding_file, v1Memo, model);
            results.v2_generated++;
          }
        }

        // If demo only (no onboarding), mark as complete
        if (demo_file && !onboarding_file && !onboardOnly) {
          completeTask(account_id);
        }

        results.accounts_processed++;
        break; // success — exit retry loop
      } catch (err) {
        if (attempt < ACCOUNT_MAX_RETRIES) {
          logger.warn(`Account ${account_id} failed (attempt ${attempt}), will retry: ${err.message}`);
        } else {
          logger.error(`Error processing ${account_id} after ${attempt + 1} attempts: ${err.message}`);
          results.errors.push({ account_id, stage: 'unknown', error: err.message, attempts: attempt + 1 });
        }
      }
    }
  }

  results.end_time = new Date().toISOString();
  results.duration_ms = Date.now() - startTime;
  results.duration_readable = formatDuration(results.duration_ms);

  if (typeof shouldStop === 'function' && shouldStop()) {
    results.stopped = true;
  }

  writeJSON(SUMMARY_FILE, results);
  logger.info(`\n${'='.repeat(60)}`);
  logger.info('=== Batch Run Complete ===');
  logger.info(`Accounts processed: ${results.accounts_processed}`);
  logger.info(`v1 agents generated: ${results.v1_generated}`);
  logger.info(`v2 agents generated: ${results.v2_generated}`);
  logger.info(`Errors: ${results.errors.length}`);
  logger.info(`Duration: ${results.duration_readable}`);
  logger.info(`Summary saved to: ${SUMMARY_FILE}`);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return m > 0 ? `${m}m ${rs}s` : `${s}s`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {
    demoOnly: args.includes('--demo-only'),
    onboardOnly: args.includes('--onboard-only'),
  };

  runAll(options).catch((err) => {
    logger.error(`Pipeline failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runAll, runPipelineA, runPipelineB, createEmptyMemo };
