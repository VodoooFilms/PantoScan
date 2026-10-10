'use strict';

const { loadTaxonomy } = require('./taxonomy');
const { loadConfig } = require('./config');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8081/v1';
const DEFAULT_MODEL = 'local-model';

function endpointCandidates(explicit) {
  const config = loadConfig();
  const list = [
    explicit,
    process.env.DOC_LLM_ENDPOINT,
    config.llmEndpoint,
    ...(config.llmCandidates || []),
    DEFAULT_ENDPOINT
  ].filter(Boolean).map((value) => value.replace(/\/$/, ''));
  return [...new Set(list)];
}

async function reachable(fetchImpl, endpoint, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint}/models`, { signal: controller.signal });
    return response.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function pickEndpoint(fetchImpl, candidates) {
  for (const candidate of candidates) {
    if (await reachable(fetchImpl, candidate)) return candidate;
  }
  return candidates[candidates.length - 1] || DEFAULT_ENDPOINT;
}

function formatSeconds(value) {
  const total = Math.max(0, value || 0);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function extractJson(text) {
  if (!text) throw new Error('llm-empty');
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('llm-no-json');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error('llm-unbalanced-json');
}

function buildPrompt(segments, taxonomy, offset) {
  const lines = segments.map((segment, index) => {
    const globalIndex = offset + index;
    return `[${globalIndex}] ${formatSeconds(segment.start)}-${formatSeconds(segment.end)} ${segment.text}`;
  }).join('\n');

  return [
    'Eres un asistente de montaje documental. Analizas la transcripción de UN clip y devuelves un mapa de edición.',
    '',
    'Temas permitidos (usa uno si encaja, o propone una etiqueta corta nueva):',
    taxonomy.topics.join(', '),
    '',
    'Emociones permitidas:',
    taxonomy.emotions.join(', '),
    '',
    'Roles narrativos permitidos:',
    taxonomy.roles.join(', '),
    '',
    'Transcripción (segmentos con índice global [n], tiempo inicial-final mm:ss.s y texto):',
    lines,
    '',
    'Devuelve SOLO un objeto JSON válido, sin texto adicional, con esta forma exacta:',
    '{',
    '  "summary": "2-4 frases que resuman el clip",',
    '  "topics": [{"label": "tema", "startSeg": n, "endSeg": n, "summary": "1 frase"}],',
    '  "emotions": [{"label": "emocion", "valence": -1.0, "arousal": 0.5, "startSeg": n, "endSeg": n, "evidence": "palabra o frase que lo sustenta"}],',
    '  "roles": [{"role": "rol", "startSeg": n, "endSeg": n}],',
    '  "quotes": [{"text": "cita textual potente", "startSeg": n, "endSeg": n}]',
    '}',
    '',
    'Reglas: usa los índices globales [n] existentes; startSeg <= endSeg; valence entre -1 y 1; arousal entre 0 y 1; no inventes texto.'
  ].join('\n');
}

function clampIndex(value, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(max, Math.round(number)));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function createAnalyzer(options = {}) {
  let endpoint = options.endpoint ? options.endpoint.replace(/\/$/, '') : null;
  const candidates = endpointCandidates(options.endpoint);
  const model = options.model || loadConfig().llmModel || process.env.DOC_LLM_MODEL || DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const taxonomy = options.taxonomy || loadTaxonomy(options.taxonomyFile);
  const chunkSize = options.chunkSize || 80;
  const overlap = options.overlap || 10;
  const temperature = options.temperature != null ? options.temperature : 0.2;
  const maxTokens = options.maxTokens || 2048;

  async function ensureEndpoint() {
    if (!endpoint) endpoint = await pickEndpoint(fetchImpl, candidates);
    return endpoint;
  }

  async function chat(messages, signal) {
    const base = await ensureEndpoint();
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        chat_template_kwargs: { enable_thinking: false }
      })
    });
    if (!response.ok) throw new Error(`llm-http-${response.status}`);
    const payload = await response.json();
    const content = payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : '';
    return content;
  }

  function windows(segments) {
    if (segments.length <= chunkSize) return [{ offset: 0, segments }];
    const result = [];
    for (let start = 0; start < segments.length; start += chunkSize - overlap) {
      const slice = segments.slice(start, start + chunkSize);
      result.push({ offset: start, segments: slice });
      if (start + chunkSize >= segments.length) break;
    }
    return result;
  }

  async function analyzeWindow(segments, offset, onProgress, signal) {
    const prompt = buildPrompt(segments, taxonomy, offset);
    const content = await chat([
      { role: 'system', content: 'Respondes únicamente con JSON válido.' },
      { role: 'user', content: prompt }
    ], signal);
    const parsed = extractJson(content);
    if (typeof onProgress === 'function') onProgress(offset);
    return parsed;
  }

  function normalize(parsed, segments) {
    const maxIndex = Math.max(0, segments.length - 1);
    const startOf = (index) => (segments[clampIndex(index, maxIndex)] || {}).start || 0;
    const endOf = (index) => (segments[clampIndex(index, maxIndex)] || {}).end || 0;

    const topics = list(parsed.topics).map((topic) => {
      const startSeg = clampIndex(topic.startSeg, maxIndex);
      const endSeg = clampIndex(topic.endSeg != null ? topic.endSeg : topic.startSeg, maxIndex);
      return {
        label: String(topic.label || 'sin tema').trim(),
        summary: topic.summary ? String(topic.summary).trim() : '',
        startSeg, endSeg,
        start: startOf(startSeg),
        end: endOf(Math.max(startSeg, endSeg))
      };
    }).sort((a, b) => a.start - b.start);

    const emotions = list(parsed.emotions).map((emotion) => {
      const startSeg = clampIndex(emotion.startSeg, maxIndex);
      const endSeg = clampIndex(emotion.endSeg != null ? emotion.endSeg : emotion.startSeg, maxIndex);
      return {
        label: String(emotion.label || 'neutro').trim(),
        valence: Math.max(-1, Math.min(1, Number(emotion.valence) || 0)),
        arousal: Math.max(0, Math.min(1, Number(emotion.arousal) || 0)),
        evidence: emotion.evidence ? String(emotion.evidence).trim() : '',
        startSeg, endSeg,
        start: startOf(startSeg),
        end: endOf(Math.max(startSeg, endSeg))
      };
    }).sort((a, b) => a.start - b.start);

    const roles = list(parsed.roles).map((role) => {
      const startSeg = clampIndex(role.startSeg, maxIndex);
      const endSeg = clampIndex(role.endSeg != null ? role.endSeg : role.startSeg, maxIndex);
      const raw = String(role.role || 'contexto').trim().toLowerCase();
      const match = taxonomy.roles.find((candidate) => candidate.toLowerCase() === raw) || raw;
      return { role: match, startSeg, endSeg, start: startOf(startSeg), end: endOf(Math.max(startSeg, endSeg)) };
    }).sort((a, b) => a.start - b.start);

    const quotes = list(parsed.quotes).map((quote) => {
      const startSeg = clampIndex(quote.startSeg, maxIndex);
      const endSeg = clampIndex(quote.endSeg != null ? quote.endSeg : quote.startSeg, maxIndex);
      return {
        text: String(quote.text || '').trim(),
        startSeg, endSeg,
        start: startOf(startSeg),
        end: endOf(Math.max(startSeg, endSeg))
      };
    }).filter((quote) => quote.text).sort((a, b) => a.start - b.start);

    return {
      summary: parsed.summary ? String(parsed.summary).trim() : '',
      topics, emotions, roles, quotes
    };
  }

  function mergeWindows(results, segments) {
    const merged = { summary: '', topics: [], emotions: [], roles: [], quotes: [] };
    for (const parsed of results) {
      const one = normalize(parsed, segments);
      if (!merged.summary && one.summary) merged.summary = one.summary;
      merged.topics.push(...one.topics);
      merged.emotions.push(...one.emotions);
      merged.roles.push(...one.roles);
      merged.quotes.push(...one.quotes);
    }
    const dedupe = (items, keyer) => {
      const seen = new Set();
      return items.filter((item) => {
        const key = keyer(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    merged.topics = dedupe(merged.topics, (t) => `${t.label}|${t.startSeg}|${t.endSeg}`);
    merged.emotions = dedupe(merged.emotions, (e) => `${e.label}|${e.startSeg}|${e.endSeg}`);
    merged.roles = dedupe(merged.roles, (r) => `${r.role}|${r.startSeg}|${r.endSeg}`);
    merged.quotes = dedupe(merged.quotes, (q) => `${q.startSeg}|${q.endSeg}|${(q.text || '').trim().toLowerCase()}`);
    return merged;
  }

  async function analyzeTranscript(transcript, opts = {}) {
    const segments = transcript.segments || [];
    if (!segments.length) throw new Error('transcript-empty');
    const parts = windows(segments);
    const results = [];
    for (const part of parts) {
      if (opts.signal && opts.signal.aborted) throw new Error('cancelled');
      results.push(await analyzeWindow(part.segments, part.offset, opts.onProgress, opts.signal));
    }
    const merged = mergeWindows(results, segments);
    return { ...merged, model, generatedAt: new Date().toISOString() };
  }

  return { analyzeTranscript, chat, taxonomy, extractJson, normalize, model, getEndpoint: () => endpoint };
}

module.exports = { createAnalyzer, extractJson, endpointCandidates, reachable, pickEndpoint, DEFAULT_ENDPOINT, DEFAULT_MODEL };
