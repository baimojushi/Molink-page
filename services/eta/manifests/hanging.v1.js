'use strict';

module.exports = Object.freeze({
  version: 'hanging-main-v1',
  jobKind: 'hang_in_home',
  nodes: [
    { id: 'worker_queue', type: 'worker_queue', p50Ms: 20_000, p90Ms: 90_000 },
    { id: 'metric3d', type: 'metric3d', p50Ms: 45_000, p90Ms: 110_000 },
    { id: 'semantic', type: 'semantic', p50Ms: 55_000, p90Ms: 140_000 },
    { id: 'hanging', type: 'hanging', p50Ms: 35_000, p90Ms: 90_000 },
    { id: 'render', type: 'render', p50Ms: 150_000, p90Ms: 360_000, resourceSensitive: true },
    { id: 'styling', type: 'styling', p50Ms: 70_000, p90Ms: 180_000, enabledWhen: features => Boolean(features.styling_requested || features.soft_furnishing_requested) },
    { id: 'upload', type: 'upload', p50Ms: 25_000, p90Ms: 80_000 },
    { id: 'delivery', type: 'delivery', p50Ms: 8_000, p90Ms: 25_000 }
  ]
});
