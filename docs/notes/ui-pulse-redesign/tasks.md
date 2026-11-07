# UI Pulse 重构 · 任务台账

> 用户 2026-11-07 要求：把提过的每一条任务列成清单，逐条推进，完成即更新状态。
> 状态只用四个词：**已完成 / 进行中 / 待做 / 待你拍板**。
> 提交号一栏只写真实 SHA，没有就写 `—`，不许编。读数一栏写实测数字或明确指向提交/探针。
>
> 维护规则：每完成一条，**当次**就改这一行（状态 / 提交 / 读数），不攒到最后；
> 里程碑报告里点名"本次更新了第几行"。

| # | 用户原话要点 | 范围（文件或组件） | 状态 | 提交 | 读数 | 遗留问题 |
|---|--------------|--------------------|------|------|------|----------|
| 1 | 本轮 UI 重构第 1 段：tokens 与骨架落地（52 头部 / 320 列表 / 62–64 行高） | [style.css](../../../src/style.css)、骨架类 | 已完成 | `fc940366`（token 修正 `f818aeb3`） | 见提交内实测表 | — |
| 2 | 本轮 UI 重构第 2 段：图标统一到 Icon.vue + 画板应用图标 | [Icon.vue](../../../src/components/ui/Icon.vue)、iconRegistry | 已完成 | `83221f9f` | 全部图标走同一注册表 | — |
| 3 | 本轮 UI 重构第 3 段：桌面主界面标题栏/列表页脚/空态按画板重构 | ResponsiveLayout、TitleBar、ConversationList | 已完成 | `834d6060` | 见提交内实测表 | — |
| 4 | 本轮 UI 重构第 4 段：移动端顶栏/搜索行/TabBar/空态 | MobilePageFrame、TabBar | 已完成 | `05c80b84` | 见提交内实测表 | — |
| 5 | 本轮 UI 重构第 5 段：独立窗口/浮层按画板重构 | SettingsWindow、GroupTodosWindow、LogViewer 等 | 已完成 | `e6204770` | 见提交内实测表 | 与画板结构性差异见待拍板清单 |
| 6 | 本轮 UI 重构第 6 段：状态/边界/字号/i18n 与验收收口 | 全局、i18n 两册 | 已完成 | `36fab80f` | 见提交内实测表 | — |
| 7 | 终稿对稿 ①：标题栏 40、头像簇、画板字阶 | TitleBar、头像簇、style.css token | 已完成 | `3d2e0684` | `--gosslan-title-h: 40px`；头像簇保住原值 | — |
| 8 | 终稿对稿 ②：会话列表标题行/搜索行/行内字号 | ConversationList、ConversationListItem | 已完成 | `4f3987dd` | 见提交内实测表 | — |
| 9 | 终稿对稿 ③：应用图标三平台产物按画板重出 | 应用图标产物（macOS/Windows/Linux） | 已完成 | `f1729f9b` | 三平台产物已重出 | macOS `.icns` 无 dark/tinted，见待拍板 |
| 10 | 设置里「关于」内边距比其他分区小，全部分区卡片内边距统一成一个标准值 | SettingsPanel、SettingsWindow、`SettingsGroup`、settings 各分区 | 已完成 | `ead3dd52` | 标准值 16px；各分区实测表见提交 | 用户 2026-11-07 补正：差异可能来自滚动条占位，已并入 #19 |
| 11 | 群管理输入框在暗色 + 玻璃 + 背景浮动（特效全开）下看不清输入区，信息可视性下降 | 输入字段 token、MessageComposer、GroupMemberPanel | 已完成 | `070c785c` | 暗/亮 × 特效全开读数见提交 | — |
| 12 | 代码块折叠为固定 8 行，展开才滚 | CodeBlock、MessageCodeBubble | 已完成 | `8130a4ee`（main） | 8 行折叠 | — |
| 13 | 窄窗列表穿透 | ResponsiveLayout、列表骨架 | 已完成 | `076e72c3` | 见提交内实测表 | — |
| 14 | 亮色层级方案 A（表面/薄纱分层） | style.css 表面 token、各面板 | 已完成 | `076e72c3`（诊断 `4c90c89f`） | 见提交内实测表 | — |
| 15 | 预览窗生命周期与全局单例 | ImageLightbox、preview 窗口 | 已完成 | `57b396ce` | 见提交内实测表 | — |
| 16 | toast 原因宽度：结论 + 一句人话原因，长原因落页面内错误档 | Toast 组件、错误档 | 已完成 | `57b396ce` | 见提交内实测表 | — |
| 17 | 预览状态图片四角是黑的：预览图绝对不许被切割（圆角/遮罩/`overflow:hidden`/`object-fit:cover` 都不许） | ImageLightbox、MessageImageBubble、收藏/群任务/消息缩略图 | 已完成 | `572117bd` | `--only=previewclip` 5/5 绿（亮/暗）：radius **0px**、object-fit **contain**、裁剪祖先 **[]**、四角命中 img **4/4**、边距 **290/220/290/180**；反面对照（stage hidden + 18px 圆角）双双变坏。缩略图按容器裁、点开走同一个灯箱 | 主窗覆盖层与独立预览窗口复用同一个 `ImageLightbox`（CE-01 已钉） |
| 18 | 群任务「标签」下拉内容一多就顶出窗口，最下面的项点不到；**全站所有同类浮层**统一：最大高度到窗口边缘、内部滚动、末项可点 | TodoAttrField/TodoAttrTagsField、SettingsSelect、ContextMenu、EmojiPicker、ActionSheet 等所有 Reka 浮层 | 已完成 | `12777527` | `--only=popclamp` 14/14 绿：桌面 40 项 bottom **467**/vh **475**（留 8px）、clientH 393、scrollH 1280、末项可点 rowClick=39；390 标签面板 bottom **632**/vh **640**；撤掉限高反面桌面溢出 **+879px**、390 **+705px** | 原生 `<select>` 弹层由 OS 绘制，明确豁免；PC-01 守卫 + 2 条注入式反例落地 |
| 19 | 滚动条出现/不出现时内容宽度不一致、「关于」因此偏小；有滚动条时内容视觉偏左。与 ⑦ 焦点环合并成一件 | 所有滚动容器（设置/日志/群任务/会话列表/搜索/收藏/转发/群成员等）、BaseModal 滚动区 | 已完成 | `77133302` | 设置独立窗口实测（亮/暗各一套）：通用(会滚) vs 关于(不滚) clientW **764/764**、文字起始 x **895/895**；缩高跨临界点 deltaW **0**、deltaTextX **0**；去掉预留的反面 deltaW **-8px**。合成夹具 tall/short 内容宽差 0、auto 档差 8px。探针 `--only=scrollstable` 5/5 绿 | 已插到 #18 之前做（已完成） |
| 20 | 焦点环被左边界裁切 + 有滚动条时内容视觉居中 | MessageItem 焦点环、滚动容器内距 | 已完成 | `77133302` | 与 #19 同一根因、同一提交：消息头像/合并卡两个焦点环改 `ring-inset`；SC-01 扫全仓 `.vue`，外扩环 0 处（改坏即红） | — |
| 21 | 输入区像悬浮在会话底部：输入框背后与左右空隙必须与消息区同一整块背景，不许独立实色面板/分隔线/第二层底；安全区按实测输入区高度让位 | MessageComposer、ChatWindow、ResponsiveLayout、BackToLatestButton | 已完成 | `5667a87f` | `--only=composerfloat` 6/6 绿（5 宽 × 亮/暗/特效全开 = 15 组）：外壳 bg **rgba(0,0,0,0)**、无 border-top/阴影；shellH **114** == paddingBottom **114**；两者等宽；「回到最新」让位 **130px**；滚到底末条距卡顶 **-32px**；反面对照（让位清零）被盖 **+82px**。CS-01 改新口径 + BT-05；注入式反例全绿 | `data-frost="off"` / reduce-transparency / contrast:more / `pane-under-chat` 均未改动 |
| 22 | 中心图标直方形与圆角矩形不协调：图标同心圆角（或充满裁切） | Icon 容器、各处图标底 | 已完成 | `49ffcf2d` | `--only=concentric` 5/5：桌面 orb **68/16px**、44px 标记削成 **4px**（inset 12）；移动端 56px 标记 **10px**（inset 6）。判据 `r_inner = r_outer − inset`，token `--gosslan-radius-orb-mark-44/-56` | 采用「同心圆角」（未选充满裁切：会吃掉 68 底盘的底色与内描边） |
| 23 | 窗口圆角/头像同心几何：右上角间距左右不等 | 头像、窗口圆角、卡片 | 已完成 | `49ffcf2d` | 头像 `gapTop 6 == gapRight 6`（28px 圆 / 40px 标题栏），与 macOS 26 的 20px 窗口圆角同心偏差 **devX 0 / devY 0**；反面对照 `pr` 改回 12px 后两向差 **6px**。CN-01/CN-02 三条反例全绿 | Windows 11（8px 窗口圆角）退化为**等距 fallback**，不做伪同心；`--gosslan-title-h` 保持 40px |
| 24 | 群任务/预览/日志/启动错误四处与画板的结构性差异（分栏+标签页+优先级图标+新建入口、深色顶栏+缩略图+元数据） | GroupTodosWindow、ImageLightbox、LogViewer、启动错误页 | 待你拍板 | — | — | 排进后续版本 or 维持现状 |
| 25 | macOS `.icns` 无 dark/tinted 容器，是否换打包格式支持 macOS 26 | 打包脚本、图标产物 | 待你拍板 | — | — | — |
| 26 | 7 项画板妥协（按钮圆角 8 vs 9、LAN 字号 11 vs 10.5、搜索壳 36 vs 34、搜索字号 13 vs 12、未读徽标 16/11 vs 18/10.5、orb 圆角 16 vs 20、红绿灯纵向错位） | 对应组件 | 待你拍板 | — | — | 哪些必须消除、哪些接受 |
| 27 | 发版节奏：这批是否并进一次 5.18.46 | 版本清单、CHANGELOG | 待你拍板 | — | 当前分支 5.18.51（#17–#23 各一笔 patch） | 合入策略见 #28 |
| 28 | 全部做完 rebase 到最新 main、ff-only 合入并推；Change Budget 判据 3 按「负责人接受」记账，不动阈值 | 分支 `feat/ui-pulse-redesign-wip`、main | 待做 | — | — | 判据 4 必须双向绿；不 force、不打 tag、不删分支 |

## 状态变更记录

- 2026-11-07：建立台账（本文件）。#12–#16 回溯补齐；#17–#23 按用户队列登记；#24–#28 进「待你拍板/待做」。
- 2026-11-07：**#19 / #20 完成**（`77133302`）。按用户补正把「滚动条占位」与 ⑦「内容偏左」合并成一件，
  插到 #18 之前做完；SC-01 守卫 + 注入式反例落地。#18 仍为「进行中」（代码在 stash）。
- 2026-11-07：**#18 完成**（`12777527`）。共享限高口径 + `POPOVER_EDGE` 单一来源；
  `--only=popclamp` 14/14、`verify-guards --only 限高` 2 条注入式反例全绿。
  顺带修好 `codeBlockLayout` 自证锚点：共享块必须排在 `.code-lang-menu` 之后（否则假绿）。
- 2026-11-07：**#17 完成**（`572117bd`）。灯箱 `rounded-none + object-contain`、stage 不裁切；
  `--only=previewclip` 5/5、CE-01 注入式反例全绿。
- 2026-11-07：**#21 完成**（`5667a87f`）。输入区外壳改 `absolute + bg-transparent`（不再有第二层底），
  让位量由 `ResizeObserver` 实测 `composerH`；`--only=composerfloat` 6/6、
  CS-01 新口径 + BT-05 + 注入式反例全绿。版本 5.18.50。
- 2026-11-07：**#22/#23 完成**（`49ffcf2d`）。同心几何：内圆角 = 外圆角 − 内距
  （44→4、56→10）；右上角头像内距 6/6 并与 20px 窗口圆角同心。`--only=concentric` 5/5、
  CN-01/CN-02 + 注入式反例全绿。版本 5.18.51。
