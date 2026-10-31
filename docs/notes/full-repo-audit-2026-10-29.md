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
> ⚠️ **本节记的是审计当时的发现。今天哪些已经落地、哪些判了不修，一律以 [§8 落地状态总表](#8-落地状态总表2026-10-29-深夜按现算对账) 为准** —— 「确认」「无机器对账」「零用例」这类字样不代表今天还没做（本轮对账实测：§8 的 19 行里有 9 行在写这张表时其实已完成）。


| ID | 严重度 | 状态 | 一句话 | 位置 |
|---|---|---|---|---|
| SEC-02 | High | 确认 | 未认证 UDP announce 让 `peers` 表无界增长，并被每 300ms 全量序列化推前端 | `network/discovery.rs:585-674`、`peer_registry.rs:115-274`、`state.rs:2588-2609` |
| SEC-04 | Medium | **已修**（5.15.14 上限与来源绑定；5.15.17 补 `code=CHAT_STYLE_FROM_MISMATCH` 留痕） | `ChatStyle` 的 `from` 未绑定链路对端 + `style` 无长度上限 ⇒ 持久化库无界增长 + O(N²) 写放大 | `network/transport/handle_messaging.rs:15-39` |
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
> ⚠️ **本节记的是审计当时的发现。今天哪些已经落地、哪些判了不修，一律以 [§8 落地状态总表](#8-落地状态总表2026-10-29-深夜按现算对账) 为准** —— 「确认」「无机器对账」「零用例」这类字样不代表今天还没做（本轮对账实测：§8 的 19 行里有 9 行在写这张表时其实已完成）。


### 3.1 命令层与事件层双向差集：基本为零

| 层 | 总数 | 孤儿 | 结果 |
|---|---|---|---|
| Tauri 命令（定义 = 注册） | 162（5.15.44 删掉 `get_topology` 后现读） | 0 | 定义未注册 0 / 注册未定义 0 |
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
| FUN-04 | Low | **已关闭（5.15.44）**：负责人拍板**删掉**（不接线）⇒ 命令本体 / 注册行 / `TopologyInfo` / `relay_circuit_count` 全删，`DEAD_COMMANDS` 回到空表、架构图两处快照同步；`link_is_relay_circuit` 保留（`relay.connected` 还在读） | `grep -rn get_topology src src-tauri/src` 现读 4 行、**全是注释**（0 个活引用） |
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

### 4.0g DUP-05（日志行模板两份拷贝）：已收成一个家，且两个既有登记跟着搬家

`LogRows.vue` 现在是日志行模板唯一的家；两个外壳各挂一处同一份组件，`v-html` 落点 8 → 4、
`v-memo` 依赖数组 2 → 1。跟着改的是**本来就该改的两处登记**：

| 登记 | 改动 | 为什么不是绕过 |
|---|---|---|
| `designGuards.ts::V_HTML_ALLOWED` | `components/LogViewer.vue` → `components/LogRows.vue` | 转义链一个字没变：`highlightText` 仍在 `LogViewer` 里生产那四段 `row.*`，清单里那条"必须是 `v.row.*`"的断言照钉，且 1067 行那句生产者断言仍然读 `LogViewer.vue` |
| `virtualListContract.test.ts`「行元素必须带 `data-index`」 | 改读 `LogRows.vue` | 它断言的是属性挂在行上，与住在哪个文件无关 |

⚠️ **本轮我自己犯的一次检索面过窄**（记在这里省一次重复踩）：动手前我只 grep 了含 "LogViewer"
字样的判据，得出"没有守卫读这个文件"的结论；实际有两处读的是**路径**（`components/LogViewer.vue`）
而不是文件名。抓到它的是 `verify-guards.py` 起跑前的**前端基线整套**（直接判红），不是我的检索。
⇒ 改完 `npm test` 1492/1492 全绿；真渲染凭据是 `check-ui-runtime.mjs --only=logs`
（独立窗 + 移动页两种外壳都真出行、滚动换页、无横向溢出）。

护栏册随之 276 → 279：行模板被抄回第二份 / 新增渲染字段没进 `v-memo` / 批量转发少传 `msg_id`
三发变异各注册成一条 Case，三条都跑过"改坏必须 FAIL、红由自己那句 hint 报出、恢复后逐字节一致"。

### 4.0h SEC-02 修完之后**新长出来的一格**（发版前 review 抓到，**已修**）

`peer_to_evict` 按 `last_seen` 最旧淘汰，**不区分这条是谁**。而 `peers` 不只是地址缓存，它同时是
公钥锚点的读取源（本轮实读数到的消费者）：

| 读它的地方 | 拿的是什么 |
|---|---|
| `transport.rs:1364`、`gossip.rs:842`、`peer_state.rs:45`、`pending_keys.rs:57` | `x25519_pubkey`（密封/解密给这个人） |
| `handshake.rs:81/180` | `ed25519` 绑定与冲突判定 |
| `dial.rs:332` | `first_seen` |

⇒ 满员时把一条**仍持有链路、但 UDP 侧很久没露面**（只经中继活着）的成员条目挤掉，后果不是"少一个缓存"，
而是**给这个人密封拿不到公钥** ⇒ 群消息对他发不出去，直到他自己再 announce 或被 Hello 重新登记。
好友那一族有 `friends` 回落（SEC-03 那次就为它建的），**不是好友的群成员没有回落**。

**已修（负责人 2026-10-29 晚点名做这条）**，落点与当初的建议一致：

- `peer_to_evict(peers, protected)` 跳过保护集里的条目；保护集 = `friends` ∪ 本机各群成员 ∪ 本机自己。
- 名单由 `protected_peer_ids(state)` 现取，而它**只在表已经满时**才被调用 —— announce 是 5s×N 的
  热路径，每条都问一次库会在 500 节点下放大成明显热点（与同函数里 `needs_anchor` 同一条理由）。
- ⚠️ **取锁顺序**：`table_full` 预检量完长度就**放掉 `peers` 锁**，然后才去问 `db`，最后回到插入。
  持着 `peers` 守卫去问库，违反的本仓那条"peers 与 db 不嵌套"正是 §4.1 里机器扫过的锁序，
  也是 J2 那一族自死锁的形状。
- **读失败的方向**（按代价定，不是随手 `unwrap_or_default`）：`protected_peer_ids` 返回 `Option`，
  两张身份表读不动时**一个都不许淘汰** —— 折叠成空集等于把"查不到谁该保护"当成"谁都不需要保护"，
  那正好把好友挤掉。这种情况与"表里全是受保护条目"共用一个出口：放弃这一条 +
  `code=PEERS_TABLE_FULL`，日志里 `reason=` 把两种成因分开说。
- 判据：`peer_eviction_picks_the_stalest_entry` 加两格（最旧那条是受保护身份 ⇒ 让位给次旧的陌生人；
  全都受保护 ⇒ `None`）。变异（摘掉 `peer_to_evict` 里那条 `filter`）当场红并点名
  「受保护的条目必须跳过，即使它是全场最旧的」，还原即绿；护栏册 **280 → 281**（这条注册成 Case）。

### 4.0i DUP-08（头像 13 份副本、圆角 3 种）：收成一个家，顺带挖出一个真缺陷

`ui/AvatarBox.vue` 现在是头像框唯一的家：盒子形状、"有图显示图 / 没图显示默认脸"、底色与 emoji 同源、
圆角档位（`token` / `full` / `none` 三档，默认 = 全站那一档）。尺寸仍由调用点用 class 给（层级关系，
写死会逼调用点再套一层壳）；`MessageAvatar` 那种必须说话算数的尺寸走内联 `size`（理由沿用它原来那段：
两个尺寸 class 同时挂上时生效的是 Tailwind 里排后面的那个）。

- **搬家凭据**：`class="gosslan-avatar-box"` 在 `src/**` 里现数只剩 `ui/AvatarBox.vue` 一处（新判据
  带正控：往真组件模板里塞一份盒子必须被读出来）；调用点数组（`<AvatarBox`）≥12 才不算"家有没人接"。
- **两条既有判据跟着搬家改了口径，不是放宽**（这是它们该做的事）：
  ① 「src 下所有默认头像都对读屏隐藏」原先靠"字母头像有十几处"防空转 ⇒ 改成钉"那个家自己带
     `aria-hidden`" + "≥12 个调用点真在用它"（比原来更强：既守 a11y 又守接线）；
  ② 「`components/message` 下每条 `<img>` 都带两个 hint」的扫描集**显式收进** `ui/AvatarBox.vue` ——
     那条 `<img>` 原先就住在这条尺子扫过的目录里，不收进来就是搬家把覆盖面悄悄削掉一圈。
- ⚠️ **统一带 `text-white`**：原先 `MessageAvatar` 那一处没有它。emoji 是彩色字形，文字色对它不生效；
  这一条如实写下，不当成零扰动。

**顺手挖出来的真缺陷（不是美观问题）**：`RemindAudienceDialog.vue` 写的是
`<SelfAvatar :src="…" :size="36" />` —— `SelfAvatar` 只有 `previewSrc` 一个 prop（它的数据源固定是
**本机自己**）。于是 ① 没有尺寸类 ⇒ 盒子塌成零尺寸，那一列候选人**根本没有头像**；② 就算有尺寸，
每个人的脸都会画成本机自己。现改成 `<AvatarBox class="h-9 w-9 shrink-0" :id="id" :src="…" />`。

### 4.0j P16 的第二半：**落库那一侧**的「failed 太粗」——`messages.fail_code`（**已修**，DB v14→v15）

§4.0i 之后同一格的延伸：负责人问「法条那句 `禁止 Err → failed` 要不要当真」，先量影响面再定档，
最后选定**加一列而不是加档位**。量的东西（现算，不凭印象）：

- **档位方案要动的地方**：`messages.status` 今天的取值集合有 9 档（`sent`/`sending`/`delivered`/`read`/
  `recalled`/`failed`/`cancelled`/`partial_cancelled`/`unknown`），而"哪一档能盖哪一档"这条规则
  **不止一个消费者** —— 后端 `set_message_status` 的 `NOT IN` 硬终态名单、`requeue_message_for_resend`
  的可复活名单、群侧 `status NOT IN ('recalled','read')` 那份**不同**的名单、清扫器与孤儿恢复的谓词、
  前端 `furthestStatus` / `promoteOnPeerRead` / `MessageItem` 的着色与 `designGuards` 里那条
  「read/failed/recalled 三档」的形状判据。加一档 ⇒ 这几处逐个表态，漏一处就是一个静默的档位漏洞。
- **加列方案要动的地方**：`MIGRATIONS` 末尾一格 + `SCHEMA` 一行 + `MessageRecord` 一个字段
  （编译器现数 **35 处构造点、22 个文件**，全是 `fail_code: None`）+ 4 个 SELECT 列表（每个都带一份
  独立的行映射，漏一个就是那条路径读不回原因）+ 4 处写 `failed` 的 SQL 各带自己的码。
  ⇒ 影响面**由编译器与判据数**，不由印象数（这一条也是选它的决定性理由）。

落地口径（细节与理由都在 `docs/protocol-invariants.md` 的 INV-P16 第 ③ 条）：`status` 说结局、
`fail_code` 说原因；词表一个家（`error_codes::MESSAGE_FAIL_CODES`）、写只有两扇门
（带原因只走 `set_message_failed`，通用门推进状态时**归零**旧码）、`NULL` 是一个要说出口的状态
（不回填、文件那一族的码仍走 `file-failed` 事件）、只在 `status='failed'` 时读。

- **两处既有写序守卫跟着搬家，不是放宽**：`lib_outbox_tests::terminal_finalize_defers_the_destructive_write`
  原先在 `finalize_expired_message` 函数体里找 `set_message_status(` —— 那一格现在走
  `set_message_failed(`，锚点不改就是**在旧地址上守一个已经搬走的实现**（会静默空转）；
  同册自动扫的 `USER_FACING` 名单也补进新门，否则"带原因的终态写"成了一条不受写序守卫的通道。
- **三条既有判据自己抓出了改动**（这正是它们该做的事，不是意外）：`v10_to_v11…` 那条手抄形状当场
  报"SCHEMA 改过了，这里要一起改"；`offline_queue_tests` 那份手写最小 DDL 报 `no such column: fail_code`
  ⇒ 补列后**顺手把"码真的落库"升级成断言**（原先只断言状态），并带上"没被改写的行不许凭空长出原因"
  的反向对照。
- ⚠️ **本轮明确不做的**：文件气泡（`file-{id}` / `gfile-{id}`）的失败仍不写这一列 —— 它的原因今天是
  自由文本（`REASON_*` 那几条中文串），只有 `DISK_FULL` 这一族有稳定码，而那份码已经有自己的通道
  （`file-failed` 事件 + `fileFailReason.ts` + `logging.rs::FAIL_CODE_*` 对账）。要让它在**重启之后**
  也说得出原因，得先给那一族失败配齐码 —— 另开一格，已登记在 §8 的 P2 表里（不在这里半接）。
### 4.0k §8 对账过程中挖出来的新的一格：CHANGELOG 里九处相邻重复的版本标题 ⇒ 那一版的更新说明会被读成空串（**已修 + 已补判据**）

做「把 §8 那张表按现算证据对账」这件事时，为了确认"每一版的应用内更新说明到底有没有内容"，
把 `notesForVersion` 拿来对**今天的 CHANGELOG** 逐版现跑：

```bash
node --experimental-strip-types -e '
  import("./scripts/updater-manifest.mjs").then(m=>{const c=require("fs").readFileSync("CHANGELOG.md","utf8");
  for(const v of ["5.15.5","5.15.6","5.15.7","5.15.8","5.15.9","5.15.10","5.15.11","5.15.12","5.15.13","5.15.20"])
    console.log(v, m.notesForVersion(c,v).length)})'
```

- **读数**：5.15.5 ～ 5.15.13 **全是 0**，5.15.20 是 1634。根因是相邻两行写着同一个
  `## [x.y.z] - 日期`：`notesForVersion` 取「第一个匹配行 → 下一个 `^## [` 行」之间的那一段，
  于是那一段长度为零 ⇒ 应用内「更新说明」为空。
- **为什么没有造成用户可见损害**（这条必须一起写，不然就是把量具缺陷说成线上事故）：
  这九节里只有 v5.15.7 与 v5.15.13 真发过 tag，两份**当时**的清单现读非空 ——
  `curl -sL https://github.com/wenzo001/gosslan/releases/download/v5.15.13/latest.json`
  → notes **1484** 字；v5.15.7 → **664** 字。所以重复是**后来**编辑 CHANGELOG 时带进来的，
  不是发布当时就错。
- **为什么既有三道判据都看不见它**（这才是值得补一条的理由）：
  ① 格式判据 —— 两行都符合 `## [x.y.z] - YYYY-MM-DD`；
  ② 降序判据 —— 相等不算逆序；
  ③ 归属判据 —— 只查**当前那一版**那一节空不空。
  ⇒ 一旦哪天给老版本重生成清单（`updater-manifest.yml` 是可重跑的），就会**静默**发一个无说明的版本。
- **修法**：删掉那九行重复的（现算剩余相邻重复 = 0），并在 `semver.mjs::changelogProblems`
  补一条「相邻两行同名版本号 ⇒ 红」。判据自己带正控（`scripts/updaterManifest.test.ts`）：
  先用一份双标题的文本证明 `notesForVersion` 真返回空串（否则这条判据是在防一个不存在的危害），
  再往**真实** CHANGELOG 里复制第一份版本标题，断言恰好被点名一次。
- ⚠️ **剩下的一格：判"不改写历史"，理由是消费者不存在**（不是"来不及做"）。
  `## [4.39.2]` 有两节内容不同且**不相邻**，而这条线一挖出的是三节错位（全部现算 `git tag --contains`）：

  | 今天小节标号 | 内容 | 真正首次包含它的 tag |
  |---|---|---|
  | `4.39.2`（第一节） | 治理补齐（INV-P33、名字判据常驻化、领域图 P24–P33） | **v4.39.4** —— `a28e37e2` **不在** v4.39.2 里 |
  | `4.39.3` | Windows 大文件收尾期间窗口失灵 | **v4.39.4** —— `6514179d` **不在** v4.39.2 里，且 **v4.39.3 这个 tag 从未存在** |
  | `4.39.2`（第二节） | 加好友不再连弹 + 同版收尾（护栏锚点搬家） | **v4.39.2** ✓ 正确：`git show v4.39.2:CHANGELOG.md` 顶部那一节就是这个标题 |

  为什么这一格**判为不做**：应用内「更新说明」只取**当前版本**那一节，历史几节没有任何消费者；
  把它们并进 4.39.4 要在一个 9000 行的文件里跨节搬正文，而文档引用守卫里有按行号锚定的引用 ——
  **风险大于收益**（这正是本仓"不为没人读的东西动历史"的口径）。
  判据的处理方式相应是：**相邻重复 ⇒ 红**（会让说明变空，形状可证）；**同名非相邻 ⇒ 显式打印、不判红**，
  所以这一格不会被静默放过，也不会逼着人去改历史。若将来真要修，正确顺序是先
  `git log -S'"version": "x.y.z"' -- package.json` 把"哪笔提交提的版"与"tag 实际包含哪笔"分清楚，
  再搬正文，最后 `check-doc-citations` 复跑（它认行号）。

### 4.0l DUP-02 剩那半复核：所谓「三套文案」其实是四件不同的事实 ⇒ 判「不统一」，改成钉住这件事（**已收尾**）

§6.3 与 §8 的原话是"缺失路径的提示文案三套，各落点各写一句 toast"。逐条读实现之后的实况：

| 事实 | 钥匙 | 谁在用 | 为什么不能与别的合并 |
|---|---|---|---|
| **会话里那份**媒体被「存储清理」删了 | `msg.imageCleaned` / `msg.cleaned` | `MessageItem.vue` 图片占位、`TodoImageThumb.vue`、`mediaAvailability.PREVIEW_FAILURE_KEYS.gone` | 它是"曾经有、现在没了" |
| **收藏目录里那份副本**不在了 | `favorite.mediaGone` | `FavoritePanel.vue` 六处 toast + 一处行间后缀 | `commands/favorites.rs` 真的 `std::fs::copy` 了一份进收藏目录（`favorite_copy_name`），删收藏删的就是那份 ⇒ 与会话那份是两个文件 |
| 本机**还没同步到**那份字节 | `chat.toast.fileNotForward` / `chat.toast.imageNotForward` | `ChatWindow.vue` 单条与批量转发两个入口 | 说成"已被清理"就是假话，用户会去翻回收站；正确动作是等同步或让对方重发 |
| 收藏指向的**原消息行**已不在 | `favorite.msgGone` | `FavoritePanel.vue` | 与三份字节无关（消息行与会话记录是另一层） |

- ⚠️ **本轮我自己先犯了一次会被这张表拦住的错**：看到 `f.available = Path::new(p).is_file()` 就推断
  "收藏不另存副本，所以那句『副本』是假的"。读到 `add_favorite` 的 `std::fs::copy(&sp, &dp)` 与
  `favorite_copy_name` 才纠正 —— **一条 `is_file()` 判不出那是谁的一份文件**。这正是本仓反复的
  "机制推论要读实现"那条：否定结论（"没有副本"）差点被我写进文档并"顺手统一"掉文案。
- **收尾形态不是改文案，而是把它钉成判据**（`src/utils/mediaAvailability.test.ts` 三条）：
  ① 四把钥匙的中英文案各自必须含它那个事实的特征词（清理 / 副本 / 尚未同步 / 原消息）；
  ② 收藏那句承诺的"副本"必须由 Rust 侧 `std::fs::copy(` + `favorite_copy_name(` 兑现 ——
     哪天收藏不再复制，这句文案就成了假话，判据当场红；
  ③ 引用面不跨界：`FavoritePanel` 不许改用通用的 `msg.cleaned`，会话侧不许引 `favorite.mediaGone`。
- **注入自证**（两条都跑过、还原后 `cmp` 逐字节一致）：把 `favorite.mediaGone` 的中文改成通用的
  「内容已被清理」⇒ 第 ① 条红；往 `MessageItem.vue` 里塞一个 `t("favorite.mediaGone")` ⇒ 第 ③ 条红。
  第 ② 条带内联反控（拿一段没有 `fs::copy` 的文本走同一把尺子必须认不出）。

### 4.0m DUP-03 逐处定性：九份墙上时钟里**没有一份是"本该不同"**（已收成一家）

先做定性再动手（负责人点名"先逐处读"）。九处定义、三件事各不同：

> **表里的行号是改动前那一版（提交 `13d77e36`，即 5.15.25）的位置** —— 这七行点的就是"被删掉的那份拷贝"，
> 所以在今天的工作树里已经不存在了，别照着去找。复跑：
> `git show 13d77e36:src-tauri/src/network/discovery.rs | grep -n "fn now_ms"`。
> 本批之后仍在的只有两处：`logging.rs` 的家（当前 1396 行）和 `db/read_receipts.rs` 的别名（当前 71 行）。

| 定义处 | 时钟源 | 兜底写法 | 调用点 | 定性 |
|---|---|---|---|---|
| `logging.rs:1385` | SystemTime − UNIX_EPOCH 毫秒 | `unwrap_or(0)` | 日志内部 + 看门狗 | **定为家** |
| `db/read_receipts.rs:66` | 同上 | `unwrap_or(0)` | **现数 120 处 / 43 个生产码文件**经 `db::now_ms`（复跑 `grep -rn "db::now_ms(" src-tauri/src \| grep -v _tests.rs \| wc -l`） | **留作具名别名**：它承载"落库那一列的时间戳"的说法 |
| `watchdog.rs:140` | 已是转调 | — | 6 | **本来就委托家**，带注释理由 |
| `mesh/gossip_replay.rs:26` | 同上 | **`unwrap_or_default()`** | `gossip.rs` 2 处（限定路径调用） | 真拷贝 |
| `transport/bluetooth_peripheral.rs:136` | 同上 | `unwrap_or(0)` | 1 | 真拷贝 |
| `transport/bluetooth_peripheral_windows.rs:376` | 同上 | 同上 | 1 | 真拷贝（Windows 腿才能编） |
| `transport/ble_android.rs:128` | 同上 | 同上 | 1 | 真拷贝（Android 腿才能编） |
| `network/discovery.rs:176` | 同上 | 同上 | 1 | 真拷贝 |
| `storage/cache_cleaner.rs:94` | 同上 | 同上 | 1 | 真拷贝 |

- **否证的一条**：我原先（以及 §8 第 14 行原话）怀疑"BLE 那几份可能刻意用单调钟"。逐处读完：三处
  全是墙上钟，`ble_android.rs` 与 windows 侧的注释还写着"与 macOS 侧同一套回收语义"⇒ **没有一份是设计如此**。
  `cache_cleaner.rs:239` 那处 `UNIX_EPOCH` 是给临时目录名取 `subsec_nanos()` 当唯一种子，与"现在几点"无关，
  不算拷贝（这也是判据为什么按"定义 `fn now_ms(` + 读 `UNIX_EPOCH`"两条件合取，而不是只看 `UNIX_EPOCH`）。
- **家为什么在 `logging` 而不是 `db`**：`lib_window_tests` 的棘轮把命令体里出现 `db::` 算成"访问 SQLite"
  （INV-P34 那一族的分母口径），家设在 `db::` 会把蓝牙、发现层、看门狗全算成重活命令。
- **判据**：`logging::tests::the_wall_clock_has_two_names_max` 扫全仓 `.rs` —— 定义 `fn now_ms(` 的文件
  只许 `{logging.rs, db/read_receipts.rs}` 两个，且**读 `UNIX_EPOCH` 的只许 `logging.rs`**（别名必须转调）。
  扫描集合有下限断言（>100 个文件），同册 `the_wall_clock_matcher_catches_a_new_copy` 是正控
  （新拷贝、"别名自己读钟"都要认得出，"调用家"不许误判）。遍历器与 §4.0k 的 hex 判据**共用同一个**
  （`logging::production_rs_files`），不另抄第四份。
- **护栏 Case** 285 → **286**（往 `discovery.rs` 注入一个 `fn now_ms()` ⇒ 判据点名三个文件并红，恢复逐字节一致）。
  - ⚠️ **这条 Case 在 5.15.26 当场是绿的，夜间整跑却红了**（run 40972871145，sha `7564472a`，
    `护栏非空转 · cargo 通道（分片 1/3）`）：注入后确实红，但红的是
    `error[E0255]: the name now_ms is defined multiple times`，输出里**没有**声明的那句判据关键词。
    根因是**同一批的另一处改动改了注入落点这个文件的编译上下文** —— 为了让跨域依赖回到判据看得见的地方，
    我把顶层 `use crate::logging::now_ms;` 加进了 `discovery.rs`，于是"再定义一个同名函数"
    从"能编译、只有形状会红"变成"根本编译不过"。⇒ 5.15.28 把注入落点换到 `storage/cache_cleaner.rs`
    （它调家用的是限定路径内联写法、本文件没有同名 import，且自己已 `use std::time::UNIX_EPOCH`
    ⇒ 两条断言都命中，先报「名字多了一个」那句）。复跑 `--only="墙上时钟又长出一个名字"` 退 0。
  - **这条的教训不是"注入串要能编译"（那条早已在册）**，而是：**"能编译"不是注入串的永久性质** ——
    锚点文件被别的改动动过（这里是被加了同名 import）就会失效，而快速层结构上看不见它
    （本地 `verify:local` 按 `--skip-guard-sweep` 跳过整跑、push 那条腿也不跑全扫描）。
    所以：**动过某个 `.rs` 的顶层 import 时，落在它上面的 Case 必须重新跑一次**，
    而夜间那条通道是这类"只有整跑才看得见"的缺陷的唯一现存防线。
- **本批自己撞掉过一条护栏的锚点 —— 第 13 步当场抓住**：`panic 站点棘轮` 那条注入用例原先把 `panic!`
  注进 `watchdog.rs` 的 `now_ms` 开头，而这一批删的正是那个只做转发的包装 ⇒ `verify:local` 第 13 步报
  「注入锚点在 `watchdog.rs` 及其 0 个 include! 子模块里**都找不到**」并 fail-fast（后面 12 步、含全部编译与
  测试都没跑）。锚点已换到 `logging.rs` 的 `pub(crate) fn now_ms() -> i64 {`（现数该字面串在该文件里恰好 1 次，
  注入器要求"唯一"才动手）。换到这里不是随手挑的：**这条线本身被上面那条判据钉着**（全仓唯一读 `UNIX_EPOCH`
  的 `now_ms` 定义），锚点不会第三次悄悄漂掉。复跑自证 `python3 scripts/verify-guards.py --only="panic 站点棘轮"`
  退 0（改坏即 FAIL、红由"棘轮只许降"报出、恢复逐字节一致）。
  ⚠️ 这是"改源码 = 改坏注入锚点"一族的第 N 次复发，但**这一回是响亮失败**（8.1s 就停），不是静默空转 ——
  正是第 13 步存在的理由。
- **同一批还长出第 7 对内联跨域引用 —— 第 16 步按棘轮把它判红了**：`network/discovery.rs` 的
  `sweep_peers` 改成内联 `crate::logging::now_ms()` 之后，`presence` 域第一次出现"指向 observability、
  但本域没有任何对应 `use`"的写法 ⇒ `check-domain-deps.mjs` 报「内联跨域引用对数 7 超过棘轮上限 6」
  （改前现数 16 处 / 6 对）。按它自己给的两条修法取了①：改成顶层 `use crate::logging::now_ms;`
  并把 `observability` 写进 `presence.consumes` —— 让这条依赖从"判据看不见"搬回"判据管得到"，
  而不是把上限调大（脚本原文："那等于把洞又变成沉默的"）。复跑 `node scripts/check-domain-deps.mjs`
  ⇒ **回到 16 处 / 6 对、退 0**。
  ⚠️ 同一个改动还牵出一份**没有机器凭据的手抄快照**：`docs/ARCHITECTURE-MAP.html` 里 presence 那一行也有
  `cons` 字段，而 `check-domain-map.mjs` **只读 `docs/domains.data.mjs`、根本不看这份 HTML**（2026-10-29 现读：
  脚本里没有 `cons`/`consumes` 字样）⇒ 两边只靠人同步，这里已同改并在 `notes` 里写明"改那边必须改这里"。
- **分格取证（一条被我自己写错后又改回来）**：
  - ✅ `ble_android.rs` **有本机编译凭据** —— 门禁第 25 步 `cargo check --target aarch64-linux-android`
    两档（默认 feature / `--features bluetooth`）各 0 warning、PASS。本轮早先写"本机编不了、缺
    `aarch64-linux-android-clang`"是**错的**：那次是我自己手敲的命令形状在环境里过不去（而且那趟还拿管道退码
    当成 `ANDROID_EXIT=0`），门禁现成的命令形是过得去的 ⇒ 教训与既有那条"clippy 自造形状会造出 49 个红"同形：
    **要用门禁那条命令的形状去证，别用手敲的**。
  - ⚠️ `bluetooth_peripheral_windows.rs` **仍只有远程凭据**。本机两条路都真跑过，且都在**类型检查之前**
    因缺件失败 ⇒ 对该文件零证据：`cargo xwin check --target x86_64-pc-windows-msvc` 退 101
    （`tauri-winres` panic `NotAttempted("llvm-rc")`；本机现在没装 LLVM，`ls /opt/homebrew/opt/llvm/bin` 无 llvm-rc）、
    `cargo check --target x86_64-pc-windows-gnu` 退 101（`cc-rs` 找不到 `x86_64-w64-mingw32-gcc`）。
    两格的改动本身都只是"删本地 `fn now_ms` + 一处限定路径调用"，没有触碰 import。
  - ✅ **远程那条腿已经跑过并把 Windows 那格补上了**（5.15.26 push，run 40969401717）：
    `Rust 单测 / 清单（windows-latest）` 走到 `cargo test --features bluetooth --lib` 就说明整个 crate
    在 Windows 上**编过了**（含 `#[cfg(all(feature="bluetooth", target_os="windows"))]` 的
    `bluetooth_peripheral_windows.rs`），该腿 1297 通过 / 1 失败 —— 唯一失败的不是产品码，
    是**本批新加的这条判据自己带了一个平台假设**：`rel_to_src` 用 `Path::display()`，
    在 Windows 上交出 `db\read_receipts.rs`，而期望值是在 macOS 上手写的 `db/read_receipts.rs`。
    ⇒ 5.15.27 归一化修掉并加了一条不需要 Windows 就能证的正控
    （`logging::tests::rel_to_src_is_separator_independent`）。
    ⚠️ 这条的形状值得记住：**本地整跑全绿可以是真的，而"绿"覆盖不到 CI 那条腿的平台差异** ——
    凡是"扫全仓再比清单"的判据，清单元素来自路径的一律要在家里归一化分隔符。
    同一条雷在 5.15.25 的 hex 判据上没炸，只因为它期望的 `crypto.rs` 正好在 `src/` 根下不含分隔符。


### 4.0n DUP-13 逐处定性：审计写「TS 侧三份 LRU/容量闸」，现数是**两种策略九处**（已收成两个出口）

先逐处读再动手（沿用 DUP-03 的顺序：分型 → 收 → 判据）。**"三份"这个数既偏少又偏窄**：
按形状扫全 `src/**` 生产 TS/Vue 后，计数型容量闸一共九处，而且**分属两种不等价的策略**。

| 站点 | 策略 | 处置 | 定性依据 |
|---|---|---|---|
| `utils/composerDrafts.ts:16` | 丢最旧 | **收** | 本地函数就叫 `trimOldest()`，与家逐字同形；它靠"写入前 `delete` 再 `set`"自己维护顺序 |
| `utils/codeHighlight.ts:37` | 丢最旧（真 LRU） | **收** | 见下面那条**唯一需要改行为**的地方 |
| `utils/highlight.ts:43` | 丢最旧（命中即重插） | **收** | 命中分支提前 return ⇒ 与家等价 |
| `utils/messageHeight.ts:161` | 丢最旧（纯 FIFO） | **收** | 等价（读命中不重插） |
| `stores/useChatStore.ts:468` | 丢最旧（Set） | **收** | `while (size > MAX) delete 最旧` ⇒ 等价 |
| `stores/useChatStore.ts:1326` `readerIdsCache` | 满了整张清 | **收进第二个出口** | 纯缓存、可按 id 重算 |
| `utils/payloadParseCache.ts:34` | 满了整张清 | 同上 | 同上（id↔content 一一对应） |
| `utils/groupSummaryCacheCore.ts:50` | 满了整张清 | 同上 | 同上 |
| `utils/filePreview.ts:133` `negativeUntil` | 满了整张清 | 同上 | 被清掉的后果是"多试一次读"，不是丢事实 |

- **两个策略不许互换，且这条判断本身有凭据**：`trimOldest` 丢最旧、热的留着；`clearWhenFull` 全丢。
  同一张 5 条的表跑 `max=3` ⇒ 前者活 `{c,d,e}`、后者活 `{}`。用例
  「两个策略不是同一个函数：同一张表跑出来的活口不同」把这句话钉成断言，
  所以以后谁想把九处"统一成一个函数"会当场红。稳态边界也**故意差一格**：
  `trimOldest` 等值不删（`size <= max`），`clearWhenFull` 等值就动手（判在写入**前**，`size >= max`）
  —— 与这九处原本的写法逐字一致；把后者挪到写入后再判，`clear()` 会连刚写那条一起丢掉 ⇒ 缓存永远命中不了。
- **收的过程中唯一改到行为的一处**（`codeHighlight.ts` 的 `remember`）：原先"先判满删最旧、再写"，
  改成"写、再由家丢到不超上限"时必须补一句 `cache.delete(key)` —— 否则**重写同一段代码**时那个键
  还排在队头，家会先把刚写进去的这条丢掉。这个差别原先被"判在写入前"掩盖着，不是新加的语义：
  该文件本来就有"命中即移到队尾"的 LRU 意图（`peekHighlight`），补这一句才是同一件事的两半。
- **判"不是同一个东西"的五格**（不收，而且判据必须证明不冤枉它们）：
  `utils/blobLru.ts`（谓词是**累计字节数**、`drop` 带 `revoke(objectURL)` 这个唯一回收出口 ⇒ 按条数的闸表达不了）、
  `components/VirtualList.vue:253`（超上限去 `measure()` 整体重测，不是删条目）、
  `utils/messages.ts:608` `selectCachedConversations`（只"算出该留哪些"，并不拥有那个数组）、
  `utils/todos.ts:1029`（给用户看的末尾 N 行业务上限；那一行原本就写着"家只吃 Map/Set"）、
  `utils/memberName.ts:55` 与 `utils/todos.ts:278`（**我最初把这两处算进 DUP-13 是错的** —— 它们是 ID 尾号 `slice(-4)`，与容量无关）。
  ⚠️ 后者是"窄正则的命中集 ≠ 分母"这条老坑第 N 次复发：我拿一条 `slice(-|MAX_SIZE|evict` 的正则先报了"三处"，
  换成两个独立形状（`.size` 与上限比 + 同段 `clear()`/`delete(`）现数才是九处。
- **顺手修掉一处会漂的行号型引用**：`blobLru.ts` 原先用 `utils/bounded.ts:19` 指那句边界声明，
  本次给家加第二个出口后那一行下移了 ⇒ `check-doc-citations.mjs` **只看行号在不在文件行数内**，
  不会报这种腐坏。改成按句子找，并把理由写在旁边。
- **判据**（`src/utils/bounded.test.ts`，+8 条）：覆盖面下限（≥200 个生产文件、且点名看得见
  `utils/bounded.ts` / `stores/useChatStore.ts` / `utils/highlight.ts`）→ 家的两个出口各只有一个定义 →
  生产码里"手写计数闸"的集合必须是空。三条反控（家自己的反向谓词、`measure()` 那格、单条目字节数那格）
  与两条正控（两种手写形状都要认得出）写在同一条用例里。
  手工变异自证两次：往 `composerDrafts.ts` 塞回一段 while-delete ⇒ 判据点名该文件并红
  （`MUTATED_EXIT=1`，hint「又抄了一遍淘汰循环」）；往 `messageHeight.ts` 加一份
  `export function clearWhenFull` ⇒ 定义那格点名 `{bounded.ts, messageHeight.ts}` 并红；两次都 `cmp` 逐字节还原。
  护栏 Case 286 → **287**（`verify-guards.py --only="计数型容量闸"` 退 0；条数由判据 E 现算，
  文档里那一格是它报出来的，不是我抄的）。

### 4.0o DUP-06 三个渲染件的切段循环收成一个家，顺带被一条**既有判据的锚点**顶回来

- **形状**：`MentionText.vue` / `MessageTextBubble.vue` / `MessageContentModal.vue` 各有一份
  逐字相同的"先 `splitEmoji` 切表情 token、文本段再交给 `linkify`"循环。两个原语早就单源，
  **会漂的是拼起来那六行** —— 三份里 `MentionText` 那一份的表情段少带 `name` 字段
  （⇒ 下一次照抄会照着少的那份抄）。
- **家**：`src/composables/useMessageSegments.ts` —— `buildMessageSegments`（纯的一半）
  + `useMessageSegments`（`computed` + 两个 `toValue` 的薄包装，写法沿用本仓
  `useMessageFile` / `useMessageDisplay` 的 `MaybeRefOrGetter` 口径）。
  颜色/对比度/点链接的副作用**留在渲染件**：气泡按当前底色现算 @ 文字色，任务详情用固定底色
  那两条全局 class —— 收进家就会把两种做法强行统一成一种（这是本仓判过的"DUP 里不能统一的那类"）。
- **为什么这段语义只能靠渲染探针证**：`utils/emoji.ts` 用 `import.meta.glob("../assets/emojis/*")`
  取图集 ⇒ 任何经过它的链在 `node --test` 里都装不起来。我先按"别名不认"猜了一次，
  把 `@/data/emojis` 改成相对路径**实测过**（`Cannot find package '@/data'` 变成了
  `(intermediate value).glob is not a function`）—— 真凶是 Vite 专有的 glob，不是别名，
  于是**那行改动整轮还原**（不改没有收益的东西）。最终：行为由 `msgovf` 渲染段证，
  结构由 `designGuards` 的形状判据证。
- **判据**：`designGuards.ts` 新增 `findHandRolledSegmentLoops`（钉 `for (const s of splitEmoji(` 这个形状），
  配 3 条用例：合成手写循环要点名并指准行号 / 改用家之后要绿 / 全仓扫（≥200 个源文件下限）
  要求命中集合恰为 `{composables/useMessageSegments.ts}`，且三个渲染件必须
  ① 调用 `useMessageSegments(`（家有了要有人接）② 不再直接 import 那两个原语。
  护栏 Case 287 → **288**（两处注入：把 import 与循环一起注回 `MessageContentModal.vue` ⇒
  坏态本身是合法源码；期望红由「切段循环又长出第二份」报出，恢复逐字节一致）。
  渲染凭据：`check-ui-runtime.mjs --only=msgovf` **80/80 绿**（真实 Chromium DOM）。
- ⚠️ **本批改到一条既有判据的锚点，它把我顶回来了**：那条「有人@我」从输入框到气泡的接缝表里，
  第 ⑩ 格钉的是气泡文件里的字面句 `props.mentionTargets ?? null,` —— 那句话随循环搬进了家 ⇒ 假红。
  修法**不是**把锚点指到新家（那样只钉住"家里有"，不钉"气泡把输入交给了家"），
  而是把那一格**拆成两格**：`MessageTextBubble.vue` 必须含 `useMessageSegments(` ＋
  `useMessageSegments.ts` 必须含 `mentionTargets ?? null,` ⇒ 链子比原来更严。
- ⚠️ **一个新的失败形态，值得记住**：我把两行数组元素误写成以 `"},` 收尾（该是 `"],`），
  于是 `designGuards.test.ts` **整册装载失败** —— `npm test` 的总数从 1515 掉到 1276（236 条消失），
  而汇总只打一句 `fail 1`、失败项名字是文件路径而不是用例名。
  ⇒ 读数时"文件级失败"与"单条用例失败"必须分开看，**总数掉了就是量具坏了**，
  不能当成"少跑了一条"。（本次是靠总数对不上才发现的，不是靠那句 fail 1。）

### 4.0p 第 19 行的真实前置与批 A 的前半（5.15.29）：6 处中文被写进了用户可见的事件载荷

- ⚠️ **本节曾给出一条错的前置，现由证据推翻并订正**（写错的那一版随 5.15.29 提交过；
  本节留下订正，不静默改写）。我当时说「文件气泡的状态来自传输台账、不是 `messages` 行 ⇒
  `messages.fail_code` 接不上 ⇒ 批 B 必须加表列（DB v16）」。**这句是错的。**现读三条凭据：
  · `src-tauri/src/db/file_transfer.rs`（当前 `:197`）—— 1:1 那一半就是 `set_message_status(&tx, &format!(file-…), status)`；
  · 同文件（当前 `:204`）—— 群那一半同一形状（`gfile-`，取消时由这里写）；
  ⚠️ 这一小节早先写的是 `:179` / `:185`：**同一批里我给那个文件加了 `fail_code()` 就把行号顶下去了**，
  而我自己在 §4.0m 刚写下「行号型引用在两个文件之间一定会漂」。⇒ 现在改成**按符号名找、行号只作当前读数**，
  复跑口径：`grep -n "set_message_status(&tx, &format!" src-tauri/src/db/file_transfer.rs`
  · `src-tauri/src/db/cascade_tests.rs:809` —— `SELECT status FROM messages WHERE msg_id = 'gfile-t5'`，
    既有判据本来就按「`gfile-<tid>` 是 `messages` 行」断言。
  ⇒ 两族文件气泡**都是 `messages` 行**，`msg_id` 只是长成 `file-<tid>` / `gfile-<tid>` 的样子；
  5.15.22 的 `fail_code` 列与 `set_message_failed()` 正是它们该走的那扇门。
  **批 B 的真实形状**：给 `finalize_file_failure(...)` 带一个 `fail_code` 参数、群路径同写一码，
  **不需要迁移、不需要新列**。
  ⚠️ 为什么会写错：我把「状态的另一份真相在 `file_transfers` / `group_file_recipients` 里」
  （这句是对的：进度与逐收件人状态确实在那）误读成「气泡不是消息行」—— 台账行与气泡行是
  **同时存在的两样东西**，我只看到了前者。教训：凡声明「X 不是 Y，所以要走 Z 通道」，
  必须先把 X 的**写入语句**读出来；`grep set_message_status` 一条就够，
  成本远低于一次错的前置声明（而错的前置会直接决定下一批人做什么）。
- **配码这一半里挖出的真实缺陷比原描述更具体**：按形状扫 `FileFailedInfo` 的构造点，
  **6 处把中文写进了事件载荷**（`outbox_sweep.rs` ×2、`relay_file.rs` ×3、`network/transport.rs` ×1）。
  前端对未知 reason 是**原样上屏**（刻意回落）⇒ 英文界面这六格是中文。5.15.29 全部换成码 + 中英词典各一条。
- **两条一等结论（不修也是结论）**：
  ① 群文件那 6 条 `REASON_*` **不配码** —— `is_stable_fail_code` 让中文原因不发 `file-failed`，
  断链时才不会每个在途传输弹一次 toast；给它们配码会当场点亮这个弹屏条件。它们要等批 B 才有第一个读者。
  ② `handle_share.rs` 的 `reason` 是**变量**，值来自文件层的中文字符串错误（`receive.rs:1497` 等，
  且 `file_tests.rs:890` 把它当契约断言）⇒ 静态判据看不见，属 A2，本批没做。
  → **已在 5.15.37 / 5.15.38 收口**（§4.0u / §4.0v）：接收侧不再把 Debug / OS 原文当载荷，发送侧 `relay_push` 整族配码。
- **判据**：`fileFailReason.test.ts` 新增一条形状扫描（`FileFailedInfo` 构造点里的 `reason:` 字面量必须
  是大写/数字/下划线形状），带**构造点数下限 ≥3**、一条正控（合成中文载荷必被抓）、
  两条反控（发码写法与**日志里的中文**都不许被判——日志本来就该写人话）。
  它第一次跑出来的读数就是那 5 处真缺陷 ⇒ "改之前就观测到它会红"，比事后注入自证更硬。
  既有那条"后端 `FAIL_CODE_*` ↔ 前端码表"的对账分母是从源码现解析的，所以加 6 个码它当场要求补 6 行。

### 4.0q 第 19 行·批 B 的前半（5.15.31）：原因码写进气泡行，界面无改动就开始说人话

订正完前置的下一刀就变小了：`file-<tid>` 是 `messages` 行 ⇒ 落库走 5.15.22 现成那扇门，
**不加列、不迁移**。三条值得记的形状判断：

- **码从终态推，不新增参数**：`FileJobEnd`（`Expired` / `GiveUp` / `Cancelled`）已经是"为什么收尾"的
  唯一表达；再加一个 `fail_code: Option<&str>` 参数就允许了第三种说法（终态说 Expired、码说 GiveUp），
  那是本仓判过的"一个数值当两件事用"同族。签名不变 ⇒ 六处既有调用点（含三处测试）一行没动。
- **取消留 `NULL` 是一等断言**：`NULL` 本身是一个状态（INV-P16 ③）。新用例先断"这一格终态真落地了"
  再断码 —— 否则"读回来是 NULL"可能只是**压根没写**，那是这条判据最容易的假绿形状。
  变异自证：把 `Expired` 的映射改成 `None` ⇒ `left: None / right: Some("FILE_SEND_EXPIRED")` 红。
- **一个码只有一个出处**：`FILE_SEND_EXPIRED` / `FILE_SEND_GIVEUP` 从事件族的家（`logging.rs::FAIL_CODE_*`）
  搬进落库族的家（`error_codes.rs::MESSAGE_FAIL_CODES`），事件载荷与库里那一列引用**同一个常量**，
  于是"当场显示 A、重启后读回来是 B"这类分叉在结构上不可能发生。另外四条中继/完整性码
  目前**只上屏不落库**，所以留在 `logging.rs` —— 搬一个没人写进库的码进落库词表，
  等于让 `MESSAGE_FAIL_CODES` 声称一件还没发生的事。
- **界面那一侧是免费的**：`useMessageDisplay` 的 failed 分支本来就读 `message.fail_code` 查表，
  与消息种类无关 ⇒ 文件气泡自动开始说人话并且**重启后仍说得出**。前置搞对，省掉的是一整段渲染层的活。

### 4.0r 第 19 行·批 B2（5.15.32）：群文件配码，代价是必须拆一个一句话兼两职的判据

`is_stable_fail_code` 用形状（大写/数字/下划线）同时回答两个问题：「这是不是一条真失败」与
「这条要不要打扰用户」。在只有一类码（`DISK_FULL`）的年代两者重合；把群文件那 6 条中文原因转成码之后
重合就破了 —— 形状判据会让它们全部弹 toast，而 `queue_policy.rs` 的断链收尾是**逐个**收件人循环，
一次断链能弹一串。所以本批真正的改动不是"加 6 个码"，是把那一格拆成
`should_notify_group_failure`（显式名单，当前只有 `DISK_FULL` ⇒ 与改前逐格一致）。

顺带两条在册的形状：① 日志要人话、界面要跟系统语言 ⇒ 同一个码两处出口，
日志那份中文做成表并由用例钉住（漏一格就是裸码，且不会编译错）；
② 用例改名会让清单守卫报"静默消失"，而 `--update`/`--sync-baselines` **只增不删** ⇒
旧名要手工清；⚠️ 本段原来还写着「本轮 windows 腿就还留着」——**那句没核实过**，
现读两腿都是 0 命中（`git show 3c7956e5:src-tauri/test-baseline.windows.txt | grep -c only_stable_fail_codes_reach_the_user`），
订正见 5.15.34。

诚实边界：群文件"失败 ⇒ 气泡行带码"这最后一步没有集成测试（要 `AppState`），
依赖的是同一扇门 `set_message_failed`（5.15.22/5.15.31 已测）；真机与跨进程本轮未跑。

### 4.0s 第 19 行·A2（5.15.35）：接收收尾那四格配码，代价是照出两处被散文藏住的**真缺陷**

审计原文只说「文件层动态错误串配稳定码（`receive.rs:1497` 等）」。做完才知道这一格底下压着两处缺陷 ——
它们不是「文案不好看」，是**说错事**与**界面不动**：

1. **群收尾失败那一格把原因硬写成「对端失联」**（`Some(REASON_PEER_UNLINKED)`）。四个终态出口
   （没收完 / 哈希不符 / `sync_all` 失败 / 占名失败）都从这一格出去，而 `finish_group_receive_into`
   给的是**中文散文** ⇒ 调用方拿不到能用的值，就随手填了一个现成的码。用户看到的是一句**另一件事**，
   真原因（「要对方重发」还是「本机盘的问题」）被抹掉。修法不是改那一句字面量，是让返回值先变成码，
   再走 `persistable_group_fail_code` 那道在册闸 —— 不在册的动态串（阻塞池被中断那种）写 NULL。
2. **同一格落了库却不 emit**：`set_gfile_bubble_status` 只写库，前端只在收到终态事件时才动那一条气泡
   ⇒ 收件人这边永远显示「发送中」，要重开会话才看得见失败。这与 10-22 审计 R-02 是同一个症状的**第二个家**
   （`finalize_failed_group_receive` 早就补了 `message-status-changed`，收尾这一格漏了）。
   复用已线那一帧（载荷就是 msg_id 字符串），不新增协议消息类型。

码的形状有两条决定值得记：
- `FILE_INTEGRITY_FAILED` **从 `logging.rs` 搬到 `error_codes.rs`**（并进 `MESSAGE_FAIL_CODES`，12 → 16）。
  中继收的与直连收的是同一个事实，两处各定一条常量就是等着分叉；搬过来它还顺手获得「重启后仍在」
  （原先只活在事件里）。
- 三个新码**不带 `GROUP_` 前缀**：这四格判的是「这一份内容收没收成」，1:1 与群共用同一份判据
  （`finish_receiver_into` 与 `finish_group_receive_into` 各写一遍同一个决定），不是「这一格收件人」。
  反面是群文件那六格 `GROUP_FILE_*` 确实只代表那一个收件人的这一单。
- 群侧 `sync_all` / 占名那两格以前写成 `is_err()` / `Err(_)`，**把错误值丢了** ⇒ 分诊不出盘满；
  本批改成拿住 `e` 再走 `classify_write_failure`（与 1:1 那一份同一判定）。
- 日志里那句 `code=SHA_MISMATCH` 与载荷的码**不同名**（全仓只有它自己一处，无消费者）⇒ 统一成在册码，
  否则 grep 一边找不到另一边。

量具这一侧三条：新增「接收收尾的终态出口发码，不发散文与 OS 原文」（按函数体取形状，内联正控：
把一格换回散文必须恰好点名那一句）；新增接线判据 `group_finalize_failure_reports_real_reason_and_moves_the_bubble`
（钉在册闸 / 不许硬写失联 / 必须 emit，带摘掉 emit 的反控）；
`every_group_file_code_has_a_log_label` 的分母从**手抄六个 `REASON_*`** 换成从 `MESSAGE_FAIL_CODES` 现读
+ 下限 + 正控 —— 手抄那份只会跟着「写代码的人当时想到的」走，方向反过来才是守卫。

⚠️ 一条找分母的方法论教训：我第一轮用**整串中文**去 grep「谁在读这句话」，漏掉两条
`assert!(err.contains(完整性))` / `contains(未完成)` 的**子串式**断言 —— 是 `cargo test` 把它们报出来的
（2 红）。**「找读者」不能只数完整字面量**；子串断言本身就是弱的（换成码之后它们连「读的是哪一句」都不说），
一并改成按码相等。

还剩的（登记，不算本批）：分片路径与 begin/resume 那几家仍是散文（`文件分片顺序错误` /
`文件传输来源不匹配` / `文件过大，无法安全保存` / `续传前缀不存在`…，经 `handle_file.rs:422` 的
`fail_receive(.., &e)` 上屏）；`relay_push.rs` 那一族与 `relay_file.rs` 的 `format!("{breach:?}")`
（枚举 Debug 当契约：改个变体名就漂）仍在事件载荷里发动态文本。分母现读：
`grep -rn '"file-failed"' src-tauri/src` = 19 行 ⇒ **16 个构造点** + 2 行测试 + 1 行注释。
按载荷分：**6 处直接写码**（`FILE_SEND_EXPIRED` / `FILE_SEND_GIVEUP` / 中继那三条 + `FILE_INTEGRITY_FAILED`
+ `FILE_RELAY_STALLED`）、**8 处转发上游给的变量**（接收收尾这一族本批已变成码；分片/begin/resume 那几家
经 `handle_file.rs:422` 的 `fail_receive(.., &e)` 上屏的仍是散文）、**2 处仍当场拼动态文本**
（`relay_file.rs:73` 的 `format!("{breach:?}")` 与 `:263` 的「中继分片形状不合法：{reason}」）。
⚠️ 复跑命令里那个模式**必须加引号**：`--include=*.rs` 这种裸 glob 在 zsh 下会先被吞掉而整条命令不跑，
屏幕上留下一句"数出 19 行"其实什么都没测。

### 4.0t 第 19 行·A2b（5.15.36）：1:1 接收侧那七格配码，外加一条「哪两格**不许**配码」的凭据

§4.0s 末尾登记的「分片路径与 begin/resume」，做完之后**只剩 begin/resume 没做** —— 因为它们根本不上屏：
`begin_receive` / `resume_receive` 的 Err 走 `handle_file.rs` 的 `FileReject` 帧 + 一句日志
（`接收文件初始化失败: {e}`），而 `FileReject` 的载荷只有 `{transfer_id, received}` 两个字段、
**不带原因文本**。⇒ 那一族散文（`文件过大，无法安全保存` / `文件名非法` / `续传前缀不存在` /
`前缀已超过 24h 续传窗口`…）的读者是排查日志的人，中文在那儿是**对的**，配码反而是给没人读的东西造契约。
**这就是「先数读者再动手」省下的那一半工作量。**

真上屏的七格（返回值经 `fail_receive(state, .., &e)` 进 `file-failed`）：
分片跳号 / 分片解密失败 / 分片超出声明 / 分片写盘失败（非盘满那一支以前发 `io::Error` 原文）/
分片序号溢出 / 阻塞池任务被丢（以前发 `format!(文件分片处理任务被线程池中断: {e})`）/
以及两处**调用点上的字面量**实参（1:1 清扫器 `接收超时：对端久未继续发送`、断链 `对端连接已断开`）。

三条值得记的形状：
- **家为什么在 `logging.rs` 而不是 `error_codes.rs`**：收件方那条 `file-<tid>` 气泡行是**落盘成功之后**
  才插的（现读 `transport/handle_file.rs` 里成功分支那句 `msg_id: format!("file-{transfer_id}")`）
  ⇒ 收失败的单没有行可写 ⇒ 原因只能当场说。把 1:1 的接收码放进 `MESSAGE_FAIL_CODES`
  就是让那张「能落库」的表声称一件 1:1 路径做不到的事（与 §4.0p 那条假前置同一个方向的错）。
- **有两格刻意不配码**：`未知传输` 与 `文件传输来源不匹配` 走 `fail_receive` 的 `return false`
  ⇒ 不 emit，是内部控制的返回值。给它们配码 = 造一条没人写的死契约。
  前端的豁免因此必须带**凭据**：`fail_receive_stays_silent_for_unknown_and_mismatched_transfer`
  数 `return false` 的处数（恰好 2）并判本函数体内不出现 `.emit(`
  ⇒ 以后新加一支「静默 false」，豁免名单不动就会被两条判据一起抓住。
- **豁免 ≠ 注释**：我第一版形状判据把 `来源不匹配` 一起抓红了 —— 那不是判据坏，是我没把
  「为什么可以不管」写成判据。凭据补齐之后豁免才成立。

还剩（A2c）：`relay_push.rs` 那一族（经 `handle_share.rs` 的 `reason` 透传上屏）与
`relay_file.rs` 的 `format!("{breach:?}")`（**枚举 Debug 当契约**：改变体名就静默漂走）。

### 4.0u 第 19 行·A2c-接收侧（5.15.37）：枚举 Debug / 内部串 / OS 原文不再当载荷

`transport/relay_file.rs` 那四格比"中文散文"更糟的一档：**动态文本**。
`format!("{breach:?}")` 是枚举的 `Debug`（英文标识符，且改变体名就静默漂）、
`format!("中继分片形状不合法：{reason}")` 混了散文与变量、哈希/落盘两格是
`format!("… 被线程池中断: {e}")` 内部串、`move_received_file` 三处出口直接把 `io::Error` 原文
（`create_dir_all` / 改名 / 跨卷 copy）当返回值，而调用方**原样 emit**。

- 四个新码（事件族）。命名上的两个决定：① `RECV_QUOTA_EXCEEDED` **沿用日志里已有的 token**
  （`admit_inbound` 自己就写 `code=RECV_QUOTA_EXCEEDED kind=…`）——同一件事不另起名，
  `kind` 从载荷挪进日志；② 哈希那格的两种失败**分开**（`JoinError` = 阻塞池丢了 vs
  `io::Error` = 本机读不出 `.part`），以前拼成同一句内部串，归因上根本分不开。
- `move_received_file` 的三处 Err 改成先 `classify_write_failure`（盘满 ⇒ `DISK_FULL`，
  它才有"清出空间后重试"那句可行动文案），再落 `FILE_RECEIVE_PLACE_FAILED` /
  `FILE_RECEIVE_WRITE_FAILED`；OS 原文只进日志。
- **一条既有判据的锚点跟着改了**：`lib_relay_data_tests.rs` 那条钉「哈希必须 await、
  不许丢 JoinHandle」的用例原来锚在 `.await.unwrap_or_else(`；改码后形状是 `.await.map_err(`。
  **意图一字没动**（仍然锚在 `.await` 上 —— 丢 JoinHandle 就等于慢活照跑、状态机永不推进），
  但它是本轮第二次"改源码 ⇒ 改量具锚点"：这类改动**必须当场重跑那条判据**，
  否则下一次红会指向一个已经不存在的原因。

还剩（A2c-发送侧）：`relay_push.rs` 那十个 Err（「只能发送普通文件」/「没有可达的中继邻居」/
「中继链路中断：第 N 片」/「无法获取对方公钥」…）经 `handle_share.rs` 的 `reason` 透传上屏。
⚠️ 其中**「用户取消发送」不是失败**：`lib_file_tests.rs` 那条守卫一直在防"把取消写成假原因"，
而 `handle_share` 现在对任何 `Err` 都发 `file-failed` ⇒ 取消在那条路上会显示成"文件失败"。
这一格要先判语义（取消该不该走失败帧），再谈配码 —— 所以本批刻意只做接收侧。

### 4.0v 第 19 行·A2c-发送侧（5.15.38）：中继推送整族配码 + 取消不再被当成失败（第 19 行闭环）

`file/relay_push.rs` 的十二个 Err 经 `handle_share.rs` 原样上屏。十一条码（`FILE_SEND_*`）把
秒数/第几片/上限值/OS 原文全挪进日志。这里顺带修了一条**语义**问题，不是文案问题：

`handle_share` 以前对**任何** Err 都发 `file-failed`。而 `relay_push` 的 cancel 槽是**真实可达**的
（共享目录推送在整份哈希**之前**就 `install_cancel_slot`，每片开始前 `cancel_requested`）——
于是用户点取消之后，那条刚被取消的传输会再收到一条"文件失败"：界面把「我取消的」显示成「失败了」。
现在先按**码**认出 `FILE_SEND_CANCELLED`，是它就不发失败帧（取消自己有终态与气泡，
既有守卫 `guards:用户取消不得记成失败` 防的正是这个形状）。**判据看码不看文案**。

量具：新增「中继发送侧发码，且取消不许被当成失败发帧」（两条独立形状 + 两个内联正控：
把一处改回中文散文、把 `if !cancelled {` 拆回无条件块，尺子各自必须红）。
⚠️ 另一条教训：第一版把两个事实写成一个跨 logger 的大窗口（400 字符），实际间隔 464
⇒ **判据一开始就红**，而红的原因是窗口太短、不是代码错。改成两条独立形状后不再依赖排版长度。

两条既有源码守卫的探针跟着改（**意图都没动**）：`发送前哈希必须 await`（`.unwrap_or_else(` →
`.map_err(`）；`0 个邻居接住 ⇒ 失败`（return 前多了一句日志，旧探针 `.await==0{returnErr(` 不再成立，
改成 `.await==0{` 恰好两处 + 两个「没邻居」的码各被 return 一次 —— 比原来更严，还钉住归因不被合并）。

**⚠️ 上一批在这里写了「第 19 行到此闭环」——5.15.40 的发版前双轴 review 推翻了它（见 §4.0y），以下那段是当时的说法，保留作记录**：事件载荷一族（`logging.rs::FAIL_CODE_*`，19 条）、落库一族
（`error_codes::MESSAGE_FAIL_CODES`，16 格）与两侧词典/表全部同源；
剩下的自由文本只有**不上屏**的那两类（begin/resume 的 `FileReject` 只有日志读者、
`fail_receive` 两条 `return false` 的内部返回值）—— 这两类的"不配码"结论各自有判据背书（§4.0t）。

### 4.0w STB-03 复核（2026-10-30）：锁里压的到底是什么 —— 先量，别先重构

审计原文：「`file_receivers` 是进程级全局锁，每片写盘期间整表阻塞 ⇒ 并发传输互相拖累，
**可能被误判超时**（`FILE_RECEIVE_IDLE_ABORT_MS = 5 min`）」。按"先数读者/先量危害"复核：

**锁里压着什么（现读源码，两处）**
- `network/file/receive.rs::write_chunk`：锁住 `file_receivers` 之后做 **一片**（`FILE_CHUNK = 256 KiB`）
  的 `crypto::open_symmetric`（AEAD 解密）+ `hasher.update`（SHA-256）+ `write_all`。
- `network/transport/group_file.rs::write_group_chunk_blocking`：群侧同一形状，用的是
  `group_file_receivers` 那把（**独立的第二把锁**，单聊与群互不阻塞），整段已在 `spawn_blocking` 里。

**不在锁里的（同样是现读，逐个确认过）**
- 续传前缀的整份哈希（`resume_receive` 里那段 `read` 循环）在**取锁外**先算完；
- 收尾的 `sync_all` + 改名：接收器先被 `remove` 出表，慢活拿的是**所有权**，不持表锁；
- 配额/占用那几处只做 `keys()` / 求和（微秒级）。

**代价的算术 —— 已实测，不是估的**（量具 `file_tests.rs::stb03_receiver_critical_section_cost`，
`#[ignore]` 不进门禁；复跑 `cd src-tauri && cargo test --release --lib --features bluetooth -- --ignored stb03 --nocapture`）：

| 构建 | 一片（256 KiB 解密+哈希+写） | 单条聚合上限 | 两条并发聚合 |
|---|---|---|---|
| debug | 24.68 ms | 10.1 MB/s | 10.2 MB/s |
| **release（发出去的那个）** | **1.872 ms** | **133.5 MB/s** | **136.9 MB/s** |

两条关键读法：① **并发不涨**（10.2 / 136.9 ≈ 单条）—— 串行段的定义使然，锁确实把并发压成一条；
② release 下这条线是 **~135 MB/s/表**，而 1 GbE 的理论上限是 ~118 MB/s ⇒ **普通千兆局域网根本到不了这条线**，
它只在 2.5GbE / Wi-Fi 6/7 这类链路上才会成为瓶颈。
**「5 分钟误判超时」不可达**：临界区是 1.9 ms 量级，攒不出 5 分钟的饿死。⇒ 审计那句「可能被误判超时」**不成立**。

**要做就得动的形状**：把表值改成 `Arc<Mutex<FileReceiver>>`（表锁只管 查/插/删，慢活在条目锁里）。
现数：`file_receivers` **39 处**、`group_file_receivers` **31 处**（含测试 12 处）/ 12 个文件。
`take_*` 那几族"判据与摘表同一次持锁"的语义**不受影响**（它们只做表操作）；
风险在锁序（表 → 条目，绝不能反过来）与清扫循环要逐条取锁。**只有跨进程 E2E 能证吞吐**
（三实例 harness 已有）。

**结论（2026-10-30 先量再定 → 量完判不修）**：release 下 135 MB/s 这条线高于千兆局域网
的实际带宽，重构 12 个文件 / 70 处引用换不来**可测**的收益，而风险落在「判据与摘表同一次持锁」那几族上
⇒ **本轮判不修**。保留两件事（5.15.48 把其中第一件升级成门）：
- 量具留在树里（`#[ignore]`，计时读数随机器漂、做不成门），**同时**新增一条非 ignored 的结构判据
  `receiver_lock_holds_only_one_chunk_worth_of_work`：锁段里只许有一片的活、不许有整份级的活
  （`sync_all`/`sha256_file_hex`/`std::fs::read`/`remove_file`）——外部变异塞一句 `sync_all` 当场红；
- 若真要动，形状已定：表值改 `Arc<Mutex<FileReceiver>>`（表锁只管查/插/删，慢活进条目锁），
  `take_*` 那几族语义不受影响，锁序只许「表 → 条目」。

### 4.0x DUP-07 收口 + DUP-15 台账订正（5.15.39）

**DUP-07 真收口**：16% 淡底配方两处各写一遍（气泡 / 全文弹窗）。两处的前景色来源**必须不同**
（按各自底色算对比度），所以合的不是 `mentionFg`，是「已知前景色之后怎么调底色」这一段 ⇒
`chatStyle::mentionHighlightBg`。产出串逐字不变（单测断言 `mentionHighlightBg("#123456")` 等于旧内联串）。
判据两条坑都是实测踩出来的：① 只认 **16%**，不认任意百分比 —— `useMessageDisplay.ts` 的 **18%** 是
卡片描边、`style.css` 的 **12%** 是静态兜底，都是别的事实（按任意百分比扫会把它们卷进来，第一版实得
`useMessageDisplay.ts: 18%`）；② 扫描前要把家里的具名常量 `MENTION_BG_PERCENT` 归一成 16，
否则「只有一个家」会被家自己的写法漏掉（第二版实得空集）。外部变异（把弹窗改回自拼配方）点名报红后还原。

**DUP-15 是台账漂，不是待办**：本表 §8 原写「overlay 手抄至少 2 处（`BaseModal.vue:113` / `FavoritePanel.vue:827`）」，
现读两处都不是那个形状——`BaseModal.vue:113` 只是**注释**里引用 z-[60]（不抄壳），真正的抄本只有
`FavoritePanel.vue` 一处，而它早已被**显式登记**为保留自研（`designGuards.test.ts` 的 `OVERLAY_SHELL_COPIES`，
连同「同一元素 serve 移动 overlay / 桌面内嵌两支布局」「底部留白量不同」与**别再排成下一批就迁**的理由），
另有棘轮判据 ㊼ 现算全仓（新增同形抄本立即红，登记表只许变小）。⇒ 不改代码，只订正台账。

### 4.0y 第 19 行的「闭环」被 review 推翻，补齐四种形状（5.15.40）

发版前双轴 review（标准轴 + 规格轴，两个独立 subagent）各自点名了同一类漏网，**逐条复核全部属实**。
根因是上一批的形状判据只认两种写法（`Err("散文")` / `Err(format!)`），而真实泄漏长在另外四种上：

| 形状 | 位置 | 现在的处理 |
|---|---|---|
| `map_err(|e| format!(…))` | `relay_push.rs` 打开/定位/读分片三处 | `FILE_SEND_READ_FAILED` + 原文进日志 |
| 包装层 `map_err(…)?` 与 `ok_or` | `receive.rs::finish_receive` 的「来源不匹配」「收尾任务被中断」 | `FILE_RECEIVE_SOURCE_MISMATCH` / `FILE_RECEIVE_FINALIZE_ABORTED` |
| `e.to_string()` | `handle_file.rs` 的 base64 解码 | `FILE_CHUNK_MALFORMED` |
| 换来源的 `Err(String)` | `begin_reassemble`（`传输标识非法` / `版本过旧` / 建目录失败） | 返回 `RelayReject { code, detail }`：码上屏、人话进日志 |

两条方法论上的账：
- **「闭环」这种断言本身需要被量**。上一批我按"两种写法为零"就宣布闭环，而同一个通道有六种写法
  ⇒ 正解不是再补一句声明，而是把**每一种**造载荷的写法都写进判据（本批的判据按文件列四条正则 + 包装层 + 直连分流，各带正控），
  并且**只宣称"这几种形状为零"**，不再宣称"闭环"。
- **包装层最容易漏**：`finish_receiver_into`（内层）改了、`finish_receive`（包装层）没改，
  而**emit 的是包装层的返回值**。教训与 5.15.32 那条同源：**一条规则有发送端 + 接收端（或内层 + 包装层）时，只补一侧＝没补**。

另外三处 review 指出的问题也一并修了：群收尾失败那一格盘满不弹通知（现与
`finalize_failed_group_receive` 同一份名单）；`finish_group_receive_into` 补 `&Logger`（OS 原文不再被丢）；
`error_codes` 两条注释按实际使用面改。**没有改**的：`FILE_SEND_CANCELLED` 目前没有界面读者（`handle_share`
认出它就不发帧）—— 保留文案是为了"万一别处把取消也走这帧时界面说得对"，属于登记的已知冗余；
`FILE_RECEIVE_INCOMPLETE` 与 `FILE_RELAY_SIZE_MISMATCH` 语义相近但**已各自落过库**，改名会让旧行查不到文案 ⇒ 不并。

### 4.0z TST-02 第一步（5.15.41）：把「跨会话按 msg_id 改一条」抽成可测的纯函数

审计原文把 TST-02 的前置写成「store 依赖注入」。复核后的判断：**不必上整店 DI** ——
真正没判据的是那三段**纯逻辑接线**（跨会话找一条、替换、保持顺序），它们完全可以抽到
`utils/messages`（与 `replaceOptimistic` 同一个家），store 只留一行调用。

- `transferFailureMsgIds` 把「1:1 用 `file-<tid>`、群文件用 `gfile-<tid>`」变成**有判别据的一句**——
  这正是 10-22 审计 R-02 前端那一半回归过的地方（当时只拼 `file-`）。
- `findFirstMessageById` / `replaceMessageAt`：跨会话找第一条 + **不可变**替换，且**没改的那条保持同一引用**
  （虚拟列表按引用跳过重渲染，直接 `[...list]` 里重建所有对象会让长列表全量重测）。
- 判据：`utils/messages.test.ts` 三组（前缀集合 / 跨会话第一条 / 不可变与引用保持）+
  `designGuards` 的接线判据（三个 handler 不许再手写跨会话循环）+ 外部变异一次（塞回循环 ⇒ 点名红）。
- **刻意没动**：`onMessageAcked`（`convIdOfMessage` 定域）与重发回退（已知 convId）是**会话内**查找，
  形状与语义都不同 —— 一起收会把"哪个会话"这件事从调用点藏进 helper，判据反而更弱。

### 4.0aa TST-02 第二步（5.15.42）：会话内两处也收进家，但**边界留在调用方**

`onMessageAcked`（送达提升）与重发回退都是"会话内按 msg_id 找一条"，与第一步那三段**语义不同**：
这里"哪个会话"由调用方决定（`convIdOfMessage` / 已知 convId）。所以新增的是
`patchMessageInConv(lists, convId, msgId, patch)` 而不是复用 `findFirstMessageById` ——
把边界藏进 helper 会让"别把另一个会话里同 id 的行也改了"读不出来，而单测正好能钉这一条
（同 id 的另一个会话必须保持同一引用）。

判据两条：单测（会话隔离 / 三种 null / 不可变）+ 接线判据（store 里手写 `findIndex(msg_id)` 现数 0、
`patchMessageInConv` ≥2 处），各带正控，外加一次外部变异（把 findIndex 塞回 `onMessageAcked` ⇒ 点名红）。

**TST-02 到此收口**：五个 handler 全部走家（⚠️ 这条当时就漏了 `onFileCancelled`，见 §4.0ae）。剩下的 `onPeerRead` 是**按会话批量提升**，
它的谓词本来就在 `utils/messages::promoteOnPeerRead`（有单测），不在这一条的范围里。

### 4.0ab §8 小尾巴复核（5.15.43）：lucide 评估完成；FUN-04 是**待拍板**不是"理由过期"；TST-09 本轮不做

**① `lucide-vue-next` 升级评估（§8 第 17 行）—— 评估完成，暂不升级。**
现读：装的是 **0.469.0**，最新 **1.0.0**（major）；生产代码里 **49 个文件 / 104 个名字**
（103 个运行时图标 + 1 个 `type LucideIcon`）。做法不是抄 changelog，而是在 `/tmp` 里装了 1.0.0
逐个比名字：**0.469.0 与 1.0.0 对 103 个运行时图标全部都有导出（缺失 0）** ⇒ 升级不会被"名字没了"卡住。
但 1.0 是 major，**默认描边/尺寸、tree-shaking 形状这些视觉面在本机没有判据**（要一轮
`msgovf`/`rowpair` 真渲染对照）。⇒ 结论：**评估完成、暂不升级**；将来要升时按"升级 PR + 真渲染对照"走一次。

**② FUN-04（`get_topology` 孤儿）—— 台账说反了，它现在是"待拍板"。**
本表原写「`DEAD_COMMANDS` 挂账但理由已过期（'随 TopologyBar 在 5.0.3 删除'）」。现读
`src/api/events.test.ts` 的挂账原文是「保留为应用内只读诊断接口；前端消费者随 TopologyBar 在 5.0.3
删除，暂无 UI 入口」—— 这句话**是准确的**（TopologyBar 确实在 5.0.3 删了，命令被**保留**下来）。
真正没过期的是 10-26 那轮的结论：`closedloop-findings` 说「不建议维持现状：**接线**（新功能，约 30–60 行，
要先砍掉那条"无 UI 入口"豁免）或**删掉**（约 10 行，删完双向对账里不再出现）」⇒ **需负责人二选一**。
本轮不动代码，只在 §8 把状态改成"待拍板"。

**③ TST-09（Windows 三类行为用例）—— 本轮判不做。**
三类要写的是 `#[cfg(windows)]` 的生产行为用例（缓存软链清扫 / 磁盘写失败 / 托盘角标）。
写得出，但**本机跑不了**（没有 Windows；跨编译只到 `cargo check`，见 §10 的 xwin 结论）⇒
按本仓口径（没跑过的层不许写成绿）它们只能等 windows-latest 那条腿给读数。
在没有本地判据的前提下一次写三条，风险是把"我以为它会红"当成了判据 —— 与 §4.0y 刚付的学费同源。

### 4.0ac INV-P18 的另一半（5.15.45）：Ed25519 私有化 + 「签名能力」抽象

现读的调用面只有三处（不是审计当初估的"十几处"）：`RelayCtx.signing`、`relay_negotiate(..)`、
`build_wrap_offer(..)`；其余十来个 `SigningKey` 出现点在**测试里自造夹具**（那本来就不该被字段公开挡住）。
所以"签名能力"抽象可以很小：

- `crypto::IdentitySigner { key }`（字段私有、`Clone`）：`sign(msg)` / `verifying_key()`；
  `Identity::signer()` 唯一入口；`#[cfg(test)] from_key_for_tests` 给测试造第三把钥。
- 三处签名的形参类型 `&SigningKey → &IdentitySigner`；拨号处的 `clone()` → `signer()`。
- **线格式零差异**：签名算法/被签字节/公钥来源全没动。这是本批最重要的边界 ——
  INV-P18 收的是"谁能拿到私钥"，不是协议。
- 判据 C 扩到这一半并补两条夹具；外部变异（字段写回 `pub`）当场点名红（`✗ [C] crypto.rs 把
  ed25519_signing 又写成 pub`）。
- 落库往返断言改看 `signer().verifying_key().to_bytes()`：公钥由私钥派生，相等 ⇔ 同一把钥，
  而且它只读**对外可见的那一面**。

### 4.0ad TST-06（5.15.46）：真 ENOSPC 量出一条活缺陷 —— 预检在 HFS+ 卷上高估余量 512 倍

审计的假设是"缺自动化"。按"造一块真盘"去量之后，量到的是缺陷本身：

- 8 MiB HFS+ 卷上，`available_bytes` 报 **3.88 GiB**（真实 7.8 MiB）⇒ 高估 **512 倍**；
- 根因：`statvfs` 的 `f_bsize` 是"最优 I/O 大小"（这块卷上是 2 MiB），`f_frsize` 才是分配单位（4 KiB）。
  旧实现**按平台**取字段（macOS 用 `f_bsize`），理由是"macOS 的 statfs 只有 f_bsize" —— 实测不成立，
  macOS 一样给 `f_frsize`。
- 后果：**预检恒放行** ⇒ 满盘时照样写到一半 ENOSPC。系统卷是 APFS（两字段相等）所以日常看不见；
  HFS+ 外置盘 / 磁盘映像会中。
- 修法与环境无关：所有平台优先 `f_frsize`。判据是同一条 `#[ignore]` 量具（要 `hdiutil`），
  A/B 退回去当场红。**Windows 那一半仍无本地判据**（`GetDiskFreeSpaceExW` 的夹具在
  `lib_startup_config_tests.rs`，本轮未动）。

### 4.0ae review 抓到上批的「收口」是假的（5.15.47）：第 6 个手写实现

两个独立 review 都指向 `onFileCancelled`（`useChatStore.ts`）：它用
`for (const [, msgs] of Object.entries(messages.value))` + `msgs.find(m => m.msg_id === …)` + 就地改
——与 `onFileFailed` 同一件事，而 5.15.42 的判据只认 `[convId, list]` 与 `.findIndex((m) => m.msg_id`
两种写法 ⇒ 它从两条正则里同时逃掉，台账却写了"五个 handler 全部走家、现数 0"。

- 修法：改用 `transferFailureMsgIds`（前缀）+ `markStatusInCache`（改状态；它本来就存在，
  这次扩成 `string | 多个 id`）。
- 判据：接线判据放宽到**任意解构**、把该 handler 加进必查清单、并新增 `.find(m => m.msg_id` 归零。
  外部变异（改回手写）⇒ 两条断言同时点名红。
- 同一批还修了 review 指出的三处：① 量具用了 `ErrorKind::StorageFull`（1.83+，本仓 MSRV 1.77，
  本文件自己写着不许用）⇒ 改裸码；② `blocks_to_bytes` 抽纯函数 + **非 ignored** 单测（原来修复只有
  要 `hdiutil` 的量具挡着）；③ `IdentitySigner` 去掉 `from_key_for_tests` 与 `verifying_key()`
  （前者 `Identity::from_secrets` 已够，后者公钥已有名字），`check-key-boundary` 的"写宽"判据
  扩到 `pub(crate)`/`pub(super)` 并对 X25519 对称检查。
- 数字订正：`messages.test` 现读 123、lucide 文件现读 49、`get_topology` 的复跑命令现读 4 行全注释。

**教训（与 §4.0y 同源）**：判据按"我当时想到的两种写法"写，就会漏掉第三种；而"收口/闭环"
这类断言必须**按形状族逐个清点**，不是按"我改过的那些"。

### 4.0af 把量具变成门（5.15.48）：STB-03 的结构判据 + TST-06 两半的纯函数判据

两条读数此前都只能人工跑（`#[ignore]`）。这一批守的是它们的**性质**，不是读数：

- **STB-03 → 结构判据**：`receiver_lock_holds_only_one_chunk_worth_of_work` 按**锁段**取文本
  （1:1 的 `write_chunk` 锁块 / 群的 `write_group_chunk_blocking` 整函数），
  锁内必须有 `open_symmetric`+`hasher.update`+`write_all`、必须没有整份级的活。变异塞 `sync_all` 当场红。
  另外两条正面证据：群侧解密在**锁外**做；计时量具本身也被钉住（不许被顺手删掉）。
- **TST-06 → 两半的纯函数判据**：`blocks_to_bytes_prefers_frsize`（上一批，非 ignored）+
  Windows 的 `volume_root_of` 用例（本来就有）。⇒ 只剩"真写满一块盘"是人工量具。
- 记下没做的：把 `#[ignore]` 的量具塞进 CI（macOS runner 上挂 dmg / 计时门）**判不做** ——
  计时门会擦着 CI 机器抖出假红，而真写满一块盘在共享 runner 上要特权，收益不抵脆弱。

### 4.0ag 审计余项重盘（2026-10-30，5.15.48 之后）：B 批 16 条从未进过 §8

§8 那张表只覆盖 10-29 这一轮审计的 19 行；`docs/notes/closedloop-findings-2026-10-26.md` 的 B 批
（B1～B4）**一条都没进表** ⇒ 它们会被下一次对账当成"没立过案"。本轮把六份审计输入统一盘了一遍，
结论：**仍存 16 条（P1 0 / P2 9 / P3 7）**，已修 37 条（现场复核无回退），已判不修或撤回 15 条。

**P2（9 条，全部"出错结果被折叠"或"两笔写不同步"，且都没有判据挡回归）**

| ID | 一句话 | 复核状态 |
|---|---|---|
| B1-F6 | 撤回的账本与物化两笔独立写都 `.ok()` ⇒ 失败后永久分裂 | **已修（5.15.50，§4.0ai）**：三笔合成一笔事务 `db::apply_recall` + 原子性行为用例 |
| B1-F7 | 首屏主读把读库失败折叠成「空」 | **已修（5.15.49，§4.0ah）**：四处改 `?` + 判据「命令层读不许折叠」 |
| B2-F1 | 盘满只报「失败」，且刻意保留 `.part` ⇒ 盘一直满、一直重试 | **1:1 已修（5.15.51，§4.0aj）**：盘满单独一格删 `.part` + 具名码 + 判据；**群侧已补（5.15.66，§4.0ax）**：`reason` 一路传到收尾，盘满同样删 `.part` + `code=GFILE_DISK_FULL` |
| B3-F3 | 读失败折叠成空 + 紧接着写回整份列表 | **已修（5.15.49，§4.0ah）**：外链 6 + 跨子网 3 处改用 `get_setting_checked`；根因（`get_setting` 返回 Option）写进它的文档 |
| B4-F1 | 托着承诺的写库结果被 `.ok()` 丢弃，无棘轮 | **棘轮已上（5.15.57，§4.0ap）**；**存量已清零（5.15.67→5.15.70，§4.0ay）**：64 处 L1 全部改成 `log_write_failure`，基线 79→15，**L1 现读 0**（余 L2 8 / L3 7 是刻意保留的） |
| B4-F3 | 通知从不查系统权限，且失败被 `let _ =` 丢弃 | **已修（5.15.52，§4.0ak）**：两个入口在发之前过权限闸、跳过/失败两行都配码、测试按钮也查；桌面恒放行（插件对桌面恒 `Granted`，读源码确认） |
| B1-F4 | 设置落库失败只 `catch { /* 忽略 */ }`，不上屏不留痕 | **已修（5.15.53，§4.0al）**：失败弹 toast + console 线索；判据禁止空 catch、要求两册词典都有该 key |
| B1-F3 | 「安装相位不可取消」靠 2 处手抄字面量 + 一条只查文本的断言 | **已修（5.15.54，§4.0am）**：收成 `PHASE_INSTALLING` 一处；判据改「代码里只许出现一次 + 两处都引用常量 + TS 值对账」 |
| TST-08 | 「重启后 device_id 不再派生」这条核心性质没有以自己名字存在的用例 | **已修（5.15.55，§4.0an）**：决议抽成 `resolve_device_id` + 五格行为用例（含「改库里的值 ⇒ 返回改后的」这条区分读库与重算） |

**P3（7 条）**：B3-F2（清库清单手抄 15/20 张表 —— **已修（5.15.56，§4.0ao）**）、B3-F1（迁移把"读不到 schema"当跳过 —— **已修（5.15.58，§4.0aq）**）、B1-F1（取消结局不留痕 —— **已修（5.15.59，§4.0ar）**）、
B4-F2（每小时清扫是裸 `spawn` 且头部豁免名单已过期 —— **已修（5.15.61，§4.0as）**：抽成 `spawn_part_sweeper` + 两张登记表 + 「每个 spawn 必须有归属」判据）、B1-F2（注释说 kinds 四种、实为六种 —— **已修（5.15.62，§4.0at）**：改写 + 禁计数写法的判据）、
STB-04 半条（非好友分支广播后直接 return，无撤销登记 —— **已修（5.15.64，§4.0av）**：好友判定改 checked 读 + 读失败撤销去重；真非好友仍按 Duplicate 丢）、STB-05（1:1 两条线格式/两套去重判据 —— **已修（5.15.63，§4.0au）**：线格式判不修；kind 谓词已同源，补守卫钉住）。

**下一步的最小可做集（子代理建议、我复核后同意）**：9 条 P2 里 6 条是同一个形状（出错结果被折叠）。
一次只做三件就能拿到最大收益 —— ① B3-F3 的 5 处加 `?`；② B1-F7 的 3 处加 `?`；③ 一条
"读/写结果不许静默折叠"的源码形状闸（把 B4-F1 的棘轮与 B1-F7/B3-F3 的**存量**一起管住）。
合计约 10 行产品码 + 1 个脚本。**B1-F6 单独做**（要 1 个事务版 db 函数 + 3 调用点）。

### 4.0ah 折叠三件套（5.15.49）：B1-F7 与 B3-F3 已修，附一条形状判据

- **B1-F7**：`get_messages` / `get_latest_messages` / `list_conversations` / `list_groups` 四处
  `unwrap_or_default()` ⇒ 改上抛（界面能说"读失败"，不再假装"没有数据"）。
- **B3-F3**：外链 6 处、跨子网端点 3 处 ⇒ 改用 `get_setting_checked`。
  **根因也记下来了**：`db::get_setting` 返回 `Option`（`.ok().flatten()`）⇒「读失败」与「没这条」不可分；
  它的文档现在明写"读-改-写必须用 checked"。
- **一处改成"留痕折叠"而不是上抛**：`channel.rs` 的跨网端点计数是**同步、非 Result** 的只读诊断
  （界面没有错误通道）⇒ 仍折叠成空，但失败时写 `code=ROUTED_ENDPOINTS_READ_FAILED`。
- **判据**（`designGuards`）：「命令层的读库结果不许折叠成空」——按形状扫 `commands/*.rs`，
  两个正控 + 一个反控（`checked(..)?.unwrap_or_default()` 是正确写法、不许误伤）；
  两处**有意折叠已登记并钉住理由**（`relay.rs::load_relay_runtime` 与 `channel.rs` 那一格）。
- 外部变异（把消息页读回折叠）⇒ 判据点名红后逐字节还原。

### 4.0ai B1-F6（5.15.50）：撤回三笔写收成一笔事务

- 新增 `db::apply_recall`：墓碑 + 物化 + 会话预览**同一个事务**；三个调用点
  （单聊发起 / 群主发起 / 接收侧）全改走它 —— 发起侧失败上抛（界面说"未生效，可重试"），
  接收侧只记日志。
- 判据：① **行为用例**（`cascade_tests`）：正常路径三笔都落、重复撤回幂等、
  **第三笔失败时前两笔回滚**（拿掉 `conversations` 表制造失败）—— 变异（去掉事务）当场点名红；
  ② 原来那两条"三处各写一遍"的形状判据改强：三个调用点只许调 `apply_recall`、
  不许再碰原语，且事务内顺序必须是 物化 → 预览重算 → commit。
- 顺带记一条老坑复现：**改名的测试会在另一条腿的基线里留下旧名**（`--sync-baselines` 只增不删）
  ⇒ 手工删 `test-baseline.windows.txt` 那一行后 `check` 才绿。

### 4.0aj B2-F1（5.15.51）：盘满是唯一不留续传前缀的失败档（只做了 1:1）

- `fail_taken_receive` 里盘满单独一格：命中 `FAIL_CODE_DISK_FULL` ⇒ 删 `.part` + 写
  `code=FILE_DISK_FULL`；其余档仍保留续传前缀。**两种语义在源码里分开写**，注释写清为什么这一档例外。
- 判据：形状判据（条件按码判 / 条件内真删 / 具名码在日志）+ **反向对照**（不许把删除提到条件外）。
  变异（去掉条件）⇒ 点名红。
- **群侧未做**：`fail_taken_group_receive` 没有 `reason` 入参，改签名会牵连它的两个调用点。
  判据里显式登记了这件事（`grep GFILE_DISK_FULL` 应为 0），免得下次被当成已完成。
  → **已在 5.15.66 收口**（§4.0ax）：签名现为 4 个形参（含 `reason: &str`），盘满分支三态留痕，判据从「计数须为 0」翻成正向。
- ⚠️ 审计原稿还建议给 `FileJobEnd` 加 `DiskFull` 变体 —— **本批判不需要**：接收侧没有气泡行，
  `FileJobEnd` 是**发送侧**的终态，盘满不是发送侧能发生的事。加了就是给一条不存在的路径造档位。

### 4.0ak B4-F3（5.15.52）：通知发之前先问系统权限，失败行配码

先纠正原稿的一处措辞：三处 `let _ =` **并不是**"失败连日志都没有" —— `show_if_enabled` /
`show_click_if_enabled` 内部已经 `log_result` 过（成功 info、失败 warn）。真正没有日志的是
**权限被拒**那一格：Android 13+ 的 `NotificationManager` 与 macOS 的 NSUserNotificationCenter
都会「成功」地什么都不发 ⇒ 日志里留一条假的 `已发送系统通知`。所以这一批修的是**判据**，不是日志管道。

- `permission_verdict(Result<PermissionState, String>) -> Option<String>`：纯函数，四格全表 ——
  只有 `Granted` 放行；`Denied`/`Prompt`/`PromptWithRationale` 都挡，且原因里带 OS 原值
  （`denied` 与 `prompt` 的修法不同）；查询失败（JNI 断）也挡并原样带出错误。
- `permission_blocked`：移动端问插件 `permission_state()`；**桌面恒 `None`** ——
  读 `tauri-plugin-notification 2.4.0` 的 `desktop.rs` 确认它对桌面恒返回 `Granted`，
  加调用只是空壳（这一条由判据钉住桌面分支必须是纯 `None`）。
- 两个入口都在 `log_result` **之前**过闸；跳过的日志带 `code=NOTIFY_PERMISSION_DENIED`，
  发送失败的日志补 `code=NOTIFY_SEND_FAILED`。
- 设置页「发送测试通知」也查权限并回失败：它是唯一能让用户当场看到原因的地方。
  它仍**绕过总开关**（用户显式要试），这一点没变。
- **不做**：后台自动弹系统权限对话框。那需要 Activity，而且本仓既有口径是
  「在用户点开关的上下文里申请」（`useAppStore::ensureNotifyPermission`）——
  前端那条链本来就在每次通知批次前 request，后端只负责"没许可就别假装发了"。
- Android 腿实测：`bash scripts/check-mobile.sh --bluetooth` **两档都 PASS（0 warning）** ——
  这是移动端 cfg 块唯一的编译证据（桌面构建把整块 cfg 掉）。

### 4.0al B1-F4（5.15.53）：设置落库失败上屏

原状：`persistSettings` 的 catch 只有一句「忽略：离线或后端暂不可用时不影响本地使用」。
前半句成立（界面已按意图生效，回滚比丢设置更糟），缺的是**后半句的代价**：库里没写 ⇒
重启变回旧值，用户拿不到任何线索。这一批只补"说出来"，不改回滚策略。

- 失败 ⇒ `toast(t("settings.toast.saveFailed"), "error")` + `console.warn("[settings] …", e)`。
  不叠屏靠既有的 `pushToast`（kind+文案同一个 id）：拖动颜色那种连写只会更新同一条。
- `pushUiLanguage` 继续静默，但注释改掉「理由与 `persistSettings` 相同」这句已经过期的说法
  —— 它只管菜单栏文案，语言偏好本身走 `persistSettings`，不该为同一件事弹两次。
- 判据 `设置落库失败必须上屏（B1-F4）`：catch 里必须有带词典 key 的 toast + console 线索、
  不许退化回空 catch（正则连"只留注释的空 catch"一起抓）、key 必须两册词典都有。
  变异：catch 改回空 ⇒ 点名「没有上屏」；删英文 key ⇒ 点名「该语言用户会看到 key 原样」。

### 4.0am B1-F3（5.15.54）：安装相位的名字收成一个常量

- 缺陷形状：`updater_install` 写 `"installing"`、`updater_cancel` 判 `"installing"`，两处**各抄一份**；
  原判据只 grep「两处都出现过这个串」⇒ 任一侧打错都不编译失败，只让「安装中不可取消」静默失效。
- 修法：`desktop::PHASE_INSTALLING` 唯一一份，写与判都引用它（名字写漂了会编译失败 ⇒ 只剩值可能漂）。
- 判据改成三条可证的形状：① 代码里该字面量只出现**一次**（注释行不计）；
  ② 取消判定 / 安装写入都引用常量；③ 值必须出现在 `src/updater/service.ts`，
  且比对的是**常量当前的值**（`format!("\"{PHASE_INSTALLING}\"")`），后端改名而前端没跟上就红。
- 变异三处：字面量写回判定处 ⇒ 计数断言点名；改值的大小写 ⇒ 同上（计数 0）；
  TS 侧 7 处改名 ⇒ 「前端判不出安装相位」。`cmp` 逐字节还原。
- **没做**：`UpdatePanel.vue` 模板里的 `'installing'` 仍手写 —— 它只决定按钮显隐，闸在后端那一条。
  （路径已搬到 `src/components/settings/UpdatePanel.vue`；现读该文件 4 处该字面量——脚本 2 处、模板 2 处。
  判据钉的是后端裁决与 TS 契约值，这 4 处仍不在判据内。）

### 4.0an TST-08（5.15.55）：`resolve_device_id` + 五格行为用例

- 原状：设备标识的决议内联在 `AppState::init`（约 55 行 match），设备侧四条用例全在"生成"一侧，
  没有一条断言"同一份库第二次启动拿到同一个 id"。
- 修法：纯搬家到 `state::resolve_device_id(conn, existing_install, logger)`，分支/注释/日志码一字未改；
  `init` 改 `resolve_device_id(&conn, existing_install, &logger).map_err(Box::new)?`。
- 用例五格：生成并入册 → 重启原值；**改库里的值 ⇒ 返回改后的**（区分"读库"与"按属性重算"）；
  已有安装缺值 ⇒ `DeviceIdMissing` 且不写；读失败（drop 表）⇒ `DeviceIdRead`；`dev-` 前缀迁移要写回。
- 变异：`None => stored` 改成重新生成 ⇒ 点名「重启后换了设备标识」，两个 id 不同；`cmp` 还原。
- clippy 在抽取时抓到两处 `&conn`（`conn` 已是引用）—— 正是「抽函数要按新签名改借用」的现场。

### 4.0ao B3-F2（5.15.56）：清库清单补两张表，并跟 schema 对账

- 漏的是 `group_file_acks`（群文件逐收件人 Ack）与 `group_recalled_messages`（群撤回账本；
  `db.rs` 建表注释原话是**只增不减**的 G-Set）⇒ 清完数据它们还跟着这台设备。
- 判据 `clearing_chat_data_covers_every_table_in_the_schema`：分母 `db.rs` 现解析、清单从
  `for table in [ … ]` 现解析，相减后只允许两类例外 —— 产品口径的保留（`friends` / `settings`，
  对话框里明说）与按行清除的 `conversation_clocks`（SQL 本身也被钉住）。用例自带正向
  （合成新表必须被报）与反向（缩一格保留名单，`settings` 必须变缺口）对照。
- **一次归因教训**：第一版把"清单条数下限"卡在实测值 17，结果删掉一张表的变异先被它接住，
  报成「锚点变了」。下限只该证明量具没坏 ⇒ 放宽到 15，重跑后由语义断言点名 `group_file_acks`。
- ⚠️ **2026-10-31 A3 决策把这一格的保留名单从 2 格改成 3 格**（用户拍板：普通「清除数据」不删收藏）：
  清单里去掉 `favorites`，`favorites_dir` 那份副本也不再整份清；判据的 `KEEP` 变成
  `["friends", "settings", "favorites"]`，反向对照随之改成「缩到只剩 `friends` ⇒ `favorites` 与 `settings` 两格缺口」。
  ⇒ 读本节时别按旧口径把「收藏必须被清」当成契约去"修复"——那正是 2026-10-31 之前的口径。

### 4.0ap B4-F1（5.15.57）：`.ok();` 棘轮 + 三级口径

- 复跑命令：`node scripts/check-silent-drops.mjs --report` → **L1 写库承诺 64 / L2 尽力而为 8 /
  L3 其它 7**（合计 79；分母是排除注释、字符串、`#[cfg(test)]` 之后的生产码语句形式）。
- 闸：硬零三格（`set_message_status` / `set_message_failed` / `apply_recall`，现读 0，
  它们的历史是 `db/messages.rs` 里那段"两条独立写、错误全吞"）+ 每文件计数对基线只降不升。
  尺子 import 自 `check-panic-sites.mjs`（`stripRust` / `stripCfgTest`），不另写一份。
- 变异：加一处普通 `.ok();` ⇒ 计数涨红；加一处 `set_message_status(...).ok();` ⇒ 硬零红。
- **没做**：L1 那 64 处没有在这一批改。它们分散在 gossip / handshake / relay / file 四条链上，
  每处的正确处置（上抛 / 记 code / 真的可忽略）要看"这一格失败时谁该知道"，批量替换只会
  把 64 行产品码一次性搅动；棘轮先把"别再涨"钉住，下落按链路分批。
  → **已分批清完**：5.15.67–5.15.70 四批（§4.0ay）把 64 降到 0；`--report` 现读 L1 **0 处**，基线 15。
- 新增门禁步的连带影响：快速层步数 20→21、全量 26→27，README 与 `docs/large-file-split-plan.md`
  里手写的数字已删（`check-doc-numbers` 现算）。

### 4.0aq B3-F1（5.15.58）：迁移读不到 schema 就中止 + 启动留痕带上版本

- 四处（v1→v2 … v4→v5）原先「读失败 ⇒ eprintln skip ⇒ runner 照常写 user_version」，
  效果是**列永久缺失且不再重跑**。改成 `ensure_column`（表在不在 → 列在不在 → 改），
  读失败上抛；只有"表本身不在"才跳过（真机 `init` 先跑 `SCHEMA`，走不到那一支）。
- 同族三处静默一并收掉：`let _ = tx.execute(...)`、`PRAGMA user_version` 折成 0
  （= 把"读不到"当"最老的库"整链重放）、`column_exists(..).unwrap_or(false)`。
- `BOOT_DB_STATE` 补 `user_version=` / `migrated=v{a}→v{b}`（迁移发生在 logger 之前，
  这是事后唯一可读处；`run_migrations` 用 `LAST_MIGRATION` 静态记区间）。
- **真读失败**怎么造：一张同名真实表遮住 `pragma_table_info` 这个省略 schema 的虚拟表
  ⇒ sqlite 报 "is not a function"（sqlite3 实测）。用例因此走的是生产那条 SQL，
  不是测试专用开关。
- 变异：探针的 `?` 改 `.unwrap_or(true)` ⇒ 版本号前进到 2（原文是 1）当场红；
  `user_version=` 改 `uv=` ⇒ 留痕判据点名。
- 顺带发现：改掉 `let _ =` 之后，老的 rollback 用例红了 —— 它的合成库没有 `group_files`
  表，旧代码一直在靠 `let _ =` 吞掉 `no such table`。因此 `ensure_column` 里保留
  "表不在就跳过"（与 v11→v12 同一理由），用例本身不动。

### 4.0ar B1-F1（5.15.59）：取消的结局也留一行具名码

- 三条通道补码：1:1 消息 `DM_CANCEL`（三种结局都记）、文件 `FILE_CANCEL`（含 `notified_peer`）、
  更新 `UPDATER_CANCEL`（被拒 + 成功两种）。群侧 `GROUP_CANCEL` 原样保留。
- 判据 `every_cancel_channel_leaves_a_named_outcome` 按**函数体**取文本；更新在 `impl` 里，
  `rust_fn_body` 的收尾锚点（列 0 的 `}`）够不着 ⇒ 那一格用计数（两种结局各一行）。
- ⚠️ 一次实测教训：`matches("code=UPDATER_CANCEL")` 是**子串计数**，把一处改成
  `code=UPDATER_CANCEL_X` 仍然算 1 行 ⇒ 变异没红。针头补上 ` outcome=` 才抓住。
- 门禁连带：文件取消那行是同步 append，加完把 `worker_bound_heavy_commands_do_not_grow`
  顶到 32（上限 31）⇒ 已改成进 `spawn_blocking`。这条正好证明那条棘轮有效。
- ⚠️ 我自己的错（5.15.60 已还原）：对 `chat.rs` / `files.rs` / `updater.rs` 跑了
  `rustfmt <file>`，而这三份都是 **`include!` 分册** —— `cargo fmt` 不管它们，独立跑 rustfmt
  会按"独立 crate 根"整档重排（实测 232 / 117 / 24 行）。**改分册不要跑 rustfmt**，
  形状由各自判据守；要格式化就先确认它是不是分册（`grep 'include!("commands/x.rs")'`）。

### 4.0as B4-F2（5.15.61）：常驻循环必须有归属

- 缺的那一格：`lib.rs` 每小时那趟清扫（`.part` / 中继内存态 / 静默接收器）是裸 `spawn(loop{…})`，
  句柄丢掉、不在 `RESIDENT_WORKERS`、也不在「刻意不碰」里。停在原地的后果**静默且只会变坏**。
- 修法：抽成 `spawn_part_sweeper`（调用点与时机未变）；`worker_supervisor` 增
  `UNSUPERVISED_LOOPS` / `ONE_SHOT_SPAWNS` 两张 `(名字, 理由)` 表；启动行补两个计数。
  用元组不用结构体：`why` 没有生产读者，结构体字段在 lib 构建里是 dead_code（实测 clippy 红）。
- 判据 `every_spawn_fn_has_a_home`：**分母从源码现解析** `fn spawn_*`（不是手抄清单），
  逐个要求恰好属于一处；登记名反向对账（防改名后假绿）；每条必须写理由。
  ⚠️ 解析有两个坑，都踩过：① 不能"截到第一个 `#[cfg(test)]`"（`state.rs` 中段就有 cfg(test)，
  实测只解析到 7 个）；② 逐行扫要跳过含引号的行（判据自己在字符串里找过签名串）。
- 顺带：`all_commands_src` 那条"清扫器必须恰好接一处"的判据抓到我新写的注释里带了完整签名串
  （数成 2）—— 注释也不能写出被计数的那个串。
- 护栏锚点：清扫搬进函数后缩进 24→12，`每小时那一趟必须…` 的注入锚点失效；已重定向并实跑
  `verify-guards.py --only 每小时那一趟`（改坏即 FAIL、恢复逐字节一致）。

### 4.0at B1-F2（5.15.62）：注释不再手抄 kinds 计数

- 文件头第 2 条写着「kinds 只有四种」，实际六种（`update_download` B5 已接好）。
  已重写为点名 + 各自真值源，并补上此前缺的那句：**更新器状态只在内存里，重启即无痕 ⇒ 不做恢复**。
- 判据只禁**计数写法**（`kinds 只有 N 种`），点名不受限；带正控（对过期原话必须报出）。
  变异：把原话贴回 ⇒ 点名红。
- 行为侧本来就有凭据（`taskCenter.test.ts` 的 `update_download` 行/相位两条），所以这里**不重复造**
  行为断言 —— 它守的是"注释被当规格"这一层。

### 4.0au STB-05（5.15.63）：两条线的 kind 判据同源 + 守卫

- 核实结论：直连（`handle_messaging.rs`）与多跳（`gossip.rs`）**已经**都调同一个
  `protocol::is_non_notifying_kind`；谓词与冻结清单 `DM_LEGACY_KINDS` 各只有一份定义。
  原发现说的"两个独立 kind 解析器"在当前代码上**已不成立**（是真的收敛过，不是测不到）。
- **判不修**：合并两条线的线格式 —— 那是协议变更，收益只是省一份代码，
  代价是所有老端兼容面（稳定 > 可维护）。
- 新增判据：两侧各恰好调一次共享谓词；谓词只有一个定义；冻结清单在三份源码里合计只出现一次。
  变异：gossip 侧换成 `if false` ⇒ 点名；往 `handle_messaging.rs` 抄一份清单 ⇒ 点名。
- 同一函数里还剩一格没动（属 STB-04 的另一半）：非好友分支在 `broadcast_gossip` 之后
  **直接 `return`，没做 `allow_message_retry`** —— 好友判定若因一次读失败而落空，
  对方后续补发会被去重表永久挡掉。
  → **已在 5.15.64 收口**（§4.0av）：读失败不再折成「非好友」，改走
  `allow_message_retry(.., "friend_read_failed")`（现读 `gossip.rs:937`）；真·非好友（`Ok(None)`）**刻意**仍直接丢。

### 4.0av STB-04 半格（5.15.64）：好友判定不再折叠读失败

- 根因：`db::get_friend` 把 `Err` 折成 `None`（`.ok().flatten()`），而 `handle_gossip` 用它做
  **权限判定** ⇒ 一次读抖动 = "不是好友" ⇒ 拒收 + return，而 `msg_id` 已进过去重表
  ⇒ 之后每次补发都被判 Duplicate，永久进不来。
- 修法：`get_friend_checked`（同一句 SQL，保留错误）+ 收件路径读失败时
  `allow_message_retry(.., "friend_read_failed")` + `code=GOSSIP_FRIEND_READ_FAILED`；
  同函数里**中继转发授权**那处也换成 checked（失败关闭 + `code=GOSSIP_RELAY_AUTH_READ_FAILED`）。
- **刻意不同的一格**：真·非好友（`Ok(None)`）仍按 Duplicate 丢补发 —— 陌生人的反复重试
  不该被重新广播成 N 次"被拦住"；只有"读失败"这种**瞬态**才撤销。
- 判据 + 两处变异（换回 `get_friend` / 删撤销行）各点名红。

### 4.0aw 发版前 review 的四条（5.15.65）

两位独立审查（标准轴 / 规格轴）跑 `v5.15.47..HEAD`，逐条复读到行后确认四条：

1. **B3-F2 的"一表不漏"是假的**：`content_transfers` 建在 `content/store.rs`（与基础 schema
   同一事务），旧判据只按 `db.rs` 数表 ⇒ 分母缺它。残留行会让本机清完数据后继续宣称持有该 cid
   （`find_source` 只看 `path IS NOT NULL`）。→ 表进清单；判据分母改成两处建表点。
2. **B3-F1 的"同族三处"少算一处**：`pre_table_count` 仍 `.unwrap_or(0)` ⇒ 读失败当"没有表"
   ⇒ `is_fresh` ⇒ 跳过整链迁移并写 `DB_VERSION`。→ `?`。
3. **盘满删除的日志说假话**：`is_ok()` 把任何 Err 都写成"文件已不在，视作已删除"。→ 三态分开。
4. **"不许无条件删"那条反向对照恒真**：grep 的串源码里根本没有。→ 形状断言（删除在盘满分支
   块内 + 全函数只一次 + 失败分支存在）。

另：**5.15.52 的提交信息里那句「否则 cargo fmt --check 必红」是假的** ——
`cargo fmt --all -- --check` 对 `include!` 分册本来就退出 0，独立跑 `rustfmt <file>` 才会整档重排。
`commands/network.rs` / `transport/handshake.rs` 那两笔 churn 已在 5.15.65 撤掉（净差异只剩语义）。

**判不修/待真机**（review 提到但未坐实）：
- `fail_taken_receive` 删 `.part` 时接收器句柄仍开着（`&FileReceiver`）—— Rust 的 std 打开方式
  含 `FILE_SHARE_DELETE`，Windows 上通常仍能删；只有真机撞到才值得改顺序。
- gossip 两处新的读失败 warn 没走节流（`log_throttled` 是 `link_state.rs` 的私有函数）——
  库真坏时每帧一条，但那时别的日志也早爆了；要节流得先把那个助手升成公共家。
- `check-silent-drops.mjs` 的 `--report` 分级只按名字前缀判读写，`db::recall_source` 这类读会被
  标成"L1"—— 它只是给文档用的报告，不参与红绿。

### 4.0ax B2-F1 群侧（5.15.66）：盘满同样不留续传前缀

- 缺口：`fail_taken_group_receive` 没有 `reason` 入参 ⇒ 群侧只能一律保留 `.part`。改签名，把
  `fail_group_file_chunk → fail_group_receive → fail_taken_group_receive` 三段的 reason 打通；
  超时清扫与对端下线各传自己的码。
- 盘满那一支：删 `.part` + `code=GFILE_DISK_FULL`，三种结局分开说（与 5.15.65 单聊同一口径）。
- 判据从"群侧未做（计数须为 0）"翻成正向（条件按码判 / 删除在支内 / 全函数一次 / 失败分支 / 具名码）。
  变异 `if false` ⇒ 点名。
- 顺手更新另一条钉住调用形状的断言（`fail_taken_group_receive(&state, &r)` →
  `(&state, &tid, &r,` 前缀）—— 它钉的是"摘出来的那份必须被收尾吃掉"，不是参数个数。

### 4.0ay B4-F1 存量第一批（5.15.67）：12 处写库承诺留痕

- 先清 friend/peer 两族（gossip 4 / handshake 2 / handle_identity 3 / peer_state 1 / peer_registry 2），
  新增 `logging::log_write_failure(logger, at, e)`（一条 `code=DB_WRITE_FAILED at=… err=…` 的 warn）。
- **写法坑**：`db::x(..).map_err(..).ok();` 仍会被棘轮数进去（实测），棘轮不会降 ⇒ 必须改成
  `if let Err(e) = … { log_write_failure(..) }`。
- `bind_friend_keys_on_accept` 加了 `logger` 入参（原先只拿 `conn`）。
- 基线 79→67（27 文件）；变异回填一处 `.ok();` ⇒ 点名「从 0 涨到 1」。
- 第二批（5.15.68）：消息/回执链 11 处（read_receipt 4 / handle_messaging 4 / transport.rs 3），基线 67→56。
- 第三批（5.15.69）：群关系 5 + 群公告 3 + 发送台账 6，基线 56→42。多行调用包 if-let 的写法已验证可编译。
- 收尾（5.15.70）：余 27 处一次清完（relay_file 10 + commands 9 + transport 4 + 其它 4），基线 42→15，
  **L1 归零**。坑：多行调用的**嵌套参数行**（`record_local(…, db::now_ms(), …)`）也以 `db::` 开头，
  按"往上找最近的 db:: 行"会把 `now_ms()` 当语句头生成语法错；这一处已手工改回。
- 顺带修一条脆弱判据：`pending_key_rotation_…` 按**字节**切 1500 窗口，中文注释会让边界落在
  多字节字符中间直接 panic；改成按**字符**取窗（这次改注释当场撞到）。

### 4.0az `.ok();` 剩下那 15 处的定论（L2 8 / L3 7，逐行读过）

复跑命令：`node scripts/check-silent-drops.mjs --report`（现读 L1 0 / L2 8 / L3 7）。

| 位置 | 是什么 | 定论 |
|---|---|---|
| `commands/files.rs:181` | `canonicalize(favorites_dir).ok()` | **可接受**：折成 None 后走 `Err(OPEN_PATH_UNBOUND)` ⇒ **失败关闭**，不会放行越界路径 |
| `db.rs:1282` | `create_dir_all(parent)`（开库前） | **可接受**：目录建不出来时紧接着的 `Connection::open` 会以真实错误上抛（`?`） |
| `db.rs` ×4 | `pragma_update(journal_mode / synchronous / foreign_keys)` | **前三处可接受**（已有读回校验 + `DB_*` 通知）；**第四处已修（5.15.73，§4.0bd）**：WAL 失败后那句 `synchronous=FULL` 原先 `.ok()` 掉却照样声称「已提到」，现改为读回决定措辞 |
| `network/file/receive.rs:841`、`state.rs:2079` | `create_dir_all(downloads)` | **可接受**：写文件时会以真实错误失败，且已走 `FILE_RECEIVE_WRITE_FAILED` / `DISK_FULL` 分类 |
| `db/group_delete_boundary.rs:52/78` | `set_lan_enabled/set_bt_enabled(默认值).ok()` | **可接受**：这是"把默认值持久化"，失败后下次启动重做（幂等），本次返回值不受影响。⚠️ 分类器把它算 L3 是因为它没写 `db::` 前缀（模块内调用），它**本质是写** —— 记录在案，别被 L3 这个名字骗了 |
| `db/group_history.rs:369` | `observe_clock(conn, …).ok()` | **可接受**：同上（模块内调用被算 L3）；db 层没有 logger 可写，而同一事务里若真写失败，前面的 insert 会先上抛 |
| `db/messages.rs:1226/1257` | `query_row(..).ok()` 折成 Option | **可接受**：读失败 = "这条没有可补的 sha" ⇒ `fill_message_sha256` 返回 `Ok(false)`（不写坏数据）。是假阴性不是假阳性，代价是补不上而不是补错 |
| `network/transport/e2ee_payload.rs:104` | 同上（取本机发出的明文） | **可接受**：取不到时走"没有明文"的分支，绝不会把密文当明文用 |
| `logging.rs:78` | logcat 线程 `spawn(…).ok()` | **可接受**：丢的是 ADB `logcat` 那份副本，主日志另有落盘通道；且此刻没有 logger 可写，`eprintln` 在打包版也没人看 |

**结论**：`.ok();` 这一族到此结案 —— **"托着承诺的写库结果被丢掉"是 0 处**；剩下 15 处各有上表的理由，
且从今往后由 `scripts/check-silent-drops.mjs` 的棘轮（只降不升）与三条硬零守着，新增一处即红。

### 4.0ba v5.15.71 发版前 review 的三处

- 标准轴审查（只读、逐处读到行）确认 64 处 `.ok();` 转换**逐处等价**（removed/added 函数名 1:1、
  无 `let x = ..ok();`、无 `&&` 误伤、`.ok();` 之后的语句未被 if-let 的块吞掉），棘轮 79→15
  的逐文件减量与该文件转换数一一相等。
- 修掉三处：① `log_write_failure` 的示例写法会被棘轮数进去（自相矛盾）；
  ② 6 个分册里 7 处 if-let 缩进错位（`cargo fmt` 看不见分册）；③ `fail_taken_group_receive`
  的调用判据只钉签名前缀 ⇒ 补三条**值**判据（reason 是否真透传/是否是对应的码）。
- 未坐实、留真机：盘满删 `.part` 时接收器句柄仍开着（Windows 上删除可能失败，只剩一条
  "删除失败"日志）。Rust std 的打开方式含 `FILE_SHARE_DELETE`，通常仍能删。

### 4.0bb 发版后对账：v5.15.65 → v5.15.71（7 个提交，两版都已发布）

**A. 提交账（声称 → 证据 → 缺口）**

| 提交 | 声称 | 证据 | 缺口 |
|---|---|---|---|
| `b50fd6e7` 群侧盘满 | reason 打通三条链、盘满删 `.part` | 源码三处调用逐一读到；判据正向化（条件按码判/支内删/全函数一次/三态日志/具名码）+ 三条**值**判据；变异 `if false` 与「传空串」各点名红 | **无端到端**：要真写满一块盘 + 群文件多跳链路 |
| `9248bc46`/`2257b4b9`/`23aaabac`/`41df3d5c` 64 处转换 | `.ok();` 改为 if-let + `log_write_failure`，控制流不变 | 编译/clippy/1337 测试全绿；review 逐文件比对 removed↔added 函数名 1:1、无 `let x=..ok()`、无 `&&` 误伤；棘轮 79→15，`--report` 现读 L1 **0** | **无运行时判据**：「写库失败时不改控制流」只有形状层覆盖（失败注入没做）；L1 名字按"语句以 `db::` 开头"分，两处模块内写被算 L3（已登记） |
| `f8dc12ee` L2/L3 定论 | 15 处逐行给了"为什么不改" | 表格 9 行，每行写了失败方向（失败关闭/幂等重做/下一步上抛/只造成假阴性） | pragma 四条的可选改进（塞 `startup_notices`）登记未做 |
| `a954b6e3` review 三处 | 注释示例、7 处缩进、3 条值判据 | 注释已改；`cargo fmt` 看不见分册这一点写进 CHANGELOG；值判据变异点名红 | 无 |

**B. 发布账（两版逐项对）**

| 项 | v5.15.65 | v5.15.71 |
|---|---|---|
| tag → commit | `53968b26` | `a954b6e3` |
| 资产 | 17 | 17（把版本号换成 `V` 后两版**逐名相同**，`diff` 空） |
| `latest.json` | version 5.15.65、四平台签名 404/404/424/420 | version 5.15.71、同样四平台同样签名长度 |
| draft / prerelease | false / false | false / false |
| 更新说明 | 手写覆盖 | 手写覆盖 |
| Latest 指针 | （当时指向 65） | 现指向 **v5.15.71** |

**C. 门禁账**

- `verify:full`：**27 步**，v65 那轮 177.0s、v71 那轮 168.4s（含 288 条护栏注入整跑与 Android 腿）。
- `verify:release`：两轮都是 **25 / 23 / 38 / 49** 条断言（4 轮）；`NO-ASSERT` 那些行是每轮的**预置步骤**，不是被跳过的轮次。
- CI `Verify`：两次提交各一轮，7 个 job success；`护栏非空转 · cargo 通道` 与上一版一样按既有条件 skipped（本地整跑 288 条）。
- tag 触发的 6 条 workflow：两次都全 success。

**D. 数字现算**（`node scripts/check-silent-drops.mjs --report`）：L1 **0** / L2 8 / L3 7；基线 15；`cargo test --lib --features bluetooth` 1337 passed / 0 failed / 3 ignored。

**E. 还开着的（都不属于本仓可自行推进的）**

1. **#23 Windows 渲染层 11 分钟零心跳** —— 等那台机器的日志/现场包（`tree_cpu=<ms>/<窗口s>`）。
2. 群侧盘满的端到端（真盘 + 群多跳）。
3. ~~64 处转换缺「失败不改控制流」的运行时判据~~ —— **已补（5.15.72，§4.0bc）**：扫块体断言「分支只许留痕、不许 return/break/continue/`?;`」，另加 `log_write_failure` 调用计数 ≥ 64。
4. 盘满删除时接收器句柄仍开着（Windows 未坐实；std 打开方式含 `FILE_SHARE_DELETE`）。
5. ~~L2 里 pragma 四条的可选留痕~~ —— **已核查并修第四条（5.15.73，§4.0bd）**：前三条早有读回校验；WAL 失败后那句 `synchronous=FULL` 原先 `.ok()` 掉却照样声称「已提到」，现改为读回决定措辞。

### 4.0bc 64 处写库留痕的运行时/结构判据（5.15.72）

- 判据 `every_db_write_failure_branch_only_logs_and_never_changes_control_flow`：对生产源里每个
  `if let Err(e) = db::…` 的**块体**，① 必须留痕（`log_write_failure` / `logger.` /
  `terminal_ledger_failure_note`）；② 不许出现 `return` / `break` / `continue` / `process::exit` / `?;`。
- 计数下限卡在**实测值 64**（加新转换要 +1；调小＝承认撤回），补上 `.ok();` 棘轮的那半边
  （`let _ = db::x(..)` 能绕过语句形态的棘轮）。
- 变异两条各点名红：回退一处 ⇒ 「只有 63 处在用 log_write_failure」；失败分支加 `return;` ⇒
  「失败分支里出现了 return」。
- 量具两个坑：按字节切块体会被中文注释打断（改 `Vec<char>`）；子串计数把文档注释的示例算进去，
  让「少一处」被抵掉（改成只数行首）。

### 4.0bd pragma 留痕核查（5.15.73）：前三条早已有读回，第四条在说假话

- 核查结论：`journal_mode` / `synchronous` / `foreign_keys` 三条在 `.ok()` 之后**都有读回比对**
  （不对就 push `DB_DURABILITY_DEGRADED` / `DB_FOREIGN_KEYS_OFF`），所以「吞掉」只是写法，不是缺陷。
- 真正的缺口在**第四条**：WAL 没开成时把 `synchronous` 提到 `FULL`，结果 `.ok()` 掉，
  而通知已写「已把 synchronous 提到 FULL」——设不上就是假话，而掉电安全正取决于它。
- 修法：先设再**读回**，措辞由纯函数 `durability_after_wal_failure(journal, raised)` 决定；
  读回非 2 时 push `DB_DURABILITY_NOT_RAISED` 并直说「掉电可能损坏、请移回本地盘」。
- 判据 `durability_notice_follows_the_read_back_value`（真值表 2 / -1 / 0 / 1 / 3）；
  变异放宽条件 ⇒ 点名。棘轮 15→14。

### 4.0be v5.15.74 发版前 review：四处都在上一版新加的判据里

- **扫描器漏两类写法**：`if let Err(e) = ` 后紧接 `db::` 的假设，让两处**换行写**的分支整体被跳过
  （在那两块加 `return` 判据仍绿）。改成 `)`/`=`/`=` 之后都允许任意空白与换行。
- **绑定名与上抛**：`Err(source)` / `Err(err)` 合法；`state.rs` 的设备标识写入失败**刻意 `return Err`**。
  「不许改控制流」只对**调 `log_write_failure` 的那一族**成立，别的族只要求留痕。
- **掉电通知三档**：读回失败（-1）≠「没提上去」⇒ `DB_DURABILITY_UNKNOWN`；`>=2`（含 EXTRA）才算提上去。
- **文档边界**：不剥离内联 `#[cfg(test)]`（当前 0 命中），红时先看归属。

### 4.0bf v5.15.74 发布事实与三条「本机不可验证」的具名遗留

**A. 版本身份**

| 项 | 值 |
|---|---|
| 提交 | `c82e96f1`（fix(guards)：发版前 review 四处 `[plan]`） |
| 附注 tag | `v5.15.74` → `ee84d409` |
| 资产 | **17** 个（APK 2 + sha256 2 + app.tar.gz 2 + sig 2 + dmg 2 + setup 4 + sig 2 + latest.json） |
| `latest.json` | version 5.15.74；darwin-aarch64 / darwin-x86_64 / windows-x86_64 / windows-aarch64 四平台签名长度 404 / 404 / 420 / 424 |
| draft / prerelease | false / false；更新说明已手写覆盖；Latest 指针现指向本版 |

**B. 门禁账（本轮实测）**

- `verify:full`：**27 步通过，1227.5s**。比 v5.15.71 那轮（168.4s）长，原因不是卡死：第 26 步
  「护栏非空转（前端子集）」在本机把一份 LTO 依赖编成了 release 二进制（`/tmp/gs-at-74`，首跑无缓存）。
- `verify:release`：**4 轮 25 / 23 / 38 / 49 条断言全绿**，226.3s，退出码 0（裸取，不过管道）。
- release 二进制：`cargo build --release --features bluetooth` 4m48s，退出码 0。
- 推送后 `c82e96f1` 的 7 条 check-run 全 success；`挂到 GitHub Release` 按既有条件 skipped（非 tag 推送）。
- tag 拉起的 6 条 workflow（Verify / Build macOS / Build Windows / Build Windows+WebView2 / Build Android APK / Publish updater manifest）全 success。

**C. 三条遗留：都写明「本机不可验证」而不是「已修」**

| # | 事项 | 为什么本机不可验证 | 要什么才能收口 |
|---|---|---|---|
| 1 | Windows 渲染层 11 分钟零心跳（任务 #23） | 需 Windows 真机复现；本机无 WebView2 | 那台机器上 `tree_cpu=<ms>/<窗口s>` 那一行（`<窗口s>` 与 `<ms>` 同量级 ⇒ 卡死；差几个数量级 ⇒ 挂起） |
| 2 | 群侧盘满端到端 | 判据只钉到形状层（条件按码判/支内删/三态日志/值判据），真写满盘 + 群多跳链路没跑过 | 一块能写满的卷 + 三个实例；macOS 可用 `hdiutil` 造小卷近似，但盘满错误码路径与 Windows 不同 |
| 3 | 盘满删除时接收器句柄仍开着（Windows） | 依赖 Win32 共享语义（std 打开含 `FILE_SHARE_DELETE`），本机文件系统不这样判 | Windows 上「删 `.part` 返回共享冲突」的真日志 |

前两条已在 §4.0bb-E 登记；本节把措辞从「等日志」改成**可执行的判读规则**，避免下次又被当成待办重开。

### 4.0bg 五个 FINDINGS 的 58 条 ID 全量清点：六条从未被裁决，六条只有题没有判

**A. 分母怎么来的**

| 文件 | ID 数 | 已有裁决措辞的 ID | 从未出现的 ID | 提到过但没有裁决的 ID |
|---|---|---|---|---|
| functional | 6 | 2 | 0 | FUN-02 / FUN-03 / FUN-05 / FUN-06 |
| security | 12 | 12 | 0 | 0 |
| stability | 8 | 6 | 0 | STB-07 / STB-08 |
| tests | 16 | 10 | **TST-11…TST-16（6 条）** | 0（TST-10 的裁决在 §4.0d：「设计使然」） |
| dup | 16 | 16 | 0 | 0 |
| **合计** | **58** | **46** | **6** | **6** |

判法：把每个 ID 在本文里命中的行连同前后各两行取窗口，窗口里出现「已修 / 已收口 /
不成立 / 判不修 / 不做 / 已撤回 / 已删」这类措辞才算有裁决。B1–B4 那 16 条属另一批，账在 §4.0ag，不在本表。

**B. TST-11…16：六条「Needs verification」的复核结论**

| ID | 原判 | 复核结论 | 证据（现算） |
|---|---|---|---|
| TST-11 尺子可能读错函数 | Needs verification | **风险成立、当前无害** | `rust_fn_body` 用 `find(signature)` 取**第一次出现**；`rust_fn_body(` 调用点 **147** 处、去重签名 **97** 个；机械解析到源的 85 处里**有 3 处歧义**：`commands/logs.rs` 的 `open_group_todos_window`（`:817` desktop / `:1084` mobile）与 `prewarm_aux_windows`（`:1201` / `:1296`）是 `#[cfg(desktop)]`／`#[cfg(mobile)]` **同名双胞胎**。三条判据（`lib_window_tests.rs:684/761/851`）断言的全是 desktop 行为，而首次出现恰好就是 desktop ⇒ **今天读对了**。但没有任何机制保证这一点：谁把 mobile 桩挪到前面，三条判据会静默换对象。修法（未做）：`rust_fn_body` 对「签名出现 N>1 次」直接 panic。 |
| TST-12 `skip/todo/only` | 干净 | **确认干净** | `grep -E '\.(skip\|todo\|only)\(' '**/*.test.ts'` → 0 命中；阳性对照 `test.skip(1)` → true |
| TST-13 快照机制 | 干净 | **确认干净** | `assert.snapshot(` / `toMatchSnapshot` 在 `src`+`scripts` 的 `.test.ts` → 0 命中；阳性对照 true。`RuntimeSnapshot` 那些命中是业务名，不是测试快照 |
| TST-14 时间依赖 | 未验证 | **确认安全** | 现读 **9** 个文件（审计当时写 12，已漂）：4 处在**字符串字面量**里（`designGuards:3788`、`defer:292/293/356/357`）、2 处是注释、1 处 `setTimeout(r,0)` 让出调度；真实时钟只有三处且都有余量——`todos.test.ts:863` 用 0 天 / 8 天做相对比较（阈值 7 天）、`time.test.ts:58` 取「正午」避跨日、`updater.test.ts:112` 断言 10 ms 超时在 1 s 内结束；`chatSearchQuery.test.ts:47` 的 `waitFor` 是 1 s 上限轮询。 |
| TST-15 文件系统依赖 | 未验证 | **确认不写仓库** | 写盘只发生在 **2** 个脚本测试（`scripts/updaterManifest.test.ts`、`scripts/publishRelease.test.ts`），目标全部来自 `mkdtempSync(join(tmpdir(), …))`；`src` 下没有任何测试写文件 |
| TST-16 网络依赖 | 未验证 | **确认无实连** | `fetch(` / `XMLHttpRequest` / `new WebSocket` / `net.connect` / `http(s).request` 在 `.test.ts` → 0 命中；阳性对照 true |

**C. 六条「提到过但没有判」的补判**

| ID | 现在怎么判 | 证据 |
|---|---|---|
| FUN-02 收藏页图片转发同源缺陷 | **已修** | `FavoritePanel.vue` 的 `doForward` 与 `ChatWindow.vue` 共用 `isTransferKind`（唯一出口 `src/utils/messageKinds.ts:176`），媒体按收藏副本重发并在注释里写明「不传 msgId」的理由 |
| FUN-03 BLE 构建门控看不出差别 | **已修** | `NetworkSection.vue:489-491` 分两档文案：`compiled-out` → 「蓝牙后端尚未编译」、`noAdapter` → 「没有适配器」 |
| FUN-05 移动端角标空实现 | **维持原判（Info，设计内）** | `useChatStore.ts:407` `if (app.isMobile) return;` 先返回，不发 IPC；命令侧移动端本来就是桩 |
| FUN-06 转发逻辑三处各写一份、已漂移 | **根因已消除，剩两处刻意不同** | kind 判据收成单一出口 `isTransferKind`；两份 `doForward`（`ChatWindow:1255` / `FavoritePanel:593`）语义本来就不同（前者转发原消息带 `msgId` 走归属闸，后者重发收藏副本不带 `msgId`），两边注释都写明了 |
| STB-07 补递缓存 TTL 与窗口不同源 | **不成立（复核后撤回）** | `GossipRelayCache` 没有第二个 TTL：`worth_replaying` 用的就是 `RELAY_WINDOW_MS`（`mesh/gossip_replay.rs:34/137`），缓存窗口与补递窗口是同一个常量 |
| STB-08 每 30 s 在锁内 clone 全表 | **仍存，可接受（Info）** | `outbox_sweep.rs:118-133` 仍是「clone 后立刻 `drop(links)`、再持 `peers` 锁只读 `last_seen`」；集合大小 = 在线 peer 数（peers 有淘汰），每 30 s 一次 ⇒ 无界增长与锁跨 await 都不成立 |

**D. 仍未被动过的真缺口**：TST-11 的修法（`rust_fn_body` 断言签名唯一）—— 它要动所有 147 个调用点里
那 3 个歧义点的取法，属独立的判据改造，本轮只登记不实施。

### 4.0bh 主线转绿的三笔（2026-10-31，全部由本地门禁实测）

| 提交 | 红在哪 | 根因 | 修法 | 证据 |
|---|---|---|---|---|
| `291370b6` | 前端测试 + 护栏非空转 | 事件扫描器扫**测试分册**，从 `!restore_f.contains("emit(")` 这句断言里截出假事件名 `'), '`（A10 新加的形状） | `collectRustFiles` 排除 `_tests.rs` / `tests.rs` / `lib_tests.rs`；新增一条用例：三类分册名必被排除、三类生产码不许排除、真实扫描面一个测试分册都没有 | `node --test src/api/events.test.ts`：`✔ 每个 Rust 事件都必须有前端消费者` |
| `04499783` | Android 编译门禁（默认 feature 与 bluetooth 两条腿） | `tauri-plugin-window-state` 整个 crate 是 `#![cfg(not(any(target_os = "android", target_os = "ios")))]`（移动端是空 crate），A7 的 `window_state_filename()` 只挂了 `cfg_attr(mobile, allow(dead_code))` ⇒ 移动端照样引用 `DEFAULT_FILENAME` | 函数改 `#[cfg(desktop)]`（调用点本来就在 `#[cfg(desktop)]` 块里） | `bash scripts/check-mobile.sh`：**PASS（0 warning）** |
| `d6c606f7` | Rust 单测（fmt --check） | 上一条新加的注释续行没按 rustfmt 对齐 | 按 rustfmt 对齐 | 隔离 worktree 跑 `cargo fmt --check --all` 退出码 0 |

**两条方法教训（都是本项目付过钱的形状）**

- **扫描器的"只扫生产码"要写成判据**：`emit` 扫描器此前把 `_tests.rs` 也算进"后端在发"，而测试里天然会有 `contains("emit(")` 这种**字符串断言**。这次是加一条真实树断言的直接理由。
- **`git commit -- <path>` 提交的是工作树内容，不是暂存内容**：共享工作树里隔壁有 315 行未提交改动时，用它会把别人的 WIP 一起卷进来（实测发生过一次，已 `reset --soft` 撤回）。正确姿势：先 `git show HEAD:<path>` 造底本、只改自己那几行、`diff` 出单块补丁、`git apply --cached`，再**不带路径** `git commit`。

### 4.0bi #23 现场取证单（Windows 渲染层卡死）：抓哪几行、怎么判

**这一步不需要改代码，只需要把那台机器上的三行日志取回来。** 取证通道现成：

| 取什么 | 在哪 | 为什么是它 |
|---|---|---|
| `gosslan-crash.log`（多开是 `gosslan-<n>-crash.log`） | `%APPDATA%\com.gosslan.app\logs\`（`log_dir_in` = `<app_data>/logs`，`crash_file_in` = `<app_data>/logs/<stem>-crash.log`） | 这是**不轮转**的现场文件；`gosslan.log` 超 512 KiB 就转且只留一代，卡死那 20 分钟的走势只有在现场文件里 |
| `gosslan.log` / `gosslan.old.log` | 同一目录 | 轮转档，补 `.old` 里更早的部分 |

**抓三行**（在 PowerShell 里）：

```powershell
$d = "$env:APPDATA\com.gosslan.app\logs"
Select-String -Path "$d\gosslan-crash.log" -Pattern '>>> code=(HANG|RUNTIME_MEM)' |
  Select-Object -Last 40 | ForEach-Object { $_.Line }
```

- `>>> code=HANG scope=ui_renderer seconds=… last_op=… last_op_age_s=…` —— 渲染层心跳断了的判定行
  （阈值 `RENDERER_STALE_MS = 3000`；10 秒时还会弹一次系统通知，`NOTIFY_AT_MS = 10_000`）。
  `last_op` 是**最后一次执行到的操作名**，`last_op_age_s` 是它距判定时过了多久。
- `>>> code=HANG scope=main_thread …` —— 主线程卡死（与渲染层是两条独立腿）。
- `>>> code=RUNTIME_MEM …` —— 每 5 分钟一行，同一行里带 `tree_procs` / `tree_private_commit` /
  `gdi_objects` / `user_objects` 与 **`tree_cpu=<ms>ms/<窗口s>`**。

**判读（只看 `tree_cpu` 那个比值）**：`tree_cpu_ms ÷ (window_s × 1000)`

| 读数 | 含义 | 下一步 |
|---|---|---|
| ≈ 100%（ms ≈ 窗口秒数 × 1000） | JS 主线程在**空转**（死循环 / 线性回溯正则 / 布局环形依赖） | 按 HANG 行里的 `last_op` 定位代码；这片是「卡死」 |
| 0ms | 整棵树**一个指令都没执行**（进程被挂起，或 WebView2 `ProcessFailed` 后不再驱动它） | 看同一行 `tree_procs` 是否还在、`tree_private_commit` 是否冻住；这片是「挂起」 |
| 几十 ms | 活着且空闲 —— 问题**不在这棵树** | 去查 `HANG scope=main_thread` 那条腿 |

**顺带看两项泄漏指标**：`tree_procs` 逐格上涨＝渲染进程在增殖；`gdi_objects` / `user_objects`
只涨不回落＝窗口站/用户对象泄漏（Windows 每进程默认 10 000 上限，到顶就创建不了窗口，
表现同样是「界面不动」）。

**打包**：整个 `logs\` 目录 + 卡死发生的本地时间 + 当时是否在传大文件（这三件事齐了才能把
`tree_cpu` 的窗口对齐到具体操作）。把这三样取回来，本条就能一次定型；在那之前**不猜修法**。

### 4.0bj A2 启动错误窗的只读复核（2026-10-31，`c96fbdbe`）

范围：24 文件、+1369/−331（`startup_error.rs` 新增 338 行；`lib.rs` 把 setup 收尾抽成 `finish_boot`）。

**逐点对账（读代码，不改代码）**

1. **`finish_boot` 有没有漏步骤** —— 与旧 setup 逐项比：`AppState::init 完成` 留痕、panic hook 重装、
   `worker_supervisor::start`、`app.manage`、`restore_pending_requests`、`watchdog::start`、
   `tray::setup`、macOS 菜单、macOS `set_closable(true)` —— 九项都在，且顺序与 E2E 的 `BOOT_LINE` 依赖一致。
   复跑（对 `c96fbdbe^` 与当前 `lib.rs` 各数一遍九个锚点，九个数逐个相等；`tray::setup` 各是 2，
   因为「开始 tray::setup」那条日志文案也含这个名字）：
   `git show c96fbdbe^:src-tauri/src/lib.rs > /tmp/lib_pre.rs` 后按上列九个字符串对两个文件 `count` 对账。
   旧路径被删掉的是 `tauri_plugin_dialog().message(...)` 那支与内联文案构造；文案已抽成
   `boot_failure_message`，内容逐字保留（错误码 `BOOT_FAILED`、数据目录、日志目录、「本次启动没有删除或覆盖你的数据」）。
2. **重试门控** —— `retry_gate` 先拒「已恢复」再拒「在途」，`claim_retry` 用 `swap(true)` 抢槽；
   成功分支置 `resolved` 后置 `retrying=false`，两步之间再来一次点击会被 `resolved` 拒掉。正确。
3. **退出路径** —— `app.exit(0)` 而不是 `process::restart`，保住 A5 的「上次是干净退出」标记。
4. **错误窗不在 capability 里**（`capabilities/default.json` 只列 `main/settings/logs/preview/tasks`）——
   **今天安全的前提是**：这页的 import 只有 `@/api`、`@/boot/boot` 的 `dismissBoot` 与它自己的 css，
   调的全是应用命令（`startup_error_info` / `retry` / `open_data_dir` / `quit`）；
   Tauri v2 的 ACL 只管插件与 `core:` 命令，应用命令不受 capability 约束。**若将来有人在这页加
   `dialog` / `window` 之类插件调用，会被 ACL 直接拒** —— 那时必须先把这扇窗登记进 capability。
   四条命令名在**三处逐字对上**（2026-10-31 现读）：`src/api/index.ts:651/656/658/660` →
   `startup_error.rs:141/162/177/197`（桌面）与 `:272/279/286`（移动桩）→ `lib.rs:749-752` 的
   `generate_handler!` 四条。名字漂一处就是"按钮点了没反应"，而这条链上没有任何运行时报错可看。

**两条留到真窗口验收去确认（不属于静态可判）**

- `resolved = true` 写在 `run_on_main_thread(...)` **之前**：万一主线程调度失败（返回 `Err`），
  二次重试会被拒并说「应用已经恢复正常」，而实际上一次都没恢复 —— 只剩「打开目录 / 退出」可用。
  **确切补丁（2 行，等下一次 `Version-Bump` 一起落）**：把那段 `if let Err(e) = host.run_on_main_thread(..) {`
  的错误分支从「只 `return Err`」改成先复位两格再返回：

  ```rust
  if let Err(e) = host.run_on_main_thread(move || { … }) {
      // 调度失败＝这一次并没有恢复：不复位的话下一次重试会被 `retry_gate` 拒掉并回
      // 「应用已经恢复正常，无需再重试」—— 那是假话，用户只剩「退出」一条路。
      failure.resolved.store(false, Ordering::SeqCst);
      failure.retrying.store(false, Ordering::SeqCst);
      return Err(format!("恢复主线程调度失败：{e}"));
  }
  ```

  `failure` 在闭包里没有被捕获（闭包只拿 `host/inner/state`）⇒ 这两行直接编译，不改任何接线；
  接线判据那句 `retry.contains("failure.resolved.store(true")` 也不受影响（置真那行原样保留）。
  **已于 2026-10-31 落地**（5.15.91 / `16e00f5e`）：按本仓规则同提交做了补丁级 `Version-Bump`
  与五处版本清单；现跑 `startup_error` 6 passed、`cargo test --lib` 1355 passed / 0 failed、
  `cargo clippy --all-targets -- -D warnings` 0、`cargo fmt --check --all` 0。
- ~~成功路径靠「主窗口 `reload()` → 前端自己 `focus_window` 显示」~~ —— **2026-10-31 真窗口实测已确认**：
  坏库场景下（隔离 HOME、实例 91/92、release 5.15.92）① 错误窗真的出现（AX 读到
  `0:Gosslan — 启动失败`）；② 点「重试」在同一次进程内失败 ⇒ 日志 `重试仍然失败：` 计数 1、窗口留在原地；
  ③ 点「退出」⇒ 进程结束（`processAlive=false`）；④ **把坏库删掉再点「重试」⇒ `AppState::init 完成` 计数 1、
  窗口标题从 `Gosslan — 启动失败` 变成 `Gosslan`**（错误窗销毁、主窗显示），进程仍活着。
  ⇒ 「重试成功」那一格不是设计意图，是屏幕上真实发生的事。
- **`perms`（数据目录不可写）也实测通过**：错误窗出现，stderr 里有
  `code=BOOT_FAILED 启动失败：初始化目录失败 …/downloads: Operation not permitted` 与两行目录、以及
  「本次启动没有删除或覆盖你的数据」。此时 crash 文件写不进去是**预期**（目录只读），stderr 是唯一通道。
- **`busy`（库被独占锁）这一格目前被脚本自身卡住**（2026-10-31 实测，两处都记下来）：
  ① 原样 `launch --break busy` **永不返回** —— 锁进程的管道替 node 维持了事件循环；
  ② 只把子进程与 stdin `unref`、stdout 改 `ignore` 后 `launch` 能返回，但 node 一退出，
  sqlite3 的 stdin 收到 EOF ⇒ **锁随之消失**，库正常打开、主窗出现（**假绿**）。
  正解是把锁**托管给一个 detached 的持有进程**（例如 `node -e` 内 spawn sqlite3 并自挂长计时器），
  `launch` 只写它的 PID。⇒ 这格留给脚本作者按这个形状重写，产品侧未被判红也未被判绿。
- **`busy`（库被独占锁）实测通过**（2026-10-31，绕过脚本自己造锁）：用一条 held-open 的
  sqlite3 会话 `begin exclusive` 锁住库（负对照：另开连接直接报 `database is locked`），
  再在同一隔离 HOME 起应用 ⇒ 应用**照常开出 `Gosslan — 启动失败` 窗口**且进程活着。
  ⚠️ 本轮中途曾误判成「应用直接退出、没有窗口」——那是**量具读错对象**：他们的 `status`
  从隔离 HOME 里的 `.qoder-a2-pid` 取 PID，而手起的进程没写这个文件 ⇒ `alive()` 拿 `null`
  报 false、AX 也按空 PID 查。补写 PID 文件后窗口当场读到。同类坑记两次：手动起的实例必须
  自己写 PID 文件，否则 status 的 `processAlive`/`windowTitles` 一概不可信。
- 他们脚本的 `launch --break busy` 本身仍不可用（见上两条），但**产品这一格是过的**；
  脚本要修的是"锁的托管方式"，不是产品。
- 小坑：`press` 紧跟在 `launch` 之后偶尔 `hitCount=0`（AX 树未就绪），先 `list` 一次再按即可。
- **`readonly`（库文件 0444）实测通过**：错误窗出现，stderr 有
  `[gosslan]初始化/升级本地数据库表结构失败，已中止启动。`
- **正常启动 + 多实例实测通过**：正常实例开主窗 `Gosslan`（`AppState::init 完成` 计数 1）；
  两实例并发时 97 开错误窗、98 开主窗，**互不影响**（各自 `processAlive=true`）。
- **单实例那格单独手跑通过**：同一个隔离 HOME、**不带** `GOSSLAN_INSTANCE` 起第一份，
  再起第二份 ⇒ 第二份 **0 秒内退出码 0**，第一份仍活着（只有一扇窗）。该脚本本身测不到这格，
  因为它总会设 `GOSSLAN_INSTANCE`，而 `allow_second_instance_launch` 对"显式实例档"是放行的
  （开发多开的设计行为）。
- **A7 三项全部实测通过**（2026-10-31，隔离 HOME + 唯一实例）：
  · **恢复**：只放 `.window-state-i97.json`（560×420@260,260）⇒ 窗口读到 **280×210@130,130**
    （AX 报**点**、插件存**像素**，Retina 2x 下正好 ÷2）；只放 `i96`（640×480@300,300）⇒ **320×240@150,150**。
  · **保存 + 分文件**：Cmd+Q 优雅退出后 `i97` 被重写（`prev_x/prev_y` 更新），`i98` 哈希逐字未变。
  · ⚠️ **两次假读数的根因是同名残留进程**：`osascript ... process "gosslan"` 按**进程名**找，
    而上一轮隔离实例还活着 ⇒ 量到的是旧实例的窗口（320×240），不是新起的那个。
    ⇒ 铁律：**同名进程要一台一台来；测前先 `pgrep` 数 0，测后按 PID 杀净**。
    （量纲坑同样记牢：不比换算就会把对读成错、把错读成对。）

**结论**：未发现需要立刻改代码的缺陷；第 4 条写成了维护约束，最后两条进 A2 的真窗口验收观察点
（验收脚本在 A2 那一批里，**尚未入库** ⇒ 本文不引用它的路径：引用未入库文件会让文档引用对账在干净检出上红）。

### 4.0bk A4 / A10 两批用户可见改动的只读复核（2026-10-31）

| 批 | 改了什么 | 复核到的关键链 | 结论 |
|---|---|---|---|
| **A4**（`cb002e3c`） | 入站好友申请从"只存内存"改成 `settings['friend_req:<id>']` 落库；启动时 `restore_pending_requests` 只填表 | 写/删/恢复各只有一个调用点（`put_friend_request` / `forget_friend_request` / `restore_pending_requests`）；恢复体里**没有** emit 与两个通知入口（`lib_friend_identity_tests.rs` 那条接线判据逐字钉）；恢复位次在 `manage` 之后、联网之前；`clear_all_data` 按前缀整批抹 | 设计自洽；"重启不重复弹窗"靠的是"恢复只填表、补发到达时 insert 返回 Some ⇒ 走 SilentRefresh"，这条与代码一致 |
| **A10**（`437d7667`） | 发起方收到 `FriendAccept` 回执后也 `ensure_conversation` | `INSERT OR IGNORE`（用例钉住：连 ensure 三次只有一行；已有摘要/未读/名字一个字不动）；调用在 `apply_friend_accept` 的库事务块内，**早于** 同函数末尾的 `emit("friend-accepted")`；前端 `onFriendAccepted` 同时 `refreshFriends()` + `refreshConversations()`（`useChatStore.ts:3013-3016`） | 用户能立刻看见新会话，不需要重启；空会话按既有空态显示 |
| **A5**（`1a55241b` 同批） | 全新安装首启不再误报「上次运行异常退出」 | ① 写入侧：`lib.rs:265` 的 bootstrap 行确实带 `pid={}`；② 切片侧：`prev` 为空时按「有没有别的 pid 的启动尝试」二分——只有自己的 ⇒ 空切片 ⇒ `NoHistory`，有别人的/旧版无 pid ⇒ 整段交给分类器 ⇒ 仍判 `silent_kill`；三格用例逐格钉（`first_run_is_no_history_while_a_foreign_bootstrap_still_reads_silent_kill`）；③ 前端：`shouldShowCrashNotice("no_history") === false`（`crashReport.test.ts:38`） | 静默死亡检测**没有被顺手关掉**；三段静态链闭合；**第二侧已于 5.15.92（`46f41213`）补齐**：`seed_previous_run` 写日志文件的那条判定此前仍按 raw 过滤，全新安装会落一条假的 Warn「异常终止 code=BOOT_PREV_SILENT_KILL」——现改为「候选内容全是本进程启动尝试时整块跳过」，并用例正反控钉住（本进程 pid ⇒ 不写；外来 pid ⇒ 仍判异常终止）。**真隔离 HOME 首启 A/B 已补**（2026-10-31）：5.15.91 首启日志含 1 行假的 `BOOT_PREV_SILENT_KILL`，5.15.92 同形状为 0 行 |

**共同缺口（不是缺陷，是未验）**：A4/A10 的提交正文都写明"双实例真机流程（加好友→同意→重启）本机未验，留到第 3 批 release 产物一起补"；
A5 缺的是"真隔离 HOME 首启不弹横幅"的一次实跑读数。⇒ A4/A10 进 §13 第 7 项、A5 进第 8 项。
A4/A10 真机验收要看三件事：① 申请人重启后那条申请还在且**不重复弹通知**；
② 同意后**两侧**都出现空会话、且来回各发一条后摘要正确；③ 拒绝/同意后库里 `friend_req:` 行确实消失。

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
> ⚠️ **本节记的是审计当时的发现。今天哪些已经落地、哪些判了不修，一律以 [§8 落地状态总表](#8-落地状态总表2026-10-29-深夜按现算对账) 为准** —— 「确认」「无机器对账」「零用例」这类字样不代表今天还没做（本轮对账实测：§8 的 19 行里有 9 行在写这张表时其实已完成）。


对 `docs/protocol-invariants.md` 的 **36 条 INV-P** 逐条做规范-代码对账（每条一个独立分析文件，在 `audit-context/spec-compliance/`）。结果：

| Verdict | 条数 | 编号 |
|---|---|---|
| implemented | 30 | P01–P15、P17、P19–P26、P28–P35 |
| **partial** | **4** | **P16、P18、P27、P34** |
| contradicted / absent / stronger-than-spec | 0 | — |

**已确认的 4 条 partial**：

| ID | 偏差 | 证据 |
|---|---|---|
| **P16** | 原状：五档里 `recoverable`/`user_action_required`/`security_related` **全仓 0 命中**，只有文件/内容传输族有真分类。**2026-10-29 已把口径写实**（负责人选"窄口挂码"而不是全面铺开）：内部收尾判断本来就是结构化的（`send_retry_verdict` 吃 `SendFileError{retryable,cancelled}`、台账走 `FailReason` 九档），需要修的只有"**界面按中文文案分支**"那两处 ⇒ 新增 `error_codes.rs`（`E2EE_PUBKEY_MISSING` / `PORT_IN_USE`）+ 前端 `CODE_RULES` 先按码分类 + 双向对账判据。OS/第三方串仍走签名兜底（那不是分类器）。**同日晚补上第二条通道**（§4.0j）：`禁止 Err → failed` 按"状态不拆档、原因必须有码"执行 ⇒ DB v14→v15 给 `messages` 加可空 `fail_code`，四格消息级终态各带自己的码，界面 tooltip 从「发送失败」变成「发送失败：<为什么>」 | `src-tauri/src/error_codes.rs`、`src/utils/errors.ts`、`src/utils/fileFailReason.ts` |
| **P18** | **只剩半条**（2026-10-29 分两批落地）：判据 A/B 真实存在且已接门禁（96 类型 + 169 命令体，0 违规），判据 C（落点边界）已加（5.15.18），`x25519_secret` **已私有化**、ECDH 只从 `Identity::dh()` 出去。仍开的只有 **Ed25519 私钥字段是 `pub`** —— 前置是「签名能力」抽象，否则每个调用点都得拿到能签的东西（复跑 `grep -n "pub ed25519_signing" src-tauri/src/crypto.rs`） | `src-tauri/src/crypto.rs`、`scripts/check-key-boundary.mjs` |
| **P27** | 已读与红点共用 `chatViewerLooking()`，但**系统通知那一族四处**（`useChatStore.ts:326/481/500/661`）用 `!document.hidden && document.hasFocus() && activeConv===conv_id` —— 第三个条件是子集，守卫只数 `!document.hidden && app.chatVisible` 这个组合所以看不见 | `src/stores/useChatStore.ts` |
| **P34** | 原状：十二处慢活逐格在池内、位置断言在、`Err` 不伪装成 `Ok`；但文档规则 6 写死的"现算处数 17"与判据实际钉的 **18** 不同步。**2026-10-29 晚已改文档（17 → 19，与判据同句说明"法条上的数要跟着判据走"）**；STB-01 那处 `write_all(` 已随 5.15.10 收进 `PRIMITIVES` | `docs/protocol-invariants.md` vs `lib_relay_data_tests.rs` |

### 5.1 规范与代码的分歧（不绑定到单条要求）

> **2026-10-31 订正状态**（本轮只动文档）：① 行号与 `[dev-dependencies]` 断言已改对——`AppState` 现址 `state.rs:1062-1063`、`init` 现址 `state.rs:1838`，且 `src-tauri/Cargo.toml:194-196` **有** `[dev-dependencies]`（`tempfile`）；
> ② `peer_keys_trusted` 已改成 `FriendKeySnapshot::capture` + `acceptable_friend_keys` 并注明旧名；③ INV-P03 已加一段写明那三条 Ack 钩子判的是**群文件**回执、1:1 唯一真调 `ack_delivered` 的用例是 `db::cascade_tests::a_late_ack_cannot_promote_a_cancelled_message`、「非收件人 / 发送者校验」没有专属用例；
> ④ INV-P12 的钩子行已补 `state::tests::device_id_is_persisted_once_and_never_rederived_on_restart`（TST-08）并写明「后者三条各证什么」；⑤⑦ 复核**仍成立**、但原路径/行号已漂——BLE 直接解析现为 `network/ble/central.rs:372`／`:686` 与 `network/ble/peripheral.rs:278`，TTL 生产构造在 `state.rs:2229`；⑥⑧ 复核**仍然成立**——⑥ 的机理注释仍在 `lib_delivery_shape_tests.rs:417-430`（结论不变：逻辑序号不保证跨离线时间序），⑧ 的两帧分别发在 `handle_messaging.rs:118` / `:256`（`Message::Ack`）与 `gossip.rs:1386`（`GossipKind::ChatAck`），发送方状态只按「已读优先、不回退」的过渡算一次。

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
> ⚠️ **本节记的是审计当时的发现。今天哪些已经落地、哪些判了不修，一律以 [§8 落地状态总表](#8-落地状态总表2026-10-29-深夜按现算对账) 为准** —— 「确认」「无机器对账」「零用例」这类字样不代表今天还没做（本轮对账实测：§8 的 19 行里有 9 行在写这张表时其实已完成）。


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
| DUP-02 | ~~High~~ **复核后判「不再统一」**（四套文案讲的是四件事，见 §4.0l） | **通道判据已收一处（5.15.9）；越权闸两条入口已一致（5.15.15，见 §4.0f）**；本报告原话「剩下未统一的是缺失路径的提示文案三套（各落点各写一句 toast）」**不准确** —— 逐条读实现后是四件不同的事实（会话媒体被清理 / 收藏自己那份副本 / 本机尚未同步 / 原消息已不在），合并会让其中两三格对用户撒谎。防复发：`src/utils/mediaAvailability.test.ts` 三条新判据（特征词、收藏那句的「副本」必须由代码兑现、引用面不跨界），①③ 做过注入自证、② 只有内联反控（未对 `favorites.rs` 变异） | `src/utils/mediaAvailability.test.ts`、`src-tauri/src/commands/favorites.rs` |
| DUP-03 | ~~Medium~~ **已修（5.15.26）** | 墙上时钟 `fn now_ms()` 现数 **9 处定义**，全部读同一个 `SystemTime − UNIX_EPOCH`，彼此唯一差别是兜底写法（`unwrap_or(0)` vs `unwrap_or_default()`）—— 审计与我自己都怀疑过"BLE 那几份可能刻意用单调钟"，**逐处读完否证**：三处 BLE 全是墙上钟，注释还写着"与 macOS 侧同一套回收语义"。收成 `logging::now_ms` 一个家，`db::now_ms` 留作具名别名（理由见 §4.0m）。对照表在 §4.0m |
| DUP-04 | ~~Medium~~ **已修（5.15.25）** | 重复工具 | 字节→小写 hex 的表达式散在生产码与测试里：**现数 20 行、11 个文件（其中 9 个是生产码文件）**，另有三个整份助手（`device::hex`、`relay_seal::channel_hex`、`commands/relay` 的探测串）—— 审计原写「8 份」偏少。收成 `crypto::hex_lower` / `sha256_hex` 一个家。 | `src-tauri/src/crypto.rs`（唯一的家）；复跑 `grep -rn ":02x" src-tauri/src` 改后只剩 `crypto.rs` 两处 |
| DUP-05 | Medium | 重复组件 | **已修（5.15.16，见 §4.0g）**：`LogViewer` 两个外壳各抄一份逐字相同的虚拟行模板（8 个 `v-html` 落点）；矩阵误以为"两条外壳"是迁移前的问题 —— 虚拟化迁了，两份拷贝还在 | `src/components/LogRows.vue`（唯一行模板） |
| DUP-06 | ~~Medium~~ **已修（5.15.28，见 §4.0o）** | 重复组件 | 「表情切段 + 链接/提及切段」的**拼装循环** 3 份同形（两个原语 `utils/emoji` + `utils/linkify` 早就单源，会漂的是拼起来那六行；三份里有一份的表情段少带 `name`）⇒ 收成 `composables/useMessageSegments`；渲染那半（颜色/对比度/副作用）刻意**不**统一 | `src/composables/useMessageSegments.ts`（唯一的家） |
| DUP-07 | Low | 重复逻辑 | ~~@提及的「16% 透明底」配方散在 2 处~~ ⇒ **已收口（5.15.39，§4.0x）**：收成一个家 `chatStyle::mentionHighlightBg`，判据钉「16% 只许出现在 chatStyle」 | `src/utils/chatStyle.ts` |
| DUP-08 | Low | 重复组件 | **已修（5.15.20，见 §4.0i）**：头像渲染 13 个副本各自手写 `gosslan-avatar-box` + `gosslan-avatar-emoji`，圆角漂成 3 种；顺带修掉 `RemindAudienceDialog` 那一处（喂了 `SelfAvatar` 没有的 prop ⇒ 那一列没有头像） | `src/components/ui/AvatarBox.vue`（唯一行像） |
| DUP-09 | **已加对账（§4.0a）** | 已读推进的排除清单 TS 一份、Rust 一份 —— 今天由 `src/utils/messageKinds.test.ts` 的「跨语言契约：已读推进的排除清单两侧逐项一致（DUP-09）」逐项比；变异（TS 去掉 `partial_cancelled`）⇒ 红 |
| DUP-10 | Low | 跨层规则 | 未读计数判据 TS 一份、Rust 一份，今天一致 | 同上 |
| DUP-11 | **已被既有判据覆盖（§4.0a）** | 未知 kind 的判据与占位文案对 `protocol.rs` 的对账早在册（同文件），不另加第二条 |
| DUP-12 | **已加对账（§4.0a）** | `previewBody`（TS）与 `preview_text` / `todo_preview` / `poll_preview` / `announcement_preview`（Rust）的固定字面量由同文件的「跨语言契约：会话预览的固定文案两侧一致（DUP-12）」比；变异（Rust 改一个字）⇒ 红 |
| DUP-13 | ~~Low~~ **已修（5.15.27，见 §4.0n）** | 自研基础设施 | 审计原写「TS 侧三份各自实现的 LRU/容量闸」——**既偏少也偏窄**：按形状现数是**两种策略九处**（丢最旧 5 处 + 满了整张清 4 处），且这两策略**不等价**（同一张表跑 `max=3`，一个活 3 条、一个活 0 条）。收成 `utils/bounded.ts` 的两个出口 `trimOldest` / `clearWhenFull`，另有六格判「不是同一个东西」不收 | `src/utils/bounded.ts`（唯一的家）；复跑 `node --test src/utils/bounded.test.ts` |
| DUP-14 | Low | 重复组件 | `MessageItem` 的「复制 / 保存」动作在右键菜单与移动端 ActionSheet 两套模板里各写一遍 | `MessageItem.vue` |
| DUP-15 | Low | 重复组件 | ~~手抄 1 份~~ ⇒ **复核后判保留**：`FavoritePanel.vue` 是**显式登记**的自研（同一元素 serve 两支布局，理由写在 `designGuards.test.ts` 的 `OVERLAY_SHELL_COPIES` 上方），棘轮判据 ㊼ 钉住「新增同形照旧红」 | `designGuards.test.ts` ㊼ |
| DUP-16 | — | 负面清单 | 未找到重复的实现（避免误报） | — |

**DUP-09～DUP-12 是「今天一致但无机器对账」** —— 这类才是 DUP-01 的真正成因：没有一条守卫断言两侧字面值相同，于是漂移可以悄无声息地发生。

---

## 7. 测试盲区（TST）
> ⚠️ **本节记的是审计当时的发现。今天哪些已经落地、哪些判了不修，一律以 [§8 落地状态总表](#8-落地状态总表2026-10-29-深夜按现算对账) 为准** —— 「确认」「无机器对账」「零用例」这类字样不代表今天还没做（本轮对账实测：§8 的 19 行里有 9 行在写这张表时其实已完成）。


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
| TST-01 | **已修（5.15.11）** | 审计当时：`saveDestination.test.ts` 是生产源码的**逐字节副本**（`diff` 无输出、0 条用例），却计入「测试文件」总数 ⇒ 清单守卫被骗过。今天：换成 3 条真用例（桌面字符串 / Android SAF 的 `{ file }` / 取消与畸形一律 `null`）+ 一条反控。复跑 `grep -c "^test(" src/utils/saveDestination.test.ts` ⇒ 3 |
| TST-02 | High | `useChatStore.ts`（**3471 行，全仓最大未测模块**）零单元测试 —— 只被 `readFileSync` 形状断言引用；含矩阵 `:204` 记的**已出过真机事故**的乐观占位替换 | `src/stores/useChatStore.ts` |
| TST-03 | **已修（5.15.11，按拆腿口径）** | 审计当时两条腿都只在 schedule/dispatch。今天 `guards-web`（node+script，护栏本体实测 13.8s）**每次 push/PR 都跑**，`guards-cargo` 整跑 2h39m 留夜间。复跑 `grep -n "^  guards-\|if: github.event_name" .github/workflows/verify.yml` —— ⚠️ 只看 `guards-cargo` 那条 `if` 会误判成「没做」（本轮就误判过一次） |
| TST-04 | Medium | 好友 **reject** 路径零测试 —— `handle_identity.rs:216-229` 整个臂无 `#[test]`，而它修的正是"已拒绝申请被反复重发"的缺陷 | `src-tauri/src/network/transport/handle_identity.rs` |
| TST-05 | Medium | 群任务的 **CRUD 写路径**（改状态/归档/重开/认领）无独立单测，编号不变性只在跨进程轮 | `src-tauri/src/commands/group_todo_media.rs` |
| TST-06 | Medium | **已量（5.15.46，§4.0ad）并量出真缺陷**：HFS+ 卷上预检高估余量 512 倍（`f_bsize` vs `f_frsize`）⇒ 已修 + A/B 自证；Windows 一半仍无本地判据 | `src-tauri/src/network/file/receive.rs` |
| TST-07 | **已修一半 + 另一半否证（5.15.11）** | 撤回**选档**抽成纯函数 `recall_authority_for` 并补行为用例，形状断言同时钉「命令真调它」两半。审计说的另一处（key-change conflict 只有形状守卫）**不准确**：`new_peer_conflicts_with_friend` 本来就有 6 条行为断言，只有「是否被调用」是形状 |
| TST-08 | Medium | 身份持久化跨重启：无「重启后不再派生」分支的用例，且**代码与需求恰好相反**（`clear_all_data` 不删身份行） | `src-tauri/src/state.rs` |
| TST-09 | Low | Windows 侧缺三类生产行为用例（缓存软链清扫 / 磁盘写失败 / 托盘角标） | `src-tauri/test-baseline.windows.txt` |
| TST-10 | Low | 2 条新 Rust 用例不在基线里；唯一 `#[ignore]` 的真实库迁移演练永不执行 | `src-tauri/src/commands/files_tests.rs` |

**最大未测模块**：`src/stores/useChatStore.ts`（3471 行）。三个 store **全部零运行时 import**；16 个 composables 里仅 `useSubmitGuard` 有真行为测试，12 个只有形状断言，3 个（`useMentionContext`/`useShortcuts`/`useWindowLauncher`）完全无引用 —— 而 `useMentionContext` 正是矩阵 `:200` 点名的"同名两人高亮"那一格的核心。

### 7.3 已核查干净的测试质量面

- `skip`/`todo`/`only` 全仓 **0 处**。
- 无快照测试机制（`node:test` 无内置 snapshot）⇒ 无过期快照。
- 12 个前端测试文件含 `Date.now`/`new Date` —— **未逐条核实**是"喂固定时间戳"还是"读真时钟"，标为未验证。

---

## 8. 落地状态总表（2026-10-29 深夜按现算对账）

> **这一节原来是"建议修复顺序"，只写该做什么、不写做完没有。** 而每一批的复核结论都另记在
> §4.0a～§4.0k，于是读这份报告的人看到的是 19 行待办，其中**大半早就落地了**：对账前实测
> **9 行整行已完成** —— P0 的 1/2/3（SEC-01、SEC-03、FUN-01）、P1 的 4/5/6/8（STB-01、STB-02、
> TST-03、TST-01）、P2 的 16（矩阵勘误）与 18（SEC-08，其实就是第 15 行的一项，重复计数）；
> 另有 5 行做了一半（第 9/10/11/12/15 行）。这就是"下一轮重新发现已完成的工作"的形状
> （本轮之前就真复发过一次：Android 后台承诺被重新发现成"没做"）。
>
> 现在把它改成**唯一的状态表**：`§1/§2/§3/§6/§7` 各节记的是**审计当时**的发现，今天的状态以本表为准。
> ⚠️ 诚实边界：本表是**人工对账 + 每行挂复跑命令**，不是机器判据 —— 没有任何脚本断言"这张表与代码一致"
> （能做这种断言的只有逐行的复跑命令本身）。表里没写的 ID 见 §4.0a～§4.0be 的复核结论。

| 序 | ID | 今天的状态 | 凭据 / 复跑 |
|---|---|---|---|
| 1 | SEC-01 | **已落地**（5.15.8） | `FriendAccept` 查 `pending_requests` + 拒绝留痕；`grep -rn "FRIEND_ACCEPT_UNSOLICITED" src-tauri/src` 现数 2 处 |
| 2 | SEC-03 | **已落地**（5.15.8） | Gossip 锚点与 Hello 同口径只认已验证身份；`grep -rn "keys_verified" src-tauri/src/network/transport/peer_registry.rs` |
| 3 | FUN-01 / DUP-01 | **已落地**（5.15.9） | 转发 kind 白名单收成一家 + 跨层对账；`node --test src/utils/messageKinds.test.ts` |
| 4 | STB-01 / STB-03 | **STB-01 已落地**（5.15.10）；**STB-03 实测后判不修**（§4.0w：release 下单表聚合上限 133.5 MB/s、两条并发 136.9 MB/s ⇒ 高于千兆线；「误判超时」不成立）；量具留在 `stb03_receiver_critical_section_cost`（`#[ignore]`） | `grep -rn "write_group_chunk_blocking" src-tauri/src` 现数 5 处，且已进 INV-P34 的登记格。全局 `file_receivers` 锁那半在 5.15.10 明确记账：要动几十个引用点、只有跨进程 E2E 能证 |
| 5 | STB-02 | **已落地**（5.15.10） | 条数上限 + TTL + 载荷尺寸闸：`grep -rn "MAX_PENDING_FRIEND_REQUESTS\|PENDING_REQUESTS_FULL" src-tauri/src/network/transport/handshake.rs` |
| 6 | TST-03 | **已落地**（5.15.11，按拆腿口径） | node+script 那条腿每次 push/PR 都跑；cargo 整跑实测 2h39m 留夜间。复跑：`grep -n "^  guards-\|if: github.event_name" .github/workflows/verify.yml`（`guards-web` 那job **没有** `if`）⚠️ 只看 `guards-cargo` 的 `if` 会误判成"没做"——本轮我自己就误判过一次 |
| 7 | TST-02 | **已落地**（5.15.41 跨会话三段 + 5.15.42 会话内两处 + **5.15.47 补第 6 个 `onFileCancelled`**，§4.0z/§4.0aa/§4.0ae）：六个 handler 全部走 `utils/messages` 的家；store 里手写 `findIndex(msg_id)` 与 `.find(m => m.msg_id)` 现读都是 0；`onPeerRead` 那处例外（谓词本来就在 `promoteOnPeerRead`） | `useChatStore` 里难的纯逻辑（`replaceOptimistic`）已有真用例，缺的是接线；做成真测试要先给 store 做注入或搬状态机，属独立重构 |
| 8 | TST-01 | **已落地**（5.15.11） | 假测试换成 3 条真用例：`grep -c "^test(" src/utils/saveDestination.test.ts` 现数 3 |
| 9 | TST-07 | **已落地一半**（5.15.11）+ 另一半被否证 | 撤回**选档**抽成 `recall_authority_for` 并补行为用例（形状断言同时钉"命令真调它"）；key-change 那半审计不准确 —— 那条判据本来就有 6 条行为断言 |
| 10 | INV-P16 | **两条通道都已落地**（5.15.21 命令返回侧 / 5.15.22 落库侧） | §4.0j。状态不拆档、原因另有码；`grep -n "MESSAGE_FAIL_CODES" src-tauri/src/error_codes.rs` |
| 10b | INV-P18 | **两半都已落地**（X25519 5.15.18；**Ed25519 5.15.45，§4.0ac**：字段私有 + `IdentitySigner` 能力对象 + 判据 C 扩到这一半） | `grep -n "pub ed25519_signing" src-tauri/src/crypto.rs` 现数 **0**；`node scripts/check-key-boundary.mjs` 判据 C 覆盖两半 |
| 11 | SEC-02 | 上限已做（5.15.14）+ 淘汰认身份（5.15.19，§4.0h）；**announce 限流判不修** | 负结论留证：无界增长的成因是"条数没上限"而不是速率，`upsert_peer` 每 5s 周期最多一次 |
| 12 | DUP-02 | 通道判据与越权闸两半**已落地**（5.15.9 / 5.15.15）；剩下那半**复核后判不再统一**（§4.0l） | 原话「剩三套 toast 文案未统一」不准确：那是四件不同的事实。改判据钉住"它们是四件事"：`src/utils/mediaAvailability.test.ts` 三条（特征词 / 收藏那句的「副本」必须由 `std::fs::copy` 兑现 / 引用面不跨界），①③ 做过注入自证、② 只有内联反控（未对 `favorites.rs` 变异） |
| 13 | DUP-09～DUP-12 | **09 与 12 已加对账、11 已被覆盖、10 判不另加**（§4.0a） | 那两条对账用例就住在一个文件里，标题自带编号：`src/utils/messageKinds.test.ts` 的「跨语言契约：已读推进的排除清单两侧逐项一致（DUP-09）」与「…会话预览的固定文案两侧一致（DUP-12）」；复跑 `node --test src/utils/messageKinds.test.ts`。⚠️ 注：§6.3 那四行仍写着"无机器对账"，以本表为准 |
| 14 | DUP-07/15 | **DUP-07 已收口（5.15.39，§4.0x）；DUP-15 复核后判保留（§4.0x：早有棘轮判据 ㊼ + 显式登记的自研理由，本表把它列成「未做」是台账漂）**；DUP-06（5.15.28，§4.0o）已收口；DUP-03（5.15.26）、DUP-04（5.15.25）、DUP-05（5.15.16）、DUP-08（5.15.20）、DUP-13（5.15.27，§4.0n）已收口；**DUP-14 本轮判「不做」** | @提及 16% 淡底配方 **2 处各写一遍**（DUP-07，`MessageTextBubble.vue:154` / `MessageContentModal.vue:64`；`style.css:1308` 是被讨论但没复用的第三种）、`MobilePageFrame` 的 overlay 手抄**至少 2 处**（DUP-15，`BaseModal.vue:113` / `FavoritePanel.vue:827` 两处注释都自称"与 MobilePageFrame 一致"，审计原写 1 份）。**DUP-14 判不做的理由**：`MessageItem.vue` 里 `copyTextWithToast` 早就是右键菜单与移动端面板共用的一份，重复的只是菜单 markup ⇒ 收它是把模板搬个家，收益最低 |
| 15 | SEC-04/05/06/08/12 | **全部已修**（SEC-04 5.15.14 + 5.15.17 留痕；SEC-05/06/08/12 见 5.15.13） | SEC-08 那条是入站帧聚合驻留的**全局限额 1 GiB**（审计原估 8 GiB 上界） |
| 15b | SEC-07 / SEC-09 / SEC-10 / SEC-11 | **不成立 / 已撤回 / 判不修 / 判不修** | §4.0 与 §4.0b 逐条给了理由，负结论也是一等结论 |
| 16 | 替换矩阵勘误 | **已做**（5.15.13：新增 §0 勘误 + 一条「每个生产依赖都必须在矩阵里登记过」的新判据，带变异正控） | 文件真路径是 `docs/architecture/open-source-replacement-matrix.md`（⚠️ 本表原来只写裸文件名，害我照着它写了一条指不到文件的复跑命令）；复跑 `grep -n "勘误" docs/architecture/open-source-replacement-matrix.md` |
| 17 | 依赖卫生 | `@pinia/colada` 死依赖**已删**；**`lucide-vue-next` 升级评估已完成**（§4.0ab：0.469.0 → 1.0.0，103 个运行时图标在 1.0.0 里都有导出、缺失 0；视觉面本机无判据 ⇒ **判暂不升级**） | `grep -n "colada" package.json` 应为 0 命中（复跑时带一个阳性对照：`grep -n "vue-i18n" package.json` 必须有命中） |
| 18 | SEC-08 | **已修**（见第 15 行） | —— 原表把它单独列一行是重复计数 |
| 19 | 文件气泡的失败原因重启后失忆 | **1:1、群文件、接收收尾三族都闭环了**：5.15.29 事件载荷配码 → 5.15.31 码写进 `messages.fail_code`（§4.0q）→ 5.15.32 群文件 6 条转码并拆掉"一句话兼两职"的通知判据（§4.0r）。剩 **A2/A2b/A2c 已落地**（5.15.35 §4.0s / 5.15.36 §4.0t / 5.15.37 §4.0u / 5.15.38 §4.0v，含取消被当失败的语义修复）；⚠️ 5.15.40 的 review 推翻了 §4.0v 的「闭环」——上一批只认两种写法，漏了 `map_err(format!)`/`ok_or`/包装层/`begin_reassemble` 四种形状的五条路径，已在 §4.0y 补齐：接收收尾四格转码，并修掉两处被散文藏住的**真缺陷**（群收尾失败一律标成「对端失联」＋那一格不落事件 ⇒ 气泡停在发送中）；begin/resume 经复核**不上屏**（只回 `FileReject` + 日志）⇒ 判为不配码（§4.0t）；§4.0v 已收口发送侧那一族与「取消被当失败」；剩余自由文本只有**不上屏**的两类，结论与凭据见 §4.0t/§4.0v；⚠️ 群文件那一步的**集成层**（真机/跨进程）本轮未证 | ⚠️ 两处前置都订正过：审计原来写「配码即可」不完整（要先看清码给谁读），而我 5.15.29 写的「必须加表列（DB v16）」**也是错的** —— 现读 `db/file_transfer.rs` 里 `set_message_status(&tx, &format!` 那几行（按符号名找，别抄行号）与 `cascade_tests.rs:809`：`file-<tid>` / `gfile-<tid>` **本来就是 `messages` 行** ⇒ 批 B 的真实形状是给 `finalize_file_failure` 带上 `fail_code`、群路径同写一码，**不加列、不迁移**（凭据与教训见 §4.0p）。复跑：`node --test src/utils/fileFailReason.test.ts` |
| 20 | `## [4.39.2]` 两节内容不同（历史改号） | **判为不做**（不是来不及：历史那几节没有任何消费者，跨节搬正文的风险大于收益） | §4.0k 给了三节的 `git tag --contains` 现算表；判据对这种形状**显式打印**，不会静默放过 |

### 还没做的，按建议顺序

1. ~~**TST-02**（曾写成「唯一还活着的 P1」）~~ —— **已收口**：5.15.41 / 5.15.42 / 5.15.47 三笔把六个 handler 收进 `utils/messageWrite`（§4.0z / §4.0aa / §4.0ae，§8 第 7 行）；当年写的前置「整店 DI」复核后判不必。
2. **INV-P18 的 Ed25519 那半** —— 前置是"签名能力"抽象（**仍开着**，见 §5 的 P18 行）。
3. ~~**第 19 行·批 B 剩下的半格**~~ —— **已收口**（5.15.32，§4.0r）：群文件 6 条 `REASON_*` 已转码并写进气泡行，且「是不是稳定码」与「要不要弹 toast」已拆成两件；同批 A2 也随 §4.0u / §4.0v 收口。原文：1:1 那一半已在 5.15.31 闭环（不加列、不迁移，走的正是 5.15.22 那扇门）；B2 必须先拆 `group_file.rs::is_stable_fail_code` 那句兼两职的话，否则断链时会给每个在途群文件弹一次 toast。
4. ~~**DUP 剩余的 2 行**~~ —— **本轮清零**（DUP-07 已于 5.15.39 收口；DUP-15 复核后确认早有棘轮判据 ㊼ 与显式登记的保留理由，§4.0x）。原文：纯重复，收益是"少一份会漂的拷贝"。DUP-03/04 已于 5.15.26 / 5.15.25 收口，DUP-13 已于 5.15.27 收口（§4.0n：现数是两种策略九处，不是审计写的三份），DUP-06 已于 5.15.28 收口（§4.0o），DUP-14 判**不做**。
   （第 12 行 DUP-02 的那半本轮**复核后判不再统一**，理由与三条防复发判据见 §4.0l。）
5. ~~`lucide-vue-next` 升级评估~~（§4.0ab 已完成，判暂不升级）、~~`get_topology` 孤儿~~（5.15.44 已按拍板删除）、~~TST-09 Windows 三类行为用例~~（§4.0ab 判不做：本机无判据）、剩 **TST-06 真 ENOSPC**，以及**需要现场日志才能推进的 Windows 渲染层卡死**（另见 `docs/notes/`）。（第 20 行的历史改号本轮**判为不做**，理由与现算证据在 §4.0k，不再列进待办。）

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

> **2026-10-31 补注**（这张表讲的是**审计当时**；下面几行后来已被关掉，别再当成今天的待办）：
>
> - 「12 个含 `Date.now` 的前端测试文件」「33 个含 `readFileSync`/`tmpdir` 的文件」→ **已逐条核过**
>   （§4.0bg 的 TST-14 / TST-15）：现读时间依赖只剩 9 个文件，真实时钟三处都有余量；写盘只发生在
>   2 个脚本测试（`scripts/updaterManifest.test.ts`、`scripts/publishRelease.test.ts`），路径全来自 `mkdtempSync(tmpdir())`。
> - 「`@pinia/colada` 死依赖」→ **已删**（§8 第 17 行，5.15.13，含"每个生产依赖都必须在替换矩阵里登记"的判据）。
> - 「跨进程 E2E 本轮未跑」→ 只描述审计当时。此后发版检查单每次都要跑 `verify:release` 4 轮；
>   本会话三次发版（v5.15.65 / .71 / .74）实测都是 25 / 23 / 38 / 49 条断言全绿（§4.0bb、§4.0bf）。
> - 「前端运行时行为」→ 功能域有 `check-ui-runtime` 探针，消息列表/溢出/替换矩阵等另有真渲染格（`msgovf` / `rowpair` 等，
>   见 §4.0x 与 memory 里的探针账）；启动失败那扇窗的真窗口十格由 A2 那一批的真窗口验收另行确认（脚本尚未入库，故不在此引用路径）。
> - 「Windows 编译」→ **CI 每次 push 都在真 MSVC 上编**（`Rust 单测 / 清单（windows-latest）` 与 `build-windows` 两条腿）；
>   仍成立的是"**本机**编不出来"，属"本机不可验"，不是"从没验过"。
>
> **仍然开着的六行**（对着上表逐行数：10 行里本轮关掉 4 行、降级 2 行）：
> 真机硬件路径（BLE / 多机局域网 / Windows 卡死）、中继公网链路、≥24h 长跑、`GITHUB_ACTIONS=true` 本机模拟
> —— 这四行要外部环境；**前端运行时行为**只关掉了"有探针覆盖的那部分"（真窗口交互仍有空白）；
> **Windows 编译**降级为"本机不可验"（CI 每 push 都在真 MSVC 上编）。

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

---

## 13. 2026-10-31 收口时刻：还开着的全部事项（一张表）

本册其余部分按主题分节；这一节只回答一个问题：**今天还剩什么**。逐条都能点回证据，没有"大概"。

| # | 事项 | 类型 | 卡在哪 | 证据 / 下一步 |
|---|---|---|---|---|
| 1 | **#23 Windows 渲染层卡死**（11 分钟零心跳） | 外部取证 | 需要那台机器的现场文件 | §4.0bi 取证单：取 `%APPDATA%\com.gosslan.app\logs\gosslan-crash.log` 里 `>>> code=HANG` 与 `>>> code=RUNTIME_MEM`；判读 `tree_cpu_ms ÷ (window_s×1000)`：≈1 空转 / 0 挂起 / 几十 ms 空闲 |
| 2 | **群侧盘满端到端（TST-06）** | 外部环境 | 需要能真写满的卷 + 三实例；10-31 拍板本批不做 | 形状层判据已齐（条件按码判 / 支内删 / 三态日志）；缺的是真 ENOSPC 的下游读数 |
| 3 | **Windows 句柄未关时删 `.part`** | 外部取证 | 需要 Windows 上「删 `.part` 报共享冲突」的真日志 | 若永不冲突，说明 `FILE_SHARE_DELETE` 已覆盖，可结案 |
| 4 | **INV-P18：Ed25519 私钥字段仍是 `pub`** | 需设计 | 前置是"签名能力"抽象，未获授权开工 | §5 的 P18 行、`protocol-invariants.md` INV-P18 |
| 5 | ~~A2 十格 + A7 各实例几何~~ | **全部实测通过**：A2 十格（含 busy）、A7 恢复 / 保存 / 各实例分文件 | 读数与量纲坑见 §4.0bj；A7 两次假读数已归因到「同名残留进程」 | A2 用 `cabe545` 的验收轮 + 手跑补 busy/单实例；A7 用隔离 HOME 预置状态文件 + Cmd+Q 实跑 |
| 6 | ~~A2 的 `resolved` 置真顺序~~ | **已修（5.15.91 / `16e00f5e`）** | 在调度失败的 `Err` 分支复位 `resolved`/`retrying`（2 行）；成功路一字未改 | 现跑：`startup_error` 6 passed、`cargo test --lib` 1355 passed / 0 failed、clippy 0、fmt 0；§4.0bj 第 2 条已改为结论 |
| 7 | **A4 / A10 的双实例真流程**（加好友→同意→重启） | A4 恢复臂**已实测且已入库**（`cabe545`）；A10 仍待真机 | `friendreq` 轮只覆盖 A4 恢复臂；A10 要真实 `FriendAccept` 回执 | 正向 **9/9（整轮 27=默认 18+本轮 9，退出 0）**、反向 `friendreq-lie` **恰 2 条设计内断言红、退出 1**；入库后的提交版本与实跑内容一致（`tcpOpen` 导入在、`check(` 9 处，现场核过） |
| 8 | ~~A5 的首启不误报~~ | **已收口（A/B 实测）** | 报告侧 5.15.75 已修；日志判定侧 5.15.92（`46f41213`）补齐并用例正反控钉住 | 隔离 HOME 真机 A/B（2026-10-31）：**5.15.91 首启日志里 `BOOT_PREV_` 1 行（假的异常终止）→ 5.15.92 同一形状 0 行**，bootstrap 行 `pid` 与进程一致；两轮都只碰 `/tmp` 隔离 HOME，跑完即清 |

**本节自身的机器对账**（2026-10-31 现跑）：① 全册引用的 25 个提交号全部
`git cat-file -e <sha>^{commit}` 命中、且都是 `origin/main` 的祖先（无一指向未推/已改写的历史）；
② 表内 **8 行**（与「八项」一致）；③ 全册 **57 处 `§4.0xx` 引用**全部能对上真实小节标题（缺失 0）。

**已收口的**（不再列进待办）：58 个审计 ID 全部有裁决（§4.0bg）、§5.1 八条分歧已逐条订正或复核（§5.1 状态块）、
§9.2 未覆盖清单已对账（4 关 / 2 降 / 4 留）、发布事实与门禁账（§4.0bb / §4.0bf）、主线转绿三笔与方法教训（§4.0bh）、
A2 只读复核（§4.0bj）、A4/A5/A10 三段静态链（§4.0bk）。

**A1 的跨进程断言已实测（2026-10-31，正向 + 反向两轮）**：`npm run test:e2e:ghsync` → **41 条断言全绿、退出码 0**；
`npm run test:e2e:ghsync-selfproof`（反向轮，按设计应红）→ **恰好新增的那两条 A1 断言红**，且打印的读数可直接归因
（`last_ts=1792667672512` vs 同步时刻 `1793445336172`；`last_msg="[图片]"` vs 末条 kind 取不到）。
两轮都正常收尾且「已还原用户原有实例库 3 个」，无残留进程。

**A4/A10 的真流程（加好友→同意→重启）现有 E2E 覆盖不到**：`scripts/e2e/rounds/multi.mjs` 是用直接 SQL 种 `friends` 行，
不经过申请/同意协议帧 ⇒ §13 第 7 项仍成立（不是"没找过"，是那套设施里没有这一轮）。
