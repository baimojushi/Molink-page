require('dotenv').config();
const db = require('../database');
const { ensureAssetThumbnail } = require('../services/artworks');

const rawArgs = process.argv.slice(2);
const argMap = new Map();
for (const item of rawArgs) {
  const [key, value = ''] = item.replace(/^--/, '').split('=');
  argMap.set(key, value || '1');
}

const limit = Math.max(1, Math.min(Number(argMap.get('limit')) || 5000, 50000));
const dryRun = argMap.has('dry-run');
const onlyArtworkId = String(argMap.get('artwork-id') || '').trim();
const startAfterId = String(argMap.get('start-after-id') || '').trim();

function listTargets() {
  const clauses = ["asset_kind IN ('artwork','frame','effect')", "COALESCE(url,'') <> ''", "COALESCE(thumb_url,'') = ''"];
  const params = [];
  if (onlyArtworkId) {
    clauses.push('artwork_id = ?');
    params.push(onlyArtworkId);
  }
  if (startAfterId) {
    clauses.push('id > ?');
    params.push(startAfterId);
  }
  return db.prepare(`
    SELECT aa.*, a.artwork_code
    FROM artwork_assets aa
    JOIN artworks a ON a.id = aa.artwork_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY aa.created_at ASC, aa.id ASC
    LIMIT ?
  `).all(...params, limit);
}

(async () => {
  const targets = listTargets();
  const stats = { total: targets.length, success: 0, failed: 0, skipped: 0 };
  console.log(`[thumb-backfill] targets=${targets.length} dryRun=${dryRun}`);
  for (const asset of targets) {
    const label = `${asset.artwork_code || asset.artwork_id}:${asset.asset_kind}:${asset.id}`;
    try {
      if (dryRun) {
        stats.skipped += 1;
        console.log(`[dry-run] ${label}`);
        continue;
      }
      const result = await ensureAssetThumbnail(asset, asset.artwork_code);
      if (result && result.url) {
        stats.success += 1;
        console.log(`[ok] ${label} -> ${result.url}`);
      } else {
        stats.skipped += 1;
        console.log(`[skip] ${label} no-thumb-generated`);
      }
    } catch (error) {
      stats.failed += 1;
      console.error(`[fail] ${label} ${error.message || error}`);
    }
  }
  console.log('[thumb-backfill] done', JSON.stringify(stats));
  if (stats.failed > 0) process.exitCode = 1;
})().catch(error => {
  console.error('[thumb-backfill] fatal', error);
  process.exit(1);
});
