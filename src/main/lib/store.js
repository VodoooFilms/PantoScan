'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrate(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      volume_key TEXT NOT NULL,
      volume_uuid TEXT,
      volume_name TEXT,
      rel_path TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      last_scan_at INTEGER,
      UNIQUE (volume_key, rel_path)
    );

    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      source_id TEXT REFERENCES sources (id) ON DELETE CASCADE,
      volume_key TEXT NOT NULL,
      volume_uuid TEXT,
      volume_name TEXT,
      rel_path TEXT NOT NULL,
      abs_path TEXT,
      name TEXT NOT NULL,
      ext TEXT,
      media_type TEXT NOT NULL,
      size INTEGER,
      mtime INTEGER,
      added_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_clips_source ON clips (source_id);
    CREATE INDEX IF NOT EXISTS idx_clips_volume ON clips (volume_key);

    CREATE TABLE IF NOT EXISTS jobs (
      clip_id TEXT PRIMARY KEY REFERENCES clips (id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      fingerprint TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs (state);

    CREATE TABLE IF NOT EXISTS results (
      clip_id TEXT PRIMARY KEY REFERENCES clips (id) ON DELETE CASCADE,
      out_dir TEXT NOT NULL,
      edit_path TEXT,
      guide_path TEXT,
      summary TEXT,
      asr_fingerprint TEXT,
      analysis_fingerprint TEXT,
      fps REAL,
      edited INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  ensureColumn(db, 'results', 'asr_fingerprint', 'TEXT');
  ensureColumn(db, 'results', 'analysis_fingerprint', 'TEXT');
  ensureColumn(db, 'results', 'fps', 'REAL');
  ensureColumn(db, 'results', 'edited', 'INTEGER NOT NULL DEFAULT 0');

  db.exec(`
    CREATE TABLE IF NOT EXISTS segments (
      clip_id TEXT REFERENCES clips (id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      start REAL,
      end REAL,
      text TEXT,
      PRIMARY KEY (clip_id, idx)
    );

    CREATE TABLE IF NOT EXISTS annotations (
      clip_id TEXT REFERENCES clips (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      label TEXT,
      start REAL,
      end REAL,
      note TEXT,
      valence REAL,
      arousal REAL,
      seg_start INTEGER,
      seg_end INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_annotations_clip ON annotations (clip_id);
    CREATE INDEX IF NOT EXISTS idx_annotations_label ON annotations (kind, label);

    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5 (
      text, clip_id UNINDEXED, section UNINDEXED, label UNINDEXED, start UNINDEXED, end UNINDEXED
    );
  `);
  const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', String(SCHEMA_VERSION));
  return Number(current ? current.value : 0);
}

class Store {
  constructor(filePath) {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.path = filePath;
    migrate(this.db);
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  insertSource(source) {
    this.db.prepare(`
      INSERT INTO sources (id, name, volume_key, volume_uuid, volume_name, rel_path, added_at, last_scan_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name
    `).run(source.id, source.name, source.volumeKey, source.volumeUuid, source.volumeName,
      source.relPath, source.addedAt, source.lastScanAt || null);
  }

  findSourceByLocation(volumeKey, relPath) {
    return this.db.prepare('SELECT * FROM sources WHERE volume_key = ? AND rel_path = ?').get(volumeKey, relPath) || null;
  }

  getSource(id) {
    return this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) || null;
  }

  listSources() {
    return this.db.prepare('SELECT * FROM sources ORDER BY added_at').all();
  }

  touchSourceScan(id, at) {
    this.db.prepare('UPDATE sources SET last_scan_at = ? WHERE id = ?').run(at, id);
  }

  deleteSource(id) {
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  }

  upsertClip(clip) {
    this.db.prepare(`
      INSERT INTO clips (id, source_id, volume_key, volume_uuid, volume_name, rel_path, abs_path,
        name, ext, media_type, size, mtime, added_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        abs_path = excluded.abs_path,
        size = excluded.size,
        mtime = excluded.mtime,
        last_seen_at = excluded.last_seen_at
    `).run(clip.id, clip.sourceId, clip.volumeKey, clip.volumeUuid, clip.volumeName, clip.relPath,
      clip.absPath, clip.name, clip.ext, clip.mediaType, clip.size, clip.mtime, clip.addedAt, clip.lastSeenAt);
  }

  getClip(id) {
    return this.db.prepare('SELECT * FROM clips WHERE id = ?').get(id) || null;
  }

  listClips(filter = {}) {
    if (filter.sourceId) {
      return this.db.prepare('SELECT * FROM clips WHERE source_id = ? ORDER BY rel_path').all(filter.sourceId);
    }
    return this.db.prepare('SELECT * FROM clips ORDER BY rel_path').all();
  }

  countClips() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM clips').get().n;
  }

  deleteClipsNotSeen(sourceId, scanStartedAt) {
    const changes = this.db.prepare('DELETE FROM clips WHERE source_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)')
      .run(sourceId, scanStartedAt).changes;
    if (changes) {
      this.db.prepare('DELETE FROM search_fts WHERE clip_id NOT IN (SELECT id FROM clips)').run();
    }
    return changes;
  }

  deleteClip(id) {
    this.db.prepare('DELETE FROM clips WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM search_fts WHERE clip_id = ?').run(id);
  }

  saveExtraction(clipId, { segments = [], annotations = [], searchEntries = [] } = {}) {
    const db = this.db;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM segments WHERE clip_id = ?').run(clipId);
      db.prepare('DELETE FROM annotations WHERE clip_id = ?').run(clipId);
      db.prepare('DELETE FROM search_fts WHERE clip_id = ?').run(clipId);
      const segStmt = db.prepare('INSERT INTO segments (clip_id, idx, start, end, text) VALUES (?, ?, ?, ?, ?)');
      for (const segment of segments) segStmt.run(clipId, segment.idx, segment.start, segment.end, segment.text);
      const annStmt = db.prepare(`INSERT INTO annotations (clip_id, kind, label, start, end, note, valence, arousal, seg_start, seg_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of annotations) {
        annStmt.run(clipId, item.kind, item.label, item.start, item.end, item.note || null,
          item.valence != null ? item.valence : null, item.arousal != null ? item.arousal : null,
          item.segStart != null ? item.segStart : null, item.segEnd != null ? item.segEnd : null);
      }
      const ftsStmt = db.prepare('INSERT INTO search_fts (text, clip_id, section, label, start, end) VALUES (?, ?, ?, ?, ?, ?)');
      for (const entry of searchEntries) {
        ftsStmt.run(entry.text, clipId, entry.section, entry.label || null,
          entry.start != null ? entry.start : null, entry.end != null ? entry.end : null);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  search(rawQuery, limit = 50) {
    const clean = String(rawQuery || '').replace(/["()*:^-]/g, ' ').trim();
    if (!clean) return [];
    const match = clean.split(/\s+/).filter(Boolean).map((token) => `"${token}"`).join(' AND ');
    return this.db.prepare(`
      SELECT search_fts.text AS text, search_fts.clip_id AS clip_id, search_fts.section AS section,
             search_fts.label AS label, search_fts.start AS start, search_fts.end AS end,
             clips.name AS clip_name, clips.rel_path AS rel_path, clips.volume_name AS volume_name
      FROM search_fts JOIN clips ON clips.id = search_fts.clip_id
      WHERE search_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(match, limit);
  }

  hasSegments(clipId) {
    return Boolean(this.db.prepare('SELECT 1 FROM segments WHERE clip_id = ? LIMIT 1').get(clipId));
  }

  projectExtractions() {
    const segments = this.db.prepare(`
      SELECT s.clip_id, s.idx, s.start, s.end, s.text, c.name AS clip_name, c.rel_path, c.volume_name
      FROM segments s JOIN clips c ON c.id = s.clip_id ORDER BY c.name, s.idx
    `).all();
    const annotations = this.db.prepare(`
      SELECT a.clip_id, a.kind, a.label, a.start, a.end, a.note, a.valence, a.arousal,
             c.name AS clip_name, c.rel_path, c.volume_name
      FROM annotations a JOIN clips c ON c.id = a.clip_id ORDER BY c.name, a.start
    `).all();
    return { segments, annotations, results: this.listResults() };
  }

  upsertJob(job) {
    this.db.prepare(`
      INSERT INTO jobs (clip_id, state, progress, attempts, error, fingerprint, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(clip_id) DO UPDATE SET
        state = excluded.state,
        progress = excluded.progress,
        attempts = excluded.attempts,
        error = excluded.error,
        fingerprint = excluded.fingerprint,
        priority = excluded.priority,
        updated_at = excluded.updated_at
    `).run(job.clipId, job.state, job.progress, job.attempts, job.error, job.fingerprint,
      job.priority, job.createdAt, job.updatedAt);
  }

  getJob(clipId) {
    return this.db.prepare('SELECT * FROM jobs WHERE clip_id = ?').get(clipId) || null;
  }

  listJobs(filter = {}) {
    if (filter.state) {
      return this.db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY priority DESC, created_at').all(filter.state);
    }
    return this.db.prepare('SELECT * FROM jobs ORDER BY priority DESC, created_at').all();
  }

  nextPendingJob() {
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'pending' ORDER BY priority DESC, created_at LIMIT 1").get() || null;
  }

  resetRunningJobs() {
    return this.db.prepare(
      "UPDATE jobs SET state = 'pending', progress = 0, error = NULL WHERE state IN ('transcribing', 'analyzing', 'exporting')"
    ).run().changes;
  }

  jobCounts() {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all();
    const counts = {};
    for (const row of rows) counts[row.state] = row.n;
    return counts;
  }

  checkpoint() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
  }

  saveResult(result) {
    this.db.prepare(`
      INSERT INTO results (clip_id, out_dir, edit_path, guide_path, summary, asr_fingerprint, analysis_fingerprint, fps, edited, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(clip_id) DO UPDATE SET
        out_dir = excluded.out_dir,
        edit_path = excluded.edit_path,
        guide_path = excluded.guide_path,
        summary = excluded.summary,
        asr_fingerprint = excluded.asr_fingerprint,
        analysis_fingerprint = excluded.analysis_fingerprint,
        fps = excluded.fps,
        edited = excluded.edited,
        updated_at = excluded.updated_at
    `).run(result.clipId, result.outDir, result.editPath || null, result.guidePath || null,
      result.summary || null, result.asrFingerprint || null, result.analysisFingerprint || null,
      result.fps != null ? result.fps : null, result.edited ? 1 : 0, result.updatedAt);
  }

  getResult(clipId) {
    return this.db.prepare(`
      SELECT results.*, clips.name AS clip_name, clips.rel_path AS rel_path, clips.volume_name AS volume_name
      FROM results JOIN clips ON clips.id = results.clip_id
      WHERE results.clip_id = ?
    `).get(clipId) || null;
  }

  listResults() {
    return this.db.prepare(`
      SELECT results.*, clips.name AS clip_name, clips.rel_path AS rel_path, clips.volume_name AS volume_name
      FROM results JOIN clips ON clips.id = results.clip_id
      ORDER BY results.updated_at DESC
    `).all();
  }

  close() {
    this.checkpoint();
    this.db.close();
  }
}

module.exports = { Store, SCHEMA_VERSION };
