'use strict';

const { execFileSync } = require('child_process');

const DEFAULT_FFPROBE = '/opt/homebrew/bin/ffprobe';

function parseRate(value) {
  if (!value || value === '0/0') return null;
  const [num, den] = String(value).split('/').map(Number);
  if (!den) return num || null;
  return num / den;
}

function probeWith(exec, ffprobePath) {
  return function probe(absPath) {
    const output = exec(ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      absPath
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const data = JSON.parse(output);
    const video = (data.streams || []).find((stream) => stream.codec_type === 'video');
    const audio = (data.streams || []).find((stream) => stream.codec_type === 'audio');
    const fps = video ? (parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate)) : null;
    return {
      fps: fps || 25,
      duration: Number(data.format && data.format.duration) || (video ? Number(video.duration) : 0) || 0,
      width: video ? video.width : null,
      height: video ? video.height : null,
      videoCodec: video ? video.codec_name : null,
      audioCodec: audio ? audio.codec_name : null,
      audioChannels: audio ? audio.channels : null,
      audioSampleRate: audio ? Number(audio.sample_rate) : null
    };
  };
}

function createProbe(options = {}) {
  return probeWith(options.execFile || execFileSync, options.ffprobePath || DEFAULT_FFPROBE);
}

module.exports = { createProbe, probeWith, parseRate, DEFAULT_FFPROBE };
