// services/snaptoshine.js —— snaptoshine.com AI 生图服务
const https = require('https');

const SUPABASE_URL = 'https://fxcegiccwqtcuuyhzgkq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4Y2VnaWNjd3F0Y3V1eWh6Z2txIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgyNTQ3ODQsImV4cCI6MjA4MzgzMDc4NH0.vnqLmWFSxUExgXJnWQOuDpUY8rdrkbLemStXoLH9QQk';
const BACKEND_URL = 'snaptoshine.com';
const WORKSPACE_ID = '3aafbca8-9c50-425a-b1a7-7fd526048893';
const SYSTEM_PROMPT_ID = 'opt_demo_sys_image_001';
const MODEL_ID = 'gemini-2.5-flash-image';

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
// 返回 execution_id
// ──────────────────────────────────────────────
async function submitImageRequest({ prompt, artworkUrl, spaceUrl }) {
  const token = await getToken();

  const userMessage = [];
  if (artworkUrl) userMessage.push({ file_url: artworkUrl });
  if (spaceUrl) userMessage.push({ file_url: spaceUrl });
  userMessage.push({ text: prompt });

  const body = {
    workspace_id: WORKSPACE_ID,
    executor_name: 'Image',
    user_prompt: userMessage,
    input_params: {
      user_message: userMessage,
      system_prompt_template_id: SYSTEM_PROMPT_ID,
      model_id: MODEL_ID,
      execution_count: 1
    },
    execution_count: 1
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

  // 提取生成的图片 URL
  let imageUrl = null;
  if (status === 'completed' || status === 'succeeded') {
    const outputs = exec.outputs || exec.output_items || [];
    for (const item of outputs) {
      if (item.type === 'image' && item.url) { imageUrl = item.url; break; }
      if (item.file_url) { imageUrl = item.file_url; break; }
      if (item.asset_url) { imageUrl = item.asset_url; break; }
    }
    // 兼容其他格式
    if (!imageUrl && exec.result_url) imageUrl = exec.result_url;
  }

  return { status, imageUrl, raw: exec };
}

module.exports = { submitImageRequest, checkExecution, downloadFile };
