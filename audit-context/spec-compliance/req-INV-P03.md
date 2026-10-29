## REQ-INV-P03 — ACK Means Durable Receive

> "ACK 只有在接收方完成项目定义的"接收确认"后才能发送。
>
> 不能把：
>
> ```text
> socket write
> ```
>
> 等价为：
>
> ```text
> message delivered
> ```"
> — docs/protocol-invariants.md §INV-P03, line 77-89
>
> 附带（spec 自己的 ⚠️ 注释，line 92-93）：
> "- ⚠️ **这些钩子各管一半，别读成"整条已被证明"**：上列后三条证明的是**接收侧前件** —— 密文损坏 / 被篡改 / 明文载荷都必须被 `open_direct_content` 拒收，且拒收后 `msg_id` 仍然空闲（⇒ 没落库）。而"于是也不发 Ack"这后半句今天**只由控制流保证**：`transport.rs` 的 `Message::ChatMessage` 臂里解密失败就是 `else { return; }`，Ack 那句在同一个臂的更后面，中间没有可注入的判定函数。
> 为什么没有行为用例（写清楚，免得下一个人重复调查）：本仓的 state **接不进测试夹具**，而且原因不是"没装 MockRuntime" —— `state.rs:873-874` 的 `AppState { pub app: AppHandle, … }` 里那个**裸 `AppHandle` 是具体 Wry 运行时**：结构体自身声明的是 `AppHandle<R: Runtime>`（`tauri-2.11.5/src/app.rs:386`），默认运行时由它上面那行 `#[default_runtime(crate::Wry, wry)]`（同文件 `:384`）展开成 `AppHandle<Wry>`，**不是** `pub type AppHandle` 那种可直接替换的别名；而 `AppState` 只有 `AppState::init(app: AppHandle)` 这一个构造器（`state.rs:1173`），`Cargo.toml` 里**没有 `[dev-dependencies]`**。⇒ **单开 `tauri` 的 `test` feature / 换用 `MockRuntime` 也接不进来**（`AppHandle<MockRuntime>` 与 `AppHandle<Wry>` 是两个不同类型），所以既实例化不了 state，也拿不到 `try_send` 需要的链接；全仓没有任何测试调用过 `handle_message`。要补这条，先补的是"能在测试里造出 AppState 并发出可捕获的出站帧"这件基础设施，不是再加一条断言。"

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** Ack 只能在"接收方已把消息**持久化**（或明确判定为重复/已存在）"之后发；socket write 成功、payload 到达、消息被读到，都不等于"已接收"。失败的接收（解不开、落库故障、超限）绝不能回 Ack —— 否则发送方会删掉 outbox 行，消息永久丢失。

**Where enforcement lives:**

1) **Ack 的发出点在落库之后**（同一臂内，Ack 句在落库块之后）：

```rust
// src-tauri/src/network/transport/handle_messaging.rs:99-L118
let Some((content, kind_str)) = open_direct_content(
    &state.identity.x25519_secret, sender_x25519_pubkey(state, &from).as_deref(), &content, kind,
) else {
    if log_throttled("direct_open_failed", 5_000) {
        state.logger.warn("chat", format!("code=DIRECT_OPEN_FAILED peer={from} len={}", content.len()));
    }
    return;                    // ← 解不开：不落库、不 Ack
};
```
紧接着长度闸（`:122-L131`）同样 `return`（不落库、不 Ack）。

2) **落库块 + Ack 之间的三态闸**：

```rust
// src-tauri/src/network/transport/handle_messaging.rs:137-L199
let (out_rec, inserted) = { /* insert_message_if_new + 条件 touch_conversation */ };
// 真数据库错误 ⇒ 消息没有持久化 ⇒ 既不投递也绝不 Ack
if !may_ack(&inserted) {           // may_ack = !inserted.is_err()
    if let Err(e) = &inserted { state.logger.error("dispatch", format!("1:1 入站消息落库失败 msg={}：{e} —— 不回 Ack，发送方 outbox 保留待补发", msg_id)); }
    return;
}
if announced_on(&inserted) { let _ = state.app.emit("message-received", &out_rec); ... }
state.logger.info("ble", format!("[ACK] 已持久化 ⇒ 回执 msg_id={msg_id} → peer={peer_id}"));
let _ = try_send(state, peer_id, &Message::Ack { msg_id }).await;
```
⇒ **Ack 的前置条件就是"这次落库没有失败"**（`may_ack`）——不是"socket write 成功"。

3) **重复投递路径也回 Ack（因为消息确已在库）**：`handle_messaging.rs:63-L72`（`message_exists` 命中 ⇒ 回 Ack 并 return）。这正是"ACK 语义 = 已持久化"的另一面：库里已有 ⇒ 已接收过 ⇒ 可以再回一次。

4) **Gossip 侧同纪律**：

```rust
// src-tauri/src/network/transport/gossip.rs:1221-L1231
// 群消息现在有 outbox 兜底：只要消息确实已持久化（无论本次是否新建），
// 就回 GroupAck 让发送方删除对应 (msg_id, peer_id) 的待发记录。
// 数据库 Err 时不回 Ack，发送方保留 outbox 继续补发。
if conv_kind == "group" && !inserted.is_err() { ... try_send(state, &env.sender_id, &ack).await; }
```
单聊跨跳同理（`gossip.rs:1236`：`if conv_kind == "single" && !inserted.is_err()`）。

5) **Ack 的收尾也在事务里**（不是"socket write 成功就删队列"）：`db::ack_delivered`（`db/messages.rs:841-L863`）在一个事务里做"校验命中 + 置 delivered + 删 outbox 行"；`db/messages.rs:860` 的 `DELETE FROM outbox` 只在 Ack **命中**后执行。

6) **禁止形态的实际缺席**：`send() == Ok → delete outbox` 这条禁令在代码里的对应物是 `flush_outbox`（`network/transport/outbox_flush.rs:12-L56`）**只发不删**，文件头注释 `:6-L8` 明写："这里**只补发、不删除**——outbox 行仅在收到对方 `Ack`（真正确认送达）时删除。旧实现 `try_send` 返回 Ok（仅表示已入发送队列）就删行，半开 TCP 链路上会静默丢消息"。

**Paths walked:**
- Direct 入站、密文完好 → 落库 `Ok(true)` → `may_ack` 真 → 回 Ack ✓
- Direct 入站、**密文损坏/被篡改**（`open_direct_content` 返 None）→ `:117` `return` ⇒ 不落库、**不发 Ack** ✓（发送方 outbox 行保留 → 补发）
- Direct 入站、**明文载荷**（无 `enc1:` 前缀）→ `open_direct_content` 的 `wire.strip_prefix("enc1:")?`（`e2ee_payload.rs:45`）返 None ⇒ 同上 ✓
- Direct 入站、**缺对端公钥** → `sender_x25519_pubkey` 返 None ⇒ `open_direct_content` 的 `sender_pubkey?` 返 None ⇒ 同上 ✓
- Direct 入站、**落库真故障**（`Err`）→ `may_ack` 假 ⇒ `:171-L186` return ⇒ **不发 Ack**、不投递 ✓（`db/messages.rs:26-L27` 注释：折叠成 false 会让临时故障变成永久丢消息）
- Direct 入站、**入站内容超长**（>5 万字符）→ `:122-L131` return ⇒ 不落库、不 Ack ✓
- Direct 入站、**重复投递** → `message_exists` 命中 ⇒ 回 Ack（可重复发送）✓
- Gossip 入站、解不开（缺群密钥/缺 X25519）→ `plaintext` 为 None ⇒ `if let Some(pt)` 整块跳过 ⇒ 不落库、**不回 ChatAck** ✓（`gossip.rs:777`）
- Gossip 入站、落库 `Err` → `gossip.rs:1188-L1198` 记 error、`allow_message_retry` 撤销去重 ⇒ `!inserted.is_err()` 假 ⇒ **不回 ChatAck** ✓
- Gossip 入站、正常 → `!inserted.is_err()` 真 ⇒ 回 ChatAck ✓
- **socket write 成功但对端没收到** → Ack 丢失 ⇒ 发送方 outbox 行仍在 ⇒ 补发时接收方 `message_exists` 命中 ⇒ **再回一次 Ack** ⇒ 收敛 ✓

**Searched:**
- `try_send(state, peer_id, &Message::Ack` → 2 hits：`handle_messaging.rs:70`（重复路径）、`:199`（落库后）
- `Message::Ack { msg_id }` → 4 hits：`handle_messaging.rs:70`、`:199`、`protocol.rs`（枚举定义）、`network/transport/gossip.rs`（转发 Ack 给原始发送方 `:248`）
- `Message::GroupAck` → `gossip.rs:1225`（构造）、`handle_group.rs:60`（接收）
- `DELETE FROM outbox` → 3 hits：`db/messages.rs:860`（`ack_delivered`，事务内）、`db/offline_queue.rs:115`（`delete_outbox_by_msg_id`，被 `finalize_expired_message` 用）、`db/offline_queue.rs:138`（`fail_pending_messages_for_peer`，删好友时）
- `try_send(...).is_ok()` 后紧跟删除 outbox → **0 hits**（禁令形态在代码中不存在）
- `socket write` / `write_frame` 与 outbox 删除相邻 → 0 hits
- `may_ack` → 2 hits（定义 + 唯一调用点）
- `open_direct_content(` → 5 hits：`e2ee_payload.rs:39`（定义）、`handle_messaging.rs:99`、`e2ee_tests.rs:25`、`:43`、`:169`
- `Message::ChatMessage` 臂内的 `return` → `handle_messaging.rs:51`（from≠peer）、`:55`（to≠me）、`:71`（重复）、`:89`（非好友）、`:117`（解不开）、`:130`（超长）、`:185`（落库故障）

**Hook verification:**
- `db::tests::message_and_outbox_are_written_atomically` → `src-tauri/src/db/favorites_tests.rs:1092`；两平台基线在册 ✓
- `db::tests::ack_from_non_recipient_is_rejected` → `src-tauri/src/db/favorites_tests.rs:1947`（群文件 recipient：非 recipient 的 ACK 更新必须 `is_err()`）；两平台基线在册 ✓ —— **注意它判的是群文件台账的 recipient 校验，不是 1:1 消息 Ack**
- `db::tests::ack_sender_check_uses_group_file_owner` → `src-tauri/src/db/favorites_tests.rs:1974`；两平台基线在册 ✓ —— 同上，是群文件 owner 判定
- `db::tests::repeated_ack_is_idempotent` → `src-tauri/src/db/favorites_tests.rs:1956`（群文件 recipient 重复 ACK 幂等）；两平台基线在册 ✓ —— 同样是群文件族
- `network::transport::tests::direct_open_rejects_corrupt_and_tampered_payloads` → `src-tauri/src/network/transport/e2ee_tests.rs:133`；两平台基线在册 ✓
- `network::transport::tests::plaintext_payload_is_rejected` → `src-tauri/src/network/transport/e2ee_tests.rs:167`；两平台基线在册 ✓
- `db::tests::failed_decrypt_leaves_msg_id_free_for_the_later_good_copy` → `src-tauri/src/db/favorites_tests.rs:729`；两平台基线在册 ✓
- 支撑（spec 未点名但在册）：`db::ack_delivery_tests::ack_marks_delivered_and_clears_only_the_expected_peer_row`（`db/messages.rs:1024`）、`db::ack_delivery_tests::duplicate_and_late_acks_are_idempotent_and_never_change_the_verdict`（`db/messages.rs:1064`）、`db::ack_delivery_tests::ack_rolls_back_the_status_when_outbox_delete_fails`（基线 `db::ack_delivery_tests::ack_rolls_back_the_status_when_outbox_delete_fails`）

**How the verdict was reached:** spec 自己已经声明"后三条钩子各管一半（只证接收侧前件），'不发 Ack' 这后半句只由控制流保证"。我按这条声明去核对控制流：`handle_messaging.rs` 的 `Message::ChatMessage` 臂里，解密失败是 `:104-L118` 的 `let Some(...) = ... else { ... return; }`，Ack 那句在 `:199`，中间隔着 `:171` 的 `may_ack` 闸 —— 两条 return 都在 Ack 之前 ⇒ **"不发 Ack"确实成立，但正如 spec 所说，只由控制流保证，没有可注入的判定函数**。spec 的 ⚠️ 与代码现状**一致**，所以不是 `partial`（spec 明确承认这个缺口并给出理由），判 `implemented` 但要在本文件里把 spec 的自述缺口如实记下。Hook 名单里那三条 Ack 相关的钩子（`ack_from_non_recipient_is_rejected` / `ack_sender_check_uses_group_file_owner` / `repeated_ack_is_idempotent`）**判的是群文件台账**，不是 1:1 消息 Ack —— spec 把它们挂在 INV-P03 下属于**分类错位**（见 Open questions），但它们确实存在、确实在册、确实在跑。

**Open questions:**
- **spec 的 ⚠️ 里有两处陈述已与今天的代码不符**：(a) 它说"`Cargo.toml` 里**没有 `[dev-dependencies]`**" —— `src-tauri/Cargo.toml:194-L196` 现在**有** `[dev-dependencies] tempfile = "3"`（测试夹具用的临时目录）。这不改变结论（`AppHandle<Wry>` vs `AppHandle<MockRuntime>` 的类型不兼容才是真因，且 `tempfile` 与 `tauri` 无关），但 spec 的**理由陈述**已过期。(b) 它引用的行号 `state.rs:873-874`（`AppState { pub app: AppHandle }`）与 `state.rs:1173`（`AppState::init`）与今天的代码不符 —— 今天分别是 `src-tauri/src/state.rs:1060-L1061` 与 `:1753`（`pub fn init(app: AppHandle)`）。**需要确认这两处行号是抄自旧版本还是笔误。**
- **spec 的 ⚠️ 断言"全仓没有任何测试调用过 `handle_message`"** —— 我核实为真：`handle_message(` 的全部调用点是 6 个生产点（`transport/queue_policy.rs:251`、`transport/dial.rs:619`、`ble/peripheral.rs:561`、`ble/central.rs:632`、`ble/io_loops.rs:225`、`transport.rs:787`）加 1 个测试（`lib_compat_gating_tests.rs:40` 只是**读源码字符串**、不调用）。所以"Ack 与落库的时序"今天**没有行为用例**，只有源码形状用例（`lib_outbox_tests.rs:405` `ack_commit_uses_the_single_transaction_helper` 钉"走 `db::ack_delivered` 这一处事务出口"、不许长出内联删行）。
- **INV-P03 的三个 Ack 钩子分类错位**：`ack_from_non_recipient_is_rejected`、`ack_sender_check_uses_group_file_owner`、`repeated_ack_is_idempotent` 三条都落在 `db/favorites_tests.rs` 的**群文件**段（`:1945-L1981` 的注释标题就是「GroupFileCompleteAck（sender 侧 recipient 状态迁移）」），判的是 `update_group_file_recipient` 的 recipient 校验与幂等。1:1 消息 Ack 的对应判据其实存在（`db::ack_delivery_tests::*`），但**spec 没点名它们**。这意味着：spec 声称的"Ack 幂等 / 非收件人 Ack 被拒"在钩子层面被群文件那族顶替了，1:1 消息 Ack 的对应验证**在册但未被引用**。**需要确认 spec 的钩子清单是想指群文件还是 1:1 消息。**
- 群文件链路的 Ack（`FileCompleteAck`）走的是**另一套**语义（`success: bool` + 台账行 `file_transfers` / `group_files`），与 1:1 消息 Ack 的"命中 outbox 行"判据不同源。spec 的 INV-P03 只描述了消息语义，未覆盖文件族。
