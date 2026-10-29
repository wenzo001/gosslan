# Gosslan — ORIENTATION (审计上下文构建 · ORIENT 阶段)

> 审计对象：`/Users/wendongfu/Documents/code/gosslan`
> 代码基线：`0bc31fc0`（tag `v5.15.1`）
> 本文件只做**上下文地图**：模块 / 入口点 / 参与者 / 状态 / 值得深挖的函数。
> **不列漏洞、不提修复建议。** 所有 `file:line` 均已逐个核对。

---

## 0. 全局速览

| 维度 | 事实 |
|---|---|
| 形态 | Tauri 2 桌面 + 移动端 P2P 消息应用。Vue 3 + TS 前端，Rust 后端，SQLite 落库 |
| 传输 | LAN（UDP 发现 + TCP 数据面）、BLE（GATT 分片）、公网中继（客户端侧记录层封装） |
| 加密 | 自研栈：X25519 + Ed25519 + ChaCha20-Poly1305，**零 TLS**（`crypto.rs`） |
| 前后端边界 | Tauri IPC（`generate_handler!` 注册 **161 个命令**，`src-tauri/src/lib.rs:741-903`） |
| 规模 | Rust ~106.5k 行（含测试）；前端 ~54.7k 行（260 个非测试文件） |
| 特殊之处 | 大量「同一语义只在纯函数里有一份真源」的设计；`include!` 拆文件（`db.rs:1366+`、`network/transport.rs`）导致**模块路径 ≠ 文件路径** |

### 0.1 关键结构约定（读代码前必须知道）

1. **`include!` 而非 `mod`**：`src-tauri/src/db.rs` 把 17 个 `db/*.rs` 文件 `include!` 进同一个模块
   （`db.rs:1366-1398`）；`network/transport.rs` 同样 `include!` 了 `transport/e2ee_payload.rs`（`:1278`）。
   ⇒ **函数在哪个文件 ≠ 它属于哪个模块**，`use` 路径会骗人。
2. **`network/transport/` 是目录化子模块**，但父文件 `network/transport.rs` **仍存在且同名**
   （Rust 允许 `transport.rs` + `transport/` 共存，父模块取 `.rs`）。
3. **注释里的 `file:line` 会腐烂**。仓库自己承认这点（`transport/tcp.rs:17-24` 明写"行号会腐烂，
   以符号名为准"）。本次审计的所有行号均为**现读现核**。
4. **测试模块用 `include!` 内联**：`lib.rs:951` `include!("lib_tests.rs")` 等。
   排名时已忽略 `*_tests.rs` 与 `#[cfg(test)] mod tests`。

---

## 1. Modules（子系统地图）

### 1.1 前端 `src/`

| 模块 | 路径 | 作用（一句话） |
|---|---|---|
| **IPC 桥** | `src/api/index.ts`（1044 行） | 全部 `invoke` 的唯一出口；含慢调用追踪（`ipcTracker`）与入参 schema 校验（`utils/validation.ts`） |
| **Stores** | `src/stores/useChatStore.ts`（3471）、`useAppStore.ts`（1147）、`useImagePreview.ts` | Pinia 状态：会话/消息、运行时快照、相册 |
| **Composables** | `src/composables/`（14 个） | 跨组件复用逻辑（成员档案、消息展示、窗口启动、输入法守卫…） |
| **Components** | `src/components/`（~100 个） | 聊天窗口、消息气泡、群任务板、设置面板、日志查看器、收件箱 |
| **Utils** | `src/utils/`（~90 个） | 纯逻辑工具：校验、路径、缩略图、任务中心、todo 模型、样式守卫（`designGuards.ts` 2399 行） |
| **Workers** | `src/workers/highlight.worker.ts` | 代码高亮 Web Worker（唯一 worker） |
| **Router** | `src/router/main.ts`、`mainRoutes.ts`、`settings.ts` | 前端路由（窗口内） |
| **i18n** | `src/i18n/index.ts`、`locales/{zh-cn,en-us}.ts` | 编译式 i18n（`compile.test.ts`） |
| **Updater** | `src/updater/{service,tauriAdapter,instance,schedule}.ts` | 更新状态机（**纯逻辑，不 import Tauri**）+ 适配器 + 单例 + 定时调度 |
| **Boot** | `src/boot/boot.ts`、`boot-guard.js`、`theme-boot.js` | 多窗口共用首屏：样式注入、异常上报、骨架撤除、标题 |
| **Entries** | `src/entries/{main,logs,preview}.ts` | 每窗口一个入口（`App.vue` 按 window label 渲染） |
| **Layouts** | `src/layouts/ResponsiveLayout.ts`（1198） | 响应式三栏布局 |
| **Data** | `src/data/emojis.ts`（1074）、`hanInitials.ts` | 静态数据 |

### 1.2 后端 `src-tauri/src/`

| 模块 | 路径 | 作用 |
|---|---|---|
| **入口/引导** | `lib.rs`（951）、`main.rs`、`restart.rs`、`watchdog.rs`、`worker_supervisor.rs` | Tauri builder、窗口标签常量、panic hook、`generate_handler!` |
| **命令层** | `commands.rs` + `commands/*.rs`（18 个文件） | 全部 `#[tauri::command]`；`commands.rs` 同样用 `include!` 聚合 |
| **协议** | `protocol.rs`（2478） | `Message` 枚举（`#[serde(tag="type")]`）、`GossipEnvelope`、kind 分类、载荷解析器（recall/todo/remind/merge/reaction…） |
| **密码学** | `crypto.rs` | X25519/Ed25519/ChaCha20-Poly1305 封装；安全码（safety number） |
| **DB** | `db.rs`（1407）+ `db/*.rs`（17 个） | Schema 唯一真源 `SCHEMA`（`db.rs:741`）、迁移、26 张表 |
| **状态** | `state.rs`（3175） | `AppState`（`:1060`）全部内存态：peer/links/keys/outbox/文件接收器 |
| **网络（编排）** | `network/mod.rs` | `start`/`stop`/`start_from_prefs`，组装 transport + discovery + ble |
| **网络（传输）** | `network/transport.rs`（1523）+ `network/transport/*.rs`（24 个） | TCP 接入、握手、消息分发、优先级队列、outbox、群文件、gossip、路由、选路 |
| **网络（BLE）** | `network/ble.rs`（765）+ `network/ble/{central,peripheral,io_loops,frame_io}.rs` | BLE 主机/外设双角色、GATT 读写循环 |
| **网络（发现）** | `network/discovery.rs`（1493） | UDP 广播 announce/who_has、网卡选择、收包循环 |
| **网络（文件）** | `network/file.rs` + `network/file/*.rs`（receive/send/group_receive/group_resume/share_walk/ledger_backfill/relay_push） | 文件分片收发、续传、群文件、共享目录 |
| **网络（群历史）** | `network/group_history.rs`（2209） | 群历史同步引擎：选源、密封分页、取消 |
| **分发** | `network/dispatch.rs` | `message_priority`：High/Normal/Low 单一分类真源 |
| **传输原语** | `transport/tcp.rs`（643）、`transport/ble_framing.rs`（571）、`transport/relay_seal.rs`（916）、`transport/bluetooth*.rs` | 字节分帧、BLE 分片重组、中继记录层、平台 BLE 驱动 |
| **发现（路由端点）** | `discovery/mod.rs`、`discovery/routed.rs` | 手动配置的 routed endpoint（Tailscale 等） |
| **Mesh** | `mesh/`（9 个文件：`router.rs` 620、`manager.rs`、`peer.rs`、`relay_policy.rs` 497、`gossip_replay.rs`、`path.rs`、`endpoint.rs`、`candidate.rs`、`connection.rs`） | Mesh 层 Peer/Connection 模型、TTL/去重路由、转发授权策略 |
| **内容传输** | `content/{mod,model,policy,store}.rs` | ADR-0019 内容寻址生命周期：`content_transfers` 表 + 状态机 + 重试策略 |
| **中继文件** | `file_relay.rs`（508） | 中继侧 `.part` 流式重组 |
| **存储** | `storage/{mod,cache_cleaner,disk_space,vacuum}.rs` | 缓存清理、配额、VACUUM |
| **日志** | `logging.rs`（2773） | 内存 ring + 落盘、panic/退出路标、崩溃现场 |
| **其它** | `device.rs`、`nickname.rs`、`user_dirs.rs`、`macos_bookmark.rs`、`private_fs.rs`、`open_path.rs`、`android_open.rs`、`notifications.rs`、`diagnostics.rs`、`mem_diag.rs`、`export/` | 设备 ID 派生、用户目录+沙盒书签、文件权限收紧、平台打开文件、诊断包 |

### 1.3 `scripts/`（护栏与验证）

| 类别 | 代表文件 | 作用 |
|---|---|---|
| 统一入口 | `verify.mjs`（`npm run verify`） | 串起前端测试 / Rust 测试 / 护栏扫描 / 构建 / Android 编译门禁 |
| 结构护栏 | `check-domain-map.mjs`、`check-import-cycles.mjs`、`check-domain-deps.mjs`、`check-lock-scope.mjs`、`check-key-boundary.mjs`、`check-ble-constants.mjs` | 领域图、导入环、锁序、密钥边界、BLE 常量一致性 |
| 不变量护栏 | `check-invariant-hooks.mjs`、`check-invariant-exceptions.mjs` | 校验 `docs/protocol-invariants.md` 的 INV 都有测试钩子 |
| 其它 | `check-panic-sites.mjs`、`check-change-budget.mjs`、`check-test-manifest.mjs`、`check-doc-citations.mjs`、`verify-guards.py`、`guard_cases/*.py` | panic 点台账、改动预算、测试清单、文档引用、护栏非空转验证 |
| E2E | `e2e-multi-instance.mjs`、`e2e-dev.sh`、`scripts/e2e/` | 多实例/多设备场景 |

### 1.4 `docs/`

| 路径 | 作用 |
|---|---|
| `docs/protocol-invariants.md` | **系统不变量总纲**（INV-P01…）：身份、幂等、ACK、outbox、gossip、E2EE、持久化 |
| `docs/adr/0007…0023`（17 篇） | 架构决策：协议版本化、状态机边界、Rust/TS 契约、gossip 信封认证、传输优先级队列、多路径选路、BLE 传输、中继授权、不透明外部帧、窗口架构、内容传输、盲电路中继、设备 ID 生成、群主撤回 |
| `docs/architecture/ARCHITECTURE-MAP.html` | 交互式架构图 |
| `docs/architecture/{backend-modernization,frontend-inventory,refactor-5.0-report,rc-5.0-report,routing-and-navigation,frontend-performance-antipatterns}.md` | 现状盘点与重构报告 |
| `docs/AI_ENGINEERING_INDEX.md`、`docs/large-file-split-plan.md`、`docs/migration-ledger.md`、`docs/version-ledger.md` | 工程索引、拆分计划、迁移台账 |
| 根级 `AI_RULES.md`（38KB）、`AGENTS.md`、`AI_PROJECT_HANDOFF.md`、`CONTEXT.md` | AI 协作规则与交接文档（**规则文件本身也是审计对象**） |

---

## 2. Entrypoints（外部可达入口点）

> 参与者类别：
> **(a)** 不可信 LAN 对端（TCP/UDP 线协议）｜**(b)** 不可信 BLE 对端｜**(c)** 中继对端/中继服务器
> **(d)** 本地 UI / Tauri IPC（半信任：前端可发任意 IPC）｜**(e)** 更新通道（远程攻击者）｜**(f)** 本地文件系统

### 2.1 (a) LAN 对端 — TCP 线协议

| 入口 | 位置 | 可达者 | 路径 |
|---|---|---|---|
| **TCP 监听 accept 循环** | `src-tauri/src/network/transport.rs:188`（`spawn`），accept 在 `:231` | (a) | 任意能连到 `0.0.0.0:59992` 的主机 |
| **TCP 分帧读（字节层）** | `src-tauri/src/transport/tcp.rs:84` `read_bytes_capped` | (a) | 长度前缀 → 校验 → 增量分配（`MAX_FRAME`=64MiB / 预认证 `MAX_PREAUTH_FRAME`=64KiB） |
| **TCP 分帧写** | `src-tauri/src/transport/tcp.rs:51` `write_bytes` | — | 4B 大端长度 + payload；空载荷/超长拒收 |
| **业务帧反序列化** | `src-tauri/src/network/transport/outbound.rs:78` `decode_frame`、`:93` `read_frame`、`:103` `read_frame_preauth` | (a) | JSON → `Message`；未知 variant 降级为 `Unknown` |
| **入站连接处理** | `src-tauri/src/network/transport.rs:585` `handle_incoming` | (a) | 首帧必须 Hello → `verify_hello` → 世代校验 → 入站去重 → 登记链路 → 回发 Hello |
| **首帧 Hello 验签** | `src-tauri/src/network/transport/handshake.rs:56` `verify_hello`；纯判定 `:7` `hello_auth_decision` | (a) | friends 表绑定优先 → peers（须 `keys_verified`）→ TOFU；nonce 重放窗口在**验签之后**才消费 |
| **统一消息分发** | `src-tauri/src/network/transport.rs:1085` `handle_message` | (a)(b)(c) | 38 个 `Message` 变体按族分流到 6 个 handler 册 |
| **TCP 读循环** | `src-tauri/src/network/transport/queue_policy.rs:218` `reader_loop` | (a) | 读帧 → `handle_message`（`:251`） |
| **拨号 / 选路** | `src-tauri/src/network/transport/dial.rs:283` `ensure_link`、`:395` `connect_to_peer`、`:178` `should_accept_inbound` | (a) | 在途去重 `state.dialing` + 并发闸 `dial_permits` |
| **peer 注册表** | `src-tauri/src/network/transport/peer_registry.rs:115` `upsert_peer` | (a) | announce 带来的公钥恒 `keys_verified=false` |
| **出站发送** | `src-tauri/src/network/transport/outbound.rs:271` `try_send`、`:39` `write_frame` | — | 按 `dispatch::message_priority` 选 high/normal/low 通道 |

### 2.2 (a) LAN 对端 — UDP 发现/announce

| 入口 | 位置 | 可达者 | 路径 |
|---|---|---|---|
| **UDP 收包处理** | `src-tauri/src/network/discovery.rs:585` `handle_datagram` | (a) | `serde_json::from_slice::<UdpPacket>` → 自签名校验 `verify_announce` → `upsert_peer` → **spawn** `ensure_link`（串行会堵死收包循环） |
| **发现主循环** | `src-tauri/src/network/discovery.rs:398` `spawn` | — | 两个 socket（发送 + 接收）、自适应间隔、失败连拍 |
| **announce 报文构造** | `src-tauri/src/network/discovery.rs:364` `announce_packet` | — | 广播 device_id / nickname / 公钥 / tcp_port |
| **peer 清扫** | `src-tauri/src/network/discovery.rs:869` `sweep_peers` | — | 45s 超时；非好友才忘身份 |
| **协议常量** | `src-tauri/src/protocol.rs:12` `UDP_PORT`=59991、`:14` `TCP_PORT`=59992 | — | |

### 2.3 (b) BLE 对端

| 入口 | 位置 | 可达者 | 路径 |
|---|---|---|---|
| **BLE 分片重组器** | `src-tauri/src/transport/ble_framing.rs:266` `BleReassembler::push` | (b) | 6 字节头（msg_id/index/count）；`count≤8192`、`index<count`、`MAX_INFLIGHT_MESSAGES=8`、`MAX_BLE_MESSAGE_BYTES=512KiB`、30s TTL |
| **BLE 分片** | `src-tauri/src/transport/ble_framing.rs:189` `fragment` | — | 按 MTU 切片 |
| **BLE 读循环** | `src-tauri/src/network/ble/io_loops.rs:175` `ble_reader_loop` | (b) | `serde_json::from_slice::<Message>`（**注意：不走 `decode_frame`，无未知帧降级**）→ `handle_message`（`:225`） |
| **BLE 中央侧（主机）握手** | `src-tauri/src/network/ble/central.rs:632` `handle_message(first)` | (b) | 首帧 Hello |
| **BLE 外设侧握手** | `src-tauri/src/network/ble/peripheral.rs:461` `verify_hello_for_ble`、`:561` `handle_message(first)` | (b) | 首帧必须是 Hello 且验签过 || **BLE 验签入口** | `src-tauri/src/network/transport/dial.rs:104` `verify_hello_for_ble` | (b) | |
| **平台 BLE 驱动** | `transport/bluetooth.rs`、`bluetooth_peripheral.rs`(820)、`bluetooth_peripheral_windows.rs`(723)、`ble_android.rs`(513)、`transport/bluetooth_peripheral.rs` | (b) | GATT 读写、notify 分片 |

### 2.4 (c) 中继对端 / 中继服务器

| 入口 | 位置 | 可达者 | 路径 |
|---|---|---|---|
| **中继电路协商** | `src-tauri/src/network/transport/relay.rs:414` `relay_negotiate` | (c) | `GSRW1 <role> <b64 X25519> <b64 sig>\n` 线上协商 |
| **记录层解封** | `src-tauri/src/transport/relay_seal.rs:271` `accept_wrap_offer`、`:387` `RecordOpen::open_record`、`:555` `OpenPipe::absorb_encrypted` | (c) | AEAD + 递增计数器（重放即断链）；通道哈希按 UTC 天轮换 |
| **记录层封装** | `src-tauri/src/transport/relay_seal.rs:236` `build_wrap_offer`、`:351` `RecordSeal::seal_frame` | — | |
| **中继 rendezvous** | `src-tauri/src/network/transport/relay.rs:186` `relay_rendezvous_task` | (c) | 定期重拨 |
| **中继文件 Offer/Chunk** | `src-tauri/src/network/transport/relay_file.rs:6` `handle_relay_file_offer`、`:153` `handle_relay_chunk`、`:570` `move_received_file` | (c) | 中继只透传密文切片，不持密钥 |
| **中继侧重组** | `src-tauri/src/file_relay.rs:130` `begin_reassemble`、`:184` `add_chunk`、`:252` `sweep_stale_reassemblies` | (c) | 流式写 `.relay.part` |
| **中继配置（IPC）** | `src-tauri/src/commands/relay.rs:320` `save_relay_config`、`:41` `normalize_relay_server`、`:59` `validate_relay_token` | (d) | token 不入日志（有测试钉死） |

### 2.5 (d) 本地 UI / Tauri IPC —— 最需关注的命令

> 全部 **161** 个命令注册于 `src-tauri/src/lib.rs:741-903`。
> 本仓**没有 app ACL manifest**（`src-tauri/permissions/` 不存在）⇒ **自定义命令不受 ACL 校验**
> （`lib.rs:76-82` 自述）。因此任一窗口（含 `WINDOW_LINK` 这个加载远端页面的窗口，
> 见 `lib.rs:99-102`）能调到的命令都是全量面。
> 前端侧唯一收敛点是 `src/api/index.ts` 的 `invoke` 包装 + `src/utils/validation.ts` 的
> zod schema —— 但**这是前端自律，不是后端边界**。

| 命令 | file:line | 触及的不变量 |
|---|---|---|
| `send_message` | `commands/chat.rs:534` | 好友校验、kind 载荷校验、remind/recall/render 目标真实性、E2EE 封装、outbox |
| `send_group_message` | `commands/group_files.rs:23` | 群成员校验、群密钥分发 |
| `send_group_file` | `commands/group_announcements.rs:253` | 群文件密钥生成、扇出投递 |
| `recall_group_message` | `commands/group_announcements.rs:116` | 群主权限判定、撤回窗口 |
| `recall_message` | `commands/chat.rs:326` | 作者判定（`protocol::recall_verdict`） |
| `group_add_member` / `group_remove_member` / `transfer_group_creator` | `commands/groups.rs:268` / `:321` / `:394` | 群主权限、成员表变更 |
| `leave_group` | `commands/groups.rs:445` | 退群后同步标记清理 |
| `distribute_group_key` | `commands/groups.rs:86` | 群密钥信封封装 |
| `respond_friend_request` | `commands/mobile_picker.rs:467` | 好友公钥绑定（TOFU→PIN） |
| `send_friend_request` | `commands/mobile_picker.rs:345` | 定向帧 |
| `sync_friend_keys` | `commands/friends.rs:245` | 密钥轮换同步 |
| `get_safety_number` | `commands/friends.rs:32` | 安全码 |
| `request_content` / `request_content_by_cid` | `commands/files.rs:1307` / `:1385` | 内容寻址拉取（拥有即授权） |
| `send_file_auto` | `commands/files.rs:1541` | 文件发送编排 |
| `delete_file` | `commands/files.rs:93` | **任意路径删除**（IPC 面，需核对路径边界） |
| `open_file_native` | `commands/files.rs:165` | **任意路径交给系统打开** |
| `copy_file` | `commands/helpers.rs:12` | 任意路径复制 |
| `save_data_file` | `commands/helpers.rs:110` | base64 → 任意路径写盘（体积闸 `MAX_OUTGOING_IMAGE_BYTES`） |
| `save_media_as` | `commands/helpers.rs:149` | 媒体另存（源路径经 `resolve_media_path` 校验） |
| `read_file_preview` | `commands/helpers.rs:294` | 路径经 `resolve_media_path`（`:209`）校验 |
| `read_content_preview` | `commands/favorites.rs:331` | |
| `download_shared_file` | `commands/share.rs:180` | 共享目录路径解析 |
| `set_share_dir` / `set_downloads_dir` | `commands/share.rs:6` / `:58` | 目录授权（macOS 书签） |
| `import_external_links_from_url` | `commands/external_links.rs:356` | **远程 URL 抓取**（HTTP 出口） |
| `import_external_links_file` | `commands/external_links.rs:336` | 外部文件导入 |
| `validate_external_url` | `commands/external_links.rs:41` | URL scheme 白名单 |
| `save_settings` | `commands/settings.rs:275` | 写 13 个设置键 + 刷新 relay 缓存 + 广播 |
| `reset_settings` | `commands/settings.rs:382` | 恢复默认（写库） |
| `clear_all_data` | `commands/favorites.rs:526` | **全量删除**（DB + 目录） |
| `export_chat_text` | `commands/favorites.rs:400` | 聊天导出到磁盘 |
| `export_diagnostics_bundle` | `commands/logs.rs:116` | 脱敏诊断包（含日志） |
| `save_todo_image_bytes` | `commands/group_todo_media.rs:114` | base64 写盘 |
| `send_todo_image` | `commands/group_announcements.rs:554` | |
| `add_routed_endpoint` | `commands/routed.rs:59` | 手动路由端点（地址簿写入） |
| `save_relay_config` | `commands/relay.rs:320` | 中继服务器 + token |

### 2.6 (e) 更新通道（远程攻击者）

| 入口 | 位置 | 路径 |
|---|---|---|
| **更新检查** | `src-tauri/src/commands/updater.rs:171` `updater_check`（桌面）；`:582`（移动端桩） | Tauri 官方 updater 插件 → 清单端点；**自加降级闸** `is_not_an_upgrade`（`:163`） |
| **更新下载** | `src-tauri/src/commands/updater.rs:249` `updater_download` | 整包**常驻内存** `Mutex<Option<Vec<u8>>>`；`Channel<DownloadEvent>` 推进度 |
| **更新安装** | `src-tauri/src/commands/updater.rs:405` `updater_install` | 字节移交给安装器；`InstallingPhase` RAII 清道夫（`:384`） |
| **更新取消/关闭/状态** | `:355` / `:539` / `:151` | |
| **前端更新状态机** | `src/updater/service.ts:78` `createUpdaterService` | 纯逻辑：单飞、超时、错误分类（`:64` `errorCode`） |
| **适配器** | `src/updater/tauriAdapter.ts` | |
| **清单生成（发布侧）** | `scripts/updater-manifest.mjs` | 签名清单产出 |

### 2.7 (f) 本地文件系统

| 面 | 位置 | 说明 |
|---|---|---|
| **应用数据目录** | `src-tauri/src/state.rs:1767-1774` | `app_data/{downloads,cache,favorites/media}`，一律 `0700` |
| **权限收紧** | `src-tauri/src/private_fs.rs`（`restrict_to_owner` 0600 / `restrict_dir_to_owner` 0700 / `create_private_dir`） | |
| **日志目录** | `src-tauri/src/logging.rs:220` `log_dir_in` | `app_data/logs/`；崩溃现场、退出路标 |
| **数据库文件** | `src-tauri/src/state.rs:1783` | `app_data/gosslan.db`（+`-wal`/`-shm`）；迁移备份保留 3 份（`db.rs:1018`） |
| **迁移备份** | `src-tauri/src/db.rs:181` `find_recovery_backup` | 含身份私钥与全部消息 |
| **共享目录 / 接收目录** | `src-tauri/src/user_dirs.rs`（`SHARE` / `RECEIVE` 键 + macOS 安全作用域书签） | |
| **沙盒书签** | `src-tauri/src/macos_bookmark.rs` | |
| **平台打开文件** | `src-tauri/src/open_path.rs`、`android_open.rs`（FileProvider `content://`） | |

### 2.8 HTTP / WebSocket 服务器

**全仓不存在**。已核查：`TcpListener::bind` 仅用于 LAN TCP 端口（`network/transport.rs:188`）；
无 `axum` / `hyper` / `actix` / `warp` / `tiny_http` / `WebSocket` 依赖；前端也无 `createServer`。
唯一 HTTP 出口是：① Tauri updater 插件（官方 HTTPS 客户端）；② `import_external_links_from_url`
（`commands/external_links.rs:356`，用户主动触发的 URL 抓取）。

---

## 3. Actors（参与者与信任级）

| # | 参与者 | 信任级 | 能做什么 |
|---|---|---|---|
| A1 | **LAN 上的任意主机**（同网段或能路由到本机的） | **不可信** | 收 UDP announce；发 TCP 连接（首帧 Hello）；发任意 JSON 帧（Hello/ChatMessage/FileOffer/Gossip/GroupKey/ShareTree…）；触发本机向任意 IP 拨号；触发文件写入请求 |
| A2 | **BLE 范围内的任意设备** | **不可信** | 通过 GATT notify 发任意分片序列；构造畸形头（越界 index / 不一致 count / 超限消息）；抢占外设标识 |
| A3 | **中继服务器 / 中继对端** | **不可信**（本仓自行设计为不可信，见 `transport/relay_seal.rs:1-38`） | 看到帧长度/时序/总量；尝试注入帧、重放旧记录、冒充好友、切断链路、转送协商行给第三人 |
| A4 | **本地 Vue 前端（任意窗口的 WebView）** | **半信任** | 调任意已注册命令；参数是它自己给的（前端 zod 校验只是自律）；可读日志、诊断包、设置、聊天导出；可写任意路径（`save_data_file` / `copy_file` / `delete_file`） |
| A4b | **`WINDOW_LINK` 窗口（加载远端页面）** | **不可信**（刻意不给 capability） | 见 `lib.rs:99-102`；`link_window_is_not_capability_covered` 测试锁死 |
| A5 | **更新通道运营方 / 被攻陷的更新端点** | **不可信**（远程攻击者） | 提供清单与更新包；本仓已加**禁止降级**闸（`updater.rs:163`）与签名校验（依赖官方插件） |
| A6 | **本地文件系统持有者**（同机其他用户 / 备份介质） | **不可信**（本仓用 0600/0700 应对） | 若权限收紧失败，可读 `gosslan.db`（含身份私钥与全部消息）、日志、迁移备份、`.part` 临时文件 |
| A7 | **本机用户（操作 UI 的人）** | **信任** | 一切本地操作；是分享目录/下载目录的授权来源（macOS 沙盒下经书签） |
| A8 | **群主 / 好友（同群或已加好友）** | **半信任**（已验签绑定，但**行为仍受限**：中继策略、撤回权限、群成员边界） | 转发群消息、发群文件、改群名、移成员、传群密钥、召回消息 |
| A9 | **陌生人 / 陌生节点** | **不可信** | 只能收到 Presence / FriendRequest / FriendAccept 三类 gossip（`gossip.rs:171` `gossip_trust_for_unpeer_sender`）；不能拉内容、不能读共享目录 |

---

## 4. State（持久状态）

### 4.1 SQLite 表（26 张 + 1 张 content 表）

Schema 唯一真源：`src-tauri/src/db.rs:741` `pub const SCHEMA`。
`content_transfers` 另建于 `src-tauri/src/content/store.rs:14` `ensure_schema`。

| 表 | 定义位置 | 写入函数 |
|---|---|---|
| `settings` | `db.rs:742` | `db/settings.rs:110` `set_setting`；`db/group_delete_boundary.rs:39` `delete_setting` |
| `friends` | `db.rs:747` | `db/friends.rs:5` `add_friend`、`:19` `remove_friend`、`:50` `update_friend_pubkeys`、`:71` `replace_friend_pubkeys` |
| `conversations` | `db.rs:756` | `db/conversations.rs:5` `touch_conversation`、`:44` `ensure_conversation`、`:109` `set_conversation_pinned`、`:117` `mark_read`、`:128` `update_conversation_profile`、`:169` `delete_conversation` |
| `messages` | `db.rs:769` | `db/messages.rs:28` `insert_message_if_new`、`:41` `insert_message`、`:47` `insert_message_and_outbox`、`:696` `set_message_status`、`:713` `finalize_expired_message`、`:751` `cancel_queued_message`、`:794` `requeue_message_for_resend`、`:841` `ack_delivered`、`:868` `apply_message_render`、`:1161` `update_message_content`、`:1188` `fill_message_sha256`、`:1222` `fill_message_size`；`db/message_delete.rs:23` `delete_messages` |
| `conversation_clocks` | `db.rs:800` | `db/clocks.rs:20` `next_clock`、`:41` `observe_clock` |
| `group_recalled_messages`（G-Set，只增不减） | `db.rs:809` | `db/recalls.rs:6` `insert_recall`、`:60` `materialize_recall` |
| `message_render`（LWW） | `db.rs:822` | `db/messages.rs:868` `apply_message_render` |
| `groups` | `db.rs:828` | `db/groups.rs` |
| `group_members` | `db.rs:835` | `db/groups.rs` |
| `group_reads` | `db.rs:842` | `db/read_receipts.rs` |
| `outbox` | `db.rs:850` | `db/messages.rs:47` `insert_message_and_outbox`；`db/offline_queue.rs` |
| `group_outbox` | `db.rs:861` | `db/group_offline_queue.rs:7` `insert_group_outbox`、`:49` `ack_group_delivered`、`:119` `cancel_queued_group_message`、`:197` `mark_group_outbox_failed`、`:236` `resend_cancelled_group_rows`、`:311`/`:333`/`:424` 删除族 |
| `file_transfers` | `db.rs:877` | `db/file_transfer.rs:6` `upsert_transfer` |
| `file_outbox` | `db.rs:903` | `db/file_offline.rs` |
| `group_files` | `db.rs:926` | `db/group_files.rs:100` `insert_group_file`、`:546` `upsert_group_file_receive`、`:414` `mark_group_file_cancelled` |
| `group_file_recipients` | `db.rs:941` | `db/group_files.rs:275` `insert_group_file_recipient`、`:342` `update_group_file_recipient`、`:384` `cancel_group_file_recipients`、`:399` `cancel_group_file_recipient`、`:428` `cancel_group_file_atomically`、`:512` `requeue_stale_group_file_sending` |
| `group_file_acks`（ACK 持久账本，跨进程重放） | `db.rs:962` | `db/group_files.rs:24` `insert_group_file_ack`、`:70` `delete_group_file_ack`、`:83` `bump_group_file_ack_attempt` |
| `pending_reads` | `db.rs:976` | `db/read_receipts.rs` |
| `pending_group_reads` | `db.rs:982` | `db/read_receipts.rs` |
| `favorites` | `db.rs:998` | `db/favorites.rs:32` `insert_favorite`、`:82` `delete_favorite` |
| `content_transfers` | `content/store.rs:16` | `content/store.rs:92` `upsert`、`:254` `touch_received`、`:275` `record_local`、`:307` `record_failure` |

**特别值得注意的两处**：
- **身份私钥存在 `settings` 表**（不是 keyring）：`settings.x25519_secret` / `settings.ed25519_secret`，
  写入在 `state.rs:1729-1731` `persist_identity`（同一事务）。
- **`group_recalled_messages` 是只增不减的 G-Set**，撤回的权威真源；
  `messages` 的 `kind='recalled'` 只是物化视图（`db.rs:805-818`）。

### 4.2 密钥材料（无 keyring / 无 OS keystore）

**全仓没有 `keyring` / `stronghold` / `keystore` / `Keychain` 依赖**（已 grep 确认）。
私钥仅以 base64 明文存在 SQLite `settings` 表里，靠文件权限 0600 + 目录 0700 保护。

| 密钥 | 存放 | 写入者 |
|---|---|---|
| X25519 私钥 | `settings.x25519_secret` | `state.rs:1729` `persist_identity` |
| Ed25519 私钥 | `settings.ed25519_secret` | `state.rs:1731` `persist_identity` |
| 群密钥 | `state.group_keys`（**仅内存**，`state.rs:1239`） | `network/transport.rs:1312` `handle_group_key` |
| 文件会话密钥 | `state.file_receivers[].file_key`、`state.relay_file_keys`、`state.group_file_keys`（**仅内存**） | `network/file/receive.rs:799` `make_receiver`；`network/transport/group_file.rs` |
| 中继记录密钥 | 由 `relay_seal::record_keys`（`transport/relay_seal.rs:312`）从 DH 派生，**仅内存** | `relay_seal.rs:236`/`:271` |
| 好友公钥（信任锚） | `friends.x25519_pubkey` / `friends.ed25519_pubkey` | `db/friends.rs:5`/`:50`/`:71` |

### 4.3 磁盘文件

| 路径 | 内容 | 写入者 |
|---|---|---|
| `app_data/gosslan.db` (+ `-wal`/`-shm`) | 全部业务数据 + 身份私钥 | `db::init`（`db.rs:1215`）+ 全部 db/* 写函数 |
| `app_data/gosslan-N.db` | 多开实例库 | 同上 |
| `app_data/gosslan.db.bak.*`（≤3 份） | 迁移前备份（含私钥 + 全部消息） | `db.rs:1018` `MAX_MIGRATION_BACKUPS` |
| `app_data/downloads/` | 接收的最终文件 | `network/file/receive.rs:1281` `finish_receive` → rename |
| `app_data/downloads/{transfer_id}.part` | 接收中的临时文件 | `network/file/receive.rs:799` `make_receiver`（`File::create`） |
| `app_data/cache/` | 图片/音频/文件缓存 | `storage/cache_cleaner.rs`（清理） |
| `app_data/favorites/media/` | 收藏媒体**独立副本**（清理器不碰） | `commands/favorites.rs:108` `add_favorite` |
| `app_data/logs/` | 运行日志、崩溃现场、退出路标 | `logging.rs:220` `log_dir_in`；`logging.rs:245` `crash_note`、`:795` `write_exit_marker` |
| `app_data/logs/`（诊断包） | 脱敏三件套导出 | `commands/logs.rs:116` `export_diagnostics_bundle` |
| `{downloads_dir}/*.relay.part` | 中继接收临时文件 | `file_relay.rs:130` `begin_reassemble` |
| 用户选定 `share_dir` / `downloads_dir` | 共享目录、用户接收目录（+ macOS 书签） | `commands/share.rs:6`/`:58`；`user_dirs.rs` |
| 聊天导出文件 | 纯文本聊天记录 | `commands/favorites.rs:400` `export_chat_text` |

### 4.4 内存注册表（`AppState`，`state.rs:1060`）

| 注册表 | 字段 | 内容 | 写入者（部分） |
|---|---|---|---|
| peer 表 | `peers` (`:1242`) | device_id → Peer（含公钥、`keys_verified`） | `peer_registry.rs:115` `upsert_peer`；`handshake.rs:231` `mark_peer_keys_verified` |
| peer 版本 | `peer_versions` | 协议/应用版本 | `handle_message`（`Unknown` 分支读） |
| 链路表 | `links` (`:1248`) | device_id → Vec\<Link\>（含三条 mpsc 通道） | `network/transport.rs:724`（入站）、`dial.rs`（出站）；`network/ble/central.rs:607`、`peripheral.rs:536` |
| Mesh 连接 | `peer_manager` (`:1229`) | Peer/Connection + 健康度 | `register_connection` / `unregister_connection`；`transport.rs:827` `mark_conn_seen` |
| Mesh 路由 | `mesh_router` (`:1235`) | 全局去重 + TTL 决策 | `mesh/router.rs:202` `on_receive` |
| Gossip 引擎 | `gossip` (`:1222`) | 去重 + 扇出 | `network/transport/gossip.rs:197` `handle_gossip` |
| Gossip 补递缓存 | `gossip_relay` (`:1174`) | 替别人转发过的群信封（有界，进程内） | `mesh/gossip_replay.rs` |
| 群密钥 | `group_keys` (`:1239`) | group_id → [u8;32] | `network/transport.rs:1312` `handle_group_key` |
| 待发已读 | `pending_reads` (`:1255`) / `pending_group_reads` | peer → last_read_ts | `network/transport/read_receipt.rs` |
| 待发群密钥 | `pending_group_keys` (`:1260`) | peer → set\<group_id\> | `network/transport/pending_keys.rs` |
| 待发好友申请 | `pending_out_requests` (`:1276`) / `pending_out_accepts` (`:1287`) | 有界补发登记 | `network/transport/handshake.rs` |
| 文件接收器 | `file_receivers` | transfer_id → FileReceiver（句柄 + 哈希 + 密钥） | `network/file/receive.rs:799` `make_receiver` |
| 群文件接收器 | `group_file_receivers` | | `network/file/group_receive.rs:18` `begin_group_receive` |
| 中继重组 | `relay` (`:1237`) `RelayManager` | transfer_id → Reassembly | `file_relay.rs:130`/`:184` |
| 中继文件密钥 | `relay_file_keys` (`:1316`) | transfer_id → 密钥 + SHA | `network/transport/relay_file.rs` |
| 群文件密钥 / 轮次 | `group_file_keys` (`:1322`) / `group_file_rounds` (`:1325`) / `group_file_round_seq` (`:1335`) | | `network/transport/group_file.rs` |
| 取消槽 | `file_send_cancels` (`:1368`)、`pending_file_accept` (`:1301`)、`pending_file_complete` (`:1312`) | oneshot 通道 | `network/file.rs:227` `signal_cancel_slot`；`network/file/send.rs:373` `install` || 拨号治理 | `dialing` (`:1080`)、`dial_permits` (`:1086`)、`inbound_permits` (`:1091`)、`group_file_permits` (`:1097`) | 在途去重 + 信号量 | `dial.rs:395` `connect_to_peer` |
| BLE 治理 | `ble_no_dial` (`:1118`)、`ble_peer_advertises` (`:1132`)、`ble_dial_failures` (`:1151`) | 镜像链路抑制 | `network/ble/*` |
| 中继策略缓存 | `relay_policy` (`:1169`) | `RelayConfig`（policy + allowlist） | `commands/settings.rs:369` `set_relay_policy_config` |
| UI 窗口态 | `todo_focus_request` (`:1205`)、`preview_gallery` (`:1211`)、`task_window_group` (`:1218`) | | `commands/logs.rs` |

### 4.5 配置 / 设置存储

- **存储**：`settings` 表（key-value）。13 个前端可写键：`theme_color` `font_family` `dark_mode`
  `appearance_mode` `notify_enabled` `notify_show_content` `remind_sound` `remind_vibrate`
  `language` `bind_ip` `chat_style` `chat_peer_styles` + `relay_policy` `relay_allowlist`。
- **写者**：`commands/settings.rs:275` `save_settings`（唯一前端写入口，逐键白名单校验）；
  `commands/settings.rs:382` `reset_settings`；`commands/group_delete_boundary.rs:60`/`:88`
  （`lan_enabled` / `bt_enabled`）；`state.rs:1729`/`:1731`（身份私钥）。
- **内存缓存**（转发热路径不锁 SQLite）：`state.lang_pref`（`state.rs:1071`）、`state.notify_pref`（`:1073`）、
  `state.relay_policy`（`:1169`）。
- **读取**：`commands/settings.rs:247` `get_settings`（13 次单行查询 + 一次 db 锁）。

---

## 5. Ranked Candidates（值得逐函数深挖的 40 个）

> 排名依据：**系统正确性依赖度** —— 校验不可信输入 / 强制边界或权限 / 修改共享状态 /
> 位于「不可信参与者 → 状态」路径上。
> 已剔除 getter、setter 与透传函数；已忽略 `*_tests.rs` 与 `#[cfg(test)]` 模块。

### T1 — 身份与握手边界（不可信对端 → 身份锚）

| # | 函数 | file:line | 为什么值得深挖 |
|---|---|---|---|
| 1 | `handle_incoming` | `network/transport.rs:585` | LAN 入站连接的总闸：首帧超时、Hello 验签、世代校验、入站去重、链路登记、回发 Hello —— 任何一格判错即冒名建链 |
| 2 | `verify_hello` | `network/transport/handshake.rs:56` | 信任根判定（friends → peers(keys_verified) → TOFU）；**nonce 必须在验签后才消费**，顺序颠倒即给洪泛者入场券 |
| 3 | `hello_auth_decision` | `network/transport/handshake.rs:7` | 已绑定身份与 TOFU 两条臂的纯判定：公钥不符 / 签名失败 ⇒ 必须拒绝 |
| 4 | `bound_ed25519_from_peer` | `network/transport/handshake.rs:128` | 决定「peers 里的公钥能不能当身份锚」；漏掉 `keys_verified` 过滤即等于允许抢先广播者冒充好友 |
| 5 | `mark_peer_keys_verified` | `network/transport/handshake.rs:231` | 「已验证」的唯一置位点；置错则后续所有 TOFU 判定随之失守 |
| 6 | `verify_hello_for_ble` | `network/transport/dial.rs:104` | BLE 侧的同一道闸（BLE 地址不是身份） |
| 7 | `accept_wrap_offer` | `transport/relay_seal.rs:271` | 中继协商签名的验收：验签、角色、通道哈希、对端 device_id 四项必须都对得上 |
| 8 | `RecordOpen::open_record` | `transport/relay_seal.rs:387` | AEAD 标签 + 递增计数器：中继注入/重放应当在此断链 |
| 9 | `verify_announce` / `AnnounceAuth` | `protocol.rs:2452`（调用点 `network/discovery.rs:605`） | announce 自签名校验；带签名却验不过必须在影响任何状态之前丢掉 |

### T2 — 不可信输入的帧解析与资源边界

| # | 函数 | file:line | 为什么值得深挖 |
|---|---|---|---|
| 10 | `read_bytes_capped` | `transport/tcp.rs:84` | TCP 长度前缀 → 校验 → 增量分配；**先校验后分配**的顺序与 `MAX_PREAUTH_FRAME` 收紧是两条核心防线 |
| 11 | `decode_frame` | `network/transport/outbound.rs:78` | JSON → `Message`；未知 variant 降级 vs 畸形字段报错，决定了「老设备连不上新设备」这类灾难的分界 |
| 12 | `read_frame_preauth` | `network/transport/outbound.rs:103` | 预认证首帧：**刻意不做**未知帧降级（认证前没有「可以继续聊」的理由） |
| 13 | `BleReassembler::push` | `transport/ble_framing.rs:266` | BLE 对端可控的 6 字节头：`count`/`index`/在途上限/字节上限/一致性 —— 每一条都是分配与状态放大的闸 |
| 14 | `handle_datagram` | `network/discovery.rs:585` | UDP 收包：JSON 解析、announce 验签、`upsert_peer`、**spawn 而非 await**（否则收包循环被 10s 拨号堵死） |
| 15 | `handle_message` | `network/transport.rs:1085` | 38 个变体的分发总表；定向借道分支在此吃中继授权闸 |
| 16 | `validate_opaque_external` | `protocol.rs:2337`（调用点 `network/transport.rs:1169`） | 不透明外部帧的畸形/超限拒收；必须「只丢这一帧、不断链」 |
| 17 | `chunk_seq_decision` / `chunk_exceeds_declared` / `frame_is_current` | `network/file/receive.rs:894` / `:910` / `:929` | 分片去重/跳号/超声明大小/轮次隔离三个判据，直接决定文件能否正确收敛 |

### T3 — 文件接收路径（不可信对端 → 磁盘）

| # | 函数 | file:line | 为什么值得深挖 |
|---|---|---|---|
| 18 | `make_receiver` | `network/file/receive.rs:799` | **落盘路径的唯一构造点**：`safe_file_name` + `safe_transfer_id` + 配额闸 `admit_inbound` + `.part` 命名（按 transfer_id 而非 final_path） |
| 19 | `write_chunk` | `network/file/receive.rs:972` | 解密 → 超声明检查 → 增量哈希 → 写盘 → 推进 seq → 节流落进度；密文绝不能落盘 |
| 20 | `decide_offer` | `network/file/receive.rs:425` | 续传位置的唯一判据（内存计数 vs 磁盘前缀 vs 已收完）；判错即整份重推或永不收敛 |
| 21 | `finish_receive` | `network/file/receive.rs:1281` | SHA-256 校验 → 改名落盘 → 台账收尾（rename 才是完成的唯一凭证） |
| 22 | `admit_inbound` | `network/file/receive.rs:599` | 入站文件配额闸（必须在建 `.part` 之前，且与 insert 共用一把闸） |
| 23 | `safe_file_name` / `safe_transfer_id` | `network/file/share_walk.rs:308` / `:325` | 对端可控字符串 → 文件名的消毒；两者都会被拼进磁盘路径 |
| 24 | `handle_file_messages`（FileOffer 臂） | `network/transport/handle_file.rs:10` | 好友校验 → SHA-256 元数据格式校验 → E2EE 解封文件密钥 → 位置判据，四道串联 |
| 25 | `handle_group_file_chunk` | `network/transport/group_file.rs:1948` | 群文件分片（扇出、轮次、群密钥解密、per-recipient 台账） |
| 26 | `handle_group_file_offer` | `network/transport/group_file.rs:268` | 群文件 Offer：群成员校验、群密钥解封、per-recipient 建账 |
| 27 | `add_chunk` / `begin_reassemble` | `file_relay.rs:184` / `:130` | 中继侧 `.part` 流式重组；`chunk_size` 不能反推（反推即偏移全错） |
| 28 | `stream_file` | `network/file/send.rs:418` | 发送侧分片循环、attempt epoch、取消响应 |

### T4 — 中继与转发授权（不可信中继 → 他人流量）

| # | 函数 | file:line | 为什么值得深挖 |
|---|---|---|---|
| 29 | `relay_denied` | `network/transport.rs:1068` | **数据面中继授权的唯一入口**（三个转发点共用）；授权主体必须是验签过的链路对端，不能用帧内自报 `from` |
| 30 | `decide_relay_from_peer` | `mesh/relay_policy.rs:122` | 数据面判据真值表（与 gossip 面共用策略语义） |
| 31 | `should_forward` / `decide_forward` | `mesh/relay_policy.rs:155` / `:181` | Gossip 面按**原始发送者**授权（Ed25519 背书），与数据面主体不同 |
| 32 | `handle_gossip` | `network/transport/gossip.rs:197` | 信封信任判定（peers 锚 vs friends 持久锚）、验签先于去重、TTL 只取自 Mesh Forward 决策（不可用自报 ttl-1） |
| 33 | `MeshRouter::on_receive` | `mesh/router.rs:202` | 全局去重 + TTL 判定；`max_ttl` 裁剪 + 递减是防 254 跳扩散的唯一闸 |
| 34 | `handle_share_and_relay_messages` | `network/transport/handle_share.rs:184` | 内容寻址 / 共享目录 / 单跳中继六变体的分发 |
| 35 | `resolve_shared_file` | `network/transport/handle_share.rs:79` | 共享目录路径解析：`canonicalize` 失败**不许**退回词法 `starts_with`（挡不住 `..` 与符号链接） |
| 36 | `content_serve_allowed` | `network/transport/handle_share.rs:19` | 「拥有即授权」的内容服务闸：好友 / 群成员 / 陌生人三档 |
| 37 | `handle_relay_chunk` / `handle_relay_file_offer` | `network/transport/relay_file.rs:153` / `:6` | 中继文件：密钥只到两端，中继只透传密文 |

### T5 — 落库裁决与共享状态变更

| # | 函数 | file:line | 为什么值得深挖 |
|---|---|---|---|
| 38 | `insert_message_if_new` | `db/messages.rs:28` | 三态（真插入 / 重复 / 真故障）决定「是否投递副作用」与「是否回 Ack」；折叠成 bool 即把临时故障变成永久丢消息 |
| 39 | `ack_delivered` | `db/messages.rs:841` | Ack 的副作用：删除 outbox 行 / 推进状态；重复 Ack 与非收件人 Ack 的判据都在此 |
| 40 | `apply_group_history_page` / `serve_group_history_page` | `db/group_history.rs:299` / `:141` | 群历史分页：预算闸、密封/解封、边界（清群 seq）、落地幂等 |

### T5 补充 —— 同样值得深挖（因 40 名上限而未单列，见备选）

- `commands/chat.rs:534` `send_message` — 好友校验 + 载荷校验 + 目标真实性 + E2EE + outbox 的五合一闸。
- `commands/chat.rs:326` `recall_message` / `commands/group_announcements.rs:116` `recall_group_message` —
  作者 vs 群主权限、撤回窗口、`group_recalled_messages` G-Set 的先撤后到处理。
- `commands/groups.rs:268`/`:321`/`:394` — 群主权限与成员表变更。
- `commands/files.rs:93` `delete_file` / `:165` `open_file_native` / `commands/helpers.rs:110` `save_data_file` —
  IPC 面上的任意路径读写删。
- `commands/helpers.rs:209` `resolve_media_path` — 消息内容里的 `path` 到本地文件的边界（必须落在 downloads 内或本机自发）。
- `commands/updater.rs:171`/`:249`/`:405` — 更新通道：降级闸、整包常驻内存、安装交接。
- `commands/external_links.rs:356` `import_external_links_from_url` — 唯一远程 URL 抓取出口。
- `network/transport/handle_identity.rs:11` `handle_identity_and_friend_messages` — 好友关系四变体。
- `network/transport/handle_messaging.rs:11` `handle_messaging_arm` — 聊天消息落库与 Ack 时序。
- `network/transport/group_membership.rs:34`/`:96`/`:128` — 群成员变更控制帧。
- `network/transport/outbox_sweep.rs:90` `spawn_outbox_sweeper` — 后台清扫器（ACK 账本重放、文件对账）。
- `network/group_history.rs:406` `run_group_history_sync` / `:1324` `handle_request` / `:1263` `handle_reply` — 群历史引擎。
- `network/transport/peer_registry.rs:115` `upsert_peer` — peer 表写入（公钥来源与 `keys_verified` 语义）。
- `mesh/relay_policy.rs:39` `RelayPolicy::parse` / `:86` `RelayConfig::parse` — 脏值回落语义（未知值 ⇒ `All`）。
- `content/store.rs:92` `upsert` / `:307` `record_failure` — 内容传输台账（尝试次数单调、退避、重试封顶）。
- `crypto.rs:75` `shared_secret` / `:83` `seal` / `:95` `open` / `:178` `verify_signature` — 密码学原语封装。
- `protocol.rs:1392` `recall_verdict` / `:1518` `recall_receive_allowed` / `:318` `kind_audience` — 权限与受众判据真源。
- `state.rs:1060` `AppState` — 全部内存态的单一持有者。

---

## 6. 最复杂 / 最脆弱的 5 个区域

1. **`network/transport.rs` 的消息分发 + 六个 handler 册**
   （`network/transport.rs:1085` + `handle_file.rs` / `handle_identity.rs` / `handle_messaging.rs` /
   `handle_group.rs` / `handle_share.rs` / `gossip.rs`）
   —— 38 个 `Message` 变体、5 个不可信参与者类别、跨 6 个族册；拆分依据是 AST 现量的「无裸 let 绑定 /
   分支间不共享局部量」（`handle_file.rs:2-8`），逻辑上是机械搬家，但**权限判据分布在多册**，
   任何一册漏判即整族失效。

2. **文件传输的双路径 + 续传状态机**
   （`network/file/receive.rs` 1640 行 + `network/file/send.rs` 820 行 + `network/transport/group_file.rs` 2513 行 +
   `file_relay.rs` 508 行）
   —— 四套并存的状态（内存接收器 / 磁盘 `.part` 前缀 / `file_transfers` 台账 / `content_transfers` 台账），
   三套 attempt/轮次机制（`attempt`、`group_file_rounds`、`group_file_round_seq`），
   每处注释都记录过一次真实的「永不收敛 / 静默丢片 / 哈希不匹配」事故。

3. **身份与信任锚的 TOFU → PIN 演进链**
   （`network/transport/handshake.rs` + `protocol.rs::verify_announce` + `db/friends.rs` +
   `network/transport/gossip.rs::gossip_trust_for_unpeer_sender`）
   —— 信任根在 friends（持久）与 peers（内存）之间迁移，两套判据（`keys_verified` 过滤、
   peers 空 ⇒ 不等于陌生节点），加上 announce 抢先广播的竞态，注释里明确记录过 P0 级冒充路径。

4. **中继路径的全栈封装**
   （`transport/relay_seal.rs` 916 行 + `network/transport/relay.rs` 924 行 +
   `network/transport/relay_file.rs` 586 行 + `mesh/relay_policy.rs` 497 行）
   —— 自研记录层（零 TLS）承担了「中继不可信」的假设：协商签名、通道哈希按天轮换、
   AEAD + 计数器防重放、**中继策略默认 `All`**（保持传播语义而非安全默认，见 `relay_policy.rs:8-13`），
   四处判据必须保持一致。

5. **SQLite schema 与迁移的双真源**
   （`db.rs:741` `SCHEMA` + `db.rs` 迁移链 v1→v14 + `content/store.rs:14` 第二张表 + `db/migration_tests.rs` 2896 行）
   —— `SCHEMA` 是"新库形状"，迁移是"老库形状"，两者必须收敛到同一形状（由 `fresh_schema_alone_has_exactly_the_migrated_shape` 钉住）；
   `idx_messages_conv_seq` **刻意不在 SCHEMA 里**（`seq` 是迁移后加的列），顺序即语义。

---

## 7. ORIENT 阶段的已知盲区（留给后续阶段）

1. **BLE 路径没有 `decode_frame` 降级**：`network/ble/io_loops.rs:200` 直接
   `serde_json::from_slice::<Message>`，未知变体 ⇒ 丢帧并告警（不拆链，但与 TCP 行为不同）。
2. **`AppState` 无法在测试里构造**：`state.rs:1061` 的 `pub app: AppHandle` 是具体 `AppHandle<Wry>`，
   且 `Cargo.toml` 无 `[dev-dependencies]` ⇒ 全仓**没有任何测试调用过 `handle_message`**
   （`docs/protocol-invariants.md:93` 自述）。这是最大的可测性缺口。
3. **注释里的 `file:line` 普遍不可信**（`transport/tcp.rs:17-24` 自述）；本文件所有行号均已现读现核。
4. **BLE 分片上限 512KiB / 8192 片**与 TCP 帧上限 64MiB 相差两个数量级，跨传输的 DoS 面不对称。
5. **更新通道的签名校验依赖官方插件**，本仓只额外加了「禁止降级」闸（`updater.rs:163`）；
   清单端点、pubkey、签名算法均不在本仓控制范围内。
6. **`import_external_links_from_url`** 是唯一的远程 URL 抓取出口，其 URL 白名单
   （`commands/external_links.rs:41` `validate_external_url`）与实际抓取是否共用同一判据，
   需要在后续阶段单独核对。

---

*本文件由 ORIENT 阶段生成：模块/入口/参与者/状态/候选五张表，行号全部现场核对，未使用记忆中的仓库内容。*
