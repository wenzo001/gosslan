# Gosslan 全仓库深度审计报告

> 审计日期：2026-10-29
> 审计基线：`11e452db`（审计期间仓库前进 7 个提交，下文结论已按 HEAD 复核）
> 方法论：Trail of Bits `audit-context-building` + `spec-to-code-compliance` 官方技能（已装到 `~/.workbuddy/skills/tob-*`），辅以 entry-point-analyzer / rust-review / sharp-edges / supply-chain-risk-auditor
> 范围：Vue 3 + TypeScript 前端（394 文件 / 81.9k 行）+ Tauri 2 / Rust 后端（185 文件 / 106.5k 行）+ SQLite + 局域网/中继/BLE 通信
> 配套证据：每条发现的全量分析在 `audit-context/`（`ORIENTATION.md` + 5 域 FINDINGS + 36 份逐条规范核查）

---

## 0. 结论摘要

Gosslan 是一个**工程质量显著高于同规模项目**的代码库：276 条带注入点的行为护栏、36 条协议不变量全部有钩子绑定、两条命令/事件层的双向差集均为零、不变量自等（空转守卫）经逐条核查**未发现**。本次审计共提出 **52 条发现**，其中 4 条为高危。

真实问题集中在三个方向，不是"全面崩坏"：

1. **身份信任链上有两处判据不一致** —— 网络路径绕过用户同意建立好友关系（SEC-01）、Gossip 锚点信任未验签公钥（SEC-03）。这两条是本报告最严重的部分。
2. **跨层同一份规则各写一份，已经漂移** —— 前端 `image` 可转发、后端白名单不收，单条转发 100% 失败（FUN-01/DUP-01）。同一根因在转发链路上重复了三份实现（DUP-02）。
3. **护栏机制强、断言层级弱** —— 152 条 Rust 护栏里约半数是源码文本断言而非行为断言，安全关键接线恰好落在这一族（TST-07）；最大的模块 `useChatStore.ts`（3471 行）零运行时测试（TST-02）。

严重度分布：

| 域 | Critical | High | Medium | Low | Info | 小计 |
|---|---|---|---|---|---|---|
| 安全 SEC | 0 | 3 | 1 | 3 | 5 | 12 |
| 功能 FUN | 0 | 1 | 2 | 2 | 1 | 6 |
| 稳定性 STB | 0 | 1 | 3 | 3 | 1 | 8 |
| 重复实现 DUP | 0 | 2 | 4 | 6 | 4 | 16 |
| 测试盲区 TST | 0 | 3 | 5 | 2 | 0 | 10 |
| **合计** | **0** | **10** | **15** | **16** | **11** | **52** |

> **关于 Critical 为 0**：本次未发现"无认证远程代码执行"或"加密被直接击穿"级别的缺陷。SEC-01/SEC-03 需要 LAN 内可达位置且在若干前提条件下才成立，因此评为 High 而非 Critical。SEC-08（8 GiB 聚合内存上限）被项目自己在代码注释里记录过，属已知缺口。

---

## 1. 最严重的问题（按修复顺序）

### 1.1 SEC-01 — 未经用户同意的 `FriendAccept` 把任意对端直接变成「好友」

**严重度：High ｜ 状态：已确认（静态分析 + 命令路径/网络路径对照）**

**位置**：`src-tauri/src/network/transport/handle_identity.rs:204-214`、`src-tauri/src/network/transport/handshake.rs:306-338`、`src-tauri/src/network/transport/gossip.rs:639-647`

**问题**：
「对方同意了我的好友申请」这条消息被当作**权威的好友关系建立指令**，但它只校验两件事：帧里的 `from` 是不是链路对端、`to` 是不是本机。**完全不校验本机是否真的发起过申请**。随后 `apply_friend_accept` 直接 `db::add_friend(...)`，把对端写进持久化的 `friends` 表。

```rust
// handle_identity.rs:204-214
Message::FriendAccept { from, to } => {
    if from != peer_id { return; }
    if to != state.device_id { return; }
    apply_friend_accept(state, &from, "收到好友同意");
}
```

```rust
// handshake.rs:310-318
let seen = db::get_friend(&dbc, from).is_some();
db::add_friend(&dbc, from, &name, None).ok();   // ← 无条件写入 friends 表
bind_friend_keys_on_accept(&dbc, from, key_snapshot);
```

**为什么"用户必须点同意"兜不住**：命令路径 `respond_friend_request`（`commands/mobile_picker.rs:473-481`）**检查** `pending_requests.contains_key(&peer_id)`，网络路径**不检查** —— 两者共用 `apply_friend_accept` 这个落库入口。

**触发条件**：
1. 攻击者在 LAN 上向本机监听端口发起 TCP 连接。
2. 首帧发 `Message::Hello`，`device_id` 用全新随机串，密钥对是攻击者自己的，`sig` 用攻击者私钥对 `hello_signing_bytes` 签名。
3. `verify_hello`（`handshake.rs:56`）走 **TOFU 分支**：`friends` 表查无此 id ⇒ `bound = None` ⇒ `hello_auth_decision` 的 `None` 分支（`handshake.rs:37-42`）只用自报公钥验签 ⇒ 通过。TOFU 是为"首次接触"设计的，此处本身不是缺陷。
4. 链路建立后发第二帧 `{"type":"friend_accept","from":"<攻击者的 device_id>","to":"<本机 device_id>"}`。`to` 的值攻击者已知 —— 受害端建链时会回发签名 Hello（`transport.rs:768-782` 的 `build_signed_hello`）里面带 `device_id`。
5. `handle_message`（`network/transport.rs:1085`）分派到 `handle_identity.rs:204` ⇒ 两个判据都过 ⇒ `apply_friend_accept` ⇒ **`friends` 表新增一行**，攻击者的 x25519 被绑定进 `friends.x25519_pubkey`（`handshake.rs:317`），并 `emit("friend-accepted")` 通知前端。
6. 跨跳版本同理：`GossipKind::FriendAccept`（`gossip.rs:639`）只判 `env.target == state.device_id`，同一入口。

**影响**：`friends` 表是后续几乎所有授权判据的输入（`is_friend`）—— 文件接收（`handle_file.rs:30`）、群文件、共享目录（`handle_share.rs:216/289/385`）、内容寻址拉取（`handle_share.rs:224`）、中继建电路（`list_bound_friend_identities`）全部读它。这一步等价于"对端自助获得本机信任"。受害者界面还会收到"好友已通过"的通知与一次系统弹窗。

**建议修复**：
- `apply_friend_accept` 增一道闸：入参区分"命令路径"与"网络路径"；网络路径必须先确认 `pending_requests` 里有这条申请（或该对端已在 `friends` 表里 ⇒ 走幂等重放分支）。**注意这是 Frozen Core（好友）范围内的改动，需按 AI_RULES 的 L2/L3 流程走。**
- 另一条更保守的出路：网络路径收到 `FriendAccept` 时只做"申请状态推进"（把这条申请标记为已接受、提示用户），由用户确认后才写 `friends`。

**回归测试**：`lib_friend_identity_tests.rs` 增一条：网络路径 `FriendAccept` 在 `pending_requests` 为空时**不得**写 `friends` 表（阳性对照：有 pending 时必须写）。这条是本仓已有的"双侧阳性对照"写法，直接照抄。

---

### 1.2 SEC-03 — Gossip 身份锚点信任「未签名 announce 提供的公钥」⇒ 可冒充好友注入聊天

**严重度：High ｜ 状态：已确认（探针实测，调用真实生产函数）**

**位置**：`src-tauri/src/network/transport/gossip.rs:205-210`（`peer_anchor`）、`handshake.rs:128-131`（`bound_ed25519_from_peer`）、`peer_registry.rs:135-188`（`upsert_peer` 的 `None` 分支）

**问题**：同一个身份（某 `device_id` 的公钥）在两条信任路径上被**用不同标准**取用：

- **Hello 验签路径**：`bound_ed25519_from_peer` 明确只信 `keys_verified` 的条目（`handshake.rs:129`：`peer.filter(|p| p.keys_verified)`）。
- **Gossip 锚点路径**（`gossip.rs:205-210`）：直接读 `peers` 表的 `ed25519_pubkey`，**不检查 `keys_verified`** —— 而 `peers` 表的该字段可以被**未签名的 UDP announce** 写入（`discovery.rs:605-618` 的 `AnnounceAuth::Legacy` 分支放行无签名包）。

```rust
// gossip.rs:205-210
let peer_anchor = {
    let peers = state.peers.lock()...;
    peers.get(&env.sender_id)
        .map(|p| (p.ed25519_pubkey.clone(), p.x25519_pubkey.clone()))
};   // ← 无 keys_verified 过滤
```

**触发条件**：攻击者广播一个 `device_id` = 受害者真实好友 F 的 announce（未签名即可），携带攻击者自己的 ed25519 公钥。随后构造 `GossipKind::Chat` 信封，`env.sender_id = F`、`env.sender_ed25519 = 攻击者公钥` ⇒ `peer_anchor` 命中 ⇒ 判据比对通过 ⇒ `sender_trusted = true`。

**已确认的证据**（探针直接调用本仓真实生产函数，非复刻）：
1. `new_peer_conflicts_with_friend(Some((None, None)), Some("X_ATTACKER"), Some("E_ATTACKER")) == false` ⇒ **friends 侧两列为 NULL 时不判冲突**（前提成立）；同一函数在 friends 侧有真实公钥时返回 `true` ⇒ 证明"返回 false"不是"恒返回 false"。
2. `bound_ed25519_from_peer(Some(&peer_with_keys_verified_false)) == None` ⇒ **Hello 路径确实拒绝**这条未验签条目。
3. 把 `gossip.rs:205-210` + `:217-223` 的锚点判定逐字复刻后，对同一个 `keys_verified=false` 的条目算出 `sender_trusted == true` ⇒ **Gossip 路径接受它**。

⇒ 两条信任标准对**同一份数据**给出相反结论。

**影响**：
- **消息伪造**：受害者聊天库里出现一条 `sender_id = F` 的消息，正文由攻击者完全指定。F 是受害者的**真实好友**，受害者无从分辨。
- **身份锁死**：F 自己的真实 ed25519 再也进不了 `peers` 表 —— F 的 Hello 触发 `upsert_peer` 的 `Some(p)` 分支时 `e_conflict = true` ⇒ `key_conflict` ⇒ 提前 return（`peer_registry.rs:227-231`）⇒ 锚点永久停留在攻击者的键。F 与受害者之间的跨跳聊天**静默中断**。
- **社工**：`warn_key_conflict_once` 会向受害者与 F 的会话插入系统消息「⚠️『F』的身份密钥发生变化，已保留原密钥未替换」⇒ 攻击者可在受害者界面伪造好友身份告警。

**建议修复**：
- `gossip.rs` 的 `peer_anchor` 与 `bound_ed25519_from_peer` **共用同一个判据**：只信 `keys_verified` 的条目。这条改动落在 **Frozen Core（E2EE）** 边界，需按 L3 流程走并明确「未触碰 msg_id / Outbox / Ack / SQLite schema」。
- 接收侧加一道闸：`GossipKind::Chat` / `Group` 必须 `env.encrypted == true`（明文只允许 `FriendMessageBlocked` 等控制帧），与 `gossip.rs:850` 注释声称的口径对齐。
- `upsert_peer` 的 `None` 分支：当 `friends` 侧两列均为 NULL 时也应拒绝以伪造 device_id 建条目（现在的冲突预判只在"两侧都有值且不同"时才拦）。

**回归测试**：仿 `lib_friend_identity_tests.rs` 的阳性对照写法 —— 构造 `keys_verified = false` 的 peers 条目，断言 Gossip 锚点判据对它返回 false；再构造 `keys_verified = true` 的对照组，断言返回 true。

---

### 1.3 STB-01 — 群文件分片的同步写盘跑在 tokio worker 上，且与单聊路径不对称

**严重度：High ｜ 状态：已确认**

**位置**：`src-tauri/src/network/transport/group_file.rs:2038-2074`（写盘在 `:2074`）；对照 `src-tauri/src/network/transport/handle_file.rs:360-384`

**问题**：`handle_group_file_chunk` 是 `async fn`，它在 **async 上下文里同步**做 `r.file.write_all(&plaintext)`，写的是一整个分块（LAN 上 `FILE_CHUNK = 256 KiB`）。这一段还**持有 `state.group_file_receivers` 这把进程级锁**。

单聊（1:1）路径对**完全同形**的工作早就搬进了阻塞池，注释里写明了理由与症状（`handle_file.rs:360-363`）：

```
// base64 解码 + AEAD 解密 + 增量 SHA-256 + 同步 `write_all`：整段离开 tokio worker
// （10-22 审计 R-01 的一半）。… 慢盘上一个 256KB 分块的同步写就把这个 worker 按住
// —— 表现是"传文件时整个界面一顿一顿"，连开窗一类的 IPC 也会排队（同一条 runtime）。
```

群文件这一支**只搬了「解码 + AEAD 解密」两步**（`group_file.rs:2015-2031`，注释明说"**只搬这两步**"），把「seq/size 校验 + 增量哈希 + 写盘」留在了 async 路径上。

**触发条件**：
1. 用户在群里收到一个 500 MB 的群文件。
2. 每片 256 KiB，在 `reader_loop` 的 tokio worker 上**就地**执行。
3. 慢盘 / 网络盘 / Windows Defender 实时扫描下，单次 `write_all` 轻易到几十毫秒。
4. 本机唯一的 tokio runtime 上还排着**所有** async IPC 命令 ⇒ 用户看到「传群文件时点设置没窗、拖窗口没反应」。
5. 更糟：写盘期间**持有 `group_file_receivers` 锁**，这把锁是**所有群文件传输共享**的 ⇒ 两条群文件传输互相拖死。

**建议修复**：把「seq/size 校验 + 增量哈希 + 写盘」整段搬进 `spawn_blocking`。注意 `group_file.rs:2015-2021` 的注释提出的顾虑（"整体搬进阻塞池就等于在等待里持锁"）—— 正确做法是：在池内只做**无锁**的纯计算（哈希 + 写盘到该 receiver 自己的 `File`），锁的获取/释放留在 async 侧，或改为每传输一把锁而非一把全局锁。后者同时解决 STB-03。

**回归测试**：`src-tauri/src/lib_tests.rs` 已有 `whole_file_slow_work_never_runs_on_an_async_worker` 同型用例（单聊侧），补一条群文件对应用例即可。

---

### 1.4 TST-07 / TST-03 — 安全关键接线只有形状守卫，且护栏非空转每天只跑一次

**严重度：High ｜ 状态：已确认**

**位置**：`src-tauri/src/lib_delivery_shape_tests.rs`、`scripts/verify-guards.py`、`.github/workflows/verify.yml`

**问题**：276 条护栏**全部有真实注入点**（本次逐条核查，未发现空洞守卫），但**约一半是源码文本断言**（`include_str!` + `.contains()`）而不是行为断言。落在这一族的安全关键接线包括：

- 群主撤回特权（`lib_delivery_shape_tests.rs`）
- key-change conflict 的拒绝路径
- relay token 不入日志

更关键的是 CI 覆盖面：`verify.yml` 的两个 guard job 的 `if` 只认 `schedule` / `workflow_dispatch` ⇒ **护栏非空转不在 push/PR 上跑** ⇒ 新增或改坏的守卫最长 24 小时无人验证。`check-ci-guard-coverage.mjs` 只对账"哪个 job 覆盖哪条通道"，不覆盖"非空转在不在 PR 上跑"。

**建议修复**：把关键接线从"形状断言"升级为"行为断言"（构造输入 → 跑生产函数 → 断言输出）；把护栏非空转的至少一条分片移到 push/PR 通道。

**回归测试**：本条本身就是测试基础设施缺陷，修复后由 `check-ci-guard-coverage.mjs` 钉住。

---

### 1.5 FUN-01 / DUP-01 — 单条图片消息「转发」必然失败

**严重度：High ｜ 状态：已确认（机械可验证）**

**位置**：`src/utils/messageKinds.ts:166`、`src/components/ChatWindow.vue:1255-1278`、`src-tauri/src/commands/chat.rs:559-592`、`src-tauri/src/commands/group_files.rs:23+`

**问题**：前端 `isForwardableKind` 允许 `image`：

```ts
// src/utils/messageKinds.ts:166
export function isForwardableKind(kind: string): boolean {
  return kind === "text" || kind === "code" || kind === "image" || kind === "file" || kind === "merge";
}
```

但 Rust 侧两条发送命令的 kind 白名单**都不含 `"image"`**：

- `send_message`（`commands/chat.rs:559-592`）：`"text" | "code" | "file" | "merge" | "reaction" | "remind" | "remind_ack" | "recall" | "render"`，其余落到 `_ => return Err("不支持的消息类型")`
- `send_group_message`（`commands/group_files.rs:23`）：`"text" | "code" | "merge" | "remind" | "remind_ack"`，其余落到 `_ => return Err("群聊不支持该消息类型")`

而 `ChatWindow.doForward`（`:1255`）只特判 `file`，`image` 落进 `chat.send(convId, f.content, f.kind)` ⇒ 撞上后端白名单 ⇒ 报错。

**同仓库批量转发路径处理正确** —— `forwardOne`（`:1408`）判的是 `m.kind === "file" || m.kind === "image"`，都走传输链路。⇒ **同一张图，单条转发失败、多选转发成功。**

**影响**：用户点"转发"选一张图片，必定看到失败 toast。零测试覆盖（`messageKinds.test.ts` 只断言 TS 自己，不读 Rust）。

**建议修复**（二选一，**修前端那一侧，不是改后端白名单** —— 后端白名单收紧是刻意的：图片消息必须由 `send_file*` 造出来，这是 Frozen Core 的设计）：
1. **推荐**：让 `doForward` 复用 `forwardOne` 的判据（`kind === "file" || kind === "image"` 走文件通道），并把 `filePath` 的取值从 `msg.kind === "file"` 放宽到两者。`MessageItem.vue:1213-1214` 同样要改（那里 `filePath`/`msgId` 也只对 `"file"` 取值）。
2. 或：把 `isForwardableKind` 的 `image` 去掉，让 UI 不给图片转发入口。

**回归测试**：加一条**跨层对账**用例 —— 断言 `isForwardableKind` 返回 true 的每个 kind 都被 Rust 白名单接受。仓里 `dmReaction.test.ts` 已有跨层对账的先例可照抄。

---

## 2. 其余安全发现（SEC）

| ID | 严重度 | 状态 | 一句话 | 位置 |
|---|---|---|---|---|
| SEC-02 | High | 确认 | 未认证 UDP announce 让 `peers` 表无界增长，并被每 300ms 全量序列化推前端 | `network/discovery.rs:585-674`、`peer_registry.rs:115-274`、`state.rs:2588-2609` |
| SEC-04 | Medium | 确认 | `ChatStyle` 的 `from` 未绑定链路对端 + `style` 无长度上限 ⇒ 持久化库无界增长 + O(N²) 写放大 | `network/transport/handle_messaging.rs:15-39` |
| SEC-05 | Medium | 确认 | 中继授权默认 `All`：任何对端都可把本机当转发器，且无速率限制 | `mesh/relay_policy.rs`、`network/transport.rs:1090-1107` |
| SEC-06 | Low | 确认 | 入站 `UserInfo` 的 `avatar`/`nickname` 无长度上限 ⇒ 落 `friends`/`conversations` 表并反复推前端 | `handle_messaging.rs` |
| SEC-07 | Low | **需验证** | announce 分支把对端自报的 `tcp_port` 用作回拨目标（源地址伪造在目标网络是否可用依赖部署环境） | `network/discovery.rs:625-637` |
| SEC-08 | Info | 确认 | 入站帧**聚合**驻留内存无全局配额：`MAX_INBOUND_CONNECTIONS(128) × MAX_FRAME(64 MiB) ≈ 8 GiB`（项目代码注释已自认） | `transport/tcp.rs:84-125`、`protocol.rs:16` |
| SEC-10 | Low | 确认 | `RelayChunk` 的中继分支用 `to`（自报字段）做定向转发目标 | `network/transport/relay.rs` |
| SEC-11 | Low | 确认 | `Message::OpaqueExternal` 的 `id`/`payload` 进入 Bloom 去重表，攻击者可用随机 id 冲刷去重表 | `network/dispatch.rs:228` |
| SEC-12 | Low | 确认 | `handle_group_file_offer` 的 `name` 未在入库前消毒（群文件名的显示层） | `network/transport/group_file.rs` |
| SEC-09 | — | **已撤回** | 「中继记录层明文队列无界累积」——实测被 `poll_read` 的排空顺序钉在一条记录以内，原结论不成立 | `transport/relay_seal.rs` |

### 2.1 已检查并确认安全（明确覆盖，避免重复审计）

- **TCP 分帧**：长度前缀**先校验后分配**；预分配封顶 64 KiB；`MAX_PREAUTH_FRAME` 64 KiB；未知帧降级不拆链；`MAX_INBOUND_CONNECTIONS` / dial 许可 / 链路数上限齐全。
- **文件接收（重点核查项）**：路径穿越被 `safe_file_name` + `safe_transfer_id` 在**每一个落盘点**挡住（含群文件）；符号链接被 `canonicalize` + `starts_with` 挡住；写前判大小；三条接收路径**都在 rename 前**比 SHA-256；`place_unique` 用 `hard_link` 原子占名，无 exists→rename 窗口。
- **密码学与身份**：X25519 / Ed25519 / ChaCha20-Poly1305 用 `OsRng`；Hello nonce 在**验签之后**才消费（防洪泛挤掉合法对端）；`update_friend_pubkeys` 只填空不覆盖；用户显式确认后的换钥是独立命令（`sync_friend_keys`）。
- **BLE**：三条上限都在分配前判断；重复片幂等；TTL 回收；首个 Hello 前丢帧不处理。
- **中继**：`accept_wrap_offer` 用**本地绑定**的 Ed25519 验签（不信任自报公钥）；计数器严格 `expect+1`（不可重放/乱序）；nonce 由计数器派生；电路数 `MAX_RELAY_CIRCUITS`=8。
- **落库幂等**：`insert_message_if_new` 按 `msg_id` 幂等 ⇒ 去重表被冲刷也不会产生重复消息行或重复通知。

---

## 3. 功能完整度（FUN）

### 3.1 命令层与事件层双向差集：基本为零

| 层 | 总数 | 孤儿 | 结果 |
|---|---|---|---|
| Tauri 命令（定义 = 注册） | 163 | 1（`get_topology`） | 定义未注册 0 / 注册未定义 0 |
| 前端 `invoke` 调用点 | 165（162 个命令名） | 0 | **无一条指向不存在的命令** ⇒ 无崩溃级缺口 |
| 后端事件 emit | 40（36 业务 + 4 `menu://`） | 0 | 36/36 全部有监听 |
| 前端 listen | 36（44 个调用点） | 0 | **无一条监听不存在的事件** |

仓库自带守卫（`src/api/events.test.ts:397`）已把这两条不变量机器化。

### 3.2 已验证端到端可用（追踪到 SQL）

消息：1:1/群发 · outbox 兜底 · Ack/状态前进 · 撤回（作者/群主两档）· 重发复用 msg_id · 表情回应（群/1:1）· 强提醒+回执 · 渲染切换 · 引用 · 合并转发
文件：1:1/群发（含图片走文件通道）· 取消传输（落 cancelled 墓碑）· 取消内容拉取 · 取消发送中消息 · 内容寻址重取 · 媒体存在性探测
群：建/改/删任务 · 任务图片 · 公告发布与删除 · 会话列表公告标记 · 成员增删/转让/退群
其它：收藏（含媒体独立副本）· 好友加/同意/拒/删 · 设置 13 键持久化与跨窗口广播 · 恢复默认 · 存储路径 · 搜索 · 已读回执 · 未读角标（托盘+Dock 数字）· 通知与点击跳转 · 清除全部数据（16 表分批删）· 中继/路由/外链/更新器/诊断

### 3.3 其余功能发现

| ID | 严重度 | 问题 | 位置 |
|---|---|---|---|
| FUN-02 | Medium | 收藏页转发图片同源同因（`FavoritePanel.vue:598` 第二份实现）—— 修 FUN-01 不会自动修它 | `src/components/FavoritePanel.vue:593` |
| FUN-03 | Medium | BLE 是非默认 Cargo feature，默认构建 `available()` 恒 false 且**界面不区分"硬件不支持"与"本次构建没编进去"**（判据 `ble.feature_compiled` 已存在但只在 DevDiagPanel 用）。发布包正常（CI 与 dist 脚本都带 `--features bluetooth`） | `src-tauri/Cargo.toml`、`NetworkSection.vue` |
| FUN-04 | Low | `get_topology` 是唯一后端孤儿，已在 `DEAD_COMMANDS` 挂账但理由已过期（"随 TopologyBar 在 5.0.3 删除"） | `src/api/events.test.ts` |
| FUN-05 | Info | 移动端 `set_unread_badge` 空实现，设计内边界（前端直接 return，不发 IPC） | `src/stores/useChatStore.ts:404` |
| FUN-06 | Low | 转发逻辑在 ChatWindow / FavoritePanel / MessageItem 三处各写一份，**已经漂移**（FUN-01/02 的根因）；`resendChannel.ts:54` 已有正确的 kind 集合可复用 | 三处 |

---

## 4. 稳定性与可靠性（STB）

| ID | 严重度 | 状态 | 问题 | 位置 |
|---|---|---|---|---|
| STB-02 | Medium | 确认 | `pending_requests` 是无界 Map，键与载荷都由不可信对端控制；`from_avatar` 收到 64 MiB 帧上限的 base64，无接收侧尺寸闸；无 TTL、无条数上限，且不在 `sweep_peers` 清理名单里 | `src-tauri/src/state.rs:1262` |
| STB-03 | Medium | 确认 | `file_receivers` 是进程级全局锁，每片写盘期间整表阻塞 ⇒ 并发传输互相拖累，可能被误判超时（`FILE_RECEIVE_IDLE_ABORT_MS = 5 min`） | `network/transport/handle_file.rs` |
| STB-04 | Medium | **需验证** | Gossip 去重登记早于"本机消费失败"；`allow_message_retry` 只覆盖"解密失败"与"落库失败"，`!group_consumable` 的提前 return 留下登记 ⇒ 群消息重发（同一 `message_id`）可能被永久判 Duplicate | `network/transport/gossip.rs:238-282` |
| STB-05 | Low | 确认 | 同一条 1:1 消息在"直发"与"补发"时用两种线格式（Gossip 信封 vs `ChatMessage`），两套独立去重机制 + 两个独立 kind 解析器，无守卫断言两者一致 | `network/transport/gossip.rs`、`handle_messaging.rs` |
| STB-06 | Low | **需验证** | `spawn_sync` 返回裸 `bool`，"已在飞"与"本机没这个群"不可区分 ⇒ 群历史同步可能被跳过一轮 | `network/group_history.rs` |
| STB-07 | Low | 确认 | `gossip_relay` 补递缓存的 TTL 与 `gossip_replay` 的窗口语义耦合，但两处 TTL 常量不同源 | `mesh/gossip_replay.rs`、`network/transport/gossip.rs` |
| STB-08 | Info | 确认 | `outbox_sweep` 的 `reachable` 快照在 peers 锁内 clone 全表，每 30s 一次 | `network/transport/outbox_sweep.rs` |

### 4.0a D/E 批复核（2026-10-29 晚）

| ID | 结论 | 证据 |
|---|---|---|
| **DUP-09** | 已加对账护栏 | 新用例「已读推进的排除清单两侧逐项一致」读 TS 的 `READ_PROMOTE_BLOCKED` 与 `db/read_receipts.rs` 的 `status NOT IN (…)` 逐项比；变异（TS 去掉 `partial_cancelled`）⇒ 红。 |
| **DUP-10** | 不另加 | `countsTowardUnread` 与 `is_non_notifying_kind` 互为补集且同源于 kind 表，已被既有 kind 分类对账间接覆盖（审计自己也判 leave alone）。 |
| **DUP-11** | 已被覆盖 | `messageKinds.test.ts` 的「未知 kind 判据与占位文案与 protocol.rs 一致」早在册。 |
| **DUP-12** | 已加对账护栏 | 新用例比 `previewBody`（TS）与 `preview_text` + `todo_preview`/`poll_preview`/`announcement_preview`（Rust）的独立字面量；变异（Rust 改一个字）⇒ 红。 |
| **TST-08 的 UI 半边** | **审计说错**：弹窗早就写了 | `ResetSection.vue` 的确认框有「以下内容不受影响：好友列表 / 设备身份与加密密钥 / 昵称头像与设置 / 其他设备上的聊天记录」（`settings.clear.item.identity`）。"保留身份但不说"这件事**不存在**，无需改。 |
| **DUP Part A 的矩阵反转** | 已补勘误 + 防复发 | `open-source-replacement-matrix.md` 新增 §0 勘误（3 条反转逐条给今天的实况、11 处过期、§3/§4 数字）；新用例「每个生产依赖都必须在矩阵里登记过」（变异：往 package.json 塞一个未登记依赖 ⇒ 红）。删 `@pinia/colada` 死依赖。 |

### 4.0 复核结论（2026-10-29 修复批，逐条读码后）

| ID | 结论 | 证据 |
|---|---|---|
| **STB-04** | **成立（窄口）**，已修 | 去重登记发生在消费之前；`group_envelope_consumable` 说"本机这次不该消费"（信封自报成员表缺我或缺发送者，典型是本机成员表与发送方新旧不一）时**原先不撤销去重** ⇒ 之后每份补发被判 `Duplicate`，消息永久进不来（直到重启）。修法：抽纯函数 `retry_allowed_for_this_frame`，把这一格也放行补发并留 `code=GROUP_ENVELOPE_NOT_CONSUMABLE`。⚠️ 审计原文说的"`!group_consumable` 的提前 return"不存在（那里只记判据、不 return），真实形状是"登记了但不消费"。 |
| **STB-06** | **不成立** | `spawn_sync` 的 `false` 只在"该群已在飞"时返回（`group_history_active.insert` 失败），没有"本机没这个群"这一支；未知群会在 `run_group_history_sync` 内部报出。返回值语义单一，调用方按"已在飞"处理是对的。 |
| **SEC-07** | **不成立（设计使然）** | `upsert_peer` 的 IP 取**报文源地址**（`src.ip()`），只有 `tcp_port` 来自载荷；对端能让我们拨的只有"它自己 IP 上的某个端口"。要把它变成打第三方，需要 UDP 源地址伪造 —— 那与"发现协议必须告诉对端端口"是同一件事的两面，改掉就没有发现。速率上已被 5s 广播周期 + `ensure_link` 去重兜住。 |

### 4.0b SEC-10 / SEC-11 / TST-04 的复核（2026-10-29 晚，读码后判"不修"或"改不了"）

| ID | 结论 | 证据 |
|---|---|---|
| **SEC-11**（`OpaqueExternal` 的 id 冲刷去重表） | **审计高估，不修** | 去重是 Bloom + LRU 两层，而 `BloomFilter::insert` 在 `count >= capacity` 时**整张位图清零轮换**（`gossip_engine.rs:52-56`）⇒ 不存在"填满后永久判重复"的断电式后果。洪水的最坏效果是"去重窗口被提前轮换 ⇒ 重复帧被重复处理"，而落库按 `msg_id` 幂等（`insert_message_if_new`）⇒ 无用户可见后果。改去重语义的风险大于这点收益。 |
| **SEC-10**（`RelayChunk` 用自报 `to` 做定向转发目标） | **设计使然，不修** | "中继"这个职责本身就是"把别人的帧送到它指定的目标"，`to` 必然来自帧；已有的闸是①中继授权策略（`relay_denied`，数据面三个转发点都过它，见 `lib_relay_data_tests.rs`）②本轮新加的每秒 100 帧全局限速。再加"目标必须是我们认识的人"会直接改变中继语义。 |
| **TST-04**（好友 reject 臂零测试） | **改不了（缺 harness），已有等价覆盖** | 该臂只有三行：守卫 + `forget_pending_request` + emit。它的决策逻辑 `friend_request_flush_decision` **已有 7 处测试引用**；"拒绝后 pending 不漏"由 `friend_request_survives_a_dropped_link` 与 `every_friend_accept_path_forgets_the_pending_request` 两处判据盯住。要做端到端行为测试需要一个能构造 `AppState` 的测试 harness —— 本仓目前没有，属于独立基础设施工作。 |

### 4.0c INV-P27（通知口径）的复核：审计判 "partial" 的依据不足

审计 §5 说「已读与红点共用 `chatViewerLooking()`，但系统通知那一族用
`!document.hidden && document.hasFocus() && activeConv===conv_id` —— 第三个条件是子集，
守卫只数 `!document.hidden && app.chatVisible` 这个组合所以看不见」。

逐条读 `docs/protocol-invariants.md` 的 INV-P27 后判：**spec 已经把这三种写法都列在表里**
（系统通知标"严"、标记已读标"严"、@红点标"★ 最弱 = 缺陷"），规则原文只禁止"重写成
`!document.hidden && app.chatVisible` 这个**组合**"，而通知那一族写的是**更严**的一档
（多了焦点与会话判定），不算"各取一个条件子集"。⇒ 这是 spec 与实现**已经对齐**的一条，
不需要改代码；要在文档里补的只有一句"通知那族为什么更严"（焦点不同：窗口可见但被别的应用
盖住时，已读可以推进、通知仍该弹）。

### 4.0d TST-10（`#[ignore]` 的真实库迁移演练）的复核：设计使然

那个用例（`db/migration_tests.rs::real_data_copy_replays_migration_without_losing_rows`）
要求 `GOSSLAN_DRILL_DB` 指向**一份真实安装库的只读副本** —— CI 里没有用户数据，永远跑不了，
所以 `#[ignore]` + 环境变量是**刻意的设计**，不是漏跑。它证明的是"真实体量/形状在当前迁移链下
不丢行"，而"迁移链本身对不对"已由同册里不 ignore 的那批用例覆盖（本轮实跑 1303 passed）。
边界：它的 `--ignored` 跑法写在用例注释里，**升级前需要人工跑一次**；要自动化得先造一份
"旧 schema + 代表性数据"的夹具，属于独立工作。

### 4.0e TST-05 的复核：审计指错了地方（编号不变性与权限窄档都有真用例）

审计说「群任务的 CRUD 写路径（改状态/归档/重开/认领）无独立单测，编号不变性只在跨进程轮」。
逐处读码后**这条不成立**，缺的只有"命令体本身"，而它需要的是一个本仓还没有的 `AppState` 夹具
（与 TST-04 同一个阻塞）：

| 审计点 | 实况 | 证据 |
|---|---|---|
| 编号不变性"只在跨进程轮" | **有 4 条内存库单测**：从 1 起递增 / 删光消息也不回收 / 对端自报的号也进高水位 / 老载荷没有 `number` 解析成 0 | `src-tauri/src/db/groups.rs` 的 `todo_number_tests`（`numbers_are_not_reused_after_messages_are_deleted` 等） |
| 归档/重开/认领的判权无单测 | **有**：`archive_only_change` 8 格、`claim_only_change` 十余格、`may_change_todo` 正反各一组、`resolve_done_archive` 7 格（含"非终态不许归档""重复保存不重置完成时间""客户端不能伪造 done_at"） | `src-tauri/src/commands/logs_tests.rs` |
| 命令体（`update_group_todo` 的参数校验/库回填/发帧） | **确实没有**：要构造 `AppState`（db + logger + 各类注册表），本仓没有这个夹具 | 与 TST-04 同一个前置条件 |

⇒ 结论：**不新增用例**。将来若有人做 `AppState` 夹具，TST-04 与 TST-05 的命令体用例可以一起补。

### 4.0f DUP-02 的残留：批量逐条转发漏了 `msg_id`（越权闸少一道）

审计 DUP-02 说"转发判据 4 处各写一份"。其中**通道选择**已在 5.15.9 收成 `isTransferKind` 一处，
但**越权闸**还差一条：后端 `owned_payload_rejection` 只在**给了 `msg_id`** 时才要求
「这条路径归这条消息」，不给就按"用户自己挑的文件"放行。单条转发（消息气泡 → 转发弹窗）一直传，
**批量逐条那条（`forwardOne`）没传** ⇒ 同一份判据在两条入口上一宽一严。

已修：`forwardOne` 的两条通道（群 / 单聊）都把 `m.msg_id` 交给后端；新用例
「批量逐条转发：两条通道都必须把 msg_id 交给后端（与单条同一道闸）」同时钉住单条那侧
（`f.msgId`）与调用数（各 2 处），变异（去掉 `m.msg_id`）⇒ 红，还原 ⇒ 绿。
顺带把取函数本体的 `tsFnBody` 从 `longPress.test.ts` 里提取出来（`utils/tsSource.ts`），
两处守卫共用一份，不再各抄一份。

### 4.1 已核查且未发现问题的稳定性面

- **锁顺序**：全仓无 `peers↔db` 嵌套；`file_receivers→db` 顺序成立。
- **锁跨 `.await`**：机器扫描每个 `tokio::sync::Mutex` guard 绑定（4 个候选），3 个是作用域误报，1 个（`BT_SWITCH_LOCK`）是刻意串行门，无重入。
- **INV-P34**：12 处登记的慢活全部在 `spawn_blocking` 内（唯一漏网是 STB-01 的 `write_all(`，不在判据的 `PRIMITIVES` 名单里）。
- **无界增长**：`peers` / `peer_content_features` / `peer_versions` / `key_conflict_warned` / `peer_manager` 身份 / `relay_file_keys` / `group_file_keys` / `file_receivers` / `seen_hello_nonces` / `gossip` / `mesh_router` / `file_wire_progress` / `pending_file_accept` 等**均有淘汰或清扫点**。
- **无限循环**：每个 `loop`/`while` 都有可证明的终止条件。
- **取消与恢复**：取消槽在慢哈希之前登记，守卫覆盖所有出口，键是 `(transfer_id, recipient)`，`set_message_status` 把 `cancelled`/`failed` 排除在迟到写之外。
- **前端生命周期**：每个 `setInterval`/`watch`/listener 都有配对拆解（`onScopeDispose`/`onUnmounted`/`scope.onDispose`）；object URL 均已 revoke（唯一例外是 `TodoImageThumb.vue` 里刻意保留的那处）。

---

## 5. 需求与实现偏差（spec-to-code-compliance）

对 `docs/protocol-invariants.md` 的 **36 条 INV-P** 逐条做规范-代码对账（每条一个独立分析文件，在 `audit-context/spec-compliance/`）。结果：

| Verdict | 条数 | 编号 |
|---|---|---|
| implemented | 30 | P01–P15、P17、P19–P26、P28–P35 |
| **partial** | **4** | **P16、P18、P27、P34** |
| contradicted / absent / stronger-than-spec | 0 | — |

**已确认的 4 条 partial**：

| ID | 偏差 | 证据 |
|---|---|---|
| **P16** | 文档点名的五档错误语义里 `recoverable`/`user_action_required`/`security_related` **全仓 0 命中**；只有文件/内容传输族有真分类（`FailReason` 九档 + `retryable()`），协议族（`verify_hello` 验签失败）与通用路径是自由文本 | `src-tauri/src/commands/files.rs`、`network/transport/handshake.rs:56` |
| **P18** | 判据 A/B 真实存在且已接门禁（96 类型 + 169 命令体，0 违规），但 `Identity` 私钥字段仍是 `pub`，`x25519_secret_b64()`/`ed25519_secret_b64()` 是两条现成的导出器；文档点名的 B-1a 补救（改私有 + 只暴露 `sign()`/`dh()`）未发生 | `src-tauri/src/crypto.rs` |
| **P27** | 已读与红点共用 `chatViewerLooking()`，但**系统通知那一族四处**（`useChatStore.ts:326/481/500/661`）用 `!document.hidden && document.hasFocus() && activeConv===conv_id` —— 第三个条件是子集，守卫只数 `!document.hidden && app.chatVisible` 这个组合所以看不见 | `src/stores/useChatStore.ts` |
| **P34** | 原状：十二处慢活逐格在池内、位置断言在、`Err` 不伪装成 `Ok`；但文档规则 6 写死的"现算处数 17"与判据实际钉的 **18** 不同步。**2026-10-29 晚已改文档（17 → 19，与判据同句说明"法条上的数要跟着判据走"）**；STB-01 那处 `write_all(` 已随 5.15.10 收进 `PRIMITIVES` | `docs/protocol-invariants.md` vs `lib_relay_data_tests.rs` |

### 5.1 规范与代码的分歧（不绑定到单条要求）

1. **spec 的 ⚠️ 引用的行号与理由已过期**（INV-P03）：`state.rs:873-874` → 实为 `:1060-1061`；`state.rs:1173` → 实为 `:1753`；「`Cargo.toml` 里没有 `[dev-dependencies]`」→ 实为 `src-tauri/Cargo.toml:194-196` **已有** `[dev-dependencies] tempfile = "3"`。结论不变（`AppHandle<Wry>` 类型不兼容才是真因），但理由陈述需更新。
2. **spec 点名了不存在的判据名**（INV-P11）：`peer_keys_trusted` 已被 `FriendKeySnapshot::capture(...).verified` 取代。
3. **三条 Ack 钩子分类错位**（INV-P03）：`ack_from_non_recipient_is_rejected` / `ack_sender_check_uses_group_file_owner` / `repeated_ack_is_idempotent` 全部落在 `db/favorites_tests.rs:1945-1981` 的**群文件**段（判 `update_group_file_recipient`），而 INV-P03 讲的是 1:1 消息 Ack。1:1 的对应判据 `db::ack_delivery_tests::*` 在册但**未被引用**。
4. **两条身份持久化钩子指向错误对象**（INV-P12）：点名的两条分别判**对端** peer 绑定与**好友**公钥；本机身份持久性的六条真判据在 `state.rs:2998-3157`（在册，未被引用）。
5. **BLE 路径无未知帧降级**（INV-P13）：`ble/io_loops.rs:200` 直读 `serde_json::from_slice::<Message>`，不走 `decode_frame` ⇒ 不产生 `Message::Unknown`、不记版本对比日志（行为上仍满足 spec 三条禁止）。
6. **群消息的"逻辑时间"有自认缺陷**（INV-P09）：`lib_delivery_shape_tests.rs:418-470` 记录"离线成员回来后第一条排在当天更早消息前面"。不违反 spec（键仍稳定），但"逻辑序号 ≈ 真实时间顺序"在离线成员上不成立。
7. **两处生产常量无测试钉住**（INV-P07）：`GossipEngine.ttl = 6`（`state.rs:2200`）与 `MeshRouter.max_ttl = 6`（`:2210`）是两个独立的 6，无断言绑定；`fanout = 4` 改常量不会让任何测试变红。
8. **INV-P08 的 "one logical delivery" 在网络层是两帧 Ack**：接收方对同一 `msg_id` 会回 `Message::Ack` **和** `GossipKind::ChatAck`；只在发送方状态上算一次。

> 全部 36 条 Rust 钩子均已核实：定义存在（每条恰好 1 处）且在 `test-baseline.macos.txt` / `test-baseline.windows.txt` **双平台在册**；`node scripts/check-invariant-hooks.mjs` 实跑通过。

---

## 6. 重复造轮子（DUP）

### 6.1 既有 `open-source-replacement-matrix.md` 的核验判决

矩阵 43 行逐行现读现核：**26 行仍准确 / 11 行过期（事实变、方向不变）/ 6 行结论已反转**。

三条反转（矩阵写于 2026-10-22，之后有 21 个前端提交）：

| 矩阵行 | 矩阵写的 | 今天的事实 |
|---|---|---|
| A31 消息列表虚拟化 | 「C 保留自研 / 525 行」 | `VirtualList.vue` **909 行、已迁 `@tanstack/vue-virtual`**（2026-10-25 迁移） |
| A38 Markdown | 「无 Markdown 渲染」 | **`marked@18.1.2` 已在生产依赖并真在用**（`src/utils/markdown.ts`，更新说明渲染） |
| A39 DOMPurify | 「C 不引入」 | **`dompurify@3.4.17` 已在用**（`src/utils/markdown.ts:10`） |

另：§4 测试读数过期（矩阵写 1053/1053，本轮实跑 **1481/1481**）；§3 依赖清单漏列 `mitt`/`vue-i18n`/`vue-router`/`zod`/`motion-v`/`marked`/`dompurify` 七个。

### 6.2 库替换结论：**必须换的 0 个**

矩阵 §1 已把该换的都换了，实装版本与声明逐条一致。其余全是"看起来像但不该换"：自研 LRU（31–155 行）比 `lru-cache`/`p-limit` 更小且语义不同、canvas 缩略图与 emoji 图片表情库根本不适用、拖拽/diff/PDF/QR/重试**无对应职责**。

**Rust 密码学不是手搓** —— `crypto.rs` 352 行是 `x25519-dalek`/`ed25519-dalek`/`chacha20poly1305`/`sha2` 的薄封装。

两个小机会：
- `@pinia/colada@1.4.8` 是**死依赖**（`src/` 与 `scripts/` 0 处引用）⇒ 建议删。
- `lucide-vue-next@0.469.0` 偏旧 ⇒ 建议评估升级。

> 所有冻结核心项（msg_id / E2EE / Outbox / Ack / SQLite schema / 好友 / 文件 / 通知 / Chat UI）已逐条标 **Forbidden (Frozen Core)**。DUP-01 的修法也是**改前端那一侧，不是改后端白名单**。

### 6.3 重复实现清单（16 条）

| ID | 严重度 | 类型 | 问题 | 位置 |
|---|---|---|---|---|
| DUP-01 | High | 跨层规则漂移 | 消息 kind 白名单 TS 与 Rust 各写一份，**`image` 已漂移**（见 §1.5） | `messageKinds.ts:166` vs `commands/chat.rs:559-592` |
| DUP-02 | High | 重复业务逻辑 | 转发判据 4 处各写一份，已漂两处（image 处理、缺失路径提示三套文案）；批量/收藏两条路径**漏传 `msgId`**（少一道越权闸） | `ChatWindow.vue:1255` / `ChatWindow.vue:1408` / `FavoritePanel.vue:593` / `MessageItem.vue:1205` |
| DUP-03 | Medium | 重复工具 | Rust `now_ms()` 9 份逐字相同的 4 行实现（已有 3 种写法） | `src-tauri/src/**/*.rs` |
| DUP-04 | Medium | 重复工具 | Rust SHA-256 hex 编码 8 份逐字相同的 `.map(\|b\| format!("{b:02x}")).collect()` | 同上 |
| DUP-05 | Medium | 重复组件 | `LogViewer` 两个外壳各抄一份**逐字相同**的虚拟行模板（8 个 `v-html` 落点）；矩阵误以为"两条外壳"是迁移前的问题 —— 虚拟化迁了，两份拷贝还在 | `src/components/LogViewer.vue` |
| DUP-06 | Medium | 重复组件 | 「表情切段 + 链接/提及切段 + 逐段渲染」3 份同形实现 | `src/components/message/*` |
| DUP-07 | Low | 重复逻辑 | @提及的「16% 透明底」配方散在 2 处 + 一个未被复用的第三种配方 | `src/style.css` 等 |
| DUP-08 | Low | 重复组件 | 头像渲染 13 个副本各自手写 `gosslan-avatar-box` + `gosslan-avatar-emoji`，圆角已漂成 3 种 | `src/components/**` |
| DUP-09 | Low | 跨层规则 | 已读推进的排除清单 TS 一份、Rust 一份，今天字面值一致（**尚未漂移，但无机器对账**） | `src/utils/*` vs `src-tauri/src/db/*` |
| DUP-10 | Low | 跨层规则 | 未读计数判据 TS 一份、Rust 一份，今天一致 | 同上 |
| DUP-11 | Low | 跨层规则 | 未知 kind 的占位文案 TS 一份、Rust 一份，今天一致 | 同上 |
| DUP-12 | Low | 跨层规则 | 预览文本（会话列表摘要）TS 一份、Rust 一份，今天一致 | 同上 |
| DUP-13 | Low | 自研基础设施 | TS 侧三份各自实现的 LRU / 容量闸 | `src/utils/*` |
| DUP-14 | Low | 重复组件 | `MessageItem` 的「复制 / 保存」动作在右键菜单与移动端 ActionSheet 两套模板里各写一遍 | `MessageItem.vue` |
| DUP-15 | Low | 重复组件 | 「移动端整屏覆盖壳」`MobilePageFrame` 的 `overlay` 形态被手抄 1 份 | `src/components/**` |
| DUP-16 | — | 负面清单 | 未找到重复的实现（避免误报） | — |

**DUP-09～DUP-12 是「今天一致但无机器对账」** —— 这类才是 DUP-01 的真正成因：没有一条守卫断言两侧字面值相同，于是漂移可以悄无声息地发生。

---

## 7. 测试盲区（TST）

### 7.1 覆盖现状

- 前端 `npm test`：**1481 通过 / 0 失败**（HEAD `11e452db`）
- Rust `cargo test`：**1274 通过 / 0 失败 / 1 ignored**
- 护栏：**276 条**（`GUARD_LANES cargo=152 npm=0 node=90 script=34`），**全部有真实注入点**，本次逐条核查**未发现空洞守卫**
- 不变量钩子：**36 条全部绑定**（形态：rust 112 / e2e 3 / guard-case 15 / frontend 26 / script 5）

**关键路径无自动化测试的数量：0 / 18。** 全部 18 条（消息收发/outbox/ack、重复投递幂等、文件传输六项、群文件、群任务 CRUD、好友四态、撤回、已读回执、身份持久化、TOFU→PIN、relay 授权、BLE 分帧、UDP 发现验签、crypto 四项、版本降级、崩溃恢复、SQLite 迁移）都有至少一条会因行为破坏而红的测试。

> 但严格打折后：**11 条纯 AUTOMATED，3 条关键接线只由形状守卫守着**（群主撤回权限、key-change conflict、relay token 不入日志），**3 条仅 SIMULATED**，**1 条（崩溃恢复 outbox）只在本地跨进程层**。

### 7.2 测试盲区发现

| ID | 严重度 | 问题 | 位置 |
|---|---|---|---|
| TST-01 | High | `saveDestination.test.ts` 是生产源码的**逐字节副本**（`diff` 无输出，两文件都是 1439 字节），**零用例**，却计入"138 个测试文件"⇒ 清单守卫被骗过，`saveDestinationOf` 真实覆盖率为 0 | `src/utils/saveDestination.test.ts` |
| TST-02 | High | `useChatStore.ts`（**3471 行，全仓最大未测模块**）零单元测试 —— 只被 `readFileSync` 形状断言引用；含矩阵 `:204` 记的**已出过真机事故**的乐观占位替换 | `src/stores/useChatStore.ts` |
| TST-03 | High | 护栏非空转只在 nightly 跑，`verify.yml` 两个 guard job 的 `if` 只认 `schedule`/`workflow_dispatch` ⇒ 新增/改坏的守卫最长 24 小时无人验证 | `.github/workflows/verify.yml` |
| TST-04 | Medium | 好友 **reject** 路径零测试 —— `handle_identity.rs:216-229` 整个臂无 `#[test]`，而它修的正是"已拒绝申请被反复重发"的缺陷 | `src-tauri/src/network/transport/handle_identity.rs` |
| TST-05 | Medium | 群任务的 **CRUD 写路径**（改状态/归档/重开/认领）无独立单测，编号不变性只在跨进程轮 | `src-tauri/src/commands/group_todo_media.rs` |
| TST-06 | Medium | 真 ENOSPC（写到一半磁盘满）无自动化；预检只是纯函数 + 形状守卫，`recv-readonly` 轮造的是 `EACCES` 不是 `ENOSPC` | `src-tauri/src/network/file/receive.rs` |
| TST-07 | Medium | 「群主撤回特权」与「key-change conflict」的接线只有**形状守卫**（74/152 cargo 守卫属这一族） | `src-tauri/src/lib_delivery_shape_tests.rs` |
| TST-08 | Medium | 身份持久化跨重启：无「重启后不再派生」分支的用例，且**代码与需求恰好相反**（`clear_all_data` 不删身份行） | `src-tauri/src/state.rs` |
| TST-09 | Low | Windows 侧缺三类生产行为用例（缓存软链清扫 / 磁盘写失败 / 托盘角标） | `src-tauri/test-baseline.windows.txt` |
| TST-10 | Low | 2 条新 Rust 用例不在基线里；唯一 `#[ignore]` 的真实库迁移演练永不执行 | `src-tauri/src/commands/files_tests.rs` |

**最大未测模块**：`src/stores/useChatStore.ts`（3471 行）。三个 store **全部零运行时 import**；16 个 composables 里仅 `useSubmitGuard` 有真行为测试，12 个只有形状断言，3 个（`useMentionContext`/`useShortcuts`/`useWindowLauncher`）完全无引用 —— 而 `useMentionContext` 正是矩阵 `:200` 点名的"同名两人高亮"那一格的核心。

### 7.3 已核查干净的测试质量面

- `skip`/`todo`/`only` 全仓 **0 处**。
- 无快照测试机制（`node:test` 无内置 snapshot）⇒ 无过期快照。
- 12 个前端测试文件含 `Date.now`/`new Date` —— **未逐条核实**是"喂固定时间戳"还是"读真时钟"，标为未验证。

---

## 8. 建议修复顺序

### P0 —— 先做（安全边界）

| 序 | 项 | 类型 | 为什么排这里 |
|---|---|---|---|
| 1 | **SEC-01** 网络路径 `FriendAccept` 必须查 `pending_requests` | 安全 | 唯一一条"未授权即可获得本机信任"的路径；改动面小（一个判据） |
| 2 | **SEC-03** Gossip 锚点只信 `keys_verified` | 安全 | 与 SEC-01 是同一族信任标准不一致；改判据即止。**注意 Frozen Core（E2EE）⇒ L3 流程** |
| 3 | **FUN-01/DUP-01** 转发 kind 跨层对账 | 功能 | 100% 失败的用户可见缺陷；**修前端那侧**；顺带加一条跨层守卫防止再漂 |

> 建议 1、2、3 合成**一个提交**：三者同属"同一份规则各写一份"的形状，一次修完并补上跨层对账守卫。（受 Change Budget 判据约束：`src-tauri/src/` 改动需要 `[impact]` 标记，同领域连续 3 次修补即红 ⇒ 这三处合并成一次更划算。）

### P1 —— 紧随（稳定性 + 测试层）

| 序 | 项 | 类型 |
|---|---|---|
| 4 | **STB-01** 群文件写盘搬进 `spawn_blocking` + 拆掉全局锁 | 稳定性（同时解 STB-03） |
| 5 | **STB-02** `pending_requests` 加上限 + TTL + 载荷尺寸闸 | 稳定性 |
| 6 | **TST-03** 护栏非空转的一条分片移到 push/PR | 测试基础设施 |
| 7 | **TST-02** `useChatStore.ts` 至少覆盖乐观占位替换路径 | 测试盲区 |
| 8 | **TST-01** 删掉 `saveDestination.test.ts` 那份副本，补真用例 | 测试盲区 |
| 9 | **TST-07** 群主撤回权限 / key-change conflict 升级为行为断言 | 测试盲区 |

### P2 —— 之后（合规、重复、其余）

| 序 | 项 | 类型 |
|---|---|---|
| 10 | INV-P16 错误语义五档 / INV-P18 私钥字段私有化（**P27 已判与 spec 对齐、P34 已改文档同步**，见 §4.0c/§4.0e） | 规范偏差（剩 2 条） |
| 11 | SEC-02 `peers` 表条数上限 + announce 限流 | 安全 |
| 12 | DUP-02 转发判据收成一家（4 处 → 1 处） | 重复实现 |
| 13 | DUP-09～DUP-12 加跨层字面值对账守卫 | 重复实现 |
| 14 | DUP-03/04/05/06 逐条收口 | 重复实现 |
| 15 | SEC-04/05/06/10/11/12 逐条加固 | 安全 |
| 16 | 修 `open-source-replacement-matrix.md` 的 6 条反转 + 11 条过期 | 文档漂移 |
| 17 | 删 `@pinia/colada` 死依赖；评估 `lucide-vue-next` 升级 | 依赖卫生 |
| 18 | SEC-08 的 8 GiB 聚合上限（项目自己已记录） | 已知缺口 |

---

## 9. 审计覆盖范围与未覆盖模块

### 9.1 已覆盖

| 层 | 覆盖内容 |
|---|---|
| 架构 | 70 个模块、**56 个入口点**（按 6 类 actor 分节：LAN-TCP 10 / LAN-UDP 5 / BLE 6 / 中继 8 / IPC 26 / 更新 7 / 文件系统 8）、9 个 actor 的信任级、26+1 张 SQLite 表、6 类密钥材料、10 类磁盘文件、~28 个内存注册表、15 个配置键 |
| 规范对账 | `docs/protocol-invariants.md` 全部 **36 条 INV-P**，逐条独立分析文件 |
| 安全 | TCP 分帧、UDP announce、BLE 分片、文件传输接收链（3 条路径）、内容存储、中继全栈、crypto/身份、Hello 握手 |
| 功能 | 163 个 Tauri 命令 ↔ 165 个前端 invoke 双向差集；40 个后端 emit ↔ 36 个前端 listen 双向差集；18 条核心业务流程端到端追踪到 SQL |
| 稳定性 | 全部 `tokio::sync::Mutex`/`std::sync::Mutex` guard 绑定、全部 `loop`/`while` 终止条件、~20 个内存注册表的淘汰点、取消/恢复全路径、前端生命周期拆解 |
| 重复 | 43 行替换矩阵逐行现核 + 16 条新发现（含 TS/Rust 跨层规则对账） |
| 测试 | 276 条护栏逐条读注入点、1481 前端用例 + 1274 Rust 用例的覆盖分级、18 条关键路径覆盖判定、平台基线差异 |

### 9.2 未覆盖 / 无法执行（诚实清单）

| 项 | 原因 |
|---|---|
| **真机硬件路径** | 无 BLE 设备、无多机局域网、无 Windows/Android 真机。BLE 分帧、软链清扫、磁盘写失败、托盘角标、真实 iOS/Android 路径均只做了静态分析 |
| **跨进程 E2E** | `npm run verify:e2e`（local 组）需 release 产物 + 桌面 GUI 会话 + 百 MB 级磁盘；本轮未跑。三实例链式 E2E（release 组）同样未跑 |
| **中继公网链路** | 无可用公网中继对端，`relay_seal.rs` 的记录层只做了静态分析 + 本地探针 |
| **长时间运行** | 无 ≥24h 的连续运行观测；竞态类结论（STB-04/STB-06、SEC-07）均为静态或局部探针 |
| **`GITHUB_ACTIONS=true` 环境下的 CI 行为** | 本机不模拟 Actions 环境；`verify.yml` 的 job 覆盖对账只做了配置层审查 |
| **前端运行时行为** | 未启动 Tauri 应用做交互验证；所有前端结论来自源码 + 静态断言。**唯一例外**是功能域用了 `node scripts/check-ui-runtime.mjs` 探针 |
| **12 个含 `Date.now` 的前端测试文件** | 未逐条核实是喂固定时间戳还是读真时钟 |
| **33 个含 `readFileSync`/`tmpdir` 的前端测试文件** | 未逐条核实是否有测试往仓库目录写文件 |
| **`@pinia/colada` 死依赖** | 确认 `src/`/`scripts/` 0 引用，但未跑构建证明删除后产物不变 |
| **Windows 编译** | 本机无 MSVC/MinGW 交叉工具链，Windows 专属代码本地编不出来 |

---

## 10. 测试结果汇总

| 检查 | 结果 |
|---|---|
| `npm test` | **1481 通过 / 0 失败**（HEAD `11e452db`） |
| `cargo test --offline` | **1274 通过 / 0 失败 / 1 ignored**（`lib.rs` 1 个 + doc-test 1 个 ignored） |
| `node scripts/check-invariant-hooks.mjs` | ✅ 36 条全部绑定，0 条登记为无自动化 |
| `python3 scripts/verify-guards.py --list` | ✅ 276 条全部有注入点；未发现空洞守卫 |
| `python3 scripts/verify-guards.py --print-lanes` | `cargo=152 npm=0 node=90 script=34 all=276` |

**未执行**：`npm run verify`（全量门禁，含 build 与 cargo fmt）、`npm run verify:e2e`（跨进程）、`npm run verify:release`（三实例链式）。

---

## 11. 审计方法与可复现性

### 11.1 使用的技能

| 技能 | 来源 | 作用 |
|---|---|---|
| `audit-context-building` | Trail of Bits 官方（`github.com/trailofbits/skills`） | 建立系统模型：模块/入口点/actor/状态/信任边界/脆弱点聚簇；产出 `audit-context/ORIENTATION.md` |
| `spec-to-code-compliance` | Trail of Bits 官方 | 逐条规范-代码对账，六档 verdict（implemented/partial/contradicted/stronger-than-spec/absent/undecidable）+ 逐条 "Searched" 记录 + 钩子核实；产出 36 份 `req-INV-PNN.md` |
| `entry-point-analyzer` / `rust-review` / `sharp-edges` / `supply-chain-risk-auditor` | Trail of Bits 官方 | 攻击面枚举、Rust 专项审查、边界与尖角识别、依赖链风险 |

技能安装位置：`~/.workbuddy/skills/tob-audit-context-building`、`tob-spec-to-code-compliance`、`tob-rust-review`、`tob-sharp-edges`、`tob-entry-point-analyzer`、`tob-supply-chain-risk-auditor`。

### 11.2 证据文件

```
audit-context/
├── ORIENTATION.md              架构模型（56 入口点 / 9 actor / 40 候选函数）
├── security/FINDINGS.md        12 条安全发现 + 18 项已确认安全
├── functional/FINDINGS.md      6 条功能发现 + 命令/事件双向差集
├── stability/FINDINGS.md       8 条稳定性发现 + 已核查安全面
├── dup/FINDINGS.md             16 条重复实现 + 矩阵核验 + 库替换评估
├── tests/FINDINGS.md           10 条测试盲区 + 覆盖矩阵
└── spec-compliance/            36 份逐条规范核查（req-INV-P01 … req-INV-P35）
```

### 11.3 方法论要点

- **规范-代码对账**用六档 verdict 而非"通过/不通过"，`partial` 与 `absent` 分开 —— `absent` 判定必须附上「搜了什么、命中几处、哪些不相关」，否则「没找到」与「没找完」不可区分。
- **发现必须能落到一行代码**：每条发现给出 `file:line` + 攻击/触发路径 + 影响；无法构造攻击路径的一律标「需验证」而不是「缺陷」。
- **不把"看起来像缺陷"当缺陷**：本轮有 **1 条发现被主动撤回**（SEC-09：探针证明「中继明文队列无界累积」不成立，实测被 `poll_read` 的排空顺序钉在一条记录以内）。
- **护栏非空转**：逐条核查 276 条守卫的注入点，未发现空洞守卫（本仓已吃过"判据自等"与"锚点搬家"两次亏，护栏质量确实高）。

### 11.4 本轮未修改任何业务代码

`git status` 在审计全程只有 `audit-context/`（新增的审计证据目录）为未跟踪项；`src/` 与 `src-tauri/src/` **零改动**。所有探针写在 `/tmp`，测完即删。

---

## 12. 与 Frozen Core 的关系

本次审计**未触碰** Frozen Core（msg_id / E2EE / Outbox / Ack / SQLite 表 schema / 好友 / 文件 / 通知 / Chat UI）。其中 SEC-01、SEC-03、FUN-01 的修复**会**触及这些边界，按 AI_RULES 的分级走：

- SEC-03（Gossip 锚点判据）落在 **E2EE** ⇒ L3，需要 `[impact]` 标记与完整回归。
- SEC-01（好友关系建立判据）落在 **好友** ⇒ L3。
- FUN-01（转发 kind）落在 **Chat UI + 文件** ⇒ L2，但修法是**改前端那一侧**，不动后端白名单与 SQLite schema ⇒ 实际影响面可控。

> 建议 P0 三项合并为一个提交并显式声明影响范围，避免在同一领域连续三次修补触发 Change Budget 判据 3。
