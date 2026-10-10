'use strict';

const { pathToFileURL } = require('url');

function toFileUrl(target) {
  if (!target) return null;
  if (target.startsWith('file://')) return target;
  try {
    return pathToFileURL(target).href;
  } catch (_) {
    return null;
  }
}

function fpsToParts(fps) {
  const value = Number(fps) || 25;
  return Number.isInteger(value) ? { numerator: value, denominator: 1 } : { numerator: Math.round(value * 1000), denominator: 1000 };
}

function toTimecode(seconds, fps = 25) {
  const safeFps = Number(fps) || 25;
  const totalFrames = Math.round((Math.max(0, seconds || 0)) * safeFps);
  const frames = totalFrames % Math.round(safeFps);
  const totalSeconds = Math.floor(totalFrames / safeFps);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(frames)}`;
}

function toSrtTime(seconds) {
  const total = Math.max(0, seconds || 0);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const whole = Math.floor(total);
  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  const pad = (value, size) => String(value).padStart(size, '0');
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(ms, 3)}`;
}

function toFcpTime(seconds, fps = 25) {
  const safeFps = Number(fps) || 25;
  const frames = Math.round((Math.max(0, seconds || 0)) * safeFps);
  return `${frames}/${Math.round(safeFps)}s`;
}

function toRationalTime(seconds, fps = 25) {
  const safeFps = Number(fps) || 25;
  return { OTIO_SCHEMA: 'RationalTime.1', value: Math.round((Math.max(0, seconds || 0)) * safeFps), rate: safeFps };
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

module.exports = { fpsToParts, toTimecode, toSrtTime, toFcpTime, toRationalTime, toFileUrl, plural };
