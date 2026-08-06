// services/hangingProgressCopy.js —— 挂画生成等待页顾问式进度文案
//
// worker 有 advisor_message 时直接透传；没有时用确定性兜底。
// QA / 渲染结果的判定仍在 GPU 服务端完成，这里只负责业务端展示和状态推进。

const STAGE_FALLBACK = {
  queued: '已收到委托，我正在为您的空间建立分析任务…',
  metric3d: '正在测量空间深度…',
  semantic: '正在识别墙面与结构信息…',
  hanging: '正在筛选安全挂画位置…',
  render: '几何分析完成，正在生成高保真效果图…',
  styling: '正在优化空间风格与色彩…',
  r2_upload: '正在上传效果图…',
  done: '效果图已完成，正在为您打开结果页…',
  failed: '效果图正在复核中，团队会继续为您确认最终效果…'
};

const STAGE_STATUS = {
  metric3d: 'hanging_geometry',
  semantic: 'hanging_geometry',
  hanging: 'hanging_geometry',
  render: 'hanging_rendering',
  styling: 'hanging_rendering',
  r2_upload: 'hanging_rendering',
  failed: 'hanging_render_review'
};

const STATUS_PROGRESS = {
  pending: {
    pct: 8,
    message: STAGE_FALLBACK.queued
  },
  content_reviewing: {
    pct: 18,
    message: '已收到图片，正在分析您的空间…'
  },
  audit_rejected: {
    pct: 100,
    message: '内容安全审核未通过'
  },
  audit_timeout: {
    pct: 100,
    message: '审核暂未完成'
  },
  hanging_queued: {
    pct: 10,
    message: STAGE_FALLBACK.queued
  },
  hanging_queued_offline: {
    pct: 10,
    message: '任务已经排队，我正在唤醒渲染服务，稍后会继续推进…'
  },
  hanging_geometry: {
    pct: 45,
    message: STAGE_FALLBACK.hanging
  },
  hanging_rendering: {
    pct: 78,
    message: STAGE_FALLBACK.render
  },
  hanging_render_review: {
    pct: 92,
    message: '效果图已经生成，正在做最后的交付复核…'
  },
  hanging_partial_review: {
    pct: 92,
    message: '效果图已经生成，正在做最后的交付复核…'
  },
  hanging_no_safe_wall: {
    pct: 92,
    message: '空间分析已完成，我正在整理需要人工确认的位置建议…'
  },
  hanging_failed: {
    pct: 92,
    message: '效果图正在复核中，团队会继续为您确认最终效果…'
  },
  failed: {
    pct: 92,
    message: '效果图正在复核中，团队会继续为您确认最终效果…'
  },
  delivered: {
    pct: 100,
    message: STAGE_FALLBACK.done
  }
};

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeProgressMessage(msg = {}) {
  const stage = cleanText(msg.stage) || 'queued';
  const stageState = cleanText(msg.stage_state || msg.state) || 'running';
  const pct = clampPct(msg.pct ?? msg.progress_pct ?? msg.progress);
  const advisorText = cleanText(msg.advisor_message || msg.advisorMessage);
  const text = cleanText(
    msg.message ||
    STAGE_FALLBACK[stage] ||
    (stageState === 'failed' ? STAGE_FALLBACK.failed : '') ||
    '正在继续处理您的空间方案…'
  );

  return {
    orderId: cleanText(msg.order_id || msg.orderId) || null,
    jobId: cleanText(msg.job_id || msg.jobId) || null,
    stage,
    stageState,
    pct,
    text,
    advisorText,
    orderStatus: STAGE_STATUS[stage] || null
  };
}

function buildOrderProgress(order = {}, clientStatus = '') {
  const rawStatus = cleanText(order.status);
  const statusPreset = STATUS_PROGRESS[rawStatus] || STATUS_PROGRESS[clientStatus] || STATUS_PROGRESS.pending;
  const dbPct = clampPct(order.ai_progress_pct);
  const currentStep = cleanText(order.ai_current_step) || statusPreset.message;
  const pct = clientStatus === 'delivered'
    ? 100
    : (dbPct !== null ? Math.max(statusPreset.pct || 0, dbPct) : statusPreset.pct);

  return {
    message: currentStep,
    text: currentStep,
    pct,
    advisorText: cleanText(order.ai_advisor_progress),
    rawStatus,
    hangingStatus: order.hanging_status || null,
    hangingJobId: order.hanging_job_id || null,
    exitCode: order.hanging_exit_code || null
  };
}

module.exports = {
  normalizeProgressMessage,
  buildOrderProgress,
  STAGE_FALLBACK,
  STATUS_PROGRESS,
  clampPct,
  cleanText
};
