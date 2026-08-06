'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TimeAwareEma } = require('../../services/eta/estimators/timeAwareEma');

test('time-aware EMA converges with uneven intervals', () => {
  const ema = new TimeAwareEma(60_000);
  ema.add(10, 1_000);
  ema.add(20, 9_000);
  assert.ok(ema.mean > 18 && ema.mean <= 20);
  assert.ok(ema.stddev >= 0);
});

test('time-aware EMA rejects invalid samples', () => {
  const ema = new TimeAwareEma(15_000);
  assert.equal(ema.add(-1, 1000), false);
  assert.equal(ema.add(Number.NaN, 1000), false);
  assert.equal(ema.mean, null);
});
