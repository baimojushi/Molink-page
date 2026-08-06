# 微信内容安全 -1008 第二阶段修复

## 本次修复为什么不同

日志证明 R2 图片从应用服务器访问正常，但微信仍返回 `-1008`。此前重试时 SHA-256
完全相同，只换了对象 Key，因此没有改变抓取链路和图片编码。

本版本同时更换两层：

1. 微信不再直接抓取 `assets.molink.art`，改抓主站短时 HMAC 签名代理。
2. 首次图片使用非 progressive、非 mozjpeg 的基线 JPEG。
3. 首次仍 `-1008` 时，自动生成 1280px 以内 PNG 再提交，而不是重复 JPEG。
4. 代理支持 GET、HEAD、单段 Range，并固定返回 Content-Length。
5. 每次代理访问记录 `media_proxy.request` 和 `media_proxy.response`。

## 建议环境变量

```bash
CONTENT_REVIEW_MEDIA_SIGNING_SECRET=至少32字节随机字符串
CONTENT_REVIEW_MEDIA_DELIVERY=relay
CONTENT_REVIEW_RELAY_BASE_URL=https://www.molink.art
CONTENT_REVIEW_RELAY_TTL_SECONDS=7200
CONTENT_REVIEW_DOWNLOAD_RETRY_MAX=1
```

所有实例必须使用相同的签名密钥与 R2 凭据。

若主站经过 CDN/WAF，且部署后微信提交期间完全看不到 `media_proxy.request`，请把
`CONTENT_REVIEW_RELAY_BASE_URL` 改为可公网直连的应用原始域名。

## 部署后检查

健康接口：

```text
GET /api/client/wx-media-check-callback-health
```

应看到：

```json
{
  "review_media": {
    "storage_mode": "r2",
    "delivery_mode": "relay",
    "relay_signing_secret_configured": true
  }
}
```

首次任务应包含：

```text
audit_profile=wxcheck_v3_baseline_jpeg
delivery=relay
```

若自动重试，应包含：

```text
audit_profile=wxcheck_v3_png_fallback
content_type=image/png
```

判断方式：

- 微信提交后出现 `media_proxy.response` 200：微信已到达代理。
- 微信提交后完全没有代理日志：DNS、CDN、WAF 或防火墙仍阻止微信抓取。
- 代理返回 403：多实例签名密钥不一致。
- 代理返回 404：R2 读取失败或实例 R2 配置不一致。
