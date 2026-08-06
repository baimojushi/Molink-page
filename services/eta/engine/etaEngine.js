'use strict';

const { getManifest } = require('../manifests/registry');

function clampMs(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function enabledNodes(manifest, features) {
  return manifest.nodes.filter(node => !node.enabledWhen || node.enabledWhen(features || {}));
}

function estimateNode(node, history) {
  if (history && history.sampleCount >= 5) {
    return {
      p50Ms: clampMs(history.p50Ms),
      p90Ms: Math.max(clampMs(history.p50Ms), clampMs(history.p90Ms)),
      source: 'historical',
      sampleCount: history.sampleCount
    };
  }
  return { p50Ms: node.p50Ms, p90Ms: node.p90Ms, source: 'fallback', sampleCount: 0 };
}

function computeEta({ runtime, loadStageSummary, nowMs, modelVersion, staleAfterMs }) {
  const manifest = getManifest(runtime.pipelineVersion, runtime.jobKind);
  const nodes = enabledNodes(manifest, runtime.inputFeatures);
  const currentIndex = Math.max(0, nodes.findIndex(node => node.id === runtime.currentStageId || node.type === runtime.currentStageType));
  const state = String(runtime.runtimeState || 'RUNNING').toUpperCase();

  if (state === 'COMPLETED') {
    return buildSnapshot(runtime, nowMs, modelVersion, 0, 0, 'HIGH', ['TERMINAL_RESULT'], 'COMPLETED', staleAfterMs, []);
  }
  if (state === 'FAILED' || state === 'CANCELLED') {
    return buildSnapshot(runtime, nowMs, modelVersion, null, null, 'LOW', ['TERMINAL_FAILURE'], state, staleAfterMs, []);
  }

  let p50 = 0;
  let p90 = 0;
  const trace = [];
  const elapsed = Math.max(0, Number(runtime.currentStageActiveElapsedMs) || 0);
  const startAt = state === 'QUEUED' ? 0 : currentIndex;

  for (let i = startAt; i < nodes.length; i += 1) {
    const node = nodes[i];
    const history = loadStageSummary(node.type, runtime);
    const estimate = estimateNode(node, history);
    let nodeP50 = estimate.p50Ms;
    let nodeP90 = estimate.p90Ms;
    if (i === currentIndex && state !== 'QUEUED') {
      nodeP50 = Math.max(0, nodeP50 - elapsed);
      nodeP90 = Math.max(nodeP50, nodeP90 - elapsed);
    }
    p50 += nodeP50;
    p90 += nodeP90;
    trace.push({ stage: node.id, p50Ms: nodeP50, p90Ms: nodeP90, source: estimate.source, sampleCount: estimate.sampleCount });
  }

  const historicalCount = trace.reduce((sum, item) => sum + item.sampleCount, 0);
  const isV2 = Number(runtime.protocolVersion) >= 2;
  const confidence = historicalCount >= 30 ? 'HIGH' : (isV2 ? 'MEDIUM' : 'LOW');
  const reasons = [];
  if (isV2) reasons.push('PROTOCOL_V2');
  else reasons.push('LEGACY_PROGRESS');
  if (trace.some(item => item.source === 'historical')) reasons.push('HISTORICAL_STAGE_DURATION');
  if (trace.some(item => item.source === 'fallback')) reasons.push('MANIFEST_FALLBACK');
  if (state === 'QUEUED') reasons.push('QUEUE_ESTIMATE');

  return buildSnapshot(runtime, nowMs, modelVersion, p50, Math.max(p50, p90), confidence, reasons, state, staleAfterMs, trace);
}

function buildSnapshot(runtime, nowMs, modelVersion, p50, p90, confidence, reasons, state, staleAfterMs, trace) {
  return {
    jobId: runtime.jobId,
    orderId: runtime.orderId,
    sourceSeq: runtime.lastSeq || 0,
    estimateState: state,
    activeP50Ms: p50 === null ? null : clampMs(p50),
    activeP90Ms: p90 === null ? null : clampMs(p90),
    wallP50Ms: p50 === null ? null : clampMs(p50),
    wallP90Ms: p90 === null ? null : clampMs(p90),
    queueP50Ms: state === 'QUEUED' ? clampMs(p50) : null,
    queueP90Ms: state === 'QUEUED' ? clampMs(p90) : null,
    confidence,
    reasonCodes: reasons,
    components: trace,
    calculatedAtMs: nowMs,
    validUntilMs: nowMs + staleAfterMs,
    modelVersion,
    pipelineVersion: runtime.pipelineVersion,
    estimatorTrace: trace,
    stageId: runtime.currentStageId,
    stageType: runtime.currentStageType,
    pauseCapability: runtime.pauseCapability || 'boundary_only'
  };
}

module.exports = { computeEta, enabledNodes, estimateNode };
