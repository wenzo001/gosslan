//! Android：应用内升级的 JNI 桥（检查安装包签名 → 发起 `PackageInstaller` 安装会话）。
//!
//! 为什么用 native 桥而不是纯 Rust：
//! - `PackageInstaller.Session` 必须拿到 `Context`；安装完成/待用户确认的回调必须回到
//!   `MainActivity`，这些都只能在 Kotlin 侧做；
//! - 系统安装器是否接管、用户取消、签名不一致等结果，只能经 `PackageInstaller` 的状态
//!   `PendingIntent` 拿回来。
//!
//! 调用方向（与 `android_open.rs` 的 FileProvider 桥同构）：
//! ```text
//! MainActivity.onCreate ─► ApkInstaller.bootstrap(this) ─► nativeAttachApkInstaller()  [本模块]
//!                                                           └─ 缓存 JavaVM + ApkInstaller 类
//! Rust android_updater_install ─► android_apk_install::install(path) ─► ApkInstaller.install(path)
//!                                                           └─ PackageInstaller 会话 + 系统确认
//! PackageInstaller 状态 ─► InstallResultReceiver ─► nativeOnInstallResult(...) ─► 命令层状态机
//! ```
//!
//! ⚠️ 三个非显然点：
//! 1. `nativeAttachApkInstaller()` 是**文件顶层函数**（`ApkInstallerKt`，static）⇒ 宏必须写
//!    `static`；写成实例方法会在真机启动时被 ART 直接 abort。
//! 2. `nativeOnInstallResult` / `nativeOnInstallStage` / `nativeOnPermissionResult` 同理是顶层
//!    `external fun`。
//! 3. release 包必须 keep 住 Kotlin 的业务方法与 native 符号，见
//!    `scripts/android/proguard-gosslan.pro`；`lib_android_jni_tests.rs` 有守卫。

use std::sync::OnceLock;

use jni::objects::{Global, JClass, JString};
use jni::sys::{jboolean, jint};
use jni::vm::JavaVM;
use jni::{jni_sig, jni_str, native_method, Env, JValue, NativeMethod};

use crate::jni_method::kotlin_method;

/// JVM 句柄（`bootstrap` 时缓存）。
static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();
/// `object ApkInstaller` 的全局引用（业务方法都带 `@JvmStatic`）。
/// native_attach 的 class 参数是 `ApkInstallerKt`，不是这个 object —— 必须额外 find_class。
static APK_INSTALLER_CLASS: OnceLock<Global<JClass<'static>>> = OnceLock::new();

const NATIVE_ATTACH: NativeMethod = native_method! {
    java_type = "com.gosslan.app.ApkInstallerKt",
    static extern fn native_attach_apk_installer() -> (),
    fn = native_attach,
};

const ON_INSTALL_RESULT: NativeMethod = native_method! {
    java_type = "com.gosslan.app.ApkInstallerKt",
    static extern fn native_on_install_result(result_code: jint, message: JString) -> (),
    fn = on_install_result,
};

const ON_INSTALL_STAGE: NativeMethod = native_method! {
    java_type = "com.gosslan.app.ApkInstallerKt",
    static extern fn native_on_install_stage(stage: jint) -> (),
    fn = on_install_stage,
};

const ON_PERMISSION_RESULT: NativeMethod = native_method! {
    java_type = "com.gosslan.app.ApkInstallerKt",
    static extern fn native_on_permission_result(granted: jboolean) -> (),
    fn = on_permission_result,
};

/// 桥是否已就绪。
pub fn ready() -> bool {
    // 四个常量都要取一次引用：`native_method!` 展开的是 `const` 块，没人用就不保证进产物。
    let _keep = std::hint::black_box((
        &NATIVE_ATTACH,
        &ON_INSTALL_RESULT,
        &ON_INSTALL_STAGE,
        &ON_PERMISSION_RESULT,
    ));
    JAVA_VM.get().is_some() && APK_INSTALLER_CLASS.get().is_some()
}

fn native_attach<'local>(
    env: &mut Env<'local>,
    _kt_class: JClass<'local>,
) -> jni::errors::Result<()> {
    if JAVA_VM.get().is_none() {
        if let Ok(vm) = env.get_java_vm() {
            let _ = JAVA_VM.set(vm);
        }
    }
    if APK_INSTALLER_CLASS.get().is_none() {
        let installer = env.find_class(jni_str!("com/gosslan/app/ApkInstaller"))?;
        let global = env.new_global_ref(installer)?;
        let _ = APK_INSTALLER_CLASS.set(global);
    }
    Ok(())
}

fn on_install_result<'local>(
    env: &mut Env<'local>,
    _kt_class: JClass<'local>,
    result_code: jint,
    message: JString<'local>,
) -> jni::errors::Result<()> {
    let message = if message.as_raw().is_null() {
        None
    } else {
        message.try_to_string(env).ok()
    };
    // `android_updater.rs` 被 `commands.rs` 以 `include!` 收进 `android_updater_impl`
    // 子模块，再由 `pub use android_updater_impl::*;` 重导出 ⇒ 这里走的是
    // `crate::commands::<名字>`，不能再多写一层模块名。
    crate::commands::on_native_install_result(result_code, message);
    Ok(())
}

fn on_install_stage<'local>(
    _env: &mut Env<'local>,
    _kt_class: JClass<'local>,
    stage: jint,
) -> jni::errors::Result<()> {
    crate::commands::on_native_install_stage(stage);
    Ok(())
}

fn on_permission_result<'local>(
    _env: &mut Env<'local>,
    _kt_class: JClass<'local>,
    granted: jboolean,
) -> jni::errors::Result<()> {
    // Kotlin 侧声明的是 `granted: Boolean`；本仓库锁定的 jni 0.22 里
    // `jni::sys::jboolean` 本身就等于 `bool` ⇒ 直接透传，不要和整数比较。
    crate::commands::on_native_permission_result(granted);
    Ok(())
}

fn with_installer<T>(
    call: impl FnOnce(&mut Env<'_>, &Global<JClass<'static>>) -> jni::errors::Result<T>,
) -> Result<T, String> {
    if !ready() {
        return Err("安装能力还没准备好（MainActivity 未调用 ApkInstaller.bootstrap）".to_string());
    }
    // 不用 `expect`：panic 站点棘轮对新文件要求 0 处（release 是 `panic = "abort"`，
    // 一条 panic 就是整个应用消失）。这里用 let-else 走可读的错误路径。
    let (Some(class), Some(vm)) = (APK_INSTALLER_CLASS.get(), JAVA_VM.get()) else {
        return Err("安装能力还没准备好（MainActivity 未调用 ApkInstaller.bootstrap）".to_string());
    };
    vm.attach_current_thread(|env| call(env, class))
        .map_err(|e| format!("JNI 调用失败：{e}"))
}

/// 检查 APK 能否安装：解析包、包名、签名证书必须与已安装应用一致。
/// `Ok(())` = 通过；`Err(code)` = Kotlin 给的具名原因（PARSE_FAILED / WRONG_PACKAGE / ...）。
pub fn inspect(path: &str) -> Result<(), String> {
    let outcome = with_installer(|env, class| -> jni::errors::Result<Result<(), String>> {
        let jpath = env.new_string(path)?;
        let (name, sig) = kotlin_method!("inspect", "(Ljava/lang/String;)Ljava/lang/String;");
        let value = env.call_static_method(class, name, sig, &[JValue::Object(&jpath)])?;
        let obj = value.l()?;
        if obj.as_raw().is_null() {
            return Ok(Ok(()));
        }
        let code = env.cast_local::<JString>(obj)?.try_to_string(env)?;
        Ok(Err(code))
    })?;
    outcome
}

/// 发起安装。`Ok(())` = `PackageInstaller` 会话已提交（系统确认框即将出现，**不代表已装完**）；
/// `Err(code)` = 具名原因（PERMISSION_REQUIRED / FILE_MISSING / ...）。
pub fn install(path: &str) -> Result<(), String> {
    let outcome = with_installer(|env, class| -> jni::errors::Result<Result<(), String>> {
        let jpath = env.new_string(path)?;
        let (name, sig) = kotlin_method!("install", "(Ljava/lang/String;)Ljava/lang/String;");
        let value = env.call_static_method(class, name, sig, &[JValue::Object(&jpath)])?;
        let obj = value.l()?;
        if obj.as_raw().is_null() {
            return Ok(Ok(()));
        }
        let code = env.cast_local::<JString>(obj)?.try_to_string(env)?;
        Ok(Err(code))
    })?;
    outcome
}

/// 是否已获得「安装未知来源应用」权限。
pub fn can_install() -> Result<bool, String> {
    with_installer(|env, class| -> jni::errors::Result<bool> {
        let (name, sig) = kotlin_method!("canInstall", "()Z");
        let value = env.call_static_method(class, name, sig, &[])?;
        Ok(value.z()?)
    })
    .map_err(|e| format!("权限检查失败：{e}"))
}

/// 打开「安装未知来源应用」设置页（用户返回后由 `onActivityResult` 回报结果）。
pub fn open_settings() -> Result<(), String> {
    with_installer(|env, class| -> jni::errors::Result<()> {
        let (name, sig) = kotlin_method!("openSettings", "()V");
        env.call_static_method(class, name, sig, &[])?;
        Ok(())
    })
}
