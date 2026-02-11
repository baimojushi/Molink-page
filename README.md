# Mo:link Design 部署指南

## 项目结构

```
molink/
├── server.js                 # 主服务器入口
├── database.js               # SQLite 数据库定义
├── package.json              # 依赖配置
├── .env                      # 环境变量（需自行配置）
├── .gitignore
├── routes/
│   ├── client.js             # 用户端 API（提交订单）
│   ├── admin.js              # 管理后台 API（查看/交付订单）
│   └── delivery.js           # 交付页面路由
├── services/
│   ├── email.js              # 邮件发送（Nodemailer + SMTP）
│   ├── sms.js                # 短信发送（阿里云/占位）
│   └── textToImage.js        # 文字渲染为图片（node-canvas）
├── middleware/
│   └── upload.js             # 图片上传中间件（Multer）
├── public/
│   ├── index.html            # 用户端提交表单页面
│   ├── admin.html            # 目标机管理后台页面
│   └── delivery.html         # 交付结果查看页面
├── uploads/                  # 用户上传的原图（自动创建）
├── deliveries/               # 目标机交付的图片（自动创建）
└── data/                     # SQLite 数据库文件（自动创建）
```

## 部署方式一：Railway（推荐）

### 第1步：准备代码仓库

```bash
cd molink
git init
git add .
git commit -m "初始化 Mo:link Design 项目"
```

在 GitHub 上创建一个仓库（如 `molink`），然后：

```bash
git remote add origin https://github.com/你的用户名/molink.git
git push -u origin main
```

### 第2步：Railway 部署

1. 访问 https://railway.app，使用 GitHub 账号登录
2. 点击 **New Project → Deploy from GitHub repo**
3. 选择 `molink` 仓库
4. Railway 自动检测到 Node.js 项目并开始构建

### 第3步：配置环境变量

在 Railway 项目面板中，进入 **Variables** 标签，添加以下环境变量：

| 变量名 | 示例值 | 说明 |
|--------|--------|------|
| `PORT` | `3000` | Railway 会自动设置，可不填 |
| `BASE_URL` | `https://molink-production.up.railway.app` | 部署后 Railway 分配的域名 |
| `DATA_DIR` | `/app/persistent` | 持久化数据根目录（必填） |
| `SMTP_HOST` | `smtp.qq.com` | SMTP 服务器地址 |
| `SMTP_PORT` | `465` | SMTP 端口 |
| `SMTP_SECURE` | `true` | 是否启用 SSL |
| `SMTP_USER` | `xxx@qq.com` | 发件邮箱 |
| `SMTP_PASS` | `abcdefg` | 邮箱授权码 |
| `SMTP_FROM_NAME` | `Mo:link Design` | 发件人名称 |
| `ADMIN_EMAIL` | `admin@xxx.com` | 目标机通知邮箱（支持多个，逗号分隔）|
| `ADMIN_SECRET` | `my-secret-123` | 管理后台密钥 |

### 第4步：配置持久化存储

Railway 免费/基础计划只支持一个 Volume，我们将所有数据存在其中：

1. 在项目中点击 **+ New → Volume**
2. Mount Path 设为 `/app/persistent`
3. 这个 Volume 会自动包含数据库、上传图片、交付图片三个子目录

### 第5步：绑定自定义域名（可选）

1. 在 **Settings → Networking** 中添加自定义域名
2. 按提示配置 DNS 的 CNAME 记录
3. 更新 `BASE_URL` 环境变量为你的自定义域名

### 第6步：验证部署

- 用户端：访问 `https://你的域名/`
- 管理后台：访问 `https://你的域名/admin`

---

## 部署方式二：自有服务器（腾讯云/阿里云 + 宝塔）

### 第1步：服务器准备

```bash
# 安装 Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 canvas 依赖（用于文字转图片）
sudo apt install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

### 第2步：上传代码并安装依赖

```bash
cd /www/molink       # 或你选择的目录
npm install
```

### 第3步：配置 .env

```bash
cp .env .env.backup       # 备份模板
nano .env                 # 编辑并填写所有配置项
```

### 第4步：使用 PM2 持久化运行

```bash
npm install -g pm2
pm2 start server.js --name molink
pm2 save
pm2 startup              # 开机自启
```

### 第5步：Nginx 反向代理

在宝塔面板中添加站点，Nginx 配置：

```nginx
server {
    listen 80;
    server_name 你的域名.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

配置 SSL 证书后启用 HTTPS。

---

## 邮箱配置指南（QQ邮箱示例）

1. 登录 QQ 邮箱 → 设置 → 账户
2. 找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」
3. 开启「IMAP/SMTP 服务」
4. 按提示发送短信验证，获取**授权码**
5. 将授权码填入 `.env` 的 `SMTP_PASS`

---

## 短信服务配置指南（阿里云示例）

1. 登录阿里云控制台 → 短信服务
2. 添加短信签名（需审核，约1个工作日）
3. 添加短信模板，内容示例：`您的「${service}」已完成，查看链接：${url}`
4. 获取 AccessKey ID 和 Secret
5. 安装依赖：`npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client`
6. 取消 `services/sms.js` 中阿里云部分的注释

---

## 后续接入 Nano Banana API

在 `routes/client.js` 的订单提交流程中，预留了中间件扩展点。当 API 结构确认后：

1. 在 `services/` 下新增 `nanoBanana.js`
2. 封装登录、上传图片、获取结果的流程
3. 在 `routes/admin.js` 或直接在订单创建后自动调用
4. 将 API 返回的图片存入 `deliveries/` 目录并自动交付

---

## 迭代更新

Railway 部署：`git push` 即自动重新部署。
自有服务器：`git pull && pm2 restart molink`。
