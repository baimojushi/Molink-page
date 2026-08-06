'use strict';

function safeParse(value, fallback = []) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function finalUrl(record = {}) {
  return record.final_image_url || record.image_url || record.r2_url || record.permanent_url || null;
}

function isSuccessfulPrimaryStyling(item = {}) {
  return item.styling_status === 'succeeded';
}

function sameCandidate(left = {}, right = {}) {
  const leftWall = String(left.wall_id || '');
  const rightWall = String(right.wall_id || '');
  if (leftWall && rightWall) return leftWall === rightWall;
  const leftCandidate = String(left.candidate_id || left.asset_id || '');
  const rightCandidate = String(right.candidate_id || right.asset_id || '');
  return Boolean(leftCandidate && rightCandidate && leftCandidate === rightCandidate);
}

function normalizedMergedRecord(existing = {}, incoming = {}) {
  const url = finalUrl(incoming);
  return Object.assign({}, existing, incoming, {
    final_image_url: url,
    image_url: url,
    r2_url: url,
    permanent_url: url,
    rank: existing.rank || incoming.rank || null,
    pre_styling_image_url: existing.pre_styling_image_url || incoming.pre_styling_image_url
  });
}

function mergeSupplementResult(order, incomingRecords, primaryWallId, isPrimaryWallRerender) {
  const existing = safeParse(order && order.delivery_result_records_json, []).map(item => Object.assign({}, item));
  const incoming = Array.isArray(incomingRecords) ? incomingRecords : [];
  const primary = String(primaryWallId || '');

  incoming.forEach(item => {
    const url = finalUrl(item);
    if (!url) return;
    const wallId = String(item.wall_id || '');
    if (isPrimaryWallRerender && wallId === primary && !isSuccessfulPrimaryStyling(item)) return;
    const index = existing.findIndex(record => sameCandidate(record, item));
    if (index >= 0) {
      existing[index] = normalizedMergedRecord(existing[index], item);
    } else if (!isPrimaryWallRerender) {
      existing.push(normalizedMergedRecord({ rank: existing.length + 1 }, item));
    }
  });
  return existing;
}

function mergeCandidateRecords(order, incomingRecords) {
  const existing = safeParse(order && order.hanging_candidate_records_json, []).map(item => Object.assign({}, item));
  const incoming = Array.isArray(incomingRecords) ? incomingRecords : [];
  incoming.forEach(item => {
    if (!finalUrl(item)) return;
    const index = existing.findIndex(record => sameCandidate(record, item));
    if (index >= 0) existing[index] = normalizedMergedRecord(existing[index], item);
    else existing.push(normalizedMergedRecord({ rank: existing.length + 1 }, item));
  });
  return existing;
}

function mergeDeliveryImages(order, incomingRecords, primaryWallId, isPrimaryWallRerender) {
  const images = safeParse(order && order.delivery_images, []).slice();
  const existingRecords = safeParse(order && order.delivery_result_records_json, []);
  const primary = String(primaryWallId || '');
  const incoming = Array.isArray(incomingRecords) ? incomingRecords : [];

  incoming.forEach(item => {
    const url = finalUrl(item);
    if (!url) return;
    const wallId = String(item.wall_id || '');
    if (isPrimaryWallRerender && wallId === primary) {
      if (!isSuccessfulPrimaryStyling(item)) return;
      const oldRecord = existingRecords.find(record => sameCandidate(record, item));
      const oldUrl = finalUrl(oldRecord || {});
      let index = oldUrl ? images.findIndex(image => String(image) === String(oldUrl)) : -1;
      if (index < 0 && images.length) index = 0;
      if (index >= 0) images[index] = url;
      else images.push(url);
      return;
    }
    if (!images.some(image => String(image) === String(url))) images.push(url);
  });
  return images;
}

function buildSupplementDeliveryUpdate(order, incomingRecords, primaryWallId, isPrimaryWallRerender) {
  const deliveryRecords = mergeSupplementResult(order, incomingRecords, primaryWallId, isPrimaryWallRerender);
  const candidateRecords = mergeCandidateRecords(order, incomingRecords);
  const deliveryImages = mergeDeliveryImages(order, incomingRecords, primaryWallId, isPrimaryWallRerender);
  return {
    deliveryRecords,
    candidateRecords,
    deliveryImages,
    aiResultUrls: deliveryImages.slice(),
    aiResultRecords: deliveryRecords.slice()
  };
}

module.exports = {
  safeParse,
  finalUrl,
  sameCandidate,
  isSuccessfulPrimaryStyling,
  mergeSupplementResult,
  mergeCandidateRecords,
  mergeDeliveryImages,
  buildSupplementDeliveryUpdate
};
