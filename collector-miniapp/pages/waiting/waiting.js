const app = getApp()
const { request, formatTime } = require('../../utils/helper')

Page({
  data: {
    orderId: '',
    status: 'pending',   // pending | processing | completed
    deliveryImages: [],
    submitTime: '',
    pollingTimer: null
  },

  onLoad(options) {
    const orderId = options.orderId || app.globalData.currentOrderId
    if (!orderId) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }
    this.setData({ orderId })
    this.checkStatus()
  },

  onUnload() {
    this.stopPolling()
  },

  onShow() {
    // 每次进入页面重新开始轮询
    if (this.data.status !== 'completed') {
      this.startPolling()
    }
  },

  onHide() {
    this.stopPolling()
  },

  startPolling() {
    this.stopPolling()
    const timer = setInterval(() => {
      this.checkStatus()
    }, 8000)
    this.data.pollingTimer = timer
  },

  stopPolling() {
    if (this.data.pollingTimer) {
      clearInterval(this.data.pollingTimer)
      this.data.pollingTimer = null
    }
  },

  async checkStatus() {
    try {
      const res = await request(
        `${app.globalData.serverUrl}/api/client/order-status/${this.data.orderId}`,
        'GET',
        null
      )

      this.setData({
        status: res.status,
        submitTime: res.submitTime ? formatTime(res.submitTime) : ''
      })

      if (res.status === 'completed' && res.deliveryImages) {
        this.setData({ deliveryImages: res.deliveryImages })
        this.stopPolling()
        wx.setStorageSync('lastOrderStatus', 'completed')

        // 跳转到结果页
        wx.redirectTo({
          url: `/pages/result/result?orderId=${this.data.orderId}`
        })
      }
    } catch (e) {
      // 静默失败，继续轮询
    }
  }
})
