//! Android 后端：**Android Keystore**（AES-256-GCM，密钥在 TEE、不可导出）。
//!
//! 真正的加解密在 Kotlin 侧（`gen/android/app/src/main/java/com/gosslan/app/KeyVault.kt`），
//! Rust 这里只做两件事：把 JavaVM 与类引用接过来、按名字调两个静态方法。
//! 为什么不在 Rust 里直调 `javax.crypto`：那要写十几段 class 查找与对象构造，
//! 而仓库既有惯例就是「Kotlin 做平台活、Rust 只调一个静态方法」
//! （见 `android_open.rs` / `android_background.rs` / `android_apk_install.rs`）。
//!
//! ⚠️ 与其它桥同源的三个坑：
//! ① `native_attach_key_vault` 必须注册成 **static**（Kotlin 侧是**顶层**函数 ⇒ 编译进
//!    `KeyVaultKt` 的静态方法）；写成实例方法会让 ART 在第一次调用时直接 abort 进程。
//! ② 描述符写错只在真机运行期抛 `NoSuchMethodError` ⇒ 由
//!    `lib_android_jni_tests.rs::android_jni_signatures_match_kotlin` 逐字钉住。
//! ③ release 包的 R8 会改名 ⇒ 必须写进 `scripts/android/proguard-gosslan.pro` 的 keep 块。

use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use jni::objects::{Global, JClass};
use jni::vm::JavaVM;
use jni::{jni_sig, jni_str, native_method, Env, JValue, NativeMethod};

use crate::jni_method::kotlin_method;

use super::KeyStoreError;

/// Keystore 里的密钥别名（必须与 Kotlin 侧 `KeyVault.ALIAS` 一致）。
const KEY_ALIAS: &str = "gosslan_rp_secret_v1";

/// JVM 句柄（`bootstrap` 时缓存；之后从任意线程 attach 使用）。
static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();
/// `KeyVault` 类的全局引用（业务方法都在这个 object 上，且都带 `@JvmStatic`）。
static KEY_VAULT_CLASS: OnceLock<Global<JClass<'static>>> = OnceLock::new();

/// 由 Kotlin 的 `KeyVault.bootstrap` 调用（`extern` ⇒ 宏直接导出 JNI 符号名）。
///
/// ⚠️ **必须是 `static`**：Kotlin 侧是**文件级（顶层）函数** ⇒ 编译成 `KeyVaultKt` 的
/// **static** 方法（与 `OpenWithKt` 同一形状）。宏若按「实例方法」注册，ART 会当场判定
/// 不一致并 **abort 整个进程**（真机实测的启动闪退）。
const NATIVE_ATTACH: NativeMethod = native_method! {
    java_type = "com.gosslan.app.KeyVaultKt",
    static extern fn native_attach_key_vault() -> (),
    fn = native_attach,
};

/// 桥是否已就绪（供上层给出准确提示，而不是笼统的「密钥库不可用」）。
fn ready() -> bool {
    // ⚠️ 这一行不是摆设：`NATIVE_ATTACH` 是 `native_method!` 展开出的 `const { … }` 块，
    // 块里那个 `#[export_name]` 的函数才是 JVM 要找的符号；整块常量如果**完全没人用**，
    // 就不保证被代码生成进产物 ⇒ 真机上 `nativeAttachKeyVault` 直接 UnsatisfiedLinkError。
    let _keep_exported = std::hint::black_box(&NATIVE_ATTACH);
    JAVA_VM.get().is_some() && KEY_VAULT_CLASS.get().is_some()
}

/// `KeyVault.bootstrap()`：缓存 VM 与 `KeyVault` 类引用。
fn native_attach<'local>(
    env: &mut Env<'local>,
    _kt_class: JClass<'local>,
) -> jni::errors::Result<()> {
    if JAVA_VM.get().is_none() {
        if let Ok(vm) = env.get_java_vm() {
            let _ = JAVA_VM.set(vm);
        }
    }
    if KEY_VAULT_CLASS.get().is_none() {
        // native_attach 在 bootstrap 调用链上，此时 App 类加载器在栈上 — find_class 安全
        let key_vault = env.find_class(jni_str!("com/gosslan/app/KeyVault"))?;
        let global = env.new_global_ref(key_vault)?;
        let _ = KEY_VAULT_CLASS.set(global);
    }
    Ok(())
}

/// 封装一段 UTF-8 文本（返回载荷字节）。
pub fn seal(plaintext: &[u8]) -> Result<Vec<u8>, KeyStoreError> {
    let text = std::str::from_utf8(plaintext)
        .map_err(|_| KeyStoreError::Malformed("待封装的私钥不是 UTF-8 文本".into()))?;
    let payload_b64 = call_seal(text)?;
    STANDARD
        .decode(payload_b64)
        .map_err(|e| KeyStoreError::Malformed(format!("Kotlin 返回的载荷不是 base64：{e}")))
}

/// 解开载荷字节（返回 UTF-8 文本的字节）。
pub fn open(payload: &[u8]) -> Result<Vec<u8>, KeyStoreError> {
    let payload_b64 = STANDARD.encode(payload);
    let plain = call_open(&payload_b64)?;
    Ok(plain.into_bytes())
}

/// 调 Kotlin 的 `KeyVault.sealSecret(alias, plaintext)`。
///
/// Kotlin 侧约定：**返回 null = 失败**（绝不返回原文）⇒ 这里把 null 转成错误上抛。
///
/// ⚠️ 描述符写错只在真机上抛 `NoSuchMethodError`（JNI 不做签名检查）⇒ 登记处与
/// Kotlin 源码必须逐字一致（由 `lib_android_jni_tests.rs` 的签名守卫钉住）。
fn call_seal(arg: &str) -> Result<String, KeyStoreError> {
    if !ready() {
        return Err(KeyStoreError::Backend(
            "Android 密钥库桥未初始化（MainActivity 未调用 KeyVault.bootstrap）".into(),
        ));
    }
    // ⚠️ 用 `ok_or_else` 而不是 `expect`：这条路径**不该** panic ——
    // 桥没就绪是「用户还没开应用/系统还没起」的正常状态，要给出可读的错误，
    // 不是让整个应用崩掉（panic 站点棘轮也不许因为新增文件而变大）。
    let class = KEY_VAULT_CLASS
        .get()
        .ok_or_else(|| KeyStoreError::Backend("Android 密钥库桥未就绪（类引用缺失）".into()))?;
    let vm = JAVA_VM
        .get()
        .ok_or_else(|| KeyStoreError::Backend("Android 密钥库桥未就绪（JavaVM 缺失）".into()))?;

    let outcome = vm.attach_current_thread(|env| -> jni::errors::Result<Option<String>> {
        let jalias = env.new_string(KEY_ALIAS)?;
        let jarg = env.new_string(arg)?;
        let (name, sig) = kotlin_method!(
            "sealSecret",
            "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;"
        );
        let value = env.call_static_method(
            class,
            name,
            sig,
            &[JValue::Object(&jalias), JValue::Object(&jarg)],
        )?;
        let obj = value.l()?;
        if obj.as_raw().is_null() {
            return Ok(None);
        }
        let text = env
            .cast_local::<jni::objects::JString>(obj)?
            .try_to_string(env)?;
        Ok(Some(text))
    });

    match outcome {
        Ok(Some(text)) => Ok(text),
        Ok(None) => Err(KeyStoreError::Backend(
            "Android Keystore sealSecret 失败（密钥库不可用，需要重新绑定该应用）".into(),
        )),
        Err(e) => Err(KeyStoreError::Backend(format!("JNI 调用失败：{e}"))),
    }
}

/// 调 Kotlin 的 `KeyVault.openSecret(alias, payload)`（语义同 `call_seal`）。
fn call_open(arg: &str) -> Result<String, KeyStoreError> {
    if !ready() {
        return Err(KeyStoreError::Backend(
            "Android 密钥库桥未初始化（MainActivity 未调用 KeyVault.bootstrap）".into(),
        ));
    }
    // ⚠️ 用 `ok_or_else` 而不是 `expect`：这条路径**不该** panic ——
    // 桥没就绪是「用户还没开应用/系统还没起」的正常状态，要给出可读的错误，
    // 不是让整个应用崩掉（panic 站点棘轮也不许因为新增文件而变大）。
    let class = KEY_VAULT_CLASS
        .get()
        .ok_or_else(|| KeyStoreError::Backend("Android 密钥库桥未就绪（类引用缺失）".into()))?;
    let vm = JAVA_VM
        .get()
        .ok_or_else(|| KeyStoreError::Backend("Android 密钥库桥未就绪（JavaVM 缺失）".into()))?;

    let outcome = vm.attach_current_thread(|env| -> jni::errors::Result<Option<String>> {
        let jalias = env.new_string(KEY_ALIAS)?;
        let jarg = env.new_string(arg)?;
        let (name, sig) = kotlin_method!(
            "openSecret",
            "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;"
        );
        let value = env.call_static_method(
            class,
            name,
            sig,
            &[JValue::Object(&jalias), JValue::Object(&jarg)],
        )?;
        let obj = value.l()?;
        if obj.as_raw().is_null() {
            return Ok(None);
        }
        let text = env
            .cast_local::<jni::objects::JString>(obj)?
            .try_to_string(env)?;
        Ok(Some(text))
    });

    match outcome {
        Ok(Some(text)) => Ok(text),
        Ok(None) => Err(KeyStoreError::Backend(
            "Android Keystore openSecret 失败（密钥可能已被系统清除，需要重新绑定该应用）".into(),
        )),
        Err(e) => Err(KeyStoreError::Backend(format!("JNI 调用失败：{e}"))),
    }
}
