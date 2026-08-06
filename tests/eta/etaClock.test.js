'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEtaAnchor, readEta } = require('../../molink-miniapp-auction/utils/etaClock');
const { presentEta } = require('../../molink-miniapp-auction/utils/etaPresenter');

test('ETA clock compensates request RTT and counts down locally', () => {
  const anchor = createEtaAnchor({
    state: 'RUNNING', displayMode: 'POINT_AND_RANGE', confidence: 'MEDIUM',
    wallRemaining: { p50Ms: 120_000, p90Ms: 240_000 },
    serverNowMs: 11_000, calculatedAtMs: 10_000, validUntilMs: 100_000
  }, 9_000, 11_000);
  const value = readEta(anchor, 21_000);
  assert.equal(value.p50Ms, 108_000);
  assert.equal(presentEta(value).visible, true);
});

test('ETA clock stops at stale boundary', () => {
  const anchor = createEtaAnchor({
    state: 'RUNNING', displayMode: 'POINT_AND_RANGE', confidence: 'MEDIUM',
    activeRemaining: { p50Ms: 60_000, p90Ms: 90_000 },
    serverNowMs: 1000, calculatedAtMs: 1000, validUntilMs: 2000
  }, 1000, 1000);
  assert.equal(readEta(anchor, 3000).state, 'STALE');
});
