'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const whisper = require('./lib/whisper');
const media = require('./lib/media');
const grouping = require('./lib/grouping');
const { buildSrt } = require('./lib/formats/srt');
const { buildFcpxml } = require('./lib/formats/fcpxml');

let mainWindow = null;
let currentLanguage = 'es';
let activeController = null;
const downloadingModels = new Set();

const TEXT = {
  es: {
    about: 'Acerca de Panto SRT', aboutCredit: 'Panto SRT transcribe audio a subtítulos con timestamps reales, 100% local y privado. Exporta SRT y FCPXML para DaVinci Resolve.', hide: 'Ocultar Panto SRT', hideOthers: 'Ocultar otras', unhide: 'Mostrar todo', quit: 'Salir de Panto SRT',
    edit: 'Edición', undo: 'Deshacer', redo: 'Rehacer', cut: 'Cortar', copy: 'Copiar', paste: 'Pegar', selectAll: 'Seleccionar todo',
    window: 'Ventana', minimize: 'Minimizar', zoom: 'Zoom', front: 'Traer todo al frente',
    selectTitle: 'Selecciona un audio o video', compatible: 'Audio y video', audio: 'Audio', videos: 'Videos',
    unsupported: 'El archivo no tiene un formato compatible.',
    engineMissing: 'No se encontró el motor whisper. Ejecuta «npm run prepare:whisper» o instala whisper-cpp.',
    modelMissing: 'El modelo Whisper aún no está descargado. Panto SRT lo descargará ahora.'
  },
  en: {
    about: 'About Panto SRT', aboutCredit: 'Panto SRT turns voice into subtitles with real word-level timestamps, fully local and private. Exports SRT and FCPXML for DaVinci Resolve.', hide: 'Hide Panto SRT', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit Panto SRT',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    window: 'Window', minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front',
    selectTitle: 'Select an audio or video file', compatible: 'Audio and video', audio: 'Audio', videos: 'Videos',
    unsupported: 'The file format is not supported.',
    engineMissing: 'Whisper engine not found. Run «npm run prepare:whisper» or install whisper-cpp.',
    modelMissing: 'The Whisper model is not downloaded yet. Panto SRT will download it now.'
  }
};

function t(key) {
  return TEXT[currentLanguage][key];
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function assertTrustedEvent(event) {
  const expected = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
  if (!event.senderFrame || event.senderFrame.url !== expected) throw new Error('Untrusted renderer request.');
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 529,
    height: 736,
    useContentSize: true,
    minWidth: 480,
    minHeight: 220,
    title: 'Panto SRT',
    ...(isMac ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 } } : {}),
    backgroundColor: '#1d1d1f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  const rendererUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function createMenu() {
  if (process.platform === 'win32') {
    const es = currentLanguage === 'es';
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: es ? 'Archivo' : 'File', submenu: [{ role: 'quit', label: t('quit') }] },
      { label: t('edit'), submenu: [{ role: 'undo', label: t('undo') }, { role: 'redo', label: t('redo') }, { type: 'separator' }, { role: 'cut', label: t('cut') }, { role: 'copy', label: t('copy') }, { role: 'paste', label: t('paste') }, { role: 'selectAll', label: t('selectAll') }] },
      { label: t('window'), submenu: [{ role: 'minimize', label: t('minimize') }, { role: 'close', label: es ? 'Cerrar' : 'Close' }] },
      { label: es ? 'Ayuda' : 'Help', submenu: [{ label: t('about'), click: () => app.showAboutPanel() }] }
    ]));
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Panto SRT',
      submenu: [
        { role: 'about', label: t('about') },
        { type: 'separator' },
        { role: 'hide', label: t('hide') },
        { role: 'hideOthers', label: t('hideOthers') },
        { role: 'unhide', label: t('unhide') },
        { type: 'separator' },
        { role: 'quit', label: t('quit') }
      ]
    },
    { label: t('edit'), submenu: [{ role: 'undo', label: t('undo') }, { role: 'redo', label: t('redo') }, { type: 'separator' }, { role: 'cut', label: t('cut') }, { role: 'copy', label: t('copy') }, { role: 'paste', label: t('paste') }, { role: 'selectAll', label: t('selectAll') }] },
    { label: t('window'), submenu: [{ role: 'minimize', label: t('minimize') }, { role: 'zoom', label: t('zoom') }, { role: 'front', label: t('front') }] }
  ]));
}

function updateAboutPanel() {
  app.setAboutPanelOptions({
    applicationName: 'Panto SRT',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 Panto SRT',
    credits: t('aboutCredit'),
    website: ''
  });
}

app.whenReady().then(() => {
  updateAboutPanel();
  createMenu();
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('window:content-height', (event, height) => {
  assertTrustedEvent(event);
  if (!mainWindow) return;
  const value = Math.max(220, Math.min(768, Math.round(Number(height) || 0)));
  const [width] = mainWindow.getContentSize();
  mainWindow.setContentSize(width, value, false);
});

ipcMain.handle('set-language', async (event, language) => {
  assertTrustedEvent(event);
  if (!TEXT[language]) return false;
  currentLanguage = language;
  updateAboutPanel();
  createMenu();
  return true;
});

ipcMain.handle('select-media', async (event) => {
  assertTrustedEvent(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('selectTitle'),
    properties: ['openFile'],
    filters: [
      { name: t('compatible'), extensions: [...new Set([...media.AUDIO_EXTENSIONS, ...media.VIDEO_EXTENSIONS])].map((extension) => extension.slice(1)) },
      { name: t('audio'), extensions: [...media.AUDIO_EXTENSIONS].map((extension) => extension.slice(1)) },
      { name: t('videos'), extensions: [...media.VIDEO_EXTENSIONS].map((extension) => extension.slice(1)) }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return media.fileDetails(result.filePaths[0]);
});

ipcMain.handle('inspect-media', async (event, filePath) => {
  assertTrustedEvent(event);
  if (!media.isSupported(filePath) || !fs.existsSync(filePath)) throw new Error(t('unsupported'));
  return media.fileDetails(filePath);
});

ipcMain.handle('list-models', async (event) => {
  assertTrustedEvent(event);
  return whisper.listModels();
});

ipcMain.handle('download-model', async (event, modelId) => {
  assertTrustedEvent(event);
  if (!whisper.modelMeta(modelId)) throw new Error('Modelo desconocido.');
  if (downloadingModels.has(modelId)) throw new Error('Este modelo ya se está descargando.');
  downloadingModels.add(modelId);
  try {
    send('model-download-status', { model: modelId, status: 'downloading', percent: 0 });
    await whisper.downloadModel(modelId, (percent) => {
      send('model-download-status', { model: modelId, status: 'downloading', percent });
    });
    send('model-download-status', { model: modelId, status: 'downloaded', percent: 100 });
    return whisper.listModels();
  } finally {
    downloadingModels.delete(modelId);
  }
});

ipcMain.handle('delete-model', async (event, modelId) => {
  assertTrustedEvent(event);
  if (downloadingModels.has(modelId)) throw new Error('Espera a que termine la descarga antes de borrar el modelo.');
  whisper.deleteModel(modelId);
  return whisper.listModels();
});

ipcMain.handle('transcribe-media', async (event, filePath, options) => {
  assertTrustedEvent(event);
  options = options && typeof options === 'object' ? options : {};
  if (!media.isSupported(filePath) || !fs.existsSync(filePath)) throw new Error(t('unsupported'));
  const modelId = whisper.modelMeta(options.model) ? options.model : 'turbo';

  if (!whisper.findModel(modelId)) {
    send('transcription-status', { status: 'model-download', model: modelId });
    await whisper.downloadModel(modelId, (percent) => send('transcription-progress', { phase: 'model', model: modelId, percent }));
    send('transcription-status', { status: 'model-ready', model: modelId });
  }

  const controller = new AbortController();
  activeController = controller;
  try {
    send('transcription-status', { status: 'starting' });
    const result = await whisper.transcribe(filePath, {
      model: modelId,
      language: options.language,
      duration: Number(options.mediaDuration) || undefined,
      signal: controller.signal,
      onProgress: (percent) => send('transcription-progress', { phase: 'transcribe', model: modelId, percent }),
      onStatus: (status) => send('transcription-status', { ...status, model: modelId })
    });
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('cancelled');
    if (error.message === 'engine-missing') throw new Error(t('engineMissing'));
    if (error.message.startsWith('model-missing:')) throw new Error(t('modelMissing'));
    throw error;
  } finally {
    activeController = null;
  }
});

ipcMain.handle('cancel-transcription', async (event) => {
  assertTrustedEvent(event);
  if (!activeController) return false;
  activeController.abort();
  send('transcription-status', { status: 'cancelling' });
  return true;
});

ipcMain.handle('group-clips', async (event, words, options) => {
  assertTrustedEvent(event);
  if (!Array.isArray(words)) return [];
  return grouping.buildClips(words, options || {});
});

function uniqueOutputPath(sourcePath, suffix, extension) {
  const directory = path.dirname(sourcePath);
  const name = path.basename(sourcePath, path.extname(sourcePath));
  let candidate = path.join(directory, `${name}${suffix}${extension}`);
  let count = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${name}${suffix}-${count}${extension}`);
    count += 1;
  }
  return candidate;
}

function validateClips(clips) {
  if (!Array.isArray(clips) || !clips.length) throw new Error('No hay clips para exportar.');
  for (const clip of clips) {
    if (!clip || !clip.text || Number.isNaN(Number(clip.start * 0)) || Number.isNaN(Number(clip.end * 0))) {
      throw new Error('Clip inválido.');
    }
  }
  return clips;
}

ipcMain.handle('export-subtitles', async (_event, sourcePath, format, clips, options) => {
  assertTrustedEvent(_event);
  options = options && typeof options === 'object' ? options : {};
  if (!media.isSupported(sourcePath) || !fs.existsSync(sourcePath)) throw new Error(t('unsupported'));
  validateClips(clips);
  const offset = Number(options.timecodeBase) || 0;
  const fps = Math.min(120, Math.max(1, Number(options.fps) || 25));

  let outputPath;
  if (format === 'fcpxml') {
    const suffix = currentLanguage === 'es' ? '-subtítulos' : '-subtitles';
    outputPath = uniqueOutputPath(sourcePath, suffix, '.xml');
    fs.writeFileSync(outputPath, buildFcpxml(clips, { fps, timecodeBase: offset, sourcePath }), 'utf8');
  } else if (format === 'srt') {
    outputPath = uniqueOutputPath(sourcePath, '', '.srt');
    fs.writeFileSync(outputPath, buildSrt(clips, offset), 'utf8');
  } else {
    throw new Error(`Formato desconocido: ${format}`);
  }
  return { outputPath, bytes: fs.statSync(outputPath).size };
});

ipcMain.handle('show-in-folder', async (_event, filePath) => {
  assertTrustedEvent(_event);
  if (typeof filePath === 'string' && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});
