const app = getApp()
const { request } = require('../../utils/helper')

const DEFAULT_ARTWORK_NUM = '38'
const DEFAULT_SERVICE = 'hang_in_home'
const MAX_SWIPE = 320
const RELEASE_THRESHOLD = 92
const EXIT_OFFSET = 460

const FIG_COPY_MAP = {
  '38': {
    title: '施歌-花园系列',
    lines: [
      '揉秋色于画布',
      '捕捉一场植物的白日梦',
      '它是色彩的引力',
      '让散落的日常',
      '在墙上重组为流动的森林'
    ]
  }
}

Page({
  touchStartY: 0,
  touchStartX: 0,
  gestureLocked: '',
  navigating: false,

  data: {
    artworkNum: DEFAULT_ARTWORK_NUM,
    service: DEFAULT_SERVICE,
    loading: true,
    heroImage: '',
    errorText: '',
    artwork: null,
    artTitle: FIG_COPY_MAP[DEFAULT_ARTWORK_NUM].title,
    artLines: FIG_COPY_MAP[DEFAULT_ARTWORK_NUM].lines,
    swipeOffset: 0,
    swipeProgress: 0,
    currentLayerStyle: '',
    previewLayerStyle: '',
    hintStyle: ''
  },

  onLoad(options) {
    const artworkNum = resolveArtworkNumFromOptions(options)
    const service = resolveServiceFromOptions(options)
    const figCopy = resolveArtworkCopy(artworkNum)

    this.setData({
      artworkNum,
      service,
      artTitle: figCopy.title,
      artLines: figCopy.lines
    })

    this.applySwipeState(0)
    this.loadArtwork(artworkNum)
  },

  async loadArtwork(artworkNum) {
    this.setData({ loading: true, errorText: '' })

    try {
      const res = await request(`${app.globalData.serverUrl}/api/client/artworks`, 'GET', null)
      const list = Array.isArray(res && res.artworks) ? res.artworks.map(item => normalizeArtwork(item)) : []
      const matched = findArtworkByNum(list, artworkNum)

      if (!matched) {
        this.setData({
          loading: false,
          errorText: `未找到编号 ${artworkNum} 的作品`
        })
        return
      }

      this.setData({
        loading: false,
        artwork: matched,
        heroImage: matched.images && matched.images[0] ? matched.images[0] : ''
      })
    } catch (error) {
      this.setData({
        loading: false,
        errorText: '作品信息加载失败，请稍后重试'
      })
    }
  },

  onTouchStart(event) {
    if (this.navigating) return
    const point = event.touches && event.touches[0]
    if (!point) return
    this.touchStartY = point.clientY
    this.touchStartX = point.clientX
    this.gestureLocked = ''
  },

  onTouchMove(event) {
    if (this.navigating) return
    const point = event.touches && event.touches[0]
    if (!point) return

    const deltaY = point.clientY - this.touchStartY
    const deltaX = point.clientX - this.touchStartX

    if (!this.gestureLocked) {
      if (Math.abs(deltaY) < 6 && Math.abs(deltaX) < 6) return
      this.gestureLocked = Math.abs(deltaY) >= Math.abs(deltaX) ? 'y' : 'x'
    }

    if (this.gestureLocked !== 'y') return

    if (deltaY >= 0) {
      this.applySwipeState(0, { dragging: true })
      return
    }

    const offset = Math.min(MAX_SWIPE, Math.abs(deltaY))
    this.applySwipeState(offset, { dragging: true })
  },

  onTouchEnd() {
    if (this.navigating) return

    if (this.data.loading) {
      this.applySwipeState(0, { dragging: false })
      return
    }

    if (this.data.swipeOffset >= RELEASE_THRESHOLD) {
      this.triggerExit()
      return
    }

    this.applySwipeState(0, { dragging: false })
  },

  onTouchCancel() {
    if (this.navigating) return
    this.applySwipeState(0, { dragging: false })
  },

  goNext() {
    if (this.navigating || this.data.loading) return
    this.triggerExit()
  },

  triggerExit() {
    if (this.navigating) return
    this.navigating = true
    this.applySwipeState(EXIT_OFFSET, { dragging: false, exiting: true })

    setTimeout(() => {
      wx.redirectTo({
        url: this.buildNextPageUrl(),
        fail: () => {
          this.navigating = false
          this.applySwipeState(0, { dragging: false })
        }
      })
    }, 260)
  },

  buildNextPageUrl() {
    const artworkNum = encodeURIComponent(this.data.artworkNum)
    const service = encodeURIComponent(this.data.service || DEFAULT_SERVICE)
    return `/pages/upload/upload?service=${service}&artworkNum=${artworkNum}`
  },

  applySwipeState(offset, options = {}) {
    const progress = Math.min(1, Math.max(0, offset / MAX_SWIPE))
    const dragging = !!options.dragging
    const transition = dragging
      ? 'none'
      : 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 260ms ease'

    const currentOpacity = Math.max(0.03, 1 - progress * 0.98)
    const previewOpacity = Math.min(1, 0.16 + progress * 0.9)
    const previewTranslate = 38 - progress * 38
    const previewScale = 0.968 + progress * 0.032
    const hintOpacity = Math.max(0, 1 - progress * 1.35)
    const hintTranslate = -progress * 8

    this.setData({
      swipeOffset: offset,
      swipeProgress: progress,
      currentLayerStyle: [
        `transform: translate3d(0, -${offset}px, 0)`,
        `opacity: ${currentOpacity.toFixed(3)}`,
        `transition: ${transition}`
      ].join(';'),
      previewLayerStyle: [
        `opacity: ${previewOpacity.toFixed(3)}`,
        `transform: translate3d(0, ${previewTranslate.toFixed(1)}px, 0) scale(${previewScale.toFixed(3)})`,
        `transition: ${transition}`
      ].join(';'),
      hintStyle: [
        `opacity: ${hintOpacity.toFixed(3)}`,
        `transform: translate3d(0, ${hintTranslate.toFixed(1)}px, 0)`,
        `transition: ${transition}`
      ].join(';')
    })
  }
})

function normalizeArtwork(artwork) {
  const serverUrl = app.globalData.serverUrl
  const images = Array.isArray(artwork.images)
    ? artwork.images.map(item => {
        if (!item) return ''
        return item.startsWith('http')
          ? item
          : `${serverUrl}${item.startsWith('/') ? '' : '/'}${item}`
      })
    : []

  return Object.assign({}, artwork, { images })
}

function findArtworkByNum(list, artworkNum) {
  const target = String(artworkNum || '').trim()
  if (!target) return null

  return list.find(item => {
    return [item.num, item.id, item.code, item.qrCode, item.qrcode]
      .filter(Boolean)
      .map(value => String(value).trim())
      .includes(target)
  }) || null
}

function resolveArtworkCopy(artworkNum) {
  return FIG_COPY_MAP[String(artworkNum)] || {
    title: '作品详情',
    lines: ['上滑挂进自己家']
  }
}

function resolveArtworkNumFromOptions(options = {}) {
  const sceneMap = parseSceneMap(options.scene)
  const direct = [
    options.artworkNum,
    options.artwork_num,
    sceneMap.artworkNum,
    sceneMap.artwork_num,
    sceneMap.num,
    sceneMap.id
  ].find(Boolean)

  if (direct) return String(direct).trim()
  if (options.scene && /^\d+$/.test(String(options.scene))) return String(options.scene).trim()
  return DEFAULT_ARTWORK_NUM
}

function resolveServiceFromOptions(options = {}) {
  const sceneMap = parseSceneMap(options.scene)
  return options.service || sceneMap.service || DEFAULT_SERVICE
}

function parseSceneMap(scene) {
  const raw = safeDecode(scene)
  if (!raw) return {}

  if (!raw.includes('=') && !raw.includes('&')) {
    return { artworkNum: raw }
  }

  return raw.split('&').reduce((accumulator, pair) => {
    const [key, value] = pair.split('=')
    if (key) {
      accumulator[key] = value ? safeDecode(value) : ''
    }
    return accumulator
  }, {})
}

function safeDecode(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (error) {
    return value
  }
}
