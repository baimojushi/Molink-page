# 微信内容安全审核 -1008 下载错误修复

## 修复内容

原实现把审核压缩图存放在应用实例本地目录，再提交 `https://www.molink.art/uploads/_content_review/...` 给微信。多实例、临时磁盘、重启或静态目录不一致时，微信会回调 `errcode=-1008`。

本补丁完成以下改造：

1. 审核图默认上传到现有 Cloudflare R2。
2. 每次生成唯一 R2 对象地址，避免缓存或覆盖。
3. 调微信前执行公网 GET 预检，校验 HTTP 200、图片 Content-Type、字节数和 SHA-256。
4. 微信回调 `-1008` 时自动重新发布并提交一次。
5. 旧 trace 标记为 inactive，不再阻塞新 trace 的通过判定。
6. 重试失败仍按技术异常处理，不误判为图片违规。

## 必须确认的现有环境变量

```bash
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_ACCOUNT_ID=...
R2_BUCKET=artworks
R2_PUBLIC_BASE_URL=https://你的公开R2域名
```

`R2_PUBLIC_BASE_URL` 必须是无需登录、无需签名、可直接 GET 图片的公开 HTTPS 地址。

## 新增可选变量

```bash
CONTENT_REVIEW_MEDIA_STORAGE=r2
CONTENT_REVIEW_PUBLIC_PREFLIGHT=1
CONTENT_REVIEW_PREFLIGHT_ATTEMPTS=3
CONTENT_REVIEW_PREFLIGHT_TIMEOUT_MS=12000
CONTENT_REVIEW_DOWNLOAD_RETRY_MAX=1
CONTENT_REVIEW_R2_PREFIX=_content_review
```

生产环境不建议开启本地降级。只有单实例、持久卷和公网静态路径完全一致时才设置：

```bash
CONTENT_REVIEW_ALLOW_LOCAL_FALLBACK=1
```

## 部署与验证

```bash
npm install
npm run content-security:smoke
npm start
```

健康检查：

```text
GET /api/client/wx-media-check-callback-health
```

应看到：

```json
{
  "review_media": {
    "storage_mode": "r2",
    "r2_configured": true,
    "public_preflight": true
  }
}
```

正常日志顺序：

```text
audit_image.generated
audit_image.published
media_check.submit.request
review.task.submitted
```

`audit_image.published` 中应满足：

```text
storage=r2
public_preflight.ok=true
```
