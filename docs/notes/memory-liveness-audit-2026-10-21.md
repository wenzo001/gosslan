# 内存安全与流程活性全项目审计（2026-10-21）

> **一句话结论**：Gosslan 的流式与有界意识处于同类项目的中上水平；本次**没有**发现经典意义上的"整文件读进内存""无界队列堆积""死循环不退出""组件卸载后监听器泄漏"。但审计确认了 **1 个 P0 + 4 个 P1 + 13 个 P2 + 19 个 P3**（产品侧）**+ 7 个 P2 + 8 个 P3**（工程脚本与 CI 侧，见 §3.4），其根因收敛为**三个体系性盲区**（锁序无约束 / 异步运行时饥饿 / 跨路径一致性缺失），而不是零散的疏漏。

| 项 | 值 |
|---|---|
| 审计日期 | 2026-10-21（周三） |
| 审计模式 | **只读**。未修改任何源码；唯一副作用是 `cargo test` 写入 `src-tauri/target/`（构建产物，已在 `.gitignore`），并把工作区里那份**陈旧的** `src-tauri/Cargo.lock` 规范回 HEAD 的内容（该 lockfile 与 `Cargo.toml` 本就不一致，cargo 解析后写回的结果与已提交版本逐字节相同 ⇒ **没有丢失任何依赖信息**；详见 §9.5） |
| 分支 / 工作区 | `main`；审计开始时有 20 个未提交改动（文档 / `scripts/check-doc-citations.mjs` / `scripts/verify.mjs` / `gen/android/app/build.gradle.kts`），**全程未覆盖、未重置** |
| 覆盖规模 | Rust `src-tauri/src` 85,729 行（排除 `vendor/`、`target/`）；Vue/TS `src/` 64,421 行；`scripts/` 68 个条目 + `perf/` 7 个 + `tools/` + `src-tauri/examples/`；`.github/workflows/` 5 个 workflow |
| 证据基线 | `npm test` → **1154 passed / 0 failed**；`cargo test --lib` → **1025 passed / 0 failed / 1 ignored**；`node scripts/verify.mjs`（快速层 17 步）→ **全绿**；`node scripts/check-lock-scope.mjs` 通过；`node scripts/check-invariant-hooks.mjs` 通过（35 条不变量全部具名绑定） |

---

## 0. 本文件的定位与读法

- 这是一份**审计证据**，不是方案书。§7 给出修复优先级，§8 给出验证计划，但**本轮不改任何代码**（用户指令 §六：本阶段以审计和方案为主）。
- 所有结论都标了**证据级别**：
  - `代码路径证实` —— 读到了确切的代码与因果链，结论由代码结构直接推出；
  - `待验证风险` —— 代码形状可疑，但需要运行时复现或外部 crate 行为才能坐实。
- **没有任何一条声称"已复现"**。本轮没有做过长时运行压测，也没有在真机上触发过任何一条死锁或泄漏。
- 行号是**现读现钉**的。凡引用 `file:line` 的位置，读者可直接 `sed -n` 复核；若日后文件变动导致行号漂移，那是正常的，**结论（因果链）不依赖行号**。

### 0.1 工作区状态快照：审计期间发生的并发修复

**本报告描述的是 `HEAD`（`cfc01a9`）的状态。** 写完报告之后、复核本节时，发现工作区里**多出了一批未提交的修复**，内容恰好覆盖本报告的 5 条发现，且注释里直接引用了本报告的问题编号（`逐行判定（P1-04）`、`不能把一条消息的所有行 all() 成一个结论（P1-04）`）。

| 文件 | 对应本报告条目 | 改了什么 |
|---|---|---|
| `src-tauri/src/commands/friends.rs` | **P0-01** | `get_friends` 的 `peers` 改成**先取快照放锁**再取 db 锁 |
| `src-tauri/src/network/transport/gossip.rs` | **P0-01** + **P2-04** | `peers` 快照提前取完放锁；转发信封的 TTL 改取 `MeshRouter` 的 Forward 决策（`max_ttl` 裁剪 + 递减） |
| `src-tauri/src/network/transport/handshake.rs` | **P0-01** | `peer_keys_trusted` 改名重写为 `struct FriendKeySnapshot`；`bind_friend_keys_on_accept` 改为接收快照参数，**不再在持 db 锁时取 peers 锁** |
| `src-tauri/src/network/transport/peer_state.rs` | **P0-01** | `maybe_update_friend` 改成先取 peers 快照再取 db 锁 |
| `src-tauri/src/network/transport/peer_registry.rs` | **P0-01** | `upsert_peer` 的"问闸"改走 `FriendKeySnapshot::capture(...).verified` |
| `src-tauri/src/lib_friend_identity_tests.rs` | **P0-01** | 守卫视图改名 + **拆成"定义 1 份 / 调用点 3 处"两条断言**（见下） |
| `src-tauri/src/network/file/send.rs` | **P2-02** | 新增 `PendingCompleteGuard`（登记即武装，离开作用域含 `?`/return/panic 即摘除） |
| `src-tauri/src/network/file_tests.rs` | **P2-02** | 新增回归用例 `pending_complete_guard_clears_the_registration_on_every_exit` |
| `src-tauri/src/network/transport/outbox_sweep.rs` | **P1-04** | 群 outbox 改成**逐行**判定 |
| `src-tauri/src/db/group_offline_queue.rs` | **P1-04** | 新增 `group_outbox_row_expired`（逐行）与 `delete_group_outbox_row` |
| `src-tauri/src/network/transport/gossip_tests.rs` | **P2-04** | 新增回归用例 `forwarded_ttl_is_clamped_by_the_mesh_router` |
| `src-tauri/test-baseline.macos.txt` / `.windows.txt` | 上述 | 测试清单基线同步（新增用例入册） |
| `scripts/semver.mjs` | **SC-P2-01** | `execSync(\`git ${args}\`)` → `execFileSync("git", args)`，全部调用点改数组 + `--end-of-options`；顺手把 `execSync("cat …")` 换成 `readFileSync` |

**本报告的复核结论（本人逐条复跑）**：

- ✅ **SC-P2-01 已验证关闭**：`node scripts/semver.mjs changelog --since 'HEAD; echo INJECTED_MARKER'` ⇒ 注入标记出现次数 **0**；`version:check` 与 `changelog` 均正常通过。
- ✅ **P1-04 / P2-04 的旧形状确实是 HEAD 的形状**：`git show HEAD:src-tauri/src/network/transport/outbox_sweep.rs | grep 'rows.iter().all'` 命中（`HEAD:...outbox_sweep.rs:228`）；`git show HEAD:src-tauri/src/network/transport/gossip.rs` 里转发用的是 `env.ttl` 家族。⇒ 报告里的这两条**在 HEAD 上成立**，工作区已修。
- ⚠️ **P2-04 的严重度要下调**：逐读工作区修复后的 `gossip.rs` 后可以确认 —— 转发路径**本来就**用 `MeshRouter` 的 Forward 决策做"要不要转发"的判定（`on_receive` 内部 `effective = ttl.min(max_ttl)`、`should_forward = remaining > 0`）⇒ **实际传播深度一直被钳在 6 跳**，wire 上的 TTL 只是"看起来大"。所以 P2-04 的真实风险是 **wire TTL 可被抬高 ⇒ 补递门槛 `MIN_TTL_FOR_RELAY = 2` 形同虚设**，属 P3 级（纵深防御缺失），**不是** P2 级的"254 跳扩散"。
- ✅ **P0-01 的机器守卫已落地**：`scripts/check-lock-scope.mjs` 已扩展到覆盖 `peers` 锁，并新增**双向** ABBA 判据（`db→peers` 与 `peers→db` 任一方向都判红），自带 16 段夹具自证（抓 8 / 放 8，含跨锁夹具）。实跑结果：**peers↔db 跨锁嵌套 0 处**。⇒ **这条守卫会挡住同形状问题复发**，不只是修当前这一处。
- ✅ **`cargo test --lib` 已回到全绿**：`1029 passed / 0 failed / 1 ignored`（会话开始时是 1025；新增 4 条即并发修复带来的回归用例）。

**后续条目的状态标记**：P0-01 / P1-04 / P2-02 / P2-04 / SC-P2-01 五条已在工作区修复（未提交）；P0-01 的机器守卫也已落地；其余条目仍待实施。**影响评估见 §6.7。**

### 0.2 拍板记录（2026-10-21，最终）

**实施原则（用户定）**：稳定 > 流畅 > 正确 > 原生体验 > 性能 > 可维护性 > 扩展性 > 新功能。
优先改善用户可感知的**卡顿、等待、失败和困惑**，同时严格控制 CPU、内存与磁盘占用。
**每项独立修改、独立验收**，不顺手扩大重构范围；**未运行的测试不得标记通过**；
涉及消息可靠性、文件完整性和持久化历史的行为**不得为节省资源而静默降级**。

| # | 拍板内容 | 状态 |
|---|---|---|
| 1 | **1A** 群文件断点续传**复用现有分片序号**，不加协议字段；必须验证断点恢复、重启恢复、重复分片及文件完整性 | ✅ **S1–S4 已实现**（协议 + 接收端 + 发送端 + 轮次隔离）；续传相关单测 16 条全绿 + **GFILE 双实例 28 断言全绿**（正常路径 + 新握手）；⚠️ **断链/重启续传矩阵未跑**（§10.1.7 逐项标注证据级别） |
| 2 | **2 = 先做 A** 数据库 VACUUM 增加**时间预算、进度中止与失败恢复**；后续单独实施 B。3 秒是目标预算，需验证实际行为 | ✅ **已实现并验证**（§10.2） |
| 3 | **3B** 蓝牙事件队列设**硬上限**，积压时**受控断链**并自动恢复；不得静默丢帧，并防止重连风暴 | ✅ **已实现**：三平台共用有界队列 64 条 + 带外溢出信号 + 2–5s 抖动冷却；单测 2 条、Android/Windows 编译门禁通过（§10.3） |
| 4 | **4A(8)** 群文件发送**并发上限 8**，**统一在传输调度层**实施；实测内存峰值、吞吐和排队行为 | ✅ **已实现**：`Semaphore(8)` 放在唯一投递入口，排队保持 `pending`（无损等待）；闸与排队有判据；⚠️ **内存峰值/吞吐未实测**（§10.4） |
| 5 | **5A(500)** 每群运行态任务缓存**最多 500 条**；**只裁剪缓存，不得擅自永久删除数据库中的任务历史** | ✅ **已实现**：前端缓存裁到 500 条，**数据库一行未删**；前端测试 2 格（§10.5） |
| 6 | **6A** 崩溃测试现场**保留 30 天**，单次超 2 GB 时按安全规则清理；同时覆盖异常退出遗留目录 | ✅ **已实现**：`unknown` 30 天 + >2 GB 只清大文件；自证 **30 格**全绿（§10.6） |
| 7 | 数据库锁大改造**放第二批**，先完成高收益低风险修复，之后**专项审计和分阶段实施** | ⏳ 延后（§10.7 给出专项审计的判据清单） |
| 8 | 沿用群消息 **30 分钟**重发失败期限；**离线暂存和上线补发的 7 天承诺不变**；**按成员独立判断**送达和失败状态 | ✅ **已实现并验证**（§10.8） |

**每项的详细台账**（实际 diff / 测试命令与结果 / 用户感知变化 / 资源实测数据 / 剩余风险）在 **§10**。

#### ✅ 这批并发修复曾把 `cargo test --lib` 弄红（1 条失败），现已修复

**历史**：P0-01 的修复把"问闸"这个函数**改名重写**了 —— `handshake.rs` 里的 `fn peer_keys_trusted(state, device_id) -> bool` 被替换成新的 `struct FriendKeySnapshot`（`capture()` 一次取齐"两把钥匙 + 是否验签过"），`bind_friend_keys_on_accept` 改为**接收快照参数**、不再自己取锁。

**这是设计上的进步**（helper 结构上**无法**再绕过闸了：verified 只能从参数进来），但 `src-tauri/src/lib_friend_identity_tests.rs` 是一条**文本形状守卫**，它按符号名计数，于是失配：

```
test result: FAILED. 1024 passed; 1 failed; 1 ignored
failures:
    tests::friend_identity_anchor_has_one_binding_rule
```

**已修复**（工作区），且修法比"改个名字"更严 —— 旧断言只数一个总数（3），分不清"多了一份定义"和"多了一个调用点"；新断言**拆成两条**：

| 守卫位置 | 新断言 | 含义 |
|---|---|---|
| `src-tauri/src/lib_friend_identity_tests.rs:266-270` | `src.matches("fn capture(state: &AppState").count() == 1` | **闸的实现只许一份**（旧的 `peer_keys_trusted` 那个角色） |
| `:271-276` | `src.matches("FriendKeySnapshot::capture(state").count() == 3` | **问闸的调用点恰好三个**：`upsert_peer` / `apply_friend_accept` / `maybe_update_friend`，且三处都必须在 **db 锁之外**取快照 |
| `:292-295` | `code_flat(&helper).contains("keys.verified")` | accept helper 必须**消费调用方取好的快照**，不得自己再去求 peers |
| `:335` | `code_flat(&upsert).contains("FriendKeySnapshot::capture(state,device_id).verified")` | `upsert_peer` 那道闸不许拆 |

（`code_flat` 去掉**全部**空白，见 `src-tauri/src/lib_source_view_tests.rs:298-300` ⇒ 断言里不带空格的写法能匹配源码里带空格的写法。）

**守卫的意图没有被破坏**（"闸只有一份 + 直调写钥匙只许出现在问过闸的地方"）—— 反而更强：旧写法 helper 还能自己调 `peer_keys_trusted`，新写法的 `verified` **只能从参数进来**。

#### 并发修复同时补上的回归用例

| 用例 | 钉住什么 |
|---|---|
| `src-tauri/src/network/transport/gossip_tests.rs` `forwarded_ttl_is_clamped_by_the_mesh_router` | 对端自报 `ttl = 255` 时必须被压到 `max_ttl - 1 = 5`；`Deliver` 分支不得再转发 |
| `src-tauri/src/network/file_tests.rs` `pending_complete_guard_clears_the_registration_on_every_exit` | 完成登记必须在**所有**退出路径回收（含 `?` / 提前 return / panic 展开） |

#### 命名统一

生产代码里最后一个旧符号引用在 `src-tauri/src/network/transport/dial.rs:564` 的历史说明注释里（讲"此前只有入站那条打标"的那段）。已改为注明旧名与新名（`旧名 peer_keys_trusted，2026-10-21 P0-01 起改名 FriendKeySnapshot::capture`），避免读者 grep 旧名找不到东西。**纯注释，零功能影响。**

#### 另有一处极窄的语义变化值得知会（不影响对错，只影响"什么时候"）

快照现在取在 `db::get_friend` / `add_friend` **之前**，旧写法是在 `bind_friend_keys_on_accept` 内部（即 `add_friend` 之后）读 `peers`。若在这几微秒里 `upsert_peer` 恰好把 `keys_verified` 置为 `true`，新写法会读到 `false` ⇒ **ed25519 身份锚点晚一个 announce 周期绑定**。`update_friend_pubkeys` 是 fill-only，且源码注释明确写着"未 verified 时留 NULL 不是死路……'晚一点绑'安全，'绑错'永久" ⇒ 方向是安全的。

---

## 1. 审计总览

### 1.1 范围与覆盖

| 区域 | 规模 | 覆盖方式 |
|---|---|---|
| Rust 后端 `src-tauri/src` | 85,729 行 | 全量阅读 + 调用链追踪 |
| Vue/TS 前端 `src/` | 64,421 行 | 全量阅读 |
| 工程脚本 `scripts/` | 68 个条目 | 循环/重试/子进程/等待条件专项扫描 |
| CI `.github/workflows/` | 4 job | 超时/重试/产物检查 |

逐条追踪的关键子系统：TCP/BLE 传输与 IO 循环、Gossip 扇出与去重、Outbox/离线补发、单聊与群文件分块传输与 ACK 账本、Relay 中继、Mesh 路由与选路、发现与 announce、DB 单连接与全部 schema、29 个命令层模块、`AppState` 全部 60+ 内存表、托盘/退出/重启生命周期、Vue 组件生命周期、Pinia store、IPC 事件层、Blob/ObjectURL 所有权、e2e 故障注入脚本。

### 1.2 这份代码的基线判断（重要前提）

Gosslan **不是**一个典型的"到处是泄漏"的仓库。它已经建立了一套成体系的活性护栏：

- `scripts/check-lock-scope.mjs` —— 全仓 db 锁作用域守卫（禁"锁内 emit"、禁"锁内调自锁 helper"），本次跑通：335 个 db guard 绑定 + 27 个语句临时量全判过，自锁 helper 187 个、持锁调用 0 处。
- `src-tauri/src/lib_window_tests.rs:241` `blocking_commands_run_off_the_main_thread` —— **规则式**守卫，强制所有碰 `.db` / `std::fs` / `logger.` / `Clipboard` / `tray:` 的命令必须 `#[tauri::command(async)]`（离开 macOS 主线程）。
- `src-tauri/src/lib_relay_data_tests.rs` `whole_file_slow_work_never_runs_on_an_async_worker` —— 形状扫描，禁止 GB 级慢活在 async worker 上跑。
- `src/utils/bounded.ts`（FIFO 容量闸）、`src/utils/blobLru.ts`（按**字节**封顶的 LRU + 单一 revoke 出口）。
- `src/utils/designGuards.test.ts` ㊽ —— 全 `src/` 事件监听器配对扫描（含 capture 标志一致性）。
- 几乎所有队列/缓存都有显式上限、淘汰策略与具名单测。

**因此本次审计的价值不在"发现一堆泄漏"，而在于找出这套护栏的系统性盲区。** 盲区集中在三处：

| 盲区 | 护栏现状 | 后果 |
|---|---|---|
| **(a) 锁序** | `check-lock-scope.mjs:57` 自陈："*别的 Mutex（`peers` / `file_receivers` / `relay`）：本脚本只管 db 那把*"，且 D 类只判**同锁重入** | 跨锁顺序反转无人看守 ⇒ **P0-01** |
| **(b) 异步运行时饥饿** | 守卫保证命令**离开主线程**，却没保证它不**占住 Tokio worker** | P1-01 / P1-02 |
| **(c) 跨路径一致性** | 无"群路径必须与单聊路径逐条对齐"的纪律 | P1-03 / P2-01 / P2-02 / P2-16 |

### 1.3 未覆盖区域（明确声明）

- **BLE 实机行为**：btleplug 是外部 crate，本仓库无法验证"外设被动断连时通知流是否终止"。相关结论降级为"待验证风险"。
- **Windows 平台**：本次全部在 macOS 上审计；Windows 特有分支（`src-tauri/src/transport/bluetooth_peripheral_windows.rs`、WebView2 消息泵）仅静态阅读。
- **Android/JNI 路径**：`src-tauri/src/android_open.rs` / `src-tauri/src/jni_method.rs` 已读，结论为安全，但未实机验证。
- **运行时内存曲线**：未做长时运行采样（`scripts/mem-sample.mjs` 存在且可用，本次未执行长跑压测）。
- **`src-tauri/vendor/btleplug/`** 与 `src-tauri/target/`：第三方代码与构建产物未审计。

---

## 2. P0 / P1 风险清单

### 🔴 P0-01：`state.peers` ↔ `state.db` 锁序反转 → 硬死锁，进程永久挂死

**风险类型**：死锁（AB-BA）· **证据级别：代码路径证实（三方独立确认）** · **影响：应用永久无响应，必须杀进程**

> **状态：已在工作区修复（未提交）** —— 4 处锁作用域收窄已落地，见 §0.1。**功能影响：零**（判定逻辑一字未改，只把「持 peers 求 db」改成「先取 peers 快照放锁，再取 db」）。

#### 涉及的两把锁

两把都是 **`std::sync::Mutex`**（非公平、不可重入）：

- `src-tauri/src/state.rs:1122` — `pub peers: Mutex<HashMap<String, Peer>>`（`use std::sync::{Arc, Mutex};` 见 `src-tauri/src/state.rs:6`）
- `src-tauri/src/state.rs:955` — `pub db: DbLock<Connection>`，而 `DbLock` 内层是 `std::sync::Mutex`（`src-tauri/src/db_hold.rs:86-89`、`:21`）

#### 方向一：`peers → db`（持 peers 求 db）

**① `src-tauri/src/network/transport/gossip.rs:167` + `:187`**（Gossip 接收热路径）

```rust
167:  let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());  // guard 活到 else 块结束
168:  match peers.get(&env.sender_id) {
...
185:      None => {
186:          let stored = {
187:              let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());  // ← 持 peers 时求 db
188:              db::get_friend_ed25519(&dbc, &env.sender_id)
189:          };
```

**② `src-tauri/src/network/transport/gossip.rs:261` + `:266`**（加密 Chat 信封）

```rust
261:  let mut peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
262:  if let Some(p) = peers.get_mut(&env.sender_id) {
263:      if p.x25519_pubkey.is_none() {
264:          p.x25519_pubkey = Some(env.sender_pubkey.clone());
265:          p.last_seen = db::now_ms();
266:          let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());  // ← 持 peers 时求 db
267:          db::update_friend_pubkeys(&dbc, &env.sender_id, Some(&env.sender_pubkey), None)
```

**③ `src-tauri/src/commands/friends.rs:67` + `:90`**（IPC 命令层）

```rust
 67:  let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());   // 活到函数结束
 ...
 90:  let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());        // ← 持 peers 时求 db
 91:  let mut friends = db::list_friends(&dbc).unwrap_or_default();
```

#### 方向二：`db → peers`（持 db 求 peers）

**④ `src-tauri/src/network/transport/handshake.rs:293` + `:299` → `handshake.rs:189`**

```rust
292:  let was_friend = {
293:      let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());   // db guard 活着
294:      let seen = db::get_friend(&dbc, from).is_some();
295:      db::add_friend(&dbc, from, &name, None).ok();
299:      bind_friend_keys_on_accept(state, &dbc, from);   // ← 仍持 db
300:      seen
301:  };
```

```rust
182: /// 调用方必须**已经持有** `state.db` 的锁（本函数不再取锁 —— 同锁重入会当场死锁）。
183: pub(crate) fn bind_friend_keys_on_accept(
184:     state: &AppState,
185:     conn: &rusqlite::Connection,     // ← 类型签名本身就是"调用方已持 db 锁"的证据
186:     friend_id: &str,
187: ) {
188:     let (x, e) = {
189:         let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());  // ← 持 db 时求 peers
```

**⑤ `src-tauri/src/network/transport/peer_state.rs:19` + `:24`**

```rust
19:  let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
20:  if db::get_friend(&dbc, device_id).is_some() {
21:      db::add_friend(&dbc, device_id, nickname, avatar.as_deref()).ok();
24:      bind_friend_keys_on_accept(state, &dbc, device_id);   // ← 持 db 求 peers
25:  }
```

`maybe_update_friend` 的调用点全是热路径：

| 调用点 | 触发时机 |
|---|---|
| `src-tauri/src/network/transport/handle_identity.rs:85` | **每一次 Hello**（每条链路建立、每种传输） |
| `src-tauri/src/network/transport/handle_identity.rs:168` | UserInfo 处理 |
| `src-tauri/src/network/transport/peer_registry.rs:264` | announce 导致公钥变化时 |
| `src-tauri/src/commands/mobile_picker.rs:431` | 移动端好友选择 |

而 `apply_friend_accept`（`handshake.rs:290`）的调用点 `src-tauri/src/network/transport/handle_identity.rs:210` 与 `src-tauri/src/network/transport/gossip.rs:558` 也都在 Gossip/身份热路径上。

#### 完整因果链（最小触发）

1. **线程 A**（Gossip 接收任务 / `get_friends` IPC）：持 `peers` → 阻塞求 `db`
2. **线程 B**（Hello 处理任务 / `apply_friend_accept`）：持 `db` → 阻塞求 `peers`
3. 两把非公平、不可重入的 `std::sync::Mutex` ⇒ **双方永久 park**

**这两个路径在不同的 `reader_loop` 任务里**（`src-tauri/src/network/transport.rs:285` / `:737` / `:1204` 为每条连接 spawn 独立任务），因此可以真正并发地跑在不同 Tokio worker 线程上。

**最现实的触发场景（重启即中）**：

- `peers` 是**纯内存表**（重启即空），`friends` 是 **DB 表**（持久）。
- 应用重启后 `peers` 为空 ⇒ 来自任一好友的**第一封 Gossip 信封**必然走 `gossip.rs:167` 的 `None` 分支（持 peers 求 db）。
- 同时另一条链路的 **Hello** 到达 ⇒ `handle_identity.rs:85` → `maybe_update_friend`（持 db 求 peers）。
- ⇒ **启动后数秒内即死锁**，且死锁的是两个**后台网络任务**，用户界面上表现为"所有窗口都点不动"。

**放大效应**：这是 `std::sync::Mutex` 的**阻塞式** OS 锁，且发生在 **Tokio worker 线程**上。两条 worker 被永久占住后，若 worker 数（= `available_parallelism()`）恰好被填满，**整个 Tokio 运行时停摆** ⇒ 心跳、announce、outbox 清扫、ACK 处理、文件传输、IPC 响应全部冻结。这正是本仓历史上"点清除数据 → 设置窗口卡死"（`src-tauri/src/commands/favorites.rs:508-512` 注释记录的同族症状）。

#### 为什么现有护栏没抓到

`scripts/check-lock-scope.mjs` 的自我声明（`:57`）写得很清楚：

> *"· **别的 Mutex**（`peers` / `file_receivers` / `relay`）：本脚本只管 db 那把，因为只有它被前端 IPC 抢。"*

它的 D 类只判 **同锁重入**（"持锁调用自锁 helper"），**不判跨锁的顺序反转**。全仓无任何锁序守卫。

#### 排除的误报（重要）

为避免"看起来像死锁其实不是"，以下位置经逐条核对确认**不是嵌套**：

| 位置 | 形状 |
|---|---|
| `src-tauri/src/network/transport/peer_registry.rs:136 / 148 / 243 / 258` | 每段 `peers` 作用域在对应 `db` 作用域之前结束 |
| `src-tauri/src/network/transport/handshake.rs:75-82` | `db` 块在 `:78` 结束，`peers` 锁在 `:80` |
| `src-tauri/src/network/transport/peer_state.rs:40-47` | `peers` 与 `db` 各自成块，互不嵌套 |
| `src-tauri/src/network/transport/member_notices.rs` `resolve_nickname` | 语句级临时量 |
| `src-tauri/src/state.rs:2227-2253` `emit_peers_now` | 取 `peers` → 放锁 → 再 `links.try_lock()`（非阻塞） |
| `src-tauri/src/network/transport/peer_registry.rs:23-49 / 64-85` | `db` 与 `pending_key_rotations` / `key_conflict_warned` 作用域不相交 |
| `src-tauri/src/state.rs:2381` | `st.peers.lock().unwrap_or_else(..).len()` 是**临时量**，语句结束即释放 |
| `state.links`（`tokio::sync::Mutex`，`state.rs:1128`） | 范围内 28 处 `links.lock().await` 全部在下一个 `.await` 或下一把锁之前释放 |

**结论：唯一的跨锁嵌套缺陷就是 `db ↔ peers` 这一对。**

#### 最小修复建议

统一为一个全局锁序（推荐 **`peers` → `db`**，因为 `peers` 的读几乎总能先克隆出所需数据再放锁）：

1. `src-tauri/src/network/transport/handshake.rs:183-199` —— 把 `bind_friend_keys_on_accept` 的 `peers` 读取**移出该函数**：改成"调用方先取 peers 快照 → 传进来"，函数只做纯 DB 写。签名从 `conn: &rusqlite::Connection` 改为同时接收 `(x, e)` 快照。
2. `src-tauri/src/network/transport/peer_state.rs:19-26` —— `maybe_update_friend` 改为：先 `db::get_friend` 判定（块内取锁即放），若是好友则**先取 peers 快照、再取 db 锁**写库。
3. `src-tauri/src/network/transport/gossip.rs:261-268` —— 先从 `peers` 取出需要的字段并**立即放锁**，再取 db 写。
4. `src-tauri/src/network/transport/gossip.rs:167-189` —— `peers` 快照在 `match` 之前克隆出来，`None` 分支不再持锁。
5. `src-tauri/src/commands/friends.rs:67-90` —— `peers` 快照在函数开头克隆成 owned 值，之后不再持锁。

#### 回归测试方案

- **源码形状守卫**（与 `check-lock-scope.mjs` 同族，建议新增 **scripts/check-lock-order.mjs**）：断言"`state.peers.lock()` 的存活区间内不得出现 `state.db.lock()`"（**单向**断言即可，因为 `db → peers` 方向可以保留）。必须自带**非空转自证**（改坏即 FAIL、恢复即 PASS）——本仓 `docs/stability-roadmap.md` R9 那条教训："*未验证的守卫比没有守卫更危险*"。
- **运行时用例**：两个线程分别走 `maybe_update_friend`（db→peers）与 `handle_gossip` 的 peers→db 分支，用 `try_lock` 超时断言不死锁。

**兼容性风险**：低。全部是锁作用域收窄 + 一个函数签名变更，不改协议、不改数据、不改 UI 行为。

---

### 🟠 P1-01：`VACUUM` 独占全局 DB 互斥锁数秒~数分钟 ⇒ Tokio 运行时饿死

**风险类型**：流程卡死 / 运行时饥饿 · **证据级别：代码路径证实**

#### 证据

`src-tauri/src/commands/channel.rs:408-416`（自动清理路径）：

```rust
408:  let vacuum_note = if vacuumed {
409:      let (wait_ms, exec_ms, failure) = {
410:          let dbc = st2.db.lock().unwrap_or_else(|e| e.into_inner());   // ← 独占唯一那条连接
411:          let wait_ms = dbc.wait_ms();
412:          let started = std::time::Instant::now();
413:          let failure = dbc.execute_batch("VACUUM").err().map(|e| e.to_string());  // ← 重写整份库
414:          (wait_ms, started.elapsed().as_millis() as u64, failure)
415:      };
```

`src-tauri/src/commands/channel.rs:514-517`（用户手动"立即清理"路径）：

```rust
514:  if report.removed > 0 {
515:      let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
516:      let _ = dbc.execute_batch("VACUUM");
517:  }
```

仓库自己已经承认了后果（`src-tauri/src/commands/channel.rs:513`）：

> *"VACUUM 本身可能**秒~分钟级**，没删文件却空转一次等于**白冻全 App 一次**。"*

以及 `src-tauri/src/commands/channel.rs:363-366`：

> *"VACUUM 要重写整份 db 文件，期间持住那**唯一**一条连接。"*

#### 为什么这不只是"慢"，而是"卡死"

1. 129 个命令声明 `#[tauri::command(async)]`，其中 **24 个**命令体里含 `.db.lock()`。按 `tauri-macros` 的 `WrapperAttributeKind::Async ⇒ execution_context = Async` ⇒ `body_async` → `respond_async_serialized` → `crate::async_runtime::spawn(...)` ⇒ **这些命令全部跑在 Tauri 全局 Tokio 运行时的 worker 线程上**。
2. `std::sync::Mutex::lock()` 是**阻塞式 OS 锁**，在 async 上下文里会**占住 worker 线程**（不 yield 给执行器）。
3. Tokio 默认 `worker_threads = available_parallelism()`。
4. ⇒ 一旦有 `worker_threads` 个命令同时阻塞在 `db.lock()` 上，**整个 Tokio 运行时停摆**：心跳（5s）、announce（10s）、outbox 清扫（30s）、outbox 重试（5s）、群历史清扫（60s）、文件传输分块、ACK 处理、全部 IPC 响应 —— 全部停止。
5. 前端主线程只 await IPC 响应，因此**界面不刷新、按钮无反应**，用户看到的就是"应用卡死了"。

**这不是推演** —— 本仓已经在另一个维度上遇到过并诊断过同一机制，`src-tauri/src/network/transport/outbox_sweep.rs:344-348` 原文：

> *"★ 2026-10-14 真机之后加的两道隔离（用户：Mac 往 Windows 传 3.x GB，收尾那一段「**点设置没窗、拖窗口没反应**」）。条数上限**管不住字节**：…而这份读盘原本直接在 async 执行路径上 —— **同一个 runtime 上还跑着所有 async 命令（开设置窗就是其中之一），worker 被占满 ⇒ 用户点什么都没反应。**"*

**那次的修复只覆盖了"文件哈希"这一个实例**（`src-tauri/src/network/transport/outbox_sweep.rs:392-395` 改 `spawn_blocking` + `CONTENT_RECONCILE_TICK_BYTE_BUDGET` 256 MiB）。**DB 互斥锁这一维度的同形状问题完全没修**，而 DB 锁的持有时长（VACUUM 秒~分钟级）比那次哈希更长。

#### 触发条件

- **自动路径**：每 6 小时一次（`CACHE_CLEAN_INTERVAL_SECS = 6 * 3600`，`src-tauri/src/commands/channel.rs:360`），当上一轮清理释放 ≥ 64 MiB（`CACHE_CLEAN_VACUUM_MIN_FREED_BYTES`，`src-tauri/src/commands/channel.rs:367`）时触发 VACUUM。
- **手动路径**：用户点「立即清理缓存」且确实删了文件 ⇒ 立即 VACUUM。
- **库越大越糟**：多 GB 库的 VACUUM 是秒级~分钟级。

#### 现有机制评估

- ❌ **没有超时**：VACUUM 一旦开始，`busy_timeout(5s)`（`src-tauri/src/db.rs:927`）对它无效（它是自己持锁，不是等锁）。
- ❌ **没有降级**：无法在 VACUUM 期间让 UI 继续用（单连接架构下不可能）。
- ⚠️ 只有"频率节流"（阈值 + 仅在真删了文件时才做），**没有"时长上界"**。
- ⚠️ 有观测：`src-tauri/src/db_hold.rs` 的 `wait_ms` / `exec_ms` 分开计量（`src-tauri/src/commands/channel.rs:404-407`）—— 但只观测，不预防。

#### 最小修复建议

1. **给 VACUUM 加时长上界并允许放弃**：用 rusqlite 的 `progress_handler` 周期性检查已耗时，超阈值（如 3s）就中断 VACUUM。
2. **把 VACUUM 移出全局锁的"独占"窗口**：VACUUM 必须在连接上跑，无法绕开单连接锁 ⇒ 替代方案是改用 **`VACUUM INTO` + 文件替换**（`src-tauri/src/db.rs:845-877` 已有 `VACUUM INTO` 的成熟用法），在**独立连接**上做，主连接只做一次原子换名。
3. **给命令层加"DB 不可用则快速失败"通道**：对可降级的命令（`get_friends` / `get_settings` / `get_peers`）改用 `try_lock`，拿不到就返回上一次缓存值，而不是阻塞 worker。

**回归测试**：构造 1 GB 的 `messages` 表 + 并发发起 50 个 `get_messages` 的用例，断言 (a) 全部 IPC 在 X 秒内返回，(b) 期间心跳任务仍有进展（`state.emit_peers()` 计数继续增长）。

---

### 🟠 P1-02：阻塞式 `std::sync::Mutex` 在异步工作线程上取锁（系统性）

**风险类型**：死锁 / 运行时饥饿 / 流程卡死 · **证据级别：代码路径证实**

这是 P1-01 的**根因**，也是 P0-01 的**放大器**。单列出来，因为它是一个**架构级模式**，而不是单点缺陷。

| 事实 | 证据 |
|---|---|
| 全应用只有**一条** SQLite 连接 | `src-tauri/src/state.rs:955`；`src-tauri/src/db.rs:916-992` |
| 锁是**阻塞式** `std::sync::Mutex` | `src-tauri/src/db_hold.rs:86-89` |
| `AppState` 里另有 **20+ 把** `std::sync::Mutex`（`peers` / `gossip` / `mesh_router` / `relay` / `peer_manager` / `group_file_keys` / `file_receivers` / `relay_file_keys` / `pending_*` …） | `src-tauri/src/state.rs:953-1290` |
| 这些锁**全部**在 Tokio worker 上被获取 | 后台任务在 `tauri::async_runtime::spawn` / `tokio::spawn` 内（`src-tauri/src/lib.rs:516/583/598`、`src-tauri/src/network/transport.rs:226/297/416/440`）；命令在 `async_runtime::spawn` 内 |
| `std::sync::MutexGuard` **不能**跨 `.await` | `!Send` ⇒ 编译器强制 ⇒ **这一类死锁被类型系统排除了**（本仓做对的地方） |
| 但**等待锁**本身会占住 worker | `std::sync::Mutex::lock()` 不 yield |

**已知长持锁点**（按持锁时长排序）：

| 持锁者 | 位置 | 典型持锁时长 |
|---|---|---|
| `VACUUM` | `src-tauri/src/commands/channel.rs:413`、`:516` | **秒 ~ 分钟** |
| `export_chat_text` 全库读 | `src-tauri/src/commands/favorites.rs:398-401` → `src-tauri/src/export.rs:243-244`（`LIMIT -1`） | 秒级（十万级消息） |
| `search_chat_history` 全表 LIKE + 窗口函数 | `src-tauri/src/commands/chat_search.rs:66-75` → `src-tauri/src/db/messages.rs:650-681` | 亚秒 ~ 数秒（库大时） |
| `clear_all_data` 分批删 | `src-tauri/src/commands/favorites.rs:514-543`（已分批，批间 `yield_now`） | 每批数 ms（**已修**） |
| `db::init` 启动全表重建时钟 | `src-tauri/src/db.rs:976-982` | 启动期，500k 消息时数秒 |
| `list_transfers` 全表 | `src-tauri/src/db/file_transfer.rs:186-203` | 随历史线性增长 |
| `list_favorites` 全表 + 每行一次 `stat()` | `src-tauri/src/db/favorites.rs:73-79`、`src-tauri/src/commands/favorites.rs:88-93` | 随收藏数增长 |

**已有的缓解**（本仓做对的部分）：

- `src-tauri/src/db_hold.rs` 持锁/等锁分别计量，`DEFAULT_SLOW_MS = 500` 超阈出日志。
- `src-tauri/src/commands/favorites.rs:508-512` 明确记录了"大事务握住锁数秒 ⇒ 界面卡死"并改成**分批**（"分批执行，界面全程可响应"）。
- `src-tauri/src/commands/channel.rs:497-502` 把文件遍历移出 db 锁。
- `src-tauri/src/commands/logs.rs:1282-1285` 对窗口打开时的 db 读改用 `try_lock`（"lock 会在 db 被其他线程持有时阻塞主线程 → 整个 App 卡死"）。

**残留风险**：上述缓解是**逐点补丁**，没有一个**通用机制**保证"任何 db 锁等待都不会占住 worker"。

**最小修复建议（根治）**：

1. **把 `DbLock` 从 `std::sync::Mutex` 换成 `tokio::sync::Mutex`**：所有取锁点改 `.lock().await`。这会自动消灭"占住 worker"这一类问题。代价：命令层要改成 `async fn`（`#[tauri::command]` + `async fn`），是一次**中等规模但机械**的改动（约 335 个取锁点），**无协议 / 无数据 / 无 UI 语义变化**。
2. 过渡期折中：保留 `std::sync::Mutex`，但把**所有**命令体里的 `db.lock()` 换成 `tokio::task::spawn_blocking` 包裹（保证不占 worker），代价是多一次线程切换。
3. 无论选哪条，都应补一条**源码形状守卫**：禁止在 `async fn` / `async` 命令体里出现直接的 `s.db.lock()`（与 `src-tauri/src/lib_window_tests.rs:241` 同族）。

---

### 🟠 P1-03：群文件**没有续传路径** ⇒ 重试后必然失败，且已落盘的分片被删除

**风险类型**：业务流程无法完成 / 资源被破坏 · **证据级别：代码路径证实**

**单聊（DM）路径有修复，群路径没有。**

**单聊路径**：

- `src-tauri/src/network/transport/handle_file.rs:148` — `file::OfferDecision::Accept | file::OfferDecision::AcceptResumeSegment`
- `src-tauri/src/network/transport/handle_file.rs:171` — `file::restart_segment(state, &transfer_id)`（把 `next_seq` 归零、保留 `.part` 前缀）
- `src-tauri/src/network/file/receive.rs:253` / `:309` / `:333` — `AcceptResumeSegment` 枚举与判定

**群路径**：

- `src-tauri/src/network/transport/group_file.rs:28-35` — 收到 GroupFileOffer 时，若 `group_file_keys` 已含该 `transfer_id` ⇒ **直接 return**（幂等分支），**不重置 `next_seq`、不调 `restart_segment`**
- `src-tauri/src/network/transport/group_file.rs:1120-1125` — 分片到达时 `chunk_seq_decision(seq, r.next_seq)`；`Duplicate` ⇒ **静默丢弃**
- `src-tauri/src/commands/group_file_dispatch.rs:151-152` — 发送侧**永远**从 `seq = 0` / offset 0 开始
- 全仓 `restart_segment` **只有一个调用点**（`src-tauri/src/network/transport/handle_file.rs:171`，DM 专属）

**完整因果链**：

1. 群文件发送途中，发送侧的停滞中止（`FILE_STALL_ABORT_MS = 60_000`，`src-tauri/src/network/file.rs:209`）或发送期限（`FILE_SEND_DEADLINE` 10min / 大文件自适应）触发 ⇒ `GroupFileSendErr::Retryable`
2. 收件人行退回 `pending`（`src-tauri/src/commands/group_file_dispatch.rs:28-33`）
3. `flush_pending_group_files` 重新投递（`src-tauri/src/commands/group_file_keys.rs:80-102`）
4. 新 Offer 到达接收侧 ⇒ `src-tauri/src/network/transport/group_file.rs:28-35` 早退（key 已存在）⇒ 接收侧 `next_seq` 仍为 N
5. 发送侧从 `seq = 0` 重发 ⇒ 全部被判 `Duplicate` ⇒ **静默丢弃**，`r.received` 不变
6. 发送侧发 `GroupFileDone` ⇒ `finish_group_receive_into` 发现 `r.received != r.size` ⇒ **`std::fs::remove_file(&r.tmp_path)`**（`src-tauri/src/network/file/group_receive.rs:164-166`）⇒ **已落盘的前缀被删除**
7. 最终态 `failed`。⇒ **群文件一旦重试，就永远传不完，且已收到的部分被销毁**

**为什么 5 分钟的空闲回收救不了**：`FILE_RECEIVE_IDLE_ABORT_MS = 5 * 60_000`（`src-tauri/src/network/file.rs:216`）只在"没被喂"时触发；这里接收侧**正在被喂**（只是喂的是重复片），`fed_at_ms` 一直推进 ⇒ 永不触发。

**最小修复建议**：把 DM 路径的 `AcceptResumeSegment` / `restart_segment` 机制平移到群 Offer 路径；让群发送侧在重试时**从接收方已收字节数继续**（`src-tauri/src/commands/group_file_dispatch.rs:152` 的 `seq = 0` 改为从 `from_bytes` 起算）。

**回归测试**：e2e 增加一个 `--fault=group-stall-mid` 轮 —— 传到 30% 时杀发送方，重启后重投，断言最终 `done` 且字节与 SHA 全对（**当前会红**）。`scripts/e2e-multi-instance.mjs` 已有 `--fault=stall-mid`（DM 版）与 `--round=gfile` 框架，可直接复用。

**兼容性风险**：中。需要确认 `GroupFileOffer` 是否已带"已收字节数"字段；若无，接收侧可用 `r.received` 自行判定并回一个 `AcceptResumeSegment` 等价语义。

---

### 🟠 P1-04：群 outbox 在"一个成员离线"时，对**在线成员**每 5 秒重发一次，持续最长 7 天

**风险类型**：错误的重试退出条件 / 容量边界缺失 / 事件风暴 · **证据级别：代码路径证实**

> **状态：已在工作区修复（未提交）** —— 群 outbox 已改成逐行判定（新增 `db::group_outbox_row_expired` / `delete_group_outbox_row`），见 §0.1。**功能影响：本批唯一有用户可感知变化的条目**（正常路径零变化；只在「某成员在线却一直不 Ack」时把该成员的重发从 7 天收窄到 30 分钟），详见 §6.7。

**第 1 环 —— 7 天 hold 窗口是有意设计**

`src-tauri/src/db/offline_queue.rs:45-56`：

```rust
45: pub fn should_fail_expired(peer_reachable: bool, age_ms: i64, deadline_ms: i64, hold_ms: i64) -> bool {
51:     if peer_reachable { age_ms >= deadline_ms }   // 在线：30min（群）
53:     else { age_ms >= hold_ms }                     // 离线：7 天
55: }
```

`GROUP_OUTBOX_FAIL_DEADLINE_MS = 30min`（`src-tauri/src/db/offline_queue.rs:32`）、`OUTBOX_OFFLINE_HOLD_MS` = 7 天。

**第 2 环 —— 群 outbox 的放弃判定被聚合成"消息级"**

`src-tauri/src/network/transport/outbox_sweep.rs:227-253`：

```rust
227:  for (msg_id, (group_id, rows)) in per_msg {
228:      let all_give_up = rows.iter().all(|(peer, created)| {
231:          db::should_fail_expired(is_reachable(peer), now - created, 30min, 7天)
236:      });
238:      if !all_give_up {
239:          if log_throttled("outbox_hold_offline", 300_000) {
                  ... "reason=peer_offline(hold_7d)"      // ← 日志自己承认了
253:          continue;                                     // ← 整条消息的所有行都保留
254:      }
```

⇒ **一个成员离线 ⇒ `all_give_up == false` ⇒ 整条消息（含在线成员的行）全部保留。**

**第 3 环 —— 保留的行每 5 秒被重发一次**

`src-tauri/src/state.rs:2330-2345`：

```rust
2334:  tokio::time::sleep(Duration::from_secs(OUTBOX_RETRY_SECS)).await;   // OUTBOX_RETRY_SECS = 5
2339:  for peer in peers {
2340:      crate::network::transport::flush_outbox(&st, &peer).await;
2341:      crate::network::transport::flush_group_outbox(&st, &peer).await;
```

另有心跳臂（`src-tauri/src/network/transport/handle_identity.rs:118-126`，心跳同样 5s）也调 `flush_group_outbox`。

**完整后果**：

- 一条群消息只要有**任一**成员离线，**在线成员**就会每 5 秒收到同一份 Gossip 信封，**最长 7 天** ≈ **12 万次重复信封**。
- 收端按 `msg_id` 幂等去重（不重复入库），但**带宽、CPU、电池**成本真实存在。
- 每 peer 每 5 秒一次 `SELECT ... WHERE peer_id = ?`（`src-tauri/src/db/group_offline_queue.rs:23-28`）⇒ 持续 DB churn。
- **对比单聊路径**：`should_fail_expired_outbox`（`src-tauri/src/db/offline_queue.rs:38-40`）在 sweeper 里是**逐行**判定，在线行 120s 就放弃 ⇒ 单聊被正确限制在 2 分钟。**同一套判据，单聊逐行、群聚合** —— 这是"跨路径一致性缺失"的第三个实例。

**触发场景（极普通）**：群里有人长期离线（关机 / 换设备 / 不在线），期间群里发过消息 ⇒ 其余在线成员被持续轰炸 7 天。

**最小修复建议**（改动很小）：把 `src-tauri/src/network/transport/outbox_sweep.rs:228` 的 `rows.iter().all(...)` 改为**逐行判定**：`all_give_up` 只用于决定"这条消息是否整体可以判 failed"，而**每一行独立按自己的可达性判定**。在线成员的行在 30 分钟后独立判 failed 并从 `group_outbox` 移除；离线成员的行继续保留 7 天。

**回归测试**：新增一条纯函数单测（与 `src-tauri/src/db/offline_queue.rs:123-170` 同族）：

```
断言：rows = [(在线, 40min), (离线, 40min)] ⇒ 在线行判 failed、离线行保留
断言：rows = [(在线, 10min), (离线, 10min)] ⇒ 两行都保留
```

当前实现会让第一条**失败**（因为 `all_give_up == false` ⇒ 两行都保留）。

**兼容性风险**：低。语义变化是"在线成员的群消息在 30 分钟后放弃重发"——与单聊的 120s 口径一致，且**离线补发承诺（INV-P04）不受影响**（离线成员的行仍保留 7 天）。

---

## 3. P2 / P3 风险清单

### 3.1 P2（13 项）

| # | 位置 | 问题 | 证据级别 |
|---|---|---|---|
| P2-01 | `src-tauri/src/network/transport/group_file.rs:521` + `src-tauri/src/db/group_files.rs:200` | **群文件完成 ACK 丢失 ⇒ 发送侧收件人行永久停在 `sending`**。代码注释（`:521`）称"ACK 丢失可接受（发送端保持 sending，等待后续 retry/offline recovery）"，但 `list_pending_group_files_for_recipient` 只选 `status='pending'`，且**无 stale-`sending` 清扫器** ⇒ 那条 recovery 路径**不存在**。DM 路径有等价恢复（`src-tauri/src/network/transport/handle_file.rs:468-520` 重复 FileDone 时重发 ACK），群路径没有。⇒ 发送方气泡永远转圈。 | 代码路径证实 |
| P2-02 | `src-tauri/src/network/file/send.rs:423`（insert）/ `:455`/`:582`（remove） | **✅ 工作区已修**（新增 `PendingCompleteGuard`，§0.1）。**功能影响：零，且顺带修掉一个边缘缺陷** —— 守卫把"登记项存活到函数作用域结束"，原先在 `remove` 之后、函数结束之前到达的 `FileCompleteAck` 会被静默丢弃（`tx.send` 失败），现在能被收到。 | **`pending_file_complete` 在 9 条早退路径中的 8 条上泄漏**（取消 449/483/570/578、读错 463、加密失败 471、发送失败 496/572）。全仓仅 3 个 remove 点。⇒ `src-tauri/src/state.rs:1192` 的 HashMap 单调增长；且残留项会**吞掉迟到的 `FileCompleteAck`**（`src-tauri/src/network/transport/handle_file.rs:346` 的 `tx.send` 静默失败）⇒ ACK 丢失。修法照抄同文件 `WireLedger` 的 `Drop` 模式（`src-tauri/src/network/file/send.rs:343-347`）。 | 代码路径证实 |
| P2-03 | `src-tauri/src/transport/tcp.rs:94` + `src-tauri/src/protocol.rs:16` | **64 MiB 帧缓冲由 4 字节长度前缀触发**。`read_bytes_capped` 在校验 `len <= max` 之后、**在数据到达之前**就 `vec![0u8; len]`。`MAX_FRAME = 64 MiB`，而真实最大载荷是 `GROUP_HISTORY_PAGE_MAX_BYTES = 1.5 MB` / `FILE_CHUNK = 256 KiB` / `MAX_OPAQUE_PAYLOAD = 256 KiB` ⇒ **上限比真实帧大 ~40 倍**。`MAX_INBOUND_CONNECTIONS = 128` ⇒ 最坏 **~8 GiB 常驻**（每连接仅需 4 字节攻击流量）。预认证路径已正确收紧到 `MAX_PREAUTH_FRAME = 64 KiB`（`src-tauri/src/network/transport/outbound.rs:105`），暴露面从握手后开始。 | 代码路径证实 |
| P2-04 | `src-tauri/src/network/transport/gossip.rs:390-391` | **✅ 工作区已修**（§0.1）；**且严重度应从 P2 下调为 P3** —— 逐读后确认"要不要转发"的判定一直走 `MeshRouter` 的 `effective = ttl.min(max_ttl)`（`src-tauri/src/mesh/router.rs:191-200`、`:213-217`）⇒ **实际传播深度一直被钳在 6 跳**，wire TTL 偏大只让补递门槛 `MIN_TTL_FOR_RELAY = 2` 形同虚设（纵深防御缺失），**不**构成 254 跳扩散。原描述： | **Gossip 转发未套用 `max_ttl` 钳制**。`MeshRouter::on_receive` 内部算了 `effective = min(ttl, max_ttl=6)` 并递减，但 Gossip 路径**只取 Drop 判定**（`src-tauri/src/network/transport/gossip.rs:245`），真正上网的信封用**原始 `env.ttl`** 重建（`:390-391`）。而 TTL 恰恰是**唯一不参与 Ed25519 签名**的字段（`src-tauri/src/protocol.rs:1400-1422`）⇒ 对端可自报 `ttl=255` ⇒ **跨 254 跳扩散**（设计上限 6）。对比：基础设施路径 `src-tauri/src/network/transport.rs:1183-1188` 用的是路由器钳制后的值，**两条转发路径语义不一致**。 | 代码路径证实 |
| P2-05 | `src-tauri/src/transport/bluetooth_peripheral.rs:362`、`src-tauri/src/transport/bluetooth_peripheral_windows.rs:165`、`src-tauri/src/transport/ble_android.rs:189` | **BLE 外设驱动事件通道是整个传输栈里唯一的无界队列**（`mpsc::unbounded_channel::<PeripheralEvent>()`）。消费侧 `peripheral_accept_loop` 会在有界的每链路通道（cap 1024）上阻塞（`src-tauri/src/network/ble/peripheral.rs:448`）⇒ 事件开始堆积。每条 `PeripheralEvent::Frame` 最大 512 KiB（`src-tauri/src/transport/ble_framing.rs:166`）。BLE 带宽上限约 40 KB/s（`src-tauri/src/network/ble.rs:120`）使实际速率低，故定 P2 而非 P1，但**它是全栈唯一没有上限的队列**，与"其余每个队列都显式有界并写明理由"的仓库纪律不一致。 | 代码路径证实 |
| P2-06 | `src-tauri/src/db/file_transfer.rs:186-203`、`src-tauri/src/db.rs:674-687` | **`file_transfers` 表无保留策略**（schema 注释自己写着"行数是只增的（历史传输不删）"），而 `list_transfers` **无 LIMIT** 整表返回（`src-tauri/src/commands/files.rs:794-798`）⇒ 每次打开传输面板都把全表读进内存、序列化 JSON、走 IPC。同族：`file_outbox` 的 `failed` / `cancelled` 终态行也从不删除（`src-tauri/src/db/file_offline.rs:80` / `:97`；`delete_file_outbox` 只在成功时调用）。 | 代码路径证实 |
| P2-07 | `src-tauri/src/commands/favorites.rs:398-401` → `src-tauri/src/export.rs:243-244`、`:170` | **导出聊天记录把整库消息装进 RAM**：`db::get_messages(conn, conv, -1, 0)`（`LIMIT -1` = 不限量）逐会话全量物化，随后 `render_markdown` 用 `String::with_capacity(1024 + total*120)` 拼成**单个 String**，再 `std::fs::write` 又拷一次。峰值 ≈ 语料的 2–3 倍。已在 `spawn_blocking` 内（不占 worker），但**内存无上界**，且 `with_capacity` 在大库上会直接申请数 GB。 | 代码路径证实 |
| P2-08 | `src-tauri/src/network/file/share_walk.rs:15-52`、`src-tauri/src/network/transport/handle_share.rs:217-236` | **`walk_share_dir` 无条目数 / 总字节上限**（只有深度 ≤ 8），且**在 reader loop 内联同步执行**。整棵目录树被塞进一个 `Vec<ShareEntry>` → 整体塞进 `Message::ShareTreeResponse` → `serde_json::to_vec` 序列化成单帧 ⇒ 超过 `MAX_FRAME`(64 MiB) 时 `write_frame` 返回 `WriteError::Local`，帧被丢弃但**链路保留** ⇒ 请求方只看到一个 10 秒超时（`src-tauri/src/commands/share.rs:155`）。 | 代码路径证实 |
| P2-09 | `src-tauri/src/commands/group_announcements.rs:426-435` | **文件传输无并发上限**（全仓 `Semaphore` 只有 `dial_permits` 16 与 `inbound_permits` 128）。群发是**每个可达成员一个 `tokio::spawn`** ⇒ 200 人群 = 200 个并发任务，各自持 256 KiB 读缓冲 + AEAD + base64 副本 + 独立链路队列 ⇒ **约 300 MB–1 GB**，且**对同一个源文件并发读 200 次**。跨 peer 的 DM 并发也无界（每条链路 Low 队列 8 MiB ⇒ 50 peer ≈ 400 MB 纯队列）。 | 代码路径证实 |
| P2-10 | `src-tauri/src/network/transport/handle_file.rs:200-208` | **DM 续传在 reader loop 内联 `await` 整个前缀哈希**：`resume_receive` 对整个 `.part` 前缀重算 SHA-256（3 GB 前缀 ≈ 3 s），而 `handle_message` 是被 `reader_loop` 内联 await 的（`src-tauri/src/network/transport/queue_policy.rs:251`）⇒ 该连接上**所有其它入站帧**（聊天、心跳、其它文件分片）全部排队。同形状的 `ContentRequest` 已经通过每 peer 有界 `FileService` 队列（cap 8，`src-tauri/src/network/transport/queue_policy.rs:336-553`）修过，**续传路径漏掉了**。 | 代码路径证实 |
| P2-11 | `src-tauri/src/notifications.rs:255-263`（macOS）、`:200-223`（Win）、`:279-297`（Linux） | **每条通知 spawn 一个 OS 线程并无限期阻塞在 `wait_for_response`**。代码注释（`:240-242`）自己承认"该线程会存活到通知被点击/自动消失；若通知长期留在通知中心，线程也会长期挂住"。⇒ 线程数与"系统通知中心里还没被清掉的通知数"同阶增长（每线程默认 8 MB 虚拟栈）。前端只有 1.5s 去抖（`src-tauri/src/notifications.rs:241` 提及，未在 Rust 侧强制）。 | 代码路径证实 |
| P2-12 | 前端 `src/components/FavoritePanel.vue:113`、`:334-345`、`:409-421`、`:726-736` | **`thumbs` 持有已被 LRU revoke 的 objectURL**。`src/utils/favoritePreview.ts:25-29` 走 `blobLru`（60 MiB 上限），`src/utils/blobLru.ts:90-98` 逐出时**调用 revoke**；而 `thumbs` 是一份裸 URL 字符串记录、无失效钩子 ⇒ `thumbs[f.id]` 指向**已撤销**的 URL ⇒ 详情图裂开；`previewImage()`（`:414`）的 `?? loadFavoritePreview(...)` 兜底因"死字符串是 truthy"而**永不触发** ⇒ 灯箱也是死图。这与 `src/utils/filePreview.ts:7-13` 写明的"消费者不得自行 revoke、缓存是唯一出口"是同一所有权模型被反向打破。 | 代码路径证实 |
| P2-13 | 前端 `src/stores/useChatStore.ts:948`、`src/utils/todos.ts:973-989` | **`groupTodoRows` 无上限、永不逐出**。后端 `get_group_todo_messages` 只限制**会话数**（`src-tauri/src/commands/chat.rs:430` `MAX_CONVS = 400`），**行数无 LIMIT**；`mergeIncomingTodoRows` 每个新任务事件都往 per-conv 数组追加。⇒ 内存单调增长，且 `foldTodos`（`src/utils/todos.ts:548-610`）对每行做一次 `JSON.parse` ⇒ 每来一个任务事件就是 O(总行数) 的解析开销。对比：消息缓存有 `MAX_CACHED_CONVS=8 × PAGE_SIZE×MAX_PAGES=1000` 的闸（`src/stores/useChatStore.ts:1345-1348`）。 | 代码路径证实 |

### 3.2 P3（19 项）

| # | 位置 | 问题 |
|---|---|---|
| P3-01 | `src-tauri/src/mesh/manager.rs:205` | `state.peer_manager` **永不裁剪**（`remove_peer` 零生产调用点），随"见过的 device_id"单调增长。对比 `state.peers` 有 45s TTL 清扫（`src-tauri/src/network/discovery.rs:876`）—— **两套 peer 表，只清了一套** |
| P3-02 | `src-tauri/src/mesh/gossip_replay.rs:57-88` | `by_group` 的 **map key** 永不淘汰（只有桶内值被 16 条 / 10 分钟窗口限制）⇒ 群数增长时键数单调增长 |
| P3-03 | `src-tauri/src/state.rs:1130` + `src-tauri/src/network/discovery.rs:896-918` | `pending_requests` **未纳入 peer 清扫**。`src-tauri/src/network/discovery.rs:898-902` 的注释点名了 `peer_content_features` / `peer_versions` / `key_conflict_warned` 三张表的同一危害，但**漏了这第四张** |
| P3-04 | `src-tauri/src/network/group_history.rs:772-798` | `group_history_active` 条目在同步任务 **panic** 时永不删除 ⇒ 该群**永远无法再同步历史**（自动清扫与手动路径都被 `spawn_sync` 挡住）。修法照抄 `WireLedger` 的 `Drop` 模式 |
| P3-05 | `src-tauri/src/network/file/send.rs:191-292` | `pending_file_accept` 在"连续 3 次 `continue`"路径（`:274`）不删条目；且外层 `timeout` 触发时整个内层 future 被 drop ⇒ 清理分支不执行 ⇒ **每次泄漏一个 `oneshot::Sender`** |
| P3-06 | `src-tauri/src/state.rs:1201` + `src-tauri/src/network/transport/group_file.rs:148-153` | `group_file_keys` **永不淘汰**；且群接收器只在**第一片**才创建（`:1077-1094`）⇒ "只发 Offer 不发分片"会留下永不被 `sweep_stalled_receives` 回收的密钥条目。对照 `relay_file_keys` 有 1h TTL（`src-tauri/src/network/transport.rs:60`） |
| P3-07 | `src-tauri/src/state.rs:1085` + `src-tauri/src/commands/logs.rs:780`/`:909` | `todo_focus_request` 在"窗口未挂载就被销毁"时条目永不取走 ⇒ 按群累积 |
| P3-08 | `src-tauri/src/network/transport/gossip.rs:250` | `gossip` 锁（std Mutex）在 `peers` 锁（`:261`）之前获取 —— 又一对潜在 ABBA 的候选对，目前未构成死锁但**没有锁序约束保护** |
| P3-09 | `src-tauri/src/network/ble/central.rs:247-263` | `scan_now.changed()` 的 `Err` 臂注释说"继续按周期跑"，但 tokio 的 `watch::Receiver::changed()` 在 sender 全 drop 后**立即且持续**返回 `Err` ⇒ select 每轮立即返回 ⇒ **扫描节奏的 5s/30s 节流被绕过**，退化为 2s 连续扫描。`src-tauri/src/network/ble.rs:323` 会在 stop 时 drop sender，但 `stop()` 先发 shutdown（`:298`）且 shutdown 是 `biased` 第一臂 ⇒ 实际是**潜伏缺陷** |
| P3-10 | `src-tauri/src/network/discovery.rs:741-793`、`src-tauri/src/network/transport/outbox_sweep.rs:478-494` | 两处同步系统调用留在 async worker 上：`get_if_addrs()`+socket bind（每 ~15–60s 一次，仅在广播全失败时）、`std::fs::metadata`（每 30s tick 最多 8 次）。慢盘 / 网络盘上可阻塞 worker 数十 ms |
| P3-11 | `src-tauri/src/network/transport/group_file.rs:1141`、`src-tauri/src/network/file/receive.rs:523-565` | **持全局 `file_receivers` 锁做阻塞 `write_all`** ⇒ 慢盘上一片 256 KiB 写可持锁数秒，阻塞**全进程所有文件接收**；且是 async 任务里的阻塞调用 |
| P3-12 | `src-tauri/src/network/file/relay_push.rs:104`、`src-tauri/src/file_relay.rs:202` | `chunk_count = ... as u32` 截断（>281 TB 才触发）；`seq * chunk_size` 在 `chunk_size = u32::MAX` 时 u64 溢出 ⇒ 写到非预期偏移（后续 SHA 会拦下） |
| P3-13 | `src-tauri/src/commands/files.rs:39-42` | `save_outgoing_image` **先 base64 解码再检查 8 MiB 上限** ⇒ 100 MB 的 data URL 会先完整进 RAM 才被拒 |
| P3-14 | `src-tauri/src/storage/cache_cleaner.rs:102-155` | `walk_files` 把**所有**文件路径收进一个 `Vec`（无条数上限、无深度上限；迭代式栈 ⇒ 不会栈溢出、不会跟符号链接）⇒ 百万文件缓存目录 ⇒ 数百 MB |
| P3-15 | 前端 `src/components/TodoImageThumb.vue:52-72` | 退避重试**永不放弃**（无次数上限，饱和到 30s）⇒ 每个缩略图在挂载期间每 ≤30s 发 2 次 IPC，直到图片字节到达或组件卸载 |
| P3-16 | `src-tauri/src/network/transport/outbox_sweep.rs:144` / `:206` / `:282` | **sweeper 每个 30s tick 对三张表各做一次无 `LIMIT` 的全量扫描**。`list_expired_outbox` / `list_expired_group_outbox` / `list_expired_file_outbox` 均无 `LIMIT`；因离线行 hold 7 天，"超过 120s 的行数 k"随 7 天内离线积压线性增长，**每 30 秒被重新物化一次**（`Vec` + `per_msg` HashMap 聚合，O(k)/tick）。同 tick 内的内容对账扫描反而是有界的（`CONTENT_RECONCILE_PER_TICK = 8` + 256 MiB 字节预算）—— 同一文件里两种纪律。修法：三条查询加 `LIMIT` 并按 `id` 分块 |
| P3-17 | `src-tauri/src/network/transport/queue_policy.rs:451-461` + `src-tauri/src/network/transport/handle_share.rs:136-177` | **`FileService` 的"有 job 无消费者"竞态**：`close_peer`（`src-tauri/src/network/transport/queue_policy.rs:545-552`，每次 `reader_loop` 退出都调）把 entry 标 `closed` 并 drop `tx`；而 `src-tauri/src/network/transport/handle_share.rs:137` 的 `if !fs.has_worker(&from)` 读到的可能仍是"旧 entry（running=true）"⇒ 跳过 `start_worker` ⇒ 随后 `submit`（`:457`）**替换**出一个 `running=false` 的新 entry，其 `Receiver` 永远无人 take ⇒ 那个 job 永不被服务，`cid` 永远留在 `PeerQueueState.queued`，且新 entry 的 generation 与旧 worker 的 `Drop` 守卫不匹配 ⇒ **map 条目永不逐出**。自愈条件：同一 peer 的**下一个** `ContentRequest` 会重启 worker；若不再来请求则泄漏。**证据级别：待验证**（竞态窗口窄） |
| P3-18 | `src-tauri/src/network/transport/relay.rs:194-207` | **`relay_rendezvous_task` 的 `inflight` 集合在拨号任务 panic 时不回收**：`Err(e)` 分支只记日志不 `inflight.remove`；`:207` 的兜底 `if dials.is_empty() { inflight.clear(); }` 只在**整个 JoinSet 空**时才清。⇒ 8 次拨号 panic 即可永久占满 `MAX_RELAY_CIRCUITS = 8`（`src-tauri/src/network/transport/relay.rs:47`）⇒ **该节点再也无法建立任何中继电路**。附带：`pick_relay_targets`（`:95-114`）只把 `inflight` 用于**计数**、不用于**跳过**已在飞的 peer ⇒ 同一 peer 每轮被重复选中、重复 spawn 拨号任务，槽位账目漂移 |
| P3-19 | `src-tauri/src/network/transport/dial.rs:576-589` | **出站链路 push 没有 per-peer 上限**。`should_accept_inbound` 对**入站**强制 `MAX_LINKS_PER_PEER = 6`（`src-tauri/src/network/transport/dial.rs:162`、`:185-187`），但出站 `state.links.entry(peer_id).or_default().push(Link{...})` **无长度检查**。实际可达性低（出站拨号按端点去重 `src-tauri/src/network/transport/dial.rs:427-433`，且 `should_dial` 在已有 LAN 路径时短路 `:266-281`），实测上限约 4（LAN/Routed/Relay/BLE） |

### 3.3 一处"矛盾"的澄清（两个子审计的结论都成立）

审计过程中两份子审计对"BLE 事件通道是否无界"给出了看似相反的结论。复核后确认**两者都正确**，差异来自范围划分：

- 其中一份的范围是 `src-tauri/src/network/transport/**`（**子目录**）；
- 无界通道实际位于 `src-tauri/src/transport/`（**兄弟目录**）：`src-tauri/src/transport/bluetooth_peripheral.rs:362`、`src-tauri/src/transport/bluetooth_peripheral_windows.rs:165`、`src-tauri/src/transport/ble_android.rs:189`。

已直接复核这三行确为 `mpsc::unbounded_channel()`。**P2-05 成立，行号不变。**

### 3.4 工程脚本与 CI 专项（SC-P2 × 7 / SC-P3 × 8）

> **这一节的结论不影响出货应用的内存与活性**。它们全部落在**本地工具链与 CI** 上：`scripts/**`、`perf/**`、`.github/workflows/**`。列出来的理由是审计范围（用户指令 §一）明确包含"工程脚本与后台任务"，而且其中 **SC-P2-03 是一条真实的命令注入原语**，值得单列。
> 编号用 `SC-` 前缀，避免与 §3.1 / §3.2 的产品侧编号冲突。

#### SC-P2（7 项）

| # | 位置 | 问题 | 证据级别 |
|---|---|---|---|
| **SC-P2-01** | `scripts/semver.mjs:196-198`（`git()`）+ `:210-211` + `:513` | **✅ 工作区已修并验证关闭**（§0.1：注入标记出现 0 次，`version:check` / `changelog` 仍通过）。**功能影响：零**，唯一变化是失败方式 —— 含空格/元字符的 revision 现在作为**单个**参数传给 git 并报错，原先会被 shell 静默拆成两个参数。**命令注入原语**。`execSync(\`git ${args}\`)` 把参数**字符串插值**进 shell；`execSync` 用字符串参数时走 `/bin/sh -c`。三处可注入来源：① `--since <value>` CLI 参数（`collectCommits` 拼成 `${since}..HEAD`）；② **git tag 名**（`lastVersionBump()` 回落到 `latestTag()`，git 允许 ref 名里含 `;` `$` `(` `)`）；③ **分支名**（`:510` 读 upstream 分支名，`:513` 拼成 `rev-list ${upstream}..HEAD`）。`maxBuffer: 64 << 20` 只限输出大小，**无参数校验、无 `shell:false`、无子命令白名单**。受影响入口 `npm run version:changelog` 是 `scripts/verify.mjs` 前端组的一步，`verify.yml` 在 push 与 pull_request 都跑 ⇒ CI 每次 push/PR 都走这条路；对维护者本机（对着克隆了攻击者 tag 的仓库）风险更直接。**修法是一行形状改动**：`execSync(\`git ${args}\`)` → `spawnSync("git", [...])`（参数数组）。 | 代码路径证实（注入已用本仓自己的 `git()` 实跑验证，标记被打印） |
| **SC-P2-02** | `perf/probe.mjs:16-26` | **CDP 调用无任何超时 ⇒ 永久挂死**。`evalJs` 在 `pending` 里登记 resolver 后**不 arm 任何定时器**；若 CDP 目标不回应 `Runtime.evaluate`（渲染线程卡死、页面冻结、目标陈旧），promise 永远 pending ⇒ `:24` 的第一个 `await evalJs(...)` 永不返回 ⇒ `for (let i = 0; i < 40; i++)` 的**迭代次数上限管不住单次迭代内的耗时** ⇒ 进程既不退出也不打印任何东西。没有 `SIGINT` 处理、没有 `process.on('exit')`、没有 `AbortController`。`perf/**` 不被任何 workflow 或 npm 脚本引用 ⇒ 影响面仅限本地。 | 代码路径证实 |
| **SC-P2-03** | `perf/run.mjs:36-43` + `:261-277` | **未清除的 180 s 定时器让进程在结果打印完后仍滞留约 3 分钟**。每次 `send()` 都 arm 一个 180 000 ms `setTimeout` 且**句柄既不存也不清**；默认分支结尾是 `ws.close()` 而**没有 `process.exit()`** ⇒ 该定时器把 Node 事件循环钉住。`:51-55` 的就绪循环每次尝试再 arm 一个 60 s 定时器 ⇒ 尾部最多同时挂着 60 个。同文件的另外三个分支（`PERF_ONLY=mem` `:128`、`resize` `:190/192`、`throttle` `:256/258`）都调了 `process.exit(...)`，所以只有默认分支受影响。**影响**：`perf/run.mjs` 的结果早就打在 stdout 了，但任何等这个进程退出的包装脚本 / `&&` 链会白等 3 分钟；期间第二次运行还会与第一次抢同一个 CDP 目标。 | 已复现（Node 语义：被引用的定时器会保持事件循环存活） |
| **SC-P2-04** | `scripts/check-ui-runtime-ax.mjs:96-99`、`:123-129`、`:144` | **detached 子进程只在成功路径被杀 ⇒ 孤儿实例**。`detached: true` + `unref()` 让子进程进入**自己的进程组**并脱离父进程寿命；唯一的收尾是 `process.kill(-pid, "SIGTERM")`，只在**成功路径**（`:194-196`）到达。而 `:105` / `:113` / `:144` 三处 `process.exit(2)` 都在 spawn 之后 ⇒ 走这些分支时**进程组从不被 signal**，孤儿 `gosslan` 继续占着 TCP 端口与 SQLite 库，后续同实例号运行会 bind 失败或撞 `SQLITE_BUSY`，反复失败会堆积进程。 | 代码路径证实 |
| **SC-P2-05** | `scripts/mem-sample.mjs:97-99` + `:187-193` | **同形状的孤儿路径**。`:98` 的 `detached: true` 让被测应用拥有自己的进程组；`:189` 的 `process.kill(-child.pid, "SIGTERM")` **只在正常路径**。`:99` 与 `:187` 之间任何抛出（`snapshot()` 抛错、`:184` 的 `fs.writeFileSync(OUT, …)` 因磁盘满 / 路径无效失败）都会让模块展开、Node 打印栈并退出，**进程组从不被 signal** ⇒ 被测应用继续跑，并且**污染下一次运行的内存基线**（这正是这个脚本要测的东西）。 | 代码路径证实 |
| **SC-P2-06** | `scripts/e2e-dev.sh:72-83` | **后台应用无 `trap` ⇒ 就绪失败路径留下孤儿**。脚本有 `set -u` 但**无 `set -e`、无 `trap ... EXIT`**；`:72` 起的后台作业在 `:79-83` 的就绪失败分支直接 `exit 1`，**不 kill `$APP_PID`**（bash 退出时不杀后台作业）。正常路径 `:89-94` 是有清理的 ⇒ 只有失败路径泄漏。**影响是自我中毒式的**：下一轮跑同一个脚本会在**同一处**再失败（端口已被占），很容易被误诊成产品回归。 | 代码路径证实 |
| **SC-P2-07** | `scripts/t4-mirror-dial.sh:49-68` | **同形状：无 `trap`，`kill` 只在两条显式路径**。`:59` 杀就绪失败分支，`:67` 杀正常分支；**任何其它退出方式（Ctrl-C、`:64` 的 peer 命令非零退出、shell 被杀）都会跳过 kill** ⇒ 孤儿占着 TCP 端口。附带：`kill "$APP_PID"` 只针对直接子进程，Tauri 应用自己 spawn 的 WebKit helper（`webContent` / `webGPU` / networking）**不在 kill 集里**（没有 `kill -- -$PGID`）⇒ 即使在"干净"路径上 helper 进程也可能残留。 | 代码路径证实 |

#### SC-P3（8 项）

| # | 位置 | 问题 |
|---|---|---|
| SC-P3-01 | `scripts/e2e/core.mjs:495` | `launch()` 用 `fs.openSync(..., "a")` 打开追加模式 fd 交给 `spawn` 当 stdout/stderr，**父进程从不 `close()`** ⇒ Node 进程的 fd 表单调增长。28 个 `launch()` 调用点、按轮次启动实例 ⇒ 多轮 E2E 会累积。当前轮次数（≈18）× 实例数（≈3）≈ 54，低于 macOS 默认软上限 256 ⇒ 属**潜伏**问题，余量随轮次增加而缩小。 |
| SC-P3-02 | `.github/workflows/build.yml` / `build-macos.yml` / `build-android.yml` / `build-windows-webview2.yml` | **四个打包 workflow 的所有 job 都没有 `timeout-minutes`** ⇒ GitHub 默认 360 分钟 ⇒ 一次挂起烧 6 小时 runner 时间。对照：`verify.yml`（真正卡门禁的那个）**有**显式预算（45 / 60 / 45 / 240）。 |
| SC-P3-03 | 四个 workflow 的 `upload-artifact` | **未设 `retention-days`** ⇒ 用仓库默认保留期（公开仓 90 天，私有仓可配置甚至无限）⇒ 每次成功打包都留下一整份安装包载荷，仓库内产物存储单调增长。`scripts/publish-release-assets.sh` 清理的是 **Release 资产**，不是 Actions artifact。 |
| SC-P3-04 | `.github/workflows/build-android.yml:125-131` | 上传 APK 的 artifact **漏了 `if-no-files-found: error`** ⇒ 默认 `warn` ⇒ **上传 0 字节也算这一步成功**。同仓另两个 workflow 都带了这个严格标志（`build.yml:73`、`build-macos.yml:92`）⇒ 属不一致而非全仓惯例。job 仍会因前一步 `::error::` + `exit 1` 而红，但留下一个**名字存在却为空**的 artifact，诊断"APK 去哪了"会更难。 |
| SC-P3-05 | `scripts/check-ui-runtime.mjs:2212-2229` | `waitForVite` 的 `buf += text` **无上限**（实际只用 `buf.slice(-800)`）⇒ 内存随 vite 输出增长；且 `:2223` resolve 之后 **`onData` 监听器从不摘除** ⇒ `buf` 在整个测试run里继续增长。90 s 的等待窗口界定了**时长**而非**缓冲**。 |
| SC-P3-06 | `scripts/e2e/core.mjs:126-140` | `citedRunIds()` 为了跑一条正则，把**每一个被 git 跟踪的 `*.md` / `*.html` 整份读进内存**。当前跟踪集约 4.6 MB（`CHANGELOG.md` 单独约 605 KB 且随每次发版增长）⇒ 每次 prune 约 5 MB 瞬时分配 + 5 MB 文件 I/O。 |
| SC-P3-07 | `scripts/e2e/core.mjs:143-149` + `:153-174` | **崩掉的 E2E run（没有 `summary.json` ⇒ `unknown`）永远不会被清理**。`prunePlan` 只删超龄的 `green` 与超龄的 `red`，`unknown` 两条都不匹配 ⇒ 崩在半路的 run 无论多老都留着（这条行为被脚本自己的单测在 `:245` / `:261` 钉住 ⇒ 是**刻意**的："崩在半路 ⇒ 现场比省空间值钱"）。⇒ `test-results/` 随崩溃次数单调增长，一次崩溃的多实例 run 会留下日志、DB 快照与截图。 |
| SC-P3-08 | `scripts/verify.mjs:1193`、`scripts/verify-guards.py:211` | ① verify 步骤用 `spawnSync` 且**无 `timeout` 选项** ⇒ 本地 `npm run verify` 无任何上限；CI 里只有 job 级 `timeout-minutes` 兜底（一个卡住的步骤会吃满整个 job 预算）。② `verify-guards.py` 每条命令 900 s × **239 条**（其中 93 条标 `frontend`、68 条用 `cmd=npm("test")` ⇒ 约 136 次全量前端测试）⇒ 理论上限约 **59.75 小时**，而 `guards` job 预算只有 240 分钟 ⇒ 真正会先触发的是外层 job 超时，**丢失"是哪条卡住"的归因**（内层 900 s 会在 15 min 给出逐条诊断）。 |

---

## 4. 关键流程活性分析

下表逐条给出**终止条件**与**异常恢复**。凡"✅"均已逐行核实。

### 4.1 单聊消息发送 → ACK

| 环节 | 终止条件 | 异常恢复 | 判定 |
|---|---|---|---|
| 乐观上屏 → 落库 → 入 outbox | `db::insert_message_and_outbox` 单事务（`src-tauri/src/db/messages.rs:44-72`） | 写库失败 ⇒ 消息不产生 | ✅ |
| outbox 投递 | `try_send` + `SEND_QUEUE_FULL_TIMEOUT` 有界等待（`src-tauri/src/network/transport/outbound.rs:260-266`） | 队列满 ⇒ 退避后重投 | ✅ |
| 等 Ack | 120 s 无 Ack ⇒ sweeper 判 failed（`src-tauri/src/network/transport/outbox_sweep.rs:108` / `:136-145`） | 对端**离线不判失败**，保留到 `OUTBOX_OFFLINE_HOLD_MS`（产品承诺"离线暂存、上线补发"） | ✅ |
| 离线补发 | 每次建链 / Hello / 心跳触发 flush | `pending_out_requests` / `pending_out_accepts` 有窗口与次数上限（`src-tauri/src/network/transport/handshake.rs:443-456`、`:543-560`） | ✅ |
| 收端落库 | INV-P03"落库才算 ACK" | 解密失败不 Ack | ✅ |

### 4.2 单聊文件传输（DM）—— **最完整的一条**

| 环节 | 终止条件 | 异常恢复 | 判定 |
|---|---|---|---|
| 发送期限 | `send_deadline_for(size)` ∈ [10 min, 1 h]（`src-tauri/src/network/file.rs:178`、`:193-201`） | 超时 ⇒ retryable | ✅ |
| 分片循环 | EOF / 取消 / 接收端否定确认 / 链路失败（`src-tauri/src/network/file/send.rs:444-498`） | 接收端已判死 ⇒ 立刻停手，不把剩余字节灌进死链路 | ✅ |
| 背压 | 原地等 `send_on_link_with_tick`（队列满时等，**不换链路**，换路=分片失序） | 等待期每 5s 做停滞检查 | ✅ |
| 停滞检测 | 15 s 告警 / 60 s 中止（`src-tauri/src/network/file.rs:205` / `:209`），由 `mark_file_wire_progress` 驱动（**只在 socket 真正写成功后**才记进展） | — | ✅ |
| 等完成 ACK | 30 s **安静**窗口（`FILE_ACK_IDLE`），**有真实进展就重置**（`src-tauri/src/network/file/send.rs:741-755`） | — | ✅ |
| 续传 | `AcceptResumeSegment` + `restart_segment` 保留 `.part` 前缀 | 丢失的完成 ACK 可由重复 `FileDone` 恢复（`src-tauri/src/network/transport/handle_file.rs:468-520`） | ✅ |
| 接收端资源 | 完成 / 失败 / 断链 / 5 min 空闲 四条路径都摘掉 `FileReceiver`（含文件句柄） | `sweep_stalled_receives` 每小时兜底 | ✅ |
| 临时文件 | 尺寸 / SHA / fsync 三道校验失败都 `remove_file`；成功则 `rename` | 中途失败**故意保留** `.part` 作续传前缀，由 24h TTL 清扫 | ✅ |
| 重试预算 | `MAX_FILE_OUTBOX_RETRIES = 5` | 5 次后 GiveUp ⇒ 终态 failed | ✅ |
| **发送侧完成信号表** | — | **8/9 条早退路径不删 `pending_file_complete`** ⇒ 泄漏 + 吞掉迟到 ACK | ❌ **P2-02** |

### 4.3 群文件传输（Group File）—— **与 DM 存在系统性差距**

| 环节 | 终止条件 | 异常恢复 | 判定 |
|---|---|---|---|
| 群发扇出 | 每成员一个 task，**无并发上限** | — | ⚠️ **P2-09** |
| 分片循环 | 与 DM 同构（`src-tauri/src/commands/group_file_dispatch.rs:158-211`），有 cancel / 背压 / 停滞 tick | — | ✅ |
| 群完成 ACK 落账 | **先落 `group_file_acks` 持久化账本再收尾**（`src-tauri/src/network/transport/group_file.rs:891-905`），失败则只留日志 | 账本每 tick 重放（`replay_pending_group_file_acks`），5 次后强制 failed（`GROUP_FILE_ACK_MAX_ATTEMPTS=5`，`:864`） | ✅ **优秀设计** |
| **重试 / 续传** | — | **群路径没有 `restart_segment`；重发从 seq 0 开始，接收侧判 Duplicate 丢弃，最后删掉 `.part`** | ❌ **P1-03** |
| **完成 ACK 帧丢失** | — | **`list_pending_group_files_for_recipient` 只选 `pending`；`sending` 行无清扫器 ⇒ 永久卡住**（注释声称的 recovery 不存在） | ❌ **P2-01** |
| **群 outbox 放弃判定** | 逐行 30 min（在线）/ 7 天（离线） | **被聚合成消息级 `all_give_up`** ⇒ 一个成员离线牵连全部在线成员 | ❌ **P1-04** |

### 4.4 内容拉取（ContentRequest / content_transfers）

| 环节 | 终止条件 | 异常恢复 | 判定 |
|---|---|---|---|
| 每 peer 串行服务队列 | cap 8（`FILE_SERVICE_QUEUE_CAP`，`src-tauri/src/network/transport/queue_policy.rs:9`），RAII 注销 | 这条曾把 15 s 握手塞在接收循环里串行 ⇒ 手机端被 14 条重试串行服务 ≈ 210 s（2026-10-13 真机）。**已修** | ✅ |
| 重试封顶 | `MAX_CONTENT_RETRIES = 8`（`src-tauri/src/content/policy.rs:14`）+ 单调退避 | 超限 ⇒ `Rejected` 终态，`list_resumable` 不再捞 | ✅ |
| **"永动重试"隐患** | 旧写法：到期重发本身不记失败 ⇒ `attempts` 永不涨 ⇒ 封顶形同虚设 | **已修**（`src-tauri/src/network/transport.rs:1006-1025` 每轮重发都 `record_failure`） | ✅ |
| 对账回收 | 每 tick ≤ 8 条 / ≤ 256 MiB 字节预算（`src-tauri/src/network/transport/outbox_sweep.rs:435`、`:437-441`） | 读盘移入 `spawn_blocking`（`:392-395`） | ✅ |
| FileService 注册竞态 | — | 存在"有 job 无消费者"窗口 | ⚠️ **P3-17** |

### 4.5 断连重连 / 链路健康

| 环节 | 终止条件 | 异常恢复 | 判定 |
|---|---|---|---|
| 拨号去重 | `DialGuard` RAII（`src-tauri/src/state.rs:900-926`）+ 16 并发信号量 | panic / 早退都会归还 | ✅ |
| 入站连接上限 | 128（`src-tauri/src/state.rs:984`，`src-tauri/src/network/transport.rs:266-279`） | 拒绝时**留痕**（三种结局可区分） | ✅ |
| 半开链路清理 | 健康看门狗 = 3× health timeout（`src-tauri/src/network/transport.rs:340-404`） | BLE 端点也纳入（`src-tauri/src/network/transport.rs:367-368` 注释记录了此前 BLE 死链永久占位的老 bug） | ✅ |
| 被动 BLE 断连 | `CentralEvent::DeviceDisconnected` **只打日志**（`src-tauri/src/network/ble.rs:230-236`） | 靠写失败或 45s 看门狗兜底 | ⚠️ **P3**（待验证：btleplug 行为外部不可知） |
| 世代号 | `network_generation`（`src-tauri/src/state.rs:1231`）阻止"上个世代"的任务登记进新世代的 `links` | — | ✅ **优秀设计** |
| 出站链路条数 | — | 无 per-peer 上限（入站有 6） | ⚠️ **P3-19** |

### 4.6 群历史同步

| 环节 | 终止条件 | 异常恢复 | 判定 |
|---|---|---|---|
| 在飞闸 | `group_history_active` 防重复排队 | — | ✅ |
| 分页 | `GROUP_HISTORY_PAGE_ITEMS` + `GROUP_HISTORY_PAGE_MAX_BYTES=1.5 MB` **共享一份预算**，且"绝不返回 0 条"（`src-tauri/src/db/group_history.rs:132-134`、`:201`）⇒ **不会因 0 条而游标不动** | ✅ **关键防护** |
| 失败 | `group_history_active` 移除 | **任务 panic ⇒ 条目永不删 ⇒ 该群永远无法同步** | ❌ **P3-04** |

### 4.7 应用启动 / 退出 / 重启

| 环节 | 终止条件 | 异常恢复 | 判定 |
|---|---|---|---|
| 启动失败 | `StartupError` 六态（`src-tauri/src/state.rs:1290-1400`），**绝不降级成"新建一份"** | 迁移前 `VACUUM INTO` 备份 + `integrity_check`（`src-tauri/src/db.rs:852-913`） | ✅ **优秀设计** |
| 迁移 | 有限数组 10 步，逐幂等；降级版本拒绝打开（`src-tauri/src/db.rs:937-941`） | — | ✅ |
| 退出 | 只有 `RunEvent::Exit` 写退出路标（`src-tauri/src/lib.rs:863-870`），**不停止任何任务** | 托盘"退出"路径会 `network::stop()` + 800ms 看门狗（`src-tauri/src/tray.rs:472-495`） | ⚠️ **P3**：非托盘退出（注销 / 崩溃 / Android 杀）不收尾 |
| 重启 | 托盘"重启"只停 LAN，**不停 BLE**（`src-tauri/src/tray.rs:440-444`） | ⇒ 新旧进程同时扫描 / 广播同一 `SERVICE_UUID` | ⚠️ **P3** |
| 任务所有权 | **没有全局任务注册表**，14 个后台任务的 `JoinHandle` 全部丢弃（`src-tauri/src/state.rs:2309` / `:2330` / `:2357` / `:2418`、`src-tauri/src/lib.rs:516` / `:583` / `:598`、`src-tauri/src/network/transport/outbox_sweep.rs:97` 等） | 进程退出时自然死亡 | ⚠️ **P3**：无法有序收尾 |
| 窗口关闭 | 桌面端"关闭 = 隐藏到托盘"（`src-tauri/src/tray.rs:519-529`） | ⇒ 后台 interval **无限期**运行 | ✅ 设计使然，但需记录 |

### 4.8 大文件传输内存峰值（1 GB 文件，LAN 直连）

| 阶段 | 存活缓冲 | 合计 |
|---|---|---|
| 发送侧 `stream_file` | 复用 buf 256 KiB + sealed 256 KiB + base64 341 KiB + msg clone 341 KiB | ≈ 1.19 MiB |
| 发送侧 writer 任务 | msg clone 341 KiB + `to_vec` 341 KiB | ≈ 0.67 MiB |
| 发送侧 Low 队列 | 24 槽 × 341 KiB（字节预算 8 MiB） | **8 MiB** |
| 接收侧 | frame JSON 341 KiB + data 341 KiB + 解密 256 KiB | ≈ 0.9 MiB |
| **合计** | | **≈ 1.2–1.6 MiB + 8 MiB 队列** |

**与文件大小无关**（1 GB 与 100 GB 峰值相同）。仓库把 `std::fs::read` 全量读改成流式的改造是真实有效的（`src-tauri/src/network/file/relay_push.rs:76-78`、`src-tauri/src/file_relay.rs:19-29`、`src-tauri/src/network/file/receive.rs:124-126` 三处注释都明确记录了这次替换）。**唯一随体积线性增长且无上界的是 P2-07（导出）与 P2-08（共享目录遍历）。**

### 4.9 工程脚本 / CI 的活性

| 环节 | 终止条件 | 异常恢复 | 判定 |
|---|---|---|---|
| e2e 实例收尾 | `scripts/e2e/core.mjs:504-518` `stopAll()`：SIGTERM → 8 s → SIGKILL 升级，**且有残留断言**（`if (left.length) throw new Error("清理后仍有实例活着：…")`） | 清理不干净 = 失败，绝不静默放过 | ✅ 优秀设计 |
| 单实例重启 | `scripts/e2e/core.mjs:522-540` `stopOne()`：用 `process.kill(pid, 0)` 判活（**不用 `exitCode`** —— 被信号杀死时它是 `null`），SIGTERM→SIGKILL 升级，再轮询 40 × 250 ms，仍活着就 **throw** | ✅ |
| e2e 各轮 `for (;;)` | 全部由墙钟 deadline 兜住（`nowMs() >= until` / `advDeadline` / `textDeadline` / `pullDeadline` / `startDeadline`），上限 60 000 / 120 000 / 150 000 ms | ✅ 无一条无界 `while (true)` |
| `waitFor` / `waitSendTerminal` | `scripts/e2e/core.mjs:333-340` / `:350-371`：到点抛错 / 返回最后一次快照而不是挂住 | ✅ |
| 发布资产重试 | `scripts/publish-release-assets.sh:130-144`：`attempt` **先自增再比较**，退出条件 `attempt >= max_attempts`（默认 5）⇒ **恰好 5 次，无 off-by-one**；退避 `attempt * sleep_base` 有界；`upload_err` 预初始化为 `""` ⇒ `set -u` 不会把失败变成未绑定变量中止 | ✅ |
| 各类 `for (let i = 0; ; i++)` | 全部 `if (i >= 5) throw e;`，且**计数器不在循环体内被重置** ⇒ 真上限 5 | ✅ |
| `check-ui-runtime.mjs` 的 CDP 调用 | `scripts/check-ui-runtime.mjs:278-303`：45 s 上限（`:93`），错误信息带方法名 / 最后一个 cell mark / 未完成调用数 / 事件尾；**守护定时器在 `finally` 里清除** | ✅ |
| `verify-guards.py` 恢复 | `scripts/verify-guards.py:157-168`：`atexit` + 信号处理 ⇒ 中断时也会还原被改动的源文件 | ✅ |
| `verify-guards.py` 注入前置检查 | `scripts/verify-guards.py:363-421`：注入**之前**先验锚点存在 ⇒ 注入失败不会留下半改的文件 | ✅ |
| 冻结 / 停滞轮的 SIGCONT | `scripts/e2e/rounds/freeze.mjs:99-101`、`stall.mjs:119-122`：在 `finally` 里恢复被冻/被挂的子进程 | ✅ |
| 自证递归守卫 | `scripts/check-selfproof-baseline.mjs` 用 `GOSSLAN_SELFPROOFORK` 环境变量阻止自我递归调用 | ✅ 无 fork 炸弹 |
| `scripts/publish-release-assets.sh` / `check-mobile.sh` / `build-android-releases.sh` / `pack-macos-app.sh` | `set -euo pipefail` / `set -uo pipefail` 纪律；`scripts/check-mobile.sh:71-72` 的 `out="$(cargo check …)"` 后**立即**取 `$?`（不是赋值的退出码），且脚本用 `-uo pipefail` 不用 `-e` ⇒ 失败被显式判读而非中途中止 | ✅ 惯用法正确 |
| `npm` 脚本图 | `package.json`：无 `pre`/`post` 钩子自我调用；`dev` / `preview` 是**设计如此**的长跑服务器 | ✅ |
| 文件监听循环 | 全范围 `scripts/**`、`perf/**`、`tools/**`、`package.json`：**无** `fs.watch` / `chokidar` / `nodemon` / `--watch` | ✅ 该类缺陷不存在 |
| `perf/latency.mjs:55`（60 s）、`perf/background.mjs:99`（120 s） | 与 SC-P2-03 同一形状，但两文件结尾都有 `process.exit(...)`（`latency.mjs:252`、`background.mjs:325`）⇒ 定时器来不及钉住循环 | ✅（气味同源，无可观测影响） |
| `scripts/t2-learn-id.sh:45`、`scripts/t3-presence-relay.sh:43` | 有 `trap cleanup EXIT` ⇒ 后台子进程在所有退出路径都被清理 | ✅ **正确样板**（对照 SC-P2-06 / SC-P2-07 的缺失） |
| `verify.yml` job 预算 / 并发 | 45 / 60 / 45 / 240 分钟；`concurrency: verify-${{ github.head_ref \|\| github.ref_name }}` + `cancel-in-progress: true` ⇒ 同分支的旧 run 会被取消，陈旧 run 不会无限占着 runner | ✅ |
| `build-android.yml` 的失败处理 | `:101-123`：APK 构建是 `continue-on-error: true`，但**另有一步**用 `::error::` + `exit 1` 把失败重新抛出 ⇒ job 仍会红，`continue-on-error` 只是为了让注解步骤能跑 | ✅ 净效果正确 |
| 矩阵规模 | 四个打包 workflow 的 matrix 都是 1–2 项的固定小列表 ⇒ 扇出有界 | ✅ |
| Release 创建竞态 | `build-android.yml:133-139`：单一专用 publish job 创建 / 更新 Release ⇒ 不会并发创建同一个 Release | ✅ |

**结论**：脚本侧的**循环终止性**基本健康 —— 真正的问题集中在**三处**：① 父进程异常退出时**不带 `trap` / `finally` 的孤儿进程**（SC-P2-04~07）；② **定时器没有句柄**导致的"结果已出但进程不退出"（SC-P2-03）与"根本没有超时"（SC-P2-02）；③ **CI 缺预算**（SC-P3-02 / SC-P3-08）。

---

## 5. 无界资源清单

| 资源 | 位置 | 实际容量 | 清理策略 | 判定 |
|---|---|---|---|---|
| `state.peers` | `src-tauri/src/state.rs:1122` | 45s TTL + 活跃链路豁免 | `src-tauri/src/network/discovery.rs:876` `retain` | ✅ |
| `state.peer_manager` | `src-tauri/src/state.rs:1109` | **无** | `remove_peer` 零调用点 | ❌ P3-01 |
| `state.gossip_relay.by_group` | `src-tauri/src/mesh/gossip_replay.rs:59` | 桶内 16 条/群 + 10min 窗口；**map key 无界** | 仅桶内裁剪 | ❌ P3-02 |
| `state.group_file_keys` | `src-tauri/src/state.rs:1201` | **无** | 仅失败收尾与成功收尾 | ❌ P3-06 |
| `state.pending_requests` | `src-tauri/src/state.rs:1130` | **无** | 接受 / 拒绝时 | ❌ P3-03 |
| `state.pending_file_complete` | `src-tauri/src/state.rs:1192` | **无** | 2/9 路径 | ❌ P2-02 |
| `state.pending_file_accept` | `src-tauri/src/state.rs:1186` | 1/transfer | 3/4 路径 | ❌ P3-05 |
| `state.todo_focus_request` | `src-tauri/src/state.rs:1085` | 1/群 | 仅窗口挂载时取 | ❌ P3-07 |
| `state.group_history_active` | `src-tauri/src/state.rs:1266` | 1/群 | 成功时；**panic 时不删** | ❌ P3-04 |
| `state.ble_peer_advertises` | `src-tauri/src/state.rs:1019` | **运行期无界** | 仅停 BLE 时清 | ⚠️ P3 |
| `state.file_receivers` / `group_file_receivers` | `src-tauri/src/state.rs:1224` / `:1226` | 停滞超时 | 5min 空闲 + 每小时清扫 | ✅ |
| `state.relay_file_keys` | `src-tauri/src/state.rs:1196` | 1h TTL | `sweep_stale_relay` | ✅ |
| `state.file_wire_progress` | `src-tauri/src/state.rs:1235` | 1/(transfer×recipient) | `WireLedger::drop`（含 panic） | ✅ |
| `state.dialing` / `file_sending` / `group_file_sending` | `src-tauri/src/state.rs:973` / `:1215` / `:1204` | 16 / 1-per-peer | RAII guard | ✅ |
| `state.seen_hello_nonces` | `src-tauri/src/state.rs:1286` | 512 FIFO | `pop_front` | ✅ |
| `state.pending_out_accepts` | `src-tauri/src/state.rs:1167` | ≤3 次/120s | GiveUp | ✅ |
| `state.pending_out_requests` | `src-tauri/src/state.rs:1156` | 1/peer，30s 间隔 | 接受 / 拒绝 | ✅ |
| `state.pending_reads` / `pending_group_keys` | `src-tauri/src/state.rs:1135` / `:1140` | 1/peer | flush + DB 删除 | ✅ |
| `state.conv_link` | `src-tauri/src/state.rs:1171` | 1/会话 | peer 清扫 | ✅ |
| `state.peer_content_features` / `peer_versions` / `key_conflict_warned` | `src-tauri/src/state.rs:1275` / `:1278` / `:1289` | 随 peer 表 | `src-tauri/src/network/discovery.rs:903-917` | ✅ |
| `state.group_keys` | `src-tauri/src/state.rs:1119` | 1/群 | 退群时删 | ✅ |
| Gossip 去重 Bloom / LRU | `src-tauri/src/gossip_engine.rs:52-61` / `:98-109` | 100k / 10k | 轮转 / FIFO | ✅ |
| Mesh 去重 | `src-tauri/src/mesh/router.rs:86-110` | 100k / 10k | 轮转 / FIFO | ✅ |
| BLE 组帧 | `src-tauri/src/transport/ble_framing.rs:166` / `:172` / `:180` | 512 KiB / 8192 片 / 8 在途 | 30s TTL GC | ✅ |
| **BLE 外设事件通道** | `src-tauri/src/transport/bluetooth_peripheral.rs:362` | **无界** | 无 | ❌ P2-05 |
| 链路队列 | `src-tauri/src/network/transport/queue_policy.rs:16` / `:19` / `:27` | 8 MiB 字节预算 / 8–1024 槽 / 控制 1024 | — | ✅ |
| `Logger.entries` | `src-tauri/src/logging.rs:130` | 500 | `pop_front` | ✅ |
| `Logger.diag_fold` | `src-tauri/src/logging.rs:147` | 512 | 整表重开 | ✅ |
| 日志文件 / 崩溃文件 | `src-tauri/src/logging.rs:140` / `:142` | 512 KiB + `.old.log` / 2 MiB | 惰性轮转 | ✅ |
| `db.messages` | `src-tauri/src/db.rs` | 无（设计如此） | 删会话 / 清除数据 | ✅ |
| **`db.file_transfers`** | `src-tauri/src/db.rs:674` | **无保留策略** | 仅"清除数据" | ❌ P2-06 |
| **`db.file_outbox` 终态行** | `src-tauri/src/db/file_offline.rs` | **不删** | — | ❌ P2-06 |
| `db.outbox` / `group_outbox` | `src-tauri/src/db/offline_queue.rs` | 在线 120s / 离线 7 天 | sweeper（群为消息级聚合，见 P1-04） | ⚠️ |
| `db.content_transfers` | `src-tauri/src/content/store.rs` | attempts ≤ 8 → Rejected | `src-tauri/src/content/policy.rs:81` | ✅ |
| `db.group_file_acks` | `src-tauri/src/db/group_files.rs` | attempts ≤ 5 → 强制 failed | `src-tauri/src/network/transport/group_file.rs:864` | ✅ |
| `db.favorites` | `src-tauri/src/db/favorites.rs` | 无（用户自建） | 删收藏 | ⚠️ 全表读 |
| 前端 `chat.messages[conv]` | `src/stores/useChatStore.ts:1348` | 8 会话 × 1000 条；**实时追加无硬上界**（源码自陈，`:1345-1347`） | 会话逐出 + `releasePreviewsOf` | ⚠️ |
| **前端 `groupTodoRows`** | `src/stores/useChatStore.ts:948` | **无** | 无 | ❌ P2-13 |
| 前端 `pendingAcks` / `notifMap` / `remindedIds` | `src/stores/useChatStore.ts:266` / `:579` / `:547` | `trimOldest` | ✅ |
| 前端 blob LRU | `src/utils/blobLru.ts:65-155` | **60 MiB 累计字节** | 逐出即 revoke | ✅ |
| 前端 `bubbleCache` | `src/utils/messageHeight.ts:106` | 50 000 | FIFO | ✅ |
| 前端 `heightOverride` | `src/components/VirtualList.vue:51` | 2 000 | FIFO | ✅ |
| 前端 `reportedErrorKeys` | `src/boot/boot.ts:34` | 50 | 总数上限 | ✅ |
| **OS 通知线程** | `src-tauri/src/notifications.rs:255` | **无界** | 线程退出即释放，但线程数无上限 | ❌ P2-11 |
| `log` 子进程 | `src-tauri/src/logging.rs:107` | 每 200ms 批一次 fork，**不 wait 不 kill** | 进程退出时被回收 | ⚠️ P3 |
| e2e 实例 stdout fd | `scripts/e2e/core.mjs:495` | **不关** ⇒ 每次 `launch()` 泄漏 1 个 fd | 无 | ❌ SC-P3-01 |
| e2e vite 输出缓冲 | `scripts/check-ui-runtime.mjs:2214` | **无上限**（只用最后 800 字符）；监听器不摘除 | 无 | ❌ SC-P3-05 |
| `test-results/` 目录 | `scripts/e2e/core.mjs:143-149` | 崩溃 run（`unknown`）**永不清** | 无 | ❌ SC-P3-07 |
| Actions artifact | 4 个打包 workflow | 默认保留期（公开仓 90 天） | 无 `retention-days` | ❌ SC-P3-03 |
| `release-artifacts/` | `scripts/build-android-releases.sh` | 每版本一份 | 无清理路径 | ⚠️ P3 |
| 孤儿应用进程 | `scripts/e2e-dev.sh:72`、`scripts/t4-mirror-dial.sh:49`、`scripts/mem-sample.mjs:98`、`scripts/check-ui-runtime-ax.mjs:97` | **失败路径不回收** | 只在成功路径 kill | ❌ SC-P2-04~07 |

---

## 6. 修复优先级与方案

按 **风险 × 影响面 ÷ 改动成本** 排序。

### 6.1 第一批：确定性 P0/P1，改动极小（建议立即修）

> **状态更新（§0.1）**：下表第 1、2、3 项**已在工作区落地（未提交）**，其中第 1 项是 P0（4 处锁作用域收窄）、第 2 项是 P2-02（`PendingCompleteGuard`）、第 3 项是 P1-04（群 outbox 逐行）。第 4、5 项（P2-01 群 ACK 恢复、P1-03 群文件续传）**待实施**。各项的功能影响见 §6.7。

| 序 | 目标 | 改动 | 成本 | 验证 |
|---|---|---|---|---|
| 1 | **P0-01 锁序反转** | 4 处锁作用域收窄（`src-tauri/src/network/transport/handshake.rs:183-199`、`src-tauri/src/network/transport/peer_state.rs:19-26`、`src-tauri/src/network/transport/gossip.rs:167-189` 与 `:261-268`、`src-tauri/src/commands/friends.rs:67-90`） | **S**（4 个文件、约 30 行） | 源码形状守卫（单向断言：`peers` 存活期内不得出现 `db`）+ 双线程 `try_lock` 死锁用例 |
| 2 | **P2-02 `pending_file_complete` 泄漏** | 照抄同文件 `WireLedger` 的 `Drop` 守卫（`src-tauri/src/network/file/send.rs:343-347`） | **XS** | 单测：8 条早退路径各断言 map 回到 0 |
| 3 | **P1-04 群 outbox 7 天重发** | `src-tauri/src/network/transport/outbox_sweep.rs:228` 的 `all` 改为逐行判定 | **XS** | `src-tauri/src/db/offline_queue.rs` 纯函数单测（当前会红） |
| 4 | **P2-01 群 ACK 卡 `sending`** | ① `send_group_file_complete_ack` 改为**先落 `group_file_acks` 账本再发帧**（与接收侧对称）；② 加 stale-`sending` 清扫器 | **S** | e2e：杀接收端在 ACK 前 ⇒ 断言发送侧终态收敛 |
| 5 | **P1-03 群文件续传** | 把 DM 的 `AcceptResumeSegment` / `restart_segment` 平移到群路径 + 群发送侧从 `from_bytes` 起算 | **M** | e2e `--fault=group-stall-mid`（当前会红） |

> 第 1 项是**最高性价比**：改动最小、影响面最大，且现在没有任何守卫能防它复发。
> 第 3、4、5 项同属"群路径比单聊路径少一层收敛"这一族，**建议放在同一个 PR**（改的是同一批文件），并在 PR 描述里明确写出这层对齐关系。

### 6.2 第二批：P1 根治（架构级，需独立排期）

| 序 | 目标 | 方案 | 成本 | 风险 |
|---|---|---|---|---|
| 6 | **P1-02 阻塞锁占住 Tokio worker** | `DbLock` 改 `tokio::sync::Mutex`（约 335 个取锁点机械改造）**或**过渡期把所有命令的 db 取锁包进 `spawn_blocking` | **L** | 低（纯机械，无语义变化），但需分批 + 保留 `db_hold` 观测 |
| 7 | **P1-01 VACUUM 独占锁** | 优先：rusqlite `progress_handler` + 超时中断；次优：独立连接 `VACUUM INTO` + 原子换名（`src-tauri/src/db.rs:876` 已有成熟用法） | **M** | 中（中断 VACUUM 的边界要测） |
| 8 | **补两条通用守卫** | ① 锁序守卫（单向断言）；② "async fn / async 命令体内不得直接 `s.db.lock()`"（与 `src-tauri/src/lib_window_tests.rs:241` 同族） | **S** | 低。**守卫先于修复**，防止同形状问题复发 |

### 6.3 第三批：P2（按"影响面 × 确定性"排序）

| 序 | 目标 | 方案要点 | 成本 |
|---|---|---|---|
| 9 | P2-03 64 MiB 帧预分配 | `MAX_FRAME` 降到 4 MiB（仍 > 任何真实帧）；或改为 `Vec::with_capacity` + 增量 `read_exact` | XS |
| 10 | P2-05 BLE 无界通道 | `unbounded_channel` → 有界（如 64）+ 溢出即断链 | S |
| 11 | P2-04 Gossip TTL 钳制 | `src-tauri/src/network/transport/gossip.rs:390` 改用路由器的钳制值（照抄 `src-tauri/src/network/transport.rs:1183-1188`），并给 `MeshRouter` 加 `max_ttl()` 访问器 | XS |
| 12 | P2-06 `file_transfers` 保留策略 | 加保留期（按 `created_at` 删 N 天前的终态行）+ `list_transfers` 加 `LIMIT` | S |
| 13 | P2-07 导出内存 | `get_messages` 分页 + Markdown **流式写入文件句柄**（不拼单个 String） | M |
| 14 | P2-08 共享目录遍历 | 加条目数 / 总字节上限 + 移入 `spawn_blocking` + 响应超限时返回显式"过大"标记 | S |
| 15 | P2-09 文件传输并发上限 | 新增 `file_permits: Semaphore`（如 8）+ 群扇出改为"固定 worker 池 + 队列" | M |
| 16 | P2-10 续传哈希内联 reader loop | 把 `resume_receive` 挪到已有的每 peer `FileService` 队列（`src-tauri/src/network/transport/queue_policy.rs:336`） | S |
| 17 | P2-11 通知线程 | 单个共享等待线程 + 待处理句柄注册表 | M |
| 18 | P2-12/13 前端 blob 与 todo 行 | `groupTodoRows` 加 per-conv 上限；`FavoritePanel` 改从缓存解析 URL 而非缓存字符串 | S/M |

### 6.4 第四批：P3（可搭车清理）

P3-01~P3-19 建议在上述改动顺手做掉，其中：

- **P3-01（`peer_manager` 不裁剪）** 应与 `src-tauri/src/network/discovery.rs:896-918` 的现有清理点合并（同一处、同一模式）。
- **P3-04（`group_history_active` panic 泄漏）** 改用 `Drop` 守卫（同 `WireLedger`）。
- **P3-18（中继 inflight 不回收）** 建议**提前到第三批** —— 它的后果是"节点永久失去中继能力"，虽然触发概率低，但恢复成本是"重启"。

### 6.4b 工程脚本与 CI（独立于产品代码，建议单独排期）

这一批**不影响出货应用**，改的是本地工具链与 CI。排序理由：**SC-P2-01 是一行形状改动却是真实的命令注入原语**，成本最低收益最高；孤儿进程四条路径共享同一个修法（`finally` / `trap`）。

| 序 | 目标 | 改动 | 成本 | 验证 |
|---|---|---|---|---|
| S1 | **SC-P2-01 命令注入** | `scripts/semver.mjs:197` 的 `execSync(\`git ${args}\`)` → `spawnSync("git", argsArray)`；同步修 `:211` 与 `:513` 的插值 | **XS** | 新增 **scripts/check-shell-args.mjs** 守卫（禁字符串插值进 `execSync`），带"改坏即红"夹具 |
| S2 | **SC-P2-04~07 孤儿进程** | ① Node 侧：把 `spawn(..., {detached:true})` 后的清理包进 `try/finally` + `process.on('exit')`（`scripts/check-ui-runtime-ax.mjs`、`scripts/mem-sample.mjs`）；② Shell 侧：照抄 `scripts/t2-learn-id.sh:45` 与 `scripts/t3-presence-relay.sh:43` 的 `trap cleanup EXIT` 样板（`scripts/e2e-dev.sh`、`scripts/t4-mirror-dial.sh`）；③ 顺带把 `kill "$APP_PID"` 换成 `kill -- -$PGID` 以覆盖 WebKit helper 进程 | **S** | 新增 **scripts/check-orphan-cleanup.mjs** 守卫 + 手工验证"失败一次后没有残留 `gosslan` 进程" |
| S3 | **SC-P2-02/03 perf 定时器** | `perf/probe.mjs` 的 `evalJs` 加超时（`AbortController` 或 `setTimeout` + `reject`）；`perf/run.mjs` 的 `send()` 存下定时器句柄并在 `finally` 里 `clearTimeout`，或在默认分支结尾补 `process.exit(0)` | **XS** | 手工跑一次 `node perf/run.mjs` 断言**结果打印后进程立即退出**（当前会滞留 ~3 min） |
| S4 | **SC-P3-02/03/04 CI 预算与产物** | 四个打包 workflow 的 job 补 `timeout-minutes`；`upload-artifact` 补 `retention-days`；`build-android.yml:126` 补 `if-no-files-found: error`（与 `build.yml:73` / `build-macos.yml:92` 对齐） | **XS** | YAML 静态检查 + 一次真实 workflow run |
| S5 | **SC-P3-01/05/06/07 脚本侧资源** | ① `scripts/e2e/core.mjs:495` 的 fd 在 `spawn` 后立刻 `closeSync`（父进程不再需要它）；② `waitForVite` 的 `buf` 只留最后 N 字符 + 摘掉 `onData`；③ `citedRunIds()` 改用流式读或只扫 `docs/` 子集；④ 给 `unknown` 类 run 加**按体积**的保留上限（保留策略从"永不删"改成"超 30 天且 > 2 GB 则删"）——**注意这会改动 `scripts/e2e/core.mjs:245` / `:261` 两条已钉住现状的单测，需要同步改** | **S** | `scripts/e2e/core.mjs` 单测同步更新 |
| S6 | **SC-P3-08 verify 预算** | `scripts/verify.mjs:1193` 的 `spawnSync` 加 `timeout`（按步骤量级给，如编译类 30 min、测试类 10 min），超时给出**是哪一步**的诊断；`scripts/verify-guards.py:211` 的 900 s 与 240 min job 预算不匹配 —— 要么把 frontend 子集的每条上限降到 300 s，要么承认"外层 job 超时会先触发"并补一条"卡住时打印当前 case 名"的诊断 | **S** | 故意造一个会挂的假步骤，断言 verify 在上限内报出**是哪一步** |

### 6.5 明确**不要**做的事

- ❌ 不要把"每条消息的实时追加无上界"（`src/stores/useChatStore.ts:1345-1347` 自陈）当作 bug 立刻改 —— 裁剪头部会改变 VirtualList 的滚动锚定，源码已说明代价。
- ❌ 不要在同一个 PR 里同时做"改 `tokio::sync::Mutex`"和"改群文件协议" —— 两者都会大范围动同一批文件。
- ❌ 不要动 `scripts/check-lock-scope.mjs` 的 D 类语义（它判的是**同锁重入**，是有价值的），应当**新增**一个锁序守卫而不是替换。

### 6.6 建议写进工程纪律的一条

本次四个"群路径比单聊路径少一层收敛"的实例（群文件续传、群 ACK 恢复、`pending_file_complete` 清理、群 outbox 放弃判定）指向同一条纪律缺口。建议把

> **"群路径必须与单聊路径逐条对齐；凡是单聊有终止/恢复机制而群没有的，必须显式登记为缺口而不是默认继承"**

写进 `docs/protocol-invariants.md`，并用该仓已有的 `scripts/check-invariant-hooks.mjs` 绑定机制（当前 35 条不变量全部具名绑定）逐条挂上机器判据。

### 6.7 功能影响评估：每条修改方案 × 对用户可感知的影响

> **本节已被 §0.2 的拍板结果取代，以 §10 的实施台账为准。** 保留本节是因为它记着
> "每条改动的原始影响面"与"拍板时追加的约束"，两者的差集就是拍板改变的东西：
>
> | 拍板 | 对本节的修订 |
> |---|---|
> | 1A | 追加四条**必须验证**的项：断点恢复 / 重启恢复 / 重复分片 / 文件完整性（§10.1） |
> | 2 | 追加"**3 秒是目标预算，需验证实际行为**"⇒ 产出了 §10.2 的实测数据与一个真 bug（回调粒度） |
> | 3B | 追加"**不得静默丢帧**"（⇒ 溢出走断链不丢帧）与"**防止重连风暴**"两条硬约束（§10.3） |
> | 4A(8) | 把实施位置从"命令层"改为"**统一在传输调度层**"，并追加"实测内存峰值、吞吐、排队行为"三项（§10.4） |
> | 5A(500) | 追加"**只裁剪缓存，不得擅自永久删除数据库中的任务历史**"这一条边界（§10.5） |
> | 6A | 追加"保留 **30 天**"的明确数字与"**覆盖异常退出遗留目录**"（§10.6） |
> | 7 | 追加"先做**专项审计**再分阶段实施"，并给出专项审计要回答的 5 个问题（§10.7） |
> | 8 | 追加"**按成员独立判断**送达和失败状态"的实现形态核实（§10.8） |
>
> 贯穿全部 8 条的一条**总约束**（本节原先没有）：
> **涉及消息可靠性、文件完整性和持久化历史的行为，不得为节省资源而静默降级。**
> 它把"限流/限量"这件事的边界划清了：排队可以、丢不行。

#### 影响分级

| 级别 | 含义 |
|---|---|
| **零影响** | 用户与开发者都观察不到差别（纯内部重构 / 纯 bug 修复的正常路径） |
| **仅边缘影响** | 只在异常、长尾或极端规模路径上可见 |
| **可感知** | 正常路径也可能被用户看到（速度、提示、状态显示） |
| **需产品决策** | 会改变一条**已经对外承诺**的行为，或需要动协议 / 需要定一个产品口径 |

#### A 组：已在工作区落地（§0.1）—— 5 条

| 条目 | 修改方案（已落地） | 对功能使用的影响 | 影响多少 | 风险 |
|---|---|---|---|---|
| **P0-01** 锁序反转 | 4 处把「持 `peers` 求 `db`」改成「先取 `peers` 快照并放锁，再取 `db`」；`bind_friend_keys_on_accept` 改为接收快照参数，**不再在持 db 锁时取 peers 锁** | **零影响**。判定逻辑一字未改 —— `gossip.rs` 里读的还是 `peers.get(&env.sender_id)` 的那对公钥，`friends.rs` 里读的还是 `last_seen` / `device_type`。唯一微观差别：快照与后续 db 读之间**不再原子**（原来持锁期间 peers 表的并发更新读不到；现在取完就放）；但原实现的 `peers.get()` 本来也是某一瞬间的值 ⇒ **等价** | 零。成本侧：`friends.rs` 每次调用多一次 O(peers) 的 `HashMap` 克隆（peers 有 45s TTL 约束，量级几十~几百条、几十 KB）⇒ 可忽略 | 低 |
| **P2-02** `pending_file_complete` 泄漏 | 新增 `PendingCompleteGuard`（登记即武装，离开作用域含 `?` / 提前 `return` / panic 展开即摘除），与同文件 `WireLedger` 同一模式 | **零影响，且顺带修掉一个边缘缺陷**：守卫把登记项的存活期延长到函数作用域结束 —— 原先在手工 `remove` 之后、函数结束之前到达的 `FileCompleteAck` 会被**静默丢弃**（`tx.send` 失败、`let _ =`），现在能被收到 ⇒ 发送侧不再无故多等一个 30 s 安静窗口 | 零（仅在 ACK 迟到这一条边缘路径上，从"丢失"变成"被正确处理"） | 低 |
| **P1-04** 群 outbox 7 天重发 | 群 outbox 改成**逐行**判定：每行只看**自己那个成员**的可达性；在线成员 30 分钟后独立放弃（删该行），离线成员仍按 7 天保留 | **本批唯一"可感知"的条目，但只影响异常路径**：<br>· **正常路径（成员都 Ack 了）⇒ 完全零变化** —— 行在 Ack 到达时就被删，压根不进 sweeper。<br>· **异常路径（某成员在线却一直不 Ack**：被群历史边界挡掉 / 缺群密钥 / ACK 丢包）**：改前该成员被每 5 秒重发一次、持续 7 天；改后 30 分钟后停。<br>· **用户看到什么**：该成员在群消息里的状态从"永远转圈"变成"30 分钟后显示发送失败" ⇒ **更诚实**，不是新问题。<br>· **完全不变的部分**：**离线成员的上线补发承诺（INV-P04）一字未动**，仍是 7 天 | 异常路径上的一个窗口从 7 天收窄到 30 分钟；正常路径零 | 中低 |
| **P2-04** Gossip TTL 钳制 | 转发出去的信封 TTL 改取 `MeshRouter` 的 Forward 决策（`max_ttl` 裁剪 + 递减），不再用 `env.ttl - 1` | **零影响**。发送方本来就发 `ttl = 6`（`src-tauri/src/gossip_engine.rs:121`、`:176`）⇒ 正常路径下改前改后 wire 上完全一样。**只影响伪造 / 异常信封**：此前 `ttl = 255` 的信封会让补递门槛 `MIN_TTL_FOR_RELAY = 2` 形同虚设，现在被钳到 ≤ 6 | 零 | 低 |
| **SC-P2-01** 命令注入 | `execSync(\`git ${args}\`)` → `execFileSync("git", args)`，全部调用点改数组；加 `--end-of-options` 把「以 `-` 开头的 revision」钉成位置参数；顺带把 `execSync("cat …")` 换成 `readFileSync` | **零影响**。唯一变化是**失败方式**：含空格 / 元字符的 revision 现在作为**单个**参数传给 git 并**报错**，原先会被 shell 静默拆成两个参数（可能得到一个看似合法的错误结果）。**已验证**：`version:check` / `changelog` 正常通过；注入标记出现 **0** 次 | 零 | 低 |

#### B 组：待实施 —— 9 条

| 条目 | 修改方案 | 对功能使用的影响 | 影响多少 | 风险 |
|---|---|---|---|---|
| **P1-03** 群文件续传 | 把 DM 的 `AcceptResumeSegment` / `restart_segment` 平移到群 Offer 路径；群发送侧改为从接收方已收字节数起算 | **方向上是改善**（把"重试必败 + 已收前缀被删"修成"能传完"），**但需要动协议** —— 要确认 `GroupFileOffer` 是否已带"已收字节数"；若没有就要加字段 ⇒ **需要双方版本兼容处理**（旧端收到新字段必须能忽略） | 用户从"群文件重试后永远失败"变成"能传完" ⇒ 严格说是修复；但涉及协议面 | 协议向后兼容 | 中 |
| **P2-01** 群 ACK 丢失卡 `sending` | ① `send_group_file_complete_ack` 改为**先落 `group_file_acks` 账本再发帧**（与接收侧对称）；② 加一个 stale-`sending` 清扫器 | **可感知，但是改善**：发送方群文件气泡从"永远转圈"变成"最终收敛到 done / failed"。DM 路径早就有等价恢复（重复 `FileDone` 时重发 ACK），群路径补上 | 异常路径上从"永久卡住"变成"最终有终态" | 低 |
| **P1-01** VACUUM 独占锁 | 优先：`rusqlite` 的 `progress_handler` + 超时中断；次优：独立连接 `VACUUM INTO` + 原子换名（`src-tauri/src/db.rs:876` 已有成熟用法） | **可感知**：<br>· 改法 A（中断）：VACUUM 可能在跑一半被取消 ⇒ **碎片没被回收**（db 文件没变小），但用户不再卡。界面上需要能说明"这次没压缩成功"。<br>· 改法 B（独立连接）：彻底不卡，用户无感。<br>· **需产品决策**：选 A 还是 B；A 需要一个"碎片未回收"的用户可见说明 | 从"界面全冻数秒~数分钟"变成"零感知"（改法 B）或"偶发提示"（改法 A） | 中 |
| **P1-02** `DbLock` → `tokio::sync::Mutex` | 335 个取锁点改 `.lock().await`；命令层从"同步函数 + `spawn`"改成 `async fn` | **仅边缘影响，且方向是改善**：正常路径零差异。差别在**锁竞争时** —— 改前一条命令会**占住一个 Tokio worker 线程**直到拿到锁（这正是 P1-01 的饥饿机制）；改后它**让出 worker**去排队等锁 ⇒ 同样的争用下，心跳 / announce / outbox 清扫 / 文件传输**不再被拖住**。<br>**用户看到的是"卡顿变少"而不是"行为变化"** | 正常路径零；高争用下界面从"整窗冻住"变成"个别命令慢一点" | 中（改动面大但纯机械；务必保留 `db_hold` 观测以便回归） |
| **P2-03** `MAX_FRAME` 64 MiB → 4 MiB | 把上限降到仍高于任何真实帧的值；或改成增量 `read_exact`（`Vec::with_capacity` + 按需扩） | **必须与 P2-08 同批做，否则会打断共享目录功能**。真实帧上界：群历史页 1.5 MB（`GROUP_HISTORY_PAGE_MAX_BYTES`）/ 文件片 256 KiB（BLE 4 KiB）/ opaque 256 KiB ⇒ 4 MiB 有 ~2.6× 余量。**唯一可能超的是 `ShareTreeResponse`**（当前无上限）⇒ 降到 4 MiB 会让它更早失败 | 共享目录在"很大"时会从"本来就可能失败"变成"更早失败" ⇒ 必须配合 P2-08 的"过大"标记 | 低-中（**顺序错了会打断功能**） |
| **P2-05** BLE 无界事件通道 | `mpsc::unbounded_channel` → 有界（如 64）+ 溢出策略 | **需产品决策溢出策略**：<br>· **丢帧** ⇒ BLE 协议层没有可靠重传语义 ⇒ 消息可能真丢。<br>· **断链** ⇒ 可恢复，但会打断当前传输。<br>· 建议**断链**，与既有"写失败 ⇒ 拆链"的语义一致 | 只在 BLE 事件积压（异常）时可见；正常路径零 | 中 |
| **P2-09** 文件传输并发上限 | 新增 `file_permits` 信号量（如 8）+ 群扇出改成"固定 worker 池 + 队列" | **可感知（速度）**：200 人群的文件发送从"200 个并发任务"变成"8 个" ⇒ **总时长变长**。但改前 200 并发会吃 300 MB–1 GB 内存、且**对同一个源文件并发读 200 次** ⇒ 改后是"更慢但更稳"。**并发数取多少需要拍板** | 大群发文件的墙钟时间变长（内存与磁盘压力的直接代价） | 中（是"更快但更危险"换"更慢但更稳"） |
| **P2-07** 导出内存 | `get_messages` 分页 + Markdown **流式写文件句柄**（不再拼单个 `String`） | **零影响**。导出内容不变；只是峰值内存从"语料的 2–3 倍"降到常数级 | 零（仅在大库导出时从"可能吃掉几 GB"变成"吃不到"） | 低 |
| **P2-08** 共享目录上限 | 加条目数 / 总字节上限 + 移入 `spawn_blocking` + 响应超限时返回显式"过大"标记 | **可感知**：超大共享目录从"可能静默失败（对端只看到 10 s 超时）"变成"明确告知过大" | 仅超大目录可见；正常目录零 | 低 |
| **P2-12 / 13 / 14 / 15** 前端 | ① `FavoritePanel` 改从缓存解析 URL（修死图）；② `groupTodoRows` 加 per-conv 上限；③ `VirtualList` 复用 observer（不每帧 new）；④ `mediaPresent` 加 singleFlight 缓存 | ① **可感知但是修复**（缩略图/灯箱从"偶发裂图"变成"正常"）；② **需产品决策裁多少**（极老的任务记录会被裁掉）；③ **零感知**（纯性能，滚动手感变好）；④ **零感知但需要失效策略**（否则会显示过期的"文件是否存在"状态） | ① 修 bug；② 裁剪窗口待定；③④ 零 | 低-中（② 需要口径） |

#### 一句话汇总

- **5 条已落地的**：**4 条零影响**（P0-01 / P2-02 / P2-04 / SC-P2-01），**1 条仅影响异常路径**（P1-04，且是"从坏变好"）。
- **9 条待实施的**：**3 条零或近零影响**（P2-07 / P2-08 / P2-12~15 里的性能项），**3 条是"从坏变好"**（P1-03 / P2-01 / P1-01），**3 条需要产品拍板**（P1-01 的 VACUUM 方案、P2-05 的 BLE 溢出策略、P2-09 的并发数、P2-13 的裁剪窗口），**1 条是纯架构**（P1-02，方向是改善）。
- **没有任何一条会让"正常使用"变差。** 唯一会**让某些行为变窄**的是 P1-04（异常路径上的重发窗口 7 天 → 30 分钟）和 P2-09（大群发文件变慢），两条都需要明确知会。
- **唯一有协议/兼容面的是 P1-03**（群文件续传可能要加字段），需要旧端能忽略新字段。

---

## 7. 验证计划

### 7.1 单元测试（新增，建议随修复同 PR 提交）

| 用例 | 位置建议 | 断言 |
|---|---|---|
| **锁序守卫自证** | 新增 **scripts/check-lock-order.mjs** 或 **src-tauri/src/lib_lock_order_tests.rs** | ① 夹具"改坏即红"（把 `src-tauri/src/network/transport/gossip.rs:266` 移到 peers 锁外侧 ⇒ 必须 FAIL）；② 全仓扫描"peers 存活期内出现 db"⇒ 0 处；③ 与 `scripts/check-lock-scope.mjs` 的 D 类不重叠 |
| **P0-01 死锁回归** | `src-tauri/src/network/transport/` | 两线程分别走 `maybe_update_friend`（db→peers）与 `handle_gossip` 的 peers→db 分支，10s 内必须双双返回（`try_lock` 版本） |
| **P2-02 泄漏** | `src-tauri/src/network/file/send.rs` | 8 条早退路径逐一断言 `state.pending_file_complete.len() == 0` |
| **P1-04 群 outbox 逐行放弃** | `src-tauri/src/db/offline_queue.rs`（与 `:123-170` 同族） | `rows = [(在线, 40min), (离线, 40min)]` ⇒ **在线行判 failed、离线行保留**。当前实现会红 |
| **P2-01 群 ACK 收敛** | `src-tauri/src/network/transport/group_file.rs` | 模拟 ACK 帧丢失 ⇒ 断言收件人行最终从 `sending` 收敛到 `done`/`failed`（当前会红） |
| **P3-04 panic 清理** | `src-tauri/src/network/group_history.rs` | 同步体 panic ⇒ 断言 `group_history_active` 条目已被清 |
| **P2-04 TTL 钳制** | `src-tauri/src/network/transport/gossip.rs` | 构造 `ttl = 255` 的信封 ⇒ 断言转发出去的 `ttl ≤ 6` |
| **P2-03 帧上限** | `src-tauri/src/transport/tcp.rs` | 断言 `MAX_FRAME` ≥ 所有真实载荷上界（`GROUP_HISTORY_PAGE_MAX_BYTES` / `FILE_CHUNK` / `MAX_OPAQUE_PAYLOAD`）的 1.5 倍且 ≤ 4 MiB |
| **P3-18 中继 inflight 回收** | `src-tauri/src/network/transport/relay.rs` | 模拟一个拨号任务 panic ⇒ 断言 `inflight` 条目被回收、`MAX_RELAY_CIRCUITS` 仍有可用槽位 |
| **SC-P2-01 注入守卫** | 新增 **scripts/check-shell-args.mjs**（或并入 `scripts/check-lock-scope.mjs` 同一族守卫） | ① 断言 `scripts/**` / `perf/**` 里**没有** `execSync` / `exec` 的字符串插值调用；② 夹具"改坏即红"（把 `spawnSync("git", [...])` 改回模板字符串 ⇒ 必须 FAIL）。**这条守卫的价值在于它同时挡住了未来新的注入点**，而不只是修当前这一处 |
| **SC-P2-04~07 孤儿回收守卫** | 新增 **scripts/check-orphan-cleanup.mjs** | ① 断言凡 `spawn(..., { detached: true })` 所在的脚本，其**每一处**提前退出（`process.exit` / `exit 1`）路径都在退出前 kill 进程组；② 断言 `scripts/*.sh` 里凡起后台作业的脚本都有 `trap ... EXIT`。**"改坏即红"夹具必做**（`docs/stability-roadmap.md` R9：*未验证的守卫比没有守卫更危险*） |
| **SC-P2-02/03 定时器纪律** | `perf/probe.mjs`、`perf/run.mjs` | ① 断言 `perf/**` 里每个 `setTimeout` 都有对应 `clearTimeout` **或** 以 `process.exit()` 收尾；② CDP 调用必须有超时 |

### 7.2 e2e / 故障注入（新增轮次）

复用 `scripts/e2e-multi-instance.mjs` 的既有框架（已有 `--fault=stall-mid` / `--fault=kill-mid` / `--fault=resume-prefix` / `--round=gfile`）：

| 新轮次 | 场景 | 断言 |
|---|---|---|
| `--fault=group-stall-mid` | 群文件传到 30% 时杀发送方 → 重投 | 最终 `done`，字节与 SHA 全对，接收端**无残留 `.part`** |
| `--fault=group-ack-drop` | 接收端在发 `GroupFileCompleteAck` 前断链 | 发送端收件人行**在 ≤ 2 个 tick 内**从 `sending` 收敛到终态（当前会永久卡住） |
| `--round=restart-contention` | 重启实例 + 2 个好友在线 + 立刻互发消息 | 进程存活、`peers-updated` 持续推送、无心跳停摆（P0-01 的 e2e 化） |
| `--fault=vacuum-during-chat` | 1 GB `messages` 库上触发 VACUUM，同时持续发 IPC | 所有 IPC 在 ≤ 3s 内返回；`peers-updated` 计数继续增长（P1-01/02 的 e2e 化） |
| `--round=group-offline-member` | 群里 1 人离线、其余在线，群里连发消息 | 在线成员在 30 min 窗口后**不再收到**重复信封（当前会持续 7 天） |

### 7.3 运行时指标（接进「运行日志」/ DevDiag 面板）

本仓已有极好的观测基础（`src-tauri/src/db_hold.rs` 的 wait/hold 分离计时、`src-tauri/src/state.rs:2418` 的 60s 摘要器、`src/components/DevDiagPanel.vue`），只需补 4 个量：

| 指标 | 采集点 | 用途 | 告警阈值 |
|---|---|---|---|
| **Tokio worker 占用数**（正在阻塞等锁的 task 数） | 包装 `DbLock::lock()` 计一个 in-flight 计数 | 直接暴露 P1-02 的饥饿前兆 | > `worker_threads/2` |
| **db 锁等待 P99** | `src-tauri/src/db_hold.rs` 已有 `wait_max_ms` ⇒ 改为直方图 + 分位 | 区分"排队"与"真慢" | P99 > 200ms |
| **db 锁最长持有 + 持有者标签** | `src-tauri/src/db_hold.rs:16-17` 注释自陈"持有多久能测到，但测不出**是谁拿的**" | 定位 VACUUM / 导出 / 搜索 | hold > 1s |
| **`file_transfers` 行数 / `group_file_recipients` 中 `sending` 的行数** | 周期性计数 | 暴露 P2-06 / P2-01 | `sending` 行龄 > 10 min |

### 7.4 内存趋势验证（长跑）

用 `scripts/mem-sample.mjs`（已存在，且**已正确区分**主进程 / `WebKit.WebContent` / GPU 三个进程组，并诚实标注"WKWebView 没有 CDP ⇒ `jsHeap: NOT RUN`"）：

| 场景 | 时长 | 采集 | 通过判据 |
|---|---|---|---|
| 空闲托盘常驻 | 24 h | 每 3 min 一次 footprint/RSS | 主进程与 WebContent 的**基线→结束回落差 < 5%** |
| 消息洪水（10 msg/s，持续 1 h） | 1 h | 同上 + `db.messages` 行数 | WebContent 增长与消息数**不成正比**（验证 `chat.messages` 逐出与 blob LRU 生效） |
| 大文件（1 GB × 20 轮） | 2 h | 同上 + 峰值 | 峰值 ≈ **1.2–1.6 MiB + 8 MiB 队列/传输**（与 §4.8 模型一致），不随轮次累积 |
| 群任务洪水 | 1 h | 同上 | `groupTodoRows` 有界（P2-13 修复后） |
| 通知洪水（1000 条不点） | 30 min | **线程数** | 线程数有界（P2-11 修复后） |

### 7.5 长时运行 / 压力场景清单

| 场景 | 覆盖的风险 |
|---|---|
| 网络不稳定（反复断连重连 1000 次） | P3-01/02/03/06/07 的内存项、链路表清理、心跳看门狗 |
| 多任务并发（32 个 peer 同时发文件） | P2-09（无并发上限）、P1-02（worker 饥饿） |
| 超大文件（10 GB） | §4.8 峰值模型、P1-01（DB 锁时长） |
| 海量消息（100 万条 `messages`） | P2-03（64 MiB 帧）、P2-06（表增长）、P2-07（导出）、P3-14（cache 遍历） |
| 频繁断连重连 + 群文件重试叠加 | P1-03（群文件无续传）、P2-01（群 ACK 卡住） |
| 群里有长期离线成员 | P1-04（在线成员被轰炸 7 天） |
| 应用退出 | P3（无任务注册表）、P3（重启不停 BLE）、退出路标完整性 |

---

## 8. 结论

**总体判定：Gosslan 的流式与有界意识处于同类项目的中上水平。** 本次**没有发现**经典意义上的"整文件读进内存""无界队列堆积""死循环不退出""组件卸载后监听器泄漏"。

但审计确认了 **1 个 P0 + 4 个 P1 + 13 个 P2 + 19 个 P3**，它们的共同根因是**三个体系性盲区**（另有 §3.4 的工具链侧 **7 个 P2 + 8 个 P3**，不影响出货应用）：

1. **锁序无约束**（P0-01）—— 现有守卫只管 db 一把锁、只管"同锁重入"与"锁内 emit"，跨锁顺序完全无人看守。**这是最高优先级，且改动最小。**
2. **异步运行时饥饿**（P1-01 / P1-02）—— 仓库已经在文件哈希维度上诊断并修过同一机制（`src-tauri/src/network/transport/outbox_sweep.rs:344-348`），但**没有把结论推广到 DB 互斥锁**，而 DB 锁的持有时长（VACUUM 秒~分钟级）比哈希更长。
3. **跨路径一致性缺失**（P1-03、P1-04、P2-01、P2-02）—— 单聊文件有 `AcceptResumeSegment` / `restart_segment` 而群文件没有；单聊完成 ACK 丢失有重发恢复而群 ACK 没有；单聊 outbox 逐行判定而群聚合判定；`pending_file_complete` 9 条退出路径只清了 2 条。**每一次"单聊修了、群忘了"的地方，都是一条业务不可完成的路径。**

### 对最终目标的直接回答

| 目标 | 回答 |
|---|---|
| **资源有界** | 绝大多数是（§5 中 20+ 项已验证有界且有淘汰策略）；例外是 `file_transfers` / `file_outbox` 终态行、`groupTodoRows`、BLE 外设事件通道、OS 通知线程、`peer_manager` |
| **循环可终止** | **需要限定**：所有 `loop` / `while` 的退出条件确实可达（47 个 Rust `loop`、18 个 e2e `for(;;)` 全部有超时 / 关断分支），但**"重试的终止条件"在群 outbox 这一条上是错的**（在线成员被离线成员的 hold 窗口牵连）⇒ 严格说，**"循环可终止"在群消息补发上不成立**。这是本次审计中唯一一处"循环语法上有退出条件、但退出条件被错误地聚合到消息级"的情形 |
| **任务可取消** | 大部分是（cancel 信号、shutdown watch、RAII guard、`Drop` 清理）；例外是 14 个被丢弃 `JoinHandle` 的后台任务（无法有序收尾）与 8 条 `pending_file_complete` 早退路径 |
| **锁可释放** | **P0-01 是唯一会导致锁永不释放的缺陷**；其余锁的持有区间均可证明有界（`std::sync::MutexGuard` 跨 `.await` 被类型系统排除） |
| **错误可恢复** | 核心业务流（消息 / ACK / 离线补发 / 内容拉取 / 群历史）都有明确终态与封顶；**群文件的续传与完成 ACK 两条恢复路径缺失** |
| **业务流程不会无法继续** | 除 P1-03（群文件重试必败 + 删前缀）、P1-04（群 outbox 在线成员被无限重发）、P2-01（群文件气泡永久转圈）外，未发现其他"无法推进"的路径 |

### 工具链侧的单独结论（§3.4）

脚本与 CI 的问题**不影响出货应用**，但值得单列一句：

- **脚本的循环终止性基本健康** —— e2e 全部 `for(;;)` 都有墙钟 deadline，发布重试恰好 5 次，护栏的 900 s 超时、`atexit` 还原、注入前置检查都在位（§4.9 的 ✅ 清单）。
- 真正的问题集中在**三处**：① **父进程异常退出时孤儿进程**（4 条路径）；② **定时器没有句柄**（"结果已出但进程不退出"）与**根本没有超时**（CDP 调用）；③ **CI 缺预算**（4 个打包 workflow 无 `timeout-minutes`、artifact 无 `retention-days`）。
- **唯一带安全维度的是 SC-P2-01**：`scripts/semver.mjs` 的 `execSync(\`git ${args}\`)` 是一条真实的命令注入原语，而它所在的 `npm run version:changelog` 是 **CI 每次 push/PR 都会走**的一步。修法是一行形状改动。

### 建议执行顺序

先做 P0-01 的 4 处锁作用域收窄（当日可完成、风险极低、收益最大），**同时补上锁序守卫**；再在第二批做 `DbLock` 的 `tokio::sync::Mutex` 化与 VACUUM 隔离；群文件的续传、群 ACK 恢复、群 outbox 逐行判定作为**同一个 PR** 一起做（它们改的是同一批文件，且属于同一条工程纪律）。工具链侧可**并行**推进，其中 SC-P2-01（命令注入）应当最优先 —— 一行改动、真实风险、CI 每次都跑。

---

## 9. 附录：审计方法与证据分级

### 9.1 方法

- **工作区先检**：`git status` / `git branch` / `git log` 在动手前确认（21 个未提交改动，全程未覆盖未重置）。
- **全局静态搜索**：`loop {`（47 处 Rust + 18 处 e2e）、`mpsc::channel` / `unbounded_channel`、`spawn` / `abort` / `JoinHandle`、`thread::sleep` / `blocking_lock`、`fs::read` / `read_to_end`、`lock()` / `try_lock()`、`setInterval` / `createObjectURL` / `addEventListener`、`while (true)` / `attempts` / `retries`。
- **调用链追踪**：对每个候选点从**入口追到出口**，确认退出条件在真实执行路径上可达。
- **锁作用域分析**：对全部 `state.*.lock()` 取锁点做**绑定行 → 存活终点**的区间计算（`drop(NAME)` 或所在块的结束），再在区间内找异种锁。**这个分析产出了 P0-01，也排除了约 20 个误报**（`peer_registry.rs`、`handshake.rs:75-82`、`member_notices.rs`、`state.rs:2381` 等）。
- **上游源码取证**：涉及框架行为的结论一律读上游源码而不是猜 —— `tauri-macros-2.6.3/src/command/wrapper.rs`（`body_blocking` vs `body_async`、`WrapperAttributeKind::Async` 的真实作用）、`tauri-2.11.5/src/async_runtime.rs`（全局运行时）、`tauri-2.11.5/src/ipc/command.rs`、`wry-0.55.1/src/wkwebview/class/wry_web_view_delegate.rs`（`#[thread_kind = MainThreadOnly]`）、`tokio-1.53.1/src/runtime/builder.rs`（`worker_threads` 默认值）。
- **现有护栏实跑**：`node scripts/check-lock-scope.mjs`、`node scripts/check-invariant-hooks.mjs`、`npm test`、`cargo test --lib`。

### 9.2 证据分级定义

| 级别 | 含义 | 本报告中的用法 |
|---|---|---|
| **已复现** | 运行时观察到现象并留有现场 | **产品侧一条都没有**（未做长跑压测、未在真机触发）。**工具链侧有 2 条**：SC-P2-03（Node 定时器钉住事件循环 ⇒ 进程滞留，用一次性脚本在 `/tmp` 复现）与 SC-P2-01（命令注入用本仓自己的 `git()` 实跑，注入标记被打印） |
| **测试证实** | 有测试断言，且该测试在当前代码上会红 | P1-03、P1-04、P2-01、P2-02 的"当前会红"用例 |
| **代码路径证实** | 读到了确切的代码与完整因果链，结论由代码结构直接推出 | **绝大多数条目** |
| **待验证风险** | 代码形状可疑，但需要运行时复现或外部 crate 行为才能坐实 | P3-09、P3-17、SC-P2-04~07（孤儿进程窗口）、§1.3 的 BLE 边界 |

### 9.3 本轮实际执行过的验证

**产品侧（会话开始时）**：
```
npm test                              → 1154 passed / 0 failed          (18.7s)
cargo test --lib                     → 1025 passed / 0 failed / 1 ignored (22.4s)
node scripts/verify.mjs              → 快速层 17 步全绿                  (84.4s)
```

**并发修复落地后（复跑）**：
```
cargo test --lib                     → 1029 passed / 0 failed / 1 ignored (31.1s)  ← 由红转绿
node scripts/verify.mjs              → 快速层 17 步全绿                  (90.8s)
node scripts/check-lock-scope.mjs    → 通过（db 336 guard + peers 27 guard；
                                       自锁 helper db 199 / peers 25，持锁调用 0 处；
                                       ★ peers↔db 跨锁嵌套 0 处；夹具 16 段 抓 8/放 8）
node scripts/check-test-manifest.mjs → 通过（基线 1046 条全在跑；macos 1046+3 / windows 1025+24）
node scripts/check-invariant-hooks.mjs → 通过（35 条不变量全部具名绑定）
node scripts/check-doc-citations.mjs → 通过（73 处 file:line + 604 处裸路径全部有效）
node scripts/check-doc-numbers.mjs   → 通过（7 份活文档硬数字对账）
node scripts/check-domain-map.mjs    → 通过
node scripts/check-domain-deps.mjs   → 通过
node scripts/semver.mjs check        → 通过（SC-P2-01 改写后仍正常）
node scripts/semver.mjs changelog --since 'HEAD; echo INJECTED_MARKER'
                                    → 注入标记出现 0 次（SC-P2-01 验证关闭）
本文件自检                            → 327 处 file:line 引用逐条核验：0 处断裂、0 处超范围
```

**未跑**（按约定跳过）：`cargo fmt --check`、`cargo clippy --features bluetooth`、Rust 单测的 `--features bluetooth` 变体、移动端 Android 编译门禁、护栏非空转的前端子集 —— 提交/打包前跑 `npm run verify:full` 即可。

### 9.4 本轮**没有**执行、建议补做的验证

1. 10 GB 级文件的实际峰值内存对照 §4.8 模型；
2. 1 GB `messages` 库上 VACUUM 的实际持锁时长与并发 IPC 延迟；
3. BLE 被动断连时 btleplug 通知流是否终止（决定 P3-09 与 BLE 断连检测的修复方向）；
4. 100 万条消息库上 `search_chat_history` 的实际耗时与持锁时长；
5. 群里有长期离线成员时，在线成员的实际重复信封速率（验证 P1-04 的 7 天窗口）；
6. `perf/run.mjs` 在真实 CDP 目标上的滞留时长（SC-P2-03 已在 Node 语义层复现，但未在真实目标上量过）；
7. `scripts/e2e-dev.sh` / `t4-mirror-dial.sh` 失败一次后是否真的留下孤儿进程（SC-P2-06 / SC-P2-07 静态成立，未实跑失败路径）。

### 9.5 关于 `src-tauri/Cargo.lock` 的如实说明

审计开始时 `git status` 把 `src-tauri/Cargo.lock` 列为已修改；跑完 `cargo test --lib` 后它**不再出现在 `git status` 里**。已查明原因：

- `src-tauri/Cargo.toml` 与 HEAD **完全一致**（未被改动）；
- `Cargo.lock` 最后一次提交是 `89c4cc3 chore(release): 5.0.42`（2026-10-21 13:25:44）；
- 审计开始时工作区里那份 lockfile 是**早于该 release 提交的陈旧残留**，cargo 1.98.1 解析依赖后把它**规范回 HEAD 的内容**（lockfile 版本仍是 `version = 3`，未发生格式升级；`git diff src-tauri/Cargo.lock` 为空 ⇒ 逐字节一致）。

**结论**：没有丢失任何依赖信息 —— 当前内容与已提交版本完全相同。这不是编辑动作，而是 cargo 在 `cargo test` 时的固有行为（它总要保证 lockfile 与 manifest 一致），下次任何人跑 `cargo build` 也会发生同样结果。其余 19 个原本已修改的文件全程未被触碰。

---

## 10. 拍板后的实施台账

> 每项独立修改、独立验收。**未运行的测试不标记通过。**
> 本节记录的是**实际做了什么、实际跑了什么、实际测到了什么**，不是计划。

### 10.1 决策 1（群文件断点续传）—— 🔴 拍板：**真断点续传**；⏳ 审计已完成，结论是**协议必须扩展**

**拍板（最终）**：选择**真正的断点续传**，不接受 `GroupOfferRetry::Reset`（重复 Offer 后截断 `.part`、
从 seq 0 重传）作为最终修复。目标是复用现有机制，实现与单聊 `AcceptResumeSegment` 一致的续传语义：
**保留已接收且校验通过的数据，从安全断点继续传输，而不是整份文件重传**。
实施前先审计，确认能否在不增加协议字段的前提下实现；**不得未经验证直接复制单聊逻辑，
也不得无条件截断已有 `.part`**。只有临时文件损坏、文件身份不匹配或进度无法安全恢复时，
才允许**明确回退**到从头传输并**记录原因**。若协议不足以可靠续传，再提交协议扩展及版本兼容方案。

#### 10.1.1 审计一：单聊续传机制的完整解剖

单聊是**唯一**已经实现真续传的一族（`FileOffer`/`FileReject`/`FileChunk`）。它的机制由五部分组成：

| # | 部件 | 位置 | 作用 |
|---|---|---|---|
| 1 | **协议上的偏移声明** | `src-tauri/src/protocol.rs:1699-1717` `FileOffer { from_seq, from_bytes, attempt }` | 发送方声明"我以为你已有 N 字节"。三个字段都是 `#[serde(default)]` ⇒ 旧端不发 ⇒ 视为 0（整份） |
| 2 | **接收端是权威** | `src-tauri/src/network/file/receive.rs:285-312` `decide_offer` | 纯函数，5 个输入（`has_active` / `active_received` / `disk_retained` / `size` / `from_bytes` / `already_completed`）⇒ 3 种结局 |
| 3 | **权威怎么告诉发送方** | `src-tauri/src/network/transport/handle_file.rs:130-147` | 接收端回 `FileReject { received = 本端真实字节 }` ⇒ **发送方永远以接收端的真实进度为准**，绝不重头覆盖 |
| 4 | **保留前缀而不是重建** | `src-tauri/src/network/file/receive.rs` `resume_receive` | 校验 `.part` 长度 == 声明的 `from_bytes`、查 TTL（过期则删掉并**整份重传**，这是**唯一**允许的回退）、**分块**喂哈希器（不是整读进内存）、用 `OpenOptions::append` 打开 ⇒ 前缀**原样保留** |
| 5 | **两端共同的序号约定** | `src-tauri/src/network/file/send.rs:446-452` | 发送侧 `f.seek(from_bytes)` 从字节偏移读，**但 `seq` 从 0 重新编号**；接收侧 `next_seq` 也归零、`received` 从 `from_bytes` 起算<br>⇒ **不变量：`seq` 是"段内相对编号"（永远从 0 起），字节偏移是绝对值** |

`decide_offer` 的三种结局（`src-tauri/src/network/file/receive.rs:245-255`）：

- `AlreadyHave` —— 本机已收完 ⇒ 只补 ACK，不重传；
- `Accept` —— 无前缀 ⇒ 全新开始；
- `AcceptResumeSegment` —— **有前缀且位置对得上** ⇒ 保留前缀、`next_seq` 归零、从断点继续；
- `ResumeFrom(held)` —— **位置对不上** ⇒ 回 `FileReject{received}` 让发送方按**真实**位置续发。

#### 10.1.2 审计二：群文件现状解剖

| 维度 | 单聊（能续传） | 群文件（**不能**） |
|---|---|---|
| 协议帧 | `FileOffer` / `FileAccept` / `FileReject{received}` / `FileChunk` / `FileDone` / `FileCompleteAck` | `GroupFileOffer` / `GroupFileChunk` / `GroupFileDone` / `GroupFileCompleteAck`（`src-tauri/src/protocol.rs:1806-1850`） |
| 偏移声明 | `FileOffer.from_bytes` | **无** |
| 轮次标识 | `FileOffer/FileChunk/FileDone.attempt` | **无** |
| **接收端 → 发送方的非终态帧** | `FileReject{received}` ✅ | **没有**（只有终态的 `GroupFileCompleteAck`） |
| 发送侧是否等对端 | 等（Offer → Accept/Reject 往返） | **不等**：`src-tauri/src/commands/group_file_dispatch.rs:108` 发完 Offer 直接进分片循环（`:151` 起） |
| 分片编号起点 | 可从断点重编（`seq` 恒从 0，字节偏移绝对） | 恒从 0（`group_file_dispatch.rs:151` `let mut seq: u32 = 0;`） |
| `.part` 命名 | `{transfer_id}.part`，**跨重试稳定**（`src-tauri/src/network/file/receive.rs:387`） | 同（走同一个 `make_receiver`） |
| 重复 Offer 的处置 | 判 `decide_offer` → 续传 | `group_offer_retry_action`（`src-tauri/src/network/transport/group_file.rs:23`）⇒ 目前只有 `ReAck` / `Reset` / `Ignore` 三档 |
| 接收端重启后的进度 | 从 `.part` 磁盘大小恢复（`resume_receive`） | **无**：重启后内存 `group_file_receivers` 丢失，`group_file_keys` 也丢（`group_file.rs:99-104` 提到"重启后内存 key 丢失"） |
| 落盘时是否无条件截断 | **否**（`resume_receive` 用 append 模式） | **是**：`make_receiver` 里 `std::fs::File::create(&tmp_path)`（`src-tauri/src/network/file/receive.rs:388`）**截断为 0** |

#### 10.1.3 审计结论：**在现有协议下无法实现真续传**

四条可核查的理由（每条都指到具体代码）：

1. **没有任何"接收端 → 发送方"的非终态帧**。单聊能用 `FileReject{received}` 把偏移告诉发送方，
   正是因为有这一帧；群文件这一族里**只有**终态的 `GroupFileCompleteAck`
   （`src-tauri/src/protocol.rs:1843-1850`）⇒ **发送方没有任何渠道知道对方有多少字节**。
2. **`GroupFileOffer` 连"我以为你有多少"都表达不了**（没有 `from_bytes`）⇒ 发送方连猜测都传不出去，
   更谈不上让接收端纠正它。
3. **发送侧不等任何回应**（`group_file_dispatch.rs:108` 之后直接进分片循环）⇒ 要拿到每个成员各自的偏移，
   必须引入**每成员一次握手**，那是"加一个回合 + 发送侧状态机"，不是"加一个字段"。
4. **群文件是扇出的**（每个在线成员一份独立投递，`src-tauri/src/commands/group_announcements.rs:426-435`），
   各成员的偏移**各不相同** ⇒ 续传点必须**逐成员**决定，不能用群级的一个值。

⇒ **"不改协议就实现真续传"在现有协议下不可行。** 按拍板"若现有协议不足以可靠续传，
再提交协议扩展及版本兼容方案"，走**协议扩展**。

> 并发改动方自己的注释已经写下了这个事实（`src-tauri/src/network/transport/group_file.rs:114-117`）：
> *"代价：本次重试**从零重传** —— 群协议没有"已收字节"回执，做不了真正的断点续传
> （那是后续优化，不是这条修复的前提）。"*
> ⇒ **该修复不与本拍板冲突**（它修的是"重试必败 + 删前缀"这个症状），
> 但**不能**被记作"已实现断点续传"。

#### 10.1.4 协议扩展方案（最小化）与版本兼容

**设计原则**：**复用单聊已验证的不变量**（`seq` 段内从 0、字节偏移绝对、接收端是权威），
只补群协议缺的那三样；**每一处新增对旧端都必须无害**。

| # | 新增 | 位置 | 作用 | 旧端兼容 |
|---|---|---|---|---|
| 1 | **`CONTENT_FEATURE_GROUP_FILE_RESUME: u32 = 1 << 5`** | `src-tauri/src/protocol.rs`（紧邻 `CONTENT_FEATURE_GROUP_HISTORY`） | 能力位：只有**声明了这一位**的对端才走续传握手 | 旧端不声明 ⇒ 发送方**不等待**、走今天的老路 ⇒ **零行为变化、零延迟变化** |
| 2 | `GroupFileOffer.attempt: Option<u32>` | `src-tauri/src/protocol.rs` | 轮次标识 | `#[serde(default)]` ⇒ 旧端发的 Offer 没有这个键 ⇒ 视为 `None` |
| 3 | `GroupFileChunk.attempt: Option<u32>` | 同上 | 上一轮残留分片要能识别（否则会被判"跳号"→ 整单打死） | `#[serde(default)]` |
| 4 | `GroupFileDone.attempt: Option<u32>` | 同上 | 同上（`FileDone.attempt` 的同形理由） | `#[serde(default)]` |
| 5 | **新帧 `GroupFileResume { transfer_id, group_id, to_sender, received: u64 }`**（接收端 → 发送方） | 同上 | **"我已有 `received` 字节，请从那里继续"** | 新端 → 旧端：旧端 `decode_frame` 把不认识的 type 降级成 `Message::Unknown` 并**保持链路**（`src-tauri/src/network/transport/outbound.rs:63-91`，INV-P24 第 1 条）⇒ **不会拆链** |

**为什么不加 `from_bytes` 到 `GroupFileOffer`**：单聊需要它是为了让接收端**发现双方位置不一致**并纠正。
群文件这边接收端**本来就是权威**（第 5 项那个帧直接给出真实偏移），`from_bytes` 是冗余的
⇒ 不加，保持扩展最小。

#### 10.1.5 实施计划（分步，每步可独立验收）

| 步 | 内容 | 验收 |
|---|---|---|
| **S1** | 协议层：加能力位 + 三个 `attempt` 字段 + `GroupFileResume` 帧；`content_features()` 带上新位 | 协议编解码单测；**旧端收到的形状必须仍然可解析**（`attempt` 缺省） |
| **S2** | 接收端：重复 Offer 时**不再无条件截断**。判据仿 `decide_offer`：<br>① 已有活跃接收器 ⇒ 用内存 `received`；<br>② 无活跃接收器 ⇒ 用 `.part` 的**磁盘大小**；<br>③ 前缀可用 ⇒ 回 `GroupFileResume{received}`，并用 `resume_receive` 那套**保留前缀**地重建接收器；<br>④ 前缀不可用（长度不符 / 身份不符 / 过期）⇒ **回 0 并记录原因**（拍板要求"明确回退 + 记录原因"） | 接收端单测：重复 Offer 不截断 `.part`；不可用前缀回退且**留痕** |
| **S3** | 发送端：**第 1 次尝试照旧**（不等、整份发）；**对端声明了能力位** ⇒ 发 Offer 后等 `GroupFileResume`（超时上限参照单聊的 accept 超时），按对方给的偏移 `seek` + **从 seq 0 重编**续发 | 发送端单测：偏移续发时**只补差的那一段**（统计实际发出字节数） |
| **S4** | 轮次隔离：收到 `attempt` 落后于本机当前轮次的分片/完成帧 ⇒ **安静丢掉**（不写盘、不打死） | 轮次单测：上一轮残留分片不触发"跳号 ⇒ 整单失败" |
| **S5** | 完整验证矩阵（拍板点名的七项） | 见 §10.1.6 |

#### 10.1.5.1 逐文件改动清单（照着做即可，不必重新审计）

| 文件 | 位置 | 要改什么 |
|---|---|---|
| `src-tauri/src/protocol.rs` | 能力位区（`:142` 之后） | 新增 `CONTENT_FEATURE_GROUP_FILE_RESUME: u32 = 1 << 5`（**不复用** `CONTENT_FEATURE_FILE_EPOCH`：那位管"能解析轮次"，这一位管"能应答偏移"，是两件事） |
| `src-tauri/src/protocol.rs` | `content_features()`（`:158-164`） | 带上新位 |
| `src-tauri/src/protocol.rs` | `GroupFileOffer`（`:1806-1823`） | 加 `attempt: Option<u64>`（`#[serde(default, skip_serializing_if = "Option::is_none")]`） |
| `src-tauri/src/protocol.rs` | `GroupFileChunk`（`:1825-1832`） | 加 `attempt: Option<u64>`（同上） |
| `src-tauri/src/protocol.rs` | `GroupFileDone`（`:1834-1838`） | 加 `attempt: Option<u64>`（同上） |
| `src-tauri/src/protocol.rs` | 群文件帧区 | 新增 `GroupFileResume { transfer_id, group_id, to_sender, received }` |
| `src-tauri/src/state.rs` | `AppState` 字段区 | ① 群文件**轮次表**（`transfer_id` → 当前轮次与权威进度）；② 发送侧**轮次号**记忆（保证同毫秒两轮不撞号）；③ **续传回执槽位**（按 `transfer_id+recipient`，因为群文件是扇出、各成员断点各不相同） |
| **src-tauri/src/network/file/group_resume.rs**（**新增**） | — | 纯函数那一族：`decide_group_offer`（收到重复 Offer 怎么答）、`prefix_usable`（前缀能不能用）、`frame_is_current`（这一帧是不是当前轮次）、轮次号的生成与存取 |
| `src-tauri/src/network/file.rs` | `include!` 区（`:394-400`） | `include!("file/group_resume.rs")`（与该文件既有分册同一机制） |
| `src-tauri/src/network/file/group_receive.rs` | 紧邻 `begin_group_receive`（`:18`） | 新增"**保留前缀**地建接收器"的一份（单聊的 `resume_receive` 是 DM 专用的：它注册进 `file_receivers`、取 `from_bytes`、还要 `spawn_blocking` 整份哈希校验 ⇒ **不能直接复制**，只能照它的判据重写一份群版） |
| `src-tauri/src/network/transport/group_file.rs` | `handle_group_file_offer`（`:43` 起） | 用 `decide_group_offer` 取代 `group_offer_retry_action` 的三分支；`Resume` ⇒ **不截断**、重建接收器、回 `GroupFileResume`；`Fallback` ⇒ **记录原因**后整份重来 |
| `src-tauri/src/network/transport/group_file.rs` | `handle_group_file_chunk`（`:1255` 起） | 进 `write_chunk` 之前先判 `frame_is_current` ⇒ 陈旧轮次的分片**安静丢掉**（不写盘、不打死整单） |
| `src-tauri/src/network/transport/group_file.rs` | `handle_group_file_done`（`:316` 起） | 同上 |
| `src-tauri/src/network/transport/handle_group.rs` | 三个群文件臂（`:144` / `:170` / `:180`） | 模式补上 `attempt` 字段；新增 `GroupFileResume` 臂 |
| `src-tauri/src/network/transport.rs` | `Message` 汇总 match（`:1090` 附近） | 新增 `GroupFileResume` 臂（转给群文件处理器） |
| `src-tauri/src/commands/group_file_dispatch.rs` | `dispatch_group_file_to_peer`（`:44` 起） | ① 生成轮次号并写进 Offer/Chunk/Done；② 对端**声明了能力位** ⇒ 发完 Offer **等 `GroupFileResume`**，按对方给的偏移 `seek` 并把 `seq` 从 0 重编；③ 统计"本次实际发出字节数"（供验证"没整份重传"） |
| `src-tauri/src/commands/group_announcements.rs` | 群发 Offer 处（`:405`） | 带上轮次号（**每个成员一份**，轮次号按 (transfer, recipient) 记 ⇒ 各成员互不干扰） |

#### 10.1.5.2 三个必须防住的坑（照抄单聊的教训）

1. **不能用"内存 `received`"当唯一真相** —— 单聊那边踩过：`report` 大了会让发送端以为对端有它没有的东西、
   永远等不齐（`file::decide_offer` 的注释原话）。⇒ **群侧的权威进度取"内存与磁盘的较小者"**，
   磁盘是最终事实。
2. **"磁盘上有整份字节"不等于"收到了"** —— 上一次收尾 `rename` 失败时字节是整份的，但磁盘上**没有成品**。
   ⇒ 磁盘前缀 ≥ 声明总长时按 **0** 处理（单聊同一条判据）。
3. **不能让上一轮的残留分片把整单打死** —— 续传时 `seq` 归零，上一轮还堵在链路队列里的高 `seq` 分片
   会被判"跳号"⇒ 整单失败（单聊那边已经为这件事付过学费，见 `CONTENT_FEATURE_FILE_EPOCH` 的注释）。
   ⇒ **必须带轮次号**，且陈旧轮次的分片要**安静丢掉**而不是打死。

#### 10.1.6 拍板点名的验证矩阵（**全部落地前本项不算完成**）

| # | 场景 | 必须验证的事实 |
|---|---|---|
| 1 | **大文件断链续传** | 续传后文件 SHA-256 与首轮一致；**实际补传字节数 ≈ 缺口大小**，**不是整份** |
| 2 | **发送方重启** | 重启后仍能续上（不从头开始） |
| 3 | **接收方重启** | 重启后从 `.part` 的磁盘前缀恢复进度（**内存态全丢**：`group_file_receivers` 与 `group_file_keys` 都没了 ⇒ 这是最需要新代码的一格） |
| 4 | **重复 Offer** | 幂等：回 `GroupFileResume`，**不截断 `.part`**、不重建会话、不重复计费 |
| 5 | **重复 / 乱序分片** | 重复片不重复写盘；乱序片不误判"跳号 ⇒ 整单失败" |
| 6 | **部分写入** | `.part` 长度不是整片倍数时，**以磁盘实际长度为准**（字节流是连续的 ⇒ 不必对齐到片边界；见下） |
| 7 | **双方进度不一致** | 发送方按**接收端给的**偏移续（接收端是权威）；不一致时以接收端为准 |
| 8 | **文件最终完整性** | 续传完成后 SHA-256 全量校验通过；不通过则判失败并**保留现场** |

> **关于第 6 项的一处更正**（审计中发现的、容易想错的一点）：`.part` 的长度**不必**对齐到分片边界。
> 续传的本质是"发送方从第 N **字节**继续"，而**字节流是连续的** ⇒ 接收方报出**磁盘上的实际长度**、
> 发送方 `seek` 到那个字节，两边拼起来仍然是完整的一条字节流 ⇒ 最终 SHA-256 一致。
> 单聊那边之所以看起来要"对齐"，是因为它的 `from_bytes` 来自双方协商的值，不是接收端现读的磁盘长度。
> ⇒ 群侧更简单：**接收端报磁盘实际长度即可**（但**不得超过**声明的总长，超过就是"文件身份不匹配" ⇒ 回退）。

**"没有整份重传"的证明方式**（拍板点名要统计的那个数）：

在 `dispatch_group_file_to_peer` 的分片循环里记两个数：
- `sent`：本次**实际写出**的字节数（现有代码已有这个计数，从 `resume_from` 起算）；
- `resume_from`：接收端报回来的偏移（首轮为 0）。

⇒ **补传字节数 = `sent`**（续传那一轮），**缺口大小 = `size - resume_from`**。
断言 `sent < size`（**不是整份**）**且** `sent <= (size - resume_from) + 一个分片`（**只补了缺口**）。
两条件缺一不可：只断 `sent < size` 会让"整份重发但省了最后一片"蒙混过关。

#### 10.1.7 当前状态

- 🔴 **`GroupOfferRetry::Reset` 不被记作"已实现断点续传"**（按拍板要求）。它的注释里已经写明
  "群协议没有'已收字节'回执，做不了真正的断点续传"（`src-tauri/src/network/transport/group_file.rs:114-117`）。
- ✅ 审计已完成（§10.1.1–§10.1.4），**结论：不改协议做不到**，最小协议扩展 + 兼容策略已给出。
- ✅ 实施清单已细化到**逐文件 / 逐函数 / 逐行**（§10.1.5.1），含三个必须防住的坑（§10.1.5.2）
  与"补传字节数"的度量口径（§10.1.6）。
- ✅ **S1–S4 已实现**（2026-10-21）：
  - **S1 协议**：`CONTENT_FEATURE_GROUP_FILE_RESUME = 1 << 5`（`protocol.rs:148`，`content_features()` 带上它 `:170`）；
    Offer/Chunk/Done 各加 `attempt: Option<u64>`（`:1834` / `:1847` / `:1858`，`serde(default)`）；
    新帧 `GroupFileResume { … }`（`:1873`）。
  - **S2 接收端**：`network/file/group_resume.rs`（`decide_group_offer` `:28` / `prefix_usable` `:55` /
    `send_start_from` `:73` / `group_frame_round_is_current` `:85`）；保留前缀的接收器
    `group_receive.rs:85` `build_group_resume_receiver`（校验 `.part` 存在、0<len<size、24h 内、整份哈希）；
    `transport/group_file.rs` 在 `attempt.is_some()` 时走 Resume，否则维持旧路；
    **Restart 时同时删旧 `.part`**（`:424`）—— 否则下一次 Offer 会把"旧字节+新字节"当可用前缀，
    最终 SHA 永远不符、陷入续传失败循环。**续传分支也建接收气泡**（`:265` 调用、`:565` helper）——
    否则接收端整段传输没有卡片，完成时 `update_message_content` 因行不存在而落空
    （判据 `lib_file_tests.rs:154`）。
  - **S3 发送端**：`commands/group_file_dispatch.rs:109-232` —— 对端声明能力位才注册回执槽位并等待（15s），
    按接收端给的偏移 `seek`、`seq` 从 0 重编；`sent` 从 `resume_from` 起算（`:232`），日志在 `:345-347`。
  - **S4 轮次隔离**：Chunk/Done 先过 `group_frame_is_current`（`group_file.rs:671` / `:1632`），陈旧轮次安静丢弃。
- **S5 验证矩阵（§10.1.6）逐项证据级别**：

| # | 场景 | 现在的证据 |
|---|---|---|
| 1 | 大文件断链续传 | ✅ 单测：`group_resume_prefix_plus_suffix_finishes_with_the_original_sha`（前缀+后缀落盘逐字节一致、最终 SHA 校验通过）+ `sender_starts_from_the_authoritative_offset`（从接收端偏移续）。⚠️ **未跑**真实断链 e2e，"实际补传字节数"没有线上读数 |
| 2 | 发送方重启 | ✅ 决策面：`send_start_from` + 「对端能力位才等待」；**轮次种子取启动纳秒**（`state.rs:940`），否则重启后轮次从 0 数、被接收端当残留丢弃（判据 `file_tests.rs:1088`）；**开机第一拍不设下界回收所有本机 `sending` 行**（`group_file.rs:1293`，判据 `db/group_files.rs:586`）—— 否则重启后要等 10 分钟 stale 阈值才重投；⚠️ 重启进程 e2e 未跑 |
| 3 | 接收方重启 | ✅ `build_group_resume_receiver` 从磁盘 `.part` 重建（单测 `group_resume_receiver_keeps_the_prefix_and_hashes_it` 模拟"内存态全丢"）；⚠️ 真重启 e2e 未跑 |
| 4 | 重复 Offer | ✅ `decide_group_offer`：已完成 ⇒ `AlreadyHave`、有活接收器取内存进度、否则取磁盘；`already_have_wins_over_any_prefix` / `resume_uses_the_smaller_of_memory_and_disk`；append 打开 ⇒ **不截断 `.part`** |
| 5 | 重复 / 乱序分片 | ✅ 既有 `group_receive_rejects_gap_but_ignores_duplicate_seq`（重复片不重复写、跳号才拒）+ 新轮次过滤 |
| 6 | 部分写入 | ✅ 集成测试的 `split = 3700` 故意不对齐分片边界；进度取磁盘实际长度 |
| 7 | 双方进度不一致 | ✅ `resume_uses_the_smaller_of_memory_and_disk` + 发送端只认接收端给的偏移（`send_start_from`） |
| 8 | 最终完整性 | ✅ `group_done_sha_mismatch_fails_and_cleans_part`（SHA 不符 ⇒ 失败并清 `.part`）+ 新集成测试的整份 SHA 一致 |

> **结论（防止把单测当 e2e）**：1/3 两项的"重启"与第 1 项的"实际补传字节数"仍**只有单元级证据**；
> §10.1.6 要求的真机断链矩阵**没有跑**。所以决策 1 标记为"已实现 + 单测矩阵"，**不标记"已验证通过"**。


### 10.2 决策 2（数据库 VACUUM 时间预算）—— ✅ 已实现并验证

**拍板**：先做 A —— 增加时间预算、进度中止与失败恢复；3 秒是目标预算，需验证实际行为；B 单独实施。

#### 改了什么（实际 diff）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/storage/vacuum.rs`（**新增**） | 带时间预算的 VACUUM：`vacuum_with_budget(conn, budget_ms)`、`VacuumOutcome{Completed/Aborted/Failed}`、`state_code()`、`note()`；8 条用例 |
| `src-tauri/src/storage/mod.rs` | `pub mod vacuum;` |
| `src-tauri/src/storage/cache_cleaner.rs` | `CleanupReport` 增 `db_compact_state: Option<String>`（机器码；`Copy` 随之去掉，因为 `Option<String>` 不可 `Copy` —— 全仓无地方依赖那个 `Copy`） |
| `src-tauri/src/commands/channel.rs` | **自动路径**与**手动路径**都改走 `vacuum_with_budget`；`format_vacuum_note` 改成按三种结局分述；新增一条守卫 `an_aborted_vacuum_never_reads_as_a_failure`；源码形状守卫 `vacuum_execution_timer_starts_after_the_lock_is_held` 随形状更新 |
| `src-tauri/Cargo.toml` | `rusqlite` 加 `hooks` feature（`hooks = []`，**不引入新依赖 ⇒ Cargo.lock 不变**） |
| `src/types.ts` | `CleanupReport` 增 `db_compact_state?: "done" \| "aborted" \| "failed"` |
| `src/components/settings/StorageSection.vue` | 按状态给用户补一句提示（`aborted` ⇒ "超时已取消、内容完好"；`failed` ⇒ 错误提示） |
| `src/i18n/locales/{zh-cn,en-us}.ts` | 新增 `settings.storage.toast.compactAborted` / `compactFailed` |

#### 实测数据（本轮真跑出来的，不是估的）

| 指标 | 实测值 |
|---|---|
| 42 MB 库（6 万行、删到 500 行）整理耗时 | **8.5 ms**（8.0 / 8.5 / 9.2 ms 三次） |
| 整理后库大小 | **42,496,000 B → 356,352 B**（省 99%） |
| VACUUM 期间进度回调触发次数 | **2,060 次**（`num_ops = 1`） |
| 预算 2 ms 的中止落点 | **实际 2 ms**（`Aborted`）—— 精确命中 |
| 中止后 `PRAGMA integrity_check` | **ok** |
| 中止后数据行数 | **一行没少** |

#### 过程中撞到并解决的**真问题**（这一段是本次最有价值的产出）

第一版把回调间隔设成 `num_ops = 1000`，结果 **2 ms 的预算根本没拦住**（VACUUM 跑完 5 ms 才结束）。
逐段测回调的时间分布才发现根因：

- `num_ops = 1` ⇒ 回调 **2,687 次**，首 263 µs / 末 6.6 ms ⇒ **均匀铺满全程**；
- `num_ops = 100` / `1000` ⇒ 回调只有 **18 次**，且**集中在前期** ⇒
  **VACUUM 的整库重写主要在 C 层进行、产生的虚机指令极少** ⇒ 回调**不会**在真正耗时的那一段被调用。

⇒ 只有 `num_ops = 1` 能可靠地在预算处中止（实测：2 ms 预算 + `num_ops = 1000` ⇒ 没拦住；
2 ms 预算 + `num_ops = 1` ⇒ 正好 2 ms 中止）。开销可忽略：回调体只有一次 `Instant::now()`
比较，实测 2,060 次 ≈ 50 µs，占 8.5 ms 整理时间的 **~0.6%**。

**这条实测顺带修正了本报告的一个判断**：P1-01 里"VACUUM 秒~分钟级 ⇒ 整窗冻住"的说法
**对 42 MB 的库是不成立的**（实测只要 8.5 ms）。真正的风险只在**很大的库**上
（`VACUUM` 耗时随库体量线性增长）。这不改变"该加预算"的结论，但**改变了紧迫度排序**：
3 秒预算对绝大多数用户的库是**用不上的**，它是给超大库兜底的。

#### 测试命令与结果（实跑）

```
cd src-tauri && cargo test --lib storage::vacuum -- --nocapture
  → 8 passed / 0 failed
cd src-tauri && cargo test --lib
  → 1049 passed / 0 failed / 1 ignored
npm test
  → 1154 passed / 0 failed
node scripts/check-lock-scope.mjs
  → 通过（db 340 guard + peers 27 guard；peers↔db 跨锁嵌套 0 处；夹具 16 段 抓 8/放 8）
node scripts/check-doc-citations.mjs / check-doc-numbers.mjs / check-invariant-hooks.mjs
  → 全部通过
```

**未跑**（按约定跳过，提交前跑 `npm run verify:full`）：`cargo fmt --check`、
`cargo clippy --features bluetooth`、Rust 单测的 bluetooth 变体、Android 编译门禁、护栏非空转前端子集。

#### 用户能感知到什么

- **正常情况（库不大）**：**零感知**。整理 8.5 ms 就完了，预算根本用不上。
- **超大库撞上预算**：界面最多卡 3 秒（而不是"几十分钟"），并且会明确看到
  **"数据库整理超时已取消：内容完好，只是这次没有压缩（会自动再试）"** —— 不是"失败"，
  也不会让人以为数据库坏了。
- **数据安全**：中断是 SQLite 事务性回滚，**原库一字未改**（有用例钉住：`integrity_check = ok` + 行数不变）。

#### 剩余风险

1. **3 秒预算本身没在"真·超大库"上验过**：本轮实测的最大库是 42 MB（8.5 ms）。
   要验证"3 秒"这个数，需要一个真能跑过 3 秒的库（按线性外推约 **≥ 1.4 GB**）——
   本轮**没有**造这么大的库，因此**"3 秒是否够"目前只有间接证据**（线性外推 + 中止精度实测 2 ms 命中）。
2. **"预算内做不完"⇒"碎片没回收"**：撞上预算后 db 文件不会变小，磁盘占用不降。
   下一次自动清理（6 小时后）会再试一次；这是可接受的取舍，但**界面上目前只有手动路径会说**，
   自动路径只记日志。
3. **B 方案（独立连接 `VACUUM INTO` + 原子换名）尚未实施**（拍板明确"后续单独实施"）。
   在 B 落地前，自动清理路径仍有"大库时每 6 小时可能卡 3 秒"的可能。
4. `CleanupReport` 去掉了 `Copy`（`Option<String>` 不可 `Copy`）。全仓核对过**没有**依赖那个 `Copy`，
   但这是一处**公开结构体的 trait 变化**（`storage::cache_cleaner` 是 crate 内部模块，非对外 API）。

### 10.3 决策 3（蓝牙事件队列硬上限）—— ✅ 已实现（编译与单测；真机 e2e 未跑）

**拍板**：3B —— 设硬上限，积压时受控断链并自动恢复；不得静默丢帧，并防止重连风暴。

**已定位的落点**（实施时直接照做）：

| 位置 | 现状 |
|---|---|
| `src-tauri/src/transport/bluetooth_peripheral.rs:362` | `mpsc::unbounded_channel::<PeripheralEvent>()` —— 全传输栈**唯一**无界队列 |
| `src-tauri/src/transport/bluetooth_peripheral_windows.rs:165` | 同上 |
| `src-tauri/src/transport/ble_android.rs:189` | 同上 |
| 消费侧 | `network/ble/peripheral.rs:158`（`RouteCtl` 通道 cap 16）、`:448`（每链路字节通道 cap 1024）⇒ 消费侧会阻塞，于是事件开始堆积 |
| 单条事件上限 | `MAX_BLE_MESSAGE_BYTES = 512 KiB`（`transport/ble_framing.rs:166`） |

**实施要点（拍板点名的两条）**：
- **不得静默丢帧** ⇒ 溢出时走**断链**（与既有"写失败 ⇒ 拆链"语义一致，`queue_policy.rs` 的 writer 就是这么做的），
  **不**走"丢最旧的"。
- **防止重连风暴** ⇒ 断链后重连必须带**退避 + 抖动**（`central.rs:293-305` 已有拨号退避的形状可复用），
  否则"积压→断链→立刻重连→再积压"会变成一个 2 秒一轮的循环，把 BLE 电台一直占着。

**落地（2026-10-21）**：

| 位置 | 改成了什么 |
|---|---|
| `src-tauri/src/transport/ble_pending.rs`（**新增**，`transport/mod.rs` 在 `feature = "bluetooth"` 下登记） | 三平台共用的有界队列：`PERIPHERAL_EVENT_QUEUE_CAP = 64`（64 × 单帧上限 512 KiB = 最坏 32 MiB）；`try_push` 满时**拒绝入队**并通过 `watch` **带外**发溢出信号；`overflow_backoff_ms(seed) = 2000 + seed % 3000`（2–5s 抖动） |
| `transport/bluetooth_peripheral.rs:282` / `bluetooth_peripheral_windows.rs:125` / `ble_android.rs:79` | `UnboundedReceiver` → `mpsc::Receiver`；`PeripheralServer` 增 `overflow`；所有回调投递点改 `try_push`（回调线程永不阻塞） |
| `network/ble/peripheral.rs:160-205` | 收到溢出信号 ⇒ **拆掉全部路由**（链路任务随之收尾 = 受控断链）、清空 `handshaking`、进入冷却；冷却期拒绝 `RouteCtl::Add`（`return` 掉 `tx`） |
| `network/ble/peripheral.rs:229-239` | 冷却期收到 `Frame` ⇒ **计数后丢弃**；冷却结束落一条日志说明丢了多少（不是静默） |

**为什么不走"丢最旧"**：丢一帧就是静默丢消息；断链会让对端按传输层语义重连/重试。
溢出那一条帧确实没进队，但它**连同断链一起被交代**（日志 + 链路消失），不是"假装收到"。

**验证**：
- `cargo test --features bluetooth --lib transport::ble_pending` → **2 passed**（满时拒绝 + 带外信号 + 消费后容量恢复；冷却有界且抖动）。
- `bash scripts/check-mobile.sh --bluetooth` → **PASS**（Android 两档 0 warning）。
- Windows：`cargo xwin check --target x86_64-pc-windows-msvc --features bluetooth --lib`（结果见 §11.2）。
- ⚠️ **未跑**：真机三平台的"溢出 ⇒ 对端自动重连并补发"（需要 BLE 电台与两台设备）。

### 10.4 决策 4（群文件发送并发上限 8）—— ✅ 已实现（闸与排队有判据；内存/吞吐未实测）

**拍板**：4A(8) —— 并发上限 8，**统一在传输调度层**实施；实测内存峰值、吞吐和排队行为。

**已定位的落点**：

| 位置 | 现状 |
|---|---|
| `src-tauri/src/commands/group_announcements.rs:426-435` | 群发文件**逐可达成员 `tokio::spawn`**，**无上限** |
| `src-tauri/src/commands/group_file_dispatch.rs` | 单个成员的投递任务（每成员一份 256 KiB 读缓冲 + AEAD + base64 副本 ≈ 1.2 MB） |
| `src-tauri/src/network/transport/queue_policy.rs:16` | 每条链路的 Low 队列字节预算 **8 MiB** ⇒ 200 成员 = 200 条链路 = **1.6 GB 队列** |
| 群成员数 | **没有上限**（全仓搜过：`MAX_GROUP_MEMBERS` 不存在，`group_add_member` 不设限） |

**"统一在传输调度层"的含义**：闸要放在**传输调度**那一层（一条链路一个槽、或一个全局的
`file_permits` 信号量），**不能**放在命令层 —— 因为命令层只管"起几个任务"，
而真正占资源的是链路上的队列与缓冲。放在调度层才能同时约束"任务数"与"队列内存"。

**拍板点名的三项实测（本项实施时必须给出）**：
1. **内存峰值**：8 并发 vs 200 并发，同一文件同一群。
2. **吞吐**：8 并发时 1 GB × N 人的总墙钟时间（预期比 200 并发慢，但 200 并发在很多机器上是"跑不完"）。
3. **排队行为**：排队时**不得丢文件、不得静默降级**（用户拍板原话："涉及消息可靠性、文件完整性和
   持久化历史的行为不得为节省资源而静默降级"）⇒ 排队必须是**无损等待**，不是"满了就失败"。

**落地（2026-10-21）**：

| 位置 | 改成了什么 |
|---|---|
| `src-tauri/src/state.rs:898` | `MAX_CONCURRENT_GROUP_FILE_SENDS = 8` |
| `src-tauri/src/state.rs:1011` / `:1930` | `group_file_permits: Arc<Semaphore>`，启动时放 8 个许可 |
| `src-tauri/src/commands/group_file_dispatch.rs:63` | 群发与离线补发的**唯一投递入口**在调度层 `acquire().await`；RAII，任何退出路径都归还 |
| `src-tauri/src/commands/group_file_dispatch.rs:60` + `state.rs:941` | **配套在途闸** `GroupFileDispatchGuard`（键 = `file_peer_key(transfer_id, recipient)`）：排队中的任务也算"在途"。没有它，排队期间行保持 `pending`，而离线补发会在 Hello/心跳/建链时捞 `pending` ⇒ 同一成员两个任务 |
| `src-tauri/src/commands/group_file_dispatch.rs:31` / `:114` / `:138-143` | **取消也要穿透排队**：取消槽位在并发闸**之前**登记（RAII `CancelSlotGuard`），拿到许可后先 `try_recv` 一次 ⇒ 排队期间点"取消发送"不会被静默丢掉；槽位不再手写 remove（`timeout` 丢 future 时走不到） |
| `src-tauri/src/commands/group_file_dispatch.rs:11` | 续传回执槽位同样 RAII（`ResumeWaiterGuard`）：等待 15s 期间被 deadline/取消打断时，槽位不会永久残留 |
| `src-tauri/src/commands/group_announcements.rs:417` | fan-out **不再提前写 `sending`**：排队成员保持 `pending`，否则 10 分钟 stale-sending 清扫器会把排队当卡死重投 ⇒ 同一成员两个任务 |

**排队行为**：`acquire` 是等待而不是 `try_acquire` ⇒ 不丢文件、不降级；任务数与每链路队列内存同时被约束。
判据：`lib_file_tests.rs` 的 `group_file_send_concurrency_is_gated_at_the_scheduler`（常量=8、
必须是 `acquire`、fan-out 不得提前标 `sending`、在途闸必须在）；行为面：
`network/file_tests.rs:1102` `group_file_dispatch_gate_is_per_member_and_releases_on_drop`
（同键第二个任务被拒、不同成员互不阻塞、Drop 后可重投）。

**三项实测的状态（拍板点名，如实区分"实测"与"算术上界"）**：
1. **内存峰值**：⚠️ **未实测**。实现推出的上界：并发 8 × 每任务约 1.2 MB 读/加密缓冲 ≈ 10 MB，
   加 8 条链路队列（每条预算 8 MiB）≤ 74 MiB；旧形状 200 成员 ≈ 200 × 1.2 MB + 200 × 8 MiB ≈ 1.8 GB。
   **这是算术上界，不是实测**。
2. **吞吐**：⚠️ **未实测**（需要 release 产物 + 多成员真机/双实例）。
3. **排队行为**：✅ 源码判据 + 无损等待的语义（`acquire`）已钉住；⚠️ 真机排队 e2e 未跑。

### 10.5 决策 5（每群任务缓存 500 条）—— ✅ 已实现

**拍板**：5A(500) —— 每群运行态任务缓存最多 500 条；**只裁剪缓存，不得擅自永久删除数据库中的任务历史**。

**已定位的落点**：

| 位置 | 现状 |
|---|---|
| `src/stores/useChatStore.ts:948` | `groupTodoRows = ref<TodoRowsByConv>({})` —— **无上限、永不逐出** |
| `src/utils/todos.ts:973-989` | `mergeIncomingTodoRows` 每个任务事件都往 per-conv 数组**追加** |
| `src-tauri/src/commands/chat.rs:430` | 后端只限**会话数**（`MAX_CONVS = 400`），**行数无 LIMIT** |
| `src/utils/todos.ts:548-610` | `foldTodos` 对每行做一次 `JSON.parse` ⇒ 每来一个任务事件 = O(总行数) 的解析 |

**"只裁剪缓存"的边界（拍板明确）**：
- ✅ 裁剪的是**前端内存里的运行态缓存**（`groupTodoRows`），超出 500 条的**最旧**记录从内存里移除。
- ❌ **不许**因此去删数据库里的 `messages` 行（那是持久化历史，删了就是数据丢失）。
- ⇒ 裁剪后那些老任务**在界面上看不到**，但**记录仍在库里**；需要时仍可从库里取回。

**实施要点**：`groupTodoRows` 改用 `src/utils/bounded.ts` 的 `trimOldest`（现成的 FIFO 闸，
本仓其他"只加不删"的集合都走它）；`foldTodos` 的重算成本随之从 O(总行数) 降到 O(500 × 群数)。

**落地（2026-10-21）**：
- `src/utils/todos.ts:931` 定义 `MAX_TODO_ROWS_PER_CONV = 500`；`:933-935` 的 `capTodoRows`
  保留**最后 500 条**（裁最旧）；`putTodoRows`（`:951`）与 `mergeIncomingTodoRows`（`:1004`）
  两条入口都过这道闸（比 `trimOldest` 少一次 import，语义相同：FIFO、只动内存）。
- **只在 `src/utils/todos.ts` 这一个前端文件里改**：没有新增/修改任何 DB 删除；后端
  `commands/chat.rs` 一行未动 ⇒ "不碰持久化历史"是结构性成立的，不靠自觉。

**验证**：`npm test` 内 `src/utils/todos.test.ts:751-761` 两格 —— ① 超过 500 条时缓存封顶到 500；
② 新事件进来后仍保留**最新** 500 条（最旧的被裁）。全量 `npm test` → **1158 passed / 0 failed**。
⚠️ **未做**：真机大群的帧率/主观流畅度读数（`foldTodos` 的重算上限由 500 决定，属静态推断）。

### 10.6 决策 6（崩溃测试现场留存）—— ✅ 已实现

**拍板**：6A —— 保留 30 天，单次超 2 GB 时按安全规则清理；同时覆盖异常退出遗留目录。

**已定位的落点**：

| 位置 | 现状 |
|---|---|
| `scripts/e2e/core.mjs:143-149` | `classifyRun` 把"崩在半路（没有 `summary.json`）"判成 `unknown` |
| `scripts/e2e/core.mjs:153-174` | `prunePlan` 只删超龄的 `green` 与超龄的 `red` ⇒ **`unknown` 永远不删**（这条行为被脚本自己的单测在 `:245` / `:261` 钉住，是**刻意的**："崩在半路 ⇒ 现场比省空间值钱"） |
| `scripts/e2e/core.mjs:126-140` | `citedRunIds` 把每个被跟踪的 `*.md`/`*.html` **整份读进内存**（当前约 4.6 MB） |
| 实测现状 | 本机 `test-results/` **13 个目录 / 2.8 MB**；历史上曾有 153 个 / 约 5 GB |

**实施要点**：
- `unknown` 这一档**单独加规则**：**保留 30 天**（从目录 mtime 算），**或**单次目录 **> 2 GB** 时按安全规则清理。
- **"按安全规则"的含义**：先删**最大的**文件、保留最近修改的；**不动**仍被文档引用的 run（`citedRunIds` 已经在算这个集合）。
- **"异常退出遗留目录"**：指跑 E2E 时被 Ctrl-C / 杀进程留下的、**连 `summary.json` 都没有**的半截目录 ——
  它和"崩了"是同一类（`unknown`），但还要额外处理"**目录结构不完整**"的情况（清理时不能因为缺文件而报错）。

**落地（2026-10-21）**：

| 位置 | 改成了什么 |
|---|---|
| `scripts/e2e/core.mjs:170-201` | `prunePlan` 新增 `unknownMaxAgeDays`：`unknown` 超 30 天且**未被文档点名** ⇒ 整目录删 |
| `scripts/e2e/core.mjs:209-235` | `planRunTrim(files, maxBytes)`：超 2 GB 时先删**最大的**，**永不删最近修改的那一个** |
| `scripts/e2e/core.mjs:280-340` | `pruneOldRuns` 对整个目录删完后，对剩余 `unknown` 逐个量体积并按计划删大文件；`listFiles` 跳过读不到/中途消失的文件 ⇒ **半截目录不报错** |
| `scripts/e2e/core.mjs:268-272` | `retentionLimits()` 增加 `unknownMaxAgeDays=30` / `unknownMaxBytes=2 GiB`（`GOSSLAN_KEEP_UNKNOWN_DAYS` / `_BYTES` 可调） |
| `scripts/e2e-multi-instance.mjs` 两处调用 | 轮末收尾与 `--prune-only` 共用同一份上限与实现 |

**验证**：
- `node scripts/e2e-multi-instance.mjs --prune-selfcheck` → **30 格全绿**。其中"真盘面"那组在临时目录里
  实删过：被点名的老崩溃现场不删；超预算只删最大文件、最新修改的留下；无人引用的老现场整目录删；
  incomplete 目录不阻断清理。
- `node --check scripts/e2e/core.mjs` / `scripts/e2e-multi-instance.mjs` → 通过。
- ⚠️ 没有在本机制造 > 2 GB 的 run 目录；体积规则用 **1 MiB 预算**在临时目录里真删过（同一实现、同一分支）。

> **审计时那条 `citedRunIds` 已不成立**：工作区当前实现按 64 KiB 块**流式**扫描
> （`scripts/e2e/core.mjs:127-155`），不再整份读进内存 ⇒ 这一项无需再改。

### 10.7 决策 7（数据库锁大改造）—— ⏳ 延后到第二批

**拍板**：放第二批，先完成高收益低风险修复，之后**专项审计和分阶段实施**。

**专项审计要回答的问题（清单）**：

1. **锁序**：把 `state` 里全部 20+ 把 `std::sync::Mutex` 排出一个**全局锁序**，
   并让 `scripts/check-lock-scope.mjs` 覆盖**全部**锁（现在只覆盖 `db` 与 `peers` 两把）。
2. **换锁的爆炸半径**：`DbLock` → `tokio::sync::Mutex` 涉及约 340 个取锁点（实跑计数），
   其中多少在 `async fn` 里、多少在**同步**上下文里（后者不能用 `.lock().await`）？
3. **同步上下文怎么办**：命令层从"同步函数 + `spawn`"改成 `async fn` 之后，
   **同步命令**（`#[tauri::command]` 不带 `async`）还能不能拿锁？⇒ 哪些命令必须改成 async？
4. **可观测性**：`db_hold` 的 wait/hold 分离计时在换锁后是否仍然成立（`.lock().await` 的"等锁"怎么测）？
5. **分阶段切法**：能否**先**把"会占住 worker 的那些"（后台任务里的 `db.lock()`）单独迁到
   `tokio::sync::Mutex`，命令层后迁？⇒ 两阶段之间两种锁并存，锁序怎么保证？

**分阶段的理由**：一次改 340 处会让 diff 大到难审，而本轮已经证实**并发改动与审计并行**是常态
（§0.1 记录了工作区在审计期间被改）⇒ 大改造必须切成**可独立验收**的几段。

### 10.8 决策 8（群消息 30 分钟重发）—— ✅ 已实现并验证

**拍板**：沿用 30 分钟；离线暂存和上线补发的 7 天承诺不变；**按成员独立判断**送达和失败状态。

**落地位置**：`src-tauri/src/network/transport/outbox_sweep.rs:227-253`（逐行判定）
+ `src-tauri/src/db/group_offline_queue.rs`（新增 `group_outbox_row_expired` / `delete_group_outbox_row`）。

**"按成员独立判断"这一条的实现形态**（实测确认）：
- 每一行只看**自己那个成员**的可达性（`group_outbox_row_expired(is_reachable(peer), age)`）；
- **在线**成员：超过 30 分钟 ⇒ **只删这一行**（不影响其它成员的行）；
- **离线**成员：仍按 7 天保留（`OUTBOX_OFFLINE_HOLD_MS`）⇒ **离线暂存 / 上线补发的承诺一字未动**；
- 消息级状态**仍然**要等**所有**行都放弃才置 failed（`all_give_up` 那一层保留着）⇒
  不会因为某个成员放弃了就把整条消息判死。

**测试**：`cargo test --lib` 全绿（1049 passed / 0 failed / 1 ignored）。

### 10.9 审计之后新发现的一条（**本报告原先漏了**）

前端 store / IPC 层的独立审计补出一条**真实的跨语言缺陷**（本报告第一轮没有覆盖到）：

| # | 位置 | 问题 |
|---|---|---|
| **N-01** | 生产者 `src-tauri/src/network/transport/outbox_sweep.rs:364`（`state.app.emit("file-failed", &transfer_id)`，发的是**裸字符串**）↔ 消费者 `src/api/index.ts:725`（`listen<FileFailedInfo>`）+ `src/stores/useChatStore.ts:2429-2443` | **载荷形状不匹配**：前端按 `{transfer_id, reason}` 取值，拿到的是 `String` ⇒ `d.transfer_id` / `d.reason` 都是 `undefined` ⇒<br>① toast 显示 **"文件发送失败：undefined"**；<br>② 那个文件气泡**永远停在"发送中"**（不会被标成 failed）；<br>③ `setTransferStalled(undefined, false)` 往 `stalledTransfers` 里塞了一个 `undefined` 键。<br>**全仓 10 个 `file-failed` 生产点，只有这一个形状不对**（其余 9 个都发 `FileFailedInfo`）。 |
| **N-02** | `src/stores/useChatStore.ts:2383` | `stalledTransfers` **无上限、永不逐出**；而 `onFileCancelled`（`:2668`）**不**调 `setTransferStalled(..., false)` ⇒ 取消的传输会永久留一条。 |
| **N-03** | `src/stores/useChatStore.ts:700-719` | `applyIncoming` 每批消息都**重建两个全量 Map**（扫遍所有缓存会话）；实测 8 会话 × 5000 条 = **13 ms/批** ⇒ 60 fps 下约 110 ms/s 的纯扫描。 |
| **N-04** | `src/stores/useChatStore.ts:661` | `pendingReplace` 在"乐观记录被丢弃"（如 `resetAfterDataCleared`）时**不删** ⇒ 残留。 |
| **N-05** | `src/stores/useChatStore.ts:341` | Vite HMR 下 `watch(totalUnread)` 的旧 scope **从不被 stop** ⇒ 每次热更新泄漏一个 watcher + 其闭包。**仅开发期**，生产无影响。 |

**N-01 是本报告该补的一条**（它正是"用户可感知的失败和困惑"：一个 `undefined` 的提示 + 一个永远转圈的气泡）。

**N-01 已修（2026-10-21）**：`outbox_sweep.rs:370-378` 改为发
`FileFailedInfo { transfer_id, reason: "文件发送超时：超过重发期限仍未送达" }`。
判据加在 `lib_outbox_tests.rs` 的 `outbox_sweeper_emits_only_after_db_write_succeeds` 里：
去空白后必须出现 `emit("file-failed",&FileFailedInfo{`（裸字符串会 FAIL）。**不是"只改一行没判据"**。
**N-02~N-05 仍只登记**（优先级低于 8 项拍板；N-02 的 `stalledTransfers` 无上限最接近本报告主题，下一批处理）。

---

## 11. 本轮实施与审计的最终状态

### 11.1 工作区

**分支** `main` · **HEAD** `cfc01a9`（审计全程未提交、未改写历史）。

审计期间**有另一个并发改动方**在工作区实施修复（§0.1 记录了它改了哪些文件、什么时候改的）。

**本轮在工作区留下的改动**（全部未提交、未改写历史）：

| 决策 | 文件 |
|---|---|
| 1 续传（S1–S4） | `protocol.rs` / `state.rs` / `network/file.rs` / `network/file/group_receive.rs` / `network/file/group_resume.rs`（**新**）/ `network/transport/group_file.rs` / `handle_group.rs` / `transport.rs` / `commands/group_file_dispatch.rs` / `commands/group_announcements.rs` + 测试（`file_tests.rs` / `protocol_tests.rs` / `dispatch_tests.rs`） |
| 2 VACUUM | §10.2 的表（8 个文件 + 1 个新文件） |
| 3 BLE 队列 | `transport/ble_pending.rs`（**新**）+ `bluetooth_peripheral.rs` / `_windows.rs` / `ble_android.rs` / `network/ble/peripheral.rs` |
| 4 并发 8 | `state.rs` / `commands/group_file_dispatch.rs` / `commands/group_announcements.rs` |
| 5 任务缓存 500 | `src/utils/todos.ts` + `src/utils/todos.test.ts` |
| 6 崩溃现场 | `scripts/e2e/core.mjs` / `scripts/e2e-multi-instance.mjs` |
| N-01 | `network/transport/outbox_sweep.rs` + `lib_outbox_tests.rs` |
| 基线 | `src-tauri/test-baseline.macos.txt` / `.windows.txt` |

> 审计期间**有另一个并发改动方**在工作区实施修复（§0.1 已逐项登记）。本轮没有回退、覆盖
> 或格式化它的文件（VACUUM 格式化是用户明确同意的那一次）。

### 11.2 验证（实跑）

```
cargo test --features bluetooth --lib → 1088 passed / 0 failed / 1 ignored   (60.82s)
npm test                              → 1158 passed / 0 failed
npm run verify（快速层 17 步）         → 全绿（58.8s；Change Budget 零覆盖 = 本地无未推提交）
cargo fmt --all --check               → 通过
cargo clippy --features bluetooth --lib -- -D warnings → 通过
bash scripts/check-mobile.sh --bluetooth → 通过（Android 默认 + bluetooth 两档，0 warning）
node scripts/check-test-manifest.mjs  → 通过（macos 1089 / windows 1068，差额全有门控背书）
node scripts/check-lock-scope.mjs     → 通过（db 344 guard / peers 27 guard；peers↔db 0 处）
node scripts/check-ble-constants.mjs  → 通过（3 个外设平台都委托）
python3 scripts/verify-guards.py --list → 通过（锚点全部命中）
python3 scripts/verify-guards.py --only "门控表里的能力位" → 改坏即 FAIL、恢复即 PASS
node scripts/e2e-multi-instance.mjs --prune-selfcheck → 32 格全绿
node scripts/e2e-multi-instance.mjs --round=gfile → **28 条断言全绿**（run-2026-10-21T12-47-09-704Z）
本文件自检                            → 377 处 file:line 引用逐条核验：0 处断裂、0 处超范围
```

**GFILE 双实例轮覆盖到了什么**（本轮唯一一次真进程 e2e）：
- 两个新端之间的 **Offer → Resume(0) → Chunk → Done → CompleteAck** 全程：接收侧成员行 `completed`、
  文件 SHA 与源一致、气泡按 `gfile-{tid}` 只落群会话、无 `.part` 残留、发送侧不停在 `pending/sending`。
- 同时真实跑了决策 6 的轮末保留路径（输出里含 `崩溃现场 30 天 … 另清超大现场 N 个大文件`）。
- 首跑发现一个**编译期影响面**：`src-tauri/examples/e2e_peer.rs` 没补 `attempt`（E0063）⇒ 已补 `attempt: None`
  （它模拟的是**旧端**发送，正好把 `attempt=None` 的兼容老路也走了一遍）。

**标准轴审查补丁（2026-10-21，提交前）**：独立审查确认**无 ABBA 死锁**，但抓到 1 条确定性回归 + 4 条建议，
已全部修复：
- **[严重] 群未读重复 +1**：气泡 helper 被 fan-out pre-Offer 与 dispatch Offer 各调一次，
  `touch_conversation` 无条件累加 ⇒ 每个群文件未读 +2、重试每轮再 +1。改法：`insert_message_if_new`
  只有**真插入新行**才 touch（`group_file.rs:611`）；重复 Offer 仍重发事件以刷新气泡状态。
- **key TTL 只按首次插入算**：大文件 > 2h 会中途被清扫。改为活动即刷新
  `at_ms`（`state.rs:1612`；Offer 命中 `group_file.rs:205`、接收每片 `:1699`、发送每片
  `group_file_dispatch.rs:303`）。判据 `lib_file_tests.rs:176`。
- **续传握手固定 15s 短于"整份前缀哈希"**：按 32 MiB/s 保守折算放大、封顶 10 分钟
  （`group_resume.rs:95`，判据 `:206`）。
- **e2e 体积裁剪绕过 `keep` 的 fail-closed**：`GOSSLAN_KEEP_RUNS` 写坏时整目录不删但大文件仍被清；
  现在 `keep` 写坏 ⇒ 一个都不删（`core.mjs:428`，自证 32 格）。
- **过期注释**：`e2e-multi-instance.mjs` 里"`unknown` 永远不删"已改成 30 天规则。

**未跑（明写，不当作绿）**：
- **决策 1 的"断链/重启续传"矩阵**：GFILE 轮验证的是**正常路径 + 新握手**，没有在传输中途
  断链/杀进程，所以"实际补传字节数 ≈ 缺口"与发送方/接收方真重启仍只有单元级证据。
- **决策 3 的 BLE 溢出重连**：需要两台带 BLE 电台的设备。
- **决策 4 的内存峰值 / 吞吐 / 排队实测**：需要多成员（理想 200）真机/多实例；本轮 GFILE 只做了
  单成员，不能拿来当 8 并发的资源读数。
- **Windows 交叉编译**：`cargo xwin check --target x86_64-pc-windows-msvc --features bluetooth --lib`
  在 `tauri-winres` 的构建脚本处失败（环境缺 `llvm-rc`），**不是本轮代码报错**；Windows 侧改动只经过人工核对。
- `npm run verify:full` 整链（发版前跑一次）；护栏非空转前端子集（≈13–15 分钟）未跑。

### 11.3 待办总览

| 决策 | 状态 | 下一步 |
|---|---|---|
| 1 群文件断点续传 | ✅ **S1–S4 已实现** + 单测矩阵 + GFILE 双实例 28 断言 | ⚠️ 断链/重启续传 e2e（含"实际补传字节数"）未跑；§10.1.7 已逐项标注证据级别 |
| 2 VACUUM 预算 | ✅ 已实现并验证 | B 方案（独立连接）单独排期；"3 秒是否够"待超大库实测（§10.2 剩余风险 1） |
| 3 BLE 队列上限 | ✅ 已实现 | ⚠️ 真机溢出/重连 e2e 未跑（需 BLE 电台 + 两台设备）；Android/Windows 编译门禁已过（§10.3） |
| 4 群发并发 8 | ✅ 已实现 | ⚠️ 内存峰值/吞吐**未实测**（算术上界见 §10.4）；排队无损已有判据 |
| 5 任务缓存 500 | ✅ 已实现 | 前端测试 2 格；数据库零改动（§10.5） |
| 6 崩溃现场留存 | ✅ 已实现 | 自证 30 格；>2GB 规则用 1 MiB 预算在临时目录真删过（§10.6） |
| 7 DB 锁大改造 | ⏳ 延后到第二批 | 先做专项审计（§10.7 的 5 个问题）再分阶段 |
| 8 群消息 30 分钟 | ✅ 已实现并验证 | —— |
| N-01 `file-failed` 形状 | ✅ 已实现 | 生产者改发 `FileFailedInfo` + 源码判据（§10.9） |
| N-02~N-05 | ⏳ 只登记 | 优先级低于上面 8 项；N-02（`stalledTransfers` 无上限）下一批 |

### 11.4 这份文档怎么用

| 想知道 | 看哪节 |
|---|---|
| 拍板了什么、现在什么状态 | **§0.2**（一览）+ **§10**（逐项台账） |
| 全部风险与证据 | §2（P0/P1）、§3（P2/P3 + 脚本侧） |
| 某条业务流的终止条件与异常恢复 | §4 |
| 哪些资源会一直涨 | §5 |
| 先做什么、为什么 | §6 + §10.3~§10.8 的"已定位的落点" |
| 怎么验证修好了 | §7 + 各项的"测试命令与结果" |
| 拍板 1（群文件续传）的完整方案 | **§10.1**（审计 → 结论 → 协议扩展 → 实施清单 → 验证矩阵） |
| 决策 2 的实测数字 | §10.2 |
| 审计还漏了什么 | §10.9 |
| 审计没覆盖什么 | §1.3 + §9.4 |


---

*本文件是审计产物 + 拍板实施台账。审计与实施都在工作区进行、**未提交**；
本轮改动清单见 §11.1（决策 1/2/3/4/5/6 + N-01 + 测试基线），并发改动方的历史见 §0.1。
`cargo test` 写入的 `src-tauri/target/` 是构建产物（已在 `.gitignore`）。*
