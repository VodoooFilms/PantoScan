'use strict';

const path = require('path');

const AUDIO_EXTENSIONS = new Set([
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aif', '.aiff', '.caf', '.wma'
]);

const VIDEO_EXTENSIONS = new Set([
  '.mov', '.mp4', '.m4v', '.avi', '.mkv', '.webm', '.mpg', '.mpeg', '.m2ts', '.mts', '.ts',
  '.mxf', '.r3d', '.braw', '.ari', '.crm', '.dng', '.mp4'
]);

const IGNORED_DIRECTORIES = new Set([
  '.fseventsd', '.Spotlight-V100', '.Trashes', '.TemporaryItems', '.DocumentRevisions-V100',
  '$RECYCLE.BIN', 'System Volume Information', 'Adobe Premiere Pro Auto-Save',
  'Adobe Premiere Pro Audio Previews', 'Adobe Premiere Pro Video Previews', 'Adobe Premiere Pro Captured Video',
  '.git', 'node_modules',
  'Exports', 'Render', 'renders', 'Previews'
]);

function mediaTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.d.ts')) return null;
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

function isSupported(filePath) {
  return typeof filePath === 'string' && mediaTypeForFile(filePath) !== null;
}

function isIgnoredDirectory(name) {
  return IGNORED_DIRECTORIES.has(name);
}

module.exports = {
  mediaTypeForFile,
  isSupported,
  isIgnoredDirectory,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  IGNORED_DIRECTORIES
};
