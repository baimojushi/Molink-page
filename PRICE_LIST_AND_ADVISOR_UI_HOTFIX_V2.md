# V2 部署要点

## 跨账号切换（域名保持 `https://www.molink.art`）

1. 服务端设置同一组新账号凭据：`WX_APPID`、`WX_SECRET`。登录、内容安全、订阅通知和小程序码生成已统一读取这组变量。
2. 本地导入微信开发者工具前运行：`WX_APPID=wx你的新AppID npm run miniapp:switch-account`。
3. 新账号后台把 `https://www.molink.art` 配置为 request/uploadFile/downloadFile 业务域名，并配置隐私保护指引中的“模糊位置信息”。域名本身无需改代码。

## 模糊定位

- `app.json` 已声明 `getFuzzyLocation` 与 `scope.userFuzzyLocation`。
- 基础库低于 2.25.0、用户拒绝授权或账号尚未开通接口时，选择页自动回退手动选择，并提供“演示：定位到这里”。
- 展览需填写 `geo_lat`、`geo_lng`、`geo_radius_m` 才能被真实围栏命中。

## 作品空间效果图

- 后台作品资料必须先有作品原图和真实尺寸。
- 点击“AI 生成空间效果图”后：生成空墙空间 → GPU 精确尺寸挂画 → 上传为主效果图 → 尝试生成/复用小程序码。
- 相关服务配置沿用 `AI_IMAGE_PROVIDER`、对应生图供应商密钥、GPU worker 和 R2 配置。
