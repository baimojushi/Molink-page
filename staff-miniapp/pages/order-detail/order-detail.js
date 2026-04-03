const app = getApp()
const { request, uploadFile, formatTime } = require('../../utils/request')

Page({
  data: {
    orderId: '',
    order: null,
    uploading: false,
    delivering: false
  },

  onLoad(options) {
    this.setData({ orderId: options.orderId })
    this.loadOrder()
  },

  async loadOrder() {
    try {
      const res = await request(
        `${app.globalData.serverUrl}/api/admin/order/${this.data.orderId}`,
        'GET',
        null
      )
      this.setData({
        order: {
          ...res,
          submitTimeFormatted: formatTime(res.submitTime)
        }
      })
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 查看藏家上传的原图
  previewSourceImage(e) {
    const src = e.currentTarget.dataset.src
    const urls = []
    if (this.data.order.images) {
      Object.values(this.data.order.images).forEach(url => {
        if (url) urls.push(url)
      })
    }
    wx.previewImage({ current: src, urls: urls.length ? urls : [src] })
  },

  // 上传效果图
  async uploadDelivery() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album'],
      success: async res => {
        this.setData({ uploading: true })
        try {
          const uploadedUrls = []
          for (const file of res.tempFiles) {
            const result = await uploadFile(file.tempFilePath, this.data.orderId)
            uploadedUrls.push(result.fileUrl)
          }
          // 更新本地订单数据中的效果图列表
          const current = this.data.order.deliveryImages || []
          this.setData({
            'order.deliveryImages': [...current, ...uploadedUrls]
          })
          wx.showToast({ title: `上传成功 ${uploadedUrls.length} 张`, icon: 'success' })
        } catch (e) {
          wx.showToast({ title: '上传失败，请重试', icon: 'none' })
        } finally {
          this.setData({ uploading: false })
        }
      }
    })
  },

  // 删除已上传的效果图
  removeDeliveryImage(e) {
    const index = e.currentTarget.dataset.index
    wx.showModal({
      title: '删除图片',
      content: '确认删除这张效果图？',
      success: async res => {
        if (!res.confirm) return
        const images = [...this.data.order.deliveryImages]
        images.splice(index, 1)
        this.setData({ 'order.deliveryImages': images })
      }
    })
  },

  // 预览效果图
  previewDelivery(e) {
    const src = e.currentTarget.dataset.src
    wx.previewImage({
      current: src,
      urls: this.data.order.deliveryImages
    })
  },

  // 交付给藏家（发送通知）
  async deliver() {
    const images = this.data.order.deliveryImages || []
    if (images.length === 0) {
      wx.showToast({ title: '请先上传效果图', icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认交付',
      content: `将向藏家发送 ${images.length} 张效果图，并发送通知`,
      success: async res => {
        if (!res.confirm) return
        this.setData({ delivering: true })
        try {
          await request(
            `${app.globalData.serverUrl}/api/admin/deliver/${this.data.orderId}`,
            'POST',
            { deliveryImages: images }
          )
          this.setData({ 'order.status': 'completed' })
          wx.showToast({ title: '交付成功，已通知藏家', icon: 'success' })
          // 返回列表
          setTimeout(() => wx.navigateBack(), 1500)
        } catch (e) {
          wx.showToast({ title: '交付失败，请重试', icon: 'none' })
        } finally {
          this.setData({ delivering: false })
        }
      }
    })
  }
})
