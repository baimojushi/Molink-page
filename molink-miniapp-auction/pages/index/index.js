const app = getApp()
const { request, trackClientEvent } = require('../../utils/helper')

const INTRO_DURATION = 2600
const HANG_DURATION = 2200
const RECOMMEND_BRIDGE_DURATION = 2200

const ANIMATION_BASES = {
  intro: 'https://molink-1404430861.cos.ap-shanghai.myqcloud.com/1.webp',
  hang: 'https://molink-1404430861.cos.ap-shanghai.myqcloud.com/2.1.webp',
  recommendBridge: 'https://molink-1404430861.cos.ap-shanghai.myqcloud.com/2.webp',
  recommendLoop: 'https://molink-1404430861.cos.ap-shanghai.myqcloud.com/2.2.webp'
}

Page({
  animationTimer: null,
  currentStep: '',
  desiredService: '',
  animationToken: 0,
  entranceStarted: false,

  data: {
    services: [
      {
        id: 'hang_in_home',
        title: '作品挂进家',
        desc: '把画作挂置于您居住的空间中，生成真实效果图',
        iconPath: '/assets/icons/huakuang.svg'
      },
      {
        id: 'recommend_work',
        title: '为空间推荐作品',
        desc: '算法升级中，敬请期待',
        iconPath: '/assets/icons/xiaofangzi.svg',
        disabled: true
      }
    ],
    selectedService: null,
    privacyAgreed: false,
    privacyShake: false,
    activeOrder: null,
    historyCount: 0,
    animationSlotA: '',
    animationSlotB: '',
    activeAnimationSlot: 'A',
    animationLoop: false,
    cardIntroStep: 0,
    headerIntroDone: false,
    currentExhibitionName: '',
    currentExhibitionStatus: '',
    exhibitionOrderDisabled: false
  },

  onLoad() {
    this.restorePrivacyAgreement()
    this.startEntranceIfNeeded()
  },

  onShow() {
    this.restorePrivacyAgreement()
    const currentExhibition = app.getCurrentExhibition()
    if (!currentExhibition.id) {
      wx.reLaunch({ url: '/pages/select-exhibition/index' })
      return
    }
    this.setData({
      currentExhibitionName: currentExhibition.name || '当前展览',
      currentExhibitionStatus: currentExhibition.status || '',
      exhibitionOrderDisabled: currentExhibition.status === 'archived'
    })
    this.checkActiveOrder()
    this.loadHistoryCount()
    this.startEntranceIfNeeded()
    trackClientEvent('home_view', { page_name: 'index', entry_source: 'miniapp_home' })
  },

  onUnload() {
    this.clearAnimationTimer()
  },

  startEntranceIfNeeded() {
    if (this.entranceStarted) return
    this.entranceStarted = true
    this.playEntranceMotion()
    this.startAnimationStep('intro', { forceReplay: true })
  },

  playEntranceMotion() {
    this.setData({
      cardIntroStep: 0,
      headerIntroDone: false
    })

    setTimeout(() => {
      this.setData({ cardIntroStep: 1 })
    }, 80)

    setTimeout(() => {
      this.setData({ cardIntroStep: 2 })
    }, 260)

    setTimeout(() => {
      this.setData({ headerIntroDone: true })
    }, 980)
  },

  clearAnimationTimer() {
    if (this.animationTimer) {
      clearTimeout(this.animationTimer)
      this.animationTimer = null
    }
  },

  buildAnimationSrc(stepName, forceReplay = false) {
    const base = ANIMATION_BASES[stepName]
    if (!base) return ''
    if (!forceReplay) return base
    this.animationToken += 1
    const connector = base.includes('?') ? '&' : '?'
    return `${base}${connector}play=${Date.now()}_${this.animationToken}`
  },

  switchAnimationSource(src, loop) {
    const nextSlot = this.data.activeAnimationSlot === 'A' ? 'B' : 'A'
    const patch = {
      animationLoop: loop,
      activeAnimationSlot: nextSlot
    }

    if (nextSlot === 'A') {
      patch.animationSlotA = src
    } else {
      patch.animationSlotB = src
    }

    this.setData(patch)
  },

  startAnimationStep(stepName, options = {}) {
    const { forceReplay = false } = options

    this.clearAnimationTimer()
    this.currentStep = stepName

    const config = {
      intro: { duration: INTRO_DURATION, loop: false },
      hang: { duration: HANG_DURATION, loop: false },
      recommendBridge: { duration: RECOMMEND_BRIDGE_DURATION, loop: false },
      recommendLoop: { duration: 0, loop: true }
    }[stepName]

    if (!config) return

    const replay = forceReplay || stepName === 'hang' || stepName === 'recommendLoop'
    const src = this.buildAnimationSrc(stepName, replay)
    this.switchAnimationSource(src, config.loop)

    if (config.loop) return

    this.animationTimer = setTimeout(() => {
      this.animationTimer = null
      this.resolveAnimationStep(stepName)
    }, config.duration)
  },

  resolveAnimationStep(stepName) {
    if (stepName === 'intro') {
      if (this.desiredService === 'hang_in_home') {
        this.startAnimationStep('hang', { forceReplay: true })
        return
      }
      if (this.desiredService === 'recommend_work') {
        this.startAnimationStep('recommendBridge', { forceReplay: true })
        return
      }
      this.currentStep = 'introDone'
      return
    }

    if (stepName === 'hang') {
      if (this.desiredService === 'recommend_work') {
        this.startAnimationStep('recommendLoop', { forceReplay: true })
        return
      }
      this.currentStep = 'hangDone'
      return
    }

    if (stepName === 'recommendBridge') {
      if (this.desiredService === 'hang_in_home') {
        this.startAnimationStep('hang', { forceReplay: true })
        return
      }
      this.startAnimationStep('recommendLoop', { forceReplay: true })
    }
  },

  syncAnimationWithSelection(serviceId) {
    this.desiredService = serviceId

    if (!serviceId || !this.entranceStarted) return

    if (serviceId === 'hang_in_home') {
      if (this.currentStep === 'recommendLoop') {
        this.startAnimationStep('hang', { forceReplay: true })
        return
      }
      if (['intro', 'hang', 'recommendBridge'].includes(this.currentStep)) {
        return
      }
      this.startAnimationStep('hang', { forceReplay: true })
      return
    }

    if (serviceId === 'recommend_work') {
      if (this.currentStep === 'recommendLoop') {
        this.startAnimationStep('recommendLoop', { forceReplay: true })
        return
      }
      if (['intro', 'hang', 'recommendBridge'].includes(this.currentStep)) {
        return
      }
      if (this.currentStep === 'hangDone') {
        this.startAnimationStep('recommendLoop', { forceReplay: true })
        return
      }
      this.startAnimationStep('recommendBridge', { forceReplay: true })
    }
  },

  onAnimationError(e) {
    console.log(
      'animation load failed',
      e,
      this.data.activeAnimationSlot === 'A' ? this.data.animationSlotA : this.data.animationSlotB
    )
  },

  async checkActiveOrder() {
    const lastOrderId = wx.getStorageSync('lastOrderId')
    if (!lastOrderId) {
      this.setData({ activeOrder: null })
      return
    }

    try {
      const res = await request(`${app.globalData.serverUrl}/api/client/order-status/${lastOrderId}`, 'GET', null)
      if (['delivered', 'viewed', 'downloaded'].includes(res.status)) {
        wx.redirectTo({ url: `/pages/result/result?orderId=${lastOrderId}` })
      } else if (['pending', 'processing', 'ai_generating', 'ai_ready', 'content_reviewing'].includes(res.status)) {
        this.setData({ activeOrder: { id: lastOrderId, status: res.status, delivered: false } })
      } else {
        wx.removeStorageSync('lastOrderId')
        this.setData({ activeOrder: null })
      }
    } catch (e) {
      this.setData({ activeOrder: null })
    }
  },

  async loadHistoryCount() {
    const deviceId = app.globalData.deviceId
    if (!deviceId) return

    try {
      const res = await request(`${app.globalData.serverUrl}/api/client/device-orders/${deviceId}?page=1&page_size=1&history_only=1`, 'GET', null)
      this.setData({ historyCount: res.total || 0 })
    } catch (e) {
      this.setData({ historyCount: 0 })
    }
  },

  goToActiveOrder() {
    const { activeOrder } = this.data
    if (!activeOrder) return
    trackClientEvent('active_order_clicked', { page_name: 'index', order_id: activeOrder.id, status: activeOrder.status || '' })
    wx.navigateTo({ url: `/pages/waiting/waiting?orderId=${activeOrder.id}` })
  },

  switchExhibition() {
    trackClientEvent('exhibition_switch_clicked', { page_name: 'index', entry_source: 'miniapp_home' })
    this.tryGeoLocateOrSelect()
  },

  tryGeoLocateOrSelect() {
    if (!app.globalData.ENABLE_GEO_ENTRY) {
      wx.navigateTo({ url: '/pages/select-exhibition/index?mode=switch' })
      return
    }

    const canUseFuzzy = wx.canIUse && wx.canIUse('getFuzzyLocation') && typeof wx.getFuzzyLocation === 'function'
    if (!canUseFuzzy) {
      wx.navigateTo({ url: '/pages/select-exhibition/index?mode=switch' })
      return
    }

    wx.showLoading({ title: '正在定位…', mask: true })
    wx.getFuzzyLocation({
      type: 'gcj02',
      success: location => {
        wx.request({
          url: `${app.globalData.serverUrl}/api/client/exhibitions/locate`,
          method: 'POST',
          header: { 'Content-Type': 'application/json' },
          data: { lat: location.latitude, lng: location.longitude },
          success: res => {
            wx.hideLoading()
            if (res.statusCode === 200 && res.data && res.data.exhibition) {
              app.setCurrentExhibition(res.data.exhibition)
              const dist = res.data.distance_m ? `（${Math.round(res.data.distance_m)}m）` : ''
              wx.showToast({ title: `已定位到${res.data.exhibition.name}${dist}`, icon: 'success', duration: 2000 })
              this.setData({
                currentExhibitionName: res.data.exhibition.name || '当前展览',
                currentExhibitionStatus: res.data.exhibition.status || '',
                exhibitionOrderDisabled: res.data.exhibition.status === 'archived'
              })
              trackClientEvent('home_geo_locate_success', {
                page_name: 'index',
                exhibition_id: res.data.exhibition.id,
                distance_m: res.data.distance_m || null
              })
            } else {
              this.fallbackToSelect('附近未匹配到展览')
            }
          },
          fail: () => {
            wx.hideLoading()
            this.fallbackToSelect('定位请求失败')
          }
        })
      },
      fail: () => {
        wx.hideLoading()
        this.fallbackToSelect('定位权限不可用')
      }
    })
  },

  fallbackToSelect(hint) {
    wx.showToast({ title: `${hint}，请手动选择`, icon: 'none', duration: 2000 })
    wx.navigateTo({ url: '/pages/select-exhibition/index?mode=switch' })
  },

  openHistory() {
    trackClientEvent('history_entry_clicked', { page_name: 'index', entry_source: 'miniapp_home' })
    wx.navigateTo({ url: '/pages/history/history' })
  },


  restorePrivacyAgreement() {
    const privacyAgreed = app.restorePrivacyAgreement()
    if (privacyAgreed !== this.data.privacyAgreed) {
      this.setData({ privacyAgreed, privacyShake: false })
    }
  },

  remindPrivacyAgreement(reason = 'privacy_not_agreed') {
    this.setData({ privacyShake: false })
    setTimeout(() => {
      this.setData({ privacyShake: true })
      wx.vibrateShort({ type: 'light' })
      trackClientEvent('privacy_agreement_required', { page_name: 'index', entry_source: 'miniapp_home', reason })
    }, 20)
    setTimeout(() => {
      this.setData({ privacyShake: false })
    }, 660)
  },

  togglePrivacyAgreement() {
    app.acceptPrivacyAgreement()
    this.setData({
      privacyAgreed: true,
      privacyShake: false
    })
    trackClientEvent('privacy_agreement_checked', {
      page_name: 'index',
      entry_source: 'miniapp_home',
      identity_type: app.globalData.openid ? 'openid' : 'device'
    })
  },

  selectService(e) {
    const serviceId = e.currentTarget.dataset.id
    const service = this.data.services.find(s => s.id === serviceId)
    if (service && service.disabled) {
      wx.showToast({ title: '算法升级中，敬请期待', icon: 'none', duration: 2000 })
      return
    }
    if (this.data.exhibitionOrderDisabled) {
      wx.showToast({ title: '该展览已结束，暂不支持在线下单', icon: 'none' })
      return
    }
    if (!this.data.privacyAgreed) {
      this.remindPrivacyAgreement('service_tapped_before_privacy')
      return
    }

    this.setData({ selectedService: serviceId })
    this.syncAnimationWithSelection(serviceId)
    trackClientEvent('service_selected', { page_name: 'index', service_type: serviceId, entry_source: 'miniapp_home' })
  },

  goNext() {
    if (this.data.exhibitionOrderDisabled) {
      wx.showToast({ title: '该展览已结束，暂不支持在线下单', icon: 'none' })
      return
    }
    if (!this.data.privacyAgreed) {
      this.remindPrivacyAgreement('next_tapped_before_privacy')
      wx.showToast({ title: '请先阅读并同意隐私协议', icon: 'none' })
      trackClientEvent('service_next_blocked', { page_name: 'index', entry_source: 'miniapp_home', reason: 'privacy_not_agreed' })
      return
    }

    if (!this.data.selectedService) {
      trackClientEvent('service_next_blocked', { page_name: 'index', entry_source: 'miniapp_home', reason: 'service_not_selected' })
      wx.showToast({ title: '请先选择服务', icon: 'none' })
      return
    }

    trackClientEvent('service_next_clicked', { page_name: 'index', service_type: this.data.selectedService, entry_source: 'miniapp_home' })
    wx.navigateTo({
      url: `/pages/upload/upload?service=${this.data.selectedService}`,
      fail: err => {
        wx.showModal({ title: '跳转失败', content: JSON.stringify(err), showCancel: false })
      }
    })
  },

  onLogoLongPress() {
    wx.vibrateShort({ type: 'light' })
    if (app.isLoggedIn()) {
      wx.navigateTo({ url: '/pages/staff-orders/staff-orders' })
    } else {
      wx.navigateTo({ url: '/pages/staff-login/staff-login' })
    }
  },

  openPrivacy() {
    wx.navigateTo({ url: '/pages/webview/webview?url=https%3A%2F%2Fwww.molink.art%2Fprivacy' })
  },

  openTerms() {
    wx.navigateTo({ url: '/pages/webview/webview?url=https%3A%2F%2Fwww.molink.art%2Fterms' })
  }
})
