const app = getApp()
const { resolveEntryPreset } = require('../../utils/qr-entry-config')

const DEFAULT_COPY = {
  'garden-orange': {
    title: '施歌-花园系列',
    descriptionLines: [
      '揉秋色于画布',
      '捕捉一场植物的白日梦',
      '它是色彩的引力',
      '让散落的日常',
      '在墙上重组为流动的森林'
    ]
  }
}

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

function stripArtworkText(value) {
  return String(value || '').replace(/[《》]/g, '').trim()
}

function resolveStoryLines(preset = {}) {
  const storyText = String(preset.storyText || '').trim()
  if (storyText) {
    return storyText
      .split(/\n+/)
      .map(item => String(item || '').trim())
      .filter(Boolean)
  }
  if (Array.isArray(preset.descriptionLines) && preset.descriptionLines.length) {
    return preset.descriptionLines
      .map(item => String(item || '').trim())
      .filter(Boolean)
  }
  return []
}

function resolveDisplayCopy(preset = {}) {
  const fallback = DEFAULT_COPY[preset.entryKey] || DEFAULT_COPY['garden-orange']
  const presetLines = resolveStoryLines(preset)
  const titleFromPreset =
    String(preset.displayTitle || '').trim() ||
    [preset.artworkAuthor, stripArtworkText(preset.artworkName)].filter(Boolean).join('-')

  return {
    title: titleFromPreset || fallback.title,
    descriptionLines: presetLines.length ? presetLines : fallback.descriptionLines
  }
}

Page({
  data: {
    heroImage: '',
    hintText: '上滑挂进自己家',
    swipeOffset: 0,
    entering: false,
    displayTitle: '',
    descriptionLines: []
  },

  onLoad(options) {
    this.touchStartY = 0
    this.touchDeltaY = 0
    this.entryPreset = resolveEntryPreset(options)
    const displayCopy = resolveDisplayCopy(this.entryPreset)

    this.setData({
      heroImage: normalizeRemoteAsset(app.globalData.serverUrl, this.entryPreset.heroImagePath),
      hintText: this.entryPreset.hintText || '上滑挂进自己家',
      displayTitle: displayCopy.title,
      descriptionLines: displayCopy.descriptionLines
    })
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
      swipeOffset: Math.min(88, Math.floor(delta * 0.36))
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
