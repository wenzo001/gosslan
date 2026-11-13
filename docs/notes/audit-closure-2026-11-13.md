# 全项目审计 · 代码可验证项关闭记录（2026-11-13）

> 基线：`d76a0d07`（5.22.2）+ 本会话工作区改动。对应 `full-project-audit-2026-11-13.md` §5「待复核项」
> 与 §6 P0/P1 中**可在本环境用代码/测试验证**的部分。真机/人工验收项不在本文范围（明确标 NOT RUN）。
> 原则：旧审计（2026-10-29）只当线索；每条以**当前 HEAD 的调用链 + 行为测试 + 反例**重新定性，不抄旧状态表。

## 1. 旧 High 项复核结论

| 项 | 结论 | 当前 HEAD 证据 | 复核命令（本会话已跑） |
| --- | --- | --- | --- |
| SEC-01 未经同意的 FriendAccept | **已修复，维持关闭** | `handshake.rs:399` 无发出中申请即拒（`code=FRIEND_ACCEPT_UNSOLICITED`），不再凭空建好友 | `cargo test --features bluetooth --lib friend_identity` → `friend_identity_anchor_has_one_binding_rule ... ok` |
| SEC-03 Gossip 锚点信任未验签公钥 | **已修复，维持关闭** | `peer_registry.rs:268` announce 来的公钥恒 `keys_verified: false`；身份绑定只经 Hello 验签后 `mark_peer_keys_verified`（`transport.rs:731`、`dial.rs:124/569`） | 同上 friend_identity 测试（含「三条路径各绑一次公钥」断言） |
| FUN-01 单条图片转发必失败 | **已修复，维持关闭** | 可转发性收成单家 `messageKinds.ts:176 isForwardableKind`，前后端跨语言对账 | `node --test src/utils/messageKinds.test.ts` → 27 pass / 0 fail |
| STB-01 群文件同步写盘占 worker | **已修复，维持关闭** | 写盘收进 `group_file.rs:2248 write_group_chunk_blocking`（spawn_blocking 内），登记进 INV-P34 | `cargo test --features bluetooth --lib slow_work` / `--lib group_chunk` → ok；形状判据 `lib_file_tests.rs:1337`、`lib_relay_data_tests.rs:489` |

### 反例自证（这些判据不是空转）

- SEC-01/SEC-03：`lib_friend_identity_tests.rs` 断言「三条路径各绑一次公钥」与 `FRIEND_ACCEPT_UNSOLICITED`
  触发点存在；把拒绝逻辑或验签打标删掉，该测试会红。
- FUN-01：`messageKinds.test.ts` 现读 `protocol.rs` 的转发白名单与前端逐项比对；前端 `isForwardableKind`
  与后端漂移即红（10 月审计正是抓到这处漂移）。
- STB-01：`lib_relay_data_tests.rs` 的慢活判据把 `write_group_chunk_blocking(` 钉在 spawn_blocking 名单里；
  挪回 async worker 即红。

## 2. 单一事实源收敛（P1.3）现状

| 规则 | 单家落点 | 跨层对账 |
| --- | --- | --- |
| 消息类型 / 可转发性 | `src/utils/messageKinds.ts` | `messageKinds.test.ts` 读 `protocol.rs` 逐项比对 |
| 错误码 | `src-tauri/src/error_codes.rs` | `errors.test.ts`「前端读的码 ⊆ 后端产出的码，且后端每个码都被用到」 |
| 任务状态 / 优先级 / 类型 | `src/utils/todos.ts` 常量表 | `messageKinds.test.ts` 读 `protocol.rs` 同序同值比对 |
| 长度上限 | `src/utils/todos.ts` / `validation.ts` | `textLimits.test.ts` 现读 Rust `const MAX_*_LEN` 数值相等 |
| 领域边界 / 依赖方向 | `docs/domains.data.mjs` | `check-domain-map.mjs` + `check-domain-deps.mjs`（consumes 声明） |

本会话新增的「外部应用设备认证」沿用同一口径：错误码进 `error_codes.rs` 并经 `errors.test.ts` 双向对账；
独立 `device-auth` 领域（`consumes: ["observability"]`），与核心 P2P 身份隔离，不触好友/传输/身份锚点。

## 3. 明确 NOT RUN（需真机 / 人工，不在本环境）

- 三平台真机矩阵：好友建立、离线补发、群聊/群文件、文件打开、权限撤销、后台接收、升级覆盖、崩溃恢复。
- 外部应用设备认证的**真机深链唤起**与系统协议注册/卸载语义（macOS Universal Links / Windows 协议注册 /
  Android intent filters）。客户端协议核心、绑定状态机、签名已由单测覆盖（`device_auth` 14 测试）；
  RP 后端契约由 `scripts/device-auth-rp-mock.mjs` 驱动联调。
- 视觉动效在 WKWebView / WebView2 / Android WebView 的实机表现与低端机性能。

> 这些格保留 NOT RUN，不以模拟测试冒充真机凭据（审计 P0.3 / P1.4）。
