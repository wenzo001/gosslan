//! Android：局域网通道开着时，让系统不要把守着 UDP/TCP/Gossip 的进程回收掉。
//!
//! 承诺的口径与全部取舍在 `docs/adr/0022-android-background-messaging-commitment.md`；
//! 这一层只做 JNI 桥，**不做任何"要不要跑"的判断** —— 判断留在 Kotlin 侧的那一个开关上
//! （见 `BackgroundService.kt` 的类注释），避免出现第二个状态机。
//!
//! ```text
//! MainActivity.onCreate ──► BackgroundService.bootstrap(ctx) ──► nativeAttachBackground()  [本模块]
//!                                                               └─ 缓存 JavaVM + BackgroundService 类引用
//! network::start()（局域网起来）──► ensure_running() ──► BackgroundService.start()  [Kotlin，@JvmStatic]
//! stop_network / set_channel_enabled("lan", false)（**用户主动关通道**）──► stop() ──► BackgroundService.stop()
//! get_runtime_diag()           ──► diag()             ──► isRunning / foregroundTypes / lastStartError
//! ```
//!
//! ⚠️ 停服务**不**接在 `network::stop()` 里：`start()` 的第一件事就是 `stop()`（换网卡/重开），
//! 接在那里会让每次重绑都"销毁服务→重建"，而 Android 12+ 从后台重新拉起前台服务会被拒 ⇒
//! 服务从此没了，而症状只是"锁屏后收不到消息"。这条落点差异由接线守卫
//! `background_service_wiring_follows_the_lan_channel` 钉住（正反两格都钉）。
//!
//! 四个非显然点，前两条与本仓另一条桥（`android_open.rs`）同源：
//! 1. **JavaVM / 类引用必须由 Kotlin 侧"带过来"**：JNI 的 `FindClass` 依赖调用方的类加载器，
//!    在 tokio 工作线程上按名字找 App 的类会失败。
//! 2. **`native_method!` 必须写 `static`**：`nativeAttachBackground()` 是**文件级（顶层）函数**
//!    ⇒ 编译成 `BackgroundServiceKt` 的 static 方法。按实例方法注册的话，ART 在第一次调用时
//!    判定不一致并**直接 abort 整个进程**（连日志都来不及写全）。护栏
//!    `jni_static_matches_kotlin_toplevel` 盯着这条对应关系。
//! 3. **非 Android 目标是空实现，而不是整个模块 `#[cfg]` 掉**：这样 `network/mod.rs` 与
//!    `commands/channel.rs` 里一处 `#[cfg]` 都不用写（三条调用点分散在两个模块，逐点加 cfg
//!    是漂移的入口）。`diag()` 在非 Android 返回 `None` ⇒ 诊断那一行整行不出现，
//!    而不是显示一个假的"没在跑"。

use serde::Serialize;

/// 前台服务的自检读数（诊断面板那一行；字段口径见 `commands::RuntimeDiag`）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundDiag {
    /// JNI 桥是否已就绪（`MainActivity.onCreate` 跑过 `bootstrap` 才是 true）。
    /// false 时后面三个读数一律是"读不到"，不许让界面把"桥没接上"显示成"服务没在跑"。
    pub ready: bool,
    pub running: bool,
    /// 实际生效的前台服务类型位。**-1 = 读不到**（界面必须显示成未知，不是 0）。
    /// 0 是有含义的：服务活着但没拿到前台地位 —— 类型被系统拒绝那一类故障就长这样。
    pub types: i64,
    /// 最近一次失败的机器码（`FG_<类型位>_<异常名>` / `START_*` / `NO_CONTEXT`）。
    pub last_error: Option<String>,
}

#[cfg(target_os = "android")]
mod bridge {
    use std::sync::OnceLock;

    use jni::objects::{Global, JClass, JString};
    use jni::vm::JavaVM;
    // 这里不导入 `JValue`：本桥调的 5 个 Kotlin 方法全是**零参**的，实参数组恒为 `&[]`。
    use jni::{jni_sig, jni_str, native_method, Env, NativeMethod};

    use crate::jni_method::kotlin_method;

    use super::BackgroundDiag;

    /// JVM 句柄（`bootstrap` 时缓存；之后从任意线程 attach 使用）。
    static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();
    /// `BackgroundService` **类本身**的全局引用（`start`/`stop`/… 都在它的 companion 上）。
    ///
    /// ⚠️ 不能直接用 `native_attach` 收到的那个 class 参数：那是顶层函数所在的
    /// `BackgroundServiceKt`，而 `@JvmStatic` 把静态桥生成在 **`BackgroundService`** 上。
    /// 同 `android_open.rs` 里 `OpenWithKt` vs `OpenWith` 那一坑。
    static SERVICE_CLASS: OnceLock<Global<JClass<'static>>> = OnceLock::new();

    /// 由 Kotlin 的 `BackgroundService.bootstrap` 调用（`extern` ⇒ 宏直接导出 JNI 符号名）。
    ///
    /// ⚠️ **必须是 `static`**（理由见本文件头第 2 条）。
    const NATIVE_ATTACH: NativeMethod = native_method! {
        java_type = "com.gosslan.app.BackgroundServiceKt",
        static extern fn native_attach_background() -> (),
        fn = native_attach,
    };

    /// 桥是否已就绪。
    fn ready() -> bool {
        // ⚠️ 这一行不是摆设：`NATIVE_ATTACH` 是 `native_method!` 展开出的 `const { … }` 块，
        // 块里那个 `#[export_name]` 的函数才是 JVM 要找的符号。整块常量如果完全没人用，
        // 就不保证被代码生成进产物 ⇒ 真机上 `UnsatisfiedLinkError`（只在 release 包里现形）。
        let _keep_exported = std::hint::black_box(&NATIVE_ATTACH);
        JAVA_VM.get().is_some() && SERVICE_CLASS.get().is_some()
    }

    /// `BackgroundService.bootstrap()`：缓存 VM 与类引用。
    fn native_attach<'local>(
        env: &mut Env<'local>,
        _kt_class: JClass<'local>,
    ) -> jni::errors::Result<()> {
        if JAVA_VM.get().is_none() {
            if let Ok(vm) = env.get_java_vm() {
                let _ = JAVA_VM.set(vm);
            }
        }
        if SERVICE_CLASS.get().is_none() {
            // native_attach 在 bootstrap 调用链上，此时 App 类加载器在栈上 —— find_class 安全
            let clazz = env.find_class(jni_str!("com/gosslan/app/BackgroundService"))?;
            let _ = SERVICE_CLASS.set(env.new_global_ref(clazz)?);
        }
        Ok(())
    }

    /// 请求起前台服务。**`None` ≠ `false`**：前者是"桥还没接上"，后者是"系统明确拒绝"，
    /// 把前者折成后者就等于给"界面显示没在跑、实际是桥没接上"这类误判开门。
    fn request_start() -> Option<bool> {
        let (class, vm) = handle()?;
        let (name, sig) = kotlin_method!("start", "()Z");
        vm.attach_current_thread(|env| env.call_static_method(class, name, sig, &[])?.z())
            .ok()
    }

    /// 停服务（常驻通知随之消失）。
    fn request_stop() -> Option<bool> {
        let (class, vm) = handle()?;
        let (name, sig) = kotlin_method!("stop", "()Z");
        vm.attach_current_thread(|env| env.call_static_method(class, name, sig, &[])?.z())
            .ok()
    }

    /// 服务实例是否活着（不含"有没有拿到前台地位"，那一半看 [`applied_types`]）。
    fn service_running() -> Option<bool> {
        let (class, vm) = handle()?;
        let (name, sig) = kotlin_method!("isRunning", "()Z");
        vm.attach_current_thread(|env| env.call_static_method(class, name, sig, &[])?.z())
            .ok()
    }

    /// 实际生效的前台服务类型位（0 = 活着但没前台地位）。
    fn applied_types() -> Option<i64> {
        let (class, vm) = handle()?;
        let (name, sig) = kotlin_method!("foregroundTypes", "()I");
        vm.attach_current_thread(|env| env.call_static_method(class, name, sig, &[])?.i())
            .ok()
            .map(i64::from)
    }

    /// 最近一次失败的机器码；Kotlin 侧 null = 没有失败。
    fn last_error() -> Option<Option<String>> {
        let (class, vm) = handle()?;
        let (name, sig) = kotlin_method!("lastStartError", "()Ljava/lang/String;");
        vm.attach_current_thread(|env| -> jni::errors::Result<Option<String>> {
            let value = env.call_static_method(class, name, sig, &[])?;
            let obj = value.l()?;
            if obj.as_raw().is_null() {
                return Ok(None);
            }
            Ok(Some(env.cast_local::<JString>(obj)?.try_to_string(env)?))
        })
        .ok()
    }

    /// 取（类引用, VM）；桥未就绪返回 `None`。
    ///
    /// 这里刻意**一个 `expect` 都不写**：本模块的公开承诺是"读不到就说读不到"，而 release
    /// 开着 `panic = "abort"` —— 为一次诊断读数把进程带走，代价与故障本身完全不成比例。
    /// `ready()` 仍要先跑一次：它负责把 `NATIVE_ATTACH` 钉进产物（见那里面那条注释）。
    fn handle() -> Option<(&'static Global<JClass<'static>>, &'static JavaVM)> {
        if !ready() {
            return None;
        }
        Some((SERVICE_CLASS.get()?, JAVA_VM.get()?))
    }

    /// 局域网通道起来了 ⇒ 起前台服务。
    ///
    /// 失败**只留日志、不向上报错**（这一条调用点在 `network::start()` 的成功路径上）：
    /// 前台服务起不来不影响本机此刻能收消息，只影响"锁屏后还能不能收到"；把网络启动判成
    /// 失败反而会让用户看到一条与他做的事无关的错误。可诊断性由 [`last_error`] 那一行读数负责。
    pub fn ensure_running(logger: &crate::logging::Logger) {
        match request_start() {
            Some(true) => logger.info("background", "code=BG_SERVICE_START_REQUESTED"),
            Some(false) => {
                // 拒绝那一格要把**码**一起打出来：只有"被拒"两个字的话，真机上分不清是
                // 类型权限缺件还是 Android 12+ 的后台启动限制（这两种的处置完全不同）。
                match last_error() {
                    Some(Some(err)) => {
                        logger.warn("background", format!("code=BG_SERVICE_START_REFUSED {err}"))
                    }
                    _ => logger.warn(
                        "background",
                        "code=BG_SERVICE_START_REFUSED（Kotlin 侧没给出码）",
                    ),
                }
            }
            None => logger.warn(
                "background",
                "code=BG_BRIDGE_NOT_READY（MainActivity 未调用 BackgroundService.bootstrap）",
            ),
        }
    }

    /// 用户关掉局域网通道 ⇒ 停服务（常驻通知随之消失）。
    ///
    /// 这条一定要留痕：`stopService` 返回 false（服务本来就没在跑）与"通道已经关了、
    /// 服务却还活着"是两件不同的事，而后者只有对比这条日志与 [`diag`] 的 `running` 才看得出来。
    pub fn stop(logger: &crate::logging::Logger) {
        match request_stop() {
            Some(true) => logger.info("background", "code=BG_SERVICE_STOPPED"),
            Some(false) => logger.info("background", "code=BG_SERVICE_STOP_NOOP 本来就没在跑"),
            None => logger.warn(
                "background",
                "code=BG_BRIDGE_NOT_READY 停服务请求没送到（MainActivity 未调用 bootstrap）",
            ),
        }
    }

    /// 诊断面板那一行：三个读数分别取，取不到的一律给"未知"（-1 / None），不许折成 0。
    pub fn diag() -> Option<BackgroundDiag> {
        if !ready() {
            return Some(BackgroundDiag {
                ready: false,
                running: false,
                types: -1,
                last_error: None,
            });
        }
        Some(BackgroundDiag {
            ready: true,
            running: service_running().unwrap_or(false),
            types: applied_types().unwrap_or(-1),
            last_error: last_error().flatten(),
        })
    }
}

#[cfg(target_os = "android")]
pub fn ensure_running(logger: &crate::logging::Logger) {
    bridge::ensure_running(logger);
}

/// 安卓：停服务并留痕（见 `bridge::stop` 那条注释）。
#[cfg(target_os = "android")]
pub fn stop(logger: &crate::logging::Logger) {
    bridge::stop(logger);
}

/// 安卓：三个读数（桥没接上时 `ready=false` + 后两格"未知"）。
#[cfg(target_os = "android")]
pub fn diag() -> Option<BackgroundDiag> {
    bridge::diag()
}

/// 非 Android：`None` ⇒ 诊断面板那一行整行不出现。
#[cfg(not(target_os = "android"))]
pub fn diag() -> Option<BackgroundDiag> {
    None
}

/// 非 Android：空实现（见文件头第 3 条 —— 目的只有一个：调用点不写 `#[cfg]`）。
#[cfg(not(target_os = "android"))]
pub fn ensure_running(_logger: &crate::logging::Logger) {}

#[cfg(not(target_os = "android"))]
pub fn stop(_logger: &crate::logging::Logger) {}
