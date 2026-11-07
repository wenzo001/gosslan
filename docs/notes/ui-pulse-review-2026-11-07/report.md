# UI Pulse 重构独立审查报告（8130a4ee..353a634d）

- 审查对象：`origin/main` 尖端 `353a634d`，28 笔提交
- 审查方式：`git worktree add --detach /Users/wendongfu/Documents/code/gosslan-ui-review-353a634d 353a634d`，全程只读；用户主工作区未触碰
- 基线读数（在审查 worktree 内实跑）：
  - `node --test --experimental-strip-types src/utils/designGuards.test.ts` → **322 pass / 0 fail**
  - `node --test --experimental-strip-types src/utils/tokenContrast.test.ts` → pass
  - `git log --oneline 8130a4ee..353a634d -- src/boot/skeleton.css index.html` → 空（**首屏骨架在本区间内没有被改过**，这是下面 M-1 的前提）
- 已知且按约定不报：Change Budget 判据 3 恒红、orb 16→20 与红绿灯纵向、四个独立窗口结构性差异、macOS `.icns` 缺 dark/tinted

分级口径：Blocker = 用户能稳定撞到且界面不可用；Major = 每次/常见路径可见的回归或守卫失效；Minor = 局部偏差、可记账。

---

## Blocker

### B-1 桌面窗口拖到最小宽度时，聊天区宽度归零（`--gosslan-list-w` 250→320 的连带后果）

**症状**：桌面布局 `rail(64) + aside(320)` 已是 384px，而主窗口 `minWidth` 只有 360px。aside 是 `shrink-0`，`<main>` 是 `min-w-0 flex-1` ⇒ 宽 360 时 main 被压到 0px，右侧聊天区完全看不见，只剩列表横向溢出 24px。用户把窗口拉窄后（窗口尺寸会被记住）再启动就是这副样子。

**证据**
- `src-tauri/tauri.conf.json:27` `"minWidth": 360`（默认 `width: 1000`，`:25`）
- `src/layouts/ResponsiveLayout.vue:803-806` `RAIL_W = 64`、`LIST_W_MIN = 280`、`LIST_W_DEFAULT = 320`
- `src/layouts/ResponsiveLayout.vue:934` `<aside class="ambient-canvas h-full shrink-0 ...">`
- `src/layouts/ResponsiveLayout.vue:1003` `<main class="ambient-canvas flex h-full min-w-0 flex-1 ...">`
- `git diff 8130a4ee..353a634d -- src/layouts/ResponsiveLayout.vue`：`LIST_W_MIN 200→280`、`LIST_W_MAX 420→400`，并新增 `LIST_W_DEFAULT = 320`；`src/style.css:265` `--gosslan-list-w: 320px`
- 区间前默认列宽 250 ⇒ `64+250=314`，360px 下 main 还有 46px；现在 `64+320=384`，main 恒为 0

**复现**：桌面平台 → 把主窗口拖到最窄（360）→ 结论是右侧聊天区实测宽度 0、列表右侧被裁。无真机截图，纯几何推算，但四处数值都是现读的，算术可复算。

**建议修法（二选一，倾向后者）**
1. 把 `listW` 运行时夹到可用宽度：`Math.min(listW, window.innerWidth - RAIL_W - 360)`，窗口再窄就自动收到 `LIST_W_MIN` 以下；或
2. 把主窗口 `minWidth` 提到 `RAIL_W + LIST_W_MIN + 360 ≈ 704`（并把默认宽度同步上调），让"列表常驻"的假设在配置层成立。
   同时补一条守卫：断言 `tauri.conf.json minWidth ≥ RAIL_W + LIST_W_MIN + 320`，把这类"结构常量 vs 窗口常量"漂移变成红灯。

---

## Major

### M-1 首屏骨架与真实布局三处漂移（`--gosslan-title-h` 38→40 与左栏 50px 标题行都没同步）

**症状**：启动瞬间的骨架按旧尺寸画，真实 UI 挂载后跳位：
1. macOS：骨架标题栏 28px，真实 `--gosslan-title-h` 40px ⇒ **跳 12px**（且 macOS 的 28px 覆盖在本区间已被删除）；
2. 全平台：骨架 `.boot-cap` 38px，真实 40px ⇒ 跳 2px（不是主因，列在此处只为说明它不再是 38）；
3. 左栏：真实桌面列表是 `50px 标题行 + 42px 搜索行`，骨架 `.boot-list` **只有搜索条**，没有任何标题行 ⇒ 会话行整体比真实位置高 **50px**，每次冷启动都跳。

**证据**
- `src/style.css:283` `--gosslan-title-h: 40px`；`src/style.css:297` 注释明写"两个平台统一 40px（2026-11-06 去掉 macOS 的 28px 覆盖）"
- `git diff 8130a4ee..353a634d -- src/style.css`：`-- --gosslan-title-h: 38px` / `++ 40px`，并删除 `.platform-mac` 的 28px 覆盖
- `src/boot/skeleton.css:82-88` `.boot-cap { height: 38px }`
- `src/boot/skeleton.css:165-168` `html.is-mac .boot-cap { height: 28px }`，其上注释仍写"与 style.css 的 `.platform-mac` 覆盖一致"——那个覆盖在本区间已被删除，注释指向不存在的对象
- `index.html:16` 骨架说明仍写"caption 38"，与 40 不符
- `src/components/ConversationList.vue:509-515` 桌面列表头 `h-[50px]` + 42px 搜索行；`index.html` 的 `.boot-list` 内只有 `.boot-search`（无标题行）
- `src/boot/skeleton.css:141-143` `.boot-head { height: 52px }` 与 `--gosslan-header-h: 52px` 一致（右栏这部分是对的，说明作者只对了右栏）
- 守卫缺失：全仓没有任何测试比对 `.boot-cap` / `.boot-list` 与 `--gosslan-title-h` / 列表头高度（`grep -rn "boot-cap" src scripts --include=*.ts --include=*.mjs` 无命中）

**复现**：`git log --oneline 8130a4ee..353a634d -- src/boot/skeleton.css index.html` 返回空 ⇒ 骨架在本区间内零改动，而上面三处尺寸在本区间内变了。结构差从 DOM 与 CSS 数值直接可读。

**建议修法**
1. `.boot-cap` 改 `40px`（`calc(40px + env(safe-area-inset-top))` 同步，`:136-139`），删掉 `:165-168` 的 `is-mac` 覆盖及过期注释，改 `index.html:16` 注释为 40；
2. `.boot-list` 增加 50px 标题行占位（与 `ConversationList.vue:515` 同一几何）；
3. 补一条"骨架↔真实"守卫：把 `--gosslan-title-h`、`--gosslan-header-h`、列表标题行高、`--gosslan-list-w` 在 `style.css` 里的值与 `index.html`/`skeleton.css` 的对应值做文本比对，任一侧对不上即红（这类"首帧跳"是项目既有约定，见 `src/style.css:272-274` 的显式要求）。

### M-2 ㊶（卡片内边距只许三档）对任意值/单轴写法空转

**症状**：守卫只认 `p-3..6`、`py-3..6`、`px-4..6`，以下三种写法实测**全绿**：`p-[16px]`、`px-[16px]`、`pt-4 pb-4`、`!p-4`。本仓库恰好在别处大量使用任意值语法（`h-[68px]`、`rounded-[var(...)]`），所以这不是理论漏洞，是随手就会踩进去的洞。

**证据**（突变实测，改真实文件后跑守卫再复原）
- `src/utils/designGuards.ts:3655` 起 `RAW_CARD_PADDING_TOKEN_RE` 只匹配整 token
- 在 `src/components/settings/AboutSection.vue` 注入 `class="p-[16px]"` → `node --test --test-name-pattern "㊶"` **GREEN**（判据未红）
- 注入 `class="pt-4 pb-4"` → **GREEN**
- 注入 `class="px-[16px]"` → **GREEN**
- 对照组：守卫本身有效——同一份文件里写 `px-4 py-3` 会红；`㊶` 真实树用例分母现算（`designGuards.test.ts:7341` 断言 `>= 17`，实测 17）

**建议修法**：把正则扩成"任意前缀 + 数值/任意值"四类：`^(p|px|py|pt|pr|pb|pl|ps|pe|gap)?` 的 `p*` + `[0-9.]+|\[.*\]`，并显式允许 `!` 前缀；加三条夹具（`p-[16px]`、`pt-4 pb-4`、`!p-4`）作为反例自证。

### M-3 设置三档共用类没有覆盖外壳，散值从门口漏过去

**症状**：17 个设置分区确实收敛到 0 散值，但移动端设置一级列表的外壳还写死的 `p-4` / `px-4 py-3`；而 ㊶ 只扫 `src/components/settings/`，外壳在 `src/components/SettingsPanel.vue`，恰好不在扫描域。

**证据**
- `src/components/SettingsPanel.vue:217` `<div class="p-4">`、`:234` `px-4 py-3`
- `src/utils/designGuards.test.ts:7334` 扫描目录写死 `../components/settings/`；`:7341` 断言样本数 `>= 17`
- 把判据正则 rę对 `SettingsPanel.vue` 实跑 = 命中 2 条

**建议修法**：外壳两处改用 `settings-group` / 三档类；把扫描域从 `components/settings/` 提到 `components/` 并只按文件名 `Settings*`+`settings/` 收口（或维护一份显式白名单，新增设置页必须先登记）。

### M-4 图标仍是两条并行出口，同 6 个 glyph 定义两遍

**症状**：本批建立了 `iconRegistry.ts` + `Icon.vue` 作为唯一出口，但旧 barrel `icons.ts` 没删，且两处登记同一批 lucide 组件；22 个文件同时 import 两者，`MessageItem.vue` 更是在同一文件里"直连 lucide + 走 barrel"。

**证据**
- `src/components/ui/icons.ts:15` 单行再导出 `AlertCircle/Check/ImageOff/Loader2/RotateCcw/Trash2/X`
- `src/components/ui/iconRegistry.ts:130/183/192/210/231/242` 把同 6 个组件以 kebab 键再登记一次
- `grep -rl "ui/icons" src --include=*.vue | wc -l` = 34；`grep -rl "ui/Icon" ... | wc -l` = 50；交集 22
- `src/components/message/MessageItem.vue:57` 直连 14 枚 lucide，`:58` 又从 barrel 引 `Check, ImageOff`
- `git log --oneline 8130a4ee..353a634d -- src/components/ui/icons.ts` = 0（旧实现零改动地被留下）

**建议修法**：registry 补 `check` 键 → 删 `icons.ts` → 逐个替换 34 个 import 点。用 `check-hardcoded-ui-text` 同款"索引存在但对象不存在"的反例夹具防回归（新增 `Icon name="..."` 时 registry 缺键即红——已有对应守卫的话确认它覆盖 `check`）。

### M-5 `Icon.vue` 的 16/20/24 三档与 1.8 描边是死代码

**症状**：`size` prop 真实调用点为 0；191 个 `<Icon>` 里 137 个用 `h-*` class 覆盖尺寸，`size === 16 ? 1.8 : 2` 分支永不执行。文档（HANDOFF 136 行"16px 时描边 1.8"）写的是这套，实际全站在 class 层面调尺寸，描边恒为 2。

**证据**
- `src/components/ui/Icon.vue:19` 声明 `size?: 16 | 20 | 24`；`:27` `strokeWidth = size === 16 ? 1.8 : 2`
- `grep '<Icon...size='` = 0；`grep '<Icon' src --include=*.vue | wc -l` = 191
- 覆盖档分布：`h-4`=59、`h-3.5`=47、`h-5`=15、`h-3`=13（`grep -o` 计数）

**建议修法**：要么删 `size`/`strokeWidth` 并把 1.8 挪到 class 层（`.icon-16 { stroke-width: 1.8 }`），要么让尺寸只走 `size` 并批量删 `h-*`。现状是"文档规定一种、实现走另一种"，属于同一规则的平行定义。

### M-6 浮层限高只是名义上统一

**症状**：`popoverBounds.ts` 只有 2 个真实消费点，13 处浮层仍硬编码 `collision-padding="8"`；@成员下拉完全在体系外（`max-h-44`=176px 写死），CSS 兜底用 `100vh` 而不是 `100dvh`（唯一用 `100dvh` 的是 `ActionSheet.vue:162`）。

**证据**
- `src/utils/popoverBounds.ts:18,21` 仅 2 个导出；消费点 `src/components/ui/SettingsSelect.vue:54`、`src/components/TodoAttrField.vue:79`
- `grep 'collision-padding="8"' src --include=*.vue` = **13**
- `src/components/chat/MessageComposer.vue:1170` `class="frost ... max-h-44 overflow-y-auto ..."`
- `src/style.css:2172-2173` 兜底 `calc(100vh - var(--gosslan-pop-edge) * 2)`
- `POPOVER_EDGE_TOKEN` 全仓 0 消费（死导出）

**建议修法**：13 处改 `POPOVER_EDGE`；mention 下拉挂 `.gosslan-pop-clamp`；兜底改 `100dvh`；删死导出。**未验证**：Reka 是否真的写 `--reka-popper-available-height`（worktree 无 `node_modules`，无法确认；若未写，现在只剩 `100vh` 兜底，780×600 的独立窗口里限高等于没做）。

### M-7 "内容区去玻璃"决策未落地，且降级开关 `data-frost` 全仓没有写入点

**症状**：`decisions.md` 决策 0 写"内容区不再有玻璃，只有标题栏/移动底栏保留一层"。实际组件里 `frost` 仍有 20 处，其中 `BaseModal` 自身是 `glass-3`，其内部菜单再叠 `.frost` = 同屏 2 层 `backdrop-filter`；图片预览用整视口 `glass`。另外 `html[data-frost="off"]` 的降级规则存在，但应用侧**没有任何 setAttribute**——它只能从 devtools 手动触发，"真机长帧时的退路"并不存在。

**证据**
- `grep -ro frost src/components --include=*.vue | wc -l` = **20**
- `src/components/BaseModal.vue:199` `glass-3`；`src/components/chat/MessageComposer.vue:1170`、`src/components/GroupTasksBoard.vue` 菜单等在同一弹层内用 `.frost`
- `src/components/message/ImageLightbox.vue:655` `class="glass fixed inset-x-0 bottom-0 top-[var(--gosslan-safe-top,0px)] ..."`（全视口背板）
- `src/style.css:1664-1669` 定义了 `html[data-frost="off"] .frost`
- `grep -rn "data-frost" src --include=*.ts --include=*.vue` 只有守卫/探针，无 `setAttribute`
- `src/components/ToastList.vue:39` 裸 `backdrop-blur-sm`，既不匹配 `.frost`，也不在 `style.css:2333-2360`（reduced-transparency 逐类名降级）的覆盖里

**说明**：本区间 `git diff 8130a4ee..353a634d | grep backdrop-filter` 在 `src/` 命中 0 处新增 ⇒ 玻璃是存量，不是本批引入。但本批把这条决策写进了文档、又在设置/独立窗口做了"去玻璃"的视觉收口，读者会认为已全面落地。

**建议修法**：内容区浮件（菜单、回执、表情、返回最新、任务板菜单）改 `bg-[var(--gosslan-panel)]` 实色；弹窗内菜单不要再叠 `.frost`；`ToastList` 补进降级选择器组；`data-frost` 要么由"低帧率/降级设置"真实写入，要么删规则并把守卫删掉（现在的守卫是在守一个不可触发的开关）。

---

## Minor

| # | 症状 | 证据 | 建议 |
|---|---|---|---|
| m-1 | 日志窗口工具条硬编码 46px，骨架写 48px，token 是 52px——三套值 | `src/components/LogViewer.vue:307,311`（注释"画板 46px"）；`src/boot/skeleton.css:420-421`；`src/style.css:101` | 统一读 `--gosslan-header-h` 或新增 `--gosslan-toolbar-h`；同步骨架 |
| m-2 | `--gosslan-header-h` 在同一个 `:root` 里声明两次 | `src/style.css:101`、`:276`（区间前是 44 与 48，第二条生效） | 删一条，留一条 |
| m-3 | `.glass-2` 与 `.frost` 逐字重复，`.glass-2` 零消费 | `src/style.css:1646-1657` vs `:1674-1685`；`grep 'class="[^"]*glass-2' src` = 0 | 删 `.glass-2`，注释说明 `.frost` 是它的载体 |
| m-4 | `POPOVER_EDGE_TOKEN` 死导出 | `src/utils/popoverBounds.ts:21` | 删 |
| m-5 | `rounded-full` 111 处绕过 ㊴，`--gosslan-radius-pill` 仅滚动条滑块消费 | `grep -ro rounded-full src --include=*.vue | wc -l` = 111；`--gosslan-radius-pill` 1 处（`style.css:1782`） | 判据把 `rounded-full` 改判 `var(--gosslan-radius-pill)`，或删 pill token |
| m-6 | `NavIcon` 同时传 `:size="24"` 又套 23/21px class；me 页签手写线宽 2.35 | `src/components/ui/NavIcon.vue:27-28`；`src/components/ui/navIcons.ts:26-29`；`src/layouts/ResponsiveLayout.vue:1300` | 去掉 `:size`；me 页签改用 `NavIcon` |
| m-7 | 骨架注释引用已不存在的对照 | `src/boot/skeleton.css:323`（"与 `rounded-lg` 同档"写死 12px，真实 `--gosslan-radius-lg`=14px）；`:330`（"与 `SettingsRow` 的 `px-4 py-3` 同档"，真实 `settings-card-row`=16px） | 改注释或改值 |
| m-8 | 占位符对比度契约只有亮色一行，暗色未钉 | `src/utils/tokenContrast.ts` 的 `--gosslan-placeholder` 只在 light 契约数组里（暗色实测 7.72，当前没问题，但未来改了不会红） | 暗色补一行 |
| m-9 | `.dark` 下 `--gosslan-field-border` 是字面量，`prefers-contrast: more` 提高 `--gosslan-divider-strong` 时它不跟随 | `src/style.css:139`（亮色是别名）、`.dark` 内 `#788dae`（`:535` 附近同块）、`:2402-2418` 媒体覆盖 `--gosslan-divider-strong` | `.dark` 也写成别名 |
| m-10 | 文件名被两行 + `break-all` 断词，`edge-cases.md` 要求单行省略 | `src/components/message/MessageFileBubble.vue:130` `line-clamp-2 break-all` | 改 `truncate`（单行）+ `title` |
| m-11 | `StateBlock` 说明无行数上限，长 IPC 错误会把按钮顶出可视区；解剖也与决策 7 不一致（图标 32 非 40、标题 14 非 17） | `src/components/ui/StateBlock.vue`（标题/说明 class 与 `showIcon`）；`decisions.md` 决策 7 | 说明加 `line-clamp-3`；尺寸差属文档/实现二选一，建议改文档（视觉已验收） |
| m-12 | Toast 宽度上限 512px、无两行截断；文档是 420px + 两行 | `src/components/ToastList.vue:39` `max-w-[min(92vw,32rem)]`；`edge-cases.md` | 改 `26.25rem` + `line-clamp-2`，或改文档 |
| m-13 | 搜索摘要/任务路径用单行 `truncate`，文档要求两行 | `src/components/search/ChatSearchDialog.vue:553`；`src/components/TaskCenter.vue:424`；`edge-cases.md` §1 | 记事：要么改实现，要么把文档改成单行 |

---

## 共享令牌消费矩阵（对应审查重点 1）

| 令牌 | 变化 | 谁消费 | 覆盖验证 | 结论 |
|---|---|---|---|---|
| `--gosslan-primary` | `#3b82f6`→`#2f6bff`（`style.css:17`） | 主色及其 color-mix 派生 `-active/-hover/-soft`、`accent-ink`；`bg-primary` 类 3 处 + 大量 `bg-[var(--gosslan-primary-active)]` | `tokenContrast` 双主题钉住 accent-ink / on-primary / primary-active / primary-hover **对面板**；**未钉** primary 默认填充、brand 渐变、焦点环 | 有覆盖，缺口在"默认填充"一格；旧蓝 `#3b82f6` 只剩测试字面量，无运行时残留（`grep 3b82f6 src` 仅 test） |
| `--gosslan-radius-xs/sm/md/lg` | 4/6/8/12 → 6/8/10/14（`style.css`） | 287 处 `var(--gosslan-radius-*)` | ㊴ 只保证"用 token"；CN-01 只覆盖空态 orb 两层；**没有**"外层圆角 - 内边距 = 内层圆角"的通用断言 | 覆盖缺口：改四个共享圆角而不同心复验（任务 #35 的规则只在 orb 一处被守卫） |
| `--gosslan-title-h` | 38→40，并删除 macOS 28 覆盖（`style.css:283`） | `TitleBar`、`--gosslan-window-safe-top`、`BaseModal`/`ImageLightbox` 顶部偏移、CN-02 几何、**首屏骨架** | CN-02 覆盖"头像 28 + 上下各 6"；骨架**未同步**（M-1） | 部分覆盖；骨架是唯一未被验证的消费者 |
| `--gosslan-header-h` | 48→52，且重复定义两次 | `ChatHeader`、右栏高度、`LogViewer` 未跟随 | 骨架 `.boot-head`=52 已同步；`LogViewer` 46px 未跟随（m-1） | 右栏 OK，独立窗口工具条漏了 |
| `--gosslan-list-w` | 250→320，`LIST_W_MIN` 200→280 | `aside` 宽度、`FavoritePanel`、拖拽边界 | 骨架 320 一致；**未校验**最小窗口宽度（B-1） | 有回归 |
| `--gosslan-placeholder` + 新增顶层 `::placeholder` | 亮 `#94a3b8`→`#5f6b7a`、暗 `#b4b8be`；规则首次全局生效（`style.css:163` 与新规则块） | 全部 `<input>/<textarea>`（不再区分是否写了 `placeholder:` 类） | 亮色契约 ≥4.5（实测约 4.72）；暗色未入契约（m-8）；**落在 `card`/`caption` 面上的输入框未钉**（契约只钉 `field`，而 caption 4.40 / card 4.25 低于 AA） | 主要风险已消（原先 UA `#9ca3af` 只 2.21），剩余是覆盖不完整 |
| `--gosslan-field-border` | 新增，亮色别名 `--gosslan-divider-strong` | 所有输入框边框 | 契约 4 面 × 双主题 ≥3.0（通过） | `.dark` 别名断链（m-9） |
| `scrollbar-gutter: stable` + `.scrollbar-both` | 新增全局块（`style.css:871-884`） | 所有 `.overflow-y-auto/.overflow-auto/.overflow-y-scroll`；12 个点名列表另加 both-edges | SC-01 只断言**声明存在**；运行时宽度差没有测量 | 未验证：Windows 经典滚动条约 15–17px 常驻，macOS overlay 为 0 ⇒ 两平台观感差异没有被任何守卫表达 |

---

## 守卫有效性（对应审查重点 2，全部为突变实测）

方法：在 worktree 内改真实文件 → `node --test --test-name-pattern <守卫>` → 记录红/绿 → 用原内容回写复原。全部复原，`git status` 干净。

| 守卫 | 突变 | 结果 | 判定 |
|---|---|---|---|
| PH-01 顶层规则 | 删掉 `opacity: 1` | **RED** | 有效 |
| PH-01 组件扫描 | 在 `AboutSection.vue` 加 `placeholder:text-[#9ca3af]` | **RED** | 有效（扫描域 `src/components/**` 当前覆盖全部输入框；`src/layouts`/`src/entries` 无输入框，暂不构成漏检） |
| PH-01 动态绑定 | `:class="['placeholder:text-[#9ca3af]']"`、单引号 `class='...'` | **GREEN** | **漏检**：正则只认 `class="..."` 且 token 必须以 `placeholder:text-` 开头，Vue 动态 class 天然绕过 |
| CN-02 | `TitleBar` `pr-1.5`→`pr-3` | **RED** | 有效 |
| CN-02 内部 | `avatarPx` 恒为 28（`.find(t => t.includes("h-7"))` 已先限定），该计算是死分支 | 无 | 记为可维护性瑕疵，不影响红灯能力 |
| CN-01 | `--gosslan-radius-orb-mark-44` 改 `4px` | **RED** | 有效 |
| SC-01 | 全局 `gutter: stable`→`auto` | **RED** | 有效（但只证明声明在，不证明宽度差） |
| PC-01 | 删共享 `max-height` | **RED** | 有效 |
| ㊶ | `p-[16px]` / `pt-4 pb-4` / `px-[16px]` | **GREEN** | **空转**（见 M-2） |

最像"空转"的五条里，实际空转的是：㊶（任意值/单轴）、PH-01（动态 class）、SC-01（只证明声明存在，运行时口径未测）。另外 `data-frost` 是"守卫在守一个没有写入点的开关"（M-7）。

---

## 未验证（卡在哪）

1. **Reka 是否写 `--reka-popper-available-height`**：worktree 未装 `node_modules`，无法读实现；若未写，`style.css:2172` 的兜底 `100vh` 就是唯一限高，780×600 窗口下等于没做。
2. **滚动预留的真实宽度差**：需要 WebView2（经典滚动条）与 WKWebView（overlay）各跑一次 `scrollWidth - clientWidth`；当前只有静态声明读数。
3. **M-1 的观感强度**：骨架有 `.boot-hide` 淡出（`skeleton.css:416-419`），跳位是否被淡出掩盖需要录屏；但三处尺寸差是确定的。
4. **B-1 的真机表现**：几何推算已成立（四处常量现读），没在 360px 宽的真实窗口里截图。
5. **`prefers-contrast: more` 下的别名断链**（m-9）：CSS 语义推理成立，未在真机渲染验证。

---

## 与已知排除项的边界

- B-1 与 M-1 都牵涉 `--gosslan-list-w` / `--gosslan-title-h`，但**不是**"orb 16→20 与红绿灯纵向"那条：那条是圆角与 mac 原生按钮对齐，这里是列宽几何与首屏骨架。
- M-7 与"独立窗口结构性差异维持现状"不冲突：M-7 说的是同一窗口内的层数与降级开关，不要求改窗口结构。
