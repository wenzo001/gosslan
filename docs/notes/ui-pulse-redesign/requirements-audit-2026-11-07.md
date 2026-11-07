# 需求 vs 实现 vs 设计稿 · 全量对账（2026-11-07）

> 只读审计。审计结束时本 worktree 无业务代码改动；未推送、未打 tag、未删分支或 worktree。
>
> - 代码基线：`origin/main` = `353a634dc02e01205421bcc511c67713e244ab22`（`git fetch origin --prune` 后读数；`65ad570d` 之后只有 `20dbbdc9`、`65d8b712`、`353a634d` 三笔文档/锚点修正，**没有新的裁切修复**）。
> - 审计 worktree：`/private/tmp/gosslan-audit-20261107`（detached at `353a634d`，独立新建，未使用主工作区，未动 `gosslan-redesign` / `gosslan-codefold`）。
> - 设计基线：`designs/gosslan-redesign/HANDOFF.md`、`designs/design-system-pulse/project/tokens.json`、`designs/gosslan-redesign/docs/decisions.md`、`designs/gosslan-redesign/docs/edge-cases.md`；`docs/design-language/ux-criteria.md`；`docs/design-guidelines.md`。
> - 需求来源：`docs/notes/ui-pulse-redesign/tasks.md`（#1–#29）、`docs/notes/unslop-review-2026-11-06/{plan,report}.md`、`docs/notes/narrow-glass-strips-5.18.34.md`、`decisions.md:209-225`（用户 2026-11-06 明确回复「1–5 可以」）、`git log 2026-11-05..2026-11-07`。
> - 台账状态**未采信**：每一行都回到源码核过；台账自报「已完成」但代码不成立的，本表按代码改判。

## 结论口径

- 状态只用：**已实现 / 部分 / 未做 / 待拍板**。与画板或用户已确认口径不一致的，再标「**与画板冲突**」。
- 冲突裁决优先级：**用户口头明确需求 > 设计画板 > 现有判据/令牌/文档**；画板让步只允许发生在可读性、可访问性、信息不可见这三类底线上。
- 证据全部是「文件:行」或可复现读数。**未验证项集中列在文末**，不混进结论。

---

## 一、需求总表

### A. UI Pulse 台账（#1–#29）

| 编号 | 需求（用户原话要点） | 当前实现证据 | 状态 | 若冲突按用户口径应该是怎样 | 落地动作 |
|---|---|---|---|---|---|
| R01 | #1 tokens 与骨架落地（52 头部 / 320 列表 / 62–64 行高） | `src/style.css:265` 列表 320；`:268-269` 行高 62/64；`:283` 标题栏 40（52 已被 #7/#23 改成 40） | 已实现 | — | 无 |
| R02 | #2 图标统一到 Icon.vue + 画板应用图标 | `src/components/ui/Icon.vue:1-27` 唯一出口；`src/utils/iconRegistry.ts:127`；但 `src/components/MessageItem.vue:57` 仍直连 13 个 lucide 图标 | 部分 | — | 见 R48：线宽/尺寸档统一；清直连 import |
| R03 | #3 桌面标题栏 / 列表页脚 / 空态按画板重构 | 标题 `src/components/TitleBar.vue:247` 40px；页脚 `src/components/ConversationList.vue:811-835` 实为 40px、仍带版本号；空态 `src/layouts/ResponsiveLayout.vue:1118-1203` 品牌 orb | 部分·与画板冲突 | 页脚 42px「任务中心 · N」+ chevron；版本号只在「关于」 | 见 P0-1 |
| R04 | #4 移动端顶栏 / 搜索行 / TabBar / 空态 | `src/components/MobilePageFrame.vue:53-85` 顶栏与标题；`src/style.css:107` `--gosslan-mobile-tabbar-h: 3.5rem`（56px） | 已实现 | — | 无 |
| R05 | #5 独立窗口 / 浮层按画板重构 | `src-tauri/src/commands/logs.rs:777,793-794` 设置窗口 780×600、最小 560×420；`src/components/SettingsWindow.vue:246` 200px 左栏；桌面导航仅 4 容器 `src/utils/settingsManifest.ts:200-205` | 部分·与画板冲突 | 桌面 9 个同级分区（个人资料/通用/外观/聊天样式/通知/网络/存储与文件/关于/重置） | 见 P0-2 |
| R06 | #6 状态 / 边界 / 字号 / i18n 与验收收口 | 两册键集对称：本轮脚本实测 `zh=1683 en=1683`、`onlyZh=0 onlyEn=0`（`node -e` 正则比对，无需依赖）；错误档 `src/components/ui/StateBlock.vue:81` | 已实现 | — | 无 |
| R07 | #7 标题栏 40 / 头像簇 / 画板字阶 | `src/style.css:283` `--gosslan-title-h: 40px`；`TitleBar.vue:247`；右上簇 `TitleBar.vue:283` `pr-1.5`（6px） | 已实现 | — | 无 |
| R08 | #8 会话列表标题行 / 搜索行 / 行内字号 | 标题行 `ConversationList.vue:461-477`；搜索行 `:515-586`（`h-[50px]`、`rounded-md`、`field-border`）；行内 `conversation/ConversationListItem.vue:160,212,264`（`text-title desktop:text-row`、`text-fine`） | 已实现 | — | 无 |
| R09 | #9 应用图标三平台产物按画板重出 | `src-tauri/icons/icon.icns` 41,457B / `icon.ico` 4,368B / `icon.png` 512×512；`designs/gosslan-redesign/brand/png/app-icon-1024.png` 与 `icons/icon-source.png` 同哈希（`97510482…`） | 已实现 | — | 无 |
| R10 | #10 设置各分区卡片内边距统一 | `src/style.css:355` `--gosslan-card-pad: 16px`；`:2323-2325` `.settings-card-row{padding:var(--gosslan-card-pad)}`；`SettingsRow.vue:24` 统一挂类 | 已实现 | — | 无 |
| R11 | #11 群管理输入框在暗色+玻璃+浮动背景下看不清 | 字段 token `src/style.css:127-139`（亮 `field-border=#7c8798`）、`:515-525`（暗 `#788dae`）；契约 `src/utils/tokenContrast.ts:253`（占位≥4.5）、`:259-262`（边框≥3.0）；但 `MessageComposer.vue:1166` 用 `border-[--gosslan-border]`+`bg-[--gosslan-panel]`，且暗色 `field-border` 在 `prefers-contrast: more` 覆盖块 `style.css:2402-2418` 里不抬升 | 部分 | 输入区在任意玻璃/对比档位都必须有可见边界 | P1：暗色 contrast:more 补 `field-border` 抬升；composer 边界改用字段 token 或登记例外 |
| R12 | #12 代码块固定 8 行、展开才滚 | `src/utils/previewMetrics.ts:30` `CODE_PREVIEW_LINES = 8`、`:159` `CODE_CLAMP_HEIGHT`；`MessageCodeBubble.vue:96,103` | 已实现 | — | 无 |
| R13 | #13 窄窗列表穿透 | `ResponsiveLayout.vue:943` `pane-under-chat`；`style.css:2525-2535` 移动/窄窗延迟隐藏 | 已实现 | — | 无 |
| R14 | #14 亮色层级方案 A（表面/薄纱分层） | `style.css:399-430`；`ambient-canvas-child` 用于主/列表/聊天 `ResponsiveLayout.vue:848,1033,1093` | 已实现 | — | 无 |
| R15 | #15 预览窗生命周期与全局单例 | 桌面独立单例窗口：`src-tauri/src/lib.rs:125` `WINDOW_PREVIEW`；`logs.rs:1181,1220` `ensure_aux_window`；移动端/不可交付才回落覆盖层 `src/utils/useImagePreview.ts:101-107` | 已实现（现行行为：桌面单例窗口 + 移动端覆盖层） | — | 无 |
| R16 | #16 toast = 结论 + 一句人话原因，长原因落页面内错误档 | `src/utils/errors.ts:352` 40 列上限、`:380-392` 超宽退回；`StateBlock.vue:81 role="alert"` 接线 `ChatWindow.vue:2037-2043`、`ConversationList.vue:66-67,787` | 已实现 | — | 无 |
| R17 | #17 预览状态图片四角是黑的：预览图绝对不许被切割 | 灯箱 `ImageLightbox.vue:769` `rounded-none object-contain`；stage `:755` 无圆角无 overflow；外壳 `:655-656` 无 `overflow-hidden`/clip；`:752` `v-if="src"` | 已实现（仅限「点开后的预览」） | 用户字面范围含「收藏/群任务/消息缩略图」，但缩略图仍裁 | 见 P2-12：先确认口径；灯箱链路保持不变 |
| R18 | #18 群任务「标签」下拉顶出窗口；全站同类浮层统一限高、内部滚动、末项可点 | 单一常量 `src/utils/popoverBounds.ts:18` `POPOVER_EDGE=8`；共享 CSS `style.css:2149-2178`；但 `POPOVER_EDGE` 只被 2 处使用（`TodoAttrField.vue:79`、`ui/SettingsSelect.vue:54`），`collision-padding="8"` 仍硬编码 13 处（`ConversationList.vue:494,544`、`MessageComposer.vue:1326`、`MessageItem.vue:1833`、`ChatSearchDialog.vue:463,496`、`ContextMenu.vue:87`、`GroupTasksBoard.vue:1888` 等）；`ActionSheet.vue:162` 自写 `max-h` | 部分 | 功能已挡住顶出；口径要「全站一个来源」 | P1-7：13 处字面量收口到 `POPOVER_EDGE`；`ActionSheet` 并入共享类 |
| R19 | #19 滚动条出现/不出现宽度一致、「关于」偏小、有滚动条时视觉偏左 | `style.css:877-885` `scrollbar-gutter: stable` + `.scrollbar-both{stable both-edges}`；`:1769-1794` 8px 轨道/4px 滑块；`:309-314` 明令删除旧 `--gosslan-scroll-gutter` 补宽 hack；设置内容区 `SettingsWindow.vue:279` `scrollbar-both` | 已实现 | — | 残余：`VirtualList.vue:902`、`EmojiPicker.vue:136` 只吃单侧 `stable`；不产生位移，但与 §14.14「视觉中心不偏」不一致（P2-11 可选） |
| R20 | #20 焦点环被左边界裁切 + 内容视觉居中 | 全局环 `style.css:1079-1082` `outline 2px + offset 1px`；文本输入改内描边 `:1093-1098`、`:1102-1105`；全仓唯一 `ring-*` 两处均为 `ring-inset`（`MessageItem.vue:1723,1970`） | 已实现 | — | 残余：`GroupTasksBoard.vue:1321`/`TaskCenter.vue:401` 的 `pr-0.5`（2px）若未来改回外扩环会裁 1px；SC-01 已禁止外扩环，建议在判据里补一条「滚动容器内距 ≥ ring 外扩」 |
| R21 | #21 输入区与消息区同一整块背景；不许独立实色面板/分隔线/第二层底；安全区按实测高度让位 | 外壳 `ChatWindow.vue:2169-2170` `absolute bg-transparent`、无 `border-t`/阴影；高度 `:653-664` ResizeObserver；消息区让位 `:1993-1995`；注释 `:2156-2165` | 已实现（布局层面） | 输入卡仍是独立卡片（半径 10）；画板要求外壳 22px | 见 R50 |
| R22 | #22 中心图标与圆角矩形同心 | `style.css:337-338` `orb-mark-44 = xl − 12`（=4px）、`-56 = xl − 6`（=10px）；orb 68px `ConversationList.vue:635`、`ResponsiveLayout.vue:1126-1132` | 已实现 | — | 底盘 16→20 见 R29 |
| R23 | #23 右上角窗口圆角/头像同心、左右间距相等 | `TitleBar.vue:256` 78px 让位（注释 = 13px 左距 + 3×12 + 2×8 + 余量）、`:283` `pr-1.5`（6px）；台账另有 devX/devY=0 读数，本轮未复跑 | 已实现 | — | 红绿灯纵向见 R29 |
| R24 | #24 群任务/预览/日志/启动错误四处结构差 | 用户拍板 B：维持现状 | 已实现（裁决） | — | 无 |
| R25 | #25 macOS `.icns` 无 dark/tinted | 用户拍板 B：维持现状，发版前再评估 | 已实现（裁决） | — | 无 |
| R26 | #26 七项画板妥协 | 五项保留（按钮圆角、LAN 字号、搜索壳、搜索字号、未读徽标）；两项转 #29 | 部分 | 见冲突表 A1 | 无（记录为「用户接受偏差」） |
| R27 | #27 这批是否并进一次 5.18.46 | 当前 `package.json:4` = 5.18.51，最新 tag 只有 `v5.18.35`；发版节奏未定 | 待拍板 | — | 由负责人拍板 |
| R28 | #28 rebase 最新 main、ff-only 合入并推；判据 3 按负责人接受 | `origin/main` = `353a634d`；`65ad570d` 已含 27 笔；判据 3 `presentation: 5 次` 记账在 `docs/notes/ui-pulse-redesign/change-budget-acceptance-2026-11-07.md` | 已实现 | — | 无 |
| R29 | #29 消除：orb 圆角 16→20、红绿灯纵向错位 | `style.css:328` `--gosslan-radius-xl: 16px`；`:324-329` 六档 6/8/10/14/16；`TitleBar.vue:246-256` 无纵向偏移处理；`macos_window.rs:94-112` 只 setHidden | 未做 | orb 底盘 20px，`orb-mark-44/-56` 内距同步改 8/14；红绿灯与 40px 标题栏居中对齐 | P0-5 见落地清单 |

### B. unslop 审查（2026-11-06）与窄窗白条

| 编号 | 需求（用户原话要点） | 当前实现证据 | 状态 | 若冲突按用户口径应该是怎样 | 落地动作 |
|---|---|---|---|---|---|
| R30 | 色雾：桌面保留 4 层原样，移动端降档 | `report.md:209-212`；`src/utils/ambient.ts:86-94` 写入；`style.css:642-670` 三态；`style.css:2546-2550` reduce/contrast/forced-colors 隐藏 | 已实现 | — | 无 |
| R31 | 消息骨架改静态，不再循环脉冲 | `ChatWindow.vue:2009-2010` `data-msg-skeleton` + `gosslan-skeleton-in`；`MessageImageBubble.vue:187-188` `data-img-skeleton`；守卫 `designGuards.ts:2778-2821` SK-01 | 已实现 | — | 无 |
| R32 | 搜索命中黄色 mark 换 token | `src/utils/highlight.ts:14` `bg-[var(--gosslan-primary-light)] text-[var(--gosslan-text)]` | 已实现 | — | 无 |
| R33 | 搜索框焦点框：按用户裁决保留键盘可达性现状 | `style.css:1093-1098` 文本输入内描边；`report.md:230-233` | 已实现（裁决） | — | 无 |
| R34 | 页脚版本号：保留还是移到「关于」（用户已于 11-06 答「移到关于」） | 页脚仍渲染版本 `ConversationList.vue:834`（注释 `:815` 明确「判据要求页脚可见 vX.Y.Z」）；「关于」也有版本 `settings/AboutSection.vue:77` | 未做·与画板冲突 | 页脚只留「任务中心 · N」；版本只在关于（用户确认见 `decisions.md:213`） | P0-1 |
| R35 | 双 CTA 只统一规格、不删 | 空态双入口 `ConversationList.vue:654-666`（`PrimaryBtn` + 文字「建群」）；`f3812e05` | 已实现 | — | 无 |
| R36 | A1：toast 短句 + 页面内错误档 | `errors.ts:352,380-392`；`StateBlock.vue:81` | 已实现 | — | 无 |
| R37 | 自愈横幅改独立占位行、不遮内容 | `App.vue:358-359` `#banner`；`ResponsiveLayout.vue:904` `<slot name="banner" />`；`RecoveryNotice.vue` | 已实现 | — | 无 |
| R38 | 空态去通用图标 | `StateBlock.vue:44` 注释记录旧 `ImageOff` 已移除，模板中无该图标；但列表/主区空态仍有 68px 品牌底盘 | 已实现 | 品牌 orb 是用户 #22 明确要的，不算「通用插画」 | 见冲突表 B10：登记 G-13 例外 |
| R39 | 失败态文案：去双后缀、标题=说明、添加好友弹窗 | `zh-cn.ts:1426`「扫描失败」、`:1459`「通道开启失败」；`report.md:200-205` | 部分 | — | P2-13：`errorText` 全局口径仍未动（报告自述「避免面过大」） |
| R40 | 窄窗流动背景白条（只在 5.18.34） | 修复 `66d38da9` 已在 main；最新 tag `v5.18.35`，线上已消失 | 已实现且已发版 | — | 无 |
| R41 | 日志页可读性 + 合并开关 + 悬空分隔点 | `f6c854e1`；`LogViewer.vue:392-424` | 已实现 | — | 无 |
| R42 | 色板同形、小节标签去全大写、emoji 浮层投影 | `e00c0daa`；`rg -n uppercase SettingsPanel.vue conversation/FriendRequestList.vue` = 0 命中 | 已实现 | — | 无 |
| R43 | 气泡对比度（对方最重/自己最轻） | `src/utils/chatStyle.ts:31-50` 各主题 `otherBubble` 已加深（亮 `#aab5c2`）；`076e72c3` | 已实现 | — | 与 R47 的实色口径分开处理 |

### C. 设计稿 + 用户已确认的 5 项（尚未进台账的偏差）

| 编号 | 需求（用户原话要点） | 当前实现证据 | 状态 | 若冲突按用户口径应该是怎样 | 落地动作 |
|---|---|---|---|---|---|
| R44 | 设置桌面 9 分区双栏（用户 11-06「3 可以」） | `settingsManifest.ts:200-205` 桌面仍只有 `general/network/storageFiles/about` 4 容器；9 项只存在于移动端 `:43-53`；`SettingsWindow.vue:286-303` 按 4 容器渲染；用户确认见 `decisions.md:214` | 未做·与画板冲突 | 桌面左栏 9 项，与移动端同名同序 | P0-2 |
| R45 | 单聊无头像列 + 自己气泡 accent 实色白字（用户 11-06「4 可以」，`decisions.md:215`） | 无头像列已满足 `MessageItem.vue:982,1719`；但亮色自己气泡是浅底深字 `chatStyle.ts:146-161`（luma 207），只有暗色是实底白字 `:162-169` | 部分·与画板冲突 | 亮/暗都 accent 实色 + 白字 | P0-3；先复测白字对比度，<4.5 则保留现状并记录 |
| R46 | 群聊头像 24px（用户 11-06「5 可以」，`decisions.md:101,215`） | `style.css:377` `--gosslan-msg-avatar: 30px`；`MessageItem.vue:1731` 直接用该 token | 未做·与画板冲突 | 24px，昵称 11px 不变 | P0-4 |
| R47 | 气泡 36px（8+20）、组内 2px、换组 12px、最宽 68% / 560px；对方 `bubble-in`+1px 边界 | `MessageTextBubble.vue:169` `py-1.5 leading-normal` → 实测约 35px；`messageHeight.ts:45` `GAP_BASE=4`；`MessageItem.vue:1620,1698` 组内 4/组间 10；`style.css:378` `--gosslan-msg-max: 78%`（无 560 上限） | 部分·与画板冲突 | 36 / 2 / 12 / 68% / 560px，桌面与移动同一口径 | P0-3 |
| R48 | 图标线宽 1.75；尺寸 14/16/20/22（rail）/24（空态），导航 22 | `Icon.vue:27` 线宽 `size===16?1.8:2`；`navIcons.ts:26-28` rail 23 / tab 21；`ResponsiveLayout.vue:1300` 显式 1.9/2.35 | 未做·与画板冲突 | 1.75 统一，rail 22，聊天头 20 | P1-6 |
| R49 | 设置行高 48px | `style.css:2323-2325` `padding:16px` 推出约 52px（`CHANGELOG.md:148-155`、`style.css:347-348`） | 部分·与画板冲突 | 48px | P1-6；注意 `decisions.md:120` 自己写「行高 52px」，需先裁定 48/52 |
| R50 | 输入外壳 22px（同心圆角：控件 10 / 卡片 16 / 气泡 20 / 外壳 22） | `MessageComposer.vue:1166` `rounded-[var(--gosslan-radius-md)]` = 10px；设计 token `tokens.json:138` `radius-2xl: 22px`「composer shell」 | 未做·与画板冲突 | 22px，并保持外壳/卡片同心 | P1-6；重标定 CS-02 |
| R51 | 首屏骨架与真实布局同步（标题栏 40） | `src/boot/skeleton.css:83` `.boot-cap{height:38px}`；`:166-167` `html.is-mac .boot-cap{height:28px}`；列表 320/行高 62 已同步 `:110,185-189` | 部分·与画板冲突 | 三平台首屏标题栏 40px | P1-9；重标定 SK-01 |

**计数**：共 51 条。已实现 **33**，部分 **11**，未做 **6**，待拍板 **1**。其中与画板/用户已确认口径冲突 **11** 条（R03、R05、R34、R44、R45、R46、R47、R48、R49、R50、R51）。

---

## 二、冲突表

### 表 A：用户需求 vs 画板（裁决 = 用户优先）

| # | 冲突点 | 用户口径（原话要点） | 画板口径 | 裁决与依据 | 落地下场 |
|---|---|---|---|---|---|
| A1 | 按钮圆角 8 vs 9 | #26「其余五项保留」 | 9px | 用户优先；现有 ㊴ 只认 `--gosslan-radius-*`（md 10 / lg 14 / xl 16），tasks.md:37 | 不改；记录为接受偏差 |
| A2 | LAN 字号 11 vs 10.5 | #26 保留 | 10.5px | 用户优先；字号只有 15/14/13/12/11 五档，11 是正文档下限 | 不改 |
| A3 | 搜索壳 36 vs 34 | #26 保留 | 34px | 用户优先；36 对齐 ⑧ 的 44pt 点按目标派生口径 | 不改 |
| A4 | 搜索字号 13 vs 12 | #26 保留 | 12px | 用户优先；同 A2 | 不改 |
| A5 | 未读徽标 16/11 vs 18/10.5 | #26 保留 | 18px/10.5 | 用户优先；同 A2 | 不改 |
| A6 | 群任务/预览/日志/启动错误四处结构 | #24 拍板 B「维持现状」 | 分栏+标签页+优先级图标等 | 用户优先 | 不加功能 |
| A7 | macOS `.icns` dark/tinted | #25 拍板 B | 支持 macOS 26 双态 | 用户优先 | 发版前再评估 |
| A8 | Windows 11 窗口圆角 | #23 拍板 A「等距 fallback，不做伪同心」 | 同心补偿 | 用户优先 | 不改 |
| A9 | 中心图标处理 | #22「同心圆角（或充满裁切）」二选一 | 画板画法未限定 | 用户选同心圆角 | 已落 R22 |
| A10 | 滚到底呼吸空间 | #21 拍板 A 保留 32px | 画板未给该值 | 用户优先 | 不改 |

> 表 A 没有「画板直接击穿可读性/可访问性」的条目；A1–A5 的现有实现都由具名判据挡着，属于「用户主动接受偏差」，不是漏做。

### 表 B：画板 vs 现有判据 / 令牌 / 实现常量（裁决 = 画板优先，除底线）

| # | 冲突点 | 画板口径 | 现有判据/令牌 | 裁决与依据 | 需重标定 |
|---|---|---|---|---|---|
| B1 | 输入外壳圆角 | 22px（`tokens.json:138`、`decisions.md:225`） | CS-02 要求 `rounded-[var(--gosslan-radius-md)]`（10px） | 画板优先；22px 不影响阅读性 | **CS-02** |
| B2 | 列表页脚 | 42px「任务中心 · N」+ chevron，版本号移走（`decisions.md:62,213`） | `scripts/check-ui-runtime.mjs:20264`「页脚同时显示版本号 vX.Y.Z」；`ConversationList.vue:815` 注释 | 画板 + 用户已确认优先 | **`check-ui-runtime` 页脚版本判据（20264）** |
| B3 | 气泡几何 | 36px / 组内 2 / 换组 12 / 68% / 560px（`decisions.md:81`） | `messageHeight`/`previewMetrics` 常量：`GAP_BASE=4`、`TEXT_BUBBLE_PADDING=12`、`--gosslan-msg-max:78%` | 画板优先；须同步估高，否则虚拟列表跳动 | **`messageHeight.ts`、`previewMetrics.ts` 及对应测试** |
| B4 | 群聊头像 | 24px（`decisions.md:101`） | `--gosslan-msg-avatar: 30px`（`style.css:377`）+ `NICKNAME_ROW=18` | 画板 + 用户已确认优先 | **`--gosslan-msg-avatar`、`messageHeight.ts`** |
| B5 | 图标刻度 | 1.75px；rail 22（`decisions.md:153`） | `Icon.vue:27` 2/1.8；`navIcons.ts:26-28` 23/21 | 画板优先 | 无编号判据；改 `Icon.vue`/`navIcons.ts` |
| B6 | 设置信息架构 | 桌面 9 分区（`decisions.md:118,214`） | 桌面 4 容器 `settingsManifest.ts:200-205` | 画板 + 用户已确认优先 | 不涉判据；`settingsManifest` 测试随改 |
| B7 | 设置行高 | 48px（`decisions.md:224`） | 52px（`style.css:2323-2325`）；但 `decisions.md:120` 自己写 52 | **设计内部冲突**，建议以更晚的 v2.2 48px 为准 | — |
| B8 | orb 底盘圆角 | 20px（#29 用户拍板） | `--gosslan-radius-xl:16px`；CN-01/CN-02 数字 4/10 | 用户拍板优先 | **CN-01、CN-02**（4/10 → 8/14） |
| B9 | 首屏骨架标题栏 | 40px（HANDOFF 同步要求） | `skeleton.css:83,166-167` 38/28 | 画板优先 | **SK-01** |
| B10 | 空态 | 品牌底盘 orb（用户 #22 要同心） | `ux-criteria.md:37` G-13「空态不画通用插画」 | 用户/画板优先；品牌底盘不是通用 NavIcon，但需显式登记例外 | **G-13** |
| B11 | 预览图圆角 | 0（用户 #17） | IP-01 要求 `object-contain` 的 `<img>` 必须带圆角 | 用户优先；IP-01 当前只扫 `FavoritePanel`/`MergeCardModal`/`MessageImageBubble`，不扫灯箱 | **IP-01**：补「灯箱显式豁免」说明，避免未来重扫误红 |

**需要重标定的判据编号（汇总）**：`CS-02`、`CN-01`、`CN-02`、`SK-01`、`G-13`、`IP-01`；非编号判据 3 处：`check-ui-runtime.mjs:20264` 页脚版本号、`messageHeight/previewMetrics` 常量、`Icon.vue/navIcons.ts` 刻度。
**明确不重标定**：`㊴`（圆角只认 token）、`⑧`（44pt 点按）、字号五档 —— 这三组是用户主动保留的实现，改它们会违背表 A。

---

## 三、重点 8 项复核（用户反复提过）

| 关注点 | 代码事实 | 结论 |
|---|---|---|
| 1. 群任务表单框/焦点环被滚动容器裁切 | 滚动容器 `GroupTasksBoard.vue:1321` `scrollbar-both overflow-y-auto pr-0.5`（右侧 2px）；输入区 `:1747` 用 `rounded-md border border-[--gosslan-field-border] focus:border-[--gosslan-primary] outline-none`；文本控件全局走内描边 `style.css:1093-1098`；SC-01 全仓禁止外扩环 | **已消除**。残余：`pr-0.5` 只有 2px，任何未来改回的外扩 outline（2+1px）会被裁 1px；建议在判据里补「滚动容器内距 ≥ 3px」 |
| 2. 有滚动条时内容视觉偏左 | `style.css:877-885` 全局 `stable`；设置/日志/群任务/会话列表/搜索/收藏/转发/BaseModal 全用 `scrollbar-both`（`SettingsWindow.vue:279`、`LogViewer.vue:424,578`、`ConversationList.vue:605`、`ChatSearchDialog.vue:585`、`FavoritePanel.vue:759,846`、`ForwardModal.vue:125`、`BaseModal.vue:247`） | **已消除**。`VirtualList.vue:902`、`EmojiPicker.vue:136` 只单侧 `stable`，宽度不跳但视觉中心仍偏右 4px，属口径未完全统一 |
| 3. 「关于」无滚动分区与有滚动分区宽度不一致 | 设置窗口所有分区共用**同一个**滚动容器 `SettingsWindow.vue:279`，`scrollbar-both`；`style.css:877-885` 双侧留白 ⇒ 两个分区的 clientWidth 必然相同 | **已消除（同一容器 + 双侧留白）**。台账另有 764/764、文字 x 895/895 读数，本轮未复跑 |
| 4. 下拉浮层顶出窗口 | 共享类 `style.css:2149-2178` 用 Reka 可用高度 + `--gosslan-pop-edge:8px`；`popoverBounds.ts:18` 单一常量；`ActionSheet.vue:162` 自写；13 处仍硬编码 `collision-padding="8"` | **功能已消除，口径未收口**（`POPOVER_EDGE` 只 2 处引用） |
| 5. 图片预览四角被裁 | 灯箱 `ImageLightbox.vue:769` `rounded-none object-contain`；外壳 `:655-656` 无 clip；缩略图 `MessageImageBubble.vue:168,223` 仍 `overflow-hidden` + 圆角 20，`TodoImageThumb.vue:160,174` 仍 `overflow-hidden` + `object-cover` | **预览链路已消除**；缩略图按容器裁是既有口径，若用户「预览图」包含缩略图则判未做 |
| 6. 输入区与消息区是否真连成一整块 | 外壳 `ChatWindow.vue:2169` `absolute inset-x-0 bottom-0 bg-transparent`，无 `border-t`/阴影；`ambient-canvas-child` 保证薄纱下同画布；让位 `:653-664,1993-1995`；输入卡自身 `MessageComposer.vue:1166` 仍是 `panel` 底 + `border` + 10px 圆角 | **布局已连成一整块**；「输入卡」仍是一张浮起的小卡片，画板要求外壳 22px（B1） |
| 7. 同心几何 | orb 68px / xl16，44px 标记 4px、56px 标记 10px（`style.css:337-338`）；右上簇 6/6（`TitleBar.vue:283`）；台账报 devX/devY=0（本轮未复跑） | **已达成**；#29 的 16→20 与红绿灯纵向仍未做 |
| 8. 特效全开时输入框与正文可读性 | 字段 token 与对比契约 `tokenContrast.ts:253,259-262`；`check-ui-runtime` `--only=fieldcontrast` 断言边框≥3.0、占位≥4.5；暗色 `prefers-contrast:more` 块不抬 `--gosslan-field-border`；`MessageComposer` 不用字段 token，用 `--gosslan-border`+`--gosslan-panel` | **部分**。正文 token 未变、对比足够；输入边界在暗色高对比档与玻璃浮层下仍有残余风险 |

---

## 四、按优先级排序的落地清单

> 排序依据：用户已明确确认 > 用户拍板遗留 > 画板结构差 > 口径收口 > 文档/基线登记。
> 每条给「影响文件」与「验证方式」；验证命令均需在装了依赖的 worktree/主工作区执行（本审计 worktree 未装 `node_modules`，见文末）。

### P0（用户已确认或已拍板，先做）

| # | 动作 | 影响文件 | 验证方式 |
|---|---|---|---|
| P0-1 | 页脚版本号迁到「关于」；列表页脚改 42px「任务中心 · N」+ chevron | `src/components/ConversationList.vue:811-835`；`src/components/settings/AboutSection.vue:77`；`src/i18n/locales/{zh-cn,en-us}.ts`；`scripts/check-ui-runtime.mjs:20264`（重标定） | `node scripts/check-ui-runtime.mjs --only=footer`（重标定后应断言「页脚无 vX.Y.Z」）；`rg -n "v{{ version }}" src/components/ConversationList.vue` 应为 0 |
| P0-2 | 桌面设置左栏 9 分区，与移动端同名同序 | `src/utils/settingsManifest.ts:200-205`；`src/components/SettingsWindow.vue:246,286-303`；`src/i18n/locales/*` | 新/改 `settingsManifest` 单测断言 `DESKTOP_NAV.length===9` 且 `MOBILE_SECTIONS` 同名；窗口截图 780×600（亮/暗） |
| P0-3 | 单聊气泡：自己 accent 实色白字 + 36px / 组内 2 / 换组 12 / 68% / 560px | `src/utils/chatStyle.ts:146-169`；`src/components/message/MessageTextBubble.vue:169`；`src/components/MessageItem.vue:1620,1698,1782`；`src/style.css:378`；`src/utils/messageHeight.ts:45`；`src/utils/previewMetrics.ts:43-52` | `node --test src/utils/chatStyle.test.ts src/utils/messageHeight.test.ts src/utils/previewMetrics.test.ts`；亮色白字对比度 ≥4.5（`tokenContrast` 口径）；视觉夹具亮/暗各一屏 |
| P0-4 | 群聊头像 24px（昵称仍 11px） | `src/style.css:377`；`src/components/MessageItem.vue:1731`；`src/utils/messageHeight.ts:50` | 同上单测；`rg -n "gosslan-msg-avatar" src/style.css` = 24px |
| P0-5 | #29：orb 底盘 16→20，`orb-mark-44/-56` 内距改 8/14；红绿灯与 40px 标题栏纵向居中 | `src/style.css:328,337-338`；`src/layouts/ResponsiveLayout.vue:1126-1132`；`src/components/ConversationList.vue:635`；`src/components/TitleBar.vue:246-256`；`src-tauri/src/macos_window.rs:52-112` | `node scripts/check-ui-runtime.mjs --only=concentric`（重标定 CN-01/CN-02 为 8/14）；macOS 真机截图量红绿灯 top 与标题栏中线 |

### P1（画板结构/口径，靠现有守卫能验）

| # | 动作 | 影响文件 | 验证方式 |
|---|---|---|---|
| P1-6 | 同心圆角补齐：输入外壳 22px、设置行高 48px、图标 1.75/rail 22 | `src/components/chat/MessageComposer.vue:1166`；`src/utils/designGuards.ts` CS-02；`src/style.css:2323-2325`；`src/components/ui/Icon.vue:27`；`src/utils/navIcons.ts:26-28` | `node --test src/utils/designGuards.test.ts`（CS-02 重标定后）；`rg -n "strokeWidth" src/components/ui/Icon.vue` |
| P1-7 | 浮层限高收口：13 处 `collision-padding="8"` 改 `POPOVER_EDGE`；`ActionSheet` 并入 `.gosslan-pop-clamp` | `TodoAttrField.vue:79`、`ui/SettingsSelect.vue:54`、`ConversationList.vue:494,544`、`MessageComposer.vue:1326`、`MessageItem.vue:1833`、`ChatSearchDialog.vue:463,496`、`ContextMenu.vue:87`、`GroupTasksBoard.vue:1888`、`ActionSheet.vue:162` | `node scripts/check-ui-runtime.mjs --only=popclamp`；`rg -n 'collision-padding="8"' src` 应为 0 |
| P1-8 | 暗色高对比档抬 `field-border`；composer 边界改用字段 token 或登记例外 | `src/style.css:2402-2418,515-525`；`src/components/chat/MessageComposer.vue:1166` | `node scripts/check-ui-runtime.mjs --only=fieldcontrast`（暗色 `prefers-contrast:more` 多一格） |
| P1-9 | 首屏骨架标题栏 40（去掉 38/28 分叉） | `src/boot/skeleton.css:83,166-167` | `node --test src/utils/designGuards.test.ts`（SK-01 重标定）；首屏截图像素量 |

### P2（口径确认/文档登记）

| # | 动作 | 影响文件 | 验证方式 |
|---|---|---|---|
| P2-10 | 空态品牌 orb 登记为 G-13 例外 | `docs/design-language/ux-criteria.md:37`；`src/utils/designGuards.ts` G-13 | 文档 + 守卫注释；`rg -n "G-13" docs src` |
| P2-11 | `VirtualList`/`EmojiPicker` 补 `scrollbar-both`（可选） | `src/components/VirtualList.vue:902`；`src/components/EmojiPicker.vue:136` | `--only=scrollstable` 加两侧断言 |
| P2-12 | 缩略图是否也算「预览图」需用户一句话确认 | 无代码改动 | 用户答复即可；不改则记录口径 |
| P2-13 | `errorText` 全局口径是否继续收口 | `src/utils/errors.ts`、两册 i18n | `--only=errtext`；报告已说明「未做」 |
| P2-14 | 发版节奏（是否压一次 5.18.52） | `package.json`、四份版本清单、CHANGELOG | 由负责人拍板；`git tag --sort=-v:refname` 当前 `v5.18.35` |

---

## 五、未验证项（卡在哪）

1. `node scripts/check-i18n.mjs`、`node scripts/check-hardcoded-ui-text.mjs`、`node scripts/check-ui-runtime.mjs`、`npm test`、`node --test src/utils/designGuards.test.ts` **未执行**：本审计 worktree 是干净检出，未安装 `node_modules`，上述脚本报 `ERR_MODULE_NOT_FOUND`。为不在审计中写入依赖目录，没有执行 `npm install`。
2. 因此本文的 UI 读数均为**源码级**证据；台账里的 `--only=*` 绿读数**未被复跑**，只在冲突处引用其口径。真正落地某条时，必须在装了依赖的环境重跑对应 `--only`。
3. 红绿灯纵向偏移的真实像素值需要 macOS 真机截图；本审计只核到「代码里没有任何纵向偏移处理」（`macos_window.rs:52-112`、`TitleBar.vue:246-256`）。
4. 移动端 360/390/430 三档未跑真机/截图；R04 只核到组件与 token 存在，未做像素级对照。
