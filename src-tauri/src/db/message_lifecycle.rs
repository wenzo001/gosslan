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
