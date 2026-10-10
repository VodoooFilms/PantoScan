'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildEdit } = require('../src/main/lib/edit');
const { buildSrt, buildVtt, buildMarkersCsv, buildFcpxml, buildOtio } = require('../src/main/lib/exports');

function sampleEdit() {
  const transcript = {
    language: 'es',
    duration: 5,
    segments: [
      { start: 0, end: 2, text: 'Hola mundo' },
      { start: 2, end: 5, text: 'Adios mundo' }
    ]
  };
  const analysis = {
    summary: 'resumen',
    model: 'modelo',
    generatedAt: '2026-01-01T00:00:00.000Z',
    topics: [{ label: 'tema uno', start: 0, end: 5, startSeg: 0, endSeg: 1, summary: 'r' }],
    emotions: [{ label: 'alegría', valence: 0.5, arousal: 0.6, evidence: 'yay', start: 0, end: 2, startSeg: 0, endSeg: 0 }],
    roles: [{ role: 'contexto', start: 0, end: 5, startSeg: 0, endSeg: 1 }],
    quotes: [{ text: 'Hola mundo', start: 0, end: 2, startSeg: 0, endSeg: 0 }]
  };
  const asset = {
    id: 'a1', name: 'clip.mov', relPath: 'Users/x/clip.mov', absPath: '/Users/x/clip.mov',
    volumeName: 'VOL', mediaType: 'video', fps: 25, duration: 5
  };
  return buildEdit({ asset, transcript, analysis });
}

test('fcpxml references media with a valid absolute file URL', () => {
  const xml = buildFcpxml(sampleEdit());
  assert.match(xml, /src="file:\/\/\/Users\/x\/clip\.mov"/);
  assert.doesNotMatch(xml, /file:\/\/Users/);
  assert.match(xml, /<marker /);
});

test('otio references media with a valid absolute file URL', () => {
  const otio = JSON.parse(buildOtio(sampleEdit()));
  const clip = otio.tracks.children[0].children[0];
  assert.strictEqual(clip.media_reference.target_url, 'file:///Users/x/clip.mov');
  assert.ok(clip.markers.length >= 1);
  assert.strictEqual(otio.OTIO_SCHEMA, 'Timeline.1');
});

test('srt and vtt are well formed', () => {
  const edit = sampleEdit();
  const srt = buildSrt(edit);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\nHola mundo/);
  const vtt = buildVtt(edit);
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000 --> 00:00:02\.000/);
});

test('markers.csv has a header and one row per annotation', () => {
  const csv = buildMarkersCsv(sampleEdit()).trim().split('\n');
  assert.strictEqual(csv[0], 'kind,label,start_tc,end_tc,start_seconds,duration_seconds,color,note');
  assert.strictEqual(csv.length, 4);
  assert.ok(csv.some((row) => row.startsWith('role,contexto,')));
});
