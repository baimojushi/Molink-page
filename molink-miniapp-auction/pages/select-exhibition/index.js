const app = getApp()
const { trackClientEvent } = require('../../utils/helper')

Page({
  data: {
    exhibitions: [],
    loading: true,
    locating: false,
    errorText: '',
    locationHint: ''
  },

  onLoad(options = {}) {
    this.forceManual = String(options.mode || '') === 'switch'
    this.loadExhibitions()
  },

  onPullDownRefresh() {
    this.loadExhibitions(true).finally(() => wx.stopPullDownRefresh())
  },

  async loadExhibitions(forceManual = false) {
    this.setData({ loading: true, errorText: '' })
    try {
      const exhibitions = await new Promise((resolve, reject) => {
        wx.request({
          url: `${app.globalData.serverUrl}/api/client/exhibitions?status=live`,
          success: res => {
            if (res.statusCode === 200 && Array.isArray(res.data.exhibitions)) resolve(res.data.exhibitions)
            else reject(new Error('展览列表加载失败'))
          },
          fail: reject
        })
      })
      this.setData({ exhibitions, loading: false })
      trackClientEvent('exhibition_select_view', {
        page_name: 'select_exhibition',
        exhibition_count: exhibitions.length
      })
      if (!forceManual && !this.forceManual && exhibitions.length === 1) {
        this.chooseExhibitionByValue(exhibitions[0], 'single_live_auto')
        return
      }
      this.tryGeoLocate()
    } catch (error) {
      this.setData({ loading: false, errorText: '展览列表加载失败，请下拉重试' })
    }
  },

  chooseExhibition(event) {
    const exhibition = event.currentTarget.dataset.exhibition || {}
    this.chooseExhibitionByValue(exhibition, 'manual_select')
  },

  chooseExhibitionByValue(exhibition, selectionMethod) {
    if (!exhibition || !exhibition.id) return
    app.setCurrentExhibition(exhibition)
    trackClientEvent('exhibition_selected', {
      page_name: 'select_exhibition',
      exhibition_id: exhibition.id,
      exhibition_name: exhibition.name || '',
      selection_method: selectionMethod
    })
    wx.reLaunch({ url: '/pages/index/index' })
  },

  tryGeoLocate() {
    if (!app.globalData.ENABLE_GEO_ENTRY) return
    if (this.data.locating) return
    const canUseFuzzy = wx.canIUse && wx.canIUse('getFuzzyLocation') && typeof wx.getFuzzyLocation === 'function'
    if (!canUseFuzzy) {
      this.setData({ locationHint: '当前微信版本不支持模糊定位，可手动选择展览。' })
      return
    }
    this.setData({ locating: true })
    wx.getFuzzyLocation({
      type: 'gcj02',
      success: location => {
        wx.request({
          url: `${app.globalData.serverUrl}/api/client/exhibitions/locate`,
          method: 'POST',
          header: { 'Content-Type': 'application/json' },
          data: { lat: location.latitude, lng: location.longitude },
          success: res => {
            if (res.statusCode === 200 && res.data && res.data.exhibition) {
              this.chooseExhibitionByValue(res.data.exhibition, 'geo_locate')
            }
          },
          fail: () => this.setData({ locationHint: '附近未匹配到展览，请手动选择。' }),
          complete: () => this.setData({ locating: false })
        })
      },
      fail: () => this.setData({ locating: false, locationHint: '定位权限暂不可用，可手动选择展览。' })
    })
  },

  locateHere(event) {
    const exhibition = event.currentTarget.dataset.exhibition || {}
    if (!exhibition.id || this.data.locating) return
    this.setData({ locating: true, locationHint: '正在确认您在展览现场…' })
    wx.request({
      url: `${app.globalData.serverUrl}/api/client/exhibitions/locate`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { demo_exhibition_id: exhibition.id },
      success: res => {
        if (res.statusCode === 200 && res.data && res.data.exhibition) {
          this.chooseExhibitionByValue(res.data.exhibition, 'geo_demo')
        } else this.setData({ locationHint: '未能确认您在展览现场，请直接选择展览。' })
      },
      fail: () => this.setData({ locationHint: '未能确认您在展览现场，请直接选择展览。' }),
      complete: () => this.setData({ locating: false })
    })
  },

  formatDateRange(exhibition = {}) {
    const start = String(exhibition.starts_at || '').slice(0, 10)
    const end = String(exhibition.ends_at || '').slice(0, 10)
    if (start && end) return `${start} — ${end}`
    if (start) return `${start} 起`
    return '展期详见现场公告'
  }
})
