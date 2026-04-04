const app = getApp()
const { request, formatTime } = require('../../utils/helper')

Page({
  data: {
    orderId: '',
    deliveryImages: [],
    submitTime: '',
    otherDeliveredOrders: []
  },

  onLoad(options) {
    const orderId = options.orderId || app.globalData.currentOrderId
    if (!orderId) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }

    this.enteredAt = Date.now()
    this.setData({ orderId })
    this.loadResult()
  },

  onShow() {
    if (!this.enteredAt) this.enteredAt = Date.now()
  },

  onHide() {
    this.reportStayDuration()
  },

  onUnload() {
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
        wx.redirectTo({ url: `/pages/waiting/waiting?orderId=${this.data.orderId}` })
        return
      }

      const baseUrl = app.globalData.serverUrl
      const images = (res.images || []).map(file => `${baseUrl}/deliveries/${file}`)
      this.setData({
        deliveryImages: images,
        submitTime: res.deliveredAt ? formatTime(res.deliveredAt) : ''
      })

      if (images.length > 0) {
        wx.removeStorageSync('lastOrderId')
        wx.setStorageSync('lastOrderStatus', 'viewed')
        request(`${app.globalData.serverUrl}/api/client/mark-viewed/${this.data.orderId}`, 'POST', {}).catch(() => {})
        this.checkOtherOrders()
      }
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
    }
  },

  async checkOtherOrders() {
    const deviceId = app.globalData.deviceId
    if (!deviceId) return
    try {
      const res = await request(`${app.globalData.serverUrl}/api/client/device-orders/${deviceId}?page=1&page_size=20&history_only=1`, 'GET', null)
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
    wx.navigateTo({ url: '/pages/history/history' })
  },

  previewImage(e) {
    const src = e.currentTarget.dataset.src
    const index = Number(e.currentTarget.dataset.index || 0)
    this.trackEvent('image_click', {
      image_url: src,
      image_index: index,
      page_name: 'result'
    })

    wx.previewImage({
      current: src,
      urls: this.data.deliveryImages
    })
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

  submitAgain() {
    wx.redirectTo({ url: '/pages/index/index' })
  }
})
