'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./lib/store');
const { createLibrary } = require('./lib/library');
const { createQueue } = require('./lib/queue');
const { createPipeline } = require('./lib/pipeline');
const { createAnalyzer, endpointCandidates, reachable } = require('./lib/analysis');
const { buildProject, writeProject, backfill, exportMarkdownFiles, exportSrtFiles, exportFcpxmlFiles } = require('./lib/project');
const { applyEdits } = require('./lib/edit');
const { loadConfig, saveConfig } = require('./lib/config');

const APP_NAME = 'PantoScan';
const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'icons', 'pantoscan.png');

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), 'documental-editor'));

let mainWindow = null;
let store = null;
let library = null;
let queue = null;
let pipeline = null;
let running = false;
let runController = null;

function outRoot() {
  const config = loadConfig();
  return config.outputDir || path.join(app.getPath('userData'), 'out');
}

function init() {
  const dbPath = path.join(app.getPath('userData'), 'library.db');
  store = new Store(dbPath);
  library = createLibrary(store);
  queue = createQueue(store);
  const recovered = queue.requeueStale();
  if (recovered) console.log(`[init] jobs colgados reencolados: ${recovered}`);
  pipeline = createPipeline({
    store, queue, library,
    outRoot: outRoot(),
    logger: () => {}
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#14151a',
    title: APP_NAME,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('app:info', () => {
  const config = loadConfig();
  return {
    dbPath: path.join(app.getPath('userData'), 'library.db'),
    outRoot: outRoot(),
    outputDir: config.outputDir || null,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node
    }
  };
});

ipcMain.handle('library:summary', () => library.summary());
ipcMain.handle('sources:list', () => library.listSources());
ipcMain.handle('clips:list', () => library.listClips());
ipcMain.handle('queue:stats', () => queue.stats());
ipcMain.handle('results:list', () => store.listResults().map((row) => ({
  clipId: row.clip_id,
  clipName: row.clip_name,
  relPath: row.rel_path,
  volumeName: row.volume_name,
  outDir: row.out_dir,
  guidePath: row.guide_path,
  summary: row.summary,
  edited: Boolean(row.edited),
  updatedAt: row.updated_at
})));

ipcMain.handle('sources:add', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Agregar carpeta de material',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const source = library.addSource(result.filePaths[0]);
  return source;
});

ipcMain.handle('sources:scan', (_event, sourceId) => {
  const result = library.scanSource(sourceId, {
    onProgress: ({ index, file }) => send('scan:progress', { sourceId, index, file })
  });
  return result;
});

ipcMain.handle('sources:remove', (_event, sourceId) => {
  library.removeSource(sourceId);
  return true;
});

ipcMain.handle('queue:enqueue', (_event, clipIds) => queue.enqueue(clipIds));

ipcMain.handle('pipeline:run', async (_event, clipIds) => {
  if (running) return { started: false, reason: 'busy' };
  running = true;
  runController = new AbortController();
  const signal = runController.signal;
  const selected = clipIds && clipIds.length ? clipIds : library.listClips().filter((clip) => clip.online).map((clip) => clip.id);
  queue.enqueue(selected);
  const processed = [];
  let cancelled = false;
  try {
    const pending = queue.stats().pending;
    for (let index = 0; index < pending; index += 1) {
      if (signal.aborted) { cancelled = true; break; }
      const claimed = queue.claimNext();
      if (!claimed) break;
      send('pipeline:progress', { clipId: claimed.clip_id, state: 'claimed' });
      try {
        const result = await pipeline.processClip(claimed.clip_id, {
          signal,
          onState: (state, extra) => send('pipeline:progress', { clipId: claimed.clip_id, state, extra })
        });
        processed.push({ clipId: claimed.clip_id, ok: true, outDir: result.written.dir });
      } catch (error) {
        if (error.name === 'AbortError') { cancelled = true; }
        processed.push({ clipId: claimed.clip_id, ok: false, error: error.message });
      }
      send('pipeline:progress', { clipId: claimed.clip_id, state: 'settled', ok: processed[processed.length - 1].ok });
      if (cancelled) break;
    }
  } finally {
    running = false;
    runController = null;
  }
  return { started: true, cancelled, processed, stats: queue.stats() };
});

ipcMain.handle('pipeline:cancel', () => {
  if (runController) { runController.abort(); return true; }
  return false;
});

function readResultBundle(clipId) {
  const result = store.getResult(clipId);
  if (!result) return null;
  let markdown = '';
  let html = '';
  try { markdown = fs.readFileSync(path.join(result.out_dir, 'guide.md'), 'utf8'); } catch (_) {}
  try { html = fs.readFileSync(path.join(result.out_dir, 'guide.html'), 'utf8'); } catch (_) {}
  let edit = null;
  try { edit = JSON.parse(fs.readFileSync(path.join(result.out_dir, 'edit.json'), 'utf8')); } catch (_) {}
  return {
    clipId,
    clipName: result.clip_name,
    outDir: result.out_dir,
    summary: result.summary,
    edited: Boolean(result.edited),
    markdown,
    html,
    edit,
    files: fs.existsSync(result.out_dir) ? fs.readdirSync(result.out_dir) : []
  };
}

ipcMain.handle('result:get', (_event, clipId) => readResultBundle(clipId));

ipcMain.handle('result:save', (_event, clipId, changes) => {
  const previous = readResultBundle(clipId);
  if (!previous || !previous.edit) return { ok: false, error: 'sin edición previa' };
  const edited = applyEdits(previous.edit, changes || {});
  pipeline.regenerateFromEdit(clipId, edited);
  return { ok: true, ...readResultBundle(clipId) };
});

ipcMain.handle('search:query', (_event, query) => {
  backfill(store);
  const rows = store.search(query, 100);
  return rows.map((row) => ({
    clipId: row.clip_id,
    clipName: row.clip_name,
    section: row.section,
    label: row.label,
    start: row.start,
    end: row.end,
    text: row.text
  }));
});

ipcMain.handle('project:build', () => {
  const bundle = buildProject(store);
  const written = writeProject(outRoot(), bundle);
  let html = '';
  try { html = fs.readFileSync(written['project-guide.html'], 'utf8'); } catch (_) {}
  return { files: written, html, stats: bundle.stats };
});

async function pickExportFolder(title) {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title,
    buttonLabel: 'Exportar aquí',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('documents')
  });
  if (picked.canceled || !picked.filePaths.length) return null;
  return picked.filePaths[0];
}

ipcMain.handle('export:md', async () => {
  backfill(store);
  writeProject(outRoot(), buildProject(store));
  const base = await pickExportFolder('Elige dónde crear la carpeta de exportación (.md)');
  if (!base) return { ok: false, canceled: true };
  return { ok: true, ...exportMarkdownFiles(store, outRoot(), base) };
});

ipcMain.handle('export:srt', async () => {
  const base = await pickExportFolder('Elige dónde crear la carpeta de subtítulos (.srt)');
  if (!base) return { ok: false, canceled: true };
  return { ok: true, kind: 'srt', ...exportSrtFiles(store, outRoot(), base) };
});

ipcMain.handle('export:fcpxml', async () => {
  const base = await pickExportFolder('Elige dónde crear la carpeta de timelines (.fcpxml)');
  if (!base) return { ok: false, canceled: true };
  return { ok: true, kind: 'fcpxml', ...exportFcpxmlFiles(store, outRoot(), base) };
});

ipcMain.handle('project:get', () => {
  const target = path.join(outRoot(), 'project-guide.html');
  if (!fs.existsSync(target)) return null;
  try { return fs.readFileSync(target, 'utf8'); } catch (_) { return null; }
});

ipcMain.handle('output:get', () => ({ outputDir: loadConfig().outputDir || null, outRoot: outRoot() }));
ipcMain.handle('output:set', (_event, dir) => {
  if (!dir || typeof dir !== 'string') return { ok: false };
  const normalized = path.resolve(dir);
  try { fs.mkdirSync(normalized, { recursive: true }); } catch (_) {}
  saveConfig({ outputDir: normalized });
  if (pipeline && typeof pipeline.setOutRoot === 'function') {
    pipeline.setOutRoot(normalized);
  } else if (pipeline) {
    pipeline._outRoot = normalized;
  }
  send('output:changed', { outRoot: normalized });
  return { ok: true, outRoot: normalized };
});
ipcMain.handle('output:choose', async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Elegir carpeta para guardar transcripciones y guías',
    buttonLabel: 'Usar esta carpeta',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: loadConfig().outputDir || app.getPath('documents')
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
  return ipcMain.invoke('output:set', picked.filePaths[0]);
});

ipcMain.handle('open:path', (_event, target) => shell.openPath(target));
ipcMain.handle('open:external', (_event, target) => shell.openExternal(target));

ipcMain.handle('llm:health', async () => {
  const analyzer = createAnalyzer();
  for (const candidate of endpointCandidates()) {
    if (await reachable(globalThis.fetch, candidate, 2500)) {
      return { ok: true, endpoint: candidate, taxonomy: analyzer.taxonomy };
    }
  }
  return { ok: false, endpoint: null, taxonomy: analyzer.taxonomy };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock && fs.existsSync(APP_ICON)) app.dock.setIcon(APP_ICON);
    init();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (store) store.close();
  if (process.platform !== 'darwin') app.quit();
});
