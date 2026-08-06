const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { URL } = require('url');
const { R2_PUBLIC_BASE_URL } = require('./r2');

const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');
const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');
const THUMB_CACHE_DIR = path.join(PERSISTENT_ROOT, 'thumb-cache');
const SERVER_BASE_URL = String(process.env.SERVER_BASE_URL || 'https://www.molink.art').trim().replace(/\/+$/, '');
const THUMB_CACHE_MAX_AGE_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.THUMB_CACHE_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000
);
const THUMB_CACHE_MAX_FILES = Math.max(100, Number(process.env.THUMB_CACHE_MAX_FILES) || 2000);
const THUMB_CACHE_MAX_BYTES = Math.max(
  50 * 1024 * 1024,
  Number(process.env.THUMB_CACHE_MAX_BYTES) || 512 * 1024 * 1024
);
const THUMB_CACHE_PRUNE_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.THUMB_CACHE_PRUNE_INTERVAL_MS) || 15 * 60 * 1000
);
const MAX_SOURCE_IMAGE_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.THUMB_SOURCE_MAX_BYTES) || 25 * 1024 * 1024
);

let lastThumbCachePruneAt = 0;
let thumbCachePruneRunning = false;

fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch (error) {
    return '';
  }
}

const ALLOWED_REMOTE_HOSTS = new Set(
  [
    safeHost(SERVER_BASE_URL),
    safeHost(R2_PUBLIC_BASE_URL),
    'www.molink.art',
    'pub-b2df17496aee418db2c3c6737e72bc8b.r2.dev'
  ].filter(Boolean)
);

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isAllowedThumbnailSource(sourceUrl) {
  const value = String(sourceUrl || '').trim();
  if (!value) return false;
  if (value.startsWith('/uploads/') || value.startsWith('/deliveries/')) return true;
  if (!isHttpUrl(value)) return false;

  try {
    const parsed = new URL(value);
    if (parsed.pathname.startsWith('/api/client/thumb')) return false;
    return ALLOWED_REMOTE_HOSTS.has(parsed.host);
  } catch (error) {
    return false;
  }
}

function safeDecodeURIComponent(value) {
  const text = String(value || '');
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

function resolveInside(baseDir, relativePath) {
  const root = path.resolve(baseDir);
  const decodedRelative = safeDecodeURIComponent(relativePath).replace(/^[/\\]+/, '');
  if (!decodedRelative || decodedRelative.includes('\0')) return null;
  const normalizedRelative = path.normalize(decodedRelative);
  if (normalizedRelative === '..' || normalizedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(normalizedRelative)) {
    return null;
  }
  const fullPath = path.resolve(root, normalizedRelative);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return fullPath;
}

function resolveLocalFilePath(sourceUrl) {
  const value = String(sourceUrl || '').trim();
  if (!value) return null;

  const mapPathToFile = pathname => {
    const decodedPathname = safeDecodeURIComponent(pathname || '');
    if (decodedPathname.includes('\0')) return null;
    if (decodedPathname.startsWith('/uploads/')) {
      return resolveInside(UPLOADS_DIR, decodedPathname.replace(/^\/uploads\//, ''));
    }
    if (decodedPathname.startsWith('/deliveries/')) {
      return resolveInside(DELIVERIES_DIR, decodedPathname.replace(/^\/deliveries\//, ''));
    }
    return null;
  };

  if (value.startsWith('/')) {
    return mapPathToFile(value.split('?')[0]);
  }

  if (!isHttpUrl(value)) return null;

  try {
    const parsed = new URL(value);
    if (ALLOWED_REMOTE_HOSTS.has(parsed.host)) {
      return mapPathToFile(parsed.pathname);
    }
  } catch (error) {}

  return null;
}

async function loadSourceBuffer(sourceUrl) {
  const localFilePath = resolveLocalFilePath(sourceUrl);
  if (localFilePath) {
    const stat = await fsp.stat(localFilePath);
    if (stat.size > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error('ThumbnailSourceTooLarge');
    }
    return fsp.readFile(localFilePath);
  }

  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`ThumbnailSourceFetchFailed:${response.status}`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error('ThumbnailSourceNotImage');
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error('ThumbnailSourceTooLarge');
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error('ThumbnailSourceTooLarge');
  }
  return Buffer.from(arrayBuffer);
}

async function pruneThumbnailCache() {
  fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });

  const now = Date.now();
  const files = (await fsp.readdir(THUMB_CACHE_DIR)).filter(name => name.endsWith('.webp'));
  const entries = [];
  let deleted = 0;

  for (const name of files) {
    const filePath = path.join(THUMB_CACHE_DIR, name);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (error) {
      continue;
    }

    if (now - stat.mtimeMs > THUMB_CACHE_MAX_AGE_MS) {
      await fsp.unlink(filePath).then(() => { deleted++; }).catch(() => {});
      continue;
    }

    entries.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
  }

  let totalBytes = entries.reduce((sum, item) => sum + item.size, 0);
  if (entries.length > THUMB_CACHE_MAX_FILES || totalBytes > THUMB_CACHE_MAX_BYTES) {
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let currentCount = entries.length;
    for (const entry of entries) {
      if (currentCount <= THUMB_CACHE_MAX_FILES && totalBytes <= THUMB_CACHE_MAX_BYTES) break;
      await fsp.unlink(entry.filePath).then(() => {
        deleted++;
        currentCount--;
        totalBytes -= entry.size;
      }).catch(() => {});
    }
  }

  return { deleted };
}

function scheduleThumbnailCachePrune() {
  const now = Date.now();
  if (thumbCachePruneRunning || now - lastThumbCachePruneAt < THUMB_CACHE_PRUNE_INTERVAL_MS) return;
  lastThumbCachePruneAt = now;
  thumbCachePruneRunning = true;
  pruneThumbnailCache()
    .catch(error => console.warn('thumbnail cache prune failed:', error.message))
    .finally(() => { thumbCachePruneRunning = false; });
}

function buildCacheFilePath({ sourceUrl, width, height, quality, fit }) {
  const hash = crypto.createHash('sha1').update(JSON.stringify({ sourceUrl, width, height, quality, fit })).digest('hex');
  return path.join(THUMB_CACHE_DIR, `${hash}.webp`);
}

async function getThumbnailBuffer({ sourceUrl, width = 480, height = 0, quality = 82, fit = 'inside' }) {
  scheduleThumbnailCachePrune();
  const normalizedWidth = Math.max(80, Math.min(Number(width) || 480, 1600));
  const normalizedHeight = Math.max(0, Math.min(Number(height) || 0, 1600));
  const normalizedQuality = Math.max(60, Math.min(Number(quality) || 82, 96));
  const normalizedFit = ['cover', 'contain', 'inside'].includes(fit) ? fit : 'inside';
  const cacheFilePath = buildCacheFilePath({
    sourceUrl,
    width: normalizedWidth,
    height: normalizedHeight,
    quality: normalizedQuality,
    fit: normalizedFit
  });

  if (fs.existsSync(cacheFilePath)) {
    try {
      return {
        buffer: await fsp.readFile(cacheFilePath),
        contentType: 'image/webp',
        cacheHit: true
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const sourceBuffer = await loadSourceBuffer(sourceUrl);
  const transformer = sharp(sourceBuffer, { failOn: 'none' }).rotate();
  const resizeOptions = {
    width: normalizedWidth,
    fit: normalizedFit,
    withoutEnlargement: true
  };

  if (normalizedHeight > 0) {
    resizeOptions.height = normalizedHeight;
  }

  const buffer = await transformer
    .resize(resizeOptions)
    .webp({ quality: normalizedQuality, effort: 4 })
    .toBuffer();

  await fsp.writeFile(cacheFilePath, buffer);

  return {
    buffer,
    contentType: 'image/webp',
    cacheHit: false
  };
}

module.exports = {
  isAllowedThumbnailSource,
  getThumbnailBuffer,
  pruneThumbnailCache
};
