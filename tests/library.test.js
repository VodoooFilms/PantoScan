'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/main/lib/store');
const { createLibrary } = require('../src/main/lib/library');
const { createQueue, fingerprintFor } = require('../src/main/lib/queue');

function makeFakeVolume(root, online = true) {
  const volume = { mountPoint: root, name: 'TESTVOL', uuid: 'TESTUUID-0001', filesystem: 'APFS' };
  return {
    listMountedVolumes: () => (online ? [volume] : []),
    volumeForPath: (candidate) => (online && candidate.startsWith(root) ? volume : null),
    toRef: (candidate) => ({
      volumeKey: 'TESTUUID-0001',
      volumeUuid: 'TESTUUID-0001',
      volumeName: 'TESTVOL',
      relPath: path.relative(root, candidate)
    }),
    resolveRef: (ref) => {
      if (!online) return { online: false, absPath: null, mountPoint: null };
      const absPath = path.join(root, ref.relPath);
      return { online: fs.existsSync(absPath), absPath, mountPoint: root };
    }
  };
}

function makeTree(root) {
  fs.mkdirSync(path.join(root, 'VIDEO', 'cam'), { recursive: true });
  fs.mkdirSync(path.join(root, 'AUDIO'), { recursive: true });
  fs.mkdirSync(path.join(root, '.Spotlight-V100'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Adobe Premiere Pro Auto-Save'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VIDEO', 'cam', 'SHOGUN_S001_T001.MOV'), 'a');
  fs.writeFileSync(path.join(root, 'VIDEO', 'cam', 'SHOGUN_S001_T002.MOV'), 'bb');
  fs.writeFileSync(path.join(root, 'AUDIO', 'ambience.wav'), 'ccc');
  fs.writeFileSync(path.join(root, 'VIDEO', 'notes.txt'), 'ignore');
  fs.writeFileSync(path.join(root, '.Spotlight-V100', 'junk.mov'), 'ignore');
  fs.writeFileSync(path.join(root, 'Adobe Premiere Pro Auto-Save', 'auto.mov'), 'ignore');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'types.d.ts'), 'ignore');
  fs.writeFileSync(path.join(root, 'VIDEO', 'captions.d.ts'), 'ignore');
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doclib-'));
}

test('addSource deduplicates the same folder by volume identity', () => {
  const root = tmpRoot();
  makeTree(root);
  const store = new Store(':memory:');
  const library = createLibrary(store, { volumes: makeFakeVolume(root) });

  const first = library.addSource(path.join(root, 'VIDEO'));
  const second = library.addSource(path.join(root, 'VIDEO'));
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(library.listSources().length, 1);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('scanSource finds only supported media and skips junk directories', () => {
  const root = tmpRoot();
  makeTree(root);
  const store = new Store(':memory:');
  const library = createLibrary(store, { volumes: makeFakeVolume(root) });
  const source = library.addSource(root);

  const result = library.scanSource(source.id);
  assert.strictEqual(result.total, 3, 'expected 3 media files');
  const names = library.listClips().map((clip) => clip.name).sort();
  assert.deepStrictEqual(names, ['SHOGUN_S001_T001.MOV', 'SHOGUN_S001_T002.MOV', 'ambience.wav']);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('rescans are idempotent and do not duplicate clips', () => {
  const root = tmpRoot();
  makeTree(root);
  const store = new Store(':memory:');
  const library = createLibrary(store, { volumes: makeFakeVolume(root) });
  const source = library.addSource(root);

  library.scanSource(source.id);
  const second = library.scanSource(source.id);
  assert.strictEqual(second.added, 0);
  assert.strictEqual(second.updated, 3);
  assert.strictEqual(store.countClips(), 3);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('rescans drop clips whose files disappeared', () => {
  const root = tmpRoot();
  makeTree(root);
  const store = new Store(':memory:');
  const library = createLibrary(store, { volumes: makeFakeVolume(root) });
  const source = library.addSource(root);
  library.scanSource(source.id);

  fs.rmSync(path.join(root, 'VIDEO', 'cam', 'SHOGUN_S001_T002.MOV'));
  const result = library.scanSource(source.id);
  assert.strictEqual(result.removed, 1);
  assert.strictEqual(store.countClips(), 2);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('clips resolve offline when the volume is unmounted, and online again after', () => {
  const root = tmpRoot();
  makeTree(root);
  const store = new Store(':memory:');
  const online = makeFakeVolume(root, true);
  const library = createLibrary(store, { volumes: online });
  const source = library.addSource(root);
  library.scanSource(source.id);

  const offlineLibrary = createLibrary(store, { volumes: makeFakeVolume(root, false) });
  const offlineSummary = offlineLibrary.summary();
  assert.strictEqual(offlineSummary.clips, 3);
  assert.strictEqual(offlineSummary.clipsOffline, 3);
  assert.strictEqual(offlineSummary.clipsOnline, 0);

  assert.strictEqual(library.summary().clipsOnline, 3);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('queue enqueues, claims and advances jobs with idempotent fingerprints', () => {
  const root = tmpRoot();
  makeTree(root);
  const store = new Store(':memory:');
  const library = createLibrary(store, { volumes: makeFakeVolume(root) });
  const source = library.addSource(root);
  library.scanSource(source.id);
  const queue = createQueue(store);
  const clipIds = library.listClips().map((clip) => clip.id);

  assert.strictEqual(queue.enqueue(clipIds), 3);
  assert.strictEqual(queue.stats().pending, 3);

  const job = queue.claimNext();
  assert.strictEqual(job.state, 'transcribing');
  assert.strictEqual(job.attempts, 1);
  assert.strictEqual(queue.stats().transcribing, 1);
  assert.strictEqual(queue.stats().pending, 2);

  const clip = library.listClips().find((item) => item.id === job.clip_id);
  assert.strictEqual(queue.isUpToDate(clip, 'default'), false);
  queue.setState(job.clip_id, 'done', { progress: 100 });
  assert.strictEqual(queue.isUpToDate(clip, 'default'), true);
  assert.ok(fingerprintFor(clip, 'default').startsWith('1:default:'));
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('requeueStale recovers jobs stranded in running states', () => {
  const root = tmpRoot();
  makeTree(root);
  const store = new Store(':memory:');
  const library = createLibrary(store, { volumes: makeFakeVolume(root) });
  const source = library.addSource(root);
  library.scanSource(source.id);
  const queue = createQueue(store);
  const [first, second] = library.listClips().map((clip) => clip.id);

  queue.enqueue([first, second]);
  queue.claimNext();
  queue.setState(first, 'analyzing');
  assert.strictEqual(queue.stats().analyzing, 1);

  const recovered = queue.requeueStale();
  assert.ok(recovered >= 1);
  assert.strictEqual(queue.stats().analyzing, 0);
  assert.strictEqual(queue.stats().pending, 2);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});
