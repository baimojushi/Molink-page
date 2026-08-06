# 第四阶段交付说明

- `buildThinking()` 只向等待页下发 `suggest_dark_wallpaper`、安全归一化后的 `suggested_wall_tone_rgb` 和建议文案。
- 小程序仅在用户选中且服务端建议成立的候选墙卡片内显示深色墙建议，默认勾选并允许取消，同时展示建议色色块。
- 勾选状态本阶段仅用于建议准确性和交互验证，不进入 `wall-preferences` 持久化，也不会生成 `wallpaper_recolor`。
- 服务端 opt-in 校验、数据库字段、非主墙合并渲染和主推荐墙补渲染均留在第五阶段。
