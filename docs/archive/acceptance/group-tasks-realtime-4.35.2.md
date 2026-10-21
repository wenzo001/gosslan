# 群任务实时刷新与任务卡片点击区域验收报告（v4.35.2）

- 范围：用户指令「群任务面板实时刷新 + 群聊任务卡片点击区域修复」，版本 4.35.1 → 4.35.2。
- 最终提交：代码 `c829208`（fix(tasks)）；认知同步 `30d63a4`（chore(cognition)）；Release tag **v4.35.2**。
- 本轮零 Rust 产品码改动；冻结核心（消息状态、msg_id、去重、Outbox/Ack、Gossip、群同步、文件传输、通知可靠性语义）未动。

---

## 1. 今日提交审查与真实根因

| 提交 | 内容 |
|---|---|
| `c829208` | fix(tasks)：看板实时同步修复 + 任务卡片三命中区 + 20 条新增探针判据（3 个产品文件 + 1 个测试脚本，L1/85 产品行） |
| `30d63a4` | chore(cognition)：AOCI 30 条语义更新（28 update + 2 create），verify/check/guide 全对齐 |

### 根因 1：独立任务窗的订阅接错了数据源

- `51dac87` 把群任务看板的取数口从有上界的消息缓存改成全表读 `groupTodoRows`（`getGroupTodoMessages`），但 `d0fff98` 建立的独立窗口实时订阅 `watchGroupTodos` 在 150ms 去抖后仍调用 `loadMessages`（写 `messages`）。
- 后果：其他成员新增/修改/完成/归档任务时，窗口**收到了事件、也发了 IPC，看板却一动不动**；只有窗口重新聚焦（`applyTarget` 的焦点兜底全量重读）碰巧把它刷新。
- 修复：新增 `reloadGroupTodoRows(groupId)`，以 DB 为真相按群整表重读并写入 `groupTodoRows`；与首屏读 `ensureGroupTodoRows` 共用 StaleGuard 键（`todoRows:group:<id>`），首屏读与事件读互相作废，只有最后发起的结果落地；读失败保留旧列表。
- 不做按事件增量拼接：事件可能重复 / 乱序 / 重连补发，整表替换把去重、防幽灵、防旧快照回滚都交给 DB 快照与折叠层（`foldTodos` 的 LWW），不造第二个真相源。

应用内弹窗（移动端 / 桌面独立窗创建失败回退）走主 store 的批量合并（`mergeIncomingTodoRows`），原本就实时；本轮补的是桌面默认路径的独立窗口。

### 根因 2：任务卡片只有底部一个可点区

- 修复前 `TodoCardBubble` 仅底部按钮可点（直达详情），头部/描述/指派人区域无任何交互。
- 修复后三个**互不重叠的兄弟命中区**，没有透明覆盖层：
  1. 底部操作条（真 `<button>`）→ `open(todoId)` 直达**这条**任务详情；
  2. 卡片主体（头部/描述/指派人，`role=button` + `tabindex=0`）→ `open-panel` 只打开看板，Enter/Space 均可触发，描述内 URL 链接只走外部打开（`closest('a')` 判空）；
  3. 图片缩略图容器 `@click.stop` + 键盘 stop，缩略图自身的点击/Enter 只开统一图片预览，绝不冒泡成开面板或详情。
- `MessageItem` 分别转发 `open`（带 id）与 `open-panel`；普通图片消息、合并卡片等其他消息不受影响。

## 2. 实时链路与「数据已同步≠UI 已刷新」

| 环节 | 证据 |
|---|---|
| 后端事件 | 任务创建/改动经 `send_group_message` 落库并 `app.emit("message-received")` 广播（群广播 Gossip 路径既有，task E2E 已证） |
| 窗口订阅 | 独立窗 `GroupTodosWindow.applyTarget` → `watchGroupTodos(gid)`，只订本群；150ms 合并突发；unlisten 摘定时器与监听 |
| 重读 | 去抖回调以 DB 快照整表替换这一个群的 `groupTodoRows` |
| 折叠/渲染 | 看板唯一折叠 `foldTodos(groupTodoRows[conv])` → 活动/归档分组、计数、详情弹窗同源 |
| UI 状态保持 | 实时重读只换数据：筛选胶囊（默认「给我的」）、已展开的详情弹窗都保留，详情内容跟到最新定义 |

断线重连后补发/重复帧只会再次触发整表重读，终态由 DB 决定；探针用「旧 seq 帧 + 重复帧」验证不回滚、不重复。

## 3. 自动化验证（行为测试，非源码字符串）

| 项 | 结果 | 复跑 |
|---|---|---|
| 前端 node:test | **915/915** | `npm test` |
| UI 运行时探针（真浏览器 CDP） | **231/231**（新增 20：看板实时 14 + 三命中区 6） | `npm run test:ui-runtime`（分段：`--only=tasksrt` / `--only=task`） |
| 实时探针变异反证 | 把订阅回调改回不更新数据源 → 14 条中 7 条实时断言变红、恢复后全绿 | 临时注入，已还原 |
| 三命中区变异反证 | 去图片区 stop → 图片点击两条变红；主体去 role/click → 主体两条变红 | 临时注入，已还原 |
| 双实例任务专项 E2E | **49 条断言全绿**（双向创建→完成→归档→重开、崩溃补发、重启不二次投递） | `node scripts/e2e-multi-instance.mjs --round=task`（按当前源码重编 release 二进制） |
| 222 条非空转护栏 | **222/222** | `python3 scripts/verify-guards.py`（约 2h10m） |
| Rust 测试 | 804（bluetooth）/ 788（默认）；零产品码改动 | `cargo test --features bluetooth --lib` |
| clippy / fmt | 双特性 `-D warnings` 零红、fmt 零差异 | 同前两轮 |
| 文档守卫 | CHANGELOG 结构、硬数字、file:line 对账通过 | `node scripts/check-doc-numbers.mjs` |
| CI（代码 SHA `c829208`） | Verify / Windows / macOS / Android **四条全绿** | GitHub Actions |

### 新增探针场景说明（`scripts/check-ui-runtime.mjs`）

- `runTasksRealtime`（`--only=tasksrt`，14 条）：挂真 `GroupTasksBoard`，stub 掉 `getGroupTodoMessages`（DB 快照）与 `onMessageReceived`（事件总线），从后端事件方向推帧——首屏计数、订阅注册、5 帧（含 1 重复帧）合并成 1 次重读、新增/改名/完成/归档后计数 2,2,0,1、无重复行、详情弹窗保留且跟新标题、筛选不重置、旧 seq 帧不回滚、归档筛选、unlisten 后事件失效、重订阅自愈、关掉重开首屏即持久化终态。等待使用有界条件轮询（固定 sleep 在长会话里曾假红）。
- `runTaskCard` 增补 6 条：主体点击仅 `open-panel`、主体键盘 Enter/Space 两次、图片点击只开预览、图片键盘只开预览、描述 URL 不被主体拦截；探针 harness 新增 `onOpenPanel` 捕获，`focusThumb` 改为优先选中缩略图（主体也是 role=button 后旧选择器会选错）。

## 4. 修改文件与目的

| 文件 | 目的 |
|---|---|
| `src/stores/useChatStore.ts` | 新增 `reloadGroupTodoRows`；`watchGroupTodos` 去抖回调从 `loadMessages` 改为重读 `groupTodoRows`（+33 行） |
| `src/components/TodoCardBubble.vue` | 主体命中区（role/tabindex/键盘/链接放行）、新增 `open-panel` 事件、图片区冒泡截断 |
| `src/components/MessageItem.vue` | 转发 `open-panel`（1 行） |
| `scripts/check-ui-runtime.mjs` | todoBus/chatStore 夹具 + 实时同步场景 14 条 + 三命中区 6 条 + 焦点选择器修正 |
| `CHANGELOG.md` + 五处版本文件 | 4.35.2 发版记录 |

## 5. 平台验证与 Release

- Release tag **v4.35.2**（annotated）触发四条发布工作流，产物由唯一脚本 `scripts/publish-release-assets.sh` 幂等创建 Release 并上传（空产物必红）：
  - Android：`gosslan-4.35.2-arm64-v8a-release.apk`(+sha256)、`gosslan-4.35.2-armeabi-v7a-release.apk`(+sha256)
  - macOS：`Gosslan_4.35.2_aarch64.dmg`、`Gosslan_4.35.2_x64.dmg`
  - Windows：`Gosslan_4.35.2_x64-setup.exe`、`Gosslan_4.35.2_arm64-setup.exe` 及各自 `-webview2-bundled.exe`
- 产物在 Release 页逐项核验（10 个附件、下载链接、tag、SHA 一致）。

## 6. 未完成事项 / 客观限制

- **真机交互 Smoke**：三命中区在 headless Chrome 已做鼠标+键盘行为验证；Windows/macOS 任务窗里真实成员并发操作的观感、Android WebView 触摸反馈属人工 Smoke 项。
- **iOS**：无构建工程，不产出安装包（边界不变）。
- **AOCI**：本轮已在提交后完成完整对接（Whole-Index 14 块交付、Challenge 10/10、30 条语义更新、verify/check/guide 对齐）；项目既有 282 个 skipped 对象（vendored/生成物/测试 observe 策略）不在本轮范围。
