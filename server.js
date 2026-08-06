// server.js —— Mo:link Design 主服务器
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { 启动定时清理 } = require('./services/cleanup');
const { submitImageRequest, checkExecution, downloadFile } = require('./services/aiImage');
const { reviewPhysics, reviewDimensions, reviewArtworkConsistency } = require('./services/qwen');
const { safeJsonParse, buildAiResultRecord, toAbsoluteFileUrl } = require('./services/recommendWork');
const { appendIterationRecord, buildIterationRecord } = require('./services/aiReviewIterations');

const app = express();
const PORT = process.env.PORT || 3000;

// 微信内容安全回调必须在全局 JSON/urlencoded 解析器之前接收原始请求体。
// 同时保留三个等价入口，避免微信后台配置路径与应用路由前缀不一致。
const clientRoutes = require('./routes/client');
const wxMediaCallbackPaths = [
  '/api/client/wx-media-check-callback',
  '/api/wx-media-check-callback',
  '/wx-media-check-callback'
];
app.get(wxMediaCallbackPaths, clientRoutes.wxMediaCheckVerifyHandler);
app.post(
  wxMediaCallbackPaths,
  express.raw({ type: '*/*', limit: '2mb' }),
  clientRoutes.wxMediaCheckRawHandler
);

// ==========================================
// 中间件配置
// ==========================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const proBootBeacon = require('./services/proBootBeacon');

app.post('/api/gpu/pro-boot-beacon', (req, res) => {
  const result = proBootBeacon.record(req.body, req);

  if (result.accepted) {
    console.log(
      `[pro-beacon] instance=${result.item.instance_id} ` +
      `stage=${result.item.stage} peer=${result.item.peer}`
    );
  }

  res.status(204).end();
});

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 持久化数据根目录（Railway 上挂载 Volume 到此路径）
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');
const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');

app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/deliveries', express.static(DELIVERIES_DIR));

// 确保上传和交付目录存在
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DELIVERIES_DIR, { recursive: true });

// ==========================================
// 路由挂载
// ==========================================
const adminRoutes = require('./routes/admin');
const deliveryRoutes = require('./routes/delivery');
const hangingLlmRoutes = require('./routes/hangingLlm');

app.use('/api/client', clientRoutes);
app.use('/api/admin', adminRoutes);
app.use('/d', deliveryRoutes);
app.use('/api/hanging', hangingLlmRoutes);

// 隐私政策页面
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// 用户协议页面
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// 用户端首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 管理后台页面（需要密钥访问）
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-analytics.html'));
});

app.get('/admin/llm-debug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-llm-debug.html'));
});

// ==========================================
// 启动服务器（HTTP server 同时承载 Express 与 WebSocket Hub）
// ==========================================
const http = require('http');
const httpServer = http.createServer(app);

const workerHub = require('./services/workerHub');
const { processResult } = require('./services/hangingResultProcessor');
const { buildJobFromOrder } = require('./services/hangingJob');
const { normalizeProgressMessage } = require('./services/hangingProgressCopy');
const etaService = require('./services/eta');
const evalRunService = require('./routes/adminEval').evalRunService;

// 配置 hub：注入 db、结果处理器、进度处理器、回队所需的作业构建器
workerHub.configure({
  db: require('./database'),
  buildJobFromOrder,
  buildBenchmarkJob: shard => evalRunService.buildShardJob(shard),
  benchmarkHandler: msg => evalRunService.handleBenchmarkResult(msg),
  resultProcessor: async (payload) => {
    await processResult(payload);
    try { etaService.onJobResult(payload, Date.now()); } catch (error) {
      console.error('[eta] result settle failed:', error.message);
    }
  },
  heartbeatHandler: (msg) => {
    try { etaService.ingestHeartbeat(msg, Date.now()); } catch (error) {
      console.error('[eta] heartbeat ingest failed:', error.message);
    }
  },
  jobEnqueuedHandler: (job) => {
    try { etaService.onJobEnqueued(job, Date.now()); } catch (error) {
      console.error('[eta] enqueue ingest failed:', error.message);
    }
  },
  progressHandler: (msg) => {
    try {
      const db = require('./database');

      const progress = normalizeProgressMessage(msg || {});
      const orderId = progress.orderId || '';
      const jobId = progress.jobId || '';
      const pctValue = progress.pct === null ? null : progress.pct;
      const advisorValue = progress.advisorText || '';

      const narrationBundleValue = (() => {
        const bundle = (msg && typeof msg === 'object') ? msg.narration_bundle : null;
        if (!bundle || typeof bundle !== 'object') return '';
        try { return JSON.stringify(bundle); } catch (_) { return ''; }
      })();

      console.log('[hanging-progress:resolve]', JSON.stringify({
        order_id: orderId,
        job_id: jobId,
        stage: progress.stage || '',
        state: progress.stageState || '',
        pct: pctValue,
        text_len: String(progress.text || '').length,
        text_preview: String(progress.text || '').slice(0, 100),
        advisor_len: advisorValue.length,
        advisor_preview: advisorValue.slice(0, 100),
        narration_bundle_len: narrationBundleValue.length
      }));

      let changes = 0;
      const updateSql = `
        UPDATE orders
        SET ai_current_step = ?,
            ai_progress_pct = COALESCE(?, ai_progress_pct),
            ai_advisor_progress = CASE WHEN ? <> '' THEN ? ELSE ai_advisor_progress END,
            hanging_narration_bundle_json = CASE
              WHEN ? <> '' AND (ai_progress_pct IS NULL OR ? >= ai_progress_pct) THEN ?
              ELSE hanging_narration_bundle_json
            END
        WHERE id = ?
      `;
      const updateByJobSql = `
        UPDATE orders
        SET ai_current_step = ?,
            ai_progress_pct = COALESCE(?, ai_progress_pct),
            ai_advisor_progress = CASE WHEN ? <> '' THEN ? ELSE ai_advisor_progress END,
            hanging_narration_bundle_json = CASE
              WHEN ? <> '' AND (ai_progress_pct IS NULL OR ? >= ai_progress_pct) THEN ?
              ELSE hanging_narration_bundle_json
            END
        WHERE hanging_job_id = ?
      `;

      if (orderId) {
        const r = db.prepare(updateSql).run(
          progress.text,
          pctValue,
          advisorValue,
          advisorValue,
          narrationBundleValue,
          pctValue,
          narrationBundleValue,
          orderId
        );
        changes += r.changes || 0;
        console.log('[hanging-progress:db-update-order]', JSON.stringify({
          order_id: orderId,
          changes: r.changes || 0,
          progress_pct: pctValue,
          advisor_len: advisorValue.length
        }));
      }

      if (!changes && jobId) {
        const r = db.prepare(updateByJobSql).run(
          progress.text,
          pctValue,
          advisorValue,
          advisorValue,
          narrationBundleValue,
          pctValue,
          narrationBundleValue,
          jobId
        );
        changes += r.changes || 0;
        console.log('[hanging-progress:db-update-job]', JSON.stringify({
          job_id: jobId,
          changes: r.changes || 0,
          progress_pct: pctValue,
          advisor_len: advisorValue.length
        }));
      }

      const row = orderId
        ? db.prepare(`
            SELECT id, status, hanging_job_id, ai_current_step, ai_progress_pct, ai_advisor_progress, hanging_narration_bundle_json
            FROM orders
            WHERE id = ?
          `).get(orderId)
        : db.prepare(`
            SELECT id, status, hanging_job_id, ai_current_step, ai_progress_pct, ai_advisor_progress, hanging_narration_bundle_json
            FROM orders
            WHERE hanging_job_id = ?
          `).get(jobId);

      console.log('[hanging-progress:db-readback]', JSON.stringify({
        found: Boolean(row),
        order_id: row && row.id,
        status: row && row.status,
        hanging_job_id: row && row.hanging_job_id,
        progress_pct: row && row.ai_progress_pct,
        advisor_len: row ? String(row.ai_advisor_progress || '').length : 0,
        step_len: row ? String(row.ai_current_step || '').length : 0,
        step_preview: row ? String(row.ai_current_step || '').slice(0, 100) : ''
      }));
    } catch (e) {
      console.error('[hanging-progress:error]', e && e.stack ? e.stack : e.message);
    }

    if (etaService.config.enabled) {
      Promise.resolve()
        .then(() => etaService.ingestProgress(msg, Date.now()))
        .catch(error => console.error('[eta] progress ingest failed:', error.message));
    }
  }
});

workerHub.attach(httpServer);

httpServer.listen(PORT, () => {
  console.log(`✅ Mo:link Design 服务器已启动: http://localhost:${PORT}`);
  console.log(`📋 管理后台: http://localhost:${PORT}/admin`);

  // 启动图片清理任务（2天有效期）
  启动定时清理();

  // 启动 AI 生图结果轮询（每 30 秒检查一次，仅服务 MMW 引擎订单）
  启动AI轮询();

  // 恢复中断的挂画作业队列（Railway 重启后 WorkerHub 内存丢失的兜底）
  try {
    const db = require('./database');
    const queued = db.prepare("SELECT * FROM orders WHERE status = 'hanging_queued'").all();
    queued.forEach(o => workerHub.enqueueJob(buildJobFromOrder(o)));
    if (queued.length) console.log(`♻️ 已恢复 ${queued.length} 个 hanging_queued 作业入队`);
  } catch (e) {
    console.warn('恢复挂画队列失败:', e.message);
  }

  // benchmark shard 可安全重投；GPU 会按 R2 completed.json 逐项跳过。
  try {
    const restoredEvalShards = evalRunService.restoreQueuedRuns();
    if (restoredEvalShards) console.log(`♻️ 已恢复 ${restoredEvalShards} 个评测分片入队`);
  } catch (e) {
    console.warn('恢复评测队列失败:', e.message);
  }

  if (process.env.PRO_SMOKE_ON_SERVER_START === '1') {
    const delayMs = Number(process.env.PRO_SMOKE_START_DELAY_MS || 3000);
    console.log(`🧪 AutoDL Pro smoke 将在 ${delayMs}ms 后启动`);

    setTimeout(() => {
      const { runFromServer } = require('./scripts/proSmoke');
      runFromServer({
        workerHub,
        db: require('./database')
      }).catch(error => {
        console.error('🧪 AutoDL Pro smoke failed:', error.message);
        if (process.env.PRO_SMOKE_EXIT_ON_FAIL === '1') {
          process.exit(1);
        }
      });
    }, delayMs);
  }
});

// ==========================================
// AI 生图结果轮询（含 Qwen 自动审核）
// 每批次生成 EXECUTION_COUNT 张图，全部轮询，收集所有通过审核的效果图
// MAX_AI_RETRIES: 若整批全部未通过，重新提交的最大次数
// ==========================================
function 启动AI轮询() {
  if (process.env.DISABLE_AI_POLLING === '1') {
    console.log('⏸️ AI 轮询已被环境变量禁用（DISABLE_AI_POLLING=1）');
    return;
  }
  const db = require('./database');
  const { recordOrderEvent } = require('./services/analytics');
  const MAX_AI_RETRIES = parseInt(process.env.MAX_AI_RETRIES || '3');
  let isPolling = false;

  function getOrderArtworkImageUrl(order, planItem = null) {
    const value = planItem?.artwork_image_url || order.artwork_image || '';
    if (!value) return '';
    return toAbsoluteFileUrl(value);
  }

  function buildDimensionFixMessage({ failedImageUrl, targetArtworkSize, review, artworkImageUrl }) {
    const qwenReason = String(review?.reason || '').trim();
    const action = String(review?.correctionAction || '').trim();
    const amount = String(review?.correctionAmount || '').trim();
    const instruction = String(review?.dimensionFixInstruction || '').trim();
    const actionText = action === 'shrink'
      ? '缩小'
      : (action === 'enlarge' ? '放大' : '调整');

    const parts = [
      { file_url: failedImageUrl }
    ];
    if (artworkImageUrl) {
      parts.push({ file_url: artworkImageUrl });
    }
    parts.push({
      text: `第一张图是上一轮 Qwen 尺寸审核未通过的室内效果图，请以第一张图为基础做局部图像编辑，不要重新设计空间。${artworkImageUrl ? '第二张图是原始作品参考，请保持画作内容与第二张图一致。' : ''}

目标作品尺寸信息：${targetArtworkSize}
Qwen 尺寸审核意见：${qwenReason || '图中作品尺寸与目标尺寸不符'}
Qwen 建议动作：${actionText}${amount ? `（${amount}）` : ''}
具体修改指令：${instruction || `请${actionText}第一张图中墙面上的作品，使其视觉尺寸严格符合「${targetArtworkSize}」。`}

严格要求：
1. 只调整墙上作品/画框的尺寸和必要的位置，使其符合目标尺寸；
2. 不要改变房间结构、家具、墙面、灯光、镜头视角和整体构图；
3. 不要替换画作内容，不要新增或删除家具、摆件、窗户、门、灯具；
4. 输出一张修正后的完整室内效果图。`
    });
    return parts;
  }

  // 单张图片的 Qwen 审核（画作一致性 → 物理合理性 → 尺寸），返回 { pass, reason }
  // execIndex/totalExecs: 当前是这批第几张（显示用）
  async function runQwenReview(order, imageUrl, execIndex, totalExecs, reviewContext = {}) {
    const tag = `图${execIndex}/${totalExecs}`;
    const artworkImageUrl = reviewContext.artworkImage
      ? toAbsoluteFileUrl(reviewContext.artworkImage)
      : (order.artwork_image ? (order.artwork_image.startsWith('http') ? order.artwork_image : `https://www.molink.art/uploads/${order.artwork_image}`) : null);
    const artworkSize = String(reviewContext.artworkSize || order.artwork_size || '').trim();

    if (artworkImageUrl) {
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?")
        .run(`${tag} ① 画作一致性审核（qwen-vl-plus）…`, order.id);
      const consistency = await reviewArtworkConsistency(imageUrl, artworkImageUrl);
      if (!consistency.pass) {
        db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?")
          .run(`${tag} ① ❌画作不一致：${consistency.reason || '效果图中画作与原作不符'}`, order.id);
        return { pass: false, reason: consistency.reason || '效果图中画作与原作不一致', reviewStage: 'artwork_consistency' };
      }
    }

    db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?")
      .run(`${tag} ${artworkImageUrl ? '✅画作一致 → ' : ''}② 物理合理性审核（qwen-vl-plus）…`, order.id);
    const physics = await reviewPhysics(imageUrl);
    if (!physics.pass) {
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?")
        .run(`${tag} ② ❌物理不通过：${physics.reason || '画面物理不合理'}`, order.id);
      return { pass: false, reason: physics.reason || '画面物理不合理', reviewStage: 'physics' };
    }

    if (artworkSize) {
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?")
        .run(`${tag} ✅画作✅物理 → ③ 尺寸比例终审（qwen-vl-max）…`, order.id);
      const dims = await reviewDimensions(imageUrl, artworkSize);
      if (!dims.pass) {
        db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?")
          .run(`${tag} ③ ❌尺寸不符：${dims.reason || '尺寸比例偏差过大'}`, order.id);
        return {
          pass: false,
          reason: dims.reason || '尺寸比例不符',
          isDimension: true,
          artworkSize,
          failedImageUrl: imageUrl,
          correctionAction: dims.correctionAction || '',
          correctionAmount: dims.correctionAmount || '',
          dimensionFixInstruction: dims.dimensionFixInstruction || '',
          rawText: dims.rawText || '',
          reviewStage: 'dimension'
        };
      }
    }

    return { pass: true };
  }

  setInterval(async () => {
    if (isPolling) {
      console.warn('⏭️ 上一轮 AI 轮询仍在执行，本轮跳过');
      return;
    }
    isPolling = true;
    let pending;
    try {
      pending = db.prepare(
        "SELECT id, device_uuid, service_type, artwork_id, artwork_code, ai_execution_id, ai_execution_ids, ai_result_urls, ai_result_records_json, ai_generation_plan_json, ai_retry_count, ai_user_message, artwork_size, artwork_image, ai_dim_fix_count, ai_total_ready_count, ai_first_ready_count, ai_iteration_records_json FROM orders WHERE status='ai_generating' AND COALESCE(ai_engine,'mmw') IN ('mmw','apiyi') AND (ai_execution_ids IS NOT NULL OR ai_execution_id IS NOT NULL)"
      ).all();
    } catch (e) {
      console.error('轮询查询出错:', e.message);
      isPolling = false;
      return;
    }

    try {
      for (const order of pending) {
        try {
        // 兼容旧订单（只有 ai_execution_id）和新订单（ai_execution_ids 数组）
        let pendingIds;
        try {
          pendingIds = order.ai_execution_ids
            ? JSON.parse(order.ai_execution_ids)
            : (order.ai_execution_id ? [order.ai_execution_id] : []);
        } catch { pendingIds = order.ai_execution_id ? [order.ai_execution_id] : []; }

        let resultUrls = [];
        try { resultUrls = JSON.parse(order.ai_result_urls || '[]'); } catch {}
        let resultRecords = safeJsonParse(order.ai_result_records_json, []);
        let generationPlan = safeJsonParse(order.ai_generation_plan_json, []);
        let iterationRecords = safeJsonParse(order.ai_iteration_records_json, []);

        if (pendingIds.length === 0) continue;

        const stillPending = [];

        // 并行查询所有 execution 状态
        const checkResults = await Promise.allSettled(
          pendingIds.map((execId, idx) =>
            checkExecution(execId).then(r => ({ execId, idx, ...r }))
          )
        );

        const completedWithImages = [];
        for (const cr of checkResults) {
          if (cr.status === 'rejected') {
            console.error(`查询状态出错 订单=${order.id.substring(0,8)}:`, cr.reason?.message);
            continue;
          }
          const { execId, idx, status, imageUrl, raw } = cr.value;
          console.log(`📊 轮询 订单=${order.id.substring(0,8)} [${idx+1}/${pendingIds.length}] exec=${execId.substring(0,8)} status=${status} 有图=${!!imageUrl}`);

          if (status === 'completed' || status === 'succeeded') {
            if (imageUrl) {
              completedWithImages.push({ execId, idx, imageUrl });
            } else {
              console.log(`⚠️ 完成但无图 订单=${order.id.substring(0,8)} exec=${execId.substring(0,8)}`);
              console.log(`📋 完整响应: ${JSON.stringify(raw).substring(0, 600)}`);
            }
          } else if (['failed', 'cancelled', 'interrupted'].includes(status)) {
            console.warn(`⚠️ execution 失败 status=${status} 订单=${order.id.substring(0,8)}`);
          } else {
            stillPending.push(execId);
          }
        }

        if (completedWithImages.length > 0) {
          let dimFixCount = order.ai_dim_fix_count || 0;
          for (const { execId, idx, imageUrl } of completedWithImages) {
            const planItem = generationPlan.find(item => item.exec_id === execId) || null;
            let review;
            try {
              review = await runQwenReview(order, imageUrl, idx + 1, pendingIds.length, {
                artworkSize: planItem?.artwork_size || order.artwork_size,
                artworkImage: planItem?.artwork_image_url || order.artwork_image
              });
            } catch (e) {
              console.error(`Qwen审核出错 订单=${order.id.substring(0,8)}:`, e.message);
              iterationRecords = appendIterationRecord(iterationRecords, buildIterationRecord({
                order,
                execId,
                imageUrl,
                planItem,
                batchIndex: idx + 1,
                totalInBatch: pendingIds.length,
                retryCount: order.ai_retry_count || 0,
                dimensionFixCount: dimFixCount,
                review: { pass: false, reason: e.message || 'Qwen 审核异常', reviewStage: 'review_error' },
                reviewStatus: 'review_error',
                selectedByDefault: false
              }));
              continue;
            }
            if (review.pass) {
              resultUrls.push(imageUrl);
              if (planItem) {
                resultRecords.push(buildAiResultRecord(imageUrl, planItem));
              }
              iterationRecords = appendIterationRecord(iterationRecords, buildIterationRecord({
                order, execId, imageUrl, review, planItem,
                batchIndex: idx + 1, totalInBatch: pendingIds.length,
                retryCount: order.ai_retry_count || 0, dimensionFixCount: dimFixCount,
                reviewStatus: 'pass', selectedByDefault: true
              }));
              console.log(`✅ 通过审核 订单=${order.id.substring(0,8)} 已通过=${resultUrls.length} 张`);
            } else if (review.isDimension && (planItem?.artwork_size || order.artwork_size)) {
              if (dimFixCount >= 3) {
                resultUrls.push(imageUrl);
                if (planItem) {
                  resultRecords.push(buildAiResultRecord(imageUrl, planItem));
                }
                iterationRecords = appendIterationRecord(iterationRecords, buildIterationRecord({
                  order, execId, imageUrl, review, planItem,
                  batchIndex: idx + 1, totalInBatch: pendingIds.length,
                  retryCount: order.ai_retry_count || 0, dimensionFixCount: dimFixCount,
                  reviewStatus: 'dimension_fix_limit', selectedByDefault: true
                }));
                console.log(`⛔ 尺寸修正已达3次上限，保留为人工审核候选 订单=${order.id.substring(0,8)}`);
              } else {
                iterationRecords = appendIterationRecord(iterationRecords, buildIterationRecord({
                  order, execId, imageUrl, review, planItem,
                  batchIndex: idx + 1, totalInBatch: pendingIds.length,
                  retryCount: order.ai_retry_count || 0, dimensionFixCount: dimFixCount,
                  reviewStatus: 'dimension_failed', selectedByDefault: false
                }));
                try {
                  const targetArtworkSize = planItem?.artwork_size || order.artwork_size;
                  const artworkImageUrl = getOrderArtworkImageUrl(order, planItem);
                  const fixMessage = buildDimensionFixMessage({
                    failedImageUrl: imageUrl, targetArtworkSize, review, artworkImageUrl
                  });
                  const fixIds = await submitImageRequest({ userMessage: fixMessage, executionCount: 1 });
                  stillPending.push(...fixIds);
                  if (planItem && fixIds[0]) {
                    generationPlan = generationPlan.map(item => item.exec_id === execId
                      ? { ...item, exec_id: fixIds[0], user_message: fixMessage,
                          dimension_fix: {
                            previous_exec_id: execId, previous_image_url: imageUrl,
                            qwen_reason: review.reason || '', qwen_action: review.correctionAction || '',
                            qwen_amount: review.correctionAmount || '',
                            qwen_instruction: review.dimensionFixInstruction || '',
                            qwen_raw_text: review.rawText || ''
                          }
                        }
                      : item);
                  }
                  dimFixCount++;
                  db.prepare("UPDATE orders SET ai_dim_fix_count=? WHERE id=?").run(dimFixCount, order.id);
                  console.log(`🔧 尺寸不符，按Qwen意见提交局部修正(第${dimFixCount}/3次) 订单=${order.id.substring(0,8)}`);
                } catch (e) {
                  console.error('尺寸修正请求失败:', e.message);
                }
              }
            } else {
              iterationRecords = appendIterationRecord(iterationRecords, buildIterationRecord({
                order, execId, imageUrl, review, planItem,
                batchIndex: idx + 1, totalInBatch: pendingIds.length,
                retryCount: order.ai_retry_count || 0, dimensionFixCount: dimFixCount,
                selectedByDefault: false
              }));
              console.log(`❌ 初审未通过（${review.reason}），保留为人工审核候选 订单=${order.id.substring(0,8)}`);
            }
          }
        }

        if (stillPending.length > 0) {
          db.prepare("UPDATE orders SET ai_execution_ids=?, ai_result_urls=?, ai_result_records_json=?, ai_generation_plan_json=?, ai_iteration_records_json=?, ai_current_step=? WHERE id=?")
            .run(
              JSON.stringify(stillPending),
              JSON.stringify(resultUrls),
              JSON.stringify(resultRecords),
              JSON.stringify(generationPlan),
              JSON.stringify(iterationRecords),
              `轮询中：${pendingIds.length - stillPending.length}/${pendingIds.length} 已完成，${resultUrls.length} 张通过`,
              order.id
            );
        } else {
          if (resultUrls.length > 0) {
            const previousTotalReadyCount = Number(order.ai_total_ready_count || 0);
            const batchKind = previousTotalReadyCount === 0 ? 'initial' : 'regenerated';
            db.prepare(`UPDATE orders SET
              status='ai_ready', ai_execution_ids='[]',
              ai_result_url=?, ai_result_urls=?, ai_result_records_json=?, ai_iteration_records_json=?,
              ai_ready_at=datetime('now','localtime'),
              ai_current_step=?,
              ai_first_ready_count = CASE WHEN COALESCE(ai_total_ready_count, 0) = 0 THEN ? ELSE ai_first_ready_count END,
              ai_total_ready_count = COALESCE(ai_total_ready_count, 0) + ?
              WHERE id=?`
            ).run(
              resultUrls[0],
              JSON.stringify(resultUrls),
              JSON.stringify(resultRecords),
              JSON.stringify(iterationRecords),
              `审核完成：${resultUrls.length} 张效果图待管理员确认`,
              resultUrls.length,
              resultUrls.length,
              order.id
            );
            recordOrderEvent({
              orderId: order.id, deviceUuid: order.device_uuid || null,
              eventType: 'ai_batch_ready', pageName: 'ai_polling',
              payload: { batch_kind: batchKind, image_count: resultUrls.length },
              actorType: 'system', platform: 'system',
              serviceType: order.service_type || null, eventResult: 'pass',
              artworkId: order.artwork_id || null, artworkCode: order.artwork_code || null
            });
            console.log(`✅ 批次完成 订单=${order.id.substring(0,8)} 通过=${resultUrls.length} 张`);
          } else {
            const retryCount = order.ai_retry_count || 0;
            if (retryCount < MAX_AI_RETRIES && (generationPlan.length > 0 || order.ai_user_message)) {
              let newIds = [];
              let nextGenerationPlan = [];
              if (generationPlan.length > 0) {
                for (const planItem of generationPlan) {
                  const ids = await submitImageRequest({ userMessage: planItem.user_message, executionCount: 1 });
                  const execId = ids[0];
                  newIds.push(execId);
                  nextGenerationPlan.push({ ...planItem, exec_id: execId });
                }
              } else {
                const userMessage = JSON.parse(order.ai_user_message);
                newIds = await submitImageRequest({ userMessage });
              }
              db.prepare(`UPDATE orders SET
                ai_execution_id=?, ai_execution_ids=?, ai_generation_plan_json=?,
                ai_result_url=NULL, ai_result_urls='[]', ai_result_records_json='[]', ai_iteration_records_json=?,
                ai_retry_count=?, ai_dim_fix_count=0, ai_current_step=?
                WHERE id=?`
              ).run(
                newIds[0], JSON.stringify(newIds),
                nextGenerationPlan.length ? JSON.stringify(nextGenerationPlan) : order.ai_generation_plan_json,
                JSON.stringify(iterationRecords),
                retryCount + 1,
                `第 ${retryCount + 1} 次重新生成（整批未通过审核）`,
                order.id
              );
              recordOrderEvent({
                orderId: order.id, deviceUuid: order.device_uuid || null,
                eventType: 'ai_retry_triggered', pageName: 'ai_polling',
                payload: { retry_count: retryCount + 1, image_count: newIds.length },
                actorType: 'system', platform: 'system',
                serviceType: order.service_type || null, eventResult: 'retry',
                artworkId: order.artwork_id || null, artworkCode: order.artwork_code || null
              });
              console.log(`🔄 整批未通过，重新生成（第 ${retryCount + 1} 次） 订单=${order.id.substring(0,8)}`);
            } else {
              const fallbackStatus = order.service_type === 'recommend_work' ? 'awaiting_manual_recommendation' : 'pending';
              const fallbackStep = order.service_type === 'recommend_work'
                ? 'AI多次生成均未通过审核，请重新确认推荐作品'
                : 'AI多次生成均未通过审核，请手动处理';
              db.prepare("UPDATE orders SET status=?, ai_current_step=?, ai_iteration_records_json=? WHERE id=?").run(fallbackStatus, fallbackStep, JSON.stringify(iterationRecords), order.id);
              recordOrderEvent({
                orderId: order.id, deviceUuid: order.device_uuid || null,
                eventType: 'ai_human_takeover', pageName: 'ai_polling',
                payload: { retry_count: retryCount, fallback_status: fallbackStatus },
                actorType: 'system', platform: 'system',
                serviceType: order.service_type || null, eventResult: 'pending',
                artworkId: order.artwork_id || null, artworkCode: order.artwork_code || null
              });
              console.warn(`⚠️ 已达最大重试次数，转人工处理 订单=${order.id.substring(0,8)}`);
            }
          }
        }

        } catch (e) {
          console.error(`轮询出错 订单=${order.id}:`, e.message);
        }
      }
    } finally {
      isPolling = false;
    }
  }, 10 * 1000);

  console.log('🔄 AI 轮询已启动（每 10 秒，全批次追踪，含 Qwen 自动审核）');
}

app.get('/admin/artworks', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin-artworks.html')); });
app.get('/admin/exhibitions', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin-exhibitions.html')); });
