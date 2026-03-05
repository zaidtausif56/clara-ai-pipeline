// transcribe.js - Audio file transcription (m4a -> text)
// Uses OpenAI Whisper CLI or compatible speech-to-text engine
// Supports: .m4a, .mp3, .wav, .webm audio formats

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const WHISPER_LANG = process.env.WHISPER_LANG || 'en';
const WHISPER_MAX_RETRIES = parseInt(process.env.WHISPER_MAX_RETRIES, 10) || 2;

const AUDIO_EXTENSIONS = ['.m4a', '.mp3', '.wav', '.webm', '.ogg', '.flac'];

function isAudioFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext);
}

// Check if a command is available (cross-platform)
function isCommandAvailable(cmd) {
  try {
    const check = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isWhisperAvailable() {
  return isCommandAvailable('whisper');
}

function isFfmpegAvailable() {
  return isCommandAvailable('ffmpeg');
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

  // Determine which transcription strategy to use
  let transcribeFn = null;
  let transcribeArgs = null;

  if (isWhisperAvailable()) {
    transcribeFn = transcribeWithWhisperCLI;
    transcribeArgs = { model, language, outputDir, basename };
  } else {
    const pythonCmd = process.platform === 'win32' ? 'python' : (process.env.PYTHON_CMD || 'python3');
    try {
      execSync(`${pythonCmd} -c "import whisper"`, { stdio: 'pipe' });
      transcribeFn = transcribeWithPythonWhisper;
      transcribeArgs = { model, language, outputDir, basename, pythonCmd };
    } catch {
      // no engine available
    }
  }

  if (!transcribeFn) {
    throw new Error(
      'No transcription engine available. Please install one of:\n' +
      '  1. Whisper CLI: pip install openai-whisper\n' +
      '  2. Python + whisper: pip install openai-whisper\n' +
      'Also ensure ffmpeg is installed.\n' +
      '  Windows: winget install Gyan.FFmpeg  OR  choco install ffmpeg\n' +
      '  Linux: apt install ffmpeg\n' +
      '  Mac: brew install ffmpeg'
    );
  }

  // Retry loop for transient transcription failures
  let lastError = null;
  for (let attempt = 0; attempt <= WHISPER_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = 2000 * attempt;
        logger.warn(`Whisper retry ${attempt}/${WHISPER_MAX_RETRIES} after ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
      return transcribeFn(audioFilePath, transcribeArgs);
    } catch (err) {
      lastError = err;
      logger.error(`Whisper attempt ${attempt} failed: ${err.message}`);
    }
  }
  throw new Error(`Transcription failed after ${WHISPER_MAX_RETRIES + 1} attempts: ${lastError?.message}`);
}

function transcribeWithWhisperCLI(audioFilePath, { model, language, outputDir, basename }) {
  const outputTxtPath = path.join(outputDir, `${basename}.txt`);

  try {
    // Use proper quoting for paths with spaces (Windows and Unix)
    const quotedAudio = `"${audioFilePath}"`;
    const quotedOutDir = `"${outputDir}"`;

    const cmd = `whisper ${quotedAudio} --model ${model} --language ${language} --output_format txt --output_dir ${quotedOutDir}`;

    logger.info(`Running: ${cmd}`);
    const result = execSync(cmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600000, // 10 min timeout
      cwd: outputDir,  // Set working directory to output location as fallback
      maxBuffer: 50 * 1024 * 1024,
    });

    if (result && result.toString().trim()) {
      logger.debug(`Whisper stdout: ${result.toString().substring(0, 500)}`);
    }

    // Check for the expected output file
    if (fs.existsSync(outputTxtPath)) {
      const transcript = fs.readFileSync(outputTxtPath, 'utf-8').trim();
      logger.info(`Transcription complete: ${transcript.length} chars`);
      return transcript;
    }

    // Fallback: search for any matching .txt file whisper may have created
    const possibleFiles = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.txt') && f.startsWith(basename))
      .map(f => path.join(outputDir, f));

    if (possibleFiles.length > 0) {
      logger.info(`Found whisper output at: ${possibleFiles[0]}`);
      const transcript = fs.readFileSync(possibleFiles[0], 'utf-8').trim();
      // Copy to expected location if different
      if (possibleFiles[0] !== outputTxtPath) {
        fs.copyFileSync(possibleFiles[0], outputTxtPath);
      }
      logger.info(`Transcription complete: ${transcript.length} chars`);
      return transcript;
    }

    // Also check CWD in case whisper ignored --output_dir
    const cwdOutput = path.join(process.cwd(), `${basename}.txt`);
    if (fs.existsSync(cwdOutput)) {
      logger.info(`Found whisper output in CWD, moving to: ${outputTxtPath}`);
      fs.copyFileSync(cwdOutput, outputTxtPath);
      fs.unlinkSync(cwdOutput);
      const transcript = fs.readFileSync(outputTxtPath, 'utf-8').trim();
      logger.info(`Transcription complete: ${transcript.length} chars`);
      return transcript;
    }

    const allFiles = fs.readdirSync(outputDir);
    logger.error(`Expected output: ${outputTxtPath}`);
    logger.error(`Files in output dir: ${allFiles.join(', ')}`);
    throw new Error(`Whisper did not produce output file. Expected: ${outputTxtPath}`);
  } catch (err) {
    if (err.message.includes('did not produce')) throw err;
    if (err.stderr) {
      logger.error(`Whisper stderr: ${err.stderr.toString().substring(0, 1000)}`);
    }
    throw new Error(`Whisper CLI failed: ${err.message}`);
  }
}

function transcribeWithPythonWhisper(audioFilePath, { model, language, outputDir, basename, pythonCmd }) {
  const outputTxtPath = path.join(outputDir, `${basename}.txt`);
  const cmd = pythonCmd || (process.platform === 'win32' ? 'python' : (process.env.PYTHON_CMD || 'python3'));

  // Use a temp script file instead of -c to avoid shell quoting issues on Windows
  const escapedAudioPath = audioFilePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const pythonScript = [
    'import whisper, json',
    `model = whisper.load_model("${model}")`,
    `result = model.transcribe("${escapedAudioPath}", language="${language}")`,
    'print(json.dumps({"text": result["text"]}))',
  ].join('\n');

  const tmpScript = path.join(outputDir, '_whisper_transcribe.py');

  try {
    fs.writeFileSync(tmpScript, pythonScript, 'utf-8');
    logger.info(`Running Python whisper via: ${cmd} ${tmpScript}`);

    const result = execSync(`${cmd} "${tmpScript}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600000,
      cwd: outputDir,
      maxBuffer: 50 * 1024 * 1024,
    });
    const parsed = JSON.parse(result.toString().trim());
    const transcript = parsed.text.trim();

    // Cache the transcript as a .txt file alongside the audio
    fs.writeFileSync(outputTxtPath, transcript, 'utf-8');
    logger.info(`Transcription complete: ${transcript.length} chars (cached to ${basename}.txt)`);

    return transcript;
  } catch (err) {
    if (err.stderr) {
      logger.error(`Python whisper stderr: ${err.stderr.toString().substring(0, 1000)}`);
    }
    throw new Error(`Python whisper failed: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
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
