# Gosslan — 稳定性与可靠性审计（STABILITY & RELIABILITY）

- **审计基线**：`0bc31fc0`（tag `v5.15.1`）工作区
- **审计范围**：`src-tauri/src/`（Rust 后端，约 106.5k 行）、`src/`（Vue 3 前端，约 54.7k 行）
- **方法**：全量静态阅读 + 结构化扫描（锁跨 `.await`、注册表插入/移除配对、panic 站点台账、INV-P34 分母判据）+ 定向探针（/tmp 下的 Python 探针，未改动 `src/` 与 `src-tauri/src/`）
- **不变量基线**：`docs/protocol-invariants.md`（INV-P01…P35）

> 说明：本文件只报**当前代码里仍然成立**的缺陷。已在本仓其它文档里记录并已修复的项
> （如 `chat_peer_styles` 只增不减、群文件 `sending` 态崩溃恢复、`file_outbox` 墓碑复活、
> `peer_manager` 身份不回收、`peers↔db` ABBA）**不重复计入**。

---

### STB-01 — 群文件分片的同步写盘跑在 tokio worker 上（INV-P34 违规，且与单聊路径不对称）
**Severity:** High
**Status:** Confirmed
**Location:** `src-tauri/src/network/transport/group_file.rs:2038-2100`（写盘在 `:2074`）；对照 `src-tauri/src/network/transport/handle_file.rs:360-384`
**What:** 群文件分片路径 `handle_group_file_chunk` 是 `async fn`，它在 **async 上下文里同步**做
`r.file.write_all(&plaintext)`（`group_file.rs:2074`），写的是**一整个分块**（LAN 上
`FILE_CHUNK = 256 KiB`，`protocol.rs:32`；BLE 上 `BLE_FILE_CHUNK = 4 KiB`）。
这一段还**持有 `state.group_file_receivers` 这把进程级锁**（`group_file.rs:2040-2043`）。

单聊（1:1）路径对**完全同形**的工作早就搬进了阻塞池，注释里写明了理由与症状
（`handle_file.rs:360-363`）：

```
// base64 解码 + AEAD 解密 + 增量 SHA-256 + 同步 `write_all`：整段离开 tokio worker
// （10-22 审计 R-01 的一半）。`reader_loop` 与各条链路的入站帧读取共用这批 worker，
// 慢盘上一个 256KB 分块的同步写就把这个 worker 按住 —— 表现是"传文件时整个界面一顿一顿"，
// 连开窗一类的 IPC 也会排队（同一条 runtime）。
```

**同一份代码里，群文件这一支只搬了「解码 + AEAD 解密」两步**（`group_file.rs:2015-2031`，
注释明说"**只搬这两步**"），把「seq/size 校验 + 增量哈希 + 写盘」留在了 async 路径上。

**Trigger scenario:**
1. 用户在群里收到一个 500 MB 的群文件。
2. 发送端按 `chunk_size_for_path` 切片（`commands/group_file_dispatch.rs:261`），LAN 上每片 256 KiB。
3. `handle_message` → `handle_group_messages` → `handle_group_file_chunk`（`handle_group.rs:188`）
   在 `reader_loop` 的 tokio worker 上**就地**执行。
4. 每片一次 `write_all(256 KiB)`。慢盘 / 网络盘 / Windows Defender 实时扫描下，单次 `write_all`
   轻易到几十毫秒。
5. 与此同时：本机唯一的 tokio runtime 上还排着**所有** async IPC 命令
   （`open_settings_window` / `open_log_window` / `get_messages`…）。
   ⇒ 用户看到「传群文件时点设置没窗、拖窗口没反应」。
6. 更糟的一格：写盘期间**持有 `group_file_receivers` 锁**。这把锁是**所有群文件传输共享**的
   ⇒ 同一时刻另一条群文件传输的分片也堵在这把锁上，**两条传输互相拖死**。
   单聊路径的同型问题在 `receive.rs:1278-1285` 已被明确写出并据此把收尾搬进池子。

**Evidence:**
```rust
// group_file.rs:2038-2074  —— async fn 内，持锁，同步写盘
    {
        use std::io::Write;
        let mut recv = state
            .group_file_receivers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(r) = recv.get_mut(&transfer_id) else { return; };
        ...
        r.hasher.update(&plaintext);
        let write_err = r.file.write_all(&plaintext).err();   // ← :2074 同步 256 KiB 写
```

**What I checked that does NOT prevent it:**
- ✅ `group_file.rs:2023` 确实把 base64 解码 + AEAD 解密搬进了 `spawn_blocking` —— 但那是**纯 CPU**，
  磁盘写仍在 worker 上。
- ✅ `commands/group_file_dispatch.rs:261` 的 `chunk_size_for_path` 确认 LAN 上就是 256 KiB（不是小片）。
- ✅ INV-P34 的分母判据（`lib_relay_data_tests.rs:445` 的 `PRIMITIVES`）**抓不到这一格**：
  清单里只有 `sha256_file_hex(` / `sync_all()` / `add_chunk(` / `resume_receive(` /
  `finish_receiver_into(` / `finish_group_receive_into(` / `move_received_file(` /
  `std::fs::copy(` / `std::fs::remove_dir_all(` / `clear_dir_contents(` ——
  **没有 `write_all(`**。这正是 INV-P34 台账第 13 行自己承认的盲区①
  「新增一类同步 helper 里藏着整份慢活 ⇒ 不在清单里就看不见」。
- ✅ `handle_file.rs:373` 的单聊路径确实在 `spawn_blocking` 内 ⇒ 说明这是**同一件事两份写法**，
  不是「群文件刻意不做慢活」的设计选择。

**Impact:** 群文件传输期间整个应用 UI 冻结（所有 async IPC 排队）；并发群文件互相阻塞；
最坏情况两两互锁式的停滞（不是死锁，是长期饥饿）。

**Confirmation:** 静态阅读 + 与单聊同形路径逐行对照。**未在真机复现**（需要慢盘 + 大文件）。
探针：`/tmp/stb_registry.py`（注册表配比扫描）显示 `group_file_receivers` 有 23 个引用点，
其中 `handle_group_file_chunk` 是唯一在 async 上下文中直接落盘的。

**Fix sketch:** 把「seq/size 校验 + 增量哈希 + 写盘」整段搬进 `spawn_blocking`（与单聊
`handle_file.rs:373` 同形），但**不要**在闭包里新取 `state.db` 锁（锁序 `group_file_receivers → db`
已有约束）；`spawn_blocking` 的 `Err` 必须落成 `Err` 走既有失败出口（INV-P34 台账第 4 条）。

**Regression test:** 在 `lib_relay_data_tests.rs` 的 `PRIMITIVES` 里加 `write_all(`，
并加一条按格点名的用例（形如
`tests::group_file_chunk_write_runs_off_the_async_worker`），
断言 `group_file.rs` 的写盘点在 `spawn_blocking(` 与其 `.await` 之间。

---

### STB-02 — `pending_requests` 是无界 Map，键与载荷都由不可信对端控制
**Severity:** Medium
**Status:** Confirmed
**Location:** `src-tauri/src/network/transport/handshake.rs:380-390`（插入）；
`src-tauri/src/network/transport/handshake.rs:424-428`（唯一按 peer 移除点）；
`src-tauri/src/commands/mobile_picker.rs:267-272`（唯一批量清理点）
**What:** `AppState::pending_requests: Mutex<HashMap<String, PendingRequest>>`（`state.rs:1262`）
在收到每一条好友申请时插入（`handshake.rs:387` `pending.insert(req.from.clone(), req.clone())`）。
它**只**在两种情况下减少：
1. 对方同意/拒绝 → `forget_pending_request`（`handshake.rs:424-428`）按 `peer_id` 移除**一条**；
2. 前端调用 `get_pending_requests` → `map.retain(|_, req| is_actionable_request(req, &friend_ids))`
   （`mobile_picker.rs:271`）——**只过滤掉「已经是好友」的条目**。

⇒ 一条**永远不被处理**的申请（用户不点、或对端从不回执）就**永久留在表里**。
键是 `req.from`（对端自报的 `device_id`），载荷是 `PendingRequest { from, from_nickname, from_avatar, ts }`
（`state.rs:342-347`）。

**Trigger scenario:**
1. 局域网内一个攻击者（或一台被攻陷的设备）用**不同的** `device_id` 连发 N 条
   `Message::FriendRequest`（直连路径 `handle_identity.rs:177-201`，或跨跳路径
   `gossip.rs:600-635`）。直连路径的 `from` 必须等于 `peer_id`（`handle_identity.rs:181`），
   所以攻击者需要每条用**不同的 TCP 连接 + 不同 device_id**；跨跳路径的
   `apply_friend_request`（`gossip.rs:629`）也把 `env.sender_id` 当键。
2. 每一份都在 `pending_requests` 里占一行，**永不删除**（用户不会去点那些申请）。
3. `from_avatar` 是 `Option<String>`，**接收侧没有尺寸闸**：
   - 直连路径 `handle_identity.rs:180` 直接把帧里的 `from_avatar` 塞进 `PendingRequest`；
   - 跨跳路径 `gossip.rs:602-604` 从解密后的 JSON 里取 `from_avatar`，同样无闸。
   发送侧有闸（`hello_avatar_for_wire`，`handshake.rs:669-671`，2048 字节），
   **但那是发送侧的自律，接收侧不检查**。帧上限是 `MAX_FRAME = 64 MiB`
   （`protocol.rs`，`transport/tcp.rs:52` 校验）⇒ 一条 64 MiB 的 `from_avatar`
   就能让内存表里多一行 64 MiB 的字符串。
4. 表只增不减 ⇒ 内存单调增长，直到进程重启。

**Evidence:**
```rust
// handshake.rs:380-390
    let prior = {
        let mut pending = state
            .pending_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending.insert(req.from.clone(), req.clone())   // ← 只增
    };
```
```rust
// mobile_picker.rs:267-272  —— 唯一的批量清理，只过滤「已是好友」
        let mut map = s
            .pending_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.retain(|_, req| is_actionable_request(req, &friend_ids));
```

**What I checked that does NOT prevent it:**
- ✅ 检索全仓，`pending_requests` 的**全部**移除点只有三处：
  `forget_pending_request`（按 peer 一条）、`get_pending_requests` 的 retain（只滤已是好友的）、
  `clear_all_data`（`commands/favorites.rs:575`，清全部数据时）。
  **没有任何 TTL、没有容量上限、没有按时间的清扫器**。
- ✅ `sweep_peers`（`network/discovery.rs:869`）会清 `peer_content_features` / `peer_versions` /
  `key_conflict_warned` / `peer_manager` 四张按 device_id 索引的表 ——
  **但 `pending_requests` 不在这张回收名单里**（`discovery.rs:918-950`）。
- ✅ `peers` 表本身有 45s 超时清扫（`should_keep_peer`，`discovery.rs:846`），
  所以攻击者的 device_id 不会长期留在 `peers` 里 —— 但**申请已经进了 `pending_requests`**，
  它跟 `peers` 的生命周期脱钩了。

**Impact:** 内存单调增长（一条申请 ≈ 键 + 昵称 + 可选头像）；最坏情况单条 64 MiB 载荷
⇒ OOM 级别的进程消失（release 是 `panic = "abort"`，OOM 同样是整进程死）。
这同时是一条**放大面**：一次 LAN 广播级的重复连接就能把对端进程撑爆。

**Confirmation:** 静态阅读 + 全仓检索移除点。未做运行时复现（需要一个能连上 TCP 的对端脚本）。

**Fix sketch:** 给 `pending_requests` 加**容量上限 + TTL**（例如上限 N 条、超过按插入序淘汰最旧的）；
`from_nickname` / `from_avatar` 在**接收侧**加尺寸闸（与 `HELLO_AVATAR_MAX_BYTES` 同一口径）。

**Regression test:** 单测「插入 M+1 条申请后表长不超过上限」；
另一条「入站 FriendRequest 的头像超过 `HELLO_AVATAR_MAX_BYTES` 时被丢弃/截断」。

---

### STB-03 — `file_receivers` 是进程级全局锁，每片写盘期间整表阻塞（跨传输互相拖累）
**Severity:** Medium
**Status:** Confirmed
**Location:** `src-tauri/src/network/file/receive.rs:984-990`（取锁）、`:1028`（持锁写盘）
**What:** 单聊文件分片的落盘由 `file::write_chunk` 完成，它在
`state.file_receivers` 这把**进程级 `std::sync::Mutex`** 下做
`r.file.write_all(&plaintext)`（`receive.rs:1028`，256 KiB/片）。
调用方已经把它搬进 `spawn_blocking`（`handle_file.rs:373`）—— **tokio worker 不再被钉住** ——
但**这把锁仍然是全局的**：一把锁罩住**所有**并发文件传输的接收器。

**Trigger scenario:**
1. 用户同时收 3 个大文件（对端各发一路，或同一条群文件扇出到多个成员）。
2. 三条传输的分片各自 `spawn_blocking` 进阻塞池，但都要抢**同一把** `file_receivers`。
3. 慢盘上单片 256 KiB 的 `write_all` 假设 30 ms ⇒ 三条传输的写盘在锁上**串行化**。
4. 三条传输的总吞吐 ≈ 单条传输的吞吐（不是 3×），且**每条的 `fed_at_ms` 推进都被拖慢**。
5. `fed_at_ms` 是接收停滞判据的唯一证据源（`receive.rs:1035` `r.fed_at_ms = now`）。
   ⇒ 排队久了，`take_stalled_receive`（`receive.rs:1170`）会把**其实还在正常收**的那一条
   判成"接收超时"（`sweep_stalled_receives`，`group_file.rs:903`），整单失败。

**Evidence:**
```rust
// receive.rs:984-990 / 1028
    let (received, cid, owner, report) = {
        let mut recv = state
            .file_receivers
            .lock()               // ← 全局锁，罩住所有传输
            .unwrap_or_else(|e| e.into_inner());
        ...
        r.file.write_all(&plaintext).map_err(|e| {   // ← :1028 持锁写盘
```

**What I checked that does NOT prevent it:**
- ✅ `handle_file.rs:373` 确实在 `spawn_blocking` 内 ⇒ tokio worker 不被钉（这一半已修）。
- ✅ `receive.rs:1274-1285` 的注释明确写出了**收尾**那一半的同型问题并据此把
  `finish_receiver_into` 搬进池子；但注释里那句「持锁期间**同一时刻其它并发文件的
  `write_chunk` 全部堵在同一把锁上** ⇒ 那些传输不再写出 ⇒ 发送端 60s 停滞判据把它们判死」
  ——**描述的正是本条**，而它只对 `finish` 那一半做了修，**`write_chunk` 这一半没动**。
- ✅ `handle_file.rs:368-369` 的注释自陈「`file_receivers` 那把进程级锁**仍在**
  （那是另一半：改它要动 59+27 个引用点…）」⇒ 这是**已知的、未修的另一半**，
  不是本审计新发现的形状。但它至今仍是一个可触发的用户可见故障（并发收多文件时进度条卡死、
  被误判超时），所以列出来。
- ✅ `sweep_stalled_receives` 判超时用的 `receive_is_stale` 阈值确实存在
  （`sweep_stalled_receives` → `take_stalled_receive`，`receive.rs:1170`），
  所以"排队拖慢 ⇒ 被误判"这条链是通的。

**Impact:** 并发收多个文件时吞吐塌陷、进度条卡住、严重时正在正常收的传输被误判超时失败。
这是**性能/活性**问题，不是数据损坏（分片序号与 SHA-256 校验都在）。

**Confirmation:** 静态阅读 + 与 `finish_receiver_into` 那条已修路径的对照。
未做运行时复现（需要慢盘 + 并发多文件）。

**Fix sketch:** 短���内可行的最小修法：在 `write_chunk` 里**先摘出写盘所需的一切、释放锁、再写** ——
但 `FileReceiver` 持有 `std::fs::File` 句柄，摘出来会与并发分片冲突。更实际的做法是
把 `file_receivers` 换成 `Mutex<HashMap<String, Arc<Mutex<FileReceiver>>>>`，
让**每个 transfer 一把锁**（同 transfer 内仍串行，跨 transfer 并行）；
这与 `handle_file.rs:368` 说的「要动 59+27 个引用点」是同一件事，属于结构性改造。

**Regression test:** 一条并发用例：两个 transfer 各写 N 片，断言二者的 `fed_at_ms`
推进不被对方阻塞（当前实现下第二条的推进会被第一条的写盘拖住）。

---

### STB-04 — Gossip 路径的去重登记早于「本机消费失败」，撤销只覆盖两类失败
**Severity:** Medium
**Status:** Needs verification
**Location:** `src-tauri/src/network/transport/gossip.rs:277`（MeshRouter 层去重登记）、
`:315`（GossipEngine 层去重登记）、`:404-411`（撤销点①）、`:1195-1198`（撤销点②）、
`:510-512`（早退点，无撤销）、`:826-855`（早退点，无撤销）
**What:** 本审计任务点名要核对的那一条：**Gossip 路径的去重登记发生在解密/消费之前**。
`handle_gossip` 的顺序是：

1. `gossip.verify_envelope(&env)`（`:265`，验签）
2. `router.on_receive(frame, …)`（`:277`，**MeshRouter 层去重登记**，`frame_id = env.message_id`）
3. `gossip.is_new(&env.message_id)`（`:315`，**GossipEngine 层去重登记**）
4. 解密（`:335-393`）
5. 消费与落库（`:510` 起）

第 2、3 步把 `env.message_id` 记进了**两张内存去重表**。**只有两个失败点会撤销这次登记**：

```rust
// gossip.rs:404-411  —— 撤销点①：解密失败
    if plaintext.is_none()
        && addressed_to_me
        && matches!(env.kind, GossipKind::Chat | GossipKind::Group)
        && group_consumable
    { allow_message_retry(state, &env.message_id, "no_plaintext"); }
```
```rust
// gossip.rs:1195-1198  —— 撤销点②：落库失败
                if let Err(e) = &inserted {
                    …
                    allow_message_retry(state, &env.message_id, "insert_failed");
                }
```

**本审计发现的缺口**：在第 3 步（去重登记）之后，有**两个「本机暂时消费不了、
但日后能消费」的早退点，没有对应的撤销**：

```rust
// gossip.rs:510-512  —— 非本群成员 ⇒ 跳过本地消费（**没有 allow_message_retry**）
    if !group_consumable {
        return;
    }
```
```rust
// gossip.rs:826-855  —— 非好友 ⇒ 广播拒绝通知后 return（**没有 allow_message_retry**）
                if env.kind == GossipKind::Chat {
                    let is_friend = { … db::get_friend(&dbc, &env.sender_id).is_some() };
                    if !is_friend {
                        …
                        broadcast_gossip(state, blocked_env).await;
                        return;
                    }
                }
```

这两条与「本机**永久**消费不了」**不等价**：
- 「不是本群成员」会随**本机收到 GroupKey / 成员变更**而变；
- 「不是好友」会随**用户点「同意」**而变。

而 `allow_message_retry` 的语义（`gossip.rs:102-107` 的注释）明写
「上一次同一 id **没消费成功** ⇒ 放行一次」—— 这两条正是「没消费成功」的一种，
却不在撤销点①的四个合取项里（`:405` 的 `plaintext.is_none()` 为假 ⇒ 不触发；
`group_consumable` 为假 ⇒ 也不触发）。

**关键的形态差别（决定这条是否真的伤到用户）**：补发走哪条接收路径，取决于
**outbox 里存的线格式**：

| 消息种类 | outbox 存的载荷 | 补发走的接收路径 | 补发是否受这两张内存去重表约束 |
|---|---|---|---|
| 1:1 单聊 | `Message::ChatMessage`（`commands/chat.rs:781-791`） | `handle_messaging.rs:41` 的直连臂 | **否** —— 直连臂的去重判据是 `db::message_exists`（`:70`，**数据库判据**），库里没这行 ⇒ 不判重 ⇒ 补发**能恢复** |
| 群消息 | `Message::Gossip { envelope }`（`commands/window.rs:303-306`） | `handle_gossip` | **是** —— 补发的就是**同一个 `message_id`** 的信封 ⇒ 被 `:315` 的 `is_new` 判成 Duplicate ⇒ **永久堵死** |

⇒ **本条实际影响的是群消息**（以及任何以 Gossip 信封形态落 outbox 的路径）。

**Trigger scenario（群消息版）：**
1. A、B 在群 G 里，但 B **尚未收到 GroupKey**（或 B 刚被拉进群、成员表还没同步）。
2. A 发一条群消息 M（`commands/window.rs:259-280` 构造信封，`env.group_members` 是 A 侧的成员表）。
3. B 收到 M：`handle_gossip` 的第 2、3 步把 `M` 记进 B 的两张去重表。
   第 4 步解密：`GossipKind::Group` 用群密钥解密（`gossip.rs:350-357`），
   B 没有群密钥 ⇒ `plaintext = None`。
4. 撤销点①的四个合取项：`plaintext.is_none()` ✅、`addressed_to_me` ✅、
   `matches!(kind, Chat|Group)` ✅、但 **`group_consumable` ❌**
   —— `group_envelope_consumable`（`gossip.rs:391`）判的是「本机在**信封自带的成员表**里」
   （`gossip.rs:87-99`）。B 刚被拉进群、A 侧信封里的成员表**还没有 B**
   ⇒ `group_consumable = false` ⇒ **撤销点①不触发** ⇒ 去重登记留在表里。
   （若 B 已在 A 侧成员表里，则 `group_consumable = true` ⇒ 撤销点①触发 ⇒ 这一格是好的。）
5. 接着 `:510` 的 `if !group_consumable { return; }` 让 B 不消费这条消息（正确 ——
   B 现在还解不开群密钥）。
6. B 随后收到 GroupKey、成员表同步完成。**A 侧 outbox 仍留着 M**
   （没收到 GroupAck ⇒ `db::ack_group_delivered` 没跑 ⇒ `group_outbox` 行还在）。
7. A 侧下一次建链/心跳触发 `flush_group_outbox`（`network/transport/outbox_flush.rs:62`）
   **补发同一枚 `message_id` 的信封**。
8. B 侧 `gossip.is_new(&env.message_id)`（`:315`）命中 `seen`/bloom ⇒ 返回 false
   ⇒ `return`（`:316`）⇒ **这条群消息永远不落库、也永远不回 GroupAck**。
9. A 侧永远停在「N 人待收」，直到群 outbox 清扫器 30 分钟后判 failed
   （`db/group_offline_queue.rs:32` `GROUP_OUTBOX_FAIL_DEADLINE_MS = 30 * 60 * 1000`）。

**Evidence:**
```rust
// gossip.rs:315-317  —— 补发被这一行判死
        let mut gossip = state.gossip.lock().unwrap_or_else(|e| e.into_inner());
        if !gossip.is_new(&env.message_id) {
            return;
        }
```
```rust
// gossip.rs:404-411  —— 撤销点①的四个合取项
    if plaintext.is_none()
        && addressed_to_me
        && matches!(env.kind, GossipKind::Chat | GossipKind::Group)
        && group_consumable          // ← 这一项在「本机不在信封成员表里」时为假
```

**What I checked that does NOT prevent it:**
- ✅ 查了撤销点②（`insert_failed`，`:1195`）—— 那是**落库**失败，
  与本条的两个早退点不在同一条路径上（早退发生在落库之前）。
- ✅ 查了 `gossip.rs:514-525`（`GossipKind::FriendMessageBlocked` 的消费臂）——
  它只是 emit 一个事件（`:521`），**不改任何去重表** ⇒ 撤销不存在。
- ✅ 查了**直连**路径（`handle_messaging.rs:41` 的 `Message::ChatMessage` 臂）：
  它的去重判据是 `db::message_exists`（`:70`）—— **数据库判据，不是内存去重表**。
  ⇒ 1:1 单聊的「先拒收、后加好友、再补发」是**能恢复**的。
  **本条只影响以 Gossip 信封落 outbox 的路径（群消息）。**
- ✅ 查了 `allow_message_retry` 撤销的两张表是否对称（`gossip.rs:109-127`）：
  `mesh_router.allow_retry` 与 `gossip.allow_retry` 都写 ⇒ 撤销机制本身有效，
  缺的是**触发点**。
- ✅ 查了 `LruSet::allow_retry` 是一次性的（`gossip_engine.rs:154` `allow_retry.remove(message_id)`
  消费掉标记）⇒ 补发**只放行一次**；第二次补发仍被挡。
- ✅ 查了 `group_outbox` 行的删除条件（`db/group_offline_queue.rs:49` `ack_group_delivered`
  的事务）—— 只有 GroupAck 才删 ⇒ 拒收时行确实保留。
- ✅ 查了 `group_envelope_consumable` 的成员表来源（`gossip.rs:87-99`）——
  它读的是**信封自带的 `env.group_members`**，不是本机的 `groups` 表
  ⇒ 「B 已在 A 侧成员表里」与「B 知道自己在这个群」是**两个独立的条件**，
  两者不一致的窗口就是本条的触发窗口。

**Impact:** 「被拉进群 shortly before / 群密钥尚未到达的那段时间里发的群消息，
即使后来条件齐了也永远补不回来，且发送方永远显示「N 人待收」（直到 30 分钟判 failed）」。
这是 INV-P04「Outbox Is Reliability Boundary」与 INV-P06「Retry Must Be Idempotent」
之间的一条裂缝：系统保留了队列行、也确实会补发，但接收侧的内存去重表
把这份补发判成了重复。

**Confirmation:** 静态阅读，代码路径闭合。**未做端到端复现** —— 复现需要构造
「群信封的成员表里没有本机、但本机随后拿到群密钥并成为成员」的时序
（B 收 GroupKey 与 A 侧成员表更新之间的窗口）。
标 **Needs verification** 的原因：需要确认「A 侧 `group_outbox` 行在 B 拒收后仍保留」
（已由 `ack_group_delivered` 的事务语义推出，但未运行时确认），
以及「B 侧 `group_consumable` 在补发时仍为假」这一条件在补发那一刻是否仍成立
（若 A 在这段时间内又发过一条成员表含 B 的群消息，B 侧成员表可能已被更新 ⇒ 窗口关闭）。

**Fix sketch:** 把「本机未消费成功」的原因枚举成 `NotReady` / `Permanent` 两类，
`NotReady`（缺群密钥 / 不是好友 / 落库失败）撤销去重，`Permanent`
（内容超限 / 群目标缺失 / 已被删除边界挡住）不撤销。
具体到本条：在 `gossip.rs:510` 的 `!group_consumable` 早退处，
若 `plaintext.is_none()`（**本机解不开** ⇒ 日后可能解得开），
则调用 `allow_message_retry(state, &env.message_id, "not_ready")`。
注意 `allow_retry` 是一次性放行：补发一次后若仍解不开会再次登记，与预期一致。

**Regression test:** 一条纯函数判据（把「本机未消费成功」的原因枚举成
`NotReady` / `Permanent` 两类，断言只有 `NotReady` 撤销去重），
再加一条源码形状断言：`gossip.rs` 的 `!group_consumable` 早退那一支
必须出现 `allow_message_retry`（且以 `plaintext.is_none()` 为条件）。

### STB-05 — 同一条 1:1 消息在「直发」与「补发」时用两种线格式，各走一套去重判据
**Severity:** Low
**Status:** Confirmed
**Location:** `src-tauri/src/commands/chat.rs:781-791`（outbox 存 `Message::ChatMessage`）、
`:827-828`（直发用 `Message::Gossip { envelope }`）；
`src-tauri/src/network/transport/outbox_flush.rs:29-43`（补发按 outbox 里存的形态发）
**What:** `send_message` 把**两条形态不同**的帧写进了同一个业务 `msg_id`：

- **outbox 行**里存的是 `Message::ChatMessage`（`chat.rs:781-791`），
  `content` 是 `enc1:` 前缀的密文（裸正文密封）；
- **直发**用的是 `Message::Gossip { envelope }`（`chat.rs:827-828`），
  载荷是 `gossip_plaintext(kind, content, …)` 密封的 JSON。

补发路径 `flush_outbox` 从 outbox 读出**存的形态**再发（`outbox_flush.rs:29-43`），
于是同一条消息可能以两种线格式抵达对端：

| 到达形态 | 接收臂 | 去重判据 | 落库的 `kind` 来源 |
|---|---|---|---|
| `Message::Gossip`（直发） | `gossip.rs:783` `parse_gossip_plaintext` | **内存** `GossipEngine::is_new` / `MeshRouter::on_receive` | 信封载荷里的 `kind` 字段 |
| `Message::ChatMessage`（补发） | `handle_messaging.rs:41` | **数据库** `db::message_exists`（`:70`） | 帧上的 `kind` 字段（`open_direct_content` 原样透传） |

两套判据**都能保证不重复落库**（`db/messages.rs:28` `insert_message_if_new` 的
`WHERE NOT EXISTS` 是最终那道闸），所以**功能上幂等成立**。

**What is the actual defect:** 「同一业务消息有两种线格式 + 两套去重判据」意味着
**接收侧的行为依赖于「哪一份先到」**。特别是：Gossip 形态先到并成功落库后，
补发形态到达时走 `handle_messaging.rs:70` 的 `message_exists` 分支（`:73-84`）——
那一支**只回 Ack、不 emit `message-received`**（INV-P02「Notification 不重复」的要求）。
⇒ 落库的 `kind` 取的是**先到者**的解析结果。

**Trigger scenario:**
1. A 发消息 M（`kind = "reaction"`，一种 `is_non_notifying_kind` 的静默事件）。
2. 直发的 Gossip 形态先到 B ⇒ B 落库，`kind = "reaction"`。
3. 补发的 `Message::ChatMessage` 形态后到 B ⇒ 走 `message_exists` 分支 ⇒ 只回 Ack。
4. 若某次重装/降级导致**顺序反过来**（补发形态先到、Gossip 形态后到），
   落库的 `kind` 就取 `ChatMessage` 帧上的 `kind` 字段。
   两者今天都源自同一个 `msg_kind.as_str()`（`chat.rs:787`），所以**今天一致**；
   但**没有任何判据钉住这一点** —— 两条解析路径（`gossip.rs:783` 与
   `handle_messaging.rs:120`）是**两份独立实现**，各自归一化 `kind`。

**Evidence:**
```rust
// chat.rs:781-791  —— outbox 存的是 ChatMessage（enc1: 密文）
    let queued = Message::ChatMessage {
        msg_id: msg_id.clone(),
        …
        content: wire_content,     // ← "enc1:…"
        …
    };
    let payload = serde_json::to_string(&queued).map_err(|e| e.to_string())?;
```
```rust
// chat.rs:827-828  —— 但直发的是 Gossip 信封（gossip_plaintext 密文）
    if has {
        let r = try_send(s, &friend_id, &Message::Gossip { envelope: env.clone() })
```

**What I checked that does NOT prevent it:**
- ✅ 查了 `db/messages.rs:28` `insert_message_if_new` —— 最终幂等闸在库里，两种形态都过它
  ⇒ **不重复落库成立**。
- ✅ 查了 `handle_messaging.rs:70-84` 的重复分支 —— 只回 Ack、不重复通知（INV-P02 正确）。
- ✅ 查了 `gossip.rs:1236-1264` 的单聊 ChatAck 与 `handle_messaging.rs:216` 的直连 Ack ——
  两者都汇到 `db::ack_delivered`（`db/messages.rs:841`）的**同一个事务**
  ⇒ **Ack 幂等成立**。
- ⚠️ 但**没有任何判据**保证「Gossip 形态解析出的 `kind`」与
  「ChatMessage 形态解析出的 `kind`」相等 —— 两条解析路径是两份独立实现。
  `protocol::display_kind`（`db/messages.rs:118` 那一列）是公共出口，
  但**入参**（解析结果）由两条路各自产生。

**Impact:** 低。当前两条路径对 `kind` 的处理实测一致（同源于 `msg_kind.as_str()`），
所以今天**看不到用户可见症状**。但这是**一条没有判据保护的双写路径** ——
将来任一侧改 `kind` 归一化（例如新增一种静默 kind 只改一侧），
就会出现「同一条消息在两端显示的类型不同」，且**按到达顺序决定**，
现场极难归因。

**Confirmation:** 静态阅读两条解析路径 + `db/messages.rs:841` 的事务。
未做运行时复现（今天两条路径本就等价）。

**Fix sketch:** 中期把「`msg_id` → 线格式」收成一个家（发送侧只产一种格式，
outbox 存的就是发出去的那一种），或至少给两条解析路径加一条
「同一 `msg_id` 两种格式解析出的 `(kind, content)` 必须相等」的判据。

**Regression test:** 一条纯函数用例：给定同一个 `msg_id`，
`parse_gossip_plaintext(gossip_bytes)` 与 `open_direct_content(direct_bytes)`
产出的 `(kind, content)` 必须相等。

### STB-06 — `group_history_active` / `group_history_cancels` 的 RAII 守卫在「同步体 panic」时能归还，但 `spawn_sync` 的返回值让调用方无法区分「已在飞」与「本机没这个群」
**Severity:** Low
**Status:** Needs verification
**Location:** `src-tauri/src/network/group_history.rs:939-961`（`spawn_sync`）
**What:** `spawn_sync` 用 `group_history_active` 做在飞闸，用 RAII 守卫
`GroupHistoryActiveGuard`（`:906-924`）归还。这一半写得对（注释明确说修过
「同步体 panic ⇒ 永久在飞」的 P3-04）。

剩下的窄处：`spawn_sync` 返回 `bool`，`false` 表示「已在飞」。
但**在飞的那一趟**与「没跑过」在返回给调用方时**无法区分**，
而调用方（`handle_identity.rs` 的 Hello 分支、群消息顺带建群那一路、清扫任务）
把 `false` 当作「不用管」。若那一趟**随后因为取消而提前结束**
（`take_group_history_cancel`，`:835`），而**新的那一趟**恰好在守卫归还**之前**被调用
⇒ 那一趟也被判「已在飞」⇒ 该群**这一轮不同步**。

**Trigger scenario:**
1. 群 G 的历史同步在飞（`group_history_active` 含 G）。
2. 用户点「停止同步」⇒ `request_cancel`（`:884`）点亮 `group_history_cancels`。
3. 同步体在**当前页处理完后**才检查取消标志 ⇒ 从点亮到归还之间有一个窗口
   （窗口长度 = 一页的传输时间，上限 `GROUP_HISTORY_PAGE_TIMEOUT_MS = 20s`，
   `group_history.rs:51`）。
4. 在这个窗口里，某个事件（Hello / 群消息 / 清扫任务）调用 `spawn_sync(G)` ⇒ 返回 `false`
   ⇒ 该事件**不排新的一趟**。
5. 那一趟随后被取消并归还 ⇒ **G 的历史同步在这一轮就没了**，要等下一个触发点。

**Evidence:**
```rust
// group_history.rs:939-947
pub fn spawn_sync(state: &Arc<AppState>, group_id: &str) -> bool {
    if !state
        .group_history_active
        .lock()...
        .insert(group_id.to_string())
    {
        return false;      // ← 「已在飞」与「刚被取消」无法区分
    }
```

**What I checked that does NOT prevent it:**
- ✅ `GroupHistoryActiveGuard`（`:906-924`）的 `Drop` 确实在正常结束 / 提前 return /
  panic 展开三种出口都归还了 `group_history_active` 与 `group_history_cancels`。
- ✅ `release_group_history_active`（`:824`）是唯一的移除家。
- ✅ 取消标志的**消费**（`take_group_history_cancel`，`:833`）是「一页之间只认一次」。
- ⚠️ 但**没有任何机制**在「取消已点亮、当前那一趟还没结束」的窗口里让新的 `spawn_sync`
  排上队。`spawn_sync` 只看 `group_history_active`，不看 `group_history_cancels`。

**Impact:** 低。用户可见现象是「我刚点了停止同步，聊天窗口又触发了一轮历史同步」
或「这一轮历史没同步上，要等下一个触发点」。不丢数据（下一轮会补上）。

**Confirmation:** 静态阅读。**未复现** —— 窗口宽度取决于实际页传输时间，
本地快速场景下可能只有几毫秒。

**Fix sketch:** `spawn_sync` 在「已在飞」时，若 `group_history_cancels` 里**有**该群
（说明当前那一趟已被要求停止），则**取消当前那一趟并排新的一趟**；
或者给在飞表加一个「已被请求取消」的标记，让 `spawn_sync` 能区分两种 `false`。

**Regression test:** 纯函数判据（`decide_spawn`）覆盖三种在飞态：
普通在飞 / 已请求取消 / 无 ⇒ 断言「已请求取消」时排新的一趟。

---

### STB-07 — `gossip_relay` 补递缓存的 TTL 与 `gossip_replay` 的窗口语义耦合，但两处 TTL 常量不同源
**Severity:** Low
**Status:** Needs verification
**Location:** `src-tauri/src/network/transport/gossip.rs:463-476`（写入）、
`src-tauri/src/mesh/gossip_replay.rs`（TTL 与窗口）
**What:** `handle_gossip` 在转发前把**准备转发出去的原样信封**记进
`state.gossip_relay`（`gossip.rs:463-476`），供「窗口内新建成链路的成员由
`replay_group_frames_to` 补递一次」。
`GossipRelayCache` 自己有 TTL（`mesh/gossip_replay.rs`），而
`RELAY_WINDOW_MS` 是另一个常量。

**Trigger scenario:** 若 `GossipRelayCache` 的 TTL 比 `RELAY_WINDOW_MS` 短，
则「窗口内新连上的成员」补递不到某些帧；反之则缓存里留着没人补的帧直到 TTL 到期。
两者不共用同一个来源 ⇒ 调整其中一个不会带动另一个。

**What I checked that does NOT prevent it:**
- ✅ `gossip.rs:465-470` 的注释明确说「记在这里、**在 `targets` 之后**是刻意的」，
  说明这一格的顺序语义是有意的。
- ✅ 我**没有**确认这两个常量的具体数值关系 —— 需要读 `mesh/gossip_replay.rs` 的
  `RELAY_WINDOW_MS` 与 TTL 定义才能判断是否真的不一致。
  因此标 **Needs verification**，不作为确定缺陷。

**Impact:** 若确实不一致：低 —— 补递漏一个成员（该成员靠下一次消息补齐）或
缓存多留一阵（内存，TTL 有界）。

**Confirmation:** 部分（只确认了写入点与注释声称的语义，未确认常量关系）。

**Fix sketch:** 两个 TTL 共用一个来源常量。

**Regression test:** 断言 `GossipRelayCache` 的 TTL ≥ `RELAY_WINDOW_MS`。

---

### STB-08 — `outbox_sweep` 的 `reachable` 快照在 peers 锁内 clone 全表，且每 30s 一次
**Severity:** Informational
**Status:** Confirmed
**Location:** `src-tauri/src/network/transport/outbox_sweep.rs:113-133`
**What:** 每一轮清扫（30s）都会 `state.links.lock().await` 后 clone 全部 peer id，
再 `state.peers.lock()` 后**逐个**判断 `outbox_peer_reachable` 并插入 `HashSet`。
两个锁都是 `std::sync::Mutex`（`peers`）/ `tokio::sync::Mutex`（`links`）。

**Evidence:**
```rust
// outbox_sweep.rs:119-133
            let reachable: std::collections::HashSet<String> = {
                let links = state.links.lock().await;
                let mut set = … links.iter().filter(…).map(…).collect();
                drop(links);
                let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
                for (device_id, peer) in peers.iter() { … }
                set
            };
```

**What I checked that does NOT prevent it:**
- ✅ 锁在 clone 后立刻 `drop(links)`（`:126`）⇒ 不持锁跨后续的 db 读。
- ✅ `peers` 锁在 `for` 循环里持有，但循环体只读 `peer.last_seen`（一个 `i64`），
  **没有在锁内调 db 或 await** ⇒ 持锁时间 = O(peers 数) 的纯内存循环。
- ✅ `peers` 表本身有 45s 超时清扫（`discovery.rs:869`）⇒ 表规模由 45s 窗口内的节点数界定。

**Impact:** Informational。500 节点规模下这一轮持 `peers` 锁几毫秒。
**不构成缺陷** —— 记录在此只是为了说明「已检查、判为安全」。

**Confirmation:** 静态阅读 + 锁序扫描（`/tmp/stb_scan_abba.py` 未报 `peers→db` 嵌套）。

---

## 已检查且判为安全（不列为缺陷）

| 类别 | 检查对象 | 结论 |
|---|---|---|
| 锁序 / ABBA | `peers` ↔ `db`（`check-lock-scope.mjs` 的 E 类已覆盖） | 全仓 0 处跨锁嵌套；`upsert_peer`（`peer_registry.rs:127-160`）先取 `peers` 快照、放锁、再取 db |
| 锁序 / ABBA | `file_receivers` → `db` | `write_chunk`（`receive.rs:982-1060`）注释明写「释放 file_receivers 锁之后才动 db」，全段成立 |
| 锁跨 `.await` | 全仓 `tokio::sync::Mutex` guard 绑定后同块内 `.await` | 机器扫（`/tmp/stb_scan_tokio.py`）得 4 处候选，逐个核对：**3 处是块作用域误报**（guard 在块尾释放），1 处是 `BT_SWITCH_LOCK`（`channel.rs:213`）—— 那是**有意的串行闸**，且 `ble::start/stop` 内部不再取同一把锁（已检索确认）⇒ 无死锁 |
| 锁跨 `.await` | `std::sync::Mutex` guard 跨 `.await` | 编译器层面不可能（`MutexGuard: !Send`，`async fn` 的 future 因此 `!Send`，而这些 future 都要 `tokio::spawn`）⇒ 全仓 0 处 |
| 阻塞 async（INV-P34） | `sha256_file_hex` / `sync_all` / `resume_receive` / `finish_receiver_into` / `finish_group_receive_into` / `move_received_file` / `std::fs::copy` / `remove_dir_all` / `clear_dir_contents` | 12 处家清单全部在 `spawn_blocking` 内（`lib_relay_data_tests.rs:467-481` 的 `registered` 清单 + `:445` 的 `PRIMITIVES` 判据实跑通过） |
| 阻塞 async（INV-P34） | `write_all(` / `File::create` / `std::fs::read` | **不在 `PRIMITIVES` 清单里 ⇒ 判据看不见**。逐个核对：`write_chunk`（单聊）已在 `spawn_blocking`；**`handle_group_file_chunk`（群）不在 ⇒ STB-01**；`make_receiver` 的 `File::create`（`receive.rs:856`）是**一次**系统调用（不是 GB 级慢活，落在 INV-P34a 的豁免口径内） |
| 阻塞 async（INV-P34） | `commands/helpers.rs:313` `std::fs::read` 的预览读 | 有 15 MiB 上限（`max_bytes.min(15 * 1024 * 1024)`），且在 `spawn_blocking` 内 ⇒ 合规 |
| 无界增长 | `peers` | 45s 超时清扫（`discovery.rs:846` `should_keep_peer`） |
| 无界增长 | `peer_content_features` / `peer_versions` / `key_conflict_warned` | 同一个清扫点连带清（`discovery.rs:918-950`） |
| 无界增长 | `peer_manager` 身份 | `should_forget_peer_identity`（`discovery.rs:859`）只忘非好友；好友只由「删好友」清 |
| 无界增长 | `relay_file_keys` / `relay.reassemblies` | 1h TTL 清扫（`transport.rs:68` `sweep_stale_relay`），且由 `lib.rs:648` 的小时级循环驱动 |
| 无界增长 | `group_file_keys` / `group_file_rounds` / `group_file_online_targets` | 30s 清扫（`outbox_sweep.rs:108` → `group_file.rs:1486` `sweep_stale_group_file_keys`），轮次表按「还有密钥」回收（`group_file.rs:1505-1517`） |
| 无界增长 | `file_receivers` / `group_file_receivers` | 停滞清扫（`group_file.rs:903` `sweep_stalled_receives`，由 `lib.rs:658` 驱动）+ 断链回收 |
| 无界增长 | `seen_hello_nonces` | 有界 FIFO 512（`state.rs:2470-2483`） |
| 无界增长 | `gossip` / `mesh_router` 的 `seen` + bloom | `LruSet` 有界（10_000）+ Bloom 有界（100_000，满了整块轮换，`gossip_engine.rs:57-60`） |
| 无界增长 | `gossip_relay` | 有界 TTL 缓存（`mesh/gossip_replay.rs`） |
| 无界增长 | `file_wire_progress` | `WireLedger` 的 `Drop` 回收（`send.rs:352-357`） |
| 无界增长 | `pending_file_accept` / `pending_file_complete` / `file_send_cancels` | `PendingCompleteGuard` / `CancelSlotGuard` 的 `Drop` 回收（`send.rs:367-395`、`file.rs:163-181`） |
| 无界增长 | `chat_peer_styles` | 已有删除点（`db/settings.rs:85` 删好友时摘除）—— 2026-10-23 审计 P2-B 已修 |
| 无界增长 | `file_outbox` 的 `sending` 态 | 启动时 `reset_sending_to_pending`（`db/file_offline.rs:159`）复位，且带墓碑保护（`cancel_terminal = 1` 不复活） |
| 无界增长 | `group_recalled_messages` | G-Set **刻意**只增不减（`db.rs:809`），是撤回的权威真源 —— 设计取舍，非缺陷 |
| 无界增长 | `pending_reads` / `pending_group_keys` / `pending_out_requests` / `pending_out_accepts` | 键是 peer id（受 `peers` 45s 清扫约束）或 group id，且各有 flush/删除点 |
| 无限循环 | `wait_complete_ack`（`send.rs:771-800`） | 以「链路上有没有分块真的写出」为续等条件，有 30s 静默窗口上限 ⇒ 必然终止 |
| 无限循环 | `sweep_stalled_receives` 的两个 `while let`（`group_file.rs:911-919`） | 每次循环体真的 `remove` 一条 ⇒ 必然终止（注释也明写） |
| 无限循环 | `send_on_link_with_tick`（`outbound.rs:409-425`） | `on_tick` 返回 `Abort` 即退出；调用点的 `stall_tick` 在 60s 静默后必 `Abort`（`file.rs:467`） |
| 无限循环 | `spawn_outbox_retrier` / `spawn_peer_emitter` / `spawn_runtime_diag_reporter` | 都是 `loop { sleep/interval; … }` 的常驻后台任务，有明确周期 |
| 无限循环 | `probe_candidates` 的 `tokio::spawn` 扇出 | 每个 `ask` 有 `timeout`（`group_history.rs:250`）⇒ 每个任务有界 |
| 重试无背���封顶 | `content::store::record_failure` | `attempts` 单调递增 + `MAX_CONTENT_RETRIES` 封顶转 `Rejected` ⇒ 闭合 |
| 重试无退避封顶 | `file_outbox` | `attempts < MAX_FILE_OUTBOX_RETRIES`（`db/file_offline.rs:28`）+ `next_attempt_at` 退避 |
| 失败处理 | 生产代码的 `panic!` / `unwrap()` / `expect()` | `check-panic-sites.mjs` 棘轮通过（本仓 panic 4 / expect 21 / unwrap 6，均未超基线）；生产路径上的 `expect` 只在 `android_open.rs`（JNI 一次性初始化，注释明写「ready() 已确认类引用存在」）与 `commands/group_file_keys.rs:71`（`src.unwrap()` 前一行已用 `ok` 判过 `src` 必为 `Some`，逻辑上不可达 `None`） |
| 失败处理 | `.ok()` 丢弃写库错误 | 逐个核对持久化路径：`upsert_transfer` / `set_message_status` / `finalize_*` / `cancel_*` 的失败都有 `logger.error` + 明确降级语义（多数处注释明写「不改变行为，只补留痕」） |
| 失败处理 | `let _ = db::…` 吞错 | 全仓检索后逐个核对：命中处均在**有替代终态出口**的位置（如 `fail_group_file_chunk` / `finalize_failed_group_receive` 之后），且伴随 `logger.error` |
| 竞态 | outbox flush 与 send 并发 | 接收侧靠 `msg_id` 幂等（`db/messages.rs:28`）+ Ack 收尾在一个事务里（`db/messages.rs:841`）⇒ 幂等成立（细节见 STB-05） |
| 竞态 | TOCTOU（文件系统） | `make_receiver` 的 `.part` 按 `transfer_id` 命名且 `File::create` 截断（`receive.rs:850-856`），重复 Offer 走「先 remove 旧的再 create」（`:838-846`）⇒ 不混写；`unique_path` 保证 final 不覆盖（`share_walk.rs:262`） |
| 竞态 | 取消与发送 | `install_cancel_slot` 在**哈希之前**登记（`send.rs:60`）⇒ 用户在慢活期间点的取消不会静默丢；`CancelSlotGuard` 的 `Drop` 覆盖所有出口（`file.rs:163-181`）；取消槽位按 `(transfer_id, recipient)` 分键（`file.rs:154`）⇒ 群文件 N 个成员互不顶掉 |
| 取消与发送 | `set_message_status` 不会把 `cancelled` 改回 `sent` | `db/messages.rs:699-706` 的 `WHERE status NOT IN ('read','delivered','recalled','cancelled','partial_cancelled','failed')` 明确排除 |
| 取消与发送 | 用户取消后不会被补发 | `cancel_queued_message` 在**同一事务**里删 outbox 行 + 写 `cancelled`（`db/messages.rs:751-780`）；`mark_file_outbox_sending` 带 `WHERE status='pending'` 守卫（`db/file_offline.rs:49`）⇒ 取消后不会被捞起来重发 |
| 前端生命周期 | `App.vue` 的两个定时器 | `startWatchdogTimers` / `stopWatchdogTimers`（`App.vue:57-80`）+ `onUnmounted(stopWatchdogTimers)`（`:209`）⇒ 对称 |
| 前端生命周期 | `useMessageFile` 的进度观察定时器 | `watch` 里 `next === null` 时 `stopProgressWatch()`（`useMessageFile.ts:103-108`）+ `onScopeDispose(stopProgressWatch)`（`:128`）⇒ 对称 |
| 前端生命周期 | `ChatWindow` 的群历史观察定时器 | `onScopeDispose(stopHistoryWatch)`（`ChatWindow.vue:410`）⇒ 对称 |
| 前端生命周期 | `useChatStore` 的事件监听 | `chatInitScope?.dispose()` 先拆上一轮再注册这一轮（`useChatStore.ts:2959-2961`）；`scope.onDispose` 清 `markReadTimer` / `notifyTimer` / `transfersRepairTimer`（`:2989-3001`）；`visibilitychange` 用具名函数 + 成对 `removeEventListener`（`:3347-3348`） |
| 前端生命周期 | `objectURL` | 造 URL 的三处（`MergeCardModal.vue:123,162`、`ProfileSection.vue:173`）都有对应 `revokeObjectURL`；`TodoImageThumb.vue:13` **刻意不 revoke**（有注释说明，避免打断其它视图的同一张图） |
| 前端生命周期 | `IntersectionObserver` / `ResizeObserver` | `VirtualList.vue:822` / `:854` 与 `MessageItem.vue:1090` 都有 `disconnect()` |

---

## 严重度分布

| 严重度 | 条数 | 编号 |
|---|---|---|
| Critical | 0 | — |
| High | 1 | STB-01 |
| Medium | 3 | STB-02, STB-03, STB-04 |
| Low | 3 | STB-05, STB-06, STB-07 |
| Informational | 1 | STB-08 |

**Confirmed / Needs verification 分布：** Confirmed 5 条（STB-01、STB-02、STB-03、STB-05、STB-08），
Needs verification 3 条（STB-04、STB-06、STB-07）。

**最需要先动的一条：** STB-01（群文件写盘钉住 tokio worker + 持全局锁）——
它有明确的**同仓先例**（单聊路径的同一段工作已经搬进 `spawn_blocking`，
注释里写明了症状「传文件时整个界面一顿一顿」），且修法是**照抄同仓既有写法**。

**最容易被误判成「不是缺陷」的一条：** STB-03（`file_receivers` 全局锁）——
`handle_file.rs:368-369` 的注释自陈「那把进程级锁**仍在**」，
容易被读成「已知且接受」。但它描述的是**收尾**那一半的修法，
**写盘**那一半（`receive.rs:1028`）至今仍在锁内 ⇒ 并发收多个文件时吞吐塌陷
且正在正常收的传输可能被误判超时（阈值 `FILE_RECEIVE_IDLE_ABORT_MS = 5min`，
`network/file.rs:322`）。
