# 第三阶段交付说明

- 继续沿用第二阶段的 `pre_styling_image_url` 与 `styling_status` 契约。
- 候选落库记录保留 `styling_zone_source` 与 `styling_qa`，供后台与人工抽检；所有客户端交付接口会剥离这两个内部诊断字段。
- 补充墙面渲染 job 继承订单的 `soft_furnishing_requested`，保证同一订单主墙与加选墙风格一致。
- `pre_styling_image_url` 仅在 `styling_status === 'succeeded'` 时向客户端下发。
- 等待页仍使用第二阶段已经接入的“正在优化空间风格与色彩…”进度。
