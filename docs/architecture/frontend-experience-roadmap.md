# 前端体验治理二期（V5）路线图

2026-10-18 建立。上一期见 `refactor-roadmap.md` / `refactor-5.0-report.md`（设计系统、依赖、图标入口、拓扑清理、5.0.3）。
本期目标：**异步状态与防白屏 → 媒体/文件主线程 → 组件与图标收口 → 性能实测**，每批可审查、可回滚。

## 0. 基线（本机现算，2026-10-18）

| 项 | 读数 | 复跑 |
|---|---|---|
| `.vue` 文件 | **83** | `find src -name '*.vue' | wc -l` |
| 手写 `<svg>` | **10 处 / 3 个文件**（TitleBar 5、NavRail 4、BackArrow 1；GroupTasksBoard 1 处是注释） | `grep -rn '<svg' src --include='*.vue'` |
| 图标源 | 仅 `lucide-vue-next`；`components/ui/icons.ts` 是语义入口（现有 7 个名字） | `grep -rn lucide-vue-next src --include='*.vue'` |
| 空态实现 | **20 个文件、≥5 套内联样式**，无共享组件 | 见 §3 清单 |
| 只转圈无重试 | GroupFilesPanel / FavoritePanel / GroupTasksBoard / ChatWindow / LinksList / ChatSearchDialog | 盘点记录（子代理，已抽读核对） |
| 图片预览窗口 | IPC 失败/空相册时**静默白屏**（已修，见 P1） | `src/components/window/PreviewWindow.vue` |
| 前端单测 | 1009 → **1015**（P1 新增 6 条状态机用例） | `npm test` 自己打印 |
| 生产包 | 310.67 → **310.01 kB**（gzip 93.21 → 92.99） | `npm run build` |
| 长列表 | 20k 行 p50 16.7 / p95 17.3 ms，长帧 0（5.0 期读数） | `perf/README.md` |

## 1. 库选型结论（本期沿用 5.0 的证据，不重复迁移）

| 候选 | 结论 | 依据 |
|---|---|---|
| ReUI | 仅模式参考 | React/shadcn 生态，不能作为 Vue 依赖 |
| reka-ui | **已引入（5.0）** | Dialog/Menu/ContextMenu/Switch/RadioGroup/Slider/Select/Focus/Toast/HoverCard/Popover 共 10 类原语、23 个 `.vue`；`@headlessui/vue` 已删除。取代了自研浮层摆位与多套无样式控件；证据见 `open-source-replacement-matrix.md` 第 1 节 |
| shadcn-vue | 不引入 | 生成源码体系与现有 token/组件并行，迁移成本大于收益 |
| Lucide | 保留为唯一图标源 | 现有 `ui/icons.ts` 静态入口；P3 把剩余手写 SVG 收口 |
| TanStack Query | **已引入（5.0，仅纯读面板）** | 群文件/共享目录/搜索聊天记录三个真实面板；Pinia/SQLite 仍是消息状态机事实源。边界见 `open-source-replacement-matrix.md` 第 2 节 |
| TanStack Virtual | **已引入（日志页）** | `LogViewer` 两条外壳已迁 `useVirtualizer`；消息列表 `VirtualList` 按 P7 实测与业务锚定语义保留（C），见矩阵第 2 节 |
| TanStack Table/Router/Form | 不引入 | 无复杂表格；多窗口 HTML 入口 + 手写导航 |
| 第三方媒体查看器 | 暂不引入 | 现有 `ImageLightbox` 已覆盖缩放/拖动/多图/Esc；替换需重新验证手势与焦点，收益未证明 |

任何新增依赖必须先给出：许可证、lock 版本、传递依赖、包体积差、回滚点；没有运行时收益证据不引入。

## 2. 批次

| 批次 | 内容 | 风险 | 状态 |
|---|---|---|---|
| P0 | 迁移回主工作区、rebase、基线 1009/1009、build 0 | 无 | 完成（2026-10-18） |
| P1 | **预览窗口异步状态机**：loading/empty/error/retry/8s 超时；新增公共 `ui/StateBlock.vue`；6 条纯状态机单测 | 低 | 完成（`npm test` 1015/1015；build 0；包体 310.01 kB） |
| P2 | 其余辅助窗口状态：群任务窗口首屏失败改为错误态+重试；日志窗口区分“无日志/读失败”并在空屏时给重试；网络设置网卡枚举失败不再截断后续加载 | 中 | 完成（`npm test` 1015/1015；build 0；包体 310.08 kB） |
| P3 | 图标收口：**修正 ㊵ 判据假绿**（旧正则跨 import 吞行 ⇒ 12 处直连漏报），12 处改走入口；10 处手写 SVG 逐处判定保留 | 低 | 完成（`npm test` 1015/1015；build 0；㊵ 真实树 195 份源码 0 处） |
| P4 | 菜单/确认框收口：5 处手搓菜单改走 `ContextMenu`；10 处 BaseModal 确认体抽 `ConfirmDialog`（含重复点击保护） | 中 | 完成（`ConfirmDialog` 覆盖 10 处：Storage 2 / Reset 2 / ConversationList 2 / ChatWindow 3 / MessageItem 1；群公告删除是查看弹窗内的两段式确认，不套独立确认框；菜单 5 处已共用 `.gosslan-menu*` 样式且带键盘导航，逐处核对后保留） |
| P5 | 空态/加载收口：20 处空态迁 `StateBlock` 或页面级变体；只转圈的 6 处补失败/重试 | 中 | 完成（群文件、收藏、链接、聊天主窗、聊天搜索、图片灯箱、群任务看板/成员面板、网络诊断已完成；其余为同步数据的合法空态，保留行内写法） |
| P6 | 主线程：粘贴图 `FileReader→dataURL→base64` 路径评估二进制 IPC；缩略图/解码移出主线程；先量再改 | 高 | **评估完成，改动 BLOCKED**：`@tauri-apps/api` 的 `InvokeArgs` 虽支持 `ArrayBuffer`，但锁定版 `tauri 2.11.5` 明确写着 **Android 上 `InvokeBody::Raw` 不支持**（`src/ipc/mod.rs:55`）；正解 `plugin-fs.writeFile` 需新增前端依赖 + fs scope 权限 + 新 Rust 接入命令，且必须真机验证 ⇒ 本机无法验收，保留现状（8 MiB 前置闸 + data URL）。详见 §5。 |
| P7 | 高频事件：`file-progress` 前端批处理/局部更新；消息/成员全表扫描的增量计算；用 perf 台对比 | 中 | 完成（2026-10-18 **测量后不改码**）：20k 满帧、`longFramesOver50ms=0`；100k 单遍 1768ms 的根因是 50k 气泡缓存 thrash，并非前缀和算法，而产品上界 1000 条/会话；`file-progress` 源侧已 250/1000ms 节流 + 单条原地写。读数见 `perf/README.md`。 |
| P8 | 全量回归：`verify:full` 23 步、UI 探针、perf 台、跨端未验证清单 | 无 | 完成（2026-10-18 完整 `verify:full` **23/23、退出码 0、922.2s**；UI 探针 262/265 与基线同集合；perf 台读数见 `perf/README.md`；跨端未验证清单见最终报告）。此后新增 `verify:local`（22 步、64.0s）供本地日常，完整链留给发版/CI。 |

## 3. 迁移清单（盘点快照）

- **菜单手搓点**：`ConversationList:426`、`NavRail:280`、`GroupTasksBoard:1496`、`TodoPickField:92`、`ChatSearchDialog:301`（公共壳 `ContextMenu:125`）。
- **Modal/确认体**：`ChatWindow:1609/1646/1678/1736`、`settings/ResetSection:90/116`、`settings/StorageSection:234/256`、`ConversationList:591/618`、`MessageItem:1488`。
- **空态**：`ResponsiveLayout:699`、`ConversationList:467/558`、`ChatWindow:1452`、`FavoritePanel:558`、`GroupTasksBoard:1002`、`LogViewer:351/503`、`GroupFilesPanel:182`、`ShareDirectory:109`、`LinksList:157`、`ChatSearchDialog:355`、`FriendRequestList:68`、`GroupMemberPanel:264/316/353/396`、`AddFriendModal:271`、`GroupCreateModal:95`、`NetworkSection:355/485`、`DevDiagPanel:291/309/332`、`ForwardModal:151`、`TodoCardBubble:280`。
- **手写 SVG（P3 已逐处判定）**：`TitleBar:266/283/304/347/357` 是 macOS 红绿灯与 Windows 11 窗口按钮字形（注释写明 lucide 造型不像系统、且依赖 10×10 视觉盒），保留；`NavRail:147/174/208/237` 依赖“选中 = 填充实心、内部镂空”的语义，lucide 线性图标填充后会成墨团，保留；`BackArrow:24` 是 iOS 专用 chevron（其余平台已用 lucide ArrowLeft），保留。10 处均属“产品/平台专属图形”，不是漏迁移。
- **平台能力**：`utils/platform.ts` 已集中（isMac/isAndroid/isIOS/canHover）；`app.isMobile` 仍是 20 文件 92 处，P2/P4 时按需收口，不一次性改。

## 5. 本轮收口读数（2026-10-18，尖 `9a6a773` + 文档 `459f2c0`）

| 命令 | 结果 |
|---|---|
| `npm test` | **1015 通过 / 0 失败**（退出码 0） |
| `npm run build` | 退出 0；`main` 311.11 kB / gzip 93.34 |
| `npm run verify` | **17/17 通过，退出码 0，18.4s** |
| `node scripts/check-ui-runtime.mjs` | 262/265（退出码 1）；3 条与基线同集合（多颗回应长昵称） |
| `cargo fmt --check --all` | 退出 0 |
| `cargo clippy --features bluetooth -- -D warnings` | 退出 0（**门禁原形**；另跑的 `--all-targets` 会点出 `examples/e2e_peer.rs` 既有 lint，那不是门禁命令，不计入） |
| `cargo test --features bluetooth` | **968 通过 / 0 失败** |
| `node scripts/check-change-budget.mjs` | 退出 0（presentation 2 次） |
| `npm run version:check` | 退出 0（5.0.4） |
| `npm run verify:full` | **NOT RUN at this tip**；上一个尖 `54b116b` 为 23/23、1169.4s。此后仅前端改动，已由快速层 + UI 探针覆盖；下一位接手者应在 push 前整跑一次 |

P5 群任务批（本批）：`npm test` **1017 通过 / 0 失败**；`npm run verify` **17/17、退出码 0、18.5s**；build `main` 311.96 kB / gzip 93.55。看板首屏三态由 `utils/todos.todoRowsLoadState` 单一判据给出，三个入口共用 store 的单飞 + `groupTodoRowsErrors`。

P7 量具复跑（同一台机器、dev 构建、headless Brave；`probe.mjs` 自检全 true）：20k `calib()` **1.3 ms/遍**，滚动 p95 **17.5 / 16.8 ms**，`longFramesOver50ms` **0**；100k `PERF_ONLY=calib` **1768.4 ms/遍**（17.68 µs/条）—— 20k→100k 条数 ×5、单遍 ×1360，原因是 `BUBBLE_CACHE_MAX = 50_000` 在 10 万条时整表 thrash，不是前缀和算法本身。产品消息缓存上界 `100 × 10 = 1000 条/会话`（8 个会话）⇒ 该档位不可达，**VirtualList 前缀和与 file-progress 前端批处理都不改**；完整读数与判据写进 `perf/README.md`。

本地门禁策略（用户 2026-10-18 定）：日常只跑 `npm run verify:local`（22 步、64–73s，跳过最长的「护栏非空转」）；完整 `npm run verify:full` 留到发版/推送前或交给 CI。跳过开关在 CI 与 `--group release` 下会直接拒绝，起跑与汇总都点名。

E2E 判据自证（不需要 release 产物、不碰用户数据）：`--logtail-selfcheck` / `--shot-selfcheck` / `--report-contract-selfcheck` / `--prune-selfcheck` **4/4 退出码 0**；主轮（会挪真实数据库并拉起两个实例）仍需现场授权，未跑。

遗留：P5 其余静态空态；P6 已写入阻塞结论（Android 不支持 raw IPC，plugin-fs 需真机验收）；跨平台真机与 E2E 仍为 NOT RUN。



- 每批：`npm test`（条数自打印）+ `npm run build`；涉及 Rust/窗口行为再加 `npm run verify:full`；UI 行为用 `node scripts/check-ui-runtime.mjs`（本机 262/265，3 条既有失败）。
- 退出码裸取，不经管道；未跑层写 NOT RUN。
- 新增测试文件必须同时加进 `package.json` 的 `test` 文件清单（本仓测试是显式枚举）。
- 数字不手抄；本文件 §0 的读数随批次更新。
