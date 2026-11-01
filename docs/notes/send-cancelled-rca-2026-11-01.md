# 发送端台账假「已取消」根因分析（判据⑩ A=cancelled，正式修复任务的立案材料）

日期：2026-11-01（取证）｜ 同日按《发送端台账假「已取消」正式修复任务》实施修复，见 §9
执行级别：L2 `[plan]` + `Version-Bump: patch`
状态：**根因已取证，且已实施**（判据⑩ 修复前后的 E2E 读数在 §9 / §10）。

---

## 1. 症状（一句话）

100 MB 文件在接收端**真的收完并落地**（同一轮里"补完那份等于源文件""终名落地 100 MB"两条判据都绿），
但**发送端自己的台账停在 `cancelled`** —— 用户会看到一条"已取消"的、其实成功的传输。

判据原文（`scripts/e2e/rounds/sendkill.mjs`，断言标题「重启后的终局只有一个：两侧 done 且队列清零」）：

```
预期 B=done A=done outbox=0
实际 B=done A=cancelled outbox=0
```

读数来源已现读确认：`waitSendTerminal`（`scripts/e2e/core.mjs`）轮询**活着的** A 库，
按 `file_transfers.status` 与 `COUNT(*) FROM file_outbox` 取值，**遇到第一个终态就停**
（done/failed/cancelled 三档之一）⇒ 它读到的是产品真写进库的那一格，不是快照、不是展示层。

复现性：**七次同形**（四趟 `verify:e2e` 整链 + 三次单轮），日志指纹逐字一致（见 §3）。
判据本身自 2026-10-07 就在册；本仓文档里此前 grep `A=cancelled` / `判据⑩` **零命中** ⇒ 第一次亮、没有台账。

---

## 2. 结论先说（两层根因）

| 层 | 机制 | 性质 |
|---|---|---|
| **主因（造出假取消）** | 同一个 `(transfer_id, peer)` 上**并发跑了两个发送任务**，第二个任务的 `install_cancel_slot` 用 `HashMap::insert` 把第一个任务登记的 `oneshot::Sender` **挤掉**；被挤掉的那个任务的 `Receiver` 当场以 `Err(Closed)` 完成，而这条链路上**"通道关闭"就等于"用户取消"** ⇒ 没有任何人点取消，任务却带着 `SendFileError::cancelled("用户取消发送")` 退出 | 真缺陷 · 产品级 |
| **锁死层（让假取消不可逆）** | 该取消走 `finalize_file_failure` ⇒ 同一事务里写 `file_transfers.status='cancelled'` **并置墓碑 `cancel_terminal=1`**；随后**真正成功**的那条任务写 `done` 时被 `upsert_transfer` 的 `WHERE ... AND cancel_terminal = 0` 挡住 ⇒ 0 行更新、而 `upsert_transfer` 把 `conn.execute` 的返回值丢了、只看 `Err` ⇒ **静默**，界面上就永远是"已取消" | 设计本意（墓碑不许晚到的 attempt 改回）被上游假信号触发 |

两句都要留着：**墓碑是对的**（INV-P26 那条"取消不许被晚到 attempt 改写"靠它），
要修的是**不该出现的取消**，不是把墓碑放宽。

---

## 3. 证据链（磁盘上的事实，不是推论）

取样：`test-results/run-2026-10-31T18-44-10-035Z/instance-A-6.stashed-gosslan-1.log`（发送端 A，重启后的那一次启动）。
其余六次同一形状的日志逐字同形（同一秒两条 `offer-sending` + 紧跟一条 `[CANCELLED]` + 之后 `COMPLETED ok=true`）：

```
18:44:38 [outbox] code=FILE_OUTBOX_RECOVERED count=1 action=sending→pending      ← 启动恢复：队列行回到 pending
18:44:38 [file]   code=TRANSFER_INTERRUPTED_RECOVERED count=1 action=active→failed ← 启动恢复：在飞台账改 failed（不是 cancelled）
18:44:38 [link]   建链 peer=gosslan-9f9b38c43544b-i2 path=routed                  ← 建链触发补发
18:44:38 [file]   [FILE] offer-sending peer=…-i2 tid=e2e-k-…-qqd2zq … resume_from=0        ← 发送任务 #1
18:44:38 [file]   [FILE] offer-sending peer=…-i2 tid=e2e-k-…-qqd2zq … resume_from=262144   ← 发送任务 #2（同一 tid、同一 peer！）
18:44:38 [file]   [CANCELLED] transfer=e2e-k-…-qqd2zq 用户取消，本次投递退出且不再重发     ← 假取消（无人点取消）
18:44:38 [content] ContentRequest 服务失败 cid=… from=…-i2                        ← #2 的家：内容拉取服务任务
18:44:43 [file]   [FILE] accept RECEIVED … → start streaming
18:44:44 [file]   [FILE] COMPLETED peer=…-i2 tid=e2e-k-…-qqd2zq ok=true           ← 文件真的传完了
```

`[CANCELLED] transfer=… 用户取消，本次投递退出且不再重发` 这一行**只有一个作者** ——
`commands/files.rs` 里 `RetryVerdict::Cancelled` 那一臂（它上面还有 `[FAILED]` 与静默重试两臂），
⇒ 证死了"取消确实发生在本进程的投递任务里"，不是展示层、不是启动清扫。

### 3.1 六个 `cancelled` 写入点（**更正一条我自己早先说的"四个"**）

`src-tauri/src/network/file/send.rs` 里 `SendFileError::cancelled("用户取消发送")` **现数是 6 处**，
不是我上一轮报的 4 处（分母要现算，这条本身就是"手抄数会漂"的现场）：

| 位置 | 宿主 | 到达条件 |
|---|---|---|
| `send.rs:74` | `send_file_from_path_at` | 整文件哈希**之后** `cancel_requested(&mut cancel_rx)` |
| `send.rs:233` | 同上（Offer 等待循环） | `select! { biased; _ = &mut cancel_rx … }` 等 `FileAccept`（15 s）那一段 |
| `send.rs:502` | `stream_file` 分片循环 | 每片之前盯取消槽位 |
| `send.rs:531` | `stream_file` 分片循环 | 等链路队列背压时盯取消槽位 |
| `send.rs:619` | `stream_file` 发 `FileDone` | 与 `send_on_link` 赛跑 |
| `send.rs:627` | `stream_file` 等完成 ack | 与 `wait_complete_ack` 赛跑 |

同名单还有一家**不是这个类型**：`commands/group_file_dispatch.rs`（群那条把 `GroupFileSendErr::Cancelled`
也印成"用户取消发送"）⇒ 界面文案分不出 1:1 与群。

**六个臂没有一个打印"死在第几段"**，所以本次只能靠排除法定位（下条）。

### 3.2 落在哪一个臂：靠日志排除

被取消的那条任务打了 `offer-sending`、**没打** `offer SENT … waiting FileAccept`，
也没打 `accept RECEIVED → start streaming` ⇒ 它走完了 `send.rs:74`（哈希后检查）却没进到 `stream_file`，
⇒ 落点是 `send.rs:233` 那条 Offer 等待的 `select` 臂。**这是排除法得到的结论（INFERRED），不是插桩读到的** ——
六个臂同名同串、盘上无从区分，这条本身是"可诊断"缺口（见 §6 配套第 2 条）。

### 3.3 "通道关闭 = 取消"是代码自己写的口径（PROVEN）

- `network/file.rs` 的 `cancel_requested`：`Ok(()) | Err(TryRecvError::Closed) => true` —— **closed 就算取消**。
- 同一段的注释原话："`Closed`（登记被摘掉）也算：投递循环里 `_ = &mut cancel_rx` 那条分支本来就分不清
  Ok 与 Err，两处口径必须一致"。
- `install_cancel_slot` 用 `.insert(key, tx)`；键 = `file_cancel_key(transfer_id, recipient)` =
  `"{transfer_id}\u{0}{recipient}"`。`HashMap::insert` 撞同键时**静默 drop 旧的 Sender**。
- `CancelSlotGuard::drop` 是**按 key 无条件 remove** ⇒ 先死的那个任务的守卫会把**还活着的那个**任务的登记也摘掉
  （这解释了为什么同一轮里两条任务先后都失败、而 18:44:43 那一次只剩一条时它顺利跑完）。

这一族**不是新问题**：`network/file.rs` 里"为什么键不能只用 `transfer_id`"那段注释（真机：三成员以上群文件
只有一人收得到）写的就是同一条机制 —— 群侧当时靠**加收件人进键**修好了；
本例是**同一收件人 + 同一 transfer_id 的两个任务**，键相同 ⇒ 那次修复覆盖不到。
同文件后面"清理只留这一个家"那段也预告过形状：`"同键的下一次投递 insert 又把残留挤掉，
对方的 rx 当场以 Err(RecvError) 完成 ⇒ 一进来就'被取消'"`。**同形缺陷换了入口重新出现**，这是它最该被记住的地方。

### 3.4 两个任务各自的家（PROVEN）

| 任务 | 入口 | 它用的闸门 |
|---|---|---|
| #1 outbox 补发 | `commands/files.rs` 的 `flush_pending_files`（建链 / Hello / 心跳触发） | `mark_peer_sending(&state.file_sending, peer_id)` + `PeerSendGuard` —— **只按 peer 去重** |
| #2 内容拉取服务 | `network/transport/handle_share.rs` 的 ContentRequest 服务任务，调 `send_file_from_path_at(&st, &job.peer_id, &job.transfer_id, …)`，`transfer_id` 就是**原始那份的 id** | 它自己的按 peer 串行队列（同文件注释承认 `pending_file_accept` 是单键）—— **不碰 `file_sending`** |

⇒ 两道闸门管同一个资源、彼此看不见。**这就是并发来源。**
（`network/file.rs` 里那条 16 MiB 分档的注释早就抱怨过 `file_sending` 按 peer 去重的代价 ——
说明这一族的状态模型一直是"按 peer"，而取消槽位是"按 (transfer_id, peer)"，两套键从来不一样。）

### 3.5 锁死层（PROVEN，两条 SQL 逐字读过）

- `db/file_transfer.rs` 的 `upsert_transfer`：
  `… ON CONFLICT(id) DO UPDATE SET … WHERE file_transfers.status <> 'done' AND file_transfers.cancel_terminal = 0`，
  且函数体把 `conn.execute` 的结果丢弃、`Ok(())` 照返 ⇒ **被挡住 = 0 行 = 无声**；
  调用侧 `send.rs` 的 `send_finalize_rows` 只对 `Err` 留痕 ⇒ 真成功的那一份写不进台账，也不报错。
- `db/file_transfer.rs` 的取消终态（`finalize_file_failure`）在**同一事务**里写
  `cancelled` + `cancel_terminal = 1`；注释自己写明 `cancel_terminal=1` **只有用户/对端主动取消会置位** ⇒
  本次是假取消把它错误点亮（缺陷的"错误置位"面）。
- `db/messages.rs` 的 `set_message_status_with_code`：
  `WHERE … AND status NOT IN ('read','delivered','recalled','cancelled','partial_cancelled','failed')`
  ⇒ 气泡同样回不来。它只保护 `messages`，**不保护 `file_transfers`**（两套名单不是同一件事）。
- 队列行为什么还是 0：取消臂写的 `mark_file_outbox_cancelled` 是把 `file_outbox.status` 置 `cancelled`（不删行），
  而成功那条走 `drop_sent_outbox_row`（按 `transfer_id` 删）⇒ 观测到的 `outbox=0` 与"台账 cancelled"**互不矛盾**，
  这条一开始被怀疑成"判据读错"，现读证否。

### 3.6 排除掉的候选（都查过，写下来免得下一个人重查）

| 候选 | 结论 | 依据 |
|---|---|---|
| 启动清扫把在飞单记成 cancelled | **否** | `fail_interrupted_transfers_on_startup` 只写 `failed`，且只碰 `status='active'`；日志自己印了 `action=active→failed` |
| 链路关闭/断开 | **否** | 没有任何链路拆除路径调用 `signal_cancel_slot(s)` |
| 读写超时 | **否** | `send.rs` 的 deadline 臂产的是 `retryable`，走 `RetryVerdict::Retry` |
| `JoinHandle` 被线程池中断 | **否** | 那一臂映射成 `permanent`（落 `failed`），不是 cancelled |
| 对端不回 ack 被判取消 | **否** | 那一臂是 `retryable("接收方未确认文件完成")` |
| 删好友 / 删会话的连带取消 | **否** | `cancel_send_transfers_for_peer` 只有 `friends.rs` / `chat.rs` / `favorites.rs` 三个调用点，本判据不碰；且它的 note 是 `peer_cancel` |
| 对端发来 `FileCancel` 帧 | **否（本机）** | 该帧只有一个发送家（`commands/files.rs` 的用户取消命令）；B 侧日志里没有它 |
| 判据取样太早（量具） | **否** | 取样在 `waitFor` 落地 + `waitSendTerminal` 之后；且墓碑一旦置位，晚到的 `done` 本来就写不进去，取样时刻不改变结论 |

---

## 4. 用户看到什么（产品后果，不是工程内部事）

1. 传输**成功**，界面却显示"已取消"，且**进度打回**、不可自愈（墓碑挡住了所有晚到的正确写）。
2. 因为六个臂共用同一句"用户取消发送"，用户会以为是自己误点；而日志里唯一的那行 `[CANCELLED] … 用户取消`
   把责任**错误地写回给用户**（这条在真机故障上报时最伤：现场日志会指着运维说"你自己取消的"）。
3. 同一条链路上如果两个任务都被顶掉（守卫按 key 摘掉对方那一格），会出现"整单反复卡在发送中/取消"的抖动，
   比这里看到的更糟。

---

## 5. 最小修复方案（一次做完，不动墓碑、不动展示、不动判据）

**主修（一处家 + 两个入口）**：给 1:1 发送补一条**按 `(transfer_id, recipient)` 去重的在途闸**，
两个入口都必须先抢它、抢不到就**本轮不重发**（队行列留在原地，等下一次建链/心跳）。

- 键复用现成的 `file_peer_key(transfer_id, recipient)`，**不新造第二套键**。
- 形状照抄群侧已经存在且已被判据钉住的 `AppState::group_file_dispatching`（RAII 守卫、集合、同键格式）⇒
  不引入新模式，只是把群侧那一家搬到 1:1。
- 为什么按 `(transfer_id, recipient)` 而不是复用 `file_sending`（按 peer）：按 peer 会把
  "同 peer 的其它文件"一起堵住（`network/file.rs` 里 16 MiB 分档那条注释抱怨的就是这个代价），
  而本缺陷的最小修复**不该顺带改投递并发度**。
- 落点：`commands/files.rs::flush_pending_files` 的任务体内、每条 transfer 之前；
  `network/transport/handle_share.rs` 的 ContentRequest 发送臂之前。两处都用同一个守卫类型。

**配套第 1 条（防同一族的第二次复发）**：`install_cancel_slot` 不许静默顶掉在任者 ——
撞键时**返回"已有人在途"**（`Option`/`Result` 由编译器把两个调用点逼出来），而不是 `.insert()` 覆盖。
这条与主修是**同一件事的两半**：主修让并发不发生，这一条让"万一又并发"不再伪装成取消。
只改这里不改主修 = 让第二个任务静默不发，那是把缺陷换一种形态留下。

**配套第 2 条（可诊断，零行为变化）**：
- 六个 `cancelled` 臂各带一个**段落名**（`hash` / `offer-wait` / `chunk` / `backpressure` / `done-send` / `ack-wait`），
  进 `[CANCELLED]` 那行 ⇒ 下次不用靠排除法；
- `upsert_transfer` / 终态写被挡住时（0 行且期望是终态前进）落一条带 code 的 Warn
  （例：`code=TERMINAL_WRITE_REFUSED transfer=… want=done have=cancelled`）⇒ 把"静默不可逆"变成"有声不可逆"。
  **不改写语义**，只补留痕。

**明确不做**（都是会掩盖问题的路子）：
- 不放宽 `cancel_terminal` 墓碑、不扩大 `upsert_transfer` 的可改写集合（那是 INV-P26 的正面）；
- 不改判据⑩、不放宽它的期望值、不给它加"再等一会儿"（用户明令禁止）；
- 不把界面文案从"已取消"改成别的说法来降低可见度（那正是"修改展示掩盖问题"）；
- 不动 `file_sending` 的按 peer 并发度（超范围）。

---

## 6. 影响面（按编译器与调用点数，不按印象）

| 面 | 具体 | 依据 |
|---|---|---|
| Rust 生产码 | `network/file.rs`（`install_cancel_slot` 签名 + 新守卫类型 + 1 处家）、`commands/files.rs`（`flush_pending_files` 任务体）、`network/transport/handle_share.rs`（服务臂）、`network/file/send.rs`（六个臂的段落名）、`db/file_transfer.rs`（0 行留痕） | 5 个文件；`install_cancel_slot` 生产调用点现数 **3 处**：`send.rs` / `relay_push.rs` / `commands/group_file_dispatch.rs` ⇒ 签名一改，三处一起过编译 |
| 群侧 | **不动**。群那条已有自己的在途集合与按收件人的键 | `state.rs` 的 `group_file_dispatching` 注释 |
| 中继推送 | `relay_push.rs` 用同一个键族 ⇒ 属于"是否也要过闸"的判断点；本轮只登记，改与不改由主修那一条一并表态 | 现读到该处 `install_cancel_slot(state, transfer_id, peer_id)` |
| 既有判据 | 有一条**结构判据**读 `install_cancel_slot(state,transfer_id,` 这类形状（`lib_file_tests.rs` 的 `cancel_slot_has_exactly_one_home` 一族）⇒ 改签名/加守卫必须**同批改判据**，否则红在判据上而不是红在产品上 | 现读 `lib_file_tests.rs` 里 `install_cancel_slot` 与 `fninstall_cancel_slot` 两处断言 |
| DB / 迁移 | **零**。不加列、不加表、不动 `PRAGMA user_version` | 方案只动内存闸与留痕 |
| 协议 / 线上帧 | **零**。不发新帧型、不碰 `FileCancel` 语义（本仓规矩：优先复用已线字段） | — |
| 前端 | **零** | 展示层不改 |
| 档位 | L2 `[plan]` + `Version-Bump: patch`（五个版本清单文件同批） | 改动半径 = 投递路径行为，跨 Rust 多文件但不跨协议/DB |

---

## 7. 验证方案（先红后绿，判据现成）

1. **绿的那一步不用新造**：`--fault=sender-kill-mid`（判据⑩）今天就是红的、且是**真产品红**；
   修完它自己转绿 —— 复跑 `npm run test:e2e:sendkill`（或门禁 `verify:e2e` 里那一步，照抄它的 `cmd`+`args`）。
   ⚠️ 判据不许动：期望仍是"两侧 done + 队列清零"。
2. **反向一格**（证这条判据不是空转）：把新守卫的"抢不到就跳过"改成"抢不到也照发"，判据⑩必须回到 `A=cancelled`。
   这是本仓反复付钱换来的动作 —— 改坏必须 FAIL。
3. **Rust 侧一格**：`install_cancel_slot` 撞键时**不许**让先登记的 `Receiver` 读到取消
   （新用例：同键两次 install，第一次的 rx `try_recv()` 必须是 `Empty`；并配一条"旧实现下它是 `Closed`"的正控）。
   这一格把"通道关闭 = 取消"这个口径的**误伤面**钉住，不依赖 E2E 时序。
4. **接线判据一格**：钉"两个入口都经过同一个守卫家"（调用点计数 + 由 `PeerSendGuard`/新守卫类型驱动），
   防止以后有人在第三个入口再抄一份裸 `send_file_from_path_at`（本仓教训：逻辑判据全绿不等于它被接上）。
5. 层级：改 `.rs` ⇒ `npm run verify:full`（cargo fmt / clippy `-D warnings` / 单测 / 清单守卫）+
   `verify:e2e` 里那一轮；文档硬数字由 `node scripts/check-doc-numbers.mjs` 现算对账。

---

## 8. 与本轮已批准修复的关系

本轮已批准的接收方恢复修复（`friend_req:` 键的 LIKE 误删）**与本条无关**，两者不共用键、不共用状态表。
A4 申请方待发申请（`pending_out_requests` 内存态）也**不是**本条 ——
那条在 `docs/notes/full-repo-audit-2026-10-29.md` §4.0bk 末段单独列了产品行为与实现影响，等用户拍板。

---

## 9. 实施记录（同日，按正式修复任务指令）

### 9.1 三项实施前核对的结论（都读过实现，不是推断）

**① `install_cancel_slot` 撞键时各调用方怎么处理？** 生产调用点现数 **3 处**，改前**三处都是"无条件登记"**，
谁都不知道撞了键 —— 撞键的后果由被顶掉那一方在下一次 `select!` / `cancel_requested` 处**以"用户取消"的形态**浮现，
所以旧代码里 `AlreadyInFlight` 与 `UserCancelled` **不是两个值，而是同一个值**（这正是缺陷本身）。
三家各自的位置与改后口径：

| 登记点 | 所属投递路径 | 改前 | 改后（`CancelSlotInstall::AlreadyInFlight` 那一支） |
|---|---|---|---|
| `network/file/send.rs` 的 `send_file_from_path_at` | 1:1 直发（outbox 补发与 ContentRequest 回发共用这一个家） | 顶替在任者 | `SendFileError::retryable(...)` + `code=SEND_ALREADY_IN_FLIGHT` ⇒ 队列行保持 pending、attempts 不消耗，**不落 cancelled/failed** |
| `network/file/relay_push.rs` 的 `relay_push_file` | 借一跳中继推共享目录文件 | 顶替在任者 | 发新码 `FAIL_CODE_FILE_SEND_ALREADY_IN_FLIGHT`；外层 `send_file_via_relay` 认这个码 ⇒ **跳过 `mark_transfer_failed_if_active`**；`handle_share` 也认它 ⇒ 不发 `file-failed` |
| `commands/group_file_dispatch.rs` 的 `dispatch_group_file_to_peer` | 群投递（每成员一任务） | 顶替在任者（就是当年"N 个成员只有最后一个发得完"那条） | 与它上面那道 `GroupFileDispatchGuard` **同一口径**：本轮跳过、`Ok(())` 返回 |

⚠️ 刻意**没有**改 `cancel_requested` 里"`Err(Closed)` 算取消"那条口径 —— 它还管着"外层 deadline 丢掉内层 future ⇒
登记随守卫展开被摘 ⇒ 那个任务自己也已经不在"这段生命周期。把它整体翻成"非取消"会造出另一种错：**真取消被漏掉**。
要修的是不该发生的顶替（上面三行），不是取消的判定。

**② `relay_push.rs` 会不会与其它入口对同一 `(transfer, recipient)` 并发？** 会 —— 已接入统一闸门。调用链证据：
`send_file_via_relay` 全仓**只有一个调用点**（`transport/handle_share.rs` 里 ContentRequest 服务任务那一支，
`has_link` 为假时走它），而同一支的另一半（`has_link` 为真）与 `from_seq/from_bytes` 那一支都调
`send_file_from_path*`；outbox 补发那条（`commands::flush_pending_files`）调的也是同一个函数。
⇒ 中继与直发不会同时跑**同一个 job**（一个 job 只走一个分支），但**同一 `(transfer_id, peer)` 可以被
两个不同的 job 分别走"中继"与"直发"**（链路状态在两次 `has_link` 之间翻转），也可以与 outbox 补发并发。
所以闸门接在**任务入口**（`handle_share` 的 `async move` 开头，两个分支之前）而不是接在 `relay_push` 内部 ——
一处覆盖三条出口，中继那一支不需要自己再抢一次（它已经在闸后面了）。

**③ RAII 守卫释放时有没有所有权校验？** 改前**没有**：`CancelSlotGuard::drop` 是无条件 `remove(&key)` ⇒
先收尾的那个任务会把**别人**那一格摘掉（真取消之后同键可以重新登记，于是"上一个人的 Drop"拆掉"下一个人的取消信道"）。
改后登记表值变成 `(Sender, 登记序号)`，守卫带着自己那份序号，Drop 时**序号对不上就不动**
（核心抽成 `install_slot_core` / `release_slot_core` 两个只吃那张表的函数 ⇒ 这三格都有单测直接驱动生产码，
不必造整台 `AppState`）。`PeerSendGuard` 与群侧 `GroupFileDispatchGuard` 的所有权是**由抢占结果决定**的
（`HashSet::insert` 返 `false` 就构造不出守卫），所以它们本来就只可能释放自己取得的资源 —— 新 `FileSendGate` 沿用同一形状。

### 9.2 实际改动清单（文件 → 目的）

| 文件 | 这一批改了什么、为什么 |
|---|---|
| `src-tauri/src/state.rs` | 新增 1:1 在途闸门 `file_send_inflight` + `FileSendGate`（RAII，键 `file_peer_key`）；`file_send_cancels` 的值改成 `(Sender, 序号)`。⚠️ 这份集合**故意不进"清除数据"那趟**：集合里每个键都代表一个仍在跑的任务，清了它等于允许并发，而那个任务结束时还会去 `remove` 一个不属于它的键 |
| `src-tauri/src/network/file.rs` | `install_cancel_slot` 撞键返回 `CancelSlotInstall::AlreadyInFlight`（不顶替）；登记/归还拆成 `install_slot_core` / `release_slot_core`（可单测）；守卫 Drop 加序号校验；`SendFileError` 新增 `cancel_stage` + `cancelled_at`；新失败码 |
| `src-tauri/src/network/file/send.rs` | 登记点按新返回类型分流（撞键 = 可重试，**不是**取消）；六个取消臂各带阶段名；`send_finalize_rows` 读 `upsert_transfer` 的档位，被终态契约挡住时产 `code=TERMINAL_WRITE_REFUSED`，`finalize_send_accepted` 按这一码走 **Warn**（真 SQL 错仍是 Error） |
| `src-tauri/src/commands/files.rs` | `flush_pending_files` 每条 transfer 之前抢闸门（**排在 `mark_file_outbox_sending` 之前** ⇒ 跳过不消耗 attempts）；`[CANCELLED]` 那行日志带上 `stage=` |
| `src-tauri/src/network/transport/handle_share.rs` | 服务任务开头抢同一道闸（两个分支之前）；`已在途` 这一码不发 `file-failed`、不算取消也不算失败 |
| `src-tauri/src/network/file/relay_push.rs` | 撞键发新码；外层包装认码 ⇒ 不落 failed |
| `src-tauri/src/commands/group_file_dispatch.rs` | 撞键与它上面那道群闸同口径（跳过 + `Ok(())`） |
| `src-tauri/src/db/file_transfer.rs` | `upsert_transfer` 检查受影响行数，返回 `TransferUpsert` 五档（`Applied` / `Idempotent` / `BlockedByDone` / `BlockedByTombstone` / `Refused`）+ `refusal()`。SQL 的 `cancel_terminal = 0` **一字未动** |
| `src-tauri/src/network/file/receive.rs` | 只改一处 `Ok(())` → `Ok(_)`（签名变化的编译后果），接收侧判定一字未动 |
| `src-tauri/src/logging.rs` | 新失败码 `FILE_SEND_ALREADY_IN_FLIGHT` |
| `src-tauri/src/network/file_tests.rs` | 新判据册 `send_inflight_guard_tests`（6 条，对应任务书五、1/2/3/4/5/6/7/8/9 格） |
| `src-tauri/test-baseline.macos.txt` / `.windows.txt` | 各 +6 行（`--update` → `--sync-baselines` → 再 check 退 0） |

### 9.3 判据⑩ 修复前的读数（本机现跑，作为对照基线）

```
$ HOME=/tmp/sk-before node scripts/e2e-multi-instance.mjs --fault=sender-kill-mid
  ❌ 重启后的终局只有一个：两侧 done 且队列清零（不许停在中间态，也不许弃单）
      预期 B=done A=done outbox=0 / 实际 B=done A=cancelled outbox=0
      30.9s · 8 断言 · FAIL
退出码 1 ｜ 产物 test-results/run-2026-11-01T01-31-52-419Z
```

同一份 A 侧日志里那三行指纹（与 §3 那七次逐字同形）：同秒两条 `offer-sending`（`resume_from=0` 与 `262144`）
→ `[CANCELLED] transfer=… 用户取消，本次投递退出且不再重发` → 6 秒后 `[FILE] COMPLETED ok=true`。

### 9.4 四条变异反证（每条只改一处，红的是**该红的那一条**）

| 变异 | 注入点 | 结果 |
|---|---|---|
| A | `install_slot_core` 退回"无条件 insert 顶替在任者" | `duplicate_slot_install_leaves_the_first_receiver_untouched` **FAILED**，其余 5 条 ok，退 101 |
| B | `FileSendGate::try_acquire` 无视抢占结果、见键也放行 | `file_send_gate_admits_one_holder_per_key_and_frees_it_on_drop` **FAILED**，退 101 |
| C | `upsert_transfer` 退回"0 行也算 Applied" | `tombstone_blocks_a_late_done_and_reports_why` **FAILED**，退 101 |
| D | 删掉 `handle_share` 那道闸的调用（模拟"以后有人抄一份没过闸"） | 接线判据 **FAILED**，报错原文点名"ContentRequest 回发…必须恰好一次经过那道闸：0 次 = 没接上"，退 101 |

四处变异全部还原后：`cargo test --lib --features bluetooth -- send_inflight_guard_tests` → **6 passed / 0 failed，退 0**；
`grep -rn "MUTATION-" src/` → 零命中；`cargo fmt --check --all` → 退 0。

## 10. 收口读数（修复提交之后，全部现跑）

### 10.1 改调用点形状带出来的三处量具订正（同族第二课：改码不只是改码，还会撞坏读形状的东西）

`7a1d868b` 把三个登记点从 `let (a, b) = install_cancel_slot(…)` 改成 `match`、把登记/回收两处
`.lock()` 改成"把 Mutex 按引用交给 core helper"。语义没动，但**读形状的量具全跟着漂**：

| # | 坏在哪 | 谁先报的 | 订正 | 反证 |
|---|---|---|---|---|
| 1 | `群文件取消登记必须按收件人分键` 的注入锚点钉的是整条旧 `let … = file::install_cancel_slot(…);` | 全量层**第 14 步**起跑前核对，fail-fast（一轮测试都没跑） | 锚点改钉 `match file::install_cancel_slot(state, transfer_id, recipient)`，注入仍是 `recipient → transfer_id` | `verify-guards.py --only "群文件取消登记…"` 退 0（改坏 FAIL、还原逐字节一致） |
| 2 | `中继发送失败必须落 DB 终态` 的锚点前两行不再相邻（外层多了 `skipped_in_flight`） | 同上，第 14 步一起点名 | 锚点扩到整块；替换串从"删成空"改成 `let _ = (reason, skipped_in_flight);` ⇒ **变异串自己必须能编译**，否则 `expect_fail_hint` 不会出现在 stderr，红就落在"量具坏了"那一格 | `verify-guards.py --only "中继发送失败必须落 DB 终态"` 退 0（cargo 腿 62.9s，基线 50.5s） |
| 3 | 既有用例 `file_cancel_and_user_cancel_share_one_local_home` 数 `.file_send_cancels.lock()` == 4，实际读成 **2** | 护栏 runner 的**干净态基线**先抓到：`1362 passed / 1 failed`，于是它拒绝开始注入 | needle 从"带 `.lock()`"换成"碰字段的位置"（`.file_send_cancels`，四处仍是四处），命令层那一格顺带收紧成"不许碰这个字段" | 家内多一处 ⇒ `lib_file_tests.rs:969 left:5 right:4` 退 101；家外多一处 ⇒ `:976 left:1 right:0` 退 101；还原 ⇒ 退 0 且两份文件 `cmp` 逐字节 same |

⚠️ 第 3 条的形状值得单独记：它**不报"锚点找不到"**，它报的是一条像产品缺陷的测试红。原因是登记/回收
改成按引用收 Mutex（为了能在没有 `AppState` 的单测里直接驱动撞键），`.lock()` 只剩两个点亮处。
家还是一个家，needle 却读数减半 ⇒ 这类红的正确处置顺序是**先读断言的意图注释**，再决定换 needle
还是修代码；换完必须两个方向各注入一次，否则另一半仍是装饰。这条也说明：**"我只跑了新增的 6 条
用例"从来不是绿**（§9.4 那轮就没覆盖到这条既有用例）。

还有一处是隔壁会话补的（同一条改动撞坏的第三家）：`handle_share` 的失败帧现在包在
`if !cancelled && !in_flight {` 里，判据原来只钉 `if !cancelled {` ⇒ 取不到块体。订正在 `3590de78`，
并且加了一条正控：把"已在途"那一半砍掉时块体必须取不到。所以本轮撞坏的锚点**实际是 3 处，不是 2 处**。

### 10.2 门禁与版本（现跑）

```
npm run verify:full   → 退 0（27 步全 ✅，共 428.6s；02:09:57Z → 02:17:07Z）
  其中：cargo fmt --check --all ✅ · clippy -D warnings --all-targets ✅ · Rust 单测 ✅ 1363 passed / 0 failed / 3 ignored（12.75s）
        测试清单守卫（Rust）✅ 基线 1366 条全部在跑
        护栏注入锚点静态核对 ✅ · 护栏非空转（前端子集）✅ 209.0s · 移动端编译门禁（Android）✅ 37.7s
        Change Budget ✅ · CHANGELOG 结构 ✅ · 文档硬数字对账 ✅ · 文档引用对账 ✅
npm run version:check → 退 0；五处版本文件现读全部 5.15.95
python3 scripts/verify-guards.py --list → 退 0（起跑前核对：锚点存在且唯一）
```

本修复自己那笔的版本位是 **5.15.94**（`7a1d868b`，`Version-Bump: patch`，五处同步）；之后
`3590de78` 又把这轮的新失败码接进前端失败原因表并修了 clippy 1.99 的两条新规，顺带推到 5.15.95。
量具订正那笔是 `a12ba702`（只动护栏脚本与测试册 ⇒ `[plan]` 零影响豁免，不占版本位）。

### 10.3 判据⑩ 修复前后的完整对照（同一条命令、同一台机器、同一个 100 MB 载荷）

命令就是门禁那一步的原形状（`scripts/verify.mjs` 里 `--fault=sender-kill-mid` 那条 `cmd+args`）：

```
node scripts/e2e-multi-instance.mjs --fault=sender-kill-mid
```

⚠️ 任务书里点名的 `npm run test:e2e:sendkill` **在本仓不存在**（`npm run` 报 Missing script），
所以这里照抄的是门禁实际执行的那条命令，不是它的替身。三轮读数：

| 轮 | run id | 二进制 | verdict | 判据⑩ 那一格 | 断言 |
|---|---|---|---|---|---|
| 修复前（基线） | `2026-11-01T01-31-52-419Z` | 主仓 release（修复前源码所编） | **FAIL** | 预期 `B=done A=done outbox=0` / 实际 **`B=done A=cancelled outbox=0`** | 26 条里 1 红 |
| 修复后 | `2026-11-01T02-23-06-047Z` | 主仓 release（`7a1d868b`+订正之后重编，4m22s） | **PASS** | 预期 `B=done A=done outbox=0` / 实际 **`B=done A=done outbox=0`** | **26/26 全绿**（30.4s） |
| 反向实验 | `2026-11-01T02-24-03-353Z` | `/private/tmp/gosslan-sendkill-reverse/…`（撤掉两道防线后重编） | **FAIL** | 实际 **`B=done A=cancelled outbox=0`** | 26 条里 1 红（29.1s） |

修复后那一轮的 A 侧实例日志里，新加的闸门**在真链路上真的开过**（不是只在单测里）：

```
02:23:36 info [share] code=SEND_ALREADY_IN_FLIGHT transfer=e2e-k-2026-11-01T02-23-06-047Z-kitgzy
          peer=gosslan-130774038112e-i2 —— 该单已有在途发送任务（outbox 补发那一侧），本轮跳过
```

这一条同时钉住两个口径：ContentRequest 那一侧撞上了 outbox 补发已经占住的 `(transfer_id, peer)`，
**跳过而不是写终态**；而整轮照样 26/26 绿 ⇒ "跳过"没有把这一单变成弃单（重启续传那三条判据仍全过）。

### 10.4 反向实验（隔离工作区，证明判据⑩ 不是被改软的）

工作区 `/tmp/gosslan-sendkill-reverse`（`git worktree` 的 detached HEAD，`CARGO_TARGET_DIR` 也在那儿
⇒ 主仓的源码、产物、target 一个字节都没动；主仓 `git status` 在这两个文件上恒为 0）。撤的是**两道**防线，
各一处、按函数作用域定位（不是按全文文本 —— `inserted.then(|| Self {` 这个形状在
`GroupFileDispatchGuard` 里也有一条，第一版脚本就是被它撞出 `anchor count=2` 而整块没落盘，
差点拿一份**没变异的二进制**去跑"反向"）：

1. `state.rs::FileSendGate::try_acquire` ⇒ 无条件 `Some`（闸门失效，两个入口可以同时发同一单）；
2. `file.rs::install_slot_core` ⇒ 删掉撞键早退，回到 `HashMap::insert` 静默覆盖（顶掉前一个任务的 Sender）。

跑之前的两道自检（都是打印出来的机器值，不是"应该没问题"）：
`MUT_IN_SOURCE state.rs=1 file.rs=1`、`MUTATION_COMMIT_TS=1793499501 BINARY_TS=1793499785 FRESH=yes`
—— 二进制必须晚于那次撤防线的提交，否则跑的就是旧产物。

结果：判据⑩ 报红，形状与修复前基线**逐字相同**（`B=done A=cancelled outbox=0`），而且这一轮第一次
把"锁死层"说出了口——两处新诊断都在真链路上亮了：

```
02:24:32 info [file] [CANCELLED] transfer=e2e-k-2026-11-01T02-24-03-353Z-v4ogxr
          用户取消，本次投递退出且不再重发 stage=hash
02:24:33 warn [file] code=TERMINAL_WRITE_REFUSED stage=send-transfer-done
          transfer=e2e-k-2026-11-01T02-24-03-353Z-v4ogxr want=done current=cancelled
          reason=INV-P26 墓碑 cancel_terminal=1（用户/对端取消不许被晚到 attempt 改写）
```

⇒ `stage=hash` 是六格阶段名之一（假取消是在算摘要那一步被点亮的），
`TERMINAL_WRITE_REFUSED` 是过去**完全无声**的那一格（晚到的 `done` 被墓碑挡掉、0 行更新不留痕迹）。
判据⑩ 的期望值一个字没改，它现在既能证伪（撤防线 ⇒ 红）也能证真（装回去 ⇒ 绿）。

⚠️ 一条范围声明：反向实验证明了"闸门 + 不顶替"这两道**合起来**能消除缺陷，没有单独证明"只撤闸门"
也能复现 —— 只撤闸门时撞键保护仍会挡住顶替，那条链在第二环就断了。这不影响结论（缺陷的第一环
就是两个入口并发），但别把它读成"闸门单独就够"。

### 10.5 `verify:e2e` 整层读数（23 步）与那一步环境红的归因

```
npm run verify:e2e   → 退 1（22/23 步 ✅，共 690.4s；02:28:00Z → 02:39:31Z）
  第 15/23 步 = 判据⑩ 那条：✅ 38.7s，"多实例 E2E 全绿（26 条断言）"
  唯一红的一步 = 第 1 步 UI 运行时探针：0.1s 在起跑前自拒
      ❌ 环境：CDP 端口 9444 起跑前空闲 —— 预期"无人监听"/实际"已被占用"
```

那一格的红**不是代码**，是环境：占着 9444 的是一台 10-30 08:36 起跑、挂了 2 天的
headless Chrome for Testing（`lsof` 读到 PID 89833，profile 在 `/tmp/gosslan-probe-*`）。
探针故意把它判成红而不是接着跑 —— 连上那台读的是**旧构建**，是一条假绿通道。
本仓规矩是"进程管理只能针对本轮创建的准确 PID" ⇒ 没杀它，改按探针自己给的那条路换端口重跑：

```
GOSSLAN_PROBE_PORT=5299 GOSSLAN_PROBE_CDP=10444 node scripts/check-ui-runtime.mjs
  → 退 1；71 段、PASS 545 / FAIL 2 / UNSUPPORTED 3
  FAIL①「鼠标真点开、真命中条目也能选中」（下拉那一格）
  FAIL②「探针自己跑完了（没在半路抛错）」——页面里抛 TypeError:
        Cannot read properties of undefined (reading 'metadata') at getCurrentWindow
        ← src/components/ConversationList.vue:86
  UNSUPPORTED×3 是探针自己具名的"这台引擎量不到"（headless 不推动画时钟 /
        键盘原生滚动 / 惯性尾巴），本来就分开记账
```

两格 FAIL 都在前端 UI 探针段，与本任务改的 Rust 文件传输链无关，且这文件本轮没动过
（`git log -- src/components/ConversationList.vue` 最后一次是 10-29 的 `11e452db` 拖拽量纲那一笔）。
**只报不改**：那两格归前端那条线，本任务的范围里没有一项要求碰它，也不许为凑绿去动它。




