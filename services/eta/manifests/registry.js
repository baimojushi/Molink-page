'use strict';

const hanging = require('./hanging.v1');
const supplement = require('./supplement.v1');

const manifests = new Map([
  [hanging.version, hanging],
  [supplement.version, supplement],
  ['hanging-legacy-v1', hanging]
]);

function getManifest(version, jobKind) {
  if (manifests.has(version)) return manifests.get(version);
  return jobKind === supplement.jobKind ? supplement : hanging;
}

module.exports = { getManifest };
