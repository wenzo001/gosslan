# UI Pulse 重构 · 任务台账

> 用户 2026-11-07 要求：把提过的每一条任务列成清单，逐条推进，完成即更新状态。
> 状态只用四个词：**已完成 / 进行中 / 待做 / 待你拍板**。
> 提交号一栏只写真实 SHA，没有就写 `—`，不许编。读数一栏写实测数字或明确指向提交/探针。
>
> 维护规则：每完成一条，**当次**就改这一行（状态 / 提交 / 读数），不攒到最后；
> 里程碑报告里点名"本次更新了第几行"。

| # | 用户原话要点 | 范围（文件或组件） | 状态 | 提交 | 读数 | 遗留问题 |
|---|--------------|--------------------|------|------|------|----------|
| 1 | 本轮 UI 重构第 1 段：tokens 与骨架落地（52 头部 / 320 列表 / 62–64 行高） | [style.css](../../../src/style.css)、骨架类 | 已完成 | `4d3b759e`（token 修正 `b99f035a`） | 见提交内实测表 | — |
| 2 | 本轮 UI 重构第 2 段：图标统一到 Icon.vue + 画板应用图标 | [Icon.vue](../../../src/components/ui/Icon.vue)、iconRegistry | 已完成 | `023b6745` | 全部图标走同一注册表 | — |
| 3 | 本轮 UI 重构第 3 段：桌面主界面标题栏/列表页脚/空态按画板重构 | ResponsiveLayout、TitleBar、ConversationList | 已完成 | `9cbb7fb1` | 见提交内实测表 | — |
| 4 | 本轮 UI 重构第 4 段：移动端顶栏/搜索行/TabBar/空态 | MobilePageFrame、TabBar | 已完成 | `e3a7bd04` | 见提交内实测表 | — |
| 5 | 本轮 UI 重构第 5 段：独立窗口/浮层按画板重构 | SettingsWindow、GroupTodosWindow、LogViewer 等 | 已完成 | `c663b8c9` | 见提交内实测表 | 与画板结构性差异见 #24（拍板 B：维持现状） |
| 6 | 本轮 UI 重构第 6 段：状态/边界/字号/i18n 与验收收口 | 全局、i18n 两册 | 已完成 | `92c5401b` | 见提交内实测表 | — |
| 7 | 终稿对稿 ①：标题栏 40、头像簇、画板字阶 | TitleBar、头像簇、style.css token | 已完成 | `a765cd5a` | `--gosslan-title-h: 40px`；头像簇保住原值 | — |
| 8 | 终稿对稿 ②：会话列表标题行/搜索行/行内字号 | ConversationList、ConversationListItem | 已完成 | `cfa14f7d` | 见提交内实测表 | — |
| 9 | 终稿对稿 ③：应用图标三平台产物按画板重出 | 应用图标产物（macOS/Windows/Linux） | 已完成 | `81eb7de0` | 三平台产物已重出 | macOS `.icns` 无 dark/tinted，见 #25（拍板 B：维持现状） |
| 10 | 设置里「关于」内边距比其他分区小，全部分区卡片内边距统一成一个标准值 | SettingsPanel、SettingsWindow、`SettingsGroup`、settings 各分区 | 已完成 | `0c0c62d7` | 标准值 16px；各分区实测表见提交 | 用户 2026-11-07 补正：差异可能来自滚动条占位，已并入 #19 |
| 11 | 群管理输入框在暗色 + 玻璃 + 背景浮动（特效全开）下看不清输入区，信息可视性下降 | 输入字段 token、MessageComposer、GroupMemberPanel | 已完成 | `389d4fe4` | 暗/亮 × 特效全开读数见提交 | — |
| 12 | 代码块折叠为固定 8 行，展开才滚 | CodeBlock、MessageCodeBubble | 已完成 | `8130a4ee`（main） | 8 行折叠 | — |
| 13 | 窄窗列表穿透 | ResponsiveLayout、列表骨架 | 已完成 | `076e72c3` | 见提交内实测表 | — |
| 14 | 亮色层级方案 A（表面/薄纱分层） | style.css 表面 token、各面板 | 已完成 | `076e72c3`（诊断 `4c90c89f`） | 见提交内实测表 | — |
| 15 | 预览窗生命周期与全局单例 | ImageLightbox、preview 窗口 | 已完成 | `57b396ce` | 见提交内实测表 | — |
| 16 | toast 原因宽度：结论 + 一句人话原因，长原因落页面内错误档 | Toast 组件、错误档 | 已完成 | `57b396ce` | 见提交内实测表 | — |
| 17 | 预览状态图片四角是黑的：预览图绝对不许被切割（圆角/遮罩/`overflow:hidden`/`object-fit:cover` 都不许） | ImageLightbox、MessageImageBubble、收藏/群任务/消息缩略图 | 已完成 | `5b18d3eb` | `--only=previewclip` 5/5 绿（亮/暗）：radius **0px**、object-fit **contain**、裁剪祖先 **[]**、四角命中 img **4/4**、边距 **290/220/290/180**；反面对照（stage hidden + 18px 圆角）双双变坏。缩略图按容器裁、点开走同一个灯箱 | 主窗覆盖层与独立预览窗口复用同一个 `ImageLightbox`（CE-01 已钉） |
| 18 | 群任务「标签」下拉内容一多就顶出窗口，最下面的项点不到；**全站所有同类浮层**统一：最大高度到窗口边缘、内部滚动、末项可点 | TodoAttrField/TodoAttrTagsField、SettingsSelect、ContextMenu、EmojiPicker、ActionSheet 等所有 Reka 浮层 | 已完成 | `a0a35ab7` | `--only=popclamp` 14/14 绿：桌面 40 项 bottom **467**/vh **475**（留 8px）、clientH 393、scrollH 1280、末项可点 rowClick=39；390 标签面板 bottom **632**/vh **640**；撤掉限高反面桌面溢出 **+879px**、390 **+705px** | 原生 `<select>` 弹层由 OS 绘制，明确豁免；PC-01 守卫 + 2 条注入式反例落地 |
| 19 | 滚动条出现/不出现时内容宽度不一致、「关于」因此偏小；有滚动条时内容视觉偏左。与 ⑦ 焦点环合并成一件 | 所有滚动容器（设置/日志/群任务/会话列表/搜索/收藏/转发/群成员等）、BaseModal 滚动区 | 已完成 | `bf37fea9` | 设置独立窗口实测（亮/暗各一套）：通用(会滚) vs 关于(不滚) clientW **764/764**、文字起始 x **895/895**；缩高跨临界点 deltaW **0**、deltaTextX **0**；去掉预留的反面 deltaW **-8px**。合成夹具 tall/short 内容宽差 0、auto 档差 8px。探针 `--only=scrollstable` 5/5 绿 | 已插到 #18 之前做（已完成） |
| 20 | 焦点环被左边界裁切 + 有滚动条时内容视觉居中 | MessageItem 焦点环、滚动容器内距 | 已完成 | `bf37fea9` | 与 #19 同一根因、同一提交：消息头像/合并卡两个焦点环改 `ring-inset`；SC-01 扫全仓 `.vue`，外扩环 0 处（改坏即红） | — |
| 21 | 输入区像悬浮在会话底部：输入框背后与左右空隙必须与消息区同一整块背景，不许独立实色面板/分隔线/第二层底；安全区按实测输入区高度让位 | MessageComposer、ChatWindow、ResponsiveLayout、BackToLatestButton | 已完成 | `bcee9d42` | `--only=composerfloat` 6/6 绿（5 宽 × 亮/暗/特效全开 = 15 组）：外壳 bg **rgba(0,0,0,0)**、无 border-top/阴影；shellH **114** == paddingBottom **114**；两者等宽；「回到最新」让位 **130px**；滚到底末条距卡顶 **-32px**；反面对照（让位清零）被盖 **+82px**。CS-01 改新口径 + BT-05；注入式反例全绿 | `data-frost="off"` / reduce-transparency / contrast:more / `pane-under-chat` 均未改动 |
| 22 | 中心图标直方形与圆角矩形不协调：图标同心圆角（或充满裁切） | Icon 容器、各处图标底 | 已完成 | `735fb3d3` | `--only=concentric` 5/5：桌面 orb **68/16px**、44px 标记削成 **4px**（inset 12）；移动端 56px 标记 **10px**（inset 6）。判据 `r_inner = r_outer − inset`，token `--gosslan-radius-orb-mark-44/-56` | 采用「同心圆角」（未选充满裁切：会吃掉 68 底盘的底色与内描边）；把底盘改 20px 见 #29 |
| 23 | 窗口圆角/头像同心几何：右上角间距左右不等 | 头像、窗口圆角、卡片 | 已完成 | `735fb3d3` | 头像 `gapTop 6 == gapRight 6`（28px 圆 / 40px 标题栏），与 macOS 26 的 20px 窗口圆角同心偏差 **devX 0 / devY 0**；反面对照 `pr` 改回 12px 后两向差 **6px**。CN-01/CN-02 三条反例全绿 | **拍板 A**：Windows 11（8px 窗口圆角）退化为**等距 fallback**，不做伪同心补偿；`--gosslan-title-h` 保持 40px |
| 24 | 群任务/预览/日志/启动错误四处与画板的结构性差异（分栏+标签页+优先级图标+新建入口、深色顶栏+缩略图+元数据） | GroupTodosWindow、ImageLightbox、LogViewer、启动错误页 | 已完成 | `—` | **拍板 B：维持现状，本批不加功能** | 若后续要补，按用户队列单独排期，不混在本批 |
| 25 | macOS `.icns` 无 dark/tinted 容器，是否换打包格式支持 macOS 26 | 打包脚本、图标产物 | 已完成 | `—` | **拍板 B：维持现状，发版前再评估** | 换格式会动打包链路，属发版决策 |
| 26 | 7 项画板妥协（按钮圆角 8 vs 9、LAN 字号 11 vs 10.5、搜索壳 36 vs 34、搜索字号 13 vs 12、未读徽标 16/11 vs 18/10.5、orb 圆角 16 vs 20、红绿灯纵向错位） | 对应组件 | 已完成 | `—` | **拍板 B**：只消除 orb 圆角（16→20）与红绿灯错位两项（→ 新行 #29 待做），其余五项保留 | 保留五项各自挡着的判据：①按钮圆角 8 vs 9 —— ㊴ 守卫禁止字面圆角，只认 `--gosslan-radius-*` 三档（md 10 / lg 14 / xl **20**，[style.css](../../../src/style.css)）；②LAN 字号 11 vs 10.5、④搜索字号 13 vs 12、⑤徽标 16/11 vs 18/10.5 —— 字号只有五档 token 15/14/13/12/11，11 是"正文最小可用字号"下限，10.5 无档可落（[style.css](../../../src/style.css#L79-L96)）；③搜索壳 36 vs 34 —— 外壳高度对齐 HIG 最小点按目标判据（`designGuards.ts` 44px 下限一节），内壳不再单独开档 |
| 27 | 发版节奏：这批是否并进一次 5.18.46 | 版本清单、CHANGELOG | 已完成 | `ab942506`（合并小节） | **负责人 2026-11-07 拍板**：不再一条一 patch 对外，5.18.47~5.18.70 合并成一条对外可读的 **5.18.71** 小节，tag `v5.18.71` 作为本次发布 | 原文逐字进 [changelog-archive.md](../../archive/notes/changelog-archive.md) 备查；发布说明用 5.18.71 的对外口径，不贴内部 SHA |
| 28 | 全部做完 rebase 到最新 main、ff-only 合入并推；Change Budget 判据 3 按「负责人接受」记账，不动阈值 | 分支 `feat/ui-pulse-redesign-wip`、main | 已完成 | `65ad570d`（`main` `4c90c89f → 65ad570d`） | 判据 4 **双向绿**（逐笔 `Version-Bump: patch / 版本文件 4/4`）；判据 3 的 `presentation: 5 次` 按负责人接受，记录在 [change-budget-acceptance-2026-11-07.md](./change-budget-acceptance-2026-11-07.md)；`origin/main` = `65ad570d`，本批 0 merge commit | 未 force、未打 tag、未删分支/worktree；本次 push 的 CI 会在判据 3 上红一次（已接受） |
| 29 | 拍板 B 遗留的两项要消除：orb 圆角 16→20、红绿灯纵向错位 | [style.css](../../../src/style.css)（`--gosslan-radius-xl` 与 orb 标记 token）、ResponsiveLayout/ConversationList orb、TitleBar 红绿灯让位 | 已完成 | orb `735fb3d3`（本批）；红绿灯 `689e6ae4` | `--gosslan-radius-xl: 16px → 20px`；`orb-mark-44: 16−12=4 → 20−12=8`；`orb-mark-56: 16−6=10 → 20−6=14`（CN-01/CN-02 由 calc 自动跟到 8/14）。红绿灯：`center_traffic_lights` 按 `origin.y = 28 − 40/2 − 按钮高/2` 重排，中心 **14pt → 20pt**（下移 6pt）；`cargo check` 通过、`titleBarIcons` 9 pass | 红绿灯需窗口层改原生灯 ⇒ 用户已放行 Rust（仅 `macos_window.rs`，协议/数据库未动） |
| 30 | 群任务表单「右边又被裁切、和滚动条贴得太近」（用户两轮实测） | 全局滚动口径 [style.css](../../../src/style.css) + 14 个内容页滚动容器（BaseModal / Settings / Log / GroupTasks / Search / Favorite / Forward / Members / FriendRequests 等） | 已完成 | 本笔 | 结构改为「内容区 │ 固定空隙 8px │ 固定滚动条带 8px」：`--gosslan-scroll-track: 8px`、`--gosslan-scroll-gap: var(--gosslan-gutter)`、`--gosslan-scroll-inset: 16px`；`scrollbar-gutter: stable both-edges` ⇒ 有/无滚动条内容盒宽度逐像素相等且左右对称；删掉 `pr-0.5`/`-mx-1`/`-mx-5` 三处宽度补偿。守卫 SC-02 正反 4 条 + 14 页消费清单全绿 | 像素读数/4× 特写需真机截图，待用户重启 dev 后补；红绿灯无关 |
| 31 | 页面内边距过大，按 VS Code compact 整档收紧（紧凑但井然有序） | [style.css](../../../src/style.css) 密度刻度 + SettingsPanel（分组间距）/ SettingsRow（行高下限）/ BaseModal·SettingsWindow（标题页脚对齐） | 已完成 | 本笔 | 依据：VS Code `window.density.layout=compact` 三条定义（更短标题栏 / 去掉部件间空隙 / 收紧面板内部间距，1.136 与 1.141 更新说明）；本应用无「部件间空隙」，只收紧内距与行高：`card-pad 16→12`、`card-pad-inset 12→8`、`section-gap 20→16`、`row-min-h 40`（下限 40，移动端命中仍 ≥44）、`gutter 8`。㊶ 判据跟着换挡（旧 16 现在判红），DE-01 正反 4 条绿 | 一屏可见条目数/亮暗截图需真机；`control-h` 未新开档（控件高度已由各行自有 `h-*` 与 HIG 判据管，避免两套口径） |
| 32 | 审计报告 9 条落地（页脚版本号 / 设置左栏 / 单聊自己消息 / 群头像 / #29 / 碰撞内距 / 右余量 / 暗色高对比字段边框 / 输入卡 22px） | ConversationList、SettingsPanel、SettingsWindow、MessageItem/MessageReceipt、MessageComposer、style.css、popoverBounds | 已完成 | `3b73eafe` · `08d6e4a3` · `250ef2c5` · `689e6ae4` · `e178e085` · `4ec8b35e` · `68d30156` | 页脚删版本号 → 42px「任务中心 · N」（探针判据同步）；设置左栏 9 分区双栏、散值归零；自己消息气泡 36 / 内距 2 / 换组 12 / 68% / 560px；群头像 24；红绿灯 14pt→20pt；碰撞内距 13 处收成 `POPOVER_EDGE`；`--gosslan-field-border` 暗色高对比抬到 `divider-strong`（7.6:1）；输入卡 10→22px（`CS-02` 按 `--gosslan-radius-2xl` 现读） | #32 的 `--only=fieldcontrast` 新增暗色 + `prefers-contrast:more` 格（比常规暗色更亮 >0.05 且 ≥3.0） |
| 33 | 独立审查报告 M-1~M-7 + B-1 复核 | 骨架/index.html、Icon.vue/iconRegistry、designGuards、popoverBounds/MessageComposer、style.css/TabBar | 已完成 | M-2·M-3 `0575a8af`；M-1 `eaf23970`；M-6 `4308a76f`；M-7 `2b59612e`；M-4·M-5 `18003179` | M-1 骨架 `.boot-cap` 38→40、补 50px 标题行、搜索 28→36、composer 22，新增 SK-02 几何对账；M-2 ㊶ 补任意值/单轴/`!` 前缀（`p-[16px]`/`pt-4 pb-4`/`!p-4` 必红）；M-3 扫描域扩到 `Settings*`；M-4 删 `ui/icons.ts`（36 点收口）；M-5 删 `size` prop 与 1.8 分支；M-6 `MENTION_POP_MAX_H=176` + 兜底 `100dvh`（Reka 实测写入 `--reka-popper-available-height`）；M-7 删死开关 | **B-1 复核结论：断点无 bug，`tauri.conf.json` 未改**。≤767 均走移动布局（rail 隐藏、list/main 全宽），768 起桌面三列；`main` 任五档实宽都不为 0。原报告「360 时 main=0」是纯几何推算、漏掉移动布局路径 |
| 34 | 缩略图被切割：「所有图片绝对不要切割」落到**缩略图**这一类（#17 只覆盖了气泡/预览窗，还漏两处 `object-cover`） | [TodoImageThumb.vue](../../../src/components/TodoImageThumb.vue)（群任务图片 80×80）、[MessageComposer.vue](../../../src/components/chat/MessageComposer.vue)（待发送 56×56） | 已完成 | `ab942506` | 两处 `object-cover → object-contain`，圆角/边框/底色不变；新增 **TH-01**（真实树断言两文件无 `object-cover` + 把 `contain` 换回 `cover` 必红的反例自证）。亮暗夹具截图：`test-results/ui-thumb-contain-2026-11-07/` | 头像仍按框裁（身份标识，不是图片内容）；收藏/转发/合并卡/气泡/预览窗原就是 `contain`，未动 |
| 35 | 所有界面的骨架图与真实 UI 同步（用户 2026-11-07 总要求，排在全部 UI 改动之后） | [skeleton.css](../../../src/boot/skeleton.css)、5 个 HTML 骨架、[skeletonTokens.ts](../../../src/boot/skeletonTokens.ts)、[vite.config.ts](../../../vite.config.ts)、[style.css](../../../src/style.css)、6 个真实组件、designGuards SK-04 | 已完成 | 本笔 | 23 项对差表见 [density-and-scroll.md §8.2](../../design-language/density-and-scroll.md)；四类首帧跳位修掉：列表缺 50px 标题行、rail 多画 42px 头像（低 58–60）、设置/日志/预览缺 40px TitleBar、群任务顶栏 48→40；SK-04 正反 5 条（骨架写字面 px / 真实组件改回私有数字 / 删 token / 孤儿 `--boot-*` / marker 非 1 次）全绿，`designGuards` 360 条；截图 `test-results/skeleton-sync/`（5 界面 × 骨架/加载 × 1440，主窗加 390） | 骨架几何改为**构建时物化**：`--gosslan-*` 唯一来源 → `--boot-*` 注入内联样式，禁止骨架自写一套数字；画板偏差回写 `designs/gosslan-redesign/docs/decisions.md` v2.3 |

## 第二批：2026-11-07 追加 11 条（A①–C⑪）

> 编号 A/B/C 沿用用户给的批次清单。状态口径：**已完成** = 代码与判据都落地；
> **已完成·待真机** = 代码与判据落地，但结论只能在用户的 Windows / 安卓设备上验收
> （本机是 macOS，拿不到 Windows WebView2 与安卓 WebView 的渲染）。
> 「自测方式」写的是**能复跑的命令或判据名**；没有的真机项一律写「待真机」，不写「应该没问题」。
> 真机照做步骤见 [device-acceptance-checklist.md](./device-acceptance-checklist.md)。

| # | 条目（用户原话要点） | 状态 | 提交 | 自测方式 | 缺口 |
|---|----------------------|------|------|----------|------|
| 36 | A① 窗口不在前台时第一下点击被吃掉：代码块/长文本弹窗、崩溃恢复条的按钮要点第二下 | 已完成 | `b3ad5bf5`（5.18.76） | **CF-01**（`node --test src/utils/designGuards.test.ts` → 369/369）：核对 `tauri.conf.json` 的 `acceptFirstMouse` 与六处 `WebviewWindowBuilder` 的 `.accept_first_mouse(true)`；两条反例（配置改回 `false`、删掉某扇窗那行）必红 | 待真机（macOS）：切到别的应用 → 直接点恢复条「知道了」，第一击应关闭 |
| 37 | A② 启动画面「小院儿 · 正在启动中」被 macOS 红绿灯 / Windows 三键压住 | 已完成 | `3c23d2d6`（5.18.75） | **SK-03**（同一测试文件）：按声明的对齐方式算出 brand 盒（768 × 保守最宽 160），与 macOS `0–78`、Windows 右侧 `132` 求交；删掉 `justify-content: center` 必红 | 待真机（冷启动首帧）：骨架在真实 DOM 挂载前就淡出，运行时探针取不到首帧矩形，只能几何推导 |
| 38 | A③ 崩溃恢复条/各类提示贴视口边，压到安卓状态栏与圆角 | 已完成·待真机 | `74e2629c`（5.18.72） | **SA-01/02/03**（同一测试文件）：在状态栏 24px + 圆角 24px + 视口 390×844 下判定矩形不侵入「圆外被切区域」；「统一出口」扫全仓，组件裸写 `env()` 必红 | 待真机（安卓）：`env()` 真值只有安卓 WebView 上报，桌面 Chrome 恒 0 |
| 39 | B④ 输入框删表情：一次退格把两个表情一起删掉 | 已完成·待真机 | `478a7766`（5.18.74） | `node --test src/utils/graphemes.test.ts`（9 条：两个连着表情、ZWJ 家庭、肤色、旗帜、VS16…）；另外 `deleteOneUnitBeforeCaret` 覆盖 token 三种 caret 落位 | 待真机（安卓）：WebView 的 caret 落位形态与 IME 组合由系统决定 |
| 40 | B⑤ 「任务中心」更名「传输队列」；移动端任务列表页页头 / `0/1 已完成` / 筛选 / 列表四套竖线并回同一条 16px | 已完成 | `da03c1c7`（5.18.78） | 文案：中英两册同步（`node scripts/check-i18n.mjs`）；几何：`GroupTasksBoard.vue` 的 `pageInset` 只输出 `px-[var(--gosslan-scroll-inset)]`，无字面 px（㊶ 守卫禁任意值） | 真机像素表未取：本批只保证「同一个 token」，实际竖线位置需截图量 |
| 41 | B⑥ 网络诊断页双层滚动条 | 已完成 | `da03c1c7`（5.18.78）；子列表 `e6ec21a3`（5.19.6） | 第一层 5.18.78 去掉；5.19.6 把剩下 4 处**子列表**（蓝牙退避 / 对端版本 / 连接活性 / 群文件日志）的 `max-h-48 + overflow-y-auto` 一并去掉——用户口径「一页只有一层滚动条，子列表不应再套一层」，随内容展开，长列表靠数据源上界兜底（群文件日志只留 50 行）。判据 PG-03 从只盯 `max-h-[75vh]` 扩到全文件任意 `class="… max-h-* / overflow-*-auto …"`，新增反例「子列表 `max-h-48` 必红」；运行时探针 `--only=diag` 5/5：`shellH 335 / shellSH 2359`（壳确实在滚）、`inner 0`；把 `max-h-48` 写回一处 ⇒ FAIL 并报 `sh 316 / ch 192` | — |
| 42 | C⑦ 触屏长按正文不弹消息面板 | 已完成·待真机 | `da03c1c7`（5.18.78） | `node --test src/utils/longPress.test.ts`（11/11：5 环链 + 逐环反例）与 `contextMenu.test.ts`（断言 `onSelectableText: false`）；结构判据：源码再出现 `hitSelectable` / `lastTouchTextCol` 即红。口径变更见 [decision-longpress-2026-11-07.md](./decision-longpress-2026-11-07.md) | 待真机（安卓）：「选择文字」点下去后能否真的选中并复制 |
| 43 | C⑧ 弹窗标题 / 固定头部 / 页脚的横向与纵向基线各写一套 | 已完成 | `da03c1c7`（5.18.78） | `BaseModal.vue` 标题、header 插槽、footer 统一 `--gosslan-modal-gap`（16px），fullscreen header 横向走 `--gosslan-scroll-inset`；`designGuards` 抓任意值写法 | 真机对比截图未取：设置 / 日志 / 群任务 / 预览四个窗口需各看一眼 |
| 44 | C⑨ Windows 图标：软件内升级后仍是旧图标；Windows 11 不给应用图标加圆角 | 已完成·待真机 | 升级不刷新 `12519540`（5.18.73）；圆角 `da03c1c7`（5.18.78） | 升级：`rg -n "SHChangeNotify" src-tauri/nsis/hooks.nsh` = 1（`SHCNE_ASSOCCHANGED` 让外壳重读图标）；圆角：`icon.ico` 4368 → **6897 B**，由 `scripts/build-app-icons.mjs` 从圆角源图重出 | 待真机（Windows）：覆盖安装后桌面/任务栏图标；必要时 `ie4uinit.exe -show` 前后对照 |
| 45 | C⑩ Windows 标题栏头像簇应在左侧，与左 R 角同圆心 | 已完成·待真机 | `f0c0e45b`（5.18.73） | **TB-01 / TB-02**（`designGuards`）：平台→头像簇侧、组内顺序、标题绝对居中、`--gosslan-caption-avatar` 与 `--gosslan-caption-inset` 同源；四条反例必红 | 待真机（Windows）：角部 4× 特写；TB-02 只是平台模拟读数 |
| 46 | C⑪ 背景动效 Windows 与 macOS 观感不一致，需要可复制的读数 | 已完成·待真机 | `da03c1c7`（5.18.78） | `src/utils/ambientProbe.ts` 13 行取样（平台 / 四个媒体查询 / `pointer: coarse` / `html[data-ambient]` / `backdrop-filter` / 三个 `--ambient-*` / DPR / 视口）+ `DevDiagPanel` 展示与一键复制；视图层裸写 `matchMedia` 由 `designGuards` ㉟ 拦住 | 待真机（Windows）：需要用户复制一段读数回传 —— 这是唯一能证明差异的一半 |

**A③ 的 TabBar 是「继承变量」，不是漏改**（证据链，三处都能现查）：

1. TabBar 元素在 [ResponsiveLayout.vue](../../../src/layouts/ResponsiveLayout.vue#L1223) 第 1223 行，`class="safe-bottom frost tabbar-chrome ..."`；
2. 它消费的选择器在 [style.css](../../../src/style.css#L1844-L1846) 第 1844–1846 行：`.safe-bottom { padding-bottom: var(--gosslan-inset-bottom) }`；
3. 这个变量在 [style.css](../../../src/style.css#L355) 第 355 行定义为一个出口：`--gosslan-inset-bottom: max(env(safe-area-inset-bottom, 0px), var(--gosslan-inset-bottom-fallback))`，移动端 fallback 24px（第 1835 行）、桌面 0（第 351 行）。

内容区的让位同样读这个变量：[ResponsiveLayout.vue](../../../src/layouts/ResponsiveLayout.vue#L1021) 第 1021 行
`pb-[calc(var(--gosslan-mobile-tabbar-h)+var(--gosslan-inset-bottom))]`（条高 `--gosslan-mobile-tabbar-h: 3.5rem` 在 [style.css](../../../src/style.css#L107) 第 107 行）。
本批把各组件散写的 `env()` 收进这一个 token 之后，TabBar 的底色内边距与内容区让位**同时**跟到新值 ——
覆盖到位的判据是 SA-03「全仓裸写 `env()` 必红」，不需要在 TabBar 里再写一遍。

## 状态变更记录

- 2026-11-07：建立台账（本文件）。#12–#16 回溯补齐；#17–#23 按用户队列登记；#24–#28 进「待你拍板/待做」。
- 2026-11-07：**#19 / #20 完成**（`bf37fea9`，rebase 前 `77133302`）。按用户补正把「滚动条占位」与 ⑦「内容偏左」合并成一件，
  插到 #18 之前做完；SC-01 守卫 + 注入式反例落地。#18 仍为「进行中」（代码在 stash）。
- 2026-11-07：**#18 完成**（`a0a35ab7`，rebase 前 `12777527`）。共享限高口径 + `POPOVER_EDGE` 单一来源；
  `--only=popclamp` 14/14、`verify-guards --only 限高` 2 条注入式反例全绿。
  顺带修好 `codeBlockLayout` 自证锚点：共享块必须排在 `.code-lang-menu` 之后（否则假绿）。
- 2026-11-07：**#17 完成**（`5b18d3eb`，rebase 前 `572117bd`）。灯箱 `rounded-none + object-contain`、stage 不裁切；
  `--only=previewclip` 5/5、CE-01 注入式反例全绿。
- 2026-11-07：**#21 完成**（`bcee9d42`，rebase 前 `5667a87f`）。输入区外壳改 `absolute + bg-transparent`（不再有第二层底），
  让位量由 `ResizeObserver` 实测 `composerH`；`--only=composerfloat` 6/6、
  CS-01 新口径 + BT-05 + 注入式反例全绿。版本 5.18.50。
- 2026-11-07：**#22/#23 完成**（`735fb3d3`，rebase 前 `49ffcf2d`）。同心几何：内圆角 = 外圆角 − 内距
  （当时外圆角 16 ⇒ 44→4、56→10；#29 把外圆角改 20 后自动变 8/14）；右上角头像内距 6/6 并与 20px 窗口圆角同心。`--only=concentric` 5/5、
  CN-01/CN-02 + 注入式反例全绿。版本 5.18.51。
- 2026-11-07：**#29（orb 部分）/ #30 / #31 完成**（本笔）。滚动带结构新增 SC-02（正反 4 条反例）；
  密度刻度新增 DE-01（行高下限 40 可红）；SC-01 的消费清单从 `scrollbar-both` 换到 `gosslan-scroll`；
  ㊶ 判据换挡 16→12。`designGuards` 329 条全绿。红绿灯纵向错位受「不动 Rust」边界阻塞，见 #29 遗留。
  运行时读数（`--only=scrollstable` 6/6）：`.gosslan-scroll` 合成夹具 `padL=padR=8 / trackW=8 / gapL=gapR=8`，
  把 `padding-inline` 清零后 `gapR=0`（读数有牙）；设置独立窗口「通用|关于」`clientW 764=764`、
  跨滚动条临界点 `deltaW=0 / deltaTextX=0`，撤掉 gutter 的反面对照 `deltaW=-8`。
  #30 的「控件右缘 → 滚动条带左缘」就是上面那 8px（内容页 14 处统一消费同一类，SC-02 逐文件钉住）。
- 2026-11-07：**六条拍板结论落地**。#23 Windows 圆角 → A（等距 fallback，不做伪同心）；
  #24 四处结构差 → B（维持现状）；#25 `.icns` dark/tinted → B（维持现状，发版前再评估）；
  #26 七项妥协 → B（只消除 orb 圆角 16→20 与红绿灯错位，另立 #29 待做；其余五项写明挡着的判据）；
  #21 滚到底 32px 呼吸空间 → A（保留，#21 读数 `-32px`）；判据 3 → A（负责人接受并记账，见
  [change-budget-acceptance-2026-11-07.md](./change-budget-acceptance-2026-11-07.md)）。
  #27 发版节奏仍为「待你拍板」。
- 2026-11-07：**#28 完成**。8 笔写成版本号的 `Version-Bump` trailer（`.36/.37/.38/.47/.48/.49/.50/.51`）
  在推送前统一改写为 `Version-Bump: patch`；判据 4 双向绿，判据 3 保持负责人接受。
- 2026-11-07：**#32 完成**（审计 9 条）。页脚 `3b73eafe`、设置左栏 `08d6e4a3`、自消息/群头像 `250ef2c5`、
  #29 红绿灯 `689e6ae4`、碰撞内距 `e178e085`、暗色高对比边框 `4ec8b35e`、输入卡 22px `68d30156`；
  版本 5.18.52 → 5.18.59。CN-01/CN-02 注释同步到 20/8/14；G-13 登记品牌 orb 例外、IP-01 登记灯箱豁免。
- 2026-11-07：**#33 六项完成**（审查 M-1~M-7，仅 B-1 待拍板）。M-2·M-3 `0575a8af`、M-1 `eaf23970`、
  M-6 `4308a76f`、M-7 `2b59612e`、M-4·M-5 `18003179`；版本 5.18.60 → 5.18.64。
  ㊵ 从「名字白名单」改为「除 `iconRegistry.ts` 外禁直连 lucide」+「Icon 字面量名必须登记」。
  `designGuards` 336 条全绿；`npm test` 1862 pass；`npm run build` 12.2s。
- 2026-11-07：**B-1 复核完成**（负责人裁决：不批 `minWidth 704`，先查断点）。Brave headless + CDP
  实测五档（Chromium 内核，`matchMedia` 判定与 WKWebView 同源）：

  | 窗宽 | 实际布局 | rail | list | main |
  |------|----------|------|------|------|
  | 360 | 移动（`html.is-mobile`） | 0（`display:none`） | 360（absolute w-full） | 360 |
  | 390 | 移动 | 0 | 390 | 390 |
  | 430 | 移动 | 0 | 430 | 430 |
  | 767 | 移动 | 0 | 767 | 767 |
  | 768 | 桌面三列 | 64 | 320 | 384 |

  `main` 的 `min-w-0` / `flex-1` 仍在，但移动态是 `absolute w-full`、不参与 flex 分配 ⇒ 不争空间。
  最窄桌面组合（768 + 列表上限 400）= main 304，仍 > 0。结论：断点正确启用，`main` 任一档都不为 0，
  原报告「360 时 main=0」漏掉了移动布局路径；`tauri.conf.json` 未改动。
- 2026-11-07：全批收尾两笔：`26fc8710` 修 #29 引入的 clippy `needless_borrow`（红绿灯两个
  调用点去掉 `&ns_window`，版本 5.18.66）；`a70f5a33` 把三条注入锚点跟着真实形状搬家
  （`<X>`→`<Icon name="x">`、`100vh`→`100dvh`、`:collision-padding="8"`→`POPOVER_EDGE`）
  并删掉清单里已不存在的 `ui/icons.ts` 行。
- 2026-11-07：**#30 遗留补完**（设置页真机像素表）。真实 WKWebView（780×600）逐分区实测：会滚的
  分区 `clientW 572 / offsetW 580`、卡片 `216..764`；不滚的分区 `580/580`、卡片 `208..772` ⇒
  与标题竖线差 **+8 / −8**。根因不是 padding 也不是包装层，而是 WebKit 在内容不溢出时**不兑现**
  `scrollbar-gutter: stable both-edges`；修法是共享容器改常驻轨道 `overflow-y-scroll`（已随 5.18.69
  发布），判据从「声明存在」升级为运行时几何差 **0px**（`--only=scrollstable` 9/9）+ SC-03 + 真机
  Swift 探针 `scripts/probes/settings-gutter-wk.swift`。截图 `test-results/ui-settings-gutter-2026-11-07/`。
- 2026-11-07：**#34 完成**（`ab942506`）：两处缩略图 `object-cover → object-contain` + TH-01 守卫。
  连带说明：#17 的「已完成」只覆盖气泡/预览窗，缩略图这类方框固定、内容被裁的画面此前没被任何判据覆盖。
- 2026-11-07：**#27 拍板为「一次对外发版 5.18.71」**。CHANGELOG 把 5.18.47~5.18.70 合并成一条
  对外可读小节（界面重构 / 可读性 / 交互手感 / 修复），原文逐字进
  [changelog-archive.md](../../archive/notes/changelog-archive.md)；`changelog:check` 由 47 节降到 12 节（上限 15）。
  **台账至此：1–34 全部「已完成」，无「待做」、无「待你拍板」。**
- 2026-11-07：当前门禁：`npm test` 1862 pass / 0 fail（中英复跑均绿）；`npm run build` ✓；
  `cargo fmt` ✓；`cargo clippy -D warnings` ✓（29.36s）；`cargo test` 1560 passed；
  `verify-guards.py --list` exit 0；`check-doc-citations` 1227 处裸路径全绿。
  **Change Budget 判据 3 仍红**：本分支最近 5 个 patch 提交里 presentation 占 5 次
  （`e4d54f6/1800317/2b59612/4308a76/eaf2397`）—— 这是「同领域连打补丁」的既有信号，
  脚本注明处置口径只有「负责人接受」或「分次推送使每次范围只含 1 笔」。
- 2026-11-07：**#35 完成**（骨架与真实 UI 同源）。用户总要求原文：「所有 UI 改完之后，
  把所有界面的骨架图也同步跟现在的 UI 同步」。
  ① 清单：`index.html`（桌面三栏 + 移动单列）、`settings.html`、`logs.html`、`todos.html`、
  `preview.html` 五套首屏骨架，样式全部内联自 `src/boot/skeleton.css`。
  ② 对差：23 项逐条量到根因 —— 列表缺 50px 标题行、rail 多画 42px 头像（低 58–60）、
  设置/日志/预览缺 40px TitleBar、群任务顶栏 48→40、设置左栏 176→200、日志工具条 48→46、
  移动行高 62→64、搜索壳留白 48→40、列表左上圆角 12→0。
  ③ 同步口径：`style.css` 的 `--gosslan-*` 是唯一来源，`vite.config.ts` 在构建时把值物化成
  `--boot-*` 注入内联样式（骨架先于 `style.css` 执行，运行时读不到那边变量）；
  骨架只许 `var(--boot-*)`，真实组件必须引用同名 `--gosslan-*`。
  ④ 判据：新增 **SK-04**（`checkBootSkeletonTokens`），四向校验 + 四条反例（骨架写字面 px /
  真实组件改回私有数字 / 删 token / 孤儿 `--boot-*`）；`designGuards` 360/360 绿。
  ⑤ 文档：本表 #35、[density-and-scroll.md §8](../../design-language/density-and-scroll.md)、
  [decisions.md v2.3](../../../designs/gosslan-redesign/docs/decisions.md)。
  ⑥ 截图：`test-results/skeleton-sync/`（5 界面 × 骨架/加载 × 1440；主窗加 390×844）。
- 2026-11-07：**追加 11 条登记**（#36–#46，A①–C⑪），每条带状态 / SHA / 自测方式 / 缺口。
  其中 6 条标 **已完成·待真机**（A③、B④、C⑦、C⑨、C⑩、C⑪）—— 代码与判据都落地，
  但本机是 macOS，Windows WebView2 与安卓 WebView 的结论只能由用户设备验收，
  照做步骤见 [device-acceptance-checklist.md](./device-acceptance-checklist.md)。
  A③ 的 TabBar 是**继承变量**而非漏改，三处证据见该节正文。
- 2026-11-07：**#14 从「只有规范」补成「代码已落地」**（8 条缺口逐条闭环，未动 Rust）。
  ① 移动 TabBar 药丸：spring(480/36/0.7) → `--gosslan-duration-fast`(150ms) + `--gosslan-ease`
  （高频短距，240 在移动端"还没停稳"、100 接近瞬移）；② page-slide 出场拆到
  `--gosslan-duration-exit`(180/200) + `exit-fast`，不再与入场同 240；③ `--gosslan-nav-switch-*`
  的裸 140ms 收编为 `--gosslan-duration-fast`；④ 灯箱 FLIP 时长改读令牌（无明显来源时仍居中放大），
  `TodoImageThumb` 补记来源矩形；⑤ 会话 / 收藏 / 群成员三处删除走 `<TransitionGroup name="list-row">`，
  看板行删除用 `.todo-row-leaving` 淡出（避让 motion-v layout 的 transform 争用）；⑥ 骨架呼吸登记为
  `--boot-breathe: 1.5s`（启动专用、不进交互阶梯）；⑦ `motionSystem.test.ts` 增 ④ 扫描全部 `.vue`
  （数字 `duration-*`、非令牌 `duration-[…]`、`type:'spring'`、`stiffness/damping/mass`、数字
  `duration`、`ease:"…"`），含 `duration-[300ms]` 反例与 ≥100 文件防空转；⑧ reduce 逐项：位移/缩放归零、
  状态变化仍可见（末条清单见代码注释与判据 ③）。
  门禁：`motionSystem+motionContinuity+designGuards+receiptMotion` 392 pass / 0 fail；`npm test`
  1937 pass / 0 fail；`npx vue-tsc --noEmit` exit 0；`npm run build` ✓（4.03s）。
  截图：`test-results/motion-2026-11-07/lightbox-{1-start,2-mid,3-end,4-reduce}.png`
  （中间帧 96×96@(200,120) → 402.7×289.8@(176.8,100.1) → 1020×680；reduce 档 transform:none 且可见）。

## 合入记录

- **基线与 rebase**：`git fetch origin --prune` → `origin/main` = `8130a4ee`（未变）；`git rebase origin/main`
  返回「当前分支 feat/ui-pulse-redesign-wip 是最新的。」（`git rev-list --left-right --count origin/main...HEAD`
  = `0 27`，即 0 behind / 27 ahead；无冲突、未 `--force`）。
- **trailer 修复（判据 4 双向绿）**：8 笔把 `Version-Bump:` 写成版本号的提交（rebase 后
  `4d3b759e` / `b99f035a` / `023b6745` / `bf37fea9` / `a0a35ab7` / `5b18d3eb` / `bcee9d42` / `735fb3d3`）
  统一改写为 `Version-Bump: patch`；改后 `--range origin/main..HEAD` 逐笔
  `Version-Bump: patch / 版本文件 4/4`。版本清单四文件一致：**5.18.51**。
- **verify:full**：末行 `❌ 失败 1 步（共 560.2s）`；30/31 步 ✅（含 npm test 28.5s、英文 locale 复跑
  29.4s、build 25.0s、cargo clippy 38.0s、Rust 单测 118.8s、护栏非空转 270.8s、Android 21.5s），
  唯一红项 **Change Budget 判据 3**（`presentation: 5 次`），按负责人接受并记账，见
  [change-budget-acceptance-2026-11-07.md](./change-budget-acceptance-2026-11-07.md)。
- **ff-only 进 main**：`main` `4c90c89f` → `65ad570d`（`git merge-base --is-ancestor main 65ad570d` 为真）。
  主工作区当时检出的是 `feat/ui-pulse-redesign`（070c785c）、**未检出 `main`**，因此用
  `git fetch . 65ad570d:main`（ff-only 语义）推进引用，**不动主工作区文件**。
- **推送**：`git push origin main` → `8130a4ee..65ad570d  main -> main`；
  `git rev-parse origin/main` = `65ad570d`。
- **形状**：本批 27 笔；`git log --merges 8130a4ee..65ad570d` 为空（0 merge commit）；
  未打 tag、未删分支、未删 worktree；`feat/code-fold` / `gosslan-codefold` 未重做未删除。
- **CI 预警**：push 事件判据仍会看到 `8130a4ee..65ad570d` 这个窗口 ⇒ 判据 3 会在这一次 CI 上红一次
  （负责人已接受该信号）；按 `scripts/check-change-budget.mjs` 注释的处置口径，**下一次推送的新范围**
  窗口自然清空。

## 收口记录（2026-11-08 · 诊断页子列表）

- **改的是什么**：`DevDiagPanel.vue` 四处子列表（蓝牙退避 / 对端版本 / 连接活性 / 群文件日志）
  的 `max-h-48 + overflow-y-auto` 全去掉。它们不是 5.18.78 那层页面滚动，而是"滚轮停在半屏小格上
  只能滚那一格"的第二、三、四层；用户口径「一页只有一层滚动条，子列表不应再套一层」。
  群文件日志仍由 `media.ts` 只留最近 50 行（`GROUP_FILE_DIAG_MAX`）—— 长列表靠数据源上界，
  不靠 CSS 限高。
- **判据（源码）**：`designGuards.test.ts` 的 PG-03 从只盯 `max-h-[75vh]` 扩到全文件任意
  `class="… max-h-* / overflow-*-auto …"`；新增反例「子列表写回 `max-h-48`」。
  `node --test src/utils/designGuards.test.ts` → 374 pass / 0 fail。
- **判据（渲染）**：`scripts/check-ui-runtime.mjs` 的 diag 段新增第 ⑤ 条，夹具把三份列表各塞 16 条，
  先证弹窗壳自己溢出，再要求「壳内可滚容器 = 0」。
  - 绿：`shellH 335 / shellSH 2359`、`inner []` → `--only=diag` 5/5。
  - 反例自证：把 `max-h-48` 写回蓝牙退避一处 → FAIL，读数 `inner [{cls:"max-h-48 …", sh:316, ch:192}]`，
    随后还原。
- **未改**：`.screenshots/`、`docs/notes/ui-pulse-redesign/candidates/` 两个未跟踪目录未动。
- **顺带修掉一条夜间假红（`5ee92e8a`，5.19.7）**：`verify-guards --only "Presence 不得内联大头像"`
  在夜间 cargo 通道连红 —— 注入确实把用例改红了，但用例声明的 `expect_fail_hint="broadcast_presence"`
  在 2026-11-04 那次「payload 构造搬进 `presence_payload_b64`」后就已经不是倒下的那句断言。
  关键词跟着搬到「Presence payload 必须过 hello_avatar_for_wire」，注入点与断言一个字没动；
  单跑该用例 → ✅ 1 条通过。这是本仓点过名的形状：判据搬了、锚点没搬，检查还在跑却查不到东西。

## 收口记录（2026-11-08 · 左列竖线 + 分栏把手）

- **C：左列列表的两条内容竖线（外部链接 / 收藏左栏）** —— 用户先问「这块有改吗」，核实结论是
  **没改过**（`73c1e89a` 只动群任务筛选行与 PG-02）。改前读数（探针 `--only=listmetrics`，
  容器 420 宽）：外部链接 `headerContentL=8 / 行左缘 16 / 行内距 8`（≈ 三条竖线）；
  收藏 `search.l=8 / 行左缘 16`。根因：`.scrollbar-both` 的 `both-edges` 左侧空带 = 平台滚动条宽度，
  而头部用固定 `px-2` 去对。改后：`headerContentL=12 / row.l=0 / rowPadL=rowPadR=12`（两条竖线合一）。
- **改了什么**：新增 `.gosslan-list-scroll`（只预留右侧滚动条带），`LinksList` / `FavoritePanel`
  左栏消费它；行、工具栏、来源条、错误条、搜索容器统一 `px-3`；行内缩分隔线 38 → 42px。
- **第二处根因（本轮新发现）**：`LinksList` 外层 `MobilePageFrame` 默认自己滚动，它的
  `both-edges` 左侧空带把内层列表整体右推 8px（`row.l=8` vs `headerContentL=12`）。
  改法是 `:scroll="false"` —— 一页只留一层滚动条，竖线才可能对齐。
- **D：分栏把手抢走左列滚动条** —— 实测把手盒 `[384, 392]`、滚动条带 `[368, 384]`，
  横向重叠 **4px**（`-mx-1` 各探 4px），`elementFromPoint(383)` 命中把手 ⇒ 用户点不到滚动条。
  改为 `-mr-2`（净占位 0，整条落在 main 一侧）、收藏页 `left` 去掉 `- 4`，并补 `resizeGrabDX`
  避免按下点不在交界线上时第一次 pointermove 跳 8px。
- **判据**：`LH-01`（竖线/一层滚动，3 条反例）/ `SP-01`（负边距朝向，2 条反例）；
  `node --test src/utils/designGuards.test.ts` → **378 pass / 0 fail**。
- **运行时读数**（`--only=listmetrics` → **11 绿 / 0 FAIL**，`test-results/list-metrics.json`）：
  `overlapX=0`、`elementFromPoint(带最右缘).inScroller=true`、滚动条按下 `scrollTop 0→549`、
  把手下按下拖动 `listW 320→360` 且 `body.cursor=col-resize`、反例注入 `-mx-1` 后
  `overlapX=4` 且最右缘归把手。
- **截图**：`test-results/list-metrics/links-{before,after}.png`、`favorites-{before,after}.png`。
- **未改**：`.screenshots/`、`docs/notes/ui-pulse-redesign/candidates/` 两个未跟踪目录未动。

## 待做（发版后动作，勿提前执行）

- **删除 v5.18.71 的 Windows 资产（两个 `-setup.exe`）** —— 用户 2026-11-07 拍板：
  「Windows 有严重的 bug，下个版本发布完之后，这个版本可以删掉了」。
  - 范围：只删 `v5.18.71` Release 里的 Windows 安装包（`*_x64-setup.exe` / `*_arm64-setup.exe`）；
    macOS 与 Android 资产**保留**（用户只点名 Windows）。
  - 触发条件（必须同时满足，缺一不可）：① 下一版（≥ 5.18.74）Release 已发布；
    ② `latest.json` 的 `version` 已指向新版、且四平台条目都指向新版 URL。
    现在**不能删**：`latest.json` 仍指 v5.18.71，提前删会让自动更新 404。
  - 执行后核对：`gh release view v5.18.71 --json assets` 只剩 macOS / Android；
    `latest.json` 不受影响；在「合入记录」里补一行带 SHA 的记账。
