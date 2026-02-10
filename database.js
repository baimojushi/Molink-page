// database.js —— 数据库初始化与表结构定义
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 使用环境变量配置的持久化根目录，默认为 ./data
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(PERSISTENT_ROOT, 'snaptoshine.db');

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
    service_type TEXT NOT NULL,                    -- 服务类型：hang_in_home / recommend_work / recommend_space
    service_type_label TEXT NOT NULL,              -- 服务类型中文名称
    receive_method TEXT NOT NULL,                  -- 接收方式：email / sms
    receive_target TEXT NOT NULL,                  -- 接收目标（邮箱地址或手机号）
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

module.exports = db;
