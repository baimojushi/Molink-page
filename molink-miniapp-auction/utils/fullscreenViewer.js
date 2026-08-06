// utils/fullscreenViewer.js —— 可复用的全屏查看器 + 贝塞尔缩放入场
//
// 用法：
//   1. 在 Page 的 data 中加入 viewer 字段：Object.assign({}, require('../../utils/fullscreenViewer').viewerData)
//   2. 在 Page methods 中混入：Object.assign(Page({...}), require('../../utils/fullscreenViewer').methods)
//   3. 在 wxml 中加入 <include src="../../utils/fullscreenViewer.wxml" /> 或直接复制 wxml 片段
//   4. 在 wxss 中加入 <style src="../../utils/fullscreenViewer.wxss" /> 或复制样式

const VIEWER_MIN_SCALE = 1
const VIEWER_MAX_SCALE = 4
const BEZIER_MOTION_DURATION = 1120
const BEZIER_MOTION_FRAME_COUNT = 14

function rounded(value, precision = 2) {
  const factor = Math.pow(10, precision)
  return Math.round(Number(value || 0) * factor) / factor
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)))
}

function smootherStep(value) {
  const t = clamp(value, 0, 1)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function buildBezierMotionFrames(startX, startY, startScale, endX, endY, endScale, direction) {
  const dx = endX - startX
  const dy = endY - startY
  const distance = Math.sqrt(dx * dx + dy * dy)
  const scaleDelta = Math.abs(endScale - startScale)
  const arcStrength = Math.max(36, Math.min(78, distance * 0.34 + scaleDelta * 36))

  let controlX
  let controlY
  if (distance > 1) {
    const perpendicularX = -dy / distance
    const perpendicularY = dx / distance
    controlX = (startX + endX) / 2 + perpendicularX * arcStrength * direction
    controlY = (startY + endY) / 2 + perpendicularY * arcStrength * direction - 10
  } else {
    controlX = (startX + endX) / 2 + 48 * direction
    controlY = (startY + endY) / 2 - 32
  }

  const frames = []
  for (let index = 1; index <= BEZIER_MOTION_FRAME_COUNT; index += 1) {
    const timeline = index / BEZIER_MOTION_FRAME_COUNT
    const progress = smootherStep(timeline)
    const inverse = 1 - progress
    const x = inverse * inverse * startX + 2 * inverse * progress * controlX + progress * progress * endX
    const y = inverse * inverse * startY + 2 * inverse * progress * controlY + progress * progress * endY
    const scale = startScale + (endScale - startScale) * progress
    frames.push({ x, y, scale })
  }
  return frames
}

const viewerData = {
  viewerVisible: false,
  viewerUrl: '',
  viewerScale: VIEWER_MIN_SCALE,
  viewerScaleText: '100%',
  viewerX: 0,
  viewerY: 0
}

const viewerMethods = {
  _viewerInit() {
    this.viewerScaleValue = VIEWER_MIN_SCALE
    this.lastViewerTapAt = 0
    this.lastViewerScaleLabelAt = 0
  },

  openFullscreenViewer(src, options = {}) {
    this._viewerInit()
    this.setData({
      viewerVisible: true,
      viewerUrl: src || options.url || '',
      viewerScale: VIEWER_MIN_SCALE,
      viewerScaleText: '100%',
      viewerX: 0,
      viewerY: 0
    })
  },

  closeFullscreenViewer() {
    this.viewerScaleValue = VIEWER_MIN_SCALE
    this.setData({
      viewerVisible: false,
      viewerUrl: '',
      viewerScale: VIEWER_MIN_SCALE,
      viewerScaleText: '100%',
      viewerX: 0,
      viewerY: 0
    })
  },

  onViewerScale(e) {
    const scale = clamp(e.detail && e.detail.scale, VIEWER_MIN_SCALE, VIEWER_MAX_SCALE)
    this.viewerScaleValue = scale
    const now = Date.now()
    if (!this.lastViewerScaleLabelAt || now - this.lastViewerScaleLabelAt > 70) {
      this.lastViewerScaleLabelAt = now
      this.setData({ viewerScaleText: `${Math.round(scale * 100)}%` })
    }
  },

  setFullscreenViewerScale(value, resetPosition = false) {
    const scale = clamp(value, VIEWER_MIN_SCALE, VIEWER_MAX_SCALE)
    this.viewerScaleValue = scale
    this.setData({
      viewerScale: scale,
      viewerScaleText: `${Math.round(scale * 100)}%`
    })
    if (resetPosition || scale <= VIEWER_MIN_SCALE + 0.001) {
      this.resetFullscreenViewerPosition()
    }
  },

  resetFullscreenViewerPosition() {
    this.setData({ viewerX: 1, viewerY: 1 }, () => {
      setTimeout(() => {
        this.setData({ viewerX: 0, viewerY: 0 })
      }, 18)
    })
  },

  zoomFullscreenViewerIn() {
    const current = Number(this.viewerScaleValue || this.data.viewerScale || VIEWER_MIN_SCALE)
    this.setFullscreenViewerScale(current + 0.5)
  },

  zoomFullscreenViewerOut() {
    const current = Number(this.viewerScaleValue || this.data.viewerScale || VIEWER_MIN_SCALE)
    this.setFullscreenViewerScale(current - 0.5)
  },

  resetFullscreenViewer() {
    this.setFullscreenViewerScale(VIEWER_MIN_SCALE, true)
  },

  onViewerImageTap() {
    const now = Date.now()
    if (this.lastViewerTapAt && now - this.lastViewerTapAt < 280) {
      const current = Number(this.viewerScaleValue || VIEWER_MIN_SCALE)
      this.setFullscreenViewerScale(current > 1.15 ? VIEWER_MIN_SCALE : 2.5, current > 1.15)
      this.lastViewerTapAt = 0
      return
    }
    this.lastViewerTapAt = now
  },

  animateViewerBezier(entryDirection = 1) {
    const frames = buildBezierMotionFrames(
      0, 0, VIEWER_MIN_SCALE,
      0, 0, VIEWER_MIN_SCALE,
      entryDirection
    )
    // 简化版：仅做缩放入场
    const animation = wx.createAnimation({
      duration: Math.max(60, Math.round(BEZIER_MOTION_DURATION / frames.length)),
      timingFunction: 'linear',
      transformOrigin: '50% 50%'
    })
    frames.forEach(frame => {
      animation.scale(rounded(frame.scale, 4)).step({
        duration: Math.max(60, Math.round(BEZIER_MOTION_DURATION / frames.length)),
        timingFunction: 'linear'
      })
    })
    return animation.export()
  }
}

module.exports = {
  viewerData,
  viewerMethods,
  VIEWER_MIN_SCALE,
  VIEWER_MAX_SCALE,
  buildBezierMotionFrames,
  clamp,
  rounded,
  smootherStep
}
