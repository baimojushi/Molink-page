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
    id TEXT PRIMARY KEY,                          -- 订单唯一ID（UUID）
    device_uuid TEXT,                             -- 设备唯一标识（用于识别同一设备）
    service_type TEXT NOT NULL,                    -- 服务类型：hang_in_home / recommend_work / recommend_space
    service_type_label TEXT NOT NULL,              -- 服务类型中文名称
    receive_method TEXT NOT NULL,                  -- 接收方式：email
    receive_target TEXT NOT NULL,                  -- 接收目标（邮箱地址）
    extra_service INTEGER DEFAULT 0,              -- 是否启用附加服务（0/1）
    artwork_image TEXT,                            -- 作品图文件名（相对路径）
    space_image TEXT,                              -- 空间图文件名（相对路径）
    status TEXT DEFAULT 'pending',                 -- 状态：pending / processing / delivered
    delivery_token TEXT,                           -- 交付页面唯一令牌
    delivery_images TEXT,                          -- 交付图片JSON数组
    delivery_text TEXT,                            -- 交付文字内容
    created_at TEXT DEFAULT (datetime('now','localtime')),  -- 创建时间
    delivered_at TEXT                              -- 交付时间
  );
`);

// 为已有数据库添加 device_uuid 字段（兼容升级）
try {
  db.exec(`ALTER TABLE orders ADD COLUMN device_uuid TEXT`);
} catch (e) {
  // 字段已存在则忽略
}

// 为 device_uuid 创建索引，加速按设备查询
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_device_uuid ON orders(device_uuid)`);
} catch (e) {
  // 索引已存在则忽略
}

module.exports = db;
