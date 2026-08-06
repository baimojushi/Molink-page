// services/llmSlots.js —— LLM 槽位配置、输入构建、留痕与轻量 lint
//
// 这里先只沉淀稳定的数据资产与调试能力，不接本地 LoRA 训练/部署接口。
// 等 llm_debug_runs / llm_preferences / user_wall_preferences 的数据稳定后，再从这些表导出训练集。

const crypto = require('crypto');
const { SYSTEM_PROMPT, buildLlmInput, buildBundleLlmInput, buildFallbackText, safeParse, cleanUserLabel } = require('./hangingLlm');

function newId(prefix = 'llm') {
  const raw = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return `${prefix}_${String(raw).replace(/-/g, '').slice(0, 24)}`;
}

function clampGrayRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function stableGrayBucket(parts = []) {
  const raw = parts.map(v => String(v ?? '')).join(':');
  const hex = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return parseInt(hex, 16) / 0xffffffffffff;
}

function fallbackSlotConfig(task, slot) {
  const def = SLOT_MAP.get(slot) || { mode: 'llm_free', fixed_seed_text: '' };
  return {
    id: null,
    task,
    slot,
    mode: def.mode || 'llm_free',
    fixed_seed_text: def.fixed_seed_text || '',
    system_prompt: buildSlotSystemPrompt(slot, def.mode || 'llm_free'),
    user_prompt_template: buildDefaultUserPromptTemplate(task, slot),
    gray_ratio: 1,
    version_label: DEFAULT_PROMPT_VERSION,
    created_by: 'system',
    created_at: ''
  };
}

const SLOT_DEFINITIONS = [
  { slot: 'S0', name: '开场', stage: 'opening', layer: '', mode: 'fixed_polish', char_limit: 90, fixed_seed_text: '我会把这幅作品放回您的真实空间里看，而不是只给出一个机械答案。' },
  { slot: 'S1', name: '空间测量', stage: 'MEASURING', layer: 'L1', mode: 'llm_free', char_limit: 90 },
  { slot: 'S2', name: '空间识别', stage: 'UNDERSTANDING', layer: 'L1', mode: 'llm_free', char_limit: 110 },
  { slot: 'S3', name: '位置评估', stage: 'EVALUATING', layer: 'L2', mode: 'llm_free', char_limit: 130 },
  { slot: 'S4', name: '安全间距', stage: 'EVALUATING', layer: 'L2', mode: 'llm_free', char_limit: 120 },
  { slot: 'S5', name: '光线预测', stage: 'RENDERING', layer: 'L3', mode: 'llm_free', char_limit: 120 },
  { slot: 'S6', name: '落选说明', stage: 'EVALUATING', layer: 'L2', mode: 'fixed_polish', char_limit: 110, fixed_seed_text: '没有进入首选的墙面，并不是被简单否定，而是我把比例、留白和结构风险一起权衡后，先放在备选之外。' },
  { slot: 'S7', name: '开放邀请', stage: 'DELIVERED', layer: 'L4', mode: 'llm_free', char_limit: 110 },
  { slot: 'S8', name: '结尾', stage: 'closing', layer: '', mode: 'fixed_polish', char_limit: 80, fixed_seed_text: '最后的选择仍然留给您；我只把更稳妥、更值得停留的可能性摊开。' }
];

const SLOT_MAP = new Map(SLOT_DEFINITIONS.map(item => [item.slot, item]));
const FIELD_CATALOG = [
  // 00 槽位控制与写作边界：页面打开或槽位确定后即可获得。
  { path: 'task', label: '任务类型', phase: '00 槽位控制与写作边界', phase_order: 0, type: '控制字段', type_order: 0, description: '来自 LLM 调用参数。说明本次生成是交付正文、等待进度还是安装指引，用来选择槽位序列和口吻边界。' },
  { path: 'slot', label: '槽位编号', phase: '00 槽位控制与写作边界', phase_order: 0, type: '控制字段', type_order: 0, description: '来自当前槽位选择。S0–S8 决定这一段文案的职责范围，避免一个槽位承担过多信息。' },
  { path: 'slot_label', label: '槽位名称', phase: '00 槽位控制与写作边界', phase_order: 0, type: '控制字段', type_order: 0, description: '由槽位定义表生成的中文名称，例如“位置评估”“光线预测”，用于提醒模型当前只写哪一类内容。' },
  { path: 'slot_stage', label: '产出阶段', phase: '00 槽位控制与写作边界', phase_order: 0, type: '控制字段', type_order: 0, description: '来自槽位定义。表示该槽位在 MEASURING、UNDERSTANDING、EVALUATING、RENDERING、DELIVERED 等阶段，帮助避免提前暴露未完成事实。' },
  { path: 'slot_layer', label: '事实层级', phase: '00 槽位控制与写作边界', phase_order: 0, type: '控制字段', type_order: 0, description: '来自方案定义的 L1/L2/L3/L4。层级越高，越依赖后置 GPU 或渲染事实；运营可用它控制字段进入正文的时机。' },
  { path: 'slot_char_limit', label: '字数上限', phase: '00 槽位控制与写作边界', phase_order: 0, type: '控制字段', type_order: 0, description: '来自槽位定义。用于限制这一段中文正文长度，防止等待页或交付页文案过长。' },
  { path: 'mode', label: '生成模式', phase: '00 槽位控制与写作边界', phase_order: 0, type: '配置字段', type_order: 1, description: '来自 llm_slot_config。fixed_polish 表示围绕种子文案润色，llm_free 表示按字段事实自由生成。' },
  { path: 'seed_text', label: '种子文案', phase: '00 槽位控制与写作边界', phase_order: 0, type: '配置字段', type_order: 1, description: '来自槽位配置 fixed_seed_text，已按字段模板渲染。适合 fixed_polish 槽位，也可以作为 User JSON 中的 writing_seed。' },
  { path: 'instructions', label: '槽位写作指令', phase: '00 槽位控制与写作边界', phase_order: 0, type: '写作约束', type_order: 2, description: '来自服务端 slotInstructions。说明本槽位应该写什么、不要重复什么，是约束模型的核心边界。' },
  { path: 'cross_slot_policy', label: '跨槽位去重规则', phase: '00 槽位控制与写作边界', phase_order: 0, type: '写作约束', type_order: 2, description: '服务端生成的跨槽位规则。提醒模型只补充本槽位的新信息，不复述前序槽位已经讲过的高度、位置和安全判断。' },

  // 01 用户提交与作品基础信息：用户提交订单后即可获得。
  { path: 'allowed_facts.artwork.name', label: '作品名称', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品字段', type_order: 0, description: '来自业务端订单和作品库。用于自然称呼作品，缺失时通常回退为“您的作品”。' },
  { path: 'allowed_facts.artwork.author', label: '艺术家', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品字段', type_order: 0, description: '来自作品库或订单扩展信息。适合交付页轻量使用；等待页没有必要反复提及。' },
  { path: 'allowed_facts.artwork.size', label: '作品尺寸', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品字段', type_order: 0, description: '来自作品库或订单尺寸字段。可帮助解释比例判断，但不要机械复述数值。' },
  { path: 'allowed_facts.best_plan.artwork_analysis', label: '作品视觉分析', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品视觉字段', type_order: 1, description: '来自 GPU/VLM 或像素分析。包含画框、表面材质、复杂度等，用于解释作品气质和空间适配，不适合直接暴露原始 JSON。' },

  // 02 订单处理进度：业务端或 GPU 处理中持续更新。
  { path: 'allowed_facts.progress.status', label: '订单状态', phase: '02 订单处理进度', phase_order: 2, type: '状态字段', type_order: 0, description: '来自 orders.status。用于判断当前业务流程，不建议原样展示给用户。' },
  { path: 'allowed_facts.progress.current_step', label: '当前处理步骤', phase: '02 订单处理进度', phase_order: 2, type: '状态字段', type_order: 0, description: '来自业务端 AI 进度字段。表示正在语义识别、挂画评估或渲染等步骤，可转写为顾问正在看的内容。' },
  { path: 'allowed_facts.progress.pct', label: '进度百分比', phase: '02 订单处理进度', phase_order: 2, type: '数值字段', type_order: 1, description: '来自业务端进度百分比。适合 UI 展示，LLM 正文中通常不需要直接说百分比。' },
  { path: 'allowed_facts.progress.advisor_progress', label: '顾问进度文案', phase: '02 订单处理进度', phase_order: 2, type: '文案字段', type_order: 2, description: '来自业务端或 GPU 的顾问过程文案。可作为等待页语气参考，但不要和槽位正文重复。' },
  { path: 'allowed_facts.progress.bundle_state', label: '叙事包状态', phase: '02 订单处理进度', phase_order: 2, type: '状态字段', type_order: 0, description: '来自 hanging_narration_bundle_json。表示 GPU 侧叙事包的状态，用于判断事实是否成熟。' },

  // 03 空间语义与候选生成：Semantic / Hanging 阶段产出。
  { path: 'allowed_facts.candidates_count', label: '候选数量', phase: '03 空间语义与候选生成', phase_order: 3, type: '候选字段', type_order: 0, description: '来自 hanging_candidate_records_json。表示当前可用挂画候选数量，用于判断是否可以说“已经形成候选”。' },
  { path: 'allowed_facts.best_plan.wall_id', label: '首选墙面 ID', phase: '03 空间语义与候选生成', phase_order: 3, type: '位置字段', type_order: 1, description: '来自 GPU hanging 首选候选。用于内部追踪，不建议直接写给用户。' },
  { path: 'allowed_facts.best_plan.wall_position_zh', label: '首选位置', phase: '03 空间语义与候选生成', phase_order: 3, type: '位置字段', type_order: 1, description: '来自 GPU hanging 的中文位置归纳，例如“边柜上方”“主墙面”。这是 S3 位置说明的核心字段。' },
  { path: 'allowed_facts.best_plan.score', label: '候选分数', phase: '03 空间语义与候选生成', phase_order: 3, type: '评分字段', type_order: 2, description: '来自 GPU 候选排序分。用于内部判断强弱，不应直接对用户说“分数更高”。' },
  { path: 'allowed_facts.best_plan.risk_level', label: '风险等级', phase: '03 空间语义与候选生成', phase_order: 3, type: '风险字段', type_order: 3, description: '来自 GPU 候选风险评估。适合转写成“更稳妥/需要复核”，不要暴露枚举名。' },
  { path: 'allowed_facts.best_plan.reason_tags', label: '推荐原因标签', phase: '03 空间语义与候选生成', phase_order: 3, type: '原因字段', type_order: 4, description: '来自 GPU 候选原因标签。适合 S3 作为位置推荐理由的素材，但不要把标签机械串起来。' },

  // 04 安装几何与结构安全：Hanging 候选评分后产出。
  { path: 'allowed_facts.best_plan.center_height_cm', label: '画心高度', phase: '04 安装几何与结构安全', phase_order: 4, type: '安装数值', type_order: 0, description: '来自首选候选 install.center_height_cm。表示建议画心离地高度，单位厘米；适合 S3/S4 使用。' },
  { path: 'allowed_facts.best_plan.bottom_edge_cm', label: '底边高度', phase: '04 安装几何与结构安全', phase_order: 4, type: '安装数值', type_order: 0, description: '来自首选候选 install.bottom_edge_cm。表示作品底边离地高度，适合安装指引，不建议等待页反复提。' },
  { path: 'allowed_facts.best_plan.top_edge_cm', label: '顶边高度', phase: '04 安装几何与结构安全', phase_order: 4, type: '安装数值', type_order: 0, description: '来自首选候选 install.top_edge_cm。表示作品顶边离地高度，主要用于安装说明。' },
  { path: 'allowed_facts.best_plan.axis_centering', label: '轴线对齐', phase: '04 安装几何与结构安全', phase_order: 4, type: '构图字段', type_order: 1, description: '来自 composition_context。说明作品与家具或墙面中心线的关系，用于解释为什么看起来更稳定。' },
  { path: 'allowed_facts.best_plan.above_furniture_label_zh', label: '邻近家具', phase: '04 安装几何与结构安全', phase_order: 4, type: '构图字段', type_order: 1, description: '来自 composition_context。表示作品下方或附近家具，例如边柜、沙发，可作为构图支撑点。' },
  { path: 'allowed_facts.best_plan.structural_clearance', label: '结构安全间距', phase: '04 安装几何与结构安全', phase_order: 4, type: '安全字段', type_order: 2, description: '来自 GPU hanging 的结构避让信息，可能包含门窗、柜体、墙缘等距离。适合 S4 安全间距槽位使用。' },

  // 05 光线与渲染复核：光线字段或渲染前后才可靠。
  { path: 'allowed_facts.best_plan.light_components', label: '光线因素', phase: '05 光线与渲染复核', phase_order: 5, type: '光线字段', type_order: 0, description: '来自候选 light_components。用于 S5 光线预测；如果为空，应写“继续复核光线”，不要编造具体光照。' },
  { path: 'allowed_facts.best_plan.light_penalty_band', label: '光线风险档位', phase: '05 光线与渲染复核', phase_order: 5, type: '光线字段', type_order: 0, description: '来自候选 light_penalty_band。表示光线风险或惩罚区间，适合内部判断，不建议直接说枚举值。' },

  // 06 落选墙面与备选说明：候选排序后产出。
  { path: 'allowed_facts.not_recommended', label: '落选墙面', phase: '06 落选墙面与备选说明', phase_order: 6, type: '候选数组', type_order: 0, description: '来自 hanging_not_recommended_json。包含未进入首选的墙面及首要原因，适合 S6 用温和方式解释。' },

  // 07 前序槽位输出：同一次 SSE 槽位序列运行中动态累积。
  { path: 'previous_slot_outputs_text', label: '前序槽位全文', phase: '07 前序槽位输出', phase_order: 7, type: '去重上下文', type_order: 0, description: '来自本次 LLM SSE 中已经生成的前序槽位正文。后续槽位应参考它来承接和避重复。' },
  { path: 'previous_slot_outputs_map.S1', label: 'S1 已输出', phase: '07 前序槽位输出', phase_order: 7, type: '去重上下文', type_order: 0, description: '来自本次请求中 S1 的实际输出。S2/S3/S5 不应再复述 S1 已说的空间比例和测量内容。' },
  { path: 'previous_slot_outputs_map.S2', label: 'S2 已输出', phase: '07 前序槽位输出', phase_order: 7, type: '去重上下文', type_order: 0, description: '来自本次请求中 S2 的实际输出。S3/S5 可据此避免重复空间结构和家具支撑。' },
  { path: 'previous_slot_outputs_map.S3', label: 'S3 已输出', phase: '07 前序槽位输出', phase_order: 7, type: '去重上下文', type_order: 0, description: '来自本次请求中 S3 的实际输出。S4/S5 不应再重复首选位置或高度判断。' },
  { path: 'previous_slot_outputs_map.S4', label: 'S4 已输出', phase: '07 前序槽位输出', phase_order: 7, type: '去重上下文', type_order: 0, description: '来自本次请求中 S4 的实际输出。后续槽位不应重复安全间距说明。' },
  { path: 'previous_slot_outputs_map.S5', label: 'S5 已输出', phase: '07 前序槽位输出', phase_order: 7, type: '去重上下文', type_order: 0, description: '来自本次请求中 S5 的实际输出。交付收束时避免再次展开光线判断。' },

  // 08 真实 LLM 输入兼容字段：来自 buildLlmInput / buildBundleLlmInput，某些任务或阶段可能为空，也必须保留为可选字段，方便保存跨订单通用 prompt。
  { path: 'char_limit', label: '字数上限', phase: '00 槽位控制与写作边界', phase_order: 0, type: '控制字段', type_order: 0, description: '来自旧版 LLM 输入或叙事包输入。限制本次 user prompt 要求的输出长度，可能和 slot_char_limit 同时存在。' },
  { path: 'source', label: '输入来源', phase: '00 槽位控制与写作边界', phase_order: 0, type: '控制字段', type_order: 0, description: '来自 buildBundleLlmInput。标记输入由 causal_narration_bundle 等来源生成，用于排查真实发送给 LLM 的上下文。' },
  { path: 'state', label: '叙事包状态', phase: '02 订单处理进度', phase_order: 2, type: '状态字段', type_order: 0, description: '来自 hanging_narration_bundle_json.state。表示 GPU 侧叙事事实包当前状态。' },
  { path: 'progress_pct', label: '进度百分比', phase: '02 订单处理进度', phase_order: 2, type: '数值字段', type_order: 1, description: '来自旧版 waiting_progress 输入或叙事包 pct。适合等待页 UI 或简短过程表达。' },
  { path: 'stage_text', label: '阶段提示文案', phase: '02 订单处理进度', phase_order: 2, type: '文案字段', type_order: 2, description: '候选未生成时的阶段文本，例如正在分析空间与作品比例。等待页可用，交付页通常不用。' },
  { path: 'advisor_progress', label: '顾问进度文案', phase: '02 订单处理进度', phase_order: 2, type: '文案字段', type_order: 2, description: '旧版 waiting_progress 顶层字段。可作为等待页过程语气参考，避免与槽位正文重复。' },
  { path: 'facts', label: '叙事事实包', phase: '03 空间语义与候选生成', phase_order: 3, type: '叙事包字段', type_order: 0, description: '来自 hanging_narration_bundle_json.facts。包含 GPU 汇总后的候选、空间、光线或邀请信息，结构会随任务变化。' },
  { path: 'copy_hints', label: '文案提示', phase: '00 槽位控制与写作边界', phase_order: 0, type: '写作约束', type_order: 3, description: '来自叙事包 copy_hints。用于提示可写角度，只能作为写作素材，不补充事实。' },
  { path: 'fired', label: '已触发规则', phase: '00 槽位控制与写作边界', phase_order: 0, type: '写作约束', type_order: 3, description: '来自叙事包 fired。记录哪些叙事规则被触发，用于排查自动文案策略。' },
  { path: 'constraints', label: '约束列表', phase: '00 槽位控制与写作边界', phase_order: 0, type: '写作约束', type_order: 3, description: '来自 waiting_progress 或叙事包。告诉模型不要提前下结论、不要编造不存在的空间事实。' },
  { path: 'selected_field_paths', label: '已选择字段路径', phase: '00 槽位控制与写作边界', phase_order: 0, type: '调试字段', type_order: 9, description: '调试留痕字段。记录当前 prompt 模板引用过哪些字段，便于复盘和再次编辑。' },
  { path: 'user_prompt_template_mode', label: 'User Prompt 模板类型', phase: '00 槽位控制与写作边界', phase_order: 0, type: '调试字段', type_order: 9, description: '调试留痕字段。json_template 表示以 JSON 模板渲染，text_template 表示文本模板渲染。' },

  { path: 'artwork.name', label: '作品名称', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品字段', type_order: 0, description: '旧版或叙事包顶层 artwork.name。与 allowed_facts.artwork.name 含义一致。' },
  { path: 'artwork.author', label: '艺术家', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品字段', type_order: 0, description: '旧版或叙事包顶层 artwork.author。适合轻量称呼，不建议等待页反复强调。' },
  { path: 'artwork.size', label: '作品尺寸', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品字段', type_order: 0, description: '旧版或叙事包顶层 artwork.size。用于比例解释，字段为空时不应编造尺寸。' },
  { path: 'artwork.visual_complexity', label: '作品视觉复杂度', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品视觉字段', type_order: 1, description: '来自叙事包 invitation.visual_complexity。表示作品画面复杂度，适合解释空间留白需求。' },

  { path: 'best_plan.wall_position_zh', label: '推荐位置', phase: '03 空间语义与候选生成', phase_order: 3, type: '位置字段', type_order: 1, description: '旧版 LLM 输入顶层 best_plan 字段。表示当前首选墙面或家具关系，例如边柜上方。' },
  { path: 'best_plan.center_height_cm', label: '画心高度', phase: '04 安装几何与结构安全', phase_order: 4, type: '安装数值', type_order: 0, description: '旧版 LLM 输入顶层 best_plan 字段。表示建议画心离地高度，单位厘米。' },
  { path: 'best_plan.height_finalized', label: '高度已确认', phase: '04 安装几何与结构安全', phase_order: 4, type: '安装状态', type_order: 0, description: '旧版 install.height_finalized。为 false 时文案需要提醒现场卷尺确认最终钉点。' },
  { path: 'best_plan.height_rule_label', label: '高度规则', phase: '04 安装几何与结构安全', phase_order: 4, type: '安装说明', type_order: 1, description: '来自 install 或 composition_context。表示高度选择依据，例如视线高度或家具关系。' },
  { path: 'best_plan.risk_level', label: '风险等级', phase: '03 空间语义与候选生成', phase_order: 3, type: '风险字段', type_order: 3, description: '旧版 LLM 输入顶层 risk_level。适合转写为更稳妥、需要复核等自然表达。' },
  { path: 'best_plan.reason_tags', label: '推荐原因标签', phase: '03 空间语义与候选生成', phase_order: 3, type: '原因字段', type_order: 4, description: '旧版 LLM 输入顶层原因标签。用于归纳推荐理由，不要机械串标签。' },
  { path: 'best_plan.composition_zh', label: '构图说明', phase: '04 安装几何与结构安全', phase_order: 4, type: '构图字段', type_order: 1, description: '旧版 composition_context 的中文汇总。说明家具、轴线和留白关系。' },
  { path: 'best_plan.cleanup_required', label: '需要清理', phase: '04 安装几何与结构安全', phase_order: 4, type: '现场处理', type_order: 3, description: '来自 cleanup_info.any_cleanup_required。表示悬挂前是否需要清理原有内容或遮挡。' },
  { path: 'best_plan.cleanup_note', label: '清理说明', phase: '04 安装几何与结构安全', phase_order: 4, type: '现场处理', type_order: 3, description: '来自 cleanup_info.cleanup_scope_label。说明需要处理的现场内容。' },
  { path: 'best_plan.clearance_note', label: '安全避让说明', phase: '04 安装几何与结构安全', phase_order: 4, type: '安全字段', type_order: 2, description: '旧版 structural_clearance 的自然语言汇总，例如距门窗或柜体的距离。' },
  { path: 'best_plan.bottom_edge_cm', label: '底边高度', phase: '04 安装几何与结构安全', phase_order: 4, type: '安装数值', type_order: 0, description: '旧版 LLM 输入顶层 best_plan 字段。表示作品底边离地高度。' },
  { path: 'best_plan.top_edge_cm', label: '顶边高度', phase: '04 安装几何与结构安全', phase_order: 4, type: '安装数值', type_order: 0, description: '旧版 LLM 输入顶层 best_plan 字段。表示作品顶边离地高度。' },
  { path: 'best_plan.nail_height_cm', label: '钉点高度', phase: '04 安装几何与结构安全', phase_order: 4, type: '安装数值', type_order: 0, description: '来自 install.nail_height_cm。表示钉点建议高度，适合安装指引任务。' },
  { path: 'alternatives_count', label: '备选数量', phase: '06 落选墙面与备选说明', phase_order: 6, type: '候选字段', type_order: 0, description: '旧版 LLM 输入顶层字段。表示除首选外还有多少备选。' },
  { path: 'not_recommended', label: '落选方案', phase: '06 落选墙面与备选说明', phase_order: 6, type: '候选数组', type_order: 0, description: '旧版 LLM 输入顶层落选方案数组。包含墙面名称、原因和重试建议。' },
  { path: 'not_recommended.0.wall_zh', label: '落选墙面名称', phase: '06 落选墙面与备选说明', phase_order: 6, type: '候选数组', type_order: 1, description: '落选方案第 1 项的中文墙面名称。字段为空时不要编造方位。' },
  { path: 'not_recommended.0.reason', label: '落选原因', phase: '06 落选墙面与备选说明', phase_order: 6, type: '候选数组', type_order: 1, description: '落选方案第 1 项的原因汇总。用于 S6 温和解释，不做贬低。' },
  { path: 'not_recommended.0.retry_hint', label: '重试建议', phase: '06 落选墙面与备选说明', phase_order: 6, type: '候选数组', type_order: 1, description: '落选方案第 1 项的可重试提示，例如换拍摄角度或更小作品。' },
  { path: 'soft_risk', label: '软风险说明', phase: '03 空间语义与候选生成', phase_order: 3, type: '风险字段', type_order: 3, description: '来自 soft_risk_info.soft_risk_reasons_zh。用于表达需要复核的非硬性风险。' },
  { path: 'light_analysis', label: '光线分析', phase: '05 光线与渲染复核', phase_order: 5, type: '光线字段', type_order: 0, description: '旧版 LLM 输入顶层光线字段。可能来自 light_components、light_facts 或 light_semantics。' },
  { path: 'light_components', label: '光线因素', phase: '05 光线与渲染复核', phase_order: 5, type: '光线字段', type_order: 0, description: '叙事包或旧版输入中的光线因素。为空时只说继续复核光线，不写具体光照。' },
  { path: 'light_penalty_band', label: '光线风险档位', phase: '05 光线与渲染复核', phase_order: 5, type: '光线字段', type_order: 0, description: '旧版 LLM 输入顶层光线风险或惩罚档位。' },
  { path: 'light_risk_band', label: '光线风险等级', phase: '05 光线与渲染复核', phase_order: 5, type: '光线字段', type_order: 0, description: '旧版 LLM 输入顶层光线风险等级。' },

  { path: 'allowed_facts.best_plan.structural_clearance.elements', label: '避让对象列表', phase: '04 安装几何与结构安全', phase_order: 4, type: '安全字段', type_order: 2, description: '结构安全间距中的具体避让对象数组，例如门、窗、柜体或墙缘。字段可能为空。' },
  { path: 'allowed_facts.best_plan.structural_clearance.elements.0.label_zh', label: '避让对象名称', phase: '04 安装几何与结构安全', phase_order: 4, type: '安全字段', type_order: 2, description: '第 1 个避让对象的中文名称，例如门洞、窗边、柜体。' },
  { path: 'allowed_facts.best_plan.structural_clearance.elements.0.edge_clearance_cm', label: '边缘间距', phase: '04 安装几何与结构安全', phase_order: 4, type: '安全字段', type_order: 2, description: '作品边缘到第 1 个避让对象的距离，单位厘米。' },
  { path: 'allowed_facts.best_plan.structural_clearance.elements.0.min_clearance_cm', label: '最低安全间距', phase: '04 安装几何与结构安全', phase_order: 4, type: '安全字段', type_order: 2, description: '第 1 个避让对象要求的最低间距，单位厘米。' },
  { path: 'allowed_facts.best_plan.structural_clearance.elements.0.passed', label: '避让是否通过', phase: '04 安装几何与结构安全', phase_order: 4, type: '安全字段', type_order: 2, description: '第 1 个避让对象是否通过安全间距规则。' },
  { path: 'allowed_facts.best_plan.artwork_analysis.has_frame', label: '是否有画框', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品视觉字段', type_order: 1, description: '来自作品视觉分析。表示是否识别到画框或装裱边界。' },
  { path: 'allowed_facts.best_plan.artwork_analysis.frame_style', label: '装裱形式', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品视觉字段', type_order: 1, description: '来自作品视觉分析。描述画框、卷轴、布面或其他装裱形式。' },
  { path: 'allowed_facts.best_plan.artwork_analysis.artwork_surface_style', label: '画面表面', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品视觉字段', type_order: 1, description: '来自作品视觉分析。描述纸本、布面、玻璃反光等表面特征。' },
  { path: 'allowed_facts.best_plan.artwork_analysis.visual_complexity', label: '视觉复杂度', phase: '01 用户提交与作品基础信息', phase_order: 1, type: '作品视觉字段', type_order: 1, description: '来自作品视觉分析。用于判断作品是否需要更多留白。' },
  { path: 'allowed_facts.not_recommended.0.wall_zh', label: '落选墙面名称', phase: '06 落选墙面与备选说明', phase_order: 6, type: '候选数组', type_order: 1, description: '完整字段表中的落选墙面第 1 项名称。某些任务中不产出，也可作为空值字段保留。' },
  { path: 'allowed_facts.not_recommended.0.primary_reason', label: '落选首要原因', phase: '06 落选墙面与备选说明', phase_order: 6, type: '候选数组', type_order: 1, description: '完整字段表中的落选墙面第 1 项原因。适合 S6 使用。' },
  { path: 'previous_slot_outputs', label: '前序槽位列表', phase: '07 前序槽位输出', phase_order: 7, type: '去重上下文', type_order: 0, description: '同一次 SSE 中已生成槽位的数组形式。包含 slot 与 text，适合结构化去重。' },
  { path: 'previous_slot_outputs.0.slot', label: '前序槽位编号', phase: '07 前序槽位输出', phase_order: 7, type: '去重上下文', type_order: 0, description: '前序槽位第 1 项的槽位编号。' },
  { path: 'previous_slot_outputs.0.text', label: '前序槽位正文', phase: '07 前序槽位输出', phase_order: 7, type: '去重上下文', type_order: 0, description: '前序槽位第 1 项已经生成的正文。后续槽位用它避重复。' }
];

const DEFAULT_PROMPT_VERSION = 'slot_v2_2026_07';

function getSlotSequence(task = 'delivery_main') {
  if (task === 'install_guide') return ['S3', 'S4', 'S8'];
  if (task === 'waiting_progress') return ['S1', 'S2', 'S3', 'S5'];
  return SLOT_DEFINITIONS.map(item => item.slot);
}

function slotLabel(slot) {
  const def = SLOT_MAP.get(slot);
  return def ? `${def.slot} ${def.name}` : slot;
}

function ensureDefaultSlotConfigs(db) {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM llm_slot_config').get().count;
  if (existing > 0) return;
  const insert = db.prepare(`
    INSERT INTO llm_slot_config (
      id, task, slot, mode, fixed_seed_text, system_prompt, user_prompt_template, is_active, gray_ratio, version_label, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'system')
  `);
  const trx = db.transaction(() => {
    for (const task of ['delivery_main', 'waiting_progress', 'install_guide']) {
      for (const slot of getSlotSequence(task)) {
        const def = SLOT_MAP.get(slot);
        if (!def) continue;
        insert.run(
          newId('slotcfg'),
          task,
          slot,
          def.mode,
          def.fixed_seed_text || '',
          buildSlotSystemPrompt(slot, def.mode),
          buildDefaultUserPromptTemplate(task, slot),
          DEFAULT_PROMPT_VERSION
        );
      }
    }
  });
  trx();
}

function getActiveSlotConfig(db, task, slot) {
  const row = db.prepare(`
    SELECT * FROM llm_slot_config
    WHERE task = ? AND slot = ? AND is_active = 1
    ORDER BY created_at DESC
    LIMIT 1
  `).get(task, slot);
  return row || fallbackSlotConfig(task, slot);
}

function selectSlotConfigForRun(db, task, slot, { orderId = '', source = 'baseline_production' } = {}) {
  const active = getActiveSlotConfig(db, task, slot);
  const ratio = clampGrayRatio(active.gray_ratio ?? 1);
  const bucket = stableGrayBucket([orderId || 'anonymous', task, slot, active.id || active.version_label || 'default']);
  const shouldApply = ratio >= 1 || bucket <= ratio;

  if (shouldApply) {
    return {
      config: active,
      gray: {
        gray_ratio: ratio,
        gray_bucket: bucket,
        gray_applied: true,
        selected_config_id: active.id || null,
        fallback_config_id: null
      }
    };
  }

  const fallback = db.prepare(`
    SELECT * FROM llm_slot_config
    WHERE task = ? AND slot = ? AND id != ?
    ORDER BY is_active DESC, created_at DESC
    LIMIT 1
  `).get(task, slot, active.id || '');

  const selected = fallback || fallbackSlotConfig(task, slot);
  return {
    config: selected,
    gray: {
      gray_ratio: ratio,
      gray_bucket: bucket,
      gray_applied: false,
      selected_config_id: selected.id || null,
      fallback_config_id: selected.id || null,
      target_config_id: active.id || null
    }
  };
}

function getOrderSlotOverride(db, orderId, task, slot) {
  return db.prepare(`
    SELECT * FROM llm_slot_overrides
    WHERE order_id = ? AND task = ? AND slot = ? AND is_active = 1
    ORDER BY created_at DESC
    LIMIT 1
  `).get(orderId, task, slot);
}

function buildSlotSystemPrompt(slot, mode) {
  const def = SLOT_MAP.get(slot) || {};
  const modeText = mode === 'fixed_polish'
    ? '本槽位是固定文案润色：必须保留给定 seed_text 的核心意思，只做更自然、更像顾问的表达。'
    : '本槽位是纯 LLM 生成：只能基于 user JSON 中已经给出的事实转写，不补充未知事实。';
  return `${SYSTEM_PROMPT}\n\n当前槽位：${slotLabel(slot)}。产出阶段：${def.stage || '通用'}。层级：${def.layer || '无'}。${modeText}\n只输出本槽位正文，不加标题、编号或 Markdown。`;
}

function buildDefaultUserPromptTemplate(task = 'delivery_main', slot = 'S3') {
  const common = {
    task: '{{task}}',
    slot: '{{slot}}',
    slot_label: '{{slot_label}}',
    stage: '{{slot_stage}}',
    layer: '{{slot_layer}}',
    char_limit: '{{slot_char_limit}}',
    writing_instruction: '{{instructions}}',
    cross_slot_policy: '{{cross_slot_policy}}',
    previous_outputs: '{{previous_slot_outputs_text}}',
    artwork: {
      name: '{{allowed_facts.artwork.name}}',
      author: '{{allowed_facts.artwork.author}}',
      size: '{{allowed_facts.artwork.size}}'
    }
  };
  const bySlot = {
    S0: { writing_seed: '{{seed_text}}' },
    S1: { progress: '{{allowed_facts.progress}}', candidates_count: '{{allowed_facts.candidates_count}}' },
    S2: { furniture_context: '{{allowed_facts.best_plan.above_furniture_label_zh}}', axis_centering: '{{allowed_facts.best_plan.axis_centering}}' },
    S3: { recommended_position: '{{allowed_facts.best_plan.wall_position_zh}}', reason_tags: '{{allowed_facts.best_plan.reason_tags}}', center_height_cm: '{{allowed_facts.best_plan.center_height_cm}}' },
    S4: { structural_clearance: '{{allowed_facts.best_plan.structural_clearance}}', bottom_edge_cm: '{{allowed_facts.best_plan.bottom_edge_cm}}', top_edge_cm: '{{allowed_facts.best_plan.top_edge_cm}}' },
    S5: { light_components: '{{allowed_facts.best_plan.light_components}}', light_penalty_band: '{{allowed_facts.best_plan.light_penalty_band}}' },
    S6: { not_recommended: '{{allowed_facts.not_recommended}}', writing_seed: '{{seed_text}}' },
    S7: { recommended_position: '{{allowed_facts.best_plan.wall_position_zh}}', previous_outputs: '{{previous_slot_outputs_text}}' },
    S8: { writing_seed: '{{seed_text}}', previous_outputs: '{{previous_slot_outputs_text}}' }
  };
  return JSON.stringify({ ...common, facts_for_this_slot: bySlot[slot] || {} }, null, 2);
}

function baseInput(order, task, charLimit) {
  const fromBundle = task === 'install_guide' ? null : buildBundleLlmInput(order, task, charLimit);
  return fromBundle || buildLlmInput(order, task, charLimit);
}

function getPromptFieldValue(input, path) {
  if (!input || !path) return undefined;
  const parts = String(path).split('.').filter(Boolean);
  let cur = input;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else cur = cur[part];
  }
  return cur;
}

function formatPromptFieldValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function renderPromptTemplate(template, input) {
  const text = String(template || '');
  if (!text || !input) return text;
  return text.replace(/\{\{\s*([a-zA-Z0-9_.$\[\]-]+)\s*\}\}/g, (full, rawPath) => {
    const normalized = String(rawPath || '').replace(/\[(\d+)\]/g, '.$1');
    const value = getPromptFieldValue(input, normalized);
    return value == null ? '' : formatPromptFieldValue(value);
  });
}


function renderUserPromptTemplate(template, input) {
  const raw = String(template || '').trim();
  if (!raw) return { userPrompt: '', inputObject: null, isJsonTemplate: false };
  try {
    const parsed = JSON.parse(raw);
    const transform = (value) => {
      if (typeof value === 'string') {
        const exact = value.match(/^\s*\{\{\s*([a-zA-Z0-9_.$\[\]-]+)\s*\}\}\s*$/);
        if (exact) {
          const resolved = getPromptFieldValue(input, String(exact[1]).replace(/\[(\d+)\]/g, '.$1'));
          return (resolved === undefined || resolved === null) ? '' : resolved;
        }
        return renderPromptTemplate(value, input);
      }
      if (Array.isArray(value)) return value.map(transform);
      if (value && typeof value === 'object') {
        const out = {};
        for (const [key, child] of Object.entries(value)) out[key] = transform(child);
        return out;
      }
      return value;
    };
    const inputObject = transform(parsed);
    return { userPrompt: JSON.stringify(inputObject, null, 2), inputObject, isJsonTemplate: true };
  } catch (_) {
    const promptText = renderPromptTemplate(raw, input);
    return { userPrompt: promptText, inputObject: { prompt_text: promptText }, isJsonTemplate: false };
  }
}

function extractPromptTemplatePaths(...texts) {
  const paths = new Set();
  const pattern = /\{\{\s*([a-zA-Z0-9_.$\[\]-]+)\s*\}\}/g;
  for (const text of texts) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(String(text || '')))) {
      const path = String(match[1] || '').replace(/\[(\d+)\]/g, '.$1').trim();
      if (path) paths.add(path);
    }
  }
  return Array.from(paths);
}

function setPromptFieldValue(target, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return;
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!cur[part] || typeof cur[part] !== 'object' || Array.isArray(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function buildScopedSlotInput(input, referencedPaths = []) {
  const paths = Array.from(new Set((referencedPaths || []).filter(Boolean)));
  if (!paths.length) return input;
  const scoped = {
    task: input.task,
    slot: input.slot,
    slot_label: input.slot_label,
    slot_stage: input.slot_stage,
    slot_layer: input.slot_layer,
    slot_char_limit: input.slot_char_limit,
    mode: input.mode,
    seed_text: input.seed_text || '',
    instructions: input.instructions,
    cross_slot_policy: input.cross_slot_policy,
    selected_field_paths: paths
  };
  for (const path of paths) {
    const value = getPromptFieldValue(input, path);
    if (value !== undefined) setPromptFieldValue(scoped, path, value);
  }
  return scoped;
}

function buildSlotInput(order, task, slot, config = null, options = {}) {
  const def = SLOT_MAP.get(slot) || {};
  const charLimit = Number(def.char_limit || (task === 'install_guide' ? 160 : 120));
  const input = baseInput(order, task, charLimit);
  const candidates = safeParse(order.hanging_candidate_records_json, []);
  const notRecommended = safeParse(order.hanging_not_recommended_json, []);
  const best = candidates[0] || {};
  const install = best.install || {};
  const comp = best.composition_context || {};
  const clearance = best.structural_clearance || {};
  const bundle = safeParse(order.hanging_narration_bundle_json, null);
  const previousOutputs = Array.isArray(options.previousOutputs) ? options.previousOutputs : [];
  const previousOutputMap = {};
  for (const item of previousOutputs) {
    if (item && item.slot) previousOutputMap[String(item.slot)] = String(item.text || '');
  }

  // Intentional soft gate:
  // slot_stage / slot_layer / allowed_facts / instructions are included so prompt and fallback
  // can avoid exposing unavailable facts. We do not hard-block slot execution by order stage here,
  // because waiting-page copy still needs a graceful advisor response while GPU data is partial.
  const result = {
    ...input,
    task,
    slot,
    slot_label: slotLabel(slot),
    slot_stage: def.stage || '',
    slot_layer: def.layer || '',
    slot_char_limit: charLimit,
    mode: (config && config.mode) || def.mode || 'llm_free',
    seed_text: (config && config.fixed_seed_text) || def.fixed_seed_text || '',
    allowed_facts: {
      artwork: {
        name: order.artwork_name || '您的作品',
        author: order.artwork_author || '',
        size: order.artwork_size || ''
      },
      progress: {
        status: order.status || '',
        current_step: order.ai_current_step || '',
        pct: order.ai_progress_pct ?? null,
        advisor_progress: order.ai_advisor_progress || '',
        bundle_state: bundle && bundle.state ? bundle.state : ''
      },
      best_plan: best && best.wall_id ? {
        wall_id: best.wall_id,
        wall_position_zh: cleanUserLabel(best.wall_position_zh, cleanUserLabel(comp.above_furniture_label_zh, '主墙面')),
        score: best.score ?? null,
        risk_level: best.risk_level || '',
        reason_tags: best.reason_tags || [],
        center_height_cm: install.center_height_cm ?? null,
        bottom_edge_cm: install.bottom_edge_cm ?? null,
        top_edge_cm: install.top_edge_cm ?? null,
        axis_centering: comp.axis_centering ?? null,
        above_furniture_label_zh: comp.above_furniture_label_zh || '',
        structural_clearance: clearance,
        light_components: best.light_components || null,
        light_penalty_band: best.light_penalty_band || null,
        artwork_analysis: best.artwork_analysis || null
      } : null,
      candidates_count: Array.isArray(candidates) ? candidates.length : 0,
      not_recommended: (notRecommended || []).slice(0, 3).map(nr => ({
        wall_zh: nr.wall_position_zh || nr.wall_id || '某面墙',
        primary_reason: (nr.reasons || [])[0] || nr.reason || ''
      }))
    },
    previous_slot_outputs: previousOutputs.map(item => ({ slot: item.slot, text: String(item.text || '') })).filter(item => item.slot && item.text),
    previous_slot_outputs_map: previousOutputMap,
    previous_slot_outputs_text: previousOutputs.map(item => `${item.slot}: ${item.text}`).join('\n'),
    cross_slot_policy: '只补充本槽位的新信息；不要复述 previous_slot_outputs_text 中已经说过的高度、位置、安全间距或光线判断。',
    instructions: slotInstructions(slot)
  };
  result.seed_text = renderPromptTemplate(result.seed_text, result);
  return result;
}

function slotInstructions(slot) {
  const map = {
    S0: '用一句温暖开场，把选择权交还给用户，不要说系统或算法。',
    S1: '描述正在/已经确认空间比例与墙面留白；不暴露深度、像素、模型等技术词。不要提及高度、安全间距或位置评估。',
    S2: '描述空间结构、家具支撑或已有画面关系；没有事实时保持克制。不要重复S1的空间比例内容，不要提及高度或安全间距。',
    S3: '说明为什么首选位置更稳妥，可提约略高度和构图关系。不要重复S1和S2的内容，专注于位置选择的理由。',
    S4: '说明安全间距与避让逻辑，把拒绝讲成专业建议。不要重复前面槽位的内容。',
    S5: '只在已有光线字段时描述光线预测；没有光线事实时说正在复核光线与画面融合。不要重复前面槽位的内容。',
    S6: '解释落选候选的首要原因，不做贬低，不让用户感到被否定。',
    S7: '开放式邀请用户感受不同墙面的长期相处方式，不替用户拍板。',
    S8: '简洁收束，强调顾问摊开可能性，最终选择仍在用户。'
  };
  return map[slot] || '按槽位事实输出自然中文。';
}

function buildSlotFallbackText(order, task, slot, config = null) {
  const candidates = safeParse(order.hanging_candidate_records_json, []);
  const notRecommended = safeParse(order.hanging_not_recommended_json, []);
  const best = candidates[0] || null;
  const seed = String((config && config.fixed_seed_text) || (SLOT_MAP.get(slot) || {}).fixed_seed_text || '').trim();
  if (!best) {
    if (task === 'waiting_progress') return buildFallbackText(order, 'waiting_progress');
    if (slot === 'S6' && notRecommended.length) {
      const nr = notRecommended[0] || {};
      return `${nr.wall_position_zh || nr.wall_id || '这面墙'}暂时没有进入首选，我更在意比例、留白和结构间距一起成立，而不是勉强把作品放上去。`;
    }
    return seed || buildFallbackText(order, task);
  }
  const install = best.install || {};
  const comp = best.composition_context || {};
  const wall = cleanUserLabel(best.wall_position_zh, cleanUserLabel(comp.above_furniture_label_zh, '主墙面'));
  const h = install.center_height_cm || install.provisional_center_height_cm;
  const tags = (best.reason_tags || []).slice(0, 2).join('、');
  const clearance = best.structural_clearance || {};
  const firstGap = (clearance.elements || []).find(e => e && e.label_zh && e.edge_clearance_cm);
  const lightBand = best.light_penalty_band || (best.light_components && best.light_components.penalty_band) || '';
  const fallbacks = {
    S0: seed || `我会把${order.artwork_name || '这幅作品'}放回您的真实空间里，陪您看见更适合它停留的位置。`,
    S1: '我已经先看过墙面留白和空间比例，重点不是把画放进去，而是让它和房间的尺度关系先成立。',
    S2: comp.above_furniture_label_zh ? `这面墙和${comp.above_furniture_label_zh}之间有可借力的视觉支撑，作品放上去会更像空间的一部分。` : '我正在把墙面、家具和已有视觉重心放在一起看，避免让作品显得孤立。',
    S3: `${wall}是当前更稳妥的推荐位置${h ? `，画心离地约${h}厘米` : ''}${tags ? `，这里${tags}` : ''}。`,
    S4: firstGap ? `我保留了作品与${firstGap.label_zh}之间约${firstGap.edge_clearance_cm}厘米的距离，让悬挂关系更安全，也更从容。` : '我会优先避开门窗、边框和拥挤的视觉区域，不为了效果图去牺牲现场悬挂的安全感。',
    S5: lightBand ? `光线关系我也会继续复核，当前这处位置的明暗变化更适合进入最终画面融合。` : '光线和阴影还会在最后效果图里继续校准，我会尽量让作品像自然留在这面墙上。',
    S6: seed || '未进入首选的位置并不是不好，而是和当前作品尺寸、留白或结构避让相比，暂时没有这处更从容。',
    S7: '同一幅作品换一面墙，会牵出您对这个空间不一样的期待；真正适合的地方，也许是您每天更愿意停留的那一处。',
    S8: seed || '这些判断只是把可能性摊开，最后那一点心里的靠近，仍然由您来决定。'
  };
  return fallbacks[slot] || buildFallbackText(order, task);
}

function deriveBannedTermsFromSystemPrompt() {
  const terms = new Set();
  const quoted = /「([^」]+)」/g;
  String(SYSTEM_PROMPT || '').split(/\r?\n/).forEach(line => {
    if (!/不提|不使用/.test(line)) return;
    let match;
    while ((match = quoted.exec(line))) {
      if (match[1]) terms.add(match[1]);
    }
    quoted.lastIndex = 0;
    if (/Markdown/i.test(line)) terms.add('Markdown');
  });
  return Array.from(terms).filter(Boolean);
}

const BANNED_TERMS = deriveBannedTermsFromSystemPrompt();

function lintOutput(text, { charLimit = 260 } = {}) {
  const value = String(text || '');
  const tags = [];
  for (const term of BANNED_TERMS) {
    if (value.includes(term)) tags.push(`banned:${term}`);
  }
  if (/^\s*[-*#>]/m.test(value)) tags.push('markdown_like');
  if (value.length > Number(charLimit || 260) * 1.35) tags.push('too_long');
  if (/\b(undefined|null|NaN)\b/i.test(value)) tags.push('raw_placeholder');
  return tags;
}

function recordRun(db, {
  orderId,
  task,
  slot,
  source = 'baseline_production',
  inputFields,
  systemPrompt,
  userPrompt,
  model,
  temperature,
  maxTokens,
  outputText,
  fixedSourceId = null,
  latencyMs = null,
  errorText = null,
  promptVersion = DEFAULT_PROMPT_VERSION,
  createdBy = 'system',
  mode = '',
  slotConfigId = null,
  grayRatio = null,
  grayBucket = null,
  grayApplied = null
}) {
  const id = newId('run');
  db.prepare(`
    INSERT INTO llm_debug_runs (
      id, order_id, task, slot, source, input_fields_json, system_prompt, user_prompt,
      model, temperature, max_tokens, output_text, fixed_source_id, latency_ms,
      error_text, prompt_version, created_by, mode, slot_config_id, gray_ratio, gray_bucket, gray_applied
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    orderId,
    task,
    slot,
    source,
    JSON.stringify(inputFields || {}),
    systemPrompt || '',
    userPrompt || '',
    model || '',
    temperature ?? null,
    maxTokens ?? null,
    outputText || '',
    fixedSourceId,
    latencyMs,
    errorText,
    promptVersion || DEFAULT_PROMPT_VERSION,
    createdBy || 'system',
    mode || '',
    slotConfigId,
    grayRatio,
    grayBucket,
    grayApplied == null ? null : (grayApplied ? 1 : 0)
  );
  const charLimit = inputFields && inputFields.slot_char_limit ? inputFields.slot_char_limit : 260;
  const violations = lintOutput(outputText, { charLimit });
  db.prepare(`
    INSERT INTO llm_run_annotations (id, run_id, annotator_type, annotator, dimension_scores_json, violation_tags_json, comment)
    VALUES (?, ?, 'auto_lint', 'system', ?, ?, ?)
  `).run(
    newId('ann'),
    id,
    JSON.stringify({}),
    JSON.stringify(violations),
    violations.length ? '自动规则发现可复核项' : '自动规则通过'
  );
  return id;
}

module.exports = {
  SLOT_DEFINITIONS,
  FIELD_CATALOG,
  DEFAULT_PROMPT_VERSION,
  ensureDefaultSlotConfigs,
  getSlotSequence,
  getActiveSlotConfig,
  selectSlotConfigForRun,
  stableGrayBucket,
  getOrderSlotOverride,
  buildSlotInput,
  buildSlotSystemPrompt,
  buildDefaultUserPromptTemplate,
  buildSlotFallbackText,
  renderPromptTemplate,
  renderUserPromptTemplate,
  extractPromptTemplatePaths,
  buildScopedSlotInput,
  lintOutput,
  recordRun,
  newId,
  slotLabel
};
