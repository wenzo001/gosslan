//! 前台/失焦节奏的**防抖状态机**（纯逻辑，虚拟时钟可测）。
//!
//! ## 为什么要有它（2026-11-04 用户 Win11 日志）
//!
//! 用户日志里 12 秒内出现 6 次「回到前台/聚焦」+ 6 次「进入后台/失焦」，
//! 每一次翻转都会：切扫描节奏（落一行日志）+ `wake_scan`（立刻扫一轮）。
//! 于是窗口焦点/可见性事件一抖动，扫描循环就被"带着跑"，日志噪音与射频/耗电一起上去。
//!
//! 三条规则（不是调数字，是让抖动不再驱动节奏）：
//! 1. 状态必须**稳定 ≥ [`FOCUS_DEBOUNCE_MS`]** 才真正切节奏；中途再翻转只会重置待生效目标，
//!    不落盘、不切节奏。
//! 2. 同向重复事件幂等丢弃（已经排队的/已经生效的目标再收到一次 ⇒ 什么都不做）。
//! 3. 「唤醒扫描」有**最小间隔**（不小于当前节奏周期），避免 1 秒内连续强制扫描。

/// 状态稳定多久才真正生效。
pub const FOCUS_DEBOUNCE_MS: i64 = 2_000;

/// 一次前台/失焦信号的处理结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// 同向重复、或翻转又翻回了已生效态：什么都不做。
    Ignored,
    /// 有一个待生效目标被排队；调用方需要安排一次（防抖期后的）[`FocusRhythm::tick`]。
    Scheduled,
}

/// 一次真正生效的节奏切换。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Switch {
    pub active: bool,
    /// 是否需要落一行「节奏切换」日志（一次稳定切换只记一次）。
    pub log: bool,
    /// 是否顺带请求立刻扫描（受最小间隔约束）。
    pub wake: bool,
}

#[derive(Debug)]
pub struct FocusRhythm {
    /// 已生效的前台状态（扫描循环读的是 `AppState::app_active`，这里只是判据副本）。
    applied: bool,
    /// 待生效目标与生效时刻（毫秒）。
    pending: Option<(bool, i64)>,
    /// 上一次强制扫描的时刻（唤醒节流用）。
    last_wake_ms: Option<i64>,
}

impl FocusRhythm {
    pub fn new(active: bool) -> Self {
        Self {
            applied: active,
            pending: None,
            last_wake_ms: None,
        }
    }

    /// 收到一次前台/失焦信号。
    pub fn signal(&mut self, active: bool, now_ms: i64) -> Signal {
        if let Some((target, _)) = self.pending {
            if target == active {
                // 同一目标重复到达：不重置计时器，也不重复排队。
                return Signal::Ignored;
            }
            if active == self.applied {
                // 翻回已生效态 ⇒ 这段抖动没有产生任何状态，直接取消待生效目标。
                self.pending = None;
                return Signal::Ignored;
            }
            // 真的换向：重新开始计稳定期。
            self.pending = Some((active, now_ms + FOCUS_DEBOUNCE_MS));
            return Signal::Scheduled;
        }
        if active == self.applied {
            // 同向重复：已在 5s 又收到"回前台"就属于这一条。
            return Signal::Ignored;
        }
        self.pending = Some((active, now_ms + FOCUS_DEBOUNCE_MS));
        Signal::Scheduled
    }

    /// 防抖期到了再看一眼：目标是否仍然稳定。
    ///
    /// `active_interval_ms` 是前台节奏周期（唤醒最小间隔）。只有切到前台才可能唤醒，
    /// 所以这里只需要前台的那个值。
    pub fn tick(&mut self, now_ms: i64, active_interval_ms: i64) -> Option<Switch> {
        let (target, at_ms) = self.pending?;
        if now_ms < at_ms {
            return None;
        }
        self.pending = None;
        self.applied = target;
        let wake = if target {
            match self.last_wake_ms {
                Some(last) => now_ms.saturating_sub(last) >= active_interval_ms,
                None => true,
            }
        } else {
            false
        };
        if wake {
            self.last_wake_ms = Some(now_ms);
        }
        Some(Switch {
            active: target,
            log: true,
            wake,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4 秒内 4 次翻转 ⇒ 只切 1 次节奏、最多 1 次强制扫描。
    #[test]
    fn a_four_second_focus_flap_switches_once_and_wakes_at_most_once() {
        let mut r = FocusRhythm::new(false); // 开局在后台
        let mut switches = Vec::new();
        let mut wakes = 0;
        // t=0 前台 / t=1.2 后台 / t=2.4 前台 / t=3.6 前台（同向重复）
        assert_eq!(r.signal(true, 0), Signal::Scheduled);
        assert_eq!(r.tick(1_000, 5_000), None, "1s 时还没稳定，不许切");
        assert_eq!(
            r.signal(false, 1_200),
            Signal::Ignored,
            "翻回已生效态 ⇒ 取消待生效目标"
        );
        assert_eq!(r.tick(2_000, 5_000), None);
        assert_eq!(r.signal(true, 2_400), Signal::Scheduled);
        assert_eq!(r.tick(3_000, 5_000), None);
        assert_eq!(
            r.signal(true, 3_600),
            Signal::Ignored,
            "同向重复必须幂等丢弃"
        );
        // 最后一次翻转之后稳定 2s ⇒ 只生效这一次
        if let Some(sw) = r.tick(4_400, 5_000) {
            switches.push(sw);
            if sw.wake {
                wakes += 1;
            }
        }
        // 反复 tick 不许重复生效
        assert_eq!(r.tick(5_000, 5_000), None);
        assert_eq!(r.tick(6_000, 5_000), None);
        assert_eq!(switches.len(), 1, "4 次翻转只许切 1 次节奏");
        assert!(switches[0].active);
        assert_eq!(wakes, 1, "最多 1 次强制扫描");
    }

    /// 反例：真的稳定切到前台、再稳定切到后台 ⇒ 各切一次（不是一刀切拒绝）。
    #[test]
    fn stable_switches_still_cut_the_rhythm_each_time() {
        let mut r = FocusRhythm::new(true);
        let back = r.signal(false, 0);
        assert_eq!(back, Signal::Scheduled);
        let behind = r.tick(2_000, 5_000).expect("稳定 2s 后必须切到后台");
        assert!(!behind.active);
        assert!(!behind.wake, "切到后台不该强行扫描");

        assert_eq!(r.signal(true, 10_000), Signal::Scheduled);
        let front = r.tick(12_000, 5_000).expect("稳定 2s 后必须切回前台");
        assert!(front.active);
        assert!(front.wake);
        assert_eq!(r.signal(true, 12_500), Signal::Ignored);
    }

    /// 唤醒最小间隔：两次切到前台间隔不足一个周期 ⇒ 第二次不强制扫描。
    #[test]
    fn wake_scan_respects_the_minimum_interval() {
        let mut r = FocusRhythm::new(false);
        assert_eq!(r.signal(true, 0), Signal::Scheduled);
        let first = r.tick(2_000, 5_000).unwrap();
        assert!(first.wake);

        // 2.1s 抖回后台（稳定生效），4.2s 再回前台：距上次唤醒只有 4.2s
        assert_eq!(r.signal(false, 2_100), Signal::Scheduled);
        assert!(r.tick(4_100, 5_000).is_some());
        assert_eq!(r.signal(true, 4_200), Signal::Scheduled);
        let second = r.tick(6_200, 5_000).unwrap();
        assert!(second.active);
        assert!(
            !second.wake,
            "距上一次强制扫描只有 4.2s，不足一个周期，必须被最小间隔挡住"
        );

        // 再等过一个完整周期后的一次稳定切换 ⇒ 允许唤醒
        assert_eq!(r.signal(false, 6_300), Signal::Scheduled);
        assert!(r.tick(8_300, 5_000).is_some());
        assert_eq!(r.signal(true, 8_500), Signal::Scheduled);
        let third = r.tick(10_500, 5_000).unwrap();
        assert!(third.wake, "距上次唤醒已 > 5s，这时才允许再唤醒");
    }
}
