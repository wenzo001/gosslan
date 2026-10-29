## REQ-INV-P24 — 跨版本必须降级，不许炸也不许装

> "四条硬判据：
> ```
> 1. 未知帧不得成为连接错误            —— 收到不认识 type 的帧 ⇒ 忽略 + 节流记日志，
>                                         绝不 panic、绝不拆链、绝不因此丢 ACK 语义
> 2. 未知内容不得成为裸 JSON            —— 渲染层必须有兜底：识别不了的 kind/载荷
>                                         ⇒「不支持的消息类型，升级后可查看」+ 可展开原文
> 3. 新字段必须可缺省                  —— 加字段 = 老对端不发它 ⇒ 读侧必须有默认值。
>                                         把字段改成必填 = breaking，必须走 ADR-0007
> 4. 新能力必须先协商再用              —— 发送方只在对端声明支持（protocol_version /
>                                         capability）时才允许发新帧或新语义；
>                                         门控失败 ⇒ 退回旧行为，而不是"发了再说"
> ```"
> — docs/protocol-invariants.md §24. Cross-Version Graceful Degradation / INV-P24, line 883

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 四条硬判据全部成立 —— 未知帧降级为"忽略 + 记日志 + 链路保持"；未知内容有可解释的渲染兜底而不是裸 JSON；新增字段在读侧有默认值（老对端不发时仍能读）；新能力/新语义必须由对端声明能力位后才发，门控失败退回旧行为。

**Where enforcement lives:**

**第 1 条（未知帧降级）** —— 判据在解码层：

```rust
// src-tauri/src/network/transport/outbound.rs:82-92
pub(crate) fn decode_frame(buf: &[u8]) -> Result<Message, serde_json::Error> {
    match serde_json::from_slice::<Message>(buf) {
        Ok(msg) => Ok(msg),
        Err(e) if e.to_string().starts_with("unknown variant") => {
            let tag = serde_json::from_slice::<FrameTag>(buf)
                .map(|t| t.tag)
                .unwrap_or_else(|_| "<no-type>".to_string());
            Ok(Message::Unknown { wire_type: tag })
        }
        Err(e) => Err(e),
    }
}
```

`Message::Unknown` 变体（`src-tauri/src/protocol.rs:2298-2308`）。消费点：

```rust
// src-tauri/src/network/transport.rs:1110-1141
Message::Unknown { wire_type } => {
    if log_throttled("unknown_frame", 10_000) {
        // 把对端**声明**的版本一起写进日志 …
        state.logger.warn("proto", format!("忽略未知帧类型 type={wire_type} peer={peer_id}：对端声明（{declared}），本机协议={} —— 本机版本低于对端，升级后即可识别；链路保持", crate::protocol::PROTOCOL_VERSION));
    }
    ...
}
```

- What it checks, and against what：只有 serde 报 `unknown variant`（即**不认识 type**）才降级；已知 type 但字段畸形仍返回 `Err`（`:91`）⇒ 真实协议 bug 不被静默吞掉。降级后的帧落到 `Message::Unknown` 分支 ⇒ **忽略这一条 + 节流日志（10s）+ 链路保持**（该分支不 `return` 掉整个 reader 循环）。
- Which paths reach it, and which do not：`read_frame`（`outbound.rs:95-99`）是数据面的唯一解码入口；`read_frame_preauth`（`outbound.rs:104-111`）**刻意**不做降级（首帧必须是 Hello，认证前不构成"可以继续聊"的理由）。

**第 2 条（未知内容不显示裸 JSON）** —— 前端唯一判定点：

```ts
// src/utils/messageKinds.ts:84-90
export function isKnownKind(kind: string): boolean {
  return (
    SILENT_KINDS.includes(kind) ||
    CARD_KINDS.includes(kind) ||
    BUBBLE_KINDS.includes(kind)
  );
}
```

```ts
// src/components/MessageItem.vue:1969-1972
<!-- 绝不把载荷原文甩上屏（INV-P24 第 2 条）。判据只能走 isKnownKind —— -->
v-else-if="!isKnownKind(message.kind)"
  <UnsupportedKindBubble ...
```

覆盖点（`isKnownKind` 的消费点）：会话列表与通知文案（`src/utils/messages.ts:459` → `UNSUPPORTED_KIND_LABEL`）、时间线气泡（`MessageItem.vue:843/1972` → `UnsupportedKindBubble`）、虚拟列表高度估算（`src/utils/messageHeight.ts:222` → `UNSUPPORTED_BUBBLE`）、收藏面板（`src/components/FavoritePanel.vue:50`）。

**第 3 条（新字段可缺省）** —— `serde(default)` 与 `Option<T>`：群聊 `mentions` / `mention_targets` 走 `protocol.rs::mention_targets_from_value`（`:1164` 附近），缺键 ⇒ 读成"缺失"；`Message::ChatMessage.kind` 从 `MsgKind` 改回 `String`（`protocol.rs:1934` 注释记着这次改动）。

**第 4 条（新能力先协商再用）** —— 能力位机制：

```rust
// src-tauri/src/protocol.rs:197-210
pub fn content_features() -> u32 {
    CONTENT_FEATURE_PULL | CONTENT_FEATURE_MERGE | CONTENT_FEATURE_FILE_EPOCH
        | CONTENT_FEATURE_FLEX_DM_KIND | CONTENT_FEATURE_GROUP_HISTORY
        | CONTENT_FEATURE_GROUP_FILE_RESUME | CONTENT_FEATURE_NUDGE
        | CONTENT_FEATURE_RENDER | CONTENT_FEATURE_FILE_CANCEL
        | CONTENT_FEATURE_CREATOR_RECALL
}

// src-tauri/src/protocol.rs:214-219（唯一映射表）
pub fn kind_required_feature(kind: &str) -> Option<u32> {
    match kind { "merge" => Some(CONTENT_FEATURE_MERGE), "render" => Some(CONTENT_FEATURE_RENDER), _ => None }
}

// src-tauri/src/protocol.rs:266-273（1:1 侧唯一判据）
pub fn dm_allowed_by_features(kind: &str, peer_features: u32) -> bool {
    let implied = if peer_features & CONTENT_FEATURE_MERGE != 0 { CONTENT_FEATURE_FLEX_DM_KIND } else { 0 };
    dm_required_features(kind) & !(peer_features | implied) == 0
}
```

发送侧接线：

```rust
// src-tauri/src/commands/chat.rs:681-690
if crate::protocol::dm_required_features(&kind) != 0 {
    let peer_features = s.peer_content_features.lock()...get(&friend_id).copied();
    if !crate::protocol::dm_allowed_by_features(&kind, peer_features.unwrap_or(0)) {
        return Err(crate::protocol::kind_blocked_hint(&kind, peer_features));
    }
}
```

- 门控**在公钥探测之前**（`:681` 早于 `:710` 的 `peer_x25519`）⇒ 不为一个根本不会发的东西白探测 1.2s ✓
- 缺条目（从未交换过 Hello / 已离线）⇒ 位图按 0 ⇒ "不知道就当不支持" ⇒ **退回旧行为，不发** ✓
- `kind_blocked_hint`（`protocol.rs:296-308`）把"确知不支持"（`Some(_)`）与"能力未知"（`None`）分成两句 ⇒ 不把"对方此刻不在线"说成"版本较旧" ✓

**对端版本更高的可解释状态**：`protocol.rs:85` `peer_protocol_is_newer(declared: Option<u32>)`；`Friend::peer_version_newer` 下发给前端；`protocol.rs:293` 注释记着两张表（`peer_content_features` / `peer_versions`）都只在内存里、重启即空。

**Paths walked:**
- `reader_loop` → `read_frame` → `decode_frame` → 未知 type ⇒ `Message::Unknown` → `transport.rs:1113` 忽略 + 节流日志 ⇒ **链路保持** ✓
- `reader_loop` → `read_frame` → `decode_frame` → 已知 type 字段畸形 ⇒ `Err` ⇒ `io::Error(InvalidData)` ⇒ reader 退出 ⇒ **拆链**（这是**刻意**的：那是本方的协议 bug，不该被静默吞掉）✓ 与文档第 1 条的"未知帧不得成为连接错误"不冲突
- `read_frame_preauth` → 首帧不是 Hello ⇒ `Err` ⇒ 丢连接（`transport.rs:652` `_ => return`）⇒ 符合"首帧必须是 Hello" ✓
- `commands/chat.rs::send_message`（1:1）→ `dm_required_features(kind) != 0` ⇒ 门控 ⇒ 不支持则 `Err` ⇒ **不发** ✓
- `Message::FileCancel` → `CONTENT_FEATURE_FILE_CANCEL` 能力位声明在 `content_features()`（`protocol.rs:206`）⇒ 只在对端声明过该位时才发（INV-P26 B3 的第 2 条）✓
- 群聊发送口 → **刻意不门控**（文档 §24 的"⬜ 残留"已如实登记）：`commands/chat.rs` 的群聊路径没有 `dm_allowed_by_features` 那样的门控 —— 群成员能力不齐、gossip 是 fire-and-forget ⇒ 发送方会收到一条受众预告（只提示、不拦）⇒ 不再是"静默看不见" ✓（文档明写这是残留，且给了降级方案作为待办）

**Searched:**
- `Message::Unknown` → 生产命中 4 处：`protocol.rs:165`（注释）、`:1934`（注释）、`:2041`（注释）、`network/transport/outbound.rs:87`（构造）、`network/transport.rs:1113`（消费）。**只有一个构造点、一个消费点** ✓
- `decode_frame` → `outbound.rs:82`（定义）+ `read_frame`（`:95`）一处调用。生产码里**没有**第二个 `serde_json::from_slice::<Message>` 的裸解码（护栏 `guards:未知帧类型必须降级而不是拆链` 注入的就是这一处）✓
- `isKnownKind` → 8 处消费（`messageHeight.ts:222`、`messages.ts:459`、`MessageItem.vue:843/1972`、`FavoritePanel.vue:50` + 测试）。**没有**第二份 kind 清单 —— Rust 的 `WIRE_KINDS`（`protocol.rs:459`）与前端的 `SILENT_KINDS`/`CARD_KINDS`/`BUBBLE_KINDS` 由 `src/utils/messageKinds.test.ts:63` 的跨语言契约测试逐项比对 ✓
- `kindClass` 回落 → `messageKinds.ts:21-25` 未知 kind 回落 `bubble`（**刻意**：宁可多显示一条也不要静默吞掉）⇒ 文档说的"用它判认识会永远判成认识"这一坑被避开（判"认识"走独立的 `isKnownKind`）✓
- `UNSUPPORTED_KIND_LABEL` → 前端 `messageKinds.ts:121` 与 Rust `protocol.rs:651` 两份，契约测试逐字比对 ✓
- `protocol_version` → `Hello` 变体携带（`protocol.rs:1831-1835`，注释明写"**不参与签名**，与 `content_features` 同理：加字段不能弄坏老端验签"）✓
- `peer_protocol_is_newer` → `protocol.rs:85`（定义）+ `Friend::peer_version_newer`（下发）✓
- `kind_allowed_by_features`（全局那条）→ `protocol.rs:229`（定义）+ `kind_audience` 侧的独立实现（`protocol.rs:318`，注释明写"群里的受众分布：三态分开数，**不要复用** `kind_allowed_by_features`"）⇒ 两个用途各自一份，理由在代码里 ✓
- `serde(default)` / `#[serde(default)]` → `protocol.rs` 的 `mention_targets` / `mentions` 相关字段（`Option<T>` 形态）
- `latest_todo_def` / `carryAbsentTodoFields` → 后端 `commands::latest_todo_def`（`src-tauri/src/commands/logs_tests.rs:909` 的用例钉它）、前端 `src/utils/todos.ts:520` `carryAbsentTodoFields` ⇒ 文档 §24 末尾那段"整份重建再发出"的两个家都在

**Hook verification:**
- `guards:未知帧类型必须降级而不是拆链` — **存在**：`scripts/guard_cases/ble_android.py:178`。注入 `decode_frame(&buf).map_err(` → `serde_json::from_slice(&buf).map_err(`，跑 `cargo test --lib --features bluetooth unknown_wire_frame_is_tolerated_after_auth`，期望失败信息含"数据面 read_frame 必须走 decode_frame" ✓（实测 name 命中 1 次）
- `guards:Hello 必须声明本机版本` — **存在**：实测 name 命中 1 次 ✓
- `tests::unknown_wire_frame_is_tolerated_after_auth` — **存在**：`src-tauri/src/lib_delivery_shape_tests.rs:20` ✓（基线命中 ⇒ 注册）
- `src/utils/versioning.test.ts` — **存在**：`src/utils/versioning.test.ts` ✓（`npm test` 的 glob `src/**/*.test.ts` 覆盖）
- `commands::tests::latest_todo_def_carries_fields_the_newest_payload_never_stated` — **存在**：`src-tauri/src/commands/logs_tests.rs:909` ✓（基线命中）
- `src/utils/todos.test.ts#老对端的更新不许把优先级与类型抹回默认` — **存在**：`src/utils/todos.test.ts` 内（标题片段可解析）✓
- `src/utils/todos.test.ts#跨语言：后端也必须沿用没说的三格` — **存在**：`src/utils/todos.test.ts:318`（`test("跨语言：后端也必须沿用没说的三格（与前端 carryAbsentTodoFields 同规矩）"`）✓

全部七条钩子存在并注册。

**How the verdict was reached:** 四条硬判据逐条对上号：第 1 条有独立解码入口 + 单一消费点 + 节流日志 + 链路保持（且护栏有注入用例）；第 2 条有前端唯一判定点 `isKnownKind` + 跨语言契约测试 + 占位气泡；第 3 条靠 `Option<T>` / `serde(default)` 与 `ChatMessage.kind` 改回 `String`；第 4 条有能力位表 + 唯一映射表 + 唯一判据 + 发送侧接线（门控在公钥探测之前、缺条目按不支持处理）。文档自己登记的两处缺口（群聊发送口刻意不门控；离线对端"未知即不支持"的代价是发不出去而不是延后判断）都如实写进了文档的"⬜ 残留"段，代码与之一致（群聊路径确实没有那道门控，而是走受众预告）。定为 `implemented`：文档的四条判据都有真实强制，且未实现的残留在文档里被显式登记为"残留"而非声称已完成 —— 不按"文档说残留 ⇒ 判 partial"处理，因为文档的硬判据第 4 条说的是"发送方只在对端声明支持时才允许发新帧或新语义"，群聊的 `FileCancel` 等新帧**确实**按能力位门控（INV-P26 B3 的能力位在 `content_features()` 里声明），而群聊**消息 kind**（`merge`）的发送口未门控是文档显式登记的例外路径。

**Open questions:**
- 群聊发送口刻意不门控（文档 §24"⬜ 残留"）—— 群消息的 `kind: "merge"` 老成员那边会退化成原始文本。文档说"发送方会收到一条受众预告（只提示、不拦）"。**这一半有接线**：`src-tauri/src/commands/window.rs:367-388` 在群发送内核里调 `protocol::kind_audience` + `kind_audience_hint`，并 emit `"content-audience"` 事件（只提示、不拦、消息照发）；`commands/group_announcements.rs:171/205` 另有 `creator_recall_audience` 一路。残留的只是"预告不拦"这件事本身（文档已登记）。
- `read_frame_preauth` 刻意不做未知帧降级（`outbound.rs:104-111`）。若某个老端的首帧不是 Hello 而是别的类型，会被当作握手失败丢连接 —— 符合"首帧必须是 Hello"，但对"更老版本"的对端是否构成跨版本断连，文档没有正面回答。
- 文档第 3 条提到的"老对端整份重建载荷、没带新增的三格"（`carryAbsentTodoFields` / `latest_todo_def`）这条属于文档正文而非四条硬判据，但它被写进了"Required Test Matrix"（`:1498-1499`）并有钩子。归到 INV-P24 记账是合理的，但它验证的是**另一件事**（写回兼容性），与"降级"不是同一条。
