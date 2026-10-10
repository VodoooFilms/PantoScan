'use strict';

const { ROLE_COLORS, EMOTION_COLORS } = require('./taxonomy');

function durationLabel(start, end) {
  return `${(Math.max(0, end - start)).toFixed(1)}s`;
}

function activeIn(list, start, end) {
  return list.filter((item) => item.start < end && item.end > start);
}

function renderMarkdown(edit) {
  const lines = [];
  const asset = edit.asset;

  lines.push(`# Guía de edición — ${asset.name}`);
  lines.push('');
  if (edit.summary) { lines.push(`> ${edit.summary}`); lines.push(''); }

  lines.push('## Ficha técnica');
  lines.push('');
  lines.push('| Campo | Valor |');
  lines.push('| --- | --- |');
  lines.push(`| Archivo | \`${asset.relPath}\` |`);
  lines.push(`| Volumen | ${asset.volumeName || '—'} |`);
  lines.push(`| Tipo | ${asset.mediaType} |`);
  lines.push(`| Idioma | ${asset.language || '—'} |`);
  lines.push(`| Duración | ${asset.durationTC} (${(asset.duration || 0).toFixed(1)}s) |`);
  lines.push(`| fps | ${asset.fps} |`);
  lines.push(`| Segmentos | ${edit.counts.segments} |`);
  lines.push(`| Modelo | ${edit.model || '—'} |`);
  lines.push(`| Generado | ${edit.generatedAt} |`);
  lines.push('');

  if (edit.topics.length) {
    lines.push('## Índice de temas');
    lines.push('');
    lines.push('| # | Tema | Entrada | Salida | Duración | Resumen |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    edit.topics.forEach((topic, index) => {
      lines.push(`| ${index + 1} | ${topic.label} | \`${topic.startTC}\` | \`${topic.endTC}\` | ${durationLabel(topic.start, topic.end)} | ${topic.summary || ''} |`);
    });
    lines.push('');
  }

  if (edit.emotions.length) {
    lines.push('## Emociones en el tiempo');
    lines.push('');
    lines.push('| Emoción | Valencia | Activación | Entrada | Salida | Evidencia |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    edit.emotions.forEach((emotion) => {
      lines.push(`| ${emotion.label} | ${emotion.valence.toFixed(2)} | ${emotion.arousal.toFixed(2)} | \`${emotion.startTC}\` | \`${emotion.endTC}\` | ${emotion.evidence || ''} |`);
    });
    lines.push('');
  }

  if (edit.roles.length) {
    lines.push('## Estructura narrativa');
    lines.push('');
    lines.push('| Rol | Entrada | Salida | Duración |');
    lines.push('| --- | --- | --- | --- |');
    edit.roles.forEach((role) => {
      lines.push(`| ${role.role} | \`${role.startTC}\` | \`${role.endTC}\` | ${durationLabel(role.start, role.end)} |`);
    });
    lines.push('');
  }

  if (edit.quotes.length) {
    lines.push('## Citas destacadas');
    lines.push('');
    edit.quotes.forEach((quote) => {
      lines.push(`> "${quote.text}"`);
      lines.push(`> — <code>${quote.startTC}</code>`);
      lines.push('');
    });
  }

  lines.push('## Guion de montaje');
  lines.push('');
  const byTopic = new Map();
  edit.segments.forEach((segment) => {
    const topic = edit.topics.find((candidate) => candidate.start <= segment.start && segment.start < candidate.end + 0.001) || null;
    const key = topic ? topic.label : 'sin clasificar';
    if (!byTopic.has(key)) byTopic.set(key, { topic, segments: [] });
    byTopic.get(key).segments.push(segment);
  });
  let order = 0;
  for (const [key, group] of byTopic) {
    order += 1;
    const first = group.segments[0];
    const head = group.topic ? `### ${order}. ${key} · \`${group.topic.startTC}\`` : `### ${order}. ${key}`;
    lines.push(head);
    lines.push('');
    if (group.topic && group.topic.summary) { lines.push(group.topic.summary); lines.push(''); }
    for (const segment of group.segments) {
      lines.push(`- \`${segment.startTC}\` ${segment.text}`);
      const emotions = activeIn(edit.emotions, segment.start, segment.end);
      const roles = activeIn(edit.roles, segment.start, segment.end);
      const quote = edit.quotes.find((q) => q.start >= segment.start - 0.001 && q.start < segment.end + 0.001);
      const notes = [];
      if (roles.length) notes.push(`rol: ${roles.map((role) => role.role).join(', ')}`);
      if (emotions.length) notes.push(`emoción: ${emotions.map((emotion) => emotion.label).join(', ')}`);
      if (notes.length) lines.push(`  ↳ ${notes.join(' · ')}`);
      if (quote) lines.push(`  ↳ cita: "${quote.text}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(edit) {
  const tbody = (rows) => rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('\n');
  const chip = (timecode) => `<span class="tc">${escapeHtml(timecode)}</span>`;

  const topics = edit.topics.map((topic, index) => [
    String(index + 1), escapeHtml(topic.label), chip(topic.startTC), chip(topic.endTC), durationLabel(topic.start, topic.end), escapeHtml(topic.summary)
  ]);

  const emotions = edit.emotions.map((emotion) => [
    `<span class="dot" style="background:${EMOTION_COLORS[emotion.label] || '#888'}"></span>${escapeHtml(emotion.label)}`,
    emotion.valence.toFixed(2), emotion.arousal.toFixed(2), chip(emotion.startTC), chip(emotion.endTC), escapeHtml(emotion.evidence)
  ]);

  const roles = edit.roles.map((role) => [
    `<span class="dot" style="background:${ROLE_COLORS[role.role] || '#888'}"></span>${escapeHtml(role.role)}`,
    chip(role.startTC), chip(role.endTC), durationLabel(role.start, role.end)
  ]);

  const script = edit.segments.map((segment) => {
    const emotionsActive = activeIn(edit.emotions, segment.start, segment.end);
    const rolesActive = activeIn(edit.roles, segment.start, segment.end);
    const notes = [];
    if (rolesActive.length) notes.push(`rol: ${rolesActive.map((role) => role.role).join(', ')}`);
    if (emotionsActive.length) notes.push(`emoción: ${emotionsActive.map((emotion) => emotion.label).join(', ')}`);
    const noteHtml = notes.length ? `<div class="note">↳ ${escapeHtml(notes.join(' · '))}</div>` : '';
    return `<li>${chip(segment.startTC)} <span>${escapeHtml(segment.text)}</span>${noteHtml}</li>`;
  }).join('\n');

  const quotes = edit.quotes.map((quote) => `<blockquote>"${escapeHtml(quote.text)}"<cite>${chip(quote.startTC)}</cite></blockquote>`).join('\n');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guía de edición — ${escapeHtml(edit.asset.name)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 48px; background: #14151a; color: #e7e7ea; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 30px; margin: 0 0 8px; }
  h2 { margin-top: 40px; border-bottom: 1px solid #2a2b33; padding-bottom: 8px; }
  h3 { margin-top: 28px; }
  .summary { background: #1c1d24; border-left: 3px solid #6c8cff; padding: 14px 18px; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #2a2b33; vertical-align: top; }
  th { color: #9aa0b4; font-weight: 600; }
  .tc { font-family: ui-monospace, Menlo, monospace; background: #23252e; border: 1px solid #33364a; border-radius: 5px; padding: 1px 6px; font-size: 12.5px; color: #b9c4ff; }
  ul.script { list-style: none; padding: 0; }
  ul.script li { padding: 6px 0; border-bottom: 1px dashed #23252e; }
  .note { color: #8f95a9; font-size: 13px; margin-top: 2px; }
  blockquote { margin: 12px 0; padding: 10px 16px; background: #1c1d24; border-left: 3px solid #4ec9a0; border-radius: 8px; }
  blockquote cite { display: block; margin-top: 6px; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; }
</style>
</head>
<body>
<main>
  <h1>Guía de edición — ${escapeHtml(edit.asset.name)}</h1>
  ${edit.summary ? `<p class="summary">${escapeHtml(edit.summary)}</p>` : ''}
  <h2>Ficha técnica</h2>
  <table><tbody>${tbody([
    ['Archivo', `<code>${escapeHtml(edit.asset.relPath)}</code>`],
    ['Volumen', escapeHtml(edit.asset.volumeName || '—')],
    ['Idioma', escapeHtml(edit.asset.language || '—')],
    ['Duración', `${chip(edit.asset.durationTC)} ${(edit.asset.duration || 0).toFixed(1)}s`],
    ['fps', String(edit.asset.fps)],
    ['Segmentos', String(edit.counts.segments)],
    ['Modelo', escapeHtml(edit.model || '—')],
    ['Generado', escapeHtml(edit.generatedAt)]
  ])}</tbody></table>
  ${topics.length ? `<h2>Índice de temas</h2><table><thead><tr><th>#</th><th>Tema</th><th>Entrada</th><th>Salida</th><th>Duración</th><th>Resumen</th></tr></thead><tbody>${tbody(topics)}</tbody></table>` : ''}
  ${emotions.length ? `<h2>Emociones en el tiempo</h2><table><thead><tr><th>Emoción</th><th>Valencia</th><th>Activación</th><th>Entrada</th><th>Salida</th><th>Evidencia</th></tr></thead><tbody>${tbody(emotions)}</tbody></table>` : ''}
  ${roles.length ? `<h2>Estructura narrativa</h2><table><thead><tr><th>Rol</th><th>Entrada</th><th>Salida</th><th>Duración</th></tr></thead><tbody>${tbody(roles)}</tbody></table>` : ''}
  ${quotes ? `<h2>Citas destacadas</h2>${quotes}` : ''}
  <h2>Guion de montaje</h2>
  <ul class="script">${script}</ul>
</main>
</body>
</html>`;
}

module.exports = { renderMarkdown, renderHtml };
