const app = getApp()
const { request } = require('../../utils/helper')

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
        desc: '根据您的居住空间，为您精选合适的艺术作品',
        iconPath: '/assets/icons/xiaofangzi.svg'
      }
    ],
    selectedService: null,
    activeOrder: null,
    showLoginOverlay: false,
    loginLoading: false,
    historyCount: 0,
    animationSlotA: '',
    animationSlotB: '',
    activeAnimationSlot: 'A',
    animationLoop: false,
    cardIntroStep: 0,
    headerIntroDone: false
  },

  onLoad() {
    if (!app.globalData.openid) {
      this.setData({ showLoginOverlay: true })
      return
    }
    this.startEntranceIfNeeded()
  },

  onShow() {
    this.checkActiveOrder()
    this.loadHistoryCount()
    if (!this.data.showLoginOverlay) {
      this.startEntranceIfNeeded()
    }
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
    }, 720)
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

  async doWxLogin() {
    this.setData({ loginLoading: true })
    try {
      await app.wxLogin('', '')
      this.setData({ showLoginOverlay: false })
      this.startEntranceIfNeeded()
    } catch (e) {
      wx.showToast({ title: '登录失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loginLoading: false })
    }
  },

  skipLogin() {
    this.setData({ showLoginOverlay: false })
    this.startEntranceIfNeeded()
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
      } else if (['pending', 'processing', 'ai_generating', 'ai_ready'].includes(res.status)) {
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
    wx.navigateTo({ url: `/pages/waiting/waiting?orderId=${activeOrder.id}` })
  },

  openHistory() {
    wx.navigateTo({ url: '/pages/history/history' })
  },

  selectService(e) {
    const selectedService = e.currentTarget.dataset.id
    this.setData({ selectedService })
    this.syncAnimationWithSelection(selectedService)
  },

  goNext() {
    if (!this.data.selectedService) {
      wx.showToast({ title: '请先选择服务', icon: 'none' })
      return
    }

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
