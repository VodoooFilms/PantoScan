'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/main/lib/store');
const { createLibrary } = require('../src/main/lib/library');
const { createQueue } = require('../src/main/lib/queue');
const { createPipeline } = require('../src/main/lib/pipeline');

function fakeVolume(root) {
  const volume = { mountPoint: root, name: 'VOL', uuid: 'UUID-1', filesystem: 'APFS' };
  return {
    listMountedVolumes: () => [volume],
    volumeToRef: null,
    toRef: (candidate) => ({ volumeKey: 'UUID-1', volumeUuid: 'UUID-1', volumeName: 'VOL', relPath: path.relative(root, candidate) }),
    resolveRef: (ref) => {
      const absPath = path.join(root, ref.relPath);
      return { online: fs.existsSync(absPath), absPath, mountPoint: root };
    }
  };
}

const TRANSCRIPT = {
  language: 'es',
  duration: 5,
  segments: [
    { start: 0, end: 2, text: 'uno' },
    { start: 2, end: 5, text: 'dos' }
  ]
};

const ANALYSIS = {
  summary: 'resumen',
  model: 'test-model',
  generatedAt: '2026-01-01T00:00:00.000Z',
  topics: [{ label: 'tema', start: 0, end: 5, startSeg: 0, endSeg: 1, summary: '' }],
  emotions: [],
  roles: [{ role: 'contexto', start: 0, end: 5, startSeg: 0, endSeg: 1 }],
  quotes: []
};

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docpipe-'));
  fs.writeFileSync(path.join(root, 'clip.mov'), 'media');
  const store = new Store(':memory:');
  const library = createLibrary(store, { volumes: fakeVolume(root) });
  const source = library.addSource(root);
  library.scanSource(source.id);
  const clipId = library.listClips()[0].id;
  const queue = createQueue(store);
  queue.enqueue([clipId]);
  const counters = { asr: 0, analyze: 0 };
  const asr = { transcribeFile: () => { counters.asr += 1; return JSON.parse(JSON.stringify(TRANSCRIPT)); } };
  const makeAnalyzer = (model) => ({
    model,
    taxonomy: { topics: ['tema'] },
    analyzeTranscript: async () => { counters.analyze += 1; return { ...ANALYSIS, model }; }
  });
  const outRoot = path.join(root, 'out');
  return { root, store, library, queue, counters, asr, makeAnalyzer, outRoot, clipId };
}

test('pipeline writes all outputs and reuses transcript and analysis on rerun', async () => {
  const h = harness();
  const pipeline = createPipeline({
    store: h.store, queue: h.queue, library: h.library,
    asr: h.asr, analyzer: h.makeAnalyzer('test-model'),
    probe: () => ({ fps: 25, duration: 5, width: 1920, height: 1080 }),
    outRoot: h.outRoot
  });

  const first = await pipeline.processClip(h.clipId);
  assert.strictEqual(h.counters.asr, 1);
  assert.strictEqual(h.counters.analyze, 1);
  for (const name of ['transcript.json', 'edit.json', 'guide.md', 'guide.html', 'captions.srt', 'timeline.fcpxml', 'timeline.otio', 'markers.csv']) {
    assert.ok(fs.existsSync(path.join(first.written.dir, name)), `missing ${name}`);
  }
  const fcpxml = fs.readFileSync(path.join(first.written.dir, 'timeline.fcpxml'), 'utf8');
  assert.match(fcpxml, /file:\/\/\//, 'fcpxml must use absolute file URL');

  const second = await pipeline.processClip(h.clipId);
  assert.strictEqual(h.counters.asr, 1, 'transcript must be reused');
  assert.strictEqual(h.counters.analyze, 1, 'analysis must be reused');
  assert.strictEqual(second.reused.transcript, true);
  assert.strictEqual(second.reused.analysis, true);

  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('cancellation returns the job to pending, not error', async () => {
  const h = harness();
  const pipeline = createPipeline({
    store: h.store, queue: h.queue, library: h.library,
    asr: h.asr, analyzer: h.makeAnalyzer('test-model'),
    probe: () => ({ fps: 25, duration: 5 }),
    outRoot: h.outRoot
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => pipeline.processClip(h.clipId, { signal: controller.signal }), /cancelled/);
  assert.strictEqual(h.queue.stats().pending, 1);
  assert.strictEqual(h.queue.stats().error, 0);
  assert.strictEqual(h.counters.asr, 0);

  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('regenerateFromEdit writes edited outputs and survives a non-forced reprocess', async () => {
  const h = harness();
  const pipeline = createPipeline({
    store: h.store, queue: h.queue, library: h.library,
    asr: h.asr, analyzer: h.makeAnalyzer('test-model'),
    probe: () => ({ fps: 25, duration: 5 }),
    outRoot: h.outRoot
  });
  const first = await pipeline.processClip(h.clipId);
  const edited = { ...first.edit, summary: 'resumen editado a mano' };
  pipeline.regenerateFromEdit(h.clipId, edited);

  assert.strictEqual(h.store.getResult(h.clipId).edited, 1);
  const guide = fs.readFileSync(path.join(first.written.dir, 'guide.md'), 'utf8');
  assert.match(guide, /resumen editado a mano/);
  assert.ok(h.store.search('resumen').some((row) => row.clip_id === h.clipId), 'index refreshed from edit');

  await pipeline.processClip(h.clipId);
  assert.strictEqual(h.counters.asr, 1, 'edited result must not re-transcribe');
  assert.strictEqual(h.counters.analyze, 1, 'edited result must not re-analyze');
  assert.strictEqual(h.store.getResult(h.clipId).summary, 'resumen editado a mano', 'edit preserved');

  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('force re-runs asr, and a model change re-analyzes but reuses the transcript', async () => {
  const h = harness();
  const pipeline = createPipeline({
    store: h.store, queue: h.queue, library: h.library,
    asr: h.asr, analyzer: h.makeAnalyzer('test-model'),
    probe: () => ({ fps: 25, duration: 5 }),
    outRoot: h.outRoot
  });
  await pipeline.processClip(h.clipId);
  await pipeline.processClip(h.clipId, { force: true });
  assert.strictEqual(h.counters.asr, 2, 'force must re-transcribe');

  const pipeline2 = createPipeline({
    store: h.store, queue: h.queue, library: h.library,
    asr: h.asr, analyzer: h.makeAnalyzer('other-model'),
    probe: () => ({ fps: 25, duration: 5 }),
    outRoot: h.outRoot
  });
  await pipeline2.processClip(h.clipId);
  assert.strictEqual(h.counters.asr, 2, 'transcript must still be reused');
  assert.strictEqual(h.counters.analyze, 3, 'new model must re-analyze');

  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});
