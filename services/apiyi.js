// services/apiyi.js —— Apiyi (Gemini 3 Pro Image) 生图适配器
// 兼容 submitImageRequest / checkExecution / downloadFile 接口
// 异步本地队列、任务持久化、模型 fallback、兼容多种返回图片格式。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const sharp = require('sharp');

const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const JOB_DIR = path.join(DATA_ROOT, 'ai-jobs');
const UPLOADS_DIR = path.join(DATA_ROOT, 'uploads');
const AI_UPLOADS_DIR = path.join(UPLOADS_DIR, 'ai');
const JOB_FILE = path.join(JOB_DIR, 'apiyi-jobs.json');

const SERVER_BASE_URL = String(process.env.SERVER_BASE_URL || 'https://www.molink.art').replace(/\/+$/, '');
const API_BASE_URL = String(process.env.APIYI_API_BASE_URL || 'https://api.apiyi.com').replace(/\/+$/, '');
const API_KEY = process.env.APIYI_API_KEY || '';
const PRIMARY_MODEL = process.env.APIYI_MODEL || 'gemini-3-pro-image-preview';
const FALLBACK_MODELS = parseModelList(process.env.APIYI_FALLBACK_MODELS || 'gemini-2.5-flash-image');
const ASPECT_RATIO = process.env.APIYI_ASPECT_RATIO || process.env.MMW_ASPECT_RATIO || '1:1';
const IMAGE_SIZE = process.env.APIYI_IMAGE_SIZE || process.env.MMW_IMAGE_SIZE || '1K';
const EXECUTION_COUNT = Math.max(1, parseInt(process.env.APIYI_EXECUTION_COUNT || process.env.MMW_EXECUTION_COUNT || '5', 10));
const CONCURRENCY = Math.max(1, parseInt(process.env.APIYI_CONCURRENCY || process.env.MMW_CONCURRENCY || '2', 10));
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.APIYI_MAX_ATTEMPTS || process.env.MMW_MAX_ATTEMPTS || '3', 10));
const TIMEOUT_MS = Math.max(30000, parseInt(process.env.APIYI_TIMEOUT_MS || process.env.MMW_TIMEOUT_MS || '180000', 10));
const RETRY_BASE_DELAY_MS = Math.max(500, parseInt(process.env.APIYI_RETRY_BASE_DELAY_MS || process.env.MMW_RETRY_BASE_DELAY_MS || '3000', 10));
const FORCE_IMAGE_MIME = process.env.APIYI_FORCE_IMAGE_MIME || process.env.MMW_FORCE_IMAGE_MIME || 'image/jpeg';
const EXTRA_BODY = safeJsonParse(process.env.APIYI_EXTRA_BODY_JSON || process.env.MMW_EXTRA_BODY_JSON, {});

fs.mkdirSync(JOB_DIR, { recursive: true });
fs.mkdirSync(AI_UPLOADS_DIR, { recursive: true });

let jobs = loadJobs();
let running = 0;
const queue = [];

function parseModelList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getModelCandidates(job) {
  const models = [job?.model || PRIMARY_MODEL, ...FALLBACK_MODELS].filter(Boolean);
  return Array.from(new Set(models));
}

function selectModelForAttempt(job, attempt) {
  const models = getModelCandidates(job);
  if (models.length === 0) return PRIMARY_MODEL;
  return models[Math.min(attempt - 1, models.length - 1)];
}

function safeJsonParse(str, fallback) {
  if (!str || typeof str !== 'string') return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function loadJobs() {
  try {
    if (!fs.existsSync(JOB_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(JOB_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    console.warn(`⚠️ Apiyi 任务文件读取失败，将从空状态启动: ${e.message}`);
    return {};
  }
}

function saveJobs() {
  try {
    fs.writeFileSync(JOB_FILE, JSON.stringify(jobs, null, 2));
  } catch (e) {
    console.warn(`⚠️ Apiyi 任务文件写入失败: ${e.message}`);
  }
}

function recoverExistingJobs() {
  const recoverable = Object.values(jobs).filter(job => job && ['pending', 'running'].includes(job.status));
  if (recoverable.length > 0) {
    console.log(`♻️ 恢复 Apiyi 生图任务 ${recoverable.length} 个`);
  }
  for (const job of recoverable) {
    job.status = 'pending';
    job.updatedAt = new Date().toISOString();
    enqueue(job.id);
  }
  if (recoverable.length > 0) saveJobs();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeExecutionId() {
  return `apiyi_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

function looksLikeApiyiId(id) {
  return /^apiyi_[a-z0-9]+_[a-f0-9]{12,}$/i.test(String(id || ''));
}

function toPublicUrl(filename) {
  return `${SERVER_BASE_URL}/uploads/ai/${filename}`;
}

function httpRequestBuffer(url, { method = 'GET', headers = {}, body = null, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'User-Agent': 'Mozilla/5.0 Molink/1.0', ...headers },
      timeout: timeoutMs
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.resume();
        return httpRequestBuffer(redirectUrl, { method: 'GET', headers, timeoutMs }).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, text: buf.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时 ${timeoutMs}ms: ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function downloadFile(url) {
  if (!url) throw new Error('downloadFile: url 不能为空');
  const text = String(url);
  const dataUrl = parseDataUrl(text);
  if (dataUrl) return dataUrl.buffer;

  try {
    const urlObj = new URL(text, SERVER_BASE_URL);
    if (urlObj.pathname.startsWith('/uploads/')) {
      const localPath = path.join(UPLOADS_DIR, decodeURIComponent(urlObj.pathname.replace(/^\/uploads\//, '')));
      if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
    }
  } catch {}

  const res = await httpRequestBuffer(text);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`下载文件失败 HTTP ${res.status}: ${res.text.substring(0, 300)}`);
  }
  return res.buffer;
}

async function imageUrlToDataUrl(imageUrl) {
  let buf = await downloadFile(imageUrl);
  let mime = FORCE_IMAGE_MIME;
  try {
    const converted = await sharp(buf)
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    buf = converted;
    mime = 'image/jpeg';
  } catch (e) {
    console.warn(`⚠️ 图片压缩失败，使用原图提交: ${e.message}`);
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function buildGeminiContents(userMessage) {
  const parts = [];
  for (const m of normalizeUserMessage(userMessage)) {
    if (m.file_url || m.image_url || m.url) {
      const imageUrl = m.file_url || m.image_url || m.url;
      const dataUrl = await imageUrlToDataUrl(imageUrl);
      const parsed = parseDataUrl(dataUrl);
      parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } });
    } else if (m.text !== undefined && m.text !== null) {
      parts.push({ text: String(m.text) });
    }
  }
  if (parts.length === 0) throw new Error('Apiyi 生图消息为空');
  return parts;
}

function normalizeUserMessage(userMessage) {
  if (Array.isArray(userMessage)) return userMessage;
  if (typeof userMessage === 'string') return [{ text: userMessage }];
  if (userMessage && typeof userMessage === 'object') return [userMessage];
  return [];
}

async function callApiyi({ model, userMessage }) {
  if (!API_KEY) throw new Error('缺少 APIYI_API_KEY');
  const parts = await buildGeminiContents(userMessage);
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: ASPECT_RATIO,
        imageSize: IMAGE_SIZE
      }
    },
    ...EXTRA_BODY
  };

  const encodedModel = encodeURIComponent(model);
  const url = `${API_BASE_URL}/v1beta/models/${encodedModel}:generateContent`;
  const res = await httpRequestBuffer(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    timeoutMs: TIMEOUT_MS
  });

  const data = parseApiResponse(res.text);
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`Apiyi API 返回错误 HTTP ${res.status}: ${res.text.substring(0, 1200)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function parseApiResponse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

function parseDataUrl(text) {
  const m = String(text || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return null;
  const base64 = m[2].replace(/\s/g, '');
  return { mimeType: m[1], base64, buffer: Buffer.from(base64, 'base64') };
}

function isProbablyBase64Image(text) {
  const s = String(text || '').trim().replace(/\s/g, '');
  if (s.length < 120) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  try {
    const head = Buffer.from(s.slice(0, 120), 'base64');
    return head.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
      (head[0] === 0xff && head[1] === 0xd8) ||
      head.toString('ascii', 0, 4) === 'RIFF' ||
      head.toString('ascii', 0, 3) === 'GIF';
  } catch { return false; }
}

function extractImageCandidateFromString(text, out) {
  const s = String(text || '').trim();
  if (!s) return;

  const dataUrlRegex = /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/g;
  let match;
  while ((match = dataUrlRegex.exec(s))) {
    out.push({ type: 'base64', mimeType: match[1], base64: match[2].replace(/\s/g, '') });
  }

  const urlRegex = /https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)"']*)?/gi;
  while ((match = urlRegex.exec(s))) {
    out.push({ type: 'url', url: match[0] });
  }

  if (out.length === 0 && isProbablyBase64Image(s)) {
    out.push({ type: 'base64', mimeType: 'image/png', base64: s.replace(/\s/g, '') });
  }
}

function extractImageCandidates(obj, out = [], depth = 0) {
  if (!obj || depth > 10) return out;
  if (typeof obj === 'string') {
    extractImageCandidateFromString(obj, out);
    return out;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) extractImageCandidates(item, out, depth + 1);
    return out;
  }
  if (typeof obj !== 'object') return out;

  const directBase64 = obj.b64_json || obj.base64 || obj.image_base64 || obj.imageBase64 || obj.data;
  const mime = obj.mime_type || obj.mimeType || obj.media_type || obj.mediaType || obj.type;
  if (typeof directBase64 === 'string' && isProbablyBase64Image(directBase64)) {
    out.push({ type: 'base64', mimeType: String(mime || 'image/png'), base64: directBase64.replace(/\s/g, '') });
  }

  if (obj.inlineData && obj.inlineData.data) {
    out.push({ type: 'base64', mimeType: obj.inlineData.mimeType || 'image/png', base64: String(obj.inlineData.data).replace(/\s/g, '') });
  }
  if (obj.inline_data && obj.inline_data.data) {
    out.push({ type: 'base64', mimeType: obj.inline_data.mime_type || 'image/png', base64: String(obj.inline_data.data).replace(/\s/g, '') });
  }

  const directUrl = obj.url || obj.image_url || obj.imageUrl;
  if (typeof directUrl === 'string') {
    if (directUrl.startsWith('data:image/')) extractImageCandidateFromString(directUrl, out);
    else if (/^https?:\/\//i.test(directUrl)) out.push({ type: 'url', url: directUrl });
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') extractImageCandidates(value, out, depth + 1);
    else if (typeof value === 'string') extractImageCandidateFromString(value, out);
  }
  return out;
}

function extFromMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}

async function persistImageCandidate(candidate, executionId) {
  let buffer;
  let mimeType = candidate.mimeType || 'image/png';
  if (candidate.type === 'url') {
    buffer = await downloadFile(candidate.url);
    mimeType = 'image/png';
  } else {
    buffer = Buffer.from(String(candidate.base64 || '').replace(/\s/g, ''), 'base64');
  }
  if (!buffer || buffer.length < 80) throw new Error('Apiyi 返回图片为空或过小');

  let finalBuffer = buffer;
  let ext = extFromMime(mimeType);
  try {
    finalBuffer = await sharp(buffer).png().toBuffer();
    ext = 'png';
  } catch (e) {
    console.warn(`⚠️ Apiyi 结果图转 PNG 失败，保存原始格式: ${e.message}`);
  }

  const filename = `${executionId}.${ext}`;
  const filePath = path.join(AI_UPLOADS_DIR, filename);
  fs.writeFileSync(filePath, finalBuffer);
  return { imageUrl: toPublicUrl(filename), filePath, filename, size: finalBuffer.length };
}

function classifyError(error) {
  const msg = String(error?.message || error || '');
  const dataStr = JSON.stringify(error?.data || '');
  const all = `${msg} ${dataStr}`.toLowerCase();
  if (error?.status === 401 || error?.status === 403 || all.includes('invalid api key') || all.includes('unauthorized')) return 'auth';
  if (error?.status === 429 || all.includes('rate limit') || all.includes('quota')) return 'rate_limit';
  if (error?.status >= 500 || all.includes('upstream error') || all.includes('do_request_failed')) return 'provider_upstream';
  if (all.includes('model') || all.includes('not found') || all.includes('unsupported')) return 'model';
  return 'unknown';
}

function shouldRetry(error) {
  const type = classifyError(error);
  return ['provider_upstream', 'rate_limit', 'unknown', 'model'].includes(type);
}

async function generateJob(job) {
  const modelCandidates = getModelCandidates(job);
  while (job.attempts < job.maxAttempts) {
    job.attempts += 1;
    const attempt = job.attempts;
    const model = selectModelForAttempt(job, attempt);
    job.status = 'running';
    job.modelUsed = model;
    job.updatedAt = new Date().toISOString();
    saveJobs();

    console.log(`🎨 Apiyi 生图开始 id=${job.id} attempt=${attempt}/${job.maxAttempts} model=${model}${model !== job.model ? ' fallback=1' : ''}`);
    try {
      const response = await callApiyi({ model, userMessage: job.userMessage });
      const candidates = extractImageCandidates(response);
      if (!candidates.length) {
        throw new Error(`Apiyi API 已返回但未解析到图片: ${JSON.stringify(response).substring(0, 1200)}`);
      }
      const saved = await persistImageCandidate(candidates[0], job.id);
      job.status = 'completed';
      job.imageUrl = saved.imageUrl;
      job.filePath = saved.filePath;
      job.filename = saved.filename;
      job.outputSize = saved.size;
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.rawSummary = summarizeResponse(response);
      saveJobs();
      console.log(`✅ Apiyi 生图完成 id=${job.id} model=${model} url=${job.imageUrl}`);
      return;
    } catch (e) {
      const errorType = classifyError(e);
      job.lastError = e.message;
      job.errorType = errorType;
      job.updatedAt = new Date().toISOString();
      saveJobs();

      const canRetry = attempt < job.maxAttempts && shouldRetry(e);
      const modelHint = modelCandidates.length > 1 && attempt < modelCandidates.length
        ? `，下次将切换模型为 ${selectModelForAttempt(job, attempt + 1)}`
        : '';
      console.warn(`⚠️ Apiyi 生图失败 id=${job.id} attempt=${attempt}: ${e.message}${canRetry ? modelHint + '，准备重试' : ''}`);
      if (!canRetry) break;
      await delay(RETRY_BASE_DELAY_MS * attempt);
    }
  }

  job.status = 'failed';
  job.failedAt = new Date().toISOString();
  job.updatedAt = job.failedAt;
  saveJobs();
}

function summarizeResponse(response) {
  try {
    const str = JSON.stringify(response);
    return str.length > 1500 ? `${str.substring(0, 1500)}...` : str;
  } catch { return String(response).substring(0, 1500); }
}

function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  processQueue();
}

function processQueue() {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift();
    const job = jobs[id];
    if (!job || !['pending', 'running'].includes(job.status)) continue;
    running += 1;
    generateJob(job)
      .catch(e => {
        console.error(`Apiyi 队列任务异常 id=${id}:`, e.message);
        if (jobs[id]) {
          jobs[id].status = 'failed';
          jobs[id].lastError = e.message;
          jobs[id].updatedAt = new Date().toISOString();
          saveJobs();
        }
      })
      .finally(() => {
        running -= 1;
        processQueue();
      });
  }
}

async function submitImageRequest({ userMessage, executionCount }) {
  const count = Math.max(1, parseInt(executionCount || EXECUTION_COUNT, 10));
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = makeExecutionId();
    jobs[id] = {
      id,
      provider: 'apiyi',
      status: 'pending',
      userMessage: normalizeUserMessage(userMessage),
      model: PRIMARY_MODEL,
      modelCandidates: getModelCandidates({ model: PRIMARY_MODEL }),
      aspectRatio: ASPECT_RATIO,
      imageSize: IMAGE_SIZE,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    ids.push(id);
    enqueue(id);
  }
  saveJobs();
  console.log(`📤 已提交 Apiyi 生图队列 数量=${ids.length} model=${PRIMARY_MODEL} fallbacks=${FALLBACK_MODELS.join('|') || '-'} ids=${ids.join(',')}`);
  return ids;
}

async function checkExecution(executionId) {
  const job = jobs[executionId];
  if (!job) {
    if (looksLikeApiyiId(executionId)) return { status: 'failed', raw: { error: 'Apiyi job not found', executionId } };
    return { status: 'failed', raw: { error: 'unknown provider execution id', executionId } };
  }
  if (job.status === 'completed') {
    return { status: 'completed', imageUrl: job.imageUrl, raw: job };
  }
  if (job.status === 'failed') {
    return { status: 'failed', raw: job };
  }
  return { status: job.status || 'pending', raw: job };
}

recoverExistingJobs();

module.exports = {
  submitImageRequest,
  checkExecution,
  downloadFile,
  _internal: {
    extractImageCandidates,
    parseDataUrl,
    isProbablyBase64Image,
    looksLikeApiyiId
  }
};
