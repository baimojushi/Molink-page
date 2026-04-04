// database.js —— 数据库初始化与表结构定义
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(PERSISTENT_ROOT, 'molink.db');

fs.mkdirSync(PERSISTENT_ROOT, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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
    status TEXT DEFAULT 'pending',
    delivery_token TEXT,
    delivery_images TEXT,
    delivery_text TEXT,
    email_sent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    delivered_at TEXT,
    viewed_at TEXT,
    downloaded_at TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    openid TEXT PRIMARY KEY,
    nickname TEXT,
    avatar TEXT,
    first_seen TEXT DEFAULT (datetime('now','localtime'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    device_uuid TEXT,
    event_type TEXT NOT NULL,
    image_index INTEGER,
    image_url TEXT,
    page_name TEXT,
    stay_ms INTEGER,
    entered_at TEXT,
    left_at TEXT,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

const upgradeFields = [
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
  'ai_result_urls TEXT',
  'ai_dim_fix_count INTEGER DEFAULT 0'
];

for (const column of upgradeFields) {
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN ${column}`);
  } catch (e) {}
}

const orderEventUpgradeFields = [
  'image_index INTEGER',
  'image_url TEXT',
  'page_name TEXT',
  'stay_ms INTEGER',
  'entered_at TEXT',
  'left_at TEXT',
  'payload_json TEXT'
];

for (const column of orderEventUpgradeFields) {
  try {
    db.exec(`ALTER TABLE order_events ADD COLUMN ${column}`);
  } catch (e) {}
}

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_device_uuid ON orders(device_uuid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_events_created_at ON order_events(created_at)`);
} catch (e) {}

module.exports = db;
