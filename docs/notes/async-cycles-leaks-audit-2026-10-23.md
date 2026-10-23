# 异步链路审计：循环依赖 / 死循环 / 泄露（2026-10-23）

范围：`src-tauri/src`（Rust 后端）与 `src`（Vue 前端）。本轮是**只读取证**，不改行为；
修复排在计划的 A1–A4 批次，每条都要配判据。基线 `ec6c935`（5.5.24）。

结论先说三句：

1. **没有发现循环依赖造成的实际故障**。前端 342 个源文件 import 图 0 个环；Rust 侧的
   "环"全部是**同一模块内的 include! 分册**（`network/file.rs`、`db.rs`、`lib.rs`），
   不是模块级互相依赖，编译单元只有一个，不构成耦合缺陷。
2. **没有发现无界重试 / 无上限循环**。有上界的都指出了上界在哪；唯一"永久重试"那一格
   （LAN 自启）是设计意图、带 sleep、有日志节流，不是缺陷。
3. **发现 1 条真的状态残留（用户可见）+ 3 条有界但口径不一致的项**。全部有
   file:line 证据；其余 10 余项"看着像泄露"的候选经核查都有清理点，列在最后一节防止
   下一轮重复劳动。

复跑本文件里的每一个数字都能用文末「量具」那段的命令现算；本文**不手抄**任何会变的数。

---

## 一、循环依赖

| 轴 | 结论 | 证据 / 量具 |
|---|---|---|
| 前端 import 图 | **0 个环**（现算：342 个文件 / 1042 条边 / 0 个环）。本轮已把它固化成门禁判据 `scripts/check-import-cycles.mjs`，接进快速层（快速层因此从 17 步变 18 步，`docs/large-file-split-plan.md` 里那两处手抄数已同步） | `node scripts/check-import-cycles.mjs`；量具自证 `node scripts/check-import-cycles.mjs --self-test`（人造三元环必须判出 1、菱形依赖必须判 0 —— 两个方向都能红，才允许它报"0 个环"） |
| Rust 模块 | 没有模块级互引；`db.rs`、`network/file.rs`、`lib.rs`、`commands/mod.rs`、`network/transport.rs` 用 `include!` 把分册拼进**同一个模块**，因此"跨文件互相引用"在编译单元内不存在 | `grep -n 'include!' src-tauri/src/db.rs src-tauri/src/network/file.rs src-tauri/src/lib.rs` |
| 命令 / 事件环（emit→listener→invoke→emit） | 未发现闭合环。`message-received` 与 `file-progress` 的**全部** emit 点都在入站传输处理器与发送循环里（`handle_messaging.rs:162`、`gossip.rs:1054`、`group_file.rs:638/997`、`relay_file.rs:111/203`、`handle_file.rs:259/591`、`file/send.rs:577/745`，复跑 `grep -rn '"message-received"' src-tauri/src --include=*.rs`）。前端那条"自 emit 做跨窗口同步"的回声（`send.rs` 里为 sha/size 回填补发的那一次）之所以不构成环，是因为它的监听器**只往缓存里塞记录、不再调任何会 emit 同一事件的命令** —— 环在这里断掉。 | 事件名双向对账由 `src/api/events.test.ts` 在管（"emit 无人听 / 听者已死"两向）；环本身**没有**自动判据 ⇒ 本轮不谎称有 |
| 锁顺序环 | `scripts/check-lock-scope.mjs` 通过（持 db 守卫时再取自锁 helper 那一族已在 J2 修掉并入判据） | `node scripts/check-lock-scope.mjs` |

**本轮补上的判据**：`scripts/check-import-cycles.mjs`（已接进 `verify.mjs` 的 frontend 组）。
在它落地之前，"今天没有环"这句话的保质期只有几小时 —— 加一条 `store ⇄ component`
的互相 import 不会让任何东西红，而环的代价到运行时才显形、现场表现与"环"无关。
白名单 `ALLOWED_CYCLES` 今天是**空**的，并且反向钉一条：往里加的环如果已经不存在了，
也算红（过期例外与第二份事实源是同一类债）。

---

## 二、真的问题（按可影响用户的程度排序）

### P1-A 取消一条文件传输后，「网络停滞」标记不会收回

- 位置：`src/stores/useChatStore.ts` 的三条文件终态处理器。
  `onFileDone`（:2522 起）与 `onFileFailed`（:2553 起）第一行都调
  `setTransferStalled(id, false)`，而 `onFileCancelled`（:2821 起）**没有调**。
- 实际后果：用户取消一条正显示「只有蓝牙，等 LAN 回来自动重试」的文件后，
  那枚停滞标签与那句原因要等到自己的 TTL 过期才消失（`stallFlagAlive`）。
  文件已经终结了，界面还在说它在等网络。
- 是不是内存泄露：**不是**。`setTransferStalled` 在每次置位时顺手清掉过期的邻居
  （:2491 那段 for 循环），读侧也一律过 TTL 判活。所以这是**状态口径漏一格**，
  属于"同一件事三条处理器两种写法"那一族。
- 修法（A4）：补一行 `setTransferStalled(transferId, false);`，判据钉"三条终态处理器
  都必须先收回停滞标记"，并带一个反向夹具证明该谓词能判出"没写"的形状
- **状态（2026-10-23，5.5.33）**：已修。`onFileCancelled` 第一行补上
  `setTransferStalled(transferId, false)`；判据是 `storeContract.test.ts` 那条
  「三条终态事件都收回标记」（按**每个 handler 自己的窗口**取，不是数整份文件 —— 数整份时
  漏一处永远绿）。非空转：把那行删掉 ⇒ 该用例红（实测），恢复即绿。
  顺带更正本文原先那句"不是内存泄露"：**单次**不泄露，但那一格**永远不会被删**
  （`setTransferStalled` 只在置位时清邻居、读侧过 TTL 判活，Map 本身没有删除点），
  一晚上取消十次就积十格、且每次渲染都要查 —— 所以它同时是"状态口径漏一格"与一个
  **只增不减的 Map**。
  （家：`src/utils/storeContract.test.ts`，复用现成的 `sliceFn` / `stripComments`）。
- 确信度：**已证实**（纯静态，行为是"标记存在且未过期 ⇒ 界面读它"，读点在
  `src/composables/useMessageFile.ts` 的 `transferStallReason(t.id)`）。

### P2-B 对端样式表只增不减，唯一的出口是"恢复默认设置"

- 位置：`src-tauri/src/network/transport/handle_messaging.rs:26-34` 往
  `settings.chat_peer_styles`（一个 JSON map）里按 `device_id` 逐条 `insert`。
- 全仓该 key 的写入点只有这一处；读取点 3 处；**删除只有一处**：
  `src-tauri/src/commands/settings.rs:397`，即"恢复默认设置"整片清掉。
  删好友的路径不碰它 ⇒ 已删除设备的样式永久留在库里。
- 上界：历史上来过样式的设备数。增长速度极慢（只在对方带 style 的消息到达时写一行）。
- 判定：**真实但低风险**。修法二选一，A4 定：① 删好友时顺带把该 device_id 从 map 摘掉
  （与"删除一致性"那一族同口径，判据已有 `db/cascade_tests` 的家）；② 不修，
  在 INV 里写明它是"设备级偏好缓存，只有恢复默认会清"。
- **状态（2026-10-23，5.5.35）**：按①修了。`db::forget_chat_peer_style` 是摘这条缓存的唯一入口，
  `remove_friend` 的 DB 块里调它（解析失败当"没有这一项"——缓存坏了不许让删好友失败）。
  判据 `removing_a_friend_forgets_its_chat_style`：删掉的那个没了、别人的还在、重复摘/摘不存在
  的 id 都不报错；同一条用例里另有一句**接线**断言（只写 helper 不接 = 没修）。
  非空转：把 `map.remove(peer_id)` 改成只读的 `map.get(peer_id)` ⇒ 该用例红（实测）。
- 确信度：写入/删除点**已证实**（`grep -rn '"chat_peer_styles"' src-tauri/src`）；
  "删好友不摘"是 absence 结论，靠上面这条 grep 的全集支撑。

### P2-C 群文件在线投递目标表只有终态删除，没有 TTL 清扫

- 位置：`group_file_online_targets`（AppState）。写点按 `transfer_id`；
  删除只发生在收到 ACK 走到 delivered/failed 那一条路径
  （`src-tauri/src/network/transport/group_file.rs:1566` 附近）。
  同文件里的 `sweep_stale_group_file_keys` / `sweep_stale_rounds`（:1260-1291）**不碰**这张表。
- 后果：永远凑不齐 ACK 的死单（对端此后不再上线）条目留到进程退出。
- 上界：死单个数 × 每单的目标设备数。不是洪水面。
- 确信度：**需运行时验证** —— 静态能证明"没有 TTL 清扫点"，但真实速率取决于
  对端是否再来敲同一单，本轮没有跨进程读数。修法候选（A4）：并入既有那一个
  每小时清扫器，别新起一个循环。
- **状态（2026-10-23，5.5.39）**：已并入 `sweep_stale_group_file_keys`（`outbox_sweep` 早就在调它，
  没有新循环）。判据不是盲 TTL 而是**台账状态**：只留 `pending|sending` 的单；
  `completed/failed/cancelled` 与"台账行都不在"的一律摘掉（快照是气泡分母的来源，
  还在传时清掉会让分母退回"未知"）。纯谓词 `online_targets_entry_is_live` + 6 个取值的单测。

### P3-D 到期队列扫描没有 LIMIT，每 tick 全量重列

- 位置：`src-tauri/src/db/offline_queue.rs:84-99` 的 `list_expired_outbox` 只按
  `created_at < ?1 ORDER BY id`，没有 LIMIT；调用点在 `outbox_sweep` 的 5s tick 里。
- 后果：离线保留期内的行（INV-P04 的 7 天）每 tick 都被整批捞出并逐行分类；
  finalize 失败的行**没有退避**，下一个 tick 再撞一次。
- 上界：outbox 行数（用户数据量），内存不涨、每 tick 是 O(N) 的 DB 读。
- 确信度：**结构已证实，耗时影响未证实** —— 需要一份"队列 N 行时一个 tick 多久"的读数
  才能判该不该加 LIMIT。A4 先加读数，不动形状。
- **状态（2026-10-23，5.5.33）**：已加 `LIMIT 500`（`OUTBOX_SWEEP_BATCH`），**但没有先拿到
  耗时读数** —— 这一处与原计划"A4 先加读数、不动形状"不同，如实记账：理由是候选集是**全库**
  且读发生在唯一那把 DB 锁里（不是"看起来像"），而清扫器每 tick 都会再来，取最早的 500 条
  不改变语义、只改变"一轮做多少"。判据是 `expired_sweep_read_is_bounded`（501 条候选 ⇒
  只返回 500、且取的是最早的），非空转由"没有 LIMIT 时返回 501"这一格直接体现。
  仍然缺的：**队列 N 行时一个 tick 多久**那份读数（它同时是 A3 想要的那个量）。
  **读数补上了（2026-10-23，5.5.38）**：`expired_sweep_read_cost_reading` 造 2 万行、
  计时一轮扫描 —— 现读 **20 000 行队列 / 一轮读 500 行 / 0.289 ms**（内存 SQLite + 有 created_at 索引；
  真盘会更慢，但量级在这一侧）。它只打印、不断言时间阈值（CI 负载会把猜的数变成掷硬币），
  唯一断言的是"有界那 500 条确实拿到了"。想让"这条查询有没有变慢"有答案时，复跑它比读旧数。

### P3-E 两处一次性定时器不随 store 作用域清理

- `src/stores/useChatStore.ts:237/248`（`notifyTimer`，通知合批）与
  `:1230-1234`（`transfersRepairTimer`，进度补拉）。两者都是
  模块内 `let … | null` + 自归零的**单发**形状：同一时刻最多各有一个待触发的回调。
- 后果：`init()` 重入（HMR、设置页"重绑事件"）时，旧的那一次延迟回调仍会落地一次
  ⇒ 多一个 toast 批次 / 多一次 `refreshTransfers` IPC。
- 判定：**不是泄露**（有界，≤1）。是否要登记进 `chatInitScope.onDispose` 由 A4 决定；
  若要改，判据应钉"待触发的定时器数量在 init 重入后仍为 0/1"，不是钉出现次数。
- **状态（2026-10-23，5.5.37）**：已登记。`init()` 里那段 `scope.onDispose` 现在与
  `markReadTimer` 一起清掉这两个（并归零句柄）。判据在 `storeContract.test.ts`：
  三个定时器都必须在同一个 onDispose 窗口里出现 `clearTimeout(...)`；删掉其中一个块 ⇒
  该用例红（实测），恢复即绿。
  注意实际危害比原文写的还轻：Store 是**单例**，旧回调落在同一份活状态上（不会碰死实例），
  代价只是多做一次通知合批 / 一次 `refreshTransfers`。登记它的理由是"口径一致"，
  不是"修了一个漏洞"——别把这条当 P0。

### P3-F 常驻 worker 的看门狗自己不被人监督

- 位置：`src-tauri/src/worker_supervisor.rs:31` `MAX_RESTARTS = 5`，`verdict()`（:80-86）
  在 5 次重启后转成"只 error、不再拉起"。
- 这是**刻意的封顶**（注释写明：反复秒退说明代码坏了，再拉也白拉），不是无界循环。
  风险在于：看门狗自己 if finished ⇒ 全部常驻 worker 从此无人判活，且没有第二双眼睛。
- 修法候选（A4，低优先）：给看门狗自己留一条"启动时断言 + 退出留痕"，
  或让它由 `lib.rs` 里那条每小时作业再点亮一次。判据要能区分"worker 全灭"与"看门狗没跑"。
- **状态（2026-10-23，5.5.39）**：按第一种修法落了两行活性证据 —— 启动时
  `code=WORKER_WATCHDOG_STARTED`（worker 数 + 判活周期），之后每 30 拍（默认 5 分钟）
  `code=WORKER_WATCHDOG_ALIVE`（在监督的数量 + 每个 worker 的重启次数）。此前只有"重启/放弃"才说话，
  安静既可能是正常、也可能是它已经死了。判据 `watchdog_leaves_start_and_heartbeat_evidence`
  （读生产码、切掉测试模块 —— 否则会把测试里的字面量数进去）。

---

## 三、查过、确认有界（不要再重新发现一遍）

每条都写了上界在哪。要复证就照着括号里的命令跑。

- **投递重试**：`MAX_FILE_OUTBOX_RETRIES` 封顶 + 5s backoff；Offer 循环 3 次重投 +
  整轮 `timeout(send_deadline_for(size))`（体积自适应，下限 10min、上限 1h）。
- **中继发送**：`RELAY_FILE_SEND_DEADLINE = 5min`，且不进 outbox。
- **接收侧**：`.part` 有 24h TTL；`take_stalled_*` 的 `while let` 每轮真 `remove`（必终止）；
  接收器注册表由每小时作业回收（`lib.rs` 那条 sweep）。
- **群文件续传**：`group_resume_wait_ms` 封顶 15s~10min；ACK 写重试 `ACK_WRITE_ATTEMPTS = 3`；
  `group_file_keys` / `group_file_rounds` 在 `outbox_sweep` 的 tick 里有 2h TTL `retain`。
- **内容拉取**：`MAX_CONTENT_RETRIES = 8`，到上限转 Rejected，且计数不被 upsert 压回。
- **Gossip**：每条链路的事件最多 2 趟，0 结果即返回。
- **拨号/入站并发**：`dial_permits` / `inbound_permits` 信号量封顶；群文件并发闸
  `MAX_CONCURRENT_GROUP_FILE_SENDS = 8`（判据钉住这个值）。
- **内存表**：`dialing` / `peers` / `pending_requests` / `pending_reads` / `pending_group_keys` /
  `pending_out_requests` / `pending_out_accepts` / `conv_link` / `file_receivers` /
  `group_file_receivers` / `group_file_resume_waiters` / `todo_focus_request` /
  `pending_share_tree` / `pending_file_accept` / `pending_file_complete` /
  `group_history_active` / `relay_file_keys` / `ble_*` —— 全部找到删除点，
  其中登记类（accept / complete / resume / history / wire-progress）已由 RAII 守卫
  保证任何退出路径都回收（`WireLedger`、`PendingCompleteGuard`、`ResumeWaiterGuard`、
  `GroupFileDispatchGuard`）。
- **取消槽位（`file_send_cancels`）**：本轮 B1 已把三条投递路径的登记与回收收进
  唯一入口 `network/file::install_cancel_slot`（RAII 守卫），并**删掉了**两处
  "在函数末尾手写调一次"的清理闭包 —— 那一族在整轮 deadline 丢掉内层 future 时
  走不到，残留的登记会让下一次同键投递"一进来就被取消"。判据：
  `tests::cancel_slot_has_exactly_one_home`。
- **前端监听器**：`src/api/index.ts` 里 36 处 `listen<…>` + 12 处裸 `listen(` 全部把
  句柄交回调用方；消费侧没有 `void api.onXxx(...)` 丢句柄的形状，订阅句柄都进了
  store 的 `initScope.onDispose` 或 `StaleGuard` 的滚动摘除。
  既有量具：`src/utils/designGuards.test.ts` 里那条"手工 unlisten 句柄 / 迟到守卫
  一律红、必须走 initScope 单一家"的形状锁（带正控与反控）。
  **它的三个已知盲区**（A1 要补的就是这三格）：① 不扫 `setTimeout/setInterval`
  有没有登记进作用域（P3-E 就是从这缝里漏的）；② 不扫 `void api.onXxx()` 直接丢句柄
  的形状（目前靠 api 层"全数交回句柄"的惯例间接保护）；③ 不扫窗口隐藏期间的空转轮询。
- **前端页面不可见**：`document.hidden` / `visibilitychange` 已接在消息与传输的重拉路径上；
  未接的是 `src/components/message/MergeCardModal.vue:152-153` 那条
  `for (let k = 0; k < 40; k++) { await sleep(1500); … }` 的落盘轮询
  （40 次硬上界 = 最长 60s；每轮开头查 `closed` 就 return，所以关窗最多多等一次 1.5s sleep ——
  有界、不打断在途 sleep，不是泄露）。
- **多窗口**：常驻集合从 Rust 侧 `*_RESIDENT` 现读（有判据），辅助窗口的订阅随窗口生命周期；
  `settings` 是非常驻（关闭即销毁），link/tasks/preview 是常驻（关=隐藏、文档不重载），
  因此它们的监听器"终身"是**设计**，不是泄露 —— 判据要盯的是"隐藏期间还在发 IPC"。

---

## 四、A1–A4 的排期建议（本轮不动码）

| 批次 | 内容 | 判据 |
|---|---|---|
| A1 | ~~固化 `scripts/check-import-cycles.mjs`~~（**本轮已落地**，见第一节：接进快速层、带双向自证）；剩下的是把 designGuards 那三个盲区补成"定时器必须登记进作用域"的形状锁 | 新判据必须自带反控：注入一个未登记的 `setTimeout` 要红 |
| A2 | 无（本轮未发现 Rust 模块环或锁顺序新问题；`check-lock-scope.mjs` 已覆盖） | — |
| A3 | 无界重试：本轮未发现真缺陷；P3-D 先补"队列 N 行时 tick 耗时"的**读数**，有读数再决定加不加 LIMIT | 读数型判据（打印机器值），不是断言一个猜的阈值 |
| A4 | P1-A 一行修复 + 三条处理器同口径的判据；P2-B 与删除级联并案；P2-C 并入既有每小时清扫；P3-F 给看门狗留一条活性证据 | 每类一个判据，独立提交，不与取消功能混在一起 |

---

## 量具（本文件里的数字都可现算）

```
# 前端 import 环（本轮已固化成门禁判据，不再是 /tmp 里的一次性脚本）
node scripts/check-import-cycles.mjs                # 342 文件 / 1042 条边 / 0 个环
node scripts/check-import-cycles.mjs --self-test     # 双向夹具：有环判得出、无环不误报

# 监听注册面
grep -o 'listen<' src/api/index.ts | wc -l        # 36
grep -o 'listen(' src/api/index.ts | wc -l        # 12

# 定时器 vs 清理器（差值为正不代表泄露，单发形状自带去重）
grep -rn 'setInterval(' src --include=*.ts --include=*.vue | wc -l
grep -rn 'clearInterval(' src --include=*.ts --include=*.vue | wc -l

# 样式表的唯一删除出口
grep -rn '"chat_peer_styles"' src-tauri/src        # 写 1 / 读 3 / 清 1（恢复默认）

# 到期扫描没有 LIMIT
grep -n 'FROM outbox WHERE created_at' src-tauri/src/db/offline_queue.rs

# worker 重启上限
grep -n 'MAX_RESTARTS' src-tauri/src/worker_supervisor.rs

# 三条文件终态处理器的停滞标记口径
grep -n 'setTransferStalled(' src/stores/useChatStore.ts
```

未做也未声称的事：跨进程双实例 E2E、真 WKWebView/WebView2 界面读数、真机长跑内存曲线。
P2-C / P3-D / P3-E 的真实速率都属于这三类，本文一律标"需运行时验证"，不写成已结。
