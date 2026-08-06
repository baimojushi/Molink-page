function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function appendQuery(url, query) {
  if (!query) return url
  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}

function hasImageProcess(url) {
  return /(?:x-oss-process=|imageMogr2|imageView2|thumbor|tr=w-|f_auto|q_auto|\/api\/client\/thumb\?)/i.test(String(url || ''))
}

function getHost(url) {
  const value = String(url || '').trim()
  if (!value) return ''

  const matched = value.match(/^https?:\/\/([^/?#]+)/i)
  return matched && matched[1] ? matched[1] : ''
}

function getServerUrl(explicitServerUrl) {
  const direct = String(explicitServerUrl || '').trim()
  if (direct) return direct.replace(/\/+$/, '')

  try {
    const app = typeof getApp === 'function' ? getApp() : null
    const runtimeUrl = app && app.globalData && app.globalData.serverUrl ? String(app.globalData.serverUrl).trim() : ''
    if (runtimeUrl) return runtimeUrl.replace(/\/+$/, '')
  } catch (error) {}

  return 'https://www.molink.art'
}

function shouldUseServerThumb(url) {
  const value = String(url || '').trim()
  if (!value) return false
  if (value.startsWith('/uploads/') || value.startsWith('/deliveries/')) return true
  if (!/^https?:\/\//i.test(value)) return false
  return /(?:molink\.art|r2\.dev)/i.test(getHost(value))
}

function buildServerThumbUrl(url, options = {}) {
  const serverUrl = getServerUrl(options.serverUrl)
  const width = clamp(Number(options.width) || 720, 80, 1600)
  const height = clamp(Number(options.height) || 0, 0, 1600)
  const quality = clamp(Number(options.quality) || 82, 60, 96)
  const fit = ['cover', 'contain', 'inside'].includes(String(options.fit || '').trim()) ? String(options.fit).trim() : 'inside'
  const params = [
    `src=${encodeURIComponent(String(url || '').trim())}`,
    `w=${width}`,
    `q=${quality}`,
    `fit=${fit}`
  ]
  if (height > 0) params.push(`h=${height}`)
  return `${serverUrl}/api/client/thumb?${params.join('&')}`
}

function buildThumbnailUrl(url, options = {}) {
  const value = String(url || '').trim()
  if (!value) return ''
  if (!/^https?:\/\//i.test(value) && !value.startsWith('/uploads/') && !value.startsWith('/deliveries/')) return value
  if (hasImageProcess(value)) return value

  if (shouldUseServerThumb(value)) {
    return buildServerThumbUrl(value, options)
  }

  const width = clamp(Number(options.width) || 720, 120, 2400)
  const height = clamp(Number(options.height) || width, 120, 2400)
  const quality = clamp(Number(options.quality) || 82, 60, 95)
  const host = getHost(value)

  if (/(?:aliyuncs\.com|oss[-.].*aliyun|aliyun)/i.test(host)) {
    return appendQuery(value, `x-oss-process=image/resize,m_lfit,w_${width},h_${height}/quality,q_${quality}`)
  }

  if (/(?:qpic\.cn|myqcloud\.com|tcb\.qcloud\.la|qcloud\.com)/i.test(host)) {
    return appendQuery(value, `imageMogr2/thumbnail/${width}x${height}>/quality/${quality}`)
  }

  if (/(?:qiniucdn\.com|clouddn\.com|qiniu)/i.test(host)) {
    return appendQuery(value, `imageView2/2/w/${width}/h/${height}/q/${quality}`)
  }

  return value
}

function decorateArtworkThumbs(serverUrl, artwork = {}, thumbSize = 720) {
  const options = {
    serverUrl,
    width: clamp(Number(thumbSize) || 720, 120, 1600),
    height: clamp(Number(thumbSize) || 720, 120, 1600),
    quality: 82,
    fit: 'cover'
  }

  const images = Array.isArray(artwork.images) ? artwork.images.filter(Boolean) : []
  const coverUrl = String(artwork.cover_url || artwork.primary_image_url || images[0] || '').trim()
  const primaryUrl = String(artwork.primary_image_url || coverUrl || images[0] || '').trim()
  const thumbImages = images.map(url => buildThumbnailUrl(url, options))
  const coverThumbUrl = buildThumbnailUrl(coverUrl, options)
  const primaryThumbUrl = buildThumbnailUrl(primaryUrl, options)

  return Object.assign({}, artwork, {
    cover_thumb_url: artwork.cover_thumb_url || coverThumbUrl,
    primary_thumb_url: artwork.primary_thumb_url || primaryThumbUrl,
    thumb_images: thumbImages.length ? thumbImages : (Array.isArray(artwork.thumb_images) ? artwork.thumb_images : []),
    list_image_url: artwork.list_image_url || thumbImages[0] || coverThumbUrl || primaryThumbUrl || coverUrl || primaryUrl
  })
}

function buildDisplayImages(urls, options = {}) {
  return (urls || [])
    .filter(Boolean)
    .map(url => ({
      fullUrl: url,
      thumbUrl: buildThumbnailUrl(url, options)
    }))
}

function getFileInfo(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileInfo({
      filePath,
      success: resolve,
      fail: reject
    })
  })
}

function safeFileSize(filePath) {
  if (!filePath) return Promise.resolve(0)
  return getFileInfo(filePath)
    .then(info => Number(info && info.size) || 0)
    .catch(() => 0)
}

function compressImage(filePath, quality) {
  return new Promise((resolve, reject) => {
    if (!wx.compressImage) {
      reject(new Error('compressImage unavailable'))
      return
    }

    wx.compressImage({
      src: filePath,
      quality,
      success: resolve,
      fail: reject
    })
  })
}

function formatFileSize(size) {
  const bytes = Number(size) || 0
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }
  if (bytes >= 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))}KB`
  }
  return `${bytes}B`
}

async function prepareUploadAsset(originPath, options = {}) {
  const quality = clamp(Number(options.quality) || 95, 85, 97)
  const minCompressBytes = Number(options.minCompressBytes) || 420 * 1024
  const minSavedRatio = Number(options.minSavedRatio) || 0.04

  // 默认上传原始图片，避免 wx.compressImage 重编码丢失 EXIF。
  // 压缩图只用于小程序本地预览。
  const preserveOriginalUpload = options.preserveOriginalUpload !== false

  const originalSize = await safeFileSize(originPath)
  const asset = {
    originalPath: originPath,
    originPath,
    previewPath: originPath,
    uploadPath: originPath,
    optimized: false,
    originalSize,
    uploadSize: originalSize,
    previewSize: originalSize,
    savedBytes: 0,
    savedText: ''
  }

  if (!originalSize || originalSize < minCompressBytes) {
    return asset
  }

  try {
    const compressed = await compressImage(originPath, quality)
    const compressedPath = compressed && compressed.tempFilePath ? compressed.tempFilePath : ''
    if (!compressedPath) return asset

    const compressedSize = await safeFileSize(compressedPath)
    const savedBytes = originalSize - compressedSize
    const savedRatio = originalSize > 0 ? savedBytes / originalSize : 0

    if (compressedSize > 0 && savedBytes > 0 && savedRatio >= minSavedRatio) {
      asset.previewPath = compressedPath
      asset.uploadPath = preserveOriginalUpload ? originPath : compressedPath
      asset.optimized = true
      asset.uploadSize = preserveOriginalUpload ? originalSize : compressedSize
      asset.previewSize = compressedSize
      asset.savedBytes = savedBytes
      asset.savedText = formatFileSize(savedBytes)
    }
  } catch (error) {}

  return asset
}

async function prepareImageAsset(originPath, options = {}) {
  return prepareUploadAsset(originPath, options)
}

module.exports = {
  buildThumbnailUrl,
  decorateArtworkThumbs,
  buildDisplayImages,
  safeFileSize,
  prepareImageAsset,
  prepareUploadAsset,
  formatFileSize
}
