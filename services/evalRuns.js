const { v4: uuidv4 } = require('uuid');
const { digestOf } = require('./evalDatasets');

function digest(value) {
  return digestOf(value);
}

class EvalRunService {
  constructor({ db, r2, workerHub }) {
    this.db = db;
    this.r2 = r2;
    this.workerHub = workerHub;
  }

  async _readJson(key) {
    const body = await this.r2.downloadObjectBufferByKey(key);
    return JSON.parse(body.toString('utf8'));
  }

  buildShardJob(shard) {
    const run = this.db.prepare('SELECT run_spec_json FROM eval_runs WHERE id = ?').get(shard.run_id);
    const spec = JSON.parse(run?.run_spec_json || '{}');
    return {
      type: 'job_dispatch',
      job_id: shard.job_id,
      job_kind: 'benchmark_shard',
      priority: 'benchmark',
      run_id: shard.run_id,
      shard_id: shard.id,
      pipeline_version: spec.pipeline_version || 'hanging-main-v1',
      manifest_key: shard.manifest_key,
      manifest_digest: shard.manifest_digest,
      result_prefix: shard.result_prefix,
      r2_output_prefix: shard.result_prefix,
      render_provider: spec.render_provider,
      render: spec.render || (spec.render_provider ? { provider: spec.render_provider } : undefined),
      item_defaults: spec.item_defaults || {},
      fault_injection: spec.fault_injection,
      retry_failed_items: Boolean(spec.retry_failed_items)
    };
  }

  async createRun({ datasetVersionId, baselineRunId = null, shardSize = 12, spec = {}, actor = 'admin' }) {
    const version = this.db.prepare(
      "SELECT * FROM eval_dataset_versions WHERE id = ? AND state = 'frozen'"
    ).get(datasetVersionId);
    if (!version) throw new Error('frozen dataset version not found');
    const manifest = await this._readJson(version.manifest_key);
    const datasetDigest = digestOf({
      schema_version: manifest.schema_version,
      items: manifest.items,
      metadata: manifest.metadata || {}
    });
    if (datasetDigest !== version.digest || (manifest.digest && manifest.digest !== version.digest)) {
      throw new Error('dataset manifest digest mismatch');
    }
    const items = Array.isArray(manifest.items) ? manifest.items : [];
    if (!items.length) throw new Error('dataset manifest has no items');
    const size = Math.max(1, Math.min(32, Math.floor(Number(shardSize) || 12)));
    const runId = uuidv4();
    const shards = [];
    for (let offset = 0, shardIndex = 0; offset < items.length; offset += size, shardIndex += 1) {
      const shardItems = items.slice(offset, offset + size);
      const shardId = uuidv4();
      const jobId = `eval-${runId}-${String(shardIndex).padStart(4, '0')}`;
      const shardManifest = {
        schema_version: 1,
        run_id: runId,
        shard_id: shardId,
        shard_index: shardIndex,
        dataset_version_id: version.id,
        dataset_digest: version.digest,
        items: shardItems
      };
      const shardDigest = digest(shardManifest);
      const manifestKey = `eval/runs/${runId}/shards/${String(shardIndex).padStart(4, '0')}/manifest.json`;
      const resultPrefix = `eval/runs/${runId}/shards/${String(shardIndex).padStart(4, '0')}`;
      await this.r2.uploadBuffer({
        key: manifestKey,
        body: Buffer.from(JSON.stringify({ ...shardManifest, digest: shardDigest })),
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store, max-age=0'
      });
      shards.push({ id: shardId, run_id: runId, shard_index: shardIndex, job_id: jobId, manifest_key: manifestKey, manifest_digest: shardDigest, result_prefix: resultPrefix, total_count: shardItems.length });
    }

    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO eval_runs
        (id, dataset_version_id, baseline_run_id, run_spec_json, state, total_count, created_by)
        VALUES (?, ?, ?, ?, 'queued', ?, ?)`
      ).run(runId, datasetVersionId, baselineRunId, JSON.stringify(spec || {}), items.length, actor);
      const insertShard = this.db.prepare(`INSERT INTO eval_run_shards
        (id, run_id, shard_index, job_id, manifest_key, manifest_digest, result_prefix, total_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const shard of shards) {
        insertShard.run(shard.id, shard.run_id, shard.shard_index, shard.job_id, shard.manifest_key, shard.manifest_digest, shard.result_prefix, shard.total_count);
      }
    })();

    for (const shard of shards) this.workerHub.enqueueJob(this.buildShardJob(shard), { priority: 'benchmark' });
    return this.getRun(runId);
  }

  async handleBenchmarkResult(message) {
    const jobId = String(message.job_id || '');
    if (!jobId) return;
    const shard = this.db.prepare('SELECT * FROM eval_run_shards WHERE job_id = ?').get(jobId);
    if (!shard) return;
    if (['completed', 'failed'].includes(shard.state) && (!message.result_key || message.result_key === shard.result_key)) return;
    const terminal = message.status === 'failed' ? 'failed' : 'completed';
    this.db.prepare(`UPDATE eval_run_shards SET
      state = ?, result_key = COALESCE(?, result_key), completed_count = ?, failed_count = ?,
      last_error = ?, started_at = COALESCE(started_at, datetime('now','localtime')),
      completed_at = datetime('now','localtime') WHERE id = ?`
    ).run(
      terminal,
      message.result_key || null,
      Number(message.completed_count) || 0,
      Number(message.failed_count) || (terminal === 'failed' ? shard.total_count : 0),
      message.error || null,
      shard.id
    );
    const refreshed = this._refreshRun(shard.run_id);
    if (refreshed.done) {
      const summaryKey = `eval/runs/${shard.run_id}/run_summary.json`;
      const runSummary = this.getRun(shard.run_id);
      try {
        await this.r2.uploadBuffer({
          key: summaryKey,
          body: Buffer.from(JSON.stringify(runSummary)),
          contentType: 'application/json; charset=utf-8',
          cacheControl: 'no-store, max-age=0'
        });
        this.db.prepare('UPDATE eval_runs SET summary_key = ? WHERE id = ?').run(summaryKey, shard.run_id);
      } catch (error) {
        console.warn(`[eval] run summary upload deferred run=${shard.run_id}: ${error.message}`);
      }
    }
  }

  _refreshRun(runId) {
    const totals = this.db.prepare(`SELECT
      SUM(total_count) AS total_count, SUM(completed_count) AS completed_count,
      SUM(failed_count) AS failed_count,
      SUM(CASE WHEN state IN ('completed','failed') THEN 1 ELSE 0 END) AS terminal_shards,
      COUNT(*) AS shard_count
      FROM eval_run_shards WHERE run_id = ?`).get(runId);
    const done = Number(totals.terminal_shards) === Number(totals.shard_count) && Number(totals.shard_count) > 0;
    const state = done ? (Number(totals.failed_count) > 0 ? 'completed_with_failures' : 'completed') : 'running';
    this.db.prepare(`UPDATE eval_runs SET state = ?, total_count = ?, completed_count = ?, failed_count = ?,
      started_at = COALESCE(started_at, datetime('now','localtime')),
      completed_at = CASE WHEN ? THEN datetime('now','localtime') ELSE completed_at END WHERE id = ?`
    ).run(state, totals.total_count || 0, totals.completed_count || 0, totals.failed_count || 0, done ? 1 : 0, runId);
    return { done, state, ...totals };
  }

  restoreQueuedRuns() {
    const shards = this.db.prepare("SELECT * FROM eval_run_shards WHERE state IN ('queued','running') ORDER BY created_at, shard_index").all();
    for (const shard of shards) {
      this.db.prepare("UPDATE eval_run_shards SET state = 'queued' WHERE id = ?").run(shard.id);
      this.workerHub.enqueueJob(this.buildShardJob(shard), { priority: 'benchmark' });
    }
    return shards.length;
  }

  getRun(id) {
    const run = this.db.prepare(`SELECT r.*, v.dataset_id, v.version_number, v.digest AS dataset_digest
      FROM eval_runs r JOIN eval_dataset_versions v ON v.id = r.dataset_version_id WHERE r.id = ?`).get(id);
    if (!run) return null;
    return {
      ...run,
      run_spec: JSON.parse(run.run_spec_json || '{}'),
      shards: this.db.prepare('SELECT * FROM eval_run_shards WHERE run_id = ? ORDER BY shard_index').all(id),
      score_count: Number(this.db.prepare('SELECT COUNT(*) AS count FROM eval_item_scores WHERE run_id = ?').get(id)?.count || 0)
    };
  }

  listRuns(limit = 50) {
    return this.db.prepare('SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  saveScores(runId, scores, reviewer) {
    if (!this.db.prepare('SELECT id FROM eval_runs WHERE id = ?').get(runId)) throw new Error('run not found');
    if (!Array.isArray(scores) || !scores.length) throw new Error('scores must be a non-empty array');
    const upsert = this.db.prepare(`INSERT INTO eval_item_scores
      (id, run_id, item_id, reviewer, effect_score, geometry_score, aesthetic_score, robustness_score, tags_json, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, item_id, reviewer) DO UPDATE SET
        effect_score=excluded.effect_score, geometry_score=excluded.geometry_score,
        aesthetic_score=excluded.aesthetic_score, robustness_score=excluded.robustness_score,
        tags_json=excluded.tags_json, notes=excluded.notes, updated_at=datetime('now','localtime')`);
    this.db.transaction(() => {
      for (const score of scores) {
        const itemId = String(score.item_id || score.id || '').trim();
        if (!itemId) throw new Error('every score requires item_id');
        const numberOrNull = value => {
          if (value == null || value === '') return null;
          const numeric = Number(value);
          if (!Number.isFinite(numeric) || numeric < 0 || numeric > 5) throw new Error('scores must be between 0 and 5');
          return numeric;
        };
        upsert.run(
          uuidv4(), runId, itemId, reviewer,
          numberOrNull(score.effect_score), numberOrNull(score.geometry_score),
          numberOrNull(score.aesthetic_score), numberOrNull(score.robustness_score),
          JSON.stringify(score.tags || []), String(score.notes || '')
        );
      }
    })();
    return this.db.prepare('SELECT * FROM eval_item_scores WHERE run_id = ? AND reviewer = ? ORDER BY item_id').all(runId, reviewer);
  }
}

module.exports = { EvalRunService };
