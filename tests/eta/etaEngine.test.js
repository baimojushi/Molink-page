'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeEta } = require('../../services/eta/engine/etaEngine');

function runtime(overrides = {}) {
  return {
    jobId: 'job1', orderId: 'o1', protocolVersion: 2, lastSeq: 4,
    pipelineVersion: 'hanging-main-v1', jobKind: 'hang_in_home', runtimeState: 'RUNNING',
    currentStageId: 'render', currentStageType: 'render', currentStageActiveElapsedMs: 60_000,
    inputFeatures: { styling_requested: false }, ...overrides
  };
}

test('ETA subtracts current stage elapsed time and preserves P90 >= P50', () => {
  const snapshot = computeEta({
    runtime: runtime(), loadStageSummary: () => ({ sampleCount: 0 }), nowMs: 1000,
    modelVersion: 'eta-v1', staleAfterMs: 90_000
  });
  assert.ok(snapshot.activeP50Ms > 0);
  assert.ok(snapshot.activeP90Ms >= snapshot.activeP50Ms);
  assert.equal(snapshot.confidence, 'MEDIUM');
  assert.ok(snapshot.reasonCodes.includes('MANIFEST_FALLBACK'));
});

test('completed ETA settles at zero', () => {
  const snapshot = computeEta({
    runtime: runtime({ runtimeState: 'COMPLETED' }), loadStageSummary: () => ({ sampleCount: 0 }),
    nowMs: 1000, modelVersion: 'eta-v1', staleAfterMs: 90_000
  });
  assert.equal(snapshot.activeP50Ms, 0);
  assert.equal(snapshot.estimateState, 'COMPLETED');
});
