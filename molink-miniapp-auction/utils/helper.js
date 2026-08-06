function generateDeviceId() {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substr(2, 9)
  return `dev_${timestamp}_${random}`
}


function getAnalyticsSessionId() {
  const key = 'analyticsSessionId'
  let sessionId = wx.getStorageSync(key)
  if (!sessionId) {
    sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    wx.setStorageSync(key, sessionId)
  }
  return sessionId
}

function trackClientEvent(eventName, data = {}) {
  const app = getApp()
  if (!eventName) return Promise.resolve()
  return new Promise(resolve => {
    wx.request({
      url: `${app.globalData.serverUrl}/api/client/app-events`,
      method: 'POST',
      data: Object.assign({
        event_name: eventName,
        platform: 'miniapp',
        session_id: getAnalyticsSessionId(),
        device_uuid: app.globalData.deviceId || '',
        openid: app.globalData.openid || '',
        miniapp_entry_method: app.globalData.miniappEntryMethod || '',
        miniapp_scene: app.globalData.miniappEntryScene || '',
        miniapp_entry_path: app.globalData.miniappEntryPath || '',
        exhibition_id: app.globalData.currentExhibitionId || ''
      }, data || {}),
      header: { 'Content-Type': 'application/json' },
      complete: () => resolve()
    })
  })
}

function formatTime(date) {
  const d = new Date(date)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hour = d.getHours()
  const minute = d.getMinutes()
  return `${month}月${day}日 ${hour}:${String(minute).padStart(2, '0')}`
}

// 藏家端请求（无需token）
function request(url, method, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      data,
      header: { 'Content-Type': 'application/json' },
      success: res => {
        if (res.statusCode === 200) resolve(res.data)
        else reject(res)
      },
      fail: err => reject(err)
    })
  })
}

// 工作人员端请求（带token）
function staffRequest(url, method, data) {
  const app = getApp()
  const hasBody = data !== null && data !== undefined && method !== 'GET' && method !== 'DELETE'
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      data: hasBody ? data : undefined,
      header: hasBody
        ? { 'Content-Type': 'application/json', 'x-admin-secret': app.globalData.token, 'x-admin-actor': app.globalData.staffName || 'staff' }
        : { 'x-admin-secret': app.globalData.token, 'x-admin-actor': app.globalData.staffName || 'staff' },
      success: res => {
        if (res.statusCode === 401) {
          app.logout()
          reject({ code: 401 })
          return
        }
        if (res.statusCode === 200) resolve(res.data)
        else reject(res)
      },
      fail: err => reject(err)
    })
  })
}

// 上传效果图（工作人员端）
function uploadDeliveryFile(filePath, orderId) {
  const app = getApp()
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${app.globalData.serverUrl}/api/admin/delivery/upload`,
      filePath,
      name: 'file',
      formData: { orderId },
      header: { 'x-admin-secret': app.globalData.token },
      success: res => {
        const data = JSON.parse(res.data)
        resolve(data)
      },
      fail: reject
    })
  })
}

// 上传藏家图片（藏家端）
function uploadClientFile(filePath, fileType) {
  const app = getApp()
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${app.globalData.serverUrl}/api/client/upload`,
      filePath,
      name: 'file',
      formData: { fileType },
      success: res => {
        const data = JSON.parse(res.data)
        resolve(data)
      },
      fail: reject
    })
  })
}

module.exports = {
  generateDeviceId,
  getAnalyticsSessionId,
  formatTime,
  request,
  staffRequest,
  trackClientEvent,
  uploadDeliveryFile,
  uploadClientFile
}
