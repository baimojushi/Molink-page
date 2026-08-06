const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const db = require('../database');
const { ensureArtworkScanToken } = require('./scanTokens');
const { uploadBuffer, deleteObjectByKey, buildArtworkObjectKey, buildArtworkThumbObjectKey, downloadObjectBufferByKey } = require('./r2');
const {
  getMiniappQrAsset,
  ensureMiniappCodeForArtwork,
  removeMiniappCodeForArtwork,
  getMiniappSceneValue,
  getMiniappScanPagePath,
  getMiniappScanPageDisplayPath
} = require('./miniappCodes');

const ARTWORK_THUMB_WIDTH = Math.max(160, Math.min(Number(process.env.ARTWORK_THUMB_WIDTH) || 320, 1600));
const ARTWORK_THUMB_QUALITY = Math.max(60, Math.min(Number(process.env.ARTWORK_THUMB_QUALITY) || 78, 92));

function nowText() {
  return db.prepare("SELECT datetime('now','localtime') AS now").get().now;
}

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeDimensionValue(value) {
  return cleanText(value).replace(/\s+/g, ' ');
}

function buildDimensionText(length, trans) {
  const a = normalizeDimensionValue(length);
  const b = normalizeDimensionValue(trans);
  if (a && b) return `${a} × ${b}`;
  return a || b || '';
}

function pickAssetThumbUrl(asset) {
  if (!asset) return '';
  return cleanText(asset.thumb_url) || buildFallbackThumbUrl(asset.url);
}


function buildFallbackThumbUrl(sourceUrl) {
  const value = cleanText(sourceUrl);
  if (!value) return '';
  return `/api/client/thumb?url=${encodeURIComponent(value)}&w=${ARTWORK_THUMB_WIDTH}&h=${ARTWORK_THUMB_WIDTH}&fit=cover&q=${ARTWORK_THUMB_QUALITY}`;
}


async function createArtworkThumbUpload({ artworkCode, assetId, assetKind, sourceBuffer }) {
  if (!sourceBuffer || !sourceBuffer.length) return null;
  const thumbBuffer = await sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize({
      width: ARTWORK_THUMB_WIDTH,
      height: ARTWORK_THUMB_WIDTH,
      fit: 'cover',
      position: 'attention',
      withoutEnlargement: true
    })
    .webp({ quality: ARTWORK_THUMB_QUALITY, effort: 4 })
    .toBuffer();
  const thumbMeta = await sharp(thumbBuffer, { failOn: 'none' }).metadata().catch(() => ({}));
  const thumbKey = buildArtworkThumbObjectKey({ artworkCode, assetId, assetKind, size: ARTWORK_THUMB_WIDTH });
  const uploaded = await uploadBuffer({
    key: thumbKey,
    body: thumbBuffer,
    contentType: 'image/webp',
    cacheControl: 'public, max-age=31536000, immutable'
  });
  return {
    key: uploaded.key,
    url: uploaded.url,
    width: thumbMeta.width || ARTWORK_THUMB_WIDTH,
    height: thumbMeta.height || ARTWORK_THUMB_WIDTH
  };
}

async function ensureAssetThumbnail(asset, artworkCode) {
  if (!asset || !artworkCode) return null;
  if (asset.thumb_url && asset.thumb_r2_key) {
    return {
      key: asset.thumb_r2_key,
      url: asset.thumb_url,
      width: asset.thumb_width || ARTWORK_THUMB_WIDTH,
      height: asset.thumb_height || ARTWORK_THUMB_WIDTH
    };
  }
  let sourceBuffer = null;
  if (asset.r2_key) {
    sourceBuffer = await downloadObjectBufferByKey(asset.r2_key);
  }
  if ((!sourceBuffer || !sourceBuffer.length) && asset.url) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`FetchAssetFailed:${response.status}`);
    sourceBuffer = Buffer.from(await response.arrayBuffer());
  }
  if (!sourceBuffer || !sourceBuffer.length) return null;
  const thumb = await createArtworkThumbUpload({
    artworkCode,
    assetId: asset.id,
    assetKind: asset.asset_kind,
    sourceBuffer
  });
  if (!thumb) return null;
  db.prepare(`
    UPDATE artwork_assets
    SET thumb_r2_key = ?, thumb_url = ?, thumb_width = ?, thumb_height = ?
    WHERE id = ?
  `).run(thumb.key, thumb.url, thumb.width, thumb.height, asset.id);
  asset.thumb_r2_key = thumb.key;
  asset.thumb_url = thumb.url;
  asset.thumb_width = thumb.width;
  asset.thumb_height = thumb.height;
  return thumb;
}

function formatAsset(asset) {
  return {
    id: asset.id,
    artwork_id: asset.artwork_id,
    asset_kind: asset.asset_kind,
    sort_order: Number(asset.sort_order || 0),
    url: asset.url,
    thumb_url: asset.thumb_url || '',
    r2_key: asset.r2_key,
    thumb_r2_key: asset.thumb_r2_key || null,
    original_filename: asset.original_filename,
    mime_type: asset.mime_type,
    file_size: asset.file_size,
    width: asset.width,
    height: asset.height,
    thumb_width: asset.thumb_width || null,
    thumb_height: asset.thumb_height || null,
    created_at: asset.created_at
  };
}

function resolveDisplayImages(artworkImages, frameImages, effectImages, coverAsset) {
  const prioritized = [];
  if (coverAsset && coverAsset.url) prioritized.push(coverAsset.url);
  for (const asset of [...artworkImages, ...frameImages, ...effectImages]) {
    if (asset && asset.url) prioritized.push(asset.url);
  }
  return [...new Set(prioritized.filter(Boolean))];
}

function resolveDisplayThumbs(artworkImages, frameImages, effectImages, coverAsset) {
  const prioritized = [];
  if (coverAsset && pickAssetThumbUrl(coverAsset)) prioritized.push(pickAssetThumbUrl(coverAsset));
  for (const asset of [...artworkImages, ...frameImages, ...effectImages]) {
    const thumbUrl = pickAssetThumbUrl(asset);
    if (thumbUrl) prioritized.push(thumbUrl);
  }
  return [...new Set(prioritized.filter(Boolean))];
}

function normalizeArtworkRow(row) {
  if (!row) return null;
  const artworkImages = db.prepare(`
    SELECT * FROM artwork_assets
    WHERE artwork_id = ? AND asset_kind = 'artwork'
    ORDER BY sort_order ASC, created_at ASC
  `).all(row.id);
  const frameImages = db.prepare(`
    SELECT * FROM artwork_assets
    WHERE artwork_id = ? AND asset_kind = 'frame'
    ORDER BY sort_order ASC, created_at ASC
  `).all(row.id);
  const effectImages = db.prepare(`
    SELECT * FROM artwork_assets
    WHERE artwork_id = ? AND asset_kind = 'effect'
    ORDER BY sort_order ASC, created_at ASC
    LIMIT 1
  `).all(row.id);
  const coverAsset = row.cover_asset_id
    ? db.prepare('SELECT * FROM artwork_assets WHERE id = ?').get(row.cover_asset_id)
    : null;
  const qrAsset = getMiniappQrAsset(row.id);

  const images = resolveDisplayImages(artworkImages, frameImages, effectImages, coverAsset);
  const thumbImages = resolveDisplayThumbs(artworkImages, frameImages, effectImages, coverAsset);
  const primaryArtwork = artworkImages[0] || frameImages[0] || effectImages[0] || null;
  const sizeText = buildDimensionText(row.length, row.trans) || cleanText(row.size_text);
  const frameSizeText = buildDimensionText(row.frame_length, row.frame_trans);

  return {
    id: row.id,
    num: row.artwork_code,
    ref: row.artwork_code,
    code: row.artwork_code,
    artwork_code: row.artwork_code,
    exhibition_id: row.exhibition_id,
    exhibition_name: row.exhibition_name || '',
    exhibition_status: row.exhibition_status || '',
    exhibition_collection_advisor_name: row.exhibition_collection_advisor_name || '',
    exhibition_collection_advisor_wechat: row.exhibition_collection_advisor_wechat || '',
    scan_token: row.scan_token || '',
    name: row.name,
    author: row.author,
    price: cleanText(row.price),
    length: cleanText(row.length),
    trans: cleanText(row.trans),
    frame_length: cleanText(row.frame_length),
    frame_trans: cleanText(row.frame_trans),
    size: sizeText,
    size_text: sizeText,
    frame_size_text: frameSizeText,
    description: row.description || '',
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    cover_asset_id: row.cover_asset_id || null,
    cover_url: coverAsset ? coverAsset.url : (images[0] || ''),
    cover_thumb_url: coverAsset ? pickAssetThumbUrl(coverAsset) : (thumbImages[0] || ''),
    primary_image_url: primaryArtwork ? primaryArtwork.url : (images[0] || ''),
    primary_thumb_url: primaryArtwork ? pickAssetThumbUrl(primaryArtwork) : (thumbImages[0] || ''),
    images,
    thumb_images: thumbImages,
    artwork_images: artworkImages.map(asset => asset.url),
    artwork_thumb_images: artworkImages.map(asset => pickAssetThumbUrl(asset)).filter(Boolean),
    frame_images: frameImages.map(asset => asset.url),
    frame_thumb_images: frameImages.map(asset => pickAssetThumbUrl(asset)).filter(Boolean),
    effect_images: effectImages.map(asset => asset.url),
    effect_thumb_images: effectImages.map(asset => pickAssetThumbUrl(asset)).filter(Boolean),
    artwork_assets: artworkImages.map(formatAsset),
    frame_assets: frameImages.map(formatAsset),
    effect_assets: effectImages.map(formatAsset),
    qrcode_asset: qrAsset ? formatAsset(qrAsset) : null,
    qrcode_url: qrAsset ? qrAsset.url : '',
    scan_page_path: getMiniappScanPagePath(),
    scan_page_display_path: row.scan_token ? getMiniappScanPageDisplayPath(row.scan_token) : '',
    scan_scene: row.scan_token ? getMiniappSceneValue(row.scan_token) : ''
  };
}

function listArtworks({ keyword = '', status = '', exhibitionId = '' } = {}) {
  const clauses = [];
  const params = [];
  const q = cleanText(keyword).toLowerCase();
  if (q) {
    clauses.push(`LOWER(
      COALESCE(a.artwork_code,'') || ' ' ||
      COALESCE(a.name,'') || ' ' ||
      COALESCE(a.author,'') || ' ' ||
      COALESCE(a.price,'') || ' ' ||
      COALESCE(a.size_text,'') || ' ' ||
      COALESCE(a.length,'') || ' ' ||
      COALESCE(a.trans,'') || ' ' ||
      COALESCE(a.frame_length,'') || ' ' ||
      COALESCE(a.frame_trans,'')
    ) LIKE ?`);
    params.push(`%${q}%`);
  }
  if (status) {
    clauses.push('a.status = ?');
    params.push(status);
  }
  if (exhibitionId) {
    clauses.push('a.exhibition_id = ?');
    params.push(exhibitionId);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT a.*, e.name AS exhibition_name, e.status AS exhibition_status,
           e.collection_advisor_name AS exhibition_collection_advisor_name,
           e.collection_advisor_wechat AS exhibition_collection_advisor_wechat
    FROM artworks a
    LEFT JOIN exhibitions e ON e.id = a.exhibition_id
    ${whereSql}
    ORDER BY a.created_at DESC
  `).all(...params);
  return rows.map(normalizeArtworkRow);
}

function buildArtworkLiteRow(row) {
  const sizeText = buildDimensionText(row.length, row.trans) || cleanText(row.size_text);
  return {
    id: row.id,
    artwork_code: row.artwork_code,
    exhibition_id: row.exhibition_id,
    exhibition_name: row.exhibition_name || '',
    exhibition_status: row.exhibition_status || '',
    exhibition_collection_advisor_name: row.exhibition_collection_advisor_name || '',
    exhibition_collection_advisor_wechat: row.exhibition_collection_advisor_wechat || '',
    scan_token: row.scan_token || '',
    code: row.artwork_code,
    num: row.artwork_code,
    name: row.name,
    author: row.author,
    price: cleanText(row.price),
    size_text: sizeText,
    size: sizeText,
    thumb_url: cleanText(row.cover_thumb_url || row.primary_thumb_url) || buildFallbackThumbUrl(row.cover_url || row.primary_image_url),
    image_url: cleanText(row.primary_image_url || row.cover_url),
    full_url: cleanText(row.primary_image_url || row.cover_url),
    cover_url: cleanText(row.cover_url),
    cover_thumb_url: cleanText(row.cover_thumb_url),
    primary_image_url: cleanText(row.primary_image_url),
    primary_thumb_url: cleanText(row.primary_thumb_url)
  };
}

function listArtworksLite({ keyword = '', status = '', exhibitionId = '', limit = 60, cursor = 0 } = {}) {
  const clauses = [];
  const params = [];
  const q = cleanText(keyword).toLowerCase();
  if (q) {
    clauses.push(`LOWER(
      COALESCE(a.artwork_code,'') || ' ' ||
      COALESCE(a.name,'') || ' ' ||
      COALESCE(a.author,'') || ' ' ||
      COALESCE(a.price,'') || ' ' ||
      COALESCE(a.size_text,'') || ' ' ||
      COALESCE(a.length,'') || ' ' ||
      COALESCE(a.trans,'') || ' ' ||
      COALESCE(a.frame_length,'') || ' ' ||
      COALESCE(a.frame_trans,'')
    ) LIKE ?`);
    params.push(`%${q}%`);
  }
  if (status) {
    clauses.push('a.status = ?');
    params.push(status);
  }
  if (exhibitionId) {
    clauses.push('a.exhibition_id = ?');
    params.push(exhibitionId);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 60, 120));
  const normalizedOffset = Math.max(0, Number(cursor) || 0);
  const rows = db.prepare(`
    SELECT
      a.id, a.exhibition_id, a.scan_token, a.artwork_code, a.name, a.author, a.price, a.length, a.trans, a.size_text, a.created_at,
      e.name AS exhibition_name, e.status AS exhibition_status,
      e.collection_advisor_name AS exhibition_collection_advisor_name,
      e.collection_advisor_wechat AS exhibition_collection_advisor_wechat,
      cover.url AS cover_url,
      cover.thumb_url AS cover_thumb_url,
      primary_asset.url AS primary_image_url,
      primary_asset.thumb_url AS primary_thumb_url
    FROM artworks a
    LEFT JOIN exhibitions e ON e.id = a.exhibition_id
    LEFT JOIN artwork_assets cover ON cover.id = a.cover_asset_id
    LEFT JOIN artwork_assets primary_asset ON primary_asset.id = (
      SELECT aa.id FROM artwork_assets aa
      WHERE aa.artwork_id = a.id AND aa.asset_kind IN ('artwork','frame','effect')
      ORDER BY CASE aa.asset_kind WHEN 'artwork' THEN 1 WHEN 'frame' THEN 2 ELSE 3 END ASC,
               aa.sort_order ASC,
               aa.created_at ASC
      LIMIT 1
    )
    ${whereSql}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, normalizedLimit + 1, normalizedOffset);
  const hasMore = rows.length > normalizedLimit;
  return {
    artworks: rows.slice(0, normalizedLimit).map(buildArtworkLiteRow),
    next_cursor: hasMore ? String(normalizedOffset + normalizedLimit) : '',
    has_more: hasMore
  };
}

function getArtworkById(id) {
  const row = db.prepare(`
    SELECT a.*, e.name AS exhibition_name, e.status AS exhibition_status,
           e.collection_advisor_name AS exhibition_collection_advisor_name,
           e.collection_advisor_wechat AS exhibition_collection_advisor_wechat
    FROM artworks a
    LEFT JOIN exhibitions e ON e.id = a.exhibition_id
    WHERE a.id = ?
  `).get(id);
  return normalizeArtworkRow(row);
}

function findArtworkByScanToken(token) {
  const value = cleanText(token);
  if (!value) return null;
  const row = db.prepare(`
    SELECT a.*, e.name AS exhibition_name, e.status AS exhibition_status,
           e.collection_advisor_name AS exhibition_collection_advisor_name,
           e.collection_advisor_wechat AS exhibition_collection_advisor_wechat
    FROM artworks a
    LEFT JOIN exhibitions e ON e.id = a.exhibition_id
    WHERE a.scan_token = ?
    LIMIT 1
  `).get(value);
  return normalizeArtworkRow(row);
}

function findArtworkByCodeInExhibition(code, exhibitionId) {
  const value = cleanText(code);
  const scope = cleanText(exhibitionId);
  if (!value || !scope) return null;
  const row = db.prepare(`
    SELECT a.*, e.name AS exhibition_name, e.status AS exhibition_status,
           e.collection_advisor_name AS exhibition_collection_advisor_name,
           e.collection_advisor_wechat AS exhibition_collection_advisor_wechat
    FROM artworks a
    LEFT JOIN exhibitions e ON e.id = a.exhibition_id
    WHERE a.exhibition_id = ? AND LOWER(a.artwork_code) = LOWER(?)
    LIMIT 1
  `).get(scope, value);
  return normalizeArtworkRow(row);
}

function findArtworkBySlugAndCode(slug, code) {
  const exhibitionSlug = cleanText(slug);
  const value = cleanText(code);
  if (!exhibitionSlug || !value) return null;
  const row = db.prepare(`
    SELECT a.*, e.name AS exhibition_name, e.status AS exhibition_status,
           e.collection_advisor_name AS exhibition_collection_advisor_name,
           e.collection_advisor_wechat AS exhibition_collection_advisor_wechat
    FROM artworks a
    INNER JOIN exhibitions e ON e.id = a.exhibition_id
    WHERE LOWER(e.slug) = LOWER(?) AND LOWER(a.artwork_code) = LOWER(?)
    LIMIT 1
  `).get(exhibitionSlug, value);
  return normalizeArtworkRow(row);
}

function ensureScanToken(artworkId) {
  const result = ensureArtworkScanToken(artworkId);
  return { ...result, artwork: getArtworkById(artworkId) };
}

function findArtworkByCodeLike(input) {
  const raw = cleanText(input);
  if (!raw) return null;
  const candidates = new Set([raw]);

  try {
    const parsed = JSON.parse(raw);
    ['code', 'artwork_code', 'id', 'artwork_id', 'num', 'artwork_num', 'artworkRef', 'artwork_ref'].forEach(key => {
      if (parsed && parsed[key]) candidates.add(String(parsed[key]));
    });
  } catch (error) {}

  try {
    const url = new URL(raw);
    ['code', 'artwork_code', 'id', 'artwork_id', 'num', 'artwork_num', 'artworkRef', 'artwork_ref'].forEach(key => {
      const value = url.searchParams.get(key);
      if (value) candidates.add(value);
    });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length) candidates.add(parts[parts.length - 1]);
  } catch (error) {}

  for (const candidate of candidates) {
    const value = cleanText(candidate);
    if (!value) continue;
    const byId = getArtworkById(value);
    if (byId) return byId;
    const rows = db.prepare('SELECT id FROM artworks WHERE LOWER(artwork_code) = LOWER(?) ORDER BY created_at ASC LIMIT 2').all(value);
    if (rows.length === 1) return getArtworkById(rows[0].id);
  }
  return null;
}

function generateArtworkCode(exhibitionId) {
  const scope = cleanText(exhibitionId);
  if (!scope) throw new Error('缺少所属展览');
  const now = new Date();
  const ym = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `AW-${ym}-`;
  const row = db.prepare(`
    SELECT artwork_code FROM artworks
    WHERE exhibition_id = ? AND artwork_code LIKE ?
    ORDER BY artwork_code DESC
    LIMIT 1
  `).get(scope, `${prefix}%`);
  let next = 1;
  if (row && row.artwork_code) {
    const match = String(row.artwork_code).match(/^AW-\d{4}-(\d{4})$/);
    if (match) next = Number(match[1]) + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

function normalizeArtworkPayload(payload = {}, current = {}) {
  const length = payload.length !== undefined ? normalizeDimensionValue(payload.length) : normalizeDimensionValue(current.length);
  const trans = payload.trans !== undefined ? normalizeDimensionValue(payload.trans) : normalizeDimensionValue(current.trans);
  const frameLength = payload.frame_length !== undefined ? normalizeDimensionValue(payload.frame_length) : normalizeDimensionValue(current.frame_length);
  const frameTrans = payload.frame_trans !== undefined ? normalizeDimensionValue(payload.frame_trans) : normalizeDimensionValue(current.frame_trans);
  const sizeText = buildDimensionText(length, trans);
  return {
    name: payload.name !== undefined ? cleanText(payload.name) : cleanText(current.name),
    author: payload.author !== undefined ? cleanText(payload.author) : cleanText(current.author),
    price: payload.price !== undefined ? cleanText(payload.price) : cleanText(current.price),
    length,
    trans,
    frame_length: frameLength,
    frame_trans: frameTrans,
    size_text: sizeText,
    description: payload.description !== undefined ? cleanText(payload.description) : cleanText(current.description),
    status: payload.status !== undefined ? cleanText(payload.status || 'published') : cleanText(current.status || 'published'),
    cover_asset_id: payload.cover_asset_id !== undefined ? (payload.cover_asset_id || null) : (current.cover_asset_id || null),
    exhibition_id: payload.exhibition_id !== undefined ? cleanText(payload.exhibition_id) : cleanText(current.exhibition_id)
  };
}

function createArtwork(payload) {
  const exhibitionId = cleanText(payload && payload.exhibition_id);
  if (!exhibitionId) throw new Error('所属展览为必填项');
  const exhibition = db.prepare('SELECT id FROM exhibitions WHERE id = ?').get(exhibitionId);
  if (!exhibition) throw new Error('所属展览不存在');
  const artworkId = uuidv4();
  const artworkCode = generateArtworkCode(exhibitionId);
  const now = nowText();
  const next = normalizeArtworkPayload(payload, {});
  db.prepare(`
    INSERT INTO artworks (
      id, exhibition_id, scan_token, artwork_code, name, author, price, length, trans, frame_length, frame_trans,
      size_text, description, status, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artworkId,
    exhibitionId,
    artworkCode,
    next.name,
    next.author,
    next.price,
    next.length,
    next.trans,
    next.frame_length,
    next.frame_trans,
    next.size_text,
    next.description,
    next.status,
    now,
    now
  );
  return getArtworkById(artworkId);
}

function updateArtwork(id, payload) {
  const current = db.prepare('SELECT * FROM artworks WHERE id = ?').get(id);
  if (!current) return null;
  const next = normalizeArtworkPayload(payload, current);
  db.prepare(`
    UPDATE artworks
    SET exhibition_id = ?, name = ?, author = ?, price = ?, length = ?, trans = ?, frame_length = ?, frame_trans = ?,
        size_text = ?, description = ?, status = ?, cover_asset_id = ?, updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(
    next.exhibition_id || current.exhibition_id,
    next.name,
    next.author,
    next.price,
    next.length,
    next.trans,
    next.frame_length,
    next.frame_trans,
    next.size_text,
    next.description,
    next.status,
    next.cover_asset_id,
    id
  );
  return getArtworkById(id);
}

function updateArtworkDimensions(artworkId, assetKind, payload = {}) {
  const current = db.prepare('SELECT * FROM artworks WHERE id = ?').get(artworkId);
  if (!current) return;
  if (assetKind === 'artwork') {
    const length = payload.length !== undefined ? normalizeDimensionValue(payload.length) : normalizeDimensionValue(current.length);
    const trans = payload.trans !== undefined ? normalizeDimensionValue(payload.trans) : normalizeDimensionValue(current.trans);
    db.prepare(`
      UPDATE artworks
      SET length = ?, trans = ?, size_text = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(length, trans, buildDimensionText(length, trans), artworkId);
  }
  if (assetKind === 'frame') {
    const frameLength = payload.frame_length !== undefined ? normalizeDimensionValue(payload.frame_length) : normalizeDimensionValue(current.frame_length);
    const frameTrans = payload.frame_trans !== undefined ? normalizeDimensionValue(payload.frame_trans) : normalizeDimensionValue(current.frame_trans);
    db.prepare(`
      UPDATE artworks
      SET frame_length = ?, frame_trans = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(frameLength, frameTrans, artworkId);
  }
}

async function deleteAssetRowAndObject(asset) {
  if (!asset) return;
  try {
    await deleteObjectByKey(asset.r2_key);
  } catch (error) {
    console.warn('R2 delete failed:', error.message);
  }
  if (asset.thumb_r2_key) {
    try {
      await deleteObjectByKey(asset.thumb_r2_key);
    } catch (error) {
      console.warn('R2 thumb delete failed:', error.message);
    }
  }
  db.prepare('DELETE FROM artwork_assets WHERE id = ?').run(asset.id);
}

async function addArtworkAssets({ artworkId, files, assetKind, dimensions = {} }) {
  const current = db.prepare('SELECT * FROM artworks WHERE id = ?').get(artworkId);
  if (!current) throw new Error('Artwork not found');

  const kind = ['artwork', 'effect', 'frame'].includes(String(assetKind)) ? String(assetKind) : 'artwork';
  const uploadFiles = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!uploadFiles.length) return [];

  if (kind === 'effect') {
    if (uploadFiles.length > 1) {
      throw new Error('每件作品只允许上传 1 张主效果图');
    }
    const existingEffects = db.prepare(`
      SELECT * FROM artwork_assets
      WHERE artwork_id = ? AND asset_kind = 'effect'
      ORDER BY created_at ASC
    `).all(artworkId);
    for (const asset of existingEffects) {
      await deleteAssetRowAndObject(asset);
    }
  }

  const countRow = db.prepare('SELECT COUNT(*) AS count FROM artwork_assets WHERE artwork_id = ? AND asset_kind = ?').get(artworkId, kind);
  let sortOrder = Number(countRow.count || 0) + 1;
  const inserted = [];
  for (const file of uploadFiles) {
    const assetId = uuidv4();
    const key = buildArtworkObjectKey({ artworkCode: current.artwork_code, assetId, assetKind: kind, originalName: file.originalname });
    const uploaded = await uploadBuffer({ key, body: file.buffer, contentType: file.mimetype || 'application/octet-stream' });
    const thumbUploaded = await createArtworkThumbUpload({
      artworkCode: current.artwork_code,
      assetId,
      assetKind: kind,
      sourceBuffer: file.buffer
    }).catch(error => {
      console.warn('作品缩略图生成失败:', error.message || error);
      return null;
    });
    let meta = {};
    try {
      meta = await sharp(file.buffer).metadata();
    } catch (error) {}
    db.prepare(`
      INSERT INTO artwork_assets (
        id, artwork_id, asset_kind, sort_order, r2_key, url, thumb_r2_key, thumb_url, thumb_width, thumb_height,
        original_filename, mime_type, file_size, width, height, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    `).run(
      assetId,
      artworkId,
      kind,
      sortOrder,
      uploaded.key,
      uploaded.url,
      thumbUploaded ? thumbUploaded.key : null,
      thumbUploaded ? thumbUploaded.url : null,
      thumbUploaded ? thumbUploaded.width : null,
      thumbUploaded ? thumbUploaded.height : null,
      file.originalname || '',
      file.mimetype || '',
      file.size || 0,
      meta.width || null,
      meta.height || null
    );
    if (!current.cover_asset_id) {
      db.prepare("UPDATE artworks SET cover_asset_id = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(assetId, artworkId);
      current.cover_asset_id = assetId;
    }
    inserted.push(db.prepare('SELECT * FROM artwork_assets WHERE id = ?').get(assetId));
    sortOrder += 1;
  }

  if ((kind === 'artwork' || kind === 'frame') && (dimensions.length || dimensions.trans || dimensions.frame_length || dimensions.frame_trans)) {
    updateArtworkDimensions(artworkId, kind, dimensions);
  } else {
    db.prepare("UPDATE artworks SET updated_at = datetime('now','localtime') WHERE id = ?").run(artworkId);
  }

  if (kind === 'effect') {
    try {
      await ensureMiniappCodeForArtwork(artworkId);
    } catch (error) {
      console.warn('主效果图上传后自动生成小程序码失败:', error.message);
    }
  }

  return inserted.map(formatAsset);
}

async function deleteArtworkAsset(assetId) {
  const asset = db.prepare('SELECT * FROM artwork_assets WHERE id = ?').get(assetId);
  if (!asset) return false;

  await deleteAssetRowAndObject(asset);

  const artwork = db.prepare('SELECT * FROM artworks WHERE id = ?').get(asset.artwork_id);
  if (artwork && artwork.cover_asset_id === assetId) {
    const nextCover = db.prepare(`
      SELECT id FROM artwork_assets
      WHERE artwork_id = ? AND asset_kind IN ('artwork', 'frame', 'effect')
      ORDER BY CASE asset_kind WHEN 'artwork' THEN 1 WHEN 'frame' THEN 2 ELSE 3 END ASC,
               sort_order ASC,
               created_at ASC
      LIMIT 1
    `).get(asset.artwork_id);
    db.prepare("UPDATE artworks SET cover_asset_id = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(nextCover ? nextCover.id : null, asset.artwork_id);
  }

  if (asset.asset_kind === 'effect') {
    const remainingEffect = db.prepare("SELECT id FROM artwork_assets WHERE artwork_id = ? AND asset_kind = 'effect' LIMIT 1").get(asset.artwork_id);
    if (!remainingEffect) {
      await removeMiniappCodeForArtwork(asset.artwork_id);
    }
  }

  db.prepare("UPDATE artworks SET updated_at = datetime('now','localtime') WHERE id = ?").run(asset.artwork_id);
  return true;
}

async function deleteArtwork(artworkId) {
  const assets = db.prepare('SELECT * FROM artwork_assets WHERE artwork_id = ?').all(artworkId);
  for (const asset of assets) {
    await deleteAssetRowAndObject(asset);
  }
  db.prepare('DELETE FROM artworks WHERE id = ?').run(artworkId);
}

function reorderAssets(artworkId, items) {
  const stmt = db.prepare("UPDATE artwork_assets SET sort_order = ? WHERE id = ? AND artwork_id = ? AND asset_kind IN ('artwork','frame')");
  const tx = db.transaction((list) => {
    for (const item of list) {
      stmt.run(Number(item.sort_order || 1), item.id, artworkId);
    }
  });
  tx(items || []);
  db.prepare("UPDATE artworks SET updated_at = datetime('now','localtime') WHERE id = ?").run(artworkId);
  return getArtworkById(artworkId);
}

function setArtworkCover(artworkId, assetId) {
  const asset = db.prepare("SELECT id FROM artwork_assets WHERE id = ? AND artwork_id = ? AND asset_kind IN ('artwork','frame','effect')").get(assetId, artworkId);
  if (!asset) {
    throw new Error('封面只能设置为作品图、装裱图或效果图');
  }
  db.prepare("UPDATE artworks SET cover_asset_id = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(assetId, artworkId);
  return getArtworkById(artworkId);
}

async function assignMiniappScanPage(artworkId) {
  const result = await ensureMiniappCodeForArtwork(artworkId);
  return {
    created: result.created,
    page_path: result.pagePath,
    display_path: result.displayPath,
    scene: result.scene,
    asset: result.asset ? formatAsset(result.asset) : null,
    artwork: getArtworkById(artworkId)
  };
}

module.exports = {
  listArtworks,
  listArtworksLite,
  getArtworkById,
  findArtworkByCodeLike,
  findArtworkByScanToken,
  findArtworkByCodeInExhibition,
  findArtworkBySlugAndCode,
  ensureScanToken,
  generateArtworkCode,
  createArtwork,
  updateArtwork,
  addArtworkAssets,
  deleteArtworkAsset,
  deleteArtwork,
  reorderAssets,
  setArtworkCover,
  normalizeArtworkRow,
  buildDimensionText,
  assignMiniappScanPage,
  ensureAssetThumbnail,
  ARTWORK_THUMB_WIDTH
};
