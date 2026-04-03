const app = getApp()
const { request, formatTime } = require('../../utils/helper')

Page({
  data: {
    orderId: '',
    deliveryImages: [],
    submitTime: '',
    otherDeliveredOrders: [],
    partnerAppId: '',
    partnerPath: ''
  },

  onLoad(options) {
    const orderId = options.orderId || app.globalData.currentOrderId
    if (!orderId) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }
    this.setData({
      orderId,
      partnerAppId: app.globalData.partnerAppId || '',
      partnerPath: app.globalData.partnerPath || ''
    })
    this.loadResult()
  },

  async loadResult() {
    try {
      const res = await request(
        `${app.globalData.serverUrl}/api/client/order-status/${this.data.orderId}`,
        'GET', null
      )
      if (res.status === 'delivered' || res.status === 'viewed') {
        const baseUrl = app.globalData.serverUrl
        const images = (res.images || []).map(f => `${baseUrl}/deliveries/${f}`)
        this.setData({
          deliveryImages: images,
          submitTime: res.deliveredAt ? formatTime(res.deliveredAt) : ''
        })
        if (images.length > 0) {
          // 图片确实存在才算真正查看完，清除横幅
          wx.removeStorageSync('lastOrderId')
          wx.setStorageSync('lastOrderStatus', 'viewed')
          request(`${app.globalData.serverUrl}/api/client/mark-viewed/${this.data.orderId}`, 'POST', {}).catch(() => {})
          this.checkOtherOrders()
        }
      } else {
        wx.redirectTo({ url: `/pages/waiting/waiting?orderId=${this.data.orderId}` })
      }
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
    }
  },

  async checkOtherOrders() {
    const deviceId = app.globalData.deviceId
    if (!deviceId) return
    try {
      const res = await request(
        `${app.globalData.serverUrl}/api/client/device-orders/${deviceId}`,
        'GET', null
      )
      // 找出其他已交付但未查看的订单（排除当前订单）
      const others = (res.orders || []).filter(o =>
        o.id !== this.data.orderId && o.status === 'delivered'
      )
      this.setData({ otherDeliveredOrders: others })
    } catch (e) {
      // 静默失败
    }
  },

  goToNextOrder(e) {
    const orderId = e.currentTarget.dataset.id
    wx.setStorageSync('lastOrderId', orderId)
    wx.redirectTo({ url: `/pages/result/result?orderId=${orderId}` })
  },

  previewImage(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.src,
      urls: this.data.deliveryImages
    })
  },

  saveImage(e) {
    const src = e.currentTarget.dataset.src
    wx.getSetting({
      success: res => {
        if (!res.authSetting['scope.writePhotosAlbum']) {
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: () => this.doSaveImage(src),
            fail: () => wx.showToast({ title: '需要相册权限才能保存', icon: 'none' })
          })
        } else {
          this.doSaveImage(src)
        }
      }
    })
  },

  doSaveImage(src) {
    wx.showLoading({ title: '保存中...' })
    wx.downloadFile({
      url: src,
      success: res => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => {
            wx.hideLoading()
            wx.showToast({ title: '已保存到相册', icon: 'success' })
            request(`${app.globalData.serverUrl}/api/client/mark-downloaded/${this.data.orderId}`, 'POST', {}).catch(() => {})
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '保存失败', icon: 'none' }) }
        })
      },
      fail: () => { wx.hideLoading(); wx.showToast({ title: '保存失败', icon: 'none' }) }
    })
  },

  submitAgain() {
    wx.redirectTo({ url: '/pages/index/index' })
  },

  goToPartner() {
    const { partnerAppId, partnerPath } = this.data
    if (!partnerAppId) return
    wx.navigateToMiniProgram({
      appId: partnerAppId,
      path: partnerPath || undefined,
      fail: () => wx.showToast({ title: '跳转失败，请稍后重试', icon: 'none' })
    })
  }
})
