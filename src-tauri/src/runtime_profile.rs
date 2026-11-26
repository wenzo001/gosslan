//! 运行档位（Runtime Profile）：把「电源 / 锁屏 / 窗口前后台」三个判据**合成**成三级节奏。
//!
//! ## 要治的那一格（用户 2026-11-26）
//!
//! 「电脑插着电就正常跑；没插电就降一档；锁屏/休眠了就把资源压到最低 —— 但用户回来时
//! 收消息要照常。」现场是长期挂机的桌面端，电量与发热是真实抱怨。
//!
//! ## 为什么是"合成判据"而不是新造一套调度
//!
//! 仓库里**已经**有两处按活跃度自适应节奏的先例：
//!   - [`crate::focus_rhythm`]：窗口前台/失焦两档，带 2s 防抖（BLE 扫描据此 5s/30s 切换）；
//!   - `discovery` 的 `adaptive_interval(node_count)`：按在线节点数调广播周期。
//!
//! 也就是说"降低频率"这件事本身不新，缺的是**判据**。所以这里只做三件事：
//!   ① 定义三级档位与它们对各循环周期的倍数（[`multiplier`]）；
//!   ② 把三个判据合成一个档位（[`compose`]），并给电源/锁屏抖动加防抖（[`ProfileGate`]）；
//!   ③ 给各循环一个统一节拍器（[`Cadence`]）—— 到点跑、没到点跳过，**不改任何协议语义**。
//!
//! ## 硬约束（动手前先读，别破坏）
//!
//! 1. **只改"下一次等多久"**：msg_id / E2EE / Outbox / Ack / 表结构一概不碰。降档期间
//!    消息照收、照落库、照回 Ack，只是"主动去问"的频率变低。
//! 2. **不做"完全冻结"**：锁屏档（Dormant）仍然保活与收包。理由有二 ——
//!    ① 用户明确要"打开接收消息正常"；② 离线判定靠链路被移除（`peer_offline_after_tail`），
//!    **不是心跳超时**，所以拉长心跳不会把人误判成离线，但完全停掉会让解锁后要重连一轮。
//! 3. **档位切换立即补一次**：`Cadence` 靠 [`generation`] 感知切换，恢复 Active 时下一轮
//!    立刻跑，而不是等一个被拉长的完整周期（否则解锁后最长 60s 才有第一次心跳）。
//! 4. **正在传文件时不降档**：由调用方（outbox 对账）自己判在途，见 `outbox_sweep`。
//!
//! ## 为什么倍数表这么定（温和档）
//!
//! 判据来自"用户到底等不等得起"：心跳是断连发现（等不起太久），广播/扫描是发现新设备
//! （用户不在跟前时等得起）。所以 Dormant 下 Keepalive 只到 12 倍（5s→60s），
//! Proactive 到 60 倍（15s→900s，15 分钟一轮，近似停掉）。

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::time::{Duration, Instant};

/// 三级档位。顺序即"资源从多到少"，`repr` 值用于原子存储，**不要重排**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Profile {
    /// 前台 + 插电 + 未锁屏：完全维持现状。
    Active = 0,
    /// 电池供电，或窗口在后台（但人还在机器前）：周期 ×3。
    Saver = 1,
    /// 锁屏：只留保活与收包，主动行为近似停掉。
    Dormant = 2,
}

impl Profile {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Profile::Saver,
            2 => Profile::Dormant,
            _ => Profile::Active,
        }
    }

    /// 诊断行/日志里的短名（现场按空白分字段，不许带空格）。
    ///
    /// 只有桌面端的切档日志与测试读它 —— 移动端没有探针（`power` 不编译），
    /// 不加这个 cfg 就会在 Android 门禁的「0 warning」上红。
    #[cfg(any(desktop, test))]
    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Active => "active",
            Profile::Saver => "saver",
            Profile::Dormant => "dormant",
        }
    }
}

/// 一个循环属于哪一类节拍 —— 决定 Dormant 时"降频"还是"近似停"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CadenceKind {
    /// 保活类（心跳）：断连发现能力，Dormant 也要留着，只降频。
    Keepalive,
    /// 主动类（广播 / 扫描 / 打洞签到）：用户不在跟前就没有价值，Dormant 近似停。
    Proactive,
    /// 送达类（outbox 对账 / ACK 重放）：**电池下不降**。
    ///
    /// 单独一档的理由：它是"消息发出去了没有"的唯一收敛出口。Saver 下把它 ×3
    /// （30s→90s），用户会觉得"电池模式下发消息变慢/一直转圈"，而省下的那点电
    /// 远不值这个体感损失。只有锁屏（人确实不在）才降到 1/20。
    Delivery,
}

/// 当前档位下该循环周期要乘几倍（`1.0` = 现状）。
///
/// ⚠️ 这张表是**唯一事实来源**：任何循环都不许自己写死降档倍数，否则两处会分叉
/// （同一个档位下心跳和广播的"降一档"含义不同，用户会看到"省电了但还是费电"）。
pub fn multiplier(kind: CadenceKind, p: Profile) -> f64 {
    match (kind, p) {
        (_, Profile::Active) => 1.0,
        (CadenceKind::Keepalive, Profile::Saver) => 3.0,
        (CadenceKind::Keepalive, Profile::Dormant) => 12.0,
        (CadenceKind::Proactive, Profile::Saver) => 3.0,
        (CadenceKind::Proactive, Profile::Dormant) => 60.0,
        // 送达路径：电池下完全维持，锁屏才慢下来（恢复时 `Cadence` 会立刻补一轮）。
        (CadenceKind::Delivery, Profile::Saver) => 1.0,
        (CadenceKind::Delivery, Profile::Dormant) => 20.0,
    }
}

/// 三个判据合成档位（纯函数，真值表见用例）。
///
/// 优先级：**锁屏压过一切** —— 锁屏时窗口往往还是"前台"（macOS 上 `app_active` 不会因为
/// 锁屏而变 false），若让 `app_active` 先判就会把锁屏当成 Active，这是最容易写错的一格。
/// 其次：前台 + 插电才算 Active；其余（电池、或窗口在后台）一律 Saver。
#[cfg(any(desktop, test))]
pub fn compose(app_active: bool, on_ac: bool, screen_locked: bool) -> Profile {
    if screen_locked {
        return Profile::Dormant;
    }
    if app_active && on_ac {
        Profile::Active
    } else {
        Profile::Saver
    }
}

/// 电源/锁屏结论要稳定多久才真正切档（毫秒）。
///
/// 比焦点防抖（2s）宽一点：插拔电源、合盖再打开都会在 1~2s 内抖出相反读数，
/// 而这三秒里用户完全感知不到（降档只影响"下一轮等多久"）。
#[cfg(any(desktop, test))]
pub const PROFILE_DEBOUNCE_MS: i64 = 3_000;

// ---------------- 全局档位 ----------------

static PROFILE: AtomicU8 = AtomicU8::new(Profile::Active as u8);
/// 档位"代际"：每次**真正**切档 +1。各循环的 [`Cadence`] 靠它感知"该补一次了"。
static GENERATION: AtomicU64 = AtomicU64::new(1);

pub fn profile() -> Profile {
    Profile::from_u8(PROFILE.load(Ordering::Acquire))
}

pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// 切档时唤醒"睡到某个时刻"的循环，让它们立刻按新周期重算。
///
/// 为什么需要它：discovery 的广播循环是 `sleep_until(next_at)` —— 锁屏时 `next_at`
/// 可能是 15 分钟之后；解锁后若只改"下次怎么算"，这一轮仍会睡满 15 分钟才广播。
/// 用 `notify_waiters`（不发 permit）：错过一次只会晚一轮，不会积压。
fn notify_handle() -> &'static tokio::sync::Notify {
    static N: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    N.get_or_init(tokio::sync::Notify::new)
}

/// 档位已变更的广播（给 `select!` 里等待）。见 [`notify_handle`] 的说明。
pub fn applied_notify() -> &'static tokio::sync::Notify {
    notify_handle()
}

/// 切档。返回 `true` 表示真的变了（同档重复调用是幂等的，不会白抬代际）。
///
/// 写序：先 profile 再 generation（都 Release）—— 读者先读 generation 再读 profile，
/// 看到新代际时新档位必然已可见。反过来会出现"代际已变、档位还是旧的"那一次误判。
#[cfg(any(desktop, test))]
pub fn set_profile(p: Profile) -> bool {
    if profile() == p {
        return false;
    }
    PROFILE.store(p as u8, Ordering::Release);
    GENERATION.fetch_add(1, Ordering::Release);
    notify_handle().notify_waiters();
    true
}

// ---------------- 抖动的三态防抖 ----------------

/// 三态版的 [`crate::focus_rhythm::FocusRhythm`]：规则同款（同向幂等、翻回已生效态即取消、
/// 真的换向才重新计稳定期），只是目标是三种档位而不是"前台/后台"。
///
/// 为什么要单独写一个而不是复用 `FocusRhythm`：后者的 `applied: bool` 与 `active_interval_ms`
/// 都绑在 BLE 扫描语义上，硬塞第三种状态会让那个已经很绕的状态机更难读。
#[cfg(any(desktop, test))]
#[derive(Debug)]
pub struct ProfileGate {
    applied: Profile,
    pending: Option<(Profile, i64)>,
}

#[cfg(any(desktop, test))]
impl ProfileGate {
    pub fn new(applied: Profile) -> Self {
        Self {
            applied,
            pending: None,
        }
    }

    /// 外部直接改过全局档位（窗口焦点切换走 `power::recompute_now`）时把已生效值同步回来。
    ///
    /// 不同步的后果：采样任务下一轮会拿**过时的** `applied` 当基准，把刚由焦点切好的档位
    /// 又"切回"去（用户看到的是"切回前台全速了，半秒后又变慢"）。
    /// 调用点必须每轮采样前先同步一次（幂等，同值无副作用）。
    pub fn set_applied(&mut self, p: Profile) {
        if self.pending.is_none() {
            self.applied = p;
        }
    }

    /// 收到一次采样结论。返回 `true` 表示排了一次待生效（调用方需要在稳定期后 [`tick`]）。
    pub fn signal(&mut self, target: Profile, now_ms: i64) -> bool {
        if let Some((pending_target, _)) = self.pending {
            if pending_target == target {
                // 同一目标重复到达：不重置计时器（否则持续抖动会永远不生效）。
                return false;
            }
            if target == self.applied {
                // 翻回已生效态 ⇒ 这段抖动什么都没产生，直接撤掉待生效。
                self.pending = None;
                return false;
            }
            self.pending = Some((target, now_ms + PROFILE_DEBOUNCE_MS));
            return true;
        }
        if target == self.applied {
            return false;
        }
        self.pending = Some((target, now_ms + PROFILE_DEBOUNCE_MS));
        true
    }

    /// 稳定期到了再看一眼：目标是否仍然稳定。返回新档位表示"这次真的切了"。
    pub fn tick(&mut self, now_ms: i64) -> Option<Profile> {
        let (target, at_ms) = self.pending?;
        if now_ms < at_ms {
            return None;
        }
        self.pending = None;
        self.applied = target;
        Some(target)
    }
}

// ---------------- 统一节拍器 ----------------

/// 各循环的统一节拍器：**到点跑、没到点跳过**。
///
/// 为什么不直接把 `tokio::time::interval` 的周期改掉：改周期要重建 interval，
/// 每个循环都得处理"重建时丢掉的那半个周期"；而"跳过本轮"对循环结构零侵入，
/// 语义也更好读 —— 循环体不变，只是"这一轮不做"。
#[derive(Debug)]
pub struct Cadence {
    base: Duration,
    kind: CadenceKind,
    /// `None` = 还没跑过 ⇒ 第一次一定 due（与 `tokio::interval` 首 tick 立即的语义一致）。
    last: Option<Instant>,
    seen_gen: u64,
}

impl Cadence {
    pub fn new(base: Duration, kind: CadenceKind) -> Self {
        Self {
            base,
            kind,
            last: None,
            seen_gen: generation(),
        }
    }

    /// 到点了吗？是 ⇒ 推进基准并返回 `true`；否 ⇒ 返回 `false`（本轮跳过）。
    pub fn due(&mut self) -> bool {
        self.due_at(Instant::now(), profile(), generation())
    }

    /// 显式参数版（虚拟时钟可测，不读全局状态）。
    pub fn due_at(&mut self, now: Instant, p: Profile, gen: u64) -> bool {
        // 档位刚变过 ⇒ 立刻补一次。
        // 这是"恢复即补"的唯一实现点：解锁/插电后心跳、对账、广播都马上跑一轮，
        // 用户不会遇到"回来了但要等一分钟才收到东西"。
        if gen != self.seen_gen {
            self.seen_gen = gen;
            self.last = Some(now);
            return true;
        }
        let need = self.base.mul_f64(multiplier(self.kind, p));
        match self.last {
            None => {
                self.last = Some(now);
                true
            }
            Some(last) => {
                // `saturating_duration_since`：时钟回拨/测试里传入更早的 now 时不许 panic。
                if now.saturating_duration_since(last) >= need {
                    self.last = Some(now);
                    true
                } else {
                    false
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成真值表：锁屏压过一切；前台+插电才是 Active；其余 Saver。
    #[test]
    fn compose_truth_table() {
        use Profile::*;
        // (app_active, on_ac, locked) -> 期望
        let cases = [
            ((true, true, false), Active),
            ((true, false, false), Saver),
            ((false, true, false), Saver),
            ((false, false, false), Saver),
            // 锁屏时窗口往往仍是"前台"，这一格最容易写错
            ((true, true, true), Dormant),
            ((true, false, true), Dormant),
            ((false, false, true), Dormant),
        ];
        for ((a, ac, lk), want) in cases {
            assert_eq!(compose(a, ac, lk), want, "compose({a}, {ac}, {lk})");
        }
    }

    /// 倍数表：Active 恒 1；Dormant 下 Keepalive 与 Proactive 必须**分开**，
    /// 否则要么心跳停太久（断连发现变慢），要么主动行为停不下来（没省电）。
    #[test]
    fn multiplier_table_is_monotonic_and_splits_by_kind() {
        use CadenceKind::*;
        use Profile::*;
        for k in [Keepalive, Proactive, Delivery] {
            assert_eq!(multiplier(k, Active), 1.0);
            assert!(
                multiplier(k, Saver) > 1.0 || k == Delivery,
                "{k:?} Saver 必须降频（送达类例外）"
            );
            assert!(
                multiplier(k, Dormant) > multiplier(k, Saver),
                "{k:?} Dormant 必须比 Saver 更低"
            );
        }
        assert_eq!(multiplier(Keepalive, Dormant), 12.0);
        assert_eq!(multiplier(Proactive, Dormant), 60.0);
        assert!(
            multiplier(Proactive, Dormant) > multiplier(Keepalive, Dormant),
            "Dormant 下主动类必须比保活类降得更狠"
        );
        // 送达路径在电池下**不许**降：降了就是"电池模式下发消息变慢"。
        assert_eq!(
            multiplier(Delivery, Saver),
            1.0,
            "电池供电不得拖慢发送/重投"
        );
        assert!(
            multiplier(Delivery, Dormant) > 1.0,
            "锁屏才允许放慢送达对账"
        );
    }

    /// 防抖：插拔电源抖三下 ⇒ 只切一次，且切的是最后稳定的那个。
    #[test]
    fn gate_collapses_power_flapping_into_one_switch() {
        use Profile::*;
        let mut g = ProfileGate::new(Active);
        // t=0 掉电(→Saver)，t=1s 插回(→Active，回到已生效态 ⇒ 取消)，t=1.5s 又掉电
        assert!(g.signal(Saver, 0));
        assert_eq!(g.tick(1_000), None, "1s 还没稳定，不许切");
        assert!(!g.signal(Active, 1_000), "翻回已生效态 ⇒ 撤销待生效");
        assert!(g.signal(Saver, 1_500));
        assert_eq!(g.tick(3_000), None, "1.5s+3s 稳定期未到");
        assert_eq!(g.tick(4_500), Some(Saver), "稳定 3s 后才生效");
        // 生效后重复 tick 不许再切
        assert_eq!(g.tick(9_000), None);
        // 同向重复信号幂等
        assert!(!g.signal(Saver, 9_100));
    }

    /// 节拍器：Active 到点就跑；Saver 下同样时间间隔必须被跳过。
    #[test]
    fn cadence_skips_in_saver_and_passes_in_active() {
        use Profile::*;
        let t0 = Instant::now();
        let base = Duration::from_secs(5);
        let mut c = Cadence {
            base,
            kind: CadenceKind::Keepalive,
            last: Some(t0),
            seen_gen: 7,
        };
        // 5.1s，Active ⇒ due
        assert!(c.due_at(t0 + Duration::from_millis(5_100), Active, 7));
        // 5.1s 后，Saver（×3=15s）⇒ 不 due
        assert!(!c.due_at(t0 + Duration::from_millis(10_200), Saver, 7));
        // 攒够 15s ⇒ due
        assert!(c.due_at(t0 + Duration::from_millis(20_300), Saver, 7));
    }

    /// 代际变化 ⇒ 立刻补一次（解锁/插电后不用等一整个被拉长的周期）。
    #[test]
    fn cadence_runs_immediately_after_profile_switch() {
        use Profile::*;
        let t0 = Instant::now();
        let mut c = Cadence {
            base: Duration::from_secs(5),
            kind: CadenceKind::Keepalive,
            last: Some(t0),
            seen_gen: 3,
        };
        // Dormant 下才过 2s（远不到 60s），但代际从 3 变 4 ⇒ 必须立刻 due
        assert!(c.due_at(t0 + Duration::from_secs(2), Dormant, 4));
        // 同代际、刚跑过 ⇒ 不 due
        assert!(!c.due_at(t0 + Duration::from_secs(3), Active, 4));
    }

    /// 首次 due：`last=None` 时第一次一定跑（与 tokio interval 首 tick 立即一致）。
    #[test]
    fn first_tick_is_immediate() {
        let t0 = Instant::now();
        let mut c = Cadence {
            base: Duration::from_secs(30),
            kind: CadenceKind::Proactive,
            last: None,
            seen_gen: 1,
        };
        assert!(
            c.due_at(t0, Profile::Dormant, 1),
            "第一轮必须立刻跑，不能被 60 倍拖住"
        );
    }

    /// `set_profile` 幂等：同档重复设置不抬代际（否则每一轮采样都会让所有循环"补一次"）。
    #[test]
    fn set_profile_is_idempotent() {
        let before = generation();
        let p = Profile::from_u8(PROFILE.load(Ordering::Acquire));
        assert!(!set_profile(p), "设置当前档位必须是 no-op");
        assert_eq!(generation(), before, "no-op 不许抬代际");
    }
}
