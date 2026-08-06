const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { WorkerHub } = require('../../services/workerHub');

function fakeSocket() {
  return {
    readyState: WebSocket.OPEN,
    sent: [],
    pingCount: 0,
    terminateCount: 0,
    closeCount: 0,
    send(raw) { this.sent.push(JSON.parse(String(raw))); },
    ping() { this.pingCount += 1; },
    terminate() { this.terminateCount += 1; this.readyState = WebSocket.CLOSED; },
    close() { this.closeCount += 1; this.readyState = WebSocket.CLOSED; }
  };
}

test('duplicate terminal results share one processor call and each receive ACK', async () => {
  const hub = new WorkerHub();
  let calls = 0;
  hub.configure({
    resultProcessor: async payload => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal(payload.job_id, 'job-ack');
    }
  });
  const ws1 = fakeSocket();
  const ws2 = fakeSocket();
  const payload = { job_id: 'job-ack', order_id: 'order-ack', status: 'succeeded' };
  const msg = { type: 'result', result_id: 'job-ack:stable', job_id: 'job-ack', payload };

  await Promise.all([
    hub._processResultAndAck(ws1, msg, payload),
    hub._processResultAndAck(ws2, msg, payload)
  ]);

  assert.equal(calls, 1);
  assert.equal(ws1.sent.at(-1).type, 'result_ack');
  assert.equal(ws1.sent.at(-1).accepted, true);
  assert.equal(ws2.sent.at(-1).accepted, true);
  for (const timer of hub.resultCleanupTimers.values()) clearTimeout(timer);
});

test('in-flight primary reconnect replaces stale socket without becoming idle', () => {
  const hub = new WorkerHub();
  const oldWs = fakeSocket();
  const newWs = fakeSocket();
  hub.workers.set('pro-1', {
    ws: oldWs,
    gpu_model: 'TITAN Xp',
    status: 'busy',
    current_job_id: 'job-inflight',
    last_hb: Date.now(),
    current_stage_snapshot: { stage: 'styling' }
  });
  const pending = setTimeout(() => {}, 60_000);
  pending.unref?.();
  hub.pendingRequeueTimers.set('job-inflight', pending);

  hub._handle(newWs, {
    type: 'register',
    instance_id: 'pro-1',
    gpu_model: 'TITAN Xp',
    status: 'busy',
    current_job_id: 'job-inflight',
    resume_inflight_job: true,
    connection_role: 'primary'
  });

  const current = hub.workers.get('pro-1');
  assert.equal(current.ws, newWs);
  assert.equal(current.status, 'busy');
  assert.equal(current.current_job_id, 'job-inflight');
  assert.equal(oldWs.closeCount, 1);
  assert.equal(hub.pendingRequeueTimers.has('job-inflight'), false);
});

test('R2 terminal recovery and websocket resend are deduplicated by result_id', async () => {
  const hub = new WorkerHub();
  let calls = 0;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const payload = { job_id: 'job-r2', order_id: 'order-r2', status: 'succeeded' };
  const envelope = {
    schema_version: 1,
    result_id: 'job-r2:stable',
    job_id: 'job-r2',
    order_id: 'order-r2',
    status: 'succeeded',
    payload
  };
  hub.configure({
    resultProcessor: async () => {
      calls += 1;
      await wait;
    },
    r2Client: {
      downloadObjectBufferByKey: async key => {
        assert.equal(key, 'orders/order-r2/job-r2/control/result_payload.json');
        return Buffer.from(JSON.stringify(envelope));
      }
    }
  });
  const ws = fakeSocket();

  const recovered = hub._recoverTerminalResultFromR2({ id: 'order-r2' }, 'job-r2');
  const resent = hub._processResultAndAck(ws, {
    type: 'result',
    result_id: 'job-r2:stable',
    job_id: 'job-r2',
    payload
  }, payload);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();

  assert.equal(await recovered, true);
  await resent;
  assert.equal(calls, 1);
  assert.equal(ws.sent.at(-1).accepted, true);
  for (const timer of hub.resultCleanupTimers.values()) clearTimeout(timer);
});

test('healthy server keepalive sends RFC ping plus legacy JSON ping', () => {
  const hub = new WorkerHub();
  const ws = fakeSocket();
  ws._molink_last_protocol_pong_at = Date.now();
  hub.workers.set('pro-keepalive', {
    ws,
    gpu_model: 'TITAN Xp',
    status: 'busy',
    current_job_id: 'job-keepalive',
    last_hb: Date.now()
  });

  hub._sendKeepalivePings();

  assert.equal(ws.pingCount, 1);
  assert.equal(ws.sent.at(-1).type, 'ping');
  assert.equal(ws.terminateCount, 0);
});
