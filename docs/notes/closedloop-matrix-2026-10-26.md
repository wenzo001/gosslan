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
| F-PRE-011 | 改设置（主题 / 语言 / 中继策略 / 允许列表 / 通知开关 / 聊天样式） | PASS setter 先视觉生效再 `persistSoon()`（`useAppStore.ts:638-639`，连续拖动用去抖、非连续直写） | 不适用(理由)：去抖合并不是「取消」语义，`cancel` 丢弃待执行已由 `defer.test.ts:87` 钉住 | **PARTIAL** 时序风险已兜住（`:846-854` 两个 flush 出口 + `defer.test.ts:104`），但**写入真失败时无回滚**；且 flush 出口本身在 Tauri 窗口销毁下是否触发**无凭据** | **PARTIAL** 失败无任何提示；界面恒显「已应用」 | PARTIAL `defer.test.ts` 有凭据；「失败」这一路零测试 | **FAIL** `catch {}` 不记日志 ⇒ 诊断包与日志都查不到这一笔 ⇒ **B1-F4** | **PARTIAL** |
| F-MSG-020 | 群消息发送与成员级投递（含部分成功与迟到 ACK） | PASS 一条群消息按成员各一行（`db/group_offline_queue.rs:7` `insert_group_outbox`） | PASS `cancel_queued_group_message` 七种结局，按**台账行**而非消息状态判定，已 delivered 的行不动（`:103-117` 注释与枚举） | PASS 逐行过期：在线成员的行独立放弃、离线继续按 7 天保留（INV-P04）；**迟到 Ack = `LateApplied` 只记账、不许把 cancelled 提成 delivered**（`:48` + `cascade_tests.rs:1188-1203`；failed 行上的迟到 Ack 同理 `:1336-1339`）；delivered 墓碑在 cancelled/failed 时**故意保留**，用来挡住"整条重发"的误判（`:81-83`） | PASS `group-delivery-changed` 在 Applied / LateApplied / 过期三处都发（`handle_group.rs:82-92`），注释写明「少了这一条，气泡的『已收到 2/5』会停在旧数字」；部分成功有 `partial_cancelled` 与 `someDelivered` | PASS 具名 DB 测试（`cascade_tests`）+ `group` 37 / `groupcrash` 26 轮（**新鲜度待比对**） | PASS `OUTBOX_EXPIRED action=partial-failed delivered=… cancelled=…`、`OUTBOX_ROW_DROP_FAILED`、`OUTBOX_OFFLINE_HELD`、`GROUP_CANCEL`，且行改成 failed 而非删掉——**删掉就再也说不清"谁没收到"**（`outbox_sweep.rs:249`） | **PASS** |
| F-MSG-030 | 1:1 消息接收与回执（"已送达"= 对端已持久化） | PASS `insert_message_if_new` 三态裁决首次/重复，不先查后写（`handle_messaging.rs:109-131`） | 不适用(理由)：接收是被动事件，无取消语义；发送侧的取消是 F-MSG-014 | PASS 解密失败**既不落库也不 Ack** ⇒ 发送方 outbox 保留 ⇒ 补发时用最新公钥重新密封且 `msg_id` 不变（`:91-98`，含 P0-2 的原始故障形态记录）；重复投递仍回 Ack（`:63-71`） | PASS 发送端超时后收到 `message-failed`；接收端按设计不显示不可解密内容 | PASS `dispatch_tests` 覆盖去重三态；Gossip 并发下未读与 `message-received` 各只一次（`:110-111` 注释所指） | **PARTIAL** 重复投递有痕（`:66-69` 专门区分"没收到"与"收到了但 ACK 丢了"），但**解密失败零记录** ⇒ **B1-F5** | **PARTIAL** |
| F-MSG-040 | 撤回一条自己发的消息（1:1 与群共用同一命令） | PASS 判定走**单一** `protocol::recall_verdict(发送者, 我, kind, 会话, 对端, ts, now)`（`commands/chat.rs:345-353`），不是各处分头比；自聊直接拒；已撤回走幂等 `Ok(())`（`:358-360`） | 不适用(理由)：撤回本身是不可逆动作，不该有"取消撤回"；它的中断边界是"帧已发出即不可撤"，这一条要在文案里说实话 | **FAIL** 账本（`group_recalled_messages`）与物化（`UPDATE messages`）是**两笔独立写且都 `.ok()`**（`:373-374`），而幂等短路只看账本 ⇒ 账本成功/物化失败后重试也被短路，且**无启动对账** ⇒ 永久分裂 ⇒ **B1-F6** | PARTIAL 当次直接改缓存（`useChatStore.ts:2821-2827`）看起来成功；**重开会话走 DB 重查时正文复现** | PARTIAL `db/recalls.rs` 层有幂等/物化断言（`favorites_tests.rs:394-413`），但**命令层"两笔写失败"零测试** | **FAIL** 两处 `.ok()` 无任何日志 ⇒ **B1-F6** | **PARTIAL** |
| F-FIL-001 | 发送一个文件（分片 / 校验 / 进度 / 取消 / 重试上限 / 磁盘满） | PASS 入口命令 + 分片循环；重试耗尽以 `FileJobEnd::GiveUp` 表达（「重试耗尽 / 明确不可重试的错误（发送侧放弃）」，`db/file_transfer.rs:121-122`）；进度落点 250ms 节流防 IPC 风暴（`handle_file.rs:387`） | PASS `file_send_cancels` oneshot 槽位，chunk loop `select!` 到即走 `Cancelled` 出口；**用户取消与对端取消共用同一条终态收尾** `apply_local_cancel`（`commands/files.rs:776-800`），`by` 只进日志、不新增状态列；群文件按前缀点亮**所有**在途槽位 | PARTIAL 失败/超时/断链都能收口；**盘满这一格不自愈到"可续传"反而更糟** ⇒ **B2-F1** | **FAIL** 盘满时只说通用失败，说不出"空间不足"、也不提示"取消可释放空间" ⇒ **B2-F1** | PASS 10 组故障注入轮（dirty `.part`、崩溃后部分写、只读目录、改名失败、源缩小、同名多文件、100MB 中途停、发送方崩溃）+ 每轮 `-lie` 反向对照 | PARTIAL 有通用错误串与 `ACK_STAGE_CHUNK_ABORTED` 等阶段名；**无 disk_full 具名码** ⇒ **B2-F1** | **PARTIAL** |
| F-FIL-002 | 接收一个文件（`.part` 续传 / TTL / 失败 / 取消 / 配额） | PASS 准入有闸：`inbound_quota_verdict` 按并发数与声明大小判定，超限打 warn 并拒（`network/file/receive.rs:112-117`）；续传只从**分片边界**起（`content/policy.rs:28-32`，半片必须重传否则哈希对不齐） | PASS `cancel_receive` 摘接收器 + **删 `.part`**，并记 `Cancelled ⇒ Rejected`（终态不自动重取），注释写明若不这样会「取消了又自己开始」（`receive.rs:923-936`） | PASS 写失败即 `fail_receive` + **回否定确认**，让发送端立刻停（`handle_file.rs:416-442`，注释记着旧行为"判死但谁也不告诉"导致整份空灌 5 次）；`FileDone` 按轮次 `done_is_current` 丢掉上一轮残留帧；启动把在途 `active` 落 `failed`（`db/file_transfer.rs:107`） | PASS 失败/取消/部分成功都由气泡与任务中心说；进度 500ms 落库、250ms 上报 | PASS `kill`/`freeze`/`disk`/`resume`/`stall` 等轮次 + `logger_persists_to_file_and_rotates` 一族 | PARTIAL 错误分支有具名码（`ACK_STAGE_*`）；缺 disk_full 分类 ⇒ **B2-F1** | **PARTIAL** |
| F-FIL-003 | 群文件按成员投递与台账 | PASS 群文件是**另一本账**（`group_files` / `group_file_recipients`），不在 `file_transfers` 里硬插幽灵行（`db/file_transfer.rs:186-191` FUNC-03 记着旧缺陷） | PASS 取消时本机为发送方按成员落 `cancelled`（`files.rs` 第 4 步）；接收侧单独分支处理，注释写明不处理会出现「界面显示已取消而接收器还在写 `.part`」的谎话（`:790-797`） | PASS 群文件 ACK 账本**持久化**，进程重启后由 30s tick 的 `replay_pending_group_file_acks` 补落终态（`outbox_sweep.rs:106-109`：这就是"跨进程恢复"的出口）；`sending` 行 10min 回 pending、7d 收尾 | PASS 群文件投递摘要 + `group-delivery-changed`；`some_delivered` 表达部分成功 | PASS `gfile` 28 断言的轮次（**新鲜度待比对**）+ `groupcrash` | PASS `FILE_OUTBOX_*` / `GROUP_CANCEL_*` 一族具名码 | **PASS** |
| F-CNT-001 | 按 cid 取回内容（缩略图/图片等） | PASS 有 `content_transfers` 台账与 `retry_content` / `cancel_content` 两条命令 | PASS 取消失真调命令，前端按结果分支（`TaskCenter.vue:217-228` 看 outcome 才选 kind） | PASS **有界退避**：`MAX_CONTENT_RETRIES=8`，2/4/8/16/32/60/60/60s 封顶，超限落 `Rejected` 终态不再自动重试（`content/policy.rs:11-26,76-92`），注释给了 Android 后台耗电与 OOM 的真机理 | PASS 任务中心有进度与 `blockedReason`（`retry_exhausted` / `waiting_retry` / `no_source` 等九个稳定短码） | PASS `contentpull` 36 断言轮 + `utils/taskCenter.test.ts` | PARTIAL 有 `RETRY_EXHAUSTED` 一类短码，具名 `code=` 覆盖需在 B4 逐条对账 | **PARTIAL** |
| F-PST-001 | 数据库迁移 / 迁移前备份 / 降级拒绝 / 迁移失败 | PASS `run_migrations` 由 `user_version` 驱动，14 个步骤（`db.rs:265-284`） | PASS **降级直接拒绝**并明确「未执行任何迁移」（`db.rs:69-74`）；迁移前必须先做备份，备份失败就**在写任何东西之前停住**（`InitError::Backup` 文案 `:94-103`） | PASS DDL 单事务、失败整体回滚（`SchemaMigrate` 文案 `:104-114` + `migration_tests` 的 rollback 用例）；崩溃落在"步骤提交后、版本号前进前"这一窗口可被**幂等重跑**覆盖（各步都先 `column_exists` / `IF NOT EXISTS`）；空库旁有迁移备份时**不按首次安装生成新身份**（`state.rs:1763-1764`） | PASS 四种失败各有**有类型**的错误与 `code()`（`DB_DOWNGRADE` / `DB_BACKUP_FAILED` / `SCHEMA_MIGRATE_FAILED` / `DB_OPEN_FAILED`），文案双语、写明"原件未被删除/覆盖"、给出数据目录与日志目录、并让用户先复制数据目录（`db.rs:76-130`） | PASS `migration_tests` 覆盖回滚、降级拒绝、shape 恒等（`fresh_schema_alone_has_exactly_the_migrated_shape`）、以及「迁移加的列上的索引不许写进 SCHEMA」 | **PARTIAL** 4/14 步把「读 schema 失败」当跳过并继续前进版本，且迁移期只有 `eprintln!`（打包后不可见）、`BOOT_DB_STATE` 不记 `user_version` ⇒ **B3-F1** | **PARTIAL** |
| F-PST-002 | 缓存清理与 VACUUM | PASS 策略由 `retention_days`(3/7/30，None=永久) + `max_bytes` 组成，最旧优先（`storage/cache_cleaner.rs:55-92`） | PASS VACUUM 有**预算**且预算为 0 时中止并保持库完好（`vacuum.rs:113`、测试 `budget_zero_aborts_and_leaves_the_database_intact` / `an_abort_lands_close_to_the_budget`） | PASS 删除是**缓存语义**：文件没了由内容台账重新校验磁盘哈希决定是否重取（此条我**未逐行读到**，标待复验，不写成已证）；符号链接**显式跳过**（`walk_files`，`cache_cleaner.rs:101-110`，记着 2026-09-23 那条"跟随软链=永久删除"的数据丢失先例） | PASS 设置里有缓存策略与"立即清理"入口，清理结果回显（`channel.rs` 的 `get_cache_info` / `clean_cache_now` / `set_cache_policy`） | PASS 清理与 VACUUM 均有真库测试（`:192` `retention_removes_expired_only` 等） | PARTIAL 清理有 `CACHE_CLEAN_ALREADY_RUNNING` 一类码；细节覆盖待 B4 对账 | **PASS** |
| F-PST-003 | 崩溃后启动对账（上一进程残留） | PASS 启动跑四条：文件队列 `sending→pending`、孤儿 `sending→failed`、在途接收 `active→failed`、发送侧孤儿 `pending→failed`（`state.rs:1786/1799/1817/1832`） | 不适用(理由)：启动对账不是用户动作 | PASS 四条**各自带具名失败日志**，失败时明确写"可能仍显示发送中/接收中，需人工关注"（`state.rs:1792-1795/1808-1811/1823-1826`）；落 `failed` 而不是删行 | PASS 对账后的结果由气泡与任务中心照旧表达 | PASS 有 `startup_safety_tests` 与 `lib_startup_config_tests` | PASS `OUTBOX_ORPHAN_RECOVERED` / `TRANSFER_INTERRUPTED_RECOVERED` / `FILE_OUTBOX_RECOVERED` / `FILE_TRANSFER_ORPHAN_RECONCILED` 四个具名码，各带 count | **PASS** |
| F-OBS-004 | 单连接与取锁纪律（全局正确性机制） | PASS 全仓**单条** SQLite 连接（`state.rs:1063` 的 `DbLock`），`db_hold.rs:484-513` 有自守卫禁止退化回裸 `Mutex<Connection>` | 不适用(理由)：非用户动作 | PASS 阻塞池纪律（INV-P34）+ 四条启动对账都在锁外 emit | 不适用(理由)：非用户动作 | PASS `check-lock-scope.mjs` 五条判据（含"判不了就算 FAIL"）逐取锁点判，且有夹具自证 | **PARTIAL** 脚本自述盲区（`check-lock-scope.mjs:57-73`）：非 `emit*` 名字的跨函数 emit、`&dbc` 传参、改名逃离 `db*` 的锁、宏生成码、以及其余 ~55 把锁的争用对**全部不在视野**（属另一轮） | **PARTIAL** |
| F-PLF-008 | 更新链：检查 → 下载 → 校验 → 安装 → 重启（含取消） | PASS 六个命令都在注册表里（`updater.rs` 12 处命令属性）；取消后 `refreshUpdaterStatus()` 回真源补拉（`TaskCenter.vue:236-240`） | **PARTIAL** 取消在 `installing` 相位被拒（`updater.rs:354-362`），但这条**不可逆边界只有文本断言守着** ⇒ **B1-F3** | 不适用(理由)：更新器状态纯内存、无持久化（**B1-K2**），检查与下载都是用户主动动作，重启重走成本为一条命令 | PASS 失败会抛进 `runAction` 的 `catch → toastError`（`TaskCenter.vue:154-155`）；`InstallingPhase` 的 `Drop` 防止命令 future 被丢弃后相位永久停在 `installing`（`updater.rs:379-390`）——那会让取消永远被拒、界面永远转圈 | PASS `updaterManifest.test.ts` 断言每个平台条目都带签名；`install_phase_is_not_cancellable` 是文本断言（见 B1-F3） | **PARTIAL** `code=` 只有 `UPDATER_DOWNGRADE_BLOCKED` / `UPDATER_INSTALL_ABORTED` / `UPDATER_INSTALL_FAILED`，取消与下载失败无码 ⇒ 并入 **B1-F1** | **PARTIAL** |
| F-OBS-005 | 更新包完整性与签名 | PASS 由 `tauri-plugin-updater 2.14` 原生校验（`src-tauri/Cargo.toml:92`） | 不适用(理由)：非用户动作 | 不适用(理由)：同上 | PASS 签名类失败被单独归类并成人话（`src/updater/service.ts:71` 把 `签名/signature/verify` 归成一档） | PASS 三重凭据：① `tauri.conf.json` 的 `plugins.updater.pubkey`（minisign 公钥）与 `latest.json` 端点；② `scripts/updaterManifest.test.ts:38` 断言每个平台 `signature.length > 20`；③ CI 的 tag-only preflight 逐项校验私钥（长度 348、base64 合法、以 `untrusted comment:` 开头、私钥与密码配套），错一样就 `::error` 并停（`.github/workflows/build-macos.yml:54-93`） | PASS 失败分类到「签名」这一档后有专门文案 | **PASS** |
| F-IDL-001 | 好友公钥的学习、轮换与安全码核验 | PASS `update_friend_pubkeys`（只填空）/ `replace_friend_pubkeys`（显式确认后覆盖）/ `get_safety_number` 三条命令都在注册表里 | 不适用(理由)：密钥接受/拒绝不是「取消」语义；用户拒绝的手段是不同步并删好友 | PASS 只填空的 `COALESCE` 写法令一次伪造广播最多抢填一次而**不能永久改写**（`db/friends.rs:40-63` 的理由成立）；轮换需用户显式确认 + Hello 自验签（`:65-80`）；代价是「错钥匙会一直错到删好友」——**这是有意的**，不是缺陷 | PASS 新候选会登记为 `PendingKeyRotation` 并 emit `friend-key-changed`，只对好友生效、同候选去重（`network/transport/peer_registry.rs:39-51`；`lib_friend_identity_tests.rs:423-429` 有断言），前端弹「同步新密钥 / 删除好友」横幅（`src/stores/useChatStore.ts:150`） | PASS `lib_friend_identity_tests` 有源码断言族、`peer_state_tests.rs:47` 钉住 peers→friends 的回退顺序 | PARTIAL 换钥有事件但无具名 `code=`；**而分叉窗口内的解密失败完全无记录**（并入 B1-F5）⇒ 分叉本身另有残余见 **B1-K4** | **PARTIAL** |
| F-PST-004 | 删除会话 / 清除聊天数据 | PASS 两个命令都在注册表；删会话有**二次确认弹窗**（`src/components/ConversationList.vue:318-328` 的 `confirmDeleteConv` 读 `pendingDelete`），成功/失败都有 toast | 不适用(理由)：删除是原子的用户意图；它的中断处理是**先取消在途发送**（`commands/chat.rs:1383-1386`） | PASS 单会话：乐观移除**带回滚**（`src/stores/useChatStore.ts:2113-2132`，失败 `throw e` 恢复会话行与消息缓存）；群会话写**删除边界**（逻辑时钟，不是墙上时钟）使他人历史重放不得回灌（`chat.rs:1390-1394`） | PASS 成功 toast 带会话名；清空数据有删除行数日志（`favorites.rs:560-563`），且**故意不用大事务**以免握锁数秒把设置窗口卡死（`:523-527`） | PARTIAL 「清空数据必须广播」有现成测试（`src/api/events.test.ts`）；**删除的级联范围无测试** ⇒ **B3-F2** | PARTIAL 删除成功**无具名码**（并入 B1-F1 族）；清空只有一句 info、无 `code=`；两张台账表不被清 ⇒ **B3-F2** | **PARTIAL** |
| F-MSG-050 | 已读回执（1:1 与群）与未读清零 | PASS `mark_read` 把 6 段 db 读写各自进阻塞池，网络等待留在锁外（`commands/chat.rs:1246-1248` 记着 R-18 与 A-14 的教训） | 不适用(理由)：已读是单向通知，没有取消语义；重复调用由 `upsert_pending_read` 的 **max 语义**吸收 | PASS `pending_reads` **持久化**（`:1293-1300` 注释明写「进程重启后内存丢失时可从 DB 恢复」）；`try_send` 不论成败都保留 pending（`:1281-1287` 写明「Ok 只代表进了 mpsc，不代表 write_frame 成功」）；自聊直接短路，避免留一条永远排不掉的回执（`:1260-1265`） | PASS 发送方气泡回执随 `read_receipts` 与事件更新；未读清零同步在库与界面 | PASS `read_receipt.rs` + `read_receipt_tests` 覆盖协议侧；**未读徽标的上屏本轮拿到真渲染读数**：`--only=convbadge` ⇒ **9/9 绿**，含一条反向对照「三态全清时名字恰好等于群名、零枚徽标（证明①不是恒过）」 | PARTIAL 持久化那笔 `upsert_pending_read(...).ok()` 会吞失败 ⇒ 重启后丢一条已读；并入 **B4-F1** | **PARTIAL** |
| F-PRS-001 | 节点发现、启停与连接/重连 | PASS `start_network` / `stop_network` / `set_channel_enabled` 等命令在注册表；启停返回**新的运行状态快照**（`src/api/index.ts:106-110` 注释：发起窗口零额外 IPC） | PASS `network::start` 那批连接/监听任务有**显式 `stop()` + `await_tasks()`** 生命周期（`worker_supervisor.rs:13-14` 正是以"重启会把用户关掉的局域网又弄起来"为由把它们排除在监督外）；`transport` 用 `watch` 关闭并 `break` 退出 | PASS 心跳 5s、连接超时 5s、握手超时 5s；局域网自启退避**有测试**（`network/mod.rs:484` `lan_autostart_backoff_grows_then_caps_at_thirty_seconds`） | PASS 运行状态只有**一个快照** + 一个带载荷的事件（`src/api/events.test.ts` 有同名回归「运行状态只能有一个快照 + 一个带载荷的事件」） | PASS 有 `lanoff` 26 轮（关局域网后行为）+ `dial`/`handshake`/`listen` 测试族；**真实多网卡组合 BLOCKED**（本机无法构造） | PARTIAL 掉线/不可达有 `OUTBOX_OFFLINE_HELD` 一类具名码；链路侧码需在 B4 全量对账 | **PARTIAL** |
| F-OBS-006 | 常驻后台任务的监督（worker supervisor） | 不适用(理由)：非用户动作 | 不适用(理由)：非用户动作 | PASS 每 10s 判 `is_finished`、同一 worker 重启上限 `MAX_RESTARTS`，超限只留 `WORKER_GIVEUP` 并要求重启应用（`src-tauri/src/worker_supervisor.rs:18-20`）；`verdict()` 是纯函数（`:85-86`），名单单一事实源 `RESIDENT_WORKERS`（`lib.rs:463` 一处注册） | PARTIAL 用户看不到这一层；只有日志/诊断包可查——这与"界面一切正常、没有任何信号"的原始缺陷相比已是**有信号**，但信号不在界面上 | PASS `verdict` 纯函数 + 源码断言钉住 5 个启动点（`:325-329`） | PASS `WORKER_GIVEUP` + error 行；且它防备的正是"循环体 return/break"那一格 | **PARTIAL** 名单只有 5 个，第 6 个常驻循环（每小时 `.part`/中继/停滞接收器清扫）既不在名单、也不在"刻意不碰"的登记里 ⇒ **B4-F2** | **PARTIAL** |
| F-RTG-002 | 中继转发授权与会合（跨网段/跨中继） | PASS 四条策略 `off` / `friends` / `allowlist` / `all`，默认 `all` 是为了**不改变传播语义**（`src-tauri/src/mesh/relay_policy.rs:1-17` 写明理由并落 ADR-0016）；三条判据（目标不转发 / TTL / 授权）收在纯函数 `should_forward` 里 | 不适用(理由)：转发是**逐信封**判定，停用即策略改 `off`；没有「取消某一封信」的语义 | PASS 会合占空比被钉成**两条不等式用例**（`network/transport/relay.rs:550` `relay_window_covers_round_period`）：① 窗口 ≥ 2×轮周期（否则两端相位互补时每一轮都错开、永久配不上）；② 窗口 +5 < 服务器 `WAIT_TIMEOUT_MS`(30s)（否则服务器主动关闭会被读成 EOF，被归类成口令/版本不匹配的**假指控**）。两条都写清了失败形态 | PASS 设置里可选策略；`relay.connected` 进运行快照；N 中继的计数曾被 `file_relay.rs:11-17` 记录为**永远 0**（读的是已删的 `active_sends`），现改为数 `path_kind == Relay` 的活跃链路 ⇒ 界面那句从此是真话 | PASS `should_forward` 有 **12** 个真值表用例（`relay_policy.rs:213-481`）+ 占空比用例 + `relay_tests` / `route_tests` | PARTIAL **relay/mesh 家族 0 个具名 `code=`**（实测 grep 为空），只有 3 处自由文本日志；而 `Rejected`（口令/版本不匹配）与超时恰恰是「为什么连不上」最常要查的 ⇒ 与 B1-F1 同族，此处只登记不另立案 | **PARTIAL** |
| F-PLF-009 | 平台外壳：托盘 / 系统通知 / 退出与重启 | PASS 托盘四项（显示 / 免打扰 / 重启 / 退出，`src-tauri/src/tray.rs:434-520`）+ macOS 菜单经 `menu://*` 桥到前端（`src/api/index.ts:992-1009`） | 不适用(理由)：托盘与通知不是取消语义；「退出」是不可逆动作，其边界由 `app.exit(0)` 定义 | PASS 退出顺序有注释修正过：原实现是「spawn 里 await `network::stop` 之后才 exit」，现正常路径仍走 `app.exit(0)`（让插件有机会保存窗口状态），另有守卫覆盖 exit 收尾（`tray.rs:476-491`）；重启走 `process::restart` 一族 | **FAIL** 通知**从不查询系统权限**（全仓 `is_permission_granted` 零命中），且发送失败多为 `let _ =` ⇒ 系统关掉通知后开关仍是「开」、用户收不到也查不到 ⇒ **B4-F3** | PASS `lib_startup_config_tests.rs:251-263` 钉住「渲染层完全卡死时必须发系统通知」与 `notify_enabled` 同键；`lib_window_tests.rs:994` 同类断言 | PARTIAL 通知失败无具名码、无记录 ⇒ **B4-F3**；托盘/退出侧有日志但无码 | **PARTIAL** |
| F-PRE-012 | 设置 11 节分域验收（profile / general / notifications / appearance / network / files / storage / storageFiles / security / about / reset） | PASS 11 节都在 `src/router/settings.ts` 的 `SETTINGS_SECTIONS` 里且深链可达；**每节的写入通道逐个点过**：网络用 `app.setChannelEnabled` / `setRelayPolicy` / `toggleRelayAllowlist` / `startNetwork` + `api.*`（失败走 `toastError`）；外观/语言/中继开关走共用 `persistSettings`；文件/存储用专用命令（`setDownloadsDir` / `setCachePolicy` / `cleanCacheNow` / `exportChatText`）；重置用 `app.resetDefaults` + `chat.clearAllData`，**各有 App 内确认框**且自己接住异常（`ResetSection.vue:29-40,49-56` 记着"原实现用 window.confirm，样式与 App 脱节"） | 不适用(理由)：设置项不是可中断的长任务 | PARTIAL 共用通道失败静默（**B1-F4**）；专用命令会把错误上屏 | PARTIAL 同上——外观/语言/中继这几项失败时界面仍显"已应用"；重置/清空有二次确认 | PASS 三条现成回归都在 `src/api/events.test.ts`：「设置变更事件两端都在」「每个改设置的后端命令必须传 `origin`」「`settingsDirty` 回灌守卫不得复活」（我跑过该文件，17/17） | PARTIAL 共用通道无记录 ⇒ **B1-F4** | **PARTIAL** |
| F-GRP-001 | 群管理：建群 / 邀请 / 移除成员 / 移交群主 / 改名 / 退群 | PASS 六个命令都在注册表；**出站授权**逐个读过：`group_add_member` / `group_remove_member` / `transfer_group_creator` / `rename_group` 都判 `group.creator != s.device_id` 并各自给中文原因（`commands/groups.rs:190-192` 等） | 不适用(理由)：群管理是即时命令，没有可中断的长任务；被移出的成员由 `GroupMemberRemoved` 帧告知 | PASS **入站也授权**：`handle_group_rename` 里 `g.creator == from` 才接受并注明「只接受群创建者的改名」（`network/transport/group_membership.rs:6-20`），外层还有 `from != peer_id` 的防冒充判据（`handle_group.rs:129-131`）；成员变化后 `resend_group_key_to` 重发群密钥 | PASS `groups-updated` 事件刷新界面；被移出/群主变更各有独立帧（`GroupMemberRemoved` / `GroupCreatorChanged` / `GroupMemberLeft`） | PARTIAL 群路由/会话有测试族（`route_tests` / `group_tests`），但**「谁能改群名」这类授权断言本轮未见具名用例**（我读的是实现，不是测试） | PARTIAL 改名后 `db::rename_group(...).ok()` 吞掉写失败（并入 B4-F1 族）；群管理路径无具名 `code=` | **PARTIAL** |
| F-FIL-004 | 共享目录浏览与下载（含中继兜底） | PASS `ShareTreeRequest/Response` + `ShareFileRequest` 两个方向都在注册表；**服务方双好友判定**：既要求「声称的 requester 是我好友」又要求「提出这条链路的对端也是我好友」（`network/transport/handle_share.rs:303-312`，注释记着"`from` 自报可伪造"）；请求方无链路时会尝试中继，**没有任何邻居接住就返回 Err**（`commands/share.rs:199-206`，注释记着旧实现 A1：返回 Ok、界面留一条"你正在下载"而请求从未离开本机） | 不适用(理由)：请求本身是即时帧；真正的传输阶段走标准文件通道，取消归 `cancel_file_transfer`（F-FIL-001/002） | **PARTIAL** 请求发出后若对端始终不推流，聊天里那句「你正在下载…」不会被收回（请求侧无 pending/超时）；但**没有卡住的进度条**——任务中心只列真实传输 → 属文案级瑕疵 | PASS 服务方那条提示用「请求下载」而**不是**「下载了」，理由写在 `handle_share.rs:329-331`：此刻尚无任何成功证据，写成完成时态就是一句可能被证伪的陈述 | PASS **路径安全有三道**：① 服务方 `canonicalize` 两侧后判 `starts_with` + `is_file()`（`:320-325`，这正是"词法前缀不是沙箱"的正解）；② 接收侧文件名一律过 `safe_file_name`（只允许 basename，拒 `/`、`\\`、`.`、`..`、NUL，`file/share_walk.rs:307-316`）；③ `transfer_id` 也被白名单化 `[A-Za-z0-9_-]{1,64}`，注释写明它会被拼进落盘路径且 `File::create` 会截断（`:318-335`）。有穿越用例（`commands/logs_tests.rs:765`） | PARTIAL share 侧无具名 `code=`（并入 B1-F1 族），但 A1 那类"假成功"已被明确修掉 | **PARTIAL** |
| F-OBS-007 | 日志面（19 条）与辅助窗口生命周期 | PASS 读/清/位置/上次退出/诊断包/前端心跳与慢操作上报都在注册表；**开窗命令全部 `#[tauri::command(async)]`**（`commands/logs.rs:662/741/808/1114/1158/1275`） | 不适用(理由)：读日志与开窗都不是可中断的长任务 | PASS 开窗走**单一入口** `ensure_aux_window`（单例 + 串行创建，注释记着"连点会出怪事"的来源）；常驻/销毁逐窗登记（常驻＝群任务/预览/外链，销毁＝设置/日志）；`decorate_aux_window` **只把 AppKit 那几行投回主线程**、命令本身不跑主线程（`:240-261` 同时解释了 macOS 的 AppKit 约束与 Windows「建 WebView2 会在调用线程泵消息 ⇒ IPC 重入 ⇒ 主线程永久挂死」，并记下 2026-09-20 真机"点设置整个界面无响应只能杀进程"）；`run_on_main_thread` 只入队，而 CreateWindow 走同一队列**且先入队** ⇒ 拿到 `ns_window()` 时不可能为空 | PASS 日志窗口 + `get_log_locations` 给出三条真实路径（多实例 `gosslan-1.log`），注释写明"前端不许自己拼——差一个数字就是别人的日志"；诊断包导出回报 `redactions` 次数 | PASS `logs_tests` 有路径穿越与 `sanitize_file_name` 用例（`:765`）；`lib_window_tests` 有窗口源码断言 | PARTIAL `logger.clear()` 删内存环与两份日志文件**但不写任何标记**（`logging.rs:929-936`）⇒ 若用户清过日志再来报障，支持侧看不出"曾清空"；崩溃现场文件**不参与轮转也不被 clear 删除**（`:944-953`），这一点是好的 | **PARTIAL** |
| F-OBS-008 | 外链（导入 / 导出 / 清理） | PASS 6 条命令在注册表；URL 导入由**后端**拉取（注释写明是为了避开 WebView 的 CORS），导入前 `validate_external_url` 只放 http/https 且 host 非空（`commands/external_links.rs:41-48`，注释记着"等于把一条本机攻击面交给用户随手粘贴的字符串"） | 不适用(理由)：一次拉取，10s 超时就是它的中断边界 | PASS 三重收口：**10s 超时** + **重定向限 3** + **流式累计截断**（`content_length` 预检之外，还有逐块累加、超 256KB 立即中止，注释写明"不能先 `bytes()` 再量大小 —— 没有 Content-Length 的服务端可以先把几个 GB 拉进内存"）；上限：20 条链接 / 32 字符名 / 256KB 导入 | PASS 所有失败都是具体中文 Err（HTTP 状态码、超限多少、非 UTF-8）；导出回报真实路径供移动端交给系统保存框 | PASS 删除闸是**纯函数** `is_export_artifact_path`（`external_links.rs:297-308`）：要求**父目录恰好等于** `cache/exports` + 文件名形状 + 不含 `..`，并明确写下"不能用 `Path::starts_with` 当安全闸：`cache/exports/../../x` 也会通过" | PARTIAL 无具名 `code=`（并入 B1-F1 族），但错误文案本身可读 | **PARTIAL** |
| F-PLF-010 | 文件另存 / 复制 / 剪贴板 / 预览（helpers 面） | PASS 7 条命令在注册表；`save_media_as` 的 `destination` 来自用户从系统另存框选出的完整路径，**不是**把远端文件名拼进去 | 不适用(理由)：单次文件操作；大文件另存进阻塞池 | PASS msg→本地路径的解析**只有一处** `resolve_media_path`（`commands/helpers.rs:159-163` 明写"安全边界必须只有一处"），并给出 `Present` / `Unknown` / `Gone` 三态、各自返回具体 Err；Android `content://` 复用 `copy_file` 已验证的 ContentResolver 分支 | PASS 失败都是具体 Err；`media_present` 对未知行返回 true（已登记的宽松口径） | PARTIAL 本轮读到实现，**未读到针对"单一解析器"的断言测试** ⇒ 标待补 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-MSG-001 | 发送一条消息（text/code/file/merge/reaction/remind/remind_ack/recall/render） | PASS 自聊在最前面分流（下面的好友/公钥/加密/outbox 对自聊都不成立）；kind 白名单 + **逐类载荷预校验**（merge/reaction/remind/remind_ack/recall/render 各调 `parse_*_payload`，注释：畸形载荷不该变成对端一条折不出来的事件）；`remind`/`remind_ack`/`recall`/`render` 还要**目标真实性**（否则对方点开通知会定位到幽灵消息）；好友检查在公钥查找之前 | 不适用(理由)：发送是单次提交；"还没送出去时改主意"归 F-MSG-014（排队中取消）与 F-FIL-001（文件） | PASS **消息行 + 离线队列在同一 `unchecked_transaction`**（`db/messages.rs:47-73`）⇒ 发送侧"有消息没队列"的崩溃窗口是关的；`msg_id` 取自 Gossip 信封、本地/Gossip/outbox **三处同一个** ⇒ 接收方跨路径去重（防建链竞态窗口的重复投递）；**先入队再投递**（INV-003），注释记着旧顺序下心跳 `flush_outbox` 的竞态 | PASS 对端能力位不足时**不发**并给可照做的人话（`kind_blocked_hint`），且区分"不知道（多半只是离线）"与"它自己声明过不支持"，避免把离线说成"版本较旧"的**假指控**；静默事件（表情回应等）不顶会话、不改预览，注释写明漏掉的症状是"回个表情把会话顶到最前、摘要变成一段 JSON" | PASS `dm_required_features` / `dm_allowed_by_features` 是**唯一**判据（1:1 侧额外要求对端具备"能吃任意 wire kind"的声明位）；`dispatch_tests` + `outbox_tests` + default/poison 轮覆盖 | PARTIAL 失败都以具体 Err 返回；但 `sending→sent→delivered→read` 的**转移本身没有具名码**（并入 B1-F1 族） | **PARTIAL** |
| F-MSG-060 | 首屏读取与历史分页（`get_messages` / `get_latest_messages` / `list_conversations`） | PASS 三处都在 `spawn_blocking` 里（注释：标了 `(async)` 的同步 fn 仍跑在 tokio worker 上，留在 worker 等锁就是拿稀缺资源换排队位置）；`limit` 夹到 1..500、`offset` 取非负 | 不适用(理由)：纯读操作 | PASS 只读，不产生需要恢复的状态；一次失败在下次成功读时自愈 | **FAIL** 三处都是 `db::…().unwrap_or_default()` ⇒ 读失败变成**空页/空列表**；会话列表整个消失时最像「数据被清空了」⇒ **B1-F7** | PARTIAL messages 读取有 DB 层用例，但「失败必须变 Err 而不是空」没有判据（B1-F7 要补） | **FAIL** 错误对象被 `unwrap_or_default` 丢弃，无日志、无事件 ⇒ **B1-F7** | **PARTIAL** |
| F-FRN-001 | 好友申请：发送 / 同意 / 拒绝 / 删除 | PASS 发送侧先挡「空 / 自己」；**同意路径只有一份实现**（`commands/mobile_picker.rs:363-371` 说明两个入口都要走它，否则会造出「我这儿有他、他那儿没我」的**单边好友关系**——用户 2026-09-12 实测过） | 不适用(理由)：申请与同意都是即时消息，没有「取消」语义；拒绝即终止 | PASS **先登记再发**：好友申请没有回执，链路一抖就静默丢、而界面照样显示「已发送」（2026-09-12 真机复现过）⇒ 登记后由建链/Hello 补全时重发；`or_insert` 保证连点几次**不重置**补发间隔；`FriendAccept` 也有**唯一**发送实现 + `flush_pending_friend_accept` 重发路径（注释："两处各写一份的话，重发的那份迟早会漏掉定向/重签/加密"） | PASS **缺对端公钥时绝不静默**：warn 一行 + 返回 Err，并写明后果（本地已加好友但回执发不出 ⇒ 单边成立）；同意/拒绝后清 pending | PARTIAL `lib_friend_identity_tests` 有源码断言族；但**跨进程好友关系始终没有 E2E 轮次**（早期矩阵就记着「no J4 proof」）⇒ 这条的"可验证"仍缺最高一档 | PARTIAL 有 warn 但**无具名 `code=`**（并入 B1-F1 族） | **PARTIAL** |
| F-GRP-002 | 群公告与群任务（创建 / 改状态 / 改结构 / 归档 / 删除 / 公告列表） | PASS 标题长度、状态白名单、**指派人必须是群成员**（`check_todo_assignees`）都校验；优先级/类型只在**给了值**时校验并覆盖，只改状态不会把优先级重置成「常规」 | 不适用(理由)：都是即时定义消息（LWW per `todo_id`），没有取消语义；删除用显式 `deleted` 标志 | PASS **鉴权三档**（`commands/group_files.rs:463-477`）：todo 创建者或群主全权；**被指派人只能改状态与指派人、不能改结构**（标题/描述/图片/删除）；其余无权。**`creator` 与 `done_at` 都不从参数来**：前者服务端从库里最新定义回填（否则传别人的 creator 就能改别人的任务），后者在**首次**完成时记权威时间戳、重复保存沿用原值（否则改个标题就重置 7 天归档计时，且客户端可伪造完成时间绕过自动归档）；LWW 语义使乱序到达也收敛 | PASS 群任务有独立窗口与任务板；徽标**只由前端 `utils/todos.ts::foldTodos` 折叠一份**，后端只回 `kind IN ('todo','todo_update')` 的原始行（注释：用内存缓存算徽标会让「没缓存的群没有数字」，那是假状态） | PARTIAL 有 `todos` 单测与群轮次；但**公告与群待办的跨实例投递仍零证据**（早期探测结论，我本轮未补轮次） | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-MSG-070 | 聊天记录搜索（关键词 / 发送者 / 时间范围） | PASS 关键词按字符截断、空词直接返回空；`sender`/`since`/`until` 都是可选过滤；命中数与会话数各有上限（`SEARCH_HISTORY_MAX_HITS` / `MAX_CONVS`） | 不适用(理由)：只读查询 | PASS **没有 SQL 注入面**：`?1..?5` 全参数化，唯一的插值是从编译期 `WIRE_KINDS` 派生并逐项加引号的 kind 清单（`protocol.rs:552-560`），不是用户输入；`escape_like` 依次转义 `\\`、`%`、`_`（`db/messages.rs:1291-1295`）⇒ 用户输入的 `%`/`_` 是字面量而不是通配 | PASS 结果按 `ts DESC` 分组，组内与左栏顺序一致；元数据批量预取（旧形状 50 会话 × 60 命中 ≈ 3000 次锁往返，注释记着） | PASS **范围钉在「仍在会话列表里的会话」**上（`conv_id IN (SELECT id FROM conversations)`），注释写明：删除级联收口之前入库的孤儿历史不该出现在搜索里——「点又点不开，还挤占共 N 条」；`system` 与静默类（表情回应/撤回）默认不可搜 | PARTIAL 有 `chatSearch*.test.ts`（纯函数）+ 真库查询；**跨实例无证据**（搜索是本机读） | PARTIAL 无具名 `code=`；但错误是 `?` 向上而非折叠成空（比 F-MSG-060 好） | **PASS** |
| F-MSG-004 | 重发一条失败/被取消的消息（复活） | PASS 前端拦截：重发前有**二次确认**（`3e3ddac1` 修的就是"重发不确认"）；发送中可取消 | PASS 发送中再次点击由状态机与 `pendingAcks` 挡住（不重复提交） | PASS **状态门只允许 `failed` / `cancelled` 复活**（`db/messages.rs:1297-1301`）：`sending`/`sent` 已在路上，`delivered`/`read`/`recalled` 是不可逆硬终态——注释写明「一条已送达的消息被『重发』会让对端收到第二条完全相同的情绪，而库里的 seq 还是旧的」；有 `resend_requeue_tests` 用例族 | PASS 失败档给「可重发」入口，终态档不给（`MessageReceipt` 按 `resendChannel` 门控） | PARTIAL 有 `resend_requeue_tests`（db 层状态门）+ `retrySend.test.ts`（前端）；**命令体本轮未逐行读**（B 级） | PARTIAL 复活/重发无具名码（并入 B1-F1 族） | **PARTIAL** |
| F-GRP-003 | 建群与群密钥分发 | PASS 群名按字符截断并要求非空；成员先过滤空/自己、再 `sort`+`dedup`（结果确定）；**逐个校验必须是好友**；自己总会被补进成员表；群行 + 成员行 + 群密钥（`settings gk:{id}`）+ 会话行**同一事务**提交 | 不适用(理由)：建群是本地事务，邀请是消息 | PASS 建群**只提交本地状态**、分发由 `distribute_group_key` 另走一条命令；**建链/Hello 时 `requeue_group_keys_for_peer` 会把「该对端在其中的每个群」重新排进待发**（`network/transport/pending_keys.rs:155-172`），再由 `flush_pending_group_keys` 重发 ⇒ 建群时不在线的成员上线后可补齐；公钥解析是 `peers` 优先、`friends` 回落（`resolve_member_x25519` 的注释记着：friends 缺公钥曾导致 GroupKey 被静默跳过） | PARTIAL 分发逐成员「取不到公钥/算不出共享密钥/加密失败就 `continue`」，且函数**恒返回 `Ok(())`**、不区分成功几个 ⇒ 创建者看不到「N/M 成员已收到」；自愈路径存在，所以判 PARTIAL 而不是 FAIL | PARTIAL 有群轮次（`group` 37 断言）与群密钥测试族；**建群/分发的部分成功没有判据** | PARTIAL 被跳过的成员**没有日志**（`continue` 静默）、无具名码（并入 B1-F1 族）；同一函数里 `db::list_groups(...).unwrap_or_default()` 也属 B1-F7 那族（后台路径，下次建链会重试） | **PARTIAL** |
| F-GRP-004 | 群公告：发布 / 删除 / 活动公告列表 | PASS 仅群主（`g.creator != 我` 直接拒，口径与 `handle_group_rename` 逐字同构）；公告内容非空 + 长度上限 | 不适用(理由)：公告是即时卡片消息；删除用**墓碑**而不是删行 | PASS 删除发 `announcement_delete`（Silent）墓碑，全端按 `ann_id` 折叠 ⇒ 与其它群消息走同一条 LWW/折叠管线，晚到也能收敛；**接收端强制 owner-only**：`gossip.rs:965-986` 校验 `g.creator == env.sender_id` 才接受——注释记着这是个真修过的洞（「接收侧原先没有任何检查 ⇒ 任何持群密钥的成员构造一条 announcement 就能改掉所有人的公告横幅」） | PASS 横幅折叠规则与 `ChatWindow.vue` 一致；**群主离线时发不了**——注释写明「无中心即无中心授权，不做『降级为任何人可发』」（见 B1-K6） | PARTIAL 有群轮次与消息族测试；**公告的跨实例投递仍零证据**（早期探测结论，本轮未补轮次） | PARTIAL 丢弃非群主公告时有 warn（带 sender 与 group），但**无具名 `code=`**（并入 B1-F1 族） | **PARTIAL** |
| F-PLF-011 | 资料与设备信息（昵称/头像/网卡枚举/设备信息） | PASS 昵称按字符截断；**头像按解码后字节数**限到 `MAX_AVATAR_BYTES` 并直接拒（注释写明理由：防止超大 base64 落库 / **撑爆 UDP 广播**）；落库进阻塞池 | 不适用(理由)：保存资料是单次写 + 一次广播 | PASS 顺序是「先落库 → 再更新内存 → 再广播」；广播**锁内只做取 + 克隆、绝不 await**——注释记着原写法「`lock().await` 后就地 `tx.send().await`」在半开 TCP / 休眠 / 写缓冲满时会让 `send().await` 挂起，而它**握着全局 links 锁** ⇒ 所有 `try_send`、心跳、`get_peers`、`mark_peer_offline` 全被堵死 | PASS 超限给具体人话（「头像过大，请压缩到 2MB 以内」）；写入失败 `?` 向上 | PARTIAL 本轮读到实现，**未读到对应断言**（如"超限必须拒"的用例）⇒ 标待补 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-PLF-012 | 窗口注意 / 抖动 / 未读角标 / 桌面通知 | PASS 四个命令都在注册表；`shake_window` 是 **async**（要睡 45ms×7），偏移序列有界（三个来回 + 回位），末尾**一定回到起点** | 不适用(理由)：都是"提醒"类动作，没有可中断语义 | PASS `shake_window` **失败静默**并写明理由（个别 WM/远程会话 `set_position` 无效，而抖动只是提醒，不该打断收消息）；`set_unread_badge` **幂等**（同值重复调用无副作用）且失败静默；`notify_desktop` **再判一次总开关**（「后端也能独立触发通知，不能只依赖前端状态」） | PASS 平台策略收成**纯函数** `attention_request`（`commands/network.rs:271-281`）：macOS 只在 `urgent` 时 `Critical`（Dock 持续弹跳，普通消息配不上），Windows/其它一律闪任务栏（窗口回前台自动停）——口径直接引自用户 2026-09-29 原话；**三腿在 macOS 上一次 `cargo test` 全判**（治 cfg 盲区）；`urgent` 由前端 `utils/notifyUrgency.ts` 判（只有前端看得见内容） | PASS 有 `attention_request` 三腿单测；`set_unread_badge` 的 async + spawn_blocking 有审计条目（2.2j：逐像素混图标在主线程会卡 UI 事件循环） | PARTIAL 提醒类失败都静默（**有意的**），所以没有码也不算缺口；但 `notify_desktop` 返回 false 只表达"应用开关关了"，**表达不了"系统权限关了"** ⇒ 并入 **B4-F3** | **PARTIAL** |
| F-OBS-002 | 前后端契约双向对账（161 命令 / 事件面） | PASS 门面唯一：`IPC 只能从 src/api 门面走`（含「6 条命令在 api 上根本没有包装」的回归） | 不适用(理由)：这是判据不是用户操作 | 不适用(理由)：同上 | 不适用(理由)：同上 | **PASS（我实跑）** `node --test src/api/events.test.ts src/utils/mapContract.test.ts` ⇒ **EXIT=0，17/17**；另独立 `comm` 复算：注册 161 / 去重调用名 160，孤儿仅 `get_topology`（`events.test.ts:375` 自declare 无 UI 入口） | PASS 命令名与注册表逐条对账、「门面之下不许留没人引用的包装」都是现成判据 | **PASS** |
| F-OBS-003 | 诊断面：错误分类 / 上限 / 脱敏 / 访问控制 | 不适用(理由)：非用户动作 | 不适用(理由)：同上 | PASS 单文件 512 KB 轮转（`logging.rs:140/1070`），有真文件读写测试 `logger_persists_to_file_and_rotates:1715` | 部分：日志窗口有独立 entry（`logs.html` + `src/entries/logs.ts`），用户可查 | **已证**（上两行测试名 + 我跑通的对账族） | **PARTIAL** 具名 `code=` 共 **87** 个、日志调用 363 处（error 81 / warn 129 / info 153），覆盖面广；但**关键操作结局缺码**（B1-F1）；脱敏是形状级（`diagnostics.rs:19-22`，作者自述并保留文件名/大小以便查传输故障）⇒ 隐私与可查性是**登记过的取舍** | **PARTIAL** |

## 二、状态机与跨层一致性（逐转移）

**读法**：每张表只写**读到过证据**的转移；没读到的写「待核」，不猜。列的含义：**唯一写入方**指"谁能决定这个状态"（多处都能写就必须写清谁有最终裁定权）；**落库时点**指崩溃后靠什么恢复。

### 6.1 1:1 消息

| 转移 | 触发 | 唯一写入方 | 落库时点 | 网络副作用 / ACK 语义 | 并发与重复 | 用户可见 | 证据 |
|---|---|---|---|---|---|---|---|
| （无）→ `sending` | 用户点发送 | `send_message` | **消息行 + outbox 同一事务**（`db/messages.rs:53`） | 尚未发出；先入队再投递（INV-003） | 同 msg_id 由 `INSERT OR IGNORE` 幂等 | 气泡"发送中" | `chat.rs:745-789` |
| `sending` → `sent` | `try_send` 成功（进了 mpsc） | 发送侧 | outbox 行仍在 | **`sent` ≠ 对端收到**：只代表进程把帧交给 writer | — | 气泡按"已发出"画 | 注释 `chat.rs:740-744` |
| `sent` → `delivered` | 对端 `Ack` | `handle_messaging` 的 Ack 臂 | 删 outbox 行 | **对端落库之后才 Ack** ⇒ `delivered`＝对端已持久化（`handle_messaging.rs:91-98`） | 重复 Ack 幂等；迟到 Ack 见 6.2 | 双勾 | 同上 |
| `delivered` → `read` | 对端 `ReadReceipt` | 读回执臂 | `read_receipts` | 回执本身也带 pending 兜底（见 F-MSG-050） | — | 双勾变色 | `chat.rs:1244-1300` |
| `sending`/`sent` → `failed` | outbox 期限到 | `outbox_sweep`（**写库成功才 emit**） | 置 failed + 删行 | 只有写成功才 emit `message-failed`；失败则保留行下轮重试（注释："绝不界面说失败、行还在、又重发"） | 离线保留 7d（INV-P04），可达 120s | 气泡失败 + 可重发 | `outbox_sweep.rs:185-206` |
| `sending` → `cancelled` | 用户取消 | `cancel_message`（**数据库裁定**竞态） | 单事务 | 群分支额外 emit | `AlreadyDelivered` 时拒绝并说"已经传完" | 六档人话（`cancelFeedback`） | `chat.rs:136-155` |
| 任态 → `recalled` | 撤回 | `recall_message` | 账本 + 物化**两笔独立写**（缺事务） | 帧先发后物化 | 幂等短路只看账本 | 正文清空 | **B1-F6** |

**终态**：`delivered` / `read` / `recalled` / `cancelled` / `failed`（`messages.rs:731`、`offline_queue.rs:375` 有终态守卫，不回退）。

### 6.2 群消息（成员级）

| 转移 | 触发 | 唯一写入方 | 落库 | 语义 | 证据 |
|---|---|---|---|---|---|
| （无）→ 每成员一行 `pending` | 发送 | `insert_group_outbox` | 与消息同批 | 一条群消息 = 每成员一行 | `db/group_offline_queue.rs:7` |
| `pending` → `delivered` | 成员 `GroupAck` | `ack_group_delivered` | 单事务；delivered 墓碑按条件删 | 只有 `prior == pending` 才把**消息**推到 delivered | `:49-101` |
| 迟到 Ack（行已 cancelled/failed） | 成员 Ack | 同上 | 只改行 | `LateApplied`：**绝不把 cancelled 提成 delivered**（有测试） | `cascade_tests.rs:1188-1203` |
| `pending` → `cancelled` | 用户取消剩余成员 | `cancel_queued_group_message` | 单事务 | 已 delivered 的行不动；有 pending 才能取消 ⇒ 可能落 `partial_cancelled` | `:103-117` |
| 行 → `failed` | 逐行过期 | `outbox_sweep` | 行标 failed（**不删**） | 删了就再也说不清"谁没收到"；`delivered>0/cancelled>0` 时**不折消息为 failed** | `outbox_sweep.rs:246-311` |
| 全行放弃且无人收到 | 期限到 | `finalize_expired_message(group=true)` | 单事务 | 写成功才 emit `message-failed` | `:340-359` |

### 6.3 文件传输

| 转移 | 触发 | 唯一写入方 | 落库 | 语义 | 证据 |
|---|---|---|---|---|---|
| （无）→ `pending`/`active` | 发起/接受 | 发送/接收侧 | `file_transfers` | 群里另有 `group_files`/`group_file_recipients` 一本账（FUNC-03 记着幽灵行旧缺陷） | `db/file_transfer.rs:186-191` |
| 任态 → `done`/`failed`/`cancelled` | 唯一终局出口 | **`finalize_file_failure`**（顺序：气泡→台账→关队列） | 单事务 | `done` **不降级**；`failed` 可被下一轮重新激活（有测试） | `db/file_transfer.rs:23-34,120-180` |
| 写盘失败（含盘满） | chunk 写错 | `fail_receive` + 回否定确认 | — | 立即告诉发送端停；但**盘满这一档不分类、且保留 `.part`** | **B2-F1** |
| 用户取消 | 点取消 / 对端 `FileCancel` | **`apply_local_cancel`（两者共用）** | 单事务 | 点亮所有在途槽位 → 停接收 → 落库 → emit；`by` 只进日志 | `commands/files.rs:776-800` |

### 6.4 其余有生命周期的对象

| 对象 | 状态与出口 | 持久化 | 备注 |
|---|---|---|---|
| `outbox` / `group_outbox` / `file_outbox` | 行只在 Ack/GroupAck 后删；否则按期限或次数收口 | 三张表 | 发送侧崩溃窗口由"消息+队列同事务"关闭 |
| 内容取回 `content_transfers` | `queued/active/verifying → complete / rejected / incomplete` | 表 + 磁盘 | 8 次退避后 `Rejected`（终态，不再自动重取）；`incomplete` 是"还能再取" |
| 更新器 | `idle/checking/downloading/ready/installing/failed/cancelled/unsupported` | **无（纯内存）** | 重启即丢；`installing` 不可取消（**B1-F3** 边界无守卫） |
| 任务中心 | `queued/running/blocked`（**派生**，无自有状态） | 无 | 只列未完成；状态由三张台账现读（F-PRE-003） |

---

## 三、缺失测试与故障注入计划

### 7.1 现有注入能力（实测，不是转述）

10 类故障 × `_lie` 反向对照：脏 `.part`、续传前缀复用、**部分写后崩溃（SIGKILL）**、对端冻结（SIGSTOP→超时）、接收目录只读（盘满近似）、改名失败、源缩小竞态、同名多文件、100MB 中途停滞、**发送方中途崩溃**。另有 `groupcrash` / `gossip-late` / `lanoff` / `task` 等轮次。**每一轮都读真二进制、真 TCP、真 SQLite 行、真 sha256**。

### 7.2 **没有**注入能力的类别（这正是缺的测试）

| 缺的注入 | 为什么重要 | 最小可行做法 |
|---|---|---|
| **用户取消经 IPC** | 5 条取消通道的"取消 vs 完成"竞态只能靠真取消触发 | 在 `group`/`gfile` 轮里加一步：发送中途调 `cancel_message`/`cancel_file_transfer`，断言终态是 `cancelled` 且**不被迟到 Ack 改写** |
| **重复 / 乱序 / 迟到帧** | 去重与 `LateApplied` 只有单测，没有跨进程证据 | 用代理重放同一帧两次、把 Ack 延迟到超时之后 |
| **DB busy / 写失败** | **B4-F1** 与 **B1-F6** 都只在"写失败"时才现形 | 在隔离库里加一个一次性失败注入（如 `PRAGMA` 触发 busy），断言落 failed 或重试，而不是静默 |
| **任意点崩溃**（而非定时 kill） | "提交前/后"窗口是状态机正确性的核心 | 在 `insert_message_and_outbox` 前后各插一个 kill 点，断言重启后要么有消息有队列、要么都没有 |
| **盘满的真实形态** | 只读目录只是近似；**B2-F1** 要的是 ENOSPC | 小容量挂载或 `ulimit -f`，断言 `.part` 被删且界面说"空间不足" |
| **网络分区 / 丢包 / 限速** | 现在只有"冻结"这一种 | `pfctl`/`tc` 在隔离网段做 10% 丢包 |
| **时钟漂移** | 消息排序依赖 `seq`，但"时钟钳制"路径没被测 | 把一端系统时间拨快/拨慢 |

### 7.3 前端行为面（这一层原本完全没有）

- 现状：132 册前端测试里 **69 册是读源码文本**；**零组件渲染、零 store 状态转移**。
- 本轮已跑：`--only=convbadge` ⇒ **9/9 绿**（含反向对照）。
- **建议补的段**（按价值排）：① 改设置失败（B1-F4）——注入 `saveSettings` 失败，断言状态行出现且不刷屏；② 撤回后重开会话（B1-F6）——断言正文不"复活"；③ 取消竞态（B1-F1）——断言"已经传完"而不是"已取消"；④ 通知权限被拒（B4-F3）——断言设置页显示"系统已关闭"。
- **纪律**：每段必须配一条反向对照（改坏必须红），否则又是一条空转判据。

## 四、FID → 命令映射（覆盖度的唯一可辩护口径）

**先说结论：我试过三个口径，前两个都不成立。**
① 按"该命令的定义文件是否被本审计文档提及" ⇒ 会得到 **161/161 = 100%**——因为我把缺口模块名写进了文档，**指标被我自己的缺口表污染**；
② 按"命令名是否出现在矩阵里" ⇒ 只有 **19/161 = 12%**——而 `cancel_message` 明明审过（F-MSG-014），只因行内写的是行为描述而没出现名字；
③ 下表按"**我到底读了什么**"分级，只有 A 级计入覆盖。

**分级定义**：**A = 读过函数体或关键分支**（能说出它怎么决定终态/怎么失败）｜**B = 只读过签名、调用点或结构形状**（知道它存在、参数与所在链路，但没读它内部）｜**C = 只在 `grep pub fn` 里见过名字**。

### A 级（计入覆盖）

| FID | A 级命令（读过函数体/关键分支） |
|---|---|
| F-PLF-011 | `update_profile`（读了头像大小门与广播锁纪律） |
| F-GRP-004 | `send_group_announcement`（读了出站校验；入站 owner-only 在 `gossip.rs`） |
| F-GRP-003 | `create_group` · `distribute_group_key` · `requeue_group_keys_for_peer`（读了本地事务与建链补发） |
| F-MSG-070 | `search_chat_history` · `search_history` · `escape_like` · `sql_kind_list`（读了 SQL 构造） |
| F-GRP-002 | `update_group_todo`（读了鉴权三档与 `creator`/`done_at` 的服务端回填） |
| F-FRN-001 | `send_friend_request`（读了实现：先登记再发的理由与补发路径） |
| F-MSG-060 | `get_messages` · `get_latest_messages` · `list_conversations`（首屏三处主读，读了实现） |
| F-MSG-001 | `send_message`（含逐类载荷预校验、能力位门控与"消息+outbox 同事务"） |
| F-MSG-014 / F-MSG-015 | `cancel_message`（含三态 `MessageCancelOutcome` 与群分支） |
| F-MSG-040 | `recall_message` |
| F-MSG-050 | `mark_read` |
| F-PLF-007 | `updater_cancel` |
| F-PST-004 | `delete_conversation` · `clear_all_data` |
| F-FIL-004 | `download_shared_file` |
| F-IDL-001 | `get_safety_number` · `rename_group` 的入站对应（`handle_group_rename`） |
| F-GRP-001 | `group_add_member` · `group_remove_member` · `transfer_group_creator` · `rename_group`（creator 门控逐个读过） |
| F-OBS-007 | `get_logs` · `clear_logs` · `get_log_locations` |
| F-OBS-008 | `export_external_links` · `cleanup_external_links_export` · `import_external_links_file` · `import_external_links_from_url` |

**A 级合计 29 条命令**（现算脚本报 30 个 token，多出的那个是内部处理器 `handle_group_rename`，它不是 tauri 命令、不计入 161）。这就是我敢说"这 19 条有六格结论"的全部。

### B 级（不计入覆盖，只说明链路形状）

`save_settings`（读了前端 `persistSettings` 与它的 catch，没读 Rust 侧）· `open_settings_window`/`open_log_window`/`open_group_todos_window`/`open_image_preview`/`prewarm_aux_windows`/`open_link_window`（读了 `#[tauri::command(async)]` 形状与 `ensure_aux_window` 的纪律，没读各自函数体）· `save_media_as` · `copy_file` · `save_data_file` · `start_network`/`stop_network`/`set_channel_enabled`/`get_runtime_snapshot`（只在快照与事件契约里见过）· `get_relay_config`/`save_relay_config`/`check_relay_server`/`list_routed_endpoints`/`add_routed_endpoint`/`remove_routed_endpoint`（只在设置页调用面见过）· `send_file_auto` · `request_share_tree` · `export_diagnostics_bundle` · `reset_settings` · `delete_messages` · `sync_friend_keys`/`get_friend_key_rotations`。

### C 级（只在名字清单里出现，**明确未审**）

`get_device_info` · `update_profile` · `list_interfaces` · `get_peers` · `search_nearby_peers` · `focus_window` · `shake_window` · `request_attention` · `set_unread_badge` · 好友四件套（`get_friends`/`send_friend_request`/`respond_friend_request`/`get_pending_requests`/`remove_friend`/`default_nickname`）· `send_message` · `get_messages`/`get_latest_messages`/`get_conversations`/`ensure_conversation`/`set_conversation_pinned`/`get_conv_link`/`get_message_count`/`get_pending_message_operations`/`get_group_todo_messages` · `send_group_message`/`send_group_reaction`/`pin_group_message`/`set_message_render`/`get_group_delivery_summaries`/`resend_group_delivery` · 群公告与群待办六条 · `send_todo_image`/`save_todo_image_bytes`/`todo_image_meta` · `request_content`/`request_content_by_cid`/`cancel_content_fetch`/`get_content_transfers`/`get_transfers` · `delete_file`/`save_outgoing_image`/`open_file_native`/`read_file_preview`/`read_content_preview`/`copy_file_to_clipboard`/`read_clipboard_file_paths`/`media_present` · `export_chat_text` · `get_discovery_diag`/`get_runtime_diag`/`set_app_active` · `window_minimize`/`window_toggle_maximize`/`window_is_maximized`/`window_close`/`set_native_titlebar_buttons_hidden`/`apply_macos_window_shape` · `search_chat_history` · `import_picked_file`/`request_ble_permissions`/`set_ui_language` · `broadcast_chat_style` · `list_favorites`/`add_favorite`/`remove_favorite`/`read_favorite_preview` · `get_cache_info`/`clean_cache_now`/`set_cache_policy` · `create_group`/`leave_group`/`distribute_group_key`/`get_groups` · `get_settings`/`reset_settings` · `get_previous_exit` · `notify_desktop`/`send_test_notification` · `login`/`updater_status` 之外的更新命令 · `ui_heartbeat`/`report_frontend_slow_op`/`log_frontend_error` · `take_group_todo_focus`/`request_group_todo_focus`/`get_group_todos_context`/`get_image_preview_gallery`/`close_settings_window`/`restart_app`。

**所以真实进度是**：**29 条 / 161 条 ≈ 18% 的命令有六格结论**；33 行矩阵里剩下的行讲的是**行为族**（例如"群成员级投递"这一族横跨收发两侧、多张表与清扫器），它们比单条命令大，但不能拿来充命令数。现算命令：

```bash
python3 - <<'EOF'
import re
s=open("docs/notes/closedloop-matrix-2026-10-26.md").read()
sec=s.split("### A 级（计入覆盖）",1)[1].split("**A 级合计",1)[0]
names=set()
for line in sec.splitlines():
    if line.startswith("| F-"):
        for tok in re.findall(r"`([a-z_0-9]+)`", line): names.add(tok)
print("A 级命令数:", len(names), "/ 161")
EOF
```

## 五、读数

现算（**只数判级列**，命令：`grep -cE '^\| F-.*\| \*\*(PASS|PARTIAL)\*\* \|$' docs/notes/closedloop-matrix-2026-10-26.md` ⇒ **43**）：已走完六格 **43** 行，其中 **PASS 7**、**PARTIAL 36**；另有若干行含「不适用(理由)」的格（不适用≠通过，也不计入这两档）。⚠️ **不要用 `grep -c '^| F-'`**——本文件第六节的「FID → 命令映射」表同样以 `| F-` 开头，那个命令会把两表相加（实测报 45）。立案 **14** 条（P2 九 / P3 五），保留 **6** 条，撤回 **6** 条。

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

## 六、B1 待审队列（每行注明缺哪一格）

| 族 | 待审内容 | 主要缺的证据 |
|---|---|---|
| 消息操作 | 引用 / 转发 / 收藏 / 强提醒 / 多选批量 / 复制保存图片文件 / 定位原消息 | 六格全缺；`MessageContextMenu` 17 个 emit 与 `MessageItem` 12 个 emit 的**后端落点**未逐条追 |
| 1:1 主链 | 发送、已读回执、撤回、重发 | 状态机转移表未画完；重发的二次确认与「取消与 ACK 竞态」在 Rust 侧的归属未读 |
| 群 | 建群 / 邀请 / 移除 / 移交群主 / 群公告 / 群待办 / 成员级投递与补发 | 部分成功与迟到 ACK 的终态归属；`some_delivered` 的表达是否等于「部分成功」 |
| 会话 | 删除会话 / 清空数据 / 置顶 / 历史边界 | 删除的不可逆边界与二次确认；清空后的跨窗口广播（`events.test.ts` 有「清空数据必须广播」这条测试，需确认覆盖面） |
| 呈现层 | 浮层返回键栈、`RouteView` 与 pane 双事实源、窄窗移动端 | 属你正在做的线（`6ca07ca5`/`39a7f216`/`c3b21b3c`），本轮只登记 |
| 设置 | 11 节各写入项的**分域**验收（F-PRE-011 只覆盖了共用的那条写入通道） | 每项设置失败是否都走同一 catch；哪些项影响网络行为需要更高要求 |
| 搜索 / 收藏 / 链接 | 命令与落库面 | 六格全缺 |

## 七、错误链表（六项标准里「可诊断」的专用视图）

| 错误路径 | 产生 | 分类记录 | 安全处理 | 用户反馈 | 诊断查询 | 恢复或终止 | 留痕 | 判级 |
|---|---|---|---|---|---|---|---|---|
| 1:1 消息取消竞态（已送达） | ✓ | **✗ 无码无日志** | ✓ DB 单一裁定 | ✓ 六档人话 | **✗** | ✓ | **✗** | FAIL（B1-F1） |
| 群消息取消 | ✓ | ✓ `GROUP_CANCEL` | ✓ 台账按成员 | ✓ | ✓ | ✓ | ✓ | PASS |
| 取消更新（installing） | ✓ | **✗ 文本断言代替行为断言** | 部分（字面量耦合） | ✓ | **✗** | ✓ 拒绝并保留现场 | **✗** | FAIL（B1-F3） |
| 设置落库失败 | ✓ | **✗ 零记录** | **✗ 界面不回滚** | **✗** | **✗** | ✗ 静默回旧值 | **✗** | FAIL（B1-F4） |
| 崩溃留下 sending/active 行 | ✓ | ✓ 四条启动对账各带具名失败码（`state.rs:1786/1799/1817/1832`，如 `OUTBOX_ORPHAN_RECOVERED` / `TRANSFER_INTERRUPTED_RECOVERED`） | ✓ | 部分（落 failed 后气泡说话） | ✓ | ✓ | ✓ | **PASS**（这是本仓做得最好的一族） |
| Worker 高亮失败 | ✓ | ✓ `onerror` 全量降级主线程（`codeHighlight.ts:62-69`） | ✓ | 不适用(理由)：降级对用户是无感的正确行为 | 待审 | ✓ | 待审 | 待审 |
