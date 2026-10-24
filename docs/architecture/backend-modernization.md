# Gosslan 后端基础设施现代化（5.0）——基线与迁移方案

> 版本与分支**现读**（`npm run version:show` / `git rev-parse --abbrev-ref HEAD`）· Rust 1.98.1 ·
> 目标平台 macOS/Windows/Linux/Android/iOS
> 真实库（只读核对）：`~/Library/Application Support/com.gosslan.app/gosslan.db`，
> `user_version=11`、**20 张业务表**（`grep -rhoE "CREATE TABLE IF NOT EXISTS ([a-z_]+)" src-tauri/src --include='*.rs' | awk '{print $NF}' | sort -u | wc -l`）、
> `journal_mode=wal`、`PRAGMA integrity_check=ok`。
> ⚠️ **下面各节的"19 张表"是 2026-10-19（5.0.32/5.0.33）那次演练的历史读数**，那之后
> 群文件 ACK 持久化账本（`group_file_acks` / `group_file_recipients`）落地 ⇒ 如今是 20 张。
> 本文是阶段 B 的选型/迁移方案；每批实施后回填读数，不把"计划"当"完成"。

## 1. 现状基线（只读审计）

| 领域 | 现状 | 已有成熟能力 | 主要缺口 |
|---|---|---|---|
| 数据库 | `rusqlite 0.31`（bundled），单一 `DbLock<Connection>`；`PRAGMA user_version` + `MIGRATIONS` 11 步 | 迁移链、每步事务、降级拒绝、失败回滚、重复启动、热查询索引、孤儿清理均有测试 | **无 `busy_timeout`**；**迁移前无备份/校验**；错误仍以字符串为主 |
| 并发/阻塞 | Tokio；慢活（哈希/落盘/重组）已用 `spawn_blocking` 并有源码判据 | `db_hold` 持锁观测、`check-lock-scope`、`lib_relay_data_tests` 慢活清单 | DB 长事务/备份/恢复仍会占住唯一连接；需逐路径量化 |
| 网络 | 自研 `network/transport`（1465 行）、discovery、mesh、gossip、relay、BLE | Tokio、socket2、现有协议与去重/可靠投递不变量 | 分帧评估后保留自研（约 30 行 + 12 条字节判据），小帧已合并写（5.0.24）；`tokio-util`/`bytes` 不引入 |
| 加密/身份 | x25519-dalek、ed25519-dalek、chacha20poly1305、sha2、rand_core | 成熟 crate；身份/签名/密钥格式已有判据 | 不更换算法/格式；只审计随机源与日志泄露面 |
| 系统集成 | Tauri 官方 notification/dialog/fs/opener/window-state/single-instance 已在用 | 官方插件优先原则已落实 | Windows 文件剪贴板等平台专用实现需逐项核对；移动端 API 差异 |
| 日志/诊断 | 自研 `logging.rs`（1439 行）+ 运行日志窗口 | 文件日志、前端异常上报、`db_hold` 观测 | 未用 `tracing`；缺稳定 span/关联 id（C/B 类，迁移成本高） |
| 错误 | 大量 `Result<_, String>` | 启动期 `InitError` 已用 `thiserror` derive（5.0.23） | 领域/基础设施错误未统一；其余边界按批迁移，不一次性扫全仓 |
| 测试/门禁 | 968 条 Rust 基线 + 前端 1060 + 338→341 UI 探针；`verify:local` 22 步 | 迁移、锁作用域、慢活、Android 编译门禁 | E2E/真机 NOT RUN；迁移的备份/恢复演练缺失 |

## 2. 依赖选型（A/B/C/D）

| 候选 | 判定 | 理由 |
|---|---|---|
| `rusqlite`（保留） | **A** | 现有 schema/迁移/事务/SQL 全在其上；替换为 SQLx 会重写 57k 行后端的全部 DB 边界，收益未证。保留但补齐 `busy_timeout`、备份、错误类型 |
| SQLite `VACUUM INTO`（内置） | **A** | 迁移前一致性快照 + 可打开/完整性校验；不新增 crate，不复制正在使用的 `-wal/-shm` |
| `thiserror` | **A（分批）** | 先在 DB/迁移/网络边界定义少量错误枚举；不一次性替换全部字符串 |
| `tokio-util` + `bytes` | **B** | 可能替换自研帧缓冲/拆包；需先做最小原型并证明协议字节不变，不能整层重写 |
| `tracing` / `tracing-subscriber` | **C（本轮保留）** | 自研 logger 已有文件/窗口/前端上报与多处判据；整体迁移风险高。先补 span 语义与关联 id 的评估 |
| SQLx + SQLx Migrate | **D** | 异步 SQLite 仍受单写锁限制；迁移成本覆盖全仓 DB，收益未证 |
| `refinery` / `rusqlite_migration` | **D** | 现有 `user_version` 迁移链已有完整失败/降级测试；换框架只增加依赖面 |
| `libp2p` / `iroh` | **D** | 会改变身份/发现/传输/协议模型，与现有 Gosslan 协议、离线可靠投递不兼容；不整体替换 |
| Tauri 官方插件 | **A（已在用）** | notification/dialog/fs/opener/window-state/single-instance 已落地；继续按官方支持矩阵逐平台核对 |
| `arboard` / 剪贴板插件 | **B** | 文本剪贴板可替换；Windows `CF_HDROP` 文件列表是产品语义，需单独验证 |
| `axum`/HTTP 服务等 | **D** | 当前无此调用面 |

## 3. 分批计划（数据安全优先）

### B1（已落地，5.0.22）：数据库迁移前备份 + `busy_timeout`
- `init()` 打开连接后设置 `busy_timeout=5s`（只读/写路径统一等待，而不是立即 SQLITE_BUSY）。
- 在**任何 schema 写入之前**，对"需要迁移的已有库"（`current < DB_VERSION` 且已有业务表）执行
  `VACUUM INTO <db>.pre-v{from}-to-v{DB_VERSION}-{pid}-{ns}.db`，然后：
  - 以只读连接打开备份；
  - `PRAGMA integrity_check` 必须为 `ok`；
  - `user_version` 必须等于迁移前版本；
  - 业务表数量必须与迁移前一致。
  任一不满足 ⇒ 以 `InitError::Backup` 中止，原库不改动，备份保留供诊断。
- 全新库、已是最新版本的库、未来版本（降级拒绝）都不备份。
- **实测（2026-10-19，5.0.22）**：
  - `cargo test --lib --features bluetooth db::migration_tests::` **33/33**；新增 8 条：
    快照完整性/数据保留、init 备份后迁移、fresh/current 不备份、降级不备份、`busy_timeout=5000`、
    1..10 每个起始版本重放保数据、损坏库拒绝且原文件逐字节不变、备份恢复后再次迁移。
  - Rust 测试基线 968 → **976**（macOS/Windows 同步）。
  - `npm run verify:local` **22/22、退出码 0、66.5s**（含 fmt/clippy/Rust 976/Android 编译）。
  - 真实库只读核对：`user_version=11`、19 表、WAL、`integrity_check=ok`；本批**未对真实库执行迁移**。
  - 回滚：删除新增备份/恢复原库即可回到旧行为；备份是独立文件，不改原库。
- 护栏：更新「数表必须早于 SCHEMA」注入锚点并单跑该护栏（改坏即 FAIL、恢复即 PASS）。
- **5.0.25 追加**：`every_4x_entity_survives_the_v7_to_current_replay_with_its_semantics`
  从 v7 重放到 v11，逐字段校验身份/好友/会话/消息/群+成员/群文件/单聊与群聊队列/文件任务/
  文件队列/收藏/逻辑时钟/已读 13 类实体，并要求 `integrity_check=ok`、无悬空外键、
  备份快照表数一致；Rust 基线 980 → **981**。真实用户库仍**只读核对、未执行迁移**。
- **真实数据副本演练（2026-10-19，5.0.28）**：对真实安装库做只读 `.backup` 副本（`0600`），
  副本置 `user_version=10` 后跑生产 `init`：**19 表、208 行**、v10→v11、备份 `integrity=ok`，
  逐表行数与 messages/friends/groups/settings/file_transfers 的关键字段聚合完全一致；
  副本与备份已删除，**源库未被修改**。这是真实数据体量/形状的演练，
  **不等于真实 4.x schema 的迁移**（真实 4.x 库不在此机器上）。
- **真实 v10 原始 DDL 判据（5.0.28）**：`docs/architecture/fixtures/v10_schema.sql` 逐字取自
  `git show 0b84f11^:src-tauri/src/db.rs`（v11 引入提交的父提交，DB_VERSION=10），
  18 张历史表建库后插入身份/好友/会话/消息/群/文件/队列/收藏数据，跑当前 `init()`：
  v10→v11 补齐 `mention_targets`，逐字段保留、`integrity_check=ok`、备份快照表数一致。

### B2（已落地，5.0.23）：启动期错误改用 `thiserror`
- `thiserror@2.0.21`（MIT OR Apache-2.0，MSRV 1.77；依赖树里已有）。
- `InitError` 的 `Display` / `Error` / `From` 样板改由 derive 生成：`Sqlite` 走 `#[from]` +
  `transparent`；`Backup` 保留原单行日志文案；降级只用 `downgrade_display` 保持单行技术描述，
  `downgrade_message` 的人话长文案不变。
- **实测（2026-10-19，5.0.23）**：新增 1 条 `Display` 判据（降级含两个版本号与"拒绝降级打开"；
  备份失败点名路径），迁移测试 **34/34**；Rust 基线 976 → **977**（macOS 977 / Windows 965）；
  `npm run verify:local` **22/22、退出码 0、85.8s**（含 fmt/clippy/Rust 977/Android 编译）。
  其余 `Result<_, String>` 边界仍留待后续批次，避免一次性扫全仓。
- 回滚：删除 `thiserror` 依赖并恢复手写 `impl` 即可，错误文案与类型不变。

### B3（已落地，5.0.24）：TCP 小帧合并写（`tokio-util`/`bytes` 评估为不替换）
- 现状审计：分帧只有「4 字节大端长度 + payload」约 30 行，已有 12 条字节级判据
  （往返、非法长度、预认证上限、大载荷、真实回环、seal 拆半）；读写循环已可被
  shutdown/cancel 打断，队列有字节预算。**真正的延迟缺口是每帧固定两次 `write_all`**：
  心跳/回执这类小帧会触发 Nagle + 延迟 ACK，最多卡 ~40ms。
- 改动：`transport::tcp::write_bytes` 对 ≤8KiB 的帧合并成一次 `poll_write`；
  大帧保持两次写，不复制整个分块。线上字节逐字不变。
- **实测（2026-10-19，5.0.24）**：先写判据并跑到红（小帧实测 2 次 `poll_write`），
  实施后 `transport::tcp::tests::` **12/12**、全量 Rust **979/979**；
  基线 977 → **979**（macOS 979 / Windows 967）；`cargo fmt --check` 与 gate 形状的
  `cargo clippy --features bluetooth -- -D warnings` 均退出 0。E2E/真机 **NOT RUN**。
- 选型：`tokio-util::codec` + `bytes` 不引入。`Framed` 只是把同一段分帧逻辑搬进新依赖，
  不会消除两次写；当前分层（业务序列化 / 字节分帧 / seal）也因此保持不变。

### B4（已评估，5.0.25）：不换 `tracing`
- 现有 logger 的同步落盘是崩溃现场与“最后一条日志”的证据前提：进程异常退出后，
  文件里必须已经有那一行；换异步写或整体替换会削弱证据链。`tracing` 仍要自己接同步 writer，
  只会增加迁移面；peer/transfer/channel 等关联字段已由现有日志承担。
- 本轮不引入 span 体系；若以后要做，按“关联 id → span → 采样”单独设计，不整体替换。

### B5（已落地，5.0.25）：预览读取移出 async worker + 系统插件核对
- `read_file_preview` / `read_favorite_preview` / `read_content_preview` 从
  `#[tauri::command(async)] + 同步 fn` 改为 `async fn` + `spawn_blocking`：
  三者都要 `canonicalize` 与最多 15 MiB 的 `std::fs::read`，慢盘/网络盘上会钉住 Tokio worker。
  15 MiB 上限与路径越权检查一字未改。
- 新增 1 条源码判据：三格必须在 `spawn_blocking` 之后读盘、读盘前不许跨 `.await`、15 MiB
  上限必须还在。注入一处 `spawn_blocking` 之前的读盘 ⇒ **FAIL**，恢复 ⇒ **PASS**。
- **实测（2026-10-19，5.0.25）**：全量 Rust **980/980**；基线 979 → **980**
  （macOS 980 / Windows 968）；`cargo fmt --check` 与 gate 形状的
  `cargo clippy --features bluetooth -- -D warnings` 均退出 0。
- 系统插件核对：notification / dialog / fs / opener / window-state / single-instance 均为官方插件
  且已在 `lib.rs` 初始化；`open_path` 的 macOS `NSWorkspace`、Android FileProvider、
  Windows/Linux opener 分派与注释一致。Windows 文件剪贴板 / Android JNI / iOS 沙盒仍为平台薄适配；
  **移动端与 Windows 真机 NOT RUN**。

### B6（已落地，5.0.26）：敏感文件权限收紧（Unix `0600`）
- 真实安装只读实测：`~/Library/Application Support/com.gosslan.app/gosslan.db` 与 `-wal`
  均为 `0644`，同机其他用户可读；库里存着身份密钥与全部消息。
- 改动：`db::init()` 打开主库后立即 `chmod 0600`；启用 WAL 后补收紧 `-wal/-shm`；
  `VACUUM INTO` 备份在校验前收紧为 `0600`。SQLite 新建侧车会沿用主库权限位。
- **实测（2026-10-19，5.0.26）**：显式把主库/侧车改回 `0644` 后重放 v10→v11，
  主库/侧车/备份全部 `0600`；Rust **982/982**；基线 981 → 982。非 Unix 无操作；
  权限设置失败只告警不阻断启动。E2E/真机 **NOT RUN**。
- 启动时扫描本库 `<stem>.pre-v…-to-v….db`，把 5.0.22–5.0.25 留下的 `0644` 备份
  补收紧到 `0600`；先做文件名匹配再 `stat`，同目录其它文件/目录不动。
  2026-10-24 审计 DB-02 起，同一处清扫还负责**保留份数**：只留最近
  `MAX_MIGRATION_BACKUPS`（3）份，排序口径与 `find_recovery_backup` 共用；
  删不掉旧副本不中止启动，但会落 `code=BACKUP_SWEEP_FAILED` 的日志。
- 2026-10-24 审计 DB-03 起，`file_transfers` 的快照读也不再是全表：`list_transfers`
  只回**未完成 + 最近 `MAX_TERMINAL_TRANSFERS`（200）条终态**，两腿各走一条索引
  （未完成走部分索引 `idx_file_transfers_open`，终态走 `idx_file_transfers_created`
  按序扫够就停）。不提供 OFFSET：截掉的终态行在界面上没有消费点（任务中心只列未完成、
  气泡按 `transfer_id` 点查、打开文件走后端按 msg_id 回查台账）。部分索引的写成本实测
  **每条 upsert +约 2µs**（20 000 条 275→315ms），且只随"同时在传的条数"增长。
- 边界：不改变目录权限（可能是共享临时目录）；Windows ACL 未在本批处理。

### B7（已落地，5.0.27）：日志与崩溃现场权限收紧
- 真实安装实测：`logs/*.log`、`*-crash.log` 均为 `0644`，日志里有 peer id、IP、文件名。
- 改动：抽出 `private_fs::restrict_to_owner`（Unix `0600`，非 Unix 无操作），数据库/侧车/
  迁移备份/运行日志/崩溃现场/启动路标共用一个实现；日志轮转后的 `.old.log` 保留原 mode。
- **实测（2026-10-19，5.0.27/5.0.28）**：启动路标、首条日志、以及**启动前已存在**的
  当前日志与 `.old.log`（预置 0644）构造后均 `0600`；Rust **983/983**；基线 982 → 983；
  `fmt`/gate 形状 `clippy` 退出 0。E2E/真机 **NOT RUN**。
- 边界：目录权限不动；Windows ACL 未在本批处理。

### E2E 实测（2026-10-19，隔离 HOME）
- 用干净 worktree 在 `824cadb` 构建 release，`HOME=/tmp/gosslan-e2e-home*` 起双实例；
  真实 app data 的 `gosslan.db` / `-wal` mtime 前后**完全不变**。
- `--round=contentpull`：40MB + 12 份 **36/36 PASS**（2026-10-19 增 A-16 受众闸：非好友同群
  仍按 cid 服务，4 条断言）；`E2E_PULL_BIG_MB=300` 复跑
  **32/32 PASS**（拉取 4774ms、文本 2768ms 落库、accept 超时 0、队列溢出留痕 1 行；
  断线格 4 份全部落盘且 sha 正确）。
- 默认轮（J1 文本 + J2 文件 + 重启 + Routed）**18/18 PASS**。
- 真实 UI：300MB 传输开始（A 日志 `[FILE] offer SENT`）后 **734ms**，接收端 B 的
  **设置窗口出现**（窗口名 `设置`；macOS System Events 按 PID 激活 + Cmd+,）。
- 修正测试时序：断线格原断言假设“杀之前 0 个 accept”。300MB 轮实测 `ucoh1k`
  在 stop 前已被旧连接接下（旧日志 17:47:55 accept RECEIVED），重启后新连接补其余 3 单，
  4 份文件全部落盘且 sha 正确。断言改为“杀前已接下的不算剩余”，总 accept 仍须覆盖
  4 单且超时 0；不是产品缺陷，也不放宽产品判据。
- 扩展覆盖（同一隔离 HOME，release 5.0.29）：`kill-mid` **25/25**、`peer-freeze` **24/24**、
  `multi-file` **29/29**（2026-10-19 增三实例同名并发：两发送者→一接收者，两条台账各自 done、
  两个不同路径、内容多重集合等于两源）、`gossip3` **25/25**、`sender-kill-mid` **26/26**（修复 outbox 后）、
  `recv-readonly` **24/24**、`group` **37/37**（`GOSSLAN_AX=1` 真界面读到 `[有人@我]`/6 未读）、
  `gfile` **28/28**（群文件逐字节一致）、`ghsync` **32/32**（新成员历史/群任务同步、
  时间/seq 保真、路径剥离、未读 0、标记 done）、`recv-dir-rotted` **24/24**
  （只有最后 rename 失败：发送侧明确 failed、不删队列行冒充成功、接收侧不假 done）、
  `src-shrunk` **26/26 ×3**（入队后源文件变小：按截断后的磁盘真值收发，内容/sha/终态一致；
  A-11 修复后补两条 size 断言：A 台账/A 气泡都等于实发 4096）；同一终态 release 上
  `recv-readonly` **24/24**（失败收尾仍按原语义推进，size 不被抹成 0）。
- 网络/业务扩展：`lanoff` **26/26**（LAN 关闭后走 Routed）、`posttext` **39/39**
  （重启后文本投递）、`task` **49/49**（群任务同步）、`dmreaction` **24/24**
  （1:1 表情回应）。
- 续传/崩溃扩展：`poison-part` **22/22**（脏 .part 前缀自愈或明确失败）、
  `resume-prefix` **23/23**（真实前缀复用）、`groupcrash` **26/26**（建群中崩溃）、
  `gossip-late` **23/23**（晚加入群的 gossip 收敛）、`stall-mid` **25/25**（中途停滞）、
  `disk` **18/18**（磁盘/队列）。
  标准轮合计 **24 轮 / 647 断言**；加互操作 **8 轮/216**，共 **32 轮 / 863 断言全绿**。
  2026-10-19 在 5.0.32 上整套重跑：23 步首跑绿；contentpull 首跑在步骤 5
  「A 侧 outbox 被 Ack 删除」**30.1s 超时红（1/4）**，同二进制连续 3 次复跑
  **36/36 绿**。失败轮 A 侧同时有 **LAN×2 + Routed 三条到 B 的链路** ⇒ 登记
  **A-17**；5.0.33 起每 5s 重放 outbox/group_outbox，contentpull ×3 全绿，转 FIXED（观察项）；
  不把 863 读成无条件稳定。
  （647 = 24 个门禁 E2E 步骤逐轮打印之和，2026-10-19 终态 release 全部重跑；含默认轮
  在 1 KB / 10 MB 两档各一次。此前后缀曾写 661/877，逐轮现算多计 14，已按现算值更正。
  互操作 216 为 5.0.32 ↔ 4.44.4 双向 8 轮读数。）
- **反向自证（证明正向断言非空转）**：`--negative`（幽灵收件人）投递断言如期
  超时红、进程 exit 0（自证通过）；`kill-mid-lie`（期望字节 +1、sha 换成错值）
  两条断言如期红（`6291457 vs 6291456`、sha 不符）——这是该轮的 **EXPECTED RED**，
  不是产品失败。正向 `kill-mid` 的 25/25 因此不是空转。
  `sender-kill-mid-lie`（sha 换成错值）如期红（expected `0000…` / actual `20492a…`）；
  `recv-readonly-lie`（把“该失败”换成“必须 done”）如期红（expected done / actual failed）。
  四条负控共同证明：发送端崩溃续传、接收端写失败这两族正向断言都不是空转。
- **依赖安全审计**：`cargo audit --file src-tauri/Cargo.lock` **exit 0、0 个漏洞**；
  10 条 allowed warnings（unmaintained/unsound，均为传递依赖）：`proc-macro-error`、
  `unic-*`（6 个未维护）、`zbus_names`/`zvariant`/`zvariant_derive`（Linux D-Bus，未维护）、
  `glib 0.18.5` unsound（Linux GTK 路径，RUSTSEC-2024-0429）。Linux 运行时未验证；
  这些属于 Tauri/GTK 依赖链，未在本轮强升。
- **旧/新二进制互操作**（4.x tag `v4.44.4` release ↔ 5.0.33，同一 harness 用包装脚本按实例
  分派二进制，A/B 两个方向都跑）：
  - default（文本 + 文件 + 重启 + Routed）**18/18 ×2**
  - group（群消息/@名单/撤回/GroupAck）**37/37 ×2**
  - gfile（群文件逐字节/元数据）**28/28 ×2**
  - gossip3（A→B→C 三节点传播）**25/25 ×2**
  合计 **8 轮 / 216 断言全绿**。4.44.4 release 从 tag 本地构建（暖 target **3m47s**；冷 target 曾 7m57s）、5.0.33 本地 release 构建 **4m56s**；两侧 `DB_VERSION=11`。
  未覆盖：真机、4.x 用户库实迁移、其余 E2E 轮次。
- 已修展示差异（`src-shrunk` 实测，A-11）：修前 A 的入队台账/气泡仍记 1048576、B 台账/盘上为 4096；
  5.0.31 起 `upsert_transfer` 同步 `size`、`fill_message_size` 回填气泡，复跑 A 气泡/A 台账/B 台账
  均为实发 4096，且补了两条断言钉住。

- `gfile` 首跑因驱动内 `cargo build --example e2e_peer` 遇到本机 toolchain 环境问题退出 1；
  直接构建成功（16s）后带 `RUSTUP_TOOLCHAIN` 复跑 **28/28** 绿 —— 环境噪声，不是产品缺陷。
- 未跑：其余 E2E 轮次、真机；Windows/Linux/iOS 运行时未验证；真实 4.x 用户库未执行。

### B10（已落地，5.0.29）：文件发送成功后的队列行统一清理
- E2E `sender-kill-mid` 发现：发送端在飞时被 SIGKILL、重启续传完成后，两侧
  `file_transfers` 均 `done`、文件 sha 正确，但发送端 `file_outbox` 仍残留 `pending`
  行（清扫器会再次投递）。根因是队列行删除只挂在 `flush_pending_files` 的 `Ok`
  分支，`AlreadyHave`/续传/恢复等成功路径绕过它。
- 修复：`finalize_send_accepted` 对所有成功路径统一 `drop_sent_outbox_row`
  （按 `transfer_id` 幂等；无队列行时 no-op；失败留痕）。源码守卫要求成功收尾
  必须包含该调用。Rust **985 通过 + 1 ignored**；`sender-kill-mid` 复跑见下。
- 未改变成功/失败判定、重试状态机、协议与文件内容。

### B12（已落地，5.0.31）：原件事后变小时发送侧 `size` 跟实发字节走（A-11）
- `src-shrunk` 修前实测：入队 1048576 → 截断后实发 4096，线协议/落地内容/sha/两侧终态都正确，
  但发送侧 `file_transfers.size` 与气泡 `content.size` 仍是 1048576；接收侧写的是 4096。
- 根因：`upsert_transfer` 的 `ON CONFLICT` 只更新 status/path/progress；气泡从未回填 size。
- 修复：冲突分支同步 `size = excluded.size`，保留 `WHERE status <> 'done'` 终态闸；
  新增 `db::fill_message_size`（与 `fill_message_sha256` 同形状：幂等、缺行/非 JSON 跳过），
  发送入口按实际 `metadata.len()` 回填，并在任一字段变更时重发 `message-received`。
- 边界：失败收尾 `finalize_file_failure` 调 `upsert_transfer` 时传的 `size=0` 是"不知道"，
  现在先读台账已知 size 再写 —— 否则新同步逻辑会把失败单抹成 0。单测
  `a_failure_finalize_keeps_the_known_transfer_size` 先红后绿。
- 影响面复核（逐个生产调用点现读）：除 finalize 外，其余调用传的都是实际字节数
  （`size` / `gf.size` / `r.size` / `expected_size` / `gap.size`），没有第二个
  "0 = 不知道"的调用点；`upsert_transfer` 的错误仍由调用方按原语义处理。
- **实测（2026-10-19，5.0.31）**：单测先红后绿三条；Rust **989 通过 + 1 ignored**，
  基线 987→990（Windows 970→973）；`src-shrunk` **26/26 ×3**（A 气泡/A 台账/B 台账均 4096），
  默认轮 **18/18**，`recv-readonly` **24/24**（失败收尾路径）。
  同一终态 release 上把受 size 同步影响的文件链全部回归：`kill-mid` **25/25**、
  `sender-kill-mid` **26/26**、`peer-freeze` **24/24**、`multi-file` **29/29**（含三实例同名并发）、
  `poison-part` **22/22**、`resume-prefix` **23/23**、`recv-dir-rotted` **24/24**、
  `gfile` **28/28**（首跑仍是 `cargo build --example e2e_peer` 无默认 toolchain 的
  环境噪声，`RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin` 复跑绿，非产品失败）。
  未跑：group/gossip/互操作/真机。

### B14（已落地，5.0.33）：多链路建链窗口内离线消息周期重放（A-17）
- 5.0.32 E2E 失败轮证据：contentpull 首跑步骤 5 文本 Ack **30.1s 超时（1/4）**；
  B 库零消息、A 气泡仍 `sending`，A 侧同时有 LAN×2 + Routed 三链路。
- 修复：`AppState::spawn_outbox_retrier` 每 **5s** 对当前有链路的 peer 重放
  `flush_outbox` + `flush_group_outbox`；收端按 `msg_id` 幂等，Ack 才删行；
  文件队列保留自己的 attempts/退避/5 次上限，不进入这个循环。
- 判据 `outbox_retrier_is_wired_and_covers_both_queues`（唯一接线/周期/按链路筛选/
  两队列）；**两次单点变异**：摘掉 `lib.rs` 的启动调用 ⇒ 红在“恰好接一处”；
  摘掉 `flush_group_outbox` ⇒ 红在“只重放一半”；还原后绿。
  Rust **991 通过 + 1 ignored**，基线 992（Windows 975）。
- **5.0.33 release 的回归**：contentpull **×3 全绿（36/36）**、default **18/18**、group **37/37**、
  posttext **39/39**；重放未引入重复消息，也未顶掉会话。
- **contentpull ×3**：**3/3 全绿（36 断言/次）**，未再出现文本 Ack 超时，
  也未出现重复消息（该轮自身判「B 侧恰好一条」）。A-17 转 **FIXED（观察项）**：原 1/4 抖动
  未被定向复现，5s 重放覆盖"建链窗口漏发"这一失败形状。

### B13（已落地，5.0.32）：SQLite 锁观测摘要进运行日志
- `DbLock` 早已逐次量 wait/hold，但 `take_summary()` 只有测试在读 ⇒ 现场看不到锁竞争。
- 新增 `AppState::spawn_db_hold_reporter`：60s 周期、`DbLock` 的唯一生产读者；空窗口
  不产行，慢持锁（默认 ≥500ms）才 warn 一行（取锁次数/最长持有/最长等待/累计/
  超阈值次数），不含 SQL、参数、正文或文件名。
- 判据 `db_hold_summary_has_exactly_one_production_reader` 钉住唯一读者、唯一启动点、
  阈值来源与日志出口；**两次单点变异**：摘掉 `lib.rs` 的启动调用 ⇒ 红在“启动点必须
  恰好一处”；把 `st.db.take_summary()` 换成默认摘要 ⇒ 红在“只许这一个读者”；
  还原后绿。Rust **990 通过 + 1 ignored**，基线 991（Windows 974）；
  干净 worktree `verify:local` **22/22 / 165.0s**。
- 未改锁语义、DB、协议；E2E/真机 **NOT RUN**（本批只加日志出口）。

### B11（已落地，5.0.30）：应用数据目录权限 `0700`
- 真实安装的 app data 目录是 `0755`：文件虽已 `0600`，同机其他用户仍可列出备份名、
  日志名与实例库名。`AppState::init()` 在解析目录后调用
  `private_fs::restrict_dir_to_owner` 收紧到 `0700`（Unix；非 Unix 无操作，
  失败只告警不阻断启动）。
- **实测（2026-10-19，5.0.30）**：临时目录 `0755 → 0700`；Rust **986 通过 + 1 ignored**；
  基线 986 → 987。只改启动期目录权限，未改文件内容/DB/协议。
- **真实启动验证**：隔离 HOME 预置 app data 目录 `0755`，启动 5.0.30 release 后目录
  变为 **`0700`**，生成的 `gosslan-1.db` 与 crash 日志均为 **`0600`**；随后停止实例。

### B15（已落地，2026-10-21）：重复基础设施减冗（thiserror / walkdir / time / tempfile）

来源：减冗审计 §B.8 第 1、2 批。四个 crate **都早已在 Cargo.lock 里**
（thiserror 2.0.20 / walkdir 2.5.0 / time 0.3.55 / tempfile 3.27.0），本次只是变成直接依赖，
没有新增任何需要下载的版本。

- **thiserror**：`state.rs::StartupError` 与 `network/file.rs::SendFileError` 的手写
  `Display` + `Error` 改成 derive。所有错误文案逐字保留；`source` 字段由 derive 自动接上
  `Error::source()`。这是 B2（`InitError`）的同类扩展，不改变对外文案与错误类型。
- **walkdir**：`storage/cache_cleaner.rs::walk_files` 的手写深度栈换成
  `WalkDir::follow_links(false)` + `filter_entry` 排除软链。软链不跟随、不收集的安全语义不变，
  既有 `walk_files_never_follows_symlinks` 判据继续守这一格。
- **time**：`logging.rs` 的 `format_utc` / `parse_utc_to_ms` 与 `export.rs` 的
  `format_local_time` 改用 `time` 的 UTC 算术，删掉三份手写 `civil_from_days`
  （logging 两份、export 一份）。**只做 UTC 算术，不读机器时区**；导出仍由前端
  `getTimezoneOffset()` 给偏移，因此原来"跨夏令时可能有 1 小时偏差"的已知代价不变。
  这是对早期"不引 chrono/time"口径的**有意更新**：旧口径的目的是不引入时区库做本地时区，
  而 `time` 早已在依赖树里，且这里只用它做纯 UTC 换算。
- **tempfile**：仅 dev-dependency。把"目录生命周期天然覆盖整个用例"的测试夹具换成
  `TempDir`（`macos_bookmark` / `private_fs` / `outbox_sweep` / `group_file` /
  `ledger_backfill` / `network::mod` / `network::file`）。**返回裸 `PathBuf` 的 helper
  没有改签名**：`TempDir` 在函数返回时就会删目录，强行改会把"文件存在"变成"文件已删"，
  那属于假修复；这类 helper 保留原来的 pid + 纳秒命名。
- **验证（本地，2026-10-21）**：`cargo test --lib --no-run --offline` 退出 0；
  受影响测试组 logging 29、export 6、cache_cleaner 4、state 10、macos_bookmark 4、
  private_fs 2、ledger_backfill 8、net task 1，以及被改夹具的 6 条具名用例全部通过。
  全量 Rust / 护栏 / Android 留给远端门禁（本地按用户口径不跑全量门禁）。
- 回滚：恢复各文件的旧实现并从 `Cargo.toml` 移除直接依赖即可；错误文案与导出格式不变。

## 4. 4.x → 5.0 数据迁移与恢复

- 现有迁移链已是 `user_version` 单调版本 + 每步事务 + 降级拒绝；本批补的是**迁移前快照**。
- 备份是完整的 SQLite 单文件（`VACUUM INTO` 读取 WAL 中的已提交数据），不复制正在使用的
  主文件 + `-wal/-shm` 组合。
- 恢复演练（后续批次）：用备份替换主库 → `integrity_check` → 启动到旧版本或当前版本；
  记录原版本、备份路径、校验结果。
- 未知未来版本：`current > DB_VERSION` 在**任何写入前**拒绝，已有测试 `downgrade_refusal_writes_nothing`。
- 迁移失败：每步 `unchecked_transaction` 回滚，`user_version` 不前进；备份保留。
- **真实数据副本实测（2026-10-19，5.0.31 release）**：对本机真实安装库做只读一致性
  `.backup` 副本（源库未写），在隔离 HOME 用 5.0.31 启动 7s 后停止：迁移前后
  `user_version=11`、`integrity_check=ok`；8 张主表行数完全一致（messages 56、friends 3、
  groups 1、settings 34、file_transfers 12、content_transfers 35、favorites 0、
  group_members 4）；语义聚合也逐项相等（messages `56:19100:100369643617480`、
  friends `3:63:5376106593919`、groups `1:4:1792329496228`、settings `34:834:1140`、
  file_transfers `12:88273400:21507826111856`、content_transfers `35:3547177738:3532648832`，
  格式为 `行数:长度和:时间和`）。启动后目录 **0700**、库 **0600**（B6/B11 生效）。
  **边界**：该库已是 v11，这次证明的是“5.0 打开真实 4.x 数据不丢不改 + 权限收紧”。
- **真实数据副本 v10→v11 演练（2026-10-19，5.0.32）**：同一真实库的只读副本跑两遍
  `real_data_copy_replays_migration_without_losing_rows`：
  ① 置 `user_version=10`、`mention_targets` 列已在 ⇒ 备份 **tables=19/integrity=ok**，
     迁移后 v11、**19 表/208 行**、逐表行数与关键聚合一致、`integrity_check=ok`
     （幂等跳过分支）。
  ② 再把 `messages` 按**逐字 v10 DDL** 重建（无 `mention_targets`）后置 v10 ⇒
     迁移前备份 **tables=19/integrity=ok**，迁移后 `user_version=11`、
     `mention_targets` 列新增、**56/56 行该列为 NULL（不回填）**、19 表/208 行保留、
     `integrity_check=ok`。
  **边界**：② 的数据来自真实安装库、schema 是逐字 v10 DDL，但**不是用户直接提供的
  v10 现场**；真实 4.x v10 用户库仍 **NOT RUN**（本机没有这样的库）。
- **第二次真实副本演练（2026-10-19 14:29，5.0.33，数据已增长）**：用户指定安装目录
  `~/Library/Application Support/com.gosslan.app` 就是本机全部 4.x 资料——里面是
  `gosslan.db`（正被**已安装的 4.44.4**、PID 56481 读写）+ 三个开发多开实例
  `gosslan-1/-2/-3.db`，**四份的 `user_version` 全是 11**，没有任何一份是未迁移的 v10 现场。
  取证方式：对运行中的源库 `VACUUM INTO` 一份只读一致性快照（源库 mtime 前后不变，
  仍 `Oct 19 09:24`），快照置 `user_version=10` 后跑
  `real_data_copy_replays_migration_without_losing_rows`（见
  `src/db/migration_tests.rs:2019`）：
  退出 0，`drill ok: tables=19 total_rows=340`，迁移前自动落备份
  `gosslan-copy.pre-v10-to-v11-<pid>-<ts>.db`（**v10/19 表/integrity=ok**）。
  **迁移前后逐表独立复算完全一致**：messages 93、friends 3、groups 1、group_members 4、
  conversations 3、group_reads 1、pending_reads 1、conversation_clocks 75、
  group_outbox 70、content_transfers 35、file_transfers 12、group_files 2、
  group_file_recipients 6、favorites 0、outbox 0、file_outbox 0、pending_group_reads 0、
  group_recalled_messages 0、settings 34（合计 340 行）。语义聚合逐项相等，格式
  `行数:长度和:时间和`：messages `93:48209:166687383475780`、friends `3:63:5376106593919`、
  groups `1:4:1792329496228`、settings `34:834:1140`、file_transfers
  `12:88273400:21507826111856`；`mention_targets` 非空 17 行迁移后仍 17 行；
  迁移后 `user_version=11`、`integrity_check=ok`、`pragma_foreign_key_check` **0 行**。
  消息 9 种 kind 分布迁移前后逐项一致（text 43 / todo_update 18 / remind_ack 9 / image 7 /
  remind 6 / reaction 3 / code 4 / file 2 / todo 1，合计 93）。
  **关联关系另用独立查询复算**（不靠测试自证）：迁移后指向不存在会话的消息 **0** 行、
  指向不存在群组的成员行 **0** 行。
  **备份可独立读取**（`mode=ro`）：`user_version=10`、19 表、`integrity_check=ok`、messages
  仍 93 行 ⇒ 回滚素材是真的，不是"文件存在"而已。
  **快照与备份用完已删除**；源库 `gosslan.db` mtime 前后均为 `Oct 19 09:24`、权限未变。
  **仍然不能声称的**：这台机器上不存在未迁移的 4.x v10 现场库（4.44.4 自身已带 v11），
  所以"用户手上那份真在 v10 的库"这一条只能靠**逐字 v10 DDL 夹具**证明，实用户库
  **BLOCKED**——需要用户提供一份 v10 时期的库文件，不是路径猜错。
- 迁移步骤登记口径：`MIGRATIONS` 数组的每个 `Migration { from, to, description, run }`
  就是一个独立、有名字、有起止版本的步骤（当前 11 步，每步一个事务），迁移测试按
  `from` 逐个重放。**没有拆成 `vN.sql` 文件**：多数步骤含列/索引条件判断与数据回填
  （Rust 逻辑），拆文件会把逻辑与 SQL 分家，收益不抵风险；后续新增步骤仍必须是一条
  独立 `Migration` 条目 + 对应迁移判据。这是有意保留的边界，不是遗漏。

### 4.1 真实数据库资产清单（2026-10-19 只读现读）
- 位置（macOS）：`~/Library/Application Support/com.gosslan.app/gosslan.db`；多开实例为
  `gosslan-<N>.db`；Windows/Linux 走 Tauri `app_data_dir()`。应用启用单实例插件，正常运行
  只有一份库；`--instance N` 只用于开发/E2E（独立库 + 端口）。
- 真实库读数（2026-10-19 14:29 只读现读，源库未写）：`user_version=11`、`integrity_check=ok`、
  **19 表 / 20 个显式索引**、**0 触发器 / 0 视图**；一致性由业务写入次序 + 迁移/级联测试守
  （本机这份库无外键声明，`pragma_foreign_key_check` 无对象可查 ⇒ 关联完整性用
  "指向不存在会话/群组的行数"两条独立查询量，实测均为 **0**）。
  行数（只读）：messages 93、friends 3、groups 1、group_members 4、conversations 3、
  conversation_clocks 75、group_outbox 70、content_transfers 35、file_transfers 12、
  group_file_recipients 6、group_files 2、group_reads 1、pending_reads 1、settings 34、
  favorites/outbox/file_outbox/pending_group_reads/group_recalled_messages 0（合计 340）。
- 表：`content_transfers`、`conversation_clocks`、`conversations`、`favorites`、`file_outbox`、
  `file_transfers`、`friends`、`group_file_recipients`、`group_files`、`group_members`、
  `group_outbox`、`group_reads`、`group_recalled_messages`、`groups`、`messages`、`outbox`、
  `pending_group_reads`、`pending_reads`、`settings`。
- 索引：`idx_content_transfers_peer/status`、`idx_favorites_msg/time`、
  `idx_file_outbox_created/peer_due`、`idx_file_transfers_created`、
  `idx_group_file_recipients_recipient/status`、`idx_group_files_group`、
  `idx_group_outbox_created/group/peer`、`idx_group_recalled_msg`、
  `idx_messages_conv/conv_kind/conv_seq`、`idx_outbox_created/peer`、
  `idx_pending_group_reads_peer`；其余主键唯一索引为 SQLite autoindex。
- 数据分级：
  - **不可丢失**：`settings`（设备 id/身份密钥/偏好）、`messages`、`friends`、`groups`、
    `group_members`、`conversations`、`conversation_clocks`、`group_reads`、
    `pending_group_reads`、`favorites`、`group_recalled_messages`、`group_files`、
    `file_transfers`。
  - **可重同步但身份/关联必须保留**：`outbox`、`group_outbox`、`pending_reads`、
    `content_transfers`、`group_file_recipients`（丢了会重投，关联 id 不能重编号）。
  - **可重建**：`cache/`（预览等派生数据）、`.window-state.json`（窗口几何）。
  - **必须保留的用户文件**：`downloads/`（实收文件，现 72 MiB）、`favorites/media/`
    （收藏副本）——不是缓存，清理工具不得按名字删。
  - **无密钥/源数据则不可恢复**：身份私钥/群密钥只在本机 `settings`；丢失后历史密封内容
    与仅存于本机的文件无法恢复；对端未保留源文件时亦不可恢复。
- 非 DB 资产：`logs/` 与 `*-crash.log`（诊断，含 peer id/IP/文件名，需 0600）、`cache/`、
  `downloads/`、`favorites/media/`、迁移备份 `<db>.pre-vX-to-vY.<ts>.db`。
- 当前真实安装权限（2026-10-19 现读）：目录 **0700**（`drwx------`，B11 已在这份真实目录上生效过），
  库文件仍是 **0644** —— 因为**装在 `/Applications` 的还是 4.44.4**（PID 56481 正在读写
  `gosslan.db`），4.x 没有收紧代码。⇒ 库 `0600` 只能等 5.0.x 正式装机后由 B6 生效，
  **本轮未手工改真实库或目录**。
- 未覆盖：真实 **v10 现场**用户库实迁移。本机四份库（主库 + 3 个多开实例）全为 v11，
  4.44.4 自身已带 v11 schema ⇒ **不存在**未迁移的 v10 文件可取；已由"真实数据 + 置回 v10"
  与"真实数据 + 逐字 v10 DDL"两条副本演练覆盖（见上一节），
  真正的 v10 现场库标 **BLOCKED**（需要用户提供一份 v10 时期的库文件）。

## 5. 边界

- 不改消息编码、消息 ID、签名输入、加密格式、确认语义与 SQLite 字段含义。
- 不重构前端；若 IPC 契约必须变化，先列影响面并提供后端兼容层。
- 不 push/tag/release/merge main；每批独立提交、独立门禁。
- 多实例 E2E：**32 轮 / 863 断言 PASS**（隔离 HOME，含 4.44.4↔5.0.33 双向互操作）；
  真机、Windows/iOS/Linux 运行时为 **NOT RUN**，不得用桌面编译代替。

## 6. 最终验收报告（2026-10-19）

### 6.1 基线

- 分支 `feat/5.0`，版本 **5.0.32**；本地未推笔数现算（`git rev-list --count origin/main..HEAD`）；Rust 1.98.1。
- 真实库只读核对：`user_version=11`、19 张业务表、WAL、`integrity_check=ok`；
  **未对真实用户库执行迁移**。
- 工作树仍有并行会话的前端改动，本轮未暂存、未覆盖。

关键模块清单（审计结论）：

| 模块 | 责任 | 实现/并发 | 主要失败路径 | 测试 | 替换结论 |
|---|---|---|---|---|---|
| `db.rs` + `db/*` | schema/迁移/实体读写 | 单 `DbLock<Connection>`，WAL，`busy_timeout` | 迁移失败回滚、降级拒绝、备份失败中止 | 迁移 38 条 + 数据保存/索引判据 | 保留 rusqlite |
| `network/transport` | 分帧、链路队列、读写循环 | Tokio、有界队列、取消 watch | 写失败拆链、半包/超长帧、断连 | 字节/队列/锁作用域判据 | 保留自研分帧 |
| `network/file` | 文件分块、续传、收尾 | `spawn_blocking` 慢活、盘上真值续传 | SHA/大小/rename/ACK 失败 | E2E kill/freeze/readonly/rotted/shrink | 保留业务状态机 |
| discovery/mesh/gossip/relay | 发现、路由、传播、中继 | Tokio + 有界通道；TTL/去重 | 断链、半开、队列满 | gossip3/late/lanoff E2E | 保留协议 |
| `crypto`/`device` | 身份、签名、AEAD、随机源 | x25519/ed25519/chacha20poly1305/`OsRng` | 解密失败、缺公钥、错密钥 | 私钥边界/协议判据 | 不换算法/格式 |
| `commands`/`state` | IPC、生命周期、任务管理 | `#[tauri::command]`、spawn_blocking | 参数校验、权限、任务取消 | 命令/守卫/E2E | 保留装配层 |
| `logging`/`private_fs` | 诊断、敏感文件权限 | 同步落盘、ring buffer；Unix 0600/0700 | 写失败告警、权限失败不阻断 | 日志/权限判据 | 不换 tracing |
| `content/store` | 内容寻址、拉取台账 | SQLite + 事务 | 丢片、假 complete、残留 | contentpull/ghsync E2E | 保留 |
| 系统插件 | 通知/对话框/fs/opener/window-state/single-instance | Tauri 官方插件 | 平台差异 | 编译/代码审计 | 官方优先 |

#### 6.1.1 调用链 / 数据 / 迁移风险补充

| 模块 | 调用链 | 读写的数据 | 迁移风险 |
|---|---|---|---|
| `db.rs` + `db/*` | `state`/`commands`/`network`/`transport` → `db::*`；启动 `init` → 备份 → SCHEMA → MIGRATIONS | 19 张业务表；`settings` 里的身份/偏好；WAL/侧车/迁移备份文件 | schema 版本、备份可用性、未知版本拒绝；改动必须带迁移与实体保留判据 |
| `network/transport` | `lib.rs`/`state` → dial/listen → handlers；出站队列 → 写循环 | 线帧、有界队列（low 8 MiB/链路）、peers/links 内存表 | 帧格式与队列语义不能变；改协议先做新旧互操作 |
| `network/file` | `commands/files` / `flush_*` → `send`/`receive`/`relay`；收尾写台账 | `file_outbox`、`file_transfers`、`content_transfers`、盘上 `.part`/终名 | transfer_id/cid/路径语义；断点续传与 rename 契约 |
| discovery/mesh/gossip/relay | `state` → discovery/mesh → transport；中继策略来自 settings | peers/links/路由与 gossip 去重表（内存）；`routed_endpoints` 等 settings | TTL/去重/中继权限；新旧端的广播与转发兼容 |
| `crypto`/`device` | 发送/接收/群密钥分发 → `crypto`；`device` 提供本机身份 | `settings` 内的私钥、好友公钥、群密钥 | 算法/密钥格式/签名输入不可静默更换；丢失密钥=历史密封内容不可恢复 |
| `commands`/`state` | Tauri IPC → `commands` → 业务/基础设施；事件 emit | 通过服务层间接读写所有实体；窗口/任务内存态 | IPC 契约变化要先列影响面并提供兼容层；前端不得绕过业务层 |
| `logging`/`private_fs` | 所有模块 → `Logger`；启动/落盘 → `private_fs` | 运行日志、崩溃现场、启动路标、DB/备份/目录权限 | 日志格式与权限口径；不得写密钥/正文；权限失败不阻断启动 |
| `content/store` | `commands`/`network` → content store；按 cid 查找/登记/补账 | `content_transfers`、磁盘内容、cid↔path 关系 | cid 即内容地址；complete 必须与真实文件/哈希一致 |
| 系统插件 | `lib.rs`/`state` → Tauri 插件与平台分支 | `.window-state.json`、通知、对话框/文件选择、单实例锁 | 平台差异与 capability 最小权限；移动端不得套桌面 API |

#### 6.1.2 业务功能清单（不可破坏行为）

- **身份/好友**：设备 id、x25519/ed25519 密钥、好友关系与公钥解析；密钥格式与安全码口径不变。
- **单聊/群聊**：消息落库、会话未读/摘要、撤回物化、@ 名单三态（`mentions`/`mention_targets`）。
- **可靠投递**：先落库再发送、Ack 回收、重试/退避、断连恢复、重复帧去重、`done` 不可降级。
- **群组同步**：建群、成员关系、GroupKey 分发、群历史/群任务同步、晚加入成员的补递。
- **发现/路由/传播**：LAN/Routed/BLE 选路、Gossip TTL/去重、中继权限与降级。
- **文件**：流式分块、断点续传、SHA/大小校验、rename 后完成、取消/失败/残留清理。
- **加密**：AEAD 密封、身份签名、群密钥封装；不改算法/封装/签名输入。
- **持久化/恢复**：迁移备份、降级拒绝、崩溃恢复（outbox `sending`→`pending`）、重启续传。
- **系统集成**：托盘/窗口状态/通知/单实例/文件选择/打开路径；平台能力不足时不伪装成功。
- **多端兼容**：4.44.4 ↔ 5.0 的默认/群/群文件/gossip 双向互操作；DB/协议版本兼容路径。

### 6.2 依赖选型

| 依赖 | 结论 | 理由 |
|---|---|---|
| `thiserror 2.0.21` | **采用** | MIT OR Apache-2.0，MSRV 1.77；替换 `InitError` 手写样板 |
| `rusqlite 0.31` | 保留 | SQLx 会重写全部 DB 边界，收益未证 |
| SQLite `VACUUM INTO` | 采用 | 迁移前一致性快照，不复制运行中的 `-wal/-shm` |
| `tokio-util` + `bytes` | 不采用 | 现有分帧约 30 行 + 字节判据；真实缺口是两次写，已直接修 |
| `tracing` | 不采用 | 同步落盘是崩溃现场/最后一条日志的证据前提 |
| SQLx / Refinery / libp2p / iroh | 不采用 | 与现有协议、迁移链、离线可靠性不兼容或收益未证 |
| Tauri 官方插件 | 已在用 | notification/dialog/fs/opener/window-state/single-instance |

### 6.3 自研代码减少

- `InitError` 的 `Display/Error/From` 改由 `thiserror` derive。
- TCP ≤8KiB 小帧合并为一次 `poll_write`；大帧保持两次写、不复制载荷。
- 三个附件预览命令移出 async worker（`spawn_blocking`）。
- 数据库/侧车/备份/日志/目录权限收敛到共享 `private_fs`。
- 保留：线协议分帧、Gossip/去重/可靠投递、身份与加密格式、`user_version` 迁移链；
  这些有字节级或数据级判据，替换风险大于收益。

### 6.4 数据库与迁移

- 机制：`user_version` 单调迁移链（v0–v11）+ 每步事务 + 降级拒绝；迁移前
  `VACUUM INTO` + `integrity_check`/版本/表数校验，失败以 `InitError::Backup` 中止；
  `busy_timeout=5s`。
- 判据：迁移测试 **38 通过 + 1 ignored**、Rust **993 通过 + 1 ignored**（B15 两条新判据已入基线 994）；
  覆盖 v0 legacy、1..10 每个起始版本、损坏库原文件逐字节不变、备份恢复再迁移。
- 真实 v10 DDL 夹具（`0b84f11^`）18 张历史表 + 各实体数据迁移后逐字段保留。
- 真实数据副本演练：只读副本置 v10 → 生产 `init`：19 表/208 行、备份 integrity ok、
  逐表行数与关键聚合一致；源库未改。2026-10-19 5.0.32 复跑两遍：① 副本列已存在 ⇒
  `ALTER` 幂等跳过；② 按逐字 v10 DDL 重建 `messages`（无 `mention_targets`）⇒ 迁移
  真加列、56/56 行为 NULL、19 表/208 行保留、备份与 integrity 均 ok。
- **第三次（2026-10-19 14:29，5.0.33，取的是当天最新数据）**：`VACUUM INTO` 快照 → 置 v10 →
  同一测试 **exit 0**，`tables=19 total_rows=340`；19 张表逐表行数与 5 组语义聚合迁移前后
  **逐项相等**（messages `93:48209:166687383475780` 等，见 §4），9 种 kind 分布相等，
  `mention_targets` 非空 17 行不变；另用独立查询复算"指向不存在会话/群组的行"均为 **0**；
  备份单独以 `mode=ro` 读取：v10/19 表/integrity ok/93 条消息。快照与备份已删，源库 mtime 不变。
- **未完成**：用户手上的**真 v10 现场库**标 **BLOCKED** —— 不是没找，是本机四份库
  （主库 + 3 个多开实例）`user_version` 全为 11，且装在 `/Applications` 的 4.44.4 自身
  就带 v11 schema（`git show v4.44.4:src-tauri/src/db.rs` 里 `DB_VERSION = 11`），
  这台机器上不存在未迁移的 v10 文件；该条只能由用户另供一份 v10 时期库文件，
  或以逐字 v10 DDL 夹具（已通过）为替代证据。

### 6.5 网络与文件传输

- 协议字节不变；写循环可被 shutdown/cancel 打断，队列有字节预算。
- E2E 标准 **24 轮 / 647 断言** + 旧新互操作 **8 轮 / 216 断言** = **32 轮 / 863 断言全绿**。
- 互操作：4.44.4 ↔ 5.0.33 双向 default/group/gfile/gossip3（8 轮/216 断言，均 exit 0）；两侧 `DB_VERSION=11`。
- 真实 UI：300MB 传输开始后 **734ms** 接收端设置窗口可开；group 轮 AX 读到
  `[有人@我]`/6 未读。
- E2E 发现并修复：发送端崩溃恢复后 `file_outbox` 残留 `pending` ⇒ 重复投递；
  `finalize_send_accepted` 对所有成功路径统一清理（5.0.29）。
- A-11 已修（5.0.31）：`src-shrunk` 修前 A 入队台账/气泡仍记 1MB、B 台账/盘上 4KB；
  修复后两处 size 都按实发字节回填，复跑 A/B 台账与气泡一致（4096），断言已补。
### 6.5.1 大文件资源与队列读数（2026-10-19，5.0.31 release）
- 场景：`--round=contentpull`、`E2E_PULL_BIG_MB=300`、隔离 HOME；从建链到
  12 份拉取完成 **4285ms**，文本落库 2778ms，队列溢出留痕 1 行。
- 内存：100ms 间隔采样 `pgrep -x gosslan` 的 RSS。全程所有 gosslan 进程的单 PID
  峰值 **126.1 MiB**；两条最长驻实例（190/266 次采样）峰值 **122.0 / 112.5 MiB**，
  相对进程启动基线增长约 **108 / 99 MiB**。300MB 文件没有整份进内存的迹象
  （整份缓冲会使 RSS 至少再增 300MiB）。
- 队列容量（源码现读）：`LINK_QUEUE_BYTE_BUDGET = 8 MiB`/链路 low 队列，
  按分片大小折算 8–1024 槽；high/normal 各 1024 帧；`FILE_SERVICE_QUEUE_CAP = 8`/对端
  （12 份请求实测 1 行显式溢出留痕，无无界排队）。
- 阻塞：2026-10-19 在 **5.0.32 release** 上重测 —— 600MB contentpull 传输中，
  接收端设置窗口 **397ms** 可开（System Events 激活接收进程 + Cmd+,，窗口名
  `设置`/`Gosslan`；探测后立即停轮，因此这一次只证响应性、不判该轮传输完成）。
  历史读数：300MB 下 **734ms**（5.0.29）。
- 口径：采样跨过了进程重启窗口，峰值取**单 PID max**、不把多个 PID 相加；
  本轮无 `.part` 残留（该轮自身断言）。

- **B15 之后的文件链回归（2026-10-19，本机 release 二进制 + 隔离 HOME）**：三张真实双实例轮全绿 —— 默认轮 **18/18**（`run-2026-10-19T10-36-38-936Z`，含 J2 单聊文件收尾：字节数/sha256/A 侧 `file_outbox` 被收尾删除/两端台账 done/无 `.part` 残留）、群文件轮 **28/28**（`run-2026-10-19T10-57-22-943Z`，判的就是 `group_file.rs` 那条收尾事务）、内容拉取轮 **36/36**（`run-2026-10-19T11-05-20-267Z`，与单聊收尾共用收尾代码的另一条入口）。合计 **82 条断言 exit 0**。
  ⚠️ 一次**红是环境不是我带进来的**：群文件轮首跑在第 8 步的前置上红 —— 它自己 spawn `cargo build --example e2e_peer`，而那次调用没有 `RUSTUP_TOOLCHAIN`、rustup 又没设默认工具链 （`error: ... explicitly, and no default is configured`），19 条里红 1 条、其余 18 条全绿；补上工具链环境变量复跑 **28/28 绿**。这与 5.0.33 那轮记录过的同一格噪声同形状 ⇒ 判据不必改，但**跑 E2E 的驱动必须显式带 `RUSTUP_TOOLCHAIN`**（本轮已把这条写进记忆）。
- **B15 第三个站点的覆盖边界（照实说）**：`ledger_backfill.rs` 那条群台账补账事务**没有任何跨实例轮判过** （现算 `grep -rln "gfile_ledger\|补账" scripts/e2e/` 只命中驱动自身，21 张轮次分册里 0 命中）⇒ 它这一格的证据只有 6 条 `ledger_backfill_tests` 单测（已在 macOS 与 Windows 两条远端腿上执行）+ 源码级接线判据。这不是 B15 引入的缺口，是这一族本来欠的那格；本轮不补轮次（§十四：不借改日志顺手扩范围）。
- **起跑前核对不再只对存在性（B15 那批的副产品，已实测）**：`_resolve_anchor_file` 的 docstring 早就写着「恰好一个文件里出现恰好一次」，但代码只判了**文件数**，同一文件里出现几次没人管 ⇒ 锚点被 `include!` 拆册弄成不唯一时，只有跑到那一条（75~90 分钟之后）才看得见。本批补上每文件计数：①「找不到」仍按原设计整跑中止；②「不唯一」改成**起跑就点名但不中止** —— 一条坏锚点不该把其余 232 条的读数一起挡掉，它会在自己那一步报同一个错、末尾汇总照样判红。真注入那一步也修了：吞掉解析原因会报「锚点在 commands.rs 里出现 0 次」这种**假线索**，现在原样上抛真原因。
  实测三条：`--only 解除好友关系` 秒级点名并以真文案报错（退码 1）；- **那条不唯一的锚点本批已修**：`解除好友关系必须同时解除内存身份绑定` 的注入形状收窄成 `remove_friend` 处独有的三行注释 + 那一行调用（测试、`expect_fail_hint`、阈值都没动；另一处由 `sync_friend_keys…` 用例各自钉住 ⇒ 覆盖面不变）。修后 `--only 解除好友关系` ⇒ 核对报「存在且唯一 1 条」、该条 **改坏 FAIL / 恢复 PASS**、退码 0。跑完 `git status --porcelain -- src-tauri` 为 0 行（注入无残留）。
  实测三条：`--only 解除好友关系` 秒级点名并以真文案报错（退码 1）；健康组 `--only change-budget` **10/10 通过、退码 0**；`--list` 退码 0 且打印「238 条里锚点存在且唯一的 237 条（不唯一 1 处已点名）」——旧那句「都在各自文件里恰好命中一次」是过度声明，已换成说真话的计数。
- **未完成**：真机/跨设备传输 **NOT RUN**。

### 6.6 跨平台与系统集成

| 平台 | 结果 |
|---|---|
| macOS arm64 | **PASS**：fmt/clippy/Rust/前端/Android 编译、32 轮 E2E；远端 `Rust 单测 / 清单（macos-latest）` **success**（run 39215124440） |
| Android aarch64 | **PASS（仅编译）**：默认与 bluetooth 两档 0 warning；远端 `Android 编译门禁` **success**（在 ubuntu runner 上真跑 cargo，不是桌面代跑） |
| Windows x86_64 | **PASS（远端真跑测试 + 交叉编译产物）**：① 远端 `Rust 单测 / 清单（windows-latest）` **success** ⇒ 977+20 条基线（含 B15 两条**无平台门控**的新判据，两边基线都已登记）在真 Windows runner 上执行并通过 —— 这一格从今天起不再只是"编译得过"；② 本机交叉编译 `cargo xwin build --release --target x86_64-pc-windows-msvc --features bluetooth` exit 0 / 14m27s、产物 `gosslan.exe` 9.6MB `PE32+ executable (GUI) x86-64`（工具只在 `/tmp`，未装系统 LLVM）。**Windows 上的 GUI 应用运行时仍 NOT RUN**（没有 Windows 桌面主机/真机） |
| Linux | **部分**：ubuntu runner 上真跑的是 Android 编译门禁（cargo 构建）。**桌面 Linux 运行时 NOT RUN**；audit 警告集中在 Linux GTK/D-Bus 传递依赖 |
| iOS | **DEFERRED（环境）**：本机无 iOS SDK/完整 Xcode，交叉编译也过不去 ⇒ 按用户 2026-10-19 口径"其他设备无法交叉编译 PASS 的先不管"；运行时 **NOT RUN** |

系统插件与 `open_path` 平台分派已核对；Windows ACL 未在本轮处理。

**远端 CI 到底由谁执行（2026-10-19 逐文件现读，别再靠猜）**：

| 工作流 | 触发 | runner | 实际执行什么 |
|---|---|---|---|
| `verify.yml` | push 任意分支 / PR / dispatch /（本轮新加）schedule | macos-latest、macos+windows 矩阵、ubuntu-latest、macos-latest(`guards`) | 前端组、Rust fmt/clippy/单测/清单（**macOS 与 Windows 两条腿真跑测试**）、Android 编译、**全量护栏非空转**（`guards` 这条腿必须 `fetch-depth: 0`：有一条用例把命令钉在真实历史上跑，浅克隆会让它在注入态与还原态**都**红，见 §6.7 浅克隆对照） |
| `build.yml` / `build-macos.yml` / `build-android.yml` | push main、tag `v*`、dispatch | windows-latest / macos-15 / ubuntu | 出包与产物上传，不跑行为测试 |
| `build-windows-webview2.yml` | tag `v*`、dispatch | windows-latest | 内置 WebView2 的打包；该文件自己写明"跑绿只说明包打出来了"，真机那一格仍是人工项 |
| iOS | **没有任何工作流** | 无 | 既没有构建也没有测试 ⇒ iOS 只能标 NOT RUN，且**当前没有可以跑它的地方**（无 runner、无签名、无 SDK） |


### 6.7 自动化测试

| 命令 | 退出码 | 读数 |
|---|---|---|
| `npm run verify:local`（干净 worktree @ `d42003f`，复用 node_modules 与 target） | **0** | **22/22，79.6s**；唯一跳过的是「护栏非空转」（`--skip-guard-sweep` 本地口径，现已由 CI 的 `guards` job 接住） |
| `git push origin feat/5.0` | 0 | `[new branch] feat/5.0 -> feat/5.0`（第一次尝试被本机 DNS 打回 `Connection closed by 199.59.149.235 port 443`，重试即通 ⇒ 网络抖动，不是权限问题）。公开的是 `origin/main..HEAD` 六笔：本批 `d42003f` + 并行前端会话的 `3de6dd9` + 四笔记账 docs。未推 main、未 tag、未发 release、未 merge |
| `npm run verify:local`（干净 worktree，5.0.33） | **0** | **22/22，1089.0s（冷 target）** |
| `cargo xwin build --release --target x86_64-pc-windows-msvc --features bluetooth` | 0 | **5.0.33 冷 target 14m27s**；`gosslan.exe` 9.6MB（PE32+ GUI x86-64） |
| `cargo test --lib --features bluetooth` | 0 | **993 通过 + 1 ignored**（B15 两条新判据；`check-test-manifest --only rust` 基线 994 全部在跑） |
| `cargo clippy --features bluetooth -- -D warnings` | 0 | B15 之后复跑，**0 warning** |
| B15 接线的单点变异自证 | 101 → 0 | 把 `receive.rs` 的 `crate::db_hold::note_tx(` 改成合法但不匹配的 `note_tx /*B15 变异*/ (` ⇒ 接线判据报"receive.rs 的收尾事务必须有且只有一条耗时观测"；还原后与备份逐字节相同，两条判据各自 exit 0 |
| 全量护栏 CI job（`verify.yml` 的 `guards`） | **已配置，两次远端全量跑都红（run 39215124440 / 39235279878，同样 3 条标记）** | 命令是 `python3 scripts/verify-guards.py`（不带 `--only`，Ruby psych 解析确认 `has_only_flag=false`、无 `continue-on-error`）；push/PR/dispatch/schedule 四个触发器都在；定时那条约等于该定义进 main 才持续生效 |
| 护栏定点（文件气泡不整文件扫描 / outbox 终态门控 / transport 锁抗中毒） | 0 | **3/3 改坏即 FAIL、恢复即 PASS**（干净 worktree 5.0.32） |
| 迁移测试 | 0 | **38 通过 + 1 ignored** |
| `GOSSLAN_DRILL_DB=<4.44.4 真实库快照> cargo test --lib --features bluetooth real_data_copy_replays_migration -- --ignored --nocapture` | 0 | **1 通过**；`drill ok: tables=19 total_rows=340`（第一次未置 v10 时该测试按设计 **exit 101** 拒跑，前置门有效） |
| E2E（32 轮，隔离 HOME） | 0 | **863/863 断言** |
| B15 之后重跑的相关三轮（本机 release 二进制 + 隔离 HOME，5.0.35） | 0 | 默认轮 **18/18** + 群文件轮 **28/28** + 内容拉取轮 **36/36** = **82 条断言全绿**；群文件轮首跑红的 1 条是驱动缺 `RUSTUP_TOOLCHAIN` 的环境噪声（详见 §6.5） |
| `cargo audit --file src-tauri/Cargo.lock` | 0 | **0 漏洞，10 allowed warnings** |
| GitHub Actions run **39215124440** @ `d42003f`（push `feat/5.0`，本轮） | 4/5 job **success**，**`guards` job 退码 1** | `前端测试 / 清单 / 构建` **success**（07:18:27→07:38:24）⇒ 上一轮那条「操作面板」护栏红在本次不再出现，由并行前端会话的 `3de6dd9` 带过来；`Rust 单测 / 清单（macos-latest）` **success**（→07:22:44）；`Rust 单测 / 清单（windows-latest）` **success**（→07:23:19）⇒ **B15 两条无平台门控的判据在真 Windows runner 上跑过**；`Android 编译门禁` **success**（→07:20:01，ubuntu runner 真跑 cargo）；**`护栏非空转（全量，不带 --only）` 退码 1**（job 117937069342，07:18 起约 85 分钟；**第二次 run 39235279878 同样退码 1、同样 3 条标记**）⇒ 这是这 233 条扫描**历史上第一次被自动执行**。匿名可读的 check 注解逐字给出 `❌ 3 条不符合预期`：①「改坏之后测试**仍然通过** ⇒ 这条护栏是空转的（没在守东西）」②「验证过程出错：注入锚点在 friends.rs 里出现 2 次（要求恰好 1 次）」③「恢复源码之后测试**仍然失败** ⇒ 源码或环境已被破坏：`signal: null`」。**这三条当时定不了名，原因已查清并且不是"跑断了"**：现读两次 run 的状态都是 **completed / failure**（`39215124440` 08:41:15Z 收、`39235279878` 12:05:25Z 收）⇒ 233 条跑完了、末尾那份名字汇总也打了；名字读不出来纯粹是**注解量具**把它们丢了（`ci-run.sh` 只转发匹配 `❌|signal|test result:|…` 的行，用例名打在上一行；汇总列表既不匹配过滤又落在"最后 25 行"之外被截断），而 job 日志页与 `/logs` 匿名 403。⇒ 已把失败行改成 `❌ 用例名 ⇒ 形状`（只动 print），三条里 ② 已按本地整跑点名、③ 已按浅克隆复现点名（见下面两行）。 |
| 本地整跑与远端整跑的第二条已知环境差（Node 引擎）| 现读 | `.node-version` 钉 **22.23.2**，本机 homebrew `node -v` = **v26.10.0** ⇒ 所有以 `npm test` 为命令的护栏用例，本地与 CI 跑在**不同引擎**上（本机没有 nvm/fnm/volta，也没有 Node 22 可用；不擅自装系统依赖 ⇒ 这一轴**无法本机复刻**）。因此"本地 233/233 只 1 条异常"不能当远端读数的替身，反之亦然；「改坏之后测试仍然通过」这条只在远端出现的标记，这一轴是**尚未排除**的候选。 |
| 本地全量护栏**整跑**（独占 target，2026-10-19 10:03Z 收） | 退码 1，**233/233 全部执行** | 同一份码在 `/tmp/gosslan-b15-verify`（HEAD `4a722b7`）以独占 `CARGO_TARGET_DIR` 从第 1 条跑到第 233 条：**232 条判过「改坏即 FAIL、恢复即 PASS」，恰好 1 条异常** —— `[114/233] 解除好友关系必须同时解除内存身份绑定（否则重装后只能重启）`，报「注入锚点在 friends.rs 里出现 2 次（要求恰好 1 次）」。**根因两条都在量具侧，不在产品侧**：① 这条 Case 声明的 `file=src/commands.rs` 是 `include!` 壳（壳里 0 次命中），解析后进 `commands/friends.rs` 分册，而那行 `forget_peer_identity(s, &peer_id)` 在分册里有两处（`remove_friend` 那一处正是用例要钉的；另一处是换钥同步路径，已被 `[63/233]` 用带注释的唯一锚点钉住）⇒ commands 拆册之后锚点失去唯一性；② **起跑前核对只查存在性**（`_resolve_anchor_file` 不做唯一化断言），唯一性只在真注入那一步才 assert ⇒ 起跑打印那句「233 条锚点都恰好命中一次」是**过度声明**，于是这条要白等约 75 分钟才暴露。修法（交护栏负责人，本轮不动它的语义）：把锚点扩成 118-121 行那段带「// ⚠️ 同时解除内存里的身份绑定」注释的整块，或给两条解除路径各起一条用例；并把起跑核对改成与注入同一个唯一性口径。 |
| 「本地不复现、远端稳定复现」的浅克隆对照（2026-10-19 更晚）| 退码 **1**，10 条里恰好 1 条红 | `guards` job 用的是 `actions/checkout@v4` 默认 `fetch-depth: 1` ⇒ 浅克隆。233 条里唯一把命令钉在真实历史上的那条 = `Change Budget:force push 后 before 不可达不得判空转（改回去必须红）`，`cmd=["node","scripts/check-change-budget.mjs","--range","73d9e20~1..73d9e20"]`（它特意不用 `--from-json`，因为要守的那段带 `!fromJson`）。本机 `git clone --depth 1 file://…` 复现，并**按这条用例自己的 env** 跑整族：`python3 scripts/verify-guards.py --only change-budget` ⇒ **10 条里恰好 `[3/10]` 红**，形状「恢复源码之后测试**仍然失败**」，且它带出的 Node 子进程转储里第 23 行逐字是 `signal: null,`（`stderr: "致命错误：有歧义的参数 '73d9e20~1..73d9e20'：未知的版本或路径不存在于工作区中"`）⇒ **远端三条标记里的第 ③ 条就此定名**；成因在我新加的这条 CI 腿（少给历史），不在这条用例的判据上。⚠️ 踩坑记在此：先**裸跑**同一条命令（不套用例的 `env`）时脚本是优雅退 1、打印「受检范围…（空转）」，输出里没有 `signal` ⇒ 差点据此判成"形状对不上、不是这条"。复现一条用例必须照它的 `cmd` **加 `env`** 一起跑，只照 `cmd` 会复刻出另一个形状。 |
| 该成因的修法（CI 配置，不是护栏） | YAML 解析通过 | `guards` job 的 checkout 加 `fetch-depth: 0`（`ruby -ryaml` 现读 `checkout with: {"fetch-depth"=>0}`、`has_only_flag=false`、`continue-on-error` 仍为空）；pack 现读 21 MiB ⇒ 全量克隆代价可接受。用例本身（锚点、`expect_fail_hint`、阈值、被跑的测试）一字未动。同族其余 9 条在浅克隆下也全绿 ⇒ 浅克隆只解释 `[3/10]` 这一条；「改坏之后仍然通过」那条已由下一次 CI 跑点名＝`发现 socket 必须收得到广播`，机制是 `GUARD_ENV_SKIP` 被 cargo 吞掉的误判（见本表末行）。 |
| 失败点名的量具修正 | `py_compile` 0 | `verify-guards.py` 的逐条结果行在失败时改成 `❌ 用例名 ⇒ 形状`：`ci-run.sh` 只把匹配 `❌|signal|test result:|…` 的关键行放进注解，而用例名打在**上一行** `[i/233] 名字` ⇒ 被过滤掉，末尾 `   - 名字` 汇总又不匹配过滤、还落在"最后 25 行"截断之外 —— 这就是三次远端跑「形状读得出、名字读不出」的原因。只动 print，不动任何判据；`--list` 在改后仍退 0（主工作树现读「238 条用例里锚点存在且唯一的 238 条」）。**已验证生效**：下一次跑（run 39279799140）的注解逐字含 `❌ 发现 socket 必须收得到广播（绑具体 IP 在 macOS 上收不到） ⇒ 改坏之后测试仍然通过` ⇒ 点名不再依赖 job 日志权限。 |
| GitHub Actions run **39279799140** @ `320f4bc`（第三次远端全量护栏，本轮） | `guards` **completed / failure**，63.3 min（15:42:14→16:45:34），**覆盖到 `[233/233]`** | **两条已修的标记在远端同时消失**：注解只剩 `❌ 1 条不符合预期`（② friends 锚点唯一性、③ 浅克隆 ⇒ 与各自的本地读数一致）。**剩下那一条由新的点名格式自己报了出来**：`发现 socket 必须收得到广播（绑具体 IP 在 macOS 上收不到）` ⇒ 形状「改坏之后测试**仍然通过**」。**机制读到源码，不是推测**：该用例 `cmd=cargo("test","--lib","discovery_recv_socket_actually_receives_broadcast")`（`scripts/guard_cases/transport_network.py:200`，**没有 `--nocapture`**），而那个测试在「无可用 LAN 接口」或「本机收不到自己的广播」时走 `eprintln!("GUARD_ENV_SKIP …"); return;` —— `discovery.rs:1246` 的注释明写 **GitHub 的 macOS runner 正是第二种**（2026-09-16 首次 CI 跑红的就是它）。cargo 对**通过**的测试不打印被捕获的 stdout ⇒ `GUARD_ENV_SKIP` 传不到 runner ⇒ `verify-guards.py:290` 那条「环境不支持（不等于护栏空转）」分支在这条腿上**永远不会触发** ⇒ 掉进「仍然通过 ⇒ 空转」。⇒ **这条不是后端缺陷，也不是判据写错，而是同一类量具缺陷第三次**（信号存在但没被转发）。一行修法：那条 `cmd` 加 `--nocapture`。本轮不改护栏（交护栏负责人），且要说清：**加不加都不会让这条 job 变绿**（runner 对两种形状都判 False），差别只在诊断是否说真话。另两条环境事实：macos arm64 **排队 34 分钟**（注解逐字「Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.」）；run 级结论是 **cancelled** 而非 failure，因为 `前端测试 / 清单 / 构建` 那条腿 15:42:13→16:02:35 被取消（属并行前端会话范围，与本轮只动 `guards` 的 checkout 与 runner 打印没有因果证据），其余三条腿 success。 |
| `version:check` / Change Budget / CHANGELOG / 文档硬数字 | 0 | 全部通过 |

### 6.8 剩余风险

- **高**：用户手上的真 v10 现场库 **BLOCKED**（本机四份库全为 v11、4.44.4 自身带 v11 schema，
  不存在未迁移文件；已用"真实数据 + 置回 v10"和"真实数据 + 逐字 v10 DDL"两条副本演练覆盖）。
  2026-10-19 深夜把"本机到底还有没有一份没迁移的旧库"这条**搜尽了**（只读，`mode=ro&immutable=1`，
  不开写事务也不生成 -wal）：应用目录下逐个数到 **4 份** —— `gosslan.db` 598016 B、
  `gosslan-1/2/3.db` 各 258048 B，`PRAGMA user_version` **全是 11**；该目录内没有 `.bak` / `*backup*` /
  `.gz` / `.zip` 任何归档；`tmutil listlocalsnapshots /` **返回空**（这台机没有 APFS 本地快照可捞）；
  再往 `~/Library/Application Support`、`~/Documents`、`~/Desktop`、`~/Downloads`（maxdepth 6）扫到
  30 个 `*.db|*.sqlite*`，除上述四份外全是别的应用的库（`user_version` 为 0 或不适用）。
  ⇒ **结论是"本机不可达"，不是"没找"**：要证真 v10 现场必须用户提供另一台机器/另一份备份里的文件。
  Windows/iOS/Linux 运行时与真机未验证 —— 2026-10-19 用户口径：**其他设备无法交叉编译 PASS
  的先不管**，故 iOS（本机无 SDK，交叉编译也过不去）与 Linux/Windows 运行时本轮
  **DEFERRED**，不再继续装工具链；交叉编译 PASS ≠ 运行时 PASS 的边界保持不变。
- **中**：B15 已落地（3 处收尾事务都有耗时出口，两条判据 + 一次单点变异自证）。仍欠两格：
  `busy_timeout` 触发没有专门一行（只能从等待时长与失败串间接看）；快且成功的事务不产行
  （设计取舍，理由见 §6.10：正常路径"不留痕"那条不变量在测试里钉着，摘要侧已有最长持有/累计）。
  **全量护栏已接进 CI 并跑满三次**：第三次（run **39279799140** @ `320f4bc`）`guards` 跑完 **233/233**、63.3 min、退码 1，注解从 3 条标记降到 **1 条**且那条**自带名字**；前两次（39215124440 / 39235279878）退码 1、报同样 3 条标记；本地独占 target 整跑 233/233 只有 **1 条**异常且已点名（同一条 ②）。三条标记的最终读数：**② 与 ③ 已修并在远端同时消失；① 是「环境跳过」被量具误判成「空转」** —— 那条用例的 `cmd` 没有 `--nocapture`，而 cargo 不打印**通过**测试的 stdout ⇒ 测试自己打的 `GUARD_ENV_SKIP` 传不到 runner，runner 那条「不等于护栏空转」的分支永不触发。一行修法与「本轮不代改护栏」的边界见 §6.7 末三行。**CI 另外两条（一条判「空转」、一条判「恢复后仍失败 `signal: null`」）本地不复现、远端却稳定复现**：第二次全量跑（run **39235279878**，job 118002738402，10:08Z 起跑）报的是**同样那 3 条标记** ⇒ 不是 runner 抖动。★ 2026-10-19 更晚改成按**环境差**取证，两条东西都落在 CI 配置侧：① 这条 `guards` job 的 `actions/checkout@v4` 用默认 `fetch-depth: 1` ⇒ **浅克隆**；而 233 条里唯一把命令钉在真实历史上跑的那条（`Change Budget:force push 后 before 不可达不得判空转`，`--range 73d9e20~1..73d9e20`）在浅克隆里连 `73d9e20~1` 这个对象都不存在 —— 本机 `git clone --depth 1` 复现（**照该用例的 `cmd` + `env` 跑整族**）：`--only change-budget` ⇒ 10 条里恰好 `[3/10]` 红，形状「恢复源码之后测试仍然失败」，转储第 23 行逐字 `signal: null,` ⇒ **远端那条 ③ 就此定名**，成因是这条 job 少给历史，不是那条用例的判据坏。修法在 CI 侧：这条 job 的 checkout 加 `fetch-depth: 0`（pack 现读 21 MiB ⇒ 全量克隆代价可接受），护栏自己的语义/阈值/断言一个字没动。② 「三条定不了名」是**注解量具**的缺陷而不是护栏的：`scripts/ci-run.sh` 只把匹配 `❌|signal|test result:|…` 的关键行放进注解，而护栏把用例名打在**上一行** `[i/233] 名字` ⇒ 被过滤掉；末尾那份 `   - 名字` 汇总既不匹配过滤、又落在"最后 25 行"之外被截断。修法：失败行改成 `❌ 用例名 ⇒ 形状`（只动 print 语句）⇒ 下一次跑自己就能报名字。job 日志匿名 403 这条边界不变。本轮不改护栏本身：不放宽判据、不动阈值、不给 job 加 `continue-on-error`。
  ★ **2026-10-20 更新**：上面那行 `--nocapture` 的一行修法已按当晚指令落地（同一批里唯一动过的护栏改动，见 §6.11 末段与 `scripts/guard_cases/transport_network.py`）—— 断言、阈值、锚点、`expect_fail_hint` 一字未动，这条 job 仍然红，差的只是「环境跳过」能不能被 runner 看见。定时那一条要等这份定义进默认分支（main）才会按夜持续跑。

★ **2026-10-20 这一批推送后的远端真实读数**（`curl` 裸 API 现读，逐条按 job 不按 run）：
`da33f15`（本批 5.0.36）触发的 run **39305238186** 创建时间 18:45:43Z，读数 **pending** ⇒ 本轮**没有**它的结果，
只有"已触发"这一件事实。上一笔 `49bf3cd` 的 run **39290544434** 里四条腿已绿
（rust macos/windows、android、前端 8/8），而 `guards` 那条在 18:46 仍在 `in_progress`（7/12 步）——
**这条被本批推送的 `concurrency…cancel-in-progress` 取消**（新 run 一到，旧的整条链被砍）。
这是把全量护栏接进 push 触发后的固有代价：一条要跑 60~90 分钟的腿，任何后续推送都会把它砍掉，
所以"这一批的护栏在远端跑满"这件事**只能在最后一次推送之后**才读得到 ⇒ 本轮状态如实记 **未跑完（被取消）**，
`--nocapture` 那一行修法目前只有**本机**非空转读数（`--only 发现 socket` ⇒ 改坏 FAIL / 恢复 PASS / 退 0）。
- **中**：远端 CI @`519d473` 的 Verify 因**前端**“操作面板”护栏空转红（1 条，非后端腿；本地复现，手工注入能让 `npm test` 红，判定仍在 runner/CI 路径）；
  单一 SQLite 连接串行化读写；入站 handler 单链路串行；
  **A-17（已修，观察项）：多链路文本 Ack 1/4 抖动；5.0.33 每 5s 重放后 contentpull ×3 绿**；
  Windows ACL 未处理；audit 的 glib/zbus 警告仅 Linux 路径。
- **低**：迁移备份只按数量清扫、无时间保留策略；`gfile` 首跑曾遇 toolchain 环境噪声（复跑绿）；目录权限仅在
  Unix 生效。

### 6.9 最终结论

- **是否达到本轮重构目标？** **未全部达到，但这一轮把最后两格欠账补上了**。数据安全、迁移保护、
  权限、网络可靠性、兼容性、E2E 与 macOS 验收早有实测证据；本轮再补 **B15 事务耗时出口**
  （§9 那格从"未做"变"已落地"）与**全量护栏的自动触发点**（`guards` job）；
  Rust **993 通过 + 1 ignored**、E2E 32 轮/863、互操作 8 轮/216、verify:local 22/22。
  仍然没绿的两格照实留着：真 v10 现场库（BLOCKED，缺文件）、GUI 真机/平台运行时（NOT RUN）。
- **用户数据是否经过真实迁移验证？** **部分是 PASS、最后一格是 BLOCKED**。
  v0–v11 合成迁移、逐字 v10 DDL 夹具均通过；**真实安装数据**（当天最新，93 条消息/340 行）
  的副本置回 v10 后跑生产 `init`：exit 0，逐表行数、5 组语义聚合、9 种 kind 分布、
  `mention_targets` 非空行数迁移前后**逐项相等**，关联关系独立查询 0 断链，
  自动备份单独以只读方式可开（v10/19 表/integrity ok）。
  **仍未证明的只有一件事**：本机不存在"停在 v10 未迁移"的用户现场库
  （已装的 4.44.4 自身就是 v11），所以真 v10 现场标 **BLOCKED**，需用户另供文件。
- **是否确认没有破坏已有业务功能？** **在已跑范围内确认**：Rust **993 通过 + 1 ignored**
  （macOS 与 Windows 两条远端腿各自 success）、E2E 32 轮/863、4.44.4↔5.0.33 互操作 8 轮/216、
  迁移 38+1、cargo audit 0 漏洞、护栏定点与分族非空转自证；未跑的真机与
  Windows/Linux/iOS **GUI 运行时**不能据此确认。
- **大文件传输期间应用仍可响应？** **通过（有边界）**：5.0.32 release 在 **600MB**
  contentpull 传输中，接收端设置窗口 **397ms** 可开（System Events 实测；探测后停轮，
  只证响应性）；300MB 下 5.0.29 读数为 **734ms**。5.0.31 补测单 PID RSS 峰值
  **126.1 MiB**、low 队列 8 MiB/链路、服务队列 8/对端，无整份文件入内存迹象。
- **哪些平台真正通过了测试？** macOS arm64 **PASS**（fmt/clippy/Rust/前端/Android 编译、32 轮 E2E、
  远端 `Rust 单测（macos-latest）` success）；**Windows x86_64 今轮升级为"真 runner 上跑过测试"**：
  远端 `Rust 单测 / 清单（windows-latest）` **success**（07:18:22→07:23:19），且 B15 那两条判据
  **没有平台门控**、两边基线都已登记 ⇒ 它们在真 Windows runner 上执行过；加上本机
  `cargo xwin build --release` exit 0 的 PE32+ 产物。**Windows 的 GUI 应用运行时仍 NOT RUN**
  （没有 Windows 桌面主机）。Android aarch64 **PASS（仅编译，ubuntu runner 真跑 cargo）**；
  桌面 Linux 运行时 NOT RUN；iOS **NOT RUN 且当前没有可跑它的地方**（无任何 iOS 工作流、无 SDK/签名）。
- **哪些问题仍然存在？** 真 v10 现场库（BLOCKED）、GUI 真机与 Windows/Linux/iOS 运行时、
  单一 SQLite 连接串行化、Windows ACL、Linux GTK/D-Bus 传递依赖告警、`busy_timeout` 无专门一行、
  跨进程统一 trace 仍靠 id 人工串；**A-17 已修（观察项）**；另有 A-9/A-10/A-13 等已登记未修项
  （见 `docs/stability-roadmap.md`）。
- 本轮**已按授权把 `feat/5.0` 推到远端**（`3de6dd9` 及以下未动）；**未推 main、未 merge、未 tag、
  未发 release**。全量护栏 job 已跑三次：第三次跑完 **233/233** 并把标记从 3 条降到 **1 条**，而那 1 条也已点名并读到机制（环境跳过被 cargo 吞掉 `GUARD_ENV_SKIP` 造成的误判；一行修法＝给那条 `cmd` 加 `--nocapture`，交护栏负责人，本轮不代改）——**这条 job 仍然是红的，红是结论，不是我没读**；本指令范围内的可执行项已全部落地并读远端真数，
  仍开的三格各有归属：**护栏负责人**那一行 `--nocapture`（不改它这条 job 也永远不会绿）、
  **用户供件**的真 v10 现场库、**真机/runner** 的 Windows·Linux·iOS 运行时（用户已裁「先不管」）；
  不宣称「全面完成」，也不发 release。

### 6.10 可观测性覆盖（第九阶段）

| 链路 | 现有关键锚点 | 关联键 | 缺口 |
|---|---|---|---|
| 消息 | 创建/入队/发送/确认/落库各自的既有日志（outbox、chat 命令） | `msg_id` | 无跨进程统一 trace，只能按 `msg_id` 人工串 |
| 文件 | `[FILE] offer-sending` / `offer SENT` / `accept RECEIVED` / `COMPLETED ok=`；接收侧初始化/ SHA / fsync / rename 失败留痕 | `transfer_id` | 无单条"总耗时分解"（accept→首片→末片→Ack 分散在多行） |
| 内容拉取 | `ContentRequest：本机没有该内容 cid=` / `请求方无权限 cid=`；服务队列溢出留痕 | `cid` / `tid` | — |
| 发现/链路 | `diag/announce_verified`、`建链 peer=`、`DialOutcome::Failed` 阶段名 | peer id | 成功路径缺分阶段耗时 |
| DB | 新增 `db 持锁观测：…`（60s 窗口，慢锁才 warn；含取锁次数/最长持有/最长等待/累计/超阈值次数）+ B15 的 `tx <阶段> transfer_id=… ms=… ok=…` | 三条收尾事务用 `transfer_id`；锁摘要无键（全局单锁） | `busy_timeout` 触发仍无专门一行；快且成功的事务不产行（其耗时在 60s 锁摘要里） |
| 后台任务 | 清扫器/队列失败留痕 | 任务名 | 任务退出/取消没有统一一行 |
| 工具决策 | 不引 `tracing`/OpenTelemetry：同步落盘是崩溃现场与最后一条日志的证据前提（B4）；外部遥测需隐私评估 | — | — |

- **B15（已落地，2026-10-19）**：事务级耗时出口。分母按"生产事务调用点"现算 = **3 处**
  （`src-tauri/src/network/transport/group_file.rs` 群文件收尾、`src-tauri/src/network/file/receive.rs` 单聊收尾、
  `src-tauri/src/network/file/ledger_backfill.rs` 群台账补账 —— 后者计时含取锁等待，因为它包住
  `gfile_ledger_repair` 那一次调用，册内只有那一个事务）。统一出口是 `db_hold::note_tx`
  （**只量不改**：不取锁、不重试、不碰 commit/rollback 与错误语义），一行里只有
  `tx <阶段> transfer_id=<键> ms=<耗时> ok=<成败>` —— 没有 SQL、参数、正文、文件名或密钥。
  阈值沿用 `DbLock::slow_threshold_ms`（500ms，同一个家，不另造常数）。
  **只在超阈值或失败时留一行**：既有不变量
  `network::file_tests::normal_completion_writes_no_ledger_note` 钉的是正常收尾**一行都不许写**
  （`logger.snapshot(None).is_empty()`），而快且成功的事务耗时本来已在 60s 锁摘要里
  （`summary_line` 的最长持有/累计）⇒ 这一格补的是"慢在哪一步、失败那次花了多久"，
  不是给每条正常事务加噪声。**没有为了通过而改那条不变量**。
  判据两条：`db_hold::tests::note_tx_stays_quiet_unless_slow_or_failed`（行为：快成功不留痕、
  慢留 warn、失败留 warn 且 `ok=false`、总共恰好 2 行）与
  `tests::production_transaction_sites_are_all_timed`（接线：每册事务调用点数=1、
  `note_tx` 调用数=1、必须有 `Instant::now()` 起点、阈值必须取自 `slow_threshold_ms()`，
  并钉住出口那一句的 `format!` 形状）。单点变异实测：把 `receive.rs` 的
  `crate::db_hold::note_tx(` 改成合法但不匹配的 `note_tx /*B15 变异*/ (` ⇒
  该判据 **exit 101** 且报"receive.rs 的收尾事务必须有且只有一条耗时观测"；
  还原后逐字节相同、两条判据各自 **exit 0**。
  **领域依赖方向那把棘轮把这一批顶回来过一次**（现量）：三处出口最初都写成内联
  `crate::db_hold::note_tx(`，第 13 步 `check-domain-deps.mjs` 当场红
  ——「内联跨域引用对数 7 超过棘轮上限 6」，新增那对是 `transport→observability`。
  按它自己给的修法① 处理：`network/transport.rs` 改成声明出来的
  `use crate::db_hold::note_tx;`，并把 `observability` 加进「传输」域的 `consumes`
  （`docs/domains.data.mjs`；「文件」域早就声明过这条边，所以那两处内联不计新增对）。
  复跑 **exit 0 / 6 对**。**上限没有调大**（它 2026-10-07 从 13 收到 6，比原来严）。
  ⚠️ 一个只有读实现才知道的事实：这把棘轮按**领域是否有 `use`** 判可见，光把域名写进
  `consumes` 不减少配对数 —— 接线判据因此多钉一条"transport.rs 必须有那条 use"。
  ⚠️ 本批带 **5.0.35** 版本清单与 CHANGELOG 条目（并行前端会话的 5.0.34 已提交为 `3de6dd9`，
  号是空的才敢动）。这一格被门禁顶回来过一次，值得记：判据 4 报「声明了 `Version-Bump: patch`，
  但 1/4 个版本清单文件没动：**package-lock.json**」——`scripts/version.mjs` 会连 lock 一起改，
  是我提交时把它漏在了文件清单外。这条红**只能在声明它的那条提交上修**，后面补一笔新提交消不掉
  ⇒ 我用 temp-index plumbing 把自己刚造的两笔未推提交重建成一笔 `d42003f`（17 文件，
  四个版本清单 + Cargo.lock + CHANGELOG 齐），`3de6dd9` 及其以下一字未动、SHA 不变。

- 新增锁摘要的**唯一生产读者**与唯一启动点由
  `db_hold_summary_has_exactly_one_production_reader` 钉住；数字行不含 SQL、参数、
  正文或文件名。

### 6.11 生产诊断补齐（2026-10-20，5.0.36）

**先审计再动手**：现读 `src-tauri/src/logging.rs`、`lib.rs:237-268`、`boot/boot.ts:45-63,124-127`、
`commands/settings.rs:238` 之后确认——**日志层、panic 钩子、分配失败留痕、启动路标、前端三条 hook
→ `log_frontend_error` 这条链本来就在**，`tauri-plugin-log`/`tracing` 一个都没装也不需要装
（再引一套只会多一个漂移点）。这一批只补审计查出来的四个 MISSING 格：

| 补的那格 | 实现 | 实测读数 |
|---|---|---|
| 落盘失败静默 | `append_file` 返回 `Err(原因)`；调用方计数（`write_fails`）+ 第一次把降级说明送进**内存环**（不再走 `log()`，避免回环）；ENOSPC/`EDQUOT(122)`/Windows `112`/`3900` ⇒ 置降级位，256 行退避窗口 | `disk_write_failure_is_counted_and_noted_in_memory`：目录改 0500 后 ⇒ 计数 >0、内存环里有「日志落盘已降级」**恰好一条**（反例靠第二条之后**重读快照**判，不是拿旧快照数）、两条日志本身都还在环里 |
| 上次怎么结束的分不开 | 新增 `----- 正常退出 … 运行 <id> -----` 路标（托盘「退出」这一点 + `RunEvent::Exit` 那一臂）与 `classify_previous_exit` 四态；**判定行写进 `gosslan.log`** | `previous_exit_is_classified_by_presence_and_absence`（四态）+ `exit_marker_lets_next_run_read_previous_as_clean_and_absence_as_abnormal`（正控 + 反控）。⚠️ 这条测试第一次就抓出真缺陷：**写了路标却没加进 `is_crash_native_line`** ⇒ 读不到，永远判成「异常终止」 |
| 一次运行没有标识 | `Logger` 带 `run_id`（6 位十六进制，wrapping 哈希），写进「启动」与「正常退出」两条路标 | `startup_marker_carries_the_run_id`。⚠️ 第一版写 `a * 131` 在 debug 溢出 panic ⇒ 改 `wrapping_mul`；`ErrorKind::StorageFull` 稳定于 1.83 > 本仓 MSRV 1.77 ⇒ 只用裸 OS 码 |
| 后台任务失败无证据 | `await_tasks` 的 `let _ = t.await` 与超时的 `eprintln!` 都改成经 `logger`（`warn [net_task]`）；`start_in_order` 那条无 logger 的臂显式传 `None` | `failed_background_task_leaves_one_named_warning_while_a_clean_one_leaves_none`：正控（干净任务）**0 条** + 反例（任务内 panic）**恰好 1 条**、级别 warn。做过单点变异：摘掉 warn 那一支 ⇒ 红（报「实测 0 条」），原样写回 ⇒ 绿，`diff -q` 证复原。**量具形状坑**：这条原先写在 `mod tests` 里、`#[tokio::test]` ⇒ `whole_file_slow_work_never_runs_on_an_async_worker` 的分母从 18 顶到 26（那条守卫给 `async fn` 定边界用「下一个第 0 列 `}`」，测试体里清理临时目录的 `std::fs::remove_dir_all(` 被每个 async 段各数一遍）。没动那条守卫的判据与阈值，改成 `#[test]` + 自建 current-thread runtime + `block_on(async { … })`（async **块**不是 `async fn`）⇒ 两条都绿 |
| 诊断包导出命令面 | **本轮不交付**（详见 §6.11.1） | 一度做完（命令 + api 包装 + 注册 + 契约图行），被自家契约判据 `mapContract.test.ts` 判成「包装全仓没人引用」⇒ 按「做不完的新字段整轮还原」撤干净；现算「这两个命令名在 `src/` 与 `src-tauri/src/` 里各出现几次」= **0 处残留** |

**生产构建验收（不是"注册了钩子"，是文件里有行）**：`target/release/gosslan` + 隔离 `HOME=/tmp/gosslan-diag-home2`：

- `kill -9` 之后下一轮日志文件第 16 行 = `warn [boot] 上次收尾判定：异常终止 —— 只有启动路标，既无正常退出路标也无崩溃现场…`；
- 把在用的库文件截断（`truncate -s 64`）后，同一文件里出现 `error [file] 群文件台账补账：候选扫描失败… database disk image is malformed` ⇒ **生产构建的 Rust 侧失败确实落盘**；
- 同一份文件里启动路标实测带 `版本 5.0.36 · macos-aarch64 · release · 设备 [dev:Mac-wendon] · 运行 dc7085`，
  三次启动三个不同 run id（`dc7085` / `49d2e1` / `f3846a`）⇒ `run_id` 在生产里真的把每一轮切开了；
- **`kill -TERM` 与 `kill -9` 在这一格同形**（2026-10-19 18:33 现读）：两种杀法之后下一轮都读成
  `warn [boot] 上次收尾判定：异常终止…`，文件里 `----- 正常退出 ` 条数 = 0 ⇒ **外部信号杀进程一律接不住**，
  退出路标只由应用内收尾写。这条把"哪些收尾臂真的接得到"从推测变成读数（Clean 那一支目前只有单测 + 代码路径，
  真机点托盘「退出」那一次仍未做 ⇒ 该支状态 **NOT RUN**）；
- 权限现读：`gosslan.log`/`gosslan-crash.log` `-rw-------`、`com.gosslan.app` `drwx------`、
  `com.gosslan.app/logs` **`drwxr-xr-x`** —— 日志层只给文件设 0600，`logs` 目录没设过。
  别人读不到内容靠的是父目录那一层。修法是一行 `restrict_to_owner(&self.dir)`；本轮**不动行为**，
  把实测与欠账一起写清楚（既有判据 `log_and_crash_files_are_owner_only` 钉的是文件那两把）。
- **前端那一跳也实测到了（18:55，release 二进制 + 隔离 HOME）**：用一个**一次性探针**在主窗口入口
  （`src/entries/main.ts`，本轮唯一临时动过的前端文件）在 8s/9s 各抛一条未捕获异常与一条未处理 rejection，
  重新 `npm run build && cargo build --release` 后跑真二进制，`gosslan.log` 第 18/21 行逐字是：
  `warn [ui] [前端 error] Error: DIAG-PROBE-5036 未捕获异常 @ tauri://localhost/assets/main-C03aaf90.js:26:33282` 与
  `warn [ui] [前端 rejection] DIAG-PROBE-5036 未处理 rejection` ⇒ **走的就是 shipped 那条链**
  （`window error`/`unhandledrejection` → `reportFrontendError` → `logFrontendError` → `commands::log_frontend_error`
  → `logger.warn("ui")` → 落盘），文件与行号都带出来了。
  ⚠️ 边界要说清：**探针没有入库** —— 跑完立刻按字节还原（`git diff --quiet src/entries/main.ts` 与 `cmp` 各证一次），
  所以这条读数的形状是"临时插桩的一次真实性能跑"，不是"界面上有一个能复现它的按钮"。
  要把这一格变成可复用的能力，仍然需要 §6.11.1 说的那 5 件收尾（命令面 + 按钮 + 语言包）。
  另外这条也顺带证明了**栈/位置在 WebKit 里同样能拿到**（`main-C03aaf90.js:26:33282`），
  与旧那条"WKWebView 的 `error.stack` 不含消息行"的教训不冲突 —— 消息与位置来自 `e.message`/`e.filename`，不是 stack。

**内存（§4）先测不猜**：新增 `scripts/mem-sample.mjs`——分别采主进程与 `com.apple.WebKit.WebContent` 的内容进程
（`ps` 的 RSS，能取到 `footprint` 就用 physical footprint；`usedFootprint` 如实记），每点带 pid 序列以便区分
"同一进程单调涨"与"多开了一个进程"。60s 空闲基线（14 点，RSS 口径）：主进程 104,848 → 峰 104,896 → 末 102,112 KB；
WebContent 119,728 → 119,728 → 100,384 KB ⇒ **空闲态没有增长**。**JS 堆 NOT RUN**：WKWebView 没有 CDP，
本机也没有可用快照通道 ⇒ 不许拿 RSS 冒充 JS 堆。

⚠️ **第一轮压力测量的读数是废的，而且废在量具上**：同一份采样脚本对 `--round=gfile`（8 子轮、约 422 s）
采到 83 个点，但**被测实例只在其中 1 个点里存在**（每个 pid 只有 1 个采样点），于是分组求和的
`baseline=0 / final=0 / delta=0` 会被读成「内存完全恢复」，真实含义是「采样窗口两端没有进程在跑」。
这条形状和历史上「整批同幅偏移 = 尺子坏了」是同一类：**先修量具，再读数**。`mem-sample.mjs` 改成按 pid 记轨迹、
并把覆盖率（`seen/total`）一起写出来，覆盖不足时基线/终值一律 `null` + 一句「采不到轨迹」。
压力轮的可用读数与结论见 §6.11.2。

### 6.11.1 「导出脱敏诊断包」为什么这轮没交付

判据不允许半成品：`src/utils/mapContract.test.ts` 三条一起判 —— 每条 `invoke("x")` 要在
`generate_handler!` 里注册、注册集合要与 `docs/ARCHITECTURE-MAP.html` 的 IPC 表双向一致、
**api 包装若既不在界面也不在 store 里就是多余面**。命令本体是好的，缺的是「有人按它」。
而能放按钮的 `LogViewer.vue` / `DevDiagPanel.vue` / `ResponsiveLayout.vue` 与 `src/api/index.ts`、
`src-tauri/src/lib.rs`、`src/i18n/locales/*` 此刻全是并行前端会话的未提交 `M` 文件 ⇒
本轮不覆盖别人在飞的文件，也不留一条没人调的 API（台账里那条「做不完的新字段要整轮还原」）。

**当下真实可用的路径**（用户文档 `docs/notes/diagnostics-where-logs-are-2026-10-20.md`）：
界面「更多 → 运行日志」看最近错误（内存环 ≤500 条，**不读** `.old.log` 与 `-crash.log`）+
按文档里的目录手工取那三份文件。**下一次闭合的顺序**（交前端线负责人，一次做齐 5 件）：
命令注册 → 契约图 IPC 行 → 按钮 → 两份语言包键 → `check-doc-citations`/`npm test` 复跑。

### 6.11.2 内存（§4）：这一轮能说到哪、不能说到哪

**能说的（单实例长跑，1 Hz，227/227 点全覆盖，`/tmp/mem-long.json`）**：同一个 pid 活 235 s 的轨迹 ——

| 那一条链 | 首 | 峰 | 末 | 后半段均值 − 前半段均值 |
|---|---|---|---|---|
| 主进程 pid 22365（Rust/Tao） | 104,688 | 104,752 | 101,776 KB | **−667 KB** |
| WebContent pid 22369（界面 1） | 73,808 | 73,824 | 64,384 KB | **−1,932 KB** |
| WebContent pid 22391（界面 2） | 52,608 | 52,608 | 37,168 KB | **−4,069 KB** |

两侧都是**不回涨**（末值低于首值、峰 ≈ 首值）⇒ 这一窗口内没有"单调增长"的形状可指。
读数口径写死在脚本里：`ps` 的 RSS（`footprint` 本机取不到 ⇒ `usedFootprint:false`），
**不是 JS 堆**；`jsHeap: NOT RUN`（WKWebView 无 CDP）⇒ 「分配器没归还」与「JS 侧真泄漏」这两种形状
在这套量具下**分不开**，不许把 RSS 回落读成"没有泄漏"，也不许把 4 分钟读成"长跑没问题"。

**不能说的**：① 用户报的"图片/大文件收发期间界面卡死"**没复现**——本轮没有可驱动界面的注入通道
（release 下 WKWebView 没有 CDP，UI 自动化那一路在本仓属于"能跑但不在本批"）⇒ **NOT RUN**；
② 传输负载下的轨迹采不到：群文件那轮的实例只活几秒，`--round=gfile` 两轮（1 Hz 与 5 s 间隔）
各自只覆盖到 `app` 组 `0/457` 与 `1/83` 个采样点 ⇒ 峰值/恢复那一格 **BLOCKED**（量具窗口比实例寿命粗一个量级，
不是"测出来没涨"）；③ 数小时级的驻留曲线没有跑 ⇒ 无读数。

**无界增长点这一轴的处理**：本轮只做了"看得见形状"的那一半（按 pid 分组的轨迹 + 覆盖率），
监听器/定时器/组件卸载/图片解码/分片缓冲/队列/缓存/SQLite 结果集/Tokio 任务/通道 这十处
**逐个的容量核对没有做**（其中已有上限的是日志环 500、`MAX_LOG_FILE_BYTES` 512 KiB、崩溃现场 2 MiB、
diag 折叠表 512 键、blob 缓存按字节封顶——那些是既有实现既有的判据，本轮没动）。⇒ 该项状态 **NOT RUN**。

### 6.12 5.0.37 有限收尾：目录权限那一格 + 诊断包的后端出口

上一节 §6.11 那张表里「诊断包导出命令面 = **本轮不交付**」那一格，从 5.0.37 起作废：命令面交付了，
**界面那一格仍然没接**。另外两处口径要更正（都是上一轮按当时的判据形状说的话）：

| 项 | 状态 | 复跑命令 / 读数 |
|---|---|---|
| `logs/` 目录收紧到仅属主 | **PASS（macOS 本机）** | `private_fs::create_private_dir`（mkdir 直接带 `0o700`）+ `Logger::new` 启动补 `restrict_dir_to_owner` 并把目录内所有 `*.log` 收到 0600。三条判据 + 三发单点变异（摘启动 chmod / 摘 mkdir mode / 摘 append 里的文件 chmod）各自 FAIL、原样恢复后全绿，两个源文件 SHA-256 恢复前后一致 |
| 真机旧形状 | 修前 `…/com.gosslan.app/logs` = `drwxr-xr-x`、停跑实例的 `gosslan-3.log` = `-rw-r--r--` | `ls -ldT` / `ls -lT`（2026-10-20 00:29 现读） |
| 修后形状 | 见本节末「真机读数」段（同一台机器、同一个 release 二进制跑过一轮之后再读） | 同那两条命令 |
| 「查看日志」 | 早就有：`get_logs` + 日志窗 + 移动端日志页 | 不动 |
| 「复制路径」 | **后端出口 PASS / 用户可达 NOT RUN** | 新命令 `get_log_locations`（目录 / 本轮那份 / 崩溃现场） |
| 「导出脱敏诊断包」 | **后端出口 PASS / 用户一键导出 FAIL** | 新命令 `export_diagnostics_bundle(destination)` + `src-tauri/src/diagnostics.rs`；脱敏五类形状全部来自真机日志现读，正控 + 反控各一条判据 |
| 两条命令为什么没红判据 | 走的是判据自己留的那个出口：`src/api/events.test.ts` 的 `DEAD_COMMANDS` + 写明归属 | 这条挂账**会自己过期** —— 前端真 invoke 之后 `resurrected` 那一格判红逼着删条目 |

⚠️ 上一轮那句「契约判据会把无人调用的命令直接拒掉」说得不准确，这里按实测改成能执行的样子：
判据不是"直接拒"，而是**逼作者把「为什么现在不能接界面」写进 `DEAD_COMMANDS` 并留人负责**
（`get_topology` 就是同一个形状的既有条目）。所以本轮的正确做法是挂账 + 交接文档，
而不是把已经写完、已经测过的命令面撤掉（上一轮撤了，等于把同一件事重做一遍）。

平台权限模型口径：`cfg(unix)` 这条路覆盖 macOS 与 Android（Android 的应用私有目录系统本来就给 0700）；
Windows 侧 `create_private_dir` / `restrict_dir_to_owner` 都是空实现 —— app data 在 `%APPDATA%`
用户 profile 下，该树 ACL 由系统只授给该用户与 SYSTEM，而 `std::fs::set_permissions` 在 Windows
只影响只读位，硬套 POSIX 语义反而会让用户以为权限被改动过。MSRV 1.77：用到的
`DirBuilderExt::mode` 远早于它，没引新依赖。

### 6.12.1 大文件传输期间的 UI 与内存（§4 那一格这一轮的真实读数）

跑法（可复跑）：`E2E_FREEZE_MB=200 E2E_FREEZE_S=60 node scripts/e2e-multi-instance.mjs --fault=peer-freeze`，
release 二进制 `src-tauri/target/release/gosslan`，双实例 A=`…-i1` / B=`…-i2`，
2026-10-20T01:09:44Z → 01:11:01Z，**全绿 24 条断言**（冻结那一步本身 63.4 s，6 条断言）。

| 测的东西 | 读数 | 口径与边界 |
|---|---|---|
| 采样覆盖率 | app 组 32 点里 **29/32**、4 个 pid；webContent 组 **32/32**、8 个 pid | `node scripts/mem-sample.mjs --attach-only --duration 70000 --interval 2000`；每 2 s 一轮 |
| 内存数值 | app 组 基线 106,048 → 峰 **203,232** → 末 47,648 KB；webContent 组 基线 64 → 峰 **287,280** → 末 31,808 KB | ⚠️ 是 `ps` 的 rss（这台机器 `footprint` 取不到，量具自己打了 `usedFootprint: false`），**不是 JS 堆**。且一组里 pid 会换（实例重启/辅助窗），组内"基线→末值"跨了不同 pid ⇒ 不许读成"同一条曲线涨到 281 MB 又跌回来" |
| 同 pid 的走向 | 主进程两个 pid 的 `driftSecondMinusFirstHalfKb` = **−4,358 / −8,173 KB**；WebContent 五个 pid = −381 / −5,541 / −5,989 / −4,805 / −2,776 KB | 按 pid 各自算"后半段减前半段"，全部为负 ⇒ 这一轮**没有**观测到单调增长；这不等于"没有泄漏"（70 s 一轮、单个 200 MB 文件、样本 29~32 点） |
| 发送端界面 | `Cmd+,` 之后 **687 ms** 出现第 2 扇窗（窗口名 `设置`）；冻结窗口内三次 AX 往返 **210 / 176 / 171 ms**，且两次都能列出 `设置` + `Gosslan` | ⚠️ 归属按 §6.12.2 的更正读：687 ms 那一次发生在轮次第 2–3 步（大文件还没开始跑），**不能算"传输期间"**；落在"200 MB 在飞 + 对端被冻"窗口内的只有那三次 AX 往返 |
| 接收端界面 | **这一轮判不了**（B 被 `SIGSTOP` 冻住是注入设定本身） | 要复现的是 2026-10-15 记的那条「100 MB 传完台账停在 active/0.8425、续发文本 150 s 不达」—— 那个形状是"对端正常但慢"，不是"对端被冻" ⇒ 仍欠一个轮次，**接收端卡死本轮未复现、也未宣称修复** |
| 切换会话 | 点击已发出（列表区三处坐标），但"当前会话确实换了"没有可判读数 | **NOT RUN（缺判据）**：窗口标题不含会话名，要靠 AX 取会话列表选中项或应用内那条切换日志 —— 记成实测就是假绿 |
| 日志 | 那两份实例日志里本轮新增只有 `warn [boot] 上次收尾判定：异常终止`（上一轮 E2E 收尾是 kill，符合预期），**没有新增 error** | 复跑：`grep -hE " (warn|error) " "$appdata/logs"/gosslan-*.log` |
| JS 堆 | **NOT RUN** | WKWebView 没有 CDP，本机没有可用的堆快照通道（量具自己在 meta 里打了这句） |
| 修后目录权限 | `…/com.gosslan.app/logs` = `drwx------`（00:29 那次读数是 `drwxr-xr-x`）；目录内**每一份** `.log` = `-rw-------`，含 10-18 之后没人写过的 `gosslan-3.log`（原来 0644） | 这一条是 §2 启动扫描旧文件那格的**真机后效**：不再只有本轮 stem 被收紧 |

一句话结论：**对端失联（200 MB 在飞）的窗口里发送端 AX 往返 171~210 ms 应答正常，内存按 pid 看没有单调增长，但接收端 UI 卡死这条本轮既没复现也没排除。**

### 6.12.2 更正 + 第二次跑（600 MB、对端**正常**、把测量钉在传输窗口内）

**先更正上一条里我说满了一句**：那格写的"发送端在 200 MB 传输…窗口里 687 ms 打开设置"不成立 —— 对着自己留下的时间线复核：实例 01:09:46 起来、按键 01:09:47–48，而那一轮的大文件是在这之后的步骤才开始跑的。
所以 687 ms 那次只能算"实例启动后、传输前"的应答；**落在传输窗口内的只有后来那三次 171~210 ms 的 AX 往返**（对端被 SIGSTOP、200 MB 停在半途的那 60 s）。表格那一格已按这个口径改 —— 结论方向没变（主线程没卡），但"什么时候测的"变了，这正是要不要信这条读数的分水岭。

第二次跑把这件事做实：**用"接收目录里的文件正在长大"这个外部信号当门闸**，量到增长之后立刻测，而不是靠"应该正在传"。

| 项 | 读数 | 边界 |
|---|---|---|
| 门闸 | 01:53:25 现读 `recv/*` 合计 1,048,576 → 6,291,456 字节（两次 0.2s 轮询之间） | 这就是"确实在传输窗口内"的证据，不是推断 |
| 界面应答 | 两个实例进程的 AX 往返各 3 次：**166 / 153 / 163 ms** 与 **142 / 141 / 133 ms** | 落在门闸之后 25 s 内（600 MB 还在灌）⇒ 两侧主线程都应答 |
| 传输结果 | `E2E_GFILE_MB=600 node scripts/e2e-multi-instance.mjs --round=gfile` 全绿 **28 条断言**，两端字节数与 sha256 一致、无 `.part` 残留 | 同一条命令可复跑 |
| 内存 | app 组 2 pid、基线 120,224 → 峰 **224,128** → 末 96,048 KB（覆盖 3/125）；webContent 组 6 pid、77,408 → 峰 **304,480** → 末 55,312 KB（覆盖 **125/125**，125 点 / 260 s） | 仍是 `ps` 的 rss，不是 JS 堆 |
| 两次放一起 | 200 MB 那次 WebContent 峰值 287,280 KB、600 MB 这次 304,480 KB —— **峰值几乎不随载荷涨**，且两次结束后都落回基线以下 | 只说明"这两轮没观测到与载荷成正比的常驻增长"；那 ~300 MB 峰值出现在哪个环节我**没有证据**，不写成机制 |
| 传输期间打开设置 | **PASS（第三次跑补上）**：增长门闸命中后**当场重新枚举 pid**（上一轮失效就是因为缓存了会被驱动重启换掉的 pid），两个实例进程各命中一次 —— pid 14263 **948 ms**、pid 14311 **826 ms**，窗口名 `Gosslan` → `设置, Gosslan` | 判据是"窗口名里新出现了设置"，不是"点了没报错"；同轮 `gfile 800 MB` 28 条断言全绿 |
| 传输期间切换会话 | **PASS（第四次跑，像素判据）**：增长期间点侧栏 `(370,350)`，聊天区截图哈希 **82bb47fccc84 → 368a14c295df** 在 **669 ms** 内变化 ⇒ 这次点击确实走到了切换；不靠肉眼也不伪造库状态 | **正控**：同一轮先抓"应用区"与"绝不可能有窗口的边角"两块，哈希不同（`2262b781ddb7` / `62cd5f039109`）⇒ 屏幕录制可用，这条判据才成立；两块相同则当场作废 |

**与 §1 那条 CI 红的机械联系**：本机 00:34 网络掉出去那一刻，日志里就是
`warn [discovery] diag/broadcast_error: target=255.255.255.255:59991, error=Can''t assign requested address (os error 49)` ——
与 CI macOS runner 上那条用例跳过的成因同一类：**没有可用广播路由**。所以那条红既不是"护栏坏了"也不是"产品坏了"。

**第三次 / 第四次跑的分工**：第三次专测"传输期间打开设置"（`Cmd+,` + 窗口名变化），第四次把设置窗让出来、专测"传输期间切换会话"（像素哈希 + 屏幕录制正控）。这两格此前都挂 NOT RUN，原因是量具追错进程、以及没给屏幕录制做正控 —— **不是产品应答不了**。

### 6.12.3 全量护栏远端那条红：现在有日志原文点名的因果

本机取不到 Actions 的日志包（`/logs` 要认证，这台机器只有 SSH 凭据），但 **check-run 的注解**公开可读：
`curl -s https://api.github.com/repos/<owner>/<repo>/check-runs/<job-id>/annotations`（复跑同这条命令）给出的关键行是——

> ❌ 发现 socket 必须收得到广播（绑具体 IP 在 macOS 上收不到） ⇒ 改坏之后测试因**环境不支持而跳过**（GUARD_ENV_SKIP），非空转在此环境无法证明（不等于护栏空转），请换真机/支持环境重跑
> ❌ 1 条不符合预期

读出来的三件事，逐条可核对：

1. 上一夜那行 `--nocapture` 的修法**生效了**：红不再被误判成"护栏空转"，而是报出"环境不支持而跳过"，这正是那次改动承诺的唯一一点。
2. **233 条里只有这 1 条**不符预期，其余（含 229–233 那五条 Change Budget）都打了"✅ 改坏即 FAIL、恢复即 PASS"；同一条用例本机独立复跑是 **PASS**（`python3 scripts/verify-guards.py --only "发现 socket"`）⇒ 是环境差异，不是判据在两份机器上给不同结论。
3. 剩下的那一步不是工程问题而是**口径问题**，两条路都不该由我拍：
   - 让 runner 上的"环境跳过"不再判红 ⇒ 等于把"非空转证明"在 CI 里降级；这类环境拦停往往是**唯一**挡住假绿的东西，摘掉它就是造一个会绿的量具。
   - 或把注入形状改成 runner 上也能证的东西（不走真广播）⇒ 但那就不再证明"绑 0.0.0.0 才收得到"这句话，属于换命题/放宽。
   本轮按指令**两条都没做**：断言、阈值、锚点、`expect_fail_hint` 一字未动。

**两个分支上的终态都是同一句**（等到底之后现读的，不是引用昨晚那次）：`200f40a` 在 `feat/5.0`（run 39307378114，
guards job 118250285332）与在 `main`（run 39347517334，guards job 118383992293，00:26:27→02:10:42 跑完 1h44m）
两条 run 上都判 **completed / failure**，而两份 check-run 注解的**关键行逐字相同**：
输出同为 1168 行、同一条 `发现 socket 必须收得到广播 … GUARD_ENV_SKIP …`、同为 `❌ 1 条不符合预期`，
其余 232 条（含 229–233 那五条 Change Budget）都打"✅ 改坏即 FAIL、恢复即 PASS"。
⇒ 这不是抖动，是**确定性**的环境依赖：同一份码在任何一台 macOS runner 上都会红在这一格。
同一条 run 的另外四条 job 终态：Rust macos / Rust windows / Android 编译门禁 全 **success**，
"前端测试 / 清单 / 构建" 是 **cancelled**（它 6 个 step 全 success，作业级结论却是 cancelled —— 这一格读数自相矛盾，
按 NOT 采信处理）。

## 7. 任务书逐项对照（完成审计）

| 任务书要求 | 状态 | 证据 / 边界 |
|---|---|---|
| §3.1 真实仓库基线 | **PASS** | 分支/版本/工作树、真实库只读读数、模块与调用链见 §6.1 |
| §3.2 模块清单（9 项） | **PASS** | §6.1 + §6.1.1（调用链/数据/迁移风险）；并发/失败路径在 §6.1 表 |
| §3.3 业务功能清单 | **PASS** | §6.1.2 十条不可破坏行为 |
| §4 选型 A/B/C/D | **PASS** | §6.2 + `open-source-replacement-matrix.md` |
| §5.1 数据库资产清单 | **PASS** | §4.1（19 表/20 索引/0 FK/数据分级/非 DB 资产） |
| §5.2 统一迁移机制 | **PASS** | `user_version` + 11 个独立 `Migration` 条目；边界见 §4 |
| §5.3 迁移前保护 | **PASS** | `VACUUM INTO` 备份 + 只读校验 + 失败中止；B1/B6/B9 |
| §5.4 迁移验证 | **PASS（合成 + 真实数据）** | v0–v11 重放、逐字 v10 DDL、真实数据（93 消息/340 行）置 v10 重放 exit 0 且逐表逐项相等；真 v10 现场库本机不存在 ⇒ **BLOCKED**（需用户供文件）。2026-10-19 深夜这条已**搜尽本机**（4 份库全 v11、目录内无归档、`tmutil listlocalsnapshots` 为空、四个用户目录 maxdepth 6 扫到 30 个库文件全是别的应用）⇒ 是"不可达"而不是"没找"，读数见 §6.8 |
| §5.5 回滚/未来兼容 | **PASS** | 降级拒绝、备份恢复、未知版本写入前拒绝 |
| §6 网络/文件/可靠语义 | **PASS** | 协议未变；队列有界；24 轮 E2E/647 + 互操作 216 |
| §7 系统集成/插件 | **PASS（代码/构建）** | 官方插件优先、平台 cfg 收口；运行时见下 |
| §8 加密/敏感数据 | **PASS（审计）** | 算法/格式未换；私钥边界判据；日志/DB 权限 0600/0700 |
| §9 可观测性 | **PASS（有明确边界）** | 5.0.36 再补四格（见 §6.11）：落盘失败可见（计数 + 一行降级说明 + 盘满退避 256 行）、上次退出四态判定并且**判定行写进日志文件**、每条 run 有 `run_id`、`await_tasks` 不再丢 `JoinError`；诊断包导出命令面**本轮未交付**（判据不许留无人接线的 API，见 §6.11.1）。B13 锁观测进日志（60s 摘要）+ B15 三处收尾事务耗时出口（慢或失败各一行，`transfer_id` 关联）+ §6.10 覆盖表；仍欠：跨进程统一 trace（只有 `msg_id`/`transfer_id`/`cid` 人工串）、`busy_timeout` 专门一行、快且成功的事务不产行（设计取舍，见 §6.10） |
| §10 IPC/事件/调用链 | **PASS** | 边界与事件判据；未改前端契约 |
| §11 架构重组 | **PASS** | 模块职责/依赖方向；未为行数继续切分 |
| §12.1 代码质量 | **PASS**（全量护栏已在 CI 跑完 **233/233**；首跑暴露的 3 条标记**全部定名并 RCA**：1 条用例锚点唯一性、1 条 CI 浅克隆 `fetch-depth`、1 条 `GUARD_ENV_SKIP` 被 cargo 吞掉的误判） | fmt/clippy/Rust 993+1（基线 994）/audit/Android/Windows 交叉编译；定点护栏 3/3 改坏即 FAIL；B15 接线判据单点变异 exit 101→0。**本轮把「护栏非空转（全量）」接进 `verify.yml` 的 `guards` job 并跑完两端**：远端 4/5 job success（前端护栏子集本轮不再红：上一轮的「操作面板」红已由并行会话的 `3de6dd9` 消掉）、`guards` 退码 1 覆盖 231/233；本地独占 target 整跑 233/233，**232 条通过、1 条锚点失效已点名**（`解除好友关系必须同时解除内存身份绑定`：commands 拆册后锚点在 `commands/friends.rs` 出现 2 次；起跑核对只查存在性 ⇒ 那句"恰好命中一次"是过度声明）。修法见 §6.7 末，交护栏负责人，本轮不改其语义 |
| §12.2 数据完整性 | **PASS** | 迁移 38+1、实体逐字段、备份恢复、v10 真实数据 |
| §12.3 网络与可靠性 | **PASS** | 24 轮 E2E（含 kill/freeze/readonly/rotted/shrink/断链补拉） |
| §12.4 大文件/UI 响应 | **PASS** | 600MB 传输中设置窗 397ms（5.0.32）；RSS 126.1 MiB；队列 8 MiB/链路 |
| §12.5 跨平台 | **PARTIAL（比上一轮多一格真证据）** | macOS PASS；**Windows 真 runner 上 Rust 单测 success**（含 B15 两条无门控判据）+ 交叉编译产物 PASS，GUI 运行时 NOT RUN；Android 仅编译 PASS（ubuntu runner 真跑 cargo）；iOS 无 SDK ⇒ DEFERRED；桌面 Linux 运行时 NOT RUN |
| §13 自主执行工作流 | **PASS** | 分批提交、失败先 RCA、未绕过门禁 |
| §14 Git/工作区保护 | **PASS（有一笔需要交代的越界）** | 未覆盖并行改动内容、未 tag/release/merge、未推 main；本轮按授权把 `feat/5.0` 推上远端（连带公开并行会话那笔 `3de6dd9`）。两处如实入账：① 为让判据 4 落地（声明 patch 必须四个版本清单文件同批），我用 temp-index plumbing 把**自己**刚造的两笔未推提交重建成 `d42003f` 一笔，`3de6dd9` 及其以下一字未动；② 刷新索引时用了能捞到 `docs/` 的宽 scope，把 `docs/ARCHITECTURE-MAP.html` 的**已 stage 状态**重置成 HEAD（文件内容未被改写，需前端会话重新 `git add` 那一个文件） |
| §15 九节最终报告 | **PASS** | §6.1–§6.10 + 本表 |

**结论**：除「真实历史 v10 现场库（BLOCKED，本机没有该版本文件）」「Windows/Linux/iOS 运行时与
真机（DEFERRED / NOT RUN）」「全量护栏首跑暴露的 **1 条锚点失效用例（已点名）+ CI 侧 2 条待复现标记**」三格之外，其余可执行项均已落地并有当场读数。事务级耗时 trace 已由 B15 落地
（不是"仍未做"）。不宣称全面完成。
