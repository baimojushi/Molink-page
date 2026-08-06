function normalizeThinkingPayload(payload, previousCandidates, selectedWallIds, options) {
  const thinking = (payload && (payload.thinking || payload)) || {}
  const candidates = Array.isArray(thinking.candidates) ? thinking.candidates : []
  const selected = Array.isArray(selectedWallIds) ? selectedWallIds : []
  const previous = Array.isArray(previousCandidates) ? previousCandidates : []
  const maxSelect = Number(thinking.max_select || 2)
  const delivered = Boolean(options && options.delivered)
  const hasUserSelection = Boolean(thinking.has_user_selection)
  return {
    ready: Boolean(payload && payload.ready !== false && candidates.length),
    guideCopy: thinking.guide_copy || '',
    primaryWallId: thinking.primary_wall_id || '',
    currentEffectWallId: thinking.current_effect_wall_id || '',
    hasPendingSupplement: Boolean(thinking.has_pending_supplement),
    maxSelect,
    candidates: candidates.map(item => {
      const box = (item.schematic && item.schematic.artworkBox) || {}
      const wallId = String(item.wall_id || '')
      const prior = previous.find(candidate => candidate.wall_id === wallId)
      const currentEffect = Boolean(item.current_effect)
      const selectedByUser = item.selected_by_user === true
      const supplementStatus = String(item.supplement_status || 'idle')
      const locallySelected = selected.indexOf(wallId) >= 0
      const isSelected = locallySelected
      const tone = Array.isArray(item.suggested_wall_tone_rgb) ? item.suggested_wall_tone_rgb.slice(0, 3) : []
      const safeTone = tone.length === 3 && tone.every(value => Number.isFinite(Number(value)))
        ? tone.map(value => Math.max(0, Math.min(255, Math.round(Number(value)))))
        : [58, 62, 71]
      let statusLabel = ''
      if (currentEffect && delivered && !hasUserSelection) statusLabel = '当前效果'
      else if (supplementStatus === 'pending') statusLabel = '生成中'
      else if (supplementStatus === 'succeeded') statusLabel = '已追加'
      else if (supplementStatus === 'failed') statusLabel = '未完成'
      else if (selectedByUser) statusLabel = '已选择'
      return Object.assign({}, item, {
        wall_id: wallId,
        current_effect: currentEffect,
        selected_by_user: selectedByUser,
        supplement_status: supplementStatus,
        status_label: statusLabel,
        is_selected: isSelected,
        is_disabled: currentEffect || supplementStatus === 'pending' || supplementStatus === 'succeeded' || (!isSelected && selected.length >= maxSelect),
        wallpaper_opt_in_preview: prior ? !!prior.wallpaper_opt_in_preview : !!(item.wallpaper_opt_in && item.suggest_dark_wallpaper),
        wallpaperToneStyle: `background:rgb(${safeTone.join(',')});`,
        artworkStyle: `left:${box.leftPct || 35}%;top:${box.topPct || 34}%;width:${box.widthPct || 30}%;height:${box.heightPct || 24}%;`
      })
    }),
    notRecommended: Array.isArray(thinking.not_recommended) ? thinking.not_recommended : []
  }
}

function refreshCandidateStates(candidates, selectedWallIds, maxSelect) {
  const selected = Array.isArray(selectedWallIds) ? selectedWallIds : []
  return (candidates || []).map(item => {
    const locallySelected = selected.indexOf(item.wall_id) >= 0
    const locked = item.current_effect || item.supplement_status === 'pending' || item.supplement_status === 'succeeded'
    return Object.assign({}, item, {
      is_selected: locallySelected,
      is_disabled: locked || (!locallySelected && !item.selected_by_user && selected.length >= Number(maxSelect || 2))
    })
  })
}

module.exports = { normalizeThinkingPayload, refreshCandidateStates }
