# Gosslan 后端基础设施现代化（5.0）——基线与迁移方案

> 分支 `feat/5.0` · 版本 5.0.30 · Rust 1.98.1 · 目标平台 macOS/Windows/Linux/Android/iOS
> 真实库（只读核对）：`~/Library/Application Support/com.gosslan.app/gosslan.db`，
> `user_version=11`、19 张业务表、`journal_mode=wal`、`PRAGMA integrity_check=ok`。
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
- **真实 v10 原始 DDL 判据（5.0.28）**：`src-tauri/src/db/fixtures/v10_schema.sql` 逐字取自
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
- `--round=contentpull`：40MB + 12 份 **32/32 PASS**；`E2E_PULL_BIG_MB=300` 复跑
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
  `multi-file` **24/24**、`gossip3` **25/25**、`sender-kill-mid` **26/26**（修复 outbox 后）、
  `recv-readonly` **24/24**、`group` **37/37**（`GOSSLAN_AX=1` 真界面读到 `[有人@我]`/6 未读）、
  `gfile` **28/28**（群文件逐字节一致）、`ghsync` **32/32**（新成员历史/群任务同步、
  时间/seq 保真、路径剥离、未读 0、标记 done）、`recv-dir-rotted` **24/24**
  （只有最后 rename 失败：发送侧明确 failed、不删队列行冒充成功、接收侧不假 done）、
  `src-shrunk` **24/24**（入队后源文件变小：按截断后的磁盘真值收发，内容/sha/终态一致）。
- 网络/业务扩展：`lanoff` **26/26**（LAN 关闭后走 Routed）、`posttext` **39/39**
  （重启后文本投递）、`task` **49/49**（群任务同步）、`dmreaction` **24/24**
  （1:1 表情回应）。
- 续传/崩溃扩展：`poison-part` **22/22**（脏 .part 前缀自愈或明确失败）、
  `resume-prefix` **23/23**（真实前缀复用）、`groupcrash` **26/26**（建群中崩溃）、
  `gossip-late` **23/23**（晚加入群的 gossip 收敛）、`stall-mid` **25/25**（中途停滞）、
  `disk` **18/18**（磁盘/队列）。
  标准轮合计 **24 轮 / 650 断言**；加互操作 **8 轮/216**，共 **32 轮 / 866 断言全绿**。
- **依赖安全审计**：`cargo audit --file src-tauri/Cargo.lock` **exit 0、0 个漏洞**；
  10 条 allowed warnings（unmaintained/unsound，均为传递依赖）：`proc-macro-error`、
  `unic-*`（6 个未维护）、`zbus_names`/`zvariant`/`zvariant_derive`（Linux D-Bus，未维护）、
  `glib 0.18.5` unsound（Linux GTK 路径，RUSTSEC-2024-0429）。Linux 运行时未验证；
  这些属于 Tauri/GTK 依赖链，未在本轮强升。
- **旧/新二进制互操作**（4.x tag `v4.44.4` release ↔ 5.0.29，同一 harness 用包装脚本按实例
  分派二进制，A/B 两个方向都跑）：
  - default（文本 + 文件 + 重启 + Routed）**18/18 ×2**
  - group（群消息/@名单/撤回/GroupAck）**37/37 ×2**
  - gfile（群文件逐字节/元数据）**28/28 ×2**
  - gossip3（A→B→C 三节点传播）**25/25 ×2**
  合计 **8 轮 / 216 断言全绿**。4.x release 构建 2m44s/3m01s；两侧 `DB_VERSION=11`。
  未覆盖：真机、4.x 用户库实迁移、其余 E2E 轮次。
- 已知展示差异（`src-shrunk` 实测）：A 的入队台账/气泡仍记 1048576，B 台账/盘上为 4096；
  字节内容、sha、两侧终态都正确。它是 UI 尺寸字段的展示口径，不影响数据完整性，未在本轮改。

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

### B11（已落地，5.0.30）：应用数据目录权限 `0700`
- 真实安装的 app data 目录是 `0755`：文件虽已 `0600`，同机其他用户仍可列出备份名、
  日志名与实例库名。`AppState::init()` 在解析目录后调用
  `private_fs::restrict_dir_to_owner` 收紧到 `0700`（Unix；非 Unix 无操作，
  失败只告警不阻断启动）。
- **实测（2026-10-19，5.0.30）**：临时目录 `0755 → 0700`；Rust **986 通过 + 1 ignored**；
  基线 986 → 987。只改启动期目录权限，未改文件内容/DB/协议。

## 4. 4.x → 5.0 数据迁移与恢复

- 现有迁移链已是 `user_version` 单调版本 + 每步事务 + 降级拒绝；本批补的是**迁移前快照**。
- 备份是完整的 SQLite 单文件（`VACUUM INTO` 读取 WAL 中的已提交数据），不复制正在使用的
  主文件 + `-wal/-shm` 组合。
- 恢复演练（后续批次）：用备份替换主库 → `integrity_check` → 启动到旧版本或当前版本；
  记录原版本、备份路径、校验结果。
- 未知未来版本：`current > DB_VERSION` 在**任何写入前**拒绝，已有测试 `downgrade_refusal_writes_nothing`。
- 迁移失败：每步 `unchecked_transaction` 回滚，`user_version` 不前进；备份保留。

## 5. 边界

- 不改消息编码、消息 ID、签名输入、加密格式、确认语义与 SQLite 字段含义。
- 不重构前端；若 IPC 契约必须变化，先列影响面并提供后端兼容层。
- 不 push/tag/release/merge main；每批独立提交、独立门禁。
- E2E、Windows/iOS/Android 真机为 **NOT RUN**，不得用桌面编译代替。
