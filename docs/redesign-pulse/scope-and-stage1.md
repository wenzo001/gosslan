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

1. **正文色 #1f2329 未采纳，保留 #0f172a**。`DISABLED_CONTRAST_CONTRACT` 的“多选工具栏 2.5 / 菜单禁用 3.3 / 禁用输入框 4.5”是按更深的正文标定的；换成 #1f2329 后三项实测降到 2.41 / 3.16 / 4.24。唯一能补的方式是把禁用 α 抬高，但 `禁用态透明度只许 4 档` 的判据会红。**处置：本段保留 #0f172a**，等你拍板是“改契约 α”还是“接受画板色并在第 3 段重标定”。
2. **主色出厂值 #2f6bff 未采纳，仍是用户主题色 #3b82f6**。primary 是用户可改的设置项，换出厂值会影响色板预设与品牌认知。**处置：留作拍板项**，第 3 段前确认。
3. **危险填充 #f04452 未采纳，保留 #d43d43**。画板填充色配白字仅 3.66:1，达不到全站“白字实底 ≥4.5”的既有契约；文字档已按画板抬到 #ff7a85。**处置：填充档保留，文字档跟随画板**。
4. **暗色中性气泡 #2a2d31 暂未采纳**。`previewMetrics` 要求卡片/画布 ≥1.10，画板这组只有 1.06；旧 `--gosslan-card` 保留到第 3 段消息气泡统一重标定。
5. **10px 字号未删**。画板最小 11px，但删 `micro` 会牵动全站排版与字号门禁，放第 6 段随 i18n 一起做。
6. **环境雾/内容层玻璃未删**。画板 decisions #0 说“删内容层玻璃与环境雾”，与你的硬约束“保留 glass 三档与降级”冲突；按你的约束**保留**，只在第 3 段收敛使用面。

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
