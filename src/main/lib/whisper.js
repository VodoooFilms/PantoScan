'use strict';

/**
 * whisper.cpp engine wrapper.
 *
 * Employs the whisper-cli binary (bundled, Homebrew, or system), transcribes
 * an audio/video file to full JSON (`-oj`) with word-level timestamps, and
 * emits progress + status events while running. The GGML models are downloaded
 * on demand into the user data folder so the install stays light.
 */

const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const APP_ROOT = path.join(__dirname, '..', '..', '..');

const MODELS = {
  tiny: { file: 'ggml-tiny.bin', label: 'Tiny', size: '75 MB' },
  base: { file: 'ggml-base.bin', label: 'Base', size: '142 MB' },
  small: { file: 'ggml-small.bin', label: 'Small', size: '466 MB' },
  medium: { file: 'ggml-medium.bin', label: 'Medium', size: '1.5 GB' },
  turbo: { file: 'ggml-large-v3-turbo.bin', label: 'Turbo', size: '1.6 GB' },
  'large-v3': { file: 'ggml-large-v3.bin', label: 'Large v3', size: '3.1 GB' }
};

const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

function executableName() {
  return process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
}

function whisperBinaryCandidates() {
  const exe = executableName();
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'whisper', exe));
  candidates.push(path.join(APP_ROOT, 'build', 'whisper', exe));
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli');
  }
  return candidates;
}

function findEngine() {
  return whisperBinaryCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

function modelsDirectory() {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function modelFileCandidates(modelId) {
  const meta = MODELS[modelId];
  if (!meta) throw new Error(`Modelo desconocido: ${modelId}`);
  const candidates = [path.join(modelsDirectory(), meta.file)];
  if (!app.isPackaged) candidates.unshift(path.join(APP_ROOT, 'build', 'whisper', meta.file));
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'whisper', meta.file));
  return candidates;
}

function findModel(modelId) {
  return modelFileCandidates(modelId).find((candidate) => fs.existsSync(candidate)) || null;
}

function modelMeta(modelId) {
  return MODELS[modelId] || null;
}

function modelInfo(modelId) {
  const meta = modelMeta(modelId);
  if (!meta) return null;
  const downloadedPath = path.join(modelsDirectory(), meta.file);
  const downloaded = fs.existsSync(downloadedPath);
  const availablePath = findModel(modelId);
  return {
    id: modelId,
    label: meta.label,
    size: meta.size,
    downloaded,
    available: Boolean(availablePath),
    removable: downloaded
  };
}

function listModels() {
  return Object.keys(MODELS).map(modelInfo);
}

function downloadFile(url, destination, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const tmp = `${destination}.part`;
    let received = 0;
    let total = 0;
    fs.rmSync(tmp, { force: true });
    https.get(url, { headers: { 'User-Agent': 'panto-srt' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('Demasiadas redirecciones.'));
        const nextUrl = new URL(res.headers.location, url).toString();
        return downloadFile(nextUrl, destination, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        fs.rmSync(tmp, { force: true });
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      total = Number(res.headers['content-length']) || 0;
      const file = fs.createWriteStream(tmp);
      res.on('data', (chunk) => {
        received += chunk.length;
        file.write(chunk);
        if (onProgress && total) onProgress(Math.min(100, Math.round((received / total) * 100)));
      });
      res.on('end', () => file.end());
      file.on('finish', () => {
        fs.renameSync(tmp, destination);
        resolve();
      });
      file.on('error', (error) => {
        fs.rmSync(tmp, { force: true });
        reject(error);
      });
    }).on('error', (error) => {
      fs.rmSync(tmp, { force: true });
      reject(error);
    });
  });
}

async function downloadModel(modelId, onProgress) {
  const candidate = findModel(modelId);
  if (candidate) return candidate;
  const meta = modelMeta(modelId);
  if (!meta) throw new Error(`Modelo desconocido: ${modelId}`);
  const destination = path.join(modelsDirectory(), meta.file);
  await downloadFile(`${MODEL_HOST}/${meta.file}?download=true`, destination, onProgress);
  return destination;
}

function deleteModel(modelId) {
  const meta = modelMeta(modelId);
  if (!meta) throw new Error(`Modelo desconocido: ${modelId}`);
  const downloadedPath = path.join(modelsDirectory(), meta.file);
  if (!fs.existsSync(downloadedPath)) return false;
  fs.rmSync(downloadedPath, { force: true });
  fs.rmSync(`${downloadedPath}.part`, { force: true });
  return true;
}

function parseTimestamp(value) {
  if (typeof value === 'number') return Math.round(value * 1000) / 1000;
  if (typeof value !== 'string') return 0;
  const match = value.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return 0;
  return Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000) * 1000) / 1000;
}

function itemStart(item) {
  if (item && item.timestamps && item.timestamps.from !== undefined) return parseTimestamp(item.timestamps.from);
  return parseTimestamp(item && item.start);
}

function itemEnd(item) {
  if (item && item.timestamps && item.timestamps.to !== undefined) return parseTimestamp(item.timestamps.to);
  return parseTimestamp(item && item.end);
}

function isSpecialToken(text) {
  return /^\[_.*\]$/.test(text);
}

/**
 * Build words from the token stream. Whisper marks a new word with a leading
 * space; `-sow` may split a word across several tokens ("bien"+"venidos"), so
 * tokens without a leading space are merged onto the previous word.
 */
function tokensToWords(tokens) {
  const words = [];
  let current = null;
  for (const token of tokens) {
    const text = String(token.text || '');
    if (isSpecialToken(text)) continue;
    const startsWord = /^\s/.test(text);
    if (startsWord) {
      current = { text: text.trim(), start: itemStart(token), end: itemEnd(token) };
      words.push(current);
    } else if (current) {
      current.text += text.trim();
      current.end = itemEnd(token);
    }
  }
  return words;
}

function transcriptionArray(result) {
  if (!result) return [];
  if (Array.isArray(result.transcription)) return result.transcription;
  if (Array.isArray(result.segments)) return result.segments;
  return [];
}

function extractWords(result) {
  const items = transcriptionArray(result);
  const words = [];
  for (const item of items) {
    const tokens = Array.isArray(item.tokens) ? item.tokens : [];
    if (tokens.length && tokens.some((token) => token && token.timestamps && (token.timestamps.from !== undefined || token.timestamps.to !== undefined))) {
      words.push(...tokensToWords(tokens));
      continue;
    }
    const text = String(item.text || '').trim();
    if (text) words.push({ text, start: itemStart(item), end: itemEnd(item) });
  }
  return words;
}

function extractUtterances(result) {
  return transcriptionArray(result)
    .filter((item) => item && (item.text || '').trim())
    .map((item) => ({ start: itemStart(item), end: itemEnd(item), text: String(item.text).trim() }));
}

function detectedLanguage(result, fallback) {
  const value = result && (result.language || (result.result && result.result.language) || (result.params && result.params.language));
  return value || fallback;
}

function languageCode(language) {
  if (language === 'es' || language === 'en') return language;
  return 'auto';
}

function readyAudio(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.wav' || extension === '.mp3' || extension === '.flac') return Promise.resolve(filePath);

  return new Promise((resolve) => {
    const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((candidate) => fs.existsSync(candidate));
    if (!ffmpeg) return resolve(filePath);
    const output = path.join(os.tmpdir(), `panto-srt-${Date.now()}-${process.pid}.wav`);
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', filePath, '-ac', '1', '-ar', '16000', output], { stdio: 'ignore' });
    child.on('error', () => resolve(filePath));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(output) ? output : filePath));
  });
}

function transcribe(filePath, options = {}) {
  const modelId = options.model || 'turbo';
  const language = languageCode(options.language);
  const engine = findEngine();
  const model = findModel(modelId);

  return new Promise((resolve, reject) => {
    if (!engine) return reject(new Error('engine-missing'));
    if (!model) return reject(new Error(`model-missing:${modelId}`));

    readyAudio(filePath).then((audioFile) => {
      const outputPrefix = path.join(os.tmpdir(), `panto-srt-${Date.now()}-${process.pid}`);
      const args = [
        '-m', model,
        '-f', audioFile,
        '-of', outputPrefix,
        '-ojf',
        '-sow',
        '-l', language,
        '-t', String(Math.max(2, os.cpus().length))
      ];

      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
      const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
      let stderr = '';
      let lastPercent = -1;
      let exitCode = null;
      const duration = Number(options.duration) || 0;
      const child = spawn(engine, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const completed = new Promise((resolveCompleted) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolveCompleted(); } };

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => stepProgress(chunk));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          stderr = (stderr + chunk).slice(-8000);
          stepProgress(chunk);
        });

        function stepProgress(chunk) {
          const windows = [...chunk.matchAll(/\[(\d{2}):(\d{2}):(\d{2}[,.]\d+)? --> (\d{2}):(\d{2}):(\d{2}[,.]\d+)?\]/g)];
          for (const match of windows) {
            const end = parseTimestamp(`${match[4]}:${match[5]}:${match[6] || '00,000'}`);
            if (duration > 0 && Number(end)) {
              const percent = Math.min(99, Math.round((end / duration) * 100));
              if (percent > lastPercent) { lastPercent = percent; onProgress(percent); }
            }
          }
          const matches = chunk.matchAll(/(\d{1,3}(?:\.\d+)?)%/g);
          for (const match of matches) {
            const raw = Number(match[1]);
            if (raw <= 100) {
              const percent = Math.min(99, Math.round(raw));
              if (percent > lastPercent) { lastPercent = percent; onProgress(percent); }
            }
          }
        }

        child.on('error', (error) => { exitCode = -1; onStatus({ status: 'error', message: error.message }); finish(); });
        child.on('close', (code) => { exitCode = code; onStatus({ status: 'exited', code }); finish(); });
      });

      completed.then(async () => {
        try {
          fs.rmSync(`${outputPrefix}.wav`, { force: true });
          if (exitCode !== 0) {
            const detail = stderr.split('\n').filter(Boolean).slice(-3).join(' ');
            fs.rmSync(`${outputPrefix}.json`, { force: true });
            reject(new Error(detail || `El motor terminó con código ${exitCode}.`));
            return;
          }
          const jsonPath = `${outputPrefix}.json`;
          if (!fs.existsSync(jsonPath)) {
            reject(new Error('El motor no generó resultados.'));
            return;
          }
          const result = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          fs.rmSync(jsonPath, { force: true });
          onProgress(100);
          const utterances = extractUtterances(result);
          resolve({
            words: extractWords(result),
            utterances,
            duration: utteranceDuration(utterances),
            detectedLanguage: detectedLanguage(result, language)
          });
        } catch (error) {
          reject(error);
        }
      });

      if (options.signal) {
        const abort = () => { try { child.kill('SIGTERM'); } catch (_) {} };
        if (options.signal.aborted) abort();
        options.signal.addEventListener('abort', abort, { once: true });
      }
    });
  });
}

function utteranceDuration(utterances) {
  let end = 0;
  for (const utterance of utterances) if (utterance.end > end) end = utterance.end;
  return end;
}

module.exports = {
  findEngine,
  findModel,
  modelMeta,
  modelInfo,
  listModels,
  downloadModel,
  deleteModel,
  transcribe,
  extractWords,
  extractUtterances
};
