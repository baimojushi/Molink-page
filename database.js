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

// 兼容升级：为旧数据库逐个添加可能缺失的字段
const 升级字段 = [
  'device_uuid TEXT',
  'email_sent INTEGER DEFAULT 0',
  'viewed_at TEXT',
  'downloaded_at TEXT'
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
