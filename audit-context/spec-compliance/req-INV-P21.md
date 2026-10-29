## REQ-INV-P21 — 链路建立前必须用密码学手段确认对端身份

> "TCP 链路建立**之前**，必须先用密码学手段确认对端确实是 `peer_id` 本人。
> `Hello` 必须携带：
> ```
> nonce  : 每次握手新生成的随机串（防重放）
> sig    : Ed25519 签名，覆盖 device_id | tcp_port | nonce | x25519_pubkey | ed25519_pubkey
> ```
> 接收方校验规则：
> ```
> friends / peers 中已绑定该 device_id 的 Ed25519 公钥？
>     ├── 是 → 自报公钥必须等于绑定公钥，且 sig 必须用该公钥验证通过
>     └── 否 → TOFU：sig 必须用 Hello 自报的 ed25519_pubkey 验证通过
> 校验失败 → 直接丢弃连接，且不得把 peer_id 写入 links / priority_links
> ```
> 禁止：
> ```
> 未经验签就把 Hello 自报的 device_id 当作链路身份
> 为「兼容旧版本」保留无签名的 Hello 分支
> ```"
> — docs/protocol-invariants.md §21. Handshake Identity / INV-P21, line 673

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 建链前必须验签：签名材料必须覆盖 `device_id | tcp_port | nonce | x25519_pubkey | ed25519_pubkey`；已绑定身份必须公钥相等 + 验签通过；未绑定走 TOFU（用自报公钥验签）；校验失败必须直接丢弃连接且不写入 `links` / `priority_links`；不得保留"无签名 Hello"的兼容分支。

**Where enforcement lives:**

纯判定内核：

```rust
// src-tauri/src/network/transport/handshake.rs:7-44
fn hello_auth_decision(
    bound: Option<&str>, device_id: &str, tcp_port: u16, nonce: &str,
    x25519_pubkey: &str, ed25519_pubkey: &str, sig_b64: &str,
) -> Result<(), String> {
    if nonce.is_empty() || sig_b64.is_empty() {
        return Err(format!("Hello 缺少 nonce/sig（device_id={device_id}）"));
    }
    let data = hello_signing_bytes(device_id, tcp_port, nonce, x25519_pubkey, ed25519_pubkey);
    match bound {
        Some(expected) => {
            if expected != ed25519_pubkey {
                return Err(format!("Hello 公钥与已绑定身份不符（device_id={device_id}）：..."));
            }
            if !crypto::verify_signature(expected, &data, sig_b64) {
                return Err(format!("Hello 签名校验失败（device_id={device_id}）"));
            }
            Ok(())
        }
        None => {
            if !crypto::verify_signature(ed25519_pubkey, &data, sig_b64) {
                return Err(format!("Hello 自签名校验失败（device_id={device_id}）"));
            }
            Ok(())
        }
    }
}
```

- What it checks, and against what：
  - `nonce`/`sig` 非空（`:16-18`）—— **无签名 Hello 分支不存在**（没有 `else` 放过空 sig 的路径）。
  - 签名材料 `hello_signing_bytes(device_id, tcp_port, nonce, x25519_pubkey, ed25519_pubkey)`（`:19`）—— 与文档要求的五元组一致。签名材料的实际构造：

```rust
// src-tauri/src/protocol.rs:2368-2384
pub fn hello_signing_bytes(
    device_id: &str, tcp_port: u16, nonce: &str, x25519_pubkey: &str, ed25519_pubkey: &str,
) -> Vec<u8> {
    serde_json::to_vec(&(
        "gosslan-hello-v1",
        device_id, tcp_port, nonce, x25519_pubkey, ed25519_pubkey,
    )).unwrap_or_default()
}
```

  - `hello_signing_bytes_sensitive_to_every_field`（`src-tauri/src/protocol_tests.rs:738-753`）逐字段断言"任一字段变化都必须改变签名材料"，并额外断言**拼接歧义防护**（`("ab",1,"c","d","e")` ≠ `("a",1,"bc","d","e")`）✓
  - `Some(expected)` 分支：先公钥相等（`:24`），再 `crypto::verify_signature(expected, &data, sig_b64)`（`:30`）—— 与文档"自报公钥必须等于绑定公钥，且 sig 必须用该公钥验证通过"逐字对应。
  - `None` 分支（TOFU）：`crypto::verify_signature(ed25519_pubkey, &data, sig_b64)`（`:38`）—— 用**自报**的公钥验签。

绑定值的取法（信任根）：

```rust
// src-tauri/src/network/transport/handshake.rs:75-82
let bound = {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db::get_friend_ed25519(&dbc, device_id)
}
.or_else(|| {
    let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
    bound_ed25519_from_peer(peers.get(device_id))
});
```

```rust
// src-tauri/src/network/transport/handshake.rs:128-131
fn bound_ed25519_from_peer(peer: Option<&Peer>) -> Option<String> {
    peer.filter(|p| p.keys_verified)
        .and_then(|p| p.ed25519_pubkey.clone())
}
```

`peers` 回落项必须 `keys_verified`（`:129`）—— 未验签的 UDP announce 公钥**不得**当绑定（否则攻击者抢先广播即可冒充，`:120-127` 注释）。

重放防护（在验签**之后**消费 nonce）：

```rust
// src-tauri/src/network/transport/handshake.rs:106-116
// ⚠️ nonce 的消费必须放在**验签通过之后**。
if !state.accept_hello_nonce(nonce) {
    return Err(format!("Hello nonce 重放（device_id={device_id}）"));
}
Ok(())
```

**Paths walked — 校验失败必须丢连接且不写 links：**

```rust
// src-tauri/src/network/transport.rs:628-641（TCP 入站首帧）
if let Err(reason) = verify_hello(&state, device_id, *tcp_port, nonce, x25519_pubkey, ed25519_pubkey, sig) {
    state.push_diag_event("hello_rejected", &format!("{reason}; from={peer_addr}"));
    state.logger.warn("transport", format!("拒绝未通过身份认证的 Hello: {reason}"));
    return;   // ← 直接返回：不登记 links、不登记 peer_manager
}
```

```rust
// src-tauri/src/network/transport/dial.rs:547-563（TCP 出站）
if let Err(reason) = verify_hello(state, device_id, *tcp_port, nonce, x25519_pubkey, ed25519_pubkey, sig) {
    state.push_diag_event("hello_rejected", &format!("{reason}; from={endpoint}"));
    state.logger.warn("transport", format!("握手验签失败：{reason}（端点 {endpoint}）"));
    return DialOutcome::Failed(format!("握手失败: {reason}"));
}
```

```rust
// src-tauri/src/network/transport/dial.rs:104-120（verify_hello_for_ble）与
// src-tauri/src/network/ble/central.rs:547、peripheral.rs:461 —— BLE 两条路走同一个判定
```

- 入站 TCP：`transport.rs:628` 的 `verify_hello` 在**任何**链路登记之前（`mark_peer_keys_verified` 在 `:645`，`links` 登记在更后面 `:672+`）⇒ 失败 ⇒ `return` ⇒ **不写 links / priority_links** ✓
- 出站 TCP：`dial.rs:547` 失败 ⇒ `DialOutcome::Failed` ⇒ 不建链 ✓
- BLE：`verify_hello_for_ble`（`dial.rs:104`）是 central / peripheral 两条路的共同入口 ✓

**额外的身份一致性检查（出站）**：

```rust
// src-tauri/src/network/transport/dial.rs:537-546
if let Some(expected) = known_id {
    if device_id != expected {
        let reason = format!("握手身份不符：预期 {expected}，对端自称 {device_id}（端点 {endpoint}）");
        state.push_diag_event("hello_mismatch", &reason);
        return DialOutcome::Failed(reason);
    }
}
```

**密钥轮换候选**（不放松拒绝）：`handshake.rs:86-96` —— 绑定值与自报值不符时，先按**新私钥自验签**，通过则登记一个"待用户确认"的候选（`record_key_rotation_candidate`），但**仍然拒绝本次连接**（`hello_auth_decision` 在 `:97` 照常返回 Err）。

**Searched:**
- `hello_auth` → `handshake.rs:7`（定义）、`handshake.rs:97`（唯一生产调用）、`handshake_tests.rs` 6 条用例。**没有第二处验签实现** ✓
- `verify_hello` → 生产调用 3 处：`transport.rs:628`（TCP 入站）、`dial.rs:547`（TCP 出站）、`dial.rs:113`（`verify_hello_for_ble`，BLE 两条路的共用入口）⇒ BLE 与 TCP 共用一个判定 ✓
- `hello_signing_bytes` → `handshake.rs:19` 与 `:90` 两处调用，签名材料五元组一致 ✓
- `accept_hello_nonce` → `handshake.rs:113`（唯一调用点），在验签之后 ✓
- `keys_verified` → `handshake.rs:129` 过滤条件 + `state.rs:270` 的字段说明 + `transport.rs:645` / `dial.rs:571` 的 `mark_peer_keys_verified` 置位点 ⇒ 升级点唯一
- 无签名 Hello 分支 → **0 hits**：全仓**没有** `if sig.is_empty() { 放行 }` 之类的分支；`handshake.rs:16-18` 与 `:65-67` 的空 sig/空 nonce 直接 `Err`。`Message::Hello` 的 `nonce` / `sig` 字段虽有 `#[serde(default)]`（`protocol.rs:1852/1855`），但那只影响**解析**（老端不发这两个字段时帧仍能解析出来，值为空串），**判定**那一层仍然硬拒 ⇒ "为兼容旧版本保留无签名的 Hello 分支"在**行为上不存在** ✓
- `Hello` 变体定义 → `src-tauri/src/protocol.rs:1822-1856`：签名相关字段（`device_id` / `tcp_port` / `x25519_pubkey` / `ed25519_pubkey` / `nonce` / `sig`）全部**无** `#[serde(default)]`；有 default 的只有展示与协商字段（`device_type` / `content_features` / `protocol_version` / `app_version` / `conv_clock`）⇒ 加新字段不破老端验签（`lib_compat_gating_tests.rs:23-28` 与 `:200-203` 两条判据钉住"`protocol_version` / `app_version` / `content_features` 不得进入签名材料"）✓

**Hook verification:**
- `network::transport::tests::hello_auth_accepts_bound_identity` — **存在**：`src-tauri/src/network/transport/handshake_tests.rs:94` ✓
- `network::transport::tests::hello_auth_rejects_attacker_declaring_own_key` — **存在**：`handshake_tests.rs:102` ✓
- `network::transport::tests::hello_auth_rejects_forged_sig_with_victim_pubkey` — **存在**：`handshake_tests.rs:116` ✓
- `network::transport::tests::hello_auth_rejects_missing_signature_and_tampering` — **存在**：`handshake_tests.rs:145`（四条否定：空 sig、空 nonce、篡改 tcp_port、换 nonce）✓
- `network::transport::tests::announced_attacker_key_cannot_bind_and_impersonate` — **存在**：`handshake_tests.rs:305` ✓（`src-tauri/test-baseline.macos.txt:846` 有登记）
- `network::transport::relay_wiring_tests::negotiation_fails_closed_when_identity_does_not_match` — **存在**：`src-tauri/src/network/transport/relay.rs:844` ✓（基线 `:834` 有登记）
- 六条全部在两个平台基线中登记 ⇒ 注册到本平台基线 ✓

**How the verdict was reached:** 文档的接收方校验规则被逐字实现为 `hello_auth_decision` 的两个 match 臂（`Some` = 公钥相等 + 验签；`None` = TOFU 自验签），签名材料五元组与文档一致，失败路径在**任何**链路登记之前 `return`（`transport.rs:641`）⇒ "不得把 peer_id 写入 links / priority_links"成立。两条禁止项也都成立：没有无签名 Hello 的放行分支（空 sig/空 nonce 直接 Err），`peers` 回落项强制 `keys_verified`（`handshake.rs:129`）⇒ 未验签的广播公钥不能当绑定。定为 `implemented` 而非 `stronger-than-spec`：多出来的 nonce 重放窗口与密钥轮换候选机制，文档没禁止（文档只要求 nonce 防重放 ⇒ 这一格是**满足**要求的实现细节）。

**Open questions:**
- `bound` 的取法是 `friends` 表优先、`peers` 回落。文档写的是"friends / peers 中已绑定该 device_id 的 Ed25519 公钥"—— 代码额外要求 `peers` 回落项必须 `keys_verified`。这比文档严（文档没提这个限制），是必要的收紧还是文档口径需要更新？
- 换钥场景：绑定值与自报值不符时登记候选但仍拒绝连接。用户按提示"删掉好友重新加"之后，`friends` 表那行没了，但 `verify_hello` 仍会回落到 `peers` 表里那条不匹配的绑定（`src-tauri/src/lib_friend_identity_tests.rs:350` 的注释记着这个形状）。这条路径下真用户能否恢复连接？
- `verify_hello` 的 Err 都是自由文本（不区分「重放」与「签名不符」），与 INV-P16 的语义分类要求相关（见该条）。
