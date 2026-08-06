#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const tempRoot = process.env.EXHIBITION_SMOKE_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'molink-exhibition-smoke-'));
const dbPath = path.join(tempRoot, 'molink.db');
process.env.DATA_DIR = tempRoot;

function seedLegacyDatabase() {
  fs.mkdirSync(tempRoot, { recursive: true });
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE artworks (
      id TEXT PRIMARY KEY,
      artwork_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      author TEXT NOT NULL,
      length TEXT DEFAULT '',
      trans TEXT DEFAULT '',
      frame_length TEXT DEFAULT '',
      frame_trans TEXT DEFAULT '',
      size_text TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      cover_asset_id TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE artwork_assets (
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
      created_at TEXT
    );
  `);
  legacy.prepare(`
    INSERT INTO artworks (
      id, artwork_code, name, author, length, trans, frame_length, frame_trans,
      size_text, description, status, cover_asset_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'art-legacy', 'AW-2026-0001', 'Legacy Work', 'Legacy Artist', '60 cm', '80 cm', '', '',
    '60 × 80 cm', 'migration fixture', 'published', 'asset-legacy', '2026-04-15 10:00:00', '2026-04-15 10:00:00'
  );
  legacy.prepare(`
    INSERT INTO artwork_assets (
      id, artwork_id, asset_kind, sort_order, r2_key, url, thumb_r2_key, thumb_url,
      original_filename, mime_type, file_size, width, height, thumb_width, thumb_height, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'asset-legacy', 'art-legacy', 'artwork', 1, 'legacy/original.jpg', 'https://example.invalid/original.jpg',
    'legacy/thumb.jpg', 'https://example.invalid/thumb.jpg', 'original.jpg', 'image/jpeg', 1024, 1200, 1600, 360, 480,
    '2026-04-15 10:00:00'
  );
  legacy.close();
}

function indexColumns(db, indexName) {
  return db.prepare(`PRAGMA index_info("${String(indexName).replace(/"/g, '""')}")`).all().map(row => row.name);
}

try {
  seedLegacyDatabase();

  const db = require('../database');
  const { LEGACY_EXHIBITION } = require('../config/exhibitionIsolation');
  const { createExhibition } = require('../services/exhibitions');
  const { ensureArtworkScanToken } = require('../services/scanTokens');
  const {
    findArtworkByScanToken,
    findArtworkByCodeInExhibition,
    generateArtworkCode
  } = require('../services/artworks');

  const artworkColumns = new Set(db.prepare("PRAGMA table_info('artworks')").all().map(row => row.name));
  assert(artworkColumns.has('exhibition_id'), 'artworks.exhibition_id missing');
  assert(artworkColumns.has('scan_token'), 'artworks.scan_token missing');

  const indexRows = db.prepare("PRAGMA index_list('artworks')").all();
  const compound = indexRows.find(row => row.name === 'ux_artworks_exhibition_code');
  const tokenIndex = indexRows.find(row => row.name === 'ux_artworks_scan_token');
  assert(compound && Number(compound.unique) === 1, 'compound unique index missing');
  assert.deepStrictEqual(indexColumns(db, compound.name), ['exhibition_id', 'artwork_code']);
  assert(tokenIndex && Number(tokenIndex.unique) === 1, 'scan token unique index missing');
  const globalCodeUnique = indexRows.some(row => Number(row.unique) === 1 && indexColumns(db, row.name).join(',') === 'artwork_code');
  assert.strictEqual(globalCodeUnique, false, 'legacy global artwork_code unique still exists');

  const migrated = db.prepare('SELECT * FROM artworks WHERE id = ?').get('art-legacy');
  assert.strictEqual(migrated.exhibition_id, LEGACY_EXHIBITION.id, 'legacy artwork was not backfilled to Legacy exhibition');
  const migratedAsset = db.prepare('SELECT * FROM artwork_assets WHERE id = ?').get('asset-legacy');
  assert.strictEqual(migratedAsset.thumb_r2_key, 'legacy/thumb.jpg', 'thumbnail key lost during rebuild');
  assert.strictEqual(migratedAsset.thumb_url, 'https://example.invalid/thumb.jpg', 'thumbnail URL lost during rebuild');
  assert.strictEqual(Number(migratedAsset.thumb_width), 360, 'thumbnail width lost during rebuild');

  const second = createExhibition({ name: 'Smoke Test Exhibition', slug: 'smoke-test', status: 'live' });
  db.prepare(`
    INSERT INTO artworks (
      id, exhibition_id, scan_token, artwork_code, name, author, size_text, status, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'published', datetime('now','localtime'), datetime('now','localtime'))
  `).run('art-second', second.id, 'AW-2026-0001', 'Second Work', 'Second Artist', '50 × 70 cm');

  assert.throws(() => {
    db.prepare(`
      INSERT INTO artworks (
        id, exhibition_id, scan_token, artwork_code, name, author, size_text, status
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'published')
    `).run('art-duplicate', second.id, 'AW-2026-0001', 'Duplicate', 'Artist', '1 × 1 cm');
  }, /UNIQUE/, 'same-exhibition duplicate code was not rejected');

  const legacyToken = ensureArtworkScanToken('art-legacy');
  const secondToken = ensureArtworkScanToken('art-second');
  assert(/^[0-9A-Za-z]{10}$/.test(legacyToken), 'legacy token format invalid');
  assert(/^[0-9A-Za-z]{10}$/.test(secondToken), 'second token format invalid');
  assert.notStrictEqual(legacyToken, secondToken, 'scan tokens collided');

  assert.strictEqual(findArtworkByScanToken(secondToken).id, 'art-second', 'token resolution returned wrong artwork');
  assert.strictEqual(findArtworkByCodeInExhibition('AW-2026-0001', LEGACY_EXHIBITION.id).id, 'art-legacy', 'legacy scoped code resolution failed');
  assert.strictEqual(findArtworkByCodeInExhibition('AW-2026-0001', second.id).id, 'art-second', 'second exhibition scoped code resolution failed');
  assert.strictEqual(generateArtworkCode(LEGACY_EXHIBITION.id), 'AW-2026-0002', 'legacy exhibition code sequence is not isolated');
  assert.strictEqual(generateArtworkCode(second.id), 'AW-2026-0002', 'second exhibition code sequence is not isolated');

  const beforeRestart = db.prepare('SELECT COUNT(*) AS count FROM artworks').get().count;
  db.close();

  const restartOutput = execFileSync(process.execPath, ['-e', `
    process.env.DATA_DIR = ${JSON.stringify(tempRoot)};
    const db = require(${JSON.stringify(path.join(__dirname, '..', 'database.js'))});
    const count = db.prepare('SELECT COUNT(*) AS count FROM artworks').get().count;
    const indexes = db.prepare("PRAGMA index_list('artworks')").all().map(row => row.name);
    if (count !== ${Number(beforeRestart)}) throw new Error('artwork count changed after restart');
    if (!indexes.includes('ux_artworks_exhibition_code') || !indexes.includes('ux_artworks_scan_token')) throw new Error('indexes missing after restart');
    db.close();
    process.stdout.write('restart-ok');
  `], { encoding: 'utf8' });
  assert(restartOutput.includes('restart-ok'), 'restart verification failed');

  console.log(JSON.stringify({
    ok: true,
    temp_data_dir: tempRoot,
    checks: [
      'legacy schema rebuilt once without artwork or thumbnail loss',
      'same code allowed across exhibitions',
      'same code rejected inside one exhibition',
      '10-character base62 scan tokens are unique',
      'token and exhibition-scoped code resolution are deterministic',
      'artwork numbering is isolated by exhibition',
      'second startup keeps rows and indexes stable'
    ]
  }, null, 2));
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
} finally {
  if (!process.env.EXHIBITION_SMOKE_KEEP && !process.env.EXHIBITION_SMOKE_DATA_DIR) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (error) {}
  }
}
