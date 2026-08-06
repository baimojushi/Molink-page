# AI 迭代图人工审核候选功能说明

本包在 `Molink-Page-v1.2-mmw-qwen-dimension-fix.zip` 的基础上增加了“保留所有迭代图片并在人工审核中展示”的功能。

## 功能变化

旧逻辑：

- 后台人工审核页只读取 `orders.ai_result_urls`。
- 这个字段只包含系统审核通过图，或尺寸修正达到上限后被放入结果集的图。
- 尺寸修正前的失败图、整批重试中的失败图、Qwen 审核异常但已经生成出来的图不会展示。

新逻辑：

- 新增 `orders.ai_iteration_records_json`。
- 每张已生成完成且拿到 URL 的 AI 图都会进入迭代记录。
- 管理后台会基于 `ai_iteration_records_json + ai_result_urls` 构建 `ai_review_candidates`。
- 人工审核画廊展示全部候选图，而不仅是最终通过图。
- 系统审核通过图默认选中；未通过图默认不选中，但管理员可以手动点选并交付。

## 记录的图片类型

包括但不限于：

- 首轮生成并通过 Qwen 审核的图
- 首轮生成但尺寸未通过的图
- 基于 Qwen 尺寸修改意见修正前/后的图
- 物理合理性未通过的图
- 画作一致性未通过的图
- Qwen 审核异常但已有图片 URL 的图
- 整批重试中产生的所有完成图
- 尺寸修正达到上限后进入人工候选的图

## 主要改动文件

- `database.js`
  - 新增字段：`ai_iteration_records_json TEXT`

- `services/aiReviewIterations.js`
  - 新增迭代图记录与人工审核候选构建工具

- `server.js`
  - Qwen 审核每处理一张完成图，都会写入迭代记录
  - 整批重试不会清空迭代记录
  - 尺寸修正中间图会保留下来

- `routes/admin.js`
  - 订单详情返回 `ai_iteration_records` 和 `ai_review_candidates`
  - 一键通过接口允许交付任意人工审核候选图

- `public/admin.html`
  - 人工审核区改为展示全部 `ai_review_candidates`
  - 每张图展示系统审核状态、原因、尺寸修正意见、轮次信息

## 兼容性

- 老订单没有 `ai_iteration_records_json` 时，会自动回退到 `ai_result_urls` 展示。
- 旧的 `ai_result_urls` 和 `ai_result_records_json` 仍保留，现有交付和统计逻辑不被破坏。
- Snaptoshine 和 MMW provider 切换逻辑不受影响。
