const { getWxMiniappCredentials } = require('./wxMiniappConfig');
const TEMPLATE_ID = process.env.WX_NOTIFY_TEMPLATE_ID || 'WBedF813hIJYRHpG0Gki9vU40Z3EoaKDmrXVC8lD4sY';
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'https://www.molink.art';

let cachedAccessToken = '';
let cachedExpireAt = 0;

function 截断字符(value, max = 20) {
  return String(value || '').trim().slice(0, max);
}

function 格式化时间(value) {
  const date = value ? new Date(value) : new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function 失效时间(value, days = 7) {
  const date = value ? new Date(value) : new Date();
  date.setDate(date.getDate() + days);
  return date;
}

async function 获取微信AccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpireAt) {
    return cachedAccessToken;
  }

  const wxConfig = getWxMiniappCredentials();
  if (!wxConfig.appid || !wxConfig.secret) {
    throw new Error('缺少微信小程序 AppID 或 AppSecret，无法发送订阅通知');
  }

  const response = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(wxConfig.appid)}&secret=${encodeURIComponent(wxConfig.secret)}`
  );
  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(`获取微信 access_token 失败: ${data.errmsg || response.status}`);
  }

  cachedAccessToken = data.access_token;
  cachedExpireAt = Date.now() + Math.max((data.expires_in || 7200) - 300, 60) * 1000;
  return cachedAccessToken;
}

async function notifyCollector(openid, order = {}) {
  const normalizedOpenid = String(openid || '').trim();
  if (!normalizedOpenid) {
    return { skipped: true, reason: 'missing_openid' };
  }

  if (!(Number(order.subscribe_completion || 0) === 1)) {
    return { skipped: true, reason: 'subscription_not_accepted' };
  }

  const accessToken = await 获取微信AccessToken();
  const deliveredAt = order.delivered_at ? new Date(order.delivered_at) : new Date();
  const expireAt = 失效时间(deliveredAt, 7);
  const deliveryPage = order.id ? `pages/result/result?orderId=${order.id}` : 'pages/history/history';

  const payload = {
    touser: normalizedOpenid,
    template_id: order.subscribe_template_id || TEMPLATE_ID,
    page: deliveryPage,
    data: {
      thing7: { value: 截断字符('制作完成通知', 20) },
      thing1: { value: 截断字符(order.artwork_name || order.service_type_label || '墨林设计效果图', 20) },
      date2: { value: 格式化时间(deliveredAt) },
      date4: { value: 格式化时间(expireAt) },
      thing3: { value: 截断字符('请打开小程序查看作品', 20) }
    }
  };

  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  if (!response.ok || data.errcode) {
    throw new Error(`发送订阅消息失败: ${data.errcode || response.status} ${data.errmsg || ''}`.trim());
  }

  return {
    success: true,
    deliveryPage,
    deliveryUrl: order.delivery_token ? `${SERVER_BASE_URL}/d/${order.delivery_token}` : ''
  };
}

module.exports = { notifyCollector };
