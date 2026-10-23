// 群接收：一个群文件对**多个成员**各建一个接收器。
//
// 为什么单独一册：单聊那份状态按 `transfer_id` 一格，群那份是 `(transfer_id, member_id)` 一格，
// 取用/失败/接管三个动作都要按成员展开 —— 这是"同一条链的第二个受众维度"，最容易和单聊那册
// 互相漏改，所以自成一本。
//

// 恒等判据（与 transport 那五刀同一套）：`cargo test --features bluetooth --lib -- --list` 用例名差集 0 行、
//   `verify-guards.py --list` 每条锚点恰好命中一次（本模块的锚点由 runner 沿 include! 树自动解析 ⇒ 不动 Case 的 file=）、
//   clippy `-D warnings`、`cargo fmt --check`。
// ⚠️ 搬家同批必须做的两件事：`network/mod.rs::file_src_for_guards()` 登记本册（漏了=形状守卫看不见这段生产码，假绿），
//   以及 `docs/domains.data.mjs` 的 transport/file 领域 paths（漏了=判据 D 报无主文件）。

/// 群文件接收：创建 `.part` 接收状态。
/// 路径安全（safe_file_name + downloads 目录内 unique_path）与一对一相同；
/// 不写 file_transfers——群文件的进度/状态记录在 group_files /
/// group_file_recipients 表中。
pub fn begin_group_receive(
    state: &AppState,
    transfer_id: &str,
    peer_id: &str,
    name: &str,
    size: u64,
    file_key: [u8; 32],
    expected_sha256: String,
) -> Result<PathBuf, String> {
    let final_path = make_receiver(
        state,
        transfer_id,
        peer_id,
        name,
        size,
        file_key,
        expected_sha256.clone(),
        &state.group_file_receivers,
    )?;
    // 持久化本地路径到 file_transfers（复用现有表，无 schema 变更）：
    // 群文件气泡的打开/另存/历史加载经 transfer_id 关联到该真实本地路径。
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::upsert_transfer(
            &dbc,
            transfer_id,
            peer_id,
            name,
            size,
            "receive",
            "active",
            Some(final_path.to_string_lossy().as_ref()),
            0.0,
        )
        .ok();
        // 统一状态：群文件接收一开始就登记 Active（cid → 暂无 path）。
        // 中途失败由 fail_group_receive 标 Incomplete ⇒ 建链自动重取
        // （群成员也能做种，原发送方不在也能从别人取）。
        let now = db::now_ms();
        let rec = crate::content::model::TransferRecord {
            cid: expected_sha256.clone(),
            transfer_id: Some(transfer_id.to_string()),
            peer_id: peer_id.to_string(),
            group_id: None,
            name: name.to_string(),
            size,
            direction: crate::content::model::Direction::Receive,
            status: crate::content::model::TransferStatus::Active,
            received: 0,
            attempts: 0,
            next_attempt_at: 0,
            last_error: None,
            path: None,
            created_at: now,
            updated_at: now,
        };
        let _ = crate::content::store::upsert(&dbc, &rec);
    }
    Ok(final_path)
}

/// 保留前缀重建群接收器（真续传 S2）：校验 `.part`、**分块**喂哈希器、append 打开。
///
/// 只做阻塞 I/O ⇒ 调用方必须放 `spawn_blocking`。返回 `Err` = 前缀不可用
/// （长度/年龄/读盘失败），调用方回 `GroupFileResume(0)` 并记录原因，整份重来。
/// 与单聊 `resume_receive` 的区别：那份注册进 `file_receivers` 且自己取下载目录；
/// 这份只构造 `FileReceiver`，注册与收尾仍由群侧调用方负责（单聊的收尾不能直接复用）。
pub fn build_group_resume_receiver(
    downloads: &Path,
    transfer_id: &str,
    peer_id: &str,
    name: &str,
    size: u64,
    file_key: [u8; 32],
    expected_sha256: String,
) -> Result<FileReceiver, String> {
    use sha2::Digest;
    use std::io::Read;

    let safe_name = safe_file_name(name).ok_or("文件名非法")?;
    let transfer_id = safe_transfer_id(transfer_id).ok_or("传输标识非法")?;
    let tmp_path = downloads.join(format!("{transfer_id}.part"));
    let meta = std::fs::metadata(&tmp_path).map_err(|e| format!("找不到可续传的前缀：{e}"))?;
    let retained = meta.len();
    if retained == 0 || (size > 0 && retained >= size) {
        return Err("前缀长度不可续传".to_string());
    }
    if let Ok(modified) = meta.modified() {
        if let Ok(age) = std::time::SystemTime::now().duration_since(modified) {
            if age.as_millis() as i64 >= GROUP_RESUME_PART_MAX_AGE_MS {
                return Err("前缀已超过 24h 续传窗口".to_string());
            }
        }
    }
    let final_path = unique_path(downloads, &safe_name);
    let mut reader = std::fs::File::open(&tmp_path).map_err(|e| format!("打开前缀失败：{e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("读取前缀失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    drop(reader);
    let file = std::fs::OpenOptions::new()
        .append(true)
        .open(&tmp_path)
        .map_err(|e| format!("以追加模式打开前缀失败：{e}"))?;
    Ok(FileReceiver {
        file,
        name: safe_name,
        size,
        received: retained,
        next_seq: 0,
        attempt: 0,
        stale_dropped: 0,
        tmp_path,
        final_path,
        peer_id: peer_id.to_string(),
        last_report_ms: 0,
        fed_at_ms: crate::db::now_ms(),
        file_key,
        expected_sha256,
        hasher,
    })
}

/// 群文件接收失败：删除 `.part` 并移除接收状态（不 rename、不标 done）。
pub fn fail_group_receive(state: &AppState, transfer_id: &str) {
    if let Some(r) = state
        .group_file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(transfer_id)
    {
        fail_taken_group_receive(state, &r);
    }
}

/// 对端确认一条链路都不剩时，**原子摘取**它名下全部群接收（判据与摘表在同一次持锁里完成）。
///
/// 为什么必须有这一份：`handle_peer_unlinked` 以前是"锁内 `collect()` 出 id、锁外逐个收尾"，
/// 而同一个文件里 `take_stalled_receive` / `take_stalled_group_receive` 的注释早就把那个形状判死过
/// —— 那两步之间完全可以挤进一个新 FileOffer（同一个 transfer_id 重建接收器），
/// 按 id 收尾就会把**正在正常收**的那一单判死。返回 (id, FileReceiver) 与那条家族同形状。
pub fn take_group_receives_for_peer(
    state: &AppState,
    peer_id: &str,
) -> Vec<(String, FileReceiver)> {
    let mut recv = state
        .group_file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let ids: Vec<String> = recv
        .iter()
        .filter(|(_, r)| r.peer_id == peer_id)
        .map(|(k, _)| k.clone())
        .collect();
    ids.into_iter()
        .filter_map(|k| recv.remove(&k).map(|r| (k, r)))
        .collect()
}

/// 静默群接收器的**原子**回收单位（理由同 `take_stalled_receive`：判据与摘表必须同一次持锁）。
pub fn take_stalled_group_receive(state: &AppState, now: i64) -> Option<(String, FileReceiver)> {
    let mut recv = state
        .group_file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let key = recv
        .iter()
        .find(|(_, r)| receive_is_stale(now - r.fed_at_ms))
        .map(|(k, _)| k.clone())?;
    recv.remove(&key).map(|r| (key, r))
}

/// **用户取消**一单群文件的接收：摘接收器、删 `.part`、内容状态记 `Cancelled`。返回是否真停了什么。
///
/// 与 [`fail_group_receive`] 的区别是**证据的归属**：失败要保留 `.part` 作续传前缀
/// （对端上线/重连还能接着收），而"用户主动取消"不许留 —— 留着的话下一次 Offer
/// 会把它当成半截进度续上（用户眼里的"取消了它自己又开始传"）。
///
/// 与单聊 `receive::cancel_receive` 是两份实现而不是一份参数化：群接收器的清理面
/// 多一张表（`group_files` 的那一行由调用方落 cancelled），且这一册的恒等判据按分册钉
/// （见文件头），参数化会把两处的失败口径搅在一起。
pub fn cancel_group_receive(state: &AppState, transfer_id: &str) -> bool {
    let taken = {
        let mut recv = state
            .group_file_receivers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        recv.remove(transfer_id)
    };
    // 没有活跃接收器时，磁盘上仍可能留着上次的 `.part`（停滞被回收过）——照样要删。
    let mut stopped = false;
    let downloads = state
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let fallback = downloads.join(format!("{transfer_id}.part"));
    let mut tmp_path = fallback.clone();
    if let Some(r) = taken {
        tmp_path = r.tmp_path.clone();
        let peer_id = r.peer_id.clone();
        let cid = r.expected_sha256.clone();
        // 句柄先离开作用域再删文件（Windows 上未关句柄时 remove_file 会失败，同 `cancel_receive`）
        drop(r);
        stopped = true;
        if !cid.is_empty() {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            if let Err(e) = crate::content::store::record_failure(
                &dbc,
                &cid,
                &peer_id,
                crate::content::model::Direction::Receive,
                crate::content::model::FailReason::Cancelled,
                db::now_ms(),
            ) {
                state.logger.warn(
                    "group_file",
                    format!("取消群文件接收后内容状态没落成 Rejected cid={cid} transfer={transfer_id}：{e}"),
                );
            }
        }
    }
    if let Err(e) = std::fs::remove_file(&tmp_path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            state.logger.warn(
                "group_file",
                format!("取消群文件接收后删除 .part 失败 transfer={transfer_id}：{e}"),
            );
        }
    } else {
        stopped = true;
    }
    state.logger.info(
        "group_file",
        format!("用户取消群文件接收 transfer={transfer_id} stopped={stopped}"),
    );
    stopped
}

/// 摘表之后的群接收收尾（与单聊同一份口径：`.part` 保留、状态记 Incomplete 可重取）。
pub fn fail_taken_group_receive(state: &AppState, r: &FileReceiver) {
    // **保留 .part**（不删）：断点续传的前缀（群友从种子拉取时也走 resume_receive）。
    let _ = &r.tmp_path;
    // 统一状态：群文件中途失败/断链 ⇒ Incomplete（可恢复）⇒ 建链时按退避自动重取。
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let _ = crate::content::store::record_failure(
        &dbc,
        &r.expected_sha256,
        &r.peer_id,
        crate::content::model::Direction::Receive,
        crate::content::model::FailReason::Partial,
        db::now_ms(),
    );
}

/// 摘出接收器之后的群文件**落盘收尾**：完整性裁决 → fsync → 改名落盘。
///
/// ⚠️ **这一整段必须在 `spawn_blocking` 里跑，不许退回 async 路径**（用户 2026-10-14 真机：
/// 传 3.x GB 期间 Windows 点设置没窗、拖窗口没反应）。单聊那份收尾 4.39.3 已经交出去，
/// 群这一处是**同一个根因的第二家**：SHA finalize + `sync_all()` + rename 是秒级到几十秒的
/// GB 级磁盘慢活，原本由 `reader_loop` 的 tokio 任务直接跑 ⇒ 钉住一个 async worker，
/// 而同一个 runtime 上还排着所有 `#[tauri::command(async)]`（开设置窗 / 日志窗）。
///
/// 与单聊 `finish_receiver_into` 同一条规矩：这个函数**不要 `AppState`**，只要摘出来的
/// 接收器与下载目录 ⇒ "显示成功是不是真成功"第一次可以由**生产码**驱动单测
/// （此前那四条群用例各自在测试里重写一遍操作序列，生产码改坏它们不红）。
/// 它也拿不到 `group_file_receivers` 那张表 ⇒ "持锁做慢活"那个形状不可能从这里长回去。
///
/// 四个 `Err` 出口都清 `.part`，且调用方必须把每一格都停在终态：
/// ① 字节数与声明的 `size` 不等（丢片/截断）；② 实际 SHA-256 与发送方声明不符
/// （**含**"发送方没声明"—— 空期望值不通过，fail-closed）；③ fsync 失败；④ rename 失败。
pub fn finish_group_receive_into(mut r: FileReceiver, downloads: &Path) -> Result<PathBuf, String> {
    if r.received != r.size {
        let _ = std::fs::remove_file(&r.tmp_path);
        return Err("文件传输未完成".to_string());
    }
    {
        use sha2::Digest;
        let actual_hex: String = r
            .hasher
            .clone()
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !actual_hex.eq_ignore_ascii_case(&r.expected_sha256) {
            let _ = std::fs::remove_file(&r.tmp_path);
            return Err("文件完整性校验失败".to_string());
        }
    }
    // 改名前写透（这就是那段秒级慢活本体）
    if r.file.sync_all().is_err() {
        let _ = std::fs::remove_file(&r.tmp_path);
        return Err("文件落盘失败".to_string());
    }
    // drop 句柄后才 rename（Windows 不允许 rename 一个还开着的文件）
    drop(r.file);
    // 最终名是"开始接收"那一刻定下的，而那时同样在途的同名传输还没落盘、`unique_path`
    // 看不到它 ⇒ 两条同名传输可能选中同一个名字。落盘前再确认一次，被占走就换名。
    // （单聊是在写盘时才定名，所以没有这个竞态 —— 这也是"群聊出问题、单聊正常"的原因。）
    if r.final_path.exists() {
        r.final_path = unique_path(downloads, &r.name);
    }
    if std::fs::rename(&r.tmp_path, &r.final_path).is_err() {
        let _ = std::fs::remove_file(&r.tmp_path);
        return Err("文件改名落盘失败".to_string());
    }
    Ok(r.final_path)
}
