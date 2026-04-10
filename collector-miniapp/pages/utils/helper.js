// 生成设备唯一ID
function generateDeviceId() {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substr(2, 9)
  return `dev_${timestamp}_${random}`
}

// 格式化时间
function formatTime(date) {
  const d = new Date(date)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hour = d.getHours()
  const minute = d.getMinutes()
  return `${month}月${day}日 ${hour}:${String(minute).padStart(2, '0')}`
}

// 请求封装
function request(url, method, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      data,
      header: { 'Content-Type': 'application/json' },
      success: res => {
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

module.exports = { generateDeviceId, formatTime, request }
