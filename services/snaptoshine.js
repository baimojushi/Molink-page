// services/snaptoshine.js —— snaptoshine.com AI 生图服务
const https = require('https');

const SUPABASE_URL = 'https://fxcegiccwqtcuuyhzgkq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4Y2VnaWNjd3F0Y3V1eWh6Z2txIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgyNTQ3ODQsImV4cCI6MjA4MzgzMDc4NH0.vnqLmWFSxUExgXJnWQOuDpUY8rdrkbLemStXoLH9QQk';
const BACKEND_URL = 'snaptoshine.com';
const WORKSPACE_ID = '3aafbca8-9c50-425a-b1a7-7fd526048893';
const SYSTEM_PROMPT_ID = 'opt_demo_sys_image_001';
const MODEL_ID = 'gemini-2.5-flash-image';
const TEMPERATURE = 0.7;
const MAX_TOKENS = 4096;
const EXECUTION_COUNT = 1;

const EMAIL = process.env.SNAPTOSHINE_EMAIL || 'lyqyrxw1pbxzyh@gmail.com';
const PASSWORD = process.env.SNAPTOSHINE_PASSWORD || '200562hj';

// 缓存 token（进程内有效）
let cachedToken = null;
let tokenExpiresAt = 0;

// ──────────────────────────────────────────────
// 底层 HTTPS 请求封装
// ──────────────────────────────────────────────
function httpsReq(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname, path, method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, data: b }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 下载二进制文件（用于保存 AI 生成图片）
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : require('http');
    const req = mod.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

// ──────────────────────────────────────────────
// 获取/刷新 access token
// ──────────────────────────────────────────────
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && tokenExpiresAt > now + 60) return cachedToken;

  const res = await httpsReq(
    'fxcegiccwqtcuuyhzgkq.supabase.co',
    '/auth/v1/token?grant_type=password',
    'POST',
    { 'apikey': SUPABASE_ANON_KEY },
    { email: EMAIL, password: PASSWORD }
  );

  if (res.status !== 200 || !res.data.access_token) {
    throw new Error('Snaptoshine 登录失败: ' + JSON.stringify(res.data));
  }

  cachedToken = res.data.access_token;
  tokenExpiresAt = res.data.expires_at || (now + 3600);
  return cachedToken;
}

// ──────────────────────────────────────────────
// 提交 AI 生图任务
// userMessage: 图文交替数组，如 [{text:'...'},{file_url:'...'},...]
// 返回 execution_id
// ──────────────────────────────────────────────
async function submitImageRequest({ userMessage }) {
  const token = await getToken();

  const body = {
    workspace_id: WORKSPACE_ID,
    executor_name: 'Image',
    user_prompt: userMessage,
    input_params: {
      user_message: userMessage,
      system_prompt_template_id: SYSTEM_PROMPT_ID,
      model_id: MODEL_ID,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      execution_count: EXECUTION_COUNT
    },
    execution_count: EXECUTION_COUNT
  };

  const res = await httpsReq(BACKEND_URL, '/api/v1/user-requests', 'POST',
    { 'Authorization': 'Bearer ' + token }, body);

  if (res.status !== 201 || !res.data.executions?.[0]?.id) {
    throw new Error('提交失败: ' + JSON.stringify(res.data));
  }

  return res.data.executions[0].id;
}

// ──────────────────────────────────────────────
// 查询执行状态
// 返回 { status, imageUrl }
// status: 'pending'|'running'|'completed'|'failed'
// ──────────────────────────────────────────────
async function checkExecution(executionId) {
  const token = await getToken();
  const res = await httpsReq(BACKEND_URL, `/api/v1/executions/${executionId}`, 'GET',
    { 'Authorization': 'Bearer ' + token }, null);

  if (res.status !== 200) {
    throw new Error('查询执行状态失败: ' + JSON.stringify(res.data));
  }

  const exec = res.data;
  const status = exec.status;

  let imageUrl = null;
  if (status === 'completed' || status === 'succeeded') {
    // 先尝试从 execution 本身提取
    imageUrl = extractImageUrl(exec);

    // 若 execution 没有图片，从 user_request 提取（snaptoshine 可能把 outputs 挂在 user_request 上）
    if (!imageUrl && exec.user_request_id) {
      const urRes = await httpsReq(BACKEND_URL, `/api/v1/user-requests/${exec.user_request_id}`, 'GET',
        { 'Authorization': 'Bearer ' + token }, null);
      if (urRes.status === 200) {
        console.log(`📋 user_request keys: ${Object.keys(urRes.data).join(',')}`);
        console.log(`📋 user_request raw: ${JSON.stringify(urRes.data).substring(0, 800)}`);
        imageUrl = extractImageUrl(urRes.data);
        // user_request 可能有 executions 数组，逐个找
        if (!imageUrl && Array.isArray(urRes.data.executions)) {
          for (const e of urRes.data.executions) {
            imageUrl = extractImageUrl(e);
            if (imageUrl) break;
          }
        }
      }
    }

    if (!imageUrl) {
      console.log(`📋 exec keys: ${Object.keys(exec).join(',')}`);
      console.log(`📋 exec raw: ${JSON.stringify(exec).substring(0, 800)}`);
    }
  }

  return { status, imageUrl, raw: exec };
}

function extractImageUrl(obj) {
  if (!obj) return null;
  // 直接字段
  if (obj.result_url) return obj.result_url;
  if (obj.image_url) return obj.image_url;
  if (obj.output_url) return obj.output_url;
  if (obj.file_url) return obj.file_url;
  if (obj.asset_url) return obj.asset_url;
  // outputs 数组
  const outputs = obj.outputs || obj.output_items || obj.results || obj.messages || [];
  for (const item of outputs) {
    if (!item) continue;
    if (item.type === 'image' && item.url) return item.url;
    if (item.file_url) return item.file_url;
    if (item.asset_url) return item.asset_url;
    if (item.url && /\.(jpg|jpeg|png|webp|gif)/i.test(item.url)) return item.url;
    if (item.content && typeof item.content === 'string' && item.content.startsWith('http')) return item.content;
    // 嵌套
    if (item.outputs) {
      const nested = extractImageUrl({ outputs: item.outputs });
      if (nested) return nested;
    }
  }
  return null;
}

module.exports = { submitImageRequest, checkExecution, downloadFile };
