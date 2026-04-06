Changed files:
- database.js
- routes/client.js
- services/wxNotify.js
- molink-miniapp-auction/app.js
- molink-miniapp-auction/pages/index/index.js
- molink-miniapp-auction/pages/upload/upload.js
- molink-miniapp-auction/pages/history/history.js
- molink-miniapp-auction/pages/result/result.js

Summary:
- Added user_devices binding table for WeChat-openid-to-device relationships.
- Made WeChat identity take precedence over device-only history queries.
- Bound current device during wx-login and backfilled existing device orders with openid.
- Added subscription message request on order submit.
- Added backend WeChat subscribe-message sender using template ID WBedF813hIJYRHpG0Gki9vU40Z3EoaKDmrXVC8lD4sY.
