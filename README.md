# Mo:link Design

艺术空间匹配服务——上传作品或空间照片，生成艺术悬挂效果图。

## 服务类型

- **A 作品挂进家**：上传作品图和空间图，将作品挂在空间最合适的位置，同时推荐两幅风格相近的作品并呈现效果
- **B 根据空间推荐作品**：上传空间图，推荐三幅适合的作品并呈现悬挂效果
- **C 根据作品推荐空间**：上传作品图，生成三份最适合悬挂的室内设计参考

## 技术栈

Node.js + Express，部署在 Railway。前端三个 HTML 页面（index / delivery / admin），采用 Glassmorphism 玻璃态 UI 设计，含视差滚动和 iOS 风格磨砂玻璃效果。

## 项目结构

```
├── server.js                 # Express 主服务
├── nixpacks.toml             # Railway 构建配置（CJK 字体）
├── package.json
├── .env.example              # 环境变量模板
│
├── middleware/
│   └── upload.js             # multer 文件上传（用户端 20MB / 管理端 50MB）
│
├── services/
│   ├── email.js              # 腾讯云 SES 邮件通知
│   ├── sms.js                # 阿里云短信通知
│   └── textToImage.js        # 文字渲染为图片（sharp + SVG）
│
├── public/
│   ├── index.html            # 用户表单页
│   ├── delivery.html         # 交付结果页
│   ├── admin.html            # 管理后台
│   └── images/
│       ├── background.jpg        # PC 端背景
│       └── background-mobile.jpg # 移动端背景
│
└── data/
    ├── uploads/              # 用户上传图片
    └── deliveries/           # 交付图片
```

## 环境变量

### 腾讯云邮件（SES）

```env
TENCENTCLOUD_SECRET_ID=       # API 密钥 ID
TENCENTCLOUD_SECRET_KEY=      # API 密钥 Key
SES_REGION=ap-guangzhou       # 地域
SES_FROM_EMAIL=notice@mail.molink.art
SES_FROM_NAME=Molink
SES_ORDER_TEMPLATE_ID=        # 订单通知模板 ID
SES_DELIVERY_TEMPLATE_ID=     # 交付通知模板 ID
ADMIN_EMAIL=                  # 目标机操作者邮箱，逗号分隔
BASE_URL=https://molink.art
```

### 阿里云短信

```env
ALIYUN_ACCESS_KEY_ID=         # AccessKey ID
ALIYUN_ACCESS_KEY_SECRET=     # AccessKey Secret
ALIYUN_SMS_SIGN_NAME=         # 短信签名
ALIYUN_SMS_TEMPLATE_CODE=     # 短信模板 CODE
```

短信模板示例：`您的${service}已完成，请查看：https://molinkdesign.up.railway.app/delivery/${url}`

阿里云模板变量只能用于链接路径参数，域名部分需在模板中硬编码。

### 其他

```env
ADMIN_SECRET=                 # 管理后台密钥
DATA_DIR=./data               # 持久化数据目录
```

## 部署

### Railway 部署

1. 推送代码到 GitHub
2. Railway 连接仓库，自动检测 Node.js 项目
3. 在 Variables 中配置上述环境变量
4. `nixpacks.toml` 会自动安装 CJK 字体（解决文字渲染为方块的问题）

### 本地开发

```bash
npm install
cp .env.example .env    # 填写环境变量
npm run dev
```

依赖安装：

```bash
npm install express multer uuid sharp dotenv
npm install tencentcloud-sdk-nodejs-ses    # 邮件服务
npm install @alicloud/pop-core             # 短信服务
```

## 前端设计

### 视觉系统

CSS 变量控制全局风格。玻璃青色调通过 `--glass-cyan-percent` 调节（推荐 0–20，数值越大青色越明显）：

```css
:root {
  --glass-cyan-percent: 16;
}
```

品牌主色 `--color-primary: #917355`，提交按钮采用褐色半透明高硼硅玻璃质感。

### 移动端适配

针对 Chrome 移动端的字体缩放和 viewport 问题做了专项优化：输入框字号设为 `max(16px, 1em)` 以避免自动缩放，viewport 配置 `maximum-scale=1.0, user-scalable=no`。视差背景使用百分比高度继承，避免移动端浏览器地址栏收起时的背景抖动。

### 上传限制

用户端单张图片最大 20MB（支持 JPG / PNG / WebP / BMP / TIFF），前端选择文件时即时校验尺寸并弹窗提示，服务端通过 multer 做二次拦截。管理端上传限制为 50MB。

## 通知服务

### 邮件

通过腾讯云 SES 发送模板邮件。`extractPath` 函数从完整 URL 中提取不含域名和开头斜杠的路径，以适配邮件模板中硬编码域名的拼接格式。

### 短信

通过阿里云 SMS 发送模板短信。模板变量只支持路径参数（阿里云限制），域名需在模板内写死。

## 文字渲染

`textToImage.js` 使用 sharp 的 SVG 渲染能力将文字内容生成为 PNG 图片。Railway 环境需通过 `nixpacks.toml` 安装 `noto-fonts-cjk-sans` 和 `fontconfig`，SVG 中字体指定为 `Noto Sans CJK SC`。

```toml
[phases.setup]
nixPkgs = ["noto-fonts-cjk-sans", "fontconfig"]

[phases.build]
cmds = ["fc-cache -fv"]
```

## 迭代记录

- 视觉系统重构：Glassmorphism 玻璃态 + iOS 风格边缘高光 + 视差滚动
- 单变量青色调控制（`--glass-cyan-percent`），提交按钮改为褐色透明高硼硅玻璃质感
- 修复 Chrome 移动端 UI 拥挤（`text-size-adjust`、输入框字号 ≥ 16px）
- 修复移动端浏览器上滑时背景异常放大（背景高度从 `100vh` 改为百分比继承）
- 接收方式输入框全设备换行布局，修复叠边问题
- 背景图取消灰度调色，使用原图
- PC 端和移动端均添加滚动与 resize 防抖
- 集成阿里云短信服务，适配模板变量只能用于路径参数的限制
- 邮件路径变量去除开头斜杠，适配模板拼接格式
- 前端上传增加 20MB 即时校验与 Toast 弹窗提示
- 修复 Railway 环境中文字渲染为方块（安装 CJK 字体）
- 三个 HTML 页面统一色调系统
