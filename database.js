// database.js —— 数据库初始化与表结构定义
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 使用环境变量配置的持久化根目录，默认为 ./data
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(PERSISTENT_ROOT, 'molink.db');

// 确保目录存在
fs.mkdirSync(PERSISTENT_ROOT, { recursive: true });

const db = new Database(DB_PATH);

// 开启 WAL 模式，提升并发读写性能
db.pragma('journal_mode = WAL');

// ==========================================
// 订单表：存储用户提交的服务请求
// ==========================================
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    device_uuid TEXT,
    service_type TEXT NOT NULL,
    service_type_label TEXT NOT NULL,
    receive_method TEXT NOT NULL,
    receive_target TEXT NOT NULL,
    extra_service INTEGER DEFAULT 0,
    artwork_image TEXT,
    space_image TEXT,
    status TEXT DEFAULT 'pending',                 -- pending / delivered / viewed / downloaded
    delivery_token TEXT,
    delivery_images TEXT,
    delivery_text TEXT,
    email_sent INTEGER DEFAULT 0,                  -- 邮件是否发送成功（0/1）
    created_at TEXT DEFAULT (datetime('now','localtime')),
    delivered_at TEXT,
    viewed_at TEXT,                                -- 用户查收时间
    downloaded_at TEXT                             -- 用户下载时间
  );
`);

// 用户表：存储微信用户信息
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    openid TEXT PRIMARY KEY,
    nickname TEXT,
    avatar TEXT,
    first_seen TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// 兼容升级：为旧数据库逐个添加可能缺失的字段
const 升级字段 = [
  'device_uuid TEXT',
  'email_sent INTEGER DEFAULT 0',
  'viewed_at TEXT',
  'downloaded_at TEXT',
  'openid TEXT',
  'user_nickname TEXT',
  'user_avatar TEXT',
  'artwork_size TEXT',
  'ai_execution_id TEXT',
  'ai_result_url TEXT',
  'artwork_num TEXT',
  'artwork_name TEXT',
  'ai_retry_count INTEGER DEFAULT 0',
  'ai_user_message TEXT',
  'ai_submitted_at TEXT',
  'ai_ready_at TEXT',
  'ai_current_step TEXT',
  'notes TEXT',
  'ai_execution_ids TEXT',
  'ai_result_urls TEXT'
];

for (const col of 升级字段) {
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN ${col}`);
  } catch (e) {
    // 字段已存在则忽略
  }
}

// 为 device_uuid 创建索引，加速按设备查询
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_device_uuid ON orders(device_uuid)`);
} catch (e) {
  // 索引已存在则忽略
}

module.exports = db;
