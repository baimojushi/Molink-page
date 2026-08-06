# 第五阶段交付说明

本阶段完成深色墙纸建议从“只展示”到“可持久化、可渲染、可回写”的闭环。

## 业务端

- `POST /api/client/wall-preferences` 接收 `wallpaper_opt_in`，只允许用户对本次已选中且服务端判定 `suggest_dark_wallpaper=true` 的墙面开启上色；建议色完全取服务端候选数据，不信任客户端色值。
- `user_wall_preferences` 新增 `wallpaper_opt_in` 与 `wallpaper_tone_rgb`，根目录和 `overlay` 的建表及幂等升级定义保持一致。
- 非主墙按墙面构造补渲染 job；软装与墙纸参数同时进入同一 Stage B 请求，每张资产仍最多调用一次生图 provider。
- 主推荐墙带墙纸 opt-in 时不再被过滤。job 显式标记 `primary_wall_rerender`，并携带原始 `pre_styling_image_url` 的 asset/wall 映射。
- 补渲染结果只合并对应候选。主推荐墙 Stage B 失败或 QA 拒绝时保留原交付图；成功时替换 `final_image_url`，但始终保留最初的 `pre_styling_image_url`。订单终态、交付时间和邮件状态均不重置。
- 小程序提交等待页当前勾选状态；服务端返回单个及多个补渲染 job id，兼容旧调用方。

## GPU 端

- 主推荐墙补渲染从持久化的 Stage A 底图填充 `final_hd`，不重新调用 Stage A provider，也不以已经软装过的终图为输入。
- Stage B 继续复用既有保护区、局部二值合成与内容 QA；墙纸和软装同时请求时仍只进行一次合并调用。
- result payload 附带 `primary_wall_rerender`、`wallpaper_recolor_requested` 与 `stage_a_base_source`，供业务端执行安全替换和审计。
- 订单以 `primary_wall_rerender_status`（`idle | pending | succeeded | failed`）和 `primary_wall_rerender_job_id` 记录主墙补渲染状态；结果仅在 job_id 匹配当前请求时收敛，失败或 QA 拒绝均停止客户端轮询并保留原交付图。
- 小程序与网页端均以结构化状态驱动处理中提示和 5 秒轮询，不再通过 `ai_current_step` 文案正则猜测终态；网页交付面板同时提供墙纸建议提交入口。
- Stage A 底图映射缺失或无法匹配 manifest 时失败关闭，不会退化成基于当前成品图继续生成。

## 回归覆盖

- Node contract smoke 覆盖：主墙过滤分支、软装/墙纸合并 job、旧记录从 URL 恢复 asset id、主墙 QA 失败保留原图、成功替换但保留 Stage A URL，以及公开字段清洗。
- GPU 新增 `tests/test_phase5_primary_stage_a_reuse.py`，覆盖零 Stage A 调用的底图复用及映射缺失时失败关闭。
- 既有 Stage B 四组合回归继续约束：无请求 0 次、软装/墙纸/两者同时请求均为每资产 1 次。
