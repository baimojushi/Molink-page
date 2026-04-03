const app = getApp()
const { request } = require('../../utils/helper')

const SERVICE_LABELS = {
  hang_artwork: '作品挂进家',
  recommend_artwork: '为空间推荐作品',
  recommend_space: '为作品推荐空间设计'
}

// 每种服务需要上传的图片配置
const UPLOAD_CONFIG = {
  hang_artwork: [
    { key: 'artwork', label: '上传作品图片', hint: '请拍摄或上传您的藏品照片' },
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_artwork: [
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_space: [
    { key: 'artwork', label: '上传作品图片', hint: '请拍摄或上传您的藏品照片' }
  ]
}

Page({
  data: {
    service: '',
    serviceLabel: '',
    uploadConfig: [],
    images: {},       // { artwork: 'tempPath', space: 'tempPath' }
    email: '',
    showEmail: false,
    submitting: false
  },

  onLoad(options) {
    const service = options.service
    this.setData({
      service,
      serviceLabel: SERVICE_LABELS[service],
      uploadConfig: UPLOAD_CONFIG[service] || []
    })
  },

  // 选择图片
  chooseImage(e) {
    const key = e.currentTarget.dataset.key
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: res => {
        const path = res.tempFiles[0].tempFilePath
        this.setData({ [`images.${key}`]: path })
      }
    })
  },

  // 删除图片
  removeImage(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ [`images.${key}`]: '' })
  },

  // 切换邮箱显示
  toggleEmail() {
    this.setData({ showEmail: !this.data.showEmail })
  },

  onEmailInput(e) {
    this.setData({ email: e.detail.value })
  },

  // 检查是否所有必要图片已上传
  checkImages() {
    for (const cfg of this.data.uploadConfig) {
      if (!this.data.images[cfg.key]) return false
    }
    return true
  },

  // 提交订单
  async submitOrder() {
    if (!this.checkImages()) {
      wx.showToast({ title: '请上传所有需要的图片', icon: 'none' })
      return
    }

    // 先请求订阅消息授权（融入提交流程，用户点提交时顺带完成）
    try {
      await this.requestSubscribe()
    } catch (e) {
      // 用户拒绝也继续提交
    }

    this.setData({ submitting: true })

    try {
      // 上传图片并提交订单
      const formData = {
        deviceId: app.globalData.deviceId,
        service: this.data.service,
        email: this.data.email || ''
      }

      // 上传图片文件
      const uploadedImages = {}
      for (const cfg of this.data.uploadConfig) {
        const path = this.data.images[cfg.key]
        if (path) {
          const res = await this.uploadFile(path, cfg.key)
          uploadedImages[cfg.key] = res.fileUrl
        }
      }

      // 提交订单
      const result = await request(
        `${app.globalData.serverUrl}/api/client/submit`,
        'POST',
        { ...formData, images: uploadedImages }
      )

      // 保存订单ID到本地
      wx.setStorageSync('lastOrderId', result.orderId)
      wx.setStorageSync('lastOrderStatus', 'pending')
      app.globalData.currentOrderId = result.orderId

      // 跳转到等待页
      wx.redirectTo({
        url: `/pages/waiting/waiting?orderId=${result.orderId}`
      })
    } catch (e) {
      wx.showToast({ title: '提交失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  // 上传单个文件
  uploadFile(filePath, fileType) {
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: `${app.globalData.serverUrl}/api/client/upload`,
        filePath,
        name: 'file',
        formData: { fileType },
        success: res => {
          const data = JSON.parse(res.data)
          resolve(data)
        },
        fail: reject
      })
    })
  },

  // 请求订阅消息权限（嵌入提交流程）
  requestSubscribe() {
    return new Promise((resolve, reject) => {
      wx.requestSubscribeMessage({
        tmplIds: ['替换为你的订阅消息模板ID'], // 注册后填入
        success: resolve,
        fail: reject
      })
    })
  }
})
