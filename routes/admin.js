// routes/admin.js —— 目标机管理后台 API 路由
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { adminUpload, DELIVERIES_DIR } = require('../middleware/upload');
const { 发送交付通知到用户邮箱 } = require('../services/email');
const { 文字渲染为图片 } = require('../services/textToImage');
const { submitImageRequest, checkExecution, downloadFile } = require('../services/aiImage');
const { notifyCollector } = require('../services/wxNotify');
const { listArtworks, listArtworksLite, getArtworkById, createArtwork, updateArtwork, addArtworkAssets, deleteArtworkAsset, deleteArtwork, reorderAssets, setArtworkCover, assignMiniappScanPage } = require('../services/artworks');
const {
  EXHIBITION_STATUSES,
  listExhibitions,
  getExhibitionById,
  createExhibition,
  updateExhibition,
  deleteOrArchiveExhibition,
  resolveAdminExhibitionId
} = require('../services/exhibitions');
const { checkR2Connection, downloadObjectBufferByKey } = require('../services/r2');
const {
  uploadDeliveryImageToR2,
  enrichDeliveryResultRecords,
  resolveDeliveryImageUrls,
  isAbsoluteUrl,
  safeJsonArray,
  matchDeliveryRecord
} = require('../services/deliveryAssets');
const { getMiniappConfigState, ensureMiniappCodeForArtwork } = require('../services/miniappCodes');
const { recordOrderEvent } = require('../services/analytics');
const {
  safeJsonParse,
  toAbsoluteFileUrl,
  buildRecommendedArtworkSnapshot,
  buildRecommendWorkUserMessage,
  buildGenerationPlanItem
} = require('../services/recommendWork');
const { buildReviewCandidates } = require('../services/aiReviewIterations');
const { SLOT_DEFINITIONS, FIELD_CATALOG, ensureDefaultSlotConfigs, newId } = require('../services/llmSlots');
const workerHub = require('../services/workerHub');
const autodl = require('../services/autodl');
const { buildJobFromOrder } = require('../services/hangingJob');

// uploads 目录（用于删除订单时清理用户上传图片）
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');

// ==========================================
// "已交付"状态集合
// delivered → 刚交付；viewed → 用户已查收；downloaded → 用户已下载
// 三种状态都属于"已完成交付"，重新交付必须允许全部三种
// ==========================================

const DELIVERED_STATUSES = ['delivered', 'viewed', 'downloaded'];

function 安全文件名(value, fallback = '未命名作品') {
  return String(value || fallback)
    .trim()
    .replace(/[\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || fallback;
}

function 格式化时间标签(value) {
  if (!value) return 'undated';
  return String(value).replace(/[\s:]/g, '-').replace(/[^0-9-]/g, '').slice(0, 16) || 'undated';
}

function 构建交付图片文件名(order, index, originalName, usedNames) {
  const artworkName = 安全文件名(order.artwork_name || order.service_type_label || '未命名作品');
  const tag = [order.id ? order.id.slice(0, 8) : 'order', 格式化时间标签(order.delivered_at || order.created_at), `img${index + 1}`]
    .filter(Boolean)
    .join('_');
  const ext = path.extname(originalName || '').toLowerCase() || '.jpg';
  let base = `${artworkName}_${tag}`;
  let filename = `${base}${ext}`;
  let counter = 1;
  while (usedNames.has(filename)) {
    filename = `${base}_${counter}${ext}`;
    counter += 1;
  }
  usedNames.add(filename);
  return filename;
}

function 解析订单扩展字段(order) {
  if (!order) return order;
  order.recommended_artworks = safeJsonParse(order.recommended_artworks_json, []);
  order.ai_generation_plan = safeJsonParse(order.ai_generation_plan_json, []);
  order.ai_result_records = safeJsonParse(order.ai_result_records_json, []);
  order.ai_iteration_records = safeJsonParse(order.ai_iteration_records_json, []);
  order.ai_review_candidates = buildReviewCandidates(order);
  order.delivery_result_records = safeJsonParse(order.delivery_result_records_json, []);
  return order;
}

function 获取推荐作品快照列表(order) {
  return safeJsonParse(order?.recommended_artworks_json, []);
}

function 获取生成计划(order) {
  return safeJsonParse(order?.ai_generation_plan_json, []);
}

function 获取结果记录(order) {
  return safeJsonParse(order?.ai_result_records_json, []);
}

function 构建交付结果记录(filename, sourceRecord = {}, uploadInfo = null) {
  const localUrl = isAbsoluteUrl(filename) ? filename : `/deliveries/${filename}`;
  return {
    filename: isAbsoluteUrl(filename) ? path.basename(String(filename).split('?')[0]) : filename,
    image_url: uploadInfo && uploadInfo.url ? uploadInfo.url : localUrl,
    local_image_url: localUrl,
    r2_key: uploadInfo && uploadInfo.key ? uploadInfo.key : null,
    r2_url: uploadInfo && uploadInfo.url ? uploadInfo.url : null,
    artwork_id: sourceRecord.artwork_id || null,
    artwork_code: sourceRecord.artwork_code || null,
    artwork_name: sourceRecord.artwork_name || '',
    artwork_author: sourceRecord.artwork_author || ''
  };
}

function 构建订单默认交付记录来源(order = {}) {
  return {
    artwork_id: order.artwork_id || null,
    artwork_code: order.artwork_code || null,
    artwork_name: order.artwork_name || order.service_type_label || '',
    artwork_author: ''
  };
}

async function 上传交付图片到R2并生成记录(order, filename, sourceRecord = {}, index = 0) {
  const localPath = isAbsoluteUrl(filename) ? '' : path.join(DELIVERIES_DIR, filename);
  try {
    const uploaded = await uploadDeliveryImageToR2({ order, filename, localPath, sourceRecord, index });
    return 构建交付结果记录(filename, sourceRecord, uploaded);
  } catch (error) {
    console.warn('⚠️ 交付图片上传 R2 失败，保留本地回退:', filename, error.message || error);
    return 构建交付结果记录(filename, sourceRecord, null);
  }
}

// ==========================================
// 管理端鉴权中间件
// ==========================================
function 验证管理权限(req, res, next) {
  const adminSecret = String(process.env.ADMIN_SECRET || '').trim();
  if (!adminSecret) {
    return res.status(503).json({ error: 'ADMIN_SECRET 未配置，管理端接口已关闭' });
  }
  const secret = String(req.headers['x-admin-secret'] || req.query.secret || (req.body && req.body.secret) || '').trim();
  if (secret !== adminSecret) {
    return res.status(403).json({ error: '无权限访问管理后台' });
  }
  next();
}

function 获取管理员标识(req) {
  return String(req.headers['x-admin-actor'] || req.headers['x-admin-user'] || req.query.admin || 'admin').trim() || 'admin';
}

function 记录管理订单事件(req, order, eventType, payload = {}, eventResult = 'success') {
  if (!order || !order.id) return;
  recordOrderEvent({
    orderId: order.id,
    exhibitionId: order.exhibition_id || null,
    deviceUuid: order.device_uuid || null,
    eventType,
    pageName: 'admin',
    payload,
    actorType: 'admin',
    actorId: 获取管理员标识(req),
    platform: 'admin',
    serviceType: order.service_type || null,
    eventResult,
    artworkId: order.artwork_id || null,
    artworkCode: order.artwork_code || null
  });
}

router.use(验证管理权限);

// 自动化规模测试控制面（数据集冻结、分片运行、人工批量评分）。
router.use('/eval', require('./adminEval'));

// SQLite 备份接口（已在鉴权之后挂载）
router.use('/', require('./adminBackup'));

// ==========================================
// 展览管理
// ==========================================
router.get('/exhibitions', (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    res.json({ exhibitions: listExhibitions({ status, includeCounts: true }) });
  } catch (error) {
    res.status(500).json({ error: error.message || '展览列表读取失败' });
  }
});

router.post('/exhibitions', express.json(), (req, res) => {
  try {
    const exhibition = createExhibition(req.body || {});
    res.json({ success: true, exhibition });
  } catch (error) {
    res.status(400).json({ error: error.message || '创建展览失败' });
  }
});

router.get('/exhibitions/:id', (req, res) => {
  const exhibition = getExhibitionById(req.params.id);
  if (!exhibition) return res.status(404).json({ error: '展览不存在' });
  res.json({ exhibition });
});

router.patch('/exhibitions/:id', express.json(), (req, res) => {
  try {
    if (req.body && req.body.status && !EXHIBITION_STATUSES.includes(String(req.body.status))) {
      return res.status(400).json({ error: '无效的展览状态' });
    }
    const exhibition = updateExhibition(req.params.id, req.body || {});
    if (!exhibition) return res.status(404).json({ error: '展览不存在' });
    res.json({ success: true, exhibition });
  } catch (error) {
    res.status(400).json({ error: error.message || '更新展览失败' });
  }
});

router.delete('/exhibitions/:id', (req, res) => {
  try {
    const result = deleteOrArchiveExhibition(req.params.id);
    if (!result) return res.status(404).json({ error: '展览不存在' });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || '删除展览失败' });
  }
});


// ==========================================
// LLM 槽位调试后台 API
// 页面：/admin/llm-debug
// ==========================================
function 确保LLM调试配置() {
  try { ensureDefaultSlotConfigs(db); } catch (error) {
    console.warn('[admin:llm-debug] ensure slot config failed:', error.message || error);
  }
}

function 安全整数(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function 解析LLMJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}


router.get('/llm-debug/field-catalog', (req, res) => {
  res.json({ fields: FIELD_CATALOG });
});

router.get('/llm-debug/slots', (req, res) => {
  确保LLM调试配置();
  const rows = db.prepare(`
    SELECT task, slot, mode, fixed_seed_text, system_prompt, user_prompt_template, gray_ratio, version_label, created_at
    FROM llm_slot_config
    WHERE is_active = 1
    ORDER BY task, slot, created_at DESC
  `).all();
  const activeByKey = new Map();
  for (const row of rows) {
    const key = `${row.task}:${row.slot}`;
    if (!activeByKey.has(key)) activeByKey.set(key, row);
  }
  const slots = SLOT_DEFINITIONS.map(def => ({
    ...def,
    configs: ['delivery_main', 'waiting_progress', 'install_guide']
      .map(task => activeByKey.get(`${task}:${def.slot}`))
      .filter(Boolean)
  }));
  res.json({ slots });
});

router.get('/llm-debug/orders', (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = 安全整数(req.query.limit, 50, 1, 200);
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT id, service_type, service_type_label, status, hanging_status,
             artwork_name, artwork_author, artwork_code, created_at, delivered_at,
             ai_engine, ai_progress_pct
      FROM orders
      WHERE id LIKE ? OR artwork_name LIKE ? OR artwork_code LIKE ? OR service_type_label LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(like, like, like, like, limit);
  } else {
    rows = db.prepare(`
      SELECT id, service_type, service_type_label, status, hanging_status,
             artwork_name, artwork_author, artwork_code, created_at, delivered_at,
             ai_engine, ai_progress_pct
      FROM orders
      WHERE ai_engine = 'hanging'
         OR hanging_job_id IS NOT NULL
         OR hanging_candidate_records_json IS NOT NULL
         OR hanging_narration_bundle_json IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }
  res.json({ orders: rows });
});

router.get('/llm-debug/order/:id', (req, res) => {
  确保LLM调试配置();
  const order = db.prepare('SELECT o.*, e.name AS exhibition_name FROM orders o LEFT JOIN exhibitions e ON e.id = o.exhibition_id WHERE o.id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const runs = db.prepare(`
    SELECT * FROM llm_debug_runs
    WHERE order_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(order.id).map(row => {
    const inputFields = 解析LLMJson(row.input_fields_json, null);
    return {
      ...row,
      input_fields: inputFields,
      selected_field_paths: Array.isArray(inputFields && inputFields.selected_field_paths) ? inputFields.selected_field_paths : []
    };
  });
  const runIds = runs.map(r => r.id);
  let annotations = [];
  if (runIds.length) {
    const placeholders = runIds.map(() => '?').join(',');
    annotations = db.prepare(`
      SELECT * FROM llm_run_annotations
      WHERE run_id IN (${placeholders})
      ORDER BY created_at DESC
    `).all(...runIds).map(row => ({
      ...row,
      dimension_scores: 解析LLMJson(row.dimension_scores_json, {}),
      violation_tags: 解析LLMJson(row.violation_tags_json, [])
    }));
  }
  const overrides = db.prepare(`
    SELECT * FROM llm_slot_overrides
    WHERE order_id = ? AND is_active = 1
    ORDER BY created_at DESC
  `).all(order.id);
  res.json({ order, runs, annotations, overrides });
});

router.post('/llm-debug/annotations', (req, res) => {
  const runId = String(req.body.run_id || '').trim();
  if (!runId) return res.status(400).json({ error: '缺少 run_id' });
  const run = db.prepare('SELECT id FROM llm_debug_runs WHERE id = ?').get(runId);
  if (!run) return res.status(404).json({ error: 'run 不存在' });
  const id = newId('ann');
  db.prepare(`
    INSERT INTO llm_run_annotations (
      id, run_id, annotator_type, annotator, dimension_scores_json, violation_tags_json, comment
    ) VALUES (?, ?, 'human', ?, ?, ?, ?)
  `).run(
    id,
    runId,
    获取管理员标识(req),
    JSON.stringify(req.body.dimension_scores || {}),
    JSON.stringify(req.body.violation_tags || []),
    String(req.body.comment || '')
  );
  res.json({ ok: true, id });
});

router.post('/llm-debug/preferences', (req, res) => {
  const chosenId = String(req.body.chosen_run_id || '').trim();
  const rejectedId = String(req.body.rejected_run_id || '').trim();
  if (!chosenId || !rejectedId) return res.status(400).json({ error: '缺少 chosen_run_id 或 rejected_run_id' });
  if (chosenId === rejectedId) return res.status(400).json({ error: 'chosen 和 rejected 不能相同' });

  const chosen = db.prepare('SELECT * FROM llm_debug_runs WHERE id = ?').get(chosenId);
  const rejected = db.prepare('SELECT * FROM llm_debug_runs WHERE id = ?').get(rejectedId);
  if (!chosen || !rejected) return res.status(404).json({ error: '偏好对中的 run 不存在' });
  if (chosen.order_id !== rejected.order_id || chosen.task !== rejected.task || chosen.slot !== rejected.slot) {
    return res.status(400).json({ error: 'chosen/rejected 必须来自同一订单、同一 task、同一 slot' });
  }

  const promptContext = {
    order_id: chosen.order_id,
    task: chosen.task,
    slot: chosen.slot,
    chosen: {
      run_id: chosen.id,
      system_prompt: chosen.system_prompt || '',
      user_prompt: chosen.user_prompt || '',
      input_fields: 解析LLMJson(chosen.input_fields_json, {})
    },
    rejected: {
      run_id: rejected.id,
      system_prompt: rejected.system_prompt || '',
      user_prompt: rejected.user_prompt || '',
      input_fields: 解析LLMJson(rejected.input_fields_json, {})
    }
  };

  const id = newId('pref');
  db.prepare(`
    INSERT INTO llm_preferences (id, chosen_run_id, rejected_run_id, task, slot, order_id, prompt_context_json, reason, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    chosen.id,
    rejected.id,
    chosen.task || '',
    chosen.slot || '',
    chosen.order_id || '',
    JSON.stringify(promptContext),
    String(req.body.reason || ''),
    获取管理员标识(req)
  );
  res.json({ ok: true, id });
});

router.get('/llm-debug/slot-configs', (req, res) => {
  确保LLM调试配置();
  const rows = db.prepare(`
    SELECT * FROM llm_slot_config
    ORDER BY task, slot, is_active DESC, created_at DESC
  `).all();
  res.json({ configs: rows });
});

router.post('/llm-debug/slot-config', (req, res) => {
  确保LLM调试配置();
  const task = String(req.body.task || 'delivery_main').trim();
  const slot = String(req.body.slot || '').trim().toUpperCase();
  const mode = ['fixed_polish', 'llm_free'].includes(String(req.body.mode || '')) ? String(req.body.mode) : 'llm_free';
  if (!slot) return res.status(400).json({ error: '缺少 slot' });
  const grayRatio = Math.max(0, Math.min(1, Number(req.body.gray_ratio ?? 1)));
  const id = newId('slotcfg');
  const trx = db.transaction(() => {
    db.prepare('UPDATE llm_slot_config SET is_active = 0 WHERE task = ? AND slot = ? AND is_active = 1').run(task, slot);
    db.prepare(`
      INSERT INTO llm_slot_config (id, task, slot, mode, fixed_seed_text, system_prompt, user_prompt_template, is_active, gray_ratio, version_label, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id,
      task,
      slot,
      mode,
      String(req.body.fixed_seed_text || ''),
      String(req.body.system_prompt || ''),
      String(req.body.user_prompt_template || ''),
      grayRatio,
      String(req.body.version_label || `manual_${new Date().toISOString().slice(0, 10)}`),
      获取管理员标识(req)
    );
  });
  trx();
  res.json({ ok: true, id });
});

router.post('/llm-debug/slot-config/:id/activate', (req, res) => {
  确保LLM调试配置();
  const target = db.prepare('SELECT * FROM llm_slot_config WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: '槽位配置不存在' });
  const trx = db.transaction(() => {
    db.prepare('UPDATE llm_slot_config SET is_active = 0 WHERE task = ? AND slot = ? AND is_active = 1').run(target.task, target.slot);
    db.prepare('UPDATE llm_slot_config SET is_active = 1 WHERE id = ?').run(target.id);
  });
  trx();
  res.json({ ok: true, id: target.id, task: target.task, slot: target.slot });
});

router.post('/llm-debug/overrides', (req, res) => {
  const orderId = String(req.body.order_id || '').trim();
  const task = String(req.body.task || 'delivery_main').trim();
  const slot = String(req.body.slot || '').trim();
  const text = String(req.body.override_text || '').trim();
  if (!orderId || !slot || !text) return res.status(400).json({ error: '缺少 order_id、slot 或 override_text' });
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const id = newId('ovr');
  const trx = db.transaction(() => {
    db.prepare('UPDATE llm_slot_overrides SET is_active = 0 WHERE order_id = ? AND task = ? AND slot = ? AND is_active = 1')
      .run(orderId, task, slot);
    db.prepare(`
      INSERT INTO llm_slot_overrides (id, order_id, task, slot, override_text, reason, is_active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, orderId, task, slot, text, String(req.body.reason || ''), 获取管理员标识(req));
  });
  trx();
  res.json({ ok: true, id });
});

router.get('/llm-debug/dataset-snapshot', (req, res) => {
  确保LLM调试配置();
  const count = (table) => {
    try { return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0); }
    catch (_) { return 0; }
  };
  res.json({
    counts: {
      llm_debug_runs: count('llm_debug_runs'),
      llm_run_annotations: count('llm_run_annotations'),
      llm_preferences: count('llm_preferences'),
      llm_slot_config: count('llm_slot_config'),
      llm_slot_overrides: count('llm_slot_overrides')
    },
    note: 'LoRA 导出、训练和部署接口暂不启用；当前只沉淀稳定样本与偏好对。'
  });
});

// ==========================================
// 获取订单列表
// GET /api/admin/orders?status=pending
// ==========================================
router.get('/orders', (req, res) => {
  const { status } = req.query;
  const exhibitionId = resolveAdminExhibitionId(req);
  const summarySubquery = `
    SELECT
      order_id,
      COUNT(*) AS event_count,
      SUM(CASE WHEN event_type = 'result_view' THEN 1 ELSE 0 END) AS view_count,
      SUM(CASE WHEN event_type = 'image_click' THEN 1 ELSE 0 END) AS click_count,
      SUM(CASE WHEN event_type = 'image_download' THEN 1 ELSE 0 END) AS download_count,
      SUM(CASE WHEN event_type = 'page_stay' THEN COALESCE(stay_ms, 0) ELSE 0 END) AS stay_ms_total,
      MAX(created_at) AS latest_event_at
    FROM order_events
    GROUP BY order_id
  `;
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('o.status = ?');
    params.push(status);
  }
  if (exhibitionId) {
    clauses.push('o.exhibition_id = ?');
    params.push(exhibitionId);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  let orders = db.prepare(`
    SELECT o.*,
           e.name AS exhibition_name,
           COALESCE(es.event_count, 0) AS event_count,
           COALESCE(es.view_count, 0) AS view_count,
           COALESCE(es.click_count, 0) AS click_count,
           COALESCE(es.download_count, 0) AS download_count,
           COALESCE(es.stay_ms_total, 0) AS stay_ms_total,
           es.latest_event_at
    FROM orders o
    LEFT JOIN exhibitions e ON e.id = o.exhibition_id
    LEFT JOIN (${summarySubquery}) es ON es.order_id = o.id
    ${whereSql}
    ORDER BY o.created_at DESC
  `).all(...params);

  orders = orders.map(o => {
    const parsed = 解析订单扩展字段(o);
    parsed.delivery_image_urls = resolveDeliveryImageUrls(parsed);
    parsed.delivery_result_records = enrichDeliveryResultRecords(parsed);
    try { parsed.delivery_images = parsed.delivery_images ? JSON.parse(parsed.delivery_images) : []; } catch { parsed.delivery_images = []; }
    return parsed;
  });
  res.json({ orders, exhibition_id: exhibitionId || 'all' });
});

// ==========================================
// 获取单个订单详情（含图片路径）
// GET /api/admin/orders/:id
// ==========================================
router.get('/orders/:id', (req, res) => {
  const order = db.prepare('SELECT o.*, e.name AS exhibition_name FROM orders o LEFT JOIN exhibitions e ON e.id = o.exhibition_id WHERE o.id = ?').get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }
  const parsed = 解析订单扩展字段(order);
  parsed.delivery_image_urls = resolveDeliveryImageUrls(parsed);
  parsed.delivery_result_records = enrichDeliveryResultRecords(parsed);
  try { parsed.delivery_images = parsed.delivery_images ? JSON.parse(parsed.delivery_images) : []; } catch { parsed.delivery_images = []; }
  res.json({ order: parsed });
});

// ==========================================
// 小程序单图上传接口（工作人员端两步上传）
// POST /api/admin/delivery/upload
// ==========================================
router.post('/delivery/upload',
  adminUpload.single('file'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '未收到图片文件' });
    }
    res.json({ success: true, filename: req.file.filename });
  }
);

// ==========================================
// 工具：删除旧交付图片文件（静默，不阻断流程）
// ==========================================
function 删除旧交付文件(imageList) {
  if (!Array.isArray(imageList)) return;
  imageList.forEach(filename => {
    if (!filename) return;
    const fullPath = path.join(DELIVERIES_DIR, filename);
    fs.unlink(fullPath, err => {
      if (err && err.code !== 'ENOENT') {
        console.warn('⚠️ 删除旧交付文件失败:', filename, err.message);
      }
    });
  });
}

// ==========================================
// 交付 / 重新交付订单
// POST /api/admin/deliver/:id
//
// 支持两种上传方式（可混用）：
//   1. 直接 multipart 上传：字段名 images（可多张）
//   2. 两步上传（小程序）：先调 /delivery/upload，再传 filenames JSON 数组
//
// body 字段：
//   images     - 直接上传的图片文件
//   filenames  - 两步上传已保存的文件名数组（JSON 字符串或数组）
//   text       - 可选文字，渲染为图片追加到交付列表
//   redeliver  - '1' 表示重新交付，覆盖旧内容；delivery_token 不变，不重发通知
// ==========================================
router.post('/deliver/:id',
  adminUpload.array('images', 20),
  async (req, res) => {
    try {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
      if (!order) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(404).json({ error: '订单不存在' });
      }

      const isRedeliver = req.body.redeliver === '1';
      const alreadyDelivered = DELIVERED_STATUSES.includes(order.status);

      // 状态校验
      // 修复根因：旧版只判断 status === 'delivered'，导致 viewed / downloaded 状态的
      // 订单无法重新交付（报"订单尚未交付"），也无法被普通交付拦截（报400）。
      // 正确逻辑：delivered / viewed / downloaded 三者均视为"已交付"。
      if (!isRedeliver && alreadyDelivered) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: '订单已交付，如需更新请使用重新交付（redeliver=1）' });
      }
      if (isRedeliver && !alreadyDelivered) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: '订单尚未交付，请使用普通交付' });
      }

      // 收集交付图片文件名
      // 方式1：直接上传的文件
      const directFilenames = (req.files || []).map(f => f.filename);

      // 方式2：两步上传已保存的文件名
      let stepFilenames = [];
      const bodyFilenames = req.body.filenames;
      if (bodyFilenames) {
        stepFilenames = Array.isArray(bodyFilenames)
          ? bodyFilenames
          : JSON.parse(bodyFilenames);
      }

      let deliveryImages = [...directFilenames, ...stepFilenames];
      const deliveryText = (req.body.text || '').trim();

      // 至少需要图片或文字
      if (deliveryImages.length === 0 && !deliveryText) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: '请至少上传一张图片或输入文字' });
      }

      // 文字渲染为图片（可选）
      if (deliveryText) {
        const textImageFilename = `text_${uuidv4()}.png`;
        const textImagePath = path.join(DELIVERIES_DIR, textImageFilename);
        await 文字渲染为图片(deliveryText, textImagePath);
        deliveryImages.push(textImageFilename);
      }

      // 重新交付：先删除旧文件，delivery_token 不变
      if (isRedeliver) {
        try {
          const oldImages = JSON.parse(order.delivery_images || '[]');
          删除旧交付文件(oldImages);
        } catch (e) {
          console.warn('解析旧交付图片列表失败，跳过删除:', e.message);
        }
      }

      const manualSourceRecord = 构建订单默认交付记录来源(order);
      const deliveryResultRecords = [];
      for (let i = 0; i < deliveryImages.length; i++) {
        const filename = deliveryImages[i];
        const record = await 上传交付图片到R2并生成记录(order, filename, { ...manualSourceRecord }, i);
        deliveryResultRecords.push(record);
      }

      // 更新数据库
      db.prepare(`
        UPDATE orders
        SET status = 'delivered',
            delivery_images = ?,
            delivery_text = ?,
            delivered_at = datetime('now','localtime'),
            viewed_at = NULL,
            downloaded_at = NULL,
            delivery_method = ?,
            delivery_result_records_json = ?
        WHERE id = ?
      `).run(
        JSON.stringify(deliveryImages),
        deliveryText,
        isRedeliver ? 'redelivery' : 'manual_upload',
        JSON.stringify(deliveryResultRecords),
        req.params.id
      );

      const deliveryUrl = `https://www.molink.art/d/${order.delivery_token}`;

      // 发送通知（仅首次交付；重新交付不重复打扰用户）
      let emailSent = false;
      if (!isRedeliver) {
        try {
          emailSent = await 发送交付通知到用户邮箱(order, deliveryUrl);
        } catch (e) {
          console.error('邮件发送失败:', e);
        }
        db.prepare('UPDATE orders SET email_sent = ? WHERE id = ?').run(emailSent ? 1 : 0, req.params.id);
        // 微信订阅消息通知（有 openid 且用户已订阅时生效）
        notifyCollector(order.openid, order).catch(e => console.error('订阅消息通知失败:', e.message));
      }

      记录管理订单事件(req, order, isRedeliver ? 'redelivery_success' : 'manual_delivery_success', {
        image_count: deliveryImages.length,
        has_text: !!deliveryText,
        email_sent: !!emailSent
      });

      console.log(`✅ ${isRedeliver ? '重新' : ''}交付完成: ${req.params.id} -> ${deliveryUrl}`);

      res.json({
        success: true,
        emailSent,
        isRedeliver,
        message: isRedeliver
          ? '已覆盖交付内容，链接不变'
          : (emailSent ? '交付成功，通知已发送' : '交付成功，邮件发送失败（请手动通知用户）'),
        deliveryUrl
      });

    } catch (error) {
      console.error('❌ 交付处理失败:', error);
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      res.status(500).json({ error: '交付处理异常' });
    }
  }
);

// ==========================================
// 人工确认推荐作品并提交生成
// POST /api/admin/recommendations/:id/confirm
// body: { artwork_ids: ['id1', 'id2'] }
// ==========================================
router.post('/recommendations/:id/confirm', express.json(), async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.service_type !== 'recommend_work') return res.status(400).json({ error: '仅“根据空间推荐作品”支持人工推荐确认' });
    if (order.status !== 'awaiting_manual_recommendation') return res.status(400).json({ error: '当前订单不处于待人工推荐状态' });
    if (!order.space_image) return res.status(400).json({ error: '订单缺少空间图，无法提交推荐生成' });

    const artworkIds = Array.isArray(req.body?.artwork_ids)
      ? Array.from(new Set(req.body.artwork_ids.map(id => String(id || '').trim()).filter(Boolean)))
      : [];
    if (artworkIds.length < 1 || artworkIds.length > 5) {
      return res.status(400).json({ error: '请勾选 1 到 5 件作品' });
    }

    const artworks = artworkIds.map(id => getArtworkById(id)).filter(Boolean);
    if (artworks.length !== artworkIds.length) {
      return res.status(400).json({ error: '存在已失效的作品，请刷新后重试' });
    }

    const invalidArtwork = artworks.find(artwork => !buildRecommendedArtworkSnapshot(artwork).image_url);
    if (invalidArtwork) {
      return res.status(400).json({ error: `作品「${invalidArtwork.name || invalidArtwork.artwork_code || invalidArtwork.id}」缺少图片，无法生成` });
    }

    const spaceUrl = toAbsoluteFileUrl(order.space_image);
    const recommendedArtworks = artworks.map(buildRecommendedArtworkSnapshot);
    const generationPlan = [];
    const executionIds = [];

    for (const artwork of artworks) {
      const userMessage = buildRecommendWorkUserMessage({
        spaceUrl,
        artwork,
        notes: order.notes || ''
      });
      const ids = await submitImageRequest({ userMessage, executionCount: 1 });
      const execId = ids[0];
      executionIds.push(execId);
      generationPlan.push(buildGenerationPlanItem({ execId, artwork, userMessage }));
    }

    db.prepare(`
      UPDATE orders SET
        recommended_artworks_json = ?,
        ai_execution_id = ?,
        ai_execution_ids = ?,
        ai_generation_plan_json = ?,
        ai_result_url = NULL,
        ai_result_urls = '[]',
        ai_result_records_json = '[]',
        ai_submitted_at = datetime('now','localtime'),
        ai_ready_at = NULL,
        ai_retry_count = 0,
        ai_dim_fix_count = 0,
        ai_current_step = ?,
        status = 'ai_generating',
        ai_initial_image_count = CASE WHEN COALESCE(ai_initial_image_count, 0) = 0 THEN ? ELSE ai_initial_image_count END
      WHERE id = ?
    `).run(
      JSON.stringify(recommendedArtworks),
      executionIds[0] || null,
      JSON.stringify(executionIds),
      JSON.stringify(generationPlan),
      `已提交 ${executionIds.length} 件推荐作品生成`,
      executionIds.length,
      order.id
    );

    记录管理订单事件(req, order, 'manual_recommendation_confirm', {
      selected_count: artworks.length,
      artwork_codes: recommendedArtworks.map(item => item.artwork_code).filter(Boolean)
    });
    记录管理订单事件(req, order, 'recommendation_batch_submitted', {
      image_count: executionIds.length,
      artwork_codes: recommendedArtworks.map(item => item.artwork_code).filter(Boolean)
    });

    res.json({ success: true, executionIds, count: executionIds.length });
  } catch (error) {
    console.error('recommendations confirm 失败:', error);
    res.status(500).json({ error: error.message || '提交推荐生成失败' });
  }
});

// ==========================================
// 一键通过：把 AI 生成图设为交付结果并通知用户
// POST /api/admin/approve/:id
// body (可选): { selected_urls: ['url1', 'url2', ...] } — 指定交付哪几张；不传则交付全部通过的
// ==========================================
router.post('/approve/:id', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });

    const candidates = buildReviewCandidates(order);
    let resultUrls = candidates.map(item => item.url).filter(Boolean);
    if (resultUrls.length === 0) return res.status(400).json({ error: 'AI 效果图尚未生成完成' });

    if (req.body.selected_urls && Array.isArray(req.body.selected_urls) && req.body.selected_urls.length > 0) {
      const allowed = new Set(resultUrls);
      const filtered = req.body.selected_urls.map(u => String(u || '').trim()).filter(u => allowed.has(u));
      if (filtered.length === 0) return res.status(400).json({ error: '所选图片不在该订单的人工审核候选图中，请刷新后重试' });
      resultUrls = filtered;
    } else {
      const defaults = candidates.filter(item => item.selected_by_default).map(item => item.url).filter(Boolean);
      if (defaults.length > 0) resultUrls = defaults;
    }

    const selectedRecords = resultUrls.map(url => {
      const matched = candidates.find(record => record.url === url);
      return matched || { url, artwork_name: order.artwork_name || '', artwork_author: '', artwork_id: order.artwork_id || null, artwork_code: order.artwork_code || null };
    });

    const filenames = [];
    const deliveryResultRecords = [];
    const usedNames = new Set();
    for (let i = 0; i < selectedRecords.length; i++) {
      const record = selectedRecords[i];
      const buf = await downloadFile(record.url);
      const filename = 构建交付图片文件名({ ...order, artwork_name: record.artwork_name || order.artwork_name || order.service_type_label }, i, 'ai.jpg', usedNames);
      const localPath = path.join(DELIVERIES_DIR, filename);
      fs.writeFileSync(localPath, buf);
      filenames.push(filename);
      deliveryResultRecords.push(await 上传交付图片到R2并生成记录(order, filename, record, i));
    }

    db.prepare(`
      UPDATE orders
      SET status='delivered', delivery_images=?, delivered_at=datetime('now','localtime'), viewed_at=NULL, downloaded_at=NULL,
          delivery_method='ai_approved', admin_approve_count=COALESCE(admin_approve_count, 0) + 1,
          admin_approved_at=datetime('now','localtime'), admin_approved_by=?, delivery_result_records_json=?
      WHERE id=?
    `).run(JSON.stringify(filenames), 获取管理员标识(req), JSON.stringify(deliveryResultRecords), order.id);

    const deliveryUrl = `https://www.molink.art/d/${order.delivery_token}`;
    let emailSent = false;
    try {
      emailSent = await 发送交付通知到用户邮箱(order, deliveryUrl);
      db.prepare('UPDATE orders SET email_sent=? WHERE id=?').run(emailSent ? 1 : 0, order.id);
    } catch (e) { console.error('邮件发送失败:', e); }
    notifyCollector(order.openid, order).catch(e => console.error('订阅消息通知失败:', e.message));

    记录管理订单事件(req, order, 'admin_approve_success', {
      image_count: filenames.length,
      email_sent: !!emailSent,
      selected_count: filenames.length,
      artwork_codes: deliveryResultRecords.map(item => item.artwork_code).filter(Boolean)
    });

    console.log(`✅ AI 效果图已审核通过: ${order.id} 共 ${filenames.length} 张`);
    res.json({ success: true, emailSent, deliveryUrl, count: filenames.length });
  } catch (e) {
    console.error('approve 失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// 重新生成：用可选的调整说明重新提交 AI 任务
// POST /api/admin/regenerate/:id
// body: { note: '调整说明（可选）' }
// ==========================================
router.post('/regenerate/:id', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });

    if (order.service_type === 'recommend_work') {
      db.prepare(`UPDATE orders SET
        ai_execution_id = NULL,
        ai_execution_ids = NULL,
        ai_generation_plan_json = NULL,
        ai_result_url = NULL,
        ai_result_urls = '[]',
        ai_result_records_json = '[]',
        ai_submitted_at = NULL,
        ai_ready_at = NULL,
        ai_retry_count = 0,
        ai_dim_fix_count = 0,
        ai_current_step = ?,
        status = 'awaiting_manual_recommendation',
        admin_regenerate_count = COALESCE(admin_regenerate_count, 0) + 1
        WHERE id = ?`).run('已退回人工推荐确认', order.id);

      记录管理订单事件(req, order, 'manual_recommendation_return', {
        retained_selection_count: 获取推荐作品快照列表(order).length
      });
      console.log(`↩️ 推荐作品订单已退回人工确认: ${order.id}`);
      return res.json({ success: true, mode: 'manual_recommendation' });
    }

    if (!order.ai_user_message) return res.status(400).json({ error: '该订单没有保存生图消息，无法重新生成' });

    let userMessage = JSON.parse(order.ai_user_message);
    if (req.body.note && req.body.note.trim()) {
      userMessage = [...userMessage, { text: `

调整要求：${req.body.note.trim()}` }];
    }

    const executionIds = await submitImageRequest({ userMessage });
    const { currentProvider } = require('./services/aiImage');
    const engine = currentProvider() === 'apiyi' ? 'apiyi' : 'mmw';
    db.prepare("UPDATE orders SET ai_engine=?, ai_execution_id=?, ai_execution_ids=?, ai_result_url=NULL, ai_result_urls=NULL, ai_retry_count=0, status=?, admin_regenerate_count=COALESCE(admin_regenerate_count, 0) + 1 WHERE id=?")
      .run(engine, executionIds[0], JSON.stringify(executionIds), 'ai_generating', order.id);

    记录管理订单事件(req, order, 'admin_regenerate_success', {
      image_count: executionIds.length,
      note: req.body.note ? String(req.body.note).trim() : ''
    });

    console.log(`🔄 重新生成: 订单=${order.id} 批次=${executionIds.length} 个执行`);
    res.json({ success: true, executionIds });
  } catch (e) {
    console.error('regenerate 失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// 获取订单埋点详情
// GET /api/admin/orders/:id/events
// ==========================================
router.get('/orders/:id/events', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  const events = db.prepare(`
    SELECT id, device_uuid, event_type, image_index, image_url, page_name, stay_ms, entered_at, left_at, payload_json, created_at
    FROM order_events
    WHERE order_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(req.params.id).map(event => ({
    ...event,
    payload: event.payload_json ? (() => {
      try { return JSON.parse(event.payload_json); } catch (e) { return null; }
    })() : null
  }));

  res.json({ events });
});

// ==========================================
// 批量下载交付图片
// POST /api/admin/orders/download-deliveries
// ==========================================
router.post('/orders/download-deliveries', express.json(), async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body.order_ids) ? req.body.order_ids.filter(Boolean) : [];
    if (orderIds.length === 0) {
      return res.status(400).json({ error: '请选择至少一个订单' });
    }

    const placeholders = orderIds.map(() => '?').join(',');
    const orders = db.prepare(`
      SELECT id, artwork_name, service_type_label, delivery_images, delivery_result_records_json, delivered_at, created_at
      FROM orders
      WHERE id IN (${placeholders})
    `).all(...orderIds);
    const usedNames = new Set();
    const zipEntries = [];

    for (const order of orders) {
      const images = safeJsonArray(order.delivery_images, []);
      const records = safeJsonArray(order.delivery_result_records_json, []);
      for (let index = 0; index < images.length; index++) {
        const filename = images[index];
        const record = matchDeliveryRecord(records, filename, index);
        const fullPath = isAbsoluteUrl(filename) ? '' : path.join(DELIVERIES_DIR, filename);
        const zipName = 构建交付图片文件名(order, index, filename, usedNames);
        if (fullPath && fs.existsSync(fullPath)) {
          zipEntries.push({ fullPath, zipName });
        } else if (record && record.r2_key) {
          try {
            const buffer = await downloadObjectBufferByKey(record.r2_key);
            zipEntries.push({ buffer, zipName });
          } catch (error) {
            console.warn('⚠️ 从 R2 读取交付图失败，跳过:', record.r2_key, error.message || error);
          }
        }
      }
    }

    if (zipEntries.length === 0) {
      return res.status(400).json({ error: '所选订单没有可下载的交付图片' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="molink-deliveries-${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', error => {
      console.error('压缩交付图片失败:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: '压缩失败' });
      } else {
        res.destroy(error);
      }
    });
    archive.pipe(res);

    zipEntries.forEach(entry => {
      if (entry.buffer) {
        archive.append(entry.buffer, { name: entry.zipName });
      } else {
        archive.file(entry.fullPath, { name: entry.zipName });
      }
    });

    await archive.finalize();
  } catch (error) {
    console.error('批量下载交付图片失败:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: '批量下载失败' });
    }
  }
});

// ==========================================
// 删除订单：删除订单记录及相关图片文件
// DELETE /api/admin/orders/:id
// ==========================================
router.delete('/orders/:id', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }

    // 删除用户上传的图片
    const 待删除文件 = [];
    if (order.artwork_image) {
      待删除文件.push(path.join(UPLOADS_DIR, order.artwork_image));
    }
    if (order.space_image) {
      待删除文件.push(path.join(UPLOADS_DIR, order.space_image));
    }

    // 删除交付图片
    if (order.delivery_images) {
      try {
        const deliveryImgs = JSON.parse(order.delivery_images);
        deliveryImgs.forEach(img => {
          if (!isAbsoluteUrl(img)) 待删除文件.push(path.join(DELIVERIES_DIR, img));
        });
      } catch (e) {
        console.error('解析交付图片列表失败:', e);
      }
    }

    // 执行文件删除
    待删除文件.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log('已删除文件:', filePath);
        }
      } catch (e) {
        console.error('删除文件失败:', filePath, e);
      }
    });

    db.prepare('DELETE FROM order_events WHERE order_id = ?').run(req.params.id);

    // 删除数据库记录
    db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);

    res.json({ success: true, message: '订单及相关文件已删除' });

  } catch (error) {
    console.error('❌ 删除订单失败:', error);
    res.status(500).json({ error: '删除订单异常' });
  }
});


const artworkAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 50 },
  fileFilter: (req, file, cb) => {
    const allowedExt = /\.(jpg|jpeg|png|webp|bmp|tiff)$/i;
    const allowedMime = /^image\/(jpeg|png|webp|bmp|tiff)$/i;
    if (allowedExt.test(path.extname(file.originalname)) || allowedMime.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持图片格式'));
    }
  }
});

function artworkSqlIsAllowed(sql) {
  const normalized = String(sql || '').trim();
  if (!normalized) return false;
  const lowered = normalized.toLowerCase();
  const allowedTargets = ['artworks', 'artwork_assets', 'sqlite_master'];
  const touchesAllowedTarget = allowedTargets.some(name => lowered.includes(name));
  const startsAllowedVerb = /^(select|pragma|update|delete|insert)/i.test(normalized);
  return startsAllowedVerb && touchesAllowedTarget;
}

router.get('/artworks/r2-status', async (req, res) => {
  const status = await checkR2Connection();
  res.json(status);
});

router.get('/artworks/miniapp-status', (req, res) => {
  res.json(getMiniappConfigState());
});

function buildEmptyRoomPrompt(artwork, note = '') {
  const imageUrl = artwork.primary_image_url || artwork.cover_url || (artwork.images || [])[0];
  const text = `你是室内艺术陈设摄影导演。请分析所附作品的色彩、形式、年代气质与材质，仅用这些信息设计一个高度匹配的真实家装空间。输出一张高清、自然透视、真实环境光的室内照片。必须保留一块完整、正视或轻微透视、无遮挡、无门窗、光照均匀的可挂画墙面；墙面周围保留充分净空。严禁把所附作品或任何画作、海报、文字、相框、挂轴放进空间，严禁复制作品图案到地毯、抱枕或家具。家具应完整但克制，形成丰富层次；预留墙面不要处于画面正中央。后续程序会按作品真实尺寸完成精确挂画，因此不要画占位框。作品信息：${artwork.name || '未命名'}；作者：${artwork.author || '未知'}；真实尺寸：${artwork.size_text || artwork.size || '未填写'}。${String(note || '').trim() ? `补充要求：${String(note).trim()}` : ''}`;
  return [{ text }, { file_url: imageUrl }];
}

router.post('/artworks/:id/generate-effect', express.json(), async (req, res) => {
  try {
    const artwork = getArtworkById(req.params.id);
    if (!artwork) return res.status(404).json({ error: '作品不存在' });
    const imageUrl = artwork.primary_image_url || artwork.cover_url || (artwork.images || [])[0];
    if (!imageUrl) return res.status(400).json({ error: '请先上传作品原图' });
    if (!artwork.size_text && !artwork.size) return res.status(400).json({ error: '请先填写作品真实尺寸' });
    const orderId = uuidv4();
    const deliveryToken = uuidv4().replace(/-/g, '').slice(0, 16);
    const userMessage = buildEmptyRoomPrompt(artwork, req.body && req.body.note);
    const executionIds = await submitImageRequest({ userMessage, executionCount: 1 });
    db.prepare(`INSERT INTO orders (
      id, exhibition_id, service_type, service_type_label, receive_method, receive_target,
      artwork_image, artwork_size, artwork_id, artwork_code, artwork_name, delivery_token,
      entry_platform, entry_source, status, ai_execution_id, ai_execution_ids, ai_user_message,
      ai_submitted_at, ai_current_step, created_at
    ) VALUES (?, ?, 'hang_in_home', '作品空间效果图', 'internal', 'admin', ?, ?, ?, ?, ?, ?,
      'admin', 'artwork_effect_generator', 'ai_generating', ?, ?, ?, datetime('now','localtime'),
      '正在生成不含画作的适配空间', datetime('now','localtime'))`).run(
      orderId, artwork.exhibition_id || null, imageUrl, artwork.size_text || artwork.size,
      artwork.id, artwork.artwork_code || null, artwork.name || null, deliveryToken,
      executionIds[0], JSON.stringify(executionIds), JSON.stringify(userMessage)
    );
    res.json({ success: true, task_id: orderId, status: 'ai_generating' });
  } catch (error) {
    res.status(500).json({ error: error.message || '空间效果图任务创建失败' });
  }
});

router.get('/artworks/:id/effect-generation', async (req, res) => {
  try {
    let order = db.prepare("SELECT * FROM orders WHERE artwork_id = ? AND entry_source = 'artwork_effect_generator' ORDER BY created_at DESC LIMIT 1").get(req.params.id);
    if (!order) return res.json({ status: 'idle' });
    if (order.status === 'ai_generating' && order.ai_execution_id) {
      const check = await checkExecution(order.ai_execution_id);
      if (check.status === 'failed') {
        db.prepare("UPDATE orders SET status='failed', ai_current_step='空空间生成失败' WHERE id=?").run(order.id);
      } else if (check.status === 'completed' && check.imageUrl) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        const buffer = await downloadFile(check.imageUrl);
        const filename = `artwork-effect-room-${order.id}.png`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
        const hangingJobId = `job_${order.id}`;
        db.prepare(`UPDATE orders SET space_image=?, status='hanging_queued', ai_ready_at=datetime('now','localtime'),
          ai_current_step='空空间已生成，正在按真实尺寸精确挂画', hanging_job_id=?,
          hanging_submitted_at=datetime('now','localtime'), ai_engine='hanging' WHERE id=?`).run(filename, hangingJobId, order.id);
        order = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
        workerHub.enqueueJob(buildJobFromOrder(order));
        autodl.selectAndStartInstance(workerHub).catch(error => console.warn('[artwork-effect] worker start failed:', error.message));
      }
    }
    order = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
    res.json({
      task_id: order.id,
      status: order.status,
      step: order.ai_current_step || '',
      created_at: order.created_at,
      ready: order.status === 'delivered',
      failed: ['failed', 'hanging_failed', 'hanging_no_safe_wall'].includes(order.status)
    });
  } catch (error) {
    res.status(500).json({ error: error.message || '任务状态读取失败' });
  }
});

router.get('/artworks/miniapp-codes/download-all', async (req, res) => {
  try {
    const exhibitionId = resolveAdminExhibitionId(req);
    if (!exhibitionId) {
      return res.status(400).json({ error: '请先在顶部选择一个具体展览，再按展览导出小程序码' });
    }
    const exhibition = getExhibitionById(exhibitionId, { includeCounts: false });
    if (!exhibition) return res.status(404).json({ error: '展览不存在' });
    const artworks = listArtworks({ keyword: '', status: '', exhibitionId }) || [];
    if (!artworks.length) {
      return res.status(400).json({ error: '暂无作品可导出' });
    }

    const readyItems = [];
    const skippedLines = [];
    const errorLines = [];

    for (const artwork of artworks) {
      try {
        const hasEffect = Array.isArray(artwork.effect_assets) && artwork.effect_assets.length > 0;
        if (!hasEffect) {
          skippedLines.push(`${artwork.artwork_code || artwork.id || 'UNKNOWN'}\t${artwork.name || '未命名作品'}\t缺少主效果图`);
          continue;
        }
        const result = await ensureMiniappCodeForArtwork(artwork.id);
        const asset = result && result.asset ? result.asset : null;
        if (!asset || !asset.url) {
          skippedLines.push(`${artwork.artwork_code || artwork.id || 'UNKNOWN'}\t${artwork.name || '未命名作品'}\t未生成可下载二维码`);
          continue;
        }
        readyItems.push({
          artworkCode: artwork.artwork_code || artwork.id,
          artworkName: artwork.name || '未命名作品',
          url: asset.url
        });
      } catch (error) {
        errorLines.push(`${artwork.artwork_code || artwork.id || 'UNKNOWN'}\t${artwork.name || '未命名作品'}\t${error.message || '二维码生成失败'}`);
      }
    }

    const exportName = `${安全文件名(exhibition.name, '展览')}-小程序码-${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="miniapp-codes.zip"; filename*=UTF-8''${encodeURIComponent(exportName)}`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || '导出失败' });
      } else {
        res.end();
      }
    });
    archive.pipe(res);

    for (const item of readyItems) {
      try {
        const response = await fetch(item.url);
        if (!response.ok) {
          throw new Error(`下载二维码失败（HTTP ${response.status}）`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        archive.append(buffer, { name: `${安全文件名(item.artworkName, '未命名作品')}-${安全文件名(item.artworkCode, 'artwork')}-小程序码.png` });
      } catch (error) {
        errorLines.push(`${item.artworkCode}\t${item.artworkName}\t${error.message || '下载二维码失败'}`);
      }
    }

    if (skippedLines.length) {
      archive.append(`以下作品未导出二维码：\n\n${skippedLines.join('\n')}\n`, { name: 'skipped.txt' });
    }
    if (errorLines.length) {
      archive.append(`以下作品导出二维码时发生错误：\n\n${errorLines.join('\n')}\n`, { name: 'errors.txt' });
    }
    if (!readyItems.length && !skippedLines.length && !errorLines.length) {
      archive.append('没有可导出的二维码。', { name: 'README.txt' });
    }
    archive.finalize();
  } catch (error) {
    res.status(500).json({ error: error.message || '批量导出小程序码失败' });
  }
});


router.get('/artworks-lite', (req, res) => {
  try {
    const result = listArtworksLite({
      keyword: req.query.q || '',
      status: req.query.status || '',
      exhibitionId: resolveAdminExhibitionId(req),
      limit: req.query.limit || 60,
      cursor: req.query.cursor || 0
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || '作品缩略列表读取失败' });
  }
});

router.get('/artworks', (req, res) => {
  try {
    const artworks = listArtworks({ keyword: req.query.q || '', status: req.query.status || '', exhibitionId: resolveAdminExhibitionId(req) });
    res.json({ artworks });
  } catch (error) {
    res.status(500).json({ error: error.message || '作品列表读取失败' });
  }
});

router.get('/artworks/:id', (req, res) => {
  const artwork = getArtworkById(req.params.id);
  if (!artwork) {
    return res.status(404).json({ error: '作品不存在' });
  }
  res.json({ artwork });
});

router.post('/artworks', express.json(), (req, res) => {
  try {
    const { name, author, price, description, status, length, trans, frame_length, frame_trans, exhibition_id } = req.body || {};
    if (!name || !author) {
      return res.status(400).json({ error: '名称和作者为必填项' });
    }
    if (!exhibition_id) {
      return res.status(400).json({ error: '所属展览为必填项' });
    }
    const artwork = createArtwork({ exhibition_id, name, author, price, description, status: status || 'published', length, trans, frame_length, frame_trans });
    res.json({ success: true, artwork });
  } catch (error) {
    res.status(500).json({ error: error.message || '创建作品失败' });
  }
});

router.patch('/artworks/:id', express.json(), (req, res) => {
  try {
    const artwork = updateArtwork(req.params.id, req.body || {});
    if (!artwork) {
      return res.status(404).json({ error: '作品不存在' });
    }
    res.json({ success: true, artwork });
  } catch (error) {
    res.status(500).json({ error: error.message || '更新作品失败' });
  }
});

router.delete('/artworks/:id', async (req, res) => {
  try {
    await deleteArtwork(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || '删除作品失败' });
  }
});

router.post('/artworks/:id/assets/:assetKind', artworkAssetUpload.array('files', 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '未收到图片文件' });
    }
    const assetKind = ['artwork', 'effect', 'frame'].includes(req.params.assetKind) ? req.params.assetKind : 'artwork';
    if (assetKind === 'effect' && req.files.length > 1) {
      return res.status(400).json({ error: '每件作品只允许上传 1 张主效果图' });
    }
    const assets = await addArtworkAssets({
      artworkId: req.params.id,
      files: req.files,
      assetKind,
      dimensions: {
        length: req.body.length,
        trans: req.body.trans,
        frame_length: req.body.frame_length,
        frame_trans: req.body.frame_trans
      }
    });
    const artwork = getArtworkById(req.params.id);
    res.json({ success: true, assetKind, assets, artwork });
  } catch (error) {
    res.status(500).json({ error: error.message || '上传作品图片失败' });
  }
});

router.post('/artworks/:id/assign-scan-page', async (req, res) => {
  try {
    const result = await assignMiniappScanPage(req.params.id);
    res.json({
      success: true,
      created: result.created,
      asset: result.asset,
      page_path: result.page_path,
      display_path: result.display_path,
      scene: result.scene,
      artwork: result.artwork
    });
  } catch (error) {
    res.status(500).json({ error: error.message || '分配扫码页失败' });
  }
});

router.patch('/artworks/:id/assets/reorder', express.json(), (req, res) => {
  try {
    const artwork = reorderAssets(req.params.id, Array.isArray(req.body && req.body.items) ? req.body.items : []);
    res.json({ success: true, artwork });
  } catch (error) {
    res.status(500).json({ error: error.message || '排序保存失败' });
  }
});

router.patch('/artworks/:id/cover', express.json(), (req, res) => {
  try {
    const { asset_id } = req.body || {};
    if (!asset_id) {
      return res.status(400).json({ error: '缺少 asset_id' });
    }
    const artwork = setArtworkCover(req.params.id, asset_id);
    res.json({ success: true, artwork });
  } catch (error) {
    res.status(500).json({ error: error.message || '设置封面失败' });
  }
});

router.delete('/artwork-assets/:assetId', async (req, res) => {
  try {
    const ok = await deleteArtworkAsset(req.params.assetId);
    if (!ok) {
      return res.status(404).json({ error: '图片不存在' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || '删除图片失败' });
  }
});

router.get('/artworks-sql/schema', (req, res) => {
  try {
    const tables = db.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('artworks', 'artwork_assets')
      ORDER BY name ASC
    `).all();
    const indexes = db.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index' AND tbl_name IN ('artworks', 'artwork_assets')
      ORDER BY name ASC
    `).all();
    res.json({ tables, indexes });
  } catch (error) {
    res.status(500).json({ error: error.message || 'SQL 结构读取失败' });
  }
});

router.post('/artworks-sql/query', express.json({ limit: '1mb' }), (req, res) => {
  try {
    const sql = String(req.body && req.body.sql || '').trim();
    if (!artworkSqlIsAllowed(sql)) {
      return res.status(400).json({ error: '仅允许 artworks / artwork_assets / sqlite_master 的 SELECT、PRAGMA、INSERT、UPDATE、DELETE 语句' });
    }
    if (/^(select|pragma)/i.test(sql)) {
      const rows = db.prepare(sql).all();
      return res.json({ rows, changes: 0 });
    }
    const result = db.prepare(sql).run();
    return res.json({ changes: result.changes, lastInsertRowid: result.lastInsertRowid || null });
  } catch (error) {
    res.status(500).json({ error: error.message || 'SQL 执行失败' });
  }
});



function 构建日期过滤(column, startDate, endDate) {
  const clauses = [];
  const params = [];
  if (startDate) {
    clauses.push(`${column} >= ?`);
    params.push(`${startDate} 00:00:00`);
  }
  if (endDate) {
    clauses.push(`${column} <= ?`);
    params.push(`${endDate} 23:59:59`);
  }
  return {
    clause: clauses.length ? clauses.join(' AND ') : '1=1',
    params
  };
}

function 计算时长毫秒(startAt, endAt) {
  if (!startAt || !endAt) return null;
  const diff = new Date(endAt).getTime() - new Date(startAt).getTime();
  if (!Number.isFinite(diff) || diff < 0) return null;
  return diff;
}

function 百分位(values, p) {
  const list = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return 0;
  if (list.length === 1) return list[0];
  const index = Math.ceil((p / 100) * list.length) - 1;
  return list[Math.max(0, Math.min(index, list.length - 1))];
}

function 平均值(values) {
  const list = values.filter(v => Number.isFinite(v));
  if (!list.length) return 0;
  return Math.round(list.reduce((sum, value) => sum + value, 0) / list.length);
}

function 保留四位(value) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(4));
}

function 解析JSON(text, fallback = {}) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function 日期键(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function 本地日期字符串(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function 偏移日期字符串(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return 本地日期字符串(date);
}

function 生成日期序列(startDate, endDate) {
  const startText = startDate || 偏移日期字符串(-6);
  const endText = endDate || 本地日期字符串();
  const start = new Date(`${startText}T00:00:00`);
  const end = new Date(`${endText}T00:00:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];
  const dates = [];
  const cursor = new Date(start);
  let guard = 0;
  while (cursor <= end && guard < 370) {
    dates.push(本地日期字符串(cursor));
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return dates;
}

function 归一化设备平台(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('ios') || text.includes('iphone') || text.includes('ipad')) return 'iOS';
  if (text.includes('android')) return 'Android';
  if (text.includes('devtools')) return '开发工具';
  if (text.includes('windows')) return 'Windows';
  if (text.includes('mac')) return 'macOS';
  return value ? '其他' : '未知';
}

function 生成占比分布(mapOrRows, totalKey = 'count') {
  const rows = Array.isArray(mapOrRows)
    ? mapOrRows
    : Array.from((mapOrRows || new Map()).entries()).map(([label, count]) => ({ label, count }));
  const total = rows.reduce((sum, row) => sum + Number(row[totalKey] || row.count || 0), 0);
  return rows.map(row => {
    const count = Number(row[totalKey] || row.count || 0);
    return Object.assign({}, row, { count, ratio: total ? 保留四位(count / total) : 0 });
  });
}

function 漏斗步骤(stepKey, label, count, previousCount, tip, options = {}) {
  const safeCount = Number(count || 0);
  const safePrevious = Number(previousCount || 0);
  const lossCount = safePrevious > 0 ? Math.max(0, safePrevious - safeCount) : 0;
  return Object.assign({
    step_key: stepKey,
    label,
    count: safeCount,
    previous_count: safePrevious,
    conversion_rate: safePrevious > 0 ? 保留四位(safeCount / safePrevious) : (safeCount > 0 ? 1 : 0),
    loss_count: lossCount,
    loss_rate: safePrevious > 0 ? 保留四位(lossCount / safePrevious) : 0,
    tip
  }, options || {});
}

router.get('/analytics/dashboard', (req, res) => {
  try {
    const startDate = String(req.query.start_date || '').trim();
    const endDate = String(req.query.end_date || '').trim();
    const exhibitionId = resolveAdminExhibitionId(req);
    const orderDateRange = 构建日期过滤('created_at', startDate, endDate);
    const appEventDateRange = 构建日期过滤('created_at', startDate, endDate);
    const orderRange = {
      clause: `${orderDateRange.clause}${exhibitionId ? ' AND exhibition_id = ?' : ''}`,
      params: exhibitionId ? [...orderDateRange.params, exhibitionId] : orderDateRange.params
    };
    const appEventRange = {
      clause: `${appEventDateRange.clause}${exhibitionId ? ' AND exhibition_id = ?' : ''}`,
      params: exhibitionId ? [...appEventDateRange.params, exhibitionId] : appEventDateRange.params
    };
    const appEventScopeSql = exhibitionId ? ' AND exhibition_id = ?' : '';
    const appEventScopeParams = exhibitionId ? [exhibitionId] : [];

    const orders = db.prepare(`
      SELECT id, device_uuid, openid, service_type, service_type_label, status, created_at, ai_submitted_at, ai_ready_at, delivered_at, viewed_at, downloaded_at,
             exhibition_id, artwork_id, artwork_code, artwork_name, entry_source, admin_approve_count, admin_regenerate_count,
             ai_first_ready_count, ai_total_ready_count, content_review_status, content_review_rejected_at
      FROM orders
      WHERE ${orderRange.clause}
      ORDER BY created_at DESC
    `).all(...orderRange.params);

    const serviceSelectedRows = db.prepare(`
      SELECT service_type, COUNT(*) AS count
      FROM app_events
      WHERE event_name = 'service_selected' AND ${appEventRange.clause}
      GROUP BY service_type
    `).all(...appEventRange.params);

    const appEventSummaryRows = db.prepare(`
      SELECT event_name, COALESCE(service_type, '') AS service_type, COUNT(*) AS count
      FROM app_events
      WHERE ${appEventRange.clause}
      GROUP BY event_name, COALESCE(service_type, '')
    `).all(...appEventRange.params);

    const scanEntryRows = db.prepare(`
      SELECT exhibition_id, artwork_id, artwork_code, COUNT(*) AS count
      FROM app_events
      WHERE event_name = 'scan_entry_view' AND COALESCE(artwork_code, '') <> '' AND ${appEventRange.clause}
      GROUP BY exhibition_id, artwork_id, artwork_code
    `).all(...appEventRange.params);

    const miniappEntryRows = db.prepare(`
      SELECT entry_source, COUNT(*) AS count
      FROM app_events
      WHERE event_name = 'miniapp_entry' AND platform = 'miniapp' AND ${appEventRange.clause}
      GROUP BY entry_source
    `).all(...appEventRange.params);

    const activeMiniappDeviceRows = db.prepare(`
      SELECT DISTINCT device_uuid
      FROM app_events
      WHERE platform = 'miniapp'
        AND COALESCE(device_uuid, '') <> ''
        AND ${appEventRange.clause}
    `).all(...appEventRange.params);

    const allMiniappDeviceRows = db.prepare(`
      SELECT device_uuid, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
      FROM app_events
      WHERE platform = 'miniapp' AND COALESCE(device_uuid, '') <> ''${appEventScopeSql}
      GROUP BY device_uuid
    `).all(...appEventScopeParams);

    const miniappDeviceProfileRows = db.prepare(`
      SELECT device_uuid, props_json, created_at
      FROM app_events
      WHERE event_name = 'miniapp_device_profile'
        AND platform = 'miniapp'
        AND COALESCE(device_uuid, '') <> ''${appEventScopeSql}
      ORDER BY created_at DESC
    `).all(...appEventScopeParams);

    const dailyAppEventRows = db.prepare(`
      SELECT substr(created_at, 1, 10) AS date_key, event_name, COUNT(*) AS count
      FROM app_events
      WHERE event_name IN ('service_selected', 'service_next_clicked', 'upload_page_view', 'required_input_ready', 'submit_clicked')
        AND ${appEventRange.clause}
      GROUP BY substr(created_at, 1, 10), event_name
    `).all(...appEventRange.params);

    const inputValidationFailedRows = db.prepare(`
      SELECT COALESCE(service_type, '') AS service_type, COUNT(*) AS count
      FROM app_events
      WHERE event_name = 'submit_failed'
        AND COALESCE(props_json, '') LIKE '%"stage":"input_image_validation"%'
        AND ${appEventRange.clause}
      GROUP BY COALESCE(service_type, '')
    `).all(...appEventRange.params);

    const uploadPageViewRows = db.prepare(`
      SELECT COALESCE(service_type, '') AS service_type,
             COALESCE(entry_source, '') AS entry_source,
             COUNT(*) AS count,
             SUM(CASE WHEN COALESCE(props_json, '') LIKE '%"artwork_selection_method":"upload_scan_button"%' THEN 1 ELSE 0 END) AS upload_scan_button_count
      FROM app_events
      WHERE event_name = 'upload_page_view' AND ${appEventRange.clause}
      GROUP BY COALESCE(service_type, ''), COALESCE(entry_source, '')
    `).all(...appEventRange.params);

    const serviceSelectedMap = new Map(serviceSelectedRows.map(row => [row.service_type, Number(row.count || 0)]));
    const scanEntryMap = new Map(scanEntryRows.map(row => [`${row.exhibition_id || ''}::${row.artwork_id || row.artwork_code}`, Number(row.count || 0)]));
    const miniappEntryMap = new Map(miniappEntryRows.map(row => [row.entry_source, Number(row.count || 0)]));
    const inputValidationFailedMap = new Map(inputValidationFailedRows.map(row => [row.service_type || '', Number(row.count || 0)]));
    const appEventCountMap = new Map(appEventSummaryRows.map(row => [`${row.event_name}::${row.service_type || ''}`, Number(row.count || 0)]));
    const 取应用事件数 = (eventName, serviceType = null) => {
      if (serviceType === null || serviceType === undefined) {
        return appEventSummaryRows
          .filter(row => row.event_name === eventName)
          .reduce((sum, row) => sum + Number(row.count || 0), 0);
      }
      return Number(appEventCountMap.get(`${eventName}::${serviceType || ''}`) || 0);
    };
    const 取上传页分支 = (serviceType = null) => {
      return uploadPageViewRows.reduce((accumulator, row) => {
        const rowService = row.service_type || '';
        if (serviceType !== null && serviceType !== undefined && rowService !== (serviceType || '')) return accumulator;
        const count = Number(row.count || 0);
        const scanButtonReentry = Number(row.upload_scan_button_count || 0);
        const entrySource = row.entry_source || '';

        if (entrySource === 'scan_entry' || entrySource === 'scan_qr') {
          const directCount = Math.max(0, count - scanButtonReentry);
          accumulator.scan_direct_count += directCount;
          accumulator.upload_scan_button_reentry_count += Math.max(0, scanButtonReentry);
        } else {
          accumulator.service_path_count += count;
        }
        accumulator.raw_upload_page_view_count += count;
        return accumulator;
      }, {
        service_path_count: 0,
        scan_direct_count: 0,
        upload_scan_button_reentry_count: 0,
        raw_upload_page_view_count: 0,
        total_count: 0
      });
    };
    const 规范化上传页分支 = branch => {
      const normalized = Object.assign({}, branch || {});
      normalized.service_path_count = Number(normalized.service_path_count || 0);
      normalized.scan_direct_count = Number(normalized.scan_direct_count || 0);
      normalized.upload_scan_button_reentry_count = Number(normalized.upload_scan_button_reentry_count || 0);
      normalized.raw_upload_page_view_count = Number(normalized.raw_upload_page_view_count || 0);
      normalized.total_count = normalized.service_path_count + normalized.scan_direct_count;
      return normalized;
    };
    const artworkSelectionRows = db.prepare(`
      SELECT artwork_selection_method, COUNT(*) AS count
      FROM orders
      WHERE ${orderRange.clause} AND COALESCE(artwork_selection_method, '') <> ''
      GROUP BY artwork_selection_method
    `).all(...orderRange.params);

    const artworkSelectionMethodMap = new Map(artworkSelectionRows.map(row => [row.artwork_selection_method, Number(row.count || 0)]));

    const deliveredOrders = orders.filter(order => !!order.delivered_at);
    const viewedOrders = orders.filter(order => !!order.viewed_at || !!order.downloaded_at);
    const downloadedOrders = orders.filter(order => !!order.downloaded_at);
    const aiReadyOrders = orders.filter(order => !!order.ai_ready_at);
    const auditRejectedOrders = orders.filter(order => order.status === 'audit_rejected' || order.content_review_status === 'rejected');
    const submitToDeliveredDurations = deliveredOrders.map(order => 计算时长毫秒(order.created_at, order.delivered_at)).filter(v => Number.isFinite(v));
    const submitToAiDurations = orders.map(order => 计算时长毫秒(order.created_at, order.ai_submitted_at)).filter(v => Number.isFinite(v));
    const aiToReadyDurations = orders.map(order => 计算时长毫秒(order.ai_submitted_at, order.ai_ready_at)).filter(v => Number.isFinite(v));
    const readyToDeliveredDurations = orders.map(order => 计算时长毫秒(order.ai_ready_at, order.delivered_at)).filter(v => Number.isFinite(v));

    const overview = {
      submit_count: orders.length,
      ai_system_pass_count: aiReadyOrders.length,
      audit_rejected_count: auditRejectedOrders.length,
      delivered_count: deliveredOrders.length,
      viewed_count: viewedOrders.length,
      downloaded_count: downloadedOrders.length,
      human_approve_count: orders.reduce((sum, order) => sum + Number(order.admin_approve_count || 0), 0),
      avg_delivery_ms: 平均值(submitToDeliveredDurations),
      p90_delivery_ms: 百分位(submitToDeliveredDurations, 90),
      submit_denominator_count: Array.from(serviceSelectedMap.values()).reduce((sum, count) => sum + count, 0)
    };

    const targetServices = ['hang_in_home', 'recommend_work'];
    const serviceOrders = serviceType => orders.filter(order => order.service_type === serviceType);
    const services = targetServices.map(serviceType => {
      const matchedOrders = serviceOrders(serviceType);
      const submitted = matchedOrders.length;
      const delivered = matchedOrders.filter(order => !!order.delivered_at).length;
      const auditRejected = matchedOrders.filter(order => order.status === 'audit_rejected' || order.content_review_status === 'rejected').length;
      const viewed = matchedOrders.filter(order => !!order.viewed_at || !!order.downloaded_at).length;
      const downloaded = matchedOrders.filter(order => !!order.downloaded_at).length;
      const selectedClicks = Number(serviceSelectedMap.get(serviceType) || 0);
      return {
        service_type: serviceType,
        service_label: serviceType === 'hang_in_home' ? '作品挂进家' : '为空间推荐作品',
        service_selected_count: selectedClicks,
        submit_count: submitted,
        submit_rate: selectedClicks ? 保留四位(submitted / selectedClicks) : 0,
        delivered_count: delivered,
        audit_rejected_count: auditRejected,
        delivery_rate: submitted ? 保留四位(delivered / submitted) : 0,
        viewed_count: viewed,
        downloaded_count: downloaded,
        download_rate_by_submit: submitted ? 保留四位(downloaded / submitted) : 0,
        download_rate_by_delivered: delivered ? 保留四位(downloaded / delivered) : 0,
        download_rate_by_result_view: viewed ? 保留四位(downloaded / viewed) : 0
      };
    });

    const hangInHomeOrders = serviceOrders('hang_in_home');
    const recommendWorkOrders = serviceOrders('recommend_work');
    const hangAuditRejectedCount = hangInHomeOrders.filter(order => order.status === 'audit_rejected' || order.content_review_status === 'rejected').length;
    const hangAiSubmittedCount = hangInHomeOrders.filter(order => !!order.ai_submitted_at).length;
    const hangAiReadyCount = hangInHomeOrders.filter(order => !!order.ai_ready_at).length;
    const recommendInputFailedCount = recommendWorkOrders.filter(order => order.status === 'audit_rejected' || order.content_review_status === 'rejected').length;
    const recommendInputPassedCount = recommendWorkOrders.filter(order => !(order.status === 'audit_rejected' || order.content_review_status === 'rejected')).length;
    const recommendInputReviewTotal = recommendInputPassedCount + recommendInputFailedCount;
    const reviewPassTotalNumerator = hangAiReadyCount + recommendInputPassedCount;
    const reviewPassTotalDenominator = hangAiSubmittedCount + recommendInputReviewTotal;
    const serviceReviewPass = {
      hang_in_home: {
        service_type: 'hang_in_home',
        service_label: '作品挂进家',
        review_name: 'AI交付图系统审核通过率',
        denominator_label: 'AI提交订单数',
        denominator_count: hangAiSubmittedCount,
        numerator_label: '系统审核通过订单数',
        numerator_count: hangAiReadyCount,
        submit_count: hangInHomeOrders.length,
        audit_rejected_count: hangAuditRejectedCount,
        rate: hangAiSubmittedCount ? 保留四位(hangAiReadyCount / hangAiSubmittedCount) : 0,
        tip: '作品挂进家会直接进入 AI 生图与系统审核链路。分母为 ai_submitted_at 非空的订单数，分子为 ai_ready_at 非空的订单数。'
      },
      recommend_work: {
        service_type: 'recommend_work',
        service_label: '根据空间推荐作品',
        review_name: '空间输入图审核通过率',
        denominator_label: '输入图审核尝试数',
        denominator_count: recommendInputReviewTotal,
        numerator_label: '输入图审核通过订单数',
        numerator_count: recommendInputPassedCount,
        submit_count: recommendInputPassedCount,
        failed_count: recommendInputFailedCount,
        rate: recommendInputReviewTotal ? 保留四位(recommendInputPassedCount / recommendInputReviewTotal) : 0,
        tip: '根据空间推荐作品先通过内容安全审核。分母为该服务全部成功创建订单数，分子为未被内容安全拒绝的订单数。审核拒绝订单保留在 orders 中并计入提交量。'
      },
      total: {
        label: '总通过率（按各自审核口径加权）',
        numerator_count: reviewPassTotalNumerator,
        denominator_count: reviewPassTotalDenominator,
        rate: reviewPassTotalDenominator ? 保留四位(reviewPassTotalNumerator / reviewPassTotalDenominator) : 0,
        tip: '公式：（作品挂进家系统审核通过订单数 + 根据空间推荐作品内容审核通过订单数）/（作品挂进家AI提交订单数 + 根据空间推荐作品全部创建订单数）。审核拒绝订单保留在总订单统计中。'
      }
    };

    const artworkMap = new Map();
    orders.forEach(order => {
      const artworkCode = String(order.artwork_code || '').trim();
      if (!artworkCode) return;
      const artworkKey = `${order.exhibition_id || ''}::${order.artwork_id || artworkCode}`;
      if (!artworkMap.has(artworkKey)) {
        artworkMap.set(artworkKey, {
          exhibition_id: order.exhibition_id || null,
          artwork_code: artworkCode,
          artwork_id: order.artwork_id || null,
          artwork_name: order.artwork_name || '未命名作品',
          selected_submit_count: 0,
          downloaded_order_count: 0,
          scan_entry_count: Number(scanEntryMap.get(artworkKey) || 0)
        });
      }
      const item = artworkMap.get(artworkKey);
      item.selected_submit_count += 1;
      if (order.downloaded_at) item.downloaded_order_count += 1;
    });
    const artworks = Array.from(artworkMap.values())
      .map(item => ({
        ...item,
        download_rate: item.selected_submit_count ? 保留四位(item.downloaded_order_count / item.selected_submit_count) : 0
      }))
      .sort((a, b) => (b.selected_submit_count - a.selected_submit_count) || (b.scan_entry_count - a.scan_entry_count));

    const selectionMethodLabels = {
      scan_entry_qr: '现场扫小程序码选定',
      search_select: '搜索选定作品',
      list_select: '滑动作品列表选定',
      upload_scan_button: '作品检索旁扫码按钮选定'
    };
    const artworkSelectionTotal = Array.from(artworkSelectionMethodMap.values()).reduce((sum, count) => sum + count, 0);
    const artworkSelectionMethods = Object.keys(selectionMethodLabels).map(method => ({
      method,
      method_label: selectionMethodLabels[method],
      order_count: Number(artworkSelectionMethodMap.get(method) || 0),
      ratio: artworkSelectionTotal > 0 ? 保留四位(Number(artworkSelectionMethodMap.get(method) || 0) / artworkSelectionTotal) : 0
    }));

    const operations = {
      avg_submit_to_ai_ms: 平均值(submitToAiDurations),
      avg_ai_to_ready_ms: 平均值(aiToReadyDurations),
      avg_ready_to_delivered_ms: 平均值(readyToDeliveredDurations),
      avg_total_ms: 平均值(submitToDeliveredDurations),
      p50_total_ms: 百分位(submitToDeliveredDurations, 50),
      p90_total_ms: 百分位(submitToDeliveredDurations, 90),
      regenerate_count: orders.reduce((sum, order) => sum + Number(order.admin_regenerate_count || 0), 0)
    };

    const humanReview = {
      admin_approve_count: orders.reduce((sum, order) => sum + Number(order.admin_approve_count || 0), 0),
      initial_image_count: orders.reduce((sum, order) => sum + Number(order.ai_first_ready_count || 0), 0),
      total_human_review_image_count: orders.reduce((sum, order) => sum + Number(order.ai_total_ready_count || 0), 0)
    };
    humanReview.original_pass_rate = humanReview.initial_image_count
      ? 保留四位(humanReview.admin_approve_count / humanReview.initial_image_count)
      : 0;
    humanReview.remake_pass_rate = humanReview.total_human_review_image_count
      ? 保留四位(humanReview.admin_approve_count / humanReview.total_human_review_image_count)
      : 0;

    const effectiveCompletedOrders = orders.filter(order => !!order.delivered_at && (!!order.viewed_at || !!order.downloaded_at));
    const investorSummary = {
      date_range_label: `${startDate || '全部'} 至 ${endDate || '今天'}`,
      submit_count: orders.length,
      delivered_count: deliveredOrders.length,
      effective_completed_count: effectiveCompletedOrders.length,
      downloaded_count: downloadedOrders.length,
      delivery_rate: orders.length ? 保留四位(deliveredOrders.length / orders.length) : 0,
      effective_completion_rate: orders.length ? 保留四位(effectiveCompletedOrders.length / orders.length) : 0,
      download_rate_by_submit: orders.length ? 保留四位(downloadedOrders.length / orders.length) : 0,
      review_pass_rate: serviceReviewPass.total.rate,
      avg_delivery_ms: overview.avg_delivery_ms,
      p90_delivery_ms: overview.p90_delivery_ms
    };

    const dates = 生成日期序列(startDate, endDate);
    const dailyMap = new Map(dates.map(date => [date, {
      date,
      service_selected_count: 0,
      service_next_count: 0,
      upload_page_view_count: 0,
      required_input_ready_count: 0,
      submit_clicked_count: 0,
      submit_count: 0,
      delivered_count: 0,
      viewed_count: 0,
      downloaded_count: 0,
      audit_rejected_count: 0,
      avg_delivery_ms: 0
    }]));

    dailyAppEventRows.forEach(row => {
      const item = dailyMap.get(row.date_key);
      if (!item) return;
      const count = Number(row.count || 0);
      if (row.event_name === 'service_selected') item.service_selected_count += count;
      if (row.event_name === 'service_next_clicked') item.service_next_count += count;
      if (row.event_name === 'upload_page_view') item.upload_page_view_count += count;
      if (row.event_name === 'required_input_ready') item.required_input_ready_count += count;
      if (row.event_name === 'submit_clicked') item.submit_clicked_count += count;
    });

    const dailyDeliveryDurations = new Map(dates.map(date => [date, []]));
    orders.forEach(order => {
      const date = 日期键(order.created_at);
      const item = dailyMap.get(date);
      if (!item) return;
      item.submit_count += 1;
      if (order.delivered_at) item.delivered_count += 1;
      if (order.viewed_at || order.downloaded_at) item.viewed_count += 1;
      if (order.downloaded_at) item.downloaded_count += 1;
      if (order.status === 'audit_rejected' || order.content_review_status === 'rejected') item.audit_rejected_count += 1;
      const duration = 计算时长毫秒(order.created_at, order.delivered_at);
      if (Number.isFinite(duration)) dailyDeliveryDurations.get(date).push(duration);
    });

    const trendSeries = {
      daily: Array.from(dailyMap.values()).map(item => Object.assign(item, {
        delivery_rate: item.submit_count ? 保留四位(item.delivered_count / item.submit_count) : 0,
        download_rate: item.submit_count ? 保留四位(item.downloaded_count / item.submit_count) : 0,
        avg_delivery_ms: 平均值(dailyDeliveryDurations.get(item.date) || [])
      })),
      granularity: 'day',
      tip: '按天聚合，不精确到分钟。提交、交付、查收、下载按订单创建日期归属，用于投资人展示同一批订单的转化表现。'
    };

    const activeDeviceSet = new Set(activeMiniappDeviceRows.map(row => row.device_uuid).filter(Boolean));
    const firstSeenMap = new Map(allMiniappDeviceRows.map(row => [row.device_uuid, row.first_seen]));
    const newDeviceSet = new Set(Array.from(activeDeviceSet).filter(device => {
      const firstSeen = firstSeenMap.get(device);
      if (!firstSeen) return false;
      const date = 日期键(firstSeen);
      return (!startDate || date >= startDate) && (!endDate || date <= endDate);
    }));
    const submittedDeviceSet = new Set(orders.map(order => order.device_uuid).filter(Boolean));
    const downloadedDeviceSet = new Set(downloadedOrders.map(order => order.device_uuid).filter(Boolean));
    const deliveredDeviceSet = new Set(deliveredOrders.map(order => order.device_uuid).filter(Boolean));
    const viewedNoDownloadDeviceSet = new Set(orders
      .filter(order => !!order.viewed_at && !order.downloaded_at && !!order.device_uuid)
      .map(order => order.device_uuid));
    const requiredReadyDeviceRows = db.prepare(`
      SELECT DISTINCT device_uuid
      FROM app_events
      WHERE event_name = 'required_input_ready'
        AND platform = 'miniapp'
        AND COALESCE(device_uuid, '') <> ''
        AND ${appEventRange.clause}
    `).all(...appEventRange.params);
    const highIntentNoSubmitDeviceSet = new Set(requiredReadyDeviceRows
      .map(row => row.device_uuid)
      .filter(device => device && !submittedDeviceSet.has(device)));

    const latestProfileByDevice = new Map();
    miniappDeviceProfileRows.forEach(row => {
      if (!activeDeviceSet.has(row.device_uuid) || latestProfileByDevice.has(row.device_uuid)) return;
      latestProfileByDevice.set(row.device_uuid, 解析JSON(row.props_json, {}));
    });
    const devicePlatformMap = new Map();
    latestProfileByDevice.forEach(profile => {
      const label = 归一化设备平台(profile.device_platform || profile.platform || profile.device_os || profile.system);
      devicePlatformMap.set(label, Number(devicePlatformMap.get(label) || 0) + 1);
    });
    const unknownProfileCount = Math.max(0, activeDeviceSet.size - Array.from(devicePlatformMap.values()).reduce((sum, count) => sum + count, 0));
    if (unknownProfileCount) devicePlatformMap.set('未知', Number(devicePlatformMap.get('未知') || 0) + unknownProfileCount);

    const servicePreferenceRows = targetServices.map(serviceType => ({
      service_type: serviceType,
      label: serviceType === 'hang_in_home' ? '作品挂进家' : '为空间推荐作品',
      count: 取应用事件数('service_selected', serviceType)
    }));
    const servicePreferenceTotal = servicePreferenceRows.reduce((sum, row) => sum + Number(row.count || 0), 0);

    const userPortrait = {
      active_device_count: activeDeviceSet.size,
      new_device_count: newDeviceSet.size,
      returning_device_count: Math.max(0, activeDeviceSet.size - newDeviceSet.size),
      submitted_device_count: submittedDeviceSet.size,
      delivered_device_count: deliveredDeviceSet.size,
      downloaded_device_count: downloadedDeviceSet.size,
      high_intent_no_submit_device_count: highIntentNoSubmitDeviceSet.size,
      viewed_no_download_device_count: viewedNoDownloadDeviceSet.size,
      device_platforms: 生成占比分布(devicePlatformMap).sort((a, b) => b.count - a.count),
      lifecycle_segments: 生成占比分布([
        { key: 'new', label: '新设备', count: newDeviceSet.size },
        { key: 'returning', label: '回访设备', count: Math.max(0, activeDeviceSet.size - newDeviceSet.size) }
      ]),
      behavior_segments: 生成占比分布([
        { key: 'submitted', label: '已提交设备', count: submittedDeviceSet.size },
        { key: 'delivered', label: '已交付设备', count: deliveredDeviceSet.size },
        { key: 'downloaded', label: '已下载设备', count: downloadedDeviceSet.size },
        { key: 'high_intent_no_submit', label: '完成必填未提交设备', count: highIntentNoSubmitDeviceSet.size },
        { key: 'viewed_no_download', label: '查收未下载设备', count: viewedNoDownloadDeviceSet.size }
      ], 'count'),
      service_preferences: servicePreferenceRows.map(row => Object.assign({}, row, {
        ratio: servicePreferenceTotal ? 保留四位(Number(row.count || 0) / servicePreferenceTotal) : 0
      })),
      tip: '第一版无感行为画像，不采集头像、昵称、手机号等隐私信息。设备维度基于匿名 device_uuid 和小程序基础环境信息聚合。'
    };

    const 构建体验漏斗 = (serviceType = null, label = '总体') => {
      const matchedOrders = serviceType ? orders.filter(order => order.service_type === serviceType) : orders;
      const countByOrder = predicate => matchedOrders.filter(predicate).length;
      const serviceSelectedCount = 取应用事件数('service_selected', serviceType);
      const serviceNextCount = 取应用事件数('service_next_clicked', serviceType);
      const uploadBranch = 规范化上传页分支(取上传页分支(serviceType));
      const servicePathConversion = serviceNextCount > 0
        ? 保留四位(uploadBranch.service_path_count / serviceNextCount)
        : 0;
      const servicePathLoss = serviceNextCount > 0
        ? Math.max(0, serviceNextCount - uploadBranch.service_path_count)
        : 0;

      const steps = [
        漏斗步骤(
          'service_selected',
          '服务点击',
          serviceSelectedCount,
          0,
          '来源：app_events.service_selected。用户在首页点击某个服务卡片或服务按钮，是服务路径的意向起点。'
        ),
        漏斗步骤(
          'service_next_clicked',
          '确认进入上传',
          serviceNextCount,
          serviceSelectedCount,
          '来源：app_events.service_next_clicked。用户选定服务后点击下一步，准备进入上传页。该环节可以区分“只点了服务但没有继续”的流失。'
        ),
        漏斗步骤(
          'upload_page_view',
          '进入上传页',
          uploadBranch.total_count,
          serviceNextCount,
          '来源：app_events.upload_page_view。该层包含两条并列分支：一是用户从服务路径点击下一步后进入上传页；二是用户扫小程序页面码/作品码后直接进入上传页。扫码直达没有上一环节，因此不拿总进入上传页数量直接除以前面的服务路径数量。',
          {
            conversion_rate: servicePathConversion,
            loss_count: servicePathLoss,
            loss_rate: serviceNextCount > 0 ? 保留四位(servicePathLoss / serviceNextCount) : 0,
            conversion_label: serviceNextCount > 0 ? `服务路径 ${(uploadBranch.service_path_count / serviceNextCount * 100).toFixed(1)}%` : '—',
            loss_label: serviceNextCount > 0 ? `服务路径流失 ${servicePathLoss}` : '—',
            branches: [
              {
                key: 'service_path',
                label: '服务路径进入',
                count: uploadBranch.service_path_count,
                base_count: serviceNextCount,
                conversion_rate: servicePathConversion,
                has_previous: true
              },
              {
                key: 'scan_direct',
                label: '扫码直达上传页',
                count: uploadBranch.scan_direct_count,
                base_count: 0,
                conversion_rate: null,
                has_previous: false
              }
            ],
            excluded_upload_scan_button_reentry_count: uploadBranch.upload_scan_button_reentry_count,
            raw_upload_page_view_count: uploadBranch.raw_upload_page_view_count
          }
        )
      ];

      let previousCount = uploadBranch.total_count;
      [
        { key: 'required_input_ready', label: '完成必填输入', count: 取应用事件数('required_input_ready', serviceType), tip: '来源：app_events.required_input_ready。客户端首次检测到当前服务提交所需的作品、空间图等必填信息已经齐备。上一环节分母使用进入上传页这一层的合计，包含服务路径进入和扫码直达进入。' },
        { key: 'submit_clicked', label: '点击提交', count: 取应用事件数('submit_clicked', serviceType), tip: '来源：app_events.submit_clicked。用户在客户端必填项已满足后点击提交按钮；未满足必填项的点击会进入“提交前校验拦截”诊断项，不计入这一层。' },
        { key: 'submit_success', label: '提交成功', count: matchedOrders.length, tip: '来源：orders。统计 created_at 落在筛选日期内且成功创建的订单。' },
        { key: 'waiting_view', label: '进入等待页', count: 取应用事件数('waiting_view', serviceType), tip: '来源：app_events.waiting_view。提交后用户看到了等待处理页面或等待面板。' },
        { key: 'delivered', label: '完成交付', count: countByOrder(order => !!order.delivered_at), tip: '来源：orders.delivered_at。订单已经交付给用户。' },
        { key: 'result_view', label: '查收结果', count: countByOrder(order => !!order.viewed_at || !!order.downloaded_at), tip: '来源：orders.viewed_at / downloaded_at。用户打开结果页，或虽未写 viewed_at 但已下载。' },
        { key: 'image_download', label: '下载结果图', count: countByOrder(order => !!order.downloaded_at), tip: '来源：orders.downloaded_at。用户下载过交付结果图。' }
      ].forEach(step => {
        steps.push(漏斗步骤(step.key, step.label, step.count, previousCount, step.tip));
        previousCount = step.count;
      });

      return { service_type: serviceType || 'all', service_label: label, steps };
    };

    const miniappEntryMethodLabels = {
      miniapp_page_code: '扫小程序页面码',
      miniapp_qr_code: '扫小程序普通二维码',
      wechat_share: '通过微信分享进入'
    };
    const miniappEntryTotal = Object.keys(miniappEntryMethodLabels)
      .reduce((sum, method) => sum + Number(miniappEntryMap.get(method) || 0), 0);
    const miniappEntryMethods = Object.keys(miniappEntryMethodLabels).map(method => ({
      method,
      method_label: miniappEntryMethodLabels[method],
      count: Number(miniappEntryMap.get(method) || 0),
      ratio: miniappEntryTotal > 0 ? 保留四位(Number(miniappEntryMap.get(method) || 0) / miniappEntryTotal) : 0,
      tip: method === 'miniapp_page_code'
        ? '来源：app_events.miniapp_entry。由小程序启动参数 scene=1047/1048/1049 归类，表示扫码、长按识别或从相册识别小程序页面码进入。'
        : method === 'miniapp_qr_code'
          ? '来源：app_events.miniapp_entry。由小程序启动参数 scene=1011/1012/1013 归类，表示扫码、长按识别或从相册识别普通二维码进入。'
          : '来源：app_events.miniapp_entry。由小程序启动参数 scene=1007/1008/1044 归类，表示通过微信单聊、群聊分享或带 shareTicket 的群分享进入。'
    }));

    const experienceFunnel = {
      total: 构建体验漏斗(null, '总体'),
      services: targetServices.map(serviceType => 构建体验漏斗(serviceType, serviceType === 'hang_in_home' ? '作品挂进家' : '为空间推荐作品')),
      miniapp_entry_methods: miniappEntryMethods,
      miniapp_entry_total: miniappEntryTotal,
      diagnostics: [
        { key: 'image_choose_cancel', label: '选择图片取消', count: 取应用事件数('image_choose_cancel'), tip: '来源：app_events.image_choose_cancel。用户打开图片选择器后取消。' },
        { key: 'image_choose_failed', label: '选择图片失败', count: 取应用事件数('image_choose_failed'), tip: '来源：app_events.image_choose_failed。图片过大或选择图片失败。' },
        { key: 'service_next_blocked', label: '下一步被拦截', count: 取应用事件数('service_next_blocked'), tip: '来源：app_events.service_next_blocked。用户点击下一步但尚未选定服务。' },
        { key: 'image_upload_failed', label: '图片上传失败', count: 取应用事件数('image_upload_failed'), tip: '来源：app_events.image_upload_failed。客户端向服务端上传图片失败。' },
        { key: 'submit_blocked_validation', label: '提交前校验拦截', count: 取应用事件数('submit_blocked_validation'), tip: '来源：app_events.submit_blocked_validation。用户点击提交，但客户端发现必填项未完成。' },
        { key: 'submit_failed_client', label: '客户端提交失败', count: 取应用事件数('submit_failed_client'), tip: '来源：app_events.submit_failed_client。客户端发起提交后收到失败、异常或网络错误。' },
        { key: 'submit_failed', label: '服务端提交失败', count: 取应用事件数('submit_failed'), tip: '来源：app_events.submit_failed。服务端校验、输入图审核或服务器异常导致提交失败。' },
        { key: 'subscribe_rejected', label: '通知订阅拒绝', count: 取应用事件数('subscribe_rejected'), tip: '来源：app_events.subscribe_rejected。用户拒绝小程序完成通知订阅。' }
      ]
    };

    res.json({
      filters: { start_date: startDate || null, end_date: endDate || null, exhibition_id: exhibitionId || 'all' },
      overview,
      services,
      service_review_pass: serviceReviewPass,
      artworks,
      artwork_selection_methods: artworkSelectionMethods,
      artwork_selection_total: artworkSelectionTotal,
      operations,
      human_review: humanReview,
      investor_summary: investorSummary,
      trend_series: trendSeries,
      user_portrait: userPortrait,
      experience_funnel: experienceFunnel
    });
  } catch (error) {
    console.error('analytics dashboard failed:', error);
    res.status(500).json({ error: error.message || '看板数据加载失败' });
  }
});

module.exports = router;
