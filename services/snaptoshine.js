// services/snaptoshine.js —— snaptoshine.com AI 生图服务
const https = require('https');
const sharp = require('sharp');

const SUPABASE_URL = 'https://fxcegiccwqtcuuyhzgkq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4Y2VnaWNjd3F0Y3V1eWh6Z2txIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgyNTQ3ODQsImV4cCI6MjA4MzgzMDc4NH0.vnqLmWFSxUExgXJnWQOuDpUY8rdrkbLemStXoLH9QQk';
const BACKEND_URL = 'snaptoshine.com';
const DEFAULT_WORKSPACE_ID = 'f1bb03f2-1a41-4dff-83d1-b874946f03d5';
let currentWorkspaceId = DEFAULT_WORKSPACE_ID;
const SYSTEM_PROMPT_ID = '0d6bcbba-61e2-4330-b87e-0ddd874f84f1';
const MODEL_ID = 'gemini-2.5-flash-image';
const TEMPERATURE = 0.7;
const MAX_TOKENS = 4096;
const EXECUTION_COUNT = 5;

const EMAIL = process.env.SNAPTOSHINE_EMAIL || 'lyqyrxw1pbxzyh@gmail.com';
const PASSWORD = process.env.SNAPTOSHINE_PASSWORD || '200562hj';

// 缓存 token（进程内有效）
let cachedToken = null;
let tokenExpiresAt = 0;

// 图片上传缓存：外部URL → Snaptoshine 内部 file_url（进程内有效）
const imageUploadCache = new Map();

// ──────────────────────────────────────────────
// 底层 HTTPS 请求封装（JSON body）
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

// ──────────────────────────────────────────────
// HTTPS 请求封装（Buffer body，用于文件上传）
// ──────────────────────────────────────────────
function httpsReqBuffer(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method,
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers }
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, data: b }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ──────────────────────────────────────────────
// 下载外部图片为 Buffer
// ──────────────────────────────────────────────
function downloadImageBuffer(url) {
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
        return downloadImageBuffer(res.headers.location).then(resolve).catch(reject);
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
// 上传图片到 Snaptoshine，返回其内部 CDN file_url
// 通过 executor_name='asset_upload' 提交，轮询完成后取 CDN URL
// 同一张图只上传一次（进程内缓存）
// ──────────────────────────────────────────────
async function uploadImageToSnaptoshine(externalUrl) {
  if (imageUploadCache.has(externalUrl)) {
    console.log(`📸 图片缓存命中: ${externalUrl.substring(0, 60)}`);
    return imageUploadCache.get(externalUrl);
  }

  const token = await getToken();
  const rawBuf = await downloadImageBuffer(externalUrl);

  // 压缩到 1280px 以内，减少 base64 体积
  let buf, width, height;
  try {
    const result = await sharp(rawBuf)
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    buf = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch (e) {
    buf = rawBuf;
    width = 1024; height = 1024;
  }

  const base64Data = `data:image/jpeg;base64,${buf.toString('base64')}`;
  const clientId = require('crypto').randomUUID();
  console.log(`📸 上传图片 (${buf.length} bytes, ${width}x${height}) → Snaptoshine CDN...`);

  const uploadBody = {
    workspace_id: currentWorkspaceId,
    executor_name: 'asset_upload',
    user_prompt: [],
    input_params: {
      base64_images: [base64Data],
      client_request_id: clientId,
      width,
      height
    },
    execution_count: 1
  };

  const res = await httpsReq(BACKEND_URL, '/api/v1/user-requests', 'POST',
    { 'Authorization': 'Bearer ' + token }, uploadBody);

  console.log(`📸 上传提交 status=${res.status} data=${JSON.stringify(res.data).substring(0, 300)}`);

  if (res.status !== 201) {
    console.warn(`⚠️ 上传提交失败 (${res.status})，降级使用外部URL`);
    return externalUrl;
  }

  // 从执行结果提取 file_url 的辅助函数
  function extractCdnUrl(exec) {
    if (!exec) return null;
    const out = exec.output || exec.outputs || [];
    if (Array.isArray(out) && out[0]?.file_url) return out[0].file_url;
    if (exec.file_url) return exec.file_url;
    return null;
  }

  // 检查是否已经立即完成
  const firstExec = res.data.executions?.[0];
  const execId = firstExec?.id;
  const immediateUrl = extractCdnUrl(firstExec);
  if (immediateUrl) {
    imageUploadCache.set(externalUrl, immediateUrl);
    console.log(`✅ 图片上传完成 (即时): ${immediateUrl}`);
    return immediateUrl;
  }

  if (!execId) {
    console.warn('⚠️ 未返回 execution ID，降级使用外部URL');
    return externalUrl;
  }

  // 轮询直到完成（最多 60 秒）
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const pollRes = await httpsReq(BACKEND_URL, `/api/v1/executions/${execId}`, 'GET',
      { 'Authorization': 'Bearer ' + token }, null);
    const exec = pollRes.data;
    console.log(`📸 上传轮询 status=${exec.status}`);

    if (exec.status === 'completed' || exec.status === 'succeeded') {
      const cdnUrl = extractCdnUrl(exec);
      if (cdnUrl) {
        imageUploadCache.set(externalUrl, cdnUrl);
        console.log(`✅ 图片上传完成: ${cdnUrl}`);
        return cdnUrl;
      }
      console.warn('⚠️ 完成但未找到 file_url:', JSON.stringify(exec).substring(0, 400));
      return externalUrl;
    }
    if (exec.status === 'failed' || exec.status === 'error') {
      console.warn('⚠️ 上传执行失败，降级使用外部URL');
      return externalUrl;
    }
  }

  console.warn('⚠️ 上传超时，降级使用外部URL');
  return externalUrl;
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
// 新建 Snaptoshine 空间
// ──────────────────────────────────────────────
async function createNewWorkspace() {
  const token = await getToken();
  const name = `molink-auto-${Date.now()}`;
  const res = await httpsReq(BACKEND_URL, '/api/v1/workspaces', 'POST',
    { 'Authorization': 'Bearer ' + token }, { name });
  console.log(`🆕 新建空间响应 status=${res.status} data=${JSON.stringify(res.data).substring(0, 200)}`);
  if ((res.status === 200 || res.status === 201) && res.data.id) {
    currentWorkspaceId = res.data.id;
    console.log(`✅ 新空间已创建: ${currentWorkspaceId}`);
    return currentWorkspaceId;
  }
  throw new Error('新建空间失败: ' + JSON.stringify(res.data));
}

// ──────────────────────────────────────────────
// 提交 AI 生图任务
// userMessage: 图文交替数组，如 [{text:'...'},{file_url:'...'},...]
// 返回 execution_id
// ──────────────────────────────────────────────
async function submitImageRequest({ userMessage }) {
  const token = await getToken();

  // 将 file_url 上传到 Snaptoshine CDN，确保 AI 模型可以访问图片内容
  const processedMessage = [];
  for (const m of userMessage) {
    if (m.file_url) {
      const cdnUrl = await uploadImageToSnaptoshine(m.file_url);
      processedMessage.push({ file_url: cdnUrl });
    } else {
      processedMessage.push({ text: m.text });
    }
  }

  // 日志
  const summary = processedMessage.map(m => m.file_url ? `[图:${m.file_url.substring(0,50)}]` : `"${(m.text||'').substring(0, 30)}"`).join(', ');
  console.log(`📤 提交生图 消息结构: ${summary}`);

  const body = {
    workspace_id: currentWorkspaceId,
    executor_name: 'Image',
    user_prompt: processedMessage,
    input_params: {
      user_message: processedMessage,
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
    const errStr = JSON.stringify(res.data);
    // 检测空间已满，自动新建并重试
    if (errStr.includes('space') || errStr.includes('quota') || errStr.includes('limit') || errStr.includes('满') || res.status === 429 || res.status === 400) {
      console.warn(`⚠️ 空间可能已满 (status=${res.status})，尝试新建空间并重试...`);
      await createNewWorkspace();
      // 重试一次
      const body2 = { ...body, workspace_id: currentWorkspaceId };
      const res2 = await httpsReq(BACKEND_URL, '/api/v1/user-requests', 'POST',
        { 'Authorization': 'Bearer ' + token }, body2);
      if (res2.status !== 201 || !res2.data.executions?.[0]?.id) {
        throw new Error('新建空间后重试仍失败: ' + JSON.stringify(res2.data));
      }
      return res2.data.executions.map(e => e.id);
    }
    throw new Error('提交失败: ' + errStr);
  }

  // 返回全部 execution ID 数组（后续逐个轮询，收集所有通过审核的效果图）
  return res.data.executions.map(e => e.id);
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
  const outputs = obj.output || obj.outputs || obj.output_items || obj.results || obj.messages || [];
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
