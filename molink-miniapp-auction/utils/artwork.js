const { buildThumbnailUrl } = require('./image')

function toAbsoluteAsset(serverUrl, assetPath) {
  const value = String(assetPath || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (!serverUrl) return value
  return `${serverUrl}${value.startsWith('/') ? '' : '/'}${value}`
}

function uniqueList(items) {
  return [...new Set((items || []).filter(Boolean))]
}

function normalizeArtwork(serverUrl, artwork = {}) {
  const artworkImages = Array.isArray(artwork.artwork_images) ? artwork.artwork_images.map(item => toAbsoluteAsset(serverUrl, item)) : []
  const frameImages = Array.isArray(artwork.frame_images) ? artwork.frame_images.map(item => toAbsoluteAsset(serverUrl, item)) : []
  const effectImages = Array.isArray(artwork.effect_images) ? artwork.effect_images.map(item => toAbsoluteAsset(serverUrl, item)) : []
  const fallbackImages = Array.isArray(artwork.images) ? artwork.images.map(item => toAbsoluteAsset(serverUrl, item)) : []
  const coverUrl = toAbsoluteAsset(serverUrl, artwork.cover_url || artwork.primary_image_url || artwork.image_url || artwork.full_url || '')
  const primaryUrl = toAbsoluteAsset(serverUrl, artwork.primary_image_url || artwork.image_url || artwork.full_url || coverUrl)
  const previewImages = uniqueList([coverUrl, primaryUrl, ...fallbackImages, ...artworkImages, ...frameImages, ...effectImages])
  const artworkCode = String(artwork.artwork_code || artwork.code || artwork.num || '').trim()
  const sizeText = String(artwork.size_text || artwork.size || '').trim()
  const frameSizeText = String(artwork.frame_size_text || '').trim()
  const priceText = String(
    artwork.price !== undefined && artwork.price !== null
      ? artwork.price
      : (artwork.artwork_price || '')
  ).trim()
  const providedCoverThumbUrl = toAbsoluteAsset(serverUrl, artwork.cover_thumb_url || artwork.thumb_url || '')
  const providedPrimaryThumbUrl = toAbsoluteAsset(serverUrl, artwork.primary_thumb_url || artwork.thumb_url || '')
  const providedThumbImages = Array.isArray(artwork.thumb_images) ? artwork.thumb_images.map(item => toAbsoluteAsset(serverUrl, item)) : []
  const coverThumbUrl = providedCoverThumbUrl || buildThumbnailUrl(coverUrl, { serverUrl, width: 840, height: 840, quality: 82, fit: 'cover' })
  const primaryThumbUrl = providedPrimaryThumbUrl || buildThumbnailUrl(primaryUrl, { serverUrl, width: 840, height: 840, quality: 82, fit: 'cover' })
  const thumbImages = providedThumbImages.length
    ? uniqueList(providedThumbImages)
    : previewImages.map(item => buildThumbnailUrl(item, { serverUrl, width: 840, height: 840, quality: 82, fit: 'cover' }))

  return Object.assign({}, artwork, {
    num: artworkCode,
    code: artworkCode,
    ref: artworkCode || String(artwork.id || '').trim(),
    artwork_code: artworkCode,
    cover_url: coverUrl,
    cover_thumb_url: coverThumbUrl,
    primary_image_url: primaryUrl,
    primary_thumb_url: primaryThumbUrl,
    images: previewImages,
    thumb_images: thumbImages,
    list_image_url: artwork.list_image_url || thumbImages[0] || coverThumbUrl || primaryThumbUrl || coverUrl || primaryUrl,
    artwork_images: artworkImages,
    frame_images: frameImages,
    effect_images: effectImages,
    size: sizeText,
    size_text: sizeText,
    frame_size_text: frameSizeText,
    price: priceText,
    display_price: priceText,
    display_code: artworkCode,
    display_size: sizeText,
    display_frame_size: frameSizeText
  })
}

function artworkIdentityPool(artwork = {}) {
  return uniqueList([
    artwork.artwork_code,
    artwork.code,
    artwork.num,
    artwork.id,
    artwork.qrCode,
    artwork.qrcode,
    artwork.ref
  ].map(item => String(item || '').trim()).filter(Boolean))
}

function matchArtworkByReference(list, artworkRef) {
  const target = String(artworkRef || '').trim().toLowerCase()
  if (!target) return null
  return (list || []).find(item => artworkIdentityPool(item).some(value => String(value).trim().toLowerCase() === target)) || null
}

function extractArtworkCandidates(raw) {
  const text = String(raw || '').trim()
  const candidates = []
  if (!text) return candidates
  candidates.push(text)

  try {
    const parsed = JSON.parse(text)
    ['num', 'id', 'artwork_num', 'code', 'artwork_code', 'artworkRef', 'artwork_ref', 'qrCode'].forEach(key => {
      if (parsed && parsed[key]) candidates.push(String(parsed[key]))
    })
  } catch (error) {}

  const queryLike = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text
  if (queryLike.includes('=')) {
    queryLike.split('&').forEach(pair => {
      const [rawKey, rawValue] = pair.split('=')
      const key = String(rawKey || '').trim()
      const value = rawValue ? decodeURIComponent(String(rawValue)) : ''
      if (['num', 'id', 'artwork', 'artwork_num', 'code', 'artwork_code', 'artworkRef', 'artwork_ref', 'scene', 'artworkCode'].includes(key) && value) {
        candidates.push(value)
      }
      if (key === 'scene' && value) {
        value.split('&').forEach(scenePair => {
          const [sceneKey, sceneValue] = scenePair.split('=')
          if (['num', 'id', 'artwork', 'artwork_num', 'code', 'artwork_code', 'artworkRef', 'artwork_ref', 'artworkCode'].includes(String(sceneKey || '').trim()) && sceneValue) {
            candidates.push(decodeURIComponent(String(sceneValue)))
          }
        })
      }
    })
  }

  try {
    const url = new URL(text)
    ['num', 'id', 'artwork', 'artwork_num', 'code', 'artwork_code', 'artworkRef', 'artwork_ref', 'scene'].forEach(key => {
      const value = url.searchParams.get(key)
      if (value) candidates.push(value)
    })
    const pathname = url.pathname.split('/').filter(Boolean)
    if (pathname.length > 0) candidates.push(pathname[pathname.length - 1])
  } catch (error) {}

  return uniqueList(candidates.map(item => decodeURIComponent(String(item)).trim()).filter(Boolean))
}

module.exports = {
  toAbsoluteAsset,
  normalizeArtwork,
  artworkIdentityPool,
  matchArtworkByReference,
  extractArtworkCandidates
}
