# Pulse 界面重构：范围地图、六段边界与第一段落地记录

基线：`origin/main`（`9f1e3bd2`） · 分支 `feat/ui-pulse-redesign` · worktree `/Users/wendongfu/Documents/code/gosslan-redesign`
设计源：`designs/gosslan-redesign/`（画板 `design-canvas-pulse/project/*.dc.html`，token `design-system-pulse/project/tokens.json`）

## 1. 画板清单与范围地图（44 块）

| 组 | 画板 | 覆盖界面 / 状态 | 主要落点 | 段 |
|---|---|---|---|---|
| 基础 | Foundations、Layout | 色/字/动效、52/320/62/64、响应式断点 | style.css、tailwind、skeleton、ResponsiveLayout | 1 |
| 品牌 | IconSet、AppIcon、BrandMascot | 图标 family、应用图标、字标 | icons/navIcons、src-tauri/icons | 2 |
| 桌面主界面 | DesktopChats、DesktopOneToOne、DesktopGroupChat、DesktopDiscover、DesktopPersonalize | 会话/1:1/群聊空态与实态、加好友整页、主题个性化 | ResponsiveLayout、ChatWindow、ChatHeader、MessageComposer、MessageItem、ConversationList | 3 |
| 桌面副区 | DesktopContacts、DesktopFavorites、DesktopLinks、DesktopSearch、DesktopRequests、DesktopShare、DesktopTasks、DesktopGroupInfo、PulseGapClosures | 通讯录/收藏/链接/全局搜索/请求冷却/共享目录/任务中心/群资料/多选与回执等闭环 | 对应面板组件 + search、favorites、requests | 3 / 6 |
| 独立窗口 | DesktopSettings、DesktopLogs、DesktopGroupTasks、DesktopPreviewWindow、DesktopStartupError、DesktopModals | 设置窗、日志窗、群任务窗、图片预览窗、启动错误窗、浮层族 | SettingsWindow/SettingsPanel、LogViewer、GroupTasksBoard、PreviewWindow、startup-error.html、全局 overlay | 5 |
| 移动 | MobileChats、MobileOneToOne、MobileGroupChat、MobileContacts、MobileDiscover、MobileFavorites、MobileFriend、MobileMe、MobileRequests、MobileSearch、MobileSettings、MobileSettingsSection、MobilePersonalize、MobileEmpty、MobileStates、MobileDark | 移动五个 Tab、单聊/群聊、搜索、设置、空态/失败态、暗色 | MobileShell、mobile 列表/头部/TabBar | 4 |
| 边界 | DesktopEdgeCases、MobileEdgeCases、DesktopDark | 长文本/溢出/离线/暗色 | 消息气泡、列表、Toast | 6 |
| 交互 | PrototypeDesktop、PrototypeMobile | 点击路径与动效节奏 | 各段复用 | 3/4 |

### 画板交叉与冲突

- **重复呈现**：空态在 DesktopChats / DesktopPersonalize / MobileEmpty 三块画板各画一次；失败态在 DesktopDark / MobileStates / StartupError 各一次。施工时只允许存在一份 `StateBlock`（stage 6 收敛），画板差异只用参数表达。
- **同文件多段**：`ResponsiveLayout.vue` 与 `style.css` 会被 1、3、4 段同时碰。规则：第 1 段只改**几何常量与 token 值**；第 3/4 段只改**模板与消费方式**，不得回改 token 值（需要微调时单独一笔 token 提交，注明段号）。
- **与 `feat/code-fold`（`0c844e27`）冲突**：该线正在改 `MessageCodeBubble.vue`、`CodeBlock.vue`、`previewMetrics.ts`、`MessageItem.vue`。第 1、2 段不碰；第 3 段的“实底气泡/代码块”若必须动 `MessageItem.vue` 或 `previewMetrics.ts`，暂停并向你报，不自行合并或改写。
- **独立窗口**：`settings/logs/preview/startup-error/todos.html` 只是挂载壳，无自有图标；图标统一不影响它们，除非要改窗口标题栏图标（第 2 段）。

## 2. 六段提交边界

1. **tokens + 骨架**：`style.css`（取值）、`tailwind.config.js`、`src/boot/skeleton.css`、`index.html` 首屏注释、`ResponsiveLayout.vue`（列表宽常量 280~400/默认 320）、`ConversationListItem.vue`（行高 62/64）、对账锚点（`tokenContrast.test.ts`、`designGuards.ts/.test.ts`、`chatStyle.ts`）。
2. **图标 + 应用图标**：`components/ui/icons.ts`、`navIcons.ts`、`NavIcon.vue`、57 个 lucide 引用文件的**引用方式**（不顺手改布局）、3 处内联 `<svg>`（TitleBar/GroupTasksBoard/BubbleTail）、`src-tauri/icons/*` 由 `npm run icon` 重生成。不含 Rust。
3. **桌面主界面**：ResponsiveLayout 桌面模板、ChatWindow/ChatHeader/Composer/MessageItem 的**呈现**、列表项、空态接线。
4. **移动端**：MobileShell、移动头部/TabBar/列表、Mobile* 画板状态。
5. **独立窗口**：SettingsWindow、LogViewer、GroupTasksBoard、PreviewWindow、StartupError、浮层。
6. **状态/边界/i18n/验收**：StateBlock 收敛、长文本/溢出、i18n 中英同步、`verify:full` 收口。

每段单独提交、单独可回滚；段间不混改。第 1 段完成即报，等你确认再开第 2 段。

## 3. tokens 取值对照（本段已落地）

### 尺寸 / 形状

| token | 改前 | 改后 | 依据 |
|---|---|---|---|
| `--gosslan-header-h` | 48px（另有一处 44px 死值） | **52px** | DesktopChats 头部 52 |
| `--gosslan-list-w` | 250px，拖拽 200~420 | **320px**，拖拽 **280~400** | DesktopChats 列表 320 |
| `--gosslan-row-h-desktop` / `-mobile` | 无（组件写死 64） | **62px / 64px** | DesktopChats / MobileChats |
| `--gosslan-radius-xs/sm/md/lg` | 4/6/8/12 | **6/8/10/14** | tokens.json radius |
| `--gosslan-avatar-radius` | 6px | **9999px** | 头像圆形 |
| `--gosslan-bubble-radius` | 18px | **20px** | 气泡半径 |

### 亮色

| token | 改前 | 改后 |
|---|---|---|
| `--gosslan-app-bg` / `-bg` | #edf1f6 / #f1f5f9 | **#f2f3f5 / #f2f3f5** |
| `--gosslan-caption` / `-rail` | #e2e8f0 | **#e9ebee** |
| `--gosslan-rail-text` / `-rail-active` | #64748b / #cbd5e1 | **#5a6068 / #dfe2e6** |
| `--gosslan-list` / `-list-active` | #f1f5f9 / #dbe3ed | **#f7f8fa / #eceef1** |
| `--gosslan-field` | #f3f5f8 | **#f2f3f5** |
| `--gosslan-border` / `-divider` | #e2e8f0 / #e2e8f0 | **#e5e6eb / #eef0f2** |
| `--gosslan-text-2` | #475569 | **#5a6068** |

### 暗色

| token | 改前 | 改后 |
|---|---|---|
| `--gosslan-app-bg` / `-bg` | #0b1220 / #0f172a | **#141518 / #141518** |
| `--gosslan-caption` / `-rail` | #16202f | **#1c1e21** |
| `--gosslan-rail-text` / `-rail-active` | #94a3b8 / #253246 | **#8a9099 / #26282b** |
| `--gosslan-list` / `-list-active` | #1e293b / #334155 | **#1e2023 / #2c2f33** |
| `--gosslan-chat` / `-panel` | #0f172a / #1e293b | **#242628 / #2c2f33** |
| `--gosslan-field` | #2a3a52 | **#2a2c31** |
| `--gosslan-border` / `-divider` | #3a4a66 / #28344a | **#34373b / #2c2f33** |
| `--gosslan-text` / `-text-2` | #f1f5f9 / #94a3b8 | **#f2f3f5 / #b4b8be** |
| `--gosslan-placeholder` | #94a3b8 | **#b4b8be**（与 text-2 同值，既有契约） |
| `--gosslan-danger-ink` | #ff5548 | **#ff7a85**（面板抬亮后仍 ≥4.5） |
| `--gosslan-toggle-off` | #64748b | **#7c8698**（≥3.0） |
| glass-1/2/3 填充与兜底 | 蓝灰 | **中性 #1e2023 / #2c2f33 / rgba(44,47,51,.92)** |

玻璃三档、`prefers-reduced-transparency`、`prefers-contrast: more` 的降级结构**未改**；AM-13/15/16 的取值约束未改（只换颜色取值，未动时长/缓动/透明度上下限）。

### 与现有实现的冲突与处置

> 2026-11-06 用户口径：**全部按设计图取值**，只有对比度硬约束允许偏离；下述 1/3 是仅有的两处偏离。

1. **正文色采纳画板 `#1f2329`（已改）**，跌破的三条契约用“现有 token / 现有档位”真回补，不删判据：
   - 多选工具栏文字钮：`disabled:opacity-40 → 50`，合成对比度 **2.41 → 3.16**（门槛 2.5）；
   - 菜单禁用条目：新增 `--gosslan-disabled-alpha-menu: 0.6`（0.6 是已有档位，不是第五档），**3.16 → 4.24**（门槛 3.3）；
   - 禁用输入框：字段族改为**实色禁用墨** `--gosslan-text-2`（α=1），**4.24 → 5.72**（门槛 4.5）。
   判据侧新增 `solid` 一族并带反例自证：删掉那条 `color: var(--gosslan-text-2)` 必须变 unresolved。
2. **主色采纳 `#2f6bff` 作出厂默认（已改）**：`style.css` 兜底、`useAppStore` 初始/重置值、`skeleton.css` 兜底、设置色板第一格同改；已存用户的 `localStorage` 主题色不受影响，可随时改回。
3. **危险填充按画板 `#f04452` 实测白字 3.71:1（不是 3.66），仍达不到 4.5 ⇒ 取最近更深一档 `#df3146`（4.50:1，ΔE76=5.5）**。对比：`#d43d43` 为 4.62:1 但 ΔE76=9.2，更偏离画板；`#e0353f` 为 4.42:1 仍不达标。文字档维持画板 `#ff7a85`（暗面板 5.36:1）。这是全仓唯一一处允许偏离画板的填充色。
4. **暗色中性气泡 #2a2d31 暂未采纳**。`previewMetrics` 要求卡片/画布 ≥1.10，画板这组只有 1.06；旧 `--gosslan-card` 保留到第 3 段消息气泡统一重标定。
5. **10px 字号未删**。画板最小 11px，但删 `micro` 会牵动全站排版与字号门禁，放第 6 段随 i18n 一起做。
6. **第 1 段的正文色按追加 token 修正处理**：`f315fd19` 保持可整体回滚，正文色与三条契约回补单独成笔。
7. **环境雾/内容层玻璃未删**。画板 decisions #0 说“删内容层玻璃与环境雾”，与你的硬约束“保留 glass 三档与降级”冲突；按你的约束**保留**，只在第 3 段收敛使用面。

## 4. 图标统一方案（第 2 段）

盘点（现读现跑）：

- `lucide-vue-next` 直接引用 **57 个文件**（含 2 个判据文件、2 个工具文件，实际 UI ≈53）。
- 内联 `<svg>` 仅 **3 个文件**：`TitleBar.vue`(2)、`GroupTasksBoard.vue`(1)、`BubbleTail.vue`(2)。
- 侧栏是第三套：`navIcons.ts` 手写 path + `NavIcon.vue` 包装。
- 独立窗口 HTML 壳（settings/logs/preview/startup-error/todos）无自有图标。
- 应用图标：`src-tauri/icons/icon-source.png` → `npm run icon`（Tauri）生成全平台尺寸；Android/iOS 目录已存在。

方案：

1. **唯一 UI 图标源 = `lucide-vue-next`**（圆角 2.0 与画板 IconSet 同族），统一 `stroke-width: 2`、端点圆角；尺寸只走三档 token（16 内联 / 20 控件 / 24 导航），禁止再写 `:size="17"` 一类。
2. 新增 `components/ui/Icon.vue` 作为**唯一入口**（包 lucide + 尺寸档 + `aria-hidden`），57 个文件的引用改为 `<Icon name="…" />`；`NavIcon` 保留为侧栏特例但内部走同一入口，`navIcons.ts` 只留“画板侧栏专用轮廓”，不再承载第二套命名。
3. 3 处内联 `<svg>` 逐个替换：TitleBar → Icon；BubbleTail 是几何装饰不是图标，保留并注明豁免；GroupTasksBoard 的 1 处并入 Icon。
4. 应用图标：以画板 `AppIcon` 为准产出 1024×1024 单源 PNG，覆盖 `icon-source.png`，再跑 `npm run icon` 生成 macOS/Windows/Android/iOS 全部尺寸；不手改 `src-tauri` 配置、不改 Rust。
5. 门禁：新增一条“组件里不得出现新内联 `<svg>`/不得新增第二套图标名”的判据（第 2 段自带反例自证）。

## 5. 第一段验收证据

- 单测：`npm test` → **1814 pass / 0 fail / 6.9s**
- 构建：`npm run build` → `[frontend] ✅ vite build（5.5s）`
- 截图（`test-results/ui-redesign/p1/`）：`desktop-1280-light/dark`、`mobile-390-light/dark`、`mobile-360-light`
- 运行方式：worktree 内 `npx vite --port 1421` + Brave CDP 截图（不写用户工作区、不碰 1420 上你自己的 dev server）

## 6. 第 2 段实施记录（图标 + 应用图标）

落地：

- 新增 `components/ui/iconRegistry.ts`：`lucide-vue-next` 具名导出 → **kebab 键 → 组件** 的静态表（112 键），保留 tree-shaking；`CheckCircle2 → "check-circle2"`、`ImageIcon → "image-icon"`（不剥尾 `Icon`，否则与 `Image` 撞键）。
- 新增 `components/ui/Icon.vue`：全应用唯一渲染出口，`size ∈ {16,20,24}`（16 档描边 1.8，其余 2.0），`label` 有值当图片读、无值整枚 `aria-hidden`。
- `navIcons.ts` 收敛为“画板四枚侧栏轮廓 → registry 键”的映射（会话=气泡、通讯录=双人、收藏=**书签**、链接=链环），尺寸档 `rail 23 / tab 21`；`NavIcon.vue` 内部改走 `Icon.vue`，不再自绘 path、不再 import lucide。
- `fileKind.ts` / `todoCustomIcons.ts` 从“组件映射”改为“registry 键映射”（`FILE_KIND_ICON_NAMES` / `TODO_CUSTOM_ICON_NAMES`），Node 单测不再解析 lucide。
- 53 个 UI 文件改为 `<Icon name="…">`；5 个用图标当变量的文件（`DevDiagPanel`/`FavoritePanel`/`GroupTasksBoard`/`SettingsWindow`/`ConversationListItem`）连同组件映射一并改成“名字 + Icon”。
- 内联 `<svg>`：`TitleBar`/`GroupTasksBoard` 的图标并入 `Icon.vue`；`BubbleTail` 是几何装饰（气泡尾巴），按方案**豁免**。
- 应用图标：画板 `brand/png/app-icon-1024.png`（1024×1024）覆盖 `src-tauri/icons/icon-source.png` 与 `icon.png`，跑 `npm run icon` 生成 36 个平台尺寸；未手改 `src-tauri` 配置、未动 Rust。

豁免（`feat/code-fold` 冲突文件，合入后迁）：

- `components/MessageItem.vue`、`components/message/MessageCodeBubble.vue` 仍直连 lucide；本段**主动回退** `MessageItem.vue` 的 codemod 改动，避免与 `gosslan-codefold` 那笔冲突。
- 两个 barrel（`ui/icons.ts`、`ui/iconRegistry.ts`）是唯一允许直连 lucide 的物理入口。

判据锚点搬迁（同提交，均保留反例自证）：

- ㊵ 分母现算 + 扫描白名单加入 `iconRegistry.ts`（registry 本身必须直连 lucide）。
- ⑬ 导航：从“navIcons 必须 import lucide / 值是组件”改为“登记 registry 键”，并新增 `NavIcon` 必须走 `Icon.vue`。
- ⑰ 看板映射表：取值必须是 `iconRegistry.ts` 里真实存在的键（反例 `not-in-registry` 仍会红）。
- 51 BackArrow：从 `<ArrowLeft v-else` 改为 `<Icon name="arrow-left" v-else`，平台分支不许合并。
- `remindFlow` 抖动入口：锚点从 `<Zap` 改为 `name="zap"`，排序判据不变。

## 7. 第 3 段实施记录（桌面主界面）

落地：

- **标题栏右侧功能组**（`TitleBar.vue` 新增 `#right` 插槽，辅助窗口不传 ⇒ 宽度为 0、原样不动）：
  `LAN · n`（`chat.peers.length`，与空态 chips 同一读数）→ 全局搜索（复用 `APP_ACTION.focusSearch`，
  与 ⌘K 同一实现）→ 个性化（写 `gosslan:settings-section=appearance` 后开设置）→ 本人头像 + 在线点
  （`app.present`，从 rail 上移）。整组 `mousedown.stop`，在拖拽区里仍可点击。
- **rail 去重**：删除顶部头像块（`SelfAvatar` 不再出现在 NavRail），首个元素即导航；`--gosslan-rail`
  随之无消费点，一并删除（亮暗两档）。
- **列表页脚**：改为画板 listFoot —— 40px 整行按钮（`list-checks` 图标 + 「任务中心」+ 未完成数
  + `vX.Y.Z` + chevron）。版本号保留在页脚，满足既有判据；任务数为 0 时不渲染数字 pill。
- **新建入口**：灰色 `+` 改为画板 32×32 主题色实底方块（`--gosslan-primary-active`）。
- **空态**：68px 品牌底盘（新增 `--gosslan-orb-bg` / `--gosslan-orb-ring`，亮暗两档）+ 44px 应用标记
  （直接复用第 2 段 `src/assets/app-mark.png`，不手绘第二份 mark）+ 标题 + 说明 + 口号 + 主动作
  + 状态 chips（设备数 / 端到端加密 / 无服务器）+ 右下角快捷键提示（非 macOS 显示 Ctrl 组合）。

判据锚点搬迁（同提交，均保留反例自证）：

- 页脚计数：`entryText === "1"` → `[data-task-count]` 文本；新增「0 件时必须没有该节点」的反例
  （探针先清空 `chat.operations` 取得确定 preimage）。
- 本人头像：`designGuards` 从「NavRail + ResponsiveLayout + ProfileSection 三处都用 SelfAvatar」
  改为「标题栏 + 设置页各一处，NavRail 出现 `<SelfAvatar>` 即红」；`events.test` 的 `present`
  锚点从 NavRail 移到 ResponsiveLayout。

与画板的有意差异：

| 项 | 画板 | 实现 | 原因 |
|---|---|---|---|
| 空态标题字号 | 22px | `text-title` 15px | 字号只走六档令牌（㊿），不新增第 7 档 |
| chips / 快捷键提示 | 10.5px | `caption` 11px | 10px→11px 统一在第 6 段收口，中途不零散改 |
| 空态次按钮「输入邀请码」 | 有 | 无 | 本仓没有邀请码功能，不新增功能；只保留真实的「添加好友 / 发起聊天」 |

验证：

- `npm test` → **1815 pass / 0 fail**（含 i18n 对称性 1668/1668、死键 0）
- `npm run build` → `✅ vite build`
- 截图：`test-results/ui-redesign/p3/before|after/desktop-1280-light|dark.png`
- 运行方式：worktree 内 dev server（1421）+ Brave CDP；截图前隐藏浏览器无后端造成的 toast HUD。

## 8. 第 4 段实施记录（移动端）

落地：

- **一级页顶栏**（`ConversationList`，`app.isMobile`）：56px，本人头像（`SelfAvatar` 30px + 在线点）
  + 页面标题（聊天/通讯录）+ 32px 主题色新建入口；桌面端这一段不渲染。
- **搜索行**：独立一行（`py-1.5` + 36px 输入框），移动端占位文案改为「搜索会话、联系人或消息」，
  桌面端仍用短文案。
- **TabBar**：`--gosslan-mobile-tabbar-h` 4rem → **3.5rem（56px）**；按钮 `py-2.5` → `py-1.5`，
  激活药丸 `min-width: 48px`（画板 46–48）；图标仍 21、标签仍 `caption` 11。
- **移动端首启空态**（画板 MobileEmpty）：68px 品牌底盘（复用 `assets/app-mark.png`）+ 标题
  + 说明 + 主/次动作（添加好友·发起聊天 / 创建群聊，均为既有能力）+ 发现设备卡（`radar` 图标、
  `chat.peers.length` 读数）+ 纯 P2P / 端到端加密 / 无服务器三条特性。
  `radar` 加入 `iconRegistry`（lucide 唯一源），无手绘路径。
- 桌面列表的紧凑空态保持不变（主区已有整屏空态，不重复）。

与画板的有意差异：

| 项 | 画板 | 实现 | 原因 |
|---|---|---|---|
| 顶栏标题字号 | 17px | `text-title` 15px | 字号只走六档令牌 |
| 空态标题 | 20px | `title` 15px | 同上 |
| Tab 标签 | 10px | `caption` 11px | 10→11 统一第 6 段，且 10px 已不可用 |
| 移动端行高/头像 | 64 / 42 | 64 / 40 | 行高按阶段 1 令牌；头像 40 与桌面同一组件，不动尺寸契约 |

验证：

- `npm test` → **1818 pass / 0 fail**
- `npm run build` → `✅ vite build（4.5s）`
- `node scripts/check-i18n.mjs` → zh=1673 / en=1673、死键 0
- 截图：`test-results/ui-redesign/p4/mobile-430-light|dark.png`

## 9. 第 5 段实施记录（独立窗口与浮层）

落地（只动模板 / 样式 / i18n，未碰 Rust、协议、数据库）：

- **设置窗口**（`SettingsWindow.vue`）：侧栏 176 → 200px，4 项导航按画板归入 3 个组标题
  （应用 / 连接与数据 / 其他）；选中态从灰底改为画板的主题色 12% 底 + 主题色文字档；
  侧栏底部加版本 + 「已自动保存」页脚；内容区新增 `text-title` 标题 + 一行说明的头部，
  以及 36px 页脚（左「设置修改即时生效」/ 右绿色对勾「已自动保存」）。
- **日志窗口**（`LogViewer.vue`）：顶部工具栏按画板收为 46px——左侧「实时 / 已暂停」状态药丸
  + 行数，右侧纯图标（刷新 / 复制 / 清空）；时间窗 chip、合并开关、搜索框合并进同一排
  （chips 去掉描边，改画板的浅底块）；底部新增 36px 状态条（刷新状态 / 可见行数 /
  复制日志路径 / 导出诊断包）；日志正文 13 → `caption` 11px。
- **浮层**（`BaseModal.vue`）：标题 16px（Tailwind `text-base`）改走 `text-title` 15px 令牌。
  `AddFriendModal` / `GroupCreateModal` 未新增第二套卡片样式，继续共用这一份解剖。
- **启动错误窗口**（`startup-error.css`）：`--se-*` 取色对齐 Pulse 亮暗两档
  （`#f2f3f5` / `#141518`、正文 `#1f2329` / `#f2f3f5`、主色 `#2f6bff` 暗色提亮、
  危险实底 `#df3146` / 文字档 `#ff7a85`）；标题 22px、按钮圆角 10px。
- **i18n**：新增 `settings.window.group.*`（3）、`settings.window.desc.*`（4）、
  `settings.window.footer.*`（2）、`logs.live|paused|statusCount`（3），中英同步。

与画板的差异表：

| 窗口 | 画板 | 实现 | 原因 |
|---|---|---|---|
| 设置 | 7 个导航项、3 组 | 现有 4 项、3 组 | 不改 IA（不新增功能）；分组只做视觉归拢 |
| 设置 | 内容头 64px、标题 19px | `title` 15px + 说明行 | 字号只走六档令牌 |
| 日志 | 级别 chips（全部/调试/信息/警告/错误） | 无 | 级别筛选是**新功能**，本段不做 |
| 日志 | 右侧详情面板（选中行展开） | 无 | 新功能 + 分栏改信息层级，本段不做 |
| 日志 | 左侧行号 gutter | 无 | 列表是虚拟滚动，行号需接入新数据源（功能面） |
| 日志 | 工具条含关闭键 | 关闭仍由共用 TitleBar 承担 | 同一语义不重复渲染（一个状态只出现一次） |
| 群任务 | 410px 列表 + 详情分栏、我的/全部/我创建/已归档标签页、优先级图标块、新建任务入口 | 保持现有单栏分组列表 | 画板是**信息层级不同**（分栏 + 标签页 + 新入口），按约定先不动功能 |
| 预览 | 深色顶栏（文件名/计数/工具）+ 底部缩略图条 / 缩放 / 元数据 | 保持现有全屏灯箱 | 缩略图与缩放是**新功能**；灯箱已覆盖窗口，改顶栏不可见 |
| 启动错误 | 66px orb、可折叠详情、底部版本行 | 保留现有诊断层级（详情 / 目录 / 安全说明 / 状态） | 画板压缩了诊断信息，删减属功能取舍，本段只对齐取色与字号 |
| 全部 | 10.5 / 13.5 / 19px | `micro`10 / `caption`11 / `meta`12 / `body`13 / `title`15 | 字号只走六档令牌；10px 统一第 6 段抬到 11px |

颜色一律走 `--gosslan-*`（启动错误窗口是独立静态页，用同源 `--se-*` 映射，不引主样式表）；
未新增任何字面色值到组件里。

验证：

- `npm test` → **1818 pass / 0 fail**（含 `designGuards` 292 条：焦点环、tap-safe、字号令牌）
- `npm run build` → `vue-tsc --noEmit` 通过、`✅ vite build（9.1s）`
- `node scripts/check-i18n.mjs` → zh=1685 / en=1685、死键 0、动态前缀 6、并行暂缓 0
- 截图（真实窗口尺寸，亮暗各一张）：`test-results/ui-redesign/p5/`
  `settings-{light,dark}.png`（780×600）、`logs-{light,dark}.png`（760×560）、
  `todos-{light,dark}.png`（780×620）、`preview-{light,dark}.png`（1120×820）、
  `startup-error-{light,dark}.png`（560×400）。
  浏览器无 Tauri 后端 ⇒ 日志/预览落在错误态、启动错误详情为空、启动错误底部一行
  `invoke` 错误；这是环境噪声，不是设计差异（逐张已核对几何与取色）。
- 浮层截图未单独出：`BaseModal` 只在有后端数据时由真实入口触发，headless 无触发路径；
  本段对它的改动只有标题字号（`text-base` → `text-title`），由 `designGuards` 的字号判据覆盖。


## 10. 第 6 段实施记录（状态 / 边界 / i18n / 验收收口）

本段只动模板、样式、i18n 文案与判据，未碰 Rust、协议、数据库，未新增功能。

### 10.1 状态收敛（一个状态只出现一次）

- `StateBlock` 增加第三档密度 `inline`：设置分组 / 摘要行里的一行提示，11px、无独立高度，
  重试是文字链。另加默认槽位，用来放空态的主行动（CTA 与状态在同一个组里）。
- 迁入 `StateBlock` 的面板级状态：
  - `ChatWindow` 无消息空态；
  - `ConversationList` 会话空态（CTA 走槽位）、好友读失败、无好友/无匹配；
  - `TaskCenter` 台账读失败 + 无任务；
  - `LinksList` 加载 / 错误 / 空；
  - `LogViewer` 桌面与移动两套外壳的空 / 筛选空；
  - `ChatSearchDialog` 搜索中 / 错误 / 空结果；
  - `GroupTasksBoard` 筛选空态；
  - `GroupMemberPanel` 任务摘要的三态、成员列表空态、可添加好友空行（`inline`）；
  - `NetworkSection` 路由表 / 中继白名单空行（`inline`）；
  - `FavoritePanel` 筛选空态、`ForwardModal` 无匹配、`GroupCreateModal` 无好友、
    `AddFriendModal` 扫描中。
- 删除被替换的内联实现，不留并行第二套。
- **同屏重复**：`ResponsiveLayout` 的「新的朋友」页原来在 `FriendRequestList` 之外又画了一遍
  `friend.request.empty`，同一空态在一屏出现两次；重复那份已删除，由列表组件自己承担。
- 保留的非 `StateBlock` 空态（画板专属、不是通用状态）：桌面中央 `/` 通讯录首启空态、
  移动端 `MobileEmpty`、添加好友页「没有任何设备」——它们各自带品牌底盘 / 就地通道开关，
  是设计源在画板上画出的页面级空态，收敛进通用块会丢掉画板指定的信息层级。

### 10.2 边界与截断

- 截断文案统一带 `title` / `aria-label`：`designGuards` 的全量扫描（全部 `.vue`）为 0 违规。
- 长代码块：`CodeBlock` 维持 `white-space: pre-wrap` + `overflow-x: hidden`，极窄窗折行、
  不产生横向滚动条；`MarkdownText` 的内联代码保留自身滚动。
- 超长设备名 / 群名：列表行、标题栏、会话头沿用既有 `truncate` + `title`，360 / 1280 两档
  截图逐张核对无溢出。

### 10.3 字号收口

- `tailwind.config.js`：`micro` 10 → 11px（`caption` 同为 11px，语义分工保留：
  micro = 徽标 / 状态条恒定短文案，caption = 正文最小档）。全站不再有 10px 文本。
- 受牵连处一次性重排：日志底部状态条、设置侧栏分组标题、诊断面板标签、
  状态块 `inline` 档，均随 11px 行高重新对齐；不留零散 `text-[11px]` hack。
- 未采纳 10.5 / 19 这类画板中间值：字号仍只走六档令牌（`designGuards` 判据不变）。

### 10.4 判据搬迁（同时搬锚点 + 反例自证）

| 判据 | 旧锚点 | 新锚点 | 反例自证 |
|---|---|---|---|
| A 档「读失败 ⇒ 界面错误档」 | 组件里的 `role="alert"` 字面量 | 面板挂了 `StateBlock` 错误档；`StateBlock` 自己带 `role="alert"` | 手写 `<div role="alert">` 不再被认作合法形状 |
| 字号令牌 | `micro: 10px` | `micro: 11px` | 原有的 `text-[13px]` 正控仍在 |
| 弹窗三态 | 共享目录 / 群文件 / 诊断面板 | 追加会话列表、任务中心、链接、日志、搜索、群任务、群成员、网络设置、收藏、转发、建群、添加好友 | 少一个 `kind` 即红 |
| 本人头像 | 三处都走 `SelfAvatar` | 标题栏（h-6）与「我的」页（h-14）各钉一个**具体落点** | 旧判据只断言"文件里出现过 `<SelfAvatar`"，标题栏那处让整条恒真，注入用例抓不到「我的」页被删 |

### 10.5 与画板的差异表（本段新增）

| 位置 | 画板 | 实现 | 原因 |
|---|---|---|---|
| 字号 | 10.5 / 19px 等中间值 | 六档 11/11/12/13/14/15 | 只走令牌；10px 抬到 11px 下限 |
| 空态 | 每个页面各自的空态插画 / 文案 | 通用状态走 `StateBlock`，画板专属首启空态保留 | 通用状态只保留一套；品牌空态按图 |
| 状态文案层级 | 标题 + 说明两行 | 同左，说明可省略 | 不新增文案键（i18n 零新增） |

验证（本段收口）：

- `npm run verify:full` → 见提交说明末行（31 步全绿）
- `npm test` → 见本段末行
- `npm run build` → 见本段末行
- 截图：`test-results/ui-redesign/p6/`（亮暗 × 1280 / 768 / 430 / 390 / 360）
