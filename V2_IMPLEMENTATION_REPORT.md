# V2 实施记录

## 已完成

- 使用 `wx.getFuzzyLocation` 自动识别展览，基础库能力检测、授权失败回退、真实地理围栏和无权限演示定位均已接通。
- 小程序权限声明改为 `getFuzzyLocation` / `scope.userFuzzyLocation`。
- 小程序码按当前展览导出；ZIP 名包含展览名称，每张码的文件名为“作品名称-作品编号-小程序码.png”；增加生成中状态和错误清单。
- 作品管理新增“AI 生成空间效果图”：空墙空间生成、GPU 真实尺寸挂画、自动上传主效果图、自动尝试生成小程序码、再次生成替换旧图。
- 微信登录、内容安全、通知和小程序码统一读取同一组账号凭据；新增账号切换脚本，业务域名保持不变。

## 验证

- Node.js 语法检查：通过。
- `package.json`、小程序 `app.json` JSON 解析：通过。
- 后台页面内联 JavaScript 解析：通过。
- 原有展览 smoke 在当前 Node 24 沙箱中无法执行：项目锁定的 `better-sqlite3@9` 没有 Node 24 预编译包，沙箱文件系统又阻止 node-gyp 解包时执行 `fchown`。生产要求 Node 18，与项目 `engines` 一致；应在 Node 18 部署环境运行 `npm run exhibitions:smoke`。
