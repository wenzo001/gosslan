## REQ-INV-P13 — Protocol Evolution Must Be Explicit

> "协议发生不兼容变化时必须：
>
> ```text
> version bump
> +
> compatibility decision
> +
> ADR
> ```
>
> 禁止：
>
> ```text
> 旧客户端收到新消息
> → panic
> → crash
> → silently corrupt state
> ```
>
> 未知扩展应在协议允许的情况下安全忽略。"
> — docs/protocol-invariants.md §INV-P13, line 455-474
>
> 附带 spec 自述（line 477-L481）：
> "- 当前实例（2026-10-24，PERF-02）：`ShareTreeResponse` 增加 `truncated: bool` 并标 `#[serde(default)]` ⇒ 旧端缺字段按 `false` 解（判据 `share_tree_response_without_truncated_is_legacy_false`）。同一轮把命令返回形状从裸数组改成 `{ entries, truncated }`，那是**命令契约**而非线上协议：前端 `parseIpcValue(shareTreeSchema, …)` 对旧形状直接报错，不允许静默读到 `undefined`。"

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** (a) 不兼容变化必须走"版本号 + 兼容性决定 + ADR"三件套；(b) 旧客户端收到新消息**不许** panic / crash / 静默损坏状态；(c) 未知扩展应当**安全忽略**（不是断链、不是丢状态）。

**Where enforcement lives:**

1) **未知帧安全降级（不 panic / 不断链）**：

```rust
// src-tauri/src/network/transport/outbound.rs:78-L91
pub(crate) fn decode_frame(buf: &[u8]) -> Result<Message, serde_json::Error> {
    match serde_json::from_slice::<Message>(buf) {
        Ok(msg) => Ok(msg),
        Err(e) if e.to_string().starts_with("unknown variant") => {
            let tag = serde_json::from_slice::<FrameTag>(buf).map(|t| t.tag).unwrap_or_else(|_| "<no-type>".to_string());
            Ok(Message::Unknown { wire_type: tag })
        }
        Err(e) => Err(e),
    }
}
```
`read_frame`（`:93-L97`）走 `decode_frame` ⇒ 未知变体变成 `Message::Unknown` 而不是 `io::Error`（`io::Error` 会让 reader 退出 ⇒ 拆链 ⇒ 重连再失败）。

2) **Unknown 分支只忽略这一条 + 节流日志，不拆链**：

```rust
// src-tauri/src/network/transport.rs:1113-L1142
Message::Unknown { wire_type } => {
    if log_throttled("unknown_frame", 10_000) {
        let declared = state.peer_versions.lock()...get(peer_id).map(...).unwrap_or_else(|| "未声明".into());
        state.logger.warn("proto", format!("忽略未知帧类型 type={wire_type} peer={peer_id}：对端声明（{declared}），本机协议={} —— 本机版本低于对端，升级后即可识别；链路保持", crate::protocol::PROTOCOL_VERSION));
    }
}
```
⇒ 链路保持、无状态变更、无 panic。

3) **握手首帧刻意不降级**（安全边界）：
```rust
// src-tauri/src/network/transport/outbound.rs:99-L108
/// ⚠️ 这里**刻意不做**未知帧降级：首帧必须是 Hello，一条对端无法解析的帧在认证之前
/// 不构成"可以继续聊"的理由 —— 降级是给已建链后的数据面用的，不是给握手用的。
async fn read_frame_preauth<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Message> {
    let buf = crate::transport::tcp::read_bytes_capped(r, crate::protocol::MAX_PREAUTH_FRAME).await?;
    serde_json::from_slice(&buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}
```
⇒ 认证前无法解析的帧 ⇒ 拒连接（不是"继续聊"）⇒ 不构成"旧客户端 crash"，只是"连不上"，符合 spec 的禁止清单（panic / crash / 静默损坏状态）。

4) **能力位门控（不门控不许发）**：`protocol.rs:89-L155` 定义了一组 `CONTENT_FEATURE_*` 位（`PULL` / `MERGE` / `FILE_EPOCH` / `FLEX_DM_KIND` / `GROUP_HISTORY` / `GROUP_FILE_RESUME` / `NUDGE`），发送侧按对端声明的位决定**发不发**新语义帧。`protocol.rs:99-L100` 的注释自陈："`merge` 是在 V1 期间才加进 `MsgKind` 的，而 v4.8.2 / v4.18.10 / v4.20.0 这些**已发布**的包里根本没有这个变体……发送方 outbox 反复重投、最后显示'发送失败'" ⇒ 这条是"兼容性决定"的落地。

5) **版本号与"唯一兼容判定处"**：

```rust
// src-tauri/src/protocol.rs:60-L87
/// 本机**线格式**版本（ADR-0007 决策 1）。
/// 只在**破坏兼容**的协议变更时 +1；加可选字段、加新帧类型都**不** bump
/// 今天所有已发布版本（v4.8.2 起）都是 1。
pub const PROTOCOL_VERSION: u32 = 1;
...
/// 全仓唯一的兼容判定处
pub fn peer_protocol_is_newer(declared: Option<u32>) -> bool { declared.is_some_and(|v| v > PROTOCOL_VERSION) }
```
⇒ "不把 app version 当 protocol version"（`protocol.rs:67-L71`）。

6) **ADR 存在**：`docs/adr/0007-protocol-versioning.md`（协议版本化）—— spec 要求的第三件套。目录里另有 16 篇 ADR（0008-L0023）。

7) **spec 自述的 PERF-02 实例在代码里**：

```rust
// src-tauri/src/protocol.rs:2062-L2067
/// 共享方是否因为条数上限只回了前 N 条（审计 PERF-02）。
/// `#[serde(default)]`：旧版本没有这个字段，默认 false（旧端确实没截断能力）。
#[serde(default)]
truncated: bool,
```
判据 `share_tree_response_without_truncated_is_legacy_false` 在 `src-tauri/src/protocol_tests.rs:587`。

8) **"不静默损坏状态"**：未知帧走 `Message::Unknown` 臂，**不触碰任何表**（`handle_message` 的 Unknown 臂只有一条日志）。

**Paths walked:**
- 新版本发出一种老版本不认识的帧 → 老端 TCP 读循环 `read_frame` → `decode_frame` → `Message::Unknown` → `handle_message` 的 Unknown 臂 ⇒ **忽略这一条、链路保持、无 panic、无状态变更** ✓
- 同一条未知帧重复到达 → 每次都进 Unknown 臂 → 日志被 `log_throttled("unknown_frame", 10_000)` 节流 ✓（不会刷爆日志）
- 新版本的 `ChatMessage.kind` 是老端不认识的字符串 → `ChatMessage.kind` 是 `String`（不是枚举）⇒ 老端**能**解析 ⇒ `open_direct_content` 的 `kind` 原样透传（`e2ee_payload.rs:50-L52`）⇒ 落库为真值 ⇒ 前端显示"不支持的消息类型"而不是丢帧 ✓
- 新版本发出老端不认识的**枚举**变体（如 `MsgKind` 在 1:1 是枚举、在群是自由字符串）→ `dm_required_features` / `dm_allowed_by_features` 在**发送侧**挡住（`commands/chat.rs:679-L689`）⇒ 不发 ⇒ 老端不会解析失败 ✓
- 老端（无该能力位）收到新帧 ⇒ 由能力位门控保证不会发生 ✓
- 认证前的未知帧 → `read_frame_preauth` 返 Err ⇒ **拒连接**（不是继续聊）✓ —— spec 的禁止清单不含"连不上"，且这是安全边界上的正确取舍（`outbound.rs:99-L102` 注释）
- **BLE 路径与 TCP 不同**：`network/ble/io_loops.rs:200` 直接 `serde_json::from_slice::<Message>(&bytes)`，**不走 `decode_frame`** ⇒ 未知变体 ⇒ `Err` ⇒ 记一条 warn 后**继续读下一帧**（`:227-L230`）⇒ **不拆链、不 panic、不丢状态**（与 TCP 的差别是"不产生 `Message::Unknown`、不记版本对比日志"）。行为上仍满足 spec 的三条禁止。
- `ShareTreeResponse` 老端缺 `truncated` 字段 → `#[serde(default)]` ⇒ 按 `false` 解 ✓（spec 自述的实例）
- 命令契约（IPC）形状变化 → 前端 `parseIpcValue(shareTreeSchema, …)` 对旧形状**直接报错**，不静默读 `undefined` ✓（spec 自述，代码在 `src/` 一带）

**Searched:**
- `Message::Unknown` → 命中：`protocol.rs`（枚举定义）、`outbound.rs:87`（构造）、`transport.rs:1113`（处理臂）、`lib_delivery_shape_tests.rs:44`（断言臂存在）
- `decode_frame` → 4 hits：`outbound.rs:78`（定义）、`:96`（`read_frame` 调用）、`lib_delivery_shape_tests.rs:31`、`:39`（断言 preauth **不**含它）
- `read_frame_preauth` → `outbound.rs:103`（定义）+ 1 处调用
- `unknown variant` → 1 hit：`outbound.rs:81`
- `PROTOCOL_VERSION` → 命中 `protocol.rs:65`（定义）、`:86`（比较）、`:1138`（日志）、`protocol.rs:1832`（Hello 里的声明字段）
- `peer_protocol_is_newer` → `protocol.rs:85`（定义）+ 命令层调用点
- `CONTENT_FEATURE_` → 10 个常量（`protocol.rs:91-L155`）+ 门控调用点（`commands/chat.rs:679-L689`、`network/file/send.rs` 的 `CONTENT_FEATURE_FILE_EPOCH` 闸）
- `panic!` / `unwrap()` 在帧解析路径上 → `decode_frame` 内 0 hits（只返回 Result）
- `serde_json::from_slice::<Message>` → 2 hits：`outbound.rs:79`（decode_frame 内）、`ble/io_loops.rs:200`（BLE 路径，不降级）
- `docs/adr/0007-protocol-versioning.md` → 存在 ✓

**Hook verification:**
- `tests::unknown_wire_frame_is_tolerated_after_auth` → `src-tauri/src/lib_delivery_shape_tests.rs:20`；两平台基线在册 ✓（断言 `decode_frame` 存在、`Ok(Message::Unknown{wire_type:tag})` 存在、`read_frame` 走 `decode_frame`、`read_frame_preauth` **不含** `decode_frame`、transport 全集视图里有 `Message::Unknown{wire_type}=>{` 臂）
- `discovery::routed::tests::device_id_is_optional_and_backward_compatible` → `src-tauri/src/discovery/routed.rs:182`；两平台基线在册 ✓（旧格式带 `device_id`、新格式只填地址，两种都能解析、往返一致）
- `db::migration_tests::migration_fresh_db_gets_latest_version` → `src-tauri/src/db/migration_tests.rs:61`；两平台基线在册 ✓
- spec 自述的 PERF-02 判据 `share_tree_response_without_truncated_is_legacy_false` → `src-tauri/src/protocol_tests.rs:587`；两平台基线在册（需按名字核对，见下）—— **它不在 spec 的钩子行里**，是 spec 的"当前实例"段提到的判据
- 支撑（spec 未点名但在册）：`protocol_tests::envelope_sign_verify_and_tamper_detection`（`gossip_engine.rs:284`）、`gossip_engine::tests::group_envelope_message_id_stable_after_resign`（`gossip_engine.rs:368`）、`network::transport::tests::forwarded_ttl_is_clamped_by_the_mesh_router`（`gossip_tests.rs:575`）

**How the verdict was reached:** spec 的三条禁止（panic / crash / 静默损坏状态）都有确定的排除机制：`decode_frame` 的降级（`outbound.rs:78-L91`）+ Unknown 臂只记日志（`transport.rs:1113-L1142`）+ 能力位门控（`protocol.rs:89-L155`）。"未知扩展安全忽略"在 TCP 路径上是显式降级、在 BLE 路径上是"丢这一帧继续读"（都不拆链、不改状态）。三件套（version bump / compatibility decision / ADR）：`PROTOCOL_VERSION`（`protocol.rs:65`）+ 能力位门控（兼容性决定）+ `docs/adr/0007-protocol-versioning.md`（ADR）三者齐备。所以判 `implemented`。

**Open questions:**
- **BLE 路径没有未知帧降级**：`network/ble/io_loops.rs:200` 直读 `serde_json::from_slice::<Message>` ⇒ 未知变体不是 `Message::Unknown` 而是 `Err` ⇒ 只记 `丢弃无法解析的 BLE 帧` 的 warn。行为上满足 spec 的三条禁止（不拆链、不改状态、无 panic），但**丢掉的是"对端声明的版本"这类诊断信息**，且与 TCP 路径行为不一致。**需要确认 BLE 路径是否也应走 `decode_frame`。**
- **"version bump" 在实践中从未发生**：`PROTOCOL_VERSION` 自 v4.8.2 起一直是 1（`protocol.rs:64`），所有新语义都靠能力位门控而不是 bump。spec 的三件套描述的是"不兼容变化"时的流程，而本仓的策略是"**从不产生不兼容变化**"（所有新增都做成可选字段 + 能力位门控）。⇒ spec 的第一件（version bump）在实践中是空转的。**需要确认 spec 想描述的是"发生了 bump 的流程"还是"任何协议变化都要 bump"。**
- **spec 的钩子清单里没有它自己提到的 PERF-02 判据**：`share_tree_response_without_truncated_is_legacy_false` 只在 spec 的"当前实例"段被提及，不在 `- 钩子：` 行里。`check-invariant-hooks.mjs` 只解析 `- 钩子：` 行 ⇒ 该判据不受"每条不变量都有钩子"的门禁保护。**需要确认这是否是有意的。**
- **`discovery::routed::tests::device_id_is_optional_and_backward_compatible` 判的是「路由端点配置的 JSON 格式向后兼容」**（`discovery/routed.rs:182`），与"协议版本演进"是**配置格式**层面而不是**线协议**层面。spec 把它挂在 INV-P13 下属于间接关联。**需要确认 spec 的意图。**
