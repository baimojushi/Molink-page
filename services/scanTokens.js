const crypto = require('crypto');
const db = require('../database');

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DEFAULT_TOKEN_LENGTH = 10;

function generateScanToken(length = DEFAULT_TOKEN_LENGTH) {
  const size = Math.max(8, Math.min(Number(length) || DEFAULT_TOKEN_LENGTH, 20));
  const bytes = crypto.randomBytes(size);
  let token = '';
  for (let index = 0; index < size; index += 1) {
    token += BASE62[bytes[index] % BASE62.length];
  }
  return token;
}

function ensureArtworkScanToken(artworkId) {
  const id = String(artworkId || '').trim();
  if (!id) throw new Error('缺少作品 ID');
  const current = db.prepare('SELECT scan_token FROM artworks WHERE id = ?').get(id);
  if (!current) throw new Error('作品不存在');
  const existing = String(current.scan_token || '').trim();
  if (existing) return { token: existing, created: false };

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const token = generateScanToken();
    try {
      const result = db.prepare(`
        UPDATE artworks
        SET scan_token = ?, updated_at = datetime('now','localtime')
        WHERE id = ? AND (scan_token IS NULL OR TRIM(scan_token) = '')
      `).run(token, id);
      if (result.changes) return { token, created: true };
      const raced = db.prepare('SELECT scan_token FROM artworks WHERE id = ?').get(id);
      if (raced && String(raced.scan_token || '').trim()) {
        return { token: String(raced.scan_token).trim(), created: false };
      }
    } catch (error) {
      if (!String(error && error.message || '').includes('UNIQUE')) throw error;
    }
  }
  throw new Error('扫码令牌生成失败，请重试');
}

function backfillArtworkScanTokens() {
  const rows = db.prepare(`
    SELECT id FROM artworks
    WHERE scan_token IS NULL OR TRIM(scan_token) = ''
    ORDER BY created_at ASC, id ASC
  `).all();
  let created = 0;
  for (const row of rows) {
    const result = ensureArtworkScanToken(row.id);
    if (result.created) created += 1;
  }
  return { total: rows.length, created };
}

module.exports = {
  BASE62,
  DEFAULT_TOKEN_LENGTH,
  generateScanToken,
  ensureArtworkScanToken,
  backfillArtworkScanTokens
};
