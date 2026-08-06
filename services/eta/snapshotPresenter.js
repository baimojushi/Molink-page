'use strict';

function presentSnapshot(snapshot, nowMs, config) {
  if (!snapshot) return null;
  const ageMs = Math.max(0, nowMs - Number(snapshot.calculatedAtMs || 0));
  let state = String(snapshot.estimateState || 'UNAVAILABLE').toUpperCase();
  let displayMode = snapshot.confidence === 'LOW' ? 'RANGE_ONLY' : 'POINT_AND_RANGE';

  if (!['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(state)) {
    if (ageMs > config.expiredAfterMs) {
      state = 'UNAVAILABLE';
      displayMode = 'HIDDEN';
    } else if (nowMs > Number(snapshot.validUntilMs || 0)) {
      state = 'STALE';
      displayMode = 'STALE';
    }
  }
  if (!config.uiEnabled) displayMode = 'HIDDEN';

  return {
    schemaVersion: 1,
    state,
    displayMode,
    activeRemaining: snapshot.activeP50Ms === null ? null : {
      p50Ms: snapshot.activeP50Ms,
      p90Ms: snapshot.activeP90Ms
    },
    wallRemaining: snapshot.wallP50Ms === null ? null : {
      p50Ms: snapshot.wallP50Ms,
      p90Ms: snapshot.wallP90Ms
    },
    queueRemaining: snapshot.queueP50Ms === null ? null : {
      p50Ms: snapshot.queueP50Ms,
      p90Ms: snapshot.queueP90Ms
    },
    confidence: snapshot.confidence,
    stage: { id: snapshot.stageId || '', type: snapshot.stageType || '' },
    reasonCodes: snapshot.reasonCodes || [],
    sourceSequence: snapshot.sourceSeq || 0,
    serverNowMs: nowMs,
    calculatedAtMs: snapshot.calculatedAtMs,
    validUntilMs: state === 'STALE' || state === 'UNAVAILABLE' ? null : snapshot.validUntilMs,
    pipelineVersion: snapshot.pipelineVersion,
    modelVersion: snapshot.modelVersion,
    control: {
      canPause: false,
      pauseCapability: snapshot.pauseCapability || 'boundary_only'
    }
  };
}

module.exports = { presentSnapshot };
