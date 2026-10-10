'use strict';

const { toSrtTime, toTimecode, toFcpTime, toRationalTime, toFileUrl } = require('./format');
const { ROLE_COLORS, EMOTION_COLORS } = require('./taxonomy');

function buildSrt(edit) {
  return edit.segments.map((segment, index) => {
    return `${index + 1}\n${toSrtTime(segment.start)} --> ${toSrtTime(segment.end)}\n${segment.text}\n`;
  }).join('\n');
}

function buildVtt(edit) {
  const body = edit.segments.map((segment) => {
    return `${toSrtTime(segment.start).replace(',', '.')} --> ${toSrtTime(segment.end).replace(',', '.')}\n${segment.text}`;
  }).join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

function markerColor(kind, label) {
  if (kind === 'role') return (ROLE_COLORS[label] || '#3498db').toUpperCase();
  if (kind === 'emotion') return (EMOTION_COLORS[label] || '#e74c3c').toUpperCase();
  return '#3498DB';
}

function buildMarkersCsv(edit) {
  const header = 'kind,label,start_tc,end_tc,start_seconds,duration_seconds,color,note';
  const rows = edit.timeline.map((item) => {
    const note = (item.note || '').replace(/"/g, '""');
    return [
      item.kind,
      item.label,
      item.startTC,
      item.endTC,
      item.start.toFixed(3),
      (item.end - item.start).toFixed(3),
      markerColor(item.kind, item.label),
      `"${note}"`
    ].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildFcpxml(edit, opts = {}) {
  const fps = edit.asset.fps;
  const duration = toFcpTime(edit.asset.duration || 0, fps);
  const src = opts.fileUrl || toFileUrl(edit.asset.absPath) || toFileUrl(edit.asset.relPath) || '';
  const markers = edit.timeline.map((item) => {
    const start = item.start;
    const dur = Math.max(1 / fps, item.end - item.start);
    return `          <marker start="${toFcpTime(start, fps)}" duration="${toFcpTime(dur, fps)}" value="${escapeXml(item.label)}" note="${escapeXml(item.note || item.kind)}" completed="0"/>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
  <resources>
    <format id="r1" name="FFVideoFormat1080p${Math.round(fps)}" frameDuration="1/${Math.round(fps)}s" width="${opts.width || 1920}" height="${opts.height || 1080}" colorSpace="1-1-1 (Rec. 709)"/>
    <asset id="a1" name="${escapeXml(edit.asset.name)}" start="0s" duration="${duration}" hasVideo="1" hasAudio="1" format="r1">
      <media-rep kind="original-media" src="${escapeXml(src)}"/>
    </asset>
  </resources>
  <library>
    <event name="Documental">
      <project name="${escapeXml(edit.asset.name)} — guía">
        <sequence format="r1" duration="${duration}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <asset-clip ref="a1" name="${escapeXml(edit.asset.name)}" offset="0s" duration="${duration}" audioRole="dialogue" format="r1">
${markers}
            </asset-clip>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

function buildOtio(edit, opts = {}) {
  const fps = edit.asset.fps;
  const duration = edit.asset.duration || 0;
  const target = opts.fileUrl || toFileUrl(edit.asset.absPath) || toFileUrl(edit.asset.relPath) || '';

  const markers = edit.timeline.map((item) => {
    const marked = {
      OTIO_SCHEMA: 'TimeRange.1',
      start_time: toRationalTime(item.start, fps),
      duration: toRationalTime(Math.max(1 / fps, item.end - item.start), fps)
    };
    return {
      OTIO_SCHEMA: 'Marker.2',
      name: item.label,
      marked_range: marked,
      color: item.kind === 'emotion' ? 'RED' : (item.kind === 'role' ? 'CYAN' : 'BLUE'),
      metadata: {
        kind: item.kind,
        note: item.note || '',
        ...(item.valence != null ? { valence: item.valence, arousal: item.arousal } : {})
      }
    };
  });

  const available = { OTIO_SCHEMA: 'TimeRange.1', start_time: toRationalTime(0, fps), duration: toRationalTime(duration, fps) };
  const clip = {
    OTIO_SCHEMA: 'Clip.2',
    name: edit.asset.name,
    source_range: available,
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: target,
      available_range: available,
      metadata: { volume: edit.asset.volumeName, relPath: edit.asset.relPath }
    },
    markers,
    metadata: { summary: edit.summary, model: edit.model }
  };

  const timeline = {
    OTIO_SCHEMA: 'Timeline.1',
    name: `${edit.asset.name} — guía`,
    global_start_time: null,
    metadata: { generatedAt: edit.generatedAt, fps, counts: edit.counts },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [
        { OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children: [clip] }
      ]
    }
  };

  return JSON.stringify(timeline, null, 2);
}

module.exports = { buildSrt, buildVtt, buildMarkersCsv, buildFcpxml, buildOtio };
