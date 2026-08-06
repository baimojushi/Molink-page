'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPublicOrderFailure } = require('../../services/orderFailurePublic');

test('program failure uses manual handling promise without leaking raw error', () => {
  const failure = buildPublicOrderFailure({
    status: 'hanging_failed',
    hanging_status: 'failed',
    hanging_exit_code: 'FAILED_WORKER_EXCEPTION',
    hanging_failure_context_json: JSON.stringify({
      category: 'program', source: 'worker', reason_code: 'FAILED_WORKER_EXCEPTION',
      public_reason: 'Traceback secret provider body'
    })
  });
  assert.equal(failure.kind, 'program');
  assert.equal(failure.manual_handling_today, true);
  assert.match(failure.suggestion, /今日内/);
  assert.match(failure.suggestion, /历史记录/);
  assert.doesNotMatch(JSON.stringify(failure), /Traceback secret provider body/);
});

test('safe-area service failure returns actionable advice', () => {
  const failure = buildPublicOrderFailure({
    status: 'hanging_no_safe_wall',
    hanging_status: 'no_safe_wall',
    hanging_exit_code: 'PARTIAL_ALL_REJECTED_WITH_REASONS',
    hanging_not_recommended_json: JSON.stringify([{ reasons: ['窗帘安全间距不足'] }])
  });
  assert.equal(failure.kind, 'service');
  assert.equal(failure.source, 'safe_area');
  assert.match(failure.reason, /窗帘安全间距不足/);
  assert.match(failure.suggestion, /更小|其他墙面|补拍/);
});

test('render review is a service judgement, not a generic program failure', () => {
  const failure = buildPublicOrderFailure({
    status: 'hanging_render_review',
    hanging_status: 'render_review',
    hanging_exit_code: 'PARTIAL_NO_FLUX_APPROVED_CANDIDATE'
  });
  assert.equal(failure.kind, 'service');
  assert.equal(failure.source, 'render_quality');
});
