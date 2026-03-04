// transcribe.js - Audio file transcription (m4a -> text)
// Uses OpenAI Whisper CLI or compatible speech-to-text engine
// Supports: .m4a, .mp3, .wav, .webm audio formats

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const WHISPER_LANG = process.env.WHISPER_LANG || 'en';

// Supported audio extensions
const AUDIO_EXTENSIONS = ['.m4a', '.mp3', '.wav', '.webm', '.ogg', '.flac'];

function isAudioFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext);
}

// Check if whisper CLI is available
function isWhisperAvailable() {
  try {
    execSync('which whisper', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Check if ffmpeg is available (needed for audio conversion)
function isFfmpegAvailable() {
  try {
    execSync('which ffmpeg', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Transcribe an audio file to text using Whisper CLI.
 * Falls back to ffmpeg + Whisper if needed.
 *
 * @param {string} audioFilePath - Absolute path to the audio file
 * @param {object} options - { model, language, outputDir }
 * @returns {string} - The transcribed text
 */
async function transcribeAudio(audioFilePath, options = {}) {
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Audio file not found: ${audioFilePath}`);
  }

  const ext = path.extname(audioFilePath).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported audio format: ${ext}. Supported: ${AUDIO_EXTENSIONS.join(', ')}`);
  }

  const model = options.model || WHISPER_MODEL;
  const language = options.language || WHISPER_LANG;
  const basename = path.basename(audioFilePath, ext);
  const outputDir = options.outputDir || path.dirname(audioFilePath);

  logger.info(`Transcribing audio: ${path.basename(audioFilePath)} (model: ${model})`);

  // Strategy 1: Use Whisper CLI directly
  if (isWhisperAvailable()) {
    return transcribeWithWhisperCLI(audioFilePath, { model, language, outputDir, basename });
  }

  // Strategy 2: Use Python whisper module
  try {
    return transcribeWithPythonWhisper(audioFilePath, { model, language, outputDir, basename });
  } catch {
    // continue to next strategy
  }

  throw new Error(
    'No transcription engine available. Please install one of:\n' +
    '  1. Whisper CLI: pip install openai-whisper\n' +
    '  2. Python + whisper: pip install openai-whisper\n' +
    'Also ensure ffmpeg is installed: apt install ffmpeg / brew install ffmpeg'
  );
}

function transcribeWithWhisperCLI(audioFilePath, { model, language, outputDir, basename }) {
  const outputTxtPath = path.join(outputDir, `${basename}.txt`);

  try {
    // Run whisper CLI - outputs .txt file in the output directory
    const cmd = [
      'whisper',
      JSON.stringify(audioFilePath),
      '--model', model,
      '--language', language,
      '--output_format', 'txt',
      '--output_dir', JSON.stringify(outputDir),
    ].join(' ');

    logger.info(`Running: whisper ${path.basename(audioFilePath)} --model ${model}`);
    execSync(cmd, {
      stdio: 'pipe',
      timeout: 600000, // 10 min timeout
    });

    if (fs.existsSync(outputTxtPath)) {
      const transcript = fs.readFileSync(outputTxtPath, 'utf-8').trim();
      logger.info(`Transcription complete: ${transcript.length} chars`);
      return transcript;
    }

    throw new Error('Whisper did not produce output file');
  } catch (err) {
    if (err.message.includes('did not produce')) throw err;
    throw new Error(`Whisper CLI failed: ${err.message}`);
  }
}

function transcribeWithPythonWhisper(audioFilePath, { model, language, outputDir, basename }) {
  const outputTxtPath = path.join(outputDir, `${basename}.txt`);

  const pythonScript = `
import whisper, sys, json
model = whisper.load_model("${model}")
result = model.transcribe("${audioFilePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", language="${language}")
print(json.dumps({"text": result["text"]}))
`;

  try {
    const pythonCmd = process.env.PYTHON_CMD || 'python3';
    const result = execSync(`${pythonCmd} -c '${pythonScript.replace(/'/g, "'\\''")}'`, {
      stdio: 'pipe',
      timeout: 600000,
    });
    const parsed = JSON.parse(result.toString().trim());
    const transcript = parsed.text.trim();

    // Cache the transcript as a .txt file alongside the audio
    fs.writeFileSync(outputTxtPath, transcript, 'utf-8');
    logger.info(`Transcription complete: ${transcript.length} chars (cached to ${basename}.txt)`);

    return transcript;
  } catch (err) {
    throw new Error(`Python whisper failed: ${err.message}`);
  }
}

/**
 * Read input that could be either a text transcript or an audio file.
 * If audio, transcribe first; if text, return contents directly.
 *
 * @param {string} filePath - Path to .txt, .json, or .m4a file
 * @returns {Promise<string>} - The transcript text
 */
async function readInputWithTranscription(filePath) {
  if (isAudioFile(filePath)) {
    // Check for a cached .txt transcript alongside the audio file
    const ext = path.extname(filePath);
    const cachedTxtPath = filePath.replace(new RegExp(`\\${ext}$`), '.transcript.txt');

    if (fs.existsSync(cachedTxtPath)) {
      logger.info(`Using cached transcript: ${path.basename(cachedTxtPath)}`);
      return fs.readFileSync(cachedTxtPath, 'utf-8');
    }

    const transcript = await transcribeAudio(filePath);

    // Cache the transcript for future runs
    fs.writeFileSync(cachedTxtPath, transcript, 'utf-8');
    logger.info(`Cached transcript to: ${path.basename(cachedTxtPath)}`);

    return transcript;
  }

  // Not audio - read as text (handled by existing readInput logic)
  return null;
}

module.exports = {
  transcribeAudio,
  readInputWithTranscription,
  isAudioFile,
  isWhisperAvailable,
  isFfmpegAvailable,
  AUDIO_EXTENSIONS,
};
