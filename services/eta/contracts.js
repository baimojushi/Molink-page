'use strict';

const crypto = require('crypto');

const STAGE_ALIASES = Object.freeze({
  content_review: 'content_review',
  worker_queue: 'worker_queue',
  queue: 'worker_queue',
  metric3d: 'metric3d',
  semantic: 'semantic',
  hanging: 'hanging',
  render: 'render',
  styling: 'styling',
  r2_upload: 'upload',
  upload: 'upload',
  delivery: 'delivery',
  complete: 'delivery'
});

const TERMINAL_STAGE_STATES = new Set(['completed', 'failed', 'cancelled']);

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeStageId(value) {
  const raw = String(value || 'unknown').trim().toLowerCase();
  return STAGE_ALIASES[raw] || raw || 'unknown';
}

function normalizeState(value) {
  const raw = String(value || 'running').trim().toLowerCase();
  const allowed = new Set([
    'queued', 'starting', 'running', 'pause_requested', 'pausing', 'paused',
    'resume_queued', 'retrying', 'completed', 'failed', 'cancelled'
  ]);
  return allowed.has(raw) ? raw : 'running';
}

function deterministicId(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function normalizeProgressV2(raw, receivedAtMs) {
  const stage = jsonObject(raw.stage);
  const timing = jsonObject(raw.timing);
  const work = jsonObject(raw.work);
  const resource = jsonObject(raw.resource);
  const inputFeatures = jsonObject(raw.input_features);
  const metadata = jsonObject(raw.metadata);
  const jobId = String(raw.job_id || '').trim();
  const runId = String(raw.run_id || '').trim();
  const seq = Math.max(1, Math.floor(finiteOrNull(raw.seq) || 0));
  if (!jobId || !runId || !seq) throw new Error('invalid progress_v2 identity');

  const stageId = normalizeStageId(stage.id || stage.type);
  return {
    eventId: String(raw.event_id || `evt_${deterministicId([jobId, runId, seq, receivedAtMs])}`),
    protocolVersion: 2,
    jobId,
    orderId: raw.order_id ? String(raw.order_id) : null,
    runId,
    seq,
    pipelineVersion: String(raw.pipeline_version || 'hanging-main-v1'),
    jobKind: String(raw.job_kind || 'hang_in_home'),
    stageId,
    stageType: normalizeStageId(stage.type || stageId),
    stageVersion: String(stage.version || 'v1'),
    attempt: Math.max(1, Math.floor(finiteOrNull(stage.attempt) || 1)),
    stageState: normalizeState(stage.state),
    pauseCapability: String(stage.pause_capability || 'boundary_only'),
    workerMonotonicMs: finiteOrNull(timing.worker_monotonic_ms),
    stageActiveElapsedMs: finiteOrNull(timing.stage_active_elapsed_ms),
    jobActiveElapsedMs: finiteOrNull(timing.job_active_elapsed_ms),
    workDone: finiteOrNull(work.done),
    workTotal: finiteOrNull(work.total),
    workUnit: work.unit ? String(work.unit) : null,
    progressQuality: Math.max(0, Math.min(1, finiteOrNull(work.quality) ?? finiteOrNull(raw.progress_quality) ?? 0.8)),
    resource,
    inputFeatures,
    metadata: { ...metadata, message: String(raw.message || '') },
    receivedAtMs
  };
}

function normalizeLegacyProgress(raw, receivedAtMs, seq) {
  const jobId = String(raw.job_id || '').trim();
  if (!jobId) throw new Error('legacy progress missing job_id');
  const stageId = normalizeStageId(raw.stage);
  const legacySeq = Math.max(1, Math.floor(Number(seq) || 1));
  return {
    eventId: `evt_${deterministicId(['legacy', jobId, legacySeq, receivedAtMs])}`,
    protocolVersion: 1,
    jobId,
    orderId: raw.order_id ? String(raw.order_id) : null,
    runId: `legacy:${jobId}`,
    seq: legacySeq,
    pipelineVersion: 'hanging-legacy-v1',
    jobKind: String(raw.job_kind || 'hang_in_home'),
    stageId,
    stageType: stageId,
    stageVersion: 'legacy',
    attempt: 1,
    stageState: normalizeState(raw.stage_state || raw.state),
    pauseCapability: 'boundary_only',
    workerMonotonicMs: null,
    stageActiveElapsedMs: null,
    jobActiveElapsedMs: null,
    workDone: null,
    workTotal: null,
    workUnit: null,
    progressQuality: 0.2,
    resource: {},
    inputFeatures: {},
    metadata: { message: String(raw.message || '') },
    receivedAtMs
  };
}

function normalizeProgress(raw, receivedAtMs, legacySeq) {
  if (raw && (raw.type === 'progress_v2' || Number(raw.protocol_version) === 2)) {
    return normalizeProgressV2(raw, receivedAtMs);
  }
  return normalizeLegacyProgress(raw || {}, receivedAtMs, legacySeq);
}

module.exports = {
  TERMINAL_STAGE_STATES,
  normalizeProgress,
  normalizeProgressV2,
  normalizeLegacyProgress,
  normalizeStageId,
  normalizeState
};
