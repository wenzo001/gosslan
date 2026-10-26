# 闭环审计 · 矩阵（B1 进行中）

HEAD `6ca07ca5`。取值：`PASS` / `PARTIAL` / `FAIL` / `UNVERIFIED` / `BLOCKED` / `不适用(理由)` / `待审`。
**不适用 ≠ 通过；UNVERIFIED 与 BLOCKED 不计入通过率。** 每格必须有证据指针（`path` + 符号），行号会漂，落笔时已按该 HEAD 复核。

域轴说明：`domains.data.mjs` 的 11 域**不是完整文件分区**——`commands/` 是登记的装配层、`presentation` 覆盖整个 `src/`（见 findings 的 B1-K1）。因此这里的域是**业务语义分类**。

## 一、已走完六格的行

| FID | 动作 | 可执行 | 可打断 | 可恢复 | 可感知 | 可验证 | 可诊断可追溯 | 总判级 |
|---|---|---|---|---|---|---|---|---|
| F-MSG-014 | 取消一条还在排队的 1:1 消息 | PASS `chat.rs:98-126` 校验发起者/会话/自聊，结构化返回 `MessageCancelResult{outcome,delivered,remaining,was_written}` | PASS 终态由**数据库**裁定：`db::MessageCancelOutcome` 三态 `Cancelled/AlreadyDelivered/NotFound`（`chat.rs:136-155`）⇒ 取消与送达竞态有唯一赢家，且竞态输了说「已经传完」 | 待审（取消即终态；崩溃窗口未查） | PASS `cancelFeedback.ts` 六档人话 + `cancelFeedback.test.ts:31/35/42/49/53/57` 逐条钉 | PARTIAL 反馈层有测试；命令结局是否被 Rust 测试覆盖**未查** | **FAIL** 1:1 分支零日志（`chat.rs:181` `_ => {}`），`db/messages.rs:729/732` 静默返回 ⇒ **B1-F1** | **PARTIAL** |
| F-MSG-015 | 取消一条群消息（按成员台账取消剩余成员） | PASS `chat.rs:130-133` 走 `cancel_queued_group_message` | PASS `partial_cancelled` 是一等结局；`delivered/remaining` 按成员算 | 待审 | PASS `messageCancelNotice(res)` `TaskCenter.vue:168-174`，文案与气泡菜单共用一份 | PARTIAL 群侧取消有 `-lie` 轮次（`docs/acceptance/stability-smoke-matrix.md`，**新鲜度待比对**） | PASS `code=GROUP_CANCEL msg_id=… delivered=… remaining=…`（`chat.rs:171-178`）——**同函数内 1:1 与群不对称，正是 B1-F1 的证据** | **PARTIAL** |
| F-PRE-003 | 任务中心：行的生成与八个动作 | PASS 八个 `OperationAction` 全部映射到今天就存在的命令（`taskCenter.ts:44-64`），文件头第 3 条明确「动作只能是对已经存在的命令的引用——界面上一个点了什么都不会发生的按钮，比不给按钮更糟」 | PASS 取消下发动作真调命令（`TaskCenter.vue:142-159` `runAction` 一处 `busy` 门 + `try/catch/finally`，杜绝重复提交与卡住的按钮态） | 不适用(理由)：本层刻意**只出未完成任务**（`taskCenter.ts:19-21`），终态由气泡与 toast 说话；无历史视图是登记的边界而非缺失 | PASS 状态归一三档 `queued/running/blocked` + `blockedReason` 九个稳定短码，**未知码不上屏机器码**（`transferState.ts:62-82` 注释与实现一致） | PASS `taskCenter.test.ts`（含 `:341` `update_download` 行、`:349` 七档 phase 遍历） | **FAIL** 取消结局不留痕（并入 **B1-F1**）；另边界注释已过期（**B1-F2**） | **PARTIAL** |
| F-PLF-007 | 取消一次更新下载 | PASS `updater_cancel` 存在且被调用（`TaskCenter.vue:236-240`），取消后 `refreshUpdaterStatus()` 回真源补拉 | **PARTIAL** 不可逆边界**存在但无守卫**：`installing` 相位拒绝（`updater.rs:354-362`）依赖两处手抄字面量 ⇒ **B1-F3** | 不适用(理由)：更新器状态纯内存、检查与下载均用户主动，重启重走成本为一条命令 ⇒ 记 **B1-K2** 保留 | PASS 失败会抛进 `runAction` 的 `catch → toastError`（我第一轮误判为「无条件成功」，已撤回） | **FAIL** 唯一断言 `updater.rs:650-658` 是 `include_str!` + `contains` 文本匹配，**从不调用被测命令** ⇒ **B1-F3** | **FAIL** `code=` 词表无 `UPDATER_CANCEL` ⇒ 并入 **B1-F1** | **PARTIAL** |
| F-PRE-011 | 改设置（主题 / 语言 / 中继策略 / 绑定网卡 / 聊天样式） | PASS setter 先视觉生效再 `persistSoon()`（`useAppStore.ts:638-639`，连续拖动用去抖、非连续直写） | 不适用(理由)：去抖合并不是「取消」语义，`cancel` 丢弃待执行已由 `defer.test.ts:87` 钉住 | **PARTIAL** 时序风险已兜住（`:846-854` 两个 flush 出口 + `defer.test.ts:104`），但**写入真失败时无回滚**；且 flush 出口本身在 Tauri 窗口销毁下是否触发**无凭据** | **PARTIAL** 失败无任何提示；界面恒显「已应用」 | PARTIAL `defer.test.ts` 有凭据；「失败」这一路零测试 | **FAIL** `catch {}` 不记日志 ⇒ 诊断包与日志都查不到这一笔 ⇒ **B1-F4** | **PARTIAL** |
| F-MSG-020 | 群消息发送与成员级投递（含部分成功与迟到 ACK） | PASS 一条群消息按成员各一行（`db/group_offline_queue.rs:7` `insert_group_outbox`） | PASS `cancel_queued_group_message` 七种结局，按**台账行**而非消息状态判定，已 delivered 的行不动（`:103-117` 注释与枚举） | PASS 逐行过期：在线成员的行独立放弃、离线继续按 7 天保留（INV-P04）；**迟到 Ack = `LateApplied` 只记账、不许把 cancelled 提成 delivered**（`:48` + `cascade_tests.rs:1188-1203`；failed 行上的迟到 Ack 同理 `:1336-1339`）；delivered 墓碑在 cancelled/failed 时**故意保留**，用来挡住"整条重发"的误判（`:81-83`） | PASS `group-delivery-changed` 在 Applied / LateApplied / 过期三处都发（`handle_group.rs:82-92`），注释写明「少了这一条，气泡的『已收到 2/5』会停在旧数字」；部分成功有 `partial_cancelled` 与 `someDelivered` | PASS 具名 DB 测试（`cascade_tests`）+ `group` 37 / `groupcrash` 26 轮（**新鲜度待比对**） | PASS `OUTBOX_EXPIRED action=partial-failed delivered=… cancelled=…`、`OUTBOX_ROW_DROP_FAILED`、`OUTBOX_OFFLINE_HELD`、`GROUP_CANCEL`，且行改成 failed 而非删掉——**删掉就再也说不清"谁没收到"**（`outbox_sweep.rs:249`） | **PASS** |
| F-MSG-030 | 1:1 消息接收与回执（"已送达"= 对端已持久化） | PASS `insert_message_if_new` 三态裁决首次/重复，不先查后写（`handle_messaging.rs:109-131`） | 不适用(理由)：接收是被动事件，无取消语义；发送侧的取消是 F-MSG-014 | PASS 解密失败**既不落库也不 Ack** ⇒ 发送方 outbox 保留 ⇒ 补发时用最新公钥重新密封且 `msg_id` 不变（`:91-98`，含 P0-2 的原始故障形态记录）；重复投递仍回 Ack（`:63-71`） | PASS 发送端超时后收到 `message-failed`；接收端按设计不显示不可解密内容 | PASS `dispatch_tests` 覆盖去重三态；Gossip 并发下未读与 `message-received` 各只一次（`:110-111` 注释所指） | **PARTIAL** 重复投递有痕（`:66-69` 专门区分"没收到"与"收到了但 ACK 丢了"），但**解密失败零记录** ⇒ **B1-F5** | **PARTIAL** |
| F-MSG-040 | 撤回一条自己发的消息（1:1 与群共用同一命令） | PASS 判定走**单一** `protocol::recall_verdict(发送者, 我, kind, 会话, 对端, ts, now)`（`commands/chat.rs:345-353`），不是各处分头比；自聊直接拒；已撤回走幂等 `Ok(())`（`:358-360`） | 不适用(理由)：撤回本身是不可逆动作，不该有"取消撤回"；它的中断边界是"帧已发出即不可撤"，这一条要在文案里说实话 | **FAIL** 账本（`group_recalled_messages`）与物化（`UPDATE messages`）是**两笔独立写且都 `.ok()`**（`:373-374`），而幂等短路只看账本 ⇒ 账本成功/物化失败后重试也被短路，且**无启动对账** ⇒ 永久分裂 ⇒ **B1-F6** | PARTIAL 当次直接改缓存（`useChatStore.ts:2821-2827`）看起来成功；**重开会话走 DB 重查时正文复现** | PARTIAL `db/recalls.rs` 层有幂等/物化断言（`favorites_tests.rs:394-413`），但**命令层"两笔写失败"零测试** | **FAIL** 两处 `.ok()` 无任何日志 ⇒ **B1-F6** | **PARTIAL** |
| F-FIL-001 | 发送一个文件（分片 / 校验 / 进度 / 取消 / 重试上限 / 磁盘满） | PASS 入口命令 + 分片循环；重试耗尽以 `FileJobEnd::GiveUp` 表达（「重试耗尽 / 明确不可重试的错误（发送侧放弃）」，`db/file_transfer.rs:121-122`）；进度落点 250ms 节流防 IPC 风暴（`handle_file.rs:387`） | PASS `file_send_cancels` oneshot 槽位，chunk loop `select!` 到即走 `Cancelled` 出口；**用户取消与对端取消共用同一条终态收尾** `apply_local_cancel`（`commands/files.rs:776-800`），`by` 只进日志、不新增状态列；群文件按前缀点亮**所有**在途槽位 | PARTIAL 失败/超时/断链都能收口；**盘满这一格不自愈到"可续传"反而更糟** ⇒ **B2-F1** | **FAIL** 盘满时只说通用失败，说不出"空间不足"、也不提示"取消可释放空间" ⇒ **B2-F1** | PASS 10 组故障注入轮（dirty `.part`、崩溃后部分写、只读目录、改名失败、源缩小、同名多文件、100MB 中途停、发送方崩溃）+ 每轮 `-lie` 反向对照 | PARTIAL 有通用错误串与 `ACK_STAGE_CHUNK_ABORTED` 等阶段名；**无 disk_full 具名码** ⇒ **B2-F1** | **PARTIAL** |
| F-FIL-002 | 接收一个文件（`.part` 续传 / TTL / 失败 / 取消 / 配额） | PASS 准入有闸：`inbound_quota_verdict` 按并发数与声明大小判定，超限打 warn 并拒（`network/file/receive.rs:112-117`）；续传只从**分片边界**起（`content/policy.rs:28-32`，半片必须重传否则哈希对不齐） | PASS `cancel_receive` 摘接收器 + **删 `.part`**，并记 `Cancelled ⇒ Rejected`（终态不自动重取），注释写明若不这样会「取消了又自己开始」（`receive.rs:923-936`） | PASS 写失败即 `fail_receive` + **回否定确认**，让发送端立刻停（`handle_file.rs:416-442`，注释记着旧行为"判死但谁也不告诉"导致整份空灌 5 次）；`FileDone` 按轮次 `done_is_current` 丢掉上一轮残留帧；启动把在途 `active` 落 `failed`（`db/file_transfer.rs:107`） | PASS 失败/取消/部分成功都由气泡与任务中心说；进度 500ms 落库、250ms 上报 | PASS `kill`/`freeze`/`disk`/`resume`/`stall` 等轮次 + `logger_persists_to_file_and_rotates` 一族 | PARTIAL 错误分支有具名码（`ACK_STAGE_*`）；缺 disk_full 分类 ⇒ **B2-F1** | **PARTIAL** |
| F-FIL-003 | 群文件按成员投递与台账 | PASS 群文件是**另一本账**（`group_files` / `group_file_recipients`），不在 `file_transfers` 里硬插幽灵行（`db/file_transfer.rs:186-191` FUNC-03 记着旧缺陷） | PASS 取消时本机为发送方按成员落 `cancelled`（`files.rs` 第 4 步）；接收侧单独分支处理，注释写明不处理会出现「界面显示已取消而接收器还在写 `.part`」的谎话（`:790-797`） | PASS 群文件 ACK 账本**持久化**，进程重启后由 30s tick 的 `replay_pending_group_file_acks` 补落终态（`outbox_sweep.rs:106-109`：这就是"跨进程恢复"的出口）；`sending` 行 10min 回 pending、7d 收尾 | PASS 群文件投递摘要 + `group-delivery-changed`；`some_delivered` 表达部分成功 | PASS `gfile` 28 断言的轮次（**新鲜度待比对**）+ `groupcrash` | PASS `FILE_OUTBOX_*` / `GROUP_CANCEL_*` 一族具名码 | **PASS** |
| F-CNT-001 | 按 cid 取回内容（缩略图/图片等） | PASS 有 `content_transfers` 台账与 `retry_content` / `cancel_content` 两条命令 | PASS 取消失真调命令，前端按结果分支（`TaskCenter.vue:217-228` 看 outcome 才选 kind） | PASS **有界退避**：`MAX_CONTENT_RETRIES=8`，2/4/8/16/32/60/60/60s 封顶，超限落 `Rejected` 终态不再自动重试（`content/policy.rs:11-26,76-92`），注释给了 Android 后台耗电与 OOM 的真机理 | PASS 任务中心有进度与 `blockedReason`（`retry_exhausted` / `waiting_retry` / `no_source` 等九个稳定短码） | PASS `contentpull` 36 断言轮 + `utils/taskCenter.test.ts` | PARTIAL 有 `RETRY_EXHAUSTED` 一类短码，具名 `code=` 覆盖需在 B4 逐条对账 | **PARTIAL** |
| F-OBS-002 | 前后端契约双向对账（161 命令 / 事件面） | PASS 门面唯一：`IPC 只能从 src/api 门面走`（含「6 条命令在 api 上根本没有包装」的回归） | 不适用(理由)：这是判据不是用户操作 | 不适用(理由)：同上 | 不适用(理由)：同上 | **PASS（我实跑）** `node --test src/api/events.test.ts src/utils/mapContract.test.ts` ⇒ **EXIT=0，17/17**；另独立 `comm` 复算：注册 161 / 去重调用名 160，孤儿仅 `get_topology`（`events.test.ts:375` 自declare 无 UI 入口） | PASS 命令名与注册表逐条对账、「门面之下不许留没人引用的包装」都是现成判据 | **PASS** |
| F-OBS-003 | 诊断面：错误分类 / 上限 / 脱敏 / 访问控制 | 不适用(理由)：非用户动作 | 不适用(理由)：同上 | PASS 单文件 512 KB 轮转（`logging.rs:140/1070`），有真文件读写测试 `logger_persists_to_file_and_rotates:1715` | 部分：日志窗口有独立 entry（`logs.html` + `src/entries/logs.ts`），用户可查 | **已证**（上两行测试名 + 我跑通的对账族） | **PARTIAL** 具名 `code=` 共 **87** 个、日志调用 363 处（error 81 / warn 129 / info 153），覆盖面广；但**关键操作结局缺码**（B1-F1）；脱敏是形状级（`diagnostics.rs:19-22`，作者自述并保留文件名/大小以便查传输故障）⇒ 隐私与可查性是**登记过的取舍** | **PARTIAL** |

## 二、读数

现算（命令：`grep -c '^| F-' docs/notes/closedloop-matrix-2026-10-26.md` ⇒ **14**）：已走完六格 **14** 行，其中 **PASS 3**（群成员级投递、群文件成员台账、前后端契约对账）、**PARTIAL 11**、不适用若干；立案 **7** 条（**P2 五条** = B1-F3、B1-F4、B1-F5、B1-F6、B2-F1；**P3 两条** = B1-F1、B1-F2），保留为有意取舍 **3** 条（B1-K1…K3），撤回 **6** 条。计数复核：`grep -oE '^## (B1|B2)-F[0-9]+ · .*（P[0-3]' docs/notes/closedloop-findings-2026-10-26.md | grep -oE 'P[0-3]' | sort | uniq -c`。

**本文件的引用不受任何守卫保护**（实况见主报告「我自己的两处错」第 2 条：`check-doc-citations.mjs` 管 `file:line` 的那条只吃 `LIVE_DOCS` 那 8 份，`docs/notes/**` 不在内）。所以行号会随改动静默腐烂。二选一，**本审计不新建脚本**（按仓里「新判据先找现成的家」与自己编的规矩要撤）：

- 要它长期不腐烂 ⇒ 由你把主报告名加进 `check-doc-citations.mjs` 与 `check-doc-numbers.mjs` 的 `LIVE_DOCS`（各 1 行改动），代价是每次改代码都可能顶红快速层第 9 步；
- 不加 ⇒ 接受这是一份**带日期的快照**，与本仓对 `docs/notes/*-<日期>.md` 的既有立场一致，复核时按下方命令现验：

```bash
# 现验本矩阵引用的 path:line 是否还在真文件真行范围内（只读，逐条打印越界项）
node -e '
const fs=require("fs"),p=require("path");
const txt=fs.readFileSync("docs/notes/closedloop-matrix-2026-10-26.md","utf8");
const bad=[];
for(const m of txt.matchAll(/(?:^|[^\/\w])((?:src|scripts|docs)[\w\/.-]*?\.(?:rs|ts|vue|mjs|json|md)):(\d+)/g)){
  const f=p.resolve(m[1]); let n=0; try{n=fs.readFileSync(f,"utf8").split("\n").length}catch{bad.push(m[1]+" (文件不存在)");continue}
  if(+m[2]>n||+m[2]<1) bad.push(m[1]+":"+m[2]+" 超出 "+n+" 行");
}
console.log(bad.length?"✗ "+bad.length+" 处失效：\n  "+bad.join("\n  "):"✓ path:line 引用全部有效");
'
```

**这 8 行不等于 B1 审完。** B1 的分母是 161 条命令里挂到 messaging / presentation 的那一部分 + 392 个触发挂点去重后的动作数，已枚举出动作族（消息右键 17 项、气泡 12 项、会话菜单 3 项、好友菜单 3 项、头部导航 7 项、编辑器 6 项、任务中心 8 项、群命令 11 项、收藏 9 项、通道与缓存 9 项），下表是**剩余待审队列**。

## 三、B1 待审队列（每行注明缺哪一格）

| 族 | 待审内容 | 主要缺的证据 |
|---|---|---|
| 消息操作 | 引用 / 转发 / 收藏 / 强提醒 / 多选批量 / 复制保存图片文件 / 定位原消息 | 六格全缺；`MessageContextMenu` 17 个 emit 与 `MessageItem` 12 个 emit 的**后端落点**未逐条追 |
| 1:1 主链 | 发送、已读回执、撤回、重发 | 状态机转移表未画完；重发的二次确认与「取消与 ACK 竞态」在 Rust 侧的归属未读 |
| 群 | 建群 / 邀请 / 移除 / 移交群主 / 群公告 / 群待办 / 成员级投递与补发 | 部分成功与迟到 ACK 的终态归属；`some_delivered` 的表达是否等于「部分成功」 |
| 会话 | 删除会话 / 清空数据 / 置顶 / 历史边界 | 删除的不可逆边界与二次确认；清空后的跨窗口广播（`events.test.ts` 有「清空数据必须广播」这条测试，需确认覆盖面） |
| 呈现层 | 浮层返回键栈、`RouteView` 与 pane 双事实源、窄窗移动端 | 属你正在做的线（`6ca07ca5`/`39a7f216`/`c3b21b3c`），本轮只登记 |
| 设置 | 11 节各写入项的**分域**验收（F-PRE-011 只覆盖了共用的那条写入通道） | 每项设置失败是否都走同一 catch；哪些项影响网络行为需要更高要求 |
| 搜索 / 收藏 / 链接 | 命令与落库面 | 六格全缺 |

## 四、错误链表（六项标准里「可诊断」的专用视图）

| 错误路径 | 产生 | 分类记录 | 安全处理 | 用户反馈 | 诊断查询 | 恢复或终止 | 留痕 | 判级 |
|---|---|---|---|---|---|---|---|---|
| 1:1 消息取消竞态（已送达） | ✓ | **✗ 无码无日志** | ✓ DB 单一裁定 | ✓ 六档人话 | **✗** | ✓ | **✗** | FAIL（B1-F1） |
| 群消息取消 | ✓ | ✓ `GROUP_CANCEL` | ✓ 台账按成员 | ✓ | ✓ | ✓ | ✓ | PASS |
| 取消更新（installing） | ✓ | **✗ 文本断言代替行为断言** | 部分（字面量耦合） | ✓ | **✗** | ✓ 拒绝并保留现场 | **✗** | FAIL（B1-F3） |
| 设置落库失败 | ✓ | **✗ 零记录** | **✗ 界面不回滚** | **✗** | **✗** | ✗ 静默回旧值 | **✗** | FAIL（B1-F4） |
| 崩溃留下 sending/active 行 | ✓ | ✓ 四条启动对账各带具名失败码（`state.rs:1786/1799/1817/1832`，如 `OUTBOX_ORPHAN_RECOVERED` / `TRANSFER_INTERRUPTED_RECOVERED`） | ✓ | 部分（落 failed 后气泡说话） | ✓ | ✓ | ✓ | **PASS**（这是本仓做得最好的一族） |
| Worker 高亮失败 | ✓ | ✓ `onerror` 全量降级主线程（`codeHighlight.ts:62-69`） | ✓ | 不适用(理由)：降级对用户是无感的正确行为 | 待审 | ✓ | 待审 | 待审 |
