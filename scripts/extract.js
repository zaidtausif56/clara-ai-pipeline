// extract.js - LLM-based data extraction from call transcripts via Ollama
// Handles: prompt building, JSON repair, schema validation, missing-data flagging

const http = require('http');
const logger = require('./logger');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const PREFERRED_MODELS = ['llama3.2', 'mistral', 'llama3', 'llama2', 'gemma'];
const MAX_RETRIES = 3;

// Chunking config — conservative limits to stay well within Ollama context windows
// Most local models support 4096-8192 tokens; ~4 chars/token → ~16K-32K chars.
// We reserve ~2K chars for the prompt template + schema, leaving ~10K for transcript.
const MAX_TRANSCRIPT_CHARS = parseInt(process.env.MAX_TRANSCRIPT_CHARS, 10) || 10000;
const CHUNK_OVERLAP_CHARS = parseInt(process.env.CHUNK_OVERLAP_CHARS, 10) || 500;

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

function buildExtractionPrompt(transcriptText, chunkInfo) {
  const chunkHeader = chunkInfo
    ? `\nNote: This is chunk ${chunkInfo.index} of ${chunkInfo.total} from a longer transcript. Extract whatever information is present in THIS chunk. Fields not mentioned in this chunk should use null or [].`
    : '';

  return `You are a data extraction assistant for a call answering service company called Clara Answers.
Extract ONLY explicitly stated information from the following transcript.
DO NOT invent, assume, or hallucinate any information.
If a field is not mentioned, use null for single values or [] for arrays.
For "notes", write a 1-2 sentence summary of the call. If nothing notable, use an empty string.
For "account_id", derive it from the company_name by lowercasing and replacing spaces/special characters with hyphens.
${chunkHeader}

Return ONLY valid JSON matching this exact schema (no markdown, no explanation, no code fences):

${SCHEMA_STRING}

TRANSCRIPT:
${transcriptText}`;
}

// Split a large transcript into overlapping chunks at sentence/paragraph boundaries
function chunkTranscript(text, maxChars = MAX_TRANSCRIPT_CHARS, overlap = CHUNK_OVERLAP_CHARS) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // Try to break at a paragraph or sentence boundary before the hard limit
    if (end < text.length) {
      // Look for paragraph break (double newline) within the last 20% of the chunk
      const searchStart = Math.max(start, end - Math.floor(maxChars * 0.2));
      const segment = text.slice(searchStart, end);

      const paraBreak = segment.lastIndexOf('\n\n');
      if (paraBreak !== -1) {
        end = searchStart + paraBreak + 2; // include the double newline
      } else {
        // Fall back to single newline
        const lineBreak = segment.lastIndexOf('\n');
        if (lineBreak !== -1) {
          end = searchStart + lineBreak + 1;
        }
        // else: hard cut at maxChars
      }
    }

    chunks.push(text.slice(start, end));

    const minAdvance = maxChars - overlap;
    start = Math.max(start + minAdvance, end - overlap);
    // But don't go backwards
    if (start >= text.length) break;
  }

  logger.info(`Transcript chunked`, { totalChars: text.length, chunks: chunks.length, maxChars, overlap });
  return chunks;
}

// Merge an array of partial memos extracted from chunks into one combined memo
function mergeChunkMemos(memos) {
  if (memos.length === 0) return null;
  if (memos.length === 1) return memos[0];

  const merged = {
    account_id: null,
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
    questions_or_unknowns: [],
    notes: '',
  };

  const noteFragments = [];

  for (const memo of memos) {
    // Scalars: take first non-null value found
    if (!merged.company_name && memo.company_name) merged.company_name = memo.company_name;
    if (!merged.account_id && memo.account_id && memo.account_id !== 'unknown-company') merged.account_id = memo.account_id;
    if (!merged.office_address && memo.office_address) merged.office_address = memo.office_address;
    if (!merged.after_hours_flow_summary && memo.after_hours_flow_summary) merged.after_hours_flow_summary = memo.after_hours_flow_summary;
    if (!merged.office_hours_flow_summary && memo.office_hours_flow_summary) merged.office_hours_flow_summary = memo.office_hours_flow_summary;

    // Business hours: fill in missing sub-fields
    if (memo.business_hours && typeof memo.business_hours === 'object') {
      for (const key of ['days', 'start', 'end', 'timezone']) {
        if (!merged.business_hours[key] && memo.business_hours[key]) {
          merged.business_hours[key] = memo.business_hours[key];
        }
      }
    }

    // Arrays: union (deduplicate)
    const arrayFields = [
      'services_supported', 'emergency_definition', 'emergency_routing_rules',
      'non_emergency_routing_rules', 'call_transfer_rules', 'integration_constraints',
      'questions_or_unknowns',
    ];
    for (const field of arrayFields) {
      if (Array.isArray(memo[field])) {
        for (const item of memo[field]) {
          if (item && !merged[field].includes(item)) {
            merged[field].push(item);
          }
        }
      }
    }

    // Notes: collect fragments to combine later
    if (memo.notes && typeof memo.notes === 'string' && memo.notes.trim().length > 0) {
      noteFragments.push(memo.notes.trim());
    }
  }

  // Combine notes, removing duplicates
  const uniqueNotes = [...new Set(noteFragments)];
  merged.notes = uniqueNotes.join(' ');

  // Ensure account_id
  if (!merged.account_id) {
    merged.account_id = slugify(merged.company_name);
  }

  logger.info('Merged chunk memos', { chunks: memos.length, company: merged.company_name });
  return merged;
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
    req.setTimeout(300000, () => {
      req.destroy();
      reject(new Error('Ollama request timed out (300s)'));
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
// Automatically chunks large transcripts and merges results.
async function extractFromTranscript(transcriptText, options = {}) {
  if (!transcriptText || transcriptText.trim().length === 0) {
    throw new Error('Transcript text is empty');
  }

  const model = options.model || (await pickModel());

  // Chunk the transcript if it exceeds the per-request limit
  const chunks = chunkTranscript(transcriptText);

  if (chunks.length === 1) {
    // Small transcript — single-pass extraction (original behavior)
    return _extractSingleChunk(chunks[0], model, null);
  }

  // Large transcript — extract from each chunk, then merge
  logger.info(`Large transcript detected (${transcriptText.length} chars). Processing ${chunks.length} chunks...`);

  const chunkMemos = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkInfo = { index: i + 1, total: chunks.length };
    logger.info(`Extracting chunk ${chunkInfo.index}/${chunkInfo.total} (${chunks[i].length} chars)`);
    try {
      const memo = await _extractSingleChunk(chunks[i], model, chunkInfo);
      chunkMemos.push(memo);
    } catch (err) {
      logger.warn(`Chunk ${chunkInfo.index} extraction failed, skipping: ${err.message}`);
      // Continue with remaining chunks — partial data is better than none
    }
  }

  if (chunkMemos.length === 0) {
    throw new Error('All chunks failed extraction — cannot produce memo');
  }

  const merged = mergeChunkMemos(chunkMemos);
  const validated = validateMemo(merged);
  logger.info('Chunked extraction complete', { account_id: validated.account_id, chunksUsed: chunkMemos.length });
  return validated;
}

// Extract from a single chunk (with retries)
async function _extractSingleChunk(chunkText, model, chunkInfo) {
  const prompt = buildExtractionPrompt(chunkText, chunkInfo);

  logger.info('Starting extraction', { model, transcriptLength: chunkText.length });

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

      const validated = chunkInfo ? parsed : validateMemo(parsed); // defer validation for chunks until merge
      logger.info('Extraction successful', { account_id: validated.account_id || '(chunk)' });
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
  chunkTranscript,
  mergeChunkMemos,
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
