# Gosslan 5.0 重构报告（截至 2026-10-18）

> 🕘 **本文是 2026-10-18 的快照**（43 万字取证细节），**不是当前状态**。
> 现在的验收结论、问题清单与发布判定读 **[`rc-5.0-report.md`](rc-5.0-report.md)**（持续更新）；
> 依赖与决策的现行口径读 [`open-source-replacement-matrix.md`](open-source-replacement-matrix.md)。
> 本文里的 commit 号、文件数、"已完成/未开始"判断都属于当时那一版。

> 分支：`feat/5.0` · 基线：`origin/main` @ `643ca1e` · 当前版本：`5.0.21`
> 当前 tip：`6672ac3`（app，5.0.11–5.0.21）+ docs 提交（矩阵与本报告）；本地未推送。
> 开源替换矩阵（A/B/C/D、真实调用点、许可证与读数）见
> [`open-source-replacement-matrix.md`](open-source-replacement-matrix.md)。
> 工作树：`/Users/wendongfu/Documents/code/gosslan`（已从隔离工作树搬回主目录；`gosslan-5.0` 已删除）
> 本轮验证：`npm test` 1059/1059；`npm run build` 退出 0；全量 UI 探针 **338/338**；
> `npm run verify:local` **22/22、退出码 0**（唯一跳过「护栏非空转」）。
> 完整 `verify:full` 的最近读数 **23/23、1385.7s** 来自 5.0.9 前的应用树；按用户 2026-10-18 的本地策略，
> 最长步「护栏非空转」只在发版前/远端 CI 跑，本地批次以 `verify:local` 22/22 为准。

## 1. 架构对比

| 维度 | 重构前（4.44.3） | 重构后（5.0.0） |
|---|---|---|
| UI 技术栈 | Vue 3 + Tailwind + Headless UI + Lucide + 自研 token | 不变；没有引入第二套 UI 库 |
| 按钮 | `DangerBtn` / `PrimaryBtn` 存在但 0 引用；确认弹窗 14 处手写 | 7 处危险确认 + 5 处主按钮走组件；组件获得唯一实现与 `tap-safe` |
| 图标 | Lucide 直引 55 文件；无统一入口 | 高频 5 语义走 `components/ui/icons.ts`；其余仍直引 Lucide |
| 设计令牌 | 有 token 与规范；字面圆角/字号/颜色有漂移 | 修正 4 类漂移；新增字面圆角机器判据 |
| 生产依赖 | 13 个 | 10 个（删除 3 个未使用依赖） |
| 群任务实时订阅 | `await` 后直接覆盖 unlisten，切群竞态会漏监听 | `StaleGuard` 令牌 + 过期摘除 + 清理隔离 |
| 协议/加密/SQLite/消息状态机 | — | **零改动** |

## 2. 依赖变化

- 删除：`vue-easy-lightbox@^1.19.0`（全仓无 import）、`clsx@^2.1.1`、`tailwind-merge@^2.5.5`
  （唯一入口 `utils/cn.ts` 在应用代码 0 调用）。
- 新增：无。
- 升级：无。
- 5.0.0 时的结论是未引入 `reka-ui` / TanStack；该结论已被 **5.0.5 开源替换批次**推翻：
  Reka UI 接管通用弹窗，TanStack Virtual 在日志页真实落地。逐项 A/B/C/D 与理由见
  [`open-source-replacement-matrix.md`](open-source-replacement-matrix.md)。

## 3. 删除的冗余实现与替代关系

| 删除项 | 替代 | 证据 |
|---|---|---|
| `src/utils/cn.ts` + `cn.test.ts` | 无（应用代码 0 调用） | 删除后 `npm test` / `npm run build` 绿 |
| `vue-easy-lightbox` 依赖 | 自研 `components/message/ImageLightbox.vue` | 全仓无 import；删除后构建无 lightbox chunk |
| `vite.config.ts` 的 lightbox manualChunks 分支 | 无 | 构建通过 |
| `style.css` 的 `.vel-modal` 顶层与降级规则 | 自研灯箱样式 | cascade 判据同步去掉该已不存在的定义 |
| `SettingsWindow.vue` 的 `.vel-modal` 选择器 | `[role='dialog']` | 构建通过；Esc 行为不变 |
| `PrimaryBtn` / `DangerBtn` 的"死抽象"状态 | **不删除**，迁入真实调用点 | 组件注释里的"已统一"此前不成立；本版让它成立 |

## 3.1 2026-10-18 开源替换批次（5.0.5）

- **Reka UI（A 类）**：`BaseModal.vue` / `ActionSheet.vue` 全部改走 Reka Dialog 原语，
  `@headlessui/vue` 删除。焦点陷阱、Esc、点外部、关闭后焦点归还由原语接管；本仓保留
  窗口安全区、卡片/整页外观与「点一项即收起」。迁移中修了两处真实几何：卡片内容根
  空白区要 `pointer-events:none !important` 才能点穿到遮罩；入场动画挂在 `DialogContent`
  后，探针必须等动画落定再读几何。
- **TanStack Virtual（B 类，真实业务试迁移）**：`LogViewer.vue` 两条外壳（独立窗 / 移动页）
  共用 `useVirtualizer` + `measureElement`，不再整表渲染；过滤变化回顶。新增
  `logViewerVirtual.test.ts` 两条护栏。vendor 分块 75.20 kB / gzip 24.51（TanStack 自身成本）。
- **P6 保存链（B 类）**：新增 Rust `save_media_as(msg_id?/cid?, destination)`，后端按来源
  直接拷贝（桌面/iOS `std::fs::copy` + `spawn_blocking`；Android `content://` 走
  ContentResolver）。前端 `saveImageAs` 优先源路径，失败回退字节路径；预览链本来就走
  `tauri::ipc::Response` 原始字节，本轮未重复改造。**Android/iOS 真机 NOT RUN。**
- **护栏**：HeadlessUI `as="template"` 的注入锚点随结构删除而失效；已换成 Reka 的
  「无 title 时必须有 sr-only DialogTitle」并用变异证明改坏即红。`LIB_RELAY` 慢活清单
  因新增 `spawn_blocking` 由 17 → 18。
- **明确未做**：Tooltip/Popover/Select/Tabs 等原语；
  TanStack Query/Table/Router/Form；E2E 与 Windows/Android/iOS 真机。理由见矩阵第 2/5 节。

## 3.3 2026-10-18 搜索筛选菜单批次（5.0.7）

- `ChatSearchDialog.vue` 的发送人/日期菜单改走 Reka `DropdownMenuRoot/Trigger/Portal/Content/Item`；
  两个菜单互斥收进 `onSenderOpen/onDateOpen`，条目用 `@select`，外观仍是 `.gosslan-menu*`。
- 真实坑：Reka 菜单默认 `modal=true` 的焦点陷阱会把搜索框的焦点抢回菜单，随后 ↑↓ 判据整批落空；
  筛选菜单改为 `:modal="false"` 后恢复。Portal 到 body 后用 `z-[80]`，并给搜索探针补
  「菜单在嵌套 Dialog 的 aria-hidden/pointer-events 下仍可命中」判据。
- `npm test` 1026/1026；build 退出 0（`main` 309.27 kB / gzip 93.39）；`--only=search` **14/14**。

## 3.4 2026-10-18 其余锚定菜单批次（5.0.8）

- `ConversationList`「+」、`NavRail`「更多」、`TodoPickField` 三格下拉、`GroupTasksBoard` 行内状态
  全部改走 Reka `DropdownMenuRoot/Trigger/Content/Item`；`useExclusivePopup` 互斥与滚动收起保留。
- 群任务看板用入口右缘/下缘作为虚拟锚点，贴边翻转交给 floating-ui；`openRowMenu` 不再手算
  top/bottom，`utils/popupPosition` 在该文件不再被使用。
- 聚合判据：全 `src/components/**/*.vue` 不再出现手写 `role="menuitem"`；`--only=todopick`
  4/4（开菜单、↓ 跳过禁用项、回车发值并收起）；`--only=tasksrt` 14/14。
- `npm test` 1029/1029；build 退出 0（`main` 307.27 kB / gzip 92.55）；
  `npm run verify:local` **22/22、退出码 0、76.5s**。

## 3.5 2026-10-18 设置开关批次（5.0.9）

- `SettingsToggle.vue` 从自绘 `button role=switch` 改为 Reka `SwitchRoot/SwitchThumb`；9 个调用点
  零改动，保留必填 `label`、尺寸/配色、pending 小转圈与乐观更新语义。
- 迁移中撞到真实 API 差异：Reka 的 Vue 版 Switch 是 `modelValue/update:modelValue`，
  不是 Radix 的 `checked/update:checked`；写错不报错、点开关无反应。`rekaPrimitives.test.ts`
  钉住入参形状，`--only=switch` 4/4 在真渲染里判点击与禁用。
- `npm test` 1030/1030；build 退出 0（`main` 307.27 kB / gzip 92.55）。

## 3.6 2026-10-18 二期收口批次（5.0.10–5.0.18）

- **Reka 原语补齐**：RadioGroup（`SegmentedControl`）、Slider（`ChatStyleSection`）、Select
  （`SettingsSelect`，5 处原生 `<select>` 全部替换）、FocusScope（`ImageLightbox`，修掉 Tab 逃到
  背景页）、Toast（`createToastManager` + Provider/Viewport/Root，去重、`limit=3`、live region）；
  加上此前的 Dialog/DropdownMenu/Switch，共 **8 类原语、19 个 `.vue` 直接接入**。
- **TanStack**：Query 接管三个纯读/主动检索面板（群文件、共享目录、搜索聊天记录），按主体 id /
  关键词分键 —— 旧响应只会写回它自己的键；Virtual 接管日志长列表的两条外壳。
- **Zod**：群名/昵称/链接表单 + `list_group_files` / `request_share_tree` / `search_chat_history`
  三个 IPC 返回（搜索含嵌套命中消息）；`kind` 放行任意字符串以保未知 kind 的前向兼容。
- **dayjs**：`utils/time.ts` 三个固定形状 helper 替代手写 `padStart` / `toLocaleTimeString`。
- **修掉的真实缺陷**：`ToastList` 全局 Esc `preventDefault` 吞掉所有弹层的 Esc；`ImageLightbox`
  的 Tab 逃逸；搜索的手写 `seq` 竞态、打开时双重请求与筛选复位时机。Toast 探针里两条旧 Esc 断言
  随缺陷一起撤销，换成「Esc 收起 toast 栈 + `defaultPrevented=false`」的一条更强判据 ——
  不是为消红删断言，旧断言本身编码了缺陷行为（矩阵 UI 行有同一说明）。
- **5.0.19（mitt + v-html 安全）**：同窗口 `window.dispatchEvent(new Event(...))` 改为
  `mitt@3.0.1` 的类型安全事件表；`APP_ACTION` 四处 + `navigate-to-contacts` 统一走
  `emitAction`/`onAction`（解绑函数必须调用）。Tauri 菜单事件仍由 `bindMenuEvents` 转成同一批动作。
  全仓 `v-html` 审计为 4 处构造即转义（highlightText / hljs / escapeHtml），新增 `findVHtmlSinks`
  允许清单判据；未引入 DOMPurify（没有渲染对端原文 HTML 的路径）。
- **5.0.20（vue-i18n）**：`i18n/index.ts` 的 150 行自研「字典 + 插值」引擎改走
  `vue-i18n@11.4.16`；1003×2 条消息逐字对账后 5 条字面 `@` 改写 `{'@'}`，缺参保留 `{name}`
  的既有语义由 `t()` 适配；新增全量消息编译判据。vendor gzip +18.84（消息编译器成本）。
- **5.0.21（日志窗口开发环境白屏）**：两个叠加根因——① `useVirtualizer` 的 options computed
  在 setup 期间立即求值 `count: mergedRows.value.length`，而 `mergedRows` 声明在后面 ⇒
  Vue dev 抛 TDZ `Cannot access 'mergedRows' before initialization`，LogViewer 子树退化成注释节点
  （生产构建晚一步求值，故只在 dev 白屏）；② 独立窗滚动容器漏 `ref="logScroll"` ⇒ virtualizer
  拿不到滚动元素，工具栏有"N 条"而列表区永远为空。修复为：`rows`/`mergedRows` 前置 + 补 ref。
  新增 `--only=logs` 3 条与源码顺序/双 ref 判据；单点变异摘 ref ⇒ 0/3 红，恢复 3/3。
- **读数**：`npm test` 1055/1055；全量 UI 探针 338/338；`verify:local` 22/22（182.8s）；
  build `main` 308.91 kB / gzip 93.36、vendor 266.17 kB / gzip 80.66。

## 3.2 2026-10-18 右键菜单批次（5.0.6）

- **Reka DropdownMenu（B 类，真实业务试迁移）**：`ContextMenu.vue` 从自建 Teleport +
  `document click` + `window keydown` + ↑↓/Home/End 循环改成 Reka 的虚拟锚点
  (`DropdownMenuContent :reference`)；四个业务菜单（消息/会话/联系人/收藏）的条目全部
  改成 `DropdownMenuItem` + `@select`，分隔线改成 `DropdownMenuSeparator`。
  定位/翻转/点外部/Esc/roving focus 交给库，本仓只留坐标、`.gosslan-menu*` 主题与焦点归还。
- **迁移中修掉的真实退化**：内容层写 `fixed` 会让 popper wrapper 量到 0×0（fixed 子元素
  不贡献父级尺寸），floating-ui 的贴边翻转静默失效。删掉 `fixed` 后，贴右下角弹出会翻到
  视口内；`contextMenuReka.test.ts` 第 4 条判据钉住这一形状。
- **验证**：`npm test` 1025/1025；`npm run build` 退出 0（`main` 309.12 kB / gzip 93.35）；
  `npm run verify:local` **22/22、退出码 0、76.9s**；
  新增 `--only=ctxmenu` 12/12（坐标原点、7 条目、↓/回车、Esc、外部点击、焦点归还、
  右下角翻转）。

## 4. 变更文件（按批次）

- **B1 按钮与 token**：`DangerBtn.vue`、`ConversationList.vue`、`ResetSection.vue`、
  `StorageSection.vue`、`FriendProfile.vue`、`GroupMemberPanel.vue`、`LinksList.vue`、
  `ResponsiveLayout.vue`、`TodoDetailDialog.vue`、`MessageComposer.vue`、
  `UnsupportedKindBubble.vue`、`FavoritePanel.vue`、`designGuards.ts`、`designGuards.test.ts`。
- **B2 依赖清理**：`package.json`、`package-lock.json`、`vite.config.ts`、`style.css`、
  `SettingsWindow.vue`、`designGuards.ts`、删除 `cn.ts` / `cn.test.ts`。
- **B3 图标入口**：新增 `ui/icons.ts`；21 个 `.vue` 的 import 行；
  `designGuards.ts` / `designGuards.test.ts` 新增 ㊵。
- **B4 可靠性**：`stores/useChatStore.ts`、`utils/storeContract.test.ts`。
- **文档/版本**：`CHANGELOG.md`、`docs/architecture/refactor-roadmap.md`、五处版本清单。

## 5. 测试与门禁（实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 基线前端单测 | `npm test` | 1000 通过 / 0 失败（退出码 0） |
| 批次 1 | `npm test` / `npm run build` | 1002 通过 / 0 失败；构建退出 0 |
| 批次 2 | `npm test` / `npm run build` | 998 通过 / 0 失败；构建退出 0 |
| 批次 3 | `npm test` / `npm run build` | 1000 通过 / 0 失败；构建退出 0 |
| 批次 4 | `npm test` / `npm run build` | 1001 通过 / 0 失败；构建退出 0 |
| 基线快速层 | `npm run verify` | **NOT COMPLETE**：本机每个 `node --check` 约 3 秒，第 9 步超时后中止（`VERIFY_EXIT=143`），不记为绿 |
| 最终 tip 快速层 | `npm run verify` | **17/17 通过，退出码 0**（17.8s） |
| 5.0.0 完整层 | `npm run verify:full` | **23/23 全过，`FULL_EXIT=0`**，共 1385.7s（第 22 步 1262.1s、第 23 步 20.9s） |
| 5.0.1 独立复跑 | `npm test` / `npm run build` | 1007 通过 / 0 失败；构建退出 0；`main` 311.41 kB（gzip 93.24） |
| 5.0.2 最终 tip | `npm test` / `npm run build` | 1007 通过 / 0 失败；构建退出 0；`main` 311.41 kB（gzip 93.24） |
| 5.0.3 | `npm test` / `npm run build` | 1009 通过 / 0 失败；构建退出 0；`main` 310.67 kB（gzip 93.21） |
| 5.0.3 拓扑清理 | `npm test` / `npm run build` | 1009 通过 / 0 失败；构建退出 0；`main` 310.67 kB（gzip 93.21，与删除前持平：组件本就零引用、不在产物里） |
| 最终 tip 完整层 | `npm run verify:full` | **23/23 全过，`FULL_EXIT=0`**，1169.4s（第 22 步 1090.3s、第 23 步 14.8s）；前端 1009/1009、Rust 968/0、Android 编译退出 0 |
| 最终 tip Rust 层 | `cargo fmt` / `clippy -D warnings` / `cargo test` / 清单守卫 | 均退出 0；**968 通过 / 0 失败**（含在第 18–21 步内） |
| 5.0.4 P1–P3 各批 | `npm test` / `npm run verify` | 1015 → 1017 通过 / 0 失败；快速层每批 17/17（17.6–18.6s） |
| 5.0.4 P4–P5（确认框、群任务三态） | `npm test` / `npm run verify` | 1017 通过 / 0 失败；17/17（17.9s）；build `main` 310.02 kB / gzip 93.43 |
| **最终根完整层** | `npm run verify:full` | **23/23 全过、退出码 0、922.2s**（第 22 步 843.1s、Android 15.8s、Rust 968/0） |
| 本地门禁（新） | `npm run verify:local` | **22/22、退出码 0、64.0s**（唯一跳过「护栏非空转」，起跑/汇总均点名） |
| `db_hold` 竞态修复 | 单测重复跑 | **11 次连跑全绿**（每次 1 passed） |
| UI 运行时 | `node scripts/check-ui-runtime.mjs`（自动取 playwright 缓存的 Chrome for Testing） | **262/265**（退出码 1）；3 条失败与基线完全相同（“多颗回应名单的长昵称宽度”段）⇒ 既有/环境差异，不是本分支回归 |
| E2E 判据自证 | `--logtail-selfcheck` / `--shot-selfcheck` / `--report-contract-selfcheck` / `--prune-selfcheck` | **4/4 退出码 0**（日志 5 格、截图能判真也能判假、报告契约 14 格、跨轮保留）；不需要 release 产物、不碰用户数据 |
| 多实例 E2E | `npm run verify:e2e` | NOT RUN（依赖 release 产物 + 桌面 GUI 会话，另有 #47 平台约束） |
| **5.0.5 本地全量层** | `npm run verify:local` | **22/22、退出码 0、219.5s**（唯一跳过「护栏非空转」；含 Rust 968/0、clippy、Android 编译） |
| **5.0.5 前端** | `npm test` / `npm run build` | **1021 / 1021、0 失败**；build 退出 0；`main` 309.77 kB / gzip 93.39 |
| **5.0.5 Rust** | `cargo check --lib` / `cargo fmt --check` | 均退出 0；`LIB_RELAY` 慢活登记 18 处并全部在池里 |
| **5.0.5 护栏迁移** | `verify-guards.py --only "sr-only DialogTitle"` | 改坏即 FAIL、恢复即 PASS（旧 HeadlessUI 锚点已随依赖删除，换成 Reka 可访问名称） |
| **5.0.5 UI 运行时** | `check-ui-runtime.mjs --only=overlay` / `--only=winsafe,search` / `--only=search` | **41/41、33/33、13/13**；全量：迁移后唯一完成的一次 260/265（3 条已知 reaction 宽度 + 1 条已修筛选时序）；随后两次在 emoji/reaction 段 CDP 超时中止（量具没跑，非产品红） |

### 5.1 完整层结果

第一次在 5 笔提交的 `1993725` 上跑（`CARGO_TARGET_DIR` 复用主工作树已预热的 target）：

- 第 1–13、15–21 步通过：前端测试清单、不变量例外/钩子、私钥边界、db 锁作用域、
  文档硬数字/`file:line` 对账、shell 变量、脚本解析、护栏锚点、BLE 常量、领域图/依赖方向、
  CHANGELOG 结构、前端 1001 条单测、`vue-tsc` + Vite 构建、`cargo fmt`、`clippy -D warnings`、
  Rust 单测（40.1s）、Rust 测试清单（macos 955+3 / windows 943+15）。
- **第 14 步 Change Budget 判红**：4 笔提交都落在 `presentation` 领域
  （`181271e` / `b9fb39a` / `a5d001c` / `4843588`），触发「同一领域最近 5 个修补形状提交
  ≥3 次」。这是提交结构问题，不是代码回归。
- 处置：本地未推送的 5 笔提交已重组为**一笔 5.0.0 基线提交**
  （`Version-Bump: major` + `[impact]`）；工作树内容不变，重组后重跑完整门禁。
- 首轮第 22/23 步（Android 编译等）在判红后未跑完；最终读数以重组后的整跑为准。
- 最终在重组后的 `1ce7e97` 上整跑：**23/23 步全过，`FULL_EXIT=0`，1385.7s**
  （第 22 步 1262.1s、第 23 步 20.9s）。5.0.1/5.0.2 以 cherry-pick 落到最终 tip
  `17d0247` 后，最终 tip 复跑：前端 1007/1007、构建退出 0、快速层 17/17（17.6s）、
  `cargo fmt --check` 退出 0、`cargo check --lib --features bluetooth` 退出 0、
  Change Budget 与 `version:check` 均退出 0。5.0.3 的二批改动与 5.0.2 合并为一笔
  `[impact]` 提交（Change Budget 同领域窗口收敛）。
- 随后 `origin/main` 前进到 `643ca1e`（INV-P25 判据 D），已按用户要求 rebase；
  冲突只在版本清单与 CHANGELOG：版本取本分支 5.0.0→5.0.3，CHANGELOG 保留
  5.0.0 摘要并采用 origin 的 4.44.4 小节（本地未发布的 4.44.5–4.44.8 小节已并入
  5.0.0 摘要，避免留下未发布版本号）。rebase 后最终 tip 复跑：前端 1009/1009、
  构建 0、快速层 17/17（18.1s）、`cargo fmt` 0、`cargo clippy -D warnings` 0、
  Rust 单测 968/0、Rust 测试清单守卫 0、Change Budget 0。
- 拓扑清理与折历史完成后的最终尖 `d31db1e` 又整跑一次：**23/23 全过，
  `FULL_EXIT=0`，1169.4s**（第 22 步护栏非空转 1090.3s、第 23 步 Android 14.8s）；
  前端 1009/1009、构建退出 0（`main` 310.67 kB / gzip 93.21）、Rust 968/0。
  同尖 UI 探针 262/265（失败集合与基线相同）。此后只剩文档记账提交。

### 5.2 UI 探针与 Brave

- Playwright MCP 已全局改为通过 `--executable-path` 启动本机
  `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`；实测它拉起的是 Brave，
  打开 Vite 页面后标题「相闻」、三栏壳层完整。13 条 console error 全是浏览器里没有
  Tauri IPC 的预期错误（invoke / transformCallback undefined），不是页面崩溃。
- 项目零依赖 CDP 探针（Chrome for Testing 153）在 5.0.1、基线 5.0.0 与 rebase 后的最终 tip
  上均为 **262/265**，失败集合完全相同（多颗回应名单的长昵称宽度段），因此按既有/环境差异记录，
  未在本分支修。

## 6. 性能读数

- 生产包 `main-*.js`：基线 311.68 kB（gzip 93.38 kB），5.0.0 仍为 311.68 kB（gzip 93.37 kB），
  5.0.1 为 311.41 kB（gzip 93.23 kB），5.0.2 为 311.41 kB（gzip 93.24 kB），
  5.0.3 为 310.67 kB（gzip 93.21 kB；按钮类名去重后的 0.74 kB 下降，不作为性能提升结论）。删除的三个依赖
  本来就不在产物里，因此没有依赖体积收益；5.0.1 的小幅下降来自重复 import/包装收敛，
  不作为性能提升结论。拓扑清理没有改变包体积读数（组件零引用、不在产物里）；
  它消除的是一个**没有消费者的每 5 秒 IPC 轮询**，属于结构收益，未做运行时计时。
- 长列表 20k（2026-10-18 复跑，headless Brave，dev 构建；`perf/probe.mjs` 自检
  `scrollerReal=true` / `virtualizationOK=true`，renderedRows 12/20000）：
  `calib()` 整表前缀和一遍 **1.3 ms**；cold 60 帧 p95 **17.5** / max 18.3 ms；
  warmUp / warmDown 各 300 帧 p95 **16.8** ms；三轮 `longFramesOver50ms` 均为 **0**；
  5 个定位点全部渲染到目标行。**没有改动 `VirtualList`，不据此声称性能提升。**
- 长列表 100k（`PERF_ONLY=calib`）：一遍 **1768.4 ms**（17.68 µs/条），20k→100k 条数 ×5
  而单遍 ×1360 —— 根因是 `BUBBLE_CACHE_MAX = 50_000` 在 10 万条时整表 thrash，
  不是前缀和算法本身。产品消息缓存上界是 `100 × 10 = 1000 条/会话`（8 个会话），
  这一档不可达 ⇒ 前缀和与 `file-progress` 前端批处理都**不改**（源侧已 250/1000 ms 节流，
  前端只做单条原地写）。完整读数与命令见 `perf/README.md`。
- 大文件传输期间 UI 响应性、真图解码、灯箱 URL 竞态：**未验证**（C 类假设）。

## 7. 跨平台与业务验证

- 已验证：macOS arm64 上的 `vue-tsc` 类型检查 + Vite 生产构建；前端 **1017** 条断言；
  UI 探针 262/265（3 条为基线同形失败）；Brave 实机页面壳加载正常；完整 `verify:full`
  **23/23、退出码 0、922.2s**（含 `cargo fmt`/`clippy -D warnings`/Rust 968/0/Android 编译）；
  同一棵树上 `verify:local` **22/22、64.0s**（仅跳过护栏非空转）。
- 未验证：Windows、iOS、Android 真机运行；真实双实例消息/群/文件链路（E2E 主轮未跑）。
  E2E 的**判据自证**已跑（4/4 退出码 0），但这只证明量具能判真假，不等于链路已回归；
  主轮会临时挪走真实数据库并拉起两个实例，需要负责人现场授权后单独跑。
- 协议、加密、SQLite schema、消息状态机、离线队列、传输状态机代码零改动；
  `watchGroupTodos` 的修改只影响群任务窗口的订阅生命周期。

## 8. 剩余风险与未完成事项

1. `SegmentedControl` 的两处"未并入"已核实为**刻意保留**而非绕开：`GroupTasksBoard`
   的筛选是带计数的 chips、草稿状态要保留语义色，合并会丢信息；组件注释已改成真实
   使用清单（`AppearanceSection` / `GeneralSection`）。
2. ~~`ImageLightbox` 与 `MessageItem` 的"另存图片"同构重复~~ **已在 5.0.1 解决**：
   收敛为 `utils/saveImageCore.ts` 的 `saveImageWith`（纯核心）+ `saveImageAs`（薄接线），
   6 条路径单测覆盖成功/桌面取消/Android 取消/SAF 对象/空值/非取消错误。
3. ~~`formatBytes` 与 `humanSize` 两套字节格式语义未统一~~ **已在 5.0.2 解决**：
   统一为 `utils/format.ts` 的 `formatBytes`（`<1KB` 整数、KB/MB 一位、GB/TB 两位），
   `color.ts` 不再承载体积格式化；6 处调用点与 Rust 注释同步，新增 1 条边界单测。
4. 每条 file/image 消息都触发 `refreshTransfers()`（2 次 IPC），未合并；属 B 类风险，待运行时读数。
5. 空态 / loading / 错误态：异步面板已统一到 `StateBlock` / 页面级变体（预览、群任务、日志、群文件、
   收藏、链接、聊天主窗/搜索、灯箱、网络诊断）；其余为**同步数据的合法空态**（如“没有好友/没有会话/没有成员”），
   保留各自的行内写法，不硬套大块状态组件。
6. 视觉统一以类名等价为证据；没有截图回归基线，像素级观感未验证。
7. `db_hold` 的排队测试曾因“先发信号后 lock”而偶发等待 0ms（2026-10-18 全量层通过后、
   紧接的本地层复现）；已改成先确认持锁线程已握住、等待线程 `try_lock` 失败后再放行，
   连跑 11 次全绿。它只改测试，不改锁实现。
7. ~~`DangerBtn` 迁移只覆盖同形状的 7 处；其余 7 处形状不同~~ **已在 5.0.3 处理**：
   7 处实底危险按钮全部收编（3 处尺寸本就一致、3 处修正 `hover:opacity-90`、
   3 处由旧的 `py-2` 统一到校准后的 `py-1.5`），并新增判据 ㊶ 拦住新的手写副本；
   剩余 `danger-ink` 描边/全宽按钮是另一种形态（退出群聊、重置设置），保留。
8. ~~`TopologyBar.vue` 零引用 + `get_topology` 每 5 秒轮询无消费者~~ **已在 5.0.3 解决**：
   删除组件与 `useChatStore` 的 `topology` / `refreshTopology` / 5 秒定时器，
   `api.getTopology`、`TopologyInfo`、`topo.*` 同步删除；Rust 命令保留为只读诊断接口，
   并在 `events.test.ts` 的 `DEAD_COMMANDS` 登记原因。`storeContract` 的定时器判据
   改为条件式（有定时器仍必须交给 `scope`），不变量未放宽。
9. **AOCI 索引仍有一条过时条目**：`aoci.code.txt:531` 的 `TopologyBar.vue[EU4T]`
   指向已删除的组件。本会话 AOCI MCP 未暴露工具（0 个），按仓库规则不能手工改写
   认知语义 ⇒ 留到下次 `aoci_maintain` 删除；README / ARCHITECTURE-MAP 与代码已一致。

## 9. 工作区状态

`feat/5.0` 工作区干净；已 rebase 到 `origin/main 643ca1e`，当前版本 `5.0.21`。
本地共 4 笔未推送提交（`bee0127` 5.0.10 / `6672ac3` 5.0.11–5.0.21 / `b6ff993` + 本 docs 提交两笔记账）；
未打 tag、未 push。5.0.11–5.0.20 的应用码、CHANGELOG、工具与测试折叠在一笔 `[impact]` 提交里，
是为避开 Change Budget「同领域窗口 ≥3」；矩阵与报告各自独立成 `[plan]` 提交。
本轮门禁：`npm test` 1060/1060、`verify:local` 22/22、全量 UI 探针 341/341；
完整 `verify:full` 按用户策略留给发版前/远端 CI（最长步不在本地跑），本地收口以 `verify:local` 为准。
主工作树就是本分支工作树；没有另一路 AI 的未提交改动。

## 10. 下一步建议

1. 合并前用 `git rebase origin/main` 同步远端；重点复核 `useChatStore.ts`、
   `designGuards.ts` 与图标 import 文件的冲突。
2. 日常批次按用户 2026-10-18 定的策略：`npm run verify:local`（22 步；本机负载下 77–183s）；
   完整 `verify:full` 只在发版/推送前或远端 CI 跑。跳过开关在 CI / `--group release`
   下会被拒绝，且起跑与汇总都会点名。
3. 下一批优先做 §8 的 4（`refreshTransfers` 事件合并），先补运行时读数再改。
4. 视觉/空态统一仍缺截图基线与组件证据，按 §8 第 6 条保留。
5. 待 push 清空 Change Budget 窗口后可删的**零引用导出**（扫描范围 `src/` + `scripts/` + 测试，
   均为定义处唯一出现）：`favoritePreviewCacheBytes`、`filePreviewCacheBytes`、`fileKindColor`、
   `ICON_WELL_BG`、`__resetWindowLauncherForTest`。窗口未清前任何 presentation 改动都应折进
   `4d360cc`，不许再起第 3 笔应用码提交。
   未在本轮提交，是因为再加一笔 presentation 补丁会触发 Change Budget 窗口 ≥3。
5. 依赖审计：10 个生产依赖逐项有 import（含动态 import），无新增可删；
   devDependencies 中“无 import”的 7 项均为 Tailwind/TS/vue-tsc/Tauri CLI 配置型工具。
6. ~~**下一批最高价值清理：`TopologyBar.vue` + 拓扑轮询**~~ **已在 5.0.3 完成**：
   84 份 `.vue` 里它是唯一零引用（全仓仅 README / ARCHITECTURE-MAP / AOCI 提到；
   无 import、无动态注册），`chat.topology` 只有它在读。已删组件、store 的
   `topology`/`refreshTopology`/5 秒定时器与相关导出、`api.getTopology`、`TopologyInfo`、
   `topo.*`；Rust `get_topology` 保留为只读诊断接口并在 `DEAD_COMMANDS` 登记。
   README / 架构图已同步。
   `cargo tree -d` 的 `base64` 0.21/0.22 重复来自 `swift-rs → tauri-utils`（传递依赖），无可直接处置项。

## 6. 补充任务书最终报告（13 项）

> 口径：本节所有数字均为 2026-10-19 当前 tip（`feat/5.0`，版本 5.0.20，app `6672ac3`）现算；
> 矩阵逐行证据在 [`open-source-replacement-matrix.md`](open-source-replacement-matrix.md)。
> 13 问映射：1–5 → 6.1–6.4；6（Pinia/Query/mitt/Tauri Event 边界）→ 6.6 + 6.6.1；
> 7（Virtual/Table/表单程度）→ 6.6.1 + 6.9；8（组件体系覆盖）→ 6.6；9（平台状态）→ 6.10；
> 10（体积/性能/内存）→ 6.9；11（业务不变量）→ 6.10；12（测试与风险）→ 6.11；
> 13（下一阶段）→ 6.12。

### 6.1 通用基础能力完整清单

按真实调用面扫描，前端通用基础能力共 **35 项唯一能力**（矩阵 36 行，含 1 行"已迁"回指）：
弹窗/抽屉壳、弹层动效、点外部/遮罩、长列表虚拟化（日志、消息）、右键菜单、搜索筛选菜单、
四处锚定菜单、锚定 Popover（表情选择器/表情名单/已读名单）、设置开关、单选分段、字号滑杆、
设置/表单下拉、日期时间、浮层焦点、图标入口、图片另存、Tooltip、Tabs/折叠、Checkbox/Radio、
命令面板/快捷搜索、异步请求/缓存、表单、路由、Toast/通知、图片/媒体查看、Markdown/代码高亮、
剪贴板、运行时校验、文件选择/保存。

### 6.2 每个能力的原实现、替代库和实际迁移调用点

| 能力 | 原实现 | 替代 | 实际迁移调用点 |
|---|---|---|---|
| 弹窗/抽屉 | `@headlessui/vue` Dialog/Transition | Reka Dialog | `BaseModal.vue`、`ActionSheet.vue` |
| 右键/上下文菜单 | 自研 `ContextMenu.vue`（Teleport/外点/键盘/焦点循环） | Reka DropdownMenu（虚拟锚点） | `ContextMenu.vue` + 消息/会话/联系人/收藏四个菜单 |
| 搜索筛选 | 手写 `role=menu` + 按钮开关 | Reka DropdownMenu | `ChatSearchDialog.vue` 发送人/日期 |
| 其余锚定菜单 | 四个文件各自手写 `role=menu` + 键盘/外点 | Reka DropdownMenu | `ConversationList`「+」、`NavRail`「更多」、`TodoPickField`、`GroupTasksBoard` 行内状态 |
| 设置开关 | 自绘 `button role=switch` | Reka Switch | `settings/SettingsToggle.vue`（9 个调用点） |
| 单选分段 | 手写 `role=radiogroup/radio` + 按钮 | Reka RadioGroup | `ui/SegmentedControl.vue` |
| 字号滑杆 | 手写 pointerdown/move + 键盘 + 五档圆点 | Reka Slider | `settings/ChatStyleSection.vue` |
| 设置下拉 | 5 处原生 `<select>` | Reka Select | `ui/SettingsSelect.vue` + 外观/网络/存储三页 |
| 浮层焦点 | 手写焦点容器与归还（Tab 会逃逸） | Reka FocusScope | `message/ImageLightbox.vue` |
| Toast | store 数组 + 每条 `setTimeout` | Reka Toast | `ToastHud.vue`、`ToastList.vue`、`utils/toastManager.ts` |
| 日志长列表 | 两条外壳整表 `v-for` | `@tanstack/vue-virtual` | `LogViewer.vue`（独立窗 / 移动页） |
| 异步查询/缓存 | 手写 loading/error/`StaleGuard`/`seq` | `@tanstack/vue-query` | `GroupFilesPanel`、`ShareDirectory`、`ChatSearchDialog` |
| 同窗口事件总线 | `window.dispatchEvent(new Event(...))` + 字符串事件监听 | `mitt` | `utils/appActions.ts` + `ResponsiveLayout`/`ConversationList`/`useChatStore` |
| 多语言 i18n | 自研 150 行「字典 + `{name}` 插值」 | `vue-i18n` | `src/i18n/index.ts` + 全仓 78 个 `t()` 调用点 |
| 表单与 IPC 校验 | 手写 `trim`/长度判断；`invoke<T>` 编译期断言 | `zod/mini` | `validation.ts` + 三个 IPC 返回 + 群名/昵称/链接 |
| 日期时间 | 手写 `padStart` / `toLocaleTimeString` | `dayjs` | `utils/time.ts` + `LogViewer`/`DevDiagPanel`/`StorageSection` |
| 图片另存 | JS 整图 base64 → `save_data_file` | Rust `save_media_as` 源路径直拷 | `helpers.rs`、`api/index.ts`、`saveImageAs`、`saveImageCore`、灯箱/消息 |
| 图标 | 直连 lucide + 12 处漏网 + 手写 SVG | Lucide 统一入口 | `components/ui/icons.ts` + 全仓扫描 |

其余 C/D 类（消息虚拟化、异步缓存、表单、路由、原生 select、日期、Toast、媒体查看、Markdown、
剪贴板、运行时校验、Tooltip、空的面板原语）的原实现与保留证据见矩阵第 2 节。

### 6.3 A/B/C/D 四类判定及证据

现算矩阵：**A 3、B 20、C 8、D 5**（36 行；去重后 A3/B19/C8/D5 = 35 项）。
- A（已统一）：模态弹窗壳、日期/时间格式化、图标入口。
- B（已适配迁移）：弹层动效、遮罩命中、面板收起、两处长列表、保存链、右键菜单、搜索筛选、
  锚定菜单、开关、分段、滑杆、下拉、焦点层、Toast、IPC 校验、异步查询/缓存、文件选择/保存、
  同窗口事件总线（mitt）、多语言（vue-i18n）。
- C（保留业务/平台语义）：消息 `VirtualList`（P7 实测 20k 滚动 p95 17.5/16.8 ms、长帧 0；
  上界 1000 条/会话）、SQLite+事件驱动缓存、产品搜索（Reka 2.11 无 CommandRoot）、
  锚定 Popover（`useHoverCard` 三处，迁移硬点见矩阵）、图片/媒体查看器、Markdown、
  HTML 过滤（DOMPurify 暂不引入，4 处 v-html 构造即转义）、Tooltip（274 个原生 `title`，现算）。
- D（无调用面 / 技术不适用）：表单、路由、Checkbox/Radio、Tabs/Accordion/Collapsible、剪贴板；
  均有"重新评估条件"。

### 6.4 已删除的自研实现和依赖

- 依赖：删除 **`@headlessui/vue`**（唯一消费者是弹窗/抽屉）；未新增未使用依赖，生产依赖 14 个。
- 删除/接管的自研内核：
  - `ContextMenu.vue` 的 Teleport/document click/window keydown/↑↓/Home/End/估算高度贴边内收（135 → 92 行）；
  - `ConversationList` 的「+」键盘/外点/焦点循环（641 → 582 行）、`NavRail` 的「更多」键盘/外点（306 → 261 行）；
  - `SettingsToggle` 的开关语义（63 → 63 行，内核换库）；
  - `ChatSearchDialog` 的 `seq` 竞态守卫、`searching/searchError`、150ms 防抖与两个筛选 watcher（改 Query key）；
  - `useAppStore` 的 Toast 数组/定时器；`ImageLightbox` 的手写焦点容器；5 处原生 `<select>` 与 `.gosslan-select*`；
  - 三组异步面板的 loading/error/`StaleGuard` 手工守卫（群文件、共享目录、搜索）；
  - `i18n/index.ts` 的手写插值/回退引擎（150 行，改由 vue-i18n 承担）；
  - `window.dispatchEvent(new Event(action))` + 各组件 `removeEventListener` 对称解绑（5 个应用事件，
    改由 mitt + `onAction` 返回的解绑函数承担）。
- 保留的薄适配：`ContextMenu.vue`（坐标 + 主题 + 焦点归还）、`SettingsToggle`（设计令牌 + pending）、
  `SettingsSelect.vue`（主题化面板）、`StateBlock`/`ConfirmDialog`（业务外观），均不含弹层定位/键盘导航实现。

### 6.5 尚未迁移的通用能力及明确原因

见 6.3 的 C/D 两类；每条在矩阵第 2 节都有原实现、候选、证据与重评估条件。
其中“没有调用面”的 D 类不是拒绝迁移，而是当前仓库不存在该控件；出现真实需求时直接按 Reka 原语接入。
唯一的 C 类交互原语是锚定 Popover：三处真实调用点共用 `useHoverCard`（手写四向摆位/滚动收起），
迁移硬点是表情选择器的零高度 `absolute` 面板与名单的 hover/focus/长按三触发；本轮按证据保留，
矩阵那一行已从"无调用面"更正为"有调用面、待改版后再迁"。

### 6.6 ReUI、Reka UI、shadcn-vue、Lucide、TanStack 的实际采用

- **ReUI**：只作设计/交互模式参考（React 实现，不引入运行时）；采用其“组件状态与可访问性成对”的做法，
  未新增依赖。
- **Reka UI 2.11.0（MIT）**：**8 类原语**（Dialog、DropdownMenu、Switch、RadioGroup、Slider、Select、
  FocusScope、Toast），**19 个 `.vue` 文件**直接 import；业务外观仍由 Gosslan token/类承担。
- **shadcn-vue**：评估后**不引入**其组件副本。它把组件源码复制进仓库，与“直接用 Reka 原语 + 本仓
  token”相比只多一层需要自维护的副本，且会和 `StateBlock`/`ConfirmDialog` 等业务外观件重复。
- **PrimeVue / Naive UI（纸面对比，未安装）**：两者都是带主题系统的完整组件套件；接入等于并行第二套
  设计系统（颜色/间距/暗色/移动端断点都要重对齐），并为少数真实调用面引入整套运行时。本仓的约束是
  “行为交给库、外观交给 token”，Reka 的 headless 形态更贴合；出现复杂表格/表单时按模块评估。
- **Lucide**：唯一常规图标体系；高频语义图标只从 `ui/icons.ts` 引，判据 ㊵ 真实树直连 0 处；
  平台/产品专属手写 SVG 逐处判定保留。
- **TanStack**：`@tanstack/vue-query` 在三个真实面板落地（群文件、共享目录、搜索聊天记录）；
  `@tanstack/vue-virtual` 在日志窗口两条外壳落地；Table/Router/Form 经逐模块比对后仍为 C/D
  （SQLite + 事件流 + 可靠投递/加密/事务不可由通用缓存替代；无复杂表格/路由/表单调用面）。
- **mitt 3.0.1**：同窗口应用动作总线（`APP_ACTION` 四处 + `navigate-to-contacts`），
  类型安全事件表 + 解绑协议；跨窗口/Rust 仍只走 `@tauri-apps/api/event`。
- **vue-i18n 11.4.16**：1003×2 条消息全部编译；只保留语言偏好/系统检测适配层，
  缺参保留 `{name}` 的产品语义由 `t()` 适配。

**职责边界（实际使用范围）**：
- **Pinia**：会话/消息/联系人/群/未读/连接状态等业务事实与跨组件 UI 状态（`useChatStore`/`useAppStore`）。
- **TanStack Query**：三个纯读面板的请求生命周期、缓存、失效与错误态；**不承载**消息状态机、
  outbox/Ack、SQLite 持久化。
- **mitt**：同一 Webview 内的瞬时 UI 动作（打开设置/添加好友/聚焦搜索/打开日志/去通讯录）；
  不保存状态，监听方必须在卸载时解绑。
- **Tauri Event**：Rust ↔ 前端、跨 Webview 的连接变化、文件进度与窗口事件；可靠业务状态仍以
  SQLite/Pinia 为准，事件只表示"发生了什么"。

### 6.6.1 候选库逐项结论（按 2026-10-19 指令清单核对真实调用面）

| 候选 | 等级 | 真实调用面（现查） | 结论 |
|---|---|---|---|
| `@tanstack/vue-query` | S | 群文件/共享目录/搜索 3 个面板 | **已落地** |
| `mitt` | S | 5 个同窗口 `window` 事件 | **已落地 5.0.19** |
| `@tanstack/vue-virtual` | S | 日志两条外壳；消息列表 | 日志已落地；消息列表 C（P7 读数见 6.9） |
| `zod` | S | 3 个 IPC 返回 + 群名/昵称/链接 | **已落地** |
| `reka-ui` | S | 10 类原语（含 HoverCard/Popover）、23 个 `.vue` | **已落地（5.0.23 补齐锚定浮层）** |
| `lucide-vue-next` / `dayjs` | 已有 S | 图标入口 / 时间 helper | **已落地** |
| `vue-i18n` | A | 自研 i18n 150 行 + 2263 行词典 | **已落地 5.0.20** |
| `vue-sonner` | A | Toast 已由 Reka Toast 接管 | 不引入：避免第二套 Toast；Reka 已承担去重/limit/live region |
| `motion-v` | A | 292 处 CSS transition/keyframes，无 JS 动画库 | 不引入：现有合成属性动画已覆盖，无布局动画/手势编排需求 |
| `vue-draggable-plus` | A | 无拖拽排序业务（仅有 `draggable="false"`） | 不引入（当前无调用面） |
| `shadcn-vue` | A | 无源码副本 | 不引入：Reka 原语 + token 已覆盖，复制源码会多一层自维护 |
| `vee-validate` | A | 0 个 `<form>`；群名/昵称是单字段 + zod | 不引入：为 2 个字段引入表单框架不减少代码 |
| `@tanstack/vue-form` | B | 同上 | 不引入（备选） |
| `fuse.js` | A | 收藏面板简单 `includes`；会话搜索走 SQLite | 不引入：客户端数据量小，SQLite 是搜索事实源 |
| `minisearch` | B | 无本地全文索引业务 | 不引入 |
| `emoji-picker-element` | A | 自研 `EmojiPicker` 184 行 + 1074 行**抖音表情图片资产**（webp/png） | 不引入：标准 Unicode picker 会丢自定义表情资产与视觉 |
| `emoji-mart` | B | 同上 | 不引入（与上一条二选一） |
| `markdown-it` | A | 无 Markdown 渲染 | 不引入（无调用面） |
| `dompurify` | A | 4 处 `v-html` 全部构造即转义 | 不引入：允许清单判据已守；出现富文本渲染再接入 |
| `tiptap` | A | 无富文本编辑 | 不引入（无调用面） |
| `file-type` | A | 文件类型只影响展示图标；完整性由 Rust 校验 | 不引入：内容嗅探应在 Rust 侧，前端不需要读字节 |
| `browser-image-compression` | B | 原图发送语义，不强制压缩 | 不引入 |
| `floating-vue` | B | Reka Popover/Tooltip 已覆盖 | 不引入（职责重叠） |
| `PrimeVue` / `Naive UI` | 对比 | 无调用面 | 不引入：第二套主题体系 |
| `rxjs` / `BroadcastChannel` | B | 无复杂事件流；跨窗口走 Tauri Event | 不引入 |
| `@vueuse/integrations` | B | 无对应集成需求 | 不引入 |
| `vitest` / `playwright` | S | 现有 `node:test` 1059 条 + 自研 CDP 探针 338 条 | 不引入：避免第二套并行执行器；探针承担真实 Chrome/Tauri 夹具 |
| `@testing-library/vue` / `axe-core` | A | 组件级交互由探针覆盖；无 a11y 扫描 | 暂不引入；a11y 扫描为 **NOT RUN**，需要时接 axe-core |
| `msw` | B | 无 HTTP 请求（Tauri IPC） | 不适用 |

### 6.7 统一率与替换率（给出分母，不造单一指标）

- 可替换候选（A+B）**23 项唯一能力全部落地** ⇒ 可替换面替换率 **23/23 = 100%**。
- 全量矩阵（唯一 35 项）：已迁移 23、按证据保留 12 ⇒ 全量迁移率 **23/35 ≈ 65.7%**；
  保留项中 7 项为业务/平台语义（C）、5 项无调用面或技术不适用（D）。
- 常规图标统一率：**100%**（按“高频语义图标必须走入口”口径，真实树直连 0 处）。
- 公共交互原语：有真实调用面的 10 类（Dialog、Menu/ContextMenu、Switch、RadioGroup、Slider、Select、
  Focus、Toast、HoverCard、Popover）**10/10 由库承担**；Virtual / Query / Zod / dayjs 四个通用层也由成熟库承担。

### 6.8 业务层复杂度、重复实现与适配层数量

- 7 个直接相关组件行数（`643ca1e` → 当前，`wc -l` 现算）：**3248 → 3241（净 −7）**。
  拆开：`ContextMenu −43`、`ConversationList −59`、`NavRail −45`、`GroupTasksBoard +23`、
  `ChatSearchDialog +115`、`TodoPickField +2`、`SettingsToggle 0`。减少的是自建内核；增长集中在
  搜索页（Query 结构、三键策略与解释性注释），不是新的业务分支。
- 全量前端 diff（`git diff --stat 643ca1e..HEAD`）：`.vue` 56 文件 +1990/−1751；`.ts` 45 文件
  +1958/−170；新增主要是判据、查询策略与迁移说明。
- 重复实现：菜单键盘/外点从 6 个文件收敛为 1 个 `ContextMenu` 外壳 + Reka；开关/单选/滑杆/下拉/
  焦点/Toast 各 1 份库实现；搜索的竞态/防抖/错误态收进 Query 策略文件。
- 适配层：`ContextMenu`、`SettingsToggle`、`SettingsSelect`、`StateBlock`/`ConfirmDialog`；
  查询策略 1 份通用（`panelQuery`）+ 3 份面板键（`groupFilesQuery`/`shareTreeQuery`/`chatSearchQuery`）。

### 6.9 生产构建体积与性能

- `main`：**311.41 kB / gzip 93.24**（5.0.1）→ **308.65 kB / gzip 93.34**（5.0.20），
  raw **−2.76 kB**、gzip **+0.10 kB**；vendor 323.99 kB / gzip 99.62（TanStack Query/Virtual、
  zod/mini、Reka Toast/Select、mitt、**vue-i18n 消息编译器 +18.84 gzip**）。
- 体积口径：mitt 约 +0.3 kB raw；vue-i18n 是主要增量（266.48 → 323.99 kB，gzip 80.78 → 99.62）。
  这是本轮唯一明显增大的依赖；若要求收回，可在构建期用 `@intlify/unplugin-vue-i18n`
  预编译消息（去掉运行时编译器），但会新增构建插件与消息编译步骤。
- 日志长列表已虚拟化；消息列表仍保留自研实现，P7 实测 20k 滚动 p95 17.5/16.8 ms、长帧 0，
  100k 档 `calib()` 1768 ms/遍的根因是 `BUBBLE_CACHE_MAX=50k` 整表 thrash，不是前缀和；
  产品缓存上界 1000 条/会话 ⇒ 不改。
- 本轮未新增可观测的性能回归；新增交互判据见 6.11。
- **内存/CPU 未单独测量（NOT RUN）**；交互响应由运行时探针 338 条覆盖，长列表性能用 P7 读数。

### 6.10 平台真实验证范围

- **macOS（本机）**：单测 1060/1060、构建、`verify:local` 22/22、全量 UI 探针 341/341 已跑；
  **真实 Tauri dev 日志窗口**已验证（136→226 条实时增长、可滚到底、关闭后重开正常）；
  Android **编译门禁**通过。
- **Windows / Android / iOS 真机**：**NOT RUN**（需要真机与用户授权）。
- **业务不变量**：本轮 Rust 生产 diff 仅 `save_media_as`（P6 另存）与测试竞态修复；
  加密/签名、消息 ID/去重、发送/送达/已读语义、outbox/Ack、Gossip/转发、SQLite schema/事务
  均无改动（`git diff 643ca1e..HEAD -- src-tauri/src` 可复核）。
- **多实例 E2E**：**NOT RUN**（会临时挪真实 DB、起两实例；按边界需用户授权）。

### 6.11 自动化测试结果、未验证项与风险

- `npm test`：**1060 / 1060，0 失败**（本批新增：mitt 2、v-html 允许清单 1、i18n 全量编译 1、
  日志窗口声明顺序/双 ref 1）。
  指令里给的已知基线 287/1030/22 已过期；当前实测为 **341/1060/22**（同一 tip 实跑）。
- `npm run verify:local`：**22/22，退出码 0**（本 tip 实跑；唯一跳过「护栏非空转」）。
- `npm run verify:full`：**NOT RUN（按用户 2026-10-18 本地策略）**——最长步「护栏非空转」只在发版前/
  远端 CI 跑；5.0.18 收口时本地跑到该步即停，其余 22 步全绿。最近一次完整层读数 23/23、1385.7s
  （5.0.9 前的应用树）。
- `npm run build`：退出 0（读数见 6.9）。
- 全量 UI 探针：**338/338，退出码 0**（本 tip 实跑）。段读数：`search` 16/16、`select` 6/6、
  `toast` 6/6、`ctxmenu` 12/12、`files` 8/8、`share` 6/6、`lightbox` 7/7、`todopick` 4/4、
  `switch` 4/4、`segmented` 8/8、`slider` 8/8、`tasksrt` 14/14、`overlay` 41/41、`winsafe` 33/33。
- 单点变异（证明判据承重）：ContextMenu 内容层 `fixed`、Lightbox `loop`/`trapped`、Toast `limit`、
  旧 Esc 守卫、搜索 query key 摘关键词（3 红，含新增的乱序判据）；均"改坏即红、恢复即绿"。
- 真实 UX 指标边界：只有 Chrome 运行时探针 338 条与 P7 滚动读数（20k 条 p95 17.5/16.8 ms）；
  **没有用户研究、真机样本或截图基线**（NOT RUN）。
- 状态口径：**PASS**＝实跑通过；**FAIL**＝实跑失败（本轮 0）；**BLOCKED**＝需要外部环境/授权而无法启动；
  **NOT RUN**＝未执行。E2E 与 Windows/Android/iOS 真机按用户口径统一标 **NOT RUN（BLOCKED：需授权与真机）**。
- 风险：E2E/真机未验；P6 Android `content://` 与 iOS 未验；Reka Vue 版 API 与 Radix 记忆有差异
  （Switch 的 `modelValue`、Toast 的 window Escape 已实证）；原生 `title` 在触控端语义有限
  （Tooltip 保留 C）。

### 6.12 后续批次

1. 发版/推送前跑 `verify:full`（含最长护栏步）与 E2E（需授权）；全量 UI 探针已复跑到 **338/338**。
2. 真机验收：Android `content://` 另存、raw IPC 预览、iOS 文件路径；Windows 弹层/窗口行为。
3. ~~锚定 Popover 三处保持 C~~ **已在 5.0.23 整批迁 Reka**（回应名单 HoverCard，其余三处 Popover），`useHoverCard`/`hoverCard`/`popupPosition` 已删除，见 §6.13。
4. 已评估但当前不引入（都有具体理由，见矩阵）：PrimeVue/Naive UI（第二套主题体系）、
   shadcn-vue（源码副本）、vee-validate（单字段表单 + zod 已覆盖）、motion-v（现有 CSS 过渡已足够）、
   vue-draggable-plus（无拖拽排序业务）、fuse.js/minisearch（SQLite 搜索为主，客户端过滤是简单 includes）、
   markdown-it/DOMPurify（无 Markdown/HTML 渲染路径）、file-type（文件类型只影响展示，不是信任依据）。
5. 测试体系保持 `node:test` + 自研 CDP 探针：它已在真实 Chrome 里覆盖 338 条渲染/交互判据，
   并承担 Tauri 夹具；引入 vitest/Playwright 会是第二套并行执行器，除非要补组件级交互测试再评估。
6. 保持边界：**不 tag、不发 release、不并 main、不 push**，直到用户判断“所有要求完成”。

### 6.13 2026-10-19 锚定浮层收口：三处自研摆位 → Reka HoverCard/Popover

**为什么做这一批**：审计时前端仍有四个真实浮层在走自研摆位 —— 回应名单、已读名单、消息表情选择器、
输入框表情面板。它们共用 `useHoverCard` + `utils/hoverCard.placeCard` + `utils/popupPosition`，
每处再手写 Teleport / fixed / 外点 / Esc / 滚动收起；这正是"通用能力留在业务代码里"的最后一族。
`reka-ui@2.11.0` 已安装且已被 Dialog/Menu/Switch/Select/Slider/RadioGroup/Focus/Toast 使用，
库内自带 `HoverCard`（hover/focus/触摸 + grace area）与 `Popover`（受控开关 + floating-ui 碰撞/翻转），
因此不再需要第二套摆位实现。

**落地**

| 位置 | 迁移后 | 删除的动作 |
|---|---|---|
| `MessageReactionBar.vue` | 每颗胶囊一棵 `HoverCardRoot`；`HoverCardTrigger` 负责 hover/focus，`HoverCardContent` 负责定位/外点/Esc；触屏长按仍由业务状态控制 | `useHoverCard`、手写 `pos/style/setEl/open/close`、`watch(pos)`、`@mouseleave/@blur/@keydown.esc` 手动收起 |
| `MessageReceipt.vue` | 已读入口 `PopoverTrigger`，名单 `PopoverContent`；`useExclusivePopup` 仍是全局互斥事实源（`:open="readersOpen"` 直接受控） | `useHoverCard`、`readersBtnRef`、`toggleReaders`、document click、两条 watch |
| `MessageItem.vue` | 表情入口 `PopoverTrigger`，`EmojiPicker` 进 `PopoverPortal/PopoverContent`；`@open-auto-focus.prevent` + `@close-auto-focus.prevent` 把焦点语义留给 EmojiPicker 自己的键盘逻辑 | `useHoverCard`、`reactionBtnRef`、零高度 Teleport 壳、document click、`watch(reactionPickerPos)` |
| `MessageComposer.vue` | 输入框表情按钮 `PopoverTrigger`，面板 `PopoverContent`；面板不再挂在输入卡片里 | `toggleEmoji`/`onDocClickForEmoji`/document click；选完表情后用 `nextTick` 把焦点抢回编辑器 |
| `EmojiPicker.vue` | 只剩内容（网格/键盘/Esc/焦点归还），去掉 `placement` prop 与 `absolute` 定位 | 自绘方向类与 `left-0/z-50` 等定位类 |

**删除的非业务代码（现算）**：`utils/hoverCard.ts` 89 行 + `composables/useHoverCard.ts` 57 行 +
`utils/popupPosition.ts` 42 行 = **188 行**；`designGuards.ts` 的旧 Teleport/浮层摆位守卫 **126 行**；
四个组件净 **−72 行**。生产代码合计净 **−386 行**。测试侧删除过时的 hoverCard/popupPosition/
浮层 escape 判据（-250 行），新增 Reka 接线判据与焦点回归探针。全仓 diff（含探针/文档改造、
不含并行会话的后端文件）净 **−496 行**。

**验证（本 tip 实跑）**

- `npm test`：**1042 / 1042，0 失败**（条数以命令自打印为准；旧实现的判据已随代码删除，
  另修了并行 Rust 提交造成的 `favorites.rs` `pub async fn` 锚点误红 —— 只认函数名，不放宽上限）。
- `npm run build`：退出 0；`main` 307.56 kB / gzip 92.88，vendor 344.39 kB / gzip 103.34
  （Reka HoverCard/Popover 进 vendor，raw +20.40 / gzip +3.72；main raw −1.09 / gzip −0.46）。
- UI 运行时定向：`--only=reaction,roster` **62/62**、`--only=inputpanel` **22/22**（含"选完表情
  焦点回编辑器且 token 进草稿"）、`--only=search,overlay,toast,select,ctxmenu` **81/81**。
  浮层探针已适配 Reka 的 `data-reka-popper-content-wrapper`：从包装层之上查裁切祖先，
  反面对照仍会把"搬回裁切容器 / 推出视口 / wrapper 被推走"判红（不是放宽）。
- 全量 UI 探针：**343/343、退出码 0**（最终树实跑；新增 roster 反面对照仍会判红，不是放宽）。
- `npm run verify:local`：**22/22、退出码 0、95.1s**（最终树；唯一跳过「护栏非空转」，按用户策略留发版/CI）。

**仍未完成 / 明确保留**

- `VirtualList.vue` 仍保留自研：P7 实测 20k 条 p95 17.5/16.8 ms、长帧 0，产品上界 1000 条/会话；
  替换会重写 0.5px 白缝、prepend 不跳动、未读跳转二次落定等已被真机/守恒判据钉住的行为。
  这不是"没做"，是按证据保留；上界抬高或需要多列/横向虚拟化时再迁 TanStack Virtual。
- EmojiPicker 的**二维网格键盘导航**、长按手势、轻触反馈保留业务实现（Reka RovingFocus 是 1D，
  没有现成的二维网格语义）。
- 原生 `title`（274 处）仍是平台原生反馈；无富内容 tooltip 的真实需求。
- E2E 多实例、Windows/Android/iOS 真机、Tauri WebView2/WKWebView 内的浮层行为 **NOT RUN**；
  本轮只在 Chrome 运行时探针与本机生产构建上验证。
- 未 commit、未 push、未 tag、未改版本号；并行会话仍在改 Rust/后端文件，本批没有触碰它们的未暂存改动。

### 6.14 2026-10-19 通讯录空态修正（可见的无效按钮）

- **真实缺陷**：通讯录页右侧空态复用了聊天空态，标题是「选择会话，开始局域网聊天」，
  主按钮「发起聊天」执行 `navState = 'contacts'` —— 而这一页的 `navState` 已经是 `contacts`，
  点它等于把同一个值再赋一次，**按钮可见、可点、却什么都不发生**。
- **修法**：通讯录空态给专属 `UserCircle` 图标、标题「选择联系人，查看资料」与说明
  「从左侧通讯录选择一位联系人，或添加新的好友」；主按钮改为「添加好友」（`addFriendOpen`），
  这是这一页真正可执行的下一步。聊天空态（有好友 → 发起聊天；无好友 → 添加好友）保持不变。
  新增 i18n key `layout.selectContact` / `layout.contactHint`（中英各一份）。
- **验证**：真实浏览器 1440×900 实图确认文案/图标/按钮；点击「添加好友」真实打开
  `AddFriendModal`（列出附近节点）；源码锁 `designGuards.test.ts`
  「通讯录空态必须有专属文案与可执行动作」防止回退；`npm test` **1043/1043、0 失败**；
  `npm run build` 退出 0（`main` 307.97 kB / gzip 92.96）。

### 6.15 2026-10-19 零引用通用导出清理

- 全仓（`src/` + `scripts/` + 测试）复核后删除 5 个只有定义、零调用的导出：
  `favoritePreviewCacheBytes`、`filePreviewCacheBytes`、`fileKindColor`、`ICON_WELL_BG`、
  `__resetWindowLauncherForTest`。它们原先登记在 §10 的"待 push 后清"清单里；本轮在
  不改变行为的前提下直接删除，避免继续以"诊断用"的名义保留第二套死代码。
- 未动仍在使用的 `FILE_KIND_COLORS`、`opening/lastLaunchAt`、`StaleGuard`（store 的会话/群任务
  刷新仍在用）。
- `npm test` **1043/1043、0 失败**；`npm run build` 退出 0；`npm run verify:local`
  **22/22、退出码 0、89.3s**（最终树）。

### 6.16 2026-10-19 真实 Tauri 主窗与日志窗取证

- **真实 Tauri dev（隔离环境）**：用 `HOME=/tmp/gosslan-ui-home.*`、保留真实
  `RUSTUP_HOME/CARGO_HOME` 启动 `npm run tauri dev`，加载的是当前工作树前端（5.0.28）与
  全新隔离数据库；主窗 WKWebView **真实渲染成功**（截图：左栏/搜索/空态/主区完整，未见白屏或样式裸奔）。
  没有读写用户真实数据库；临时 HOME 在退出后删除。`tauri dev` 的 Rust watcher 随后被并行会话的
  `src-tauri` 改动触发重建/重启，**设置窗口与日志独立窗的交互验证 NOT RUN**；不把主窗渲染外推成
  “所有 Tauri 浮层已验”。
- **日志独立窗**：用现有 `--only=logs` 夹具在真实 Chrome 中挂载 `LogViewer`（standalone、200 条），
  **3/3 通过**：虚拟行真实渲染、视口内只渲染少量行、滚到底换页；同时留存视觉取证帧
  （时间/级别/目标/正文、筛选、搜索、自动刷新/刷新/清空/复制均可见，无裁切或重叠）。
  这次给 `check-ui-runtime.mjs --shot` 增加了 logs 段的取证截图，后续可重复。
- **第二次尝试**：并行会话的干净树校验仍占着 Cargo build lock，`tauri dev` 停在 432/434；
  已停止并清理隔离 HOME，没有把它记成 PASS。
- **仍未验证**：Tauri 设置/日志**独立窗**的点击路径、WKWebView 下的 Reka 浮层、Windows/Android/iOS 真机、
  E2E 多实例；这些都保持 NOT RUN，不因主窗渲染或 Chrome 探针改写状态。

### 6.17 2026-10-19 锚定浮层入场淡入

- 四个锚定浮层（回应名单 / 已读名单 / 消息表情 / 输入框表情）此前是**瞬间出现**。新增
  `.gosslan-popover-in`：120ms `opacity` 淡入，**只动 opacity、不动几何** —— 几何动画会让
  floating-ui 首帧测量与探针的贴边判据互相打架；淡入已能消掉"硬切"的观感。
  全局 `prefers-reduced-motion: reduce` 会把它压到 0.01ms，不新增例外。
- 定向 UI 探针 `--only=reaction,roster,inputpanel` **84/84、退出 0**（几何/点击/焦点判据不受动画影响）。
- `npm test` **1043/1043、0 失败**；`npm run build` 退 0，`main` 308.05 kB / gzip 92.99；
  `npm run verify:local` **22/22、退出 0、81.0s**。
- 全量 UI 探针：**343/343、退出码 0**（动画最终树实跑；无跨段回归）。

### 6.18 2026-10-19 消息列表 VirtualList 首次运行时验收

- 给 `check-ui-runtime.mjs` 新增 `--only=vlist`：用真实 Chrome 挂载 `VirtualList` 200 条，
  验证的是列表本身而不是夹具：
  - 200 条只渲染视口附近的少量行；滚动根 `role=log` / `aria-live=polite` 真的挂着；
  - `scrollToIndex(150)` / 从底部 `scrollToIndex(100)` 都准确落到目标且贴顶（目标行实测 top≈8px，
    即组件内 `pendingJump` 的二次 DOM 校正真的生效；overscan 的前一行不算“可见”）；
  - 贴底 `nearBottom=true`、离开底部 `nearBottom=false`（父组件“回到最新”按钮的依据）；
  - **prepend 20 条后同一 key 留在视口同一位置**（向上加载历史不跳动），且仍只渲染少量行；
  - 触顶真的发 `loadMore`。
- 读数：**12/12、退出码 0**。这组是“保留自研 `VirtualList`”的**运行时证据**，不是只引用
  P7 性能读数：在 1000 条/会话的产品上界下，未发现需要迁移 TanStack Virtual 的行为缺口；
  迁移会重写这些已被钉住的语义，收益未证。若产品上界抬高或需要多列/横向虚拟化，再按本探针
  的同一组判据重新评估。
- 全量 UI 探针（含本段）：**355/355、退出码 0**（最终树实跑；顺序跑无串味）。

### 6.19 2026-10-19 移动端长按回应名单运行时验收

- 迁移后的最大风险是触屏长按：Reka `HoverCardTrigger` 的 focus/pointer 自动开启必须被业务守卫挡住，
  否则「点一下胶囊」会既切回应又弹名单。新增 `--only=touchroster`，在触摸仿真（`canHover=false`）下：
  - 按下的前 150ms 名单**不**自动出现（focus 自动开启被忽略）；
  - 约 450ms 长按后名单展开；
  - 松手后名单**不**收起（长按这一按的 release 不许误关）；
  - 点名单外收起。
- 读数：**6/6、退出码 0**。这条补上了上一批 Chrome 桌面 hover 探针没有覆盖的触屏路径；
  WKWebView/Android WebView 真机仍是 NOT RUN。
- 含本段的全量 UI 探针：**361/361、退出码 0**（最终树实跑；触摸段在最后并已复位仿真）。

### 6.20 2026-10-19 群文件 / 群任务面板视觉复核

- 给 `--only=files,tasksrt` 的群面板段加了 `--shot` 取证帧，实跑 **22/22、退出码 0**：
  - 群文件面板（`-files.png`）：标题「群文件 (1)」、汇总「共 1 个文件 · 1.0 KB」、行 `g2.bin`
    （BIN · 1.0 KB · 未知成员）对齐，空槽/上传按钮与行高正常，无裁切或重叠；
  - 群任务面板（`-tasks.png`）：标题「0/1 已完成」、筛选胶囊「全部 1 / 给我的 1 / 我创建的 0 /
    已归档 0」、任务行「写周报」与发起/指派元信息在同一行簇内，无溢出。
- 结论：两张实图均未发现布局/信息层级缺陷，本轮不为了"有改动"而改样式。
  群文件/群任务的交互判据已在同一段内覆盖（打开、筛选、行点击、关闭）。
- 聊天搜索也补了视觉帧（`-search.png`，`--only=search` 仍 **16/16**）：搜索框、发送人/日期筛选、
  会话卡片、3 条命中（文本 / 任务 / 图片）与高亮都正常；截图里的「1970年1月1日」是夹具 `ts=1`
  的产物，不是产品缺陷。
- 群任务详情也补了视觉帧（`-taskdetail.png`，`--only=tasksrt` 由 14 条扩到 **15/15**）：
  矮窗口下内容区可滚到底，描述与操作记录能完整露出，footer 的「完成 / 编辑」不被遮住。
  至此前述列出的重点面板都已有实图或真实 Tauri 读数。
- 移动端日志页（390×844，Chrome 触摸仿真，`--only=logs` 由 3 条扩到 **5/5**）：
  返回/标题/计数/图标工具栏/复制/时间窗口/筛选/虚拟行全部在视口内，
  `scrollWidth == innerWidth`（无横向溢出）且滚动容器有真实高度；取证帧 `-logsmobile.png`。
- 移动端设置（390×844，`--only=settingsmobile` **4/4**）：一级分组列表、一级→「外观」二级页、
  6 个预设色 + 自定义色完整可见（预设宽 ≥20、自定义色 ≥24，且都在行内）、返回一级都通过；
  取证帧 `-settingsmobile.png`。
- 移动端群任务（390×844，`--only=tasksmobile` **2/2**）：任务行渲染、无横向溢出/越界按钮，
  点行打开的详情弹窗整个在视口内；取证帧 `-tasksmobile.png`。
- 移动端群文件（390×844，`--only=files` **10/10**，其中移动端 2 条）：文件行渲染、
  无横向溢出/越界按钮、面板宽度不超过视口；取证帧 `-filesmobile.png`。
- 移动端输入框（390×844，`--only=composermobile` **2/2**）：表情/代码/附件/发送都在视口内，
  编辑器宽度 ≥100，无横向溢出；取证帧 `-composermobile.png`。
- 移动端搜索（390×844，`--only=search` **18/18**，其中移动端 2 条）：弹窗不超视口、
  无越界按钮、结果仍渲染；取证帧 `-searchmobile.png`。

### 6.21 2026-10-19 收藏页移动端崩溃与详情标题修正

- **真实缺陷 1（崩溃）**：`useBackLayer` 内部是 `watch(..., { immediate: true })`，在 setup 里**同步**求值；
  收藏页把 `const active = ref(...)` 声明在两个 `useBackLayer(...)` **之后**。桌面端 `app.isMobile`
  为假时被短路掩盖，移动端一打开收藏页就 `Cannot access 'active' before initialization`（TDZ）。
  真实 Chrome 触摸视口实测复现；修法是把 `active` 声明移到两个 `useBackLayer` 之前，并加
  `designGuards.test.ts` 顺序判据防回退。
- **真实缺陷 2（错误标题）**：移动端详情头部用的是 `displayName(active)`，文本收藏没有文件名，
  于是标题显示「文件」。改为 `rowTitle(active)`：文本显示正文摘要、卡片显示标题、文件才显示文件名。
- **新增运行时验收** `--only=favorites`（8 条）：真实 store + 真实 Query 无关，只替 `listFavorites`：
  三条列表与搜索、五个筛选（含空结果提示）、详情正文与四条操作、移动端两级覆盖层与返回；
  截图 `-favorites.png` / `-favorites-mobile.png` 复核了列表/详情/底部操作条（操作条铺满详情宽度）。
- **新增运行时验收** `--only=links`（5 条）：标题/行/编辑删除按钮、点行发 open、添加表单为空、
  编辑预填、取消恢复；截图 `-links.png` 复核窄栏布局。
- 备注：探针宿主原先把组件当 `display:flex` 的**非增长**子项（桌面详情只剩 690px 宽），
  那是夹具自己的量具错误；改成 `display:block` 后详情铺满、操作条正确分布。
- 读数：定向 **13/13、退出 0**；全量 UI 探针 **374/374、退出 0**；`npm test` **1044/1044、0 失败**；
  `npm run build` 退出 0（`main` 308.05 kB / gzip 93.00）；`npm run verify:local` **22/22、74.4s**。

### 6.22 2026-10-19 真实 Tauri：设置窗 / 日志窗复验

- 环境：隔离 `HOME=/tmp/gosslan-ui-home-*`，显式 `RUSTUP_HOME=/Users/wendongfu/.rustup`、
  `CARGO_HOME=/Users/wendongfu/.cargo`；真实 `tauri dev` 编译并启动当前工作树前端。退出后已停止进程并删除临时 HOME。
- **主窗**：真实 WKWebView 渲染成功；在输入框真实键入 `uiprobe-`（系统自动更正弹层也出现），
  证明键鼠事件确实进入 WebView。
- **设置窗**：`Cmd+,` 从真实菜单打开「设置」窗（780×600），
  左栏（个人资料/通用/通知/外观/网络与连接/文件与共享/存储/安全/关于/重置与数据）与个人资料卡片完整渲染。
- **日志窗**：菜单「帮助 → 打开日志窗口」打开「运行日志」窗（760×560）：标题「运行日志 N 条」、
  `自动刷新 / 刷新 / 清空 / 复制`、窗口筛选、`30s / 1分钟 / 2分钟`、`合并重复`、搜索框与虚拟行全部可见；
  运行中日志条数从 65 实时增长到 74（自动刷新真实生效）。用真实鼠标点击「合并重复」：
  按钮退为未激活、行尾的 `×2` 分组标记消失、条数从 71 变为 74 ⇒ WKWebView 内按钮状态与列表重算真实可用。
- **键盘导航**：设置左栏用 Tab 移动时焦点环可见，Enter 从「通用」切到「外观」，说明键盘可达。
- **Reka Select（真实 WKWebView 浮层）**：在外观页真实点击「字体」下拉，Portal 菜单在触发按钮下方展开
  （苹方/微软雅黑、思源黑体、等宽字体）；按 ↓ + Enter 选中「思源黑体」后菜单收起、触发器文案变为
  「思源黑体」。这直接验证了 Reka 的 Portal + popper 定位 + 键盘选中在 WKWebView 内可用。
- **Reka Slider**：点击字号滑杆第 4 档，滑块移动、标签从「14px · 标准」变为「16px · 大」、预览气泡同步放大。
- **输入框表情 Popover（真实 WKWebView）**：用「通讯录 → 自己 → 发消息」进入自聊（不依赖任何对端），
  点击输入框的表情按钮，Reka Popover Portal 在输入框上方展开（常用 / 全部表情，无裁切）；
  这补齐了「WKWebView 内至少一处业务锚定浮层」的读数。同一条自聊里用 Cmd+Enter 与
  「Tab 聚焦发送键 + Enter」都真的发出了消息；代码模式按钮点击后进入代码模式，消息以
  `[代码]` 卡片渲染。鼠标直接点「发送」在 WKWebView 的自动化坐标下没有稳定命中
  （Chromium 的鼠标出口已由 `--only=inputpanel` **23/23** 证明；键盘激活在 Tauri 也已证明），
  不据此判成产品缺陷。
- **消息行浮层（真实 WKWebView）**：在隔离 HOME 的 `gosslan.db` 里种一个 `group:probe` 群 +
  一条文本 + 一条 `kind='reaction'` 记录（不接任何对端），真实 Tauri 渲染出群会话、气泡和
  「[赞] 1」胶囊；点击气泡外侧笑脸打开 Reka Popover 表情面板，悬停胶囊打开 Reka HoverCard
  名单（显示 Noble Falcon JGI）。消息行的 Popover 与 HoverCard 两条都拿到了真实读数。
  已读名单 Popover 没有单独点，但它与已验证的回应选择器是同一个 Reka Popover 原语。
- **仍未验证**：Windows/Android/iOS 真机、E2E 仍 **NOT RUN**。
- 注意：该 dev 实例与局域网里的并行 E2E 进程互相发现并收到过对端消息；隔离数据库已随临时 HOME 删除，
  没有读写用户真实数据，也没有把这次运行当作 E2E 证据。

### 6.23 2026-10-19 接线判据空转修复（护栏注入实测抓出）

- **发现**：`verify-guards.py --only 已读名单` 首次实跑报「改坏之后测试仍然通过」。
  根因是 `rekaPrimitives.test.ts` 只用 `src.includes("PopoverPortal")` 做接线断言 ——
  **`import { PopoverPortal } from "reka-ui"` 本身就满足它**；把模板里的 `<PopoverPortal>`
  换成 `<div>` 后，测试仍然绿。这正是「存在性断言只是半个守卫」的现场复现。
- **修法**：四组组件（回应名单 / 已读名单 / 消息表情 / 输入框表情）的断言全部改成只认**模板标签**
  （`<HoverCardRoot` / `<PopoverTrigger` / `<PopoverPortal` …），并同步了护栏声明的 fail-hint。
- **验证**：`verify-guards.py --only 已读名单` **退出 0**：注入态必红且由声明的那条判据报出，
  还原态必 PASS（改坏即 FAIL、恢复即 PASS 两半都成立）。这比 `--list` 的锚点核对强一层：
  证明这条判据真的会失败。
- 这条修复只动测试/护栏与文档，不改生产代码。
- **全量前端护栏（86 条）**也跑了一遍：首跑 **85/86**，唯一失败的是
  「操作面板：点任何一项都要收起」。根因不是测试弱，而是**注入锚点指错了元素**：
  旧锚点（12/10 空格缩进）实际命中 `ActionSheet.vue` 里的「取消」按钮，
  面板 `DialogContent` 的 `@click` 仍在，所以删掉按钮后测试照绿。
  把锚点改成面板开标签真实的 8/6 空格缩进后，单条复跑 **1/1、退出 0**
  （注入态必红且报 `必须在点击时收起`，还原态必 PASS）；其余 85 条在同一源码树上已通过。
- 结论：这两条空转都不是「测试没写」，而是**判据/锚点没有真的指到被守的语义**；
  它们只有在真正注入并观察失败时才会暴露。完整 231 条仍留给发版/CI（本地只跑了前端族 86 条）。

### 6.24 2026-10-19 字体「系统默认」档被 Reka Select 吞掉

- **发现**：真实 Tauri 打开「外观 → 字体」下拉时，菜单只有三档（苹方/微软雅黑、思源黑体、等宽字体），
  「系统默认」不见了，触发器也是一片空白。根因是默认档的 option value 写成空串 `""`，
  而 Reka 的 `SelectItem` 不渲染空串值；触发器又按值匹配标签，于是空值匹配不到任何选项。
  这同时意味着用户**无法把字体切回系统默认**。
- **修法**：默认档改用非空哨兵 `__gosslan_system__`，`fontModel` 把存储里的空串映射成哨兵，
  `onFont` 再把哨兵落库回空串；存储格式不变，哨兵不外泄。
- **验证**：新增 `--only=fontsel` **4/4、退出 0**：默认触发器显示「系统默认」、菜单四项齐全、
  ↓+Enter 选中苹方后触发器与落库字体栈同步、再切回默认后 `localStorage` 为空串；
  取证帧 `-font.png` 可见菜单四项。另加 `designGuards.test.ts` 源码判据锁住
  「不许空串 option / 必须有哨兵互映」，防止 CI 看不到 UI 探针时静默回退。
  全量 UI 探针 **396/396、退出 0**（含群任务详情滚动判据、「发送」按钮鼠标出口、
  回执入口与回应入口的命中区不重叠，以及移动端日志/设置/群任务/群文件/输入框/搜索
  390 宽无横向溢出）。首跑一次在 overlay 段后 renderer 的 CDP 调用 45s 未回包
  （255/256，判的是探针自身没跑完，不是产品红）；第二次跑时残留的 probe Chrome/profile
  让端口检查当场判红（这正是那条检查的用途），清掉后 **396/396**。
  `npm test` **1045/1045、0 失败**；
  `npm run build` 退 0（`main` 308.05 kB / gzip 93.00）；`npm run verify:local` **22/22、75.7s**。
  生产代码改动未提交、未 bump 版本号。

### 6.25 2026-10-19 已读名单弹层的真实 WKWebView 点击验收（顺带修掉 AX 探针的一个盲区）

- 这一格补的是 §6.22 留下的那句「已读 Popover 未单独点」：此前它只有 Chromium 探针，
  没有真实 WKWebView 上的点击证据。按下走**系统无障碍 `AXPress`**（不是合成鼠标，
  上一轮合成鼠标在回执/回应入口上判不准）。
- 做法：隔离 `HOME` + `GOSSLAN_INSTANCE=88` 直接起已有的 dev 产物（**不重编 Rust**，
  避开并行会话的 cargo 锁），vite dev 端口 1420；用 `node:sqlite` 往隔离库塞一个 5 人群
  （我 + 4 名已读者）、3 条消息、`group_reads` 4 行，再 `AXPress` 回执入口。
- ★ **抓出探针自己的盲区**（改前）：`scripts/ax-tree.mjs` 的 `collect()` 与 `listPressables()`
  只认 `AXButton / AXLink / AXCheckBox / AXMenuItem`，而**真实 WKWebView 会把带 `aria-haspopup`
  的 `<button>` 映射成 `AXPopUpButton`** —— Reka 的 PopoverTrigger / SelectTrigger /
  DropdownMenuTrigger 全是这一类。后果不是"少一条读数"，而是**界面上明明渲染了
  `desc="已读 4 人，查看已读成员"`，探针却报「没有可点元素」**：每一个锚定浮层入口
  在这条取证路上都不可用。把 `AXPopUpButton` 加进两处可点集合后，同一棵树当场列出
  `8 AXPopUpButton | 已读 4 人，查看已读成员`、`7 AXPopUpButton | 添加表情回复`、
  `6 AXPopUpButton | 表情`（可点元素 17 → 25）。
- ★ 另一条取证坑（记进判读口径）：`GOSSLAN_INSTANCE=n` 时运行时 device_id 是
  `<settings.device_id>-i<n>`（`src-tauri/src/state.rs:1424`）。种子若直接写 `settings.device_id`，
  那些消息会被判成**别人发的** —— 表现是自己的消息左对齐、带昵称、没有回执，
  看着像"回执功能坏了"。改指 `-i88` 后回执与弹层全部正常。
- 读数（真实窗口截图 + 像素采样，`/tmp/gosslan-receipt-*.png`）：
  - 浅色：弹层标题「已读成员（4）」+ 4 行头像与昵称（琥珀/蔷薇/青瓷/紫罗兰），锚在触发器下方、
    右缘与气泡列对齐，圆角/描边/磨砂底都正常。
  - 深色：同一弹层正常渲染，没有残留浅色底。
  - **Esc（真实键盘 `key code 53`）收起**，且焦点回到触发器并显出 `:focus-visible` 描边
    ⇒ Reka 的 DismissableLayer 与焦点归还在 WKWebView 里成立，不只是 Chromium 里成立。
  - 顺手用像素采样否掉一句凭截图产生的怀疑：深色下「我的气泡」实测 `#513f99`（luma 79，
    设计目标 74）、文字 `#d4d4d4`（luma 212 = 目标 212）⇒ `softenMineForDark` 生效，
    **不是**"暗色分支没接上"，因此不改（`src/utils/chatStyle.ts:123`）。
- 边界：只有 macOS / WKWebView 这一条腿。Windows WebView2、Android/iOS 真机、E2E 仍 **NOT RUN**
  （本机无 AVD/system-image/iOS 模拟器/iOS Rust target，见 §7）。
  取证期间一次 `set frontmost` 没生效，那次 Esc 落到了前台的另一个应用（无破坏性动作）。
  隔离 HOME 与那份库已删；用户真实 `gosslan-1/2/3.db` 的数据 mtime 仍是 10-13 / 10-16，未被动过。

### 6.26 2026-10-19 划选打断、假空态、假错误出口与两处间接层（只读审计 + 变异证明）

- 这一批的来源是一次**只读**全仓审计（重复实现 / 死导出 / 无意义包装层三类），
  逐条自己复跑到行之后才动码。审计给的 195 条"无用导出"候选里，
  真正零引用的值导出只有 `useBackLayer.ts::backLayerDepth` 一条，而它自己的注释写着"诊断用"
  ⇒ 判为**故意留的排障出口**，不删。模块层没有死文件（每个 utils/composables/ui 文件都有 ≥1 个生产 import 方）。
- **① 划选被图片打断（真实交互缺陷，桌面端还能把图片拖出窗口）**：
  `-webkit-user-drag: none` 2026-09-13 那次只加在 `.emoji-img` 上（当时判的是"划过表情选区中断"），
  而全仓 26 个 `<img>` 只有 2 处自己写了 `draggable="false"` ⇒ 划过**头像 / 图片气泡 / 文件图标**
  依旧会变成拖图片。收口成一条全局 `img` 规则（`src/style.css`），
  并把这条不变量加进已有判据 `checkSelectionContract` 的 ⑤-b（`src/utils/designGuards.ts`）。
  只禁拖拽，**没有**加 `user-select:none` —— 那会连带丢掉图片 alt 的复制。
- **② 文件角标三处各写一遍，漂移已经变成假空态**：
  `GroupFilesPanel` 与 `MessageFileBubble` 是 `ext.toUpperCase().slice(0,4) : t("common.file")`，
  而 `FavoritePanel` 那处是裸的 `fileExt(name).toUpperCase()` —— 既不截断也不兜底，
  **没有扩展名的文件在收藏详情里渲染成空串 + 一个孤零零的「 · 大小」**。
  新增 `utils/fileKind.ts::extBadgeLabel(name, fallback)` 一份，三处调用点收口
  （`fallback` 由调用方传，本文件继续不碰 i18n）。
- **③ 群任务的错误出口有两种表现**：`GroupTasksBoard.vue` 同一文件里 8 处 `catch`，
  4 处走 `app.toastError(e, …)`、4 处走 `app.toast(String(e), "error")`。
  后者既把原始异常串（`Error: [object Object]` 这类）直接甩给用户，又**不进日志**
  （`toastError` 才走 `reportError`）—— 而 `useAppStore.ts:230` 的注释早就写明
  "所有 catch 里的错误提示都应走这里"。四条统一到 `toastError(e, t("todo.updateFail"))`
  （同一个 `updateTodo` 动作，前缀沿用既有那句，不新增文案）。
- **④ 两处零语义间接层删除**：`filePreview.ts` 里为"不动 import 点"留的
  `export { imageMime }` 转出（它把刚做出来的断环方向又写模糊了，两个消费者改指
  `utils/imageMime.ts`）；`GROUP_FILES_QUERY_POLICY = PANEL_QUERY_POLICY` 别名
  （1 个消费者改指 `panelQuery` 本体）。
- **判据不是写完就算**：三条新判据各做了一次**单点变异证明**（注入→必红且由点名那条报出、
  还原→必绿），实测 A/B/C 三次注入分别 `exit=1` 并打印
  `扩展名角标必须走 …extBadgeLabel`、`错误出口必须统一走 app.toastError`、
  `全局 \`img\` 规则缺少 -webkit-user-drag: none`，随后逐条还原。
- **明确否掉的两条审计建议**（记下来免得下一轮又被"发现"）：
  ① 14 处内联头像片并进 `MessageAvatar.vue`（审计估 −60 行）—— 这些点在
  `h-4…h-14`、`rounded-full` vs `--gosslan-avatar-radius`、离线灰度、
  以及 `SelfAvatar`/`ConversationListItem` 的多格拼图结构上**各不相同**，
  而默认头像是设计过的功能；一次 14 文件的视觉重构换 60 行，
  尺寸档写错的表现是视觉回归而不是测试红 ⇒ 不做。
  ② `useDeferredRef`/`useSearchKeyword` 换成 `@vueuse/core` 的 `refDebounced`——
  现值只有约 50 行、带 `onBeforeUnmount` 取消待执行提交，且 `defer.test.ts` 里有
  三处**接线判据**按名字钉着它（"建了镜像却仍读原值"那种骗不过）；
  换库要连带重写判据，收益只是行数 ⇒ 不做（"确有收益再迁移"这一档没过）。
- **实测读数（当前树）**：`npm test` **1048/1048、0 失败、退出 0**；
  `node scripts/check-ui-runtime.mjs` **396/396、退出 0**（第一次跑在 overlay 段之后 CDP eval 45s 未回包，
  停在 254/256；单独跑挂起点那两段 `--only=imgskel` 两次 7/7 ⇒ 判为并行 cargo 抢 CPU 下的冷编译超预算，
  不是产品红 —— 这条与 §6.24 那次是同一族，探针的预算守卫把它响亮地报了出来）；
  `npm run verify:local` **22/22、退出 0、532.0s**（耗时被并行会话抢 `src-tauri/target` 的 cargo 锁放大，
  无抢锁时同层 75.7s）；两份文档门禁 **退出码 0**。
- **行数账要按口径说清**（复跑：`git diff HEAD --numstat -- src` 分别按"排除测试与 i18n"和"再排除
  `designGuards.ts`"各算一次）：`designGuards.ts` **只有测试引用**（应用码里零 import），
  所以它是量具不是产品码。修正口径后累计**应用码净 −234**（+354 −588）；
  本轮这一批本身是**应用码小幅净增**（新增一条全局 CSS 规则 + 一个 `extBadgeLabel` 出口），
  换来的是三处重复实现收口成一处、两处零语义间接层删除、三条新判据（都已做变异证明）。
  ⇒ 不把这一批写成"非业务代码又少了多少"。
- 取证边界：本批想再在真实窗口里点一次已读名单弹层做回归确认，但那一刻并行会话起了 3 个实例
  （我的实例已被 E2E 网格发现并建链）⇒ 按"不扰动别人在跑的轮次"处理，**只按 pid 停掉自己那一台**，
  多实例下 WKWebView 控件树读不到（只有第一台建得起来）这条限制照旧记着，不拿它当产品结论。
  真实窗口的弹层点击证据仍归 §6.25（那一次是本批改动之前、单实例状态下取的）。
- **另外两条审计建议也按实测否掉**（都复读到行才判）：
  ① `utils/color.ts` 的 `mix` 与 `mixHex` 不是同一个活：一个出 `rgb(...)` 供 CSS 直接用、
  一个出 hex 供继续参与混合链，且 **`mixHex` 带 0-255 钳位而 `mix` 不带**。合并省下约 5 行，
  代价是给所有派生色加一次钳位 ⇒ 不做。
  ② `ChatSearchDialog.vue:242` 那个手写 `setTimeout` 不是 `utils/defer.ts::debounce` 的重复实现：
  它的 watch 里"清空关键词"那一支要**立即**清结果、只有非空词才走 150ms 合并。
  换成通用 debounce 会连带改掉那一支的触发时机（搜索是热路径）⇒ 不做。
- **本轮欠的一格（不是没做，是被并行轮次挡住）**：真实 WKWebView 下的**移动端布局**
  （把窗口收到 390 宽看 `is-mobile` 那一套）—— 本机此刻并行会话的 3 个 E2E 实例正在跑，
  再起一台会被它们的网格发现并建链（本轮已经实测到这条：我那台起来后立刻
  `link peer=gosslan-…-i2`），会改动别人那一轮的邻居数 ⇒ 停了自己的实例、把这一格留给
  并行轮次结束之后再取。此前移动端布局只有 Chromium 390 宽的探针读数（`settingsmobile`
  `tasksmobile` `files` `composermobile` `search` `logs` 六段），真 WebView 那一半仍未证。

### 6.27 2026-10-19 真实 WKWebView 下的移动端布局（把窗口拖窄，不碰并行轮次）

- 这一格补的是 §6.26 末尾登记的那条欠账。做法：隔离库先把 `settings.lan_enabled` 置 `0` 再起实例
  （启动日志里 `discovery` 行数 **0** ⇒ 它没有加入局域网，不会改动并行会话那一轮的邻居数——
  这条前置是必须的，因为并行 E2E 当时就在跑）。窗口用系统无障碍收到 **390×768 点**
  （`tauri.conf.json` 的 `minWidth: 360` 本来就允许拖窄，所以这是受支持状态，不是畸形窗口）。
- 读数（按窗口真实边界裁图后判，不看整屏缩略图）：
  - 列表页：**单列**（搜索框 + 会话行 + 底部 TabBar 四项），无横向溢出；
  - `AXPress` 会话行 → 聊天页**整页推入**：左上出现 `AXButton | 返回`、TabBar 依 `showMobileTabBar` 收起、
    头部四个动作（成员/文件/任务/补历史）都在，**已读回执头像栈在移动端同样渲染**；
  - `AXPress` 「返回」→ 回到列表、TabBar 回来 ⇒ 移动端的 push/pop 与 TabBar 显隐规则在真实
    WKWebView 里成立（此前只有 Chromium 390 宽的探针读数）。
  - 可点元素账：列表页 6 个、聊天页 14 个（含 2 个 `AXPopUpButton | 已读 4 人，查看已读成员`、
    3 个「添加表情回复」）——第一次读仍是 0（WebKit 懒建 AX 树），重试一次才挂上。
- ★ **一条判读教训（记进取证口径）**：第一次判"移动布局没生效、聊天被裁成两栏"是**看整屏缩略图**看出来的，
  按窗口 bounds 裁出来再看是正常单列。本机截图像素/点的比例**不是常数**（这张屏是 2.0，
  此前另一台记录里是 1.342）⇒ 几何结论必须每次从 `position`+`size` 现算，不能拿上一次的换算系数。
  这次没有据此改任何代码——**"看起来不对"先怀疑自己的尺子**。
- 边界：桌面端窄窗触发的是 `resolveMobileLayout` 的**宽度兜底**那一支；Android/iOS 真机
  （平台优先那一支 + 触摸/安全区/权限弹框时序）仍 **NOT RUN**，按分工归用户。

### 6.28 2026-10-19 判据 ㊵ 的分母是手抄的，漂移已经漏掉两处真违规

- **发现方式**：量"图标入口有没有被绕开"时，先看入口自己导出什么，再看判据守什么。
  `src/components/ui/icons.ts` 具名导出 **7** 个
  （`AlertCircle, Check, ImageOff, Loader2, RotateCcw, Trash2, X`），
  而守它的判据 ㊵ 用的是**手抄清单** `SEMANTIC_ICON_NAMES = ["Check","Loader2","RotateCcw","Trash2","X"]` —— 只有 5 个。
- **漂移不是理论风险，已经漏了**：只读干跑（用判据自己的函数、不改任何文件）量化过：
  ```
  从入口现算出的分母: 7  AlertCircle,Check,ImageOff,Loader2,RotateCcw,Trash2,X
  扫描 202 份源码 ⇒ 直连命中 2 处
     src/components/MessageItem.vue:42
     src/components/message/MessageImageBubble.vue:4
  对照：旧手抄清单（5 个）命中 0 处
  ```
  ⇒ 判据一直打的「直连 lucide 0 处」是**分母少抄两个名字**换来的绿；
  那两处 `ImageOff` 违规真实存在，而同一个图标在 `StateBlock.vue` 是走入口的 —— 两种来源并存。
- **修法（按"分母要从那个家现解析"这条口径）**：
  ① 判据的名单改成从 `icons.ts` 那行 `export { … } from "lucide-vue-next"` **现解析**；
  ② 配一条 `>= 5` 的**非空转下限** —— 否则"把入口导出清空"会让分母塌成 0，
     于是"全库 0 处违规"变成一条永远绿的判据（这是现解析本身带进来的新失败模式，必须一起堵）；
  ③ 两处 `ImageOff` 改走入口（纯 import 改动，组件与图标本体都没动）；
  ④ 入口注释里写死的「这 **5** 个名字」去掉，改成"判据从本文件现解析分母"。
- **两条变异证明**（各改完即还原）：
  - 把 `MessageImageBubble.vue` 的 `ImageOff` 改回直连 ⇒ `exit=1`，
    且报的就是那条新消息：`components/message/MessageImageBubble.vue:4 高频语义图标 \`ImageOff\` 必须从 @/components/ui/icons 引`；
  - 把入口导出砍成一个名字 ⇒ `exit=1`，报 `只从 ui/icons.ts 解析出 1 个名字 ⇒ 分母塌了，这条判据不再成立`；
  - 还原后 `exit=0`，判据自报 `· ㊵ 分母：扫 202 份源码，高频语义图标直连 lucide 0 处`。
- **读数**：`npm test` **1048/1048、0 失败、exit 0**；`npm run verify`（快速层，含 vue-tsc 与构建）
  **17/17、46.1s、exit 0**。
  另外一条过程账：§6.26 那一批落地后先把前端护栏族**整族**跑过一遍 —— **86/86 通过非空转验证、exit 0**
  （耗时 39 分钟，因为并行会话同时在冷编 `src-tauri/target`；平时这一族 13–15 分钟）。
  本轮这批（只动 import 与判据）之后又在最终树上复跑一次同一族。
- 顺带否掉的两条（同 §6.26 的口径，都不做）：`shareTreeKey` 是生产零引用但删它要连带删在过的断言，
  换 1 行源码不值；字号 `text-[Npx]` 265 处裸写里 4 档占 258 处、10px 只在开发者诊断面板，
  没有实测缺陷支撑就不做 token 化。

### 6.29 2026-10-19 同一族第二个"手抄分母"：窗口登记表比磁盘少一扇就全绿

- §6.28 那一条修完，按同一个失败形状去查别的判据：`src/utils/windowEntries.test.ts` 里
  **同一批窗口被手抄了两处**（`WINDOWS` 表 + 另一段入口清单），而它所有"每个窗口都必须有骨架/主题脚本"
  的循环**只遍历这张表** ⇒ 新增一扇窗忘了登记，这些判据全部照绿。
  实测今天没漂（`src/entries/` 5 个入口 = 表里 5 行），但注释里两个数量都是旧的
  （文件头写「三个窗口（主/设置/日志）」、表上方写「四个窗口」、断言消息写「三个窗口必须是三个不同的入口」，
  实际 5 扇：主 / 设置 / 日志 / 群任务 / 图片预览）。
- **修法**：加一条**从 `readdirSync("src/entries")` 现算**的集合相等断言（新增窗口没登记就当场红），
  并把三处写死的数量改成不依赖条数的说法。
- **变异证明**（一次单点注入，用完即删）：往 `src/entries/` 放一个 `zz-guard-probe.ts` ⇒
  `exit=1` 且报 `窗口登记表与 src/entries/ 的实际入口不一致 ⇒ 新窗口没在这里登记，按表循环的判据全都覆盖不到它`；
  删掉后同一文件 **13/13、exit 0**，`ls src/entries` 回到 5 个入口（临时文件没有留下）。
- **读数**：`npm test` **1048/1048、exit 0**；`npm run verify` 快速层 **17/17、23.2s、exit 0**。
  §6.28 那一批的**前端护栏族整族复跑也已通过：86/86、exit 0**（在最终树上；这一次是补 §6.26/6.27
  那批的账，之后按用户口径本地不再起整族 —— 长门禁归发版前与远端 CI）。
- **判据族小结（本轮三处"绿不等于守住"）**：① 存在性断言命中 import 行（§6.23）；
  ② 注入锚点指到同文件另一个元素（§6.23）；③ **分母手抄、且与它要守的那个家漂移**（§6.28 图标、§6.29 窗口）。
  三条都是"跑得很绿、覆盖面却比声称的小"，只有真注入或现算分母才会暴露。

### 6.30 2026-10-19 提交前双轴审查：两条被顺手删掉的变异证明 + 名单的第二条状态源

- 用户授权提交前按「标准轴 / 规格轴」把 44 个文件的未提交批次重读了一遍。**两条都是本轮自己造出来的问题**，
  不是历史欠账，所以都在提交前修掉而不是记账。

- **① 两条非空转用例被连带删除（严重）**。§6.23 把「浮层 escape」两条真实文件注入换成一条 Reka 接线注入时，
  同一个 `Case(...)` 块里**相邻的两条 SelfAvatar 用例也一起没了**——它们守的是
  「三处都走 `<SelfAvatar>`」和「图片那一支只有 `app.device.avatar` 一个取值口」，
  与浮层迁移毫无关系。取证：两条断言今天还在 `designGuards.test.ts:2147 / :2161`，
  两个注入锚点在真树里仍**逐字命中一次**（`ResponsiveLayout.vue:619`、`SelfAvatar.vue:42`）
  ⇒ 删它们没有客观理由，属于"重构判据册时误伤"。按本仓库口径这就是**删断言**，目标里明令禁止。
  **修法**：原样恢复两条用例（正文一字未改），总数 231→**233**、前端族 86→**88**，
  `docs/ARCHITECTURE-MAP.html` 那个现算数同批改 233（判据 E 对账）。
  **读数**：`verify-guards.py --only 本人头像那一处不再渲染` **1/1、exit 0**（改坏即 FAIL、恢复即 PASS，
  红由声明的那条 fail-hint 报出）；`--only "SelfAvatar 的图片改回"` **1/1、exit 0**。
  跑完 `git status` 复核两个被注入的文件没有残留（`UserCircle class="h-14 w-14` 命中 0 次）。

- **② `MessageReactionBar` 的"开着哪一颗"有第二条状态源（真实缺陷，桌面端可复现形状）**。
  §6.23 迁移到 Reka `HoverCard` 时，把旧的 `@mouseleave`/`@keydown.esc` 关闭出口交给了库，
  但 `@mouseenter → reveal()` 里那句 `openEmoji.value = emoji` 被留下 —— 而名单**真的**展开要等
  `open-delay=120ms` 之后库回写。于是指针在 120ms 内进出（横向扫过一排胶囊是日常动作）：
  名单从未出现，`aria-expanded` 与 `data-open-emoji` 却停在 `true`。这正是旧实现用
  `watch(pos)` 反向同步堵过的那个形态，迁移时把它重新引入了。
  **修法（同时减一个状态源）**：`openEmoji` 改为 `computed(() => canHover ? hoverOpenEmoji : touchOpenEmoji)`，
  `reveal()` 只算 `align`、桌面不再点亮状态；`isOpen()` 这个函数整个删掉（它与派生值同一件事），
  触屏一支仍由 `reveal()` 唯一开启、由库回写关闭。三 ref + 一个函数 ⇒ **两 ref + 一个派生值**。
  **判据**：`reactionRoster.test.ts` 加两条 ——`const openEmoji = computed(` 必须在、
  `openEmoji.value = ` 必须不在（派生值被直接写就是第二条状态源）。
  **不加**运行时探针那条：结构上赋值口已经封死（源码判据会红），而探针只能靠合成 `mouseenter`
  制造 120ms 窗口——§6.19 那册明确写过"刻意不再留合成 mouseenter 兜底"，为了这一条把它请回来不划算。
  **读数**：`npm test` **1048/1048、exit 0**；`npm run verify` 快速层 **17/17、18.5s、exit 0**；
  UI 探针 `--only=reaction,roster,touchroster` **70/70、exit 0**（含 hover 名单展开/贴边夹取、
  移动端长按 450ms 展开、松手不收起、点外收起）。

- **规格轴**（目标五条逐条对）：①剩余验证——已读回执 Popover 的真实 WKWebView 点击已补（§6.25），
  Windows/Android/iOS/E2E 只登记不伪报；②真实 UI 差距——§6.26/6.27 的划选、假空态、移动端窄窗；
  ③通用自研清理——`hoverCard`/`popupPosition`/`useHoverCard` 三个家已删干净（`git grep` 现在只剩
  **禁止它们复活**的断言），本轮再加两条：`GROUP_FILES_QUERY_POLICY` 与 `filePreview` 里的 `imageMime` 转出；
  ④可读性——§6.28/6.29 两个手抄分母改现算，本轮 ② 又减一个状态源；⑤验证持续推进——见上面读数。
  **没做到的**：预览窗口（`PreviewWindow.vue`）的真实 WKWebView 点击仍 NOT RUN；真机观感判断归用户。

### 6.31 2026-10-19 前端全量盘点（专项启动）+ 第一批：时间文案收口到 vue-i18n + dayjs

- **盘点口径先立住**：新增 `scripts/frontend-inventory.mjs`，把清单第 1 节做成**现算生成**
  （`--check` 对账），产物 `docs/architecture/frontend-inventory.md`。现读：
  `src/` 299 份源码 = 生产 204 份 / 42,615 行 + 测试 95 份 / 17,596 行（不含 `src/assets/` 214 张表情图）；
  16 个生产依赖**全部**在生产码里有使用点 ⇒ 没有"装了没用"的包袱。
  分类里要单列一档：`designGuards.ts`(2041) + `a11yLabels.ts`(131) + `templateBranches.ts`(174) 只被测试与门禁读，
  住在 `src/` 但不进产物 —— 算进"业务简化成果"就是自欺。
- **盘点捞到的第一批真实缺陷（用户可见，且机器可判）**：
  ① 「今天/昨天/一周内/年内/跨年」这套判断在 `utils/chatStyle.ts:formatTimeDivider` 与
  `utils/time.ts:fmtConversationTime` 里**各写一遍**；
  ② 星期表 `WEEKDAYS = ["周日"…]` 与「昨天」「M月D日」「YYYY年M月D日」是**硬编码中文**，
  绕过了已装的 `vue-i18n` ⇒ 英文界面里每条消息的时间分割线都是中文（含搜索页两处）；
  ③ `composables/useMessageDisplay.ts` 又自己 `dayjs(ts).format("YYYY-MM-DD HH:mm:ss")` 一遍
  （那就是 `fmtDateTime`）。
- **改法（三档结论各归一处）**：格式化**形状**（哪一档用月日、哪一档带年份）是产品口径，留在 `utils/time.ts`；
  **词语与月日排列**进词典（`date.yesterday` / `date.md` / `date.ymd`，中英各三条，
  key 一一对应由 `i18n/index.test.ts` 那条现成护栏逼着）；**星期名 / 月份名**交给 dayjs 自带的 locale 数据。
  因 `utils/*` 被 `node --test` 直接 import、裸 Node 解析不了 `@/` 别名 ⇒
  文案与语言都由调用方注入（`t` + `currentLocale()`），沿用 `extBadgeLabel(name, fallback)` 那个先例。
  12 处调用点全部改完；`chatStyle.ts` 里那份实现与那张星期表删除，`dayjs` 依赖也从该文件摘掉。
- **P0 形状：全局 locale 不参与响应式**（这一条是探针自己抓出来的，不是我推出来的）。
  第一版按"`i18n` 换语言时同步 `dayjs.locale()`"实现，`locale` 段真浏览器跑到最后一条时报
  `{"backZh":"zh-CN","zhWeek":"Fri 12:00"}` —— 切回中文后分割线仍印英文星期名。
  成因：`dayjs.locale()` 是模块级全局，而 `timeDividerText` 这个 computed 不依赖它 ⇒ 不重算
  （「昨天」那一支反而对，因为 `t()` 读了 reactive 的 `locale`）。
  改法：语言**作为参数传进格式化函数**，内部用 `dayjs(ts).locale(L)` 取实例级 locale。
  同时 `time.ts` 不再有任何全局副作用（新增一条判据：剥掉注释后不许出现 `dayjs.locale(`）。
- **判据侧两条账**：
  ① 新增护栏用例「时间列把文案注入丢掉」，第一次跑被判**空转** ——
  我在 `time.test.ts` 里写的是 `assert.match(read(rel), /fmtConversationTime\([^()]+, t\)/)`，
  而 `FavoritePanel` 有两处调用，摘掉其中一处另一处照样命中 ⇒ 又踩了"存在性断言"这同一个坑（本仓第二次）。
  改成**按次数**判 + 分母从磁盘现算（配对括号扫实参表，要求每一处都带 `t`，分割线还要求带 `currentLocale()`），
  护栏随后 1/1 通过（改坏即 FAIL、恢复即 PASS）。
  ② 探针新增 `locale` 段：真 Chrome 里挂一条"昨天正午"的消息行，读 `[data-time-divider]` 的**文本**，
  切 `en-US` 再读，再挂一条三天前的判星期名，最后切回中文 ⇒ **7/7**。
  这一段是"真实界面验证"，不是探针自嗨：它同时是那三个家族（时间、错误文案、通知）后续批次的验收出口。
- **读数**：`npm test` **1053/1053、exit 0**（本轮净 +5 条：时间 5 条新用例、`chatStyle.test.ts` 那条搬过来）；
  `npm run verify` 快速层 **17/17、19.4s、exit 0**；
  `npm run test:ui-runtime -- --only=locale` **7/7、exit 0**；`--only=search` **18/18、exit 0**；
  `verify-guards.py --only 时间列把文案注入丢掉` **1/1、exit 0**，护栏总数 **233→234**（地图那个现算数同批改掉）。
- **没做的**：English 界面下的真实 WKWebView 截图归用户肉眼判（这条改的是文案，探针能证明形状，
  证明不了"英语用户读着顺不顺"）；Windows/Android/iOS **NOT RUN**。

### 6.32 预览失败的「原因」与「文案」拆开（P1 第 2 批 · 2026-10-19）

- **发现形状**（不是风格问题，是静默失效）：`filePreview.ts` 与 `favoritePreview.ts` 都拿
  `r.note === "文件过大，无法预览"` 判「这条失败能不能进缓存」。`note` 是**上屏的那句话** ⇒
  这句一旦接进 i18n（换语言、改标点、改错字都算），两处缓存判据同时静默变假，
  表现为"超大文件的失败被永久缓存 / 该缓存的确定性失败不再缓存"，而单测与构建都看不出来。
- **改法**：`utils/mediaAvailability.ts` 里加机器可读的 `PreviewFailure = "gone" | "tooLarge"`
  与 `PREVIEW_FAILURE_KEYS`（原因→词典键，`gone` 复用已有 `msg.cleaned`，新增 `media.tooLarge`）；
  两个预览模块的缓存判据改成读 `r.failure`；三处上屏点（`useMessageFile.ts`、
  `ImageLightbox.vue`、以及原写死文案的两条分支）改成 `t(PREVIEW_FAILURE_KEYS[r.failure])`。
  `previewFailureResult` / `loadFilePreview` 内部识别后端串时仍读串，但**只读一次、只产原因**，
  不再把串往下传。
- **护栏侧的账（这轮第二次踩同一个坑，记下来）**：改了源码就改坏了注入锚点 ——
  `file_transfer.py` 那条「图片预览：在途失败不能永久缓存」的锚点写的正是被删掉的那句字符串，
  快速层第 10 步（起跑前核对）当场把它拦下，一条测试都没跑就红了。锚点跟着换成
  `if (r.failure) cache.put(msgId, r);` 后 `verify-guards.py --only 在途失败不能永久缓存`
  **1/1、exit 0**（改坏即 FAIL、恢复即 PASS，红由声明的那句"确定性失败"报出）。
- **读数**：`npm test` **1054/1054、exit 0**（净 +1：新增"原因只给机器读：文案由词典出，
  缓存判据不许再比字符串"，它同时钉两个预览文件的 `if (r.failure) cache.put(`、
  两个词典里 `media.tooLarge` 的存在，以及 `mediaAvailability` 里不许再出现 `.note`）；
  `npm run verify` 快速层 **17/17、exit 0**；
  `check-ui-runtime.mjs --only=lightbox,imgload,files,locale` **30/30、exit 0**；
  `frontend-inventory.mjs --check` **exit 0**（清单段现读：生产 204 份 / 42693 行，测试 95 份 / 17752 行）。
- **仍欠后端一条**（写在这儿防遗忘）：`utils/errors.ts` 的 `friendlyError` 与
  `previewFailureResult` 都靠**匹配中文错误串**分类，英文界面要说全，正解是后端给结构化错误码。
  那属于协议/接口面，不在本专项的安全边界内 ⇒ 记为暂缓项，不在本轮动。

### 6.33 通知正文与日志标题接进 vue-i18n（P1 第 2 批续 · 2026-10-19）

- **动的两处**：① `utils/notifications.ts` 的 `notificationBody` 原来直接返回
  「你收到一条新消息」/「你收到 N 条新消息」/「张三 等 N 条新消息」三句写死的中文；
  现在改成 `notificationBody(input, tr)`，文案走 `notify.one` / `notify.count` / `notify.senderCount`，
  调用点 `useChatStore.ts` 把它作用域里已经在用的 `t` 注入进去。这条约束是硬的：`utils/*` 被
  `node --test` 直接 import，裸 Node 解析不了 `@/` 别名 ⇒ 只能由调用侧注入文案（先例是 `time.ts`）。
  ② `components/LogViewer.vue` 的四句 `:title` —— 它们本来就是**同一句话在桌面/移动两个分支各抄一遍**
  （合并相同日志 / 展开相同日志 / 已合并 N 条相同日志），现在各归一个键，重复表达随文案一起消失。
- **记一条我自己犯的错（这就是"重写整份测试文件"的代价）**：第一版我把 `notifications.test.ts`
  整册重写，只留下 `notificationBody` 的 6 条 —— 另外 **5 条 `mergeNoticesInto`
  （权限查询失败时把已取出的通知放回队列）的用例被我一起删了**。`npm test` 从 1054 掉到 **1050**
  才暴露这件事：条数会报"少了"，但它不会告诉我少的是**与本轮无关的那一组**。
  从 `git show HEAD:` 把那 5 条原样并回后 **1055/1055**。
  ⇒ 规矩写死在这儿：**改一个函数的测试时不许整册重写，只做局部替换**；
  真要整册重写，先把原有用例逐条对上号再动笔。
- **为什么这处值得加一条护栏**：关掉「显示正文」后那两条文案**不含任何参数**，
  这是隐私不变量的机器表达；把开关那一格改成恒真 = 锁屏直接泄出对端正文，
  而其余判据全都不会红。新用例「通知的隐私开关失效」两次单点变异跑通
  ⇒ 护栏总数 **234→235**（地图那个数同批改，判据 E 现算对账）。
  接线那一半**没有**加护栏，理由是它属于响亮失败：`notificationBody` 少一个 `tr` 实参
  是 vue-tsc 编译不过的 —— 响亮失败不需要再买一条静默守卫。
- **读数**：`npm test` **1055/1055、exit 0**；`npm run verify` 快速层 **17/17、exit 0**；
  `check-ui-runtime.mjs --only=logs` **5/5、exit 0**（日志窗与移动端日志页照常渲染，标题换成键没打断探针）；
  `verify-guards.py --only 通知的隐私开关失效` **1/1、exit 0**；
  `frontend-inventory.mjs --check`、`check-doc-numbers.mjs`、`check-doc-citations.mjs` 全 **exit 0**。
- **仍欠**：英文界面下真实通知中心的措顺不顺归用户肉眼；Windows/Android/iOS 的系统通知 **NOT RUN**
  —— 那条路径要真机发一条通知才看得见。

### 6.34 四处手抄的「在途去重」合成一个 helper（P1 第 3 批 · 2026-10-19）

- **盘点出来的形状**：`new Map<string, Promise<…>>` 这套"同键只跑一次"在**公共层写了四遍** ——
  `filePreview.ts` 的 `loadFilePreview` / `loadContentPreview` / `loadThumbPreview`、
  `favoritePreview.ts` 的 `loadFavoritePreview`。前三处里 `loadThumbPreview` 又是**另一种写法**：
  它靠 `void p.finally(() => thumbInflight.delete(key))` 摘除，而另外三处靠 `finally` 块。
  两种写法不一样，是因为 `p.finally` 挂在**已 settle 的 Promise** 上：若期间同键被重新登记过，
  这个回调会把**别人的**在途记录一起删掉（`finally` 块那种写法是在 settle **之前**摘除，没这个问题）。
  ⇒ 这不是风格问题，是一处真实的错位摘除。
- **改法**：新增 `src/utils/singleFlight.ts`（36 行，含注释；对外只有 `run/remove/reset`），
  四个入口都改成 `inflight.run(key, async () => …)`，`remove/reset` 接在原 `delete/clear` 那几格。
  语义与原来那份 `try/finally` **逐字对齐**（没有顺手加"同步抛错"那种新分支）⇒ 摘除时机不变，
  而缩略图那一处的错位摘除被顺带修正（它现在与其他三处同一条实现）。
  按 §四 的口径归入**组合替换**：去重机制交给一个共用实现，预览的业务规则（缓存哪一层、
  字节封顶、失败能不能缓存）仍在各自模块里。
- **没有换成 TanStack Query，是有理由的**（记录判据，免得下一轮又被"为什么不复用现成库"问回来）：
  这三份缓存的核心是**按字节封顶 + 淘汰时 revoke objectURL**（`createBlobLru` 的 `weigh/revoke`），
  Query 没有"条目权重上界 + 驱逐回调"这一层；而它一旦被替换，被钉住的那条真实缺陷
  （`2026-09-21` 那种"只从 Map 抹掉、不 revoke ⇒ 字节永不释放"的确定性泄漏）就失去了实现层护栏。
  归入 **保留自研**。
- **判据侧**：新增 5 条用例（同键并发只发一次 / 跑完能重跑 / 抛错也摘除 / remove 与 reset 的边界 /
  公共层不许再出现第二份 + 四个入口按**次数**接线）。分母从磁盘现算，
  且只量**公共层这一维**：`useChatStore.ts` 里还剩两处同形状的表（`groupTodoRowsInflight`、
  `loadingMore`），它们是"重入保护"而不是"取回值"，是否等价要先证 ⇒ **登记成下一批**，
  不在判据里用一份手抄文件名清单糊过去。护栏新增一条「单飞跑完不摘除在途记录」⇒ **235→236**，
  两次单点变异（改坏 FAIL / 恢复 PASS）跑通。
- **两个本轮自己撞上的坑（都值得记）**：
  ① `npm test` 的脚本是**一份显式文件清单**，不是 glob ⇒ 新测试文件不登记就**一条都不跑**，
  而条数只从 1055 变到 1055（我最初就是靠这个"没涨"才发现的）。⇒ 加测试文件必须同批改 `package.json`。
  ② 代码行一变，`docs/protocol-invariants.md` 里钉的三处 `filePreview.ts:148/196/242`
  立刻越界/漂移 ⇒ 由「文档 file:line 引用对账」拦下（快速层第 7 步），按 `grep -n` 现算重钉成
  **142/180/219**。这是本仓第 N 次证明"行号引用是会被一次普通重构打断的"，而它确实有机器判据。
- **读数**：`npm test` **1060/1060、exit 0**；`npm run verify` 快速层 **17/17、exit 0**；
  `check-ui-runtime.mjs --only=imgload,files,lightbox` **23/23、exit 0**（气泡缩略图、原图、
  收藏预览与点大图那条链都照常走）；`verify-guards.py --only 单飞跑完不摘除` **1/1、exit 0**。
- **没跑的**：`filePreview` 的在途去重只在**真 Chrome** 的 imgload/files 段间接验过（同键并发两次的
  IPC 计数没有真机读数）；WKWebView 上的缩略图摘除修正 **NOT RUN**。

### 6.35 复制反馈并回一个家（P2 第 4 批 · 2026-10-19）

- **盘点纠偏**：这一处一度被记成"两份剪贴板实现"，实际查下来是**三个名字、两种职责** ——
  `utils/clipboard.ts` 管的是**粘贴意图分类**（图片/文件/文本三条分支，纯函数、有单测、
  钉着 WKWebView 与 Win11 截图的两条真实兼容坑），它和"复制"不是一件事 ⇒ **不动**；
  真正重复的是 `composables/useClipboard.ts`（VueUse 写入 + 已复制态 + 自动复位）与
  `LogViewer.vue` 里自己抄的那一份（同样三件事，直连 VueUse、自己 `setTimeout`）。
- **两份的差异不会报错，只会表现成行为不一致**：组合式默认 1500ms 且**卸载后那条裸 setTimeout
  还会回写 ref**；LogViewer 那份是 2000ms 且自己清了 timer。⇒ 合并时把两侧都对齐成
  "以后一次为准 + `onScopeDispose` 摘表"，LogViewer 传 `useClipboard(2000)` 保住它原有的时长。
  业务侧的 `copied` 模板读法没动（改成一个按 key 的 `computed`），所以渲染层零差异。
- **判据**：`componentImports.test.ts` 新增一条接线判据（分母 = 现扫全部 `.vue`，
  不抄文件清单），另加一条护栏「复制反馈又长出第二份实现」⇒ 护栏 **236→237**，
  单点变异两次跑通（改坏 FAIL / 恢复 PASS）。这条钉的是**接线**而不是文案：
  将来谁把 VueUse 再接回组件里就红。
- **读数**：`npm test` **1061/1061、exit 0**；`npm run verify` 快速层 **17/17、exit 0**；
  `check-ui-runtime.mjs --only=logs` **5/5、exit 0**；`verify-guards.py --only 复制反馈又长出第二份` **1/1、exit 0**；
  `check-doc-numbers` 现算护栏 237 条与地图对上。
- **没验的**：复制成功/失败在**真机**上的观感（VueUse 的 `legacy` 回退只在非 secure context 才走，
  本机探针进不到那条道）；Windows/Android/iOS 的剪贴板权限形态 **NOT RUN**。
- **本批我自己撞的两处（都不是判据的错，记下来防重犯）**：
  ① `let timer = 0` + 裸 `setTimeout(...)` 在**本仓的 tsconfig** 里被判
  `TS2322: Type 'Timeout' is not assignable to type 'number'` —— 本仓约定写 `window.setTimeout`
  （LogViewer 原来那份就是对的）。快速层第 17 步（vue-tsc）拦下的，没进 cargo 就红。
  ② 我改清单时把**机器生成的那一行**（§1 里 `src/composables/useClipboard.ts` 那条索引）
  当成判定行改了 —— 生成器一跑就把它覆盖回来，而 `--check` 会当场报红。
  ⇒ 教训写死：**改 `frontend-inventory.md` 只许动 §2/§4 的判定行**，§1 由
  `node scripts/frontend-inventory.mjs` 生成；改完必跑 `--check`。

### 6.36 校验层的 message 改成词典键，长度规则收成一处（P1 第 2 批 c · 2026-10-19）

- **原来是什么形状**：`utils/validation.ts` 的 `trimmedNonEmpty(max, label)` 把
  「群名称不能为空 / 群名称最长 40 个字符」写进 zod 的 message。两个后果：
  ① schema 是**模块级常量**，import 那一刻就定死语言，英文界面里这两句仍是中文
     （和 dayjs 全局 locale 同一个坑）；
  ② 更要紧的是**这两句根本没人显示** —— 两处调用点自己写了 `t("…nameEmpty")`，
     于是中文 message 成了"长得像 UI 文案的死代码"。
- **一处我当时说重了的账（现在更正）**：下面这条原本写成"顺出来一个**用户看得见**的缺陷：超长也被报成「请输入群名称」"。
  读完两处入口的可达性，这句话站不住：
  ① `GroupCreateModal` 的提交按钮是 `:disabled="selected.length === 0 || !name.trim() || creating"`，
     名字为空时按钮就灰着 ⇒ `nameEmpty` 那条 toast 点不到；该文件也没有 `<form>`/Enter 通道
     （`grep -n 'keydown\|<form\|type="submit"' src/components/GroupCreateModal.vue` 现算 0 命中）。
  ② 两格输入框都带 `maxlength=40`，而 `maxlength` 数的是 UTF-16 单元、schema 数的是码点
     ⇒ 能进 schema 的长度永远 ≤40，`tooLong` 那一支**在 UI 里走不到**。
  ⇒ 正确说法：**改动本身仍然对**（键化、常量同源、按实际违反的那条报错），但它修的是
  "这一支将来一旦可达就会说错原因"的**潜在**缺陷，不是当下看得见的错；两条 `tooLong` 属**防御分支**
  （留着：`maxlength` 一旦去掉、或有别的调用方喂长串，它们立刻就是正确行为）。
  对照之下 `ProfileSection` 的昵称格**有**可达路径 —— 它挂着 `@keydown="onNicknameKeydown"`（回车即存），
  所以"空昵称"那条 toast 真的会响。两格表单的可达性不是一件事，不许一起宣布。
  **真·用户可见的那条缺口是另一回事**：`maxlength` 静默截断 —— 粘贴 60 字只剩 40 字、无半句说明，
  已登记成队列 4b 的真实目标（比这两条防御文案值得做多）。
- **改法**：message 位置放**词典键**（复用既有的 `group.toast.nameEmpty` /
  `settings.profile.toast.nicknameEmpty`，新增 `…TooLong` 两条），渲染处
  `t(issue.message, { max: MAX_*_CHARS })`；两处 `maxlength="40"` 改成绑常量。
  ⇒ 「输入框上限 / 前端判长 / 提示里的数字」从三份变成同一个常量 —— 这正是该模块
  文件注释自己声明的目标，之前没做到。归 **组合替换**：判据层继续用 Zod，语言交给 vue-i18n。
- **判据**：3 条用例（message 不许含中文且必须是键的形状 / 引用的键两种语言都要在 /
  两个入口必须绑常量且不许再写死数字）+ 1 条护栏「校验层又把中文写回 message」
  （单点变异跑通）⇒ 护栏 **237→238**。
- **又撞自己一条规矩**：追加用例时直接写了 `read(...)`，而那是**别的那条用例闭包里的局部 helper**
  ⇒ `ReferenceError: read is not defined`。⇒ 往既有测试文件追加时，先确认 helper 在**模块作用域**，
  别照抄邻居用例里的名字（这次是第二次踩"抄邻居"这一类）。
- **读数**：`npm test` **1064/1064、exit 0**；`npm run verify` 快速层 **17/17、exit 0**；
  探针 `settingsmobile,toast,inputpanel` **33/33、exit 0**；
  `verify-guards.py --only 校验层又把中文写回` **1/1、exit 0**；
  `frontend-inventory.mjs --check`、两个文档对账 **exit 0**。
- **⚠️ 覆盖缺口如实写**：`GroupCreateModal.vue` 与 `ProfileSection.vue` **不在任何探针段的挂载清单里**
  （段名按现扫数出来：`grep -o 'want("[a-z]*")' scripts/check-ui-runtime.mjs | sort -u | wc -l` = **34 段**，没有 groupcreate / profile 那两格）
  ⇒ 这一批的运行时证据只到相邻段，"超长那次真报对原因"目前只有单测 + 类型检查撑着。
  要闭合就得给探针补一格挂 `GroupCreateModal` —— 已登记成下一批的一项，不在这里假称验过。

### 6.37 「暗色有两个解析家」这条账复核完：不是缺判据，是判据在、地图错了（P0 复核 · 2026-10-19）

- **盘点队列里这条原本是"待审：主题解析有两个家，可能是重复状态源"。读过代码后的结论不同**：
  规则只有一个家 `utils/appearance.ts`（`isAppearanceMode` / `resolveDark` / `readStoredAppearance`，
  纯函数、有单测，`useAppStore` 只是消费者）；第二份是 `src/boot/theme-boot.js`，它由 vite 的
  `gosslan:inline-boot` 插件内联成**裸脚本**、必须早于 bundle 执行（否则首帧闪白），
  结构上就 import 不到那个模块 ⇒ **复制是平台约束**。
  而且两边等价**早就有机器判据**：`appearance.test.ts` 用替身 `localStorage / document / matchMedia`
  把那段脚本真跑一遍，逐例与纯函数对照。⇒ 归类 **保留自研**，不改代码结构。
- **真正的问题是地图错了，而且错了三处**（这类问题不会让任何东西变红，只会让下一个来人走空）：
  ① `theme-boot.js:14` 写「必须与 useAppStore 的 `readLocalAppearance()` + dark computed 完全一致」——
  `grep -rn readLocalAppearance src` 实得**只有这一行注释本身**，那个符号不存在；真值是
  `utils/appearance.ts` 的 `readStoredAppearance()` + `resolveDark()`。
  ② `utils/appearance.ts` 头注释说第二份在 `index.html` 里 —— 脚本早已搬进 `src/boot/theme-boot.js`
  （同文件测试里第 78 行自己都承认这件事，两处注释互相矛盾）。
  ③ 测试文件顶部注释把「本模块」写成 `useAppStore`。
  三处都按现状改准，并在注释里写清"复制是平台约束 + 等价由谁管"。
- **补的那条判据才是这一批的重点**：`test("两份实现互相指认的符号必须真实存在…")`
  —— 把三处交叉引用里点名的符号（`readStoredAppearance` / `resolveDark` / `isAppearanceMode` /
  `APPEARANCE_STORAGE_KEY` / `LEGACY_DARK_STORAGE_KEY` / `readLocalAppearance`）与
  `appearance.ts` 的**实际导出集合**对账：指到不存在的名字就红。
  这条不只修好这一次——它把"注释里那个函数叫什么"变成机器事实，将来改名/搬家会当场逮住。
- **又一次踩到自己记过的坑**：追加用例时我写了 `bootScript()`，而模块级真名是 `readBootScript()`
  ⇒ 一条红。这是本会话内**同一类错的第二次**（上一次是抄邻居闭包里的 `read()`）。
  ⇒ 结论：往既有测试文件加东西前，必须先 `grep` 出模块级 helper 的真名，而不是凭印象写。
- **读数**：`node --test src/utils/appearance.test.ts` **11/11**；`npm test` **1065/1065、exit 0**；
  `npm run verify` 快速层 **17/17、exit 0**（含 vue-tsc + 构建；`theme-boot.js` 是被插件读进去的，
  构建通过说明新注释没有破坏那段裸脚本的可执行性）。
- **没验的**：真实 WebView 的"首帧不闪白"仍只有既有真机读数撑着 —— 这条改动没有触碰判定逻辑本身，
  只动了注释与判据；Windows/Android/iOS **NOT RUN**。

### 6.38 store 里最后两格在途表：一格并入 helper、一格判成"不许并"（P1 第 3b 批 · 2026-10-19）

- **这批的对象是 §6.34 留下的尾巴**：`useChatStore` 还有两处 `new Map<string, Promise<...>>()` 与
  `utils/singleFlight` 同形。逐格读过代码后结论**不一样**，所以两格分别归档：
- **A `ensureGroupTodoRows`（群任务补读）= 直接替换（并入 helper）**。它的体就是 helper 的体：
  查在飞 → 有就返回那一份 → 没有就跑 → `finally` 里摘除 → 返回同一份 Promise；
  调用方三处（看板 / 任务弹窗 / 成员面板）全是 `void ensureGroupTodoRows(...)` ⇒ 取不回值也无妨。
  现在写的是 `groupTodoRowsInflight.run(convId, async () => { ... })`，取数语义（StaleGuard 键
  `todoRows:${convId}`、失败写 `groupTodoRowsErrors` 而不向上抛）原样留在体内 ⇒ 通用逻辑一个家、
  业务规则还在业务侧。净删的是自己维护的 `get/set/finally/delete` 四行。
- **B `loadingMore`（向上翻历史页）= 保留自研，且是"强并会拿实测行为换行数"的那种**。两处偏离都写在注释里：
  ① 容量闸门 `pages >= MAX_PAGES` 夹在**"并入在飞"与"登记"之间** —— 走 helper 就得挪进 `make` 体内，
  于是满 10 页的会话每次触顶都会先登记一个瞬间存在的条目再摘掉，白多一次 `set/delete`；
  ② 摘除写成 `return page.finally(() => loadingMore.delete(convId))`，处理器**挂在链上**而不是在体内 ——
  目的是让 `page` 始终带着处理器，reject 不会变成 unhandled rejection，而**所有** await 方各自拿到同一次结果。
  ②不是风格：`locateMessage` / `locateMessageInConv` 的循环写的是 `await loadMoreMessages()` 后"长度没变 ⇒
  没有更早历史"，把"正在翻"弹回成"直接返回"会让点引用/搜索命中时**误报**「原消息在更早的历史里」并拒绝定位
  （2026-09-23 评审抓出的真回归）。这两条都没有判据兜着 ⇒ 按目标里"有充分证据证明现有行为更合适的才保留自研"，
  这一格保留，并把理由钉在 `useChatStore.ts:1286` 的注释块里。
- **顺手核掉一个自己引入的假风险**：并入后 `loadFilePreview(msgId)` 与 `loadContentPreview(cid)` 共用
  `inflight` 那一份，键空间不同源（消息 id 有 `file-`/`tmp-`/`file-failed-` 前缀或 DB 数字串，cid 是 64 位 sha256 hex）
  ⇒ 撞键不可达，**不加前缀**（加了就是为不会发生的场景写防御，还会牵动 `invalidate` 那几条路径）。
- **读数**（全部现算，退出码未过管道）：`npm test` **1065/1065、exit 0**；`npm run verify` 快速层
  **17/17、exit 0（17.6s，含 vue-tsc + 构建）**。接线量 `grep -rn createSingleFlight src`（排除测试与本体）
  = **4 个实例**（`filePreview` 2 + `favoritePreview` 1 + `useChatStore` 1）、`\.run(` 取数口 = **5 处**；
  残留手写同形状 `grep -rn "new Map<string, Promise" src` = **4 行命中**，其中生产码只剩 `useChatStore.ts:1294`
  那**一格**（另三行分别是 helper 自己那一格与 `singleFlight.test.ts` 的分母判据/白名单两处文本）。
  分母判据在 `singleFlight.test.ts`：扫 `src/utils/**` 命中即红，并按名字钉住 B 格"仍然手写着"——
  这条是反向的：**将来谁把它并进 helper 而没先补上那两条行为的判据，测试会红**。
- **这一批我自己踩的两次**（都属于"改完以为完了"）：① 批量补丁里 `createSingleFlight` 的 import 锚点
  我按**另一个文件**的 import 行写（`useChatStore` 里根本没有 `createBlobLru` 那一行）⇒ 报"期望 1 实得 0"，
  引用有了、import 没有 —— 这是本会话第 N 次证明"锚点必须来自目标文件自身的 `grep`"；
  ② Python 侧按 `.count()` 做子串替换把 `ensureGroupTodoRows` 的 `catch` 块留下了未闭合的括号，
  靠通读迁移段才发现 ⇒ 结论不变：**改完必须把改动段整段读一遍**，只看补丁回执不算。
- **没验的**：三入口同时补读只打一次 IPC 这条**逻辑**由 helper 的 5 条用例保证，但"看板 / 任务弹窗 /
  成员面板真的会同时要求补读"这个场景需要运行中的实例 + 群任务数据，本批**没有跑** CDP 探针
  （store 逻辑不在探针的挂载能力内）；Windows/Android/iOS **NOT RUN**。

### 6.39 一个长度规则原本有三个落点：10 处手抄 `maxlength` 与后端 const 现读对账（P1 第 3c 批 · 2026-10-19）

- **起点比队列里原来的格子大得多**。4b 那条只写了"群名/昵称两格的 `maxlength` 静默截断"；
  我先按「数分母而不是猜范围」把整条口径扫了一遍：`grep -rn "maxlength" src --include="*.vue"`
  实得 **14 处**，其中 **10 处是裸数字**（`"100"×3`、`"50"×2`、`"200"×2`、`"40"`、`"500"`、`"4000"`）。
  也就是说"输入框 maxlength / 后端 `chars().count()` / 有的还有一份 schema"这个**三份规则**的形状，
  本仓在 8 个组件里各写过一遍。既有那条判据（`validation.test.ts:137`）只盯群名与昵称两格，
  其余八格从来不在任何判据眼里。
- **数值这次是全对上的**（现读两边：40/40/100/500/200/4000/32/20 与 Rust 侧逐个相等）⇒
  **没有已发作的 bug，不许把它写成 bug**。真正的缺陷是**没有任何机器判据**，而且后端的写法更静：
  `commands/chat_search.rs:59` 与 `network/transport/group_membership.rs:10` 拿到超长串走的是
  `chars().take(N)` —— **截掉、不报错**。所以哪一天两边数值漂了，表现是"用户以为自己存进去的是
  自己打的那串"，界面与日志都不红。这类"沉默失真"正是本专项 P1 那一档。
- **做法**（按 §七.4：不新增一层包装、只把通用口径收进已有的家）：
  ① 数值不动，把 10 处裸数字改成具名常量绑定。落点跟着**领域**走，不新建"集中常量表"模块：
  `validation.ts`（群名/昵称/公告 500/搜索词 100/列表过滤 50）、`todos.ts`（标题 200/描述 4000）、
  `logFilter.ts`（日志过滤 200）、`externalLinks.ts`(32) 与已有的 `TODO_CUSTOM_CATEGORY_MAX_LEN`(20) 同侧；
  ② 新增 `src/utils/textLimits.test.ts` 三条：TS 常量与 Rust `const …: usize` **现读两边对账**
  （读不到那个 const 就抛 —— 名字搬家要响亮）、**扫全部 `.vue` 禁止 `maxlength="数字"`（白名单为空）**、
  并钉住"绑上的名字必须在这张对账表里"（防止改绑到组件内的私有魔法数）；
  ③ 只有本地过滤框（日志 200 / 列表 50）允许没有后端主人，测试里显式写明这件事。
- **不空转证明**（每个形状两次单点变异）：把 `MAX_SEARCH_LEN` 改成 101 ⇒ 对账那格当场红；
  把 `FavoritePanel` 的绑定改回 `maxlength="50"` ⇒ 分母那格当场红；两处都已复原（复原后再跑 = 绿）。
- **真实界面这一层补上了**：`check-ui-runtime.mjs` 的 favorites 段新增一格，直接读 DOM 的
  `getAttribute("maxlength") === "50"` 与 `input.maxLength === 50`。为什么要读 DOM：
  绑到**不存在的名字**时 Vue 不会报错，只会安静地不写这个属性 ⇒ 上限消失而界面一模一样。
  反向跑一次（把绑定名改成 typo）⇒ 该格当场红（8/9），复原后 9/9。
  同一轮 `--only=search,favorites,links,logs` 共 **36/36**（改动的四个组件都真实挂载并跑完原有交互）。
- **顺手抓到自己一个**：往模板字符串里插注释时写了反引号（`` `:maxlength="常量"` ``），
  直接把 `check-ui-runtime.mjs` 的字符串打断 ⇒ `node --check` 语法错。⇒ 规则补一条：
  **改探针脚本内那段 `cdp.eval` 字符串里的注释，禁用反引号**，且改完必须先 `node --check`。
- **读数**：`npm test` **1068/1068、exit 0**（新增 3 条）；`npm run verify` 快速层 **17/17、exit 0（17.6s）**；
  现算分母 `grep -rn 'maxlength="[0-9]' src --include="*.vue" | wc -l` = **0**（原 10）。
- **没验的**：iOS/Android 的 WKWebView 与 WebView2 上 `maxlength` 行为差异 **NOT RUN**；
  其余 6 格新绑定没各自补一格 DOM 读数（只对 favorites 一格做了正反两跑）⇒ 静态分母 + 全量构建
  覆盖到的是"名字存在于导出面"，运行时真值这一层只抽查了一格。

### 6.40 计时器按形状数完 19 处：抓到的是"包装层撒了谎"，不是"轮子造了七遍"（P1 第 3d 批 · 2026-10-19）

- **这一批的起点是队列 6**（"107 处 timer/防抖按形状分类清点，只合并输入防抖那一族"）。
  先按"数分母"重测口径：生产 `.vue` 里带 `clearTimeout` 的是 **13 本文件、19 处计时器**
  （`grep -rc clearTimeout src --include="*.vue"`）。分类结果决定这一批动哪一格 ——
  **结论与原队列不一样**，所以把表写下来，不让下一个来人重数一遍：

  | 形状 | 处数 | 落点 | 判定 |
  |---|---|---|---|
  | 输入值延迟镜像 | 1 | `ChatSearchDialog.vue:243-267` 自己写 `setTimeout`+`clearDebounce`，而 `useDeferredRef`（6 消费者）就是干这个的 | **重复，但不在本批动**（它多了"空关键词丢弃 + `props.open` 复查"两条语义，并过去要先证这两条，见下面"欠账"） |
  | 触摸长按 | 4 | `MessageItem:508` / `ConversationListItem:151` / `FriendListItem:106`（各 500ms，容差 12px vs 10px）/ `MessageReactionBar:146`（450ms，无容差，`:133` 明写"刻意不借 `utils/longPress.ts`"） | 三本列表项是近亲，但**容差不一致**；合并前要先定哪一个才是实测值 ⇒ 记欠账 |
  | 资源重试退避 | 2 | `MessageImageBubble:47` 定长表 400…3200 / `TodoImageThumb:67` 指数 1500→30000 | 两个"追后到字节"的调度不同形 ⇒ 保留自研 |
  | N ms 后复位一个临时界面旗标 | 3 | `AboutSection:43`（1500，**无卸载清理**）/ `ChatWindow:827`（1600，无清理）/ `LogViewer:197`（3000，有清理） | **`AboutSection` 那格本批处理掉**（它其实是复制反馈的第二份家，见下） |
  | 点击冷却 | 2 | `AddFriendModal:251`（Map、整体清理）/ `MessageComposer:72`（单表） | 值相同、容器不同 ⇒ 不构成缺陷，保留 |
  | 滚动/测量收敛 | 4 | `VirtualList:155/240/257/342` + `ChatWindow:437` | 同一本组件内两种机制，属实现细节 ⇒ 不动 |

- **真正值得动手的那一格不在"重复轮子"里，而在唯一家里**。读 `AboutSection` 为什么自备一份
  `copyState` + 1500ms 定时器时顺出来一条更大的：`composables/useClipboard.ts` 的
  `copyContent` 声明 `Promise<boolean>`，**实现恒 `return true`**。按"读锁定版本的原文"的规矩
  打开 `node_modules/@vueuse/core/dist/index.js`（14.4.0）看 `function copy(value)`：
  async 分支 `catch` 后转 legacy、`legacyCopy` 把 `document.execCommand("copy")` 的返回值丢掉、
  然后**无条件** `copied.value = true` —— 库里根本没有这个信号。
  ⇒ 全仓 5 个组件、7 处 `const ok = await copyContent(...)` 再 `ok ? 已复制 : 复制失败`
  （`AboutSection:40`、`MessageItem:212`、`FriendProfile:80`、`FavoritePanel:370/380/391`）
  的**失败半边是永远跑不到的分支**；真没写进剪贴板时，用户看到的是"已复制"。
- **做法（按编译器数影响面，不靠"我觉得哪几个文件"）**：把签名改成 `Promise<void>`，
  vue-tsc 会把每一处消费假分支的地方点出来 ⇒ 一次改完 7 处；`AboutSection` 顺手并回
  `copiedKey`（它的第二份就地反馈家与自备定时器一起删掉）。
  **用户可见行为零变化** —— 因为今天本来就只会显示成功；清掉的只是永不执行的那半边。
  三个 `*copyFail` / `safetyFail` 词典键**没有变成孤儿**：它们各自还有可达的消费方
  （`MessageItem:238/1014`、`FriendProfile:208`、`FavoritePanel:388/402`，都是"取不到内容/写异常"那条真路径）。
- **为什么不给"复制失败"自己实现一个信号**（写 `execCommand` 返回值判断）：那正是目标里
  §七.4 禁止的形状 —— 引入一个成熟库，再在包装层里把它给不了的东西**假装**给出来。
  诚实的做法是让签名和依赖能力对齐，把这条需求记成"要真做得换依赖或改协议"（进队列 10）。
- **读数**：`npm test` **1068/1068、exit 0**；`npm run verify` 快速层 **17/17、exit 0（17.9s）**
  （含 vue-tsc：签名一改，7 处假分支全部由类型检查点名，无残留）；
  CDP 探针 `--only=settingsmobile,favorites,composermobile` **15/15、exit 0**（这三段真实挂载了被改动的组件）。
- **没验的 / 欠账**：① 探针这三段跑的是挂载与交互，**没有一段点"复制"按钮读 toast** ⇒ "已复制"
  这条反馈本身仍只有静态与类型证据（与队列 4b 同一个障碍：单组件挂载 + ToastHud 在应用根）；
  ② 真机（Android/iOS WebView 无 `navigator.clipboard` 那条路）**NOT RUN**；
  ③ `ChatSearchDialog` 的输入防抖并回 `useDeferredRef`、长按容差不一致（12px vs 10px）这两条
  只登记未动 —— 各自需要先证语义等价，不在本批顺手做。

### 6.41 `maxlength` 的静默截断有了可见读数，且读数只有 `ui/CharCounter.vue` 一个家（P3 · 队列 4b）

- **边界**：只做"到顶要看得见"这一件事 —— 给所有**要存住**的长度上限配一枚 `n/max` 读数。
  不动协议、不动后端、不改任何一格的数值、不改任何一格的截断行为。
- **为什么排在这**：§6.39 把 10 处手抄数字绑成常量之后，剩下的缺口是**用户看不见**：
  粘 60 字进群名只剩 40 字、发一条超长公告尾巴被砍掉，界面半个字不说。四个平台里唯一都成立的反馈就是这个数。
- **影响面按现算**：`python3` 扫 `src/**/*.vue` ⇒ `:maxlength="常量"` 共 **16 格**。
  其中 7 格只当过滤/查询用（搜索词 3、列表内过滤 2、日志过滤 2）⇒ 值不回写，不需要读数；
  **9 格要存住** ⇒ 分布在 6 本组件：`GroupCreateModal`、`GroupMemberPanel`（群名 + 公告）、
  `GroupTasksBoard`（标题 + 自定义类型 + 描述）、`TodoDetailDialog`（自定义类型）、`LinksList`（链接名）、
  `settings/ProfileSection`（昵称）。
- **做了什么**：新增 `components/ui/CharCounter.vue`（纯展示件，props `text`/`max`；
  空值不渲染 ⇒ 不常驻噪声；到顶切 `--gosslan-danger-ink`）。9 格全部接上它；
  本批前面先内联写的那两处（建群名、昵称）也一并换成这一枚，**避免 9 份模板各写一遍**；
  并**删掉** `GroupTasksBoard` 里那格 `{{ draft.customCategory.length }}/{{ … }}` —— 那是**第二把尺**
  （UTF-16 单元），与 schema / 后端数码点的维度不同。
- **两把尺这件事不许糊**（实测出来的，不是推测）：`maxlength` 数 UTF-16 单元，`charCount` 与后端数码点。
  20 个 emoji 已经占满 40 格 ⇒ 只数码点会印 `20/40` 却打不进字；只数 UTF-16 会印 `40/40` 而真存下的只有 20 个字符。
  ⇒ 定死两条：**数字走码点**（= 真会被存下的长度 = schema 那把尺），
  **告警色按两把尺里先到那一把亮**（= "这一下没进去"是真的）。探针第三条钉的就是这一格。
- **为什么这不是"给库再套一层自研包装"**：VueUse / Reka 都没有长度读数这种东西
  （`useMaxLength` 不做跨语言对账、也不给读数 DOM）。被收拢的是一套模板 markup，不是依赖能力 ⇒ 方向是 §一.4 的去重。
- **判据（静态 2 条 + 真实 DOM 1 段）**：`validation.test.ts`
  「计数器那把尺与 schema 同一把」剥注释后扫 `utils/validation.ts`，只许留 1 处 `[...s].length`；
  「绑了长度上限的输入框必须给出可见读数」= 分母现扫 + **失败关闭**
  （名单只登记"只当过滤"的三个常量 ⇒ 新增任何上限默认就要求读数，想豁免必须显式登记），
  并禁止任何 `.vue` 再出现 `{{ x.length }}/{{ N }}` 这种手搓读数。
- **读数**（这一段每一项都在**最终内容**上复跑过一次）：`npm test` **1070/1070、exit 0**（新增 2 条）；
  `npm run verify` 快速层 **17/17、exit 0**（首跑 20.6s，收尾在同内容复跑 42.7s —— 同一台机器上有别的负载在抢 CPU，退码不变）；
  `node scripts/check-ui-runtime.mjs --only=namecap` **3/3、exit 0**（真实 Chromium：
  `maxlength="40"` 落成真属性且空值不显读数；程序化灌 41 个 emoji ⇒ DOM 的 UTF-16 是 82 而计数器印 `41/40`；
  灌 20 个 emoji ⇒ 印 `20/40` 且 class 含 danger）；
  `node scripts/check-ui-runtime.mjs --only=links` **6/6、exit 0** —— 新增那一格量的正是**最窄一档里的共存**：
  360 px 主栏内链接名读数与输入框同排，输入框仍 >=120 px、读数右沿不越面板（面板右沿实读 360）；
  三次单点变异各证一次非空转：摘掉 `LinksList` 那格读数 ⇒ 静态判据当场点名红；
  同一处再摘一次 ⇒ 探针 **5/6**（`text=null`、`spanLeft=null` ⇒ 证明确有这一格在排里；同一次读数里输入框独占整排 322 px）；
  把 `atCap` 的 UTF-16 半边删掉 ⇒ 探针 **2/3** 红。三处都由 `/tmp` 备份恢复并 `diff -q` 核对后复绿。
  文档三道 `check-doc-numbers` / `check-doc-citations` / `frontend-inventory --check` 均 exit 0
  （`§1` 现算：生产 204 份 / 42797 行）。
- **没验的 / 欠账**：① 9 格里只有 **2 格**拿到真实 DOM 读数（`GroupCreateModal` 的名称、`LinksList` 的链接名），
  另外 7 格是靠"共用同一件组件 + 常量对得上（判据现扫）"两条推过去的 ——
  尤其是**标签行右侧**那种摆法（`GroupMemberPanel` 两格、`GroupTasksBoard` 标题/描述、`ProfileSection` 昵称）
  在窄窗里会不会把标签挤到换行，以及 `TodoDetailDialog` 那格插在按钮左边的读数会不会挤按钮，
  **都没有逐格量过**（夹具只能挂单组件，这几本都要 store 里有群/任务数据才出得来表单）；
  ② 真机（Android / iOS / WKWebView）**NOT RUN**；
  ③ 本批只做到"两把尺都不撒谎"，没把上限统一成一把尺 —— 真统一要摘掉 `maxlength` 自己按码点截，
  那会牵动 IME 组合输入，风险与收益不对等，不做。

### 6.42 错误提示的**文案**全部搬进 i18n 词典：分类器一条文案都不带，英文界面不再漏中文（P3 · 队列 2 的 `errors.ts`）

- **边界**：只搬"前端自己写的那半句话"。协议串、后端返回的中文说明、落库/上线的形状一个字没动
  （见下面"为什么 `messages.ts` 那半边判成暂缓"）。
- **为什么排在这**：`utils/errors.ts` 是错误文案唯一的出口族 —— **95 处** `app.toastError` 生产调用点（25 本文件）
  与 **10 处**"写进内联状态、不是 toast"的读数全从它出去。可它把三条**中文句子**写死在 `RULES` 里，
  另有四条中文串是 `avatarImage` / `imageBytes` 直接 `throw new Error("…")`
  ⇒ 英文界面上这些位置必说中文。这是"重复的自有文案"里最集中的一格，也是一次改动能覆盖最多调用点的一格。
- **影响面按现算**：`grep -rn 'toastError(' src`（剥掉定义、导出与测试）⇒ **95 处 / 25 本**；
  直接吃 `errorText` 的那 10 处是 `LogViewer`、`FavoritePanel`、`LinksList`、`GroupTasksBoard`、
  `GroupTodosWindow`、`GroupFilesPanel`、`GroupMemberPanel`、`DevDiagPanel`、`search/ChatSearchDialog`、`ShareDirectory`
  —— 它们的错误不弹 toast，而是落进 `loadError` 一类内联状态交给 `StateBlock` 显示，
  所以**没有**并进 `toastError`（并了就是把 toast 的副作用塞进渲染路径）。两条出口共用同一支拼装函数。
- **做了什么**（三格各一个职责，没有再加一层）：
  ① `utils/errors.ts` 改成**纯分类器**：`classifyError` 只回 `{kind:"copy"; key; params}` /
  `{kind:"human"; detail}` / `{kind:"retry"}`，`RULES` 里三条句子换成三个键名；
  新增 `MessageKeyError`（抛出物带键 + 参数，给 utils 层用）与 `isTechnicalError`；
  **删掉** `friendlyError` 与 `reportError` —— 旧名一个不剩（`grep -rn 'friendlyError\|reportError' src` 只剩一条注释，本批已改）。
  ② `composables/useErrorText.ts`（新，29 行）= 唯一的拼装处，也是这一族里**唯一**为错误去 import `@/i18n` 的格子；
  `useAppStore.ts:233` 的 `toastError` 改成 `toast(errorText(e, prefix, { log: true }), "error")`
  ⇒ 95 处调用点同一次拿到词典文案。
  ③ 中英词典各加 **9 个** `errors.*` 键（`joined` / `retry` / 三条 rule / 头像两条 / 图片两条）；
  `avatarImage.ts:57,77`、`imageBytes.ts:67,112` 的 `throw new Error("中文")` 改成 `throw new MessageKeyError("errors.…")`。
- **为什么这不是"给 vue-i18n 再套一层自研包装"**：vue-i18n 给的是插值，**不给**"这条错误该用哪句话"的判断；
  而 `src/utils/*.test.ts` 要能被 `node --test` 直接 import ⇒ 分类器不能 value-import `@/i18n`。
  于是分成"分类（纯函数）/ 文案（词典）/ 拼装（一格）"，两个旧公开函数删除，没留任何平行实现。方向是 §一.4 的去重。
- **`messages.ts` / `mergeCard.ts` 那半边判成暂缓**（§七.8，实测出来的不是猜的）：
  会话预览的标签（`previewBody` 那 **12 档** `[文件]`/`[图片]`/… + `mergeCard` 的 **2 档** `[聊天记录]`）
  不是自由文案 —— Rust 侧有同名的另一份实现（`protocol.rs:859 preview_text`），
  它算出的预览会进会话行与通知（调用点 `commands/chat.rs:178`、`db/message_delete.rs:90`、
  `db/group_history.rs:408`、`transport/member_notices.rs:212`），`mergeCard.ts:58-60` 也把这个约定写死在注释里。
  ⇒ 搬进词典 = 改**存储里已经写进去的那串字** + 让两侧不再同形（老行中文、新行英文 ⇒ 同一列表两种语言）。
  这一格不是漏做：会话列表里几个标签的翻译不值一次存储迁移。
  ⚠️ 顺手量到一处**文档比判据能说**：`messages.test.ts:116` 写"两侧同一文案，由 `messageKinds.test.ts` 与 Rust 比对字面量"，
  实际那条只钉住**未知 kind 那一档**（`messageKinds.test.ts:92-95` ↔ `UNSUPPORTED_PREVIEW_LABEL`），
  其余 14 档标签没有任何跨语言判据 ⇒ 登记，不改（那本文件不在本批边界内）。
- **判据**：`errors.test.ts` 重写为 10 条，含新增一条文件扫描 —— 生产码里 `throw` 出去的 `errors.*` 键
  必须同时在中英词典里，且 `all.length >= 7` 防"扫了个空"；`avatarImage.test.ts` 三处断言改成钉**键名**而不是钉中文句子
  （§七.5：换的是断言目标，不是删断言）；探针新增 `errtext` 段 4 条，夹具另加 `H.stubApiFail`
  —— 原 `stubApi` 只能给成功值，抛不出去就根本量不到这一族。
- **读数**（都在**最终内容**上复跑，含文档收尾后那一次）：`npm test` **1072/1072、exit 0**（本批 +2）；
  `npm run verify` 快速层 **17/17、exit 0**（收尾复跑 32.3s；改文档前先跑的那一次是 55.1s —— 同一台机器上有别的负载在抢 CPU，退码一致）；
  `node scripts/check-ui-runtime.mjs --only=errtext` **4/4、exit 0** —— 真实 Chromium 里让 `getLogs` 抛
  `open /tmp/gosslan-probe.log failed: No such file or directory (os error 2)`，读 `[role=alert]` 那两行的文本：
  英文档印的是 `errors.joined` 拼出的整句、错误块整块无 CJK、无 `os error`、无裸 key；中文档同一条拼成中文那句；
  两档正文互不等。期望值**从词典模块现读**（不在判据里手抄句子）⇒ 改文案不必同批改探针。
  两次单点变异各证一次非空转，均由 `/tmp` 备份恢复并 `diff -q` 核对后复绿：
  ① 把 `useErrorText` 的 copy 分支改成直接印 `rawErrorMessage(e)` ⇒ 探针 **0/4** 而 `npm test` 仍 **exit 0**
  —— 这条正是本批立论的直接证据：**改回"把原始串甩给用户"那个形状，单测一条都不红，坏的只有屏幕上的字**；
  ② 删掉 `applyPreference` 里那句 `syncI18nLocale()` ⇒ 探针 **0/4**，读数印出**语言对调**
  （`currentLocale()` 报 en-US，屏上却是「日志读取失败：系统或网络暂时不可用…」，zh 档反过来是英文）。
  `t()` 的模板取 `locale.value`、插值走 `i18n.global.t`，两者只靠那一次同步调用对齐 ⇒ 判据钉的是**内容**不是那面旗。
  收尾在最终内容上复跑**全量探针**：`node scripts/check-ui-runtime.mjs` **412/412、exit 0**（36 段，`errtext` 为新增那 4 条）。
- **没验的 / 欠账**：① 真机（Android / iOS / WKWebView）**NOT RUN**；
  ② 10 处内联读数只有 `LogViewer` 拿到真实 DOM 证据，其余 9 处靠"同一件 `StateBlock` + 同一支拼装函数"推过去；
  ③ 95 处 toast 调用点**一处都没在真界面上弹过**（本批动的是它下游的文案来源，toast 自己另有判据）；
  ④ 工作树里另一处矛盾登记待判：`i18n/index.ts` 那段在飞注释说 `syncI18nLocale` 同时喂 dayjs，
  而 `src/utils/time.ts:16` 的契约写明**不许**靠 dayjs 全局 locale —— 那是别的会话正在改的行，本批按 §七.9 没碰。

### 6.43 挂载期的 DOM 监听有了"必须有解绑路径"这条形状判据；根组件那四条摘不掉的交给 VueUse（P0/P1 · 队列 新增「事件订阅与监听器清理」）

- **边界**：只管"注册 ↔ 解绑"这一件事。不动任何一条监听的业务语义、不动事件名、不动处理器里做什么。
- **分母按现算**：`grep -rn 'addEventListener(' src --include='*.vue'` ⇒ **19 处 / 12 本组件**；
  剥掉注释后逐格读实现，另加 store 与几个模块级注册，生产侧共 **25 处具名注册**。
  逐格核对的结果（这是本批的主要产出，不是顺手改代码）：
  ① **15 格是"挂载期注册 + 卸载期同一 `(事件, 处理器)` 解绑"，已经写对了** —— 而且这些组件各自有真界面读数
  （`vlist`、`winsafe`、`tasksrt`、`lightbox`、`logs`…）。⇒ 判**保留自研**：按 §七.7，
  行为正确、被钉住的东西不该为了"多用一个库"重排一遍，收益只有十几行模板、代价是热路径回归风险。
  ② **4 格按业务状态开关**（`MessageItem` 长按吞 release 那三条 + `GroupTasksBoard` 粘贴那条）⇒ 同样**保留自研**，
  理由不同：它们的寿命不是组件作用域，加不加库都得手写 on/off。
  ③ **真缺陷在两个地方，且形状一模一样：处理器写成匿名函数 ⇒ 结构上就摘不掉。**
     `App.vue` 那四条（其中 `contextmenu` 是内联箭头，`visibilitychange`/`focus`/`blur` 三条**完全没有解绑路径**）；
     `useAppStore.ts` setup 里的 `beforeunload`/`visibilitychange` 两条也是匿名箭头，
     而同一只 store 在 `init()` 里早就用 `createInitScope` 统一拆别的注册 —— **同一个文件里两种口径**。
     这一类失败不响亮：界面照常用，只有"重挂一次多一份回调 / 多打一次 IPC"会偶发冒出来。
- **做了什么**（各归各家，没有新抽象）：
  ① `App.vue` 四条改 `useEventListener`（已装的 `@vueuse/core@14.4.0`，按组件作用域自动解绑），
     并把内联的右键屏蔽判断提成具名 `suppressContextMenu` —— **原来那句 `const sel = window.getSelection()`
     是没有任何句柄可以 remove 的**，组件重挂（HMR）一次就多一份，`reportActivity` 同理多打一次 `set_app_active`。
  ② store 那两条挪进 `init()` 的本轮 `scope`（`scope.onDispose`），处理器具名 ⇒ 与同文件那两条 `mq`/`resize` 同一个口径；
     **没有**新增容器、**没有**新增 composable。
  ③ 新判据一条（`designGuards.test.ts`，全仓形状、分母现扫、不写死文件名）：
     `.vue` 里出现"内联函数当处理器"的注册 ⇒ 红；`.vue` 里手写的 `addEventListener("e", h)`
     在同文件配不上同 `(事件, 处理器)` 的 `removeEventListener`、且整文件没用 `useEventListener` ⇒ 红；
     另带两条分母下限（组件份数 > 80、具名注册 >= 15）防"扫了个空就报绿"。
- **读数**（都在**最终内容**上复跑）：`npm test` **1073/1073、exit 0**（+1 条判据）；
  快速层 `npm run verify` **17/17、exit 0**（19.4s）；
  两条单点变异各证一次非空转并各点名到文件 —— 往 `App.vue` 塞一条内联 `addEventListener("online", () => {})` ⇒ 红
  「内联处理器结构上摘不掉…src/App.vue」；摘掉 `ConversationList` 那句 `removeEventListener("click", closeFriendMenu)` ⇒ 红
  「手写的 add 必须配同 (事件, 处理器) 的 remove：src/components/ConversationList.vue: click/closeFriendMenu」。
  两处都由 `/tmp` 备份恢复、`diff -q` 核对后复绿（154/154）。
- **一次被门禁当场抓住的自伤（记下来，别再犯）**：本批把 `App.vue` 的形状改了之后，
  第 10 步「护栏注入锚点静态核对」**fail-fast 报红** —— 判据「聊天区文本选择契约」的注入锚点写的是
  `'    const sel = window.getSelection();'`（4 空格），而那句搬进 `suppressContextMenu` 后是 2 空格。
  一条测试都没跑就被拦下 ⇒ 这正是这道核对存在的意义。锚点按新形状改过（并留注释说明为什么改），
  `python3 scripts/verify-guards.py --only 文本选择` 复跑 **1/1、exit 0**（改坏 FAIL、恢复 PASS、红由点名那条报出）。
- **没验的 / 欠账**：① 探针不挂根组件 ⇒ **真窗口里右键是否仍放行系统菜单、切前台/后台后蓝牙扫描节奏是否照旧，
  本批没有真界面读数**。只有间接证据：探针每一段都会先 `Page.navigate` 真加载一次应用壳
  （`main.ts` → `App.vue` setup 会跑，之后夹具才替换 body），所以那四条监听的注册路径每次都被真走过；
  **需要他在真窗口右键一次、并确认切后台/回前台没有异常**；
  ② 真机（Android / iOS / WKWebView）**NOT RUN**；③ `useBackLayer` 的 `popstate`、`boot.ts` 的崩溃钩子、
  `i18n` 的 `languagechange` 三处是"每文档一次"的模块级注册（有 `installed` 旗标或模块单次语义兜着），
  判据按 `.vue` 划界因此不覆盖它们 —— 现读它们各自也只注册一次，不是欠账，但**口径要在这里写清楚**。

### 6.44 输入去抖与"延迟镜像"两格交给 `@vueuse/core`：`debounce` 与 `useDeferredRef` 整册删除（P1 · 队列 6 收尾 + 队列 11①）

- **为什么这一批值得动**：`utils/defer.ts` 里那个 `debounce` 是本仓自己写的尾沿计时器，
  `composables/useDeferredRef.ts` 又只是它上面的一层包装（`watch(source)` → `commit(v)` →
  `deferred.value = v` + `onBeforeUnmount(cancel)`）。已装的 `@vueuse/core@14.4.0` 同时给了
  `useDebounceFn`（尾沿 + `cancel`/`flush`）和 `refDebounced`（原值即时、派生延迟那一档）⇒
  这正是目标里"库能给、又留着包装层与原实现"那一格。**先证等价再动手**，不猜。
- **等价是靠现量出来的，不是靠读文档**：把 `defer.test.ts` 那套假定时器搬到库上跑，六条语义逐条全等 ——
  连发 10 次只在停手后执行一次且参数是最后一次的、间隔大于窗口时每次都执行、`cancel` 丢弃待执行且不剩定时器、
  `flush` 立即执行且原定时器已被清掉、无待执行时 `flush` 是空操作、`refDebounced` 初始等于原值且窗口后才落新值。
  另外两条单独量过（真定时器）：作用域 `stop()` 后待提交**不回写**（与 `useDeferredRef` 的
  `onBeforeUnmount(cancel)` 同一个结果）；待执行在作用域关闭后仍会跑完一次（自研版也是这个行为，不是新风险）。
  ⚠️ 顺带**更正 §6.40 的一句判断**：那轮写过「`useDebounceFn` 换不掉"两档"这一层」——
  那句把库的能力记少了，"延迟镜像"那一档就是 `refDebounced`；当时的结论因此偏保守。
- **删掉与改掉的（全部现算）**：`utils/defer.ts` **93 → 54 行**（`Debounced` + `debounce` 整块删除，
  只留 `INPUT_DEFER_MS` 与纯函数 `shouldRunThrottled`），`composables/useDeferredRef.ts` **31 行整册删除**
  （`git rm`）；调用侧 `useSearchKeyword.ts` / `AddFriendModal.vue` / `ForwardModal.vue` / `LogViewer.vue`
  直接叫 `refDebounced(x, INPUT_DEFER_MS)`，`useAppStore.ts:519` 的 `persistSoon` 与
  `ChatSearchDialog.vue:244` 的输入防抖直接叫 `useDebounceFn`。队列 11① 那两条额外语义原样保住：
  空关键词那格仍**立即**清 `searched`/`activeConvId`/`activeIdx`（不进去抖），到点那一发仍复查
  `props.open`；原来 watcher 顶部是无条件取消 ⇒ 换成 `pushKeyword.cancel()` 同位置，
  四个取消点（watcher、回车强搜、关窗复位、卸载）与改前逐格对得上（现算 `pushKeyword.cancel()` = 4 处）。
- **为什么不套新包装**：库的默认窗口是 200ms，而本仓"输入原值 + 派生延迟"那一档的实测值是 120ms
  （§6.40 量过卡顿才定的）。为了不把 120 抄成四份，常量放在 `utils/defer.ts` 一个家，
  各调用点显式传 ⇒ 既不引入第二份计时器实现，也不新增一层 `use*` 包装。
- **判据跟着换了对象，但没有变松**：`defer.test.ts` 前半那四条原本是"自研 `debounce` 的真值表"，
  现在钉的是**库契约**（升级把哪条语义改了会当场红）；接线守卫的正则从 `useDeferredRef(` 换成
  `refDebounced(`（仍然要求"派生渲染不许直接读原值"那第三条仍在，那是这层守卫真正的价值）。
  `useAppStore` 那一格原来只断言"源码里出现过 `persistSoon`"—— 存在性半个守卫都不算，
  本轮换成**出现次数**：定义点 1 次、`persistSoon.flush()` 恰好 2 次（`beforeunload` + `visibilitychange`，
  §6.43 刚接上的那两条落库出口），并各配一条反空转字符串。
- **读数**：`npm test` **1073/1073、exit 0**；`npm run verify` 快速层 **17/17、exit 0**（17.8s，
  含 vue-tsc 与 vite 构建，第 10 步锚点核对未被本批改形状打断）；
  探针 `--only=search,logs` **23/23、exit 0**（真 Chromium 里打字触发那 150ms 与日志过滤的 120ms 窗口）；
  `node --test src/utils/defer.test.ts` **11/11**；收尾在最终树上再跑一次**全量探针**
  `node scripts/check-ui-runtime.mjs` **412/412、exit 0**（36 段；删掉 `useDeferredRef` 这册后，
  四个用延迟镜像的界面里 `LogViewer` 有真段、`AddFriendModal`/`ForwardModal`/联系人姓名过滤仍无独立挂载段 ⇒ 那三格只有静态证据）。
- **三次单点变异各证一次判据非空转**：① 把 `visibilitychange` 那一条 `persistSoon.flush()` 改成普通调用 ⇒
  计数判据红（10/1，报"落库出口必须仍是两条"）；② 把 `LogViewer.vue` 的 `deferredFilter` 改回直接等于 `filter` ⇒
  接线判据红（10/1，点名 `必须为 filter 建延迟镜像`）；③ 把真值表第一条的去抖换成不去抖的直通函数 ⇒
  语义判据红（10/1，报"连发期间不应执行"）。三处都由 `/tmp` 备份恢复并 `diff -q` 核对后复绿（11/11）。
- **没验的 / 欠账**：① 连发粘贴时"每 `INPUT_DEFER_MS` 才派生一次"这件事**没有新的运行时读数**——
  探针能证的是"打字之后结果正确"（`search` 18 条 + `logs` 5 条），证不了节流窗口真的合并了；
  这条原来也没有，属于既有欠账，要动得先在真窗口的性能面板上取一次连发粘贴的采样；
  ② `useDebounceFn` 的返回是 `Promise`（自研版返回 `void`），全仓 6 个调用点都不看返回值、
  且仓里没有 floating-promise 规则（无 eslint 配置），但**若将来给 `persistSoon()` 加 `await`**，
  语义会变成"等到窗口结束"，这与原来的同步返回不同 —— 写在这里免得日后当怪事查；
  ③ 真机（Android / iOS / WKWebView）**NOT RUN**；④ `shouldRunThrottled` 仍留在 `defer.ts`，
  它是"拿两个时间戳判该不该跑"的纯函数（`windowLaunch.ts` 用、且要能被 `node --test` 直测），
  VueUse 的 `useThrottleFn` 是绑作用域的节流器、给不了这个形状 ⇒ 继续**保留自研**。
- **认知索引跟着这次删除漂了 2 条（登记，不手改）**：`aoci.code.txt` 里还留着
  `useDeferredRef.ts[EU6T]` 一整条，以及 `defer.ts[EL7S]` 的 A 字段仍写 `debounce、shouldRunThrottled`。
  本轮**没有可用的写通道**：AOCI 的 MCP 在本会话 `mcp_list` 实测 **0 工具**（拿不到 Plan/Guide），
  而 CLI 侧 `init/scan/inventory/--deep` 历史上都退 3、也没有 `maintain` 子命令 ⇒ 按 AGENTS 的口径
  "证据不足或无法可靠生成语义时登记待办、不猜写"，这里只登记。**下次 AOCI 可用时应做的**：删 `EU6T` 那条、
  把 `EL7S` 的 A 改成"`INPUT_DEFER_MS` + `shouldRunThrottled`"，并按其 `R:` 面把 `windowLaunch.ts[RP5T]`
  对 `defer.ts` 的引用再确认一次（那条引用仍然成立）。

### 6.45 「延迟镜像」这一档第一次有真 DOM 读数；顺带抓出我自己写空的一条判据（P3 · 补 §6.44 的验证欠账）

- **为什么要动探针**：§6.44 换了 4 件用延迟镜像的组件，换完才发现其中三件
  （`AddFriendModal`、`ForwardModal`、联系人姓名过滤）在探针里**没有任何挂载段** ⇒ 那一批的
  运行时证据只覆盖到 `LogViewer` 与搜索框。任务书 §八 那句"不能只凭静态代码和探针绿灯判断体验已经达标"
  对这一族成立得最严格：**接线退化后界面完全正常**，只有连发粘贴才卡。
- **新增 `--only=friendfilter`（4 条判据）**：往 store 种 3 个对端（两个昵称含「探针」）→ 真挂
  `AddFriendModal`（`open: true`，`watch(props.open)` 无 `immediate` ⇒ 不会去打扫描 IPC）→
  打字"探针"→ 在 **50ms** 那一格读到"输入框已是新值、列表仍是全量 3 行"→ 300ms 读到
  "2 行且是 `探针甲|探针乙`"→ 清空后 50ms 仍读到 2 行、窗口后回到 3 行。
  前两条合起来就是"原值即时 / 派生延迟"这两档在真界面上**分开成立**的直接证据。
- **一条我自己写空的判据，被自己的变异当场抓住（这批真正的收获）**：第一版把"打字后读行数"塞进
  **同一次页面求值里同步读**（`dispatchEvent` 之后立刻 `box.children.length`）。看着比等待更严谨，
  其实**接不接延迟镜像都必然读到旧 DOM** —— Vue 的 DOM 更新排在微任务里，同拍谁都还没渲染 ⇒
  那条判据永远不会红。改成"窗口内、渲染之后"（50ms：> 一次微任务 + 一帧，< `INPUT_DEFER_MS`=120ms）
  才有判别力：把 `AddFriendModal` 的派生改回读原值 ⇒ 该段 **2/4 红**（红的正是第 2、第 4 条），
  由 `/tmp` 备份恢复并 `diff -q` 核对后 4/4。
  ⚠️ **口径值得留下**：量"节流 / 延迟窗口"这类时间行为，**同拍读是空转的**；判据的取样时刻必须落在
  "渲染已经落地、时间窗还没到"那条缝里，且要留双向余量（这里一边 ~16ms、一边 ~70ms）。
- **读数（全部在最终树上现算）**：`--only=friendfilter` **4/4、exit 0**；收尾复跑**全量探针**
  `node scripts/check-ui-runtime.mjs` **416/416、exit 0**（段数 36 → **37**，`grep -c 'want("' scripts/check-ui-runtime.mjs` 现算）；
  `npm test` **1073/1073**；快速层 `npm run verify` **17/17**（含第 10 步「判据脚本自身可解析」对
  `check-ui-runtime.mjs` 的 `node --check`）；三道文档门禁 exit 0。
- **没验的 / 欠账**：① `ForwardModal` 与联系人姓名过滤两格**仍无挂载段** —— 它们读的确实是同一个
  `refDebounced`，但"共用同一件能力"是推断，不是读数；下一批要么给这两格补段，要么把这条明确留在欠账里。
  ② 50ms 这一格依赖"渲染比时间窗先落地"这个前提，本机实测余量充足（16 vs 70ms），
  但在**极慢设备**上理论上可能反客为主 ⇒ 真机（Android / iOS / WKWebView）**NOT RUN**，
  若真机上这段红，先按这个方向查，不要先怀疑实现。

### 6.46 存储键名有了跨边界判据：首屏脚本的裸字面量 ↔ TS 侧 `*_KEY` 常量现算比对（P1 · 队列 新增「跨边界裸字面量」）

- **形状**：`src/boot/theme-boot.js` 由 vite 的 `gosslan:inline-boot` 内联进**每个窗口的 HTML**，
  必须早于 bundle 执行 ⇒ 它 import 不到任何模块，只能用**字符串字面量**读 localStorage。
  于是同一个"键名"在仓库里有两种载体：TS 侧的 `const *_KEY`、脚本里的裸字面量。
  **漂移是静默的**：脚本读了没人写的键 ⇒ 首帧永远按浅色/英文渲染，而 vue-tsc、构建、探针全绿 ——
  旧名字再没有任何一处代码引用，编译期看不见任何东西。
- **现算分母**（`grep -rEn 'localStorage\.(getItem|setItem|removeItem)\(\s*"' src` 加上对 `.vue` 的同形状检索）：
  生产码裸字面量调用 **6 处** = 首屏脚本 4 处（`gosslan.appearance` / `.dark` / `.themeColor` / `.locale`）
  + `ResponsiveLayout.vue` 2 处（读 + 写同一个 `gosslan-list-w`）；
  具名 `*_KEY` 字符串常量 **11 个**（本批之前 10 个，第 11 个就是新具名化的 `LIST_W_KEY`）；生产 `.ts`/`.vue`（不含 `*.test.ts`）**205 份**。
- **改了什么**：① `ResponsiveLayout.vue` 那 2 处收成同文件内的 `const LIST_W_KEY`（挨着
  `LIST_W_MIN/MAX`，键值一字未改 —— 改值会把用户已存的栏宽抹掉）；
  ② `appearance.test.ts` 加两条判据：**四个角色各自等于 TS 侧常量的现算值**
  （私有常量 `THEME_KEY` / `STORAGE_KEY` 按名字从各自源文件解析，**不为测试扩大导出面**）
  + 反方向"脚本读的每个键都必须在 `*_KEY` 集合里"，两条各带分母下限（具名键 ≥8、脚本键 ≥4、扫描面 ≥180）；
  ③ 第二条"生产码零裸字面量键"是**缺席型断言** ⇒ 自带正控：先对一段合成源码断言 matcher 认得出
  `probe.key`，再断言真实扫描 0 处，否则"0"可能只是正则坏了。
- **顺手修掉两处把人带偏的注释**：首屏脚本里点名的 `APPEARANCE_KEY`、`LEGACY_DARK_KEY` **全仓不存在**
  （真值是 `utils/appearance.ts` 的 `APPEARANCE_STORAGE_KEY` / `LEGACY_DARK_STORAGE_KEY`），
  而既有那条"注释点名的符号必须真实存在"的判据之所以没抓到，是因为它的正则**只列了它认识的名字** ——
  已把这两个名字补进择一式，并把注释改成写真的家。
- **非空转（三次单点变异，均 `/tmp` 备份 + `diff -q` 复原）**：
  ① 把 `useAppStore.ts` 的 `THEME_KEY` 改成 `gosslan.theme-color` ⇒ **1 红、exit 1**，
  报错同时印出两边当前值（`脚本读到的是：gosslan.appearance, gosslan.dark, gosslan.themeColor, gosslan.locale`）；
  ② **自己踩到的那一次**：`ResponsiveLayout.vue` 只改了读、漏改写 ⇒ 缺席型判据当场红并点名
  `layouts/ResponsiveLayout.vue → "gosslan-list-w"` —— 这条不算刻意设计，但它正是"半接线"最便宜的抓法；
  ③ 把注释里的 `APPEARANCE_STORAGE_KEY` 改回不存在的 `APPEARANCE_KEY` ⇒ 符号判据 **1 红**。
- **读数（最终树现算）**：`node --test src/utils/appearance.test.ts` **13/13、exit 0**（11 → 13）；
  `npm test` **1075/1075**；`npm run verify` **17/17、19.3s**（含 vue-tsc + 构建）；
  `npm run version:check` 与 `node scripts/check-change-budget.mjs` 均 **exit 0**（当前版本 **5.0.35**，未推送 5 笔）；
  重建后 `dist/index.html` 仍内联着那 4 个字面量（`.appearance` 1、`.themeColor` 1、`.locale` 2、`.dark` 2 ——
  多出的 2 处来自脚本自身注释，内联器不剥注释）。
- **判断**：这一格属**保留自研 + 补护栏**。两份实现的原因是平台约束（早于 bundle），不是偷懒；
  没有任何库能替代"跨边界键名一致"这条判据，也不该为它加一层包装。
- **没验的 / 欠账**：① 新判据只比**键名**，不比**值的语义** —— 语言那一格已由 §6.47 补成逐例对照；
  `themeColor` 仍是脚本原样写进 CSS 变量、没有与 TS 侧口径的对照（外观那一族有 10 例真跑对照）；
  ② "两边同时改成同一个新名字"这种漂移判据看不见 —— 那属于存量迁移问题，不是键名一致性问题；
  ③ 首帧闪白/语言首帧在**真实 WebView** 里的观感仍 NOT RUN（Windows WebView2 / Android / iOS）；
  ④ `gosslan-list-w` 的命名风格与其余 9 个 `gosslan.*` 不一致，**故意未改**（改值 = 抹掉用户已存宽度）。

### 6.47 首帧语言：第二份实现真的漂了一格，而我的第一版判据在比它自己（P0/P1 · 队列 新增「首帧语言逐例对照」）

- **动因**：§6.46 只钉住了**键名**，没钉**值的语义** —— 首屏脚本里 `detectSystemLocale` 那份第二实现
  仍然只靠注释"改动请同步"。这一族的症状是用户可见的：中文系统的骨架先英文、bundle 起来再翻回中文。
- **读到的一处真实分歧（不是重构）**：脚本把「languages 全不命中」直接落到英文默认，
  而 `i18n` 的 `detectSystemLocale()` 在无注入时还有一步 `navigator.language` 兜底。
  ⇒ 输入 `languages=["ja-JP"]`、`language="zh-CN"` 时，**i18n 判中文、脚本判英文**。
  本批把脚本对齐到事实源（`theme-boot.js:52-57` 补上"列表没命中再看 `navigator.language`"），
  改的只有这一格：`languages` 里能命中中英时的行为一字未动。
- **第一版判据是空转的，被自己的变异当场抓住（这批真正的收获）**：`bootAndI18n()` 先跑脚本、
  再调 `applyPreference()`/`refreshSystemLocale()`，最后才读 `el.lang` ——
  而 i18n 的 `syncDocumentLang()` **写的是同一个替身 `el`**。于是"脚本判出的 lang"其实是 i18n 自己写的值，
  两边比的是同一个数，**接没接兜底都永远绿**。
  把读取挪到"跑完脚本立刻取快照"之后，同一条变异才红：
  `首帧语言不一致：pref=null languages=["ja-JP"] language=zh-CN → 脚本=en-US，i18n=zh-CN`。
  ⚠️ **口径**：用替身 DOM 做 A/B 对照时，**两个被测方不许共用一个可变出口**；
  先跑 A、再跑 B、最后读共享容器 ⇒ 读到的一定是 B。这条比 §6.45 那条"同拍读 DOM 是空转"更隐蔽，
  因为它连"时序"都不涉及，纯粹是被测系统的副作用互相覆盖。
- **九例矩阵**（`pref` 三态 + `languages`/`language` 组合）：显式偏好两支、"system" 走检测、
  脏值走检测、`languages` 空 / 全非中英 / 首个命中 —— 期望值**全部来自 i18n 的公开 API**
  （`isLanguagePreference` + `applyPreference` + `refreshSystemLocale` + `currentLocale`），
  判据里不抄任何一条白名单或前缀规则；`gosslan.locale` 的键名也从 `i18n/index.ts` 现解析。
  替身 `navigator` 用 `Object.defineProperty` 覆盖并按原描述符还原（Node 的 `navigator` 是只读访问器）。
- **另外两条**：骨架标题按首帧语言取 `data-title-zh`/`data-title-en` 两支（含"HTML 没声明就不许动 title"）；
  五扇窗口 HTML **必须同时声明两支**（现算分母下限 ≥5）—— 少一支的形态只在另一种语言下错，最容易漏看。
- **读数**：`node --test src/utils/appearance.test.ts` **16/16、exit 0**（13 → 16）；
  `npm test` **1078/1078**；`npm run build`（含 vue-tsc）**exit 0**，`main` 308.49 kB / gzip 93.16；
  `check-change-budget` 与 `version:check` 各 **exit 0**。
  两次单点变异各红一次（摘 `navigator.language` 兜底 ⇒ 语言逐例判据红并点名输入组合；
  标题只取中文支 ⇒ 标题判据红），`/tmp` 备份 + `diff -q` 核对复原后复绿。
- **⚠️ 快速层第 9 步当时是红的，但不是本轮代码**（下一批 §6.48 已复跑转绿）：`npm run verify` 停在「判据脚本自身可解析」，
  `scripts/verify-guards.py:405` 把多行 `print(` 写成了带**字面 `\n` 的一行** ⇒ `SyntaxError: unexpected character
  after line continuation character`。该文件与 `guard_cases/file_transfer.py` 都是并行会话正在改的
  （`git status` 三条 `M`，最后一次提交 `677735c`），本会话一字未动，**不替对方改**。
  所以这批的证据是"单测 + 类型检查 + 构建 + 版本/预算/文档门现算全绿 + 快速层第 1–8 步绿、
  第 9 步 BLOCKED（他人 in-flight 编辑）"，不写成"17/17 绿"。
- **没验的 / 欠账**：① 真实 WebView 里的首帧观感（会不会真的闪一下语言/标题）仍 **NOT RUN**；
  ② `localStorage` 抛错的隐私模式路径下，脚本整个 try 提前退出 ⇒ `el.lang` 与 dark 类都不写，
  而 i18n 会继续按系统语言判定 —— 这是**已知的结构差异**（脚本一个 try 包全局），本批只登记不重构；
  ③ 标题文案本身（中英两支各窗口是否贴切）是主观判断，留给用户。

### 6.48 「延迟镜像」的三格挂载段合用量具：时间阶梯只留一份，三处各自能红（P3 · 关掉 §6.45 最后一格覆盖欠账）

- **欠账形状**：§6.44 换了四件用延迟镜像的组件，§6.45 只给 `AddFriendModal` 补了真 DOM 读数，
  `message/ForwardModal.vue`（过滤会话）与 `ConversationList.vue:53`（通讯录姓名过滤，走 `useSearchKeyword`
  那条共用组合）**仍无挂载段** —— 而"共用同一件能力"恰恰是单点退化最容易漏掉的那一型：一格的接线坏了，
  另两格照绿。⚠️ 同时更正清册里的一处措辞：这一族没有独立的"联系人页"组件，两格调用面就是上面这两个；
  会话栏那一格**故意不过滤**（用户 2026-09-12「在上面输入，列表就不要有变化了」）⇒ 量派生必须挂 `view:"contacts"`。
- **量具自身也去重**：原先"打字 → 窗口内读 → 窗口后读 → 清空 → 再两拍"这套阶梯写死在一个段里。
  现在抽成 `mirrorLadder()` + `mirrorSeed()`（三段共用的种 store 前置），段与段的差异退化成参数：
  组件路径、props、种子数据、输入框/列表的选择器、以及"这一行在不在"的三种判法
  （`title=` / `aria-label` 含名字 / 行内文本全等）。四条断言与时间窗只留一份。
  探针段数 37 → **39**（现算 `grep -c 'want("' scripts/check-ui-runtime.mjs`）。
- **首跑 12/12，于是把三条都顶了一遍（这批要留的东西）**：一次改三格 —— 每格把派生从 `query.value`
  改回读原值 `keyword.value` ⇒ **恰好 6 条红，且每段红的都是那两条时间判据**，
  而"过滤框挂出来了 / 窗口后拿到正确那两条"三段照绿；三处 `/tmp` 备份 + `diff -q` 复原后重跑 12/12。
  口径：**共用量具必须证明每个调用点各自能红** —— 否则"三段共用一份阶梯"只是把一次空转复制了三遍。
- **读数（最终树现算）**：`--only=friendfilter,forwardfilter,contactfilter` 改前 **12/12**、变异后 **6 红 exit 1**、
  复原后 **12/12**；收尾复跑全量探针 `node scripts/check-ui-runtime.mjs` **424/424、exit 0**（39 段）；
  快速层 `npm run verify` **17/17、32.9s**（上一批 BLOCKED 的第 9 步已被并行会话修好：
  `scripts/verify-guards.py` 现在可解析 ⇒ 这一批是整层绿的，不只是"第 1–8 步"）。
- **没验的 / 欠账**：真机上拇指连发粘贴（Android / iOS）仍 NOT RUN —— 这三段量的是"两档在 chromium 里分开成立"，
  不等价于真设备"打字不卡"的主观手感；另外 `ForwardModal`/`ConversationList` 这两段用的是同一份假数据形状，
  真实会话名/昵称里带大小写混排、emoji、全角的情况没有读数（`toLowerCase()` 那一步只在单测里判过）。


### §6.49 主题色派生档只留一份实现（P1，里面还嵌着一条真的首屏缺陷）

- **形状**：`--gosslan-primary` 的三档派生（hover / active / light）有**两份实现且互相不同意**——
  `utils/color.ts` 的 `applyTheme` 按 8% 混白 / 8% 混黑 / 12% 透明现算，而 `style.css:13-15` 又硬编一份
  出厂蓝的近似值（`#60a5fa` / `#2563eb` 并不是同一比率的产物）。首屏脚本只写得到 `--gosslan-primary`
  ⇒ 在 store 起来之前，**按钮已经是用户色、hover 与半透明选中底还是出厂蓝**。这一格不是重构偏好，是真实的第一帧缺陷。
- **改法（去重，不新增抽象）**：三档改成 `color-mix(in srgb, var(--gosslan-primary) …%)` —— 同一家里
  `--gosslan-primary-soft` / `-ring` / `--gosslan-accent-ink` / `--gosslan-danger-hover` 本来就是这么派生的，
  JS 那一份才是异类。`applyTheme` 于是只写主色与字体；`lighten` / `darken` / `mix` 失去全部生产调用者，随本批删除。
  派生只剩一处之后，`.dark` 第一次**有可能**单独覆盖派生档（以前 inline 压着，`style.css:25` 那条注释写的就是这个约束）。
- **顺带量出来的缺口（已按本仓既有做法收口）**：去掉硬编兜底后，契约表第一次读到用户真正看到的值 ——
  白字压在 `--gosslan-primary-active` 上只有 **4.25**，而 `tokenContrast.ts:179/200` 要求 4.5
  （那条"未完成任务蓝色徽标"一直靠兜底值 `#2563eb` = 5.17 判绿）。按 danger 家族当年的同一处置
  （为这条把填充色压深到 4.62）把 active 的混黑比例定为 15% ⇒ 实测 **4.85** 过线。
  受影响面现算：`-active` 只有两个消费者（`UnreadBadge` 蓝底 + `ConversationListItem` 的任务图标），
  按钮按下态不走这个 token ⇒ 没有"全应用按下态变深"这种连带观感改动。
- **还欠着的（本批不擅自改）**：`-hover` 朝白混（更浅 ⇒ 白字更低），12 个组件拿它当 hover 底，
  而契约表**没有这一行**（danger 的 hover 有）。补这一行必然要把主色 hover 改成朝暗混 ——
  那是全应用按钮 hover 的观感方向变化，留给负责人拍板，不在这里替产品做决定。
- **读数**：`npm test` **1078/1078**；`color.test.ts` + `tokenContrast.test.ts` + `appearance.test.ts` **35/35**；
  新增探针段 `--only=accent` **6/6**；快速层 `npm run verify` **17/17、39.8s**；
  `npm run build`（含 vue-tsc）**exit 0**（`main` 308.49 kB / gzip 93.15）。
  三次单点变异各红一次：兜底改回硬编 `#2563eb` ⇒ 探针 active 条红；`applyTheme` 重新 inline 写 hover ⇒
  单测"只注入两件事"那条红并列出真实变量名；active 的混向改成 `#ffffff` ⇒ 真实样式表契约红且印出 `= 2.98 < 4.5`。
  三处都 `/tmp` 备份 + `diff -q` 核对复原。
- **⚠️ 两条自己写空的判据，都是当场抓出来的（写判据的新教训）**：
  ① **`color-mix` 的 computed 值不写成 `rgb()`**：Chrome 153 回的是 `color(srgb 0.844863 0.300078 0.321725)`。
    按"抓三个数"去读会把 0.84 / 0.30 当成 RGB —— **数值全错、格式看着完全正常**。取色器现在两种写法都归一化，
    且先拿一段**合成正控**证明归一化自己没坏。
  ② **判"inline 里没有派生档"测的是环境不是产品**：探针页面没有 Tauri，`applyTheme` 压根不跑，
    那条判据不管产品怎么写都绿。换成"只改主色这一个 inline，派生三档的取值必须跟着变"（前后对照）
    才量到真实行为 —— 它同时也是"首屏就成套"的直接读数。
- **没验的 / 欠账**：① 真机 `WKWebView` / `WebView2` 上的 `color-mix` 本批**没有读数**（不是新增风险面：
  样式表里已有 10+ 处 color-mix 在跑，但那两端的实际渲染值没人量过）；② 蓝徽标与任务图标比原先略深，
  主观观感留给负责人在真窗口确认；③ `--gosslan-font-family` 仍在 `applyTheme` 里写、首屏脚本不写 ——
  自定义字体那条首屏路径和本批无关，还没盘过。

### §6.50 字体与主色是同一族缺陷，当年只修了一半（P1）

- **形状**：用户在设置里选的字体存进 `localStorage`（`gosslan.fontFamily`），`applyTheme` 把它写成内联
  `--gosslan-font-family`。但**首屏脚本不读这个键**，而骨架 CSS 又写死一份默认栈 ⇒ 选了字体的人每次启动
  先看到整屏系统栈，等 store 起来才翻一次。这跟 2026-09-21 那条"骨架屏没适配主题色，现在永远都是蓝色的"
  是**同一族**：那一半当年修了（`windowEntries.test.ts` 里现在还有那条守卫，写明"骨架只要引用 token"），
  字体这一半一直没人补。**教训：修一族缺陷时要把同族其它成员一起点名，别按用户报的那一个现象修。**
- **默认栈原来有四处各一份**（现算）：`style.css` 的 token 值、`color.ts` 的 JS 兜底串、
  `skeleton.css` 的写死栈、`AppearanceSection` 里那个选项字面量（最后那份只是 UI 的 option value，
  选"系统默认"时落库的是空串 ⇒ 它不是第二份实现，没动）。本批收到两处：
  token 那一份 + 骨架的必要兜底（骨架样式先于 `style.css` 加载，`var()` 那时还没有值可解析）。
- **改法**：首屏脚本读同一个键并写这个 token（默认档空串 ⇒ 不写，让 CSS 的 token 生效）；
  `applyTheme` 删掉 JS 兜底串，默认档改成 `removeProperty`；骨架 `font-family` 改 `var(--gosslan-font-family, <兜底栈>)`。
- **读数**：`npm test` **1080/1080**（比上一批 +2：字体那条逐例对照 + 骨架引用守卫）；探针 `accent` 段 6 → **7 条、7/7**
  （新增一条"字体 token 不是死变量：改内联后真实元素的 computed fontFamily 跟着换"）；
  快速层 **17/17、59.9s**；`npm run build` exit 0；三道文档门与 `check-change-budget` 各 exit 0（版本现读 **5.0.35**）。
  **一次改三处**（首屏不写 / 骨架写死 / JS 又抄兜底栈）⇒ 恰好 **3 条红**、三条分别是
  `appearance.test.ts` 的对照、`windowEntries.test.ts` 的骨架引用、`color.test.ts` 的变量清单；三处 `diff -q` 核对复原。
- **⚠️ 一处判据空转被自己的变异测试抓到**：第一版把两次 `applyTheme` 放在同一个 `try/finally` 之外，
  第二次跑在无 `document` 的环境里 —— 红得像是产品坏了，其实是替身生命周期写错。
  另：`runBootScript` 原来只记"加了哪些类"，看不到内联变量 ⇒ 必须先让量具能读出这一维，判据才谈得上有效。
- **没验的 / 欠账**：① 真机首帧（选了非默认字体的窗口第一帧到底是不是那个字体）**NOT RUN**；
  ② 那几档字体在目标机器上**装没装**没盘过 —— 未安装时浏览器自己回退，界面不会报错，
  所以"选了思源却仍在系统栈上"这种情况目前没有读数；③ 字体值本身合法性仍不校验（同 §6.49 里 `themeColor` 那条）。

### §6.51 「长按容差不一致」查下来不是缺陷 —— 判过并留痕，顺手把它的前提钉成判据

- **来路**：待办清单上挂着一条"两处长按容差不一样（一处 12px、一处 450ms 无容差）"。逐行读完两处之后判**不是缺陷**：
  两条用的是**不同的取消路径**，各自成立。
  `MessageItem`（消息行菜单）自己绑 `@touchmove` 判，所以必须有抖动容差 —— 那 12px 是用户 2026-09-13
  真机报"长按十次九次不灵"换来的；`MessageReactionBar`（长按胶囊看名单）**不绑 move**，
  靠 `pointercancel`（浏览器把这一串手势判给滚动时发出）+ `pointerup` / `pointerleave` 清定时器。
  给后者补一份容差判定 = 在平台已经提供的那道上再叠一份自研，**没有收益**，所以不动。
- **但它的前提此前没有任何判据**：第二个方案成立的条件是"那三个取消出口都在"。少一个（尤其 `pointercancel`）
  的失效形状恰好是**"在胶囊上开始竖向滑动 ⇒ 450ms 后名单自己弹出来"**，只有真机看得见。
  于是补一条成对判据（`longPress.test.ts`）：起点数与 cancel 出口数一对一、三个出口逐一在位、
  卸载时摘表；并带**合成正控**（喂一段"少一个 cancel"的源码，先证明匹配器真的会判缺）。
- **读数**：`longPress.test.ts` 8 → **9/9**；变异（删掉 `@pointercancel="clearPress"` 那一行）⇒
  **该条红并点名是哪个出口**，`/tmp` 备份 + `diff -q` 复原后复绿。
  §6.50 收尾的全量探针 **431/431、exit 0**（40 段；这一段跑的是字体接入后的树）。
- **没验的 / 下一批的入口**：① "从胶囊起手竖向滑动到底发不发 `pointercancel`" 在 Android WebView / WKWebView 上
  **没有读数** —— UI 探针那段走的是 hover 分支（`canHover` 为真时这条长按路径直接 return），
  要真验得用 CDP `Input.dispatchTouchEvent` 造一串带位移的触摸（本仓探针目前没有这能力，是下一步最值钱的一格）；
  ② `--gosslan-font-family` 的取值合法性、`themeColor` 的取值合法性（§6.49/§6.50 各登记一次，仍未动）；
  ③ `-hover` 那一档的白字对比度是契约空白，补它会逼出全应用按钮 hover 方向的观感变化 ⇒ 等负责人拍板。

### §6.52 动效族的「减弱动态」只接住了四处里的三处（2026-10-19）

**发现方式**：本轮把 P0 那条「事件泄漏 / 生命周期」用机器数了一遍 —— 一次性脚本
（`/tmp/leak-sweep.mjs`，扫 `src/**` 生产码 206 份，只筛不调）列出七类"取用"模式与其对偶"释放"模式，
读数：`addEventListener` 28、`new ResizeObserver` 2、`new MutationObserver` 1、`new IntersectionObserver` 0、
`setInterval` 2、`requestAnimationFrame` 7、自研事件总线 `.on(` 0；
其中 5 格报"找不到对偶"，逐格读过之后 4 格是环境级常驻（`boot.ts` 的全局错误上报、`i18n/index.ts`
的 `languagechange`、`App.vue` 的 `onMounted`（根组件不卸载）、`useAppStore.ts` 的 rAF 重判一帧），
**没有一格是真泄漏** —— `VirtualList` 那两个 `ResizeObserver` 在 `onBeforeUnmount` 里成对 `disconnect()`
（`VirtualList.vue:430-431`），所以那一格判"保留自研"，不改（TanStack Virtual 换不换它是矩阵第 42 行
已经用 P7 实测 + `--only=vlist` 12/12 判过的 C 档，不在本批重开）。

真正的问题是顺着"动效"这条线读出来的。把会产生位移/震动的出口点名数完，一共四家：

| 出口 | 谁产生 | 系统「减弱动态效果」怎么接住的 |
|---|---|---|
| 全局 CSS 过渡/动画 | `style.css:624-632` | `@media (prefers-reduced-motion: reduce)` 把 duration 压到 0.01ms |
| 骨架呼吸 | `boot/skeleton.css:584-604` | 同一条 `@media`，直接 `animation: none` |
| 触觉震动 | `utils/haptics.ts` | JS 自己读 `matchMedia` ⇒ 命中就 return |
| **桌面窗口抖动** | **`useChatStore.ts:507` → Rust `commands/network.rs:199`** | **没人接** |

最后一行是缺陷：那条 Rust 命令连续 7 次 `set_position`（`[10,-10,10,-10,8,-8,0]` × 45ms ≈ 315ms）
**真的把整扇 OS 窗口搬走**，CSS 那条降级管不到窗口本身，而 Rust 侧读不到 WebView 的媒体查询
（`grep -rni reduced src-tauri/src` 零命中）。结果对动效敏感的用户：界面里所有动画都按要求关掉了，
别人按一下「抖动」却把自己的窗口整个摇了一遍 —— **同一个 OS 开关，四个出口三种守约、最响的那一种不守约，
且不报错**。这与 §6.50 那条"主色修了、字体没修"是同一个形状：**判过一族缺陷之后必须把同族其它成员点完名**。
（`requestAttention`（macOS Dock 弹跳 / Windows 任务栏闪烁）是第五家，本批**判为保留**并已把理由写清：
它是"不动窗口"之后唯一还在的后台提醒通道，门掉它等于让桌面端收到强提醒没有任何感知 —— 这一条由他拍板可随时推翻。）

**改法（两处，都在前端，不动 Rust）**：

1. `utils/platform.ts` 长出这一对（与 `canHoverByMedia`/`canHover` 同一个家、同一套口径）：
   `prefersReducedMotionByMedia(mm)` 纯函数 + `prefersReducedMotion()` 运行时读数。
   **每次调用现读**，不在模块加载时快照 —— 用户改系统开关不该要求重启应用；而触觉与抖窗都是
   "事件发生才问"的低频调用，现读只多一次 `matchMedia`，不注册监听也就不需要摘。
2. `utils/haptics.ts` 删掉私有的 `reduceMotion()`（那是这条查询的第二份手抄），改调上面那个；
   `stores/useChatStore.ts` 的 `raiseAndShakeOnRemind` 桌面分支在节流之前先 `if (prefersReducedMotion()) return;`。
   窗口仍拉到前台、会话仍切过去（用户 2026-10-12 那句"抖动可以不提醒，但窗口要直接给他打开"是功能本体，
   抖只是装饰），声音/通知/Dock·任务栏都不受本闸影响。

**判过但不动的一格**：`haptics.ts` 能不能换成 VueUse 的 `useReducedMotion()`？
**保留自研**，理由是实测出来的结构差：那个 composable 返回 `ref` 且把监听挂在 effect scope 上，
而 `haptic()` 是被 6 个调用点直接调的普通函数（`ConversationListItem` ×2、`FriendListItem`、`MessageItem`、
`MessageComposer` ×2），要么在模块顶层调 composable（脱离 scope ⇒ 监听永久留着，比现在更差），
要么把 ref 一路传进工具函数（为了用库再加一层）。现在这版每次读 `.matches`，**零监听、零 scope、值也照样是活的**。

**验证**（每条挂复跑命令）：

- `npm test` → **1085/1085**（本批 +4：纯函数两方向、"查询串只有一个家"、触觉两方向、抖窗闸必须在调用之前）。
  复跑：`npm test`（条数由它自己打印）。
- `npm run verify` → **17/17、32.1s、exit 0**（含 vue-tsc 与 vite 构建）。
- 收尾全量探针复跑 → **431/431、exit 0**（40 段）。本批改的是 OS 级抖窗，探针页里没有 Tauri，
  这一段对它不作数；它在这里是**回归确认**（确认 `platform.ts`/`haptics.ts`/store 三处改动没弄坏运行时那 40 段）。
- 三次单点变异，各自只红该红的那条，`diff -q` 核对复原：
  ① 摘掉 store 的闸 ⇒ `remindFlow.test.ts` 那条接线判据红；
  ② `haptics.ts` 改回自己手抄查询串 ⇒ "只有一个家"红并点名文件；
  ③ `prefersReducedMotionByMedia` 判成恒 `false` ⇒ 触觉行为用例与纯函数用例两条一起红
     （触觉那条同时验反方向："没开时必须照常震"，否则 0 读数可能只是整条路径坏了）。
- **⚠️ 量具自己的一格坑（本批撞上并当场纠正）**：第一次跑变异把命令存进变量
  `NODE="node --test --experimental-strip-types …"`，zsh **不拆词** ⇒ 三次全部 exit 127（command not found），
  屏幕上只印出 `M1 exit=127 / 0`，**看着像"改坏也没红"，其实是测试根本没跑**。
  改成每条命令写全，才拿到上面那三份读数。凡是"变异后没红"，先证明那次真的执行了测试。

**NOT RUN（欠的）**：真实系统开关下的观感 —— macOS 系统设置 → 辅助功能 → 显示 → 减弱动态效果，
需要真机两态各收一次"收到强提醒时窗口抖不抖"的读数；CDP 探针帮不上（它跑在没有 Tauri 的页面里，
`api.shakeWindow()` 那条 IPC 根本不存在），所以这一格只能由真机补。iOS/Android 本批无影响
（移动端那一路退回 CSS 动画，`shake_window` 的 `#[cfg(mobile)]` 版是空实现）。
Windows 桌面腿同样没跑。

### §6.53 「这条只有真机测得了」是句错话 —— 补上滚动抢走长按手势那一格（2026-10-20）

**起因是先发现自己写错了一句记录。** §6.51 收尾时我写下"本仓探针没有 CDP 触摸能力
（`Input.dispatchTouchEvent` 那套没建）⇒ 『从胶囊起手竖向滑动到底发不发 `pointercancel`』只能等真机"。
本批要挑下一格时先 grep 了一遍探针：`scripts/check-ui-runtime.mjs:4350` 就在用
`Input.dispatchTouchEvent`，`touchroster` 段本来有 5 条真触摸派发（长按弹名单、松手不收起、点外面收起……）。
**那句话是错的**，而它当时把一格本可以机器量的东西判成了"无判据"。既然派发得出来，
缺的只是"一串**带位移**的触摸" ⇒ 本批把它补上，并回头更正记录。

**做法**（只动探针，不动应用码）：在 `runTouchRoster` 末尾加三条。

1. **前提自证**：先在页面里挂计数器（capture 阶段的 `pointercancel` / `touchcancel` 各记一笔），
   再用 `Input.synthesizeScrollGesture`（`gestureSourceType: "touch"`、`yDistance: -120`、
   `speed: 800`、`preventFling: true`）从胶囊中心起手做一次竖向滚动手势，然后断言
   **这台浏览器真的发了 cancel**（计数 > 0）。
   为什么用 synthesizeScrollGesture 而不是手发 `touchMove`：手发的移动点不会让浏览器把这次触摸
   **判成滚动**，于是 `pointercancel` 压根不来，"名单没弹"就变成一次假绿。
   实测机器值：`cancel={"pointer":1,"touch":0}`（这台 Chrome 在滚动接管时发的是 `pointercancel`，不是 `touchcancel`）。
2. **结果**：滑动之后等 700ms（> 450ms 的长按阈值），断言名单**没有**弹出来。
3. **反控**：同一坐标**按住不动** 650ms，断言名单**会**弹 ——
   没有这一条，上一条的"没弹"可能只是因为整条长按路径坏了。

**读数**：`node scripts/check-ui-runtime.mjs --only=touchroster` ⇒ **9/9、exit 0**（这一段原 6 条 + 新增 3 条）。

**本批最值钱的发现是两轮变异跑出来的，而且它推翻了我自己上一批写下的一条结论：**

| 变异 | 静态那条（`longPress.test.ts`，§6.51 补的那条） | 运行时新那条 |
|---|---|---|
| 只摘 `@pointercancel="clearPress"` | **红**（点名出口） | **照绿** |
| 把 `@pointercancel` 与 `@pointerleave` 一起摘 | 红 | **红**，打印 `afterScroll=true`，其余 8 条照绿 |
| 复原（`diff -q` 核对） | 绿 | **9/9 绿** |

⇒ 这条用户可见的结果（"在胶囊上竖向滑动不要把名单弹出来"）在 Chrome 里由**两个冗余出口共同守**：
`pointercancel` 和 `pointerleave` 谁先到都能取消长按计时器。所以 §6.51 写的失效形状
"少一个出口 ⇒ 名单自己弹出来"**是错的**，实测要**两个都少**才成立。

这件事留下两条方法学（都已进记忆）：

- **新增一条运行时判据之后，第一次反证如果只摘"手上那一个绑定"而判据照绿，不要立刻当成"判据坏了"，
  也不要当成"绑定有守卫了"** —— 先问"还有没有别的路径会做同一件事"，再用**摘掉全部冗余出口**那一发
  作为这条判据的非空转证明。两轮跑完才知道：判据没坏（M2 它红了），绑定也确实有另一条判据在守（M1 静态红了）。
- **行为层判据与绑定层判据是两个层次，各证一次，不许互相顶替**：运行时那条守"用户看得见什么"，
  静态那条守"成对的取消出口在不在位"。只留运行时 ⇒ 摘掉一个绑定不会报警（本批 M1 实测），
  将来两个引擎的取消时机不一样时就没有凭据；只留静态 ⇒ 变成又一条"只读源码不看结果"的判据。

**更正掉的历史**：§5 那条"真机触摸那一路还没有 CDP 能力"改写为
"探针已有真触摸派发，缺的只是带位移的手势，本批已补；仍欠的是**别的引擎**（WKWebView / WebView2 /
Android WebView）上到底发 `pointercancel` 还是 `touchcancel`" —— 这一格从"没有判据"降级成
"有判据、但只在这台 Chrome 上量过"。

**NOT RUN（本批如实记）**：本批没跑全量探针（只跑了受影响那一段 + 复原复跑）；当时留下的预测是"下一次全量应是 **434**（上一轮实测 431 + 本段新增 3 条）"，**§6.55 收尾那次全量已把它变成实测读数：434/434、exit 0、40 段** —— 条数与预测一致。应用码一字未动 ⇒ `npm test` 只作回归确认。

### §6.54 「无用导出」这一轴机器数完了：已经是干净的（2026-10-20，无码改动）

目标里 P3 那条「删除死代码、无用导出」此前只有注释级的印象，本批把它数完。一次性脚本
（`/tmp/unused-bucket.mjs`，扫 `src` + `scripts` 全部 `.ts/.vue/.js/.mjs` 共 365 份，测试文件与被定义文件
自身除外；再叠一层"文档/HTML 有没有点名"的分桶）读数：**832 个导出符号**。

| 桶 | 条数 | 含义与处置 |
|---|---|---|
| A 生产码零引用、**本文件内也只出现一次**（声明即全部） | **2** | 都在 dev 脚本（`scripts/ax-tree.mjs::pressElement`、`scripts/rustSrc.ts::readDbSrc`），不在本专项面内 —— `scripts/` 与护栏工具是并行会话地界，且这两处删掉换不到任何读数，**不动** |
| B 只在本文件内被用（死的是 `export` 这个字） | **92** | 收窄导出面属机械改动，`vue-tsc` 能证没人引用，但**一次改 ~100 格换不到任何用户可见或判据可见的差别** ⇒ 判为不做（记下来防止以后重复发现） |
| C 生产码没人用、但测试或文档点名 | 145 | 逐格看过抽样：`utils/designGuards.ts` 那一族（20+ 条）本来就是**测试面 API**（护栏用例的入口），`avatarSeed`/`avatarImage`/`color`/`chatSearchQuery` 那几条是"策略常量由测试对账"的同一套做法 ⇒ 全部**合法保留** |

**结论：这一轴没有可收的成果。** 之前几轮把重复实现收进家（`singleFlight`、`blobLru`、`time`、`textLimits`、
`platform`）已经把"导出了但没人用"这一族顺手清掉了；剩下 A 那 2 格在 dev 脚本里、B 那一族纯机械无收益。

顺带留下两条口径：

- **"某类东西还有多少"这种话必须先数** —— 本批如果不是先跑脚本，很可能又写一条"再收一轮死代码"的空转工单。
- **筛选脚本报的"缺对偶/零引用"只是"去读它"**，不是结论：A 桶那 2 格和 C 桶那 145 格在脚本里长得一样，
  差别要靠读代码（测试面 API vs 真死码）才能分开。

### §6.55 「至少隔 N 毫秒才放行」这一族有五份手写实现，并成一个家（2026-10-20）

**先数再动手**：把全仓形状像 `now - last < N` 的地方一次数完（13 处），逐格读语义后分成两类。

*真的限流闸*（"太早就别提第二次"）：`defer.ts` 的 `shouldRunThrottled`（家本身）、
`windowLaunch.ts`（已经在走家）、**`useChatStore` 的抖动 —— 同一个 `lastShakeAt` 上的两份逐字复制**
（移动端 CSS 抖一份、桌面搬 OS 窗口一份）、群历史分页进度重查（裸 `1500`）、
草稿已满提示（`FULL_WARN_INTERVAL_MS`）。

*形状像但语义相反*（要的是"最近 N 毫秒**之内**"或"超过 N 就过期"，套上那个家会把意思写反）：
`ime.ts` 输入法组合窗口、`TitleBar.vue` 双击标题栏检测、`VirtualList.vue` "最近往上滚过 ⇒ 暂停贴底"、
`messages.ts` 在线状态 TTL 清扫、`todos.ts` 完成满 N 天归档、`AddFriendModal.vue` 的冷却置灰
（它只决定按钮灰不灰与文案，解除由定时器负责，不认领额度）⇒ **全部保留并逐格写明理由**。
另有两处在数之内但属于另一件事（消息时间分割线按 `ts` 差算，不碰墙上时钟）。

**改法**：抖动那两份合成一个 `claimShakeSlot()`（判据走家、`lastShakeAt` 仍只有一份 ⇒
"CSS 抖与桌面搬窗口共用同一份预算"这个不变量第一次只有一个定义处）；另两处直接改走
`shouldRunThrottled`；裸 `1500` 提成 `HISTORY_RELOAD_MIN_INTERVAL_MS`。

**新判据**（`defer.test.ts`，第 12 条）：现扫 `src/**` 生产码的时间差比较，剥注释后
必须**全部**落在白名单里；四条已知写法作正控（matcher 认不出就红，防止"0 处"是空扫）、
分母下限（认出的比白名单还少 ⇒ 判据自己坏了）、反向还要"至少 3 份生产文件真在用那个家"
（否则"没有第二份"会因为大家压根没做这件事而成立）。

**变异**：在 `src/utils/appActions.ts` 故意手写一道闸门 ⇒ 该条当场红并点名文件
（`这些文件手写了「至少隔 N 才放行」的闸门，该改走 shouldRunThrottled：utils/appActions.ts`），
`diff -q` 核对复原。

**⚠️ 本批自己撞的坑，值得单独留一行**：批量补丁用 python 脚本改，脚本中途抛了
`TypeError`（`str.replace` 少传一个参数），**前半的替换只在内存里、根本没落盘** ⇒
`MessageComposer.vue` 变成"调用了函数却没有 import"。`npm test` **1086/1086 全绿**
（`node --test` 不做 `.vue` 类型检查），是 `npm run verify` 第 17 步 `vue-tsc` 报
`Cannot find name 'shouldRunThrottled'` 才抓住。两条口径：① 脚本式补丁**每一处替换都要单独
assert 并立刻落盘**，不要把多个替换攒到最后一次 `save`；② 改完必跑类型检查 ——
快速层那一步在本仓不是仪式，它是唯一能看见 `.vue` 类型断裂的判据。

**读数**：`npm test` **1086/1086**（本批 +1 条）、`npm run verify` **17/17、20.6s exit 0**
（含 vue-tsc 与构建）、**收尾全量 CDP 探针 434/434、exit 0**（40 段，跑的是本批之后的树 ——
§6.53 结尾预测的那个"下次全量应是 434"由此从预测变成实测）。

### §6.56 搜索的日期筛选把"一天"当成 86 400 000 毫秒 —— 夏令时地区差一小时（2026-10-20，P1 真缺陷）

**发现方式**：不是照着清单找的，是数"字节格式化 / 日期格式化还有没有第二份"时顺手撞上的。
那一轴本身是干净的（`utils/format.ts` 12 行一个家、6 本组件都调它；`utils/time.ts` 一个家），
但读 `utils/chatSearch.ts` 的 `dateRangeFor` 时看到它自己算"本地零点"和"N 天前"。

**缺陷**：`startOfToday = new Date(y, m, d).getTime()` 之后用 `startOfToday - N × 86_400_000` 求"昨天 / 近 7 天 / 近 30 天"。
在实行夏令时的时区里"一天"不是常数：回拨日 25 小时、拨前日 23 小时 ⇒ 切换日的**次日**往前推 24 小时
落不到那一天的零点。本机（中国无夏令时）永远复现不了，所以这条从写下那天起就一直错着。

**实测读数**（`/tmp/dst-discriminate.mjs`，`TZ=America/New_York`）：今天取 2026-11-02（前一天是回拨日）时
`yesterday`/`week`/`month` 的起点全部落在 **01:00**（各差 **+3 600 000 ms**）；
今天取 2026-03-09（前一天是 23 小时的拨前日）时 `yesterday` 起点落在前一天 **23:00**（差 **−3 600 000 ms**）。
⇒ 用户可见的后果有两面：回拨日"昨天"少一小时（那天的头一小时筛不出来），拨前日"昨天"多一小时
（把前天深夜的消息算进昨天）。而回拨日那一小时**实际出现过两次**（00:30 EDT 与 00:30 EST），
所以那半天里"昨天"与"今天"的分界对用户是含混的。

**更值得记的一笔**：同一份"昨天"在本仓有**两种算法**。`utils/time.ts` 的会话列表标签用的是
`dayjs().subtract(1, "day")`（日历法，对的），`chatSearch.ts` 用的是固定毫秒减法（错的）⇒
列表上标着「昨天」的那条消息，在搜索里选「昨天」有可能筛不到。这是目标 C 档说的"同一份数据两种口径"，
只不过口径不是状态源而是**算法**。

**改法**：`dayjs(now).startOf("day").subtract(N, "day")`。库已装、已是本仓日期的家 ⇒ 不加新依赖、不套新包装。
文件 105 → 113 行：`DAY` 常数与手写的"年/月/日拆零点"被库调用替掉（代码行 7 删 7 增，持平），
增的 8 行里 7 行是那条时区陷阱注释。`todos.ts` 的"完成满 N 天归档"与 `logFilter.ts` 的
环形秒差（`min(d, 86400-d)`，判的是**钟面时刻**不是日历天）**不改**：两者语义都不是"日历日"，
套上日历法反而写错。全仓再扫 `setHours(` / `getDay()` / `Math.floor(…86` / `toDateString()`
⇒ **零命中**，这一族只有这一个成员。

**测试**（`chatSearch.test.ts` 4 → **5 条**）：新增"夏令时切换日的次日：日期预设起点仍是本地零点"，
四条边界各一条断言 + 一条语言无关的**正控**（`getTimezoneOffset()` 必须是 300，否则整段读数无效）+
一条"今天"对照。**跑序是先红后绿**：改实现之前跑，当场红并打印 `差 3600000 ms`；改后 5/5。
测试里把 `process.env.TZ` 设成 `America/New_York` 又还原（`finally`，原来没有就 `delete`）——
本机 Node 支持运行时改时区（实测 `before -480 after 300`）。
顺手把**老那条**用例的期望值从"零点减 N 天毫秒"改写成"本地日历日"（`new Date(2026, 8, 11, 0, 0, 0)`）：
写成减法等于把实现的算法抄进测试，换时区或换实现会一起错。

**Rust 侧同族也数完**（`grep -rn "86_400\|86400" src-tauri/src` = 12 命中，逐格读）：只有 `export.rs::format_local_time` 对夏令时敏感，而它的头注释**早已写明**这一点（时区偏移由前端一次性给出 ⇒ 跨切换日的历史行可能差一小时，对"把文字抢救出来"的导出可以接受）⇒ 那是已声明的取舍，不是本轮该改的缺陷；`logging.rs` 两处明写 UTC、`relay.rs:71` 是**协议日 key**（动它等于改线上语义，按 §七.8 不许顺手）、`cache_cleaner.rs`/`offline_queue.rs` 是保留时长。⇒ 这一族在前后端都数完，无待修项。

**读数**：单测文件 5/5；`npm test` **1086 → 1087/1087**；快速层 **17/17、26.5s exit 0**（含 vue-tsc 与构建）；
探针 `search` 段 **18/18**（改的是那个界面的筛选）。**NOT RUN**：真机在夏令时地区点一次"昨天"没有做
（本机不在该时区，且这条已由算法读数钉住）；Windows / Android / iOS 照旧欠。

### §6.57 「类型逃生口 + 兼容层」这一族数完了：无待删项，也**故意不加判据**（2026-10-20，无码改动）

目标 P3 那句「删除死代码、无用导出、重复工具函数和旧实现」之外还有一句
「**只为绕过问题而存在的兼容层**」。前两批把死代码（§6.54）与无用导出数完了，这一批把这一格数完。
现算口径：剥注释后扫 `src/**` 生产码（`.ts`/`.vue`，排除 `*.test.ts`），脚本 `/tmp/escape-scan.mjs` + `/tmp/shim-scan.mjs`。

**读数（全部分母现算，复跑即得同一份）**

| 形状 | 命中 | 逐格读完之后的判定 |
|---|---|---|
| `@ts-ignore` / `@ts-expect-error` / `eslint-disable` | **0 / 0 / 0** | 干净 |
| `as any` | 2 | 都在 `VirtualList.vue` 的 `:key` 兜底（`msg_id ?? id ?? index`，跨消息与任务两种行）—— 键兜底是渲染层需求，不是类型问题 |
| `as unknown as` | 2 | `peerMerge.ts` 把两种对端记录当 `Record<string, unknown>` 比字段；是"通用合并算法要吃一个开放形状"，注释已写明 |
| 非空断言 `x!.y` | 6 | `ChatWindow.vue` 5 处全部由上一行 `if (!conv.value …) return` 把住（`!` 是因为要**跨进回调**再读那个 computed，TS 的窄化带不进去）；`MessageItem.vue` 2 处（`getContext("2d")!`、`toBlob((b) => resolve(b!))`）在 `copyImage` 的 `try` 里 ⇒ 真返回 null 时走 `catch` 弹「复制图片失败」。⇒ **没有一处能抛到界面外** |
| `legacy` / `compat` / `shim` | 9 行（非注释） | `useClipboard` 的 `{ legacy: true }` 是 VueUse 给老 WebView 的官方开关；`i18n` 的 `legacy: false` 是 composition mode 的正确写法；`LEGACY_DARK_STORAGE_KEY` 是**读一次 + 立刻 `removeItem`** 的迁移形状（不是常驻兜底）⇒ 三处都不是债 |
| `typeof X === "undefined"` 兜底 | 7 | 全是 `node --test` 直接 import 这些 utils 时没有 `window/localStorage/navigator` 的环境嗅探 ⇒ 结构性必要（同一族的另一种写法是调用方注入，见 `time.ts` 的 `Translate` 参数） |
| `TODO` / `FIXME` / `HACK` / `@deprecated` | **0 / 0 / 0 / 0** | 没有欠账标记 |

**为什么这一批"数完就完了"，不给它加一条判据**：本仓记过的口径是**先分响亮失败还是静默失败** ——
往生产码里新加一个 `foo!.bar` 而那个 `foo` 真为 null 时，浏览器当场抛 `TypeError`、面板白掉，是**响亮**的失败；
`as any` 新长一处也一样（ vue-tsc 看不见它，但它自己会在运行时出事）。
一条"不许超过 6 处非空断言"的棘轮只能拦住一个会自己喊出来的问题，却会长期拦住合法写法 ⇒ **不写**。
（对照 §6.55 那条为什么该写：那里漏掉一个 `shouldRunThrottled` 调用点没有任何东西会喊。）

**留下一条可复用的判读口径**：兼容层要不要删，看它**是不是"读一次就删键"** ——
`LEGACY_DARK_STORAGE_KEY` 是（`appearance.ts` 读、`useAppStore` 立刻 `removeItem`），所以它是迁移；
判断条件是形状，不是年龄。常驻兜底（每次读都走一遍 legacy 分支）才是债。

**读数**：应用码一字未动 ⇒ `npm test` 只作回归确认（这一批跑在同一棵树上：见 §6.56 那段的 1087/1087 与快速层 17/17）。
复跑：`node /tmp/escape-scan.mjs`、`node /tmp/shim-scan.mjs`。

### §6.58 A 档「浮层 / 提示」的剩余存量数完了：不迁 Reka Tooltip，理由是**原生 title 不是自研轮子**（2026-10-20，无码改动）

目标 A 档那段点名了 Tooltip/Popover/Dropdown，并说"避免自己维护焦点管理、键盘导航、无障碍、浮层定位、
点击外部关闭、滚动锁定和移动端手势"。前面几批已经把三处锚定浮层换成 Reka HoverCard/Popover，
这一批把这一档**剩下的存量**数完，给每格一个结论 —— 因为清单要能回答"为什么这里还是没用库"。

**现算读数**（`/tmp/overlay-scan.mjs` + `/tmp/title-a11y2.mjs`，扫 `src/**/*.vue`）

| 形状 | 读数 | 结论 |
|---|---|---|
| Reka `Popover*` / `HoverCard*` | 8 处 / 4 本（`MessageItem`、`MessageComposer`、`MessageReactionBar`、`MessageReceipt`） | 已交给库的那些**只有**触发/内容/摆位是库的，业务内容仍是本仓的 ⇒ 组合替换 |
| Reka `Tooltip*` | **0** | 见下面三条理由，判定为**不该用** |
| 原生 `title=`（含组件 props 那类） | 273 行 / 62 本；其中**元素级** 195 处 | 保留 —— 这是平台能力 |
| 手搓悬停浮层（`@mouseenter` + 绝对定位） | **1**（`MessageReactionBar.vue:217`，触摸/无 hover 时的 reveal 路径，`role="tooltip"` 在同一本 238 行） | §6.51–§6.53 已逐格判过（450ms + 位移 + 两个冗余取消出口），保留 |
| 手搓 `z-index: 9xxx` / `z-[9xxx]` | **0** | 没有第四种摆位体系 |

**为什么不把 195 处原生 title 换成 Reka Tooltip**（这是清单里必须写清的那类"不为库的数量引依赖"）：

1. **原生 `title` 不是自研轮子，是平台轮子。** 目标要的是"别重复造库已有的通用功能"，
   而摆位、延迟、跟随光标、聚焦显示这些浏览器已经做好了、且不占本仓一行 JS。
2. 换过去要**每处包一对 Trigger/Content 再加 Provider**，浮层的显示时长与动画反过来变成要本仓定的东西；
   而触摸端上原生 `title` 本来就不显示，Reka 的 tooltip 也不会自动因此在手机上变好 ——
   那 195 处里真正的移动端答案仍是"内容本身可见 / 长按菜单"。
3. **可访问名已经由 `aria-label` 或元素内容承担**（现算：195 处里"既没 aria-label、元素内又没可读内容"的
   = **0 处**）。这条轴原本可能存在的真缺陷是"图标按钮只有一个 `title`、屏幕阅读器读不出来"，
   数完证明本仓没有这一型。

**⚠️ 本批最大的收获其实是量具，不是结论**：第一版判据按**行**匹配，报"171 处缺可访问名" ——
差 171。原因是模板里属性经常换行、可见内容经常排在开始标签的下一行，按行读必然把它们看成空元素。
改成按**起始标签整块属性**解析后 = 1 处，而那 1 处是 `v-html`（内容在解析期是空的，但 AT 读得到）
⇒ 真缺口 **0**。这是"解析期看不见内容"的第三个已知形状（前两个：`git grep` 行式把跨行调用数成 0、
`include!` 拆册让锚点不再唯一），**模板类判据一律按元素解析，不按行**。

**读数**：应用码一字未动 ⇒ 无新验证需要跑（`npm test` 1087/1087、快速层 17/17 是同一棵树的 §6.56 读数）。
**§6.55–§6.58 四批的收尾全量 CDP 探针：434/434、exit 0（40 段，跑的是 §6.58 之后的树）** —— 这三批只有 §6.56 动了应用码，探针条数与 §6.55 那次相同（没有新增判据）。
复跑：`node /tmp/overlay-scan.mjs`、`node /tmp/title-a11y2.mjs`。

### §6.59 「注册↔卸载」这一族有四个家：把 8 处 Tauri 订阅并回 `initScope`，顺手补上三处漏掉的竞态（2026-10-20，P0/P1）

**先数再动手**：E 档那句"事件订阅、监听器清理"此前只数过 DOM 监听（§6.43，19 处逐格读）。
**Tauri 侧的 `listen()` 是另一套 API、另一套清理义务**，本批第一次数它：现算 8 处订阅、5 本组件，
外加 store 里已有的两家。逐格读完后分成三种质量：

| 位置 | 订阅 | 卸载写法 | 判定 |
|---|---|---|---|
| `TitleBar.vue` | `onFocusChanged` + `onResized` | `unlistenX = await …` ＋ `onBeforeUnmount` 里 `unlistenX?.()` | **缺守卫**：赋值发生在清理之后 ⇒ 取消函数永远没人调用 |
| `GroupTasksBoard.vue` | `onDragDropEvent`（草稿开关联动，非挂载周期） | 同一个形状 | **缺守卫**，而且后果可见：留下的 handler 会继续翻 `app.boardDropActive`，而 `ChatWindow.canDropInto()` 正是读它决定"拖进来的文件算任务还是算聊天附件" |
| `ChatWindow.vue` | `onDragDropEvent` | 手写 `dragDropDisposed` 标志 | 有守卫，但是**第二份**实现 |
| `GroupTodosWindow.vue` | 定向事件 + `onFocusChanged` | 手写 `disposed` 标志 | 第三份 |
| `PreviewWindow.vue` | `onImagePreviewChanged` + `onCloseRequested` | 手写 `disposed` 标志 | 第四份 |

**家早就存在**：`utils/initScope.ts`（43 行）的头注释写的就是这一族 —— "拿到卸载函数要等一次 IPC 往返，
若这段时间里本轮已被拆掉，把卸载函数攒进一个已经 dispose 的列表等于永远没人调用它 ⇒ 拆过之后的注册就地执行"。
`GroupFilesPanel`、两个 store 已经在用它。⇒ 本轮不加任何东西，只把剩下 8 处并回去、把 3 份手写实现删掉。

**改法与形状**：注册侧一律 `scope.onDispose(await …)`（迟到就在就地取消），清理侧一律 `scope.dispose()`；
`GroupTasksBoard` 因为订阅随草稿开关起伏，改成"每轮一个 scope"（`dropScope`），异常分支里把 scope 清空，
否则一次注册失败会把后续所有轮次锁死。净变化：**5 份组件码 −83 / +67 行（−16）**，手写守卫从 3 份变 0 份。

**⚠️ 一条判据被本轮"合法地"打破，处理方式值得单写**：`titleBarIcons.test.ts` 里
「最大化/全屏状态必须订阅窗口尺寸变化」那条，是用**正则贴旧形状**（`onBeforeUnmount…unlistenResize?.()…`）
实现的 —— 迁移后形状变了，它当场红。这里**没有**"为了通过而放宽"：改成两条更严的
（① `onResized` 的卸载函数必须登记进 `listenerScope`；② `onBeforeUnmount` 必须 `dispose()`），
并且**分别用单点变异证各自能红**：只删 `dispose()` ⇒ 第②条红；把注册退回裸赋值 ⇒ 第①条红；
`diff -q` 核对复原后 7/7。旧那条判据其实**默许了一个真实缺陷**（它只查"有没有写退订那一行"，
查不到"退订那一行可能跑在赋值之前"）⇒ 贴形状的判据在形状变化时红是好事，趁机把它换成贴语义的。

**新判据**（`designGuards.test.ts` ㊷，跟着 §6.43 那条 DOM 监听守卫排在一起）：现扫全部生产码
（剥注释、跳过 `initScope.ts` 自己），两种形状一律红 —— ① `let unlistenX: (() => void)` 手工句柄；
② `if (disposed) fn()` 手写迟到守卫。三条已知形状做 matcher 正控（含花括号版），
反向还要"至少 6 份生产文件真在用 `createInitScope(`"（否则"没有手工句柄"可能只是因为大家不订阅了）。
**非空转实测**：往 `GroupTasksBoard` 塞回一行 `let unlistenProbe: (() => void) | null = null;`
⇒ 该条红并打印 `src/components/GroupTasksBoard.vue: 手工 unlisten 句柄`，`diff -q` 复原后 155/155。
为什么这种失败值得钉：监听泄漏**不响亮** —— 界面照常，只有偶发的重复回调/错误的拖放归属会冒出来。

**读数**：`npm test` **1087 → 1088/1088**（+1 条判据）；快速层 **17/17、21.9s exit 0**（含 vue-tsc 与构建）；
探针 `search` 段本批不需要（未动搜索码）；四道文档门 + change-budget 各 exit 0。收尾全量探针实测 **434/434、exit 0**（40 段，跑的是本批之后的树，日志 `/tmp/probe-659.log`）。
**NOT RUN（如实记）**：真实拖放（桌面往任务草稿图片区拖文件、同时快速开关草稿）与真实"秒关辅助窗"
都没有做机器验证 —— 前者需要真鼠标拖放，后者需要在窗口被关掉的同一瞬间赶上 IPC 往返；
本轮对这两格只有静态判据 + 形状一致性的证据。

### §6.60 判据 ㊷ 自己漏了两类形状：mitt 订阅与「一批句柄存成数组」（2026-10-20，P1）

§6.59 把 8 处 Tauri 订阅并回 `utils/initScope` 后，那条新判据 ㊷ 的句柄 matcher 写成了
`let unlisten[A-Za-z0-9_]*: (() => void)` —— 也就是**按变量名前缀 + 单一函数类型**认句柄。
本轮按这两处漏重新数一遍，抓到两份此前判据看不见的手抄守卫：

| 站点 | 旧形状 | 为什么判据没抓到 |
|---|---|---|
| `components/ConversationList.vue:166-173` | 1 条 mitt `onAction(focusSearch)` 存进 `let disposeFocusSearch: (() => void) \| null`，`onUnmounted` 里手工调 + 置 null | 句柄名不叫 `unlisten*` |
| `layouts/ResponsiveLayout.vue:403 / 420-437` | 4 条 mitt `onAction` 存进 `let disposeAppActions: (() => void)[]`；菜单那 4 条 `listen()` 存进 `let unlistenMenu: UnlistenFn[] \| null` | 类型是**数组**、`UnlistenFn` 别名，matcher 只认单函数写法 |

**`ResponsiveLayout` 那半正是 §6.59 描述的「迟到的注册」本人**：`void bindMenuEvents().then((fns) => (unlistenMenu = fns))`
要等 4 次 IPC 往返，往返途中被拆 ⇒ `onUnmounted` 读到的一直是 `null`，那 4 条原生菜单监听永久留在窗口上，
每次菜单动作多 emit 一份。⚠️ **但这条现网看不见**：`App.vue` 模板里 `<ResponsiveLayout />` 没有 `v-if`
（只有 `LogViewer`/`SettingsWindow` 那些兄弟页有），所以今天能触发重挂的是 HMR 与分支切换，不是用户点出来的。
判语因此写成"形状不合家 + 迟到竞态未接住"，不写"用户报的现象"。

改动：两处都换 `createInitScope()`（mitt 那半同步返回、菜单那半在 `.then()` 里逐条 `onDispose(fn)`，
拆过之后就地取消）；`ResponsiveLayout` 顺带删掉 `import type { UnlistenFn }`（唯一消费者没了）。
`ConversationList` 的订阅从 `onMounted` 挪进 setup —— mitt 是同步的，而本组件在桌面切「链接」视图时
确实被 `v-else` 拆挂（`ResponsiveLayout.vue:533-535`），换成 scope 后少一对生命周期钩子。

**判据加宽的过程里最重要的一条是量具别过界**：把 matcher 改成"只认类型形状"（任何 `let X: (() => void) | null`）
当场红了两处 —— `composables/useBackLayer.ts:76` 的 `let release` 与 `stores/useChatStore.ts:1572` 的
`let groupTodosUnlisten`。读实现后判定**这两处不是同一族**：它们是"同一个句柄反复换人"（压/退一层历史条目、
切群时先摘旧再订新），`useChatStore` 那处的迟到竞态由 `StaleGuard`（1579 行 `new StaleGuard()`）裁决（1610-1614
显式"更晚那次已开始 ⇒ 本次结果整个丢弃并立刻摘掉"）。`initScope` 管的是"注册一次、拆卸时取消"，家不是同一个
⇒ 判据收回类型形状那半边，改认 **① 名字以 `dispose|unlisten|cancel|teardown|cleanup` 开头 + 句柄类型**
**② 类型是 `UnlistenFn`（含 `UnlistenFn[]` / `Array<UnlistenFn>`）**，并把这两处滚动句柄**写成反控**
（matcher 误判 ⇒ 测试当场红）。留下已知的覆盖边界：`let removal: (() => void) | null` 这类
"名字不在关键字集里、类型又不是 `UnlistenFn`"的手工句柄仍会漏 —— 再往上半步就要开始误伤滚动句柄，
这一格按"判据只认这两个信号"写明，不假装全覆盖。

同轮把这一族的另外两条轴数完（都不改码）：
- **非 `.vue` 生产码的 DOM 监听**：12 处（`useAppStore` 4 对成对 remove / `useChatStore` 1 对进 scope /
  `useShortcuts` `onMounted`+`onBeforeUnmount` 成对 / `boot.ts` 3 处、`i18n/index.ts` 1 处、`useBackLayer.ts` 1 处
  为模块级一次性 install）。⇒ **实测 0 泄漏，故意不加判据**：`.vue` 那条"不许内联处理器"的依据是
  "组件重挂会累积、每份闭包绑上一轮 state"，而 `install()` + `installed` 闸门结构性不累积，把同一条禁令
  扩到 `.ts` 只会拦合法写法。
- **丢弃订阅返回值的形状**（`void onAction(` / 裸 `listen(` 当语句）：生产码 0 处 —— `api/index.ts` 那 7 处
  是把句柄交给调用方的 API 壳（`bindMenuEvents` 返回 `Promise<UnlistenFn[]>`），`useChatStore.ts:2797` 在
  `.then()` 里落进 scope。本轮没有观察到的失败形状 ⇒ 不加判据（§6.57 那条"量具不该管响亮之外的事"同一口径）。

**读数**：`npm test` **1088/1088**（判据条数不变，㊷ 是加宽不是新增）；快速层 **17/17、21.9s exit 0**；
`designGuards` 单册 **155/155**；**两次单点变异各点名自己的文件**（ConversationList 塞回 `let disposeFocusSearch`
⇒ `src/components/ConversationList.vue: 手工卸载句柄`；ResponsiveLayout 塞回 `let unlistenMenu: UnlistenFn[] | null`
⇒ 同名红并指到那份文件），各自 `diff -q` 复原后复绿；反向判据下限 6 → **8**（实测消费者 10 份生产文件）；
组件码净 **−4 行**（`ConversationList` −2、`ResponsiveLayout` −2）。收尾全量探针实测 **434/434、exit 0**（40 段，跑的是本批之后的树，日志 `/tmp/probe-660.log`）。
**NOT RUN**：macOS 原生菜单四次点击在"布局被重挂过之后"只执行一遍这件事没有运行时证据
（现网触发不了重挂，机器上造这一发要改 `App.vue` 的挂载条件，属为验证而改产品码）。

### §6.61 「等一会儿」与「等这一拍」：自研 sleep 并一家、`setTimeout(fn, 0)` 换回 `nextTick`（2026-10-20，P1）

接着 §6.60 的定时器轴（`window.setTimeout`/`setInterval` 生产码共 **34 处**，扫描器 `/tmp/timer-scan.mjs`）
往下数两件"重复的通用能力"。分母是现扫的，不是印象：

**① 自研 `sleep` 有 2 份。** `MergeCardModal.vue:120-122` 自带一个私有 `function sleep(ms)`，
`useAppStore.ts:423` 的蓝牙自动开重试则是内联的一份 `await new Promise((r) => setTimeout(r, 2000))`。
先按目标第五阶段核对库：**`@vueuse/core@14.4.0` 与 `@vueuse/shared` 的 `dist/index.d.ts` 里 grep `sleep` 各 0 命中**
⇒ 库里没有对应物可换（不许为了"多用一个库"再造一层包装），所以这一格判**保留自研但收进一个家**：
`utils/defer.ts`（本仓既有的时间语义家）加 `sleep(ms)`，两份手抄都改成调用它。
顺手把同轴的另一半分开数：`setInterval` 生产码 0 处没有 `clearInterval` 的；`App.vue:116`（预热延后一拍）、
`boot.ts:106/112`（骨架淡出 + 兜底拆除）都是**故意不等卸载**的一次性定时，不动。

**② `setTimeout(fn, 0)` 当「等这一拍」用有 3 处，其中 2 处是重造 `nextTick`。**
`StorageSection.vue:64/102` 用它来"等 watch 跳过这一轮由回显赋值触发的回调"—— 这就是 Vue 的
`nextTick()` 语义（本次视图更新周期结束），而全仓已有 **10 份文件**在用 `nextTick`（现扫 `[C]`）
⇒ 换成 `await nextTick()` / `void nextTick(() => …)`，那个 `0` 一起消失。
第三处 `useChatStore.ts:684 setTimeout(flushNow, 0)` **不迁**：它要的不是"视图更新完"，
而是"等这批同步写入都进队列再一次性冲刷"，那是**宏任务边界**（microtask 的 `nextTick` 兜不住），
按 §6.55 那条口径属于"形状像、语义不是同一件事"，判保留并写明。

**判据**（`defer.test.ts` 12 → **14 条**）：
- 行为层：`sleep(500)` 在假定时器下 499ms 不许醒、到点必须醒（复用本文件已有的 `withFakeTimers`）。
  非空转：把 `sleep` 改成 `return Promise.resolve()` ⇒ 当场红 `499ms 就 resolve ⇒ 重试间隔实际短了一档`。
- 绑定层：现扫生产码里手抄的 `new Promise(… setTimeout …)` = 0，带**两条正控**（就是本轮删掉的私有
  helper 与内联写法，matcher 认不出 ⇒ 下面的 0 不作数），外加**反向钉**：那个家必须真被 ≥2 份生产文件用起来。
  非空转：往 `MergeCardModal` 塞回一份 `sleepLocal` ⇒ 红并点名 `components/message/MergeCardModal.vue`。

**读数**：`npm test` **1088 → 1090/1090**、快速层 **17/17、20.1s exit 0**（含 vue-tsc 与构建）；
两次单点变异各自能红、`diff -q` 复原后 14/14；改动落在 5 份文件
（`utils/defer.ts` 加 `sleep`、`utils/defer.test.ts` 加两条用例、`MergeCardModal` 删私有 helper 并 import、
`useAppStore` 内联换调用、`StorageSection` 两处换 `nextTick`）。收尾全量探针实测 **434/434、exit 0**（40 段，跑的是本批之后的树，日志 `/tmp/probe-661.log`）。
**NOT RUN**：「回显不再触发自动落库确认弹窗」这一格只有静态与语义证据 —— 它要真机在设置页把
缓存保留天数从"永久"改成"7 天"再改回来，看确认弹窗不该出现的时机是否仍然不出现；`nextTick` 比
`setTimeout(…,0)` 更早一拍，这一拍差没有机器凭据，留给真机（已在待办点名）。

### §6.62 「15 MiB 单条预览上限」被抄了六份（前端三份 + Rust 三处），而那句"与后端同一口径"没有凭据（2026-10-20，P1）

§6.61 之后接着数同一族的时间/字节轴，扫到 `15 * 1024 * 1024` 这个字面量在生产码里的全部落点：

| 侧 | 落点 | 用途 |
|---|---|---|
| 前端 | `utils/filePreview.ts:74`、`utils/favoritePreview.ts:26`、`components/message/MergeCardModal.vue:41` | ①`blobLru.maxEntryBytes`（单条上限）②③喂给 `api.readContentPreview` / `readFavoritePreview` 的 `max_bytes` |
| Rust | `commands/helpers.rs:246`、`commands/favorites.rs:246`、`favorites.rs:314` | 三处 `let max_bytes = max_bytes.min(15 * 1024 * 1024);` 的**服务端钳制** |

`filePreview.ts` 的注释写着「与后端 `read_file_preview` 同一口径」，但**这句话此前没有任何机器判据**：改任何一侧都不会红，而它坏起来的形状是安静的 —— 前端把上限调到 20 MiB、后端仍按 15 MiB 截，用户看到的是"这张图点开永远少一截/预览失败"，而不是异常。这一族与 §6.39（`maxlength` 手抄 + TS↔Rust 数值对账）同型，只是当时只办了文本长度那一维。

改动（**只动前端**）：`utils/filePreview.ts` 导出 `IMAGE_PREVIEW_MAX_BYTES` 一个家，`favoritePreview.ts` 与 `MergeCardModal.vue` 改成 import（删两份手抄）；`utils/blobLru.ts` 注释里的旧名跟着改，不留说谎的引用。Rust 侧那三处**本批不收家常量**：那要动 `src-tauri/**`（cargo 门禁 + 档位 + 版本清单），且三条各自在 `spawn_blocking` 闭包里，收家常量会新造一个跨命令模块的公共导出面 —— 同值这件事已经由判据钉住，合并留给后端那条线按它自己的节奏做。顺带把 `StorageSection.vue:62/109` 全仓唯一的裸 `1048576` 改成 `(1024 * 1024)`（与仓内其余 MiB 写法一致，不新增导出）。

**判据**（`imageBytes.test.ts` 8 → **9 条**，这条文件已在 `package.json` 的测试清单里，不需登记）：两侧都**从源码现读现算**再比数值 —— TS 侧正则读 `export const IMAGE_PREVIEW_MAX_BYTES = …` 的乘法表达式，Rust 侧正则读 `.min(N * 1024 * 1024)`。
两边都不 import：`filePreview.ts` 要 `@/api`，`node --test` 解析不了 `@/` 别名（这条约束在 `appActions.ts` 头注释里写着），所以判据只能当**文本量具**用。零件齐：Rust 命中数下限 3（分母掉了 ⇒ 先报错而不是让相等断言空过）、matcher 两条已知形状做正控、前端剥注释后 `15*1024*1024` 只许出现在那个家。

**三发单点变异，各红各的那一条**：Rust 改 `16 * 1024 * 1024` ⇒ `后端钳制与前端上限不再同值：TS 15728640 vs Rust 16777216`；前端塞回一份手抄 ⇒ `单条预览上限被各抄一份…：./favoritePreview.ts ×1`；Rust 两处改写成 `15_728_640`（matcher 不认的合法写法）⇒ `Rust 侧只认出 1 处…（实测 3）⇒ 分母掉了，下面的相等断言没有意义`。三处 `diff -q` 复原后 9/9。

**一次环境事件（如实记，不改）**：第一次 `npm run verify` 在第 5 步 **db 锁作用域守卫** 处以
`ENOENT: stat src-tauri/src/logging.rs.tmp.37241.1792430404487` 失败 —— 那是并行会话原子写留下的临时文件在同一次目录扫描中途消失。同一命令复跑 **17/17、19.7s exit 0**。
根因是那条守卫对"扫到又消失的文件"没有 `ENOENT` 容错，属今晚 J2 那条线新加的工具，本批**不动它**（不覆盖并行会话的工作），只把复现条件记在这里。

**读数**：`npm test` **1090 → 1091/1091**、`node --test src/utils/imageBytes.test.ts` **9/9**、快速层 **17/17、19.7s exit 0**（含 vue-tsc 与构建）。收尾全量探针 `npm run test:ui-runtime` **434/434 条判据绿、exit 0**（2026-10-20 现跑，日志 `/tmp/probe-662b.log`）。
**第二次环境事件（同样如实记，不改）**：这次收尾探针的**第一次**尝试读到 `✗ 82/86`、退码 1，4 条红全在 `files` 段（`预期 calls=[g1]/g1.bin / 实际 {"calls":[],"files":[]}` 与 `TypeError: window.__gf.emit is not a function`），而同一棵工作树上单跑那一段 `node scripts/check-ui-runtime.mjs --only=files` 是 **10/10 exit 0**；`scripts/check-ui-runtime.mjs` 与 `GroupFilesPanel.vue` 当时都是并行会话的未提交 `M`。探针是**边跑边 `import('/src/…')`** 的（`check-ui-runtime.mjs:974/994` 那两处现读模块），所以并行写入方在同一次跑里改源码，后面几段拿到的就是另一份实现 —— 这与上面那次 `ENOENT` 是同一个根因的两种表现，不是本批判据坏了。**处置**：重跑取干净读数（就是上面那条 434/434），并在后续批次遵守「跑探针期间自己也不改 `src/**`」。
**NOT RUN**：真实"点开一张 15–20 MiB 的图"没有机器凭据 —— 要真机两侧同改才能观察钳制行为，本批只有静态同值与文本对账。

### §6.63 「跨文件同名同值常量」一次数完（205 份生产文件 / 151 个声明位点），落到实处的只有时间分割线那一格（2026-10-20，P1）

不是再挑一个数去抄，而是把这一族**整轴数完**：现扫 `src/**` 全部 `.ts`/`.vue` 生产文件（测试码与脚本另算），**205 份文件、151 个数值常量声明位点**，按「同名 + 同值 + 至少两份文件」分组 ⇒ **5 组**。逐组判：

| 组 | 位点 | 判定 |
|---|---|---|
| `bytes = new Uint8Array(raw)` ×5 | `filePreview.ts`×2、`favoritePreview.ts`、`MergeCardModal.vue`×2 | **误报** —— 是局部变量不是常量，我的扫描器只按「`const NAME = 表达式`」认，表达式里没有数字也算进来了（记在下面那条量具边界） |
| `LONG_PRESS_MS = 500` ×3 | `MessageItem`、`FriendListItem`、`ConversationListItem` | **已被 §6.51 判过** —— 那是「一个能力几种写法」，合并要先定哪个是真机拇指实测值；清单行 11② 挂着等读数 ⇒ 本批不重开 |
| `PRESS_MOVE_TOLERANCE = 10` ×2 | `FriendListItem`、`ConversationListItem` | 同上（同一格的两处） |
| `reloadToken = ref(0)` ×2 | `SettingsPanel`、`SettingsWindow` | **误报** —— 响应式状态不是常量 |
| `TIME_DIVIDER_GAP = 5 * 60 * 1000` ×2 | `useMessageDisplay.ts:11`、`messageHeight.ts:17` | **动手** —— 见下 |

这一格比其他几组更值得办，是因为它**正好躺在本仓自己写的契约怀里**：`messageHeight.ts` 与 `previewMetrics.ts` 两份头部都明写「VirtualList 按它排布、MessageItem 按它渲染，**两边必须来自同一套常量与同一个判断函数**，否则相邻消息会互相遮挡」，而同族的另外两格都有机器凭据 —— ㉞（图片高度只从 `previewMetrics` 取）与 ㊳（可见张数只引 `TODO_CARD_IMAGE_VISIBLE`）—— **只有时间分割线这一格既抄了两份、又没人管**。

而且抄的不只是数：两边各写一遍判定 `!prev || ts - prev.ts >= 阈值`。分割行自己占 32px（`messageHeight.TIME_DIVIDER`），所以这个布尔值同时决定渲染与估算；改一边**不会红任何测试**，坏起来的形状是「相邻消息互相遮挡」，且只在间隔恰好跨过阈值的那几条消息上出现 —— 是本仓最难复现的那一型。

**改动**：家 = `previewMetrics.TIME_DIVIDER_GAP` + `shouldShowTimeDivider(ts, prevTs)`（连判定一起收，不只收数字，与那条契约的字面意思对齐）；两处消费方改成调用。空值口径从 `!prev` 收成 `prevTs == null`，并把「不许写成 `!prevTs`」写在家的注释里（`ts === 0` 会被当成首条 ⇒ 少画一行也少估 32px）。两本消费方**净 0 行**，家 +20 行（其中 13 行是"为什么"）。顺带清掉两处说谎的注释：原话「时间行恒显示」与代码里的 5 分钟阈值互相矛盾，改成按实际规则写。

**登记但本批不动的一格**（数到了就得留痕）：`showNickname` 两边写法不同 —— 估算端 `isGroup && sender_id !== selfId && !isTipKind(kind)`，渲染端 `isGroup && !mine`，看着像漏了 `!isTipKind`。读实现确认**现状不遮挡**：`MessageItem.vue:1102` 的提示行是 `v-if="isTip"`、正文块是 `:1119` 的 `v-else`，昵称行在 `v-else` 里面，所以提示行结构上就不渲染昵称 ⇒ 估算端那条 `!isTipKind` 正是把这个结构事实翻译成数字。把它并成一个函数要动模板结构（或让渲染端多一层恒真判断），收益不抵风险 ⇒ 记为下一格候选，不动。

**判据 ㊸**（`designGuards.test.ts` 155 → **157 条**，+81 行）：两条信号 —— ①别处再写 `const TIME_DIVIDER_GAP` ⇒ 「又声明了一份阈值」；②两个 `.ts` 字段相减再和阈值比（`>=` 与 `>` 都认，换个比较符不许漏）⇒ 「自己写了一遍间隔比较」。**夹具正控 3 条**（就是本轮删掉的两种真写法 + `>` 变体）、**反控 4 条**（调用那个家 / `Date.now() - m.ts` / 只相减不比较 / 模板注释），越界的量具当场就能被抓出来。真实树那一半：现扫 **205 份生产文件、违规 0**、反向 `importers >= 2`（实测 2 份：渲染端 + 估算端）、家的两行形状（那两行各钉"值"和"空值口径"）。已知覆盖边界写在注释里：改名 + 换字面量（`const GAP = 3e5`）这一型看不见 —— 这条量的是形状，不是"值等于 300000"。

**三发单点变异，各红各的那一条**：估算端塞回本地 `const TIME_DIVIDER_GAP` ⇒ 点名 `messageHeight.ts: 又声明了一份阈值`；渲染端把调用换回 `message.value.ts - prev.value.ts >= 300000` ⇒ 点名 `useMessageDisplay.ts: 自己写了一遍间隔比较`；把家的 `prevTs == null` 改成 `!prevTs` ⇒ 真实树那一条红在家的形状断言上。三处 `diff -q` 复原后 157/157、exit 0。

**读数（本批）**：`node --test src/utils/designGuards.test.ts` **157/157、exit 0**；`npm test` **1091 → 1093 条，1091 通过、2 条红**；`npm run build`（vue-tsc + vite）**exit 0**；收尾全量探针 **434/434、exit 0**；`check-doc-citations` / `check-doc-numbers` / `check-scripts-parse` / `check-domain-deps` / `check-change-budget` 各 **exit 0**。

**这轮红的 2 条与 1 道门都不是本批的**（逐条钉归属，不背也不代修）：
- `mapContract.test.ts` 那 2 条点名 `get_log_diagnostics` / `export_diagnostics_bundle` —— 现算这两个名字**只存在于** `src/api/index.ts`、`src-tauri/src/lib.rs`、`src-tauri/src/commands/logs.rs` 三份并行会话的未提交 `M` 文件里，本批一行没碰。缺的是「登记进契约图 IPC 表」和「有调用方」这两件收尾，属那条诊断线自己的账。
- `check-test-manifest` **exit 1** 是 Rust 侧清单守卫，它此刻**编译不过**（`logging.rs` 的 `fold_diag_same_second` 等 19 条 `E0599`）⇒ 同样是并行会话在飞的那半；本批不动 `src-tauri/**`。
- 连带影响：`npm run verify` 在「前端测试」这步 fail-fast，**构建那一步因此没被跑到** ⇒ 本批的类型+构建证据改由 `npm run build` 直接取（上面那条 exit 0）。这就是记忆里「快速层的绿要现算、不能推」的又一格：**工作树里有别人的红时，"整层绿"这句话不成立**，只能说"我这几条绿"。
- 一处自己踩的量具坑（已改成正确形状再取数）：我第一版批跑脚本写成 `for s in …; do if [ -f scripts/$s.mjs ]; then …`，名字猜错的两条（`check-protocol-invariants`、`check-test-list`）**被静默跳过**而屏幕上什么都没发生 —— 与记忆里「用日志解析当门会静默 SKIP」同一型。改成先 `ls scripts` 取真名再逐条跑，才有上面那串 exit 码。

**NOT RUN**：「两条消息间隔恰好跨过 5 分钟时，渲染出的这一行 == 估高加的那 32px」没有机器凭据。探针里 `[data-time-divider]` 只有一处用途（`check-ui-runtime.mjs:4272`，§6.47 那条语言档判据），它挂的是**单条**消息、`prev` 为空 ⇒ 分割行恒出，测不到阈值本身。可补的一格是「挂两条带 ts 差值的消息 + 量矩形高」，本批没做，记在这里作为下一格候选。

### §6.64 昵称行那条规则要读三个文件才看得全 —— 把它并成一个函数，并把"量具决定家"这件事记下（2026-10-20，P1）

§6.63 数那一格时顺手量到的同族另一格，当时判「登记不动」（怕动模板结构），这批改了，因为读完了实现才确认它**不需要**动结构。

两边各写一套：**估算端** `messageHeight.ts` 是 `isGroup && sender_id !== selfId && !isTipKind(kind)`，**渲染端** `useMessageDisplay.ts` 是 `isGroup && !mine` —— 看着像渲染端漏了 `!isTipKind`。读到 `MessageItem.vue:1102` 才确认不是缺陷：提示行走 `v-if="isTip"`、正文块是 `:1119` 的 `v-else`，昵称行在正文块里 ⇒ 提示行**结构上**就不渲染昵称，估算端那条 `!isTipKind` 正是把这个结构事实翻译成 18px。所以这是**可读性/可定位性**问题而不是遮挡 bug：一条"有没有昵称行"的规则散在三个文件里，靠模板分支暗合 —— 谁哪天给提示行加个来源标注，两边就各走一半，而那正好是本仓反复踩的"相邻消息互相遮挡"的形状。

**改动**：家 = `messageKinds.shouldShowNickname({ isGroup, mine, kind })`（把「提示行没有昵称行」写进判定本身，模板那一层继续只管渲染分支）；两侧改调用。`mine` 由各侧**已有**的口径传入（渲染端比 `device.device_id`、估算端比 `ctx.selfId`）⇒ **不新增第三个 self-id 来源**，这是这条规则此前没有更早并掉的真实代价点。`MessageItem.vue` 一字未动（它是并行会话的在飞文件，而这次也确实不需要动它）。

**家为什么放在 `messageKinds` 而不是 §6.63 那个邻居 `previewMetrics`**：量具决定家。`previewMetrics` 要 `@/utils/chatStyle`，而 `node --test --experimental-strip-types` 解析不了 `@/` 别名 ⇒ 放那儿判据就只能当**文本量具**（像 §6.62 那样）；`messageKinds.ts` **零 import**，放那儿就能真跑一张行为真值表。同一个"成对判定"分在两处，是这两格各自能证到什么程度的直接结果，不是随手的位置选择 —— 这条判断已写进两个文件与判据注释里。

**判据**（`messageKinds.test.ts` 那条既有的「提示行判定只有一个来源」**扩**成「+ 昵称行两边共用一个函数」，册子仍 15 条、全仓 1093 条不因这批增减）：
- 新增**真值表 5 格**（群里别人 text → 要；自己发的 / 单聊 / system / recalled → 不要）+ 一格「表里必须有会亮的格子」，防"恒 false 也算全绿"那种空转。
- 两端各自必须出现 `shouldShowNickname(`，且两本文件都**不许再出现 `isTipKind(`**（一出现就说明规则被拆回两边）。
- ⚠️ 有一条**改了口径**，写清楚免得被当成放宽：原先断言 `messageHeight.ts` 里必须出现 `isTipKind(` —— 那其实是"抄本存在"的证据；现在它不该再有抄本，所以那条断言撤销，**同一条语义改由真值表承担**（摘掉规则里任何一角，表里必有一格翻转）。撤销的是结构断言，不是覆盖 —— 三种变异见下面第三发。
- `kind === "system"` 那条禁令从 2 本文件扩到 3 本（加上 `useMessageDisplay.ts`）。

**三发单点变异，各红各的那一条**：家里摘掉 `&& !isTipKind(input.kind)` ⇒ 红在真值表 `{"isGroup":true,"mine":false,"kind":"system"}` 那格、打印 `true !== false`；估算端把 `shouldShowNickname({...})` 换回手写那行 ⇒ 红在「messageHeight.ts（估算端）必须走那个共用的判定函数」；渲染端退回 `isGroup && !mine` ⇒ 红在「useMessageDisplay.ts（渲染端）必须走…」。三处 `diff -q` 复原后 15/15。

**读数（本批）**：`node --test src/utils/messageKinds.test.ts` **15/15、exit 0**；`npm test` **1093/1093、exit 0**（§6.63 那两条来自并行诊断线的红，这一轮跑之前已被他们自己补上契约图与调用方 ⇒ 整层第一次全绿，值得记一笔：这条链上第一次）；`npm run build`（vue-tsc + vite）**exit 0**；收尾全量探针 **434/434、exit 0**。行数（净变化，`git show HEAD:<file> | wc -l` 与现值各自现算，注意这个对照含 §6.63 未提交的那部分）：`messageKinds.ts` +24、`messageKinds.test.ts` +35、`previewMetrics.ts` 里本批 +8（那段"为什么不在这里"）、两本消费方各 +3。

**探针这一趟跑了三次才拿到读数，两次红都不是代码**（第一次 262/263）：`❌ 探针自己跑完了（没在半路抛错）` 实际打印的是 `CDP 调用「Runtime.evaluate」在 45000 ms 内没回包 ⇒ 响亮失败，这一格记没跑，不是产品红` —— 渲染进程不再响应；第二次被**起跑前的端口预检**挡下（`环境：CDP 端口 9444 起跑前空闲 → 已被占用`）。查出来占着 9444 的是 **pid 92683 那台 Chrome for Testing、`ppid=1`、起了 14 分钟** —— 正是第一次那趟被卡死后留下的残留（起点时间与我那次跑完全吻合）。按 `check-ui-runtime.mjs:2244` 那段注释给的口子（"要么把它清掉"）只 `kill -TERM 92683` 这一台（不 `pkill`、不动别的），第三次 **434/434 exit 0**。⇒ 一条可复用的口径：**探针读到一个 `CDP … 没回包` 之后，下一趟多半会被自己的残留挡住；先 `lsof -nP -iTCP:9444 -sTCP:LISTEN` 认出那台的启动时间与 ppid，确认是残留再按 PID 清**。这个端口预检是**唯一**挡住"连到几小时前那台旧构建上照样打绿"的东西，它报红的时候不要想去放宽它。
**NOT RUN**：真机上「群聊里一条对方撤回，上下两条有没有错位」没有凭据 —— 昵称行那 18px 只在估高端被算，探针没有任何针对昵称行的矩形断言（本轮现算：`grep -n "昵称\|nickname" scripts/check-ui-runtime.mjs` 的 11 处里没有一处是消息行昵称的高度）。**这一格已由 §6.65 补上机器凭据。**

### §6.65 「判定一致」不等于「占位一致」：把分割行与昵称行的**高度配对**量进运行时探针（2026-10-20，P1）

§6.63/§6.64 把两格的**判定**各收成一个函数之后，留下的不是"还有没有抄本"，而是那两批自己记下的两条 NOT RUN：判定共用了，**但没人量过"这一行真画出多高"**。本批补的就是那一格 —— 也是 `messageHeight.ts` 文件头那句契约（「两边必须共用同一套常量，否则相邻消息会互相遮挡」）里唯一没有机器凭据的组成部分。

**新增 `rowpair` 段（`scripts/check-ui-runtime.mjs`，挂 `want("rowpair")`）**：挂**两条**带 `ts` 差值的消息进真组件（`prev` 是 `MessageItem` 已有 prop，`useMessageDisplay` 现推），按 6 分钟 / 4 分钟 / **恰好 5 分钟** / 5 分钟差 1 秒四档各挂一次，读 `[data-time-divider]` 的出与不出；再把 `estimateMessageHeight` 的两档之差与两次挂载的**根盒高之差**对齐。昵称行同族：群聊·对方那条量「消息行顶边 − 那一列顶边」，与估高端「群聊 − 单聊」之差对齐。

**三条口径（都写进段内注释，防后人"顺手改成写死像素"）**：
1. **只比差值，不把 32 / 18 抄进探针。** 抄进去就等于给 `TIME_DIVIDER`/`NICKNAME_ROW` 开了第二个家 —— 那正是本专项在收的那一型错（§6.62 的 15 MiB、§6.63 的阈值都是它）。差值口径的另一层好处：估高端与渲染端**用同一份 ts**，气泡段两边抵消，红的时候只能是那一行本身。
2. **非空转先证**（差值必须 > 0）。这一条不是形式：第三发变异（下面 C）实测「两侧同时归零」时**配对判据自己不会红**（`|0 − 0| <= 1` 成立），只有这条 sibling 抓住它 ⇒ 配对类判据**必须**成对写，一条断"相等"、一条断"不是都为零"。
3. **边界按判定的原话打**：恰好 5 分钟要画（`>=`）、差 1 秒不画。变异 B 实测：`>=` → `>` **只红在"恰好 5 分钟"那一格**，其余 13 条照绿 ⇒ 边界格不是配对格的附属品，两者抓的是不同的病。

**实测读数（Chrome 153 / 本机 2× 屏，`--only=rowpair` 14/14、exit 0）**：`rowFar 80.5`、`rowNear 48`、`dividerBox 38.5`、`estFar 100`、`estNear 68` ⇒ **估高差 32 vs 画出差 32.5**；昵称行 `dNickEst 18` vs `dNickRow 18`（**逐像素对平**）。分割行那 **0.5px 是低估**，来源已算清：分割行盒 38.5 = `pt-3.5`(14) + `pb-2`(8) + 11px 行盒(16.5)，而它出现时正文块不再带 `pt-1.5`(6) ⇒ 净增 38.5 − 6 = 32.5，常量取整成 32。**判定：本轮不动那个常量**，三条理由 —— ① 16.5 那一段是「继承行高 × 11px」，改基础行高就跟着变，写死 32.5 只是把假精确从 32 搬到 32.5；② 低估方向虽是本仓不喜欢的那侧，但 `VirtualList.vue:75` 那条实测回填（ResizeObserver）会在该行渲染后当场校掉 0.5px；③ 配对判据的容差 1px 就是为这一档留的，**读数已经印在探针输出里**（`高度实测表`），漂出容差会响亮红而不是静默。

**三发变异，各自点名各自的那一条**（每发 `diff -q` 复原后再跑下一发）：
- **A**（`messageHeight.ts` 同批改两个常量：`TIME_DIVIDER` 32→40、`NICKNAME_ROW` 18→26）⇒ **12/14**，红的是「分割行占位配对」（打印 `dEst=40 vs dRow=32.5`）与「昵称行占位配对」（`26 vs 18`）；两条**非空转**照绿 —— 这正是它们该有的样子：它们管"是不是都为零"，不管"对不对得平"。这一发同时证了 `dRow` **不跟估高端走**（改了 messageHeight 而 `dRow` 仍是 32.5）。
- **B**（`previewMetrics.ts` 的 `>=` → `>`）⇒ **13/14**，只红「边界·恰好 5 分钟」。
- **C**（把探针自己的 `NEAR` 从 4 分钟改成 6 分钟 ⇒ 两档 DOM 变成同一件事）⇒ **12/14**，红「间隔 4 分钟：分割行不画」与「非空转·分割行」，而**配对那条反而绿**（`0 == 0`）—— 这一发就是 A 里那条口径 2 的反证，也证了 `dRow` 是真量出来的（写死的话它会停在 32.5 而不是变成 0）。

**读数（本批）**：`--only=rowpair` **14/14、exit 0**（`/tmp/rowpair2.log`，跑的是最终内容）；收尾**全量探针 448/448、exit 0**（41 段，`grep -c '= want('` 现算 40 → **41**；= 上一轮 434 + 本段 14，`/tmp/probe-full.log`）；`node --check` **exit 0**；`npm test` **1093/1093、exit 0** 与 `npm run build` **exit 0**（应用码一字未动，本批只动 `scripts/check-ui-runtime.mjs` ⇒ 这两条只作回归确认，且都在探针之后现跑）。三处变异对象的复原都各自 `diff -q` 过（`messageHeight.ts`/`previewMetrics.ts`/`check-ui-runtime.mjs`）。

⚠️ 一条流程上的自证：C 那发是**故意把量具改坏**，因此它跑出来的 12/14 **不能**当作"探针坏了"的证据上报；判据的绿只认复原之后那两次（`--only=rowpair` 与全量）。

**同一趟里顺手量到的第二条轴（文档表格的格子数）**：为了改行 35/36 那两行台账，先用一把 20 行的尺子扫了 `docs/architecture/*.md` + `docs/stability-roadmap.md` 的**全部 85 张表**（GFM 在切表格时**先按 `|` 分格再解析行内** ⇒ 行内代码里写的 `` `a || b` ``、`` `x|y` `` 都会把一行劈成多一格）。`frontend-inventory.md`（本专项的交付物）里实测 **6 行有这病**：两行行尾多一个 `|`、一行行首多一个 `|`、三行的 code span 里含裸管道 ⇒ 本批全改成单边竖线 / `\|`。改法的依据不是印象：GFM 规范 **Example 200** 明写 `` `\|` `` 在表格里渲染成 `<code>|</code>`（反斜杠被切格那一步吃掉）⇒ 渲染正常、复制出来仍是原式。改完复扫该文件 **extra-cell-rows = 0**，四道文档门 + change-budget 各 **exit 0**。
- **同型另 4 行不在这批动**：`backend-modernization.md:565/570`、`frontend-experience-roadmap.md:10`、`stability-roadmap.md:496`（前一份与后一份都是并行会话在飞的 `M` 文件）⇒ 只登记行号，归属在别人名下。
- **这把尺子自己的假阳性要写明**：第一版把「行尾没有竖线」也算坏行（多报 8 条）——GFM 里尾竖线是可选的 ⇒ 判据形状收窄成**只报格子多于表头**的那一类。
- **为什么本批不加一条文档门**：这类坏是**静默的**（多出一列而没有任何门红）。但量具还不稳（要真分辨 code span / 转义 / 合法缺尾竖线，20 行那把尺已经实测错方向一次）⇒ 按「先分响亮还是静默、量具不稳就别上闸门」判成**下一格候选**，不在这里立半稳的门。

### §6.66 组件自造的 objectURL：7 个创建点数完，其中一条链在 await 之后没问取消（2026-10-20，P0）

**先数轴再动手**（口径 = 生产码里 `URL.createObjectURL(` 的全部落点，判据现扫 205 份生产文件）：**7 处 / 4 本**。
- `utils/filePreview.ts` 3 处 + `utils/favoritePreview.ts` 1 处 ⇒ 这两本的 URL **归 LRU 缓存所有**，回收走 `blobLru` 注入的那个出口（`revoke:`），判据 ⑤ 早就把它们钉成"消费者不许自己 revoke"。**不是这一族的成员，也不许把它们拽进新家**（那是假抽象）。
- `settings/ProfileSection.vue` 1 处 ⇒ 创建后交给 `Image` 的 `onload/onerror`，**三条终局分支各回收一次**（154/157/162），这一条链上没有"取消"这个概念 ⇒ 形状像但语义不是同一件事，**不动**。
- `message/MergeCardModal.vue` 2 处（`probe` 本机探测、`pull` 向对端回源）⇒ **全仓只有这一本同时具备"造 URL"与"取消标志"**，也就是这一族真正的主场。

**发现的缺陷（`pull`）**：它在轮询里先问一次 `closed`（137 行），**然后**才 `await readContentPreview(...)`；await 之后直接 `objectUrls.push(url)` + 写 `imageSlots`。弹窗如果正在这次 await 期间被关掉，`onBeforeUnmount` 那一轮回收**已经跑完并把账本清空**了，这条晚到的 URL 就再也没人回收 —— 一张上限 `IMAGE_PREVIEW_MAX_BYTES`（15 MiB）的 blob 永久留在文档里。`probe` 同一条链上是写了复查的（`closed || items.value[i] !== item`）⇒ **同族两处的取消复查不对称**，坏的是那条更慢的：`pull` 走网络，await 动辄几秒，撞上关闭的窗口比 `probe` 大得多。

**改法（连"重复"一起收，不是只补一句 if）**：两处那 4 行「创建 → 问取消 → 回收或入账」本来就是同一件事写两遍 ⇒ 收成组件内的一个入账出口 `adoptUrl(url, stale?)`（取消或换条了就当场 `releaseUrl` 并返回 null，否则入账返回该 URL），两处创建点改成 `const url = adoptUrl(URL.createObjectURL(...), …); if (!url) return;`。顺带修掉 `probe` 原来"先 push 再判"留下的死账（回收过的 URL 还挂在账本上、卸载时会被再 revoke 一次 —— 浏览器侧是 no-op，但那是**没人声明过的冗余**）。`adoptUrl` 里 `closed` / `releaseUrl(url)` / `objectUrls.push(url)` 三个零件各写清缺任何一个这个家都不成立。

**判据 ㊹**（`designGuards.test.ts` 157 → **159**，全仓 `npm test` **1093 → 1095**）：真实树现扫，**只对"同一本文件里既有 `URL.createObjectURL` 又有 `let/const closed|cancelled|disposed|unmounted` 标志"那一类**要求「create 点数 == `adoptUrl(URL.createObjectURL(` 数」；两条下限（全仓 create 点 ≥ 2、带取消标志的那一族 ≥ 1 本）防"改名 / 没人造 URL"把判据扫空；那个家的三个零件单独断言。夹具里 2 条正控就是本轮删掉的两种真写法（带 `stale` 第三参 / 不带），3 条反控是 utils 那一族（无取消标志 ⇒ 不判）、缓存写入形状、以及**注释里提这个名字不许被数成调用点**。
⚠️ 边界写进注释：这条只判「create 有没有被包住」，**不判"回收有没有真的执行"** —— 后者要跑起来才有答案，而 §6.65 刚为同一件事写过矩形量具，那条经验就是"文本判据看不到的那一半要单独量"，这里不冒充覆盖了它。

**两发单点变异各点名各的那一条**：M1 把 `probe` 换回裸写法 ⇒ 红「真实树」并打印 `造了 2 个 objectURL，只有 1 个走 adoptUrl`；M2 只摘掉 `adoptUrl` 里那句 `releaseUrl(url)` ⇒ 红「adoptUrl 里没有当场回收 ⇒ 家不成立」，而 M1 那条等式在这一发里仍然成立（说明两条判的不是同一个病）。两处 `diff -q` 复原后 159/159。

**读数（本批）**：`node --test src/utils/designGuards.test.ts` **159/159 exit 0**、`npm test` **1095/1095 exit 0**、`npm run build`（vue-tsc + vite）**exit 0**（这两条都在复原之后的树上现跑）。收尾全量 CDP 探针 **448/448、exit 0**（41 段，跑的是本批之后的树，`/tmp/probe-666.log`；条数与 §6.65 那次相同 —— 本批没加探针段，`MergeCardModal` 也不在任何段的挂载清单里）。净变化：`MergeCardModal.vue` **+13/−9**（一个 `adoptUrl` 家 + 两处改调用 + 注释）＝**业务渲染组件里的非业务资源生命周期代码**，`designGuards.test.ts` 是测试码不计入业务成果。判据读数：`· ㊹ 分母：生产文件 205 份 / create 点 7 处 / 带取消标志的那一族 1 份 / 违规 0`。

⚠️ **NOT RUN**：「关掉弹窗后那张晚到的图真的被回收」没有运行时凭据 —— 要证它得让 `api.readContentPreview` 在探针里可控地慢下来（stub IPC），本仓探针没有这层桩。本轮的证据是**结构对称 + 两发变异各红各的一条**，不是"跑起来数过 revoke 次数"。这条留在「要动 IPC 桩」那一档。
⚠️ 提交时的欠账（本批不动版本，按用户授权不提交）：本批改了应用码（`isAppCodePath` 命中 `MergeCardModal.vue`）⇒ 真提交那一笔要带 `Version-Bump:` trailer 并核对五处版本清单，且 ㊹ 让 `designGuards` 条数变了（157 → 159）。

### §6.67 i18n 词典的反向可达：41 条「定义了却全仓引不到」的死文案删掉，量具本身返工三次（2026-10-20，P3）

**这一轴是谁**：`src/i18n/locales/{zh-cn,en-us}.ts` 的键集合 → `src/**`.{vue,ts} 里的字符串字面量。既有三条判据（key 集合中英一致 / 值非空 / 每个 `t("字面量")` 都能命中真实 key）全是**正向**的「调用点 → 词典」，没有一条问反方向「词典 → 调用点」。⇒ 改名与删功能留下的尾巴没人管：一条死文案要在**中英两册各占一行**，于是"这条还在用吗"从此没有答案，词典越留越不敢删。

**存量（现算，`git show HEAD:…` 与当前树各数一遍 `^  "k":`）**：HEAD 两册各 **1001** 键、两册对称 0 差、`t()` 正向缺口 0（这三条本来就有）⇒ 反向那一侧本批数出 **41** 条引不到的，全部删掉（中英各 41 行 = **−82 行非业务文案码**，判定＝**删除**，依赖零增减）。当前 981 键（差额里另有 **21 条是本批之前就在工作树里的新增键**，不属于本批、也没被本批动过）。来源分布看得出"尾巴"是怎么长出来的：`settings.chatStyle.fontSize.{xs…xl}` 5 条（字号五档曾改名为 `chatStyle.fontSize.*`）、`friend.profile.*` 6 条与 `diag.*` 5 条（面板删过行）、`conv.toast.*` 3 条、`todo.*` 3 条。

**★量具三次返工（本批真正的收获，比那 82 行值钱）**：
| 版本 | 提取器写法 | 实测读数 | 结论 |
|---|---|---|---|
| V1 | `["'`]…["'`]`：任一种引号起、任一种引号止 | 死文案 **41** 条 | 当时以为对，其实形状是错的（见 V2 的反证） |
| V2 | `(["'`])…\1`：同种引号成对，**单遍** | 死文案 **94** 条，其中 `logs.filter`、`common.clear`、`nav.me.online` 这些**正在用**的 | 误杀。`matchAll` 扫完 `"t('common.clear')"` 整条后从**闭合引号之后**接着走，被它包住的那对 `'…'` 永远不会再成为一次"起" |
| V3 | 三种引号**各扫一遍**（每遍内容排除该引号与换行） | 死文案 **0** 条 | 嵌套够得到 ⇒ 41 条是真的，94 那轮是量具坏了 |

真实形状在本仓是主流写法：`src/components/LogViewer.vue:249` 的 `:title="t('logs.title')"`、`src/components/settings/ResetSection.vue:108` 的 `:confirm-label="t('common.clear')"`。**方向要说清**：V1 那版**报出来的 41 条是对的**（它只是"漏算引用面"，漏算让死文案显得更多、不会更少），V2 才是会把在用文案删掉的那一版 —— 所以这一轴的教训不是"V1 删错了"，而是**"任何一条缺席型判据，量具换形状必须重跑一次存量"**。

**第二个发现（更隐蔽）：判据会读自己的说明**。口径里"注释中的字面量也算引用面"（为的是不误杀 `@param` 那种说明），而这条判据自己的文档注释举例写了 ``t(`diag.${k}`)`` ⇒ 造出一个 `diag.` 前缀，把**整族 `diag.*` 洗白**。修好量具后 41 条里有 **8** 条被这类垃圾前缀判成"可达"（`chat.selfChat`、`chat.selfChatHint`、`multi.forward`、`diag.networkStatus/name/selected/lanPeers/btInterval`）。逐条按**精确引号**复核：`git grep -E '["'"'"'`]{key}["'"'"']'` 排除两册与 `docs/` ⇒ **0 条**被引；再按裸串复核，7 条的命中全是更长的键（`chat.selfChatTextOnly`、`msg.reactionAddEntry`、`todo.assigneesEmpty`、Rust 字段 `diag.selected_ip`）⇒ 删除成立。注释里的例子已换成真在用的 ``t(`favorite.cardKind.${active.kind}`)``，并写明"举例请用真在用的族或换个不存在的名字"。

**删除手术自己踩的坑（记进纪律）**：词典里**条目不是一行**。有些条目写成 `"k":` + 值在下一行，还有 `"k": "段一" + "段二" + "段三",` 这种三段拼接。按行删键会留下孤儿值行，而我那版"孤儿清理"（"下一行不是键行就删"）把**活键** `diag.connHealthHint` 的后两段吃掉了 ⇒ `ERR_INVALID_TYPESCRIPT_SYNTAX`。中英两册都按 `git show HEAD:` 的逐字原文复原（该键未被本系列任何批次改过，所以 HEAD 就是权威）。⇒ 对多行条目做批量删除要用"键行 → 下一个键行之前"的**条目边界**，不许用行级启发式。

**三发单点变异（都 `diff -q` 复原后再跑）**：M1 中英两册各加一条全仓引不到的 key ⇒ 红「死文案」并点名那条；M2 只往 zh 一册加 ⇒ 红「zh/en key 集合一致」那条（同轮「死文案」也红，两条判的不是同一个病）；M3 把 `QUOTES` 从三种改成只剩双引号 ⇒ 红引用面夹具，报 `嵌套单引号里的 key 没进引用面：["t('nav.me.online')"]`。夹具里另有两条反控：`ct(zo, "group.toast.nameEmpty", fallback)` 这种**查表常量**要认（只扫 `t("…")` 就会误杀），跨行模板**不许**被吃成一条字面量。

**读数（本批）**：`node --test src/i18n/index.test.ts` **19/19 exit 0**，判据自打印 `· 死文案护栏：词典 985 键 / 引用面 15588 个字面量 / 可达前缀 492 个 / 死文案 0`；`npm test` **全绿 exit 0**；`npm run build`（vue-tsc + vite）**exit 0**。两条都在复原之后的树上现跑。⚠️ 总条数不落笔：同一棵工作树被并行会话共用，`npm test` 现算从 1095 → 1097 → **1099**（后两次涨的是别人新增的用例），条数一律以脚本自己打印的为准。

**界面这一格**：删掉的 41 条按定义**没有任何调用点** ⇒ 界面上不可能有可感知变化，所以真机复看不构成这一批的验收面（这不是"没验"，是这一批没有可看的东西）。运行时的体验凭据在 §6.65 那一格里。

**已知边界（不许当成全覆盖）**：① 前缀规则**偏松**是故意的 —— `todos.test.ts` 里 `mu${seq}` 这种非 i18n 拼接也会留下前缀 `mu`，所以这条判据**只会漏杀不会误杀**；删文案时仍要自己按精确引号复核（本批 8 条就是这么复核的）。② 引用面只扫 `src/`（两册词典自己不算），`scripts/` 与 `index.html` 里若引 key 不在这条的量程内 —— 本批实测 `scripts/check-ui-runtime.mjs:2521` 引的 `msg.reactionAddEntry` 是**在册**的键，不影响删除集。③ 它判的是"字面量可达"，不判"这条文案还该不该存在"——语义过期（词还在、意思变了）不在这一轴。

⚠️ 提交时的欠账（本批不动版本，按用户授权不提交）：本批只改词典与测试码（`isAppCodePath` 不命中 `src/i18n/locales/*` 的文案行与 `index.test.ts`），但**工作树里 §6.66 那笔应用码改动仍在** ⇒ 真提交时那一笔仍要带 `Version-Bump:` 并核对五处版本清单；`npm test` 条数本批跑时现算 **1097**（+1 条夹具），同棵树收尾时已因并行新增变 **1099** ⇒ 提交时不许拿这两个数中的任何一个当"当前值"，测试清单基线那一腿要在提交时按现算走 `--update` → `--sync-baselines` → 再 check。

### §6.68 主题令牌拼错一个字符不报任何错：`var(--gosslan-*)` 的「定义 ↔ 消费」两个方向一起数完（2026-10-20，P1）

**这一轴是谁**：`--gosslan-*` 这批设计令牌。它们写在 Tailwind 的任意值里（`text-[var(--gosslan-text-2)]`、`hover:bg-[var(--gosslan-hover)]`），**拼错一个字符不会有任何报错** —— CSS 里未定义的自定义属性在计算值阶段失效，`color` 退回继承值、`background` 退回初值。于是"次要文字"和"正文文字"长得一样、"悬停有底色"变成点了没反应，而且**只有那一处**不对，没人会去查一个 class。

**现扫存量**（305 份 `.vue/.ts/.js/.css/.html`，判据自己打印）：消费点 **1546** 处、定义 **76** 个名字、未定义 **8** 处（修完之后 0）、无人消费 **5** 个。那 8 处分三类：

| 令牌 | 站点 | 坏法 | 判定与改法 |
|---|---|---|---|
| `--gosslan-text-3` | 5 处（`RemindAudienceDialog` 两行说明、`SettingsPanel` 分组标题 + 一枚 `ChevronRight`、`MessageReceipt` 已读的 `Check`） | **第三档灰从来没存在过** —— 册子里只有 `--gosslan-text` 与 `--gosslan-text-2` ⇒ 这五处一直在继承正文色，看着就是"该浅的地方不浅" | 全指向已存在的 `--gosslan-text-2`。**不新造第三档**：新色档要过对比度账（`tokenContrast` 那一族），而这五处要的语义与 `text-2` 完全一致 |
| `--gosslan-surface-2` | 2 处（`NetworkSection.vue:452/479` 两枚按钮的 `hover:bg-`） | 这个名不存在（悬停档叫 `--gosslan-hover`，另有 `list-hover` / `pressed`）⇒ **悬停压根没有底色**，只有 `transition` 在空转 | 指向 `--gosslan-hover`（两档主题与 `-hover` 覆盖都在册） |
| `--gosslan-link-ink` | 1 处（`ChatSearchDialog.vue:506`） | 带兜底 `var(--gosslan-link-ink,var(--gosslan-primary))` ⇒ 今天看着正常，但那层间接**永远走不到**，唯一作用就是兜底 | 直接写 `var(--gosslan-primary)`。**并且这条决定了判据口径：带兜底也算违规** —— 兜底会把拼错永久藏起来 |

**判据 ㊺**（`designGuards` 159 → **161**）：只判 `--gosslan-` 命名空间（`--reka-toast-swipe-move-x` 这类由库在运行时提供，不归我们定义），要求每个消费点的名字都能在同一棵树里找到定义。**定义面必须认三种形状**：CSS 声明、内联 `:style` 的字符串键、`setProperty("…")` —— 本批第一版只认 CSS 声明，`--gosslan-msg-size`（`useAppStore.ts:329` 运行时写）与 `--gosslan-primary`（`color.ts:123` + `theme-boot.js:38` 写用户主题色）当场被误报成"没定义"。剥注释不能用现成的 `stripCommentsJs`：它按 `//[^\n]*` 砍行注释，会连 `url(https://…)` 一起吃掉 ⇒ 另写了一把（块注释与 HTML 注释整段去，行注释只在 `//` 前不是 `:` 时才去），并把"不许砍掉协议地址"钉成夹具里的一条反控。另两条反控：白名单里的名字必须**真有人在消费**（防它变成过期借口，今天为空）；拼出来的名字（`var(--gosslan-radius-${x})`）静态分不出与拼错的差别 ⇒ 夹具直接把这个事实写成断言，白名单就是为它留的口子。

**反向那一半故意不判红，但钉成只许变小（≤ 6）并每轮点名**：`--gosslan-text-title/callout/footnote` 是 `docs/design-guidelines.md` 那张排版标尺里写明"等接线"的三档（今天只有 `body`/`caption` 有人读，全仓 `.vue` 里还有 **265 处** `text-[13px]` 这类散值），`--gosslan-mobile-tabbar-h` 与 `ResponsiveLayout.vue:595` 的 `pb-[calc(4rem+…)]` 是同一个 64px 的两种写法（**接线要动移动端布局** ⇒ 归到"等窄窗读数"那一档），`--gosslan-item-radius` 同理待归属。把 265 处散值一次迁进标尺是另一条轴（每一处都是可见变化），不在这一批顺手做。

**两发单点变异各红各的一条**：N1 往 `SettingsPanel` 塞一个不存在的令牌（无兜底）⇒ 真实树那条红并点名 `gosslan-nope-xyz ← components/SettingsPanel.vue`；N2 同一个坏名字**带兜底** ⇒ 同样红（证口径 1 真的在判，不是只写在注释里）。两处 `diff -q` 复原后 161/161。

**读数（本批）**：`node --test src/utils/designGuards.test.ts` **161/161 exit 0**（判据自打印 `· ㊺ 分母：扫 305 份 / 消费点 1546 处 / 定义 76 个 / 未定义 0 / 无人消费 5 个（…）`）；`npm test` **全绿 exit 0**（收尾时现算打印 1099，含并行会话新增，非本批成果）；`npm run build`（vue-tsc + vite）**exit 0**；收尾全量 CDP 探针 **448/448 条判据绿、exit 0（`/tmp/probe-668.log`）**。净变化：5 个业务组件文件 **8 处 class 里的令牌名**（`RemindAudienceDialog` / `SettingsPanel` / `MessageReceipt` / `NetworkSection` / `ChatSearchDialog`）＝**业务渲染组件里的样式引用**，零新增行逻辑；`designGuards.test.ts` 是测试码不计入业务成果。

⚠️ **要用户看一眼的真机读数**（这八处是"颜色对不对"，探针没有针对它们的矩形/取色断言）：设置页分组标题与右侧箭头、消息已读的那个小勾、提醒受众弹窗里两行说明 —— 应从正文黑变成浅灰；网络页两枚小按钮（"移除"与中继那枚）悬停时**应有底色**。深色主题各看一遍。
⚠️ **NOT RUN**：Windows / Android / iOS 三腿同样未跑；`--gosslan-mobile-tabbar-h` 那一档的接线已在 **§6.69** 落地（含「为什么必须用 rem」这条单位口径），但窄窗真机读数仍欠 ⇒ 归到 §6.69 的待复看清单。
⚠️ 提交时的欠账：本批改了应用码（`isAppCodePath` 命中这五本 `.vue`）⇒ 真提交那一笔要带 `Version-Bump:` trailer 并核对五处版本清单；`designGuards` 条数 159 → 161 会让测试清单基线漂 ⇒ 提交前 `--update` → `--sync-baselines` → 再 check。
⚠️ 并行会话重叠：`src/components/search/ChatSearchDialog.vue` 在本批动手前已是**已暂存**状态（`M ` 在第一列），本批只把第 506 行那一个令牌名换成 `--gosslan-primary`（该文件工作树与索引当时逐字一致 ⇒ 不是覆盖别人的未提交改动），提交归属仍属他们那一笔。

### §6.69 · 移动端底栏占位高度：同一档尺寸有三个家，两个在用人手抄（P1 收口 + 一条量具侧外溢）

**这一轴的现数口径**（复跑：`git grep -n 'pb-\[calc(' -- src | grep -v '\.test\.'`）：全仓生产码里
`pb-[calc(` 形状**恰好 2 处** —— `ResponsiveLayout.vue` 主内容区、`ConversationList.vue` 会话/通讯录列表，
两处都写的是同一串字面量 `pb-[calc(4rem+env(safe-area-inset-bottom))]`。而 `src/style.css` 里
`--gosslan-mobile-tabbar-h: 64px` **定义了却没人读**（㊺ 每轮点名的那 5 个未消费令牌之一就是它）。
⇒ 同一档高度有**三个家**：令牌（没人用）、两份手抄字面量（真正在用的那两个）。
这是 §6.68 那条"定义 ↔ 消费"轴的另一半：那里查的是"消费了没定义的"，这里查的是"定义了却被抄成字面量的"。

**为什么这条值得动**（不是"看起来更整洁"）：那两处占位是 fixed 底栏的**唯一**遮挡补偿 ——
底栏 `position: fixed` 不占流，占位少了**最后一行就永久压在栏底下、滚到底也露不出来**
（`ConversationList.vue` 那段注释里记着这条缺陷原本的样子：聊天区早有补偿、列表这处漏了）。
`ResponsiveLayout.vue:108` 已经为**显示条件**立过"单一事实来源"（2026-09-19 那次漂移是条件漂了、
栏没了占位还留着 ⇒ 底部空一大截），但**尺寸**这一维当时没收 —— 同一个对象的两半，只钉了一半。

**改动**（净 −0 行逻辑、三处引用改指向同一个家）：
- `src/style.css`：`--gosslan-mobile-tabbar-h` 从 `64px` 改成 **`4rem`**，并把"必须 rem"的理由写进注释。
  ⚠️ 这一条是本批唯一非显然的判断：**不能改成 px**。全仓没有任何地方覆盖根字号（现数：
  `git grep -n 'documentElement.style.fontSize'` 与 `html { font-size` 都 0 命中），
  所以今天 `4rem` ≡ 64px、改动**逐字等价**；但底栏自己的几何是 `py-2.5` / `h-5`（都是 rem），
  Android WebView 的 `textZoom` 会把根字号一起放大 ⇒ 条子变高时 rem 的占位跟着变高。
  把令牌写成死 px 就等于"用户开大字体后最后一行被压住"—— 而这只有 Android 真机能看见。
- 两处占位 → `pb-[calc(var(--gosslan-mobile-tabbar-h)+env(safe-area-inset-bottom))]`。
- 两个文件的注释各自写明"条高只有这一个家"，`ResponsiveLayout.vue:108` 那段补一句
  "条件与尺寸是两件事，别把其中一个的收敛当成另一个也收敛了"。
- 同批把 §6.68 里"接线要窄窗读数 ⇒ 留在原档"那句改成指向本节（那条前提已经不再成立）。

**判据 ㊻**（`designGuards` **161 → 163**）：
- 真树那条：扫全部 `.vue`（88 份），命中 `pb-[calc(` 的每一个占位**不许含字面长度**
  （`\d+(px|rem|em|vh|dvw|dvh)`），且必须引用一个 `--gosslan-*` 令牌；两条分母下限
  （占位 ≥ 2、`--gosslan-mobile-tabbar-h` 被读到 ≥ 2 次）—— 掉到 1 只可能是"有人退回手抄"或
  "量具被改名扫空"，两种都必须响亮地红。自打印：`· ㊻ 分母：扫 88 份 .vue / 底栏占位 2 处 / 读到的令牌 --gosslan-mobile-tabbar-h（各 2 次）`。
- 口径边界写死三条，防止它去禁一件正确的事：**只扫 `pb-[calc(`**（`pb-[max(env(…),0.75rem)]`
  那种"安全区下限"是另一件事，ActionSheet / FavoritePanel 在用，误扫就会把它们判成违规）；
  `env()` 自己不算字面量（它是平台给的量）；**单位不在这一条判**（rem/px 的取舍属于令牌自己，
  这条只判"有没有第二个家"）。
- 夹具四个形状：字面量要报、令牌不报、`max()` 那族**根本不进分母**、两个令牌相加（底栏 + 呼吸位）
  不误伤 —— 最后那一条是防"必须恰好一个令牌"这种过紧写法。
- 两发单点变异各红各的一格：M1 把 `ResponsiveLayout` 换回 `4rem` ⇒ 恰好点名
  `layouts/ResponsiveLayout.vue: 占位里抄了字面长度 4rem+env(safe-area-inset-bottom) ⇒ 字面长度 4rem`
  而 ㊺ 照绿（证明"多一个家"与"消费没定义的"是两个病）；M2 把列表那处占位整段换成 `pb-16` ⇒
  红的是分母下限那句（`全仓只扫到 1 处 pb-[calc(…) 底栏占位（下限 2）`）。两处 `diff -q` 逐字节复原，
  复原后 163/163。

**顺手撞到的一条量具侧外溢（本批的意外发现，值得单独记）**：把 `tailwind.config.js` 的 `content`
从 `./src/**/*.{vue,ts,tsx}` 改成 `./src/**/!(*.test).{vue,ts,tsx}`。
Tailwind 扫的是**原始文本**、不做语义判断 ⇒ 97 本 `*.test.ts` 一直在被扫，
判据夹具里"故意写坏的示例 class"（`z-[7]`、`z-[200]`、`pb-[calc(56px+8px)]`、
`text-[var(--gosslan-x)]`、`rounded-[var(--gosslan-item-radius)]`…）被当成"真在用过的样式"
**生成进生产 CSS** —— 现数 **13 条死规则**，全部只出现在 `src/utils/designGuards.test.ts` 里。
修法选在配置那一栏而不是改夹具写法：夹具只会越加越多，逐条去躲字面量是打地鼠。
两条核对（都是现算，不靠"Tailwind 大概是这样"）：
① 排掉的到底是不是只有测试码 —— `fast-glob` 按新旧两套 pattern 各展一遍：
**303 → 206 份，差的 97 份全是 `*.test.ts`，非测试文件少 0 份、多出 0 份**（`.vue` 88 份一份没掉）；
② 产物侧 —— 构建后 CSS 里 `z-[7]` / `56px+8px` / `gosslan-gap-lg` / `条高` 这些形状**全部不在**，
而真占位那条 `calc(var(--gosslan-mobile-tabbar-h)+env(safe-area-inset-bottom))` **在**；
CSS 字符数 61945 → **59904**（−2041）。
另记一条同源边界：**生产文件里的注释 prose 也会被扫**（我第一版注释写了个完整的
`pb-[calc(条高+safe-area)]` 例子，当场多生成一条 CSS 规则）⇒ 已在同一批把注释改成不拼出完整 class 的说法。
这一档**不配判据**：它的代价只是几百字节死 CSS，而判它必然要去禁"注释里出现 class 形状"，
那条会连带禁掉大量正当写法 —— 记成写注释的口径，不建量具。

**换成令牌 = 换了一种失败方式，所以按新失败方式各查一条**（都不靠推断）：
① **同一个值被拆进两个 CSS 分块** 这一族 —— 现算：定义 `--gosslan-mobile-tabbar-h:4rem` 与消费它的
`padding-bottom:calc(var(--gosslan-mobile-tabbar-h)+env(…))` **同在 `dist/assets/boot-*.css`**，而 `index.html` 三个
`<link>` 里就有这一份（`grep -o 'href="[^"]*\.css"' dist/index.html`）⇒ 不会出现"分块没加载 ⇒ `var()` 未定义 ⇒
占位整条失效 ⇒ 最后一行被压住"。② **这两处占位会不会在没有 `style.css` 的辅助窗口里渲染** ——
`git grep -ln ConversationList -- 'src/**/*.vue'` 只有 `ResponsiveLayout` 真挂载它（其余是注释/同目录文件），
而辅助窗口是 `logs.html` / `preview.html` / `settings.html` / `todos.html` 四个独立入口 ⇒ 不共用这条链。
（`--gosslan-header-h` 那类同族令牌今天都有消费点，㊺ 已盯住"定义了没人读"与"读了没定义"两个方向。）

**读数（本批）**：`node --test src/utils/designGuards.test.ts` **163/163 exit 0**；`npm run build`
（vue-tsc + vite）**exit 0**；`npm test` **全绿 exit 0**（条数由脚本自己打印，见 §6.68 那条口径）；
收尾全量 CDP 探针 **448/448 exit 0**。净变化：`src/style.css` 1 行值改动 + 2 处业务组件的 class 令牌名 +
`tailwind.config.js` 1 行 content ⇒ 逻辑零增减；`designGuards.test.ts` 是测试码不计入业务成果。

⚠️ **那 448 条里没有一条读底部占位几何**（`grep -E "TabBar|tabbar|底栏|pb-"` 现数 0 条命中，只有分割行/昵称行的
"占位"是别的东西）⇒ 这次绿灯只证明"本批没碰坏别的界面"，**不证明**"最后一行没被压"。判据 ㊻ 钉的是
"尺寸只有一个家"，不是"那个值够不够高"：把 `--gosslan-mobile-tabbar-h` 改成 `1rem` 时 ㊻ 与探针都会绿，
而界面已经把最后一条会话压在栏底下。**这一格目前只有真机能判**（见下一条），探针侧的遮挡判据登记为待办。

⚠️ **探针侧本轮挂了一条台账（本批不修，只登记）**：448 那次之前有 **2 次同形挂死**（`/tmp/probe-669b.log`
与 `…c.log` 的 md5 **逐字节相同** = `9375bfd7…c2124`），都停在"弹窗·Android 返回键那一层关干净"之后的
第一次 `Runtime.evaluate`，读数 `264/265`、`PROBE_EXIT=1`、
`CDP 调用「Runtime.evaluate」在 45000 ms 内没回包（renderer 主线程很可能已经不响应）`。
三次尝试的差别只在环境：**清掉 9444 上残留的 probe Chrome 后同一段就过了**，隔离跑 `--only=overlay,imgskel`
= **48/48 exit 0**。脚本第 87 行原本就记着一件同形的历史挂死，所以这不是新形状。
口径：挂死那两次**不算产品红也不算本批判据**，本批只认 D 轮那一次全绿；但"两次同形、一次通过"没给出根因 ⇒
它是 harness 侧一条**未闭合缺陷**（下一次再挂要按脚本自己那句"记没跑"处理，不许当成通过、也不许为消红放宽 45 s 预算）。

⚠️ **要用户看一眼的真机读数**：这条改动**按构造应当外观不变**（`4rem` ≡ 64px、单位仍是 rem、占位值不变），
所以它不产生新的观感项；但"不变"这件事要在窄窗里看一眼才算闭合 —— **手机形态（≤640px）打开聊天列表，
滚到底，最后一条会话必须完整露在底部导航之上**；同一屏在浅色/深色各看一眼。
⚠️ **NOT RUN**：Android / iOS 的 `textZoom` 放大档（本批"必须 rem"那条理由的真机反证，只有设备能答）；
Windows / Linux 腿同样未跑。探针跑的是没有 Tauri 的页面，它不会替 `textZoom` 作证。
⚠️ **本批故意没动的一格**：两处占位的**显示条件**不对称 —— `ResponsiveLayout` 读 `showMobileTabBar`
（含 `multiSelectActive` 与四 tab 判断），`ConversationList` 读自己那套 `app.isMobile && !app.keyboardOpen`。
按推断两者在列表可见的那些状态下等价（多选态时列表在 ChatWindow 背后），但**这是推断不是读数**，
改它要跨组件传条件（prop 或下沉 store），属另一条轴 ⇒ 只登记，不顺手改。
⚠️ 提交时的欠账：本批改了应用码（`ResponsiveLayout.vue` / `ConversationList.vue`）⇒ 与 §6.66/§6.68 同一笔
`Version-Bump:` 欠账一起补；`designGuards` 161 → 163 ⇒ 测试清单基线提交前 `--update` → `--sync-baselines` → 再 check。

---

### §6.70 · 移动端「整屏覆盖壳」这一族数完：家只有一个，抄本登记成棘轮（判据 ㊼，结论 = 暂缓替换）

**轴与分母（现算）**：`designGuards` ㊼ 扫 `src/**/*.vue`（排掉 `*.test.vue`）里**三段形状齐全**的文件 ——
`fixed inset-0` + `z-[60]` + `pt-[env(safe-area-inset-top)]`：

```bash
node --test --test-name-pattern='㊼ 真实树' src/utils/designGuards.test.ts
# · ㊼ 分母：扫 88 份 .vue / 认出整屏壳 2 份 （家 1 + 抄本 1：components/FavoritePanel.vue）
```

独立核对同一条轴用另一把尺子（`fixed inset-0 z-[` 的原文命中）⇒ 生产码同样只有 `MobilePageFrame.vue:54` 与
`FavoritePanel.vue:691` 两处，其余命中都在注释里（`BaseModal.vue:94`、`ImageLightbox.vue:41`）。
**三段齐全**是刻意的口径：只写 `fixed inset-0` 的普通铺满层（灯箱、遮罩、ActionSheet）是另一族，
把它们扫进来会去禁一件正确的事。

**这条为什么算"重复组件封装"**：`FavoritePanel.vue:688–712` 手抄了整屏壳的三段 —— 根类、头部、返回键，
而它自己的注释第 694 行写着"与 MobilePageFrame **完全一致**的框架返回键"。
"靠人手工保持一致"就是漂移的定义：公共原语改了，这里不会跟着改，而且不会有任何东西变红。

**为什么本批不迁（三条都是代码级读数，不是偏好）**：

1. **桌面几何不允许直接换 `inline`。** frame 的 inline 根类是 `flex h-full min-h-0 flex-col`
   （`MobilePageFrame.vue:55`），而收藏详情桌面分支今天是 `flex min-h-0 flex-1 flex-col`
   （`FavoritePanel.vue:692`）。它挂在 flex-**row** 父级里，`flex-1` 管的是**宽度** ⇒ 去掉它就是"右栏从占满剩余宽度
   变成按内容收缩"。这不是像素级微调，是主轴向换掉，必须先用运行时读数钉住"改前是多少"才能改。
2. **底部安全区两个家给的不是同一个量。** frame 的 overlay 给 `.safe-bottom`（= 纯 `env(safe-area-inset-bottom)`），
   收藏详情今天给 `pb-[max(env(safe-area-inset-bottom),0.75rem)]`（`:714`）。直接套 frame 会变成两层相加
   （frame 的滚动层 `env` + 自己那层 `max(env,12px)`）⇒ iOS 34 px 那一档实际涨到约 46 px。**这是真像素变化**，
   按 §八 必须有界面读数，不能靠"看起来差不多"。
3. **两条出路都越界。** 要么动公共原语的根类/inset 口径 —— 它另有 **4 家调用点**（`ResponsiveLayout:832`、
   `SettingsPanel:160`、`LinksList:107`、`LogViewer:425`；复跑 `grep -rn "<MobilePageFrame" src --include="*.vue"`
   现数 5 处命中，扣掉原语自己第 14 行的注释示例 = 4 家。其中 3 家写死 `mode="overlay"`，1 家按 `app.isMobile` 动态选），
   一家迁移拖着 4 家回归；要么给原语加一个 `inset` 参数专门伺候收藏页 —— 那是任务规则里明确禁止的
   "为一家调用者加配置层"。

⇒ 判 **暂缓替换**，但**不许无名**：㊼ 把抄本数钉成棘轮（上限 = 登记名单长度，只许变小），
新页面再抄一份壳 ⇒ `这些页面手抄了整屏覆盖壳而没有登记` 直接点名。

**正反两发单点变异（各红各的一格，都逐字节复原）**：
M1 把 `MobilePageFrame.vue:54` 的 `z-[60]` 改成 `z-[62]`（形状签名过期）⇒ 红的是正控那句
`全仓没认出 components/MobilePageFrame.vue 的整屏壳 ⇒ 形状签名过期，这条判据已经在空扫`（`EXIT=1`）。
M2 新建一个页面手抄三段 ⇒ 红的是 `这些页面手抄了整屏覆盖壳而没有登记`。
⚠️ M1 第一发是**假证据**：`perl s///`（无 `/g`）命中的是第 19 行**注释**里那串同形文字，真实 class 没动，
判据照绿、`EXIT=0` —— 我一度把它读成"变异没生效"。按行号锚到 class 属性本体才拿到非零退码。
教训进记忆：**变异要锚"代码那处"，注释里的同形文字会让非零退码变成假绿**。

**下一批的配方（照这个做就不返工）**：先给探针 `favorites` 段加一条"桌面右栏宽度 ≈ 父容器剩余宽度"的成对读数，
**改前取基线**；然后二选一 —— (a) 让 frame 的 inline 根类带上 `flex-1` 并跑 `--only=links` 证另一家 inline 调用者
没被带偏，或 (b) 收藏详情保留自己的外层 div、只把**头部那三段**换成 `MobilePageFrame`（需要原语允许"只要头不要壳"，
那是第二个设计问题）。两条都要在同一轮里把 `:714` 的底部间距口径统一到 frame 那一档并做窄窗复看。

**净变化**：生产码 **0 行**（本批只加判据），`designGuards.test.ts` 是测试码不计入业务成果，
⇒ 本批**不新增** `Version-Bump:` 欠账（口径 = `isAppCodePath`，测试文件不算应用码）。

**读数（本批）**：`node --test src/utils/designGuards.test.ts` **165/165 exit 0**（163 → 165，㊼ 的形状 + 真实树两条）；
`npm test` **1103 pass / 0 fail exit 0**；`npm run build`（vue-tsc + vite）**exit 0**。
⚠️ **CDP 探针 NOT RUN，理由是"本批没有可跑的界面变化"**（生产码 0 行改动），不是"忘了跑"——
判据只在测试码里，界面行为逐字未变。
⚠️ 留给下一批的两条硬约束：① 改前必须先取"桌面右栏宽度"基线读数；② 迁移完成后
㊼ 的登记名单要**当场清空**（`OVERLAY_SHELL_COPIES` 删成 `[]`），留着名字 = 把判据变成过期借口。

---

### §6.71 · DOM 监听的「绑定 ↔ 解绑」数完：27 处逐点对账，最阴的一形是漏了 capture 的那次解绑（判据 ㊽）

**为什么先量这条**：任务书 P0 点名"事件泄漏"，而这一族是**静默失败**——漏解绑不报错、不掉帧，
只在长跑里长出来（与本仓那条未结的"Windows 长跑跳死、唯一无界候选＝常驻隐藏窗"是同一个形状）。
静默失败才配判据；响亮失败不用（同 §6.58 那条口径）。

**轴与分母（判据自己现算，不留第二把尺子）**：

```bash
node --test --test-name-pattern='㊽ 真实树' src/utils/designGuards.test.ts
# · ㊽ 分母：扫 205 份生产码 / 绑定点 27 处（动态旗标 0）/ 一次性登记 3 份 / 未配对 0 / 旗标不一致 0
```

⚠️ `grep -rn "addEventListener(" src` 数到 **29 行**，剥注释后 **27 处** ⇒ 差的 2 处活在注释里
（`initScope.ts:6` 那句"匿名 `addEventListener` 摘不掉"就是其中之一）。两把尺子读数不一致时，
先搞清哪一种数法对，再把对的写进文档 —— 反过来抄 grep 的数就是把守卫的口径写歪。
另：这里分母是 **205**（判据按目录走、含未跟踪文件），与 `frontend-inventory` 报的 git 跟踪口径 203 不是一把尺子，不许互相换算。

**三条判据**（按 `(事件名, 处理函数标识)` 配对、只在同一份文件内认账）：① 具名绑定而同文件没有解绑 ⇒ 点名；
② 匿名箭头函数按身份配不了对 ⇒ 只许出现在登记过的一次性文件里；③ **capture 旗标每一侧都必须一致**。

**三处一次性接线登记**（每条都带"为什么这不是泄漏"，且正控会抓过期借口）：
`boot/boot.ts`（启动期全局错误上报，早于任何组件）、`i18n/index.ts`（系统语言监听，模块单例）、
`composables/useBackLayer.ts`（`installed` 旗标保证全窗只挂一次）。

★ **本批最值钱的一条是判据自己被自己的变异抓出来了。** M2 第一次摘掉 `MessageItem` 一处解绑的
`{ capture: true }` —— **判据照绿**（`EXIT=0`）。原因不是变异没生效，而是规则当时写的是
"**至少一侧**对得上就行"，而 `swallowLongPressRelease` 在这个组件里有**两处**解绑（切换关闭 + 卸载兜底）：
漏掉其中一侧的那趟仍然是空解绑，而另一侧把判据哄过去了。⇒ 规则改成"**每一侧**都必须一致"，
同一发变异才红（`绑定侧 = capture，有 2/2 处解绑旗标不一致`），且**收紧后的真实树照绿**（0 处不一致）——
方向是收紧不是放宽，这点必须写成读数而不是写成态度。
配对判据写成"至少一个"和"每一个"的差别，只有在**同一对句柄有多个解绑出口**时才暴露；这种出口数量也要现数。

**三发变异各红各的一格（全部逐字节复原）**：M1 删 `ChatWindow.vue:959` 那行解绑 ⇒ `绑了 keydown onGlobalKey 但同文件没有解绑`；
M2 摘 capture 旗标（收紧后）⇒ 旗标不一致那句；M3 把 `i18n/index.ts` 的绑定整个摘掉 ⇒ 名单正控
`登记的一次性接线文件 i18n/index.ts 今天没有任何 addEventListener ⇒ 该从名单里删掉`。

**同轴撞出来的另一件事（记下来但不在这批动）**：这一族今天其实**有两个卸载机制并存** ——
`App.vue` 已把 4 条监听交给 VueUse `useEventListener`（组件作用域自动解绑，`grep -c "useEventListener(" src/App.vue` = 4），
其余 **27 处**仍是手写 `addEventListener` + 手写解绑。这不等于"重复实现该立刻合并"：
`useEventListener` 的自动解绑只在**组件作用域**成立，而 27 处里有 store / boot 级（非组件，没有卸载时机可挂）
与"条件性摘挂"（`MessageItem` 的长按兜底按开/关来回挂）——后者本来就要手动两侧。
⇒ 边界按三条判：**组件作用域 + 挂载即终身 + 无 capture/无 once 语义** 的站点才是 `useEventListener` 的合法迁移面；
剩下的保留手写并由 ㊽ 盯配对。这条属于 P1 的重复实现收敛，但它一次要过 15 份文件、且每份都要先按这三条分类，
故登记为下一批，不在本批顺手做（同 §6.70 的判法：能写清边界与验收面才动手）。

**净变化**：生产码 **0 行**（判据在测试码里）⇒ 本批**不新增** `Version-Bump:` 欠账。

**读数（本批）**：`node --test src/utils/designGuards.test.ts` **167/167 exit 0**（165 → 167，㊽ 的形状 + 真实树两条）；
`npm test` **1105 pass / 0 fail exit 0**；`npm run build` **exit 0**。
⚠️ **CDP 探针 NOT RUN**：本批没改任何生产码，没有可跑的界面变化；判据读的是源码文本，不是运行时状态。
⚠️ 这条判据**测不到**的一格：它证"解绑语句在不在、旗标对不对"，**不证"解绑真的执行过"**
（要证后者得在运行时数 `getEventListeners`/代理 `removeEventListener`，属探针的活，本批没做）。
⚠️ 提交时的基线欠账是**累计**的：`designGuards` 这三批 161 → **167**（§6.69 +2、§6.70 +2、§6.71 +2），
三批改动全在测试码 ⇒ 一次 `--update` → `--sync-baselines` → 再 `check` 就够，不用分三回补。

---

### §6.72 · 把"挂载即终身"那 5 处手写 DOM 监听交给 VueUse `useEventListener`，顺手合并掉管同一根轴的两条判据

**这批动的是应用码**，判据的三条边界（§6.71 立的）在这里第一次被拿来用：**组件作用域 + 挂载即终身 + 无 capture / 无条件摘挂**。
逐行读过、三条全中的有 5 处，全部迁到已装的 `@vueuse/core@14.4.0`（`App.vue` 早就这么用，不是新依赖）：

| 站点 | 原来 | 现在 |
|---|---|---|
| `ChatWindow.vue` `onGlobalKey`（多选态 Esc） | `onMounted(add)` + `onBeforeUnmount(remove)` | `useEventListener(window, "keydown", onGlobalKey)` |
| `SettingsWindow.vue` `onKeydown`（Esc 关窗） | 同上（`onUnmounted`） | `useEventListener(window, "keydown", onKeydown)` |
| `message/ImageLightbox.vue` `onKey` | 同上 | `useEventListener(window, "keydown", onKey)` |
| `ConversationList.vue` `closeFriendMenu` | `onMounted(add document click)` + `onUnmounted(remove)` | `useEventListener(document, "click", closeFriendMenu)` |
| `composables/useShortcuts.ts` `onKeydown` | 同上 | `useEventListener(window, "keydown", onKeydown)` |

真删掉的是 **10 条手写注册/注销语句**（5 组配对），换回 5 条库调用；连带清掉因此没人用的
4 个生命周期 import 名（`SettingsWindow` 的 `onMounted`/`onUnmounted`、`ImageLightbox` 的 `onBeforeUnmount`、
`ConversationList` 的 `onMounted`，以及 `useShortcuts.ts` 那整行 `from "vue"`）。⚠️ 行数几乎没变
（净 ±1 行级别）—— 这批的成果不是"少写几行"，是**卸载路径只剩一处会写错**：配对、迟到赋值、
capture 旗标这些都得由那个库来保证，而不是每个组件各自记得。

**没迁的那些，不是漏了，是不满足那三条**：`MessageItem` 的长按兜底要按开关来回挂（还要 capture 两侧一致）、
`TitleBar` 的解绑和 `listenerScope.dispose()` 同在一个 `onBeforeUnmount` 块里（拆成两处只为了迁库不值得）、
`GroupTasksBoard` 的 scroll 是 capture 相位且与 resize 成对、`stores/*` 与 `boot/*` 根本没有组件作用域。
⚠️ 其余站点（`MessageComposer` / `VirtualList` / `LogViewer` / `useBackLayer`）**本轮没逐行读过它们的解绑侧** ⇒ 不下判断，
留给下一批按同样三条一处一处过；写"没读过的原因"就是编。

★ **这条判据轴上原本挂着两个量具，迁移立刻把代价显形了**：除 ㊽ 之外，更早那册
`组件里的 DOM 监听必须有解绑路径` 也在管同一根轴（只扫 `.vue`、只比"有没有同 (事件,处理器) 的 remove"、
分母是一条硬编码 `registered >= 15`）。迁完这 5 处，`.vue` 侧手写注册从 14 掉到 10 ⇒ **它先红了**，
而 ㊽ 全绿。这就是"同一根轴两把尺子"的下场：任何人迁一次都得同时改两处数字。⇒ 删掉旧的那条、
只留 ㊽，并在原地留一段**取代关系**注释：㊽ 覆盖面更广（`.vue` **和** `.ts`）、多一条 capture 逐侧一致、
分母与正控各一条 —— 撤销旧断言不是放宽，是把同一语义指到更强的证据上。册数 167 → **166**。

**读数（本批）**：`node --test src/utils/designGuards.test.ts` **166/166 exit 0**（分母行现读：手写绑定点 22 处 /
VueUse 托管 9 处 / 未配对 0 / 旗标不一致 0）；`npm test` **1104 pass / 0 fail exit 0**；
`npm run build`（vue-tsc + vite）**exit 0** —— 类型层当场抓到过一次我改坏 import（脚本按 `\bnamed\(` 认"还在用"，
漏了 `computed<{…}[]>(…)` 这种泛型调用 ⇒ 把 `computed` 从 `SettingsWindow` 的 import 里错删了），
构建报出来才补回。**教训：批量清理 import 的判据必须认 `name<` 也算被引用。**
收尾全量运行时探针（`npm run test:ui-runtime`，日志 `/tmp/probe672.log`）**448/448 条判据绿、退码 0** —— 迁移没把
这五处所在组件的其他语义碰坏（探针里真挂 `ChatWindow` / `ImageLightbox` / `ConversationList` 的段落照旧全绿）。
★ **一把不为这批新写的尺子也对上了**：盘点机器段（`node scripts/frontend-inventory.mjs` 现算）里 `@vueuse/core`
的引用文件数 **8 → 13**（正好 +5 = 迁的 5 份文件），`vue` 的引用文件数 **90 → 89**（`useShortcuts.ts` 那整行
`from "vue"` 消失）。这两格是清单自己算的 ⇒ "真的接上了库"不由我数自己的语句来证明。

★ **但这 448 条**「各自替迁走的 5 条卸载路径背书」**是不成立的**，逐站点读探针源码数出来的覆盖：

| 迁移站点 | 探针是否真按过那一下 | 依据 |
|---|---|---|
| `ImageLightbox.vue` `onKey`（Esc 关 + 方向键切图） | **有**：`runLightbox` 挂的就是这份真组件（`probe host` 的 `lightboxMount()` 在 533 行 `install('/src/components/message/ImageLightbox.vue')`），6408 行真按 `ArrowRight`、6416 行真按 `Escape`，112 行那条判据绿 | 本组件里 Escape 出口**只有** `onKey`（274 行）一处：它用的是 `FocusScope` 而不是 Dialog，没有第二个会关它的处理器 |
| `ChatWindow.vue` `onGlobalKey`（多选态 Esc） | **没有**：`runPinKeyboard`（2618..2769）逐行只发 Tab / Enter | 该段零次 Escape ⇒ 这条路径仍只有静态证据 |
| `SettingsWindow.vue` `onKeydown`（Esc 关窗） | **没有**：探针从未挂过 `SettingsWindow` | —— |
| `ConversationList.vue` `closeFriendMenu`（点名单外收起） | **没有**：5602 行挂它的是"姓名过滤"那一段，好友菜单的开/收没有任何判据 | —— |
| `useShortcuts.ts` `onKeydown` | **没有**：探针从未挂过它 | —— |

⚠️ **这条读数是差点被量具骗出来的**：我最初打算写"这 448 条里一次 Escape 都没有"，依据是
`grep -c "Escape" /tmp/probe672.log` = **0**。那个 0 不证明"没按过 Esc"，它只证明**探针日志不打印按键名**。
真按键在源码里有 11 处 `Escape` 字样（8 处 `cdp.key("Escape", …)` 发键 + 1 处注释 + 2 处页面内 `e.key === 'Escape'` 监听）。
**"日志里查不到"与"这件事没发生"是两件事 —— 覆盖度只能从发射按键的那份源码数。**

⚠️ **要用户真机看的（这批改了键盘与点外部关闭的路径）**：① 多选态按 Esc 只退多选、不连带关转发/删除确认；
② 设置窗 Esc 关掉且弹层开着时 Esc 先关弹层；③ 好友菜单点开后再点别处要收；④ 全局快捷键仍生效。
⑤ 图片灯箱的 Esc / 方向键**探针已经按过真键并绿**，真机只剩一眼 iOS WKWebView（探针跑的是没有 Tauri 的页面，
它不替 WebKit 的键盘事件语义作证）。桌面 + Android 各走一遍。⚠️ 本批改了应用码 ⇒ 与 §6.66/§6.68/§6.69 同一笔
`Version-Bump:` 欠账一起补。

### §6.73 · 把 §6.72 写在文档里的那两条"不迁理由"拿去读**库的实现** ⇒ 一条被推翻、一条被证伪；7 处交出去，分母改成守恒量

上一批收尾时我在报告里留了两条"这些手写不迁"的理由。这一批不重新数轴，而是**去读那两条理由本身站不站得住**
——读的是装在那儿的那份实现（`@vueuse/core@14.4.0`，`node_modules/@vueuse/core/dist/index.js:188-213`，不是我猜的 API 文档）：

- ★ **被推翻的那条：「带 capture 所以不迁」，方向正好相反。** 实现里 `register(el, event, listener, options)` 先
  `addEventListener(event, listener, options)`，再把**同一个 `options` 克隆**闭进返回的注销函数
  （`190-191` 两行），且整个注册跑在 `watchImmediate(...)` + `onCleanup` 里 ⇒ **两侧旗标由构造保证一致，不可能只改一侧**。
  而 §6.71 的 M2 变异抓到的正是"手写时摘掉一侧旗标 ⇒ 那趟解绑是空操作且不报错"这一族 ⇒
  **capture 站点是这条轴上最该交给库的那一类，不是最不该**。`GroupTasksBoard` 的 `scroll`（必须 capture，scroll 不冒泡）
  与 `resize`（不需要）那一对就是一真一假的手写形状，今天迁了。
- ★ **被证伪的那条：「解绑和其它清理同在一个卸载块里 ⇒ 拆成两处只为迁库不值得」。** 这是**自相矛盾**——
  §6.72 自己迁的 `ChatWindow` 就是同一个情况（它的 `onBeforeUnmount` 里还留着 `dragDropScope.dispose()`），照样迁了。
  ⇒ 按这条理由留下的 `TitleBar` 也迁了。**教训：写进文档的"理由"和代码同样是断言，也要被复查**，
  否则一条含糊的理由会变成永久不做的事实。
- **仍然成立的那条：条件性摘挂**（`if (on) add; else remove` / 按开关来回挂）——库这一份**没有 `when` 选项**
  （读到的实现只有 target/event/listener/options 四个入参），要做条件挂只能用"把目标传成 `computed(() => on ? document : null)`"
  这种写法（实现会过滤 `e != null` 并在空目标时直接 return）。这个写法**故意不采用**：它把"挂与不挂"藏进一个假目标里，
  读代码的人必须先看库源码才懂；而且 `GroupTasksBoard` 的粘贴订阅与 `subscribeImageDrop()`（一条 **IPC 往返**，
  注释写明"退订发生在往返途中时迟到函数仍须执行"）在同一只 `watch` 里成对出现，拆开挂到响应式目标上会动那只 `InitScope` 的语义
  ⇒ 属规则 6 禁止的那类"为了用库加的一层间接"。

**这批真迁的 7 处**（都是"组件作用域 + 挂载即终身 + 无条件摘挂"，capture 已不再是障碍）：

| 站点 | 处理器干什么 | 迁完之后 |
|---|---|---|
| `TitleBar.vue` `onKeydown` | 窗口控制快捷键（其中一条走 `api.windowClose()`） | 卸载块只剩 `listenerScope.dispose()` |
| `GroupTasksBoard.vue` `onScrollOrResize` ×2 | 滚动/缩放时收起行菜单（虚拟锚点会跟丢） | `onMounted` 整块删掉，`onUnmounted` 只剩 `closeRowMenu()` |
| `LogViewer.vue` `onVisibility` | 窗口重新可见立刻补一次拉日志（不等下一个 2 s 周期） | 两个块都留下别的职责 |
| `VirtualList.vue` `onResize` | 窗口尺寸变了重测行高 | 首帧显式 `onResize()` 一字未动 |
| `MessageComposer.vue` `onDocClickForMention` + `onSelectionChange` | @ 候选列表点别处收起 / 选区变化 | `onMounted` 整块删掉，`onUnmounted` 只剩 `clearTimeout(shakeTimer)` |

真删的是 **7 条注册 + 7 条解绑 = 14 条语句**，换回 7 条库调用，连带清掉 2 个失去用途的 import 名
（`GroupTasksBoard` 的 `onMounted`、`MessageComposer` 的 `onMounted`——按上一批的教训，**连同 `name<` 形状一起核过**才敢删）。
⚠️ 语义有一处**真实但无害**的变化：库在 `setup` 里同步注册（`watchImmediate`），原先是 `mounted` 之后。
处理器全是 `function` 声明（提升），且这些事件（keydown / resize / click / selectionchange / visibilitychange）
在 setup 与 mounted 之间不可能到达 ⇒ 行为不变；这条不是猜的，是按"声明形态 + 事件种类"两处读过的。

**这根轴今天全貌（㊽ 现数，不再手抄）：22 → 15 处手写 / 9 → 16 处走库 / 一次性登记 3 份 / 未配对 0 / 旗标不一致 0。**
剩下的 15 处手写，逐格都有名字和理由：**条件性摘挂 4 处**（`GroupTasksBoard` 粘贴、`MessageItem` 的 touchend / touchcancel /
selectionchange——后三条还带 capture 与"卸载兜底"那第二处出口）；**没有组件作用域 11 处**（`boot/boot.ts` 1、`i18n/index.ts` 1、
`composables/useBackLayer.ts` 1 匿名、`stores/useAppStore.ts` 7、`stores/useChatStore.ts` 1）⇒ 这两族**保留手写**，
不是"还没轮到"。

★ **量具跟着改了一条口径（这次不是重定下限，是把下限换成守恒量）**：分母原先钉"手写 ≥ 20"，每迁一次就得手动重定一次
——那是**量具在跟着被量的东西走**。读实现发现这条轴上守恒的是**两个家加起来**：手写面 27→22→15，走库面 8→9→16，
而 **27+8 = 22+9 = 15+16 = 31**（每一处迁移动手的就是"少一条 addEventListener、多一条 useEventListener"）。
⇒ 主判据改成钉**总数下限 28**，两个家各自的存在下限（≥13 / ≥15）退成"这一侧不许静默清零"的兜底。
**非空转**：N1 把统计库调用的正则改坏 ⇒ `两个家加起来只数到 15 处…（手写 15 + 走库 0）` 红；
N2 把统计手写的正则改坏 ⇒ `…只数到 16 处…（手写 0 + 走库 16）` 红；两次都 `diff -q` 证过复原，复原后重跑退 0。
⚠️ **这条下限管不住"只删一处监听"**（31→30 照绿）——它管的是"量具空扫 / 整批消失"；
少一条监听归配对判据与探针，不许反过来写成"这条判据能发现漏删"。

**读数（本批）**：`node --test src/utils/designGuards.test.ts` **166/166 exit 0**；`npm test` **1104 pass / 0 fail exit 0**；
`npm run build`（vue-tsc + vite）**exit 0**；收尾全量 CDP 探针 **448/448 条判据绿、退码 0**（日志 `/tmp/probe673.log`）。
⚠️ **这 448 条对这批 7 处的覆盖边界（按 §6.72 立的规矩读探针源码数，不读日志）**：**没有一条是为这 7 个处理器写的专项断言**。
唯一算"被真实输入顺带执行到"的是 `MessageComposer` 那条 document click —— `inputpanel` 段在**真挂着这份组件**的时候发了多次真点
（那两条"真点之后表情面板由 Reka Portal 挂到 body"与"真点『发送』按钮也 emit send"就是它），
而"点别处 ⇒ @ 候选列表收起"这件事本身**没有断言** ⇒ 那段的绿只背书"这条监听在跑、别的东西没被它弄坏"，
不背书它把列表收起来了。这跟 §6.72 灯箱那条不是一级（那条是专项断言 + 组件里只有已迁的那一个 Escape 出口）。
其余 6 条（`TitleBar` keydown、`GroupTasksBoard` scroll/resize、`LogViewer` visibilitychange、`VirtualList` resize、
`MessageComposer` selectionchange）探针**一次都没让它们跑到可判读的结局** ⇒ 不许写成"运行时已验"。
⚠️ **这一格在 §6.74 往前推了一步**：`MessageComposer` 那条 document click 现在有**专项断言**，
而且归因是单点变异跑出来的（摘掉那条监听当场红）；剩下 6 处仍是"只有静态证据"。
（**§6.76 又补了台账那一格** —— `GroupTasksBoard` 的 `scroll`(capture) + `resize` 现在有 3 条运行时判据、两发单点变异各点一面
⇒ 这句话在写下时是 6 处，**现读是 5 处**；剩下 5 处见 §6.76 的读数段。别把这一格读成"7 处都验过了"。）
★ **另一把尺子把我的直觉数纠正了一次**：清单机器段（`node scripts/frontend-inventory.mjs` 现算）里 `@vueuse/core`
的引用文件数是 **13 → 17**，而我按"迁了 5 份文件"写的预期是 +5。差的这一份不是漏迁：
`git show HEAD:src/components/LogViewer.vue | grep -c "@vueuse/core"` 现读 **1** ⇒ 那份文件本来就在 import 这个库，
这一批只是让它多了一行，**引用文件数不动**。`vue` 的引用文件数 **89 → 89**（没让任何文件彻底脱离 vue），
生产码总行 **42,843 → 42,842**（净 **−1**）。⇒ **两个家加起来 15 + 16 = 31 这条守恒量，与清单的"引用文件数"是两个不同分母，别互相换算**；
而"我预期的那个数"永远不是证据 —— 撞上之前就把它当假设去核。
⚠️ **要用户真机看的（这批改的全是"用户能碰到的那一下"）**：① 输入框 @ 候选列表点开后再点别处要收，选中文字仍会同步；
② 群任务台账：滚动列表或缩放窗口时行菜单要收起（Android 上也试一次）；③ 草稿弹窗关掉之后**再粘图片不许进图**；
④ 日志页切到别的窗口再切回来应立刻刷新（不是等 2 s）；⑤ 虚拟列表在窗口改大小后不出现空行/遮挡（聊天窗与日志窗各看一次）；
⑥ 标题栏那条关闭窗口快捷键仍生效且不误伤输入。桌面 + Android 各走一遍，iOS 至少走 ①②。
⚠️ 本批又改了应用码 ⇒ `Version-Bump:` 欠账并入 §6.66/§6.68/§6.69/§6.72 那一笔；`designGuards` 161 → 166 ⇒ 提交前测试清单基线
`--update` → `--sync-baselines` → 再 check。**下一批不在这根轴上继续**（该迁的迁完、该留的都点名了），回到 §6.70 那格
（收藏页整屏壳，改前先取桌面右栏宽度基线）与"排版令牌归属"那两档。

### §6.74 · 把 §6.73 自己登记的那格覆盖空洞补上：给"点卡片外收起 @ 名单"加一条运行时间断言

上一批收尾时我写下"这 7 个迁库的处理器没有一个拿到专项断言"。**登记洞不是补洞**，所以这一批就地补了最有咬合力的那一条
（`scripts/check-ui-runtime.mjs` 的 `runInputPanels` 末尾，只改编发脚本，业务码一字未动）：

- 断言形状：**点开 @ 名单** → **真点视口左上角（离贴底的输入卡片最远，一定在 `.gosslan-composer` 之外）** →
  名单必须消失，**而编辑器里那个 `@` 必须还在**。
- ★ **"草稿里那个 @ 还在"是关键的那一半**：只有名单状态被清、草稿没被动，才是 `onDocClickForMention` 干的；
  把草稿清空的是发送那条路（同段前面刚验过）。**没有这半句，"列表不见了"会被"顺手清了一次草稿"混过去** ——
  这正是"一条判据要能分开两种成因"那条纪律（§探针册 hover 那一节同款）。
- **归因不是论证出来的，是变异跑出来的**：把 `MessageComposer.vue` 里那一条
  `useEventListener(document, "click", onDocClickForMention)` 摘掉 ⇒ 该段 **23/24、退码 1，红的正是这条**；
  `cp` 复原后 `diff -q` 报相同、重跑 **24/24 退码 0**。⇒ 这条监听**确实是运行时把名单收起的那个东西**，
  而不是"组件里恰好还挂着别的出口"。
- **读数**：`--only=inputpanel` 由 **23/23 → 24/24 exit 0**；变异轮 **23/24 exit 1**；复原轮 **24/24 exit 0**；
  收尾全量（含这一条新判据）见下一行 —— 探针条数每次都是它自己打印的，别处不许手抄。收尾全量重跑 **449/449 条判据绿、退码 0**（448 + 这条 = 449；条数只由探针自己打印，`grep -o '[0-9]*/[0-9]* 条判据绿' /tmp/probe674full2.log`）。
  ⚠️ **同一条命令的第一趟不算这批读数，但值得留案**：它在 `runOverlay` 里挂住 ⇒ **264/265、退码 1**，红的正是那条元判据「探针自己跑完了（没在半路抛错）」，
  文案写着「CDP evaluate 45 s 无回包 ⇒ 这一格记没跑，不是产品红」。那一趟**根本没跑到新加的那条** —— 派发序列里 `runOverlay` 排在 `runInputPanels` 之前
  （现读 `scripts/check-ui-runtime.mjs:2382` vs `:2386`），所以 265 既不能当这批的收尾读数，也不能反过来读成「新断言把页面弄挂了」。归因现场都核过：
  起跑前 9444/5199 若被占，前置门会当场退 1 而那一趟照常打印了 dev server 行；跑时机器上只有我一个探针进程 + 它自己那台 vite；`src/` 最近 6 分钟零写入。
  ⇒ 记为**量具单次抖动**（第二趟走同一位置照过）。那趟留下的僵尸 CfT（PPID=1、profile 在 `/tmp/gosslan-probe-*`）占着 9444 是我手动 `kill` 掉的 ——
  这正是那条前置拒收门要挡的形状，但它只挡**起跑**，不回收**跑挂之后**的现场；下次跑前先 `lsof -nP -iTCP:9444 -sTCP:LISTEN` 看一眼。
- ⚠️ 这条**不改变**上一批的真机清单：`TitleBar` 窗口快捷键、`GroupTasksBoard` 滚动/缩放收行菜单、`LogViewer` 切回来即刷新、
  `VirtualList` 改窗后不空行、`MessageComposer` 选区同步、以及"关掉草稿后再粘图片不许进图"，仍然只有静态凭据。
  （**§6.76 之后**：台账那一格拿到了 3 条 CDP 侧判据（其中 scroll 那根事件是合成的），所以「缩放改窗收菜单」这一条
  已不是"只有静态凭据"；但**"用户真的用手指滚列表"这一条仍在真机清单上** —— 合成事件不替真机验收。）
  ⚠️ 本批**没改应用码**（`scripts/` 属开发工具）⇒ 不新增 `Version-Bump:` 欠账，也不占五处版本清单。

### 6.75 收藏页那格整屏壳：把"欠着迁"拿去读实现，判成保留自研，并把理由钉进判据自己（10-20）

待办原本写的是「迁给 `MobilePageFrame`，并把 `OVERLAY_SHELL_COPIES` 清成 `[]`」。按 §6.73 那条教训办：**登记册里的"欠着"和文档里的"理由"一样都是断言，动手前先读实现**。三步都在读码阶段就能判完，实测三处：

1. **父亲的主轴**。`src/components/FavoritePanel.vue:688` 那个 `<div>` 的父亲是 `:582` 的 `flex min-h-0 flex-1`（没写 `flex-col` ⇒ 默认 **row**），所以桌面那一支的 `flex-1` 管的是**宽度**（`flex-basis:0%`+grow 打在横轴上，把左列之外的剩余宽度吃掉）。而 `MobilePageFrame` 的 `inline` 写的是 `flex h-full min-h-0 flex-col`（`:55`，**没有 `flex-1`**）—— 换过去右栏退成按内容收宽。同一份文件 `:597` 的注释自己就写着这个轴是横的（"`desktop:sm:flex-none` 不能省：`flex-1` 把 `flex-basis` 设成 0%，会让下面的 width 失效"），左列正因为这个才必须 `flex-none`。`overlay` 那一支更接不了：`fixed inset-0` 会把详情从流里摘走并盖住左列。
2. **拆支要付的代价**。移动端那一支确实和 `overlay` 同串（壳 + 头部逐字相同），但要用上库就必须把**同一个元素拆成两支**，而里面这块详情正文实测 **L688–L881 = 194 行 / 9 处 `@click`（8 个不同处理函数：`onFavBack` `previewImage` `copyItem` `startForward` `openItem` `saveItem` `locate` `askDelete`）/ 28 个绑定标识符 / 2 个自定义子组件**。⇒ 要么把这 194 行抄第二份（比这条轴本来要防的事更糟），要么抽成 `FavoriteDetail.vue` 再向下传 8 个回调。为消掉**两行 class 串**新造一层业务组件，正撞上 §七.6「不为追求通用性增加不必要的层级」。
3. **一处会静默改行为的量纲差**。壳内那层滚动的底部留白，收藏页写 `pb-[max(env(safe-area-inset-bottom),0.75rem)]`，框架的 `.safe-bottom`（`src/style.css:722-724`）= `padding-bottom: env(safe-area-inset-bottom)`，**没有 0.75rem 兜底**。桌面浏览器与无上栏手势条的 Android 上 `env()` 取 0 ⇒ 迁过去同一点从 12px 变 0px。这不是"写法看着不一样"，是同一个动作在不同端量出不同像素。

**判定（六档）：保留自研。** 依据不是"跑得好好的"，而是形状本身：这一格是**一个元素同时 serve 两支布局**，`MobilePageFrame` 的两个 mode 各只盖住一支，另一支的「流内 + 按剩余宽度伸展」无法由 mode 表达。判据 ㊼ 的 `OVERLAY_SHELL_COPIES` 因此**保持 1 格**，但那格里由"没迁"改成上面这三条 —— 下一批不必重新发现，也不许当默认豁免读（新增同形照旧红）。

⚠️ 这条**不构成**"框架多余"的反证：设置 / 日志 / 链接 / 资料那几页是**纯移动端整页**（没有桌面内嵌的另一支），它们走 `MobilePageFrame` 是对的，这一轴也确实只剩一个家 + 一格点名过的例外。

复跑命令（三条都静态可核）：`sed -n '582p;597p;688,692p' src/components/FavoritePanel.vue`、`sed -n '52,55p' src/components/MobilePageFrame.vue`、`sed -n '722,724p' src/style.css`；194/9/28 那两个数是剥 `<!-- -->` 后按 `<div>/<Transition>` 标签配对现数的（口径同 ㊼：**不按行**，按标签块）。⚠️ 第一遍我用没剥注释的粗解析数过一次，注释里那句 `<main>` 被当成开标签、深度全错 —— 缺席与结构类判据的同一课第二次撞上来。

★ **教训：「清成 `[]`」这种待办写法本身藏着假前提** —— 它默认剩下的每一格都迁得动。判一格能不能迁的最小序列是 (a) 认父亲主轴（`flex-row` 还是 `flex-col`，默认 row）、(b) 认库那几个 mode 各自写出哪些属性、(c) 数拆支要付的正文行数与回调数。三步都在读码阶段，不动码就能判完；省掉这三步就直接动手，会在第 (c) 步付一份不可回收的新抽象层。本批**没改应用码** ⇒ 不新增 `Version-Bump:` 欠账。

### 6.76 台账那一对交给库的 window 监听：运行时各咬一面，capture 那一面用冒泡相探针正面证（10-20）

接的是 §6.74 自己登记的那句「另外 6 处仍只有静态凭据」。补的是**形状最有意思的一格**：`GroupTasksBoard` 交给库的
`scroll`（带 capture）+ `resize`（不带）这一对 —— §6.71 的 M2 变异抓的「两侧旗标不一致」正是这根轴的真缺陷形状。

- **三条判据**（都加在 `runTasksMobile` 里，不新开段）：① 开局核对 —— 行菜单打得开、行**确实挂在** `div.overflow-y-auto` 里、`window.scrollY=0`；
  ② 从**行自己那层**发一根 `bubbles:false` 的 scroll ⇒ window 上的**冒泡相探针收不到**（`bubSawIt===false`，正面证明这根事件到不了冒泡相）
  而菜单**从 DOM 里被撤掉** ⇒ 收它的只能是组件那条带 capture 的 window 监听；③ 改视口尺寸（真 `Emulation.setDeviceMetricsOverride`）⇒ 同一个菜单也被撤掉。
  三条读的都是**撤掉**而不是**看不见**：Reka 自己只会隐藏浮层，撤掉才说明跑的是我们的 `closeRowMenu`。
- ★ **读事件路径那一发是量具坏了，不是现象不符**：原先写 `ev.composedPath().some((n) => n === window)`，实测读到 `false` **而菜单确实被撤了**。
  原因是派发结束后 `composedPath()` 已被清空 ⇒ 永远得到空数组。**判据红、现象绿这种自相矛盾，先怀疑尺子再动判据。**
  换成「在 window 上临时挂一根冒泡相探针、派发完立刻摘掉」之后，读到的正是这件事本身（这根事件到不到得了冒泡相）。
- **两发单点变异各点自己那一面**：M1 摘掉 `, true` ⇒ **3/5 退码 1**，红的正是第二条；第三条同时红是**级联**、不是独立咬合
  （`openRowMenu` 点的是同一枚 toggle 入口，第二条没把菜单关掉时它反而把菜单关回去）⇒ 这条链只能记「3/5 里有我想要的红」，
  不许写成「两条各自能红」。M2 摘掉 `resize` 那整条 ⇒ **4/5 退码 1**，红的只有第三条（这发才是干净的一格一红）。
  `cp` 备份 + `diff -q` 报相同 ⇒ 复原后 **5/5 退码 0**。
- ⚠️ **覆盖面要说清**：第二条的事件是**合成的** —— 它审的是**注册旗标**（捕获相收不收得到从后代元素上来的这根事件），
  不是「用户真滚动时 Chromium 会不会发 scroll」。为什么不用真滚动：面板形态那层 `overflow-y-auto` 根本不受高
  （`GroupTasksBoard.vue:1062` 的 `min-h-0 flex-1` 挂在 `standalone` 上，实测 `scrollHeight-clientHeight = 0`），而窗口形态
  （真实调用点 `GroupTodosWindow.vue:173`）在本探针里会先卡在 `todosLoadedOnce`（`GroupTasksBoard.vue:321`）⇒ 渲染空列表。
  ⇒ **「滚动列表看菜单收不收」仍在用户真机清单上，这条没有把它划掉。**
- **读数**：`--only=tasksmobile` **2/2 → 5/5 退码 0**；M1 **3/5 退码 1**；M2 **4/5 退码 1**；复原 **5/5 退码 0**。
  收尾全量 **452/452 条判据绿、退码 0、日志内 ❌ 计数 0**（449 + 这三条 = 452；条数只由探针自己打印，
  复跑 `grep -o '[0-9]*/[0-9]* 条判据绿' /tmp/probe676full.log | tail -1`）。
  运行时那一格由此从 **1/7** 变 **2/7**（`MessageComposer` 的 document click + 台账这一对 window 监听）；
  剩下 5 处（`TitleBar` 窗口快捷键、`LogViewer` visibilitychange、`VirtualList` resize、选区同步、关掉草稿后不许再粘图）**仍只有静态凭据**。
- **本批没改应用码**（只动 `scripts/`，`isAppCodePath` 只认 `^src/` 与 `^src-tauri/src/` 且排掉 `*.test.ts`）⇒ 不新增 `Version-Bump:` 欠账，也不占五处版本清单。

### 6.77 新开一根轴「同一个处理器被两条机制驱动」：全仓扫完 = 1 处多驱动、0 处可删（并把我自己那条"冗余"论证读没了）（10-20）

起因是 §6.76 途中撞上的：`VirtualList` 的 `onResize` 同时被 window 监听（§6.73 交给库的那条）与容器 `ResizeObserver` 驱动。
目标④点名要减的就是**重复事件处理**，而这根轴以前没人数过 ⇒ 现扫 205 份生产码（剥注释、认 `useEventListener` / `addEventListener`
的**具名**处理器、只数真调用点、驱动源取"回调后 300 字符窗口内出现该调用"）⇒ **一处**：`VirtualList.vue` handler=`onResize`
真调用点 2、另一驱动 = `new ResizeObserver(` + `onMounted(`。

- ★ **两把坏尺子各造了一种假阳性，全靠一个正控抓住**：① 择一式写成 `watch\(|watchEffect\([\s\S]{0,240}?h\(` ⇒ 文件里只要出现**任何** `watch(`
  整条就为真，报了 12 行废话；② 数调用点时把 `function h() {`（定义）与 `useEventListener(..., h)`（注册，后面没有 `(`）也算成调用 ⇒ 又报 2 行。
  两版改严之后 **VirtualList 那一格必须还在名单里**（它就是"已知为真"的正控）—— 少了的行才允许读成"少了假阳性"而不是"漏了真的"。
- ★ **我上一条"这条监听是冗余、可以删"的论证被自己读的实现推翻了**（同一格、写文档到执行之间那一步读码救回来）：
  读 `computeScrollState()` 全文才看见它**不只重算视口**，还带副作用 —— `nearBottom` 变了 `emit("nearBottom")`、`scrollTop < 60` 时 `emit("loadMore")`。
  而观察者的回调带 `h !== viewport.value` 守卫 ⇒ **只变宽（容器高不变）那一类窗口 resize 只有 window 这条路会跑到重算与再广播**。
  ⇒ 两条机制不等价，这一格**不删**，判定 = **保留自研**（`GroupTasksBoard` 那一对是"同一件事的两侧"，这一对是"两件不同的事"）。
  复跑对证：`sed -n "$(grep -n 'function computeScrollState' src/components/VirtualList.vue | cut -d: -f1),+30p" src/components/VirtualList.vue`、
  `grep -n "onResize" src/components/VirtualList.vue`、`grep -n "h > 0 && h !== viewport.value" src/components/VirtualList.vue`。
- ★ **通用一条：判"两条机制做同一件事"必须读那条机制*除了赋值还干什么***。我只读了 `onResize` 的头两行（`viewport = clientHeight`）
  就判成冗余、写进记忆与工单，差一步就把它删了。删"看起来重复"的代码前的最小动作是把它调用的函数**读完**，
  尤其看里面有没有 `emit` / 计时器 / 全局广播这类副作用 —— 这与 §6.73「写下来的不迁理由也要复查」是同一条纪律的另一半。
- 本批**没改应用码**（扫描脚本在 `/tmp`，仓库里只动了文档）⇒ 不新增 `Version-Bump:` 欠账。这根轴到此数完，
  剩下的候选还是 §6.68 那两档（排版令牌归属、265 处内联 `text-[NNpx]`）与 §6.69 那条窄窗遮挡判据。

### 6.78 CSS 令牌那根轴的「定义了没人消费」半边：4 格逐格点名 + 写理由，数量上限换成登记册（10-20）

§6.68 立 ㊺ 时，正向半边（`var(--gosslan-*)` 找不到定义 ⇒ 红）判红了缺陷，反向半边只钉了「**无人消费 ≤ 6 个**，每轮打印名字」。
这半边有两个问题：① 数量上限意味着第 5、6 个没人读的名字可以混过去；② 它不交代**这几格是什么**，于是下一批只能重新查一遍 ——
或者更糟，当成死令牌删掉（我今天差点这么干了两次，一次是收藏页壳、一次是台账监听）。

- **现读 4 格**（㊺ 自己打印：`扫 305 份 / 消费点 1548 处 / 定义 76 个 / 未定义 0 / 无人消费 4 个`）：
  `--gosslan-item-radius` = `docs/design-guidelines.md:44` 明写的**语义别名契约**（值统一来自 `radius-md`，给旧名留的），
  `--gosslan-text-title/callout/footnote` = `src/style.css:63-66` 的**字号阶梯**，也就是那 265 处内联 `text-[NNpx]` 的**目标档**（还没接线）。
  ⇒ 四格都判**保留自研**：删掉它们等于把迁移目的地和一份对外契约一起删掉，而 265 处内联值还在原地。
- **量具改形**：数量上限 → **逐格点名 + 每格写理由 + 反向钉**（登记的每个名字今天必须仍然处于"定义但无人消费"，
  被接上了或名字拼错就红），与 `DYNAMIC_WRITERS` 那条白名单同一个四件套口径。注释里写明**这是收紧不是放宽**。
- **非空转是一发跑出来的**：把 `--gosslan-text-title` 这一格登记名改错一个字 ⇒ ㊺ 真实树那条 **165/166、退码 1**，
  红的消息正是「新增了"定义了却没人消费"的令牌且没登记理由」；`cp` 备份 + `diff -q` 报相同 ⇒ 复原后 **166/166 退码 0**。
- ⚠️ 这根轴**没有**因此变短：`text-[NNpx]` 那 265 处仍是 P3 那格欠的活，且它属于"改完必须真机看字号观感"的一类（我这边只能给静态与运行时凭据，
  给不了观感）。下一批要么接线要么继续挂着，**不许**为了消掉这 4 格而删令牌。
- **本批只动判据与文档**（`src/utils/designGuards.test.ts` 是测试文件，`isAppCodePath` 排掉 `*.test.ts`）⇒ 不新增 `Version-Bump:` 欠账。
  读数：`node --test src/utils/designGuards.test.ts` **166/166 退码 0**；变异轮 165/166 退码 1；复原轮 166/166 退码 0；
  快速层 `npm run verify:local`：**22 步全通过、共 72.3 s、退码 0**（复跑 `npm run verify:local`；`tail -1 /tmp/vl680.log`）

### 6.79 日志窗那条 `visibilitychange`：把竞争驱动关掉才谈得上归因，并跑出一根新轴「同一个谓词被两处守卫」

- **动机仍是行 46/§6.74 自己写下的那句**：「登记洞 ≠ 补洞」。§6.73 收尾时那 7 处迁库监听里只有 1 处拿到运行时凭据，
  这一批补第 3 处（`LogViewer.vue:174` 交给库的 `useEventListener(document, "visibilitychange", onVisibility)`）。
  **现读 3/7**：MessageComposer 的 document click（§6.74）、台账 scroll(capture)+resize（§6.76）、日志切回来即刷新（本节）。
  仍欠 4 处：`TitleBar` 快捷键、`VirtualList` 改窗不空行、`MessageComposer` 选区同步、关掉草稿后不许再粘图。
- ★ **归因不靠时间差，靠拆掉竞争驱动**。这条链有两个驱动：2 s 的 `setInterval(load)` 和那根事件。原本想到的写法是
  "读一次比 2 s 快"，那仍然是**猜**。改成**先点掉自动刷新开关**（`LogViewer.vue:263` → `syncTimer()` → `clearInterval`），
  此后 `api.getLogs` 的调用方只剩 `onMounted`（已经发生完）和我手工发的那根事件 ⇒ 「+1 只能来自那条监听」是构造出来的，不是推断的。
  配套给夹具加了一条通用出口 `H.apiCalls(name)`（`stubApi` 顺手计数）：**这种断言只能数调用次数，读内容读不出来**。
- ★ **正控先行**：不先证明"开着时确实在轮询"，"关掉后调用数不动"可能只是因为压根没跑过。所以顺序是
  静置 2.3 s 看到调用数增加 → 点掉 → 静置 2.4 s 看到不动 → 才轮到正反两格。
- **两发单点变异，一发打红、一发打掉我自己的一句大话**：
  - **M1** 摘掉 `:174` 那一条注册 ⇒ **10/11、退码 1**，红的正是「切回前台 +1」那一格（读数 `cHidden:2 / cShown:2`），其余全绿。
  - **M2** 摘掉处理器里的 `if (!document.hidden)`（`:176`）⇒ **11/11 全绿**。这直接**证伪**了我本来要写的
    "反向那一格证明处理器的条件"：`load()` 自己在 `:148` 已经判过同一个谓词，所以"后台时不发请求"这个结局
    **两处守卫都能给**，那一条判据分不开它们。⇒ 新开一根 §6.77 的姊妹轴：**同一个谓词被两处守卫**
    （`LogViewer.vue:148` 与 `:176`）。判定 **保留原样**：删掉处理器那一层行为等价（M2 就是证据），但那句话是处理器的
    契约表达，而且改应用码要新造版本欠账 ⇒ 不为省一行动它。**"冗余"与"可删"之间隔着一发变异。**
- ★ **判据依赖的环境量，要么钉住要么打印，不能既依赖又不看**。这段原本"挂载后渲染出日志行"那条断言一直在读
  `document.hidden` 的**原生值**（`load()` 第一句就 return），而本探针页的可见性并不恒定——这个文件里已经有两处
  为它写的纪律（焦点模拟那段、出帧泵那段）。现在把"前台"钉成夹具的一部分（用户读日志时窗口必然在前台），
  并把原生读数**打印**出来：本轮实测 `hidden=false / visibilityState=visible`。离开本段时 `delete` 自己的覆写还原，
  并加了一条"还原后仍能读到原生 boolean/string"的外溢守卫（`App.vue:57`、`useChatStore` 多处也读这个值）。
- **栽回去的一次（量具坏，不是产品坏）**：第一次跑 **9/10**，红的正是"点掉自动刷新"那格，读数
  `{found:true, before:"true", after:"true"}`。原因是**同一次 `cdp.eval` 里读不到 Vue 翻面后的 `aria-pressed`**
  ——Vue 把 DOM 写入排在微任务，而 evaluate 那段脚本是同步跑完的 ⇒ 拆成"点一次、下个 evaluate 再读"才成立。
  判据红 + 现象绿 ⇒ 先怀疑尺子，这次尺子确实错在我手里。
- **读数**：`--only=logs` 5/5 → **11/11 退码 0**（复跑 `npm run test:ui-runtime -- --only=logs`，`grep 判据绿 /tmp/p679d.log`）；
  M1 轮 10/11 退码 1；M2 轮 11/11 退码 0（＝盲点证据）；复原轮 11/11 退码 0；
  快速层 `npm run verify:local`：**22 步全通过、共 59.9 s、退码 0**（复跑 `npm run verify:local`；`tail -2 /tmp/vl679.log`）；
  台账 5 列形状修复后 `node scripts/frontend-inventory.mjs --check`、`check-doc-numbers`、`check-doc-citations` 三条各退 0。
  本批**只动 `scripts/`** ⇒ 按 `isAppCodePath` 不新增 `Version-Bump:` 欠账；`LogViewer.vue` 被两次临时改写后 `cp` 复原 + `diff -q` 报相同
  ⇒ 应用码零变化（`git diff --stat src/components/LogViewer.vue` 只剩 §6.73 那一批的内容）。
- ⚠️ **别把这格读成"真机验过了"**：合成 `visibilitychange` 审的是**注册在不在、处理器走哪条分支**，
  它不证明"最小化/切后台时 WebView 真的会发这根事件"。真机那条仍是他的活：把日志窗最小化再切回来，看列表是不是立刻换到最新几行
  （而不用等 2 s）。iOS/Android 的 WebView 可见性语义与桌面不同，也一并欠着。
- **下一格（`VirtualList` 的 window resize）起跑前先读夹具，读出一条硬障碍**（写在这里免得下一批重查）：
  `vlistMount` 把宿主写成**死高度** `height:400px`（`scripts/check-ui-runtime.mjs:1855` 与内层包装 `:1871`），
  所以改视口尺寸**不会**改变 `container.clientHeight` ⇒ `onResize` 里 `viewport = clientHeight` 是恒等赋值 ⇒
  摘掉那条 `useEventListener(window, "resize", onResize)` 也不会有任何读数变化，**这条断言在这一格里压根不会红**。
  按"不会红的判据不写"（与 §6.77 同一条纪律）**先登记不动手**。真要让这一格可测，得先让夹具高度随视口走（`vh`），
  而那会牵动本段已有的 9 条读数（`rows < 60`、`nearBottom`、prepend 锚定）⇒ 单独一批、先量再改。

### 6.80 新开一根轴「`localStorage` 可能抛」：25 个直连点现读 17 处裸奔、四处各自手写的兜底并成一个家

- **形状**：全仓生产码 `localStorage.<op>` 直连点现读 **25 处**，其中 **17 处连 `try` 都没有**；
  而"存储不可用"这件事已经被**各自手写**过四遍（`i18n/index.ts` 读+写、`useChatStore.ts` 读+写、
  `useAppStore.loadLocalChatStyle` 读）。⇒ 同一件通用能力，一份没兜的裸点 + 四份重复实现。
- **为什么是 P0 形状而不是风格问题**（每处都读过上下文，不是猜）：`useAppStore.ts:90/91` 在 **store 创建期**
  就 `localStorage.getItem` ⇒ 一抛整个 store 起不来；`applyAppearance`/`setThemeColor`/`setFontFamily`/`setChatStyle`
  四条写路径都没兜 ⇒ Safari 配额写满时**用户点一下切换外观，函数当场中断**（外观不落 DOM、也不落后端）；
  `ResponsiveLayout.vue:471` 在拖分栏的收尾函数里 ⇒ 拖拽收尾被异常打断。
- **一个不显然的点（这条决定了实现形状）**：光**访问** `localStorage` 这个属性本身在某些 WebView 里就会抛，
  所以取后端那一步也得进 `try` —— 只在 `getItem` 外面包 try 的写法在这里是不够的。
- **新家**：`src/utils/safeStorage.ts` —— `createSafeStorage(storage | null)` 工厂 + `storageGet/Set/Remove` 三个包装。
  语义三条且**绝不 rethrow**：读失败当"没这个键"、写/删失败当"没写成"（返回布尔，只有布尔出口才谈得上"不再假装成功"）。
  **值的校验留在调用方**（键名白名单、JSON 解析、数字夹取一条没动）⇒ 这一家只管"会不会抛"，
  不管"对不对"，避免长成一个配置层。工厂那层不是为可测硬造的：本仓 `appearance.ts`、`memberNameCache.ts`
  早就是"调用方把 storage 传进来"的同一口径。
- **迁走 20 处、删掉 5 份手写兜底**：`useAppStore`（读 2 + 写 6 + 删 5 + 它自己那份 try）、
  `useChatStore`（读 1 + 写 1，两处 try/catch 脚手架整块删除）、`i18n`（读 1 + 写 1，同上）、
  `ResponsiveLayout`（读 1 + 写 1）。净删的是 **8 行 `try {`/`} catch {` 脚手架 + 4 条"忽略"注释**。
- ⚠️ **故意没迁的一格（判保留自研）**：`src/boot/theme-boot.js` 那 5 处读。它由 vite 的 `gosslan:inline-boot`
  插件**内联进每个窗口的 HTML**（`vite.config.ts:38`），必须早于 bundle 执行 ⇒ **import 不到任何模块**，
  这是平台约束不是偷懒。它那 5 处由整块外层 `try`（`:22`/`:83`）兜住 ⇒ 不会崩页面，
  但**第一个抛点会让后面四件事全不做**（语言、字体、主色一起丢）——这一格留作后续，改法是给它一个自己的
  逐键 `read()` 而不是继续吃外层大 try。
- ★ **一次假绿形状（自己造的量具坑，写死在测试注释里）**：第一版测试用 helper 在 `finally` 里还原全局，
  而 **`finally` 早于用例体执行** ⇒ 用例读到的是这台 Node 的**原生** localStorage，`set` 返回 `true`
  而断言要 `false`；另一件更阴的：**`delete globalThis.localStorage` 只摘掉自己写的影子，
  原型上那份原生存储会立刻回来** ⇒ "没有存储的世界"根本不能靠 delete 造。
  两条合起来 = 6 条用例里 2 条红，而红的不是产品而是量具。改法是覆盖与还原都写进用例体自己。
- ★ **第二次踩 `@/` 别名（这次连累三份既有测试）**：新家先用 `@/utils/safeStorage` 落 import ⇒
  `npm test` 里 `i18n/index.test.ts`、`appearance.test.ts`、`cardText.test.ts` **整本 ERR_MODULE_NOT_FOUND**
  （`node --test` 不解析别名，只有快速层 vue-tsc/vite 那条路解析）。改成相对 `../utils/safeStorage.ts` 后 49/49。
  ⇒ 这条不是"新坑"，是我又忘了一次：**被 `node --test` 摸到的模块图里不许出现 `@/`**。
- **新判据 ㊾**（`designGuards`）：正向钉"生产码 `.ts/.vue` 里 `localStorage|sessionStorage` 的属性调用直连点必须为空集"
  （新增即点名到文件行），反向钉分母下限——`storageGet/Set/Remove` 的调用面 ≥ 20 且那四份迁过的文件仍在名单里
  （防"改名扫空"让第一句假绿）。非空转由一发注入证明：往 `useAppStore.ts` 塞回一行 `localStorage.getItem("x")` ⇒
  判据当场点名那一行；`cp` 复原 + `diff -q` ⇒ 重跑回绿。
- **读数**：受影响四本 + 新家行为测试 **49/49 退码 0**（复跑 `node --test --experimental-strip-types src/utils/safeStorage.test.ts src/i18n/index.test.ts src/utils/appearance.test.ts src/utils/cardText.test.ts`）；
  新测试文件已登记进 `package.json` 的 `test` 清单（这条清单是显式枚举，不登记就不会被跑到）；
  快速层 `npm run verify:local`：**22 步全通过、共 68.7 s、退码 0**（复跑 `npm run verify:local`；`grep 全部门禁 /tmp/vl680b.log`）；生产码净变化：新增 1 份基础设施文件（86 行）+ 1 本测试，
  5 份业务/基础设施文件里的 5 处手写 try/catch 脚手架消失。
- ⚠️ **NOT RUN / 欠验证**：① 真机 Safari/iOS WebView 的 `SecurityError` 路径本机造不出来，新家的行为只在注入后端下证过；
  ② 外观切换/字体/分栏宽在真实界面上的回归没跑 CDP 探针（本批改的是 store 与布局的存储出口，不是交互形状）；
  ③ Android/iOS `textZoom`、Windows/Linux 两层照例欠着；④ 这批动了应用码 ⇒ `Version-Bump:` 欠账在 §6.66/6.68/6.69/6.72/6.73 之上再加一格。

### 6.81 上一批留下的判据有个洞：把 `localStorage` 当**值**交出去，它压根看不见

- **动机是自己登记的两条尾巴**：§6.80 收尾时我写了"DI 型那一族只登记未迁"，而判据 ㊾ 的反向那半我标的是"直连点=空集"。
  这一批先去读那个洞：**`useAppStore.ts:73` 的 `readStoredAppearance(localStorage)` 在判据 ㊾ 第一版里根本不算直连**
  ——它只认 `localStorage.<op>` 属性调用。而抛点恰恰就在**属性访问**那一步（§6.80 自己刚写下的那句话），
  所以上一批修掉了 20 处、**store 创建期那条崩路仍在**。现读这一族共 6 处 hand-off：
  `useAppStore.ts:73`、`useChatStore.ts:118/192`、`EmojiPicker.vue:50`、`ChatWindow.vue:519/541`。
- **做法**：给家加一个 `safeStorageBackend: StorageLike`——方法名与 `localStorage` 一致但**永不抛**。
  被喂的那些 util（`appearance.ts` 的 `ReadonlyStorage`、`memberNameCache.ts` 的 `KVStore`、
  `announcementDismiss.ts`）的形参形状**一个字没动** ⇒ 它们喂假表的单测照旧跑，
  不需要为了这次收口去改六本测试。⚠️ 代价明写：这个面上**写失败读不到成败**（吞成 `void`）——
  那几家本来也是吞掉的，而真正的持久化权威在后端 settings/SQLite，`localStorage` 只是首帧快路径。
- ★ **贴形状的判据在形状变化时红，正好是换成贴语义的两条的机会**：
  `announcementDismiss.test.ts:75-77` 原来钉的是字面串 `readAnnounceSeen(localStorage)`，
  迁完就红。改成两条语义断言——① 必须把**家**传进去（`…(safeStorageBackend…)`），
  ② 且 `doesNotMatch(/(?:read|write)AnnounceSeen\(localStorage/)` 不许再直连全局；
  "收起真的落盘"这件事仍由同文件上面那组喂假表的行为用例判，**没被这次改动接手**。
- **判据 ㊾ 两处收紧**：正则从"属性调用"放宽到**裸标识符** `\b(local|session)Storage\b`（注释行仍跳过）；
  另加一条下限——`safeStorageBackend` 在家以外被提到 ≥ 6 次，DI 那一族哪天漂回直连，这句会点名而不是静默放行。
- **非空转证明**（专门挑旧形状判据看不见的那一发）：往 `useAppStore.ts` 末尾注入 `const __p681 = localStorage;`
  ——**没有属性调用** ⇒ 判据 ㊾ **166/167 退码 1**，点名 `stores/useAppStore.ts:1063`；`cp` 复原 + `diff -q` ⇒ 回绿。
- **读数**：`node --test … designGuards.test.ts … announcementDismiss.test.ts` **174/174 退码 0**；
  `npm test` **1112/1112 退码 0**（复跑 `npm test`；`grep -E "^ℹ (tests|pass|fail)" /tmp/t681b.log`）；
  快速层 `npm run verify:local` **22 步全通过、共 69.0 s、退码 0**；分母读数「扫 206 份生产码 / 直连点 0 / 新家消费点 20 处（4 份文件）」。
  生产码净变化：6 处 hand-off 改指同一个家 + `src/utils/safeStorage.ts` 多一个导出（+13 行）。
- ⚠️ **仍欠两格，都不许读成"已经收完"**：① `theme-boot.js` 那 5 处仍吃整块外层 try（内联约束，改法是逐键 `read()`）；
  ② `readStoredAppearance`、`memberNameCache`、`announcementDismiss` 内部**各自还留着一层 try/catch** ⇒
  §6.79 那根"同一个谓词被两处守卫"的轴在这一族里**成规模出现**（家一层 + util 内层）。
  本批判**保留**：那些 util 的单测正是喂"会抛的假表"跑的（`memberNameCache.test.ts` 的 `throwOnGet`、
  `assert.doesNotThrow`），删了内层就等于把它们自己的用例地基抽掉；但要写明**现在只有外面那层能被判据 ㊾ 看到**。
  ⚠️ NOT RUN：真机 Safari/WKWebView 的 `SecurityError`（这台 Node 造不出来，只能靠注入后端证行为）、
  外观/字体/公告收起/分栏宽在真实界面上的落盘复看（CDP 探针这一段没跑，本批改的是出口不是交互形状）、Android/iOS/Windows 层。
  动了应用码 ⇒ `Version-Bump:` 欠账再加一格；`designGuards` 用例数 **167**（本批 0 增 0 删）⇒ 提交时测试清单基线三步照旧。

### 6.82 首屏脚本那五枚键：从"整块外层 try"改成逐键兜底，并先用一条红用例把缺陷钉住

- **收的是 §6.80 留下的最后一格**（"判保留自研"那 5 处读）。内联约束不变：这段由 vite `gosslan:inline-boot`
  搬进每个窗口的 HTML、跑在 bundle 之前 ⇒ 它 import 不到 `utils/safeStorage` 那个家，**同一语义只能有第二份实现**。
  这次动的就是这份副本的**兜底粒度**，不是把它并回家（并不了）。
- **原来的形状有什么问题**：整个 IIFE 体挂在一条外层 `try` 上，所以隐私模式确实"不崩"（旧测试就只钉了
  `assert.doesNotThrow`），但 Safari 是**按键**抛的 —— 第一枚键（外观）一抛，**后面的主色、字体、首帧语言、
  macOS 标记全都不做**。症状是"深色没闪但整屏是出厂蓝 + 系统字体 + 英文标题"，而没有任何一层会报错。
- ★ **先红后绿，这条是本批唯一的硬凭据**：给替身环境加一门 `throwKeys`（只让指定那枚键抛），
  新用例「★某一枚键抛错只许带走它自己：主色/字体/语言必须照样落地」在**改脚本之前**跑 ⇒
  **17 pass / 1 fail，红的正是这一条**；改成逐键 `readBootLS(k)`（自己那层 try）后 ⇒ **18/18 退码 0**。
  这比"我读代码认为旧写法会带走后面三件事"强：那条旧判断现在有一发红读数替它作证。
- **交叉核对的载体跟着加了一种，正控同步扩**：键名契约（脚本里的裸字面量必须等于 TS 侧 `*_KEY` 的现算值）
  靠 `findBareStorageLiterals` 现解析。脚本改成 `readBootLS("键")` 之后，只认 `localStorage.getItem("键")` 的
  提取器会认出 **0 个键** —— 而那句的下游断言本来就有下限（`boot.size >= 4`）所以不会假绿，但**下限报红和被认出是两件事**：
  提取器已扩成"两种载体都认"，正控里加了 `readBootLS("probe.boot")` 这一发，证明新那一支真的在匹配。
- **为什么没有把这五处并回 `utils/safeStorage`**（判保留自研，理由要具体）：
  ① 内联脚本没有模块图，`import` 会让它在第一批像素之前拿不到值 —— 首帧防闪整件事就白做；
  ② 家的那三个出口是 TS 侧签名，搬进内联脚本要么带类型要么再造一份，两者都比现在这份 9 行副本贵。
  ⇒ 这一格是**平台约束**下的最小正确形状，同 §6.75/§6.80 那条"复制不是偷懒"的口径。
- **读数**：`node --test --experimental-strip-types src/utils/appearance.test.ts` 修前 **17/18 退码 1**、修后 **18/18 退码 0**
  （复跑：`node /tmp/patch682.mjs` 只动测试能复现那一发红；`复跑 `node /tmp/patch682.mjs`（只动测试）+ `node --test --experimental-strip-types src/utils/appearance.test.ts``）；`npm test` **1113/1113 退码 0**；
  快速层 `npm run verify:local` **22 步全通过、共 69.3 s、退码 0**（复跑 `npm run verify:local`；`grep 全部门禁 /tmp/vl682.log`）（这一层会真的把脚本内联进三个窗口的 HTML 再构建，
  所以"改坏了内联形状"至少能被它抓到）；`readBootLS` 现数 6 次 = 1 定义 + 5 枚键。
- ⚠️ **NOT RUN / 边界**：① 这条只在 Node 的替身环境里证了"按键抛错的隔离"，真机 Safari/WKWebView 的
  `SecurityError` 到底按不按键抛、以及 iOS 上首帧是否真的会因此丢主色 —— 只有他手上的装机能判；
  ② 外层那圈 `try` **仍然保留**（`document.documentElement`、`matchMedia`、`navigator` 也都在它里面），
  所以"整块一抛全跳"这个形状在**脚本后半段**还在，只是那几步不再读存储；要不要继续拆粒度，等真机读数再说；
  ③ 本批动了 `src/boot/theme-boot.js` ⇒ `Version-Bump:` 欠账再加一格（§6.66/6.68/6.69/6.72/6.73/6.80/6.81/6.82）。


### 6.83 「移动布局的宽度档」原本有三份手抄：收成一个家，并把 Tailwind 的 md 拉进同一条对账

- **这一轴是数出来的**：全仓（`.ts/.vue/.js` + `.css` + `index.html`）的宽度媒体查询现读**恰好 4 处**，
  其中 **3 处是同一串** `(max-width: 767px)` —— `useAppStore.ts:246`（建 store 时判 `isMobile` 初值）、
  `useAppStore.ts:735`（init 里那条活着的 `matchMedia`）、`src/boot/skeleton.css:127`（首屏骨架的移动端档），
  第 4 处在 `platform.ts` 的注释里。第四档不在我们手里：Tailwind 的 `md` = **768px**，
  而全仓结构级断点都写成 `desktop:md:*` 叠加 ⇒ JS 那一档必须**恰好低 1px**。
- **为什么值 P1**：三份手抄各自合法 —— 改一份，vue-tsc 过、构建过、探针过，症状只是"首帧按另一档渲染"
  或"骨架在手机上画成桌面三栏"（静默）。而 JS 与 `md` 一旦重叠或留缝，窗口停在那一格时
  `html.is-mobile` 与 `md:` 会**同时亮或同时灭**（导航栏与抽屉各来一份）。同 §6.46/§6.62/§6.69 那一族。
- **做法**：家落在判据层的老家 `utils/platform.ts`（`resolveMobileLayout` 已经在那儿）——
  `MOBILE_MAX_WIDTH_PX = 767` + 由它现拼的 `NARROW_LAYOUT_QUERY`（`platform.ts:101`），两处 JS 直连改成引用常量
  ⇒ **真删掉一份手抄副本**。CSS 那一份接不进来（媒体查询读不了自定义属性，骨架又必须在 JS 之前画），
  只能由判据两边现读对账 —— 与存储键名（§6.46）同一形状。
- **判据的家选在 `platform.test.ts` 末尾**（紧挨「减弱动态这条查询只有一个家」那条同族判据），四件零件齐：
  正控（认得出裸查询串、且不把注释里的同形文字算成作用点）／分母下限（扫描面 ≥ 180 份、CSS 侧至少认出 1 处）／
  反向钉（骨架那一处必须仍然等于这个数 —— "不许错"型判据发现不了"整条规则被删"；两个 JS 消费点各 1 次；
  Node 里现读 `NARROW_LAYOUT_QUERY` 的运行时值）／**md 从库自己的默认主题现算**
  （`createRequire` 读 `tailwindcss/defaultTheme.js`，判据里不手抄 768）。
- **库的判定：`useMediaQuery` 不接（保留自研）**，读的是 14.4.0 的 dist 实现而不是文档 —— 它只把 `change`
  接成布尔 `ComputedRef`，**没有 resize 兜底、没有首帧后重判**，而这两条正是安卓首帧读到 980px 那一档要求的；
  它内部 `useEventListener` 只在**有活动 effectScope** 时自动摘，而 store 的 `init()` 是 setup 之外可重跑的函数
  （现靠 `appInitScope` 手工配对）⇒ 接进去等于每重跑一份永不摘的监听。理由已写进 `useAppStore.ts:736` 那段注释。
- ★**本批跑出一个量具的谎**（比改动本身更值得记）：UI 探针 `check-ui-runtime.mjs:694` 是自己
  `classList.toggle('is-mobile', !!o.isMobile)` —— 布尔由夹具传进去，**从不走 store 的 `applyIsMobile()`**。
  所以"探针绿"从来不是这条链的证据：把窄档改错、甚至把 `mq.addEventListener` 整行摘掉，探针照样全绿。
  ⇒ 这条链的运行时凭据仍是**零**，下一批要做的不是再补一条文本判据，而是让探针真的驱动宽度
  （CDP `Emulation.setDeviceMetricsOverride` 500 → 读 `html.is-mobile` → 回 1200 → 再读）。
- **读数**：判据先红 —— `node --test --experimental-strip-types src/utils/platform.test.ts` 退码 **1**，
  红在「platform.ts 里没有 export const MOBILE_MAX_WIDTH_PX」（正控在同一发里已先过）；改后同一本退码 **0**，
  打印「家=767px / Tailwind md=768px / JS 侧裸抄 0 处 / CSS 侧查询 src/boot/skeleton.css (max-width: 767px)」。
  两发单点变异各点一面：**M1** 把家里的数改成 766 ⇒ 退码 1、红在「Tailwind md=768px 与 JS 的窄档 766px 必须恰好错开 1px」；
  **M2** 往家里追加一行手抄 `(max-width: 900px)` ⇒ 退码 1、点名 `utils/platform.ts → (max-width: 900px)`
  （判据不按文件豁免，所以"抄进家里"也报 —— 这是旧写法会漏的那一类）。两发都 `cp` + `diff -q` 证复原。
  `npm test` **1114/1114 退码 0**（1113→1114 = 本批新那条）；快速层 `npm run verify:local`
  **22 步全通过、共 69.6 s、退码 0**（复跑 `npm run verify:local`；含 vue-tsc 与 vite 构建）。
- ⚠️ **NOT RUN / 边界**：① 真实浏览器里"跨 768 时 `is-mobile` 跟着翻"没有凭据（见上面那个谎）；
  ② Android 首帧读到 980px 那一档时**骨架仍按宽度判** —— 骨架接不到"平台优先"这条判据，
  两个候选改法（CSS 加 `(pointer: coarse)` 或让首屏脚本先写类）都要真机首帧读数才能判：
  前者会把判据从"宽度"换成"另一个代理量"，后者要在只有字符串字面量的内联脚本里再抄一份 UA 正则
  （§6.82 刚证过这种"两种载体"的漂法）。本机无法证 ⇒ **暂缓**，等真机；
  ③ 动了 `src/utils/platform.ts` 与 `src/stores/useAppStore.ts` ⇒ `Version-Bump:` 欠账再加一格
  （§6.66/6.68/6.69/6.72/6.73/6.80/6.81/6.82/6.83）。


### 6.84 那条链第一次被真浏览器看到：跑真的 `store.init()`，把视口宽度来回跨过那一档

- **补的是上一批数出来的那个谎**：探针里唯一的 `is-mobile` 是夹具自己
  `classList.toggle('is-mobile', o.isMobile)`（`check-ui-runtime.mjs:694` 那一族），布尔由夹具传入 ⇒
  `applyIsMobile()` 从来没被执行过，"摘掉监听"这种坏法以前整套探针一条都不红。
- **新增段 `--only=layoutstore`**：夹具 `H.layoutBoot` 跑**真的 `useAppStore().init()`**，查询串从
  `/src/utils/platform.ts` 现取（探针里不许抄第二个 767 —— 那个数与 Tailwind `md` 的补数关系已由
  `platform.test.ts` 从库的默认主题现算对账）。三格读数各管一层：**查询本身 / store.isMobile / `<html>` 上那个类**，
  驱动方式是 CDP `Emulation.setDeviceMetricsOverride` 1200 → 390 → 1200。
  `init()` 故意不 await：布局那一格排在第一个 await 之前，而后面的 IPC 在没有 Tauri 的页面里必然抛
  （实测抛在 `Cannot read properties of undefined (reading 'invoke')`，属预期，已作为自然读数打印）。
- **四发变异把"两个机制驱动同一格"的归因坐实**（§6.77 那一族第一次有运行时侧读数）：
  只摘 `mq.addEventListener` ⇒ **3/3 绿**；只摘 `resize` ⇒ **3/3 绿**；**两条都摘 ⇒ 2/3，红的正是跨窄档那一格**；
  复原 ⇒ 3/3 绿且 `diff -q` 逐字一致。⇒ 冗余的两条出口是**故意的**（#27 那次"变窄早于监听注册"就是靠它们兜的），
  而这条链作为一个整体是**可证伪**的。
- ★**顺带读出反向那一格的强度**：两条监听都摘掉时「退回 1200 后类为 false」仍然绿 —— 因为类压根没挂上过。
  那一格防的是"只会变窄不会变宽"，**不防"这条链没接"**；后者由正向那一格负责。已写进段注释，
  免得下一轮把反向那格读成正向的证据（同 §6.79 那一课的另一半）。
- **读数**：`npm run test:ui-runtime -- --only=layoutstore` **3/3 条判据绿、退码 0**（自然读数
  `q=(max-width: 767px) 宽档 vw=1200 窄档 vw=390`）；四发变异见上；`node --check scripts/check-ui-runtime.mjs` 通过；
  快速层 `npm run verify:local` **22 步全通过、共 58.0 s、退码 0**。
- ⚠️ **NOT RUN / 边界**：① Chromium 的 `setDeviceMetricsOverride` **不会**重现 Android WebView「首帧读到 980px
  兜底档」那一档 —— 那要靠真机首帧读数判（仍在他手上）；② 本批只动 `scripts/` 与文档 ⇒ 不产生 `Version-Bump:` 欠账；
  ③ 全量探针耗时随段数涨，本批只在快速层之外单独跑了那一段。

### 6.85 菜单的「往视口里收」只剩一个 owner：删掉迁移到 Reka 之后留下的那份手算残留

- **轴是数出来的**：全仓生产码里 `Math.max(<数>, Math.min(… window.inner…))` 这种"自己把浮层收进视口"
  的写法现读**只剩 1 本文件**（`GroupTasksBoard.vue:196`，限的是菜单**自己的宽**，不是坐标收边 —— Reka
  不会替内容缩宽，且辅助任务窗没有 `minWidth`，判**保留**）。而 `ConversationList.onFriendContext` 曾是第二处：
  它按 `mw = 150 / mh = 90` 两个**猜出来的菜单尺寸**向内收坐标。
- **为什么它是残留**：统一外壳 `ContextMenu.vue` 把鼠标点做成**零尺寸虚拟锚点**，注释里写死了
  "量尺寸、翻转、贴边内收由 Reka 的 popper wrapper 做"；而**同一个文件里的 `onConvContext` 早就把 x,y 原样传下去**
  ⇒ 一个文件两种口径。菜单条目增减时那两个数就漂，漂了不报错，只是弹开的位置偏离用户点的那一下。
- **做法**：删掉收边与两个尺寸猜测（`ConversationList.vue:223-236`），坐标原样交给外壳 —— 这是规则七.3
  「替换完成后删除失去用途的旧实现」里那种**没人来删的尾巴**：迁移那批把定位交给了 Reka，却没回头删父级的手算。
- **判据**（家在同一条轴的 `contextMenuReka.test.ts` 末尾）：三件零件齐 —— 正控（matcher 认得出那种写法）、
  分母下限（扫描面 ≥ 180 份）、**反向钉名单**（允许留下的那一处必须点名是哪本文件、并把它的形状钉住，
  换形状时要重新判它该不该留）；另钉两个菜单都传裸坐标 + 外壳的虚拟锚点契约没被拆。
- **读数**：`node --test --experimental-strip-types src/utils/contextMenuReka.test.ts` **退码 0**，打印
  「手算收边这一族现读 1 本文件（名单：components/GroupTasksBoard.vue）」；**单点变异**：把收边按回好友菜单
  ⇒ 退码 1，红在「这一族又长出了新成员」并点名 `components/ConversationList.vue`；`cp` + `diff -q` 证复原逐字一致。
  整层：`npm test` **1115/1115 条、fail=0、退码 0**；快速层 `npm run verify:local` **22 步全通过、共 69.1 s、退码 0**
  （含 vue-tsc —— 它不会替这条判据说话，因为删的是表达式不是类型）。
- ⚠️ **NOT RUN / 边界**：① 这条改的是**弹开落点**，探针没有"在窗口右缘右键 → 量菜单矩形"那一格 ——
  已登记为下一格运行时判据（同 §6.69 窄窗遮挡那一族）；真机 WKWebView/WebView 上的观感仍要你点一次；
  ② 动了应用码 `src/components/ConversationList.vue` ⇒ `Version-Bump:` 欠账再加一格
  （§6.66/6.68/6.69/6.72/6.73/6.80/6.81/6.82/6.83/6.85），designGuards/contextMenuReka 用例数涨了 ⇒
  提交时测试清单基线三步（`--update` → `--sync-baselines` → 再 check）照旧。

### 6.86 尝试给「菜单贴边」补运行时凭据 —— 量具装不出来，摘掉了（这条仍然欠）

- **动机是 §6.85 自己留的洞**：那批删掉父级手算收边的理由是"贴边内收归 Reka 的 popper"，可**没有任何一格运行时判据读过菜单渲染出来的矩形**。
  于是新起一段 `--only=menufit`：在 420×640 视口里装**真菜单** `FriendContextMenu.vue`（自带条目，不装裸外壳 —— 裸外壳没 slot 内容时量到 0×0，
  "在视口内"会成立得毫无意义），把锚点分别放到右下 / 左上 / 右上，量 `.gosslan-menu` 的四边。
- **实测读数**：`install` 返回 `{ok:true, cmp:'/src/components/conversation/FriendContextMenu.vue', pinia:true}`，
  但 `document.querySelector('.gosslan-menu')` 取不到 —— 四格全红（0/4，退码 1）。⇒ 这是**夹具装不出 Reka 的浮层**，
  不是产品缺陷：同一段代码在应用里能弹出菜单（用户天天在用），差别在"组件被单独挂在一个裸 host 上"。
- **为什么选择摘掉而不是留着**：`want()` 在**全量跑**里恒为真，留着就是给整套探针钉上四格必红 ——
  那等于用"让大家都红"换一条我自己的未验主张，规则七.5 不允许。已按注释边界逐字节摘除并核对
  `layoutstore` 那条**还在**（`--only=layoutstore` 复跑 **3/3 退码 0**、`node --check` 通过）。
- **这条洞的下一步（留给下一批，已经给出具体的读法）**：不要单独挂菜单组件，而是**挂它的父级**
  （`ConversationList` 需要 store 里有会话/联系人数据，或给 `H.install` 加一个"带 slot / 带 provide"的入口），
  或者退一步在真窗口里取证（§6.x 那条 `launchAuxWindow` 的真实窗口验法）。
  在补上之前，§6.85 那句"库真的会收"只有**静态凭据**：外壳显式写了 `:collision-padding="8"`、
  `side/align/offset` 齐全，且它是全仓唯一的外壳（`contextMenuReka.test.ts` 钉着）。

### 6.87 首屏脚本剩下的那半个「一抛全跳」：先钉红，再把每件事各自兜住

- **§6.82 只修了一半**：五枚键改成逐键兜底之后，外层那圈 `try` 仍然罩着**脚本后半段** ——
  `window.matchMedia`、`navigator.languages`、`el.lang`、`document.title`、`is-mac` 全在它里面。
  而 `mode` 的默认值是 `"system"` ⇒ **从没在设置里选过亮暗的大多数首帧，恰好要走那条会抛的分支**
  （旧 WebView 没有这个 API、受限环境里访问它就抛）。一抛，主色、字体、语言、标题、macOS 标记一起不做，
  症状是"深色没闪，但整屏出厂蓝 + 系统字体 + 英文标题 + 38px 骨架标题栏"，且没有任何一层报错。
  原来那句注释还写着"→ 按浅色渲染即可，不影响后续" —— **这句话本身是错的**，它确实影响后续。
- **做法**：删掉外层 try，改成五件事各一个 `bootStep(fn)`（亮暗 / 主色 / 字体 / 语言+标题 / macOS 标记）；
  问不到系统偏好时按**浅色**（宁可少做一次深色，也不瞎猜成深色闪一下）。五枚键名仍是裸字面量，
  逐键兜底的 `readBootLS` 一个字没动 ⇒ §6.46/§6.82 那两条跨载体核对不受影响（现数 `readBootLS` 仍是 6 = 1 定义 + 5 枚键）。
- **★先红后绿**：替身环境加 `matchMediaThrows: true | "missing"`（抛错 / 这个 API 压根不存在两种世界），
  新用例改脚本前 **18/19 退码 1**、红的正是「matchMedia 抛错时主色必须照样落地」；改后 **19/19 退码 0**。
  ⚠️ 这条用例自带正控：`matchMedia` 可用时 `system` 档仍要点亮 `dark` —— 没有它，
  "matchMedia 不可用 ⇒ 什么都不做"这种把四件事一起关掉的写法也能让前面全绿（§6.79 反向那格同一课）。
- **读数**：`node --test --experimental-strip-types src/utils/appearance.test.ts` **19/19 退码 0**；
  `npm test` **1116/1116、fail=0、退码 0**；快速层 `npm run verify:local` **22 步全通过、共 69.4 s、退码 0**（这一层真的把脚本内联进三份 HTML 再构建 ⇒ 改坏内联形状它抓得到）；
  `grep -rn theme-boot scripts/guard_cases/*.py` 现读 **0 命中** ⇒ 护栏注入锚点没被这次重写挪走。
- ⚠️ **NOT RUN / 边界**：真机侧仍只有替身凭据 —— 哪一版 WKWebView/WebView 真的没有 `matchMedia`、
  以及受限环境里访问 `navigator` 到底抛不抛，要装机判（他手上）。动了 `src/boot/theme-boot.js`
  ⇒ `Version-Bump:` 欠账再加一格（清单见 §6.85 那条）。

### 6.88 第二次撞那堵墙，但这回带回了证据：Reka 的**强开式**弹层在探针的"单独挂载"路径下不进 DOM

- 重起 `--only=menufit`（420×640 视口、装真菜单 `FriendContextMenu.vue`、坐标推到右下/左上），
  并先给探针补一条**页面侧错误通道**（`H.pageErrors` / `H.resetErrors`：接 `window.onerror`、
  `unhandledrejection`，并把 `console.error` 收一份 —— Vue 把 render 期异常吞成 console.error，
  不接这一路就永远只看得见"DOM 少了"，看不见"为什么少"）。
- **拿到的是否定证据**：`install` 回 `{ok:true, cmp:'…/FriendContextMenu.vue', pinia:true}`，
  三格 `found:false` 且 **`errs:[]` —— 一个页面错误都没有** ⇒ 上一批那句"大概是组件渲染抛了"被否掉；
  真实形状是 **Reka 的 `DropdownMenuContent`（外壳是 `:open="true"` 强开、虚拟锚点）在这条"把组件当根挂上去"的路径下根本不进 DOM**。
  与本仓已经绿着的 Reka 弹层格（`reaction 20/20`、已读回执 Popover）的差别就在：那些是**有 trigger 的组件、靠事件把它打开**，
  不是被强开的根。
- **于是两件事分开收尾**：判据段**再次摘掉**（`want()` 在全量跑里恒真 ⇒ 留着就是四格必红；规则七.5），
  摘完复跑 `--only=layoutstore` **3/3 退码 0**、`node --check` 通过、`diff -q` 证脚本回到本轮起跑前；
  诊断通道**不留在仓里**（没人消费就是死代码），但补丁留在 `/tmp/p688.mjs`，下一批连着"挂父级 + 靠 trigger 打开"的写法一起落。
- ★**本轮我自己踩的两坑，写死成规矩**：① 摘段时按"`/**` 到下一个 `async function`"删，会顺手吃掉
  相邻段的 doc 注释，且**顺序插过两次之后同一锚点已经指向别的函数** —— 第二次摘除直接把 `runLayoutStore` 删没了
  （症状：`--only=layoutstore` 变成 `0/1：runLayoutStore is not defined`，而 `node --check` 照样过 ⇒ 语法合法不等于还在）；
  靠本轮起跑前的 `cp` 备份复原 + 改用**行号精确**删除。⇒ 以后摘代码段：先 `cp`，删完必须**现 grep 那个函数名还在**，
  不能只看 `--check`。② 摘完先跑一遍"上一批刚建的那条判据"，它红就说明我删多了。
- ⚠️ **NOT RUN**：菜单贴边这条运行时判据仍欠，且现在知道该怎么写：挂**父级**、靠事件打开，或走真实窗口。

### 6.89 连着改了三轮探针之后，把整套 UI 探针重跑了一遍（不是抽查，是全量）

- **为什么这一格要跑**：§6.84/§6.85/§6.86 这三批都动过 `check-ui-runtime.mjs`（加夹具、加段、摘段、
  改 PAGE_FIXTURE），而我此前只单独复跑过 `--only=layoutstore` 那一段 ⇒ "我这条判据绿"不等于"整套没被我改坏"。
- **全量实测**：`npm run test:ui-runtime` → **264/265 条判据绿、退码 1**（这是截断后的读数，见下三条）。
  唯一那格红是探针自己的元判据："CDP `Runtime.evaluate` 在 45000 ms 内没回包（renderer 主线程很可能已经不响应）
  ⇒ 响亮失败，这一格记**没跑**，不是产品红"；末尾还打印"端口让位耗时 10000 ms —— 到点仍被占着（这是本趟的残留）"。
  同类挂死在本仓**早有记录**（脚本自己第 87 行的注释：2026-10-10 `--only=pinkb` 变异对照那一段一次 eval 十几分钟没回，
  只能靠人 kill），且这次红在的是"弹窗栈/泵帧"那一段，不是我动过的任何一段。
- ⚠️ **但那三段这次根本没跑到**：现 grep 日志里「宽档 store 判否 / 跨到 390 / 退回 1200」三格**一条都没有**，
  而且末尾另有一行「端口让位耗时 10000 ms —— 到点仍被占着（本趟残留）」⇒ 这 264/265 是**截断后**的读数，
  后面的段压根没跑。那三段目前仍然只有 `--only=layoutstore` 单跑 3/3 一条凭据，不算"全量跑里也绿"。
- **顺手记下台账该改的一句**：矩阵末尾那句"最近一次实跑 448/448"是 §6.72 那趟的**历史读数**，
  与今天的 265 格不是同一个数（判据会随批次涨缩）—— 两处都别手抄，复跑 `npm run test:ui-runtime` 看末行。
- ⚠️ **NOT RUN / 边界**：那 1 格"没跑"的段（弹窗栈）仍欠一次干净读数 —— 要么下一趟单跑那段，
  要么等并行轮次结束后再全量；本批没动任何应用码，`verify:local` 上一轮的 22 步读数仍属同一份工作树状态。

### 6.90 只读面板的「手写 loading 三件套」一次数完：7 格里 1 格交给 Query，剩下 6 格逐格写理由（10-20，P1）

**这根轴之前没人数过。** 数法（现算，别手抄）：

```bash
grep -rlE '^const (loading|failed|loadError) = ref\(' src --include='*.vue' | sort
```

迁移前 **7** 个文件，迁移后 **5** 个（第二格 `LinksList` 见 §6.98）；分母是全扫 `src/` 得到的 **88** 个 `.vue`（判据里钉了 `>= 80` 的下限，防止有人把路径写错扫出空集还报"零处"）。
逐格判定（六档），留在册子里的**理由本身**也写进了判据注释 —— 下一批不必重新查一遍，也不许当默认豁免读：

| 格 | 判定 | 依据（读过实现，不是看名字） |
|---|---|---|
| `DevDiagPanel.vue` | **直接替换（本批落地）** | 一次 `getDiscoveryDiag()` 拿全的纯读快照，没有主体可分键、没有写路径 |
| `LinksList.vue` | **直接替换（§6.98 落地）** | 三条写命令都返回整份数组 ⇒ 读侧 `["links",""]` 交给 Query、三条写命令共用一枚 `useMutation`，成功时把返回值 `setQueryData` 回同一个键；删除的是 `links`/`loading`/`loadError`/`saving` 四枚 ref + `onMounted(load)` + `try/finally` |
| `LogViewer.vue` | **暂缓替换** | 2s 轮询 + `document.hidden` 闸门 + "有旧内容不报失败"；那一族的读数已由 §6.79 用两发变异钉过，换 Query 等于重测整族（收益未证） |
| `FavoritePanel.vue` | **保留自研** | 数据家是 Pinia `chat.refreshFavorites()`；交给 Query 会把同一份收藏变成**第二个状态源**（正是 §三.C 警告的那种） |
| `GroupTodosWindow.vue` | **保留自研** | 群任务台账是事件驱动的业务状态机（INV-P29 编号规则同源），不是"打开拉一份"的快照 |
| `AddFriendModal.vue` | **不在这根轴上**（登记在册是因为名字撞了） | 那枚 `loading` 是**提交在飞**（写操作），读的是申请接口的一次性返回 |
| `TodoImageThumb.vue` | **保留自研** | 取字节 + 失败向对端拉 + 排期重试；重试语义是业务的（`pullFromPeers`/`scheduleRetry`），普通查询缓存给不了 |

**那一格怎么交的**：`useQuery(panelQueryOptions<DiscoveryDiag>("diag", "", () => api.getDiscoveryDiag()))`。
· 键是 `["diag", ""]` —— 全局只有一份读数、没有主体，所以 id 传空串，**但仍然走 utils/panelQuery 那个家**（不另起第五份策略抄本，也不为凑库再包一层）；
· 删掉的是 `diag`/`loading`/`loadError` 三枚 ref + `onMounted(refresh)` + `try/finally`；
· 业务口径原样搬：`loading = isFetching`（刷新时也转圈、按钮禁用），`loadError` 只在 `error && !diag` 时说话（有旧快照就不把整屏换成错误页），模板 `v-if="diag" / v-else-if="loading" / v-else-if="loadError"` 三态优先级不变；
· 顺带一条真实改进：**连点刷新合并成一次**（旧实现每次点击各发一条命令）。

**判据**：新册 `src/utils/panelQuery.test.ts`（已登记进 `package.json` 的 test 清单），本批 6 条、§6.98 再加 2 条 ——
① 键与策略档（staleTime/retry/retryDelay 从 `PANEL_QUERY_POLICY` 现读，不手抄数字）；② 重开真的再打一次命令；
③ **失败时旧读数仍在、error 同时可见**（正反控：断言这次真发了两次尝试＝不是"没跑所以没变"，反控换键取不到数据）；
④⑤ 诊断面板的接线与三态口径（文本逐件钉，含"摘掉 refetch 就红"那条反向钉）；
⑥ 存量登记册：命中集合必须**恰好等于**这 5 格，多一个红、少一个也红（登记理由要跟着删）；
⑦⑧ `LinksList` 的读写接线（§6.98）：读键 `["links",""]` + 三条命令各自接线 + `setQueryData(panelKey(...))` + `saving` 来自 `isPending`。

**非空转证明（三发单点变异，每发只被一格抓住，`bash /tmp/mut690.sh`）**：
塞回一枚 `const failed = ref(false)` ⇒ 第⑥格红（5/6）；摘掉 `&& !diag.value` 那道闸 ⇒ 第⑤格红；把 `void diagQuery.refetch()` 改成注释 ⇒ 第④格红。三发之后 `cmp -s` 与备份逐字节相同、复跑 6/6。

**门禁读数（本次真跑，退码裸取）**：`npm test` **1122/1122、fail=0**（比上批 +6＝新册那 6 条）；`npm run verify:local` **22 步全通过、70.1 s**（含 vue-tsc 与构建 ⇒ 改过的 `.vue` 类型与 import 成立），其中"测试清单守卫通过"＝新册确实被纳管；`python3 scripts/verify-guards.py --list` 退 0（锚点仍命中）。

⚠️ **NOT RUN / 边界**：这一格当时**没有真实界面读数** —— 诊断面板要从开发者入口打开，人眼看首屏"加载中"→有读数→拔网线点刷新这三态。~~探针今天没有 `diag` 段…只能由用户复看~~ —— **已在 §6.100 补上 `diag` 段 4 格**（Chromium 里三态 + 一条冷启动失败反控；真机仍未跑）。
矩阵第 3 节那句"使用面只有群文件面板"同步改成现算的 **4 个纯读面板**（群文件 / 共享目录 / 搜索聊天记录 / 诊断快照）。

**下一批（顺序已经排好，不再新开轴）**：① ~~`LinksList` 连读带写一起接~~ **已完成（§6.98：`useMutation` + 真浏览器里驱动增/改/删，两发单点变异各证一面）**；② `favorites` 那格维持 store 唯一家（常设判定，不是待办）；③ ~~菜单贴边的运行时凭据~~ **已完成（§6.97）**。下一批回到 P0 清单里**只能由用户拍板**的两项：§四.3 的 Tooltip 决策（0 处 Reka Tooltip / 199 处原生 `title=` / 113 处无 `aria-label`）与 265 处行内 `text-[NNpx]` → 字号令牌的观感；其余都是真机条目（见 §11 问 5）。

### 6.91 移动端弹窗顶部被刘海压住：两套「让位」口径收成一枚出口，顺出手动量出来的第二处双计（10-20，P0）

**起点是用户实测**："移动端部分弹窗上方内容被摄像头区域/刘海/状态栏遮挡"。读实现读出根因，且根因**不是**"没人做安全区"：本仓顶部让位一直有**两套互不相认**的口径 —— 桌面读 `--gosslan-window-safe-top`（自绘 caption，Win 38 / macOS 28，移动端刻意 0），移动端整屏形态读 `env(safe-area-inset-top)`。缺的是第三种情形：

| 形态 | 迁移前谁让顶部 | 结果 |
|---|---|---|
| BaseModal **卡片**（小/中弹窗） | 外壳读 window 那枚（移动端=0），里面只靠容器 `p-4` | **移动端只有 16px**，刘海/状态区通常 44–59px ⇒ 用户看到的压住 |
| BaseModal **整屏** | 面板自己 `pt-[env(...)]` + 外壳 window 那枚 | 各自对，但两层各写各的 |
| ImageLightbox 工具条 | 外壳让一遍，工具条又写 `calc(window + env + 1rem)` | **桌面把 caption 算了两遍** |
| MobilePageFrame / FavoritePanel overlay / ActionSheet | 自己读 env / 只需要底部 | 本来就是对的（本批**没动**，并反向钉住不许"统一"顺手删） |

**收口的办法**（§五.1 要的"统一约定"，不是又加一层包装）：`style.css` 里加**一枚**出口
`--gosslan-safe-top: max(var(--gosslan-window-safe-top, 0px), env(safe-area-inset-top, 0px))`。
用 `max()` 而不是相加，理由是这两个世界里各有一半恒为 0 —— 相加等于**把同一个物理避让读两遍**（工具条那一格就是这么错的）；真机上万一两者同时不为 0，该让开的也是较大那一个，不是它们的和。消费方改成只读这一枚：外壳 `top-[var(--gosslan-safe-top)]`、卡片 `max-h-[calc(100vh-var(--gosslan-safe-top)-2rem)]`；整屏面板里自己加的那句顶部内距**删掉**（外壳已经让了）。
**一处故意不统一**：遮罩 `DialogOverlay` 继续读 window 那枚。遮罩是把背景压暗用的，移动端必须让刘海区也落在暗层底下，读合并值反而会在状态栏底下留一条没压暗的缝 —— 这条"不许顺手统一"已经用反向钉写进判据。

**顺手删掉的兼容层**：`ImageLightbox` 的 `topInset` prop（`PreviewWindow.vue:151` 传的 `var(--gosslan-title-h)`）。它当初存在的唯一理由就是"让外壳顶到 caption 下沿"，现在外壳读的就是同一枚出口 ⇒ 它没有活了。prop、文档块、`:style` 里那段两层口径注释、调用点传参一起删（`grep -c topInset` 现读 **0**）。

**证据：这条不是推断出来的，是真几何量出来的**（`scripts/check-ui-runtime.mjs` 的 `--only=lightbox` 新增两格，把 `--gosslan-window-safe-top` 钉成 44px 后量外壳与工具条）：
· 迁移前读数 `{"shellTop":44,"barTop":104,"delta":60}` ⇒ 判据"工具条相对外壳只留 1rem（16px）"**红**（先红后绿）；
· 迁移后该段 **9/9 判据绿**，`shellTop=44` 那格证明"让位只挂在外壳这一层"；
· `--only=overlay` **41/41 绿** ⇒ BaseModal 改 top/max-h 没动坏既有几何。

**判据 ㊿**（`src/utils/designGuards.test.ts` 4 条）：出口只定义一次且必须是 `max(window, env)`；生产码里**没有人再把两枚相加**（缺席型四件零件齐：合成串正控 + 单读任一枚的反控 + 分母 `>=200` 份生产码 + 反向钉 window 那枚仍有 `>=2` 个真消费者）；BaseModal 三处绑法（出口 1 处、max-h 读出口、遮罩读 window、整屏面板不再自己加）；预览那两条 + 页面级那两格仍自己读 env。

**本批四发变异**（`bash /tmp/mut691.sh`，每发只被指定那一格抓住，跑完与备份逐字节相同）：
A 把两枚重新相加 ⇒ 缺席判据红；B 外壳改回只读 window ⇒ BaseModal 判据红；C 整屏面板自己再加一句 ⇒ 同一条红；
**D 反向**：只在 **HTML 注释**里写那枚类名 ⇒ **不许红**，实测 171 pass。
D 这一发是补自己犯的错：判据第一版把整份文件当文本搜，而我在 BaseModal 注释里逐字引用过被删掉的那句 ⇒ 代码已经改对、判据却报红（`pass 170 / fail 1`）。改成先剥 HTML/块/行注释再判（`code691()`），并把"注释能喂饱的判据不是判据"这双向理由写进注释。

**门禁读数（现算）**：`npm run build` **退 0**（2895 modules，构建步含前端静态检查）；`npm test` **1125/1126** —— 唯一那条红**不属于本批**，是并行轮次的在飞状态：`注册表与前端调用面必须逐条对账` 报 `export_diagnostics_bundle, get_log_locations` 前端零调用（`grep -rc … src` 现读 0 处，这两条从未有过调用面 ⇒ 不是我删的），以及 `verify:local` 第 12 步 `node scripts/check-domain-map.mjs` 自己点名 `src-tauri/src/diagnostics.rs 既没被领域认领、也没列进 unmapped`。**因此本 tip 的"整层绿"不成立**（fail-fast 之后 10 步没跑），等并行轮次把那两条收口后必须重跑整层；本批的可复跑证据就是上面这四条。

⚠️ **NOT RUN / 边界**：`env(safe-area-inset-*)` 在 Chrome 恒 0 ⇒ **移动端那一半在这里证不了**。要真机才算：iOS 刘海/动态岛与 Android 挖孔机上打开任一卡片弹窗（添加好友、创建群组、确认框、任务详情），看标题与 ✕ 是否完整落在状态栏之下；再各看一次横竖屏切换与键盘弹出（`keyboardInset` 那条 `paddingBottom` 与本出口是两件事，别混）。桌面那一半可以当场看：窗口化后图片预览的右上工具条应离 caption 下沿 16px，而不是 92px。

### 6.92 导航图标收进单一家：4 枚自绘glyph的例外登记 + BackArrow 那条手抄路径（10-20，P0）

**专项 §三点名要做的事**：PC 最左侧栏与移动端底栏/空状态的图标必须同一语义同一造型，且不许手写 SVG 路径。
本轮之前，那 4 枚（聊天/通讯录/收藏/链接）在 PC 栏和移动端**各写了一遍同一条 `d`**，
而 `NavRail.vue` 里还留着"选中态靠 fill 表达"的三处重复绑定 —— 用户 2026-09-21 报的
"链接指南针选中时不变实心"，根因就是第 4 处漏了绑定：造型与绑定各写四遍，漏一遍没人看得见。

改成两个家：`src/components/ui/navIconPaths.ts`（造型数据，4 条 `d` + `evenodd` 标志）
和 `src/components/ui/NavIcon.vue`（`:fill="props.active ? 'currentColor' : 'none'"` 这一处绑定）。
`NavRail.vue` 的内联 `<svg>` 从 4 块变成 4 行 `<NavIcon name=… :active=… />`，
`ResponsiveLayout.vue` 的 7 处（两个 tab、链接行、三个空状态）换同一只组件、只改 `size-class`。

**为什么这 4 枚仍要自绘（登记的例外，不是漏网的）**：lucide 只有描边图标，没有填充档；
而这一族选中态的表达方式就是"填成实心"。给线性图标直接 `fill` 会糊成墨团（双人图标尤其）。
⇒ 例外只此 4 枚，且 `navIconPaths.ts` 顶部写明"新增第 5 枚必须先在 lucide 里找语义最近的"。

**BackArrow 那条是真重复**：它的 iOS 分支手写 `d="m15 18-6-6 6-6"`，而
`node_modules/lucide-vue-next/dist/esm/icons/chevron-left.js` 里 `chevron-left` 的路径**逐字就是这一串**
（现查：`grep -o '"m15 18[^"]*"' …`）。库里已有的东西不必再画一遍 ⇒ 换成 `<ChevronLeft>`。
副作用要说清楚：描边从这条手写路径自定的 `1.9` 回到库默认的 `2`，是 0.1px 的视觉差，
**这一档只能由你在真机/真浏览器里判观感**（未跑，见 §十清单）。

**判据（`src/utils/designGuards.test.ts` 新增 4 条 + 原有那条改指新语义）**：
原来那条"可选中导航项：图标必须有 `:fill` 的选中绑定"是按源码文本钉 `:fill="navState === '…'"` 的，
重构后它红了一次 —— 这是信号不是麻烦：把语义换成"必须 `<NavIcon name=… :active=… />`"，
并把 `:fill` 那一格钉进 `NavIcon.vue` 内部。新增的 4 条把"自绘"这轴钉成机器事实：
`.vue` 里出现**内联 `<svg>` 元素**的家必须恰好是 `{TitleBar.vue, ui/NavIcon.vue}` 两个；
手写图标路径（`d="M…"` 与 `d: "M…"` 两种写法）只许在 `navIconPaths.ts` 与 `TitleBar.vue`；
BackArrow 不许长出内联 svg、不许再抄那条 path、且 `v-if="isIOS"` 那档不许被"统一"顺手抹平。
按元素解析而非按行 —— `GroupTasksBoard.vue` 的注释里写着 `<svg>` 三个字，
它必须不算家（这条同时当判据的反控写在测试里）。

**读数（都是写这段时现算的，括号里是复跑命令）**：
`npm test` **1130/1130 绿**（先前那格并行会话的注册表红已被它自己那批消掉）；
`npm run build` 退 **0**（2898 modules transformed）；
`node --test … src/utils/designGuards.test.ts` **175/175**；
运行时探针新段 `npm run test:ui-runtime -- --only=navicon` **6/6**；
全仓内联 `<svg>` 的家现算 **2** 个（`python3` 用 `/<svg[\s>][\s\S]*?<\/svg>/` 扫 89 个 `.vue`，
注释里的 `<svg>` 不算）；lucide 导入面现算 **48** 个文件。

**变异（每格都证过会红，不是"有断言"就算完）**：
文本层 4 发 —— 去掉 links 的 `:active` ⇒ 红 1；`:fill` 写成常量 ⇒ 红 1；移动端 favorites 换回 `<Star/>` ⇒ 红 1；`active` 接反 ⇒ 红 1。运行时层 5 发 —— `:fill` 写成常量 `none` ⇒ 6/6→4/6（点第 1、4 格）；
`active` 接反 ⇒ →3/6（点第 1、2、4 格）；`evenodd` 全摘 ⇒ →5/6（点第 3 格）；
组件里私藏一条 `d="M2 2h20v20H2z"` ⇒ →4/6（点第 4、6 格，第 6 格正是"DOM 与表逐字相等"）；
`sizeClass` 写死 ⇒ →5/6（点第 5 格）。每发之间 `shasum -a 256` 核对还原字节一致，末了复验 6/6。
第 1 格那条"分母 ≥60"没单独变异 —— 它是防"扫描塌了整条白过"的下限，红条件是文件数骤减。

**两条自己造的假证，记在这儿免得再犯**：
① 变异脚本对没匹配上的 mode 也打印 `ok <MODE>` ⇒ "APPLY 成功"是假的，那一发的 `EXIT=0` 只能读成"没变异"；
现在未知 mode 直接抛，且写盘后回读确认针的命中数归零。
② `evenodd: true` 现算是 3 处不是 2 处 —— 第 3 处在我自己写的说明注释里（第 14 行）。
断言在写盘前拦住，所以那轮没有留下半份变异；改针为带缩进的形式后才真正打上。

**PC ↔ 移动图标对照（专项 §三要求的交付物）**

| 语义 | PC 端 | 移动端 | 来源 | 标记 |
|---|---|---|---|---|
| 聊天 | `NavIcon chats`（rail） | `NavIcon chats`（底栏 tab + 空状态） | navIconPaths | 已替换（同一只组件） |
| 通讯录 | `NavIcon contacts` | `NavIcon contacts`（tab + 空状态） | navIconPaths | 已替换 |
| 收藏 | `NavIcon favorites` | `NavIcon favorites`（tab + 空状态） | navIconPaths | 已替换 |
| 外部链接 | `NavIcon links` | `NavIcon links`（抽屉行 + 空状态） | navIconPaths | 已替换 |
| 设置 | `Settings`（更多二级菜单） | `Settings`（抽屉行）；面板本体两端是**同一个 `SettingsPanel`** | lucide | 已统一（分叉不存在） |
| 运行日志 | `ScrollText`（二级菜单） | `ScrollText`（抽屉行） | lucide | 已统一 |
| 深/浅色切换 | `Sun` / `Moon` | 同一开关在设置面板里 | lucide | 保留（同库同档） |
| 更多菜单 | `MoreHorizontal` | 移动端不用三点，改用抽屉列表 | lucide | 保留（交互差异，非造型差异） |
| 我的 | PC 无此入口 | `UserCircle` | lucide | 例外：移动端独有入口，PC 无对照项 |
| 返回箭头 | `BackArrow`：iOS 档 `ChevronLeft`、其余档 `ArrowLeft` | 同（组件本身按平台分支） | lucide | 已替换（iOS 那档此前是手抄库路径） |
| 聊天输入区 | `Folder`/`Smile`/`SquareCode`/`Users`/`Zap`（`MessageComposer`） | 同一组件 | lucide | 已统一（本轮只核不动：本就同源） |
| 设置各分组 | `UserRound`/`Palette`/`SlidersHorizontal`/`Wifi`/`HardDrive`/`Lock`/`Info`/`Bell`/`FolderOpen`（`SettingsWindow`）+ 各 Section 的 `Camera`/`BellRing`/`Download` | 同一批 Section | lucide | 已统一 |
| 窗口标题栏控件 | `TitleBar.vue` 内联 `<svg>` ×5 | 移动端无标题栏 | 自绘 | **保留自研**：OS 窗口控件的造型必须逐平台贴着真实标题栏，不是应用功能图标 |

`TitleBar.vue` 这格按专项口径也属"自绘"，但它画的是 macOS 交通灯/Win 标题栏符号（含 10×10 的两枚），
换 lucide 反而失真 —— 若你要严格统一到"零内联 svg"，说一声，我把那 5 枚换成 `Minus`/`Square`/`X` 并留对照截图口径。

**没做与不能在这台机器上做的**：观感（0.1px 描边档、实心 vs 描边的选中态在 macOS/Win 真实 DPI 下的表现）
只能真机判；iOS/Android 端图标渲染一致性依赖 §6.91 那条安全区链的真机读数，仍未验。

### 6.93 只读审计：文档里的路径引用是否还指得到真文件（10-20，专项 §八「过时文件引用」这一格）

专项 §八 要求核实"已失效的操作步骤和过时文件引用"，§十一 问 7 也要这条。现有的 `check-doc-citations.mjs`
只验 `` `file:line` `` 那一种写法（现算 73 处全绿），**散文里写的 `docs/xxx.md`、`src/...vue` 没人查**。
这一轴此前没数过，现在一次数完（只读，不改代码）。

扫 71 份 `.md`（`docs/**` + 根目录），用 `(docs|src|src-tauri|scripts|e2e|tests)/…\.(md|ts|vue|rs|py|mjs|json|html|sh|yaml|yml)`
取路径样 token，逐条问"这个路径在工作树里存在吗"；不存在的再分四桶（每桶都给复跑口径）：

| 桶 | 条数 | 判定 | 处置 |
|---|---|---|---|
| 同行上下文写着"不存在／已删／不再" | 13 | **故意的断言**（含 §11 那张复算表：`hoverCard.ts`/`useHoverCard.ts`/`contextMenu.ts` 就是"三册都不存在了"） | 不动 |
| Rust 侧简写：写作 `src/x.rs` 而 crate 根就是 `src-tauri/src/` | 37 | 记法问题，不是断链；改它要连 Rust 文档一起扫，属别的领域 | 不动，交后端那一轮 |
| 同名文件确实在别处（真·错定位） | 5 → **读完原文剩 2** | 3 条是我这遍分诊的假报（见下） | 2 条点名不代改 |
| 别处也没有（孤儿引用） | 23 | 绝大多数是 `changelog-archive.md`/`notes/` 里**描述当时存在、后来被删**的文件 ⇒ 历史证据，不是链接 | 不动 |

**第一遍读数 78 条，逐条读原文后本专项范围内可改的是 0 条。** 那 3 条我自己数错的假报，形状都记下来：
① `docs/audit/evidence-2026-10-16/security-maintainability.md:13` 是一行 `$ ls …` 的**命令输出证据**，
它列的就是"这两个文件不在"，我的正则把它当引用了；
② 同册 `:28` 整句是「任务里写的 `docs/acceptance/stability-roadmap.md §9` 同样是**错路径** —— 真路径是
`docs/stability-roadmap.md`」—— 引用出现的位置是**被批评的主语**，不是定位符；
③ `CHANGELOG.md:5217` 写的是"这一条判据**原来**只读 `e2e/core.mjs`，后来加宽到 `scripts/e2e/…`"，
是变更史实，改它等于改已发布记录（专项 §十二 不许）。

剩下 2 条真错定位，都不在本任务、也不该由我改：
`docs/notes/community-repos-review.md:49` 引 `src-tauri/src/core/window.rs`（同名文件现在在 `commands/window.rs`），
属 Rust 侧那一轮；`AI_TASK_HANDOFF_20261012.md:205` 引 `src/components/group/GroupTasksBoard.vue`
（真路径没有 `group/` 这一层），而这个文件 **git 未跟踪**（`git ls-files` 空），是别的会话留在工作树的交接稿。
⇒ 写进"需要你来处置的最短清单"，我不动别人的册子也不动未跟踪的交接稿。

**为什么不顺手加一条"文档不许引用不存在的路径"的判据**：上表四桶里有三桶（13 + 37 + 23 = 73 条）
按现有事实**必然是红的**，而它们红的都是正当语义（已删断言、Rust 记法、历史描述）。要把判据做绿就得
开一堆豁免或改窄匹配 —— 那正是"为了让测试变绿而扩大忽略规则"，专项 §八 明令禁止的形状。
真要钉这一轴，得先把"引用/主语/历史"三种角色在文本里区分开，那是独立一轮的事，不在这批顺手做。

复跑口径（现算 78 条粗筛）：
`python3` 扫 `docs/**/*.md` + 根目录 `*.md`，取路径样 token 后 `Path.exists()` 取非。

### 6.94 「这条窗口有没有 caption」收给画它的人（10-20，用户 2026-09-30 那条不变量的第二个洞）

**怎么发现的**：上一批（§6.92）收尾时全量探针有一格红（`遮罩把标题栏那一条让开了`，实际
`ovTop=0 / capBottom=28`）。我先把它判成"段间顺序污染"并这样报了 —— **那句归因是错的**：
红的那格在 `runCaption` 里（`scripts/check-ui-runtime.mjs:3505`），而 `--only=overlay` 根本不执行那一段。
单跑 `--only=caption` 同样红 ⇒ 与顺序无关。把浏览器真值量出来后根因很清楚：

| 现读到的事实 | 读数 | 复跑 |
|---|---|---|
| 探针页面里 caption 是 28px、遮罩是 0px | `capBottom=28 / ovTop=0` | `npm run test:ui-runtime -- --only=caption`（退 1，7/8 绿） |
| 真·桌面页面（非移动布局）上那枚出口是对的 | `--gosslan-window-safe-top: 28px`、`--gosslan-safe-top: max(28px, 0px)` | playwright 现读 `getComputedStyle(documentElement)` |
| 让位类名与工具条位置由同一个 CSS 变量决定，而它挂在**布局档**上 | `html:not(.is-mobile)` 才给值 | `grep -n "gosslan-window-safe-top: " src/style.css` ⇒ 定义两处（默认 0px + 桌面覆盖） |
| caption 画不画却看 **prop**，辅助窗的宿主不传 ⇒ 永远画 | `AuxWindowShell.vue:47`、`LogViewer.vue:236` 都不带 `:is-mobile`；`TitleBar.vue:242` 是 `v-if="!isMobile"` | `grep -n "TitleBar" src/components/window/AuxWindowShell.vue src/components/LogViewer.vue` |
| 「桌面但窄」确实存在，且日志窗默认就是那一档 | `resolveMobileLayout({android,ios,narrow})`、`MOBILE_MAX_WIDTH_PX=767`；日志窗 `inner_size(760.0, 560.0)` | `grep -n "MOBILE_MAX_WIDTH_PX" src/utils/platform.ts`; `grep -n "inner_size(760" src-tauri/src/commands/logs.rs` |

⇒ 同一个事实被两处各判一次：**CSS 按布局档猜"有没有 caption"，TitleBar 按 prop 决定"画不画"**。
桌面窗拖到 ≤767 CSS px（或日志窗这种默认 760 宽的）就得到"画着 caption、CSS 说没有 caption"，
于是预览遮罩顶边算成 0，右上角那颗 ✕/保存落进标题带底下被 `z-[85]` 的 caption 压住 ——
正是用户 2026-09-30 报的那一类。（§6.91 删 `topInset` prop 把这个洞从辅助窗那一路摊开到了全部宿主。）

**改法（不新增 prop、不加第二套机制）**：`TitleBar.vue` 成为这个事实的唯一写者 ——
它渲染 caption 时把 `has-caption` 写上 `<html>`（`watch` 跟 `props.isMobile` 翻，卸载时摘掉），
`style.css` 那枚 `--gosslan-window-safe-top` 的覆盖改挂 `html.has-caption`。
Tailwind 的 `desktop:` 变体**不动** —— 它管的确实是布局档，与"这条窗有没有 caption"是两件事。
读侧（`BaseModal` 的遮罩/滚动层/卡片 max-h、`ImageLightbox` 的外壳）一个字没改：出口还是那一枚。

**验证**（全部现跑，退码裸取）：

| 层 | 读数 |
|---|---|
| `npm test` | 1132/1132（本批 +2 条判据） |
| `node --test src/utils/designGuards.test.ts` | 177/177（判据 52 两条 + ㊱ 那条改了归属） |
| `npm run verify:local` | 22 步全绿 81.9s |
| 探针 `--only=caption` | 12/12 绿（旧 8 格 → 12 格：新增"申报了那个类"、"窄档仍让位"、"移动端不许白留一条标题带"、"摘掉类=修之前的几何"） |

**四发变异 + 两发我自己先否掉的假证据**（`python3 /tmp/mut694.py apply:<名>` / `undo:<名>`，恢复靠 sha 现核）：

| 变异（单点） | 运行时红格 | 文本层 |
|---|---|---|
| CSS 键退回 `html:not(.is-mobile)` | 1（"同一档遮罩仍要让开标题栏"——就是本轮缺陷那一格） | 判据 52 + ㊱ 共 2 条红 |
| TitleBar 不再写那个类（`!mobile`→`false`） | 4（两档"申报" + 两档"让开"） | 判据 52 写者那条红 |
| 那枚默认值改成 caption 高（=永远让位） | 3（两条对照 + "移动端不许白留一条标题带"） | 判据 52 + ㊱ 共 2 条红 |
| 把覆盖写成 `html { … }`（想测"永远让位"） | **这条没测到我想测的事**：`:root` 的特异性高于 `html`，实际变成"永远 0"⇒ 红的是另外两格 ⇒ 作废，改用上一发 | — |

自证伪的第二发：第一版 `stackRead` 的 `hasCaption` 读的是 **caption 元素在不在**，不是那个类在不在。
"TitleBar 不写了"那一发因此只红 2 格而不是 4 格 —— 名字写着"申报了 has-caption"、量的是另一件事。
补了 `captionClass`（现读 `classList.contains`）并把三格改到它上面，重跑才有上面那行 4 格。
还有一条纪律被这次坐实：**变异的针必须在"变异后"仍然唯一** —— 第三发的反向替换在变异态下有两处同文，
`undo` 直接拒写并留下已变异的工作树，靠 sha 现比（`9039bd8b90d7`）+ 上下文锚点才复原成基线。

**登记 NOT RUN**：真实设备上窄辅助窗的观感（本批改的是几何，浏览器合成档已证）；`env()` 那半仍只能真机证
（Chrome 里恒 0，见 §6.91 末）。判据 52 只钉"写者与画者是同一处"，观感不在它的射程内。

### 6.95 「回车 = 一个动作」全仓有 12 处，其中 9 处没让输入法先行（10-20，专项 §四.1 键盘交互）

**怎么发现的。** §四.1 要盘「Input 到底有没有公共家」。先把 20 处裸 `<input>` 按形状数完（18 文本 / 1 `type=file` / 1 `type=color`，4 种视觉档），
顺手把键盘行为一起数 —— 于是一眼看见 `useImeEnterGuard` 的文件头注释自己写着：

> 只要某处"回车 = 触发一个动作"（发送、打开搜索、提交表单），就会踩同一个坑。

这条规矩是 2026-09-12 那个真实缺陷（「输入拼音后按回车，英文没落下来，中文却发出去了」）换来的，
根因是 **macOS WKWebView 上 `compositionend` 先于 `keydown`**，那一刻 `isComposing` 已经是 false，
所以只看这个标准字段必然误判（`utils/ime.ts` 用三条互补判据兜，含 80ms 提交窗）。
现读：**这条规矩适用的 12 处里只有 3 处接了**（MessageComposer / ConversationList / ChatSearchDialog），
另外 9 处让业务码自己 `@keyup.enter="保存"`。

**为什么这 9 处是可见缺陷而不是洁癖**：漏掉的那几格恰好是**注定被中文命名的自由文本** ——
群名、任务标题、自定义分类、链接名、昵称。拼音打完按回车选字，那一下会被当成"提交"，
于是半成品（甚至还是拉丁字母）直接落库。代价方向与当初那条反馈完全一致。

**现读证据（命令可复跑）**

| 数什么 | 读数 | 命令 |
|---|---|---|
| 可编辑元素（input/textarea/contenteditable）上挂了 key/keyup 绑定 | 12 处 | `node /tmp/x695.mjs`（与判据 53 同一个起始标签解析器） |
| 其中带 `.enter` 提交 | 11 处 | 同上 |
| 改前接了守卫的文件 | 3 个 | `grep -rl "compositionstart" src --include="*.vue"` |
| 改后接了守卫的文件 | 9 个 | `grep -rl "useImeEnterGuard\|isImeKey" src/components --include="*.vue" \| wc -l` |
| 摘掉的接线数 | 9 处模板 + 删掉 ProfileSection 那份手写 `e.key === "Enter"` | `git diff --stat` |

**改法（组合替换，家不变）**：家还是那一个 `composables/useImeEnterGuard`，只给它加一个出口 `enter(fn)`
—— 返回值直接挂 `@keydown.enter` / `@keyup.enter`，输入法让路由这一格管，调用方只写动作本身。
加这一格的理由写在文件里：`isIme(e)` 要求调用方**自己拿事件再包一层函数**，全仓 9 处就得各写 4 行，
"每处自己接"正是这一族缺陷漏掉的原因。9 处接线各自补 `@compositionstart/@compositionend`；
ProfileSection 保留事件版（它的动作要用 `e.target.blur()`），改成 `@keydown.enter` + 进门先 `ime.isIme(e)`
—— 顺带把它那份只判 `e.key === "Enter"` 的手写版删了，并把 `@keydown`（所有键）收窄成 `@keydown.enter`（行为等价，
因为那个函数本来就只对 Enter 做事）。

**验证**

| 层 | 读数 | 命令 |
|---|---|---|
| 前端断言 | **1135/1135** | `npm test` |
| designGuards | **180/180**（判据 53 三条新用例） | `node --test src/utils/designGuards.test.ts` |
| 快速门禁 | **22 步全绿，81.7s** | `npm run verify:local`（退码裸取，未过管道） |
| UI 运行时探针 | `--only=imecommit` **5/5** | `npm run test:ui-runtime -- --only=imecommit` |

**变异（四发，每发都改坏即红、恢复即绿；家 `326f8c0c7ef3` / LinksList `574917a5e57a` 已 sha 对回）**

| 变异 | 红在哪 | 读数 |
|---|---|---|
| `enter` 不判直接放（摘掉守卫那半） | 运行时 3 格：组合中 / 那一拍 / 过窗后 | EXIT=1 |
| `enter` 只信 `e.isComposing`（退成单条判据） | 运行时 2 格：**正是 macOS 那一拍** + 其后计数被推歪的过窗格 | EXIT=1 |
| `enter` 恒不放（写成"永远不触发"） | 运行时 4 格：干净回车与过窗那两格先红 ⇒ 证明"不触发"两格不是恒真 | EXIT=1 |
| 摘掉一处的接线（LinksList 引 + 调用一起摘） | 判据 53 第 1 条红：`components/LinksList.vue(input,input)` | EXIT=1 |

**第 4 发第一版是我自己搞错的**：只删 import 行、留着 `LinksList.vue:71` 那个 `useImeEnterGuard()` 调用点，
判据整册绿 —— 我一度把这条记成"判据不咬"。复跑 `grep -n` 才看清文件确实还引着这个家，
那条判据认的是"这个文件引没引家"，所以它绿得对，错的是我的变异针。**记在这儿是因为这正是"缺席型判据要先证它真的缺席"**。

**判成保留自研的相邻两格（不动码，留读数）**：`<input>` 的 4 种视觉档（filled / outlined / inline / inset）
本轮**不并成 `ui/TextInput.vue`**。理由是读数，不是口味：`focus:border-transparent` 在 18 处里全是空转
（`style.css:493` 那条 `input:focus` 是**空的**，且这是用户 2026-09-16「输入框聚焦时那个主题色方框很难看」的口径，
另有护栏 `checkTextFieldFocusRing` 钉着"有意留空"）—— 我一开始把它当成"缺焦点环"的缺陷，读了 CSS 与护栏才否掉。
并档要先解决"同一语义（弹窗内搜索框）现在有三种形状"，那是视觉档决策，需要真机眼睛判，不能由我从 class 字符串反推。

**未跑 / 只能他证**：真机 iOS WKWebView 与 Android WebView 上的输入法组合顺序（这里的事件是合成的，
浏览器没有可驱动的假输入法）；9 处各自的手感复看。

### 6.96 卡死的量具改成会自述的：全量探针超时定位 + 端口释放 + 分层返回那三条判据换维度（10-20，专项 §十 P0「全量 UI 探针超时」）

**这一批不改产品码，改的是量具本身** —— 因为 §十 把「全量 UI 探针超时」点成了 P0，
而一条"不知道死在哪"的判据既挡不住回归、又会把下一趟的归因带偏。三件事，各自有读数。

#### ① 版本号收口（并行会话报来的那条「一个提交里出三个号」）

现读工作树五处版本清单全部 **5.0.37**（`node scripts/version.mjs show` → `5.0.37`、
`npm run version:show` → 退 0、`npm run version:check` → 退 0）。做两件事：
`git restore --staged src-tauri/tauri.conf.json` 撤掉那次 5.0.37→5.0.36 的**暂存回退**
（工作树本来就是 5.0.37，撤完该文件对 HEAD 零差异、无内容损失），再把 `package.json`
与 `package-lock.json` 的三处版本行从 5.0.35 改回 5.0.37。

⚠️ 一处要纠正的转述：`package.json` 相对 HEAD 的差**不止版本行**。我这四册测试
（`safeStorage` / `textLimits` / `singleFlight` / `panelQuery`）在 HEAD 的 `test` 脚本里各命中
**0 次**、在工作树各命中 **1 次**、文件都在盘上 —— 也就是说那一份是"5.0.35 的底 +
我的四条登记"，不是单纯的回退。现读 `git diff HEAD --stat` 对五个版本文件只剩
`package.json | 2 +-`（就是这一行），提交时必须带走，否则那四册在 HEAD 上零判据。

#### ② 快层整跑一遍并贴逐步读数（`npm run verify:local`，裸退码，不管道）

**退 0，22 步，共 74.2 s**（日志 `/tmp/vl-5037.log`）。逐步：1 前端测试清单 ✅（磁盘 99 个全登记）·
2 不变量例外 ✅（2 条）· 3 不变量钩子 ✅（34 条全绑定）· 4 私钥边界 ✅（79 类型 / 144 命令体）·
5 db 锁作用域 ✅（327 guard + 27 语句量，持锁调用自锁 helper 0 处）· 6 文档硬数字 ✅ ·
7 `file:line` 引用 ✅（73 处）· 8 shell 变量 ✅ · 9 脚本可解析 ✅（63 个）· 10 护栏锚点 ✅ ·
11 BLE 单一事实来源 ✅ · 12 领域图 ✅（416 文件无重叠）· 13 依赖方向 ✅ ·
**14 Change Budget ⚠️ 零覆盖 0.2 s**（`origin/main..HEAD` 为空 ⇒ 无可判对象；零覆盖 ≠ 守住，不当通过）·
15 CHANGELOG ✅ · 16 `npm test` ✅ **1135/1135，fail 0** · 17 静态检查+构建 ✅（2898 modules）·
18 fmt ✅ · 19 clippy `-D warnings` ✅ · 20 Rust 单测 ✅ · 21 Rust 清单 ✅（基线 1007 全在跑）·
22 Android 编译 ✅ 10.6 s；「护栏非空转」按 `--skip-guard-sweep` 本地跳过（发版/CI 必跑）。
另：`git diff HEAD -- src-tauri` **为空** ⇒ 这棵树里的 Rust 就是 HEAD（tip `e66e500`）那份，
上面 18–22 步测的正是它。

#### ③ 超时那条报错改成会自述死在哪（`scripts/check-ui-runtime.mjs`）

旧版只说「`Runtime.evaluate` 在 45000 ms 内没回包」，于是归因只能靠 `--only=` 逐段复跑二分 ——
而这条链的实测形状是**非单调**的：`roster,overlay` 两格卡死，`reaction,roster,overlay` 却 105 格全绿；
`lightbox,overlay` 稳定红在另一格。二分本身给了假结论（我一度把 `history.length` 那格判成
"被前一段污染"，见 ⑤）。所以现在直接印三样：**最后一条已记录的判据（第几格 + 名字前缀）**、
**仍未到账的调用条数**、**最近 6 条 CDP 事件尾巴**（`this.eventTail`，含
`Page.javascriptDialogOpening` / `frameNavigated` / `executionContextDestroyed` 这三类形状 ——
旧代码 `if (!w) return` 把事件整个丢掉，三种死法在日志里长得一模一样）。
配套把 `catch` 里那格的 `slice(0, 300)` 放宽到 1200，否则定位信息会被截走。

#### ④ 卡死那趟不再污染下一趟

实测读数（`/tmp/full_probe_696.log`、`697.log` 两趟同形）：收尾这段走完有界等待后印
「端口让位耗时 10000 ms —— 到点仍被占着，下一趟会红」⇒ **SIGTERM 治不了 renderer 已不响应那一档**，
于是下一趟必红在「环境：CDP 端口 9444 起跑前空闲」，看着像护栏坏。现在等不到就升级 SIGKILL
（9444 那个监听 socket 在 Chrome 父进程手里）再短等一轮，仍占着才承认残留并打印 `lsof` 复跑命令。
本轮两趟没复现卡死（`roster,overlay` 85/85），所以这一支的**新行为未被实测触发** —— 只证了
它没有把正常收尾变慢（两趟都没印「端口让位」，500 ms 内就空了）。

#### ⑤ 分层返回那三条判据换到对得上的那一维

`history.length` 是**整个标签页**的条目总数，而"打开压一条"要的是**我们那一条**。现读证据：
`--only=lightbox,overlay` 报 `预期 histLen > 3 / 实际 histLen=3`（同一段单独跑 `--only=overlay` 是绿的）
⇒ 这条判据随跑段顺序变。改成读 `history.state.gosslanBackLayer`（`utils/backStack.ts` 压进去的
那枚标记，每份文档自己从 1 起）：

| 格 | 判据 | 换之前 | 换之后 |
|---|---|---|---|
| A 打开 | 当前条目是我们压的那一条 | `histLen > 基线`（随顺序红） | `histLayer != null && != 基线` |
| A 后退 | 条目退回打开前那一条 | 只判 close 计数 +1 | 新增：`bk.histLayer === base.histLayer` |
| C 连开关 3 轮 | 我们那条没漏在外面 | `histLen <= 基线+1`（饱和即恒绿） | `f.histLayer === cbase.histLayer` |

**这三处不是放宽**：压一条同 URL 条目必然同时涨总数并换 state，所以新读数是旧断言的加强，
并且还能认出"state 被换成别的东西"这种旧读式放过的形状。

#### ⑥ 五发实测（改坏即红，两发各自只点自己那一面）

| # | 变异（唯一落点 `composables/useBackLayer.ts` 的 `browserPort`） | 探针读数 |
|---|---|---|
| 基线 | 无 | `--only=lightbox,overlay` **51/51**（换维度前同命令 49/50 红）、`--only=overlay` **42/42** |
| 1 | `push` 一条都不压（直接回报失败） | **13/15**，红的正是「A 打开确实压了我们自己的那一条」+「探针自己跑完了」（后续段抛错 ⇒ 响亮失败），退 1 |
| 2 | 一次打开压两条 | **40/42**，红的正是「A 后退之后换回了打开前那一条」与「C 连开关 3 轮之后退回基线」两条，而 A 打开那格仍绿 |
| 还原 | 两发各自按 sha 逐字节还原 | `RESTORED_SHA c10f875ebef3 MATCH` ×2，`grep -c MUTANT` → 0 |

**两发各点不同格** ⇒ 三条新判据不是同一句话的三种写法。

#### ⑦ 顺带把两条诊断命令接到界面上（后端 5.0.37 交付的命令面）

`src/api/index.ts:497 getLogLocations` / `:505 exportDiagnosticsBundle`（返回类型
`LogLocations{dir,current,crash}`、`DiagnosticsBundleSummary{bytes,files,redactions,path}`，
Rust 侧无 serde rename）；`components/LogViewer.vue` 桌面 standalone 工具栏加「复制日志路径」
「导出诊断包」两颗（图标 `FileDown`/`ScrollText` 直取 lucide；落点走 `plugin-dialog` 的 `save()`
经 `saveDestinationOf` 归一化、取消含 Android 的 reject 都不弹红条、错误走 `errorText`）；
两份语言包各补 7 键（`zh-cn.ts:53-59` / `en-us.ts:53-59`）；
`src/api/events.test.ts` 的 `DEAD_COMMANDS` 删掉这两条挂账（`get_topology` 保留）。
实测：`node --test src/api/events.test.ts src/utils/mapContract.test.ts` 退 0；`npm test` 1135/1135；
`npm run build` 退 0；`check-doc-numbers` / `check-doc-citations` 各退 0。
⚠️ 我一度收到一份"这三键只在 dict.ts、zh 下 t() 会返回键名"的转述 —— 自己读源否掉了：
`i18n/locales.ts` 只是门面再导出，`zh-cn.ts` 是一份完整册（`:43` 就是 `logs.title`），
`t()` 按正则从**当前语言的模板**里抽 `{name}` 再插值（`index.ts:108-116`），
`logs.exportDone` 那句中文里 `{files}/{redactions}/{size}` 都是真占位符。
另外 `commands::open_local_path` 这个符号**在 src-tauri 里不存在**（只有
`commands/logs.rs:42` 那句注释提到它；真家是 `open_path.rs:16 open_path_native` 与
`android_open.rs:90 open_path`）⇒ "在文件夹中显示"那一格的前提要先改名对齐，
且我拍的板是**给那条托管目录闸加一条具名的日志目录分支**而不是开 `opener` 的 reveal 权限
（能力表现读只有 `opener:default`，reveal 要在 OS 层另开一扇门还得五端重生成能力）。

**未跑 / 只能他证**：release 构建里真按一次这两颗按钮 + 导出物 `grep -c "$HOME"`、
`grep -c "192\.168\."` 都为 0（要真实日志内容，只有负责人能做）；
③④ 两支加固在真实卡死场景下的效果（本轮没复现卡死，只有历史两趟的"到点仍被占着"读数）；
`overlay` 全段在手机真 WebView 上的表现（这里的事件与 history 都是 Chromium 合成的）。

### 6.97 菜单贴边那一格终于拿到运行时凭据：挂父级 + 390 宽窄视口 + 一发打到生产码的变异（10-20，专项 §十 P0「菜单贴边运行时验证」）

**欠的是哪一格**：§6.86/§6.88 两次撞在同一堵墙上 —— 探针把菜单组件**当根强开**时，Reka 的
`DropdownMenuContent` 根本不进 DOM（那趟 `errs:[]` ⇒ 否定证据，排除了"渲染抛了"这个解释），
当时留下的结论是"配方是挂父级、靠状态渲染"。本段照那条配方把凭据补上。

**先确认几何只有一个 owner**：`src/components/conversation/ConversationContextMenu.vue` 与
`src/components/conversation/FriendContextMenu.vue` 都渲染同一份 `src/components/ContextMenu.vue`
（Reka 壳 + 虚拟 `reference` 锚点 + `:collision-padding="8"` + `side="bottom" align="start"`），
所以贴边只有一处实现、两个业务入口 ⇒ 判据量这一处就够，不必每入口各写一份。

**探针改动**（`scripts/check-ui-runtime.mjs`，只动量具不动产品码）：
① `H.installMenu(propsJson, specJson)` 加第二个参数 `spec = {path, emits}`：不传时仍是消息菜单那一份
（`ctxmenu` 段零改动），传了就挂业务菜单 —— 这就是 §6.88 那条"挂父级、靠状态渲染"的配方；
② 新增 `menufit` 段：用 `Emulation.setDeviceMetricsOverride` 切到 **390×844**，把会话菜单与联系人菜单
分别开在右下角，量三件事：整块四边是否还在视口内、说明行（`.gosslan-menu-hint`，纯 div、不进菜单集合）
是否还在视口内、以及一组对照（把 popper wrapper 推出右缘 ⇒ 同一条 inside 读数必须翻假，换回来必须又成立）。

**实测读数**（每条都带复跑命令）：

| 步骤 | 命令 | 读数 |
|---|---|---|
| 基线 | `node scripts/check-ui-runtime.mjs --only=menufit,ctxmenu` | **EXIT=0，21/21 绿**（新段 9 格全绿） |
| 单点变异 | 在 `src/components/ContextMenu.vue` 的 `DropdownMenuContent` 上加一行 `:avoid-collisions="false"`（关掉"贴边交给 popper"这件事；Reka 默认 `avoidCollisions: true`）后跑 `--only=menufit` | **EXIT=1，3/9 绿** |
| 还原 | `cp` 回备份 ⇒ sha256 `f78a9b3c…5178515b783`（与变异前同一串）、`diff -q` MATCH、`grep -c "avoid-collisions"` = 0 | 零残留 |
| 复跑 | `node scripts/check-ui-runtime.mjs --only=menufit,ctxmenu` | **EXIT=0，21/21 绿** |

**变异打红了哪几条、读数是多少**（这才是"贴边"在 390 宽上的缺陷形状，是量出来的不是推演的）：

| 读数 | 变异后实际值 | 视口 |
|---|---|---|
| 会话菜单整块 | left=384 top=838 right=612 bottom=972 ⇒ **右溢出 222 px、下溢出 128 px** | 390×844 |
| 联系人菜单整块 | left=384 top=838 right=634 bottom=950 ⇒ **右溢出 244 px、下溢出 106 px** | 390×844 |
| 说明行 | 会话两条 hints 在 left=391..right=605（bottom 900/965）；联系人一条在 left=391..right=627（bottom 943）⇒ `hintsInside=false` | 390×844 |

两条对照格在变异下也红：它们的第一句就是 `clean.inside === true` ⇒ 生产几何一坏，整条链跟着红
（**依赖，不是误报**）。反过来说，基线那 21/21 里"对照：把 popper wrapper 推出右缘 ⇒ inside 读数真的翻假"
与"对照可逆"这两格，说明 `inside` 这个读数**本身会动**，不是恒真。

**为什么这发变异打的是生产码而不是夹具**：菜单内容**不能**自己 `fixed`（那样 popper 量到的 wrapper 是 0×0，
翻转与内收会静默失效）—— 贴边完全由 Reka 的 popper wrapper 负责测量/翻转/内收 ⇒ "关掉碰撞处理"是唯一能
真正让菜单出界的单点，而那正是 `ContextMenu.vue` 里的一行 prop。

⚠️ **未跑**：真机（iOS WKWebView / Android WebView）与真实 Tauri 窗口里的同一格 —— 这里量的是 Chromium
合成视口；桌面宽窗那一格仍由 `ctxmenu` 段的「贴右下角弹出时整块翻到视口内」覆盖（那条也是变异过、还原过的）。

**并进全量的那次跑（10-20 补）**：`node scripts/check-ui-runtime.mjs`（全量，退码裸取）
⇒ **EXIT=0、488/488 绿**（上一轮那次是**截断**在 264/265，这轮才是完整的一轮）。`menufit` 那 9 格在
全量顺序下同样全绿（日志里紧挨着 `navicon` 段之后：`对照：窄视口夹具真生效（390×844）` → 会话/联系人各 3 格
→ `对照：把 popper wrapper 推出右缘` → `对照可逆`）—— 说明那 9 格**不依赖前面任何一段的残留**，
不是只在 `--only=menufit` 的干净环境里才成立。**并进全量的欠账到此清掉**；仍未跑的只剩真机那一格。

### 6.98 `LinksList` 连读带写一起交给 TanStack Query：写侧不是「回填一个 ref」，而是把后端返回的整份数组写回读缓存（10-20，P1，专项 §十 P0「LinksList 等已明确登记的剩余工作」）

**欠的是哪一格**：§6.90 那张表的第二格，原文判「暂缓替换」，理由是三条写命令（增/改/删）各自把后端返回的**整份数组**直接回填同一个 `links` ref ⇒ 只迁读的那半边就是"套一层库、旧实现全留"。本段把读写一起交出去。

**生产码改动**（`src/components/LinksList.vue`，工作树 227 → 257 行；多出来的 30 行是注释与联合类型，没有新功能）：

| 旧 | 新 |
|---|---|
| `links` / `loading` / `loadError` 三枚 `ref` | `useQuery(panelQueryOptions<ExternalLink[]>("links", "", () => api.listExternalLinks()))`，三枚全改成 `computed`（`LinksList.vue:42`） |
| `onMounted(load)` + `async load()` + `try/catch/finally` | 删除；重开重拉、单飞、失败补一次由 `PANEL_QUERY_POLICY` 管 |
| 三条写命令各自 `links.value = await api.xxx(...)` | 一枚 `useMutation`（`LinksList.vue:75`）：`mutationFn` 按 `kind` 分到 add/update/remove，`onSuccess` 里 `setQueryData(panelKey("links",""), data)` |
| `const saving = ref(false)` | `computed(() => writeLink.isPending.value)`（`LinksList.vue:88`） |
| 三个 `catch` 各自 toast | `onError` 按 `kind` 取 `links.addFail / updateFail / removeFail`（三条话术没合并成一句） |

**三条口径原样搬、一条故意换掉**：
· `loading = isFetching`（首帧与每次重拉都算加载中）、`loadError` 只在 `error && !data` 时说话 —— 与 §6.90 那格同一条业务口径；
· **故意换掉的**：旧实现刷新失败会**无条件**置 `loadError`，而模板的 `v-else-if="loadError"` 排在列表之前 ⇒ 一次后台重拉失败就把用户正在用的列表整屏换成错误页。新写法遵循面板族契约（`utils/panelQuery.ts` 头注释："失败保留旧数据"），有快照时保留列表。这是**用户可见的行为变化**，记在这里而不是让它悄悄发生；
· 写成功为什么是 `setQueryData` 而不是 `invalidateQueries`：后端三条写命令本来就返回整份数组，写回缓存与旧实现"把返回值回填 ref"同义，且**不再多发一次 list 命令**——下面变异 B 量的就是这两者的差别。

**判据（两层）**：
① 单元层：`src/utils/panelQuery.test.ts` 新增两格（读键 `["links",""]`、三条命令各自接线、键从 `panelKey` 现算、`saving` 来自 `isPending`），并把存量登记册从 **6 格改成 5 格**（LinksList 迁走 ⇒ 命中集合必须**恰好**等于剩下 5 格）；
② 运行时层：探针 `links` 段从 **6 格加到 9 格**。夹具 `H.linksStore(initial)` 把四条命令换成一份内存表（四条都返回整份数组，与 Rust 同形），三条新格在真浏览器里驱动**增 / 改 / 删**，每条同时断三件事：发的是那条命令、列表立刻变成返回值的形状、`list` 的调用次数**全程不变**。

**实测读数**（每条都带复跑命令，退码裸取）：

| 步骤 | 命令 | 读数 |
|---|---|---|
| 基线 | `node scripts/check-ui-runtime.mjs --only=links` | **EXIT=0，9/9 绿** |
| 变异 A（不写回） | `onSuccess` 里的 `setQueryData(...)` 删成空函数后跑 `--only=links` | **EXIT=1，6/9 绿** |
| 还原 + 变异 B（改失效重拉） | 换回备份后把 `setQueryData(...)` 换成 `invalidateQueries({queryKey: panelKey("links","")})`，再跑 | **EXIT=1，6/9 绿** |
| 还原 | `cp` 回备份 ⇒ sha256 `449058c3…9242d49`、`diff -q` MATCH、`grep -c "MUT-A\|MUT-B"` = 0 | 零残留 |
| 复跑 | `node scripts/check-ui-runtime.mjs --only=links` | **EXIT=0，9/9 绿** |

**两发变异各自量到什么**（失败那几格的实际读数，不是推演）：

| 变异 | 新增三格的实测 |
|---|---|
| A：不写回缓存 | `{"list":1,"add":1,"update":0,"remove":0}`、`rows` 仍是两条（`intra` / `docs`）⇒ 命令发了、列表不动 |
| B：改成失效重拉 | `list` 依次 **2 → 3 → 4**，而 `rows` 每一步都对 ⇒ **行数那半边会放过它**，抓住它的是"list 不变"那半边 |

变异 B 是关键的一发：它证明这三格量的不是"列表最后对不对"，而是"**写回**还是**重拉**"——后者在本地桩下也能把列表补对，只有调用次数分得开。

**门禁读数（本次真跑，退码裸取）**：`npm test` **1137/1137、fail=0**（比上批 +2 = 新加的两格接线判据）；`npm run verify:local` **22 步全通过**、首跑 **76.4 s** / 收尾复跑 **65.3 s**（含 vue-tsc 与构建 ⇒ 改过的 `.vue` 类型与 `useMutation` 泛型成立），其中"测试清单守卫（前端）"通过。

⚠️ **NOT RUN / 边界**：
· §6.90 原文要求"真机验增删改"——本段只在 **Chromium 合成视口**里驱动；iOS WKWebView / Android WebView 与真实 Tauri 窗口那一格**仍未跑**（同一份 DOM 交互，但没有真机凭据就不写成通过）；
· 本批**没有再跑一轮全量探针**：全量 488/488 那次读数属于**本批之前**的树；本批只跑了 `--only=links`（先 9/9，补完写失败那格后 10/10，见 §6.99）；
· ~~写失败的 toast 文案只在源码层钉了三条 key…没有运行时凭据~~ —— 已在 §6.99 补上（同一页挂 ToastHud + 一次性 reject），现为 `links` 段第 10 格。

### 6.99 写失败的那格补上**真实可见反馈**：同一页挂出 ToastHud，让 add 真抛一次（10-20，P1，§6.98 的 NOT RUN 之一）

**欠的是哪一格**：§6.98 末尾写着"写失败的 toast 文案只在源码层钉了三条 key；`links` 段不挂 ToastHud ⇒ 没有运行时凭据"。这条不补，"写失败必须有反馈"就只是一句承诺 —— `onError` 被摘掉时，列表照样不变、草稿照样开着，**屏幕上一片安静**，而所有既有判据都会绿。

**探针改动（只动量具，不动产品码）**：
① `H.mountToastHud()`：`install` 只建一个 `#probe-host`，这里再用**页面那份 vue** 建第二个 app 挂到 `#probe-toast-host`；ToastHud 只读模块级 `toastManager`、不碰 pinia，所以不需要第二份 store；
② `H.linksFailNext(kind)`：内存表加一枚一次性 `fail` 开关，下一次对应写命令真 `throw`（与真实 IPC 失败同形：调用方 await 到的是一次 reject）；
③ `H.toastRead()`：与 `--only=toast` 段**同一套选择器**（`li[data-status]` + 可见性过滤 + `[role=alert]`），不另造一把尺。

**新判据（`links` 段 9 → 10 格）**：一次失败的"新增"必须同时满足四件事 ——
`st4.add === 2`（命令真发了、真失败了）、`st4.list` 不变（失败不触发重拉）、
`toast.visible >= 1 && statuses.includes("error") && texts.some(t => t.includes("添加链接失败"))`（屏幕上有 error toast 且是 `links.addFail` 拼出来的那句）、
`s.rows.length === 2 && !s.rows.includes("https://boom.example.com") && s.inputs.some(i => i.value === "会失败")`（**没被当成成功**：列表没多、草稿与已填内容都还在）。

**实测读数**（退码裸取）：

| 步骤 | 命令 | 读数 |
|---|---|---|
| 基线 | `node scripts/check-ui-runtime.mjs --only=links` | **EXIT=0，10/10 绿** |
| 变异 C（静默失败） | 把 `onError: (e, v) => app.toastError(...)` 改成空函数后跑 | **EXIT=1，9/10 绿**（只有写失败那格红） |
| 还原 | `cp` 回备份 ⇒ sha256 `449058c3…9242d49`、`diff -q` MATCH、`grep -c "MUT-C"` = 0 | 零残留 |
| 复跑 | `--only=links` | **EXIT=0，10/10 绿** |

变异 C 的实际读数（失败那格原文）：`{"hud":{"ok":true},"toast":{"total":0,"visible":0,"texts":[],"statuses":[],"alerts":0},"st4":{"list":1,"add":2,"update":1,"remove":1},"rows":["https://intra.example.com","https://docs.example.com"],"inputs":[{"ph":"显示名称","value":"会失败"},…]}` ——
**命令发了（add=2）、列表与草稿都对，唯独屏幕上一个字都没有**。这正是"静默失败"的缺陷形状，也证明这条判据抓的不是"是否成功"而是"失败有没有说出口"。

⚠️ **边界**：这条量的是 **Chromium 里的 ToastHud 真 DOM**（复用生产 `ToastHud.vue` 与生产 `toastManager`），不是真机；真机上的系统通知与 toast 的层叠关系仍未跑（见 §11 问 5）。

**全量那一轮（本批最终读数）**：`node scripts/check-ui-runtime.mjs` 全量、退码裸取 ⇒ **EXIT=0、492/492 绿**，耗时 **6 分 12 秒**（15:13:35 → 15:19:47）。492 = 上一轮 488 + LinksList 新增 4 格（增/改/删/写失败）。`menufit` 9 格、`links` 10 格、`overlay` 42 格都在同一轮全量顺序里全绿。
**中间踩到一次探针自身的卡死**：第一次全量跑到**第 273 格**后 `Runtime.evaluate` 45 s 无回包（`273/274`，自述"死在第 273 格之后，不是产品红"）；单跑 `--only=overlay` **42/42 绿** ⇒ 不是产品回归，是那一段（全量里泵帧最密）被遮挡时 rAF/截图会停。修法只动量具：`runOverlay` 的 `boot()` 起页前补 `Page.bringToFront` + `setFocusEmulationEnabled`（其余十几个段本来就是这么写的）⇒ 复跑全量 **492/492**。**这不是放宽判据**（没有任何一条断言被删或改），是把"窗口被盖住"这个环境变量从量具里去掉。

### 6.100 诊断面板的「加载中 / 有数据 / 刷新失败保留旧数据」不再只靠人眼：`diag` 段 4 格（10-20，P1，§6.90 的 NOT RUN 之一）

**欠的是哪一格**：§6.90 把诊断面板的三态登记成"探针今天没有 `diag` 段 ⇒ 只能由用户复看"。这一格是 §八 清单里**唯一还能自动化**的一项，本轮补上。

**探针改动**：`H.diagDeferred()` 把 `getDiscoveryDiag` 换成可控夹具 —— 首次调用挂起（量"加载中"），`H.diagResolve(payload)` 决定成功，`H.diagFailWith(msg)` 之后每次调用立即 reject（量 `retry:1` 之后真的进 error）。四格：
① 命令在飞 ⇒ 屏上是「加载中...」；
② 解析后 ⇒ 模式 / 绑定 IP / TCP 监听 / 版本行都在；
③ 点刷新 + 命令 reject ⇒ **旧读数仍在、整屏没被「诊断数据读取失败」换掉**；
④ **反控**：干净缓存 + 一开始就失败 ⇒ 必须把「诊断数据读取失败」说出来（否则③只是"永不报错"的别名）。

**实测读数**：`--only=diag` **4/4、EXIT=0**。

**这一格差点写成空转 —— 两发单点变异都没咬住，第三发才咬住**（这是本批最值得记的一条）：

| 变异 | 改了什么 | 结果 |
|---|---|---|
| D（单点） | 把 `loadError` 里的 `&& !diag.value` 摘掉 | **仍 4/4 绿** |
| E（单点） | 把模板 `<template v-if="diag">` 改成 `v-if="diag && !loadError"` | **仍 4/4 绿** |
| **F（两点）** | 上面两处**同时**改 | **3/4**，只有③红 |

读数（F）：`{"before":1,"after":3,"head":"网络诊断（开发者）\n刷新数据\n\n诊断数据读取失败，请稍后重试\n\n重试"}` —— 旧读数被错误页换掉、`calls` 1→3（retry 一次）。还原 sha `b9f9381a…342d18fd`、`diff -q` MATCH、`grep -c MUT-`=0，复跑 4/4。

**为什么会这样（更正 §6.90 的一句措辞）**：`loadError` 自己的表达式里就带着 `!diag`，模板又把 `v-if="diag"` 排在错误块之前 ⇒ **两道闸互为等价变异**：任摘一道，行为都不变。§6.90 写的"摘掉 `&& !diag` 那道闸 ⇒ 第⑤格红"指的是**源码文本判据**（正则匹配那半句），不是运行时行为 —— 两件事，别混读。结论：这条行为只有在**两处同时坏**时才会回归，所以它比单闸判据更稳，但也意味着**单点变异证不了它**；本段把两发失败的单点变异和那发成功的两点变异都记下来，下一批不必再撞一次。

**全量并进**：`node scripts/check-ui-runtime.mjs` 全量、退码裸取 ⇒ **EXIT=0、496/496 绿**（492 + `diag` 4 格）。

⚠️ **边界**：Chromium 合成视口，不是真机；刷新按钮用的是 DOM `.click()`（这一格量三态切换，不量命中区——命中区由 `overlay`/`links` 两段负责）。

## 11. 专项 §九「最终五问」的直答（10-20 落笔，随批次更新）



> 本节所有计数都在写这段的同一刻现算；定义与命令写在括号里，手抄数字不算数。
> 现算命令：`python3` 逐行取矩阵两张表的**第 4 列（判定）**首字母 ⇒ 共 39 行：A（已统一）3、B（已交给库并落地）24、C（当前保留/保留业务核心）7、D（当前不引入）5（10-20 重跑）。⚠️ 这条口径**漏掉 1 行**：判定写成「组合替换」的那行首字母不是 A–D，所以卡片总数是 40 而不是 39 —— 原先手抄的 37/22 就是被 §6.91/§6.92 追加的两行 B 顶掉的。

### 问 1 · 哪些通用能力已经交给成熟库，真正删除了哪些旧实现？

交给库的（矩阵第 1 节里判定以 B 开头的那些行（现算 21 行），逐行都写了"实际迁移点"）：右键与上下文菜单、锚定浮层（HoverCard/Popover/DropdownMenu）、模态弹窗壳、设置开关、分段控件、字号滑杆、原生 `<select>`、Toast、日志长列表虚拟化、图片保存链、日志诊断包的落点选择、i18n 引擎、纯读面板的查询缓存（4 个面板）。
依赖面：新增 3 枚（`reka-ui` / `@tanstack/vue-virtual` / `@tanstack/vue-query`，`package.json` 现查），复用已装（`@vueuse/core` / `dayjs` / `mitt` / `highlight.js` / `@tauri-apps/plugin-dialog`），**删除 1 枚**（`@headlessui/vue`，现查 `grep -c headlessui package.json` = 0，唯一消费者全部迁完）。
真删掉的旧实现（不是"包一层新的"）：`ContextMenu.vue` 自研的 Teleport+document click+keydown+焦点循环（135 行）、`useHoverCard` 与自研摆位、两个面板各自的手写 `StaleGuard`、`useAppStore` 手写 toast 数组与逐条 `setTimeout`、5 份手写 `localStorage` try/catch 兜底、41 条引不到的死文案、好友菜单迁移后残留的手算视口收边、诊断面板的三枚手写加载 ref。

**"真删了"这一句在收尾时对着当前树复算过**（每条都是现读，不是引用当初那批的话）：

| 复算项 | 读数 | 复跑 |
|---|---|---|
| 自研浮层摆位 | `src/utils/hoverCard.ts`、`src/composables/useHoverCard.ts`、`src/utils/contextMenu.ts` **三册都不存在了** | `[ -f src/utils/hoverCard.ts ] \|\| echo absent` |
| 右键菜单壳 | `ContextMenu.vue` 文件**仍在**，但只剩 92 行的 Reka 壳：`keydown`/`Teleport` 现算 **0 处** ⇒ 准确说法是"自研机制删光，薄壳留着复用调用面" | `wc -l < src/components/ContextMenu.vue`; `grep -c "keydown\|Teleport" src/components/ContextMenu.vue` |
| 老 toast 数组 | `useAppStore.ts` 里 `toasts` 现算 **0 处**（渲染/计时/去重/限流的家是 `utils/toastManager.ts` + `ToastHud.vue`） | `grep -c toasts src/stores/useAppStore.ts` |
| `localStorage` 裸直连 | 除 `utils/safeStorage.ts` 自身与测试外，生产码现算 **0 处** | `grep -rno "localStorage\.\(getItem\|setItem\|removeItem\)" src --include="*.ts" --include="*.vue" \| grep -v safeStorage \| grep -v ".test.ts" \| wc -l` |
| 内联 `<svg>` 元素的家 | 现算 **2** 个：`components/TitleBar.vue`（OS 窗口控件，保留自研）与 `components/ui/NavIcon.vue`（就是那唯一的家）；`GroupTasksBoard.vue` 里那处是注释，按元素解析不算家 | `python3` 用 `/<svg[\s>][\s\S]*?<\/svg>/` 扫 `src/**/*.vue`；`grep -rn "<svg" src --include="*.vue"` |
| `StaleGuard` 这个家 | **没删**，仍被消息行与会话 store 这类真需要它的地方用着（`ShareDirectory.vue` 里那处是注释，说的是"面板不再需要手写它"）⇒ 交付里凡是写"删了 StaleGuard"的都是**假话**，删的是两个面板各自抄的那份守卫 | `grep -rl StaleGuard src` |

### 问 2 · 哪些重复的函数/方法/组件/状态已经合并或删除？

按"几家变一家"记：`sleep`/`defer` 收一个家；手写限流闸门收一个家；**窄屏宽度档 3 份手抄 → 1 个家**（`utils/platform.ts` 的 `MOBILE_MAX_WIDTH_PX`，并与 Tailwind `md` 同一条对账）；15 MiB 预览上限前端 3 份 → 1；时间分割线阈值与判定 → 1；昵称行判定 → 1；移动端底栏占位高度 3 家 → 1 枚 CSS 令牌；`localStorage` 直连 20 处 → `utils/safeStorage`；挂载即终身的手写 DOM 监听 7 处 → `@vueuse/core` 的 `useEventListener`；只读面板的加载策略 4 个面板 → `utils/panelQuery`。
状态源减少的具体一格：群文件/共享目录原来是 `files`+`loading`+`failed`+`loadError` 四枚 ref（每个面板各一套），现在是一份 Query 缓存 + 两个派生 computed。外部链接同理（§6.98）：`links`+`loading`+`loadError`+`saving` 四枚 ref → 一份 Query 缓存 + 一枚 `useMutation` 的 `isPending`，且三条写命令从"各回填一次 ref"收成"共用一枚 mutation"。

### 问 3 · 哪些仍然是自研的，为什么不能直接替换？

C/D 那 12 行都有依据，最常被问到的几格：`VirtualList.vue`（P7 实测 20k 条 `calib()` 1.3 ms/遍、滚动 p95 17.5/16.8 ms、`longFramesOver50ms=0`，且"0.5px 白缝 / prepend 不跳 / 未读跳转二次落定"三件事已被真机与守恒判据钉住，而产品缓存上界只有 1000 条/会话）；消息与会话的异步状态机（可靠投递、离线队列、事务与事件流不是查询缓存的语义，交出去会把"谁拥有事实"变成两份）；`useMediaQuery` 不接（库只发 `change`→布尔，本应用还要 resize/首帧后重判，且 `init()` 可重跑、句柄归 `appInitScope` 管）；`FavoritePanel`（数据家是 Pinia store，接库即造第二个状态源）；收藏页那格整屏壳（一个元素同时 serve 两支布局，`MobilePageFrame` 的两个 mode 各只盖住一支）；DOMPurify 不接（4 处 `v-html` 的输入由构造保证已转义，另有允许清单判据 + 真实组件正控）；Reka Tooltip 不接（274 处原生 `title` 是平台级反馈，替换会改变现有行为而收益未证）。

### 问 4 · 前端是否更容易理解、定位问题、维护？举具体例子。

四条都能反向验：① 首屏脚本「一个键抛、五件事全跳」这条用户可见缺陷，现在是一条**先红后绿**的用例（`appearance.test.ts` 逐例真跑内联脚本），改坏即红；② 改窄屏断点只需要改 `platform.ts` 一处，因为同一条判据会去 `tailwindcss/defaultTheme.js` 现解析 `md` 并要求 `md === 窄档 + 1`；③ 菜单贴边的口径只剩 Reka 一个 owner，任何人再手写一份 `Math.max(8, Math.min(x, window.innerWidth …))` 直接红（`contextMenuReka.test.ts`）；④ 读诊断面板代码的人不再需要判断"刷新失败该不该说读失败"——那行 `error && !diag.value` 就是唯一答案，且有单点变异证明它摘掉会红。

### 问 5 · 哪些问题还没解决，哪些平台尚未验证？

未解决（都登记了边界与验收面，不是散话）：`LogViewer` 判**暂缓替换**（理由见 §6.90 那张表）；`LinksList` 已在 §6.98/§6.99 连读带写一起迁走（Chromium 里增/改/删 + 写失败 toast **10/10**，三发单点变异各红一次；真机那一格未跑）；诊断面板三态已由 §6.100 的 `diag` 段在 Chromium 里量过（**4/4**；两发单点变异是等价变异，两点变异才咬住）；行内 `text-[NNpx]` → 字号令牌那批要你拍观感。
全量 UI 探针**已在最终树上跑完整一轮**：`node scripts/check-ui-runtime.mjs` ⇒ **EXIT=0、496/496 绿**（488 + LinksList 4 格 + 诊断面板 4 格；`menufit` 9 格、`overlay` 42 格、`links` 10 格都在同一轮里全绿）。中途那次 **273/274** 是探针自身在 `overlay` 段被遮挡后的 45 s 无回包（单跑 42/42 绿），修法只补 `Page.bringToFront`+焦点仿真、未改任何断言（§6.99）。
菜单贴边那一格的运行时凭据**已补**（§6.97：390×844 窄视口 + §6.88 那条"挂父级、靠状态渲染"的配方 + 一发打在 `ContextMenu.vue` **生产码**上的单点变异 ⇒ 基线 21/21 绿、变异 3/9 红、按 sha 逐字节还原后复跑 21/21）；仍欠的只剩真机那一格（iOS WKWebView / Android WebView / 真实 Tauri 窗口）。
未验证平台：Android/iOS（`textZoom`、`content://`、首帧骨架形状；§6.91 那枚 `env(safe-area-inset-top)` 在浏览器里恒 0，弹窗顶部让位只能真机看）、Windows/Linux 门禁层与安装包、真机 WKWebView/WebView 里 `matchMedia` 与 `navigator` 是否会抛、夏令时下的"昨天"。
本轮仍未做（未经授权）：commit / push / tag / 发版 / 版本号。`Version-Bump:` 欠账随 §6.90 继续累计（§6.66、6.68、6.69、6.72、6.73、6.80、6.81、6.82、6.83、6.85、6.87、6.90、6.98）。

## 6.101 P0：群聊与单聊的会话归属（2026-10-20）

### 数据流与取证结论

沿真实生产链逐层读完：发送侧 `commands/window.rs::send_group_payload`（群）与 `commands/chat.rs::send_message`（单聊）→ 信封 `GossipKind` + `group_id`（签名覆盖）→ 接收 `transport/gossip.rs::handle_gossip`（群）与 `handle_messaging.rs`（直连单聊）→ 落库 `db/messages.rs`（唯一 `messages` 写入口）→ 会话行 `db/conversations.rs` → 前端 `useChatStore::applyIncoming`（按 `m.conv_id` 分桶）与 `utils/messages.rs::applyIncomingToConversations`（按 `convId` 找会话）。群文件（`gfile-`）、群历史（`apply_group_history_page`）、群离线队列、群已读、群公告均使用 `group:{group_id}`；前端没有 `sender_id` 当会话键的路径。

**未发现**“群消息被写成单聊记录”的现存生产分支（A、B 两类均未成立）。唯一不符合归属规则的是：`handle_gossip` 在 `GossipKind::Group` 且 `group_id` 缺失/空白时，旧写法 `format!("group:{}", unwrap_or_default())` 会静默生成 `group:` 空群会话。它不是单聊，但违反“缺目标必须拒绝/隔离并留痕，不得猜”。

### 修复（单一实现点）

- 在 `transport/gossip.rs` 新增 `InboundConversation` + `inbound_conversation(kind, group_id, sender_id)`：`Chat` ⇒ `(sender_id, "single")`；`Group` ⇒ 仅当 `group_id` 去空白后非空才给出 `("group:{gid}", "group")`，否则 `None`；其它 kind 无会话归属。
- `handle_gossip` 改为调用这一处；`None` 时丢弃群信封并 `logger.warn`（含 `msg_id`/`sender`），不再生成空群会话，也绝不回退到 `sender_id`。

### 回归与变异

- `gossip_tests.rs`：3 条纯函数真值表（群不取发送者、缺/空目标拒绝、单群键不相交）+ 1 条真实 schema/真实 DB 函数集成用例（群文本/图片/群文件卡片、两群一单聊、重复投递、群改名、群历史页、离线 `group_outbox` 帧保真）。
- 前端 `utils/messages.test.ts`：群文本/图片/文件只更新群会话；两群一单聊同批到达时未读与预览各归各键。
- 单点变异：把 `Group` 缺目标时的 `None` 改成回退到 `sender_id` + `"single"`，`inbound_conversation_rejects_missing_or_blank_group_target` 由绿转红（`EXIT=101`）；按原文还原后 3/3 + 集成 1/1 复绿。命令与日志：`cargo test --features bluetooth --lib inbound_conversation`、`... real_db_keeps_group_and_dm_conversations_isolated`（`/tmp/p0-*.log`）。

### 历史数据只读审计

本机 4 个库（`~/Library/Application Support/com.gosslan.app/gosslan{,-1,-2,-3}.db`）以 `mode=ro` 查了 5 类可疑形状：群消息落在非 `group:` 会话、群会话行缺前缀、`gfile-` 卡片与台账群不符、群形状 `receiver_id` 落在单聊、撤回墓碑跨会话 —— **全部 0 行**（最大库 107 条消息 / 3 会话 / 1 群）。未做任何写入、删除或迁移；本机库规模很小且不代表外部现场库，外部现场仍需同一组 SQL 复跑。

### 仍未证明

三节点真实局域网、不同上线顺序与重连下的群消息归属（含 `group_outbox` 重放）没有在本轮真机跑过 ⇒ **发版阻塞项**，不能用单元/DB 测试代替。

## 6.102 列表与 UI 存量现算（2026-10-20）

- 列表：含 `v-for` 的 `.vue` **40 个 / 73 处**；`VirtualList` 2 处（`ChatWindow`、`VirtualList` 自身）、`StateBlock` 7 个、TanStack Query 5 个、可滚动容器 24 个。会话/消息/任务三类业务列表保留各自组件；已接 Query 的列表为 LinksList、GroupFilesPanel、ChatSearchDialog、ShareDirectory、DevDiagPanel。
- 字号：迁移前现算 **269 处 / 57 文件**（11px 117、13px 83、12px 40、15px 22、10px 4、14px 3），与上一轮登记的 265 有漂移。已把其中**生产码 266 处 / 56 文件**收成六档语义令牌：`micro`(10)、`caption`(11)、`meta`(12)、`body`(13)、`emphasis`(14)、`title`(15)，像素逐档不变且显式 `line-height: inherit`；生产码现算 **0 处 `text-[NNpx]`**。构建产物现读 `.text-caption{font-size:11px;line-height:inherit}`、`.text-body{font-size:13px;line-height:inherit}`，旧任意类在 dist 中 0 条。判据 `designGuards.test.ts::㊿ 字号只走令牌` 带正/反控与 config 六档像素对账。剩余 3 处在 `*.test.ts` 夹具，按设计保留。
- 图标：`lucide-vue-next` 49 文件；内联 `<svg>` 只有 2 个家（`TitleBar.vue`、`ui/NavIcon.vue`）+ 1 处注释。
- Tooltip：Reka `Tooltip` 0 处，原生 `title="` 276 处；按用户口径不做 276 处工作量的机械迁移。
- 写失败反馈：LinksList 已由 §6.99 证到真实 ToastHud DOM；诊断面板三态由 §6.100 证到。
