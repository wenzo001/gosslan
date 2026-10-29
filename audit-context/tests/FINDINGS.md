# Gosslan 测试盲区评估（TEST BLIND SPOT）

> 审计日期：2026-10-29
> 审计对象：`/Users/wendongfu/Documents/code/gosslan`
> 审计方式：**只读静态审计 + 少量便宜的真跑**。没有跑 `npm test` 全量、没有跑 `cargo`。
> 审计者声明：本文件里每一条结论都带 `file:line` 或一条我实际跑过的命令。
> 我**没有**验证的部分在文末「本次未能验证」里逐条列出。

---

## Coverage inventory

| Layer | Test count | Registered where | Notes |
|---|---|---|---|
| 前端单测（node:test） | 138 个 `.test.ts` 文件，**1471 条**断言（题设基线） | `package.json:19` — `node --test --experimental-strip-types "src/**/*.test.ts" "scripts/*.test.ts"` | 清单由 `scripts/check-test-manifest.mjs` 现场对账：磁盘 138 个文件全部被 glob 覆盖。但 **138 这个数里有 1 个是假的**（见 TST-01） |
| Rust 单元测试 | `#[test]`/`#[tokio::test]` 属性 **1303 处**（我 grep 现算）；题设基线 1272 passed + 1 ignored | `src-tauri/src/**`（`include!` 分册） | 按目录：`(root)` 380 / `network/` 364 / `db/` 285 / `commands/` 98 / `mesh/` 90 / `transport/` 51 / `storage/` 17 / `content/` 14 / `discovery/` 4 |
| Rust 跨平台基线 | macOS 1291 条 / Windows 1269 条 | `src-tauri/test-baseline.macos.txt`（1291 行）、`src-tauri/test-baseline.windows.txt`（1269 行） | 清单守卫 `scripts/check-test-manifest.mjs` 现场比对；差额需源码门控背书 |
| 护栏（guard）非空转 | **276 条** | `scripts/guard_cases/` 7 个分册（`MODULES` 与目录实文件对账，见 `scripts/guard_cases/__init__.py:32`） | `python3 scripts/verify-guards.py --print-lanes` ⇒ `GUARD_LANES cargo=152 npm=0 node=90 script=34 all=276` |
| 护栏按域分布 | ble_android 39 / transport_network 38 / file_transfer 56 / desktop_misc 30 / frontend_ui 63 / frontend_state 19 / toolchain 31 | 同上 | 我实跑 `importlib` 逐册现算 |
| E2E 双实例轮次 | 24 个正向轮 + 24 个 `-lie` 反证轮 | `package.json:54-97`，`scripts/e2e-multi-instance.mjs` + `scripts/e2e/rounds/*.mjs`（22 册） | **全部只在本地层**（`verify.mjs --group local`），远端 CI 一条都不跑（`docs/acceptance/stability-smoke-matrix.md:258` 自陈） |
| 稳定性冒烟矩阵 | 23 个 P0 格 + 13 个 Smoke 硬件格 | `docs/acceptance/stability-smoke-matrix.md` | 见下节 |
| 前端运行时探针 | `scripts/check-ui-runtime.mjs`（994 KB）+ `check-ui-runtime-ax.mjs` | `npm run test:ui-runtime` / `verify:ax` | 浏览器内 / macOS AX 探针，**不进远端 CI** |

**我实跑的便宜命令（原文）：**

```
$ python3 scripts/verify-guards.py --print-lanes
GUARD_LANES cargo=152 npm=0 node=90 script=34 all=276

$ node scripts/check-invariant-hooks.mjs
✓ 不变量钩子：36 条全部绑定（具名钩子 36 条、登记为无自动化 0 条） · 形态 rust:112 e2e:3 guard-case:15 frontend:26 script:5

$ node scripts/check-test-manifest.mjs
✓ 跨平台基线完整性：差额全部有源码门控背书（macos:1291+3，windows:1269+25）
✓ 前端测试清单：磁盘 138 个文件全部被 glob 覆盖（不会静默跳过）
✓ 基线名字与模块路径跨平台一致（核对 2 份基线）
⚠ 有 2 条新用例不在基线里（它们**会跑**，只是尚未纳入保护）：
    · commands::files_gate_tests::inspect_drop_paths_is_capped
    · commands::files_gate_tests::inspect_drop_paths_reports_name_size_and_directory
✓ Rust 测试清单：基线 1291 条全部在跑（另有 2 条新用例待纳入）

$ python3 scripts/verify-guards.py --lane script        # 整条通道真跑
✅ 34 条护栏通过非空转验证（每条：改坏必须 FAIL、红由它自己声明的 hint 报出、恢复后逐字节一致）
GUARD_TIMING ran=34 script=434.3s total=434.3s slowest=177.0s@script

$ python3 scripts/verify-guards.py --lane node --shard 0/6   # 部分
   [2/15] Win11 窗口字形都在 … ✅ 改坏即 FAIL 且红由声明的那条判据报出（⏱ 0.2s）
   [3/15] 常驻群任务窗口换群必须靠 :key 重挂 … ✅ （⏱ 1.6s）
```

---

## Per-platform manifest gaps

`diff <(sort src-tauri/test-baseline.macos.txt) <(sort src-tauri/test-baseline.windows.txt)` ⇒ **28 行差异**（25 条 macOS 独有 + 3 条 Windows 独有）。

**macOS 独有 25 条**（Windows 上不跑）：

| 域 | 条数 | 用例 |
|---|---|---|
| `db::migration_tests` | 4 | `a_failed_backup_sweep_reports_a_searchable_code`、`init_tightens_database_sidecars_and_backup_to_owner_only`、`init_tightens_historical_backups_but_not_unrelated_files`、`real_data_copy_replays_migration_without_losing_rows` |
| `logging::tests` | 4 | `disk_write_failure_is_counted_and_noted_in_memory`、`log_and_crash_files_are_owner_only`、`log_dir_is_tightened_at_startup_and_covers_stale_logs`、`rotated_logs_keep_owner_only_permissions` |
| `macos_bookmark::tests` | 4 | `bookmark_to_a_deleted_directory_fails_cleanly`、`create_then_resolve_returns_the_same_directory`、`garbage_bookmark_is_an_error_not_a_panic`、`plain_bookmark_really_round_trips` |
| `menu::tests` | 3 | `every_label_is_present_in_both_languages`、`initial_lang_uses_only_explicit_preference`、`parse_maps_locale_tags` |
| `private_fs::tests` | 2 | `create_private_dir_makes_0700_and_leaves_an_existing_dir_alone`、`restrict_dir_to_owner_sets_0700` |
| `storage::cache_cleaner::tests` | 1 | `walk_files_never_follows_symlinks` |
| `transport::bluetooth_peripheral::tests` | 5 | macOS 外设 5 条（含 `leaving_powered_on_detaches_every_subscribed_central`、`central_mtu_clamps_and_never_returns_zero`） |
| `tray::tests` | 1 | `menu_bar_number_clears_at_zero_and_caps_at_99` |
| `user_dirs::tests` | 1 | `moved_directory_is_followed_through_the_bookmark` |

**Windows 独有 3 条**：

```
network::transport::tests::windows_abortive_close_allows_immediate_rebind
transport::bluetooth_peripheral_windows::tests::fragmentation_round_trips_at_windows_notification_size
transport::bluetooth_peripheral_windows::tests::peripheral_and_central_agree_on_payload_budget
```

**判读**：

1. 平台差额的**成因是明确的**（`#[cfg(target_os)]` 互斥），清单守卫 `check-test-manifest.mjs` 会核「差额必须有源码门控背书」⇒ **没有"忘了登记"的平台洞**。这一格是健康的。
2. **但有一个真实的不对称**：`storage::cache_cleaner::tests::walk_files_never_follows_symlinks`（审计 P1.1，软链目标会被当缓存永久删除）**只在 macOS 跑**。Windows 上 `cache_cleaner` 无对应用例。
3. `logging::tests::disk_write_failure_is_counted_and_noted_in_memory` 只在 macOS ⇒ **「写盘失败」这条错误路径在 Windows 上没有单测**（Windows 正是历史上出过 SIGABRT / 磁盘问题的平台，见 `verify.yml` 里 Windows 加载期 `0xc0000139` 那一大段）。
4. `macos_bookmark` 4 条 vs Windows 无对应物 ⇒ **Windows 上没有「书签失效/沙盒路径回退」的任何用例**（Smoke-8 至今"未做"）。
5. `tray::tests::menu_bar_number_clears_at_zero_and_caps_at_99` 只在 macOS ⇒ Windows 托盘数字角标无单测。

**结论**：平台差额的"登记"是完整的（无漏登记 ⇒ 无假绿）；但"覆盖"是不对称的：**Windows 侧缺 3 类生产行为用例**（缓存清扫软链、磁盘写失败、托盘角标），这些不是 `#[cfg]` 造成的物理限制，是当时只在 macOS 上写了。

---

## Guard quality (vacuous / no injection / shape-only)

### 守卫总数与注入点

| 指标 | 数值 | 来源 |
|---|---|---|
| 守卫总数 | **276** | `verify-guards.py --print-lanes` ⇒ `all=276` |
| **有真实注入点的守卫** | **276 / 276（100%）** | 我逐条遍历 `CASES`：`injections` 非空 276 条，`extra_injections` 另有 9 条用例各带第二处注入 |
| 每条守卫都声明 `expect_fail_hint` | 276 / 276 | `verify-guards.py:549-557` 起跑前核对，空 hint 直接 `return 1` |
| 平台受限守卫 | 3（2 条 darwin-only、1 条 darwin+linux） | `Case.platforms` |
| 声明 `env_skip` 的守卫 | 1 | 「发现 socket 必须收得到广播」 |

**⇒ 就"有没有注入点"这一条而言：零真空守卫。** 这是这套系统最强的地方，我不打算把它说弱。

### 但断言的性质分三层

我逐条把 276 条按"断言对象"分类（脚本化判定，见下）：

| 类别 | 条数 | 判据长什么样 | 空转风险 |
|---|---|---|---|
| **A. 真行为断言**（Rust 里真的调生产函数，跑 SQLite/文件/网络，再断言状态） | **~71** | `assert_eq!(status, "done")` / `assert!(ack_delivered(...))` | 低。破坏生产码必红。 |
| **B. 源码形状断言**（`include_str!` 读生产源码 + `.contains()` / `code_flat()`） | **~74** | `assert!(src.contains("db::ack_delivered(&dbc,&msg_id,peer_id)"))` | **中**。它证明"这段字在源码里"，不证明"这段字在运行时被走到"。 |
| **C. 静态扫描器**（`node scripts/check-*.mjs`） | 34 | 扫源码文本 / 扫清单 / 扫 CI 配置 | 中。同样是形状层。 |
| D. 上面几类的守卫走 `cargo test --lib <filter>`，但 filter 命中的是 B 类用例（一个 `#[test]` 里既有 A 也有 B） | 混在 A/B 里 | | |

我的分类脚本（可复跑）：对每条 `cargo` 通道守卫，从 `case.cmd` 抽出 `cargo test` 的过滤器 → 在 `src-tauri/src/**/*.rs` 里定位 `fn <filter>(` → 取该函数体 3000 字符 → 检查是否出现 `include_str!` / `read_to_string` / `source_view`。命中 ⇒ 形状层。

```
Counter({'SRC-TEXT': 74, 'RUNTIME': 71, 'NOFILTER-ALLBLUE': 7})
```

### 我逐条核过的"自等断言"（用户点名的那个形状）

用户说：「a guard that asserts `contains("DELETE FROM outbox")` inside a body that always contains that string regardless of the behavior — that is a vacuous guard.」

我照这条线索查了 `lib_delivery_shape_tests.rs:655-660`：

```rust
let ack_body = rust_fn_body(include_str!("db/messages.rs"), "pub fn ack_delivered(");
assert!(
    ack_body.contains("SET status = 'delivered'") && ack_body.contains("DELETE FROM outbox"),
    "1:1 Ack 的事务出口必须真的把状态写成 delivered 并删 outbox 行"
);
```

**判定：不是自等断言。** 理由三条：
1. `ack_body` 是 `rust_fn_body()` 从 `db/messages.rs` 里**切出来的 `ack_delivered` 函数体**（`lib_source_view_tests.rs:271-289`），不是整文件。
2. 这条守卫的注入点就是 `db/messages.rs` 里 `ack_delivered` 的那两句 —— 把它改坏，`ack_body` 里那两个字面量就消失，断言立刻红。
3. 同一条用例**自带阳性对照**：`group_ack_advances_sender_message_status_like_dm_ack_does` 同时断言 1:1 臂（`db::ack_delivered`）与群臂（`db::ack_group_delivered`）两条，`lib_delivery_shape_tests.rs:650-674`。注释里明写「它同时保证本判据不会在'两边都没有'的世界里假绿」。

**但这里有一个真实的、值得记下的系统性问题**：

### 形状守卫的"分母空了"陷阱 —— 已被本仓自己抓到并修过一次

`lib_source_view_tests.rs:170-178` 那条反向自检写得很清楚：

> 反向自检：解析器如果整体失效（两边都空 / 都少），上面两条会同时通过 ⇒ 空转。所以每个用例点一枚 canary。

这是本仓对"自等断言"这一族**唯一系统性的防御**：给形状守卫配一枚 canary（必须同时出现在"真实闭包"与"登记清单"里）。它守住的是**解析器失效**，守不住**"断言的字面量恰好在别的函数里"**。

### 形状守卫的真实失效模式（仍然存在）

形状层断言"B 类"有一个**结构性的**弱点，且它在本仓**确实存在实例**：

`lib_source_view_tests.rs:301-330` 那条 `transport_src_never_whole_file_read` 用「阳性对照 = 视图里必须至少有 1 处 `std::fs::File::open(`」来防"零命中是尺子读空了"。这是**对的做法**。

但同文件 `:377-419` 那条 `preview_reads_run_off_the_async_worker` 的**阳性对照缺失**：它对三个函数各断言 `spawn_blocking(` + `max_bytes.min(15*1024*1024)` 存在，**没有一条断言"这个尺子确实读到了这个函数体"**。若哪天 `rust_fn_body` 的签名锚点改名，`rust_fn_body` 会 `panic!("源码里找不到 {signature}")`（`lib_source_view_tests.rs:279`）⇒ 报错而不是假绿，**这一点是安全的**。但若锚点**命中了另一个同名/相似函数**，就会读到错误的函数体且断言照样可能过。

**⇒ 归纳**：
- 「断言的字面量恰好在被注入的函数体里」这一族，**本仓已用 canary + 阳性对照 + `panic` 兜底处理得相当扎实**。
- 「断言读的是 A 函数、注入改的是 B 函数」这一族，**没有系统性的防御**。我用脚本量过：**40 条守卫**（152 条 cargo 通道里）注入的文件与断言读取的文件**不是同一个**，其中 71 条走 `*_src_for_guards()` 视图（视图把多个分册拼起来，注入落在视图内 ⇒ 仍有效），剩下的是**真正的可疑集**（脚本的粗口径，会误报 —— 因为大量 B 类断言本来就在同一个文件里、只是我的 `include_str!` 相对路径解析没对上）。**我没能把这一族彻底分离，这是本次审计的已知缺口。**

### 守卫质量小结

| 维度 | 结论 |
|---|---|
| 有注入点 | **276/276，零例外** — 优秀 |
| 注入后必须 FAIL 且红由自带 hint 报出 | 机制齐备（`verify-guards.py:378`、`:399-405`），我实跑 script 通道 34 条全绿 |
| 恢复后逐字节一致 | 机制齐备（`:396-398`） |
| 起跑前锚点存在性/唯一性核对 | 机制齐备（`:509-537`），实测 0 处死锚点 |
| hint 不得为空 | 机制齐备（`:549-557`） |
| 命令形态（点名的文件必须存在且在 `npm test` 语料内、禁裸 `npm test`） | 机制齐备（`:584-615`） |
| **断言层混用**：74 条形状断言与 71 条行为断言混在同一套机制里，**没有一条标注自己属于哪一层** | ⚠️ 缺口 |
| **形状守卫的自等防护只覆盖"解析器失效"**，不覆盖"断言读错函数" | ⚠️ 缺口 |
| **护栏非空转只在 `schedule` / `workflow_dispatch` 跑** | ⚠️ **重要缺口**，见 TST-05 |

---

## Critical-path coverage matrix

> 判据：**存在一个自动化测试，若该行为被破坏它会红**。只写"单元级"不算跨进程；只写"形状守卫"降半档。

| Feature | Automated test (cite) | Grade | Gap |
|---|---|---|---|
| **message send → outbox → transport → ack → delivered** | `db/messages.rs:1027` `ack_delivered` 落 delivered + 删队列行（同一事务）；`db/messages.rs:1064` `duplicate_and_late_acks_are_idempotent_and_never_change_the_verdict`；`network/transport/outbox_tests.rs:236` `ack_local_sender_marks_delivered_and_clears_outbox`；跨进程：`scripts/e2e/rounds/posttext.mjs` | **AUTOMATED（单元）+ AUTOMATED-LOCAL（跨进程）** | 跨进程那一档**不在远端 CI**（`stability-smoke-matrix.md:258` 自陈） |
| **duplicate delivery idempotence** | `db/favorites_tests.rs:824` `insert_message_if_new_distinguishes_first_from_duplicate`；`db/group_history.rs:632-634` 同一页写两遍全 duplicate；`network/file_tests.rs:1334` `group_receive_rejects_gap_but_ignores_duplicate_seq`；`file_relay.rs:341` `duplicate_chunk_is_ignored_not_double_counted`；`transport/ble_framing.rs:470` `duplicate_and_partial_do_not_complete` | **AUTOMATED** | 无 |
| **file transfer: chunk ordering** | `network/file_tests.rs:186` `chunk_seq_rule_only_rejects_real_gaps`（**调生产函数 `chunk_seq_decision`，不是镜像** —— `network/file/receive.rs:894`）；`network/file_tests.rs:1366` `group_chunk_seq_rule_has_exactly_one_home` | **AUTOMATED** | 无。**这是本仓做得最好的一格** |
| **file transfer: hash verification failure** | `network/file_tests.rs:861` `receiver_hash_mismatch_fails`；`:1880` `sha_mismatch_does_not_complete_the_content_ledger`；`:1518` `group_done_sha_mismatch_fails_and_cleans_part` | **AUTOMATED** | 无 |
| **file transfer: cancel** | `network/file_tests.rs:2410` `a_user_cancel_never_enters_the_retry_queue_and_is_not_a_failure`；`db/cascade_tests.rs:465` `a_completed_transfer_row_is_never_downgraded`；`network/file_tests.rs:800` `file_cancel_keys_are_scoped_per_recipient` | **AUTOMATED（单元）** | ⚠️ **跨进程"对面真的停了"无判据**（协议无 Cancel 帧 —— 矩阵 `:206` 自陈） |
| **file transfer: resume** | `network/file_tests.rs:1080` `group_resume_prefix_plus_suffix_finishes_with_the_original_sha`；`:3316` `resume_prefix_identity_distinguishes_same_content_from_another_one`；`lib_source_view_tests.rs:461` `resume_receive_checks_the_prefix_identity_before_reading_it` | **AUTOMATED** | 跨进程续传靠 `--fault=resume-prefix` 轮（本地层） |
| **file transfer: oversized file** | `network/file_tests.rs:2302` `chunk_length_may_fill_declared_size_but_must_not_exceed_it`；`:1401` `group_receive_rejects_oversize`；`network/file/receive.rs:910` `chunk_exceeds_declared` | **AUTOMATED** | 无 |
| **file transfer: disk-full** | `storage/disk_space.rs:96` `verdict_of` 纯函数 + `:225-310` 边界用例；`lib_source_view_tests.rs:525` `inbound_admission_preflights_the_disk_space_with_the_right_folding`（**形状**） | **SIMULATED** | ⚠️ **真 ENOSPC 中途发生**没有自动化：`storage/disk_space.rs:7-8` 自陈「写到一半 `ENOSPC` → 整单失败」正是要防的场景，而**这条路径只由跨进程 `--fault=recv-readonly` 轮覆盖（本地层）**。写入中途真 ENOSPC 的兜底（保留 `.part` + 台账 failed + 回 Ack(false)）在 `lib_source_view_tests.rs:571` 只以**形状**断言存在 |
| **group file transfer** | `network/file_tests.rs:975-1573` 一整族（`group_file_key_roundtrip_with_group_key`、`:988` wrong-key/tampered、`:1200` distinct nonces、`:1432` done roundtrip、`:1476` rename、`:1518` sha mismatch、`:1537` rename failure、`:1573` `group_file_complete_ack_roundtrip`）；`commands/group_file_dispatch_tests.rs` 5 条；跨进程 `--round=gfile` | **AUTOMATED（单元）+ AUTOMATED-LOCAL（跨进程）** | 「离线成员先 pending、重连后自己补上」跨进程无判据（矩阵 `:205` 自陈） |
| **group tasks CRUD + numbering** | 编号：`db/groups.rs:460` `next_todo_number` / `:427` `todo_number_high_water`（`db/groups.rs:502-567` 有 6+ 条边界用例）；`db/group_history.rs:437` `raise_todo_number_floor` + `:924` `todo_floor_only_raises_and_ignores_a_missing_field`；读取：`db/todo_reads_tests.rs` 4 条 | **AUTOMATED（编号/读取）** | ⚠️ **群任务的 CRUD 写路径本身无独立单测**：`db/next_todo_number` 只在 `commands/group_files.rs:243` 被调（创建那一刻分配），而**「改状态/归档/重开/认领」这几步的编号不变性只有跨进程 `--round=task` 轮**（本地层，49 断言）。⚠️ 任务**类型**与**认领**两格矩阵 `:234` 自陈"只到单元层"且"跨实例这一格没判" |
| **friend add / accept / reject / delete** | add：`db/favorites_tests.rs:147` `friend_add_and_pubkey_persistence`；accept：`lib_friend_identity_tests.rs:81` `every_friend_accept_path_forgets_the_pending_request` + `:193` `friend_request_from_existing_friend_auto_accepts`；delete：`db/favorites_tests.rs:299` `friend_remove_then_readd_flow` + `lib_friend_identity_tests.rs:358` `removing_a_friend_also_drops_the_in_memory_identity_binding` | **AUTOMATED（单元）** | ⚠️ **reject 路径无任何单测**：`network/transport/handle_identity.rs:216-229` 的 `Message::FriendReject` 臂（`forget_pending_request` + emit `friend-rejected`）**在整个 `src-tauri/src` 里没有任何 `#[test]` 命中**。矩阵 `:176` 自己写「**无跨进程一致性证明** → J4」 |
| **message recall (author + group owner)** | author：`protocol_tests.rs:1685` `recall_verdict_covers_author_conversation_and_window`；group owner：`protocol_tests.rs:1854` `recall_receive_allowed_matrix` + `commands/files_tests.rs:282` `creator_recall_authority_is_wired_on_both_ends`（后者是形状）；落库：`db/favorites_tests.rs:386` `recall_is_idempotent_and_materializes_content` | **AUTOMATED（单元）** | ⚠️ 群主特权的**接线**只有形状守卫（`creator_recall_authority_is_wired_on_both_ends`）；跨进程撤回靠 `--round=group` 那条 |
| **read receipts / unread badge** | 已读：`db/read_receipts_tests.rs:42-104` 5 条 + `network/transport/read_receipt_tests.rs:12` `read_receipt_marks_messages_as_read`；未读：`db/conversations.rs:117` `mark_read` + `src/utils/channelState.test.ts:823-860`（`clearUnreadLocally` / `applyConversationSnapshot` 形状） | **AUTOMATED（单元）** | ⚠️ 徽标**渲染**只在浏览器探针（`check-ui-runtime.mjs`）+ macOS AX 一读数（`GOSSLAN_AX=1 npm run test:e2e:group`）；**移动端群已读"不见了" = #30 未定位**（矩阵 `:182`）。跨进程群已读点亮无判据（矩阵 `:197`） |
| **identity persistence across restart** | `device.rs:153` `generated_id_keeps_the_one_prefix_and_length`；`:185` `identical_attributes_still_produce_different_ids`；`:220` `legacy_dev_prefix_is_stripped_exactly_once`；迁移保身份：`migration_tests.rs` `migration_preserves_identity_data` | **SIMULATED** | ⚠️ 矩阵 `:236` 自陈：「**'重启不再派生'这一分支没有以自己名字存在的用例**」，且「初始化时**重新生成**」与代码要求恰好相反 |
| **TOFU → pinned key transition** | `network/transport/handshake_tests.rs:158` `hello_auth_tofu_requires_self_consistent_signature`；`:210` `gossip_trust_for_known_friend_never_tofus`；`:265` `new_peer_entry_respects_friend_key_anchor`；`lib_friend_identity_tests.rs:257` `friend_identity_anchor_has_one_binding_rule` | **AUTOMATED（单元）** | ⚠️ `acceptable_friend_keys` / `mark_peer_keys_verified` **没有以自己名字命名的行为用例**（矩阵 `:236` 明写）。形状守卫 `lib_friend_identity_tests.rs:282-320` 钉"唯一家"与"次序" |
| **key-change conflict** | `lib_friend_identity_tests.rs` `key_rotation_candidate_requires_friend_and_new_key_self_signature`（2 条）、`pending_key_rotation_cleared_on_both_friend_removal_paths`（2 条）、`sync_friend_keys_replaces_both_trust_legs_under_explicit_confirm` | **AUTOMATED（形状 + 少量行为）** | ⚠️ 全部是**形状**守卫（读源码判 `contains("...")`）。真实「对端换钥后旧消息解不开」只有 `network/transport/e2ee_tests.rs:89` `reseal_with_current_receiver_key_recovers_where_retry_cannot` 一条 |
| **relay authorization** | `mesh/relay_policy.rs:294` `relay_authorization_truth_table`；`:214` `peer_relay_respects_policy_matrix`；`:403` `default_path_does_not_touch_friend_or_allowlist`；`commands/relay.rs:423` `load_relay_runtime_is_fail_closed`；`lib_relay_data_tests.rs:28` `relay_data_plane_respects_policy` | **AUTOMATED（单元）** | ⚠️ **token 值不得入日志/事件**只有**形状**守卫（`lib_relay_data_tests.rs:251` `relay_token_never_reaches_logs_or_diagnostics`），**无日志级断言**（矩阵 `:196` 自陈）。跨网真机 Smoke-9 是"人工验收，无机器判据" |
| **BLE framing** | `transport/ble_framing.rs:461` `out_of_order_chunks_still_complete`；`:470` `duplicate_and_partial_do_not_complete`；10 条用例；`network/file_tests.rs:374` `ble_file_chunk_actually_fits_the_ble_fragment_layer` | **AUTOMATED（单元）** | ⚠️ 真 BLE 收发 = Smoke-2，**永远人工**（同机 peripheral 广播不回喂本机 central，实测） |
| **UDP discovery spoofing / announce validation** | `protocol.rs:2452` `verify_announce`；`protocol_tests.rs:266` `announce_rejects_forged_signature_with_victim_pubkey`；`:219` `announce_rejects_tampering_on_every_signed_field`；`network/transport/handshake_tests.rs:116` `hello_auth_rejects_forged_sig_with_victim_pubkey` | **AUTOMATED（纯函数）** | ⚠️ **验签函数本身有测试，但"socket 收到一份伪造 UDP 包"这条路径无自动化** —— 冒名建链跨进程未测（矩阵 `:184`）。多网卡误判 = Smoke-1，未做 |
| **crypto: nonce reuse** | `network/file_tests.rs:1200` `group_chunks_use_distinct_nonces`（同 key 同明文两次密文必不同） | **AUTOMATED** | ⚠️ 只覆盖**群文件分片**一路。`crypto.rs:83-92` 的 `seal()` 通用路径**没有"连续 N 次 nonce 不重复"的统计性用例**（随机源正确 ⇒ 概率上不可能，但"必然"与"概率"在本仓的口径里是两件事） |
| **crypto: wrong key** | `network/file_tests.rs:988` `group_file_key_rejects_wrong_key_or_tampered_ciphertext`；`transport/relay_seal.rs:806` `tampered_record_is_rejected` | **AUTOMATED** | 无 |
| **crypto: tampered ciphertext** | `network/file_tests.rs:486` `tampered_chunk_fails_to_decrypt`；`network/transport/e2ee_tests.rs:133` `direct_open_rejects_corrupt_and_tampered_payloads`；`gossip_engine.rs:280` `envelope_sign_verify_and_tamper_detection` | **AUTOMATED** | 无 |
| **E2EE round trip** | `crypto.rs:333` `seal_open_roundtrip`；`network/transport/e2ee_tests.rs:20` `direct_open_succeeds_with_current_keys`；`:38` `direct_open_fails_without_sender_key_and_recovers_when_key_arrives`；`:167` `plaintext_payload_is_rejected` | **AUTOMATED** | 无 |
| **upgrade / downgrade version handling** | 降级拒绝：`db/migration_tests.rs:425` `migration_refuses_downgrade`；`:469` `downgrade_refusal_writes_nothing`；`:1845` `downgrade_refusal_creates_no_backup_and_writes_nothing`；`:496` `downgrade_message_says_who_is_old_and_what_to_do`；未知帧：`lib_delivery_shape_tests.rs` `unknown_wire_frame_is_tolerated_after_auth` | **AUTOMATED（单元）** | ⚠️ **新旧安装包互发 = Smoke-6，未做**（矩阵 `:211`）。且**真用户库升级 = Smoke-12，未做** —— 双实例轮每轮都把用户库整个挪走 ⇒ **整条迁移链在 E2E 层一行都不执行**（矩阵 `:293` 自陈） |
| **crash recovery (outbox survives restart)** | 跨进程：`scripts/e2e/rounds/gcrash.mjs`（建群崩溃轮，SIGKILL 发送端后对端自学到群、群密钥逐字节相同）；杀进程轮 `--fault=kill-mid` | **AUTOMATED-LOCAL** | ⚠️ **单测层无"重启后 outbox 仍在"的用例**：`db/favorites_tests.rs:1251` `pending_read_survives_restart` 只覆盖已读标记。outbox 跨重启只有跨进程轮（本地层） |
| **SQLite migration from older schema version** | `db/migration_tests.rs:1882` `every_supported_starting_version_replays_to_current_and_preserves_the_sentinel`；`:2024` `every_4x_entity_survives_the_v7_to_current_replay_with_its_semantics`；`:2506` `real_data_copy_replays_migration_without_losing_rows`（**`#[ignore]`**，需 `GOSSLAN_DRILL_DB`）；`:1916` `a_corrupt_database_is_rejected_and_left_byte_for_byte_untouched` | **AUTOMATED（单元，`#[ignore]` 一条除外）** | ⚠️ **迁移中途失败不可恢复 → J7**（矩阵 `:185` 自陈）。且那唯一一条"真实数据副本"用例是 **`#[ignore]`**（`db/migration_tests.rs:2504`）⇒ **默认 CI 永远不跑它** |

### 统计

**18 条关键路径中，有 0 条"完全没有自动化测试"。** 但按"若行为破坏是否必红"严格打折：

| 等级 | 条数 | 路径 |
|---|---|---|
| 纯 AUTOMATED（单元层坏必红） | **11** | 重复幂等、分片顺序、哈希失败、超限、群文件传输、撤回、已读回执、relay 授权、BLE framing、wrong key、tampered、crypto、E2EE |
| AUTOMATED 但**关键接线是形状断言**（重构即碎） | **3** | 群主撤回权限、key-change conflict、relay token 不入日志 |
| SIMULATED（只有纯函数/单进程证明） | **3** | 身份持久化、disk-full、nonce 唯一性（通用路径） |
| AUTOMATED-LOCAL（只在本地层，**不进远端 CI**） | **1** | 崩溃恢复 outbox |

---

## Uncovered error paths

### `src-tauri/src/commands/` —— 21 个生产模块**没有**同名 `_tests.rs`

```
channel.rs (883)        chat.rs (1473)          chat_search.rs (240)
dev_diag.rs (362)       external_links.rs (394)  favorites.rs (672)
friends.rs (299)        group_announcements.rs (570)  group_file_keys.rs (107)
group_files.rs (985)    group_todo_media.rs (215)     groups.rs (510)
mobile_picker.rs (498)  network.rs (535)         relay.rs (565)
routed.rs (123)         settings.rs (452)       share.rs (250)
system.rs (191)         updater.rs (828)        window.rs (391)
```

（只有 `files_tests.rs` / `helpers_tests.rs` / `logs_tests.rs` / `group_file_dispatch_tests.rs` 四个有专属分册。）

### `src-tauri/src/network/` —— 31 个生产模块**没有**同名 `_tests.rs`

含最大的几个：`network/file/receive.rs` (1640)、`network/transport/group_file.rs` (2513)、`network/transport/outbox_sweep.rs` (1123)、`network/transport.rs` (1523)、`network/discovery.rs` (1493)、`network/group_history.rs` (2209)、`network/transport/handle_file.rs` (672)。

> ⚠️ **重要限定**：Rust 里 `#[cfg(test)] mod tests` 可以**内联在生产文件里**，所以"没有同名 `_tests.rs`"**不等于**"没有测试"。我用 `grep -rEc "#\[(tokio::)?test\]"` 现算：`network/discovery.rs` 有 19 条、`network/transport.rs` 有 18 条、`network/transport/group_file.rs` 有 17 条。所以上面两张表**只说明"没有独立的分册文件"**，不说明"没有用例"。**真正的空白在下面逐条列的错误分支。**

### 逐条错误分支 —— 确实没有测试的

| 场景 | 生产码位置 | 有没有测试 | 证据 |
|---|---|---|---|
| **DB 写失败发生在事务中段** | `db/messages.rs:841` `ack_delivered`（置 delivered + 删队列行同一事务） | ❌ **无** | `db/messages.rs:1123` 只有一条 `ack_delivered(&conn,"m3","peer-a").is_err()`（外键错误），**没有"事务中途失败 ⇒ 不留半成品"** 的用例。`db/messages.rs:734-735` 的注释明写「两边都靠'队列行还在不在'仲裁」，而这个仲裁的失败路径无测试 |
| **DB 写失败发生在事务中段（文件侧）** | `network/file/receive.rs` 收尾写库 | ✅ 部分 | `network/file_tests.rs:1921` `content_ledger_write_failure_leaves_no_false_complete`、`:2475` `ledger_primary_write_failure_emits_one_diagnostic_note`、`:2507` `ledger_primary_and_fallback_both_failing_says_the_row_may_stay_active` —— **这一族做得好** |
| **磁盘满（真 ENOSPC 写到一半）** | `storage/disk_space.rs:7-8` 自陈；写入路径 `network/file/receive.rs` | ❌ **无自动化** | 预检是纯函数（`storage/disk_space.rs:96` `verdict_of`，有边界用例）+ 形状守卫（`lib_source_view_tests.rs:525`）。**"写到一半 ENOSPC"本身只有跨进程 `--fault=recv-readonly` 轮（本地层）** |
| **磁盘满（log 写失败）** | `logging.rs:387` `classify_write_failure` | ⚠️ 仅 macOS | `logging.rs:1772` `disk_write_failure_is_counted_and_noted_in_memory` —— **只在 macOS 基线里**（Windows 无） |
| **文件路径非法** | `network/file.rs` 的 `derive_file_name` / `rejects_path_traversal_file_names`；`network/file_tests.rs:290` `rejects_path_traversal_transfer_ids` | ✅ **有** | `network/file_tests.rs:246`/`:290`/`:3599` `retained_part_path_rejects_unsafe_transfer_ids` |
| **文件路径非法（命令层 ACL）** | `commands/files.rs`（`files_gate_tests` 14 条） | ✅ **有** | `commands/files_tests.rs:96` `forged_payload_path_is_rejected_when_ledger_points_elsewhere` 等 |
| **对端在传输中途断开** | `network/transport/outbox_sweep.rs` / `network/file/receive.rs` | ✅ 单元 + 跨进程 | `network/file_tests.rs:704` `stalled_receiver_is_reclaimed_only_after_the_idle_window`；`network/file_tests.rs:2337-2408` 四个失败/重试预算用例；跨进程 `--fault=peer-freeze` / `--fault=stall-mid` |
| **对端在传输中途断开（群文件）** | `network/transport/group_file.rs` | ✅ | `network/file_tests.rs:3367` `peer_offline_group_cleanup_takes_before_finalizing`、`:3423` `single_peer_offline_cleanup_also_takes_before_finalizing` |
| **时钟回拨** | `db/clocks.rs:41` `observe_clock`；`db/clocks.rs:20` `next_clock` | ⚠️ **部分** | `db/favorites_tests.rs:2410` `conversation_clock_is_monotonic` 有；但**"系统时钟被往回拨 ⇒ 消息排序错乱"没有用例**。`clock-align` 标签下的 2 条守卫都是**形状**守卫（`lib_delivery_shape_tests.rs:433`） |
| **消息 64 MiB** | `protocol.rs:16` `MAX_FRAME = 64*1024*1024`；`transport/tcp.rs:84` `read_bytes_capped` | ⚠️ **上限有、边界无** | `transport/tcp.rs:459-477` 有 cap 相关的用例（`read_bytes_capped` 超 cap 报错），`lib_source_view_tests.rs:427` `frame_reader_does_not_preallocate_the_declared_length` 是形状守卫。**但"一条恰好 64 MiB 的消息"整条业务路径（加密 → 分帧 → 落库 → 渲染）没有用例** —— 而 `protocol.rs:16` 的 64 MiB 是硬上限，命令层 `commands.rs:48` `MAX_OUTGOING_IMAGE_BYTES = 8 MiB` 才拦图片，**文本消息正文上限在哪一层拦，无测试定位** |
| **SQLite 迁移中途失败** | `db.rs` `run_migrations` | ❌ **无** | 矩阵 `:185` 自陈「迁移**中途失败**不可恢复 → J7」。`db/migration_tests.rs` 50 条里没有一条注入"迁移到一半崩" |
| **中继口令错误 / token 无效** | `commands/relay.rs:423` `load_relay_runtime_is_fail_closed` | ✅ 单元 | 但**真连一个错误口令的中继**无自动化（Smoke-9 人工） |
| **发现 socket 收不到广播** | `network/discovery.rs` | ⚠️ **环境受限** | 守卫「发现 socket 必须收得到广播」是**唯一**声明 `env_skip` 的守卫 ⇒ 本机/CI 容器里**这一格从未被证明过** |

---

## Untested frontend modules

### `src/composables/` —— 16 个文件**全部无同名 `.test.ts`**（但覆盖方式差别很大）

| 文件 | 行数 | 覆盖方式（实测） |
|---|---|---|
| `useMessageFile.ts` | **330** | 仅**形状**（`channelState` / `transferState` / `storeContract` / `fileMeta` / `transferProgressWatch` 五个测试读它的源码文本） |
| `useMessageDisplay.ts` | **224** | 仅**形状**（`messageKinds` / `designGuards` / `time`） |
| `useBackLayer.ts` | 121 | 仅**形状**（`designGuards` / `taskCenterJump`） |
| `useDropSend.ts` | 88 | 仅**形状**（`channelState`） |
| `usePressMenu.ts` | 87 | 仅**形状**（`designGuards`） |
| `useWindowLauncher.ts` | 67 | ❌ **完全无引用** |
| `useShortcuts.ts` | 65 | ❌ **完全无引用** |
| `useImeEnterGuard.ts` | 62 | 仅**形状**（`designGuards` / `defer`） |
| **`useMentionContext.ts`** | 57 | ❌ **完全无引用** —— 而矩阵 `:200` 说它「高亮与「@你」标签仍按我自己的昵称匹配正文里那串名字（`useMentionContext.ts:36-39` 的输入就是 `device.nickname`）」，是**同名两人高亮**那一格的核心 |
| `useMemberProfile.ts` | 38 | 仅**形状**（`memberName`） |
| `useClipboard.ts` | 43 | 仅**形状**（`componentImports`） |
| `useExclusivePopup.ts` | 32 | 仅**形状**（`popupRegistry`） |
| `useErrorText.ts` | 29 | 仅**形状**（`designGuards` / `errors`） |
| `useSearchKeyword.ts` | 26 | 仅**形状**（`defer`） |
| **`useSubmitGuard.ts`** | 24 | ✅ **唯一有真实运行时测试的**：`src/utils/submitGuard.test.ts:3` `import { useSubmitGuard } from "../composables/useSubmitGuard.ts";`（2 条用例，断言并发提交只放行第一次 + 失败后复位） |
| `useDocumentDark.ts` | 27 | 仅**形状**（`appearance`） |

**结论修正**：composables 不是"零覆盖"，而是 **1/16 有真实行为测试 + 12/16 只有源码形状断言 + 3/16 完全无引用**（`useWindowLauncher` / `useShortcuts` / `useMentionContext`）。
形状断言能证明"那段接线还在"，**不能证明"那个 composable 的逻辑对"** —— 而 `useMentionContext` 正是矩阵 `:200` 点名的同名两人高亮那一格的核心实现。

### `src/stores/` —— **3 个文件全部无 `.test.ts`**（100% 未覆盖）

| 文件 | 行数 | 说明 |
|---|---|---|
| **`useChatStore.ts`** | **3471** | **全仓最大的未测模块** |
| `useAppStore.ts` | 1147 | 应用级状态 |
| `useImagePreview.ts` | 130 | 图片预览 |

**关键证据：没有任何一个 `.test.ts` 在运行时 import 过这三个 store。**
我 grep 全部 `src/**`（精确到 import 语句）：
```
$ grep -rnE "^import .*(useChatStore|useAppStore|useImagePreview)|from \"[^\"]*stores/(useChatStore|useAppStore|useImagePreview)" --include="*.test.ts" src scripts
EXIT=1        ← 零命中
```
⇒ `useChatStore.ts` 里的一切（乐观占位替换、`onMessageAcked` advance、群任务同步、`flushNotifications`、会话快照应用、发送重试）**没有任何一条单元测试会因它坏掉而红**。

它们在 `.test.ts` 里出现的方式**全部是读源码文本**（形状断言），例如：
```
src/utils/designGuards.test.ts:2123  const storeSrc = readFileSync(join(srcDir,"stores","useChatStore.ts"),"utf8");
src/utils/designGuards.test.ts:2185  ["src/stores/useChatStore.ts", "api.sendGroupMessage(...)", "③ store 发送时丢了这一参"]
src/utils/memberNameCache.test.ts:109 const src = readFileSync(join(import.meta.dirname,"..","stores","useChatStore.ts"),"utf8");
src/utils/storeContract.test.ts:31-44  STORES = [{prefix:"app", file:.../useAppStore.ts}, {prefix:"chat", file:.../useChatStore.ts}]
```
⇒ 这是**形状**覆盖（"那段字还在吗"），**不是行为**覆盖（"store 算出来对吗"）。

> 这与矩阵 `:64` 记的那个真机事故直接相关：**「群里发完显示两条自己发的」根因是内存里同一个 msg_id 被插了第二份**，判据收在 `messages.test.ts` 的 `replaceOptimistic` + `designGuards.test.ts` ㉑ —— 也就是说，**store 里那个真出过一次事的函数，至今没有单元测试**，只有形状守卫。

### `src/utils/` —— 250 个文件，**18 个承载逻辑的文件既无同名 `.test.ts`、也未被任何测试 import**

用户题面说"245 files"；我 `find src/utils -type f | wc -l` ⇒ **250**（其中 130 个 `.test.ts`、120 个生产文件）。

**注意**：这 18 个是"**既没有同名 `.test.ts`、也没有被别的 `.test.ts` import**"的。
- `groupSummaryCacheCore.ts` 被 `groupSummaryCache.test.ts` import ⇒ **有覆盖**，只是文件名不同名（说明"同名测试"这条机械判据本身会误报）
- `saveDestination.ts` **有**同名文件 —— **而那个同名文件是假的**（TST-01）⇒ **实质 19 个 utils 模块零行为覆盖**

| 文件 | 行数 | 生产引用者数量 | 备注 |
|---|---|---|---|
| `filePreview.ts` | **290** | 13 | 文件预览 |
| `messageHeight.ts` | **274** | 10 | 消息气泡高度（虚拟列表依赖） |
| `previewMetrics.ts` | **205** | 13 | 预览尺寸 |
| `codeHighlight.ts` | 97 | 2 | 代码高亮 |
| `imageThumbnail.ts` | 85 | 4 | 缩略图 |
| `favoritePreview.ts` | 81 | 3 | 收藏预览 |
| `localFile.ts` | 70 | 5 | 本地文件（**含 `saveDestinationOf` 调用**） |
| `emoji.ts` | 68 | **39** | emoji（引用面最广） |
| `markdown.ts` | 55 | 3 | Markdown 渲染 |
| `textSelection.ts` | 50 | 4 | 文本选择 |
| `imageMime.ts` | 44 | 4 | MIME 判定 |
| `composerDrafts.ts` | 42 | 2 | 草稿 |
| `nowTick.ts` | 37 | 1 | 时间推进 |
| `toastManager.ts` | 27 | 2 | Toast |
| `saveImageAs.ts` | 16 | 2 | 另存为 |
| `quoteStyle.ts` | 14 | 2 | 引用样式 |
| `newlines.ts` | 12 | 3 | 换行 |
| `saveDestination.ts` | 39 | 3 | ⚠️ **有"同名测试文件"，但那是假的**（TST-01） |
| ~~`groupSummaryCacheCore.ts`~~ | 57 | 1 | ✅ **实际有覆盖**：`src/utils/groupSummaryCache.test.ts:3` `import { createGroupSummaryCache } from "./groupSummaryCacheCore.ts"` —— **文件名与被测文件不同名**，所以"同名测试"这条机械判据会误报 |

**⇒ 真实缺口是 18 个**（上表去掉 `groupSummaryCacheCore.ts`），加上 `saveDestination.ts` 这个"有同名文件但同名文件是假的" ⇒ **实质 19 个 utils 模块零行为覆盖**。

我逐个查过：这 18 个文件**没有一个被任何其他 `.test.ts` import 过**（`grep -rn "from \".*<name>\.ts\"" --include="*.test.ts"` 对 `markdown` / `messageHeight` / `previewMetrics` / `filePreview` / `composerDrafts` 等全部 0 命中）⇒ **零间接覆盖**。

### `src/components/` —— 40 个 `.vue`，**零 `.test.ts`**

组件层全部靠：
- `src/utils/designGuards.test.ts`（**403 条**用例，读 `.vue` 源码做形状断言）
- `scripts/check-ui-runtime.mjs`（浏览器内运行时探针）
- `scripts/check-ui-runtime-ax.mjs`（macOS 无障碍树）

⇒ **组件行为层没有任何单元测试**。矩阵 `:218` 记的"表情折叠成一枚胶囊"「是渲染层，DB 里没有那一格 ⇒ 只有 TS 用例与运行时探针级证据」就是这个结构。

---

## Test quality smells

| # | 气味 | 位置 | 判定 |
|---|---|---|---|
| **TST-01** | **伪测试文件**：`saveDestination.test.ts` 与 `saveDestination.ts` **逐字节相同**（`diff` 空输出，两文件均 1439 字节、mtime 均 2026-09-14 21:26），里面**一个 `test()` 都没有** —— 它是生产源码被复制一份改了后缀 | `src/utils/saveDestination.test.ts` | **Confirmed — 高危** |
| **TST-02** | **清单守卫被这个伪文件骗过**：`check-test-manifest.mjs` 报「磁盘 138 个文件全部被 glob 覆盖」—— 那 138 里有 1 个不含任何用例 | `scripts/check-test-manifest.mjs`（`--only frontend` 实跑输出） | **Confirmed** |
| **TST-03** | **`saveDestinationOf` / `isDialogCancelled` 零覆盖**：全仓 grep `saveDestinationOf` 在 `.test.ts` 里只命中伪文件自己那一份定义 | `src/utils/saveDestination.ts:11,31` | **Confirmed**。这两个函数被 `LogViewer.vue:247`、`localFile.ts:61`、`saveImageCore.ts:45` 三处生产调用 —— **"另存为"在 Android 上返回对象形状（`{file:"content://…"}`）的归一化逻辑，正是矩阵里那条"Android 上会报 invalid args destination: invalid type: map"事故的修复点，现在没有一条断言守着它** |
| **TST-04** | **Rust 有一条 `#[ignore]`**：`real_data_copy_replays_migration_without_losing_rows`（真实用户库迁移演练），需手工 `GOSSLAN_DRILL_DB` | `src-tauri/src/db/migration_tests.rs:2504` | **Confirmed**（题设基线里的那 1 条 ignored）。默认 CI 永不执行 |
| **TST-05** | **护栏非空转不在 push/PR 上跑** | `.github/workflows/verify.yml`（`guards-cargo` / `guards-web` 两个 job 的 `if: github.event_name == 'schedule' \|\| github.event_name == 'workflow_dispatch'`） | **Confirmed — 重要**。276 条守卫每天只跑一次（cron `20 19 * * *`）。**"每条守卫都被证明会红"这条纪律，实际约束力是 24 小时窗口** —— 24 小时内合进 main 的守卫改动没有任何机器检查 |
| **TST-06** | **形状断言占守卫的 ~48%**（74/152 cargo 通道），且**每条用例不标注自己属于哪一层** | `src-tauri/src/lib_*_tests.rs`、`network/file_tests.rs` 等 | **Confirmed**（分类脚本） |
| **TST-07** | **前端 403 条用例是源码形状扫描**（`designGuards.test.ts` 一个文件 403 条） | `src/utils/designGuards.test.ts`（5747 行） | **Confirmed**。规模最大、断言最"文本"的一族 |
| **TST-08** | **2 条新 Rust 用例不在基线里** | `commands::files_gate_tests::inspect_drop_paths_is_capped`、`..._reports_name_size_and_directory` | **Confirmed**（清单守卫实跑输出）。它们**会跑**（不在 `#[ignore]` 里），只是没有基线保护 ⇒ 哪天被删了清单守卫不会报 |
| **TST-09** | **组件层零单元测试** | `src/components/*.vue`（40 个） | **Confirmed** |
| **TST-10** | **`useChatStore.ts` 3471 行零单元测试** | `src/stores/useChatStore.ts` | **Confirmed** |
| **TST-11** | **形状守卫的"读错函数"无系统防御** | `lib_source_view_tests.rs:377-419`（`preview_reads_run_off_the_async_worker` 三个函数各断言，但**无阳性对照**证明尺子读到了对的函数体） | **Needs verification** —— `rust_fn_body` 在锚点找不到时会 panic（`:279`）⇒ 改名安全；但**同名函数**误命中未验证 |
| **TST-12** | **`skip` / `todo` / `only` 全仓 0 处** | `grep -rn "\.skip\|\.todo\|\.only" --include="*.test.ts" src scripts` ⇒ **0** | ✅ **干净** |
| **TST-13** | **快照测试**：全仓**没有** `node:test` 的 snapshot 机制使用（`node --test` 无内置 snapshot），**无过期快照** | — | ✅ **干净**（无风险） |
| **TST-14** | **时间依赖**：12 个前端测试文件含 `Date.now` / `new Date` / `setTimeout` | `channelState` / `staleGuard` / `todos` / `designGuards` / `chatSearchQuery` / `updater` / `defer` / `time` / `chatSearch` / `avatarSeed` / `componentImports` / `retrySend` | **Needs verification** —— 我**没有逐条**读这 12 个文件确认它们是"喂固定时间戳"还是"读真时钟"。`defer.test.ts` / `time.test.ts` 大概率是前者。**诚实标注为未验证** |
| **TST-15** | **文件系统状态依赖**：33 个前端测试文件含 `readFileSync` / `writeFileSync` / `mkdirSync` / `tmpdir` | 含 `reactionRoster` / `cancelSend` / `messageEnter` / `format` / `longPress` / `messageKinds` / `buildConfig` / `designGuards` … | **Needs verification** —— 大多是"读生产源码当夹具"（设计如此），但**是否有测试往仓库目录写文件**我未查 |
| **TST-16** | **网络依赖**：前端测试里无 `fetch`/`http` 实连（我未逐条确认） | — | **Needs verification** |

---

## Test blind spot findings

### TST-01 — `saveDestination.test.ts` 是生产源码的逐字节副本，零用例，却计入"138 个测试文件"

**Severity:** High **Status:** Confirmed

**Location:** `src/utils/saveDestination.test.ts`（全文 39 行）；真身 `src/utils/saveDestination.ts`（39 行）

**What:**
`src/utils/saveDestination.test.ts` 与 `src/utils/saveDestination.ts` **逐字节相同**（`diff` 无输出；两文件都是 1439 字节、mtime `2026-09-14 21:26`）。这个文件里**没有任何 `test()` 调用**，它是一份**带 `.test.ts` 后缀的生产源码副本**。

**Evidence:**
```
$ diff src/utils/saveDestination.ts src/utils/saveDestination.test.ts
（无输出 = 完全相同）
$ ls -la src/utils/saveDestination*
-rw-r--r--  1 wendongfu  staff  1439  2026-09-14 21:26  src/utils/saveDestination.test.ts
-rw-r--r--  1 wendongfu  staff  1439  2026-09-14 21:26  src/utils/saveDestination.ts

$ grep -c "test(" src/utils/saveDestination.test.ts
1        ← 这 1 处是注释里的 "test" 字样，不是 test() 调用
$ grep -cE "^\s*(test|it)\s*\(" src/utils/saveDestination.test.ts
0        ← 零用例

$ node scripts/check-test-manifest.mjs --only frontend
✓ 前端测试清单：磁盘 138 个文件全部被 glob 覆盖（不会静默跳过）
```

`saveDestinationOf` / `isDialogCancelled` 的全仓引用：
- 生产：`src/components/LogViewer.vue:16,247,259`、`src/utils/localFile.ts:17,61`、`src/utils/saveImageCore.ts:1,42,45`
- 测试：**只有 `src/utils/saveDestination.test.ts:11,31` 那份副本自己的定义**

⇒ **`saveDestinationOf` 与 `isDialogCancelled` 的真实覆盖率是 0。**

**Impact:**
1. "1471 条前端断言 / 138 个测试文件" 这两个数字里，**有 1 个文件是 0 条断言** ⇒ 真实文件数是 137。
2. `saveDestinationOf` 是**"另存为"返回值归一化**的唯一实现。它的注释自己写着：
   > 桌面端 `save()` 返回的是**路径字符串**；而 Android 的 SAF 实现返回 `{ file: "content://…" }` 对象 … 两种形状都必须认，否则 Android 上会把对象原样传给后端，报 `invalid args destination: invalid type: map`。
   这是一条**已经在真机上出过事故、且已在代码里写好了修复**的路径 —— 而修复本身现在**没有任何断言守着**。任何人把 `{file}` 分支删掉（"反正桌面端用不到"），Android 端立刻回到那个报错，而 138 个绿灯不会响。
3. `isDialogCancelled` 同理 —— 它决定"用户点了取消"要不要弹红条。删掉 ⇒ Android 每次取消保存都弹"保存失败"。
4. 更要紧的是**它让"清单守卫"这一族整体降级**：`check-test-manifest.mjs` 的判据是"磁盘上的 `.test.ts` 文件都被 glob 覆盖了吗"。它**只查文件名与 glob 的匹配**，**不查文件里有没有用例** ⇒ 任何一份源码复制成 `.test.ts` 就能给清单守卫贡献一个"绿"。

**Fix sketch:**
1. 立刻删掉 `src/utils/saveDestination.test.ts`（它是副本，不是测试）。
2. 补一份真的测试：给 `saveDestinationOf` 覆盖 4 个形状（字符串 / 空字符串 / `{file:"content://x"}` / `{file:""}` / `null` / `{file:123}`），给 `isDialogCancelled` 覆盖（`Error("File picker cancelled")` / 字符串 / `new Error("其他")`）。
3. **给清单守卫加一条判据**：每个被 glob 覆盖的 `.test.ts` 必须至少含 1 个 `test(` / `it(` 调用（可用 `scripts/jsScan.ts` 那份词法扫描剥掉注释与字符串再数，避免误判）。这一条一加，本仓的"138"就变成可信的数。
4. 同族检查：既然能复制源码当测试，就该有判据挡住"复制源码当测试"本身 —— 例如"`*.test.ts` 与同名生产文件逐字节相同 ⇒ 报红"。

**Regression test:**
```ts
// src/utils/saveDestination.test.ts （新写的真测试）
import { test } from "node:test";
import assert from "node:assert/strict";
import { saveDestinationOf, isDialogCancelled } from "./saveDestination.ts";

test("saveDestinationOf：桌面端字符串", () => {
  assert.equal(saveDestinationOf("/tmp/a.bin"), "/tmp/a.bin");
});
test("saveDestinationOf：Android SAF 的 {file} 形状必须被认（回归：曾报 invalid args destination: invalid type: map）", () => {
  assert.equal(saveDestinationOf({ file: "content://x/y.bin" }), "content://x/y.bin");
});
test("saveDestinationOf：无法识别的形状一律 null", () => {
  assert.equal(saveDestinationOf(null), null);
  assert.equal(saveDestinationOf({ file: "" }), null);
  assert.equal(saveDestinationOf({ file: 123 }), null);
  assert.equal(saveDestinationOf(""), null);
});
test("isDialogCancelled：Android 的 reject('File picker cancelled') 不该弹红条", () => {
  assert.equal(isDialogCancelled(new Error("File picker cancelled")), true);
  assert.equal(isDialogCancelled("File picker cancelled"), true);
  assert.equal(isDialogCancelled(new Error("磁盘写失败")), false);
});
```

---

### TST-02 — `useChatStore.ts`（3471 行，全仓最大的未测模块）零单元测试

**Severity:** High **Status:** Confirmed

**Location:** `src/stores/useChatStore.ts`（3471 行）

**What:**
`src/stores/` 三个 store **全部**没有 `.test.ts`。全仓没有任何 `.test.ts` 在**运行时** import 过 `useChatStore` —— 它在测试里出现的方式**全部是 `readFileSync` 读源码做形状断言**。

**Evidence:**
```
$ grep -rn "useChatStore\|useAppStore\|useImagePreview" --include="*.ts" src
src/api/events.test.ts:305:  const store = readFileSync(join(ROOT,"src","stores","useAppStore.ts"),"utf8");
   ↑ 唯一的 .test.ts 命中：读源码文本，不是 import
src/components/conversation/ConversationListItem.vue:39: const chat = useChatStore();
src/components/ShareDirectory.vue:20: const app = useAppStore();
   ↑ 其余全是 .vue
$ grep -rnE "^import .*(useChatStore|useAppStore|useImagePreview)" --include="*.test.ts" src scripts
EXIT=1        ← 零运行时 import
$ ls src/stores/
useAppStore.ts  useChatStore.ts  useImagePreview.ts     ← 无一个 .test.ts
```

**Impact:**
矩阵 `:204` 自己记了这个洞的后果：
> 群里发完「显示两条自己发的」根因是**内存里同一个 msg_id 被插了第二份** —— 一条真实记录有两条到达路径（后端为跨窗口同步加的自 emit、以及 `invoke` 的返回值），而那次「乐观占位→真实记录」的替换原来是**按位置**做的。判据收在 `messages.test.ts` 的 `replaceOptimistic` 那几条 + `designGuards.test.ts` ㉑（形状锁，带「坏形状必须被抓到」的对照）；等级仍是 SIMULATED —— **真机上还出现两条与否只有他能判**。

⇒ **出过一次真机事故的 store 函数，至今只有形状守卫与浏览器内探针，没有一条单元测试。** 其余 3471 行同理：`onMessageAcked` 的状态推进、群任务同步、`flushNotifications`、会话快照应用、发送重试与去重 —— 全部无单元测试。

矩阵 `:78` 还记了第二个洞：**任务轮的徽标那个数字"是前端 store 算的（库里没有这一格）"**，而那一格在跨实例层被判的是**它的输入**，不是输出 ⇒ **store 的输出至今无人证明**。

**Fix sketch:**
把 `useChatStore.ts` 里**纯函数/可注入依赖**的那部分先抽出来测，不要一上来就测整个 store：
1. 抽出「乐观占位 → 真实记录替换」为纯函数（入参：消息列表 + 真实记录；出参：新列表），按 `msg_id` 匹配而不是按位置 ⇒ 直接覆盖矩阵 `:204` 那个真机事故。
2. 抽出「会话快照应用」（`applyConversationSnapshot`）为纯函数 —— `channelState.test.ts:859` 现在只判它的**源码形状**，把形状判据升级成行为断言。
3. 抽出「消息列表按 `kind` 过滤」为纯函数（`messageKinds.ts` 的过滤表）。
4. 装依赖注入（`invoke` / `listen` 可注入）后，用 `node:test` 驱动 store 的 `sendMessage` / `onMessageAcked` / 乐观占位三段。
5. 至少先把 `useAppStore.ts` 的 `applyIsMobile()` 钉住（它是 `style.css` 里 `html:not(.is-mobile)` 唯一写者，`designGuards.test.ts` 判的是"这个类名必须对得上"，但**没人判 `applyIsMobile` 真的会写这个类**）。

**Regression test:**
```ts
// 抽出 store 纯函数后的最小行为回归（覆盖矩阵 :204 的真机事故）
test("乐观占位 → 真实记录：按 msg_id 替换，不按位置（回归：曾显示两条自己发的）", () => {
  const list = [opt("m1"), opt("m2")];
  const out = replaceOptimistic(list, real("m1"));
  assert.equal(out.filter(m => m.id === "m1").length, 1);
  assert.equal(out.length, 2);
});
```

---

### TST-03 — 护栏非空转（276 条）每天只跑一次，不在 push/PR 上

**Severity:** High **Status:** Confirmed

**Location:** `.github/workflows/verify.yml` — `guards-cargo` 与 `guards-web` 两个 job 的 `if:` 条件

**What:**
本仓最核心的纪律是"每条守门测试都必须证明它真的会失败"（`scripts/verify-guards.py:2-15` 的文件头写着"此前这一步靠人手做，于是有三类真实风险… 写了护栏但**从没验证过它会失败**（等于没有护栏）"）。但这 276 条守卫的验证**只在 nightly / 手动触发时跑**。

**Evidence:**
```yaml
# .github/workflows/verify.yml
guards-cargo:
    name: 护栏非空转 · cargo 通道（分片 ${{ matrix.shard }}/3）
    runs-on: macos-latest
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'

guards-web:
    name: 护栏非空转 · node + script 通道
    runs-on: macos-latest
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
```
而 `on.schedule` 只有一条：`cron: "20 19 * * *"`（UTC 19:20 = 北京 03:20）。

CI 里 `push` / `pull_request` 只跑：`frontend` 组、`rust` 组（macOS + Windows 两条腿）、`android` 组、`lint`、`supply-chain`。
⇒ **24 小时内合进 main 的任何守卫改动，都不会被"它真的会红吗"验证过。**

**Impact:**
1. 改坏一条守卫（让它的断言永远成立）→ 合并后**最长 24 小时**才被发现；如果 nightly 那趟因为别的原因提前红/超时，那条守卫可能连续几天没被验过。
2. 反过来：**新增一条守卫**（最常见的日常操作）→ 合并后立刻就有一条"从未被证明会红"的守卫在仓库里 —— 正是文件头点名的第一类风险。
3. `verify.yml:288-300` 那段注释自己承认过这件事：
   > **2026-10-19 之前**没有任何自动触发点 … 于是它实际上没人跑。
   那次修的是"完全没人跑"，**没修"只跑 nightly"**。
4. 我实跑确认机制本身是好的：`--lane script` 34 条全绿、`--lane node --shard 0/6` 前 4 条全绿 ⇒ **问题不是机制坏，是触发点太稀**。

**Fix sketch:**
1. **push/PR 上跑 `node` + `script` 通道**（合计 124 条，实测 node 89 条 ≈ 133.7s + script 33 条 ≈ 32.6s ≈ **2.8 分钟**，见 `verify.mjs` 里 2026-10-26 的读数）。cargo 通道（152 条 × ~25s ≈ 60 分钟）留在 nightly，但**在 push/PR 上跑一个抽样子集**（例如每条域各挑 1 条，7 条 × 25s ≈ 3 分钟），保证"新增守卫当天就被验过"。
2. 或者更省：`--lane node,script` 全跑 + cargo 通道用 `--shard 0/3` 跑一片。
3. 补一条**元守卫**（放 `scripts/guard_cases/toolchain.py`）："verify.yml 里 push/PR 必须至少覆盖 node+script 通道全量" ⇒ 这条元守卫自己也进 nightly 扫描，形成闭环。
4. 把 `cron` 从每天一次提到每 4 小时一次（`20 */4 * * *`），把"守卫改动最久 24 小时无人验"压到 4 小时。

**Regression test:**（元守卫，形状判据）
```python
# scripts/guard_cases/toolchain.py 新增一条
Case(
    name="护栏非空转：push/PR 上必须至少覆盖 node+script 两条通道",
    why="护栏改坏若只被 nightly 验，24 小时内合进 main 就是一条从未被证明会红的守卫",
    file=ROOT/".github/workflows/verify.yml",
    injections=[(
        "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'\n",
        "    if: github.event_name == 'schedule'\n",
    )],
    cmd=["node", "scripts/check-ci-guard-coverage.mjs"],
    expect_fail_hint="push/PR",
    tags=["ci", "guards"],
)
```

---

### TST-04 — 好友 **reject** 路径（`Message::FriendReject` 臂）零测试

**Severity:** Medium **Status:** Confirmed

**Location:** `src-tauri/src/network/transport/handle_identity.rs:216-229`

**What:**
`Message::FriendReject { from, to }` 臂做两件事：`forget_pending_request(state, &from)`（清**入站 + 出站**两张表）与 `emit("friend-rejected")`。这段代码的注释明确指出它曾经是一个**真缺陷**：
> 回执（同意或拒绝）走同一个清队列入口。这里原先只清**入站**那一张，而 `forget_pending_request` 的注释写的就是"同意/拒绝都要清两张" —— **漏掉出站登记 ⇒ `flush_pending_friend_request` 每次建链都把已被拒绝的申请再发一遍，对方那边的「新朋友」里那条申请永远删不掉。**

**Evidence:**
```rust
// src-tauri/src/network/transport/handle_identity.rs:216-229
Message::FriendReject { from, to } => {
    if from != peer_id { return; }
    if to != state.device_id { return; }
    forget_pending_request(state, &from);
    let _ = state.app.emit("friend-rejected", &from);
}
```
全仓 `src-tauri/src` 里，**没有任何 `#[test]` 命中 `FriendReject`**（我 grep `FriendReject|reject_friend|friend_reject` ⇒ 只有生产码 4 处命中：`commands/mobile_picker.rs:486`（发）、`protocol.rs:1912`（定义）、`network/transport.rs:1161`（放行白名单）、`network/dispatch.rs:57`（放行白名单）、`handle_identity.rs:216`（收）。零测试。）

对照：accept 路径有 `lib_friend_identity_tests.rs:81` `every_friend_accept_path_forgets_the_pending_request`（明确覆盖"两条 FriendAccept 路径"）；delete 有 `db/favorites_tests.rs:299` `friend_remove_then_readd_flow`；add 有 `db/favorites_tests.rs:147`。**只有 reject 这一格是空的。**

**Impact:**
1. 上面那个"已被拒绝的申请被反复重发"的缺陷**没有回归测试** ⇒ 下次有人重构 `forget_pending_request`（比如把出站清理挪走），缺陷会原样回来，而 CI 全绿。
2. `emit("friend-rejected")` 无接收方断言 —— 矩阵 `:182` 记的"移动端群已读'不见了' = #30，**未定位**"是同一族的"事件发出去了但没人接住"。
3. 好友流程的**两端一致性**整体无跨进程证明（矩阵 `:176`：「**无跨进程一致性证明** → J4」）。

**Fix sketch:**
1. 补一条单测：在 `lib_friend_identity_tests.rs` 里构造"入站 pending + 出站 pending"两行 → 走一次 `FriendReject` 臂 → 断言**两张表都清了**。
2. 断言 `friend-rejected` 事件**确实发出**（`AppState` 的 emit 可被测试替身接住）。
3. 补一条前端断言：`friend-rejected` 事件**有调用方接住**（`storeContract.test.ts` 已有"emit 必须有调用方接住，一路到命令名"这条形状判据 —— 把它扩到这条事件）。
4. 跨实例那一格：harness 造不出"应用自己执行一次 IPC 命令"，同矩阵 `:107` 的边界 ⇒ 记为人工，或在 harness 里加一条直写 DB 的 reject 路径。

**Regression test:**
```rust
#[test]
fn a_friend_reject_clears_both_pending_tables_and_notifies() {
    let conn = fresh_db();
    // 入站 pending + 出站 pending 各一行
    // ... 走 FriendReject 臂 ...
    assert_eq!(pending_request_count(&conn, "peer-a"), 0, "入站 pending 必须清");
    assert_eq!(pending_flush_count(&conn, "peer-a"), 0, "出站 pending 必须清（漏了它 ⇒ 每次建链重发）");
    assert_eq!(captured_events, vec!["friend-rejected"]);
}
```

---

### TST-05 — 群任务的 **CRUD 写路径**（改状态/归档/重开/认领）无独立单测，编号不变性只在跨进程轮

**Severity:** Medium **Status:** Confirmed

**Location:** `src-tauri/src/db/groups.rs:460`（`next_todo_number` 分配）；`src-tauri/src/commands/group_files.rs:243`（唯一调用点）

**What:**
群任务**编号**本身有扎实单测（`db/groups.rs:502-567` 六条以上边界用例 + `db/group_history.rs:924` `todo_floor_only_raises_and_ignores_a_missing_field`）。但**"改状态 / 归档 / 重开 / 认领"这四个写动作**各自的编号不变性没有独立单测。

**Evidence:**
```
$ grep -rn "next_todo_number\|todo_number_high_water" src-tauri/src
src-tauri/src/commands/group_files.rs:243:  db::next_todo_number(&dbc,&group_id)...   ← 创建那一刻分配
src-tauri/src/db/groups.rs:460: pub fn next_todo_number(...)                        ← 分配器
src-tauri/src/db/groups.rs:427: pub fn todo_number_high_water(...)                   ← 水位
src-tauri/src/network/group_history.rs:1382: let todo_floor = db::todo_number_high_water(...)  ← 群历史同步
src-tauri/src/db/group_history.rs:437: pub fn raise_todo_number_floor(...)           ← 只抬不降
```
`db/groups.rs:522-529` 那条用例只钉"任务行真的没了"这一件事：
```rust
// db/groups.rs:522-529
// 只钉"行真的没了"这一件事。`todo_number_high_water` 在这里**不该**归零 ——
assert_eq!(next_todo_number(&conn,"g1").unwrap(), first + 1);
```
⇒ **"改了状态之后编号不变"**这件事在单测层**没有任何一条断言**。它的证据全部来自跨进程 `--round=task` 轮（49 断言，**只在本地层**）。

矩阵 `:234` 记的更狠：
> 任务**类型**、需求**认领**）今天**只到单元层** —— 窄档三次单点变异各红对应那一条断言 … **跨实例这一格没判**：任务轮的载荷字段对齐没带 `category`，认领那条窄档也没穿过两个真进程。

**Impact:**
1. 编号是用户可见的（Smoke-13 判据里写明「类型 bug、号 12345 时可见文本恰为 `B2345`」）。**"改了三次状态后编号被重新分配"** 是一条用户立刻会发现的缺陷，而它今天只有本地跨进程轮挡着 —— **那条轮不在远端 CI**。
2. 「认领」与「类型」两格，矩阵明说跨实例没判。
3. `raise_todo_number_floor` 只抬不降 —— 这个语义有单测（`:924`），但**"两台机器各自算出的编号会不会撞"**只有跨进程轮。

**Fix sketch:**
1. 在 `db/` 里补一条纯单测：建一条 todo → 改状态 → 改状态 → 归档 → 重开，**每一步断言编号不变**。这只需要 DB，不需要进程。
2. 补一条「认领」的单测：认领者字段的写入 + 幂等。
3. 补一条「类型」的单测：`TodoPayload.category` 的写入与缺省值。
4. 让 `--round=task` 轮的载荷字段带上 `category`（矩阵 `:234` 点名的缺口）。

**Regression test:**
```rust
#[test]
fn editing_a_todo_never_reallocates_its_number() {
    let conn = fresh_db();
    let n = next_todo_number(&conn, "g1").unwrap();
    // 改状态 → 归档 → 重开
    // 每一步后都断言：该 todo 的编号仍是 n，且 next_todo_number(&conn,"g1") 仍是 n+1
}
```

---

### TST-06 — 真 ENOSPC（写到一半磁盘满）无自动化；预检只是纯函数 + 形状守卫

**Severity:** Medium **Status:** Confirmed

**Location:** `src-tauri/src/storage/disk_space.rs:7-8`（问题自陈）；`src-tauri/src/network/file/receive.rs:635`；`src-tauri/src/lib_source_view_tests.rs:525`

**What:**
`storage/disk_space.rs` 的文件头把要防的场景写得很清楚：
> 配额通过 → 开始逐片写 → 写到一半 `ENOSPC` → 整单失败 → 用户看到一句 "No space left on device"，而**这一单已经传了一半**。

预检（`verdict_for` / `verdict_of`）是**纯函数**，有边界用例（`storage/disk_space.rs:225-310`）。但：
1. **预检本身是 TOCTOU** —— 查完到写之间余量会变。`lib_source_view_tests.rs:571` 那行断言自己也承认：
   > 写盘兜底必须仍在（预检是 TOCTOU，替代不了它）
   这行断言是**形状**（`recv.contains("write_all(&plaintext)")`），**不是行为**。
2. "写到一半 ENOSPC"这个**真正的兜底路径**（保留 `.part` + 台账 failed + 回 `Ack(false)`）**没有任何行为用例**。

**Evidence:**
```
$ grep -rn "ENOSPC|disk_full|No space left|disk_space|SpaceVerdict" src-tauri/src
src-tauri/src/storage/disk_space.rs:7-8    ← 问题自陈（注释）
src-tauri/src/storage/disk_space.rs:60     pub enum SpaceVerdict
src-tauri/src/storage/disk_space.rs:81/96  verdict_for / verdict_of（纯函数）
src-tauri/src/lib_source_view_tests.rs:525 ← 形状守卫
src-tauri/src/lib_source_view_tests.rs:571 assert!(recv.contains("write_all(&plaintext)"))  ← 形状
src-tauri/src/network/file/receive.rs:635  ← 生产码注释
```
⇒ 磁盘满的**唯一**行为级证据是跨进程 `--fault=recv-readonly` 轮（**本地层**，矩阵 `:186` 称"磁盘轮 1 连绿"）。

**Impact:**
1. 磁盘满是最容易在用户机器上发生的故障（不是攻击，是现实）。而它的兜底只有形状守卫 + 本地跨进程轮。
2. `recv-readonly` 轮造的是**目录不可写**（`EACCES`），不是**写到一半没空间**（`ENOSPC`）。这两者的失败点不同：前者第一片就写不进，后者写到 90% 死。**兜底代码里"保留 .part + 台账 failed"那段只在后者被需要** —— 而它恰恰没有行为用例。
3. 矩阵 `:186` 还记了一条相关的已知缺陷：**「接收方自己完全无感」（offer 期只记日志、不写库不发事件）→ A-10 未修**。

**Fix sketch:**
1. **单测级**：把"写盘失败"这一层抽成可注入的 —— 给 `write_chunk` 的写盘点一个可注入的失败注入点（或在测试里用一个配额受限的 tmpfs / 一个会返回 `ENOSPC` 的自定义 `Write`），断言：① `.part` 保留；② 台账 `failed` 且带可检索码；③ 回 `Ack(false)`；④ 界面能看见。
2. **纯函数级**：`admit_inbound` 的预检与写失败兜底的关系，判"兜底还在"应该从**形状**升级成**行为**（用一个会失败的写盘点跑一遍完整收尾）。
3. **跨进程**：给 `--fault=recv-readonly` 增加一个 `--fault=recv-enosppc` 变体（在接收目录挂一个大小受限的 tmpfs）。
4. 一并修 A-10：offer 失败时写库 + emit 事件（今天只有日志）。

**Regression test:**
```rust
#[test]
fn a_write_failure_mid_transfer_keeps_the_part_and_marks_the_row_failed() {
    // 注入一个写第 3 片时返回 ENOSPC 的 writer
    // 断言：.part 存在且前缀字节数正确 / 台账 status=failed 且带码 / Ack(false) 被回 / 界面事件发出
}
```

---

### TST-07 — 「群主撤回特权」与「key-change conflict」的接线只有**形状守卫**（74/152 cargo 守卫属这一族）

**Severity:** Medium **Status:** Confirmed

**Location:** `src-tauri/src/commands/files_tests.rs:282`（`creator_recall_authority_is_wired_on_both_ends`）；`src-tauri/src/lib_friend_identity_tests.rs`（`key_rotation_candidate_requires_friend_and_new_key_self_signature` 等 4 条）

**What:**
我逐条分类 152 条 cargo 通道守卫：**74 条断言的是源码文本**（`include_str!` + `.contains()` / `code_flat()`），**71 条是真行为断言**（调生产函数 + 断言状态），7 条无过滤器。

在两处**安全关键**的接线点上，落在了形状那一族：
- **群主撤回**：形状守卫 `creator_recall_authority_is_wired_on_both_ends` 判"选档逻辑里 Author / Creator 两态都在"。但矩阵 `:236` 明确记着这个形状的局限：
  > ⚠️ §四-A 另有**三条今天不成立**，别读成"已覆盖"：③「同 ID 不同密钥 ⇒ 提示换新 ID」= ADR-0021 切片 2 **未实现**（`state.rs` 那段注释自己写着）⇒ **已经撞上号的两台今天没有自愈路径**
- **key-change conflict**：4 条形状守卫判"换钥候选登记前必须用**新公钥**自验签"、"只给好友登记"、"两条删除路径都清候选"。矩阵 `:236` 同样记着：
  > `acceptable_friend_keys` / `mark_peer_keys_verified` 仍是**生产函数**、没有以自己名字命名的行为用例。

**Evidence:**
我的分类脚本对每条 cargo 守卫抽出过滤器 → 定位 `fn <filter>(` → 取函数体 3000 字符 → 查 `include_str!` / `read_to_string` / `source_view`：
```
Counter({'SRC-TEXT': 74, 'RUNTIME': 71, 'NOFILTER-ALLBLUE': 7})
```
其中 `lib_friend_identity_tests.rs` 的 4 条 key-change 守卫全部落 `SRC-TEXT`。
而**行为**那一侧只有一条：`network/transport/e2ee_tests.rs:89` `reseal_with_current_receiver_key_recovers_where_retry_cannot`（矩阵 `:183` 把它写成这格"现在真在跑的同一条不变量"）。

**Impact:**
1. 形状守卫在**重构时会碎**（"源码里那段字还在吗"与"行为对不对"是两件事），且它**对分册拆分敏感** —— 本仓已经吃过这个亏，`lib_file_tests.rs:33` 那条注释写着：
   > 读单个文件只会看见主册 ⇒ 形状守卫对分册失明（假绿形状）。
2. **假绿风险的具体形态**：形状守卫判"这段字存在"，但若该字在**另一个函数**里也有一份，它照样绿。本仓确实有"一个家 vs 两个家"这个反复出现的题材（`group_chunk_seq_rule_has_exactly_one_home` 就是为它专门写的）⇒ **说明这类假绿在本仓是真实发生过的**。
3. 关键安全接线（群主特权、换钥验签）恰好落在这一族。

**Fix sketch:**
1. 给形状守卫**加一层断言分级**：`Case` 上加一个字段 `assertion_kind: "behavior" | "shape"`，并在报告里分层打印 ⇒ 至少让人知道 74/152 是形状层（现在完全看不出来）。
2. 对**安全关键**的接线（群主撤回、换钥验签、身份锚点打标）补**行为**用例：
   - 群主撤回：构造"群主撤回别人消息"与"普通成员撤回别人消息"两个场景，断言一个落 `kind=recalled`、一个被拒。
   - 换钥验签：构造"用受害者公钥自签的换钥候选"，断言被拒（`protocol_tests.rs:266` 已有 announce 侧的同类用例可复用套路）。
3. 形状守卫本身可以保留（它守的是"不许出现第二个家"这类编译器管不着的事）—— 但**它不该是那一格唯一的证据**。

**Regression test:**
```rust
// 群主撤回的行为断言（替代 / 补充形状守卫）
#[test]
fn a_group_owner_may_recall_another_members_message_but_a_plain_member_may_not() {
    // 群主身份 => 落 recalled
    // 普通成员身份 => 被拒，消息行不变
}
```

---

### TST-08 — 身份持久化跨重启：无「重启后不再派生」分支的用例，且**代码与需求恰好相反**

**Severity:** Medium **Status:** Confirmed

**Location:** `src-tauri/src/state.rs`（身份初始化段）；`src-tauri/src/device.rs:153-220`（4 条用例）；矩阵 `:236`

**What:**
`device.rs` 有 4 条用例（`generated_id_keeps_the_one_prefix_and_length`、`identical_attributes_still_produce_different_ids`、`empty_attributes_still_yield_valid_distinct_ids`、`legacy_dev_prefix_is_stripped_exactly_once`），覆盖**生成**侧。但矩阵 `:236` 记着两条今天不成立的：

> ②「初始化时**重新生成**」与代码里的要求恰好相反（`state.rs` 那段：只认已持久化的值、没有才生成一次），而**"重启不再派生"这一分支没有以自己名字存在的用例**，现有覆盖只到 settings 读写与迁移不丢；

也就是说：**"重启后 device_id 必须与上次一模一样"这条最核心的身份持久化性质，没有一条以自己名字存在的测试。** 迁移侧有 `migration_preserves_identity_data`，但那是"迁移不丢"，不是"重启不派生"。

**Evidence:**
```
$ grep -rn "fn [a-z0-9_]*(identity_persist|persisted_identity|identity_survives|stable_device_id)" src-tauri/src
（0 命中 —— 没有以自己名字存在的用例）
src-tauri/src/device.rs:153  generated_id_keeps_the_one_prefix_and_length
src-tauri/src/device.rs:185  identical_attributes_still_produce_different_ids
src-tauri/src/device.rs:203  empty_attributes_still_yield_valid_distinct_ids
src-tauri/src/device.rs:220  legacy_dev_prefix_is_stripped_exactly_once
```

**Impact:**
1. **身份漂移 = 全链路信任断裂**。device_id 变了 ⇒ 好友关系对不上、已加密消息解不开、`msg_id` 幂等失效、群成员表错位。而这条性质今天只有"生成侧"的用例。
2. 矩阵 `:236` 还记着**第三条不成立**：「同 ID 不同密钥 ⇒ 提示换新 ID」= ADR-0021 切片 2 **未实现**（`state.rs` 注释自己写着）⇒ **已经撞上号的两台今天没有自愈路径**。也就是说"身份冲突"这一整个风险类别，**当前既无检测也无自愈，更无测试**。
3. 用户若是"重装但保留数据"或"数据目录被搬走"，落到哪条分支完全靠人读代码。

**Fix sketch:**
1. 补一条行为用例（不需要起进程）：把 `state.rs` 里"读已持久化身份"的那段抽成一个可测函数 → 喂一个已有的 settings 行 ⇒ 断言返回**同一个** device_id 且**不重新生成**。
2. 补一条"空库首次启动" ⇒ 生成一次 ⇒ **第二次调用必须返回同一个**（即幂等派生）。
3. 把 ADR-0021 切片 2（同 ID 不同密钥 ⇒ 提示换新 ID）落到代码或明确记为"未实现 + 无自愈"，并补一条守卫钉住"当前状态"（避免它被当成已实现）。
4. 矩阵那一格的等级从 SIMULATED 升到 AUTOMATED 之前，先补上面两条。

**Regression test:**
```rust
#[test]
fn a_restart_reuses_the_persisted_device_id_and_never_re_derives_it() {
    // 已有 settings 行 → 读回来的 device_id 与落盘值逐字相同，且生成器没被调用
}
```

---

### TST-09 — Windows 侧缺三类生产行为用例（缓存软链、磁盘写失败、托盘角标）

**Severity:** Low **Status:** Confirmed

**Location:** `src-tauri/test-baseline.macos.txt` vs `test-baseline.windows.txt` 的 25/3 差额

**What:**
平台差额的**成因与登记都是干净的**（`#[cfg(target_os)]` 互斥；`check-test-manifest.mjs` 现场核"差额必须有源码门控背书" ⇒ 无假绿）。但有三条**不是物理限制、只是当时只在 macOS 写了**：

| 用例 | 只在 | 生产码 | 为什么重要 |
|---|---|---|---|
| `storage::cache_cleaner::tests::walk_files_never_follows_symlinks` | macOS | `src-tauri/src/storage/cache_cleaner.rs` | 审计 P1.1：软链目标会被当缓存**永久删除**。Windows 上软链/ junctions 更常见。 |
| `logging::tests::disk_write_failure_is_counted_and_noted_in_memory` | macOS | `src-tauri/src/logging.rs:387` `classify_write_failure` | Windows 正是历史上出过 SIGABRT / 磁盘问题的平台（`verify.yml` 里 Windows 加载期 `0xc0000139` 那一大段诊断） |
| `tray::tests::menu_bar_number_clears_at_zero_and_caps_at_99` | macOS | `src-tauri/src/tray.rs:293` `set_unread_badge` | 未读角标 |

**Evidence:**
```
$ comm -23 <(sort src-tauri/test-baseline.macos.txt) <(sort src-tauri/test-baseline.windows.txt) | wc -l
25
$ comm -13 <(sort src-tauri/test-baseline.macos.txt) <(sort src-tauri/test-baseline.windows.txt)
network::transport::tests::windows_abortive_close_allows_immediate_rebind
transport::bluetooth_peripheral_windows::tests::fragmentation_round_trips_at_windows_notification_size
transport::bluetooth_peripheral_windows::tests::peripheral_and_central_agree_on_payload_budget
$ node scripts/check-test-manifest.mjs
✓ 跨平台基线完整性：差额全部有源码门控背书（macos:1291+3，windows:1269+25）
```
⇒ 守卫确认"差额有背书"，**但没有守卫确认"该有的行为两侧都有"**。

**Impact:**
1. 软链那个是**审计 P1.1** 的回归测试 —— 它的存在证明这个风险被认真对待过，但它在 Windows 上不跑。
2. Windows 是本仓**唯一有专门 CI 腿**的平台（`verify.yml` 的 `rust` job 是 `matrix.os: [macos-latest, windows-latest]`），却在这三条行为上比 macOS 少。
3. 清单守卫的判据是"差额的成因是否可解释"，**不是"覆盖是否对称"** ⇒ 这类不对称会一直静默存在。

**Fix sketch:**
1. 把 `walk_files_never_follows_symlinks` 的用例**移到跨平台**（`cache_cleaner.rs` 本身不平台门控 ⇒ 大概率只是当时忘了在 Windows 跑 —— 若 Windows 上真的跑不了，要显式说明原因）。
2. `logging::tests::disk_write_failure_*` 同理：写盘失败模拟不该是 macOS-only。
3. 托盘角标：Windows 托盘与 macOS 菜单栏是两套实现（`tray.rs` 里 `PathKind`/平台分支）⇒ Windows 侧补一条等价用例。
4. 在 `check-test-manifest.mjs` 加一条**对称性**判据（非硬失败，先报告）："某个跨平台模块的用例只在一边出现 ⇒ 点名"。

---

### TST-10 — 2 条新 Rust 用例不在基线里；`#[ignore]` 的迁移演练永不执行

**Severity:** Low **Status:** Confirmed

**Location:** `src-tauri/src/db/migration_tests.rs:2504`（`#[ignore]`）；`commands::files_gate_tests::inspect_drop_paths_*`（2 条，不在基线）

**What:**
1. **唯一一条 `#[ignore]`**：`real_data_copy_replays_migration_without_losing_rows` —— "真实用户库副本迁移演练"，需手工设 `GOSSLAN_DRILL_DB` 指向一份副本。它是**唯一**能证明"真实数据体量/形状在当前迁移链下不丢行"的用例，而**默认 CI 永远不执行**。
2. **2 条新用例不在基线**（`inspect_drop_paths_is_capped` / `inspect_drop_paths_reports_name_size_and_directory`）—— 它们**会跑**（不在 `#[ignore]` 里），只是基线没有它们 ⇒ **哪天被删掉，清单守卫不会报**。

**Evidence:**
```
$ node scripts/check-test-manifest.mjs
⚠ 有 2 条新用例不在基线里（它们**会跑**，只是尚未纳入保护）：
    · commands::files_gate_tests::inspect_drop_paths_is_capped
    · commands::files_gate_tests::inspect_drop_paths_reports_name_size_and_directory
  跑 `node scripts/check-test-manifest.mjs --update` 把它们纳入。
```
```
// src-tauri/src/db/migration_tests.rs:2504
#[ignore = "真实数据副本演练：显式设置 GOSSLAN_DRILL_DB 指向一份副本"]
#[test]
fn real_data_copy_replays_migration_without_losing_rows() { ... }
```

**Impact:**
1. 真实库迁移这一格是**升级路径唯一的端到端证据**（矩阵 `:293` Smoke-12 自陈"真用户库 + 真数据 + 真启动 没有自动化覆盖"）。它既 `#[ignore]` 又要手工准备副本 ⇒ **实际上从未自动跑过**。
2. 那 2 条新用例是"**会跑但不受保护**"的状态：删掉它们 CI 不会红。

**Fix sketch:**
1. 立刻跑 `node scripts/check-test-manifest.mjs --update` 把那 2 条纳入基线（一条命令的事）。
2. 给 `#[ignore]` 那条加一个**自动化触发口**：
   - 在 CI 的 nightly 腿上准备一份**合成的**旧版本 schema 库（脚本按 v10 schema 建一份）⇒ 设 `GOSSLAN_DRILL_DB` 跑这条；
   - 或者把这条拆成两条：一条"合成旧库"（CI 自动跑）+ 一条"真实库副本"（`#[ignore]`，人工）。
3. 清单守卫把"新用例不在基线"从 `⚠` 升级为**硬失败**（或至少在 CI 上硬失败，本地仍可警告）—— 否则这个 `⚠` 会长期挂着。

---

## 本次未能验证（诚实清单）

| # | 未验证项 | 为什么 | 我做到哪一步 |
|---|---|---|---|
| 1 | **cargo 通道 152 条守卫的真跑** | 实测每条要整库重编译 ~25s ⇒ 整通道 ≈ 60+ 分钟，且题面禁止跑 cargo | 我只跑了 `--lane script`（34 条全绿）与 `--lane node --shard 0/6`（前 4 条全绿）。cargo 通道的**机制**（锚点核对、hint 判据、逐字节恢复）我读了源码确认齐备，但**没有实测 152 条全绿** |
| 2 | **132 条 node 通道守卫全绿** | 同上（node 通道约 133.7s，本可跑完，但我只跑了 1/6 片） | 已跑片内前 4 条全绿 |
| 3 | **形状守卫的"自等断言"是否真的零** | 我只能做启发式分类（`include_str!` / `read_to_string` 启发式 + 注入目标 vs 断言读取文件的比对）。**40 条守卫的注入文件与断言读取文件不一致**，其中大部分是因为我的 `include_str!` 相对路径解析没对上（视图类守卫仍然有效），**我没有把这一族彻底分离** | 我把 74 条标成 SRC-TEXT、71 条标成 RUNTIME，并逐条核了用户点名的 `DELETE FROM outbox` 那一例（**不是自等**） |
| 4 | **12 个含 `Date.now`/`new Date`/`setTimeout` 的前端测试是否 flaky** | 需要逐个读文件判断"喂固定值"还是"读真时钟" | 我只做了文件级清点，未逐条核实 |
| 5 | **33 个含 `readFileSync`/`writeFileSync` 的前端测试是否往仓库目录写文件** | 需要逐个读 | 我只做了文件级清点 |
| 6 | **前端 1471 条断言的准确性** | 题面明确不许重跑 `npm test` | 我用了题设基线，并自己算出了 1303 处 `#[test]` 属性（Rust 侧） |
| 7 | **`check-test-manifest.mjs` 那 2 条新用例的实际影响** | 我确认了它们会跑但不在基线；没有确认删掉后守卫是否真的不报 | 只读了守卫的判定逻辑 |
| 8 | **`cargo test` 实际通过数（1272）与基线（1291）的 19 条差** | 差值应是平台门控 + `#[ignore]`；我没有逐条对账 | 我知道 macOS 基线 1291、`#[ignore]` 1 条、题设 1272 passed ⇒ 差 18 条未对账 |
| 9 | **`audit-context/` 下已有的其它审计产物** | `ORIENTATION.md`（48 KB）、`spec-compliance/`、`security/`、`stability/` 都在，但本次任务是独立的盲区评估 | 我**没有**读它们 ⇒ 本文件可能与既有审计重复 |

---

## 附：Top 8 盲区（按"若坏了会不会被抓住"排序）

| # | 盲区 | 现状 | 若坏了会怎样 |
|---|---|---|---|
| 1 | **`useChatStore.ts`（3471 行）零单元测试** | 3 个 stores **全部**无 `.test.ts`，**零运行时 import**（只被 `readFileSync` 形状断言引用）；16 个 composables 里 12 个同样只有形状断言、3 个完全无引用 | 乐观占位重复渲染（**已出过真机事故**）、已读状态推进、群任务同步全靠形状守卫与浏览器探针 |
| 2 | **护栏非空转只在 nightly 跑** | `verify.yml` 两个 guard job 的 `if` 只认 `schedule`/`workflow_dispatch` | 新增/改坏的守卫最长 24 小时无人验证；push/PR 全绿不代表守卫有效 |
| 3 | **`saveDestination.test.ts` 是源码副本（零用例）** | 与 `saveDestination.ts` 逐字节相同；清单守卫把它算成"138 个文件之一" | Android「另存为」回到 `invalid args destination: invalid type: map`；清单守卫的整体可信度被拉低 |
| 4 | **74/152 cargo 守卫是源码形状断言，安全关键接线落在这一族** | 群主撤回权限、换钥验签、relay token 不入日志 全靠 `include_str!` + `.contains()` | 重构即碎；且"这段字在另一个函数里也有一份"时假绿（本仓已因"一个家 vs 两个家"吃过亏） |
| 5 | **好友 reject 路径零测试** | `handle_identity.rs:216-229` 整个臂无 `#[test]` | "已被拒绝的申请被反复重发"的缺陷可原样回归 |
| 6 | **真 ENOSPC 兜底只有形状守卫** | `storage/disk_space.rs` 预检是纯函数；"写到一半没空间"只有本地跨进程轮（且该轮造的是 `EACCES` 不是 `ENOSPC`） | 用户机器上最常见的故障发生时，`.part`/台账/回执三件事可能不一致 |
| 7 | **群任务 CRUD 写路径无单测；身份持久化"重启不派生"无分支用例** | 编号分配有 6+ 条边界用例，但"改状态后编号不变"只在本地跨进程轮；身份"重启不派生"完全无以自己名字存在的用例 | 用户可见的编号错乱；身份漂移 ⇒ 全链路信任断裂 |
| 8 | **Windows 侧缺三类行为用例；2 条新用例不在基线；唯一 `#[ignore]` 的迁移演练永不跑** | 软链清扫 / 磁盘写失败 / 托盘角标只在 macOS | Windows（唯一有专门 CI 腿的平台）在这三条行为上比 macOS 少；真实库迁移路径实际从未自动执行 |
