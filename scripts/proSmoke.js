// scripts/proSmoke.js
//
// 用途：
// - 在业务端 deploy logs 中验证 AutoDL Pro API、实例状态、worker 反连是否正常。
// - 支持 server.js 内部调用，也支持 node scripts/proSmoke.js 直接运行。
// - 不依赖 Railway CLI。

const autodl = require('../services/autodl');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function isRunningStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'running' || s === 'ready';
}

function isStartingStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'starting' || s === 'booting' || s === 'pending';
}

function publicInstanceView(i) {
  return {
    uuid: i.uuid,
    status: i.status,
    sub_status: i.sub_status,
    machine_id: i.machine_id,
    machine_alias: i.machine_alias,
    region_sign: i.region_sign,
    region_name: i.region_name,
    gpu_model: i.gpu_model
  };
}

function getWorkerRowsFromDb(db) {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT
        instance_id,
        gpu_model,
        status,
        current_job_id,
        last_heartbeat,
        registered_at
      FROM worker_connections
      ORDER BY last_heartbeat DESC
      LIMIT 10
    `).all();
  } catch (error) {
    return [];
  }
}

function getWorkerSnapshot(workerHub) {
  if (!workerHub || typeof workerHub.workerSnapshot !== 'function') return [];
  try {
    return workerHub.workerSnapshot();
  } catch {
    return [];
  }
}

function findReadyWorker({ workerHub, db, targetUuid }) {
  const acceptAny = process.env.PRO_SMOKE_ACCEPT_ANY_WORKER !== '0';

  const snapshot = getWorkerSnapshot(workerHub);
  const readyFromMemory = snapshot.find(w => {
    const status = String(w.status || '').toLowerCase();
    const idOk = acceptAny || String(w.instance_id || '') === String(targetUuid || '');
    return idOk && (status === 'idle' || status === 'connected_idle');
  });

  if (readyFromMemory) {
    return {
      source: 'memory',
      worker: readyFromMemory
    };
  }

  const rows = getWorkerRowsFromDb(db);
  const readyFromDb = rows.find(w => {
    const status = String(w.status || '').toLowerCase();
    const idOk = acceptAny || String(w.instance_id || '') === String(targetUuid || '');
    return idOk && status === 'connected_idle';
  });

  if (readyFromDb) {
    return {
      source: 'db',
      worker: readyFromDb
    };
  }

  return null;
}

async function waitForInstanceRunning(uuid, timeoutMs) {
  const intervalMs = Number(process.env.PRO_SMOKE_INSTANCE_POLL_MS || 10000);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';

  while (Date.now() < deadline) {
    const inst = await autodl.getInstanceStatus(uuid).catch(error => {
      console.warn(`[pro-smoke] getInstanceStatus failed: ${error.message}`);
      return null;
    });

    if (inst) {
      lastStatus = inst.status;
      console.log(`[pro-smoke] instance ${uuid} status=${inst.status || '-'} sub_status=${inst.sub_status || '-'}`);

      if (isRunningStatus(inst.status)) {
        return inst;
      }

      if (!isStartingStatus(inst.status)) {
        console.log(`[pro-smoke] instance is not running yet: ${inst.status || 'unknown'}`);
      }
    } else {
      console.log(`[pro-smoke] instance ${uuid} not found in list yet`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`等待 Pro 实例 running 超时，uuid=${uuid}, last_status=${lastStatus || 'unknown'}`);
}

async function waitForWorkerReady({ workerHub, db, targetUuid, timeoutMs }) {
  const intervalMs = Number(process.env.PRO_SMOKE_WORKER_POLL_MS || 15000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = findReadyWorker({ workerHub, db, targetUuid });
    const snapshot = getWorkerSnapshot(workerHub);
    const rows = getWorkerRowsFromDb(db);

    if (ready) {
      console.log(`[pro-smoke] worker ready from ${ready.source}: ${JSON.stringify(ready.worker)}`);
      return ready.worker;
    }

    const wsDiagnostics = typeof workerHub?.wsDiagnostics === 'function'
      ? workerHub.wsDiagnostics()
      : [];

    console.log(
      `[pro-smoke] waiting worker ready... ` +
      `memory=${JSON.stringify(snapshot)} ` +
      `db=${JSON.stringify(rows)} ` +
      `ws=${JSON.stringify(wsDiagnostics)}`
    );
    await sleep(intervalMs);
  }

  throw new Error(`等待 worker 反连 ready 超时，target=${targetUuid}`);
}

async function runFromServer({ workerHub, db } = {}) {
  console.log(`[pro-smoke] ===== AutoDL Pro smoke started at ${now()} =====`);

  if (!autodl.isConfigured()) {
    throw new Error('AutoDL 未启用或 AUTODL_TOKEN 未配置');
  }

  console.log(`[pro-smoke] base=${process.env.AUTODL_API_BASE || 'https://api.autodl.com'}`);
  console.log(`[pro-smoke] list_path=${process.env.AUTODL_PATH_LIST || '/api/v1/dev/instance/pro/list'}`);
  console.log(`[pro-smoke] auth_prefix=${process.env.AUTODL_AUTH_PREFIX || '(empty/raw token)'}`);
  console.log(`[pro-smoke] worker_secret_configured=${Boolean(process.env.WORKER_SECRET)}`);

  const list = await autodl.listInstances();
  console.log(`[pro-smoke] pro/list count=${list.length}`);
  console.log(JSON.stringify(list.map(publicInstanceView), null, 2));

  const target = autodl.pickPreferredInstance(list);
  if (!target || !target.uuid) {
    throw new Error('没有可用 Pro 实例：pro/list 为空且未配置 AUTODL_PRO_INSTANCE_ID');
  }

  console.log(`[pro-smoke] target=${target.uuid}, status=${target.status || 'unknown'}, gpu=${target.gpu || target.gpu_model || '-'}`);

  if (process.env.PRO_SMOKE_POWER_ON === '1') {
    console.log('[pro-smoke] power_on enabled, calling AutoDL Pro power_on...');
    await autodl.startInstance(target.uuid);
    console.log('[pro-smoke] power_on request sent');
  } else {
    console.log('[pro-smoke] PRO_SMOKE_POWER_ON != 1, skip power_on');
  }

  if (process.env.PRO_SMOKE_WAIT_RUNNING !== '0') {
    const runningTimeoutMs = Number(process.env.PRO_SMOKE_INSTANCE_TIMEOUT_MS || 10 * 60 * 1000);
    await waitForInstanceRunning(target.uuid, runningTimeoutMs);
  }

  if (process.env.PRO_SMOKE_WAIT_WORKER !== '0') {
    const workerTimeoutMs = Number(process.env.PRO_SMOKE_WORKER_TIMEOUT_MS || 45 * 60 * 1000);
    await waitForWorkerReady({
      workerHub,
      db,
      targetUuid: target.uuid,
      timeoutMs: workerTimeoutMs
    });
  }

  console.log(`[pro-smoke] ✅ AutoDL Pro smoke passed at ${now()}`);
}

async function runCli() {
  let db = null;
  try {
    db = require('../database');
  } catch {}

  await runFromServer({ db });
}

if (require.main === module) {
  runCli().catch(error => {
    console.error('[pro-smoke] ❌ failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  runFromServer
};
