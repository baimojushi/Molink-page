'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EtaApplicationService } = require('../../services/eta/applicationService');

class FakeRepository {
  constructor() {
    this.events = new Set();
    this.runtimes = new Map();
    this.snapshots = new Map();
    this.observations = [];
  }
  transaction(fn) { return fn(); }
  nextLegacySeq() { return 1; }
  insertEvent(event) {
    const key = `${event.jobId}|${event.runId}|${event.seq}`;
    if (this.events.has(key)) return false;
    this.events.add(key);
    return true;
  }
  loadRuntime(jobId) { return this.runtimes.get(jobId) || null; }
  saveRuntime(runtime) { this.runtimes.set(runtime.jobId, { ...runtime }); }
  closeStageObservation(observation) { this.observations.push(observation); }
  loadStageDurationSummary() { return { sampleCount: 0 }; }
  saveSnapshot(snapshot) { this.snapshots.set(snapshot.jobId, { ...snapshot }); }
  getSnapshot(jobId) { return this.snapshots.get(jobId) || null; }
  appendSnapshotHistory() {}
  touchHeartbeat() {}
}

const config = {
  enabled: true,
  shadowMode: true,
  uiEnabled: true,
  staleAfterMs: 90_000,
  expiredAfterMs: 180_000,
  modelVersion: 'eta-v1'
};

test('application service moves queued job into V2 running state', () => {
  const repository = new FakeRepository();
  const service = new EtaApplicationService(repository, config);
  service.onJobEnqueued({
    job_id: 'job1', order_id: 'order1', job_kind: 'hang_in_home',
    pipeline_version: 'hanging-main-v1', eta_features: { candidate_limit: 3 }
  }, 1000);
  assert.equal(repository.loadRuntime('job1').runtimeState, 'QUEUED');

  service.ingestProgress({
    type: 'progress_v2', protocol_version: 2, event_id: 'evt1',
    job_id: 'job1', order_id: 'order1', run_id: 'run1', seq: 1,
    pipeline_version: 'hanging-main-v1', job_kind: 'hang_in_home',
    stage: { id: 'metric3d', type: 'metric3d', version: 'v1', state: 'running' },
    timing: { stage_active_elapsed_ms: 5000, job_active_elapsed_ms: 5000 },
    input_features: { candidate_limit: 3 }
  }, 6000);

  const runtime = repository.loadRuntime('job1');
  assert.equal(runtime.runtimeState, 'RUNNING');
  assert.equal(runtime.runId, 'run1');
  assert.equal(service.getClientSnapshot('job1', 6000).state, 'RUNNING');
});
