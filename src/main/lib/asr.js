'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('./config');

const DEFAULT_FFMPEG = process.env.DOC_FFMPEG || 'ffmpeg';
const DEFAULT_WHISPER = process.env.DOC_WHISPER || 'whisper-cli';
const DEFAULT_MODEL = process.env.DOC_ASR_MODEL || '';

function defaultRun(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function normalizeWhisper(raw) {
  const rows = raw.transcription || raw.transcription_segments || [];
  const segments = rows.map((row, index) => {
    const start = (row.offsets && row.offsets.from != null ? row.offsets.from : 0) / 1000;
    const end = (row.offsets && row.offsets.to != null ? row.offsets.to : 0) / 1000;
    const words = Array.isArray(row.timestamps)
      ? row.timestamps.map((stamp, position) => ({
        start: stamp.from != null ? stamp.from.seconds : null,
        end: stamp.to != null ? stamp.to.seconds : null,
        text: (row.tokens && row.tokens[position] != null) ? row.tokens[position].trim() : ''
      }))
      : undefined;
    return {
      index,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      text: (row.text || '').replace(/\s+/g, ' ').trim(),
      words
    };
  });
  return {
    language: (raw.result && raw.result.language) || null,
    duration: segments.length ? segments[segments.length - 1].end : 0,
    segments
  };
}

function createAsr(options = {}) {
  const run = options.run || defaultRun;
  const config = loadConfig();
  const ffmpegPath = options.ffmpegPath || process.env.DOC_FFMPEG || config.ffmpegPath || DEFAULT_FFMPEG;
  const whisperPath = options.whisperPath || process.env.DOC_WHISPER || config.whisperPath || DEFAULT_WHISPER;
  const modelPath = options.modelPath || process.env.DOC_ASR_MODEL || config.asrModel || DEFAULT_MODEL;
  const tmpRoot = options.tmpRoot || os.tmpdir();

  async function extractAudio(srcPath, tmpDir, signal) {
    const wavPath = path.join(tmpDir, 'audio.wav');
    await run(ffmpegPath, [
      '-nostdin', '-y', '-i', srcPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      wavPath
    ], { signal });
    return wavPath;
  }

  async function runWhisper(wavPath, tmpDir, opts = {}, signal) {
    const prefix = path.join(tmpDir, 'transcript');
    await run(whisperPath, [
      '-m', opts.modelPath || modelPath,
      '-f', wavPath,
      '-ojf', '-sow',
      '-l', opts.language || 'auto',
      '-of', prefix,
      '-t', String(opts.threads || 4)
    ], { signal });
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(prefix + '.json', 'utf8'));
    } catch (_) {
      throw new Error('asr-failed');
    }
    return raw;
  }

  async function transcribeFile(srcPath, opts = {}) {
    if (!fs.existsSync(srcPath)) throw new Error('media-offline');
    if (!(opts.modelPath || modelPath)) throw new Error('asr-model-not-configured');
    const signal = opts.signal;
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'doc-asr-'));
    try {
      const wavPath = await extractAudio(srcPath, tmpDir, signal);
      const raw = await runWhisper(wavPath, tmpDir, opts, signal);
      return normalizeWhisper(raw);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  return { transcribeFile, extractAudio, runWhisper, normalizeWhisper };
}

module.exports = { createAsr, normalizeWhisper, defaultRun, DEFAULT_MODEL, DEFAULT_FFMPEG, DEFAULT_WHISPER };
