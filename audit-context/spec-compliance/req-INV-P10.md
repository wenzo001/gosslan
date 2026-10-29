## REQ-INV-P10 — Ciphertext Must Not Become Plaintext Silently

> "如果：
>
> ```text
> ciphertext
> +
> missing key
> ```
>
> 必须：
>
> ```text
> observable failure
> ```
>
> 不得：
>
> ```text
> decrypt failed
> → show plaintext
> ```
>
> 也不得：
>
> ```text
> decrypt failed
> → silently drop
> ```"
> — docs/protocol-invariants.md §INV-P10, line 316-342

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 三条：(a) 解不开必须是**可观测的失败**（不是无声无息）；(b) 绝不能把密文当明文显示；(c) 绝不能静默丢弃（要有留痕）。注意 spec 没有禁止"不落库"——"不落库 + 不 Ack + 留痕"是合规形态。

**Where enforcement lives:**

1) **解封函数返回 `None` 而非降级内容**：

```rust
// src-tauri/src/network/transport/e2ee_payload.rs:39-L53
fn open_direct_content(my_x25519_secret: &StaticSecret, sender_pubkey: Option<&str>, wire: &str, kind: String) -> Option<(String, String)> {
    let b64 = wire.strip_prefix("enc1:")?;      // ← 没有 enc1: 前缀 ⇒ None
    let pubkey = sender_pubkey?;                  // ← 缺公钥 ⇒ None
    let shared = crypto::shared_secret(my_x25519_secret, pubkey)?;
    let bytes = STANDARD.decode(b64).ok()?;       // ← 坏 base64 ⇒ None
    let plain = crypto::open(&shared, &bytes)?;   // ← AEAD 校验失败 ⇒ None
    Some((String::from_utf8(plain).ok()?, kind))
}
```
⇒ 缺 key / 密文被篡改 / 明文载荷 / 坏 base64 **一律** `None`。**没有任何一条路径返回"原文"或占位文本** ⇒ (b) 成立。

2) **(a)+(c)：解不开 ⇒ 留痕 + 不落库 + 不 Ack**：

```rust
// src-tauri/src/network/transport/handle_messaging.rs:104-L118
let Some((content, kind_str)) = open_direct_content(&state.identity.x25519_secret, sender_x25519_pubkey(state, &from).as_deref(), &content, kind) else {
    // 解不开 = 缺对端 X25519 或内容被改。**不落库、不 Ack**（由 outbox 续发）
    // 是对的，但这臂必须留痕：否则"对方说发了、我这边什么都没有"查不出原因
    // （2026-10-27 审计 C-5：Gossip 那半有留痕，直连这半是静默 return）。
    if log_throttled("direct_open_failed", 5_000) {
        state.logger.warn("chat", format!("code=DIRECT_OPEN_FAILED peer={from} len={}", content.len()));
    }
    return;
};
```
⇒ 有可检索的日志码 `code=DIRECT_OPEN_FAILED` ⇒ **可观测**（不是静默 drop）。

3) **Gossip 侧同一纪律，且留痕更细**：

```rust
// src-tauri/src/network/transport/gossip.rs:754-L776
// ⚠️ 可观测性缺口（用户 2026-10-13：「刚加了好友，两端能看到互相在线，但我发的单聊他收不到」）。
// ... 这一条就是那道分界；只报布尔量，不报密钥本身（日志会进报告产物）。
if env.kind == GossipKind::Chat && env.encrypted && plaintext.is_none() {
    let (has_local_key, local_matches_envelope) = { ... };
    state.logger.warn("chat", format!("单聊信封解不开（本机为接收方）msg={} peer={} 本机存有对方密钥={} 与信封自报一致={}", ...));
}
```
⇒ 报告"本机有没有对方密钥""信封自报的公钥与本机存的是否一致" ⇒ 足以区分"缺公钥"与"公钥不符"。

4) **群信封解不开**：同样 `plaintext = None` ⇒ `if let Some(pt)` 整块跳过 ⇒ 不落库、不通知、不回 Ack（`gossip.rs:777` 起的块被跳过）；同时 `gossip.rs:405-L411` 调 `allow_message_retry(state, &env.message_id, "no_plaintext")` **撤销去重登记** ⇒ 补发能重入（否则"第一次没消费成功就等于之后每一份补发都被判 Duplicate，这条消息永远进不来"，`gossip.rs:102-L108`）。

5) **文件族：解密失败 ⇒ 判死接收器 + 回否定确认**：

```rust
// src-tauri/src/network/file/receive.rs:1017-L1018
let plaintext = crypto::open_symmetric(&r.file_key, data)
    .ok_or_else(|| "文件分片解密失败".to_string())?;
```
```rust
// src-tauri/src/network/transport/handle_file.rs:416-L443
Err(e) => {
    // true = 本次真的中止了一个在途接收器 ...
    // **必须回否定确认**：旧行为是"判死但谁也不告诉"，
    // 发送端于是把剩下的整份文件继续灌进一条已经死掉的传输 ...
    if file::fail_receive(state, &transfer_id, peer_id, &e) {
        if let Err(se) = try_send(state, peer_id, &Message::FileCompleteAck { transfer_id: transfer_id.clone(), success: false }).await { ... }
    }
}
```
⇒ 文件分片解密失败**既可观测（对端收到否定确认 + 本机记日志）又不静默**。

6) **"绝不落占位文本"的反面对照**：仓库里有一条**故意**展示这个坑的测试：
```rust
// src-tauri/src/db/favorites_tests.rs:714-L724
/// P0-2 根因（反面用例，锁定必须避免的写法）：真实 msg_id 一旦被「解密失败的占位系统消息」占用，
/// 之后同一 msg_id 的正确副本会被 INSERT OR IGNORE 静默吞掉，明文永久不可恢复。
#[test]
fn placeholder_on_real_msg_id_swallows_the_good_copy() { ... }
```
生产代码里**没有**这条路径（`open_direct_content` 只返 `Option`）。

7) **发送方本地行存明文是有意的，且可按 (msg_id, sender_id) 取回**：
```rust
// src-tauri/src/db/favorites_tests.rs:751-L778
/// 补发前重封依赖的事实前提：发送方本地行存的是**明文**，且能按 (msg_id, sender_id)
/// 精确取回，不会被同一 msg_id 下别的 sender_id 记录串味。
```
`reseal_for_send`（`e2ee_payload.rs:95-L106`）按 `WHERE msg_id = ?1 AND sender_id = ?2` 取明文重封 —— **接收方那一侧不存在这条取法**（接收方行也是明文，但只按 `sender_id` 取才取到自己的）。

**Paths walked:**
- Direct 入站、缺对端 X25519 公钥 → `sender_x25519_pubkey` 返 None → `open_direct_content` 的 `sender_pubkey?` 返 None → `handle_messaging.rs:117` return ⇒ 不落库、不 Ack、**留 `code=DIRECT_OPEN_FAILED` 日志** ✓
- Direct 入站、密文被篡改（AEAD tag 破坏）→ `crypto::open` 返 None ⇒ 同上 ✓
- Direct 入站、**明文载荷**（无 `enc1:`）→ `strip_prefix` 返 None ⇒ 同上 ✓
- Direct 入站、坏 base64 → `STANDARD.decode(...).ok()?` 返 None ⇒ 同上 ✓
- Direct 入站、密文解开但**不是合法 UTF-8** → `String::from_utf8(plain).ok()?` 返 None ⇒ 同上 ✓
- Gossip 入站、缺 X25519 ⇒ `crypto::shared_secret` 返 None ⇒ `plaintext` 为 None ⇒ 留 `单聊信封解不开` warn + `allow_message_retry("no_plaintext")` ⇒ 不落库、不 Ack ✓
- Gossip 入站、缺群密钥 ⇒ `get_group_key` 返 None ⇒ 同上 ✓
- Gossip 入站、密文被篡改 ⇒ `crypto::open` 返 None ⇒ 同上 ✓
- 群信封解不开 + 后续补发 ⇒ `allow_message_retry` 让同一 `message_id` 再进来一次（`gossip_engine.rs:146-L163` 的 `allow_retry` LRU）⇒ 补发能重入 ✓
- 文件分片密文被篡改 ⇒ `write_chunk` 返 `Err("文件分片解密失败")` ⇒ `fail_receive` 判死接收器 + 回 `FileCompleteAck{success:false}` ⇒ 发送端立刻知道 ✓
- 本机自发的那条消息 → `sender_id == state.device_id` ⇒ 只影响"补发时取明文"这一步（`e2ee_payload.rs:98-L104` 的 `AND sender_id = ?2`）⇒ 不会把对端会话的明文串进来 ✓

**Searched:**
- `open_direct_content(` → 生产 1 处调用（`handle_messaging.rs:99`）+ 定义（`e2ee_payload.rs:39`）
- `crypto::open(` → 命中 `e2ee_payload.rs:49`、`gossip.rs:346`、`:375`、`file/receive.rs:1017`
- `unwrap_or` / `unwrap_or_default()` 在解密结果上 → **0 hits**（没有"解不开就用原文"的兜底）
- `[加密消息]` / `解密失败` 占位文本 → **0 hits** 在生产代码（只出现在 `db/favorites_tests.rs:717` 的**反面用例**里）
- `"enc1:"` → 命中 `e2ee_payload.rs:45`（`strip_prefix`）、`:64`（`reseal_chat_content` 造）、`commands/chat.rs:735`/`:939`（造）、`e2ee_payload.rs:84`（`content.starts_with("enc1:")` 判"这是密文"）
- `DIRECT_OPEN_FAILED` → 1 hit：`handle_messaging.rs:112`
- `单聊信封解不开` → 1 hit：`gossip.rs:769`
- `allow_message_retry` → 3 hits：`gossip.rs:109`（定义）、`:410`（no_plaintext）、`:1197`（insert_failed）
- `文件分片解密失败` → 1 hit：`network/file/receive.rs:1018`

**Hook verification:**
- `network::transport::tests::plaintext_payload_is_rejected` → `src-tauri/src/network/transport/e2ee_tests.rs:167`；断言 `open_direct_content(..., "plain old text", ...)` 返 `None`；两平台基线在册 ✓
- `network::file::tests::tampered_chunk_fails_to_decrypt` → `src-tauri/src/network/file_tests.rs:486`；翻转密文最后一比特 ⇒ `crypto::open_symmetric` 返 `None`；两平台基线在册 ✓
- `db::tests::own_sent_row_keeps_plaintext_selectable_by_sender` → `src-tauri/src/db/favorites_tests.rs:755`；断言"自己发的那行能按 (msg_id, sender_id) 取到明文、别人的行取不到"；两平台基线在册 ✓
- 支撑（spec 未点名但在册）：`network::transport::tests::direct_open_rejects_corrupt_and_tampered_payloads`（`e2ee_tests.rs:133`，坏 base64 / 空载荷 / 篡改 AEAD tag 三种都判 `None`，且"失败只影响这一次投递"不污染同一条完好密文）、`network::transport::tests::direct_open_fails_without_sender_key_and_recovers_when_key_arrives`（`e2ee_tests.rs:38`）、`network::transport::tests::direct_open_recovers_once_sender_pubkey_cache_refreshed`（`:60`）、`db::tests::failed_decrypt_leaves_msg_id_free_for_the_later_good_copy`（`db/favorites_tests.rs:729`）、`db::tests::placeholder_on_real_msg_id_swallows_the_good_copy`（`:715`，反面用例）

**How the verdict was reached:** spec 的三条禁令逐条对照：(b) "不得 decrypt failed → show plaintext" —— `open_direct_content` 只返 `Option<(String,String)>`，无任何兜底文本，全仓 0 处占位字符串；(a)+(c) "不得 decrypt failed → silently drop" —— 直连侧有 `code=DIRECT_OPEN_FAILED`（`handle_messaging.rs:108-L116`）、Gossip 侧有"单聊信封解不开"（`gossip.rs:769-L776`）、文件侧有否定确认回执（`handle_file.rs:422-L431`）三处留痕。三条禁令都成立，所以判 `implemented` 而不是 `partial`。

**Open questions:**
- **"observable failure" 的强度需要界定**：代码里的"可观测"是**日志**（`code=DIRECT_OPEN_FAILED`，带 5s 节流 `log_throttled("direct_open_failed", 5_000)`），**不是**用户可见的 UI 提示。接收方用户在界面上看到的是"对方说发了、我这边什么都没有"，只有打开日志才看得到原因。spec 用 "observable failure" 一词但未定义可见性层级。**需要确认 spec 要求的是日志级可观测还是用户级可观测。**
- **日志节流 5s**（`handle_messaging.rs:108`）⇒ 同一对端在 5s 内连续多条解不开，只留一行。事件级的"每条失败都留痕"不成立。
- **Gossip 侧留痕有，但直连侧留痕是 2026-10-27 审计 C-5 补上的**（`handle_messaging.rs:105-L107` 的注释自陈"此前这半是静默 return"）⇒ spec 的这条要求在 2026-10-27 之前**曾经不成立**。今天成立。
- **`own_sent_row_keeps_plaintext_selectable_by_sender` 断言的是"发送方本地行存明文"** —— 这与"密文不得变成明文"表面上相反（明文进了 SQLite）。这是**发送侧**的设计（补发重封需要明文，`e2ee_payload.rs:69-L71` 注释自陈），且有专门的取证约束（`AI_RULES` 提到私钥与消息以 0600 保护）。spec 的 INV-P10 只讲**接收侧**的解密失败语义。**需要确认 spec 是否也要约束发送侧的存储形态（明文落盘）。**
- 文件族（`file_receivers` / `file_transfers`）与内容寻址族（`content_transfers`）的"解密失败 ⇒ 可观测"分别由 `handle_file.rs:416-L443` 与 `network/transport/outbox_sweep.rs:745-L777`（`finish_reconcile`）覆盖，但 spec 的 INV-P10 只给了三条钩子，未描述文件族的这条路径。
