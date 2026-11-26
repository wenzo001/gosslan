//! 其它桌面平台（Linux / *BSD）的占位探针。
//!
//! 目前**一律返回插电 + 未锁屏** ⇒ 档位恒为 Active，行为与改造前完全一致。
//!
//! 为什么不顺手读 `/sys/class/power_supply/*/online`：
//!   - 笔记本的电池/适配器命名因厂商而异（`AC` / `ACAD` / `ADP1` / `AC0` …），
//!     "读不到"与"没插电"在这个接口上无法区分，误判会把用户降档；
//!   - 锁屏要走 D-Bus（`org.freedesktop.login1` 的 `LockedHint`），需要拉一个
//!     D-Bus 客户端依赖 —— 而 Linux 目前不是发版主力，先不引入。
//!
//! 接口已经在这里定型：接 Linux 时只需要把 [`snapshot`] 换成真实读数，
//! 上层的档位合成、防抖、节拍器都不用动。

use super::Snapshot;

pub fn snapshot() -> Snapshot {
    Snapshot {
        on_ac: true,
        screen_locked: false,
    }
}
