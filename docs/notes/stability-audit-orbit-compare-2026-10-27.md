# 稳定性专项审计：磁盘预检 / Android 保活 / 续传完整性 / Orbit 对照

**基线**（写本文件时，复跑即知是否已过期）：

```bash
git rev-parse --abbrev-ref HEAD && git log -1 --format='%h %s' && \
git status --porcelain | wc -l && node scripts/version.mjs show
```

本轮为**只读审计**：未改产品码/依赖/lock/DB/协议/配置，未 commit、未 push、未打 tag。
本轮**实际执行过**的验证只有三条：`npm test`、`node scripts/verify.mjs --list`、
`python3 scripts/verify-guards.py --list`。其余层为 `NOT RUN`，见第 8 节。

对照对象：`github.com/D4niel-dev/Orbit-beta`（Electron 32 + Capacitor 8，LAN P2P 聊天，
tip `e947539` = v0.9.0）。**本文件的目的不是照搬它，而是判断哪些缺口是真的。**

---

## 1. 取证范围与分母（一律现算，不留第二份手抄）

| 分母 | 复跑命令 |
|---|---|
| Rust 生产码文件数 / 行数 | `find src-tauri/src -name '*.rs' ! -name '*test*' \| wc -l` ／ 同上加 `xargs wc -l` |
| Rust 测试册数 | `find src-tauri/src -name '*_tests.rs' \| wc -l` |
| 前端 ts/vue 文件数、测试文件数 | `find src -name '*.ts' -o -name '*.vue' \| wc -l`、`find src -name '*.test.ts' \| wc -l` |
| 护栏锚点条数 | `python3 scripts/verify-guards.py --list`（条数由脚本自己打印） |
| 快速层门禁步数 | `node scripts/verify.mjs --list`（门禁第 8 步本来就按它现算对账） |
| 设置面条目 | `grep -c "<SettingsRow" / "<SettingsToggle"` 逐册相加 + `src/router/settings.ts` 的 `SETTINGS_SECTIONS` |
| IME 接线面 | 逐行判：`grep -rn "ime\.enter(" src` 后**按"该行是否带 `$event`"分类**，命中数不等于格数 |

覆盖分级：A = 读到函数体/关键分支；B = 只到签名/调用点。
本文件结论全部落在 A 级链路上；B 级只在"未证明清单"里出现。

---

## 2. 已确认问题（CONFIRMED）与已有保护

| 编号 | 结论 | 证据（现读行号） |
|---|---|---|
| C-1 | 接收/落盘前**没有任何真实磁盘余量检查**（无 `statvfs`/`GetDiskFreeSpaceExW`/预分配预留） | 全仓 `grep` 0 调用点；唯一痕迹是"刻意不做"的注释 `src-tauri/src/logging.rs:132` |
| C-2 | 盘满时用户看到**裸 OS 文本**，i18n 无可行动文案；群侧失败**不带 reason** | `src/stores/useChatStore.ts:2799`（`send.fileFail：${d.reason}`）；`group_file.rs` 的 `finalize_failed_group_receive` 只置态 |
| C-3 | **Android 无前台服务**（无 Service/startForeground/WakeLock/NetworkCallback/自研开机接收器） | 手写 Kotlin 仅 `MainActivity`/`BlePeripheral`/`LanMulticast`/`OpenWith`；模板里的 `<service>` 是注释 `scripts/android/AndroidManifest.xml:55-65`；本地注入函数见 `NEARBY_WIFI_DEVICES` 即 return ⇒ 现树恒 no-op `scripts/inject-android-signing.mjs:403`；[README.md:227](../../README.md) 却写"前台服务……CI 自动注入"；欠账本身已记于 `docs/adr/0020-blind-circuit-relay.md` |
| C-4 | **两处注释互相矛盾**：收藏目录到底进不进清理面 | `src-tauri/src/commands/channel.rs:359-361`（`media_dirs()` **含** `favorites_dir`，注释称"必须在内"）⇄ `src-tauri/src/state.rs:1181-1184`（称"不在 `media_dirs` 里，清理不会碰它"） |
| C-5 | 直连**解密失败静默 return，不留日志**（Gossip 那半有留痕） | `src-tauri/src/network/transport/handle_messaging.rs` 的 `open_direct_content` 失败分支；对照 `gossip.rs` 同名分支 |
| C-6 | **HEAD 上打 tag 发布根本不触发门禁**：`git show HEAD:.github/workflows/verify.yml` 的 `on:` 只有 `branches: ["**"]` + PR + dispatch，**没有 `tags`**；而四个 `build*.yml` 全是 `push: tags: ["v*"]` ⇒ 一个从未跑过任何测试的 commit 可以直接被发布。即便补上 tags，`verify.yml` 与 `build.yml` 仍是同事件的**并列 workflow**（发布 job 只 `needs` 构建），不阻断 | `git show HEAD:.github/workflows/verify.yml`；`build.yml:3-7`。⚠️ 审计期间另一会话已在**未提交的工作树里**给 `verify.yml` 补了 `tags: ["v*"]`，别把那条未提交改动当成 HEAD 的事实 |

**已有保护（本轮确认存在，别重复造）**：接收四入口共用一把准入闸 `file::admit_inbound`
（`receive.rs:179`/`:660`、`group_file.rs:468`、`relay_file.rs:64`，且 `file_tests.rs` 有一条
"四入口必须同闸"的判据）；末段 SHA fail-closed（含"发送方没声明哈希也判失败"）；
`.part` 24h TTL 且 prune 只认本机 UUID 命名；rename 前二次确认 `final_path.exists()` 换名；
"≥size 的磁盘前缀不算进度"；`FileReject.received` 承载真实续传位；outbox / `file_outbox` /
`group_file_acks` 三张持久队列 + 退避封顶 + 启动对账；Ed25519 握手验签 + 安全码 + 群密钥；
脱敏诊断包；IME 判定唯一份 + 判据 53；外链出口收敛且 `linkify` 只放 http(s)；
发送 socket 的 `SendCell` 探测式换绑（`discovery.rs:276-292`、`:525`、`:779`）。

---

## 3. 五个候选项：证据与不确定性

### P1 接收前磁盘余量预检 — CONFIRMED 无预检 / 风险中

链路：`FileOffer` → 好友与 `from==链路 peer` 与 sha 形状与密钥解封四道 → `decide_offer` →
`admit_inbound`（配额）→ `.part` → 逐片 `write_all` → 末 SHA → `sync_all` → rename → 双表同事务收口。
群/中继/补传共用同一把准入闸。

- **事实**：无任何卷余量查询；配额算的是"对端声明 size 之和"（`MAX_CONCURRENT_RECEIVES`、
  `MAX_INCOMING_FILE_BYTES`、`MAX_INCOMING_TOTAL_BYTES`、`MAX_RETAINED_PART_BYTES`，见
  `receive.rs:370-380`），与磁盘真实余量无关。
- **并发与竞态（子问 4/5）**：`inbound_quota_verdict` 是纯函数，`resume_receive` 刻意"哈希读完
  再判一次，且这一判与 insert 同闸"。预检放同一区域即继承该原子性；但预检本质是 TOCTOU，
  **不能替代**写失败兜底（后者现在就是完整的：写失败保留 `.part`+台账 failed+回 `Ack(false)`；
  rename 失败保留 `.part`；下一轮按整份重收，不会把半成品当完成）。
- **误删/覆盖/丢可恢复（子问 8）**：**FALSIFIED**，见第 2 节保护清单最后四条。
- **用户影响（推断，未真机）**：满盘时"跑到中途失败 + 一段 `No space left on device (os error 28)`"。
- **可复现**：是。本仓已有真实文件系统用例形状（`tempfile::TempDir`、"整个下载目录消失"用例），
  补一格 `#[cfg(unix)] chmod 0o500` 只读目录即可。
- **最小修复**：① 把 `logging.rs` 已有的 `is_disk_full`（裸码 28/112/3900/122 + 文本兜底）提为共享
  helper 并在接收失败路径复用；② `admit_inbound` 内加"目标卷余量 ≥ `size − held` + 水位"，
  **读不到余量 ⇒ 放行 + warn**（折叠方向按代价定：误拒 = 永远收不下）；③ 群侧失败补 reason；
  ④ i18n 加"释放磁盘空间后可重试"。
- **跨平台**：unix（含 Android）`libc::statvfs`——`libc` 已在 lock 里但只在 macOS 段声明，需扩 cfg；
  Windows 用已直接依赖的 `windows-sys`，加 `Win32_Storage_FileSystem`，且命名空间必须逐个开 feature
  （有判据钉住：`lib_startup_config_tests.rs` 的"用到的命名空间都必须声明"）。
- **与 INV 的边界**：`admit_inbound` 现被 async 路径同步调用，而 INV-P34 规定 GB 级慢活只许在阻塞
  线程池 ⇒ 落地时必须先定"一次 `statvfs` 算不算慢活"，写进该 INV 或其新增条目（含 `- 钩子：` 与
  `- 反向：` 两段，否则门禁第 3 步不认）。
- 成本：小。回归风险：中（误拒会致"永远收不到文件"），故必须带"读不到就放行"那一格反例。
- **需要用户决策：否。**

### P2 Android 后台保活与电池优化 — CONFIRMED 未实装 / 风险中

- **事实**：无 Service 类；`LanMulticast.kt` 在 `MainActivity.onCreate` 取组播锁并**整前台期持有**；
  `compileSdk = targetSdk = 36`、`minSdk = 24`；Rust 侧只处理 `RunEvent::Exit`/`Reopen`，
  network/discovery 里 `cfg(target_os = "android")` 只出现在 BLE；电池豁免全仓 0 命中。
- **换网不自愈？——已被否证**：发送 socket 在 `SendCell` 里可换，广播循环在"这轮一个都没回"时
  `reprobe_send_socket` + `plan_send_rebind` 换绑并留痕，**手动模式刻意不换**。
  所以缺口收窄为：**进程被回收/挂起后没有任何东西把它叫醒**（无服务、无开机自启）。
- **清单/代码接线差额**：`POST_NOTIFICATIONS`、`WAKE_LOCK`、`BOOT_COMPLETED` 由
  tauri-plugin-notification 2.4.0 的合并清单带来（只为它自己的定时通知服务，不是保活）；
  生效清单里没有 `FOREGROUND_SERVICE*`；模板 `permissions.xml` 里有这两条但注入路径在现树恒 no-op。
- **目标版本风险**：API34 起前台服务**必须**声明类型且需与该服务真实工作匹配；API35 起
  后台启动前台服务受限 ⇒ "开机后/后台把它拉起来"这条路本身就有平台限制。
- **服务类型判断（不照搬 Orbit）**：Gosslan 的后台工作是"P2P 收消息 + 局域网发现 + BLE 被连"。
  `dataSync` 的准入理由（同步/备份/会话转发）与它不符；`remoteMessaging` 最贴"实时收消息"这一条，
  `connectedDevice` 只覆盖 BLE 那一半。默认推荐：**`remoteMessaging` 为主、`connectedDevice` 为辅**，
  并只在"会收消息"的窗口内持有，退出即停。
- **不做**：`BOOT_COMPLETED` 自启、`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 白名单（商店政策 +
  国内 OEM 不可控，且承诺不了"永久保活"）。
- **未知（需真机）**：合并后的真实清单、`Rust.pause()` 是否冻结事件循环、各家 OEM 杀进程时点、
  后台通知可达性。
- 成本：中-大（Kotlin 服务 + JNI 启停 + 通知渠道归属 + Rust 生命周期接线）。
- **需要用户决策：是**（是否对外承诺"后台可收消息"）。

### P3 断点续传前缀指纹 — LIKELY（浪费一轮，不产生错文件）/ 风险低

恢复时到底验了什么：`.part` 存在且是文件、`meta.len() == from_bytes`、`0 < from_bytes ≤ size`、
24h TTL；**前缀内容不比**。但接收端**本来就把整个 `.part` 分块喂进 SHA-256**（播种 hasher），
且这一步专门为它走 `spawn_blocking`（注释还写了吞吐实测 ≈1 GB/s 与为什么不能留在 async 上）。

- **子问 2**：同 `transfer_id`、同长度、不同内容 ⇒ **能进续传**（`file_transfers` 无 cid 列，
  1:1 侧没有"这份 `.part` 属于哪个内容"的记录；群侧有——`group_resume.rs::prefix_usable` 比
  size+sha）。后果不是收错文件，而是**整份白传后**末 SHA 判死并删 `.part`。
- **子问 3**：协议只有整份 `file_sha256` + `sealed_file_key` + attempt 轮次，**无分片/前缀哈希**。
- **子问 4（真正该补的）**：大小不符与 SHA 不符都返回**同一条固定文案**"文件传输未完成/
  文件完整性校验失败"，且 SHA 分支自身**不打印 actual/expected/是否续传而来** ⇒ 不可归因。
- **子问 5**：历史真机那两格"校验失败"根因是**喂哈希的位置**不对（已修，有测试），
  **不是**"前缀属于另一份内容" ⇒ 无故障证据支撑协议改动。
- **子问 6/7（成本与替代）**：加前缀摘要需发送端整读前缀——但发送端每轮**本来就整读一遍**算
  `file_sha256`（`send.rs:67`），所以增量成本近零；**不需要新字段的最小替代**是：拿
  `content_transfers` 里同一 `transfer_id` 已登记的 `cid` 与新 Offer 的 `file_sha256` 比，
  不等 ⇒ 判 Restart（群侧同形状已有实现与用例）。代价是一条按 `transfer_id` 的查询（当前无索引）。
- **判定**：补可诊断日志 + 上述"内容身份"判据 = **建议直接修复**；
  新增协议字段做端到端前缀指纹 = **暂不处理**（跨版本兼容要能力位，收益不抵成本）。
- **需要用户决策：仅当**选择给 `content_transfers.transfer_id` 加索引（属迁移）。

### P4 在线状态形状 — 基本 FALSIFIED，剩一格可访问性 / 风险低

模型是三态（`ConversationListItem.vue` 的 `online: boolean | null`，null 不画角标 ⇒
**没有"未知当离线"**）；离线另有整头像 `grayscale opacity-70` 的第二通道；资料页是"点 + 文字"药丸；
口径唯一份在 `src/utils/friendOnline.ts`（含一段"某一层其实恒为冗余，别以为它在兜什么"的自我更正）。
`docs/design-guidelines.md` 的"不允许只用颜色"写在**选中态/导航**那一节，未覆盖状态点，也无判据。

- **真实残余**：会话行的 `rowAriaLabel` 只含未读/@/待办，**不含在线/离线** ⇒ 读屏拿不到。
- **最小修复**：`rowAriaLabel` 增一段（复用既有 `common.online`/`common.offline`），
  可选把离线角标改成空心环（沿用现有 token，不重做状态体系、不引入"月亮"这类新图形）。
- 成本：极小。**需要用户决策：否。**

### P5 设置搜索 / 诊断入口前移 — 体验候选，非稳定性缺陷

设置面量级：`SETTINGS_SECTIONS` 11 个键（含折叠的 `storageFiles` 二级页）、命名项 =
`SettingsRow` + `SettingsToggle`（现算 34 条）。这个量级下搜索的边际收益弱，
且 Orbit 自己也只有移动端有。**默认推荐：暂不实现**；若做只做"过滤 + 跳节 + 高亮"，不建索引不引依赖。

诊断侧**已覆盖，不重复实现**：NavRail 有普通用户可达的日志窗（复制全部 / 复制路径 /
**导出脱敏诊断包**），脱敏是形状级（设备指纹/对端 id/局域网 IP），命中处数回显给用户，
文件名与大小刻意保留并写在包头部（`src-tauri/src/diagnostics.rs` 模块注释）；
DevDiagPanel 是"连点设备指纹 7 次"的开发者入口，属有意分层。唯一真缺口 = P1 的"失败原因不可行动"。

---

## 4. Orbit 反向清单 → Gosslan 逐条（12 条）

| # | 标签 | 一句结论（证据） |
|---|---|---|
| 1 | 已有保护 / 残余 LIKELY | Ack 才删队列行、落库 `Err` 绝不回 Ack；120s 无 Ack 落 failed。残余：对端离线保留期内一直显示"发送中"，没有"待补发"这一格 |
| 2 | 已有保护 | 启动对账把"无队列行的 sending"落终态（刻意排除 `file-`/`gfile-`）；群 ACK 有跨进程账本 + 重放 |
| 3 | 已有保护 + C-5 | 解不开 ⇒ 不落库不 Ack ⇒ 由 outbox 续发（设计有据，防"占位吃掉真 msg_id"）；缺的是这一臂的日志 |
| 4 | FALSIFIED（口径重算过） | 分段渲染不拼 HTML；`ime.enter(` 命中的行里**不带 `$event` 的 4 处全部落在守卫自身与判据夹具** ⇒ 真实模板位全部接线；判据 53 在守 |
| 5 | CONFIRMED（有意，挂待拍板） | Hello 签名载荷不含昵称；`friends` 覆盖式写 ⇒ 昵称/头像/设备型/IP/端口"自报即采信"；密钥身份是严格的（`keys_verified`、只填空、冲突不换） |
| 6 | FALSIFIED | SQL `LIMIT/OFFSET` + 1000 条/会话 + 8 会话 LRU + 虚拟列表；已知遗留：活跃会话实时追加无条数上界（代码自述） |
| 7 | FALSIFIED | 直连/中继/接收三处都逐片读，且留着"原先整读已修"的注释 |
| 8 | 已有保护 | 文件 offer 校验好友 + `from==链路 peer`；非成员不消费群信封、拿不到群密钥；改群名/移人仅 creator |
| 9 | FALSIFIED | 同第 4 条（判定唯一份 + 分母判据） |
| 10 | FALSIFIED | 外链出口收敛 3 处、只放 http(s)、无 `target=_blank`/`window.open` 旁路、外链窗口 capability 刻意最小 |
| 11 | CONFIRMED = C-6 | verify 已挂 tags，但同事件并列 workflow ⇒ 红了不阻断发布 |
| 12 | 已有保护 + C-4 | 清理默认不动（无策略=不删）、VACUUM 有预算可回滚、`.part` 只删本机 UUID 命名的；矛盾只在"收藏是否算媒体目录" |

---

## 5. 建议修复顺序（一次一个域，不并发跨层）

1. **盘满归类 + 可行动文案**（含群侧 reason）——纯错误归类，不动网络语义。
2. **`admit_inbound` 余量预检** + INV 登记（含"读不到 ⇒ 放行"反例格）+ 只读目录注入用例。
3. **两条可诊断日志**：直连解密失败 `code=` warn；SHA 不符打 actual/expected/`resumed`。
4. **1:1 续传补内容身份判据**（复用 `content_transfers.cid`，不碰协议）。
5. **会话行在线/离线可访问名**。
6. **README 前台服务那句改准** + C-4 二选一（按第 7 节拍板结果）并加"现解析"判据。
7. （拍板后）Android `GosslanService`。

## 6. 最小改动与回归测试（每项都要"改坏必红"）

| 项 | 落点 | 回归 |
|---|---|---|
| 1 | `logging.rs::is_disk_full` 提 `pub(crate)`；接收失败点归类 `code=DISK_FULL`；`group_file.rs` 失败带 reason；i18n 两语 | 纯函数用例（错误串→归类）+ `verify-guards` 变异（把归类改回恒非盘满必红） |
| 2 | `receive.rs::admit_inbound`；INV 新条目或并 INV-P26；`cfg(unix)` libc statvfs、`windows-sys` 新命名空间 | 真 fs 只读目录用例（断言 reject 带码、`.part` 不残留、对端收 `Ack(false)`）+"读不到⇒放行"反例格 + 恒真变异 |
| 3 | `handle_messaging.rs` 解密臂、`receive.rs` SHA 分支 | 日志内容断言（`code=` 可检索），零行为变化 |
| 4 | `resume_receive`/`handle_file` Offer 臂（查 cid 不等 ⇒ Restart） | 表驱动：同 tid 异 cid 必整份重收；反向变异"只比长度"必红；`decide_offer` 既有用例不许改绿 |
| 5 | `ConversationListItem.vue` 的 `rowAriaLabel` | `a11yLabels` 或新用例 + CDP 探针一格（读**真渲染**的可访问名） |
| 6 | `README.md`、`state.rs`/`channel.rs` 注释二选一 | 门禁第 9 步（file:line/裸路径存在性）+ 新增"favorites 是否在 media_dirs"源码判据（现解析，不手抄） |

## 7. 需要拍板的三件事（默认推荐 + 取舍）

1. **Android 是否对外承诺"后台可收消息"** → 默认**不承诺**：实装前台服务（`remoteMessaging` 为主）
   + 设置页诚实文案；不做开机自启、不申请电池豁免。取舍：承诺=可用性但续航/审核/厂商不可控；
   不承诺=诚实，用户仍可能当 bug 报（缓解在文案而非放宽）。
2. **收藏媒体能否被存储清理回收** → 默认**不能**（从 `media_dirs()` 去掉 `favorites_dir`，
   同步修注释 + 加判据）。取舍：留着=配额数字真实但用户显式收藏的东西可能被删；去掉=收藏独立
   且永不自动回收（与微信同口径），代价是配额统计少一份。
3. **发布是否绑门禁** → 默认**绑**（给 tag 发布加 required status check / branch protection，
   或在 updater-manifest 那一步做"verify 未绿则拒绝"的显式判据）。取舍：多一道可能因 runner
   抖动卡住的串联；不绑=verify 与发布并行，红了照发。

## 8. 未执行的测试与原因

`cargo fmt/clippy --all-targets`、Rust 单测、`verify`/`verify:full`/`verify:local`、
CDP UI 探针（`verify:ax`）、双实例 E2E（`verify:e2e`）、发版层（`verify:release`）、
Android 构建与真机 —— 全部 **NOT RUN**。原因：本阶段限定只读且工作树与他人共用，重层会编译工作树
并改动 `src-tauri/target/`（要看在途产物多大就现算 `du -sh src-tauri/target`，别往这里抄数字）；
E2E/发版层另需 release 产物 + 桌面 GUI 会话 + 百 MB 级磁盘（这一条 `verify.mjs --list` 自己就打印）。
本文件凡"某判据当前是否绿"一律不作 PASS 断言。

## 9. 第一批建议范围（等批复后开工）

第 5 节的 **1–6 项**（不含 Android）。全部 L1–L2 半径、单域推进、各带一条"改坏必红"的判据；
第 6 项里"收藏能否被清理"按第 7 节 ② 的结论执行。Android（第 7 项）待承诺口径单独开批。

## 10. 本轮自我纠正（防止下一个人重复我的错）

- 曾判"发布不跑测试"——第一次说成"跑了但不阻断"，也**不准确**：那个 `tags: ["v*"]` 是并行会话
  **未提交**的工作树改动。按 HEAD 复跑 `git show HEAD:.github/workflows/verify.yml`，tag 事件
  连 verify 都不触发。教训：**读工作树 ≠ 读 HEAD**，在多人共用工作树时每条 `file:line` 都要说明按哪个基线。
- 曾判"Android 断网/换网后不会自愈"——错。发送 socket 有 `SendCell` + 探测式换绑，缺的是
  "进程死了没人叫醒"。
- 曾判"在线状态只靠颜色、未知被当离线"——错。三态 + 灰度 + 文字药丸都在，残余只有读屏可访问名。
- IME 计数第一次用 `ime.enter([a-zA-Z]` 判别，把**正确写法**也算成漏挂（28 命中里 15"疑似"）；
  改成逐行判"该行是否带 `$event`"后真实漏挂 = 0。关键词命中数 ≠ 格数，这条口径别再退回去。

## 11. 审计期间工作树被并行会话改动（实施前必须重读）

本文件所有 `file:line` 的基线是 **HEAD `2c55ba34` + 当时的干净工作树**（`git status --porcelain`
在那一刻为 0 行）。审计收尾时同一棵工作树里出现**另一会话的 11 个未提交改动**，其中多个正是本报告的
落点文件，因此行号会漂、个别结论会被他们顺手改掉：

```bash
git status --short          # 现算，别照本文件抄
git diff --stat
```

已知影响（三条，逐条按 HEAD 复跑过）：

1. `commands/channel.rs`：HEAD 上 `media_dirs()` 含 `favorites_dir` 且无删除侧豁免 ⇒ **C-4 在 HEAD 成立**；
   现树里未提交的 `cleanable_dirs()` 已经把"收藏只计占用、不参与删除"实现了——即第 7 节 ② 的默认推荐方向。
   若那笔改动落地，C-4 从"矛盾"降级为"已修，待回归"。
2. `verify.yml`：HEAD 无 `tags` ⇒ C-6 按 HEAD 成立；现树未提交改动补上了 tags，但仍未解决"并列 workflow 不阻断"。
3. `receive.rs` / `group_file.rs` / `file_tests.rs` / `favorites*` / `publish-release-assets.sh` /
   `publishRelease.test.ts` / `message_delete.rs` / `lib_file_tests.rs`：同批未提交改动，
   与本报告的 P1（`admit_inbound` 预检落点）与 P3（可诊断日志落点）直接重叠。

**因此**：开工前先 `git log -1` + `git status --short` 重取基线，对本文件每一条 `file:line` 现读一次；
本文件**不代替**那次复核。他人未提交的改动一律不代改、不代提交、不代回滚。


---

## 12. 实施回填（2026-10-27 晚，另一会话）

基线已从 `2c55ba34` 前进到 `0fd6652d`（4 批数据/可靠性/体验修复已落地）。逐条复核本文件：

**已修（复核方式写了，别只信这行字）**

| 编号 | 状态 | 落点 / 判据 |
|---|---|---|
| C-4 收藏是否进清理面 | **已修** | `commands/channel.rs::cleanable_dirs`（清理面去掉 `favorites_dir`，统计仍含）；判据 `clean_targets_exclude_favorites_but_keep_counting_them` |
| C-6 打 tag 不跑门禁 / 并列不阻断 | **已修** | `verify.yml` 的 `on.push.tags` + `publish-release-assets.sh` 的 Verify 门禁（同 SHA 必须 success，`GOSSLAN_SKIP_VERIFY_GATE=1` 可放行）+ 四个 release job 补 `actions: read`；判据 `发布门禁：Verify 未绿必须拒绝发布…` + 正面对照 |
| C-5 直连解密失败静默 | **已修** | `handle_messaging.rs` 留 `code=DIRECT_OPEN_FAILED peer=… len=…`（节流 5s） |
| P3 子问 4（校验失败不可归因） | **已修**（只补日志那半） | `file/receive.rs` 留 `code=SHA_MISMATCH transfer=… actual=… expected=… received=… size=…` |
| P4 残余（读屏拿不到在线态） | **已修** | `ConversationListItem.vue` 的 `rowAriaLabel` 追加 `common.online/offline`（`null` 不念） |
| C-3 的 README 那一句 | **已修（只改文案）** | `README.md` 改成"当前没有前台服务"并指向 `docs/adr/0020-blind-circuit-relay.md`；**Service 本身仍未实装** |

**仍未做（都写了为什么，不要误读成"漏了"）**

- **P1 接收前磁盘余量预检**：未做。它要 `libc::statvfs`（unix）+ `windows-sys` 新命名空间，
  且按本文件自己的口径得先给 INV-P34 补"一次 statvfs 算不算慢活"，还要带"读不到 ⇒ 放行"的反例格。
  本轮没有 Windows 编译与真机盘满注入，做一半比不做更危险。**建议单开一批**，顺序：先归因（已完成
  `code=SHA_MISMATCH`；盘满归因 `DISK_FULL` 仍未做）→ 再预检。
- **P2 Android 后台保活**：未做，等第 7 节 ① 的产品口径（是否对外承诺"后台可收消息"）。
- **P3 的"1:1 续传内容身份"判据**（拿 `content_transfers.cid` 与新 Offer 的 sha 比）：未做。
  它要动 `resume_receive` / Offer 臂，且需要"同 tid 异 cid 必整份重收"的表驱动用例；
  在发版前动续传路径，回归面大于收益。
- **P5 设置搜索**：本文件自己建议暂不实现，维持。

**结论**：本文件第 5 节的 1–6 项里，3（日志）、5（朗读）、6（README + 收藏判据）已落地；
1 的"归因"只落了 SHA 那一半，盘满归类与 2（预检）未做；4（续传身份）未做。Android 待拍板。
