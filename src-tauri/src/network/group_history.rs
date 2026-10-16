//! 群历史同步引擎（负责人 2026-10-16 需求：新进群的人自动拿到群里的聊天与群任务）。
//!
//! 一句话形状：**新成员**向群里每个"在线、有直连、且升级到本特性"的成员各问一次摘要
//! （`limit = 0` 那一型请求），按各家的读数选出**最早最全**的那一台，然后按 `(seq, id)`
//! 游标一页一页把聊天与群任务搬回来，逐页幂等落库。全程后台跑，
//! 界面上只有一条"正在同步群消息 N/M"的提示。
//!
//! 为什么是"问一圈摘要"而不是"直接找群主"：需求写的是"群里面成员中群信息最早最全的那个人"，
//! 而**没有人知道别人家里有什么**。群主常常就是那台，但群主换过设备、群主长期离线、
//! 或者某个成员清过聊天记录，都会让"按角色猜"给出错的答案。摘要把这件事变成实测；
//! 代价是每个候选多收一帧空页（只有 `total` 与两个 `seq`，不含任何正文）。
//!
//! 为什么不做成 DB 迁移或"启动就补"：这一趟能不能跑取决于**谁在线**，而在线状态每次都不同；
//! 迁移跑在启动路径上还会把网络等待钉在界面前面（INV-P34 那一族已经数到十二家的根因）。
//! 形态因此是"入群那一刻记一个待同步标记 + 后台作业随时机跑"，
//! 与 `network/file/ledger_backfill.rs` 同一条纪律：**没跑完就不写完成标记**。
//!
//! ⚠️ 三条不许放宽的边界，就是这一册的判据本体：
//!   ① 服务端只把历史交给**本群成员**，且本机必须持有该群密钥（密封用的就是它）；
//!   ② 只对声明了 `CONTENT_FEATURE_GROUP_HISTORY` 的对端发请求（INV-P24「不门控不许发」）；
//!   ③ 落库一律走 `db::apply_group_history_page`，本机"清空过这个群"的水位照常生效
//!      —— 否则这条需求会变成"用户清掉的记录自己长了回来"。
//!
//! 已知边界（如实登记）：只从**有直连链路**的成员取。跨跳借道搬运整段历史没做 ——
//! 一页 1.5MB 的帧经第三方转一跳要吃双份链路预算，而局域网场景里"群里总有直连成员"
//! 几乎总成立。找不到直连候选时这一趟判"暂时没源"，标记保持 `pending`，
//! 清扫任务每 60 秒再来看一次（见 `spawn_group_history_sweeper`）。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use rand_core::RngCore;
use tauri::Emitter;
use tokio::sync::oneshot;

use crate::crypto;
use crate::db;
use crate::protocol::{
    GroupHistoryPage, GroupHistoryReplyBody, Message, CONTENT_FEATURE_GROUP_HISTORY,
    GROUP_HISTORY_PAGE_ITEMS,
};
use crate::state::AppState;

/// 一轮摘要最多问几个候选。再多也不会让选源更准，只会同时占住几条链路的队列。
pub const GROUP_HISTORY_MAX_PROBE: usize = 8;
/// 摘要问话的应答上限（毫秒）。局域网 RTT 是毫秒级，这个数只用来兜"对端没升级"。
pub const GROUP_HISTORY_PROBE_TIMEOUT_MS: u64 = 4_000;
/// 取一页的应答上限（毫秒）。服务端要在阻塞线程池里查库并密封最多 1.5MB，比摘要慢一档。
pub const GROUP_HISTORY_PAGE_TIMEOUT_MS: u64 = 20_000;
/// 两页之间让出的时间（毫秒）。
///
/// 为什么要有这一格而不是收完立刻下一页：用户在等的**只有**聊天与文件（INV-P20），
/// 而这一趟是后台补账。120ms 不是量出来的节流数字，是"每页之间一定留出一次完整的
/// 调度窗口"这件事的最小成本写法。
pub const GROUP_HISTORY_INTER_PAGE_MS: u64 = 120;
/// 一趟最多取多少页（硬上限，防病态循环：`has_more` 恒真而游标前进得极慢）。
/// 200 条/页 × 1000 页 = 20 万条，比任何真实群历史都多；碰到它判"没跑完"。
pub const GROUP_HISTORY_MAX_PAGES: usize = 1_000;
/// 一趟允许试几台源（每台都可能在半路下线）。
pub const GROUP_HISTORY_MAX_SOURCES: usize = 4;
/// 前端监听的那个进度事件名（**唯一**真相；`src/api/index.ts` 的 `listen` 用的是同一个串）。
pub const GROUP_HISTORY_EVENT: &str = "group-history-progress";

/// 一群这一趟的结局。四种都要能在日志里区分开，因为运维要问的是"为什么没同步上"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncOutcome {
    /// 一个候选都没问到（都不在线 / 都没升级 / 都没直连）⇒ 保持 pending，下轮再来
    NoSource,
    /// 本机没有这个群（退群或删群赶上了）⇒ 顺手把标记清掉
    NoGroup,
    /// 跑到底了：服务端说这一页之后没有下一页
    Completed {
        source: String,
        synced: i64,
        total: i64,
    },
    /// 中途换不到源 / 页解不开 / 落库报错 ⇒ **不写完成标记**
    Incomplete { synced: i64, reason: String },
}

/// 摘要问出来的一个候选（只有读数，没有正文）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryCandidate {
    pub peer_id: String,
    pub oldest_seq: i64,
    pub newest_seq: i64,
    pub total: i64,
}

/**
 * 选源 —— 需求那句"群里面成员中群信息最早最全的那个人"的**唯一**实现。
 *
 * 三档按顺序比，不是加权分（一个可解释的次序比一个调出来的分数好复查）：
 *   1. **最早** —— `oldest_seq` 最小。量的是逻辑序号而不是墙上时钟：`seq` 才是这个仓的
 *      排序权威（INV-P09），跨设备的 `ts` 不可比（快钟慢钟都会骗人）。
 *   2. **最全** —— 同一起点时 `total` 最大（都从同一条最早的消息开始，谁后面接得更多）。
 *   3. **确定性** —— 前两个数都相同时按 `peer_id` 字典序取小。这一档不是凑数：
 *      没有它，同一台机器两次跑会选到不同的源（候选来自不稳定顺序），
 *      于是"到底是这台给的历史"在日志里无法复现。
 *
 * `total <= 0` 的候选**直接排除**：那一台没有这一群的历史。选它只会白跑一趟，
 * 而那趟的结局与"这个群本来就没人说过话"在线上是同一个形状 —— 那才是真危险的地方：
 * 它会写下一个"同步完成"的标记，把一次没发生的事变成永久状态（INV-P26 的反面）。
 * 全部被排除时返回 `None` ⇒ 调用方判 `NoSource`。
 */
pub fn pick_history_source(candidates: &[HistoryCandidate]) -> Option<usize> {
    let mut best: Option<(usize, &HistoryCandidate)> = None;
    for (i, c) in candidates.iter().enumerate() {
        if c.total <= 0 {
            continue;
        }
        let take = match best {
            None => true,
            Some((_, cur)) => {
                c.oldest_seq < cur.oldest_seq
                    || (c.oldest_seq == cur.oldest_seq && c.total > cur.total)
                    || (c.oldest_seq == cur.oldest_seq
                        && c.total == cur.total
                        && c.peer_id < cur.peer_id)
            }
        };
        if take {
            best = Some((i, c));
        }
    }
    best.map(|(i, _)| i)
}

/// 服务端授权判定（把四条事实喂进来，判定本体可单测；臂里只负责取事实）。
///
/// 为什么**不复用** `transport/handle_share.rs::content_serve_allowed`：
/// 那一判的第一支是 `if is_friend { return true }` —— 按 cid 取文件时"好友就是授权"
/// 是 ADR-0019 的既定语义；而群历史属于**群**，一个不在群里的好友照那一判就会被放行。
/// 两件事的授权语义不同，判据就必须是两个（同类先例：1:1 与群的 kind 容忍度不是一件事）。
pub fn serve_allowed(
    from_is_link_peer: bool,
    to_is_me: bool,
    from_is_group_member: bool,
    has_group_key: bool,
) -> bool {
    from_is_link_peer && to_is_me && from_is_group_member && has_group_key
}

/**
 * 这一页能不能往本机库里写。**必须在落库之前判**，理由不是"数据不好看"：
 * `apply_group_history_page` 是**握着全仓唯一那把 db 锁**逐行插的（消息 + 台账 + 时钟），
 * 而对端可以爱给多少行给多少行 —— 不加这道闸，就等于让对端决定本机界面卡多久，
 * 正面撞上本需求那句"别让用户感觉到卡顿"与 INV-P34 那一族的根因。
 *
 * 上限取的是**本机自己请求的那个数**（`GROUP_HISTORY_PAGE_ITEMS`，一个家）：
 * 诚实的对端不可能超，超了就是它没守约定或这帧被伪造过 ⇒ 判"这台不能用"、换源，
 * 而不是硬着头皮把它的东西全收下来。
 */
pub fn page_is_within_budget(items_len: usize, files_len: usize) -> bool {
    let cap = GROUP_HISTORY_PAGE_ITEMS as usize;
    items_len <= cap && files_len <= cap
}

/// 解开一页（AEAD 自带完整性；解不开就是不该落的页，一格都不许写）。
pub fn decode_sealed_page(key: &[u8; 32], sealed: &str) -> Option<GroupHistoryPage> {
    let bytes = STANDARD.decode(sealed).ok()?;
    let plain = crypto::open_symmetric(key, &bytes)?;
    serde_json::from_slice(&plain).ok()
}

/// 服务端侧：把一页封成线上那串 base64。
pub fn seal_page(key: &[u8; 32], page: &GroupHistoryPage) -> Option<String> {
    let json = serde_json::to_vec(page).ok()?;
    let sealed = crypto::seal_symmetric(key, &json)?;
    Some(STANDARD.encode(sealed))
}

/// 这一群现在该不该跑一趟。
///
/// 只认**明确写过的 `pending`**：没有这行状态 = 本机从没被要求同步过（升级前就在群里的
/// 老成员），一律不动。这一条划的就是"这轮只服务新进群的人"与"升级后满屏开始拉历史"
/// 之间那条线 —— 后者会在所有人升级完之前把局域网塞满补账流量。
pub fn should_sync_group(status: Option<&str>) -> bool {
    status == Some(db::GROUP_HISTORY_STATUS_PENDING)
}

fn new_request_id() -> String {
    let mut b = [0u8; 12];
    rand_core::OsRng.fill_bytes(&mut b);
    STANDARD.encode(b)
}

/// 问一次（摘要或取页）。`None` = 没答、答不上来、或发不出去。
///
/// 登记在**发帧之前**，撤表在**每一条出口**（发送失败 / 超时 / 通道被关 / 拿到应答）：
/// 顺序反了，一个快对端会在等待者还没登记时把应答丢进空表 ⇒ 这一趟白等一个整超时。
async fn ask(
    state: &Arc<AppState>,
    peer: &str,
    group_id: &str,
    after_seq: i64,
    after_id: i64,
    limit: u32,
    timeout_ms: u64,
) -> Option<GroupHistoryReplyBody> {
    let request_id = new_request_id();
    let (tx, rx) = oneshot::channel();
    state
        .pending_group_history
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.clone(), (group_id.to_string(), tx));
    let req = Message::GroupHistoryRequest {
        request_id: request_id.clone(),
        from: state.device_id.clone(),
        to: peer.to_string(),
        group_id: group_id.to_string(),
        after_seq,
        after_id,
        limit,
    };
    if crate::network::transport::try_send(state, peer, &req)
        .await
        .is_err()
    {
        state
            .pending_group_history
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&request_id);
        return None;
    }
    let got = tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await;
    let out = match got {
        Ok(Ok(body)) => Some(body),
        // 两条失败出口都要留痕，且**留的是不同的事**："这台没答"与"这台的应答通道自己关了"
        // 在现场是两种毛病（前者是网络或对端读循环，后者是本机一侧提前撤了等待者）。
        Ok(Err(_)) => {
            state.logger.warn(
                "group",
                format!("群历史应答通道被关 peer={peer} group={group_id}"),
            );
            None
        }
        Err(_) => {
            state.logger.warn(
                "group",
                format!(
                    "群历史应答超时 peer={peer} group={group_id}（等 {timeout_ms}ms，limit={limit}）"
                ),
            );
            None
        }
    };
    state
        .pending_group_history
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id);
    out
}

/// 扇出去问摘要：每候选一个任务，问完再收（最坏 = 一个超时，不是 N 个之和）。
async fn probe_candidates(
    state: &Arc<AppState>,
    peers: &[String],
    group_id: &str,
) -> Vec<HistoryCandidate> {
    let mut handles = Vec::new();
    for peer in peers {
        let st = state.clone();
        let peer = peer.clone();
        let gid = group_id.to_string();
        handles.push(tokio::spawn(async move {
            let body = ask(&st, &peer, &gid, -1, -1, 0, GROUP_HISTORY_PROBE_TIMEOUT_MS).await?;
            if !body.ok {
                st.logger.info(
                    "group",
                    format!(
                        "群历史候选拒绝 peer={} group={gid}：{}",
                        peer,
                        if body.reason.is_empty() {
                            "未给原因"
                        } else {
                            body.reason.as_str()
                        }
                    ),
                );
                return None;
            }
            Some(HistoryCandidate {
                peer_id: peer,
                oldest_seq: body.oldest_seq,
                newest_seq: body.newest_seq,
                total: body.total,
            })
        }));
    }
    let mut out = Vec::new();
    for h in handles {
        match h.await {
            Ok(Some(c)) => out.push(c),
            Ok(None) => {}
            Err(e) => state.logger.warn(
                "group",
                format!("群历史候选任务被中断：{e}（其余候选不受影响）"),
            ),
        }
    }
    out
}

/// 在线、有直连、且声明了本特性位的那几个群成员（稳定顺序 + 封顶）。
async fn eligible_peers(state: &Arc<AppState>, members: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for m in members {
        if m == &state.device_id {
            continue;
        }
        if !state.has_link(m).await {
            continue;
        }
        // 「不知道就当不支持」的方向（与 `kind_allowed_by_features` 同一口径）：
        // 从没交换过 Hello、或老端没带这个字段 ⇒ 位是 0 ⇒ 一个字节都不发。
        let feats = state
            .peer_content_features
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(m)
            .copied()
            .unwrap_or(0);
        if feats & CONTENT_FEATURE_GROUP_HISTORY == 0 {
            continue;
        }
        out.push(m.clone());
    }
    out.sort();
    out.truncate(GROUP_HISTORY_MAX_PROBE);
    out
}

/// 进度提示的唯一出口。**必须在 db 锁之外调用**（INV-P25：持锁 emit 会让监听器
/// 立刻回手要一次 IPC，两边抢同一把锁 ⇒ 现场就是"界面整个冻一下"）。
fn emit_progress(
    state: &Arc<AppState>,
    group_id: &str,
    source: &str,
    synced: i64,
    total: i64,
    phase: &str,
    reason: Option<&str>,
) {
    let _ = state.app.emit(
        GROUP_HISTORY_EVENT,
        &serde_json::json!({
            "group_id": group_id,
            "source": source,
            "synced": synced,
            "total": total,
            "phase": phase,
            "reason": reason,
        }),
    );
}

/// 一趟页面试探的结局。分开写是因为这三件事**后续动作不同**：
/// 换源（这台不行）、中止（本机自己出问题，换源也没意义）、继续（这一页落了库）。
enum PageAttempt {
    /// 这一页**已落库**。带回来的这几个数就是下一页的游标 ——
    /// 只有落成的那一页才允许推动游标，否则"落库失败"会变成"那几条永远不再要"。
    Applied {
        inserted: usize,
        has_more: bool,
        next_seq: i64,
        next_id: i64,
        total: i64,
    },
    SourceUnusable(&'static str),
    NoKey,
    DbFailure(String),
}

/// 跑一趟这一群的群历史同步。
pub async fn run_group_history_sync(state: &Arc<AppState>, group_id: &str) -> SyncOutcome {
    let (group_name, members) = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        match db::get_group(&dbc, group_id) {
            Some(g) => (g.name, g.members),
            None => {
                // 标记还在、群已经没了（退群/删群赶上了）⇒ 把标记**删掉**而不是写成 done：
                // "done" 是一个事实声明（这台拿到过历史），对不存在的群它两样都不是。
                db::delete_setting(&dbc, &db::group_history_state_key(group_id)).ok();
                return SyncOutcome::NoGroup;
            }
        }
    };

    let candidates = eligible_peers(state, &members).await;
    if candidates.is_empty() {
        state.logger.info(
            "group",
            format!(
                "群历史同步没有可用候选 group={group_id}（成员 {} 人：都没直连、或还没升级到认得这一帧）",
                members.len()
            ),
        );
        return SyncOutcome::NoSource;
    }

    let mut summaries = probe_candidates(state, &candidates, group_id).await;
    let Some(i) = pick_history_source(&summaries) else {
        state.logger.info(
            "group",
            format!(
                "群历史同步问到的候选都没有历史 group={group_id}（问了 {} 台，全是空群）",
                summaries.len()
            ),
        );
        return SyncOutcome::NoSource;
    };
    let mut source = summaries.remove(i).peer_id;
    let mut exhausted: HashSet<String> = HashSet::new();
    let mut after_seq = -1i64;
    let mut after_id = -1i64;
    let mut synced = 0i64;
    let mut total_declared = 0i64;
    let mut pages = 0usize;

    loop {
        pages += 1;
        if pages > GROUP_HISTORY_MAX_PAGES {
            let reason = format!("取页达到硬上限 {GROUP_HISTORY_MAX_PAGES} 仍未到底");
            state.logger.error(
                "group",
                format!("群历史同步中止 group={group_id}：{reason}"),
            );
            emit_progress(
                state,
                group_id,
                &source,
                synced,
                total_declared,
                "failed",
                Some("too many pages"),
            );
            return SyncOutcome::Incomplete { synced, reason };
        }

        let attempt =
            try_one_page(state, group_id, &group_name, &source, after_seq, after_id).await;

        match attempt {
            PageAttempt::Applied {
                inserted,
                has_more,
                next_seq,
                next_id,
                total,
            } => {
                synced += inserted as i64;
                total_declared = total.max(total_declared);
                emit_progress(
                    state,
                    group_id,
                    &source,
                    synced,
                    total_declared,
                    "running",
                    None,
                );
                if !has_more {
                    break;
                }
                // 游标只在"这一页落成了"之后才前进 —— 见 `PageAttempt::Applied` 的注释。
                after_seq = next_seq;
                after_id = next_id;
                // 让出一次：链路里排在后面的聊天与分片先走（INV-P20）。
                tokio::time::sleep(Duration::from_millis(GROUP_HISTORY_INTER_PAGE_MS)).await;
            }
            PageAttempt::DbFailure(reason) => {
                // 本机自己的问题 ⇒ 不换源也没意义：这一趟判没收口，游标不前进，
                // 下一趟从同一页重来（落库按 msg_id 去重，重复那一页不会写重行）。
                emit_progress(
                    state,
                    group_id,
                    &source,
                    synced,
                    total_declared,
                    "failed",
                    Some("local failure"),
                );
                return SyncOutcome::Incomplete { synced, reason };
            }
            PageAttempt::NoKey => {
                // 没有群密钥就一格也解不开。这里**不许**放过成"这页是空的"：
                // 那会把"还没拿到密钥"这一格写成一个看起来像成功的完成标记。
                emit_progress(
                    state,
                    group_id,
                    &source,
                    synced,
                    total_declared,
                    "failed",
                    Some("no group key"),
                );
                return SyncOutcome::Incomplete {
                    synced,
                    reason: "本机没有该群密钥".to_string(),
                };
            }
            PageAttempt::SourceUnusable(why) => {
                exhausted.insert(source.clone());
                if exhausted.len() >= GROUP_HISTORY_MAX_SOURCES || summaries.is_empty() {
                    state.logger.warn(
                        "group",
                        format!(
                            "群历史没有更多可用源 group={group_id}（已试 {} 台，最后因为 {why}）",
                            exhausted.len()
                        ),
                    );
                    emit_progress(
                        state,
                        group_id,
                        &source,
                        synced,
                        total_declared,
                        "failed",
                        Some(why),
                    );
                    return SyncOutcome::Incomplete {
                        synced,
                        reason: format!("源用完（{why}）"),
                    };
                }
                // 补问一轮剩下的候选（新上线的那台可能正好是最早最全的）
                let all = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::get_group(&dbc, group_id)
                        .map(|g| g.members)
                        .unwrap_or_default()
                };
                let probed =
                    probe_candidates(state, &eligible_peers(state, &all).await, group_id).await;
                for c in probed {
                    if !exhausted.contains(&c.peer_id)
                        && !summaries.iter().any(|s| s.peer_id == c.peer_id)
                    {
                        summaries.push(c);
                    }
                }
                match pick_history_source(&summaries) {
                    Some(j) => {
                        source = summaries.remove(j).peer_id;
                        // 跨源游标：`after_id` 是**上一台**库里的行号，拿到新源去比会把
                        // "同 seq、id 更大"的那些整批跳过（漏历史，而且没有任何痕迹）。
                        // 重置成 `id > -1` ⇒ 同一 seq 的那批重来一遍，重复由 msg_id 去重吃掉。
                        // 也就是换源的代价只会是"多做一点重复功"，绝不是"少几条"。
                        after_id = -1;
                        state.logger.info(
                            "group",
                            format!("群历史改用新源 group={group_id} source={source}（seq={after_seq}）"),
                        );
                        emit_progress(
                            state,
                            group_id,
                            &source,
                            synced,
                            total_declared,
                            "running",
                            None,
                        );
                        continue;
                    }
                    None => {
                        emit_progress(
                            state,
                            group_id,
                            &source,
                            synced,
                            total_declared,
                            "failed",
                            Some(why),
                        );
                        return SyncOutcome::Incomplete {
                            synced,
                            reason: "没有更多可用候选".to_string(),
                        };
                    }
                }
            }
        }
    }

    let marked = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::write_group_history_state(
            &dbc,
            group_id,
            db::GROUP_HISTORY_STATUS_DONE,
            &source,
            synced,
            total_declared,
        )
    };
    if let Err(e) = marked {
        // 收口了但标记写不上 ⇒ 下次还会再跑一趟（落库幂等，不会写重行）。
        // 这不是故障，但必须看得见 —— 否则"我到底同步过没有"只剩界面读数能猜（INV-P26）。
        state.logger.error(
            "group",
            format!("群历史同步完成但标记写失败 group={group_id}：{e} —— 下次会再跑一趟（幂等）"),
        );
    }
    emit_progress(
        state,
        group_id,
        &source,
        synced,
        total_declared,
        "done",
        None,
    );
    state.logger.info(
        "group",
        format!(
            "群历史同步收口 group={group_id} source={source}：新入库 {synced} 条、源机报总数 {total_declared} 条、取页 {pages} 次"
        ),
    );
    SyncOutcome::Completed {
        source,
        synced,
        total: total_declared,
    }
}

/// 取一页并落库。**只在成功落库后**才把游标写进 `LAST_PAGE`（见那里的说明）。
async fn try_one_page(
    state: &Arc<AppState>,
    group_id: &str,
    group_name: &str,
    source: &str,
    after_seq: i64,
    after_id: i64,
) -> PageAttempt {
    let Some(body) = ask(
        state,
        source,
        group_id,
        after_seq,
        after_id,
        GROUP_HISTORY_PAGE_ITEMS,
        GROUP_HISTORY_PAGE_TIMEOUT_MS,
    )
    .await
    else {
        return PageAttempt::SourceUnusable("这台没答");
    };
    if !body.ok {
        return PageAttempt::SourceUnusable(if body.reason.is_empty() {
            "这台拒绝"
        } else {
            "这台给不了"
        });
    }
    let Some(key) = crate::network::transport::get_group_key(state, group_id).await else {
        return PageAttempt::NoKey;
    };
    let Some(page) = decode_sealed_page(&key, &body.sealed) else {
        state.logger.warn(
            "group",
            format!("群历史一页解不开 group={group_id} source={source}（一格都不写）"),
        );
        return PageAttempt::SourceUnusable("应答对不上群密钥");
    };
    if !page_is_within_budget(page.items.len(), page.files.len()) {
        // 超预算的一页**整页不收**（不是收下其中一部分）：游标因此不前进，换源后从同一处重来。
        // 宁可多做重复功，也不把"对端决定本机界面卡多久"这件事让出去 ——
        // 落库那一段是握着全仓唯一那把 db 锁逐行插的（INV-P34 / 本需求那句"别让用户感觉到卡顿"）。
        state.logger.warn(
            "group",
            format!(
                "丢弃超预算的群历史一页 group={group_id} source={source}：条目 {} 行、台账 {} 行（本机每页只请求 {GROUP_HISTORY_PAGE_ITEMS} 行）",
                page.items.len(),
                page.files.len()
            ),
        );
        return PageAttempt::SourceUnusable("那一页超出本机请求的预算");
    }
    let todo_floor = body.todo_high_water;
    let total_seen = body.total;
    let (has_more, next_seq, next_id) = (body.has_more, body.next_seq, body.next_id);

    // 落库进阻塞线程池：一页最多 200 行，含去重判定与时钟推进，
    // 而它握的是全仓唯一那把 db 锁 —— 消息收发与所有读库命令都在同一把锁上排队。
    let applied = {
        let st = state.clone();
        let gid = group_id.to_string();
        let name = group_name.to_string();
        let me = state.device_id.clone();
        tokio::task::spawn_blocking(move || {
            let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
            let stats = db::apply_group_history_page(&dbc, &gid, &me, &name, &page)?;
            db::raise_todo_number_floor(&dbc, &gid, todo_floor)?;
            Ok::<_, rusqlite::Error>(stats)
        })
        .await
    };
    let stats = match applied {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            state.logger.error(
                "group",
                format!("群历史一页落库失败 group={group_id} source={source}：{e} —— 完成标记不写"),
            );
            return PageAttempt::DbFailure(format!("落库失败：{e}"));
        }
        Err(e) => {
            state.logger.error(
                "group",
                format!("群历史落库任务被中断 group={group_id}：{e} —— 完成标记不写"),
            );
            return PageAttempt::DbFailure(format!("任务被中断：{e}"));
        }
    };
    if stats.files_skipped > 0 {
        // 留痕但不升级为失败：补不了的是**台账行**（发件人已退群，本机认不上那一行的身份），
        // 卡片消息行照样落了，文件仍可按 cid 从任何持有者那里拉。
        // 数出来这一格的价值在于：现场问"为什么这个文件在这台点不开"时，日志里有答案。
        state.logger.warn(
            "group",
            format!(
                "群历史台账有 {} 行认不上身份、未补 group={group_id} source={source}（卡片照常落，文件仍可按 cid 拉）",
                stats.files_skipped
            ),
        );
    }
    PageAttempt::Applied {
        inserted: stats.inserted,
        has_more,
        next_seq,
        next_id,
        total: total_seen,
    }
}

/// 起跑一趟后台同步的**唯一**出口：在飞则不再排第二个，跑完释放那一格。
///
/// 为什么要有这一格而不是"谁想起来就 spawn"：入群钩子、群消息顺手建群那一路、清扫任务
/// 三处都会喊一声。没有在飞闸，同一个群会同时排两三趟，每趟都在用同一批帧要同一份历史
/// —— 链路与 db 锁的开销翻倍，而落库结果一字不差。
pub fn spawn_sync(state: &Arc<AppState>, group_id: &str) -> bool {
    if !state
        .group_history_active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(group_id.to_string())
    {
        return false;
    }
    let st = state.clone();
    let gid = group_id.to_string();
    tokio::spawn(async move {
        let outcome = run_group_history_sync(&st, &gid).await;
        st.group_history_active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&gid);
        st.logger.info(
            "group",
            format!("群历史同步这一趟结束 group={gid}：{outcome:?}"),
        );
    });
    true
}

/// 后台清扫：定期看哪几个群还挂着"待同步"，为它们喊一声 `spawn_sync`。
///
/// 为什么这一半必须有：入群那一刻**常常没有人在线**（群主下班了、那台机器没开）。
/// 只靠入群钩子跑一次，"自动同步"就变成"看运气"；这一格把它变成"有人在线就补上"。
/// 形态与 `commands::spawn_cache_auto_clean` 一致：`to_infinity` 的周期任务，
/// 随进程退出自然结束，不进 `NetworkHandle::tasks`（否则重开网络会把它一起 kill 掉）。
pub fn spawn_group_history_sweeper(state: &Arc<AppState>) {
    let st = state.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let found = {
                let inner = st.clone();
                tokio::task::spawn_blocking(move || {
                    let dbc = inner.db.lock().unwrap_or_else(|e| e.into_inner());
                    let mut out: Vec<String> = Vec::new();
                    if let Ok(groups) = db::list_groups(&dbc) {
                        for g in groups {
                            let stt = db::read_group_history_state(&dbc, &g.id);
                            if !should_sync_group(stt.as_ref().map(|s| s.status.as_str())) {
                                continue;
                            }
                            let in_flight = inner
                                .group_history_active
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .contains(&g.id);
                            if !in_flight {
                                out.push(g.id);
                            }
                        }
                    }
                    out
                })
                .await
            };
            match found {
                Ok(list) => {
                    for gid in list {
                        spawn_sync(&st, &gid);
                    }
                }
                Err(e) => st.logger.error(
                    "group",
                    format!("群历史清扫任务被中断：{e} —— 下一轮再扫（待同步标记不会被消耗）"),
                ),
            }
        }
    });
}

/// 记下"这一群欠一份历史"的**唯一**出口。
///
/// 为什么单独成函数而不是在两处各写一遍：这一枚标记同时是清扫任务的判据（`should_sync_group`
/// 只认显式 `pending`），多一个写它的家就意味着"谁把它写成 pending"这件事要按两处对账
/// （INV-P23 批评的正是这种形状）。
fn mark_history_pending(state: &Arc<AppState>, group_id: &str) {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db::write_group_history_state(&dbc, group_id, db::GROUP_HISTORY_STATUS_PENDING, "", 0, 0).ok();
}

/// 新成员入群时调用：记下"这一群欠一份历史"，并立刻试一趟。
///
/// 为什么标记与起跑是两个动作而不是一个函数里顺手做完：标记要落在**入群那同一段锁**里
/// （与群密钥、群记录同一个原子窗口），而起跑要等 db 锁放掉之后（`spawn_sync` 会排队读库）。
/// 顺序错了的表现是：标记写了、进程在那之前崩了 ⇒ 界面上永远停在"没历史"，
/// 而这一格靠清扫任务还能救回来 —— 所以真正的要求只有一条：**标记必须先于任何起跑**。
pub fn note_new_membership(state: &Arc<AppState>, group_id: &str) {
    mark_history_pending(state, group_id);
    spawn_sync(state, group_id);
}

/// 手动那一格的四种结局（负责人 2026-10-16 追加：老成员也要能自己点一下补历史）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManualVerdict {
    /// 已排上：接下来照常规那趟跑（进度走 `group-history-progress`）。
    Started,
    /// 这一群已经在搬了 ⇒ 不重复排、也不改标记（改了会让在飞那趟收口时的读数对不上）。
    AlreadyRunning,
    /// 本机没有这个群 ⇒ 不写标记：对一个不存在的群声明"欠历史"是假事实。
    NoGroup,
    /// 现在没有任何可问的候选（都没在线 / 都还没升级到认得这一帧）。
    /// 标记**照写** —— 这正是清扫任务存在的理由：有人在线了就自动补上。
    NoSource,
}

impl ManualVerdict {
    /// 线上/界面上用的那个短码（前端只按它选文案，不解析句子）。
    pub fn as_str(self) -> &'static str {
        match self {
            ManualVerdict::Started => "started",
            ManualVerdict::AlreadyRunning => "already_running",
            ManualVerdict::NoGroup => "no_group",
            ManualVerdict::NoSource => "no_source",
        }
    }
}

/// 手动同步的裁决表：只吃三个读数，没有任何 IO —— 所以它能被逐行判。
///
/// 顺序是有意义的：`NoGroup` 排在最前，因为"点了一个本机根本没有的群"这件事不该被
/// "有人在飞"盖过去（后者只是等一会儿，前者是界面上那一行已经不该存在了）。
pub fn decide_manual_sync(
    has_group: bool,
    in_flight: bool,
    eligible_sources: usize,
) -> ManualVerdict {
    if !has_group {
        return ManualVerdict::NoGroup;
    }
    if in_flight {
        return ManualVerdict::AlreadyRunning;
    }
    if eligible_sources == 0 {
        return ManualVerdict::NoSource;
    }
    ManualVerdict::Started
}

/// 界面上那颗小按钮的后端：让**任何**群成员（不只新进的那位）主动跑一趟常规同步。
///
/// 它不新增第二种搬运形状，只是"再跑一趟常规那趟"，而这恰好就是需求要的结果：
/// 常规那趟的游标起点本来就是 `after_seq = -1`（全量重扫），落库按 `msg_id` 幂等
/// ⇒ 自己已经最全的人点 ⇒ 每一行都被判成"已有"、补进 0 条；中间缺的那几条会被补上。
/// 两处闸也照原样生效：用户清掉的历史不会被这一趟复活（`group_message_blocked_by_boundary`），
/// 撤回墓碑照旧。**没有**"我最全就别问了"这种本地捷径 —— 别人手里有没有本机缺的那几条，
/// 只有问过一次才知道（与自动那一格同一个理由）。
///
/// 与自动那一格的唯一区别：这里**不受 `should_sync_group` 那道"只认 pending"的闸管**
/// （那道闸划的是"升级后不许满屏开始拉"这条线，手动点一下是用户自己给的许可）。
pub async fn request_manual_sync(state: &Arc<AppState>, group_id: &str) -> ManualVerdict {
    let members = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, group_id).map(|g| g.members)
    };
    let Some(members) = members else {
        return ManualVerdict::NoGroup;
    };
    let in_flight = state
        .group_history_active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(group_id);
    // 在飞时不再花一次候选探测的功夫（那一趟自己正在问同样的事）。
    let sources = if in_flight {
        1
    } else {
        eligible_peers(state, &members).await.len()
    };
    let verdict = decide_manual_sync(true, in_flight, sources);
    if verdict == ManualVerdict::Started || verdict == ManualVerdict::NoSource {
        // NoSource 也要写标记：这一趟没人可问，不等于"这一群不缺历史"（清扫任务会再来问）。
        mark_history_pending(state, group_id);
    }
    if verdict == ManualVerdict::Started {
        spawn_sync(state, group_id);
    }
    state.logger.info(
        "group",
        format!("群历史手动同步请求 group={group_id}：{}", verdict.as_str()),
    );
    verdict
}

/// 应答臂：把 `group_history_reply` 交给正在等它的那个请求方。
///
/// 三道校验都要有，缺一道就是给别人一个往本机库里写东西的口子：
///   ① `from == peer_id`：帧里自报的发送者必须就是这条链路的对端（验签只证明密钥属于谁，
///      不证明这台有权替别人应答）；
///   ② `to == 本机`：不是发给我的应答不当吃；
///   ③ 应答里的 `group_id` 必须等于**本机当初问的那个群** —— 这一格最容易被省掉，
///      省掉之后一台对端就能拿 A 群的历史让本机写进 B 群的会话。
/// 表里没有这个 `request_id` ⇒ 丢弃（我们这边已经超时撤了等待者），并留一行说明：
/// 这是"对端答得比本机等的还晚"与"应答被人伪造"在日志里唯一的分界。
pub fn handle_reply(
    state: &Arc<AppState>,
    peer_id: &str,
    request_id: String,
    from: String,
    to: String,
    reply: GroupHistoryReplyBody,
) {
    if from != peer_id || to != state.device_id {
        state.logger.warn(
            "group",
            format!(
                "丢弃对不上号的群历史应答 peer={peer_id} 自报 from={from} to={to}（链路对端才是事实）"
            ),
        );
        return;
    }
    let tx = {
        let mut map = state
            .pending_group_history
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match map.get(&request_id) {
            Some((want_group, _)) if want_group == &reply.group_id => {
                map.remove(&request_id).map(|(_, tx)| tx)
            }
            Some((want_group, _)) => {
                state.logger.warn(
                    "group",
                    format!(
                        "丢弃群不匹配的群历史应答 peer={peer_id}：本机问的是 {want_group}，答的是 {}",
                        reply.group_id
                    ),
                );
                None
            }
            None => {
                state.logger.info(
                    "group",
                    format!("群历史应答没人等（本机已超时撤走等待者）peer={peer_id}"),
                );
                None
            }
        }
    };
    if let Some(tx) = tx {
        // 发送失败只可能是接收任务已经被取消 —— 那一侧自己会走超时分支，这里不必再判一次。
        let _ = tx.send(reply);
    }
}

/// 请求臂：替这个群交出最多一页历史（`limit = 0` 时只交摘要）。
///
/// 三条形状要求，都是这一册的判据：
///   ① 授权判定走 `serve_allowed`（四格全真才给）；
///   ② **查库与密封分两步**：取数在阻塞线程池里持 db 锁，而 JSON 序列化 + AEAD + base64
///      那一半**在锁外**做。GB 级不在这里（一页封顶 1.5MB），但"慢活握着全仓唯一那把锁"
///      这个形状本身就是 INV-P34 那一族已经数到十二家的根因；
///   ③ 拒绝也要**明确回答**（`ok = false` + 原因），不许静默不回：请求方要能分清
///      "这台不给"与"这台没答"，前者换源、后者重试 —— 静默会把一个权限判断变成一次超时。
#[allow(clippy::too_many_arguments)] // 与 `transport::handle_group_key` 同一形状：帧字段逐个传进来，不另造一个只为绕 lint 的中间结构
pub async fn handle_request(
    state: &Arc<AppState>,
    peer_id: &str,
    request_id: String,
    from: String,
    to: String,
    group_id: String,
    after_seq: i64,
    after_id: i64,
    limit: u32,
) {
    let key = crate::network::transport::get_group_key(state, &group_id).await;
    let is_member = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, &group_id)
            .map(|g| g.members.contains(&from))
            .unwrap_or(false)
    };
    if !serve_allowed(
        from == peer_id,
        to == state.device_id,
        is_member,
        key.is_some(),
    ) {
        state.logger.warn(
            "group",
            format!(
                "拒绝群历史请求 group={group_id} from={from}：链路对端相符={} 收件人是本机={} 请求方是本群成员={} 本机持有群密钥={}",
                from == peer_id,
                to == state.device_id,
                is_member,
                key.is_some()
            ),
        );
        let body = GroupHistoryReplyBody {
            group_id,
            ok: false,
            reason: "not authorized".to_string(),
            ..Default::default()
        };
        let reply = Message::GroupHistoryReply {
            request_id,
            from: state.device_id.clone(),
            to: from,
            reply: body,
        };
        let _ = crate::network::transport::try_send(state, peer_id, &reply).await;
        return;
    }

    // 取数（在池里，握着 db 锁）
    let scanned = {
        let st = state.clone();
        let gid = group_id.clone();
        tokio::task::spawn_blocking(move || {
            let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
            let summary = db::group_history_summary(&dbc, &gid)?;
            let served = db::serve_group_history_page(&dbc, &gid, after_seq, after_id, limit)?;
            let todo_floor = db::todo_number_high_water(&dbc, &gid);
            Ok::<_, rusqlite::Error>((summary, served, todo_floor))
        })
        .await
    };
    let (summary, served, todo_floor) = match scanned {
        Ok(Ok(v)) => v,
        // 取不动也要回答：`ok = false` + 原因。不回就是把一次 SQLITE_BUSY 变成对端的超时。
        Ok(Err(e)) => {
            state.logger.error(
                "group",
                format!("群历史取数失败 group={group_id} peer={peer_id}：{e}"),
            );
            let reply = Message::GroupHistoryReply {
                request_id,
                from: state.device_id.clone(),
                to: from,
                reply: GroupHistoryReplyBody {
                    group_id,
                    ok: false,
                    reason: "local read failed".to_string(),
                    ..Default::default()
                },
            };
            let _ = crate::network::transport::try_send(state, peer_id, &reply).await;
            return;
        }
        Err(e) => {
            state.logger.error(
                "group",
                format!("群历史取数任务被中断 group={group_id}：{e}"),
            );
            return;
        }
    };

    // 密封（锁外）。解不开就没有任何一行能落库，所以这一步失败也只回 `ok = false`。
    let Some(sealed) = key.as_ref().and_then(|k| seal_page(k, &served.page)) else {
        state.logger.error(
            "group",
            format!("群历史一页密封失败 group={group_id} peer={peer_id}（密钥不可用）"),
        );
        return;
    };
    let n = served.page.items.len();
    let reply = Message::GroupHistoryReply {
        request_id,
        from: state.device_id.clone(),
        to: from.clone(),
        reply: GroupHistoryReplyBody {
            group_id: group_id.clone(),
            ok: true,
            reason: String::new(),
            oldest_seq: summary.oldest_seq,
            newest_seq: summary.newest_seq,
            total: summary.total,
            next_seq: served.next_seq,
            next_id: served.next_id,
            has_more: served.has_more,
            todo_high_water: todo_floor,
            sealed,
        },
    };
    if let Err(e) = crate::network::transport::try_send(state, peer_id, &reply).await {
        state.logger.warn(
            "group",
            format!("群历史应答发不出去 group={group_id} peer={peer_id}：{e}（请求方会超时换源）"),
        );
        return;
    }
    state.logger.info(
        "group",
        format!(
            "群历史交出一页 group={group_id} to={from}：{} 条、本机共 {} 条、还有下一页={}{}",
            n,
            summary.total,
            served.has_more,
            if served.files_dropped > 0 {
                format!("、台账另有不带 {} 行（超出每页封顶）", served.files_dropped)
            } else {
                String::new()
            },
        ),
    );
}

#[cfg(test)]
mod group_history_engine_tests {
    use super::*;

    fn cand(peer: &str, oldest: i64, total: i64) -> HistoryCandidate {
        HistoryCandidate {
            peer_id: peer.to_string(),
            oldest_seq: oldest,
            newest_seq: oldest + total,
            total,
        }
    }

    /// 「最早」优先于「最全」：起点更早的那一台赢，哪怕它条数少。
    /// 需求那句是"最早**最**全"，读起来像一个乘积；这里钉死它是两个档位、最早在前。
    #[test]
    fn earliest_beats_a_peer_with_more_messages() {
        let cands = vec![cand("rich", 50, 900), cand("early", 3, 40)];
        let i = pick_history_source(&cands).unwrap();
        assert_eq!(
            cands[i].peer_id, "early",
            "起点更早的那台才是「最早最全」的那个人"
        );
    }

    /// 同一起点才比条数（这一条把上一行挡不住的那个方向反过来钉住：
    /// 只按 oldest 排、把 total 当摆设，这条就红）。
    #[test]
    fn same_start_prefers_the_more_complete_peer() {
        let cands = vec![cand("thin", 3, 40), cand("full", 3, 900)];
        let i = pick_history_source(&cands).unwrap();
        assert_eq!(cands[i].peer_id, "full");
    }

    /// 两个数都相同时必须给同一个答案（可复现性；日志里"是谁给的这份历史"要能信）。
    #[test]
    fn a_full_tie_is_broken_deterministically_by_id() {
        let a = vec![cand("b", 7, 5), cand("a", 7, 5)];
        let b = vec![cand("a", 7, 5), cand("b", 7, 5)];
        assert_eq!(a[pick_history_source(&a).unwrap()].peer_id, "a");
        assert_eq!(
            b[pick_history_source(&b).unwrap()].peer_id,
            "a",
            "顺序不许影响结果"
        );
    }

    /// 空群不算候选 —— 否则那台会写下一个"同步完成"的标记，
    /// 把一件没发生的事变成永久状态（INV-P26 反面）。
    #[test]
    fn peers_without_any_history_are_not_eligible() {
        assert_eq!(pick_history_source(&[cand("empty", 0, 0)]), None);
        let cands = vec![cand("empty", 1, 0), cand("has", 9, 2)];
        assert_eq!(cands[pick_history_source(&cands).unwrap()].peer_id, "has");
    }

    #[test]
    fn empty_candidate_list_has_no_source() {
        assert_eq!(pick_history_source(&[]), None);
    }

    /// 授权四格：缺一格都不许给。四格各自单独反证，否则"少查一格"是看不出来的。
    #[test]
    fn serving_requires_all_four_facts() {
        assert!(serve_allowed(true, true, true, true));
        // 帧里的 from 与这条链路的对端不符 ⇒ 冒充（INV-P21 之后仍然要判）
        assert!(!serve_allowed(false, true, true, true));
        // 不是发给本机的请求（借道/串号）
        assert!(!serve_allowed(true, false, true, true));
        // 不在群里的好友 —— 这一格正是 `content_serve_allowed` 会放行、而这里必须拒的那一格
        assert!(!serve_allowed(true, true, false, true));
        // 本机还没有群密钥 ⇒ 连密封都做不了，也不该假装"给了空的"
        assert!(!serve_allowed(true, true, true, false));
    }

    /// 密封与解开是一个闭环；用错的密钥必须**解不开**而不是解出半个对象。
    #[test]
    fn a_page_sealed_with_one_key_never_opens_with_another() {
        let key = [7u8; 32];
        let other = [8u8; 32];
        let page = GroupHistoryPage {
            items: vec![crate::protocol::GroupHistoryItem {
                msg_id: "m1".into(),
                sender_id: "a".into(),
                kind: "text".into(),
                content: "只给群里的人看".into(),
                ts: 1,
                seq: 1,
                mention_targets: None,
            }],
            files: vec![],
        };
        let sealed = seal_page(&key, &page).unwrap();
        let back = decode_sealed_page(&key, &sealed).unwrap();
        assert_eq!(back.items.len(), 1);
        assert_eq!(back.items[0].content, "只给群里的人看");
        assert!(
            decode_sealed_page(&other, &sealed).is_none(),
            "换一把密钥就不许解开"
        );
        assert!(decode_sealed_page(&key, "不是 base64!!").is_none());
    }

    /// 只有明确写过的 `pending` 才跑（老群不许被这轮扫到）。
    #[test]
    fn only_an_explicit_pending_marker_starts_a_run() {
        assert!(should_sync_group(Some(db::GROUP_HISTORY_STATUS_PENDING)));
        assert!(!should_sync_group(Some(db::GROUP_HISTORY_STATUS_DONE)));
        assert!(
            !should_sync_group(None),
            "升级前就在群里的老成员不许被动开始拉历史"
        );
        assert!(!should_sync_group(Some("")));
    }

    /// 手动那一格的裁决表。
    ///
    /// 这条判的是"点下去之后到底发生了什么"那四种结局**互斥且都可达**：
    /// 少一格就是界面上一句没有对应读数的话。顺序也判（NoGroup 必须压过在飞）。
    #[test]
    fn the_manual_button_is_a_decision_table_not_a_second_shape() {
        use ManualVerdict::*;
        assert_eq!(
            decide_manual_sync(true, false, 3),
            Started,
            "有群、没在飞、有候选 ⇒ 排一趟"
        );
        assert_eq!(
            decide_manual_sync(true, false, 0),
            NoSource,
            "一个候选都问不到 ⇒ 明说，别假装开始了"
        );
        assert_eq!(
            decide_manual_sync(true, true, 0),
            AlreadyRunning,
            "在飞优先于候选数（那一趟自己正在问同一批人）"
        );
        assert_eq!(
            decide_manual_sync(false, true, 5),
            NoGroup,
            "本机没有这个群时必须压过一切：对不存在的群不许声明任何同步事实"
        );
        // 短码是前端选文案的唯一依据 ⇒ 钉住串本身（改名要连 i18n 一起改）。
        assert_eq!(
            [Started, AlreadyRunning, NoSource, NoGroup]
                .iter()
                .map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(","),
            "started,already_running,no_source,no_group"
        );
    }

    /// 「自己最全的人点一下 ⇒ 只补缺的、其余一字不变」这条需求的**接线**判据。
    ///
    /// 行为本身由 `group_history_db_tests` 里那两条重放用例判（同一份页两次落库、
    /// 中间缺一条再补上）；这里判的是它接没接上：
    /// ① 标记只有**一个**写它的家（两处各写 = 谁把标记写成 pending 要按两处对账）；
    /// ② 手动那一路唯一的起跑出口还是 `spawn_sync`（不许另起第二个 `tokio::spawn`）；
    /// ③ 命令注册了一次，且 `request_manual_sync` 除命令外没有第二个调用者。
    #[test]
    fn the_manual_entry_shares_one_marker_home_and_one_spawn_gate() {
        let body = engine_body();
        assert_eq!(
            body.matches("db::GROUP_HISTORY_STATUS_PENDING,").count(),
            1,
            "本册生产码里写 pending 现数到 {} 处（登记 1 处 = `mark_history_pending` 那一个家）",
            body.matches("db::GROUP_HISTORY_STATUS_PENDING,").count()
        );
        assert_eq!(
            body.matches("mark_history_pending(state,group_id)").count(),
            2,
            "两个入口（入群钩子 / 手动按钮）都走那一个家，现数到 {} 处（登记 2 处）",
            body.matches("mark_history_pending(state,group_id)").count()
        );
        assert_eq!(
            body.matches("spawn_sync(state,group_id)").count(),
            2,
            "起跑出口还是 `spawn_sync` 两处调用（入群 + 手动），现数到 {} 处",
            body.matches("spawn_sync(state,group_id)").count()
        );

        let cmd = code_flat(include_str!("../commands/groups.rs"));
        assert_eq!(
            cmd.matches("request_manual_sync(state.inner(),&group_id)")
                .count(),
            1,
            "`request_manual_sync` 全仓只该有命令那一个调用者，现数到 {} 处",
            cmd.matches("request_manual_sync(state.inner(),&group_id)")
                .count()
        );
        let lib = code_flat(include_str!("../lib.rs"));
        assert_eq!(
            lib.matches("commands::sync_group_history_now,").count(),
            1,
            "命令注册现数到 {} 处（登记 1 处 = `generate_handler!` 那一行）；0 = 界面上的按钮点了没人接",
            lib.matches("commands::sync_group_history_now,").count()
        );
    }

    /// 落库前的那一页预算闸：两个维度各自封顶，且**必须真的被调用一次**。
    ///
    /// 为什么这条要连"调用点数量"一起钉：这一格的价值全在"落库之前"，
    /// 有人把闸挪到落库之后（或干脆删掉留个函数）时，纯函数用例照样绿、
    /// 而对端又能重新决定本机界面卡多久 —— 那是本仓最常见的"判据还在、作用点没了"空转形状。
    #[test]
    fn an_oversized_page_is_rejected_before_it_reaches_the_db_lock() {
        let cap = GROUP_HISTORY_PAGE_ITEMS as usize;
        assert!(
            page_is_within_budget(cap, cap),
            "恰好等于本机请求的条数要收"
        );
        assert!(page_is_within_budget(0, 0));
        assert!(
            !page_is_within_budget(cap + 1, 0),
            "条目超一页请求数 = 对端没守约定"
        );
        assert!(!page_is_within_budget(0, cap + 1), "台账超数同样不收");
        // 调用点：本册生产码里"定义 + 使用"恰好各一处（多了=第二个家，少了=闸没接上）
        assert_eq!(
            engine_body().matches("page_is_within_budget(").count(),
            2,
            "`page_is_within_budget(` 现数到 {} 处（登记 2 处 = 定义 1 + 落库前那一道闸 1）",
            engine_body().matches("page_is_within_budget(").count()
        );
    }

    /// 进度事件名在本仓只有**一个**串：常量、`src/api/index.ts` 的 listen 与
    /// `events.test.ts` 的双侧扫描都靠它对齐。这条断言防的是"有人手抄了一个字"。
    #[test]
    fn the_progress_event_name_is_one_string() {
        assert_eq!(GROUP_HISTORY_EVENT, "group-history-progress");
    }

    /// 去整行注释与行尾注释，再抹掉所有空白（与 `network/file/ledger_backfill_tests.rs`
    /// 那册同一套做法）。注释必须先去：这一册的注释里**复述了被断言的那句**，
    /// 不去注释的判据会因为文档而假绿（本仓第 48 条教训）。
    fn code_flat(raw: &str) -> String {
        let no_comments: String = raw
            .lines()
            .map(|l| {
                let t = l.trim_start();
                if t.starts_with("//") || t.starts_with("/*") || t.starts_with('*') {
                    String::new()
                } else {
                    match l.find("//") {
                        Some(i) => l[..i].to_string(),
                        None => l.to_string(),
                    }
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        no_comments.chars().filter(|c| !c.is_whitespace()).collect()
    }

    /// 本册去掉测试模块之后的**生产码**部分（测试字面量会把按次数计的判据喂成假绿）。
    fn engine_body() -> String {
        let flat = code_flat(include_str!("group_history.rs"));
        let cut = flat
            .find("#[cfg(test)]")
            .expect("本册末尾要有测试模块的锚点");
        flat[..cut].to_string()
    }

    /// **接线判据（清扫任务）**：这一趟的"自动"完全靠这一格 —— 入群那一刻常常没有人在线，
    /// 少了周期清扫，"自动同步"就退化成"看运气"。而**删掉 `lib.rs` 里那一行调用，
    /// 全部用例照样绿、功能从此不跑**（本仓把这一类叫静默失效）。
    /// 所以钉三件事：只接一次、不在本册里自己喊自己（那是第二个家）、不许手抄那个 settings 键。
    #[test]
    fn the_group_history_sweeper_is_wired_exactly_once_at_startup() {
        let lib = code_flat(include_str!("../lib.rs"));
        assert_eq!(
            lib.matches("spawn_group_history_sweeper(&state)").count(),
            1,
            "清扫任务在 lib.rs 里现数到 {} 个调用点（登记 1 处）：0 = 没人接（永远不扫），2 = 两把周期任务",
            lib.matches("spawn_group_history_sweeper(&state)").count()
        );
        // 本册里只许有**定义**那一处，不许有调用（否则一个进程里排两个循环）
        assert_eq!(
            engine_body()
                .matches("spawn_group_history_sweeper(")
                .count(),
            1,
            "引擎册里 `spawn_group_history_sweeper(` 现数到 {} 处（登记 1 处 = 函数定义本身）",
            engine_body()
                .matches("spawn_group_history_sweeper(")
                .count()
        );
        // 开关键名的唯一家在 `db::group_history_state_key`；任何一处手抄字面量，
        // 键名一改就会变成"读一个家、写另一个家"（静默失效的另一种）。
        let db_book = code_flat(include_str!("../db/group_history.rs"));
        assert_eq!(
            db_book.matches("\"ghsync:group:").count(),
            1,
            "settings 前缀字面量在 db 册里现数到 {} 处（登记 1 处 = `group_history_state_key` 的函数体）",
            db_book.matches("\"ghsync:group:").count()
        );
        assert!(
            !lib.contains("\"ghsync:group:"),
            "lib.rs 里手抄了那个 settings 键 ⇒ 键名一旦改，标记就静默失效"
        );
        assert!(
            !engine_body().contains("\"ghsync:group:"),
            "引擎里手抄了那个 settings 键 ⇒ 同上（读一个家、写另一个家）"
        );
    }

    /**
     * **接线判据（起跑那一格）**：`spawn_sync` 是唯一的起跑出口，而它必须
     * ① 由 `tokio::spawn` 驱动（不是就地 await —— 那会把网络往返钉进调用者的持锁段），
     * ② 有一把在飞闸（否则入群钩子 + 群消息建群 + 清扫三处各排一趟，同一段历史要三遍），
     * ③ 跑完释放那一格（漏了就永久卡住：这一群以后再也起不来）。
     *
     * 取函数体来数（而不是全文数）：`tokio::spawn` 在本册还有另一处用途
     * —— 扇出问摘要时每个候选一个任务，那是**故意**的并发，不是第二个起跑出口。
     */
    #[test]
    fn sync_starts_from_one_spawn_behind_an_in_flight_gate() {
        let body = engine_body();
        let start = body
            .find("pubfnspawn_sync(state:&Arc<AppState>,group_id:&str)->bool{")
            .expect("`spawn_sync` 的函数体锚点必须还在（改名/改签名要一起改这条判据）");
        // 取到下一个顶层项为止；本册在 `spawn_sync` 之后只剩两个 `pub fn`，
        // 所以取不到分隔符就用文末（**不许** panic —— 这条判据要判的是"接线"，不是"文件长得对不对"）。
        let end = body[start + 1..]
            .find("pubfn")
            .map(|i| i + 1)
            .unwrap_or(body.len() - start);
        let f = &body[start..start + end];
        assert_eq!(
            f.matches("tokio::spawn(").count(),
            1,
            "`spawn_sync` 体内现数到 {} 处 `tokio::spawn(`（登记 1 处）：0 = 根本没起跑",
            f.matches("tokio::spawn(").count()
        );
        assert!(
            f.contains("group_history_active.lock()"),
            "起跑必须过在飞闸：没有它，同一个群会被排两三趟、各要一遍同样的历史"
        );
        assert_eq!(
            f.matches(".remove(&gid)").count(),
            1,
            "跑完要释放那一格（现数到 {} 处）：0 = 这一群以后再也起不来",
            f.matches(".remove(&gid)").count()
        );
    }

    /// **收口纪律**：完成标记只能在整趟跑到底之后写，且任何"没跑完"的出口都不许写。
    /// 次序判据照抄补账那册的形状（跑作业 → 判收口 → 才写标记）：这里比的是
    /// "最后一个 `return SyncOutcome::Incomplete`" 必须在"写 DONE"**之前** ——
    /// 一旦有人把标记写到循环里面（每页都写一次），中途崩的那台就会被永久钉成"已同步"。
    #[test]
    fn the_done_marker_is_written_only_after_the_whole_run_completes() {
        let body = engine_body();
        let mark = body
            .find("db::GROUP_HISTORY_STATUS_DONE,")
            .expect("写完成标记那一句必须还在");
        let last_incomplete = body
            .rfind("returnSyncOutcome::Incomplete")
            .expect("至少要有一条『没跑完』的出口");
        assert!(
            last_incomplete < mark,
            "完成标记必须在所有『没跑完』出口之后再写：先写 ⇒ 中途断的那台以后再也不补"
        );
        assert_eq!(
            body.matches("db::GROUP_HISTORY_STATUS_DONE").count(),
            1,
            "本册生产码里 DONE 这个值现数到 {} 处（登记 1 处 = 收口那一次写）；多一处就是第二个家",
            body.matches("db::GROUP_HISTORY_STATUS_DONE").count()
        );
    }

    /// 请求方必须**先登记等待者、再发帧**：顺序反了，一个快对端的应答会落进空表，
    /// 这一趟就白等一个整超时（表现为"同步很慢"，而日志里只有超时那一条）。
    #[test]
    fn the_waiter_is_registered_before_the_request_is_sent() {
        let body = engine_body();
        let reg = body
            .find("pending_group_history.lock()")
            .expect("等待者登记那一句必须还在");
        let send = body
            .find("transport::try_send(state,peer,&req)")
            .expect("发请求那一句必须还在");
        assert!(
            reg < send,
            "先发帧后登记 = 应答比等待者早到，这一页一定超时"
        );
    }

    /// INV-P24「不门控不许发」：只对声明了本特性位的对端发请求，且本机要把这一位**广播出去**。
    /// 后一半最容易漏 —— 自己不声明，别人就永远问不到本机（这条需求只跑一半）。
    #[test]
    fn the_frame_is_gated_and_advertised() {
        let body = engine_body();
        assert_eq!(
            body.matches("feats&CONTENT_FEATURE_GROUP_HISTORY==0")
                .count(),
            1,
            "候选筛选里的能力位闸现数到 {} 处（登记 1 处）：0 = 会对老端发它不认的帧",
            body.matches("feats&CONTENT_FEATURE_GROUP_HISTORY==0")
                .count()
        );
        let proto = code_flat(include_str!("../protocol.rs"));
        assert!(
            proto.contains("pubfncontent_features()->u32{CONTENT_FEATURE_PULL|CONTENT_FEATURE_MERGE|CONTENT_FEATURE_FILE_EPOCH|CONTENT_FEATURE_FLEX_DM_KIND|CONTENT_FEATURE_GROUP_HISTORY}"),
            "本机没把群历史这一位声明出去 ⇒ 别人选源时永远问不到这台（能力位必须与门控同批改）"
        );
    }

    /// INV-P20（聊天不许被大块饿死）：一页正文是这条需求里最大的一块流量，
    /// 它必须落在调度表的 **Low** 那一档 —— 位置判据，不是"存在性"判据：
    /// 把它挪到 Normal 那一段，这条就红（写反时只判"有没有 GroupHistoryReply"是看不出来的）。
    #[test]
    fn a_history_page_is_classified_low_so_chat_is_never_starved() {
        let d = code_flat(include_str!("dispatch.rs"));
        let chunk = d
            .find("Message::FileChunk{..}")
            .expect("Low 那一档的锚点（FileChunk）");
        let reply = d
            .find("Message::GroupHistoryReply{..}")
            .expect("群历史应答要在这张分类表里");
        let low_end = d
            .find("=>MessagePriority::Low,")
            .expect("Low 那一档的终结臂");
        assert!(
            chunk < reply && reply < low_end,
            "应答必须在 FileChunk 之后、Low 终结之前"
        );
        // 请求帧本身很小，留在 Normal 才对（它要的是"尽快问到摘要"，不是搬数据）
        let normal = d
            .find("=>MessagePriority::Normal,")
            .expect("Normal 那一档的终结臂");
        let req = d
            .find("Message::GroupHistoryRequest{..}")
            .expect("群历史请求要在这张分类表里");
        assert!(
            req > low_end && req < normal,
            "请求帧必须落在 Normal 档（Low 之后、Normal 终结之前）"
        );
    }

    /// **两个入群入口都要喊一声**，且各自都被"第一次成为成员"那个条件挡着：
    /// 只接 `GroupKey` 那一路，"从未收到密钥、只收到过群消息"的成员就永远拿不到历史
    /// —— 而那恰恰是这一族里人数最多的一类（`gossip.rs` 里那段顺手建群）。
    /// 条件写在哪儿就用哪儿的锚点数：这两处各有 1 个守卫，缺任一个都会退化成
    /// "群主每次重发密钥，大家都重补一遍历史"。
    #[test]
    fn both_membership_entry_points_trigger_the_sync_behind_a_first_membership_guard() {
        let transport = code_flat(include_str!("transport.rs"));
        let gossip = code_flat(include_str!("transport/gossip.rs"));
        assert_eq!(
            transport
                .matches("note_new_membership(state,&group_id)")
                .count(),
            1,
            "GroupKey 那一路的起跑调用点现数到 {} 处",
            transport
                .matches("note_new_membership(state,&group_id)")
                .count()
        );
        assert!(
            transport.contains("ifknown_group.is_none(){"),
            "GroupKey 那一路必须由『本机还没有这个群』挡着：否则群主每次重发密钥都重补一遍"
        );
        assert_eq!(
            gossip.matches("note_new_membership(state,&gid)").count(),
            1,
            "群消息顺手建群那一路的起跑调用点现数到 {} 处",
            gossip.matches("note_new_membership(state,&gid)").count()
        );
        assert!(
            gossip.contains("iffirst_membership{"),
            "这一路同样要有守卫（`first_membership` = 本机第一次建这个群的记录）"
        );
        // 喊话必须在放掉 db 锁之后（INV-P25：持锁 emit / 持锁起一个会再取锁的活）
        assert!(
            gossip
                .find("drop(dbc)")
                .map(|i| i < gossip.find("iffirst_membership{").unwrap_or(usize::MAX))
                .unwrap_or(false),
            "gossip 那一路的喊话要在 `drop(dbc)` 之后：`note_new_membership` 自己还要取那把锁"
        );
    }

    /// 退群/删群要把这个群的**同步状态一起删掉**（与清除边界同批）。
    /// 漏掉这一格的表现很隐蔽：被踢的人重新入群后 `done` 还挂着 ⇒ 永远不再同步，
    /// 而他看到的就是一个空的群 —— 正是这条需求要解决的那个现场。
    #[test]
    fn leaving_a_group_drops_its_sync_marker_too() {
        let groups = code_flat(include_str!("../db/groups.rs"));
        assert_eq!(
            groups
                .matches("crate::db::group_history_state_key(group_id)")
                .count(),
            1,
            "delete_group 里现数到 {} 处按键删除（登记 1 处）：0 = 重新入群后再也不同步",
            groups
                .matches("crate::db::group_history_state_key(group_id)")
                .count()
        );
        assert!(
            !groups.contains("\"ghsync:group:"),
            "删除处手抄了那个键的字面量 ⇒ 必须改成认 `group_history_state_key` 这个名字"
        );
    }
}
