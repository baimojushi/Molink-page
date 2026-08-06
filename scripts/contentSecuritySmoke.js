#!/usr/bin/env node

const assert = require('assert');
const {
  contentReviewDecisionFromSuggest,
  normalizeImgSecCheckResponse,
  isMediaDownloadError,
  normalizeMediaCheckCallback,
  summarizeMediaCheckCallback,
  sanitizeUrlForLog
} = require('../services/wxContentSecurity');

const checks = [];

function check(name, fn) {
  fn();
  checks.push(name);
}

check('pass stays pass', () => {
  assert.equal(contentReviewDecisionFromSuggest('pass', 0), 'pass');
});

check('risky is the only content rejection result', () => {
  assert.equal(contentReviewDecisionFromSuggest('risky', 0), 'reject');
});

check('review enters manual review instead of rejection', () => {
  assert.equal(contentReviewDecisionFromSuggest('review', 0), 'manual_review');
});

check('non-zero errcode is a technical error instead of rejection', () => {
  assert.equal(contentReviewDecisionFromSuggest('risky', 40001), 'error');
});


check('binary image check maps errcode 0 to pass', () => {
  const normalized = normalizeImgSecCheckResponse({ errcode: 0, errmsg: 'ok' });
  assert.equal(normalized.decision, 'pass');
  assert.equal(normalized.suggest, 'pass');
});

check('binary image check maps 87014 to content rejection', () => {
  const normalized = normalizeImgSecCheckResponse({ errcode: 87014, errmsg: 'risky content' });
  assert.equal(normalized.decision, 'reject');
  assert.equal(normalized.suggest, 'risky');
});

check('binary image check keeps other nonzero codes as technical errors', () => {
  const normalized = normalizeImgSecCheckResponse({ errcode: 40001, errmsg: 'invalid credential' });
  assert.equal(normalized.decision, 'error');
});

check('-1008 is recognized as a media download error', () => {
  assert.equal(isMediaDownloadError(-1008, '下载错误，请检查媒体链接是否有效'), true);
});

check('ordinary content errors are not treated as download errors', () => {
  assert.equal(isMediaDownloadError(0, 'ok'), false);
});

check('top-level execution error is not converted into a risky rejection', () => {
  const normalized = normalizeMediaCheckCallback({
    trace_id: 'trace-error',
    errcode: 47001,
    errmsg: 'media download failed',
    result: { suggest: 'risky', label: 20002 },
    detail: [{ suggest: 'risky', label: 20002 }]
  });
  assert.equal(normalized.decision, 'error');
  assert.equal(normalized.errcode, 47001);
});

check('detail risky result overrides a top-level pass result', () => {
  const normalized = normalizeMediaCheckCallback({
    trace_id: 'trace-risky',
    errcode: 0,
    result: { suggest: 'pass', label: 100 },
    detail: [
      { strategy: 'content', errcode: 0, suggest: 'risky', label: 20002, prob: 0.99 }
    ]
  });
  assert.equal(normalized.decision, 'reject');
  assert.equal(normalized.label, 20002);
  assert.equal(normalized.decision_source, 'detail[0]');
});

check('detail pass is used when top-level result has no suggest', () => {
  const normalized = normalizeMediaCheckCallback({
    trace_id: 'trace-pass',
    errcode: 0,
    result: { label: 100 },
    detail: [
      { strategy: 'content', errcode: 0, suggest: 'pass', label: 100, prob: 0.01 }
    ]
  });
  assert.equal(normalized.decision, 'pass');
  assert.equal(normalized.suggest, 'pass');
});

check('callback summary includes detail diagnostics', () => {
  const summary = summarizeMediaCheckCallback({
    trace_id: 'trace-review',
    Event: 'wxa_media_check',
    errcode: 0,
    result: { suggest: 'review', label: 21000 },
    detail: [{ strategy: 'content', suggest: 'review', label: 21000, prob: 0.55 }]
  });
  assert.equal(summary.trace_id, 'trace-review');
  assert.equal(summary.event, 'wxa_media_check');
  assert.equal(summary.decision, 'manual_review');
  assert.equal(summary.detail_count, 1);
});

check('media URL logging removes query parameters', () => {
  assert.equal(
    sanitizeUrlForLog('https://www.molink.art/uploads/demo.jpg?signature=secret&expires=1'),
    'https://www.molink.art/uploads/demo.jpg'
  );
});

console.log(JSON.stringify({
  ok: true,
  checks
}, null, 2));
