function generateDeviceId() {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substr(2, 9)
  return `dev_${timestamp}_${random}`
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
        ? { 'Content-Type': 'application/json', 'x-admin-secret': app.globalData.token }
        : { 'x-admin-secret': app.globalData.token },
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
  formatTime,
  request,
  staffRequest,
  uploadDeliveryFile,
  uploadClientFile
}
