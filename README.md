# Waiting-page customer copy v3

This revision rewrites the waiting-page progress language for customer delivery.

## What changed

- Backend progress messages are no longer displayed directly.
- The main progress title is mapped to concise customer-facing stages:
  - 正在确认您的空间照片
  - 正在读懂空间的比例与留白
  - 正在寻找作品更从容的落点
  - 正在让空间设想逐渐清晰
  - 正在收束最后的细节
  - 您的专属呈现已准备好
- Technical wording is filtered from streamed advisor copy before display.
- Notification, advisor placeholder, preference acknowledgement, and navigation title were refined.
- Internal order statuses and progress percentages remain unchanged.

## Changed files

- `molink-miniapp-auction/pages/waiting/waiting.js`
- `molink-miniapp-auction/pages/waiting/waiting.wxml`
- `molink-miniapp-auction/pages/waiting/waiting.json`
