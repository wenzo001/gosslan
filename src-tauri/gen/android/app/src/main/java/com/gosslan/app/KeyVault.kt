package com.gosslan.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android Keystore：把 RP 绑定私钥封进系统密钥库。
 *
 * ## 为什么在这里做，而不是从 Rust 直调 `javax.crypto`
 *
 * 直调要写十几段 class 查找与对象构造（`KeyStore` → `KeyGenerator` → `KeyGenParameterSpec`
 * → `Cipher` → `GCMParameterSpec`），每一段都要自己管 JNI 的引用与异常；
 * Kotlin 侧只要几十行，而且仓库既有惯例就是「Kotlin 做平台活、Rust 只调一个静态方法」
 * （见 [OpenWith]、[BlePeripheral]）。Rust 侧见 `src-tauri/src/rp_key_store/keystore_android.rs`。
 *
 * ## 密钥本身
 *
 * - 一把 **AES-256-GCM** 密钥，生成在 `AndroidKeyStore` 里（多数设备在 TEE/安全区，
 *   **不可导出** ⇒ 拿到密文也没用，攻击者必须在本机上调 Keystore 才能解开）；
 * - `setUserAuthenticationRequired(false)`：不绑生物识别 —— 绑了的话，
 *   未解锁手机时整个授权流程会失败，而这不是用户能理解的失败；
 * - 不做「设备绑定」之外的自定义派生：Keystore 自己的密钥已经绑在设备上了。
 *
 * ## 载荷格式
 *
 * ```text
 * [1 字节 iv 长度][iv][密文+GCM 认证标签]
 * ```
 *
 * 整段 base64（标准字母表、无换行）后交给 Rust；Rust 再把它塞进信封
 * （`gsk1.aks.<base64url>`，见 `src-tauri/src/rp_key_store.rs`）。
 *
 * ## 失败语义
 *
 * 任何一步失败都**返回 null**（Rust 侧转成错误上抛）：绝不能「返回原文」——
 * 那等于把私钥明文写回数据库。
 */
object KeyVault {
  /** Keystore 提供者（系统内置，不可替换）。 */
  private const val PROVIDER = "AndroidKeyStore"

  /** 密钥别名。与 Rust 侧 `KEY_ALIAS` 必须一致。 */
  const val ALIAS = "gosslan_rp_secret_v1"

  /** 变换：AES/GCM/NoPadding（GCM 自带认证标签，不需要 padding）。 */
  private const val TRANSFORMATION = "AES/GCM/NoPadding"

  /** GCM 初始向量长度（字节）。Android Keystore 默认 12。 */
  private const val IV_LENGTH = 12

  /** GCM 认证标签长度（位）。 */
  private const val TAG_BITS = 128

  /**
   * `MainActivity.onCreate` 调用：把 JavaVM 交给 Rust（Rust 才能 attach 线程调本对象）。
   *
   * 必须在 App 代码还在栈上时做 —— JNI 的 `FindClass` 依赖调用方的类加载器。
   */
  @JvmStatic
  fun bootstrap(context: android.content.Context) {
    try {
      nativeAttachKeyVault()
    } catch (e: UnsatisfiedLinkError) {
      // 理论上不会发生（这个 native 无条件编译进库），但绝不能崩在启动路径上
      Log.i("GosslanKeyVault", "密钥库桥不可用：${e.message}")
    }
  }

  /**
   * 封装：[plaintext] → base64 载荷。**失败返回 null**（绝不返回原文）。
   */
  @JvmStatic
  fun sealSecret(alias: String, plaintext: String): String? {
    return try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.ENCRYPT_MODE, secretKey(alias))
      val iv = cipher.iv
      val cipherText = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
      val out = ByteArray(1 + iv.size + cipherText.size)
      out[0] = iv.size.toByte()
      System.arraycopy(iv, 0, out, 1, iv.size)
      System.arraycopy(cipherText, 0, out, 1 + iv.size, cipherText.size)
      Base64.encodeToString(out, Base64.NO_WRAP)
    } catch (t: Throwable) {
      Log.w("GosslanKeyVault", "封装失败：${t.javaClass.simpleName} ${t.message}")
      null
    }
  }

  /**
   * 解封：base64 载荷 → 明文。**失败返回 null**。
   */
  @JvmStatic
  fun openSecret(alias: String, payload: String): String? {
    return try {
      val raw = Base64.decode(payload, Base64.NO_WRAP)
      if (raw.size < 2) {
        Log.w("GosslanKeyVault", "载荷太短：${raw.size} 字节")
        return null
      }
      val ivLen = raw[0].toInt() and 0xFF
      if (ivLen <= 0 || raw.size < 1 + ivLen) {
        Log.w("GosslanKeyVault", "载荷里的 iv 长度不对：$ivLen")
        return null
      }
      val iv = raw.copyOfRange(1, 1 + ivLen)
      val cipherText = raw.copyOfRange(1 + ivLen, raw.size)
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(
        Cipher.DECRYPT_MODE,
        secretKey(alias),
        GCMParameterSpec(TAG_BITS, iv)
      )
      String(cipher.doFinal(cipherText), Charsets.UTF_8)
    } catch (t: Throwable) {
      // ⚠️ 这里最常见的失败是「密钥被系统清掉了」（换机恢复、用户清除数据、
      // 系统因安全原因重置 Keystore）⇒ 解不开就是解不开，**不许**回落成明文。
      Log.w("GosslanKeyVault", "解封失败：${t.javaClass.simpleName} ${t.message}")
      null
    }
  }

  /**
   * 取（或先生成）密钥。
   *
   * 已存在就直接用 —— **不覆盖**：覆盖会让已封存的密文全部解不开。
   */
  private fun secretKey(alias: String): SecretKey {
    val store = KeyStore.getInstance(PROVIDER)
    store.load(null)
    val existing = store.getKey(alias, null)
    if (existing is SecretKey) return existing
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
    generator.init(
      KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setUserAuthenticationRequired(false)
        .build()
    )
    return generator.generateKey()
  }
}

/** Kotlin → Rust：把 JavaVM 交给 Rust（见本文件顶部注释）。 */
external fun nativeAttachKeyVault()
