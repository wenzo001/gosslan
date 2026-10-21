//! BLE 外设事件队列的**硬上限**与溢出信号（三平台共用，拍板 3B）。
//!
//! 三个平台的外设回调（CoreBluetooth 主队列 / WinRT 任意线程 / Kotlin JNI）都**不能
//! await**，事件只能非阻塞投递。此前用的是**无界**通道 —— 消费侧一旦被慢链路堵住
//! （每条链路的字节通道 cap 1024），事件就无限堆积；单条帧上限还是 512 KiB
//! （[`super::ble_framing::MAX_BLE_MESSAGE_BYTES`]）。
//!
//! 拍板的三条，全在这里落地：
//! 1. **硬上限**：队列容量固定（`PERIPHERAL_EVENT_QUEUE_CAP` 条）。
//! 2. **不得静默丢帧**：满了以后这条事件**不入队**，同时通过 `watch` **带外**发一个
//!    溢出信号（队列满时这是唯一还能送达消费侧的通道）。消费侧收到后**主动拆掉全部
//!    外设路由**并进入冷却期 —— 断链本身就是"这一帧不会假装收到"的交代；冷却期收到的
//!    帧会计数后丢弃，冷却结束落一条日志。不做"丢最旧的"。
//! 3. **防重连风暴**：冷却时长带**抖动**（基准 + 随种子变化的 0..=3s），
//!    避免两端在同一毫秒反复重连。
#![cfg(feature = "bluetooth")]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, watch};

/// 事件队列硬上限（条）。
///
/// 64 条 × 单帧上限 512 KiB = 最坏 **32 MiB**；正常帧（BLE 分片重组后）远小于此。
/// 消费侧只做"转交给每条链路的管道"，64 条足够吸收一次突发，又不会把慢链路的影响
/// 放大成随时间的无界增长。
pub const PERIPHERAL_EVENT_QUEUE_CAP: usize = 64;

/// 溢出断链后的冷却基准（毫秒）。
pub const OVERFLOW_BACKOFF_BASE_MS: u64 = 2_000;
/// 冷却抖动的上限（毫秒）—— 实际冷却 = 基准 + [0, 本值]。
pub const OVERFLOW_BACKOFF_JITTER_MS: u64 = 3_000;

/// 回调线程持有的投递端。`Clone`（macOS 的 delegate 与 writer 可能各持一份）。
#[derive(Clone)]
pub struct PeripheralEventSender<T> {
    tx: mpsc::Sender<T>,
    overflows: Arc<AtomicU64>,
    overflow: Arc<watch::Sender<u64>>,
}

impl<T> PeripheralEventSender<T> {
    /// 非阻塞投递。返回 `false` 表示**这一条没进队**（队满或消费端已退出）；
    /// 队满时同时把溢出信号推给消费侧，由它受控断链。
    ///
    /// 回调线程上绝不能阻塞/await —— 所以这里没有 `send().await`，
    /// 溢出是"丢这一条 + 带外信号"，不是"静默丢帧之后当没发生"。
    pub fn try_push(&self, ev: T) -> bool {
        match self.tx.try_send(ev) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                let n = self.overflows.fetch_add(1, Ordering::Relaxed) + 1;
                self.overflow.send_replace(n);
                false
            }
            Err(TrySendError::Closed(_)) => false,
        }
    }
}

/// 建一对（投递端，接收端，溢出信号）。
pub fn channel<T>() -> (
    PeripheralEventSender<T>,
    mpsc::Receiver<T>,
    watch::Receiver<u64>,
) {
    let (tx, rx) = mpsc::channel(PERIPHERAL_EVENT_QUEUE_CAP);
    let (otx, orx) = watch::channel(0u64);
    (
        PeripheralEventSender {
            tx,
            overflows: Arc::new(AtomicU64::new(0)),
            overflow: Arc::new(otx),
        },
        rx,
        orx,
    )
}

/// 溢出后的服务端冷却时长：**有下界、有上界、随种子抖动**。
///
/// 种子用当前时间（`db::now_ms()`）即可 —— 它每次都不同，足够打散两端节奏；
/// 同一毫秒内的两端也会因为各自溢出时刻不同而错开。
pub fn overflow_backoff_ms(seed: u64) -> u64 {
    OVERFLOW_BACKOFF_BASE_MS + seed % (OVERFLOW_BACKOFF_JITTER_MS + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 满了必须"拒绝入队 + 带外发信号"，消费一拍之后容量必须恢复。
    /// 反过来说：这里**不许**出现"丢最旧的继续塞"（那会把积压藏进内存里）。
    #[test]
    fn overflow_is_signalled_and_capacity_recovers() {
        let (tx, mut rx, mut overflow) = channel::<u8>();
        assert!(!overflow.has_changed().unwrap(), "初值不算一次溢出");
        for i in 0..PERIPHERAL_EVENT_QUEUE_CAP {
            assert!(tx.try_push(i as u8), "第 {i} 条应当入队");
        }
        assert!(!tx.try_push(0), "队满时必须拒绝这一条（调用侧据此断链）");
        assert!(overflow.has_changed().unwrap(), "溢出必须有带外信号");
        assert_eq!(*overflow.borrow_and_update(), 1);
        rx.try_recv().expect("先取出最早那条");
        assert!(tx.try_push(0), "消费一拍后队列必须恢复可用");
    }

    /// 冷却有下界、有上界、且真的抖动（不是常数）。
    #[test]
    fn overflow_backoff_is_bounded_and_jittered() {
        assert_eq!(overflow_backoff_ms(0), OVERFLOW_BACKOFF_BASE_MS);
        assert_eq!(
            overflow_backoff_ms(OVERFLOW_BACKOFF_JITTER_MS),
            OVERFLOW_BACKOFF_BASE_MS + OVERFLOW_BACKOFF_JITTER_MS
        );
        assert_eq!(
            overflow_backoff_ms(OVERFLOW_BACKOFF_JITTER_MS + 1),
            OVERFLOW_BACKOFF_BASE_MS,
            "抖动是取模，不是无限增长"
        );
        let mut seen = std::collections::HashSet::new();
        for seed in 0..10_000u64 {
            let d = overflow_backoff_ms(seed);
            assert!(
                (OVERFLOW_BACKOFF_BASE_MS..=OVERFLOW_BACKOFF_BASE_MS + OVERFLOW_BACKOFF_JITTER_MS)
                    .contains(&d),
                "冷却必须在 [基准, 基准+抖动] 内，实测 {d}"
            );
            seen.insert(d);
        }
        assert!(
            seen.len() > 1,
            "冷却必须抖动，不能是常数（否则两端同步重连）"
        );
    }
}
