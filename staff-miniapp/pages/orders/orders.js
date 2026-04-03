const app = getApp()
const { request, formatTime } = require('../../utils/request')

const STATUS_MAP = {
  pending: { label: '待处理', color: '#e67e22' },
  processing: { label: '处理中', color: '#2980b9' },
  completed: { label: '已完成', color: '#27ae60' }
}

Page({
  data: {
    orders: [],
    loading: true,
    staffName: '',
    filterStatus: 'all'  // all | pending | completed
  },

  onLoad() {
    if (!app.isLoggedIn()) {
      wx.redirectTo({ url: '/pages/login/login' })
      return
    }
    this.setData({ staffName: app.globalData.staffName })
    this.loadOrders()
  },

  onShow() {
    // 每次回到列表页刷新
    if (app.isLoggedIn()) {
      this.loadOrders()
    }
  },

  async loadOrders() {
    this.setData({ loading: true })
    try {
      const res = await request(
        `${app.globalData.serverUrl}/api/admin/orders`,
        'GET',
        null
      )
      const orders = (res.orders || []).map(order => ({
        ...order,
        statusInfo: STATUS_MAP[order.status] || STATUS_MAP.pending,
        submitTimeFormatted: formatTime(order.submitTime)
      }))
      this.setData({ orders })
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  goToDetail(e) {
    const orderId = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/order-detail/order-detail?orderId=${orderId}`
    })
  },

  setFilter(e) {
    this.setData({ filterStatus: e.currentTarget.dataset.status })
  },

  get filteredOrders() {
    if (this.data.filterStatus === 'all') return this.data.orders
    return this.data.orders.filter(o => o.status === this.data.filterStatus)
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确认退出？',
      success: res => {
        if (res.confirm) app.logout()
      }
    })
  },

  onPullDownRefresh() {
    this.loadOrders().then(() => {
      wx.stopPullDownRefresh()
    })
  }
})
