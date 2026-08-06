// services/wxMiniappConfig.js —— 微信小程序 AppID/AppSecret 统一配置
// 后端所有 wx.login、access_token、内容安全、订阅通知都从这里读取同一套配置。
// 不在代码里放旧 AppSecret，避免项目 AppID 与后端 fallback AppID 不一致导致 jscode2session 失败。

function pickEnv(names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return { value, name };
  }
  return { value: '', name: '' };
}

function mask(value, head = 6, tail = 4) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= head + tail) return `${raw.slice(0, 2)}***`;
  return `${raw.slice(0, head)}***${raw.slice(-tail)}`;
}

function getWxMiniappCredentials() {
  const appid = pickEnv([
    'WX_APPID',
    'MINIAPP_AUCTION_APPID',
    'MINIAPP_APPID',
    'WECHAT_MINIAPP_APPID'
  ]);
  const secret = pickEnv([
    'WX_SECRET',
    'MINIAPP_AUCTION_SECRET',
    'MINIAPP_SECRET',
    'WECHAT_MINIAPP_SECRET'
  ]);

  return {
    appid: appid.value,
    secret: secret.value,
    appidSource: appid.name,
    secretSource: secret.name,
    maskedAppid: mask(appid.value, 8, 4),
    maskedSecret: secret.value ? 'configured' : ''
  };
}

function describeWxMiniappConfig() {
  const config = getWxMiniappCredentials();
  return {
    appidConfigured: Boolean(config.appid),
    secretConfigured: Boolean(config.secret),
    appidSource: config.appidSource,
    secretSource: config.secretSource,
    maskedAppid: config.maskedAppid
  };
}

module.exports = {
  getWxMiniappCredentials,
  describeWxMiniappConfig
};
