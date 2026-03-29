// services/qwen.js —— Qwen-VL 自动审核服务
// 初审（qwen-vl-flash，便宜）：检查是否违反物理法则
// 终审（qwen-vl-max，精准）：检查画作尺寸比例
// 两者均先将图片缩成低分辨率缩略图再发送，大幅节省 token

const https = require('https');
const http = require('http');
const sharp = require('sharp');

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
  const fs = require('fs');
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

// 初审：DashScope qwen-vl-flash
function callDashScope(model, imageBase64, prompt) {
  const host = process.env.DASHSCOPE_HOST || 'dashscope-intl.aliyuncs.com';
  return callVisionAPI(host, '/compatible-mode/v1/chat/completions',
    process.env.DASHSCOPE_API_KEY, model, imageBase64, prompt);
}

// 终审：wcode.net qwen-vl-max（已废弃，key 失效）
// function callWcode(model, imageBase64, prompt) { ... }

// ──────────────────────────────────────────────
// 解析 Qwen 回答是否通过
// 期望格式："通过" 或 "不通过，原因..."
// ──────────────────────────────────────────────
function parseResult(responseText) {
  const text = (responseText || '').trim();
  const pass = !text.startsWith('不通过');
  const reason = pass ? '' : text.replace(/^不通过[：:，,\s]*/, '').trim();
  return { pass, reason };
}

// ──────────────────────────────────────────────
// 初审：物理法则检查
// 模型：qwen-vl-flash（便宜）
// 缩略图：512px —— 足够判断图片是否生成崩了
// ──────────────────────────────────────────────
async function reviewPhysics(imageUrl) {
  try {
    const base64 = await imageToBase64Thumbnail(imageUrl, 512);
    const prompt = `这是一张AI生成的室内空间效果图。请判断：这张图片是否存在明显违反物理法则的情况？
包括但不限于：画面严重扭曲/错乱、图层混合导致物体融合穿透、空间结构完全不合理、生成失败的乱码或大片噪声。
注意：轻微的AI生成痕迹是正常的，只拒绝明显无法展示给客户的图片。
请只回答"通过"或"不通过"，如果不通过，紧跟一句原因（不超过20字）。`;

    const res = await callDashScope('qwen-vl-plus', base64, prompt);
    const text = res?.choices?.[0]?.message?.content || '通过';
    const result = parseResult(text);
    console.log(`🔍 Qwen 初审结果: ${result.pass ? '✅通过' : '❌不通过 ' + result.reason}`);
    return result;
  } catch (e) {
    console.error('Qwen 初审异常（跳过）:', e.message);
    return { pass: true, reason: '' };
  }
}

// ──────────────────────────────────────────────
// 终审：画作尺寸比例检查
// 模型：qwen-vl-max（精准）
// 缩略图：768px —— 足够看清挂画与家具的比例关系
// ──────────────────────────────────────────────
async function reviewDimensions(imageUrl, artworkSize) {
  try {
    const base64 = await imageToBase64Thumbnail(imageUrl, 768);
    const prompt = `图中的画作的尺寸应该为（${artworkSize}），你帮我判断这个画作的尺寸是否正确。请只回答"通过"或"不通过"，如果不通过，紧跟一句原因（不超过20字）。`;

    const res = await callDashScope('qwen-vl-max', base64, prompt);
    const text = res?.choices?.[0]?.message?.content || '通过';
    const result = parseResult(text);
    console.log(`🔍 Qwen 终审结果: ${result.pass ? '✅通过' : '❌不通过 ' + result.reason}`);
    return result;
  } catch (e) {
    console.error('Qwen 终审异常（跳过）:', e.message);
    return { pass: true, reason: '' };
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

    const res = await callDashScope('qwen-vl-plus', base64, prompt);
    const text = (res?.choices?.[0]?.message?.content || '是').trim();
    const valid = !text.startsWith('否');
    console.log(`🖼️ 作品图验证: ${valid ? '✅通过' : '❌不通过'}`);
    return { valid, reason: valid ? '' : '上传的作品图片看起来不是艺术作品，请重新上传画作照片' };
  } catch (e) {
    console.error('作品图验证异常（放行）:', e.message);
    return { valid: true };
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

    const res = await callDashScope('qwen-vl-plus', base64, prompt);
    const text = (res?.choices?.[0]?.message?.content || '是').trim();
    const valid = !text.startsWith('否');
    console.log(`🏠 空间图验证: ${valid ? '✅通过' : '❌不通过'}`);
    return { valid, reason: valid ? '' : '上传的空间图片看起来不是室内空间，请重新上传房间照片' };
  } catch (e) {
    console.error('空间图验证异常（放行）:', e.message);
    return { valid: true };
  }
}

// ──────────────────────────────────────────────
// 画作一致性检查：对比原作品图和效果图里的挂画是否是同一幅
// 模型：qwen-vl-flash（够用，省钱）
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

    // 发送两张图片
    const body = {
      model: 'qwen-vl-plus',
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

    const host = process.env.DASHSCOPE_HOST || 'dashscope-intl.aliyuncs.com';
    const res = await callVisionAPI(host, '/compatible-mode/v1/chat/completions',
      process.env.DASHSCOPE_API_KEY, null, null, null, body);
    const text = res?.choices?.[0]?.message?.content || '通过';
    const result = parseResult(text);
    console.log(`🔍 Qwen 画作一致性: ${result.pass ? '✅通过' : '❌不通过 ' + result.reason}`);
    return result;
  } catch (e) {
    console.error('Qwen 画作一致性检查异常（跳过）:', e.message);
    return { pass: true };
  }
}

module.exports = { reviewPhysics, reviewDimensions, validateArtworkImage, validateSpaceImage, reviewArtworkConsistency };
