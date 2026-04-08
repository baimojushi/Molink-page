const app = getApp()
const { resolveEntryPreset } = require('../../utils/qr-entry-config')

function buildQuery(params) {
  return Object.keys(params)
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&')
}

function normalizeRemoteAsset(serverUrl, assetPath) {
  const value = String(assetPath || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (!serverUrl) return value
  return `${serverUrl}${value.startsWith('/') ? '' : '/'}${value}`
}

Page({
  data: {
    heroImage: '',
    hintText: '上滑挂进自己家',
    swipeOffset: 0,
    entering: false,
    heroImageReady: false
  },

  onLoad(options) {
    this.touchStartY = 0
    this.touchDeltaY = 0
    this.entryPreset = resolveEntryPreset(options)

    this.setData({
      heroImage: normalizeRemoteAsset(app.globalData.serverUrl, this.entryPreset.heroImagePath),
      hintText: this.entryPreset.hintText || '上滑挂进自己家',
      heroImageReady: false
    })
  },

  onHeroLoad() {
    this.setData({ heroImageReady: true })
  },

  onHeroError(e) {
    console.log('qr hero load failed', e, this.data.heroImage)
  },

  onTouchStart(e) {
    const touch = (e.touches && e.touches[0]) || null
    this.touchStartY = touch ? touch.clientY : 0
    this.touchDeltaY = 0
  },

  onTouchMove(e) {
    const touch = (e.touches && e.touches[0]) || null
    if (!touch) return

    const delta = Math.max(0, this.touchStartY - touch.clientY)
    this.touchDeltaY = delta
    this.setData({
      swipeOffset: Math.min(72, Math.floor(delta * 0.35))
    })
  },

  onTouchEnd() {
    const shouldEnter = this.touchDeltaY >= 90
    this.setData({ swipeOffset: 0 })
    this.touchDeltaY = 0

    if (shouldEnter) {
      this.enterUpload()
    }
  },

  noop() {},

  enterUpload() {
    if (this.data.entering) return

    const preset = this.entryPreset || resolveEntryPreset({})
    const query = buildQuery({
      service: preset.service || 'hang_in_home',
      entryKey: preset.entryKey || preset.key,
      artworkNum: preset.artworkNum,
      artworkName: preset.artworkName,
      artworkAuthor: preset.artworkAuthor,
      artworkVariant: preset.artworkVariant,
      lockArtwork: 1
    })

    this.setData({ entering: true })
    wx.redirectTo({
      url: `/pages/upload/upload?${query}`,
      complete: () => {
        this.setData({ entering: false })
      }
    })
  }
})
