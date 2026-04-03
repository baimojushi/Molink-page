const app = getApp()

function request(url, method, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${app.globalData.token}`
      },
      success: res => {
        if (res.statusCode === 401) {
          // token 失效，重新登录
          app.logout()
          reject({ code: 401 })
          return
        }
        if (res.statusCode === 200) {
          resolve(res.data)
        } else {
          reject(res)
        }
      },
      fail: err => reject(err)
    })
  })
}

function uploadFile(filePath, orderId) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${app.globalData.serverUrl}/api/admin/delivery/upload`,
      filePath,
      name: 'file',
      formData: { orderId },
      header: { 'Authorization': `Bearer ${app.globalData.token}` },
      success: res => {
        const data = JSON.parse(res.data)
        resolve(data)
      },
      fail: reject
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

module.exports = { request, uploadFile, formatTime }
