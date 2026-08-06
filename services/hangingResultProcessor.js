// services/hangingResultProcessor.js —— 处理 worker result 消息
//
// 收到 worker 的 result 后：
//  1. 落 hanging_* 细化字段；
//  2. 映射到既有 ai_result_* / delivery 字段，复用既有交付页与邮件链路；
//  3. 推进订单状态机；
//  4. succeeded 时直接交付并发邮件（与 MMW 链路一致的用户体验）。
//
// 幂等：同一 job_id 的 result 重复到达时，已是终态则跳过二次交付与重复邮件。

const db = require('../database');
const { 发送交付通知到用户邮箱 } = require('./email');
const { recordOrderEvent } = require('./analytics');
const { buildFallbackText } = require('./hangingLlm');
const { downloadFile } = require('./aiImage');
const { addArtworkAssets } = require('./artworks');
const { ensureMiniappCodeForArtwork } = require('./miniappCodes');
const { isSuccessfulPrimaryStyling, buildSupplementDeliveryUpdate } = require('./hangingSupplementResult');

const DELIVERED_STATUSES = ['delivered', 'viewed', 'downloaded'];
const PRIMARY_RERENDER_PENDING_COPY = '正在为主图优化色彩，稍后自动更新';

const STATUS_MAP = {
  succeeded: 'hanging_ready',
  succeeded_partial: 'hanging_partial_review',
  render_review: 'hanging_partial_review',
  no_safe_wall: 'hanging_no_safe_wall',
  failed: 'hanging_failed'
};

function wallPositionZh(candidate) {
  const comp = candidate.composition_context || {};
  if (comp.above_furniture_label_zh && comp.above_furniture_label_zh !== '未知支撑') {
    return `${comp.above_furniture_label_zh}`;
  }
  return candidate.wall_position_zh || '主墙面';
}

// 把 worker 候选规整为业务端候选记录（绑定终图 + 安装 + 风险 + 原因）
// image_url 与 final_image_url 并列写入，确保 enrichDeliveryResultRecords
// 的 pickRecordUrl 能直接命中，不触发 localDeliveryUrl 降级路径。
function normalizeCandidates(candidates) {
  return (candidates || []).map(c => ({
    rank: c.rank,
    wall_id: c.wall_id,
    candidate_id: c.candidate_id || null,
    asset_id: c.asset_id || null,
    wall_position_zh: wallPositionZh(c),
    score: c.score,
    risk_level: c.risk_level,
    reason_tags: c.reason_tags || [],
    install: c.install || {},
    composition_context: c.composition_context || {},
    cleanup_info: c.cleanup_info || {},
    structural_clearance: c.structural_clearance || {},
    geometry_confidence: c.geometry_confidence || {},
    soft_risk_info: c.soft_risk_info || null,
    needs_review: !!c.needs_review,
    final_image_url: c.final_image_url || null,
    pre_styling_image_url: c.pre_styling_image_url || null,
    styling_status: c.styling_status || 'not_requested',
    styling_zone_source: c.styling_zone_source || null,
    styling_qa: c.styling_qa || null,
    final_image_source: c.final_image_source || null,
    promoted_partial_review: !!c.promoted_partial_review,
    partial_review_image: c.partial_review_image || null,
    // image_url / r2_url 别名：供 enrichDeliveryResultRecords.pickRecordUrl 直接命中
    image_url: c.final_image_url || null,
    r2_url: c.final_image_url || null,
    permanent_url: c.final_image_url || null,
    qa: c.qa || null,
    light_components: c.light_components || null,
    light_risk_band: c.light_risk_band || null,
    light_penalty_band: c.light_penalty_band || null,
    light_semantics: c.light_semantics || null,
    light_facts: c.light_facts || null,
    artwork_analysis: c.artwork_analysis || null
  }));
}

function parseRecords(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function isCurrentPrimaryWallRerender(order, payload) {
  if (!payload || payload.primary_wall_rerender !== true) return false;
  const incomingJobId = String(payload.job_id || '');
  const currentJobId = String(order && order.primary_wall_rerender_job_id || '');
  return Boolean(incomingJobId && currentJobId && incomingJobId === currentJobId);
}

function settlePrimaryWallRerender(order, payload, status, mergedRecords) {
  if (!isCurrentPrimaryWallRerender(order, payload)) return false;
  const serializedRecords = Array.isArray(mergedRecords) ? JSON.stringify(mergedRecords) : null;
  const result = serializedRecords === null
    ? db.prepare(`
        UPDATE orders
        SET primary_wall_rerender_status = ?,
            ai_current_step = CASE WHEN ai_current_step = ? THEN '' ELSE ai_current_step END
        WHERE id = ? AND primary_wall_rerender_job_id = ?
      `).run(status, PRIMARY_RERENDER_PENDING_COPY, order.id, payload.job_id)
    : db.prepare(`
        UPDATE orders
        SET delivery_result_records_json = ?,
            primary_wall_rerender_status = ?,
            ai_current_step = CASE WHEN ai_current_step = ? THEN '' ELSE ai_current_step END
        WHERE id = ? AND primary_wall_rerender_job_id = ?
      `).run(serializedRecords, status, PRIMARY_RERENDER_PENDING_COPY, order.id, payload.job_id);
  return result.changes > 0;
}

function settleWallPreferenceJob(payload, status, errorCode = '') {
  const jobId = String(payload && payload.job_id || '');
  if (!jobId) return;
  try {
    db.prepare(`
      UPDATE user_wall_preferences
      SET supplement_status = ?, supplement_error_code = ?
      WHERE supplement_job_id = ?
    `).run(status, String(errorCode || ''), jobId);
  } catch (error) {
    console.warn(`[hanging] preference status update failed job=${jobId}: ${error.message}`);
  }
}

function processSupplementResult(payload, order) {
  const incoming = normalizeCandidates(payload.candidates);
  const incomingStatus = String(payload.status || 'failed');
  const primaryWallRerender = payload.primary_wall_rerender === true;
  const primaryWallId = String(payload.primary_wall_id || '');
  if (primaryWallRerender && !isCurrentPrimaryWallRerender(order, payload)) {
    console.warn(`[hanging] ignored stale primary-wall rerender result job=${payload.job_id || ''} order=${order.id}`);
    return;
  }
  if (!['succeeded', 'succeeded_partial'].includes(incomingStatus) || incoming.length === 0) {
    if (primaryWallRerender) settlePrimaryWallRerender(order, payload, 'failed');
    settleWallPreferenceJob(payload, 'failed', payload.exit_code || payload.error || incomingStatus);
    recordOrderEvent({
      orderId: order.id, deviceUuid: order.device_uuid || null,
      eventType: 'hanging_supplement_result_received', pageName: 'gpu_worker',
      actorType: 'system', platform: 'gpu', serviceType: order.service_type || null,
      eventResult: 'failed',
      payload: { job_id: payload.job_id || null, status: incomingStatus, error: payload.error || null }
    });
    console.warn(`[hanging] supplement job ${payload.job_id || ''} failed for order ${order.id}; existing delivery preserved`);
    return;
  }

  const knownWallIds = new Set([
    ...parseRecords(order.delivery_result_records_json),
    ...parseRecords(order.hanging_candidate_records_json)
  ].map(item => String(item.wall_id || '')).filter(Boolean));
  const acceptedIncoming = incoming.filter(item => {
    const wallId = String(item.wall_id || '');
    if (!wallId || !knownWallIds.has(wallId) || !item.final_image_url) return false;
    if (primaryWallRerender && wallId !== primaryWallId) return false;
    return !(primaryWallRerender && wallId === primaryWallId && !isSuccessfulPrimaryStyling(item));
  });
  const skippedWallIds = incoming
    .map(item => String(item.wall_id || ''))
    .filter(wallId => wallId && !acceptedIncoming.some(item => String(item.wall_id || '') === wallId));
  if (acceptedIncoming.length === 0) {
    recordOrderEvent({
      orderId: order.id, deviceUuid: order.device_uuid || null,
      eventType: 'hanging_supplement_result_received', pageName: 'gpu_worker',
      actorType: 'system', platform: 'gpu', serviceType: order.service_type || null,
      eventResult: 'fallback_preserved',
      payload: { job_id: payload.job_id || null, skipped_wall_ids: skippedWallIds }
    });
    if (primaryWallRerender) settlePrimaryWallRerender(order, payload, 'failed');
    settleWallPreferenceJob(payload, 'failed', payload.exit_code || 'NO_SAFE_SUPPLEMENT_RESULT');
    console.warn(`[hanging] supplement job ${payload.job_id || ''} produced no safe replacement for order ${order.id}`);
    return;
  }

  const merged = buildSupplementDeliveryUpdate(order, acceptedIncoming, primaryWallId, primaryWallRerender);
  db.prepare(`UPDATE orders SET
      delivery_images = ?,
      ai_result_urls = ?,
      ai_result_records_json = ?,
      delivery_result_records_json = ?,
      hanging_candidate_records_json = ?
    WHERE id = ?`)
    .run(
      JSON.stringify(merged.deliveryImages),
      JSON.stringify(merged.aiResultUrls),
      JSON.stringify(merged.aiResultRecords),
      JSON.stringify(merged.deliveryRecords),
      JSON.stringify(merged.candidateRecords),
      order.id
    );
  if (primaryWallRerender) {
    settlePrimaryWallRerender(
      Object.assign({}, order, { delivery_result_records_json: JSON.stringify(merged.deliveryRecords) }),
      payload,
      'succeeded',
      merged.deliveryRecords
    );
  }
  settleWallPreferenceJob(payload, 'succeeded');

  recordOrderEvent({
    orderId: order.id, deviceUuid: order.device_uuid || null,
    eventType: 'hanging_supplement_result_received', pageName: 'gpu_worker',
    actorType: 'system', platform: 'gpu', serviceType: order.service_type || null,
    eventResult: 'success',
    payload: {
      job_id: payload.job_id || null,
      merged_wall_ids: acceptedIncoming.map(item => item.wall_id),
      skipped_wall_ids: skippedWallIds,
      primary_wall_rerender: primaryWallRerender,
      stage_a_base_source: payload.stage_a_base_source || null
    }
  });
  console.log(`[hanging] supplement job ${payload.job_id || ''} merged walls=${acceptedIncoming.map(item => item.wall_id).join(',')} into delivered order ${order.id}`);
}

async function processResult(payload) {
  if (!payload || !payload.order_id) return;
  const orderId = payload.order_id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    console.warn(`[hanging] result for unknown order ${orderId}`);
    return;
  }

  if (payload.supplement === true || payload.job_kind === 'hanging_supplement_render') {
    processSupplementResult(payload, order);
    return;
  }

  // 幂等：已交付终态不再二次处理
  // 但允许成功结果（succeeded/succeeded_partial）覆盖之前的失败状态，
  // 因为 worker 可能在 progress 发送失败后重连补发真正结果。
  const deliverableStatuses = ['succeeded', 'succeeded_partial'];
  const incomingIsSuccess = deliverableStatuses.includes(payload.status || 'failed');
  const previousWasFailure = order.hanging_status === 'hanging_failed' || order.hanging_status === 'failed';

  // 已交付订单（用户已看到结果）绝不重新处理
  if (DELIVERED_STATUSES.includes(order.status)) {
    console.log(`[hanging] order ${orderId} 已交付，幂等跳过`);
    return;
  }

  // 非交付的失败订单：允许成功结果覆盖
  if (previousWasFailure && incomingIsSuccess) {
    console.log(`[hanging] order ${orderId} 之前为失败状态(${order.hanging_status})，` +
                `现收到成功结果(${payload.status})，覆盖处理`);
  }

  const status = payload.status || 'failed';
  const mappedStatus = STATUS_MAP[status] || 'hanging_failed';
  const candidates = normalizeCandidates(payload.candidates);
  const notRecommended = payload.not_recommended || [];
  const partialImages = payload.partial_review_images || [];

  const narrationBundleJson = (() => {
    const bundle = payload.narration_bundle;
    if (!bundle || typeof bundle !== 'object') return null;
    try { return JSON.stringify(bundle); } catch (_) { return null; }
  })();

  const resultUrls = candidates.map(c => c.final_image_url).filter(Boolean);
  // succeeded_partial 现在可能表示：BFL QA 未产出 final_hd，但 worker 已把
  // 可交付 hardpaste preview 提升到 candidate.final_image_url。
  // 只要有 final_image_url，就应进入自动交付；否则小程序只会一直看到 pending。
  const canAutoDeliver = deliverableStatuses.includes(status) && resultUrls.length > 0;
  const iterRecords = partialImages.map(x => ({
    url: x.url, image_url: x.url,
    review_status: 'physics_failed', review_status_label: '渲染QA未通过',
    selected_by_default: false, source: 'hanging_partial'
  }));


  db.prepare(`UPDATE orders SET
      hanging_status = ?, hanging_exit_code = ?, hanging_failure_context_json = ?,
      hanging_plans_json = ?, hanging_not_recommended_json = ?,
      hanging_candidate_records_json = ?,
      hanging_narration_bundle_json = COALESCE(?, hanging_narration_bundle_json),
      hanging_provider = ?,
      hanging_result_zip_url = COALESCE(?, hanging_result_zip_url),
      hanging_result_zip_key = COALESCE(?, hanging_result_zip_key),
      hanging_ready_at = datetime('now','localtime')
    WHERE id = ?`)
    .run(
      status, payload.exit_code || null,
      payload.failure_context && typeof payload.failure_context === 'object' ? JSON.stringify(payload.failure_context) : null,
      JSON.stringify(candidates),
      JSON.stringify(notRecommended),
      JSON.stringify(candidates),
      narrationBundleJson,
      (
        payload.metrics && (
          payload.metrics.actual_render_provider
          || payload.metrics.render_provider
          || payload.metrics.requested_render_provider
        )
      ) || payload.render_provider || 'apiyi_gpt_image2_vip',
      payload.hanging_artifact_url || payload.hanging_result_zip_url || null,
      payload.hanging_artifact_key || payload.hanging_result_zip_key || null,
      orderId
    );

  recordOrderEvent({
    orderId, deviceUuid: order.device_uuid || null,
    eventType: 'hanging_result_received', pageName: 'gpu_worker',
    actorType: 'system', platform: 'gpu', serviceType: order.service_type || null,
    eventResult: canAutoDeliver ? 'success' : 'partial',
    payload: { exit_code: payload.exit_code, status, candidate_count: candidates.length, final_url_count: resultUrls.length }
  });

  if (canAutoDeliver) {
    // 自动交付：复用既有交付页 + 邮件链路
    const deliveryText = buildFallbackText(order); // 顾问主文案由交付页 SSE 实时生成，这里存兜底
    db.prepare(`UPDATE orders SET
        status = 'delivered',
        delivery_images = ?, delivery_text = ?,
        ai_result_urls = ?, ai_result_records_json = ?,
        delivery_result_records_json = ?,
        ai_iteration_records_json = ?,
        ai_engine = 'hanging',
        delivered_at = datetime('now','localtime')
      WHERE id = ?`)
      .run(
        JSON.stringify(resultUrls), deliveryText,
        JSON.stringify(resultUrls), JSON.stringify(candidates),
        JSON.stringify(candidates),
        JSON.stringify(candidates.concat(iterRecords)),
        orderId
      );


    const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (fresh.entry_source === 'artwork_effect_generator' && fresh.artwork_id) {
      try {
        const buffer = await downloadFile(resultUrls[0]);
        await addArtworkAssets({
          artworkId: fresh.artwork_id,
          assetKind: 'effect',
          files: [{
            buffer,
            originalname: `${fresh.artwork_name || fresh.artwork_code || 'artwork'}-空间效果图.png`,
            mimetype: 'image/png',
            size: buffer.length
          }]
        });
        await ensureMiniappCodeForArtwork(fresh.artwork_id).catch(error => {
          console.warn('[artwork-effect] miniapp code generation skipped:', error.message);
        });
        db.prepare("UPDATE orders SET ai_current_step='已自动上传到作品资料' WHERE id=?").run(orderId);
        console.log(`[artwork-effect] artwork=${fresh.artwork_id} effect asset replaced from order=${orderId}`);
      } catch (error) {
        db.prepare("UPDATE orders SET status='failed', ai_current_step=? WHERE id=?")
          .run(`效果图上传作品资料失败：${error.message}`, orderId);
        console.error('[artwork-effect] attach failed:', error.message);
      }
      return;
    }
    const deliveryUrl = `https://www.molink.art/d/${fresh.delivery_token}`;
    try {
      await 发送交付通知到用户邮箱(fresh, deliveryUrl);
      db.prepare("UPDATE orders SET email_sent = 1 WHERE id = ?").run(orderId);
    } catch (e) {
      console.error('[hanging] 交付邮件失败:', e.message);
    }
    console.log(`[hanging] order ${orderId} 自动交付完成 status=${status} final_urls=${resultUrls.length} → ${deliveryUrl}`);
  } else {
    // partial / no_safe_wall / failed：进入人工或回退队列，记录迭代图供人工挑选
    db.prepare(`UPDATE orders SET status = ?, ai_iteration_records_json = ? WHERE id = ?`)
      .run(mappedStatus, JSON.stringify(iterRecords), orderId);
    console.log(`[hanging] order ${orderId} → ${mappedStatus}（exit=${payload.exit_code}），转人工/回退`);
  }
}

module.exports = {
  processResult,
  processSupplementResult,
  normalizeCandidates,
  isCurrentPrimaryWallRerender,
  settlePrimaryWallRerender,
  settleWallPreferenceJob
};
