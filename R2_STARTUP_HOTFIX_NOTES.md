# R2 startup hotfix

修复 Railway 启动时报错 `ReferenceError: encodeObjectKeyForUrl is not defined`。

原因：上一轮 R2 中文 URL 编码修复合并时，`services/r2.js` 的 `module.exports` 导出了 `encodeObjectKeyForUrl`，但函数定义漏写，Node 在加载模块时直接崩溃。

本包补齐：

- `services/r2.js`：定义并导出 `encodeObjectKeyForUrl`，`getPublicUrl()` 输出按路径段编码的 R2 URL。
- `services/thumbs.js`：修复 `/uploads`、`/deliveries` 中文 URL 解码，并保留目录越界保护。
- `services/deliveryAssets.js`：规范交付图 URL 编码，兼容历史未编码 URL。
- `services/cleanup.js`：本地 deliveries 仅在确认已有 R2 备份时清理。
- `services/aiImage.js`：保留 Snaptoshine 代码，但默认阻止新任务误回退到旧 provider。
