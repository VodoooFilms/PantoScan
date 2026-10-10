'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const volumes = require('./volumes');
const media = require('./media');

function defaultId(...parts) {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

function createLibrary(store, options = {}) {
  const volumeApi = options.volumes || volumes;
  const mediaApi = options.media || media;
  const now = options.now || (() => Date.now());

  function clipIdFor(ref) {
    return defaultId('clip', ref.volumeKey, ref.relPath);
  }

  function mounted() {
    return volumeApi.listMountedVolumes ? volumeApi.listMountedVolumes() : undefined;
  }

  function refFromSource(source) {
    return {
      volumeKey: source.volume_key,
      volumeUuid: source.volume_uuid,
      volumeName: source.volume_name,
      relPath: source.rel_path
    };
  }

  function refFromClip(clip) {
    return {
      volumeKey: clip.volume_key,
      volumeUuid: clip.volume_uuid,
      volumeName: clip.volume_name,
      relPath: clip.rel_path
    };
  }

  function addSource(absFolder) {
    const resolved = path.resolve(absFolder);
    let stats;
    try { stats = fs.statSync(resolved); } catch (_) { throw new Error('source-not-found'); }
    if (!stats.isDirectory()) throw new Error('source-not-a-directory');

    const ref = volumeApi.toRef(resolved, mounted());
    const existing = store.findSourceByLocation(ref.volumeKey, ref.relPath);
    if (existing) return existing;

    const source = {
      id: defaultId('source', ref.volumeKey, ref.relPath),
      name: path.basename(resolved),
      volumeKey: ref.volumeKey,
      volumeUuid: ref.volumeUuid,
      volumeName: ref.volumeName,
      relPath: ref.relPath,
      addedAt: now(),
      lastScanAt: null
    };
    store.insertSource(source);
    return source;
  }

  function listSources() {
    const vols = mounted();
    return store.listSources().map((source) => {
      const resolved = volumeApi.resolveRef(refFromSource(source), vols);
      return {
        id: source.id,
        name: source.name,
        volumeKey: source.volume_key,
        volumeUuid: source.volume_uuid,
        volumeName: source.volume_name,
        relPath: source.rel_path,
        addedAt: source.added_at,
        lastScanAt: source.last_scan_at,
        online: resolved.online,
        absPath: resolved.absPath
      };
    });
  }

  function walk(root, onFile) {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || mediaApi.isIgnoredDirectory(entry.name)) continue;
          stack.push(full);
        } else if (entry.isFile()) {
          onFile(full);
        }
      }
    }
  }

  function scanSource(sourceId, opts = {}) {
    const source = store.getSource(sourceId);
    if (!source) throw new Error('source-not-found');
    const vols = mounted();
    const resolved = volumeApi.resolveRef(refFromSource(source), vols);
    if (!resolved.online) return { online: false, added: 0, updated: 0, removed: 0, total: 0 };

    let startedAt = now();
    if (source.last_scan_at != null && startedAt <= source.last_scan_at) startedAt = source.last_scan_at + 1;
    let added = 0;
    let updated = 0;
    let total = 0;
    let index = 0;

    walk(resolved.absPath, (filePath) => {
      if (!mediaApi.isSupported(filePath)) return;
      const mediaType = mediaApi.mediaTypeForFile(filePath);
      const ref = volumeApi.toRef(filePath, vols);
      const id = clipIdFor(ref);
      const preexisting = store.getClip(id);
      let size = null;
      let mtime = null;
      try {
        const stats = fs.statSync(filePath);
        size = stats.size;
        mtime = Math.floor(stats.mtimeMs);
      } catch (_) {}

      store.upsertClip({
        id,
        sourceId,
        volumeKey: ref.volumeKey,
        volumeUuid: ref.volumeUuid,
        volumeName: ref.volumeName,
        relPath: ref.relPath,
        absPath: filePath,
        name: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        mediaType,
        size,
        mtime,
        addedAt: preexisting ? preexisting.added_at : startedAt,
        lastSeenAt: startedAt
      });
      if (preexisting) updated += 1; else added += 1;
      total += 1;
      index += 1;
      if (typeof opts.onProgress === 'function' && index % 50 === 0) opts.onProgress({ index, file: path.basename(filePath) });
    });

    const removed = store.deleteClipsNotSeen(sourceId, startedAt);
    store.touchSourceScan(sourceId, startedAt);
    return { online: true, added, updated, removed, total };
  }

  function decorateClip(clip, vols) {
    const resolved = volumeApi.resolveRef(refFromClip(clip), vols);
    return {
      id: clip.id,
      sourceId: clip.source_id,
      name: clip.name,
      ext: clip.ext,
      mediaType: clip.media_type,
      size: clip.size,
      mtime: clip.mtime,
      relPath: clip.rel_path,
      volumeName: clip.volume_name,
      absPath: resolved.absPath || clip.abs_path,
      online: resolved.online
    };
  }

  function listClips(filter = {}) {
    const rows = store.listClips(filter);
    const vols = mounted();
    return rows.map((clip) => decorateClip(clip, vols));
  }

  function refreshClipStates(filter = {}) {
    return listClips(filter).map((clip) => ({ id: clip.id, online: clip.online }));
  }

  function removeSource(sourceId) {
    store.deleteSource(sourceId);
  }

  function removeClip(clipId) {
    store.deleteClip(clipId);
  }

  function summary() {
    const sources = listSources();
    const clips = listClips();
    return {
      sources: sources.length,
      sourcesOnline: sources.filter((source) => source.online).length,
      clips: clips.length,
      clipsOnline: clips.filter((clip) => clip.online).length,
      clipsOffline: clips.filter((clip) => !clip.online).length
    };
  }

  return {
    addSource,
    listSources,
    scanSource,
    listClips,
    refreshClipStates,
    removeSource,
    removeClip,
    summary,
    clipIdFor
  };
}

module.exports = { createLibrary, defaultId };
