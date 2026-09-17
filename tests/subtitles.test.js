'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildClips, normalizeWords } = require('../src/main/lib/grouping');
const { buildSrt, secondsToSrt } = require('../src/main/lib/formats/srt');
const { buildFcpxml } = require('../src/main/lib/formats/fcpxml');
const { extractWords, extractUtterances } = require('../src/main/lib/whisper');

const DEFAULT = { maxChars: 42, maxDuration: 3.5, minGap: 0.2 };

function word(text, start, end) {
  return { text, start, end };
}

test('normalizeWords attaches punctuation tokens to the previous word', () => {
  const words = normalizeWords([
    { text: 'Hola', start: 0, end: 0.4 },
    { text: ',', start: 0.4, end: 0.45 },
    { text: 'mundo', start: 0.45, end: 1.0 }
  ]);
  assert.equal(words.length, 2);
  assert.equal(words[0].text, 'Hola,');
});

test('buildClips respects maxChars per clip', () => {
  const words = [];
  let time = 0;
  for (const w of 'una frase larga que deberia dividirse en varios clips'.split(' ')) {
    words.push(word(w, time, time + 0.4));
    time += 0.4;
  }
  const clips = buildClips(words, { ...DEFAULT, maxChars: 18, minGap: 0 });
  assert.ok(clips.length > 1);
  for (const clip of clips) assert.ok(clip.text.length <= 19, `clip over limit: "${clip.text}"`);
});

test('buildClips respects maxDuration', () => {
  const clips = buildClips([
    word('uno', 0, 0.3),
    word('dos', 0.3, 0.6),
    word('tres', 0.6, 0.9),
    word('cuatro', 0.9, 1.2),
    word('cinco', 1.2, 1.5),
    word('seis', 1.5, 1.8),
    word('siete', 1.8, 2.1)
  ], { ...DEFAULT, maxChars: 200, minGap: 0, maxDuration: 0.9 });
  assert.ok(clips.length >= 3);
  for (const clip of clips) assert.ok(clip.end - clip.start <= 0.9 + 1e-9, `clip too long: ${clip.text}`);
});

test('buildClips splits on a clear pause (minGap)', () => {
  const clips = buildClips([
    word('Hola', 0, 0.5),
    word('señores', 0.5, 1.0),
    word('gracias', 1.8, 2.3)   // 0.8s pause after "señores"
  ], { ...DEFAULT, maxChars: 200, maxDuration: 20, minGap: 0.2 });
  assert.equal(clips.length, 2);
  assert.equal(clips[0].text, 'Hola señores');
  assert.equal(clips[1].text, 'gracias');
});

test('buildClips prefers a sentence boundary when mature', () => {
  const clips = buildClips([
    word('Este', 0, 0.3),
    word('es', 0.3, 0.6),
    word('un', 0.6, 0.9),
    word('titular.', 0.9, 1.2),
    word('Y', 1.2, 1.5),
    word('esto', 1.5, 1.8)
  ], { ...DEFAULT, maxChars: 200, maxDuration: 20, minGap: 1 });
  assert.equal(clips.length, 2);
  assert.equal(clips[0].text, 'Este es un titular.');
  assert.equal(clips[1].text, 'Y esto');
});

test('buildClips trims stray whitespace and produces indexed clips', () => {
  const clips = buildClips([
    word('  hola  ', 0, 0.4),
    word('mundo', 0.4, 0.9)
  ], DEFAULT);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].text, 'hola mundo');
  assert.equal(clips[0].index, 1);
  assert.equal(clips[0].start, 0);
  assert.equal(clips[0].end, 0.9);
});

test('buildClips never drops spoken content across long silences', () => {
  const clips = buildClips([
    word('a', 0, 0.1),
    word('b', 0.1, 0.19),
    word('c', 3.0, 3.4)
  ], { ...DEFAULT, maxChars: 200, maxDuration: 20, minGap: 0.2 });
  assert.equal(clips.length, 2);
  assert.equal(clips[0].text, 'a b');
  assert.equal(clips[1].text, 'c');
});

test('extractWords handles whisper.cpp v1.9 JSON (transcription) with sub-word tokens', () => {
  const result = {
    transcription: [{
      text: ' Hola bienvenidos al tutorial de hoy.',
      timestamps: { from: '00:00:00,000', to: '00:00:05,120' },
      offsets: { from: 0, to: 5120 },
      tokens: [
        { text: '[_BEG_]', timestamps: { from: '00:00:00,000', to: '00:00:00,000' } },
        { text: ' Hola', timestamps: { from: '00:00:00,010', to: '00:00:00,260' } },
        { text: ' bien', timestamps: { from: '00:00:00,260', to: '00:00:00,500' } },
        { text: 'venidos', timestamps: { from: '00:00:00,540', to: '00:00:00,980' } },
        { text: ' al', timestamps: { from: '00:00:00,980', to: '00:00:01,110' } },
        { text: ' tutorial', timestamps: { from: '00:00:01,110', to: '00:00:01,640' } },
        { text: ' hoy.', timestamps: { from: '00:00:04,900', to: '00:00:05,090' } },
        { text: '[_TT_256]', timestamps: { from: '00:00:05,120', to: '00:00:05,120' } }
      ]
    }]
  };
  const words = extractWords(result);
  assert.deepEqual(words, [
    { text: 'Hola', start: 0.01, end: 0.26 },
    { text: 'bienvenidos', start: 0.26, end: 0.98 },
    { text: 'al', start: 0.98, end: 1.11 },
    { text: 'tutorial', start: 1.11, end: 1.64 },
    { text: 'hoy.', start: 4.9, end: 5.09 }
  ]);
  assert.equal(extractUtterances(result)[0].text, 'Hola bienvenidos al tutorial de hoy.');
});

test('extractWords falls back to segment text when tokens lack timestamps', () => {
  const result = { transcription: [
    { text: ' Solo texto.', timestamps: { from: '00:00:01,000', to: '00:00:02,500' } }
  ] };
  assert.deepEqual(extractWords(result), [{ text: 'Solo texto.', start: 1, end: 2.5 }]);
});

test('secondsToSrt formats a timestamp', () => {
  assert.equal(secondsToSrt(0), '00:00:00,000');
  assert.equal(secondsToSrt(65.5), '00:01:05,500');
  assert.equal(secondsToSrt(3661.007), '01:01:01,007');
});

test('buildSrt produces numbered cues with the given offset', () => {
  const clips = [{ start: 0, end: 1.25, text: 'Hola' }, { start: 2, end: 3.5, text: 'Mundo' }];
  const srt = buildSrt(clips, 3600);
  assert.match(srt, /^1\n01:00:00,000 --> 01:00:01,250\nHola\n\n2\n01:00:02,000 --> 01:00:03,500\nMundo\n$/);
});

test('buildSrt skips empty cues', () => {
  const srt = buildSrt([{ start: 0, end: 1, text: 'ok' }, { start: 1, end: 2, text: '   ' }]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,000\nok\n');
});

test('buildFcpxml emits a valid title spine with tcStart', () => {
  const clips = [{ start: 0, end: 1.2, text: 'Hola <mundo> & amigos' }];
  const xml = buildFcpxml(clips, { fps: 25, timecodeBase: 3600, sourcePath: '/tmp/demo.mp4' });
  assert.match(xml, /<title name="Subtítulo 1" lane="1" offset="0\/25s" duration="30\/25s">/);
  assert.match(xml, /tcStart="90000\/25s"/);
  assert.match(xml, /Hola &lt;mundo&gt; &amp; amigos/);
  assert.match(xml, /<project name="Panto SRT · demo">/);
  assert.ok(xml.endsWith('</fcpxml>\n'));
});

test('buildFcpxml rounds durations to whole frames', () => {
  const clips = [{ start: 0.3333, end: 1.9999, text: 'bien' }];
  const xml = buildFcpxml(clips, { fps: 30, timecodeBase: 0, sourcePath: '/tmp/x.mp4' });
  assert.match(xml, /offset="10\/30s"/);
  assert.match(xml, /duration="50\/30s"/);
});

test('buildFcpxml keeps every cue editable and frame-synchronised', () => {
  const clips = [
    { start: 0.04, end: 1.08, text: 'Primera línea' },
    { start: 2.02, end: 3.14, text: 'Segunda\nlínea' }
  ];
  const xml = buildFcpxml(clips, { fps: 25, sourcePath: '/tmp/timeline.mov' });
  assert.match(xml, /<title name="Subtítulo 1" lane="1" offset="1\/25s" duration="26\/25s">/);
  assert.match(xml, /<title name="Subtítulo 2" lane="1" offset="51\/25s" duration="28\/25s">/);
  assert.match(xml, /<text-style ref="sts-0">Primera línea<\/text-style>/);
  assert.match(xml, /<text-style ref="sts-1">Segunda&lt;br\/&gt;línea<\/text-style>/);
});
