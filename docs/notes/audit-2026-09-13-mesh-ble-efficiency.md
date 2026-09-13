# 审计：BLE 加入 mesh 的稳定性 · 聊天效率 · 手机↔电脑 / 手机↔手机 mesh

- 日期：2026-09-13
- 基线：`b4b82fb`（4.2.19）+ 工作区未提交改动
- 范围：按用户 2026-09-13 的优先级 —— ① 蓝牙设备加入 mesh 的**稳定性** ② **聊天高效**
  ③ **BLE↔BLE / 手机↔手机 mesh**（先手机↔电脑，再手机↔手机）。Windows 蓝牙与 UI 交互靠后。
- 方法：读代码（`文件:行号` 取证）+ 三路并行深审（BLE 传输层 / mesh 多跳 / 聊天效率）+ 对照 btleplug 0.13 实际实现。
- 标注：**【已核实】**=有代码证据；**【待实测】**=只能真机确认。

---

## 0. 结论（TL;DR）

1. **框架是齐的**：三种链路、统一链路表、多跳路由、中继授权、外部帧流水线（Phase 8）**都已在主干实现**。
   缺的不是"有没有"，而是**稳定性细节 + 可观测性 + 弱链路效率**。
2. **🔴 最严重：BLE 链路会周期性自杀。** 读活性只在建链时播种一次、此后只由**读循环**刷新，
   而 BLE 读循环**漏调** `mark_conn_seen` ⇒ 任何**健康**的蓝牙链路
   **15s 被判"不健康"、45s 被健康看门狗拆掉**，对端再拨回来、再拆，无限循环。
   （`network/ble.rs` 读循环 vs `transport.rs:1326` TCP 侧；**本轮已修 + 已加护栏**。）
3. **"1 KB/s" 是假设，不是实测。** 代码在 central 侧本会协商到 **182~514 字节载荷**
   （btleplug：macOS `maximumWriteValueLength+3`、Android `requestMtu(517)`），
   而我们**从不打印协商到的 MTU** ⇒ 真实吞吐未知，给用户的提示文案可能低报一个数量级。
4. **真正卡吞吐的大概率是"每片固定 sleep 12ms"**（`ble_android.rs:56`）—— 由载荷/12ms 决定速率。
5. **BLE 上 >20KB 的文件事实上传不完**：`file.rs:317` 固定 30s 等 `FileCompleteAck`，
   而 1MB 文件的 256 个分块在 1s 内就全部入队、`FileDone` 排在很后面 ⇒ 必然超时 ⇒
   每 5s 从头重传（且 `seq` 从 0 重来）⇒ 接收方报**"文件分片顺序错误"**
   —— **这正是你之前报过的那条错**。
6. **群文件在 BLE 上 0 字节可达**：`commands.rs:2962` 硬编码 256KiB/块（没走 `chunk_size_for_path`），
   MTU23 下要 25000 片 > 上限 8192 ⇒ 整帧被丢弃，而发送方界面照旧显示"已发送"。
7. **多跳 mesh 有 4 个阻断点**（群消息非成员不转发、无 store-and-forward、跨跳无补发、
   fanout 候选用 peers 且失败静默）—— "3 节点、同时在线、单聊"这条最窄路径推演可通，但**从未真机验收**。

---

## 1. 事实基线：现在到底有什么

| 能力 | 状态 | 证据 |
|---|---|---|
| LAN 发现（UDP 广播+组播）/ BLE 扫描 | ✅ | `network/discovery.rs`；`network/ble.rs:52-73` |
| 建链：TCP（小 id 拨）/ BLE（大 id 拨，central+peripheral 双角色） | ✅ | `network/ble.rs::should_dial_ble` |
| 双向 Hello 验签、镜像链路退让、重连防幽灵连接 | ✅ | `network/ble.rs:477-484,551-574` |
| 统一链路表 + 每链路 priority/bulk 双队列 | ✅ | `state.rs:187-213` |
| 选路 LAN > Routed > BLE + 健康度 | ✅ | `mesh/selection.rs:32-68` |
| 多跳中继 + TTL + 三重去重 | ✅（有缺口） | `mesh/router.rs`、`transport.rs:3331-3585` |
| 中继授权 all/friends/allowlist/off（默认 all） | ✅ | `mesh/relay_policy.rs:22-47` |
| 外部帧流水线（Phase 8 线格式+转发） | ✅ 代码在，**无生产者** | `protocol.rs:501`、`transport.rs:2164-2227` |
| 离线补发 outbox/group_outbox/file_outbox + Ack 才删 | ✅（**不支持跨跳**） | `commands.rs:1822-1834`、`transport.rs:5748` |
| BLE 分片/重组 + 在途/大小上限 | ✅ | `transport/ble_framing.rs` |
| BLE 外设：macOS ✅ / Android ✅ / Windows ⬜ | — | `ble.rs:133,1079`（仅 macos/android） |
| 读活性看门狗 + 死链拆除 | ✅ | `transport.rs:457-503`、`mesh/manager.rs:154-168` |

---

## 2. 🔴 P0：BLE 链路周期性自杀（**本轮已修**）

**证据链**：
- 读活性唯一写入点：`mesh/manager.rs:113 mark_connection_seen`（`inbound=true`）。
- 非读循环的唯一写入口是 `seed_connection_read_seen`，只在**新连接**时调用
  （`transport.rs:1507-1509`，"只在真的是新连接时播种"）。
- TCP 侧每次读到帧都刷新：`transport.rs:1326 mark_conn_seen(&state, &peer_id, &endpoint)`。
- **BLE 读循环 `ble.rs:974-1060` 里此前没有任何 `mark_conn_seen`/`peer_manager` 调用**（grep 为空）。
- 看门狗按 `health_timeout(15s) × 3 = 45s` 拆链路：`transport.rs:457-503`，且**显式覆盖非 TCP 端点**。

**后果**（与你的实测体感完全对上）：
- 15s 后 `is_healthy=false` → 选路/镜像去重按"不健康"处理；
- 45s 被拆 → 对端再拨回 → 再撑 45s → 再拆；
- 期间所有在途消息/文件分片作废 → **"蓝牙时好时坏""加好友过一会儿才到""大图传到一半失败"**。

**修法（已落地）**：`ble.rs` 读循环读到帧即 `mark_conn_seen`。
该函数同时服务 central（`BleReader`）与外设（`ChannelSource`）两条路径，一处修复覆盖两个方向。
护栏：Rust 单测 `ble_reader_loop_refreshes_read_activity`（源码断言，漏了必 FAIL）+
`verify-guards.py` 新增非空转用例。

---

## 3. 🔴 P0：BLE 吞吐的真相与瓶颈

### 3.1 "MTU=23 / 1KB/s" 是**假设**，不是实测

- `file.rs:60-70` 的注释按 MTU23（14B/片）推算；全仓库**没有任何 MTU 日志**。
- 但 btleplug 0.13 的真实实现是：
  - macOS central：`mtu = maximumWriteValueLength + 3`（通常 185 ⇒ 载荷 182）
    （`btleplug/src/corebluetooth/internal.rs:53`）
  - Android central：连接时 `requestMtu(517)` 并存回结果（`btleplug/src/droidplug/peripheral.rs:255-266`）
  - 我方外设：`central_payload_mtu(maximumUpdateValueLength)`，钳 512（`bluetooth_peripheral.rs:88-97`）
- ⇒ 正常协商应是 **182~512 字节载荷**；**我们的代码里没有 `request_mtu`，全靠对端/系统隐式协商**。

### 3.2 真正的限速器：每片固定 12ms

`ble_android.rs:56 NOTIFY_CHUNK_INTERVAL = 12ms`，`send_frame` 每片后 sleep（`:244-248`）。
⇒ 速率 = 载荷/12ms：MTU23 ⇒ ~1.2KB/s；载荷 182 ⇒ ~15KB/s；载荷 506 ⇒ ~42KB/s。
macOS 外设走 `updateValue` 队列+连接间隔（`bluetooth_peripheral.rs:225-266`），量级类似。

### 3.3 三个改动点（按顺序）

1. **加 MTU 日志**（central + 外设两侧）—— 否则后面全是盲改。
2. **`onNotificationSent` 做真背压**（回调已存在，`BlePeripheral.kt:437`，目前只打日志），
   把"固定 12ms"换成"能发多快发多快 + 超时兜底"。**必须真机 A/B**（12ms 是踩坑换来的）。
3. **Android central 主动 `requestMtu`**（若实测发现落在 23）；
   同时放宽 `bluetooth_peripheral.rs:90` / `BlePeripheral.kt:340` 的 512 上限（否则 517 协商会误退 20）。

### 3.4 附带不自洽（值得顺手修）

- `MAX_BLE_CHUNKS_PER_MESSAGE=8192` 与 `MAX_BLE_MESSAGE_BYTES=512KiB` 在 MTU23 下只覆盖 **114KB**；
  114KB~512KB 必然 `fragment→None`，而错误只报"帧无法分片"（`ble_framing.rs:52-58,85`）。

---

## 4. 🔴 P0（聊天效率）：BLE 上大文件传不完，且会退化成"分片顺序错误"

- `file.rs:305-330`：`FileDone` 之后**固定等 30s** 要 `FileCompleteAck`。
- 发送侧把 4KiB 明文 → 加密(+nonce/tag) → base64(×1.33) → JSON ≈ **5.5KB/帧**
  （`file.rs:255-262`、`crypto.rs:83-91`）⇒ MTU23 下 **399 片/块**（注释里写的 293 片漏算了 base64）。
- 1MB = 256 块，**1 秒内全部入队**（mpsc 容量 1024），`FileDone` 排在第 257 位；30s 只走得掉约 30KB
  ⇒ **必然超时** ⇒ `Err(retryable)` ⇒ 每 5s 心跳重传，且**重传时 `seq` 从 0 重来**（`file.rs:227`）
  而接收方 `next_seq` 已推进 ⇒ **`file.rs:537` 返回「文件分片顺序错误」**（= 你截图里那条）。
- ⇒ **BLE 上 >20KB 的文件事实上不可能完成；`attempts` 只增无上限（`db.rs:1218`）。**

**修法（建议第 1 优先做）**：把"固定 30s"改成**进展驱动**（每写出一帧刷新一个 watch，
`stream_file` 等"静默超时"而非总时长）；再加 `file_outbox.attempts` 上限 + 断点续传（`start_seq`）。

### 4.1 群文件在 BLE 上 = 0 字节

`commands.rs:2962` 群文件固定 `FILE_CHUNK=256KiB`（**没走 `chunk_size_for_path`**）
⇒ MTU23 需 ≈25000 片 > `MAX_BLE_CHUNKS_PER_MESSAGE=8192` ⇒ `fragment()` 返回 `None`
⇒ 整帧被丢弃且只打一条 warn（`ble.rs:940-949`），**发送方界面照旧显示已发送**。
修法：改用 `chunk_size_for_path`（与单聊同一真相源）。

---

## 5. P1：聊天效率的其余瓶颈

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | **帧内不可抢占**：写循环一次发完整帧，priority 只能在帧间插队 | `ble.rs:891-926`、`bluetooth.rs:326-333` | 4KiB 块 = 399 片 ≈ **5.5s**；群文件块 ≈ 6 分钟；上限 512KiB ⇒ 最长阻塞约 8 分钟 |
| 2 | **跨跳无 outbox 补发**：outbox 只按直连 peer `try_send` | `commands.rs:1822-1834`、`transport.rs:5748` | A→C 无直连时首帧丢 = 永久"发送中" |
| 3 | **无 store-and-forward**：转发只在两端同时在线时直发 | `transport.rs:3550-3585` | 对端不在线即丢（BitChat 对比文档已标"未做"） |
| 4 | **群消息非成员不转发**：群成员门在转发决策**之前** return | `transport.rs:3500-3506` | 群聊无法借非成员中继 ⇒ **多跳群聊不通** |
| 5 | **fanout 候选取 `peers`（含无链路节点）且失败静默** | `transport.rs:3550-3570,3583` | ≥4 节点时转发可能空转 |
| 6 | **Gossip TTL 上限失效**：router 的 max_ttl 裁剪只用于 Drop 判定，实际发出 `env.ttl-1`，而 ttl 不参与签名 | `router.rs:191-196` vs `transport.rs:3573-3574`、`protocol.rs:188-207` | 自报 ttl=255 可扩散 255 跳（放大/滥用面） |
| 7 | **M3-d 未接线**：源发 Gossip 取 `links.get(peer).first()`，不按健康度选路 | `transport.rs:274` | LAN 死链路 + 健康 BLE 时，**源发消息仍投死路** |
| 8 | 心跳 5s 固定、BLE 上开销占比不低 | `transport.rs:1589` | 弱链路可拉长 |
| 9 | 外设侧坏片**完全静默**（central 已有日志） | `bluetooth_peripheral.rs:651`、`ble_android.rs:427` | 你报过的"分片错误"那一半路径无证据 |
| 10 | 局域网侧：深 OFFSET 分页 + 每条消息 O(n)/O(n log n) 前端合并 | `db.rs:765`、`utils/messages.ts:22`、`useChatStore.ts:250-268` | 大会话开窗与高频收消息变慢 |
| 11 | `relay_manager.rs`（BitTorrent 式并行分发）是**死代码** | `#[allow(dead_code)]`，仅构造/重置 | 文档若宣称"并行中继"是失实的 |
| 12 | 文件中继也是死代码：`send_file_relay` 退化为直发 | `commands.rs:3444-3450` | 跨跳文件只能一跳、无兜底 |

---

## 6. P1：BLE 连接生命周期与并发

| # | 问题 | 证据 |
|---|---|---|
| 1 | `teardown_link` **不断开物理连接**，也不唤醒扫描 ⇒ 重连要等下一轮（前台≤5s/**后台≤30s**） | `ble.rs:195-222`（作者自注 drop Peripheral 不断连 `:490-491`） |
| 2 | 外设侧 `handshaking` 集合**泄漏** | ✅ 已修：新增 `RouteCtl::HandshakeFailed`，**只在握手失败时**回传并摘标记（成功仍由 `Add` 摘，避免与「刚起来的第二次握手」抢标记）|
| 3 | 外设重连**不清重组器**，而 central 的 msg_id 每连接从 1 重启 ⇒ 新旧分片撞车、整条消息被丢 | `bluetooth.rs:287`、`bluetooth_peripheral.rs:409` |
| 4 | BLE 拨号**不占 `dial_permits`**（TCP 占 16），外设三表无上限 ⇒ 伪造/拥挤环境可无界 spawn | `ble.rs:462`、`state.rs:568` |
| 5 | `ble_no_dial` 按 BLE 地址记、只在 stop 清 ⇒ 对端换角色/地址后可能永久单侧不可拨 | `ble.rs:253-260,162-167` |
| 6 | `start()` 在 `adapter()` 失败时 `?` 早退 ⇒ **外设角色根本不会启动**（与 `:130-134` 注释矛盾） | `ble.rs:125` |
| 7 | stop 不清 `ble_dial_failures` ⇒ 重开通道后仍可能被最多 60s 退避挡住 | `ble.rs:162-167` |

---

## 7. 文档与规则不一致（按项目自己的规则必须治理）

| 文档 | 写的 | 实际 |
|---|---|---|
| `AI_RULES.md` §3 冻结清单 | "不要实现 Bluetooth transport / Advanced Mesh routing…" | 蓝牙与 mesh 已是**当前主线** |
| `docs/acceptance/1.0-release.md` | "不要主动实现 Bluetooth、Mesh…" | 同上 |
| `.workbuddy/mesh-task/P2-P3-开发计划.md` §9.1 | Phase 8 ⬜"已授权可开工" | **代码已实现**（`transport.rs:2164`） |
| `AI_PROJECT_HANDOFF.md` | "Android 侧仅为接口契约，未接线" | 早已接线 |
| `docs/adr/0017` | "Phase 8 已落地" | 线格式+流水线在，但**没有生产者**（见 §5 第 6 条）——两边都只对一半 |
| `docs/notes/ble-audit-2026-09-13.md:89` | "MTU 只有 23 ⇒ 1.2KB/s" | **未实测的假设**（见 §3） |
| `useAppStore.ts:647-650` 注释 | "移动端启动路径不申请任何权限" | `:645` 无条件 2s 后调 `ensureBluetoothOn()`（含权限申请） |

---

## 8. 建议推进顺序

1. **✅ 已做**：BLE 读循环回灌读活性（消除 45s 自拆）。
2. **MTU + 吞吐可观测性**（两侧日志）→ 出包 → **你真机跑一次基准**。
3. **文件传输 30s 固定超时改成进展驱动** + `attempts` 上限（消除"永远传不完 + 分片顺序错误"）。
4. **群文件块大小走 `chunk_size_for_path`**（一行级，消除"0 字节可达"）。
5. **断链立刻重拨（burst）+ 清退避**（"加入 mesh 稳定性"）。
6. **`onNotificationSent` 真背压**（真机 A/B）。
7. **帧内让路 + BLE 单帧上限收紧**（聊天不再被文件阻塞）。
8. **群消息转发门位置修正 + 跨跳补发 + M3-d 选路接线**（这三条是"手机↔手机 mesh"能不能用的分水岭）。
9. 外设侧坏片日志、handshaking 泄漏、并发上限、文档治理。

---

## 9. 审计后的修复进展（回填）

| 审计项 | 状态 | 提交/位置 |
|---|---|---|
| §2 **BLE 健康链路每 45s 自拆** | ✅ 已修 + 护栏 | `network/ble.rs::ble_reader_loop` 回灌 `mark_conn_seen`；单测 `ble_reader_loop_refreshes_read_activity` + verify-guards 用例 |
| §3 MTU 不可观测 | ✅ 已加日志 | central：`[GATT] MTU 协商结果 …`；外设：`[GATT] 外设侧 MTU 协商结果 …`（真实数值待 T2 真机测） |
| §4.1 群文件在 BLE 上 0 字节可达 | ✅ 已修 | `commands.rs::dispatch_group_file_to_peer` 改用 `chunk_size_for_path(inbound_path_kind(...))` |
| §6-1 断链不立刻重拨 | ✅ 已修 | `network/ble.rs::teardown_link` → `wake_scan` + 清该地址退避 |
| §6-… 外设侧坏片静默 | ⬜ 未做 | `bluetooth_peripheral.rs` / `ble_android.rs` |
| §6-2 外设 `handshaking` 泄漏 | ✅ 已修 | `RouteCtl::HandshakeFailed`（只在失败时摘标记）|
| §4 文件 30s 固定超时 ⇒ 大文件永远传不完 | ✅ 已修 | 进展驱动的**安静 30s** 超时（`file_wire_progress` 由两条 writer_loop 在写成功时刷新）+ 重传时接收方重置 + 重复分片忽略；纯函数 `chunk_seq_decision` + 单测 + verify-guards 用例 |
| §5-1 帧内不可抢占（文件阻塞聊天） | ⬜ 未做 | `ble.rs` / `bluetooth.rs` |
| §5-2/3 跨跳补发 + store-and-forward | ⬜ 未做 | `transport.rs` |
| §5-4 群消息非成员不转发 | ✅ 已修 | 判据抽成纯函数 `group_envelope_consumable`（只决定"要不要本地消费"），非成员继续转发；真值表单测 + 结构护栏 |
| §5-6 Gossip TTL 上限失效 | ⬜ 未做 | `router.rs` / `transport.rs` |
| §5-7 M3-d 源发不按健康度选路 | ⬜ 未做 | `transport.rs:274` |
| §7 文档与代码不一致 | ⬜ 未做 | 见该节清单 |

验证：`cargo check`（默认 + bluetooth）0 warning · `cargo test --features bluetooth --lib` **430/430** ·
`npm test` **360/360**。
