// services/hangingLlm.js —— 艺术装置顾问 LLM 输入构建与兜底
//
// LLM 职责：把已翻译为中文的结构化几何摘要转写为自然语言，不做判断或计算。
// 原始像素坐标、quad_px、法线向量、工程枚举不进入 LLM。

const SYSTEM_PROMPT = `你是 Mo:link 的艺术空间装置顾问。Mo:link 专注于将中国传统与当代艺术作品融入私人居住空间。
你的职责是把已经确定的空间事实、候选方案与因果解释线索转写为自然中文，不做额外判断或计算。

语气风格：
- 专业而温暖，如同相识已久的美学顾问；
- 使用具体数字时以「约」开头，避免过度精确感；
- 揭示空间关系并翻译成感官体验，止于观察，不用「好/不好/适合」收尾；
- 不提「算法」「几何」「像素」「深度模型」「SSIM」「mask」「Flux2」等技术词语；
- 不使用「此外」「首先」「其次」等格式化过渡词；
- 不使用 Markdown 格式、列表或标题；
- 不编造没有出现在输入中的家具、光线、方位、距离或颜色。

输出要求：
- 使用简体中文，句式流畅自然；
- 严格控制在 task 指定字数内；
- 每个 task 只输出正文，无开场白、无署名；
- height_finalized=false 时必须提示现场卷尺确认最终钉点；
- final_url_count=0 且 partial_review_count>0 时表述为「正在复核效果图」，禁止说系统失败或重新拍摄；
- task=waiting_progress 是等待页过程文案：候选未形成时只描述正在分析/正在确认的动作；已有 bundle、候选摘要或进展时，可以基于已给字段做两到三句深入但克制的过程解读。`;

function buildBundleLlmInput(order, task = 'delivery_main', charLimit = 220) {
  const bundle = safeParse(order.hanging_narration_bundle_json, null);
  if (!bundle || typeof bundle !== 'object') return null;
  const facts = (bundle.facts && typeof bundle.facts === 'object') ? bundle.facts : {};
  const requestedTask = task === 'install_guide' ? task : (bundle.task || task);
  const input = {
    task: requestedTask,
    char_limit: Number(bundle.char_limit) || charLimit,
    source: 'causal_narration_bundle',
    state: bundle.state || '',
    progress_pct: bundle.pct ?? null,
    facts,
    copy_hints: Array.isArray(bundle.copy_hints) ? bundle.copy_hints : [],
    fired: Array.isArray(bundle.fired) ? bundle.fired : [],
    constraints: Array.isArray(bundle.constraints) ? bundle.constraints : [],
    artwork: {
      name: order.artwork_name || (facts.artwork && facts.artwork.name) || '您的作品',
      author: order.artwork_author || (facts.artwork && facts.artwork.author) || '',
      size: order.artwork_size || ''
    }
  };
  const bundleLight = facts.light_analysis || facts.light_components || facts.light_facts || facts.light_semantics || null;
  if (bundleLight) {
    input.light_analysis = bundleLight;
    input.light_components = bundleLight;
  }
  if (facts.invitation && facts.invitation.visual_complexity !== undefined) {
    input.artwork.visual_complexity = facts.invitation.visual_complexity;
  }
  return input;
}

function safeParse(json, fallback) {
  if (!json) return fallback;
  if (typeof json === 'object') return json;
  try { return JSON.parse(json); } catch (e) { return fallback; }
}

function cleanUserLabel(value, fallback = '') {
  const s = String(value || '').trim();
  if (!s) return fallback;
  if (/未知|unknown|null|undefined/i.test(s)) return fallback;
  return s;
}

// 由订单的细化候选记录构建 LLM 结构化输入（见方案 §8.4）
function buildLlmInput(order, task = 'delivery_main', charLimit = 220) {
  const candidates = safeParse(order.hanging_candidate_records_json, []);
  const notRecommended = safeParse(order.hanging_not_recommended_json, []);
  const best = candidates[0] || null;

  const artwork = {
    name: order.artwork_name || '您的作品',
    author: order.artwork_author || '',
    size: order.artwork_size || ''
  };

  if (!best) {
    if (task === 'waiting_progress') {
      return {
        task: 'waiting_progress',
        char_limit: charLimit,
        artwork,
        stage_text: order.ai_current_step || '正在分析空间与作品比例',
        advisor_progress: order.ai_advisor_progress || '',
        progress_pct: order.ai_progress_pct ?? null,
        constraints: [
          '候选方案尚未生成时只描述过程，不做安全结论',
          '不得说没有安全墙面，不得建议暂缓悬挂',
          '不得编造家具、方位、门窗、距离或光线事实'
        ]
      };
    }
    return {
      task: 'no_safe_wall',
      char_limit: charLimit,
      artwork,
      not_recommended: (notRecommended || []).map(nr => ({
        wall_zh: nr.wall_position_zh || nr.wall_id || '某面墙',
        reason: (nr.reasons || []).join('；') || '结构间距不足',
        retry_hint: nr.can_retry_hint || ''
      }))
    };
  }

  const install = best.install || {};
  const comp = best.composition_context || {};
  const cleanup = best.cleanup_info || {};
  const clearance = best.structural_clearance || {};
  const clearanceNote = (clearance.elements || [])
    .filter(e => e && e.label_zh)
    .map(e => `距${e.label_zh}约${e.edge_clearance_cm}厘米`)
    .join('，');

  return {
    task,
    char_limit: charLimit,
    artwork,
    best_plan: {
      wall_position_zh: cleanUserLabel(best.wall_position_zh, cleanUserLabel(comp.above_furniture_label_zh, '主墙面')),
      center_height_cm: install.center_height_cm || null,
      height_finalized: !!install.height_finalized,
      height_rule_label: install.height_rule_label || comp.height_rule_label || '',
      risk_level: best.risk_level || 'low',
      reason_tags: best.reason_tags || [],
      composition_zh: [
        comp.above_furniture_label_zh,
        comp.axis_centering ? `${comp.axis_centering}悬挂` : '',
        comp.bottom_gap_to_furniture_cm ? `画框下沿距支撑面约${comp.bottom_gap_to_furniture_cm}厘米` : ''
      ].filter(Boolean).join('，'),
      cleanup_required: !!cleanup.any_cleanup_required,
      cleanup_note: cleanup.any_cleanup_required ? (cleanup.cleanup_scope_label || '') : null,
      clearance_note: clearanceNote || null,
      bottom_edge_cm: install.bottom_edge_cm ?? comp.bottom_edge_cm ?? null,
      top_edge_cm: install.top_edge_cm ?? comp.top_edge_cm ?? null,
      nail_height_cm: install.nail_height_cm ?? null
    },
    alternatives_count: Math.max(0, candidates.length - 1),
    not_recommended: (notRecommended || []).map(nr => ({
      wall_zh: nr.wall_position_zh || nr.wall_id || '某面墙',
      reason: (nr.reasons || []).join('；') || '结构间距不足',
      retry_hint: nr.can_retry_hint || ''
    })),
    soft_risk: (best.soft_risk_info && best.soft_risk_info.has_soft_risk)
      ? best.soft_risk_info.soft_risk_reasons_zh
      : null,
    light_analysis: best.light_components || best.light_facts || best.light_semantics || null,
    light_penalty_band: best.light_penalty_band || null,
    light_risk_band: best.light_risk_band || null
  };
}

// LLM 不可用时的静态兜底（核心交付不依赖 LLM）
function buildFallbackText(order, task = 'delivery_main') {
  const candidates = safeParse(order.hanging_candidate_records_json, []);
  const best = candidates[0];
  if (!best) {
    if (task === 'waiting_progress') {
      const advisor = cleanUserLabel(order.ai_advisor_progress, '');
      if (advisor) return `${advisor} 我会继续核对画面融合、边缘关系和最终交付效果。`;
      return '我正在确认墙面留白、作品比例和安全间距，先为您锁定适合进入效果图渲染的候选位置。';
    }
    return '经过对您空间的全面分析，这一尺幅的作品暂时难以找到既安全又结构稳固的悬挂位置。建议重新拍摄一张更正面、能完整呈现主墙的照片，或选择宽度更小的作品，我们将重新为您分析。';
  }
  const install = best.install || {};
  const h = install.center_height_cm;
  const tags = (best.reason_tags || []).slice(0, 2).join('、');
  const wall = cleanUserLabel(best.wall_position_zh, '主墙面');
  let text = `推荐挂于${wall}，`;
  if (h) text += `画心离地约${h}厘米，`;
  if (tags) text += `该位置${tags}。`;
  if (candidates.length > 1) text += `另有${candidates.length - 1}个备选方案可供参考。`;
  return text;
}

module.exports = { SYSTEM_PROMPT, buildLlmInput, buildBundleLlmInput, buildFallbackText, safeParse, cleanUserLabel };
