const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { EvalDatasetService } = require('../../services/evalDatasets');
const { EvalRunService } = require('../../services/evalRuns');

function testDatabase() {
  const native = new DatabaseSync(':memory:');
  const source = fs.readFileSync(path.join(__dirname, '../../database.js'), 'utf8');
  const marker = source.indexOf('// Automated evaluation Phase 0/1.');
  const start = source.indexOf('db.exec(`', marker) + 'db.exec(`'.length;
  const end = source.indexOf('\n`);', start);
  assert.ok(marker >= 0 && start > marker && end > start, 'evaluation schema block not found');
  native.exec(source.slice(start, end));
  return {
    prepare: sql => native.prepare(sql),
    transaction: fn => (...args) => {
      native.exec('BEGIN');
      try {
        const result = fn(...args);
        native.exec('COMMIT');
        return result;
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

class FakeR2 {
  constructor() { this.objects = new Map(); }
  async uploadBuffer({ key, body }) { this.objects.set(key, Buffer.from(body)); return { key }; }
  async downloadObjectBufferByKey(key) {
    if (!this.objects.has(key)) throw new Error(`missing fake object ${key}`);
    return this.objects.get(key);
  }
}

test('frozen dataset schedules R2-native shards and accepts batch scores', async () => {
  const db = testDatabase();
  const r2 = new FakeR2();
  const queued = [];
  const workerHub = { enqueueJob(job, options) { queued.push({ job, options }); } };
  const datasets = new EvalDatasetService({ db, r2 });
  const runs = new EvalRunService({ db, r2, workerHub });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const version = await datasets.freeze({
    name: `baseline-${suffix}`,
    metadata: { baseline: true },
    items: [1, 2].map(index => ({
      id: `room-${index}`,
      room_image_url: `https://r2/room-${index}.jpg`,
      artwork_image_url: 'https://r2/art.png',
      artwork: { physical_width_m: 0.8, physical_height_m: 1.2 }
    }))
  });
  const run = await runs.createRun({ datasetVersionId: version.id, shardSize: 1, spec: { render_provider: 'mock' } });
  assert.equal(run.shards.length, 2);
  assert.equal(queued.length, 2);
  assert.ok(queued.every(entry => entry.job.job_kind === 'benchmark_shard' && entry.options.priority === 'benchmark'));

  for (const shard of run.shards) {
    await runs.handleBenchmarkResult({
      job_id: shard.job_id,
      status: 'completed',
      completed_count: 1,
      failed_count: 0,
      result_key: `${shard.result_prefix}/shard_summary.json`
    });
  }
  const completed = runs.getRun(run.id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completed_count, 2);

  const scores = runs.saveScores(run.id, [{ item_id: 'room-1', effect_score: 4.5, robustness_score: 4 }], 'reviewer-a');
  assert.equal(scores.length, 1);
  assert.equal(scores[0].effect_score, 4.5);
});
