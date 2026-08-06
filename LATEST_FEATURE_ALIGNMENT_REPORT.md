# 最新功能代码对齐报告

生成时间：2026-05-27T06:33:51

## 对齐基线

本次对齐读取了用户上传的三份完整代码包：

1. `Molink-Page-v1.2-mmw-nano-banana-adapted.zip`
2. `Molink-Page-v1.2-mmw-qwen-dimension-fix.zip`
3. `Molink-Page-v1.2-mmw-qwen-dimension-fix-all-iterations.zip`

最终以第 3 包作为主干，因为它已经包含：
- MMW / Nano Banana provider 适配
- Qwen 尺寸审核修改建议
- 尺寸不符后提交上一张图进行修正
- 所有迭代图片进入人工审核候选池

然后补回后续应保留的安全与稳定性修复：
- Snaptoshine 新任务保护开关
- `/api/client/thumb` 中文路径 decode + 路径越界保护
- R2 中文 object key 对外 URL 编码
- 交付图片 URL 编码/历史 URL 归一化
- 本地 `/deliveries` 只在已有 R2 备份记录时才清理

## 功能对齐矩阵

```json
{
  "1_mmw_adapter": {
    "mmw_adapter": true,
    "ai_image_entry": true,
    "qwen_dimension_json": false,
    "dimension_fix_flow": false,
    "all_iterations": false,
    "admin_candidates": false,
    "snaptoshine_guard": false,
    "thumb_decode_guard": false,
    "r2_url_encoding": false,
    "delivery_safe_cleanup": false
  },
  "2_qwen_dimension_fix": {
    "mmw_adapter": true,
    "ai_image_entry": true,
    "qwen_dimension_json": true,
    "dimension_fix_flow": true,
    "all_iterations": false,
    "admin_candidates": false,
    "snaptoshine_guard": false,
    "thumb_decode_guard": false,
    "r2_url_encoding": false,
    "delivery_safe_cleanup": false
  },
  "3_all_iterations": {
    "mmw_adapter": true,
    "ai_image_entry": true,
    "qwen_dimension_json": true,
    "dimension_fix_flow": true,
    "all_iterations": true,
    "admin_candidates": true,
    "snaptoshine_guard": false,
    "thumb_decode_guard": false,
    "r2_url_encoding": false,
    "delivery_safe_cleanup": false
  },
  "final_unified": {
    "mmw_adapter": true,
    "ai_image_entry": true,
    "qwen_dimension_json": true,
    "dimension_fix_flow": true,
    "all_iterations": true,
    "admin_candidates": true,
    "snaptoshine_guard": true,
    "thumb_decode_guard": true,
    "r2_url_encoding": true,
    "delivery_safe_cleanup": true
  }
}
```

## 最终保留功能

### 1. MMW / Nano Banana provider

文件：
- `services/aiImage.js`
- `services/mmwBanana.js`

保留旧 Snaptoshine 代码，但新任务默认走 MMW。历史旧 execution id 仍可查询。

### 2. Snaptoshine 防回退保护

即使环境变量误设：

```env
AI_IMAGE_PROVIDER=snaptoshine
```

只要没有显式设置：

```env
SNAPTOSHINE_ENABLED=1
```

新任务也会自动改用 MMW，避免重新进入旧 `asset_upload`。

### 3. Qwen 尺寸审核修改意见

文件：
- `services/qwen.js`
- `server.js`

尺寸审核失败时，Qwen 输出结构化字段：
- `correction_action`
- `correction_amount`
- `fix_instruction`

后续生图修正会带上上一张失败图、Qwen 修改意见和目标作品尺寸。

### 4. 全部迭代图进入人工审核

文件：
- `services/aiReviewIterations.js`
- `server.js`
- `routes/admin.js`
- `public/admin.html`
- `database.js`

字段：
- `orders.ai_iteration_records_json`

人工审核页不再只显示最后一次或最终通过图，而是显示每一轮生成/修正图片。

### 5. 交付图缩略图与中文路径修复

文件：
- `services/thumbs.js`

修复 `/deliveries/%E7...jpg` 被当作真实文件名的问题，并保留路径越界保护。

### 6. R2 / 交付图片 URL 编码修复

文件：
- `services/r2.js`
- `services/deliveryAssets.js`

R2 object key 可以继续保留中文，但对外 URL 会按路径段安全编码，兼容小程序、浏览器和缩略图 query 参数。

### 7. 本地交付图清理策略

文件：
- `services/cleanup.js`

`uploads` 仍按 2 天清理。`deliveries` 只有数据库记录确认已有 R2 备份时，才清理本地副本。

## 推荐线上环境变量

```env
AI_IMAGE_PROVIDER=mmw
SNAPTOSHINE_ENABLED=0

MMW_API_KEY=sk-你的key
MMW_API_BASE_URL=https://api.mmw.ink
MMW_MODEL=gemini-2.5-flash-image
MMW_FALLBACK_MODELS=gemini-3.1-flash-image,[A]gemini-3-pro-image-preview
MMW_EXECUTION_COUNT=1
MMW_CONCURRENCY=1
MMW_MAX_ATTEMPTS=4
MMW_TIMEOUT_MS=180000
```

确认稳定后再恢复：

```env
MMW_EXECUTION_COUNT=5
```
