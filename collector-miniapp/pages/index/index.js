const app = getApp()

Page({
  data: {
    services: [
      {
        id: 'hang_artwork',
        title: '作品挂进家',
        desc: '将您的藏品悬挂于理想空间，生成真实效果图',
        icon: '🖼'
      },
      {
        id: 'recommend_artwork',
        title: '为空间推荐作品',
        desc: '根据您的居住空间，为您精选合适的艺术作品',
        icon: '🏠'
      },
      {
        id: 'recommend_space',
        title: '为作品推荐空间设计',
        desc: '根据您的藏品风格，为您规划空间陈设方案',
        icon: '✨'
      }
    ],
    selectedService: null
  },

  onLoad() {
    // 如果有未完成的订单，直接跳到等待/结果页
    const lastOrderId = wx.getStorageSync('lastOrderId')
    const lastOrderStatus = wx.getStorageSync('lastOrderStatus')
    if (lastOrderId && lastOrderStatus !== 'viewed') {
      wx.redirectTo({
        url: `/pages/waiting/waiting?orderId=${lastOrderId}`
      })
    }
  },

  selectService(e) {
    const serviceId = e.currentTarget.dataset.id
    this.setData({ selectedService: serviceId })
  },

  goNext() {
    if (!this.data.selectedService) {
      wx.showToast({ title: '请先选择服务', icon: 'none' })
      return
    }
    wx.navigateTo({
      url: `/pages/upload/upload?service=${this.data.selectedService}`
    })
  }
})
