const app = getApp()
const { trackClientEvent, getAnalyticsSessionId } = require('../../utils/helper')
const { normalizeArtwork, matchArtworkByReference } = require('../../utils/artwork')
const { decorateArtworkThumbs, prepareImageAsset, safeFileSize } = require('../../utils/image')

const SERVICE_LABELS = {
  hang_in_home: '作品挂进家',
  recommend_work: '为空间推荐作品',
  recommend_space: '一画一宅'
}

const COMPLETION_TEMPLATE_ID = 'WBedF813hIJYRHpG0Gki9vU40Z3EoaKDmrXVC8lD4sY'
const ARTWORK_CACHE_PREFIX = 'molink_artworks_cache_v6_price'
const ARTWORK_CACHE_TTL = 10 * 60 * 1000

const UPLOAD_CONFIG = {
  hang_in_home: [
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_work: [
    { key: 'space', label: '上传空间图片', hint: '请拍摄或上传您的居室照片' }
  ],
  recommend_space: []
}

function safeDecode(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (error) {
    return value
  }
}

function parseSceneMap(scene) {
  const raw = safeDecode(scene)
  if (!raw) return {}

  if (!raw.includes('=') && !raw.includes('&')) {
    return { artworkCode: raw }
  }

  return raw.split('&').reduce((accumulator, pair) => {
    const [key, value] = pair.split('=')
    if (key) {
      accumulator[key] = value ? safeDecode(value) : ''
    }
    return accumulator
  }, {})
}

function resolveArtworkRefFromOptions(options = {}) {
  const sceneMap = parseSceneMap(options.scene)
  const direct = [
    options.artworkCode,
    options.artwork_code,
    options.artworkNum,
    options.artwork_num,
    sceneMap.artworkCode,
    sceneMap.artwork_code,
    sceneMap.artworkNum,
    sceneMap.artwork_num,
    sceneMap.code,
    sceneMap.num,
    sceneMap.id
  ].find(Boolean)

  return direct ? String(direct).trim() : ''
}

function resolveArtworkIdFromOptions(options = {}) {
  return String(options.artworkId || options.artwork_id || '').trim()
}

function buildArtworkResolveUrl(serverUrl, artworkRef, artworkId = '', exhibitionId = '') {
  const query = []
  if (artworkId) query.push(`artwork_id=${encodeURIComponent(String(artworkId).trim())}`)
  else query.push(`code=${encodeURIComponent(String(artworkRef || '').trim())}`)
  if (exhibitionId) query.push(`exhibition_id=${encodeURIComponent(String(exhibitionId).trim())}`)
  return `${serverUrl}/api/client/artworks/resolve?${query.join('&')}`
}

function normalizeScannedPath(path) {
  const text = safeDecode(String(path || '').trim())
  if (!text) return ''

  if (text.startsWith('/')) return text

  const purePath = text.split('?')[0]
  if (purePath.startsWith('pages/')) return `/${text}`

  try {
    const parsed = new URL(text)
    const target = `${parsed.pathname || ''}${parsed.search || ''}`
    if (target.startsWith('/pages/')) return target
  } catch (error) {}

  return ''
}

function getScanPathCandidates(scanRes = {}) {
  const resultText = String(scanRes.result || '').trim()
  const pathCandidates = [
    scanRes.path,
    normalizeScannedPath(resultText)
  ].filter(Boolean)

  if (resultText) {
    try {
      const parsed = new URL(resultText)
      const innerPath = parsed.searchParams.get('path') || parsed.searchParams.get('page') || ''
      const normalizedInnerPath = normalizeScannedPath(innerPath)
      if (normalizedInnerPath) pathCandidates.push(normalizedInnerPath)
    } catch (error) {}
  }

  return [...new Set(pathCandidates.map(item => normalizeScannedPath(item)).filter(Boolean))]
}

function isMiniProgramPagePath(path = '') {
  return /^\/pages\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\?.*)?$/.test(String(path || '').trim())
}

Page({
  imageProcessTokens: {},
  funnelRequiredReadyTracked: false,
  emailInputTracked: false,
  lastTrackedArtworkSearchKeyword: '',


  data: {
    service: '',
    serviceLabel: '',
    uploadConfig: [],
    images: {},
    imageAssets: {},
    imageProcessing: {},
    artworkSize: '',
    notes: '',
    extraOptimize: true,
    email: '',
    submitting: false,
    submitProgress: 0,
    submitStage: '',
    submitStageText: '',
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
    artworkPreviewUrl: '',
    initialArtworkRef: '',
    initialArtworkId: '',
    exhibitionId: '',
    exhibitionName: '',
    exhibitionStatus: '',
    entrySource: 'service_selected',
    entryScene: '',
    artworkSelectionMethod: '',
    artworkSelectionKeyword: ''
  },

  onLoad(options) {
    this.funnelRequiredReadyTracked = false
    this.emailInputTracked = false
    this.lastTrackedArtworkSearchKeyword = ''

    const service = options.service
    const showArtworkSelect = service === 'hang_in_home'
    const initialArtworkRef = showArtworkSelect ? resolveArtworkRefFromOptions(options) : ''
    const initialArtworkId = showArtworkSelect ? resolveArtworkIdFromOptions(options) : ''
    const currentExhibition = app.getCurrentExhibition()
    const exhibitionId = String(options.exhibition_id || currentExhibition.id || '').trim()

    if (!exhibitionId) {
      wx.reLaunch({ url: '/pages/select-exhibition/index' })
      return
    }

    const presetSelectionMethod = this.resolveInitialSelectionMethod(options, initialArtworkRef)
    const entrySource = initialArtworkRef ? 'scan_entry' : 'service_selected'
    this.setData({
      service,
      serviceLabel: SERVICE_LABELS[service],
      uploadConfig: UPLOAD_CONFIG[service] || [],
      showExtraOptimize: service === 'hang_in_home' || service === 'recommend_work',
      showArtworkSelect,
      serverUrl: app.globalData.serverUrl,
      initialArtworkRef,
      initialArtworkId,
      exhibitionId,
      exhibitionName: currentExhibition.name || '',
      exhibitionStatus: currentExhibition.status || '',
      entrySource,
      entryScene: options.scene || '',
      artworkSelectionMethod: presetSelectionMethod,
      artworkSelectionKeyword: ''
    })

    trackClientEvent('upload_page_view', {
      page_name: 'upload',
      service_type: service,
      entry_source: entrySource,
      artwork_id: initialArtworkId || '',
      artwork_code: initialArtworkRef || '',
      exhibition_id: exhibitionId,
      artwork_selection_method: presetSelectionMethod || ''
    })

    if (showArtworkSelect && (initialArtworkId || initialArtworkRef)) {
      this.resolveInitialArtworkPreset(initialArtworkRef, initialArtworkId)
    }
  },


  resolveInitialSelectionMethod(options = {}, initialArtworkRef = '') {
    if (!initialArtworkRef) return ''
    const raw = String(
      options.selection_method || options.artwork_selection_method || options.selectionMethod || ''
    ).trim()
    return raw || 'scan_entry_qr'
  },

  buildArtworkSelectionLabel(method) {
    const map = {
      scan_entry_qr: '现场扫小程序码选定',
      search_select: '搜索选定作品',
      list_select: '滑动作品列表选定',
      upload_scan_button: '作品检索旁扫码按钮选定'
    }
    return map[method] || ''
  },

  getSelectedArtworkPayload() {
    const artwork = this.data.presetArtwork || {}
    return {
      artwork_id: artwork && artwork.id ? artwork.id : '',
      artwork_code: artwork && (artwork.artwork_code || artwork.code) ? (artwork.artwork_code || artwork.code) : (this.data.initialArtworkRef || ''),
      exhibition_id: artwork.exhibition_id || this.data.exhibitionId || app.globalData.currentExhibitionId || '',
      artwork_selection_method: this.data.artworkSelectionMethod || ''
    }
  },

  trackUploadFunnel(eventName, payload = {}) {
    if (!eventName) return
    trackClientEvent(eventName, Object.assign({
      page_name: 'upload',
      service_type: this.data.service,
      entry_source: this.data.entrySource || '',
      has_artwork_selected: !!this.data.presetArtwork,
      has_space_image: !!this.data.images.space,
      has_artwork_image: !!this.data.images.artwork,
      has_email: !!String(this.data.email || '').trim()
    }, this.getSelectedArtworkPayload(), payload || {}))
  },

  trackRequiredReadyIfNeeded(trigger = '') {
    if (this.funnelRequiredReadyTracked) return
    if (!this.checkImages()) return
    this.funnelRequiredReadyTracked = true
    this.trackUploadFunnel('required_input_ready', { trigger })
  },

  setArtworkSelectionMethod(method) {
    this.setData({ artworkSelectionMethod: method || '' })
  },

  appendQueryParam(url, key, value) {
    const [base, hash = ''] = String(url || '').split('#')
    const joiner = base.includes('?') ? '&' : '?'
    return `${base}${joiner}${key}=${encodeURIComponent(value || '')}${hash ? `#${hash}` : ''}`
  },

  decorateArtwork(item) {
    try {
      return decorateArtworkThumbs(
        app.globalData.serverUrl,
        normalizeArtwork(app.globalData.serverUrl, item),
        360
      )
    } catch (error) {
      console.warn('decorate artwork failed:', error)
      return normalizeArtwork(app.globalData.serverUrl, item)
    }
  },

  getArtworkCacheKey() {
    return `${ARTWORK_CACHE_PREFIX}:${this.data.exhibitionId || app.globalData.currentExhibitionId || 'none'}`
  },

  readArtworkCache() {
    try {
      const cache = wx.getStorageSync(this.getArtworkCacheKey())
      if (cache && cache.expireAt > Date.now() && Array.isArray(cache.artworks)) {
        return cache.artworks
      }
    } catch (error) {}
    return []
  },

  writeArtworkCache(artworks) {
    try {
      wx.setStorageSync(this.getArtworkCacheKey(), {
        expireAt: Date.now() + ARTWORK_CACHE_TTL,
        artworks
      })
    } catch (error) {}
  },

  async resolveInitialArtworkPreset(artworkRef, artworkId = '') {
    const target = String(artworkRef || '').trim()
    const targetId = String(artworkId || '').trim()
    if (!target && !targetId) return false

    try {
      const artwork = await new Promise((resolve, reject) => {
        wx.request({
          url: buildArtworkResolveUrl(app.globalData.serverUrl, target, targetId, this.data.exhibitionId),
          success: res => {
            if (res.statusCode === 200 && res.data && res.data.artwork) resolve(res.data)
            else reject(new Error('作品识别失败'))
          },
          fail: reject
        })
      })

      const response = artwork
      const resolvedArtwork = response.artwork
      const exhibition = {
        id: response.exhibition_id || resolvedArtwork.exhibition_id || this.data.exhibitionId,
        name: response.exhibition_name || resolvedArtwork.exhibition_name || this.data.exhibitionName,
        status: response.exhibition_status || resolvedArtwork.exhibition_status || this.data.exhibitionStatus
      }
      if (exhibition.id) app.setCurrentExhibition(exhibition)
      this.setData({
        presetArtwork: this.decorateArtwork(resolvedArtwork),
        initialArtworkRef: resolvedArtwork.artwork_code || target,
        initialArtworkId: resolvedArtwork.id || targetId,
        exhibitionId: exhibition.id,
        exhibitionName: exhibition.name,
        exhibitionStatus: exhibition.status
      })
      this.trackRequiredReadyIfNeeded('initial_artwork_resolved')
      return true
    } catch (error) {
      return false
    }
  },

  async loadArtworks(forceRefresh = false) {
    if (this.data.loadingArtworks) return

    if (!forceRefresh && this.data.artworks.length > 0) {
      this.applyArtworkFilter(this.data.artworkSearchKeyword)
      return
    }

    if (!forceRefresh) {
      const cachedArtworks = this.readArtworkCache()
      if (cachedArtworks.length > 0) {
        this.setData({
          artworks: cachedArtworks,
          artworkCount: cachedArtworks.length
        })
        this.applyArtworkFilter(this.data.artworkSearchKeyword)
        this.applyInitialArtworkPreset(this.data.initialArtworkRef, cachedArtworks)
        return
      }
    }

    this.setData({ loadingArtworks: true })

    try {
      const artworks = await new Promise((resolve, reject) => {
        wx.request({
          url: `${app.globalData.serverUrl}/api/client/artworks-lite?exhibition_id=${encodeURIComponent(this.data.exhibitionId)}`,
          success: res => {
            if (res.statusCode === 200 && res.data && res.data.need_exhibition) {
              wx.reLaunch({ url: '/pages/select-exhibition/index' })
              reject(new Error('需要选择展览'))
            } else if (res.statusCode === 200 && Array.isArray(res.data.artworks)) {
              resolve(res.data.artworks)
            } else {
              reject(new Error('作品列表加载失败'))
            }
          },
          fail: reject
        })
      })

      const normalized = artworks.map(item => this.decorateArtwork(item))
      this.writeArtworkCache(normalized)

      this.setData({
        artworks: normalized,
        artworkCount: normalized.length
      })

      this.applyArtworkFilter(this.data.artworkSearchKeyword)
      this.applyInitialArtworkPreset(this.data.initialArtworkRef, normalized)
    } catch (error) {
      wx.showToast({ title: '作品列表加载失败', icon: 'none' })
    } finally {
      this.setData({ loadingArtworks: false })
    }
  },

  applyInitialArtworkPreset(artworkRef, artworkList) {
    const target = String(artworkRef || '').trim()
    if (!target) return false

    const matched = matchArtworkByReference(artworkList || this.data.artworks, target)
    if (!matched) return false

    if (
      this.data.presetArtwork &&
      String(this.data.presetArtwork.artwork_code || '').trim() === String(matched.artwork_code || '').trim()
    ) {
      return true
    }

    this.setData({
      presetArtwork: matched,
      artworkPanelOpen: false,
      artworkSearchKeyword: ''
    })

    this.applyArtworkFilter('')
    this.trackRequiredReadyIfNeeded('initial_artwork_matched')
    return true
  },

  applyArtworkFilter(keyword = '') {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase()
    const filtered = this.data.artworks.filter(item => {
      if (!normalizedKeyword) return true

      const haystack = [item.artwork_code, item.id, item.name, item.author, item.display_price, item.price, item.display_size, item.display_frame_size]
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
    this.trackUploadFunnel('artwork_panel_open')
    this.loadArtworks()
    this.applyArtworkFilter(this.data.artworkSearchKeyword)
  },

  closeArtworkPanel() {
    this.setData({ artworkPanelOpen: false })
  },

  onArtworkSearchInput(e) {
    const keyword = e.detail.value || ''
    this.setData({ artworkSelectionKeyword: keyword })
    this.applyArtworkFilter(keyword)

    const normalizedKeyword = String(keyword || '').trim()
    if (normalizedKeyword.length >= 2 && normalizedKeyword !== this.lastTrackedArtworkSearchKeyword) {
      this.lastTrackedArtworkSearchKeyword = normalizedKeyword
      this.trackUploadFunnel('artwork_search', { keyword_length: normalizedKeyword.length })
    }
  },

  chooseArtwork(e) {
    const artwork = e.currentTarget.dataset.artwork
    const selectionSource = String(this.data.artworkSearchKeyword || this.data.artworkSelectionKeyword || '').trim() ? 'search_select' : 'list_select'
    this.setData({
      presetArtwork: artwork,
      artworkPanelOpen: false,
      artworkSearchKeyword: '',
      initialArtworkRef: artwork && artwork.artwork_code ? String(artwork.artwork_code) : this.data.initialArtworkRef,
      initialArtworkId: artwork && artwork.id ? String(artwork.id) : this.data.initialArtworkId,
      exhibitionId: artwork && artwork.exhibition_id ? artwork.exhibition_id : this.data.exhibitionId,
      artworkSelectionMethod: selectionSource
    })
    trackClientEvent('artwork_selected', {
      page_name: 'upload',
      service_type: this.data.service,
      entry_source: this.data.entrySource,
      artwork_id: artwork && artwork.id ? artwork.id : '',
      artwork_code: artwork && artwork.artwork_code ? artwork.artwork_code : '',
      selection_source: selectionSource,
      selection_source_label: this.buildArtworkSelectionLabel(selectionSource)
    })
    this.trackRequiredReadyIfNeeded('artwork_selected')
    this.applyArtworkFilter('')
  },

  clearArtwork() {
    this.setData({
      presetArtwork: null,
      initialArtworkRef: '',
      initialArtworkId: '',
      artworkSearchKeyword: '',
      artworkSelectionKeyword: '',
      artworkSelectionMethod: '',
      artworkPanelOpen: false
    })
    this.applyArtworkFilter('')
  },

  async scanArtwork() {
    if (this.data.scanLoading) return

    this.trackUploadFunnel('artwork_scan_button_clicked')
    this.setData({ scanLoading: true })

    wx.scanCode({
      success: res => {
        const pathCandidates = getScanPathCandidates(res)
        const pagePath = pathCandidates.find(item => isMiniProgramPagePath(item))

        if (!pagePath) {
          wx.showToast({ title: '请扫描小程序码进入指定页面', icon: 'none' })
          return
        }

        trackClientEvent('miniapp_code_scan_navigate', {
          page_name: 'upload',
          service_type: this.data.service,
          entry_source: this.data.entrySource,
          scan_type: res.scanType || '',
          target_path: pagePath
        })

        const targetPath = this.appendQueryParam(pagePath, 'selection_method', 'upload_scan_button')

        wx.redirectTo({
          url: targetPath,
          fail: () => {
            wx.showToast({ title: '页面跳转失败，请重试', icon: 'none' })
          }
        })
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
    this.trackUploadFunnel('image_choose_started', { image_key: key })

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async res => {
        const path = res.tempFiles[0].tempFilePath
        const token = `${Date.now()}_${Math.random()}`
        this.imageProcessTokens[key] = token

        this.trackUploadFunnel('image_choose_success', { image_key: key })

        this.setData({
          [`images.${key}`]: path,
          [`imageAssets.${key}`]: {
            originalPath: path,
            originPath: path,
            uploadPath: path,
            previewPath: path,
            originalSize: 0,
            uploadSize: 0,
            previewSize: 0,
            optimized: false,
            savedBytes: 0,
            savedText: ''
          },
          [`imageProcessing.${key}`]: true
        })

        try {
          const asset = await prepareImageAsset(path, {
            quality: 95,
            preserveOriginalUpload: true
          })
          if (this.imageProcessTokens[key] !== token) return
          this.setData({
            [`images.${key}`]: asset.previewPath || path,
            [`imageAssets.${key}`]: asset,
            [`imageProcessing.${key}`]: false
          })
          this.trackRequiredReadyIfNeeded('image_choose_success')
        } catch (error) {
          this.setData({ [`imageProcessing.${key}`]: false })
          this.trackRequiredReadyIfNeeded('image_choose_success')
        }
      },
      fail: err => {
        const errMsg = err && err.errMsg ? String(err.errMsg) : ''
        this.trackUploadFunnel(errMsg.includes('cancel') ? 'image_choose_cancel' : 'image_choose_failed', {
          image_key: key,
          error_msg: errMsg
        })
      }
    })
  },

  removeImage(e) {
    const key = e.currentTarget.dataset.key
    this.trackUploadFunnel('image_removed', { image_key: key })
    delete this.imageProcessTokens[key]
    this.setData({
      [`images.${key}`]: '',
      [`imageAssets.${key}`]: null,
      [`imageProcessing.${key}`]: false
    })
  },

  previewImage(e) {
    const key = e.currentTarget.dataset.key
    const asset = key ? this.data.imageAssets[key] : null
    const src = (asset && asset.originalPath) || e.currentTarget.dataset.src
    if (!src) return

    wx.previewImage({
      current: src,
      urls: [src]
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
    const email = e.detail.value || ''
    this.setData({ email })
    const normalizedEmail = String(email || '').trim()
    if (!this.emailInputTracked && normalizedEmail.includes('@')) {
      this.emailInputTracked = true
      this.trackUploadFunnel('email_input_completed', { email_domain: normalizedEmail.split('@').pop() || '' })
    }
  },

  onSizeInput(e) {
    this.setData({ artworkSize: e.detail.value })
  },

  onNotesInput(e) {
    this.setData({ notes: e.detail.value })
  },

  toggleExtraOptimize() {
    const nextValue = !this.data.extraOptimize
    this.setData({ extraOptimize: nextValue })
    this.trackUploadFunnel('extra_service_toggled', { enabled: nextValue })
  },

  onExtraOptimizeChange(e) {
    const nextValue = !!e.detail.value
    this.setData({ extraOptimize: nextValue })
    this.trackUploadFunnel('extra_service_toggled', { enabled: nextValue })
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
      this.trackUploadFunnel('subscribe_unavailable')
      return { accepted: false, templateId: '' }
    }

    this.trackUploadFunnel('subscribe_prompt_shown', { template_id: COMPLETION_TEMPLATE_ID })
    return new Promise(resolve => {
      wx.requestSubscribeMessage({
        tmplIds: [COMPLETION_TEMPLATE_ID],
        success: res => {
          const accepted = res && res[COMPLETION_TEMPLATE_ID] === 'accept'
          this.trackUploadFunnel(accepted ? 'subscribe_accepted' : 'subscribe_rejected', { template_id: COMPLETION_TEMPLATE_ID })
          resolve({
            accepted,
            templateId: COMPLETION_TEMPLATE_ID
          })
        },
        fail: err => {
          this.trackUploadFunnel('subscribe_failed', { template_id: COMPLETION_TEMPLATE_ID, error_msg: err && err.errMsg ? String(err.errMsg) : '' })
          resolve({ accepted: false, templateId: '' })
        }
      })
    })
  },

  setSubmitProgress(progress, stage) {
    const stageText = stage || this.data.submitStage || '提交中'
    const progressValue = Math.max(0, Math.min(100, Math.round(progress || 0)))
    this.setData({
      submitProgress: progressValue,
      submitStage: stageText,
      submitStageText: stageText
    })
  },

  resetSubmitState() {
    this.setData({
      submitting: false,
      submitProgress: 0,
      submitStage: '',
      submitStageText: ''
    })
  },

  async collectUploadFiles() {
    const files = []
    for (const cfg of this.data.uploadConfig) {
      const asset = this.data.imageAssets[cfg.key] || {}
      const uploadPath = asset.uploadPath || this.data.images[cfg.key]
      const originalPath = asset.originalPath || uploadPath
      const size = asset.uploadSize || await safeFileSize(uploadPath)
      if (uploadPath) {
        files.push({
          key: cfg.key,
          uploadPath,
          originalPath,
          size: Math.max(1, size || 0)
        })
      }
    }
    return files
  },

  uploadFilesWithProgress(files) {
    if (!files.length) return Promise.resolve({})

    const uploadedBytes = {}
    const totalBytes = files.reduce((sum, item) => sum + Math.max(1, item.size || 0), 0)
    const uploadStart = 8
    const uploadWeight = 84

    this.setSubmitProgress(uploadStart, '上传图片')

    const updateOverallProgress = () => {
      const currentUploaded = Object.keys(uploadedBytes).reduce((sum, key) => sum + (uploadedBytes[key] || 0), 0)
      const percent = uploadStart + Math.round((currentUploaded / totalBytes) * uploadWeight)
      this.setSubmitProgress(Math.min(92, percent), '上传图片')
    }

    return Promise.all(files.map(file => new Promise((resolve, reject) => {
      this.trackUploadFunnel('image_upload_started', { image_key: file.key, file_size: file.size || 0 })
      const task = wx.uploadFile({
        url: `${app.globalData.serverUrl}/api/client/upload-image`,
        filePath: file.uploadPath,
        name: 'image',
        formData: {
          openid: app.globalData.openid || '',
          image_key: file.key || ''
        },
        success: res => {
          try {
            const data = JSON.parse(res.data)
            if (res.statusCode === 200 && data && data.filename) {
              uploadedBytes[file.key] = file.size
              updateOverallProgress()
              this.trackUploadFunnel('image_upload_success', { image_key: file.key, file_size: file.size || 0 })
              resolve({ key: file.key, filename: data.filename })
            } else {
              this.trackUploadFunnel('image_upload_failed', { image_key: file.key, error_msg: data && data.error ? data.error : '图片上传失败' })
              reject(data || new Error('图片上传失败'))
            }
          } catch (error) {
            this.trackUploadFunnel('image_upload_failed', { image_key: file.key, error_msg: error && error.message ? error.message : '响应解析失败' })
            reject(error)
          }
        },
        fail: err => {
          this.trackUploadFunnel('image_upload_failed', { image_key: file.key, error_msg: err && err.errMsg ? String(err.errMsg) : '' })
          reject(err)
        }
      })

      if (task && task.onProgressUpdate) {
        task.onProgressUpdate(progress => {
          uploadedBytes[file.key] = Math.round(file.size * ((Number(progress.progress) || 0) / 100))
          updateOverallProgress()
        })
      }
    }))).then(items => items.reduce((accumulator, item) => {
      accumulator[item.key] = item.filename
      return accumulator
    }, {}))
  },

  async submitOrder() {
    if (this.data.submitting) return
    if (this.data.exhibitionStatus === 'archived' || (this.data.presetArtwork && this.data.presetArtwork.can_order === false)) {
      wx.showToast({ title: '该展览已结束，暂不支持在线下单', icon: 'none' })
      return
    }

    if (!this.checkImages()) {
      const msg = this.data.showArtworkSelect && !this.data.presetArtwork
        ? '请先选择参展作品'
        : '请上传所需的图片'

      this.trackUploadFunnel('submit_blocked_validation', { reason: msg })
      wx.showToast({ title: msg, icon: 'none' })
      return
    }

    this.trackUploadFunnel('submit_clicked')

    this.setData({
      submitting: true,
      submitProgress: 2,
      submitStage: '准备提交'
    })

    try {
      this.setSubmitProgress(4, '校验微信身份')
      if (!app.globalData.openid) {
        await app.wxLogin('', '')
      }

      const subscribeResult = await this.requestCompletionSubscribe()
      this.setSubmitProgress(6, '整理图片')

      const filenames = {}
      const artwork = this.data.presetArtwork
      const artworkCode = artwork ? String(artwork.artwork_code || artwork.code || '') : ''
      const files = await this.collectUploadFiles()

      if (artwork && artwork.images && artwork.images[0]) {
        filenames.artwork = artwork.images[0]
      }

      const uploaded = await this.uploadFilesWithProgress(files)
      Object.assign(filenames, uploaded)

      this.setSubmitProgress(94, '创建委托')

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
            artwork_size: artwork ? (artwork.size_text || artwork.size || '') : (this.data.artworkSize || ''),
            artwork_id: artwork && artwork.id ? artwork.id : '',
            artwork_num: artworkCode,
            artwork_code: artworkCode,
            exhibition_id: artwork && artwork.exhibition_id ? artwork.exhibition_id : this.data.exhibitionId,
            artwork_name: artwork ? (artwork.name || '') : '',
            notes: this.data.notes || '',
            openid: app.globalData.openid || '',
            user_nickname: app.globalData.userNickname || '',
            user_avatar: app.globalData.userAvatar || '',
            subscribe_completion: subscribeResult.accepted ? '1' : '0',
            subscribe_template_id: subscribeResult.accepted ? subscribeResult.templateId : '',
            entry_platform: 'miniapp',
            entry_source: this.data.entrySource || 'service_selected',
            entry_scene: this.data.entryScene || '',
            session_id: getAnalyticsSessionId(),
            artwork_selection_method: this.data.artworkSelectionMethod || ''
          },
          success: res => {
            if (res.statusCode === 200) resolve(res.data)
            else reject(res.data)
          },
          fail: reject
        })
      })

      this.setSubmitProgress(100, '提交完成')

      trackClientEvent('submit_success_client', {
        page_name: 'upload',
        service_type: this.data.service,
        entry_source: this.data.entrySource,
        order_id: result.orderId,
        artwork_id: artwork && artwork.id ? artwork.id : '',
        artwork_code: artworkCode || '',
        exhibition_id: artwork && artwork.exhibition_id ? artwork.exhibition_id : this.data.exhibitionId,
        artwork_selection_method: this.data.artworkSelectionMethod || ''
      })

      wx.setStorageSync('lastOrderId', result.orderId)
      wx.setStorageSync('lastOrderStatus', 'pending')
      if (result.deliveryToken) {
        wx.setStorageSync('lastDeliveryToken', result.deliveryToken)
        wx.setStorageSync(`deliveryToken:${result.orderId}`, result.deliveryToken)
      }
      app.globalData.currentOrderId = result.orderId

      const tokenQuery = result.deliveryToken ? `&deliveryToken=${encodeURIComponent(result.deliveryToken)}` : ''
      wx.redirectTo({
        url: `/pages/waiting/waiting?orderId=${result.orderId}${tokenQuery}`
      })
    } catch (error) {
      const msg = error && (error.errMsg || error.error || JSON.stringify(error))
      this.trackUploadFunnel('submit_failed_client', { error_msg: msg || '未知错误' })
      wx.showModal({ title: '提交失败', content: msg || '未知错误', showCancel: false })
      this.resetSubmitState()
      return
    }

    this.resetSubmitState()
  }
})
