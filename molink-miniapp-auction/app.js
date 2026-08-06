const { generateDeviceId, getAnalyticsSessionId } = require('./utils/helper')

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
    miniappEntryMethod: '',
    miniappEntryScene: '',
    miniappEntryPath: '',
    miniappEntryQuery: {},
    miniappDeviceProfileTrackedDate: '',
    currentExhibitionId: '',
    currentExhibitionName: '',
    currentExhibitionStatus: '',
    currentExhibitionAdvisorName: '',
    currentExhibitionAdvisorWechat: '',
    // 真机优先调用模糊定位；接口未开通/低版本时仍保留演示入口。
    GEO_ENTRY_MODE: 'auto',
    ENABLE_GEO_ENTRY: true,
    privacyAgreed: false
  },

  onLaunch(options = {}) {
    // 初始化设备ID（藏家匿名身份）
    let deviceId = wx.getStorageSync('deviceId')
    if (!deviceId) {
      deviceId = generateDeviceId()
      wx.setStorageSync('deviceId', deviceId)
    }
    this.globalData.deviceId = deviceId
    this.restoreCurrentExhibition()

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

    // 恢复账号登录状态
    const openid = wx.getStorageSync('openid')
    if (openid) {
      this.globalData.openid = openid
      this.globalData.userNickname = wx.getStorageSync('userNickname') || ''
      this.globalData.userAvatar = wx.getStorageSync('userAvatar') || ''
    }

    // 先按匿名设备身份恢复，登录后再补写到 openid 身份。
    this.globalData.privacyAgreed = this.restorePrivacyAgreement()

    this.updateMiniappEntry(options, 'launch')
    this.trackMiniappDeviceProfile(options)
  },


  restoreCurrentExhibition() {
    const stored = wx.getStorageSync('currentExhibition') || {}
    this.globalData.currentExhibitionId = String(stored.id || '').trim()
    this.globalData.currentExhibitionName = String(stored.name || '').trim()
    this.globalData.currentExhibitionStatus = String(stored.status || '').trim()
    this.globalData.currentExhibitionAdvisorName = String(stored.collection_advisor_name || '').trim()
    this.globalData.currentExhibitionAdvisorWechat = String(stored.collection_advisor_wechat || '').trim()
    return stored
  },

  setCurrentExhibition(exhibition = {}) {
    const current = {
      id: String(exhibition.id || exhibition.exhibition_id || '').trim(),
      name: String(exhibition.name || exhibition.exhibition_name || '').trim(),
      status: String(exhibition.status || exhibition.exhibition_status || '').trim(),
      collection_advisor_name: String(exhibition.collection_advisor_name || exhibition.exhibition_collection_advisor_name || '').trim(),
      collection_advisor_wechat: String(exhibition.collection_advisor_wechat || exhibition.exhibition_collection_advisor_wechat || '').trim()
    }
    if (!current.id) return null
    this.globalData.currentExhibitionId = current.id
    this.globalData.currentExhibitionName = current.name
    this.globalData.currentExhibitionStatus = current.status
    this.globalData.currentExhibitionAdvisorName = current.collection_advisor_name
    this.globalData.currentExhibitionAdvisorWechat = current.collection_advisor_wechat
    wx.setStorageSync('currentExhibition', current)
    return current
  },

  clearCurrentExhibition() {
    this.globalData.currentExhibitionId = ''
    this.globalData.currentExhibitionName = ''
    this.globalData.currentExhibitionStatus = ''
    this.globalData.currentExhibitionAdvisorName = ''
    this.globalData.currentExhibitionAdvisorWechat = ''
    wx.removeStorageSync('currentExhibition')
  },

  getCurrentExhibition() {
    return {
      id: this.globalData.currentExhibitionId || '',
      name: this.globalData.currentExhibitionName || '',
      status: this.globalData.currentExhibitionStatus || '',
      collection_advisor_name: this.globalData.currentExhibitionAdvisorName || '',
      collection_advisor_wechat: this.globalData.currentExhibitionAdvisorWechat || ''
    }
  },

  resolveMiniappEntryMethod(scene) {
    const sceneText = String(scene || '').trim()
    if (['1047', '1048', '1049'].includes(sceneText)) return 'miniapp_page_code'
    if (['1011', '1012', '1013'].includes(sceneText)) return 'miniapp_qr_code'
    if (['1007', '1008', '1044'].includes(sceneText)) return 'wechat_share'
    return ''
  },

  updateMiniappEntry(options = {}, trigger = 'show') {
    const scene = String(options.scene || '').trim()
    const method = this.resolveMiniappEntryMethod(scene)
    if (!method) {
      if (scene) {
        this.globalData.miniappEntryMethod = ''
        this.globalData.miniappEntryScene = scene
        this.globalData.miniappEntryPath = String(options.path || '')
        this.globalData.miniappEntryQuery = options.query || {}
      }
      return
    }

    const path = String(options.path || '')
    const query = options.query || {}
    const key = `${method}|${scene}|${path}|${JSON.stringify(query)}`
    const now = Date.now()
    if (this.lastMiniappEntryKey === key && now - (this.lastMiniappEntryAt || 0) < 3000) return
    this.lastMiniappEntryKey = key
    this.lastMiniappEntryAt = now

    this.globalData.miniappEntryMethod = method
    this.globalData.miniappEntryScene = scene
    this.globalData.miniappEntryPath = path
    this.globalData.miniappEntryQuery = query

    wx.request({
      url: `${this.globalData.serverUrl}/api/client/app-events`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: {
        event_name: 'miniapp_entry',
        page_name: path || 'app',
        platform: 'miniapp',
        session_id: getAnalyticsSessionId(),
        device_uuid: this.globalData.deviceId || '',
        openid: this.globalData.openid || '',
        entry_source: method,
        miniapp_entry_method: method,
        miniapp_scene: scene,
        miniapp_entry_path: path,
        miniapp_entry_trigger: trigger,
        miniapp_entry_query: query,
        exhibition_id: this.globalData.currentExhibitionId || ''
      }
    })
  },

  getLocalDateText(date = new Date()) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  },

  trackMiniappDeviceProfile(options = {}) {
    const today = this.getLocalDateText()
    const storageKey = 'miniappDeviceProfileTrackedDate'
    if (wx.getStorageSync(storageKey) === today) return

    let systemInfo = {}
    try {
      systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
    } catch (error) {
      systemInfo = {}
    }

    const firstSeenKey = 'miniappFirstSeenAt'
    let firstSeenAt = wx.getStorageSync(firstSeenKey)
    const isReturningDevice = !!firstSeenAt
    if (!firstSeenAt) {
      firstSeenAt = new Date().toISOString()
      wx.setStorageSync(firstSeenKey, firstSeenAt)
    }

    wx.setStorageSync(storageKey, today)
    this.globalData.miniappDeviceProfileTrackedDate = today

    wx.request({
      url: `${this.globalData.serverUrl}/api/client/app-events`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: {
        event_name: 'miniapp_device_profile',
        page_name: String(options.path || 'app'),
        platform: 'miniapp',
        session_id: getAnalyticsSessionId(),
        device_uuid: this.globalData.deviceId || '',
        entry_source: this.globalData.miniappEntryMethod || '',
        miniapp_entry_method: this.globalData.miniappEntryMethod || '',
        miniapp_scene: this.globalData.miniappEntryScene || String(options.scene || ''),
        miniapp_entry_path: this.globalData.miniappEntryPath || String(options.path || ''),
        device_platform: systemInfo.platform || '',
        device_os: systemInfo.system || '',
        device_brand: systemInfo.brand || '',
        device_model: systemInfo.model || '',
        device_language: systemInfo.language || '',
        screen_width: systemInfo.screenWidth || 0,
        screen_height: systemInfo.screenHeight || 0,
        window_width: systemInfo.windowWidth || 0,
        window_height: systemInfo.windowHeight || 0,
        sdk_version: systemInfo.SDKVersion || '',
        is_returning_device: isReturningDevice,
        first_seen_date: String(firstSeenAt).slice(0, 10),
        exhibition_id: this.globalData.currentExhibitionId || ''
      },
      fail: () => {}
    })
  },

  onShow(options = {}) {
    this.updateMiniappEntry(options, 'show')
    this.trackMiniappDeviceProfile(options)
  },

  // 账号登录：code换openid + 获取用户昵称头像
  wxLogin(nickname, avatar) {
    return new Promise((resolve, reject) => {
      wx.login({
        success: loginRes => {
          wx.request({
            url: `${this.globalData.serverUrl}/api/client/wx-login`,
            method: 'POST',
            header: { 'Content-Type': 'application/json' },
            data: { code: loginRes.code, nickname, avatar, device_uuid: this.globalData.deviceId },
            success: res => {
              if (res.statusCode === 200 && res.data.openid) {
                const { openid, nickname: nick, avatar: ava } = res.data
                this.globalData.openid = openid
                this.globalData.userNickname = nick || nickname || ''
                this.globalData.userAvatar = ava || avatar || ''
                wx.setStorageSync('openid', openid)
                wx.setStorageSync('userNickname', this.globalData.userNickname)
                wx.setStorageSync('userAvatar', this.globalData.userAvatar)
                if (this.globalData.privacyAgreed) {
                  this.acceptPrivacyAgreement()
                }
                resolve(res.data)
              } else {
                const data = res.data || {}
                const detail = data.detail || data.errmsg || ''
                const errcode = data.errcode ? `（${data.errcode}）` : ''
                reject({
                  error: detail ? `${data.error || '微信授权失败'}：${detail}${errcode}` : (data.error || '微信授权失败'),
                  detail,
                  errcode: data.errcode || '',
                  config: data.config || null
                })
              }
            },
            fail: reject
          })
        },
        fail: reject
      })
    })
  },


  getPrivacyAgreementStorageKeys() {
    const version = 'v1'
    const keys = []
    const deviceId = String(this.globalData.deviceId || wx.getStorageSync('deviceId') || '').trim()
    const openid = String(this.globalData.openid || wx.getStorageSync('openid') || '').trim()

    if (deviceId) keys.push(`privacyAgreement:${version}:device:${deviceId}`)
    if (openid) keys.push(`privacyAgreement:${version}:openid:${openid}`)
    return keys
  },

  isStoredPrivacyAgreementAccepted(value) {
    if (value === true || value === '1') return true
    return Boolean(value && typeof value === 'object' && value.accepted === true)
  },

  restorePrivacyAgreement() {
    const keys = this.getPrivacyAgreementStorageKeys()
    const agreed = keys.some(key => this.isStoredPrivacyAgreementAccepted(wx.getStorageSync(key)))

    this.globalData.privacyAgreed = agreed
    if (agreed) {
      const record = { accepted: true, version: 'v1', acceptedAt: Date.now() }
      keys.forEach(key => {
        if (!this.isStoredPrivacyAgreementAccepted(wx.getStorageSync(key))) {
          wx.setStorageSync(key, record)
        }
      })
    }
    return agreed
  },

  acceptPrivacyAgreement() {
    const record = { accepted: true, version: 'v1', acceptedAt: Date.now() }
    this.getPrivacyAgreementStorageKeys().forEach(key => wx.setStorageSync(key, record))
    this.globalData.privacyAgreed = true
    return true
  },

  buildIdentityQuery(extra = {}) {
    const params = Object.assign({}, extra)
    if (this.globalData.openid) {
      params.openid = this.globalData.openid
    }
    return Object.keys(params)
      .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
      .join('&')
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
