package com.gosslan.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * 局域网通道开着时的**前台服务**（见 `docs/adr/0022-android-background-messaging-commitment.md`）。
 *
 * ## 它守的是什么
 * Gosslan 收消息靠三样东西常驻：UDP 发现（组播/广播）、TCP 监听、Gossip 洪泛。
 * 安卓在应用退到后台后会把进程放进 cached 档并**回收它的 socket**（各家 ROM 更激进），
 * 于是"锁屏后就收不到消息"。前台服务是系统给应用的唯一正当出口：进程升到
 * `foreground` 优先级，socket 才有人守。
 *
 * ## 生命周期只有一个开关：局域网通道
 * `network::start()` 成功 ⇒ [start]；`network::stop()` ⇒ [stop]。
 * 服务不做任何"要不要跑"的自主判断，也不在用户按过「停止后台连接」后自己复活 ——
 * 引入第二个状态机就是给自己造"界面显示开着、实际没在跑"那类故障。
 *
 * ## 类型为什么是**两个**
 * API 34 要求声明的 `foregroundServiceType` 与**实际做的事**相符：
 * · `remoteMessaging` —— 收对端消息就是它的定义用途；
 * · `connectedDevice` —— 同一条通道上还挂着蓝牙链路（ADR-0015 的外设角色）。
 * 只报一个，系统在真实用途上会判"不符"。
 *
 * ## 为什么所有对外读数都带失败码
 * 前台服务的失效**全是静默的**：类型权限缺件、Android 12+ 从后台启动被拒、通知权限被撤。
 * 这些都不会让服务崩，只会让它**不存在** —— 而"锁屏后收不到消息"没有任何日志线索。
 * 所以这里每个出口都把原因归一成机器码，经 JNI 交给 `RuntimeDiag` 那一行读数
 * （Rust 侧 `android_background::diag()`，界面在诊断面板）。
 */
class BackgroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // 用户在通知里按了「停止后台连接」：这是明确的意图，本次进程内不许复活。
            // 返回 START_NOT_STICKY：即使随后进程被杀，系统也不会重建这个服务。
            Log.i(TAG, "收到停止动作：用户在通知里明确关闭后台连接")
            stopSelf()
            return START_NOT_STICKY
        }
        enterForeground()
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        appliedTypes = 0
        Log.i(TAG, "服务销毁")
        super.onDestroy()
    }

    /**
     * 拿到前台地位。
     *
     * 逐级回退而不是"一次成功或放弃"：API 34 上类型必须显式给（给 0 会被拒），
     * 而 29–33 上类型是可选的 —— 所以候选表按系统版本给，每级都留下机器码。
     */
    private fun enterForeground() {
        ensureChannel()
        val notification = buildNotification()
        val candidates = when {
            Build.VERSION.SDK_INT >= 34 -> listOf(
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
            )

            Build.VERSION.SDK_INT >= 29 -> listOf(
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
                0,
            )

            else -> listOf(0)
        }
        for (mask in candidates) {
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, mask)
                running = true
                appliedTypes = mask
                lastErrorCode = null
                Log.i(TAG, "已进入前台（类型位=$mask）")
                return
            } catch (e: Exception) {
                lastErrorCode = "FG_$mask" + "_" + classify(e)
                Log.w(TAG, "startForeground 被拒（类型位=$mask）：${e.javaClass.name}: ${e.message}")
            }
        }
        // 全部候选都被拒：服务还活着但没有前台地位 ⇒ 读数会报 running=false，界面那行能看见
        running = true
        appliedTypes = 0
    }

    private fun buildNotification(): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            // FLAG_IMMUTABLE：Android 12+ 对未声明可变性的 PendingIntent 直接抛异常，
            // 而这条通知常驻 ⇒ 崩的时机是"锁屏后再收到消息"这种最难复现的时刻。
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, BackgroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.bg_notif_title))
            .setContentText(getString(R.string.bg_notif_text))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openApp)
            .addAction(0, getString(R.string.bg_notif_stop), stop)
            .build()
    }

    /** 低优先级渠道：常驻通知不许响、不许震动，但它必须在（系统强制）。 */
    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.bg_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.bg_channel_desc)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "GosslanBG"
        private const val CHANNEL_ID = "gosslan_background"
        private const val NOTIFICATION_ID = 4_2_1
        private const val ACTION_STOP = "com.gosslan.app.action.STOP_BACKGROUND"

        @Volatile
        private var appContext: Context? = null

        @Volatile
        private var running = false

        /** 实际生效的前台服务类型位；0 = 还没拿到前台地位。 */
        @Volatile
        private var appliedTypes = 0

        /**
         * 最近一次失败的机器码（`FG_<类型位>_<异常名>` / `START_*` / `NO_CONTEXT`）；null = 没有失败。
         *
         * ⚠️ 属性名不许与对外的 `fun lastStartError()` 同名：Kotlin 的属性与函数在同一个作用域里
         * 共用一套名字，同名会让"返回字段"读起来像"函数返回自己"，而 JVM 那边是两个不同的条目 ——
         * 这类形状改一次就查一次，别留给下一个人猜。
         */
        @Volatile
        private var lastErrorCode: String? = null

        /** 由 `MainActivity.onCreate` 调用：存下 applicationContext 并把 JVM 句柄交给 Rust。 */
        @JvmStatic
        fun bootstrap(context: Context) {
            appContext = context.applicationContext
            try {
                nativeAttachBackground()
            } catch (e: UnsatisfiedLinkError) {
                // 理论上不会发生（这个 native 无条件编译进库），但绝不能崩在启动路径上
                Log.i(TAG, "后台服务桥不可用：${e.message}")
            }
        }

        /**
         * Rust（`network::start()`）唯一的启动入口。
         *
         * @return 系统是否接受了这次启动请求。**接受 ≠ 已拿到前台地位** —— 后者只看
         *         [foregroundTypes] 是否非 0，两者不一致就是"后台启动被拒"这一类，
         *         诊断那一行会把它们并排显示。
         */
        @JvmStatic
        fun start(): Boolean {
            val ctx = appContext ?: run {
                lastErrorCode = "NO_CONTEXT"
                Log.w(TAG, "start 被拒：bootstrap 还没跑过（MainActivity 未创建）")
                return false
            }
            return try {
                ContextCompat.startForegroundService(
                    ctx,
                    Intent(ctx, BackgroundService::class.java),
                )
                lastErrorCode = null
                true
            } catch (e: Exception) {
                // Android 12+：从后台调 startForegroundService 会抛
                // ForegroundServiceStartNotAllowedException（IllegalStateException 的子类）。
                // 不判类名再分派 —— 按异常名归类交给 Rust 侧，界面读数里看得见。
                lastErrorCode = "START_" + classify(e)
                Log.w(TAG, "startForegroundService 被拒：${e.javaClass.name}: ${e.message}")
                false
            }
        }

        @JvmStatic
        fun stop(): Boolean {
            val ctx = appContext ?: return false
            // stopService 会让系统销毁服务并移除常驻通知，用户按「停止」走的也是这条路
            return ctx.stopService(Intent(ctx, BackgroundService::class.java))
        }

        @JvmStatic
        fun isRunning(): Boolean = running

        @JvmStatic
        fun foregroundTypes(): Int = appliedTypes

        @JvmStatic
        fun lastStartError(): String? = lastErrorCode

        /**
         * 异常 → 机器码。
         *
         * `ForegroundServiceStartNotAllowedException` 是 API 31 才有的类，直接 `catch` 它要带
         * 版本门（否则 lint 在低版本判定为不可达）。这里按**类名尾段**归一成固定码，
         * 低版本上拿不到这个类也不会出问题。
         */
        private fun classify(e: Exception): String {
            val name = e.javaClass.simpleName
            return when {
                name.endsWith("ForegroundServiceStartNotAllowedException") -> "NOT_ALLOWED_BG"
                e is SecurityException -> "PERMISSION"
                else -> name
            }
        }
    }
}

/** Kotlin → Rust：把 JavaVM 与 `BackgroundService` 类引用交给 Rust（见 android_background.rs）。 */
external fun nativeAttachBackground()
