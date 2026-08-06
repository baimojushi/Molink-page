const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { LEGACY_EXHIBITION, EXHIBITION_STATUSES } = require('../config/exhibitionIsolation');

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeStatus(value, fallback = 'draft') {
  const status = cleanText(value || fallback).toLowerCase();
  return EXHIBITION_STATUSES.includes(status) ? status : fallback;
}

function slugBase(value) {
  const normalized = cleanText(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || `exhibition-${Date.now().toString(36)}`;
}

function uniqueSlug(value, excludeId = '') {
  const base = slugBase(value);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const row = excludeId
      ? db.prepare('SELECT id FROM exhibitions WHERE slug = ? AND id <> ?').get(slug, excludeId)
      : db.prepare('SELECT id FROM exhibitions WHERE slug = ?').get(slug);
    if (!row) return slug;
  }
  return `${base}-${uuidv4().slice(0, 8)}`;
}

function withCounts(row) {
  if (!row) return null;
  return {
    ...row,
    artwork_count: Number(row.artwork_count || 0),
    order_count: Number(row.order_count || 0),
    geo_radius_m: Number(row.geo_radius_m || 400)
  };
}

function listExhibitions({ status = '', includeCounts = true } = {}) {
  const params = [];
  const clauses = [];
  const normalizedStatus = cleanText(status);
  if (normalizedStatus) {
    clauses.push('e.status = ?');
    params.push(normalizedStatus);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT e.*
      ${includeCounts ? ', (SELECT COUNT(*) FROM artworks a WHERE a.exhibition_id = e.id) AS artwork_count, (SELECT COUNT(*) FROM orders o WHERE o.exhibition_id = e.id) AS order_count' : ''}
    FROM exhibitions e
    ${whereSql}
    ORDER BY
      CASE e.status WHEN 'live' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
      CASE WHEN e.ends_at IS NULL OR TRIM(e.ends_at) = '' THEN 0 ELSE 1 END,
      COALESCE(e.starts_at, e.created_at) DESC,
      e.created_at DESC
  `).all(...params);
  return includeCounts ? rows.map(withCounts) : rows;
}

function getExhibitionById(id, { includeCounts = true } = {}) {
  const value = cleanText(id);
  if (!value) return null;
  const row = db.prepare(`
    SELECT e.*
      ${includeCounts ? ', (SELECT COUNT(*) FROM artworks a WHERE a.exhibition_id = e.id) AS artwork_count, (SELECT COUNT(*) FROM orders o WHERE o.exhibition_id = e.id) AS order_count' : ''}
    FROM exhibitions e WHERE e.id = ?
  `).get(value);
  return includeCounts ? withCounts(row) : row;
}

function getExhibitionBySlug(slug) {
  const value = cleanText(slug);
  if (!value) return null;
  return db.prepare('SELECT * FROM exhibitions WHERE LOWER(slug) = LOWER(?)').get(value) || null;
}

function createExhibition(payload = {}) {
  const name = cleanText(payload.name);
  if (!name) throw new Error('展览名称为必填项');
  const id = uuidv4();
  const slug = uniqueSlug(payload.slug || name);
  const status = normalizeStatus(payload.status, 'draft');
  db.prepare(`
    INSERT INTO exhibitions (
      id, name, slug, status, venue_name, geo_lat, geo_lng, geo_radius_m,
      starts_at, ends_at, cover_url, collection_advisor_name, collection_advisor_wechat, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
  `).run(
    id,
    name,
    slug,
    status,
    cleanText(payload.venue_name) || null,
    payload.geo_lat === '' || payload.geo_lat == null ? null : Number(payload.geo_lat),
    payload.geo_lng === '' || payload.geo_lng == null ? null : Number(payload.geo_lng),
    Math.max(1, Number(payload.geo_radius_m) || 400),
    cleanText(payload.starts_at) || null,
    cleanText(payload.ends_at) || null,
    cleanText(payload.cover_url) || null,
    cleanText(payload.collection_advisor_name) || null,
    cleanText(payload.collection_advisor_wechat) || null
  );
  return getExhibitionById(id);
}

function updateExhibition(id, payload = {}) {
  const current = getExhibitionById(id, { includeCounts: false });
  if (!current) return null;
  const name = payload.name !== undefined ? cleanText(payload.name) : current.name;
  if (!name) throw new Error('展览名称不能为空');
  const slug = payload.slug !== undefined
    ? uniqueSlug(payload.slug || name, current.id)
    : current.slug;
  const status = payload.status !== undefined ? normalizeStatus(payload.status, current.status) : current.status;
  const pickText = (key) => payload[key] !== undefined ? (cleanText(payload[key]) || null) : current[key];
  const pickNumber = (key, fallback = null) => {
    if (payload[key] === undefined) return current[key];
    if (payload[key] === '' || payload[key] == null) return fallback;
    return Number(payload[key]);
  };
  db.prepare(`
    UPDATE exhibitions SET
      name = ?, slug = ?, status = ?, venue_name = ?, geo_lat = ?, geo_lng = ?, geo_radius_m = ?,
      starts_at = ?, ends_at = ?, cover_url = ?, collection_advisor_name = ?, collection_advisor_wechat = ?,
      updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(
    name,
    slug,
    status,
    pickText('venue_name'),
    pickNumber('geo_lat'),
    pickNumber('geo_lng'),
    Math.max(1, pickNumber('geo_radius_m', 400) || 400),
    pickText('starts_at'),
    pickText('ends_at'),
    pickText('cover_url'),
    pickText('collection_advisor_name'),
    pickText('collection_advisor_wechat'),
    current.id
  );
  return getExhibitionById(current.id);
}

function deleteOrArchiveExhibition(id) {
  const exhibition = getExhibitionById(id);
  if (!exhibition) return null;
  if (exhibition.id === LEGACY_EXHIBITION.id && (exhibition.artwork_count > 0 || exhibition.order_count > 0)) {
    return { action: 'archived', exhibition: updateExhibition(id, { status: 'archived' }) };
  }
  if (exhibition.artwork_count > 0 || exhibition.order_count > 0) {
    return { action: 'archived', exhibition: updateExhibition(id, { status: 'archived' }) };
  }
  db.prepare('DELETE FROM exhibitions WHERE id = ?').run(id);
  return { action: 'deleted', exhibition };
}

function isStrictClientScope() {
  return ['1', 'true', 'yes', 'on'].includes(cleanText(process.env.STRICT_EXHIBITION_SCOPE).toLowerCase());
}

function resolveClientExhibitionScope(requestedId) {
  const id = cleanText(requestedId);
  if (id) {
    const exhibition = getExhibitionById(id, { includeCounts: false });
    if (!exhibition) return { exhibition: null, exhibitionId: '', needExhibition: true, error: '展览不存在' };
    return { exhibition, exhibitionId: exhibition.id, needExhibition: false };
  }
  if (isStrictClientScope()) {
    return { exhibition: null, exhibitionId: '', needExhibition: true };
  }
  const live = listExhibitions({ status: 'live', includeCounts: false });
  if (live.length === 1) {
    return { exhibition: live[0], exhibitionId: live[0].id, needExhibition: false, fallback: true };
  }
  return { exhibition: null, exhibitionId: '', needExhibition: true };
}

function resolveAdminExhibitionId(req) {
  const value = cleanText(
    (req && req.query && req.query.exhibition_id) ||
    (req && req.headers && req.headers['x-exhibition-id']) ||
    ''
  );
  if (!value || value.toLowerCase() === 'all') return '';
  return value;
}

module.exports = {
  LEGACY_EXHIBITION,
  EXHIBITION_STATUSES,
  listExhibitions,
  getExhibitionById,
  getExhibitionBySlug,
  createExhibition,
  updateExhibition,
  deleteOrArchiveExhibition,
  resolveClientExhibitionScope,
  resolveAdminExhibitionId,
  isStrictClientScope
};
