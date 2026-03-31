// services/wxNotify.js —— 微信订阅消息通知
const https = require('https');

const WX_APPID  = process.env.WX_APPID  || 'wx248d207b3006d7f0';
const WX_SECRET = process.env.WX_SECRET || '27281704adb1e19e2b3e686692a574a1';

// 效果图完成通知的模板ID（在微信公众平台申请后填入）
// 环境变量：WX_SUB_TEMPLATE_ID
const TEMPLATE_ID = process.env.WX_SUB_TEMPLATE_ID || '';

// Access token 缓存
let cachedToken = '';
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && tokenExpiresAt > now + 60) return cachedToken;

  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_APPID}&secret=${WX_SECRET}`;
    const urlObj = new URL(url);
    https.get({ hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            cachedToken = json.access_token;
            tokenExpiresAt = now + (json.expires_in || 7200) - 120;
            resolve(cachedToken);
          } else {
            reject(new Error('获取access_token失败: ' + JSON.stringify(json)));
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ──────────────────────────────────────────────
// 发送订阅消息通知藏家：效果图已完成
// openid: 藏家的微信openid
// order: 订单信息（含 service_type_label）
// ──────────────────────────────────────────────
async function notifyCollector(openid, order) {
  if (!TEMPLATE_ID) {
    console.log('⏭️ 订阅消息未配置（未设置 WX_SUB_TEMPLATE_ID），跳过通知');
    return;
  }
  if (!openid) {
    console.log('⏭️ 藏家无 openid，无法发送订阅消息');
    return;
  }

  try {
    const token = await getAccessToken();
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const body = JSON.stringify({
      touser: openid,
      template_id: TEMPLATE_ID,
      page: 'pages/result/result',
      data: {
        thing1: { value: (order.service_type_label || '效果图').substring(0, 20) },
        time2:  { value: timeStr }
      }
    });

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.weixin.qq.com',
        path: `/cgi-bin/message/subscribe/send?access_token=${token}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          const json = JSON.parse(data);
          if (json.errcode === 0) {
            console.log(`✅ 订阅消息已发送 openid=${openid.substring(0,8)}...`);
          } else {
            console.warn(`⚠️ 订阅消息发送失败: ${JSON.stringify(json)}`);
          }
          resolve();
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.error('订阅消息异常:', e.message);
  }
}

module.exports = { notifyCollector };
