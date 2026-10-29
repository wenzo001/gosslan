## REQ-INV-P16 — 错误必须有语义（至少五类，禁止统一 Err → failed）

> "错误至少区分：
> ```
> recoverable
> retryable
> permanent
> user_action_required
> security_related
> ```
> 禁止统一：
> ```
> Err → failed
> ```"
> — docs/protocol-invariants.md §16. Error Handling / INV-P16, line 533

**Verdict:** partial · confidence: high

**What this demands of an implementation:** 全仓的错误必须能被归到文档列出的五类语义里（可恢复 / 可重试 / 永久 / 需用户动作 / 安全相关），任何"出错"都不许被无差别地压成同一个 `failed`；错误分类必须是一个可查询、可判定的显式维度，而不是靠错误文案猜。

**Where enforcement lives:**

前后端各有一套分类机制，但**都不覆盖文档要求的五类全集**：

```ts
// src/utils/errors.ts:66-95
export type ErrorVerdict =
  | { kind: "copy"; key: string; params?: Record<string, string | number> }
  | { kind: "human"; detail: string }
  | { kind: "retry" };

export function classifyError(e: unknown): ErrorVerdict {
  if (e instanceof MessageKeyError) return { kind: "copy", key: e.message, params: e.params };
  const raw = rawErrorMessage(e);
  if (!raw) return { kind: "retry" };
  for (const r of RULES) {
    if (r.re.test(raw)) return { kind: "copy", key: r.key };
  }
  if (looksUserFacing(raw)) return { kind: "human", detail: raw };
  return { kind: "retry" };
}
```

前端这一层是**文案形态分类**（copy / human / retry），不是文档说的**语义分类**。三条 `RULES`（`src/utils/errors.ts:27-43`）只覆盖公钥缺失 / 端口占用 / OS 错误三种**文案模式**，靠正则匹配错误串。

后端真正的语义分类在文件传输域：

```rust
// src-tauri/src/network/file.rs:412-424
pub(crate) enum RetryVerdict {
    GiveUp(String),
    Retry { backoff_ms: i64 },
    Cancelled,
}

// src-tauri/src/commands/group_file_dispatch.rs:42-51
pub(crate) enum GroupFileSendErr {
    Unrecoverable(String),
    Retryable(String),
    Cancelled,
}

// src-tauri/src/content/model.rs:97-125
pub enum FailReason {
    LinkDown, Timeout, Partial, HashMismatch, SourceGone, Unsupported, Local, Cancelled,
}
impl FailReason {
    pub fn retryable(self) -> bool {
        matches!(self, FailReason::LinkDown | FailReason::Timeout | FailReason::Partial | FailReason::Local)
    }
}
```

- What it checks, and against what：`FailReason::retryable()`（`content/model.rs:122-127`）把 `LinkDown/Timeout/Partial/Local` 判成可重试、`HashMismatch/SourceGone/Unsupported/Cancelled` 判成不可重试；`RetryVerdict`（`network/file.rs:442-455`）把 `cancelled` 排在 `retryable` 之前单独短路，落 `Cancelled` 而不是 `GiveUp`（后者落 `failed`）。这一层**确实**区分了「可重试 / 永久 / 用户取消」三档。
- Which paths reach it, and which do not：`RetryVerdict` 只被 `network/file.rs` 的单聊文件投递路径使用（`commands/files.rs:579/589/598`）；`GroupFileSendErr` 只被群文件投递路径使用（`commands/group_file_dispatch.rs:56`）；`FailReason` 只被内容寻址（content store）路径使用。**协议层的其它错误（握手验签失败、Hello 重放、未知帧、群密钥分发失败、离线队列判死）没有一个进入这套分类**。

**Paths walked:**
- `commands/files.rs::flush_pending_files` → `file::send_retry_verdict` → `RetryVerdict::{Retry, GiveUp, Cancelled}`：三档分开 ✓
- `commands/group_file_dispatch.rs::dispatch_group_file_to_peer` → `group_file_status_after_fail` → `{failed, pending, cancelled}`：三档分开 ✓
- `network/transport/handshake.rs::verify_hello` → `Err(String)`（`:66/:74/:81/:91`）：**裸字符串**，不区分「重放」（可重试/不该重试）与「签名不符」（安全相关）— `verify_hello` 的四个 Err 出口全部是 `format!` 出来的自由文本，落到调用方后不再被分类 ✗
- `network/transport/outbound.rs::decode_frame` → `Err(serde_json::Error)`（`:89`）：已知 type 但字段畸形 ⇒ 一律 `Err`，与"未知 type ⇒ `Message::Unknown`"并列，但**这个 Err 不带任何语义标记**（是协议 bug？是对端恶意？）✗
- `network/transport/dial.rs:556` 握手验签失败 → `DialOutcome::Failed(reason)`（`:558`）：安全相关事件被降级成"这次拨号失败"这一个形状 ✗
- `network/transport/gossip.rs:1171` `db::observe_clock(&dbc, &conv_id, seq).ok()`：写库错误被 `.ok()` 丢弃 ⇒ 分类信息连留痕都没有 ✗

**Searched:**
- `recoverable` → 0 hits（`src/`、`src-tauri/src/` 全仓）。最接近的是 `GroupFileSendErr::Unrecoverable`（`commands/group_file_dispatch.rs:44`），词形不同且只在群文件投递域。
- `user_action_required` → 0 hits（全仓）。文档要求的这一档**在代码里完全没有对应物**。
- `security_related` → 0 hits（全仓）。同上。
- `ErrorVerdict` → 1 hit：`src/utils/errors.ts:66`（类型定义本身）。`classifyError` 的调用点只有 `src/composables/useErrorText.ts:25` 一处。
- `classifyError` → 3 hits：`errors.ts:86`（定义）、`useErrorText.ts:25`（唯一消费者）、`errors.test.ts`（测试）。
- `permanent` → 命中全部落在 `SendFileError::permanent`（`network/file/send.rs:39/41/69/127/441/454/506` 等），即单聊文件发送的错误构造器；其它域无此概念。
- `retryable` → 命中 `content/model.rs`、`content/policy.rs`、`network/file.rs`、`network/file/send.rs`、`db/file_transfer.rs`、`commands/group_file_dispatch.rs`、`commands/files.rs`、`network/transport/outbox_tests.rs` 等 —— 全部属文件/内容传输族。
- `enum .*Err|Error` → 全仓无任何**统一**的错误类型：`InitError`（`db.rs:50`）、`StartupError`（`state.rs:1499`）是启动期专用；`WriteError`（`network/transport/outbound.rs:22`）只有 `Local` / `Socket` 两档。
- `Err(.*failed` / `=> failed` / `"failed"` → 在生产码里没有"所有错误压成 failed"的**统一**归约点（`"failed"` 出现在 `db/file_transfer.rs:86/109`、`content/model.rs` 的 `FailReason` 码表等处，都是有意的状态落库，不是错误归约）。这一条禁令在**文件台账**域成立，在**协议错误**域不存在归约点（因为根本没有统一错误类型）。
- `AppError` / `ErrorKind` / `ErrorCode` / `error_code` → 0 hits。

**Hook verification:**
- `src/utils/errors.test.ts` — **存在且注册**。`src/utils/errors.test.ts:19-111` 共 9 条用例 + 1 条跨语言词典用例；`package.json:22` 的 `npm test` 用 glob `src/**/*.test.ts` 覆盖它。实测该文件被 `check-invariant-hooks.mjs` 解析成功（脚本输出 `✓ 不变量钩子：36 条全部绑定`）。
  - 但它判的是**文案形态分类**（copy/human/retry）与词典键齐全，**不判语义五分类**。
- `guards:用户取消不得记成失败` — **存在且注册**。`scripts/guard_cases/file_transfer.py:445`，注入 `FileJobEnd::Cancelled` → `FileJobEnd::Expired`，跑 `cargo test --lib a_user_cancel_is_not_recorded_as_a_failure`。实测该用例名在 `scripts/guard_cases/file_transfer.py` 中存在（`grep` 命中 1 次）。

**How the verdict was reached:** 不是 `implemented`，因为文档点名的五档里 `recoverable` / `user_action_required` / `security_related` 三档在代码里 0 命中 —— 类别本身不存在，不是"实现了但叫别的名字"：安全相关的 `verify_hello` 失败被降成自由文本，`user_action_required`（例如"公钥未到，需要用户等对端上线"这一类）在前端被 `errors.rule.pubkey` 折叠成一句文案提示、在后端 `SendFileError::permanent` 里被当成**永久失败**（`network/file/send.rs:127`）—— 后者与文档的语义正好相反（那一条其实可恢复）。不是 `absent`，因为文档明确点名的第二条禁令「禁止统一 Err → failed」在**文件台账域**有真实且经变异用例钉住的强制（`upsert_transfer` 的 `done` 闸门、`finalize_file_failure` 的 `FileJobEnd` 三态、`RetryVerdict` 的 `Cancelled` 短路），而「错误要有语义」这个大方向也在文件/内容传输族成立（`FailReason` 九档 + `retryable()`）。定为 `partial`：三个族（文件投递、内容寻址、群文件投递）各有一套真分类，协议族与通用路径没有，而文档要的是一个**全仓**统一的语义维度。

**Open questions:**
- 文档点名的五档到底要求"每一类都必须有判据钉住"，还是"错误只要不压成 failed 就算有语义"？前者需要一份跨域的错误分类表（现在没有），后者则本条应当是 `implemented`。这一读法决定了 `partial` 与 `implemented` 的边界。
- `SendFileError::permanent("无法获取对方公钥，无法加密文件")`（`network/file/send.rs:127`）在文档语义下应是 `user_action_required` 或 `recoverable`（公钥会到），今天被当成永久错误 ⇒ 这一单直接落 `failed`。这是"分类错了"还是"当时就接受了这个错"？
- 审计报告 `docs/archive/audit/evidence-2026-10-16/reliability-silence.md:53` 已把"接收侧落库吞错没有留痕门"列为空白。补齐那 223 格需要一份错误语义登记，本条不变量是否已被默认为那件事的载体？
