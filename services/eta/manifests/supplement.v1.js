'use strict';

module.exports = Object.freeze({
  version: 'hanging-supplement-v1',
  jobKind: 'hanging_supplement_render',
  nodes: [
    { id: 'worker_queue', type: 'worker_queue', p50Ms: 20_000, p90Ms: 90_000 },
    { id: 'render', type: 'render', p50Ms: 120_000, p90Ms: 300_000, resourceSensitive: true },
    { id: 'styling', type: 'styling', p50Ms: 60_000, p90Ms: 160_000, enabledWhen: features => Boolean(features.styling_requested || features.soft_furnishing_requested) },
    { id: 'upload', type: 'upload', p50Ms: 20_000, p90Ms: 70_000 },
    { id: 'delivery', type: 'delivery', p50Ms: 8_000, p90Ms: 25_000 }
  ]
});
