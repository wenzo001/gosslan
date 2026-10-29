## REQ-INV-P06 — Retry Must Be Idempotent

> "重试不得生成新的业务消息 ID。
>
> ```text
> retry(msg_id)
> ```
>
> 不是：
>
> ```text
> create_new_message()
> ```"
> — docs/protocol-invariants.md §INV-P06, line 183-193
>
> 附带 spec 自述（line 197-L233）：
> "### 界面上的「重发」回归同 id 重投（2026-10-25）
> 2026-09-25 曾把 `resend_message` 删掉、界面重发改走 `chat.send`（新 `msg_id`）；那条记录当时如实写下了"INV-P06 在 UI 路径上不成立"。2026-10-25 起**已改回同 id 重投**，因为它正是本轮需求「重试必须复用稳定消息身份」的全部意义：半开链路上 Ack 丢失时，新 `msg_id` 会让对端多收一条。
> 今天的两条入口（都不生成新业务消息 id）：
> - 1:1：`resend_message` 只接受 `failed` / `cancelled`，**复用原 `msg_id` / `ts` / `seq`**；
>   接收端按 `msg_id` 去重，重复到达只会再回一次 Ack。入队与置 `sending` 在 `db::requeue_message_for_resend` 的**一个事务**里（`INSERT OR IGNORE` + 条件 UPDATE）。
> - 群：`resend_group_delivery` 只把台账里的 `cancelled` 行重置为 pending（`msg_id` 不变），
>   已 delivered/failed 的成员不动；`no_ledger`（升级前发出的历史消息）才退回整条重发。
> ……两条用真事故换来的规则仍然必须连实现一起保留：
> 1. **先密封再入队**：`messages` 存的是**明文**，直接把库内 content 上线就没有 `enc1:` 前缀 ⇒ 接收端 `open_direct_content` 拒收（不落库、不 Ack）⇒ 重发静默变 no-op，稍后又被清扫器判 failed（用户看到「点重发没反应」）。`ts`/`seq` 同理必须沿用原记录：`seq: 0` 会让接收端把重发消息排到会话最前（排序按 seq，INV-P09），两端顺序分裂。
> 2. **所有可失败步骤通过之后才置 `sending`**：旧顺序先 `set_message_status("sending")` 再判群聊 / 取公钥 / 密钥交换 / 加密，失败路径不回滚 ⇒ 状态永久卡 `sending`，而重发入口的守卫又把它挡死 ⇒ 这条消息**永远发不出去**，outbox 也从未写入。现在的顺序是：校验原记录与状态 → 取钥 → 重密封并重签 → 一个事务入队+置 sending。"

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 任何"重试/重发"都必须在**同一条业务消息**上进行：复用原 `msg_id`（以及排序用的 `ts`/`seq`），不改内容语义；入队与状态推进在一个事务里；任何可失败的步骤（取钥、加密）失败时**不得**留下半状态。

**Where enforcement lives:**

1) **1:1 重发：复用原 msg_id / ts / seq**：

```rust
// src-tauri/src/commands/chat.rs:931-L958
// ③ 用**原来的 ts/seq** 重新密封（内容仍是库里的明文；信封里的密文按当前公钥重签）。
let ts = msg.ts;
let seq = msg.seq;
let plaintext = crate::protocol::gossip_plaintext(&msg.kind, &msg.content, None);
let shared = crypto::shared_secret(&s.identity.x25519_secret, &pubkey).ok_or("密钥交换失败")?;
let sealed = crypto::seal(&shared, plaintext.as_bytes()).ok_or("加密失败")?;
...
let mut env = { gossip.build_envelope(...) };
// ⚠️ 这一行是"复用稳定身份"的全部：信封身份默认由 (sender, nonce, payload) 现算，
// 重新密封必然换密文 ⇒ 换 ID。这里显式改回原 msg_id，再重签（message_id 参与签名）。
env.message_id = msg_id.clone();
env.target = Some(peer.clone());
env.sender_sig = s.identity.sign_b64(&env.signing_bytes());
```

2) **守卫：只接受 `failed` / `cancelled`**：

```rust
// src-tauri/src/commands/chat.rs:919-L921
if !matches!(msg.status.as_str(), "failed" | "cancelled") {
    return Err("这条消息不是失败/已取消状态，不需要重发".to_string());
}
```
加上归属校验（`:908-L913`：`sender_id != s.device_id` / `conv_id` 不符都拒）与 kind 校验（`:916-L918`：`file`/`image`/`recall`/`render` 不支持原地重发）。

3) **入队 + 置 `sending` 一个事务**：

```rust
// src-tauri/src/db/messages.rs:794-L827
pub fn requeue_message_for_resend(conn: &Connection, msg_id: &str, peer_id: &str, payload: &str) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let status: Option<String> = tx.query_row("SELECT status FROM messages WHERE msg_id = ?1", ...).optional()?;
    let Some(status) = status else { return Ok(0); };
    if !matches!(status.as_str(), "failed" | "cancelled") { return Ok(0); }
    // `INSERT OR IGNORE`：极少数情况下队列行还在（比如心跳 flush 与重发同时到达），直接复用它、不产生第二行
    tx.execute("INSERT OR IGNORE INTO outbox(msg_id, peer_id, payload, created_at) VALUES(?1, ?2, ?3, ?4)", ...)?;
    let changed = tx.execute("UPDATE messages SET status = 'sending' WHERE msg_id = ?1 AND status IN ('failed', 'cancelled')", ...)?;
    tx.commit()?;
    Ok(changed)
}
```
调用点 `commands/chat.rs:974`；`changed == 0` 时 `commands/chat.rs:977-L979` 如实返回 Err（"这条消息已经送达或状态已变，不能重发"）⇒ 不会"以为重发了其实没发"。

4) **顺序：所有可失败步骤先过，最后才置 sending**：`commands/chat.rs` 的 `resend_message` 顺序是 —— 校验归属与状态（`:900-L921`）→ 取钥（`:923-L929`，失败即 Err，**不**动状态）→ 重密封并重签（`:931-L958`，失败即 Err）→ **一个事务**入队+置 sending（`:971-L979`）→ 投递（`:981-L988`）。置 `sending` 只发生在事务里，前面的失败**不可能**留下"卡在 sending"的状态。

5) **"先密封再入队"**：`commands/chat.rs:960-L969` 构造的 `queued` payload 里 `content: wire_content`，而 `wire_content = format!("enc1:{}", STANDARD.encode(&sealed_content))`（`:939`）⇒ **入队的是密文**，不是库里的明文。接收端 `open_direct_content`（`e2ee_payload.rs:39-L53`）要求 `enc1:` 前缀 ⇒ 明文入队会被拒收（不落库、不 Ack）这一形态被排除。

6) **群重发：只重置 cancelled 行，msg_id 不变**：

```rust
// src-tauri/src/commands/chat.rs:236-L239
/// 只把 `cancelled` 行重置为 pending；在线成员立即 flush，离线保留 pending 等上线。
/// 不重签/不重加密：`group_outbox.payload` 就是原来那个已签名 Gossip 信封，
/// 接收端按 msg_id 幂等 ⇒ 已 Ack 的成员不会收到第二条。历史消息没有台账时返回 `no_ledger`。
```
`db::resend_cancelled_group_rows`（`db/group_offline_queue.rs:236` 一带）把 `cancelled` 行改回 pending；`group_outbox` 的 payload 就是原信封本身 ⇒ **msg_id 与密文都不变**。
`no_ledger` 分支（`commands/chat.rs:271-L282`）返回 `no_ledger` / `unsupported` / `already_pending` / `already_delivered` / `already_failed` 五个结论，由界面决定是否退回整条重发。

7) **前端：重发路径不许新建第二条**：
- `src/components/MessageItem.vue` 单聊走 `chat.resend(msg.conv_id, msg.msg_id)`；群走 `api.resendGroupDelivery(msg.conv_id, msg.msg_id)`，只有 `no_ledger`/`unsupported` 才退回 `chat.send(..., msg.msg_id)`（带旧 msg_id 作 `retryOfMsgId`）。
- store 侧 `resend()` 调 `api.resendMessage(convId, msgId)` 后用 `replaceMessage(convId, msgId, next)` 原地换气泡，**不** `enqueueMessage`。
- 钩子 `src/utils/retrySend.test.ts` 四条断言钉住这些形状。

8) **文件族（"重试"的另一形态）**：
- 内容寻址管线的重试裁决只有一处纯函数：`file::send_retry_verdict`（`network/file/send.rs` 一带，`commands/files.rs` 的唯一调用点），由 `tests::the_outbox_retry_decision_has_exactly_one_judge_and_one_caller` 钉住（`lib_outbox_tests.rs:231`）。
- 续传只从**分片边界**续：`content::policy::resume_from_seq`（`content/policy.rs:32-L37`，`(received_bytes / chunk_size)` 向下取整），由 `content::policy::tests::resume_only_from_chunk_boundaries` 钉住。
- 轮次（attempt）机制保证"上一轮还在排队的分片"不会被本轮当重复：`network/file/receive.rs:996-L1008` 的 `frame_is_current` 闸 + `:1012-L1015` 的 `chunk_seq_decision`。
- 读不到重试次数时**不判死**：`file::send_retry_verdict(&e, None)` ⇒ `Retry { backoff_ms: 5_000 }`（`network/file_tests.rs:2387`）。
- `.part` 长度 ≥ size **不算进度**（`network/file/receive.rs:440-L443` 的 `decide_offer`），由 `network::file::tests::a_full_length_part_without_rename_is_not_progress` 钉住。

**Paths walked:**
- 1:1 重发，状态 `failed` → 校验通过 → 取钥成功 → 重密封成功 → 事务入队+置 sending ⇒ **原 msg_id / ts / seq** ⇒ 投递 → 对端按 msg_id 去重（已在库 ⇒ 回一次 Ack）✓
- 1:1 重发，状态 `delivered`/`read`/`sending`/`sent` → `commands/chat.rs:919-L921` 直接 Err ⇒ 状态与 outbox **一个字都不动**（钩子 `terminal_and_in_flight_states_are_refused_without_writing` 钉住）✓
- 1:1 重发，取钥失败 → Err，状态仍 `failed` ⇒ 可再次重发 ✓（不卡 sending）
- 1:1 重发，加密失败 → Err，状态仍 `failed` ✓
- 1:1 重发，outbox 行已存在（心跳 flush 与重发撞上）→ `INSERT OR IGNORE` 复用那一行，**不产生第二行**（钩子 `an_existing_queue_row_is_reused_not_duplicated`）✓
- 1:1 重发，消息不存在 → `requeue_message_for_resend` 返回 0，**不写任何东西**（钩子 `an_unknown_message_writes_nothing`）✓
- 1:1 重发，接收端已经落过这条 msg_id（上次其实送到了、只是 Ack 丢了）→ 接收端 `message_exists` 命中 ⇒ 只回 Ack、不产生第二条业务消息 ✓
- 群重发，`cancelled` 行 → 置回 pending、payload 原样（同一信封、同一 msg_id）⇒ 对端按 msg_id 幂等 ✓
- 群重发，已 delivered 的成员 → 不动（`resend_cancelled_group_rows` 只改 cancelled）⇒ 结论 `already_delivered` ✓
- 群重发，无台账（升级前历史消息）→ 返回 `no_ledger` ⇒ 界面退回整条重发（**这是 spec 明说的例外**：此时会生成新 msg_id）✓
- 文件重试（发送端投递失败）→ `send_retry_verdict` 决定 GiveUp / Retry ⇒ 同一 `transfer_id`，不新建消息 ✓
- 文件续传 → 只从分片边界续 ⇒ 同一 `transfer_id`、同一内容摘要 ✓

**Searched:**
- `resend_message` → 3 hits：`commands/chat.rs:888`（定义）、`src/utils/retrySend.test.ts:48`、`:134`
- `resend_group_delivery` → 4 hits：`commands/chat.rs:241`（定义）、`commands/chat.rs` 内调用点、`src/utils/retrySend.test.ts:64`、前端 `MessageItem.vue`
- `env.message_id = ` → 2 hits：`commands/chat.rs:956`（唯一一处"改回原 id"）、`network/transport/gossip.rs:1054`（allow_retry 撤销登记）
- `requeue_message_for_resend` → 5 hits：`db/messages.rs:794`（定义）、`commands/chat.rs:974`、`db/messages.rs:1377`/`:1402`/`:1421`/`:1430`（测试）
- `resend_cancelled_group_rows` → 2 hits：`db/group_offline_queue.rs`（定义）、`commands/chat.rs:264`
- `create_new_message` → **0 hits**（全仓无此函数）
- `send_retry_verdict` → 命中 `network/file/send.rs`（定义）、`commands/files.rs`（唯一调用点）、`network/file_tests.rs:2387` 等（测试）
- `resume_from_seq` → 命中 `content/policy.rs:32`（定义）、`content/policy.rs:148`（测试）、文件续传调用点
- `retryOfMsgId` → `src/stores/useChatStore.ts` 内（群历史消息的整条重发兜底）
- `msg_id` 出现在 `send_message` 签名里 → **0 hits**（`src/utils/retrySend.test.ts:129` 显式断言 `send_message` 签名里不得出现 `msg_id`）—— 首次发送的身份不由客户端指定
- `enqueueMessage` 在 `resend()` 内 → **0 hits**（`src/utils/retrySend.test.ts:55` 断言）

**Hook verification:**
- `db::tests::duplicate_transfer_id_offer_is_idempotent` → `src-tauri/src/db/favorites_tests.rs:1818`；两平台基线在册 ✓（群文件台账：同 `transfer_id` 的 Offer 重复处理不覆盖既有状态）
- `content::policy::tests::resume_only_from_chunk_boundaries` → `src-tauri/src/content/policy.rs:148`；两平台基线在册 ✓
- `network::file::tests::unknown_attempt_count_is_not_a_death_sentence` → `src-tauri/src/network/file_tests.rs:2387`；两平台基线在册 ✓
- `network::file::tests::a_full_length_part_without_rename_is_not_progress` → `src-tauri/src/network/file_tests.rs:1696`；两平台基线在册 ✓
- `e2e:故障注入判据③` → `scripts/e2e/rounds/kill.mjs:39`（"接收中被 SIGKILL ⇒ 不许假成功，重启后按盘上真实字节续完"）；`e2e:` 检索面含 `scripts/e2e/rounds/*.mjs` ⇒ 解析成功 ✓
- `e2e:故障注入判据⑧` → `scripts/e2e/rounds/rot.mjs:25`（"预置可写 .part 后把接收目录改成只读 ⇒ 半路失败不许被当成完成（rename 才算完成）"）⇒ 解析成功 ✓
- `db::resend_requeue_tests::failed_and_cancelled_come_back_to_sending_with_a_queue_row` → `src-tauri/src/db/messages.rs:1372`（并断言 `ts`/`seq` 原样保留：`:1384-L1391`）；两平台基线在册 ✓
- `db::resend_requeue_tests::terminal_and_in_flight_states_are_refused_without_writing` → `src-tauri/src/db/messages.rs:1396`；两平台基线在册 ✓
- `db::resend_requeue_tests::an_existing_queue_row_is_reused_not_duplicated` → `src-tauri/src/db/messages.rs:1413`；两平台基线在册 ✓
- `db::resend_requeue_tests::an_unknown_message_writes_nothing` → `src-tauri/src/db/messages.rs:1428`；两平台基线在册 ✓
- 前端：`src/utils/retrySend.test.ts` 6 条 `test(...)`（`:36`、`:60`、`:80`、`:94`、`:123`、`:153`、`:168`）；由 `package.json` 的 `"test": "node --test ... \"src/**/*.test.ts\" ..."` glob 覆盖 ⇒ 已注册运行 ✓
- `tests::the_outbox_retry_decision_has_exactly_one_judge_and_one_caller` → `src-tauri/src/lib_outbox_tests.rs:231`；两平台基线在册 ✓

**How the verdict was reached:** spec 的两条自述规则（"先密封再入队"、"所有可失败步骤通过之后才置 sending"）都逐条对上了代码：`commands/chat.rs:939`（`enc1:` 密文入队）与 `:900-L979`（校验 → 取钥 → 重密封 → 事务入队+置 sending）的顺序，以及 `db/messages.rs:794-L827` 的单事务实现。"同 id 重投"由 `commands/chat.rs:956` 的 `env.message_id = msg_id.clone()` 一行钉住，且 `ts`/`seq` 复用、群侧 `group_outbox` payload 原样。唯一的"生成新 id"路径是 spec 自己点名的 `no_ledger` 兜底（历史消息无台账），不构成违反。所以不是 `partial`。

**Open questions:**
- **`no_ledger` 兜底确实会生成新 `msg_id`**（前端走 `chat.send(...)`，`commands/chat.rs` 的 `send_message` 里 `msg_id = env.message_id.clone()` 是新算的）。spec 明说这是允许的例外（"升级前发出的历史消息才退回整条重发"），但**这意味着该路径上 INV-P06 不成立**。**需要确认 spec 的"重试"是否只指"有台账的重试"。**
- **`src/utils/retrySend.test.ts` 判的是源码形状（`assert.match(item, /await chat\.resend\(msg\.conv_id, msg\.msg_id\)/)` 等），不是行为**。`resend_message` 的真实行为（复用 msg_id、复用 ts/seq、事务入队）由 `db::resend_requeue_tests::*` 在 db 层覆盖，但**"重发的消息最终到达对端时对端不会多收一条"这一端到端性质没有行为用例**（后端无法构造 AppState，见 INV-P03 的 ⚠️）。
- spec 说"重发入口的守卫又把它挡死 ⇒ 这条消息永远发不出去"是**旧顺序**的描述。今天 `resend_message` 的守卫是 `!matches!(msg.status.as_str(), "failed" | "cancelled")`（`commands/chat.rs:919`）⇒ `sending` 状态确实被挡，但**它不再有"永久卡死"的后果**，因为 `set_message_status` 的硬终态列表里 `failed`/`cancelled` 是终态而 `sending` 不是（`db/messages.rs:700-L701`），且失败路径不再先置 sending。spec 这段是**问题描述**（记录曾经的事故），不是今天的要求 —— 判定按"今天的要求"读。
- 文件族的"重试"在 spec 里没有独立条款；`INV-P06` 的钩子清单里有四条文件钩子，但 spec 的正文只说"重试不得生成新的业务消息 ID"。文件传输的身份是 `transfer_id`（不是 `msg_id`），且群文件用 `gfile-{transfer_id}` 作为消息 id（`commands/files.rs`、`network/transport/group_file.rs`）—— **文件族与消息族是两套身份**，spec 未区分。
