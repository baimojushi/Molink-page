const app = getApp()
const { request } = require('../../utils/helper')

const INTRO_DURATION = 2600
const HANG_DURATION = 2200
const RECOMMEND_BRIDGE_DURATION = 2200

const ANIMATION_ASSETS = {
  intro: '/assets/icons/1.webp',
  hang: '/assets/icons/2.1.webp',
  recommendBridge: '/assets/icons/2.webp',
  recommendLoop: '/assets/icons/2.2.webp'
}

Page({
  animationTimer: null,
  currentStep: '',
  desiredService: '',
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
    animationSrc: ANIMATION_ASSETS.intro,
    animationVisible: true,
    animationLoop: false
  },

  onLoad() {
    if (!app.globalData.openid) {
      this.setData({ showLoginOverlay: true })
    }
    this.startAnimationStep('intro')
  },

  onShow() {
    this.checkActiveOrder()
    this.loadHistoryCount()
  },

  onUnload() {
    this.clearAnimationTimer()
  },

  clearAnimationTimer() {
    if (this.animationTimer) {
      clearTimeout(this.animationTimer)
      this.animationTimer = null
    }
  },

  startAnimationStep(stepName) {
    this.clearAnimationTimer()
    this.currentStep = stepName

    const config = {
      intro: { src: ANIMATION_ASSETS.intro, loop: false, duration: INTRO_DURATION },
      hang: { src: ANIMATION_ASSETS.hang, loop: false, duration: HANG_DURATION },
      recommendBridge: { src: ANIMATION_ASSETS.recommendBridge, loop: false, duration: RECOMMEND_BRIDGE_DURATION },
      recommendLoop: { src: ANIMATION_ASSETS.recommendLoop, loop: true, duration: 0 }
    }[stepName]

    if (!config) return

    this.setData({
      animationVisible: false
    })

    setTimeout(() => {
      this.setData({
        animationSrc: config.src,
        animationLoop: config.loop,
        animationVisible: true
      })
    }, 20)

    if (config.loop) return

    this.animationTimer = setTimeout(() => {
      this.animationTimer = null
      this.resolveAnimationStep(stepName)
    }, config.duration)
  },

  resolveAnimationStep(stepName) {
    if (stepName === 'intro') {
      if (this.desiredService === 'hang_in_home') {
        this.startAnimationStep('hang')
        return
      }
      if (this.desiredService === 'recommend_work') {
        this.startAnimationStep('recommendBridge')
        return
      }
      this.currentStep = 'introDone'
      return
    }

    if (stepName === 'hang') {
      if (this.desiredService === 'recommend_work') {
        this.startAnimationStep('recommendLoop')
        return
      }
      this.currentStep = 'hangDone'
      return
    }

    if (stepName === 'recommendBridge') {
      if (this.desiredService === 'hang_in_home') {
        this.startAnimationStep('hang')
        return
      }
      this.startAnimationStep('recommendLoop')
    }
  },

  syncAnimationWithSelection(serviceId) {
    this.desiredService = serviceId

    if (!serviceId) return

    if (serviceId === 'hang_in_home') {
      if (this.currentStep === 'recommendLoop') {
        this.startAnimationStep('hang')
        return
      }
      if (['intro', 'hang', 'recommendBridge'].includes(this.currentStep)) {
        return
      }
      this.startAnimationStep('hang')
      return
    }

    if (serviceId === 'recommend_work') {
      if (this.currentStep === 'recommendLoop') return
      if (['intro', 'hang', 'recommendBridge'].includes(this.currentStep)) return
      if (this.currentStep === 'hangDone') {
        this.startAnimationStep('recommendLoop')
        return
      }
      this.startAnimationStep('recommendBridge')
    }
  },

  async doWxLogin() {
    this.setData({ loginLoading: true })
    try {
      await app.wxLogin('', '')
      this.setData({ showLoginOverlay: false })
    } catch (e) {
      wx.showToast({ title: '登录失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loginLoading: false })
    }
  },

  skipLogin() {
    this.setData({ showLoginOverlay: false })
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
