'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function plistString(xml, key) {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<(string|integer)>([\\s\\S]*?)</\\1>`));
  return match ? match[2].trim() : null;
}

function infoForMountPoint(mountPoint) {
  let xml;
  try {
    xml = execFileSync('diskutil', ['info', '-plist', mountPoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) {
    return null;
  }
  const name = plistString(xml, 'VolumeName');
  const uuid = plistString(xml, 'VolumeUUID');
  const filesystem = plistString(xml, 'FilesystemType') || plistString(xml, 'FilesystemName');
  return { mountPoint, name: name || path.basename(mountPoint), uuid: uuid || null, filesystem: filesystem || null };
}

const VOLUME_CACHE_TTL_MS = 2000;
let volumeCache = { at: 0, volumes: [] };

function listMountedVolumes(options = {}) {
  const now = Date.now();
  if (!options.force && volumeCache.volumes.length && now - volumeCache.at < VOLUME_CACHE_TTL_MS) {
    return volumeCache.volumes;
  }
  const mounts = ['/'];
  try {
    for (const entry of fs.readdirSync('/Volumes')) mounts.push(path.join('/Volumes', entry));
  } catch (_) {}
  const volumes = [];
  const seen = new Set();
  for (const mountPoint of mounts) {
    if (seen.has(mountPoint)) continue;
    seen.add(mountPoint);
    let stats;
    try { stats = fs.statSync(mountPoint); } catch (_) { continue; }
    if (!stats.isDirectory()) continue;
    const info = infoForMountPoint(mountPoint);
    if (info) volumes.push(info);
  }
  volumeCache = { at: now, volumes };
  return volumes;
}

function isUnder(candidate, base) {
  if (candidate === base) return true;
  return candidate.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

function volumeForPath(absPath, volumes) {
  const list = volumes || listMountedVolumes();
  let best = null;
  for (const volume of list) {
    if (isUnder(absPath, volume.mountPoint) && (!best || volume.mountPoint.length > best.mountPoint.length)) {
      best = volume;
    }
  }
  return best;
}

function volumeKey(volume) {
  if (volume.uuid) return volume.uuid;
  return 'mp:' + crypto.createHash('sha1').update(volume.mountPoint).digest('hex').slice(0, 12);
}

function toRef(absPath, volumes) {
  const volume = volumeForPath(absPath, volumes);
  if (!volume) return { volumeKey: 'abs', volumeUuid: null, volumeName: null, relPath: absPath };
  const relPath = path.relative(volume.mountPoint, absPath) || path.basename(absPath);
  return {
    volumeKey: volumeKey(volume),
    volumeUuid: volume.uuid,
    volumeName: volume.name,
    relPath
  };
}

function resolveRef(ref, volumes) {
  const list = volumes || listMountedVolumes();
  let volume = null;
  if (ref.volumeUuid) volume = list.find((item) => item.uuid === ref.volumeUuid) || null;
  if (!volume && ref.volumeName) volume = list.find((item) => item.name === ref.volumeName) || null;
  if (!volume && ref.volumeKey && ref.volumeKey.startsWith('mp:')) {
    volume = list.find((item) => volumeKey(item) === ref.volumeKey) || null;
  }
  if (!volume) {
    const absPath = ref.relPath && path.isAbsolute(ref.relPath) ? ref.relPath : null;
    return {
      online: Boolean(absPath && fs.existsSync(absPath)),
      absPath: absPath && fs.existsSync(absPath) ? absPath : null,
      mountPoint: null
    };
  }
  const absPath = path.join(volume.mountPoint, ref.relPath);
  return { online: fs.existsSync(absPath), absPath, mountPoint: volume.mountPoint };
}

module.exports = {
  listMountedVolumes,
  volumeForPath,
  toRef,
  resolveRef,
  volumeKey,
  isUnder,
  _plistString: plistString
};
