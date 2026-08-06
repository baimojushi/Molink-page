const fs = require('fs');
const path = require('path');
const { uploadBuffer, buildDeliveryObjectKey, encodeObjectKeyForUrl } = require('./r2');
const { sanitizeDeliveryResultRecords } = require('./deliveryResultPublic');

const DEFAULT_SERVER_BASE_URL = (process.env.SERVER_BASE_URL || 'https://www.molink.art').replace(/\/+$/, '');

function safeJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function isAbsoluteUrl(value) {
  return /^(https?:)?\/\//i.test(String(value || '').trim());
}

function safeDecodeURIComponent(value) {
  const text = String(value || '');
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

function encodePathname(pathname) {
  const raw = String(pathname || '');
  const leadingSlash = raw.startsWith('/');
  const encoded = raw
    .split('/')
    .filter((segment, index) => !(index === 0 && segment === ''))
    .map(segment => encodeURIComponent(safeDecodeURIComponent(segment)))
    .join('/');
  return leadingSlash ? `/${encoded}` : encoded;
}

function normalizePublicImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!isAbsoluteUrl(raw)) return raw;
  try {
    const parsed = new URL(raw);
    parsed.pathname = encodePathname(parsed.pathname);
    return parsed.toString();
  } catch (error) {
    return raw;
  }
}

function decodeComparable(value) {
  return safeDecodeURIComponent(String(value || '').trim());
}

function basenameForCompare(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (isAbsoluteUrl(raw)) {
      const parsed = new URL(raw);
      return decodeComparable(path.basename(parsed.pathname));
    }
  } catch (error) {}
  return decodeComparable(path.basename(raw.split('?')[0]));
}

function normalizeServerBaseUrl(serverBaseUrl) {
  return String(serverBaseUrl || DEFAULT_SERVER_BASE_URL).replace(/\/+$/, '');
}

function localDeliveryUrl(filename, serverBaseUrl = DEFAULT_SERVER_BASE_URL) {
  const value = String(filename || '').trim();
  if (!value) return '';
  if (isAbsoluteUrl(value)) return normalizePublicImageUrl(value);
  const baseUrl = normalizeServerBaseUrl(serverBaseUrl);
  if (value.startsWith('/deliveries/')) return `${baseUrl}${encodePathname(value)}`;
  return `${baseUrl}/deliveries/${encodeObjectKeyForUrl(value.replace(/^\/+/, ''))}`;
}

function pickRecordUrl(record) {
  if (!record) return '';
  return normalizePublicImageUrl(record.r2_url || record.r2_public_url || record.permanent_url || record.image_url || '');
}

function matchDeliveryRecord(records, image, index) {
  const value = String(image || '').trim();
  const decodedValue = decodeComparable(value);
  const basename = basenameForCompare(value);
  return records.find(record => {
    if (!record) return false;
    const candidates = [
      record.filename,
      record.local_image_url,
      record.image_url,
      record.r2_url,
      record.r2_public_url,
      record.permanent_url
    ].filter(Boolean);
    return candidates.some(candidate => {
      const raw = String(candidate || '').trim();
      return raw === value
        || decodeComparable(raw) === decodedValue
        || basenameForCompare(raw) === basename;
    });
  }) || records[index] || null;
}

function resolveDeliveryImageUrl(image, record, serverBaseUrl = DEFAULT_SERVER_BASE_URL) {
  const permanentUrl = pickRecordUrl(record);
  if (permanentUrl) {
    if (isAbsoluteUrl(permanentUrl)) return permanentUrl;
    if (permanentUrl.startsWith('/deliveries/')) return localDeliveryUrl(permanentUrl, serverBaseUrl);
  }
  return localDeliveryUrl(image, serverBaseUrl);
}

function getDeliveryImages(order) {
  return safeJsonArray(order && order.delivery_images, []);
}

function getDeliveryResultRecords(order) {
  return safeJsonArray(order && order.delivery_result_records_json, []);
}

function resolveDeliveryImageUrls(order, options = {}) {
  const serverBaseUrl = normalizeServerBaseUrl(options.serverBaseUrl);
  const images = getDeliveryImages(order);
  const records = getDeliveryResultRecords(order);
  return images.map((image, index) => {
    const record = matchDeliveryRecord(records, image, index);
    return resolveDeliveryImageUrl(image, record, serverBaseUrl);
  }).filter(Boolean);
}

function enrichDeliveryResultRecords(order, options = {}) {
  const serverBaseUrl = normalizeServerBaseUrl(options.serverBaseUrl);
  const images = getDeliveryImages(order);
  const records = getDeliveryResultRecords(order).map(record => Object.assign({}, record));
  return images.map((image, index) => {
    const record = matchDeliveryRecord(records, image, index) || { filename: isAbsoluteUrl(image) ? path.basename(String(image).split('?')[0]) : image };
    const url = resolveDeliveryImageUrl(image, record, serverBaseUrl);
    return Object.assign({}, record, {
      filename: record.filename || (isAbsoluteUrl(image) ? path.basename(String(image).split('?')[0]) : image),
      image_url: url,
      local_image_url: record.local_image_url || localDeliveryUrl(image, serverBaseUrl)
    });
  });
}

function enrichPublicDeliveryResultRecords(order, options = {}) {
  return sanitizeDeliveryResultRecords(enrichDeliveryResultRecords(order, options));
}

function inferContentType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/jpeg';
}

async function uploadDeliveryImageToR2({ order, filename, localPath, sourceRecord = {}, index = 0 }) {
  if (!filename || isAbsoluteUrl(filename)) return null;
  const filePath = localPath || '';
  if (!filePath || !fs.existsSync(filePath)) return null;
  const artworkCode = sourceRecord.artwork_code || order.artwork_code || order.artwork_id || 'unassigned';
  const key = buildDeliveryObjectKey({
    artworkCode,
    orderId: order.id,
    filename,
    index
  });
  const body = fs.readFileSync(filePath);
  return uploadBuffer({
    key,
    body,
    contentType: inferContentType(filename)
  });
}

module.exports = {
  safeJsonArray,
  isAbsoluteUrl,
  localDeliveryUrl,
  normalizePublicImageUrl,
  getDeliveryImages,
  getDeliveryResultRecords,
  matchDeliveryRecord,
  resolveDeliveryImageUrl,
  resolveDeliveryImageUrls,
  enrichDeliveryResultRecords,
  enrichPublicDeliveryResultRecords,
  uploadDeliveryImageToR2
};
