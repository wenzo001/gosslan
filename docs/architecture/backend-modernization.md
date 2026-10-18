# Gosslan 后端基础设施现代化（5.0）——基线与迁移方案

> 分支 `feat/5.0` · 版本 5.0.23 · Rust 1.98.1 · 目标平台 macOS/Windows/Linux/Android/iOS
> 真实库（只读核对）：`~/Library/Application Support/com.gosslan.app/gosslan.db`，
> `user_version=11`、19 张业务表、`journal_mode=wal`、`PRAGMA integrity_check=ok`。
> 本文是阶段 B 的选型/迁移方案；每批实施后回填读数，不把"计划"当"完成"。

## 1. 现状基线（只读审计）

| 领域 | 现状 | 已有成熟能力 | 主要缺口 |
|---|---|---|---|
| 数据库 | `rusqlite 0.31`（bundled），单一 `DbLock<Connection>`；`PRAGMA user_version` + `MIGRATIONS` 11 步 | 迁移链、每步事务、降级拒绝、失败回滚、重复启动、热查询索引、孤儿清理均有测试 | **无 `busy_timeout`**；**迁移前无备份/校验**；错误仍以字符串为主 |
| 并发/阻塞 | Tokio；慢活（哈希/落盘/重组）已用 `spawn_blocking` 并有源码判据 | `db_hold` 持锁观测、`check-lock-scope`、`lib_relay_data_tests` 慢活清单 | DB 长事务/备份/恢复仍会占住唯一连接；需逐路径量化 |
| 网络 | 自研 `network/transport`（1465 行）、discovery、mesh、gossip、relay、BLE | Tokio、socket2、现有协议与去重/可靠投递不变量 | 未用 `tokio-util`/`bytes`；帧解析/缓冲/关闭仍自研（B 类，需原型） |
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

### B3–B5（未开工）
- B3 网络帧与缓冲（`tokio-util`/`bytes` 原型）——未开工；必须做字节级协议对照与断连/半包测试，
  且当前无 E2E 授权，不整体替换。
- B4 `tracing`/span 关联 id——未开工；保留现有 logger，先评估。
- B5 系统插件/跨平台逐项核对——未开工；notification/dialog/fs/opener/window-state/single-instance
  已在用；移动端真机为 **NOT RUN**。

### B2：错误类型化（分批）
- 在 DB/迁移、文件保存、网络入口定义 `thiserror` 枚举；IPC 边界仍转成可读字符串，保持前端契约。

### B3：网络帧与缓冲（B 类原型）
- 用 `tokio-util::codec` + `bytes` 做一个**隔离原型**，逐字节比对现有帧；只有在断连/半包/大帧/
  背压测试全部等价后才替换。不改变协议字节与消息 ID/加密语义。

### B4：日志/追踪评估
- 先为消息发送、文件分块、DB 事务、连接建立补稳定关联 id；评估 `tracing` 的收益与替换成本，
  不整体替换现有 logger。

### B5：系统集成与跨平台
- 逐项核对官方插件支持矩阵；Windows 文件剪贴板/Android JNI/iOS 沙盒保留薄适配；
  所有移动端未跑项标 NOT RUN。

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
