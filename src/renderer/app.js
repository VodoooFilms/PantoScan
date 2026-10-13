'use strict';

const state = {
  sources: [],
  clips: [],
  results: new Map(),
  selected: new Set(),
  activeClipId: null,
  activeResult: null,
  running: false,
  searchQuery: '',
  searchResults: [],
  outRoot: ''
};

const $ = (id) => document.getElementById(id);

function fmtSize(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function statusFor(clipId) {
  const result = state.results.get(clipId);
  if (result) return result.edited
    ? { label: 'editado', className: 'status-done' }
    : { label: 'listo', className: 'status-done' };
  return { label: 'pendiente', className: '' };
}

const esc = (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const EDIT_BLANKS = {
  topics: { label: '', start: '0', end: '0', summary: '' },
  emotions: { label: '', start: '0', end: '0', valence: '0', arousal: '0.5', evidence: '' },
  roles: { role: '', start: '0', end: '0' },
  quotes: { text: '', start: '0', end: '0' }
};

function readEditorForm() {
  const model = { summary: $('edit-summary').value, topics: [], emotions: [], roles: [], quotes: [] };
  document.querySelectorAll('#editor .edit-row').forEach((row) => {
    const item = {};
    row.querySelectorAll('[data-f]').forEach((input) => { item[input.dataset.f] = input.value; });
    model[row.dataset.kind].push(item);
  });
  return model;
}

function renderEditor(model) {
  const input = (field, value, type = 'text', cls = '') => `<input type="${type}" data-f="${field}" value="${esc(value)}" class="${cls}">`;
  const section = (kind, title, grid, fields, rows) => `
    <div class="editor-section">
      <h4>${title}</h4>
      <div data-rows="${kind}">
        ${rows.map((row, index) => `
          <div class="edit-row" data-kind="${kind}" data-i="${index}">
            <div class="edit-grid ${grid}">
              ${fields.map((field) => `<div><label>${field.label}</label>${input(field.key, row[field.key], field.type || 'text', field.num ? 'num' : '')}</div>`).join('')}
              <button class="btn btn-small btn-danger" data-remove>Quitar</button>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn btn-small" data-add="${kind}">+ Añadir</button>
    </div>`;

  const topicFields = [
    { key: 'label', label: 'Tema' }, { key: 'start', label: 'Inicio (s)', type: 'number', num: true },
    { key: 'end', label: 'Fin (s)', type: 'number', num: true }, { key: 'summary', label: 'Resumen' }
  ];
  const emotionFields = [
    { key: 'label', label: 'Emoción' }, { key: 'start', label: 'Inicio (s)', type: 'number', num: true },
    { key: 'end', label: 'Fin (s)', type: 'number', num: true }, { key: 'valence', label: 'Valencia', type: 'number', num: true },
    { key: 'arousal', label: 'Activación', type: 'number', num: true }, { key: 'evidence', label: 'Evidencia' }
  ];
  const roleFields = [
    { key: 'role', label: 'Rol' }, { key: 'start', label: 'Inicio (s)', type: 'number', num: true },
    { key: 'end', label: 'Fin (s)', type: 'number', num: true }
  ];
  const quoteFields = [
    { key: 'text', label: 'Cita' }, { key: 'start', label: 'Inicio (s)', type: 'number', num: true },
    { key: 'end', label: 'Fin (s)', type: 'number', num: true }
  ];

  $('editor').innerHTML = `
    <div class="editor-head">
      <h3>Editar guía — ${esc(state.activeResult ? state.activeResult.clipName : '')}</h3>
      <div class="editor-actions">
        <button class="btn btn-small" id="edit-cancel">Cerrar</button>
        <button class="btn btn-small btn-primary" id="edit-save">Guardar y re-exportar</button>
      </div>
    </div>
    <div class="field"><label>Resumen del clip</label><textarea id="edit-summary" rows="3">${esc(model.summary || '')}</textarea></div>
    ${section('topics', 'Temas', 'topic', topicFields, model.topics)}
    ${section('emotions', 'Emociones', 'emotion', emotionFields, model.emotions)}
    ${section('roles', 'Roles narrativos', 'role', roleFields, model.roles)}
    ${section('quotes', 'Citas', 'quote', quoteFields, model.quotes)}
    <p class="editor-hint">Los cambios se guardan en edit.json y regeneran la guía, subtítulos, marcadores y timelines. No se repite ASR ni LLM.</p>`;
}

function openEditor() {
  if (!state.activeResult || !state.activeResult.edit) return;
  const edit = state.activeResult.edit;
  renderEditor({
    summary: edit.summary,
    topics: edit.topics.map((t) => ({ label: t.label, start: t.start, end: t.end, summary: t.summary || '' })),
    emotions: edit.emotions.map((e) => ({ label: e.label, start: e.start, end: e.end, valence: e.valence, arousal: e.arousal, evidence: e.evidence || '' })),
    roles: edit.roles.map((r) => ({ role: r.role, start: r.start, end: r.end })),
    quotes: edit.quotes.map((q) => ({ text: q.text, start: q.start, end: q.end }))
  });
  $('editor').hidden = false;
  $('guide-frame').style.display = 'none';
  $('edit-guide').textContent = 'Editando…';
}

function closeEditor() {
  $('editor').hidden = true;
  $('editor').innerHTML = '';
  $('guide-frame').style.display = 'block';
  $('edit-guide').textContent = 'Editar';
}

async function saveEditor() {
  if (!state.activeResult) return;
  const changes = readEditorForm();
  const button = $('edit-save');
  button.disabled = true;
  button.textContent = 'Guardando…';
  try {
    const result = await window.api.saveEdit(state.activeResult.clipId, changes);
    closeEditor();
    await refresh();
    if (result && result.ok) await openClip(state.activeResult.clipId);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Guardar y re-exportar'; }
  }
}

async function refresh() {
  const [sources, clips, results, stats] = await Promise.all([
    window.api.listSources(),
    window.api.listClips(),
    window.api.listResults(),
    window.api.queueStats()
  ]);
  state.sources = sources;
  state.clips = clips;
  state.results = new Map(results.map((row) => [row.clipId, row]));
  renderSources();
  renderClips();
  $('queue-badge').textContent = `cola ${stats.pending} · listos ${stats.done}`;
}

function renderSources() {
  const container = $('sources');
  container.innerHTML = '';
  if (!state.sources.length) {
    container.innerHTML = '<p class="subtle" style="padding:10px">Sin carpetas. Agrega una para empezar.</p>';
    return;
  }
  for (const source of state.sources) {
    const clipCount = state.clips.filter((clip) => clip.sourceId === source.id).length;
    const el = document.createElement('div');
    el.className = 'source';
    el.innerHTML = `
      <div class="source-head">
        <span class="${source.online ? 'dot-online' : 'dot-offline'}">●</span>
        <span class="source-name" title="${esc(source.relPath)}">${esc(source.name)}</span>
      </div>
      <div class="source-meta">${esc(source.volumeName || '—')} · ${clipCount} clips</div>
      <div class="source-actions">
        <button class="btn btn-small" data-scan="${source.id}">Escanear</button>
        <button class="btn btn-small" data-remove="${source.id}">Quitar</button>
      </div>`;
    container.appendChild(el);
  }
  container.querySelectorAll('[data-scan]').forEach((button) => {
    button.addEventListener('click', () => scanSource(button.dataset.scan));
  });
  container.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      await window.api.removeSource(button.dataset.remove);
      await refresh();
    });
  });
}

function fmtSeconds(seconds) {
  const total = Math.max(0, seconds || 0);
  const mm = Math.floor(total / 60);
  const ss = Math.floor(total % 60);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function renderSearchResults() {
  const container = $('clips');
  container.innerHTML = '';
  $('clip-count').textContent = `· ${state.searchResults.length} coincidencias`;
  if (!state.searchResults.length) {
    container.innerHTML = '<p class="search-empty">Sin coincidencias.</p>';
    return;
  }
  for (const hit of state.searchResults) {
    const el = document.createElement('div');
    el.className = 'hit';
    el.dataset.open = hit.clipId;
    el.innerHTML = `
      <div class="hit-head">
        <span class="hit-section ${esc(hit.section)}">${esc(hit.section)}</span>
        <span class="hit-clip">${esc(hit.clipName)}</span>
        <span class="hit-tc">${fmtSeconds(hit.start)}</span>
      </div>
      <div class="hit-text">${hit.label ? `<strong>${esc(hit.label)}</strong> · ` : ''}${esc(hit.text || '')}</div>`;
    container.appendChild(el);
  }
  container.querySelectorAll('[data-open]').forEach((node) => {
    node.addEventListener('click', () => openClip(node.dataset.open));
  });
}

function renderClips() {
  if (state.searchQuery) { renderSearchResults(); return; }
  const container = $('clips');
  container.innerHTML = '';
  $('clip-count').textContent = `(${state.clips.length})`;
  for (const clip of state.clips) {
    const status = statusFor(clip.id);
    const el = document.createElement('div');
    el.className = `clip${state.activeClipId === clip.id ? ' selected' : ''}`;
    el.innerHTML = `
      <input type="checkbox" ${state.selected.has(clip.id) ? 'checked' : ''} data-check="${clip.id}">
      <div class="clip-main" data-open="${clip.id}">
        <div class="clip-name">${clip.online ? '' : '⚠ '}${esc(clip.name)}</div>
        <div class="clip-meta">${esc(clip.mediaType)} · ${fmtSize(clip.size)}</div>
      </div>
      <span class="status ${status.className}">${status.label}</span>`;
    container.appendChild(el);
  }
  container.querySelectorAll('[data-check]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(box.dataset.check);
      else state.selected.delete(box.dataset.check);
    });
  });
  container.querySelectorAll('[data-open]').forEach((node) => {
    node.addEventListener('click', () => openClip(node.dataset.open));
  });
}

async function scanSource(sourceId) {
  $('scan-status').textContent = 'escaneando…';
  await window.api.scanSource(sourceId);
  $('scan-status').textContent = 'escaneo completo';
  await refresh();
}

async function openClip(clipId) {
  state.activeClipId = clipId;
  renderClips();
  closeEditor();
  const result = await window.api.getResult(clipId);
  state.activeResult = result;
  const frame = $('guide-frame');
  const empty = $('guide-empty');
  if (!result) {
    frame.style.display = 'none';
    empty.style.display = 'grid';
    $('guide-title').textContent = 'Guía de edición';
    $('guide-files').innerHTML = '';
    $('open-guide').disabled = true;
    $('open-folder').disabled = true;
    $('edit-guide').disabled = true;
    return;
  }
  empty.style.display = 'none';
  frame.style.display = 'block';
  frame.srcdoc = result.html || `<pre>${result.markdown}</pre>`;
  $('guide-title').textContent = `Guía — ${result.clipName}${result.edited ? ' (editada)' : ''}`;
  $('guide-files').innerHTML = result.files
    .map((name) => `<span class="file-chip" data-file="${result.outDir}/${name}">${name}</span>`)
    .join('');
  $('guide-files').querySelectorAll('[data-file]').forEach((chip) => {
    chip.addEventListener('click', () => window.api.openPath(chip.dataset.file));
  });
  $('open-guide').disabled = false;
  $('open-folder').disabled = false;
  $('edit-guide').disabled = !result.edit;
  $('open-guide').onclick = () => window.api.openPath(`${result.outDir}/guide.md`);
  $('open-folder').onclick = () => window.api.openPath(result.outDir);
}

async function runPipeline(clipIds) {
  if (state.running) return;
  state.running = true;
  $('run-all').disabled = true;
  $('run-selected').disabled = true;
  $('cancel-run').disabled = false;
  const payload = clipIds && clipIds.length ? clipIds : null;
  try {
    const result = await window.api.run(payload);
    if (result && result.processed && result.processed.length) {
      const last = result.processed.filter((item) => item.ok).pop();
      if (last) await openClip(last.clipId);
    }
  } finally {
    state.running = false;
    $('run-all').disabled = false;
    $('run-selected').disabled = false;
    $('cancel-run').disabled = true;
    $('scan-status').textContent = '';
    await refresh();
  }
}

async function health() {
  const badge = $('llm-badge');
  badge.textContent = 'LLM…';
  badge.className = 'badge badge-muted';
  const result = await window.api.llmHealth();
  if (result.ok) {
    const port = (result.endpoint || '').replace(/\/v1$/, '').split(':').pop();
    badge.textContent = `LLM :${port}`;
    badge.title = result.endpoint;
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = 'LLM no disponible';
    badge.title = 'Arranca el servidor con: npm run llm';
    badge.className = 'badge badge-err';
  }
}

let searchTimer = null;
function onSearchInput(value) {
  state.searchQuery = value.trim();
  $('search-clear').hidden = !state.searchQuery;
  clearTimeout(searchTimer);
  if (!state.searchQuery) { state.searchResults = []; renderClips(); return; }
  searchTimer = setTimeout(async () => {
    state.searchResults = await window.api.search(state.searchQuery);
    if (state.searchQuery) renderClips();
  }, 220);
}

async function buildProject() {
  const button = $('project-guide');
  button.disabled = true;
  button.textContent = 'Generando…';
  try {
    const result = await window.api.buildProject();
    const frame = $('guide-frame');
    $('guide-empty').style.display = 'none';
    frame.style.display = 'block';
    frame.srcdoc = result.html || '<p>Guía de proyecto vacía.</p>';
    $('guide-title').textContent = 'Guía de proyecto';
    state.activeClipId = null;
    state.activeResult = null;
    closeEditor();
    $('edit-guide').disabled = true;
    const names = ['project-guide.md', 'project-guide.html', 'selects.csv'];
    $('guide-files').innerHTML = names
      .filter((name) => result.files[name])
      .map((name) => `<span class="file-chip" data-file="${result.files[name]}">${name}</span>`)
      .join('');
    $('guide-files').querySelectorAll('[data-file]').forEach((chip) => {
      chip.addEventListener('click', () => window.api.openPath(chip.dataset.file));
    });
    $('open-guide').disabled = false;
    $('open-folder').disabled = false;
    $('open-guide').onclick = () => window.api.openPath(result.files['project-guide.md']);
    $('open-folder').onclick = () => window.api.openPath(state.outRoot);
    $('scan-status').textContent = `${result.stats.clips} clips · ${result.stats.topics} temas`;
  } finally {
    button.disabled = false;
    button.textContent = 'Guía de proyecto';
  }
}

async function runExport(button, invoke) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Exportando…';
  try {
    const result = await invoke();
    if (result && result.ok) {
      $('scan-status').textContent = `${result.count} archivo(s) en ${result.folder}`;
      await window.api.openPath(result.folder);
    } else if (result && result.canceled) {
      $('scan-status').textContent = 'exportación cancelada';
    }
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function bind() {
  if ($('set-output')) {
    $('set-output').addEventListener('click', async () => {
      const result = await window.api.chooseOutputDir();
      if (result && result.outRoot) {
        state.outRoot = result.outRoot;
        const info = await window.api.info();
        if (info) state.outRoot = info.outRoot || state.outRoot;
        $('dbpath').title = info ? info.dbPath : $('dbpath').title;
        await refresh();
      }
    });
  }
  $('add-source').addEventListener('click', async () => {
    await window.api.addSource();
    await refresh();
  });
  $('run-all').addEventListener('click', () => runPipeline(null));
  $('project-guide').addEventListener('click', () => buildProject());
  $('export-md').addEventListener('click', () => runExport($('export-md'), () => window.api.exportMd()));
  $('export-srt').addEventListener('click', () => runExport($('export-srt'), () => window.api.exportSrt()));
  $('export-fcpxml').addEventListener('click', () => runExport($('export-fcpxml'), () => window.api.exportFcpxml()));
  $('edit-guide').addEventListener('click', () => openEditor());
  $('editor').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const model = readEditorForm();
      const row = remove.closest('.edit-row');
      model[row.dataset.kind].splice(Number(row.dataset.i), 1);
      renderEditor(model);
      return;
    }
    const add = event.target.closest('[data-add]');
    if (add) {
      const model = readEditorForm();
      model[add.dataset.add].push({ ...EDIT_BLANKS[add.dataset.add] });
      renderEditor(model);
      return;
    }
    if (event.target.id === 'edit-cancel') closeEditor();
    if (event.target.id === 'edit-save') saveEditor();
  });
  $('search-input').addEventListener('input', (event) => onSearchInput(event.target.value));
  $('search-clear').addEventListener('click', () => { $('search-input').value = ''; onSearchInput(''); });
  $('run-selected').addEventListener('click', () => runPipeline([...state.selected]));
  $('cancel-run').addEventListener('click', async () => {
    $('scan-status').textContent = 'cancelando…';
    await window.api.cancel();
  });
  $('select-all').addEventListener('click', () => {
    state.clips.forEach((clip) => state.selected.add(clip.id));
    renderClips();
  });
  $('select-none').addEventListener('click', () => {
    state.selected.clear();
    renderClips();
  });
  window.api.onScanProgress((payload) => {
    $('scan-status').textContent = `escaneando… ${payload.index} (${payload.file})`;
  });
  window.api.onPipelineProgress((payload) => {
    const labels = { claimed: 'en proceso', transcribing: 'transcribiendo', analyzing: 'analizando', exporting: 'exportando', done: 'listo', error: 'error' };
    $('scan-status').textContent = `${payload.clipId.slice(0, 8)}: ${labels[payload.state] || payload.state}`;
    if (payload.state === 'done') refresh();
  });
  if (window.api.onOutputChanged) {
    window.api.onOutputChanged((payload) => {
      if (payload && payload.outRoot) {
        state.outRoot = payload.outRoot;
      }
    });
  }
}

async function boot() {
  bind();
  const info = await window.api.info();
  $('dbpath').textContent = 'análisis local · sin copias';
  $('dbpath').title = info.dbPath;
  state.outRoot = info.outRoot;
  await health();
  await refresh();
}

boot();
