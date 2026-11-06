# 可直接复制的 AI 提示词

> 配套 `HANDOFF.md` 使用。把 `{{...}}` 替换成实际任务。建议一次只发一批，不要把所有页面塞给一个 AI 一次做完。

## 1. 总入口（先发这个）

```text
你是 Gosslan 的前端实现工程师。请严格按 designs/gosslan-redesign/HANDOFF.md 实现，不要重新设计。

先读：
1) designs/gosslan-redesign/HANDOFF.md
2) designs/gosslan-redesign/design-system-pulse/project/tokens.json
3) designs/gosslan-redesign/design-system-pulse/project/README.md
4) designs/gosslan-redesign/docs/decisions.md
5) designs/gosslan-redesign/docs/edge-cases.md
6) designs/gosslan-redesign/docs/feature-coverage.md

硬约束：
- 不新增功能；不改 Rust / 协议 / 数据库 / IPC。
- 先落 tokens，再改组件；不照抄画板的 DOM/CSS。
- 桌面、移动端、设置/任务/日志/预览等窗口共用同一套图标；只改尺寸。
- 一个状态只出现一次：头像有在线点时，旁边不再出现第二个绿点或“在线”文字。
- 长文本按 docs/edge-cases.md 收束：单行省略、两行截断、URL 任意断行、技术串等宽断行。
- 新文案中英同步，用 t()。
- 完成后跑 npm test、npm run test:ui-runtime、npm run verify:full，并列出改动文件、关键截图、未验证项。

本次范围：{{桌面会话列表 / 移动聊天 / 设置窗口 / ...}}
对应画板：{{design-canvas-pulse/project/....dc.html}}
```

## 2. 只做基础层（第一批）

```text
只做设计 tokens 与骨架，不改页面结构：
- 把 designs/gosslan-redesign/design-system-pulse/project/tokens.json 的颜色、字号、圆角、行高、尺寸映射到 src/style.css 与 tailwind.config.js。
- 同步 index.html 首屏骨架：header 52px、desktop list 320px、row 62/64px；注意设置/日志/任务/预览窗口的骨架也要同步。
- 不要改业务组件、Rust、协议、数据库。
- 完成后跑 npm run verify:full；列出新增/修改的 CSS 变量、受影响的组件、未同步的地方。
```

## 3. 桌面主聊天（第二批）

```text
只实现桌面主界面视觉：

画板：
- designs/gosslan-redesign/design-canvas-pulse/project/DesktopChats.dc.html
- DesktopOneToOne.dc.html
- DesktopGroupChat.dc.html

代码范围：
- src/layouts/ResponsiveLayout.vue
- src/components/NavRail.vue
- src/components/TitleBar.vue
- src/components/ConversationList.vue
- src/components/ChatWindow.vue
- src/components/message/*

要求：
- 不改变现有 props/事件/路由/状态管理；只改样式和必要的模板结构。
- 行高 62px、头像 42px、header 52px；列表 320px 可调 280–400。
- 自己气泡纯蓝 #2f6bff；对方 #f2f3f5；气泡 20px 圆角，连接角 6px。
- 一个在线状态只出现一次；联系人/会话行不要重复点 + 文字。
- 长 URL、长文件名、长群名按 edge-cases 处理。
- 完成后截图 1000×680，并给出改动文件与测试结果。
```

## 4. 移动端（第三批）

```text
只实现移动端视觉：

画板：
- MobileChats.dc.html
- MobileOneToOne.dc.html
- MobileGroupChat.dc.html
- MobileContacts.dc.html
- MobileMe.dc.html

代码范围：
- src/layouts/ResponsiveLayout.vue（is-mobile 分支）
- src/components/MobilePageFrame.vue
- src/components/ConversationList.vue
- src/components/ChatWindow.vue
- src/components/message/*

要求：
- 390×844；顶栏 52、底栏 56、行高 64、头像 42。
- 移动端顶栏「+」，不要 FAB。
- 会话列表头像点唯一；联系人按分组标题表达在线/离线，行内不再叠加状态文字。
- 输入区随键盘上移；长草稿最多 5 行后内部滚动（如当前实现是单行，先保持行为，只改视觉，并在报告里说明）。
- 完成后截图 390×844，并跑 verify。
```

## 5. 独立窗口（第四批）

```text
只实现独立窗口视觉：

- 设置：settings.html + src/entries/settings.ts + SettingsWindow.vue / SettingsPanel.vue
- 日志：logs.html + src/entries/logs.ts + LogViewer.vue
- 群任务：todos.html + src/entries/todos.ts + GroupTodosWindow.vue
- 图片预览：preview.html + src/entries/preview.ts + PreviewWindow.vue
- 外链：1000×720 窗口（不要 app chrome）

要求：
- 不改窗口创建逻辑与尺寸；只改内部视觉。
- 设置：780×600，16px 分组卡片、48px 行、9 分区；长值截断。
- 日志：760×560，级别/时间/消息列对齐，长消息换行。
- 群任务：780×620，看板/列表 + 详情，长标题省略。
- 预览：1120×820，深色工具栏、缩略图、保存/定位。
- 完成后分别截图，并跑 verify。
```

## 6. 状态与边界（第五批）

```text
只做状态、边界与细节，不改布局大结构：

画板：
- MobileStates.dc.html
- MobileEmpty.dc.html
- DesktopEdgeCases.dc.html
- MobileEdgeCases.dc.html
- DesktopModals.dc.html

要求：
- 一个状态只出现一次；在线/离线/未读/置顶/静音/传输不叠加两个槽位。
- 长名称、长预览、99+、长 URL、长文件名、IPv6、安全码、Toast、长草稿全部按 edge-cases。
- 空态/错误/离线/重试/传输暂停与失败状态齐全。
- 不丢输入；错误就地显示并带重试。
- 完成后用 200 字长文本、长 URL、99+ 做真实注入测试，记录 scrollWidth/clientWidth。
```

## 7. 图标与应用图标（可并到第二批）

```text
只做图标与应用图标：

- 界面图标：按 IconSet.dc.html 与 brand/icons.svg 建本地图标注册表；桌面/移动/窗口共用一套 path，尺寸 rail 23 / tab 21 / header 20 / inline 16；16px 描边 1.8；点击热区 ≥44。
- 收藏改书签，设置改两条滑杆；清理 lucide 混用。
- 应用图标：用 brand/app-icon-light.svg（或 png/app-icon-1024.png）替换 src-tauri/icons/icon.png 后跑 npm run icon，生成 icns/ico/各尺寸；iOS 上架图需去 alpha。
- 不改业务逻辑；完成后列出替换的图标、生成的文件、未替换的旧图标。
```

## 8. 代码审查（最后发）

```text
请按 designs/gosslan-redesign/HANDOFF.md 的硬规则审查这次改动：
- 是否新增功能或改 Rust/协议/DB；
- 是否照抄画板 DOM/CSS、是否绕过 tokens；
- 是否出现重复状态（头像点 + 第二个点/文字）；
- 是否破坏长文本、窄窗、深色、reduce motion；
- 是否只改了一端图标；
- 是否中英不同步、是否新增硬编码中文。

只输出问题、证据（文件/行号/截图）和修复建议，不要直接改代码。
```
