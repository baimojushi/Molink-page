// services/workerHub.js —— GPU worker 反隧道 WebSocket Hub
//
// GPU worker（AutoDL，无稳定公网 IP）主动连入业务端 wss://.../api/gpu/worker-connect，
// 业务端维护连接注册表 + 作业队列，向 worker 分发作业、接收进度与结果。
// 所有方向均由 GPU 端发起连接，GPU 无需暴露公网端口。
//
// 持久化兜底：作业入队的同时由 orders.hanging_status='hanging_queued' 落库，
// 服务重启后由 server.js 从 SQLite 重新入队。

const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const crypto = require('crypto');

const HEARTBEAT_TIMEOUT_MS = parseInt(process.env.WORKER_HEARTBEAT_TIMEOUT_MS || '600000', 10);
const KEEPALIVE_INTERVAL_MS = parseInt(process.env.WORKER_KEEPALIVE_INTERVAL_MS || '20000', 10);
const KEEPALIVE_PONG_TIMEOUT_MS = parseInt(process.env.WORKER_KEEPALIVE_PONG_TIMEOUT_MS || '120000', 10);
const REQUEUE_DELAY_MS = parseInt(process.env.WORKER_REQUEUE_DELAY_MS || '30000', 10);
const R2_RESULT_GRACE_MS = parseInt(process.env.WORKER_R2_RESULT_GRACE_MS || '180000', 10);
const R2_RESULT_RECHECK_MS = parseInt(process.env.WORKER_R2_RESULT_RECHECK_MS || '30000', 10);
const REGISTER_DISPATCH_DELAY_MS = parseInt(process.env.WORKER_REGISTER_DISPATCH_DELAY_MS || '1000', 10);
const RESULT_DEDUPE_TTL_MS = parseInt(process.env.WORKER_RESULT_DEDUPE_TTL_MS || '86400000', 10);
const DELIVERED_ORDER_STATUSES = new Set(['delivered', 'viewed', 'downloaded']);
const TERMINAL_HANGING_STATUSES = new Set([
  'succeeded',
  'succeeded_partial',
  'render_review',
  'no_safe_wall',
  'failed'
]);

// 仅输出 token/secret 的指纹，不输出真实 secret
function secretFingerprint(value) {
  const text = String(value || '');
  if (!text) return '(empty)';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));

  return a.length > 0 &&
    a.length === b.length &&
    crypto.timingSafeEqual(a, b);
}
const SWEEP_INTERVAL_MS = parseInt(process.env.WORKER_SWEEP_INTERVAL_MS || '60000', 10);

function gpuRank(model) {
  return String(model || '').includes('TITAN Xp') ? 0 : 1;
}

function resolveWorkerInstanceId(input) {
  const raw = String(input || '').trim();

  if (raw && raw !== 'autodl-local' && raw !== '__REPLACE_ME__') {
    return raw;
  }

  let fromAutodl = '';
  try {
    const autodl = require('./autodl');
    fromAutodl = typeof autodl.getLastTargetInstanceId === 'function'
      ? autodl.getLastTargetInstanceId()
      : '';
  } catch (error) {}

  return fromAutodl ||
    process.env.AUTODL_PRO_INSTANCE_ID ||
    process.env.AUTODL_INSTANCE_ID ||
    process.env.AUTODL_INSTANCE_TITAN_XP ||
    process.env.AUTODL_INSTANCE_RTX2080TI ||
    'autodl-pro-primary';
}

class WorkerHub {
  constructor() {
    this.workers = new Map(); // instance_id → { ws, gpu_model, status, current_job_id, last_hb }
    this.jobQueue = [];
    this.benchmarkQueue = [];
    this.inflightJobs = new Map();
    this.db = null;
    this.resultProcessor = null;
    this.progressHandler = null;
    this.heartbeatHandler = null;
    this.jobEnqueuedHandler = null;
    this.benchmarkHandler = null;
    this._sweepTimer = null;
    this._keepaliveTimer = null;
    this.pendingRequeueTimers = new Map();
    this.uploadedOutputGrace = new Map();
    this.resultProcessing = new Map();
    this.resultCleanupTimers = new Map();
    this.r2Client = null;
    this.wss = null;

    this.wsEvents = [];
  }

  // 注入依赖，避免循环 require
  configure({ db, resultProcessor, progressHandler, heartbeatHandler, jobEnqueuedHandler, benchmarkHandler, buildJobFromOrder, buildBenchmarkJob, r2Client } = {}) {
    if (db) this.db = db;
    if (resultProcessor) this.resultProcessor = resultProcessor;
    if (progressHandler) this.progressHandler = progressHandler;
    if (heartbeatHandler) this.heartbeatHandler = heartbeatHandler;
    if (jobEnqueuedHandler) this.jobEnqueuedHandler = jobEnqueuedHandler;
    if (benchmarkHandler) this.benchmarkHandler = benchmarkHandler;
    if (buildJobFromOrder) this.buildJobFromOrder = buildJobFromOrder;
    if (buildBenchmarkJob) this.buildBenchmarkJob = buildBenchmarkJob;
    if (r2Client) this.r2Client = r2Client;
  }

  _getR2Client() {
    return this.r2Client || require('./r2');
  }

  attach(server) {
    const wss = new WebSocketServer({ server, path: '/api/gpu/worker-connect' });
    this.wss = wss;
    wss.on('connection', (ws, req) => {
      let token = '';
      let peer = '';

      try {
        const parsed = new URL(req.url || '/', 'http://worker');
        token = parsed.searchParams.get('token') || '';
        peer = String(
          req.headers['x-forwarded-for'] ||
          req.socket?.remoteAddress ||
          ''
        ).split(',')[0].trim();
      } catch {}

      const expected = String(process.env.WORKER_SECRET || '');

      this._recordWsEvent('open', {
        peer,
        token_fp: secretFingerprint(token),
        expected_fp: secretFingerprint(expected)
      });

      if (!sameSecret(token, expected)) {
        this._recordWsEvent('rejected', {
          peer,
          reason: !expected
            ? 'server_worker_secret_missing'
            : !token
              ? 'worker_token_missing'
              : 'worker_token_mismatch',
          token_fp: secretFingerprint(token),
          expected_fp: secretFingerprint(expected)
        });

        ws.close(1008, 'Unauthorized');
        return;
      }

      this._recordWsEvent('accepted', { peer });

      ws._molink_peer = peer;
      ws._molink_last_protocol_pong_at = Date.now();
      ws.on('pong', () => {
        ws._molink_last_protocol_pong_at = Date.now();
        this._touchWorkerBySocket(ws, {});
      });

      let registered = false;

      const registrationTimer = setTimeout(() => {
        if (!registered) {
          this._recordWsEvent('register_timeout', { peer });
          ws.close(1008, 'Register timeout');
        }
      }, 20_000);

      registrationTimer.unref?.();

      ws.on('message', raw => {
        let msg = null;

        try {
          msg = JSON.parse(String(raw));
        } catch {
          this._recordWsEvent('invalid_json', { peer });
          return;
        }

        if (msg.type === 'register') {
          registered = true;
          clearTimeout(registrationTimer);

          this._recordWsEvent('register', {
            peer,
            instance_id: String(msg.instance_id || ''),
            gpu_model: String(msg.gpu_model || '')
          });
        }

        this._touchWorkerBySocket(ws, msg);

        try {
          this._handle(ws, msg);
        } catch (err) {
          console.error('[hub] handle error:', err.message);
        }
      });

      ws.on('close', (code, reason) => {
        clearTimeout(registrationTimer);

        this._recordWsEvent('close', {
          peer,
          code,
          reason: String(reason || '')
        });

        for (const [id, worker] of this.workers) {
          if (worker.ws !== ws) continue;

          if (worker.current_job_id) {
            this._scheduleRequeueByJobId(worker.current_job_id, 'ws_close', {
              instance_id: id,
              code,
              reason: String(reason || '')
            });
          }

          this.workers.delete(id);
          this._syncWorkerRow(id, {
            status: 'disconnected',
            current_job_id: null
          });
        }
      });

      ws.on('error', error => {
        this._recordWsEvent('error', {
          peer,
          message: error.message
        });
      });
    });

    if (!this._sweepTimer) {
      this._sweepTimer = setInterval(() => this._sweepStaleWorkers(), SWEEP_INTERVAL_MS);
      if (this._sweepTimer.unref) this._sweepTimer.unref();
    }
    if (!this._keepaliveTimer) {
      this._keepaliveTimer = setInterval(() => this._sendKeepalivePings(), KEEPALIVE_INTERVAL_MS);
      if (this._keepaliveTimer.unref) this._keepaliveTimer.unref();
    }
    console.log('[hub] WebSocket worker hub 已挂载于 /api/gpu/worker-connect');
  }

  _handle(ws, msg) {
    switch (msg.type) {
      case 'register': {
        const instanceId = resolveWorkerInstanceId(msg.instance_id);
        if (instanceId !== String(msg.instance_id || '').trim()) {
          console.warn(`[hub] worker instance_id="${msg.instance_id || ''}" 已归一化为 "${instanceId}"`);
        }

        const existing = this.workers.get(instanceId);
        const requestedJobId = String(msg.current_job_id || '').trim() || null;
        const resumeBusy = Boolean(
          requestedJobId &&
          (msg.resume_inflight_job === true || String(msg.status || '') === 'busy')
        );
        const replacingSameInflight = Boolean(
          existing &&
          existing.ws !== ws &&
          resumeBusy &&
          existing.current_job_id === requestedJobId &&
          String(msg.connection_role || 'primary') === 'primary'
        );
        if (
          existing &&
          existing.ws !== ws &&
          existing.current_job_id &&
          existing.status === 'busy' &&
          existing.ws &&
          existing.ws.readyState === WebSocket.OPEN &&
          !replacingSameInflight
        ) {
          // Worker.send_result 的重连重发会新建一个短连接并再次 register。
          // 这个短连接只用于补发 result/progress，不能覆盖仍在执行作业的主 worker 连接，
          // 否则 hub 会把同一 instance 误判为空闲并把后续 job 派到即将关闭的临时连接上。
          ws._molink_auxiliary_worker = true;
          ws._molink_worker_instance_id = instanceId;
          this._recordWsEvent('auxiliary_register_ignored', {
            instance_id: instanceId,
            current_job_id: existing.current_job_id,
            reason: 'keep_busy_primary_worker_connection'
          });
          this._syncWorkerRow(instanceId, {
            gpu_model: msg.gpu_model,
            status: 'connected_busy',
            current_job_id: existing.current_job_id,
            registered: true
          });
          break;
        }

        if (replacingSameInflight) {
          existing.ws._molink_superseded = true;
          this._recordWsEvent('primary_reconnected_inflight', {
            instance_id: instanceId,
            current_job_id: requestedJobId,
            old_peer: existing.ws._molink_peer || null,
            new_peer: ws._molink_peer || null
          });
          try { existing.ws.close(1000, 'superseded by reconnect'); } catch (error) {}
        }

        this.workers.set(instanceId, {
          ws,
          gpu_model: msg.gpu_model || 'unknown',
          resource: {
            instance_id: instanceId,
            gpu_model: msg.gpu_model || 'unknown',
            gpu_count: Number(msg.gpu_count) || 0,
            worker_version: msg.worker_version || 'unknown',
            precision: msg.precision || 'unknown',
            benchmark_score: Number(msg.benchmark_score) || null,
            services: Array.isArray(msg.services) ? msg.services.map(String) : []
          },
          status: resumeBusy ? 'busy' : 'idle',
          current_job_id: resumeBusy ? requestedJobId : null,
          last_hb: Date.now(),
          current_stage_snapshot: existing?.current_stage_snapshot || null
        });

        if (resumeBusy && requestedJobId) {
          this._cancelPendingRequeue(requestedJobId, 'worker_reconnected_inflight');
        }
        console.log(`[hub] worker registered: ${instanceId} (${msg.gpu_model}) status=${resumeBusy ? 'busy' : 'idle'} current_job_id=${requestedJobId || ''}`);
        this._syncWorkerRow(instanceId, {
          gpu_model: msg.gpu_model,
          status: resumeBusy ? 'connected_busy' : 'connected_idle',
          current_job_id: resumeBusy ? requestedJobId : null,
          registered: true
        });

        const dispatchAfterRegister = () => {
          const current = this.workers.get(instanceId);
          if (current && current.ws === ws && current.status === 'idle') {
            this.tryDispatch();
          }
        };
        if (REGISTER_DISPATCH_DELAY_MS > 0) {
          const timer = setTimeout(dispatchAfterRegister, REGISTER_DISPATCH_DELAY_MS);
          if (timer.unref) timer.unref();
        } else {
          dispatchAfterRegister();
        }
        break;
      }

      case 'ping': {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', server_ts: Date.now() }));
          }
        } catch (e) {
          console.warn('[hub] pong send failed:', e.message);
        }
        break;
      }

      case 'pong':
        break;

      case 'heartbeat': {
        const instanceId = resolveWorkerInstanceId(msg.instance_id);
        const w = this.workers.get(instanceId);
        if (w) {
          w.status = msg.status || w.status;
          w.last_hb = Date.now();
          w.current_job_id = msg.current_job_id || w.current_job_id || null;
          if (msg.resource && typeof msg.resource === 'object') w.resource = { ...w.resource, ...msg.resource };
          if (msg.current_stage_snapshot && typeof msg.current_stage_snapshot === 'object') {
            w.current_stage_snapshot = msg.current_stage_snapshot;
          }
          if (msg.benchmark_snapshot && typeof msg.benchmark_snapshot === 'object') {
            w.benchmark_snapshot = msg.benchmark_snapshot;
          }
          this._syncWorkerRow(instanceId, {
            status: msg.status === 'busy' ? 'connected_busy' : 'connected_idle',
            current_job_id: msg.current_job_id || null
          });
        }
        if (this.heartbeatHandler) {
          try { this.heartbeatHandler(msg); } catch (e) { console.error('[hub] heartbeat handler:', e.message); }
        }
        break;
      }

      case 'job_accepted': {
        const instanceId = resolveWorkerInstanceId(msg.instance_id);
        const wa = this.workers.get(instanceId);
        if (wa) {
          wa.status = 'busy';
          wa.current_job_id = msg.job_id;
        }
        this._syncWorkerRow(instanceId, { status: 'connected_busy', current_job_id: msg.job_id });
        const acceptedJob = this.inflightJobs.get(msg.job_id);
        if (acceptedJob?.job_kind === 'benchmark_shard' && this.db) {
          try {
            this.db.prepare(`UPDATE eval_run_shards SET state='running', attempt=attempt+1,
              started_at=COALESCE(started_at, datetime('now','localtime')) WHERE job_id=?`).run(msg.job_id);
            this.db.prepare(`UPDATE eval_runs SET state='running',
              started_at=COALESCE(started_at, datetime('now','localtime')) WHERE id=?`).run(acceptedJob.run_id);
          } catch (error) {
            console.warn(`[hub] benchmark accepted state update skipped: ${error.message}`);
          }
        }
        break;
      }

      case 'progress':
      case 'progress_v2':
        if (this.progressHandler) {
          try { this.progressHandler(msg); } catch (e) { console.error('[hub] progress handler:', e.message); }
        }
        break;

      case 'benchmark_result': {
        const jobId = String(msg.job_id || '');
        if (this.benchmarkHandler) {
          Promise.resolve(this.benchmarkHandler(msg))
            .then(() => {
              if (jobId) this._cancelPendingRequeue(jobId, 'benchmark_result_processed');
              if (jobId) this.inflightJobs.delete(jobId);
            })
            .catch(error => {
              console.error('[hub] benchmark handler:', error.message);
              if (jobId) this._scheduleRequeueByJobId(jobId, 'benchmark_handler_failed');
            });
        } else if (jobId) {
          this.inflightJobs.delete(jobId);
        }
        break;
      }

      case 'result': {
        const payload = msg.payload || msg;
        const worker = this._touchWorkerBySocket(ws, msg);
        if (worker && !worker.current_job_id) {
          worker.status = 'result_only';
        }
        const jobId = payload.job_id || msg.job_id;
        if (jobId) this._cancelPendingRequeue(jobId, 'result_received');
        if (jobId) this.uploadedOutputGrace.delete(jobId);

        // 补发结果处理：worker 重连后可能补发之前因 progress 发送失败
        // 而被错误标记为失败的任务的真正结果。需要确保即使订单当前
        // 处于 hanging_failed 状态，补发的成功结果仍能覆盖它。
        const isRetroactiveResult = (
          Boolean(ws._molink_auxiliary_worker) &&
          (payload.status === 'succeeded' || payload.status === 'succeeded_partial')
        );
        if (isRetroactiveResult && this.db && jobId) {
          try {
            const order = this.db.prepare(
              "SELECT id, status, hanging_status FROM orders WHERE hanging_job_id = ?"
            ).get(jobId);
            if (order && order.hanging_status === 'failed') {
              this._recordWsEvent('retroactive_result_override', {
                job_id: jobId,
                order_id: order.id,
                previous_hanging_status: 'failed',
                new_status: payload.status
              });
              // 清除失败状态，让 resultProcessor 重新处理
              this.db.prepare(
                "UPDATE orders SET hanging_status = NULL WHERE id = ?"
              ).run(order.id);
            }
          } catch (e) {
            console.warn('[hub] retroactive result check failed:', e.message);
          }
        }

        this._processResultAndAck(ws, msg, payload).catch(e => {
          console.error('[hub] result processor:', e.message);
        });
        break;
      }

      case 'worker_idle': {
        const instanceId = resolveWorkerInstanceId(msg.instance_id);
        const wi = this.workers.get(instanceId);
        if (wi) {
          if (wi.current_job_id) this.inflightJobs.delete(wi.current_job_id);
          wi.status = 'idle';
          wi.current_job_id = null;
        }
        this._syncWorkerRow(instanceId, { status: 'connected_idle', current_job_id: null });
        this.tryDispatch();
        break;
      }

      case 'shutting_down': {
        const instanceId = resolveWorkerInstanceId(msg.instance_id);
        console.log(`[hub] worker ${instanceId} shutting down: ${msg.reason}`);
        this.workers.delete(instanceId);
        this._syncWorkerRow(instanceId, { status: 'disconnected', current_job_id: null });
        break;
      }
    }
  }

  _sendResultAck(ws, details) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: 'result_ack', server_ts: Date.now(), ...details }));
      return true;
    } catch (error) {
      this._recordWsEvent('result_ack_send_failed', {
        job_id: details?.job_id || null,
        result_id: details?.result_id || null,
        message: error.message
      });
      return false;
    }
  }

  _scheduleResultProcessingCleanup(resultId) {
    if (!resultId || this.resultCleanupTimers.has(resultId)) return;
    const cleanupTimer = setTimeout(() => {
      this.resultProcessing.delete(resultId);
      this.resultCleanupTimers.delete(resultId);
    }, RESULT_DEDUPE_TTL_MS);
    cleanupTimer.unref?.();
    this.resultCleanupTimers.set(resultId, cleanupTimer);
  }

  _forgetFailedResult(resultId) {
    this.resultProcessing.delete(resultId);
    const timer = this.resultCleanupTimers.get(resultId);
    if (timer) clearTimeout(timer);
    this.resultCleanupTimers.delete(resultId);
  }

  _processResultPayloadOnce(payload, resultId) {
    if (!this.resultProcessor) {
      return Promise.reject(new Error('result_processor_not_configured'));
    }
    let processing = this.resultProcessing.get(resultId);
    if (!processing) {
      processing = Promise.resolve().then(() => this.resultProcessor(payload));
      this.resultProcessing.set(resultId, processing);
    }
    return processing;
  }

  async _processResultAndAck(ws, msg, payload) {
    const jobId = String(payload?.job_id || msg?.job_id || '');
    const resultId = String(
      msg?.result_id || payload?.transport_result_id || `${jobId || 'job'}:legacy`
    );

    try {
      await this._processResultPayloadOnce(payload, resultId);
      this._scheduleResultProcessingCleanup(resultId);
      if (jobId) this._cancelPendingRequeue(jobId, 'result_processed');
      this._sendResultAck(ws, {
        accepted: true,
        retryable: false,
        job_id: jobId,
        result_id: resultId,
        status: payload?.status || msg?.status || null
      });
      this._recordWsEvent('result_ack', {
        job_id: jobId,
        result_id: resultId,
        status: payload?.status || msg?.status || null
      });
    } catch (error) {
      this._forgetFailedResult(resultId);
      this._sendResultAck(ws, {
        accepted: false,
        retryable: true,
        job_id: jobId,
        result_id: resultId,
        error: error.message
      });
      throw error;
    }
  }

  enqueueJob(job, options = {}) {
    if (!job || !job.job_id) return;
    if (this._isJobTerminal(job.job_id)) {
      console.log(`[hub] skip enqueue terminal job ${job.job_id}`);
      return;
    }
    if (this.jobQueue.some(j => j.job_id === job.job_id)) return; // 队列去重
    if (this.benchmarkQueue.some(j => j.job_id === job.job_id)) return;
    if ([...this.workers.values()].some(w => w.current_job_id === job.job_id)) return; // 在途去重
    if (this.inflightJobs.has(job.job_id)) return;
    const priority = String(options.priority || job.priority || (job.job_kind === 'benchmark_shard' ? 'benchmark' : 'production'));
    if (priority === 'benchmark') this.benchmarkQueue.push({ ...job, priority: 'benchmark' });
    else this.jobQueue.push({ ...job, priority: 'production' });
    if (this.jobEnqueuedHandler) {
      try { this.jobEnqueuedHandler(job); } catch (error) { console.error('[hub] enqueue handler:', error.message); }
    }
    this.tryDispatch();
  }

  tryDispatch() {
    if (!this.jobQueue.length && !this.benchmarkQueue.length) return;
    const idleWorkers = [...this.workers.values()]
      .filter(w => w.status === 'idle')
      .sort((a, b) => gpuRank(a.gpu_model) - gpuRank(b.gpu_model));
    if (!idleWorkers.length) return;

    let queue = this.jobQueue;
    let idle = idleWorkers[0];
    if (!queue.length) {
      queue = this.benchmarkQueue;
      idle = idleWorkers.find(worker => (worker.resource?.services || []).includes('benchmark'));
      if (!idle) return;
    }
    const job = queue.shift();
    idle.status = 'busy';
    this.inflightJobs.set(job.job_id, job);
    for (const [id, w] of this.workers) {
      if (w === idle) { idle.current_job_id = job.job_id; this._syncWorkerRow(id, { status: 'connected_busy', current_job_id: job.job_id }); break; }
    }
    try {
      if (idle.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`worker websocket not open: ${idle.ws.readyState}`);
      }
      idle.ws.send(JSON.stringify({ type: 'job_dispatch', ...job }));
      console.log(`[hub] dispatched ${job.job_id} → ${idle.gpu_model}`);
    } catch (err) {
      console.error('[hub] dispatch send failed, requeue:', err.message);
      idle.status = 'idle';
      idle.current_job_id = null;
      this.inflightJobs.delete(job.job_id);
      queue.unshift(job);
    }
  }

  getIdleWorker() {
    for (const [instance_id, w] of this.workers) {
      if (w.status === 'idle') return { instance_id, gpu_model: w.gpu_model };
    }
    return null;
  }

  hasIdleWorker() { return !!this.getIdleWorker(); }
  hasAnyWorker() { return this.workers.size > 0; }

  _touchWorkerBySocket(ws, msg = {}) {
    // 辅助连接（用于补发 result/progress）也需要能匹配到 worker 条目
    if (ws._molink_auxiliary_worker && ws._molink_worker_instance_id) {
      const worker = this.workers.get(ws._molink_worker_instance_id);
      if (worker) {
        worker.last_hb = Date.now();
        return worker;
      }
    }

    const rawInstanceId = String(msg.instance_id || '').trim();
    const instanceId = rawInstanceId ? resolveWorkerInstanceId(rawInstanceId) : '';
    for (const [id, worker] of this.workers) {
      if (worker.ws !== ws && (!instanceId || id !== instanceId)) continue;
      worker.last_hb = Date.now();
      return worker;
    }
    return null;
  }

  _sendKeepalivePings() {
    const payload = JSON.stringify({ type: 'ping', server_ts: Date.now() });
    const now = Date.now();
    for (const [id, worker] of this.workers) {
      const ws = worker.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      const lastProtocolPongAt = Number(ws._molink_last_protocol_pong_at || worker.last_hb || now);
      if (now - lastProtocolPongAt > KEEPALIVE_PONG_TIMEOUT_MS) {
        this._recordWsEvent('keepalive_pong_timeout', {
          instance_id: id,
          job_id: worker.current_job_id || null,
          elapsed_ms: now - lastProtocolPongAt,
          timeout_ms: KEEPALIVE_PONG_TIMEOUT_MS
        });
        if (worker.current_job_id) {
          this._scheduleRequeueByJobId(worker.current_job_id, 'keepalive_pong_timeout', { instance_id: id });
        }
        try { ws.terminate(); } catch (error) {}
        continue;
      }
      try {
        // RFC WebSocket ping is answered by the Python protocol layer even
        // while the application receiver is busy.  Keep the JSON ping for
        // older workers and diagnostics, but do not depend on it for liveness.
        ws.ping();
        ws.send(payload);
      } catch (error) {
        this._recordWsEvent('keepalive_send_failed', {
          instance_id: id,
          job_id: worker.current_job_id || null,
          message: error.message
        });
        if (worker.current_job_id) {
          this._scheduleRequeueByJobId(worker.current_job_id, 'keepalive_send_failed', { instance_id: id });
        }
        try { ws.terminate(); } catch (e) {}
      }
    }
  }

  _recordWsEvent(type, details = {}) {
    const event = {
      at: new Date().toISOString(),
      type,
      ...details
    };

    this.wsEvents.push(event);

    if (this.wsEvents.length > 30) {
      this.wsEvents.splice(0, this.wsEvents.length - 30);
    }

    console.log(`[hub/ws] ${type} ${JSON.stringify(details)}`);
  }

  wsDiagnostics() {
    return this.wsEvents.slice(-20);
  }

  workerSnapshot() {
    return [...this.workers.entries()].map(([instance_id, w]) => ({
      instance_id, gpu_model: w.gpu_model, resource: w.resource || {}, status: w.status,
      current_job_id: w.current_job_id, last_hb: w.last_hb,
      current_stage_snapshot: w.current_stage_snapshot || null,
      benchmark_snapshot: w.benchmark_snapshot || null
    }));
  }

  queueSnapshot() {
    return {
      production: this.jobQueue.length,
      benchmark: this.benchmarkQueue.length,
      inflight: this.inflightJobs.size
    };
  }

  _cancelPendingRequeue(jobId, reason = 'cancelled') {
    if (!jobId) return;
    const timer = this.pendingRequeueTimers.get(jobId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingRequeueTimers.delete(jobId);
    this._recordWsEvent('requeue_cancelled', { job_id: jobId, reason });
  }

  _scheduleRequeueByJobId(jobId, reason, details = {}) {
    if (!jobId) return;
    if (this._isJobTerminal(jobId)) {
      this._recordWsEvent('requeue_skip_terminal', { job_id: jobId, reason });
      return;
    }
    if (this.pendingRequeueTimers.has(jobId)) {
      this._recordWsEvent('requeue_already_pending', { job_id: jobId, reason });
      return;
    }

    this._recordWsEvent('requeue_scheduled', {
      job_id: jobId,
      reason,
      delay_ms: REQUEUE_DELAY_MS,
      ...details
    });

    const timer = setTimeout(() => {
      this.pendingRequeueTimers.delete(jobId);
      this._requeueByJobId(jobId, reason).catch(error => {
        console.error('[hub] delayed requeue failed:', error.message);
      });
    }, REQUEUE_DELAY_MS);
    if (timer.unref) timer.unref();
    this.pendingRequeueTimers.set(jobId, timer);
  }

  _isJobTerminal(jobId) {
    if (!this.db || !jobId) return false;
    try {
      const order = this.db.prepare(`
        SELECT status, hanging_status, ai_result_urls, delivery_result_records_json
        FROM orders
        WHERE hanging_job_id = ?
      `).get(jobId);
      if (!order) return false;
      if (DELIVERED_ORDER_STATUSES.has(String(order.status || ''))) return true;
      if (TERMINAL_HANGING_STATUSES.has(String(order.hanging_status || ''))) return true;

      const aiUrls = String(order.ai_result_urls || '').trim();
      const deliveryRecords = String(order.delivery_result_records_json || '').trim();
      if (aiUrls && aiUrls !== '[]' && aiUrls !== 'null') return true;
      if (deliveryRecords && deliveryRecords !== '[]' && deliveryRecords !== 'null') return true;
    } catch (e) {}
    return false;
  }

  async _hasUploadedOutputsForOrder(order, jobId) {
    if (!order || !jobId) return false;
    try {
      const { hasObjectsWithPrefix } = this._getR2Client();
      if (typeof hasObjectsWithPrefix !== 'function') return false;
      const prefix = `orders/${order.id}/${jobId}/`;
      return await hasObjectsWithPrefix(prefix);
    } catch (error) {
      console.warn(`[hub] R2 prefix check skipped for ${jobId}: ${error.message}`);
      return false;
    }
  }

  async _recoverTerminalResultFromR2(order, jobId) {
    if (!order || !jobId || !this.resultProcessor) return false;
    const key = `orders/${order.id}/${jobId}/control/result_payload.json`;
    try {
      const { downloadObjectBufferByKey } = this._getR2Client();
      if (typeof downloadObjectBufferByKey !== 'function') return false;
      const body = await downloadObjectBufferByKey(key);
      const envelope = JSON.parse(body.toString('utf8'));
      const payload = envelope && typeof envelope === 'object' ? envelope.payload : null;
      if (!payload || typeof payload !== 'object') {
        throw new Error('R2 terminal result envelope has no payload');
      }
      const envelopeJobId = String(envelope.job_id || payload.job_id || '');
      const envelopeOrderId = String(envelope.order_id || payload.order_id || '');
      if (envelopeJobId !== String(jobId) || envelopeOrderId !== String(order.id)) {
        throw new Error(`R2 terminal result identity mismatch job=${envelopeJobId} order=${envelopeOrderId}`);
      }
      const resultId = String(envelope.result_id || payload.transport_result_id || `${jobId}:r2-recovery`);
      await this._processResultPayloadOnce(payload, resultId);
      this._scheduleResultProcessingCleanup(resultId);
      this.uploadedOutputGrace.delete(jobId);
      this._cancelPendingRequeue(jobId, 'r2_terminal_result_recovered');
      this._recordWsEvent('r2_terminal_result_recovered', {
        job_id: jobId,
        order_id: order.id,
        result_id: envelope.result_id || payload.transport_result_id || null,
        status: payload.status || null,
        key
      });
      return true;
    } catch (error) {
      const code = String(error?.name || error?.code || error?.Code || '');
      const statusCode = Number(error?.$metadata?.httpStatusCode || error?.statusCode || 0);
      if (code === 'NoSuchKey' || code === 'NotFound' || statusCode === 404) {
        return false;
      }
      console.warn(`[hub] R2 terminal result recovery failed for ${jobId}: ${error.message}`);
      return false;
    }
  }

  async _requeueByJobId(jobId, reason = 'unknown') {
    const inflight = this.inflightJobs.get(jobId);
    if (inflight && inflight.job_kind === 'benchmark_shard') {
      this.inflightJobs.delete(jobId);
      this.enqueueJob(inflight, { priority: 'benchmark' });
      console.log(`[hub] benchmark shard ${jobId} 已延迟回队 reason=${reason}`);
      return;
    }
    if (this.db && typeof this.buildBenchmarkJob === 'function') {
      try {
        const shard = this.db.prepare(
          "SELECT * FROM eval_run_shards WHERE job_id = ? AND state IN ('queued','running')"
        ).get(jobId);
        if (shard) {
          this.enqueueJob(this.buildBenchmarkJob(shard), { priority: 'benchmark' });
          console.log(`[hub] benchmark shard ${jobId} 已从控制表回队 reason=${reason}`);
          return;
        }
      } catch (error) {
        console.warn(`[hub] benchmark shard lookup skipped for ${jobId}: ${error.message}`);
      }
    }
    if (!this.db) return;
    if (typeof this.buildJobFromOrder !== 'function') {
      console.warn(`[hub] _requeueByJobId(${jobId}): buildJobFromOrder 未注入，无法回队，请检查 server.js configure() 调用`);
      return;
    }
    try {
      if (this._isJobTerminal(jobId)) {
        console.log(`[hub] 在途作业 ${jobId} 已是终态，跳过回队`);
        return;
      }

      const order = this.db.prepare('SELECT * FROM orders WHERE hanging_job_id = ?').get(jobId);
      if (order) {
        if (await this._recoverTerminalResultFromR2(order, jobId)) {
          console.warn(`[hub] 在途作业 ${jobId} 已从 R2 控制结果恢复并完成处理`);
          return;
        }

        const hasUploadedOutputs = await this._hasUploadedOutputsForOrder(order, jobId);
        if (hasUploadedOutputs) {
          const firstSeenAt = this.uploadedOutputGrace.get(jobId) || Date.now();
          this.uploadedOutputGrace.set(jobId, firstSeenAt);
          const elapsed = Date.now() - firstSeenAt;
          this.db.prepare(`UPDATE orders SET
              ai_current_step = '效果图已上传，正在等待 GPU 回传最终结果…',
              ai_progress_pct = CASE WHEN COALESCE(ai_progress_pct, 0) < 95 THEN 95 ELSE ai_progress_pct END
            WHERE id = ?
          `).run(order.id);
          if (elapsed < R2_RESULT_GRACE_MS) {
            console.warn(`[hub] 在途作业 ${jobId} 已发现 R2 输出但控制结果未到，等待恢复 elapsed=${elapsed}ms grace=${R2_RESULT_GRACE_MS}ms`);
            this._recordWsEvent('r2_output_waiting_for_terminal_result', {
              job_id: jobId,
              order_id: order.id,
              elapsed_ms: elapsed,
              grace_ms: R2_RESULT_GRACE_MS
            });
            if (!this.pendingRequeueTimers.has(jobId)) {
              const retryTimer = setTimeout(() => {
                this.pendingRequeueTimers.delete(jobId);
                this._requeueByJobId(jobId, 'r2_terminal_result_recheck').catch(error => {
                  console.error('[hub] R2 terminal result recheck failed:', error.message);
                });
              }, R2_RESULT_RECHECK_MS);
              retryTimer.unref?.();
              this.pendingRequeueTimers.set(jobId, retryTimer);
            }
            return;
          }
          console.warn(`[hub] 在途作业 ${jobId} R2 输出存在但终态结果超过宽限期，允许安全回队`);
        }

        this.uploadedOutputGrace.delete(jobId);
        this.db.prepare("UPDATE orders SET status='hanging_queued' WHERE id=?").run(order.id);
        this.enqueueJob(this.buildJobFromOrder(order));
        console.log(`[hub] 在途作业 ${jobId} 已延迟回队 reason=${reason}`);
      }
    } catch (e) { console.error('[hub] requeue failed:', e.message); }
  }

  _sweepStaleWorkers() {
    const now = Date.now();
    for (const [id, w] of this.workers) {
      if (now - w.last_hb > HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[hub] worker ${id} 心跳超时（${Math.round((now - w.last_hb) / 1000)}s），移除并回队`);
        if (w.current_job_id) this._scheduleRequeueByJobId(w.current_job_id, 'heartbeat_timeout', { instance_id: id });
        try { w.ws.terminate(); } catch (e) {}
        this.workers.delete(id);
        this._syncWorkerRow(id, { status: 'disconnected', current_job_id: null });
      }
    }
  }

  _syncWorkerRow(instanceId, fields) {
    if (!this.db || !instanceId) return;
    try {
      const exists = this.db.prepare('SELECT instance_id FROM worker_connections WHERE instance_id=?').get(instanceId);
      if (!exists) {
        this.db.prepare(`INSERT INTO worker_connections (instance_id, gpu_model, status, current_job_id, last_heartbeat, registered_at)
          VALUES (?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`)
          .run(instanceId, fields.gpu_model || null, fields.status || 'disconnected', fields.current_job_id || null);
        return;
      }
      this.db.prepare(`UPDATE worker_connections SET
          gpu_model = COALESCE(?, gpu_model),
          status = ?,
          current_job_id = ?,
          last_heartbeat = datetime('now','localtime')
        WHERE instance_id = ?`)
        .run(fields.gpu_model || null, fields.status || 'disconnected', fields.current_job_id || null, instanceId);
    } catch (e) { /* worker_connections 表可选，缺失则忽略 */ }
  }
}

const workerHub = new WorkerHub();
module.exports = workerHub; // 单例
module.exports.WorkerHub = WorkerHub; // 测试与独立诊断使用
