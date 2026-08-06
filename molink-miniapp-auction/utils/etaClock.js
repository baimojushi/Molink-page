function finiteOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function createEtaAnchor(snapshot, requestStartedMs, responseReceivedMs) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const remaining = snapshot.wallRemaining || snapshot.activeRemaining
  if (!remaining || typeof remaining !== 'object') return null
  const p50 = finiteOrNull(remaining.p50Ms)
  const p90 = finiteOrNull(remaining.p90Ms)
  if (p50 === null || p90 === null) return null

  const midpoint = requestStartedMs + Math.max(0, responseReceivedMs - requestStartedMs) / 2
  const serverNowMs = finiteOrNull(snapshot.serverNowMs)
  const rawOffset = serverNowMs === null ? 0 : serverNowMs - midpoint
  const clockOffsetMs = Math.max(-5 * 60 * 1000, Math.min(5 * 60 * 1000, rawOffset))
  const estimatedServerNow = responseReceivedMs + clockOffsetMs
  const calculatedAtMs = finiteOrNull(snapshot.calculatedAtMs) || estimatedServerNow
  const snapshotAgeMs = Math.max(0, estimatedServerNow - calculatedAtMs)
  const running = snapshot.state === 'RUNNING' || snapshot.state === 'QUEUED' || snapshot.state === 'RESUME_QUEUED'

  return {
    receivedAtMs: responseReceivedMs,
    p50Ms: running ? Math.max(0, p50 - snapshotAgeMs) : p50,
    p90Ms: running ? Math.max(0, p90 - snapshotAgeMs) : p90,
    running,
    state: String(snapshot.state || ''),
    displayMode: String(snapshot.displayMode || ''),
    confidence: String(snapshot.confidence || 'LOW'),
    validUntilMs: finiteOrNull(snapshot.validUntilMs),
    clockOffsetMs
  }
}

function readEta(anchor, nowMs) {
  if (!anchor) return null
  const elapsed = anchor.running ? Math.max(0, nowMs - anchor.receivedAtMs) : 0
  const estimatedServerNow = nowMs + (anchor.clockOffsetMs || 0)
  const stale = anchor.validUntilMs !== null && estimatedServerNow > anchor.validUntilMs
  return {
    p50Ms: Math.max(0, anchor.p50Ms - elapsed),
    p90Ms: Math.max(0, anchor.p90Ms - elapsed),
    state: stale ? 'STALE' : anchor.state,
    displayMode: stale ? 'STALE' : anchor.displayMode,
    confidence: anchor.confidence,
    stale
  }
}

module.exports = { createEtaAnchor, readEta }
