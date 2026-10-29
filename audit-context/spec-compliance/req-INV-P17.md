## REQ-INV-P17 — 文件分片必须可识别/排序/去重/校验/重组

> "文件分片必须能够：
> ```
> identify
> order
> dedupe
> validate
> reassemble
> ```
> 不能仅依赖：
> ```
> arrival order
> ```
> **续推论（2026-09-22 跨网真机：160MB 永远停在 0%）**：`order` 这条对**续传**同样成立，而且它有两个方向，只做一半必然错 ——
> 1. **接收端是"我有什么"的唯一权威，每一次 `FileOffer` 都必须把真实位置答出去。**
>    ...判据只许一份：`file::decide_offer`（`has_active` 时用内存 `received`，否则用 `.part` 长度）。
> 2. **段号必须与发送端的"按段从 `seq = 0` 重编"对齐，但只在续传段归零。**
> 3. **但"我有什么"这个数有上限：`.part` 长度 ≥ size 不算进度**（2026-09-26 A-12）。"
> — docs/protocol-invariants.md §17. File Transfer / INV-P17, line 557

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 分片协议必须自带身份、顺序、去重、完整性校验与重组能力，不得把"到达顺序"当作协议顺序；并且这个能力必须覆盖**续传**：接收端对"我有什么"的回答必须唯一且真实，段号重编必须与发送端对齐，且"字节齐但没有成品"不能被当成完成。

**Where enforcement lives:**

判据唯一地落在 `file::decide_offer`：

```rust
// src-tauri/src/network/file/receive.rs:425-452
pub fn decide_offer(
    has_active: bool, active_received: u64, disk_retained: u64,
    size: u64, from_bytes: u64, already_completed: bool,
) -> OfferDecision {
    if already_completed {
        return OfferDecision::AlreadyHave;
    }
    let held = if has_active {
        active_received
    } else if size > 0 && disk_retained >= size {
        0
    } else {
        disk_retained
    };
    if from_bytes != held {
        return OfferDecision::ResumeFrom(held);
    }
    if has_active && from_bytes > 0 {
        return OfferDecision::AcceptResumeSegment;
    }
    OfferDecision::Accept
}
```

- What it checks, and against what：`has_active` 时用内存 `received`（`receiver_progress`，`receive.rs:457-464`），否则用 `.part` 磁盘长度（`retained_part_len`）；`disk_retained >= size` 时一律按 0 处理（第三段推论）；`from_bytes != held` ⇒ `ResumeFrom(held)`（真实位置答出去）；`has_active && from_bytes > 0` ⇒ `AcceptResumeSegment`（续传段，段号归零）。
- Which paths reach it, and which do not：只有 `network/transport/handle_file.rs:103` 一个生产调用点。`src-tauri/src/lib_ble_tests.rs:220-231` 有一条形状判据钉住"位置比对不许在处理器里再写一遍"（只许 `file::decide_offer` 一份）。

顺序 / 去重 / 校验：

```rust
// src-tauri/src/network/file/receive.rs:894-901
pub(crate) fn chunk_seq_decision(seq: u32, next_seq: u32) -> ChunkSeq {
    match seq.cmp(&next_seq) {
        Ordering::Less => ChunkSeq::Duplicate,
        Ordering::Equal => ChunkSeq::Accept,
        Ordering::Greater => ChunkSeq::Gap,
    }
}

// src-tauri/src/network/file/receive.rs:910-912
pub(crate) fn chunk_exceeds_declared(size: u64, received: u64, plaintext_len: u64) -> bool {
    plaintext_len > size.saturating_sub(received)
}
```

```rust
// src-tauri/src/network/file/receive.rs:1013-1023（write_chunk 体内）
if !frame_is_current(attempt, r.attempt) { ... return Ok(r.received); }   // 轮次过滤
match chunk_seq_decision(seq, r.next_seq) {
    ChunkSeq::Duplicate => return Ok(r.received),                          // 去重
    ChunkSeq::Gap => return Err("文件分片顺序错误".to_string()),          // 真跳号才死
    ChunkSeq::Accept => {}
}
let plaintext = crypto::open_symmetric(&r.file_key, data)
    .ok_or_else(|| "文件分片解密失败".to_string())?;                        // 每片 AEAD
if chunk_exceeds_declared(r.size, r.received, plaintext.len() as u64) {   // 越过声明 size
    return Err("文件分片超出声明大小".to_string());
}
r.hasher.update(&plaintext);                                              // 增量 SHA-256
```

- `identify`：`transfer_id` + `seq` + `attempt`（轮次号）三件套。`frame_is_current`（`receive.rs:929-934`）按 attempt epoch 过滤上一轮残留片。
- `order`：`chunk_seq_decision` 比 `next_seq`，`Less ⇒ Duplicate`、`Greater ⇒ Gap`。
- `dedupe`：`Duplicate` 一律忽略（`return Ok(r.received)`），**不**整单失败。
- `validate`：三重 —— 每片 AEAD 解密、声明 size 上限、末尾文件级 SHA-256（增量 `hasher`，收尾 `finish_receive` 比对）。
- `reassemble`：`r.file.write_all(&plaintext)` 追加写（不 seek），文件级 sha256 与 size 双证（`content/model.rs` 的 `TransferStatus` 状态机、`network/file/receive.rs::finish_receive`）。

段号归零（第二段推论）：

```rust
// src-tauri/src/network/transport/handle_file.rs:165-170
if resumed {
    file::restart_segment(state, &transfer_id);
}
```

```rust
// src-tauri/src/network/file/receive.rs:473-482
pub fn restart_segment(state: &AppState, transfer_id: &str) {
    if let Some(r) = state.file_receivers.lock()...get_mut(transfer_id) {
        r.next_seq = 0;
    }
}
```

只在 `OfferDecision::AcceptResumeSegment` 分支被调 ⇒ "只在续传段归零"成立；`from_bytes = 0` 的重复 offer 走 `Accept` 分支，**不**归零 ⇒ 上一轮 attempt 还在排空的分片不被打成"跳号"。

**Paths walked:**
- `handle_file.rs:103` `decide_offer(...)` → `AlreadyHave`：回 `FileReject{received: size}`（`:118-128`）⇒ "字节齐但没有成品"被当成完成的风险被显式排除 ✓
- `handle_file.rs:103` → `ResumeFrom(held)`：回 `FileReject{received: held}`（`:130-146`）⇒ 真实位置答出去 ✓
- `handle_file.rs:103` → `AcceptResumeSegment` + `active.is_some()`：回 `FileAccept` + `restart_segment` ⇒ 段号归零 ✓（`handle_file.rs:165-170`）
- `handle_file.rs:103` → `Accept` + `active.is_some()`：**不**归零（重复 offer 幂等接受）✓ ⇒ 上一轮 attempt 的残片不会被打成跳号 ✓
- `handle_file.rs:103` → `Accept` + 无活跃接收器 + `from_bytes > 0`：`file::resume_receive` 走 `spawn_blocking`（`:198-206`），**先校验前缀再注册接收器**，成功后才回 Accept ⇒ 不满足时不会留下"半注册"状态 ✓
- `write_chunk`（`receive.rs:972`）：`frame_is_current` 过滤 → `chunk_seq_decision` → AEAD → size 上限 → 写盘 → 增量哈希 → `next_seq += 1` ⇒ 顺序/去重/校验三关都在写盘**之前** ✓
- 群侧：`network/file/group_receive.rs` 有独立的群分片路径（`GroupFileChunk`）。**该侧没有 `decide_offer` 的等价物** —— 群文件 Offer 的位置判定走 `network/file/group_resume.rs` 的另一族（`GroupOfferDecision::{AlreadyHave, Restart, Resume}`，`group_resume.rs:13/34`）。这一侧的分片顺序由 `group_chunk_seq_rule_has_exactly_one_home` 单独钉住。

**Searched:**
- `decide_offer` → 14 hits（可靠工具复验）：`network/file/receive.rs:425`（定义）、`network/transport/handle_file.rs:103`（**唯一生产调用**）、`network/file_tests.rs` 12 处用例。**生产调用点恰好 1 个** ✓
- **"位置比对不许在处理器里再写一遍"另有两条形状判据**：`src-tauri/src/lib_ble_tests.rs:224` 与 `src-tauri/src/lib_compat_gating_tests.rs:279` 都断言 `transport.contains("file::decide_offer(")` ⇒ 除那一个调用点外，处理器里**不许**再出现位置比对 ✓
- 群侧的等价物是**另一族**：`network/file/group_resume.rs:13/34` 的 `GroupOfferDecision`（`AlreadyHave` / `Restart` / `Resume(held)`），调用点 `network/transport/group_file.rs:441/579` ⇒ 群侧不经过 `decide_offer`
- `chunk_seq_decision` → `network/file/receive.rs:894`（定义）+ `receive.rs:1017`（唯一调用）+ 用例
- `restart_segment` → `receive.rs:473`（定义）+ `handle_file.rs:166`（唯一调用，且在 `resumed` 分支内）✓
- `frame_is_current` → `receive.rs:929`（定义）+ `receive.rs:999`（唯一调用）
- `retained_part_len` / `receiver_progress` → `receive.rs` 内定义，`handle_file.rs:88-89` 调用
- `is_transfer_done` → `db/file_transfer.rs`（`SELECT 1 FROM file_transfers WHERE id = ?1 AND status = 'done'`），`handle_file.rs:92` 调用，`db/file_transfer.rs` 的 `is_transfer_done` 注释明确说 `Err` 不折叠成 `false` ⇒ 判错方向不会静默
- `sha256` / `hasher` → `receive.rs` 内 `r.hasher.update(&plaintext)`（`:1024`），收尾在 `finish_receive` / `finish_group_receive_into` 比对；`finish_group_receive_into`（`network/file/group_receive.rs:297`）的注释写明"实际 SHA-256 与发送方声明不符（含发送方没声明——空期望值不通过，fail-closed）"
- `arrival order` / 依赖到达顺序 → 0 hits（协议层不依赖到达顺序；排序由 `seq` + `attempt` 决定）

**Hook verification:**
- `network::file::tests::receiver_hash_mismatch_fails` — **存在**：`src-tauri/src/network/file_tests.rs:861`。在基线 `src-tauri/test-baseline.macos.txt:724`（`network::file::tests::receiver_hash_mismatch_fails`）与 `test-baseline.windows.txt` 中均有登记 ⇒ 注册到本平台基线 ✓
- `file_relay::tests::chunks_stream_to_disk_and_completion_hands_back_a_path` — **存在**：`src-tauri/src/file_relay.rs:302`。基线命中 ✓（中继侧分片落盘与完成回传路径）
- `guards:中继收文件的哈希必须对组装后的明文算` — **存在**：`scripts/guard_cases/transport_network.py:639`，注入乱序/重复分片 ⇒ 哈希必错。实测该 name 在护栏文件里命中 1 次 ✓

三条钩子全部存在并注册到会被跑到的位置（Rust 用例进平台基线、护栏用例进 `scripts/guard_cases/`）。

**How the verdict was reached:** 文档点名的三条推论（真实位置唯一判据 `decide_offer`、段号只在续传段归零、`.part` 长度 ≥ size 按 0 处理）逐条在 `decide_offer` 的实现里对上了号，且三段推论各自对应代码里的一行显式分支（`:438-444` 的 `held` 三元、`:448-450` 的 `AcceptResumeSegment`、`:440-442` 的 `disk_retained >= size ⇒ 0`）。identify/order/dedupe/validate/reassemble 五项各有独立判据（`chunk_seq_decision` / `chunk_exceeds_declared` / 增量 hasher / AEAD / `finish_*` 的 size+sha 双证）。生产调用点唯一（`decide_offer` 只有 `handle_file.rs:103` 一处），文档担心的"两套规矩"没有复现。定为 `implemented` 而非 `partial`：三条推论逐条实现，没有一条走"只做一半"。

**Open questions:**
- 群侧（`GroupFileChunk`）的位置判定走 `network/file/group_resume.rs` 的 `GroupOfferDecision`（`group_resume.rs:13/34`），**不是** `decide_offer`。文档第一段推论写的是"`file::decide_offer` 是唯一判据"，若把群侧也读进去，则"唯一"不成立（单聊与群是两族）。文档未明确群侧是否纳入该推论。
- `decide_offer` 的 `already_completed` 输入来自 `db::is_transfer_done` 的查询失败即 `false`（`handle_file.rs:96-102`，有 warn 留痕）。台账写失败 ⇒ 按"还没收完"处理 ⇒ 最坏重传一次（不丢数据，但可能落"名字(1)"副本）。这是不是"重组"维度上仍然可接受？
