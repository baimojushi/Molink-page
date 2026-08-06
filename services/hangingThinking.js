// services/hangingThinking.js —— 等待页候选墙思考过程与用户偏好数据
//
// 本文件只负责候选打分展示、偏好向量沉淀和补渲染 job 构建；
// LoRA/排序模型训练接口暂不在这里接入，等偏好数据稳定后再开放导出与训练流水线。

const crypto = require('crypto');
const { safeParse, cleanUserLabel } = require('./hangingLlm');
const { normalizeRenderProvider } = require('./hangingJob');

function newId(prefix = 'pref') {
  const raw = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return `${prefix}_${String(raw).replace(/-/g, '').slice(0, 24)}`;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeRgb(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const rgb = value.slice(0, 3).map(channel => Math.max(0, Math.min(255, Math.round(Number(channel)))));
  return rgb.every(Number.isFinite) ? rgb : null;
}

function featureVectorFromCandidate(c = {}) {
  const install = c.install || {};
  const comp = c.composition_context || {};
  const clearance = c.structural_clearance || {};
  return {
    wall_id: c.wall_id || '',
    rank: c.rank ?? null,
    score: c.score ?? null,
    risk_level: c.risk_level || '',
    axis_centering: comp.axis_centering ?? null,
    center_height_cm: install.center_height_cm ?? null,
    bottom_edge_cm: install.bottom_edge_cm ?? null,
    top_edge_cm: install.top_edge_cm ?? null,
    above_furniture_label_zh: comp.above_furniture_label_zh || '',
    artwork_wall_area_ratio: comp.artwork_wall_area_ratio ?? null,
    bottom_gap_to_furniture_cm: comp.bottom_gap_to_furniture_cm ?? null,
    light_penalty_band: c.light_penalty_band || '',
    light_components: c.light_components || null,
    structural_clearance: (clearance.elements || []).map(item => ({
      label_zh: item.label_zh || '',
      edge_clearance_cm: item.edge_clearance_cm ?? null
    }))
  };
}

function buildElevationSchematic(c = {}) {
  const install = c.install || {};
  const comp = c.composition_context || {};
  const bottom = clamp(install.bottom_edge_cm ?? comp.bottom_edge_cm, 30, 220, 90);
  const top = clamp(install.top_edge_cm ?? comp.top_edge_cm, 60, 260, 150);
  const height = Math.max(24, top - bottom);
  const centerY = 240 - clamp((bottom + height / 2), 40, 240, 130) * 0.75;
  const boxHeight = clamp(height * 0.75, 34, 108, 64);
  const axis = String(comp.axis_centering || '').toLowerCase();
  const x = /左|left/.test(axis) ? 52 : (/右|right/.test(axis) ? 156 : 104);
  return {
    wallLabel: cleanUserLabel(c.wall_position_zh, cleanUserLabel(comp.above_furniture_label_zh, '候选墙面')),
    artworkBox: {
      leftPct: Math.round((x / 240) * 100),
      topPct: Math.round((centerY / 260) * 100),
      widthPct: 30,
      heightPct: Math.round((boxHeight / 260) * 100)
    },
    supportLabel: comp.above_furniture_label_zh || '',
    bottomEdgeCm: install.bottom_edge_cm ?? null,
    topEdgeCm: install.top_edge_cm ?? null,
    centerHeightCm: install.center_height_cm ?? null
  };
}

function buildThinking(order) {
  const candidates = safeParse(order.hanging_candidate_records_json, []);
  const notRecommended = safeParse(order.hanging_not_recommended_json, []);
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const top = candidates.slice(0, 4);
  const primaryWallId = top[0] && top[0].wall_id ? String(top[0].wall_id) : null;
  return {
    stage: order.hanging_status || order.status || 'hanging',
    primary_wall_id: primaryWallId,
    max_select: 2,
    artifact_ready: Boolean(order.hanging_result_zip_url),
    guide_copy: '同一幅作品，放在不同的墙上，会牵出你对这个空间不一样的期待。如果有一两处让你心里先动了一下，不妨留住它——你更想每天在哪一面墙前，和它相处。',
    candidates: top.map((c, i) => {
      const install = c.install || {};
      const suggestDarkWallpaper = !!install.suggest_dark_wallpaper;
      const suggestedTone = suggestDarkWallpaper ? normalizeRgb(install.suggested_wall_tone_rgb) : null;
      return {
        wall_id: c.wall_id || `wall_${i + 1}`,
        candidate_id: c.candidate_id || c.asset_id || '',
        rank: i + 1,
        is_primary: i === 0,
        score: c.score ?? null,
        score_label: c.score != null ? `${Math.round(Number(c.score) * 100) / 100}` : '',
        risk_level: c.risk_level || '',
        reason: c.composition_zh || (c.reason_tags || []).slice(0, 2).join('、') || '综合比例、留白与安全间距后进入候选。',
        suggest_dark_wallpaper: suggestDarkWallpaper,
        suggested_wall_tone_rgb: suggestedTone,
        wallpaper_copy: suggestDarkWallpaper ? '这面墙偏浅，作品色调偏深，试试为它换一面深色墙？' : '',
        feature_vector: featureVectorFromCandidate({ ...c, rank: i + 1 }),
        schematic: buildElevationSchematic(c)
      };
    }),
    not_recommended: (notRecommended || []).slice(0, 4).map(nr => ({
      wall_id: nr.wall_id || '',
      wall_zh: nr.wall_position_zh || nr.wall_id || '某面墙',
      primary_reason: (nr.reasons || [])[0] || nr.reason || '当前比例或间距不够从容'
    }))
  };
}

function resolveUserSupplementRenders(selectedWallIds, primaryWallId, wallpaperOptIn = {}) {
  const primary = String(primaryWallId || '');
  return (selectedWallIds || [])
    .map(id => String(id || '').trim())
    .filter(Boolean)
    .filter((id, index, arr) => arr.indexOf(id) === index)
    .filter(id => id !== primary || wallpaperOptIn[id] === true)
    .slice(0, 2);
}

function validateWallpaperOptIn(requestedOptIn, selectedWallIds, candidates) {
  const selected = Array.isArray(selectedWallIds) ? selectedWallIds.map(String) : [];
  const validByWall = new Map((candidates || []).map(candidate => [String(candidate.wall_id || ''), candidate]));
  const wallpaperOptIn = {};
  const wallpaperToneByWall = {};
  for (const [rawWallId, wantsOptIn] of Object.entries(requestedOptIn || {})) {
    if (!wantsOptIn) continue;
    const wallId = String(rawWallId || '').trim();
    const candidate = validByWall.get(wallId);
    let message = '';
    let statusCode = 400;
    if (!candidate) message = `未知墙面 ${wallId}`;
    else if (!selected.includes(wallId)) message = `墙面 ${wallId} 未在本次选中列表内`;
    else if (!candidate.suggest_dark_wallpaper) message = `墙面 ${wallId} 不满足深色墙纸建议条件`;
    const tone = candidate ? normalizeRgb(candidate.suggested_wall_tone_rgb) : null;
    if (!message && !tone) {
      message = '候选墙缺少有效的建议墙色';
      statusCode = 409;
    }
    if (message) {
      const error = new Error(message);
      error.statusCode = statusCode;
      error.wallId = wallId;
      throw error;
    }
    wallpaperOptIn[wallId] = true;
    wallpaperToneByWall[wallId] = tone;
  }
  selected.forEach(wallId => {
    if (wallpaperOptIn[wallId] !== true) wallpaperOptIn[wallId] = false;
  });
  return { wallpaperOptIn, wallpaperToneByWall };
}

function buildSupplementRenderJobsFromOrder(order, selectedWallIds, wallpaperOptIn = {}) {
  if (!order || !order.id || !order.hanging_result_zip_url) return [];
  const primaryWallId = String(order.primary_wall_id || '');
  const wallIds = resolveUserSupplementRenders(selectedWallIds, primaryWallId, wallpaperOptIn);
  if (wallIds.length === 0) return [];
  const candidates = safeParse(order.hanging_candidate_records_json, []);
  const provider = normalizeRenderProvider(order.hanging_provider || process.env.HANGING_RENDER_PROVIDER);
  const jobs = [];
  for (const wallId of wallIds) {
    const candidate = candidates.find(item => String(item.wall_id || '') === wallId);
    if (!candidate) return [];
    const candidateId = String(candidate.candidate_id || candidate.asset_id || '').trim();
    if (!candidateId) return [];

    const isPrimary = wallId === primaryWallId;
    const optIn = wallpaperOptIn[wallId] === true;
    const install = candidate.install && typeof candidate.install === 'object' ? candidate.install : {};
    const suggestDark = candidate.suggest_dark_wallpaper === true || install.suggest_dark_wallpaper === true;
    const suggestedTone = normalizeRgb(candidate.suggested_wall_tone_rgb || install.suggested_wall_tone_rgb);
    if (optIn && (!suggestDark || !suggestedTone)) return [];
    const wallpaperRecolor = optIn
      ? { enabled: true, tone_rgb: suggestedTone }
      : null;
    if (isPrimary && !candidate.pre_styling_image_url) return [];

    const jobId = `supp_${order.id}_${wallId}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const job = {
      job_id: jobId,
      order_id: order.id,
      job_kind: 'hanging_supplement_render',
      pipeline_version: 'hanging-supplement-v1',
      eta_features: {
        service_type: order.service_type || '',
        candidate_limit: 1,
        render_provider: provider,
        styling_requested: order.service_type !== 'recommend_space' && !!order.extra_service,
        soft_furnishing_requested: order.service_type !== 'recommend_space' && !!order.extra_service,
        wallpaper_requested: !!wallpaperRecolor,
        room_pixel_bucket: 'unknown'
      },
      supplement: true,
      source_job_id: order.hanging_job_id || '',
      hanging_result_zip_url: order.hanging_result_zip_url,
      target_wall_ids: [wallId],
      target_candidate_ids: [candidateId],
      soft_furnishing_requested: order.service_type !== 'recommend_space' && !!order.extra_service,
      wallpaper_recolor: wallpaperRecolor,
      wallpaper_recolor_requested: !!wallpaperRecolor,
      primary_wall_rerender: isPrimary,
      primary_wall_id: primaryWallId || null,
      stage_a_base_source: isPrimary ? 'pre_styling_image_url' : 'hanging_stage_a_render',
      render_provider: provider,
      hanging_provider: provider,
      render: {
        provider,
        render_provider: provider,
        global_limit: 1,
        per_wall_limit: 1,
        target_wall_ids: [wallId],
        target_candidate_ids: [candidateId]
      },
      r2_output_prefix: `orders/${order.id}/${jobId}`
    };
    if (isPrimary) job.pre_styling_image_url = candidate.pre_styling_image_url;
    jobs.push(job);
  }
  return jobs;
}

module.exports = {
  newId,
  buildThinking,
  featureVectorFromCandidate,
  resolveUserSupplementRenders,
  validateWallpaperOptIn,
  buildSupplementRenderJobsFromOrder
};
