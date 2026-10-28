# ADR-0022: 「后台可收消息」是一条**带条件的承诺**，条件写进文案，实现只做前台服务

- Status: **Accepted**（2026-10-28，用户拍板「要承诺 ⇒ 实装前台服务」）
- Date: 2026-10-28
- Owners: Gosslan
- 相关：ADR-0015（BLE 传输 —— 它的 Android 权限分档口径同本 ADR）、
  ADR-0020（公网哑管道中继 —— 后台期能否续上中继取决于本 ADR 的服务是否活着）、
  INV-P26（落盘证据态：后台期收到的文件仍走同一条台账，本 ADR 不改它的任何语义）

---

## 1. 这条承诺原本的形状是"话说过头了"

审计（`/tmp/gosslan-audit/gosslan-audit-2026-10-27-round2.md` #23）核对过：README 与设置页
在「安卓后台能不能收到消息」这件事上给的是**没有实现支撑的说法**，而
`README.md` 与 `docs/adr/0020-blind-circuit-relay.md` 两处同时写着「当前没有前台服务」。
两者不可能同时为真 ⇒ 要么文案在承诺系统不会兑现的行为，要么实现缺一整块。

用户 2026-10-28 的裁决是：**要承诺**，所以补实现；但承诺必须带条件，因为安卓的
后台策略不是应用单方面能兑现的（见 §5）。

## 2. 决策

| 决策点 | 取定的形状 | 为什么是它 |
|---|---|---|
| 服务什么时候跑 | **局域网通道开着就跑，直到用户关掉通道** | 服务的唯一职责是保住 UDP/TCP/Gossip 的监听 socket。以"通道"为开关，服务的生命周期与它守的东西完全重合，不引入第二个状态机 |
| 停服务接在哪 | **只接在两条"用户主动关通道"的命令出口**（`commands::stop_network`、`commands::set_channel_enabled("lan", false)`），**不接**在 `network::stop()` 里 | `network::start()` 的第一件事就是 `stop()`（换网卡 / 重开通道）。接在那里，每次重绑都会"销毁服务→重建"，而 Android 12+ **从后台重新拉起前台服务会被拒** —— 5s→30s 那条自动重试正好可能在后台跑 ⇒ 服务从此没了，而症状只是"锁屏后收不到消息"。落点差异由 `background_service_wiring_follows_the_lan_channel` 正反两格钉住 |
| 前台服务类型 | `remoteMessaging` **＋** `connectedDevice`（双类型） | API 34 要求声明的类型**与实际做的事**相符：收消息＝remoteMessaging，同时持有蓝牙链路＝connectedDevice。只报一个会在真实用途上被判不符 |
| 通知档位 | **低优先级**常驻通知 ＋ 通知里一条「停止后台连接」动作 | Android 8+ 强制：前台服务必须有常驻通知，那就把它做成**用户可见的开关出口**，而不是偷偷挂一条。用户能在不打开 App 的情况下停掉它 |
| 用户主动停止后 | 不自动复活（本次进程内认用户的决定） | 「停止」是用户意图，自动重启等于把用户的决定当噪声 |
| 自检 | `RuntimeDiag` 增加一行服务读数（就绪/在跑/生效类型/最近一次失败码） | 前台服务失效**全是静默的**：类型不符、后台启动被系统拒绝、通知权限被撤 —— 没有读数的话，用户说"收不到"时界面零入口 |

## 3. 落点（一处一家）

```text
MainActivity.onCreate ─► BackgroundService.bootstrap(ctx) ─► nativeAttachBackground()
                                                              └ 缓存 JavaVM + 类引用

network::start()（局域网通道起来）─► android_background::ensure_running() ─► BackgroundService.start()
stop_network / set_channel_enabled("lan", false)（用户关通道）─► android_background::stop(logger)
                                                              ─► BackgroundService.stop()
commands::get_runtime_diag()       ─► android_background::diag()          ─► running / types / lastStartError
```

⚠️ 停服务这一格**不写在 `network::stop()` 上**（理由见 §2 那一行，代码里也有同一条 ⚠️）：
两处声明一旦分叉，读文档的人会按文档去"补"那个根本不存在的接线。

- Kotlin：`src-tauri/gen/android/app/src/main/java/com/gosslan/app/BackgroundService.kt`
- Rust 桥：`src-tauri/src/android_background.rs`（非 Android 目标是三个空实现，
  这样 `network/mod.rs` 与 `commands/channel.rs` 里不出现 `#[cfg]`）
- 清单：`src-tauri/gen/android/app/src/main/AndroidManifest.xml`
  （`FOREGROUND_SERVICE` + 两个类型权限 + `<service android:foregroundServiceType>`）
- R8 keep：`scripts/android/proguard-gosslan.pro`（`gen/android` 那份只是注入副本）
- 护栏（`lib_android_jni_tests.rs`）：JNI 签名逐字对齐 / static 形态 / keep 名单双向 这三条
  都把新桥纳入分母，另加一条接线守卫 `background_service_wiring_follows_the_lan_channel`。
  **新桥不单独写一份检查，否则一定漂移**

## 4. 明确不做（以及为什么）

| 不做 | 理由 |
|---|---|
| `BOOT_COMPLETED` 开机自启 | 需要 `RECEIVE_BOOT_COMPLETED`，且系统是白名单式放行；开机就自启是"未经用户同意先占住后台"，与本 App 的定位不符 |
| 电池优化白名单（`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`） | 这是要用户去系统弹窗里点"允许"的强索取，且各家 ROM 行为不一致；等真机读数证明常驻通知不够用再谈 |
| 厂商保活（小米/华为后台限制引导） | 那是按 ROM 的运营工作，不是代码能兑现的承诺 |
| Doze 例外 / `WAKE_LOCK` 常驻 | 前台服务在 Doze 下网络仍会被限制 —— **这是 §5 那句"条件"的来源**，靠代码绕不开 |
| 断点续传的协议级前缀指纹 | 同轮审计 #24：现有 size＋`.part` 头部校验已覆盖实际故障形状，加协议字段要全端同步 ⇒ 代价大于收益，**已否证**（见 `docs/notes/stability-audit-orbit-compare-2026-10-27.md` §12） |
| 盘满真机注入 | 用户 2026-10-28 明确"真机不需要盘满注入"；归类判据走单元用例与纯函数 |

## 5. 诚实边界（文案必须带上，不许写成"永不掉线"）

1. **常驻通知是系统强制的**，不是可选装饰 ⇒ 承诺的代价是"通知栏一直有一条 Gosslan"。
2. **Android 12+（API 31）禁止从后台启动前台服务**：如果局域网通道是在应用已经退到后台后
   才自动重试成功的（`network::lan_autostart_delay` 那条 5s→30s 重试链），那一次 `start()`
   会被系统拒绝。实现按"读不到 ⇒ 放行"的反面处理：**拒绝必须留下码**，
   下一次用户把 App 切回前台并触发通道开关时才补得上。
3. **Android 13+ 通知权限被拒**时服务仍然在跑（前台服务的地位不依赖通知可见），
   但用户在通知栏看不到它，也就拿不到那条「停止」动作。
4. **Doze / 省电策略**会在设备静置一段时间后限制网络，此时服务活着但收不到东西；
   这一条只能靠文案条件化，不能靠代码保证。
5. **只覆盖局域网通道**：蓝牙通道单独开着时不起服务（决策表第 1 行的口径），
   公网中继的续上能力取决于服务是否活着（ADR-0020）。

所以对外的一句话是：**「连着同一个局域网、且没被系统强制停止时，锁屏后仍能收到消息；
代价是一条常驻通知，可在通知里直接停掉。」** —— 设置页与 README 都按这句写，不许省略条件。

## 6. 验收边界

- 本 ADR 落地的这一批只做**骨架 + 接线 + 自检读数**：服务的启停路径、通知、停止动作、
  诊断那一行。
- **真机验收由用户执行**（本机没有安卓设备，`verify:full` 的 Android 那档只
  `cargo check --target aarch64-linux-android`，不编译 Kotlin）。本机实际跑到的证据是
  **编译级**的：`bash scripts/check-mobile.sh --bluetooth`（0 warning）、
  `./gradlew :app:compileArmDebugKotlin`、`:app:compileArmReleaseKotlin`、
  `:app:processArmDebugMainManifest` —— 最后那条的**合并产物**里现读到
  `<service … foregroundServiceType="remoteMessaging|connectedDevice">` 与三个
  `FOREGROUND_SERVICE*` 权限（`POST_NOTIFICATIONS` 由通知插件带进来，同样是现读不是推断）。
  **运行时行为仍然没有证据**：通知是否显示、系统接受哪一档类型位、「停止」是否生效。
- 真机那四格读什么：① 通知栏出现「Gosslan 正在后台接收消息」；② 锁屏后对端发消息能收到；
  ③ 通知里点「停止后台连接」后通知消失且设置页诊断行变成「未运行」；
  ④ 设置 → 诊断面板那一行的 `types` 不是 0（0 = 服务活着但系统没给前台地位，
  就是 §5 那类被拒的形状，`lastError` 会带出机器码）。
  对应手动冒烟行：`docs/acceptance/stability-smoke-matrix.md` 的 Smoke-3。
