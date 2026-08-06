// routes/client.js —— 用户端 API 路由
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const etaService = require('../services/eta');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const crypto = require('crypto');
const { clientUpload } = require('../middleware/upload');
const UPLOADS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');
const { 发送订单通知到目标机 } = require('../services/email');
const { submitImageRequest } = require('../services/aiImage');
const {
  mediaCheckAsync,
  imgSecCheck,
  contentReviewDecisionFromSuggest,
  isMediaDownloadError,
  normalizeMediaCheckCallback,
  summarizeMediaCheckCallback,
  sanitizeUrlForLog,
  truncateForLog
} = require('../services/wxContentSecurity');
const {
  publishContentReviewImage,
  describeContentReviewMediaConfig
} = require('../services/contentReviewMedia');
const {
  listArtworks,
  listArtworksLite,
  getArtworkById,
  findArtworkByCodeLike,
  findArtworkByScanToken,
  findArtworkByCodeInExhibition,
  findArtworkBySlugAndCode
} = require('../services/artworks');
const {
  LEGACY_EXHIBITION,
  listExhibitions,
  getExhibitionById,
  resolveClientExhibitionScope
} = require('../services/exhibitions');
const { recordAppEvent, recordOrderEvent } = require('../services/analytics');
const { getThumbnailBuffer, isAllowedThumbnailSource } = require('../services/thumbs');
const { resolveDeliveryImageUrls, enrichPublicDeliveryResultRecords } = require('../services/deliveryAssets');
const workerHub = require('../services/workerHub');
const autodl = require('../services/autodl');
const { parseArtworkSizeToMeters } = require('../services/artworkDimensions');
const { buildJobFromOrder } = require('../services/hangingJob');
const { buildOrderProgress } = require('../services/hangingProgressCopy');
const { buildThinking, resolveUserSupplementRenders, validateWallpaperOptIn, buildSupplementRenderJobsFromOrder } = require('../services/hangingThinking');
const { getWxMiniappCredentials, describeWxMiniappConfig } = require('../services/wxMiniappConfig');
const { buildPublicOrderFailure } = require('../services/orderFailurePublic');
const { buildWallPreferenceState, applyWallPreferenceState } = require('../services/wallPreferencePublic');
const { parsePaginationQuery } = require('../services/pagination');

const SERVER_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.SERVER_BASE_URL || process.env.APP_BASE_URL || 'https://www.molink.art').replace(/\/+$/, '');
const WX_MEDIA_CHECK_MAX_BYTES = 10 * 1024 * 1024;
const WX_MEDIA_CHECK_TARGET_BYTES = Math.floor(9.4 * 1024 * 1024);
const WX_IMAGE_SECURITY_MODE = String(process.env.WX_IMAGE_SECURITY_MODE || 'binary').trim().toLowerCase();
const WX_IMG_SEC_CHECK_MAX_BYTES = Math.max(64 * 1024, Math.min(1024 * 1024, Number(process.env.WX_IMG_SEC_CHECK_MAX_BYTES || 1024 * 1024) || 1024 * 1024));
const WX_IMG_SEC_CHECK_TARGET_BYTES = Math.max(64 * 1024, Math.min(WX_IMG_SEC_CHECK_MAX_BYTES - 16 * 1024, Number(process.env.WX_IMG_SEC_CHECK_TARGET_BYTES || 900 * 1024) || 900 * 1024));
const CONTENT_REVIEW_UPLOAD_DIRNAME = '_content_review';
const CONTENT_REVIEW_UPLOAD_DIR = path.join(UPLOADS_DIR, CONTENT_REVIEW_UPLOAD_DIRNAME);
const WX_MESSAGE_TOKEN = String(process.env.WX_MESSAGE_TOKEN || process.env.WECHAT_MESSAGE_TOKEN || '').trim();
const WX_MESSAGE_AES_KEY = String(process.env.WX_MESSAGE_ENCODING_AES_KEY || process.env.WX_MESSAGE_AES_KEY || process.env.WECHAT_MESSAGE_AES_KEY || '').trim();
const WX_MESSAGE_VERIFY_STRICT = String(process.env.WX_MESSAGE_VERIFY_STRICT || '') === '1';
const CONTENT_REVIEW_TIMEOUT_MINUTES = Math.max(30, Number(process.env.CONTENT_REVIEW_TIMEOUT_MINUTES || 35) || 35);
const CONTENT_REVIEW_DOWNLOAD_RETRY_RAW = Number(process.env.CONTENT_REVIEW_DOWNLOAD_RETRY_MAX);
const CONTENT_REVIEW_DOWNLOAD_RETRY_MAX = Math.max(0, Math.min(3, Number.isFinite(CONTENT_REVIEW_DOWNLOAD_RETRY_RAW) ? CONTENT_REVIEW_DOWNLOAD_RETRY_RAW : 1));
const CONTENT_SECURITY_LOG_RAW = String(process.env.CONTENT_SECURITY_LOG_RAW || '') === '1';
fs.mkdirSync(CONTENT_REVIEW_UPLOAD_DIR, { recursive: true });
// 挂画引擎开关：默认开启，置 0 可全量回退 MMW 链路
const HANGING_ENGINE_ENABLED = process.env.HANGING_ENGINE_ENABLED !== '0';


// 服务类型中文映射
const 服务类型映射 = {
  'hang_in_home': '作品挂进家',
  'recommend_work': '根据空间推荐作品',
  'recommend_space': '根据作品推荐空间'
};

const 历史记录状态 = ['delivered', 'viewed', 'downloaded'];
const 人工推荐等待状态 = 'awaiting_manual_recommendation';
const 挂画处理中状态 = ['hanging_queued', 'hanging_geometry', 'hanging_rendering', 'hanging_queued_offline'];
const 挂画需人工状态 = ['hanging_partial_review', 'hanging_render_review', 'hanging_no_safe_wall', 'hanging_failed'];

function 映射客户端订单状态(status) {
  if (status === 'audit_rejected') return 'audit_rejected';
  if (status === 'audit_timeout') return 'audit_timeout';
  if (status === 'content_reviewing') return 'content_reviewing';
  if (status === 人工推荐等待状态) return 'pending';
  if (挂画处理中状态.includes(status)) return 'pending';
  if (挂画需人工状态.includes(status)) return 'failed';
  if (status === 'failed') return 'failed';
  return status;
}

function 读取作品列表() {
  return listArtworks({ status: 'published' });
}

function 构建完整图片地址(filePath) {
  if (!filePath) return '';
  if (filePath.startsWith('http')) return filePath;
  return `${SERVER_BASE_URL}${filePath.startsWith('/') ? '' : '/'}${filePath}`;
}

function 解析交付图片(order) {
  let images = [];
  try {
    images = JSON.parse(order.delivery_images || '[]');
  } catch (e) {}
  return images;
}

function 记录订单埋点({ orderId, exhibitionId = null, deviceUuid = null, eventType, imageIndex = null, imageUrl = null, pageName = null, stayMs = null, enteredAt = null, leftAt = null, payload = null, actorType = 'user', actorId = null, platform = 'client', serviceType = null, eventResult = null, artworkId = null, artworkCode = null }) {
  if (!orderId || !eventType) return;
  recordOrderEvent({
    orderId,
    exhibitionId,
    deviceUuid,
    eventType,
    imageIndex,
    imageUrl,
    pageName,
    stayMs,
    enteredAt,
    leftAt,
    payload,
    actorType,
    actorId,
    platform,
    serviceType,
    eventResult,
    artworkId,
    artworkCode
  });
}

function 记录应用埋点({ sessionId = null, deviceUuid = null, openid = null, orderId = null, exhibitionId = null, eventName, pageName = null, platform = 'client', serviceType = null, entrySource = null, artworkId = null, artworkCode = null, props = null }) {
  if (!eventName) return;
  recordAppEvent({
    sessionId,
    deviceUuid,
    openid,
    orderId,
    exhibitionId,
    eventName,
    pageName,
    platform,
    serviceType,
    entrySource,
    artworkId,
    artworkCode,
    props
  });
}

function 绑定微信号与设备(openid, deviceUuid) {
  const normalizedOpenid = String(openid || '').trim();
  const normalizedDeviceUuid = String(deviceUuid || '').trim();
  if (!normalizedOpenid || !normalizedDeviceUuid) return;

  db.prepare(`
    INSERT INTO user_devices (openid, device_uuid, first_seen, last_seen)
    VALUES (?, ?, datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(openid, device_uuid) DO UPDATE SET
      last_seen = datetime('now','localtime')
  `).run(normalizedOpenid, normalizedDeviceUuid);
}

function 构建身份查询条件(deviceUuid, openid, historyOnly) {
  const conditions = [];
  const params = [];
  const normalizedOpenid = String(openid || '').trim();
  const normalizedDeviceUuid = String(deviceUuid || '').trim();

  if (normalizedOpenid) {
    conditions.push(`(
      openid = ?
      OR device_uuid IN (
        SELECT device_uuid FROM user_devices WHERE openid = ?
      )
    )`);
    params.push(normalizedOpenid, normalizedOpenid);
  } else {
    conditions.push('device_uuid = ?');
    params.push(normalizedDeviceUuid);
  }

  if (historyOnly) {
    conditions.push(`status IN (${历史记录状态.map(() => '?').join(',')})`);
    params.push(...历史记录状态);
  }

  return { whereClause: conditions.join(' AND '), params };
}

function 匹配作品(code) {
  return findArtworkByCodeLike(code);
}

function 读取请求展览Id(req) {
  return String((req && req.query && req.query.exhibition_id) || (req && req.body && req.body.exhibition_id) || '').trim();
}

function 解析作品请求(query = {}) {
  const token = String(query.token || query.t || '').trim();
  if (token) return findArtworkByScanToken(token);

  const slug = String(query.e || query.exhibition_slug || '').trim();
  const slugCode = String(query.c || '').trim();
  if (slug && slugCode) return findArtworkBySlugAndCode(slug, slugCode);

  const artworkId = String(query.artwork_id || query.id || '').trim();
  if (artworkId) {
    const byId = getArtworkById(artworkId);
    if (byId) return byId;
  }

  const code = String(
    query.code || query.artwork_code || query.artworkCode || query.num || query.artwork_num || query.artworkRef || query.artwork_ref || ''
  ).trim();
  if (!code) return null;
  const requestedExhibitionId = String(query.exhibition_id || '').trim();
  return findArtworkByCodeInExhibition(code, requestedExhibitionId || LEGACY_EXHIBITION.id);
}

function 作品展览响应字段(artwork) {
  if (!artwork) return {};
  return {
    exhibition_id: artwork.exhibition_id || '',
    exhibition_name: artwork.exhibition_name || '',
    exhibition_status: artwork.exhibition_status || '',
    collection_advisor_name: artwork.exhibition_collection_advisor_name || '',
    collection_advisor_wechat: artwork.exhibition_collection_advisor_wechat || '',
    can_order: artwork.exhibition_status !== 'archived',
    order_disabled_message: artwork.exhibition_status === 'archived' ? '该展览已结束，暂不支持在线下单' : ''
  };
}

function 内容安全结果数组(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function 内容安全结构化日志(level, event, payload = {}) {
  const logger = console[level] || console.log;
  logger.call(console, `[content-security] ${truncateForLog({ event, ...payload })}`);
}

function 内容安全任务摘要(item = {}) {
  const callback = item.callback || {};
  return {
    trace_id: String(item.trace_id || callback.trace_id || ''),
    field: item.field || '',
    label: item.label || '',
    media_url: sanitizeUrlForLog(item.media_url || ''),
    original_size: Number(item.original_size || 0),
    audit_size: Number(item.audit_size || 0),
    callback_received: Boolean(item.callback),
    errcode: Number(callback.errcode || 0),
    errmsg: callback.errmsg || '',
    suggest: callback.suggest || '',
    result_label: Number(callback.label || 0),
    decision: callback.decision || contentReviewDecisionFromSuggest(callback.suggest, callback.errcode),
    active: item.active !== false,
    retry_attempt: Number(item.retry_attempt || 0),
    retry_of_trace_id: String(item.retry_of_trace_id || ''),
    media_storage: item.media_storage || '',
    media_key: item.media_key || '',
    public_preflight_ok: item.public_preflight ? item.public_preflight.ok : null,
    review_transport: item.review_transport || '',
    review_provider: item.review_provider || ''
  };
}

function 内容安全审核异常文案(callback = {}) {
  const errcode = Number(callback.errcode || 0);
  const errmsg = String(callback.errmsg || '').trim();
  if (errcode) return `微信内容安全审核执行异常（${errcode}${errmsg ? `：${errmsg}` : ''}）`;
  return errmsg || '微信内容安全审核暂时异常';
}

function 构建上传图片Url(relativePath) {
  const value = String(relativePath || '').trim().replace(/^\/+/, '');
  return `${SERVER_BASE_URL}/uploads/${encodeURIComponent(value).replace(/%2F/g, '/')}`;
}

function 获取本地上传文件路径(filename) {
  const value = String(filename || '').trim();
  if (!value || value.startsWith('http://') || value.startsWith('https://')) return null;
  const safeRelative = value.replace(/^\/+/, '');
  const resolved = path.resolve(UPLOADS_DIR, safeRelative);
  const uploadRoot = path.resolve(UPLOADS_DIR);
  if (resolved !== uploadRoot && !resolved.startsWith(`${uploadRoot}${path.sep}`)) return null;
  return { relative: safeRelative, absolute: resolved };
}

async function 获取文件大小(filepath) {
  try {
    const stat = await fs.promises.stat(filepath);
    return Number(stat && stat.size) || 0;
  } catch (error) {
    return 0;
  }
}

async function 生成微信审核压缩图(filename, field, { maxBytes = WX_MEDIA_CHECK_MAX_BYTES, targetBytes = WX_MEDIA_CHECK_TARGET_BYTES, profile = 'async_url' } = {}) {
  const local = 获取本地上传文件路径(filename);
  if (!local) return null;

  const sourceSize = await 获取文件大小(local.absolute);
  if (!sourceSize) {
    throw new Error(`微信内容安全审核源图不存在：${filename}`);
  }

  const parsed = path.parse(local.relative);
  const safeProfile = String(profile || 'review').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 32);
  const targetBasename = `${parsed.name}_${field || 'image'}_wxcheck_${safeProfile}.jpg`;
  const targetRelative = `${CONTENT_REVIEW_UPLOAD_DIRNAME}/${targetBasename}`;
  const targetAbsolute = path.join(CONTENT_REVIEW_UPLOAD_DIR, targetBasename);
  const existingSize = await 获取文件大小(targetAbsolute);

  if (existingSize > 0 && existingSize <= targetBytes) {
    内容安全结构化日志('log', 'audit_image.reused', {
      field: field || 'image',
      source_filename: local.relative,
      audit_filename: targetRelative,
      original_size: sourceSize,
      audit_size: existingSize
    });
    return {
      audit_filename: targetRelative,
      audit_media_url: 构建上传图片Url(targetRelative),
      audit_size: existingSize,
      original_size: sourceSize,
      compressed: true,
      reused: true
    };
  }

  const dimensionPlans = [2560, 2200, 1800, 1400, 1200, 960];
  const qualityPlans = [86, 78, 70, 62, 54, 46];
  let lastError = null;

  for (const maxDimension of dimensionPlans) {
    for (const quality of qualityPlans) {
      try {
        await sharp(local.absolute, { animated: false, limitInputPixels: false })
          .rotate()
          .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality, mozjpeg: true })
          .toFile(targetAbsolute);

        const auditSize = await 获取文件大小(targetAbsolute);
        if (auditSize > 0 && auditSize <= targetBytes) {
          if (auditSize > targetBytes) {
            内容安全结构化日志('warn', 'audit_image.near_limit', {
              field: field || 'image',
              source_filename: local.relative,
              audit_filename: targetRelative,
              original_size: sourceSize,
              audit_size: auditSize,
              max_bytes: maxBytes
            });
          }
          内容安全结构化日志('log', 'audit_image.generated', {
            field: field || 'image',
            source_filename: local.relative,
            audit_filename: targetRelative,
            original_size: sourceSize,
            audit_size: auditSize,
            max_dimension: maxDimension,
            quality
          });
          return {
            audit_filename: targetRelative,
            audit_media_url: 构建上传图片Url(targetRelative),
            audit_size: auditSize,
            original_size: sourceSize,
            compressed: true,
            max_dimension: maxDimension,
            quality
          };
        }
        lastError = new Error(`审核压缩图仍超过目标限制：${auditSize} bytes（target=${targetBytes}）`);
      } catch (error) {
        lastError = error;
      }
    }
  }

  try { await fs.promises.unlink(targetAbsolute); } catch (error) {}
  内容安全结构化日志('error', 'audit_image.failed', {
    field: field || 'image',
    source_filename: local.relative,
    audit_filename: targetRelative,
    original_size: sourceSize,
    message: lastError && lastError.message ? lastError.message : 'unknown'
  });
  throw new Error(`无法生成符合微信审核限制的压缩图：${filename}${lastError ? `；${lastError.message}` : ''}`);
}

async function 构建内容安全任务(order, { retryAttempt = 0, onlyField = '' } = {}) {
  const tasks = [];
  const binaryTransport = WX_IMAGE_SECURITY_MODE !== 'async_url';
  const addLocalImage = async (field, filename, label) => {
    if (onlyField && field !== onlyField) return;
    const value = String(filename || '').trim();
    if (!value || value.startsWith('http://') || value.startsWith('https://')) return;
    const audit = await 生成微信审核压缩图(value, field, binaryTransport ? {
      maxBytes: WX_IMG_SEC_CHECK_MAX_BYTES,
      targetBytes: WX_IMG_SEC_CHECK_TARGET_BYTES,
      profile: 'binary_sync'
    } : {
      maxBytes: WX_MEDIA_CHECK_MAX_BYTES,
      targetBytes: WX_MEDIA_CHECK_TARGET_BYTES,
      profile: 'async_url'
    });
    if (!audit) return;

    const auditLocal = 获取本地上传文件路径(audit.audit_filename);
    if (!auditLocal) throw new Error(`微信审核压缩图路径无效：${audit.audit_filename}`);

    let published = {
      media_url: '',
      media_storage: 'local',
      media_key: '',
      media_size: audit.audit_size,
      media_sha256: '',
      public_preflight: { ok: null, skipped: true }
    };
    if (!binaryTransport) {
      published = await publishContentReviewImage({
        absolutePath: auditLocal.absolute,
        localUrl: audit.audit_media_url,
        orderId: order.id,
        field,
        attempt: retryAttempt,
        expectedBytes: audit.audit_size
      });
      内容安全结构化日志('log', 'audit_image.published', {
        order_id: order.id,
        field,
        storage: published.media_storage,
        media_url: sanitizeUrlForLog(published.media_url),
        media_key: published.media_key || '',
        audit_size: published.media_size,
        sha256: published.media_sha256,
        public_preflight: published.public_preflight
      });
    } else {
      内容安全结构化日志('log', 'audit_image.ready_for_binary_check', {
        order_id: order.id,
        field,
        audit_filename: audit.audit_filename,
        audit_size: audit.audit_size,
        max_bytes: WX_IMG_SEC_CHECK_MAX_BYTES,
        transport: 'multipart_binary'
      });
    }

    tasks.push({
      field,
      label,
      filename: value,
      original_media_url: 构建上传图片Url(value),
      audit_filename: audit.audit_filename,
      audit_size: audit.audit_size,
      original_size: audit.original_size,
      compressed_for_review: true,
      media_type: 2,
      media_url: published.media_url,
      media_storage: published.media_storage,
      media_key: published.media_key,
      media_sha256: published.media_sha256,
      public_preflight: published.public_preflight,
      review_transport: binaryTransport ? 'multipart_binary' : 'remote_url',
      review_provider: binaryTransport ? 'img_sec_check' : 'media_check_async',
      retry_attempt: Number(retryAttempt || 0),
      active: true
    });
  };

  await addLocalImage('artwork_image', order.artwork_image, '作品图');
  await addLocalImage('space_image', order.space_image, '空间图');

  return tasks;
}

function 内容安全拒绝文案(result) {
  const labelMap = {
    20001: '图片可能包含时政敏感内容',
    20002: '图片可能包含色情或低俗内容',
    20006: '图片可能包含违法违规内容',
    21000: '图片可能包含其他风险内容'
  };
  const normalized = result && result.raw
    ? normalizeMediaCheckCallback(result.raw)
    : normalizeMediaCheckCallback(result || {});
  const label = Number(result?.label || normalized.label || 0);
  return labelMap[label] || `图片未通过内容安全审核${label ? `（风险标签 ${label}）` : ''}`;
}

function 构建同步审核回调(result, traceId) {
  return {
    trace_id: traceId,
    callback_at: new Date().toISOString(),
    errcode: Number(result.errcode || 0),
    errmsg: result.errmsg || '',
    suggest: result.suggest || '',
    label: Number(result.label || 0),
    decision: result.decision || 'error',
    decision_source: result.decision_source || 'img_sec_check',
    detail: [],
    received_count: 1,
    raw: result.raw || {}
  };
}

async function 提交同步图片内容安全审核(order, tasks) {
  const completed = [];
  for (const task of tasks) {
    const local = 获取本地上传文件路径(task.audit_filename);
    if (!local) throw new Error(`同步图片审核文件路径无效：${task.audit_filename}`);
    const body = await fs.promises.readFile(local.absolute);
    if (!body.length) throw new Error(`同步图片审核文件为空：${task.audit_filename}`);
    if (body.length > WX_IMG_SEC_CHECK_MAX_BYTES) {
      throw new Error(`同步图片审核文件超过 1MB：${task.audit_filename} (${body.length} bytes)`);
    }

    内容安全结构化日志('log', 'review.task.submit_binary', {
      order_id: order.id,
      field: task.field,
      audit_filename: task.audit_filename,
      bytes: body.length,
      transport: 'multipart_binary'
    });
    const result = await imgSecCheck({
      imageBuffer: body,
      filename: path.basename(task.audit_filename),
      contentType: 'image/jpeg'
    });
    const traceId = `sync-${uuidv4()}`;
    const callback = 构建同步审核回调(result, traceId);
    const completedTask = {
      ...task,
      trace_id: traceId,
      submitted_at: new Date().toISOString(),
      callback,
      active: true
    };
    completed.push(completedTask);
    内容安全结构化日志(result.decision === 'reject' ? 'warn' : 'log', 'review.task.completed_binary', {
      order_id: order.id,
      field: task.field,
      trace_id: traceId,
      errcode: result.errcode,
      errmsg: result.errmsg,
      decision: result.decision,
      transport: 'multipart_binary'
    });

    if (result.decision === 'reject') break;
  }

  const rejected = completed.find(item => item.callback && item.callback.decision === 'reject');
  if (rejected) {
    const reason = 内容安全拒绝文案(rejected.callback);
    db.prepare(`
      UPDATE orders SET
        status='audit_rejected',
        content_review_status='rejected',
        content_review_trace_ids_json=?,
        content_review_result_json=?,
        content_review_reject_reason=?,
        content_review_rejected_at=datetime('now','localtime'),
        content_review_completed_at=datetime('now','localtime'),
        ai_current_step=?
      WHERE id=?
    `).run(
      JSON.stringify(completed.map(item => item.trace_id)),
      JSON.stringify(completed),
      reason,
      reason,
      order.id
    );
    记录系统订单事件(order, 'content_review_rejected', {
      trace_id: rejected.trace_id,
      field: rejected.field || '',
      reason,
      errcode: Number(rejected.callback.errcode || 0),
      errmsg: rejected.callback.errmsg || '',
      provider: 'img_sec_check',
      transport: 'multipart_binary'
    }, 'fail');
    内容安全结构化日志('warn', 'review.rejected_binary', {
      order_id: order.id,
      field: rejected.field || '',
      reason,
      tasks: completed.map(内容安全任务摘要)
    });
    return { status: 'rejected', tasks: completed };
  }

  db.prepare(`
    UPDATE orders SET
      status='pending',
      content_review_status='passed',
      content_review_trace_ids_json=?,
      content_review_result_json=?,
      content_review_completed_at=datetime('now','localtime'),
      ai_current_step='图片分析完成，正在继续处理'
    WHERE id=?
  `).run(
    JSON.stringify(completed.map(item => item.trace_id)),
    JSON.stringify(completed),
    order.id
  );
  记录系统订单事件(order, 'content_review_passed', {
    trace_ids: completed.map(item => item.trace_id),
    provider: 'img_sec_check',
    transport: 'multipart_binary',
    tasks: completed.map(内容安全任务摘要)
  }, 'success');
  内容安全结构化日志('log', 'review.passed_binary', {
    order_id: order.id,
    task_count: completed.length,
    tasks: completed.map(内容安全任务摘要)
  });
  return { status: 'passed', tasks: completed };
}

async function 提交订单内容安全审核(order) {
  const openid = String(order.openid || '').trim();
  const tasks = await 构建内容安全任务(order);
  内容安全结构化日志('log', 'review.prepare', {
    order_id: order.id,
    service_type: order.service_type || '',
    openid_present: Boolean(openid),
    task_count: tasks.length,
    server_base_url: SERVER_BASE_URL,
    tasks: tasks.map(内容安全任务摘要)
  });

  if (!tasks.length) {
    内容安全结构化日志('warn', 'review.skipped', {
      order_id: order.id,
      reason: 'no_local_image_tasks',
      artwork_image: order.artwork_image || '',
      space_image: order.space_image || ''
    });
    db.prepare(`UPDATE orders SET content_review_status='not_required', content_review_completed_at=datetime('now','localtime') WHERE id=?`).run(order.id);
    return { status: 'not_required', tasks: [] };
  }

  if (WX_IMAGE_SECURITY_MODE !== 'async_url') {
    return 提交同步图片内容安全审核(order, tasks);
  }

  if (!openid) {
    内容安全结构化日志('warn', 'review.skipped', {
      order_id: order.id,
      reason: 'missing_openid',
      message: 'mediaCheckAsync requires a recent miniapp openid',
      tasks: tasks.map(内容安全任务摘要)
    });
    db.prepare(`UPDATE orders SET content_review_status='skipped', content_review_completed_at=datetime('now','localtime'), content_review_result_json=? WHERE id=?`)
      .run(JSON.stringify([{ skipped: true, reason: 'missing_openid', tasks }]), order.id);
    return { status: 'skipped', tasks };
  }

  const submitted = [];
  for (const task of tasks) {
    内容安全结构化日志('log', 'review.task.submit', {
      order_id: order.id,
      ...内容安全任务摘要(task)
    });
    const result = await mediaCheckAsync({
      mediaUrl: task.media_url,
      openid,
      mediaType: task.media_type,
      scene: 1
    });
    内容安全结构化日志('log', 'review.task.submitted', {
      order_id: order.id,
      field: task.field,
      trace_id: result.trace_id,
      errcode: result.errcode,
      errmsg: result.errmsg
    });
    submitted.push({
      ...task,
      trace_id: result.trace_id,
      errcode: result.errcode,
      errmsg: result.errmsg,
      submitted_at: new Date().toISOString()
    });
  }

  db.prepare(`
    UPDATE orders SET
      status='content_reviewing',
      content_review_status='checking',
      content_review_trace_ids_json=?,
      content_review_result_json=?,
      ai_current_step='已收到图片，正在分析您的空间…'
    WHERE id=?
  `).run(
    JSON.stringify(submitted.map(item => item.trace_id)),
    JSON.stringify(submitted),
    order.id
  );
  return { status: 'checking', tasks: submitted };
}

async function 重试微信内容安全下载失败(order, failedItem, merged) {
  const callback = failedItem && failedItem.callback ? failedItem.callback : {};
  if (!isMediaDownloadError(callback.errcode, callback.errmsg)) return null;

  const currentAttempt = Number(failedItem.retry_attempt || 0);
  if (currentAttempt >= CONTENT_REVIEW_DOWNLOAD_RETRY_MAX) {
    内容安全结构化日志('error', 'review.download_retry_exhausted', {
      order_id: order.id,
      trace_id: failedItem.trace_id || '',
      field: failedItem.field || '',
      retry_attempt: currentAttempt,
      retry_max: CONTENT_REVIEW_DOWNLOAD_RETRY_MAX,
      callback: 内容安全任务摘要(failedItem)
    });
    return null;
  }

  const nextAttempt = currentAttempt + 1;
  try {
    const retryTasks = await 构建内容安全任务(order, {
      retryAttempt: nextAttempt,
      onlyField: failedItem.field || ''
    });
    const retryTask = retryTasks[0];
    if (!retryTask) throw new Error(`无法重建审核任务：${failedItem.field || 'unknown'}`);

    内容安全结构化日志('warn', 'review.download_retry_submit', {
      order_id: order.id,
      previous_trace_id: failedItem.trace_id || '',
      field: failedItem.field || '',
      retry_attempt: nextAttempt,
      media_url: sanitizeUrlForLog(retryTask.media_url),
      media_storage: retryTask.media_storage || '',
      public_preflight: retryTask.public_preflight || null
    });

    const result = await mediaCheckAsync({
      mediaUrl: retryTask.media_url,
      openid: String(order.openid || '').trim(),
      mediaType: retryTask.media_type,
      scene: 1
    });

    const replacement = {
      ...retryTask,
      trace_id: result.trace_id,
      errcode: result.errcode,
      errmsg: result.errmsg,
      submitted_at: new Date().toISOString(),
      retry_of_trace_id: String(failedItem.trace_id || ''),
      active: true
    };
    const updated = merged.map(item => String(item.trace_id || '') === String(failedItem.trace_id || '')
      ? { ...item, active: false, superseded_by_trace_id: result.trace_id }
      : item);
    updated.push(replacement);
    const activeTraceIds = updated
      .filter(item => item.active !== false)
      .map(item => String(item.trace_id || ''))
      .filter(Boolean);

    db.prepare(`
      UPDATE orders SET
        status='content_reviewing',
        content_review_status='checking',
        content_review_trace_ids_json=?,
        content_review_result_json=?,
        ai_current_step='审核图片已切换持久化地址，正在重新检查'
      WHERE id=?
    `).run(JSON.stringify(activeTraceIds), JSON.stringify(updated), order.id);

    记录系统订单事件(order, 'content_review_download_retried', {
      previous_trace_id: failedItem.trace_id || '',
      trace_id: result.trace_id,
      field: failedItem.field || '',
      retry_attempt: nextAttempt,
      media_storage: replacement.media_storage || '',
      media_url: sanitizeUrlForLog(replacement.media_url)
    }, 'success');
    内容安全结构化日志('warn', 'review.download_retry_submitted', {
      order_id: order.id,
      previous_trace_id: failedItem.trace_id || '',
      trace_id: result.trace_id,
      field: failedItem.field || '',
      retry_attempt: nextAttempt,
      media_storage: replacement.media_storage || '',
      media_url: sanitizeUrlForLog(replacement.media_url),
      tasks: updated.map(内容安全任务摘要)
    });
    return { ok: true, orderId: order.id, status: 'retrying', traceId: result.trace_id };
  } catch (error) {
    内容安全结构化日志('error', 'review.download_retry_failed', {
      order_id: order.id,
      previous_trace_id: failedItem.trace_id || '',
      field: failedItem.field || '',
      retry_attempt: nextAttempt,
      message: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : '',
      preflight: error && error.preflight ? error.preflight : null,
      stack: error && error.stack ? error.stack : ''
    });
    return null;
  }
}

function 记录系统订单事件(order, eventType, payload = {}, result = 'success') {
  if (!order || !order.id || !eventType) return;
  记录订单埋点({
    orderId: order.id,
    deviceUuid: order.device_uuid || null,
    eventType,
    pageName: 'submit',
    platform: order.entry_platform || (order.openid ? 'miniapp' : 'web'),
    serviceType: order.service_type,
    actorType: 'system',
    eventResult: result,
    artworkId: order.artwork_id || null,
    artworkCode: order.artwork_code || null,
    payload
  });
}

async function 启动订单后续处理(orderId, trigger = 'content_review_pass') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return;
  if (order.status === 'audit_rejected') return;
  if (order.status === 'ai_generating' || order.status === 'ai_ready' || order.status === 'delivered') return;
  if (order.status === 人工推荐等待状态 && order.service_type === 'recommend_work') return;

  if (order.service_type === 'recommend_work') {
    db.prepare("UPDATE orders SET status = ?, ai_current_step = ? WHERE id = ?")
      .run(人工推荐等待状态, '图片分析完成，等待人工推荐作品', order.id);
    记录系统订单事件(order, 'manual_recommendation_queued', { step: 'awaiting_manual_recommendation', trigger });
    console.log(`🪄 已进入人工推荐队列: 订单=${order.id}`);
    return;
  }

  if (HANGING_ENGINE_ENABLED && order.service_type === 'hang_in_home') {
    const dim = parseArtworkSizeToMeters(order.artwork_size || '');
    if (dim) {
      try {
        const hangingJobId = `job_${order.id}`;
        const freshOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
        const jobPayload = buildJobFromOrder({ ...freshOrder, hanging_job_id: hangingJobId });
        db.prepare(`UPDATE orders SET ai_engine='hanging', status='hanging_queued',
          hanging_job_id=?, hanging_submitted_at=datetime('now','localtime'),
          ai_current_step='已收到委托，正在分析您的空间…' WHERE id=?`).run(hangingJobId, order.id);
        workerHub.enqueueJob(jobPayload);
        autodl.selectAndStartInstance(workerHub)
          .then(r => console.log(`[autodl] selectAndStart →`, r))
          .catch(err => console.warn('[autodl] start failed:', err.message));
        记录系统订单事件(order, 'hanging_queued', { width_m: dim.width_m, height_m: dim.height_m, trigger });
        console.log(`🖼️ 已进入挂画引擎队列: 订单=${order.id} 尺寸=${dim.width_m}×${dim.height_m}m`);
        return;
      } catch (e) {
        console.error('❌ 挂画引擎入队失败，回退 MMW:', e.message);
        try {
          db.prepare(`UPDATE orders SET ai_engine='mmw', hanging_job_id=NULL,
            hanging_status='fallback_mmw' WHERE id=? AND status='hanging_queued'`).run(order.id);
        } catch (resetErr) {
          console.error('❌ ai_engine 重置失败:', resetErr.message);
        }
      }
    } else {
      console.log(`↩️ 订单=${order.id} 尺寸不可解析(${order.artwork_size || ''})，回退 MMW 链路`);
    }
  }

  try {
    const artworkFilename = order.artwork_image || '';
    const spaceFilename = order.space_image || '';
    const artworkUrl = artworkFilename
      ? (String(artworkFilename).startsWith('http') ? artworkFilename : `${SERVER_BASE_URL}/uploads/${artworkFilename}`)
      : null;
    const spaceUrl = spaceFilename ? (String(spaceFilename).startsWith('http') ? spaceFilename : `${SERVER_BASE_URL}/uploads/${spaceFilename}`) : null;
    const size = order.artwork_size || '';
    console.log(`🎨 生图参数 订单=${order.id} service=${order.service_type} artworkUrl=${artworkUrl} spaceUrl=${spaceUrl} size=${size}`);
    const userMessage = 构建生图消息(order.service_type, artworkUrl, spaceUrl, size, order.notes || '');
    db.prepare("UPDATE orders SET ai_user_message = ? WHERE id = ?").run(JSON.stringify(userMessage), order.id);
    const { currentProvider } = require('./services/aiImage');
    const engine = currentProvider() === 'apiyi' ? 'apiyi' : 'mmw';
    const executionIds = await submitImageRequest({ userMessage });
    db.prepare("UPDATE orders SET ai_engine = ?, ai_execution_id = ?, ai_execution_ids = ?, status = ?, ai_submitted_at = datetime('now','localtime'), ai_initial_image_count = CASE WHEN COALESCE(ai_initial_image_count, 0) = 0 THEN ? ELSE ai_initial_image_count END WHERE id = ?")
      .run(engine, executionIds[0], JSON.stringify(executionIds), 'ai_generating', executionIds.length, order.id);
    记录系统订单事件(order, 'ai_submit_success', { batch_kind: 'initial', image_count: executionIds.length, trigger });
    console.log(`🤖 AI 生图已提交: 订单=${order.id} 批次=${executionIds.length} 个执行`);
  } catch (e) {
    记录系统订单事件(order, 'ai_submit_failed', { batch_kind: 'initial', reason: e.message, trigger }, 'fail');
    console.error('❌ AI 生图提交失败:', e.message);
  }
}

function 读取微信Xml字段(xmlText, name) {
  const text = String(xmlText || '');
  const match = text.match(new RegExp(`<${name}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>|<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? String(match[1] || match[2] || '').trim() : '';
}

function 读取微信Xml详情(xmlText) {
  const text = String(xmlText || '');
  const blocks = [...text.matchAll(/<detail>([\s\S]*?)<\/detail>/gi)];
  return blocks.map((match, index) => {
    const block = match[1] || '';
    return {
      index,
      strategy: 读取微信Xml字段(block, 'strategy'),
      errcode: Number(读取微信Xml字段(block, 'errcode') || 0),
      suggest: 读取微信Xml字段(block, 'suggest'),
      label: Number(读取微信Xml字段(block, 'label') || 0),
      prob: Number(读取微信Xml字段(block, 'prob') || 0)
    };
  });
}

function 解析微信内容安全回调(rawBody) {
  if (Buffer.isBuffer(rawBody)) rawBody = rawBody.toString('utf8');
  if (rawBody && typeof rawBody === 'object') return rawBody;
  const bodyText = String(rawBody || '').trim();
  if (!bodyText) return {};
  try { return JSON.parse(bodyText); } catch (error) {}

  const payload = {
    ToUserName: 读取微信Xml字段(bodyText, 'ToUserName'),
    FromUserName: 读取微信Xml字段(bodyText, 'FromUserName'),
    CreateTime: Number(读取微信Xml字段(bodyText, 'CreateTime') || 0),
    MsgType: 读取微信Xml字段(bodyText, 'MsgType'),
    Event: 读取微信Xml字段(bodyText, 'Event'),
    appid: 读取微信Xml字段(bodyText, 'appid'),
    trace_id: 读取微信Xml字段(bodyText, 'trace_id'),
    version: Number(读取微信Xml字段(bodyText, 'version') || 0),
    errcode: Number(读取微信Xml字段(bodyText, 'errcode') || 0),
    errmsg: 读取微信Xml字段(bodyText, 'errmsg'),
    Encrypt: 读取微信Xml字段(bodyText, 'Encrypt'),
    result: {
      suggest: 读取微信Xml字段(bodyText, 'suggest'),
      label: Number(读取微信Xml字段(bodyText, 'label') || 0)
    },
    detail: 读取微信Xml详情(bodyText)
  };
  return payload;
}

function 生成微信消息签名(parts) {
  return crypto.createHash('sha1')
    .update(parts.map(item => String(item || '')).sort().join(''))
    .digest('hex');
}

function 安全比较文本(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function 校验微信消息签名(signature, timestamp, nonce, encryptedText = '') {
  if (!WX_MESSAGE_TOKEN) return { configured: false, valid: true };
  if (!signature) return { configured: true, valid: !WX_MESSAGE_VERIFY_STRICT, missing: true };
  const parts = encryptedText
    ? [WX_MESSAGE_TOKEN, timestamp, nonce, encryptedText]
    : [WX_MESSAGE_TOKEN, timestamp, nonce];
  const expected = 生成微信消息签名(parts);
  return { configured: true, valid: 安全比较文本(signature, expected), expected };
}

function 解密微信消息(encryptedText) {
  if (!WX_MESSAGE_AES_KEY) {
    throw new Error('收到微信加密消息，但服务端未配置 WX_MESSAGE_ENCODING_AES_KEY');
  }

  const normalizedKey = WX_MESSAGE_AES_KEY.endsWith('=')
    ? WX_MESSAGE_AES_KEY
    : `${WX_MESSAGE_AES_KEY}=`;
  const aesKey = Buffer.from(normalizedKey, 'base64');
  if (aesKey.length !== 32) {
    throw new Error('WX_MESSAGE_ENCODING_AES_KEY 格式无效，应为微信后台生成的 43 位 EncodingAESKey');
  }

  const encrypted = Buffer.from(String(encryptedText || ''), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  const pad = Number(plain[plain.length - 1] || 0);
  if (pad < 1 || pad > 32) throw new Error('微信消息 PKCS#7 填充无效');
  plain = plain.subarray(0, plain.length - pad);
  if (plain.length < 20) throw new Error('微信加密消息长度无效');

  const messageLength = plain.readUInt32BE(16);
  const messageStart = 20;
  const messageEnd = messageStart + messageLength;
  if (messageEnd > plain.length) throw new Error('微信加密消息正文长度无效');

  const message = plain.subarray(messageStart, messageEnd).toString('utf8');
  const embeddedAppid = plain.subarray(messageEnd).toString('utf8');
  const wxConfig = getWxMiniappCredentials();
  if (wxConfig.appid && embeddedAppid && embeddedAppid !== wxConfig.appid) {
    throw new Error(`微信加密消息 AppID 不匹配：${embeddedAppid}`);
  }
  return message;
}

function 规范化微信回调请求体(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');
  if (typeof rawBody === 'string') return rawBody;
  if (rawBody && typeof rawBody === 'object') return JSON.stringify(rawBody);
  return '';
}

async function 微信内容安全回调校验处理(req, res) {
  try {
    const query = req.query || {};
    const timestamp = String(query.timestamp || '');
    const nonce = String(query.nonce || '');
    const echostr = String(query.echostr || '');
    const encryptedMode = String(query.encrypt_type || '').toLowerCase() === 'aes' || Boolean(query.msg_signature);
    const signature = encryptedMode ? String(query.msg_signature || '') : String(query.signature || '');
    const signatureCheck = 校验微信消息签名(signature, timestamp, nonce, encryptedMode ? echostr : '');

    内容安全结构化日志('log', 'callback.verify_get', {
      path: req.originalUrl || req.url || '',
      encrypted: encryptedMode,
      token_configured: Boolean(WX_MESSAGE_TOKEN),
      aes_key_configured: Boolean(WX_MESSAGE_AES_KEY),
      signature_present: Boolean(signature),
      signature_valid: signatureCheck.valid,
      echostr_present: Boolean(echostr)
    });

    if (!signatureCheck.valid) {
      return res.status(403).type('text/plain').send('invalid signature');
    }

    let responseText = echostr || 'ok';
    if (encryptedMode && echostr) {
      responseText = 解密微信消息(echostr);
    }
    return res.type('text/plain').send(responseText);
  } catch (error) {
    内容安全结构化日志('error', 'callback.verify_failed', {
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : ''
    });
    return res.status(500).type('text/plain').send('callback verify failed');
  }
}

async function 微信内容安全回调原始处理(req, res) {
  try {
    const query = req.query || {};
    const rawText = 规范化微信回调请求体(req.body);
    const outerPayload = 解析微信内容安全回调(req.body);
    const encryptedText = String(
      outerPayload.Encrypt ||
      outerPayload.encrypt ||
      读取微信Xml字段(rawText, 'Encrypt') ||
      ''
    ).trim();

    const timestamp = String(query.timestamp || '');
    const nonce = String(query.nonce || '');
    const signature = encryptedText
      ? String(query.msg_signature || '')
      : String(query.signature || '');
    const signatureCheck = 校验微信消息签名(signature, timestamp, nonce, encryptedText);

    内容安全结构化日志('log', 'callback.entered', {
      path: req.originalUrl || req.url || '',
      content_type: req.headers && req.headers['content-type'] ? req.headers['content-type'] : '',
      body_bytes: Buffer.byteLength(rawText || '', 'utf8'),
      encrypted: Boolean(encryptedText),
      token_configured: Boolean(WX_MESSAGE_TOKEN),
      signature_present: Boolean(signature),
      signature_valid: signatureCheck.valid
    });

    if (!signatureCheck.valid) {
      内容安全结构化日志('warn', 'callback.rejected', { reason: 'invalid_signature' });
      return res.status(403).type('text/plain').send('invalid signature');
    }

    const payload = encryptedText
      ? 解析微信内容安全回调(解密微信消息(encryptedText))
      : outerPayload;

    const callbackSummary = summarizeMediaCheckCallback(payload);
    内容安全结构化日志('log', 'callback.received', {
      ...callbackSummary,
      encrypted: Boolean(encryptedText),
      ...(CONTENT_SECURITY_LOG_RAW ? { raw: payload } : {})
    });

    if (!payload || !callbackSummary.trace_id) {
      内容安全结构化日志('warn', 'callback.ignored', {
        reason: 'missing_trace_id',
        summary: callbackSummary,
        body_preview: truncateForLog(rawText || '', 800)
      });
      return res.type('text/plain').send('success');
    }

    const result = await 处理微信内容安全回调(payload);
    内容安全结构化日志('log', 'callback.handled', {
      trace_id: callbackSummary.trace_id,
      order_id: result && result.orderId ? result.orderId : '',
      status: result && result.status ? result.status : '',
      reason: result && result.reason ? result.reason : ''
    });
    return res.type('text/plain').send('success');
  } catch (error) {
    内容安全结构化日志('error', 'callback.processing_failed', {
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : ''
    });
    return res.type('text/plain').send('success');
  }
}

async function 处理微信内容安全回调(payload) {
  const normalized = normalizeMediaCheckCallback(payload);
  const traceId = normalized.trace_id;
  if (!traceId) return { ok: false, reason: 'missing_trace_id' };

  const order = db.prepare(`
    SELECT * FROM orders
    WHERE COALESCE(content_review_trace_ids_json, '') LIKE ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(`%${traceId}%`);
  if (!order) {
    内容安全结构化日志('warn', 'callback.order_not_found', {
      trace_id: traceId,
      callback: summarizeMediaCheckCallback(payload)
    });
    return { ok: false, reason: 'order_not_found', traceId };
  }

  const existing = 内容安全结果数组(order.content_review_result_json);
  const previousItem = existing.find(item => String(item.trace_id || '') === traceId) || null;
  const previousCallback = previousItem && previousItem.callback ? previousItem.callback : null;
  const previousDecision = previousCallback
    ? (previousCallback.decision || contentReviewDecisionFromSuggest(previousCallback.suggest, previousCallback.errcode))
    : '';
  const callbackHistory = Array.isArray(previousCallback?.history) ? previousCallback.history.slice(-4) : [];
  if (previousCallback) {
    callbackHistory.push({
      callback_at: previousCallback.callback_at || '',
      errcode: Number(previousCallback.errcode || 0),
      errmsg: previousCallback.errmsg || '',
      suggest: previousCallback.suggest || '',
      label: Number(previousCallback.label || 0),
      decision: previousDecision
    });
  }

  const callbackRecord = {
    trace_id: traceId,
    callback_at: new Date().toISOString(),
    errcode: normalized.errcode,
    errmsg: normalized.errmsg,
    suggest: normalized.suggest,
    label: normalized.label,
    decision: normalized.decision,
    decision_source: normalized.decision_source,
    detail: normalized.detail,
    received_count: Number(previousCallback?.received_count || 0) + 1,
    history: callbackHistory,
    raw: payload
  };
  const merged = existing.map(item => String(item.trace_id || '') === traceId ? { ...item, callback: callbackRecord } : item);
  if (!merged.some(item => String(item.trace_id || '') === traceId)) {
    merged.push({ trace_id: traceId, callback: callbackRecord });
  }

  const matchedItem = merged.find(item => String(item.trace_id || '') === traceId) || {};
  const taskStates = merged.map(内容安全任务摘要);
  内容安全结构化日志('log', 'callback.matched_order', {
    order_id: order.id,
    order_status_before: order.status || '',
    review_status_before: order.content_review_status || '',
    trace_id: traceId,
    matched_field: matchedItem.field || '',
    matched_label: matchedItem.label || '',
    media_url: sanitizeUrlForLog(matchedItem.media_url || ''),
    previous_decision: previousDecision,
    callback: {
      errcode: callbackRecord.errcode,
      errmsg: callbackRecord.errmsg,
      suggest: callbackRecord.suggest,
      label: callbackRecord.label,
      decision: callbackRecord.decision,
      decision_source: callbackRecord.decision_source,
      detail_count: callbackRecord.detail.length,
      detail: callbackRecord.detail,
      received_count: callbackRecord.received_count
    },
    tasks: taskStates
  });

  if (isMediaDownloadError(callbackRecord.errcode, callbackRecord.errmsg)) {
    const retryResult = await 重试微信内容安全下载失败(order, matchedItem, merged);
    if (retryResult) return retryResult;
  }

  const activeItems = merged.filter(item => item.active !== false);
  const rejected = activeItems.find(item => {
    const cb = item.callback || {};
    return (cb.decision || contentReviewDecisionFromSuggest(cb.suggest, cb.errcode)) === 'reject';
  });

  if (rejected) {
    const reason = 内容安全拒绝文案(rejected.callback || rejected);
    db.prepare(`
      UPDATE orders SET
        status='audit_rejected',
        content_review_status='rejected',
        content_review_result_json=?,
        content_review_reject_reason=?,
        content_review_rejected_at=datetime('now','localtime'),
        content_review_completed_at=datetime('now','localtime'),
        ai_current_step=?
      WHERE id=?
    `).run(JSON.stringify(merged), reason, reason, order.id);
    记录系统订单事件(order, 'content_review_rejected', {
      trace_id: traceId,
      field: rejected.field || '',
      reason,
      errcode: Number(rejected.callback?.errcode || 0),
      errmsg: rejected.callback?.errmsg || '',
      suggest: rejected.callback?.suggest || '',
      label: rejected.callback?.label || null,
      decision_source: rejected.callback?.decision_source || '',
      detail: rejected.callback?.detail || []
    }, 'fail');
    内容安全结构化日志('warn', 'review.rejected', {
      order_id: order.id,
      trace_id: traceId,
      field: rejected.field || '',
      reason,
      callback: 内容安全任务摘要(rejected),
      tasks: taskStates
    });
    return { ok: true, orderId: order.id, status: 'rejected' };
  }

  const technicalError = activeItems.find(item => {
    const cb = item.callback || {};
    return (cb.decision || contentReviewDecisionFromSuggest(cb.suggest, cb.errcode)) === 'error';
  });
  if (technicalError) {
    const callback = technicalError.callback || {};
    const reason = 内容安全审核异常文案(callback);
    db.prepare(`
      UPDATE orders SET
        content_review_status='error',
        content_review_result_json=?,
        ai_current_step='内容安全审核暂时异常，正在等待处理'
      WHERE id=?
    `).run(JSON.stringify(merged), order.id);
    记录系统订单事件(order, 'content_review_callback_error', {
      trace_id: traceId,
      field: technicalError.field || '',
      reason,
      errcode: Number(callback.errcode || 0),
      errmsg: callback.errmsg || '',
      suggest: callback.suggest || '',
      label: callback.label || null,
      detail: callback.detail || []
    }, 'fail');
    内容安全结构化日志('error', 'review.callback_error', {
      order_id: order.id,
      trace_id: traceId,
      field: technicalError.field || '',
      reason,
      callback: 内容安全任务摘要(technicalError),
      action: 'kept_in_content_reviewing_for_retry_or_manual_handling',
      tasks: taskStates
    });
    return { ok: true, orderId: order.id, status: 'error', reason };
  }

  const manualReview = activeItems.find(item => {
    const cb = item.callback || {};
    return (cb.decision || contentReviewDecisionFromSuggest(cb.suggest, cb.errcode)) === 'manual_review';
  });
  if (manualReview) {
    const callback = manualReview.callback || {};
    db.prepare(`
      UPDATE orders SET
        content_review_status='manual_review',
        content_review_result_json=?,
        ai_current_step='图片正在复核，请稍候'
      WHERE id=?
    `).run(JSON.stringify(merged), order.id);
    记录系统订单事件(order, 'content_review_manual_review', {
      trace_id: traceId,
      field: manualReview.field || '',
      suggest: callback.suggest || '',
      label: callback.label || null,
      decision_source: callback.decision_source || '',
      detail: callback.detail || []
    }, 'success');
    内容安全结构化日志('warn', 'review.manual_review', {
      order_id: order.id,
      trace_id: traceId,
      field: manualReview.field || '',
      callback: 内容安全任务摘要(manualReview),
      action: 'not_rejected_waiting_for_follow_up_or_manual_handling',
      tasks: taskStates
    });
    return { ok: true, orderId: order.id, status: 'manual_review' };
  }

  const traceIds = 内容安全结果数组(order.content_review_trace_ids_json);
  const passTraceIds = new Set(activeItems
    .filter(item => {
      const cb = item.callback || {};
      return (cb.decision || contentReviewDecisionFromSuggest(cb.suggest, cb.errcode)) === 'pass';
    })
    .map(item => String(item.trace_id || '')));
  const allPassed = traceIds.length > 0 && traceIds.every(id => passTraceIds.has(String(id)));

  const terminalReviewStatus = order.status === 'audit_rejected' || order.status === 'audit_timeout';
  const nextReviewStatus = terminalReviewStatus
    ? (order.content_review_status || 'checking')
    : (allPassed ? 'passed' : 'checking');
  db.prepare(`UPDATE orders SET content_review_result_json=?, content_review_status=? WHERE id=?`)
    .run(JSON.stringify(merged), nextReviewStatus, order.id);
  if (allPassed && order.status === 'content_reviewing') {
    db.prepare(`
      UPDATE orders SET
        status='pending',
        content_review_status='passed',
        content_review_completed_at=datetime('now','localtime'),
        ai_current_step='图片分析完成，正在继续处理'
      WHERE id=?
    `).run(order.id);
    记录系统订单事件(order, 'content_review_passed', {
      trace_ids: traceIds,
      tasks: taskStates
    }, 'success');
    内容安全结构化日志('log', 'review.passed', {
      order_id: order.id,
      trace_ids: traceIds,
      task_count: taskStates.length,
      tasks: taskStates
    });
    启动订单后续处理(order.id, 'wx_media_check_callback').catch(err => {
      内容安全结构化日志('error', 'review.follow_up_failed', {
        order_id: order.id,
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : ''
      });
    });
    return { ok: true, orderId: order.id, status: 'passed' };
  }

  内容安全结构化日志('log', 'review.waiting', {
    order_id: order.id,
    trace_id: traceId,
    received_count: taskStates.filter(item => item.callback_received).length,
    expected_count: traceIds.length,
    tasks: taskStates
  });
  return { ok: true, orderId: order.id, status: 'checking' };
}

// ==========================================
// 构建 AI 生图消息（图文交替数组格式）
// ==========================================
function 构建生图消息(serviceType, artworkUrl, spaceUrl, size, notes) {
  if (serviceType === 'hang_in_home') {
    const sz = size ? `尺寸：${size}` : '尺寸';
    return [
      { text: '将这张作品' },
      { file_url: artworkUrl },
      { text: `（${sz}）放到这个` },
      { file_url: spaceUrl },
      { text: `家装空间内，空间内不要增减家具，去除原有的挂画和明显杂物，保留文玩摆件，可以转动视角寻找更优的悬挂位置。调整画面明度使其与环境合理自然且一致。并且最重要的是严格遵循我提供的画作尺寸信息（${sz}）如尺寸不符合目标信息，将判定为失败并按审核意见重新调整
作品信息，应在空间设计中作为整体视觉及家具设计的部分充分参考：

作品与空间陈设匹配规则，自行判断哪些规则是当前设计所需的：
如果空间使用对比鲜明的色彩打造引人入胜、充满活力的设计，为了达到最佳视觉效果，为墙面艺术品选择的主色调最好也出现在地毯或椅子上，均匀地分布在整个房间中，但不要直接使用艺术品上的图案，应对艺术品中的个别元素进行提取与抽象。选择一种中性色，例如白色或灰色，与你从色轮上选出的两种对比色相协调。这种颜色能使房间整体风格更加平衡。
如果空间色调单一，可以采用小面积的带有补色的挂画，为空间增添活力。
将同一位艺术家的多件作品，或风格语汇极为相似的作品组合在一起，能产生更强的视觉冲击力。
选取能表达房屋所处的特殊气候或周围环境的具象作品，产生外部空间的关联；让抱枕的花纹与作品保持相似，但内容风格又有差异，各有体系，以产生内部空间的关联。如地处威尼斯的空间搭配删擅长描绘威尼斯生活的艺术家的作品，并让抱枕的色彩和纹路高度吻合画作上的斜向光影。
在统一作品与空间风格和色调的同时，选取能表达房屋所处的特殊气候或周围环境的具象作品。如轻盈、简约的灰白色调现代风格搭配白雪皑皑的山地景观作品。
抽象艺术几乎可以与任何室内装潢风格相匹配，但不要同时摆放过多装饰品，只选择那些更加能衬托艺术品的必需品。
形式单纯的抽象艺术更适合与室内空间中大体量家具的形式相匹配，如平行排列性的画作笔触与沙发的纹理产生自上而下的连续绵延的平行排列形式。
装饰品与艺术品的纹理、形状元素或色彩搭配保持一致，产生异质同构的效果，并在相对位置上营造出一种引导视线的韵律感。深色的墙面比浅白色更适合承载深色、高饱和、高对比度的作品。
确保作品的视觉张力能够支撑空间的视觉张力，包括环境光线、色彩和形式变化营造的视知觉体验。色彩越鲜艳，艺术品就需要越多的视觉空间。大尺幅作品比小尺幅提供更强的视觉张力，但通常看上去不会大于邻近的最大家具。而尺寸较小的艺术品则更适合较小的空间和邻近家具。
艺术作品的配色如果与环境中的家具不同，图形元素的相同能够带来更有趣活泼的视觉联系。
图形元素的相同能够带来更有趣活泼的视觉联系。
画作反映的质感可以与环境中的家具相关，如在棱角分明方体组成的沙发和不锈钢管线条结构的桌椅旁安置描绘北方金属外皮的工业建筑的画作。
艺术作品可以成为关联两种弱相关环境元素的中间媒介，如使用藤曼般蜿蜒的轮胎痕壁画来串联落地窗后葱郁的热带自然景观和带有工业特质的现代主义设计，以背后的"橡胶"意象串联起完整的空间叙事。
作品与家具设计的流派和文化来源一致通常有较好的效果。
运用灰色和棕色为主的中性色调使多元的古典风格和不同年代的新旧物品浑然一体，散发出历史的厚重和温馨的气息。
画框、装饰条和线条之间要留出足够的空间，让空间显得更宽敞。确保每件艺术品与其他作品保持等距，每件墙面艺术品之间以及画框四周都应留出 3-6 英寸的距离。较大的艺术品画框之间应留出更多空间，较小的艺术品则应集中摆放。
从地面到作品水平中心应在60英寸（152厘米）左右，随居住者平均身高上下浮动。如果作品在餐桌旁边且远离过道，则应适当下降在135cm左右，以适应人体坐高。
如作品安置在边柜或沙发上方墙面，其宽度应为下方家具的三分之二倍至0.618倍，具体大小取决于两者视觉体量的平衡与其他视觉张力因素。

画框与装裱效果生成规则：
当作品为宋元代中国画时，画框和装裱起到衔接画面颜色与墙面家具颜色的作用，并衬托作品气质。画框内层卡纸、衬纸在明亮空间中常用纯白起提亮作用，但如果空间中亮白色少，应跟随暗淡的画面与墙面色调选用相近的浅驼、淡灰或浅豆青等素色避免夺目。画面内容气质清雅的应简洁明快，内容华丽饱满的则使用复杂质感的配框与有色织锦内衬。如果画面多留白淡雅，框色用相近明度的柚木色至胡桃色，如果画面墨色重对比强，可以用深檀色至黑色边框，画框颜色最好与空间中家具存在相同。家具设计偏轻盈则画框也应轻薄纤细，家具厚实则适当加宽，保持平衡，可以使用极细金属色边线呼应空间中的金属材质。简洁利落或中古家具风格适合搭配哑光细黑画框，只含画芯画框，不使用卡纸留白，视觉干净清爽，但团扇作品一定使用卡纸留白、方形画框装裱，不要使用圆形画框。偏传统中式风格家具适合挂轴形制的立轴类型作品，绫色低饱和需与作品或空间中的低饱和色彩呼应，但与墙面颜色不同，轴杆颜色呼应空间里的深木色/金属色。现代风格或中古风家具适合装框立轴作品，简洁清爽。一件画作的挂轴或画框只能选择其中一种使用，不能叠加使用。
当挂画为现代中式风格时，使用画框装裱不要出现白边。` }
    ];
  }

  if (serviceType === 'recommend_work') {
    const artworks = 读取作品列表();
    const messages = [{ text: '从这些作品中 （尺寸）' }];
    artworks.forEach((aw, i) => {
      messages.push({ text: `${i + 1}` });
      messages.push({ file_url: aw.primary_image_url || aw.cover_url || aw.images[0] });
      messages.push({ text: `（尺寸：${aw.size}）` });
    });
    messages.push({ text: '（小幅）选取一张高度匹配的放到这个' });
    messages.push({ file_url: spaceUrl });
    messages.push({ text: `家装空间内，按照作品特点和匹配规则挑选，不要全部使用，空间内不要增减家具，去除原有的挂画和明显杂物，保留文玩摆件，可以转动视角寻找更优的悬挂位置。调整画面明度使其与环境合理自然且一致。并且最重要的是严格遵循我提供的画作尺寸信息（尺寸）如尺寸不符合目标信息，将判定为失败并按审核意见重新调整
作品信息，应在空间设计中作为整体视觉及家具设计的部分充分参考：

作品与空间陈设匹配规则，自行判断哪些规则是当前设计所需的：
如果空间使用对比鲜明的色彩打造引人入胜、充满活力的设计，为了达到最佳视觉效果，为墙面艺术品选择的主色调最好也出现在地毯或椅子上，均匀地分布在整个房间中，但不要直接使用艺术品上的图案，应对艺术品中的个别元素进行提取与抽象。选择一种中性色，例如白色或灰色，与你从色轮上选出的两种对比色相协调。这种颜色能使房间整体风格更加平衡。
如果空间色调单一，可以采用小面积的带有补色的挂画，为空间增添活力。
将同一位艺术家的多件作品，或风格语汇极为相似的作品组合在一起，能产生更强的视觉冲击力。
选取能表达房屋所处的特殊气候或周围环境的具象作品，产生外部空间的关联；让抱枕的花纹与作品保持相似，但内容风格又有差异，各有体系，以产生内部空间的关联。如地处威尼斯的空间搭配删擅长描绘威尼斯生活的艺术家的作品，并让抱枕的色彩和纹路高度吻合画作上的斜向光影。
在统一作品与空间风格和色调的同时，选取能表达房屋所处的特殊气候或周围环境的具象作品。如轻盈、简约的灰白色调现代风格搭配白雪皑皑的山地景观作品。
抽象艺术几乎可以与任何室内装潢风格相匹配，但不要同时摆放过多装饰品，只选择那些更加能衬托艺术品的必需品。
形式单纯的抽象艺术更适合与室内空间中大体量家具的形式相匹配，如平行排列性的画作笔触与沙发的纹理产生自上而下的连续绵延的平行排列形式。
装饰品与艺术品的纹理、形状元素或色彩搭配保持一致，产生异质同构的效果，并在相对位置上营造出一种引导视线的韵律感。深色的墙面比浅白色更适合承载深色、高饱和、高对比度的作品。
确保作品的视觉张力能够支撑空间的视觉张力，包括环境光线、色彩和形式变化营造的视知觉体验。色彩越鲜艳，艺术品就需要越多的视觉空间。大尺幅作品比小尺幅提供更强的视觉张力，但通常看上去不会大于邻近的最大家具。而尺寸较小的艺术品则更适合较小的空间和邻近家具。
艺术作品的配色如果与环境中的家具不同，图形元素的相同能够带来更有趣活泼的视觉联系。
图形元素的相同能够带来更有趣活泼的视觉联系。
画作反映的质感可以与环境中的家具相关，如在棱角分明方体组成的沙发和不锈钢管线条结构的桌椅旁安置描绘北方金属外皮的工业建筑的画作。
艺术作品可以成为关联两种弱相关环境元素的中间媒介，如使用藤曼般蜿蜒的轮胎痕壁画来串联落地窗后葱郁的热带自然景观和带有工业特质的现代主义设计，以背后的"橡胶"意象串联起完整的空间叙事。
作品与家具设计的流派和文化来源一致通常有较好的效果。
运用灰色和棕色为主的中性色调使多元的古典风格和不同年代的新旧物品浑然一体，散发出历史的厚重和温馨的气息。
画框、装饰条和线条之间要留出足够的空间，让空间显得更宽敞。确保每件艺术品与其他作品保持等距，每件墙面艺术品之间以及画框四周都应留出 3-6 英寸的距离。较大的艺术品画框之间应留出更多空间，较小的艺术品则应集中摆放。
从地面到作品水平中心应在60英寸（152厘米）左右，随居住者平均身高上下浮动。如果作品在餐桌旁边且远离过道，则应适当下降在135cm左右，以适应人体坐高。
如作品安置在边柜或沙发上方墙面，其宽度应为下方家具的三分之二倍至0.618倍，具体大小取决于两者视觉体量的平衡与其他视觉张力因素。

画框与装裱效果生成规则：
当作品为宋元代中国画时，画框和装裱起到衔接画面颜色与墙面家具颜色的作用，并衬托作品气质。画框内层卡纸、衬纸在明亮空间中常用纯白起提亮作用，但如果空间中亮白色少，应跟随暗淡的画面与墙面色调选用相近的浅驼、淡灰或浅豆青等素色避免夺目。画面内容气质清雅的应简洁明快，内容华丽饱满的则使用复杂质感的配框与有色织锦内衬。如果画面多留白淡雅，框色用相近明度的柚木色至胡桃色，如果画面墨色重对比强，可以用深檀色至黑色边框，画框颜色最好与空间中家具存在相同。家具设计偏轻盈则画框也应轻薄纤细，家具厚实则适当加宽，保持平衡，可以使用极细金属色边线呼应空间中的金属材质。简洁利落或中古家具风格适合搭配哑光细黑画框，只含画芯画框，不使用卡纸留白，视觉干净清爽，但团扇作品一定使用卡纸留白、方形画框装裱，不要使用圆形画框。偏传统中式风格家具适合挂轴形制的立轴类型作品，绫色低饱和需与作品或空间中的低饱和色彩呼应，但与墙面颜色不同，轴杆颜色呼应空间里的深木色/金属色。现代风格或中古风家具适合装框立轴作品，简洁清爽。一件画作的挂轴或画框只能选择其中一种使用，不能叠加使用。
当挂画为现代中式风格时，使用画框装裱不要出现白边。` });
    return messages;
  }

  if (serviceType === 'recommend_space') {
    const sz = size ? `尺寸：${size}` : '尺寸';
    const notesPrefix = notes ? `用户备注：${notes}。请在生成时参考。\n` : '';
    return [
      { text: notesPrefix + '将这件作品' },
      { file_url: artworkUrl },
      { text: `（${sz}） 放到这个与之高度匹配的家装空间内，空间内应包含所有必要的家具，重叠产生丰富视觉层次，大师级窗帘光影。作品` },
      { file_url: artworkUrl },
      { text: `（${sz}）不要处在画面中央，不显眼。严格使用画作` },
      { file_url: artworkUrl },
      { text: `（${sz}）原图 ，不要换成其他作品。并且最重要的是严格遵循我提供的画作尺寸信息（${sz}）如尺寸不符合目标信息，将判定为失败并按审核意见重新调整
作品信息，应在空间设计中作为整体视觉及家具设计的部分充分参考：

作品与空间陈设匹配规则，自行判断哪些规则是当前设计所需的：
如果空间使用对比鲜明的色彩打造引人入胜、充满活力的设计，为了达到最佳视觉效果，为墙面艺术品选择的主色调最好也出现在地毯或椅子上，均匀地分布在整个房间中，但不要直接使用艺术品上的图案，应对艺术品中的个别元素进行提取与抽象。选择一种中性色，例如白色或灰色，与你从色轮上选出的两种对比色相协调。这种颜色能使房间整体风格更加平衡。
将同一位艺术家的多件作品，或风格语汇极为相似的作品组合在一起，能产生更强的视觉冲击力。
选取能表达房屋所处的特殊气候或周围环境的具象作品，产生外部空间的关联；让抱枕的花纹与作品保持相似，但内容风格又有差异，各有体系，以产生内部空间的关联，绝对不要直接在地毯或抱枕上使用作品图像。如地处威尼斯的空间搭配删擅长描绘威尼斯生活的艺术家的作品，并让抱枕的色彩和纹路高度吻合画作上的斜向光影。
在统一作品与空间风格和色调的同时，选取能表达房屋所处的特殊气候或周围环境的具象作品。如轻盈、简约的灰白色调现代风格搭配白雪皑皑的山地景观作品。
抽象艺术几乎可以与任何室内装潢风格相匹配，但不要同时摆放过多装饰品，只选择那些更加能衬托艺术品的必需品。
形式单纯的抽象艺术更适合与室内空间中大体量家具的形式相匹配，如平行排列性的画作笔触与沙发的纹理产生自上而下的连续绵延的平行排列形式。
装饰品与艺术品的纹理、形状元素或色彩搭配保持一致，产生异质同构的效果，并在相对位置上营造出一种引导视线的韵律感。深色的墙面比浅白色更适合承载深色、高饱和、高对比度的作品。
确保作品的视觉张力能够支撑空间的视觉张力，包括环境光线、色彩和形式变化营造的视知觉体验。色彩越鲜艳，艺术品就需要越多的视觉空间。大尺幅作品比小尺幅提供更强的视觉张力，但通常看上去不会大于邻近的最大家具。而尺寸较小的艺术品则更适合较小的空间和邻近家具。
艺术作品的配色如果与环境中的家具不同，图形元素的相同能够带来更有趣活泼的视觉联系。
图形元素的相同能够带来更有趣活泼的视觉联系。
画作反映的质感可以与环境中的家具相关，如在棱角分明方体组成的沙发和不锈钢管线条结构的桌椅旁安置描绘北方金属外皮的工业建筑的画作。
艺术作品可以成为关联两种弱相关环境元素的中间媒介，如使用藤曼般蜿蜒的轮胎痕壁画来串联落地窗后葱郁的热带自然景观和带有工业特质的现代主义设计，以背后的"橡胶"意象串联起完整的空间叙事。
作品与家具设计的流派和文化来源一致通常有较好的效果。
运用灰色和棕色为主的中性色调使多元的古典风格和不同年代的新旧物品浑然一体，散发出历史的厚重和温馨的气息。
画框、装饰条和线条之间要留出足够的空间，让空间显得更宽敞。确保每件艺术品与其他作品保持等距，每件墙面艺术品之间以及画框四周都应留出 3-6 英寸的距离。较大的艺术品画框之间应留出更多空间，较小的艺术品则应集中摆放。
从地面到作品水平中心应在60英寸（152厘米）左右，随居住者平均身高上下浮动。如果作品在餐桌旁边且远离过道，则应适当下降在135cm左右，以适应人体坐高。
如作品安置在边柜或沙发上方墙面，其宽度应为下方家具的三分之二倍至0.618倍，具体大小取决于两者视觉体量的平衡与其他视觉张力因素。

画框与装裱效果生成规则：
当作品为宋元代中国画时，画框和装裱起到衔接画面颜色与墙面家具颜色的作用，并衬托作品气质。画框内层卡纸、衬纸在明亮空间中常用纯白起提亮作用，但如果空间中亮白色少，应跟随暗淡的画面与墙面色调选用相近的浅驼、淡灰或浅豆青等素色避免夺目。画面内容气质清雅的应简洁明快，内容华丽饱满的则使用复杂质感的配框与有色织锦内衬。如果画面多留白淡雅，框色用相近明度的柚木色至胡桃色，如果画面墨色重对比强，可以用深檀色至黑色边框，画框颜色最好与空间中家具存在相同。家具设计偏轻盈则画框也应轻薄纤细，家具厚实则适当加宽，保持平衡，可以使用极细金属色边线呼应空间中的金属材质。简洁利落或中古家具风格适合搭配哑光细黑画框，只含画芯画框，不使用卡纸留白，视觉干净清爽，但团扇作品一定使用卡纸留白、方形画框装裱，不要使用圆形画框。偏传统中式风格家具适合挂轴形制的立轴类型作品，绫色低饱和需与作品或空间中的低饱和色彩呼应，但与墙面颜色不同，轴杆颜色呼应空间里的深木色/金属色。现代风格或中古风家具适合装框立轴作品，简洁清爽。一件画作的挂轴或画框只能选择其中一种使用，不能叠加使用。
当挂画为现代中式风格时，使用画框装裱不要出现白边。` }
    ];
  }

  throw new Error(`未知服务类型: ${serviceType}`);
}

// ==========================================
// 微信登录：code 换 openid，保存用户信息，并绑定当前设备
// POST /api/client/wx-login
// ==========================================
router.post('/wx-login', express.json(), async (req, res) => {
  const { code, nickname, avatar, device_uuid } = req.body || {};
  if (!code) return res.status(400).json({ error: '缺少code' });

  try {
    const wxConfig = getWxMiniappCredentials();
    if (!wxConfig.appid || !wxConfig.secret) {
      const configState = describeWxMiniappConfig();
      console.error('[wx-login] missing miniapp credentials:', configState);
      return res.status(500).json({
        error: '微信登录配置缺失',
        detail: '请在服务端环境变量中配置当前小程序对应的 AppID 和 AppSecret',
        config: configState
      });
    }

    console.log(`[wx-login] jscode2session request appid=${wxConfig.maskedAppid} appid_source=${wxConfig.appidSource || 'unknown'} secret_source=${wxConfig.secretSource || 'unknown'}`);
    const wxRes = await fetch(
      `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(wxConfig.appid)}&secret=${encodeURIComponent(wxConfig.secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
    );
    const data = await wxRes.json();

    if (data.errcode) {
      console.error('[wx-login] jscode2session failed:', {
        errcode: data.errcode,
        errmsg: data.errmsg,
        appid: wxConfig.maskedAppid,
        appid_source: wxConfig.appidSource,
        secret_source: wxConfig.secretSource
      });
      return res.status(400).json({
        error: '微信授权失败',
        detail: data.errmsg,
        errcode: data.errcode,
        appid: wxConfig.maskedAppid
      });
    }

    const { openid } = data;

    db.prepare(`
      INSERT INTO users (openid, nickname, avatar)
      VALUES (?, ?, ?)
      ON CONFLICT(openid) DO UPDATE SET
        nickname = COALESCE(excluded.nickname, users.nickname),
        avatar   = COALESCE(excluded.avatar,   users.avatar)
    `).run(openid, nickname || null, avatar || null);

    if (device_uuid) {
      绑定微信号与设备(openid, device_uuid);
      db.prepare(`
        UPDATE orders
        SET openid = COALESCE(NULLIF(openid, ''), ?),
            user_nickname = COALESCE(user_nickname, ?),
            user_avatar = COALESCE(user_avatar, ?)
        WHERE device_uuid = ?
      `).run(openid, nickname || null, avatar || null, device_uuid);
    }

    res.json({ success: true, openid, nickname: nickname || '', avatar: avatar || '' });
  } catch (e) {
    console.error('wx-login error:', e);
    res.status(500).json({ error: '登录失败' });
  }
});

// ==========================================
// 小程序单图上传接口（微信小程序每次只能传一张图）
// POST /api/client/upload-image
// ==========================================
router.post('/upload-image',
  clientUpload.single('image'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '未收到图片文件' });
    }
    res.json({
      success: true,
      filename: req.file.filename
    });
  }
);


// ==========================================
// 微信内容安全异步结果回调
// GET 用于消息服务器 URL 校验；POST 接收 wxa_media_check 事件。
// ==========================================
router.get('/wx-media-check-callback', 微信内容安全回调校验处理);

router.post(
  '/wx-media-check-callback',
  express.raw({ type: '*/*', limit: '2mb' }),
  微信内容安全回调原始处理
);

router.get('/wx-media-check-callback-health', (req, res) => {
  res.json({
    ok: true,
    callback_url: `${SERVER_BASE_URL}/api/client/wx-media-check-callback`,
    callback_aliases: [
      `${SERVER_BASE_URL}/api/client/wx-media-check-callback`,
      `${SERVER_BASE_URL}/api/wx-media-check-callback`,
      `${SERVER_BASE_URL}/wx-media-check-callback`
    ],
    token_configured: Boolean(WX_MESSAGE_TOKEN),
    aes_key_configured: Boolean(WX_MESSAGE_AES_KEY),
    signature_strict: WX_MESSAGE_VERIFY_STRICT,
    review_timeout_minutes: CONTENT_REVIEW_TIMEOUT_MINUTES,
    raw_callback_logging: CONTENT_SECURITY_LOG_RAW,
    image_security_mode: WX_IMAGE_SECURITY_MODE,
    img_sec_check_max_bytes: WX_IMG_SEC_CHECK_MAX_BYTES,
    download_retry_max: CONTENT_REVIEW_DOWNLOAD_RETRY_MAX,
    review_media: describeContentReviewMediaConfig()
  });
});

// ==========================================
// 提交服务请求
// POST /api/client/submit
// ==========================================
router.post('/submit',
  clientUpload.fields([{ name: 'artwork', maxCount: 1 }, { name: 'space', maxCount: 1 }]),
  async (req, res) => {
    try {
      const {
        service_type,
        receive_target,
        extra_service,
        device_uuid,
        openid,
        user_nickname,
        user_avatar,
        artwork_size,
        notes,
        subscribe_completion,
        subscribe_template_id,
        artwork_code,
        artwork_id,
        exhibition_id,
        entry_platform,
        entry_source,
        entry_scene,
        session_id,
        artwork_selection_method
      } = req.body;

      const 记录提交失败 = (reason, stage = 'server_validation') => {
        记录应用埋点({
          sessionId: session_id || null,
          deviceUuid: device_uuid || null,
          openid: openid || null,
          eventName: 'submit_failed',
          pageName: 'submit',
          platform: entry_platform || (openid ? 'miniapp' : 'web'),
          serviceType: service_type || null,
          entrySource: entry_source || (openid ? 'miniapp_upload' : 'web_home'),
          artworkId: artwork_id || null,
          artworkCode: artwork_code || null,
          props: {
            stage,
            reason: reason || 'unknown',
            artwork_selection_method: artwork_selection_method || ''
          }
        });
      };

      if (openid && device_uuid) {
        绑定微信号与设备(openid, device_uuid);
      }

      if (!service_type || !服务类型映射[service_type]) {
        记录提交失败('无效的服务类型');
        return res.status(400).json({ error: '无效的服务类型' });
      }
      if (!receive_target || receive_target.trim() === '') {
        记录提交失败('请填写接收邮箱');
        return res.status(400).json({ error: '请填写接收邮箱' });
      }

      const artworkFile = req.files && req.files['artwork'] ? req.files['artwork'][0] : null;
      const spaceFile = req.files && req.files['space'] ? req.files['space'][0] : null;
      let artworkFilename = artworkFile ? artworkFile.filename : (req.body.artwork_filename || null);
      const spaceFilename = spaceFile ? spaceFile.filename : (req.body.space_filename || null);
      const selectedArtwork = artwork_id
        ? getArtworkById(artwork_id)
        : (artwork_code ? findArtworkByCodeInExhibition(artwork_code, exhibition_id || LEGACY_EXHIBITION.id) : null);

      if (selectedArtwork && selectedArtwork.exhibition_status === 'archived') {
        记录提交失败('该展览已结束，暂不支持在线下单');
        return res.status(409).json({ error: '该展览已结束，暂不支持在线下单', exhibition_id: selectedArtwork.exhibition_id });
      }

      if (selectedArtwork && !artworkFilename) {
        artworkFilename = selectedArtwork.primary_image_url || selectedArtwork.cover_url || (selectedArtwork.images && selectedArtwork.images[0]) || null;
      }

      const hasArtwork = Boolean(artworkFilename || selectedArtwork);

      if (service_type === 'hang_in_home' && (!hasArtwork || !spaceFilename)) {
        记录提交失败('「作品挂进家」需同时提供作品图和空间图');
        return res.status(400).json({ error: '「作品挂进家」需同时提供作品图和空间图' });
      }
      if (service_type === 'recommend_work' && !spaceFilename) {
        记录提交失败('「根据空间推荐作品」需上传空间图');
        return res.status(400).json({ error: '「根据空间推荐作品」需上传空间图' });
      }
      if (service_type === 'recommend_space' && !hasArtwork) {
        记录提交失败('「一画一宅」需提供作品图');
        return res.status(400).json({ error: '「一画一宅」需提供作品图' });
      }

      const orderId = uuidv4();
      const deliveryToken = uuidv4().replace(/-/g, '').substring(0, 16);
      const serviceLabel = 服务类型映射[service_type];
      const resolvedArtworkSize = artwork_size || (selectedArtwork ? selectedArtwork.size_text || selectedArtwork.size : null);
      const resolvedArtworkName = selectedArtwork ? selectedArtwork.name : (req.body.artwork_name || null);
      const resolvedArtworkCode = selectedArtwork ? selectedArtwork.artwork_code || selectedArtwork.code : null;
      const resolvedArtworkId = selectedArtwork ? selectedArtwork.id : null;
      const resolvedExhibitionId = selectedArtwork ? selectedArtwork.exhibition_id : null;

      const stmt = db.prepare(`
        INSERT INTO orders (
          id, exhibition_id, device_uuid, service_type, service_type_label, receive_method, receive_target, extra_service,
          artwork_image, space_image, delivery_token, openid, user_nickname, user_avatar, artwork_size,
          artwork_num, artwork_name, notes, subscribe_completion, subscribe_template_id, artwork_id, artwork_code,
          entry_platform, entry_source, entry_scene, artwork_selection_method
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        orderId,
        resolvedExhibitionId || null,
        device_uuid || null,
        service_type,
        serviceLabel,
        'email',
        receive_target.trim(),
        extra_service === 'true' || extra_service === '1' ? 1 : 0,
        artworkFilename,
        spaceFilename,
        deliveryToken,
        openid || null,
        user_nickname || null,
        user_avatar || null,
        resolvedArtworkSize || null,
        resolvedArtworkCode || null,
        resolvedArtworkName || null,
        notes || null,
        subscribe_completion === '1' || subscribe_completion === 1 || subscribe_completion === true ? 1 : 0,
        subscribe_template_id || null,
        resolvedArtworkId || null,
        resolvedArtworkCode || null,
        entry_platform || (openid ? 'miniapp' : 'web'),
        entry_source || (openid ? 'miniapp_upload' : 'web_home'),
        entry_scene || null,
        artwork_selection_method || null
      );

      记录应用埋点({
        sessionId: session_id || null,
        deviceUuid: device_uuid || null,
        openid: openid || null,
        orderId,
        exhibitionId: resolvedExhibitionId || null,
        eventName: 'submit_success',
        pageName: 'submit',
        platform: entry_platform || (openid ? 'miniapp' : 'web'),
        serviceType: service_type,
        entrySource: entry_source || (openid ? 'miniapp_upload' : 'web_home'),
        artworkId: resolvedArtworkId || null,
        artworkCode: resolvedArtworkCode || null,
        props: {
          subscribe_completion: subscribe_completion === '1' || subscribe_completion === 1 || subscribe_completion === true,
          extra_service: extra_service === 'true' || extra_service === '1',
          artwork_selection_method: artwork_selection_method || ''
        }
      });

      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      记录订单埋点({
        orderId,
        exhibitionId: resolvedExhibitionId || null,
        deviceUuid: device_uuid || null,
        eventType: 'submit_success',
        pageName: 'submit',
        platform: entry_platform || (openid ? 'miniapp' : 'web'),
        serviceType: service_type,
        actorType: 'user',
        actorId: openid || null,
        eventResult: 'success',
        artworkId: resolvedArtworkId || null,
        artworkCode: resolvedArtworkCode || null,
        payload: {
          entry_source: entry_source || (openid ? 'miniapp_upload' : 'web_home'),
          artwork_selection_method: artwork_selection_method || ''
        }
      });
      发送订单通知到目标机(order).catch(err => console.error('通知发送异常:', err));

      let contentReview = { status: 'not_required', tasks: [] };
      try {
        contentReview = await 提交订单内容安全审核(order);
        记录系统订单事件(order, 'content_review_submitted', {
          status: contentReview.status,
          task_count: Array.isArray(contentReview.tasks) ? contentReview.tasks.length : 0,
          trace_ids: Array.isArray(contentReview.tasks) ? contentReview.tasks.map(item => item.trace_id).filter(Boolean) : []
        });
      } catch (reviewError) {
        内容安全结构化日志('error', 'review.submit_failed', {
          order_id: orderId,
          service_type: order.service_type || '',
          message: reviewError && reviewError.message ? reviewError.message : String(reviewError),
          stack: reviewError && reviewError.stack ? reviewError.stack : '',
          wx_response: reviewError && reviewError.wxResponse ? reviewError.wxResponse : null
        });
        db.prepare(`UPDATE orders SET content_review_status='error', content_review_result_json=?, ai_current_step='内容安全审核暂不可用，已转入人工处理' WHERE id=?`)
          .run(JSON.stringify([{ error: reviewError.message || String(reviewError), wx_response: reviewError && reviewError.wxResponse ? reviewError.wxResponse : null }]), orderId);
        记录系统订单事件(order, 'content_review_submit_failed', { reason: reviewError.message || String(reviewError), wx_response: reviewError && reviewError.wxResponse ? reviewError.wxResponse : null }, 'fail');
        contentReview = { status: 'error', tasks: [] };
      }

      if (['passed', 'not_required', 'skipped'].includes(contentReview.status)) {
        启动订单后续处理(orderId, contentReview.status === 'passed' ? 'wx_img_sec_check_pass' : 'wx_content_review_not_required')
          .catch(err => console.error('订单后续处理启动失败:', err));
      }

      res.json({
        success: true,
        message: '提交成功！处理完成后将通过邮箱通知您。',
        orderId,
        deliveryToken,
        contentReviewStatus: contentReview.status
      });
    } catch (error) {
      try {
        const body = req.body || {};
        记录应用埋点({
          sessionId: body.session_id || null,
          deviceUuid: body.device_uuid || null,
          openid: body.openid || null,
          eventName: 'submit_failed',
          pageName: 'submit',
          platform: body.entry_platform || (body.openid ? 'miniapp' : 'web'),
          serviceType: body.service_type || null,
          entrySource: body.entry_source || (body.openid ? 'miniapp_upload' : 'web_home'),
          artworkId: body.artwork_id || null,
          artworkCode: body.artwork_code || null,
          props: { stage: 'server_exception', reason: error.message || '服务器处理异常' }
        });
      } catch (trackError) {}
      console.error('❌ 订单提交失败:', error);
      res.status(500).json({ error: '服务器处理异常，请稍后重试' });
    }
  }
);

function 检查并处理内容安全审核超时(order) {
  if (!order || order.status !== 'content_reviewing') return false;
  const reason = `内容安全审核超过${CONTENT_REVIEW_TIMEOUT_MINUTES}分钟未完成，请重新提交`;
  const result = db.prepare(`
    UPDATE orders SET
      status='audit_timeout',
      content_review_status='timeout',
      content_review_reject_reason=?,
      content_review_completed_at=datetime('now','localtime'),
      ai_current_step=?
    WHERE id=?
      AND status='content_reviewing'
      AND datetime(created_at) <= datetime('now','localtime', ?)
  `).run(reason, reason, order.id, `-${CONTENT_REVIEW_TIMEOUT_MINUTES} minutes`);

  if (result.changes) {
    记录系统订单事件(order, 'content_review_timeout', {
      timeout_minutes: CONTENT_REVIEW_TIMEOUT_MINUTES,
      trace_ids: 内容安全结果数组(order.content_review_trace_ids_json || '[]')
    }, 'fail');
    内容安全结构化日志('warn', 'review.timeout', {
      order_id: order.id,
      minutes: CONTENT_REVIEW_TIMEOUT_MINUTES,
      trace_ids: 内容安全结果数组(order.content_review_trace_ids_json || '[]')
    });
    return true;
  }
  return false;
}

// ==========================================
// 查询设备最新进行中的订单状态
// GET /api/client/device-status/:uuid
// ==========================================
router.get('/device-status/:uuid', (req, res) => {
  const deviceUuid = req.params.uuid;
  if (!deviceUuid) {
    return res.status(400).json({ error: '缺少设备标识' });
  }

  // 查找该设备最新一笔未完成或已交付的订单（排除已被用户主动重置的）
  let order = db.prepare(`
    SELECT id, service_type, service_type_label, status, delivery_token, delivery_images, delivery_result_records_json, delivery_text, delivered_at, created_at,
           content_review_status, content_review_trace_ids_json, content_review_reject_reason,
           ai_current_step, hanging_status, hanging_exit_code, hanging_failure_context_json, hanging_not_recommended_json,
           primary_wall_rerender_status, primary_wall_rerender_job_id
    FROM orders
    WHERE device_uuid = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(deviceUuid);

  if (!order) {
    return res.json({ hasActiveOrder: false });
  }

  if (检查并处理内容安全审核超时(order)) {
    order = db.prepare(`
      SELECT id, service_type, service_type_label, status, delivery_token, delivery_images, delivery_result_records_json, delivery_text, delivered_at, created_at,
             content_review_status, content_review_trace_ids_json, content_review_reject_reason,
             ai_current_step, hanging_status, hanging_exit_code, hanging_failure_context_json, hanging_not_recommended_json,
             primary_wall_rerender_status, primary_wall_rerender_job_id
      FROM orders WHERE id = ?
    `).get(order.id);
  }

  const clientStatus = 映射客户端订单状态(order.status);

  if (clientStatus === 'pending' || clientStatus === 'processing' || clientStatus === 'content_reviewing' || clientStatus === 'audit_rejected' || clientStatus === 'audit_timeout') {
    return res.json({
      hasActiveOrder: true,
      status: clientStatus,
      orderId: order.id,
      serviceType: order.service_type || '',
      serviceTypeLabel: order.service_type_label,
      deliveryToken: order.delivery_token
    });
  }

  if (clientStatus === 'failed') {
    return res.json({
      hasActiveOrder: true,
      status: 'failed',
      orderId: order.id,
      serviceType: order.service_type || '',
      serviceTypeLabel: order.service_type_label,
      deliveryToken: order.delivery_token,
      failure: buildPublicOrderFailure(order)
    });
  }

  if (clientStatus === 'delivered') {
    return res.json({
      hasActiveOrder: true,
      status: 'delivered',
      orderId: order.id,
      serviceType: order.service_type || '',
      serviceTypeLabel: order.service_type_label,
      deliveryToken: order.delivery_token,
      images: JSON.parse(order.delivery_images || '[]'),
      imageUrls: resolveDeliveryImageUrls(order, { serverBaseUrl: SERVER_BASE_URL }),
      resultRecords: enrichPublicDeliveryResultRecords(order, { serverBaseUrl: SERVER_BASE_URL }),
      text: order.delivery_text || '',
      deliveredAt: order.delivered_at,
      primary_wall_rerender_status: order.primary_wall_rerender_status || 'idle',
      primary_wall_rerender_job_id: order.primary_wall_rerender_job_id || ''
    });
  }

  // 其他状态（如 cancelled 等）视为无活跃订单
  res.json({ hasActiveOrder: false });
});

// ==========================================
// 查询订单交付数据（用于 index 页面轮询）
// GET /api/client/order-status/:orderId
// ==========================================
router.get('/order-status/:orderId', (req, res) => {
  const readOrder = () => db.prepare(`
    SELECT o.id, o.status, o.delivery_token, o.delivery_images, o.delivery_result_records_json, o.delivery_text, o.delivered_at, o.created_at,
           o.service_type, o.service_type_label, o.artwork_name, o.exhibition_id,
           o.content_review_status, o.content_review_trace_ids_json, o.content_review_reject_reason, o.content_review_rejected_at,
           o.ai_current_step, o.ai_progress_pct, o.ai_advisor_progress,
           o.hanging_status, o.hanging_job_id, o.hanging_exit_code, o.hanging_failure_context_json, o.hanging_not_recommended_json, o.ai_engine,
           o.hanging_candidate_records_json,
           o.primary_wall_rerender_status, o.primary_wall_rerender_job_id,
           e.name AS exhibition_name,
           e.status AS exhibition_status,
           e.collection_advisor_name,
           e.collection_advisor_wechat
    FROM orders o
    LEFT JOIN exhibitions e ON e.id = o.exhibition_id
    WHERE o.id = ?
  `).get(req.params.orderId);

  let order = readOrder();

  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (检查并处理内容安全审核超时(order)) {
    order = readOrder();
  }

  const clientStatus = 映射客户端订单状态(order.status);
  const progress = buildOrderProgress(order, clientStatus);
  const hangingCandidateCount = (() => {
    try {
      const arr = JSON.parse(order.hanging_candidate_records_json || '[]');
      return Array.isArray(arr) ? arr.length : 0;
    } catch (_) {
      return 0;
    }
  })();

  const out = {
    status: clientStatus,
    rawStatus: order.status,
    orderId: order.id,
    deliveryToken: order.delivery_token || '',
    serviceType: order.service_type || '',
    serviceTypeLabel: order.service_type_label,
    exhibition_id: order.exhibition_id || '',
    exhibition_name: order.exhibition_name || '',
    exhibition_status: order.exhibition_status || '',
    collection_advisor_name: order.collection_advisor_name || '',
    collection_advisor_wechat: order.collection_advisor_wechat || '',
    exhibition: {
      id: order.exhibition_id || '',
      name: order.exhibition_name || '',
      status: order.exhibition_status || '',
      collection_advisor_name: order.collection_advisor_name || '',
      collection_advisor_wechat: order.collection_advisor_wechat || ''
    },
    currentStep: progress.message || '',
    progress: {
      pct: progress.pct ?? null,
      message: progress.message || '',
      text: progress.text || progress.message || '',
      advisorText: progress.advisorText || '',
      rawStatus: order.status,
      hangingStatus: order.hanging_status || '',
      hangingJobId: order.hanging_job_id || '',
      exitCode: order.hanging_exit_code || ''
    },
    // 让小程序在需要时能直接拿到关键字段（用于展示/埋点/调试）
    ai_current_step: order.ai_current_step || '',
    ai_progress_pct: order.ai_progress_pct ?? null,
    ai_advisor_progress: order.ai_advisor_progress || '',
    advisorProgress: order.ai_advisor_progress || '',
    hanging_status: order.hanging_status || '',
    hanging_job_id: order.hanging_job_id || '',
    hanging_exit_code: order.hanging_exit_code || '',
    ai_engine: order.ai_engine || '',
    hangingCandidateCount,
    hasHangingCandidates: hangingCandidateCount > 0,
    primary_wall_rerender_status: order.primary_wall_rerender_status || 'idle',
    primary_wall_rerender_job_id: order.primary_wall_rerender_job_id || '',
    contentReviewStatus: order.content_review_status || '',
    auditRejectReason: order.content_review_reject_reason || '',
    auditRejectedAt: order.content_review_rejected_at || '',
    auditTimeout: order.status === 'audit_timeout',
    auditTimeoutReason: order.status === 'audit_timeout' ? (order.content_review_reject_reason || order.ai_current_step || '') : '',
    failure: buildPublicOrderFailure(order)
  };

  const eta = etaService.getClientSnapshot(order.hanging_job_id || '', Date.now());
  if (eta) out.eta = eta;

  if (历史记录状态.includes(clientStatus)) {
    out.images = 解析交付图片(order);
    out.imageUrls = resolveDeliveryImageUrls(order, { serverBaseUrl: SERVER_BASE_URL });
    out.resultRecords = enrichPublicDeliveryResultRecords(order, { serverBaseUrl: SERVER_BASE_URL });
    out.text = order.delivery_text || '';
    out.deliveredAt = order.delivered_at;
    out.artworkName = order.artwork_name || '';
  }

  console.log('[order-status:out]', JSON.stringify({
    order_id: order.id,
    db_status: order.status,
    client_status: clientStatus,
    ai_engine: order.ai_engine || '',
    hanging_status: order.hanging_status || '',
    hanging_job_id: order.hanging_job_id || '',
    current_step_len: String(order.ai_current_step || '').length,
    current_step_preview: String(order.ai_current_step || '').slice(0, 100),
    advisor_len: String(order.ai_advisor_progress || '').length,
    progress_pct: order.ai_progress_pct ?? null,
    exit_code: order.hanging_exit_code || '',
    candidate_count: hangingCandidateCount,
    content_review_status: order.content_review_status || '',
    primary_wall_rerender_status: order.primary_wall_rerender_status || 'idle',
    primary_wall_rerender_job_id: order.primary_wall_rerender_job_id || ''
  }));

  res.json(out);
});

// ==========================================
// 等待页挂画候选思考过程
// GET /api/client/hanging-thinking/:orderId
// ==========================================
router.get('/hanging-thinking/:orderId', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const thinking = buildThinking(order);
  if (!thinking) return res.json({ ok: true, ready: false, thinking: null });
  const preferenceState = buildWallPreferenceState(db, order);
  res.json({ ok: true, ready: true, thinking: applyWallPreferenceState(thinking, preferenceState) });
});

// ==========================================
// 用户墙面偏好采集与非首选墙补充渲染请求
// POST /api/client/wall-preferences
// ==========================================
router.post('/wall-preferences', express.json(), (req, res) => {
  const orderId = String(req.body.order_id || req.body.orderId || '').trim();
  const token = String(req.body.delivery_token || req.body.token || '').trim();
  const selectedWallIds = Array.isArray(req.body.selected_wall_ids)
    ? req.body.selected_wall_ids.map(id => String(id || '').trim()).filter(Boolean)
    : [];
  const requestedWallpaperOptIn = req.body.wallpaper_opt_in && typeof req.body.wallpaper_opt_in === 'object' && !Array.isArray(req.body.wallpaper_opt_in)
    ? req.body.wallpaper_opt_in
    : {};
  const preferencePlatform = req.body.platform === 'web' ? 'web' : 'miniapp';
  if (!orderId || selectedWallIds.length === 0) return res.status(400).json({ error: '缺少 order_id 或 selected_wall_ids' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.delivery_token && token !== order.delivery_token) return res.status(403).json({ error: 'delivery_token 校验失败' });

  const thinking = buildThinking(order);
  if (!thinking || !Array.isArray(thinking.candidates)) return res.status(409).json({ error: '候选墙面尚未准备好' });
  const valid = new Map(thinking.candidates.map(c => [String(c.wall_id || ''), c]));
  const uniqueSelected = selectedWallIds.filter((id, index, arr) => id && arr.indexOf(id) === index);
  const unknownSelected = uniqueSelected.find(id => !valid.has(id));
  if (unknownSelected) return res.status(400).json({ error: `未知墙面 ${unknownSelected}` });
  const normalizedSelected = uniqueSelected.slice(0, Number(thinking.max_select || 2));
  if (normalizedSelected.length === 0) return res.status(400).json({ error: '未选择有效候选墙面' });

  let wallpaperOptIn;
  let wallpaperToneByWall;
  try {
    ({ wallpaperOptIn, wallpaperToneByWall } = validateWallpaperOptIn(
      requestedWallpaperOptIn,
      normalizedSelected,
      thinking.candidates
    ));
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message, wall_id: error.wallId || null });
  }

  const supplementWallIds = resolveUserSupplementRenders(normalizedSelected, thinking.primary_wall_id, wallpaperOptIn);
  const constructedJobs = buildSupplementRenderJobsFromOrder(
    Object.assign({}, order, { primary_wall_id: thinking.primary_wall_id }),
    normalizedSelected,
    wallpaperOptIn
  );
  if (supplementWallIds.length && constructedJobs.length !== supplementWallIds.length) {
    const primaryRequested = supplementWallIds.includes(String(thinking.primary_wall_id || ''));
    return res.status(409).json({
      error: primaryRequested
        ? '主推荐墙缺少可复用的 Stage A 底图，无法安全补渲染'
        : '补充渲染所需产物尚未准备好'
    });
  }
  const constructedJobByWall = new Map(constructedJobs.map(job => [String(job.target_wall_ids[0] || ''), job]));
  const supplementJobsByWall = {};
  const jobsToEnqueue = [];
  for (const wallId of supplementWallIds) {
    const wallpaperEnabled = wallpaperOptIn[wallId] === true;
    const tone = wallpaperToneByWall[wallId] || null;
    const supplementRequestKey = `${orderId}:${wallId}:wallpaper=${wallpaperEnabled ? tone.join(',') : 'off'}:soft=${order.service_type !== 'recommend_space' && !!order.extra_service ? 'on' : 'off'}`;
    const existing = db.prepare(`
      SELECT supplement_job_id, supplement_status, supplement_error_code FROM user_wall_preferences
      WHERE order_id = ? AND supplement_request_key = ? AND supplement_job_id != ''
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(orderId, supplementRequestKey);
    const existingFailed = existing && String(existing.supplement_status || '').toLowerCase() === 'failed';
    const failedCurrentPrimaryJob = wallId === String(thinking.primary_wall_id || '') &&
      existing && existing.supplement_job_id === order.primary_wall_rerender_job_id &&
      order.primary_wall_rerender_status === 'failed';
    if (existing && existing.supplement_job_id && !existingFailed && !failedCurrentPrimaryJob) {
      supplementJobsByWall[wallId] = { job_id: existing.supplement_job_id, request_key: supplementRequestKey };
      continue;
    }
    const job = constructedJobByWall.get(wallId);
    if (!job) {
      return res.status(409).json({
        error: wallId === thinking.primary_wall_id
          ? '主推荐墙缺少可复用的 Stage A 底图，无法安全补渲染'
          : '补充渲染所需产物尚未准备好',
        wall_id: wallId
      });
    }
    supplementJobsByWall[wallId] = { job_id: job.job_id, request_key: supplementRequestKey };
    jobsToEnqueue.push(job);
  }
  const insert = db.prepare(`
    INSERT INTO user_wall_preferences (
      id, order_id, chosen_wall_id, chosen_feature_vector_json, rejected_feature_vectors_json,
      rank_at_choice, wallpaper_opt_in, wallpaper_tone_rgb, supplement_request_key, supplement_job_id,
      supplement_status, supplement_error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const primaryJobToEnqueue = jobsToEnqueue.find(job => job.primary_wall_rerender === true) || null;
  const primaryWallId = String(thinking.primary_wall_id || '');
  const primaryRerenderJobId = wallpaperOptIn[primaryWallId] === true && supplementJobsByWall[primaryWallId]
    ? supplementJobsByWall[primaryWallId].job_id
    : null;
  const trx = db.transaction(() => {
    normalizedSelected.forEach((wallId, index) => {
      const chosen = valid.get(wallId);
      const rejected = thinking.candidates
        .filter(c => String(c.wall_id || '') !== wallId)
        .map(c => c.feature_vector || {});
      const supplement = supplementJobsByWall[wallId] || {};
      insert.run(
        uuidv4(),
        orderId,
        wallId,
        JSON.stringify(chosen.feature_vector || {}),
        JSON.stringify(rejected),
        index + 1,
        wallpaperOptIn[wallId] ? 1 : 0,
        wallpaperOptIn[wallId] ? JSON.stringify(wallpaperToneByWall[wallId]) : null,
        supplement.request_key || '',
        supplement.job_id || '',
        supplement.job_id ? 'pending' : 'selected',
        ''
      );
    });
    if (primaryJobToEnqueue) {
      db.prepare(`
        UPDATE orders
        SET primary_wall_rerender_status = 'pending',
            primary_wall_rerender_job_id = ?,
            ai_current_step = '正在为主图优化色彩，稍后自动更新'
        WHERE id = ?
      `).run(primaryJobToEnqueue.job_id, orderId);
    }
  });
  trx();
  jobsToEnqueue.forEach(job => workerHub.enqueueJob(job));

  记录订单埋点({
    orderId,
    deviceUuid: order.device_uuid || null,
    eventType: 'wall_preference_submitted',
    pageName: preferencePlatform === 'web' ? 'index' : 'waiting',
    platform: preferencePlatform,
    serviceType: order.service_type || null,
    actorType: 'user',
    payload: {
      selected_wall_ids: normalizedSelected,
      wallpaper_opt_in: wallpaperOptIn,
      supplement_wall_ids: supplementWallIds,
      supplement_job_ids: supplementWallIds.map(wallId => supplementJobsByWall[wallId] && supplementJobsByWall[wallId].job_id).filter(Boolean)
    }
  });

  const supplementJobIds = supplementWallIds.map(wallId => supplementJobsByWall[wallId] && supplementJobsByWall[wallId].job_id).filter(Boolean);
  res.json({
    ok: true,
    selected_wall_ids: normalizedSelected,
    wallpaper_opt_in: wallpaperOptIn,
    supplement_wall_ids: supplementWallIds,
    supplement_job_id: supplementJobIds[0] || null,
    supplement_job_ids: supplementJobIds,
    primary_wall_id: thinking.primary_wall_id || null,
    primary_wall_rerender_job_id: primaryRerenderJobId,
    primary_wall_rerender_status: primaryJobToEnqueue
      ? 'pending'
      : (primaryRerenderJobId ? (order.primary_wall_rerender_status || 'idle') : 'idle'),
    artifact_ready: Boolean(order.hanging_result_zip_url),
    supplement_status_by_wall: Object.fromEntries(normalizedSelected.map(wallId => [
      wallId,
      supplementJobsByWall[wallId] && supplementJobsByWall[wallId].job_id ? 'pending' : 'selected'
    ]))
  });
});

// ==========================================
// 查询设备/微信账号可见的历史订单
// GET /api/client/device-orders/:uuid?openid=xxx
// ==========================================
router.get('/device-orders/:uuid', (req, res) => {
  const deviceUuid = req.params.uuid;
  const openid = String(req.query.openid || '').trim();
  if (!deviceUuid) {
    return res.status(400).json({ error: '缺少设备标识' });
  }

  const { page, pageSize, offset } = parsePaginationQuery(req.query);
  const historyOnly = req.query.history_only === '1';
  const { whereClause, params } = 构建身份查询条件(deviceUuid, openid, historyOnly);

  const total = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE ${whereClause}`).get(...params).count;
  const orders = db.prepare(`
    SELECT id, service_type, service_type_label, status, delivery_token, delivery_images, delivery_result_records_json, delivery_text, delivered_at, created_at, artwork_name, openid, device_uuid
    FROM orders
    WHERE ${whereClause}
    ORDER BY COALESCE(delivered_at, created_at) DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset).map(order => ({
    ...order,
    status: 映射客户端订单状态(order.status),
    images: 解析交付图片(order),
    imageUrls: resolveDeliveryImageUrls(order, { serverBaseUrl: SERVER_BASE_URL }),
    resultRecords: enrichPublicDeliveryResultRecords(order, { serverBaseUrl: SERVER_BASE_URL })
  }));

  res.json({
    orders,
    total,
    page,
    pageSize,
    hasMore: offset + orders.length < total,
    identityMode: openid ? 'wechat' : 'device'
  });
});

// ==========================================
// 标记为已查收（用户在 index 页加载了交付图）
// POST /api/client/mark-viewed/:orderId
// ==========================================
router.post('/mark-viewed/:orderId', express.json(), (req, res) => {
  const order = db.prepare('SELECT id, status, device_uuid, service_type, artwork_id, artwork_code FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  if (order.status === 'delivered') {
    db.prepare("UPDATE orders SET status = 'viewed', viewed_at = datetime('now','localtime') WHERE id = ?").run(req.params.orderId);
  }

  记录订单埋点({
    orderId: req.params.orderId,
    deviceUuid: (req.body && req.body.device_uuid) || order.device_uuid || null,
    eventType: 'result_view',
    pageName: 'result',
    platform: (req.body && req.body.platform) || 'client',
    serviceType: order.service_type || null,
    actorType: 'user',
    artworkId: order.artwork_id || null,
    artworkCode: order.artwork_code || null,
    payload: { source: 'mark_viewed' }
  });

  res.json({ success: true });
});

// ==========================================
// 标记为已下载（用户长按保存了图片）
// POST /api/client/mark-downloaded/:orderId
// ==========================================
router.post('/mark-downloaded/:orderId', express.json(), (req, res) => {
  const order = db.prepare('SELECT id, status, device_uuid, service_type, artwork_id, artwork_code FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  if (['delivered', 'viewed'].includes(order.status)) {
    db.prepare("UPDATE orders SET status = 'downloaded', downloaded_at = datetime('now','localtime') WHERE id = ?").run(req.params.orderId);
  }

  记录订单埋点({
    orderId: req.params.orderId,
    deviceUuid: (req.body && req.body.device_uuid) || order.device_uuid || null,
    eventType: 'image_download',
    imageIndex: Number.isFinite(Number(req.body && req.body.image_index)) ? Number(req.body.image_index) : null,
    imageUrl: (req.body && req.body.image_url) || null,
    pageName: (req.body && req.body.page_name) || 'result',
    platform: (req.body && req.body.platform) || 'client',
    serviceType: order.service_type || null,
    actorType: 'user',
    artworkId: order.artwork_id || null,
    artworkCode: order.artwork_code || null,
    payload: { source: 'mark_downloaded' }
  });

  res.json({ success: true });
});

// ==========================================
// 扫码全屏效果图入口
// GET /api/client/scan-entry?artworkCode=AW-2604-0001
// ==========================================
router.get('/scan-entry', (req, res) => {
  try {
    const artwork = 解析作品请求(req.query || {});
    if (!artwork || !Array.isArray(artwork.effect_images) || !artwork.effect_images[0]) {
      return res.json({ ok: false, redirect: '/pages/index/index' });
    }
    const exhibitionFields = 作品展览响应字段(artwork);
    res.json({
      ok: true,
      redirect: '',
      ...exhibitionFields,
      artwork: {
        id: artwork.id,
        artwork_code: artwork.artwork_code,
        scan_token: artwork.scan_token || '',
        name: artwork.name,
        author: artwork.author,
        hero_image: artwork.effect_images[0],
        effect_images: artwork.effect_images,
        scan_page_path: artwork.scan_page_path || 'pages/scan-entry/index',
        scan_page_display_path: artwork.scan_page_display_path || '',
        scan_scene: artwork.scan_scene || '',
        ...exhibitionFields
      }
    });
  } catch (e) {
    res.json({ ok: false, redirect: '/pages/index/index' });
  }
});

// ==========================================
// 获取预设作品列表（拍卖版专用）
// GET /api/client/artworks
// ==========================================
router.get('/thumb', async (req, res) => {
  const sourceUrl = String(req.query.url || req.query.src || '').trim();
  const width = Math.max(80, Math.min(Number(req.query.w) || 480, 1600));
  const height = Math.max(0, Math.min(Number(req.query.h) || 0, 1600));
  const quality = Math.max(60, Math.min(Number(req.query.q) || 82, 96));
  const fit = ['cover', 'contain', 'inside'].includes(String(req.query.fit || '').trim()) ? String(req.query.fit).trim() : 'inside';

  if (!sourceUrl) {
    return res.status(400).json({ error: '缺少图片地址' });
  }

  if (!isAllowedThumbnailSource(sourceUrl)) {
    return res.status(400).json({ error: '图片地址不受支持' });
  }

  try {
    const { buffer, contentType } = await getThumbnailBuffer({
      sourceUrl,
      width,
      height,
      quality,
      fit
    });

    res.set('Content-Type', contentType || 'image/webp');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(buffer);
  } catch (error) {
    console.error('thumbnail route error:', error);
    return res.status(500).json({ error: '缩略图生成失败' });
  }
});

router.get('/exhibitions', (req, res) => {
  try {
    const status = String(req.query.status || 'live').trim() || 'live';
    const exhibitions = listExhibitions({ status, includeCounts: false });
    res.json({ exhibitions });
  } catch (error) {
    res.status(500).json({ error: error.message || '展览列表加载失败' });
  }
});

router.post('/exhibitions/locate', express.json(), (req, res) => {
  const body = req.body || {};
  const demoId = String(body.demo_exhibition_id || '').trim();
  if (demoId) {
    const exhibition = getExhibitionById(demoId, { includeCounts: false });
    if (!exhibition || exhibition.status !== 'live') return res.status(404).json({ error: '演示展览不存在' });
    return res.json({ enabled: true, demo: true, exhibition, distance_m: 0 });
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: '缺少有效坐标' });
  const radians = value => value * Math.PI / 180;
  const distance = item => {
    const dLat = radians(Number(item.geo_lat) - lat);
    const dLng = radians(Number(item.geo_lng) - lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat)) * Math.cos(radians(Number(item.geo_lat))) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
  const matches = listExhibitions({ status: 'live', includeCounts: false })
    .filter(item => Number.isFinite(Number(item.geo_lat)) && Number.isFinite(Number(item.geo_lng)))
    .map(item => ({ exhibition: item, distance_m: Math.round(distance(item)) }))
    .filter(item => item.distance_m <= Math.max(1, Number(item.exhibition.geo_radius_m) || 400))
    .sort((a, b) => a.distance_m - b.distance_m);
  res.json({ enabled: true, exhibition: matches[0] ? matches[0].exhibition : null, distance_m: matches[0] ? matches[0].distance_m : null });
});

router.get('/artworks', (req, res) => {
  try {
    const scope = resolveClientExhibitionScope(req.query.exhibition_id);
    if (scope.needExhibition) return res.json({ artworks: [], need_exhibition: true });
    const keyword = String(req.query.q || '').trim();
    const artworks = listArtworks({ keyword, status: req.query.status || 'published', exhibitionId: scope.exhibitionId });
    res.json({ artworks, exhibition: scope.exhibition, need_exhibition: false });
  } catch (e) {
    res.status(500).json({ error: '作品列表加载失败' });
  }
});

router.get('/artworks-lite', (req, res) => {
  try {
    const scope = resolveClientExhibitionScope(req.query.exhibition_id);
    if (scope.needExhibition) return res.json({ artworks: [], need_exhibition: true });
    const keyword = String(req.query.q || '').trim();
    const status = String(req.query.status || 'published').trim() || 'published';
    const artworks = [];
    let cursor = 0;
    let guard = 0;

    while (guard < 200) {
      const result = listArtworksLite({ keyword, status, exhibitionId: scope.exhibitionId, limit: 120, cursor });
      if (result && Array.isArray(result.artworks) && result.artworks.length) artworks.push(...result.artworks);
      if (!result || !result.has_more || !result.next_cursor) break;
      cursor = Number(result.next_cursor) || 0;
      if (cursor <= 0) break;
      guard += 1;
    }

    res.json({ artworks, exhibition: scope.exhibition, need_exhibition: false });
  } catch (e) {
    console.error('client artworks-lite error:', e);
    res.status(500).json({ error: '作品列表加载失败' });
  }
});

router.get('/artworks/resolve', (req, res) => {
  try {
    const artwork = 解析作品请求(req.query || {});
    if (!artwork) return res.status(404).json({ error: '未找到对应作品' });
    const exhibitionFields = 作品展览响应字段(artwork);
    res.json({ artwork: { ...artwork, ...exhibitionFields }, ...exhibitionFields });
  } catch (e) {
    res.status(500).json({ error: '作品识别失败' });
  }
});

router.post('/app-events', express.json(), (req, res) => {
  const {
    session_id,
    device_uuid,
    openid,
    order_id,
    exhibition_id,
    event_name,
    page_name,
    platform,
    service_type,
    entry_source,
    artwork_id,
    artwork_code,
    ...props
  } = req.body || {};

  if (!event_name) {
    return res.status(400).json({ error: '缺少 event_name' });
  }

  let order = null;
  if (order_id) {
    order = db.prepare('SELECT id, exhibition_id, service_type, artwork_id, artwork_code, device_uuid, openid FROM orders WHERE id = ?').get(order_id);
  }

  const eventArtwork = artwork_id
    ? getArtworkById(artwork_id)
    : (artwork_code && exhibition_id ? findArtworkByCodeInExhibition(artwork_code, exhibition_id) : null);
  const resolvedEventExhibitionId = (order && order.exhibition_id) || (eventArtwork && eventArtwork.exhibition_id) || exhibition_id || null;

  记录应用埋点({
    sessionId: session_id || null,
    deviceUuid: device_uuid || (order && order.device_uuid) || null,
    openid: openid || (order && order.openid) || null,
    orderId: order_id || null,
    exhibitionId: resolvedEventExhibitionId,
    eventName: event_name,
    pageName: page_name || null,
    platform: platform || 'client',
    serviceType: service_type || (order && order.service_type) || null,
    entrySource: entry_source || null,
    artworkId: artwork_id || (order && order.artwork_id) || null,
    artworkCode: artwork_code || (order && order.artwork_code) || null,
    props
  });

  res.json({ success: true });
});

router.post('/order-events', express.json(), (req, res) => {
  const { order_id, event_type, device_uuid, image_index, image_url, page_name, stay_ms, entered_at, left_at, ...payload } = req.body || {};
  if (!order_id || !event_type) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const order = db.prepare('SELECT id, exhibition_id, device_uuid, service_type, artwork_id, artwork_code, openid FROM orders WHERE id = ?').get(order_id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  记录订单埋点({
    orderId: order_id,
    exhibitionId: order.exhibition_id || null,
    deviceUuid: device_uuid || order.device_uuid || null,
    eventType: event_type,
    imageIndex: Number.isFinite(Number(image_index)) ? Number(image_index) : null,
    imageUrl: image_url || null,
    pageName: page_name || null,
    stayMs: Number.isFinite(Number(stay_ms)) ? Number(stay_ms) : null,
    enteredAt: entered_at || null,
    leftAt: left_at || null,
    platform: payload.platform || 'client',
    serviceType: order.service_type || null,
    actorType: 'user',
    actorId: order.openid || null,
    artworkId: order.artwork_id || null,
    artworkCode: order.artwork_code || null,
    payload
  });

  res.json({ success: true });
});

router.wxMediaCheckVerifyHandler = 微信内容安全回调校验处理;
router.wxMediaCheckRawHandler = 微信内容安全回调原始处理;

module.exports = router;
