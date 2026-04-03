const app = getApp()

const SERVICE_LABELS = {
  hang_in_home: '作品挂进家',
  recommend_work: '为空间推荐作品',
  recommend_space: '一画一宅'
}

const UPLOAD_CONFIG = {
  hang_in_home: [
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_work: [
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_space: []
}

Page({
  data: {
    service: '',
    serviceLabel: '',
    uploadConfig: [],
    images: {},
    artworkSize: '',
    notes: '',
    extraOptimize: false,
    email: '',
    submitting: false,
    presetArtwork: null,
    showArtworkSelect: false,
    serverUrl: ''
  },

  onLoad(options) {
    const service = options.service
    this.setData({
      service,
      serviceLabel: SERVICE_LABELS[service],
      uploadConfig: UPLOAD_CONFIG[service] || [],
      showNotes: service === 'recommend_space',
      showExtraOptimize: service === 'hang_in_home' || service === 'recommend_work',
      showArtworkSelect: service === 'hang_in_home' || service === 'recommend_space',
      serverUrl: app.globalData.serverUrl
    })
  },

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

  removeImage(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ [`images.${key}`]: '' })
  },

  previewImage(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.src,
      urls: [e.currentTarget.dataset.src]
    })
  },

  goSelectArtwork() {
    wx.navigateTo({ url: '/pages/select-artwork/select-artwork' })
  },

  clearArtwork() {
    this.setData({ presetArtwork: null })
  },

  toggleEmail() {
    this.setData({ showEmail: !this.data.showEmail })
  },

  onEmailInput(e) {
    this.setData({ email: e.detail.value })
  },

  onSizeInput(e) {
    this.setData({ artworkSize: e.detail.value })
  },

  onNotesInput(e) {
    this.setData({ notes: e.detail.value })
  },

  toggleExtraOptimize() {
    this.setData({ extraOptimize: !this.data.extraOptimize })
  },

  checkImages() {
    if (this.data.showArtworkSelect && !this.data.presetArtwork) return false
    for (const cfg of this.data.uploadConfig) {
      if (!this.data.images[cfg.key]) return false
    }
    return true
  },

  async submitOrder() {
    if (!this.checkImages()) {
      const msg = (this.data.showArtworkSelect && !this.data.presetArtwork)
        ? '请先选择参展作品' : '请上传所需的图片'
      wx.showToast({ title: msg, icon: 'none' })
      return
    }

    this.setData({ submitting: true })

    try {
      const configs = this.data.uploadConfig
      const images = this.data.images
      const filenames = {}

      // 预设作品直接使用服务器完整 URL，无需上传
      if (this.data.presetArtwork) {
        const imgPath = this.data.presetArtwork.images[0]
        filenames['artwork'] = imgPath.startsWith('http') ? imgPath : `${app.globalData.serverUrl}${imgPath.startsWith('/') ? '' : '/'}${imgPath}`
      }

      // 逐张上传图片，拿回文件名
      for (const cfg of configs) {
        const filename = await new Promise((resolve, reject) => {
          wx.uploadFile({
            url: `${app.globalData.serverUrl}/api/client/upload-image`,
            filePath: images[cfg.key],
            name: 'image',
            success: res => {
              try {
                const data = JSON.parse(res.data)
                if (res.statusCode === 200) resolve(data.filename)
                else reject(data)
              } catch (e) { reject(e) }
            },
            fail: reject
          })
        })
        filenames[cfg.key] = filename
      }

      // 提交订单（带文件名）
      const artwork = this.data.presetArtwork
      const result = await new Promise((resolve, reject) => {
        wx.request({
          url: `${app.globalData.serverUrl}/api/client/submit`,
          method: 'POST',
          header: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: {
            service_type: this.data.service,
            device_uuid: app.globalData.deviceId,
            receive_target: this.data.email || 'miniapp',
            artwork_filename: filenames['artwork'] || '',
            space_filename: filenames['space'] || '',
            artwork_size: artwork ? (artwork.size || '') : (this.data.artworkSize || ''),
            artwork_num: artwork ? String(artwork.num) : '',
            artwork_name: artwork ? (artwork.name || '') : '',
            openid: app.globalData.openid || '',
            user_nickname: app.globalData.userNickname || '',
            user_avatar: app.globalData.userAvatar || ''
          },
          success: res => {
            if (res.statusCode === 200) resolve(res.data)
            else reject(res.data)
          },
          fail: reject
        })
      })

      wx.setStorageSync('lastOrderId', result.orderId)
      wx.setStorageSync('lastOrderStatus', 'pending')
      app.globalData.currentOrderId = result.orderId

      wx.redirectTo({
        url: `/pages/waiting/waiting?orderId=${result.orderId}`
      })
    } catch (e) {
      const msg = e && (e.errMsg || e.error || JSON.stringify(e))
      wx.showModal({
        title: '提交失败',
        content: msg || '未知错误',
        showCancel: false
      })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
