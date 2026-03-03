// extract.js - LLM-based data extraction from call transcripts via Ollama
// Handles: prompt building, JSON repair, schema validation, missing-data flagging

const http = require('http');
const logger = require('./logger');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const PREFERRED_MODELS = ['llama3.2', 'mistral', 'llama3', 'llama2', 'gemma'];
const MAX_RETRIES = 2;

// Account Memo schema used for LLM prompt and validation
const MEMO_SCHEMA = {
  account_id: 'string',
  company_name: 'string | null',
  business_hours: {
    days: 'string | null',
    start: 'string | null',
    end: 'string | null',
    timezone: 'string | null',
  },
  office_address: 'string | null',
  services_supported: 'string[]',
  emergency_definition: 'string[]',
  emergency_routing_rules: 'string[]',
  non_emergency_routing_rules: 'string[]',
  call_transfer_rules: 'string[]',
  integration_constraints: 'string[]',
  after_hours_flow_summary: 'string | null',
  office_hours_flow_summary: 'string | null',
  questions_or_unknowns: 'string[]',
  notes: 'string',
};

const SCHEMA_STRING = JSON.stringify(MEMO_SCHEMA, null, 2);

function buildExtractionPrompt(transcriptText) {
  return `You are a data extraction assistant for a call answering service company called Clara Answers.
Extract ONLY explicitly stated information from the following transcript.
DO NOT invent, assume, or hallucinate any information.
If a field is not mentioned, use null for single values or [] for arrays.
For "notes", write a 1-2 sentence summary of the call. If nothing notable, use an empty string.
For "account_id", derive it from the company_name by lowercasing and replacing spaces/special characters with hyphens.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation, no code fences):

${SCHEMA_STRING}

TRANSCRIPT:
${transcriptText}`;
}

// Send a prompt to Ollama, return raw response text
function ollamaGenerate(model, prompt) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/generate', OLLAMA_URL);
    const body = JSON.stringify({ model, prompt, stream: false });

    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response || '');
        } catch {
          reject(new Error(`Failed to parse Ollama response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('Ollama request timed out (120s)'));
    });
    req.write(body);
    req.end();
  });
}

// Fetch available models from Ollama
function ollamaListModels() {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/tags', OLLAMA_URL);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const names = (parsed.models || []).map((m) => m.name.replace(/:latest$/, ''));
            resolve(names);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.end();
  });
}

// Pick the best available model from our preferred list
async function pickModel() {
  const available = await ollamaListModels();
  logger.debug('Available Ollama models', { available });

  if (available.length === 0) {
    throw new Error(
      'No Ollama models available. Please pull a model first: ollama pull llama3.2'
    );
  }

  for (const pref of PREFERRED_MODELS) {
    const match = available.find((a) => a.startsWith(pref));
    if (match) {
      logger.info(`Selected model: ${match}`);
      return match;
    }
  }

  // Fallback to first available
  logger.warn(`No preferred model found, using: ${available[0]}`);
  return available[0];
}

// Try to extract valid JSON from potentially messy LLM output
function repairJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Remove markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  // Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // Try to find JSON object boundaries
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // continue
    }
  }

  // try array boundaries as fallback
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1));
    } catch {
      // continue
    }
  }

  return null;
}

function slugify(str) {
  if (!str) return 'unknown-company';
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'unknown-company';
}

// Validate and normalize extracted memo against required schema
function validateMemo(raw) {
  const memo = { ...raw };

  const nullableStrings = [
    'company_name',
    'office_address',
    'after_hours_flow_summary',
    'office_hours_flow_summary',
  ];
  for (const field of nullableStrings) {
    if (memo[field] !== null && typeof memo[field] !== 'string') {
      memo[field] = memo[field] != null ? String(memo[field]) : null;
    }
  }

  if (typeof memo.notes !== 'string') {
    memo.notes = memo.notes != null ? String(memo.notes) : '';
  }

  const arrayFields = [
    'services_supported',
    'emergency_definition',
    'emergency_routing_rules',
    'non_emergency_routing_rules',
    'call_transfer_rules',
    'integration_constraints',
    'questions_or_unknowns',
  ];
  for (const field of arrayFields) {
    if (!Array.isArray(memo[field])) {
      if (typeof memo[field] === 'string' && memo[field].length > 0) {
        memo[field] = [memo[field]];
      } else {
        memo[field] = [];
      }
    }
    memo[field] = memo[field].map((v) => (typeof v === 'string' ? v : String(v)));
  }

  if (!memo.business_hours || typeof memo.business_hours !== 'object') {
    memo.business_hours = { days: null, start: null, end: null, timezone: null };
  } else {
    for (const sub of ['days', 'start', 'end', 'timezone']) {
      if (memo.business_hours[sub] !== null && typeof memo.business_hours[sub] !== 'string') {
        memo.business_hours[sub] = memo.business_hours[sub] != null
          ? String(memo.business_hours[sub])
          : null;
      }
    }
  }

  if (!memo.account_id || typeof memo.account_id !== 'string') {
    memo.account_id = slugify(memo.company_name);
  } else {
    memo.account_id = slugify(memo.account_id);
  }

  // Flag missing critical info
  const bh = memo.business_hours;
  if (!bh.days && !bh.start && !bh.end && !bh.timezone) {
    addUnknown(memo, 'Business hours not specified');
  }
  if (memo.emergency_definition.length === 0) {
    addUnknown(memo, 'Emergency definition not provided');
  }
  if (memo.emergency_routing_rules.length === 0) {
    addUnknown(memo, 'Emergency routing rules not specified');
  }
  if (memo.services_supported.length === 0) {
    addUnknown(memo, 'Services supported not listed');
  }
  if (memo.non_emergency_routing_rules.length === 0) {
    addUnknown(memo, 'Non-emergency routing rules not specified');
  }
  if (memo.call_transfer_rules.length === 0) {
    addUnknown(memo, 'Call transfer rules not specified');
  }

  return memo;
}

function addUnknown(memo, note) {
  if (!memo.questions_or_unknowns.includes(note)) {
    memo.questions_or_unknowns.push(note);
  }
}

// Main extraction: transcript text -> validated Account Memo JSON
async function extractFromTranscript(transcriptText, options = {}) {
  if (!transcriptText || transcriptText.trim().length === 0) {
    throw new Error('Transcript text is empty');
  }

  const model = options.model || (await pickModel());
  const prompt = buildExtractionPrompt(transcriptText);

  logger.info('Starting extraction', { model, transcriptLength: transcriptText.length });

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        logger.warn(`Retry attempt ${attempt}/${MAX_RETRIES}`);
      }

      const rawResponse = await ollamaGenerate(model, prompt);
      logger.debug('Raw LLM response', { length: rawResponse.length });

      const parsed = repairJSON(rawResponse);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Could not parse JSON from LLM response');
      }

      const validated = validateMemo(parsed);
      logger.info('Extraction successful', { account_id: validated.account_id });
      return validated;
    } catch (err) {
      lastError = err;
      logger.error(`Extraction attempt ${attempt} failed: ${err.message}`);
    }
  }

  throw new Error(`Extraction failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`);
}

module.exports = {
  extractFromTranscript,
  validateMemo,
  slugify,
  repairJSON,
  pickModel,
  buildExtractionPrompt,
  MEMO_SCHEMA,
};

// CLI: node scripts/extract.js <transcript_file>
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');

  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/extract.js <transcript_file>');
    process.exit(1);
  }

  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const text = fs.readFileSync(fullPath, 'utf-8');
  extractFromTranscript(text)
    .then((memo) => {
      console.log(JSON.stringify(memo, null, 2));
    })
    .catch((err) => {
      console.error('Extraction failed:', err.message);
      process.exit(1);
    });
}
