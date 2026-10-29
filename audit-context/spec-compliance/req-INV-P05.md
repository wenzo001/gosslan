## REQ-INV-P05 — Process Crash Must Not Lose Queued Message

> "以下场景：
>
> ```text
> write outbox
> process crash
> restart
> ```
>
> 重启后必须仍能发现：
>
> ```text
> pending outbox
> ```
>
> 并尝试补发。"
> — docs/protocol-invariants.md §INV-P05, line 159-173

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** outbox 行是**落盘**的（SQLite），进程崩溃不能把它带走；重启后系统必须能重新发现仍 pending 的行并再次尝试投递，而不是把它们当成"发送中"永远挂着。

**Where enforcement lives:**

1) **outbox 行在 SQLite 里（WAL 模式、事务提交）**：`outbox` 表定义在 `src-tauri/src/db.rs:850`；写入走 `insert_message_and_outbox`（`db/messages.rs:47-L76`，一个事务）或 `insert_outbox`（`db/offline_queue.rs:59-L65`）。进程崩溃 ⇒ 已提交的行在 WAL 里，重启后仍在。

2) **重启后重新发现 pending outbox 的三个出口**：

```rust
// src-tauri/src/state.rs:2674-L2699  （5s 周期重放器，进程级常驻）
pub fn spawn_outbox_retrier(state: &Arc<AppState>) -> tauri::async_runtime::JoinHandle<()> {
    ... tokio::time::sleep(Duration::from_secs(OUTBOX_RETRY_SECS)).await;
    let peers: Vec<String> = { let links = st.links.lock().await; links.keys().cloned().collect() };
    for peer in peers {
        crate::network::transport::flush_outbox(&st, &peer).await;
        crate::network::transport::flush_group_outbox(&st, &peer).await;
        crate::commands::flush_pending_files(&st, &peer).await;
    }
}
```
注册在 `src-tauri/src/worker_supervisor.rs:55-L58` 的 `RESIDENT_WORKERS` 名单（`name: "outbox_retrier"`）⇒ 进程级常驻，与网络生命周期无关。

3) **建链 / Hello / 心跳三个事件驱动的补发点**（覆盖"重启后第一次连上对端"）：
- `network/transport/handle_identity.rs:86`（Hello 臂）`flush_outbox(state, &device_id).await;`
- `network/transport/handle_identity.rs:122`（Heartbeat 臂）`flush_outbox(state, &device_id).await;`
- `network/transport/dial.rs:631`（出站拨号建链）`flush_outbox(state, &peer_id).await;`
- `network/ble/central.rs:656` / `network/ble/peripheral.rs:587`（BLE 两条建链路径）

4) **`flush_outbox` 从 DB 读 pending 行**（不是从内存态）：

```rust
// src-tauri/src/network/transport/outbox_flush.rs:12-L27
pub async fn flush_outbox(state: &AppState, peer_id: &str) {
    let pending = { let dbc = state.db.lock()...; db::list_outbox(&dbc, peer_id) };
    let pending = match pending { Ok(v) => v, Err(e) => { state.logger.error("outbox", format!("code=OUTBOX_FLUSH_READ_FAILED peer={peer_id} err={e} —— 本轮补发跳过")); return; } };
    for (id, payload) in pending { ... try_send(...) }
}
```
`db::list_outbox`（`db/offline_queue.rs:67-L71`）= `SELECT id, payload FROM outbox WHERE peer_id = ?1 ORDER BY id` ⇒ **只读 DB**，重启后内存态清空也不影响。

5) **重启时的孤儿修复（不误杀可补发的行）**：

```rust
// src-tauri/src/db.rs:248-L262
pub fn recover_orphan_sending_messages(conn: &Connection) -> Result<usize> {
    let changed = conn.execute(
        "UPDATE messages SET status = 'failed'
          WHERE status = 'sending'
            AND msg_id NOT LIKE 'file-%' AND msg_id NOT LIKE 'gfile-%'
            AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.msg_id = messages.msg_id)
            AND NOT EXISTS (SELECT 1 FROM group_outbox g WHERE g.msg_id = messages.msg_id AND g.status = 'pending')", [])?;
    Ok(changed)
}
```
调用点 `src-tauri/src/state.rs:1917`（启动路径）。⇒ **有 outbox 行的 `sending` 消息绝不被判死**（它们才是"还能补发"的），只有既无 outbox 行又无 pending 群行的孤儿才落 failed。

6) **补发时重封（对方换过身份也能重发）**：`reseal_for_send`（`network/transport/e2ee_payload.rs:71-L129`）在补发前用**当前**公钥重新密封，但 `msg_id` 原样带回 ⇒ 重启补发不换身份。

**Paths walked:**
- 写 outbox → 进程被 SIGKILL → 重启 → `db::init` 打开同一个库（`db.rs:init`）⇒ outbox 行仍在 → 5s 周期重放器读到（前提：该 peer 已建链）→ `try_send` 补发 ✓
- 重启 → 对端上线并建链 → Hello 臂 `flush_outbox` → 补发 ✓（不依赖 5s 周期）
- 重启 → 对端在线但本机还没建链 → 周期重放器的 `links` 为空 ⇒ 本轮不跑；待建链后由 Hello/心跳路径补发 ✓
- 重启 → 消息状态 `sending` 且 outbox 行在 ⇒ `recover_orphan_sending_messages` 的 `NOT EXISTS (outbox)` 谓词不命中 ⇒ 状态保持 `sending` ⇒ 补发后正常 Ack 收尾 ✓
- 重启 → 消息状态 `sending` 且**无** outbox 行（极窄崩溃窗口）⇒ 被判 `failed` ⇒ 用户可见、可重发 ✓
- 重启 → 对方离线 ⇒ outbox 行保留 7 天（`db/offline_queue.rs:23` `OUTBOX_OFFLINE_HOLD_MS`）⇒ 之后上线补发 ✓
- 重启 → 坏 payload 行（JSON 解不开）⇒ `outbox_flush.rs:31-L41` 记 `OUTBOX_PAYLOAD_CORRUPT` 并 `continue` ⇒ **不删行** ⇒ 交给清扫器落终态 ✓
- 重启 → 对方换了身份 → `reseal_for_send` 用当前公钥重封 ⇒ 解得开 ✓（`msg_id` 不变 ⇒ 接收端按 msg_id 去重）

**Searched:**
- `list_outbox` → 3 hits：`db/offline_queue.rs:67`（定义）、`outbox_flush.rs:15`、`db/offline_queue.rs:379`（测试）
- `flush_outbox(` → 10 hits：`outbox_flush.rs:12`（定义）、`handle_identity.rs:86`、`:122`、`dial.rs:631`、`ble/central.rs:656`、`ble/peripheral.rs:587`、`network/ble.rs:36`（import）、`outbox_flush.rs` 文档注释、`db/offline_queue.rs:12`（注释）、`db/offline_queue.rs:18`（注释）
- `recover_orphan_sending_messages` → 3 hits：`db.rs:248`（定义）、`state.rs:1917`（启动调用）、`db/group_offline_queue.rs:325`（注释）
- `spawn_outbox_retrier` → 4 hits：`state.rs:2674`（定义）、`worker_supervisor.rs:57`（名单）、`lib_outbox_tests.rs:320`/`:325`（守卫）
- `RESIDENT_WORKERS` → `worker_supervisor.rs:50`
- `outbox` 表定义 → `db.rs:850`
- `WAL` / `journal_mode` → `db.rs` 的 `init` 一带（WAL 模式）
- 内存里的 pending outbox 队列 → **0 hits**（不存在"内存版 outbox"；`state.rs` 里没有 outbox 字段，只有 `file_receivers` 之类的接收器）

**Hook verification:**
- `db::tests::pending_read_survives_restart` → `src-tauri/src/db/favorites_tests.rs:1251`；两平台基线在册 ✓ —— **但它判的是 `pending_reads` 表（待发已读回执）的重启恢复，不是 outbox**。outbox 的"重启后仍在"由 e2e 判据与 `db::startup_safety_tests::orphan_sending_is_recovered_but_queued_and_terminal_rows_are_untouched`（`db/startup_safety_tests.rs:108`，判"有队列行的 sending 不许判死"）覆盖。
- `content::store::tests::failure_persists_resumable_or_terminal` → `src-tauri/src/content/store.rs:439`；两平台基线在册 ✓ —— 判的是 `content_transfers` 表的失败落库（可恢复 ⇒ Incomplete 且能被 `list_resumable_for_peer` 捞出；不可恢复 ⇒ Rejected 且从可恢复列表消失），与"outbox 崩溃不丢"是**同一族机制的第二张表**（内容寻址管线）。
- `e2e:L-B 故障注入：两端重启后仍正确` → `scripts/e2e-multi-instance.mjs:606`（`step("L-B 故障注入：两端重启后仍正确", ...)`）；由 `check-invariant-hooks.mjs` 的 `e2e:` 形态解析（检索面 = 驱动 + `scripts/e2e/core.mjs` + `scripts/e2e/rounds/*.mjs`）⇒ 解析成功 ✓
  - L-B 的实际判据（`:606-L645`）：`stopAll()` → `bootAndStop("重启")` → 断言 **B 侧 messages 表里该 msg_id 仍只有一条、内容不变**（`:610-L613`），以及 **A 侧 outbox 表里该 msg_id 的行数为 0**（"重启不复活已 Ack 的 outbox 行（不二次投递）"，`:615-L617`）。
  - ⚠️ 注意方向：L-B 判的是"**已 Ack 的** outbox 行不复活"，不是"**未 Ack 的** pending outbox 行在重启后被补发"。后者由 `scripts/e2e/rounds/kill.mjs:39`（"故障注入判据③：接收中被 SIGKILL ⇒ 不许假成功，重启后按盘上真实字节续完"）与 `scripts/e2e/rounds/sendkill.mjs:23`（"判据⑩：发送端在飞时被 SIGKILL ⇒ 崩溃不许抹掉『已入队』，重启后必须自己续完"）在**文件**侧覆盖，**消息**侧没有对应的 e2e 判据。

**How the verdict was reached:** 三个必要条件逐一落到代码：(a) outbox 行落盘 ⇒ `outbox` 表 + 事务；(b) 重启后能重新发现 ⇒ `flush_outbox` 只读 DB + 三类事件触发 + 5s 周期重放器；(c) 不误杀 ⇒ `recover_orphan_sending_messages` 的 `NOT EXISTS` 谓词。三条都成立，且"崩溃前写、崩溃后补"的完整链条在代码里是可读的。所以不是 `partial`（每个环节都通），也不是 `stronger-than-spec`（没有额外约束超出 spec）。

**Open questions:**
- **spec 点的两条 Rust 钩子都不直接判"outbox 崩溃不丢"**：`pending_read_survives_restart` 判 `pending_reads` 表，`failure_persists_resumable_or_terminal` 判 `content_transfers` 表。真正对应"outbox 行重启后仍在"的判据是 `db::startup_safety_tests::orphan_sending_is_recovered_but_queued_and_terminal_rows_are_untouched`（在册，**未被 spec 点名**）。**需要确认 spec 的钩子清单是否指错了表。**
- **消息侧的"崩溃后 pending outbox 被补发"没有 e2e 判据**。L-B 判的是反方向（已 Ack 的行不复活）；`kill.mjs:39` / `sendkill.mjs:23` 判的是文件侧。消息侧的"写 outbox → SIGKILL → 重启 → 补发 → 对端收到"在 e2e harness 里**没有对应 step**。**需要确认这是否是一个真实缺口（spec 要求的场景未被端到端证明）。**
- e2e harness 的 `check()` 机制与 `takeShot` 与本条无关，但 L-B 的第一个断言（B 侧仍只有一条）依赖**重启前 B 已经收到并落库**；若崩溃发生在"B 收到之前"，这条判据并不覆盖该情形。
