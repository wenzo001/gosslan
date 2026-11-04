package com.gosslan.app

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileInputStream
import java.lang.ref.WeakReference
import java.security.MessageDigest

/**
 * 安卓应用内升级的安装端（Rust 经 JNI 调这里）。
 *
 * 选型：PackageInstaller 会话（现代 API，能拿到精确状态与失败码）+ 系统确认界面。
 * 为什么不静默安装：普通应用没有 `INSTALL_PACKAGES` 系统权限；用户必须亲自在系统
 * 安装器里确认，这不是"做得不彻底"，而是 Android 的安全模型。
 *
 * 状态口径（与 Rust 的 installStep 对齐）：
 *  · 写会话（Rust 已先发 preparing）
 *  · session.commit() → Rust 发 launching
 *  · STATUS_PENDING_USER_ACTION → nativeOnInstallStage(1) → Rust 发 waiting-user
 *  · STATUS_SUCCESS / FAILURE_ABORTED / 其它 → nativeOnInstallResult(...)
 *
 * ⚠️ 非显然点：
 * 1. PendingIntent 必须 `FLAG_MUTABLE`（Android 12+），否则系统安装器无法写入
 *    EXTRA_STATUS / EXTRA_INTENT，回调永远等不到。
 * 2. 动态注册接收器（而不是清单静态注册）避免 Android 12+ 的 exported 语义歧义；
 *    API 33+ 要显式 `RECEIVER_NOT_EXPORTED`。
 * 3. `REQUEST_INSTALL_PACKAGES` 只是"可以申请"，Android 8+ 还要逐应用授权；
 *    `canRequestPackageInstalls()` 为 false 时只能把用户送到设置页。
 * 4. 安装失败/取消要保留已校验的 APK，用户才能"重试安装"而不必重新下载。
 */
object ApkInstaller {
    private var appContext: Context? = null
    private var activityRef: WeakReference<Activity>? = null
    private var activeReceiver: InstallResultReceiver? = null

    private const val TAG = "ApkInstaller"
    private const val ACTION_RESULT = "com.gosslan.app.APK_INSTALL_RESULT"
    private const val REQ_INSTALL_UI = 1102
    private const val REQ_PERMISSION = 1103

    @JvmStatic
    fun bootstrap(activity: Activity) {
        appContext = activity.applicationContext
        activityRef = WeakReference(activity)
        try {
            nativeAttachApkInstaller()
        } catch (e: UnsatisfiedLinkError) {
            Log.w(TAG, "nativeAttachApkInstaller 不可用", e)
        }
    }

    /** Android 8+：是否已允许本应用安装未知来源应用。 */
    @JvmStatic
    fun canInstall(): Boolean {
        val context = appContext ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    /**
     * 安装前检查：能否解析、包名是否一致、签名是否与已安装应用一致、版本是否不降级。
     * 返回 null = 通过；否则返回具名错误码（Rust 再翻译成用户话术）。
     */
    @JvmStatic
    fun inspect(path: String): String? {
        val context = appContext ?: return "APP_NOT_READY"
        val file = File(path)
        if (!file.exists()) return "FILE_MISSING"
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        @Suppress("DEPRECATION")
        val archive = pm.getPackageArchiveInfo(path, flags) ?: return "PARSE_FAILED"
        if (archive.packageName != context.packageName) return "WRONG_PACKAGE"

        @Suppress("DEPRECATION")
        val installed = pm.getPackageInfo(context.packageName, flags)

        val archiveCode = versionCode(archive)
        val installedCode = versionCode(installed)
        if (archiveCode < installedCode) return "DOWNGRADE"

        val archiveCerts = certificateDigests(archive)
        val installedCerts = certificateDigests(installed)
        if (archiveCerts.isEmpty() || installedCerts.isEmpty()) return "SIGNATURE_CHECK_UNAVAILABLE"
        if (archiveCerts != installedCerts) return "SIGNATURE_MISMATCH"
        return null
    }

    /**
     * 发起安装。返回 null = 会话已提交/已唤起安装器（**不代表装完**）；
     * 其它 = 具名错误码。
     */
    @JvmStatic
    fun install(path: String): String? {
        val context = appContext ?: return "APP_NOT_READY"
        if (!canInstall()) {
            openSettings()
            return "PERMISSION_REQUIRED"
        }
        inspect(path)?.let { return it }

        return try {
            installWithPackageInstaller(context, path)
        } catch (t: Throwable) {
            Log.w(TAG, "PackageInstaller 失败，回退到 ACTION_INSTALL_PACKAGE", t)
            installWithLegacyIntent(path)
        }
    }

    private fun installWithPackageInstaller(context: Context, path: String): String? {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        try {
            val apk = File(path)
            FileInputStream(apk).use { input ->
                session.openWrite("base.apk", 0, apk.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }
            val receiver = InstallResultReceiver()
            activeReceiver = receiver
            registerReceiver(context, receiver)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val resultIntent = Intent(ACTION_RESULT).setPackage(context.packageName)
            val pending = PendingIntent.getBroadcast(context, 0, resultIntent, flags)
            session.commit(pending.intentSender)
            return null
        } catch (t: Throwable) {
            finishReceiver()
            try {
                session.abandon()
            } catch (ignored: Throwable) {
                Log.w(TAG, "放弃安装会话失败", ignored)
            }
            throw t
        } finally {
            session.close()
        }
    }

    /**
     * 兼容兜底：极少数 ROM 上 PackageInstaller 会话不可用。
     * 这条路径用 `ACTION_INSTALL_PACKAGE`，它会把结果送进 `onActivityResult`，
     * 因此用户取消能回到"未安装"而不是卡住。
     */
    // `ACTION_INSTALL_PACKAGE` 自 API 26 起被标记 deprecated，但它正是这条**兼容兜底**
    // 要用的东西：会话路径不可用时只有它还能把结果送回 `onActivityResult`。
    // 换 `ACTION_VIEW` 会变成"打开文件"而不是"装应用"，行为不一样，不改。
    @Suppress("DEPRECATION")
    private fun installWithLegacyIntent(path: String): String? {
        val context = appContext ?: return "APP_NOT_READY"
        val activity = activityRef?.get() ?: return "INSTALLER_UNAVAILABLE"
        return try {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                File(path),
            )
            val intent = Intent(Intent.ACTION_INSTALL_PACKAGE)
                .setData(uri)
                .putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.runOnUiThread {
                activity.startActivityForResult(intent, REQ_INSTALL_UI)
            }
            null
        } catch (t: Throwable) {
            Log.w(TAG, "ACTION_INSTALL_PACKAGE 也不可用", t)
            "INSTALLER_UNAVAILABLE"
        }
    }

    /** 打开「安装未知来源应用」设置页；用户返回时由 MainActivity → onActivityResult 回报。 */
    @JvmStatic
    fun openSettings() {
        val context = appContext ?: return
        val activity = activityRef?.get()
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        )
        try {
            if (activity != null) {
                activity.runOnUiThread {
                    activity.startActivityForResult(intent, REQ_PERMISSION)
                }
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "无法打开未知来源安装设置", t)
            nativeOnPermissionResult(false)
        }
    }

    /** MainActivity.onActivityResult 的唯一入口。 */
    @JvmStatic
    fun onActivityResult(requestCode: Int, resultCode: Int) {
        when (requestCode) {
            REQ_PERMISSION -> nativeOnPermissionResult(canInstall())
            REQ_INSTALL_UI -> when (resultCode) {
                Activity.RESULT_OK -> nativeOnInstallResult(0, null)
                Activity.RESULT_CANCELED -> nativeOnInstallResult(1, null)
                else -> nativeOnInstallResult(2, "INSTALL_FAILED")
            }
        }
    }

    private fun registerReceiver(context: Context, receiver: BroadcastReceiver) {
        val filter = IntentFilter(ACTION_RESULT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(receiver, filter)
        }
    }

    private fun unregisterReceiver(context: Context, receiver: BroadcastReceiver) {
        try {
            context.unregisterReceiver(receiver)
        } catch (t: Throwable) {
            Log.w(TAG, "注销安装结果接收器失败", t)
        }
    }

    private fun finishReceiver() {
        val context = appContext
        val receiver = activeReceiver
        if (context != null && receiver != null) {
            unregisterReceiver(context, receiver)
        }
        activeReceiver = null
    }

    private fun versionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }

    @Suppress("DEPRECATION")
    private fun certificateDigests(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners ?: info.signingInfo?.signingCertificateHistory
        } else {
            info.signatures
        } ?: return emptySet()
        val digest = MessageDigest.getInstance("SHA-256")
        return signatures.map { signature ->
            digest.reset()
            digest.digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    private class InstallResultReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val status = intent.getIntExtra(
                PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE,
            )
            when (status) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    nativeOnInstallStage(1)
                    @Suppress("DEPRECATION")
                    val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                    launchConfirmation(confirm)
                }
                PackageInstaller.STATUS_SUCCESS -> {
                    finishReceiver()
                    nativeOnInstallResult(0, null)
                }
                PackageInstaller.STATUS_FAILURE_ABORTED -> {
                    finishReceiver()
                    nativeOnInstallResult(1, null)
                }
                else -> {
                    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                        ?: "INSTALL_FAILED_$status"
                    finishReceiver()
                    nativeOnInstallResult(2, message)
                }
            }
        }

        private fun launchConfirmation(confirm: Intent?) {
            if (confirm == null) {
                finishReceiver()
                nativeOnInstallResult(2, "INSTALL_FAILED_CONFIRMATION_MISSING")
                return
            }
            val context = appContext ?: return
            val activity = activityRef?.get()
            if (activity != null) {
                activity.runOnUiThread { activity.startActivity(confirm) }
            } else {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(confirm)
            }
        }
    }
}

external fun nativeAttachApkInstaller()
external fun nativeOnInstallResult(resultCode: Int, message: String?)
external fun nativeOnInstallStage(stage: Int)
external fun nativeOnPermissionResult(granted: Boolean)
