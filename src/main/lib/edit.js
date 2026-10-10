'use strict';

const { toTimecode } = require('./format');

function buildEdit({ asset, transcript, analysis }) {
  const fps = Number(asset.fps) || 25;
  const tc = (seconds) => toTimecode(seconds, fps);

  const segments = (transcript.segments || []).map((segment, index) => ({
    index,
    start: segment.start,
    end: segment.end,
    startTC: tc(segment.start),
    endTC: tc(segment.end),
    text: segment.text
  }));

  const withTc = (item) => ({ ...item, startTC: tc(item.start), endTC: tc(item.end) });

  const topics = analysis.topics.map(withTc);
  const emotions = analysis.emotions.map(withTc);
  const roles = analysis.roles.map(withTc);
  const quotes = analysis.quotes.map(withTc);

  const timeline = [
    ...topics.map((topic) => ({ kind: 'topic', label: topic.label, start: topic.start, end: topic.end, startTC: topic.startTC, endTC: topic.endTC, note: topic.summary })),
    ...emotions.map((emotion) => ({ kind: 'emotion', label: emotion.label, start: emotion.start, end: emotion.end, startTC: emotion.startTC, endTC: emotion.endTC, valence: emotion.valence, arousal: emotion.arousal, note: emotion.evidence })),
    ...roles.map((role) => ({ kind: 'role', label: role.role, start: role.start, end: role.end, startTC: role.startTC, endTC: role.endTC }))
  ].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));

  return {
    version: 1,
    generatedAt: analysis.generatedAt || new Date().toISOString(),
    model: analysis.model || null,
    asset: {
      id: asset.id,
      name: asset.name,
      relPath: asset.relPath,
      absPath: asset.absPath || null,
      volumeName: asset.volumeName,
      mediaType: asset.mediaType,
      language: transcript.language || asset.language || null,
      fps,
      width: asset.width || null,
      height: asset.height || null,
      duration: transcript.duration || asset.duration || null,
      durationTC: tc(transcript.duration || asset.duration || 0)
    },
    summary: analysis.summary,
    counts: {
      segments: segments.length,
      topics: topics.length,
      emotions: emotions.length,
      roles: roles.length,
      quotes: quotes.length
    },
    segments,
    timeline,
    topics,
    emotions,
    roles,
    quotes
  };
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, toNumber(value, min)));
}

function applyEdits(base, changes = {}) {
  const fps = Number(base.asset && base.asset.fps) || 25;
  const tc = (seconds) => toTimecode(seconds, fps);
  const duration = toNumber(base.asset && base.asset.duration, 0);
  const upper = duration > 0 ? duration : Infinity;
  const segments = base.segments || [];

  const segIndexFor = (seconds) => {
    const hit = segments.findIndex((segment) => segment.start <= seconds + 1e-6 && seconds < segment.end + 1e-6);
    if (hit >= 0) return hit;
    let best = 0;
    let bestDist = Infinity;
    segments.forEach((segment, index) => {
      const dist = Math.abs(segment.start - seconds);
      if (dist < bestDist) { bestDist = dist; best = index; }
    });
    return best;
  };

  const span = (start, end) => {
    const s = Math.max(0, Math.min(upper, toNumber(start, 0)));
    const e = Math.max(s, Math.min(upper, toNumber(end, s)));
    return { start: s, end: e, startTC: tc(s), endTC: tc(e), startSeg: segIndexFor(s), endSeg: segIndexFor(e) };
  };

  const topics = (changes.topics || [])
    .filter((topic) => topic && String(topic.label || '').trim())
    .map((topic) => ({ label: String(topic.label).trim(), summary: topic.summary != null ? String(topic.summary) : '', ...span(topic.start, topic.end) }));
  const emotions = (changes.emotions || [])
    .filter((emotion) => emotion && String(emotion.label || '').trim())
    .map((emotion) => ({
      label: String(emotion.label).trim(),
      valence: clampNumber(emotion.valence, -1, 1),
      arousal: clampNumber(emotion.arousal, 0, 1),
      evidence: emotion.evidence != null ? String(emotion.evidence) : '',
      ...span(emotion.start, emotion.end)
    }));
  const roles = (changes.roles || [])
    .filter((role) => role && String(role.role || '').trim())
    .map((role) => ({ role: String(role.role).trim(), ...span(role.start, role.end) }));
  const quotes = (changes.quotes || [])
    .filter((quote) => quote && String(quote.text || '').trim())
    .map((quote) => ({ text: String(quote.text).trim(), ...span(quote.start, quote.end) }));

  const timeline = [
    ...topics.map((topic) => ({ kind: 'topic', label: topic.label, start: topic.start, end: topic.end, startTC: topic.startTC, endTC: topic.endTC, note: topic.summary })),
    ...emotions.map((emotion) => ({ kind: 'emotion', label: emotion.label, start: emotion.start, end: emotion.end, startTC: emotion.startTC, endTC: emotion.endTC, valence: emotion.valence, arousal: emotion.arousal, note: emotion.evidence })),
    ...roles.map((role) => ({ kind: 'role', label: role.role, start: role.start, end: role.end, startTC: role.startTC, endTC: role.endTC }))
  ].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));

  return {
    ...base,
    summary: changes.summary != null ? String(changes.summary) : base.summary,
    counts: {
      segments: segments.length,
      topics: topics.length,
      emotions: emotions.length,
      roles: roles.length,
      quotes: quotes.length
    },
    segments,
    timeline,
    topics,
    emotions,
    roles,
    quotes
  };
}

function extractForIndex(edit) {
  const segments = (edit.segments || []).map((segment) => ({ idx: segment.index, start: segment.start, end: segment.end, text: segment.text }));
  const annotations = [
    ...(edit.topics || []).map((topic) => ({ kind: 'topic', label: topic.label, start: topic.start, end: topic.end, note: topic.summary, segStart: topic.startSeg, segEnd: topic.endSeg })),
    ...(edit.emotions || []).map((emotion) => ({ kind: 'emotion', label: emotion.label, start: emotion.start, end: emotion.end, note: emotion.evidence, valence: emotion.valence, arousal: emotion.arousal, segStart: emotion.startSeg, segEnd: emotion.endSeg })),
    ...(edit.roles || []).map((role) => ({ kind: 'role', label: role.role, start: role.start, end: role.end, segStart: role.startSeg, segEnd: role.endSeg })),
    ...(edit.quotes || []).map((quote) => ({ kind: 'quote', label: 'cita', start: quote.start, end: quote.end, note: quote.text, segStart: quote.startSeg, segEnd: quote.endSeg }))
  ];
  const searchEntries = [
    ...(edit.summary ? [{ section: 'summary', label: 'resumen', text: edit.summary }] : []),
    ...segments.map((segment) => ({ section: 'segment', text: segment.text, start: segment.start, end: segment.end })),
    ...(edit.topics || []).map((topic) => ({ section: 'topic', label: topic.label, text: `${topic.label} ${topic.summary || ''}`, start: topic.start, end: topic.end })),
    ...(edit.emotions || []).map((emotion) => ({ section: 'emotion', label: emotion.label, text: `${emotion.label} ${emotion.evidence || ''}`, start: emotion.start, end: emotion.end })),
    ...(edit.roles || []).map((role) => ({ section: 'role', label: role.role, text: role.role, start: role.start, end: role.end })),
    ...(edit.quotes || []).map((quote) => ({ section: 'quote', label: 'cita', text: quote.text, start: quote.start, end: quote.end }))
  ];
  return { segments, annotations, searchEntries };
}

module.exports = { buildEdit, applyEdits, extractForIndex };
