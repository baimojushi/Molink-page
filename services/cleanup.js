// services/cleanup.js —— 定时清理过期图片（2天有效期）
const fs = require('fs');
const path = require('path');
const db = require('../database');

const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');
const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');

// 有效期：2天（单位：毫秒）
const 有效期 = 2 * 24 * 60 * 60 * 1000;

/**
 * 清理超过2天的图片文件
 */
function 清理过期图片() {
  const 当前时间 = Date.now();
  let 清理数量 = 0;

  // 清理用户上传的原图
  const 上传文件列表 = fs.readdirSync(UPLOADS_DIR).filter(f => f.match(/\.(jpg|jpeg|png|webp|bmp|tiff)$/i));
  for (const 文件名 of 上传文件列表) {
    const 文件路径 = path.join(UPLOADS_DIR, 文件名);
    const 文件状态 = fs.statSync(文件路径);
    if (当前时间 - 文件状态.mtimeMs > 有效期) {
      fs.unlinkSync(文件路径);
      清理数量++;
    }
  }

  // 清理交付的图片
  const 交付文件列表 = fs.readdirSync(DELIVERIES_DIR).filter(f => f.match(/\.(jpg|jpeg|png|webp|bmp|tiff)$/i));
  for (const 文件名 of 交付文件列表) {
    const 文件路径 = path.join(DELIVERIES_DIR, 文件名);
    const 文件状态 = fs.statSync(文件路径);
    if (当前时间 - 文件状态.mtimeMs > 有效期) {
      fs.unlinkSync(文件路径);
      清理数量++;
    }
  }

  if (清理数量 > 0) {
    console.log(`🗑️  已清理 ${清理数量} 个过期图片文件`);
  }
}

/**
 * 启动定时清理任务（每天执行一次）
 */
function 启动定时清理() {
  // 立即执行一次
  清理过期图片();
  
  // 每24小时执行一次
  setInterval(清理过期图片, 24 * 60 * 60 * 1000);
  
  console.log('✅ 图片清理任务已启动（有效期2天，每日检查）');
}

module.exports = { 启动定时清理, 清理过期图片 };
