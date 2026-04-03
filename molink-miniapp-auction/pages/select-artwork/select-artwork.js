const app = getApp()

Page({
  data: {
    artworks: [],
    selected: null,
    loading: true
  },

  onLoad() {
    this.loadArtworks()
  },

  loadArtworks() {
    wx.request({
      url: `${app.globalData.serverUrl}/api/client/artworks`,
      success: res => {
        if (res.statusCode === 200 && res.data.artworks) {
          const serverUrl = app.globalData.serverUrl
          const artworks = res.data.artworks.map(a => {
            a.images = a.images.map(img => serverUrl + img)
            return a
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
      current: artwork.images[0],
      urls: artwork.images
    })
  },

  confirmSelection() {
    const { selected } = this.data
    if (!selected) {
      wx.showToast({ title: '请先选择作品', icon: 'none' })
      return
    }
    // 将选中作品传给上传页
    const pages = getCurrentPages()
    const prevPage = pages[pages.length - 2]
    if (prevPage) {
      prevPage.setData({ presetArtwork: selected })
    }
    wx.navigateBack()
  }
})
