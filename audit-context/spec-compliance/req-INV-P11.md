## REQ-INV-P11 — Public Key Change Is Security-Relevant

> "如果发现：
>
> ```text
> device_id 相同
> public_key 不同
> ```
>
> 不能静默覆盖后继续发送。
>
> 必须明确决定：
>
> ```text
> accept
> reject
> re-key
> warn
> ```
>
> 当前实现若尚未具备完整 key rotation，应记录为已知限制，而不是让 AI 自行决定。"
> — docs/protocol-invariants.md §INV-P11, line 352-370
>
> 附带 spec 自述（line 374-L412）：
> "### 现在的决定（2026-09-13 实装，用户真机反馈后）
>
> | 绑定来源 | 公钥不一致时 | 理由 |
> |---|---|---|
> | **好友表**（`friends.ed25519_pubkey`，用户显式建立的关系） | **硬拒** Hello + 在聊天里插一条系统提示 | 这是唯一一条"用户亲自建立过"的信任；静默换钥等于把中间人攻击变成默认行为 |
> | **内存 `peers` 表**（广播里学来的公钥，**未经验签**） | **同样硬拒**，但删好友 / 收到 `FriendRemove` 时会**解除绑定**（`forget_peer_identity`） | 广播公钥本来就没有任何可信度，它不该变成"永久枷锁" |
>
> **用户可行动路径**（提示里必须写出来，否则等于把用户扔在原地）：
> `删掉该好友 → 重新添加`（聊天记录保留、**不需要重启**）。"
>
> 以及（line 384-L412）写入侧的收紧："`update_friend_pubkeys` 只填空、首写者永久胜出 ⇒ **写入侧的信任等级决定锚点本身** …… 现在的规则（判据只有一份：`peer_keys_trusted` + `acceptable_friend_keys`）：**`x25519`（加密钥匙）照旧早绑** —— 晚了就是"首次加密发送失败"；**`ed25519`（身份锚点）只认被证明过的来源**。"

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 发现同一 `device_id` 报出不同公钥时，**不能静默覆盖后继续发送**；必须有一个明确决定的分支（accept / reject / re-key / warn），且这个决定必须对用户可见、可行动。

**Where enforcement lives:**

1) **硬拒（friends 表锚）—— Hello 判定**：

```rust
// src-tauri/src/network/transport/handshake.rs:20-L33
match bound {
    Some(expected) => {
        if expected != ed25519_pubkey {
            return Err(format!(
                "Hello 公钥与已绑定身份不符（device_id={device_id}）：对方可能重装了应用。\
                 若确认是本人重装，删掉该好友后重新添加即可（聊天记录保留、无需重启）"
            ));
        }
        if !crypto::verify_signature(expected, &data, sig_b64) { return Err(...); }
        Ok(())
    }
```
⇒ 公钥不一致 ⇒ **拒绝这条连接**（`verify_hello` 返回 Err ⇒ `handle_incoming` / `dial` 断开）。这就是 spec 表格里的"硬拒"。

2) **硬拒（peers 内存锚）—— 回落项必须已验签**：

```rust
// src-tauri/src/network/transport/handshake.rs:128-L131
fn bound_ed25519_from_peer(peer: Option<&Peer>) -> Option<String> {
    peer.filter(|p| p.keys_verified).and_then(|p| p.ed25519_pubkey.clone())
}
```
⇒ 广播学来的（未验签）公钥**不能**当身份锚；一旦有验签通过的锚，`Some(expected)` 分支同样硬拒。

3) **绝不静默覆盖（持久层）**：

```rust
// src-tauri/src/db/friends.rs:38-L63
/// 补齐好友**尚缺**的 X25519 / Ed25519 公钥（首次学到时持久化）。
/// ⚠️ **只填空位，绝不覆盖已有值**（`COALESCE(x25519_pubkey, ?2)` 而非反过来）。
pub fn update_friend_pubkeys(conn: &Connection, device_id: &str, x25519: Option<&str>, ed25519: Option<&str>) -> Result<()> {
    conn.execute("UPDATE friends SET x25519_pubkey = COALESCE(x25519_pubkey, ?2), ed25519_pubkey = COALESCE(ed25519_pubkey, ?3) WHERE device_id = ?1", ...)?;
```
⇒ 一旦绑过，**任何自动路径都改不掉**。唯一的覆盖路径是**用户显式确认**：
```rust
// src-tauri/src/db/friends.rs:65-L83
/// **用户显式确认后**覆盖好友的两把公钥（密钥轮换）。
pub fn replace_friend_pubkeys(conn: &Connection, device_id: &str, x25519: &str, ed25519: &str) -> Result<()> { ... }
```
调用点 `commands/friends.rs` 的 `sync_friend_keys`（前端"同步新密钥"按钮）。

4) **绝不静默覆盖（内存层）**：

```rust
// src-tauri/src/network/transport/peer_registry.rs:189-L231
Some(p) => {
    let x_conflict = matches!((&p.x25519_pubkey, &x25519), (Some(old), Some(new)) if old != new);
    let e_conflict = matches!((&p.ed25519_pubkey, &ed25519), (Some(old), Some(new)) if old != new);
    let key_conflict = x_conflict || e_conflict;
    ...
    if x25519.is_some() && !x_conflict { p.x25519_pubkey = x25519; }     // ← 冲突时不写
    if ed25519.is_some() && !e_conflict { p.ed25519_pubkey = ed25519; } // ← 冲突时不写
    ...
}
if key_conflict {
    state.push_diag_event("identity_key_conflict", &format!("device_id={device_id}"));
    warn_key_conflict_once(state, device_id);
    return;                                    // ← 冲突 ⇒ 直接返回，不落库、不补发群密钥
}
```
⇒ 冲突时**不覆盖**（内存）、**不落库**、**不继续发**（`return` 在 `key_changed` 落库与 `redistribute_group_keys` 之前）。

5) **"warn" 分支：聊天里插一条系统提示**：

```rust
// src-tauri/src/network/transport/peer_registry.rs:82-L94
crate::commands::insert_system_message(state, device_id, &format!(
    "⚠️「{name}」的身份密钥发生变化，已保留原密钥未替换。\
     如果对方刚重装过应用：**删掉这个好友再重新添加即可**（聊天记录会保留、不用重启）；\
     如果不是本人操作，就别继续，对方可能被人冒名顶替。"
));
```
⇒ spec 要求的"用户可行动路径"（删掉该好友 → 重新添加、不需要重启）**写在提示里**。
去重：`warn_key_conflict_once` 用 `state.key_conflict_warned` Set 保证同一 `device_id` 只提示一次（`:63-L72`）⇒ 不会因 5s 一次的 announce 刷屏。

6) **"re-key" 分支：换钥候选（用户点确认才生效）**：

```rust
// src-tauri/src/network/transport/handshake.rs:83-L96
// 绑定值与自报值不一致（对方重装应用换了身份）时：先按**新私钥自验签**，
// 通过则给聊天界面留一个"用户确认后同步新密钥"的候选（仍拒绝本次连接）。
// 未通过自验签 = 连"持新私钥者本人"都证明不了，或纯伪造，不登记。
if let Some(expected) = bound.as_deref() {
    if expected != ed25519_pubkey && crypto::verify_signature(ed25519_pubkey, &hello_signing_bytes(...), sig_b64) {
        record_key_rotation_candidate(state, device_id, x25519_pubkey, ed25519_pubkey);
    }
}
```
`record_key_rotation_candidate`（`peer_registry.rs:14-L53`）额外要求**对方是好友**（`:25-L28`）且**同一对候选只通知一次**（`:34-L48`）。
`record_key_rotation_candidate(state` 的调用点**全仓只有一处**（`lib_friend_identity_tests.rs:437` 断言 count == 1）⇒ 未验签的 announce 冲突**给不出**一键换钥入口。

7) **"解除绑定"分支（peers 表不变成永久枷锁）**：`forget_peer_identity` 在两条解除关系路径上被调：
- `commands/friends.rs` 的 `remove_friend`（本地删好友）
- `network/transport/handle_identity.rs` 的 `Message::FriendRemove` 分支（对方删了我）
（`lib_friend_identity_tests.rs:358-L393` 钉住两条路径都调。）

8) **写入侧收紧（spec 的"反过来的一面"）**：

```rust
// src-tauri/src/network/transport/handshake.rs:179-L191
fn acceptable_friend_keys(verified: bool, x25519: Option<String>, ed25519: Option<String>) -> (Option<String>, Option<String>) {
    (x25519, if verified { ed25519 } else { None })
}
```
⇒ `x25519` 照绑、`ed25519`（身份锚）**只认已验签来源**。唯一调用点 `bind_friend_keys_on_accept`（`handshake.rs:206-L215`），三条"成为好友"路径都走它（`lib_friend_identity_tests.rs:259-L265` 断言 `bind_friend_keys_on_accept(` 在 transport 全集视图里恰好 3 次）。
Gossip 那处补齐**只准绑 x25519**（`gossip.rs:330`：`db::update_friend_pubkeys(&dbc, &env.sender_id, Some(&env.sender_pubkey), None)`）。
`upsert_peer` 那道闸：`peer_registry.rs:240-L241`（`let verified = FriendKeySnapshot::capture(state, device_id).verified; if key_changed && verified {`）。

9) **自愈通道（留 NULL 不是死路）**：`mark_peer_keys_verified`（`handshake.rs:231-L249`）在 `handle_message` 的 Hello 分支里、`upsert_peer` **之后**打标（`network/transport/handle_identity.rs:79`）⇒ 下一次 announce 就能把 `ed25519` 补进来（因为 `update_friend_pubkeys` 只填空）。

**Paths walked:**
- 好友重装应用（换身份）→ 新 Hello 到达 → `verify_hello` 发现 `expected != ed25519_pubkey` ⇒ **硬拒这条连接**（Err ⇒ 断链）⇒ 同时若新私钥自验签通过 ⇒ 登记换钥候选 ⇒ 前端出现"同步新密钥"横幅 ⇒ 用户点 ⇒ `sync_friend_keys` → `replace_friend_pubkeys` 覆盖（**用户显式确认**）⇒ 之后新连接正常 ✓
- 伪造者用同一 `device_id` 广播不同公钥 → `upsert_peer` 的 `key_conflict` ⇒ 不覆盖 + `warn_key_conflict_once` 插系统提示 + `return`（不落库、不补发群密钥）⇒ **绝不静默继续发送** ✓
- 伪造者用同一 `device_id` 发 Hello（新私钥自验签能过，但签名是伪造者自己的私钥做的）→ `hello_auth_decision` 的 `Some(expected)` 分支：公钥与绑定值不符 ⇒ **硬拒** ✓（自验签通过只让它拿到"换钥候选"这一个入口，而候选要用户点确认才生效）
- 未验签的 announce 抢先广播 → `upsert_peer` 新建条目恒标 `keys_verified: false`（`peer_registry.rs:180`）⇒ `bound_ed25519_from_peer` 过滤掉它 ⇒ **不能**成为身份锚 ✓
- 三条"成为好友"路径（直连 FriendAccept / 跨跳 Gossip FriendAccept / 本机点同意）→ 都走 `bind_friend_keys_on_accept` ⇒ `ed25519` 只在 `verified` 时绑 ⇒ 伪造 announce 抢填不成功 ✓
- 删好友 → `remove_friend` ⇒ `forget_peer_identity` ⇒ 内存旧锚解除 ⇒ 下次 Hello 回落 TOFU ⇒ **不需要重启** ✓
- 收到 `FriendRemove` → `handle_identity.rs` 的 FriendRemove 分支 ⇒ 同样调 `forget_peer_identity` ✓
- 对方只是轮换了 x25519（加密钥匙）而非身份 → `update_friend_pubkeys` 的 COALESCE 仍保留旧 ed25519，x25519 列在未绑定时补齐 ⇒ 走 spec 表格里的"硬拒"路径 ✓

**Searched:**
- `update_friend_pubkeys` → 3 处生产调用：`network/transport/handshake.rs:213`（accept helper）、`network/transport/peer_registry.rs:251`（`upsert_peer`，自带闸）、`network/transport/gossip.rs:330`（只绑 x25519）
- `replace_friend_pubkeys` → 1 处生产调用：`commands/friends.rs` 的 `sync_friend_keys`（用户显式确认）
- `keys_verified` → 命中 `state.rs:274`（字段）、`peer_registry.rs:180`（新建恒 false）、`handshake.rs:129`（过滤）、`handshake.rs:168`（快照）、`handshake.rs:248`（置位）、`peer_registry.rs:240`
- `forget_peer_identity` → 生产 2 处调用（`remove_friend` 命令 + `FriendRemove` 分支）+ 定义
- `record_key_rotation_candidate(state` → **1 hit**（`handshake.rs:94`）⇒ 未验签路径给不出换钥入口 ✓
- `warn_key_conflict_once` → 2 hits（定义 `peer_registry.rs:63` + 调用 `:229`）
- `key_conflict` → 命中 `peer_registry.rs:147`/`:194`/`:227`/`:230`
- `silent` / `静默` + `overwrite` 形态的覆盖写 → `UPDATE friends SET x25519_pubkey = ?2` 只在 `replace_friend_pubkeys`（`db/friends.rs:78`）一处 ⇒ 覆盖式写入只有一条路径 ✓
- `acceptable_friend_keys` → 2 hits：`handshake.rs:185`（定义）、`:211`（唯一调用）
- `bind_friend_keys_on_accept(` → transport 全集视图里 3 次（定义 1 + 两处调用），由 `lib_friend_identity_tests.rs:259` 断言

**Hook verification:**
- `tests::friend_identity_anchor_has_one_binding_rule` → `src-tauri/src/lib_friend_identity_tests.rs:257`；两平台基线在册 ✓（断言 helper 3 处、快照 3 处、`acceptable_friend_keys` 1 处、`mark_peer_keys_verified` 5 处、打标必须在 `upsert_peer` 之后、`upsert_peer` 只许一处写钥匙、Gossip 那处只准绑 x25519）
- `db::tests::update_friend_pubkeys_never_overwrites_a_bound_key` → `src-tauri/src/db/favorites_tests.rs:271`；两平台基线在册 ✓
- `guards:身份锚点的打标点必须留在 handle_message 的 Hello 分支` → `scripts/guard_cases/transport_network.py:411-L427`（`name="身份锚点的打标点必须留在 handle_message 的 Hello 分支（删掉即红）"`）；由 `check-invariant-hooks.mjs` 的 `guards:` 形态解析（检索面 = `scripts/verify-guards.py` + `scripts/guard_cases/*.py` 里的 `name = "..."`）⇒ 解析成功 ✓
- `guards:打标必须排在` → `scripts/guard_cases/transport_network.py:428-L452`（`name="打标必须排在 \`upsert_peer\` **之后**（换序即红，计数不变所以只有次序断言会响）"`）⇒ 解析成功 ✓
- 支撑（spec 未点名但在册）：`tests::removing_a_friend_also_drops_the_in_memory_identity_binding`（`lib_friend_identity_tests.rs:358`）、`tests::key_rotation_candidate_requires_friend_and_new_key_self_signature`（`:403`，断言登记点全 transport 视图里恰好 1 处）、`tests::sync_friend_keys_replaces_both_trust_legs_under_explicit_confirm`（`:460`）、`tests::pending_key_rotation_cleared_on_both_friend_removal_paths`（`:510`）、`db::tests::friend_add_and_pubkey_persistence`（`favorites_tests.rs:147`）、`mesh::manager::tests::identity_merge_never_overwrites_existing_keys`（`mesh/manager.rs:345`）、`mesh::manager::tests::forget_identity_clears_keys_but_keeps_the_connection`（`mesh/manager.rs:378`）

**How the verdict was reached:** spec 的四个分支（accept / reject / re-key / warn）代码里**全部存在且分工明确**：reject = `hello_auth_decision` 的 `Some(expected)` 分支硬拒 + `upsert_peer` 的 `key_conflict` 不覆盖；re-key = `record_key_rotation_candidate` + `replace_friend_pubkeys`（用户显式确认）；warn = `warn_key_conflict_once` 的系统提示（含可行动路径）；accept 只在 TOFU 首触时发生。spec 的"不能静默覆盖后继续发送"在**持久层**（COALESCE）与**内存层**（冲突时不写 + `return`）两处都成立。spec 的"写入侧收紧"（ed25519 只认已验签来源）也有单点实现 `acceptable_friend_keys`。所以判 `implemented`。

**Open questions:**
- **spec 的 `guards:` 两条钩子的注入锚点已随 `include!` 拆册搬家**：guard 用例声明 `file=TAURI / "src" / "network" / "transport.rs"`，而它要注入的两行现在在 `src-tauri/src/network/transport/handle_identity.rs:59` / `:79`（`transport.rs` 里已无 `mark_peer_keys_verified(state, &device_id, &hello_x, &hello_e);` 这一行，`transport.rs:647` 是**另一处**不同形状的调用 `mark_peer_keys_verified(&state, device_id, x25519_pubkey, ed25519_pubkey);`）。`verify-guards.py` 的 `_resolve_anchor_file`（`:118-L145`）会沿 `include!` 子模块找锚点，所以注入仍能落到 `handle_identity.rs` ⇒ **护栏仍然有效**；但护栏的 `file=` 声明与实际落点已不同名。**需要确认 `verify-guards.py` 的锚点解析确实命中 `handle_identity.rs` 而不是 `transport.rs`。**
- **spec 引用的判据名 `peer_keys_trusted` 已不存在**：spec line 392 写"判据只有一份：`peer_keys_trusted` + `acceptable_friend_keys`"，但代码里 `peer_keys_trusted` 已被 `FriendKeySnapshot::capture(state, device_id).verified` 取代（`handshake.rs:154-L177`、`peer_registry.rs:240`）。`acceptable_friend_keys` 仍在（`handshake.rs:185`）。**spec 的判据名已过期。**
- **spec line 372 的两个 `guards:` 钩子第二条（`guards:打标必须排在`）是前缀匹配**（`check-invariant-hooks.mjs:104` 用 `guardNames.some((n) => n.includes(frag))`）⇒ 该前缀只匹配到一条用例（`transport_network.py:429`）。若将来出现第二条以"打标必须排在"开头的用例，会被这条 spec 引用同时命中，spec 的意图与守卫的实际覆盖不再一一对应。
- **`upsert_peer` 的 `key_conflict` 分支不区分"好友"与"非好友"** —— 但 `warn_key_conflict_once` 内部对非好友直接 return（`peer_registry.rs:79-L81`）⇒ 非好友的冲突**完全静默**（无系统提示、无诊断事件除外：`peer_registry.rs:228` 的 `push_diag_event` 在 return 之前）。spec 的表格只描述了"好友表"与"peers 表"两行，未提非好友。**需要确认非好友的公钥冲突静默是否是预期。**
- **spec 的"已知限制"登记**：spec line 370 说"当前实现若尚未具备完整 key rotation，应记录为已知限制"。代码里 key rotation 是**半**具备的（好友表有 `replace_friend_pubkeys` 一键换钥 + `pending_key_rotations` 候选表；**peers 内存表的非好友**降级为"提示"这件事 spec line 424-L425 明确列为**待办**）。spec 的"待办"段（line 422-L427）已如实登记 ⇒ 与代码现状一致。
