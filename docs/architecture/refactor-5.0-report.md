# Gosslan 5.0 重构报告（截至 2026-10-18）

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
| `reka-ui` | S | 8 类原语、19 个 `.vue` | **已落地** |
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

- 可替换候选（A+B）**22 项唯一能力全部落地** ⇒ 可替换面替换率 **22/22 = 100%**。
- 全量矩阵（唯一 35 项）：已迁移 22、按证据保留 13 ⇒ 全量迁移率 **22/35 ≈ 62.9%**；
  保留项中 8 项为业务/平台语义（C）、5 项无调用面或技术不适用（D）。
- 常规图标统一率：**100%**（按“高频语义图标必须走入口”口径，真实树直连 0 处）。
- 公共交互原语：有真实调用面的 8 类（Dialog、Menu/ContextMenu、Switch、RadioGroup、Slider、Select、
  Focus、Toast）**8/8 由库承担**；Virtual / Query / Zod / dayjs 四个通用层也由成熟库承担。

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
3. 锚定 Popover 三处保持 C；若表情面板改版使内容不再零高度，再整批迁 Reka 并删除 `useHoverCard`。
4. 已评估但当前不引入（都有具体理由，见矩阵）：PrimeVue/Naive UI（第二套主题体系）、
   shadcn-vue（源码副本）、vee-validate（单字段表单 + zod 已覆盖）、motion-v（现有 CSS 过渡已足够）、
   vue-draggable-plus（无拖拽排序业务）、fuse.js/minisearch（SQLite 搜索为主，客户端过滤是简单 includes）、
   markdown-it/DOMPurify（无 Markdown/HTML 渲染路径）、file-type（文件类型只影响展示，不是信任依据）。
5. 测试体系保持 `node:test` + 自研 CDP 探针：它已在真实 Chrome 里覆盖 338 条渲染/交互判据，
   并承担 Tauri 夹具；引入 vitest/Playwright 会是第二套并行执行器，除非要补组件级交互测试再评估。
6. 保持边界：**不 tag、不发 release、不并 main、不 push**，直到用户判断“所有要求完成”。
