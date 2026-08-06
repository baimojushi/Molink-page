const express = require('express');
const db = require('../database');
const r2 = require('../services/r2');
const workerHub = require('../services/workerHub');
const { EvalDatasetService } = require('../services/evalDatasets');
const { EvalRunService } = require('../services/evalRuns');

const router = express.Router();
const datasets = new EvalDatasetService({ db, r2 });
const runs = new EvalRunService({ db, r2, workerHub });

function actor(req) {
  return String(req.headers['x-admin-actor'] || req.headers['x-admin-user'] || 'admin').trim() || 'admin';
}

router.get('/datasets', (_req, res) => {
  res.json({ datasets: datasets.list() });
});

router.post('/datasets/freeze', async (req, res) => {
  try {
    const version = await datasets.freeze({ ...req.body, actor: actor(req) });
    res.status(201).json({ dataset_version: version });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/dataset-versions/:id', (req, res) => {
  const version = datasets.getVersion(req.params.id);
  if (!version) return res.status(404).json({ error: 'dataset version not found' });
  res.json({ dataset_version: version });
});

router.post('/runs', async (req, res) => {
  try {
    const run = await runs.createRun({
      datasetVersionId: req.body.dataset_version_id,
      baselineRunId: req.body.baseline_run_id || null,
      shardSize: req.body.shard_size,
      spec: req.body.spec || {},
      actor: actor(req)
    });
    res.status(202).json({ run, queues: workerHub.queueSnapshot() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/runs', (req, res) => {
  res.json({ runs: runs.listRuns(req.query.limit), queues: workerHub.queueSnapshot() });
});

router.get('/runs/:id', (req, res) => {
  const run = runs.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json({ run, queues: workerHub.queueSnapshot() });
});

router.post('/runs/:id/scores', (req, res) => {
  try {
    const reviewer = String(req.body.reviewer || actor(req)).trim();
    const scores = runs.saveScores(req.params.id, req.body.scores, reviewer);
    res.json({ scores });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.evalRunService = runs;
module.exports = router;
