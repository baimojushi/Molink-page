// services/contentReviewMedia.js —— 微信内容安全审核图片的持久化发布与公网预检
// 审核图默认上传到 R2，避免多实例、本地临时盘和部署重启导致微信回调 -1008。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const {
  R2_PUBLIC_BASE_URL,
  isR2Configured,
  uploadBuffer
} = require('./r2');

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

const CONTENT_REVIEW_MEDIA_STORAGE = cleanEnv(process.env.CONTENT_REVIEW_MEDIA_STORAGE || 'r2').toLowerCase();
const CONTENT_REVIEW_R2_PREFIX = cleanEnv(process.env.CONTENT_REVIEW_R2_PREFIX || '_content_review').replace(/^\/+|\/+$/g, '') || '_content_review';
const CONTENT_REVIEW_PUBLIC_PREFLIGHT = String(process.env.CONTENT_REVIEW_PUBLIC_PREFLIGHT || '1') !== '0';
const CONTENT_REVIEW_PREFLIGHT_TIMEOUT_MS = parsePositiveInt(process.env.CONTENT_REVIEW_PREFLIGHT_TIMEOUT_MS, 12000, 1000, 60000);
const CONTENT_REVIEW_PREFLIGHT_ATTEMPTS = parsePositiveInt(process.env.CONTENT_REVIEW_PREFLIGHT_ATTEMPTS, 3, 1, 6);
const CONTENT_REVIEW_PREFLIGHT_MAX_BYTES = parsePositiveInt(process.env.CONTENT_REVIEW_PREFLIGHT_MAX_BYTES, 11 * 1024 * 1024, 1024, 20 * 1024 * 1024);
const CONTENT_REVIEW_ALLOW_LOCAL_FALLBACK = String(process.env.CONTENT_REVIEW_ALLOW_LOCAL_FALLBACK || '') === '1';

function safeSegment(value, fallback = 'unknown') {
  const cleaned = String(value || '').trim()
    .replace(/[\\/:*?"<>|#%{}\[\]^~`]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return cleaned || fallback;
}

function sanitizePublicBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch (error) {
    return text.split('?')[0].replace(/\/+$/, '');
  }
}

function buildContentReviewObjectKey({ orderId, field, attempt = 0, filename = '' }) {
  const order = safeSegment(orderId, 'order');
  const imageField = safeSegment(field, 'image');
  const base = safeSegment(path.basename(filename || 'audit', path.extname(filename || '')), 'audit').slice(0, 48);
  const nonce = crypto.randomBytes(8).toString('hex');
  return `${CONTENT_REVIEW_R2_PREFIX}/${order}/${imageField}/a${Number(attempt) || 0}-${Date.now()}-${nonce}-${base}.jpg`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestPublicImageOnce(url, {
  timeoutMs = CONTENT_REVIEW_PREFLIGHT_TIMEOUT_MS,
  maxBytes = CONTENT_REVIEW_PREFLIGHT_MAX_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      return reject(new Error(`审核图片公网 URL 无效：${url}`));
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return reject(new Error(`审核图片公网 URL 协议不支持：${parsed.protocol}`));
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        Accept: 'image/*,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; MicroMessenger; MolinkContentSecurityPreflight/1.0)',
        'Cache-Control': 'no-cache'
      }
    }, res => {
      const chunks = [];
      let receivedBytes = 0;
      let aborted = false;

      res.on('data', chunk => {
        if (aborted) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.length;
        if (receivedBytes > maxBytes) {
          aborted = true;
          res.destroy(new Error(`审核图片公网响应超过限制：${receivedBytes} bytes`));
          return;
        }
        chunks.push(buffer);
      });
      res.on('end', () => {
        if (aborted) return;
        const body = Buffer.concat(chunks);
        resolve({
          ok: Number(res.statusCode || 0) === 200,
          http_status: Number(res.statusCode || 0),
          content_type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
          content_length_header: Number(res.headers['content-length'] || 0),
          received_bytes: body.length,
          sha256: sha256(body),
          location: String(res.headers.location || ''),
          duration_ms: Date.now() - startedAt
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`审核图片公网预检超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    req.end();
  });
}

function validatePreflight(result, { expectedBytes = 0, expectedSha256 = '' } = {}) {
  if (!result || Number(result.http_status || 0) !== 200) {
    return `HTTP 状态不是 200（${Number(result && result.http_status || 0)}）`;
  }
  if (!String(result.content_type || '').startsWith('image/')) {
    return `Content-Type 不是图片（${result.content_type || 'empty'}）`;
  }
  if (Number(result.received_bytes || 0) <= 0) {
    return '公网响应图片为空';
  }
  if (expectedBytes && Number(result.received_bytes || 0) !== Number(expectedBytes)) {
    return `公网图片字节数不一致（expected=${expectedBytes}, received=${result.received_bytes}）`;
  }
  if (expectedSha256 && result.sha256 !== expectedSha256) {
    return '公网图片 SHA-256 与上传内容不一致';
  }
  return '';
}

async function preflightPublicImage({
  url,
  expectedBytes = 0,
  expectedSha256 = '',
  attempts = CONTENT_REVIEW_PREFLIGHT_ATTEMPTS,
  timeoutMs = CONTENT_REVIEW_PREFLIGHT_TIMEOUT_MS
}) {
  let lastResult = null;
  let lastError = null;
  const maxAttempts = parsePositiveInt(attempts, CONTENT_REVIEW_PREFLIGHT_ATTEMPTS, 1, 6);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await requestPublicImageOnce(url, { timeoutMs });
      const validationError = validatePreflight(result, { expectedBytes, expectedSha256 });
      lastResult = { ...result, attempt, validation_error: validationError };
      if (!validationError) {
        return { ...lastResult, ok: true };
      }
      lastError = new Error(validationError);
    } catch (error) {
      lastError = error;
      lastResult = {
        ok: false,
        attempt,
        http_status: 0,
        content_type: '',
        received_bytes: 0,
        duration_ms: 0,
        validation_error: error && error.message ? error.message : String(error)
      };
    }
    if (attempt < maxAttempts) await sleep(Math.min(1500, 250 * attempt));
  }

  const error = new Error(`审核图片公网预检失败：${lastError && lastError.message ? lastError.message : 'unknown'}`);
  error.code = 'CONTENT_REVIEW_PUBLIC_PREFLIGHT_FAILED';
  error.preflight = lastResult;
  throw error;
}

async function publishContentReviewImage({
  absolutePath,
  localUrl = '',
  orderId,
  field,
  attempt = 0,
  expectedBytes = 0
}) {
  const body = await fs.promises.readFile(absolutePath);
  if (!body.length) throw new Error(`审核图片文件为空：${absolutePath}`);
  if (expectedBytes && Number(expectedBytes) !== body.length) {
    throw new Error(`审核图片本地字节数变化：expected=${expectedBytes}, actual=${body.length}`);
  }

  const digest = sha256(body);
  let storage = CONTENT_REVIEW_MEDIA_STORAGE;
  let mediaUrl = '';
  let objectKey = '';

  if (storage !== 'local') {
    if (!isR2Configured()) {
      if (!CONTENT_REVIEW_ALLOW_LOCAL_FALLBACK) {
        const error = new Error('内容安全审核图要求上传 R2，但缺少 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY');
        error.code = 'CONTENT_REVIEW_R2_NOT_CONFIGURED';
        throw error;
      }
      storage = 'local';
    } else {
      objectKey = buildContentReviewObjectKey({
        orderId,
        field,
        attempt,
        filename: absolutePath
      });
      const uploaded = await uploadBuffer({
        key: objectKey,
        body,
        contentType: 'image/jpeg',
        cacheControl: 'no-store, max-age=0'
      });
      mediaUrl = uploaded.url;
      storage = 'r2';
    }
  }

  if (storage === 'local') {
    if (!localUrl) throw new Error('内容安全审核图本地模式缺少公网 URL');
    mediaUrl = localUrl;
  }

  const preflight = CONTENT_REVIEW_PUBLIC_PREFLIGHT
    ? await preflightPublicImage({
        url: mediaUrl,
        expectedBytes: body.length,
        expectedSha256: digest
      })
    : { ok: null, skipped: true };

  return {
    media_url: mediaUrl,
    media_storage: storage,
    media_key: objectKey,
    media_size: body.length,
    media_sha256: digest,
    public_preflight: preflight
  };
}

function describeContentReviewMediaConfig() {
  return {
    storage_mode: CONTENT_REVIEW_MEDIA_STORAGE,
    r2_configured: isR2Configured(),
    r2_public_base_url: sanitizePublicBaseUrl(R2_PUBLIC_BASE_URL),
    public_preflight: CONTENT_REVIEW_PUBLIC_PREFLIGHT,
    preflight_attempts: CONTENT_REVIEW_PREFLIGHT_ATTEMPTS,
    preflight_timeout_ms: CONTENT_REVIEW_PREFLIGHT_TIMEOUT_MS,
    allow_local_fallback: CONTENT_REVIEW_ALLOW_LOCAL_FALLBACK
  };
}

module.exports = {
  buildContentReviewObjectKey,
  preflightPublicImage,
  publishContentReviewImage,
  describeContentReviewMediaConfig
};
