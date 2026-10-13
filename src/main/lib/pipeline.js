'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createAsr } = require('./asr');
const { createAnalyzer } = require('./analysis');
const { createProbe } = require('./probe');
const { buildEdit, extractForIndex } = require('./edit');
const { renderMarkdown, renderHtml } = require('./guide');
const { buildSrt, buildVtt, buildMarkersCsv, buildFcpxml, buildOtio } = require('./exports');

function hash(...parts) {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 20);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function isAbort(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'CanceledError') return true;
  return /abort|cancel/i.test(error.message || '');
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const error = new Error('cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

function createPipeline(options = {}) {
  const store = options.store;
  const queue = options.queue;
  const library = options.library;
  const asr = options.asr || createAsr();
  const analyzer = options.analyzer || createAnalyzer();
  const probe = options.probe || createProbe();
  let outRoot = options.outRoot || path.join(process.cwd(), 'out');
  const now = options.now || (() => Date.now());
  const logger = options.logger || (() => {});
  const asrSignature = options.asrSignature || 'whisper-large-v3-turbo';
  const taxonomyTag = JSON.stringify(analyzer.taxonomy || {});

  function setOutRoot(newRoot) {
    if (typeof newRoot === 'string' && newRoot) {
      outRoot = newRoot;
    }
    return outRoot;
  }

  function asrFingerprint(clip, language) {
    const vad = (asr.vadModelPath && fs.existsSync(asr.vadModelPath)) ? `vad:${path.basename(asr.vadModelPath)}:${asr.vadThreshold ?? ''}` : 'vad:none';
    return hash('asr:v2', asrSignature, language || 'auto', vad, clip.size, clip.mtime);
  }

  function analysisFingerprint(asrFp) {
    return hash('analysis:v1', asrFp, analyzer.model || 'model', taxonomyTag);
  }

  function artifacts(edit, meta = {}) {
    const width = meta.width != null ? meta.width : (edit.asset && edit.asset.width);
    const height = meta.height != null ? meta.height : (edit.asset && edit.asset.height);
    return {
      'edit.json': JSON.stringify(edit, null, 2),
      'guide.md': renderMarkdown(edit),
      'guide.html': renderHtml(edit),
      'captions.srt': buildSrt(edit),
      'captions.vtt': buildVtt(edit),
      'markers.csv': buildMarkersCsv(edit),
      'timeline.fcpxml': buildFcpxml(edit, { width, height }),
      'timeline.otio': buildOtio(edit)
    };
  }

  function writeOut(clipId, files) {
    const dir = path.join(outRoot, clipId);
    fs.mkdirSync(dir, { recursive: true });
    const written = {};
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      fs.writeFileSync(target, content);
      written[name] = target;
    }
    written.dir = dir;
    return written;
  }

  async function processClip(clipId, hooks = {}) {
    const emit = (state, extra) => {
      if (hooks.onState) hooks.onState(state, extra);
      logger(`[${clipId}] ${state}`, extra || '');
    };

    const decorated = library.listClips().find((clip) => clip.id === clipId);
    if (!decorated) throw new Error('clip-not-found');
    if (!decorated.online) throw new Error('media-offline');

    const relClip = {
      id: decorated.id,
      name: decorated.name,
      relPath: decorated.relPath,
      absPath: decorated.absPath,
      volumeName: decorated.volumeName,
      mediaType: decorated.mediaType
    };

    const force = Boolean(hooks.force);
    const previous = store.getResult(clipId);
    const outDir = path.join(outRoot, clipId);
    const asrFp = asrFingerprint(decorated, (hooks.asr || {}).language);
    const analysisFp = analysisFingerprint(asrFp);
    const reused = { transcript: false, analysis: false };

    if (!force && previous && previous.edited && previous.asr_fingerprint === asrFp && previous.analysis_fingerprint === analysisFp) {
      const prior = readJson(path.join(outDir, 'edit.json'));
      if (prior) {
        store.saveExtraction(clipId, extractForIndex(prior));
        queue.setState(clipId, 'done', { progress: 100 });
        emit('done', 'edición humana');
        return { edit: prior, written: { dir: outDir }, transcript: null, analysis: null, reused: { transcript: true, analysis: true, edited: true } };
      }
    }

    try {
      throwIfAborted(hooks.signal);
      queue.setState(clipId, 'transcribing', { progress: 10 });
      let transcript = null;
      if (!force && previous && previous.asr_fingerprint === asrFp) {
        transcript = readJson(path.join(outDir, 'transcript.json'));
      }
      if (transcript) {
        reused.transcript = true;
        emit('transcribing', 'reutilizada');
      } else {
        emit('transcribing');
        transcript = await asr.transcribeFile(decorated.absPath, { ...(hooks.asr || {}), signal: hooks.signal });
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'transcript.json'), JSON.stringify(transcript, null, 2));
      }
      throwIfAborted(hooks.signal);

      queue.setState(clipId, 'analyzing', { progress: 45 });
      let analysis = null;
      if (reused.transcript && !force && previous && previous.analysis_fingerprint === analysisFp) {
        const prior = readJson(path.join(outDir, 'edit.json'));
        if (prior) {
          analysis = {
            summary: prior.summary, model: prior.model, generatedAt: prior.generatedAt,
            topics: prior.topics, emotions: prior.emotions, roles: prior.roles, quotes: prior.quotes
          };
        }
      }
      if (analysis) {
        reused.analysis = true;
        emit('analyzing', 'reutilizado');
      } else if (!(transcript.segments || []).length) {
        emit('analyzing', 'sin diálogo');
        analysis = {
          summary: 'Sin diálogo detectado.',
          topics: [], emotions: [], roles: [], quotes: [],
          model: null, generatedAt: new Date().toISOString()
        };
      } else {
        emit('analyzing');
        analysis = await analyzer.analyzeTranscript(transcript, {
          signal: hooks.signal,
          onProgress: (offset) => logger(`[${clipId}] análisis ventana @${offset}`)
        });
      }
      throwIfAborted(hooks.signal);

      queue.setState(clipId, 'exporting', { progress: 80 });
      emit('exporting', reused.transcript && reused.analysis ? 'reutilizado' : '');
      let meta = { fps: 25, duration: transcript.duration, width: null, height: null };
      try { meta = { ...meta, ...probe(decorated.absPath) }; } catch (_) {}

      const asset = { ...relClip, fps: meta.fps, duration: meta.duration };
      const edit = buildEdit({ asset, transcript, analysis });

      const written = writeOut(clipId, {
        'transcript.json': JSON.stringify(transcript, null, 2),
        ...artifacts(edit, meta)
      });

      store.saveResult({
        clipId,
        outDir: written.dir,
        editPath: written['edit.json'],
        guidePath: written['guide.md'],
        summary: edit.summary,
        asrFingerprint: asrFp,
        analysisFingerprint: analysisFp,
        fps: meta.fps,
        edited: false,
        updatedAt: now()
      });
      store.saveExtraction(clipId, extractForIndex(edit));

      queue.setState(clipId, 'done', { progress: 100 });
      emit('done', written);
      return { edit, written, transcript, analysis, reused };
    } catch (error) {
      if (isAbort(error)) {
        queue.setState(clipId, 'pending', { progress: 0 });
        emit('cancelled');
        const cancelled = new Error('cancelled');
        cancelled.name = 'AbortError';
        throw cancelled;
      }
      queue.setState(clipId, 'error', { error: error.message });
      emit('error', error.message);
      throw error;
    }
  }

  async function drain(hooks = {}) {
    const processed = [];
    for (;;) {
      const claimed = queue.claimNext();
      if (!claimed) break;
      try {
        const result = await processClip(claimed.clip_id, hooks);
        processed.push({ clipId: claimed.clip_id, ok: true, outDir: result.written.dir });
      } catch (error) {
        processed.push({ clipId: claimed.clip_id, ok: false, error: error.message });
      }
      if (hooks.onDrained) hooks.onDrained(processed[processed.length - 1]);
    }
    return processed;
  }

  function regenerateFromEdit(clipId, edit) {
    const previous = store.getResult(clipId);
    const written = writeOut(clipId, artifacts(edit));
    store.saveResult({
      clipId,
      outDir: written.dir,
      editPath: written['edit.json'],
      guidePath: written['guide.md'],
      summary: edit.summary,
      asrFingerprint: previous ? previous.asr_fingerprint : null,
      analysisFingerprint: previous ? previous.analysis_fingerprint : null,
      fps: edit.asset ? edit.asset.fps : null,
      edited: true,
      updatedAt: now()
    });
    store.saveExtraction(clipId, extractForIndex(edit));
    return written;
  }

  return { processClip, drain, writeOut, regenerateFromEdit, artifacts, setOutRoot, get outRoot() { return outRoot; } };
}

module.exports = { createPipeline };
