const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digestOf(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function cleanItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`items[${index}] must be an object`);
  }
  const id = String(item.id || item.item_id || `item-${String(index + 1).padStart(5, '0')}`).trim();
  const roomImageUrl = String(item.room_image_url || '').trim();
  const artworkImageUrl = String(item.artwork_image_url || '').trim();
  if (!id) throw new Error(`items[${index}].id is required`);
  if (!roomImageUrl) throw new Error(`items[${index}].room_image_url is required`);
  if (!artworkImageUrl) throw new Error(`items[${index}].artwork_image_url is required`);
  const artwork = item.artwork && typeof item.artwork === 'object' ? item.artwork : {};
  const width = Number(artwork.physical_width_m);
  const height = Number(artwork.physical_height_m);
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`items[${index}].artwork physical_width_m/physical_height_m must be positive`);
  }
  return {
    ...item,
    id,
    room_image_url: roomImageUrl,
    artwork_image_url: artworkImageUrl,
    artwork: {
      ...artwork,
      physical_width_m: width,
      physical_height_m: height,
      has_frame: artwork.has_frame !== false
    }
  };
}

class EvalDatasetService {
  constructor({ db, r2 }) {
    this.db = db;
    this.r2 = r2;
  }

  async freeze({ datasetId, name, description = '', rights = {}, metadata = {}, items, actor = 'admin' }) {
    const datasetName = String(name || '').trim();
    if (!datasetName && !datasetId) throw new Error('dataset name is required');
    if (!Array.isArray(items) || !items.length) throw new Error('items must be a non-empty array');
    const normalizedItems = items.map(cleanItem);
    const ids = new Set();
    for (const item of normalizedItems) {
      if (ids.has(item.id)) throw new Error(`duplicate item id: ${item.id}`);
      ids.add(item.id);
    }

    const resolvedDatasetId = String(datasetId || uuidv4());
    const digestInput = { schema_version: 1, items: normalizedItems, metadata };
    const digest = digestOf(digestInput);
    const existing = this.db.prepare(
      'SELECT * FROM eval_dataset_versions WHERE dataset_id = ? AND digest = ?'
    ).get(resolvedDatasetId, digest);
    if (existing) return existing;

    const version = Number(this.db.prepare(
      'SELECT COALESCE(MAX(version_number), 0) AS value FROM eval_dataset_versions WHERE dataset_id = ?'
    ).get(resolvedDatasetId)?.value || 0) + 1;
    const versionId = uuidv4();
    const manifestKey = `eval/datasets/${resolvedDatasetId}/v${version}-${digest.slice(0, 12)}/manifest.json`;
    const manifest = {
      schema_version: 1,
      dataset_id: resolvedDatasetId,
      dataset_version_id: versionId,
      version,
      digest,
      item_count: normalizedItems.length,
      metadata,
      items: normalizedItems
    };
    await this.r2.uploadBuffer({
      key: manifestKey,
      body: Buffer.from(JSON.stringify(manifest)),
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store, max-age=0'
    });

    const insert = this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO eval_datasets
        (id, name, description, rights_json, created_by) VALUES (?, ?, ?, ?, ?)`
      ).run(resolvedDatasetId, datasetName || resolvedDatasetId, String(description || ''), JSON.stringify(rights || {}), actor);
      this.db.prepare(`INSERT INTO eval_dataset_versions
        (id, dataset_id, version_number, digest, manifest_key, item_count, state, metadata_json, frozen_at)
        VALUES (?, ?, ?, ?, ?, ?, 'frozen', ?, datetime('now','localtime'))`
      ).run(versionId, resolvedDatasetId, version, digest, manifestKey, normalizedItems.length, JSON.stringify(metadata || {}));
    });
    insert();
    return this.getVersion(versionId);
  }

  getVersion(id) {
    return this.db.prepare(`SELECT v.*, d.name AS dataset_name, d.description
      FROM eval_dataset_versions v JOIN eval_datasets d ON d.id = v.dataset_id WHERE v.id = ?`).get(id);
  }

  list() {
    return this.db.prepare(`SELECT d.*, COUNT(v.id) AS version_count, MAX(v.version_number) AS latest_version
      FROM eval_datasets d LEFT JOIN eval_dataset_versions v ON v.dataset_id = d.id
      GROUP BY d.id ORDER BY d.created_at DESC`).all();
  }
}

module.exports = { EvalDatasetService, canonicalize, digestOf, cleanItem };
