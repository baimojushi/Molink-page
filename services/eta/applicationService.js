'use strict';

const { normalizeProgress } = require('./contracts');
const { reduceTimeline } = require('./timelineReducer');
const { computeEta } = require('./engine/etaEngine');
const { presentSnapshot } = require('./snapshotPresenter');

class EtaApplicationService {
  constructor(repository, config) {
    this.repository = repository;
    this.config = config;
  }

  ingestProgress(rawMessage, receivedAtMs = Date.now()) {
    if (!this.config.enabled) return null;
    const jobId = String(rawMessage && rawMessage.job_id || '');
    const legacySeq = rawMessage && rawMessage.type === 'progress_v2'
      ? null
      : this.repository.nextLegacySeq(jobId);
    const event = normalizeProgress(rawMessage, receivedAtMs, legacySeq);
    let reduced = null;

    this.repository.transaction(() => {
      if (!this.repository.insertEvent(event)) return;
      const current = this.repository.loadRuntime(event.jobId);
      reduced = reduceTimeline(current, event);
      if (reduced.ignored) return;
      this.repository.saveRuntime(reduced.runtime);
      for (const observation of reduced.observations) {
        this.repository.closeStageObservation(observation);
      }
    });

    if (!reduced || reduced.ignored) return this.repository.getSnapshot(event.jobId);
    return this.recalculate(event.jobId, receivedAtMs);
  }

  ingestHeartbeat(rawMessage, receivedAtMs = Date.now()) {
    if (!this.config.enabled) return null;
    const jobId = String(rawMessage && rawMessage.current_job_id || '');
    if (!jobId) return null;
    this.repository.touchHeartbeat(jobId, rawMessage, receivedAtMs);
    const currentStage = rawMessage.current_stage_snapshot;
    if (currentStage && typeof currentStage === 'object' && currentStage.job_id) {
      try { return this.ingestProgress(currentStage, receivedAtMs); } catch (error) {}
    }
    return this.repository.getSnapshot(jobId);
  }

  onJobEnqueued(job, enqueuedAtMs = Date.now()) {
    if (!this.config.enabled || !job || !job.job_id) return null;
    const event = {
      type: 'progress_v2', protocol_version: 2,
      event_id: `enqueue:${job.job_id}:${enqueuedAtMs}`,
      job_id: job.job_id, order_id: job.order_id,
      run_id: `queue:${job.job_id}`, seq: 1,
      pipeline_version: job.pipeline_version || 'hanging-main-v1',
      job_kind: job.job_kind || 'hang_in_home',
      stage: { id: 'worker_queue', type: 'worker_queue', version: 'v1', attempt: 1, state: 'queued', pause_capability: 'immediate' },
      timing: { stage_active_elapsed_ms: 0, job_active_elapsed_ms: 0 },
      work: null, resource: {}, input_features: job.eta_features || {}, metadata: {}, message: 'queued'
    };
    return this.ingestProgress(event, enqueuedAtMs);
  }

  onJobResult(result, receivedAtMs = Date.now()) {
    if (!this.config.enabled || !result) return null;
    const jobId = String(result.job_id || '');
    if (!jobId) return null;
    const runtime = this.repository.loadRuntime(jobId);
    if (!runtime) return null;
    const status = String(result.status || '').toLowerCase();
    runtime.runtimeState = status.startsWith('succeeded') ? 'COMPLETED' : 'FAILED';
    runtime.currentStageId = 'delivery';
    runtime.currentStageType = 'delivery';
    runtime.currentStageVersion = 'v1';
    runtime.currentStageActiveElapsedMs = 0;
    runtime.lastEventAtMs = receivedAtMs;
    runtime.updatedAtMs = receivedAtMs;
    this.repository.saveRuntime(runtime);
    return this.recalculate(jobId, receivedAtMs);
  }

  recalculate(jobId, nowMs = Date.now()) {
    const runtime = this.repository.loadRuntime(jobId);
    if (!runtime) return null;
    const snapshot = computeEta({
      runtime,
      loadStageSummary: (stageType, context) => this.repository.loadStageDurationSummary(stageType, context),
      nowMs,
      modelVersion: this.config.modelVersion,
      staleAfterMs: this.config.staleAfterMs
    });
    this.repository.saveSnapshot(snapshot);
    if (this.config.shadowMode) this.repository.appendSnapshotHistory(snapshot);
    return snapshot;
  }

  getSnapshot(jobId, nowMs = Date.now()) {
    if (!this.config.enabled || !jobId) return null;
    return presentSnapshot(this.repository.getSnapshot(jobId), nowMs, this.config);
  }

  getClientSnapshot(jobId, nowMs = Date.now()) {
    if (!this.config.uiEnabled) return null;
    return this.getSnapshot(jobId, nowMs);
  }
}

module.exports = { EtaApplicationService };
