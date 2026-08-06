# MMW / Nano Banana 生图适配热修复说明

## 这次日志的含义

你贴出来的错误：

```txt
MMW API 返回错误 HTTP 500: upstream error: do request failed
```

说明请求已经到达 MMW 中转服务，但 MMW 访问其上游模型时失败。它不是 Qwen 审核失败，也不是订单状态机没跑通。

## 本版本修复点

- 新增 `services/mmwBanana.js`
- 新增统一入口 `services/aiImage.js`
- 业务侧从直接引用 `services/snaptoshine.js` 改成引用 `services/aiImage.js`
- 保留 `services/snaptoshine.js`，可通过环境变量随时回切
- MMW 任务仍然是“本地异步队列 + 轮询”，不阻塞用户下单接口
- 遇到 `HTTP 500 / upstream error / do_request_failed` 自动重试
- 第 2 次开始自动切换 `MMW_FALLBACK_MODELS` 中的备用模型，避免一直撞同一个失败上游
- 支持 MMW 返回：
  - `data:image/png;base64,...`
  - Markdown 图片 `![](data:image/png;base64,...)`
  - 纯 base64 图片
  - 递归 JSON 字段里的 `b64_json/base64/inlineData.data`
  - 图片 URL

## 推荐线上环境变量

```env
AI_IMAGE_PROVIDER=mmw
MMW_API_KEY=sk-你的key
MMW_API_BASE_URL=https://api.mmw.ink

# 主模型。若 3.1 上游不稳，可临时换成 gemini-2.5-flash-image。
MMW_MODEL=gemini-3.1-flash-image

# 备用模型，多个用英文逗号分隔。
MMW_FALLBACK_MODELS=gemini-2.5-flash-image,[A]gemini-3-pro-image-preview

MMW_ASPECT_RATIO=1:1
MMW_IMAGE_SIZE=1K
MMW_EXECUTION_COUNT=5
MMW_CONCURRENCY=1
MMW_MAX_ATTEMPTS=4
MMW_TIMEOUT_MS=180000
MMW_REQUEST_MODE=openai
```

## 线上快速止血建议

如果继续出现 `do_request_failed`，先用低并发单张测试：

```env
MMW_MODEL=gemini-2.5-flash-image
MMW_FALLBACK_MODELS=[A]gemini-3-pro-image-preview
MMW_EXECUTION_COUNT=1
MMW_CONCURRENCY=1
MMW_MAX_ATTEMPTS=4
```

确认一单能出图后，再把 `MMW_EXECUTION_COUNT` 恢复到 5。

## 回切旧 Snaptoshine

```env
AI_IMAGE_PROVIDER=snaptoshine
```

旧任务兼容规则：

- `mmw_` 开头的任务仍由 MMW 适配器查询
- 非 `mmw_` 的旧 execution id 仍由 Snaptoshine 查询

## 2026-05 尺寸审核反馈修正升级

本版本进一步升级了尺寸不符后的自动修正逻辑：

1. `services/qwen.js` 的 `reviewDimensions()` 不再只要求 Qwen 回答“通过/不通过”，而是要求输出结构化 JSON：
   - `pass`
   - `reason`
   - `correction_action`: `none | enlarge | shrink`
   - `correction_amount`
   - `fix_instruction`

2. `server.js` 在 Qwen 尺寸审核失败时，不再只盲目重画，而是提交：
   - 上一次尺寸审核未通过的效果图
   - 原始作品参考图（如果订单里有）
   - Qwen 给出的尺寸审核原因
   - Qwen 给出的放大/缩小建议
   - 目标作品尺寸信息

3. 生图模型收到的是局部修正指令，要求：
   - 只缩小或放大墙上作品/画框
   - 不改变房间结构、家具、灯光、视角和整体构图
   - 不替换画作内容

4. 每次尺寸修正的 Qwen 原始输出和修改意见会写入 `ai_generation_plan_json` 的 `dimension_fix` 字段，方便后续排查。

