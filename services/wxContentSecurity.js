// services/wxContentSecurity.js —— 微信官方多媒体内容安全审核
// 使用小程序 mediaCheckAsync 2.0 异步接口。只在服务端调用，不在小程序前端暴露 access_token。

const https = require('https');
const { getWxMiniappCredentials } = require('./wxMiniappConfig');
const MEDIA_CHECK_SCENE = Number(process.env.WX_MEDIA_CHECK_SCENE || 1); // 1 资料；2 评论；3 论坛；4 社交日志
const REQUEST_TIMEOUT_MS = Number(process.env.WX_MEDIA_CHECK_TIMEOUT_MS || 12000);
const CONTENT_SECURITY_LOG_RAW = String(process.env.CONTENT_SECURITY_LOG_RAW || '') === '1';
const CONTENT_SECURITY_LOG_MAX_CHARS = Math.max(1000, Number(process.env.CONTENT_SECURITY_LOG_MAX_CHARS || 12000) || 12000);
const WX_IMG_SEC_CHECK_TIMEOUT_MS = Math.max(3000, Number(process.env.WX_IMG_SEC_CHECK_TIMEOUT_MS || 20000) || 20000);
const WX_IMG_SEC_CHECK_MAX_BYTES = Math.max(64 * 1024, Math.min(1024 * 1024, Number(process.env.WX_IMG_SEC_CHECK_MAX_BYTES || 1024 * 1024) || 1024 * 1024));


let accessTokenCache = { token: '', expireAt: 0 };

function truncateForLog(value, maxChars = CONTENT_SECURITY_LOG_MAX_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text || text.length <= maxChars) return text || '';
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

function sanitizeUrlForLog(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (error) {
    return text.split('?')[0];
  }
}

function structuredLog(level, event, payload) {
  const output = truncateForLog({ event, ...payload });
  const logger = console[level] || console.log;
  logger.call(console, `[content-security] ${output}`);
}

function requestJson(url, body = null, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body == null ? null : JSON.stringify(body);
    const startedAt = Date.now();
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: payload ? 'POST' : 'GET',
      timeout: options.timeout || REQUEST_TIMEOUT_MS,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data || '{}');
          const responseData = parsedData && typeof parsedData === 'object'
            ? parsedData
            : { data: parsedData };
          Object.defineProperty(responseData, '__http_status', {
            value: Number(res.statusCode || 0),
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(responseData, '__duration_ms', {
            value: Date.now() - startedAt,
            enumerable: false,
            configurable: true
          });
          resolve(responseData);
        } catch (error) {
          const parseError = new Error(`微信接口返回非 JSON：${data.slice(0, 160)}`);
          parseError.httpStatus = Number(res.statusCode || 0);
          parseError.durationMs = Date.now() - startedAt;
          reject(parseError);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('微信内容安全接口超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getAccessToken() {
  const now = Date.now();
  if (accessTokenCache.token && accessTokenCache.expireAt - 60000 > now) {
    return accessTokenCache.token;
  }
  const wxConfig = getWxMiniappCredentials();
  if (!wxConfig.appid || !wxConfig.secret) {
    throw new Error('缺少微信小程序 AppID 或 AppSecret，无法调用微信内容安全审核');
  }
  structuredLog('log', 'access_token.request', {
    appid: wxConfig.maskedAppid,
    appid_source: wxConfig.appidSource || 'unknown',
    secret_source: wxConfig.secretSource || 'unknown'
  });
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(wxConfig.appid)}&secret=${encodeURIComponent(wxConfig.secret)}`;
  const data = await requestJson(url, null);
  if (!data.access_token) {
    structuredLog('error', 'access_token.failed', {
      http_status: data.__http_status || 0,
      duration_ms: data.__duration_ms || 0,
      errcode: Number(data.errcode || 0),
      errmsg: data.errmsg || ''
    });
    throw new Error(`获取微信 access_token 失败：${data.errmsg || data.errcode || 'unknown'}`);
  }
  accessTokenCache = {
    token: data.access_token,
    expireAt: now + Math.max(300, Number(data.expires_in || 7200)) * 1000
  };
  structuredLog('log', 'access_token.success', {
    http_status: data.__http_status || 0,
    duration_ms: data.__duration_ms || 0,
    expires_in: Number(data.expires_in || 7200)
  });
  return accessTokenCache.token;
}

function normalizeOpenid(openid) {
  return String(openid || '').trim();
}

function normalizeMediaUrl(mediaUrl) {
  return String(mediaUrl || '').trim();
}

function normalizeSuggest(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeDetailItem(item, index = 0) {
  const source = item && typeof item === 'object' ? item : {};
  return {
    index,
    strategy: String(source.strategy || source.keyword || source.category || '').trim(),
    errcode: Number(source.errcode || 0),
    suggest: normalizeSuggest(source.suggest),
    label: Number(source.label || 0),
    prob: Number.isFinite(Number(source.prob)) ? Number(source.prob) : null
  };
}

function collectCallbackDetails(payload) {
  const result = payload && typeof payload.result === 'object' ? payload.result : {};
  const candidates = [
    payload && payload.detail,
    payload && payload.details,
    result && result.detail,
    result && result.details
  ];
  const raw = candidates.find(Array.isArray) || [];
  return raw.map((item, index) => normalizeDetailItem(item, index));
}

function isMediaDownloadError(errcode, errmsg = '') {
  const code = Number(errcode || 0);
  const message = String(errmsg || '').toLowerCase();
  return code === -1008 || message.includes('下载错误') || message.includes('download error') || message.includes('media download');
}

function contentReviewDecisionFromSuggest(suggest, errcode = 0) {
  const normalized = normalizeSuggest(suggest);
  if (Number(errcode) !== 0) return 'error';
  if (normalized === 'pass') return 'pass';
  if (normalized === 'risky') return 'reject';
  if (normalized === 'review') return 'manual_review';
  return 'pending';
}

function decisionPriority(decision) {
  const priorities = {
    error: 60,
    reject: 50,
    manual_review: 30,
    pass: 20,
    pending: 10
  };
  return priorities[decision] || 0;
}

function normalizeMediaCheckCallback(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const result = source.result && typeof source.result === 'object' ? source.result : {};
  const detail = collectCallbackDetails(source);
  const topLevelErrcode = Number(source.errcode || result.errcode || 0);
  const topLevelSuggest = normalizeSuggest(result.suggest || source.suggest || '');
  const topLevelLabel = Number(result.label || source.label || 0);

  const candidates = [
    {
      source: 'top_level',
      errcode: topLevelErrcode,
      suggest: topLevelSuggest,
      label: topLevelLabel,
      decision: contentReviewDecisionFromSuggest(topLevelSuggest, topLevelErrcode)
    },
    ...detail.map(item => ({
      source: `detail[${item.index}]`,
      errcode: item.errcode,
      suggest: item.suggest,
      label: item.label,
      decision: contentReviewDecisionFromSuggest(item.suggest, item.errcode)
    }))
  ];

  const meaningful = candidates.filter(item => item.errcode !== 0 || item.suggest || item.label);
  const selected = (meaningful.length ? meaningful : candidates)
    .slice()
    .sort((left, right) => decisionPriority(right.decision) - decisionPriority(left.decision))[0];

  return {
    trace_id: String(source.trace_id || source.traceId || '').trim(),
    event: String(source.Event || source.event || '').trim(),
    errcode: Number(selected?.errcode || topLevelErrcode || 0),
    errmsg: String(source.errmsg || result.errmsg || '').trim(),
    suggest: normalizeSuggest(selected?.suggest || topLevelSuggest),
    label: Number(selected?.label || topLevelLabel || 0),
    decision: selected?.decision || 'pending',
    decision_source: selected?.source || 'top_level',
    detail
  };
}

function summarizeMediaCheckCallback(payload) {
  const normalized = normalizeMediaCheckCallback(payload);
  return {
    trace_id: normalized.trace_id,
    event: normalized.event,
    errcode: normalized.errcode,
    errmsg: normalized.errmsg,
    suggest: normalized.suggest,
    label: normalized.label,
    decision: normalized.decision,
    decision_source: normalized.decision_source,
    detail_count: normalized.detail.length,
    detail: normalized.detail
  };
}

function normalizeImgSecCheckResponse(data) {
  const source = data && typeof data === 'object' ? data : {};
  const errcode = Number(source.errcode || 0);
  const errmsg = String(source.errmsg || '').trim();
  const rejected = errcode === 87014;
  return {
    errcode,
    errmsg,
    suggest: rejected ? 'risky' : (errcode === 0 ? 'pass' : ''),
    label: 0,
    decision: rejected ? 'reject' : (errcode === 0 ? 'pass' : 'error'),
    decision_source: 'img_sec_check',
    raw: source
  };
}

function requestMultipartImage(url, {
  imageBuffer,
  filename = 'wxcheck.jpg',
  contentType = 'image/jpeg',
  timeout = WX_IMG_SEC_CHECK_TIMEOUT_MS
}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const boundary = `----MolinkWxImgSec${require('crypto').randomBytes(12).toString('hex')}`;
    const safeFilename = String(filename || 'wxcheck.jpg').replace(/["\\\r\n]/g, '_');
    const safeContentType = String(contentType || 'image/jpeg').replace(/[\r\n]/g, '');
    const prefix = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${safeContentType}\r\n\r\n`,
      'utf8'
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const payloadLength = prefix.length + imageBuffer.length + suffix.length;
    const startedAt = Date.now();
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payloadLength,
        Accept: 'application/json'
      }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data || '{}');
          Object.defineProperty(parsedData, '__http_status', {
            value: Number(res.statusCode || 0), enumerable: false, configurable: true
          });
          Object.defineProperty(parsedData, '__duration_ms', {
            value: Date.now() - startedAt, enumerable: false, configurable: true
          });
          resolve(parsedData);
        } catch (error) {
          const parseError = new Error(`微信图片内容安全接口返回非 JSON：${data.slice(0, 160)}`);
          parseError.httpStatus = Number(res.statusCode || 0);
          parseError.durationMs = Date.now() - startedAt;
          reject(parseError);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('微信图片内容安全接口超时')));
    req.on('error', reject);
    req.write(prefix);
    req.write(imageBuffer);
    req.end(suffix);
  });
}

async function imgSecCheck({ imageBuffer, filename = 'wxcheck.jpg', contentType = 'image/jpeg' }) {
  const body = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer || '');
  if (!body.length) throw new Error('缺少待审核图片二进制数据');
  if (body.length > WX_IMG_SEC_CHECK_MAX_BYTES) {
    const error = new Error(`微信同步图片审核文件超过 1MB 限制：${body.length} bytes`);
    error.code = 'WX_IMG_SEC_CHECK_FILE_TOO_LARGE';
    throw error;
  }

  const accessToken = await getAccessToken();
  const url = `https://api.weixin.qq.com/wxa/img_sec_check?access_token=${encodeURIComponent(accessToken)}`;
  structuredLog('log', 'image_check.submit.request', {
    transport: 'multipart_binary',
    filename: String(filename || ''),
    content_type: String(contentType || ''),
    bytes: body.length
  });
  const data = await requestMultipartImage(url, {
    imageBuffer: body,
    filename,
    contentType
  });
  const normalized = normalizeImgSecCheckResponse(data);
  structuredLog(normalized.decision === 'error' ? 'error' : 'log', 'image_check.submit.response', {
    transport: 'multipart_binary',
    http_status: data.__http_status || 0,
    duration_ms: data.__duration_ms || 0,
    errcode: normalized.errcode,
    errmsg: normalized.errmsg,
    decision: normalized.decision,
    ...(CONTENT_SECURITY_LOG_RAW ? { raw: data } : {})
  });
  if (normalized.decision === 'error') {
    const error = new Error(`微信同步图片内容安全审核失败：${normalized.errmsg || normalized.errcode || 'unknown'}`);
    error.code = 'WX_IMG_SEC_CHECK_FAILED';
    error.wxResponse = data;
    throw error;
  }
  return normalized;
}

async function mediaCheckAsync({ mediaUrl, openid, mediaType = 2, scene = MEDIA_CHECK_SCENE }) {
  const normalizedUrl = normalizeMediaUrl(mediaUrl);
  const normalizedOpenid = normalizeOpenid(openid);
  if (!normalizedUrl) throw new Error('缺少 media_url');
  if (!normalizedOpenid) throw new Error('缺少 openid，无法调用微信内容安全审核');

  const accessToken = await getAccessToken();
  const url = `https://api.weixin.qq.com/wxa/media_check_async?access_token=${encodeURIComponent(accessToken)}`;
  const payload = {
    openid: normalizedOpenid,
    scene: Number(scene) || 1,
    version: 2,
    media_url: normalizedUrl,
    media_type: Number(mediaType) || 2
  };
  structuredLog('log', 'media_check.submit.request', {
    media_type: payload.media_type,
    scene: payload.scene,
    openid_present: Boolean(normalizedOpenid),
    media_url: sanitizeUrlForLog(normalizedUrl)
  });
  const data = await requestJson(url, payload);
  structuredLog(Number(data.errcode || 0) === 0 ? 'log' : 'error', 'media_check.submit.response', {
    http_status: data.__http_status || 0,
    duration_ms: data.__duration_ms || 0,
    errcode: Number(data.errcode || 0),
    trace_id: data.trace_id || '',
    errmsg: data.errmsg || '',
    ...(CONTENT_SECURITY_LOG_RAW ? { raw: data } : {})
  });
  if (Number(data.errcode || 0) !== 0 || !data.trace_id) {
    const message = data.errmsg || data.errcode || 'unknown';
    const err = new Error(`微信内容安全提交失败：${message}`);
    err.wxResponse = data;
    throw err;
  }
  return {
    trace_id: String(data.trace_id),
    errcode: Number(data.errcode || 0),
    errmsg: data.errmsg || 'ok',
    request: payload,
    response: data
  };
}

module.exports = {
  mediaCheckAsync,
  imgSecCheck,
  normalizeImgSecCheckResponse,
  contentReviewDecisionFromSuggest,
  isMediaDownloadError,
  normalizeMediaCheckCallback,
  summarizeMediaCheckCallback,
  sanitizeUrlForLog,
  truncateForLog
};
