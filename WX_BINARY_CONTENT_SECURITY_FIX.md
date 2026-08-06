# Molink 微信图片内容安全：二进制直传修复

## 根因结论

最新日志中出现的 `media_proxy.request` 全部来自：

```text
Mozilla/5.0 (compatible; MicroMessenger; MolinkContentSecurityPreflight/2.0)
```

这是应用自身的公网预检，不是微信审核服务的下载请求。

在 `media_check.submit.response` 返回 `trace_id` 后，服务端没有收到任何新的图片 GET，随后微信直接回调 `errcode=-1008`。因此故障发生在微信异步 URL 下载器到达应用 HTTP 层之前。继续更换 R2 对象、代理 URL、JPEG/PNG 或重试次数无法消除这一类故障。

## 本补丁的处理方式

默认审核模式改为：

```text
本地生成 <= 900KB 的基线 JPEG
→ 服务端读取图片二进制
→ multipart/form-data 上传到微信 img_sec_check
→ 同步获得 pass / reject
→ 不再向微信提交 media_url
→ 不再依赖 R2、Cloudflare、DNS、TLS、URL 长度或远程下载
```

原 `mediaCheckAsync` 异步 URL 链路仍保留，可通过环境变量显式启用，但不再作为默认路径。

## 默认环境变量

```bash
WX_IMAGE_SECURITY_MODE=binary
WX_IMG_SEC_CHECK_MAX_BYTES=1048576
WX_IMG_SEC_CHECK_TARGET_BYTES=921600
WX_IMG_SEC_CHECK_TIMEOUT_MS=20000
```

不要把 `WX_IMAGE_SECURITY_MODE` 设置为 `async_url`，否则会重新走当前持续返回 `-1008` 的远程下载链路。

## 部署

```bash
npm install
npm run content-security:smoke
npm start
```

## 预期日志

成功时应看到：

```text
audit_image.ready_for_binary_check
review.task.submit_binary
image_check.submit.request
image_check.submit.response
review.task.completed_binary
review.passed_binary
```

不应再出现：

```text
media_check.submit.request
wxa_media_check ... errcode=-1008
review.download_retry_submit
```

## 结果处理

- 微信返回 `errcode=0`：立即标记审核通过，并启动后续处理。
- 微信返回 `errcode=87014`：标记为内容违规并终止后续处理。
- 其他非零错误：标记为技术异常，不再错误地继续启动 AI 处理。
