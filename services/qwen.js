// services/qwen.js —— Qwen-VL 自动审核服务
// 初审（qwen-vl-plus，稳）：检查是否违反物理法则
// 终审（qwen-vl-max，精准）：检查画作尺寸比例
// 两者均先将图片缩成低分辨率缩略图再发送，大幅节省 token

const https = require('https');
const http = require('http');
const fs = require('fs');
const sharp = require('sharp');

const DASHSCOPE_HOST = process.env.DASHSCOPE_HOST || 'dashscope-intl.aliyuncs.com';
const QWEN_MODEL_PHYSICS = process.env.QWEN_MODEL_PHYSICS || 'qwen-vl-plus';
const QWEN_MODEL_DIMENSIONS = process.env.QWEN_MODEL_DIMENSIONS || 'qwen-vl-max';
const QWEN_MODEL_VALIDATION = process.env.QWEN_MODEL_VALIDATION || 'qwen-vl-plus';
const QWEN_MODEL_CONSISTENCY = process.env.QWEN_MODEL_CONSISTENCY || 'qwen-vl-plus';

// ──────────────────────────────────────────────
// 下载图片为 Buffer（支持重定向）
// ──────────────────────────────────────────────
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
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
// 下载图片并缩小为低分辨率 JPEG，返回 base64 字符串
// urlOrPath: HTTP URL 或本地文件绝对路径
// maxSize: 最长边像素数（缩小后最长边不超过此值）
// ──────────────────────────────────────────────
async function imageToBase64Thumbnail(urlOrPath, maxSize) {
  const buf = (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://'))
    ? await downloadBuffer(urlOrPath)
    : fs.readFileSync(urlOrPath);
  const resized = await sharp(buf)
    .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  return resized.toString('base64');
}

// ──────────────────────────────────────────────
// 通用 OpenAI 兼容接口调用
// hostname: API 服务器域名
// path: API 路径
// apiKey: 鉴权 Key
// ──────────────────────────────────────────────
function callVisionAPI(hostname, path, apiKey, model, imageBase64, prompt, customBody) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      return resolve({ choices: [{ message: { content: '通过' } }] });
    }

    const body = JSON.stringify(customBody || {
      model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
          },
          { type: 'text', text: prompt }
        ]
      }],
      max_tokens: 100
    });

    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callDashScope(model, imageBase64, prompt) {
  return callVisionAPI(DASHSCOPE_HOST, '/compatible-mode/v1/chat/completions',
    process.env.DASHSCOPE_API_KEY, model, imageBase64, prompt);
}

function stripMarkdownCodeFence(text) {
  const value = String(text || '').trim();
  if (!value.startsWith('```')) return value;
  return value
    .replace(/^```[a-zA-Z0-9_-]*\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function extractEmbeddedJson(text) {
  const cleaned = stripMarkdownCodeFence(text);
  const direct = safeJsonParse(cleaned);
  if (direct && typeof direct === 'object') return direct;

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return safeJsonParse(cleaned.slice(start, end + 1));
  }
  return null;
}

function flattenContentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(item => flattenContentToText(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text.trim();
    if (typeof content.output_text === 'string') return content.output_text.trim();
    if (typeof content.content === 'string') return content.content.trim();
    if (typeof content.reason === 'string') return content.reason.trim();
  }
  return String(content).trim();
}

function extractResponseText(response) {
  if (typeof response === 'string') return response.trim();

  const primary = response?.choices?.[0]?.message?.content;
  const primaryText = flattenContentToText(primary);
  if (primaryText) return primaryText;

  const altMessage = response?.output?.choices?.[0]?.message?.content;
  const altText = flattenContentToText(altMessage);
  if (altText) return altText;

  if (typeof response?.output_text === 'string') return response.output_text.trim();
  if (typeof response?.error === 'string') return response.error.trim();
  if (response?.error && typeof response.error.message === 'string') return response.error.message.trim();

  return '';
}

function normalizeDecisionToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[“”"']/g, '');
}

function classifyDecisionToken(value, positiveTokens, negativeTokens) {
  const token = normalizeDecisionToken(value);
  if (!token) return null;
  if (positiveTokens.includes(token)) return true;
  if (negativeTokens.includes(token)) return false;
  return null;
}

function extractReasonFromText(text, negativePattern) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '';

  const labeled = cleaned.match(/(?:原因|说明|备注|理由)\s*[：:]\s*(.+)$/u);
  if (labeled?.[1]) return labeled[1].trim();

  if (negativePattern) {
    const stripped = cleaned.replace(negativePattern, '').replace(/^[：:，,\s-]+/u, '').trim();
    if (stripped && stripped !== cleaned) return stripped;
  }

  return '';
}

function parseStructuredDecision(text, positiveTokens, negativeTokens) {
  const json = extractEmbeddedJson(text);
  if (!json || typeof json !== 'object') return null;

  const boolKeys = ['pass', 'passed', 'approved', 'valid', 'ok'];
  for (const key of boolKeys) {
    if (typeof json[key] === 'boolean') {
      return {
        pass: json[key],
        reason: String(json.reason || json.message || json.detail || '').trim()
      };
    }
  }

  const decisionKeys = ['result', 'status', 'decision', 'verdict', 'conclusion', 'judgement', 'judgment', 'answer'];
  for (const key of decisionKeys) {
    if (json[key] != null) {
      const classified = classifyDecisionToken(json[key], positiveTokens, negativeTokens);
      if (classified != null) {
        return {
          pass: classified,
          reason: String(json.reason || json.message || json.detail || '').trim()
        };
      }
    }
  }

  return null;
}

function parseDecisionText(text, { positiveTokens, negativeTokens, positivePattern, negativePattern, defaultPass = true }) {
  const cleaned = stripMarkdownCodeFence(text);
  const structured = parseStructuredDecision(cleaned, positiveTokens, negativeTokens);
  if (structured) {
    return {
      pass: structured.pass,
      reason: structured.pass ? '' : structured.reason
    };
  }

  const normalized = cleaned.trim();
  if (!normalized) {
    return { pass: defaultPass, reason: '' };
  }

  const labeledNegative = normalized.match(/(?:结论|结果|判断|答复|回答)\s*[：:]\s*(不通过|否|不合格|失败|fail|failed|ng)/iu);
  if (labeledNegative) {
    return { pass: false, reason: extractReasonFromText(normalized, /.*?(?:结论|结果|判断|答复|回答)\s*[：:]\s*(?:不通过|否|不合格|失败|fail|failed|ng)/iu) };
  }

  const labeledPositive = normalized.match(/(?:结论|结果|判断|答复|回答)\s*[：:]\s*(通过|是|合格|pass|passed|ok)/iu);
  if (labeledPositive) {
    return { pass: true, reason: '' };
  }

  const directToken = classifyDecisionToken(normalized, positiveTokens, negativeTokens);
  if (directToken != null) {
    return { pass: directToken, reason: directToken ? '' : '' };
  }

  if (negativePattern.test(normalized)) {
    return { pass: false, reason: extractReasonFromText(normalized, negativePattern) };
  }
  if (positivePattern.test(normalized)) {
    return { pass: true, reason: '' };
  }

  return { pass: defaultPass, reason: '' };
}

function parseAuditResult(responseOrText) {
  const text = extractResponseText(responseOrText);
  return parseDecisionText(text, {
    positiveTokens: ['通过', 'pass', 'passed', 'ok', '合格'],
    negativeTokens: ['不通过', 'fail', 'failed', 'ng', '不合格', '否'],
    positivePattern: /(?:^|[\s"'“”‘’({【\[])(?:通过|pass|passed|ok|合格)(?:$|[\s,，。；;:：!！?？)}】\]])/iu,
    negativePattern: /(?:^|[\s"'“”‘’({【\[])(?:不通过|fail|failed|ng|不合格|否)(?:$|[\s,，。；;:：!！?？)}】\]])/iu,
    defaultPass: true
  });
}

function parseYesNoResult(responseOrText) {
  const text = extractResponseText(responseOrText);
  const parsed = parseDecisionText(text, {
    positiveTokens: ['是', 'yes', 'true', '通过', 'pass'],
    negativeTokens: ['否', 'no', 'false', '不通过', 'fail'],
    positivePattern: /(?:^|[\s"'“”‘’({【\[])(?:是|yes|true|通过|pass)(?:$|[\s,，。；;:：!！?？)}】\]])/iu,
    negativePattern: /(?:^|[\s"'“”‘’({【\[])(?:否|no|false|不通过|fail)(?:$|[\s,，。；;:：!！?？)}】\]])/iu,
    defaultPass: true
  });
  return { valid: parsed.pass, reason: parsed.pass ? '' : '' };
}

function createSkippedAuditResult(error, defaults = {}) {
  return {
    pass: true,
    reason: '',
    skipped: true,
    error: error?.message || String(error || ''),
    ...defaults
  };
}

// ──────────────────────────────────────────────
// 初审：物理法则检查
// 模型：qwen-vl-plus（稳）
// 缩略图：512px —— 足够判断图片是否生成崩了
// ──────────────────────────────────────────────
async function reviewPhysics(imageUrl) {
  try {
    const base64 = await imageToBase64Thumbnail(imageUrl, 512);
    const prompt = `这是一张AI生成的室内空间效果图。请判断：这张图片是否存在明显违反物理法则的情况？
包括但不限于：画面严重扭曲/错乱、图层混合导致物体融合穿透、空间结构完全不合理、生成失败的乱码或大片噪声。
注意：轻微的AI生成痕迹是正常的，只拒绝明显无法展示给客户的图片。
请只回答"通过"或"不通过"，如果不通过，紧跟一句原因（不超过20字）。`;

    const res = await callDashScope(QWEN_MODEL_PHYSICS, base64, prompt);
    const result = parseAuditResult(res);
    const rawText = extractResponseText(res);
    console.log(`🔍 Qwen 初审结果: ${result.pass ? '✅通过' : '❌不通过 ' + (result.reason || '无原因')} | 模型输出: ${rawText || '（空）'}`);
    return { ...result, rawText };
  } catch (e) {
    console.error('Qwen 初审异常（跳过）:', e.message);
    return createSkippedAuditResult(e);
  }
}

// ──────────────────────────────────────────────
// 终审：画作尺寸比例检查
// 模型：qwen-vl-max（精准）
// 缩略图：768px —— 足够看清挂画与家具的比例关系
// ──────────────────────────────────────────────
function normalizeDimensionAction(value, text = '') {
  const raw = String(value || '').trim().toLowerCase();
  const full = `${raw} ${String(text || '').toLowerCase()}`;
  if (/shrink|smaller|reduce|decrease|缩小|偏大|过大|太大|大了/u.test(full)) return 'shrink';
  if (/enlarge|larger|increase|放大|扩大|偏小|过小|太小|小了/u.test(full)) return 'enlarge';
  return 'none';
}

function buildDimensionFixInstruction({ action, reason, correctionAmount, fixInstruction, artworkSize }) {
  const target = String(artworkSize || '').trim();
  const reasonText = String(reason || '').trim();
  const amountText = String(correctionAmount || '').trim();
  const modelInstruction = String(fixInstruction || '').trim();
  if (modelInstruction) {
    return modelInstruction;
  }
  const verb = action === 'shrink' ? '缩小' : (action === 'enlarge' ? '放大' : '调整');
  const amountClause = amountText ? `，调整幅度参考：${amountText}` : '';
  const reasonClause = reasonText ? `。Qwen尺寸审核意见：${reasonText}` : '';
  return `请在上一张效果图基础上只${verb}墙面上的画作，使图中作品的视觉尺寸严格符合「${target}」${amountClause}${reasonClause}。保持房间结构、家具、墙面、光线、镜头视角、画作内容和画框样式不变，不要新增或删除其他物体。`;
}

function parseDimensionReview(rawText, fallbackResult, artworkSize) {
  const json = extractEmbeddedJson(rawText);
  let pass = fallbackResult.pass;
  let reason = fallbackResult.reason || '';
  let correctionAction = 'none';
  let correctionAmount = '';
  let fixInstruction = '';

  if (json && typeof json === 'object') {
    const boolKeys = ['pass', 'passed', 'approved', 'valid', 'ok'];
    for (const key of boolKeys) {
      if (typeof json[key] === 'boolean') {
        pass = json[key];
        break;
      }
    }
    const decision = json.result || json.status || json.decision || json.verdict || json.conclusion || json.answer;
    const classified = classifyDecisionToken(decision, ['通过', 'pass', 'passed', 'ok', '合格'], ['不通过', 'fail', 'failed', 'ng', '不合格', '否']);
    if (classified != null) pass = classified;

    reason = String(json.reason || json.message || json.detail || json.problem || reason || '').trim();
    correctionAction = normalizeDimensionAction(json.correction_action || json.action || json.direction || json.adjustment_direction || json.size_action, `${reason} ${rawText}`);
    correctionAmount = String(json.correction_amount || json.adjustment || json.scale || json.scale_hint || json.ratio_hint || '').trim();
    fixInstruction = String(json.fix_instruction || json.revision_prompt || json.suggestion || json.advice || json.correction_suggestion || '').trim();
  } else {
    correctionAction = normalizeDimensionAction('', `${reason} ${rawText}`);
  }

  if (!pass && correctionAction === 'none') {
    correctionAction = normalizeDimensionAction('', `${reason} ${rawText}`);
  }
  if (!pass && correctionAction === 'none') {
    correctionAction = 'adjust';
  }

  const dimensionFixInstruction = pass ? '' : buildDimensionFixInstruction({
    action: correctionAction,
    reason,
    correctionAmount,
    fixInstruction,
    artworkSize
  });

  return {
    pass,
    reason: pass ? '' : (reason || '尺寸比例不符'),
    correctionAction,
    correctionAmount,
    dimensionFixInstruction
  };
}

async function reviewDimensions(imageUrl, artworkSize) {
  try {
    const base64 = await imageToBase64Thumbnail(imageUrl, 768);
    const prompt = `你是AI室内空间效果图的尺寸终审员。目标：图中墙面上的画作视觉尺寸必须符合「${artworkSize}」。

请判断这张效果图里的画作尺寸是否正确，重点看：
1. 画作宽高比是否符合目标尺寸；
2. 画作相对墙面、沙发、柜子、床、餐桌等参照物的视觉比例是否合理；
3. 只评估画作尺寸，不要因为风格、光线或轻微AI痕迹而判不通过。

请只输出严格 JSON，不要输出 Markdown，不要解释 JSON 以外内容：
{
  "pass": true,
  "reason": "通过时为空；不通过时用一句话说明是偏大、偏小、比例不对或位置导致尺寸感不对",
  "correction_action": "none | enlarge | shrink",
  "correction_amount": "如能判断，写约放大/缩小多少，例如约放大20%；不能判断则写空字符串",
  "fix_instruction": "不通过时，写给生图/修图模型的中文修改指令：基于上一张图，只放大或缩小墙上画作，使其视觉尺寸符合${artworkSize}，并保持房间、家具、光线、镜头视角、画作内容和画框样式不变。通过时为空"
}`;

    const body = {
      model: QWEN_MODEL_DIMENSIONS,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: prompt }
        ]
      }],
      max_tokens: 320
    };

    const res = await callVisionAPI(DASHSCOPE_HOST, '/compatible-mode/v1/chat/completions',
      process.env.DASHSCOPE_API_KEY, null, null, null, body);
    const rawText = extractResponseText(res);
    const fallbackResult = parseAuditResult(rawText || res);
    const dimensionReview = parseDimensionReview(rawText, fallbackResult, artworkSize);
    console.log(`🔍 Qwen 终审结果: ${dimensionReview.pass ? '✅通过' : '❌不通过 ' + (dimensionReview.reason || '无原因')} | 修正动作=${dimensionReview.correctionAction || 'none'} | 修改意见=${dimensionReview.dimensionFixInstruction || '无'} | 模型输出: ${rawText || '（空）'}`);
    return { ...dimensionReview, rawText };
  } catch (e) {
    console.error('Qwen 终审异常（跳过）:', e.message);
    return createSkippedAuditResult(e);
  }
}

// ──────────────────────────────────────────────
// 提交前验证：图片内容是否符合该槽位
// 策略：宁可放过，不可错杀——只拒绝明显错误，有疑问一律通过
// ──────────────────────────────────────────────

// 验证作品图：必须是某种艺术作品/画作
async function validateArtworkImage(imageUrl) {
  try {
    const base64 = await imageToBase64Thumbnail(imageUrl, 512);
    const prompt = `这张图片是否是一件艺术作品（包括国画、油画、水彩、版画、素描、水墨画、书法、雕塑照片等任何形式的艺术品或画作）？
注意：只要看起来像是某种艺术创作，哪怕拍摄角度不佳或有装裱，都算"是"。
只有明显不是艺术作品的（例如：自拍照、风景照、食物照、截图、纯文字图片、空白图片）才回答"否"。
请只回答"是"或"否"。`;

    const res = await callDashScope(QWEN_MODEL_VALIDATION, base64, prompt);
    const parsed = parseYesNoResult(res);
    const rawText = extractResponseText(res);
    console.log(`🖼️ 作品图验证: ${parsed.valid ? '✅通过' : '❌不通过'} | 模型输出: ${rawText || '（空）'}`);
    return { ...parsed, rawText, reason: parsed.valid ? '' : '上传的作品图片看起来不是艺术作品，请重新上传画作照片' };
  } catch (e) {
    console.error('作品图验证异常（放行）:', e.message);
    return { valid: true, skipped: true, error: e.message || String(e), reason: '' };
  }
}

// 验证空间图：必须是室内空间/房间
async function validateSpaceImage(imageUrl) {
  try {
    const base64 = await imageToBase64Thumbnail(imageUrl, 512);
    const prompt = `这张图片是否是一个室内空间或房间的照片（包括客厅、卧室、书房、餐厅、走廊、展厅等任何室内环境）？
注意：只要是在室内拍摄的空间照片，哪怕较空旷或角度奇特，都算"是"。
只有明显不是室内空间的（例如：户外风景、人物特写、艺术品特写、截图、纯文字）才回答"否"。
请只回答"是"或"否"。`;

    const res = await callDashScope(QWEN_MODEL_VALIDATION, base64, prompt);
    const parsed = parseYesNoResult(res);
    const rawText = extractResponseText(res);
    console.log(`🏠 空间图验证: ${parsed.valid ? '✅通过' : '❌不通过'} | 模型输出: ${rawText || '（空）'}`);
    return { ...parsed, rawText, reason: parsed.valid ? '' : '上传的空间图片看起来不是室内空间，请重新上传房间照片' };
  } catch (e) {
    console.error('空间图验证异常（放行）:', e.message);
    return { valid: true, skipped: true, error: e.message || String(e), reason: '' };
  }
}

// ──────────────────────────────────────────────
// 画作一致性检查：对比原作品图和效果图里的挂画是否是同一幅
// 模型：qwen-vl-plus（够用，省钱）
// 策略：宁可放过，只拒绝明显换了画的情况
// ──────────────────────────────────────────────
async function reviewArtworkConsistency(resultImageUrl, artworkImageUrl) {
  try {
    const resultBase64 = await imageToBase64Thumbnail(resultImageUrl, 768);
    const artworkBase64 = await imageToBase64Thumbnail(artworkImageUrl, 512);
    const prompt = `我给你两张图：第一张是室内空间效果图，第二张是原始画作。
请判断：效果图中墙上挂的画，是否与第二张原始画作是同一幅（或同类型的同一幅）作品？

判断规则（宽松，宁可放过，不可错杀）：
- 只要主体题材相同即可通过（如两者都是花鸟、都是山水、都是抽象色块）
- AI生成效果图中画作的颜色、笔触与原作略有差异属于正常，不要因此不通过
- 只有以下情况才不通过：效果图中完全没有任何挂画；或挂画的题材与原作完全不同（如原作是山水，效果图挂的却是人物肖像）
- 如有疑问，一律通过

请只回答"通过"或"不通过"，如果不通过，紧跟一句原因（不超过20字）。`;

    const body = {
      model: QWEN_MODEL_CONSISTENCY,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${resultBase64}` } },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${artworkBase64}` } },
          { type: 'text', text: prompt }
        ]
      }],
      max_tokens: 64
    };

    const res = await callVisionAPI(DASHSCOPE_HOST, '/compatible-mode/v1/chat/completions',
      process.env.DASHSCOPE_API_KEY, null, null, null, body);
    const result = parseAuditResult(res);
    const rawText = extractResponseText(res);
    console.log(`🔍 Qwen 画作一致性: ${result.pass ? '✅通过' : '❌不通过 ' + (result.reason || '无原因')} | 模型输出: ${rawText || '（空）'}`);
    return { ...result, rawText };
  } catch (e) {
    console.error('Qwen 画作一致性检查异常（跳过）:', e.message);
    return createSkippedAuditResult(e);
  }
}

module.exports = {
  reviewPhysics,
  reviewDimensions,
  validateArtworkImage,
  validateSpaceImage,
  reviewArtworkConsistency,
  extractResponseText,
  parseAuditResult
};
