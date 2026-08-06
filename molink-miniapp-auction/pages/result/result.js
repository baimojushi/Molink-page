const app = getApp()
const { request, formatTime, trackClientEvent } = require('../../utils/helper')
const { viewerData, viewerMethods, buildBezierMotionFrames, clamp, rounded } = require('../../utils/fullscreenViewer')
const { normalizeThinkingPayload, refreshCandidateStates } = require('../../utils/wallPreference')

const FOCUS_GOLDEN_POINTS = [[0.382, 0.382], [0.618, 0.382], [0.382, 0.618], [0.618, 0.618]]
const FULL_VIEW_TRANSFORM = 'translate3d(0px, 0px, 0) scale(1)'
const REVEAL_DIRECTIONS = ['reveal-left', 'reveal-right', 'reveal-center', 'reveal-right']
const REVEAL_DELAYS = [0, 120, 45, 170]
const DELIVERY_MOTION_DURATION = 1120
const DELIVERY_MOTION_FRAME_COUNT = 14

function buildViewTransform(x, y, scale) {
  return `translate3d(${rounded(x)}px, ${rounded(y)}px, 0) scale(${rounded(scale, 4)})`
}

function normalizeArtworkBBox(value) {
  const raw = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' ? [value.x1, value.y1, value.x2, value.y2] : null)
  if (!raw || raw.length < 4) return null
  const box = raw.slice(0, 4).map(Number)
  if (box.some(n => !Number.isFinite(n))) return null
  const x1 = Math.max(0, Math.min(1, Math.min(box[0], box[2])))
  const y1 = Math.max(0, Math.min(1, Math.min(box[1], box[3])))
  const x2 = Math.max(0, Math.min(1, Math.max(box[0], box[2])))
  const y2 = Math.max(0, Math.min(1, Math.max(box[1], box[3])))
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null
}

function calculateFocusLayout(imageWidth, imageHeight, containerWidth, containerHeight, bboxNorm) {
  if (!bboxNorm || !imageWidth || !imageHeight || !containerWidth || !containerHeight) return null
  const [nx1, ny1, nx2, ny2] = bboxNorm
  const artWidth = (nx2 - nx1) * imageWidth
  const artHeight = (ny2 - ny1) * imageHeight
  const artCenterX = (nx1 + nx2) * imageWidth / 2
  const artCenterY = (ny1 + ny2) * imageHeight / 2
  const aspect = containerWidth / containerHeight
  // 保留空间语境，但比旧版更主动地靠近作品，使缩放变化更容易被感知。
  const targetArea = artWidth * artHeight * 20
  let cropWidth = Math.sqrt(targetArea * aspect)
  cropWidth = Math.max(cropWidth, artWidth * 1.15, artHeight * 1.15 * aspect)
  const cropHeight = cropWidth / aspect
  if (cropWidth > imageWidth || cropHeight > imageHeight) return null

  let point = FOCUS_GOLDEN_POINTS[0]
  let bestDistance = Infinity
  FOCUS_GOLDEN_POINTS.forEach(candidate => {
    const dx = artCenterX / imageWidth - candidate[0]
    const dy = artCenterY / imageHeight - candidate[1]
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      bestDistance = distance
      point = candidate
    }
  })
  const cropX = Math.max(0, Math.min(imageWidth - cropWidth, artCenterX - point[0] * cropWidth))
  const cropY = Math.max(0, Math.min(imageHeight - cropHeight, artCenterY - point[1] * cropHeight))
  const scale0 = Math.min(containerWidth / imageWidth, containerHeight / imageHeight)
  const zoom = Math.min(2.35, containerWidth / (cropWidth * scale0), containerHeight / (cropHeight * scale0))
  if (!Number.isFinite(zoom) || zoom <= 1.001) return null
  const baseWidth = imageWidth * scale0
  const baseHeight = imageHeight * scale0
  const cropCenterScreenX = (containerWidth - baseWidth) / 2 + (cropX + cropWidth / 2) * scale0
  const cropCenterScreenY = (containerHeight - baseHeight) / 2 + (cropY + cropHeight / 2) * scale0
  const translateX = -zoom * (cropCenterScreenX - containerWidth / 2)
  const translateY = -zoom * (cropCenterScreenY - containerHeight / 2)
  return {
    layoutStyle: `width:${baseWidth}px;height:${baseHeight}px;left:${(containerWidth - baseWidth) / 2}px;top:${(containerHeight - baseHeight) / 2}px`,
    focusX: translateX,
    focusY: translateY,
    focusScale: zoom,
    focusTransform: buildViewTransform(translateX, translateY, zoom)
  }
}

Page({
  data: Object.assign({
    orderId: '',
    deliveryToken: '',
    deliveryImages: [],
    deliveryImageUrls: [],
    submitTime: '',
    otherDeliveredOrders: [],
    primarySupplementRendering: false,
    wallSupplementPending: false,
    thinkingReady: false,
    thinkingGuideCopy: '',
    wallCandidates: [],
    notRecommendedWalls: [],
    selectedWallIds: [],
    maxWallSelect: 2,
    preferenceSubmitting: false,
    preferenceMessage: '',
    advisorText: '',
    collectionAdvisorName: '',
    collectionAdvisorWechat: ''
  }, viewerData),

  onLoad(options) {
    const orderId = options.orderId || app.globalData.currentOrderId
    if (!orderId) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }

    this.enteredAt = Date.now()
    const primarySupplement = wx.getStorageSync(`primarySupplement:${orderId}`)
    const deliveryToken = options.deliveryToken || wx.getStorageSync(`deliveryToken:${orderId}`) || wx.getStorageSync('lastDeliveryToken') || ''
    const exhibition = app.getCurrentExhibition()
    this.setData({
      orderId,
      deliveryToken,
      primarySupplementRendering: !!primarySupplement,
      collectionAdvisorName: exhibition.collection_advisor_name || '',
      collectionAdvisorWechat: exhibition.collection_advisor_wechat || ''
    })
    this.loadResult()
  },

  onShow() {
    if (!this.enteredAt) this.enteredAt = Date.now()
    if (this.data.primarySupplementRendering || this.data.wallSupplementPending) this.startPrimarySupplementPolling()
  },

  onHide() {
    this.stopPrimarySupplementPolling()
    this.reportStayDuration()
  },

  onUnload() {
    this.stopPrimarySupplementPolling()
    this.clearDeliveryMotionTimers()
    this.reportStayDuration()
  },

  trackEvent(eventType, payload = {}) {
    wx.request({
      url: `${app.globalData.serverUrl}/api/client/order-events`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: Object.assign({
        order_id: this.data.orderId,
        event_type: eventType,
        device_uuid: app.globalData.deviceId || ''
      }, payload),
      fail: () => {}
    })
  },

  reportStayDuration() {
    if (!this.enteredAt || this.stayReported) return
    const stayMs = Date.now() - this.enteredAt
    this.stayReported = true
    this.trackEvent('page_stay', {
      stay_ms: stayMs,
      entered_at: new Date(this.enteredAt).toISOString(),
      left_at: new Date().toISOString(),
      page_name: 'result'
    })
  },

  async loadResult() {
    try {
      const res = await request(`${app.globalData.serverUrl}/api/client/order-status/${this.data.orderId}`, 'GET', null)
      if (!['delivered', 'viewed', 'downloaded'].includes(res.status)) {
        trackClientEvent('result_redirect_waiting', { page_name: 'result', order_id: this.data.orderId, status: res.status || '' })
        wx.redirectTo({ url: `/pages/waiting/waiting?orderId=${this.data.orderId}` })
        return
      }

      const baseUrl = app.globalData.serverUrl
      const imageUrls = Array.isArray(res.imageUrls) && res.imageUrls.length
        ? res.imageUrls
        : (res.images || []).map(file => `${baseUrl}/deliveries/${file}`)
      const resultRecords = Array.isArray(res.resultRecords) ? res.resultRecords : []
      const urlsChanged = imageUrls.length !== this.data.deliveryImageUrls.length ||
        imageUrls.some((url, index) => url !== this.data.deliveryImageUrls[index])
      const nextData = {
        deliveryToken: res.deliveryToken || this.data.deliveryToken,
        submitTime: res.deliveredAt ? formatTime(res.deliveredAt) : '',
        advisorText: String(res.text || res.advisorProgress || res.ai_advisor_progress || '').trim(),
        collectionAdvisorName: String(res.collection_advisor_name || (res.exhibition && res.exhibition.collection_advisor_name) || '').trim(),
        collectionAdvisorWechat: String(res.collection_advisor_wechat || (res.exhibition && res.exhibition.collection_advisor_wechat) || '').trim()
      }
      if (res.exhibition && res.exhibition.id) app.setCurrentExhibition(res.exhibition)
      if (urlsChanged || !this.data.deliveryImages.length) {
        nextData.deliveryImages = imageUrls.map((url, index) => ({
          fullUrl: url,
          displayUrl: url,
          artworkBBoxNorm: normalizeArtworkBBox(resultRecords[index] && (
            (resultRecords[index].install && resultRecords[index].install.artwork_bbox_norm) ||
            resultRecords[index].artwork_bbox_norm
          )),
          hasFocus: false,
          isLoaded: false,
          loadFailed: false,
          motionLocked: false,
          viewState: 'full',
          revealClass: REVEAL_DIRECTIONS[index % REVEAL_DIRECTIONS.length],
          revealDelay: `${REVEAL_DELAYS[index % REVEAL_DELAYS.length]}ms`,
          revealDelayMs: REVEAL_DELAYS[index % REVEAL_DELAYS.length],
          arcSign: index % 2 === 0 ? 1 : -1,
          layoutStyle: 'width:100%;height:100%;left:0;top:0',
          focusX: 0,
          focusY: 0,
          focusScale: 1,
          focusTransform: FULL_VIEW_TRANSFORM,
          animationData: {},
          hint: ''
        }))
        nextData.deliveryImageUrls = imageUrls
      }
      this.setData(nextData)
      if (res.deliveryToken) {
        wx.setStorageSync(`deliveryToken:${this.data.orderId}`, res.deliveryToken)
        wx.setStorageSync('lastDeliveryToken', res.deliveryToken)
      }
      await this.loadThinking(true)

      const supplementStorageKey = `primarySupplement:${this.data.orderId}`
      const structuredStatus = String(res.primary_wall_rerender_status || 'idle')
      const wasTrackingSupplement = this.data.primarySupplementRendering || !!wx.getStorageSync(supplementStorageKey)
      if (structuredStatus === 'pending') {
        if (!this.data.primarySupplementRendering) this.setData({ primarySupplementRendering: true })
        this.startPrimarySupplementPolling()
      } else {
        wx.removeStorageSync(supplementStorageKey)
        if (this.data.primarySupplementRendering) this.setData({ primarySupplementRendering: false })
        if (!this.data.wallSupplementPending) this.stopPrimarySupplementPolling()
        if (wasTrackingSupplement && structuredStatus === 'succeeded') {
          wx.showToast({ title: '主图色彩已更新', icon: 'success' })
        } else if (wasTrackingSupplement && structuredStatus === 'failed') {
          wx.showToast({ title: '色彩优化未通过，已保留原图', icon: 'none', duration: 2600 })
        }
      }

      if (imageUrls.length > 0 && !this.resultViewTracked) {
        this.resultViewTracked = true
        trackClientEvent('result_page_view', {
          page_name: 'result',
          order_id: this.data.orderId,
          image_count: imageUrls.length,
          status: res.status || ''
        })
        wx.removeStorageSync('lastOrderId')
        wx.setStorageSync('lastOrderStatus', 'viewed')
        request(`${app.globalData.serverUrl}/api/client/mark-viewed/${this.data.orderId}`, 'POST', {}).catch(() => {})
        this.checkOtherOrders()
      }
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
    }
  },

  startPrimarySupplementPolling() {
    if (this.primarySupplementPollingTimer || (!this.data.primarySupplementRendering && !this.data.wallSupplementPending)) return
    this.primarySupplementPollingTimer = setInterval(() => this.loadResult(), 5000)
  },

  stopPrimarySupplementPolling() {
    if (!this.primarySupplementPollingTimer) return
    clearInterval(this.primarySupplementPollingTimer)
    this.primarySupplementPollingTimer = null
  },

  rememberDeliveryMotionTimer(timer) {
    if (!this.deliveryMotionTimers) this.deliveryMotionTimers = []
    this.deliveryMotionTimers.push(timer)
    return timer
  },

  scheduleDeliveryMotion(callback, delay) {
    return this.rememberDeliveryMotionTimer(setTimeout(callback, delay))
  },

  clearDeliveryMotionTimers() {
    ;(this.deliveryMotionTimers || []).forEach(timer => clearTimeout(timer))
    this.deliveryMotionTimers = []
  },

  onDeliveryImageLoad(e) {
    const index = Number(e.currentTarget.dataset.index || 0)
    const item = this.data.deliveryImages[index]
    const width = Number(e.detail.width || 0)
    const height = Number(e.detail.height || 0)
    if (!item || !width || !height) return

    wx.createSelectorQuery().in(this).select(`#delivery-image-${index}`).boundingClientRect(rect => {
      if (!rect) return
      const focus = calculateFocusLayout(width, height, rect.width, rect.height, item.artworkBBoxNorm)
      const path = `deliveryImages[${index}]`
      if (!focus) {
        this.setData({
          [`${path}.isLoaded`]: true,
          [`${path}.loadFailed`]: false,
          [`${path}.hasFocus`]: false,
          [`${path}.viewState`]: 'full',
          [`${path}.hint`]: ''
        })
        return
      }

      this.setData({
        [`${path}.isLoaded`]: true,
        [`${path}.loadFailed`]: false,
        [`${path}.hasFocus`]: true,
        [`${path}.viewState`]: 'full',
        [`${path}.layoutStyle`]: focus.layoutStyle,
        [`${path}.focusX`]: focus.focusX,
        [`${path}.focusY`]: focus.focusY,
        [`${path}.focusScale`]: focus.focusScale,
        [`${path}.focusTransform`]: focus.focusTransform,
        [`${path}.animationData`]: {},
        [`${path}.hint`]: ''
      })

      // 揭幕结束后再启动统一的贝塞尔缩放轨迹，避免两组动画叠加造成动作割裂。
      this.scheduleDeliveryMotion(() => {
        this.animateDeliveryImage(index, true, { initial: true })
      }, 940 + Number(item.revealDelayMs || 0))
    }).exec()
  },

  onDeliveryImageError(e) {
    const index = Number(e.currentTarget.dataset.index || 0)
    const path = `deliveryImages[${index}]`
    this.setData({
      [`${path}.isLoaded`]: false,
      [`${path}.loadFailed`]: true,
      [`${path}.motionLocked`]: false
    })
  },

  animateDeliveryImage(index, focus, options = {}) {
    const item = this.data.deliveryImages[index]
    if (!item || !item.hasFocus || item.motionLocked) return false

    const startX = focus ? 0 : Number(item.focusX || 0)
    const startY = focus ? 0 : Number(item.focusY || 0)
    const startScale = focus ? 1 : Number(item.focusScale || 1)
    const endX = focus ? Number(item.focusX || 0) : 0
    const endY = focus ? Number(item.focusY || 0) : 0
    const endScale = focus ? Number(item.focusScale || 1) : 1
    const direction = (focus ? 1 : -1) * Number(item.arcSign || 1)
    const frames = buildBezierMotionFrames(
      startX,
      startY,
      startScale,
      endX,
      endY,
      endScale,
      direction
    )
    const segmentDuration = Math.max(60, Math.round(DELIVERY_MOTION_DURATION / frames.length))
    const animation = wx.createAnimation({
      duration: segmentDuration,
      timingFunction: 'linear',
      transformOrigin: '50% 50%',
      delay: 0
    })

    // 平移和缩放写入同一个 transform 动画队列；每一帧同时更新位置与比例，
    // 轨迹由二次贝塞尔曲线生成，不再出现“先平移、后缩放”的割裂感。
    frames.forEach(frame => {
      animation
        .translate3d(rounded(frame.x), rounded(frame.y), 0)
        .scale(rounded(frame.scale, 4))
        .step({ duration: segmentDuration, timingFunction: 'linear' })
    })

    const path = `deliveryImages[${index}]`
    this.setData({
      [`${path}.motionLocked`]: true,
      [`${path}.viewState`]: focus ? 'focus' : 'full',
      [`${path}.hint`]: '',
      [`${path}.animationData`]: animation.export()
    })

    this.scheduleDeliveryMotion(() => {
      this.setData({
        [`${path}.motionLocked`]: false,
        [`${path}.hint`]: focus ? '点击查看完整空间' : '点击聚焦作品'
      })
    }, segmentDuration * frames.length + 80)

    if (!options.initial) {
      trackClientEvent('result_image_view_toggle', {
        page_name: 'result',
        order_id: this.data.orderId,
        image_index: index,
        view_state: focus ? 'focus' : 'full'
      })
    }
    return true
  },

  toggleDeliveryImage(e) {
    const index = Number(e.currentTarget.dataset.index || 0)
    const item = this.data.deliveryImages[index]
    if (!item || !item.hasFocus || item.motionLocked) return
    this.animateDeliveryImage(index, item.viewState !== 'focus')
  },

  normalizeThinking(payload) {
    return normalizeThinkingPayload(
      payload,
      this.data.wallCandidates || [],
      this.data.selectedWallIds || [],
      { delivered: true }
    )
  },

  async loadThinking(force = false) {
    if (!this.data.orderId || (this.data.thinkingReady && !force)) return
    try {
      const payload = await request(`${app.globalData.serverUrl}/api/client/hanging-thinking/${this.data.orderId}`, 'GET', null)
      const normalized = this.normalizeThinking(payload)
      if (!normalized.ready) return
      this.setData({
        thinkingReady: true,
        thinkingGuideCopy: normalized.guideCopy,
        maxWallSelect: normalized.maxSelect,
        wallCandidates: normalized.candidates,
        notRecommendedWalls: normalized.notRecommended,
        wallSupplementPending: normalized.hasPendingSupplement
      })
      if (normalized.hasPendingSupplement) this.startPrimarySupplementPolling()
      else if (!this.data.primarySupplementRendering) this.stopPrimarySupplementPolling()
    } catch (e) {
      console.warn('[result:thinking:error]', e && (e.message || e.errMsg || e))
    }
  },

  refreshCandidateStates(selectedWallIds) {
    const selected = selectedWallIds || this.data.selectedWallIds || []
    this.setData({
      selectedWallIds: selected,
      wallCandidates: refreshCandidateStates(this.data.wallCandidates || [], selected, this.data.maxWallSelect)
    })
  },

  toggleWallChoice(e) {
    const wallId = e.currentTarget && e.currentTarget.dataset ? String(e.currentTarget.dataset.wallId || '') : ''
    if (!wallId || this.data.preferenceSubmitting) return
    const candidate = (this.data.wallCandidates || []).find(item => item.wall_id === wallId)
    if (!candidate || candidate.is_disabled || candidate.current_effect) return
    const selected = (this.data.selectedWallIds || []).slice()
    const index = selected.indexOf(wallId)
    if (index >= 0) selected.splice(index, 1)
    else {
      if (selected.length >= Number(this.data.maxWallSelect || 2)) {
        wx.showToast({ title: `最多选择${this.data.maxWallSelect}面墙`, icon: 'none' })
        return
      }
      selected.push(wallId)
    }
    this.refreshCandidateStates(selected)
  },

  toggleWallpaperSuggestion(e) {
    const wallId = e.currentTarget && e.currentTarget.dataset ? String(e.currentTarget.dataset.wallId || '') : ''
    if (!wallId || this.data.preferenceSubmitting) return
    const current = (this.data.wallCandidates || []).find(item => item.wall_id === wallId)
    if (!current || !current.suggest_dark_wallpaper || current.current_effect) return
    const selected = (this.data.selectedWallIds || []).slice()
    const enabling = !current.wallpaper_opt_in_preview
    if (enabling && selected.indexOf(wallId) < 0) {
      if (selected.length >= Number(this.data.maxWallSelect || 2)) {
        wx.showToast({ title: `最多选择${this.data.maxWallSelect}面墙`, icon: 'none' })
        return
      }
      selected.push(wallId)
    }
    const wallCandidates = (this.data.wallCandidates || []).map(item => Object.assign({}, item, {
      is_selected: selected.indexOf(item.wall_id) >= 0,
      wallpaper_opt_in_preview: item.wall_id === wallId ? enabling : item.wallpaper_opt_in_preview
    }))
    this.setData({
      selectedWallIds: selected,
      wallCandidates: refreshCandidateStates(wallCandidates, selected, this.data.maxWallSelect)
    })
  },

  async submitWallPreference() {
    const selected = this.data.selectedWallIds || []
    if (!selected.length || this.data.preferenceSubmitting) return
    const wallpaperOptIn = {}
    ;(this.data.wallCandidates || []).forEach(item => {
      if (selected.indexOf(item.wall_id) >= 0 && item.suggest_dark_wallpaper) {
        wallpaperOptIn[item.wall_id] = !!item.wallpaper_opt_in_preview
      }
    })
    this.setData({ preferenceSubmitting: true, preferenceMessage: '' })
    try {
      const payload = await request(`${app.globalData.serverUrl}/api/client/wall-preferences`, 'POST', {
        order_id: this.data.orderId,
        delivery_token: this.data.deliveryToken,
        selected_wall_ids: selected,
        wallpaper_opt_in: wallpaperOptIn
      })
      this.setData({
        preferenceSubmitting: false,
        selectedWallIds: [],
        preferenceMessage: payload && payload.supplement_job_ids && payload.supplement_job_ids.length
          ? '已开始生成追加效果，完成后会自动出现在上方。'
          : '已记录您的墙面选择。'
      })
      await this.loadThinking(true)
      if (payload && payload.supplement_job_ids && payload.supplement_job_ids.length) {
        this.setData({ wallSupplementPending: true })
        this.startPrimarySupplementPolling()
      }
      trackClientEvent('result_wall_preference_submitted', {
        page_name: 'result',
        order_id: this.data.orderId,
        selected_wall_ids: selected
      })
    } catch (e) {
      this.setData({ preferenceSubmitting: false, preferenceMessage: '暂时没有提交成功，请稍后再试。' })
    }
  },

  async checkOtherOrders() {
    const deviceId = app.globalData.deviceId
    if (!deviceId) return
    try {
      const query = app.buildIdentityQuery({ page: 1, page_size: 20, history_only: 1 })
      const res = await request(`${app.globalData.serverUrl}/api/client/device-orders/${deviceId}?${query}`, 'GET', null)
      const others = (res.orders || []).filter(order => order.id !== this.data.orderId)
      this.setData({ otherDeliveredOrders: others.slice(0, 5) })
    } catch (e) {}
  },

  goToNextOrder(e) {
    const orderId = e.currentTarget.dataset.id
    wx.setStorageSync('lastOrderId', orderId)
    wx.redirectTo({ url: `/pages/result/result?orderId=${orderId}` })
  },

  openHistory() {
    trackClientEvent('history_entry_clicked', { page_name: 'result', order_id: this.data.orderId })
    wx.navigateTo({ url: '/pages/history/history' })
  },

  previewImage(e) {
    const src = e.currentTarget.dataset.src
    const index = Number(e.currentTarget.dataset.index || 0)
    trackClientEvent('result_image_preview', { page_name: 'result', order_id: this.data.orderId, image_index: index })
    this.trackEvent('image_click', {
      image_url: src,
      image_index: index,
      page_name: 'result'
    })

    this.openFullscreenViewer(src)
  },

  saveImage(e) {
    const src = e.currentTarget.dataset.src
    const imageIndex = Number(e.currentTarget.dataset.index || 0)
    wx.getSetting({
      success: res => {
        if (!res.authSetting['scope.writePhotosAlbum']) {
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: () => this.doSaveImage(src, imageIndex),
            fail: () => wx.showToast({ title: '需要相册权限才能保存', icon: 'none' })
          })
        } else {
          this.doSaveImage(src, imageIndex)
        }
      }
    })
  },

  doSaveImage(src, imageIndex = 0) {
    wx.showLoading({ title: '保存中...' })
    wx.downloadFile({
      url: src,
      success: res => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => {
            wx.hideLoading()
            wx.showToast({ title: '已保存到相册', icon: 'success' })
            request(`${app.globalData.serverUrl}/api/client/mark-downloaded/${this.data.orderId}`, 'POST', {
              device_uuid: app.globalData.deviceId || '',
              image_index: imageIndex,
              image_url: src,
              page_name: 'result'
            }).catch(() => {})
          },
          fail: () => {
            wx.hideLoading()
            wx.showToast({ title: '保存失败', icon: 'none' })
          }
        })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    })
  },

  copyCollectionAdvisorWechat() {
    const value = String(this.data.collectionAdvisorWechat || '').trim()
    if (!value) return
    wx.setClipboardData({
      data: value,
      success: () => {
        wx.showToast({ title: '微信号已复制', icon: 'success' })
        trackClientEvent('collection_advisor_wechat_copied', {
          page_name: 'result',
          order_id: this.data.orderId
        })
      }
    })
  },

  submitAgain() {
    trackClientEvent('reorder_clicked', { page_name: 'result', order_id: this.data.orderId })
    wx.redirectTo({ url: '/pages/index/index' })
  },

  // Fullscreen viewer methods
  ...viewerMethods
})
