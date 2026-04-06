const app = getApp()

const SERVICE_LABELS = {
  hang_in_home: '作品挂进家',
  recommend_work: '为空间推荐作品',
  recommend_space: '一画一宅'
}

const COMPLETION_TEMPLATE_ID = 'WBedF813hIJYRHpG0Gki9vU40Z3EoaKDmrXVC8lD4sY'

const UPLOAD_CONFIG = {
  hang_in_home: [
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_work: [
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_space: []
}

function normalizeArtwork(serverUrl, artwork) {
  const images = Array.isArray(artwork.images) ? artwork.images.map(img => {
    if (!img) return ''
    return img.startsWith('http') ? img : `${serverUrl}${img.startsWith('/') ? '' : '/'}${img}`
  }) : []

  return Object.assign({}, artwork, { images })
}

function extractCandidates(raw) {
  const text = String(raw || '').trim()
  const candidates = []
  if (!text) return candidates

  candidates.push(text)

  try {
    const parsed = JSON.parse(text)
    ;['num', 'id', 'artwork_num', 'code', 'qrCode'].forEach(key => {
      if (parsed && parsed[key]) candidates.push(String(parsed[key]))
    })
  } catch (e) {}

  try {
    const url = new URL(text)
    ;['num', 'id', 'artwork', 'artwork_num', 'code'].forEach(key => {
      const value = url.searchParams.get(key)
      if (value) candidates.push(value)
    })
    const pathname = url.pathname.split('/').filter(Boolean)
    if (pathname.length > 0) candidates.push(pathname[pathname.length - 1])
  } catch (e) {}

  return [...new Set(candidates.filter(Boolean).map(item => decodeURIComponent(String(item)).trim()))]
}

Page({
  data: {
    service: '',
    serviceLabel: '',
    uploadConfig: [],
    images: {},
    artworkSize: '',
    notes: '',
    extraOptimize: true,
    email: '',
    submitting: false,
    presetArtwork: null,
    showArtworkSelect: false,
    showExtraOptimize: false,
    serverUrl: '',
    artworks: [],
    filteredArtworks: [],
    artworkSearchKeyword: '',
    artworkPanelOpen: false,
    loadingArtworks: false,
    artworkCount: 0,
    scanLoading: false,
    showArtworkPreview: false,
    artworkPreviewUrl: ''
  },

  onLoad(options) {
    const service = options.service
    const showArtworkSelect = service === 'hang_in_home'
    this.setData({
      service,
      serviceLabel: SERVICE_LABELS[service],
      uploadConfig: UPLOAD_CONFIG[service] || [],
      showExtraOptimize: service === 'hang_in_home' || service === 'recommend_work',
      showArtworkSelect,
      serverUrl: app.globalData.serverUrl
    })

    if (showArtworkSelect) {
      this.loadArtworks()
    }
  },

  async loadArtworks(forceRefresh = false) {
    if (this.data.loadingArtworks) return
    if (!forceRefresh && this.data.artworks.length > 0) {
      this.applyArtworkFilter(this.data.artworkSearchKeyword)
      return
    }

    this.setData({ loadingArtworks: true })
    try {
      const artworks = await new Promise((resolve, reject) => {
        wx.request({
          url: `${app.globalData.serverUrl}/api/client/artworks`,
          success: res => {
            if (res.statusCode === 200 && Array.isArray(res.data.artworks)) {
              resolve(res.data.artworks)
            } else {
              reject(new Error('作品列表加载失败'))
            }
          },
          fail: reject
        })
      })

      const normalized = artworks.map(item => normalizeArtwork(app.globalData.serverUrl, item))
      this.setData({
        artworks: normalized,
        artworkCount: normalized.length
      })
      this.applyArtworkFilter(this.data.artworkSearchKeyword)
    } catch (e) {
      wx.showToast({ title: '作品列表加载失败', icon: 'none' })
    } finally {
      this.setData({ loadingArtworks: false })
    }
  },

  applyArtworkFilter(keyword = '') {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase()
    const filtered = this.data.artworks.filter(item => {
      if (!normalizedKeyword) return true
      const haystack = [item.num, item.id, item.name, item.author, item.medium, item.size]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedKeyword)
    })

    this.setData({
      artworkSearchKeyword: keyword,
      filteredArtworks: filtered
    })
  },

  openArtworkPanel() {
    this.setData({ artworkPanelOpen: true })
    this.loadArtworks()
    this.applyArtworkFilter(this.data.artworkSearchKeyword)
  },

  closeArtworkPanel() {
    this.setData({ artworkPanelOpen: false })
  },

  onArtworkSearchInput(e) {
    this.applyArtworkFilter(e.detail.value)
  },

  chooseArtwork(e) {
    const artwork = e.currentTarget.dataset.artwork
    this.setData({
      presetArtwork: artwork,
      artworkPanelOpen: false,
      artworkSearchKeyword: ''
    })
    this.applyArtworkFilter('')
  },

  clearArtwork() {
    this.setData({ presetArtwork: null })
  },

  async scanArtwork() {
    if (this.data.scanLoading) return
    if (this.data.artworks.length === 0) {
      await this.loadArtworks()
    }

    this.setData({ scanLoading: true })
    wx.scanCode({
      success: res => {
        const candidates = extractCandidates(res.result)
        const matched = this.data.artworks.find(item => {
          const exactPool = [item.num, item.id, item.code, item.qrCode, item.qrcode]
            .filter(Boolean)
            .map(value => String(value).trim().toLowerCase())
          if (candidates.some(candidate => exactPool.includes(candidate.toLowerCase()))) {
            return true
          }
          return candidates.some(candidate => {
            const normalized = candidate.toLowerCase()
            return [item.num, item.name]
              .filter(Boolean)
              .map(value => String(value).trim().toLowerCase())
              .some(value => value.includes(normalized) || normalized.includes(value))
          })
        })

        if (!matched) {
          wx.showToast({ title: '未找到对应作品，请改用检索', icon: 'none' })
          return
        }

        this.setData({
          presetArtwork: matched,
          artworkPanelOpen: false,
          artworkSearchKeyword: ''
        })
        this.applyArtworkFilter('')
      },
      fail: err => {
        if (err && err.errMsg && err.errMsg.includes('cancel')) return
        wx.showToast({ title: '扫码失败，请重试', icon: 'none' })
      },
      complete: () => {
        this.setData({ scanLoading: false })
      }
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

  openArtworkPreview(e) {
    const src = e.currentTarget.dataset.src || ''
    if (!src) return
    this.setData({
      showArtworkPreview: true,
      artworkPreviewUrl: src
    })
  },

  closeArtworkPreview() {
    this.setData({
      showArtworkPreview: false,
      artworkPreviewUrl: ''
    })
  },

  noop() {},

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

  onExtraOptimizeChange(e) {
    this.setData({ extraOptimize: !!e.detail.value })
  },

  checkImages() {
    if (this.data.showArtworkSelect && !this.data.presetArtwork) return false
    for (const cfg of this.data.uploadConfig) {
      if (!this.data.images[cfg.key]) return false
    }
    return true
  },

  async requestCompletionSubscribe() {
    if (!app.globalData.openid || !wx.requestSubscribeMessage) {
      return { accepted: false, templateId: '' }
    }

    return new Promise(resolve => {
      wx.requestSubscribeMessage({
        tmplIds: [COMPLETION_TEMPLATE_ID],
        success: res => {
          resolve({
            accepted: res && res[COMPLETION_TEMPLATE_ID] === 'accept',
            templateId: COMPLETION_TEMPLATE_ID
          })
        },
        fail: () => resolve({ accepted: false, templateId: '' })
      })
    })
  },

  async submitOrder() {
    if (!this.checkImages()) {
      const msg = this.data.showArtworkSelect && !this.data.presetArtwork
        ? '请先选择参展作品'
        : '请上传所需的图片'
      wx.showToast({ title: msg, icon: 'none' })
      return
    }

    this.setData({ submitting: true })

    try {
      const subscribeResult = await this.requestCompletionSubscribe()
      const filenames = {}
      const artwork = this.data.presetArtwork
      const configs = this.data.uploadConfig
      const images = this.data.images

      if (artwork && artwork.images && artwork.images[0]) {
        filenames.artwork = artwork.images[0]
      }

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
              } catch (e) {
                reject(e)
              }
            },
            fail: reject
          })
        })
        filenames[cfg.key] = filename
      }

      const result = await new Promise((resolve, reject) => {
        wx.request({
          url: `${app.globalData.serverUrl}/api/client/submit`,
          method: 'POST',
          header: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: {
            service_type: this.data.service,
            device_uuid: app.globalData.deviceId,
            receive_target: this.data.email || 'miniapp',
            extra_service: this.data.extraOptimize ? '1' : '0',
            artwork_filename: filenames.artwork || '',
            space_filename: filenames.space || '',
            artwork_size: artwork ? (artwork.size || '') : (this.data.artworkSize || ''),
            artwork_num: artwork ? String(artwork.num || '') : '',
            artwork_name: artwork ? (artwork.name || '') : '',
            notes: this.data.notes || '',
            openid: app.globalData.openid || '',
            user_nickname: app.globalData.userNickname || '',
            user_avatar: app.globalData.userAvatar || '',
            subscribe_completion: subscribeResult.accepted ? '1' : '0',
            subscribe_template_id: subscribeResult.accepted ? subscribeResult.templateId : ''
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
      wx.showModal({ title: '提交失败', content: msg || '未知错误', showCancel: false })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
