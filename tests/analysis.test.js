'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createAnalyzer, extractJson, endpointCandidates, pickEndpoint } = require('../src/main/lib/analysis');

test('extractJson tolerates code fences and surrounding text', () => {
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('Claro:\n{"b":[1,2]}\nfin'), { b: [1, 2] });
  assert.throws(() => extractJson('sin json'), /llm-no-json/);
});

test('endpointCandidates dedupes and prefers the explicit endpoint', () => {
  const list = endpointCandidates('http://host:9000/v1');
  assert.strictEqual(list[0], 'http://host:9000/v1');
  assert.ok(list.includes('http://127.0.0.1:8081/v1'));
  assert.ok(list.includes('http://127.0.0.1:8080/v1'));
  assert.strictEqual(new Set(list).size, list.length);
});

test('pickEndpoint returns the first reachable candidate', async () => {
  const fetchImpl = async (url) => ({ ok: url.includes('8080'), status: url.includes('8080') ? 200 : 503 });
  const picked = await pickEndpoint(fetchImpl, ['http://127.0.0.1:8081/v1', 'http://127.0.0.1:8080/v1']);
  assert.strictEqual(picked, 'http://127.0.0.1:8080/v1');
});

test('pickEndpoint falls back to the last candidate when none respond', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const picked = await pickEndpoint(fetchImpl, ['http://a/v1', 'http://b/v1']);
  assert.strictEqual(picked, 'http://b/v1');
});

test('analyzeTranscript parses and normalizes an LLM response', async () => {
  const payload = {
    choices: [{
      message: {
        content: JSON.stringify({
          summary: 'resumen',
          topics: [{ label: 'proceso creativo', startSeg: 0, endSeg: 1, summary: 's' }],
          emotions: [{ label: 'alegría', valence: 0.8, arousal: 0.7, startSeg: 0, endSeg: 0, evidence: 'genial' }],
          roles: [{ role: 'gancho', startSeg: 0, endSeg: 0 }],
          quotes: [{ text: 'cita', startSeg: 0, endSeg: 0 }]
        })
      }
    }]
  };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => payload });
  const analyzer = createAnalyzer({ endpoint: 'http://test/v1', fetchImpl });
  const transcript = {
    language: 'es',
    duration: 4,
    segments: [{ start: 0, end: 4, text: 'hola' }]
  };
  const result = await analyzer.analyzeTranscript(transcript);
  assert.strictEqual(result.summary, 'resumen');
  assert.strictEqual(result.topics[0].label, 'proceso creativo');
  assert.strictEqual(result.topics[0].end, 4);
  assert.strictEqual(result.emotions[0].valence, 0.8);
  assert.strictEqual(result.roles[0].role, 'gancho');
  assert.strictEqual(result.quotes[0].text, 'cita');
});

function analyzerReturning(content) {
  const payload = { choices: [{ message: { content: JSON.stringify(content) } }] };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => payload });
  return createAnalyzer({ endpoint: 'http://test/v1', fetchImpl, chunkSize: 50 });
}

const TWO_SEGMENTS = { language: 'es', duration: 4, segments: [{ start: 0, end: 2, text: 'uno' }, { start: 2, end: 4, text: 'dos' }] };

test('distinct items that share a start segment are not collapsed', async () => {
  const analyzer = analyzerReturning({
    summary: 's',
    topics: [
      { label: 'tema', startSeg: 0, endSeg: 0, summary: 'a' },
      { label: 'tema', startSeg: 0, endSeg: 1, summary: 'b' }
    ],
    emotions: [],
    roles: [],
    quotes: [
      { text: 'primera cita', startSeg: 0, endSeg: 0 },
      { text: 'segunda cita', startSeg: 0, endSeg: 1 }
    ]
  });
  const result = await analyzer.analyzeTranscript(TWO_SEGMENTS);
  assert.strictEqual(result.topics.length, 2, 'two topics sharing startSeg must survive');
  assert.strictEqual(result.quotes.length, 2, 'two quotes sharing startSeg must survive');
});

test('exact duplicates from window overlap are collapsed', async () => {
  const analyzer = analyzerReturning({
    summary: 's',
    topics: [
      { label: 'tema', startSeg: 0, endSeg: 1, summary: 'a' },
      { label: 'tema', startSeg: 0, endSeg: 1, summary: 'a' }
    ],
    emotions: [],
    roles: [],
    quotes: [
      { text: 'la misma cita', startSeg: 0, endSeg: 1 },
      { text: 'la misma cita', startSeg: 0, endSeg: 1 }
    ]
  });
  const result = await analyzer.analyzeTranscript(TWO_SEGMENTS);
  assert.strictEqual(result.topics.length, 1);
  assert.strictEqual(result.quotes.length, 1);
});
