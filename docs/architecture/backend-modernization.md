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
| `verify.yml` | push 任意分支 / PR / dispatch /（本轮新加）schedule | macos-latest、macos+windows 矩阵、ubuntu-latest、macos-latest(`guards`) | 前端组、Rust fmt/clippy/单测/清单（**macOS 与 Windows 两条腿真跑测试**）、Android 编译、**全量护栏非空转** |
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
| 全量护栏 CI job（`verify.yml` 的 `guards`） | **已配置，远端结果待读** | 命令是 `python3 scripts/verify-guards.py`（不带 `--only`，Ruby psych 解析确认 `has_only_flag=false`、无 `continue-on-error`）；push/PR/dispatch/schedule 四个触发器都在；定时那条约等于该定义进 main 才持续生效 |
| 护栏定点（文件气泡不整文件扫描 / outbox 终态门控 / transport 锁抗中毒） | 0 | **3/3 改坏即 FAIL、恢复即 PASS**（干净 worktree 5.0.32） |
| 迁移测试 | 0 | **38 通过 + 1 ignored** |
| `GOSSLAN_DRILL_DB=<4.44.4 真实库快照> cargo test --lib --features bluetooth real_data_copy_replays_migration -- --ignored --nocapture` | 0 | **1 通过**；`drill ok: tables=19 total_rows=340`（第一次未置 v10 时该测试按设计 **exit 101** 拒跑，前置门有效） |
| E2E（32 轮，隔离 HOME） | 0 | **863/863 断言** |
| B15 之后重跑的相关三轮（本机 release 二进制 + 隔离 HOME，5.0.35） | 0 | 默认轮 **18/18** + 群文件轮 **28/28** + 内容拉取轮 **36/36** = **82 条断言全绿**；群文件轮首跑红的 1 条是驱动缺 `RUSTUP_TOOLCHAIN` 的环境噪声（详见 §6.5） |
| `cargo audit --file src-tauri/Cargo.lock` | 0 | **0 漏洞，10 allowed warnings** |
| GitHub Actions run **39215124440** @ `d42003f`（push `feat/5.0`，本轮） | 4/5 job **success**，**`guards` job 退码 1** | `前端测试 / 清单 / 构建` **success**（07:18:27→07:38:24）⇒ 上一轮那条「操作面板」护栏红在本次不再出现，由并行前端会话的 `3de6dd9` 带过来；`Rust 单测 / 清单（macos-latest）` **success**（→07:22:44）；`Rust 单测 / 清单（windows-latest）` **success**（→07:23:19）⇒ **B15 两条无平台门控的判据在真 Windows runner 上跑过**；`Android 编译门禁` **success**（→07:20:01，ubuntu runner 真跑 cargo）；**`护栏非空转（全量，不带 --only）` 退码 1**（job 117937069342，07:18 起，约 85 分钟）⇒ 这是这 233 条扫描**历史上第一次被自动执行**。匿名可读的 check 注解逐字给出 `❌ 3 条不符合预期`：①「改坏之后测试**仍然通过** ⇒ 这条护栏是空转的（没在守东西）」②「验证过程出错：注入锚点在 friends.rs 里出现 2 次（要求恰好 1 次）」③「恢复源码之后测试**仍然失败** ⇒ 源码或环境已被破坏：`signal: null`」；且它跑到 `[231/233]` 才收 ⇒ 覆盖面是真的、`continue-on-error` 确实没设、红也确实报出来了。**哪三条定不了名**：job 日志页与 `/logs` 匿名 403（要登录/管理员），注解只留关键行 ⇒ 靠下一次跑或本地复现定位 |
| 本地全量护栏**整跑**（独占 target，2026-10-19 10:03Z 收） | 退码 1，**233/233 全部执行** | 同一份码在 `/tmp/gosslan-b15-verify`（HEAD `4a722b7`）以独占 `CARGO_TARGET_DIR` 从第 1 条跑到第 233 条：**232 条判过「改坏即 FAIL、恢复即 PASS」，恰好 1 条异常** —— `[114/233] 解除好友关系必须同时解除内存身份绑定（否则重装后只能重启）`，报「注入锚点在 friends.rs 里出现 2 次（要求恰好 1 次）」。**根因两条都在量具侧，不在产品侧**：① 这条 Case 声明的 `file=src/commands.rs` 是 `include!` 壳（壳里 0 次命中），解析后进 `commands/friends.rs` 分册，而那行 `forget_peer_identity(s, &peer_id)` 在分册里有两处（`remove_friend` 那一处正是用例要钉的；另一处是换钥同步路径，已被 `[63/233]` 用带注释的唯一锚点钉住）⇒ commands 拆册之后锚点失去唯一性；② **起跑前核对只查存在性**（`_resolve_anchor_file` 不做唯一化断言），唯一性只在真注入那一步才 assert ⇒ 起跑打印那句「233 条锚点都恰好命中一次」是**过度声明**，于是这条要白等约 75 分钟才暴露。修法（交护栏负责人，本轮不动它的语义）：把锚点扩成 118-121 行那段带「// ⚠️ 同时解除内存里的身份绑定」注释的整块，或给两条解除路径各起一条用例；并把起跑核对改成与注入同一个唯一性口径。 |
| `version:check` / Change Budget / CHANGELOG / 文档硬数字 | 0 | 全部通过 |

### 6.8 剩余风险

- **高**：用户手上的真 v10 现场库 **BLOCKED**（本机四份库全为 v11、4.44.4 自身带 v11 schema，
  不存在未迁移文件；已用"真实数据 + 置回 v10"和"真实数据 + 逐字 v10 DDL"两条副本演练覆盖）。
  Windows/iOS/Linux 运行时与真机未验证 —— 2026-10-19 用户口径：**其他设备无法交叉编译 PASS
  的先不管**，故 iOS（本机无 SDK，交叉编译也过不去）与 Linux/Windows 运行时本轮
  **DEFERRED**，不再继续装工具链；交叉编译 PASS ≠ 运行时 PASS 的边界保持不变。
- **中**：B15 已落地（3 处收尾事务都有耗时出口，两条判据 + 一次单点变异自证）。仍欠两格：
  `busy_timeout` 触发没有专门一行（只能从等待时长与失败串间接看）；快且成功的事务不产行
  （设计取舍，理由见 §6.10：正常路径"不留痕"那条不变量在测试里钉着，摘要侧已有最长持有/累计）。
  **全量护栏已接进 CI 且两端都跑完**：远端 `guards` job（run 39215124440）退码 1、覆盖到 `[231/233]`，注解报 3 条标记；本地独占 target 整跑 233/233 只有 **1 条**异常且已点名牌名（`解除好友关系必须同时解除内存身份绑定`，锚点在 `commands/friends.rs` 里出现 2 次，根因与修法见 §6.7 末）。**CI 另外两条（一条判「空转」、一条判「恢复后仍失败 `signal: null`」）在本地不复现** ⇒ 标 **待复现**：下一次 push 让 CI 再跑一遍，用来判它是稳定缺陷还是 runner 抖动（那次跑带着 macOS runner 容量告警注解）。本轮不改护栏本身：不放宽判据、不动阈值、不给 job 加 `continue-on-error`。定时那一条要等这份定义进默认分支（main）才会按夜持续跑。
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
  未发 release**。全量护栏 CI job 的首跑结果在读到之前一律标 in_progress，不写成通过；
  目标不标记完成。

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
  （`src/network/transport/group_file.rs` 群文件收尾、`src/network/file/receive.rs` 单聊收尾、
  `src/network/file/ledger_backfill.rs` 群台账补账 —— 后者计时含取锁等待，因为它包住
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
| §5.4 迁移验证 | **PASS（合成 + 真实数据）** | v0–v11 重放、逐字 v10 DDL、真实数据（93 消息/340 行）置 v10 重放 exit 0 且逐表逐项相等；真 v10 现场库本机不存在 ⇒ **BLOCKED**（需用户供文件） |
| §5.5 回滚/未来兼容 | **PASS** | 降级拒绝、备份恢复、未知版本写入前拒绝 |
| §6 网络/文件/可靠语义 | **PASS** | 协议未变；队列有界；24 轮 E2E/647 + 互操作 216 |
| §7 系统集成/插件 | **PASS（代码/构建）** | 官方插件优先、平台 cfg 收口；运行时见下 |
| §8 加密/敏感数据 | **PASS（审计）** | 算法/格式未换；私钥边界判据；日志/DB 权限 0600/0700 |
| §9 可观测性 | **PASS（有明确边界）** | B13 锁观测进日志（60s 摘要）+ B15 三处收尾事务耗时出口（慢或失败各一行，`transfer_id` 关联）+ §6.10 覆盖表；仍欠：跨进程统一 trace（只有 `msg_id`/`transfer_id`/`cid` 人工串）、`busy_timeout` 专门一行、快且成功的事务不产行（设计取舍，见 §6.10） |
| §10 IPC/事件/调用链 | **PASS** | 边界与事件判据；未改前端契约 |
| §11 架构重组 | **PASS** | 模块职责/依赖方向；未为行数继续切分 |
| §12.1 代码质量 | **PASS**（护栏全量首跑已执行，暴露 1 条量具缺陷 + 2 条待复现） | fmt/clippy/Rust 993+1（基线 994）/audit/Android/Windows 交叉编译；定点护栏 3/3 改坏即 FAIL；B15 接线判据单点变异 exit 101→0。**本轮把「护栏非空转（全量）」接进 `verify.yml` 的 `guards` job 并跑完两端**：远端 4/5 job success（前端护栏子集本轮不再红：上一轮的「操作面板」红已由并行会话的 `3de6dd9` 消掉）、`guards` 退码 1 覆盖 231/233；本地独占 target 整跑 233/233，**232 条通过、1 条锚点失效已点名**（`解除好友关系必须同时解除内存身份绑定`：commands 拆册后锚点在 `commands/friends.rs` 出现 2 次；起跑核对只查存在性 ⇒ 那句"恰好命中一次"是过度声明）。修法见 §6.7 末，交护栏负责人，本轮不改其语义 |
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
