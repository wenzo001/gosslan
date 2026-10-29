## REQ-INV-P34 — 文件生命周期的 GB 级慢活只许在阻塞线程池里跑

> "| # | 规则 | 今天靠什么成立（逐个指到实物） |
> | 1 | 登记在册的十二处慢活必须**整体**交给阻塞线程池，不许留在 async 路径上 | 单聊收尾 `finish_receiver_into` 与群收尾 `finish_group_receive_into` 由 `tests::receive_finalize_slow_work_happens_outside_the_receiver_lock`、`tests::group_receive_finalize_slow_work_runs_off_the_async_worker` 钉；续传前缀校验 `file::resume_receive` 由 `tests::resume_prefix_hash_runs_off_the_async_worker` 钉；中继链那四格由 `tests::relay_file_lifecycle_slow_work_runs_off_the_async_worker` 一格一条钉；4.40.5 又收三格：另存为 `commands::copy_file`、收藏 `commands::add_favorite`、待办图元数据 `commands::todo_image_meta`；4.40.6 收第十一格 —— 设置里「清除数据」…；4.40.9 登记**第十二格** … |
> | 2 | 判据要按**位置**钉，只数出现次数不算钉住 | 第三条判据同时断言"交出点在续传臂的起点与 `else` 臂之间" |
> | 3 | 交出执行上下文**不等于**可以丢掉那份活儿 | 被交出去的那一段必须还在原地做完整的事（收尾的校验 + fsync + rename；续传的**逐块**喂校验器） |
> | 4 | 线程池的结果不许被吞 | `JoinHandle` 的 `Err` 必须落成 `Err` 走既有拒绝出口。写成 `unwrap_or(Ok(..))` 会**回 Accept 却没注册接收器** ⇒ 整单静默死掉 |
> | 5 | 慢活不许持接收表的锁（这一半不由本条管） | 由 INV-P28 负责 …本条只管"在哪条线程上跑" |
> | 6 | **家清单**是法条的一部分：新增一处慢活不许悄悄出现 | `tests::whole_file_slow_work_never_runs_on_an_async_worker` 遍历生产码 …并把**现算处数**（4.40.9 起 17）与**落在哪几册**（12）都钉成登记值（判据自己打印分母，另有"文件数 > 100"的阳性对照拦"尺子空转"） |"
> — docs/protocol-invariants.md §31（INV-P34）/ INV-P34, line 1644

**Verdict:** partial · confidence: high

**What this demands of an implementation:** 登记在册的 GB 级慢活（整份哈希、整份 fsync、整份复制、整树删除）必须**整体**在阻塞线程池里跑；判据按**位置**钉；交出去的那份活儿不许被删掉；线程池的 `Err` 不许被伪装成 `Ok`；家清单是法条的一部分（新增慢活必须登记）。

**Where enforcement lives:**

**单聊收尾（第一格）：**

```rust
// src-tauri/src/network/file/receive.rs:1300-1312
let st = state.clone();
let transfer_id = transfer_id.to_string();
tokio::task::spawn_blocking(move || finish_receiver_into(&st.db, &st.logger, &transfer_id, r))
    .await
    // 阻塞任务只会在 panic / 运行时关闭时出错；两种都当"这次没收口"上抛 …
    .map_err(|e| format!("接收收尾任务被中断: {e}"))?
    .map(Some)
```

- What it checks, and against what：`spawn_blocking` 交出**整个** `finish_receiver_into`（校验 + fsync + rename），且紧跟 `.await` ⇒ 规则 1（整体）+ 规则 3（活儿还在）+ 规则 4（`Err` 上抛，不伪装成 `Ok`）。`receive.rs:1286-1299` 的摘锁在**闭包外**完成 ⇒ 慢活不持 `file_receivers` 锁（规则 5 的边界，INV-P28 那一半）。
- Which paths reach it, and which do not：`finish_receive`（`receive.rs:1281`）→ 由 `handle_file.rs` 的 FileDone 分支调用。

**群收尾（第二格）：**

```rust
// src-tauri/src/network/transport/group_file.rs:1033
let finalized = match tokio::task::spawn_blocking(move || file::finish_group_receive_into(r))
```

**续传前缀校验（第三格）：**

```rust
// src-tauri/src/network/transport/handle_file.rs:204-209
tokio::task::spawn_blocking(move || {
    file::resume_receive(&st, &tid, &from_owner, &fname, size, file_key, sha, from_bytes)
})
.await
.unwrap_or_else(|e| Err(format!("续传校验任务被线程池中断: {e}")))
```

- 规则 4 的关键：`unwrap_or_else(|e| Err(...))` —— 线程池 `Err` 落成 `Err` ⇒ **不会**"回 Accept 却没注册接收器" ✓

**中继链四格：**

```rust
// src-tauri/src/network/file/relay_push.rs:82
let file_sha256 = tokio::task::spawn_blocking(move || sha256_file_hex(&hash_path))
// src-tauri/src/network/transport/relay_file.rs:195 / :339 / :415
tokio::task::spawn_blocking(move || { … relay.add_chunk(&tid, seq, &bytes) … })   // 重组 + 完成片 fsync
tokio::task::spawn_blocking(move || file::sha256_file_hex(&p))                    // 接收侧整份 .part 哈希
tokio::task::spawn_blocking(move || move_received_file(&st, &nm, &pp))             // 落盘（rename / 跨卷整份 copy）
```

**群台账补账（第十二格）：**

```rust
// src-tauri/src/network/file/ledger_backfill.rs:239
tokio::task::spawn_blocking(move || { … sha256_file_hex(&target) … })
```

**分母判据（家清单是法条）：**

```rust
// src-tauri/src/lib_relay_data_tests.rs:445-465（受保护的名字清单）
const PRIMITIVES: [&str; 10] = [
    "sha256_file_hex(", "sync_all()", "add_chunk(", "resume_receive(",
    "finish_receiver_into(", "finish_group_receive_into(", "move_received_file(",
    "std::fs::copy(", "std::fs::remove_dir_all(", "clear_dir_contents(",
];

// src-tauri/src/lib_relay_data_tests.rs:467-481（登记的"家"清单 = 12 册）
let registered: Vec<&str> = vec![
    "commands/favorites.rs", "commands/group_announcements.rs", "commands/group_todo_media.rs",
    "commands/helpers.rs", "commands/mobile_picker.rs", "network/file/ledger_backfill.rs",
    "network/file/receive.rs", "network/file/relay_push.rs", "network/file/send.rs",
    "network/transport/group_file.rs", "network/transport/handle_file.rs",
    "network/transport/relay_file.rs",
];
```

```rust
// src-tauri/src/lib_relay_data_tests.rs:567-572（分母：现算处数与登记处数相等）
assert_eq!(total, 18, "整份慢活现数到 {total} 处、登记 18 处。…");
assert!(offenders.is_empty(), "INV-P34：整份文件级慢活不许跑在 tokio worker 上…");
// src-tauri/src/lib_relay_data_tests.rs:616-621（家清单相等）
assert_eq!(homes, registered, "整份慢活的「家」清单与登记不一致…");
```

**规则 2（按位置钉）：**

```rust
// src-tauri/src/lib_file_tests.rs:707-716
let bl = flat.find("tokio::task::spawn_blocking(");
"spawn_blocking 必须就在续传那一格里（续传臂起点 {at}、臂尾 {arm_end}、实得 {bl}）"
```

**规则 3（活儿不许被删掉）：** `lib_file_tests.rs:576-580` 断言 `flat.contains("tokio::task::spawn_blocking(move||finish_receiver_into(")` —— 即"交出的是**真的那一份活**"，不是"交出点还在但活被删了"。

**Paths walked:**
- 单聊收尾 → `spawn_blocking(finish_receiver_into)` + `.await` ✓
- 群收尾 → `spawn_blocking(file::finish_group_receive_into)` ✓
- 续传前缀校验 → `spawn_blocking(file::resume_receive)` + `.await` + `unwrap_or_else(|e| Err(..))` ✓
- 中继发送前哈希 → `spawn_blocking(sha256_file_hex)` ✓
- 中继重组（含完成片 fsync）→ `spawn_blocking(relay.add_chunk)` ✓
- 中继接收整份校验 → `spawn_blocking(file::sha256_file_hex)` ✓
- 中继落盘 → `spawn_blocking(move_received_file)` ✓
- 另存为 / 收藏 / 待办图元数据 → `commands/helpers.rs` / `commands/favorites.rs` / `commands/group_todo_media.rs`（家清单里）✓
- 清除数据整树删除 → `commands/favorites.rs` 的 `clear_dir_contents`（由 `spawn_blocking` 驱动）✓
- 群台账一次性补账整文件哈希 → `network/file/ledger_backfill.rs:239` ✓

**Searched:**
- `spawn_blocking` → 全仓生产命中约 60+ 处（`commands/` 约 30、`network/` 约 25、`transport/` 若干）。慢活相关的（`sha256_file_hex` / `sync_all` / `add_chunk` / `resume_receive` / `finish_receiver_into` / `finish_group_receive_into` / `move_received_file` / `std::fs::copy` / `std::fs::remove_dir_all` / `clear_dir_contents`）全部在池内 ✓（由分母判据实测确认）
- `sha256_file_hex` → `network/file/send.rs:67`、`network/file/relay_push.rs:82`、`network/transport/relay_file.rs:339`、`commands/group_announcements.rs:289`、`network/file/ledger_backfill.rs`（补账那处）、`network/transport/outbox_sweep.rs:543` ⇒ **全部**在 `spawn_blocking` 里
- `std::fs::copy` → 家清单含它（4.40.5 补的），`commands/helpers.rs` / `commands/favorites.rs` 的调用在池内
- `std::fs::remove_dir_all` → 家清单含它 + `clear_dir_contents`（4.40.6 补的 helper 名）⇒ 拦得住"把整树删除搬回 async 体里就地调"
- `sync_all()` → `network/file/receive.rs`（`finish_receiver_into` 内）+ `file_relay.rs`（`add_chunk` 内）+ `network/file/group_receive.rs`（`finish_group_receive_into` 内）⇒ 都在池内
- **盲区①**（分母认的是**名字**）：新增一类"同步 helper 里藏着整份慢活"（新函数名）不在 `PRIMITIVES` 清单里 ⇒ 分母判据看不见。判据自己的注释（`lib_relay_data_tests.rs:434-438`）如实写了这个边界，并要求"加名字时要在 `docs/migration-ledger.md` 第 13 行说一句"。
- **盲区②**（包了却不 `.await`）：分母判据**判绿**（它只看"这活不在 worker 上"），只有按格点名的那条判据红。判据注释（`lib_relay_data_tests.rs:572-576` 的断言文案）明写这一点。
- `std::fs::read` **故意不进**清单（`lib_relay_data_tests.rs:442-444`：它与"读一份 8 KB 配置"字面同形，数进来等于把尺子稀释成噪声；预览那三格的有界性由同体内的 `max_bytes.min(15 MiB)` 保证）⇒ 与文档规则 6 一致

**Hook verification:**
- `tests::receive_finalize_slow_work_happens_outside_the_receiver_lock` — **存在**：`src-tauri/src/lib_file_tests.rs:551` ✓（基线 `:1172` 有登记）。它同时钉两件事：摘锁形状（`letr={letmutrecv=state.file_receivers.lock()`）+ 慢活整体在 `spawn_blocking` 里（`flat.contains("tokio::task::spawn_blocking(move||finish_receiver_into(")`）
- `tests::group_receive_finalize_slow_work_runs_off_the_async_worker` — **存在**：`lib_file_tests.rs:596` 起（断言 `tokio::task::spawn_blocking(move||{file::finish_group_receive_into(r)})` 或 `move||file::finish_group_receive_into(r)`）✓（基线 `:1136`）
- `tests::resume_prefix_hash_runs_off_the_async_worker` — **存在**：`lib_file_tests.rs:694` 起 ✓（基线命中）
- `tests::relay_file_lifecycle_slow_work_runs_off_the_async_worker` — **存在**：`src-tauri/src/lib_relay_data_tests.rs:338` ✓（基线 `:1176`）。它逐格钉三件事：包进了 `spawn_blocking`（`wrap`）、紧跟 `.await`（`awaited`）、旧写法没回来（`!legacy`），并用**相等**（不是 `>=`）钉死 `handle_relay_chunk` 的 3 次与 `relay_push_file` 的 1 次
- `tests::whole_file_slow_work_never_runs_on_an_async_worker` — **存在**：`lib_relay_data_tests.rs:441` ✓（基线 `:1213`）
- `network::file::gfile_ledger_backfill_tests::group_ledger_backfill_hashes_off_the_async_worker` — **存在**：`src-tauri/src/network/file/ledger_backfill_tests.rs:411` ✓（基线命中）。它钉三件事：本册的整文件哈希**恰好 1 处**、它在 `spawn_blocking` 闭包里且闭包外紧跟 `.await`、事务写法与 `tx.commit()` 各恰好 1 处
- 全部 6 条钩子存在并注册。

**How the verdict was reached:** 十二处登记慢活逐格都在 `spawn_blocking` 里（人工复核了单聊收尾、群收尾、续传前缀校验、中继四格、补账那格；其余由分母判据实测）；规则 2 的位置断言在（`lib_file_tests.rs:707-716` 钉"交出点必须在续传臂的起点与 else 臂之间"）；规则 3 有"交出的必须是那份活"的断言；规则 4 有 `unwrap_or_else(|e| Err(...))` 的实参与断言；规则 6 的家清单是 12 册 + 分母相等断言 + "文件数 > 100"的阳性对照。但——**文档规则 6 自己写死的那两个数已经漂移**：文档说"现算处数（4.40.9 起 **17**）与落在哪几册（**12**）都钉成登记值"，而判据 `lib_relay_data_tests.rs:596-604` 钉的是 **`total == 18`**（断言文案也写"登记 18 处"）。家清单 12 册不变。定为 `partial`：不变量本身（GB 级慢活不许钉住 tokio worker）有完整的机器强制且覆盖了文档点名的每一格；漂移的是**文档里写死的那个数**（17 vs 18）与判据自陈的两处盲区（新增 helper 名不在清单看不见、包了不 await 分母判绿）——后者是文档自己登记的边界，不是实现缺失。

**Open questions:**
- 文档规则 6 写"现算处数（4.40.9 起 17）"，判据实际钉 **18**。文档与判据的数字不同步（文档那一节写于 4.40.9，之后又补了一格）。
- 文档规则 6 写"落在哪几册（12）"，判据的 `registered` 也是 12 册 ⇒ 这一半一致。
- 文档规则 6 说"清单里那 10 个名字（现算看 `lib_relay_data_tests.rs` 的 `PRIMITIVES`）" —— 实测 `PRIMITIVES` 是 **10** 个 ✓，但文档同段又说"4.40.9 起 17"（处数）与"12"（册数），三个数字混在一句里，容易读错。
- 文档"边界"段自陈：① 分母判据认的是名字（新增 helper 名看不见）；② "包进了池子但不等它（丢掉 JoinHandle）"分母判绿、只有按格点名那条红。这两条在代码里成立（`lib_relay_data_tests.rs:434-438` 与 `:572-576` 的断言文案都写着）。
- 文档"更正"段说"12 处家今天都在池子里了" —— 实测 `registered` 12 册与判据一致 ✓，但"十二处"这个数在文档里出现了四次（§27 表格 / 规则 1 / 台账第 6 行 / 边界段），其中一处是 17/18 的漂移。
- 文档提到的 `commands/channel.rs:384` 与 `commands/network.rs:370` 是 `let _ = spawn_blocking(...)`（丢 JoinHandle）—— 本次未复验这两处。
- 前端那一半（`src/utils/filePreview.ts:142/180/219` 三个归一点各写一遍 `new Uint8Array(raw)`）—— 本条未复验。
