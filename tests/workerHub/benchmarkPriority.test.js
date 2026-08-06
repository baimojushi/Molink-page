const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { WorkerHub } = require('../../services/workerHub');

function workerSocket() {
  return {
    readyState: WebSocket.OPEN,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(String(raw))); }
  };
}

test('production queue is always dispatched before benchmark queue', () => {
  const hub = new WorkerHub();
  hub.enqueueJob({ job_id: 'benchmark-1', job_kind: 'benchmark_shard' }, { priority: 'benchmark' });
  hub.enqueueJob({ job_id: 'production-1', job_kind: 'hang_in_home' });
  const ws = workerSocket();
  hub.workers.set('gpu-1', {
    ws,
    gpu_model: 'TITAN Xp',
    status: 'idle',
    current_job_id: null,
    resource: { services: ['benchmark'] }
  });

  hub.tryDispatch();
  assert.equal(ws.sent[0].job_id, 'production-1');
  assert.deepEqual(hub.queueSnapshot(), { production: 0, benchmark: 1, inflight: 1 });

  hub.inflightJobs.delete('production-1');
  hub.workers.get('gpu-1').status = 'idle';
  hub.workers.get('gpu-1').current_job_id = null;
  hub.tryDispatch();
  assert.equal(ws.sent[1].job_id, 'benchmark-1');
});

test('benchmark result is routed to its handler without entering order processor', async () => {
  const hub = new WorkerHub();
  let benchmarkMessage;
  let orderCalls = 0;
  hub.configure({
    benchmarkHandler: async message => { benchmarkMessage = message; },
    resultProcessor: async () => { orderCalls += 1; }
  });
  hub._handle(workerSocket(), { type: 'benchmark_result', job_id: 'benchmark-2', status: 'completed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(benchmarkMessage.job_id, 'benchmark-2');
  assert.equal(orderCalls, 0);
});
