'use strict';

const TEXT = {
  es: {
    dropTitle: 'Audio a subtítulos',
    dropHint: 'arrastra un archivo o haz clic para abrir',
    generate: 'Generar subtítulos',
    exportSrt: 'Exportar SRT',
    exportXml: 'Exportar FCPXML',
    modelLabel: 'Modelo Whisper',
    modelReadyToDownload: 'No descargado',
    modelDownloaded: 'Descargado',
    modelBundled: 'Incluido con la app',
    download: 'Descargar',
    downloading: (percent) => `Descargando ${percent}%`,
    deleteModel: 'Borrar modelo',
    modelRequired: 'Descarga el modelo seleccionado antes de generar subtítulos.',
    cancel: 'Cancelar',
    downloadingModel: 'Descargando modelo…',
    modelReady: 'Modelo listo',
    transcribing: 'Transcribiendo…',
    cancelling: 'Cancelando…',
    editing: 'clips',
    regroup: 'Reagrupar',
    ready: 'Listo',
    exportReady: 'Exportado',
    exportDetails: (name) => `Guardado junto al original`,
    details: (count, duration) => `${count} clips · ${duration}`,
    revealed: 'Mostrar en Finder',
    selectFileFirst: 'Selecciona un audio o video primero.',
    lightTheme: 'Cambiar a modo claro',
    darkTheme: 'Cambiar a modo oscuro'
  },
  en: {
    dropTitle: 'Audio to subtitles',
    dropHint: 'drop a file or click to open',
    generate: 'Generate subtitles',
    exportSrt: 'Export SRT',
    exportXml: 'Export FCPXML',
    modelLabel: 'Whisper model',
    modelReadyToDownload: 'Not downloaded',
    modelDownloaded: 'Downloaded',
    modelBundled: 'Included with the app',
    download: 'Download',
    downloading: (percent) => `Downloading ${percent}%`,
    deleteModel: 'Delete model',
    modelRequired: 'Download the selected model before generating subtitles.',
    cancel: 'Cancel',
    downloadingModel: 'Downloading model…',
    modelReady: 'Model ready',
    transcribing: 'Transcribing…',
    cancelling: 'Cancelling…',
    editing: 'clips',
    regroup: 'Regroup',
    ready: 'Done',
    exportReady: 'Exported',
    exportDetails: () => `Saved next to the original`,
    details: (count, duration) => `${count} clips · ${duration}`,
    revealed: 'Reveal in Finder',
    selectFileFirst: 'Select an audio or video file first.',
    lightTheme: 'Switch to light mode',
    darkTheme: 'Switch to dark mode'
  }
};

const SUBTITLE_DEFAULTS = { maxChars: 42, maxDuration: 3.5, minGap: 0.2, model: 'turbo', lang: 'auto', fps: 25 };

const state = {
  appLang: 'es',
  file: null,
  words: null,
  clips: [],
  transcribing: false,
  lastExport: null,
  models: [],
  selectedModel: localStorage.getItem('panto-srt-model') || SUBTITLE_DEFAULTS.model,
  modelDownload: null
};

const $ = (id) => document.getElementById(id);
const languageToggle = $('languageToggle');
const themeToggle = $('themeToggle');

function applyTheme(theme) {
  const isDark = theme !== 'light';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  themeToggle.setAttribute('aria-label', isDark ? u('lightTheme') : u('darkTheme'));
  themeToggle.title = isDark ? u('lightTheme') : u('darkTheme');
  localStorage.setItem('panto-srt-theme', isDark ? 'dark' : 'light');
}

const SHELL_PAD_TOP = 46;
const SHELL_PAD_BOTTOM = 18;
const SHELL_GAP = 12;

function measureContentHeight() {
  const shell = document.querySelector('.shell');
  let total = SHELL_PAD_TOP;
  let first = true;
  for (const child of shell.children) {
    if (child.classList.contains('hidden')) continue;
    if (!first) total += SHELL_GAP;
    first = false;
    total += child.offsetHeight;
  }
  return Math.ceil(total + SHELL_PAD_BOTTOM);
}

function requestWindowHeight() {
  const hasEditor = !$('editorPanel').classList.contains('hidden');
  const height = hasEditor ? 736 : measureContentHeight();
  window.pantoSRT.setContentHeight(Math.max(220, Math.min(768, height)));
}

function u(key, ...args) {
  const value = TEXT[state.appLang][key];
  return typeof value === 'function' ? value(...args) : value;
}

function setUiLanguage(lang) {
  state.appLang = lang;
  document.documentElement.lang = lang;
  languageToggle.textContent = lang === 'es' ? 'EN' : 'ES';
  languageToggle.title = lang === 'es' ? 'Cambiar a inglés' : 'Cambiar a español';
  $('dropTitle').textContent = u('dropTitle');
  $('dropHint').textContent = u('dropHint');
  $('generateButton').textContent = u('generate');
  $('exportSrtButton').textContent = u('exportSrt');
  $('exportXmlButton').textContent = u('exportXml');
  $('cancelButton').textContent = u('cancel');
  $('regroupButton').textContent = u('regroup');
  $('modelLabel').textContent = u('modelLabel');
  $('modelDeleteButton').setAttribute('aria-label', u('deleteModel'));
  $('modelDeleteButton').title = u('deleteModel');
  renderModelManager();
}

function currentModel() {
  return state.models.find((model) => model.id === state.selectedModel) || null;
}

function renderModelManager() {
  const select = $('modelSelect');
  const selected = currentModel();
  select.textContent = '';
  state.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.selected = model.id === state.selectedModel;
    option.textContent = `${model.label} · ${model.size}`;
    select.append(option);
  });
  if (state.models.length && !selected) {
    state.selectedModel = state.models[0].id;
    select.value = state.selectedModel;
  }
  const model = currentModel();
  const isDownloading = state.modelDownload && state.modelDownload.id === state.selectedModel;
  const downloadButton = $('modelDownloadButton');
  const deleteButton = $('modelDeleteButton');
  select.disabled = state.transcribing || Boolean(isDownloading);
  downloadButton.disabled = state.transcribing || !model || model.available || Boolean(isDownloading);
  downloadButton.classList.toggle('hidden', Boolean(model && model.available));
  deleteButton.classList.toggle('hidden', !model || !model.removable || Boolean(isDownloading));
  deleteButton.disabled = state.transcribing || Boolean(isDownloading);
  if (isDownloading) {
    const percent = Math.round(state.modelDownload.percent || 0);
    $('modelState').textContent = u('downloading', percent);
    downloadButton.textContent = u('downloading', percent);
  } else if (model) {
    $('modelState').textContent = model.downloaded ? u('modelDownloaded') : model.available ? u('modelBundled') : u('modelReadyToDownload');
    downloadButton.textContent = u('download');
  } else {
    $('modelState').textContent = '';
    downloadButton.textContent = u('download');
  }
}

async function refreshModels() {
  state.models = await window.pantoSRT.listModels();
  if (!state.models.some((model) => model.id === state.selectedModel)) state.selectedModel = SUBTITLE_DEFAULTS.model;
  renderModelManager();
}

function secondsToStamp(seconds, includeMillis = true) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const secs = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const body = `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  return includeMillis ? `${body},${pad(millis, 3)}` : body;
}

function formatDuration(totalSeconds) {
  const total = Math.round(Number(totalSeconds) || 0);
  if (!total) return '';
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let index = -1;
  let size = value;
  do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
}

function rowLabel(clip) {
  return `${secondsToStamp(clip.start)} → ${secondsToStamp(clip.end)}`;
}

function renderClipRows() {
  const list = $('clipList');
  list.textContent = '';
  state.clips.forEach((clip, index) => {
    const row = document.createElement('div');
    row.className = 'clip-row';

    const indexCell = document.createElement('span');
    indexCell.className = 'clip-index';
    indexCell.textContent = String(clip.index);

    const rangeCell = document.createElement('span');
    rangeCell.className = 'clip-range';
    rangeCell.dataset.index = index;

    const textInput = document.createElement('input');
    textInput.className = 'clip-text';
    textInput.type = 'text';
    textInput.value = clip.text;
    textInput.spellcheck = false;
    textInput.addEventListener('input', () => { state.clips[index].text = textInput.value; });

    row.append(indexCell, rangeCell, textInput);
    list.append(row);
  });
  refreshRanges();
  $('editorCount').textContent = `${state.clips.length} ${u('editing')}`;
}

function refreshRanges() {
  state.clips.forEach((clip, index) => {
    const cell = document.querySelector(`.clip-range[data-index="${index}"]`);
    if (cell) cell.textContent = rowLabel(clip);
  });
}

function showError(message) {
  const el = $('errorMessage');
  if (!message) { el.classList.add('hidden'); return; }
  el.textContent = message;
  el.classList.remove('hidden');
}

function showResult(titleKey, details = '', revealPath = null) {
  $('resultTitle').textContent = u(titleKey);
  $('resultDetails').textContent = details;
  $('resultReveal').classList.toggle('hidden', !revealPath);
  $('resultPanel').classList.remove('hidden');
  if (revealPath) state.lastExport = { path: revealPath, button: $('resultReveal') };
}

function hideResult() {
  $('resultPanel').classList.add('hidden');
  state.lastExport = null;
}

function setBusy(busy) {
  state.transcribing = busy;
  $('generateButton').disabled = busy || !state.file;
  $('cancelButton').classList.toggle('hidden', !busy);
  $('dropZone').style.pointerEvents = busy ? 'none' : '';
  renderModelManager();
}

async function pickFromDialog() {
  const file = await window.pantoSRT.selectMedia();
  if (file) setFile(file);
}

function setFile(file) {
  state.file = { ...file };
  state.words = null;
  state.clips = [];
  hideResult();
  showError('');
  $('dropZone').classList.add('hidden');
  $('fileCard').classList.remove('hidden');
  $('fileName').textContent = file.name;
  const meta = [formatBytes(file.size), file.duration ? formatDuration(file.duration) : ''].filter(Boolean).join(' · ');
  $('fileMeta').textContent = meta;
  $('editorPanel').classList.add('hidden');
  $('generateButton').classList.remove('hidden');
  $('exportSrtButton').classList.add('hidden');
  $('exportXmlButton').classList.add('hidden');
  $('generateButton').disabled = false;
}

function reset() {
  state.file = null;
  state.words = null;
  state.clips = [];
  state.lastExport = null;
  showError('');
  hideResult();
  $('fileCard').classList.add('hidden');
  $('dropZone').classList.remove('hidden');
  $('editorPanel').classList.add('hidden');
  $('progressPanel').classList.add('hidden');
  $('generateButton').disabled = true;
  $('generateButton').classList.remove('hidden');
  $('exportSrtButton').classList.add('hidden');
  $('exportXmlButton').classList.add('hidden');
  $('cancelButton').classList.add('hidden');
}

function setProgress(percent, label) {
  $('progressPercent').textContent = `${Math.round(Number(percent) || 0)}%`;
  $('progressBar').style.width = `${Math.min(100, Math.max(0, percent))}%`;
  if (label) $('progressLabel').textContent = label;
  $('progressTime').textContent = '';
}

async function generate() {
  if (!state.file) { showError(u('selectFileFirst')); return; }
  const model = currentModel();
  if (!model || !model.available) { showError(u('modelRequired')); return; }
  showError('');
  hideResult();
  setBusy(true);
  $('editorPanel').classList.add('hidden');
  $('progressPanel').classList.remove('hidden');
  setProgress(0, u('transcribing'));

  try {
    const result = await window.pantoSRT.transcribeMedia(state.file.path, {
      model: state.selectedModel,
      language: SUBTITLE_DEFAULTS.lang,
      mediaDuration: state.file.duration
    });
    state.words = result.words;
    state.clips = await window.pantoSRT.groupClips(result.words, SUBTITLE_DEFAULTS);
    $('progressPanel').classList.add('hidden');
    $('editorPanel').classList.remove('hidden');
    $('exportSrtButton').classList.remove('hidden');
    $('exportXmlButton').classList.remove('hidden');
    renderClipRows();
    showResult('ready', u('details', state.clips.length, formatDuration(result.duration || 0)));
  } catch (error) {
    $('progressPanel').classList.add('hidden');
    if (error && error.message !== 'cancelled') showError(error.message || 'Error');
  } finally {
    setBusy(false);
  }
}

async function regroup() {
  if (!state.words || !state.words.length) return;
  const previous = new Map(state.clips.map((clip) => [Number(clip.start).toFixed(3), clip.text]));
  const next = await window.pantoSRT.groupClips(state.words, SUBTITLE_DEFAULTS);
  next.forEach((clip) => {
    const edited = previous.get(Number(clip.start).toFixed(3));
    if (edited !== undefined) clip.text = edited;
  });
  state.clips = next;
  renderClipRows();
  showResult('ready', u('details', state.clips.length, formatDuration(state.file.duration || 0)));
}

async function exportSubtitle(format) {
  if (!state.clips.length) return;
  showError('');
  try {
    const result = await window.pantoSRT.exportSubtitles(state.file.path, format, state.clips, {
      timecodeBase: 0,
      fps: SUBTITLE_DEFAULTS.fps
    });
    showResult('exportReady', u('exportDetails', result.path), result.outputPath);
  } catch (error) {
    showError((error && error.message) || 'Error');
  }
}

function wireEvents() {
  $('dropZone').addEventListener('click', pickFromDialog);
  $('removeButton').addEventListener('click', reset);
  $('generateButton').addEventListener('click', generate);
  $('modelSelect').addEventListener('change', (event) => {
    state.selectedModel = event.target.value;
    localStorage.setItem('panto-srt-model', state.selectedModel);
    renderModelManager();
  });
  $('modelDownloadButton').addEventListener('click', async () => {
    const modelId = state.selectedModel;
    showError('');
    try {
      state.modelDownload = { id: modelId, percent: 0 };
      renderModelManager();
      state.models = await window.pantoSRT.downloadModel(modelId);
    } catch (error) {
      showError((error && error.message) || 'Error');
    } finally {
      state.modelDownload = null;
      renderModelManager();
    }
  });
  $('modelDeleteButton').addEventListener('click', async () => {
    const model = currentModel();
    if (!model || !model.removable) return;
    showError('');
    try {
      state.models = await window.pantoSRT.deleteModel(model.id);
      renderModelManager();
    } catch (error) {
      showError((error && error.message) || 'Error');
    }
  });
  $('cancelButton').addEventListener('click', () => window.pantoSRT.cancelTranscription());

  $('regroupButton').addEventListener('click', regroup);
  $('exportSrtButton').addEventListener('click', () => exportSubtitle('srt'));
  $('exportXmlButton').addEventListener('click', () => exportSubtitle('fcpxml'));

  $('resultReveal').addEventListener('click', () => {
    if (state.lastExport) window.pantoSRT.showInFolder(state.lastExport.path);
  });

  languageToggle.addEventListener('click', async () => {
    const next = state.appLang === 'es' ? 'en' : 'es';
    await window.pantoSRT.setLanguage(next);
    setUiLanguage(next);
  });

  themeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  const dropZone = $('dropZone');
  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!state.file && event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault();
      dragDepth += 1;
      dropZone.classList.add('dragging');
    }
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.remove('dragging');
  });
  document.addEventListener('dragover', (event) => {
    if (!state.file) event.preventDefault();
  });
  document.addEventListener('drop', async (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
    dragDepth = 0;
    if (state.file || !event.dataTransfer.files.length) return;
    const filePath = window.pantoSRT.pathForFile(event.dataTransfer.files[0]);
    try {
      const details = await window.pantoSRT.inspectMedia(filePath);
      setFile(details);
    } catch (_) {
      showError(state.appLang === 'es' ? 'Formato no compatible.' : 'Format not supported.');
    }
  });

  const unsubStatus = window.pantoSRT.onTranscriptionStatus((payload) => {
    if (payload.status === 'model-download') setProgress(0, u('downloadingModel'));
    else if (payload.status === 'model-ready') setProgress(0, u('modelReady'));
    else if (payload.status === 'starting') setProgress(0, u('transcribing'));
    else if (payload.status === 'cancelling') setProgress(0, u('cancelling'));
  });
  window.pantoSRT.onTranscriptionProgress((payload) => {
    if (payload.phase === 'model') setProgress(payload.percent, u('downloadingModel'));
    else setProgress(payload.percent);
  });
  const unsubModelDownload = window.pantoSRT.onModelDownloadStatus((payload) => {
    if (!state.modelDownload || payload.model !== state.modelDownload.id) return;
    state.modelDownload.percent = payload.percent;
    renderModelManager();
  });
  window.addEventListener('beforeunload', unsubStatus);
  window.addEventListener('beforeunload', unsubModelDownload);
}

window.addEventListener('DOMContentLoaded', () => {
  $('resultReveal').textContent = window.pantoSRT.platform === 'darwin' ? '⌘' : '◎';
  setUiLanguage('es');
  applyTheme(localStorage.getItem('panto-srt-theme') || 'dark');
  const sizeObserver = new MutationObserver(requestWindowHeight);
  document.querySelectorAll('.shell > *').forEach((el) => {
    sizeObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  requestWindowHeight();
  wireEvents();
  refreshModels().catch((error) => showError((error && error.message) || 'Error'));
});
