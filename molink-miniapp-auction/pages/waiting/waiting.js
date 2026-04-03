const app = getApp()
const { request, formatTime } = require('../../utils/helper')

Page({
  data: {
    orderId: '',
    submitTime: '',
    dots: [0,30,60,90,120,150,180,210,240,270,300,330],
    pollingTimer: null,
    subscribed: false
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

  onShow() {
    this.startPolling()
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
  },

  startPolling() {
    this.stopPolling()
    const timer = setInterval(() => this.checkStatus(), 8000)
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
      if (res.status === 'delivered') {
        this.stopPolling()
        wx.setStorageSync('lastOrderStatus', 'delivered')
        wx.redirectTo({
          url: `/pages/result/result?orderId=${this.data.orderId}`
        })
      }
    } catch (e) {
      // 静默失败，继续轮询
    }
  },

  goHome() {
    this.stopPolling()
    wx.reLaunch({ url: '/pages/index/index' })
  },

  subscribeNotification() {
    // 上线后将 'YOUR_TEMPLATE_ID' 替换为微信公众平台审核通过的模板ID
    wx.requestSubscribeMessage({
      tmplIds: ['YOUR_TEMPLATE_ID'],
      success: (res) => {
        if (res['YOUR_TEMPLATE_ID'] === 'accept') {
          this.setData({ subscribed: true })
        }
      }
    })
  }
})
