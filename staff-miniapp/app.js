App({
  globalData: {
    token: '',
    staffName: '',
    serverUrl: 'https://你的后端域名.railway.app' // 注册好后填入
  },

  onLaunch() {
    const token = wx.getStorageSync('staffToken')
    const staffName = wx.getStorageSync('staffName')
    if (token) {
      this.globalData.token = token
      this.globalData.staffName = staffName
    }
  },

  isLoggedIn() {
    return !!this.globalData.token
  },

  logout() {
    this.globalData.token = ''
    this.globalData.staffName = ''
    wx.removeStorageSync('staffToken')
    wx.removeStorageSync('staffName')
    wx.reLaunch({ url: '/pages/login/login' })
  }
})
