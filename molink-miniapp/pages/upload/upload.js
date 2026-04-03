const app = getApp()
const version = require('../../version')

const SERVICE_LABELS = {
  hang_in_home: '作品挂进家',
  recommend_work: '为空间推荐作品',
  recommend_space: '一画一宅'
}

const UPLOAD_CONFIG = {
  hang_in_home: [
    { key: 'artwork', label: '上传作品图片', hint: '请拍摄或上传您心仪的书画照片', showSize: true },
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_work: [
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_space: [
    { key: 'artwork', label: '上传作品图片', hint: '请拍摄或上传您心仪的书画照片', showSize: true }
  ]
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

    // 国拍版
    isAuctionVersion: false,
    artworkSource: 'upload',   // 'upload' | 'select'
    artworkList: [],
    selectedArtwork: null
  },

  onLoad(options) {
    const service = options.service
    const isAuction = version.isAuctionVersion
    this.setData({
      service,
      serviceLabel: SERVICE_LABELS[service],
      uploadConfig: UPLOAD_CONFIG[service] || [],
      showNotes: service === 'recommend_space',
      showExtraOptimize: service === 'hang_in_home' || service === 'recommend_work',
      isAuctionVersion: isAuction
    })

    // 国拍版且需要选作品时，提前加载作品库
    const needsArtwork = service === 'hang_in_home' || service === 'recommend_space'
    if (isAuction && needsArtwork) {
      this.loadArtworkList()
    }
  },

  loadArtworkList() {
    wx.request({
      url: `${app.globalData.serverUrl}/api/client/artworks`,
      method: 'GET',
      success: res => {
        if (res.statusCode === 200) {
          const list = (res.data.artworks || []).map(a => ({
            ...a,
            thumbUrl: `${app.globalData.serverUrl}${a.images[0]}`
          }))
          this.setData({ artworkList: list })
        }
      }
    })
  },

  switchArtworkSource(e) {
    const source = e.currentTarget.dataset.source
    this.setData({
      artworkSource: source,
      'images.artwork': '',
      selectedArtwork: null,
      artworkSize: ''
    })
  },

  selectArtwork(e) {
    const aw = e.currentTarget.dataset.artwork
    this.setData({
      selectedArtwork: aw,
      artworkSize: aw.size
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
    for (const cfg of this.data.uploadConfig) {
      if (cfg.key === 'artwork') {
        // 作品图：上传或从作品库选，二者满足其一即可
        if (!this.data.images[cfg.key] && !this.data.selectedArtwork) return false
      } else {
        if (!this.data.images[cfg.key]) return false
      }
    }
    return true
  },

  async submitOrder() {
    if (!this.checkImages()) {
      wx.showToast({ title: '请上传或选择所需的图片', icon: 'none' })
      return
    }

    this.setData({ submitting: true })

    try {
      const configs = this.data.uploadConfig
      const images = this.data.images
      const filenames = {}

      for (const cfg of configs) {
        // 作品图且用户选了作品库，跳过上传
        if (cfg.key === 'artwork' && this.data.selectedArtwork) continue
        if (!images[cfg.key]) continue

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

      const sel = this.data.selectedArtwork

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
            artwork_size: this.data.artworkSize || '',
            artwork_num: sel ? sel.num : '',
            artwork_name: sel ? sel.name : '',
            extra_service: this.data.extraOptimize ? '1' : '0',
            notes: this.data.notes || '',
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
