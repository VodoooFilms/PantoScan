'use strict';

const PIPELINE_VERSION = 1;

const STATES = ['pending', 'transcribing', 'analyzing', 'exporting', 'done', 'error', 'skipped'];
const RUNNING = new Set(['transcribing', 'analyzing', 'exporting']);
const TERMINAL = new Set(['done', 'error', 'skipped']);

function fingerprintFor(clip, configHash) {
  return [PIPELINE_VERSION, configHash || 'default', clip.size, clip.mtime].join(':');
}

function createQueue(store, options = {}) {
  const now = options.now || (() => Date.now());

  function enqueue(clipIds, opts = {}) {
    const list = Array.isArray(clipIds) ? clipIds : [clipIds];
    let enqueued = 0;
    for (const clipId of list) {
      const clip = store.getClip(clipId);
      if (!clip) continue;
      const existing = store.getJob(clipId);
      if (existing && !opts.force && (RUNNING.has(existing.state) || existing.state === 'done')) {
        if (existing.state === 'done') continue;
      }
      const timestamp = now();
      store.upsertJob({
        clipId,
        state: 'pending',
        progress: 0,
        attempts: existing ? existing.attempts : 0,
        error: null,
        fingerprint: fingerprintFor(clip, opts.configHash),
        priority: opts.priority || (existing ? existing.priority : 0),
        createdAt: existing ? existing.created_at : timestamp,
        updatedAt: timestamp
      });
      enqueued += 1;
    }
    return enqueued;
  }

  function claimNext() {
    const job = store.nextPendingJob();
    if (!job) return null;
    const timestamp = now();
    store.upsertJob({
      clipId: job.clip_id,
      state: 'transcribing',
      progress: 0,
      attempts: job.attempts + 1,
      error: null,
      fingerprint: job.fingerprint,
      priority: job.priority,
      createdAt: job.created_at,
      updatedAt: timestamp
    });
    return store.getJob(job.clip_id);
  }

  function setState(clipId, state, opts = {}) {
    if (!STATES.includes(state)) throw new Error('invalid-state:' + state);
    const job = store.getJob(clipId);
    if (!job) throw new Error('job-not-found');
    store.upsertJob({
      clipId,
      state,
      progress: opts.progress != null ? opts.progress : (state === 'done' ? 100 : job.progress),
      attempts: job.attempts,
      error: state === 'error' ? (opts.error || 'error') : null,
      fingerprint: job.fingerprint,
      priority: job.priority,
      createdAt: job.created_at,
      updatedAt: now()
    });
    return store.getJob(clipId);
  }

  function retry(clipId) {
    return setState(clipId, 'pending', { progress: 0 });
  }

  function isStale(job) {
    if (!job || !RUNNING.has(job.state)) return false;
    return false;
  }

  function requeueStale() {
    return store.resetRunningJobs();
  }

  function stats() {
    const counts = store.jobCounts();
    const result = {};
    for (const state of STATES) result[state] = counts[state] || 0;
    result.total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return result;
  }

  function list(filter = {}) {
    return store.listJobs(filter);
  }

  function isUpToDate(clip, configHash) {
    const job = store.getJob(clip.id);
    if (!job || job.state !== 'done') return false;
    return job.fingerprint === fingerprintFor(clip, configHash);
  }

  return {
    enqueue,
    claimNext,
    setState,
    retry,
    requeueStale,
    stats,
    list,
    isUpToDate,
    isStale,
    STATES,
    RUNNING,
    TERMINAL,
    PIPELINE_VERSION
  };
}

module.exports = { createQueue, STATES, PIPELINE_VERSION, fingerprintFor };
