## REQ-INV-P19 — 每会话逻辑序号（不用墙上时钟，不猜对端时钟）

> "同一会话内的消息排序使用本地维护的逻辑序号 `seq`，不使用墙上时钟，也不猜测对端时钟。
> - 发送：`seq = local_clock + 1`，并持久化 `conversation_clocks`。
> - 接收：`seq = max(1, received_seq)`，并推进本地时钟。
> - 排序：`seq ASC, id ASC`。
> - 群聊清空边界：记录清空时的 `seq`，`seq <= boundary` 的旧消息不再回灌。
> 禁止：
> ```
> sender_wall_clock 直接决定消息顺序
> receiver 纠正/猜测 sender 时钟
> ```"
> — docs/protocol-invariants.md §19. Logical Ordering / INV-P19, line 628

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 消息顺序必须由本地维护的 Lamport 式逻辑序号决定；发送端取本地时钟 +1 并持久化；接收端取 `max(1, received_seq)` 并推进本地时钟（只前进）；排序权威是 `seq ASC, id ASC`；群聊清空后旧消息（`seq <= boundary`）不许回灌。任何"用墙上时钟决定顺序"或"接收端纠正发送端时钟"的写法都不许存在。

**Where enforcement lives:**

逻辑时钟本体：

```rust
// src-tauri/src/db/clocks.rs:18-38
pub fn next_clock(conn: &Connection, conv_id: &str) -> Result<i64> {
    let tx = conn.unchecked_transaction()?;
    let cur: i64 = tx.query_row("SELECT seq FROM conversation_clocks WHERE conv_id = ?1", ...)?
        .optional()?.unwrap_or(0);
    let next = cur.saturating_add(1);
    tx.execute("INSERT INTO conversation_clocks(conv_id, seq) VALUES(?1, ?2)
         ON CONFLICT(conv_id) DO UPDATE SET seq = excluded.seq", params![conv_id, next])?;
    tx.commit()?;
    Ok(next)
}

// src-tauri/src/db/clocks.rs:40-48
pub fn observe_clock(conn: &Connection, conv_id: &str, observed: i64) -> Result<()> {
    conn.execute("INSERT INTO conversation_clocks(conv_id, seq) VALUES(?1, ?2)
         ON CONFLICT(conv_id) DO UPDATE SET seq = MAX(conversation_clocks.seq, excluded.seq)", ...)?;
    Ok(())
}
```

- `next_clock` = 本地时钟 +1（`:30`），并在**同一事务**里持久化到 `conversation_clocks`（`:31-36`）⇒ 发送侧"取号 + 持久化"是原子的。
- `observe_clock` = `MAX(本地, 观察到的)`（`:44`）⇒ 接收侧只**推进**不**回退**，且**不纠正**对端（它不把 `observed` 当权威，只是取大）。

排序权威：

```rust
// src-tauri/src/db/messages.rs:107（get_messages）
FROM messages WHERE conv_id = ?1 ORDER BY seq ASC, id ASC LIMIT ?2 OFFSET ?3
// src-tauri/src/db/messages.rs:146、:190
ORDER BY seq ASC, id ASC     /     ORDER BY seq DESC, id DESC
// src-tauri/src/db/group_history.rs:164
ORDER BY seq ASC, id ASC
```

接收侧 seq 下界与时钟推进：

```rust
// src-tauri/src/network/transport/handle_messaging.rs:141
let seq = seq.max(1);
// src-tauri/src/network/transport/handle_messaging.rs:159
db::observe_clock(&dbc, &from, seq).ok();
// src-tauri/src/network/transport/gossip.rs:1103
let seq = env.seq.max(1);
// src-tauri/src/network/transport/gossip.rs:1171
db::observe_clock(&dbc, &conv_id, seq).ok();
```

清空边界：

```rust
// src-tauri/src/db/group_delete_boundary.rs:11-13
pub fn set_clear_boundary(conn: &Connection, group_id: &str, seq: i64) -> Result<()> {
    set_setting(conn, &clear_boundary_key(group_id), &seq.to_string())
}

// src-tauri/src/db/group_delete_boundary.rs:23-36
pub fn group_message_blocked_by_boundary(
    conn: &Connection, group_id: &str, seq: i64, kind: &str,
) -> bool {
    if crate::protocol::kind_class(kind) != crate::protocol::KindClass::Bubble {
        return false;
    }
    get_setting(conn, &clear_boundary_key(group_id))
        .and_then(|v| v.parse::<i64>().ok())
        .map(|boundary| seq <= boundary)
        .unwrap_or(false)
}
```

写入边界：`src-tauri/src/commands/chat.rs:1433` `db::set_clear_boundary(&dbc, gid, boundary)`。
消费边界：`src-tauri/src/network/transport/gossip.rs:883` `db::group_message_blocked_by_boundary(&dbc, &gid, env.seq, &kind)` ⇒ 命中即 `return`（`:888`），不回灌。

**Paths walked:**
- 发送（单聊）→ `commands/chat.rs:721` `db::next_clock(&dbc, &friend_id)` ⇒ 本地时钟 +1 并持久化 ✓
- 发送（群聊）→ `commands/chat.rs:1054` `db::next_clock(&dbc, &me)` ✓
- 发送（分享/文件消息）→ `commands/share.rs:235`、`commands/files.rs:411`、`commands/window.rs:196`、`commands/group_announcements.rs:408`、`network/transport/group_file.rs:748`、`network/transport/relay_file.rs:486`、`network/transport/handle_file.rs:561` 全部走 `next_clock` ✓
- 接收（直连单聊）→ `handle_messaging.rs:141` `seq.max(1)` ⇒ `seq = max(1, received_seq)` ✓；`:159` `observe_clock` 推进本地时钟 ✓
- 接收（跨跳 gossip）→ `gossip.rs:1103` `env.seq.max(1)` ✓；`:1171` `observe_clock` ✓
- 接收（群关系同步）→ `network/transport.rs:1443` `observe_clock(&dbc, &conv_id, clock)` ✓
- 接收（群历史同步）→ `db/group_history.rs:368` `observe_clock(conn, &conv_id, item.seq)` ✓
- 接收（Hello 带会话时钟）→ `network/transport/handle_identity.rs:83` `observe_clock(&dbc, &device_id, conv_clock)` ✓
- 群聊清空边界 → `commands/chat.rs:1433` 写边界 → `gossip.rs:883` 拦 ⇒ `seq <= boundary` 不回灌 ✓
- **群历史同步路径的边界消费** → `db/group_history.rs:321` `group_message_blocked_by_boundary(conn, group_id, item.seq, &item.kind)` ✓（与 gossip 路径同一判据）

**Searched:**
- `ORDER BY seq` → 7 hits（`db/clocks.rs:83`、`db/group_history.rs:164`、`db/messages.rs:107/146/179/190`、`commands/group_announcements.rs:33`、`commands/group_files.rs:322`）。**全部**带 `id ASC` 或 `id DESC` 作为第二排序键 ⇒ 与 `seq ASC, id ASC` 一致 ✓
- `ORDER BY ts` → 检查 `db/messages.rs` 其它查询：`:179` 是 `ORDER BY seq DESC, id DESC` 的镜像（最近页）；`commands/group_announcements.rs:33` 是 `ORDER BY seq ASC, msg_id ASC`（群公告），`commands/group_files.rs:322` 是 `ORDER BY seq DESC, msg_id DESC`。**无**任何以 `ts`/`created_at` 为首排序键的消息列表查询 ⇒ 墙上时钟不参与消息排序 ✓
- `observe_clock` / `next_clock` → 全仓 14 处调用点（`commands/window.rs:196`、`commands/share.rs:235`、`db/group_history.rs:368/734`、`commands/files.rs:411`、`commands/chat.rs:721/1054`、`commands/group_announcements.rs:408`、`network/transport.rs:1354/1443`、`network/transport/handle_identity.rs:83`、`network/transport/relay_file.rs:486`、`network/transport/group_file.rs:748`、`network/transport/handle_file.rs:561`、`network/transport/gossip.rs:1171`、`network/transport/handle_messaging.rs:159`）+ `db/clocks.rs` 定义 + `db/favorites_tests.rs` 用例。**没有第三处时钟实现** ✓
- `sender_wall_clock` / 墙上时钟参与排序 → 0 hits；`ts` 仍被存进 `messages.ts` 列，但它只用于"最后消息时间"展示与 `conversation` 排序（`db/conversations.rs` 的会话列表按 `last_ts`），**不决定消息在会话内的顺序** ✓
- `clear_boundary` → `db/group_delete_boundary.rs`（定义）、`commands/chat.rs:1433`（写）、`db/group_history.rs:321` + `network/transport/gossip.rs:883`（读）⇒ 唯一键 `clear_boundary:group:{gid}` ✓

**Hook verification:**
- `db::tests::conversation_clock_is_monotonic` — 基线命中 ✓。实测定义在 `src-tauri/src/db/favorites_tests.rs:2408-2419`（`conversation_clocks` 家族测试，`next_clock` 单调 + `observe_clock` 只前进不回退）。它被 `db.rs` 的 `include!` 放进 `db` 作用域 ⇒ 全名 `db::tests::conversation_clock_is_monotonic` 与文档一致。
- `db::tests::clear_boundary_blocks_old_group_messages` — 基线命中 ✓。定义在 `src-tauri/src/db/favorites_tests.rs:2041-2056`（`group_message_blocked_by_boundary` 的真值表：`seq <= boundary` 拦、`seq = boundary` 拦、`seq > boundary` 放行、无边界不拦、重复清除覆盖边界）。
- `db::tests::latest_page_breaks_seq_ties_by_id_exactly_like_the_ascending_query` — 基线命中 ✓。
- `network::file::tests::group_receive_rejects_gap_but_ignores_duplicate_seq` — 基线命中 ✓（`src-tauri/src/network/file_tests.rs` 内）。
- `network::file::tests::group_chunk_seq_rule_has_exactly_one_home` — 基线命中 ✓。

全部五条都在 `src-tauri/test-baseline.macos.txt` 与 `test-baseline.windows.txt` 中有登记 ⇒ 注册到本平台基线（`check-invariant-hooks.mjs` 的 rust 形态判定 = 本平台基线名集合）。

**How the verdict was reached:** 文档的四条规则逐条对上号：发送 +1 并持久化（`next_clock` 的同事务 upsert）、接收 `max(1, received_seq)` 并推进时钟（两处 `seq.max(1)` + 两处 `observe_clock`）、排序 `seq ASC, id ASC`（全仓 7 处排序全部带第二键，无 `ts` 首排序）、群清空边界 `seq <= boundary` 拦截（`group_message_blocked_by_boundary` + 两个消费点）。两条禁止项也成立：全仓无以墙上时钟为首排序键的消息查询；`observe_clock` 取 `MAX` 而不是把观察值当权威 ⇒ 接收端不纠正发送端时钟。定为 `implemented` 而非 `partial`：`seq.max(1)` 在**两条**入站路径（直连 `handle_messaging.rs:141` 与跨跳 `gossip.rs:1103`）上都存在，不是只做了一半；边界拦截也覆盖了 gossip 与群历史同步两条回灌路径。

**Open questions:**
- `observe_clock` 的调用点全部以 `.ok()` 吞掉写库失败（`handle_messaging.rs:159`、`gossip.rs:1171`、`transport.rs:1443`、`handle_identity.rs:83`、`group_history.rs:368`）。写库失败 ⇒ 本地时钟**不前进** ⇒ 本机后续自己发的消息会拿到一个可能与历史撞号的 seq。是否需要留痕？
- `db/group_history.rs:287` 的注释说 `observe_clock` "与这条要不要计未读无关" —— 那是消费侧的说明，不影响本条判定，但说明这条时钟的推进点散在五处，与 INV-P30 的"一个家"风格不同（那一条只管前端）。
