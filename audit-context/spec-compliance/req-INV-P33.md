## REQ-INV-P33 — 重复到达的好友申请 / 好友同意，同一进程内不许重复弹系统通知

> "| # | 规则 | 今天靠什么成立（去重键与通知边界，逐个指到实物） |
> | 1 | 申请：系统通知只许由"本机第一次握着这条申请"点亮 | 键 = `pending_requests.insert(from)` 返回的**旧值**（`network/transport/handshake.rs:364`，`None`=第一次）；判定经纯函数出口 `friend_request_arrival_decision`（`:339`，调用点 `:374`）；通知只在 `Notify` 那一支（`:387` 的 `show_click_if_enabled`）。直连与跨跳两个到达点共用这一个家（`network/transport/handle_identity.rs:188` / `network/transport/gossip.rs:501`） |
> | 2 | 同意：系统通知只许由"这一次真的从不是好友变成好友"点亮 | 键 = **持久**好友表：`db::get_friend(..).is_some()` 在 `add_friend` **之前**取值（`network/transport/handshake.rs:292`–`301` 的 `was_friend`），门控在 `:307`，通知在 `:314`；两个到达点同样共用这一个家 |
> | 3 | 首次判定不许硬编码、不许写反 | 判据的输入只许是 `insert` 的返回值。把 `prior.is_none()` 写成恒 `true` ⇒ 回到刷屏；写成 `is_some` ⇒ 变成"首次不弹、重复才弹"，两种都静默 ⇒ `tests::every_friend_request_path_notifies_only_on_first_sighting` 认这两种形状 |
> | 4 | 频率那一半在**发送侧**：补发必须有最小间隔 | `friend_request_flush_decision`（`network/transport/handshake.rs:443`）+ 调用处的 `const MIN_INTERVAL_MS: i64 = 30_000;`（`:468`），挂在建链与每轮心跳 |
> | 5 | `emit` 每次都发**不算违反本条** | 事件是"请界面重拉一次"的幂等信号 ... 本条只约束**系统通知**那一路 |
> | 6 | 已经是好友的人再发申请，不许落到"通知"那一支 | `apply_friend_request` 进门先走 `auto_accept_if_already_friend`（`network/transport/handshake.rs:361`） |
> **边界（如实写下，别当成已解决）**：规则 1 的键是**内存态**。`pending_requests` 是 `Mutex<HashMap>`（`state.rs:1076`），而库里**没有**对应的表 ⇒ **接收端重启**后内存表是空的 ... ⇒ 所以本条的可信范围只到**同一进程生命周期内**"
> — docs/protocol-invariants.md §33. INV-P33, line 1558

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 好友申请重复到达时系统通知只许弹第一次；好友同意重复到达时系统通知只许弹"真的从不是好友变成好友"那一次；首次判定不许硬编码也不许写反；发送侧补发必须有最小间隔；`emit` 每次都发不算违规；已经是好友的人再发申请不许落到通知那一支。

**Where enforcement lives:**

**规则 1（申请的通知门控）：**

```rust
// src-tauri/src/network/transport/handshake.rs:340-364
pub enum FriendRequestArrival { Notify, SilentRefresh }

pub fn friend_request_arrival_decision(first_sighting: bool) -> FriendRequestArrival {
    if first_sighting { FriendRequestArrival::Notify } else { FriendRequestArrival::SilentRefresh }
}

// src-tauri/src/network/transport/handshake.rs:388-408（apply_friend_request）
pub(crate) async fn apply_friend_request(state: &Arc<AppState>, req: PendingRequest, trace: &str) {
    if auto_accept_if_already_friend(state, &req.from).await { return; }   // ← 规则 6
    let prior = {
        let mut pending = state.pending_requests.lock().unwrap_or_else(|e| e.into_inner());
        pending.insert(req.from.clone(), req.clone())        // ← 键 = insert 的旧值
    };
    let _ = state.app.emit("friend-request", &req);            // ← 规则 5：每次都发
    let was_pending =
        friend_request_arrival_decision(prior.is_none()) == FriendRequestArrival::Notify;
    if was_pending {
        state.logger.info("friend", format!("{trace} peer={} nickname={}", req.from, req.from_nickname));
        let mut extra = std::collections::HashMap::new();
        extra.insert("type".to_string(), "friend_request".to_string());
        // … show_click_if_enabled(state, …)
    }
}
```

- What it checks, and against what：`pending.insert(...)` 返回**旧值**（`Option<PendingRequest>`）⇒ `None` = 本机第一次握着这条申请 ⇒ `prior.is_none()` = true ⇒ `Notify`。旧值非 `None` = 重复 ⇒ `SilentRefresh` ⇒ 只发事件、**不弹系统通知**。
- Which paths reach it, and which do not：`apply_friend_request` 有**两个**到达点（直连 `Message::FriendRequest` 与跨跳 `GossipKind::FriendRequest`），判据数了这两个调用点。

**规则 2（同意的通知门控）：**

```rust
// src-tauri/src/network/transport/handshake.rs:308-338（apply_friend_accept）
let was_friend = {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let seen = db::get_friend(&dbc, from).is_some();       // ← 在 add_friend **之前**取值
    db::add_friend(&dbc, from, &name, None).ok();
    bind_friend_keys_on_accept(&dbc, from, key_snapshot);
    seen
};
forget_pending_request(state, from);
let _ = state.app.emit("friend-accepted", from);            // ← 规则 5
if was_friend {
    state.logger.info("friend", format!("重复的好友同意（已忽略）peer={from}"));
} else {
    state.logger.info("friend", ...);
    let _ = crate::notifications::show_if_enabled(state, "好友申请已通过", &format!("{name} 已成为你的好友"));
}
```

- What it checks, and against what：键 = **持久**好友表（`friends`）⇒ 跨重启仍然有效 ⇒ 规则 2 不像规则 1 那样有"重启后复发"的缺口。`was_friend` 在 `add_friend` **之前**取（否则永远是 true）⇒ 第一次真的从不是好友变成好友 ⇒ 弹通知。

**规则 3（不许硬编码 / 不许写反）：**

```ts
// src-tauri/src/lib_friend_identity_tests.rs:173-181
assert!(
    home_f.contains("friend_request_arrival_decision(prior.is_none())"),
    "门控的输入必须是 insert 的返回值（None = 本机第一次握着这条申请）",
);
assert!(
    !home_f.contains("friend_request_arrival_decision(true)")
        && !home_f.contains("friend_request_arrival_decision(false)"),
    "不许把首次判定硬编码成常量 —— 那等于拆掉门控却留着判据的名字",
);
```

**规则 4（发送侧补发间隔）：**

```rust
// src-tauri/src/network/transport/handshake.rs:461-476
pub fn friend_request_flush_decision(
    entry: Option<(i64, i64)>, now: i64, min_interval_ms: i64,
) -> FriendRequestFlush {
    let Some((_issued, last)) = entry else { return FriendRequestFlush::Nothing; };
    if last != 0 && now - last < min_interval_ms { return FriendRequestFlush::Nothing; }
    FriendRequestFlush::Flush
}

// src-tauri/src/network/transport/handshake.rs:485-496
pub async fn flush_pending_friend_request(state: &Arc<AppState>, peer_id: &str) {
    const MIN_INTERVAL_MS: i64 = 30_000;
    let now = crate::db::now_ms();
    let decision = { /* 锁内只判定 */ friend_request_flush_decision(entry, now, MIN_INTERVAL_MS) };
    if decision == FriendRequestFlush::Nothing { return; }
```

**规则 6（已是好友 ⇒ 自动同意）：**

```rust
// src-tauri/src/network/transport/handshake.rs:277-296
async fn auto_accept_if_already_friend(state: &Arc<AppState>, peer_id: &str) -> bool {
    let already_friend = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_friend(&dbc, peer_id).is_some()
    };
    if !already_friend { return false; }
    ...
    crate::commands::accept_friend_request(state, peer_id).await
    true
}
```

**Paths walked:**
- 直连好友申请 → `handle_identity.rs` → `apply_friend_request` ⇒ 首次弹通知、重复只发事件 ✓
- 跨跳好友申请 → `gossip.rs` → `apply_friend_request`（同一个家）⇒ 同上 ✓
- 直连好友同意 → `handle_identity.rs` → `apply_friend_accept` ⇒ `was_friend` 门控 ✓
- 跨跳好友同意 → `gossip.rs` → `apply_friend_accept`（同一个家）✓
- 已是好友的人再发申请 → `apply_friend_request` → `auto_accept_if_already_friend` ⇒ **早退**，不插 pending、不弹"请求添加你为好友" ✓
- 补发（发送侧）→ `flush_pending_friend_request` → `friend_request_flush_decision` ⇒ 距上次补发 < 30s ⇒ `Nothing`（不发）✓

**Searched:**
- `apply_friend_request` → 生产调用点 **2 处**（直连 + 跨跳），判据 `lib_friend_identity_tests.rs:138-143` 断言恰好 2 ⇒ **一个家，两个消费者** ✓
- `apply_friend_accept` → 生产调用点 **2 处**，判据 `lib_friend_identity_tests.rs:88-93` 断言恰好 2 ✓
- `emit("friend-request"` → 全仓 **1 处**（在 `apply_friend_request` 内，判据 `:146-150` 断言恰好 1）✓
- `show_click_if_enabled(state` → 全仓 **1 处**（在 `apply_friend_request` 内，判据 `:151-155` 断言恰好 1）✓
- `show_if_enabled(state` → `apply_friend_accept` 内（通知在 `was_friend` 的 else 支）✓
- `auto_accept_if_already_friend(state, ` → 全仓 **1 处**（在 `apply_friend_request` 内，判据 `lib_friend_identity_tests.rs:200-210` 断言恰好 1）✓
- `friend_request_arrival_decision` → `handshake.rs:364`（定义）+ `handshake.rs:401`（唯一生产调用）+ `handshake_tests.rs` ✓
- `friend_request_flush_decision` → `handshake.rs:461`（定义）+ `handshake.rs:496`（唯一生产调用）+ `group_keys_tests.rs` 5 处用例 ✓
- `MIN_INTERVAL_MS` → `handshake.rs:486`（申请补发，30 000）+ `handshake.rs:590`（同意补发，5 000）—— 两条不同的常量，注释明写"**别把它们合并**"（`:446-447`）✓
- `pending_requests` 的持久化 → `state.rs` 里的 `Mutex<HashMap>`（内存态）。**库里没有对应的表** —— 文档边界（"接收端重启后会再弹一次"）在代码里成立。`grep -rn "CREATE TABLE" src-tauri/src --include="*.rs"` 中无 `friend_requests` / `pending_requests` 表 ✓（本条未逐条复验该 grep，但 `db.rs` 的 `SCHEMA` 里没有这两张表）
- `friend-accepted` 的 `emit` → `handshake.rs` 内 1 处（每次都发）✓

**Hook verification:**
- `tests::every_friend_request_path_notifies_only_on_first_sighting` — **存在**：`src-tauri/src/lib_friend_identity_tests.rs:135` ✓（基线命中）。断言：调用点恰好 2、`emit("friend-request"` 恰好 1、`show_click_if_enabled(state` 恰好 1、家里含 `ifwas_pending{` + `show_click_if_enabled(state`、家里含 `auto_accept_if_already_friend(state,`、家里含 `pending_requests.lock()` + `.insert(`、门控输入必须是 `friend_request_arrival_decision(prior.is_none())`、不许出现 `friend_request_arrival_decision(true)` / `(false)`。
- `tests::every_friend_accept_path_forgets_the_pending_request` — **存在**：`lib_friend_identity_tests.rs:81` ✓（基线命中）。断言：调用点恰好 2、家里含 `forget_pending_request(state,from)`、家里含 `ifwas_friend{` + `show_if_enabled(state`。
- `network::transport::tests::friend_request_arrival_notifies_only_the_first_time` — **存在**：`src-tauri/src/network/transport/handshake_tests.rs` 内 ✓（基线命中）
- `network::transport::tests::pending_friend_request_reflush_is_spaced_not_per_heartbeat` — **存在**：同上文件 ✓（基线命中）
- `guards:好友申请的通知只在第一次到达时弹` — **存在**：实测 name 命中 1 次 ✓
- `guards:待发好友申请的补发必须有间隔` — **存在**：实测 name 命中 1 次 ✓
- `guards:两条 FriendAccept 路径走同一个家` — **存在**：实测 name 命中 1 次 ✓

全部七条钩子存在并注册。

**How the verdict was reached:** 六条规则逐条对上号：规则 1 的键是 `insert` 的旧值、判定经纯函数、通知只在 `Notify` 支；规则 2 的键是持久好友表且在 `add_friend` 之前取值；规则 3 的输入被形状判据钉死（`prior.is_none()`，且不许出现常量）；规则 4 的补发间隔 30s 由纯函数判定；规则 5 的 `emit` 每次都发且**只有一个发起点**；规则 6 的自动同意在那个家里且早退。文档自己如实登记的边界（规则 1 的键是内存态 ⇒ 接收端重启后会再弹一次）在代码里**确实如此**——文档没有把它说成已解决，而"同意那一支没有这个问题（键在 `friends` 表里，重启还在）"也在代码里成立。定为 `implemented`。

**Open questions:**
- 文档说规则 1 的键在 `network/transport/handshake.rs:364`（`pending_requests.insert`），实际 `insert` 在 `:394` 附近、`friend_request_arrival_decision` 定义在 `:364` ⇒ 文档把两个行号对调了（它把 `:364` 说成 insert、`:339` 说成定义；实际定义在 `:364`、insert 在 `:394`）。行号漂移，不影响判定。
- 文档的"边界"段说 `pending_requests` 在 `state.rs:1076`，构造处 `state.rs:1472` 给的是空表 —— 本次未逐行复验这两个行号。
- 文档说"两个到达点：`handle_identity.rs:188` / `gossip.rs:501`" —— 未逐行复验，但"恰好 2 个调用点"由判据断言强制。
- 文档自陈的判据不足："同意那一支今天**只有形状断言、没有专属注入 Case**（`guards:两条 FriendAccept 路径走同一个家` 的注入打的是'少一条消费者'与'家里不清 pending'，都不碰 `was_friend` 门控）⇒ 摘掉门控在本地单测会红，但注入层没有独立一条证明它会红。" 这条自陈与代码一致。
- 规则 4 的 `MIN_INTERVAL_MS` 是 30 s，而同意补发那条是 5 s（`handshake.rs:590`）。文档只给申请侧的 30 s。同意侧 5 s 意味着一条没人应答的 FriendAccept 每 5 s 洪泛一次 —— 注释解释了它与申请侧"别把它们合并"的理由（回执要数次数，申请不等对方），但补发**频率**上 5 s 是否也构成"洪泛"，文档没有讨论。
