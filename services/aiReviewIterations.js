// services/aiReviewIterations.js —— 记录 AI 生图全流程迭代图，并为人工审核构建候选列表
const crypto = require('crypto');
const { safeJsonParse, buildAiResultRecord } = require('./recommendWork');

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  return safeJsonParse(value, []);
}

function normalizeUrl(value) {
  return String(value || '').trim();
}

function uniqueId(prefix = 'iter') {
  const rand = crypto.randomBytes(6).toString('hex');
  return `${prefix}_${Date.now()}_${rand}`;
}

function getResultUrls(order = {}) {
  const urls = safeJsonArray(order.ai_result_urls)
    .map(normalizeUrl)
    .filter(Boolean);
  if (urls.length === 0 && order.ai_result_url) {
    const one = normalizeUrl(order.ai_result_url);
    if (one) urls.push(one);
  }
  return Array.from(new Set(urls));
}

function getResultRecords(order = {}) {
  return safeJsonArray(order.ai_result_records || order.ai_result_records_json);
}

function getIterationRecords(orderOrValue) {
  if (Array.isArray(orderOrValue)) return orderOrValue;
  if (orderOrValue && typeof orderOrValue === 'object') {
    return safeJsonArray(orderOrValue.ai_iteration_records || orderOrValue.ai_iteration_records_json);
  }
  return safeJsonArray(orderOrValue);
}

function reviewStatusLabel(status) {
  const key = String(status || '').trim();
  const labels = {
    pass: '系统审核通过',
    dimension_failed: '尺寸未通过',
    dimension_fix_limit: '尺寸修正上限',
    artwork_consistency_failed: '画作不一致',
    physics_failed: '物理不通过',
    review_failed: '系统审核未通过',
    review_error: '审核异常',
    unknown: '待确认'
  };
  return labels[key] || labels.unknown;
}

function inferReviewStatus(review = {}, override = '') {
  if (override) return override;
  if (review.pass) return 'pass';
  if (review.isDimension) return 'dimension_failed';
  const stage = String(review.reviewStage || review.stage || '').trim();
  if (stage === 'artwork_consistency') return 'artwork_consistency_failed';
  if (stage === 'physics') return 'physics_failed';
  if (stage === 'review_error') return 'review_error';
  return 'review_failed';
}

function buildIterationRecord({
  order = {},
  execId = '',
  imageUrl = '',
  review = {},
  planItem = null,
  batchIndex = null,
  totalInBatch = null,
  retryCount = null,
  dimensionFixCount = null,
  reviewStatus = '',
  selectedByDefault = null,
  source = 'ai_polling'
} = {}) {
  const url = normalizeUrl(imageUrl || review.failedImageUrl);
  const status = inferReviewStatus(review, reviewStatus);
  const pass = status === 'pass' || review.pass === true;
  const baseRecord = planItem ? buildAiResultRecord(url, planItem) : {
    url,
    exec_id: execId || null,
    artwork_id: order.artwork_id || null,
    artwork_code: order.artwork_code || null,
    artwork_name: order.artwork_name || order.service_type_label || '',
    artwork_author: '',
    artwork_size: order.artwork_size || ''
  };

  return {
    id: uniqueId('ai_iter'),
    url,
    image_url: url,
    exec_id: execId || baseRecord.exec_id || null,
    source,
    created_at: new Date().toISOString(),
    review_status: status,
    review_status_label: reviewStatusLabel(status),
    review_pass: pass,
    selected_by_default: selectedByDefault == null ? pass : !!selectedByDefault,
    reason: review.reason || '',
    qwen_reason: review.reason || '',
    correction_action: review.correctionAction || '',
    correction_amount: review.correctionAmount || '',
    dimension_fix_instruction: review.dimensionFixInstruction || '',
    qwen_raw_text: review.rawText || '',
    batch_index: Number.isFinite(Number(batchIndex)) ? Number(batchIndex) : null,
    total_in_batch: Number.isFinite(Number(totalInBatch)) ? Number(totalInBatch) : null,
    retry_count: Number.isFinite(Number(retryCount)) ? Number(retryCount) : null,
    dimension_fix_count: Number.isFinite(Number(dimensionFixCount)) ? Number(dimensionFixCount) : null,
    artwork_id: baseRecord.artwork_id || null,
    artwork_code: baseRecord.artwork_code || null,
    artwork_name: baseRecord.artwork_name || '',
    artwork_author: baseRecord.artwork_author || '',
    artwork_size: baseRecord.artwork_size || ''
  };
}

function normalizeRecord(record = {}, index = 0) {
  const url = normalizeUrl(record.url || record.image_url || record.imageUrl);
  if (!url) return null;
  const status = record.review_status || (record.review_pass ? 'pass' : 'unknown');
  return {
    ...record,
    id: record.id || `ai_iter_legacy_${index}`,
    url,
    image_url: url,
    review_status: status,
    review_status_label: record.review_status_label || reviewStatusLabel(status),
    selected_by_default: record.selected_by_default === true || record.review_pass === true || status === 'pass'
  };
}

function appendIterationRecord(existingValue, nextRecord) {
  const existing = getIterationRecords(existingValue)
    .map(normalizeRecord)
    .filter(Boolean);
  const next = normalizeRecord(nextRecord, existing.length);
  if (!next) return existing;

  const sameIndex = existing.findIndex(item => {
    if (item.url && next.url && item.url === next.url) return true;
    if (item.exec_id && next.exec_id && item.exec_id === next.exec_id && item.url === next.url) return true;
    return false;
  });

  if (sameIndex >= 0) {
    existing[sameIndex] = {
      ...existing[sameIndex],
      ...next,
      id: existing[sameIndex].id || next.id,
      created_at: existing[sameIndex].created_at || next.created_at,
      selected_by_default: existing[sameIndex].selected_by_default === true || next.selected_by_default === true,
      review_status_label: next.review_status_label || existing[sameIndex].review_status_label
    };
  } else {
    existing.push(next);
  }
  return existing;
}

function mergeRecordMeta(candidate, meta = {}) {
  if (!meta) return candidate;
  return {
    ...candidate,
    exec_id: candidate.exec_id || meta.exec_id || null,
    artwork_id: candidate.artwork_id || meta.artwork_id || null,
    artwork_code: candidate.artwork_code || meta.artwork_code || null,
    artwork_name: candidate.artwork_name || meta.artwork_name || '',
    artwork_author: candidate.artwork_author || meta.artwork_author || '',
    artwork_size: candidate.artwork_size || meta.artwork_size || ''
  };
}

function buildReviewCandidates(order = {}) {
  const resultUrls = getResultUrls(order);
  const resultUrlSet = new Set(resultUrls);
  const resultRecords = getResultRecords(order);
  const records = getIterationRecords(order)
    .map(normalizeRecord)
    .filter(Boolean);

  const byUrl = new Map();
  records.forEach((record, index) => {
    const matchedMeta = resultRecords.find(item => normalizeUrl(item?.url) === record.url);
    const merged = mergeRecordMeta(record, matchedMeta);
    byUrl.set(merged.url, {
      ...merged,
      candidate_index: byUrl.size,
      selected_by_default: merged.selected_by_default === true || resultUrlSet.has(merged.url)
    });
  });

  resultUrls.forEach((url, index) => {
    if (byUrl.has(url)) return;
    const meta = resultRecords.find(item => normalizeUrl(item?.url) === url) || resultRecords[index] || {};
    const fallback = normalizeRecord({
      ...meta,
      id: `ai_result_${index}`,
      url,
      image_url: url,
      review_status: 'pass',
      review_status_label: reviewStatusLabel('pass'),
      review_pass: true,
      selected_by_default: true,
      source: 'ai_result_urls'
    }, index);
    if (fallback) byUrl.set(url, fallback);
  });

  return Array.from(byUrl.values()).map((candidate, index) => ({
    ...candidate,
    candidate_index: index,
    review_status_label: candidate.review_status_label || reviewStatusLabel(candidate.review_status),
    selected_by_default: candidate.selected_by_default === true || candidate.review_pass === true || resultUrlSet.has(candidate.url)
  }));
}

function findCandidateByUrl(order = {}, url = '') {
  const target = normalizeUrl(url);
  return buildReviewCandidates(order).find(item => item.url === target) || null;
}

module.exports = {
  safeJsonArray,
  getIterationRecords,
  getResultUrls,
  buildIterationRecord,
  appendIterationRecord,
  buildReviewCandidates,
  findCandidateByUrl,
  reviewStatusLabel
};
