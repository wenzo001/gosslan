// 职责边界：
// - 群文件 Offer→Chunk→Done 投递核心（dispatch_group_file_to_peer）
// - 失败诊断日志（app_handle_log）

/// 续传回执槽位的 RAII 守卫：登记之后无论从哪条路径离开（Offer 发送失败 / 15s 超时 /
/// 外层 deadline / 取消 / panic），都必须把 `(transfer, recipient)` 的 oneshot 槽位摘掉。
///
/// 旧写法在两个正常出口手写 `remove`；而外层 `timeout(deadline, …)` 在等回执期间触发时
/// future 直接被 drop，那两行都走不到 ⇒ 槽位永久残留（每次重投多一个）。与 P2-02 的
/// `PendingCompleteGuard` 同一条纪律：登记即武装，离开作用域就回收。
struct ResumeWaiterGuard<'a> {
    state: &'a std::sync::Arc<crate::state::AppState>,
    key: String,
}

impl Drop for ResumeWaiterGuard<'_> {
    fn drop(&mut self) {
        self.state
            .group_file_resume_waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

/// 取消登记槽位的 RAII 守卫（与 `PendingCompleteGuard` 同一条纪律）。
///
/// 登记**必须在并发闸之前**：任务可能排队几十秒甚至更久，用户在这期间点"取消发送"
/// 时，槽位若还没登记，`send(())` 会失败、取消被静默丢掉，排到队后照样把文件发出去。
/// 守卫保证任何退出路径（取消 / 超时 / 提前 return / panic）都摘掉槽位。
struct CancelSlotGuard<'a> {
    state: &'a std::sync::Arc<crate::state::AppState>,
    key: String,
}

impl Drop for CancelSlotGuard<'_> {
    fn drop(&mut self) {
        self.state
            .file_send_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

/// 向单个 recipient 执行完整群文件投递：Offer → 流式 Chunk → Done。
/// 元数据/源路径/密钥均从 DB 与运行态恢复，支持离线 pending 的延迟投递。
/// 群文件投递失败的种类 —— 它决定这个 recipient 行接下来落到哪个状态。
///
/// 为什么要有这个类型（#154-4）：`dispatch_group_file_to_peer` 一进来就把该成员置成 `sending`，
/// 而离线补发只捞 `status = 'pending'`（`db/group_files.rs::list_pending_group_files_for_recipient`）
/// ⇒ **失败之后不写状态，就是"永远在发、重启也不重试"**。原先两条调用路径各写一套：
/// 群发那条按错误**文案**猜（`e == "用户取消发送"`）、补发那条**什么都不写** ⇒
/// 同一条判据两个家，而弱的那个正好是最常走的补发路径。
/// 带原因字符串只为日志可读，裁决只看种类 ⇒ 文案改了也不会把状态判错。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GroupFileSendErr {
    /// 永远给不了货（群文件行本身不在 / 源文件不在）⇒ `failed`
    Unrecoverable(String),
    /// 现在给不了、以后可能给得了（没链路 / 密钥未到 / 写失败 / 超时 / 读文件失败）⇒ 回 `pending`
    Retryable(String),
    /// 用户主动取消 ⇒ `cancelled`（INV-P26：取消不许记成 failed）
    Cancelled,
}

/// 失败之后该把这个 recipient 行写成什么。
///
/// 三条都不许是 `sending` —— 那是"进来时"的状态，不是一个可以停下来的地方。
pub(crate) fn group_file_status_after_fail(e: &GroupFileSendErr) -> Option<&'static str> {
    match e {
        GroupFileSendErr::Unrecoverable(_) => Some("failed"),
        GroupFileSendErr::Retryable(_) => Some("pending"),
        GroupFileSendErr::Cancelled => Some("cancelled"),
    }
}

/// 失败日志要的那句原因（裁决不看它，只给人看）。
pub(crate) fn group_file_send_err_reason(e: &GroupFileSendErr) -> &str {
    match e {
        GroupFileSendErr::Unrecoverable(s) | GroupFileSendErr::Retryable(s) => s.as_str(),
        GroupFileSendErr::Cancelled => "用户取消发送",
    }
}

async fn dispatch_group_file_to_peer(
    state: &Arc<AppState>,
    transfer_id: &str,
    group_id: &str,
    recipient: &str,
    source_path: &str,
) -> Result<(), GroupFileSendErr> {
    // 写出记账的回收守卫：与单聊 `stream_file` 同一条理由（`Drop` 覆盖取消 / 超时 /
    // 十余处提前 return），键**必须带收件人** —— 这里 N 个成员各一个任务、共用同一个
    // `transfer_id`，按 id 记会让甲的写出把乙的"最近有写出"一直刷新（真卡死的成员
    // 判不出停滞），按 id 收更会让先收尾的甲删掉还在写的乙的记录。
    let _wire_ledger = file::WireLedger::install(state, transfer_id, recipient);
    // 同一 (transfer, recipient) 只许一个任务在途 —— 排队中的也算。
    // 为什么不能只靠状态行：排队期间行必须保持 `pending`（见下），而离线补发会在
    // Hello/心跳/建链时捞 `pending` ⇒ 没有这道内存闸，同一成员会出现两个任务
    // （两个轮次、两份读缓冲），在并发闸后叠起来。
    let Some(_dispatch_gate) = crate::state::GroupFileDispatchGuard::try_acquire(
        &state.group_file_dispatching,
        file::file_peer_key(transfer_id, recipient),
    ) else {
        return Ok(());
    };
    // ---- cancel 登记（H3 fix：群文件也支持用户取消）----
    // 必须在并发闸**之前**登记：任务可能排队很久，用户在这期间点"取消发送"时，
    // 槽位若还没登记，取消信号会静默丢掉，排到队后照样把文件发出去。
    // 键必须带 recipient：本函数是**每个成员各 spawn 一个任务、共用同一个 transfer_id**
    // （group_announcements.rs 的 fan-out 循环）。只按 transfer_id 登记时，后注册的任务会
    // 把前一个的 Sender 挤掉 ⇒ 前者的 cancel_rx 以 Err(RecvError) 完成 ⇒ 被取消分支当成
    // 「用户取消发送」，N 个成员里只有最后一个发得完（真机三成员群必现）。
    let cancel_key = file::file_cancel_key(transfer_id, recipient);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    state
        .file_send_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(cancel_key.clone(), cancel_tx);
    let _cancel_slot = CancelSlotGuard {
        state,
        key: cancel_key,
    };
    // 全局并发闸（拍板 4A(8)）：群发是"每可达成员一个任务"，无闸时 200 成员会同时
    // 占住 200 份读缓冲（每份约 1.2 MB）与 200 条链路的队列（每条预算 8 MiB）。
    // 闸放在**传输调度层**（本函数是群发与离线补发的唯一投递入口），才同时管住
    // 任务数与队列内存。`acquire().await` 是**无损等待**：排队不丢文件、不降级。
    // 排队期间该成员仍是 `pending`（状态由拿到许可后自己写）⇒ stale-sending 清扫器
    // 不会把排队误判成卡死而重复投递。
    let _slot = state
        .group_file_permits
        .acquire()
        .await
        .map_err(|_| GroupFileSendErr::Retryable("群文件并发闸已关闭".into()))?;
    // 排队期间用户可能已经点了取消：拿到许可后先看这一格，别把已取消的文件真发出去。
    // （槽位在闸前登记 ⇒ 排队时的取消也能在这里被看到。）
    match cancel_rx.try_recv() {
        Ok(()) | Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
            return Err(GroupFileSendErr::Cancelled);
        }
        Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
    }
    let gf = db::get_group_file(
        &state.db.lock().unwrap_or_else(|e| e.into_inner()),
        transfer_id,
    )
    .ok_or_else(|| GroupFileSendErr::Unrecoverable("群文件记录不存在".into()))?;
    let group_key = get_group_key(state, group_id)
        .await
        .ok_or_else(|| GroupFileSendErr::Retryable("群密钥缺失".into()))?;
    let file_key = ensure_group_file_key(state, transfer_id, group_id, &group_key)
        .ok_or_else(|| GroupFileSendErr::Retryable("文件会话密钥缺失".into()))?;
    let sealed_file_key = STANDARD.encode(
        crypto::seal_symmetric(&group_key, &file_key)
            .ok_or_else(|| GroupFileSendErr::Retryable("封装文件密钥失败".into()))?,
    );

    // 源文件必须仍存在：不存在则该 recipient 置 failed（明确状态变化，
    // 不允许数据库停留在 pending 却永远无法投递）
    let src = std::path::PathBuf::from(source_path);
    let size = match std::fs::metadata(&src) {
        Ok(m) if m.is_file() => m.len(),
        _ => {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            let _ = db::update_group_file_recipient(&dbc, transfer_id, recipient, "failed", 0.0);
            return Err(GroupFileSendErr::Unrecoverable("源文件已不存在".into()));
        }
    };

    // recipient → sending + Offer
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = db::update_group_file_recipient(&dbc, transfer_id, recipient, "sending", 0.0);
    }
    // 整条群文件流（Offer → Chunk → Done）**钉在同一条链路**上。
    // 为什么 Offer 也必须钉：它和分片不同优先级（Offer=Normal、Chunk=Low），走 `try_send`
    // 时是按消息各自选路的 —— 一次 burst 里两个成员各一条流，Normal 满掉就会 failover 到
    // 另一条连接，于是 Offer 落在链路 A、分片落在链路 B。接收端**没有该 transfer 的会话密钥
    // 时是静默 return**（不报错、不回执），等 Offer 到达时前面那批分片已经丢了 ⇒ 首个 seq
    // 对不上 ⇒ 整条传输判死。真机形状：群里连发 9-10 张总有 1-2 张收不全、单发同一张必成功。
    let link = crate::network::transport::resolve_stream_link(state, recipient)
        .await
        .ok_or_else(|| GroupFileSendErr::Retryable("未建立连接".into()))?;
    // 续传：对端声明了能力位才注册回执槽位并等待；否则保持"发完 Offer 直接分片"的旧路。
    let sender_can_resume = state
        .peer_content_features
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(recipient)
        .is_some_and(|f| f & crate::protocol::CONTENT_FEATURE_GROUP_FILE_RESUME != 0);
    let round = state
        .group_file_round_seq
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        .wrapping_add(1);
    // 只有"这一轮确实会等 Resume"时才带 attempt：接收端把 attempt 当作握手标记，
    // 不带它就走旧路。否则会出现"发送端没等、接收端却按偏移准备好了追加"的错位。
    let send_attempt = sender_can_resume.then_some(round);
    let waiter_key = file::file_peer_key(transfer_id, recipient);
    let mut resume_rx = if sender_can_resume {
        let (tx, rx) = tokio::sync::oneshot::channel::<u64>();
        state
            .group_file_resume_waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(waiter_key.clone(), tx);
        Some(rx)
    } else {
        None
    };
    // 槽位与守卫同生共死：下面任何提前返回（含外层 timeout 丢 future）都会摘掉它。
    let _resume_slot = sender_can_resume.then(|| ResumeWaiterGuard {
        state,
        key: waiter_key.clone(),
    });
    let offer = Message::GroupFileOffer {
        transfer_id: transfer_id.to_string(),
        group_id: group_id.to_string(),
        sender_id: state.device_id.clone(),
        name: gf.name.clone(),
        size,
        sha256: gf.sha256.clone(),
        sealed_file_key,
        scope: gf.scope.clone(),
        todo_id: gf.todo_id.clone(),
        attempt: send_attempt,
    };
    if let Err(e) = crate::network::transport::send_on_link(&link, &offer).await {
        // Offer 没发出去 ⇒ 不会有回执（槽位由 `_resume_slot` 在返回时摘掉）。
        return Err(GroupFileSendErr::Retryable(format!("Offer 发送失败：{e}")));
    }

    // 期限按体积自适应（与单聊同一口径，见 `file::send_deadline_for`）：
    // 固定 10min 窗口下 500-600MB 的视频在群发里必被误判超时。
    let deadline = file::send_deadline_for(size);
    let result = tokio::time::timeout(deadline, async {
        // 流式分片：按**该接收者的实际链路**选块大小 → AEAD（独立随机 nonce）→ Base64 → GroupFileChunk。
        //
        // ⚠️ 不能再用固定的 256KiB（原 `FILE_CHUNK`）：BLE 上 256KiB base64 后约 350KB，
        // MTU=23 时需 ≈25000 片 > `MAX_BLE_CHUNKS_PER_MESSAGE`(8192) ⇒ `fragment()` 返回 `None`
        // ⇒ 整帧被丢（只留一条 warn），而发送方界面照旧显示"已发送"
        // —— 即**群文件在 BLE 上等于 0 字节可达**。
        // 单聊路径早已用 `chunk_size_for_path` 修掉同一个坑（推导见 `network/file.rs`），这里补齐。
        //
        // 分块大小读**这条已钉住的链路**的 path_kind（BLE 上必须 4KiB，见 chunk_size_for_path）。
        let chunk_size = file::chunk_size_for_path(link.path_kind.as_str());
        // 对端声明了能力位 ⇒ 等它给出可用前缀（接收端是权威）。
        // 超时/非法偏移一律按可重试处理，**绝不从头重发**：接收端可能已经按 n 准备好追加了，
        // 这时再从 0 发会把前缀重复写一遍（单聊为这一类付过学费）。
        let resume_from = match resume_rx.as_mut() {
            Some(rx) => {
                let wait_ms = file::group_resume_wait_ms(size);
                match tokio::time::timeout(std::time::Duration::from_millis(wait_ms), &mut *rx)
                    .await
                {
                    Ok(Ok(n)) if n <= size => n,
                    Ok(Ok(_)) => {
                        return Err(GroupFileSendErr::Retryable(
                            "对端报的续传偏移超过文件大小".into(),
                        ))
                    }
                    _ => return Err(GroupFileSendErr::Retryable("等待群文件续传回执超时".into())),
                }
            }
            None => 0,
        };
        let resume_from = match file::send_start_from(resume_from, size) {
            Ok(file::GroupSendStart::From(n)) => n,
            Ok(file::GroupSendStart::AlreadyHave) => {
                // 对端已完整持有：不重传。它已发完成 ACK；万一下一轮 ACK 丢了，P2-01 的
                // stale-sending 清扫器会重新投递 Offer，对端会再回一次 ACK。
                return Ok(());
            }
            Err(why) => return Err(GroupFileSendErr::Retryable(why.into())),
        };
        let mut f = tokio::fs::File::open(&src)
            .await
            .map_err(|e| GroupFileSendErr::Retryable(format!("打开源文件失败：{e}")))?;
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        if resume_from > 0 {
            f.seek(std::io::SeekFrom::Start(resume_from))
                .await
                .map_err(|e| GroupFileSendErr::Retryable(format!("定位续传偏移失败：{e}")))?;
        }
        let mut buf = vec![0u8; chunk_size];
        let mut seq: u32 = 0;
        let mut sent: u64 = resume_from;
        // 本次投递的起点 + 停滞提示状态（与单聊共用 `file::stall_tick`）
        let stream_started_ms = db::now_ms();
        let mut stalled_shown = false;
        let mut last_report = std::time::Instant::now() - std::time::Duration::from_secs(1);
        loop {
            // 每片开始前先查 cancel —— 用户点了"取消发送"就立刻停
            let n = tokio::select! {
                biased;
                _ = &mut cancel_rx => {
                    return Err(GroupFileSendErr::Cancelled);
                }
                n = f.read(&mut buf) => n
                    .map_err(|e| GroupFileSendErr::Retryable(format!("读源文件失败：{e}")))?,
            };
            if n == 0 {
                break;
            }
            // 每片刷新 TTL：大文件/慢链路超过 2h 也不该中途丢 key。
            let Some(key) = state.touch_group_file_key(transfer_id) else {
                return Err(GroupFileSendErr::Retryable("文件会话密钥丢失".into()));
            };
            let sealed = crypto::seal_symmetric(&key, &buf[..n])
                .ok_or_else(|| GroupFileSendErr::Retryable("分片加密失败".into()))?;
            let data = STANDARD.encode(&sealed);
            let chunk = Message::GroupFileChunk {
                transfer_id: transfer_id.to_string(),
                group_id: group_id.to_string(),
                sender_id: state.device_id.clone(),
                seq,
                data,
                attempt: send_attempt,
            };
            // 投到**钉住的这条**链路：队列满时原地等背压，绝不换链路（换路 = 分片失序）；
            // 等待期间做停滞检查（与单聊同一套 `file::stall_tick`）。
            tokio::select! {
                biased;
                _ = &mut cancel_rx => {
                    return Err(GroupFileSendErr::Cancelled);
                }
                r = crate::network::transport::send_on_link_with_tick(
                    &link,
                    &chunk,
                    file::FILE_STALL_TICK,
                    || file::stall_tick(
                        state,
                        transfer_id,
                        recipient,
                        stream_started_ms,
                        &mut stalled_shown,
                    ),
                ) => {
                    r.map_err(|e| GroupFileSendErr::Retryable(format!("分片发送失败：{e}")))?;
                }
            }
            sent += n as u64;
            // 真实本地进度节流落库（250ms），并向前端推送进度事件。
            if last_report.elapsed() >= std::time::Duration::from_millis(250) {
                last_report = std::time::Instant::now();
                let progress = if size == 0 {
                    1.0
                } else {
                    sent as f64 / size as f64
                };
                // 发送方气泡的进度口径：**只按发送时在线的成员平均**（用户 2026-09-12 反馈）。
                // 离线成员不计入分母、之后补发也不回退进度条；在线成员全部完成即 100%。
                //
                // ⚠️ 先算聚合再取 db 锁：`group_file_online_progress` 内部要读 DB，
                // 若在持有 db 锁时调用就是同锁重入（std Mutex 不可重入，必死锁）。
                // 聚合口径取「在线成员各自进度的平均」，因此这里传入的是**本条连接**的
                // 字节进度，函数内部再与落库值取 max（同一 recipient 的进度单调不减）。
                let max_progress = group_file_online_progress(state, transfer_id, progress);
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                let _ = db::update_group_file_recipient(
                    &dbc,
                    transfer_id,
                    recipient,
                    "sending",
                    progress,
                );
                let _ = db::upsert_transfer(
                    &dbc,
                    transfer_id,
                    group_id,
                    &gf.name,
                    size,
                    "send",
                    "active",
                    Some(source_path),
                    max_progress,
                );
                drop(dbc);
                let _ = state.app.emit(
                    "file-progress",
                    &crate::state::FileProgress {
                        transfer_id: transfer_id.to_string(),
                        received: (size as f64 * max_progress) as u64,
                        total: size,
                    },
                );
            }
            seq += 1;
        }
        // Done：分片全部发出，接收端据此做最终校验
        // 本轮实际补传字节数：S5 的"没有整份重传"就靠这一行现算。
        state.logger.info(
            "group_file",
            format!(
                "群文件本轮发送完成 transfer={transfer_id} peer={recipient} from={resume_from} \
                 sent_this_round={} size={size}",
                sent.saturating_sub(resume_from)
            ),
        );
        let done = Message::GroupFileDone {
            transfer_id: transfer_id.to_string(),
            group_id: group_id.to_string(),
            sender_id: state.device_id.clone(),
            attempt: send_attempt,
        };
        // Done 也必须排在**自己那串分片之后**：走 `try_send` 时队列满会 failover 到另一条
        // 空闲连接，完成帧超过仍在路上的分片先到 ⇒ 接收端判"未完成"打死整条传输。
        crate::network::transport::send_on_link(&link, &done)
            .await
            .map_err(|e| GroupFileSendErr::Retryable(format!("Done 发送失败：{e}")))?;
        // 收尾：与单聊 send_file_from_path 同理 — 确保前端收到 100% progress + done 事件。
        let _ = state.app.emit(
            "file-progress",
            &crate::state::FileProgress {
                transfer_id: transfer_id.to_string(),
                received: size,
                total: size,
            },
        );
        let _ = state.app.emit(
            "file-done",
            &crate::state::FileDoneInfo {
                transfer_id: transfer_id.to_string(),
                name: gf.name.clone(),
                size,
                path: source_path.to_string(),
            },
        );
        Ok(())
    })
    .await;

    // 取消槽位由 `_cancel_slot` 在返回时摘掉（手写 remove 在 timeout 丢 future 时走不到）。

    // 外层只区分"内层自己报了错"与"到期限"两种：内层的类型化错误原样透传；
    // 到期限必然是"没在期限内发完" ⇒ 按可重试处理（下一次建链 / 心跳会重新投递，
    // 与单聊 `file::RetryVerdict::Retry` 同一口径）。
    match result {
        Ok(inner) => inner,
        Err(_) => Err(GroupFileSendErr::Retryable(format!(
            "群文件发送超时（超过 {}s）",
            deadline.as_secs()
        ))),
    }
}

// ---------------- 测试 ----------------
include!("group_file_dispatch_tests.rs");
