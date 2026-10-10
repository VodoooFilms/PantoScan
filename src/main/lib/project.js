'use strict';

const fs = require('fs');
const path = require('path');

const { toTimecode } = require('./format');
const { ROLE_COLORS, EMOTION_COLORS } = require('./taxonomy');
const { extractForIndex } = require('./edit');

const KEY_ROLES = ['gancho', 'giro', 'conflicto', 'insight', 'resolución', 'cierre'];

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function backfill(store) {
  let count = 0;
  for (const row of store.listResults()) {
    if (store.hasSegments(row.clip_id)) continue;
    const edit = readJson(row.edit_path);
    if (!edit) continue;
    store.saveExtraction(row.clip_id, extractForIndex(edit));
    count += 1;
  }
  return count;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function groupBy(items, keyer) {
  const map = new Map();
  for (const item of items) {
    const key = keyer(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function buildProject(store) {
  backfill(store);
  const { segments, annotations, results } = store.projectExtractions();
  const fpsByClip = new Map(results.map((row) => [row.clip_id, row.fps || 25]));
  const nameByClip = new Map(results.map((row) => [row.clip_id, row.clip_name]));
  const volumeByClip = new Map(results.map((row) => [row.clip_id, row.volume_name]));
  const tc = (clipId, seconds) => toTimecode(seconds, fpsByClip.get(clipId) || 25);

  const topics = groupBy(annotations.filter((a) => a.kind === 'topic'), (a) => a.label);
  const emotions = groupBy(annotations.filter((a) => a.kind === 'emotion'), (a) => a.label);
  const quotes = annotations.filter((a) => a.kind === 'quote');
  const roles = annotations.filter((a) => a.kind === 'role');

  const segmentsByClip = groupBy(segments, (s) => s.clip_id);
  function textAt(clipId, seconds) {
    const list = segmentsByClip.get(clipId) || [];
    const hit = list.find((s) => s.start <= seconds + 1e-6 && seconds < s.end + 1e-6);
    return hit ? hit.text : '';
  }

  const topicRows = [...topics.entries()].map(([label, items]) => ({
    label,
    clips: new Set(items.map((i) => i.clip_id)).size,
    count: items.length,
    first: items.reduce((min, i) => (i.start < min.start ? i : min), items[0])
  })).sort((a, b) => b.clips - a.clips || b.count - a.count);

  const emotionRows = [...emotions.entries()].map(([label, items]) => {
    const valence = items.reduce((sum, i) => sum + (i.valence || 0), 0) / items.length;
    const arousal = items.reduce((sum, i) => sum + (i.arousal || 0), 0) / items.length;
    return { label, clips: new Set(items.map((i) => i.clip_id)).size, count: items.length, valence, arousal };
  }).sort((a, b) => b.clips - a.clips || b.count - a.count);

  const durationByClip = new Map();
  for (const [clipId, list] of segmentsByClip) {
    const last = list[list.length - 1];
    durationByClip.set(clipId, last ? last.end : 0);
  }
  const totalSeconds = [...durationByClip.values()].reduce((sum, value) => sum + value, 0);

  const annotationsByClip = groupBy(annotations.filter((a) => a.kind !== 'quote'), (a) => a.clip_id);

  const keyRoleRows = roles
    .filter((role) => KEY_ROLES.includes(role.label))
    .map((role) => ({
      clipId: role.clip_id,
      clipName: role.clip_name,
      tc: tc(role.clip_id, role.start),
      role: role.label,
      text: textAt(role.clip_id, role.start)
    }))
    .sort((a, b) => a.clipName.localeCompare(b.clipName) || a.tc.localeCompare(b.tc));

  const selectRows = [];
  const seenSelects = new Set();
  const pushSelect = (row) => {
    const key = `${row.clipId}|${row.tc}`;
    if (seenSelects.has(key)) return;
    seenSelects.add(key);
    selectRows.push(row);
  };
  quotes.forEach((quote) => pushSelect({ clipId: quote.clip_id, clipName: quote.clip_name, tc: tc(quote.clip_id, quote.start), kind: 'cita', label: 'cita', text: quote.note || '' }));
  keyRoleRows.forEach((row) => pushSelect({ clipId: row.clipId, clipName: row.clipName, tc: row.tc, kind: 'rol', label: row.role, text: row.text }));

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      clips: results.length,
      clipsWithExtraction: annotationsByClip.size,
      totalSeconds,
      topics: topicRows.length,
      emotions: emotionRows.length,
      quotes: quotes.length
    },
    fpsByClip,
    nameByClip,
    volumeByClip,
    topicRows,
    emotionRows,
    annotationsByClip,
    quotes,
    keyRoleRows,
    selectRows,
    tc,
    results
  };
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function renderMarkdown(bundle) {
  const lines = [];
  const s = bundle.stats;
  lines.push('# Guía de proyecto documental');
  lines.push('');
  lines.push(`> ${s.clips} clips · ${fmtDuration(s.totalSeconds)} de material analizado · ${s.topics} temas · ${s.emotions} emociones · ${s.quotes} citas`);
  lines.push('');
  lines.push('## Panorama');
  lines.push('');
  lines.push('| Métrica | Valor |');
  lines.push('| --- | --- |');
  lines.push(`| Clips procesados | ${s.clips} |`);
  lines.push(`| Duración analizada | ${fmtDuration(s.totalSeconds)} |`);
  lines.push(`| Temas distintos | ${s.topics} |`);
  lines.push(`| Emociones distintas | ${s.emotions} |`);
  lines.push(`| Citas detectadas | ${s.quotes} |`);
  lines.push(`| Generado | ${bundle.generatedAt} |`);
  lines.push('');

  if (bundle.topicRows.length) {
    lines.push('## Índice de temas del proyecto');
    lines.push('');
    lines.push('| Tema | Clips | Apariciones | Ejemplo |');
    lines.push('| --- | --- | --- | --- |');
    bundle.topicRows.forEach((topic) => {
      lines.push(`| ${topic.label} | ${topic.clips} | ${topic.count} | ${bundle.nameByClip.get(topic.first.clip_id)} \`${bundle.tc(topic.first.clip_id, topic.first.start)}\` |`);
    });
    lines.push('');
  }

  if (bundle.emotionRows.length) {
    lines.push('## Mapa de emociones');
    lines.push('');
    lines.push('| Emoción | Clips | Valencia media | Activación media | Apariciones |');
    lines.push('| --- | --- | --- | --- | --- |');
    bundle.emotionRows.forEach((emotion) => {
      lines.push(`| ${emotion.label} | ${emotion.clips} | ${emotion.valence.toFixed(2)} | ${emotion.arousal.toFixed(2)} | ${emotion.count} |`);
    });
    lines.push('');
  }

  lines.push('## Línea de tiempo por clip');
  lines.push('');
  for (const result of bundle.results) {
    const list = bundle.annotationsByClip.get(result.clip_id) || [];
    lines.push(`### ${result.clip_name} · ${result.volume_name || '—'}`);
    lines.push('');
    if (result.summary) { lines.push(result.summary); lines.push(''); }
    if (!list.length) { lines.push('_(sin anotaciones)_'); lines.push(''); continue; }
    lines.push('| Entrada | Tipo | Etiqueta | Nota |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of list) {
      lines.push(`| \`${bundle.tc(item.clip_id, item.start)}\` | ${item.kind} | ${item.label} | ${(item.note || '').replace(/\|/g, '/')} |`);
    }
    lines.push('');
  }

  if (bundle.selectRows.length) {
    lines.push('## Selects (paper edit)');
    lines.push('');
    lines.push('| Clip | Entrada | Tipo | Etiqueta | Texto |');
    lines.push('| --- | --- | --- | --- | --- |');
    bundle.selectRows.forEach((row) => {
      lines.push(`| ${row.clipName} | \`${row.tc}\` | ${row.kind} | ${row.label} | ${(row.text || '').replace(/\|/g, '/')} |`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function renderHtml(bundle) {
  const s = bundle.stats;
  const table = (headers, rows) => `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const chip = (value) => `<span class="tc">${escapeHtml(value)}</span>`;

  const topics = table(['Tema', 'Clips', 'Apariciones', 'Ejemplo'],
    bundle.topicRows.map((topic) => [escapeHtml(topic.label), topic.clips, topic.count, `${escapeHtml(bundle.nameByClip.get(topic.first.clip_id))} ${chip(bundle.tc(topic.first.clip_id, topic.first.start))}`]));

  const emotions = table(['Emoción', 'Clips', 'Valencia', 'Activación', 'Apariciones'],
    bundle.emotionRows.map((emotion) => [`<span class="dot" style="background:${EMOTION_COLORS[emotion.label] || '#888'}"></span>${escapeHtml(emotion.label)}`, emotion.clips, emotion.valence.toFixed(2), emotion.arousal.toFixed(2), emotion.count]));

  const timeline = bundle.results.map((result) => {
    const list = bundle.annotationsByClip.get(result.clip_id) || [];
    const rows = list.map((item) => [chip(bundle.tc(item.clip_id, item.start)), item.kind, escapeHtml(item.label), escapeHtml(item.note || '')]);
    return `<h3>${escapeHtml(result.clip_name)} · ${escapeHtml(result.volume_name || '—')}</h3>${result.summary ? `<p class="subtle">${escapeHtml(result.summary)}</p>` : ''}${rows.length ? table(['Entrada', 'Tipo', 'Etiqueta', 'Nota'], rows) : '<p class="subtle">(sin anotaciones)</p>'}`;
  }).join('');

  const selects = bundle.selectRows.map((row) => [
    escapeHtml(row.clipName), chip(row.tc), row.kind,
    `<span class="dot" style="background:${ROLE_COLORS[row.label] || '#6c8cff'}"></span>${escapeHtml(row.label)}`,
    escapeHtml(row.text)
  ]);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guía de proyecto documental</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 48px; background: #14151a; color: #e7e7ea; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 30px; margin: 0 0 8px; }
  h2 { margin-top: 40px; border-bottom: 1px solid #2a2b33; padding-bottom: 8px; }
  h3 { margin-top: 28px; }
  .summary { background: #1c1d24; border-left: 3px solid #6c8cff; padding: 14px 18px; border-radius: 8px; }
  .subtle { color: #8f95a9; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #2a2b33; vertical-align: top; }
  th { color: #9aa0b4; font-weight: 600; }
  .tc { font-family: ui-monospace, Menlo, monospace; background: #23252e; border: 1px solid #33364a; border-radius: 5px; padding: 1px 6px; font-size: 12.5px; color: #b9c4ff; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; }
</style>
</head>
<body>
<main>
  <h1>Guía de proyecto documental</h1>
  <p class="summary">${s.clips} clips · ${fmtDuration(s.totalSeconds)} de material analizado · ${s.topics} temas · ${s.emotions} emociones · ${s.quotes} citas</p>
  <h2>Panorama</h2>
  ${table(['Métrica', 'Valor'], [
    ['Clips procesados', s.clips], ['Duración analizada', fmtDuration(s.totalSeconds)],
    ['Temas distintos', s.topics], ['Emociones distintas', s.emotions], ['Citas detectadas', s.quotes],
    ['Generado', escapeHtml(bundle.generatedAt)]
  ])}
  ${bundle.topicRows.length ? `<h2>Índice de temas del proyecto</h2>${topics}` : ''}
  ${bundle.emotionRows.length ? `<h2>Mapa de emociones</h2>${emotions}` : ''}
  <h2>Línea de tiempo por clip</h2>
  ${timeline}
  ${bundle.selectRows.length ? `<h2>Selects (paper edit)</h2>${table(['Clip', 'Entrada', 'Tipo', 'Etiqueta', 'Texto'], selects)}` : ''}
</main>
</body>
</html>`;
}

function renderSelectsCsv(bundle) {
  const header = 'clip,start_tc,start_seconds,kind,label,text';
  const rows = bundle.selectRows.map((row) => {
    return [row.clipName, row.tc, '', row.kind, row.label, `"${(row.text || '').replace(/"/g, '""')}"`].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

function sanitizeFileName(name) {
  return String(name == null ? '' : name)
    .replace(/[/:]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'clip';
}

function exportMarkdownFiles(store, outRoot, baseDir) {
  const folder = path.join(baseDir, 'guias-md');
  fs.mkdirSync(folder, { recursive: true });
  const files = [];
  const projectGuide = path.join(outRoot, 'project-guide.md');
  if (fs.existsSync(projectGuide)) {
    const target = path.join(folder, '00_proyecto.md');
    fs.copyFileSync(projectGuide, target);
    files.push(target);
  }
  const results = store.listResults().slice().sort((a, b) => a.clip_name.localeCompare(b.clip_name));
  results.forEach((row, index) => {
    const source = path.join(row.out_dir, 'guide.md');
    if (!fs.existsSync(source)) return;
    const target = path.join(folder, `${String(index + 1).padStart(2, '0')}_${sanitizeFileName(row.clip_name)}.md`);
    fs.copyFileSync(source, target);
    files.push(target);
  });
  return { folder, files, count: files.length };
}

function copyPerClipFiles(store, baseDir, subfolder, artifactName, extension) {
  const folder = path.join(baseDir, subfolder);
  fs.mkdirSync(folder, { recursive: true });
  const files = [];
  const results = store.listResults().slice().sort((a, b) => a.clip_name.localeCompare(b.clip_name));
  results.forEach((row, index) => {
    const source = path.join(row.out_dir, artifactName);
    if (!fs.existsSync(source)) return;
    const target = path.join(folder, `${String(index + 1).padStart(2, '0')}_${sanitizeFileName(row.clip_name)}.${extension}`);
    fs.copyFileSync(source, target);
    files.push(target);
  });
  return { folder, files, count: files.length };
}

function exportSrtFiles(store, outRoot, baseDir) {
  return copyPerClipFiles(store, baseDir, 'subtitulos-srt', 'captions.srt', 'srt');
}

function exportFcpxmlFiles(store, outRoot, baseDir) {
  return copyPerClipFiles(store, baseDir, 'timelines-fcpxml', 'timeline.fcpxml', 'fcpxml');
}

function writeProject(outRoot, bundle) {
  fs.mkdirSync(outRoot, { recursive: true });
  const files = {
    'project-guide.md': renderMarkdown(bundle),
    'project-guide.html': renderHtml(bundle),
    'selects.csv': renderSelectsCsv(bundle)
  };
  const written = {};
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(outRoot, name);
    fs.writeFileSync(target, content);
    written[name] = target;
  }
  return written;
}

module.exports = { buildProject, backfill, renderMarkdown, renderHtml, renderSelectsCsv, writeProject, exportMarkdownFiles, exportSrtFiles, exportFcpxmlFiles, sanitizeFileName };
