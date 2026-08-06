const app = getApp()
const { request, trackClientEvent } = require('../../utils/helper')
const { createEtaAnchor, readEta } = require('../../utils/etaClock')
const { presentEta } = require('../../utils/etaPresenter')
const { normalizeThinkingPayload, refreshCandidateStates } = require('../../utils/wallPreference')

function refineCustomerCopy(value) {
  return String(value || '')
    .replace(/GPU/gi, '系统')
    .replace(/高保真效果图|效果图/g, '空间呈现')
    .replace(/渲染/g, '细化')
    .replace(/生成/g, '形成')
    .replace(/请稍候|请耐心等待/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function clientProgressCopy(res, progressPct) {
  const progress = (res && res.progress) || {}
  const status = String((res && res.status) || '')
  const rawStatus = String(
    progress.rawStatus ||
    progress.hangingStatus ||
    (res && (res.rawStatus || res.hanging_status)) ||
    status
  ).toLowerCase()
  const rawStep = String(
    progress.message ||
    progress.text ||
    (res && res.currentStep) ||
    ''
  ).toLowerCase()
  const source = `${rawStatus} ${rawStep}`
  const pct = Number(progressPct)

  if (status === 'audit_rejected') return '这张照片暂时无法继续'
  if (status === 'audit_timeout') return '照片确认暂未完成'
  if (status === 'delivered' || pct >= 100) return '您的专属呈现已备好'
  if (status === 'failed' || /failed|no_safe_wall/.test(source)) return '正在为您确认最终呈现'
  if (status === 'content_reviewing') return '正在确认您的空间照片'

  if (/review|upload|delivery|final|complete|复核|整理|上传|交付/.test(source)) {
    return '最后的细节收束'
  }
  if (/render|gpu|image|compose|composite|inpaint|成图|出图/.test(source)) {
    return '想象逐渐清晰，征求您的偏好'
  }
  if (/measure|depth|metric3d|测量|深度/.test(source)) {
    return '解读空间的形与色'
  }
  if (/wall|structure|semantic|墙面|结构|落点|构图|位置/.test(source)) {
    return '正在为您寻找更合适的呈现角度'
  }
  if (/geometry|geometric|几何|建模/.test(source)) {
    return '空间分析进行中'
  }
  if (/analyse|analyze|analysis|detect|segment|识别|分析/.test(source)) {
    return '解读空间的形与色'
  }

  if (Number.isFinite(pct)) {
    if (pct < 20) return '正在确认您的空间照片'
    if (pct < 35) return '解读空间的形与色'
    if (pct < 55) return '空间分析进行中'
    if (pct < 75) return '想象逐渐清晰，征求您的偏好'
    if (pct < 92) return '最后的细节收束'
    return '即将与您见面'
  }

  return '正在为您细细构想'
}

function collectionAdvisorInitial(name) {
  const value = String(name || '').trim()
  return value ? value.slice(0, 1) : '藏'
}

function asNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeRawStatus(res, progress) {
  return String((progress && (progress.rawStatus || progress.hangingStatus)) || (res && (res.rawStatus || res.hanging_status || res.status)) || '')
}

function canStartWaitingAdvisor(res, progressPct, advisorProgress) {
  const progress = (res && res.progress) || {}
  const rawStatus = normalizeRawStatus(res, progress)
  const currentStep = String((progress && (progress.message || progress.text)) || (res && res.currentStep) || '')
  const status = String((res && res.status) || '')
  if (status === 'delivered' || status === 'failed' || /failed|no_safe_wall/.test(rawStatus)) return false
  if (advisorProgress) return true
  if (progressPct !== null && progressPct >= 60) return true
  if (/hanging_rendering|hanging_render_review|hanging_partial_review/.test(rawStatus)) return true
  if (/review|upload|delivery|final|render|compose|复核|整理|上传|交付/.test(currentStep.toLowerCase())) return true
  return false
}

function decodeUtf8Chunk(data, decoder) {
  if (!data) return ''
  if (typeof data === 'string') return data
  try {
    if (decoder) return decoder.decode(data, { stream: true })
  } catch (e) {}
  try {
    const bytes = new Uint8Array(data)
    let binary = ''
    const step = 0x8000
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
    }
    return decodeURIComponent(escape(binary))
  } catch (e) {
    return ''
  }
}

Page({
  lastTrackedStatus: '',
  advisorRequestTask: null,
  advisorSseBuffer: '',
  advisorTypingQueue: '',
  advisorTypingTimer: null,
  advisorReceivedChunks: false,
  advisorManuallyClosed: false,
  advisorTextDecoder: null,
  advisorReceivedText: false,
  advisorDeferredUntil: 0,
  advisorCopyResetTimer: null,
  etaAnchor: null,
  etaTickTimer: null,
  pageVisible: false,

  data: {
    orderId: '',
    deliveryToken: '',
    submitTime: '',
    dots: [0,30,60,90,120,150,180,210,240,270,300,330],
    pollingTimer: null,
    currentStep: '正在确认您的空间照片',
    progressText: '正在确认您的空间照片',
    progressPct: 8,
    consultantText: '',
    advisorProgress: '',
    consultantStreaming: false,
    consultantTyping: false,
    consultantDone: false,
    consultantError: false,
    advisorReady: false,
    thinkingReady: false,
    thinkingGuideCopy: '',
    wallCandidates: [],
    notRecommendedWalls: [],
    selectedWallIds: [],
    maxWallSelect: 2,
    preferenceSubmitting: false,
    preferenceSubmitted: false,
    preferenceMessage: '',
    auditRejected: false,
    orderFailed: false,
    failureProgram: false,
    failureTitle: '本次处理暂未完成',
    failureReason: '',
    failureSuggestion: '',
    failureSuggestions: [],
    auditIssueTitle: '内容安全审核未通过',
    auditIssueCopy: '请更换照片后重新提交。',
    auditRejectReason: '',
    retryService: '',
    collectionAdvisorName: '',
    collectionAdvisorWechat: '',
    collectionAdvisorInitial: '藏',
    collectionAdvisorExpanded: false,
    collectionAdvisorCopied: false,
    etaPrimaryText: '',
    etaRangeText: '',
    etaStateText: '',
    etaVisible: false,
    etaStale: false
  },

  onLoad(options) {
    const orderId = options.orderId || app.globalData.currentOrderId
    if (!orderId) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }

    const deliveryToken = options.deliveryToken || wx.getStorageSync(`deliveryToken:${orderId}`) || wx.getStorageSync('lastDeliveryToken') || ''
    const exhibition = app.getCurrentExhibition()
    const advisorName = String(exhibition.collection_advisor_name || '').trim()
    this.setData({
      orderId,
      deliveryToken,
      collectionAdvisorName: advisorName,
      collectionAdvisorWechat: String(exhibition.collection_advisor_wechat || '').trim(),
      collectionAdvisorInitial: collectionAdvisorInitial(advisorName)
    })

    trackClientEvent('waiting_view', { page_name: 'waiting', order_id: orderId, entry_source: 'submit_success' })
  },

  onShow() {
    this.pageVisible = true
    this.checkStatus()
    this.startPolling()
    this.startEtaTick()
    this.startCollectionAdvisorIntro()
  },

  onHide() {
    this.pageVisible = false
    this.stopPolling()
    this.stopEtaTick()
    this.stopAdvisorStream({ keepText: true })
    this.clearCollectionAdvisorTimers()
  },

  onUnload() {
    this.pageVisible = false
    this.stopPolling()
    this.stopEtaTick()
    this.stopAdvisorStream({ keepText: true })
    this.clearTypingTimer()
    this.clearCollectionAdvisorTimers()
    if (this.advisorCopyResetTimer) {
      clearTimeout(this.advisorCopyResetTimer)
      this.advisorCopyResetTimer = null
    }
  },

  startPolling() {
    this.stopPolling()
    trackClientEvent('polling_started', { page_name: 'waiting', order_id: this.data.orderId })
    const timer = setInterval(() => this.checkStatus(), 8000)
    this.data.pollingTimer = timer
  },

  stopPolling() {
    if (this.data.pollingTimer) {
      clearInterval(this.data.pollingTimer)
      this.data.pollingTimer = null
    }
  },

  startEtaTick() {
    if (!this.pageVisible || !this.etaAnchor || this.etaTickTimer) return
    this.etaTickTimer = setInterval(() => this.refreshEtaDisplay(), 1000)
  },

  stopEtaTick() {
    if (this.etaTickTimer) {
      clearInterval(this.etaTickTimer)
      this.etaTickTimer = null
    }
  },

  refreshEtaDisplay() {
    if (!this.etaAnchor) return
    const etaView = presentEta(readEta(this.etaAnchor, Date.now()))
    this.setData({
      etaPrimaryText: etaView.primaryText,
      etaRangeText: etaView.rangeText,
      etaStateText: etaView.stateText,
      etaVisible: etaView.visible,
      etaStale: etaView.stale
    })
    if (!etaView.visible || etaView.stale) this.stopEtaTick()
  },

  async checkStatus() {
    const requestStartedAt = Date.now()
    try {
      const res = await request(
        `${app.globalData.serverUrl}/api/client/order-status/${this.data.orderId}`,
        'GET',
        null
      )
      const responseReceivedAt = Date.now()

      const auditBlocked = res.status === 'audit_rejected' || res.status === 'audit_timeout'
      const auditTimedOut = res.status === 'audit_timeout'
      const orderFailed = res.status === 'failed'
      const failure = res.failure || {}
      const nextAdvisorName = String(res.collection_advisor_name || (res.exhibition && res.exhibition.collection_advisor_name) || this.data.collectionAdvisorName || '').trim()
      const nextAdvisorWechat = String(res.collection_advisor_wechat || (res.exhibition && res.exhibition.collection_advisor_wechat) || this.data.collectionAdvisorWechat || '').trim()
      const nextData = {
        auditRejected: auditBlocked,
        orderFailed,
        failureProgram: orderFailed && (failure.category === 'program' || failure.kind === 'program'),
        failureTitle: orderFailed ? (failure.title || '本次处理暂未完成') : '',
        failureReason: orderFailed ? (failure.reason || '系统未能完成本次空间处理。') : '',
        failureSuggestion: orderFailed ? (failure.suggestion || '') : '',
        failureSuggestions: orderFailed && Array.isArray(failure.suggestions) ? failure.suggestions : [],
        auditIssueTitle: auditTimedOut ? '审核暂未完成' : '内容安全审核未通过',
        auditIssueCopy: auditTimedOut ? '请重新提交。' : '请更换照片后重新提交。',
        auditRejectReason: res.auditTimeoutReason || res.auditRejectReason || '',
        retryService: res.serviceType || '',
        collectionAdvisorName: nextAdvisorName,
        collectionAdvisorWechat: nextAdvisorWechat,
        collectionAdvisorInitial: collectionAdvisorInitial(nextAdvisorName)
      }

      if (res.exhibition && res.exhibition.id) app.setCurrentExhibition(res.exhibition)

      if (res.deliveryToken && res.deliveryToken !== this.data.deliveryToken) {
        nextData.deliveryToken = res.deliveryToken
        wx.setStorageSync(`deliveryToken:${this.data.orderId}`, res.deliveryToken)
        wx.setStorageSync('lastDeliveryToken', res.deliveryToken)
      }

      const progress = res.progress || {}
      const rawStatus = normalizeRawStatus(res, progress)
      const fallbackPctByStatus = {
        pending: 8,
        hanging_queued: 10,
        hanging_queued_offline: 10,
        hanging_geometry: 45,
        hanging_rendering: 78,
        hanging_render_review: 92,
        hanging_partial_review: 92,
        hanging_no_safe_wall: 92,
        hanging_failed: 92,
        delivered: 100,
        content_reviewing: 18,
        audit_rejected: 100,
        audit_timeout: 100
      }

      const numericPct = asNumber(progress.pct)
      const legacyPct = asNumber(res.ai_progress_pct)
      const candidatePct = numericPct !== null
        ? numericPct
        : (legacyPct !== null ? legacyPct : (fallbackPctByStatus[rawStatus] || (res.status === 'delivered' ? 100 : this.data.progressPct)))

      const nextPct = (res.status === 'delivered' || auditBlocked || orderFailed)
        ? 100
        : Math.max(this.data.progressPct || 0, candidatePct)

      const customerStep = clientProgressCopy(res, nextPct)
      const advisorProgress = refineCustomerCopy(
        res.advisorProgress || progress.advisorText || res.ai_advisor_progress || ''
      )
      const advisorReady = canStartWaitingAdvisor(res, nextPct, advisorProgress)

      nextData.currentStep = customerStep
      nextData.progressText = customerStep
      nextData.progressPct = Math.max(0, Math.min(100, Math.round(nextPct)))
      nextData.advisorReady = advisorReady

      if (res.eta) {
        this.etaAnchor = createEtaAnchor(res.eta, requestStartedAt, responseReceivedAt)
        const etaView = presentEta(readEta(this.etaAnchor, responseReceivedAt))
        nextData.etaPrimaryText = etaView.primaryText
        nextData.etaRangeText = etaView.rangeText
        nextData.etaStateText = etaView.stateText
        nextData.etaVisible = etaView.visible
        nextData.etaStale = etaView.stale
        this.startEtaTick()
      } else {
        this.etaAnchor = null
        nextData.etaPrimaryText = ''
        nextData.etaRangeText = ''
        nextData.etaStateText = ''
        nextData.etaVisible = false
        nextData.etaStale = false
        this.stopEtaTick()
      }

      if (advisorProgress && !this.data.consultantText && !this.advisorTypingQueue) {
        nextData.consultantText = advisorProgress
        nextData.consultantDone = false
        nextData.consultantStreaming = false
      }

      const hadCollectionAdvisor = Boolean(this.data.collectionAdvisorName || this.data.collectionAdvisorWechat)
      this.setData(nextData, () => {
        const hasCollectionAdvisor = Boolean(this.data.collectionAdvisorName || this.data.collectionAdvisorWechat)
        if (!hadCollectionAdvisor && hasCollectionAdvisor) {
          this.startCollectionAdvisorIntro()
        }
      })
      const aiEngine = String(res.aiEngine || res.ai_engine || '')
      const hangingCandidateCount = Number(res.hangingCandidateCount || res.candidate_count || 0)
      const shouldProbeThinking = aiEngine === 'hanging' || hangingCandidateCount > 0 || nextData.progressPct >= 55 || /hanging_rendering|hanging_render_review|hanging_partial_review|hanging_failed|failed|delivered/.test(rawStatus)
      if (shouldProbeThinking) {
        this.loadThinking(this.data.thinkingReady || orderFailed)
      }

      console.log('[waiting:order-status]', {
        orderId: this.data.orderId,
        status: res.status,
        rawStatus,
        aiEngine,
        currentStep: customerStep,
        hasDeliveryToken: Boolean(res.deliveryToken || this.data.deliveryToken),
        progressPct: nextData.progressPct,
        candidateCount: hangingCandidateCount,
        advisorReady,
        advisorLen: String(advisorProgress || this.data.consultantText || '').length
      })

      const token = res.deliveryToken || this.data.deliveryToken
      const canRetryAdvisor = !this.advisorDeferredUntil || Date.now() >= this.advisorDeferredUntil
      if (advisorReady && token && canRetryAdvisor && !this.data.consultantDone && !this.advisorRequestTask) {
        this.startAdvisorStream(token)
      }

      if (res.status && res.status !== this.lastTrackedStatus) {
        this.lastTrackedStatus = res.status
        trackClientEvent('polling_status_seen', { page_name: 'waiting', order_id: this.data.orderId, status: res.status, raw_status: rawStatus })
      }

      if (auditBlocked) {
        trackClientEvent(
          res.status === 'audit_timeout' ? 'waiting_audit_timeout_seen' : 'waiting_audit_rejected_seen',
          { page_name: 'waiting', order_id: this.data.orderId, reason: nextData.auditRejectReason }
        )
        this.stopPolling()
        this.stopAdvisorStream({ keepText: true })
        wx.setStorageSync('lastOrderStatus', res.status)
        return
      }

      if (orderFailed) {
        trackClientEvent('waiting_failure_seen', {
          page_name: 'waiting',
          order_id: this.data.orderId,
          failure_kind: failure.kind || '',
          failure_source: failure.source || ''
        })
        this.stopAdvisorStream({ keepText: true })
        wx.setStorageSync('lastOrderStatus', 'failed')
        return
      }

      if (res.status === 'delivered') {
        trackClientEvent('waiting_to_result_redirect', { page_name: 'waiting', order_id: this.data.orderId, status: res.status })
        this.stopPolling()
        this.stopAdvisorStream({ keepText: true })
        wx.setStorageSync('lastOrderStatus', 'delivered')
        wx.redirectTo({
          url: `/pages/result/result?orderId=${this.data.orderId}`
        })
      }
    } catch (e) {
      // 静默失败，继续轮询
    }
  },

  normalizeThinking(payload, options = {}) {
    return normalizeThinkingPayload(payload, this.data.wallCandidates || [], this.data.selectedWallIds || [], options)
  },

  refreshCandidateStates(selectedWallIds) {
    const selected = selectedWallIds || this.data.selectedWallIds || []
    this.setData({
      selectedWallIds: selected,
      wallCandidates: refreshCandidateStates(this.data.wallCandidates || [], selected, this.data.maxWallSelect)
    })
  },

  async loadThinking(force = false) {
    if (!this.data.orderId || (this.data.thinkingReady && !force)) return
    try {
      const payload = await request(`${app.globalData.serverUrl}/api/client/hanging-thinking/${this.data.orderId}`, 'GET', null)
      const normalized = this.normalizeThinking(payload, { delivered: false })
      if (!normalized.ready) return
      this.setData({
        thinkingReady: true,
        thinkingGuideCopy: normalized.guideCopy,
        maxWallSelect: normalized.maxSelect,
        wallCandidates: normalized.candidates,
        notRecommendedWalls: normalized.notRecommended,
        preferenceSubmitted: false
      })
      trackClientEvent('waiting_thinking_card_shown', {
        page_name: 'waiting', order_id: this.data.orderId,
        candidate_count: normalized.candidates.length,
        has_pending_supplement: normalized.hasPendingSupplement
      })
    } catch (e) {
      console.warn('[waiting:thinking:error]', e && (e.message || e.errMsg || e))
    }
  },

  toggleWallChoice(e) {
    const wallId = e.currentTarget && e.currentTarget.dataset ? String(e.currentTarget.dataset.wallId || '') : ''
    if (!wallId || this.data.preferenceSubmitting) return
    const candidate = (this.data.wallCandidates || []).find(item => item.wall_id === wallId)
    if (!candidate || candidate.is_disabled || candidate.current_effect) return
    const selected = (this.data.selectedWallIds || []).slice()
    const index = selected.indexOf(wallId)
    if (index >= 0) {
      selected.splice(index, 1)
    } else {
      if (selected.length >= Number(this.data.maxWallSelect || 2)) {
        wx.showToast({ title: `最多选择${this.data.maxWallSelect}面墙`, icon: 'none' })
        return
      }
      selected.push(wallId)
    }
    this.refreshCandidateStates(selected)
  },

  toggleWallpaperSuggestion(e) {
    const wallId = e.currentTarget && e.currentTarget.dataset ? String(e.currentTarget.dataset.wallId || '') : ''
    if (!wallId || this.data.preferenceSubmitting) return
    const current = (this.data.wallCandidates || []).find(item => item.wall_id === wallId)
    if (!current || !current.suggest_dark_wallpaper) return
    const selected = (this.data.selectedWallIds || []).slice()
    const enabling = !current.wallpaper_opt_in_preview
    if (enabling && current.is_primary && selected.indexOf(wallId) < 0) {
      if (selected.length >= Number(this.data.maxWallSelect || 2)) {
        wx.showToast({ title: '最多选择两面墙', icon: 'none' })
        return
      }
      selected.push(wallId)
    }
    const wallCandidates = (this.data.wallCandidates || []).map(item => {
      const isSelected = selected.indexOf(item.wall_id) >= 0
      return Object.assign({}, item, {
        is_selected: isSelected,
        is_disabled: !isSelected && selected.length >= Number(this.data.maxWallSelect || 2),
        wallpaper_opt_in_preview: item.wall_id === wallId ? enabling : item.wallpaper_opt_in_preview
      })
    })
    this.setData({ selectedWallIds: selected, wallCandidates })
    const changed = wallCandidates.find(item => item.wall_id === wallId)
    trackClientEvent('waiting_wallpaper_suggestion_toggled', {
      page_name: 'waiting', order_id: this.data.orderId, wall_id: wallId,
      enabled: !!(changed && changed.wallpaper_opt_in_preview), phase: 'suggestion_preview'
    })
  },

  openHistory() {
    trackClientEvent('history_entry_clicked', { page_name: 'waiting', order_id: this.data.orderId })
    wx.navigateTo({ url: '/pages/history/history' })
  },

  replacePhoto() {
    const service = this.data.retryService || 'hang_in_home'
    trackClientEvent('audit_rejected_replace_photo_clicked', { page_name: 'waiting', order_id: this.data.orderId, service_type: service })
    wx.redirectTo({ url: `/pages/upload/upload?service=${encodeURIComponent(service)}&retryFromOrder=${encodeURIComponent(this.data.orderId)}` })
  },

  async submitWallPreference() {
    const selected = this.data.selectedWallIds || []
    if (!selected.length || this.data.preferenceSubmitting) return
    const wallpaperOptIn = {}
    ;(this.data.wallCandidates || []).forEach(item => {
      if (selected.indexOf(item.wall_id) >= 0 && item.suggest_dark_wallpaper) {
        wallpaperOptIn[item.wall_id] = !!item.wallpaper_opt_in_preview
      }
    })
    this.setData({ preferenceSubmitting: true, preferenceMessage: '' })
    try {
      const payload = await request(`${app.globalData.serverUrl}/api/client/wall-preferences`, 'POST', {
        order_id: this.data.orderId,
        delivery_token: this.data.deliveryToken,
        selected_wall_ids: selected,
        wallpaper_opt_in: wallpaperOptIn
      })
      if (payload && payload.primary_wall_rerender_job_id) {
        wx.setStorageSync(`primarySupplement:${this.data.orderId}`, {
          jobId: payload.primary_wall_rerender_job_id,
          wallId: payload.primary_wall_id || ''
        })
      }
      this.setData({
        preferenceSubmitting: false,
        preferenceSubmitted: true,
        selectedWallIds: [],
        preferenceMessage: payload && payload.supplement_job_ids && payload.supplement_job_ids.length
          ? '已开始生成所选墙面的追加效果，完成后会一并交付。'
          : '已记录您的选择；符合条件的追加效果会自动生成。'
      })
      await this.loadThinking(true)
      trackClientEvent('waiting_wall_preference_submitted', {
        page_name: 'waiting', order_id: this.data.orderId,
        selected_wall_ids: selected, wallpaper_opt_in: wallpaperOptIn
      })
    } catch (e) {
      this.setData({ preferenceSubmitting: false, preferenceMessage: '暂时没有保存成功，请稍后再试。' })
    }
  },

  startAdvisorStream(token) {
    if (!token || this.advisorRequestTask || this.data.consultantDone || !this.data.advisorReady) return

    this.advisorSseBuffer = ''
    this.advisorReceivedChunks = false
    this.advisorManuallyClosed = false
    try {
      this.advisorTextDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null
    } catch (e) {
      this.advisorTextDecoder = null
    }
    this.setData({ consultantStreaming: true, consultantError: false, consultantDone: false })

    const url = `${app.globalData.serverUrl}/api/hanging/llm-stream/${this.data.orderId}?token=${encodeURIComponent(token)}&task=waiting_progress`
    console.log('[waiting:advisor-stream:start]', { orderId: this.data.orderId, task: 'waiting_progress', hasToken: Boolean(token), url: url.replace(encodeURIComponent(token), '***') })
    trackClientEvent('waiting_advisor_stream_started', { page_name: 'waiting', order_id: this.data.orderId })

    const task = wx.request({
      url,
      method: 'GET',
      enableChunked: true,
      responseType: 'arraybuffer',
      header: { Accept: 'text/event-stream' },
      success: res => {
        console.log('[waiting:advisor-stream:success]', { orderId: this.data.orderId, statusCode: res && res.statusCode, receivedChunks: this.advisorReceivedChunks })
        if (!this.advisorReceivedChunks && res && res.data) {
          this.handleAdvisorChunk(res.data)
        }
        if (res.statusCode && res.statusCode >= 400) {
          console.warn('[waiting:advisor-stream:http-error]', res.statusCode)
          this.setData({ consultantError: true })
        }
      },
      fail: err => {
        if (!this.advisorManuallyClosed) {
          console.warn('[waiting:advisor-stream:fail]', err)
          this.setData({ consultantStreaming: false, consultantError: true })
          trackClientEvent('waiting_advisor_stream_failed', { page_name: 'waiting', order_id: this.data.orderId, error_msg: err && err.errMsg ? err.errMsg : '' })
        }
      },
      complete: () => {
        this.advisorRequestTask = null
        if (!this.data.consultantDone) {
          this.setData({ consultantStreaming: false })
        }
      }
    })

    this.advisorRequestTask = task
    if (task && task.onChunkReceived) {
      task.onChunkReceived(res => {
        this.advisorReceivedChunks = true
        console.log('[waiting:advisor-stream:chunk]', { orderId: this.data.orderId, byteLength: res && res.data && res.data.byteLength })
        this.handleAdvisorChunk(res.data)
      })
    }
  },

  stopAdvisorStream({ keepText } = {}) {
    this.advisorManuallyClosed = true
    if (this.advisorRequestTask && this.advisorRequestTask.abort) {
      try { this.advisorRequestTask.abort() } catch (e) {}
    }
    this.advisorRequestTask = null
    this.advisorSseBuffer = ''
    if (!keepText) {
      this.advisorTypingQueue = ''
      this.clearTypingTimer()
      this.setData({ consultantText: '', consultantTyping: false })
    }
    this.setData({ consultantStreaming: false })
  },

  handleAdvisorChunk(data) {
    const text = decodeUtf8Chunk(data, this.advisorTextDecoder)
    if (!text) return

    this.advisorSseBuffer += text
    const events = this.advisorSseBuffer.split(/\r?\n\r?\n/)
    this.advisorSseBuffer = events.pop() || ''

    events.forEach(raw => {
      const lines = raw.split(/\r?\n/)
      const dataLines = lines
        .filter(line => line.indexOf('data:') === 0)
        .map(line => line.slice(5).trim())

      if (!dataLines.length) return
      const payload = dataLines.join('\n')

      if (payload === '[DONE]') {
        this.finishAdvisorStream()
        return
      }

      try {
        const obj = JSON.parse(payload)

        if (obj && obj.wait) {
          const retryAfterMs = asNumber(obj.retryAfterMs) || 6000
          this.advisorDeferredUntil = Date.now() + retryAfterMs
          console.log('[waiting:advisor-stream:wait]', {
            orderId: this.data.orderId,
            retryAfterMs,
            reason: obj.reason || ''
          })
          return
        }

        if (obj && obj.text) {
          console.log('[waiting:advisor-stream:text]', { orderId: this.data.orderId, len: String(obj.text || '').length, preview: String(obj.text || '').slice(0, 20) })
          this.enqueueAdvisorText(obj.text)
          this.advisorReceivedText = true
        }
      } catch (e) {}
    })
  },

  enqueueAdvisorText(text) {
    const customerText = refineCustomerCopy(text)
    if (!customerText) return
    this.advisorTypingQueue += customerText
    if (!this.data.consultantTyping) {
      this.setData({ consultantTyping: true })
    }
    this.scheduleTypingTick()
  },

  scheduleTypingTick() {
    if (this.advisorTypingTimer) return
    const delay = this.nextTypingDelay()
    this.advisorTypingTimer = setTimeout(() => {
      this.advisorTypingTimer = null
      if (!this.advisorTypingQueue) {
        this.setData({ consultantTyping: false })
        return
      }

      const ch = this.advisorTypingQueue.slice(0, 1)
      this.advisorTypingQueue = this.advisorTypingQueue.slice(1)

      this.setData({
        consultantText: `${this.data.consultantText}${ch}`,
        consultantTyping: this.advisorTypingQueue.length > 0
      })
      this.scheduleTypingTick()
    }, delay)
  },

  nextTypingDelay() {
    const last = this.data.consultantText.slice(-1)
    if ('，。；、！？'.indexOf(last) >= 0) return 130 + Math.floor(Math.random() * 90)
    return 24 + Math.floor(Math.random() * 46)
  },

  finishAdvisorStream() {
    console.log('[waiting:advisor-stream:done]', { orderId: this.data.orderId, received_text: this.advisorReceivedText })
    this.advisorManuallyClosed = true
    if (this.advisorRequestTask && this.advisorRequestTask.abort) {
      try { this.advisorRequestTask.abort() } catch (e) {}
    }
    this.advisorRequestTask = null
    const done = Boolean(this.advisorReceivedText)
    this.setData({ consultantStreaming: false, consultantDone: done })
    trackClientEvent('waiting_advisor_stream_done', {
      page_name: 'waiting',
      order_id: this.data.orderId,
      received_text: done
    })
  },

  clearTypingTimer() {
    if (this.advisorTypingTimer) {
      clearTimeout(this.advisorTypingTimer)
      this.advisorTypingTimer = null
    }
  },


  clearCollectionAdvisorTimers() {
    if (this.advisorExpandTimer) {
      clearTimeout(this.advisorExpandTimer)
      this.advisorExpandTimer = null
    }
    if (this.advisorAutoCollapseTimer) {
      clearTimeout(this.advisorAutoCollapseTimer)
      this.advisorAutoCollapseTimer = null
    }
  },

  scheduleCollectionAdvisorAutoCollapse() {
    if (this.advisorAutoCollapseTimer) clearTimeout(this.advisorAutoCollapseTimer)
    this.advisorAutoCollapseTimer = setTimeout(() => {
      this.advisorAutoCollapseTimer = null
      if (!this.data.collectionAdvisorExpanded) return
      this.setData({ collectionAdvisorExpanded: false })
      trackClientEvent('collection_advisor_auto_collapsed', {
        page_name: 'waiting',
        order_id: this.data.orderId
      })
    }, 15000)
  },

  startCollectionAdvisorIntro() {
    this.clearCollectionAdvisorTimers()
    if (!(this.data.collectionAdvisorName || this.data.collectionAdvisorWechat)) return

    this.setData({ collectionAdvisorExpanded: false })
    this.advisorExpandTimer = setTimeout(() => {
      this.advisorExpandTimer = null
      this.setData({ collectionAdvisorExpanded: true })
      this.scheduleCollectionAdvisorAutoCollapse()
    }, 180)
  },

  toggleCollectionAdvisor() {
    const expanded = !this.data.collectionAdvisorExpanded
    this.setData({ collectionAdvisorExpanded: expanded })

    if (expanded) {
      this.scheduleCollectionAdvisorAutoCollapse()
    } else if (this.advisorAutoCollapseTimer) {
      clearTimeout(this.advisorAutoCollapseTimer)
      this.advisorAutoCollapseTimer = null
    }

    trackClientEvent('collection_advisor_panel_toggled', {
      page_name: 'waiting',
      order_id: this.data.orderId,
      expanded
    })
  },

  copyCollectionAdvisorWechat() {
    const value = String(this.data.collectionAdvisorWechat || '').trim()
    if (!value) return
    wx.setClipboardData({
      data: value,
      success: () => {
        if (this.advisorCopyResetTimer) clearTimeout(this.advisorCopyResetTimer)
        this.setData({ collectionAdvisorCopied: true })
        try { wx.vibrateShort({ type: 'light' }) } catch (e) {}
        this.advisorCopyResetTimer = setTimeout(() => {
          this.advisorCopyResetTimer = null
          this.setData({ collectionAdvisorCopied: false })
        }, 1800)
        trackClientEvent('collection_advisor_wechat_copied', {
          page_name: 'waiting',
          order_id: this.data.orderId
        })
      }
    })
  },

  goHome() {
    trackClientEvent('waiting_leave_home', { page_name: 'waiting', order_id: this.data.orderId })
    this.stopPolling()
    this.stopAdvisorStream({ keepText: true })
    wx.reLaunch({ url: '/pages/index/index' })
  }
})
