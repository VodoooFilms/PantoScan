'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { applyEdits } = require('../src/main/lib/edit');

const BASE = {
  version: 1,
  asset: { id: 'c1', name: 'clip', fps: 25, duration: 10, language: 'es' },
  summary: 'original',
  counts: { segments: 2, topics: 1, emotions: 0, roles: 0, quotes: 0 },
  segments: [
    { index: 0, start: 0, end: 5, startTC: '00:00:00:00', endTC: '00:00:05:00', text: 'uno' },
    { index: 1, start: 5, end: 10, startTC: '00:00:05:00', endTC: '00:00:10:00', text: 'dos' }
  ],
  topics: [{ label: 'viejo', start: 0, end: 5, startTC: '00:00:00:00', endTC: '00:00:05:00', startSeg: 0, endSeg: 0, summary: '' }],
  emotions: [],
  roles: [],
  quotes: [],
  timeline: []
};

test('applyEdits rebuilds times, timecodes, counts and timeline', () => {
  const edited = applyEdits(BASE, {
    summary: 'resumen nuevo',
    topics: [{ label: 'tema A', start: 2, end: 7, summary: 's' }],
    emotions: [{ label: 'alegría', start: 5, end: 10, valence: 2, arousal: -1, evidence: 'e' }],
    roles: [{ role: 'gancho', start: 0, end: 2 }],
    quotes: [{ text: 'la frase', start: 6, end: 6.5 }]
  });
  assert.strictEqual(edited.summary, 'resumen nuevo');
  assert.strictEqual(edited.topics.length, 1);
  assert.strictEqual(edited.topics[0].startTC, '00:00:02:00');
  assert.strictEqual(edited.topics[0].startSeg, 0);
  assert.strictEqual(edited.topics[0].endSeg, 1);
  assert.strictEqual(edited.emotions[0].valence, 1, 'valence clamps to 1');
  assert.strictEqual(edited.emotions[0].arousal, 0, 'arousal clamps to 0');
  assert.deepStrictEqual(edited.counts, { segments: 2, topics: 1, emotions: 1, roles: 1, quotes: 1 });
  assert.strictEqual(edited.timeline.length, 3);
  assert.strictEqual(edited.timeline[0].kind, 'role');
});

test('applyEdits drops empty rows and clamps spans to the clip duration', () => {
  const edited = applyEdits(BASE, {
    topics: [{ label: '  ', start: 0, end: 1 }, { label: 'válido', start: -3, end: 99 }],
    emotions: [], roles: [], quotes: [{ text: '', start: 0, end: 1 }]
  });
  assert.strictEqual(edited.topics.length, 1);
  assert.strictEqual(edited.topics[0].start, 0);
  assert.strictEqual(edited.topics[0].end, 10);
  assert.strictEqual(edited.quotes.length, 0);
});
