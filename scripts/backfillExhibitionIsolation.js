#!/usr/bin/env node
const db = require('../database');
const { LEGACY_EXHIBITION } = require('../config/exhibitionIsolation');
const { backfillArtworkScanTokens } = require('../services/scanTokens');

function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return Number(row && (row.count ?? row.value) || 0);
}

function upsertLegacyExhibition() {
  db.prepare(`
    INSERT INTO exhibitions (
      id, name, slug, status, venue_name, starts_at, ends_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'live', ?, ?, NULL, datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      slug = excluded.slug,
      status = 'live',
      venue_name = excluded.venue_name,
      starts_at = excluded.starts_at,
      ends_at = NULL,
      updated_at = datetime('now','localtime')
  `).run(
    LEGACY_EXHIBITION.id,
    LEGACY_EXHIBITION.name,
    LEGACY_EXHIBITION.slug,
    LEGACY_EXHIBITION.venue_name,
    LEGACY_EXHIBITION.starts_at
  );
}

function backfill() {
  console.log('[exhibition-isolation] backfill start');
  upsertLegacyExhibition();

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE artworks
      SET exhibition_id = ?
      WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = ''
    `).run(LEGACY_EXHIBITION.id);

    db.exec(`
      UPDATE orders
      SET exhibition_id = (
        SELECT a.exhibition_id FROM artworks a
        WHERE a.id = orders.artwork_id
        LIMIT 1
      )
      WHERE (exhibition_id IS NULL OR TRIM(exhibition_id) = '')
        AND COALESCE(artwork_id, '') <> '';
    `);
    db.prepare(`
      UPDATE orders
      SET exhibition_id = ?
      WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = ''
    `).run(LEGACY_EXHIBITION.id);

    db.exec(`
      UPDATE app_events
      SET exhibition_id = (
        SELECT o.exhibition_id FROM orders o
        WHERE o.id = app_events.order_id
        LIMIT 1
      )
      WHERE (exhibition_id IS NULL OR TRIM(exhibition_id) = '')
        AND COALESCE(order_id, '') <> '';

      UPDATE app_events
      SET exhibition_id = (
        SELECT a.exhibition_id FROM artworks a
        WHERE a.id = app_events.artwork_id
        LIMIT 1
      )
      WHERE (exhibition_id IS NULL OR TRIM(exhibition_id) = '')
        AND COALESCE(artwork_id, '') <> '';
    `);
    db.prepare(`
      UPDATE app_events
      SET exhibition_id = ?
      WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = ''
    `).run(LEGACY_EXHIBITION.id);

    db.exec(`
      UPDATE order_events
      SET exhibition_id = (
        SELECT o.exhibition_id FROM orders o
        WHERE o.id = order_events.order_id
        LIMIT 1
      )
      WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = '';
    `);
    db.prepare(`
      UPDATE order_events
      SET exhibition_id = ?
      WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = ''
    `).run(LEGACY_EXHIBITION.id);
  });
  tx();

  const tokenResult = backfillArtworkScanTokens();
  const summary = {
    legacy_exhibition_id: LEGACY_EXHIBITION.id,
    artworks_null_exhibition: scalar("SELECT COUNT(*) AS count FROM artworks WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = ''"),
    orders_null_exhibition: scalar("SELECT COUNT(*) AS count FROM orders WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = ''"),
    app_events_null_exhibition: scalar("SELECT COUNT(*) AS count FROM app_events WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = ''"),
    order_events_null_exhibition: scalar("SELECT COUNT(*) AS count FROM order_events WHERE exhibition_id IS NULL OR TRIM(exhibition_id) = ''"),
    artwork_count: scalar('SELECT COUNT(*) AS count FROM artworks'),
    artwork_scan_token_count: scalar("SELECT COUNT(*) AS count FROM artworks WHERE scan_token IS NOT NULL AND TRIM(scan_token) <> ''"),
    scan_tokens_created: tokenResult.created,
    duplicate_scan_token_groups: scalar(`
      SELECT COUNT(*) AS count FROM (
        SELECT scan_token FROM artworks
        WHERE scan_token IS NOT NULL AND TRIM(scan_token) <> ''
        GROUP BY scan_token HAVING COUNT(*) > 1
      )
    `),
    duplicate_exhibition_code_groups: scalar(`
      SELECT COUNT(*) AS count FROM (
        SELECT exhibition_id, artwork_code FROM artworks
        GROUP BY exhibition_id, artwork_code HAVING COUNT(*) > 1
      )
    `)
  };
  summary.scan_token_coverage = summary.artwork_count
    ? `${summary.artwork_scan_token_count}/${summary.artwork_count}`
    : '0/0';

  console.log(JSON.stringify(summary, null, 2));
  const failed = [
    summary.artworks_null_exhibition,
    summary.orders_null_exhibition,
    summary.app_events_null_exhibition,
    summary.order_events_null_exhibition,
    summary.duplicate_scan_token_groups,
    summary.duplicate_exhibition_code_groups
  ].some(value => Number(value) > 0);
  if (failed) {
    throw new Error('回填校验未通过，请检查上方汇总');
  }
  console.log('[exhibition-isolation] backfill complete');
}

try {
  backfill();
} catch (error) {
  console.error('[exhibition-isolation] backfill failed:', error);
  process.exitCode = 1;
}
