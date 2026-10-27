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
| F-MSG-060 | 首屏读取与历史分页（`get_messages` / `get_latest_messages` / `get_conversations`） | PASS 三处都在 `spawn_blocking` 里（注释：标了 `(async)` 的同步 fn 仍跑在 tokio worker 上，留在 worker 等锁就是拿稀缺资源换排队位置）；`limit` 夹到 1..500、`offset` 取非负 | 不适用(理由)：纯读操作 | PASS 只读，不产生需要恢复的状态；一次失败在下次成功读时自愈 | **FAIL** 三处都是 `db::…().unwrap_or_default()` ⇒ 读失败变成**空页/空列表**；会话列表整个消失时最像「数据被清空了」⇒ **B1-F7** | PARTIAL messages 读取有 DB 层用例，但「失败必须变 Err 而不是空」没有判据（B1-F7 要补） | **FAIL** 错误对象被 `unwrap_or_default` 丢弃，无日志、无事件 ⇒ **B1-F7** | **PARTIAL** |
| F-FRN-001 | 好友申请：发送 / 同意 / 拒绝 / 删除 | PASS 发送侧先挡「空 / 自己」；**同意路径只有一份实现**（`commands/mobile_picker.rs:363-371` 说明两个入口都要走它，否则会造出「我这儿有他、他那儿没我」的**单边好友关系**——用户 2026-09-12 实测过） | 不适用(理由)：申请与同意都是即时消息，没有「取消」语义；拒绝即终止 | PASS **先登记再发**：好友申请没有回执，链路一抖就静默丢、而界面照样显示「已发送」（2026-09-12 真机复现过）⇒ 登记后由建链/Hello 补全时重发；`or_insert` 保证连点几次**不重置**补发间隔；`FriendAccept` 也有**唯一**发送实现 + `flush_pending_friend_accept` 重发路径（注释："两处各写一份的话，重发的那份迟早会漏掉定向/重签/加密"） | PASS **缺对端公钥时绝不静默**：warn 一行 + 返回 Err，并写明后果（本地已加好友但回执发不出 ⇒ 单边成立）；同意/拒绝后清 pending | PARTIAL `lib_friend_identity_tests` 有源码断言族；但**跨进程好友关系始终没有 E2E 轮次**（早期矩阵就记着「no J4 proof」）⇒ 这条的"可验证"仍缺最高一档 | PARTIAL 有 warn 但**无具名 `code=`**（并入 B1-F1 族） | **PARTIAL** |
| F-GRP-002 | 群公告与群任务（创建 / 改状态 / 改结构 / 归档 / 删除 / 公告列表） | PASS 标题长度、状态白名单、**指派人必须是群成员**（`check_todo_assignees`）都校验；优先级/类型只在**给了值**时校验并覆盖，只改状态不会把优先级重置成「常规」 | 不适用(理由)：都是即时定义消息（LWW per `todo_id`），没有取消语义；删除用显式 `deleted` 标志 | PASS **鉴权三档**（`commands/group_files.rs:463-477`）：todo 创建者或群主全权；**被指派人只能改状态与指派人、不能改结构**（标题/描述/图片/删除）；其余无权。**`creator` 与 `done_at` 都不从参数来**：前者服务端从库里最新定义回填（否则传别人的 creator 就能改别人的任务），后者在**首次**完成时记权威时间戳、重复保存沿用原值（否则改个标题就重置 7 天归档计时，且客户端可伪造完成时间绕过自动归档）；LWW 语义使乱序到达也收敛 | PASS 群任务有独立窗口与任务板；徽标**只由前端 `utils/todos.ts::foldTodos` 折叠一份**，后端只回 `kind IN ('todo','todo_update')` 的原始行（注释：用内存缓存算徽标会让「没缓存的群没有数字」，那是假状态） | PARTIAL 有 `todos` 单测与群轮次；但**公告与群待办的跨实例投递仍零证据**（早期探测结论，我本轮未补轮次） | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-MSG-070 | 聊天记录搜索（关键词 / 发送者 / 时间范围） | PASS 关键词按字符截断、空词直接返回空；`sender`/`since`/`until` 都是可选过滤；命中数与会话数各有上限（`SEARCH_HISTORY_MAX_HITS` / `MAX_CONVS`） | 不适用(理由)：只读查询 | PASS **没有 SQL 注入面**：`?1..?5` 全参数化，唯一的插值是从编译期 `WIRE_KINDS` 派生并逐项加引号的 kind 清单（`protocol.rs:552-560`），不是用户输入；`escape_like` 依次转义 `\\`、`%`、`_`（`db/messages.rs:1291-1295`）⇒ 用户输入的 `%`/`_` 是字面量而不是通配 | PASS 结果按 `ts DESC` 分组，组内与左栏顺序一致；元数据批量预取（旧形状 50 会话 × 60 命中 ≈ 3000 次锁往返，注释记着） | PASS **范围钉在「仍在会话列表里的会话」**上（`conv_id IN (SELECT id FROM conversations)`），注释写明：删除级联收口之前入库的孤儿历史不该出现在搜索里——「点又点不开，还挤占共 N 条」；`system` 与静默类（表情回应/撤回）默认不可搜 | PARTIAL 有 `chatSearch*.test.ts`（纯函数）+ 真库查询；**跨实例无证据**（搜索是本机读） | PARTIAL 无具名 `code=`；但错误是 `?` 向上而非折叠成空（比 F-MSG-060 好） | **PASS** |
| F-MSG-004 | 重发一条失败/被取消的消息（复活） | PASS 前端拦截：重发前有**二次确认**（`3e3ddac1`）；命令层先校验归属/会话/kind，**群消息直接拒**（"请用按成员补发"）、自聊直接拒 | PASS 发送中再次点击由状态机与 `pendingAcks` 挡住（不重复提交）；**复用原 `msg_id`/`ts`/`seq`** ⇒ 若上次其实送到只是 Ack 丢了，对方只会再回一次 Ack、界面不多一条（注释：走 `send_message` 会生成新 id/新 seq，就变成"再发一条新消息"，恰好在最需要幂等的那一刻失去幂等——用户 2026-10-25 的原话是"重试必须复用稳定消息身份"） | PASS **状态门只允许 `failed` / `cancelled` 复活**（`db/messages.rs:1297-1301`）：`sending`/`sent` 已在路上，`delivered`/`read`/`recalled` 是不可逆硬终态——注释写明「一条已送达的消息被『重发』会让对端收到第二条完全相同的情绪，而库里的 seq 还是旧的」；有 `resend_requeue_tests` 用例族 | PASS 失败档给「可重发」入口，终态档不给（`MessageReceipt` 按 `resendChannel` 门控） | PARTIAL 有 `resend_requeue_tests`（db 层状态门）+ `retrySend.test.ts`（前端）；命令体本轮读过（⇒ 升 A 级），**「先密封→再入队→最后置 sending 三步失败都留在原态」没有具名判据**（属 `requeue_message_for_resend` 的事务语义） | PARTIAL 复活/重发无具名码（并入 B1-F1 族） | **PARTIAL** |
| F-GRP-003 | 建群与群密钥分发 | PASS 群名按字符截断并要求非空；成员先过滤空/自己、再 `sort`+`dedup`（结果确定）；**逐个校验必须是好友**；自己总会被补进成员表；群行 + 成员行 + 群密钥（`settings gk:{id}`）+ 会话行**同一事务**提交 | 不适用(理由)：建群是本地事务，邀请是消息 | PASS 建群**只提交本地状态**、分发由 `distribute_group_key` 另走一条命令；**建链/Hello 时 `requeue_group_keys_for_peer` 会把「该对端在其中的每个群」重新排进待发**（`network/transport/pending_keys.rs:155-172`），再由 `flush_pending_group_keys` 重发 ⇒ 建群时不在线的成员上线后可补齐；公钥解析是 `peers` 优先、`friends` 回落（`resolve_member_x25519` 的注释记着：friends 缺公钥曾导致 GroupKey 被静默跳过） | PARTIAL 分发逐成员「取不到公钥/算不出共享密钥/加密失败就 `continue`」，且函数**恒返回 `Ok(())`**、不区分成功几个 ⇒ 创建者看不到「N/M 成员已收到」；自愈路径存在，所以判 PARTIAL 而不是 FAIL | PARTIAL 有群轮次（`group` 37 断言）与群密钥测试族；**建群/分发的部分成功没有判据** | PARTIAL 被跳过的成员**没有日志**（`continue` 静默）、无具名码（并入 B1-F1 族）；同一函数里 `db::list_groups(...).unwrap_or_default()` 也属 B1-F7 那族（后台路径，下次建链会重试） | **PARTIAL** |
| F-GRP-004 | 群公告：发布 / 删除 / 活动公告列表 | PASS 仅群主（`g.creator != 我` 直接拒，口径与 `handle_group_rename` 逐字同构）；公告内容非空 + 长度上限 | 不适用(理由)：公告是即时卡片消息；删除用**墓碑**而不是删行 | PASS 删除发 `announcement_delete`（Silent）墓碑，全端按 `ann_id` 折叠 ⇒ 与其它群消息走同一条 LWW/折叠管线，晚到也能收敛；**接收端强制 owner-only**：`gossip.rs:965-986` 校验 `g.creator == env.sender_id` 才接受——注释记着这是个真修过的洞（「接收侧原先没有任何检查 ⇒ 任何持群密钥的成员构造一条 announcement 就能改掉所有人的公告横幅」） | PASS 横幅折叠规则与 `ChatWindow.vue` 一致；**群主离线时发不了**——注释写明「无中心即无中心授权，不做『降级为任何人可发』」（见 B1-K6） | PARTIAL 有群轮次与消息族测试；**公告的跨实例投递仍零证据**（早期探测结论，本轮未补轮次） | PARTIAL 丢弃非群主公告时有 warn（带 sender 与 group），但**无具名 `code=`**（并入 B1-F1 族） | **PARTIAL** |
| F-PLF-011 | 资料与设备信息（昵称/头像/网卡枚举/设备信息） | PASS 昵称按字符截断；**头像按解码后字节数**限到 `MAX_AVATAR_BYTES` 并直接拒（注释写明理由：防止超大 base64 落库 / **撑爆 UDP 广播**）；落库进阻塞池 | 不适用(理由)：保存资料是单次写 + 一次广播 | PASS 顺序是「先落库 → 再更新内存 → 再广播」；广播**锁内只做取 + 克隆、绝不 await**——注释记着原写法「`lock().await` 后就地 `tx.send().await`」在半开 TCP / 休眠 / 写缓冲满时会让 `send().await` 挂起，而它**握着全局 links 锁** ⇒ 所有 `try_send`、心跳、`get_peers`、`mark_peer_offline` 全被堵死 | PASS 超限给具体人话（「头像过大，请压缩到 2MB 以内」）；写入失败 `?` 向上 | PARTIAL 本轮读到实现，**未读到对应断言**（如"超限必须拒"的用例）⇒ 标待补 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-PLF-012 | 窗口注意 / 抖动 / 未读角标 / 桌面通知 | PASS 四个命令都在注册表；`shake_window` 是 **async**（要睡 45ms×7），偏移序列有界（三个来回 + 回位），末尾**一定回到起点** | 不适用(理由)：都是"提醒"类动作，没有可中断语义 | PASS `shake_window` **失败静默**并写明理由（个别 WM/远程会话 `set_position` 无效，而抖动只是提醒，不该打断收消息）；`set_unread_badge` **幂等**（同值重复调用无副作用）且失败静默；`notify_desktop` **再判一次总开关**（「后端也能独立触发通知，不能只依赖前端状态」） | PASS 平台策略收成**纯函数** `attention_request`（`commands/network.rs:271-281`）：macOS 只在 `urgent` 时 `Critical`（Dock 持续弹跳，普通消息配不上），Windows/其它一律闪任务栏（窗口回前台自动停）——口径直接引自用户 2026-09-29 原话；**三腿在 macOS 上一次 `cargo test` 全判**（治 cfg 盲区）；`urgent` 由前端 `utils/notifyUrgency.ts` 判（只有前端看得见内容） | PASS 有 `attention_request` 三腿单测；`set_unread_badge` 的 async + spawn_blocking 有审计条目（2.2j：逐像素混图标在主线程会卡 UI 事件循环） | PARTIAL 提醒类失败都静默（**有意的**），所以没有码也不算缺口；但 `notify_desktop` 返回 false 只表达"应用开关关了"，**表达不了"系统权限关了"** ⇒ 并入 **B4-F3** | **PARTIAL** |
| F-OBS-009 | 导出聊天文字（Markdown 单文件） | PASS 目标是用户的另存路径（空路径直接拒）；整段进 `spawn_blocking`，**db 锁只包住 `collect_sections`**，渲染几十万条 + 写盘都在锁外（注释：不能让一次导出把消息落库卡住） | 不适用(理由)：低频「自救」操作（磁盘满 / 换机），不是可中断的长任务 | PARTIAL **已知限制如实写在代码里**：单连接架构下读全库必须持锁，分批读要引入读连接/池 = 架构级改动，判定「收益不抵风险」；导出本身只读、失败 `?` 向上 | PASS 返回 `{conversations, messages, path}` 真实计数；**刻意不产出 HTML**（模块注释：避免对端消息在本机浏览器里执行）；媒体只保留文件名；时区偏移由前端给（不引时区库），**夏令时导致的 1 小时偏差写进了模块注释** | PARTIAL 有 `export` 模块与纯函数；本轮未读其测试 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-PRE-014 | 收藏（列表 / 添加 / 移除 / 预览） | PASS 收藏源必须在**本机存在**（`get_favorite_source` 取不到就报「要收藏的消息不在本机」）；预览有 `max_bytes` 上限且再夹到 15MB | 不适用(理由)：增删收藏是即时单条操作 | PASS **添加幂等**：已收藏过直接返回原条目，注释写明理由「不重复复制文件（那会给磁盘留下无人引用的垃圾）」；预览路径走与 helpers 同一个 `MediaPath` 三态解析（`Present`/`Unknown`/`Gone`），不存在就报错而不是返回空 | PASS 溢界返回 `TOO_LARGE`（前端可据此提示），不是空内容；移除与列表各自返回具体错误 | PARTIAL 有 `favorites_tests`（含撤回与收藏的交互用例）；收藏自身的跨层行为未逐条读 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-MSG-061 | 会话读取与轻写入（`ensure_conversation` / `set_conversation_pinned` / `get_conv_link` / `get_message_count`） | PASS 群名只认 `groups` 表（取不到就报「群不存在」，不走前端拼的名字）；自聊取本机资料（否则回落成 device_id 原文）；都在 `spawn_blocking` 里且不跨 await 持锁 | 不适用(理由)：单条读或单条写 | PASS **在线态由活链路判定**：先 `has_link` + `inbound_path_kind`，缓存 `conv_link` 只作回落 ⇒ 不会拿过期缓存说「在线」（这正是 `peer_offline` 那条「前端拿到的 peers 是发现过的邻居，按它判会把刚掉线的对端说成在线」的反面做法）；置顶写入错误 `?` 向上 | PARTIAL `get_message_count` 返回 `Ok(db::count_messages(...))`，而后者内部 `unwrap_or(0)`（`db/messages.rs:90-97`）⇒ 读失败会显示「共 0 条」⇒ **B1-F7**（这一处的折叠在 db 层，改命令层无效） | PARTIAL 有会话/消息读取测试族，本轮未逐条读 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-CNT-002 | 按 cid 重取内容（请求 / 取消） | PASS 从消息载荷取 cid/name/size，**缺 cid 时明确报**「这条内容没有内容指纹（对方版本较旧）」而不是静默失败 | PASS `cancel_content_fetch` 走统一终态出口，前端按 outcome 分支（`TaskCenter.vue:217-228` 看结果才选 kind） | PASS **能力协商**：只给在 Hello 里声明了 `CONTENT_FEATURE_PULL` 的对端发拉取帧，旧端返回 `Ok(false)`（「不打扰、不报错」）；**手动重取也续传**——先读统一状态里的 `transfer_id` / 已收字节再补；长期取不到有 8 次退避后 `Rejected` 的封顶（F-CNT-001） | PASS 三态各有明确含义：`Ok(true)` 已发出 / `Ok(false)` 对方版本不支持 / `Err` 硬失败；「拥有即授权」（对方无需确认，ADR-0019 Phase 3）是写明的模型 | PASS `contentpull` 36 断言轮 + `content/policy.rs` 单测 | PARTIAL 无具名 `code=`（并入 B1-F1 族）；续传状态查询失败用 `.ok()` 回落成"从头取"（可接受但无痕） | **PARTIAL** |
| F-FRN-002 | 好友列表与待处理申请（读取面） | PASS `get_friends` 把 links/peers/peer_versions 三份快照 + 好友全表读 + 逐行富化全放进阻塞池（`links` 用 `try_lock`，在阻塞线程同样合法） | 不适用(理由)：纯读 | PASS **在线判定只认非空 link Vec**（与 `sweep_peers` / `has_link` 同口径），注释写明理由「残留的空 key 会让好友**永久显示在线**」且「根因已在 reader_loop 修掉，这里是防线」；**待处理申请虽是内存态，但请求方有 `pending_out_requests` 在建链/Hello 时重发**（F-FRN-001）⇒ 重启后能重建，不是单边丢失 | PASS 在线/离线与「是否好友」分开表达；非好友的密钥冲突不进聊天界面（`lib_friend_identity_tests.rs:423-425` 有断言） | PARTIAL `lib_friend_identity_tests` 有源码断言族；**跨进程好友关系仍无 E2E 轮次**（同 F-FRN-001） | PARTIAL `db::list_friends(...).unwrap_or_default()` ⇒ 读失败会让「已加为好友的旧申请」重新出现在待处理列表（B1-F7 族，下次调用自愈） | **PARTIAL** |
| F-FIL-005 | 文件写入 / 删除 / 用系统应用打开 | PASS 另存图片只接受 image/*（按解码后字节限），文件名是 `image-{uuid}.{ext}`（**不含任何远端输入**）并落在下载目录 | 不适用(理由)：单次文件操作 | PASS `delete_file` **只允许删下载目录内的文件**（两侧 canonicalize 后按**路径分量**比）；`open_file_native` 把信任边界收到**对象**：必须与台账里那条路径一致，台账未建立时**只放行本机发出的消息**（对端写不了 `sender_id`），无 owner 的只剩收藏入口且只允许 `favorites_dir`——注释写明「只校验『落在托管目录内』挡不住『托管目录内的任意文件』，对端先前投递的 `.command`/`.app` 也算」（SEC-01/SOL-01） | PASS 拒绝有**两条不同的用户文案**（"这个文件不属于这条消息" / "无法确认这个文件属于本应用"）；并记着 Windows 的坑：边界判定用 canonical、**打开用原始路径**——`ShellExecuteW` 不支持 `\?\` 前缀，"顺序不能反，反了就是安全了、但你最常按的那个按钮在 Windows 上死了" | PASS `files_tests` 对 `path_under_any` 有 3 个用例，含 `/app/data/downloads_evil/x.png` **必须被拒**（分量比对 vs 字符串前缀的分水岭）；`ledger_path_owns` / `transfer_id_of_owner` 同族 | PASS **拒绝时用具名码并留痕**：`code=OPEN_PATH_UNBOUND` / `code=OPEN_PATH_NOT_OWNED`，日志带 `file=` 与 `owner=`，并写明「真机有没有合法用例被这条挡住，只有那条日志知道」 | **PASS** |
| F-GRP-005 | 群内消息操作：表情回应 / 置顶 / 撤回 / 渲染切换 | PASS 都要求目标非空；回应只接受本应用已知的 `[名字]` 表情 token（`is_valid_emoji_token`，避免任意字符串落库/超长内容进广播） | 不适用(理由)：回应是静默事件；撤回本身不可再撤 | PASS **回应走与普通群消息完全相同**的可靠管道（E2EE + outbox + GroupAck + 幂等去重 + 离线补发），只是接收端不计未读、不改预览、不弹通知——注释写明「否则『回个表情』会和发一条消息一样吵闹」；置顶是 LWW 折叠；撤回与 1:1 同形（账本+物化两笔 `.ok()` ⇒ B1-F6 族） | PASS **权限按可逆性分档**：置顶**任意群成员**（「置顶错了再取消即可，不必引入管理员角色」）；撤回**仅原作者**（「不做群主撤他人——那需要引入管理员角色，而没有中心权威就没有中心授权」）；并记着一个已修的 bug：置顶原先返回 `()` ⇒ 事件进不了前端 store ⇒ 折叠 `foldPinned` 看不到、要重进会话才刷新 | PASS 有 `reaction` 20 断言轮（CDP）与键盘出口探针 | PARTIAL 无具名 `code=`；撤回那两笔 `.ok()` 并入 B1-F6 族 | **PARTIAL** |
| F-PLF-013 | 窗口原语（最小化 / 最大化 / 是否最大化 / 关闭 / 原生标题栏按钮） | PASS 六个命令（desktop + mobile 两份桩）都在注册表；`window_toggle_maximize` 先判"这个窗**打算**可最大化吗"再动手 | 不适用(理由)：窗口原语是即时动作 | PASS **关闭语义按窗口分档**：主窗口 = **隐藏**（托盘语义，关窗 ≠ 退出，与 `tray.rs` 的 CloseRequested 一致）；辅助窗口 = `close()`，但"关了是藏还是销毁"由各自的 `AUX_*_RESIDENT` 决定，常驻那几扇已由 `install_hide_on_close` 拦下 | PASS 最大化判据**换掉了会撒谎的 API**：`is_maximizable()` 在 macOS Borderless 窗上恒假 ⇒ 改成显式白名单 `MAXIMIZABLE_WINDOWS`（含义是"我们打算让它可最大化"，与平台能力分开），白名单与 `logs.rs` 的 builder 由 `window_maximizable_matches_builder` 测试**交叉核对**；`window_is_maximized` 仍读 tao 真值（并说明 Borderless 下靠 `is_zoomed()` 比对 frame 与 visibleFrame） | PASS `window_maximizable_matches_builder` 交叉核对 + `lib_window_tests` | 不适用(理由)：窗口原语失败静默是设计（`let _ =`，不影响业务结果），没有"事后追溯某次最小化"的需求 | **PASS** |
| F-PRS-002 | 节点表读取 / 应用前台状态 / 运行诊断 | PASS `get_peers` 排序后返回并在命令里补 `Peer::link`；`set_app_active` 用**原子交换**作唯一判据（只对真翻转做事）；诊断命令只读 | 不适用(理由)：读操作或单次状态翻转 | PASS `set_app_active` 从后台回前台会**额外 wake 一次扫描**（立刻补一轮，不等完 30s 慢周期）；BLE 节奏 5s/30s 切换且「进程被杀则扫描随进程消失，无需额外代码」；热路径纪律：日志落盘搬进阻塞池，而**原子交换留在 await 侧**（它是判据，不能排到池子后面）；同一函数里还记着一个 clippy 1.98 的坑（非 bluetooth 构建下"提前 return"会成末语句触发 `needless_return`） | PASS **链路类型只在命令里补、事件里恒 `None`**（`links` 是异步锁，节点推送是同步上下文），而界面**只认「字段存在且是 bluetooth」**：以前用 `ip || 蓝牙直连` 反推会把同一 Tailscale 网段（Routed）的设备也标成蓝牙直连（用户 2026-09-12 实测）——这是「别用一个事实反推另一个事实」的现场 | PARTIAL 有 `lib_tests` 与探针；`RuntimeDiag` 的 Rust 字段与 TS interface 有「逐字对应」判据（`src/api/events.test.ts`，我实跑 17/17 的那批里就有它） | PARTIAL 无具名 `code=`；但诊断命令本身就是诊断出口，缺口小于业务命令 | **PARTIAL** |
| F-PRE-015 | 读取设置 / 恢复默认设置 | PASS `get_settings` 返回**显式 14 字段**（`theme_color`…`peer_styles`），不是整表 dump ⇒ `gk:{id}` 群密钥与身份私钥根本不在交出值里（INV-P18 的边界由类型形状保证） | 不适用(理由)：读操作 / 一次批量删键 | PASS **恢复默认用显式键清单而不是清空整表**：保留 device_id / x25519_secret / ed25519_secret / 好友 / 聊天记录；**刻意清掉中继口令**（`RELAY_TOKEN_KEY`）并写明理由「留着它比清掉更糟——机器上仍存着一个通往公网的准入口令，而界面上已经看不到这个功能在哪儿配的」；删完**同步重置内存缓存**（relay policy 回默认 All + 热设置缓存失效），否则「用户点了恢复默认、行为却还是旧的限制策略（要重启才生效）」 | PASS 缺省值有合理兜底（`notify_enabled` / `notify_show_content` 缺省 `Some(true)`）；恢复默认后向**其它窗口**广播变更（发起窗口已自行应用，不回发） | PARTIAL 有设置相关测试；**「恢复默认后行为立即生效」这条没有具名判据**（代码注释里那份理由目前只靠人记得）⇒ 待补 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-PLF-014 | 另存复制 / 剪贴板文件 / 媒体预览读取 | PASS `copy_file` 有 Android `content://` 分支；`copy_file_to_clipboard` 先判文件存在；`read_file_preview` 经 `resolve_media_path` 三态解析 | 不适用(理由)：单次文件/剪贴板操作 | PASS 三处都挪进阻塞池并写明理由：`copy_file` 是**任意大小**（600 MB 会把一个 worker 按在磁盘复制上数秒）；**剪贴板是系统级独占资源**（别的程序开着要等，Windows 还带 10 次重试）；预览的 `canonicalize`+`read` 可能落在慢盘/网络盘。`copy_file` 的注释还顺带更正了一条普遍误解——**`#[tauri::command(async)]` 挂在同步 `fn` 上不是豁免**（宏把函数体放进 `spawn` 的 future，跑的是 tokio worker），并引到 tauri-macros 2.6.3 / tauri 2.11.5 的具体行号 | PASS 预览有 `max_bytes` 且夹到 15MiB；`TOO_LARGE` 与「文件不存在」各有前端回退（回退文件卡片 / 渲染成「已清理」占位），不是空白也不是错误弹窗 | PARTIAL 有 `helpers_tests` 同族；「超限必须拒」这类断言本轮未逐条读 | PARTIAL 无具名 `code=`（并入 B1-F1 族）；剪贴板失败有具体中文原因 | **PARTIAL** |
| F-GRP-006 | 退群 / 群列表 / 待办图片落盘 | PASS 退群要求**群主先转让**（否则该群永久失去管理权）；待办图片只接受 raw body + **按 magic bytes 白名单**（`sniff_media_ext` 读首 16 字节，只放 jpg/png/gif/webp/bmp）——改名的 `.command` 混不进来 | 不适用(理由)：退群是一次本地清理 + 一轮通知 | PASS 退群**先通知其余成员、再删本地记录**（成员表要在删除前取）；离线成员的 `GroupMemberLeft` 会丢，但注释说明**成员表会随后续群消息（Gossip group_members / GroupKey）自愈**；本地清理复用「被移出群」同一条路径 `db::delete_group` | PASS 待办图片有大小闸（`todo_image_size_guard`）+ 格式闸，错误文案具体（"图片数据为空"/"只支持粘贴图片"）；写盘进阻塞池（几 MB 截图不卡 async runtime） | PARTIAL 有 `todos` 单测与群轮次；退群/被移出的跨实例行为仍缺轮次 | PARTIAL 退群时 `DELETE FROM settings WHERE key = 'gk:…'` 是 `let _ =`（失败则留下孤儿群密钥，与 B3-F2 同族）；无具名 `code=` | **PARTIAL** |
| F-OBS-010 | 前端健康：心跳 / 慢操作 / 前端异常 | PASS 心跳是**唯一**允许每秒一次的 IPC，且**不进前端的 invoke 追踪表**（否则自我递归）；`current_op` 截到 120 字符 | 不适用(理由)：都是即时上报 | PASS 看门狗靠心跳时戳 + `active` 判渲染层是否卡死；慢操作**只写一行日志、不回传事件**（避免形成回环） | PASS `log_frontend_error` 的理由写得很实：「界面『点了没反应』最常见的原因就是**一次 JS 异常**，而前端异常此前**不留任何痕迹**」——所以它是一条**现成的落点**（B1-F4 / B1-F5 的修法可以直接用它，不必新造通道）；文本截到 2000 字符 | PASS 有心跳/看门狗断言（`lib_window_tests.rs:994`「渲染层完全卡死时必须发系统通知」） | PARTIAL **同一族里码不一致**：`report_frontend_slow_op` 有 `code=SLOW_OP`，而 `log_frontend_error` 只有 `[前端 kind]` 前缀、没有 code | **PARTIAL** |
| F-PRE-016 | 界面语言切换 / 聊天样式广播 | PASS `set_ui_language` 先记 hint（macOS 菜单与后端文案的依据），非 macOS 下菜单模块整体不编译但**命令保留**（前端不必按平台分支）；`broadcast_chat_style` 广播给所有已连节点 | 不适用(理由)：单次状态广播 | PASS `set_ui_language` **刻意不发 `settings-changed`**——注释记着一个被修掉的**事件乒乓**：另一窗口收到 → 重拉设置 → `applySettingsSnapshot` 结尾无条件 `pushUiLanguage()` → 又调回这条命令 → 再发一次；`broadcast_chat_style` 同 `update_profile` 的纪律：**锁内只克隆发送端、发送在锁外**（否则一条拥塞链路就能握着全局 links 锁把整个网络层含看门狗拖死） | PASS 大载荷的风格帧按**唯一分类表**降级为 `Low`、不占聊天道；语言切换即时反映到菜单 | PARTIAL 有「设置变更事件两端都在」等回归（我实跑 17/17 那批里）；语言/样式的跨进程行为无轮次 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-OBS-011 | 一键重启 / 上一轮退出原因 / 测试通知 | PASS `restart_app` 立即返回（"前端等不到——进程会重启"），真正收尾在独立线程；`get_previous_exit` **不做文件 IO**、直接返回启动时缓存的报告（"启动路径不该再等一次磁盘"）；`send_test_notification` 显式忽略总开关（用户显式要试）并**如实返回失败原因 + 平台提示** | 不适用(理由)：重启是进程级动作、其余是读取 | PASS 重启复用托盘同一个入口 `restart::request_restart`（有界收尾 → 销毁单实例锁 → 重启），与「重启与单实例」那条既有纪律一致；上一轮退出原因在启动时已落定，读取零成本 | PASS 测试通知的注释点明它的存在意义：「Windows 上通知失败可能完全静默（未注册 AUMID / 专注助手 / 系统里关掉），没有这个入口用户只能描述『收不到』」——但**系统静默丢弃时 `show()` 仍返回 `Ok`**，于是最需要它说话的那一格会说"已发送"（**B4-F3** 的精确缺口） | PARTIAL 有 `lib_window_tests` 的托盘/看门狗断言；重启链路属既有实现 | PARTIAL 重启与测试通知都无具名 `code=`（测试通知失败有 warn 文案） | **PARTIAL** |
| F-MSG-002 | 发群消息（text / code / merge / 群强提醒） | PASS kind 白名单 + merge 载荷预校验；`mentions` 是**三态**：缺省=不发这个键（接收端按昵称兜底）/ 空数组=明确回答「谁都没 @」/ 有值=点名，上限 64 | 不适用(理由)：单次提交；未送出前取消归 F-MSG-014 | PASS 群强提醒**只提醒 actors 点名的成员、绝不默认全群**：群帧共享群密钥 + gossip 广播，物理上人人收到同一帧，但**只有 actors 设备允许触发提醒与回执**；而且**出帧前的受众校验是承重件**——目标消息必须是本群真实一行、`actors` 按**现读成员**劈分、**没有有效受众一律拒发**（注释原文） | PASS 拒发有具体原因；`mentions` 不落库的理由指到 `state::MessageRecord.mention_targets` 字段文档（单处说明，不重复） | PARTIAL 有 group 37 轮与消息族测试；**群强提醒的受众劈分没有跨实例轮次** | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-FIL-006 | 文件发送统一入口 / 传输表读取 | PASS `send_file_auto` 是薄包装，统一走 `send_file`（注释：直连 + 离线队列，「只要好友最终上线，文件就会在连接事件触发时自动补发，不再依赖不可达的中继路径」） | 不适用(理由)：发送入口是单次提交，取消归 F-FIL-001 | PASS `get_transfers` 整读进阻塞池，并再次点明「挂在同步 fn 上的 `#[tauri::command(async)]` 不是豁免」（INV-P34 推导在 `helpers.rs`）；**DB-03 之后 `list_transfers` 本身是有界的**（未完成 + 最近 N 条终态），所以不再随历史行数线性变慢 | PARTIAL `get_transfers` 用的是 `db::list_transfers(...).unwrap_or_default()` ⇒ 读失败会显示"没有传输"，与 B1-F7 同族（此处只读展示，自愈） | PASS 有 10 组文件故障注入轮 + `-lie` 反向对照 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-FRN-003 | 同意 / 拒绝好友申请 | PASS 先要求该申请**确实还在待处理列表**里（否则报"好友申请不存在或已处理"），避免对过期 UI 动作 | 不适用(理由)：单次决策 | PASS 同意走**唯一**实现 `accept_friend_request`（落库→回执→清 pending→通知 UI）；回执发送失败时**记一行并保留登记待补发**（"已登记待补发"），然后才 `forget_pending_request` + emit。拒绝：回执尽力而为，但**绝不因此阻塞本地清理**——注释写明理由「否则『拒绝』发不出去会导致 pending 不被删除、申请『清掉又冒出来』」 | PASS 同意/拒绝各自 emit 独立事件；失败有具体日志 | PARTIAL 有 `lib_friend_identity_tests` 断言族；跨进程仍无 J4 轮次 | PARTIAL **一处残余**：拒绝回执若始终发不出去，本地已清理但**对方的 `pending_out_requests` 仍会在建链/Hello 时补发申请**（对方侧没有"被拒"的终态）⇒ 对端可能反复重发；属 P3 级语义缺口，本轮未立案 | **PARTIAL** |
| F-FIL-007 | 手动取消一条没传完的文件（1:1 与群共用） | PASS 一个入口同时覆盖发送中与接收中；结果里带 `notified_peer` | PASS 本机收尾走 `apply_local_cancel`（与「对端取消」共用同一条终态路径） | PASS **顺序即语义**：通知名单必须在收尾**之前**读——`apply_local_cancel` 会把成员行落成 cancelled，之后再看就只剩「已经取消的」，**谁都收不到通知**；通知只在**对端声明了 `CONTENT_FEATURE_FILE_CANCEL`** 时才发（INV-P24 第 4 条），老端不发 ⇒ 它那边行为与今天完全一致（继续收发到自己的 deadline）。三种通知形状（1:1 / 群·我方发送 / 群·我方接收）**只读一次台账**分清，且**刻意放在 `apply_local_cancel` 之外**——那函数也被「对端已取消」复用，写进去会造成「收到取消 → 又回一条取消」的回声 | PASS `notified_peer` 回填后界面能说「对方可能仍在继续」——这正是"取消只是本机停手"这一语义的诚实表达；取消记 `cancelled` 而非 `failed` | PASS 10 组文件故障注入轮覆盖取消路径；`cancelFeedback` 六档文案有 6 条断言 | PASS 取消路径有具名码族（`FILE_CANCEL_LIST_FAILED` / `CANCEL_COMMIT_FAILED`），且失败分支留痕 | **PASS** |
| F-CNT-003 | 取消内容取回 | PASS 空 `cid` 直接拒（"这条内容没有内容指纹，无法取消"）；SQLite 读写与 `.part` 删除都在阻塞池 | PASS 取消走统一终态出口，不会只改界面 | PASS 返回**三字段结构化结果** `{already_done, stopped, ledger_committed}`——`stopped>0` 说明本机确实有一路在收；`ledger_committed=false` 时界面该说「本机已停止、状态待刷新」（而不是谎报已完成） | PASS 三态各有对应文案（前端按 outcome 分支，`TaskCenter.vue:217-228`） | PASS `contentpull` 36 断言轮 + `cancelFeedback` 六档断言 | PARTIAL 无具名 `code=`；台账写的失败经 `ledger_committed` 表达但**日志里没有对应一行**（并入 B1-F1 族） | **PARTIAL** |
| F-FRN-004 | 删除好友 | PASS 删前**先取消在途发送**——注释写明"否则 outbox 删了、发送任务却可能把 transfer 写回 active" | 不适用(理由)：关系解除是即时决定 | PASS 顺序与语义都写清了：先解关系（这次调用的事实），再顺带清 file_outbox / 样式缓存（失败不阻断，因为是缓存）；**`fail_pending_messages_for_peer` 是 D5-A（用户 2026-10-25 拍板）**：关系没了，还挂在补发队列里的消息永远没人收 ⇒ 一起清队列并落 **`failed` 而不是 `cancelled`**（"用户取消的是『我不发了』，这里是『发不成了』"）；清理失败**必须留痕**，否则那些消息会永远停在「发送中」而日志里一个字都没有 | PASS 落 failed 后气泡与任务中心都会说话；聊天记录**保留**，对方仍出现在扫描列表可重新添加 | PARTIAL 有 `friends` 相关测试；删除的级联范围未见具名判据 | PARTIAL 清理失败有 `logger.error`（friend 域）但无具名 `code=` | **PARTIAL** |
| F-PLF-015 | 媒体存在性 / base64 另存 / 剪贴板文件路径 | PASS `media_present` 每条媒体气泡都会问一次，仍进阻塞池（审计 R-18）；`save_data_file` 有 Android `content://` 分支；`read_clipboard_file_paths` 区分「真实文件」与「位图」 | 不适用(理由)：单次检查/写入/读取 | PASS 三处都挪出 worker 且理由不同：媒体检查是**每条气泡都问**、另存是无上限整文件写、剪贴板读**每按一次 Ctrl+V 打一次**（且可能被别的程序占住）。`read_clipboard_file_paths` 读不到（格式不符/被占用）一律按「无文件」处理，前端回退到图片粘贴分支 | PASS **`media_present` 的极性是刻意不对称的**：只有能确定「文件已被删除」才返回 `false`；查不到（如尚未落库的乐观消息）一律按「存在」——注释写明「绝不能把在途消息误标成已清理」。这与 B1-F7（把未知折叠成空）方向相反，而**这里的方向是对的**：假阴性（把在途说成已清理）比假阳性更糟 | PARTIAL `save_data_file` 明确写着**体积没有上限**（「前端解多大我们就写多大」）——用户自选文件场景下可接受，但属登记的开放面 | PASS `helpers_tests` 覆盖同族纯函数；`resolve_media_path` 三态有断言 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-PRE-004 | 任务中心「消息还没送到对端」行读取 | PASS 有界读（`MESSAGE_OPS_LIMIT`），db 读取进阻塞池 | 不适用(理由)：纯读 | PASS **错误是 `??` 往上抛，不是折叠成空**——与 `get_transfers`（`unwrap_or_default`）形成对照，说明本仓对"读失败该怎么办"没有统一教条，而是逐处按"哪种错更贵"定 | PASS `peer_offline` 在**锁外**用 `has_link(peer).await` 补：链路是内存里的事实，而前端拿到的 `peers` 是"发现过的邻居"、按它判会把刚掉线的对端说成在线（用户看到的是一句假的"发送中"）——注释原文 | PASS 返回结构里带 `can_cancel` / `some_delivered` 等字段，前端不必自己推 | PARTIAL 有 `taskCenter.test.ts`（22 条）+ task 49 轮；**"读失败必须变 Err"没有具名判据**（与 B1-F7 要补的是同一族） | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-GRP-007 | 群读取面（群列表 / 群已读名单） | PASS 两条都在阻塞池里读 | 不适用(理由)：纯读 | PASS 只读，失败在下一次成功读时自愈 | **FAIL** 两条都是 `db::…().unwrap_or_default()` ⇒ 读失败时**整个群列表消失**（与"会话列表消失"同档的假陈述）、已读名单变空 ⇒ **B1-F7**（后来扩进去的两处） | PARTIAL 有 `group` 轮次；"读失败必须变 Err"仍无判据（与 B1-F7 要补的是同一族） | **FAIL** 错误被 `unwrap_or_default` 吞掉，无日志无事件 ⇒ **B1-F7** | **PARTIAL** |
| F-PRS-003 | 通道启停 / 缓存策略与立即清理 | PASS `set_channel_enabled` 开局域网时**沿用用户已选网卡**（`start_from_prefs`，注释：不再硬编码 0.0.0.0），关时走 `network::stop`；返回**新的运行快照**（发起窗口零额外 IPC） | 不适用(理由)：开关是即时动作 | PASS 蓝牙显式开启成功会**清掉「上次崩溃后的自动暂停」**（区分"用户决定再用"与"崩溃自动暂停"）；`clean_cache_now` 的文件遍历/删除在阻塞池，且**绝不持全局 db 锁做**——注释记着旧形状的后果「用户点一下『立即清理』，整个应用冻住」 | PASS 清理前先读策略、清理后用 `CleanupReport` 回报；失败记 `logger.error` 并返回 Err；文档写明**不删聊天文字**、被清媒体在历史里将无法再打开（`media_present` 据此显示「已清理」占位） | PASS `retention_removes_expired_only` 等真库测试 + `lan_autostart_backoff` 测试 | PARTIAL `db::set_lan_enabled(...).ok()` 是尽力而为（写失败时"这次起来了、下次不会自启"，无痕）；清理侧有 `CACHE_CLEAN_*` 一族码但无统一入口码 | **PARTIAL** |
| F-PRE-017 | 外链增改 / 收藏删除 | PASS 外链添加有数量上限（20）与 URL 规范化；收藏删除对"已不在收藏里"**幂等返回 Ok** 不报错 | 不适用(理由)：单条记录的增删 | PASS **外链的读-改-写必须在同一把 db 锁里**——注释写明理由「规范化判据要看**当前列表**，搬出来就是另一份读、另一个答案」；**收藏删除的顺序是算过代价的**：先删记录、再删副本文件，因为「先删文件而删记录失败，会留下一条**打不开**的收藏（比『删了记录但文件没删掉』差得多——后者只占磁盘，用户看不见）」；删文件只允许在收藏目录内（canonicalize + `starts_with`），失败只记日志不回滚记录 | PASS 添加返回**更新后的完整列表**（前端不用再拉一次）；越界与规范化失败都返回具体原因 | PASS 有 `favorites_tests`（含撤回与收藏交互）；外链有 `updaterManifest` 同族的纯函数测试 | PARTIAL 无具名 `code=`（并入 B1-F1 族） | **PARTIAL** |
| F-RTG-003 | 跨子网端点 / 中继配置 | PASS `add_routed_endpoint` 的 `device_id` **可省略**（身份由 TCP 握手学来：`IP:PORT → TCP → Hello → Node ID → Identity`，注释称之为「少配置」）；地址接受 `ip` 或 `ip:port`（省端口按标准端口补全），**只收 IPv4** 并写明原因（监听侧绑的是 `Ipv4Addr`，IPv6 拨出去也连不上）；中继口令有长度上限（128）与"最长口令仍塞得进服务器行"的用例 | 不适用(理由)：单条配置写入 | PASS 两处都是**读-改-写整段在同一把 db 锁里**（新增/去重判据要看当前列表）；端点**按地址去重**、不看是否带 `device_id`（"一个地址只对应一个端点"） | PASS 越界/规范化失败返回具体原因；配置变更走既有的设置事件广播 | PASS 端点解析与口令校验各有纯函数测试 | PARTIAL 无具名 `code=`；`check_relay_server` 的失败分类本轮未读 | **PARTIAL** |
| F-PLF-016 | 更新链内部：检查 / 下载 / 状态 / 安装 / 关闭 | PASS `updater_download` 用 **`compare_exchange(false,true)`** 挡并发（第二次直接报「更新已在下载」）；下载前 `update.timeout = DOWNLOAD_TIMEOUT`（有界） | 不适用(理由)：下载的取消归 `updater_cancel`（F-PLF-007） | PASS **取消句柄是闭环的**：download 里登记 `Notify`，`updater_cancel` 取走并 `notify_one`（两者我分别读过）；安装相位的 future 被丢弃由 `InstallingPhase` 的 `Drop` 收尾，避免相位永久停在 `installing`（那会让取消永远被拒、界面永远转圈）；状态机 `idle→checking→downloading→ready→installing` 与 `failed/cancelled/unsupported` 全在内存 | PASS 进度经 `Channel` 推送并节流（`last_emit_ms`）；每次相位变化都 `set_status` 并广播；`downloaded/total` 逐块更新 | PARTIAL `updater_status` 是**唯一真相源**（设置窗与任务中心首帧都靠它补拉），但**没有具名 `code=`**；`updater_check` 的失败分类本轮只读到 `Err → phase=failed + error` 这一层 | **PARTIAL** |
| F-OBS-002 | 前后端契约双向对账（161 命令 / 事件面） | PASS 门面唯一：`IPC 只能从 src/api 门面走`（含「6 条命令在 api 上根本没有包装」的回归） | 不适用(理由)：这是判据不是用户操作 | 不适用(理由)：同上 | 不适用(理由)：同上 | **PASS（我实跑）** `node --test src/api/events.test.ts src/utils/mapContract.test.ts` ⇒ **EXIT=0，17/17**；另独立 `comm` 复算：注册 161 / 去重调用名 160，孤儿仅 `get_topology`（`events.test.ts:375` 自declare 无 UI 入口） | PASS 命令名与注册表逐条对账、「门面之下不许留没人引用的包装」都是现成判据 | **PASS** |
| F-OBS-003 | 诊断面：错误分类 / 上限 / 脱敏 / 访问控制 | 不适用(理由)：非用户动作 | 不适用(理由)：同上 | PASS 单文件 512 KB 轮转（`logging.rs:140/1070`），有真文件读写测试 `logger_persists_to_file_and_rotates:1715` | 部分：日志窗口有独立 entry（`logs.html` + `src/entries/logs.ts`），用户可查 | **已证**（上两行测试名 + 我跑通的对账族） | **PARTIAL** 具名 `code=` 共 **87** 个、日志调用 363 处（error 81 / warn 129 / info 153），覆盖面广；但**关键操作结局缺码**（B1-F1）；脱敏是形状级（`diagnostics.rs:19-22`，作者自述并保留文件名/大小以便查传输故障）⇒ 隐私与可查性是**登记过的取舍** | **PARTIAL** |

## 二、状态机与跨层一致性（逐转移）

**读法**：每张表只写**读到过证据**的转移；没读到的写「待核」，不猜。列的含义：**唯一写入方**指"谁能决定这个状态"（多处都能写就必须写清谁有最终裁定权）；**落库时点**指崩溃后靠什么恢复。

### 2.1 1:1 消息

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

### 2.2 群消息（成员级）

| 转移 | 触发 | 唯一写入方 | 落库 | 语义 | 证据 |
|---|---|---|---|---|---|
| （无）→ 每成员一行 `pending` | 发送 | `insert_group_outbox` | 与消息同批 | 一条群消息 = 每成员一行 | `db/group_offline_queue.rs:7` |
| `pending` → `delivered` | 成员 `GroupAck` | `ack_group_delivered` | 单事务；delivered 墓碑按条件删 | 只有 `prior == pending` 才把**消息**推到 delivered | `:49-101` |
| 迟到 Ack（行已 cancelled/failed） | 成员 Ack | 同上 | 只改行 | `LateApplied`：**绝不把 cancelled 提成 delivered**（有测试） | `cascade_tests.rs:1188-1203` |
| `pending` → `cancelled` | 用户取消剩余成员 | `cancel_queued_group_message` | 单事务 | 已 delivered 的行不动；有 pending 才能取消 ⇒ 可能落 `partial_cancelled` | `:103-117` |
| 行 → `failed` | 逐行过期 | `outbox_sweep` | 行标 failed（**不删**） | 删了就再也说不清"谁没收到"；`delivered>0/cancelled>0` 时**不折消息为 failed** | `outbox_sweep.rs:246-311` |
| 全行放弃且无人收到 | 期限到 | `finalize_expired_message(group=true)` | 单事务 | 写成功才 emit `message-failed` | `:340-359` |

### 2.3 文件传输

| 转移 | 触发 | 唯一写入方 | 落库 | 语义 | 证据 |
|---|---|---|---|---|---|
| （无）→ `pending`/`active` | 发起/接受 | 发送/接收侧 | `file_transfers` | 群里另有 `group_files`/`group_file_recipients` 一本账（FUNC-03 记着幽灵行旧缺陷） | `db/file_transfer.rs:186-191` |
| 任态 → `done`/`failed`/`cancelled` | 唯一终局出口 | **`finalize_file_failure`**（顺序：气泡→台账→关队列） | 单事务 | `done` **不降级**；`failed` 可被下一轮重新激活（有测试） | `db/file_transfer.rs:23-34,120-180` |
| 写盘失败（含盘满） | chunk 写错 | `fail_receive` + 回否定确认 | — | 立即告诉发送端停；但**盘满这一档不分类、且保留 `.part`** | **B2-F1** |
| 用户取消 | 点取消 / 对端 `FileCancel` | **`apply_local_cancel`（两者共用）** | 单事务 | 点亮所有在途槽位 → 停接收 → 落库 → emit；`by` 只进日志 | `commands/files.rs:776-800` |

### 2.4 其余有生命周期的对象

| 对象 | 状态与出口 | 持久化 | 备注 |
|---|---|---|---|
| `outbox` / `group_outbox` / `file_outbox` | 行只在 Ack/GroupAck 后删；否则按期限或次数收口 | 三张表 | 发送侧崩溃窗口由"消息+队列同事务"关闭 |
| 内容取回 `content_transfers` | `queued/active/verifying → complete / rejected / incomplete` | 表 + 磁盘 | 8 次退避后 `Rejected`（终态，不再自动重取）；`incomplete` 是"还能再取" |
| 更新器 | `idle/checking/downloading/ready/installing/failed/cancelled/unsupported` | **无（纯内存）** | 重启即丢；`installing` 不可取消（**B1-F3** 边界无守卫） |
| 任务中心 | `queued/running/blocked`（**派生**，无自有状态） | 无 | 只列未完成；状态由三张台账现读（F-PRE-003） |

---

## 三、缺失测试与故障注入计划

### 3.1 现有注入能力（实测，不是转述）

10 类故障 × `_lie` 反向对照：脏 `.part`、续传前缀复用、**部分写后崩溃（SIGKILL）**、对端冻结（SIGSTOP→超时）、接收目录只读（盘满近似）、改名失败、源缩小竞态、同名多文件、100MB 中途停滞、**发送方中途崩溃**。另有 `groupcrash` / `gossip-late` / `lanoff` / `task` 等轮次。**每一轮都读真二进制、真 TCP、真 SQLite 行、真 sha256**。

### 3.2 **没有**注入能力的类别（这正是缺的测试）

| 缺的注入 | 为什么重要 | 最小可行做法 |
|---|---|---|
| **用户取消经 IPC** | 5 条取消通道的"取消 vs 完成"竞态只能靠真取消触发 | 在 `group`/`gfile` 轮里加一步：发送中途调 `cancel_message`/`cancel_file_transfer`，断言终态是 `cancelled` 且**不被迟到 Ack 改写** |
| **重复 / 乱序 / 迟到帧** | 去重与 `LateApplied` 只有单测，没有跨进程证据 | 用代理重放同一帧两次、把 Ack 延迟到超时之后 |
| **DB busy / 写失败** | **B4-F1** 与 **B1-F6** 都只在"写失败"时才现形 | 在隔离库里加一个一次性失败注入（如 `PRAGMA` 触发 busy），断言落 failed 或重试，而不是静默 |
| **任意点崩溃**（而非定时 kill） | "提交前/后"窗口是状态机正确性的核心 | 在 `insert_message_and_outbox` 前后各插一个 kill 点，断言重启后要么有消息有队列、要么都没有 |
| **盘满的真实形态** | 只读目录只是近似；**B2-F1** 要的是 ENOSPC | 小容量挂载或 `ulimit -f`，断言 `.part` 被删且界面说"空间不足" |
| **网络分区 / 丢包 / 限速** | 现在只有"冻结"这一种 | `pfctl`/`tc` 在隔离网段做 10% 丢包 |
| **时钟漂移** | 消息排序依赖 `seq`，但"时钟钳制"路径没被测 | 把一端系统时间拨快/拨慢 |

### 3.3 前端行为面（这一层原本完全没有）

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

### A 级（计入覆盖）——**机器可数的清单**

下面这份清单是"我读过函数体或关键分支"的命令，**由脚本与 161 条注册表求交并报出拼错的名字**（不是手抄计数）：

```text
updater_download
save_relay_config
add_routed_endpoint
remove_favorite
add_external_link
clean_cache_now
set_channel_enabled
get_group_reads
get_groups
get_pending_message_operations
read_clipboard_file_paths
save_data_file
media_present
remove_friend
cancel_content_fetch
cancel_file_transfer
respond_friend_request
set_unread_badge
request_attention
shake_window
set_native_titlebar_buttons_hidden
window_close
window_is_maximized
window_toggle_maximize
window_minimize
get_transfers
send_file_auto
resend_message
send_group_message
cancel_message
recall_message
mark_read
send_message
get_messages
get_latest_messages
get_conversations
ensure_conversation
set_conversation_pinned
get_conv_link
get_message_count
search_chat_history
save_settings
reset_settings
get_settings
updater_cancel
update_profile
copy_file
copy_file_to_clipboard
read_file_preview
save_media_as
delete_file
open_file_native
save_outgoing_image
download_shared_file
send_group_file
request_content
delete_conversation
clear_all_data
get_safety_number
get_peers
set_app_active
send_friend_request
get_friends
get_pending_requests
create_group
distribute_group_key
group_add_member
group_remove_member
transfer_group_creator
rename_group
leave_group
update_group_todo
send_group_announcement
pin_group_message
send_group_reaction
recall_group_message
get_logs
clear_logs
get_log_locations
export_external_links
cleanup_external_links_export
import_external_links_file
import_external_links_from_url
ui_heartbeat
report_frontend_slow_op
log_frontend_error
get_previous_exit
restart_app
send_test_notification
export_chat_text
```

计数与校验（复跑即可；若我写错一个名字，它会出现在 `NOT-IN-REGISTRY` 里）：

```bash
python3 - <<'EOF'
import re
doc=open("docs/notes/closedloop-matrix-2026-10-26.md").read()
sec=doc.split("### A 级（计入覆盖）")[1].split("```text")[1].split("```")[0]
mine=[w for w in sec.split() if w]
lib=open("src-tauri/src/lib.rs").read()
m=re.search(r"generate_handler!\s*\[(.*?)\]\s*\)", lib, re.S)
reg={e.strip().split("::")[-1] for e in m.group(1).split(",") if e.strip()}
print("A-level listed:", len(mine), "unique:", len(set(mine)))
print("NOT-IN-REGISTRY:", [w for w in mine if w not in reg] or "none")
print("coverage:", len(set(mine)&reg), "/ 161")
EOF
```

### B 级（不计入覆盖，只说明链路形状）

`save_settings`（读了前端 `persistSettings` 与它的 catch，没读 Rust 侧）· `open_settings_window`/`open_log_window`/`open_group_todos_window`/`open_image_preview`/`prewarm_aux_windows`/`open_link_window`（读了 `#[tauri::command(async)]` 形状与 `ensure_aux_window` 的纪律，没读各自函数体）· `save_media_as` · `copy_file` · `save_data_file` · `start_network`/`stop_network`/`set_channel_enabled`/`get_runtime_snapshot`（只在快照与事件契约里见过）· `get_relay_config`/`save_relay_config`/`check_relay_server`/`list_routed_endpoints`/`add_routed_endpoint`/`remove_routed_endpoint`（只在设置页调用面见过）· `send_file_auto` · `request_share_tree` · `export_diagnostics_bundle` · `reset_settings` · `delete_messages` · `sync_friend_keys`/`get_friend_key_rotations`。

### C 级（仍未审）——**现算，不是手抄**

下面这份清单由脚本从 161 条注册表减去 A 级清单得到；**审完一个就往 A 级清单里搬一个**，下次重算自动缩短：

```bash
python3 - <<'EOF'
import re
sec=open('docs/notes/closedloop-matrix-2026-10-26.md').read().split('### A 级（计入覆盖）')[1].split('```text')[1].split('```')[0]
mine={w for w in sec.split() if w}
lib=open('src-tauri/src/lib.rs').read()
m=re.search(r'generate_handler!\s*\[(.*?)\]\s*\)', lib, re.S)
reg=[e.strip().split('::')[-1] for e in m.group(1).split(',') if e.strip()]
rest=sorted(set(reg)-mine)
print(len(rest), '条仍未审:'); print(' '.join(rest))
EOF
```

**当前仍未审（71 条）**：

`add_favorite` · `apply_macos_window_shape` · `broadcast_chat_style` · `cancel_group_history` · `check_relay_server` · `close_settings_window` · `default_nickname` · `delete_group_announcement` · `delete_messages` · `export_diagnostics_bundle` · `focus_window` · `get_cache_info` · `get_content_transfers` · `get_device_info` · `get_discovery_diag` · `get_downloads_dir` · `get_friend_key_rotations` · `get_group_delivery_summaries` · `get_group_file_delivery_summary` · `get_group_todo_messages` · `get_group_todos_context` · `get_image_preview_gallery` · `get_relay_config` · `get_runtime_diag` · `get_runtime_snapshot` · `get_share_dir` · `get_topology` · `import_picked_file` · `list_active_group_announcements` · `list_external_links` · `list_favorites` · `list_group_files` · `list_interfaces` · `list_routed_endpoints` · `notify_desktop` · `open_downloads_dir` · `open_group_todos_window` · `open_image_preview` · `open_link_window` · `open_log_window` · `open_settings_window` · `prewarm_aux_windows` · `read_content_preview` · `read_favorite_preview` · `remove_external_link` · `remove_routed_endpoint` · `request_ble_permissions` · `request_content_by_cid` · `request_group_todo_focus` · `request_share_tree` · `resend_group_delivery` · `save_todo_image_bytes` · `search_nearby_peers` · `send_group_todo` · `send_todo_image` · `set_cache_policy` · `set_downloads_dir` · `set_message_render` · `set_share_dir` · `set_ui_language` · `start_network` · `stop_network` · `sync_friend_keys` · `sync_group_history_now` · `take_group_todo_focus` · `todo_image_meta` · `update_external_link` · `updater_check` · `updater_close` · `updater_install` · `updater_status`

## 五、读数

现算（**只数判级列**，命令：`grep -cE '^\| F-.*\| \*\*(PASS|PARTIAL)\*\* \|$' docs/notes/closedloop-matrix-2026-10-26.md` ⇒ **71**）：已走完六格 **71** 行，其中 **PASS 10**、**PARTIAL 61**；另有若干行含「不适用(理由)」的格（不适用≠通过，也不计入这两档）。⚠️ **不要用 `grep -c '^| F-'`**——本文件第六节的「FID → 命令映射」表同样以 `| F-` 开头，那个命令会把两表相加（实测报 45）。立案 **14** 条（P2 九 / P3 五），保留 **6** 条，撤回 **6** 条。

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
