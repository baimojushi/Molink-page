# Framer 导入指南

## 设计理念

Mo:link Design 的前端代码遵循 Framer 友好的架构模式：

1. **CSS 变量集中管理** - 所有颜色、尺寸、动画参数都定义在 `:root` 中
2. **模块化状态管理** - JavaScript 状态集中在 `状态` 对象中
3. **声明式动画参数** - 使用 Framer Motion 风格的命名（duration, easing）
4. **语义化类名** - 所有 class 名称清晰表达用途

## 将 index.html 导入 Framer 的方案

### 方案一：作为 Code Component 嵌入

```jsx
// 在 Framer 中创建 Code Component
export default function MolinkForm(props) {
  return (
    <iframe
      src="https://你的域名.railway.app"
      style={{
        width: "100%",
        height: "100vh",
        border: "none"
      }}
    />
  )
}
```

### 方案二：拆解为 Framer Motion 组件

将 `index.html` 的结构和动画转换为 React + Framer Motion：

```jsx
import { motion } from "framer-motion"
import { useState } from "react"

export default function ServiceSelector() {
  const [selectedService, setSelectedService] = useState(null)

  return (
    <motion.div
      initial={{ opacity: 0, y: -40 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
    >
      {/* 服务选择按钮组 */}
    </motion.div>
  )
}
```

### 方案三：直接复用 CSS 动画

Framer 支持自定义 CSS，可以直接将 `index.html` 的 `<style>` 标签内容复制到 Framer 项目的 Custom CSS 中。

## 动画参数映射表

| CSS 变量 | Framer Motion 等价写法 |
|----------|----------------------|
| `var(--duration-fast)` | `transition={{ duration: 0.2 }}` |
| `var(--duration-normal)` | `transition={{ duration: 0.3 }}` |
| `var(--duration-slow)` | `transition={{ duration: 0.5 }}` |
| `var(--easing-standard)` | `ease: [0.4, 0, 0.2, 1]` |
| `var(--easing-enter)` | `ease: [0, 0, 0.2, 1]` |
| `var(--slide-distance)` | `y: -40` (负值向上) |

## 渐进式动画实现示例

```jsx
const sections = [
  { id: 'service', visible: true },
  { id: 'upload', visible: showUpload },
  { id: 'receive', visible: showReceive },
  { id: 'extra', visible: showExtra }
]

return (
  <>
    {sections.map(section => (
      <motion.div
        key={section.id}
        initial={{ opacity: 0, y: -40, maxHeight: 0 }}
        animate={{
          opacity: section.visible ? 1 : 0,
          y: section.visible ? 0 : -40,
          maxHeight: section.visible ? 2000 : 0
        }}
        transition={{
          duration: 0.5,
          ease: [0.4, 0, 0.2, 1]
        }}
        onAnimationComplete={() => {
          // 自动滚动到视野内
          if (section.visible) {
            ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          }
        }}
      >
        {/* 区域内容 */}
      </motion.div>
    ))}
  </>
)
```

## 颜色主题快速调整

所有颜色都集中在 CSS `:root` 中，修改即可全局生效：

```css
:root {
  /* 主色系 */
  --color-primary: #6b4c3b;        /* 改这里即可全局换色 */
  --color-accent: #7a9e7e;
  
  /* 更多颜色变量... */
}
```

在 Framer 中可以通过 Variables 面板绑定这些颜色值，实现可视化主题编辑。

## 上传区底图设置

在 `.upload-box` 类中取消注释并设置背景图：

```css
.upload-box {
  /* 取消注释以启用底图 */
  background-image: url('/path/to/placeholder-artwork.png');
  background-size: cover;
  background-position: center;
}
```

或者为不同上传区设置不同底图：

```css
.upload-box[data-placeholder="artwork"] {
  background-image: url('/images/artwork-placeholder.png');
}

.upload-box[data-placeholder="space"] {
  background-image: url('/images/space-placeholder.png');
}
```

## 注意事项

1. **CRLF 换行符**：所有文件已使用 Windows 格式（CRLF），确保跨平台兼容
2. **无 emoji**：严格遵循 Apple 设计规范，所有图标使用字母或符号
3. **渐进式渲染**：每个区域在前置条件满足后自动滑出显示
4. **自动滚动**：新区域出现时自动调整视口，确保用户始终看到当前交互区

## 性能优化建议

- 图片上传预览使用 `URL.createObjectURL()` 实现即时显示
- 所有动画使用 CSS `transition` 而非 JavaScript，性能更佳
- 状态检查函数设计为纯函数，可安全地频繁调用
- 使用 `will-change` 提示浏览器优化动画性能（如需要）
