## REQ-INV-P35 — 会话归属只来自目标，不来自发送者

> "群信封的会话键只能由 `group_id` 决定（`group:{gid}`）；`sender_id` 是「谁说的」，不是「说在哪个会话」。
> 只有单聊才用 `sender_id` 做会话键。目标缺失或空白时必须**丢弃并留痕**，不许回退成 `group:` 空群会话，
> 也不许回退成发送者的单聊。
> 为什么它是协议级的：同一条群消息会经直连 Gossip、第三方转发、离线补发、历史同步四条路径到达，
> 四条都必须落到同一个 `conversations.id`。其中任意一条按发送者归属，用户就会在**个人聊天**里看到
> 本来只属于群的内容（2026-10-20 修的就是这个形状），而且 `unread` / `last_msg` / 列表排序会一起被改写 ——
> 那不是渲染问题，是数据写错了会话。
> - 唯一定义点：`network/transport/gossip.rs::inbound_conversation`（`member_notices` 另有一处只用于群系统提示文本）。"
> — docs/protocol-invariants.md §31. Conversation Ownership / INV-P35, line 1682

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 群信封的会话键只能由 `group_id` 决定；只有单聊才用 `sender_id`；目标缺失/空白必须**丢弃并留痕**（不许回退空群、不许回退单聊）；四条到达路径（直连 Gossip / 第三方转发 / 离线补发 / 历史同步）必须落到同一个 `conversations.id`。

**Where enforcement lives:**

**唯一定义点：**

```rust
// src-tauri/src/network/transport/gossip.rs:139-161
pub(crate) fn inbound_conversation(
    kind: &GossipKind,
    group_id: Option<&str>,
    sender_id: &str,
) -> Option<InboundConversation> {
    match kind {
        GossipKind::Chat => Some(InboundConversation {
            conv_id: sender_id.to_string(),      // ← 只有单聊用 sender_id
            kind: "single",
            group_id: None,
        }),
        GossipKind::Group => {
            // 只判空白，不改写目标本身：群 id 是身份，不是展示文本。
            let gid = group_id.filter(|g| !g.trim().is_empty())?;   // ← 缺失/空白 ⇒ None
            Some(InboundConversation {
                conv_id: format!("group:{gid}"),                    // ← 只由 group_id 决定
                kind: "group",
                group_id: Some(gid.to_string()),
            })
        }
        _ => None,
    }
}
```

- What it checks, and against what：`GossipKind::Group` 的 `conv_id` = `format!("group:{gid}")`，**只用** `group_id` ⇒ `sender_id` 不参与；`group_id` 为 `None` 或空白 ⇒ 返回 `None`（**不回退**）。`GossipKind::Chat` 的 `conv_id` = `sender_id`（单聊才这么用）。其它 kind（Presence / ChatAck / …）⇒ `None`。
- Which paths reach it, and which do not：`handle_gossip` 里**恰好一次**调用（`gossip.rs:859`），判据 `gossip_tests.rs:361-366` 断言恰好 1 次。

**丢弃并留痕：**

```rust
// src-tauri/src/network/transport/gossip.rs:858-874
let Some(target) = inbound_conversation(&env.kind, env.group_id.as_deref(), &env.sender_id)
else {
    if env.kind == GossipKind::Group {
        state.logger.warn(
            "group",
            format!(
                "丢弃缺少群目标的群信封 msg={} sender={} —— 会话归属不猜、不回退到单聊",
                env.message_id, env.sender_id
            ),
        );
    }
    return;
};
let conv_id = target.conv_id;
```

**结构护栏（"不许把归属逻辑重新内联回 handle_gossip"）：**

```rust
// src-tauri/src/network/transport/gossip_tests.rs:352-386
fn handle_gossip_takes_conversation_only_from_the_single_definition() {
    ...
    assert_eq!(
        body.matches("inbound_conversation(").count(),
        1,
        "handle_gossip 必须恰好调用一次 `inbound_conversation` —— 改成就地拼会话键等于开出第二个定义点",
    );
    // ⚠️ 这几条都在**原文**上搜（不 code_flat）：带空格的 Rust 语句一旦去空白
    // 就变成 `letconv_id=env.sender_id;`，断言会永远为真 ⇒ 判据自等。
    assert!(
        body.contains("let conv_id = target.conv_id;"),
        "会话键必须原样取自 `inbound_conversation` 的结论（`target.conv_id`）",
    );
    for forbidden in ["conv_id = env.sender_id", "conv_id: env.sender_id"] {
        assert!(!body.contains(forbidden), "handle_gossip 里又出现 `{forbidden}` …");
    }
    assert!(
        !body.contains("format!(\"group:\")"),
        "群会话键不许在 handle_gossip 里就地拼",
    );
}
```

**Paths walked:**
- 直连 Gossip 群消息 → `handle_gossip` → `inbound_conversation(Group, group_id, sender_id)` ⇒ `conv_id = "group:{gid}"` ⇒ 落库到群会话 ✓
- 第三方转发（同一条群消息经中继）→ 同一条 `handle_gossip` ⇒ 同一个 `inbound_conversation` ⇒ 同一个 conv_id ✓
- 群目标缺失 / 空白 ⇒ `inbound_conversation` 返回 `None` ⇒ **丢弃 + warn 留痕**（`gossip.rs:863-871`）⇒ 不回退空群、不回退单聊 ✓
- 单聊 Gossip → `inbound_conversation(Chat, _, sender_id)` ⇒ `conv_id = sender_id` ✓
- 群历史同步（离线补发 / 历史同步路径）→ `db/group_history.rs:321` 用 `group_message_blocked_by_boundary(conn, group_id, item.seq, &item.kind)`，其 `group_id` 参数来自群 id ⇒ 归属由目标决定 ✓（该路径不经过 `inbound_conversation`，它按群 id 定位）
- 群文件消息（`group_file.rs`）→ `db::next_clock(&dbc, &conv_id)` 用的 `conv_id` 是 `format!("group:{group_id}")` 形态 ⇒ 群会话 ✓
- 前端：`applyIncomingToConversations`（`src/utils/messages.ts:680-711`）按 `incomingByConv` 的 **map 键**（即 conv_id）找会话 ⇒ `conv.last_msg` / `last_ts` / `unread` 都落在那个键上 ⇒ 群消息不碰同发送者的单聊 ✓

**Searched:**
- `inbound_conversation` → 生产调用 **1 处**（`gossip.rs:859`）；定义 `gossip.rs:139`；测试 `gossip_tests.rs:63/75/83/361` ⇒ **唯一定义点**成立 ✓
- `format!("group:` → `gossip.rs:154`（`inbound_conversation` 内）+ `db/group_history.rs` / `commands/` 的群会话键构造（那些是**别的**用途：从已知 group_id 构造会话键，不是入站归属判定）⇒ 判据 `!body.contains("format!(\"group:\")")` 只针对 `handle_gossip` 函数体 ✓
- `conv_id = env.sender_id` / `conv_id: env.sender_id` → **0 hits**（全仓）⇒ 2026-10-20 修掉的那个形状没有复现 ✓
- `member_notices` → `network/transport/member_notices.rs`（文档说"另有一处只用于群系统提示文本"）⇒ 它**不**参与入站消息归属 ✓
- 群会话键的其它构造点 → `commands/` 里的 `format!("group:{...}")`（如 `commands/chat.rs:1433` 的 `set_clear_boundary(&dbc, gid, boundary)`）—— 这些是**出站/本地**用途，归属由已知的 group_id 决定 ⇒ 与本条不冲突
- `handle_gossip` 的 `conv_id` 变量 → `gossip.rs:874` `let conv_id = target.conv_id;`（**原样取自**定义点，判据 `:367-370` 钉住这一行）✓

**Hook verification:**
- `network::transport::tests::inbound_conversation_group_never_uses_sender` — **存在**：`src-tauri/src/network/transport/gossip_tests.rs:63` ✓（基线命中）
- `network::transport::tests::inbound_conversation_rejects_missing_or_blank_group_target` — **存在**：`gossip_tests.rs:75` ✓（断言 `None` / `Some("")` / `Some("   ")` 三种输入都返回 `None`）
- `network::transport::tests::inbound_conversation_chat_and_group_are_disjoint` — **存在**：`gossip_tests.rs:83` ✓（断言单聊与群的 conv_id 不相交，且 Presence / ChatAck 返回 `None`）
- `network::transport::tests::real_db_keeps_group_and_dm_conversations_isolated` — **存在**：`gossip_tests.rs:96` ✓（基线命中；真 SQLite 夹具，`group:g1` / `group:g2` / `dev-b` 三类会话并存，断言群消息不进单聊）
- `network::transport::tests::handle_gossip_takes_conversation_only_from_the_single_definition` — **存在**：`gossip_tests.rs:352` ✓（基线命中）
- `src/utils/messages.test.ts#群消息只更新群会话` — **存在**：`src/utils/messages.test.ts:215` ✓（断言群消息的 3 条（文本/图片/文件）只让 `group:g1` 的 `unread = 3`、`last_ts = 12`，而 `dev-a` 单聊的 `unread = 0`、`last_msg = null`、`last_ts = 0`）
- `src/utils/messages.test.ts#多个群 + 单聊同批到达` — **存在**：`messages.test.ts:239` ✓（断言三个会话键各归各的未读/预览/时间戳）
- 全部七条钩子存在并注册。

**How the verdict was reached:** 文档的核心主张（"群信封的会话键只能由 `group_id` 决定；只有单聊才用 `sender_id`；目标缺失或空白必须丢弃并留痕"）在 `inbound_conversation` 里逐字实现（`format!("group:{gid}")` 只用 group_id、`filter(|g| !g.trim().is_empty())?` 使缺失/空白返回 `None`），且 `handle_gossip` 的 `else` 分支**确实**丢弃 + warn 留痕。文档特别强调的那条"结构护栏"（归属逻辑不许被内联回 `handle_gossip`）有形状判据钉住调用次数恰好 1 + `let conv_id = target.conv_id;` + 三条禁止形状。前端两条用例证明群消息不污染同发送者的单聊。定为 `implemented`。

**Open questions:**
- 文档说"同一条群消息会经直连 Gossip、第三方转发、离线补发、历史同步四条路径到达，四条都必须落到同一个 `conversations.id`"。本次核实的是：直连 Gossip 与第三方转发**都**经过 `handle_gossip` ⇒ 同一个 `inbound_conversation` ✓；前端归属 ✓。**离线补发与历史同步这两条路径**走的是 `db/group_history.rs`（按 `group_id` 构造 `format!("group:{group_id}")`），**不经过** `inbound_conversation` —— 它们的归属由**已知**的 group_id 决定（不是从信封里读），因此不会发生"按发送者归属"那种缺陷，但也不受 `inbound_conversation` 这条护栏保护。文档说"唯一定义点：`inbound_conversation`"，若把后两条路径也算进去，则实际有**两个**构造点（一个入站、一个按已知 group_id 构造）。这是措辞上的边界，不是缺陷。
- 群文件消息（`network/transport/group_file.rs`）与群公告（`commands/group_announcements.rs`）的会话键同样由已知 `group_id` 构造，不经 `inbound_conversation` —— 同上。
- `member_notices`（`network/transport/member_notices.rs`）文档说"只用于群系统提示文本" —— 本次未逐行核实它是否真的不用 sender_id 做会话键。
- 文档的"反向"说"把 `handle_gossip` 里的 `let conv_id = target.conv_id;` 换成 `env.sender_id` ⇒ 结构那条红（实测 exit 101，报「会话键必须原样取自 …」)" —— 判据确实会在那一行红，但**这不等于真机上不再串会话**（形状判据只在源码层）。
