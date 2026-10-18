# Gosslan 5.0 重构路线与验收台账

> 分支：`feat/5.0` · 基线：`origin/main` @ `3d4bd02` · 工作树：`/Users/wendongfu/Documents/code/gosslan-5.0`
> 目标：在不改协议、加密语义、SQLite 结构与可靠投递机制的前提下，治理前端冗余、统一设计系统、按证据引入成熟库，并用仓库现有门禁持续验收。
> 约束：主工作树由另一路开发与完整门禁占用，本分支的一切修改只发生在独立 worktree；主分支前进时用 rebase 同步。

## 1. 基线（本分支起点）

| 项 | 读数 | 复跑命令 |
|---|---|---|
| 版本 | 4.44.3（三处源码 + 两个 lock） | `node scripts/version.mjs show` |
| 前端单测 | 1000 通过 / 0 失败 / 0 跳过，退出码 0 | `npm test` |
| 前端依赖 | Vue 3.5 / Vite 6 / Tailwind 3.4 / Pinia 2 / Headless UI 1.7 / Lucide 0.469 | `node -e "console.log(require('./package.json').dependencies)"` |
| 快速层门禁 | 以本分支本次实跑日志为准（见 §6） | `npm run verify` |
| 全量层 | NOT RUN（Rust/Android 层将在主工作树门禁结束后补跑） | `npm run verify:full` |

## 2. 关键前提纠正

- **仓库没有 Ant Design Vue。** `package.json` 无该依赖，`src` 无任何 `ant-design-vue` / `antd` 引用（`grep -RIn -i 'ant-design\\|antd' src package.json` 返回 0）。因此不存在“AntDV 迁移”问题，G1 的落点是**现有自研设计系统的收敛与护栏**。
- 现状是单一 UI 库组合：Tailwind + Headless UI（仅 `BaseModal.vue`、`ActionSheet.vue`）+ Lucide 图标 + 自研 token/组件。没有第二套主题系统或图标库。
- 设计令牌已在 `src/style.css` 定义（圆角/字号/语义色/动效/布局），规范在 `docs/design-guidelines.md`，并已有大量机器判据在 `src/utils/designGuards.ts`。

## 3. 审计结论（A–G）

### A. UI 组件与设计系统

| 候选项 | 证据 | 结论 |
|---|---|---|
| `ui/PrimaryBtn.vue`、`ui/DangerBtn.vue` | 新增后 0 个真实调用（仅注释提到） | **本批迁入真实调用点**，不删除；尺寸按真实用法校准 |
| `ui/BackArrow.vue` | 5 个调用点，平台自适应返回箭头 | 保留（唯一实现） |
| `ui/SegmentedControl.vue` | 2 个调用点；`GroupTasksBoard.vue` 仍手写分段控件且激活态不同 | 暂缓：需支持状态色点，直接迁会丢信息，登记为后续适配 |
| `BaseModal.vue` / `ActionSheet.vue` | BaseModal 29 个实例，Headless UI 负责焦点与 portal | 保留，不动 |
| `ContextMenu.vue` / `.gosslan-menu` | 菜单外观唯一源；锚定下拉只绕开摆位 | 保留 |
| `ToastHud.vue` | 唯一 Toast 实现，3 处挂载 | 保留 |
| 空态 / loading / 错误态 | 空态 20 个 i18n key、无统一组件；loading 有 Loader2 / RefreshCw / CSS 圆环三套 | **证据不足**统一视觉；先登记，不做大迁移 |
| 危险确认按钮 | 14 处手写；其中 8 处无 `tap-safe`（pad 尺寸逃过现有 `h-*` 判据） | 本批迁移同形状的 7 处，另 1 处补 `tap-safe`；其余形状不同，保留 |

### B. 图标、主题、CSS、动效

- 55 个非测试文件从 `lucide-vue-next` 导入，约 106 个图标名；`TitleBar.vue`、`NavRail.vue`、`BackArrow.vue` 的自绘 SVG 是平台外观，**不是**第二套图标体系。
- 同义图标：`RotateCcw`（重试）与 `RotateCw`（刷新/重试）并存；`Loader2` / `RefreshCw` / CSS 圆环三套 loading。
- Token 漂移（已核实）：字面圆角 2 处（`TodoDetailDialog.vue` 的 `rounded-md`、`MessageComposer.vue` 的 `rounded-[6px]`）；用户可见 10px 字号 1 处（`UnsupportedKindBubble.vue`）；`FavoritePanel.vue` 中性色硬编码 2 个。
- 合法例外：`ProfileSection.vue` 画布 JPEG 白底（必须是不随主题变化的纯白）；`TitleBar.vue` 的 macOS 原生色。
- 结论：本批修漂移并新增**字面圆角**判据；图标入口见 §4 的“语义图标入口”决定。

### C. 工具函数与第三方依赖

| 依赖 | 证据 | 结论 |
|---|---|---|
| `vue-easy-lightbox` | 全仓无 import；仅 `vite.config.ts` 死分支、`style.css` 死规则、`SettingsWindow.vue` 死选择器 | **已删除**（4.44.6；cascade 判据同步去掉 `.vel-modal`） |
| `clsx` + `tailwind-merge` | 仅 `utils/cn.ts` 使用；`cn()` 在应用代码 0 调用，只有自测 | **已删除**（4.44.6；实现 + 自测 + npm test 清单） |
| `@headlessui/vue` | BaseModal / ActionSheet 真实使用 | 保留 |
| `dayjs` / `highlight.js` / `pinia` / `vue-easy-lightbox` 之外的其余项 | 均有真实归属 | 保留 |

### D. 状态、请求封装、事件流

- `src/api/index.ts` 是唯一 invoke/listen 门面；组件层 0 处裸 `listen`；`initScope` 已有卸载机制。**结构健康，不动。**
- 真实缺陷：`useChatStore.ts:1532-1551` 的 `watchGroupTodos` 在 `await` 后才写 unlisten，无序号校验；快速切群时先返回者被覆盖，会漏一个监听。**登记为可靠性批次**（需补测试后再改）。
- 事件风暴风险：每条 file/image 消息都触发 `refreshTransfers()`（2 次 IPC），未合并。**B 类风险，待有运行时读数后再改**。
- 红线：`messages.ts` 的 `furthestStatus` / `applyReplacements` / `replaceOptimistic` / 离线队列与 `files.rs` 终态守卫不得动。

### E. 虚拟列表与渲染性能

- `VirtualList.vue` 自带 key 锚定 prepend、贴底状态机、跳转落定、0.5px 高度、live region；高度缓存有 2000 上界，滚动走 rAF + passive。
- 仓库性能台读数（`perf/README.md`）：20k 合成行 p50 16.7ms、>50ms 长帧 0；1000 条整表估算约 0.1ms。
- 结论：**不引入 TanStack Virtual**。现有实现承载聊天专属语义，库只解决通用测量；没有证据表明当前是瓶颈。再评估触发条件：真机真实会话（含图/群回执）p95 > 16.7ms 或长帧，或单会话实时消息远超 2 万。
- 未验证：真图解码、15MiB 单图重挂载、逐出与灯箱显示 URL 的竞态（C 类）。

### F. Tauri 前后端边界

- invoke/listen 收敛在 `src/api/index.ts`；`PreviewWindow` / `GroupTodosWindow` 均有 disposed 补卸载；`App.vue` 根监听只挂一次。无新增跨端契约改动。
- 本分支不改 Rust 协议、命令签名、事件名与窗口生命周期。

### G. 测试与验收缺口

- 已有：前端 1000 条单测、17 步快速层、全量 Rust/Android 层、多实例 E2E、UI 运行时检查。
- 缺口：字面圆角/hex/字号下限无机器判据；`SegmentedControl` 的绕开无判据；危险按钮的 `tap-effect` 判据只认 `h-*`，漏掉 padding 型小按钮（本批用组件收敛解决 7 处）。
- 本批新增：字面圆角判据（含正反夹具 + 全库分母打印）。

## 4. 选型结论（G1 / G2）

| 候选 | 结论 | 理由 |
|---|---|---|
| ReUI | **仅作模式参考** | React/shadcn 生态，不能作为 Vue 依赖引入 |
| `reka-ui` | **暂不引入** | 现有 Headless UI 已覆盖弹窗/动作面板；引入会形成第二套无样式原语，收益未证明 |
| `shadcn-vue` | **不引入** | 会生成一套与现有 token/组件并行的源码体系，迁移成本大于收益 |
| Lucide | **保留** | 已是唯一图标来源；本批建立语义图标入口（静态具名再导出，保 tree-shaking） |
| TanStack Query | **不引入** | 数据来自 Tauri 事件 + SQLite + Pinia，无 HTTP 请求缓存语义；引入会与消息状态机/离线队列形成重复状态 |
| TanStack Virtual | **不引入** | 见 §3E，现有实现有专属语义且性能台无瓶颈 |
| TanStack Table | **不引入** | 无复杂表格需求（任务看板不是表格） |
| TanStack Router / Form | **不引入** | 多窗口 HTML 入口 + 手写导航/表单，无证据表明现有实现有问题 |

## 5. 批次计划与状态

| 批次 | 内容 | 风险 | 状态 |
|---|---|---|---|
| B0 | 基线、审计、本路线文档 | 无 | 完成（基线单测 1000/1000；快速层批前长跑在第 9 步中止，`VERIFY_EXIT=143`，非绿） |
| B1 | Token 漂移修复 + 字面圆角判据 + 危险/主要按钮首批迁移 | 低 | 完成（`npm test` 1002/1002，`npm run build` 退出 0；7 危险 + 5 主按钮；新判据 ㊴） |
| B2 | 语义图标入口 + 5 个高频图标迁移 | 中（机械改动面大） | 完成（`ui/icons.ts` 静态再导出；21 文件/22 处 import；`npm test` 1000/1000；build 退出 0） |
| B3 | 未使用依赖与死代码清理（lightbox / clsx / tailwind-merge / cn） | 低 | 完成（生产依赖 13→10；`npm test` 998/998；`npm run build` 退出 0） |
| B4 | 可靠性小修（watchGroupTodos 竞态；先补测试） | 中 | 完成（StaleGuard 令牌；`npm test` 1001/1001；build 退出 0；接线判据含非空转对照） |
| B5 | 完整回归 + 性能/体积读数 + 最终报告 | 无 | 进行中（5.0.0 tip 上跑 `verify:full`；报告见 `refactor-5.0-report.md`） |
| B6 | 另存图片去重（`saveImageWith` 纯核心 + 薄接线） | 低 | 完成（5.0.1；`npm test` 1007/1007、build 退出 0；新增 6 条路径单测） |
| 后续 | SegmentedControl 状态色适配、saveImage 去重、字节格式统一、事件风暴合并 | 中 | 登记，不阻塞 5.0 |

## 6. 门禁与证据纪律

- 每批必跑：`npm test`（前端断言条数由它自己打印）+ `npm run verify`（17 步快速层）。
- 涉及 Rust 的批次：`npm run verify:full`；涉及真实传输/群/文件：`npm run verify:e2e`（本机条件见仓库文档）。
- 所有退出码裸取，不经过管道；每次记录命令、退出码与失败归因。
- 未执行的层一律写 NOT RUN / BLOCKED，不写成绿。

## 7. 未验证与风险

- Windows / Android 真机行为未在本分支验证；Rust/Android 全量层待主工作树门禁空闲后用共享 `CARGO_TARGET_DIR` 补跑。
- 视觉统一以类名等价为证据；没有截图回归基线，像素级观感未验证。
- 大文件传输期间 UI 响应性、真图解码、灯箱 URL 竞态属于 C 类假设，尚无运行时读数。
