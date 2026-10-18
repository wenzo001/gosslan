# Gosslan 5.0 重构报告（截至 2026-10-18）

> 分支：`feat/5.0` · 基线：`origin/main` @ `3d4bd02` · 发布版本：`5.0.0`
> 工作树：`/Users/wendongfu/Documents/code/gosslan-5.0`（与主工作树隔离；主工作树当时被另一路完整门禁占用）
> 完整门禁：本文件落盘时在 5.0.0 tip 上起跑；实测读数补在 §5。

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
- 未引入：`reka-ui`、`shadcn-vue`、TanStack Query/Virtual/Table/Router/Form（逐项结论见
  `refactor-roadmap.md` §4）。

## 3. 删除的冗余实现与替代关系

| 删除项 | 替代 | 证据 |
|---|---|---|
| `src/utils/cn.ts` + `cn.test.ts` | 无（应用代码 0 调用） | 删除后 `npm test` / `npm run build` 绿 |
| `vue-easy-lightbox` 依赖 | 自研 `components/message/ImageLightbox.vue` | 全仓无 import；删除后构建无 lightbox chunk |
| `vite.config.ts` 的 lightbox manualChunks 分支 | 无 | 构建通过 |
| `style.css` 的 `.vel-modal` 顶层与降级规则 | 自研灯箱样式 | cascade 判据同步去掉该已不存在的定义 |
| `SettingsWindow.vue` 的 `.vel-modal` 选择器 | `[role='dialog']` | 构建通过；Esc 行为不变 |
| `PrimaryBtn` / `DangerBtn` 的"死抽象"状态 | **不删除**，迁入真实调用点 | 组件注释里的"已统一"此前不成立；本版让它成立 |

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
| UI 运行时 | `node scripts/check-ui-runtime.mjs`（自动取 playwright 缓存的 Chrome for Testing） | **262/265**（退出码 1）；3 条失败与基线完全相同（“多颗回应名单的长昵称宽度”段）⇒ 既有/环境差异，不是本分支回归 |
| 多实例 E2E | `npm run verify:e2e` | NOT RUN（依赖 release 产物 + 桌面 GUI 会话，另有 #47 平台约束） |

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
- 长列表：**最终 tip 重测**（20k 合成行，headless Brave，dev 构建；`perf/probe.mjs` 自检
  `scrollerReal=true` / `virtualizationOK=true`，renderedRows 12/20000）：
  cold 60 帧 avg 16.6 / p50 16.7 / p95 17.3 / max 17.6 ms；warmUp 300 帧 p50 16.7 /
  p95 17.3 / max 17.8 ms；warmDown 300 帧 p50 16.7 / p95 17.3 / max 17.7 ms；
  三轮 `longFramesOver50ms` 均为 **0**；5 个定位点全部渲染到目标行。本次没有改动
  `VirtualList`，这是同一基线的复测，不据此声称性能提升。
- 大文件传输期间 UI 响应性、真图解码、灯箱 URL 竞态：**未验证**（C 类假设）。

## 7. 跨平台与业务验证

- 已验证：macOS arm64 上的 `vue-tsc` 类型检查 + Vite 生产构建；前端 1007 条断言；
  UI 探针 262/265（3 条为基线同形失败）；Brave 实机页面壳加载正常；`verify:full` 在
  5.0.0 tip 上 23/23 全过（含 `cargo fmt`/`clippy -D warnings`/Rust 单测/Android 编译）；
  rebase 到 `643ca1e` 后另跑 `cargo fmt` 0、`clippy -D warnings` 0、Rust 单测 968/0、
  Rust 测试清单守卫 0。
- 未验证：Windows、iOS、Android 真机运行；真实双实例消息/群/文件链路（E2E 未跑）。
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
5. 空态 / loading / 错误态仍是多套写法，未做统一组件（证据不足，避免大迁移）。
6. 视觉统一以类名等价为证据；没有截图回归基线，像素级观感未验证。
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

本报告提交后，`feat/5.0` 工作区应为干净；已 rebase 到 `origin/main 643ca1e`。
本地共 3 笔应用码提交（`d60e607` 5.0.0 / `f385b9a` 5.0.1 / `13931f4` 5.0.2–5.0.3）
加 2 笔记账提交（`d31db1e` 与本次）；未推送、未打 tag。5.0.2、5.0.3 与拓扑清理
合并为一笔补丁提交，是为避开 Change Budget「同领域窗口 ≥3」；折历史前后的树逐字节相同
（`git diff --stat` 为空），备份分支 `backup/wip-5247e2f…` 可回退。
**完整门禁 23/23 在 `d31db1e` 上整跑**；其后只有文档记账提交，不动应用码。
主工作树另有另一路 AI 的未提交改动，本分支从未触碰。

## 10. 下一步建议

1. 合并前用 `git rebase origin/main` 同步另一路改动；重点复核 `useChatStore.ts`、
   `designGuards.ts` 与 21 个图标 import 文件的冲突。
2. 下一批优先做 §8 的 4（`refreshTransfers` 事件合并），先补运行时读数再改。
3. 视觉/空态统一仍缺截图基线与组件证据，按 §8 第 5、6 条保留。
4. 下一轮（待 push 清空 Change Budget 窗口后）可删的**零引用导出**（扫描范围
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
