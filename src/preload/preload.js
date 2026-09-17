'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pantoSRT', {
  platform: process.platform,
  selectMedia: () => ipcRenderer.invoke('select-media'),
  inspectMedia: (filePath) => ipcRenderer.invoke('inspect-media', filePath),
  listModels: () => ipcRenderer.invoke('list-models'),
  downloadModel: (modelId) => ipcRenderer.invoke('download-model', modelId),
  deleteModel: (modelId) => ipcRenderer.invoke('delete-model', modelId),
  transcribeMedia: (filePath, options) => ipcRenderer.invoke('transcribe-media', filePath, options),
  cancelTranscription: () => ipcRenderer.invoke('cancel-transcription'),
  groupClips: (words, options) => ipcRenderer.invoke('group-clips', words, options),
  exportSubtitles: (sourcePath, format, clips, options) => ipcRenderer.invoke('export-subtitles', sourcePath, format, clips, options),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  setLanguage: (language) => ipcRenderer.invoke('set-language', language),
  setContentHeight: (height) => ipcRenderer.send('window:content-height', height),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onTranscriptionStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('transcription-status', listener);
    return () => ipcRenderer.removeListener('transcription-status', listener);
  },
  onTranscriptionProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('transcription-progress', listener);
    return () => ipcRenderer.removeListener('transcription-progress', listener);
  },
  onModelDownloadStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('model-download-status', listener);
    return () => ipcRenderer.removeListener('model-download-status', listener);
  }
});
