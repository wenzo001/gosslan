# Gosslan — 未信任网络攻击面审计（VULNERABILITY HUNTING）

- 审计基线：`c325e125`（tag `v5.15.2`），工作区 `/Users/wendongfu/Documents/code/gosslan`
- 范围：同 LAN 节点 / BLE 对端 / 中继对端**可达**的入口
- 方法：逐条跟调用链到被调函数（不信任函数名的暗示），为每条候选构造具体线上字节；无攻击路径的一律不报
- 结论先行：**11 条有效发现**（High 3、Medium 1、Low 3、Informational 4）；其中 **10 条 Confirmed**、1 条 Needs verification（SEC-07，缺失的那条腿已在条内写明）。
- 另有 **1 条经实测撤回**（SEC-09：前提被证伪，详见该条）—— 撤回过程与探针数据一并留在报告里，供复核。
- 本轮有 **3 条结论由实跑探针确认或证伪**（SEC-03 确认、SEC-09 撤回、SEC-11 确认），其余为静态分析。

---

## SEC-01 — 未经用户同意的 `FriendAccept` 把任意对端直接变成「好友」

**Severity (your assessment):** High
**Status:** Confirmed
**Location:** `src-tauri/src/network/transport/handle_identity.rs:204-214`、`src-tauri/src/network/transport/handshake.rs:306-338`、`src-tauri/src/network/transport/gossip.rs:639-647`

**What:**
「对方同意了我的好友申请」这条消息被当成了**权威的好友关系建立指令**，但它只校验「帧里的 `from` 是不是链路对端」和「`to` 是不是我」，**完全不校验本机是否真的发起过申请**。`apply_friend_accept` 直接 `db::add_friend(...)`，把对端写进持久化的 `friends` 表。友谊是后续几乎所有授权判据的输入（`is_friend`），所以这一步等价于「对端自助获得本机信任」。

**Attack path:**
1. 攻击者在 LAN 上开一个 TCP 连接到本机监听端口（`network/transport.rs:585` `handle_incoming`）。
2. 首帧发 `Message::Hello`，`device_id` 用一个全新的随机串（例如 `attacker-0001`），`ed25519_pubkey`/`x25519_pubkey` 是攻击者自己的密钥对，`sig` 用攻击者的 Ed25519 私钥对 `hello_signing_bytes` 签名。
3. `verify_hello`（`handshake.rs:56`）走 **TOFU 分支**：`bound` 取自 `friends` 表（该 id 不在表里）→ `None` → `hello_auth_decision` 的 `None` 分支只用**自报公钥**验签 → 通过（`hello_auth_decision` 是为「首次接触」设计的，不是缺陷）。
4. 链路建立，攻击者发第二帧：
   `{"type":"friend_accept","from":"attacker-0001","to":"<本机 device_id>"}`
   - `to` 的值攻击者**已经知道**：受害端建链时把自己的签名 Hello 回发（`transport.rs:768-782` 的 `build_signed_hello`），里面带 `device_id`。
   - `from` 必须等于链路对端 id（`handle_identity.rs:205`），攻击者用自己 Hello 里声明的那个即可。
5. `handle_message`（`network/transport.rs:1085`）把 `FriendAccept` 分派到 `handle_identity_and_friend_messages` → `handle_identity.rs:204`：`from == peer_id` ✓、`to == state.device_id` ✓ → `apply_friend_accept`。
6. `apply_friend_accept`（`handshake.rs:306`）→ `db::add_friend(&dbc, "attacker-0001", ...)` → **`friends` 表新增一行**；随后 `bind_friend_keys_on_accept` 把攻击者的 x25519 绑定进 `friends.x25519_pubkey`（`handshake.rs:317`）；并 `emit("friend-accepted", ...)` 通知前端。
7. 跨跳版本同理：`GossipKind::FriendAccept`（`gossip.rs:639`）只判 `env.target == state.device_id`，`apply_friend_accept` 同一入口。

**为什么这条不能被「用户必须点同意」兜住：**
网络路径与命令路径**共用** `apply_friend_accept`，但只有命令路径 `respond_friend_request`（`commands/mobile_picker.rs:467`）检查 `pending_requests`；网络路径直接落库。

**Evidence:**
```rust
// handle_identity.rs:204-214
Message::FriendAccept { from, to } => {
    if from != peer_id { return; }
    if to != state.device_id { return; }
    apply_friend_accept(state, &from, "收到好友同意");
}
```
```rust
// handshake.rs:306-319
pub(crate) fn apply_friend_accept(state: &Arc<AppState>, from: &str, trace: &str) {
    ...
    let was_friend = {
        let dbc = state.db.lock()...;
        let seen = db::get_friend(&dbc, from).is_some();
        db::add_friend(&dbc, from, &name, None).ok();      // ← 无条件写入 friends 表
        bind_friend_keys_on_accept(&dbc, from, key_snapshot);
        seen
    };
    forget_pending_request(state, from);
```
```rust
// db/friends.rs:5-17 —— ON CONFLICT DO UPDATE，任何 device_id 都能被写成好友
"INSERT INTO friends(device_id, nickname, avatar, added_at) VALUES(?1, ?2, ?3, ?4)
 ON CONFLICT(device_id) DO UPDATE SET nickname = excluded.nickname, avatar = excluded.avatar"
```

**我搜索过、确认**不构成缓解的：
- `state.pending_requests`：`apply_friend_accept` 只**清理**它（`forget_pending_request`），从不**检查**它。唯一检查 `pending_requests` 的是命令层 `respond_friend_request`（`commands/mobile_picker.rs:467`）——那是**用户主动点击**的路径，网络路径绕开了它。
- `is_friend` 判据本身：它读 `db::get_friend`，所以第 6 步之后攻击者**就是**好友了。
- 签名/TOFU：Hello 验签通过是设计内的（TOFU），不能阻止第 4 步。

**Impact:**
`is_friend` 是多个网络入口的授权闸，攻击者一步拿到好友身份后可：
- **拉取内容**：`handle_share.rs:214-225` 的 `content_serve_allowed(is_friend=true, ...)` ⇒ 攻击者可凭 cid 拉走本机**任何**已收内容（`find_source` 只看 cid 命中，不看会话归属）。cid 是明文 SHA-256，若攻击者能观测到本机发出的 `FileOffer`/`ContentRequest`，cid 即得。
- **浏览并下载共享目录**：`handle_share.rs:287-289`（树）与 `:383-386`（文件）的「双好友」判定中，`from` 与 `peer_id` 都取自链路对端/自报字段 —— 攻击者此刻**两者都是好友** ⇒ 可枚举并下载本机共享目录里的文件。文件路径本身仍受 `resolve_shared_file` 的 `canonicalize`+`starts_with` 保护（见「已检查且确认安全」），所以读到的是共享目录**之内**的文件。
- **发文件**：`handle_file.rs:28-32` 的 `is_friend` 闸打开 ⇒ 可让本机接收任意文件（受磁盘配额限制）。
- 消息/群密钥侧：仍受群成员表限制，但受害端 UI 上会出现一个**未经用户同意**的「好友」，且 `friends.x25519_pubkey` 被写成攻击者的公钥 ⇒ 受害端此后向该 id 发消息时 E2EE 用的是攻击者的 X25519（`sender_x25519_pubkey` 优先读 friends 表，`e2ee_payload.rs:20-33`）。

**Confirmation:** static analysis only（逐行读完 `handle_identity.rs` / `handshake.rs` / `gossip.rs` / `db/friends.rs` / `handle_share.rs` / `e2ee_payload.rs` 的调用链与判据）。

**Fix sketch:** `apply_friend_accept` 在写库前要求本机存在对应 `pending_out_requests`（本机确实申请过）；缺失则只记日志并丢弃，不落库、不绑定公钥。命令层的 `respond_friend_request` 已有这个判据，把它下沉到共享入口即可。

**Regression test:** `lib_friend_identity_tests.rs`（或同级新文件）——「收到一个本机从未申请过的 `FriendAccept` ⇒ `friends` 表行数不变、`friends.x25519_pubkey` 未被绑定」；正向用例「本机申请过 ⇒ 落库成功」。

---

## SEC-02 — 未认证 UDP announce 让 `peers` 表无界增长，并被每 300ms 全量序列化推给前端

**Severity (your assessment):** High
**Status:** Confirmed
**Location:** `src-tauri/src/network/discovery.rs:585-674`（`handle_datagram`）、`src-tauri/src/network/transport/peer_registry.rs:115-274`（`upsert_peer`）、`src-tauri/src/state.rs:2576-2609`（`emit_peers_now`）、`src-tauri/src/state.rs:2653-2665`（`spawn_peer_emitter`）

**What:**
发现协议接受**未签名**的 announce（`verify_announce` 返回 `Legacy`），并把包里的 `device_id` 当成新节点写进内存 `peers` 表。该表**没有任何条数上限**，唯一的回收是 `sweep_peers` 的 **45 秒**时间窗回收（`discovery.rs:846`）。同时 `state.peers` 的**全量拷贝 + JSON 序列化 + IPC 推送**每 300ms 触发一次（`emit_peers_now`），且 announce 路径每次都 `emit_peers()` 把节流窗口重新点亮 —— 于是「攻击者每包 200 字节」换来「受害端每 300ms 一次全表克隆+序列化+IPC」。

**Attack path:**
1. 攻击者（同 LAN，能向 `UDP_PORT` 发包，不需要 TCP 握手、不需要任何密钥）持续发 UDP：
   `{"kind":"announce","device_id":"<每包一个全新随机串>","nickname":"x","tcp_port":1234,"x25519_pubkey":null,"ed25519_pubkey":null,"nonce":"","sig":""}`
   → `verify_announce`（`protocol.rs:2452`）走 `Legacy` 分支（无 sig ⇒ 接受）→ 不拒绝。
2. `discovery.rs:625` → `upsert_peer` → `peers` 表新增一条（`peer_registry.rs:162-188` 的 `None` 分支，`keys_verified: false`）。
3. 每条 announce 末尾 `state.emit_peers()`（`peer_registry.rs:225`）把 `peers_dirty` 置位 ⇒ `spawn_peer_emitter` 的 300ms 窗口永远被重新点亮 ⇒ `emit_peers_now` 持续全量执行。
4. `emit_peers_now`（`state.rs:2582-2608`）：`self.peers.values().cloned().collect()`（深拷贝全部 `Peer`）→ `app.emit("peers-updated", peers)`（整表 JSON 序列化成 IPC 载荷）。
5. 45 秒内 `peers` 规模 ≈ 攻击者发包速率 × 45。10 万条 ≈ 每 300ms 一次 40 MB 量级的 JSON 克隆 + 序列化 + IPC 推送。

**Evidence:**
```rust
// discovery.rs:605-618 —— 无签名的 announce 被接受
match crate::protocol::verify_announce(&pkt) {
    crate::protocol::AnnounceAuth::Invalid(reason) => { ...; return; }
    crate::protocol::AnnounceAuth::Verified => ...,
    crate::protocol::AnnounceAuth::Legacy => {}      // ← 未签名也放行
}
```
```rust
// discovery.rs:625-637 —— 攻击者控制的 device_id 直接进 peers 表
upsert_peer(state, &pkt.device_id, &pkt.nickname, None, "",
            &src.ip().to_string(), pkt.tcp_port,
            pkt.x25519_pubkey.clone(), pkt.ed25519_pubkey.clone(), None).await;
```
```rust
// state.rs:2582-2608 —— 每 300ms 全表克隆 + 序列化 + IPC
fn emit_peers_now(&self) {
    let mut peers: Vec<Peer> = self.peers.lock()...values().cloned().collect();
    ...
    let _ = self.app.emit("peers-updated", peers);
}
```
```rust
// state.rs:2653-2665 —— 300ms 节流窗口会被持续唤醒
st.peers_notify.notified().await;
tokio::time::sleep(Duration::from_millis(300)).await;
if st.peers_dirty.swap(false, Ordering::SeqCst) { st.emit_peers_now(); }
```
```rust
// discovery.rs:846 —— 唯一的回收是 45 秒时间窗，不是条数上限
fn should_keep_peer(last_seen: i64, now: i64, has_active_link: bool) -> bool {
    has_active_link || last_seen >= now - RELAY_PEER_TIMEOUT_SECS * 1000
}
```

**我搜索过、确认**不构成缓解的：
- `MAX_PEERS` / `peers.len() > N` 之类上限：**不存在**（全仓 grep 无命中）。
- `MAX_INBOUND_CONNECTIONS`(128) / `dial_permits`(16)：只管 **TCP 连接**与**并发拨号**，管不到 UDP → peers 表的条目数。
- `adaptive_interval`（`discovery.rs:552`）：只调**本机自己**的广播周期，不限制入包。
- `sweep_peers`：只按时间窗回收，速率越高存活越多。
- `log_throttled` / `logging::diag_delivery("announce_recv")`：`announce_recv` 属 `Dropped` 档，**不会**刷日志 —— 所以这条攻击在日志上是静默的（这一点让影响更隐蔽，不是缓解）。

**Impact:**
受害端内存被 `peers` 条目撑大；更重的是 CPU/IPC：每 300ms 把整表深拷贝并 JSON 序列化推给 WebView，N 大时形成持续几百 MB/s 的序列化与 IPC 压力 ⇒ 界面卡死/前端 OOM，同时挤占 CPU 影响消息收发。

**Confirmation:** static analysis only（未做实测速率压测）。

**Fix sketch:**
- 给 `state.peers` 加条数上限（如 5 000）：`upsert_peer` 满了就拒绝新条目并计数告警，而不是无限增长。
- `handle_datagram` 增加**按源 IP 的入包速率限制**（如每秒 N 包超额丢弃）。
- announce 不再无条件 `emit_peers()`，或让 `emit_peers_now` 对表大小设上限/分页。

**Regression test:** `network/discovery_tests.rs` ——「连续注入 10 000 个不同 `device_id` 的 announce ⇒ `state.peers.len()` 不超过配置上限」。

---

## SEC-03 — Gossip 身份锚点信任「未签名 announce 提供的公钥」⇒ 可冒充好友并注入聊天

**Severity (your assessment):** High
**Status:** Confirmed
**Location:** `src-tauri/src/network/transport/gossip.rs:205-244`（`peer_anchor` / `sender_trusted`）、`src-tauri/src/network/transport/handshake.rs:128-131`（`bound_ed25519_from_peer`）、`src-tauri/src/network/transport/peer_registry.rs:135-188`（`upsert_peer` 的 `None` 分支）

**What:**
同一个身份（某 `device_id` 的公钥）在两条信任路径上被**用不同标准**取用：
- Hello 验签路径明确只信**已验签**的条目（`bound_ed25519_from_peer` 要求 `keys_verified`）。
- Gossip 锚点路径（`gossip.rs:205-210`）直接读 `peers` 表的 `ed25519_pubkey`，**不检查 `keys_verified`** —— 而 `peers` 表的该字段可以被**未签名的 UDP announce** 写入。

后果有两层：
(a) 攻击者能让 `env.sender_ed25519` 通过「已认识的可信发送方」判定；
(b) 关键的是 `sender_trusted` 通过后，`kind=Chat` 的载荷走的是 **`env.encrypted == false` 的明文分支**（`gossip.rs:334-337`：`STANDARD.decode(&env.payload)`），**不做任何 ECDH 解密** —— 于是攻击者可以**任意构造明文聊天内容**，落库并显示为该好友发来的消息。`verify_envelope` 只验「签名与自己声明的公钥自洽」，而攻击者用自己的 E_att 签的名恰好自洽。

**Attack path:**
1. 攻击者用**未签名** announce 广播 `device_id = "F"`（F 是受害者的某个好友）、`ed25519_pubkey = E_att`、`x25519_pubkey = X_att`（两个都是攻击者自己的密钥对）。
   - `verify_announce`（`protocol.rs:2452`）：无 sig ⇒ 返回 `Legacy` ⇒ **接受**（`discovery.rs:605-618` 只在 `Invalid` 时拒绝）。
   - `upsert_peer`（`discovery.rs:625`）：`needs_anchor` 为真（`peers` 里还没有 F）⇒ 取 `friend_anchor = db::get_friend_pubkeys(F)`。
   - **关键前提**：`friends.F.x25519_pubkey` 必须是 `NULL`。若 F 是通过**跨跳**加的好友，`bind_friend_keys_on_accept` 只在 `verified` 时绑 ed25519、但 x25519 恒绑；反之若 F 的 x25519 已绑（`Some(X_real)`），`new_peer_conflicts_with_friend` 的第一段 `matches!((fx, x25519), (Some(o), Some(n)) if o != n)` 命中 ⇒ 判冲突 ⇒ **条目不被写入**（`peer_registry.rs:150-161` 的 `None` 分支直接返回 `key_conflict`）。
   - 所以攻击者需要 `friends.F.x25519_pubkey IS NULL`。这是**真实存在**的状态：`update_friend_pubkeys`（`db/friends.rs:50-63`）用 `COALESCE(x25519_pubkey, ?2)` **只填空不覆盖**，而 x25519 的填空发生在 `bind_friend_keys_on_accept`（`handshake.rs:206-211`）—— 该函数**要求 `peers` 快照里已有 x25519**；若好友是在 `peers` 条目被 `sweep_peers` 回收（45s 空闲）之后才被接受的，x25519 就一直是 NULL。
   - 在该前提下，`new_peer_conflicts_with_friend`（`peer_registry.rs:102-113`）两段 `matches!` 都不命中（friends 侧两个都是 None）⇒ **不判冲突** ⇒ 条目建成 `(x25519=X_att, ed25519=E_att, keys_verified=false)`。
2. 攻击者用**自己的** device_id（`attacker-0001`）建立正常 TCP 链路（TOFU Hello 通过，`handshake.rs:37-42`）。
3. 攻击者在这条链路上发一个 Gossip 信封：
   `kind=Chat`、`sender_id="F"`、`sender_ed25519=E_att`、`sender_pubkey=X_att`、`encrypted=false`、`target=<受害端 device_id>`、`payload=base64(任意 JSON)`，并用 E_att 的私钥对 `signing_bytes()` 签名（`message_id` 按 `compute_message_id()` 算好）。
4. `gossip.rs:205`：`peer_anchor = peers.get("F")` = `(E_att, X_att)` ⇒ 与 `env.sender_ed25519` 相等 ⇒ **`sender_trusted = true`**（`gossip.rs:219`，`direct_peer` 不需要成立）。
5. `verify_envelope`（`gossip.rs:265`）用 `env.sender_ed25519`(=E_att) 验签 ⇒ 攻击者自签即通过。
6. `gossip.rs:334`：`env.encrypted == false` ⇒ `plaintext = STANDARD.decode(&env.payload)` ⇒ **攻击者的明文 JSON 直接成为聊天内容**，不做 ECDH、不做 AEAD。
7. `gossip.rs:826`：`env.kind == Chat` ⇒ 查 `db::get_friend(&dbc, "F")` ⇒ F 确实是好友 ⇒ 通过。
8. `gossip.rs:1099-1167`：以 `sender_id = env.sender_id = "F"` 落库 `messages` 行 ⇒ **受害者的聊天记录里出现一条冒充 F 的消息**。

**Evidence:**
```rust
// gossip.rs:205-210 —— 锚点取自 peers 表，不看 keys_verified
let peer_anchor = {
    let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
    peers.get(&env.sender_id)
        .map(|p| (p.ed25519_pubkey.clone(), p.x25519_pubkey.clone()))
};
```
```rust
// gossip.rs:217-223 —— 锚点相等即判可信（direct_peer 分支不需要成立）
Some((ed25519, x25519)) => {
    let direct_peer = peer_id == env.sender_id;
    (ed25519.as_deref() == Some(env.sender_ed25519.as_str())
        || (direct_peer && ed25519.is_none()))
        && (x25519.as_deref().map_or(true, |key| key == env.sender_pubkey)
            || (direct_peer && x25519.is_none()))
}
```
```rust
// gossip.rs:334-337 —— encrypted=false ⇒ 明文 base64，不解密
let plaintext = if !env.encrypted {
    // FriendMessageBlocked 等明文 Gossip：payload 是 base64 编码的 JSON
    STANDARD.decode(&env.payload).ok()
} else { ... };
```
```rust
// handshake.rs:128-131 —— Hello 路径明确要求 keys_verified（同一份数据，两套标准）
fn bound_ed25519_from_peer(peer: Option<&Peer>) -> Option<String> {
    peer.filter(|p| p.keys_verified)
        .and_then(|p| p.ed25519_pubkey.clone())
}
```
```rust
// peer_registry.rs:102-113 —— friends 侧两列为 NULL 时不判冲突
fn new_peer_conflicts_with_friend(friend: Option<(Option<&str>, Option<&str>)>, ...) -> bool {
    match friend {
        Some((fx, fe)) => {
            matches!((fx, x25519), (Some(o), Some(n)) if o != n)
                || matches!((fe, ed25519), (Some(o), Some(n)) if o != n)
        }
        None => false,
    }
}
```
```rust
// db/friends.rs:50-63 —— 只填空不覆盖 ⇒ x25519 一旦为 NULL 就可能长期为 NULL
"UPDATE friends SET x25519_pubkey = COALESCE(x25519_pubkey, ?2),
                    ed25519_pubkey = COALESCE(ed25519_pubkey, ?3)"
```

**我搜索过、确认**不构成缓解的：
- `keys_verified` 在 gossip 路径**未被检查**（已逐行确认 `gossip.rs:205-244` 全文）。
- `friend_anchor` 冲突检测：friends 侧两列都是 `None` 时两段 `matches!` 都不命中（已确认）。
- `verify_envelope` 只验「签名与自己声明的公钥自洽」，不验「这个公钥是该 device_id 的」—— 攻击者声明的正是自己刚注入的那把。
- `env.encrypted == false` 的 Chat 分支：代码注释里写着「不再为用户 Chat/Group 提供明文兼容路径」（`gossip.rs:850`），但**接收侧并没有强制** Chat 必须 `encrypted == true`（已确认 `gossip.rs:334` 与 `:760` 的判断都是「encrypted 为真时如何」，没有「Chat 不得为 false」的反向闸）。

**Impact:**
- **消息伪造**：受害者的聊天库里出现一条 `sender_id = F` 的消息，正文由攻击者完全指定。F 是受害者的**真实好友**，受害者无从分辨。配合 §SEC-01（无需用户同意即可成为好友），攻击者可把这条消息投递给受害者的任意联系人。
- **身份锁死**：F 自己的真实 ed25519 再也进不了 `peers` 表 —— F 自己的 Hello 触发 `upsert_peer` 的 `Some(p)` 分支时 `e_conflict=true` ⇒ `key_conflict` ⇒ 提前 return（`peer_registry.rs:227-231`）⇒ 锚点永久停留在 E_att。F 的 Gossip 消息此后**全部被拒**（`sender_trusted` 判false）⇒ F 与受害者之间的跨跳聊天静默中断。
- **社工**：`warn_key_conflict_once` 会向受害者与 F 的会话插入系统消息「⚠️『F』的身份密钥发生变化，已保留原密钥未替换」⇒ 攻击者可在受害者界面伪造好友身份告警。

**Confirmation:** **已执行** —— 探针直接调用本仓的 `new_peer_conflicts_with_friend` 与 `bound_ed25519_from_peer`（**真实生产函数**，非复刻），逐条断言三件事：
1. `new_peer_conflicts_with_friend(Some((None, None)), Some("X_ATTACKER"), Some("E_ATTACKER"))` == `false` ⇒ **friends 侧两列为 NULL 时不判冲突**（SEC-03 的前提成立）；且同一函数在 friends 侧有真实公钥时返回 `true` ⇒ 证明「返回 false」不是「恒返回 false」。
2. `bound_ed25519_from_peer(Some(&peer_with_keys_verified_false))` == `None` ⇒ **Hello 路径确实拒绝**这条未验签的 `peers` 条目。
3. 把 `gossip.rs:205-210` + `:217-223` 的锚点判定**逐字复刻**后，对同一个 `keys_verified=false` 的条目算出 `sender_trusted == true` ⇒ **Gossip 路径接受它**。
⇒ 两条信任标准对**同一份数据**给出相反结论，SEC-03 成立。探针文件测完即删，工作区已还原。

**Fix sketch:**
- `gossip.rs` 的 `peer_anchor` 与 `bound_ed25519_from_peer` **共用同一个判据**：只信 `keys_verified` 的条目；`keys_verified=false` 的 ed25519 不得用作身份锚点。
- 接收侧加一道闸：`GossipKind::Chat` / `Group` 必须 `env.encrypted == true`（明文只允许 `FriendMessageBlocked` 等控制帧），与 `gossip.rs:850` 的注释所声称的口径对齐。
- `upsert_peer` 的 `friend_anchor` 冲突检测：friends 侧该列为 `NULL` 时应视作「未知」而非「不冲突」；或让 announce 路径对**已是好友**的 device_id 一律不写入 `peers`（好友的身份只由验签路径决定）。

**Regression test:** `network/transport/gossip_tests.rs` —— ①「`peers[X].keys_verified=false` 且 `peers[X].ed25519_pubkey=E` ⇒ 用 E 签名的 `sender_id=X` 的信封判为不可信」；②「`kind=Chat` 且 `encrypted=false` ⇒ 丢弃且不落库」；③反向用例「`keys_verified=true` 且 `encrypted=true` ⇒ 正常接收」。

---

## SEC-04 — `ChatStyle` 帧：`from` 未绑定链路对端 + `style` 无长度上限 ⇒ 持久化库无界增长与二次方写放大

**Severity (your assessment):** Medium
**Status:** Confirmed
**Location:** `src-tauri/src/network/transport/handle_messaging.rs:15-40`、`src-tauri/src/db/settings.rs:110-117`

**What:**
收到 `ChatStyle` 时，代码只检查「`from` 不是我」和「`to` 是不是我（或是广播）」，**没有检查 `from == peer_id`** —— 与同文件里 `ChatMessage`（`handle_messaging.rs:50`）、`ReadReceipt`（`:261`）、`UserInfo`（`handle_identity.rs:149`）的写法不一致（那三个都绑了 `peer_id`）。同时 `style` 字符串**没有任何长度上限**（`MAX_MESSAGE_LEN`/`content_within_limit` 只管聊天正文，不管 style）。落库方式是「读整张表 → 插入 → 整张表序列化回写」，于是 N 个不同 `from` 产生 O(N²) 的写放大。

**Attack path:**
1. 攻击者建立 TCP 链路（TOFU Hello 即可，无需好友身份）。
2. 连续发 N 帧：
   `{"type":"chat_style","from":"<每帧一个不同的随机 device_id>","to":null,"style":"<任意长度字符串>"}`
   - `to: null` ⇒ 走「广播」分支，`handle_messaging.rs:19` 的 `if let Some(t) = &to` 不触发 ⇒ 直接通过。
   - `from` 不与 `peer_id` 比较 ⇒ 任意值都接受。
3. 每帧在 `handle_messaging.rs:26-34`：`db::get_setting("chat_peer_styles")` 读出**整张表** → JSON 解析 → `map.insert(from, style)` → `serde_json::to_string` 序列化**整张表** → `db::set_setting` **整张表回写**。
4. 结果：`settings` 表里 `chat_peer_styles` 这一行的体积随帧数线性增长，而**总写字节数随 N 二次方增长**；`style` 本身还可单帧携带数十 MB（认证后帧上限 `MAX_FRAME` = 64 MiB）。
5. `style` 的键 `from` 可以是**任意好友的 device_id** ⇒ 受害端前端渲染气泡时用的是被攻击者改写的样式（`commands/settings.rs:267` 把整张表发给前端；`api/index.ts:985` 监听 `peer-style-updated`）。

**Evidence:**
```rust
// handle_messaging.rs:15-34
Message::ChatStyle { from, to, style } => {
    if from == state.device_id { return; }               // 只挡「我自己」
    if let Some(t) = &to { if t != &state.device_id { return; } }   // to=null ⇒ 广播，放行
    {
        let dbc = state.db.lock()...;
        let mut map: serde_json::Map<String, serde_json::Value> =
            db::get_setting(&dbc, "chat_peer_styles")
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
        map.insert(from.clone(), serde_json::Value::String(style.clone()));   // ← from 未校验
        if let Ok(json) = serde_json::to_string(&map) {
            db::set_setting(&dbc, "chat_peer_styles", &json).ok();           // ← 整表回写
        }
    }
```
对比同文件 `ChatMessage`（`handle_messaging.rs:50`）：`if from != peer_id { return; }` —— 写法不一致本身就是证据。

**我搜索过、确认**不构成缓解的：
- `style.len()` 上限：**全仓无命中**（grep `style.len()` / `MAX_STYLE`）。
- `content_within_limit`（`commands.rs:32`，50000 字符）：**只用于** `ChatMessage.content`（`handle_messaging.rs:122`）与 Gossip 明文（`gossip.rs:788`），**不覆盖** `ChatStyle.style`。
- `forget_chat_peer_style`（`db/settings.rs:93`）：只在**删好友**时调用（`commands/friends.rs:147`）⇒ 攻击者写的任意 `from` 永不被清理。
- 表级上限：`settings` 表无行大小/键数限制。

**Impact:**
`settings.chat_peer_styles` 无界增长 ⇒ 磁盘占用；O(N²) 写放大 ⇒ 写放大本身成为 CPU/IO 放大器（N=10⁴、style=1 KiB 时累计写入 ≈ 50 GB）；整表还会随每次 `get_settings` 推给前端，撑爆 WebView。

**Confirmation:** static analysis only。

**Fix sketch:**
- 加 `if from != peer_id { return; }`（与 `ChatMessage` 对齐）。
- `style` 加长度上限（复用 `MAX_MESSAGE_LEN` 量级），超限丢弃并记日志。
- 落库改成增量（按 `from` 分行存，而不是整张表序列化回写），或对表大小设上限。

**Regression test:** `network/transport/handle_messaging_tests.rs` ——「`from != peer_id` 的 `ChatStyle` 被丢弃，`chat_peer_styles` 不变」；「`style` 超过上限被丢弃」。

---

## SEC-05 — 中继授权默认 `All`：任何对端都可把本机当转发器，且无速率限制

**Severity (your assessment):** Low
**Status:** Confirmed
**Location:** `src-tauri/src/mesh/relay_policy.rs:29-32`、`src-tauri/src/mesh/relay_policy.rs:122-136`、`src-tauri/src/network/transport.rs:1068-1083`

**What:**
数据面中继闸 `relay_denied` 存在且正确（`decide_relay_from_peer` 的授权主体是**链路对端**，不是自报字段 —— 这一半是对的），但默认策略是 `All`，含义是「替所有通过验签的对端转发」，**不做任何好友/白名单判断**。这本身是 ADR-0016 明示的取舍（保持既有传播语义），但它意味着：默认配置下，任何能在 LAN 上完成 TOFU 握手的陌生节点，都能驱动受害端替第三方转发 `ShareFileRequest`/`RelayChunk`/`OpaqueExternal`（单帧上限 256 KiB，`MAX_OPAQUE_TTL`=16，路由 fanout=6、ttl=4 ⇒ 多跳放大）。

**Attack path:**
1. 攻击者以任意 device_id 完成 TOFU TCP 握手（无需好友身份）。
2. 发 `Message::OpaqueExternal { id, ttl, payload }`（payload ≤ 256 KiB，`protocol.rs:2327`）⇒ `handle_message`（`transport.rs:1166`）→ `validate_opaque_external` 通过 → `relay_denied(state, peer_id, ...)` → 默认 `All` ⇒ 放行 → `choose_fanout` 选 ≤6 个邻居转发。
3. 同理 `Message::RelayChunk` / `Message::ShareFileRequest` 走定向借道（`transport.rs:1090-1107`）⇒ 默认 `All` ⇒ 放行。
4. 无任何按对端的转发速率限制 ⇒ 单个对端可持续驱动。

**Evidence:**
```rust
// relay_policy.rs:29-32
    /// 替所有通过验签的邻居转发 —— **默认值，与今天的行为一致**。
    #[default]
    All,
```
```rust
// relay_policy.rs:122-136 —— All 分支直接 true，连好友表都不查
pub fn decide_relay_from_peer(config: &RelayConfig, requester_peer_id: &str, is_friend: impl FnOnce() -> bool) -> bool {
    match config.policy {
        RelayPolicy::All => true,
        RelayPolicy::Off => false,
        RelayPolicy::Friends => config.needs_friend_lookup() && is_friend(),
        RelayPolicy::Allowlist => config.needs_allowlist_lookup() && config.allowlist_contains(requester_peer_id),
    }
}
```
```rust
// transport.rs:1068-1076 —— 闸本身正确：授权主体是链路对端 peer_id
fn relay_denied(state: &Arc<AppState>, peer_id: &str, why: impl FnOnce() -> String) -> bool {
    let cfg = state.relay_policy_config();
    let allowed = crate::mesh::relay_policy::decide_relay_from_peer(&cfg, peer_id, || {
        let dbc = state.db.lock()...; db::get_friend(&dbc, peer_id).is_some()
    });
```

**我搜索过、确认**不构成缓解的：
- 转发速率限制：**不存在**。
- `MAX_RELAY_CIRCUITS`(8)：只管**公网中继电路**，管不到「本机作为数据面转发器」。
- 载荷上限：`MAX_OPAQUE_PAYLOAD`=256 KiB、`MAX_OPAQUE_TTL`=16、`validate_opaque_external`（`protocol.rs:2337`）只限单帧大小，不限总量。

**Impact:**
受害端被当作第三方流量的免费中继（带宽/电量/流量计费），并把攻击者选定的载荷扩散到它的邻居；`All` 下该行为对**陌生对端**同样开放。

**Confirmation:** static analysis only。注意：默认值为**有意设计**（ADR-0016 有明示），故定级 Low；但「陌生对端即拥有转发权 + 无速率限制」这一组合未见文档记载。

**Fix sketch:** 至少给数据面转发加**按对端的速率/带宽配额**；或把 `All` 收窄为「至少是好友」而保留 gossip 层的 `All`（保持群消息传播语义不变）。

**Regression test:** `mesh/relay_policy_tests.rs` ——「`All` 策略下陌生对端仍被放行（钉住现状）」+「加配额后超额请求被拒」。

---

## SEC-06 — 入站 `UserInfo` 的 `avatar`/`nickname` 无长度上限 ⇒ 落 `friends`/`conversations` 表并反复推给前端

**Severity (your assessment):** Low
**Status:** Confirmed
**Location:** `src-tauri/src/network/transport/handle_identity.rs:143-176`、`src-tauri/src/network/transport/peer_state.rs:13-29`

**What:**
本机上传自己的头像走 `update_profile`（`commands/system.rs:34`），有 2 MiB 上限（`MAX_AVATAR_BYTES`）与 40 字昵称上限（`MAX_NICKNAME_LEN`）。但**入站** `Message::UserInfo` 没有对应校验：`avatar`/`nickname` 原样进 `upsert_peer`（内存 `peers` 表）、`maybe_update_friend` → `db::add_friend`（`friends.avatar`）、`update_conversation_profile`（`conversations.avatar`），并随 `peers-updated` 事件整表推给前端。

**Attack path:**
1. 攻击者（作为**已有好友**，或借助 SEC-01 变成好友）连上 TCP 链路。
2. 发 `{"type":"user_info","device_id":"<攻击者 id>","nickname":"<数十 MB>","avatar":"<数十 MB 的 data URI>","device_type":"x"}` —— `handle_identity.rs:149` 只校验 `device_id == peer_id`。
3. `avatar` 被写进 `friends.avatar`（持久化）与 `conversations.avatar`，并驻留在 `peers` 表内存里。

**Evidence:**
```rust
// handle_identity.rs:143-175
Message::UserInfo { device_id, nickname, avatar, device_type } => {
    if device_id != peer_id { return; }
    ...
    upsert_peer(state, &device_id, &nickname, avatar.clone(), ...).await;   // ← 无长度校验
    maybe_update_friend(state, &device_id, &nickname, avatar.clone());        // → db::add_friend
    db::update_conversation_profile(&dbc, &device_id, &nickname, avatar.as_deref()).ok();
}
```
```rust
// commands/system.rs:44-49 —— 只有本机上传路径有上限
if let Some(a) = &avatar {
    if avatar_decoded_len(a) > MAX_AVATAR_BYTES { return Err("头像过大…".to_string()); }
}
```

**我搜索过、确认**不构成缓解的：
- `MAX_AVATAR_BYTES` / `MAX_NICKNAME_LEN`：只在 `commands/system.rs`（本机上传）出现，入站路径无引用（grep `MAX_AVATAR_BYTES` 仅 2 处命中，均在 `commands.rs` / `system.rs`）。
- `content_within_limit`：只管聊天正文。

**Impact:**
好友（或借助 SEC-01 的陌生对端）可让受害端数据库与内存里存入数十 MB 的头像/昵称，并被反复经 IPC 推给前端；磁盘与前端内存压力。

**Confirmation:** static analysis only。

**Fix sketch:** 入站 `UserInfo` 复用 `MAX_AVATAR_BYTES` / `MAX_NICKNAME_LEN` 判据，超限丢弃该字段（而非整帧）。

**Regression test:** `network/transport/handle_identity_tests.rs` ——「入站 3 MiB 头像 ⇒ `friends.avatar` 未被写入超限内容」。

---

## SEC-07 — `handle_datagram` 的 announce 分支把**对端自报的 `tcp_port`** 用作回拨目标

**Severity (your assessment):** Low
**Status:** Needs verification
**Location:** `src-tauri/src/network/discovery.rs:625-652`

**What:**
announce 包里的 `tcp_port` 完全由发送方决定，`handle_datagram` 把它与数据报的**源 IP**一起交给 `ensure_link` → `connect_to_peer` → `TcpStream::connect`。于是受害端会对「(源 IP, 自报端口)」发起 TCP 连接。源 IP 在同网段可被伪造（UDP 源地址不校验），端口任意 ⇒ 受害端可被诱导去连内网任意主机的任意端口。

**Attack path:**
1. 攻击者从伪造源地址 `10.0.0.5` 向受害端 UDP 发现端口发 announce：`device_id` 取一个**字典序小于**受害端 device_id 的串（使 `should_dial` 的 `my_id > peer_id` 成立，`dial.rs:277-279`），`tcp_port` 填目标端口。
2. `discovery.rs:650-652` → `ensure_link`（`dial.rs:283`）→ `socket_addr_from(ip, tcp_port)`（`dial.rs:291`）→ `connect_to_peer` → `TcpStream::connect(10.0.0.5:<port>)`。
3. 若受害端有到该地址的路由（典型内网），连接尝试发生。

**Evidence:**
```rust
// discovery.rs:648-652 —— 端口来自包体，IP 来自数据报源地址
let ip = src.ip().to_string();
let port = pkt.tcp_port;
tokio::spawn(async move { ensure_link(&state, &device_id, &ip, port, shutdown).await; });
```
```rust
// dial.rs:277-279 —— 大 ID 方恒拨，攻击者用小 id 即可触发
if my_id > peer_id {
    return true;
}
```

**我搜索过、确认**不构成缓解的：
- 源地址校验：UDP 层无（`recv_from` 返回即信任）。
- `is_virtual_ip`（`ensure_link` 内）：只挡 `100.64/10`、`169.254/16`、`198.18/15`，**不挡**普通内网段。

**未证实的部分：** 源 IP 伪造在目标网络是否可用（取决于网络是否做 ingress filtering / uRPF），以及受害端是否真的有到该地址的路由。两者都依赖部署环境 ⇒ 标 needs verification。**在攻击者使用自己真实 IP 的情况下**，该原语退化为「受害端回连攻击者指定的端口」，价值有限。

**Confirmation:** static analysis only；未验证目标网络的源地址伪造可行性。

**Fix sketch:** `ensure_link` 忽略 announce 自报的 `tcp_port`，或只接受「与上次已知值一致」的端口；源地址不可信时不要用它做回拨目标。

**Regression test:** `network/transport/dial_tests.rs` ——「announce 自带 `tcp_port` 与对端实际监听端口不一致 ⇒ 不以自报端口拨号」。

---

## SEC-08 — 入站帧的**聚合**驻留内存无全局配额：`MAX_INBOUND_CONNECTIONS(128) × MAX_FRAME(64 MiB) ≈ 8 GiB`

**Severity (your assessment):** Informational
**Status:** Confirmed
**Location:** `src-tauri/src/transport/tcp.rs:84-125`、`src-tauri/src/protocol.rs:16`

**What:**
`read_bytes_capped` 的**校验在前、分配在后**这一纪律是正确的（长度前缀声明 64 MiB 不会立刻换来 64 MiB 常驻，**单条连接**没有「声明即占用」的问题）。真正的缺口在**聚合**：认证后的帧上限是 `MAX_FRAME` = 64 MiB（`protocol.rs:16`），而入站连接数上限是 `MAX_INBOUND_CONNECTIONS` = 128（`state.rs:927`）⇒ 128 条连接各自持有一帧 64 MiB 的驻留内存 ≈ 8 GiB，**全局没有任何配额**。代码注释自己已经承认这个聚合值「没人管过」（`tcp.rs:100-110`）。

**Evidence:**
```rust
// tcp.rs:93-117 —— 校验在前 ✓、按实际到达字节增长 ✓
let len = u32::from_be_bytes(len_buf) as usize;
if len == 0 || len > max { return Err(...InvalidData...); }
...
let mut buf = Vec::with_capacity(len.min(PREALLOC_CAP));   // 预分配上限 64 KiB
r.take(len as u64).read_to_end(&mut buf).await?;
```
```rust
// tcp.rs:100-105 —— 项目自己写下的已知缺口
// ★ 只计量，不拒绝（负责人 2026-10-26 拍板"先补读数，再动手）：按**声明长度**预约这个数，
//   因为这里要看的就是"对端一句话让我们最多可能同时握着多少字节"——那正是
//   `MAX_INBOUND_CONNECTIONS(128) × MAX_FRAME(64MiB)` 那个没人管过的聚合值。
```
```rust
// protocol.rs:16
pub const MAX_FRAME: usize = 64 * 1024 * 1024;
```

**我搜索过、确认**不构成缓解的：
- 聚合上限：无。
- `mem_diag::FrameReadGauge`（`tcp.rs:110`）：**只计量不拒绝**（注释自述）。

**Impact:**
单机可被诱导持有远超预期的内存（需要真的传输那么多字节，属带宽受限型）。这是**已知并被记录**的缺口，不作为新缺陷。

**Confirmation:** static analysis only。

**Fix sketch:** 给「全部入站连接的在途帧字节」加一个全局配额（超过即拒收新帧/断链）。

**Regression test:** `transport/tcp_tests.rs` ——「N 条连接各持一帧时，全局在途字节超过配额 ⇒ 新帧被拒」。

---

## SEC-09 — 中继记录层的「解密后明文」队列：~~可无界累积~~ ⇒ **实测被 `poll_read` 的排空顺序钉住，撤回**

**Severity (your assessment):** Informational（**前提经实测证伪 ⇒ 撤回**）
**Status:** Withdrawn（前提被实测否定；机制本身正确但结论不成立）
**Location:** `src-tauri/src/transport/relay_seal.rs:555-593`（`OpenPipe::absorb_encrypted`）、`src-tauri/src/transport/tcp.rs:322-372`（`TcpReceiver::poll_read`）

**原假设（已证伪）：**
`OpenPipe.plain`（`VecDeque<u8>`）没有字节上限，而排空速率取决于下游读速 ⇒ 慢速对端可让明文无界累积。

**实测结论：这条不成立。** 决定性的一行在 `poll_read`（`tcp.rs:342-346`）：**先把 `plain` 排空、排到了就立刻返回；只有 `plain` 空了才去读 socket**。于是一条记录的明文在被消费掉之前，**下一条记录根本不会被吸收**（`absorb_encrypted` 只在 `plain` 为空的那一轮被调用）⇒ 队列里最多同时存在**一条**记录的明文。

**Evidence（探针实测，跑在真实的 `OpenPipe` / 真实的 `TcpReceiver` 上）：**
```rust
// tcp.rs:342-346 —— 排空优先，且排到了就 return（这就是那条上限）
let n = pipe.take_plain(buf.initialize_unfilled());
if n > 0 {
    buf.advance(n);
    return Poll::Ready(Ok(()));     // ← 直接返回，不会再去读 socket
}
```
```
【探针 1：真实 OpenPipe + 真实 poll_read 顺序】
64 条记录 × 64 KiB = 4 MiB 明文推入，消费者每步只排空 4 KiB
⇒ peak plain = 65536 B（= 恰好一条记录），不是 4 MiB

【探针 2：真实 TcpReceiver + 真实带背压的 socket（duplex 16 KiB）】
512 帧 × 64 KiB = 32 MiB 明文推入，读端故意读得慢
⇒ 实测 peak plaintext backlog = 0 B
```
第一个探针用**错误的顺序**（每步先吸收再排空）时会得到 peak = 3.1 MiB（看似无界）；改用 `poll_read` 的真实顺序后 peak 掉到一条记录 —— 这正说明结论对**顺序**敏感，必须按真实顺序测。

**为什么撤回而不是降级：**
「可无界累积」需要一条**无上限的增长路径**（缺 leg b）。实测显示增长被 `poll_read` 的排空顺序**结构性**钉住，不需要额外的字节上限。这与 SEC-08（`MAX_INBOUND_CONNECTIONS × MAX_FRAME` 那个**已被项目自己记录**的聚合值）是两类东西 —— 后者是**真的**无上限，本条不是。

**残余影响（不足以单列为发现，但记在此处备查）：**
单条中继记录的明文仍可到 `MAX_FRAME`（64 MiB）——但那是 `relay_seal.rs:567` 明确校验过的**记录长度上限**，且与 SEC-08 记的是同一个聚合值。

**Confirmation:** **已执行**（探针跑在真实的 `OpenPipe` / `TcpReceiver` 上，用真实的 `RecordSeal` 对端与带背压的 socket；两个探针文件测完即删，工作区已还原）。

**Fix sketch:** 无需修复。若要加固，可给 `plain` 加一条**显式**字节上限（把当前的「顺序隐式保证」变成「代码显式保证」），避免将来有人调整 `poll_read` 的排空/读取顺序时静默失去这条上限。

**Regression test:** `transport/relay_seal_tests.rs` ——「连推 64 条记录而下游不读 ⇒ `plain` 长度不超过一条记录的大小」。

---

## SEC-10 — `RelayChunk` 的中继分支用 `to`（自报字段）做定向转发目标

**Severity (your assessment):** Informational
**Status:** Confirmed
**Location:** `src-tauri/src/network/transport/relay_file.rs:534-561`

**What:**
`handle_relay_chunk` 的转发分支把帧里的 `to` 原样交给 `try_send`，即受害端会替攻击者把分片送到**任意 device_id**（只要有链路）。授权由 `relay_denied` 控制，默认 `All` ⇒ 放行（见 SEC-05）。

**Evidence:**
```rust
// relay_file.rs:534-556
} else if ttl > 1 {
    if relay_denied(state, requester, || format!(" RelayChunk 转投 tid={transfer_id}")) { return; }
    let fwd = Message::RelayChunk { transfer_id, seq, data, from, to: to.clone(), ttl: ttl - 1 };
    if let Err(e) = try_send(state, &to, &fwd).await { ... }
```

**我搜索过、确认**不构成缓解的：
- `to` 是否是好友：**不检查**（`relay_file.rs` 这条分支没有 `is_friend`）。
- 终局接收方 `handle_relay_file_offer`（`relay_file.rs:6-150`）**有** `is_friend(from)` 检查 ⇒ 攻击者自己收不到内容（拿不到 `file_key`）。
- `relay_denied`：默认 `All` ⇒ 放行（SEC-05）。

**Impact:**
受害端被当作任意定向分片的转发器（内容拿不到，但带宽/流量被消耗）。

**Confirmation:** static analysis only。

**Fix sketch:** 转发分支也校验 `to` 是本机已知节点（至少 `state.peers` 里有），并纳入 SEC-05 的速率配额。

**Regression test:** `network/transport/relay_file_tests.rs` ——「`to` 是陌生 device_id 时不转发」。

---

## SEC-11 — `Message::OpaqueExternal` 的 `id`/`payload` 进入 Bloom 去重表，攻击者可用随机 id 冲刷去重表

**Severity (your assessment):** Informational
**Status:** Confirmed（前提与可达性均已实测确认；**真实后果被落库幂等闸压住**，见下）
**Location:** `src-tauri/src/network/transport.rs:1166-1207`、`src-tauri/src/mesh/router.rs:176-192`、`src-tauri/src/gossip_engine.rs:52-61`

**What:**
`OpaqueExternal` 的 `id` 由发送方任意指定（≤128 字符，`protocol.rs:2339`），并被 `router.on_receive` → `is_new_frame` 写进 Bloom + LRU 去重表（容量 100 000 / 10 000，`state.rs:2222`）。攻击者可用大量随机 id 挤掉真帧的去重记录。

**实测（探针跑在真实的 `MeshRouter` / `GossipEngine` 上）：**
```
L1 (MeshRouter)  被冲刷：100 165 个攻击者 id 后，合法帧的去重记录失效
L2 (GossipEngine) 被冲刷：100 158 个攻击者 id 后，合法帧的去重记录失效
冲刷后：L1 把合法帧当新帧 = true；L2 把合法帧当新帧 = true
```
⇒ **前提成立**：两个去重层都能被冲刷，冲刷后同一条合法帧在**两层**都会被当成首次见到。

**但冲刷的可达性要分开说（这是本条最关键的一层）：**
- **L1（MeshRouter）易冲刷**：`OpaqueExternal` 的 `id` 只要满足「≤128 字符 + 字符集 `[A-Za-z0-9_.:-]`」即可（`protocol.rs:2339-2346`），**攻击者自己构造互不相同的 id** 即可，无需任何密钥。
- **L2（GossipEngine）需要签名**：它的键是 `env.message_id` = `SHA-256(sender_id || nonce || payload)`（`protocol.rs:1676-1683`），三者都是发送方可控 ⇒ 互不相同的 id 依然是白送的；但信封必须先过 `verify_envelope`（签名自洽，`gossip_engine.rs:219-229`）与 `sender_trusted`（`gossip.rs:211-244`）。
  ⇒ **不需要冒充任何人**：攻击者用自己的 `device_id` + 自己的密钥签名即可通过（`peers` 里查得到自己），所以这一层**也是可达的**。

**Evidence:**
```rust
// mesh/router.rs:181-186
if self.seen.contains(frame_id) || self.bloom.contains(frame_id) { return false; }
self.bloom.insert(frame_id);
self.seen.insert(frame_id.to_string());
```
```rust
// gossip_engine.rs:52-61 —— Bloom 满了整体轮换清零（这是它「不永久误判」的原因，
// 但也正是「一次冲刷抹掉全部历史记录」的原因）
pub fn insert(&mut self, data: &str) {
    if self.count >= self.capacity {
        self.bits.fill(0);
        self.count = 0;
    }
    ...
}
```

**我搜索过、确认**不构成缓解的：
- `id` 必须是稳定/可推导的：**没有**校验（只查长度与字符集）。
- Bloom 轮换**不是**缓解：它把「永久误判」换成了「**一次冲刷清空全部历史**」。

**实测确认的残余影响（这条限制真实后果，但把量级压住了）：**
冲刷后合法帧会被**再次转发**（L1 失效 ⇒ 重复转发），并可能**再次进入消费路径**（L2 失效）。但落库那一步仍被一道**独立的幂等闸**挡住：`db::insert_message_if_new`（`db/messages.rs:28-39`）用 `WHERE NOT EXISTS (SELECT 1 FROM messages WHERE msg_id = ?1)` ⇒ **同一 msg_id 不会产生第二行**；且 `announced_on`（`transport.rs:1290-1292`）只在 `Ok(true)` 时才发通知/计未读 ⇒ **重复消费不会变成重复消息行或重复通知**。
⇒ 真实后果是：**重复转发（带宽/放大）** + **重复处理（CPU）**，**不是**消息重复投递。

**Confirmation:** **已执行** —— 探针跑在真实的 `MeshRouter` / `GossipEngine` 上，测出冲刷成本（L1 = 100 165、L2 = 100 158 个 id）与冲刷后两层都把合法帧当新帧；另跑了既有的 `db::insert_message_if_new_distinguishes_first_from_duplicate`（通过）确认落库幂等。探针文件测完即删，工作区已还原。

**Fix sketch:** `OpaqueExternal` 的 `id` 加上「与发送方绑定」的构造要求（如 `sha256(sender_id||nonce)`），或只允许已登记的对端使用该帧类型；把「一次冲刷清空全部历史」改成「分段轮换」。

**Regression test:** `mesh/router_tests.rs` ——「用随机 id 冲刷后，合法帧的去重行为仍正确」。

---

## SEC-12 — `handle_group_file_offer` 的 `name` 未在入库前消毒（群文件名的显示层）

**Severity (your assessment):** Informational
**Status:** Confirmed
**Location:** `src-tauri/src/network/transport/group_file.rs:268-297`、`src-tauri/src/network/transport/group_file.rs:385-397`（`ensure_group_file_row`）、`src-tauri/src/network/file/group_receive.rs:18-76`

**What:**
群文件 `name` 与 1:1 路径不同：1:1 在 `make_receiver` 里用 `safe_file_name` 挡住路径分隔符；群路径上 `name` 直接进 `ensure_group_file_row` → `group_files.name` 列，**没有** `safe_file_name` 校验。

**但落盘路径是安全的**（这一点我逐层确认过，见 Evidence）⇒ 本条**不是路径穿越**，残留影响仅限「库里/UI 里显示一个奇怪的文件名」。

**Attack path:**
1. 攻击者作为**群成员**（`sender_id == peer_id` 且 `sender_id ∈ group.members`，`group_file.rs:283-310`）发一条 `GroupFileOffer`，`name` 为任意字符串（含 `/`、控制字符、超长）。
2. `handle_group_file_offer`（`group_file.rs:268`）只过 `safe_transfer_id`（`:288`）⇒ 通过。
3. `ensure_group_file_row`（`:385`）→ `group_files.name` = 原始 `name`（`:231`）⇒ **入库**。
4. 同一份 `name` 还进 `create_group_file_receive_bubble`（`:399`）⇒ 前端气泡显示它。
5. 落盘阶段：`begin_group_receive`（`:626` / `:993` / `:2001`）→ `make_receiver`（`receive.rs:799`）→ **`safe_file_name(name)`（`receive.rs:809`）失败即返回 `Err("文件名非法")`** ⇒ 接收器根本建不起来 ⇒ **不会落盘**。续传重建路径 `build_group_resume_receiver`（`group_receive.rs:97`）同样有 `safe_file_name`。

**Evidence:**
```rust
// group_file.rs:288 —— 只消毒 transfer_id，name 未过 safe_file_name
let Some(transfer_id) = file::safe_transfer_id(&transfer_id) else { ...; return; };
```
```rust
// group_file.rs:227-240 —— name 原样进表
let gf = crate::state::GroupFile { ..., name: name.to_string(), ... };
db::upsert_group_file_receive(&dbc, &gf, &state.device_id).is_ok()
```
```rust
// receive.rs:809 —— 落盘侧的安全网：文件名非法 ⇒ 直接失败，不建接收器、不写盘
let safe_name = safe_file_name(name).ok_or("文件名非法")?;
```
```rust
// group_receive.rs:97 —— 群续传重建路径同样过 safe_file_name
let safe_name = safe_file_name(name).ok_or("文件名非法")?;
```

**我搜索过、确认**不构成缓解的：
- `safe_file_name` 在群文件**入库**路径上的调用：群侧**没有**（只有落盘侧有）⇒ `group_files.name` 列可以存任意字符串。

**已排除的假设（路径穿越不成立）：** 群文件的落盘文件名来自 `make_receiver` 的 `safe_name` 与 `unique_path`，临时文件按 `transfer_id`（白名单 `{A-Za-z0-9_-}{1,64}`）命名（`receive.rs:847`）⇒ **不存在**路径穿越或写入任意路径。

**Impact:**
`group_files.name` 与聊天气泡里出现任意字符串（超长 / 含控制字符 / 含路径分隔符），影响 UI 渲染与后续任何「按名字找文件」的逻辑；**不影响**文件系统。

**Confirmation:** static analysis only（已逐层确认落盘路径：`handle_group_file_offer` → `begin_group_receive` → `make_receiver` → `safe_file_name`，以及续传重建 `build_group_resume_receiver` → `safe_file_name`）。

**Fix sketch:** `handle_group_file_offer` 入库前对 `name` 也跑一次 `safe_file_name`（与 1:1 对齐）。

**Regression test:** `lib_file_tests.rs` ——「`name` 含 `/` 的群文件 Offer 被拒或名字被净化」。

---

### Attack surface summary（攻击面总结：未信任网络可达入口清单）

图例：**A1** 本地用户 ｜ **A2** IPC（前端）｜ **A3** 好友 ｜ **A4** 本机管理员 ｜ **A5** 陌生人/群友 ｜ **A6** 设备丢失的持有者 ｜ **A8** 恶意好友 ｜ **A9** 不可信 LAN 节点 ｜ **A10** 中继/服务器 ｜ **A11** 本机上的其他用户

| # | 入口（文件:行） | 攻击者 | 我找到的控制 |
|---|---|---|---|
| 1 | TCP accept → 首帧 Hello（`network/transport.rs:585-651`） | A9 | ✅ `MAX_INBOUND_CONNECTIONS`=128 许可；✅ `FIRST_FRAME_TIMEOUT_SECS`=10s 超时；✅ `MAX_PREAUTH_FRAME`=64 KiB 预认证上限；✅ `read_bytes_capped` 先校验后分配；✅ Hello 验签 + nonce 一次性 + `mark_peer_keys_verified`；⚠️ TOFU 允许自选 device_id（设计内） |
| 2 | TCP 已建链帧 → `handle_message`（`network/transport.rs:1085`） | A9/A5 | ✅ 逐族判据（`from==peer_id`、好友检查、`content_within_limit`）；❌ `ChatStyle` 未绑 `peer_id` 且 `style` 无上限（**SEC-04**）；❌ `FriendAccept` 无申请前置（**SEC-01**）；⚠️ `UserInfo` 头像/昵称无上限（**SEC-06**） |
| 3 | `Message::FriendAccept` / `FriendRequest`（`handle_identity.rs:177-229`） | A9 | ✅ `from==peer_id`、`to==device_id`；❌ 缺「本机申请过」前置（**SEC-01**）；✅ `pending_requests` 去重防通知刷屏 |
| 4 | `Message::ChatMessage` / `Ack` / `ReadReceipt`（`handle_messaging.rs:41-296`） | A5/A8 | ✅ `from==peer_id` + `to==device_id`；✅ 非好友不落库并回 `FriendMessageBlocked`；✅ `content_within_limit`（50000 字符）；✅ `ack_delivered` 事务内校验目标 |
| 5 | `Message::UserInfo`（`handle_identity.rs:143-176`） | A8/A9 | ✅ `device_id==peer_id`；⚠️ 头像/昵称无长度上限（**SEC-06**） |
| 6 | `Message::FileOffer` / `FileChunk` / `FileDone`（`handle_file.rs:14-282`） | A8 | ✅ 好友闸；✅ `safe_file_name` + `safe_transfer_id`；✅ `valid_sha256_hex`；✅ `file_key` AEAD 解封失败即拒；✅ `admit_inbound` 三道配额闸（并发 8 / 单文件 8 GiB / 总量 16 GiB / 保留 16 GiB）+ 卷余量预检；✅ `chunk_exceeds_declared` 写前判大小；✅ 收尾前比 SHA-256（空期望值 fail-closed）；✅ `place_unique` 用 `hard_link` 原子占名（无 exists→rename 覆盖窗口）；✅ `FileCancel` 认人（`from==ledger peer==peer_id`） |
| 7 | 群文件 Offer/Chunk/Done/Cancel/Resume（`network/transport/group_file.rs`） | A5/A8 | ✅ `sender_id==peer_id`；✅ 群存在 + 发送者是群成员；✅ `file_key` 需群密钥解封；✅ `safe_transfer_id`（Offer L288、Cancel L78、Resume L674 三处）；✅ 落盘经 `make_receiver` → `safe_file_name`（`receive.rs:809`）⇒ **无路径穿越**；✅ 收尾前比 SHA-256；⚠️ `name` 入库前未过 `safe_file_name`（**SEC-12**，仅显示层） |
| 8 | 中继文件 Offer/Chunk（`network/transport/relay_file.rs`） | A9 | ✅ `to==device_id` 才收；✅ `is_friend(from)`；✅ `safe_file_name`（L28）+ `safe_transfer_id`（`file_relay.rs:142`）；✅ 落盘前比 SHA-256 + 大小双检；⚠️ 转发分支 `to` 不校验（**SEC-10**） |
| 9 | `Message::OpaqueExternal`（`network/transport.rs:1166-1234`） | A9 | ✅ `validate_opaque_external`（id ≤128、ttl ≤16、payload ≤256 KiB）；✅ `relay_denied` 授权闸；✅ `router.on_receive` TTL 裁剪 + 去重；⚠️ `id` 可冲刷去重表（**SEC-11**，实测冲刷成本 ≈10 万 id；真实后果限于重复转发/重复处理，落库幂等闸挡住重复消息行） |
| 10 | UDP announce / who_has（`network/discovery.rs:585-674`） | A9 | ✅ `verify_announce`（带签名但验不过 ⇒ 拒）；⚠️ 无签名（Legacy）也接受；❌ `peers` 表无上限 + 300ms 全表 IPC（**SEC-02**）；⚠️ 自报 `tcp_port` 参与回拨（**SEC-07**） |
| 11 | Gossip 信封（`network/transport/gossip.rs:197-950`） | A5/A9 | ✅ 先验签再登记去重表（`gossip.rs:261-268`）；✅ `peer_anchor` 比对 `peers` 表公钥；✅ 群成员表参与消费判据；⚠️ 锚点**不检查 `keys_verified`**（**SEC-03**） |
| 12 | 定向借道 / 中继转发（`network/transport.rs:1090-1107`） | A9 | ✅ `relay_denied` 闸（授权主体=链路对端）；⚠️ 默认 `All` + 无速率限制（**SEC-05**） |
| 13 | 共享目录树 / 按路径取文件（`network/transport/handle_share.rs:273-440`） | A8 | ✅ 双好友判定（`from` 与 `peer_id` 都须为好友）；✅ `resolve_shared_file` 用 `canonicalize` + `starts_with` 挡 `..` 与符号链接；✅ 每对端有界串行队列（`FILE_SERVICE_QUEUE_CAP`） |
| 14 | 内容寻址拉取（`ContentRequest`，`handle_share.rs:187-272`） | A8 | ✅ `content_serve_allowed`（好友 或 群成员）；✅ cid 命中本机真实内容；⚠️ 依赖 SEC-01 修复后 `is_friend` 才可靠 |
| 15 | BLE 分片重组（`transport/ble_framing.rs:266-333`） | A5 | ✅ `count` ≤8192、`index<count`；✅ 在途消息 ≤8；✅ 单消息 ≤512 KiB（累计字节计数）；✅ 重复片幂等丢弃；✅ TTL 30s 回收；✅ 首个 Hello 前丢帧不处理（`central.rs:700`） |
| 16 | BLE 链路握手（`network/ble/central.rs:525-632`、`peripheral.rs:461-561`） | A5 | ✅ `verify_hello_for_ble` 复用同一套判据；✅ `should_accept_inbound_public` 复用入站去重；✅ 与 TCP 同一 `MAX_LINKS_PER_PEER` |
| 17 | 中继协商 / 记录层（`transport/relay_seal.rs:236-401`） | A10 | ✅ `accept_wrap_offer` 用**本地绑定**的 Ed25519 验签（不信任自报公钥）；✅ role 按 ID 字典序锁定；✅ `channel_hex` 参与签名材料；✅ 记录计数器严格 `expect+1`（不可重放/乱序）；✅ nonce = 计数器（同一密钥内不重复）；✅ 明文队列 `plain` 实测被 `poll_read` 的排空顺序钉住在**一条记录**以内（**SEC-09 已撤回**）；✅ 电路数 `MAX_RELAY_CIRCUITS`=8 |
| 18 | 中继电路建立（`network/transport/relay.rs:186-347`） | A10 | ✅ 只对**已绑定 Ed25519** 的好友建电路（`list_bound_friend_identities` 排除 NULL）；✅ `MAX_RELAY_CIRCUITS`=8 + `InflightGuard` |

---

# 已检查且确认安全（明确覆盖，避免重复审计）

**TCP 分帧 / 入站闸**
- `read_bytes_capped`（`transport/tcp.rs:84-125`）：**先校验长度前缀、再分配**；预分配封顶 64 KiB（`PREALLOC_CAP`），按实际到达字节增量增长 ⇒ 4 字节长度前缀换不来 64 MiB 常驻。**聚合值**问题见 SEC-08（已知缺口）。
- `read_frame_preauth`（`network/transport/outbound.rs:103-108`）：预认证帧上限 `MAX_PREAUTH_FRAME`=64 KiB；且**刻意不做**未知帧降级（首帧必须是 Hello）。
- `decode_frame`（`outbound.rs:78-91`）：未知 `type` 降级为 `Message::Unknown` 而非拆链（跨版本兼容），且只有「unknown variant」才降级，已知类型字段畸形仍报错。
- `write_bytes`（`transport/tcp.rs:51-70`）：长度与 `MAX_FRAME` 双检；小帧合并写不改线上字节格式。
- 入站闸的其余部分：`MAX_INBOUND_CONNECTIONS`=128（许可信号量，`transport.rs:266`）、`FIRST_FRAME_TIMEOUT_SECS`=10s、`MAX_LINKS_PER_PEER`=6、`dial_permits`=16、`DialGuard` 在途去重、`generation_is_current` 跨世代丢弃。

**文件传输接收路径（重点核查项）**
- **路径穿越**：`safe_file_name`（`network/file/share_walk.rs:307-316`）挡 `/`、`\`、`.`、`..`、NUL；`safe_transfer_id`（`:325-336`）用白名单 `[A-Za-z0-9_-]{1,64}`。两个函数在**所有**落盘点前被调用：1:1 建接收器（`receive.rs:809-811`）、1:1 续传（`receive.rs:176-180`）、中继重组（`file_relay.rs:142`）、群文件 Offer（`group_file.rs:674`）、群文件 Cancel（`group_file.rs:78`）、群续传（`group_receive.rs:98`）。`Path::join` 遇绝对路径会整体替换前缀这一点也被白名单一并挡掉。
- **符号链接**：共享目录路径用 `canonicalize` + `starts_with`（`handle_share.rs:79-86`，注释明确「不回退词法比较」）⇒ 指向目录外的符号链接被拒。
- **大小上限 vs 实际写**：写入前判 `chunk_exceeds_declared`（`receive.rs:1019-1021`）；入站有三道闸（`admit_inbound`，`receive.rs:599-667`）：并发接收 ≤8、单文件 ≤8 GiB、在途总量 ≤16 GiB、保留 `.part` ≤16 GiB，另有磁盘余量预检（`storage/disk_space.rs`）。中继路径额外有「末片形状」三判据（`file_relay.rs:193-210`）。
- **分片哈希是否真的在标记完成前校验**：1:1（`receive.rs:1462-1499`）、群（`group_receive.rs:297-334`）、中继（`relay_file.rs:337-406`）三处**都在 rename/落库之前**做全量 SHA-256 比对，且期望值为空时 fail-closed。
- **temp→final 的 TOCTOU**：`place_unique`（`share_walk.rs:355-388`）用 `hard_link` 原子占名（目标已存在则失败），失败才退到 `unique_path`+`rename`；避免了 `exists()`→`rename()` 的覆盖窗口。
- **覆盖任意文件**：落盘名一律经 `unique_path`/`place_unique`，不覆盖既有文件。
- `FileCancel` 认人（`handle_file.rs:636-660`）：要求 `from == 台账里的 peer == 链路 peer_id` ⇒ 传输 id 不是秘密也不能被第三方用来取消。

**密码学与身份**
- `crypto::seal/open`（`crypto.rs:83-102`）：ChaCha20-Poly1305，12 字节随机 nonce（`OsRng`），格式 `nonce||ct`；`open` 先判长度再解密。
- `shared_secret`（`crypto.rs:75-80`）：X25519 输出直接作密钥，输出长度校验（`try_into` ⇒ 非 32 字节即失败）。
- **nonce 重放**：Hello nonce 在**验签通过之后**才消费（`handshake.rs:106-115`，注释明确说明顺序理由），且是 512 条有界 FIFO。
- **验签顺序**：`hello_auth_decision` 先比对绑定公钥再验签；TOFU 分支只用自报公钥（首次接触的固有性质，非缺陷）。
- **TOFU 降级**：`bound_ed25519_from_peer` 要求 `keys_verified`，防止未签名 announce 抢占绑定（**Gossip 侧缺同一条判据见 SEC-03**）。
- **重放窗口**：`MeshRouter::on_receive`（`mesh/router.rs:202-241`）先裁 TTL 再登记去重，且 TTL=0 的帧**不烧去重槽**（回归测试 `zero_ttl_frame_does_not_burn_the_dedup_slot` 钉住）。
- **常数时间**：签名验证交给 `ed25519-dalek`（`vk.verify`），本仓无自实现的签名比较。
- **RNG**：`OsRng` 用于 nonce/密钥/随机 token（`crypto.rs:86`、`handshake.rs:699`）。

**BLE 分帧**
- `BleReassembler::push`（`transport/ble_framing.rs:266-333`）：三条上限**都在分配前**判断（`count` ≤8192、`index<count`、在途 ≤8、累计字节 ≤512 KiB）；重复片幂等丢弃；`count` 不一致整条丢弃；30s TTL 回收。
- BLE 链路在 Hello 验签前丢弃的业务帧不进入 `handle_message`（`network/ble/central.rs:700` 注释明示）。

**中继**
- `accept_wrap_offer`（`transport/relay_seal.rs:271-309`）：用**本地绑定**的 Ed25519 验签（不信自报公钥）、role 由 ID 字典序唯一决定、`channel_hex` 进签名材料 ⇒ 中继服务器无法串线/冒充。
- `RecordOpen::open_record`（`relay_seal.rs:387-401`）：计数器必须**严格等于** `expect+1` ⇒ 不可重放、不可乱序；缺口即断链。
- `RecordSeal::seal_frame`（`:351-369`）：nonce = 4 字节零 + 8 字节计数器，同一密钥内不重复；`checked_add` 防溢出。
- 电路数上限 `MAX_RELAY_CIRCUITS`=8（`network/transport/relay.rs:47`）+ `InflightGuard` 在途名额。
- **中继记录层的明文积压**（原 SEC-09，**实测确认安全**）：`TcpReceiver::poll_read`（`transport/tcp.rs:342-346`）**先排空 `plain`、排到了立刻返回**，只有 `plain` 空了才读 socket ⇒ 一条记录的明文被消费掉之前，下一条记录根本不会被吸收 ⇒ 队列里最多同时存在**一条**记录的明文。
  实测（真实 `OpenPipe` + 真实 `TcpReceiver` + 带背压的 socket）：推入 32 MiB 明文、读端故意读得慢，**peak backlog = 0 B**；按 `poll_read` 的真实顺序在 `OpenPipe` 上单独测，peak = 恰好一条记录（64 KiB）。⇒ 原「无界累积」的结论**不成立**，该条已撤回。

**消息落库的幂等性（这一层挡住了 SEC-11 的真实后果）**
- `db::insert_message_if_new`（`db/messages.rs:28-39`）：按 `msg_id` 幂等（`WHERE NOT EXISTS`），**同一 msg_id 永不产生第二行**；且刻意不用 `OR IGNORE`（否则 `local_id` 唯一冲突会把新消息静默吞掉）。
- `announced_on`（`network/transport.rs:1290-1292`）：只在 `Ok(true)`（真插入）时才发通知/计未读 ⇒ 重复消费**不会**变成重复消息行或重复通知。
- ⇒ 即便内存去重表被冲刷（SEC-11），落库与通知侧仍有独立闸门；真实后果退化为「重复转发 + 重复处理」。

**已知的、刻意不做的事（不是缺陷，但记录在此以免被重复报）**
- 中继策略默认 `All`（ADR-0016 有明示，语义保持）—— 见 SEC-05 的残留风险说明。
- gossip 层源发**不做** fanout 截断（`outbound.rs:465-472` 注释说明：截断会让群成员静默漏发），转发层才截断。
- 群密钥「加人时不轮换」（`commands/groups.rs:260-266` 注释说明：群主离线时轮换会让整群消息永久无法解密）。
