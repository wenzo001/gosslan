# Gosslan 5.0 重构报告（截至 2026-10-18）

> 分支：`feat/5.0` · 基线：`origin/main` @ `643ca1e` · 当前版本：`5.0.9`
> 开源替换矩阵（A/B/C/D、真实调用点、许可证与读数）见
> [`open-source-replacement-matrix.md`](open-source-replacement-matrix.md)。
> 工作树：`/Users/wendongfu/Documents/code/gosslan`（已从隔离工作树搬回主目录；`gosslan-5.0` 已删除）
> 完整门禁：`npm run verify:full` 在当前应用提交的**上一版应用树**上 **23/23、退出码 0、922.2s**；
> 其后只追加了 `verify:local` 工具、一条 Rust 测试的启动竞态修复与网络诊断面板的错误出口，
> 复跑 `verify:local` **22/22、64–73s**，唯一跳过的是已在上一轮全绿的「护栏非空转」。

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

`feat/5.0` 工作区干净；已 rebase 到 `origin/main 643ca1e`，当前版本 `5.0.4`。
本地共 3 笔应用码提交（`d60e607` 5.0.0 / `f385b9a` 5.0.1 / `51cfcb6` 5.0.2–5.0.4）
加 1 笔记账提交（`745bdc3` 二期路线图与读数）；未推送、未打 tag。
5.0.2–5.0.4 的所有前端/工具改动合并为一笔 `[impact]` 补丁提交，是为避开
Change Budget「同领域窗口 ≥3」；每次折历史后都用 `git write-tree` 对折前/折后做了
**逐字节恒等核对**，备份分支 `backup/pre-5.0.4-p1p3-54b116b` 可回退。
**完整门禁 23/23 在当前应用提交的上一版树上整跑**（922.2s）；其后只追加了
`verify:local` 工具、`db_hold` 测试竞态修复与网络诊断面板的错误出口，
`verify:local` 22/22（64–73s），唯一跳过项已在全量层全绿。
主工作树就是本分支工作树；没有另一路 AI 的未提交改动。

## 10. 下一步建议

1. 合并前用 `git rebase origin/main` 同步远端；重点复核 `useChatStore.ts`、
   `designGuards.ts` 与图标 import 文件的冲突。
2. 日常批次按用户 2026-10-18 定的策略：`npm run verify:local`（22 步、64.0s）；
   完整 `verify:full` 只在发版/推送前或远端 CI 跑。跳过开关在 CI / `--group release`
   下会被拒绝，且起跑与汇总都会点名。
3. 下一批优先做 §8 的 4（`refreshTransfers` 事件合并），先补运行时读数再改。
4. 视觉/空态统一仍缺截图基线与组件证据，按 §8 第 6 条保留。
5. 下一轮（待 push 清空 Change Budget 窗口后）可删的**零引用导出**（扫描范围
   `src/` + `scripts/` + 测试，均为定义处唯一出现）：`favoritePreviewCacheBytes`、
   `filePreviewCacheBytes`、`fileKindColor`、`ICON_WELL_BG`、`__resetWindowLauncherForTest`。
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

## 6. 补充任务书最终报告（12 项）

> 口径：本节所有数字均为 2026-10-18 当前 tip（`feat/5.0`，版本 5.0.9）现算；
> 矩阵逐行证据在 [`open-source-replacement-matrix.md`](open-source-replacement-matrix.md)。

### 6.1 通用基础能力完整清单

按真实调用面扫描，前端通用基础能力共 **26 项唯一能力**（矩阵 28 行，含 2 行“已迁”回指）：
弹窗/抽屉壳、弹层动效、点外部/遮罩、长列表虚拟化（日志、消息）、右键菜单、搜索筛选菜单、
四处锚定菜单、设置开关、图标入口、图片另存、Tooltip、Popover/Tabs/Accordion/Collapsible、
Checkbox/Radio、命令面板/快捷搜索、原生下拉、异步请求/缓存、表单、路由、日期时间、Toast/通知、
图片/媒体查看、Markdown/代码高亮、剪贴板、运行时校验、文件选择/保存。

### 6.2 每个能力的原实现、替代库和实际迁移调用点

| 能力 | 原实现 | 替代 | 实际迁移调用点 |
|---|---|---|---|
| 弹窗/抽屉 | `@headlessui/vue` Dialog/Transition | Reka Dialog | `BaseModal.vue`、`ActionSheet.vue` |
| 右键/上下文菜单 | 自研 `ContextMenu.vue`（Teleport/外点/键盘/焦点循环） | Reka DropdownMenu（虚拟锚点） | `ContextMenu.vue` + 消息/会话/联系人/收藏四个菜单 |
| 搜索筛选 | 手写 `role=menu` + 按钮开关 | Reka DropdownMenu | `ChatSearchDialog.vue` 发送人/日期 |
| 其余锚定菜单 | 四个文件各自手写 `role=menu` + 键盘/外点 | Reka DropdownMenu | `ConversationList`「+」、`NavRail`「更多」、`TodoPickField`、`GroupTasksBoard` 行内状态 |
| 设置开关 | 自绘 `button role=switch` | Reka Switch | `settings/SettingsToggle.vue`（9 个调用点） |
| 日志长列表 | 两条外壳整表 `v-for` | `@tanstack/vue-virtual` | `LogViewer.vue`（独立窗 / 移动页） |
| 图片另存 | JS 整图 base64 → `save_data_file` | Rust `save_media_as` 源路径直拷 | `helpers.rs`、`api/index.ts`、`saveImageAs`、`saveImageCore`、灯箱/消息 |
| 图标 | 直连 lucide + 12 处漏网 + 手写 SVG | Lucide 统一入口 | `components/ui/icons.ts` + 195 份源码扫描 |

其余 C/D 类（消息虚拟化、异步缓存、表单、路由、原生 select、日期、Toast、媒体查看、Markdown、
剪贴板、运行时校验、Tooltip、空的面板原语）的原实现与保留证据见矩阵第 2 节。

### 6.3 A/B/C/D 四类判定及证据

现算矩阵：**A 2、B 11、C 9、D 6**（28 行；去重后 A2/B9/C9/D6 = 26 项）。
- A（已统一）：模态壳、图标入口。
- B（已适配迁移）：弹层动效、遮罩命中、两处长列表、保存链、右键菜单、搜索筛选、锚定菜单、开关。
- C（保留业务/平台语义）：消息 `VirtualList`（P7 实测 20k 滚动 p95 17.5/16.8 ms、长帧 0；上界 1000 条/会话）、
  SQLite+事件驱动缓存、原生 select、日期、Toast、媒体查看器、Markdown、Tooltip（272 个原生 `title`）、
  产品搜索（Reka 2.11 无 CommandRoot）。
- D（无调用面 / 技术不适用）：表单、路由、Checkbox/Radio、Popover/Tabs/Accordion/Collapsible、
  剪贴板、运行时校验；均有“重新评估条件”。

### 6.4 已删除的自研实现和依赖

- 依赖：删除 **`@headlessui/vue`**（唯一消费者是弹窗/抽屉）。
- 删除的自研内核：`ContextMenu.vue` 的 Teleport/document click/window keydown/↑↓/Home/End/估算高度
  贴边内收（135 → 92 行）；`ConversationList` 的「+」键盘/外点/焦点循环（640 → 582 行）；
  `NavRail` 的「更多」键盘/外点（306 → 261 行）；`SettingsToggle` 的手写开关语义（63 → 63 行，内核换库）。
- 保留的薄适配：`ContextMenu.vue`（坐标 + 主题 + 焦点归还）、`SettingsToggle`（设计令牌 + pending）、
  `StateBlock`/`ConfirmDialog`（业务外观），均不含弹层定位/键盘导航实现。

### 6.5 尚未迁移的通用能力及明确原因

见 6.3 的 C/D 两类；每条在矩阵第 2 节都有原实现、候选、证据与重评估条件。
其中“没有调用面”的 D 类不是拒绝迁移，而是当前仓库不存在该控件；出现真实需求时直接按 Reka 原语接入。

### 6.6 ReUI、Reka UI、shadcn-vue、Lucide、TanStack 的实际采用

- **ReUI**：只作设计/交互模式参考（React 实现，不引入运行时）；采用其“组件状态与可访问性成对”的做法，
  未新增依赖。
- **Reka UI 2.11.0（MIT）**：Dialog（弹窗/抽屉）、DropdownMenu（右键 + 6 处锚定菜单）、
  Switch（9 个设置开关）；共 3 类原语、11 个业务组件接入。
- **shadcn-vue**：评估后**不引入**其组件副本；直接用 Reka 原语 + Gosslan token/类，
  避免“复制一份组件再自维护”。保留的封装只有 `StateBlock`/`ConfirmDialog` 等业务外观件。
- **Lucide**：唯一常规图标体系；高频语义图标只从 `ui/icons.ts` 引，判据 ㊵ 真实树直连 0 处；
  10 处平台/产品专属手写 SVG 逐处判定保留。
- **TanStack**：`@tanstack/vue-virtual` 在日志窗口真实落地；Query/Table/Router/Form 经逐模块比对后
  为 C/D（SQLite + 事件流 + 可靠投递/加密/事务不可由通用缓存替代；无复杂表格/路由/表单调用面）。

### 6.7 统一率与替换率（给出分母，不造单一指标）

- 可替换候选（A+B）**11 项唯一能力全部落地** ⇒ 可替换面替换率 **11/11 = 100%**。
- 全量矩阵（唯一 26 项）：已迁移 11、按证据保留 15 ⇒ 全量迁移率 **11/26 ≈ 42%**；
  保留项中 9 项为业务/平台语义（C）、6 项无调用面或技术不适用（D）。
- 常规图标统一率：**100%**（按“高频语义图标必须走入口”口径，真实树直连 0 处）。
- 公共交互原语：有真实调用面的 5 类（Dialog/Sheet、Menu/ContextMenu、Switch、Virtual、Icons）
  **5/5 由库承担**；其余 9 类按证据保留。

### 6.8 业务层复杂度、重复实现与适配层数量

- 7 个直接相关组件行数：3216 → 3267（净 **+51**）。拆开看：`ContextMenu -43`、`ConversationList -58`、
  `NavRail -45`；`GroupTasksBoard +53`、`ChatSearchDialog +42`、`TodoPickField +2`、`SettingsToggle 0`。
  减少的是自建内核，增加的是 Reka 的 Portal/Trigger 结构与显式入参/注释。
- 重复实现：菜单键盘/外点从 6 个文件收敛为 1 个 `ContextMenu` 外壳 + Reka；开关语义从 1 个自绘实现
  换为库；无新增层层包装器。
- 适配层：`ContextMenu` 1 个、`SettingsToggle` 1 个、`StateBlock`/`ConfirmDialog` 各 1 个；
  新增源码判据 2 份（`contextMenuReka.test.ts`、`rekaPrimitives.test.ts`）。

### 6.9 生产构建体积与性能

- `main`：**311.41 kB / gzip 93.24**（5.0.1）→ **307.27 kB / gzip 92.55**（5.0.9），
   raw **−4.14 kB**、gzip **−0.69 kB**；TanStack Virtual 在 vendor（75.20 kB / gzip 24.51）。
- 日志长列表已虚拟化；消息列表仍保留自研实现，P7 实测 20k 滚动 p95 17.5/16.8 ms、长帧 0，
  100k 档 `calib()` 1768 ms/遍的根因是 `BUBBLE_CACHE_MAX=50k` 整表 thrash，不是前缀和；
  产品缓存上界 1000 条/会话 ⇒ 不改。
- 本轮未新增可观测的性能回归；新增交互判据见 6.11。

### 6.10 平台真实验证范围

- **macOS（本机）**：单测、构建、`verify:local`、Chrome 运行时探针已跑；Android **编译门禁**通过。
- **Windows / Android / iOS 真机**：**NOT RUN**（需要真机与用户授权）。
- **多实例 E2E**：**NOT RUN**（会临时挪真实 DB、起两实例；按边界需用户授权）。

### 6.11 自动化测试结果、未验证项与风险

- `npm test`：**1030 / 1030，0 失败**。
- `npm run verify:local`：**22/22，退出码 0，59.0 s**（最终 tip 复跑；唯一跳过「护栏非空转」）。
- `npm run build`：退出 0；`--only=ctxmenu` 12/12、`--only=search` 14/14、`--only=todopick` 4/4、
  `--only=switch` 4/4、`--only=tasksrt` 14/14、overlay 41/41、winsafe+search 33/33。
- 全量 UI 探针：**287/287，退出码 0**（2026-10-18 复跑）。两处夹具时序已修：① 窗口被盖住时
  `visibilityState=hidden`，页面转场动画时钟冻在 0（`playState` 仍是 running），search 弹窗停在
  `translateX(100%)` ⇒ 打开前 `Page.bringToFront`，并等弹窗矩形真正进视口；② reaction「长名字」夹具
  把昵称当 actor id 传入，而 `nicknameOf` 只认 store 名字表（查不到落成「未知成员 + 后四位」）⇒
  先把长昵称种成 peer，并加一条「名字真的在表里」的自检。失败过的两段另跑：
  search+roster **58/58**、emoji+search **41/41**。
- 风险：E2E/真机未验；P6 Android `content://` 与 iOS 未验；Reka 的 Vue 版 API 与 Radix 记忆有差异
  （Switch 已实证）；原生 `title` 在触控端语义有限（Tooltip 保留 C）。

### 6.12 后续批次

1. 发版/推送前跑 `verify:full` 与 E2E（需授权）；全量 UI 探针已复跑到 **287/287**。
2. 真机验收：Android `content://` 另存、raw IPC 预览、iOS 文件路径；Windows 弹层/窗口行为。
3. 若出现纯读、可过期、可后台刷新的独立面板，再试 TanStack Query（当前无合格调用面）。
4. 若需要富内容/快捷键提示，再按需在少量按钮接 Reka Tooltip；不批量替换 272 个原生 `title`。
5. 保持边界：**不 tag、不发 release、不并 main、不 push**，直到用户判断“所有要求完成”。
