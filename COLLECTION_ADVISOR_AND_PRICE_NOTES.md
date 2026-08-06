# 收藏顾问与作品价格功能说明

本版本在当前基线源码上增加：

- 作品管理：新增可选的 `price` 文本字段，不预设币种或单位，前端按填写原样展示。
- 展览管理：新增可选的收藏顾问名称与微信号。
- 小程序作品列表：有价格时，在每行右下角以小字显示。
- 小程序等待页与交付页：有收藏顾问信息时，在窗口底部显示磨砂玻璃浮窗；有微信号时提供一键复制图标按钮。
- 数据库升级：服务启动时自动为现有 SQLite 表补充字段，无需单独执行迁移命令。

新增数据库列：

```text
artworks.price TEXT
exhibitions.collection_advisor_name TEXT
exhibitions.collection_advisor_wechat TEXT
```

部署后执行：

```bash
npm install
npm start
```

建议在微信开发者工具与真机上重点检查：作品列表长价格文本截断、底部安全区、微信号复制提示、等待页与交付页滚动内容不被浮窗遮挡。
