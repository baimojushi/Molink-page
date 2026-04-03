const app = getApp()

Page({
  data: {
    username: '',
    password: '',
    loading: false
  },

  onLoad() {
    // 已登录直接跳转
    if (app.isLoggedIn()) {
      wx.redirectTo({ url: '/pages/orders/orders' })
    }
  },

  onUsernameInput(e) {
    this.setData({ username: e.detail.value })
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value })
  },

  async login() {
    const { username, password } = this.data
    if (!username || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' })
      return
    }

    this.setData({ loading: true })

    wx.request({
      url: `${app.globalData.serverUrl}/api/admin/login`,
      method: 'POST',
      data: { username, password },
      header: { 'Content-Type': 'application/json' },
      success: res => {
        if (res.statusCode === 200 && res.data.token) {
          app.globalData.token = res.data.token
          app.globalData.staffName = res.data.name || username
          wx.setStorageSync('staffToken', res.data.token)
          wx.setStorageSync('staffName', res.data.name || username)

          // 登录成功后订阅新订单通知
          this.subscribeNewOrder()

          wx.redirectTo({ url: '/pages/orders/orders' })
        } else {
          wx.showToast({ title: '账号或密码错误', icon: 'none' })
        }
      },
      fail: () => {
        wx.showToast({ title: '网络错误，请重试', icon: 'none' })
      },
      complete: () => {
        this.setData({ loading: false })
      }
    })
  },

  // 订阅新订单通知
  subscribeNewOrder() {
    wx.requestSubscribeMessage({
      tmplIds: ['替换为工作人员端订阅消息模板ID'], // 注册后填入
      success: () => {},
      fail: () => {}
    })
  }
})
