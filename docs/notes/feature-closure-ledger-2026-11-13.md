# 功能级异步闭环台账（2026-11-13）

承接 `docs/notes/feature-closure-async-audit-2026-11-13.md` 阶段一。对每个用户可发起的长流程
登记七项字段：**状态机 / 真值源 / 用户反馈 / 反向动作 / 恢复能力 / 边界资源 / 验收证据**。
"无此能力"是有效值，附原因；不把不可逆动作硬做成可撤销。

- 日期：2026-11-13
- 口径：源码审阅 + 本轮取证；行为结论以当前源码为准，运行时完整性需对应测试佐证。
- 术语：乐观更新（本地可逆且能回滚/服务端确认）≠ 取消（停止未完成工作）≠ 撤回（改变已发送事实）
  ≠ 撤销（约定窗口内恢复本地变更）。恢复分四种：页面重查 / 失败重试 / 断点续传 / 进程重启恢复。

## 台账

### 1. 普通消息发送
- **状态机**：`sending`（乐观上屏）→ 真实记录替换 → `sent`/`failed`；Ack 可先于 invoke 返回。终态不被迟到事件无条件复活。
- **真值源**：Rust outbox + 对端 ACK；前端 `messages` 是投影。
- **用户反馈**：气泡即时上屏；失败保留 `failed` + 重发入口。
- **反向动作**：失败可重发；取消发送与撤回是不同协议动作；发送 invoke 无通用 Abort。
- **恢复能力**：失败重试（outbox 重发）；进程重启后 outbox 续传。无"撤销已发送"。
- **边界资源**：Ack/迟到失败有守卫；乐观投影绑定 `local_id`，真实记录先到则 `dropOptimistic` 不误删。
- **验收证据**：`messaging.ts` 发送守卫 + `restoreSummaryIfOurs`（generation 式摘要回滚）。
- **本轮改进**：批删消息回滚改按项逆操作（见 §并发回滚）。

### 2. 消息撤回 / 反应
- **状态机**：撤回依赖可靠 outbox + 对端事实；反应按服务端结果入账（幂等状态事件）。
- **真值源**：协议 + 对端 ACK；反应不做乐观上屏。
- **用户反馈**：任务中心临时行 + 回执；失败按台账重试。
- **反向动作**：撤回不是本地 undo；反应 add/remove 幂等。
- **恢复能力**：失败重试（outbox）；重启续传。
- **边界资源**：不伪造远端成功；折叠逻辑处理重复反应。
- **验收证据**：协议层判据 + outbox 测试。

### 3. 单聊文件 / 图片传输
- **状态机**：queued/active/verifying/incomplete/completed/failed/cancelled（`TransferStatus`）。
- **真值源**：SQLite `file_transfers` + 字节进度事件。
- **用户反馈**：气泡进度条 + 停滞/恢复提示 + 完成/失败事件。
- **反向动作**：取消（`cancel_file_transfer`）、失败重试/续传、内容重取（`request_content_by_cid`）。
- **恢复能力**：断点续传 + 进程重启恢复（持久台账）；进度丢行安排快照修复。
- **边界资源**：取消台账逐条收尾不短路（本轮 P1 修复 `commit_each_no_short_circuit`）；磁盘满/停滞有判据。
- **验收证据**：`files_tests.rs`（含本轮 `cancel_ledger_*` 反例自证）+ 传输判据。

### 4. 群文件
- **状态机**：Offer→Chunk→Done→CompleteAck；成员级投递台账（completed/failed/waiting/cancelled）。
- **真值源**：Rust 群文件/成员投递台账。
- **用户反馈**：`message/MessageFileBubble.vue`（delivery 底栏 + 进度 + 重取）+ `GroupFilesPanel.vue`（四档状态 + 已送达 N/M + 取消/重取 + 失败横幅）。
- **反向动作**：取消（发送方/接收方两侧，`utils/groupFileCancel`）、重取；文案走 `utils/cancelFeedback` 同一映射。
- **恢复能力**：断点/离线补投按专用规则；多接收人部分失败有事件。
- **边界资源**：取消 busy（`cancellingId`）；部分失败/取消后部分提交说明。
- **验收证据**：`GroupFilesPanel` 判据 + `cancelFeedback.test.ts`。
- **本轮改进**：`media.ts` 过期注释已更新（气泡/进度能力已具备）。

### 5. 群历史同步
- **状态机**：started→running（页/批次进度）→completed/failed/cancelled；协作式取消（页/批次边界停）。
- **真值源**：Rust 后台进度事件 + `group_history` 进度。
- **用户反馈**：UI 横幅 + toast；failed/cancelled 结束提示。
- **反向动作**：取消（`cancel_group_history`）；失败可重新发起（`sync_group_history_now`）。
- **恢复能力**：失败重试；已接收页面保留。
- **边界资源**：后端 `already_running` 去重。
- **验收证据**：任务中心群历史行 + 进度事件判据。
- **本轮改进**：启动期按群 pending + 同群去重 + 非 started 撤销（P3，#35）。

### 6. 好友申请 / 成员管理
- **状态机**：申请 pending/accepted/rejected/withdrawn；群成员/管理员乐观更新。
- **真值源**：后端申请状态 + 刷新；前端投影。
- **用户反馈**：操作失败恢复 UI + toast。
- **反向动作**：申请可撤回；好友删除确认后不可逆；成员动作按后端权限。
- **恢复能力**：失败重试（后端刷新）；无"撤销删好友"。
- **边界资源**：removeFriend 三入口（ChatWindow/ConversationList/ResponsiveLayout）。
- **验收证据**：contacts/groups store 判据。
- **本轮改进**：乐观回滚改按项逆操作 + generation 守卫（P2，#32），消除整份快照并发覆盖。

### 7. 任务中心
- **状态机**：聚合 queued/running/blocked（只列未完成；终态由 toast/气泡反馈）。
- **真值源**：四份台账归一（`file_transfers`/`content_transfers`/outbox/`group_history`/`UpdaterStatusView`），`utils/taskCenter.ts` 唯一读模型。
- **用户反馈**：进度 + 失败原因 + 阻塞信息；读失败保留可区分旧数据。
- **反向动作**：按任务能力 cancel/cancel_message/cancel_update/cancel_content/retry_content/sync_history/cancel_history。
- **恢复能力**：失败任务重试；**不是所有后台工作的统一入口**（见 §8/§10）。
- **边界资源**：无台账不造任务；动作只引用真实命令。
- **验收证据**：`taskCenter.test.ts` + 文件头 kinds 计数判据。

### 8. 桌面 / Android 更新器
- **状态机**：显式阶段（check/download/install）+ downloaded/total + error；另有 `resumable` 标记，表示「状态来自跨重启恢复的意图」，它不是相位（自动检查会把 phase 翻回 idle，标记不跟着丢）。
- **真值源**：`UpdaterStatus`（全局内存会话，可查询 + 单一广播出口）与 settings 表的 `update_intent`（版本/阶段，**非密、不含字节**）。
- **用户反馈**：下载进度条 + 状态文案 + 错误；重启恢复时任务中心列「有可用更新，重新下载」（待办档，无进度、只给重新下载动作），设置页的 `restore` 直接显示下载卡片。
- **反向动作**：下载可取消（`updater_cancel`，同时清意图）；恢复出来的待办由设置页「稍后处理」/ `updater_close` 放弃；**安装开始后不可取消**（安全边界，跨层常量不变）。
- **恢复能力**：失败重试；**进程重启后重查重下** —— 启动时 `restore_update_intent` 读意图并灌回 `resumable`，**不恢复字节、不恢复 installing 相位**；前端自动检查重新查清单，用户点「重新下载」走已有的 `updater_check` + `updater_download` 整包重下。官方更新器整块内存下载、验签后一次返回，**没有续传 API**（用户 2026-11-14 拍板）。
- **边界资源**：离线/清单读失败**不清意图**（那条待办不能因一次抖动消失）；装完、取消、稍后处理、清单说已是最新均清意图；坏意图解析失败关闭并留 `code=UPDATE_INTENT_*` 痕迹；意图写失败不阻断下载。
- **验收证据**：`src-tauri/src/commands/updater.rs` 的 `intent_tests`（编解码与坏值反例、启动接线顺序、不造假的 installing、写/清覆盖全部相位、来源 host 与同源校验、两命令共用实现、自动回落不绕过安全裁决）、`src/utils/taskCenter.test.ts` 与 `src/utils/updater.test.ts` 的 A/B 对照用例、`src/utils/designGuards.test.ts` 的端点常量对账与切源链路判据。
- **来源契约**：清单从哪个平台取，安装包就只能从哪个平台下。指定源时 `check_once` 只挂那一个端点，并按 `download_url` 的 host 复核（不一致即 `code=UPDATE_SOURCE_MISMATCH` 拒绝）；GitHub 连不上自动回落 Gitee，下载缓慢只提示不自动切，下载失败自动切 Gitee 整包重下。Rust 端点常量与 `src-tauri/tauri.conf.json` 的配置由判据逐字对账。
- **本轮改进**：#34 与更新源同源/切换已落地。此前这一节写的是**决策**而不是已实现，现补齐实现与证据。

### 9. 搜索 / 设置 / 只读面板
- **状态机**：loading/error/retry（Query 状态）；不做写入式 optimistic。
- **真值源**：组件/Query 状态。
- **用户反馈**：错误档 + 重试；部分面板重新打开刷新。
- **反向动作**：重试查询；不适用撤回。
- **恢复能力**：页面重查。
- **边界资源**：逐面板验收错误/陈旧/无结果/无权限。
- **验收证据**：各面板 StateBlock 错误档判据。
- **本轮改进**：保留旧值的 Query 补 stale/error 标记 + 重试（P2，#33）。

### 10. Todo 图片 / 共享目录下载
- **状态机**：**早已在册** —— 分别复用 `content_transfers`（Todo 图片按 cid 拉取）与 `file_transfers`（共享目录文件由对端推流）的既有状态机，在任务中心以 `content_fetch` / `file_receive` 出现。此前「无统一台账」是误读。
- **真值源**：`src-tauri/src/network/transport/handle_file.rs` 的 FileOffer 臂写内容台账、`src-tauri/src/network/file/receive.rs` 写文件台账；前端来源映射收在 `src/utils/taskCenter.ts` 的 `OPERATION_ORIGIN_MAP`。
- **用户反馈**：任务中心进度 + 失败原因；Todo 图片另有 `src/components/TodoImageThumb.vue` 的「同步中/已放弃」本地态，共享目录下载后 `src/components/ShareDirectory.vue` 刷新台账。
- **反向动作**：`cancel_content_fetch` / `request_content_by_cid` / `cancel_file_transfer`，都是现有真命令（见 `OperationAction`，不新增）。
- **恢复能力**：随持久台账走（传输链路自己的断点/重启恢复），不套用更新器「重下整包」那一套。
- **边界资源**：来源标记是**契约级映射**，不是新增数据列 —— 后端两张台账没有稳定的「来自 Todo / 共享目录」字段，所以不逐行标来源，也不为了标它去动表结构。
- **验收证据**：`src/utils/taskCenter.test.ts` 的「来源映射不另立 kind」形状判据（带正控）+ `src/utils/taskCenter.ts` 文件头对账注释。
- **本轮改进**：**不新增 OperationKind**（用户 2026-11-14 裁决）。新增会让同一个 transfer_id 出两行，而新 kind 并不带来更多真值或可执行动作；改为登记来源映射、更正文件头与本节的假现状。

## 并发回滚策略（P2，#32，本轮实施）

**问题**：群信息/成员/删好友/删会话/置顶/批删消息的乐观失败回滚整份旧快照；同集合另一操作先成功、
后一操作失败回滚时，旧快照覆盖先成功的变更。

**决策（用户选定）**：按项逆操作回滚 + generation 守卫。
- 回滚只作用于本次改动（对当前态施加逆操作），不恢复整份快照。
- 乐观写入绑定 per-entity generation；权威刷新递增 generation；晚到失败回滚若发现 generation
  已前进（后端已收敛更新）则跳过逆操作，后端状态优先。
- 共享 helper 收口机制，各调用点提供 forward/inverse；配并发反例自证（A 成功 B 失败，B 回滚不覆盖 A）。

## 本轮验证边界

- 已实施并单测绿：P1 取消内容拉取台账不短路、#33 stale 标记、#35 群历史 pending、#32 并发回滚、#34 跨重启重查重下（见 §8/§10）。
- #34 的验收证据见 §8；跑法见 `package.json` 的 `scripts.test` / `scripts.verify:full` 与对应测试文件头，读数以实跑为准，不在此抄数字。
- 台账行为结论以源码为准；运行时完整性需对应测试/真机佐证，不据此宣称"所有边界已兜底"。
