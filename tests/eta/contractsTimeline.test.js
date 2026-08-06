'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProgressV2, normalizeLegacyProgress } = require('../../services/eta/contracts');
const { reduceTimeline } = require('../../services/eta/timelineReducer');

test('progress V2 normalizes stage aliases and identity', () => {
  const event = normalizeProgressV2({
    type: 'progress_v2', protocol_version: 2, event_id: 'evt1', job_id: 'job1',
    run_id: 'run1', seq: 2, pipeline_version: 'hanging-main-v1', job_kind: 'hang_in_home',
    stage: { id: 'r2_upload', type: 'r2_upload', state: 'running' },
    timing: { stage_active_elapsed_ms: 1200 }, work: { quality: 0.9 }
  }, 10_000);
  assert.equal(event.stageId, 'upload');
  assert.equal(event.protocolVersion, 2);
  assert.equal(event.seq, 2);
});

test('timeline closes prior stage and ignores legacy after V2', () => {
  const first = normalizeProgressV2({
    type: 'progress_v2', job_id: 'job1', order_id: 'o1', run_id: 'run1', seq: 1,
    pipeline_version: 'hanging-main-v1', job_kind: 'hang_in_home',
    stage: { id: 'metric3d', type: 'metric3d', state: 'running' },
    timing: { stage_active_elapsed_ms: 0, job_active_elapsed_ms: 0 }
  }, 1_000);
  const r1 = reduceTimeline(null, first);
  const second = normalizeProgressV2({
    type: 'progress_v2', job_id: 'job1', order_id: 'o1', run_id: 'run1', seq: 2,
    pipeline_version: 'hanging-main-v1', job_kind: 'hang_in_home',
    stage: { id: 'semantic', type: 'semantic', state: 'running' },
    timing: { stage_active_elapsed_ms: 0, job_active_elapsed_ms: 10_000 }
  }, 11_000);
  const r2 = reduceTimeline(r1.runtime, second);
  assert.equal(r2.observations.length, 1);
  assert.equal(r2.observations[0].stageType, 'metric3d');
  assert.equal(r2.runtime.currentStageId, 'semantic');

  const legacy = normalizeLegacyProgress({ job_id: 'job1', stage: 'render' }, 12_000, 1);
  const r3 = reduceTimeline(r2.runtime, legacy);
  assert.equal(r3.ignored, true);
  assert.equal(r3.reason, 'legacy_after_v2');
});
