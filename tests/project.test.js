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
const { extractForIndex } = require('../src/main/lib/edit');
const { buildProject, writeProject, renderSelectsCsv, exportMarkdownFiles, exportSrtFiles, exportFcpxmlFiles } = require('../src/main/lib/project');

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
    { start: 0, end: 2, text: 'el buen samaritano prestó la casa' },
    { start: 2, end: 5, text: 'grabamos en cayambe con alegría' }
  ]
};

const ANALYSIS = {
  summary: 'resumen del clip',
  model: 'test-model',
  generatedAt: '2026-01-01T00:00:00.000Z',
  topics: [{ label: 'relaciones y colaboración', start: 0, end: 5, startSeg: 0, endSeg: 1, summary: 'la casa' }],
  emotions: [{ label: 'alegría', valence: 0.8, arousal: 0.6, start: 2, end: 5, startSeg: 1, endSeg: 1, evidence: 'alegría' }],
  roles: [{ role: 'gancho', start: 0, end: 2, startSeg: 0, endSeg: 0 }],
  quotes: [{ text: 'el buen samaritano prestó la casa', start: 0, end: 2, startSeg: 0, endSeg: 0 }]
};

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docproj-'));
  fs.writeFileSync(path.join(root, 'clipA.mov'), 'media');
  fs.writeFileSync(path.join(root, 'clipB.mov'), 'media');
  const store = new Store(':memory:');
  const library = createLibrary(store, { volumes: fakeVolume(root) });
  const source = library.addSource(root);
  library.scanSource(source.id);
  const queue = createQueue(store);
  const asr = { transcribeFile: () => JSON.parse(JSON.stringify(TRANSCRIPT)) };
  const analyzer = { model: 'test-model', taxonomy: { topics: [] }, analyzeTranscript: async () => JSON.parse(JSON.stringify(ANALYSIS)) };
  const outRoot = path.join(root, 'out');
  return { root, store, library, queue, asr, analyzer, outRoot };
}

async function processAll(h) {
  const pipeline = createPipeline({
    store: h.store, queue: h.queue, library: h.library,
    asr: h.asr, analyzer: h.analyzer,
    probe: () => ({ fps: 25, duration: 5 }),
    outRoot: h.outRoot
  });
  const clips = h.library.listClips();
  h.queue.enqueue(clips.map((clip) => clip.id));
  for (const clip of clips) await pipeline.processClip(clip.id);
  return clips;
}

test('extractForIndex maps edit into segments, annotations and search entries', () => {
  const edit = {
    segments: [{ index: 0, start: 0, end: 2, text: 'hola' }],
    topics: [{ label: 'tema', start: 0, end: 2, startSeg: 0, endSeg: 0, summary: 's' }],
    emotions: [{ label: 'alegría', start: 0, end: 2, startSeg: 0, endSeg: 0, valence: 0.5, arousal: 0.5, evidence: 'e' }],
    roles: [{ role: 'gancho', start: 0, end: 2, startSeg: 0, endSeg: 0 }],
    quotes: [{ text: 'hola', start: 0, end: 2, startSeg: 0, endSeg: 0 }]
  };
  const out = extractForIndex(edit);
  assert.strictEqual(out.segments.length, 1);
  assert.strictEqual(out.annotations.length, 4);
  assert.strictEqual(out.annotations.find((a) => a.kind === 'emotion').valence, 0.5);
  assert.strictEqual(out.searchEntries.length, 5);
  assert.ok(out.searchEntries.some((e) => e.section === 'quote' && e.text === 'hola'));
});

test('search finds segments, topics and emotions across every clip', async () => {
  const h = harness();
  await processAll(h);

  const byCasa = h.store.search('casa');
  assert.strictEqual(new Set(byCasa.map((row) => row.clip_id)).size, 2, 'both clips must match');
  assert.ok(byCasa.every((row) => row.clip_name), 'results carry the clip name');

  const byEmotion = h.store.search('alegría');
  assert.ok(byEmotion.some((row) => row.section === 'emotion'));

  const byTopic = h.store.search('colaboración');
  assert.ok(byTopic.some((row) => row.section === 'topic'));

  assert.deepStrictEqual(h.store.search('zzzzz'), []);

  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('buildProject aggregates clips, and backfills the index from edit.json', async () => {
  const h = harness();
  await processAll(h);

  h.store.db.exec('DELETE FROM segments; DELETE FROM annotations; DELETE FROM search_fts;');
  assert.strictEqual(h.store.search('casa').length, 0, 'index was cleared');

  const bundle = buildProject(h.store);
  assert.strictEqual(bundle.stats.clips, 2);
  assert.strictEqual(bundle.stats.topics, 1);
  assert.strictEqual(bundle.stats.emotions, 1);
  const refilled = h.store.search('casa');
  assert.strictEqual(new Set(refilled.map((row) => row.clip_id)).size, 2, 'backfill repopulated the index');

  const written = writeProject(h.outRoot, bundle);
  const markdown = fs.readFileSync(written['project-guide.md'], 'utf8');
  assert.match(markdown, /# Guía de proyecto documental/);
  assert.match(markdown, /relaciones y colaboración/);
  assert.match(fs.readFileSync(written['project-guide.html'], 'utf8'), /Mapa de emociones/);

  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('exportMarkdownFiles creates a guias-md folder with project guide and one file per clip', async () => {
  const h = harness();
  await processAll(h);
  writeProject(h.outRoot, buildProject(h.store));

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'docdest-'));
  const result = exportMarkdownFiles(h.store, h.outRoot, dest);

  assert.ok(result.folder.endsWith(path.join('', 'guias-md')) || result.folder.endsWith('guias-md'));
  const names = fs.readdirSync(result.folder);
  assert.strictEqual(names.length, 3, 'project guide plus two clips');
  assert.ok(names.includes('00_proyecto.md'));
  assert.ok(names.some((name) => /^01_.*\.md$/.test(name)));
  assert.ok(names.some((name) => /^02_.*\.md$/.test(name)));

  fs.rmSync(dest, { recursive: true, force: true });
  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('exportSrtFiles and exportFcpxmlFiles dump one file per clip into their folders', async () => {
  const h = harness();
  await processAll(h);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'docdest-'));

  const srt = exportSrtFiles(h.store, h.outRoot, dest);
  assert.strictEqual(srt.count, 2);
  assert.ok(srt.folder.endsWith('subtitulos-srt'));
  assert.ok(fs.readdirSync(srt.folder).every((name) => name.endsWith('.srt')));
  assert.match(fs.readFileSync(path.join(srt.folder, fs.readdirSync(srt.folder)[0]), 'utf8'), /-->/, 'valid SRT timing');

  const fcpxml = exportFcpxmlFiles(h.store, h.outRoot, dest);
  assert.strictEqual(fcpxml.count, 2);
  assert.ok(fcpxml.folder.endsWith('timelines-fcpxml'));

  fs.rmSync(dest, { recursive: true, force: true });
  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});

test('selects dedupe a quote and a key role that share clip and timecode', async () => {
  const h = harness();
  await processAll(h);
  const bundle = buildProject(h.store);
  const csv = renderSelectsCsv(bundle);
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines.length, 3, 'header plus one select per clip');
  assert.match(lines[1], /"el buen samaritano prestó la casa"/);
  h.store.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});
