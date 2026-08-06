const path = require('path');
const db = require('../database');
const { DELIVERIES_DIR } = require('../middleware/upload');
const {
  safeJsonArray,
  matchDeliveryRecord,
  uploadDeliveryImageToR2,
  localDeliveryUrl,
  isAbsoluteUrl
} = require('../services/deliveryAssets');

function buildRecord(order, filename, existing = {}, uploaded = null) {
  const localUrl = isAbsoluteUrl(filename) ? filename : `/deliveries/${filename}`;
  return Object.assign({}, existing, {
    filename: existing.filename || (isAbsoluteUrl(filename) ? path.basename(String(filename).split('?')[0]) : filename),
    image_url: uploaded && uploaded.url ? uploaded.url : (existing.image_url || localUrl),
    local_image_url: existing.local_image_url || localUrl,
    r2_key: uploaded && uploaded.key ? uploaded.key : (existing.r2_key || null),
    r2_url: uploaded && uploaded.url ? uploaded.url : (existing.r2_url || null),
    artwork_id: existing.artwork_id || order.artwork_id || null,
    artwork_code: existing.artwork_code || order.artwork_code || null,
    artwork_name: existing.artwork_name || order.artwork_name || order.service_type_label || '',
    artwork_author: existing.artwork_author || ''
  });
}

async function main() {
  const orders = db.prepare(`
    SELECT id, service_type_label, artwork_id, artwork_code, artwork_name, delivery_images, delivery_result_records_json
    FROM orders
    WHERE status IN ('delivered','viewed','downloaded')
      AND COALESCE(delivery_images, '') <> ''
  `).all();

  let uploadedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const order of orders) {
    const images = safeJsonArray(order.delivery_images, []);
    const existingRecords = safeJsonArray(order.delivery_result_records_json, []);
    if (!images.length) continue;

    const nextRecords = [];
    let changed = false;

    for (let index = 0; index < images.length; index++) {
      const filename = images[index];
      const existing = matchDeliveryRecord(existingRecords, filename, index) || {};
      if (existing.r2_url && existing.r2_key) {
        nextRecords.push(buildRecord(order, filename, existing, null));
        skippedCount += 1;
        continue;
      }
      if (isAbsoluteUrl(filename)) {
        nextRecords.push(buildRecord(order, filename, existing, null));
        skippedCount += 1;
        continue;
      }

      const localPath = path.join(DELIVERIES_DIR, filename);
      try {
        const uploaded = await uploadDeliveryImageToR2({ order, filename, localPath, sourceRecord: existing, index });
        if (uploaded && uploaded.url) {
          nextRecords.push(buildRecord(order, filename, existing, uploaded));
          uploadedCount += 1;
          changed = true;
        } else {
          nextRecords.push(buildRecord(order, filename, existing, null));
          skippedCount += 1;
        }
      } catch (error) {
        console.warn(`交付图上传失败 ${order.id} / ${filename}:`, error.message || error);
        nextRecords.push(buildRecord(order, filename, existing, null));
        failedCount += 1;
      }
    }

    if (changed || nextRecords.length !== existingRecords.length) {
      db.prepare('UPDATE orders SET delivery_result_records_json = ? WHERE id = ?')
        .run(JSON.stringify(nextRecords), order.id);
    }
  }

  console.log(`R2 交付图回填完成：上传 ${uploadedCount}，跳过 ${skippedCount}，失败 ${failedCount}`);
}

main().catch(error => {
  console.error('R2 交付图回填失败:', error);
  process.exit(1);
});
