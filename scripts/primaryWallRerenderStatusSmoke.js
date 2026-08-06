'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molink-primary-rerender-'));
process.env.DATA_DIR = tempDataDir;

const db = require('../database');
const { processSupplementResult } = require('../services/hangingResultProcessor');

const pendingCopy = '正在为主图优化色彩，稍后自动更新';
const originalUrl = 'https://example.test/original-styled.png';
const originalBaseUrl = 'https://example.test/original-stage-a.png';
const orderId = 'primary-rerender-smoke';

function readOrder() {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function resetPending(jobId, currentStep = pendingCopy) {
  db.prepare(`
    UPDATE orders
    SET primary_wall_rerender_status = 'pending',
        primary_wall_rerender_job_id = ?,
        ai_current_step = ?,
        delivery_result_records_json = ?
    WHERE id = ?
  `).run(jobId, currentStep, JSON.stringify([{
    wall_id: 'wall_main',
    final_image_url: originalUrl,
    pre_styling_image_url: originalBaseUrl,
    styling_status: 'succeeded'
  }]), orderId);
}

function payload(jobId, status, candidates) {
  return {
    job_id: jobId,
    order_id: orderId,
    job_kind: 'hanging_supplement_render',
    supplement: true,
    primary_wall_rerender: true,
    primary_wall_id: 'wall_main',
    status,
    candidates
  };
}

try {
  db.prepare(`
    INSERT INTO orders (
      id, service_type, service_type_label, receive_method, receive_target,
      status, delivered_at, delivery_result_records_json,
      primary_wall_rerender_status, primary_wall_rerender_job_id, ai_current_step
    ) VALUES (?, 'hang_in_home', '挂画效果', 'email', 'test@example.test',
      'delivered', '2026-07-18 10:00:00', ?, 'pending', 'job_failed', ?)
  `).run(orderId, JSON.stringify([{
    wall_id: 'wall_main',
    final_image_url: originalUrl,
    pre_styling_image_url: originalBaseUrl,
    styling_status: 'succeeded'
  }]), pendingCopy);

  processSupplementResult(payload('job_failed', 'failed', []), readOrder());
  let order = readOrder();
  assert.strictEqual(order.primary_wall_rerender_status, 'failed');
  assert.strictEqual(order.ai_current_step, '');
  assert.strictEqual(JSON.parse(order.delivery_result_records_json)[0].final_image_url, originalUrl);

  resetPending('job_qa_rejected');
  processSupplementResult(payload('job_qa_rejected', 'succeeded', [{
    wall_id: 'wall_main',
    final_image_url: 'https://example.test/plain-fallback.png',
    styling_status: 'qa_rejected_fallback_to_plain'
  }]), readOrder());
  order = readOrder();
  assert.strictEqual(order.primary_wall_rerender_status, 'failed');
  assert.strictEqual(JSON.parse(order.delivery_result_records_json)[0].final_image_url, originalUrl);

  resetPending('job_succeeded');
  processSupplementResult(payload('job_succeeded', 'succeeded', [{
    wall_id: 'wall_main',
    final_image_url: 'https://example.test/recolored-styled.png',
    pre_styling_image_url: 'https://example.test/reuploaded-stage-a.png',
    styling_status: 'succeeded'
  }]), readOrder());
  order = readOrder();
  const succeededRecord = JSON.parse(order.delivery_result_records_json)[0];
  assert.strictEqual(order.primary_wall_rerender_status, 'succeeded');
  assert.strictEqual(order.status, 'delivered');
  assert.strictEqual(order.delivered_at, '2026-07-18 10:00:00');
  assert.strictEqual(succeededRecord.final_image_url, 'https://example.test/recolored-styled.png');
  assert.strictEqual(succeededRecord.pre_styling_image_url, originalBaseUrl);

  resetPending('job_current');
  processSupplementResult(payload('job_stale', 'succeeded', [{
    wall_id: 'wall_main',
    final_image_url: 'https://example.test/stale.png',
    styling_status: 'succeeded'
  }]), readOrder());
  order = readOrder();
  assert.strictEqual(order.primary_wall_rerender_status, 'pending');
  assert.strictEqual(JSON.parse(order.delivery_result_records_json)[0].final_image_url, originalUrl);

  resetPending('job_unrelated_copy', '内容安全审核暂时异常，正在等待处理');
  processSupplementResult(payload('job_unrelated_copy', 'failed', []), readOrder());
  order = readOrder();
  assert.strictEqual(order.primary_wall_rerender_status, 'failed');
  assert.strictEqual(order.ai_current_step, '内容安全审核暂时异常，正在等待处理');

  const miniappSource = fs.readFileSync(path.join(__dirname, '../molink-miniapp-auction/pages/result/result.js'), 'utf8');
  assert.ok(miniappSource.includes("res.primary_wall_rerender_status"));
  assert.ok(!miniappSource.includes('terminalCopy'));
  assert.ok(!miniappSource.includes('primaryChanged'));

  const webSource = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(webSource.includes('开始主墙补渲染轮询'));
  assert.ok(webSource.includes("fetch('/api/client/wall-preferences'"));

  console.log('primary wall rerender status smoke: ok');
} finally {
  db.close();
  fs.rmSync(tempDataDir, { recursive: true, force: true });
}
