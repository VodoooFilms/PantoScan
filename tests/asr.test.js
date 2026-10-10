'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAsr, normalizeWhisper } = require('../src/main/lib/asr');

const FAKE_WHISPER_JSON = {
  result: { language: 'es' },
  transcription: [
    { offsets: { from: 0, to: 1500 }, text: ' Hola   mundo ', tokens: [], timestamps: [] },
    { offsets: { from: 1500, to: 4200 }, text: ' segunda frase', tokens: [], timestamps: [] }
  ]
};

test('normalizeWhisper converts ms offsets to seconds', () => {
  const result = normalizeWhisper(FAKE_WHISPER_JSON);
  assert.strictEqual(result.language, 'es');
  assert.strictEqual(result.segments.length, 2);
  assert.strictEqual(result.segments[0].start, 0);
  assert.strictEqual(result.segments[0].end, 1.5);
  assert.strictEqual(result.segments[0].text, 'Hola mundo');
  assert.strictEqual(result.duration, 4.2);
});

test('transcribeFile leaves no temp files behind (zero residue)', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-asr-test-'));
  const mediaPath = path.join(tmpRoot, 'clip.mov');
  fs.writeFileSync(mediaPath, 'fake-media');

  const calls = [];
  async function fakeRun(file, args) {
    calls.push({ file, args });
    const ofIndex = args.indexOf('-of');
    if (ofIndex >= 0) {
      fs.writeFileSync(args[ofIndex + 1] + '.json', JSON.stringify(FAKE_WHISPER_JSON));
    }
    if (args.includes('-i')) {
      fs.writeFileSync(args[args.length - 1], 'fake-wav');
    }
    return { stdout: '', stderr: '' };
  }

  const asr = createAsr({ run: fakeRun, tmpRoot });
  const result = await asr.transcribeFile(mediaPath);

  assert.strictEqual(result.segments.length, 2);
  assert.strictEqual(calls.filter((call) => call.file.includes('whisper')).length, 1);
  const leftovers = fs.readdirSync(tmpRoot).filter((name) => name.startsWith('doc-asr-'));
  assert.deepStrictEqual(leftovers, [], 'temp dir must be removed');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('transcribeFile fails fast when the media is offline', async () => {
  const asr = createAsr({ run: async () => ({ stdout: '', stderr: '' }), tmpRoot: os.tmpdir() });
  await assert.rejects(() => asr.transcribeFile('/no/existe/clip.mov'), /media-offline/);
});
