// routes/hangingLlm.js —— 艺术装置顾问 LLM 流式接口（SSE）
// GET /api/hanging/llm-stream/:orderId?token=<delivery_token>&task=delivery_main|install_guide|waiting_progress

const express = require('express');
const router = express.Router();
const db = require('../database');
const { SYSTEM_PROMPT } = require('../services/hangingLlm');
const {
  ensureDefaultSlotConfigs, getSlotSequence, selectSlotConfigForRun, getOrderSlotOverride,
  buildSlotInput, buildSlotSystemPrompt, buildSlotFallbackText, renderPromptTemplate, renderUserPromptTemplate, extractPromptTemplatePaths, buildScopedSlotInput, recordRun
} = require('../services/llmSlots');

const LLM_API_BASE_URL = (process.env.LLM_API_BASE_URL || '').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}


function requireStrictAdmin(req, res) {
  const adminSecret = String(process.env.ADMIN_SECRET || '').trim();
  if (!adminSecret) {
    res.status(503).json({ error: 'ADMIN_SECRET 未配置，LLM 调试接口已关闭' });
    return false;
  }
  const secret = String(req.headers['x-admin-secret'] || req.query.secret || (req.body && req.body.secret) || '').trim();
  if (secret !== adminSecret) {
    res.status(403).json({ error: '无权限访问 LLM 调试接口' });
    return false;
  }
  return true;
}

async function callLlmOnce(systemPrompt, userPrompt, { maxTokens = 360, temperature = 0.65 } = {}) {
  if (!LLM_API_BASE_URL || !LLM_API_KEY) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const r = await fetch(`${LLM_API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        stream: false,
        max_tokens: maxTokens,
        temperature
      }),
      signal: controller.signal
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`LLM HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
    const json = await r.json();
    return String(json?.choices?.[0]?.message?.content || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function runSingleSlot({ order, task, slot, source = 'debug_manual', createdBy = 'admin', previousOutputs = [] }) {
  ensureDefaultSlotConfigs(db);
  const { config, gray } = selectSlotConfigForRun(db, task, slot, { orderId: order.id, source });
  const override = getOrderSlotOverride(db, order.id, task, slot);
  const availableInput = buildSlotInput(order, task, slot, config, { previousOutputs });
  const mode = override ? 'override' : (config.mode || availableInput.mode || 'llm_free');
  const rawSystemPrompt = override
    ? buildSlotSystemPrompt(slot, 'fixed_polish')
    : (config.system_prompt || buildSlotSystemPrompt(slot, mode));
  const rawUserPromptTemplate = override ? '' : String(config.user_prompt_template || availableInput.user_prompt_template || '').trim();
  const referencedPaths = extractPromptTemplatePaths(
    rawSystemPrompt,
    rawUserPromptTemplate,
    config.fixed_seed_text || '',
    availableInput.instructions || ''
  );
  const systemPrompt = renderPromptTemplate(rawSystemPrompt, availableInput);
  let input = buildScopedSlotInput(availableInput, referencedPaths);
  let userPrompt = JSON.stringify(input, null, 2);
  if (rawUserPromptTemplate) {
    const renderedUser = renderUserPromptTemplate(rawUserPromptTemplate, availableInput);
    if (renderedUser.userPrompt) userPrompt = renderedUser.userPrompt;
    if (renderedUser.inputObject) {
      input = {
        task: availableInput.task,
        slot: availableInput.slot,
        slot_label: availableInput.slot_label,
        slot_stage: availableInput.slot_stage,
        slot_layer: availableInput.slot_layer,
        slot_char_limit: availableInput.slot_char_limit,
        mode: availableInput.mode,
        selected_field_paths: referencedPaths,
        user_prompt_template_mode: renderedUser.isJsonTemplate ? 'json_template' : 'text_template',
        ...renderedUser.inputObject
      };
    }
  }
  const started = Date.now();
  let outputText = '';
  let errorText = '';
  let fixedSourceId = null;
  const maxTokens = Math.max(120, Math.min(700, Number(input.slot_char_limit || 220) * 3));
  const temperature = mode === 'fixed_polish' || mode === 'override' ? 0.35 : 0.65;
  try {
    if (override && String(override.override_text || '').trim()) {
      outputText = String(override.override_text || '').trim();
      fixedSourceId = override.id;
    } else if (LLM_API_BASE_URL && LLM_API_KEY) {
      outputText = await callLlmOnce(systemPrompt, userPrompt, { maxTokens, temperature });
    }
    if (!outputText) {
      outputText = buildSlotFallbackText(order, task, slot, config);
    }
  } catch (error) {
    errorText = error.message || String(error);
    outputText = buildSlotFallbackText(order, task, slot, config);
  }
  if (!fixedSourceId && mode === 'fixed_polish' && config.id) fixedSourceId = config.id;
  const runId = recordRun(db, {
    orderId: order.id,
    task,
    slot,
    source,
    inputFields: input,
    systemPrompt,
    userPrompt,
    model: LLM_API_BASE_URL && LLM_API_KEY ? LLM_MODEL : 'fallback',
    temperature,
    maxTokens,
    outputText,
    fixedSourceId,
    latencyMs: Date.now() - started,
    errorText,
    promptVersion: config.version_label,
    createdBy,
    mode,
    slotConfigId: config.id || null,
    grayRatio: gray.gray_ratio,
    grayBucket: gray.gray_bucket,
    grayApplied: gray.gray_applied
  });
  return {
    run_id: runId,
    output_text: outputText,
    input_fields: input,
    available_fields: availableInput,
    selected_field_paths: referencedPaths,
    system_prompt: systemPrompt,
    user_prompt: userPrompt,
    error_text: errorText || null,
    mode,
    slot_config_id: config.id || null,
    gray
  };
}


router.post('/debug/run-slot', async (req, res) => {
  if (!requireStrictAdmin(req, res)) return;
  const orderId = String(req.body.order_id || req.body.orderId || '').trim();
  const requestedTask = String(req.body.task || 'delivery_main').trim();
  const task = ['delivery_main', 'waiting_progress', 'install_guide'].includes(requestedTask) ? requestedTask : 'delivery_main';
  const slot = String(req.body.slot || '').trim().toUpperCase();
  if (!orderId || !slot) return res.status(400).json({ error: '缺少 order_id 或 slot' });
  if (!getSlotSequence(task).includes(slot)) return res.status(400).json({ error: `slot ${slot} 不属于 task ${task}` });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  try {
    const actor = String(req.headers['x-admin-actor'] || req.headers['x-admin-user'] || req.query.admin || 'admin').trim() || 'admin';
    const result = await runSingleSlot({ order, task, slot, source: 'debug_manual', createdBy: actor });
    res.json({ ok: true, order_id: orderId, task, slot, ...result });
  } catch (error) {
    console.error('[llm-debug:run-slot] failed:', error);
    res.status(500).json({ error: error.message || '槽位调试失败' });
  }
});

router.get('/llm-stream/:orderId', async (req, res) => {
  const orderId = req.params.orderId;
  const token = req.query.token || '';
  const allowedTasks = new Set(['delivery_main', 'install_guide', 'waiting_progress']);
  const requestedTask = String(req.query.task || 'delivery_main');
  const task = allowedTasks.has(requestedTask) ? requestedTask : 'delivery_main';

  console.log('[llm-stream:start]', JSON.stringify({
    order_id: orderId,
    task,
    has_token: Boolean(token),
    has_base_url: Boolean(LLM_API_BASE_URL),
    has_key: Boolean(LLM_API_KEY),
    model: LLM_MODEL
  }));

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND delivery_token = ?')
    .get(orderId, token);

  if (!order) {
    console.warn('[llm-stream:auth-fail]', JSON.stringify({
      order_id: orderId,
      task,
      has_token: Boolean(token)
    }));
    return res.status(404).end();
  }

  const candidates = (() => {
    try { return JSON.parse(order.hanging_candidate_records_json || '[]'); }
    catch (_) { return []; }
  })();

  function isWaitingProgressReady(order, candidates) {
    const pct = Number(order && order.ai_progress_pct);
    const rawStatus = String(order && order.status || '');
    const advisorText = String(order && order.ai_advisor_progress || '').trim();
    const readyStatuses = new Set([
      'hanging_rendering',
      'hanging_render_review',
      'hanging_partial_review',
      'delivered'
    ]);
    return Boolean(
      (Array.isArray(candidates) && candidates.length > 0) ||
      advisorText ||
      (Number.isFinite(pct) && pct >= 60) ||
      readyStatuses.has(rawStatus)
    );
  }

  function writeWaitAndEnd(res, reason = 'not_ready') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    sseWrite(res, { wait: true, reason, retryAfterMs: 8000 });
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const waitingReady = task !== 'waiting_progress' || isWaitingProgressReady(order, candidates);

  console.log('[llm-stream:order-loaded]', JSON.stringify({
    order_id: orderId,
    task,
    status: order.status,
    ai_engine: order.ai_engine,
    progress_pct: order.ai_progress_pct ?? null,
    advisor_len: String(order.ai_advisor_progress || '').length,
    candidate_count: candidates.length,
    waiting_ready: waitingReady,
    can_use_llm: Boolean(LLM_API_BASE_URL && LLM_API_KEY),
    has_narration_bundle: Boolean(order.hanging_narration_bundle_json)
  }));

  if (!waitingReady) {
    console.log('[llm-stream:waiting-deferred]', JSON.stringify({ order_id: orderId, task, status: order.status, progress_pct: order.ai_progress_pct ?? null }));
    return writeWaitAndEnd(res, 'waiting_progress_not_ready');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const slots = getSlotSequence(task);
  const previousOutputs = [];
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    try {
      const result = await runSingleSlot({
        order,
        task,
        slot,
        source: 'baseline_production',
        createdBy: 'system',
        previousOutputs
      });
      const text = `${result.output_text || ''}${index < slots.length - 1 ? '\n' : ''}`;
      if (result.output_text) previousOutputs.push({ slot, text: result.output_text });
      sseWrite(res, {
        text,
        slot,
        task,
        mode: result.mode,
        run_id: result.run_id,
        slot_config_id: result.slot_config_id,
        gray: result.gray
      });
    } catch (error) {
      console.warn('[llm-stream:slot-failed]', JSON.stringify({ order_id: orderId, task, slot, error: error.message || String(error) }));
      const fallback = buildSlotFallbackText(order, task, slot);
      sseWrite(res, { text: `${fallback}${index < slots.length - 1 ? '\n' : ''}`, slot, task, mode: 'fallback', error: true });
    }
  }

  // 统一单条结束帧；前端检查 e.data === '[DONE]'
  res.write('data: [DONE]\n\n');
  res.end();
});

module.exports = router;
