'use strict';

const crypto = require('crypto');
const { TERMINAL_STAGE_STATES } = require('./contracts');

function resourceSignature(resource) {
  const r = resource || {};
  return [
    `gpu=${String(r.gpu_model || 'unknown').replace(/\s+/g, '')}`,
    `count=${Number(r.gpu_count) || 0}`,
    `precision=${r.precision || 'unknown'}`,
    `worker=${r.worker_version || 'unknown'}`
  ].join('|');
}

function runtimeStateFor(event) {
  const state = event.stageState;
  if (state === 'queued') return 'QUEUED';
  if (state === 'paused') return 'PAUSED';
  if (state === 'pause_requested' || state === 'pausing') return 'PAUSING';
  if (state === 'resume_queued') return 'RESUME_QUEUED';
  if (state === 'failed') return 'FAILED';
  if (state === 'cancelled') return 'CANCELLED';
  if (state === 'completed' && event.stageType === 'delivery') return 'COMPLETED';
  return 'RUNNING';
}

function observationFrom(runtime, event, outcome, endedAtMs) {
  if (!runtime || !runtime.currentStageId) return null;
  const duration = Math.max(
    0,
    Number(runtime.currentStageActiveElapsedMs) ||
      (Number(endedAtMs) - Number(runtime.currentStageStartedAtMs || endedAtMs))
  );
  if (duration <= 0) return null;
  const key = [runtime.jobId, runtime.runId, runtime.currentStageId, runtime.currentAttempt].join('|');
  return {
    observationId: `obs_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`,
    jobId: runtime.jobId,
    runId: runtime.runId,
    orderId: runtime.orderId,
    pipelineVersion: runtime.pipelineVersion,
    jobKind: runtime.jobKind,
    stageId: runtime.currentStageId,
    stageType: runtime.currentStageType,
    stageVersion: runtime.currentStageVersion,
    attempt: runtime.currentAttempt,
    outcome,
    censored: outcome === 'completed' ? 0 : 1,
    activeDurationMs: Math.round(duration),
    wallDurationMs: Math.max(0, Number(endedAtMs) - Number(runtime.currentStageStartedAtMs || endedAtMs)),
    resourceSignature: resourceSignature(runtime.resource),
    resource: runtime.resource || {},
    inputBucket: String(runtime.inputFeatures && runtime.inputFeatures.room_pixel_bucket || 'unknown'),
    inputFeatures: runtime.inputFeatures || {},
    provider: String(runtime.inputFeatures && runtime.inputFeatures.render_provider || ''),
    retryReason: null,
    startedAtMs: runtime.currentStageStartedAtMs,
    endedAtMs,
    createdAtMs: endedAtMs
  };
}

function newRuntime(event) {
  return {
    jobId: event.jobId,
    orderId: event.orderId,
    runId: event.runId,
    protocolVersion: event.protocolVersion,
    lastSeq: 0,
    pipelineVersion: event.pipelineVersion,
    jobKind: event.jobKind,
    runtimeState: 'QUEUED',
    currentStageId: null,
    currentStageType: null,
    currentStageVersion: null,
    currentAttempt: 1,
    currentStageStartedAtMs: event.receivedAtMs,
    currentStageActiveElapsedMs: 0,
    activeElapsedMs: 0,
    pausedAtMs: null,
    lastEventAtMs: event.receivedAtMs,
    lastWorkerHeartbeatAtMs: null,
    resource: event.resource || {},
    inputFeatures: event.inputFeatures || {},
    manifestPatch: {},
    pauseCapability: event.pauseCapability || 'boundary_only',
    updatedAtMs: event.receivedAtMs
  };
}

function reduceTimeline(existing, event) {
  let runtime = existing ? { ...existing } : newRuntime(event);
  const observations = [];

  if (existing && existing.protocolVersion >= 2 && event.protocolVersion < 2) {
    return { runtime: existing, observations, ignored: true, reason: 'legacy_after_v2' };
  }
  if (existing && existing.runId === event.runId && event.seq <= existing.lastSeq) {
    return { runtime: existing, observations, ignored: true, reason: 'old_sequence' };
  }
  if (existing && existing.runId !== event.runId) {
    if (existing.currentStageId && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(existing.runtimeState)) {
      const censored = observationFrom(existing, event, 'run_replaced', event.receivedAtMs);
      if (censored) observations.push(censored);
    }
    runtime = newRuntime(event);
  }

  const stageChanged = runtime.currentStageId && runtime.currentStageId !== event.stageId;
  if (stageChanged) {
    const closed = observationFrom(runtime, event, 'completed', event.receivedAtMs);
    if (closed) observations.push(closed);
  }

  if (!runtime.currentStageId || stageChanged) {
    runtime.currentStageStartedAtMs = event.receivedAtMs;
    runtime.currentStageActiveElapsedMs = Math.max(0, Number(event.stageActiveElapsedMs) || 0);
  } else if (event.stageActiveElapsedMs !== null) {
    runtime.currentStageActiveElapsedMs = Math.max(runtime.currentStageActiveElapsedMs || 0, event.stageActiveElapsedMs);
  } else if (!['PAUSED', 'PAUSING'].includes(runtime.runtimeState)) {
    runtime.currentStageActiveElapsedMs = Math.max(0, event.receivedAtMs - runtime.currentStageStartedAtMs);
  }

  runtime.jobId = event.jobId;
  runtime.orderId = event.orderId || runtime.orderId;
  runtime.runId = event.runId;
  runtime.protocolVersion = Math.max(runtime.protocolVersion || 1, event.protocolVersion);
  runtime.lastSeq = event.seq;
  runtime.pipelineVersion = event.pipelineVersion || runtime.pipelineVersion;
  runtime.jobKind = event.jobKind || runtime.jobKind;
  runtime.runtimeState = runtimeStateFor(event);
  runtime.currentStageId = event.stageId;
  runtime.currentStageType = event.stageType;
  runtime.currentStageVersion = event.stageVersion;
  runtime.currentAttempt = event.attempt;
  runtime.activeElapsedMs = Math.max(runtime.activeElapsedMs || 0, Number(event.jobActiveElapsedMs) || 0);
  runtime.lastEventAtMs = event.receivedAtMs;
  runtime.resource = Object.keys(event.resource || {}).length ? event.resource : runtime.resource;
  runtime.inputFeatures = Object.keys(event.inputFeatures || {}).length ? event.inputFeatures : runtime.inputFeatures;
  runtime.pauseCapability = event.pauseCapability || runtime.pauseCapability;
  runtime.updatedAtMs = event.receivedAtMs;

  if (TERMINAL_STAGE_STATES.has(event.stageState)) {
    const closed = observationFrom(runtime, event, event.stageState, event.receivedAtMs);
    if (closed) observations.push(closed);
  }

  return { runtime, observations, ignored: false, reason: null };
}

module.exports = { reduceTimeline, resourceSignature, runtimeStateFor };
