# AI 实现交接说明（Gosslan v2.2）

> 给要接手实现开发的 AI / 工程师：
> **先读本文件，再读设计系统与对应画板；不要只看截图就重画。**
> 设计只覆盖视觉与交互规格，不改变现有业务逻辑、协议、数据库和功能范围。

---

## 0. 最短使用方式

### 情况 A：对方能访问这个仓库（推荐）

把仓库路径给它，并附上一句话：

> 请严格按 `designs/gosslan-redesign/HANDOFF.md` 实现。先读交接文档、设计系统 tokens 和对应画板，再改代码；不要新增功能，不要改协议/数据库，完成后跑 `npm run verify:full` 并截图对比。

### 情况 B：对方只能聊天上传文件

上传 `designs/gosslan-redesign-handoff.zip`，并附上同样一句话。压缩包内根目录就是 `gosslan-redesign/`，`HANDOFF.md` 在根目录。

### 情况 C：对方只能看图

至少给它：

- `screenshots/` 里的参考图（桌面/移动/边界/应用图标）；
- `docs/edge-cases.md`；
- `docs/verification-v2.md` 的验收清单；
- `brand/png/app-icon-1024.png`、`32.png`、`16.png`。

`screenshots/README.md` 已注明：截图只建立印象，不是实现规格。

**注意**：只给截图时，它容易把画板里的绝对尺寸、演示文案、假数据当成产品规格。能读文件就一定给文件。

---

## 1. 读文件的顺序

1. `HANDOFF.md`（本文件）
2. `design-system-pulse/project/tokens.json` — 颜色、字号、间距、圆角、阴影、尺寸
3. `design-system-pulse/project/README.md` — 品牌手册、组件、状态、可访问性
4. `docs/decisions.md` — 已确认的信息架构与 5 个基线决策
5. `docs/edge-cases.md` — 长文本、溢出、状态去重
6. `docs/feature-coverage.md` — 功能 → 画板覆盖矩阵
7. 具体画板 `.dc.html`（按第 4 节映射）
8. `docs/verification-v2.md` — 已做过的验证与已知限制

机器可读索引：`design-manifest.json`。

---

## 2. 硬规则（实现时必须遵守）

- **不要新增功能**。账号、云同步、语音/视频、贴纸、输入中提示、消息编辑、群管理员、会话归档等都不在范围内。详见 `docs/decisions.md`。
- **不要改 Rust / 协议 / 数据库 / IPC 契约**，除非任务明确要求；纯 UI 改版不应触碰这些。
- **不要照抄画板 DOM/CSS**。画板是 1000×680、390×844 的静态演示；实际实现要用现有 Vue 组件、路由、CSS 变量和响应式逻辑。
- **先落 tokens，再改组件**。颜色、字号、圆角、间距从 `tokens.json` / `src/style.css` 变量取值，不在组件里散写十六进制。
- **一套图标**：桌面 rail 23px、移动 tab 21px、header 20px、inline 16px；同一套 path，只改尺寸。不要桌面/移动各画一套。
- **一个状态只出现一次**：头像有在线点时，旁边不再出现第二个绿点或“在线”文字；联系人分组标题已经表达状态时，行内不再叠加文字状态。
- **长文本收束**：单行省略用 `min-width:0 + overflow:hidden + text-overflow:ellipsis`；URL/长单词用 `overflow-wrap:anywhere`；技术串用等宽字体 + `word-break:break-all`；摘要/原因最多 2 行。
- **中英双语**：所有新文案同时加到 `zh-cn` 与 `en-us`，用 `t()`；不能只加一边。
- **动效**：出现才播一次，状态切换不重播 scale，reduce 档只淡入淡出；遵守 `src/utils/receiptMotion.test.ts` 的约束。
- **不确定就问**。不要用“我觉得更好看”替换已确认的 IA、状态语义或功能范围。

---

## 3. 设计 token 落地

### 3.1 颜色 / 字体 / 圆角

| 设计值 | 实现位置 |
| --- | --- |
| 主蓝 `#2f6bff`、红 `#fa5151`、绿 `#07c160`、金 `#ffb400` | 扩展 `src/style.css` 的 CSS 变量；`primary` 仍由用户主题色覆盖 |
| 表面 `#f2f3f5 / #e9ebee / #f7f8fa / #ffffff` | 新增/映射 `--gosslan-*` 表面变量 |
| 系统字体栈 | 已有 `--gosslan-font-family`；不要引 Google Fonts |
| 字号：15/14/13/12/11 | 已有 `--gosslan-text-title/body/callout/footnote/caption`；新 UI 不写 10px |
| 圆角：6 / 10 / 16 / 20 / 22 / 999 | 新增 `--gosslan-radius-*` 或在 Tailwind 主题里加 `rounded-*` 语义档 |
| 行高：桌面 62、移动 64、设置 48 | 用 token/变量，不在每个组件硬写 |

### 3.2 现状注意

- 当前 `src/style.css` 的出厂主色是 `#3b82f6`，设计稿是 `#2f6bff`。**不要直接覆盖用户主题色变量**；把设计值作为默认主色候选，或在设计验收时明确“出厂蓝改为 #2f6bff”。
- 现有 `--gosslan-list-w` 是 250px；设计确认桌面列表默认 **320px（280–400）**。改这里会影响启动骨架 `index.html`，要同步。
- 现有 header 是 48px；设计是 **52px**。改这里要同步首屏骨架，否则首帧会跳。
- 现有 Tailwind 字号档位是 10/11/12/13/14/15px；设计要求**最小 11px**，新代码不要再使用 10px 档。

---

## 4. 画板 → 代码映射

### 4.1 主窗口 / 布局

| 设计画板 | 代码入口 | 说明 |
| --- | --- | --- |
| `DesktopChats.dc.html` | `src/layouts/ResponsiveLayout.vue`、`src/components/NavRail.vue`、`ConversationList.vue`、`TitleBar.vue` | 桌面三栏、rail、列表、空态 |
| `MobileChats.dc.html` | `ResponsiveLayout.vue`、`MobilePageFrame.vue`、`ConversationList.vue` | 移动单栏、4 tab、顶栏「+」 |
| `DesktopOneToOne.dc.html` / `DesktopGroupChat.dc.html` | `src/components/ChatWindow.vue`、`src/components/message/*` | 1:1 / 群聊、气泡、回执、引用、文件 |
| `MobileOneToOne.dc.html` / `MobileGroupChat.dc.html` | `ChatWindow.vue`、移动分支 | 移动聊天气泡、输入区 |
| `DesktopContacts.dc.html` / `MobileContacts.dc.html` | `FriendProfile.vue`、`FriendRequestList.vue`、`ResponsiveLayout` 的 contacts 分支 | 联系人、在线/离线分组、资料 |
| `DesktopRequests.dc.html` / `MobileRequests.dc.html` | `FriendRequestList.vue` | 好友申请 |
| `DesktopFavorites.dc.html` / `MobileFavorites.dc.html` | `FavoritePanel.vue` | 收藏列表/详情 |
| `DesktopLinks.dc.html` | `LinksList.vue` | 链接与导入导出 |
| `MobileMe.dc.html` | `ResponsiveLayout` me 分支、`ProfileSection.vue` | 我的 |
| `DesktopSearch.dc.html` / `MobileSearch.dc.html` | `src/components/search/ChatSearchDialog.vue` | 全局搜索 |
| `DesktopGroupInfo.dc.html` | 群资料抽屉/面板（在 `ChatWindow` 或同级组件） | 成员/文件/任务/公告 |
| `DesktopTasks.dc.html` | `TaskCenter.vue` | 传输/获取/待发送/群同步 |
| `DesktopModals.dc.html` | `AddFriendModal.vue`、`GroupCreateModal.vue`、`ImageLightbox.vue`、表情/转发/强提醒 | 浮层 |
| `DesktopDark.dc.html` / `MobileDark.dc.html` | `.dark` 主题 | 深色验证 |
| `MobileStates.dc.html` / `MobileEmpty.dc.html` | 各页空态/错误态 | 离线、失败、重试、首次空态 |

### 4.2 独立窗口

| 设计画板 | 文档 / 入口 | 根组件 | 尺寸 |
| --- | --- | --- | --- |
| `DesktopSettings.dc.html` | `settings.html` → `src/entries/settings.ts` | `SettingsWindow.vue` / `SettingsPanel.vue` | 780×600，最小 560×420 |
| `DesktopLogs.dc.html` | `logs.html` → `src/entries/logs.ts` | `LogViewer.vue` | 760×560，最小 420×320 |
| `DesktopGroupTasks.dc.html` | `todos.html` → `src/entries/todos.ts` | `GroupTodosWindow.vue` | 780×620，最小 360×420 |
| `DesktopPreviewWindow.dc.html` | `preview.html` → `src/entries/preview.ts` | `src/components/window/PreviewWindow.vue` | 1120×820，最小 480×360 |
| `DesktopStartupError.dc.html` | 启动错误页 | 现有启动错误组件 | 560×400 |
| 外链窗口 | Rust `src-tauri/src/commands/logs.rs` | 外部链接窗口 | 1000×720，无 app chrome |

窗口尺寸/最小尺寸在 `src-tauri/src/commands/logs.rs`；主窗口在 `src-tauri/tauri.conf.json`。

### 4.3 路由

- 主窗口路由：`src/router/mainRoutes.ts`（`chats / conversation / contacts / friend / requests / favorites / links / me / profile / settings / settings-section / logs / search`）。
- 设置窗口路由：`src/router/settings.ts` + `src/utils/settingsManifest.ts`。
- 移动/桌面布局归一：`ResponsiveLayout.vue` 的 `navOfRoute()` 与 `is-mobile` 判定。
- **不要把设计画板直接变成新路由**；沿用现有路由和返回栈。

### 4.4 图标

- 现状：`lucide-vue-next` + `src/components/ui/NavIcon.vue`。
- 设计：`IconSet.dc.html` + `brand/icons.svg`。实现时建议新建本地图标注册表（例如 `src/components/ui/icons/`），按名称导出同一套 path；桌面/移动/辅助窗口共用。
- 高频替换：chat / contacts / favorites / links / me / back / plus / send / search / more / attach / close / settings。
- 收藏图标改为**书签**；设置改为**两条滑杆**；调色盘图标统一为设置滑杆。
- 图标尺寸：rail 23、tab 21、header 20、inline 16；描边统一 2px（回执错误 / 群任务等强调处由调用方显式覆盖）；点击热区 ≥44px。
  （2026-11-07 收敛：`<Icon>` 不再有 `size` prop，盒尺寸只由消费方 class 决定；原「16px 时描边 1.8px」从未生效，已合并进这条。）

### 4.5 应用图标

- 母版：`brand/app-icon-light.svg`（1024 满版蓝底 + 奶油拱门 + 绿苗）。
- 平台：`app-icon-macos.svg`（22.37% 圆角）、`app-icon-ios.svg`（满版方图）、`app-icon-android.svg`（66% 安全区）、`app-icon-tinted.svg`。
- 尺寸梯：`brand/png/app-icon-16/32/64/128/256/512/1024.png`。
- Tauri 打包图标：`src-tauri/icons/`。替换 `src-tauri/icons/icon.png` 为 1024 母版后跑 `npm run icon`，会生成各平台尺寸；iOS 上架图需按 Apple 要求去掉 alpha 通道。
- 现有 `tauri.conf.json` 的 `bundle.icon` 指向 `icons/32x32.png`、`128x128.png`、`icon.icns`、`icon.ico`，生成后不要漏掉这些文件。

---

## 5. 实现顺序（建议分 6 批提交）

1. **Tokens + 骨架**：CSS 变量、Tailwind 字号/圆角、表面层级、header 52、list 320、row 62/64；同步首屏骨架。
2. **图标 + 品牌资产**：本地 Rounded 2.0 图标注册表；清理 `lucide` 混用；替换 Tauri app icons。
3. **桌面主界面**：rail、会话列表、空态、1:1、群聊、联系人、收藏、链接。
4. **移动端**：4 tab、顶栏「+」、列表、1:1、群聊、我的、设置二级页。
5. **独立窗口与复杂页面**：设置、日志、群任务、图片预览、外链、搜索、任务中心、群资料。
6. **状态/边界/验收**：长文本、99+、空/错/离线、Toast、动效、深色、reduce motion、i18n。

每一批都要独立可运行、可截图、可回滚；不要把 6 批合成一个巨大提交。

---

## 6. 验收标准

必须同时满足：

- `npm run verify:full` 通过（含中英双语测试、i18n、硬编码文案、动效守卫）。
- `npm test` 通过；如果新增组件，补对应测试。
- `npm run test:ui-runtime` 通过。
- 手动检查：
  - 1000×680、780×600、760×560、780×620、1120×820、390×844 六种尺寸不溢出；
  - 长会话名/长 URL/长文件名/IPv6 不撑破布局；
  - 头像在线点唯一，不再出现第二个绿点或“在线”文字；
  - 桌面/移动/设置/任务/日志的图标是同一套形状；
  - 中英文切换后无截断、无溢出、无未翻译；
  - 深色、reduce motion、键盘焦点、44px 热区。
- 提交前 `node scripts/check-change-budget.mjs --staged` 看变更等级，标题带对应 `[plan]` / `[impact]`。

---

## 7. 给其他 AI 的提示词模板

### 7.1 总实现提示词（推荐）

> 你是 Gosslan 的前端实现工程师。请严格按 `designs/gosslan-redesign/HANDOFF.md` 实现，不要重新设计。
>
> 先读：HANDOFF.md → `design-system-pulse/project/tokens.json` → `design-system-pulse/project/README.md` → `docs/decisions.md` → `docs/edge-cases.md` → 本次要改的画板。
>
> 约束：
> - 不新增功能；不改 Rust / 协议 / 数据库 / IPC。
> - 先落 tokens，再改组件；不照抄画板 DOM/CSS。
> - 桌面/移动/辅助窗口共用一套图标；一个状态只出现一次。
> - 长文本按 edge-cases 规则收束。
> - 新文案中英同步，用 `t()`。
> - 完成后跑 `npm run verify:full`，并给出改动的文件、关键截图、未验证项。
>
> 本次范围：`<填写：桌面会话列表 / 移动聊天 / 设置窗口 / …>`
> 对应画板：`<填写 .dc.html 文件名>`

### 7.2 只做基础层

> 只做 tokens 与骨架，不改页面结构：把 `tokens.json` 的颜色/字号/圆角/行高映射到 `src/style.css` 与 `tailwind.config.js`；同步 `index.html` 首屏骨架的 52px header / 320px list；不改业务组件。完成后跑 `npm run verify:full`，列出改动的变量和受影响的组件。

### 7.3 只做某个屏幕

> 只实现 `DesktopOneToOne.dc.html` 对应的 `ChatWindow.vue` 视觉：消息气泡、回执、引用、文件、输入区。不要改会话列表、联系人、Rust 或数据库。保持现有 props/事件/路由不变；只改样式和必要的模板结构。完成后截图对比，并说明没有改动的交互。

### 7.4 审查提示词

> 请按 `designs/gosslan-redesign/HANDOFF.md` 的硬规则审查这次改动：是否新增功能、是否照抄画板、是否绕过 tokens、是否出现重复状态、是否破坏长文本、是否只改了一端图标、是否中英不同步。只输出问题和证据，不要直接改代码。

---

## 8. 已知边界

- 画板是设计演示，不包含真实网络、加密、持久化。
- 原型输入框是单行 `<input>`；正式实现应为可增长到 5 行的 `<textarea>`，超过后内部滚动。
- 主题色设计为“只影响本机”；气泡颜色“会同步给聊天对象”。改契约前先问产品。
- 设计稿里的假数据、绝对像素、演示文案不是产品数据；不要写进数据库或 i18n 文案。
- 画板的 `$preview` 尺寸只服务预览，不是运行时窗口尺寸；运行时尺寸以 Tauri 配置和现有窗口逻辑为准。

---

## 9. 快速检查清单

- [ ] 读了 HANDOFF + tokens + decisions + edge-cases
- [ ] 没新增功能、没改 Rust/协议/DB
- [ ] 没照抄画板 DOM/CSS
- [ ] 颜色/字号/圆角走 token
- [ ] 桌面/移动/窗口图标同一套
- [ ] 在线状态只出现一次
- [ ] 长文本、99+、长 URL、长文件名已测
- [ ] 中英双语、深色、reduce motion、44px 热区
- [ ] `npm run verify:full` / `npm test` / `npm run test:ui-runtime` 通过
- [ ] 提交标题带 `[plan]` 或 `[impact]`
