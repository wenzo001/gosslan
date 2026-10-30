// 接收侧：offer 决策 → 建 `.part` 接收器 → 逐片解密落盘 → 校验改名 → 失败与接管。
//
// 为什么单独一册：这一册的不变量集中在**幂等与磁盘证据**（重发的片要丢、`FileDone` 必须
// 字节数与 sha256 都对才 rename、被别的接收器占用的会话要怎么接管），与发送侧的"进度记账"
// 是两套判据；`stream_file` 的早退与这里的 `fail_taken_receive` 隔了 600 行时最难核对。
//

// 恒等判据（与 transport 那五刀同一套）：`cargo test --features bluetooth --lib -- --list` 用例名差集 0 行、
//   `verify-guards.py --list` 每条锚点恰好命中一次（本模块的锚点由 runner 沿 include! 树自动解析 ⇒ 不动 Case 的 file=）、
//   clippy `-D warnings`、`cargo fmt --check`。
// ⚠️ 搬家同批必须做的两件事：`network/mod.rs::file_src_for_guards()` 登记本册（漏了=形状守卫看不见这段生产码，假绿），
//   以及 `docs/domains.data.mjs` 的 transport/file 领域 paths（漏了=判据 D 报无主文件）。

/// 该 transfer_id 已保留的 .part 前缀字节数（无则 0）。
///
/// 用于把"接收端已持有多少"回给发送端（FileReject.received），让发送端从真实进度续发。
pub fn retained_part_len(state: &AppState, transfer_id: &str) -> u64 {
    let dl = state
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(p) = retained_part_path(&dl, transfer_id) else {
        return 0;
    };
    std::fs::metadata(p)
        .map(|m| if m.is_file() { m.len() } else { 0 })
        .unwrap_or(0)
}

/// `transfer_id` → `<downloads>/<tid>.part`（**拼路径前消毒**）。
///
/// 审计 P2 #25：`transfer_id` 来自对端的 Offer；`../..` 拼进去就是一个"能探任意文件
/// 是否存在/多大"的读数口。消毒口径与接收/落盘同一份（`safe_transfer_id`）。
pub(crate) fn retained_part_path(dl: &std::path::Path, transfer_id: &str) -> Option<std::path::PathBuf> {
    let tid = safe_transfer_id(transfer_id)?;
    Some(dl.join(format!("{tid}.part")))
}

/// 这一条 `.part` 是不是"本应用自己留下的、可以清"的分片。
///
/// 两个判据都要过：名字必须是 `owned_part_stem` 认可的 UUID 形状（接收目录是**用户的**
/// 目录，`draft.part` / `合同终稿.part` 不是我们的），且该 tid 不在活跃接收表里。
/// 按后缀盲删就是删用户数据 —— 同文件 `prune_retained_parts` 的注释已经写过这条。
fn sweepable_part_name<'a>(
    name: &'a str,
    active: &std::collections::HashSet<String>,
) -> Option<&'a str> {
    let tid = owned_part_stem(name)?;
    (!active.contains(tid)).then_some(tid)
}

/// 定期清扫：删除超过 TTL、且当前不在接收中的 .part。
///
/// 为什么需要（审计 §7 风险 2）：可恢复失败会**保留** .part 作续传前缀，若对端一去不回，
/// 这些前缀会一直占空间。清扫只删"够旧 + 没人正在用"的，绝不碰活跃接收。
pub fn sweep_stale_parts(state: &AppState) -> usize {
    const TTL_MS: u64 = 24 * 60 * 60 * 1000;
    let dl = state
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let active: std::collections::HashSet<String> = {
        let a: Vec<String> = state
            .file_receivers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        let b: Vec<String> = state
            .group_file_receivers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        a.into_iter().chain(b).collect()
    };
    let mut removed = 0;
    if let Ok(rd) = std::fs::read_dir(&dl) {
        for entry in rd.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if sweepable_part_name(name, &active).is_none() {
                continue;
            }
            let stale = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_millis() as u64 > TTL_MS)
                .unwrap_or(false);
            if stale && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// 磁盘上那份 `.part` 前缀**能不能拿来续传**（1:1 侧的内容身份判据）。
///
/// ## 为什么需要（2026-10-27 审计 P3 子问 2）
///
/// 1:1 续传此前**只比长度**：`.part` 存在、是文件、`len == from_bytes`、`0 < from_bytes ≤ size`
///、未过 24h TTL —— 于是这个形状成立：**同一 transfer_id、同长度、内容不同** ⇒ 续传能进
/// ⇒ 整份白传一遍 ⇒ 末段 SHA 判死并删 `.part`。用户看到的是"传到 90% 又从头开始"。
///
/// 群侧早就有同形状的判据（`group_resume.rs::prefix_usable` 比 size + sha），
/// 1:1 侧此前是空白 —— 现在补上。
///
/// ## 判据怎么读
///
/// - `known_cids`：这个 transfer_id 在内容台账里**已经登记过**的 cid 集合
///   （`content::store::cids_for_transfer_id`）。
/// - `offer_sha`：本次 Offer 声明的文件 sha256（= 内容 cid）。
///
/// 三种结果：
/// · `known_cids` 为空 ⇒ **没有历史** ⇒ 放行（第一次收，前缀无从谈起）；
/// · `offer_sha` 在集合里 ⇒ **同一份内容** ⇒ 放行续传；
/// · 集合非空且不含 `offer_sha` ⇒ 前缀属于**另一份内容** ⇒ **判整份重收**
///   （`Restart`）—— 不许拿它当前缀续。
///
/// ⚠️ **只比长度是不够的**（那是本条要替代的旧行为）：长度相同的内容可以完全不同，
/// 而"长度相同"恰恰是"同长度不同内容"这个形状的伪装。
pub(crate) fn prefix_identity_usable(
    known_cids: &[String],
    offer_sha: &str,
) -> PrefixIdentity {
    if known_cids.is_empty() {
        // 没有历史 ⇒ 无从判别 ⇒ 放行（保守方向：宁可续传一次，也不把正常续传打死）
        return PrefixIdentity::Unknown;
    }
    if known_cids
        .iter()
        .any(|c| c.eq_ignore_ascii_case(offer_sha))
    {
        return PrefixIdentity::SameContent;
    }
    PrefixIdentity::DifferentContent
}

/// `.part` 前缀与本次 Offer 的内容身份关系（纯判据的输出）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PrefixIdentity {
    /// 没有历史记录 ⇒ 放行。
    Unknown,
    /// 同一份内容 ⇒ 可以续传。
    SameContent,
    /// **另一份内容** ⇒ 必须整份重收（拿它续传会白传一轮再判死）。
    DifferentContent,
}

/// 断点续传：从已保留的 .part 前缀继续接收。
///
/// 与 begin_receive 的区别：**不再 truncate**，而是读入已有前缀播种 hasher，
/// received 从 from_bytes 接上；next_seq 归零（发送端从 from_seq=0 重编，只对本段排序）。
/// 任何不一致都返回 Err ⇒ 上层回 FileReject ⇒ 发送端整份重传（安全兜底）。
#[allow(clippy::too_many_arguments)]
pub fn resume_receive(
    state: &AppState,
    transfer_id: &str,
    peer_id: &str,
    name: &str,
    size: u64,
    file_key: [u8; 32],
    expected_sha256: String,
    from_bytes: u64,
) -> Result<PathBuf, String> {
    const TTL_MS: i64 = 24 * 60 * 60 * 1000;
    let safe_name = safe_file_name(name).ok_or("文件名非法")?;
    // 续传同样要落 `{id}.part`，消毒口径必须与 make_receiver 完全一致 ——
    // 否则「首次收被拦、续传绕过」就会留下一条可用的攻击路径。
    let transfer_id = safe_transfer_id(transfer_id).ok_or("传输标识非法")?;
    let transfer_id = transfer_id.as_str();
    // 配额判据与新建接收器同一份（SEC-05）：续传会重新占一格接收表，
    // 不能让"先被拒、再续传"成为绕过并发上限的路径。放在读 `.part` 之前 —— 那是阻塞的。
    let replacing = state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(transfer_id);
    let (active, inflight) = inbound_usage(state);
    if let Err(breach) = inbound_quota_verdict(active, inflight, replacing, size) {
        let msg = quota_error(breach, active, inflight, size, transfer_id, peer_id);
        state.logger.warn("file", msg.clone());
        return Err(msg);
    }
    // **内容身份判据**（2026-10-27 审计 P3 子问 2）：磁盘上那份 `.part` 属于哪一份内容？
    //
    // 放在**读前缀之前**（读前缀要整份哈希，是 GB 级慢活）：属于另一份内容时，
    // 早一步判 Restart 就省掉"整份白传一遍 + 末段 SHA 判死 + 删 .part"这一轮。
    //
    // 判据是"台账里这个 transfer_id 登记过哪些 cid"（`content_transfers` 的主键是
    // `(cid, peer_id, direction)` ⇒ 同一 transfer_id 配不同 cid 会留多行，
    // 正是这里要的证据）。台账查不到 ⇒ 无从判别 ⇒ 放行（保守方向）。
    let dl = state
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    {
        let known = {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            crate::content::store::cids_for_transfer_id(&dbc, peer_id, transfer_id)
        };
        let known = match known {
            Ok(v) => v,
            Err(e) => {
                // 台账读不出来 ⇒ 无从判别 ⇒ 放行（保守方向：宁可续传一次，
                // 也不要把正常续传打死 —— 白传一轮只是浪费带宽，打死续传是功能不可用）。
                state.logger.warn(
                    "file",
                    format!(
                        "查内容台账失败，按无历史处理（放行续传）transfer={transfer_id} peer={peer_id}: {e}"
                    ),
                );
                Vec::new()
            }
        };
        match prefix_identity_usable(&known, &expected_sha256) {
            PrefixIdentity::Unknown | PrefixIdentity::SameContent => {}
            PrefixIdentity::DifferentContent => {
                // 前缀属于**另一份内容** ⇒ 判整份重收。
                // 删掉那份前缀：留着它会让下一轮续传再撞一次同样的判定。
                let _ = std::fs::remove_file(dl.join(format!("{transfer_id}.part")));
                let msg = format!(
                    "code=RESUME_CONTENT_MISMATCH transfer={transfer_id} peer={peer_id} \
                     sha={expected_sha256} known={} —— 磁盘前缀属于另一份内容，整份重收",
                    known.len()
                );
                state.logger.warn("file", msg.clone());
                return Err(msg);
            }
        }
    }
    let tmp_path = dl.join(format!("{transfer_id}.part"));
    let meta = std::fs::metadata(&tmp_path).map_err(|_| "续传前缀不存在".to_string())?;
    if !meta.is_file() || meta.len() != from_bytes || from_bytes == 0 || from_bytes > size {
        return Err("续传前缀与请求不一致".to_string());
    }
    // TTL：太旧的前缀不复用（避免无穷增长），删掉并让上层整份重传。
    if let Ok(modified) = meta.modified() {
        if let Ok(age) = modified.elapsed() {
            if age.as_millis() as i64 > TTL_MS {
                let _ = std::fs::remove_file(&tmp_path);
                return Err("续传前缀已过期".to_string());
            }
        }
    }
    // ⚠️ **分块喂哈希器，不整读进内存**。这曾经是 `std::fs::read(&tmp_path)`：
    // `.part` 前缀最长就等于整个文件，于是「几个 GB 的文件传到 90% 断链、对端续传」
    // 会让本进程瞬间占用 ≈ 文件大小的内存 —— 而续传恰恰是为了处理这种大文件场景。
    let hasher = {
        use sha2::Digest as _;
        let mut h = sha2::Sha256::new();
        let mut src = std::fs::File::open(&tmp_path).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; FILE_CHUNK];
        let mut counted: u64 = 0;
        loop {
            let n = src.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            counted += n as u64;
        }
        // 只记录、不改行为：`received` 仍以 from_bytes 为准（发送端的分片编号是据此推出来的，
        // 这里单方面改会让两端的 seq 对不上）。不一致说明该 .part 已被外部改动，
        // 后续 SHA-256 整体校验会拦下，此处先留下可诊断的痕迹。
        if counted != from_bytes {
            state.logger.warn(
                "file",
                format!(
                    "续传前缀长度与声明不符：磁盘 {counted} 字节 / 声明 {from_bytes} 字节（transfer={transfer_id}）"
                ),
            );
        }
        h
    };
    let f = std::fs::OpenOptions::new()
        .append(true)
        .open(&tmp_path)
        .map_err(|e| e.to_string())?;
    let final_path = unique_path(&dl, &safe_name);
    // 哈希读完才走到这里：占用可能已经变了（别的链路刚插进来）⇒ **插入前再判一次**，
    // 并且这一判与 insert 在同一把闸下（上面的初判只是"别白读几个 GB"的快速失败）。
    let replacing_now = state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(transfer_id);
    let _admission = admit_inbound(state, replacing_now, transfer_id, peer_id, size)?;
    state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(transfer_id);
    state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            transfer_id.to_string(),
            FileReceiver {
                file: f,
                name: safe_name,
                size,
                received: from_bytes,
                next_seq: 0,
                attempt: 0,
                stale_dropped: 0,
                tmp_path,
                final_path: final_path.clone(),
                peer_id: peer_id.to_string(),
                last_report_ms: crate::db::now_ms(),
                fed_at_ms: crate::db::now_ms(),
                file_key,
                expected_sha256,
                hasher,
            },
        );
    Ok(final_path)
}

/// 接收方：准备接收文件，返回最终落盘路径。
pub fn begin_receive(
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
        expected_sha256,
        &state.file_receivers,
    )?;
    // 首笔 active 写不进去，这单在台账上就不存在。note 出锁之后再写，锁内不做文件 IO。
    let begin_note = {
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
        .err()
        .map(|e| terminal_ledger_failure_note(LEDGER_STAGE_BEGIN, transfer_id, &e, None))
    };
    if let Some(note) = begin_note {
        state.logger.error("file", note);
    }
    Ok(final_path)
}

/// 构造接收端状态（路径安全 + `.part` 创建 + 插入对应接收表），
/// 收到 `FileOffer` 时接收端的答复。
#[derive(Debug, PartialEq, Eq)]
pub enum OfferDecision {
    /// 回 `FileReject { received = 文件总大小 }`：本机已完整收下这份内容，
    /// 发送端不得再发任何分片（收到 `received ≥ size` 应直接宣布完成）。
    ///
    /// 为什么必须有（2026-09-23 审计 A6）：旧判据只有「活跃接收器 / .part 前缀 /
    /// from_bytes」三输入——**没有"本机已收完"**。收完之后 `.part` 已改名、接收器
    /// 已清空 ⇒ 三输入全归零 ⇒ 重复 Offer 判成 Accept ⇒ 整份重推落「名字(1)」副本
    /// （重复 Offer 的常见来源：A4 丢回执 → 发送端 outbox 重试）。
    AlreadyHave,
    /// 回 `FileAccept`，其它什么都不动（全新，或"同一起点的重复 offer"）。
    Accept,
    /// 回 `FileAccept`，**并且**把活跃接收器切到"新段从 `seq = 0` 重编"。
    ///
    /// 为什么必须有这一档：发送端续传时分片编号是按段从 0 重编的（`FileOffer.from_seq` 恒为 0）。
    /// 活跃接收器的 `next_seq` 还停在上一段末尾 ⇒ 不重置就会把这些**新数据**判成"迟到的重复片"
    /// 静默丢掉，文件永远差一截，而且不报错。
    AcceptResumeSegment,
    /// 回 `FileReject { received = 本端真实已收字节 }`：让发送端从真实位置续发。
    ResumeFrom(u64),
}

/// 「收到 offer 时该怎么答」的**唯一**判据（纯函数，能被单测直接钉住）。
///
/// 一句话：**接收端是"我有什么"的唯一权威，而且每次都要把这个回答出去。**
/// 之前这里有两套规矩 —— 没有活跃接收器时比对 `.part` 前缀、有活跃接收器时**一律** `Accept`
/// —— 后者在真机上把 160MB 的大文件判了死刑：发送端每一轮重试都从 `from_bytes = 0` 重发
/// （`flush_pending_files` 走的就是不带位置的 `send_file_from_path`），接收端回 Accept
/// 之后把那 40MB 已收前缀当"迟到的重复片"静默丢掉（`chunk_seq_decision` 的 `Duplicate` 分支），
/// 于是**每一轮都要重传一遍已收部分**，慢链路上永远跑不完 ⇒ 界面恒 0%、最后报"分片失败"。
///
/// `held` 的取法也是判据的一部分：有活跃接收器时用**内存里的 `received`**（每片 `write_all`
/// 之后就更新），没有时才退回磁盘 `.part` 的大小 —— 报小了会让发送端重灌已写进文件的字节，
/// 文件超长、SHA-256 必不匹配；报大了会让发送端以为对端有它没有的东西，永远等不齐。
///
/// ⚠️ 归零只在 `from_bytes > 0` 时做，无条件归零会引入另一个故障：上一轮 attempt 被 timeout
/// 丢掉时它**已入队的分片还在 writer_loop 里往外排**（队列 1024 槽 ≈ 262MB，丢 future 不排空
/// 队列），那些片的 seq 已到 160+，此时因一个 `from_bytes = 0` 的重复 offer 把 `next_seq`
/// 拍回 0 ⇒ 它们变成「跳号」⇒ `Err(文件分片顺序错误)` ⇒ 整单被判死。
///
/// ⚠️ **磁盘前缀的长度上限也是判据的一部分**（A-12，2026-09-26 由注入⑧在真实双实例照出）：
/// `FileReject.received` 承载两个含义 —— 发送端把 `received >= size` 读成"对方已完整收下"
/// 并直接收尾（记 done、**删掉队列行**）。所以"`.part` 字节数够了"绝不能当续传位置报出去：
/// 上一次收尾 `rename` 失败（目录只读 / 磁盘满 / 进程被杀在半步）时字节是整份的，
/// **但磁盘上没有成品文件**，而"成品"才是「rename 才算完成」的唯一凭证。
/// 那一格实测的形状就是这条判据要拦的：`A=done 且队列行已删 / B=failed / .part 整份 / final 不存在`
/// —— 两边各给了用户一个结论，而且互相矛盾，且再也没人重试。
/// 故：≥ size 的磁盘前缀**不算进度**，按 0 处理 ⇒ 重新整份收，走真实的哈希校验与真实的 rename。
/// 活跃接收器的内存计数不走这条（它收完那一刻收尾就已经跑过了，见 `write_chunk` 的裁决分支）。
pub fn decide_offer(
    has_active: bool,
    active_received: u64,
    disk_retained: u64,
    size: u64,
    from_bytes: u64,
    already_completed: bool,
) -> OfferDecision {
    // 「本机已收完」优先于一切位置判据（审计 A6）：收完后三输入全归零，
    // 任何位置比较都会退化成"整份重推"。
    if already_completed {
        return OfferDecision::AlreadyHave;
    }
    let held = if has_active {
        active_received
    } else if size > 0 && disk_retained >= size {
        0
    } else {
        disk_retained
    };
    if from_bytes != held {
        return OfferDecision::ResumeFrom(held);
    }
    if has_active && from_bytes > 0 {
        return OfferDecision::AcceptResumeSegment;
    }
    OfferDecision::Accept
}

/// 该 transfer 当前是否有活跃接收器，以及它真实收下了多少字节。
///
/// 返回 `None` = 没有活跃接收器（此时 `.part` 磁盘前缀才是唯一事实）。
pub fn receiver_progress(state: &AppState, transfer_id: &str) -> Option<u64> {
    state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(transfer_id)
        .map(|r| r.received)
}

/// 把活跃接收器切到"新的一段从 `seq = 0` 重新编号"，**不动**已收字节、文件位置与增量哈希。
///
/// 为什么必须做：发送端续传时分片编号是**按段**从 0 重编的（`FileOffer.from_seq` 恒为 0，
/// `stream_file` 也只按 `from_bytes` 定位文件偏移）。接收器如果还留着上一段推进到的
/// `next_seq = 160`，新段那些从 0 开始、内容其实是**新数据**的分片会被
/// `chunk_seq_decision` 判成"迟到的重复片"静默丢掉 ⇒ 文件永远差一截。
/// 只在"位置对得上、决定 Accept 而接收器已推进过"的情况下调用；重置的是段号，不是进度。
pub fn restart_segment(state: &AppState, transfer_id: &str) {
    if let Some(r) = state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(transfer_id)
    {
        r.next_seq = 0;
    }
}

/// 入站接收配额（SEC-05）。三个数值是**运营参数**（按需调整），不是协议契约。
///
/// 为什么需要：每收到一个 `FileOffer` 就会建一个 `{transfer_id}.part` 并占一格内存表。
/// 对端（或被盗的好友身份）可以靠连续 Offer 把磁盘写满、把表撑大、拖垮同一个 runtime
/// 上排队的所有命令。旧实现只有 24h TTL 清扫 —— 那是"事后收尸"，不是"事前拒绝"。
pub const MAX_CONCURRENT_RECEIVES: usize = 8;
pub const MAX_INCOMING_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub const MAX_INCOMING_TOTAL_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// 接收前**卷余量预检**要额外留出的水位（字节）。
///
/// 为什么留水位：判据是"余量 ≥ 这一单的大小"，而恰好等于时会把卷写到 0 字节 ——
/// 那时连 `.part` 的元数据、日志、本机数据库的写都放不进去，于是**这一单失败**、
/// **别的活也跟着失败**。留 64 MiB 水位 ⇒ 收完这一单之后卷上仍有喘气的地方。
///
/// 为什么不是 0：0 意味着"刚好塞满"，而 Windows 与某些网络卷会在写满瞬间
/// 拒绝**所有**写（包括删 `.part`），清理路径一起卡死。
pub const INBOUND_SPACE_HEADROOM: u64 = 64 * 1024 * 1024;

/// **未登记接收器**的 `.part` 保留总量上限（审计 SEC-05 的第二道闸）。
///
/// 为什么单列这一项：断链时 `.part` 被刻意保留供续传，而接收器会从内存表里摘掉
/// ⇒ 它对 `MAX_INCOMING_TOTAL_BYTES` 不再计数。对端只要"发一份、断链、换个新 id 再来"
/// 就能无限写盘（`.part` 只在 24h 后被清扫）。保留总量与在途总量分开封顶之后，
/// 磁盘占用上界 = 16 GiB（在途） + 16 GiB（保留），与对端行为无关。
pub const MAX_RETAINED_PART_BYTES: u64 = MAX_INCOMING_TOTAL_BYTES;

/// 入站配额超限的原因（拼进 `code=RECV_QUOTA_EXCEEDED kind=…`）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum QuotaBreach {
    Concurrent,
    FileTooLarge,
    TotalBytes,
    /// 断链保留的 `.part` 已经占满预算（即使清掉最旧的那些也放不下新的一份）。
    RetainedBytes,
}

/// 「这份 Offer 还能不能接」的**唯一**判据（纯函数，单测直接钉住）。
///
/// `replacing = true` 表示同一个 `transfer_id` 已经在接收表里（对端重试 / 续传同一个文件）：
/// 它不占新槽位、也不新增字节额度，必须放行 —— 否则一次瞬时的槽位打满就会让重试永远接不上，
/// 那一单卡在"对端一直重发、本机一直拒绝、界面永远 0%"。
pub(crate) fn inbound_quota_verdict(
    active: usize,
    inflight_bytes: u64,
    replacing: bool,
    new_size: u64,
) -> Result<(), QuotaBreach> {
    if new_size > MAX_INCOMING_FILE_BYTES {
        return Err(QuotaBreach::FileTooLarge);
    }
    if replacing {
        return Ok(());
    }
    if active >= MAX_CONCURRENT_RECEIVES {
        return Err(QuotaBreach::Concurrent);
    }
    if inflight_bytes.saturating_add(new_size) > MAX_INCOMING_TOTAL_BYTES {
        return Err(QuotaBreach::TotalBytes);
    }
    Ok(())
}

/// 把若干组 `(条数, 字节)` 累加成一份占用（纯函数，便于钉住中继也算进来）。
pub(crate) fn usage_sum(parts: &[(usize, u64)]) -> (usize, u64) {
    parts.iter().fold((0usize, 0u64), |(n, b), (n2, b2)| {
        (n.saturating_add(*n2), b.saturating_add(*b2))
    })
}

/// 当前入站占用：活跃接收器数 + 它们声明的总字节数。
///
/// 三张表**分开取锁、不嵌套**：仓库里已有"先 file 后 group"的取锁点（`commands/helpers.rs`），
/// 这里若同时持有两把锁，就等于给未来的交叉取锁埋一个顺序问题。
///
/// 中继那张表（`relay_file_keys`）也必须算进来（审计 SEC-05）：它同样是"对端一次性声明
/// 一份大小、本机就得为它留出磁盘与内存"的入站资源，漏掉它等于给配额开了一扇侧门。
fn inbound_usage(state: &AppState) -> (usize, u64) {
    fn one(map: &std::sync::Mutex<HashMap<String, FileReceiver>>) -> (usize, u64) {
        let g = map.lock().unwrap_or_else(|e| e.into_inner());
        (
            g.len(),
            g.values().map(|r| r.size).fold(0u64, |a, b| a.saturating_add(b)),
        )
    }
    let relay = {
        let g = state
            .relay_file_keys
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        (
            g.len(),
            g.values()
                .map(|r| r.size)
                .fold(0u64, |a, b| a.saturating_add(b)),
        )
    };
    usage_sum(&[
        one(&state.file_receivers),
        one(&state.group_file_receivers),
        relay,
    ])
}

/// 入站登记的准入闸（审计 SEC-05：check-then-act）。
///
/// 配额判定与"把接收器插进表里"必须在同一把锁下完成，否则两条链路并发 Offer 时
/// 会同时读到旧占用、双双通过。守卫活到调用方插入之后（`Drop` 即释放）。
pub(crate) struct InboundAdmission<'a> {
    _guard: std::sync::MutexGuard<'a, ()>,
}

/// 申请一个入站槽位：`replacing = false` 时若不满足配额，返回 `RECV_QUOTA_EXCEEDED`
/// （含 `transfer=` / `peer=`，能归因到哪一单）；`replacing = true`（同一 transfer 重试/续传）
/// 不占新槽位，直接放行。
pub(crate) fn admit_inbound<'a>(
    state: &'a AppState,
    replacing: bool,
    transfer_id: &str,
    peer_id: &str,
    size: u64,
) -> Result<InboundAdmission<'a>, String> {
    let guard = state
        .inbound_gate
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let (active, inflight) = inbound_usage(state);
    if let Err(breach) = inbound_quota_verdict(active, inflight, replacing, size) {
        let msg = quota_error(breach, active, inflight, size, transfer_id, peer_id);
        state.logger.warn("file", msg.clone());
        return Err(msg);
    }
    // 第二道闸（只在**新建**槽位时判）：断链保留的 `.part` 不占内存表，但占磁盘。
    // `replacing` 跳过它 —— 那一份的 `.part` 已经在途表里计过字节。
    if !replacing {
        let kept = prune_retained_parts(state, transfer_id, size);
        if kept.saturating_add(size) > MAX_RETAINED_PART_BYTES {
            let msg = quota_error(
                QuotaBreach::RetainedBytes,
                active,
                inflight,
                size,
                transfer_id,
                peer_id,
            );
            state.logger.warn("file", msg.clone());
            return Err(msg);
        }
        // 第三道闸：**卷余量预检**（2026-10-27 审计 P1）。
        //
        // 前两道闸算的都是"对端声明的 size 之和"，与磁盘真实余量无关 ⇒ 满盘时
        // 配额照样通过，然后逐片写、写到一半 ENOSPC、整单失败（用户看到一句
        // 不可行动的英文）。这一道**事前**回绝：装不下就别开始传。
        //
        // 三条纪律（`storage/disk_space.rs` 的文件头有完整版）：
        // ① **读不到 ⇒ 放行**（`Unknown`）—— 误拒的代价（永远收不下）远大于误放。
        // ② 预检**不替代**写失败兜底（那套完整保留：`.part` + 台账 failed + 回 Ack(false)）。
        // ③ 一次 `statvfs` 是**系统调用**（微秒级），不是 INV-P34 管的 GB 级慢活
        //    ⇒ 允许留在 async 路径上（该 INV 的"边界"段已登记这条口径）。
        let dl = state
            .downloads_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        match crate::storage::disk_space::verdict_for(
            &dl,
            size,
            INBOUND_SPACE_HEADROOM,
        ) {
            crate::storage::disk_space::SpaceVerdict::Enough
            | crate::storage::disk_space::SpaceVerdict::Unknown => {}
            crate::storage::disk_space::SpaceVerdict::NotEnough { available, needed } => {
                let msg = format!(
                    "code=RECV_DISK_SPACE_INSUFFICIENT transfer={transfer_id} peer={peer_id} \
                     size={needed} available={available} headroom={INBOUND_SPACE_HEADROOM} \
                     —— 磁盘空间不足，请释放空间后重试"
                );
                state.logger.warn("file", msg.clone());
                return Err(msg);
            }
        }
    }
    Ok(InboundAdmission { _guard: guard })
}

/// 只有**本应用建的** `.part` 才能被预算清理：stem 必须是 UUID。
///
/// 接收目录是用户的目录，里面完全可能有 `backup.part` / `draft.part` 这类
/// 用户自己的文件 —— 按后缀盲删就是删用户数据。生产端所有 transfer_id 都是
/// `Uuid::new_v4()`，所以 UUID 形状是"这文件是我建的"的可靠判据。
fn owned_part_stem(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".part")?;
    uuid::Uuid::parse_str(stem).ok().map(|_| stem)
}

/// 纯函数：给定保留项（路径、字节、mtime 毫秒），按**最旧先删**选出要清掉的那些，
/// 直到剩余总量加上 `incoming` 不超过预算。
fn parts_to_prune(entries: &[(std::path::PathBuf, u64, i64)], incoming: u64) -> Vec<std::path::PathBuf> {
    let budget = MAX_RETAINED_PART_BYTES.saturating_sub(incoming);
    let mut total: u64 = entries.iter().map(|(_, b, _)| *b).sum();
    let mut sorted: Vec<&(std::path::PathBuf, u64, i64)> = entries.iter().collect();
    sorted.sort_by_key(|(_, _, mtime)| *mtime);
    let mut out = Vec::new();
    for (path, bytes, _) in sorted {
        if total <= budget {
            break;
        }
        total = total.saturating_sub(*bytes);
        out.push(path.clone());
    }
    out
}

/// 把断链保留的 `.part` 清到预算以内，返回清理后的保留总字节。
///
/// 只动"UUID 形状 + 当前没登记在任何接收表里"的 `.part`；删不掉只留痕，不阻断。
/// `incoming` 参与预算：目标是"清完之后还能放下这一份"。
fn prune_retained_parts(state: &AppState, keep_transfer: &str, incoming: u64) -> u64 {
    let dl = state
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let registered: std::collections::HashSet<String> = {
        let mut ids: Vec<String> = Vec::new();
        for map in [&state.file_receivers, &state.group_file_receivers] {
            ids.extend(
                map.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .keys()
                    .cloned(),
            );
        }
        ids.extend(
            state
                .relay_file_keys
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .keys()
                .cloned(),
        );
        ids.into_iter().collect()
    };
    let mut entries = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dl) {
        for entry in rd.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let Some(stem) = owned_part_stem(name) else {
                continue;
            };
            if stem == keep_transfer || registered.contains(stem) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            entries.push((path, meta.len(), mtime));
        }
    }
    let total: u64 = entries.iter().map(|(_, b, _)| *b).sum();
    let victims = parts_to_prune(&entries, incoming);
    let mut removed_bytes = 0u64;
    for p in &victims {
        match std::fs::remove_file(p) {
            Ok(()) => {
                if let Some((_, b, _)) = entries.iter().find(|(path, _, _)| path == p) {
                    removed_bytes = removed_bytes.saturating_add(*b);
                }
            }
            Err(e) => state.logger.warn(
                "file",
                format!("code=PART_PRUNE_FAILED path={} err={e}", p.display()),
            ),
        }
    }
    total.saturating_sub(removed_bytes)
}

/// 超限时构造给调用方的错误串（上层会把它原样写进日志并回 `FileReject`）。
///
/// 带上 `transfer=` / `peer=`：只记"超了"而不记"哪一单"，现场就只能看到一堆超限数字，
/// 归因不到具体对端（审计 SEC-05 的可定位性要求）。
pub(crate) fn quota_error(
    breach: QuotaBreach,
    active: usize,
    inflight: u64,
    size: u64,
    transfer_id: &str,
    peer_id: &str,
) -> String {
    let kind = match breach {
        QuotaBreach::Concurrent => "concurrent",
        QuotaBreach::FileTooLarge => "file_too_large",
        QuotaBreach::TotalBytes => "total_bytes",
        QuotaBreach::RetainedBytes => "retained_bytes",
    };
    format!(
        "code=RECV_QUOTA_EXCEEDED kind={kind} transfer={transfer_id} peer={peer_id} size={size} active={active} inflight={inflight} max_concurrent={MAX_CONCURRENT_RECEIVES} max_file={MAX_INCOMING_FILE_BYTES} max_total={MAX_INCOMING_TOTAL_BYTES} max_retained={MAX_RETAINED_PART_BYTES}"
    )
}

/// 一对一与群文件共用；差异只在写入哪个接收 map 与是否记录 file_transfers。
#[allow(clippy::too_many_arguments)]
fn make_receiver(
    state: &AppState,
    transfer_id: &str,
    peer_id: &str,
    name: &str,
    size: u64,
    file_key: [u8; 32],
    expected_sha256: String,
    receivers: &std::sync::Mutex<HashMap<String, FileReceiver>>,
) -> Result<PathBuf, String> {
    let safe_name = safe_file_name(name).ok_or("文件名非法")?;
    // transfer_id 会成为 `{id}.part` 的文件名，必须与文件名同级消毒（见 safe_transfer_id）
    let transfer_id = safe_transfer_id(transfer_id).ok_or("传输标识非法")?;
    let transfer_id = transfer_id.as_str();
    if size > i64::MAX as u64 {
        return Err("文件过大，无法安全保存".to_string());
    }
    // 配额判据（SEC-05）：必须在建 `.part` **之前**，而且判定与下面的 insert 共用一把闸 ——
    // 中间隔着 `create_dir_all` / `File::create`，不持闸时两条链路会同时读到旧占用、双双通过。
    let replacing = receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(transfer_id);
    let _admission = admit_inbound(state, replacing, transfer_id, peer_id, size)?;
    // 同一个 transfer_id 又收到一次 Offer = 发送方在**重试**（它每次都从 seq 0 重新开始）。
    // 旧实现这里直接返回「重复的文件传输」⇒ 接收方拒收 ⇒ 发送方 15s 等 accept 超时 ⇒
    // 可恢复失败 ⇒ 再重试 —— 死循环；而新 attempt 的分片与旧状态交错，就报出
    // 「文件分片顺序错误」。现在：把旧状态丢掉、从零重新开始。
    // 安全性：临时文件按 `transfer_id` 命名，下面 `File::create` 会**截断**它，
    // 新 attempt 不会与旧字节混写；`final_path` 仍走 `unique_path`（旧 final 未完成 ⇒ 不存在）。
    if let Some(old) = receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(transfer_id)
    {
        let _ = std::fs::remove_file(&old.tmp_path);
    }
    let dl = state
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    std::fs::create_dir_all(&dl).ok();
    let final_path = unique_path(&dl, &safe_name);
    // ⚠️ 临时文件必须按 **transfer_id** 命名，不能从 final_path 派生：
    // 两张同名图同时在途时，begin 那一刻磁盘上还没有同名文件 → unique_path 会给两者同一个 final_path
    // → 由它派生的 .part 也相同 → 两份字节交错写进同一文件 → sha256 校验失败
    // （表现为"第一张能看、第二张加载不出来"）。
    let tmp_path = dl.join(format!("{transfer_id}.part"));
    let f = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;

    receivers.lock().unwrap_or_else(|e| e.into_inner()).insert(
        transfer_id.to_string(),
        FileReceiver {
            file: f,
            name: safe_name,
            size,
            received: 0,
            next_seq: 0,
            attempt: 0,
            stale_dropped: 0,
            tmp_path: tmp_path.clone(),
            final_path: final_path.clone(),
            peer_id: peer_id.to_string(),
            last_report_ms: 0,
            fed_at_ms: crate::db::now_ms(),
            file_key,
            expected_sha256,
            hasher: {
                use sha2::Digest as _;
                sha2::Sha256::new()
            },
        },
    );
    Ok(final_path)
}

/// 收到一片文件分片时该怎么处理（**纯函数**，便于单测钉住"重复不致命"这条规则）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ChunkSeq {
    /// 重复或迟到的分片（`seq` 落在已收范围内）⇒ **忽略**，绝不让整单失败。
    Duplicate,
    /// 正好是下一片 ⇒ 写入。
    Accept,
    /// 跳号（中间真缺片）⇒ 只能靠重传解决。
    Gap,
}

/// 判据：`seq < next_seq` **忽略**、相等**接受**、大于**报错**。
///
/// 为什么"重复"不能报错（2026-09-13 审计的真缺陷）：发送方一次 attempt 超时后会**从头重传**
/// （`seq` 从 0 重来），上一轮的残片可能仍在链路上。旧实现一律报「文件分片顺序错误」，
/// 于是接收方整单失败、状态被清 ⇒ 新 attempt 也永远拼不齐 ⇒
/// **BLE 上 >20KB 的文件事实上永远传不完**（用户实测的那条报错就是它）。
/// 只挡"跳号"仍然安全：整份字节由文件级 SHA-256 兜底校验。
pub(crate) fn chunk_seq_decision(seq: u32, next_seq: u32) -> ChunkSeq {
    use std::cmp::Ordering;
    match seq.cmp(&next_seq) {
        Ordering::Less => ChunkSeq::Duplicate,
        Ordering::Equal => ChunkSeq::Accept,
        Ordering::Greater => ChunkSeq::Gap,
    }
}

/// 这片明文的长度会不会**越过声明的 `size`**（§七「错误 size」那格唯一的裁决点）。
///
/// 为什么这条判据必须在写盘**之前**、而不是留到收尾的"字节数与声明不符"：`.part` 是按片增长的，
/// 不设上限就等于让对端决定这台机器往磁盘上写多少字节，而用户看到的是一条会跑到 100% 再失败的单。
///
/// ⚠️ 边界刻意取"恰好填满 = 放行"：`stream_file` 的最后一片通常正好把 `size` 补齐，
/// 写成 `>=` 会让**每一单**都在最后一片上打死（与 [`chunk_seq_decision`] 只挡真空缺是同一类设计）。
pub(crate) fn chunk_exceeds_declared(size: u64, received: u64, plaintext_len: u64) -> bool {
    plaintext_len > size.saturating_sub(received)
}

/// 这一帧属于**当前这一轮**发送尝试吗（attempt epoch 判据，2026-09-23 真机 600MB 复核）。
///
/// 病根：一轮超时后 outbox 重投，但**上一轮已经塞进链路队列的分片不会被撤回**
/// （Low 队列 1024 槽 ≈ 262MB）。接收端每段的 `seq` 都是从 0 重编的，于是旧轮的高 `seq`
/// 落在新轮的 `next_seq` 之上 ⇒ 判成"跳号"⇒ 整单被打死。有了轮次号就能把它安静丢掉。
///
/// 三条刻意的设计：
/// 1. `None`（老端不带这个字段，或对方没声明 `CONTENT_FEATURE_FILE_EPOCH`）⇒ **恒真**，
///    完全退回旧语义 —— 新 behaviour 只在两端都支持时才生效。
/// 2. 用 `==` 而不是 `>=`：**比本机新的轮次也算"不是我的"**。"未来的分片"只可能是它的
///    Offer 还在另一条链路上排队；先收下会把文件拼坏，而拼坏由末尾 SHA 兜住 ⇒ 宁可丢这一片，
///    等它自己的 Offer 到达后由发送端从 `.part` 前缀续发（自愈，最多多一轮）。
/// 3. **Offer 永远照单全收并借此设定轮次**（不走这个判据）：否则本机重启后计数器回到 1，
///    而接收端存的是上一轮的 5 ⇒ 新 Offer 被判陈旧 ⇒ 这份文件永久饿死。Offer 是权威，
///    分片/完成帧才是被过滤的对象。
pub(crate) fn frame_is_current(frame: Option<u32>, current: u32) -> bool {
    match frame {
        Some(a) => a == current,
        None => true,
    }
}

/// `None`（老端不带 attempt）在本机记作这一轮。
pub const LEGACY_ATTEMPT: u32 = 0;

/// Offer 一到达就把接收器的"当前轮次"设成它带来的值 —— **Offer 是权威，不参与过滤**
/// （见 `frame_is_current` 第 3 条：否则本机重启后计数器回到小值，新 Offer 会被自己判成陈旧，
/// 那份文件就永久饿死）。
pub fn note_offer_attempt(state: &AppState, transfer_id: &str, attempt: Option<u32>) {
    if let Some(r) = state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(transfer_id)
    {
        r.attempt = attempt.unwrap_or(LEGACY_ATTEMPT);
    }
}

/// `FileDone` 是否属于当前轮次（只读，不摘接收器）。
///
/// 为什么必须在 `finish_receive` **之前**判：那份函数一进来就把接收器摘掉了，
/// 陈旧完成帧会被当成"重复 FileDone"去补一个成功 Ack，或更糟 —— 拿这一轮刚开头的
/// `received ≠ size` 把整单打死。没有接收器时返回 true，交给原有"未知传输"分支处理。
pub fn done_is_current(state: &AppState, transfer_id: &str, attempt: Option<u32>) -> bool {
    let recv = state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    match recv.get(transfer_id) {
        Some(r) => frame_is_current(attempt, r.attempt),
        None => true,
    }
}

/// 接收方：写入一个分片，返回累计字节数。
/// 入参 `data` 为 AEAD 密文（nonce || ciphertext）：先解密再写盘，
/// 解密失败直接报错——密文绝不落盘。
pub fn write_chunk(
    state: &AppState,
    transfer_id: &str,
    peer_id: &str,
    seq: u32,
    data: &[u8],
    attempt: Option<u32>,
) -> Result<u64, String> {
    use std::io::Write;
    // 锁作用域：先算完，把要落库的进度取出来，**释放 file_receivers 锁之后**再动 db
    // （避免 file_receivers -> db 的嵌套锁顺序）。
    let (received, cid, owner, report) = {
        let mut recv = state
            .file_receivers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let r = recv.get_mut(transfer_id).ok_or("未知传输")?;
        if r.peer_id != peer_id {
            return Err("文件传输来源不匹配".to_string());
        }
        // **上一轮 attempt 的残留分片**安静丢掉（2026-09-23 真机 600MB 的根治，attempt epoch）。
        // 不丢会怎样：它们带着上一轮的高 `seq`，落到下面的判据里就是"跳号"⇒ 整单打死 ——
        // 而旧注释里"重传时 seq 从 0 重来 ⇒ 残片算 Duplicate"那条推理，只在残片**先到**、
        // 新轮 Offer 把 next_seq 归零**之后**才成立；队列里还压着最多 262MB 时顺序是反的。
        if !frame_is_current(attempt, r.attempt) {
            if r.stale_dropped == 0 {
                state.logger.info(
                    "file",
                    format!(
                        "丢掉非当前轮次的分片（本机在接收第 {} 轮）transfer={transfer_id}",
                        r.attempt
                    ),
                );
            }
            r.stale_dropped += 1;
            return Ok(r.received);
        }
        // 重复/迟到的分片必须**忽略**，而不是整单失败：发送方一次 attempt 超时后会**从头重传**
        // （seq 从 0 重来），而上一轮的残片可能仍在链路上。只挡"跳号"（真缺片，只能重传）；
        // 整份字节仍由文件级 SHA-256 兜底。
        match chunk_seq_decision(seq, r.next_seq) {
            ChunkSeq::Duplicate => return Ok(r.received),
            ChunkSeq::Gap => return Err(crate::logging::FAIL_CODE_FILE_CHUNK_GAP.to_string()),
            ChunkSeq::Accept => {}
        }
        let plaintext = crypto::open_symmetric(&r.file_key, data)
            .ok_or_else(|| crate::logging::FAIL_CODE_FILE_CHUNK_DECRYPT_FAILED.to_string())?;
        if chunk_exceeds_declared(r.size, r.received, plaintext.len() as u64) {
            return Err(crate::logging::FAIL_CODE_FILE_CHUNK_OVERSIZE.to_string());
        }
        // 文件级完整性：明文增量哈希（与写盘同一份数据，无二次磁盘读取）
        use sha2::Digest;
        r.hasher.update(&plaintext);
        // 写盘失败：载荷**只给码**。盘满归 `DISK_FULL`（前端据此给"清出空间后可重试"的可行动
        // 文案），其余归 `FILE_RECEIVE_WRITE_FAILED`；OS 原文留在日志里 —— 那是唯一信息量，
        // 但它不是给用户读的话（5.15.35 之前这一格把 `e.to_string()` 直接当载荷）。
        r.file.write_all(&plaintext).map_err(|e| {
            let detail = e.to_string();
            let code = crate::logging::classify_write_failure(&e)
                .unwrap_or(crate::error_codes::FILE_RECEIVE_WRITE_FAILED);
            state.logger.error(
                "file",
                format!(
                    "code={code} transfer={transfer_id} peer={peer_id} received={} size={} —— 分片写盘失败: {detail}",
                    r.received, r.size
                ),
            );
            code.to_string()
        })?;
        r.received += plaintext.len() as u64;
        // 每片都记一次"还被喂得动"—— 这是 `receive_is_stale` 唯一的证据来源。
        // 代价是一次 epoch 毫秒读取，相对上面的 `write_all` 可以忽略。
        r.fed_at_ms = crate::db::now_ms();
        r.next_seq = r.next_seq
            .checked_add(1)
            .ok_or(crate::logging::FAIL_CODE_FILE_CHUNK_SEQ_OVERFLOW.to_string())?;
        // 节流 500ms 落一次进度：这是断点续传的起点，也让统一状态显示真实进度。
        let now = crate::db::now_ms();
        let report = now - r.last_report_ms >= 500;
        if report {
            r.last_report_ms = now;
        }
        (
            r.received,
            r.expected_sha256.clone(),
            r.peer_id.clone(),
            report,
        )
    };
    if report {
        // 进度落点写不进去，续传起点就丢了。`report` 本身就是 500ms 节流，warn 级不刷屏。
        let touch_err = {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            crate::content::store::touch_received(
                &dbc,
                &cid,
                &owner,
                received,
                crate::db::now_ms(),
            )
            .err()
        };
        if let Some(e) = touch_err {
            state.logger.warn(
                "file",
                terminal_ledger_failure_note(LEDGER_STAGE_PROGRESS, transfer_id, &e, None),
            );
        }
    }
    Ok(received)
}

/// 终止损坏或超时的接收：摘表 → 收尾（见 `fail_taken_receive`）。
pub fn fail_receive(state: &AppState, transfer_id: &str, peer_id: &str, reason: &str) -> bool {
    let mut recv = state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(r) = recv.remove(transfer_id) else {
        return false;
    };
    if r.peer_id != peer_id {
        recv.insert(transfer_id.to_string(), r);
        return false;
    }
    drop(recv);
    fail_taken_receive(state, transfer_id, &r, reason);
    true
}

/// 用户取消一条**正在接收**的文件：把本机这一侧停手（B3a）。
///
/// 与 `fail_receive` 的三处区别每一条都是语义，不是风格：
///  · **删 `.part`**。`fail_receive` 刻意保留它当续传前缀；而用户说"不要了"，那半截文件
///    既不该留在下载目录里，更不该被下一次同单投递当成"已经收了 N 字节"接着写。
///  · 内容记 `FailReason::Cancelled` ⇒ **Rejected**（终态、不自动重取）。记成 `Partial`
///    就走 Incomplete ⇒ 下一次建链 `retry_incomplete_content` 会把用户刚取消的东西
///    自己再拉一遍（"取消了又自己开始"那一族，与 `file_transfers.cancel_terminal` 同案）。
///  · 不核对 `peer_id`：这是用户动作，来源是谁都得停。
///
/// 台账那一笔（`cancelled` + 墓碑 + 气泡）不在这里写 —— 唯一出口仍是
/// `db::finalize_file_failure(.., Cancelled)`，由取消命令统一调（一份顺序、一处 emit）。
/// 返回值 = 本机是否真有一路在收的传输被停下（`false` 也要继续落 cancelled：
/// 对端可能已经不再发了，但用户要的是"这一单别再出现在我的进行中"）。
pub fn cancel_receive(state: &AppState, transfer_id: &str) -> bool {
    let taken = {
        let mut recv = state
            .file_receivers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        recv.remove(transfer_id)
    };
    let Some(r) = taken else {
        return false;
    };
    let tmp_path = r.tmp_path.clone();
    let peer_id = r.peer_id.clone();
    let cid = r.expected_sha256.clone();
    // 先让持有 `File` 句柄的接收器离开作用域，再去删文件：Windows 上句柄未关时
    // `remove_file` 会失败（同一份纪律见 `fail_taken_receive` 里"句柄与磁盘动作的先后"）。
    drop(r);
    if let Err(e) = std::fs::remove_file(&tmp_path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            state.logger.warn(
                "file",
                format!("取消接收后删除 .part 失败 transfer={transfer_id}：{e}"),
            );
        }
    }
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = crate::content::store::record_failure(
            &dbc,
            &cid,
            &peer_id,
            crate::content::model::Direction::Receive,
            crate::content::model::FailReason::Cancelled,
            db::now_ms(),
        ) {
            state.logger.error(
                "file",
                format!("取消接收后内容状态没落成 Rejected cid={cid} transfer={transfer_id}：{e}（下一次建链可能自动重取这一单）"),
            );
        }
    }
    state.logger.info(
        "file",
        format!("用户取消接收：已停手并删除 .part transfer={transfer_id} peer={peer_id}"),
    );
    true
}

/// 静默接收器的**原子**回收单位：判据与摘表在同一次持锁里完成。
///
/// 为什么不能"先快照一批 id、再逐个收尾"：那两步之间完全可以挤进一个新 FileOffer
/// （同一 transfer_id 重新建接收器、`fed_at_ms` 就是现在）—— 按 id 收尾会把那个
/// **正在收**的传输判死。宁可每轮只摘一个、循环到没有，也不留这个缝。
pub fn take_stalled_receive(state: &AppState, now: i64) -> Option<(String, FileReceiver)> {
    let mut recv = state
        .file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let key = recv
        .iter()
        .find(|(_, r)| receive_is_stale(now - r.fed_at_ms))
        .map(|(k, _)| k.clone())?;
    recv.remove(&key).map(|r| (key, r))
}

/// 摘表之后的收尾：落 failed 终态、记 Incomplete、emit。
/// `fail_receive` 与清扫器共用这一份 —— 终态口径不许有两套。
pub fn fail_taken_receive(state: &AppState, transfer_id: &str, r: &FileReceiver, reason: &str) {
    // **保留 .part**（不删）：这是断点续传的前缀。只有"确定是永久失败"（校验不符）
    // 才删；超时/断链属于可恢复。陈旧 .part 由 resume_receive 的 TTL 与后续清理收割。
    //
    // ★ 盘满是唯一的例外（B2-F1，5.15.51）：这一档保留 `.part` 的后果**正好相反** ——
    // 那半截文件继续占着本就不够的空间，下一次重试写第一片又 ENOSPC ⇒「一直满、一直失败」。
    // 断链/超时那一档仍然保留（见上面那段），**别把这条一起改回去**：两者语义不同。
    if reason == crate::logging::FAIL_CODE_DISK_FULL {
        // 三种结局必须分开说（发版前 review 抓到）：原先 `is_ok()` 把**任何** Err 都写成
        // "文件已不在，视作已删除" —— 权限/占用（Windows 上句柄未关时真的会撞）会被说成成功，
        // 而用户看到的还是一块没释放的空间。
        let outcome = match std::fs::remove_file(&r.tmp_path) {
            Ok(()) => "已删除 .part".to_string(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "文件已不在".to_string(),
            Err(e) => format!("删除 .part 失败：{e}（这一档会继续占着空间）"),
        };
        state.logger.error(
            "file",
            format!(
                "code=FILE_DISK_FULL transfer={transfer_id} peer={} size={} —— 盘满，{outcome}（这一档不留续传前缀）",
                r.peer_id, r.size
            ),
        );
    }
    let fail_notes = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut notes: Vec<String> = Vec::new();
        if let Err(e) = db::upsert_transfer(
            &dbc,
            transfer_id,
            &r.peer_id,
            &r.name,
            r.size,
            "receive",
            "failed",
            None,
            0.0,
        ) {
            notes.push(terminal_ledger_failure_note(
                LEDGER_STAGE_FAILED,
                transfer_id,
                &e,
                None,
            ));
        }
        // 注意：**不能**把 .part 写进 path —— find_source 只看 path 非空就当作可服务内容，
        // 那样会把"半截文件"当成完整种子发出去。.part 的位置由 transfer_id 推导。
        let _ = &r.tmp_path;
        // 统一状态：中途失败/超时/断链 ⇒ **Incomplete**（可恢复）。
        // 于是建链时 retry_incomplete_content 会按退避自动重取，而不是永远停在 Active。
        // 单独一格 stage：这一笔丢的是"能不能自动重取"，不是界面显示。
        if let Err(e) = crate::content::store::record_failure(
            &dbc,
            &r.expected_sha256,
            &r.peer_id,
            crate::content::model::Direction::Receive,
            crate::content::model::FailReason::Partial,
            db::now_ms(),
        ) {
            notes.push(terminal_ledger_failure_note(
                LEDGER_STAGE_INCOMPLETE,
                transfer_id,
                &e,
                None,
            ));
        }
        notes
    };
    for note in fail_notes {
        state.logger.error("file", note);
    }
    emit_failed(state, transfer_id, reason);
}

/// 对端断链时终止其所有未完成接收，避免下载目录长期堆积临时文件。
/// 对端确认一条链路都不剩时，**原子摘取**它名下全部单聊接收（判据与摘表同一次持锁）。
///
/// 与群侧 `take_group_receives_for_peer` 同一族。旧写法是"锁内 `collect()` 出 id、锁外逐个
/// `fail_receive`"：`fail_receive` 虽然会核对 `peer_id`（别人的原样插回），但**同 peer、同
/// transfer_id 的新 attempt** 正好可以在那两步之间建起来 ⇒ 上一轮的 teardown 会把这一轮
/// 正在收的传输判死。后果有界（内容记 Incomplete、建链时按退避自动重取），
/// 但"多等一轮"本身就是用户看到的"下载卡在重试"。
pub fn take_receives_for_peer(state: &AppState, peer_id: &str) -> Vec<(String, FileReceiver)> {
    let mut recv = state
        .file_receivers
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

pub fn fail_receives_for_peer(state: &AppState, peer_id: &str) {
    // 摘与收尾分开：摘在锁内一次做完，收尾（写库 + emit）一律在锁外。
    for (id, r) in take_receives_for_peer(state, peer_id) {
        state.logger.warn(
            "file",
            format!(
                "code={} transfer={} peer={peer_id} received={} size={} —— 对端一条链路都不剩，这一单要对方重发",
                crate::logging::FAIL_CODE_FILE_PEER_UNLINKED, id, r.received, r.size
            ),
        );
        fail_taken_receive(state, &id, &r, crate::logging::FAIL_CODE_FILE_PEER_UNLINKED);
    }
}

/// 接收方：收尾，返回 (name, size, final_path, peer_id)。
///
/// ⚠️ **这是一次 `spawn_blocking`，不是随手加的 async**（用户 2026-10-14 真机：3.x GB 收尾那一段
/// 期间 Windows 的窗口操作全失灵）：SHA finalize + `sync_all()` + rename 是**秒级到几十秒**的
/// 磁盘慢活，而这个函数原本由 `reader_loop` 的 tokio 任务直接调用 ⇒ 它钉住的是
/// **异步 runtime 的 worker 线程**，而那同一个 runtime 上还跑着所有 async 命令
/// （`open_settings_window` / `open_log_window` …）。表现就是"文件还在处理时，点设置没窗、
/// 拖窗口没反应"。搬到阻塞线程池之后，worker 立刻回到调度池里，慢活照做、一件不少。
///
/// ⚠️ 锁只用来"把接收器摘出来"，摘完立刻放（2026-09-23 真机 600MB 复核）：
/// 下面这段是 SHA finalize + `sync_all()` + rename —— 600MB 的 fsync 是秒级慢活，
/// 而它跑在 reader_loop 里；持锁期间**同一时刻其它并发文件的 `write_chunk` 全部堵在同一把锁上**
/// ⇒ 那些传输不再写出 ⇒ 发送端 60s 停滞判据（`FILE_STALL_ABORT_MS`）把它们判死。
/// 摘出来之后这份接收器已经不在表里，锁外独占使用它是安全的。
pub async fn finish_receive(
    state: &Arc<AppState>,
    transfer_id: &str,
    peer_id: &str,
) -> Result<Option<(String, u64, PathBuf, String)>, String> {
    let r = {
        let mut recv = state
            .file_receivers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match recv.remove(transfer_id) {
            Some(r) => {
                if r.peer_id != peer_id {
                    recv.insert(transfer_id.to_string(), r);
                    // 5.15.40：这一支**会** emit（与 `fail_receive` 里那条只 `return false` 的
                    // 同名判断不是一条路）⇒ 载荷必须给码；原句进日志。
                    state.logger.warn(
                        "file",
                        format!(
                            "code={} transfer={transfer_id} —— 接收器不属于这个对端（收尾放弃）",
                            crate::logging::FAIL_CODE_FILE_RECEIVE_SOURCE_MISMATCH
                        ),
                    );
                    return Err(crate::logging::FAIL_CODE_FILE_RECEIVE_SOURCE_MISMATCH.to_string());
                }
                r
            }
            None => return Ok(None),
        }
    };
    // 摘出来的那份接收器**整个交给阻塞线程池**：包装函数此后不再碰它（判据
    // `receive_finalize_slow_work_happens_outside_the_receiver_lock` 同时钉着"摘锁形状"与
    // "慢活整体在 spawn_blocking 里"两件事）。
    let st = state.clone();
    let transfer_id = transfer_id.to_string();
    let tid_for_task = transfer_id.clone();
    tokio::task::spawn_blocking(move || finish_receiver_into(&st.db, &st.logger, &tid_for_task, r))
        .await
        // 阻塞任务只会在 panic / 运行时关闭时出错；两种都当"这次没收口"上抛，
        // 由调用方那一条失败分支照原样发 `file-failed` + 回一帧失败确认（不谎报成功）。
        .map_err(|e| {
            state.logger.error(
                "file",
                format!(
                    "code={} transfer={transfer_id} —— 接收收尾任务被中断: {e}",
                    crate::logging::FAIL_CODE_FILE_RECEIVE_FINALIZE_ABORTED
                ),
            );
            crate::logging::FAIL_CODE_FILE_RECEIVE_FINALIZE_ABORTED.to_string()
        })?
        .map(Some)
}

/// 台账写入的阶段名。每格都要有调用点，也要有用例。
pub(crate) const LEDGER_STAGE_BEGIN: &str = "begin-active";
pub(crate) const LEDGER_STAGE_FAILED: &str = "failed-terminal";
pub(crate) const LEDGER_STAGE_INCOMPLETE: &str = "incomplete-record";
pub(crate) const LEDGER_STAGE_PROGRESS: &str = "progress-touch";
pub(crate) const LEDGER_STAGE_SIZE: &str = "size-mismatch-failed";
pub(crate) const LEDGER_STAGE_SHA: &str = "sha-mismatch-failed";
pub(crate) const LEDGER_STAGE_FSYNC: &str = "fsync-failed";
pub(crate) const LEDGER_STAGE_RENAME: &str = "rename-failed";
pub(crate) const LEDGER_STAGE_DONE_REPAIRED: &str = "done-tx-repaired";
pub(crate) const LEDGER_STAGE_DONE_BOTH: &str = "done-tx-and-fallback";

/// 台账关键写入失败时要留的那一句（纯函数，便于单独测文本形状）。
///
/// 三种情况靠 `stage` 与 `fallback` 区分：只有主写入失败、主写失败但补偿成功
/// （`done-tx-repaired`）、主写与补偿都失败（`done-tx-and-fallback`）。
/// 日志自身落盘失败由 Logger 处理，不经过这里。
///
/// 只带阶段、传输 id 和 SQLite 错误文本（截到 `LEDGER_ERR_TEXT_MAX` 字符）；这一句
/// 不主动写入文件名、落盘路径或内容。rusqlite 里唯一自带路径的变体是 `InvalidPath`，
/// 它只在打开库文件时产生，收尾这条路上碰不到。
pub(crate) fn terminal_ledger_failure_note(
    stage: &str,
    transfer_id: &str,
    err: &rusqlite::Error,
    fallback: Option<&rusqlite::Error>,
) -> String {
    let primary = bounded_err_text(err);
    match fallback {
        None => format!("台账写入失败 stage={stage} id={transfer_id}: {primary}"),
        Some(second) => format!(
            "台账写入失败 stage={stage} id={transfer_id}: 主写={primary} · 补偿也失败={} ⇒ 该行可能仍停在 active（界面上的进度会一直不动）",
            bounded_err_text(second)
        ),
    }
}

/// 错误文本进日志的字符上界。SQLite 原文长度不可控（一条 `no such column` 会把候选列名全列出来），
/// 而这一句要的只是"哪一步、为什么"。
const LEDGER_ERR_TEXT_MAX: usize = 240;

fn bounded_err_text(err: &rusqlite::Error) -> String {
    bounded_raw_text(&err.to_string())
}

fn bounded_raw_text(raw: &str) -> String {
    if raw.chars().count() <= LEDGER_ERR_TEXT_MAX {
        return raw.to_string();
    }
    let head: String = raw.chars().take(LEDGER_ERR_TEXT_MAX).collect();
    format!("{head}…")
}

/// 接收端回 `FileCompleteAck` 的五个出口各自的 stage（取值互不相同，判据按"不互相冒充"钉）。
/// 只有 `try_send` **返回 Err** 才记，成功路径一行都不写 —— 回执每单至多一次，写成 info
/// 也会变成"每条文件传输都留一行"的噪声，而这一族要的只是"哪一分支、为什么没送出去"。
pub(crate) const ACK_STAGE_CHUNK_ABORTED: &str = "ack-chunk-aborted";
pub(crate) const ACK_STAGE_FINISH_FAILED: &str = "ack-finish-failed";
pub(crate) const ACK_STAGE_DUP_DONE: &str = "ack-duplicate-done";
pub(crate) const ACK_STAGE_NO_RECEIVER: &str = "ack-no-receiver";
pub(crate) const ACK_STAGE_COMPLETED: &str = "ack-completed";

/// 回执发不出去时的那一句留痕（与台账那几条同一口径：只有 stage / `transfer_id` / 有界错误文本，
/// 不带文件名、路径、内容、密钥）。
///
/// `try_send` 的 `Err` 是 `String`，类别只有三种形状：`未建立连接`（选路一条都没挑上）、
/// `连接已关闭`、`发送队列已满…`。把它们原样带进日志才能分"B 没发出去"与"发了但 A 没读到"
/// —— 后者这条日志不会出现。
///
/// 为什么单独成函数：调用点在 `transport/handle_file.rs`（那五处此前全是 `let _ =`），
/// 而它只要字符串不要 `AppState` ⇒ 出站帧这条路本仓没有能驱动真 `try_send` 的异步夹具
/// （见 `lib_file_tests.rs` 那两条源码守卫同样的理由），至少文本形状能拿生产码判。
pub(crate) fn ack_send_failure_note(stage: &str, transfer_id: &str, err: &str) -> String {
    format!(
        "完成回执发不出去 stage={stage} id={transfer_id}: {}",
        bounded_raw_text(err.trim())
    )
}

/// **writer 出口**那一格的留痕（`transport/queue_policy.rs::writer_loop`）：`try_send` 返回
/// `Ok` 只代表帧进了这条连接的 mpsc，真正写 socket 的是 writer 任务 —— 两者之间没有别的答案。
///
/// 只在**这一帧确实是 `FileCompleteAck`** 时才记：writer 同时扛着所有族的帧（心跳、Hello、
/// 群消息、几百万条 `FileChunk`），把别人的写失败报成"回执故障"会把归因指错地方；不匹配就
/// 返回 `None`，一行都不写。`outcome` 只有两个取值，分的是"谁的错"：
/// `local` = 本机就没写成（超长 / 序列化不出来，一个字节都没上链路，链路保留）；
/// `socket` = 真的 socket 写失败（这条链路随即判死拆掉）。
pub(crate) fn ack_writer_failure_note(
    msg: &Message,
    outcome: &str,
    reason: &str,
) -> Option<String> {
    match msg {
        Message::FileCompleteAck {
            transfer_id,
            success,
        } => Some(format!(
            "完成回执没写成 stage=ack-writer id={transfer_id} success={success} 出口={outcome}: {}",
            bounded_raw_text(reason.trim())
        )),
        _ => None,
    }
}

/// 摘出接收器之后的收尾：完整性裁决 → fsync → 改名落盘 → 落库终态。
///
/// 三个 `Err` 出口都必须让 `file_transfers` 停在 `failed`（而不是留在 `sending` / `done`）：
/// ① 字节数与声明的 `size` 不等（丢片/截断）；② 实际 SHA-256 与发送方声明不符
/// （**含**"发送方没声明"这一种 —— 空期望值不通过，fail-closed）；③ fsync 或 rename 失败。
/// 这三条合起来就是界面上那句「已收到」的证据，少任何一条都是假成功。
///
/// 为什么要独立成一个函数（#25）：它只要一个 db 锁、不要 `AppState`
/// （那个要 tauri `AppHandle`，单测造不出来）⇒ 「显示成功是不是真成功」第一次可以拿
/// **生产码**驱动，而不是像现有几处接收端测试那样各自重写一遍操作序列（生产码改坏它们不红）。
/// 另外它拿不到 `file_receivers` 那张表 ⇒ "持锁 fsync" 那个形状不可能从这里长回去。
///
/// 形参收 `DbLock` 而不是裸 `Mutex<Connection>`：这五处取锁正是"台账停在 active"那族故障的
/// 现场，走裸 Mutex 的话一次持锁读数都不会有（夹具那边用 `DbLock::new` 造，取锁写法一字不变）。
fn finish_receiver_into(
    db_lock: &crate::db_hold::DbLock<rusqlite::Connection>,
    logger: &Logger,
    transfer_id: &str,
    mut r: FileReceiver,
) -> Result<(String, u64, PathBuf, String), String> {
    if r.received != r.size {
        let _ = std::fs::remove_file(&r.tmp_path);
        let note = {
            let dbc = db_lock.lock().unwrap_or_else(|e| e.into_inner());
            db::upsert_transfer(
                &dbc,
                transfer_id,
                &r.peer_id,
                &r.name,
                r.size,
                "receive",
                "failed",
                None,
                0.0,
            )
            .err()
            .map(|e| terminal_ledger_failure_note(LEDGER_STAGE_SIZE, transfer_id, &e, None))
        };
        if let Some(note) = note {
            logger.error("file", note);
        }
        logger.warn(
            "file",
            format!(
                "code={} transfer={transfer_id} peer={} received={} size={} —— 字节没收完就收到完成帧",
                crate::error_codes::FILE_RECEIVE_INCOMPLETE,
                r.peer_id,
                r.received,
                r.size
            ),
        );
        return Err(crate::error_codes::FILE_RECEIVE_INCOMPLETE.to_string());
    }
    // 文件级完整性校验：实际 SHA-256 必须与发送方声明一致，否则不落盘
    {
        use sha2::Digest;
        let actual = r.hasher.clone().finalize();
        let actual_hex = crate::crypto::hex_lower(&actual);
        if !actual_hex.eq_ignore_ascii_case(&r.expected_sha256) {
            let _ = std::fs::remove_file(&r.tmp_path);
            let note = {
                let dbc = db_lock.lock().unwrap_or_else(|e| e.into_inner());
                db::upsert_transfer(
                    &dbc,
                    transfer_id,
                    &r.peer_id,
                    &r.name,
                    r.size,
                    "receive",
                    "failed",
                    None,
                    0.0,
                )
                .err()
                .map(|e| terminal_ledger_failure_note(LEDGER_STAGE_SHA, transfer_id, &e, None))
            };
            if let Some(note) = note {
                logger.error("file", note);
            }
            // 可归因：actual/expected/收到多少 —— 只有"校验失败"四个字时，分不清是
            // 续传前缀属于另一份内容、还是发送端声明错了哈希（2026-10-27 审计 P3 子问 4）。
            // `code=` 用的是**在册的那个码**（与下面返回给界面的载荷同一个名字）：日志里另起
            // 一个只对排查人员存在的码，等于同一件事两个名字，grep 一边就找不到另一边。
            logger.warn(
                "file",
                format!(
                    "code={} transfer={transfer_id} peer={} actual={actual_hex} expected={} received={} size={} —— 内容与本机不匹配",
                    crate::error_codes::FILE_INTEGRITY_FAILED,
                    r.peer_id, r.expected_sha256, r.received, r.size
                ),
            );
            return Err(crate::error_codes::FILE_INTEGRITY_FAILED.to_string());
        }
    }
    if let Err(e) = r.file.sync_all() {
        // 载荷给**码**，OS 原文只进日志：原先这里 `return Err(e.to_string())`，于是英文界面
        // 那一格读到的是 "No space left on device (os error 28)" —— 前端对未知 reason 是原样上屏，
        // 这串既没法翻译也没法当成动作。盘满单独归 `DISK_FULL`（那条才有"清出空间后重试"），
        // 其余落盘失败给通用码，原始文本留在日志里供排查。
        let detail = e.to_string();
        let code = crate::logging::classify_write_failure(&e)
            .unwrap_or(crate::error_codes::FILE_RECEIVE_WRITE_FAILED);
        let _ = std::fs::remove_file(&r.tmp_path);
        let note = {
            let dbc = db_lock.lock().unwrap_or_else(|e| e.into_inner());
            db::upsert_transfer(
                &dbc,
                transfer_id,
                &r.peer_id,
                &r.name,
                r.size,
                "receive",
                "failed",
                None,
                0.0,
            )
            .err()
            .map(|e| terminal_ledger_failure_note(LEDGER_STAGE_FSYNC, transfer_id, &e, None))
        };
        if let Some(note) = note {
            logger.error("file", note);
        }
        logger.error(
            "file",
            format!(
                "code={code} transfer={transfer_id} peer={} received={} size={} —— 落盘(fsync)失败: {detail}",
                r.peer_id, r.received, r.size
            ),
        );
        return Err(code.to_string());
    }
    drop(r.file);
    // §七「两个 offer 都在任一次 rename 之前到达」：`final_path` 是 begin 时用 `unique_path` 定的，
    // 而那一刻两份都还没落地 ⇒ 同名两单会拿到**同一个**名字。`exists()` + `rename` 之间还有窗口，
    // 而 POSIX 的 rename 在目标已存在时**静默覆盖**（两行台账都 done、一个气泡指向不存在的字节）。
    // 改用 `place_unique`：硬链接原子占名，占不到就换下一个候选（审计 P2 #42）。
    match place_unique(&r.tmp_path, &r.final_path, &r.name) {
        Ok(placed) => r.final_path = placed,
        Err(e) => {
            // 同 sync_all 那一格：载荷给码，OS 原文进日志。盘满仍单独归 `DISK_FULL`
            //（占名也可能因为没空间而失败）。
            let detail = e.to_string();
            let code = crate::logging::classify_write_failure(&e)
                .unwrap_or(crate::error_codes::FILE_RECEIVE_PLACE_FAILED);
            let note = {
                let dbc = db_lock.lock().unwrap_or_else(|e| e.into_inner());
                db::upsert_transfer(
                    &dbc,
                    transfer_id,
                    &r.peer_id,
                    &r.name,
                    r.size,
                    "receive",
                    "failed",
                    None,
                    0.0,
                )
                .err()
                .map(|e| terminal_ledger_failure_note(LEDGER_STAGE_RENAME, transfer_id, &e, None))
            };
            if let Some(note) = note {
                logger.error("file", note);
            }
            logger.error(
                "file",
                format!(
                    "code={code} transfer={transfer_id} peer={} name={} —— 占名落盘失败: {detail}",
                    r.peer_id, r.name
                ),
            );
            return Err(code.to_string());
        }
    }
    // 终态要**一次写全**：`file_transfers` 说 done 而 `content_transfers` 还停在 active/incomplete，
    // 就是 2026-10-13 真机第 7 条那个永动重试 —— 拉取队列只看后一张表
    // （`content/store.rs::list_resumable_for_peer` 的 `status IN ('queued','active','incomplete')`），
    // 而 `Complete` 全仓唯一构造点是 `content::store::record_local`，此前 5 个调用点都在
    // 群文件 / 群公告 / 待办 / 中继，单聊这一条没有 ⇒ 每次建链整批再投。
    // 两句放同一事务 ⇒ 要么两张表一起收口，要么一起不动；"不动"落在**可恢复**那一侧（宁可重投一次，
    // 不可假 complete）。事务本身失败时退回今天的形状：只写 `file_transfers`，界面上那句"已收到"
    // 仍然成立（文件此刻确实已在盘上，见上面 SHA + fsync + rename 三道），内容台账留给下次建链补。
    {
        let mut dbc = db_lock.lock().unwrap_or_else(|e| e.into_inner());
        let path_str = r.final_path.to_string_lossy().to_string();
        let tx_started = std::time::Instant::now();
        let both = dbc.transaction().and_then(|tx| {
            db::upsert_transfer(
                &tx,
                transfer_id,
                &r.peer_id,
                &r.name,
                r.size,
                "receive",
                "done",
                Some(path_str.as_str()),
                1.0,
            )?;
            crate::content::store::record_local(
                &tx,
                &r.expected_sha256,
                &r.peer_id,
                None,
                &r.name,
                r.size,
                crate::content::model::Direction::Receive,
                &path_str,
                db::now_ms(),
            )?;
            tx.commit()
        });
        crate::db_hold::note_tx(
            logger,
            "dm_finalize",
            &format!("transfer_id={transfer_id}"),
            tx_started,
            db_lock.slow_threshold_ms(),
            both.is_ok(),
        );
        let done_note = match both {
            // 补偿写成功：file_transfers 收口，content_transfers 留给下次建链补（状态仍正确）。
            Err(primary) => match db::upsert_transfer(
                &dbc,
                transfer_id,
                &r.peer_id,
                &r.name,
                r.size,
                "receive",
                "done",
                Some(r.final_path.to_string_lossy().as_ref()),
                1.0,
            ) {
                Ok(()) => Some(terminal_ledger_failure_note(
                    LEDGER_STAGE_DONE_REPAIRED,
                    transfer_id,
                    &primary,
                    None,
                )),
                // 两次都失败：两张表都可能停在 active，界面上的进度就永远不动。
                Err(second) => Some(terminal_ledger_failure_note(
                    LEDGER_STAGE_DONE_BOTH,
                    transfer_id,
                    &primary,
                    Some(&second),
                )),
            },
            Ok(()) => None,
        };
        drop(dbc);
        if let Some(note) = done_note {
            logger.error("file", note);
        }
    }
    Ok((
        r.name.clone(),
        r.size,
        r.final_path.clone(),
        r.peer_id.clone(),
    ))
}
