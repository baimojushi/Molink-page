const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { uploadBuffer, deleteObjectByKey, buildMiniappCodeObjectKey } = require('./r2');
const { ensureArtworkScanToken } = require('./scanTokens');
const { getWxMiniappCredentials } = require('./wxMiniappConfig');

// 与 wx.login / 内容安全 / 订阅通知共用同一套凭据解析，跨账号时只改环境变量。
const wxCredentials = getWxMiniappCredentials();
const MINIAPP_APPID = wxCredentials.appid;
const MINIAPP_SECRET = wxCredentials.secret;

const MINIAPP_SCAN_PAGE = 'pages/scan-entry/index';

function parseBooleanEnv(value, defaultValue) {
  if (value == null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function normalizeMiniappEnvVersion(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['release', 'trial', 'develop'].includes(normalized)) return normalized;
  return 'release';
}

const MINIAPP_CODE_ENV_VERSION = normalizeMiniappEnvVersion(
  process.env.MINIAPP_CODE_ENV_VERSION ||
  process.env.MINIAPP_ENV_VERSION ||
  'release'
);

const MINIAPP_CODE_CHECK_PATH = parseBooleanEnv(
  process.env.MINIAPP_CODE_CHECK_PATH,
  true
);

const MINIAPP_CODE_DEBUG = parseBooleanEnv(
  process.env.MINIAPP_CODE_DEBUG,
  false
);

let accessTokenCache = {
  token: '',
  expiresAt: 0
};

function getMiniappSceneValue(scanToken) {
  const token = String(scanToken || '').trim();
  return token ? `t=${token}` : '';
}

function getMiniappScanPagePath() {
  return MINIAPP_SCAN_PAGE;
}

function getMiniappScanPageDisplayPath(scanToken) {
  const scene = getMiniappSceneValue(scanToken);
  return scene ? `${MINIAPP_SCAN_PAGE}?scene=${scene}` : MINIAPP_SCAN_PAGE;
}

function getMiniappConfigState() {
  const configured = Boolean(MINIAPP_APPID && MINIAPP_SECRET);
  return {
    configured,
    appIdConfigured: Boolean(MINIAPP_APPID),
    secretConfigured: Boolean(MINIAPP_SECRET),
    appidSource: wxCredentials.appidSource,
    maskedAppid: wxCredentials.maskedAppid,
    scanPage: MINIAPP_SCAN_PAGE,
    envVersion: MINIAPP_CODE_ENV_VERSION,
    checkPath: MINIAPP_CODE_CHECK_PATH
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    const message = data && (data.errmsg || data.error || data.message)
      ? (data.errmsg || data.error || data.message)
      : `HTTP ${response.status}`;
    const err = new Error(message);
    err.httpStatus = response.status;
    err.payload = data;
    throw err;
  }
  return data || {};
}

async function getWechatAccessToken() {
  const now = Date.now();
  if (accessTokenCache.token && accessTokenCache.expiresAt > now + 120000) {
    return accessTokenCache.token;
  }

  if (!MINIAPP_APPID || !MINIAPP_SECRET) {
    throw new Error('缺少小程序 APPID 或 SECRET，请设置 MINIAPP_AUCTION_APPID 和 MINIAPP_AUCTION_SECRET');
  }

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(MINIAPP_APPID)}&secret=${encodeURIComponent(MINIAPP_SECRET)}`;
  const data = await fetchJson(url, { method: 'GET' });
  if (!data.access_token) {
    throw new Error(data.errmsg || '获取微信 access_token 失败');
  }

  const expiresIn = Number(data.expires_in || 7200);
  accessTokenCache = {
    token: data.access_token,
    expiresAt: now + expiresIn * 1000
  };
  return accessTokenCache.token;
}

function getArtworkRowById(artworkId) {
  return db.prepare('SELECT * FROM artworks WHERE id = ?').get(artworkId);
}

function getEffectAssetForArtwork(artworkId) {
  return db.prepare(`
    SELECT * FROM artwork_assets
    WHERE artwork_id = ? AND asset_kind = 'effect'
    ORDER BY sort_order ASC, created_at ASC
    LIMIT 1
  `).get(artworkId);
}

function listMiniappQrAssets(artworkId) {
  return db.prepare(`
    SELECT * FROM artwork_assets
    WHERE artwork_id = ? AND asset_kind = 'miniapp_qr'
    ORDER BY created_at ASC
  `).all(artworkId);
}

function getMiniappQrAsset(artworkId) {
  return listMiniappQrAssets(artworkId)[0] || null;
}

async function generateUnlimitedMiniappCode({ scanToken }) {
  const accessToken = await getWechatAccessToken();
  const requestBody = {
    scene: getMiniappSceneValue(scanToken),
    page: MINIAPP_SCAN_PAGE,
    check_path: MINIAPP_CODE_CHECK_PATH,
    env_version: MINIAPP_CODE_ENV_VERSION,
    width: 430,
    is_hyaline: false
  };

  if (MINIAPP_CODE_DEBUG) {
    console.log('[miniapp code request]', JSON.stringify(requestBody));
  }

  const response = await fetch(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const arrayBuffer = await response.arrayBuffer();
  const bodyBuffer = Buffer.from(arrayBuffer);

  if (contentType.includes('application/json') || contentType.includes('text/plain')) {
    let payload = null;
    try {
      payload = JSON.parse(bodyBuffer.toString('utf8'));
    } catch (error) {
      payload = null;
    }
    if (MINIAPP_CODE_DEBUG) {
      console.error('[miniapp code response error]', payload || bodyBuffer.toString('utf8'));
    }
    const message = payload && (payload.errmsg || payload.error || payload.message)
      ? (payload.errmsg || payload.error || payload.message)
      : `微信小程序码生成失败（HTTP ${response.status})`;
    const err = new Error(message);
    err.httpStatus = response.status;
    err.payload = payload;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`微信小程序码生成失败（HTTP ${response.status})`);
    err.httpStatus = response.status;
    throw err;
  }

  return bodyBuffer;
}

async function removeMiniappCodeForArtwork(artworkId) {
  const assets = listMiniappQrAssets(artworkId);
  for (const asset of assets) {
    try {
      await deleteObjectByKey(asset.r2_key);
    } catch (error) {
      console.warn('删除小程序码对象失败:', error.message);
    }
  }
  db.prepare("DELETE FROM artwork_assets WHERE artwork_id = ? AND asset_kind = 'miniapp_qr'").run(artworkId);
  if (assets.length) {
    db.prepare("UPDATE artworks SET updated_at = datetime('now','localtime') WHERE id = ?").run(artworkId);
  }
  return assets.length;
}

async function ensureMiniappCodeForArtwork(artworkId) {
  let artwork = getArtworkRowById(artworkId);
  if (!artwork) {
    throw new Error('作品不存在');
  }

  const tokenResult = ensureArtworkScanToken(artworkId);
  artwork = getArtworkRowById(artworkId);
  const scanToken = tokenResult.token;

  const effectAsset = getEffectAssetForArtwork(artworkId);
  if (!effectAsset) {
    throw new Error('请先上传作品主效果图，再分配扫码页');
  }

  let existing = getMiniappQrAsset(artworkId);
  const expectedFilename = `${artwork.artwork_code}-${scanToken}-${MINIAPP_CODE_ENV_VERSION}.png`;
  if (existing && existing.url && String(existing.original_filename || '') === expectedFilename) {
    return {
      created: false,
      asset: existing,
      pagePath: getMiniappScanPagePath(),
      displayPath: getMiniappScanPageDisplayPath(scanToken),
      scene: getMiniappSceneValue(scanToken)
    };
  }
  if (existing) {
    await removeMiniappCodeForArtwork(artworkId);
    existing = null;
  }

  const imageBuffer = await generateUnlimitedMiniappCode({ scanToken });
  const key = buildMiniappCodeObjectKey({
    artworkCode: artwork.artwork_code,
    scanToken,
    envVersion: MINIAPP_CODE_ENV_VERSION
  });
  const uploaded = await uploadBuffer({
    key,
    body: imageBuffer,
    contentType: 'image/png',
    cacheControl: 'public, max-age=31536000, immutable'
  });

  const assetId = uuidv4();
  db.prepare(`
    INSERT INTO artwork_assets (
      id, artwork_id, asset_kind, sort_order, r2_key, url,
      original_filename, mime_type, file_size, width, height, created_at
    ) VALUES (?, ?, 'miniapp_qr', 1, ?, ?, ?, ?, ?, NULL, NULL, datetime('now','localtime'))
  `).run(
    assetId,
    artworkId,
    uploaded.key,
    uploaded.url,
    expectedFilename,
    'image/png',
    imageBuffer.length
  );
  db.prepare("UPDATE artworks SET updated_at = datetime('now','localtime') WHERE id = ?").run(artworkId);

  const asset = db.prepare('SELECT * FROM artwork_assets WHERE id = ?').get(assetId);
  return {
    created: true,
    asset,
    pagePath: getMiniappScanPagePath(),
    displayPath: getMiniappScanPageDisplayPath(scanToken),
    scene: getMiniappSceneValue(scanToken)
  };
}

module.exports = {
  MINIAPP_SCAN_PAGE,
  MINIAPP_CODE_ENV_VERSION,
  MINIAPP_CODE_CHECK_PATH,
  getMiniappConfigState,
  getMiniappSceneValue,
  getMiniappScanPagePath,
  getMiniappScanPageDisplayPath,
  getWechatAccessToken,
  getMiniappQrAsset,
  ensureMiniappCodeForArtwork,
  removeMiniappCodeForArtwork
};
