'use strict';

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function stringify(value) {
  try { return JSON.stringify(value ?? null); } catch (_) { return 'null'; }
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

class SqliteEtaRepository {
  constructor(db) {
    this.db = db;
  }

  transaction(fn) {
    return this.db.transaction(fn)();
  }

  nextLegacySeq(jobId) {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS max_seq
      FROM eta_progress_events
      WHERE job_id = ? AND run_id = ?
    `).get(jobId, `legacy:${jobId}`);
    return Number(row && row.max_seq || 0) + 1;
  }

  insertEvent(event) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO eta_progress_events (
        event_id, protocol_version, job_id, run_id, order_id, seq,
        pipeline_version, job_kind, stage_id, stage_type, stage_version,
        attempt, stage_state, worker_monotonic_ms, stage_active_elapsed_ms,
        work_done, work_total, work_unit, progress_quality, resource_json,
        input_features_json, metadata_json, received_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId, event.protocolVersion, event.jobId, event.runId, event.orderId, event.seq,
      event.pipelineVersion, event.jobKind, event.stageId, event.stageType, event.stageVersion,
      event.attempt, event.stageState, event.workerMonotonicMs, event.stageActiveElapsedMs,
      event.workDone, event.workTotal, event.workUnit, event.progressQuality, stringify(event.resource),
      stringify(event.inputFeatures), stringify(event.metadata), event.receivedAtMs
    );
    return result.changes > 0;
  }

  loadRuntime(jobId) {
    const row = this.db.prepare('SELECT * FROM eta_job_runtime WHERE job_id = ?').get(jobId);
    if (!row) return null;
    return {
      jobId: row.job_id,
      orderId: row.order_id,
      runId: row.run_id,
      protocolVersion: row.protocol_version,
      lastSeq: row.last_seq,
      pipelineVersion: row.pipeline_version,
      jobKind: row.job_kind,
      runtimeState: row.runtime_state,
      currentStageId: row.current_stage_id,
      currentStageType: row.current_stage_type,
      currentStageVersion: row.current_stage_version,
      currentAttempt: row.current_attempt,
      currentStageStartedAtMs: row.current_stage_started_at_ms,
      currentStageActiveElapsedMs: row.current_stage_active_elapsed_ms,
      activeElapsedMs: row.active_elapsed_ms,
      pausedAtMs: row.paused_at_ms,
      lastEventAtMs: row.last_event_at_ms,
      lastWorkerHeartbeatAtMs: row.last_worker_heartbeat_at_ms,
      resource: parseJson(row.resource_json),
      inputFeatures: parseJson(row.input_features_json),
      manifestPatch: parseJson(row.manifest_patch_json),
      pauseCapability: row.pause_capability || 'boundary_only',
      updatedAtMs: row.updated_at_ms
    };
  }

  saveRuntime(runtime) {
    this.db.prepare(`
      INSERT INTO eta_job_runtime (
        job_id, order_id, run_id, protocol_version, last_seq, pipeline_version, job_kind,
        runtime_state, current_stage_id, current_stage_type, current_stage_version,
        current_attempt, current_stage_started_at_ms, current_stage_active_elapsed_ms,
        active_elapsed_ms, paused_at_ms, last_event_at_ms, last_worker_heartbeat_at_ms,
        resource_json, input_features_json, manifest_patch_json, pause_capability, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        order_id=excluded.order_id, run_id=excluded.run_id, protocol_version=excluded.protocol_version,
        last_seq=excluded.last_seq, pipeline_version=excluded.pipeline_version, job_kind=excluded.job_kind,
        runtime_state=excluded.runtime_state, current_stage_id=excluded.current_stage_id,
        current_stage_type=excluded.current_stage_type, current_stage_version=excluded.current_stage_version,
        current_attempt=excluded.current_attempt, current_stage_started_at_ms=excluded.current_stage_started_at_ms,
        current_stage_active_elapsed_ms=excluded.current_stage_active_elapsed_ms,
        active_elapsed_ms=excluded.active_elapsed_ms, paused_at_ms=excluded.paused_at_ms,
        last_event_at_ms=excluded.last_event_at_ms, last_worker_heartbeat_at_ms=excluded.last_worker_heartbeat_at_ms,
        resource_json=excluded.resource_json, input_features_json=excluded.input_features_json,
        manifest_patch_json=excluded.manifest_patch_json, pause_capability=excluded.pause_capability,
        updated_at_ms=excluded.updated_at_ms
    `).run(
      runtime.jobId, runtime.orderId, runtime.runId, runtime.protocolVersion, runtime.lastSeq,
      runtime.pipelineVersion, runtime.jobKind, runtime.runtimeState, runtime.currentStageId,
      runtime.currentStageType, runtime.currentStageVersion, runtime.currentAttempt,
      runtime.currentStageStartedAtMs, runtime.currentStageActiveElapsedMs, runtime.activeElapsedMs,
      runtime.pausedAtMs, runtime.lastEventAtMs, runtime.lastWorkerHeartbeatAtMs,
      stringify(runtime.resource), stringify(runtime.inputFeatures), stringify(runtime.manifestPatch),
      runtime.pauseCapability, runtime.updatedAtMs
    );
  }

  touchHeartbeat(jobId, heartbeat, receivedAtMs) {
    const resource = heartbeat && heartbeat.resource;
    this.db.prepare(`
      UPDATE eta_job_runtime
      SET last_worker_heartbeat_at_ms = ?,
          resource_json = CASE WHEN ? <> '' THEN ? ELSE resource_json END,
          updated_at_ms = MAX(updated_at_ms, ?)
      WHERE job_id = ?
    `).run(receivedAtMs, resource ? '1' : '', resource ? stringify(resource) : '', receivedAtMs, jobId);
  }

  closeStageObservation(observation) {
    this.db.prepare(`
      INSERT OR IGNORE INTO eta_stage_observations (
        observation_id, job_id, run_id, order_id, pipeline_version, job_kind,
        stage_id, stage_type, stage_version, attempt, outcome, censored,
        active_duration_ms, wall_duration_ms, resource_signature, resource_json,
        input_bucket, input_features_json, provider, retry_reason,
        started_at_ms, ended_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.observationId, observation.jobId, observation.runId, observation.orderId,
      observation.pipelineVersion, observation.jobKind, observation.stageId, observation.stageType,
      observation.stageVersion, observation.attempt, observation.outcome, observation.censored,
      observation.activeDurationMs, observation.wallDurationMs, observation.resourceSignature,
      stringify(observation.resource), observation.inputBucket, stringify(observation.inputFeatures),
      observation.provider, observation.retryReason, observation.startedAtMs, observation.endedAtMs,
      observation.createdAtMs
    );
  }

  loadStageDurationSummary(stageType, runtime) {
    let rows = this.db.prepare(`
      SELECT active_duration_ms FROM eta_stage_observations
      WHERE stage_type = ? AND job_kind = ? AND outcome = 'completed' AND censored = 0
        AND pipeline_version = ?
      ORDER BY created_at_ms DESC LIMIT 500
    `).all(stageType, runtime.jobKind, runtime.pipelineVersion);
    let cohortLevel = 'pipeline';
    if (rows.length < 5) {
      rows = this.db.prepare(`
        SELECT active_duration_ms FROM eta_stage_observations
        WHERE stage_type = ? AND job_kind = ? AND outcome = 'completed' AND censored = 0
        ORDER BY created_at_ms DESC LIMIT 500
      `).all(stageType, runtime.jobKind);
      cohortLevel = 'job-kind';
    }
    const values = rows.map(row => Number(row.active_duration_ms)).filter(value => Number.isFinite(value) && value >= 0);
    return {
      sampleCount: values.length,
      p50Ms: quantile(values, 0.5),
      p90Ms: quantile(values, 0.9),
      cohortLevel
    };
  }

  saveSnapshot(snapshot) {
    this.db.prepare(`
      INSERT INTO eta_snapshots (
        job_id, order_id, source_seq, estimate_state, active_p50_ms, active_p90_ms,
        wall_p50_ms, wall_p90_ms, queue_p50_ms, queue_p90_ms, confidence,
        reason_codes_json, components_json, calculated_at_ms, valid_until_ms,
        model_version, pipeline_version, estimator_trace_json, stage_id, stage_type,
        pause_capability
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        order_id=excluded.order_id, source_seq=excluded.source_seq,
        estimate_state=excluded.estimate_state, active_p50_ms=excluded.active_p50_ms,
        active_p90_ms=excluded.active_p90_ms, wall_p50_ms=excluded.wall_p50_ms,
        wall_p90_ms=excluded.wall_p90_ms, queue_p50_ms=excluded.queue_p50_ms,
        queue_p90_ms=excluded.queue_p90_ms, confidence=excluded.confidence,
        reason_codes_json=excluded.reason_codes_json, components_json=excluded.components_json,
        calculated_at_ms=excluded.calculated_at_ms, valid_until_ms=excluded.valid_until_ms,
        model_version=excluded.model_version, pipeline_version=excluded.pipeline_version,
        estimator_trace_json=excluded.estimator_trace_json, stage_id=excluded.stage_id,
        stage_type=excluded.stage_type, pause_capability=excluded.pause_capability
    `).run(
      snapshot.jobId, snapshot.orderId, snapshot.sourceSeq, snapshot.estimateState,
      snapshot.activeP50Ms, snapshot.activeP90Ms, snapshot.wallP50Ms, snapshot.wallP90Ms,
      snapshot.queueP50Ms, snapshot.queueP90Ms, snapshot.confidence,
      stringify(snapshot.reasonCodes), stringify(snapshot.components), snapshot.calculatedAtMs,
      snapshot.validUntilMs, snapshot.modelVersion, snapshot.pipelineVersion,
      stringify(snapshot.estimatorTrace), snapshot.stageId, snapshot.stageType,
      snapshot.pauseCapability
    );
  }

  getSnapshot(jobId) {
    const row = this.db.prepare('SELECT * FROM eta_snapshots WHERE job_id = ?').get(jobId);
    if (!row) return null;
    return {
      jobId: row.job_id, orderId: row.order_id, sourceSeq: row.source_seq,
      estimateState: row.estimate_state, activeP50Ms: row.active_p50_ms,
      activeP90Ms: row.active_p90_ms, wallP50Ms: row.wall_p50_ms,
      wallP90Ms: row.wall_p90_ms, queueP50Ms: row.queue_p50_ms,
      queueP90Ms: row.queue_p90_ms, confidence: row.confidence,
      reasonCodes: parseJson(row.reason_codes_json, []), components: parseJson(row.components_json, []),
      calculatedAtMs: row.calculated_at_ms, validUntilMs: row.valid_until_ms,
      modelVersion: row.model_version, pipelineVersion: row.pipeline_version,
      estimatorTrace: parseJson(row.estimator_trace_json, []), stageId: row.stage_id,
      stageType: row.stage_type, pauseCapability: row.pause_capability
    };
  }

  appendSnapshotHistory(snapshot) {
    const last = this.db.prepare(`
      SELECT calculated_at_ms, source_seq FROM eta_snapshot_history
      WHERE job_id = ? ORDER BY id DESC LIMIT 1
    `).get(snapshot.jobId);
    if (last && last.source_seq === snapshot.sourceSeq && snapshot.calculatedAtMs - last.calculated_at_ms < 30_000) return;
    this.db.prepare(`
      INSERT INTO eta_snapshot_history (
        job_id, source_seq, active_p50_ms, active_p90_ms, calculated_at_ms, model_version
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(snapshot.jobId, snapshot.sourceSeq, snapshot.activeP50Ms, snapshot.activeP90Ms, snapshot.calculatedAtMs, snapshot.modelVersion);
  }
}

module.exports = { SqliteEtaRepository, quantile };
