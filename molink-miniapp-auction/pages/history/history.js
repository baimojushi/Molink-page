const app = getApp()
const { request, formatTime } = require('../../utils/helper')

function buildTiles(orders) {
  const tiles = []
  orders.forEach(order => {
    const urls = Array.isArray(order.imageUrls) ? order.imageUrls : []
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
        heightWeight: index % 2 === 0 ? 1 : 1.15
      })
    })
  })
  return tiles
}

Page({
  data: {
    loading: false,
    page: 1,
    pageSize: 12,
    hasMore: true,
    total: 0,
    orders: [],
    leftColumn: [],
    rightColumn: []
  },

  onLoad() {
    this.refreshHistory()
  },

  onPullDownRefresh() {
    this.refreshHistory().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadHistory()
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
      const res = await request(
        `${app.globalData.serverUrl}/api/client/device-orders/${deviceId}?page=${page}&page_size=${this.data.pageSize}&history_only=1`,
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
    } catch (e) {
      wx.showToast({ title: '历史记录加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
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

    this.trackEvent(tile.orderId, 'image_click', {
      image_url: tile.imageUrl,
      image_index: tile.previewIndex,
      page_name: 'history'
    })

    wx.previewImage({
      current: tile.imageUrl,
      urls: tile.previewUrls || [tile.imageUrl]
    })
  }
})
