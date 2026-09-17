# 迁移台账（Migration Ledger）

> **这份台账只回答一个问题：每个关注点有几个"家"，哪个在跑数据？**
>
> 配套：`docs/domains.yml`（机器可读的领域图）。两份文件必须一致 —— 由
> `scripts/check-domain-map.mjs` 守门（路径存在、一文件不属两域、无文件漏归属）。

---

## 0. 为什么需要这份台账

本仓库处在一次**半完成的 ADR 迁移**中：从 `network/`（老栈）走向
`transport/` + `discovery/` + `mesh/`（新栈，分 `P-A03` / `P-A04` / `7-e` 等阶段）。

这本身是**正确**的安排（新栈的文档头把"待接线"写得很清楚）。风险在于：

```text
同一个关注点有两个家，且都"看起来对"
      ↓
AI（或人）改「传输 / 在线状态 / 发现」时 grep 命中 2 处
      ↓
改了搜索先命中的那个（通常是更小、更新、文档更好的新家）
      ↓
真跑数据的是老家 ⇒ 症状不变或换了个形态
      ↓
下一轮再修，命中另一处 ⇒ 「改完这个 bug 又冒那个」
```

**所以 `docs/domains.yml` 里每个领域强制带一个 `active_home` 字段** ——
不回答这个问题，领域图就是一份"AI 会照着执行、但与真实活路径不符"的地图，
**比没有地图更危险**。

本台账的每一条都给出 `file:line` 证据，都是实测（`grep` 调用点）而非推测。

---

## 1. 台账正文

| # | 关注点 | 家 A（旧） | 家 B（新） | **谁在跑数据** | 证据 | 收口动作 |
|---|---|---|---|---|---|---|
| 1 | **局域网发现（UDP 广播/组播）** | `network/discovery.rs`（1089 行，含 `UdpSocket::bind` / `recv_from` / `send_to` 循环） | `discovery/`（5 文件 684 行：`trait` / `lan` / `manager` / `routed`） | **A（旧家）** | 旧家：`network/mod.rs:54` 起 `discovery::spawn(...)`；新家：`DiscoveryManager` 除 `discovery/mod.rs:21` 的 re-export 外**无任何调用点**，`LanDiscovery` 只出现在 `discovery/mod.rs:9` 的注释里 | 把 socket 循环搬进 `discovery/lan.rs`，删掉旧家（`discovery/lan.rs` 自己写着"待下一步由 Adapter 接入"） |
| 2 | **TCP 帧原语（4 字节大端长度 + payload）** | 曾内联在 `network/transport.rs` | `transport/tcp.rs`（356 行） | **B（新家）** | `network/transport.rs:40` `use crate::transport::tcp::{TcpReceiver, TcpSender}`；`:57` `tcp::write_bytes`；`:62` `tcp::read_bytes`；注释自述"单一真相源见 `transport::tcp`（P-A03）" | ✅ 已收口（只是 `TcpTransport` **结构体**仍未接线，见第 4 行） |
| 3 | **TCP 数据面 / 建链 / 心跳** | `network/transport.rs`（**8836 行**：建链竞态、Gossip 广播、中继切片、群密钥、E2EE 解密分发） | — | **A（旧家，单家）** | `state.rs:1042` 注释"心跳在 `network::transport` 每 5s 一次"；`ensure_link` / `should_dial` 都在此 | Phase 7：先回答"这个文件里有几个独立的变化原因"（行数**不是**判据），再按变化原因拆 |
| 4 | **传输抽象 / 通道分流** | — | `transport/mod.rs`（`Transport` trait + `TransportManager` + `Channel`） | **控制面活、数据面未接线** | 控制面：`commands.rs:495,756,983` 用 `TransportManager::{new,status}`；数据面：`route()` 带 `#[allow(dead_code)]` + 注释"**待蓝牙后端接入后**，在消息/文件发送路径中调用以真正分流"；`transport/lan.rs` 只在 `transport/mod.rs:90,104` 作为字段被构造 | 保持未接线（等真机），但**要在领域图上标注**，否则 AI 会以为分流已经在跑 |
| 5 | **BLE 中央角色（扫描/连接/握手）** | `network/ble.rs`（2236 行：扫描循环、握手验签、链路登记、去重、退避） | `transport/bluetooth.rs::driver`（btleplug 封装） | **两家都在跑**（分层，不是重复） | `network/ble.rs:42` `use ...::driver::{self, BleReader, BleWriter}`；实际调用 7 处：`:179 driver::adapter()`、`:386 driver::scan_peers()`、`:785 driver::connect()`、`:835 driver::BleConnection`、`:863 writer.send_frame()` | ✅ 这是**正常分层**（driver = 字节级、`network/ble.rs` = 策略级）。不要合并 |
| 6 | **BLE 外设角色（GATT server）** | — | `transport/bluetooth_peripheral.rs`(macOS) / `_windows.rs` / `ble_android.rs` | **B（新家，三家平台实现）** | `network/ble.rs:54-64` 按 `target_os` 分别 `use`；`transport/mod.rs:15,19,24` 的 `cfg(target_os)` 门控 | ✅ 已收口；Phase 4 给 Android 加了编译门禁 |
| 7 | **BLE 载荷预算 / 分片** | 曾有三份：`ble_framing.rs` 函数内匿名常量、`bluetooth.rs:110,112` 重复常量、macOS `central_payload_mtu` 自算一份、Android `payload_mtu` 自算一份 | `transport/ble_framing.rs`（唯一） | **B（新家，已收敛）** | Phase 3：`4.18.7→4.18.10` 连着四版修同一问题；Phase 4：Android 那份还有真 bug（`1..=512` 放行装不下分片头的值 ⇒ 整条链路发不出消息） | ✅ 已收口（`INV-P23` + `scripts/check-ble-constants.mjs` 三条判据） |
| 8 | **Mesh 路由 / 选路 / 中继策略** | — | `mesh/`（10 文件 2432 行） | **单家（活）** | 被 9 个外部文件引用：`network/{ble,transport,file}.rs`、`discovery/{trait,lan,manager,routed}.rs`、`commands.rs`、`state.rs` | ✅ **本仓库最成型的领域模块**（有 ADR-0013/0014 背书）。是"领域该长什么样"的参照 |
| 9 | **文件切片中继（BitTorrent 式分发）** | — | `file_relay.rs`（299 行；原 `relay_manager.rs`，2026-09-17 重命名以消"relay"命名撞车） | **部分未接线** | 活：`network/file.rs:296` 用 `MIN_CHUNK_SIZE`、`commands.rs:4999` 用 `RelayManager::new()`、`state.rs:23` 导入类型；未接线：`ChunkData`(17) / `RelayPlan`(25) / `impl RelayManager`(67) 都带 `#[allow(dead_code)]` | 低频，可缓。命名撞车已处理（见 §2） |
| 10 | **内容生命周期（文本/文件/图片统一）** | — | `content/`（4 文件 725 行） | **单家（活）** | `network/{transport,file}.rs`、`db.rs`、`commands.rs` 引用 | ✅ 已收口 |
| 11 | **二进制落盘 + 缓存清理** | — | `storage/`（2 文件 212 行） | **单家（活）** | `commands.rs:63` 用 `cache_cleaner::{CachePolicy, CleanupReport}` | ✅ 已收口 |

**统计**：11 个关注点里，**1 个双家未收口**（发现）、**1 个三家但属正常分层**（BLE）、
**2 个部分未接线**（传输抽象、文件切片中继）、**6 个已收口/单家**。

---

## 2. 命名撞车（作者已经要用注释来区分了 —— 这就是结构问题的化石）

| 撞车 | 两处 | 现状 |
|---|---|---|
| 两个 `transport.rs` | `network/transport.rs`（8836 行，活）vs `transport/{mod,tcp}.rs`（新栈） | ⚠️ **未消解**。搜索 `transport` 会同时命中两个栈 |
| 两个 "relay" | `file_relay.rs`（**文件切片中继**；原 `relay_manager.rs`，2026-09-17 改名）vs `mesh::router`（**路由转发**） | ✅ **已消解**。模块名自带语义，不再需要 `lib.rs:19` 那句"无关"注释 |
| 两个 "discovery" | `network/discovery.rs`（活）vs `discovery/`（未接线） | ⚠️ **未消解**，且**活的那个名字更难猜** |
| 两个 payload budget | 已收敛（Phase 3/4） | ✅ 已消解 |

**剩余建议**（Phase 6/7 的最小动作，不需要重构）：
- 两个 `transport.rs` 的消解必须等迁移收口，**现在不要动**（改名会让"哪个是活的"更难判断）。

---

## 3. 过期的"未接线"声明（文档与代码冲突 —— 按项目规矩必须上报，不得静默择一）

`docs/AI_ENGINEERING_INDEX.md` 的规矩：「若文档与可执行代码/测试冲突，**不得静默择一**，
必须上报并判定是文档过期还是实现过期」。以下是本台账实测发现的冲突：

| # | 声明 | 实测 | 判定 |
|---|---|---|---|
| 1 | `transport/bluetooth.rs:37`：「## 状态：**已实现、尚未接线**（7-e 的一半）」 | `network/ble.rs` 有 **7 处**实际调用（`driver::adapter` / `scan_peers` / `connect` / `BleConnection` / `send_frame`） | ❌ **文档过期**（至少对 `driver` 部分）。准确表述应是：**`driver` 已接线；未接线的是同文件的 `BluetoothTransport`（`Transport` trait 实现，仅服务 `status()` 展示）与 `TransportManager::route()`** |
| 2 | `transport/tcp.rs:14`：`#![allow(dead_code)] // 旁路阶段：待接线后移除` | `network/transport.rs:40,57,62` 用了它的 `TcpReceiver` / `TcpSender` / `write_bytes` / `read_bytes` | ❌ **文档过期（部分）**：帧原语**已接线**并被自述为"单一真相源（P-A03）"；未接线的只是 `TcpTransport` 结构体 |
| 3 | `transport/mod.rs:112`：「待蓝牙后端接入后，在消息/文件发送路径中调用以真正分流」 | `route()` 确实无生产调用点 | ✅ **准确** |
| 4 | `transport/mod.rs:122` + 注释：「开了 `bluetooth` feature 时**不用它**……只服务未编译 BLE 后端的默认构建」 | 与 `network/ble.rs` 的分工一致 | ✅ **准确**（这是"条件化 allow"的正面样本） |
| 5 | `lib.rs:1920` / `network/ble.rs:153`：`TransportManager` 里的 `BluetoothTransport` 是"尚未接线"的占位实现 | 确实只用于 `status()` | ✅ **准确** |

> 第 1、2 条与 Phase 3 修掉的 `ble_framing.rs` 那句"接入前没有任何生产调用点"是**同一个病**：
> **"待接线"的注释在接线之后没人回头改**。而且它们都挂着 `#[allow(dead_code)]`，
> 把编译器本来会给出的提示一起静音了 —— 于是过期声明可以存活很久。
>
> 本轮**只上报、不改**（Phase 5 是只读审计）。修正它们属于 Phase 6/7 的最小动作。

---

## 4. 收口顺序（Phase 6/7 的输入）

按「风险 ÷ 护栏成熟度」排：

| 序 | 关注点 | 为什么排这个位置 | 前置条件 |
|---|---|---|---|
| 1 | ~~修正 §3 的第 1、2 条过期声明~~ | ~~零风险（只改注释），且**不修就会继续误导**下一次判断~~ | 无 |
| 2 | ~~`relay_manager.rs` 改名 ~~ | ~~一行 `git mv` + 3 处引用，消掉一处命名撞车~~ | 无 |
| 3 | **发现**（唯一真正的双家） | 有非空转护栏（Presence 那条）、新旧边界清晰（`discovery/trait.rs` 已就位） | 需要真机验证广播行为（类似 `loopback_broadcast_works` 的做法） |
| 4 | 打开 `domains.yml` 里第一个 `enforce` | 上面某条收口完成后，才能"开一个" | 该领域边界成为事实 |
| 5 | TCP 数据面拆分（`network/transport.rs` 8836 行） | **最后**：最大、最活、改动风险最高 | 先回答"有几个独立变化原因"（行数不是判据） |
| 6 | `db::` 穿透传输层 | 13 个文件引用，横跨 network/transport/mesh —— 架构上最值得收口 | 需要先有 Application 层（或至少约定"传输层不得直接写库"） |

---

## 5. 维护规则

1. **改了某个关注点的"活路径"，必须同时更新本台账与 `domains.yml` 的 `active_home`** ——
   否则地图开始说谎。`scripts/check-domain-map.mjs` 能守住"路径存在/不重复/不遗漏"，
   但**守不住"哪个是活的"** —— 那一栏只能靠人诚实。
2. 新增关注点（或新增第二个家）时，先加一行台账再动手。
3. 迁移收口（删掉老家）时，把该行从"双家"改成"单家"，并删掉 `domains.yml` 里的
   `second_home` / `second_home_status`。
