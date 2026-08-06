function roundedSeconds(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000
  if (seconds < 60) return Math.max(10, Math.round(seconds / 10) * 10)
  if (seconds <= 300) return Math.max(60, Math.round(seconds / 30) * 30)
  return Math.max(60, Math.round(seconds / 60) * 60)
}

function durationText(ms) {
  const seconds = roundedSeconds(ms)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  return `${minutes} 分钟`
}

function presentEta(value) {
  if (!value) return { visible: false, primaryText: '', rangeText: '', stateText: '', stale: false }
  const state = String(value.state || '')
  if (state === 'UNAVAILABLE' || value.displayMode === 'HIDDEN') {
    return { visible: false, primaryText: '', rangeText: '', stateText: '', stale: false }
  }
  if (state === 'COMPLETED') {
    return { visible: true, primaryText: '即将完成', rangeText: '', stateText: '', stale: false }
  }
  if (state === 'STALE' || value.stale) {
    return {
      visible: true,
      primaryText: `上次预估 ${durationText(value.p50Ms)}`,
      rangeText: value.p90Ms > value.p50Ms ? `保守范围至 ${durationText(value.p90Ms)}` : '',
      stateText: '预估正在刷新',
      stale: true
    }
  }
  if (state === 'PAUSED') {
    return { visible: true, primaryText: `恢复后约 ${durationText(value.p50Ms)}`, rangeText: '', stateText: '任务已暂停', stale: false }
  }

  const rangeText = value.p90Ms > value.p50Ms
    ? `通常在 ${durationText(value.p50Ms)}–${durationText(value.p90Ms)} 内完成`
    : ''
  if (value.displayMode === 'RANGE_ONLY' || value.confidence === 'LOW') {
    return { visible: true, primaryText: rangeText || `预计 ${durationText(value.p90Ms)}`, rangeText: '', stateText: '当前为保守预估', stale: false }
  }
  return {
    visible: true,
    primaryText: value.p50Ms <= 10000 ? '即将完成' : `预计约 ${durationText(value.p50Ms)}`,
    rangeText,
    stateText: '',
    stale: false
  }
}

module.exports = { presentEta, durationText, roundedSeconds }
