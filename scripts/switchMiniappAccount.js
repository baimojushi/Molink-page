const fs = require('fs');
const path = require('path');

const appid = String(process.env.WX_APPID || process.env.MINIAPP_AUCTION_APPID || '').trim();
if (!/^wx[a-zA-Z0-9]{16}$/.test(appid)) {
  console.error('请设置有效的 WX_APPID（例如：WX_APPID=wx... npm run miniapp:switch-account）');
  process.exit(1);
}

const configPath = path.join(__dirname, '..', 'molink-miniapp-auction', 'project.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.appid = appid;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`小程序开发者工具 AppID 已切换为 ${appid.slice(0, 6)}***${appid.slice(-4)}；业务域名保持不变。`);
