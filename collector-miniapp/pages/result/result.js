const app = getApp()
const { request, formatTime } = require('../../utils/helper')

Page({
  data: {
    orderId: '',
    deliveryImages: [],
    submitTime: '',
    currentIndex: 0
  },

  onLoad(options) {
    const orderId = options.orderId || app.globalData.currentOrderId
    if (!orderId) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }
    this.setData({ orderId })
    this.loadResult()
  },

  async loadResult() {
    try {
      const res = await request(
        `${app.globalData.serverUrl}/api/client/order-status/${this.data.orderId}`,
        'GET',
        null
      )
      if (res.status === 'completed') {
        this.setData({
          deliveryImages: res.deliveryImages || [],
          submitTime: res.submitTime ? formatTime(res.submitTime) : ''
        })
        wx.setStorageSync('lastOrderStatus', 'viewed')
        // 标记已查看
        request(
          `${app.globalData.serverUrl}/api/client/mark-viewed/${this.data.orderId}`,
          'POST',
          {}
        ).catch(() => {})
      } else {
        wx.redirectTo({ url: `/pages/waiting/waiting?orderId=${this.data.orderId}` })
      }
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
    }
  },

  // 预览图片
  previewImage(e) {
    const src = e.currentTarget.dataset.src
    wx.previewImage({
      current: src,
      urls: this.data.deliveryImages
    })
  },

  // 保存图片到相册
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

  // 重新提交
  submitAgain() {
    wx.removeStorageSync('lastOrderId')
    wx.removeStorageSync('lastOrderStatus')
    wx.redirectTo({ url: '/pages/index/index' })
  }
})
