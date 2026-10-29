## REQ-INV-P14 — DB Is Not Cache

> "消息、好友、身份、outbox 等持久化数据不能只存在：
>
> ```text
> Pinia
> memory
> peer map
> ```
>
> 如果数据定义为 durable：
>
> ```text
> SQLite must be source of truth
> ```"
> — docs/protocol-invariants.md §INV-P14, line 489-501

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 被定义为 durable 的数据（消息、好友、身份、outbox 等）必须以 SQLite 为**唯一真相源**；内存态只能是**缓存**（丢了能从 DB 重建），不能是**唯一副本**。

**Where enforcement lives:**

1) **消息**：`messages` 表（`db.rs:769-L790`，`msg_id TEXT UNIQUE NOT NULL`）。写：`db::insert_message_if_new` / `insert_message` / `insert_message_and_outbox`（`db/messages.rs:28`/`:41`/`:47`）。读：`get_messages`（`:99`）/ `get_latest_messages`（`:183`）。
前端 `messages.value[convId]` 是**缓存**：`useChatStore.ts:1566-L1587` 的注释自陈"其它会话的缓存纯粹是内存副本，切回时由 loadMessages 从 SQLite 重新[取]"；`loadMessages`（`:1656`）调 `api.getLatestMessages`（`src/api/index.ts:210`）⇒ 前端可从 DB 重建。

2) **好友**：`friends` 表（`db.rs:747-L755`，含 `x25519_pubkey` / `ed25519_pubkey` 两列）。写：`db/friends.rs` 的 `add_friend`（`:5`）/ `remove_friend`（`:19`）/ `update_friend_pubkeys`（`:50`）/ `replace_friend_pubkeys`（`:71`）。
前端 `useAppStore` 的好友列表是缓存；权威读数是 `db::list_friends`（`db/friends.rs:150`）。

3) **身份**：`settings` 表的三行（`db.rs:742-L745`，key-value）：`device_id`、`x25519_secret`、`ed25519_secret`。
写：`state.rs:1729-L1731`（同事务）；读：`state.rs:1697-L1699`。
公钥是私钥的函数（`crypto.rs:56-L62`）⇒ 不单独持久化也不需要。

4) **outbox**：`outbox` 表（`db.rs:850`，`msg_id TEXT NOT NULL UNIQUE`）+ 群侧 `group_outbox` 表（`db.rs:861`）+ 文件侧 `file_outbox` 表（`db.rs:903`）。
写：`db::insert_message_and_outbox`（`db/messages.rs:47`）；读：`db::list_outbox`（`db/offline_queue.rs:67`）。
⇒ `AppState` 里**没有** outbox 字段（内存态清单里只有 `file_receivers` 之类的**接收器**）。

5) **群密钥（一个"内存优先 + DB 兜底"的例子，且 DB 是真相源）**：

```rust
// src-tauri/src/network/transport.rs:1461-L1482
pub async fn get_group_key(state: &AppState, group_id: &str) -> Option<[u8; 32]> {
    if let Some(k) = state.group_keys.lock()...get(group_id) { return Some(*k); }   // ← 内存缓存
    let key_b64 = { let dbc = state.db.lock()...; db::get_setting(&dbc, &format!("gk:{group_id}")) }?;  // ← DB 真相源
    ...
    state.group_keys.lock()...insert(group_id.to_string(), arr);   // ← 回填缓存
    Some(arr)
}
```
⇒ 内存 `state.group_keys`（`state.rs:1239`）是**缓存**，DB（`settings` 里的 `gk:{group_id}` 键，`transport.rs:1388` / `commands/groups.rs:59` 写）才是真相源。重启后内存空 ⇒ 从 DB 读回 ⇒ 群消息仍可解密。

6) **待发已读回执**：`pending_reads` / `pending_group_reads` 表（`db.rs:976` / `:982`）。写：`db/read_receipts.rs:6`/`:32`（MAX 语义）；启动时**从 DB 恢复到内存**：

```rust
// src-tauri/src/state.rs:2118-L2125
// 启动时从 DB 恢复待发已读回执（进程重启后 pending_reads 内存丢失的恢复路径）
let mut pending_reads_map = HashMap::new();
if let Ok(rows) = db::load_pending_reads(&conn) {
    for (peer_id, ts) in rows { let cur = pending_reads_map.entry(peer_id).or_insert(ts); *cur = (*cur).max(ts); }
}
```
⇒ 内存 `state.pending_reads`（`state.rs:1255`）是缓存，DB 是真相源。

7) **文件传输台账**：`file_transfers` 表（`db.rs:877`）+ `group_files` / `group_file_recipients`（`db.rs:926` / `:941`）。
写：`db::upsert_transfer`（`db/file_transfer.rs:6`）、`db::insert_group_file`（`db/group_files.rs:100`）。
前端 `file-progress` 事件只是通知；权威是台账行。

8) **内容寻址台账**：`content_transfers` 表（`content/store.rs:14` `ensure_schema`）。写：`content/store.rs:92` `upsert` / `:275` `record_local` / `:307` `record_failure`。
`content_transfers` 的 `received` 字段是**续传起点的真相**（`content/store.rs:253-L268` `touch_received`，MAX 语义只前进）。

9) **"内存只是缓存"的一个反例检验 —— 群文件路径回填**：`db::tests::gfile_transfer_record_persists_local_path`（`db/favorites_tests.rs:2126`）断言群文件的本地路径经 `file_transfers` 持久化 ⇒ 重启后仍有效。

**Paths walked:**
- 收到消息 → 落 `messages` ⇒ 前端缓存可丢弃、可从 DB 重建 ✓
- 加好友 → 落 `friends` ⇒ 重启后好友列表仍在（公钥也在）✓
- 启动 → 从 `settings` 恢复两条私钥 + `device_id` ⇒ 身份不变 ✓
- 写 outbox → 落 `outbox` 表 ⇒ 重启后 `flush_outbox` 从 DB 读回 ✓
- 收到已读回执 → 落 `pending_reads` ⇒ 重启后 `load_pending_reads` 恢复 ✓
- 群密钥 → 内存空（重启后）⇒ `get_group_key` 从 `settings` 的 `gk:{gid}` 读回 ⇒ 群消息仍可解密 ✓
- 文件接收 → 进度落 `file_transfers` / `content_transfers` ⇒ 重启后续传起点在 ✓
- 前端 Pinia 里的消息/好友/未读数 → 都是缓存；切会话走 `loadMessages`、切窗口走 `refreshEnvironment`、事件丢失后走 `get_latest_messages` 重取 ✓

**Searched:**
- `AppState` 里的持久数据字段 → `state.rs:1060` 起的结构体：`db`（SQLite 连接）、`device_id`、`identity`、`group_keys`（内存缓存 + DB 兜底）、`pending_reads`（缓存 + DB 兜底）、`peers`（内存**知识集**，非 durable 数据 —— 由 announce/Hello 重建）、`file_receivers`（在途接收器，非 durable —— 见下）
- `CREATE TABLE IF NOT EXISTS messages|friends|settings|outbox|group_outbox|file_outbox|file_transfers|group_files|pending_reads|pending_group_reads|content_transfers` → `db.rs` 的 SCHEMA 一处 + `content/store.rs:14`
- `state.outbox` / `outbox: Mutex` → **0 hits**（`AppState` 里没有 outbox 字段）⇒ outbox 只能是 DB
- `state.messages` / `messages: Mutex` → **0 hits**
- `state.friends` / `friends: Mutex` → **0 hits**
- `state.identity` 之外的身份副本 → 0 hits（`state.rs:16` 只 `use crate::crypto::Identity`）
- `gk:` 键的读写 → 命中 `network/transport.rs:1388`（写）、`:1472`（读）、`network/transport/group_membership.rs:59`（删）、`commands/groups.rs:59`/`:350`（写）、`:471`（删）
- `pending_reads` 的读写 → `db/read_receipts.rs` 全族 + `state.rs:2120`
- `file_receivers` 内存表 → `state.rs` 字段 + `network/file/receive.rs` —— **这是"在途接收器"**（文件句柄 + 增量 hasher），不是 durable 数据；`.part` 文件在盘上、`file_transfers` 记进度 ⇒ 重启后重建接收器（`content/store.rs` 的 `record_failure` / `list_resumable_for_peer`）
- `state.peers` → `state.rs:1242` 一带的内存哈希表；`state.rs:267-L274` 的注释自陈"由 UDP announce（可伪造）与验签通过的 Hello（可信）共同维护"⇒ 是**知识集/缓存**，durable 的身份锚在 `friends` 表
- Pinia store 里的持久数据 → `useChatStore.ts` 的 `messages` / `conversations` 都是缓存；`useAppStore.ts` 的 `friends` / `device` 同理

**Hook verification:**
- `db::tests::pending_read_survives_restart` → `src-tauri/src/db/favorites_tests.rs:1251`；两平台基线在册 ✓（写两行 → 模拟重启（新建 HashMap 从 DB load）→ 两行都恢复；且 DB 里的记录仍存在，flush 时才删）
- `db::tests::gfile_transfer_record_persists_local_path` → `src-tauri/src/db/favorites_tests.rs:2126`；两平台基线在册 ✓（群文件本地路径经 `file_transfers` 持久化 ⇒ 重启后仍有效）
- `content::store::tests::failure_persists_resumable_or_terminal` → `src-tauri/src/content/store.rs:439`；两平台基线在册 ✓（失败落库后：可恢复 ⇒ `Incomplete` 且能被 `list_resumable_for_peer` 捞出；不可恢复 ⇒ `Rejected` 且从可恢复列表消失）
- 支撑（spec 未点名但在册）：`db::migration_tests::migration_preserves_identity_data`（`db/migration_tests.rs:200`）、`db::tests::friend_add_and_pubkey_persistence`（`db/favorites_tests.rs:147`）、`content::store::tests::record_local_makes_content_servable_with_group_scope`（`content/store.rs:476`）、`db::startup_safety_tests::orphan_sending_is_recovered_but_queued_and_terminal_rows_are_untouched`（`db/startup_safety_tests.rs:108`）

**How the verdict was reached:** 对 spec 点名的四类数据（消息 / 好友 / 身份 / outbox）逐一确认：**每一类在 `AppState` 里要么没有字段，要么该字段明确是"缓存 + DB 兜底"**（群密钥 `get_group_key` 与待发已读 `load_pending_reads` 是这两个模式的生产实现）。`AppState` 里**没有** `outbox` / `messages` / `friends` 字段（grep 0 命中）⇒ 这三类只能是 DB。所以不是 `partial`（没有哪类数据只在内存里）。

**Open questions:**
- **spec 点名的 `pending_read_survives_restart` 是"待发已读回执"（`pending_reads`），不是消息 / 好友 / 身份 / outbox 中任何一类**。spec 的四条钩子里没有一条直接判"消息落 DB 后重启仍在"（那由 `migration_tests::migration_preserves_identity_data` 间接覆盖）或"outbox 落 DB 后重启仍在"（由 `db::startup_safety_tests::orphan_sending_is_recovered_but_queued_and_terminal_rows_are_untouched` 覆盖）。**需要确认 spec 的钩子清单是否覆盖了它声称的四类数据。**
- **`state.peers` 是纯内存的**（`state.rs` 的 `peers` 字段）。它承载 nick / avatar / ip / tcp_port / 公钥 / `last_seen`。spec 的禁止清单里列了 "peer map" ⇒ **字面上**这条禁令把 `state.peers` 命中了。代码的立场是：`peers` 是**知识集/发现缓存**（由 announce/Hello 重建，可丢失），**durable 的身份锚在 `friends` 表**（`db/friends.rs:50` 的 COALESCE 只填空）。但 `peers` 里的 `keys_verified` 标记与 `x25519_pubkey` 参与**信任判定**（`handshake.rs:128` 的 `bound_ed25519_from_peer`）⇒ 重启后它们丢失 ⇒ 回落 TOFU。**需要确认 spec 的 "peer map" 指的是"持久数据只存在 peer map 里"（不成立）还是"任何数据都只能存在 peer map 里"（则 `peers` 命中）。**
- **`state.group_keys` 的内存副本是"缓存"，但 `gk:{gid}` 键在 `settings` 表里与 `device_id` / 两条私钥**同表** ⇒ `clear_all_data`（`commands/favorites.rs:526`）的删除清单里**不含** `settings`（只删 `gk:%` 前缀的键，`:561`）⇒ 群密钥被清而身份不被清。**需要确认这与 spec 的分类一致（群密钥算 durable 数据吗）。**
- **`state.file_receivers`（在途接收器：文件句柄 + 增量 hasher）也是纯内存的**，`.part` 文件在盘上。重启后接收器丢失 ⇒ 需要重建（`content/store.rs` 的 `list_resumable_for_peer` + `.part` 长度）。**这是"durable 数据只在内存"的边缘形态**（进度在 `content_transfers` / `file_transfers`，但**增量哈希**只在内存）⇒ 重启后必须重算整份哈希（`outbox_sweep.rs:716-L739` 的 `content_file_matches` 就是这条路径）。**需要确认 spec 是否把"增量 hasher"算 durable 数据。**
