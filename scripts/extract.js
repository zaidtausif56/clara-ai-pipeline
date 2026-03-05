// extract.js - LLM-based data extraction from call transcripts via Ollama
// Handles: prompt building, JSON repair, schema validation, missing-data flagging

const http = require('http');
const logger = require('./logger');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const PREFERRED_MODELS = ['llama3.2', 'llama3.1:8b', 'llama3.1', 'mistral', 'llama3', 'llama2', 'gemma'];
const MAX_RETRIES = 3;
const NUM_CTX = parseInt(process.env.NUM_CTX, 10) || 8192;

// Chunking config — with num_ctx=8192, the model can handle ~8K tokens per request.
// Our prompt+schema uses ~1500 tokens (~6K chars), leaving ~6500 tokens (~26K chars) for transcript.
// We use 10K char chunks for llama3.2 (3B) to stay safely within limits.
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

  return `You are a precise data extraction assistant. Extract structured operational information about a CLIENT'S TRADE BUSINESS from a sales/onboarding call transcript.

WHO IS WHO:
- "Clara" / "Clara AI" / "Clara Answers" = the SERVICE PROVIDER selling AI phone answering. They are NOT the client.
- The CLIENT is the trade business owner being sold to or onboarded (e.g., an electrician, plumber, HVAC company). Extract only THEIR company info.
- If you cannot determine the client's company name from the transcript, use null. NEVER use "Clara" or any variation.

DEMO / SIMULATION WARNING:
- These transcripts often include a LIVE DEMO where Clara shows a simulated phone call to the client. During the demo, a fake caller gives fake details (name, address, job description). DO NOT extract demo/simulation data as real business information.
- Any address given by a simulated caller (e.g., "my address is 123 Main St") is a JOB SITE in the demo, NOT the client's office address.
- Only extract addresses that the client explicitly identifies as their business/office address, NOT addresses from demo conversations.

STRICT EXTRACTION RULES:
1. Extract ONLY facts the CLIENT explicitly states about THEIR OWN business. If something is not clearly said by the client, use null or []. NEVER guess, infer, or assume.
2. company_name: The client's business name. Look for when they say "my company is..." or when the Clara rep addresses them by company name. NEVER use "Clara".
3. office_address: The client's BUSINESS office address, NOT a demo caller's job site address, NOT a website, NOT an email. If not explicitly stated by the client as their office, use null.
4. business_hours: Only fill in if the CLIENT explicitly states their hours. Do NOT assume 9-5 or Monday-Friday. Do NOT assume a timezone — only include it if stated.
5. services_supported: ONLY services the client's company actually performs. The client is typically ONE trade (e.g., electrical). Do NOT add other trades (plumbing, HVAC) unless the client explicitly says they do those. Do NOT duplicate (e.g., list "EV chargers" once, not as both "EV chargers" and "electric vehicle charger installation"). Keep each entry short (2-5 words).
6. emergency_definition: SPECIFIC situations the client describes as emergencies. NOT generic phrases like "electrical emergencies" or "outages". Only include what the client actually describes (e.g., "gas station pumps go down for property manager X").
7. emergency_routing_rules: The ACTUAL protocol the client describes — who to call, in what order, under what conditions. NOT generic phrases like "call to service owner" or "first responder". Must reference real people/roles mentioned by the client.
8. non_emergency_routing_rules: What actually happens — take a message, schedule a callback, etc. Keep entries specific and actionable.
9. call_transfer_rules: ONLY transfer rules the client explicitly states (e.g., "forward calls to my cell", "transfer to my second number"). Do NOT invent rules. Do NOT reference "Clara's team" or "Claire's team" — those are the service provider, not the client.
10. integration_constraints: ONLY tools/CRMs the CLIENT confirms they currently use (e.g., "Jobber"). Not tools mentioned by Clara as examples or suggestions.
11. after_hours_flow_summary: A concrete 1-2 sentence summary of what happens when someone calls after hours, based on what the client actually said. If not discussed, use null.
12. office_hours_flow_summary: A concrete 1-2 sentence summary of how calls during business hours should be handled. If not discussed, use null.
13. questions_or_unknowns: SPECIFIC operational gaps still needed for agent setup (e.g., "Business hours end time not confirmed", "After-hours contact number not provided"). Not generic curiosities.
14. notes: EXACTLY 2-3 sentences summarizing the key business facts and decisions. No filler.
15. account_id: Derive from company_name — lowercase, spaces/special chars become hyphens.
${chunkHeader}

Return ONLY valid JSON. No markdown, no explanation, no comments.

{
  "account_id": null,
  "company_name": null,
  "business_hours": { "days": null, "start": null, "end": null, "timezone": null },
  "office_address": null,
  "services_supported": [],
  "emergency_definition": [],
  "emergency_routing_rules": [],
  "non_emergency_routing_rules": [],
  "call_transfer_rules": [],
  "integration_constraints": [],
  "after_hours_flow_summary": null,
  "office_hours_flow_summary": null,
  "questions_or_unknowns": [],
  "notes": ""
}

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
        const lineBreak = segment.lastIndexOf('\n');
        if (lineBreak !== -1) {
          end = searchStart + lineBreak + 1;
        }
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

  const CLARA_NAMES_SET = new Set(['clara', 'clara answers', 'clara ai', 'clara answer']);

  for (const memo of memos) {
    // Scalars: take first non-null, non-junk value found
    if (!merged.company_name && memo.company_name && !CLARA_NAMES_SET.has(memo.company_name.trim().toLowerCase())) {
      merged.company_name = memo.company_name;
    }
    if (!merged.account_id && memo.account_id && memo.account_id !== 'unknown-company') merged.account_id = memo.account_id;
    if (!merged.office_address && memo.office_address && !isJunkValue(memo.office_address)) merged.office_address = memo.office_address;
    if (!merged.after_hours_flow_summary && memo.after_hours_flow_summary && !isJunkValue(memo.after_hours_flow_summary)) merged.after_hours_flow_summary = memo.after_hours_flow_summary;
    if (!merged.office_hours_flow_summary && memo.office_hours_flow_summary && !isJunkValue(memo.office_hours_flow_summary)) merged.office_hours_flow_summary = memo.office_hours_flow_summary;

    // Business hours: fill in missing sub-fields (skip junk)
    if (memo.business_hours && typeof memo.business_hours === 'object') {
      for (const key of ['days', 'start', 'end', 'timezone']) {
        if (!merged.business_hours[key] && memo.business_hours[key] && !isJunkValue(String(memo.business_hours[key]))) {
          merged.business_hours[key] = memo.business_hours[key];
        }
      }
    }

    // Arrays: union (deduplicate, case-insensitive)
    const arrayFields = [
      'services_supported', 'emergency_definition', 'emergency_routing_rules',
      'non_emergency_routing_rules', 'call_transfer_rules', 'integration_constraints',
      'questions_or_unknowns',
    ];
    for (const field of arrayFields) {
      if (Array.isArray(memo[field])) {
        for (const item of memo[field]) {
          if (item && !isJunkValue(item) && !isClaraReference(item)) {
            const isDuplicate = merged[field].some(
              (existing) => existing.toLowerCase() === item.toLowerCase()
            );
            if (!isDuplicate) {
              merged[field].push(item);
            }
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

  // Deduplicate services after merging all chunks
  merged.services_supported = deduplicateServices(merged.services_supported);

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
    const body = JSON.stringify({ model, prompt, stream: false, options: { num_ctx: NUM_CTX } });

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

  logger.warn(`No preferred model found, using: ${available[0]}`);
  return available[0];
}

// Try to extract valid JSON from potentially messy LLM output
function repairJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Remove markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  try {
    return JSON.parse(text);
  } catch {
  }

  // Try to find JSON object boundaries
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
    }
  }

  // try array boundaries as fallback
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1));
    } catch {
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
const JUNK_VALUES = new Set([
  'string', 'null', 'string[]', 'string | null', 'number', 'boolean',
  'undefined', 'array', 'object', 'any', 'unknown',
  // Schema hint phrases the LLM copies verbatim
  'service1', 'service2',
  'what counts as emergency', 'what counts as an emergency',
  'how emergencies are routed', 'how non-emergencies are handled',
  'transfer rules', 'open questions',
  'crm or tools the client uses', 'the client company name',
  'summary or null', 'address or null', 'brief call summary',
  'days of week or null', 'start time or null', 'end time or null',
  'timezone or null', 'derived-from-company-name',
  // LLM filler phrases
  'not mentioned', 'not mentioned in this chunk', 'not specified',
  'not discussed', 'not provided', 'not confirmed', 'not available',
  'n/a', 'none', 'none mentioned', 'unknown at this time',
  'to be determined', 'tbd', 'pending',
  // Generic placeholder routing rules
  'call to service owner', 'call to backup service owner',
  'first responder', 'equipment repair', 'emergency plumber',
  'forward to owner', 'forward to service owner',
  // Clara/platform references that should never appear as client data
  'clara', 'clara ai', 'clara answers', 'clara answer',
  "phone to claire's team for immediate assistance",
  "forward to claire's team for further assistance",
  "phone to clara's team for immediate assistance",
  "forward to clara's team for further assistance",
]);

// Phrases that indicate the LLM wrote a description instead of a real value
const DESCRIPTIVE_JUNK_PATTERNS = [
  /^not mentioned/i,
  /^not specified/i,
  /^not discussed/i,
  /^not provided/i,
  /^not confirmed/i,
  /^no \w+ (was |were )?(mentioned|provided|discussed|specified|given)/i,
  /^the system will/i,
  /^the service will/i,
  /^the (ai|agent|assistant|platform) (will|can|should)/i,
  /^this (field|information|detail)/i,
  /^clara (will|can|should|is)/i,
  /^contact .* for (immediate |further )?assistance$/i,
  /^(call|phone|forward|transfer) to (clara|claire)/i,
];

function isJunkValue(val) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  const lower = trimmed.toLowerCase();
  if (JUNK_VALUES.has(lower)) return true;
  if (/^<.*>$/.test(lower)) return true;
  for (const pattern of DESCRIPTIVE_JUNK_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

// Detect values that reference Clara (the platform) instead of the client
function isClaraReference(val) {
  if (typeof val !== 'string') return false;
  const lower = val.trim().toLowerCase();
  if (/\bclara\b/i.test(lower) || /\bclaire'?s?\b/i.test(lower)) return true;
  return false;
}

// Remove duplicate services: case-insensitive, substring containment, and synonym matching
function deduplicateServices(services) {
  if (!Array.isArray(services) || services.length === 0) return services;

  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

  const kept = [];
  for (const svc of services) {
    const norm = normalize(svc);
    // Skip if a kept item already covers this one (or vice versa)
    let dominated = false;
    for (let i = 0; i < kept.length; i++) {
      const keptNorm = normalize(kept[i]);
      // If one contains the other, keep the shorter (more specific) one
      if (keptNorm.includes(norm) || norm.includes(keptNorm)) {
        if (svc.length < kept[i].length) {
          kept[i] = svc;
        }
        dominated = true;
        break;
      }
      if (keptNorm === norm) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      kept.push(svc);
    }
  }
  return kept;
}

function validateMemo(raw) {
  const memo = { ...raw };

  // --- Fix company_name if LLM put Clara ---
  const CLARA_NAMES = ['clara', 'clara answers', 'clara ai', 'clara answer'];
  if (memo.company_name && CLARA_NAMES.includes(memo.company_name.trim().toLowerCase())) {
    logger.warn(`company_name was "${memo.company_name}" (service provider). Resetting to null.`);
    memo.company_name = null;
  }

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
    // Treat string "null" as actual null
    if (typeof memo[field] === 'string' && memo[field].trim().toLowerCase() === 'null') {
      memo[field] = null;
    }
    // Treat descriptive junk as null (e.g. "Not mentioned in this chunk")
    if (typeof memo[field] === 'string' && isJunkValue(memo[field])) {
      logger.warn(`${field} contained junk value: "${memo[field]}". Setting to null.`);
      memo[field] = null;
    }
  }

  // --- Validate office_address: must look like a physical address, not a URL/email ---
  if (memo.office_address) {
    const addr = memo.office_address.trim().toLowerCase();
    if (/\.(com|net|org|io|co|ca|us)\b/i.test(addr) || addr.includes('@') || addr.startsWith('http')) {
      logger.warn(`office_address looks like a URL/email, not physical address: "${memo.office_address}". Setting to null.`);
      memo.office_address = null;
    }
  }

  if (typeof memo.notes !== 'string') {
    memo.notes = memo.notes != null ? String(memo.notes) : '';
  }
  // Truncate excessively long notes to ~3 sentences (roughly 500 chars)
  if (memo.notes.length > 500) {
    // Try to cut at a sentence boundary
    const sentences = memo.notes.match(/[^.!?]+[.!?]+/g) || [memo.notes];
    let truncated = '';
    for (const s of sentences) {
      if ((truncated + s).length > 500) break;
      truncated += s;
    }
    memo.notes = truncated.trim() || memo.notes.slice(0, 500).trim();
    logger.warn('Notes truncated to ~500 chars');
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
    memo[field] = memo[field]
      .map((v) => (typeof v === 'string' ? v : String(v)))
      .filter((v) => !isJunkValue(v) && v.trim().length > 0)
      .filter((v) => !isClaraReference(v));
  }

  // Deduplicate services (case-insensitive + substring containment)
  memo.services_supported = deduplicateServices(memo.services_supported);

  // Stringify any object values that slipped through (e.g., business_hours as object in string field)
  for (const field of nullableStrings) {
    if (memo[field] !== null && typeof memo[field] === 'object') {
      logger.warn(`${field} was an object instead of string. Setting to null.`);
      memo[field] = null;
    }
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
