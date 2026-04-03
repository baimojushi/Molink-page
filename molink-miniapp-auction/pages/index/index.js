const app = getApp()
const { request } = require('../../utils/helper')

Page({
  data: {
    services: [
      {
        id: 'hang_in_home',
        title: '作品挂进家',
        desc: '把画作挂置于您居住的空间中，生成真实效果图',
        iconPath: '/assets/icons/huakuang.svg'
      },
      {
        id: 'recommend_space',
        title: '一画一宅',
        desc: '为您心仪书画作品生成理想的"生活化展览空间"',
        iconPath: '/assets/icons/ruanzhuang.svg'
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
    loginLoading: false
  },

  onLoad() {
    // 只在首次进入时显示登录提示（不在 onShow 里，避免每次返回都弹出）
    if (!app.globalData.openid) {
      this.setData({ showLoginOverlay: true })
    }
  },

  onShow() {
    this.checkActiveOrder()
  },

  // 微信一键登录（静默获取openid，无需用户授权弹窗）
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

  // 跳过登录
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
      const res = await request(
        `${app.globalData.serverUrl}/api/client/order-status/${lastOrderId}`,
        'GET', null
      )
      if (res.status === 'delivered') {
        wx.redirectTo({ url: `/pages/result/result?orderId=${lastOrderId}` })
      } else if (res.status === 'viewed' || res.status === 'downloaded') {
        wx.removeStorageSync('lastOrderId')
        wx.removeStorageSync('lastOrderStatus')
        this.setData({ activeOrder: null })
      } else if (res.status === 'pending' || res.status === 'processing' || res.status === 'ai_generating' || res.status === 'ai_ready') {
        this.setData({
          activeOrder: { id: lastOrderId, status: res.status, delivered: false }
        })
      } else {
        wx.removeStorageSync('lastOrderId')
        this.setData({ activeOrder: null })
      }
    } catch (e) {}
  },

  goToActiveOrder() {
    const { activeOrder } = this.data
    if (!activeOrder) return
    if (activeOrder.delivered) {
      wx.navigateTo({ url: `/pages/result/result?orderId=${activeOrder.id}` })
    } else {
      wx.navigateTo({ url: `/pages/waiting/waiting?orderId=${activeOrder.id}` })
    }
  },

  selectService(e) {
    this.setData({ selectedService: e.currentTarget.dataset.id })
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
    wx.navigateTo({
      url: '/pages/webview/webview?url=https%3A%2F%2Fwww.molink.art%2Fprivacy'
    })
  },

  openTerms() {
    wx.navigateTo({
      url: '/pages/webview/webview?url=https%3A%2F%2Fwww.molink.art%2Fterms'
    })
  }
})
