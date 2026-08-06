const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

const R2_PUBLIC_BASE_URL = cleanEnv(process.env.R2_PUBLIC_BASE_URL || 'https://pub-b2df17496aee418db2c3c6737e72bc8b.r2.dev').replace(/\/+$/, '');
const R2_ACCOUNT_ID = cleanEnv(process.env.R2_ACCOUNT_ID || '2cae7e0d09899585fac8567d9d054572');
const R2_BUCKET = cleanEnv(process.env.R2_BUCKET || 'artworks');
const rawEndpoint = cleanEnv(process.env.R2_ENDPOINT || process.env.R2_S3_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
const R2_ENDPOINT = rawEndpoint.replace(new RegExp(`/${R2_BUCKET}/?$`), '').replace(/\/+$/, '');
const R2_ACCESS_KEY_ID = cleanEnv(process.env.R2_ACCESS_KEY_ID || '');
const R2_SECRET_ACCESS_KEY = cleanEnv(process.env.R2_SECRET_ACCESS_KEY || '');

let client = null;

function isR2Configured() {
  return Boolean(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
}

function getClient() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
      }
    });
  }
  return client;
}

function safeDecodeURIComponent(value) {
  const text = String(value || '');
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

function encodeObjectKeyForUrl(key) {
  const normalizedKey = String(key || '').replace(/^\/+/, '');
  if (!normalizedKey) return '';
  return normalizedKey
    .split('/')
    .filter(segment => segment !== '')
    .map(segment => encodeURIComponent(safeDecodeURIComponent(segment)))
    .join('/');
}

function getPublicUrl(key) {
  const encodedKey = encodeObjectKeyForUrl(key);
  return encodedKey ? `${R2_PUBLIC_BASE_URL}/${encodedKey}` : R2_PUBLIC_BASE_URL;
}

async function listObjectsByPrefix(prefix, { maxKeys = 1 } = {}) {
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('Missing R2 credentials. Please set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  }
  const normalizedPrefix = String(prefix || '').replace(/^\/+/, '');
  const result = await getClient().send(new ListObjectsV2Command({
    Bucket: R2_BUCKET,
    Prefix: normalizedPrefix,
    MaxKeys: Math.max(1, Math.min(Number(maxKeys) || 1, 1000))
  }));
  return Array.isArray(result.Contents) ? result.Contents : [];
}

async function hasObjectsWithPrefix(prefix) {
  const objects = await listObjectsByPrefix(prefix, { maxKeys: 1 });
  return objects.length > 0;
}

async function checkR2Connection() {
  const hasCreds = Boolean(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
  if (!hasCreds) {
    return {
      ok: false,
      configured: false,
      bucket: R2_BUCKET,
      endpoint: R2_ENDPOINT,
      publicBaseUrl: R2_PUBLIC_BASE_URL,
      message: 'R2 credentials are missing. Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.'
    };
  }
  try {
    await getClient().send(new ListObjectsV2Command({ Bucket: R2_BUCKET, MaxKeys: 1 }));
    return { ok: true, configured: true, bucket: R2_BUCKET, endpoint: R2_ENDPOINT, publicBaseUrl: R2_PUBLIC_BASE_URL };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      bucket: R2_BUCKET,
      endpoint: R2_ENDPOINT,
      publicBaseUrl: R2_PUBLIC_BASE_URL,
      message: error && error.message ? error.message : 'UnknownError',
      errorName: error && error.name ? error.name : undefined,
      errorCode: error && (error.code || error.Code) ? (error.code || error.Code) : undefined,
      httpStatusCode: error && error.$metadata ? error.$metadata.httpStatusCode : undefined,
      requestId: error && error.$metadata ? error.$metadata.requestId : undefined,
      accessKeyIdLength: R2_ACCESS_KEY_ID.length,
      secretAccessKeyLength: R2_SECRET_ACCESS_KEY.length
    };
  }
}

async function uploadBuffer({ key, body, contentType, cacheControl = 'public, max-age=31536000, immutable' }) {
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('Missing R2 credentials. Please set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  }
  const normalizedKey = String(key || '').replace(/^\/+/, '');
  await getClient().send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: normalizedKey,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: cacheControl
  }));
  return {
    key: normalizedKey,
    url: getPublicUrl(normalizedKey)
  };
}


async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadObjectBufferByKey(key) {
  if (!key) throw new Error('Missing key');
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('Missing R2 credentials. Please set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  }
  const normalizedKey = String(key).replace(/^\/+/, '');
  const result = await getClient().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: normalizedKey }));
  return streamToBuffer(result.Body);
}

async function deleteObjectByKey(key) {
  if (!key) return;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('Missing R2 credentials. Please set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  }
  const normalizedKey = String(key).replace(/^\/+/, '');
  await getClient().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: normalizedKey }));
}

function buildArtworkObjectKey({ artworkCode, assetId, assetKind, originalName }) {
  const ext = (path.extname(originalName || '') || '.jpg').toLowerCase();
  const safeKind = assetKind === 'effect' ? 'effect' : (assetKind === 'frame' ? 'frame' : 'artwork');
  return `${artworkCode}/${safeKind}/${assetId}${ext}`;
}

function buildArtworkThumbObjectKey({ artworkCode, assetId, assetKind, size = 320 }) {
  const safeKind = assetKind === 'effect' ? 'effect' : (assetKind === 'frame' ? 'frame' : 'artwork');
  const normalizedSize = Math.max(120, Math.min(Number(size) || 320, 1600));
  return `${artworkCode}/${safeKind}/${assetId}_thumb_${normalizedSize}.webp`;
}

function safeObjectSegment(value, fallback = 'unknown') {
  const cleaned = String(value || '').trim()
    .replace(/[\\/:*?"<>|#%{}\[\]^~`]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function buildDeliveryObjectKey({ artworkCode, orderId, filename, index = 0 }) {
  const ext = (path.extname(filename || '') || '.jpg').toLowerCase();
  const base = safeObjectSegment(path.basename(filename || 'delivery', path.extname(filename || '')), 'delivery');
  const code = safeObjectSegment(artworkCode, 'unassigned');
  const order = safeObjectSegment(orderId, 'order');
  const idx = String(Number(index || 0) + 1).padStart(2, '0');
  return `${code}/delivery/${order}/${idx}_${base}${ext}`;
}

function buildMiniappCodeObjectKey({ artworkCode, scanToken, envVersion = 'release' }) {
  const token = safeObjectSegment(scanToken, 'unassigned');
  const code = safeObjectSegment(artworkCode, 'artwork');
  const env = safeObjectSegment(envVersion, 'release');
  return `QR-code/miniapp-codes/${token}-${code}-${env}.png`;
}


module.exports = {
  R2_PUBLIC_BASE_URL,
  R2_ENDPOINT,
  R2_BUCKET,
  isR2Configured,
  getPublicUrl,
  encodeObjectKeyForUrl,
  checkR2Connection,
  listObjectsByPrefix,
  hasObjectsWithPrefix,
  uploadBuffer,
  deleteObjectByKey,
  downloadObjectBufferByKey,
  buildArtworkObjectKey,
  buildArtworkThumbObjectKey,
  buildDeliveryObjectKey,
  buildMiniappCodeObjectKey
};
