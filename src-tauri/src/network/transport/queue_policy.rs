// 链路队列的容量策略（字节预算 / 槽数折算 / 写失败分流，第 2 步 · P3）
// 从 transport.rs 搬出：`include!` 回同一模块 ⇒ 模块路径、可见性、测试全名一字不变。
// 大文件拆分第二批，判据与顺序见 docs/large-file-split-plan.md。

/// 一个对端的内容服务队列深度。**有界是这份设计唯一买的东西**：满了显式拒绝，
/// 由请求方既有的退避 + 心跳机会重投（见 `handle_identity.rs` 心跳臂那句 `retry_incomplete_content`）。
/// 8 的来源：一次服务最坏 15 秒（等接受）或整份文件，同一条链路上并发几十个内容请求并不存在
/// —— 手机那次真机日志里一轮突发是 14 条，超出部分本就该被合并/拒绝而不是无界排队。
pub(crate) const FILE_SERVICE_QUEUE_CAP: usize = 8;

/// 一条链路 **low 队列**允许压住多少字节的待发分块。///
/// 为什么是字节而不是帧数：旧形状是四个建链点各写三条 `mpsc::channel`、深度都是 1024，
/// 而一片 LAN 分块上线约 341 KB ⇒ **单链路最坏 ~350 MB**，多链路/群文件按连接翻倍，
/// 手机上就是 OOM 或整机变慢。背压本来就有（`send_on_link` 满了原地等 + `stall_tick`），
/// 错的只是"缓冲先分配完才开始排队"。8 MB ≈ 24 片 LAN 分块，够 writer 连续排空用。
pub const LINK_QUEUE_BYTE_BUDGET: usize = 8 * 1024 * 1024;

/// 只**收紧**不放宽：今天就是 1024，小分片（BLE 4 KB）时保持原深度。
const LINK_QUEUE_MAX_SLOTS: usize = 1024;

/// 折算下限。必须 ≥1（`mpsc::channel(0)` 直接 panic），留 8 是为了还能流水。
const LINK_QUEUE_MIN_SLOTS: usize = 8;

/// high / normal 两条队列的深度（帧数）。这两条上只有消息与控制帧，被
/// `MAX_MESSAGE_LEN` 与各类载荷上限卡着，不是内存问题 —— 保持今天的 1024 不动。
/// 起名而不写字面量是为了让"只剩一处策略"这件事可被判据检查。
const CONTROL_QUEUE_SLOTS: usize = 1024;

/// 一条队列的收发两端（`mpsc` 的一对）。
type LinkQueue = (mpsc::Sender<Message>, mpsc::Receiver<Message>);

/// 按"这一条链路会装的最大分片"把字节预算折算成槽数。纯函数、单调。
pub fn low_queue_slots(chunk_plain_bytes: usize) -> usize {
    let wire = crate::network::file::chunk_wire_bytes(chunk_plain_bytes).max(1);
    (LINK_QUEUE_BYTE_BUDGET / wire).clamp(LINK_QUEUE_MIN_SLOTS, LINK_QUEUE_MAX_SLOTS)
}

/// 一条链路的三条队列（high / normal / low），四个建链点共用这一份策略。
///
/// high/normal 仍按帧数；只有 low（分块通道）按字节预算 —— 分片是这里唯一能到几百 KB 的东西。
/// 优先级模型一字未动，这次只改容量语义。
pub(crate) fn link_channels(chunk_plain_bytes: usize) -> (LinkQueue, LinkQueue, LinkQueue) {
    (
        mpsc::channel(CONTROL_QUEUE_SLOTS),
        mpsc::channel(CONTROL_QUEUE_SLOTS),
        mpsc::channel(low_queue_slots(chunk_plain_bytes)),
    )
}

/// 单次写出的结果（D8-4）。把"主动放弃"与"写失败"分开：
/// 前者是我们在停机/拆链路，不该记成链路故障（否则选路会把正在关闭的链路算成失败）。
///
/// `Local` 是第三种（第 1 步 · 故障隔离）：**载荷自身不可写**（超长 / 序列化不出来），
/// 一个字节都没上链路 ⇒ 这一帧作废即可，**链路保留**。
/// 旧形状是 `res.is_ok()` 一把抓 ⇒ 一条永远发不出去的超大帧会把整条连接判死，
/// 再顺带拖掉同一 peer 其它链路上正在跑的文件传输。
enum WriteOutcome {
    Ok,
    Local(String),
    Failed,
    Stopped,
}

#[allow(clippy::too_many_arguments)]
async fn writer_loop(
    state: Arc<AppState>,
    peer_id: String,
    // 本连接的端点：健康信号要按**连接**记，必须能唯一定位到是哪一条。
    // 类型是 transport 无关的 `Endpoint`（BLE 也需要它）。
    endpoint: MeshEndpoint,
    mut w: TcpSender,
    mut high_rx: mpsc::Receiver<Message>,
    mut normal_rx: mpsc::Receiver<Message>,
    mut low_rx: mpsc::Receiver<Message>,
    mut shutdown: watch::Receiver<bool>,
    // 本连接的取消信号（M3#6）：由健康 watchdog 在半开链路上触发。
    mut cancel: watch::Receiver<bool>,
    // 同一条链路的**发送端**：写不出去时由这里点亮判死（与 watchdog 同一条出口）。
    cancel_tx: watch::Sender<bool>,
) {
    let mut high_open = true;
    let mut normal_open = true;
    let mut low_open = true;
    loop {
        if !high_open && !normal_open && !low_open {
            break;
        }
        let msg = tokio::select! {
            biased;
            // 停止信号优先：立刻放弃待发帧并 drop 写半，让 socket 尽快关闭
            // （Windows 上配合 SO_LINGER=0 发 RST，不留下 TIME_WAIT）。
            _ = shutdown.changed() => break,
            // 本连接被判死（读活性长期过期）→ 与全局停机同样立即收尾。
            _ = cancel.changed() => break,
            maybe = high_rx.recv(), if high_open => maybe,
            maybe = normal_rx.recv(), if normal_open => maybe,
            maybe = low_rx.recv(), if low_open => maybe,
        };
        match msg {
            Some(msg) => {
                // ⚠️ **写必须可被打断**（D8-4）：对端不读时发送缓冲满，`write_all` 会长时间
                // 阻塞；而 shutdown/cancel 只有在回到循环顶部才会被轮询 ⇒ 退出流程与
                // watchdog 的"精确拆链路"在写阻塞场景下都会失效（STOP_TASK_TIMEOUT 兜底
                // 也只能打日志放行）。放进 select 后，停机与判死都能立刻放弃这一帧。
                //
                // 主动放弃时**不记失败**：那不是链路故障，是我们自己在拆。半写出去的分片
                // 会让对端看到截断帧并自行断开 —— 本来就是要断的链路，无妨。
                let outcome = tokio::select! {
                    biased;
                    _ = shutdown.changed() => WriteOutcome::Stopped,
                    _ = cancel.changed() => WriteOutcome::Stopped,
                    res = write_frame(&mut w, &msg) => match res {
                        Ok(()) => WriteOutcome::Ok,
                        Err(WriteError::Local(why)) => WriteOutcome::Local(why),
                        // 真 socket 写失败 ⇒ 这条连接已经不可信，照旧走下面的判死+拆链。
                        // ⚠️ 这一格以前把 `e` 整个丢掉（`Err(WriteError::Socket(_))`）⇒
                        // "回执进了 mpsc 但没上链路"与"回执压根没发"两种现场在日志里长一样，
                        // J2 四轮 0 条 `stage=ack-*` 就是被这一格挡住读不下去。
                        Err(WriteError::Socket(e)) => {
                            if let Some(note) = crate::network::file::ack_writer_failure_note(
                                &msg,
                                "socket",
                                &e.to_string(),
                            ) {
                                state.logger.error("file", note);
                            }
                            WriteOutcome::Failed
                        }
                    }
                };
                if matches!(outcome, WriteOutcome::Ok) {
                    // 写成功只记**出站**活性（诊断口径）。M3-0b 起它**不**参与 is_healthy：
                    // 半开 TCP 上写会一直"成功"，那是本缺陷要被排除的伪证据。
                    mark_conn_write_seen(&state, &peer_id, &endpoint);
                    mark_file_wire_progress(&state, &msg, &peer_id);
                    continue;
                }
                if matches!(outcome, WriteOutcome::Stopped) {
                    break;
                }
                if let WriteOutcome::Local(why) = outcome {
                    // 载荷自身不可写（超长 / 序列化不出来）：一个字节都没上链路 ⇒
                    // 这一帧作废，**链路保留**、不记连接失败。
                    // ⚠️ 必须响：静默丢帧违反 INV-005「不允许静默丢失」。发不出去的帧
                    //    仍留在 outbox / file_outbox 里，界面上是"未送达/排队中"而不是"已送达"。
                    eprintln!(
                        "[gosslan][WRITE] peer={peer_id} 帧 {} 本机就写不出去，已丢弃这一帧（链路保留）：\
                         {why} —— 这是本机 bug，换链路也会同样失败，别当网络问题查",
                        msg.wire_kind()
                    );
                    if let Some(note) =
                        crate::network::file::ack_writer_failure_note(&msg, "local", &why)
                    {
                        // eprintln 进的是 stdout 捕获，本轮 J2 的判据读的是应用日志 ⇒ 两处都要有，
                        // 否则"回执没写成"又会变成一个只有翻 stdout 才看得见的现场。
                        state.logger.error("file", note);
                    }
                    continue;
                }
                {
                    // TCP write 失败：普通消息由 outbox 重发；ReadReceipt 需要特殊处理——
                    // 它没有 outbox 行，如果 pending 已被 flush_pending_reads 清除，
                    // 此处不恢复就永久丢失。将 timestamp 重新放回 pending_reads，
                    // 下一次建链 / Hello / Heartbeat 会再次 flush 重发。
                    if let Message::ReadReceipt { last_read_ts, .. } = &msg {
                        let mut pending = state
                            .pending_reads
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        let cur = pending.entry(peer_id.clone()).or_insert(*last_read_ts);
                        *cur = (*cur).max(*last_read_ts);
                    }
                    // 这条连接已经写不出去了 —— 记一次失败，供 M3 的选路与收敛使用。
                    mark_conn_failure(&state, &peer_id, &endpoint);
                    // ⚠️ 还必须**拆掉这一条链路**（2026-10-15 全链路审计的已证实缺陷）。
                    // 旧形状是"记一次失败 + break"，链路仍留在 `state.links` 里 —— 于是形成
                    // **单向黑洞**：本机的读半还活着（对端心跳照收 ⇒ `touch_peer` 把 peer 顶成在线，
                    // 45s 读活性看门狗也不会 reap），而这一条的 writer 已经死了 ⇒
                    //  · `try_send` 之后永远返回"连接已关闭"（outbound.rs 那份判定），消息只进 outbox；
                    //  · `ensure_link` 的 `has_lan_path` 因为表里那条 LAN 链路还在而**拒绝重拨**；
                    //  · `is_healthy` 对 1 次连续失败仍判健康。
                    // 三者叠加 ⇒ 除非重启进程（或对方自己先拆）就再也发不出去，正是用户说的
                    // "要双方反复重启应用才能恢复"。上面 `:113` 那句注释本来就写着"照旧走
                    // 判死+拆链"，这一格是代码没跟上注释。
                    //
                    // 出口用**同一条**：点亮本链路的 cancel ⇒ reader_loop 在 `:191` 一起退出，
                    // 由它那份收尾精确摘除本 channel（空了才删 key、mesh 层同步注销、必要时才标离线），
                    // 不在这里重复实现一遍拆链。
                    if log_throttled("writer_dead", 5_000) {
                        state.logger.warn(
                            "link",
                            format!("写失败判死拆链 peer={peer_id} ep={endpoint}（读半可能仍活着，不算本机故障）"),
                        );
                    }
                    let _ = cancel_tx.send(true);
                    break;
                }
            }
            None => {
                // select 无法直接区分是哪个分支关闭，用三个 recv 的 is_closed 兜底。
                if high_rx.is_closed() {
                    high_open = false;
                }
                if normal_rx.is_closed() {
                    normal_open = false;
                }
                if low_rx.is_closed() {
                    low_open = false;
                }
                if !high_open && !normal_open && !low_open {
                    break;
                }
            }
        }
    }
}

async fn reader_loop(
    state: Arc<AppState>,
    mut r: TcpReceiver,
    peer_id: String,
    // 本连接的端点，用于按连接记健康信号。
    endpoint: MeshEndpoint,
    link_tx: mpsc::Sender<Message>,
    mut shutdown: watch::Receiver<bool>,
    // 本连接的取消信号（M3#6）：半开链路上的读会永久阻塞，只有它能打断。
    mut cancel: watch::Receiver<bool>,
) {
    loop {
        let res = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            _ = cancel.changed() => break,
            res = read_frame(&mut r) => res,
        };
        match res {
            Ok(msg) => {
                // 入站读到帧是比「写成功」**更强**的活性证据：对端确实活着（不只是内核收下了
                // 我们的字节）。这条信号正是半开 TCP 场景下唯一能区分「真活 / 假活」的东西。
                mark_conn_seen(&state, &peer_id, &endpoint);
                // ⚠️ 入站队头阻塞的留痕（用户 2026-10-13「刚加好友，他收不到我发的群聊和单聊」）。
                // 这个循环**一帧一帧串行 await** ⇒ 任何一支 handler 等得久，后面所有入站帧
                // （群聊、单聊、连心跳/Hello 都在同一个 match 里）都得排队。已核实会等久的出口：
                // `handle_share.rs` 的 ContentRequest 那一支就地 await 文件发送
                // （等 FileAccept 最长 15s：`file/send.rs` 的 `Duration::from_secs(15)`；
                // 对方接受了则要等**整个文件**传完，没有上界）。
                // 机制是读代码读出来的，此前**没有任何读数量它** ⇒ 这一行把推断变成可测量。
                // 只记耗时与 peer，不记正文/类型。节流键受 `log_throttled` 的 `&'static str` 限制
                // 是**全局**一份 ⇒ 5 秒窗口内多条链路只记第一条（宁可少记，绝不在热路径上刷屏）。
                let t0 = std::time::Instant::now();
                handle_message(&state, &peer_id, msg).await;
                let blocked_ms = t0.elapsed().as_millis() as i64;
                if blocked_ms >= 3_000 && log_throttled("inbound_head_of_line", 5_000) {
                    state.logger.warn(
                        "link",
                        format!(
                            "入站处理占用接收循环 {blocked_ms}ms（这段时间该链路的后续帧都在排队）peer={peer_id}"
                        ),
                    );
                }
            }
            Err(e) => {
                // 读循环退出必须留痕：它是"链路为什么消失"的唯一现场证据。
                //
                // 2026-10-22 e2e（`--round=posttext`）：文件 `COMPLETED` 后 4 秒链路就没了，
                // 日志里只有一行「掉线（链路断开）」，分不清是对端关了写侧、本地 read 出错、
                // 还是被上面的 shutdown/cancel 分支打断（那两条也是静默 break）。
                // 没有这一行，只能靠猜去动传输层 —— 而这一层猜错的代价是丢块/乱序。
                state.logger.info(
                    "link",
                    format!("读循环结束 peer={peer_id} err={e:?}"),
                );
                break;
            }
        }
    }
    // ⚠️ 这里**不再**清接收器（P1 故障隔离）。旧形状是"这条连接的读半一结束就按 peer 清"，
    // 而同一 peer 完全可以同时挂着 LAN + Tailscale + BLE 多条链路 ⇒
    // 断其中一条会连带杀掉另外几条链路上**正在收**的文件（下面 `:1563` 那段
    // 早就写明了「断一条 ≠ peer 下线」，文件这两处一直与它自相矛盾）。
    // 清理挪到下面算出 `peer_now_offline` 之后，只在"这个 peer 真的没有任何链路了"时做；
    // "对端在线但这一单被放弃"那种情形由 `sweep_stalled_receives` 负责回收。
    // 只移除**这一条**连接（按 channel 身份匹配），不是整条删光：
    // 同一 peer 可能还连着别的端点（LAN + Tailscale），断一条 ≠ peer 下线 ——
    // 这正是 6b 的核心语义。旧实现整条 remove，会让另一条连接一起消失。
    let peer_now_offline = {
        // 先记下被移除的是哪个端点（mesh 层要按端点删对应的 Connection）
        let removed_endpoint = {
            let links = state.links.lock().await;
            links
                .get(&peer_id)
                .and_then(|list| list.iter().find(|l| l.low.same_channel(&link_tx)))
                .map(|l| l.endpoint.clone())
        };
        let mut links = state.links.lock().await;
        let removed = match links.get_mut(&peer_id) {
            Some(list) => {
                let before = list.len();
                list.retain(|l| !l.low.same_channel(&link_tx));
                list.len() != before
            }
            None => false,
        };
        // 移除后该 peer 已无任何连接 → 才算真的离线，并**把空的 Vec 一起删掉**。
        let empty = links.get(&peer_id).map_or(true, |v| v.is_empty());
        if removed && empty {
            // ⚠️ 只 retain 不删 key 会留下一个**空 Vec**，而好几处判定用的是
            // `links.keys()` / `contains_key`（不是 `has_link` 的非空判据）：
            //  - `sweep_peers` 认为「有活跃链路」→ 该 peer 永不被清扫；
            //  - `get_friends` 的 Friend.online 恒 true → 前端**永久显示在线**；
            //  - 定向转发 `contains_key` 命中「直连」分支 → `try_send` 失败后
            //    **不再洪泛兜底**，跨跳的好友申请/回执可能永久丢失。
            // 一次「连过又掉线」的节点就能让上述三条同时成立（复核抓到的 High 缺陷）。
            links.remove(&peer_id);
        }
        let offline = peer_offline_after_tail(removed, empty);
        drop(links);
        // 释放 links 锁后再动 mesh 层（避免持锁嵌套）
        if let Some(ep) = removed_endpoint {
            unregister_connection(&state, &peer_id, &ep);
        }
        offline
    };
    // 所有连接都断了才标记离线；还剩别的连接则保持在线（failover 生效）
    if peer_now_offline {
        mark_peer_offline(&state, &peer_id).await;
        // 只有到这一步才有资格清接收器：这个 peer 确实一条链路都不剩了。
        // 单聊与群文件两张表同规矩（旧代码把它们放在上面，与 `:1563` 的"只删这一条"矛盾）。
        file::fail_receives_for_peer(&state, &peer_id);
        // 摘表与判据同一次持锁（旧写法是锁内 collect id、锁外逐个收尾 ——
        // 那两步之间挤进来的新 FileOffer 会被误判死，见 file::take_group_receives_for_peer）。
        let taken = file::take_group_receives_for_peer(&state, &peer_id);
        // 收尾在锁外：里面要写库、要 emit，都不该持着接收表。
        // ★ 摘出来的那一份必须一起用完：`fail_taken_group_receive` 是群收件人**内容台账**
        //   （`record_failure` ⇒ Incomplete，建链时按退避自动重取）的唯一写点，只调 finalize
        //   那一半会把台账留在 Active。超时那一路（`sweep_stalled_receives`）一直是成对调的。
        for (tid, r) in taken {
            file::fail_taken_group_receive(&state, &r);
            finalize_failed_group_receive(&state, &tid, REASON_PEER_UNLINKED);
        }
    }
    // 内容服务队列跟着这条链路一起收：还排在队列里的回发**不该在死链路上继续尝试**
    // （发送会失败、还把对端的容量占住）。关停方式沿用本文件既有的"丢端 ⇒ 收端自然结束"，
    // 不 kill 任务：worker 的 rx 结束 ⇒ 循环退出 ⇒ guard 摘掉注册（同一文件里的单测钉住这条）。
    state.file_service.close_peer(&peer_id);
}

// ==================== 文件服务调度器（每对端一个有界串行队列） ====================
//
// 为什么要它（2026-10-13 真机第 7 条）：`ContentRequest` 的服务此前在**接收循环里就地 await
// 整条文件握手**（`handle_share.rs` → `file/send.rs` 发 `FileOffer` 后 `timeout(15s, rx)`），
// 而那个应答要读的正是这条被堵住的循环 ⇒ 每次必走满 15 秒，同链路所有入站（群聊/单聊/心跳）全排队。
// 搬出去必须是**每对端串行**而不是裸 `tokio::spawn`：`pending_file_accept` 只按 `transfer_id`
// 单键登记，同链路多路并发传文件会互相挤掉登记（本仓历史上就在这张表上修过一次）。
//
// 纯层（不碰 `AppState`）⇒ 六条生命周期性质第一次能被单测钉住；生产侧只注入一个执行器闭包。

/// 一次"替对端回发一份内容"的工作。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FileServeJob {
    pub cid: String,
    pub peer_id: String,
    pub transfer_id: String,
    pub path: std::path::PathBuf,
    pub from_seq: u32,
    pub from_bytes: u64,
}

/// `submit` 的三种结局 —— 第三种**必须**是可断言的，因为"队列满只打日志然后丢单"
/// 就是这条链路下一轮的静默故障。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ServeTicket {
    Accepted,
    /// 同一 cid 已在队列里 ⇒ 合并掉（服务两次是纯浪费，还会撞同一个 transfer_id）
    Merged,
    /// 队列满 ⇒ 拒了，调用方要留痕；重投由请求方既有的退避 + 心跳驱动的机会完成
    RejectedFull,
}

/// 一个对端的一份队列。`generation` 用来区分"哪一任 worker 登记的"：
/// 快速重连时旧 worker 的清理**不许**把新 worker 摘掉。
#[derive(Default)]
struct PeerQueueState {
    /// 入队端。**被 close_peer 丢掉 ⇒ 收端自然结束 ⇒ worker 退出**（关停不靠轮询）。
    tx: Option<mpsc::Sender<FileServeJob>>,
    /// 出队端：只有一份，`start_worker` 把它取走；取不到 = 已有 worker 在跑。
    rx: Option<mpsc::Receiver<FileServeJob>>,
    generation: u64,
    running: bool,
    closed: bool,
    /// 已排队**或正在执行**的 cid。去重与"跑完才放开"都读它 ⇒ 同一条内容不会被排两次服务。
    queued: std::collections::HashSet<String>,
}

pub(crate) struct FileService {
    cap: usize,
    inner: std::sync::Mutex<std::collections::HashMap<String, PeerQueueState>>,
}

/// 全局单调递增的 worker 代号来源。**不按对端计数**：条目摘掉又重建时，若每对端都从 1 开始，
/// 迟到的旧 worker 清理就可能正好匹配上新那一代 ⇒ 把现役 worker 摘掉（那是"快速重连后没人服务"的形状）。
static SERVE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_serve_generation() -> u64 {
    SERVE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// worker 的收尾兜底：正常退出、`?`/return 早退、**执行器 panic 导致任务被 abort** 三条路都会走
/// `Drop` ⇒ 该对端的注册不会留僵尸（否则那个对端永远不会再被服务，且 map 随断连单调增长）。
struct ServeWorkerGuard {
    fs: std::sync::Arc<FileService>,
    peer: String,
    generation: u64,
}

impl Drop for ServeWorkerGuard {
    fn drop(&mut self) {
        self.fs.unregister_worker(&self.peer, self.generation);
    }
}

impl FileService {
    pub(crate) fn new(cap: usize) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            cap: cap.max(1),
            inner: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
    }

    fn fresh_entry(&self) -> PeerQueueState {
        let (tx, rx) = mpsc::channel(self.cap);
        PeerQueueState {
            tx: Some(tx),
            rx: Some(rx),
            generation: next_serve_generation(),
            ..Default::default()
        }
    }

    /// 一次投递尝试。`None` = 这一份条目不能用了（不存在 / 已关停 / 通道已死），调用方重建后再试。
    fn try_push(&self, job: &FileServeJob) -> Option<ServeTicket> {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let e = map.get_mut(&job.peer_id)?;
        if e.closed {
            return None;
        }
        if e.queued.contains(&job.cid) {
            return Some(ServeTicket::Merged);
        }
        let tx = e.tx.clone()?;
        match tx.try_send(job.clone()) {
            Ok(()) => {
                e.queued.insert(job.cid.clone());
                Some(ServeTicket::Accepted)
            }
            // 满了就是满了：**绝不偷偷排队**（有界性是这份设计唯一买的东西）。
            Err(mpsc::error::TrySendError::Full(_)) => Some(ServeTicket::RejectedFull),
            Err(mpsc::error::TrySendError::Closed(_)) => None,
        }
    }

    /// 入队。返回结局；**绝不阻塞调用方**（调用方是接收循环）。
    pub(crate) fn submit(self: &std::sync::Arc<Self>, job: FileServeJob) -> ServeTicket {
        if let Some(ticket) = self.try_push(&job) {
            return ticket;
        }
        {
            let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            map.insert(job.peer_id.clone(), self.fresh_entry());
        }
        // 第二轮仍推不进去（理论上到不了）⇒ 保守收在"拒"，不引入任何无界缓冲。
        self.try_push(&job).unwrap_or(ServeTicket::RejectedFull)
    }

    /// 起一个该对端的 worker；已有 worker 在跑就返回 `None`（幂等，不多起一份 ⇒ 不并行两份队列）。
    pub(crate) fn start_worker<F, Fut>(
        self: &std::sync::Arc<Self>,
        peer_id: &str,
        exec: F,
    ) -> Option<u64>
    where
        F: Fn(FileServeJob) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let (rx, generation) = {
            let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !map.contains_key(peer_id) {
                map.insert(peer_id.to_string(), self.fresh_entry());
            }
            let e = map.get_mut(peer_id)?;
            if e.running {
                return None;
            }
            // rx 只有一份：take 不到就说明已经有人在收（双保险，不依赖 running 这个布尔）
            let rx = e.rx.take()?;
            e.running = true;
            (rx, e.generation)
        };
        let fs = self.clone();
        let peer = peer_id.to_string();
        tokio::spawn(async move {
            let _guard = ServeWorkerGuard {
                fs: fs.clone(),
                peer: peer.clone(),
                generation,
            };
            let mut rx = rx;
            while let Some(job) = rx.recv().await {
                exec(job.clone()).await;
                // 跑完才放开这个 cid：同一条内容不许同时在队列里再排一份（服务两次是纯浪费）
                if let Some(e) = fs
                    .inner
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_mut(&peer)
                {
                    e.queued.remove(&job.cid);
                }
            }
            // 走到这里 = 所有 tx 已 drop（close_peer / 条目被重建）⇒ guard 退出即摘注册
        });
        Some(generation)
    }

    pub(crate) fn has_worker(self: &std::sync::Arc<Self>, peer_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_id)
            .map(|e| e.running)
            .unwrap_or(false)
    }

    /// 诊断用：该对端队列里还压着几个 cid（有界性的直接读数）。
    pub(crate) fn queued_len(self: &std::sync::Arc<Self>, peer_id: &str) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_id)
            .map(|e| e.queued.len())
            .unwrap_or(0)
    }

    /// 只允许"摘自己那一代"：快速重连时旧 worker 退出不许把新 worker 的登记清掉。
    pub(crate) fn unregister_worker(self: &std::sync::Arc<Self>, peer_id: &str, generation: u64) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = map.get_mut(peer_id) {
            if e.generation == generation {
                // 整条摘掉而不是留个 running=false 的空壳：留空壳就等于"这个对端有队列"，
                // 而它已经没人收了。摘掉之后新请求会重建一份并另起 worker。
                map.remove(peer_id);
            }
        }
    }

    /// 关停某对端的队列：拒收新任务、让 worker 自然退出（退出时由 guard 摘注册）。
    pub(crate) fn close_peer(self: &std::sync::Arc<Self>, peer_id: &str) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = map.get_mut(peer_id) {
            e.closed = true;
            // 丢掉唯一入队端 ⇒ recv() 返回 None ⇒ worker 结束。不 kill、不 panic。
            e.tx = None;
        }
    }
}

#[cfg(test)]
mod file_service_tests {
    use super::{FileServeJob, FileService, ServeTicket};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn job(cid: &str, peer: &str, tid: &str) -> FileServeJob {
        FileServeJob {
            cid: cid.to_string(),
            peer_id: peer.to_string(),
            transfer_id: tid.to_string(),
            path: PathBuf::from(format!("/tmp/{cid}.bin")),
            from_seq: 0,
            from_bytes: 0,
        }
    }

    /// 等一个条件成立（有界，避免"永远不红"的假绿：到点就是断言失败）。
    async fn wait_until<F: FnMut() -> bool>(mut f: F, ms: u64, why: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        loop {
            if f() {
                return;
            }
            if std::time::Instant::now() >= deadline {
                panic!("等不到：{why}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// ① 同一对端严格 FIFO 串行，且**同一时刻至多一个在飞**。
    #[tokio::test]
    async fn same_peer_jobs_are_serial_and_fifo() {
        let fs = FileService::new(8);
        let inflight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let order = Arc::new(Mutex::new(Vec::new()));
        // 三个不同 cid，先入队再起 worker ⇒ 队列里正好压着 3 条（cap=8，不触发溢出）
        for c in ["a", "b", "c"] {
            assert_eq!(fs.submit(job(c, "dev-a", "t-x")), ServeTicket::Accepted);
        }
        assert_eq!(fs.queued_len("dev-a"), 3);
        let (i2, p2, o2) = (inflight.clone(), peak.clone(), order.clone());
        let gen = fs
            .start_worker("dev-a", move |j: FileServeJob| {
                let (i2, p2, o2) = (i2.clone(), p2.clone(), o2.clone());
                async move {
                    let now = i2.fetch_add(1, Ordering::SeqCst) + 1;
                    p2.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    o2.lock().unwrap_or_else(|e| e.into_inner()).push(j.cid);
                    i2.fetch_sub(1, Ordering::SeqCst);
                }
            })
            .expect("首次 start_worker 必须真的起一个");
        assert!(gen > 0);
        assert!(fs.has_worker("dev-a"));
        // 三个 job 的入队顺序 = 执行顺序，且峰值并发 = 1
        let o3 = order.clone();
        wait_until(
            move || o3.lock().unwrap_or_else(|e| e.into_inner()).len() == 3,
            3_000,
            "3 个 job 要全部跑完（串行 FIFO）",
        )
        .await;
        assert_eq!(peak.load(Ordering::SeqCst), 1, "同一对端同一时刻只许一个文件服务在飞");
        assert_eq!(*order.lock().unwrap_or_else(|e| e.into_inner()), ["a", "b", "c"], "必须严格 FIFO，且不重排");
        // 同一对端再起第二任 worker 必须被拒（不许并行两份队列）
        assert!(fs.start_worker("dev-a", |_| async {}).is_none(), "已有 worker 时不得再起一份");
    }

    /// ② 同 cid 合并；不同 cid、不同对端**不许**合并。
    #[tokio::test]
    async fn merges_only_the_same_cid_of_the_same_peer() {
        let fs = FileService::new(8);
        assert_eq!(fs.submit(job("x", "dev-a", "t1")), ServeTicket::Accepted);
        assert_eq!(fs.submit(job("x", "dev-a", "t2")), ServeTicket::Merged, "同 cid 重复请求要合并");
        assert_eq!(fs.submit(job("y", "dev-a", "t3")), ServeTicket::Accepted, "不同 cid 不许被合并掉");
        assert_eq!(fs.submit(job("x", "dev-b", "t4")), ServeTicket::Accepted, "不同对端不许互相吞");
        assert_eq!(fs.queued_len("dev-a"), 2);
        assert_eq!(fs.queued_len("dev-b"), 1);
    }

    /// ③ 队列满 ⇒ 明确拒绝 + 容量能被恢复（worker 消化掉一个之后又可入队），不是无限增长。
    #[tokio::test]
    async fn overflow_is_bounded_and_recovers() {
        let fs = FileService::new(2);
        assert_eq!(fs.submit(job("c1", "dev-a", "t1")), ServeTicket::Accepted);
        assert_eq!(fs.submit(job("c2", "dev-a", "t2")), ServeTicket::Accepted);
        assert_eq!(fs.submit(job("c3", "dev-a", "t3")), ServeTicket::RejectedFull, "超容量必须显式拒绝");
        assert_eq!(fs.queued_len("dev-a"), 2, "被拒的那条不许偷偷进队列（有界性）");

        let done = Arc::new(AtomicUsize::new(0));
        let d2 = done.clone();
        fs.start_worker("dev-a", move |_| {
            let d2 = d2.clone();
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                d2.fetch_add(1, Ordering::SeqCst);
            }
        })
        .expect("worker 应起来");
        // 消化掉至少一个 ⇒ 容量恢复 ⇒ 同一条 cid 后来还能重新排队（"队列满丢单"必须有可验证的重投路径）
        wait_until(move || done.load(Ordering::SeqCst) >= 1, 2_000, "worker 要消费掉一个 job").await;
        assert_eq!(fs.submit(job("c3", "dev-a", "t3")), ServeTicket::Accepted, "容量恢复后必须能再入队");
    }

    /// ④ 断线 / 快速重连：旧 worker 的清理不许动新 worker 的登记（不污染新会话）。
    #[tokio::test]
    async fn a_retiring_old_worker_does_not_kick_the_new_one() {
        let fs = FileService::new(4);
        let g1 = fs
            .start_worker("dev-a", |_| async { tokio::time::sleep(std::time::Duration::from_millis(50)).await })
            .expect("第一任 worker");
        // 模拟"这代 worker 退出"的清理（生产里由 Drop guard 做）：只允许摘自己那一代
        fs.unregister_worker("dev-a", g1 + 999);
        assert!(fs.has_worker("dev-a"), "别的代号的清理不许把现役 worker 摘掉");
        fs.unregister_worker("dev-a", g1);
        assert!(!fs.has_worker("dev-a"), "自己那一代的清理必须生效");
    }

    /// ⑤ shutdown / 通道关闭：worker 能退出并摘除注册；任务 panic 也不留僵尸条目。
    #[tokio::test]
    async fn worker_exits_and_unregisters_after_shutdown_and_panic() {
        let fs = FileService::new(4);
        // (a) 正常关停：submit 不再被接受，注册被摘
        let g = fs
            .start_worker("dev-a", |_| async {})
            .expect("worker 起来");
        assert!(fs.has_worker("dev-a"));
        fs.close_peer("dev-a");
        wait_until({ let fs = fs.clone(); move || !fs.has_worker("dev-a") }, 2_000, "关停后必须摘除注册")
            .await;
        assert_eq!(fs.submit(job("z", "dev-a", "tz")), ServeTicket::Accepted, "关闭后应能重建队列（下一次请求另起 worker）");
        let _ = g;

        // (b) 执行器 panic：guard 必须在 unwind 时摘掉登记，不能留永久占位
        let fs2 = FileService::new(4);
        fs2.submit(job("boom", "dev-b", "tb"));
        fs2.start_worker("dev-b", |_| async { panic!("模拟任务内 panic") })
            .expect("worker 起来");
        wait_until(
            { let fs2 = fs2.clone(); move || !fs2.has_worker("dev-b") },
            2_000,
            "panic 之后注册必须被清掉（否则该对端永远不会再被服务）",
        )
        .await;
    }

    /// ⑥ 重复投递 / 任务失败：transfer_id 原样交给执行器（不许错配），失败后该 cid 可再次入队。
    #[tokio::test]
    async fn keeps_transfer_id_paired_and_allows_retry_after_failure() {
        let fs = FileService::new(4);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        fs.start_worker("dev-a", move |j: FileServeJob| {
            let s2 = s2.clone();
            async move { s2.lock().unwrap_or_else(|e| e.into_inner()).push((j.cid, j.transfer_id)) }
        })
        .expect("worker");
        assert_eq!(fs.submit(job("c1", "dev-a", "tid-1")), ServeTicket::Accepted);
        assert_eq!(fs.submit(job("c1", "dev-a", "tid-1")), ServeTicket::Merged, "同 cid 同 tid 的重复帧要合并");
        assert_eq!(fs.submit(job("c2", "dev-a", "tid-2")), ServeTicket::Accepted);
        wait_until(
            { let s3 = seen.clone(); move || s3.lock().unwrap_or_else(|e| e.into_inner()).len() == 2 },
            2_000,
            "两条都要被执行",
        )
        .await;
        assert_eq!(
            *seen.lock().unwrap_or_else(|e| e.into_inner()),
            vec![("c1".to_string(), "tid-1".to_string()), ("c2".to_string(), "tid-2".to_string())],
            "cid 与 transfer_id 必须成对传递 —— 配错就是应答错到别的单上"
        );
        wait_until(
            { let fs = fs.clone(); move || fs.queued_len("dev-a") == 0 },
            2_000,
            "两条跑完后队列要清空（cid 不许被永久拉黑）",
        )
        .await;
        assert_eq!(fs.submit(job("c1", "dev-a", "tid-9")), ServeTicket::Accepted);
    }
}
