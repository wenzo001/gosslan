# 安全与可维护性审计证据（2026-10-16）

范围：`src-tauri/src` + `src/` + 配置/脚本/锁文件。防御性自审，只读，无生产码改动。
优先级口径沿用用户既定制：**稳定 > 流畅 > 正确 > 原生 > 安全 > 可维护 > 可扩展 > 新功能**；本轮不加功能。

---

## 0. 前置：任务点名的两份"作废清单"在本仓不存在（必须先纠正）

现算证据：

```
$ ls docs/stability-audit-2026-09-23.md docs/ARCHITECTURE-CROSSREVIEW-2026-10-01.md
wc: docs/stability-audit-2026-09-23.md: open: No such file or directory
wc: docs/ARCHITECTURE-CROSSREVIEW-2026-10-01.md: open: No such file or directory
$ git log --oneline --all -- docs/stability-audit-2026-09-23.md docs/ARCHITECTURE-CROSSREVIEW-2026-10-01.md
（空 —— 两个路径从未进过版本历史）
```

实际承担"已审过不要重做"职责的是这三份，本文的"已审"引用全部改指它们：

| 角色 | 真实路径 | 关键节 |
|---|---|---|
| 作废清单 / 任务重判 / 进度状态机 | `docs/stability-roadmap.md`（1830 行） | §3.3 C-1…C-8（延后）、§3.4 **D-1…D-12（明确不做）**、§4.1「已完成——**不要重做**」、§9 进度状态机、§12.3 网络 |
| 架构与传输层结论 | `docs/ARCHITECTURE-REVIEW-2026-09-24.md`（630 行） | §A 12 条、§B P1…P12、§D 第 0–7 步、`:614` 明确不做 |
| 协议不变量（安全语义真源） | `docs/protocol-invariants.md`（1488 行） | INV-P10 密文不得静默变明文、INV-P11 公钥变更属安全相关、INV-P12 设备身份持久化、INV-P18 私钥不跨 UI 边界 |

任务里写的 `docs/acceptance/stability-roadmap.md §9` 同样是错路径 —— 真路径是 `docs/stability-roadmap.md`（§9 在 `:483`）。
**结论：文档引用本身要修，但那是文档格子，`check-doc-citations.mjs` 已有判据，本轮只在 §6 登记。**

---

## 1. 加密与身份

### 1.1 密钥生成 / 存储 / 导出面

- `src-tauri/src/crypto.rs:27-35` 生成走 `OsRng`（`StaticSecret::random_from_rng` / `SigningKey::generate`），无常量时间问题面。
- 存储：`src-tauri/src/crypto.rs:8` 自述 + `src-tauri/src/state.rs:1393-1407` 实读 —— **两把私钥以 base64 明文写在 SQLite `settings` 表**，没有系统 Keychain / DPAPI / Keystore。这是既成设计（INV-P12 要求"重启后身份不变"），代价见 §4.3。
- 导出面只有两条通道（Tauri 事实）：命令返回值与 emit 载荷，都要求 `Serialize`。
  量具现跑（秒级，本文唯一执行过的检查）：

  ```
  $ node scripts/check-key-boundary.mjs        EXIT=0
  · 命令体扫描 139 个函数（注册表 133 条，差额为未注册的 #[tauri::command]）
  ✓ 私钥边界：71 个可序列化类型无密钥字段（判据 A） · 139 条命令体无密钥触碰且与注册表逐条对上（判据 B）
  ```

- **已审，不重做**：`docs/stability-roadmap.md:504` 行 `B-1a-P18` 已登记该守卫为 `GUARDS_LOCKED`，并**已自己写明残余**："两步搬运扫不住，根治要密钥字段私有化（属重构核心码，另立）"。本轮复核这条残余**仍然成立** —— `crypto.rs:20-23` 的 `Identity` 两个字段至今是 `pub`，任何非命令代码（如 `emit` 前的字符串拼接、或 `Debug` 派生）都能把私钥搬出去而守卫无感。**不重复登记，只确认它没被解决。**

### 1.2 X25519 公钥会不会被覆盖写 —— 不会（有双闸）

- `src-tauri/src/db/friends.rs:50-63` `update_friend_pubkeys` 用 `COALESCE(col, ?)`，**只填空、首写者永久胜出**；
- 唯一的覆盖式写入 `db/friends.rs:71-84` `replace_friend_pubkeys` 全仓**只有一个调用点** `src-tauri/src/commands/friends.rs:205`，位于"用户显式点『同步新密钥』"那条命令内；候选登记侧 `network/transport/handshake.rs:86-96` 还要求**新公钥自验签通过 + 该 device_id 确为好友**（`scripts/guard_cases/transport_network.py:444-458` 两条判据钉着）。
- ⇒ 判据成立，本轮不重做。

### 1.3 信任建立（安全码 / TOFU）在哪判定

- 安全码：`crypto.rs:148-175`，6 个字段（双方 device_id + 各自 X25519/Ed25519）+ 域前缀 + 逐字段 `0x00` 分隔符，输出 6×5 位十进制（≈100 bit）；排序用 device_id 字典序保证两侧同码。形状正确。
- TOFU 判定唯一入口：`network/transport/handshake.rs:57-118` `verify_hello`，信任根顺序 **friends（持久权威）→ peers（仅当 `keys_verified`）→ TOFU**。
- `keys_verified` 这道闸**不可绕过**（本轮实测复核）：判据被抽成两个具名纯函数 —— `handshake.rs:128-131` `bound_ed25519_from_peer`（Hello 回落锚点唯一判定点）与 `handshake.rs:150-158` `peer_keys_trusted`（成为好友时写 `friends.ed25519` 的唯一判定点），并由 `src-tauri/src/lib_friend_identity_tests.rs:285-310` 用**源码计数 + 顺序断言**钉住"打标必须在 `upsert_peer` 之后、且 `handle_message` 体内不得出现第二处打标"。
- nonce 消费放在验签**之后**（`handshake.rs:103-117`），且为 512 条有界 FIFO ⇒ 未验签连接无法污染重放缓存。

### 1.4 【新证据 · 真缺陷】同一个"好友公钥是哪一把"有**三套读取顺序**

不是重复 `#32`（那一格治的是"写侧不看 `keys_verified`"，已收口）。本轮抓到的是**读侧**分叉，且代码注释自己承认但没有判据、roadmap 里没有登记：

| 读取处 | 顺序 | 位置 |
|---|---|---|
| 单聊解封 / 重封 | **friends 优先** | `network/transport/e2ee_payload.rs:19-32` |
| 出帧密封 | **friends 优先** | `commands/chat.rs:185` |
| 群密钥分发 `resolve_member_x25519` | **peers 优先** | `commands/groups.rs:112`、`:219` |
| 界面安全码 `get_safety_number` | **peers 优先** | `commands/friends.rs:32-50` |

后果（`e2ee_payload.rs:15-19` 的注释已经把这句话写出来了，但**没有任何测试钉住它**）：两张表不一致时，**"双方安全码对得上"不能证明消息解得开** —— 核对读新钥匙、加密用旧钥匙。这是一条能静默降级的形状：判据（安全码一致）成立、程序照跑，但用户得到的密码学保证与他以为的不是同一件事。
现算：全仓 `grep -rn "get_friend_x25519\|peers.*x25519_pubkey" src-tauri/src --include="*.rs"` ⇒ 读取点 **7 处**，`x25519` 锚点判定函数 **0 个**（`ed25519` 有 `bound_ed25519_from_peer` 这个唯一入口，`x25519` 没有对应物）。⇒ **本轮该动手**（一处抽函数 + 一条纯函数判据，半径小）。

### 1.5 密封与群密钥的密钥层级（现算 3 层）

```
L1 身份：X25519(ECDH) + Ed25519(签名)                    crypto.rs:20-35
L2 会话：单聊 = ECDH(我的 x25519, 对方 x25519) 直接当 AEAD key   crypto.rs:75-81
        群聊 = 群主 random_key() 生成的 32B 群密钥，按成员用 L2 逐个密封分发
                                                    commands/groups.rs:112-118
L3 内容：文件密钥 = 每单随机 32B
        单聊用 L2 密封  network/file/send.rs:88-89 / handle_file.rs:61-63
        群聊用 L2(群密钥) 密封  protocol.rs:1674 / group_file.rs:55 /
                               commands/group_file_dispatch.rs:68
公网中继：ADR-0020 盲电路，准入只认 friends.ed25519
        （db/friends.rs:131 `IS NOT NULL` 过滤）+ transport/relay_seal.rs
```

层级评价：**没有 KDF/双密钥派生** —— `crypto.rs:75-81` 把裸 ECDH 输出直接当 ChaCha20-Poly1305 密钥（无 HKDF、无域分离、无对端身份进 KDF）。同时 `crypto.rs:105-110` 的群/文件对称加密与 `crypto.rs:83-93` 的单聊密封**共用同一个 `seal` 实现、同一种 nonce 生成（随机 96 bit）**，两种用途靠"密钥来源不同"隔离，不靠标签。
这不是可静默降级的形状（算法本身成立），属"可扩展性/密码学卫生"欠账；`docs/stability-roadmap.md:292` D-11 已把 Noise XX 之类的协议改造判为**本阶段删除**，所以本轮**不建议动**，只把事实登记在此，避免下一个人以为没人看过。
随机 96-bit nonce 在**同一把 L2 密钥下**的碰撞界：`send.rs:443-445` 每片独立随机 nonce，单文件 100 MB / 片 256 KiB ⇒ 约 400 次加密/单；跨单同密钥累计到 2³² 片量级才进入 birthday 风险。LAN 用量下属安全，但**没有任何地方写下这条预算**（现算：`grep -rn "nonce" docs/protocol-invariants.md` = 0 命中）。

### 1.6 能静默降级的形状清单（判据不成立但程序继续跑）

| # | 形状 | 位置 | 有没有症状 |
|---|---|---|---|
| D1 | §1.4 三套公钥读取顺序 | `e2ee_payload.rs:19`、`commands/friends.rs:32`、`commands/groups.rs:112` | 无（安全码照显示、消息照发） |
| D2 | `handle_group_key` 的"群主闸"**只在本地已有群记录时生效**；无记录即放行（新成员首次拿密钥的唯一途径），成员表由对端自报 | `network/transport.rs:1307-1314`、自报成员闸 `:1304` | 无。缓解是硬的：`from != peer_id`（`handle_group.rs:100-102`，绑定到已验签 Hello 连接）+ `lib_delivery_shape_tests.rs:410-414` 禁止该臂出现 `ensure_conversation` ⇒ 注入的群不进聊天列表。**判为已审形状，本轮不动** |
| D3 | `handle_group_key` 随后取 `peers[from].x25519_pubkey` 时**不看 `keys_verified`** | `network/transport.rs:1315-1319` | 与 changelog `:5694` 那条"读 `peers` 里的公钥时不看 `keys_verified`（显示侧缺口）"同源；本轮实测确认**仍在**。属 D1 的同一格 |
| D4 | announce 无签名 ⇒ `AnnounceAuth::Legacy` 仍接受用于发现 | `protocol.rs:1936-1939`、`:1955-1957` | **刻意设计且已论证**（旧端可见性 > 收益），下游靠 Hello 验签与 `keys_verified` 兜住。**已审，不重做** |
| D5 | `open_direct_content` 解密失败 ⇒ `return`（不落库不 Ack），无用户可见计数 | `e2ee_payload.rs:36-54`、`handle_messaging.rs:99-105` | 形状正确（INV-P10/`roadmap §9 B-1a-P03`），但"对端一直解不开"只有 outbox 堆积可读。P03 已登记 `AUDITED`/延后，**不重做** |

---

## 2. 输入面（对端可控数据）

### 2.1 长度与边界

- `transport/tcp.rs:68-85` `read_bytes_capped` —— **先校验长度前缀、再分配缓冲**（`:76-81` 的 `if len == 0 || len > max` 在 `vec![0u8; len]` 之前），注释自己点명了反例形状。预认证 64 KiB（`protocol.rs:26 MAX_PREAUTH_FRAME`）与认证后 64 MiB（`protocol.rs:16 MAX_FRAME`）分档 ⇒ **已审，形状正确**。认证后 64 MiB/帧 × 并发连接的内存放大由 `ARCHITECTURE-REVIEW-2026-09-24:114`（P3 缓冲按帧数限流）与 `:128`（P4 中继借用接收全量进内存）覆盖，roadmap §9 记为已处置 ⇒ **不重做**。
- BLE 分片重组 `transport/ble_framing.rs:215-236`：注释明确拒绝 `vec![None; count]`（对端给的 count），改惰性 map + `bytes` 总量上限 + `MAX_INFLIGHT_MESSAGES=8`（`:180`）+ 30 s TTL（`:183`、`gc()` `:336-342`）；`count==0`/越界/不一致/重复片各有独立裁决（`:274-315`）。`Vec::with_capacity(p.bytes)`（`:325`）的 `p.bytes` 已在 `:313` 被 `MAX_BLE_MESSAGE_BYTES` 夹住 ⇒ **安全**。
- 全仓 `with_capacity` 现算 **11 处**（非测试），逐处对账：`crypto.rs:88`（自身明文）、`logging.rs:174`（自有常量）、`mesh/router.rs:128`（自有环形缓冲计数）、`ble_framing.rs:202/204/325`（见上）、`relay_seal.rs:115/353/365`（自有帧长）、`relay.rs:493`（字面量 192）、`outbound.rs:170`（自有候选数）、`export.rs:170`（`total*120`，`total` 来自本机 DB 行数）⇒ **没有一处把对端给的数直接喂给 with_capacity**。

### 2.2 反序列化后当路径 / 当 SQL 参数

- 文件名清洗**只有一家**：`network/file/share_walk.rs:183-190 safe_file_name`（拒空 / `.` / `..` / `\0` / `/` / `\`）。调用点现算 **5 处**：`file/receive.rs:100`、`:351`、`transport/relay_file.rs:28`、`:532`、群聊经 `group_receive.rs:15` 复用同一条 ⇒ **没有第二家各写各的**。
- 第二道同样只有一家：`share_walk.rs:202-214 safe_transfer_id`，白名单 `[A-Za-z0-9_-]{1,64}`，理由注释点名了 `{transfer_id}.part` 直接拼路径 + `File::create` 截断 + `join` 遇绝对路径整体替换前缀这三种死法。判据 `network/file_tests.rs:202` 是拒绝式断言。
- `usize`/`u64` 转换：`file/receive.rs:355` 显式挡 `size > i64::MAX`；`tcp.rs:49` 写侧同时挡 `> MAX_FRAME` 与 `> u32::MAX`。
- SQL：**没有一处把对端可控值拼进 SQL**。现算 `grep -rn 'format!("(SELECT|INSERT|UPDATE|DELETE' src-tauri/src/db src-tauri/src/commands` = **12 处**，逐个读：插进去的全是编译期常量片段（`message_delete.rs:42/46/50` 的 `{ph}`/`{bubble}` 占位符串、`conversations.rs:179-201` 的 `{keep}` kind 白名单、`favorites.rs:55/65/85` 的 `{FAVORITE_COLS}`），值一律走 `params![]`。余下 `{table}`/`{col}` 两处只在测试里（`favorites_tests.rs:1752`、`cascade_tests.rs:482`）。
- 落库侧的"类型不校验"是有意的：`e2ee_payload.rs:51-53` 把未知 `kind` 原样透传（注释给了理由：前端要显示"不支持的消息类型"而不是当 text 渲染出裸 JSON）。前端对应入侧是**白名单**：`src/utils/fileMeta.ts:26-36` 逐字段 `typeof` 检查、缺省/类型不对一律不填 ⇒ 形状正确。
- 导出侧递归：`export.rs:89-92` 对未知/嵌套 kind 一律给 `[kind]` 占位，注释点名"构造深嵌套就能把导出撑爆" ⇒ 已封堵。

### 2.3 残余（登记，不在本轮动手范围）

接收侧 `FileOffer` 声明的 `size` **没有全局上限闸**，只有 `PathKind::Bluetooth` 一条分支限流（`network/file.rs:116`）。因为落盘是流式写、不做全量预分配，风险形态是"磁盘写满"而不是"内存打爆"；而"接收目录写不进去"已由 `roadmap §9 A-2` 注入⑧（`EACCES`，两真进程）与 L2 判据覆盖 ⇒ **已审，本轮不重做**，只记一句：声明尺寸与实收尺寸的偏差判据在 `file/receive.rs:295`（`disk_retained >= size`），有。

---

## 3. IPC 与前端可达面

现算：`#[tauri::command]` 属性出现 **169** 次；`generate_handler!` 注册 **133** 条（`lib.rs:498-…`，`commands.rs` 以 `include!` 拼 19 个分册）。守卫自报的口径是权威口径 —— "扫描 139 个函数体 / 注册表 133 条，差额为未注册的 `#[tauri::command]`"，即**存在声明了但未注册的命令体**，覆盖面靠"每条注册命令必须找到函数体、否则直接红"自证（`scripts/check-key-boundary.mjs:36-42`），不会"少扫一条照样绿"。

### 3.1 配置现状

| 项 | 现值 | 证据 | 判定 |
|---|---|---|---|
| CSP | **`null`（完全不下发）** | `src-tauri/tauri.conf.json:33`（全仓 `grep csp` 仅此一处命中） | **本轮该动手**，见 3.3 |
| `withGlobalTauri` | 未设置（⇒ false） | `tauri.conf.json` app 键只有 `windows` / `security` | 好 |
| `assetProtocol` | 未启用 | 同上 | 无 asset: 面 |
| 危险开关 | 无 `dangerousDisableAssetCspModification`、无 `freezePrototype` 设置 | grep `dangerous` 零命中 | — |
| capability | `capabilities/default.json`，`windows: [main, settings, logs, preview, tasks]` | 文件内注释自述"刻意**不含**外链窗口 `link`：它加载远端页面，任何 capability 都会把命令面暴露给第三方内容" | 判断正确，已审 |
| macOS 沙盒 | `app-sandbox = true`，downloads / user-selected / bookmarks app-scope / bt / net client+server | `src-tauri/entitlements.plist` | 最小面合理 |
| 自定义协议 | `default = ["custom-protocol"]`（= Tauri 内置，非自研 URI scheme handler） | `Cargo.toml:129-132`；全仓 `grep register_.*uri_scheme_protocol` **0 命中** | 无自研协议解析面 |

preview 窗口加载的是**打包在应用内的 `preview.html`**（`lib.rs:91-95`，入口 `src/entries/preview.ts`），不是远端内容 ⇒ 把它放进 capability 是合理的。

### 3.2 【新证据 · 真缺陷】`open_file_native` 收任意路径，而同族两个兄弟都有边界

```rust
// src-tauri/src/commands/files.rs:111-113
#[tauri::command(async)]
pub fn open_file_native(path: String) -> Result<(), String> {
    crate::open_path::open_path_native(std::path::Path::new(&path))
}
```

对照它自己的两个兄弟（同一条边界，两处都写了、这处没写）：

- `commands/files.rs:82-106 delete_file` —— canonicalize 后必须落在 downloads 内，注释的理由正是**"若哪天有 UI 把它接到消息里的 `path`（该字段由对端控制），没有它就会变成『对端点一下按钮删掉本机任意文件』"**；
- `commands/helpers.rs:109-166 resolve_media_path` —— 按 `msg_id` 反查、canonicalize、越界即 `路径越权`，是读取侧的既有口径（`favorites.rs:10`、`:300` 两处注释都明写"与 `resolve_media_path` 同口径"）。

而"哪天"已经来了 —— 现算调用链：

| 环节 | 位置 |
|---|---|
| 接收侧把对端 `content` **原样落库** | `network/transport/handle_messaging.rs:110-131`（`content: content.clone()`，来自 `open_direct_content` 的透传） |
| 前端从载荷里读 `path` | `src/utils/fileMeta.ts:31` `if (typeof p.path === "string") out.path = p.path` |
| 点开文件气泡直接把这个 `path` 交出去 | `src/composables/useMessageFile.ts:187-195` → `src/utils/localFile.ts:29 api.openFileNative(path)` |
| 桌面端不做"自己发的文件不响应"限制 | `useMessageFile.ts:183`（仅 `isAndroid && isMineFile` 才不可点） |

可达性边界要说清（不过度报）：发这封消息的对端**必须先通过 Hello 验签**、`from == peer_id`，且消息要落进一个已存在的会话 —— 所以这不是"任意局域网节点"，而是**"一个已经加上好友的恶意/被盗身份"**；且要用户点一下气泡。后果是"用系统默认处理器打开本机任意路径"（探测文件存在性、按路径拉起 `.app`/文档、触发 macOS 上的 LaunchServices 行为）。
**判为 §3 首条真该动手**：修法是把 `delete_file` 那 8 行边界原样搬到 `open_file_native`（或让前端改传 `msg_id` 走 `resolve_media_path`），**不新增任何功能**，改动半径 1 个函数。

其余命令面抽查：`commands/share.rs:93-107 open_in_file_manager` 的三处 `Command::new("explorer"|"open"|"xdg-open")` 只接受**状态里的 downloads 目录**（`:71-82`），不是前端入参；`commands/logs.rs`、`commands/dev_diag.rs:251 get_discovery_diag` 无入参、只读状态；`commands/system.rs` 未列外部执行程序。⇒ 除 `open_file_native` 外没找到第二个"前端传路径 → 后端直接动文件系统/进程"的口子。

### 3.3 CSP 缺失 × v-html

13 处 `v-html`（现算）：`LogViewer.vue:369-373`/`:516-520`（9 处）、`ChatSearchDialog.vue:375`/`:425`、`CodeBlock.vue:111`。
逐处读过生产者：前 11 处全部由 `src/utils/highlight.ts:21 highlightText` 供给，**函数内先转义**，`src/utils/highlight.test.ts:12/44/45/49` 直接拿 `<b>hi</b>`、`&`、`"`、`<script>` 当断言输入 ⇒ 单测层已封。`CodeBlock.vue:87` 走 highlight.js 输出。

但**架构事实没变**：`csp: null` ⇒ WebView 无内容策略；本应用的渲染输入里有大量对端可控字符串（昵称、群名、文件名、消息正文、日志行 —— 日志行经 `state.rs:1278-1290` 的 `[dev:平台-主机名前6字符]` 与 190 处 `logger.*` 把对端信息带进 UI）；而一旦 `highlightText` 或未来新增的第 14 处 `v-html` 漏掉转义，落点就是**整个 133 条命令的 IPC 面**（含 `open_file_native`）。
⇒ 属"安全"而非"稳定/流畅"格子，用户排序里在 4-5 位；配置一行、零运行时风险、零功能新增。**本轮该动手**（加一条最小 CSP 并保留 asset/inline-style 所需豁免，实测首帧与主题注入 `preview.html:11-13` 的两个占位注释不被打断）。

---

## 4. 凭据与隐私

### 4.1 私钥 / token 进日志或 emit

已由 §1.1 的 `check-key-boundary.mjs` 现跑覆盖（判据 A 覆盖 emit+返回值，判据 B 覆盖 139 条命令体）⇒ **绿**。
补一条本轮实测：`grep -rn "to_bytes()\|secret_b64\|ed25519_secret" src-tauri/src` 的非命令命中全在 `state.rs:1393-1407`（读写 `settings`）与 `crypto.rs` 内部，日志侧 **0 处** ⇒ D1 之外没有第二条搬运路径被发现。

### 4.2 日志里落了哪些可识别信息（现读）

- 每行前缀固定带**设备指纹** `state.rs:1278-1290`：`[dev:{平台}-{hostname 前 6 字符}]`，由 `logging.rs:308-315` 拼进**每一条**落盘行。主机名前 6 字符对局域网内识别同设备足够（`device.rs:132` 注释自己承认 `hostname_fingerprint()` 同源）。
- 190 处 `logger.*` 调用里高频带 `device_id`、`peer=`、`msg_id`、`tid`、`ip/addr`（如 `transport/handshake.rs:66` 错误串带 device_id、`handle_messaging.rs:66-69` 带 `msg_id`+`peer`、`:1320` 群密钥路径带 from）。昵称与文件名经 `resolve_nickname`/`preview_content` 进日志与 emit。
- **没有集中脱敏层**：`grep -rn "redact\|mask\|scrub" src-tauri/src/logging.rs` = 0；`logging.rs:192 log()` 只做 `(ts, level, target, message)` 四元拼装 ⇒ 隐私完全依赖 190 个调用点各自的手上分寸，无判据。

### 4.3 文件权限与轮转上限（现读）

- 轮转：`logging.rs:296-311` 惰性改名到 `{stem}.old.log`，**只留一代**（`:304` 先 `remove_file(old)`）；单文件超 `MAX_LOG_FILE_BYTES = 512 KiB`（`:128`）⇒ 每个 stem 硬上限 ≈ **1 MB**。内存 ring buffer 500 条（`:126`、`:204`）。⇒ 上限有、形状简单、无失控风险。**已足够，本轮不建议动。**
- 权限：**全仓 `grep set_permissions|from_mode|0o600|0o700` src-tauri/src = 0 命中**。日志与含私钥的 SQLite 都按 umask 创建（POSIX 典型 0644）。macOS 因 §3.1 的 app-sandbox 落在容器内、同用户其他进程仍可读；**Windows 便携版（`scripts/build-windows-portable.ps1`）与 Linux 无沙盒 ⇒ 同机其他本地用户可读私钥文件**（在能读到 app_data 的前提下）。
  与 §1.1"私钥明文进 SQLite"是同一格欠账：`roadmap §9 B-1a-P18` 只登记了"不外泄到 UI"，**"落盘文件权限"这一半没有登记** ⇒ 本轮登记，但修法要么涉及 OS 信任存储（D-11 那一族的改造），要么是一行 `from_mode(0o600)` + 首启迁移，需拍板，不算本轮必修。

---

## 5. 依赖（离线，只做版本事实）

⚠️ **本轮未执行任何联网命令**（不跑 `cargo audit` / `npm audit`）。以下全部是 `src-tauri/Cargo.lock`（**564** 个包）与 `package-lock.json` + `package.json` 的现读版本事实；**离线只能给版本，CVE/等级判定需联网**。

| crate | 锁定版本 | 角色 | 备注（纯事实） |
|---|---|---|---|
| `x25519-dalek` | 2.0.1 | prod（E2EE 核心） | `static_secrets` feature |
| `ed25519-dalek` | 2.2.0 | prod（签名根） | |
| `chacha20poly1305` / `chacha20` | 0.10.1 / 0.9.1 | prod | 走 `aead` 0.5 |
| `rand` / `rand_core` / `getrandom` | 0.9.5 / 0.6.4+0.9.5 / **0.2.17 + 0.3.4 + 0.4.3（三份共存）** | prod | 多版本共存本身是审计噪声点 |
| `rusqlite` | 0.31.0（`features=["bundled"]`）→ `libsqlite3-sys` 0.28.0 | prod | **现读到捆绑 SQLite = 3.45.0**（`~/.cargo/.../libsqlite3-sys-0.28.0/sqlite3/sqlite3.h:149`）。bundled 意味着系统 sqlite 的安全更新**不会**传导到本产物 |
| `tokio` / `hyper` / `reqwest` / `tower` / `http` | 1.53.1 / 1.11.1 / 0.13.4 / 0.5.3 / 1.5.0 | prod | `tokio features=["full"]` 面偏大 |
| `serde` / `serde_json` | 1.0.229 / 1.0.151 | prod | 唯一 emit/返回序列化面 |
| `notify-rust` | 4.18.0 | prod（桌面） | |
| `sha2` / `base64` / `uuid` / `regex` / `chrono` / `walkdir` / `tempfile` / `open` | 0.10.9 / 0.22.1(+0.21.7) / 1.26.0 / 1.13.1 / 0.4.45 / 2.5.0 / 3.27.0 / 5.4.3 | prod | |
| `btleplug` | **`[patch.crates-io]` 指向仓内副本 `src-tauri/vendor/btleplug`（90 个 .rs / 1.1 MB）** | optional，feature `bluetooth` **默认关**（`Cargo.toml:129-136`） | 事实：BLE 解析路径上跑的是**本仓自维护分叉**（补丁理由见 `Cargo.toml:170-176` WinRT 地址类型丢失）。默认产物不含它；开 feature 时它不在上游安全更新路径上 |
| tauri / runtime / wry | tauri 2.11.5（lock 首行版本对）、tauri-runtime 2.11.3、runtime-wry 2.4.1、tauri-build 2.6.3 | prod | 6 个插件：notification/dialog/**fs**/opener/window-state/single-instance |

前端：prod 依赖 13 个（`vue 3.5.13`、`pinia 2.2.6`、`@tauri-apps/api ^2.1.1`、`highlight.js ^11.10.0`、`@headlessui/vue`、`dayjs`、`clsx`、`tailwind-merge`、`lucide-vue-next`、`vue-easy-lightbox`、3 个 `@tauri-apps/plugin-*`）；dev 10 个（`vite ^6.0.3`、`typescript ^5.7.2`、`@tauri-apps/cli ^2.1.0`、`vue-tsc`、`tailwindcss ^3.4.17`、`postcss`、`autoprefixer`、`@types/node`、`@vitejs/plugin-vue`）⇒ **`highlight.js` 是 prod 且直接喂 §3.3 的 `v-html` 汇点**，是本表里唯一"版本 + 位置都安全相关"的格子；`vite`/`vue-tsc` 全为 dev-only，不进产物。

建议（属流程、不属代码）：把 `cargo audit` / `npm audit --omit=dev` 挂到**已存在的离线周检查**而不是 PR 门禁，避免与"不跑长门禁"冲突 —— 现有 `scripts/verify.mjs` 分层里目前没有联网依赖腿。

---

## 6. 可维护性与可扩展（按"改动半径"）

现算命令与结果（全部本轮执行）：

```
Rust 生产码 129 个 .rs / 51,878 行；*_tests.rs 37 个文件 / 20,111 行 ⇒ 比值 38.8%
前端 生产 192 个 .ts/.vue / 41,475 行；*.test.ts 83 个 / 16,307 行 ⇒ 比值 39.3%
include! 拆分点：全仓 73 处
scripts/*.mjs 量具 34 个
```

**最大 5 个生产文件**（`find … ! -name '*_tests.rs' | xargs wc -l | sort -rn`）：

| 行数 | 文件 |
|---|---|
| 1998 | `src-tauri/src/state.rs` |
| 1971 | `src-tauri/src/protocol.rs` |
| 1449 | `src-tauri/src/network/transport.rs` |
| 1381 | `src-tauri/src/network/discovery.rs` |
| 1324 | `src-tauri/src/commands/logs.rs` |

（前端最大 3 个：`src/stores/useChatStore.ts` 2811、`src/utils/designGuards.ts` 1996、`src/components/MessageItem.vue` 1705。）
⚠️ `useChatStore` 拆 store = `roadmap §3.3 C-2`、`handle_message` 分册 = `C-1`，两处都判为"纯搬家、短期只降稳定、本轮不做"（并见 `:1659` "`lib.rs` 拆 mod tests 旧账已作废"）⇒ **本文不重复建议**。

**被 `include!` 拆分的分册（按扇出计）**：`network/transport.rs` **24** 册、`commands.rs` **19**、`db.rs` **16**、`network/transport/tests.rs` 15、`network/file.rs` 6、`commands/group_files.rs` 4、`network/ble.rs` 4，另 `lib.rs`/`protocol.rs`/`commands/{favorites,group_file_dispatch,helpers}.rs`/`db/*` 各 1。⇒ 这不是"待清理的技术债"，而是**本仓既定的分册机制**（`e2ee_payload.rs:2-3` 自述"搬出后 `include!` 回同一模块 ⇒ 路径/可见性/测试全名一字不变"）。真实成本在**登记面**：`roadmap §13` 与 `docs/notes/changelog-archive.md:5618` 都记过"把 grep 出来的函数名清单当测试名单"“include 分册漏登记 ⇒ 假绿"这两次自骗。`scripts/check-domain-map.mjs` + `check-test-manifest.mjs` + `check-doc-numbers.mjs` 是现有对策 ⇒ **已审，只提醒"分册清单必须与守卫对账"，不建议合并回单文件**。

**跨语言常量同值（Rust 写一遍、前端再写一遍）**：现算 **11 个具名常量在前端有同名副本** —— `WIRE_KINDS`(4 文件)、`TODO_PRIORITIES`(5)、`TODO_CUSTOM_ICONS`(7)、`TODO_CUSTOM_CATEGORY_MAX_LEN`(3)、`TODO_STATUSES`(7)、`TODO_CATEGORIES`(5)、`TODO_CUSTOM_ICON_DEFAULT`(5)、`MAX_MERGE_ITEMS`(3)、`MAX_FRAME`(1)、`PROTOCOL_VERSION`(1)、`UNSUPPORTED_PREVIEW_LABEL`(2)。
同步机制**只有一处**且很脆：`src/utils/messageKinds.test.ts:56-57/98-99/163` 用 `readFileSync(protocol.rs)` + `indexOf("pub const WIRE_KINDS")` 到 `indexOf("];")` 的**字符串切片**比对前端表 ⇒ 上游改个换行/加一行注释不影响它，但把常量改成 `include!` 进来、或改名、或改成函数构造表，它会**静默扫不到**（`indexOf` 返回 -1 时切片为空）。`roadmap §3.4 D-12` 已把"从 Rust 全量生成 TS 类型"判为延后（只留 B-2 窄版本）⇒ **不建议上 codegen**；建议只做一件小事：给 `messageKinds.test.ts` 的 `rustTableOf` 加"锚点找不到 ⇒ 直接 FAIL"（现算该文件目前靠 `.expect(...)`/`indexOf` 混用，覆盖 3/11 个常量 ⇒ 另外 8 个（`MAX_FRAME`、`PROTOCOL_VERSION`、`TODO_*` 4 个、`UNSUPPORTED_PREVIEW_LABEL`）**没有任何跨语言对账判据**）。

**新增一格功能的"税"（以"新增一种消息 kind"为例，现算）**：需要动的文件 **21** 个（`grep -rlE "WIRE_KINDS|from_wire_str|is_non_notifying_kind|preview_content"`），其中 Rust 协议表 2、DB 侧 3（`db/{messages,conversations,favorites}.rs` 的 kind 白名单）、前端 9（`utils/{messageKinds,fileMeta,messages,todos}.ts` + 4 个 .vue + i18n）、守卫/测试 7。⇒ 这个数字是**"为什么本轮不加功能"的量化理由**，不是待办。

---

## 7. 本轮判定"真该动手"（≤3 格，均不新增功能）

| 格 | 一句话 | 半径 | 证据 |
|---|---|---|---|
| **1** | `open_file_native` 补上 `delete_file` 已有的 downloads 边界（或改收 `msg_id` 走 `resolve_media_path`） | 1 个命令函数 + 1 条单测 | `commands/files.rs:111-113` 对 `:82-106`、`helpers.rs:109-166`；链 `handle_messaging.rs:110-131` → `fileMeta.ts:31` → `useMessageFile.ts:187-195` → `localFile.ts:29` |
| **2** | `tauri.conf.json:33` 的 `csp: null` 换成最小 CSP（保留本仓实际需要的 inline style / asset 豁免），并实测主题首帧与 13 处 `v-html` 不破 | 1 行配置 + 一轮手工 | `tauri.conf.json:33`（全仓唯一 `csp` 命中）× 133 条注册命令 |
| **3** | §1.4：X25519 锚点读取抽出唯一入口（对齐已有的 `bound_ed25519_from_peer` 形状），把 `e2ee_payload.rs:15-19` 那句"安全码对得上不证明解得开"从注释升级成一条纯函数判据 | 4 个读取点 + 1 条纯函数测试 | `e2ee_payload.rs:19`、`commands/friends.rs:32-50`、`commands/groups.rs:112/219`、`commands/chat.rs:185`；现算读取点 7 处 / 唯一判定函数 0 个 |

其余全部为**登记**：§4.3 日志与私钥文件的 `0o600`（涉及 Windows/Linux 便携版，需拍板）、§5 联网依赖审计进周检、§6 跨语言对账锚点缺失 8/11、§0 文档路径引用更正（交给 `check-doc-citations.mjs`）。
D1–D5 五形状里，D2/D4/D5 本轮判为已审有缓解，**不动**。
