const app = getApp()
const { request } = require('../../utils/helper')

Page({
  data: {
    services: [
      {
        id: 'hang_in_home',
        title: '作品挂进家',
        desc: '把画作挂置于您居住的空间中，生成真实效果图',
        iconPath: '/assets/icons/huakuang.svg',
        animationKey: 'hang'
      },
      {
        id: 'recommend_work',
        title: '为空间推荐作品',
        desc: '根据您的居住空间，为您精选合适的艺术作品',
        iconPath: '/assets/icons/xiaofangzi.svg',
        animationKey: 'recommend'
      }
    ],
    selectedService: null,
    activeOrder: null,
    showLoginOverlay: false,
    loginLoading: false,
    historyCount: 0,
    selectedAnimationKey: ''
  },

  onLoad() {
    if (!app.globalData.openid) {
      this.setData({ showLoginOverlay: true })
    }
  },

  onShow() {
    this.checkActiveOrder()
    this.loadHistoryCount()
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
    const matched = this.data.services.find(item => item.id === selectedService)
    this.setData({
      selectedService,
      selectedAnimationKey: matched ? matched.animationKey : ''
    })
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
