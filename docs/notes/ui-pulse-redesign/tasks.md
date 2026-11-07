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
| 27 | 发版节奏：这批是否并进一次 5.18.46 | 版本清单、CHANGELOG | 待你拍板 | `—` | 已按"一条一 patch"落地，当前分支 **5.18.51**（#17–#23 各一笔 patch） | 是否再压成一次对外发版由负责人定；合入见 #28 |
| 28 | 全部做完 rebase 到最新 main、ff-only 合入并推；Change Budget 判据 3 按「负责人接受」记账，不动阈值 | 分支 `feat/ui-pulse-redesign-wip`、main | 已完成 | `65ad570d`（`main` `4c90c89f → 65ad570d`） | 判据 4 **双向绿**（逐笔 `Version-Bump: patch / 版本文件 4/4`）；判据 3 的 `presentation: 5 次` 按负责人接受，记录在 [change-budget-acceptance-2026-11-07.md](./change-budget-acceptance-2026-11-07.md)；`origin/main` = `65ad570d`，本批 0 merge commit | 未 force、未打 tag、未删分支/worktree；本次 push 的 CI 会在判据 3 上红一次（已接受） |
| 29 | 拍板 B 遗留的两项要消除：orb 圆角 16→20、红绿灯纵向错位 | [style.css](../../../src/style.css)（`--gosslan-radius-xl` 与 orb 标记 token）、ResponsiveLayout/ConversationList orb、TitleBar 红绿灯让位 | 进行中 | orb 已改（本笔）；红绿灯「待你拍板」 | `--gosslan-radius-xl: 16px → 20px`；`orb-mark-44: 16−12=4 → 20−12=8`；`orb-mark-56: 16−6=10 → 20−6=14`；CN-01/CN-02 由 calc 自动跟到 8/14（`designGuards` 327 条全绿） | **红绿灯纵向错位做不了**：只能用 Rust/窗口层改原生灯 y（`use_native_titlebar` 固定 AppKit 28pt 条 = 灯心 y14，而标题栏内容心 y20），本批边界「不动 Rust」⇒ 需你裁决是否放行 Rust |
| 30 | 群任务表单「右边又被裁切、和滚动条贴得太近」（用户两轮实测） | 全局滚动口径 [style.css](../../../src/style.css) + 14 个内容页滚动容器（BaseModal / Settings / Log / GroupTasks / Search / Favorite / Forward / Members / FriendRequests 等） | 已完成 | 本笔 | 结构改为「内容区 │ 固定空隙 8px │ 固定滚动条带 8px」：`--gosslan-scroll-track: 8px`、`--gosslan-scroll-gap: var(--gosslan-gutter)`、`--gosslan-scroll-inset: 16px`；`scrollbar-gutter: stable both-edges` ⇒ 有/无滚动条内容盒宽度逐像素相等且左右对称；删掉 `pr-0.5`/`-mx-1`/`-mx-5` 三处宽度补偿。守卫 SC-02 正反 4 条 + 14 页消费清单全绿 | 像素读数/4× 特写需真机截图，待用户重启 dev 后补；红绿灯无关 |
| 31 | 页面内边距过大，按 VS Code compact 整档收紧（紧凑但井然有序） | [style.css](../../../src/style.css) 密度刻度 + SettingsPanel（分组间距）/ SettingsRow（行高下限）/ BaseModal·SettingsWindow（标题页脚对齐） | 已完成 | 本笔 | 依据：VS Code `window.density.layout=compact` 三条定义（更短标题栏 / 去掉部件间空隙 / 收紧面板内部间距，1.136 与 1.141 更新说明）；本应用无「部件间空隙」，只收紧内距与行高：`card-pad 16→12`、`card-pad-inset 12→8`、`section-gap 20→16`、`row-min-h 40`（下限 40，移动端命中仍 ≥44）、`gutter 8`。㊶ 判据跟着换挡（旧 16 现在判红），DE-01 正反 4 条绿 | 一屏可见条目数/亮暗截图需真机；`control-h` 未新开档（控件高度已由各行自有 `h-*` 与 HIG 判据管，避免两套口径） |

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
