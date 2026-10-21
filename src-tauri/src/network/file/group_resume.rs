// 群文件**真续传**的纯判据（决策 1 / P1-03）。
//
// 为什么单独一册：这些判据要能在没有 AppState、没有网络的情况下逐条钉住；
// 真正的 I/O（保留前缀重建接收器）在 `group_receive.rs`，网络与状态机在
// `transport/group_file.rs`。三处共用同一份结论，避免"接收端说能续、发送端说从头"。

/// 前缀 `.part` 的可续传年龄上限（与单聊 `resume_receive` 的 24h 对齐）。
/// 超过它的前缀由现有的 24h `.part` 清扫管辖，本判据只负责"不要拿一份快被清掉的前缀续传"。
pub(crate) const GROUP_RESUME_PART_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

/// 收到（带轮次的）重复 Offer 时的三种结局。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GroupOfferDecision {
    /// 本机已收完 ⇒ 只补 ACK，不重传。
    AlreadyHave,
    /// 磁盘/内存里有可用的前缀 ⇒ 回 `GroupFileResume(received)`，保留前缀续传。
    Resume(u64),
    /// 没有可用前缀，或前缀不可信 ⇒ 回 0，整份重来（必须留原因由调用方记录）。
    Restart,
}

/// 决定一个重复 Offer 该怎么答。**接收端是权威**：
/// 可用前缀取"内存已收"与"磁盘实际长度"的**较小者**（磁盘是最终事实；
/// 内存计数可能因写入失败/截断而偏大，偏大会让发送端以为对端有它没有的东西）。
///
/// `disk_retained >= size` 时按 0 处理：那可能是上次 `rename` 失败留下的整份 `.part`，
/// 成品文件并不存在（与单聊 `decide_offer` 的同一条判据）。
pub(crate) fn decide_group_offer(
    already_completed: bool,
    has_active: bool,
    active_received: u64,
    disk_retained: u64,
    size: u64,
) -> GroupOfferDecision {
    if already_completed {
        return GroupOfferDecision::AlreadyHave;
    }
    if size == 0 || disk_retained >= size {
        return GroupOfferDecision::Restart;
    }
    let held = if has_active {
        active_received.min(disk_retained)
    } else {
        disk_retained
    };
    if held > 0 {
        GroupOfferDecision::Resume(held)
    } else {
        GroupOfferDecision::Restart
    }
}

/// 磁盘前缀是否属于**这一份**文件（长度与 SHA 必须与 Offer 声明一致）。
/// 不一致 ⇒ 不能续传：那可能是同一 transfer_id 的旧文件/半截垃圾。
pub(crate) fn prefix_usable(
    offer_size: u64,
    offer_sha: &str,
    stored_size: u64,
    stored_sha: &str,
) -> bool {
    offer_size == stored_size && offer_sha.eq_ignore_ascii_case(stored_sha)
}

/// 发送端拿到接收端给的偏移后该怎么开始（纯判据）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GroupSendStart {
    /// 对端已有整份：不重传。
    AlreadyHave,
    /// 从该字节偏移续发（段内 seq 仍从 0 重编）。
    From(u64),
}

pub(crate) fn send_start_from(received: u64, size: u64) -> Result<GroupSendStart, &'static str> {
    if received > size {
        return Err("续传偏移超过文件大小");
    }
    if size > 0 && received == size {
        return Ok(GroupSendStart::AlreadyHave);
    }
    Ok(GroupSendStart::From(received))
}

/// 续传握手的基础等待（接收端要先把磁盘前缀整份哈希，才回 `GroupFileResume`）。
pub(crate) const GROUP_RESUME_HANDSHAKE_BASE_MS: u64 = 15_000;
/// 哈希吞吐的**保守**下界（32 MiB/s）：慢盘/大前缀按这个折算附加等待。
pub(crate) const GROUP_RESUME_HASH_BYTES_PER_SEC: u64 = 32 * 1024 * 1024;
/// 握手等待上限（10 分钟）：再大也不无限等，按可重试处理。
pub(crate) const GROUP_RESUME_HANDSHAKE_MAX_MS: u64 = 10 * 60 * 1000;

/// 发送端等 `GroupFileResume` 的时长：基础 15s + 前缀哈希的保守估算（有上限）。
///
/// 为什么不能固定 15s：接收端回执前要把 `.part` **整份**流式哈希一遍（为了播种 hasher）；
/// 几 GB 的前缀在慢盘上远超 15s ⇒ 发送端白等一轮、白占一个并发许可，还让接收端
/// 的 `spawn_blocking` 重建任务继续跑，下一轮再撞一次。
pub(crate) fn group_resume_wait_ms(size: u64) -> u64 {
    let hash_ms = size.saturating_mul(1000) / GROUP_RESUME_HASH_BYTES_PER_SEC;
    (GROUP_RESUME_HANDSHAKE_BASE_MS + hash_ms).min(GROUP_RESUME_HANDSHAKE_MAX_MS)
}

/// 这一帧属于当前轮次吗（S4 轮次隔离）。
/// `None`（旧端/本字段上线前的帧）⇒ 恒真；`Some` 必须等于当前轮次；查不到当前轮次也恒真。
pub(crate) fn group_frame_round_is_current(attempt: Option<u64>, current: Option<u64>) -> bool {
    match (attempt, current) {
        (None, _) => true,
        (Some(a), Some(c)) => a == c,
        (Some(_), None) => true,
    }
}

#[cfg(test)]
mod group_resume_tests {
    use super::*;

    /// 已收完优先于一切：不再看前缀，只补 ACK。
    #[test]
    fn already_have_wins_over_any_prefix() {
        assert_eq!(
            decide_group_offer(true, true, 50, 50, 100),
            GroupOfferDecision::AlreadyHave
        );
        assert_eq!(
            decide_group_offer(true, false, 0, 0, 0),
            GroupOfferDecision::AlreadyHave
        );
    }

    /// 活跃接收器与磁盘都有时，取较小者（磁盘是最终事实）。
    #[test]
    fn resume_uses_the_smaller_of_memory_and_disk() {
        assert_eq!(
            decide_group_offer(false, true, 80, 60, 100),
            GroupOfferDecision::Resume(60),
            "内存报 80、磁盘只有 60 ⇒ 以磁盘为准"
        );
        assert_eq!(
            decide_group_offer(false, false, 0, 40, 100),
            GroupOfferDecision::Resume(40),
            "没有活跃接收器 ⇒ 磁盘前缀就是权威"
        );
    }

    /// 空文件、无前缀、磁盘已有整份（rename 失败的残留）都不算可续传。
    #[test]
    fn no_usable_prefix_restarts() {
        assert_eq!(
            decide_group_offer(false, false, 0, 0, 100),
            GroupOfferDecision::Restart
        );
        assert_eq!(
            decide_group_offer(false, false, 0, 0, 0),
            GroupOfferDecision::Restart
        );
        assert_eq!(
            decide_group_offer(false, true, 100, 100, 100),
            GroupOfferDecision::Restart,
            "磁盘 ≥ 声明总长：可能是 rename 失败留下的整份 .part，成品不存在"
        );
    }

    /// 前缀身份必须与 Offer 一致（长度 + SHA，大小写不敏感）。
    #[test]
    fn prefix_identity_is_checked() {
        assert!(prefix_usable(100, "abcDEF", 100, "abcdef"));
        assert!(!prefix_usable(100, "abc", 99, "abc"));
        assert!(!prefix_usable(100, "abc", 100, "abd"));
    }

    /// 发送端只按接收端给的权威偏移开始；整份已在对端则不重传。
    #[test]
    fn sender_starts_from_the_authoritative_offset() {
        assert_eq!(send_start_from(0, 100), Ok(GroupSendStart::From(0)));
        assert_eq!(send_start_from(40, 100), Ok(GroupSendStart::From(40)));
        assert_eq!(send_start_from(100, 100), Ok(GroupSendStart::AlreadyHave));
        assert!(send_start_from(101, 100).is_err(), "超过文件大小必须拒绝");
        assert_eq!(
            send_start_from(0, 0),
            Ok(GroupSendStart::From(0)),
            "空文件仍走 Done"
        );
    }

    /// 轮次过滤：旧端 None 恒真；同轮次接受；不同轮次丢弃。
    #[test]
    fn frame_round_filter() {
        assert!(
            group_frame_round_is_current(None, Some(3)),
            "旧端帧保持旧行为"
        );
        assert!(group_frame_round_is_current(Some(3), Some(3)));
        assert!(
            !group_frame_round_is_current(Some(2), Some(3)),
            "上一轮的残留片必须丢"
        );
        assert!(
            !group_frame_round_is_current(Some(4), Some(3)),
            "未来轮次也丢，等它自己的 Offer"
        );
        assert!(
            group_frame_round_is_current(Some(3), None),
            "没有 Offer 的旧帧不该被丢"
        );
    }

    /// 握手等待按"接收端要哈希的前缀大小"放大，且有上限。
    #[test]
    fn resume_wait_scales_with_the_prefix_it_must_hash() {
        assert_eq!(group_resume_wait_ms(0), GROUP_RESUME_HANDSHAKE_BASE_MS);
        assert_eq!(
            group_resume_wait_ms(32 * 1024 * 1024),
            GROUP_RESUME_HANDSHAKE_BASE_MS + 1_000,
            "32 MiB 前缀按 32 MiB/s 折 1s"
        );
        assert_eq!(
            group_resume_wait_ms(1024 * 1024 * 1024),
            GROUP_RESUME_HANDSHAKE_BASE_MS + 32_000,
            "1 GiB 前缀折 32s（固定 15s 会白等一轮）"
        );
        assert_eq!(
            group_resume_wait_ms(100 * 1024 * 1024 * 1024),
            GROUP_RESUME_HANDSHAKE_MAX_MS,
            "再大也封顶，按可重试处理"
        );
        assert!(
            group_resume_wait_ms(10 * 1024 * 1024 * 1024) > GROUP_RESUME_HANDSHAKE_BASE_MS,
            "大文件必须比固定值等得更久"
        );
    }
}
