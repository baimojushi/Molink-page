const { generateDeviceId } = require('./utils/helper')

App({
  globalData: {
    deviceId: '',
    currentOrderId: null,
    serverUrl: 'https://www.molink.art',
    token: '',
    staffName: '',
    openid: '',
    userNickname: '',
    userAvatar: '',
    // 合作方小程序配置（填入后自动在效果图页展示跳转入口）
    partnerAppId: '',       // 填入合作方小程序 AppID，如 'wx1234567890abcdef'
    partnerPath: '',        // 填入合作方目标页路径，如 'pages/shop/index'
    // 微信订阅消息模板ID（在微信公众平台申请通过后填入）
    wxSubTemplateId: ''     // 填入后用户可在等待页开启完成通知
  },

  onLaunch() {
    // 初始化设备ID（藏家匿名身份）
    let deviceId = wx.getStorageSync('deviceId')
    if (!deviceId) {
      deviceId = generateDeviceId()
      wx.setStorageSync('deviceId', deviceId)
    }
    this.globalData.deviceId = deviceId

    // 恢复上次订单
    const lastOrderId = wx.getStorageSync('lastOrderId')
    if (lastOrderId) {
      this.globalData.currentOrderId = lastOrderId
    }

    // 恢复工作人员登录状态
    const token = wx.getStorageSync('staffToken')
    if (token) {
      this.globalData.token = token
    }

    // 恢复微信登录状态
    const openid = wx.getStorageSync('openid')
    if (openid) {
      this.globalData.openid = openid
      this.globalData.userNickname = wx.getStorageSync('userNickname') || ''
      this.globalData.userAvatar = wx.getStorageSync('userAvatar') || ''
    }
  },

  // 微信登录：code换openid + 获取用户昵称头像
  wxLogin(nickname, avatar) {
    return new Promise((resolve, reject) => {
      wx.login({
        success: loginRes => {
          wx.request({
            url: `${this.globalData.serverUrl}/api/client/wx-login`,
            method: 'POST',
            header: { 'Content-Type': 'application/json' },
            data: { code: loginRes.code, nickname, avatar },
            success: res => {
              if (res.statusCode === 200 && res.data.openid) {
                const { openid, nickname: nick, avatar: ava } = res.data
                this.globalData.openid = openid
                this.globalData.userNickname = nick || nickname || ''
                this.globalData.userAvatar = ava || avatar || ''
                wx.setStorageSync('openid', openid)
                wx.setStorageSync('userNickname', this.globalData.userNickname)
                wx.setStorageSync('userAvatar', this.globalData.userAvatar)
                resolve(res.data)
              } else {
                reject(res.data)
              }
            },
            fail: reject
          })
        },
        fail: reject
      })
    })
  },

  isLoggedIn() {
    return !!this.globalData.token
  },

  logout() {
    this.globalData.token = ''
    this.globalData.staffName = ''
    wx.removeStorageSync('staffToken')
    wx.removeStorageSync('staffName')
    wx.reLaunch({ url: '/pages/index/index' })
  }
})
