# 强提醒 / 原生体验 / 流畅度 最终验收报告（2026-10-11，v4.35.1）

对应总目标《Gosslan｜消息强提醒、原生体验与流畅度一次性完成指令》。
本报告按该指令第七节要求的 7 项交付逐条作答；凡数字均为定稿时现算，复跑命令随附。

范围口径：强提醒战役四个提交 `9e7ec82`（Phase 1）→ `786b348`（Phase 2）→
`80e2b55`（Phase 3，v4.35.0）→ `6c8e0b4`（复审加固，v4.35.1）。
本轮（续接会话）的改动全部落在最后一个提交：11 文件 / +126 / −30
（`git show --stat 6c8e0b4`），冻结核心零改动。

---

## 1. 本轮实际修改的文件与目的

### v4.35.1（6c8e0b4，本轮）

| 文件 | 目的 |
|---|---|
| `src-tauri/src/commands/chat.rs` | **1:1 强提醒补目标真实性校验**：`send_message` 出帧前现读消息表，remind 的原消息、remind_ack 的 remind 行都必须真实存在于本会话，否则明确拒发（此前只有群路径有，对方可能点开通知定位到「幽灵消息」） |
| `src-tauri/src/notifications.rs` | ① `build()` 的 `extra` 参数只有 macOS 块读取，非 macOS 构建是未使用参数，补零成本引用修掉 Windows/Linux 的 `-D warnings` 挂红；② 移动端 `show_click_impl` 签名与三个桌面变体统一为持有 `AppHandle`（修掉 Phase 3 在 Android 编译门禁的红）；③ 注释如实改写「action 按钮只在 macOS 加」的理由 |
| `src-tauri/src/commands/network.rs` | `set_app_active` 在**无 bluetooth 特性**构建下被新版 clippy 1.98 判 needless_return（2026-09-18 既有代码，工具链加严照出）；反转为「状态翻转才进入工作分支」，行为一字不变，两种特性配置 clippy 均零红 |
| `src-tauri/src/lib_delivery_shape_tests.rs` | 新增形状护栏 `direct_remind_validates_target_message_exists`（先 `code_flat` 压空白再断言，防 cargo fmt 拆行假失败） |
| `src/utils/remindFlow.test.ts` | 新增接线断言：`notification.action("open", …)` 只许出现在 macOS cfg 块内（移出即红，防回归成全平台死按钮） |
| `CHANGELOG.md` + 5 个版本清单 | 落 v4.35.1 小节；补 Windows 通知声音行为的源码级证据（见 §2）；更正前端测试终值 914 → **915** |

### v4.35.0（80e2b55，Phase 3，前序会话完成、本轮独立复核）

24 文件 / 1219 行（Change Budget 机读）。用户入口（右键/长按「强提醒」，仅
sent/delivered/read、非自聊、非提示行）、群受众弹窗（显式勾选、绝不默认全群）、
气泡五态标识与「我知道了」、接收链路（绕过 1.5s 去抖、按 remind id 去重、群双门控、
S3 回执与本地通知解耦、抑制矩阵）、点击通知翻页定位原消息、macOS NSUserNotification
点击通道补齐（action 按钮 + 同步投递 + 正文/按钮双判定 + `NSUserNotificationDefaultSoundName`）、
Android High 重要级专属通道（振动随设置 remove+create 重建、建不上退回默认通道）、
设置页声音/振动两开关。**本轮对以上每一处做了源码回读复核，结论与提交说明一致**
（关键复核点：`useChatStore.ts:382-509/2192-2195/2356-2425`、
`MessageItem.vue:920-1021/1460-1490`、`ChatWindow.vue:339-347`、
`commands/network.rs:351-414`、`notifications.rs:87-447`、
`network/transport/{handle_identity,gossip}.rs` 的好友申请通知）。

冻结核心（消息状态、msg_id、E2EE、Outbox/Ack、Gossip、去重、文件传输、群同步、
持久化语义）在四个提交中均未修改；remind/remind_ack 复用 `send_message` /
`send_group_message` 既有内核，无新协议消息、无新表/列/迁移。

## 2. 消息提醒：各平台能力、验证结果与降级边界

| 平台 | 强提醒能力 | 普通消息能力 | 角标/打断 | 验证证据 |
|---|---|---|---|---|
| **macOS** | 系统通知（notify-rust / NSUserNotification）+ 默认提示音（声音开关）；action 按钮是点击捕获承重件，点正文/按钮都路由到开会话+翻页定位 | 横幅（无应用内声音是系统现状） | Dock 数字角标、菜单栏托盘点数；urgent=true 才弹跳 Dock（普通消息不弹） | Rust/前端护栏 + **CI macOS 双架构安装包构建绿**；notify-rust 同形独立程序投递实测（Phase 3）；**点按交互仍为人工 Smoke 项（见 §6）** |
| **Windows** | toast + 显式 `Sound::Default` 系统提示音 + Critical 任务栏请求；正文点击回调定位 | toast 横幅；**无声是库的既有渲染**（下详） | 托盘红点 + tooltip 未读数；刻意不用任务栏 overlay 图标（2026-09-17 判丑撤掉） | **CI Verify 的 Windows Rust 门禁在 80e2b55 为红、6c8e0b4 转绿**；Windows x64+ARM64 安装包构建绿；通知真实观感仍需安装包人工确认（见 §6） |
| **Android** | High 重要级专属通道（横幅+锁屏可见），振动跟随应用开关（通道承载，不再叠加 `navigator.vibrate` 双震）；声音走系统通道设置；点击 extra 带 msg_id 定位；运行时权限门控 | 默认通道 + 1.5s 去抖合并；「标记已读」动作按钮 | 无托盘（系统通知即强提醒） | 本地 `check-mobile.sh` 双特性 cargo check **0 warning**；CI Android 编译门禁与**分 ABI release APK 构建在 80e2b55 红、6c8e0b4 绿**；真机横幅/振动观感待人工（见 §6） |
| **iOS** | 无：仓库从未 `tauri ios init`，无构建目标 | — | — | 本轮不产出、不宣称；CHANGELOG 平台边界明示 |
| **Linux/BSD** | XDG 通知 + `message-new-instant` hint；守护进程不支持 action 时以 Closed 退出，不影响通知本身 | 同左 | Unity 系启动器角标，其它环境静默忽略 | 代码级双判定同构；无 CI 发行版，归入桌面既有支持面 |

**Windows 声音行为（本轮读库源码坐实，非推测）**：notify-rust 4.18 的 Windows 后端
恒调 `Toast::sound(...)`（`notify-rust-4.18.0/src/windows.rs:51-85`），未指定声音时
为 `None`；tauri-winrt-notification 0.7.3 把 `None` 渲染成 `<audio silent="true"/>`
（`tauri-winrt-notification-0.7.3/src/lib.rs:475`），把 `Sound::Default` 渲染成空
audio 元素（同文件 476 行，由系统播默认声），`Sound::from_str("Default")` 命中
枚举（同文件 126 行）。应用从不设置 urgency，所以「普通通知无声、强提醒有默认声」
是库行为的如实利用；给普通通知加 IM 提示音会改变全局通知策略，超出本轮范围，
CHANGELOG 已记为单独决策项。

**抑制 / 降级矩阵（代码复核 + 前端 11 条接线守卫）**：

- 总开关 `notify_enabled`：前端判一次、后端再判一次（好友申请不经前端也不漏弹）；
  关着不响不振不弹，但 S3「已提醒」自动回执照发（回执归属消息可靠性，不挂在通知 API 上）。
- 正查看该会话（`!document.hidden && document.hasFocus() && activeConv===conv_id`）：
  强提醒不振不弹，时间线上标识本身可见。
- 权限拒绝（Android 13+）：不弹、不重复申请骚扰；通道建不上：退回系统默认通道。
- 连续消息：普通消息 1.5s 去抖按会话合并、一批只请求一次注意；强提醒按
  remind msg_id 去重（内存集合 512 FIFO），同帧重复/多投递路径只生效一次。
- 群：发起名单 actors + 到达时**当前**成员表双门控（被移出群不再提醒）；第一版不默认全群。
- 重启：历史只走 `loadMessages`，不重放提醒；传输层 msg_id 去重是既有冻结核心。
- 通知点击：桌面后端事件 / 移动端插件 actionPerformed **同形载荷共用一个路由函数**；
  先唤起窗口后切视图；找不到原消息（未同步）给 toast 而不是静默；移动端监听器
  `scope.onDispose` 注销，防 init 重入叠加（本轮复核在）。

## 3. 原生交互与流畅度问题修复清单

本轮续接会话没有新开交互改造，按指令「复用现有机制、不新增未验证交互」执行，
复核确认强提醒新 UI 全部继承既有平台规范，没有自造一套：

- **受众选择弹窗**复用 `BaseModal`（Headless UI Dialog：Esc/遮罩关闭、焦点陷阱、
  关闭后焦点归还打开者、Android 返回键 `useBackLayer`、软键盘 inset、z-[65] 层级阶梯）；
  候选按钮整行可点、确认/取消按钮挂 `tap-safe`（44px 命中区，`:where()` 零特异性不抢定位）；
  打开即重置勾选；至少选 1 人才能确认。
- **五态标识**是静态胶囊（图标+文案）+ 文本按钮，无循环动画；hover 仅 opacity 过渡，
  被全局 `@media (prefers-reduced-motion: reduce)` 统一压到 0.01ms（`style.css:558`）。
- **右键/长按双模板**：桌面菜单与移动端长按面板共用 `canRemindEntry` 同一门控，
  接线守卫钉「两套模板都必须有」。
- **打断收口唯一**：`requestAttentionOnce` 是全仓唯一点击系统注意 API 的字面位置，
  且必须在通知**确实发出**之后才调（被合并/抑制的消息不闪不弹）；macOS 普通消息不弹
  Dock（用户 2026-09-29 明确要求），强提醒恒 urgent。
- **角标单一事实源**：托盘红点/点数、Dock/启动器角标由 `totalUnread` 驱动、300ms
  去抖、值不变不发 IPC；标记已读/切会话/删会话同一条链，修过「红点清了 Dock 还挂 3」。
- **流畅度**：长列表仍用既有动态测高虚拟列表；强提醒折叠在会话层算一次
  （`reminderMap` computed，与 reactionMap 同构），不在气泡里 O(n²) 重复折叠；
  修掉一个真实监听器泄漏（通道振动设置 watch 未挂 `scope.onDispose`，init 重入会叠加，
  Phase 3 复审已修，本轮复核在位）。

## 4. 性能证据（前后可比较；没测量的如实标记）

- **本轮无新性能改动、无新性能数字**：6c8e0b4 的产品代码净增 78 行（两块出帧前校验 +
  零成本参数引用 + 分支翻转），都在通知/发送的低频路径，不动渲染热路径。
- 既有基线仍以 `docs/acceptance/native-experience-round-1.md` 与 `perf/` 量具为准
  （消息行共享冻结常量后 27.6ms → 16.6ms 等读数，复跑命令在那份报告里）。
- 本轮相关的**资源泄漏修复**（watch 注销）是定性闭环，未做泄漏前后堆快照对比 ——
  标记为「有代码与接线守卫证据、无量化曲线」，不冒充性能数据。
- 强提醒不产生通知风暴的证据是结构性的：去抖合并 + remind id 去重 + 一批一次注意请求，
  且通知路径全部 fire-and-forget（不阻塞消息收发/DB/UI），错误只记日志不反压。

## 5. 自动化测试、护栏、构建与平台验证（定稿时现算）

| 项 | 结果 | 复跑 |
|---|---|---|
| 前端 node:test | **915/915 全绿**（战役基线 898，净 +17） | `npm test` |
| UI 运行时探针（真浏览器布局/键盘/软键盘/弹层裁切/变异反证） | **212/212 全绿** | `npm run test:ui-runtime` |
| Rust 单测（bluetooth） | **804/804** | `cargo test --features bluetooth` |
| Rust 单测（默认特性） | **788/788**（差集 16 为 BLE 专属） | `cargo test` |
| clippy `-D warnings` | 两特性配置均**零红零警告** | `cargo clippy [--features bluetooth] -- -D warnings` |
| rustfmt | 零差异 | `cargo fmt --check --all` |
| 非空转护栏（改坏即 FAIL/恢复即 PASS） | **222/222 全绿，0 跳过，工作区无变异残留**（约 52 分钟，Rust 用例逐条重编译） | `python3 scripts/verify-guards.py` |
| 全量门禁 | verify:full **23/23**（含前端构建、Android 双特性 cargo check 0 warning） | `npm run verify:full` |
| 文档守卫 | CHANGELOG 结构、硬数字对账（现算 222 等）、33 处 file:line 引用全部在界 | `check-doc-numbers.mjs` / `check-doc-citations.mjs` |
| Change Budget / 版本 | 6c8e0b4 判 L1（5 文件/119 行/1 领域），Version-Bump: patch 与 4/4 清单一致，无重复犯案 | `check-change-budget.mjs` / `semver.mjs check` |
| **GitHub Actions @6c8e0b4** | Verify（前端 / macOS Rust / **Windows Rust** / **Android 编译门禁** 4 job）、Windows x64+ARM64 包、**Android 分 ABI release APK**、macOS arm64+x86_64 包 —— **4 条工作流全绿** | Actions 列表（公开 API 可读；日志需仓库权限） |

**红→绿对照（本轮修复的直接外部证据）**：80e2b55 的 CI 中 Verify 的 Windows Rust
门禁、Android 编译门禁、Android release APK 三条为红（Phase 2 的 786b348 同位置全绿，
证明是 Phase 3 引入）；6c8e0b4 对应四条工作流全部转绿。CI 日志需仓库权限拉取，
本报告依据「失败步骤名 ↔ 修复点 ↔ 同 SHA 转绿」的对应关系 + 本地
`check-mobile.sh`/双特性 clippy 复现结论，不断言日志逐字内容。

测试有效性自查：新增两条护栏均为变异敏感型（Rust 那条钉真实调用与错误文案、
前端那条钉按钮的 cfg 位置）；222 条非空转验证本身保证「改坏必红」。

## 6. 未完成事项与客观阻塞（最小阻塞清单）

1. **macOS 通知点按人工 Smoke**：横幅约 5s 自动过期，自动化（含浏览器探针）来不及点；
   需要安装包 + 人工点正文/点「查看」两条路径各一次。交付物：通知投递已用 notify-rust
   同形独立程序实测，双判定逻辑有代码与评审证据，差的是真人一次点击。
2. **Windows 真机观感**：安装包已由 CI 产出，但 toast 外观、任务栏 Critical 闪烁、
   托盘红点/tooltip、勿扰下的实际表现需在装好的 Windows 上人工走一遍
   （dev/便携版不设 AUMID、本就不出系统通知，属既有平台边界）。
3. **Android 真机**：High 通道横幅/锁屏、振动随开关重建、点按定位需一台真机确认；
   **无前台服务**，进程被系统回收后消息级通知不可达（与普通消息同边界，CHANGELOG 已明示）。
4. **iOS 无工程**：`tauri ios init` 从未执行，本轮不产出也不验证；设置页文案已诚实降级。
5. **macOS 通知框架**：仍走已废弃的 NSUserNotification（notify-rust 默认后端）；
   迁移 UNUserNotificationCenter 需开 `preview-macos-un` 特性，留待单独评估。
6. **Windows 普通通知无声**：证据见 §2；加 IM 提示音是全局通知策略决策，未在本轮代拍。
7. **AOCI 认知层未同步**：本会话未挂载 aoci MCP；CLI `index agent plan` 返回
   「不支持修改 Volumes v1 正式认知」（仓库 Volumes 治理处于 blocked，312 项既有 finding）。
   未手工绕过写 `aoci.txt`；Phase 3 + 4.35.1 的语义同步留下一次带 MCP 的会话执行。
8. `--all-targets` clippy 在 examples/e2e_peer.rs 与测试码上有 38 条新 clippy 1.98
   告警（项目标准门禁不含 `--all-targets`，CI 不扫），属既有代码工具链漂移，
   不在本轮功能改动面，未顺手扩大修改。

## 7. 最终提交 SHA 与发布条件判断

- 最终 SHA：**`6c8e0b4`**（`fix(remind): 强提醒复审加固 —— 1:1 目标真实性校验、
  跨平台编译门禁与证据补全`），已推送 `origin/main`，版本 **4.35.1**；
  工作区干净（`git status` 仅报告本文档后续提交）。
- **发布条件判断：满足**。功能面：强提醒端到端（发起→投递→提醒→点击定位→确认）
  在四类应用状态与两类会话的代码路径均有实现与接线守卫；平台能力边界全部如实声明、
  无能力处明确降级；四条 CI 工作流在发布 SHA 上全绿（含 Windows/Android 安装包产出），
  本地四层自动化（915/212/804+788/222）与双特性 clippy/fmt 全绿；冻结核心零改动。
- 遗留项全部是**外部环境/人工动作/独立决策**（§6 第 1–6 项）或**工具链/治理另行排期**
  （第 7–8 项），无一项是「本轮在本机可安全完成而未做」的功能/测试缺口。
