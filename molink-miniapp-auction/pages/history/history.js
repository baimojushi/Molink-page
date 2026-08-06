const app = getApp()
const { request, formatTime, trackClientEvent } = require('../../utils/helper')
const { viewerData, viewerMethods } = require('../../utils/fullscreenViewer')

function normalizeText(value) {
  return String(value || '').trim()
}

function collectionAdvisorInitial(name) {
  const value = normalizeText(name).replace(/\s+/g, '')
  return value ? value.slice(0, 1) : '藏'
}

function resolveCollectionAdvisor(source = {}) {
  const exhibition = source.exhibition || source.exhibition_info || source.exhibitionInfo || {}
  const name = normalizeText(
    source.collection_advisor_name ||
    source.collectionAdvisorName ||
    source.exhibition_collection_advisor_name ||
    exhibition.collection_advisor_name ||
    exhibition.collectionAdvisorName
  )
  const wechat = normalizeText(
    source.collection_advisor_wechat ||
    source.collectionAdvisorWechat ||
    source.exhibition_collection_advisor_wechat ||
    exhibition.collection_advisor_wechat ||
    exhibition.collectionAdvisorWechat
  )
  return {
    name,
    wechat,
    initial: collectionAdvisorInitial(name)
  }
}

function buildTiles(orders) {
  const tiles = []
  orders.forEach(order => {
    const urls = Array.isArray(order.imageUrls) ? order.imageUrls : []
    const collectionAdvisor = resolveCollectionAdvisor(order)
    urls.forEach((url, index) => {
      tiles.push({
        key: `${order.id}_${index}`,
        orderId: order.id,
        imageUrl: url,
        previewUrls: urls,
        previewIndex: index,
        title: order.artwork_name || order.service_type_label || '效果图',
        subtitle: order.delivered_at ? formatTime(order.delivered_at) : '',
        serviceLabel: order.service_type_label || '',
        collectionAdvisorName: collectionAdvisor.name,
        collectionAdvisorWechat: collectionAdvisor.wechat,
        collectionAdvisorInitial: collectionAdvisor.initial,
        heightWeight: index % 2 === 0 ? 1 : 1.15
      })
    })
  })
  return tiles
}

Page({
  data: Object.assign({
    loading: false,
    page: 1,
    pageSize: 12,
    hasMore: true,
    total: 0,
    orders: [],
    leftColumn: [],
    rightColumn: [],
    showLoginCard: false,
    loginLoading: false,
    dismissedLoginCard: false,
    viewerOrderId: '',
    viewerCollectionAdvisorName: '',
    viewerCollectionAdvisorWechat: '',
    viewerCollectionAdvisorInitial: '藏',
    viewerCollectionAdvisorCopied: false,
    viewerCollectionAdvisorExpanded: false
  }, viewerData),

  onLoad() {
    trackClientEvent('history_page_view', { page_name: 'history', entry_source: 'miniapp_history' })
    this.syncLoginCard()
    this.refreshHistory()
  },

  onShow() {
    const prev = this.data.showLoginCard
    this.syncLoginCard()
    if (prev !== this.data.showLoginCard) {
      this.refreshHistory()
    }
  },

  onPullDownRefresh() {
    this.refreshHistory().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadHistory()
  },

  syncLoginCard() {
    const loggedIn = !!app.globalData.openid
    this.setData({
      showLoginCard: !loggedIn && !this.data.dismissedLoginCard
    })
  },

  async refreshHistory() {
    this.setData({
      page: 1,
      hasMore: true,
      orders: [],
      leftColumn: [],
      rightColumn: []
    })
    await this.loadHistory(true)
  },

  async loadHistory(isRefresh = false) {
    if (this.data.loading || !this.data.hasMore) return

    this.setData({ loading: true })
    const page = isRefresh ? 1 : this.data.page

    try {
      const deviceId = app.globalData.deviceId
      const query = app.buildIdentityQuery({ page, page_size: this.data.pageSize, history_only: 1 })
      const res = await request(
        `${app.globalData.serverUrl}/api/client/device-orders/${deviceId}?${query}`,
        'GET',
        null
      )

      const incomingOrders = Array.isArray(res.orders) ? res.orders.map(order => ({
        ...order,
        imageUrls: Array.isArray(order.imageUrls) ? order.imageUrls : []
      })) : []

      const orders = isRefresh ? incomingOrders : this.data.orders.concat(incomingOrders)
      const tiles = buildTiles(orders)
      const leftColumn = []
      const rightColumn = []
      let leftScore = 0
      let rightScore = 0
      tiles.forEach(tile => {
        if (leftScore <= rightScore) {
          leftColumn.push(tile)
          leftScore += tile.heightWeight
        } else {
          rightColumn.push(tile)
          rightScore += tile.heightWeight
        }
      })

      this.setData({
        orders,
        leftColumn,
        rightColumn,
        page: page + 1,
        hasMore: !!res.hasMore,
        total: res.total || orders.length
      })
      trackClientEvent(isRefresh ? 'history_loaded' : 'history_more_loaded', {
        page_name: 'history',
        loaded_count: incomingOrders.length,
        total: res.total || orders.length
      })
    } catch (e) {
      wx.showToast({ title: '历史记录加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async doWxLogin() {
    if (this.data.loginLoading) return
    this.setData({ loginLoading: true })
    try {
      await app.wxLogin('', '')
      this.setData({
        showLoginCard: false,
        dismissedLoginCard: false
      })
      await this.refreshHistory()
    } catch (e) {
      wx.showToast({ title: '登录失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loginLoading: false })
    }
  },

  skipLoginCard() {
    trackClientEvent('history_login_skip', { page_name: 'history' })
    this.setData({
      showLoginCard: false,
      dismissedLoginCard: true
    })
  },

  trackEvent(orderId, eventType, payload = {}) {
    wx.request({
      url: `${app.globalData.serverUrl}/api/client/order-events`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: Object.assign({
        order_id: orderId,
        event_type: eventType,
        device_uuid: app.globalData.deviceId || ''
      }, payload),
      fail: () => {}
    })
  },

  previewTile(e) {
    const tile = e.currentTarget.dataset.tile
    if (!tile) return

    trackClientEvent('history_card_click', { page_name: 'history', order_id: tile.orderId, image_index: tile.previewIndex })
    this.trackEvent(tile.orderId, 'image_click', {
      image_url: tile.imageUrl,
      image_index: tile.previewIndex,
      page_name: 'history'
    })

    const requestKey = `${tile.orderId}_${Date.now()}`
    const advisorName = normalizeText(tile.collectionAdvisorName)
    const advisorWechat = normalizeText(tile.collectionAdvisorWechat)
    const hasAdvisor = !!(advisorName || advisorWechat)

    this.viewerAdvisorRequestKey = requestKey
    this.clearViewerCollectionAdvisorTimer()
    this.setData({
      viewerOrderId: tile.orderId,
      viewerCollectionAdvisorName: advisorName,
      viewerCollectionAdvisorWechat: advisorWechat,
      viewerCollectionAdvisorInitial: tile.collectionAdvisorInitial || collectionAdvisorInitial(advisorName),
      viewerCollectionAdvisorCopied: false,
      viewerCollectionAdvisorExpanded: hasAdvisor
    })
    this.openFullscreenViewer(tile.imageUrl)
    if (hasAdvisor) this.scheduleViewerCollectionAdvisorCollapse()
    this.loadViewerCollectionAdvisor(tile.orderId, requestKey)
  },

  async loadViewerCollectionAdvisor(orderId, requestKey) {
    if (!orderId) return
    try {
      const res = await request(
        `${app.globalData.serverUrl}/api/client/order-status/${orderId}`,
        'GET',
        null
      )
      if (
        this.viewerAdvisorRequestKey !== requestKey ||
        !this.data.viewerVisible ||
        String(this.data.viewerOrderId) !== String(orderId)
      ) return

      const resolved = resolveCollectionAdvisor(res)
      const hasResolvedAdvisor = !!(resolved.name || resolved.wechat)
      const hadAdvisor = !!(
        this.data.viewerCollectionAdvisorName ||
        this.data.viewerCollectionAdvisorWechat
      )
      this.setData({
        viewerCollectionAdvisorName: hasResolvedAdvisor ? resolved.name : this.data.viewerCollectionAdvisorName,
        viewerCollectionAdvisorWechat: hasResolvedAdvisor ? resolved.wechat : this.data.viewerCollectionAdvisorWechat,
        viewerCollectionAdvisorInitial: hasResolvedAdvisor
          ? resolved.initial
          : collectionAdvisorInitial(this.data.viewerCollectionAdvisorName),
        viewerCollectionAdvisorExpanded: hasResolvedAdvisor && !hadAdvisor
          ? true
          : this.data.viewerCollectionAdvisorExpanded
      }, () => {
        if (hasResolvedAdvisor && !hadAdvisor) {
          this.scheduleViewerCollectionAdvisorCollapse()
        }
      })
    } catch (e) {
      // 收藏顾问信息属于辅助内容，请求失败时保持历史列表已有数据或继续隐藏。
    }
  },

  clearViewerCollectionAdvisorTimer() {
    if (this.viewerAdvisorCollapseTimer) {
      clearTimeout(this.viewerAdvisorCollapseTimer)
      this.viewerAdvisorCollapseTimer = null
    }
  },

  scheduleViewerCollectionAdvisorCollapse() {
    this.clearViewerCollectionAdvisorTimer()
    if (!(
      this.data.viewerCollectionAdvisorName ||
      this.data.viewerCollectionAdvisorWechat
    )) return

    this.viewerAdvisorCollapseTimer = setTimeout(() => {
      this.viewerAdvisorCollapseTimer = null
      if (!this.data.viewerVisible || !this.data.viewerCollectionAdvisorExpanded) return
      this.setData({ viewerCollectionAdvisorExpanded: false })
      trackClientEvent('history_viewer_collection_advisor_auto_collapsed', {
        page_name: 'history',
        order_id: this.data.viewerOrderId
      })
    }, 10000)
  },

  toggleViewerCollectionAdvisor() {
    const expanded = !this.data.viewerCollectionAdvisorExpanded
    this.setData({ viewerCollectionAdvisorExpanded: expanded })

    if (expanded) {
      this.scheduleViewerCollectionAdvisorCollapse()
    } else {
      this.clearViewerCollectionAdvisorTimer()
    }

    trackClientEvent('history_viewer_collection_advisor_toggled', {
      page_name: 'history',
      order_id: this.data.viewerOrderId,
      expanded
    })
  },

  copyViewerCollectionAdvisorWechat() {
    const value = normalizeText(this.data.viewerCollectionAdvisorWechat)
    if (!value) return

    wx.setClipboardData({
      data: value,
      success: () => {
        if (this.viewerAdvisorCopyTimer) clearTimeout(this.viewerAdvisorCopyTimer)
        this.setData({ viewerCollectionAdvisorCopied: true })
        this.viewerAdvisorCopyTimer = setTimeout(() => {
          this.viewerAdvisorCopyTimer = null
          if (this.data.viewerVisible) {
            this.setData({ viewerCollectionAdvisorCopied: false })
          }
        }, 1600)
        trackClientEvent('history_viewer_collection_advisor_copied', {
          page_name: 'history',
          order_id: this.data.viewerOrderId
        })
      }
    })
  },

  onUnload() {
    this.viewerAdvisorRequestKey = ''
    this.clearViewerCollectionAdvisorTimer()
    if (this.viewerAdvisorCopyTimer) {
      clearTimeout(this.viewerAdvisorCopyTimer)
      this.viewerAdvisorCopyTimer = null
    }
  },

  // Fullscreen viewer methods
  ...viewerMethods,

  closeFullscreenViewer() {
    this.viewerAdvisorRequestKey = ''
    this.clearViewerCollectionAdvisorTimer()
    if (this.viewerAdvisorCopyTimer) {
      clearTimeout(this.viewerAdvisorCopyTimer)
      this.viewerAdvisorCopyTimer = null
    }
    viewerMethods.closeFullscreenViewer.call(this)
    this.setData({
      viewerOrderId: '',
      viewerCollectionAdvisorName: '',
      viewerCollectionAdvisorWechat: '',
      viewerCollectionAdvisorInitial: '藏',
      viewerCollectionAdvisorCopied: false,
      viewerCollectionAdvisorExpanded: false
    })
  }
})
