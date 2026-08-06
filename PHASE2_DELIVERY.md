# 第二阶段交付说明

本阶段接入 Stage B 骨架所需的业务端契约。

- `services/hangingJob.js` 下发订单级 `soft_furnishing_requested`；`recommend_space` 服务强制忽略该开关。
- `services/hangingResultProcessor.js` 透传 `pre_styling_image_url` 与 `styling_status`。
- 等待进度新增 `styling` 阶段，展示“正在优化空间风格与色彩…”。
- 墙纸建议、用户 opt-in、数据库列与主推荐墙补渲染仍按最终规格留待阶段 4–5。
