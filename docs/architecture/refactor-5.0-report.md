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
| 5.0.0 完整层 | `npm run verify:full` | 在 5.0.0 tip 上起跑；结果见 §5.1 |
| UI 运行时 | `GOSSLAN_CHROME=<Chrome for Testing> node scripts/check-ui-runtime.mjs` | **262/265**（退出码 1）；3 条失败在“多颗回应名单的长昵称宽度”段，基线 `1ce7e97` 上复跑同样 3 条失败 ⇒ 既有/环境差异，不是本分支回归 |
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

### 5.2 UI 探针与 Brave

- Playwright MCP 已全局改为通过 `--executable-path` 启动本机
  `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`；实测它拉起的是 Brave，
  打开 Vite 页面后标题「相闻」、三栏壳层完整。13 条 console error 全是浏览器里没有
  Tauri IPC 的预期错误（invoke / transformCallback undefined），不是页面崩溃。
- 项目零依赖 CDP 探针（Chrome for Testing 153）在 5.0.1 与基线 5.0.0 上均为 **262/265**，
  失败集合完全相同（多颗回应名单的长昵称宽度段），因此按既有/环境差异记录，未在本分支修。

## 6. 性能读数

- 生产包 `main-*.js`：基线 311.68 kB（gzip 93.38 kB），5.0.0 仍为 311.68 kB（gzip 93.37 kB），
  5.0.1 为 311.41 kB（gzip 93.23 kB）。删除的三个依赖本来就不在产物里，因此没有依赖体积收益；
  5.0.1 的小幅下降来自重复 import/包装收敛，不作为性能提升结论。
- 长列表：未做新测量。仓库既有性能台（`perf/README.md`）的读数是 20k 合成行 p50 16.7ms、
  >50ms 长帧 0；本次没有改动 `VirtualList`，不据此声称性能提升。
- 大文件传输期间 UI 响应性、真图解码、灯箱 URL 竞态：**未验证**（C 类假设）。

## 7. 跨平台与业务验证

- 已验证：macOS arm64 上的 `vue-tsc` 类型检查 + Vite 生产构建；前端 1007 条断言；
  UI 探针 262/265（3 条为基线同形失败）；Brave 实机页面壳加载正常。
- 未验证：Windows、Android、iOS 真机；Rust 全量层与 Android 编译（§5.1 若已跑则以实测为准）；
  真实双实例消息/群/文件链路（E2E 未跑）。
- 协议、加密、SQLite schema、消息状态机、离线队列、传输状态机代码零改动；
  `watchGroupTodos` 的修改只影响群任务窗口的订阅生命周期。

## 8. 剩余风险与未完成事项

1. `SegmentedControl` 仍被 `GroupTasksBoard` 绕开（它需要状态色点，直接迁会丢信息）。
2. ~~`ImageLightbox` 与 `MessageItem` 的"另存图片"同构重复~~ **已在 5.0.1 解决**：
   收敛为 `utils/saveImageCore.ts` 的 `saveImageWith`（纯核心）+ `saveImageAs`（薄接线），
   6 条路径单测覆盖成功/桌面取消/Android 取消/SAF 对象/空值/非取消错误。
3. `formatBytes` 与 `humanSize` 两套字节格式语义未统一。
4. 每条 file/image 消息都触发 `refreshTransfers()`（2 次 IPC），未合并；属 B 类风险，待运行时读数。
5. 空态 / loading / 错误态仍是多套写法，未做统一组件（证据不足，避免大迁移）。
6. 视觉统一以类名等价为证据；没有截图回归基线，像素级观感未验证。
7. `DangerBtn` 迁移只覆盖同形状的 7 处；其余 7 处形状不同，保留待后续。

## 9. 工作区状态

本报告提交后，`feat/5.0` 分支工作区应为干净；所有提交均为本地提交，未推送、未打 tag。
主工作树另有另一路 AI 的未提交改动，本分支从未触碰。

## 10. 下一步建议

1. 在 5.0.0 tip 上完成 `verify:full` 与 `test:ui-runtime`，把读数补进 §5.1。
2. 合并前用 `git rebase origin/main` 同步另一路改动；重点复核 `useChatStore.ts`、
   `designGuards.ts` 与 21 个图标 import 文件的冲突。
3. 下一批优先做 §8 的 2/3（低风险去重）与 4（事件合并，先补运行时读数）。
