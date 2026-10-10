'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  summary: () => ipcRenderer.invoke('library:summary'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  listClips: () => ipcRenderer.invoke('clips:list'),
  queueStats: () => ipcRenderer.invoke('queue:stats'),
  listResults: () => ipcRenderer.invoke('results:list'),
  addSource: () => ipcRenderer.invoke('sources:add'),
  scanSource: (sourceId) => ipcRenderer.invoke('sources:scan', sourceId),
  removeSource: (sourceId) => ipcRenderer.invoke('sources:remove', sourceId),
  enqueue: (clipIds) => ipcRenderer.invoke('queue:enqueue', clipIds),
  run: (clipIds) => ipcRenderer.invoke('pipeline:run', clipIds),
  cancel: () => ipcRenderer.invoke('pipeline:cancel'),
  getResult: (clipId) => ipcRenderer.invoke('result:get', clipId),
  saveEdit: (clipId, changes) => ipcRenderer.invoke('result:save', clipId, changes),
  search: (query) => ipcRenderer.invoke('search:query', query),
  buildProject: () => ipcRenderer.invoke('project:build'),
  exportMd: () => ipcRenderer.invoke('export:md'),
  exportSrt: () => ipcRenderer.invoke('export:srt'),
  exportFcpxml: () => ipcRenderer.invoke('export:fcpxml'),
  getProject: () => ipcRenderer.invoke('project:get'),
  openPath: (target) => ipcRenderer.invoke('open:path', target),
  llmHealth: () => ipcRenderer.invoke('llm:health'),
  onScanProgress: (handler) => ipcRenderer.on('scan:progress', (_event, payload) => handler(payload)),
  onPipelineProgress: (handler) => ipcRenderer.on('pipeline:progress', (_event, payload) => handler(payload))
});
