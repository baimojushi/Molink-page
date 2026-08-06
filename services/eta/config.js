'use strict';

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !['', '0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function intEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

module.exports = Object.freeze({
  enabled: boolEnv('ETA_ENABLED', true),
  shadowMode: boolEnv('ETA_SHADOW_MODE', true),
  uiEnabled: boolEnv('ETA_UI_ENABLED', false),
  protocolV2Required: boolEnv('ETA_PROTOCOL_V2_REQUIRED', false),
  staleAfterMs: intEnv('ETA_STALE_AFTER_MS', 90_000, 10_000),
  expiredAfterMs: intEnv('ETA_EXPIRED_AFTER_MS', 180_000, 30_000),
  minHistoricalSamples: intEnv('ETA_PARENT_COHORT_MIN_SAMPLES', 15, 3),
  exactHistoricalSamples: intEnv('ETA_EXACT_COHORT_MIN_SAMPLES', 30, 5),
  modelVersion: String(process.env.ETA_MODEL_VERSION || 'eta-v1'),
  maxSnapshotHistoryIntervalMs: 30_000
});
