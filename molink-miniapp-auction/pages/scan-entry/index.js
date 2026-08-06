const app = getApp()
const { request, trackClientEvent } = require('../../utils/helper')
const { normalizeArtwork } = require('../../utils/artwork')

const DEFAULT_ARTWORK_REF = 'AW-2604-0001'
const DEFAULT_SERVICE = 'hang_in_home'
const RELEASE_THRESHOLD = 90
const MAX_SWIPE_OFFSET = 72
const HOME_URL = '/pages/index/index'
const MOTION_CYCLE_MS = 9000
const MOTION_FRAME_MS = 1000 / 30
const SENSOR_BOOT_TIMEOUT_MS = 420
const SENSOR_STALE_TIMEOUT_MS = 1200
const SENSOR_WATCHDOG_MS = 360
const SENSOR_RENDER_FRAME_MS = 1000 / 30
const SENSOR_MAX_GAMMA = 16
const SENSOR_TRANSLATE_EPSILON = 0.18
const SENSOR_SMOOTHING_ALPHA = 0.2
const SENSOR_SNAP_EPSILON = 0.22
const SENSOR_EDGE_ZONE_RATIO = 0.055
const SENSOR_EDGE_RESISTANCE_POWER = 3.2
const HERO_VERTICAL_PADDING_PX = 16
const SENSOR_MAX_BETA = 12
const SENSOR_VERTICAL_RANGE_PX = 18
const SENSOR_VERTICAL_SMOOTHING_ALPHA = 0.14
const PERIODIC_VERTICAL_RANGE_PX = 5
const SENSOR_BASELINE_BETA_SAMPLE_COUNT = 6
const SENSOR_PERIODIC_VERTICAL_RANGE_PX = 1.4
const SENSOR_PERIODIC_VERTICAL_CYCLE_MS = 4200

Page({
  touchStartY: 0,
  touchDeltaY: 0,
  heroMotionTimer: null,
  heroMotionStartAt: 0,
  lastHeroTranslateX: null,
  lastHeroTranslateY: null,
  sensorFallbackTimer: null,
  sensorWatchdogTimer: null,
  sensorRenderTimer: null,
  sensorMotionActive: false,
  sensorListenerAttached: false,
  sensorLastEventAt: 0,
  sensorTargetTranslateX: 0,
  sensorCurrentTranslateX: 0,
  sensorTargetTranslateY: 0,
  sensorCurrentTranslateY: 0,
  sensorBaselineBeta: null,
  sensorBaselineBetaSamples: [],
  sensorPeriodicStartAt: 0,
  deviceMotionHandler: null,

  data: {
    artworkRef: DEFAULT_ARTWORK_REF,
    artworkId: '',
    artworkCode: DEFAULT_ARTWORK_REF,
    scanToken: '',
    exhibitionId: '',
    exhibitionName: '',
    exhibitionStatus: '',
    canOrder: true,
    orderDisabledMessage: '',
    service: DEFAULT_SERVICE,
    loading: true,
    heroImage: '',
    heroDisplayWidth: 0,
    heroDisplayHeight: 0,
    heroTrackTop: 0,
    heroTranslateX: 0,
    heroTranslateY: 0,
    heroBaseOffsetX: 0,
    heroTravelPx: 0,
    heroMotionEnabled: false,
    heroImageReady: false,
    heroImageVisible: false,
    artworkTitle: '',
    artworkAuthor: '',
    artworkSizeText: '',
    artworkFrameSizeText: '',
    swipeOffset: 0,
    entering: false,
    errorText: '',
    selectionMethod: 'scan_entry_qr'
  },

  onLoad(options) {
    this.touchStartY = 0
    this.touchDeltaY = 0
    this.stopHeroMotion()

    const viewport = getViewportInfo()
    const artworkRef = resolveArtworkRefFromOptions(options)
    const scanToken = resolveScanTokenFromOptions(options)
    const service = resolveServiceFromOptions(options)
    const selectionMethod = resolveSelectionMethod(options)

    this.setData({
      artworkRef,
      artworkCode: artworkRef,
      scanToken,
      service,
      selectionMethod,
      heroDisplayWidth: viewport.windowWidth,
      heroDisplayHeight: viewport.windowHeight,
      heroTrackTop: 0,
      heroTranslateX: 0,
      heroTranslateY: 0,
      heroBaseOffsetX: 0,
      heroTravelPx: 0,
      heroMotionEnabled: false,
      heroImageReady: false,
      heroImageVisible: false
    })

    if (!artworkRef && !scanToken) {
      this.redirectHome()
      return
    }

    this.loadArtwork(artworkRef, scanToken)
  },

  onShow() {
    if (this.data.heroMotionEnabled) {
      this.startHeroMotion()
    }
  },

  onHide() {
    this.stopHeroMotion()
  },

  onUnload() {
    this.stopHeroMotion()
  },

  async loadArtwork(artworkRef, scanToken = '') {
    this.stopHeroMotion()
    this.lastHeroTranslateX = null
    this.lastHeroTranslateY = null
    this.setData({
      loading: true,
      errorText: '',
      heroImage: '',
      heroImageReady: false,
      heroImageVisible: false,
      artworkTitle: '',
      artworkAuthor: '',
      artworkSizeText: '',
      artworkFrameSizeText: '',
      heroTranslateX: 0,
      heroTranslateY: 0,
      heroTrackTop: 0,
      heroBaseOffsetX: 0,
      heroTravelPx: 0,
      heroMotionEnabled: false
    })

    try {
      const resolveQuery = scanToken
        ? `token=${encodeURIComponent(scanToken)}`
        : `code=${encodeURIComponent(artworkRef)}`
      const res = await request(
        `${app.globalData.serverUrl}/api/client/artworks/resolve?${resolveQuery}`,
        'GET',
        null
      )
      const matched = res && res.artwork ? normalizeArtwork(app.globalData.serverUrl, res.artwork) : null
      const heroImage = resolveHeroImage(matched)

      if (!matched || !heroImage) {
        this.redirectHome()
        return
      }

      const exhibition = {
        id: res.exhibition_id || matched.exhibition_id || '',
        name: res.exhibition_name || matched.exhibition_name || '',
        status: res.exhibition_status || matched.exhibition_status || '',
        collection_advisor_name: res.collection_advisor_name || matched.exhibition_collection_advisor_name || '',
        collection_advisor_wechat: res.collection_advisor_wechat || matched.exhibition_collection_advisor_wechat || ''
      }
      if (exhibition.id) app.setCurrentExhibition(exhibition)

      const canOrder = res.can_order !== false && matched.can_order !== false
      const artworkInfo = buildArtworkInfo(matched)
      this.setData({
        loading: true,
        artworkId: matched.id || '',
        artworkCode: matched.artwork_code || artworkRef,
        scanToken: matched.scan_token || scanToken || '',
        exhibitionId: exhibition.id,
        exhibitionName: exhibition.name,
        exhibitionStatus: exhibition.status,
        canOrder,
        orderDisabledMessage: res.order_disabled_message || matched.order_disabled_message || '',
        heroImage,
        ...artworkInfo
      })

      trackClientEvent('scan_entry_view', {
        page_name: 'scan_entry',
        service_type: this.data.service,
        entry_source: 'scan_qr',
        artwork_id: matched.id || '',
        artwork_code: matched.artwork_code || artworkRef,
        exhibition_id: exhibition.id,
        artwork_selection_method: this.data.selectionMethod || 'scan_entry_qr'
      })
    } catch (error) {
      this.redirectHome()
    }
  },

  onHeroImageLoad(event) {
    const imageWidth = Number(event.detail && event.detail.width)
    const imageHeight = Number(event.detail && event.detail.height)
    this.applyHeroLayout(imageWidth, imageHeight)
  },

  onHeroImageError() {
    const viewport = getViewportInfo()
    this.stopHeroMotion()
    this.lastHeroTranslateX = null
    this.lastHeroTranslateY = null
    this.setData({
      loading: true,
      errorText: '装饰效果图加载失败，请稍后重试',
      heroDisplayWidth: viewport.windowWidth,
      heroDisplayHeight: viewport.windowHeight,
      heroTrackTop: 0,
      heroTranslateX: 0,
      heroTranslateY: 0,
      heroBaseOffsetX: 0,
      heroTravelPx: 0,
      heroMotionEnabled: false,
      heroImageReady: false,
      heroImageVisible: false
    })
  },

  applyHeroLayout(imageWidth, imageHeight) {
    const viewport = getViewportInfo()
    const safeImageWidth = imageWidth > 0 ? imageWidth : viewport.windowWidth
    const safeImageHeight = imageHeight > 0 ? imageHeight : viewport.windowHeight
    const displayHeight = viewport.windowHeight + HERO_VERTICAL_PADDING_PX * 2
    const aspectRatio = safeImageWidth / safeImageHeight
    const displayWidth = Math.max(1, displayHeight * aspectRatio)
    const overflowPx = Math.max(0, displayWidth - viewport.windowWidth)
    const baseOffsetX = overflowPx > 0 ? 0 : (viewport.windowWidth - displayWidth) / 2

    this.stopHeroMotion()
    this.lastHeroTranslateX = null
    this.lastHeroTranslateY = null

    this.setData({
      heroDisplayWidth: Number(displayWidth.toFixed(2)),
      heroDisplayHeight: Number(displayHeight.toFixed(2)),
      heroTrackTop: -HERO_VERTICAL_PADDING_PX,
      heroTranslateX: Number(baseOffsetX.toFixed(2)),
      heroTranslateY: 0,
      heroBaseOffsetX: Number(baseOffsetX.toFixed(2)),
      heroTravelPx: Number(overflowPx.toFixed(2)),
      heroMotionEnabled: true,
      heroImageReady: true
    })

    this.startHeroMotion()
    setTimeout(() => {
      if (!this.data.heroImageReady) return
      this.setData({
        loading: false,
        heroImageVisible: true
      })
    }, 180)
  },

  startHeroMotion() {
    if (!this.data.heroMotionEnabled) return

    this.stopHeroMotion()

    if (this.startSensorMotion()) {
      return
    }

    this.startPeriodicHeroMotion()
  },

  startPeriodicHeroMotion() {
    if (!this.data.heroMotionEnabled) return

    this.heroMotionStartAt = Date.now()
    this.updatePeriodicHeroMotionFrame(true)
    this.heroMotionTimer = setInterval(() => {
      this.updatePeriodicHeroMotionFrame(false)
    }, MOTION_FRAME_MS)
  },

  startSensorMotion() {
    if (typeof wx.startDeviceMotionListening !== 'function' || typeof wx.onDeviceMotionChange !== 'function') {
      return false
    }

    this.sensorMotionActive = false
    this.sensorLastEventAt = 0
    this.resetSensorVerticalBaseline()

    if (!this.deviceMotionHandler) {
      this.deviceMotionHandler = (event = {}) => {
        const gamma = Number(event.gamma)
        const beta = Number(event.beta)
        const hasGamma = Number.isFinite(gamma)
        const hasBeta = Number.isFinite(beta)
        if (!hasGamma && !hasBeta) return

        this.sensorMotionActive = true
        this.sensorLastEventAt = Date.now()

        if (this.sensorFallbackTimer) {
          clearTimeout(this.sensorFallbackTimer)
          this.sensorFallbackTimer = null
        }

        const travel = Number(this.data.heroTravelPx || 0)
        if (hasGamma && travel > 0) {
          const maxGamma = SENSOR_MAX_GAMMA
          const clampedGamma = Math.max(-maxGamma, Math.min(maxGamma, gamma))
          const rawProgress = (clampedGamma + maxGamma) / (maxGamma * 2)
          const progress = applyEdgeResistance(rawProgress)
          this.sensorTargetTranslateX = this.data.heroBaseOffsetX - travel * progress
        }

        if (hasBeta) {
          const betaDelta = this.resolveSensorBetaDelta(beta)
          const maxBeta = SENSOR_MAX_BETA
          const clampedBetaDelta = Math.max(-maxBeta, Math.min(maxBeta, betaDelta))
          this.sensorTargetTranslateY = Number((-clampedBetaDelta / maxBeta * SENSOR_VERTICAL_RANGE_PX).toFixed(2))
        }
      }
    }

    try {
      if (!this.sensorListenerAttached) {
        wx.onDeviceMotionChange(this.deviceMotionHandler)
        this.sensorListenerAttached = true
      }
      wx.startDeviceMotionListening({
        interval: 'ui',
        success: () => {},
        fail: () => {
          this.stopSensorMotion()
          this.startPeriodicHeroMotion()
        }
      })
    } catch (error) {
      this.stopSensorMotion()
      return false
    }

    const initialTranslateX = Number(this.data.heroTranslateX || this.data.heroBaseOffsetX || 0)
    const initialTranslateY = Number(this.data.heroTranslateY || 0)
    this.sensorCurrentTranslateX = initialTranslateX
    this.sensorTargetTranslateX = initialTranslateX
    this.sensorCurrentTranslateY = initialTranslateY
    this.sensorTargetTranslateY = initialTranslateY
    this.lastHeroTranslateX = initialTranslateX
    this.lastHeroTranslateY = initialTranslateY
    this.sensorPeriodicStartAt = Date.now()

    this.sensorRenderTimer = setInterval(() => {
      this.renderSensorHeroMotionFrame()
    }, SENSOR_RENDER_FRAME_MS)

    this.sensorFallbackTimer = setTimeout(() => {
      if (!this.sensorMotionActive) {
        this.stopSensorMotion()
        this.startPeriodicHeroMotion()
      }
    }, SENSOR_BOOT_TIMEOUT_MS)

    this.sensorWatchdogTimer = setInterval(() => {
      if (!this.sensorMotionActive) return
      if (Date.now() - this.sensorLastEventAt <= SENSOR_STALE_TIMEOUT_MS) return
      this.stopSensorMotion()
      this.startPeriodicHeroMotion()
    }, SENSOR_WATCHDOG_MS)

    return true
  },

  stopHeroMotion() {
    this.stopSensorMotion()
    this.stopPeriodicHeroMotion()
  },

  stopPeriodicHeroMotion() {
    if (this.heroMotionTimer) {
      clearInterval(this.heroMotionTimer)
      this.heroMotionTimer = null
    }
  },

  stopSensorMotion() {
    if (this.sensorFallbackTimer) {
      clearTimeout(this.sensorFallbackTimer)
      this.sensorFallbackTimer = null
    }

    if (this.sensorWatchdogTimer) {
      clearInterval(this.sensorWatchdogTimer)
      this.sensorWatchdogTimer = null
    }

    if (this.sensorRenderTimer) {
      clearInterval(this.sensorRenderTimer)
      this.sensorRenderTimer = null
    }

    if (this.sensorListenerAttached && this.deviceMotionHandler) {
      if (typeof wx.offDeviceMotionChange === 'function') {
        wx.offDeviceMotionChange(this.deviceMotionHandler)
      }
      this.sensorListenerAttached = false
    }

    if (typeof wx.stopDeviceMotionListening === 'function') {
      try {
        wx.stopDeviceMotionListening()
      } catch (error) {}
    }

    this.sensorMotionActive = false
    this.sensorLastEventAt = 0
    this.resetSensorVerticalBaseline()
    this.sensorPeriodicStartAt = 0
    this.sensorTargetTranslateX = Number(this.data.heroTranslateX || this.data.heroBaseOffsetX || 0)
    this.sensorCurrentTranslateX = Number(this.data.heroTranslateX || this.data.heroBaseOffsetX || 0)
    this.sensorTargetTranslateY = Number(this.data.heroTranslateY || 0)
    this.sensorCurrentTranslateY = Number(this.data.heroTranslateY || 0)
  },

  resetSensorVerticalBaseline() {
    this.sensorBaselineBeta = null
    this.sensorBaselineBetaSamples = []
  },

  resolveSensorBetaDelta(beta) {
    const normalizedBeta = Number(beta)
    if (!Number.isFinite(normalizedBeta)) return 0

    if (this.sensorBaselineBeta === null) {
      this.sensorBaselineBetaSamples.push(normalizedBeta)
      const sampleCount = this.sensorBaselineBetaSamples.length
      const sampleSum = this.sensorBaselineBetaSamples.reduce((sum, sample) => sum + sample, 0)
      const currentBaseline = sampleSum / sampleCount

      if (sampleCount >= SENSOR_BASELINE_BETA_SAMPLE_COUNT) {
        this.sensorBaselineBeta = currentBaseline
        this.sensorBaselineBetaSamples = []
      }

      return 0
    }

    return normalizedBeta - this.sensorBaselineBeta
  },

  getSensorPeriodicTranslateY() {
    if (!this.sensorPeriodicStartAt) return 0
    const elapsed = (Date.now() - this.sensorPeriodicStartAt) % SENSOR_PERIODIC_VERTICAL_CYCLE_MS
    const phase = elapsed / SENSOR_PERIODIC_VERTICAL_CYCLE_MS
    return Math.sin(Math.PI * 2 * phase + Math.PI / 5) * SENSOR_PERIODIC_VERTICAL_RANGE_PX
  },

  renderSensorHeroMotionFrame() {
    const travel = Number(this.data.heroTravelPx || 0)
    const minX = this.data.heroBaseOffsetX - Math.max(0, travel)
    const maxX = this.data.heroBaseOffsetX
    const targetYWithPeriodicFeedback = this.sensorTargetTranslateY + this.getSensorPeriodicTranslateY()
    const deltaX = this.sensorTargetTranslateX - this.sensorCurrentTranslateX
    const deltaY = targetYWithPeriodicFeedback - this.sensorCurrentTranslateY

    if (Math.abs(deltaX) <= SENSOR_SNAP_EPSILON) {
      this.sensorCurrentTranslateX = this.sensorTargetTranslateX
    } else {
      this.sensorCurrentTranslateX += deltaX * SENSOR_SMOOTHING_ALPHA
    }

    if (Math.abs(deltaY) <= SENSOR_SNAP_EPSILON) {
      this.sensorCurrentTranslateY = targetYWithPeriodicFeedback
    } else {
      this.sensorCurrentTranslateY += deltaY * SENSOR_VERTICAL_SMOOTHING_ALPHA
    }

    const nextX = Math.max(minX, Math.min(maxX, this.sensorCurrentTranslateX))
    const nextY = Math.max(-SENSOR_VERTICAL_RANGE_PX, Math.min(SENSOR_VERTICAL_RANGE_PX, this.sensorCurrentTranslateY))
    const xUnchanged = this.lastHeroTranslateX !== null && Math.abs(nextX - this.lastHeroTranslateX) < SENSOR_TRANSLATE_EPSILON
    const yUnchanged = this.lastHeroTranslateY !== null && Math.abs(nextY - this.lastHeroTranslateY) < SENSOR_TRANSLATE_EPSILON
    if (xUnchanged && yUnchanged) return

    this.sensorCurrentTranslateX = nextX
    this.sensorCurrentTranslateY = nextY
    this.lastHeroTranslateX = nextX
    this.lastHeroTranslateY = nextY
    this.setData({
      heroTranslateX: Number(nextX.toFixed(2)),
      heroTranslateY: Number(nextY.toFixed(2))
    })
  },

  updatePeriodicHeroMotionFrame(forceUpdate = false) {
    const travel = Number(this.data.heroTravelPx || 0)
    const elapsed = (Date.now() - this.heroMotionStartAt) % MOTION_CYCLE_MS
    const phase = elapsed / MOTION_CYCLE_MS
    const dampingProgress = 0.5 - 0.5 * Math.cos(Math.PI * 2 * phase)
    const nextX = travel > 0
      ? this.data.heroBaseOffsetX - travel * dampingProgress
      : this.data.heroBaseOffsetX
    const nextY = Math.sin(Math.PI * 2 * phase + Math.PI / 3) * PERIODIC_VERTICAL_RANGE_PX

    const xUnchanged = this.lastHeroTranslateX !== null && Math.abs(nextX - this.lastHeroTranslateX) < 0.4
    const yUnchanged = this.lastHeroTranslateY !== null && Math.abs(nextY - this.lastHeroTranslateY) < 0.22
    if (!forceUpdate && xUnchanged && yUnchanged) return

    this.lastHeroTranslateX = nextX
    this.lastHeroTranslateY = nextY
    this.setData({
      heroTranslateX: Number(nextX.toFixed(2)),
      heroTranslateY: Number(nextY.toFixed(2))
    })
  },

  onTouchStart(event) {
    if (this.data.entering || !this.data.heroImageVisible) return
    const point = event.touches && event.touches[0]
    if (!point) return
    this.touchStartY = point.clientY
    this.touchDeltaY = 0
  },

  onTouchMove(event) {
    if (this.data.entering || !this.data.heroImageVisible) return
    const point = event.touches && event.touches[0]
    if (!point) return

    const delta = Math.max(0, this.touchStartY - point.clientY)
    this.touchDeltaY = delta
    this.setData({
      swipeOffset: Math.min(MAX_SWIPE_OFFSET, Math.floor(delta * 0.35))
    })
  },

  onTouchEnd() {
    if (this.data.entering || !this.data.heroImageVisible) return
    const shouldEnter = this.touchDeltaY >= RELEASE_THRESHOLD
    this.touchDeltaY = 0
    this.setData({ swipeOffset: 0 })
    if (shouldEnter) {
      this.enterUpload()
    }
  },

  onTouchCancel() {
    if (this.data.entering || !this.data.heroImageVisible) return
    this.touchDeltaY = 0
    this.setData({ swipeOffset: 0 })
  },

  enterUpload() {
    if (this.data.entering || !this.data.heroImageVisible) return
    if (!this.data.canOrder) {
      wx.showToast({ title: this.data.orderDisabledMessage || '该展览已结束，暂不支持在线下单', icon: 'none' })
      return
    }
    this.setData({ entering: true })
    trackClientEvent('scan_enter_upload', {
      page_name: 'scan_entry',
      service_type: this.data.service,
      entry_source: 'scan_qr',
      artwork_id: this.data.artworkId || '',
      artwork_code: this.data.artworkCode || this.data.artworkRef,
      exhibition_id: this.data.exhibitionId || '',
      artwork_selection_method: this.data.selectionMethod || 'scan_entry_qr'
    })
    wx.redirectTo({
      url: this.buildNextPageUrl(),
      complete: () => {
        this.setData({ entering: false, swipeOffset: 0 })
      }
    })
  },

  buildNextPageUrl() {
    const artworkRef = encodeURIComponent(this.data.artworkCode || this.data.artworkRef)
    const artworkId = encodeURIComponent(this.data.artworkId || '')
    const exhibitionId = encodeURIComponent(this.data.exhibitionId || '')
    const service = encodeURIComponent(this.data.service || DEFAULT_SERVICE)
    const method = encodeURIComponent(this.data.selectionMethod || 'scan_entry_qr')
    return `/pages/upload/upload?service=${service}&artworkCode=${artworkRef}&artworkId=${artworkId}&exhibition_id=${exhibitionId}&selection_method=${method}`
  },

  redirectHome() {
    wx.reLaunch({ url: HOME_URL })
  }
})

function buildArtworkInfo(artwork = {}) {
  return {
    artworkTitle: String(artwork.name || artwork.title || '').trim(),
    artworkAuthor: String(artwork.author || artwork.artist || '').trim(),
    artworkSizeText: String(artwork.display_size || artwork.size_text || artwork.size || '').trim(),
    artworkFrameSizeText: String(artwork.display_frame_size || artwork.frame_size_text || '').trim()
  }
}

function resolveHeroImage(artwork) {
  if (!artwork) return ''
  if (Array.isArray(artwork.effect_images) && artwork.effect_images[0]) return artwork.effect_images[0]
  if (Array.isArray(artwork.effect_assets) && artwork.effect_assets[0] && artwork.effect_assets[0].url) return artwork.effect_assets[0].url
  return ''
}

function resolveArtworkRefFromOptions(options = {}) {
  const sceneMap = parseSceneMap(options.scene)
  const direct = [
    options.artworkCode,
    options.artwork_code,
    sceneMap.artworkCode,
    sceneMap.artwork_code,
    sceneMap.code,
    sceneMap.artworkRef,
    sceneMap.artwork_ref,
    sceneMap.id,
    options.artworkRef,
    options.artwork_ref
  ].find(Boolean)

  return direct ? String(direct).trim() : ''
}


function resolveScanTokenFromOptions(options = {}) {
  const sceneMap = parseSceneMap(options.scene)
  const direct = [
    options.token,
    options.t,
    options.scan_token,
    sceneMap.token,
    sceneMap.t,
    sceneMap.scan_token
  ].find(Boolean)
  return direct ? String(direct).trim() : ''
}

function resolveSelectionMethod(options = {}) {
  return String(options.selection_method || options.artwork_selection_method || 'scan_entry_qr').trim() || 'scan_entry_qr'
}

function resolveServiceFromOptions(options = {}) {
  const sceneMap = parseSceneMap(options.scene)
  return options.service || sceneMap.service || DEFAULT_SERVICE
}

function parseSceneMap(scene) {
  const raw = safeDecode(scene)
  if (!raw) return {}

  if (!raw.includes('=') && !raw.includes('&')) {
    return { artworkCode: raw }
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

function applyEdgeResistance(progress) {
  const safeProgress = Math.max(0, Math.min(1, Number(progress) || 0))
  const edgeZone = SENSOR_EDGE_ZONE_RATIO

  if (edgeZone <= 0 || edgeZone >= 0.5) return safeProgress

  if (safeProgress < edgeZone) {
    const ratio = safeProgress / edgeZone
    return edgeZone * Math.pow(ratio, SENSOR_EDGE_RESISTANCE_POWER)
  }

  if (safeProgress > 1 - edgeZone) {
    const ratio = (1 - safeProgress) / edgeZone
    return 1 - edgeZone * Math.pow(ratio, SENSOR_EDGE_RESISTANCE_POWER)
  }

  return safeProgress
}

function getViewportInfo() {
  if (typeof wx.getWindowInfo === 'function') {
    return wx.getWindowInfo()
  }
  return wx.getSystemInfoSync()
}
