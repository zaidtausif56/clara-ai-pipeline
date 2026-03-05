# Clara AI Pipeline

> Zero-cost automation pipeline that converts messy sales call recordings into production-ready AI voice agent configurations for [Retell](https://www.retell.ai/).

**Pipeline A:** Demo call recording/transcript → Structured account memo (v1) → Preliminary Retell agent spec  
**Pipeline B:** Onboarding call recording/transcript → Updated memo (v2) → Revised agent spec + changelog

---

## Table of Contents

- [Architecture](#architecture)
- [Data Flow](#data-flow)
- [Transcript Chunking](#transcript-chunking)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Setup Instructions](#setup-instructions)
- [Running the Pipeline](#running-the-pipeline)
- [Web Dashboard](#web-dashboard)
- [Adding New Dataset Files](#adding-new-dataset-files)
- [Output Format](#output-format)
- [Retell Integration](#retell-integration)
- [Environment Variables](#environment-variables)
- [Known Limitations](#known-limitations)
- [Production Improvements](#production-improvements)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        n8n (Docker, port 5678)                      │
│   Orchestration layer — triggers pipelines via webhook → HTTP       │
└────────────────┬────────────────────────────┬───────────────────────┘
                 │  POST /pipeline/run        │
                 ▼                            │
┌─────────────────────────────────────────────┴───────────────────────┐
│                   Node.js API Server (port 3000)                    │
│   scripts/server.js — HTTP endpoints + Web Dashboard                │
│                                                                     │
│   Pipeline:                                                         │
│     POST /pipeline/run         → batch run (all accounts)           │
│     POST /pipeline/stop        → stop current batch                 │
│     GET  /pipeline/control     → batch lock / status                │
│     POST /pipeline/demo        → single demo extraction             │
│     POST /pipeline/onboarding  → single onboarding merge            │
│     GET  /pipeline/status      → task tracker status                │
│     GET  /health               → health check                       │
│                                                                     │
│   Dashboard (served at / ):                                         │
│     GET  /ui/data/files        → list input files                   │
│     POST /ui/data/upload       → upload transcript / audio          │
│     GET  /ui/data/accounts     → list processed accounts            │
│     GET  /ui/data/diff/:id     → v1→v2 changelog for account        │
└──────┬──────────┬───────────┬──────────┬────────────┬───────────────┘
       │          │           │          │            │
       ▼          ▼           ▼          ▼            ▼
 ┌──────────┐ ┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
 │transcribe│ │ extract  │ │ merge  │ │generate│ │  diff    │
 │   .js    │ │   .js    │ │  .js   │ │Agent.js│ │   .js    │
 │          │ │          │ │        │ │        │ │          │
 │ Whisper  │ │  Ollama  │ │v1 + OB │ │ Retell │ │changelog │
 │ (audio→  │ │  LLM     │ │ = v2   │ │ agent  │ │ v1 vs v2 │
 │  text)   │ │extraction│ │        │ │ spec   │ │          │
 └──────────┘ └────┬─────┘ └────────┘ └────────┘ └──────────┘
                   │
                   ▼
          ┌────────────────┐
          │  Ollama Server │
          │ (port 11434)   │
          │ llama3.2       │
          └────────────────┘

Storage: Local JSON files in outputs/accounts/<account_id>/v1/ and v2/
Task Tracking: Local JSON tracker (outputs/tasks.json) — replaces Asana
```

### Stack (All Zero-Cost)

| Component | Purpose | Cost |
|-----------|---------|------|
| **Node.js** | Pipeline runtime, API server | Free |
| **Ollama + llama3.2** | Local LLM for transcript extraction | Free (runs locally) |
| **OpenAI Whisper** | Audio transcription (speech-to-text) | Free (open-source, runs locally) |
| **n8n** (Docker) | Workflow orchestration | Free (self-hosted) |
| **Docker** | Container runtime for n8n + Ollama | Free |
| **Local JSON files** | Storage for memos, agent specs, tasks | Free |

---

## Data Flow

### Pipeline A: Demo Call → v1 Agent

```
Demo transcript (.txt)          Demo audio (.m4a)
        │                              │
        │                     ┌────────▼─────────┐
        │                     │  Whisper (local) │
        │                     │ transcribe audio │
        │                     └────────┬─────────┘
        │                              │ .transcript.txt (cached)
        ▼                              ▼
┌───────────────────────────────────────────┐
│           Chunk transcript                │
│   (if > 10,000 chars, split into chunks   │
│    with 500-char overlap)                 │
└───────────────────┬───────────────────────┘
                    ▼
┌───────────────────────────────────────────┐
│   LLM Extraction (Ollama / llama3.2)      │
│   - Per-chunk extraction with retries     │
│   - JSON repair (handles malformed LLM    │
│     output, code fences, etc.)            │
│   - Merge chunk results (union arrays,    │
│     first-non-null scalars, dedup)        │
└───────────────────┬───────────────────────┘
                    ▼
┌───────────────────────────────────────────┐
│           Validate & Clean Memo           │
│   - Filter junk/schema-artifact values    │
│   - Flag missing critical fields in       │
│     questions_or_unknowns                 │
│   - Normalize types                       │
└───────────────────┬───────────────────────┘
                    ▼
┌──────────────────────┐    ┌──────────────────────┐
│  v1/memo.json        │    │  v1/agent.json       │
│  (structured account │───>│  (Retell agent spec  │
│   memo)              │    │   with system prompt)│
└──────────────────────┘    └──────────────────────┘
```

### Pipeline B: Onboarding → v2 Agent

```
Onboarding input (.txt / .m4a / .json form)
        │
        ▼ (transcribe if audio)
┌───────────────────────────────────────────┐
│   LLM Extraction → onboarding memo        │
└───────────────────┬───────────────────────┘
                    ▼
┌───────────────────────────────────────────┐
│   Merge: v1 memo + onboarding memo        │
│   - Onboarding overrides string fields    │
│   - Arrays are union-merged               │
│   - Conflicts are logged explicitly       │
└───────────────────┬───────────────────────┘
                    ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ v2/memo.json │  │v2/agent.json │  │ changes.json │
│ (merged)     │  │(regenerated) │  │ (field-level │
│              │  │              │  │  changelog)  │
└──────────────┘  └──────────────┘  └──────────────┘
```

---

## Transcript Chunking

### Model Choice

We use **llama3.2** (3B parameters) — a lightweight model that runs fully locally at zero cost. Combined with structured prompts, JSON repair, and junk-value filtering, it produces reliable structured extraction for our use case.

### Context Window Configuration

Ollama defaults to `num_ctx=2048` tokens to save memory. We set `num_ctx=8192` to give the model more working context per request. One token ≈ 4 characters of English text. The extraction prompt + JSON schema consumes roughly **1,500 tokens (~6,000 chars)**, leaving the rest for transcript content.

| Parameter | Value | Token Equivalent |
|-----------|-------|------------------|
| `MAX_TRANSCRIPT_CHARS` | 10,000 chars | ~2,500 tokens |
| `CHUNK_OVERLAP_CHARS` | 500 chars | ~125 tokens |
| Prompt + schema overhead | ~6,000 chars | ~1,500 tokens |
| **Total per request** | **~16,000 chars** | **~4,000 tokens** |
| `num_ctx` (Ollama) | — | **8,192 tokens** |

### How Chunking Works

1. **Split** the transcript into chunks of 10,000 characters (`MAX_TRANSCRIPT_CHARS`)
2. **Overlap** adjacent chunks by 500 characters so information at boundaries isn't lost
3. **Break at natural boundaries** — paragraph or sentence endings, not mid-word
4. **Extract independently** from each chunk (with per-chunk retry logic, up to 3 retries)
5. **Merge** chunk results: union-merge arrays (case-insensitive dedup), take first non-null scalar, combine notes
6. **Deduplicate** services by substring containment (e.g., "EV chargers" and "electric vehicle charger installation" collapse to the shorter form)

---

## Project Structure

```
clara-ai-pipeline/
├── README.md                          # This file
├── package.json                       # Project metadata and npm scripts
├── .env.example                       # Environment variable template
├── .gitignore
│
├── inputs/                            # Input files (transcripts and audio)
│   ├── demo/                          #   Demo call transcripts/recordings
│   │   └── demo-<account>.txt         #     One file per account
│   ├── onboarding/                    #   Onboarding call transcripts/recordings
│   │   ├── onboarding-<account>.txt   #     Text transcript
│   │   └── onboarding-<account>.m4a   #     Audio recording (auto-transcribed)
│   └── uploads/                       #   Temp dir for API file uploads
│
├── outputs/                           # All generated outputs
│   ├── batch_summary.json             #   Batch run summary (timing, counts, errors)
│   ├── tasks.json                     #   Task tracker state (replaces Asana)
│   └── accounts/
│       └── <account-id>/
│           ├── v1/
│           │   ├── memo.json          #   Preliminary account memo (from demo)
│           │   └── agent.json         #   Preliminary Retell agent spec
│           ├── v2/
│           │   ├── memo.json          #   Updated account memo (after onboarding)
│           │   └── agent.json         #   Updated Retell agent spec
│           └── changes.json           #   Field-level changelog (v1 → v2)
│
├── scripts/                           # Pipeline modules
│   ├── server.js                      #   HTTP API server (for n8n integration)
│   ├── runPipeline.js                 #   Batch pipeline runner (CLI + programmatic)
│   ├── extract.js                     #   LLM extraction (Ollama), chunking, validation
│   ├── generateAgent.js               #   Retell agent spec generator
│   ├── merge.js                       #   v1 + onboarding → v2 merge with conflict logging
│   ├── diff.js                        #   Changelog generator (v1 vs v2 diff)
│   ├── transcribe.js                  #   Audio transcription (Whisper integration)
│   ├── taskTracker.js                 #   Local JSON-based task tracker
│   └── logger.js                      #   Structured logging utility
│
└── workflows/                         # Orchestration configs
    ├── docker-compose.yml             #   Docker services (n8n + Ollama)
    └── n8n-workflow.json              #   n8n workflow export (importable)
```

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | v18+ | Pipeline runtime |
| **Docker** + **Docker Compose** | v20+ | n8n and Ollama containers |
| **Ollama** | v0.1+ | Local LLM inference |
| **Python 3** | 3.8+ | Required for Whisper (audio transcription only) |
| **ffmpeg** | Any | Required for Whisper audio processing |
| **OpenAI Whisper** | Latest | `pip install openai-whisper` (audio transcription only) |

> **Note:** If you only have text transcripts (`.txt` files), Python/ffmpeg/Whisper are not required.

---

## Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/zaidtausif56/clara-ai-pipeline.git
cd clara-ai-pipeline
```

### 2. Install Ollama and Pull a Model

Download Ollama from [ollama.com](https://ollama.com/download) and install it.

```bash
ollama pull llama3.2
```

Verify it's running:
```bash
ollama list
# Should show llama3.2
```

### 3. Start Docker Services (n8n + Ollama)

```bash
# Copy environment template
cp .env.example .env

# Start n8n and Ollama containers
docker compose -f workflows/docker-compose.yml up -d

# Pull the model inside Docker Ollama as well
docker exec clara-ollama ollama pull llama3.2
```

Verify:
- n8n UI: [http://localhost:5678](http://localhost:5678)
- Ollama API: [http://localhost:11434](http://localhost:11434)

### 4. Install Whisper (only if you have audio files)

```bash
pip install openai-whisper
```

Install ffmpeg:
- **Windows:** Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH, or `winget install Gyan.FFmpeg`
- **macOS:** `brew install ffmpeg`
- **Linux:** `apt install ffmpeg`

### 5. Import n8n Workflow

1. Open n8n at [http://localhost:5678](http://localhost:5678)
2. Create an account (first-time only)
3. Go to **Workflows** → **Import from File**
4. Select `workflows/n8n-workflow.json`
5. **Activate** the workflow (toggle in top-right)

### 6. Start the API Server

```bash
node scripts/server.js
# → Pipeline API server running on http://localhost:3000
```

---

## Running the Pipeline

### Option 1: Via Dashboard

The primary way to run the pipeline is through the **Web Dashboard** at `http://localhost:3000` (see [Web Dashboard](#web-dashboard) below). The dashboard lets you upload files, trigger runs, and view diffs — all from one page.


### Option 2: Via API (cURL)

```bash
# Full batch run
curl -X POST http://localhost:3000/pipeline/run

# Run demo-only or onboard-only mode
curl -X POST http://localhost:3000/pipeline/run \
  -H "Content-Type: application/json" \
  -d '{"mode": "demo-only"}'

# Check task tracker status
curl http://localhost:3000/pipeline/status

# Health check
curl http://localhost:3000/health
```

## Web Dashboard

A simple built-in UI is available for file management, batch execution, and diff viewing.

### Start

```bash
npm run server

```

Open:

- `http://localhost:3000/`
- `http://localhost:3000/ui`

### Features

1. Upload demo/onboarding transcript or audio files to the correct input folder:
  - `inputs/demo/`
  - `inputs/onboarding/`
2. List existing files in both folders and remove files directly from UI.
3. Run batch pipeline from UI in one of 3 modes:
  - Full (`demo + onboarding`)
  - `demo-only`
  - `onboard-only`
4. View account-level v1 to v2 diffs directly in UI from `outputs/accounts/<account_id>/changes.json`.
5. Concurrency lock:
  - When a batch run is active, new mutating requests are blocked (to avoid overlapping runs).
  - Use **Stop Current Run** in the UI to request stop before launching another run.

---

## Adding New Dataset Files

### File Naming Convention

The pipeline auto-matches demo and onboarding files by account name:

```
inputs/demo/demo-<account-name>.txt          →  account_id: <account-name>
inputs/onboarding/onboarding-<account-name>.txt  (matched automatically)
inputs/onboarding/onboarding-<account-name>.m4a  (matched automatically)
```

### Steps to Add New Accounts

1. Place demo transcript in `inputs/demo/`:
   ```
   inputs/demo/demo-acme-fire.txt
   ```

2. Place onboarding transcript or audio in `inputs/onboarding/`:
   ```
   inputs/onboarding/onboarding-acme-fire.txt    (text transcript)
   inputs/onboarding/onboarding-acme-fire.m4a    (audio — auto-transcribed)
   ```

3. Run the pipeline:
   ```bash
   node scripts/runPipeline.js
   ```

4. Outputs appear in `outputs/accounts/acme-fire/v1/` and `v2/`

### Custom Mapping (Optional)

For non-standard filenames, create `inputs/mapping.json`:

```json
[
  {
    "account_id": "acme-fire",
    "demo_file": "demo/custom-demo-name.txt",
    "onboarding_file": "onboarding/custom-onboarding.m4a"
  }
]
```

### Supported Formats

| Format | Type | Handling |
|--------|------|----------|
| `.txt` | Text transcript | Used directly |
| `.json` | Onboarding form | Converted to text format for extraction |
| `.m4a`, `.mp3`, `.wav`, `.webm`, `.ogg`, `.flac` | Audio | Auto-transcribed via Whisper (cached as `.transcript.txt`) |

---

## Output Format

### Account Memo (`memo.json`)

```json
{
  "account_id": "bens-electrical",
  "company_name": "Ben's Electric Solutions",
  "business_hours": {
    "days": "Monday to Friday",
    "start": "8:00 AM",
    "end": "4:30 PM",
    "timezone": "Eastern Time"
  },
  "office_address": null,
  "services_supported": ["Service calls", "EV chargers", "Panel changes", "..."],
  "emergency_definition": ["Gas station electrical emergencies via GNM Pressure Washing"],
  "emergency_routing_rules": ["After-hours GNM calls patched through to Ben"],
  "non_emergency_routing_rules": ["Take message, follow up next business day"],
  "call_transfer_rules": ["During hours: forward to Ben", "If fail: take message"],
  "integration_constraints": ["Jobber"],
  "after_hours_flow_summary": "Only GNM emergencies get patched through...",
  "office_hours_flow_summary": "Service call fee $115 + $98/hr...",
  "questions_or_unknowns": ["Ben's second phone number not yet provided"],
  "notes": "Onboarding call with Ben. Confirmed business hours..."
}
```

### Retell Agent Spec (`agent.json`)

```json
{
  "agent_name": "Clara - Ben's Electric Solutions",
  "version": "v2",
  "voice_style": "professional, warm, concise",
  "system_prompt": "You are Clara, a professional AI answering service agent for...",
  "variables": { "company_name": "...", "timezone": "...", "...": "..." },
  "tool_invocation_placeholders": [
    { "name": "transfer_call", "description": "...", "trigger": "..." },
    { "name": "create_ticket", "description": "...", "trigger": "..." },
    { "name": "lookup_on_call", "description": "...", "trigger": "..." }
  ],
  "call_transfer_protocol": { "method": "...", "rules": [], "timeout_action": "..." },
  "fallback_protocol": { "transfer_fail": "...", "system_error": "..." }
}
```

### Changelog (`changes.json`)

```json
{
  "account_id": "bens-electrical",
  "from_version": "v1",
  "to_version": "v2",
  "timestamp": "2026-03-04T20:41:04.730Z",
  "total_fields_changed": 7,
  "changes": {
    "business_hours.end": { "old": "5:00 PM", "new": "4:30 PM" },
    "services_supported": {
      "old": ["..."],
      "new": ["..."],
      "added": ["Tenant improvements"],
      "removed": []
    }
  }
}
```

---

## Retell Integration

I went through the Retell docs (starting from their `llms.txt` index) to understand how agents, prompts, and versioning work, and then used that to shape the pipeline's output format.

### Prompt Architecture — Single vs Multi-Prompt

Retell supports two prompt modes. **Single Prompt** is one system prompt that covers the entire call flow — good when the conversation is mostly linear and you only need a couple of tool calls. **Multi-Prompt** splits the agent into distinct states (greeting, qualification, routing, escalation, etc.), each with its own prompt and tools. Retell's own guidance suggests moving to multi-prompt once a single prompt stretches past ~1,000 words or uses more than 5 functions.

For this project, `v1` agents use a single prompt since the demo call only reveals a basic call flow. If the onboarding call introduces branching rules (dedicated emergency routing, separate dispatch flows, multiple transfer targets), the `v2` prompt could be restructured into multi-prompt — but for the accounts in this dataset, single prompt is sufficient.

### How to Deploy an Agent

After running the pipeline:

1. Sign up at [retell.ai](https://www.retell.ai/) and create a new agent
2. In basic settings, pick a voice, set speed, and choose agent-first or user-first initiation
3. Open the generated `agent.json` (e.g., `outputs/accounts/bens-electrical/v2/agent.json`)
4. Paste the `system_prompt` into the agent's **Prompt** section
5. Add tools in the **Functions** panel — at minimum, `transfer_call` for emergency escalation and `end_call` for clean hang-up
6. Configure transfer-call targets (E.164 phone number or SIP URI), choose cold or warm transfer, and set a timeout for unanswered transfers
7. Test in Retell's built-in web test mode, then **Publish** to create an immutable version

### Generated Prompt Structure

The `system_prompt` in `agent.json` covers two distinct flows, which map directly to Retell's prompt design best practices:

**Business Hours Flow:**
Greet caller → identify company → ask call purpose → collect name + callback number → route or transfer based on service rules → if transfer fails, take message and confirm follow-up → ask "anything else?" → close politely

**After Hours Flow:**
Greet caller → ask purpose → confirm if it's an emergency → if yes: collect name, number, address first, then attempt transfer; if transfer fails, apologize and assure follow-up → if no: capture details, confirm next-business-day callback → ask "anything else?" → close politely

Guardrails baked into the prompt: only ask necessary routing questions, never expose internal tool names to callers, keep responses short and operational.

### Versioning — v1 to v2

Retell treats published agent versions as immutable snapshots. The pipeline mirrors this:

1. `v1/agent.json` is generated from the demo call — publish this as the first Retell version
2. After the onboarding call, the pipeline produces `v2/agent.json` with updated rules and `changes.json` showing exactly what changed
3. In Retell, create a new draft from the published version, apply the `v2` prompt, compare versions side by side, and publish
4. Point the phone number to the intended version

The full Retell build playbook (prompt design checklist, function calling setup, transfer config details) lives in `docs/retell-process.md`.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API server port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `MAX_TRANSCRIPT_CHARS` | `10000` | Max chars per LLM chunk (see [Transcript Chunking](#transcript-chunking)) |
| `CHUNK_OVERLAP_CHARS` | `500` | Overlap between chunks to avoid boundary data loss |
| `WHISPER_MODEL` | `base` | Whisper model size (`tiny`, `base`, `small`, `medium`, `large`) |
| `WHISPER_LANG` | `en` | Transcription language |
| `WHISPER_MAX_RETRIES` | `2` | Retry count for Whisper transcription failures |
| `ACCOUNT_MAX_RETRIES` | `1` | Retry count for per-account pipeline failures |
| `LOG_LEVEL` | `INFO` | Log verbosity (`DEBUG`, `INFO`, `WARN`, `ERROR`) |
| `NUM_CTX` | `8192` | Ollama context window size in tokens (higher = more VRAM) |
| `PYTHON_CMD` | `python` (Win) / `python3` (Unix) | Python executable for Whisper |
| `N8N_WEBHOOK_URL` | `http://localhost:5678/` | n8n webhook base URL (used by docker-compose) |
| `N8N_EDITOR_BASE_URL` | `http://localhost:5678/` | n8n editor URL (used by docker-compose) |

---

## Known Limitations

1. **LLM extraction quality varies** — Local models (llama3.2 3B) occasionally produce schema artifacts as literal values or hallucinate details not in the transcript. The pipeline includes junk-value filtering, Clara-reference removal, and service deduplication, but is not perfect.

2. **Single-threaded processing** — Accounts are processed sequentially. Batch runs on 10+ accounts can take 30+ minutes depending on transcript length and hardware.

3. **No GPU acceleration for Whisper by default** — Whisper runs on CPU, making a 12-minute audio file take ~5 minutes to transcribe. CUDA-enabled PyTorch would significantly speed this up.

4. **No Retell API integration** — Free tier does not allow programmatic agent creation. Agent specs must be imported manually into the Retell dashboard.

5. **No persistent database** — All state is stored in local JSON files. Concurrent writes to the same account could cause race conditions.

6. **Context window limits** — The chunking system handles long transcripts, but very small chunks can lose context that spans multiple parts of a conversation. The overlap (500 chars) mitigates but does not fully solve this.

7. **No authentication on the API server** — The HTTP server is intended for local use with n8n and has no auth layer.

---

## Production Improvements

With production access and budget, the pipeline could be enhanced with:

- **GPT-4 / Claude for extraction** — Higher accuracy, fewer junk values, better contextual understanding
- **Retell API integration** — Programmatically create and update agents instead of manual import
- **PostgreSQL / Supabase** — Replace JSON files with a proper database for concurrent access and querying
- **GPU-accelerated Whisper** — Use CUDA or Whisper API for faster transcription
- **Asana / Linear integration** — Replace local task tracker with real project management tools
- **Webhook notifications** — Push status updates to Slack/email when pipelines complete or fail
- **Enhanced dashboard** — Upgrade the built-in UI with charts, real-time progress bars, and multi-user support
- **Parallel processing** — Process multiple accounts simultaneously with a job queue
- **Confidence scoring** — Rate extraction confidence per field so reviewers know what to double-check
- **Automated testing** — Test suite with known transcripts and expected outputs to catch regressions
- **Rate limiting and auth** — Secure the API server for multi-user deployment