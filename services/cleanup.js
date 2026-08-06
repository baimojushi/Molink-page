// services/cleanup.js —— 定时清理过期图片（2天有效期）
const fs = require('fs');
const path = require('path');
const db = require('../database');
const { pruneThumbnailCache } = require('./thumbs');

const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');
const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');

// 有效期：2天（单位：毫秒）
const 有效期 = 2 * 24 * 60 * 60 * 1000;

function safeJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function safeDecodeURIComponent(value) {
  const text = String(value || '');
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

function basenameForCompare(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      return safeDecodeURIComponent(path.basename(parsed.pathname));
    }
  } catch (error) {}
  return safeDecodeURIComponent(path.basename(raw.split('?')[0]));
}

function recordHasR2Backup(record) {
  if (!record) return false;
  return Boolean(record.r2_url || record.r2_public_url || record.permanent_url || record.r2_key);
}

function addFilename(set, value) {
  const basename = basenameForCompare(value);
  if (basename) set.add(basename);
}

function getR2BackedDeliveryFilenames() {
  const backed = new Set();
  try {
    const rows = db.prepare(`
      SELECT delivery_images, delivery_result_records_json
      FROM orders
      WHERE COALESCE(delivery_images, '') <> ''
         OR COALESCE(delivery_result_records_json, '') <> ''
    `).all();

    for (const row of rows) {
      const images = safeJsonArray(row.delivery_images, []);
      const records = safeJsonArray(row.delivery_result_records_json, []);
      records.forEach((record, index) => {
        if (!recordHasR2Backup(record)) return;
        addFilename(backed, record.filename);
        addFilename(backed, record.local_image_url);
        addFilename(backed, record.image_url);
        addFilename(backed, images[index]);
      });
    }
    return backed;
  } catch (error) {
    console.warn('读取交付图 R2 备份记录失败，跳过本次 deliveries 清理:', error.message);
    return null;
  }
}

function listImageFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.match(/\.(jpg|jpeg|png|webp|bmp|tiff)$/i));
}

function cleanupOldFilesInDir(dir, shouldDeleteFile) {
  const 当前时间 = Date.now();
  let 清理数量 = 0;
  const 文件列表 = listImageFiles(dir);
  for (const 文件名 of 文件列表) {
    const 文件路径 = path.join(dir, 文件名);
    let 文件状态;
    try {
      文件状态 = fs.statSync(文件路径);
    } catch (error) {
      continue;
    }
    if (当前时间 - 文件状态.mtimeMs <= 有效期) continue;
    if (!shouldDeleteFile(文件名, 文件路径)) continue;
    fs.unlinkSync(文件路径);
    清理数量++;
  }
  return 清理数量;
}

/**
 * 清理超过2天的图片文件
 * uploads 仍按原策略清理；deliveries 只有确认已有 R2 备份时才清理本地副本。
 */
function 清理过期图片() {
  let 清理数量 = 0;

  // 清理用户上传的原图
  清理数量 += cleanupOldFilesInDir(UPLOADS_DIR, () => true);

  // 清理交付图片：必须确认数据库已有 r2_url/r2_key 备份，避免本地唯一副本被删。
  const r2BackedDeliveryFilenames = getR2BackedDeliveryFilenames();
  if (r2BackedDeliveryFilenames) {
    清理数量 += cleanupOldFilesInDir(DELIVERIES_DIR, 文件名 => r2BackedDeliveryFilenames.has(safeDecodeURIComponent(文件名)));
  }

  if (清理数量 > 0) {
    console.log(`🗑️  已清理 ${清理数量} 个过期图片文件`);
  }

  pruneThumbnailCache()
    .then(result => {
      if (result && result.deleted > 0) {
        console.log(`🗑️  已清理 ${result.deleted} 个缩略图缓存文件`);
      }
    })
    .catch(error => console.warn('缩略图缓存清理失败:', error.message));
}

/**
 * 启动定时清理任务（每天执行一次）
 */
function 启动定时清理() {
  // 立即执行一次
  清理过期图片();

  // 每24小时执行一次
  setInterval(清理过期图片, 24 * 60 * 60 * 1000);

  console.log('✅ 图片清理任务已启动（uploads有效期2天；deliveries仅在已有R2备份时清理）');
}

module.exports = { 启动定时清理, 清理过期图片 };
