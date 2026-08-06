// services/aiImage.js —— AI 生图服务统一入口
// 默认使用 MMW / Nano Banana；保留 Snaptoshine，便于通过环境变量回切。
// 支持 Apiyi (gemini-3-pro-image-preview) 作为替代供应商。
const mmw = require('./mmwBanana');
const snaptoshine = require('./snaptoshine');
const apiyi = require('./apiyi');

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function currentProvider() {
  return normalizeProvider(process.env.AI_IMAGE_PROVIDER || 'mmw');
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isSnaptoshineEnabled() {
  return isTruthyEnv(process.env.SNAPTOSHINE_ENABLED);
}

function isMmwExecutionId(id) {
  return /^mmw_/i.test(String(id || ''));
}

function isApiyiExecutionId(id) {
  return /^apiyi_/i.test(String(id || ''));
}

function getSubmitProvider() {
  const provider = currentProvider();
  if (['snaptoshine', 'snap'].includes(provider)) {
    if (isSnaptoshineEnabled()) return snaptoshine;
    console.warn('⚠️ AI_IMAGE_PROVIDER=snaptoshine 但 SNAPTOSHINE_ENABLED 未开启，已阻止新任务进入旧 Snaptoshine 上传链路，自动改用 MMW。');
    return mmw;
  }
  if (['apiyi', 'api-yi'].includes(provider)) return apiyi;
  if (['mmw', 'nano-banana', 'nanobanana', 'banana'].includes(provider)) return mmw;
  console.warn(`⚠️ 未识别 AI_IMAGE_PROVIDER=${provider}，默认使用 mmw`);
  return mmw;
}

async function submitImageRequest(args) {
  const providerName = currentProvider();
  const provider = getSubmitProvider();
  const effectiveProvider = provider === snaptoshine ? 'snaptoshine' : (provider === apiyi ? 'apiyi' : 'mmw');
  const requestedSuffix = effectiveProvider !== providerName && providerName ? ` requested=${providerName}` : '';
  console.log(`🧩 AI 生图 provider=${effectiveProvider}${requestedSuffix}`);
  return provider.submitImageRequest(args);
}

async function checkExecution(executionId) {
  // 历史兼容：mmw_ 前缀永远走 MMW；apiyi_ 前缀永远走 Apiyi；旧 Snaptoshine execution id 永远走旧服务。
  if (isMmwExecutionId(executionId)) return mmw.checkExecution(executionId);
  if (isApiyiExecutionId(executionId)) return apiyi.checkExecution(executionId);
  return snaptoshine.checkExecution(executionId);
}

async function downloadFile(url) {
  // MMW 的下载函数兼容本地 /uploads 文件和普通 http(s)；优先使用它。
  try {
    return await mmw.downloadFile(url);
  } catch (e) {
    return snaptoshine.downloadFile(url);
  }
}

module.exports = { submitImageRequest, checkExecution, downloadFile, currentProvider, isMmwExecutionId, isApiyiExecutionId };
