// 职责边界：
// - 消息生命周期的**纯判定**（不碰 Connection、不写表、不读表）
//
// 为什么单独成册：同一条判据在写入口（真正改状态、删队列行）与读出口（给界面的
// `PendingMessageOp::can_cancel`）各写一遍，就是本仓反复付学费的漂移形状 ——
// 2026-10-25 用户实报「明明还在排队，点取消却说已送达」，根因正是两处各守一套。
// 特征测试 `cascade_tests::direct_cancel_button_matches_the_backend_outcome_for_every_status`
// 把 8 个状态下两处的答案钉在一起；本册只搬判据，不改任何行为。

/// 1:1 取消的三种结论：查无此行 / 已是硬终态 / 允许取消。
///
/// `delivered` / `read` / `recalled` 是硬终态（取消不成立，界面要说实话）。
/// `cancelled` / `partial_cancelled` 仍在可取消面内 —— 重复点取消是幂等（界面上它就是
/// 「已取消」）；`failed` 也在，因为失败由清扫器收口，用户仍可点取消把它定住。
#[derive(Debug, PartialEq, Eq)]
enum DirectCancelVerdict {
    NotFound,
    AlreadyDelivered,
    Allowed,
}

fn direct_cancel_verdict(status: Option<&str>) -> DirectCancelVerdict {
    match status {
        None => DirectCancelVerdict::NotFound,
        Some("delivered" | "read" | "recalled") => DirectCancelVerdict::AlreadyDelivered,
        Some(_) => DirectCancelVerdict::Allowed,
    }
}

// ---------------- 迟到写被拒的门族 ----------------
//
// 四扇门（`set_message_status` / `ack_delivered` / 已读回执 / 重发）各自要排掉一组状态。
// 集合写在这一个文件里，SQL 片段由 `sql_not_in` / `sql_in` 生成 —— 生成出来的语句与
// 原先手写的逐字等价（SQLite 只认语义，不认换行缩进）。特征测试
// `cascade_tests::late_write_door_family_pins_every_status` 逐状态钉住每扇门的结论，
// 改这里的顺序或成员都会在那里红。

/// `set_message_status` 的守卫：硬终态 + 不可被迟到写撤销的软终态。
const LATE_WRITE_BLOCKED: [&str; 6] = [
    "read",
    "delivered",
    "recalled",
    "cancelled",
    "partial_cancelled",
    "failed",
];

/// `cancel_queued_message` 的状态守卫：重复取消是幂等，所以 `cancelled` 不在里面；
/// `failed` 也不在（用户仍可把一条失败的消息定住）。顺序与原手写一致。
const CANCEL_BLOCKED: [&str; 4] = ["delivered", "read", "recalled", "cancelled"];

/// `ack_delivered` 的守卫：Ack 只在硬终态面前让位。
const ACK_BLOCKED: [&str; 3] = ["read", "delivered", "recalled"];

/// 已读回执的守卫：额外排掉本端已收口的行 —— 一条没发出去的消息不可能被对方读过。
const READ_RECEIPT_BLOCKED: [&str; 5] = [
    "read",
    "failed",
    "recalled",
    "cancelled",
    "partial_cancelled",
];

/// 「整条重发」放行的状态集合：只有本端判失败 / 被用户取消的行能原身份重投。
const RESEND_ALLOWED: [&str; 2] = ["failed", "cancelled"];

fn sql_not_in(column: &str, statuses: &[&str]) -> String {
    format!("{column} NOT IN ({})", quote_statuses(statuses))
}

fn sql_in(column: &str, statuses: &[&str]) -> String {
    format!("{column} IN ({})", quote_statuses(statuses))
}

fn quote_statuses(statuses: &[&str]) -> String {
    statuses
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 这条消息能不能整条重发。命令层的「能重发吗」与 `requeue_message_for_resend`
/// 的写前判定共用同一份（2026-11-04 起）。
pub(crate) fn message_can_resend(status: &str) -> bool {
    RESEND_ALLOWED.contains(&status)
}

// ---------------- 群消息的取消（每成员台账） ----------------

/// 群台账里与「还能不能取消」有关的四类行数。
///
/// 群消息的取消判据不是 `messages.status` —— 任一成员 Ack 都会把它推成 `delivered`，
/// 而其余成员的 pending 行还在（2026-10-25 实报的死按钮）。判据是**台账行**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GroupCancelCounts {
    pending: i64,
    delivered: i64,
    cancelled: i64,
    failed: i64,
}

/// 群取消的结论：`Cancel` 之外的几格都是「现在不该真的动数据」。
#[derive(Debug, PartialEq, Eq)]
enum GroupCancelVerdict {
    /// 查无此消息，且台账也没有可解释的行。
    NotFound,
    /// `read` / `recalled`：已读或已撤回，取消不成立。
    Rejected,
    AlreadyCancelled,
    AlreadyDelivered { remaining: i64 },
    AlreadyFailed,
    /// 还有 pending 行 ⇒ 取消剩余成员；`next_status` 由「已收下的成员」决定。
    Cancel { next_status: &'static str },
}

fn group_cancel_verdict(status: &str, counts: GroupCancelCounts) -> GroupCancelVerdict {
    if matches!(status, "read" | "recalled") {
        return GroupCancelVerdict::Rejected;
    }
    if counts.pending > 0 {
        return GroupCancelVerdict::Cancel {
            next_status: if counts.delivered > 0 {
                "partial_cancelled"
            } else {
                "cancelled"
            },
        };
    }
    // 全部送达后墓碑会被即时清理 ⇒ 台账可能是空的，此时只能靠消息状态兜底，
    // 否则一条「已送达」的消息会答成 not_found，界面只能猜。
    if counts.cancelled > 0 || matches!(status, "cancelled" | "partial_cancelled") {
        return GroupCancelVerdict::AlreadyCancelled;
    }
    if counts.delivered > 0 || matches!(status, "delivered" | "read") {
        return GroupCancelVerdict::AlreadyDelivered {
            remaining: counts.failed,
        };
    }
    if counts.failed > 0 || status == "failed" {
        return GroupCancelVerdict::AlreadyFailed;
    }
    GroupCancelVerdict::NotFound
}

/// 读出口只需要「这一刻按下取消会不会真的发生」。
///
/// `delivered` / `cancelled` / `failed` 三格在 `pending > 0` 时**不影响结论类型**
/// （只影响 `next_status` 的标签），所以任务中心那侧传 0 是安全的：它由
/// `HAVING waiting > 0` 保证只看得到 pending 行还在的消息。
fn group_cancel_is_offered(status: Option<&str>, pending: i64) -> bool {
    status.is_some_and(|s| {
        matches!(
            group_cancel_verdict(
                s,
                GroupCancelCounts {
                    pending,
                    delivered: 0,
                    cancelled: 0,
                    failed: 0,
                }
            ),
            GroupCancelVerdict::Cancel { .. }
        )
    })
}
