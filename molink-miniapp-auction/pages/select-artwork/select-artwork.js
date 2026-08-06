const app = getApp()
const { normalizeArtwork } = require('../../utils/artwork')
const { decorateArtworkThumbs } = require('../../utils/image')
const { viewerData, viewerMethods } = require('../../utils/fullscreenViewer')

Page({
  data: {
    artworks: [],
    selected: null,
    loading: true
  },

  onLoad() {
    if (!app.globalData.currentExhibitionId) {
      wx.reLaunch({ url: '/pages/select-exhibition/index' })
      return
    }
    this.loadArtworks()
  },

  loadArtworks() {
    wx.request({
      url: `${app.globalData.serverUrl}/api/client/artworks-lite?exhibition_id=${encodeURIComponent(app.globalData.currentExhibitionId)}`,
      success: res => {
        if (res.statusCode === 200 && res.data && res.data.need_exhibition) {
          wx.reLaunch({ url: '/pages/select-exhibition/index' })
        } else if (res.statusCode === 200 && Array.isArray(res.data.artworks)) {
          const artworks = res.data.artworks.map(item => {
            try {
              return decorateArtworkThumbs(app.globalData.serverUrl, normalizeArtwork(app.globalData.serverUrl, item), 360)
            } catch (error) {
              console.warn('normalize artwork failed:', error)
              return normalizeArtwork(app.globalData.serverUrl, item)
            }
          })
          this.setData({ artworks, loading: false })
        } else {
          wx.showToast({ title: '加载失败，请重试', icon: 'none' })
          this.setData({ loading: false })
        }
      },
      fail: () => {
        wx.showToast({ title: '加载失败，请重试', icon: 'none' })
        this.setData({ loading: false })
      }
    })
  },

  selectArtwork(e) {
    const artwork = e.currentTarget.dataset.artwork
    this.setData({ selected: artwork })
  },

  previewArtwork(e) {
    const artwork = e.currentTarget.dataset.artwork
    wx.previewImage({
      current: (artwork.images && artwork.images[0]) || '',
      urls: artwork.images || []
    })
  },

  confirmSelection() {
    const { selected } = this.data
    if (!selected) {
      wx.showToast({ title: '请先选择作品', icon: 'none' })
      return
    }
    const pages = getCurrentPages()
    const prevPage = pages[pages.length - 2]
    if (selected.exhibition_id) {
      app.setCurrentExhibition({
        id: selected.exhibition_id,
        name: selected.exhibition_name || app.globalData.currentExhibitionName,
        status: selected.exhibition_status || app.globalData.currentExhibitionStatus
      })
    }
    if (prevPage) {
      prevPage.setData({
        presetArtwork: selected,
        initialArtworkId: selected.id || '',
        initialArtworkRef: selected.artwork_code || '',
        exhibitionId: selected.exhibition_id || app.globalData.currentExhibitionId
      })
    }
    wx.navigateBack()
  }
})
