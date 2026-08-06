// routes/adminBackup.js —— SQLite 备份接口
// 复用 admin 路由的鉴权中间件（在 routes/admin.js 中 router.use(验证管理权限) 之后挂载）。
// 路径：/api/admin/backup/sqlite, /info, /restore

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../database');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'molink.db');
const upload = multer({ dest: path.join(DATA_DIR, 'tmp_restore') });

function tableCount(name) {
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n; } catch (e) { return null; }
}

// GET /api/admin/backup/sqlite —— 下载 db 文件
router.get('/backup/sqlite', (req, res) => {
  if (!fs.existsSync(DB_PATH)) return res.status(404).json({ error: 'db file not found' });
  // WAL 模式下，checkpoint 前 .db 文件不含最近事务；强制 TRUNCATE checkpoint 确保备份完整
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.warn('[backup] WAL checkpoint 失败（继续备份）:', e.message);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  console.log(`[backup] admin download from ${req.ip} at ${new Date().toISOString()}`);
  res.setHeader('Content-Disposition', `attachment; filename="molink_backup_${ts}.db"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(DB_PATH).pipe(res);
});

// GET /api/admin/backup/sqlite/info —— 文件大小与行数摘要
router.get('/backup/sqlite/info', (req, res) => {
  if (!fs.existsSync(DB_PATH)) return res.status(404).json({ error: 'db file not found' });
  const stat = fs.statSync(DB_PATH);
  res.json({
    size_mb: (stat.size / 1048576).toFixed(2),
    mtime: stat.mtime,
    row_counts: {
      orders: tableCount('orders'),
      artworks: tableCount('artworks'),
      app_events: tableCount('app_events'),
      order_events: tableCount('order_events')
    }
  });
});

// POST /api/admin/backup/sqlite/restore —— 恢复（谨慎：覆盖生产库）
router.post('/backup/sqlite/restore', upload.single('db'), (req, res) => {
  const uploadedPath = req.file && req.file.path;
  if (!uploadedPath) return res.status(400).json({ error: '未收到文件' });
  try {
    const Database = require('better-sqlite3');
    const testDb = new Database(uploadedPath, { readonly: true });
    testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    testDb.close();

    const ts = Date.now();
    fs.copyFileSync(DB_PATH, `${DB_PATH}.before_restore_${ts}`);
    fs.copyFileSync(uploadedPath, DB_PATH);
    fs.unlinkSync(uploadedPath);
    console.warn(`[backup] RESTORE executed by admin at ${new Date().toISOString()}`);
    res.json({ ok: true, message: '恢复成功，请重启服务使新库生效' });
  } catch (e) {
    try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch (err) {}
    res.status(400).json({ error: `恢复失败: ${e.message}` });
  }
});

module.exports = router;
