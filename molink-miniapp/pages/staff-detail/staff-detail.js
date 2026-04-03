const app = getApp()
const { staffRequest, uploadDeliveryFile, formatTime } = require('../../utils/helper')

const STATUS_TEXT = {
  pending: '待处理',
  ai_generating: 'AI 生图中…',
  ai_ready: '待审核',
  processing: '处理中',
  delivered: '已交付',
  viewed: '已查看',
  downloaded: '已下载'
}

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
      const res = await staffRequest(
        `${app.globalData.serverUrl}/api/admin/orders/${this.data.orderId}`,
        'GET',
        null
      )
      const order = res.order || res
      const baseUrl = app.globalData.serverUrl
      const rawDelivery = Array.isArray(order.delivery_images)
        ? order.delivery_images
        : (order.delivery_images ? JSON.parse(order.delivery_images) : [])
      const deliveryImages = rawDelivery.map(f => `${baseUrl}/deliveries/${f}`)
      const artworkImage = order.artwork_image ? `${baseUrl}/uploads/${order.artwork_image}` : null
      const spaceImage = order.space_image ? `${baseUrl}/uploads/${order.space_image}` : null
      const aiResultUrl = order.ai_result_url || null
      this.setData({
        order: {
          ...order,
          serviceLabel: order.service_type_label,
          submitTimeFormatted: formatTime(order.created_at),
          statusText: STATUS_TEXT[order.status] || '待处理',
          artworkImage,
          spaceImage,
          deliveryImages,
          aiResultUrl
        }
      })
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  previewAiResult() {
    const url = this.data.order.aiResultUrl
    if (url) wx.previewImage({ current: url, urls: [url] })
  },

  previewSourceImage(e) {
    const src = e.currentTarget.dataset.src
    const urls = [
      this.data.order.artworkImage,
      this.data.order.spaceImage
    ].filter(Boolean)
    wx.previewImage({ current: src, urls: urls.length ? urls : [src] })
  },

  async uploadDelivery() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album'],
      success: async res => {
        this.setData({ uploading: true })
        try {
          const newFilenames = []
          for (const file of res.tempFiles) {
            const result = await uploadDeliveryFile(file.tempFilePath, this.data.orderId)
            newFilenames.push(result.filename)
          }
          // 本地显示时用完整URL，存储时保存文件名
          const baseUrl = app.globalData.serverUrl
          const newUrls = newFilenames.map(f => `${baseUrl}/deliveries/${f}`)
          const currentUrls = this.data.order.deliveryImages || []
          const currentFilenames = this.data.order.deliveryFilenames || []
          this.setData({
            'order.deliveryImages': [...currentUrls, ...newUrls],
            'order.deliveryFilenames': [...currentFilenames, ...newFilenames]
          })
          wx.showToast({ title: `上传成功 ${newFilenames.length} 张`, icon: 'success' })
        } catch (e) {
          wx.showToast({ title: '上传失败，请重试', icon: 'none' })
        } finally {
          this.setData({ uploading: false })
        }
      }
    })
  },

  removeDeliveryImage(e) {
    const index = e.currentTarget.dataset.index
    wx.showModal({
      title: '删除图片',
      content: '确认删除这张效果图？',
      success: res => {
        if (!res.confirm) return
        const images = [...(this.data.order.deliveryImages || [])]
        const filenames = [...(this.data.order.deliveryFilenames || [])]
        images.splice(index, 1)
        filenames.splice(index, 1)
        this.setData({
          'order.deliveryImages': images,
          'order.deliveryFilenames': filenames
        })
      }
    })
  },

  previewDelivery(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.src,
      urls: this.data.order.deliveryImages
    })
  },

  deleteOrder() {
    wx.showModal({
      title: '删除订单',
      content: '确认删除此订单？相关图片也会一并删除，无法恢复。',
      confirmColor: '#c0392b',
      success: async res => {
        if (!res.confirm) return
        try {
          await staffRequest(
            `${app.globalData.serverUrl}/api/admin/orders/${this.data.orderId}`,
            'DELETE',
            null
          )
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 1000)
        } catch (e) {
          const msg = (e && e.data && e.data.error) || (e && e.statusCode ? `HTTP ${e.statusCode}` : '网络错误')
          wx.showModal({ title: '删除失败', content: msg, showCancel: false })
        }
      }
    })
  },

  // AI 审核：通过
  async approve() {
    wx.showModal({
      title: '确认发送给藏家',
      content: '将把 AI 生成的效果图直接发送给藏家并通知',
      success: async res => {
        if (!res.confirm) return
        this.setData({ delivering: true })
        try {
          await staffRequest(
            `${app.globalData.serverUrl}/api/admin/approve/${this.data.orderId}`,
            'POST', {}
          )
          this.setData({ 'order.status': 'delivered', 'order.statusText': '已交付' })
          wx.showToast({ title: '已发送给藏家', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 1500)
        } catch (e) {
          const msg = (e && e.data && e.data.error) || '操作失败'
          wx.showModal({ title: '发送失败', content: msg, showCancel: false })
        } finally {
          this.setData({ delivering: false })
        }
      }
    })
  },

  // AI 审核：重新生成
  regenerate() {
    wx.showModal({
      title: '重新生成',
      content: '可以输入调整说明，留空则按原要求重新生成',
      editable: true,
      placeholderText: '如：光线更明亮一些，作品挂高一点',
      success: async res => {
        if (!res.confirm) return
        this.setData({ delivering: true })
        try {
          await staffRequest(
            `${app.globalData.serverUrl}/api/admin/regenerate/${this.data.orderId}`,
            'POST', { note: res.content || '' }
          )
          this.setData({ 'order.status': 'ai_generating', 'order.statusText': 'AI 生图中…', 'order.aiResultUrl': null })
          wx.showToast({ title: '已重新提交', icon: 'success' })
        } catch (e) {
          const msg = (e && e.data && e.data.error) || '操作失败'
          wx.showModal({ title: '失败', content: msg, showCancel: false })
        } finally {
          this.setData({ delivering: false })
        }
      }
    })
  },

  async deliver() {
    const filenames = this.data.order.deliveryFilenames || []
    const images = this.data.order.deliveryImages || []
    if (filenames.length === 0) {
      wx.showToast({ title: '请先上传效果图', icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认交付',
      content: `将向藏家发送 ${filenames.length} 张效果图并发送通知`,
      success: async res => {
        if (!res.confirm) return
        this.setData({ delivering: true })
        try {
          await staffRequest(
            `${app.globalData.serverUrl}/api/admin/deliver/${this.data.orderId}`,
            'POST',
            { filenames }
          )
          this.setData({ 'order.status': 'delivered' })
          wx.showToast({ title: '交付成功，已通知藏家', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 1500)
        } catch (e) {
          const msg = (e && e.data && e.data.error) || (e && e.statusCode ? `HTTP ${e.statusCode}` : '网络错误')
          wx.showModal({ title: '交付失败', content: msg, showCancel: false })
        } finally {
          this.setData({ delivering: false })
        }
      }
    })
  }
})
