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
