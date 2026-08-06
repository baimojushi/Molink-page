const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { LEGACY_EXHIBITION } = require('./config/exhibitionIsolation');

const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(PERSISTENT_ROOT, 'molink.db');

fs.mkdirSync(PERSISTENT_ROOT, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableExists(name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

function getTableInfo(name) {
  if (!tableExists(name)) return [];
  return db.prepare(`PRAGMA table_info(${name})`).all();
}

function hasColumn(tableName, columnName) {
  return getTableInfo(tableName).some(col => col.name === columnName);
}

function columnType(tableName, columnName) {
  const col = getTableInfo(tableName).find(item => item.name === columnName);
  return col ? String(col.type || '').toUpperCase() : '';
}

function getIndexList(tableName) {
  if (!tableExists(tableName)) return [];
  return db.prepare(`PRAGMA index_list(${tableName})`).all();
}

function getIndexColumns(indexName) {
  if (!indexName) return [];
  return db.prepare(`PRAGMA index_info(${JSON.stringify(String(indexName))})`).all().map(row => row.name);
}

function hasNamedIndex(tableName, indexName) {
  return getIndexList(tableName).some(index => index.name === indexName);
}

function quoteIdentifier(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function dropNamedIndexesForTable(tableName) {
  for (const index of getIndexList(tableName)) {
    const name = String(index.name || '');
    if (!name || name.startsWith('sqlite_autoindex_')) continue;
    db.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`);
  }
}

function hasLegacyArtworkCodeUniqueIndex() {
  return getIndexList('artworks').some(index => {
    if (!Number(index.unique)) return false;
    const columns = getIndexColumns(index.name);
    return columns.length === 1 && columns[0] === 'artwork_code';
  });
}

function nowSuffix() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function newUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const hex = crypto.randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createExhibitionsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exhibitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'draft',
      venue_name TEXT,
      geo_lat REAL,
      geo_lng REAL,
      geo_radius_m INTEGER DEFAULT 400,
      starts_at TEXT,
      ends_at TEXT,
      cover_url TEXT,
      collection_advisor_name TEXT,
      collection_advisor_wechat TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS ix_exhibitions_status ON exhibitions(status);
  `);
}

function ensureLegacyExhibition() {
  createExhibitionsTable();
  db.prepare(`
    INSERT INTO exhibitions (
      id, name, slug, status, venue_name, starts_at, ends_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      slug = COALESCE(exhibitions.slug, excluded.slug),
      venue_name = COALESCE(exhibitions.venue_name, excluded.venue_name),
      starts_at = COALESCE(exhibitions.starts_at, excluded.starts_at),
      updated_at = datetime('now','localtime')
  `).run(
    LEGACY_EXHIBITION.id,
    LEGACY_EXHIBITION.name,
    LEGACY_EXHIBITION.slug,
    LEGACY_EXHIBITION.status,
    LEGACY_EXHIBITION.venue_name,
    LEGACY_EXHIBITION.starts_at
  );
}

function createCanonicalArtworkTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artworks (
      id TEXT PRIMARY KEY,
      exhibition_id TEXT NOT NULL,
      scan_token TEXT,
      artwork_code TEXT NOT NULL,
      name TEXT NOT NULL,
      author TEXT NOT NULL,
      price TEXT DEFAULT '',
      length TEXT DEFAULT '',
      trans TEXT DEFAULT '',
      frame_length TEXT DEFAULT '',
      frame_trans TEXT DEFAULT '',
      size_text TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      cover_asset_id TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_artworks_exhibition_code
      ON artworks(exhibition_id, artwork_code);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_artworks_scan_token
      ON artworks(scan_token) WHERE scan_token IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_artworks_exhibition_status
      ON artworks(exhibition_id, status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS artwork_assets (
      id TEXT PRIMARY KEY,
      artwork_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 1,
      r2_key TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      thumb_r2_key TEXT,
      thumb_url TEXT,
      original_filename TEXT,
      mime_type TEXT,
      file_size INTEGER,
      width INTEGER,
      height INTEGER,
      thumb_width INTEGER,
      thumb_height INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (artwork_id) REFERENCES artworks(id) ON DELETE CASCADE
    );
  `);
}

function artworksSchemaLooksCanonical() {
  if (!tableExists('artworks')) return false;
  const idType = columnType('artworks', 'id');
  const codeType = columnType('artworks', 'artwork_code');
  const sizeType = columnType('artworks', 'size_text');
  return idType === 'TEXT'
    && codeType === 'TEXT'
    && sizeType === 'TEXT'
    && hasColumn('artworks', 'exhibition_id')
    && hasColumn('artworks', 'scan_token')
    && hasColumn('artworks', 'length')
    && hasColumn('artworks', 'trans')
    && hasColumn('artworks', 'frame_length')
    && hasColumn('artworks', 'frame_trans')
    && hasNamedIndex('artworks', 'ux_artworks_exhibition_code')
    && hasNamedIndex('artworks', 'ux_artworks_scan_token')
    && !hasLegacyArtworkCodeUniqueIndex();
}

function artworkAssetsSchemaLooksCanonical() {
  if (!tableExists('artwork_assets')) return false;
  const idType = columnType('artwork_assets', 'id');
  const artworkIdType = columnType('artwork_assets', 'artwork_id');
  const r2KeyType = columnType('artwork_assets', 'r2_key');
  return idType === 'TEXT' && artworkIdType === 'TEXT' && r2KeyType === 'TEXT';
}

function rebuildArtworkTablesIfNeeded() {
  const needsArtworksRebuild = tableExists('artworks') && !artworksSchemaLooksCanonical();
  const needsAssetsRebuild = tableExists('artwork_assets') && !artworkAssetsSchemaLooksCanonical();
  if (!needsArtworksRebuild && !needsAssetsRebuild) {
    createCanonicalArtworkTables();
    return;
  }

  const suffix = nowSuffix();
  db.exec('BEGIN');
  try {
    if (tableExists('artwork_assets')) {
      db.exec(`ALTER TABLE artwork_assets RENAME TO artwork_assets_legacy_${suffix}`);
    }
    if (tableExists('artworks')) {
      db.exec(`ALTER TABLE artworks RENAME TO artworks_legacy_${suffix}`);
    }

    if (tableExists(`artwork_assets_legacy_${suffix}`)) dropNamedIndexesForTable(`artwork_assets_legacy_${suffix}`);
    if (tableExists(`artworks_legacy_${suffix}`)) dropNamedIndexesForTable(`artworks_legacy_${suffix}`);

    createCanonicalArtworkTables();

    if (tableExists(`artworks_legacy_${suffix}`)) {
      const oldArtworkCols = new Set(getTableInfo(`artworks_legacy_${suffix}`).map(col => col.name));
      const selectId = oldArtworkCols.has('id') ? `CAST(id AS TEXT)` : `lower(hex(randomblob(16)))`;
      const selectCode = oldArtworkCols.has('artwork_code')
        ? `CAST(artwork_code AS TEXT)`
        : oldArtworkCols.has('code')
          ? `CAST(code AS TEXT)`
          : `''`;
      const selectExhibitionId = oldArtworkCols.has('exhibition_id')
        ? `COALESCE(NULLIF(TRIM(CAST(exhibition_id AS TEXT)), ''), '${LEGACY_EXHIBITION.id}')`
        : `'${LEGACY_EXHIBITION.id}'`;
      const selectScanToken = oldArtworkCols.has('scan_token') ? `NULLIF(TRIM(CAST(scan_token AS TEXT)), '')` : `NULL`;
      const selectName = oldArtworkCols.has('name') ? `CAST(name AS TEXT)` : `''`;
      const selectAuthor = oldArtworkCols.has('author') ? `CAST(author AS TEXT)` : `''`;
      const selectPrice = oldArtworkCols.has('price') ? `CAST(price AS TEXT)` : `''`;
      const selectLength = oldArtworkCols.has('length') ? `CAST(length AS TEXT)` : `''`;
      const selectTrans = oldArtworkCols.has('trans') ? `CAST(trans AS TEXT)` : `''`;
      const selectFrameLength = oldArtworkCols.has('frame_length') ? `CAST(frame_length AS TEXT)` : `''`;
      const selectFrameTrans = oldArtworkCols.has('frame_trans') ? `CAST(frame_trans AS TEXT)` : `''`;
      const selectSize = oldArtworkCols.has('size_text')
        ? `CAST(size_text AS TEXT)`
        : oldArtworkCols.has('size')
          ? `CAST(size AS TEXT)`
          : `''`;
      const selectDescription = oldArtworkCols.has('description') ? `CAST(description AS TEXT)` : `''`;
      const selectStatus = oldArtworkCols.has('status') ? `CAST(status AS TEXT)` : `'published'`;
      const selectCover = oldArtworkCols.has('cover_asset_id') ? `CAST(cover_asset_id AS TEXT)` : `NULL`;
      const selectCreated = oldArtworkCols.has('created_at') ? `CAST(created_at AS TEXT)` : `datetime('now','localtime')`;
      const selectUpdated = oldArtworkCols.has('updated_at') ? `CAST(updated_at AS TEXT)` : `datetime('now','localtime')`;

      db.exec(`
        INSERT INTO artworks (id, exhibition_id, scan_token, artwork_code, name, author, price, length, trans, frame_length, frame_trans, size_text, description, status, cover_asset_id, created_at, updated_at)
        SELECT
          CASE WHEN TRIM(COALESCE(${selectId}, '')) = '' THEN lower(hex(randomblob(16))) ELSE ${selectId} END,
          ${selectExhibitionId},
          ${selectScanToken},
          CASE WHEN TRIM(COALESCE(${selectCode}, '')) = '' THEN 'LEGACY-' || printf('%06d', rowid) ELSE ${selectCode} END,
          COALESCE(${selectName}, ''),
          COALESCE(${selectAuthor}, ''),
          COALESCE(${selectPrice}, ''),
          COALESCE(${selectLength}, ''),
          COALESCE(${selectTrans}, ''),
          COALESCE(${selectFrameLength}, ''),
          COALESCE(${selectFrameTrans}, ''),
          COALESCE(${selectSize}, ''),
          ${selectDescription},
          CASE WHEN TRIM(COALESCE(${selectStatus}, '')) = '' THEN 'published' ELSE ${selectStatus} END,
          ${selectCover},
          ${selectCreated},
          ${selectUpdated}
        FROM artworks_legacy_${suffix}
      `);
    }

    if (tableExists(`artwork_assets_legacy_${suffix}`)) {
      const oldAssetCols = new Set(getTableInfo(`artwork_assets_legacy_${suffix}`).map(col => col.name));
      const artworkRows = db.prepare('SELECT id, artwork_code FROM artworks').all();
      const artworkIdSet = new Set(artworkRows.map(row => String(row.id)));
      const artworkCodeToId = new Map(artworkRows.map(row => [String(row.artwork_code), String(row.id)]));
      const oldAssets = db.prepare(`SELECT * FROM artwork_assets_legacy_${suffix}`).all();
      const insert = db.prepare(`
        INSERT INTO artwork_assets (
          id, artwork_id, asset_kind, sort_order, r2_key, url,
          thumb_r2_key, thumb_url, original_filename, mime_type, file_size, width, height,
          thumb_width, thumb_height, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const asset of oldAssets) {
        const rawArtworkId = oldAssetCols.has('artwork_id') ? asset.artwork_id : null;
        const resolvedArtworkId = rawArtworkId && artworkIdSet.has(String(rawArtworkId))
          ? String(rawArtworkId)
          : (rawArtworkId && artworkCodeToId.get(String(rawArtworkId))) || null;
        if (!resolvedArtworkId) continue;
        const assetId = asset.id ? String(asset.id) : newUuid();
        const rawKind = String(asset.asset_kind || asset.kind || 'artwork');
        const assetKind = rawKind === 'effect' ? 'effect' : (rawKind === 'frame' ? 'frame' : rawKind === 'miniapp_qr' ? 'miniapp_qr' : 'artwork');
        const sortOrder = Number.isFinite(Number(asset.sort_order)) ? Number(asset.sort_order) : 1;
        const r2Key = String(asset.r2_key || asset.key || `legacy/${assetId}`);
        const url = String(asset.url || '');
        if (!url) continue;
        insert.run(
          assetId,
          resolvedArtworkId,
          assetKind,
          sortOrder,
          r2Key,
          url,
          oldAssetCols.has('thumb_r2_key') && asset.thumb_r2_key ? String(asset.thumb_r2_key) : null,
          oldAssetCols.has('thumb_url') && asset.thumb_url ? String(asset.thumb_url) : null,
          asset.original_filename ? String(asset.original_filename) : null,
          asset.mime_type ? String(asset.mime_type) : null,
          asset.file_size != null ? Number(asset.file_size) : null,
          asset.width != null ? Number(asset.width) : null,
          asset.height != null ? Number(asset.height) : null,
          oldAssetCols.has('thumb_width') && asset.thumb_width != null ? Number(asset.thumb_width) : null,
          oldAssetCols.has('thumb_height') && asset.thumb_height != null ? Number(asset.thumb_height) : null,
          asset.created_at ? String(asset.created_at) : new Date().toISOString()
        );
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

ensureLegacyExhibition();

const exhibitionUpgradeFields = [
  'collection_advisor_name TEXT',
  'collection_advisor_wechat TEXT'
];
for (const column of exhibitionUpgradeFields) {
  try {
    db.exec(`ALTER TABLE exhibitions ADD COLUMN ${column}`);
  } catch (error) {}
}

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    exhibition_id TEXT,
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
  CREATE TABLE IF NOT EXISTS user_devices (
    openid TEXT NOT NULL,
    device_uuid TEXT NOT NULL,
    first_seen TEXT DEFAULT (datetime('now','localtime')),
    last_seen TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (openid, device_uuid)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exhibition_id TEXT,
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


db.exec(`
  CREATE TABLE IF NOT EXISTS app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exhibition_id TEXT,
    session_id TEXT,
    device_uuid TEXT,
    openid TEXT,
    order_id TEXT,
    event_name TEXT NOT NULL,
    page_name TEXT,
    platform TEXT,
    service_type TEXT,
    entry_source TEXT,
    artwork_id TEXT,
    artwork_code TEXT,
    props_json TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS worker_connections (
    instance_id TEXT PRIMARY KEY,
    gpu_model TEXT,
    status TEXT DEFAULT 'disconnected',
    current_job_id TEXT,
    last_heartbeat TEXT,
    registered_at TEXT
  );
`);

const orderUpgradeFields = [
  'exhibition_id TEXT',
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
  'ai_advisor_progress TEXT',
  'ai_progress_pct INTEGER',
  'notes TEXT',
  'ai_execution_ids TEXT',
  'ai_result_urls TEXT',
  'ai_dim_fix_count INTEGER DEFAULT 0',
  'subscribe_completion INTEGER DEFAULT 0',
  'subscribe_template_id TEXT',
  'artwork_id TEXT',
  'artwork_code TEXT',
  'entry_platform TEXT',
  'entry_source TEXT',
  'entry_scene TEXT',
  'admin_approve_count INTEGER DEFAULT 0',
  'admin_regenerate_count INTEGER DEFAULT 0',
  'ai_initial_image_count INTEGER DEFAULT 0',
  'ai_first_ready_count INTEGER DEFAULT 0',
  'ai_total_ready_count INTEGER DEFAULT 0',
  'delivery_method TEXT',
  'admin_approved_at TEXT',
  'admin_approved_by TEXT',
  'artwork_selection_method TEXT',
  'recommended_artworks_json TEXT',
  'ai_generation_plan_json TEXT',
  'ai_result_records_json TEXT',
  'ai_iteration_records_json TEXT',
  'delivery_result_records_json TEXT',
  // —— 挂画引擎（hanging）接入新增列 ——
  "ai_engine TEXT DEFAULT 'mmw'",          // mmw | hanging
  'artwork_author TEXT',
  'hanging_job_id TEXT',
  'hanging_status TEXT',                     // 镜像 worker 终态
  'hanging_exit_code TEXT',
  'hanging_failure_context_json TEXT',       // 面向客户端的结构化失败来源与建议
  'hanging_plans_json TEXT',                 // 细化后 candidates 数组（含终图 URL）
  'hanging_not_recommended_json TEXT',
  'hanging_candidate_records_json TEXT',     // 终图+安装+风险+原因 绑定
  'hanging_narration_bundle_json TEXT',     // GPU 因果层输出的最新 NarrationBundle
  'hanging_submitted_at TEXT',
  'hanging_ready_at TEXT',
  'hanging_provider TEXT',                   // apiyi_gpt_image2_vip | bfl | mock | mmw_fallback
  'hanging_result_zip_url TEXT',              // GPU hanging_result.zip 可复用中间产物 URL
  'hanging_result_zip_key TEXT',              // GPU hanging_result.zip R2 key
  "primary_wall_rerender_status TEXT DEFAULT 'idle'", // idle | pending | succeeded | failed
  "primary_wall_rerender_job_id TEXT DEFAULT ''",
  // —— 微信官方内容安全审核 ——
  "content_review_status TEXT DEFAULT 'not_required'", // not_required | checking | passed | rejected | skipped | error
  "content_review_trace_ids_json TEXT DEFAULT '[]'",
  "content_review_result_json TEXT DEFAULT '[]'",
  'content_review_reject_reason TEXT',
  'content_review_rejected_at TEXT',
  'content_review_completed_at TEXT'
];

for (const column of orderUpgradeFields) {
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN ${column}`);
  } catch (error) {}
}

const orderEventUpgradeFields = [
  'exhibition_id TEXT',
  'actor_type TEXT',
  'actor_id TEXT',
  'platform TEXT',
  'service_type TEXT',
  'event_result TEXT',
  'artwork_id TEXT',
  'artwork_code TEXT'
];

for (const column of orderEventUpgradeFields) {
  try {
    db.exec(`ALTER TABLE order_events ADD COLUMN ${column}`);
  } catch (error) {}
}

const appEventUpgradeFields = [
  'exhibition_id TEXT'
];
for (const column of appEventUpgradeFields) {
  try {
    db.exec(`ALTER TABLE app_events ADD COLUMN ${column}`);
  } catch (error) {}
}

rebuildArtworkTablesIfNeeded();

db.exec(`
  CREATE INDEX IF NOT EXISTS ix_orders_exhibition_created ON orders(exhibition_id, created_at);
  CREATE INDEX IF NOT EXISTS ix_app_events_exhibition_created ON app_events(exhibition_id, created_at);
  CREATE INDEX IF NOT EXISTS ix_order_events_exhibition_created ON order_events(exhibition_id, created_at);
`);

if (tableExists('artworks')) {
  try {
    if (!hasColumn('artworks', 'description')) db.exec(`ALTER TABLE artworks ADD COLUMN description TEXT`);
    if (!hasColumn('artworks', 'status')) db.exec(`ALTER TABLE artworks ADD COLUMN status TEXT NOT NULL DEFAULT 'published'`);
    if (!hasColumn('artworks', 'cover_asset_id')) db.exec(`ALTER TABLE artworks ADD COLUMN cover_asset_id TEXT`);
    if (!hasColumn('artworks', 'created_at')) db.exec(`ALTER TABLE artworks ADD COLUMN created_at TEXT DEFAULT (datetime('now','localtime'))`);
    if (!hasColumn('artworks', 'updated_at')) db.exec(`ALTER TABLE artworks ADD COLUMN updated_at TEXT DEFAULT (datetime('now','localtime'))`);
    if (!hasColumn('artworks', 'length')) db.exec(`ALTER TABLE artworks ADD COLUMN length TEXT DEFAULT ''`);
    if (!hasColumn('artworks', 'trans')) db.exec(`ALTER TABLE artworks ADD COLUMN trans TEXT DEFAULT ''`);
    if (!hasColumn('artworks', 'frame_length')) db.exec(`ALTER TABLE artworks ADD COLUMN frame_length TEXT DEFAULT ''`);
    if (!hasColumn('artworks', 'frame_trans')) db.exec(`ALTER TABLE artworks ADD COLUMN frame_trans TEXT DEFAULT ''`);
    if (!hasColumn('artworks', 'price')) db.exec(`ALTER TABLE artworks ADD COLUMN price TEXT DEFAULT ''`);
    if (!hasColumn('artworks', 'size_text')) {
      db.exec(`ALTER TABLE artworks ADD COLUMN size_text TEXT NOT NULL DEFAULT ''`);
      if (hasColumn('artworks', 'size')) {
        db.exec(`UPDATE artworks SET size_text = COALESCE(CAST(size AS TEXT), '') WHERE COALESCE(size_text, '') = ''`);
      }
    }
  } catch (error) {}
}

if (tableExists('artwork_assets')) {
  const artworkAssetUpgradeFields = [
    'sort_order INTEGER NOT NULL DEFAULT 1',
    'original_filename TEXT',
    'mime_type TEXT',
    'file_size INTEGER',
    'width INTEGER',
    'height INTEGER',
    'created_at TEXT DEFAULT (datetime(\'now\',\'localtime\'))'
  ];

  for (const column of artworkAssetUpgradeFields) {
    try {
      db.exec(`ALTER TABLE artwork_assets ADD COLUMN ${column}`);
    } catch (error) {}
  }
}


function assertExhibitionIsolationSchema() {
  const errors = [];
  if (!hasColumn('artworks', 'exhibition_id')) errors.push('artworks.exhibition_id missing');
  if (!hasColumn('artworks', 'scan_token')) errors.push('artworks.scan_token missing');
  if (!hasNamedIndex('artworks', 'ux_artworks_exhibition_code')) errors.push('ux_artworks_exhibition_code missing');
  if (!hasNamedIndex('artworks', 'ux_artworks_scan_token')) errors.push('ux_artworks_scan_token missing');
  if (hasLegacyArtworkCodeUniqueIndex()) errors.push('legacy global artwork_code UNIQUE still exists');
  const nullArtworkCount = tableExists('artworks')
    ? Number(db.prepare("SELECT COUNT(*) AS count FROM artworks WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = ''").get().count || 0)
    : 0;
  if (nullArtworkCount > 0) errors.push(`artworks.exhibition_id has ${nullArtworkCount} empty rows; run npm run exhibitions:backfill`);
  if (errors.length) {
    console.warn('[exhibition-isolation] schema self-check warning:', errors.join('; '));
  }
  return { ok: errors.length === 0, errors };
}

assertExhibitionIsolationSchema();

// —— LLM 槽位调试 / 标注 / 偏好数据资产 ——
db.exec(`
  CREATE TABLE IF NOT EXISTS llm_slot_config (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    slot TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'llm_free',
    fixed_seed_text TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    user_prompt_template TEXT DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    gray_ratio REAL NOT NULL DEFAULT 1,
    version_label TEXT DEFAULT '',
    created_by TEXT DEFAULT 'system',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS llm_slot_overrides (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    task TEXT NOT NULL,
    slot TEXT NOT NULL,
    override_text TEXT NOT NULL,
    reason TEXT DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS llm_debug_runs (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    task TEXT NOT NULL,
    slot TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'baseline_production',
    input_fields_json TEXT DEFAULT '{}',
    system_prompt TEXT DEFAULT '',
    user_prompt TEXT DEFAULT '',
    model TEXT DEFAULT '',
    temperature REAL,
    max_tokens INTEGER,
    output_text TEXT DEFAULT '',
    fixed_source_id TEXT,
    latency_ms INTEGER,
    error_text TEXT,
    prompt_version TEXT DEFAULT '',
    created_by TEXT DEFAULT 'system',
    mode TEXT DEFAULT '',
    slot_config_id TEXT,
    gray_ratio REAL,
    gray_bucket REAL,
    gray_applied INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS llm_run_annotations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    annotator_type TEXT NOT NULL DEFAULT 'human',
    annotator TEXT DEFAULT '',
    dimension_scores_json TEXT DEFAULT '{}',
    violation_tags_json TEXT DEFAULT '[]',
    comment TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS llm_preferences (
    id TEXT PRIMARY KEY,
    chosen_run_id TEXT NOT NULL,
    rejected_run_id TEXT NOT NULL,
    task TEXT DEFAULT '',
    slot TEXT DEFAULT '',
    order_id TEXT DEFAULT '',
    prompt_context_json TEXT DEFAULT '{}',
    reason TEXT DEFAULT '',
    created_by TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_wall_preferences (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    chosen_wall_id TEXT DEFAULT '',
    chosen_feature_vector_json TEXT DEFAULT '{}',
    rejected_feature_vectors_json TEXT DEFAULT '[]',
    rank_at_choice INTEGER,
    wallpaper_opt_in INTEGER DEFAULT 0,
    wallpaper_tone_rgb TEXT,
    supplement_request_key TEXT DEFAULT '',
    supplement_job_id TEXT DEFAULT '',
    supplement_status TEXT DEFAULT 'idle',
    supplement_error_code TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

const llmTableUpgradeFields = {
  llm_slot_config: [
    "task TEXT", "slot TEXT", "mode TEXT DEFAULT 'llm_free'", "fixed_seed_text TEXT DEFAULT ''",
    "system_prompt TEXT DEFAULT ''", "user_prompt_template TEXT DEFAULT ''", "is_active INTEGER NOT NULL DEFAULT 1", "gray_ratio REAL NOT NULL DEFAULT 1",
    "version_label TEXT DEFAULT ''", "created_by TEXT DEFAULT 'system'", "created_at TEXT DEFAULT (datetime('now','localtime'))"
  ],
  llm_slot_overrides: [
    "order_id TEXT", "task TEXT", "slot TEXT", "override_text TEXT DEFAULT ''", "reason TEXT DEFAULT ''",
    "is_active INTEGER NOT NULL DEFAULT 1", "created_by TEXT DEFAULT 'admin'", "created_at TEXT DEFAULT (datetime('now','localtime'))"
  ],
  llm_debug_runs: [
    "order_id TEXT", "task TEXT", "slot TEXT", "source TEXT DEFAULT 'baseline_production'", "input_fields_json TEXT DEFAULT '{}'",
    "system_prompt TEXT DEFAULT ''", "user_prompt TEXT DEFAULT ''", "model TEXT DEFAULT ''", "temperature REAL", "max_tokens INTEGER",
    "output_text TEXT DEFAULT ''", "fixed_source_id TEXT", "latency_ms INTEGER", "error_text TEXT",
    "prompt_version TEXT DEFAULT ''", "created_by TEXT DEFAULT 'system'", "mode TEXT DEFAULT ''", "slot_config_id TEXT",
    "gray_ratio REAL", "gray_bucket REAL", "gray_applied INTEGER", "created_at TEXT DEFAULT (datetime('now','localtime'))"
  ],
  llm_run_annotations: [
    "run_id TEXT", "annotator_type TEXT DEFAULT 'human'", "annotator TEXT DEFAULT ''", "dimension_scores_json TEXT DEFAULT '{}'",
    "violation_tags_json TEXT DEFAULT '[]'", "comment TEXT DEFAULT ''", "created_at TEXT DEFAULT (datetime('now','localtime'))"
  ],
  llm_preferences: [
    "chosen_run_id TEXT", "rejected_run_id TEXT", "task TEXT DEFAULT ''", "slot TEXT DEFAULT ''",
    "order_id TEXT DEFAULT ''", "prompt_context_json TEXT DEFAULT '{}'", "reason TEXT DEFAULT ''", "created_by TEXT DEFAULT 'admin'", "created_at TEXT DEFAULT (datetime('now','localtime'))"
  ],
  user_wall_preferences: [
    "order_id TEXT", "chosen_wall_id TEXT DEFAULT ''", "chosen_feature_vector_json TEXT DEFAULT '{}'",
    "rejected_feature_vectors_json TEXT DEFAULT '[]'", "rank_at_choice INTEGER", "wallpaper_opt_in INTEGER DEFAULT 0",
    "wallpaper_tone_rgb TEXT", "supplement_request_key TEXT DEFAULT ''", "supplement_job_id TEXT DEFAULT ''",
    "supplement_status TEXT DEFAULT 'idle'", "supplement_error_code TEXT DEFAULT ''",
    "created_at TEXT DEFAULT (datetime('now','localtime'))"
  ]
};

for (const [tableName, columns] of Object.entries(llmTableUpgradeFields)) {
  for (const column of columns) {
    const columnName = column.trim().split(/\s+/)[0];
    try {
      if (tableExists(tableName) && !hasColumn(tableName, columnName)) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column}`);
      }
    } catch (error) {}
  }
}

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_device_uuid ON orders(device_uuid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_openid ON orders(openid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_artwork_id ON orders(artwork_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_artwork_code ON orders(artwork_code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_devices_openid ON user_devices(openid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_devices_device_uuid ON user_devices(device_uuid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_events_created_at ON order_events(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_events_event_type ON order_events(event_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_events_service_type ON order_events(service_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_events_created_at ON app_events(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_events_event_name ON app_events(event_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_events_service_type ON app_events(service_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_events_artwork_code ON app_events(artwork_code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_events_session_id ON app_events(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_events_order_id ON app_events(order_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artworks_code ON artworks(artwork_code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artworks_status ON artworks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artwork_assets_artwork_id ON artwork_assets(artwork_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artwork_assets_kind_sort ON artwork_assets(artwork_id, asset_kind, sort_order)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artwork_assets_thumb_url ON artwork_assets(thumb_url)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_hanging_job_id ON orders(hanging_job_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_ai_engine ON orders(ai_engine)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_content_review_status ON orders(content_review_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_slot_config_task_slot ON llm_slot_config(task, slot, is_active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_debug_runs_order ON llm_debug_runs(order_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_debug_runs_task_slot ON llm_debug_runs(task, slot, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_run_annotations_run ON llm_run_annotations(run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_preferences_order ON llm_preferences(order_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_wall_preferences_order ON user_wall_preferences(order_id, created_at)`);
} catch (error) {}


// ETA V1: raw events, current runtime, closed-stage observations and snapshots.
// All timestamps use Unix milliseconds so active time does not depend on local timezone.
db.exec(`
  CREATE TABLE IF NOT EXISTS eta_progress_events (
    event_id TEXT PRIMARY KEY,
    protocol_version INTEGER NOT NULL DEFAULT 1,
    job_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    order_id TEXT,
    seq INTEGER NOT NULL,
    pipeline_version TEXT NOT NULL,
    job_kind TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    stage_type TEXT NOT NULL,
    stage_version TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    stage_state TEXT NOT NULL,
    worker_monotonic_ms INTEGER,
    stage_active_elapsed_ms INTEGER,
    work_done REAL,
    work_total REAL,
    work_unit TEXT,
    progress_quality REAL,
    resource_json TEXT,
    input_features_json TEXT,
    metadata_json TEXT,
    received_at_ms INTEGER NOT NULL,
    UNIQUE(job_id, run_id, seq)
  );

  CREATE TABLE IF NOT EXISTS eta_job_runtime (
    job_id TEXT PRIMARY KEY,
    order_id TEXT,
    run_id TEXT NOT NULL,
    protocol_version INTEGER NOT NULL DEFAULT 1,
    last_seq INTEGER NOT NULL DEFAULT 0,
    pipeline_version TEXT NOT NULL,
    job_kind TEXT NOT NULL,
    runtime_state TEXT NOT NULL,
    current_stage_id TEXT,
    current_stage_type TEXT,
    current_stage_version TEXT,
    current_attempt INTEGER NOT NULL DEFAULT 1,
    current_stage_started_at_ms INTEGER,
    current_stage_active_elapsed_ms INTEGER NOT NULL DEFAULT 0,
    active_elapsed_ms INTEGER NOT NULL DEFAULT 0,
    paused_at_ms INTEGER,
    last_event_at_ms INTEGER NOT NULL,
    last_worker_heartbeat_at_ms INTEGER,
    resource_json TEXT,
    input_features_json TEXT,
    manifest_patch_json TEXT,
    pause_capability TEXT DEFAULT 'boundary_only',
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eta_stage_observations (
    observation_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    order_id TEXT,
    pipeline_version TEXT NOT NULL,
    job_kind TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    stage_type TEXT NOT NULL,
    stage_version TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    censored INTEGER NOT NULL DEFAULT 0,
    active_duration_ms INTEGER NOT NULL,
    wall_duration_ms INTEGER,
    resource_signature TEXT,
    resource_json TEXT,
    input_bucket TEXT,
    input_features_json TEXT,
    provider TEXT,
    retry_reason TEXT,
    started_at_ms INTEGER,
    ended_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(job_id, run_id, stage_id, attempt)
  );

  CREATE TABLE IF NOT EXISTS eta_snapshots (
    job_id TEXT PRIMARY KEY,
    order_id TEXT,
    source_seq INTEGER NOT NULL,
    estimate_state TEXT NOT NULL,
    active_p50_ms INTEGER,
    active_p90_ms INTEGER,
    wall_p50_ms INTEGER,
    wall_p90_ms INTEGER,
    queue_p50_ms INTEGER,
    queue_p90_ms INTEGER,
    confidence TEXT NOT NULL,
    reason_codes_json TEXT,
    components_json TEXT,
    calculated_at_ms INTEGER NOT NULL,
    valid_until_ms INTEGER NOT NULL,
    model_version TEXT NOT NULL,
    pipeline_version TEXT NOT NULL,
    estimator_trace_json TEXT,
    stage_id TEXT,
    stage_type TEXT,
    pause_capability TEXT DEFAULT 'boundary_only'
  );

  CREATE TABLE IF NOT EXISTS eta_snapshot_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    source_seq INTEGER NOT NULL,
    active_p50_ms INTEGER,
    active_p90_ms INTEGER,
    calculated_at_ms INTEGER NOT NULL,
    model_version TEXT NOT NULL,
    actual_remaining_ms INTEGER,
    settled_at_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS eta_model_artifacts (
    model_key TEXT NOT NULL,
    artifact_kind TEXT NOT NULL,
    model_version TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    trained_from_ms INTEGER,
    trained_to_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(model_key, artifact_kind, model_version)
  );

  CREATE INDEX IF NOT EXISTS idx_eta_events_job_received
    ON eta_progress_events(job_id, received_at_ms);
  CREATE INDEX IF NOT EXISTS idx_eta_events_stage
    ON eta_progress_events(stage_type, stage_version, received_at_ms);
  CREATE INDEX IF NOT EXISTS idx_eta_observations_cohort
    ON eta_stage_observations(stage_type, stage_version, job_kind, resource_signature, input_bucket, provider);
  CREATE INDEX IF NOT EXISTS idx_eta_snapshot_history_job
    ON eta_snapshot_history(job_id, calculated_at_ms);
`);

// Automated evaluation Phase 0/1. Dataset versions are immutable after freeze;
// image bytes and result payloads live in R2, while SQLite only keeps control
// plane metadata and human review scores.
db.exec(`
  CREATE TABLE IF NOT EXISTS eval_datasets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    rights_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS eval_dataset_versions (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    digest TEXT NOT NULL,
    manifest_key TEXT NOT NULL,
    item_count INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'frozen',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    frozen_at TEXT,
    FOREIGN KEY (dataset_id) REFERENCES eval_datasets(id),
    UNIQUE(dataset_id, version_number),
    UNIQUE(dataset_id, digest)
  );

  CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    dataset_version_id TEXT NOT NULL,
    baseline_run_id TEXT,
    run_spec_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued',
    total_count INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    summary_key TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (dataset_version_id) REFERENCES eval_dataset_versions(id)
  );

  CREATE TABLE IF NOT EXISTS eval_run_shards (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    shard_index INTEGER NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    manifest_key TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    result_prefix TEXT NOT NULL,
    result_key TEXT,
    state TEXT NOT NULL DEFAULT 'queued',
    attempt INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES eval_runs(id),
    UNIQUE(run_id, shard_index)
  );

  CREATE TABLE IF NOT EXISTS eval_item_scores (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    effect_score REAL,
    geometry_score REAL,
    aesthetic_score REAL,
    robustness_score REAL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (run_id) REFERENCES eval_runs(id),
    UNIQUE(run_id, item_id, reviewer)
  );

  CREATE INDEX IF NOT EXISTS idx_eval_versions_dataset ON eval_dataset_versions(dataset_id, version_number);
  CREATE INDEX IF NOT EXISTS idx_eval_runs_state ON eval_runs(state, created_at);
  CREATE INDEX IF NOT EXISTS idx_eval_shards_run_state ON eval_run_shards(run_id, state, shard_index);
  CREATE INDEX IF NOT EXISTS idx_eval_scores_run_item ON eval_item_scores(run_id, item_id);
`);

module.exports = db;
