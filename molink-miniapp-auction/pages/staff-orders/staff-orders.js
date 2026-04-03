const app = getApp()
const { staffRequest, formatTime } = require('../../utils/helper')

const STATUS_TEXT = {
  pending: '待处理',
  ai_generating: 'AI生图中',
  ai_ready: '待审核',
  processing: '处理中',
  delivered: '已交付',
  viewed: '已查看',
  downloaded: '已下载'
}

Page({
  data: {
    orders: [],
    filteredOrders: [],
    loading: true,
    staffName: '',
    filterStatus: 'all'
  },

  onLoad() {
    if (!app.isLoggedIn()) {
      wx.redirectTo({ url: '/pages/staff-login/staff-login' })
      return
    }
    this.setData({ staffName: app.globalData.staffName })
    this.loadOrders()
  },

  onShow() {
    if (app.isLoggedIn()) this.loadOrders()
  },

  onPullDownRefresh() {
    this.loadOrders().then(() => wx.stopPullDownRefresh())
  },

  async loadOrders() {
    this.setData({ loading: true })
    try {
      const res = await staffRequest(
        `${app.globalData.serverUrl}/api/admin/orders`,
        'GET',
        null
      )
      const orders = (res.orders || []).map(order => ({
        ...order,
        serviceLabel: order.service_type_label,
        statusText: STATUS_TEXT[order.status] || '待处理',
        submitTimeFormatted: formatTime(order.created_at)
      }))
      this.setData({ orders })
      this.applyFilter()
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  setFilter(e) {
    this.setData({ filterStatus: e.currentTarget.dataset.status })
    this.applyFilter()
  },

  applyFilter() {
    const { orders, filterStatus } = this.data
    let filtered
    if (filterStatus === 'all') {
      filtered = orders
    } else if (filterStatus === 'pending') {
      filtered = orders.filter(o => ['pending', 'ai_generating', 'processing'].includes(o.status))
    } else if (filterStatus === 'completed') {
      filtered = orders.filter(o => ['delivered', 'viewed', 'downloaded'].includes(o.status))
    } else {
      filtered = orders.filter(o => o.status === filterStatus)
    }
    this.setData({ filteredOrders: filtered })
  },

  goToDetail(e) {
    wx.navigateTo({
      url: `/pages/staff-detail/staff-detail?orderId=${e.currentTarget.dataset.id}`
    })
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确认退出？',
      success: res => {
        if (res.confirm) app.logout()
      }
    })
  }
})
