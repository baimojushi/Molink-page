const { generateDeviceId } = require('./utils/helper')

App({
  globalData: {
    deviceId: '',
    currentOrderId: null,
    serverUrl: 'https://你的后端域名.railway.app' // 注册好后填入
  },

  onLaunch() {
    // 获取或生成设备ID，用于匿名追踪订单
    let deviceId = wx.getStorageSync('deviceId')
    if (!deviceId) {
      deviceId = generateDeviceId()
      wx.setStorageSync('deviceId', deviceId)
    }
    this.globalData.deviceId = deviceId

    // 恢复上次订单ID
    const lastOrderId = wx.getStorageSync('lastOrderId')
    if (lastOrderId) {
      this.globalData.currentOrderId = lastOrderId
    }
  }
})
