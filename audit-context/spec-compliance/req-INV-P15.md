## REQ-INV-P15 — Event Is Notification, Not Durable Storage

> "Tauri event：
>
> ```text
> Rust → Vue
> ```
>
> 是通知机制，不是数据库。
>
> 如果事件丢失：
>
> ```text
> UI should be able to rehydrate from DB / command
> ```
>
> 不能因为一次 event 丢失而导致永久状态丢失。"
> — docs/protocol-invariants.md §INV-P15, line 511-525

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 事件的角色是"通知"，不是"存储"。任何一条事件丢了，UI 必须能**从 DB / command 重新取回**真相，不能因为丢了一条事件就永久少一份状态。

**Where enforcement lives:**

1) **消息：事件只是通知，DB 是真相**：

```rust
// src-tauri/src/network/transport/handle_messaging.rs:187-L192
if announced_on(&inserted) {
    let _ = state.app.emit("message-received", &out_rec);
    ...
}
```
emit 在**落库之后**（`inserted` 裁决之后）⇒ 事件携带的内容一定是已持久化的内容。
前端收到事件后仍然以 DB 为准：`useChatStore.ts:877-L895` 的 upsert 用 `pickMediaContent(prev, m)`（取更新的那份）与 `furthestStatus(prev.status, m.status)`（状态只前进）⇒ **事件不覆盖 DB 的真相，只做增量提示**。
事件丢了 ⇒ 下次 `loadMessages`（`useChatStore.ts:1656`，走 `api.getLatestMessages` → `get_latest_messages` 命令 → `db::get_latest_messages`）从 DB 重建整页。

2) **会话列表：事件丢了可重取**：`api.getConversations()`（`src/api/index.ts:212` → `get_conversations` 命令 → `db::list_conversations`）。`useChatStore.ts:1227` 是它的调用点。

3) **好友：事件丢了可重取**：`api.getFriends()`（`src/api/index.ts:162` → `get_friends` → `db::list_friends`）。`useChatStore.ts:984` 是调用点。

4) **设置窗口（常驻窗口）重新获得焦点时刷新环境数据**：

```ts
// src/entries/settings.ts:31
if (focused) void useAppStore().refreshEnvironment();
```
```ts
// src/stores/useAppStore.ts:1050-L1061
async function refreshEnvironment() {
  const [dev, ifaces, share, snap] = await Promise.allSettled([
    api.getDeviceInfo(), api.listInterfaces(), api.getShareDir(), api.getRuntimeSnapshot(),
  ]);
  ...
}
```
⇒ 常驻设置窗口不再依赖"重开一次才刷新"的事件。

5) **事件契约守卫（双向）**：

```ts
// src/api/events.test.ts:148-L165
test("每个 Rust 事件都必须有前端消费者，或写在例外清单里并说明理由", () => {
  const emitted = rustEmittedEvents();
  const listened = frontendListenedEvents();
  ...
  const orphans = [...emitted].filter((name) => !listened.has(name) && ... );
  assert.deepEqual(orphans, [], ...);
});
```
反向也有（`:167-L180`："前端监听的事件必须真的有人发"）⇒ **不存在"死监听"**（前端听了一个后端从不发的事件，那功能就是被悄悄摘掉了）。
例外清单 `ALLOWED_EMIT_WITHOUT_LISTENER`（`src/api/events.test.ts:31-L35`）**当前为空**（`:33` 注释："2026-10-26：`group-key-received` 是最后一条 —— 它从没被任何前端监听，且紧邻的 `groups-updated` 已经承担同一路径的通知，故直接删掉那次 emit"）。

6) **"先落库、后 emit" 的纪律**：
- 群发送内核：`commands/window.rs:327`（`tx.commit()`）→ `:341`（`emit("message-received", &rec)`），且 emit 在**锁作用域闭合之后**（`lib_delivery_shape_tests.rs:362` `group_send_kernel_emits_to_own_windows_after_commit_outside_the_lock` 钉住）。
- 落库失败 ⇒ 不 emit（`handle_messaging.rs:171-L186` 的 `may_ack` 闸在 emit 之前 return；`gossip.rs:1188-L1198` 的 Err 分支只记日志）。

7) **事件载荷不承载"唯一一份"的数据**：
- `message-received` 载荷是 `MessageRecord`（DB 行的镜像）⇒ 丢事件 = 少一次刷新，不丢数据。
- `peer-read` 载荷是 `{ peer_id, last_read_ts }`（`handle_messaging.rs:292-L295`）—— **注意**：这条事件是"增量"（只带一个时间戳），但 DB 里的 `messages.status` 是真相（`db::mark_own_messages_read_upto` 已在事件发出**之前**落库，`handle_messaging.rs:283-L287`）⇒ 事件丢了不影响 DB 状态；前端的绿勾会由下一次 `loadMessages` 补上。
- `message-acked` 载荷是 `msg_id`（`handle_messaging.rs:228`），DB 状态已落（`ack_delivered` 在同一事务里）。

8) **未读数**：DB 里的 `conversations.unread` 是真相（`db::touch_conversation` / `db::mark_read`）。前端未读是缓存；`useChatStore.ts:1227` 的 `getConversations()` 可重取。

**Paths walked:**
- `message-received` 事件丢失 → 用户切走再切回该会话 → `loadMessages`（`:1656`）→ `get_latest_messages` → DB ⇒ 消息在 ✓
- `peer-read` 事件丢失 → DB 的 `messages.status` 已是 `read`（落库在事件之前）⇒ 下次 `loadMessages` 读到 `read` ⇒ 绿勾在 ✓
- `message-acked` 事件丢失 → DB 的 `messages.status` 已是 `delivered`（`ack_delivered` 同事务）⇒ 下次 `loadMessages` 读到 `delivered` ✓
- 会话列表事件丢失 → `getConversations()` 重取 ✓
- 好友列表事件丢失 → `getFriends()` 重取 ✓
- 设置窗口常驻（关闭=隐藏）后重新显示 → `onFocusChanged` → `refreshEnvironment()` ⇒ 环境数据刷新 ✓
- **落库失败 + 事件丢失** ⇒ DB 与事件**都没**那条数据 ⇒ 两边一致（不是"事件丢了导致状态丢失"，而是"这一条本来就没成功"）✓
- **前端事件顺序竞态**（旧事件晚到）→ `applyIncoming` 用 `furthestStatus` 与 `pickMediaContent` ⇒ 状态只前进、内容取更新的那份 ⇒ 乱序不倒退 ✓

**Searched:**
- `emit(` 在 `src-tauri/src/` → 大量命中（Rust 侧事件发出点）；与本条相关的主要是 `message-received` / `message-acked` / `peer-read` / `group-read` / `file-progress` / `group-delivery-changed` / `message-failed` / `message-status-changed` / `friend-request` / `friends-updated`
- `app.emit("message-received"` → **9 处生产 emit**：`handle_messaging.rs:188`（直连收）、`gossip.rs:1201`（Gossip 收）、`commands/window.rs:341`（群发送内核自回送）、`commands/files.rs:1529`（1:1 文件发送自回送）、`network/transport/handle_file.rs:595`（1:1 文件收完成）、`network/transport/group_file.rs:804` 与 `:1223`（群文件 Offer/完成回填）、`network/transport/relay_file.rs:523`（中继文件）、`network/file/send.rs:117`（文件发送）；另有 2 处在**测试**里（`lib_delivery_shape_tests.rs:172`/`:373`，只做位置断言）
- `emit("peer-read"` → 2 处：`handle_messaging.rs:293`、`gossip.rs:735`
- `emit("message-acked"` → 3 处：`handle_messaging.rs:228`、`gossip.rs:672`、`network/file/send.rs:733`（文件用的 `file-{transfer_id}` 形态）；另有 `emit("group-message-acked"` 在 `handle_group.rs:85`
- `get_latest_messages` → `db/messages.rs:183`（定义）+ `db/favorites_tests.rs` 若干 + `src/api/index.ts:211`
- `loadMessages` → `useChatStore.ts:1656`（定义）+ `:1506`、`:1861`、`:2935`、`:3164`（调用点）
- `getConversations` → `src/api/index.ts:212` + `useChatStore.ts:1227`
- `getFriends` → `src/api/index.ts:162` + `useChatStore.ts:984`
- `refreshEnvironment` → `useAppStore.ts:1050`（定义）、`:885`、`:1128`（导出）、`src/entries/settings.ts:31`（调用）
- `ALLOWED_EMIT_WITHOUT_LISTENER` → `src/api/events.test.ts:31`（**空对象**，`:33` 注释说明最后一条已删）
- "先 emit 后落库"的形态 → **0 hits**：`group_send_kernel_emits_to_own_windows_after_commit_outside_the_lock`（`lib_delivery_shape_tests.rs:362`）用位置断言钉住

**Hook verification:**
- `guards:常驻窗口（设置窗口重新显示必须刷新环境数据）` → `scripts/guard_cases/frontend_ui.py:515-L532`（`name="常驻窗口（设置窗口重新显示必须刷新环境数据）"`，注入 `src/entries/settings.ts` 的 `onFocusChanged` 块，命令 `node_test("src/utils/windowEntries.test.ts")`）；由 `check-invariant-hooks.mjs` 的 `guards:` 形态解析 ⇒ 解析成功 ✓
- `src/api/events.test.ts#每个 Rust 事件都必须有前端消费者` → `src/api/events.test.ts:148`（测试标题逐字为"每个 Rust 事件都必须有前端消费者，或写在例外清单里并说明理由"）；由 `check-invariant-hooks.mjs` 的 `.test.ts#` 形态解析（读文件看是否含该片段）⇒ 解析成功 ✓；运行由 `package.json` 的 `"test": "node --test ... \"src/**/*.test.ts\" ..."` glob 覆盖 ✓
- `db::tests::pending_read_survives_restart` → `src-tauri/src/db/favorites_tests.rs:1251`；两平台基线在册 ✓ —— 它判的是"待发已读回执从 DB 恢复"，即"内存态可从 DB 重建"这条模式的一个实例
- 支撑（spec 未点名但在册）：`tests::group_send_kernel_emits_to_own_windows_after_commit_outside_the_lock`（`lib_delivery_shape_tests.rs:362`）、`src/utils/windowEntries.test.ts`（`:252-L256` 断言 `refreshEnvironment` 存在且被导出）

**How the verdict was reached:** spec 的判据是"事件丢了能否重取"。我逐条核对了被事件通知的每一类数据（消息、已读、送达、会话列表、好友列表、环境快照）在 DB / 命令侧的真相源与重取入口，全部存在；并确认事件发出**在落库之后**（事件不可能比 DB 更真）且前端对事件是"增量提示 + 只前进"（`furthestStatus` / `pickMediaContent`）而不是"覆盖真相"。另外 `events.test.ts` 双向守卫保证"没有死监听"（功能被摘掉时门禁会红）。所以判 `implemented`。

**Open questions:**
- **spec 点的 `db::tests::pending_read_survives_restart` 与本条的关系是间接的**（它判的是 DB→内存的恢复，不是"事件丢了 UI 能重取"）。真正对应"事件是通知不是数据库"的是 `src/api/events.test.ts`（双向事件契约）与 `tests::group_send_kernel_emits_to_own_windows_after_commit_outside_the_lock`（先落库后 emit）。**需要确认 spec 的钩子清单是否覆盖了本条的核心主张。**
- **`peer-read` 事件是增量载荷（只带 `last_read_ts`），不是 DB 行的镜像**。DB 状态在事件之前已落（`handle_messaging.rs:283-L287`），所以事件丢失**不会**导致状态丢失（重取 `loadMessages` 即可）。但如果 DB 写失败而事件仍发（当前顺序是先写后发，写失败会 return，事件不发）⇒ 一致。**无缺口。**
- **`message-received` 的 emit 在 `announced_on` 为真时发生**（只有本次真新建的一方发）⇒ 重复投递不产生第二条事件 ⇒ 前端不重复 upsert。这条同时是 INV-P02 的"UI 不重复"依据。
- **前端没有任何"事件流重放"机制**（没有 offset/sequence 号来检测丢失）⇒ 一次丢失只能靠"切会话触发 `loadMessages`"或"重开窗口"来修复。spec 说"UI should be able to rehydrate from DB / command" ⇒ **能力存在**，但不是自动检测+修复。**需要确认 spec 是否要求"自动发现丢失并修复"，还是只要求"有能力重取"。**
- `ALLOWED_EMIT_WITHOUT_LISTENER` 现在是空表（`src/api/events.test.ts:31-L35`），意味着**每一个** Rust 事件都必须有前端消费者。这条比 spec 更严，但它是 `events.test.ts` 的判据不是 spec 的。
