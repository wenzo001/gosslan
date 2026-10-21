# reliability-silence — 静默失败 / 崩溃面 / 线程锁 / 竞态幂等 / 前端释放（只读审计）

审计日期：2026-10-16。范围：`src-tauri/src`（129 个生产 `.rs`，另 37 个 `*_tests.rs`）+ `src`（84 `.vue` / 191 `.ts`）。
立场：本仓「静默失败最危险」——界面看着正常、账已经错。
约束：只读，未编译、未跑 cargo 门禁、未 commit。仅 `node scripts/check-invariant-hooks.mjs`、`check-lock-scope.mjs`、`check-doc-numbers.mjs` 已实际运行（秒级）。
计数口径：下文「生产」= 每个文件从其首个顶层 `#[cfg(test)]` 之前算起（Rust 惯例把测试模块放文件尾）；已按此把测试噪声剔掉。

---

## 1. 崩溃面

原始全仓（含测试）计数：`.unwrap()` 1330、`.expect(` 247、`panic!` 74、`unreachable!` 4。
生产码（剔 `#[cfg(test)]` 与 `*_tests.rs`）真实计数：**`.unwrap()` 8、`.expect(` 20、`panic!` 3、`unreachable!` 1**，共 32 处。
即：绝大多数 unwrap 在测试里；受扫生产码的崩溃面极小，且逐条核过后**基本都有就地护栏**（详见每条判定）。

按「能否被外部输入 / 网络对端 / 磁盘状态点亮」排序的前 12 处：

1. `src-tauri/src/transport/relay_seal.rs:483` — `self.body_need.unwrap()`：吃对端/中继**字节流**的状态机，async worker。**判定：安全**——466 行 `if self.body_need.is_none()` 分支内必 `continue`（481），走到 483 说明此处必为 `Some`；且对端长度在 472-475 已校验 `len==0 || len>MAX_FRAME ⇒ Err`。风险仅在于护栏被未来一次编辑破坏，故列第一。
2. `src-tauri/src/transport/relay_seal.rs:488` — 同上，`self.body_need.unwrap()==0`，486 行刚写 `Some(need-take)`，必 `Some`。**安全（就地不变式）**。
3. `src-tauri/src/transport/relay_seal.rs:573` / `:578` — 解密/开记录侧的同型副本，同样受 466 式不变式保护。**安全**。
4. `src-tauri/src/network/ble/central.rs:545` — `unreachable!("read_hello_frame 只返回 Hello")`：BLE 对端 hello 握手，async。**判定：安全**——`read_hello_frame`（`central.rs:705`）只有 `PreambleAction::Hello` 分支 `return Ok(frame)`，而该分支由 `matches!(frame, Message::Hello)` 门控（726），非 Hello 一律 Err。契约成立。
5. `src-tauri/src/transport/ble_android.rs:170` / `:281` / `:294` — `panic!("未登记的 Kotlin 方法：{other}")`：`name` 来自**内部固定调用点**（`"start"`/`"isConnected"`…），非对端可控；但在 JNI `with_env` 回调内 panic 会向 JNI 层展开。**判定：仅由代码回归点亮，低-中**。
6. `src-tauri/src/network/ble/peripheral.rs:201` — `pending.take().expect("pending 刚被设置")`：BLE 外设帧路径，async。190 行 `Some(bytes)`，`Ok` 分支 `continue` 不落到后续，故到达即 `Some`。**安全（就地不变式）**。
7. `src-tauri/src/network/ble/peripheral.rs:214` — `pending.expect("未投递的帧必须还在")`：send 失败时 205 行回填 `Some(e.0)`，仍 `Some`。**安全**。
8. `src-tauri/src/commands/group_file_keys.rs:68` — `src.unwrap()`：`src` 是 `db::get_transfer_path`（读库+`fs::metadata`，吃磁盘）返回的 `Option<String>`；`ok`（63-66）为 true 蕴含 `src` 为 `Some`。**判定：安全但脆弱**——依赖 63-66 与 68 的非局部耦合，改 `ok` 口径即可能 panic。磁盘可点亮，列此。
9. `src-tauri/src/file_relay.rs:230` — `.expect("刚拿_mut过")`：`reassemblies.remove(transfer_id)`，先前 `get_mut` 成功才有此行；文件重组完成时（`rename` 前 `sync_all` 之后）。**安全（同键不变式）**。运行在 `spawn_blocking`（`relay_file.rs:163`）内。
10. `src-tauri/src/gossip_engine.rs:75` — `d[..8].try_into().unwrap()`：`d` 是固定 32 字节 SHA-256 摘要，切片与 `try_into` 恒成立。**判定：不可能点亮**（列出以正视听——它是「看起来像」但实际安全的一类）。
11. `src-tauri/src/android_open.rs:96`（及 139/179/227/259/282 同行） — `.expect("ready() 已确认类引用存在")`：启动 bootstrap 顺序不变式，非外部输入。**判定：低**。
12. `src-tauri/src/lib.rs:634` — `.expect("error while building tauri application")`：构建期失败即不起窗，属既定设计落点。**判定：低（有意）**。
（其余 `.expect` 为编译期常量 `Uuid::parse_str` / 元组序列化，不可能运行时失败。）

结论：**不存在「对端可控数据未校验即 unwrap」的真实开放格子**；12 处里最高的两处（relay_seal / central）都被就地不变式或函数契约封死，唯一值得盯的是 8/9 的脆弱不变式耦合。

---

## 2. 静默面

生产码吞错原语（剔测试）分模块统计（`模块 = 顶层目录`）：
`let _ =` **311**、`unwrap_or(..)` **145**、`.ok();` **116**、`unwrap_or_default()` **99**。
按模块：**network 317**、**commands 218**、transport 38、state.rs 24、db 15。

其中「吞掉的是账」（`let _ =` / `.ok();` 落在 db 写 / 状态 / emit）实测 **223 处**。

**同一语义既留痕又吞掉的重复（本仓最危险的一类）**：

- `db::insert_message` —— 用户发送侧把写失败**上抛并带文案**：`commands/chat.rs:370` `map_err("消息写入失败：{e}")?`、`commands/files.rs:695` `?`、`commands/window.rs:275` `?`；而**接收侧一律 `.ok();` 吞掉**：`commands/group_announcements.rs:340`、`commands/share.rs:227`、`network/transport/group_file.rs:126`、`network/transport/handle_file.rs:512`、`network/transport/relay_file.rs:464`。**收到的一条消息若落库真失败（磁盘满/非 msg_id 约束冲突），既不进 UI 也不留痕**——正是「界面看着正常、账已经错」。5 个吞点、0 个接收侧留痕。
- `db::set_message_status` —— `network/transport/outbox_sweep.rs:17` 用 `.is_ok()` 判并动作、`db/file_transfer.rs:124/130` 参与 bubble 判定；而 `delivered`/`read` 前进在 6 处接收/群路径被吞：`network/file/send.rs:597`、`network/transport/gossip.rs:545`、`handle_group.rs:83`、`handle_messaging.rs:190`、`group_file.rs:208/586`。同一「送达事实」一处用、一处丢。
- `db::update_group_file_recipient` —— 12 个调用点里 **11 个 `let _ =` 吞**，仅 `network/transport/group_file.rs:363`（completed 终态）显式处理。群文件每个收件人的进度/状态行基本 fire-and-forget。
- `db::finalize_file_failure` —— `commands/files.rs:294` 与 `network/transport/outbox_sweep.rs:37` 走 `.unwrap_or(false)`、`commands/files.rs:475` `let _ =`：文件失败终态化被吞，可致「卡在 X%」。

**INV-P「留痕」判据核跑情况**：
`node scripts/check-invariant-hooks.mjs` → **绿**：`34 条全部绑定（具名钩子 34、无自动化 0）· 形态 rust:91 e2e:3 guard-case:15 frontend:21 script:5`，退出码 0。
但要点：该脚本只判**绑定是否可解析**（测试名/脚本存在），**不判**上面这些接收路径 `.ok();` 是否有「某格必须有留痕」的判据。现有留痕类不变量（INV-P16 错误须有语义，钩子在 `src/utils/errors.test.ts`；INV-P10/14/15）覆盖的是协议/身份/密文/事件语义那一族，**接收侧落库吞错没有对应的留痕门**。因此「checker 全绿」不等于「这 223 格有留痕」——这是账上真实的空白。

---

## 3. 线程与锁模型

- **单一 SQLite 连接 + 一把 `Mutex<Connection>`**，前端每个 IPC 抢同一把锁。锁中毒约定**已文档化**（`state.rs:828`：一律 `lock().unwrap_or_else(|e| e.into_inner())`，禁止 `.lock().unwrap()`）。实测生产码 **0 处** `.lock().unwrap()` / `.read().unwrap()` / `.write().unwrap()`——约定完全落地，避免了「一次 panic 级联点炸全部加锁」。
- **「持锁 emit」格子：0**。`node scripts/check-lock-scope.mjs` → 绿：`300 个 guard 绑定 + 19 个语句临时量全部判过，没有一处锁活着时 emit`（INV-P25）。这条同时是 roadmap §1.1 第 46 行登记的判据，实跑一致。
- **持锁做 GB 慢活**：未发现。慢活（`sync_all` / 整文件 `sha2` / `std::fs::copy` / `remove_dir_all` / 收尾改名）都在 `spawn_blocking` 闭包内做，且取锁在闭包里、锁生命周期不跨 `emit`。
- **`spawn_blocking` 使用**：生产码 22 处。慢活原语（受扫生产码）实测 **22 处**：`sha256_file_hex×6`、`sync_all×4`、`std::fs::copy×4`、`std::fs::read×3`、`std::fs::write×4`、`remove_dir_all×1`。其中 `std::fs::read/write` 按 INV-P34 设计**故意不入尺**（与「读 8KB 配置」字面同形，见 `protocol-invariants.md` INV-P34 规则 6），真正「整份」的 15 处（sha2/sync_all/copy/remove_dir_all）逐条回溯**均在池上**：如 `file_relay::add_chunk`（含完成片 `sync_all`，`file_relay.rs:233`）唯一生产调用点 `network/transport/relay_file.rs:165` 在 `spawn_blocking`（:163）内；`clear_dir_contents` 的 `remove_dir_all`（`commands/favorites.rs:478`）由 `:608` `spawn_blocking` 驱动。
- **「同步 fn 挂 `#[tauri::command(async)]`」误判区**：INV-P34 文档已专门更正——`commands::copy_file` / `add_favorite` / `todo_image_meta` 原属此类、曾被误判成「已在池外」，现由分母判据按形状盯（`whole_file_slow_work_never_runs_on_an_async_worker`：体起点认 `async fn` 与紧贴 `#[tauri::command(async)]` 的同步 `fn`）。本应用只有一个 tokio runtime，钉住 worker 即界面失灵——该不变量正是为此而立。
- **遗漏 / 盲区**：`commands/channel.rs:384` 与 `commands/network.rs:370` 是 `let _ = spawn_blocking(...)`（丢弃 `JoinHandle`）。这正是 INV-P34 **自认的盲区**（`protocol-invariants.md:1370`：「包了 spawn_blocking 但把 JoinHandle 丢了，分母看不见」）。`network.rs:370` 只是刷角标，无害；`channel.rs:384` 内为目录操作，任务 panic 会静默。

---

## 4. 竞态与幂等

- **重发去重不是只看帧级 id**。权威家在 DB：`db::insert_message_if_new`（`db/messages.rs:28`）用 `INSERT OR IGNORE INTO messages(msg_id,…)`，`msg_id` 唯一约束是**语义级、可持久**的去重（对应 INV-P14「DB 不是缓存」）。帧级/内存级去重只是有界 best-effort：`gossip_engine.rs`（`LruSet`+`BloomFilter`，INV-P07 收敛）、`mesh/router.rs:15/139`（转发去重，TTL=0 帧不得污染表——具名测试 `router.rs:369`）、`file_relay.rs:222 received.insert(seq)`（分片 seq，INV-P17）、`content/store.rs`（内容寻址 hash 去重）、`network/transport/handshake.rs:339` `first_sighting`（好友申请通知去重）。**合计约 6 个「去重家」**，帧级 LRU 只兜并发热点、DB `msg_id` 才是幂等底线（符合 INV-P02/P06）。
- **乐观 UI 被过期快照点亮**：有专门护栏。`src/utils/staleGuard.ts` `StaleGuard`（按 key 计数，令牌只答「我是不是最新」）；`stores/useChatStore.ts:1230` 按会话分桶的加载竞态守卫；`:677`/`:1357` 用 `furthestStatus` 把快照与「查询期间已推进的内存状态」合并（防旧快照把刚亮的绿勾退回「发送中」）；`:853-868` 未读「乐观清零 + 水位窗」防清零前的旧快照把红点亮回来，水位窗刻意丢弃过老 key「以免 Map 无界增长」。`StaleGuard.seq` 无显式淘汰但按 key（会话/流）基数增长——有限实体，可接受。
- **ACK/回执终态是否可被回翻**：
  - `db::set_message_status`（`db/messages.rs:272-280`）带单调闸：`WHERE … status NOT IN ('read','delivered','recalled')` ⇒ 终态不可回退。
  - `db::upsert_transfer`（`db/file_transfer.rs:32-38`）终态闸 `WHERE file_transfers.status <> 'done'` ⇒ 有磁盘证据的 `done` 不可降级（INV-P26）。
  - **但 `db::update_message_content`（`db/messages.rs:286-296`）写 `status` 无闸**：`UPDATE … SET content=?, status=? WHERE msg_id=?`。群文件 Done 回填时若对一条已 `read` 的行写 `delivered`，会 read→delivered 回翻。这是第二个「写状态的家」，未复用单调闸——窄但真实。
  - 「39 个写入点」口径核对：`upsert_transfer` 生产直接调用点我实测约 **30**（`db/file_transfer.rs:22` 注释与 INV-P26 均称 39；差值或含别名/宏/口径）。不影响保护——闸在 SQL 语句层，与调用点数无关。

---

## 5. 前端

- **释放路径**：事件订阅集中在 `src/api/index.ts:614 bindEvents(h)` → `Promise.all([...listen…])` 返回 `UnlistenFn[]`；`stores/useChatStore.ts` 以 effect scope 收尾——`:1509 unlisten()`、`:2632 scope.onDispose(stopRemindChannelWatch)`、`:2372 chatInitScope?.dispose()`（`utils/initScope.ts`）。blob/objectURL 释放集中在缓存层（见下）。
- **`onUnmounted` 覆盖率**（`.vue`）：含 `onMounted` 的文件 **21**、含 `onUnmounted`/`onBeforeUnmount` 的 **25**（清理多于挂载）；出现次数 `onMounted(×24` vs `onUnmounted(/onBeforeUnmount(×30`。事件 `listen(` 站 12 处，`unlisten` 引用 44 处；`setInterval(×3` vs `clearInterval(×6`；`createObjectURL×7` vs `revokeObjectURL×18`。**账面净正向、无「只订不释」明显格**。
- **只增不减的 Map/Set（按名字找）**：模块级仅 3 类常量集合（`VOID_TAGS`/`TRUE_WORDS`/`byName` 等，冻结），非增长。消息/预览类缓存**都有界**：`utils/messageHeight.ts:107 bubbleCache` 走 `BUBBLE_CACHE_MAX` FIFO 淘汰（`:116-118`）；`utils/blobLru.ts` 是按**累计字节数**封顶的 LRU，逐出/delete/clear/覆盖**四条路都 revoke**（文件头记 2026-09-21「共用 objectURL 被别处 revoke 打回裂图」的根因，回收出口唯一）；`utils/filePreview.ts` / `favoritePreview.ts` 用它，`useChatStore.ts:1032/2213` 在清会话/清数据时显式丢预览缓存并释放。`utils/bounded.ts` 提供按条数 FIFO 闸（预览不用它，改 blobLru）。**未发现无界增长的生产缓存**。
- **虚拟列表 / 无界 DOM**：`components/VirtualList.vue` 只渲染 `[start,end]` 窗口 + `overscan=6`（`:116-118`）；DOM 有界。图片行高与骨架共用常量（`utils/previewMetrics.ts IMAGE_BUBBLE_HEIGHT=288`），无「整表前缀和每图重算」放大。

---

## 6. 与 stability-roadmap §1/§3/§4 的关系

路径订正：**`docs/acceptance/stability-roadmap.md` 不存在**；roadmap 实际在 **`docs/stability-roadmap.md`**（§1 现状架构判定 @32、§3 现有任务逐条重判 @201、§4 Completed/Invalid/Dup/Missing @301，另 §2 风险登记 @74）。逐条对照：

| 本审计发现 | roadmap 归属 |
|---|---|
| 生产崩溃面小、逐条有护栏（§1 整节） | **roadmap 没有**——§2 风险表无「unwrap/panic 生产清单」这一格 |
| 接收侧 `insert_message` / `set_message_status` `.ok();` 吞错无留痕（§2） | **部分**：文件 offer 期静默=**A-10**（:231，待拍板）；单聊收尾不写内容台账=**A-14**（:497，已修）；但「接收路径落库吞错」本身**没有单独格子/留痕门** |
| `update_group_file_recipient` 11/12 吞、`finalize_file_failure` 吞 | **roadmap 没有**对应格子 |
| 单连接单锁 + emit 出锁 + `.lock().unwrap()` 约定（§3） | **已登记**：§1.1 第 46 行（INV-P25，钩子 `check-lock-scope.mjs`）；§1.3 第 68 行「单全局 Mutex + emit 出锁是已落地取舍」；`state.rs:828` 约定 |
| GB 慢活只在 `spawn_blocking`（§3 的 22 原语/15 重活） | **roadmap 没有**——INV-P34（`protocol-invariants.md`）体系在 roadmap 里 **0 次出现**；最接近是 §12 第 493 行「锁内不许秒级慢活」但只讲 db/clocks |
| `let _ = spawn_blocking` 丢 JoinHandle（channel.rs:384 / network.rs:370） | **roadmap 没有**；INV-P34 自认盲区（:1370），roadmap 未记 |
| 去重多 / DB `msg_id` 兜底、非帧级（§4） | **已登记**：第 1205-1206 行（接收按 `message_id` 去重、`group_members` 不入 `compute_message_id`）；**C-7**（:274 LRU 只覆盖 4 会话）、**D-10**（:290 gossip 解密前去重） |
| 乐观 UI 被旧快照点亮 + StaleGuard（§4） | **部分**：风险「后发先至」=**B-5**（:256，useAppStore 冻面）；但 `src/utils/staleGuard.ts` 这套机制本身**无格子** |
| ACK 终态可回翻 / `done` 不可降级（§4） | **已登记**：**A-15**（:498，GroupAck 补写发起方 `delivered`，已修，引用同一单调 WHERE）；INV-P26 闸。唯 `update_message_content` 无闸这一格 **roadmap 没有** |
| blob/objectURL 缓存回收（§5） | **已登记**：**N23**（:1065）；但 N23 正文仍写「仍未动码 / 动码等点头」，而 `utils/blobLru.ts` 已按其结论实现字节预算 LRU + 四路 revoke ⇒ **roadmap 落后于代码**。骨架高度=**N22**（:1065，已落地） |
| `onUnmounted`/事件/timer/blob 释放覆盖（§5 整节） | **roadmap 没有**「前端生命周期/释放覆盖率」这一格（当前实测健康，但无登记判据） |
| VirtualList 有界 DOM（§5） | **roadmap 没有**专属格子（仅作为 `perf/vlist` 量具出现在 N22/N23） |
| §1.2「登记不变量 26」（:60-61） | **数字漂**：实测 `^### INV-P` = **34**，`check-invariant-hooks.mjs` 亦报 34 全绑定；`check-doc-numbers.mjs` 对账了门禁步数/E2E 断言/护栏条数/取锁点，**未覆盖 INV-P 总数** ⇒ 26 是未受保护的旧硬数字 |

**一句话账**：roadmap 把「锁内 emit」「终态不可降级」「去重按 message_id」「blob 缓存」这四族钉得很实（且我实跑判据一致），但**崩溃面清单、接收路径落库吞错的留痕门、INV-P34/spawn_blocking 与丢 JoinHandle、前端生命周期覆盖率**这四格 roadmap 里没有；另有 §1.2 不变量数（26 vs 实 34）与 N23 状态（正文未动码 vs `blobLru.ts` 已实现）两处「roadmap 落后于代码」的漂移。
