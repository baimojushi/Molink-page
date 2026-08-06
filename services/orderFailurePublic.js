'use strict';

function clean(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeJsonObject(value) {
  if (!value) return null;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

const PROGRAM_COPY = Object.freeze({
  category: 'program',
  source: 'system',
  title: '本次处理暂未完成',
  reason: '系统在处理过程中遇到异常，未能自动完成本次呈现。',
  suggestion: '问题已经记录，我们将在今日内进行人工处理。完成后会通过消息通知您，您也可以在历史记录中查看结果。',
  suggestions: [
    '无需重复提交，我们会继续处理本次委托。',
    '完成后会通过消息通知您，也可在历史记录中查看结果。'
  ],
  history_available: true,
  manual_handling_today: true
});

const SERVICE_COPY = Object.freeze({
  content_review: {
    category: 'service', source: 'content_review',
    title: '这张图片暂时无法继续处理',
    reason: '图片未通过内容与使用范围确认。',
    suggestion: '请更换为内容清晰、符合平台要求的空间照片或作品图片后重新提交。',
    suggestions: ['更换图片后重新提交。', '确保图片内容完整、清晰且符合平台要求。']
  },
  no_safe_wall: {
    category: 'service', source: 'safe_area',
    title: '暂未找到安全的挂画位置',
    reason: '当前照片中的可用墙面、留白或安全间距不足，系统没有交付可能误导您的结果。',
    suggestion: '建议尝试尺寸更小的作品、换一面墙，或重新拍摄包含更多完整墙面的照片。',
    suggestions: ['尝试尺寸更小的作品或其他墙面。', '重新拍摄更完整的墙面，并减少家具、门窗和窗帘遮挡。']
  },
  structural_clearance: {
    category: 'service', source: 'structural_clearance',
    title: '墙面安全间距不足',
    reason: '候选位置与门窗、窗帘、家具或墙面边界的距离不足。',
    suggestion: '建议选择更小尺寸的作品、调整墙面选择，或补拍更宽的空间照片。',
    suggestions: ['选择更小尺寸的作品。', '换一面留白更充足的墙，或补拍更宽的空间照片。']
  },
  geometry: {
    category: 'service', source: 'geometry',
    title: '空间几何信息不够可靠',
    reason: '照片中的透视、深度或墙面结构证据不足，无法安全确定挂画位置。',
    suggestion: '请从更正面的角度重拍，保持镜头水平，避免超广角、强反光和严重遮挡。',
    suggestions: ['尽量正对墙面拍摄，并保持镜头水平。', '避免超广角、强反光、窗帘遮挡和画面边缘裁切。']
  },
  artwork_dimensions: {
    category: 'service', source: 'artwork_dimensions',
    title: '缺少作品尺寸信息',
    reason: '系统无法确认作品的实际宽高，因此不能给出可靠的挂画比例和高度。',
    suggestion: '请补充作品实际宽度和高度后重新提交。',
    suggestions: ['补充作品的实际宽度和高度。', '尺寸请包含画框外沿。']
  },
  artwork_image: {
    category: 'service', source: 'artwork_image',
    title: '作品图片不适合生成',
    reason: '作品图片的清晰度、角度、反光或边缘完整度不足。',
    suggestion: '请上传清晰、正面、无明显反光且四边完整的作品图片。',
    suggestions: ['正对作品拍摄，保证四边完整。', '减少反光、模糊和透视变形。']
  },
  room_image: {
    category: 'service', source: 'room_image',
    title: '空间照片不适合分析',
    reason: '当前照片未能提供足够完整、清晰的墙面与空间结构。',
    suggestion: '请重新拍摄完整墙面，保持光线充足、镜头水平，并尽量减少遮挡。',
    suggestions: ['完整拍到墙面上下左右边界。', '保持镜头水平、光线充足，并减少遮挡。']
  },
  render_quality: {
    category: 'service', source: 'render_quality',
    title: '效果图未达到交付标准',
    reason: '系统完成了方案计算，但生成结果的光影、作品一致性或空间可信度未达到交付要求。',
    suggestion: '我们没有交付不可靠的图片。建议更换照片后重试；本次结果也会保留供团队复核。',
    suggestions: ['可更换更清晰、视角更正的空间照片后重试。', '本次未达标结果会保留供团队复核。']
  }
});

function contextType(context) {
  const raw = clean(context && (context.public_type || context.type || context.category || context.source), 80).toLowerCase();
  if (!raw) return '';
  if (/program|system|worker|provider|transport|storage|upload|timeout|internal/.test(raw)) return 'program';
  if (/content/.test(raw)) return 'content_review';
  if (/clearance|curtain|window|door|furniture/.test(raw)) return 'structural_clearance';
  if (/safe|wall/.test(raw) && /no|reject|unavailable/.test(raw)) return 'no_safe_wall';
  if (/geometry|depth|perspective|normal|plane|metric|semantic/.test(raw)) return 'geometry';
  if (/dimension|size/.test(raw)) return 'artwork_dimensions';
  if (/artwork.*image|art_image/.test(raw)) return 'artwork_image';
  if (/room.*image|space.*image/.test(raw)) return 'room_image';
  if (/render|quality|qa/.test(raw)) return 'render_quality';
  return '';
}

function classifyByCode(order) {
  const status = clean(order && order.status, 100).toLowerCase();
  const hangingStatus = clean(order && order.hanging_status, 100).toLowerCase();
  const code = clean(order && order.hanging_exit_code, 180).toUpperCase();
  const joined = `${status} ${hangingStatus} ${code}`;

  if (status === 'audit_rejected' || status === 'audit_timeout') return 'content_review';
  if (/HANGING_NO_SAFE_WALL|NO_SAFE_WALL|ALL_REJECTED/.test(joined)) return 'no_safe_wall';
  if (/CLEARANCE|CURTAIN|WINDOW|DOOR|FURNITURE|STRUCTURAL/.test(code)) return 'structural_clearance';
  if (/MISSING_ARTWORK_DIMENSIONS|ARTWORK_SIZE|DIMENSION/.test(code)) return 'artwork_dimensions';
  if (/ARTWORK_IMAGE|ART_IMAGE|FRAME_VLM|INPUT_ARTWORK/.test(code)) return 'artwork_image';
  if (/ROOM_IMAGE|SPACE_IMAGE|INPUT_ROOM|NO_WALL/.test(code) && !/NO_SAFE_WALL/.test(code)) return 'room_image';
  if (/GEOMETRY|METRIC|DEPTH|NORMAL|PLANE|PERSPECTIVE|SEMANTIC|PROJECTION/.test(code)) return 'geometry';
  if (/HANGING_RENDER_REVIEW|HANGING_PARTIAL_REVIEW|PARTIAL_NO_FLUX|PARTIAL_HARDPASTE|RENDER_REVIEW|QA/.test(joined)) return 'render_quality';
  if (/HANGING_FAILED|FAILED_WORKER|FAILED_SUPPLEMENT|PROVIDER|R2|UPLOAD|WEBSOCKET|TRANSPORT|TIMEOUT|EXCEPTION|INTERNAL/.test(joined)) return 'program';
  return status === 'failed' || hangingStatus === 'failed' ? 'program' : '';
}

function firstServiceReason(order) {
  const rows = safeJsonArray(order && order.hanging_not_recommended_json);
  for (const row of rows) {
    const reasons = Array.isArray(row && row.reasons) ? row.reasons : [];
    const candidate = clean(reasons[0] || (row && (row.reason || row.primary_reason)), 120);
    if (candidate && !/failed|exception|traceback|http|provider|api/i.test(candidate)) return candidate;
  }
  return '';
}

function buildPublicOrderFailure(order = {}) {
  const status = clean(order.status, 100).toLowerCase();
  const hangingStatus = clean(order.hanging_status, 100).toLowerCase();
  const isFailureState = [
    'failed', 'hanging_failed', 'hanging_no_safe_wall', 'hanging_render_review',
    'hanging_partial_review', 'audit_rejected', 'audit_timeout'
  ].includes(status) || ['failed', 'no_safe_wall', 'render_review'].includes(hangingStatus);
  if (!isFailureState) return null;

  const context = safeJsonObject(order.hanging_failure_context_json || order.failure_context);
  const classified = contextType(context) || classifyByCode(order) || 'program';
  if (classified === 'program') {
    return Object.assign({}, PROGRAM_COPY, {
      kind: 'program',
      reason_code: clean((context && context.reason_code) || order.hanging_exit_code || 'SYSTEM_PROCESSING_FAILURE', 100),
      terminal: true
    });
  }

  const base = SERVICE_COPY[classified] || SERVICE_COPY.render_quality;
  const contextReason = clean(context && (context.public_reason || context.reason), 160);
  const contextSuggestion = clean(context && (context.public_suggestion || context.suggestion), 220);
  const auditReason = classified === 'content_review'
    ? clean(order.content_review_reject_reason || order.ai_current_step, 160)
    : '';
  const safeReason = auditReason || contextReason || (['no_safe_wall', 'structural_clearance'].includes(classified) ? firstServiceReason(order) : '');
  return Object.assign({}, base, {
    kind: 'service',
    reason: safeReason || base.reason,
    suggestion: contextSuggestion || base.suggestion,
    reason_code: clean((context && context.reason_code) || order.hanging_exit_code || classified.toUpperCase(), 100),
    history_available: true,
    manual_handling_today: false,
    terminal: true
  });
}

module.exports = {
  buildPublicOrderFailure,
  classifyByCode,
  contextType,
  PROGRAM_COPY,
  SERVICE_COPY
};
