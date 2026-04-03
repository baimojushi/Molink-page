const app = getApp()

Page({
  data: {
    secret: '',
    loading: false
  },

  onLoad() {
    if (app.isLoggedIn()) {
      wx.redirectTo({ url: '/pages/staff-orders/staff-orders' })
    }
  },

  onSecretInput(e) { this.setData({ secret: e.detail.value }) },

  async login() {
    const { secret } = this.data
    if (!secret) {
      wx.showToast({ title: '请输入管理密钥', icon: 'none' })
      return
    }

    this.setData({ loading: true })

    // 用密钥请求订单列表来验证是否正确
    wx.request({
      url: `${app.globalData.serverUrl}/api/admin/orders`,
      method: 'GET',
      header: { 'x-admin-secret': secret },
      success: res => {
        if (res.statusCode === 200) {
          // 密钥正确，保存到本地
          app.globalData.token = secret
          wx.setStorageSync('staffToken', secret)

          // 订阅新订单通知
          wx.requestSubscribeMessage({
            tmplIds: ['填入工作人员端通知模板ID'], // 审核后填入
            success: () => {},
            fail: () => {}
          })

          wx.redirectTo({ url: '/pages/staff-orders/staff-orders' })
        } else {
          wx.showToast({ title: '密钥错误，请重试', icon: 'none' })
        }
      },
      fail: () => {
        wx.showToast({ title: '网络错误，请重试', icon: 'none' })
      },
      complete: () => {
        this.setData({ loading: false })
      }
    })
  }
})
