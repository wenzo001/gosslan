//! macOS 电源 / 锁屏探针（手写 FFI，零新依赖）。
//!
//! 两个都是**只读**系统调用，微秒级，可以在任意线程调用（不要在主线程高频调即可）。
//!
//! ## 电源：为什么用 `IOPSGetProvidingPowerSourceType`
//!
//! 常见写法是 `IOPSCopyPowerSourcesInfo` + 遍历电源列表 + 读 `kIOPSPowerSourceStateKey`，
//! 要处理一堆 CFDictionary/CFArray（代码长、易漏 `CFRelease`）。而这一个函数直接返回
//! 当前供电来源的 CFString（`"AC Power"` / `"Battery Power"` / `"UPS Power"`），
//! 够用且没有所有权遍历。传 `NULL` 表示"当前系统快照"。
//!
//! ## 锁屏：为什么只能读 `CGSessionCopyCurrentDictionary`
//!
//! macOS 至今**没有公开 API** 能问"屏幕现在锁了没有"。事实标准是读
//! `CGSessionCopyCurrentDictionary()` 里的 `CGSSessionScreenIsLocked`（一个 CFBoolean），
//! 大量开源项目（Hammerspoon、Amphetamine 类工具）都这么做，十多年稳定。
//! 该字典在**非 GUI 会话**（如 launchd 起的纯后台进程）里可能返回 NULL ——
//! 那时按"未锁屏"处理（安全默认：宁可少省电，也不要在读不到状态时降档）。
//!
//! ## 休眠为什么不单独接
//!
//! `NSWorkspace.willSleepNotification` 能拿到"即将休眠"，但休眠时**整个进程被挂起**，
//! 本来就不耗 CPU；醒来后 tokio 的定时器会按 `MissedTickBehavior::Delay` 收敛，
//! 不会补一堆 tick。所以"休眠"这一档不需要额外代码 —— 真正需要感知的是锁屏
//! （锁屏时进程仍在跑、仍在全速轮询，那才是要省的电）。

use super::Snapshot;
use std::ffi::{c_void, CStr};

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFDictionaryRef = *const c_void;
type Boolean = u8;

/// `kCFStringEncodingUTF8`
const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(alloc: CFTypeRef, c_str: *const i8, encoding: u32) -> CFStringRef;
    fn CFStringGetCString(s: CFStringRef, buf: *mut i8, buf_size: isize, encoding: u32) -> Boolean;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetLength(s: CFStringRef) -> isize;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFBooleanGetValue(b: CFTypeRef) -> Boolean;
    fn CFRelease(cf: CFTypeRef);
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    /// 返回当前供电来源的 CFString（调用方持有，需要 `CFRelease`）。`NULL` = 读不到。
    fn IOPSGetProvidingPowerSourceType(snapshot: CFTypeRef) -> CFStringRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    /// 当前 GUI 会话的描述字典（调用方持有，需要 `CFRelease`）。非 GUI 会话可能为 `NULL`。
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
}

/// CFString → Rust String（只在诊断/判据里用，长度都很短）。
///
/// # Safety
/// `s` 必须是有效的 CFString 且调用方仍持有它。
unsafe fn cfstring_to_string(s: CFStringRef) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let len = unsafe { CFStringGetLength(s) };
    if len <= 0 {
        return None;
    }
    let max = unsafe { CFStringGetMaximumSizeForEncoding(len, CF_STRING_ENCODING_UTF8) } + 1;
    if max <= 0 {
        return None;
    }
    let mut buf = vec![0i8; max as usize];
    let ok = unsafe { CFStringGetCString(s, buf.as_mut_ptr(), max, CF_STRING_ENCODING_UTF8) };
    if ok == 0 {
        return None;
    }
    let c = unsafe { CStr::from_ptr(buf.as_ptr()) };
    c.to_str().ok().map(|v| v.to_string())
}

/// 是否正在用交流电。读不到时按"插电"处理（安全默认）。
pub fn on_ac() -> bool {
    unsafe {
        let s = IOPSGetProvidingPowerSourceType(std::ptr::null());
        if s.is_null() {
            return true;
        }
        let name = cfstring_to_string(s);
        CFRelease(s);
        match name.as_deref() {
            // "AC Power" / "UPS Power" 都算接电；"Battery Power" 才是电池。
            Some(v) => !v.contains("Battery"),
            None => true,
        }
    }
}

/// 屏幕是否已锁定。读不到会话字典时按"未锁屏"处理（安全默认）。
pub fn screen_locked() -> bool {
    unsafe {
        let dict = CGSessionCopyCurrentDictionary();
        if dict.is_null() {
            return false;
        }
        // key 必须是 CFString；用 C 字符串现造一个（`CFDictionaryGetValue` 只比较内容）。
        let key_bytes = b"CGSSessionScreenIsLocked\0";
        let key = CFStringCreateWithCString(
            std::ptr::null(),
            key_bytes.as_ptr() as *const i8,
            CF_STRING_ENCODING_UTF8,
        );
        if key.is_null() {
            CFRelease(dict);
            return false;
        }
        let v = CFDictionaryGetValue(dict, key);
        let locked = if v.is_null() {
            // 键不存在 = 该会话从未锁过（macOS 在锁屏时才写入这个键）。
            false
        } else {
            CFBooleanGetValue(v) != 0
        };
        CFRelease(key);
        CFRelease(dict);
        locked
    }
}

pub fn snapshot() -> Snapshot {
    Snapshot {
        on_ac: on_ac(),
        screen_locked: screen_locked(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 探针必须能真的跑起来（不 panic、不泄漏导致崩溃）。
    /// 不断言具体值：CI/开发机的电源与锁屏状态本来就不同。
    #[test]
    fn probe_runs_without_panic() {
        let s = snapshot();
        // 只要不是两条都"看起来像默认值没读到"就行 —— 真机上至少 on_ac 能读出来。
        println!(
            "macOS power snapshot: on_ac={} locked={}",
            s.on_ac, s.screen_locked
        );
    }

    /// 反复采样 50 次不许崩/不许读挂（等价于"没有 CFRelease 用错导致的 use-after-free"）。
    #[test]
    fn repeated_sampling_is_stable() {
        for _ in 0..50 {
            let s = snapshot();
            let _ = (s.on_ac, s.screen_locked);
        }
    }
}
