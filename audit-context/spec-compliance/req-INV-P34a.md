## REQ-INV-P34a — 一次系统调用级的元数据查询不是慢活（余量预检可以留在 async 路径）

> "**口径（判据的事实依据，不是推测）**：那一次查询是**一次系统调用**
> （unix `statvfs` / Windows `GetDiskFreeSpaceExW`），量级是**微秒级**，
> **不读文件内容、不做整份哈希、不 fsync、不随文件大小增长** ⇒ 不属于 INV-P34 管的
> "GB 级慢活"。它留在 async 路径上是安全的。
> ⚠️ **反过来读这条才是重点**：如果哪天余量查询变成"遍历目录统计占用"或"读配额文件"，
> 它就**立刻**变成慢活，必须搬进阻塞线程池并登记进 INV-P34 的家清单。
> 判据（`tests::inbound_space_preflight_tests::inbound_admission_preflights_the_disk_space_with_the_right_folding`）
> 钉住"预检调用的是 `verdict_for(`（一次系统调用）"，而不是任何目录遍历。"
> — docs/protocol-invariants.md §31（INV-P34a）/ INV-P34a, line 1610

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 入站卷余量预检必须留在 async 路径上（它是一次系统调用，不是慢活），且判据必须钉住"它调用的是一次系统调用"这个事实 —— 从而在它哪天变成目录遍历时能被抓住。

**Where enforcement lives:**

**查询本体（一次系统调用）：**

```rust
// src-tauri/src/storage/disk_space.rs:39-53
pub fn available_bytes(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    { unix_available_bytes(path) }
    #[cfg(windows)]
    { windows_available_bytes(path) }
    #[cfg(not(any(unix, windows)))]
    { let _ = path; None }
}

// src-tauri/src/storage/disk_space.rs:108-136（unix：一次 libc::statvfs）
#[cfg(unix)]
fn unix_available_bytes(path: &Path) -> Option<u64> {
    let c = std::ffi::CString::new(path.as_os_encoded_bytes()).ok()?;
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st as *mut statvfs) != 0 { return None; }
        let block = /* unix 上 f_frsize（linux/android）或 f_bsize（mac/bsd） */;
        let avail = st.f_bavail as u64;
        Some(block.saturating_mul(avail))
    }
}

// src-tauri/src/storage/disk_space.rs:142-176（windows：一次 GetDiskFreeSpaceExW）
#[cfg(windows)]
fn windows_available_bytes(path: &Path) -> Option<u64> {
    let wide: Vec<u16> = path.as_os_encoded_bytes().encode_wide().chain(Some(0)).collect();
    let root = volume_root_of(&wide);
    if root.is_empty() { return None; }
    ... GetDiskFreeSpaceExW(root_with_nul.as_ptr(), &mut free_to_caller, ...) ...
    Some(free_to_caller)
}
```

- What it checks, and against what：`available_bytes` 的两个平台实现各自**只调一次**系统调用，**没有**目录遍历、没有读文件内容、没有哈希、没有 fsync ⇒ 符合"不是慢活"的口径。
- Which paths reach it, and which do not：`verdict_for`（`disk_space.rs:81-86`）是唯一对外入口 ⇒ `available_bytes` 只有它一个调用者。

**判定（三态 + 折叠）：**

```rust
// src-tauri/src/storage/disk_space.rs:59-72
pub enum SpaceVerdict { Enough, NotEnough { available: u64, needed: u64 }, Unknown }

// src-tauri/src/storage/disk_space.rs:96-102
pub fn verdict_of(available: u64, needed: u64, headroom: u64) -> SpaceVerdict {
    if available.saturating_sub(headroom) >= needed { SpaceVerdict::Enough }
    else { SpaceVerdict::NotEnough { available, needed } }
}
```

**接线（在准入闸里）：**

```rust
// src-tauri/src/network/file/receive.rs:632-660（admit_inbound 的第三道闸）
// ③ **卷余量预检**（2026-10-27 审计 P1）。
// 三条纪律（`storage/disk_space.rs` 的文件头有完整版）：
// ① **读不到 ⇒ 放行**（`Unknown`）—— 误拒的代价（永远收不下）远大于误放。
// ② 预检**不替代**写失败兜底（那套完整保留：`.part` + 台账 failed + 回 Ack(false)）。
// ③ 一次 `statvfs` 是**系统调用**（微秒级），不是 INV-P34 管的 GB 级慢活
//    ⇒ 允许留在 async 路径上（该 INV 的"边界"段已登记这条口径）。
match crate::storage::disk_space::verdict_for(&dl, size, INBOUND_SPACE_HEADROOM) {
    crate::storage::disk_space::SpaceVerdict::Enough
    | crate::storage::disk_space::SpaceVerdict::Unknown => {}
    crate::storage::disk_space::SpaceVerdict::NotEnough { available, needed } => {
        let msg = format!("code=RECV_DISK_SPACE_INSUFFICIENT transfer={transfer_id} peer={peer_id} size={needed} available={available} headroom={INBOUND_SPACE_HEADROOM} —— 磁盘空间不足，请释放空间后重试");
        ...
    }
}
```

**Paths walked:**
- 入站文件（单聊）→ `handle_file.rs` → `file::begin_receive` / `resume_receive` → `admit_inbound` ⇒ 预检在这里跑 ⇒ **留在 async 路径**（`admit_inbound` 是同步 fn，被 async 路径同步调用）✓
- 入站文件（群）→ `network/transport/group_file.rs` → 同一个 `admit_inbound` ⇒ 同一处 ✓
- 中继入站 → `network/transport/relay_file.rs` ⇒ 同一个 `admit_inbound` ✓（文档说"四条入口共用"）
- `SpaceVerdict::Unknown`（读不到）⇒ 与 `Enough` **同一个 match 分支** ⇒ 放行 ✓（误拒的代价远大于误放）
- `SpaceVerdict::NotEnough` ⇒ 拒绝并留可检索的码 `RECV_DISK_SPACE_INSUFFICIENT` + 余量读数 ✓

**"写失败兜底仍在"（纪律 ②）：**

```rust
// src-tauri/src/network/file/receive.rs:1026-1046（write_chunk 里的写盘失败分支）
r.file.write_all(&plaintext).map_err(|e| {
    let reason = match crate::logging::classify_write_failure(&e) {
        Some(code) => { state.logger.error("file", format!("code={code} transfer={transfer_id} …")); code.to_string() }
        None => e.to_string(),
    };
    reason
})?;
```

**Searched:**
- `statvfs` → `storage/disk_space.rs:129`（唯一一处）✓
- `GetDiskFreeSpaceExW` → `storage/disk_space.rs:161`（唯一一处）✓
- `available_bytes` → `disk_space.rs:39`（定义）+ `:82`（`verdict_for` 内唯一调用）+ `disk_space.rs:328/346/357/364`（用例）⇒ 生产调用点 **1 处** ✓
- `verdict_for` → `disk_space.rs:81`（定义）+ `network/file/receive.rs:648`（唯一生产调用）+ `lib_source_view_tests.rs:531`（判据）⇒ 生产调用点 **1 处** ✓
- `verdict_of` → `disk_space.rs:96`（定义）+ `:83`（`verdict_for` 内）+ 用例
- 目录遍历 → `disk_space.rs` 内 **0 命中**（`read_dir` / `WalkDir` / `walk` 等一律没有）⇒ 判据要钉的"不是目录遍历"成立 ✓
- `admit_inbound` → `network/file/receive.rs:599`（定义）+ 四个调用点（单聊 `handle_file.rs`、群 `group_file.rs`、中继 `relay_file.rs`、以及 `network/file/receive.rs` 内部）⇒ 文档说的"四条入口共用"成立
- `INBOUND_SPACE_HEADROOM` → `network/file/receive.rs:501`（定义，64 MiB）+ `:651`（使用）✓
- `volume_root_of` → `disk_space.rs:189`（定义）+ `:150`（唯一生产调用）+ 用例 ⇒ 卷根解析是**不依赖 Windows API 的纯函数**（文档点名的设计）✓

**Hook verification:**
- `tests::inbound_space_preflight_tests::inbound_admission_preflights_the_disk_space_with_the_right_folding` — **存在**：`src-tauri/src/lib_source_view_tests.rs:525` ✓（基线命中）。它断言五件事：
  ① `admit_inbound` 函数体内出现 `verdict_for(`（预检接在准入闸里，不在别处 ⇒ 别的入口绕不过）
  ② 函数体同时含 `SpaceVerdict::Enough` 与 `SpaceVerdict::Unknown`（三态被区分）
  ③ **`Enough|Unknown => {}` 必须是同一个 match 分支**（`body.contains("{enough}|{unknown}=>{{}}")` 或反向）⇒ 防止「读不到」被偷偷改成拒绝
  ④ 拒绝分支留 `RECV_DISK_SPACE_INSUFFICIENT` + `available={available}` + `size={needed}`
  ⑤ `write_all(&plaintext)` 仍在（预检是 TOCTOU，替代不了写盘兜底）
  - 另有一条**反空转闸**：`branch_heads >= 3`（`:544-548`），"预检的 match 分支数不对 ⇒ 判据自己失效了"
- `storage::disk_space::tests::space_verdict_folds_headroom_into_the_decision` — **存在**：`storage/disk_space.rs:281` ✓（基线命中）
- `storage::disk_space::tests::volume_root_is_parsed_for_drive_and_unc_paths` — **存在**：`disk_space.rs:249` ✓
- `storage::disk_space::tests::available_bytes_is_readable_for_a_real_dir` — **存在**：`disk_space.rs:328` ✓
- `storage::disk_space::tests::available_bytes_is_none_when_the_volume_cannot_be_located` — **存在**：`disk_space.rs:346` ✓（文档的"反向"段点名它）

全部五条钩子存在并注册。

**How the verdict was reached:** 文档的判据要求是"钉住预检调用的是 `verdict_for(`（一次系统调用），而不是任何目录遍历" —— 代码里 `admit_inbound` 的函数体确实只有 `verdict_for(` 一个查询入口，`verdict_for` → `available_bytes` → 单次 `statvfs` / `GetDiskFreeSpaceExW`，链上无目录遍历；判据 `inbound_admission_preflights_the_disk_space_with_the_right_folding` 逐条钉住接线位置、三态同分支、留痕与兜底仍在。文档的三条纪律（读不到⇒放行、不替代写失败兜底、一次系统调用）逐条对上。定为 `implemented`。

**Open questions:**
- 判据的"不是目录遍历"这一半靠什么保证？`lib_source_view_tests.rs:525-574` 只断言 `admit_inbound` 体内含 `verdict_for(` —— 它**不**断言 `verdict_for` 的实现里没有目录遍历。若有人把 `available_bytes` 改成遍历目录统计占用，判据**不会红**（`verdict_for(` 仍在）。这正是文档"⚠️ 反过来读这条才是重点"警告的那个方向 —— 今天的判据**没有**覆盖它。
- 文档说"Windows 那一半在本机**编不出来**（`#[cfg(target_os = "windows")]`），只有 Windows CI 会验；本仓为此把'卷根解析'抽成不依赖 Windows API 的纯函数（`volume_root_of`），让 mac 上的单测也能钉住它" —— `volume_root_of` 的 `#[cfg_attr(not(windows), allow(dead_code))]`（`disk_space.rs:188`）意味着它在非 Windows 上不参与生产路径，仅供测试。
- `verdict_of` 的折叠方向是 `available - headroom >= needed`（水位是**减项**）。文档说"把水位从折叠里去掉（`available >= needed`）⇒ `space_verdict_folds_headroom_into_the_decision` 红" —— 代码里确实是减项 ✓。但这条折叠在**剩余 0 字节**时（`available == headroom`）判 `NotEnough { needed }` ⇒ 一单都不收；这与"误拒的代价远大于误放"的口径是否一致，文档没有正面讨论。
