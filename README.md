# 小院儿 Gosslan · 无服务器 P2P 局域网即时通讯

> **小院儿**（中文名，zh 环境显示）/ **Gosslan**（英文名，en 环境显示）——同一个应用，安装后按系统语言自动显示对应名称；安装器界面同样跟随系统语言（中文系统中文界面、英文系统英文界面）。

[![GitHub release](https://img.shields.io/github/v/release/wenzo001/gosslan?sort=semver)](https://github.com/wenzo001/gosslan/releases/latest)
[![Verify](https://img.shields.io/github/actions/workflow/status/wenzo001/gosslan/verify.yml?branch=main&label=verify)](https://github.com/wenzo001/gosslan/actions/workflows/verify.yml)
[![Contributors](https://img.shields.io/github/contributors/wenzo001/gosslan)](https://github.com/wenzo001/gosslan/graphs/contributors)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#-license)

一个**没有中央服务器**的局域网即时通讯软件，界面高度模仿飞书 / 钉钉。
数据**只存本机**（SQLite），节点间通过 **UDP 组播/广播发现 + TCP 点对点传输**直接通信，
**端到端加密强制开启**，无需注册登录，用**设备指纹**识别同一用户，连上局域网即自动同步用户资料。
支持 **Windows / macOS / Android** 三端。

> 技术栈：Tauri v2 · Rust · Vue 3 (Composition API) · TypeScript · Vite · **Tailwind CSS · Reka UI · Lucide 图标** · SQLite

---

## 📥 下载

三个平台共用同一条 Release 渠道：**没有官网、没有应用商店、也不需要注册账号**。
每次发版由 CI 出包并挂到 [Releases](https://github.com/wenzo001/gosslan/releases/latest)，
按你的系统挑对应那一份即可（文件名里带平台与架构，不用看版本号也能认）：

| 平台 | 首装下这一份 | 备注 |
| --- | --- | --- |
| **Windows x64** | `..._x64-setup.exe` | 常规版，用系统已装的 WebView2 |
| **Windows x64（老机器 / 离线环境）** | `..._x64-setup-webview2-bundled.exe` | 把 WebView2 固定版本一起打包，体积更大但装得上；**只作首装兜底，不进更新渠道** |
| **Windows ARM64** | `..._arm64-setup.exe`（同样有 bundled 那一档） | 骁龙本 / ARM 主机 |
| **macOS Apple 芯片** | `..._aarch64.dmg` | Intel 机器取 `..._x64.dmg` |
| **Android** | `...-arm64-v8a-release.apk` | 近十年手机基本都取这份；老机型另有 `armeabi-v7a` 那份 |

校验件按平台的实际形状是三种，别以为"所有包都有一份 sha256"：

- **Android**：两份 APK 各配一个 `.sha256`。
- **Windows**：两份常规安装包（x64 / arm64）各配一个 `.sig`，供应用内更新验签；
  `webview2-bundled` 那一档不带任何附件 —— 它不在更新渠道里。
- **macOS**：首装用的 `.dmg` 没有附件；应用内更新取的其实是同一次发布里的
  `Gosslan-arm64.app.tar.gz` / `Gosslan-x86_64.app.tar.gz`，这两份各配一个 `.sig`。

**应用内自动更新**读的是同一次发布里的更新清单 `latest.json`（CI 每次发版重算，里面按平台
列出包与签名）⇒ "有没有新版本"不依赖任何官方服务器。Android 不在这条更新渠道里（清单里没有 android 那一档）：发新版后重新安装 APK 即可。

> 版本号一律不抄进这份文档：抄一次就会漂一次。现读用 `npm run version:show`，或直接看上面那颗徽标。

---

## 🤖 AI 开发必读

> **AI 编程助手改代码前先读这一份入口**：[AI_PROJECT_HANDOFF.md](AI_PROJECT_HANDOFF.md)
> （文档地图 / 核心机制 / 命令 / 验证口径 / Frozen Core / 常见坑）。

| 优先级 | 文档 | 内容 |
|---|---|---|
| **★★★ 必读** | [AI_PROJECT_HANDOFF.md](AI_PROJECT_HANDOFF.md) | **唯一入口**：文档地图、技术栈、核心机制速览、命令、验证口径、红线、常见坑 |
| **★★★ 必读** | [AI_RULES.md](AI_RULES.md) | **工程宪法**：核心不变量 INV-001~008、任务分级 L1/L2/L3、协议/DB/加密规则、Bug 修复流程、何时必须停、Definition of Done |
| **★★ 参考** | [docs/protocol-invariants.md](docs/protocol-invariants.md) | 协议不变量明细（INV-P01 起；条数只认 `node scripts/check-invariant-hooks.mjs` 现算）+ 测试矩阵 |
| **★★ 参考** | [docs/AI_ENGINEERING_INDEX.md](docs/AI_ENGINEERING_INDEX.md) | 文档地图备查索引 + 文档与代码冲突时的处理规则 |
| **★★ 参考** | [docs/migration-ledger.md](docs/migration-ledger.md) | 迁移台账：改一个关注点前先确认"哪个家在跑数据" |
| **★★ 参考** | [docs/ARCHITECTURE-MAP.html](docs/ARCHITECTURE-MAP.html) | 架构与接口契约图（单文件浏览器直接打开；数字现算） |
| **★★ 参考** | [CHANGELOG.md](CHANGELOG.md) | 版本历史与所有已修 bug 的根因 |
| **★ 按需** | [docs/VERSIONING.md](docs/VERSIONING.md) · [docs/design-guidelines.md](docs/design-guidelines.md) · [docs/adr/](docs/adr/) · [docs/acceptance/stability-smoke-matrix.md](docs/acceptance/stability-smoke-matrix.md) · [docs/large-file-split-plan.md](docs/large-file-split-plan.md) · [docs/templates/](docs/templates/) | 发版规则 / UI 规范 / 架构决策 / 验证覆盖矩阵 / 大文件拆分 / 模板 |

**阅读顺序**：`AI_PROJECT_HANDOFF.md`（入口）→ `AI_RULES.md`（约束）→ 涉及协议时读
`docs/protocol-invariants.md` 与相关 ADR → 代码。

---

## ✨ 功能特性

| 模块 | 能力 |
| --- | --- |
| **界面** | 三栏布局（左导航 / 中会话列表 / 右聊天区），**响应式**（PC 三栏 + 移动端单栏滑动切换），自定义主题色与字体（CSS 变量动态注入），**深色模式**，网卡选择下拉框 |
| **发现与好友** | UDP **广播 + 组播**双通道；**按需 `who_has` 探测**（打开「添加好友」才扫描，启动不持续扫描）；昵称/IP 实时过滤、已是好友显示禁用态；发送申请 → 对方弹窗确认 → 双方互存本地 SQLite；好友头像在线/离线角标，右键删除好友（保留聊天记录） |
| **E2EE（强制）** | **恒开且不可关闭**：**X25519**（ECDH 密钥交换）+ **Ed25519**（签名/身份校验）+ **ChaCha20-Poly1305**（AEAD 加密）；聊天窗口顶部绿锁徽标；公钥自动同步 + 缺失时自动探测，解密失败以系统消息提示（不丢消息） |
| **消息分发** | **Gossip 广播**（Epidemic 泛洪，Bloom Filter + LRU 去重，TTL 衰减）；单聊点对点加密、群聊群密钥加密 |
| **消息可靠性** | 直发 + Gossip + 离线补发三路径统一 msg_id 幂等去重；消息**一律写离线队列**、Ack 到达才删行，防半开连接静默丢包 |
| **消息回执** | 转圈=发送中 → 空心圆=已送达未读 → **绿勾=已读**（挂在我方气泡左侧）；失败红叉；打开会话/窗口聚焦自动回执 |
| **离线兜底** | 对方离线时消息自动暂存，上线建链后**自动补发** |
| **大文件** | **BitTorrent 式切片中继**：64KB~512KB 分片，并行分发到空闲节点二次转发，接收方乱序重组；直连/中继**自动路由** |
| **消息** | 文本 / 长文本（>280 字折叠）/ 代码（`highlight.js` 高亮 + 折叠）/ 图片（粘贴板直发）/ 文件（内嵌进度条）/ 系统消息；气泡悬停一键复制 |
| **聊天体验** | 虚拟滚动 + 触顶分页加载历史 + 未读定位分割线 +「回到最新」；连续消息合并与时间分割线；消息时间 `MM-DD HH:mm`（悬停看秒级）；6 套聊天配色预设 + 字号（**跨设备同步**：对方按我的配色渲染我的消息）；长文本折叠；**删除聊天记录**（列表项右下角 ×，二次确认） |
| **通知** | 应用处于**后台或非当前会话**时触发系统原生通知，**点击通知唤起窗口、跳转到发送者会话并清零未读**（Windows / macOS / Android） |
| **系统托盘** | 点击窗口「×」**最小化到托盘**（后台继续收发消息与通知），托盘菜单「显示主窗口 / 退出」——**只有选择退出才真正结束进程**（桌面端） |
| **双通道** | 局域网 + 蓝牙**双通道聚合**架构：`Transport` 抽象接口、独立开关、按负载智能分流（蓝牙通道接口就绪待接线） |
| **中继路由** | 异构 **Mesh 桥接**（局域网 ↔ 蓝牙跨链路转发）+ TTL 衰减 + 有界 RingBuffer 限流，节点降压保护 |
| **存储** | SQLite 只存文本 / 密钥 / 关系（**不存 BLOB**），图片/文件落 `Cache` 目录懒加载；**自动缓存清理**（3/7/30 天/永久 + 磁盘配额）+ VACUUM 整理 |
| **共享目录** | 设置本地共享文件夹，好友点对点浏览目录树并下载文件（防目录穿越） |
| **多开压测** | `--instance N` 单机多开（独立数据库/TCP 端口/指纹，UDP 共享），模拟多节点 Mesh |

---

## 🎯 为什么是它

同类工具大多默认"要有个服务器"。小院儿把这条反过来了，几条原则与它们**实际意味着什么**：

| 原则 | 实际意味着 |
| --- | --- |
| **没有中心服务器** | 官方不运营任何服务器，也没有账号体系。发现靠 UDP 组播/广播，传输是设备之间的 TCP；要跨 CGNAT 才需要**自己**架一台哑管道中继（ADR-0020），它只搬密文字节、不解析也不存储 |
| **数据只在产生它的那台机器上** | 聊天库与文件都落本机（SQLite + Cache 目录），没有云备份 ⇒ 换设备要自己导出聊天记录（导出是产品能力：纯文字单文件） |
| **加密不是开关** | X25519 + Ed25519 + ChaCha20-Poly1305 **恒开且不可关闭**；聊天窗顶部那把绿锁徽标就是它。想"临时关掉加密"在这款产品里做不到 |
| **可靠性优先于新功能** | 消息一律先写离线队列、Ack 到达才删行；直发 / Gossip / 离线补发三条路径共用同一个 `msg_id` 幂等去重 ⇒ 同一句话不会因为你多按了一次就变成两条 |
| **静默失败按缺陷处理** | 这个仓库最常见的修复形状是"给它补一个具名错误码 + 一行诊断读数"。判断依据是：能看见的故障可以修，看不见的故障只能传染 |
| **一切声称都要能重跑** | 门禁步数、不变量条数、护栏条数这类数字不在文档里手写，由 `scripts/check-doc-numbers.mjs` 现算对账；不变量条目必须解析成真实存在的用例（`scripts/check-invariant-hooks.mjs`） |
| **取舍有顺序** | 稳定 > 流畅 > 正确 > 原生体验 > 安全 > 可维护 > 扩展 > 新功能 —— 冲突时按这条排，不靠临时感觉（口径见 `docs/notes/memory-liveness-audit-2026-10-21.md`，`AI_RULES.md` 里写的是同一句话的短句版：「稳定性优先于新功能」） |

---

## 🚧 它不做什么（已知边界）

写在这里是为了**别把这份 README 当成"什么都能干"的承诺**——每条都能指回代码或 ADR：

- **不承诺跨网段默认可达**：默认范围是同一个局域网（外加蓝牙近距离）。两侧都在 CGNAT 后面时，
  要么靠节点互相中继/手动端点（ADR-0014 / ADR-0016），要么自托管中继（ADR-0020，**可选**且官方不运营）。
- **不承诺 Android 锁屏后无条件收到**：局域网通道开着期间才有前台服务守住监听，代价是一条常驻通知
  （通知里可以直接停掉）。开机不自启、不申请电池优化白名单，Doze 与厂商省电仍会限制网络 ——
  所以这句承诺是**带条件**的，条件写在设置页与这条边界里（ADR-0022）。
- **没有语音/视频通话**，也没有"已读之外的送达回执时间线"这类运营向功能。
- **不做云同步与多设备历史合并**：没有账号就没有服务端可存的地方，这是设计选择不是进度问题。
- **群历史不是无底洞**：新成员入群会自动补拉群里的聊天与群任务（`network/group_history.rs`），
  但补拉有边界与失败留痕，不承诺"整个群从第一条消息开始都在"。
- **BLE 只用来发现本应用的对端**：清单里的蓝牙权限全部带 `neverForLocation`，
  不做任何位置推断，因此也不会向用户索取定位权限（Android 12+ 的口径见 ADR-0015）。

---

## 📁 项目结构

> **不在本仓库里的配套项目**：公网中转服务器 **`gosslan-relay-server`** →
> <https://github.com/wenzo001/gosslan-relay-server>。零依赖 Node，只把两条连接拼成字节管道：不解析载荷、不落盘，
> 部署与运维文档（PM2 / systemd / Docker / 故障排查）都在那个仓库的 README 里。
> ⚠️ 改到中继发往的**线格式**时必须**同一轮改两个仓库**：协议规格写在那边 README
> 「协议规格」一节，客户端侧的记录层封装与拨号在这边（`src-tauri/src/transport/`）。
> 曾经它在主仓里有一份副本，2026-09-22 移除，只留这个指针 —— 重复源码迟早漂移。

```
gosslan/
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js        # darkMode: class + 主题色变量
├── AI_RULES.md               # ★ AI 工程宪法（不变量/禁止事项/开发流程）
├── AI_PROJECT_HANDOFF.md     # ★ 项目全景与代码导读
├── CHANGELOG.md              # 版本历史
├── docs/
│   ├── AI_ENGINEERING_INDEX.md   # 文档地图备查索引（入口是根目录 AI_PROJECT_HANDOFF.md）
│   ├── ARCHITECTURE-MAP.html     # ★ 单文件交互架构 + 接口契约图（浏览器直接打开）
│   ├── protocol-invariants.md    # 协议不变量明细（INV-P 条数由 check-invariant-hooks 现打印，别抄）
│   ├── migration-ledger.md       # 迁移台账：同一关注点有几个家、哪个在跑数据
│   ├── VERSIONING.md             # ★ 版本号强制规则：每个提交声明档位 + 同一个提交把版本提上去
│   ├── design-guidelines.md      # UI 规范（动界面必读：圆角 / hover / 配色 / 窗口边界）
│   ├── domains.data.mjs          # 领域图数据（check-domain-map.mjs 读的就是这份）
│   ├── large-file-split-plan.md  # 大文件拆分计划（护栏锚点风险、下刀顺序）
│   ├── stability-roadmap.md      # 稳定版工作地图 + 漂移事故台账（按节查，不要通读）
│   ├── version-ledger.md         # 版本分类台账（npm run version:ledger 生成，别手改）
│   ├── acceptance/               # 活文档：1.0-release（门禁对账）+ 稳定版验证覆盖矩阵
│   ├── architecture/             # 架构报告与清单（rc-5.0-report / frontend-inventory…）
│   ├── notes/                    # 近期排障记录（"当时发现了什么"，不是约束）
│   ├── adr/                      # 架构决策记录（含 ADR-0020 公网哑管道中继）
│   ├── archive/                  # 历史档案：旧架构复审 / 旧验收 / 旧审计（只作证据）
│   └── templates/                # Bug 修复 / ADR 模板
├── src/                      # Vue 3 前端
│   ├── main.ts
│   ├── App.vue
│   ├── style.css             # CSS 变量（亮/暗）+ Tailwind
│   ├── types.ts
│   ├── api/index.ts          # Tauri invoke 封装 + 事件监听
│   ├── utils/{cn.ts,color.ts}
│   ├── stores/
│   │   ├── useAppStore.ts    # 设备 / 主题 / 深色 / 聊天样式 / 响应式
│   │   └── useChatStore.ts   # 好友 / 会话 / 消息队列 / 回执 / 通知
│   ├── layouts/ResponsiveLayout.vue # 三栏 + 移动端单栏
│   └── components/
│       ├── NavRail.vue / ConversationList.vue / ChatWindow.vue
│       ├── MessageItem.vue / CodeBlock.vue / VirtualList.vue
│       ├── BaseModal.vue
│       └── ShareDirectory.vue / SettingsPanel.vue / AddFriendModal.vue / GroupCreateModal.vue
└── src-tauri/                # Rust 后端
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/default.json
    └── src/
        ├── main.rs / lib.rs
        ├── tray.rs           # 桌面托盘：关窗驻留、仅托盘退出（#[cfg(desktop)]）
        ├── device.rs         # 设备 ID 生成（gosslan- 前缀；随机数主导 + 设备属性混合，见 ADR-0021）
        ├── crypto.rs         # E2EE：X25519 + Ed25519 + ChaCha20-Poly1305
        ├── gossip_engine.rs  # Gossip 广播 + Bloom/LRU 去重 + 扇出
        ├── file_relay.rs  # 大文件切片 + 并行分发 + 重组
        ├── db.rs             # SQLite 存储层 + Schema
        ├── protocol.rs       # 线格式（UDP 包 / TCP 帧 / 消息枚举 / Gossip 信封）
        ├── state.rs          # AppState 全局状态
        ├── commands.rs       # Tauri 命令层
        ├── network/
        │   ├── mod.rs        # 网络启动 / 停止
        │   ├── discovery.rs  # UDP 广播+组播发现 + 多网卡选择 + 按需探测
        │   ├── transport.rs  # TCP 传输 + Gossip/中继/群密钥分发
        │   └── file.rs       # 文件直传 + 共享目录枚举
        ├── transport/        # 双通道聚合传输抽象
        │   ├── mod.rs        # Transport trait + TransportManager + 分流
        │   ├── lan.rs        # 局域网通道适配
        │   └── bluetooth.rs  # 蓝牙通道（BLE/RFCOMM 接口契约）
        ├── relay/
        │   └── mesh_router.rs # 异构 Mesh 桥接 + TTL + RingBuffer
        └── storage/
            └── cache_cleaner.rs # 缓存清理 + VACUUM
```

---

## 🚀 快速开始

### 环境要求

- **Node.js ≥ 18**（推荐 20+）
- **Rust ≥ 1.77**（[rustup](https://rustup.rs) 安装，MSVC 工具链）
- **Windows**：需安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 与 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win10/11 已内置）
- **Linux**：`sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libgtk-3-dev`
- **macOS**：Xcode Command Line Tools

### 安装依赖

```bash
npm install
```

### 生成图标（首次打包前执行一次）

```bash
npm run tauri icon src-tauri/icons/icon.png
```

### 开发调试

```bash
npm run tauri dev
```

> 局域网联调建议使用两台真实电脑 / 虚拟机，且处于**同一网段**。双方启动网络后会自动互相发现。

### 一键出包 `npm run dist`（推荐，按当前平台自动决定打什么）

**规则（用户定的）**：

- **macOS 上**：同时产出 **Android 包 + macOS 包**，两者 **并行**构建（不串行）。
- **Windows 上**：只产出**当前环境**适配的那一个 Windows 包（当前架构 + NSIS）。

```bash
npm run dist                 # 当前平台一键出包
npm run dist -- --dry-run    # 只打印将要执行的命令与环境（不构建）
npm run dist -- --dmg        # macOS 额外出 DMG（默认只出 .app + .zip）
npm run dist -- --all-abis   # Android 两个 ABI（默认只出 arm64-v8a）
npm run dist -- --fat-lto    # 发布级 LTO（仓库默认配置，最慢、体积最小）
npm run dist -- --serial     # 串行 + 共用旧 target 目录（复用缓存）
npm run dist -- --migrate-cache   # 一次性：把旧 target/ 的安卓产物搬进 target-android/
npm run dist -- --debug      # Android debug 包
```

产物：`release-artifacts/android/*.apk`、`release-artifacts/macos/*.app.zip`（Windows 在
`src-tauri/target/<triple>/release/bundle/nsis/`）。

**为什么快**（实现见 `scripts/package.mjs` 头部注释）：

| 优化 | 原来 | 现在 |
|---|---|---|
| 前端构建 | mac + 每个 ABI 各跑一遍 `vue-tsc + vite`（2~3 遍） | **只跑一遍**，其余进程用 `GOSSLAN_SKIP_FRONTEND=1` 短路 |
| macOS bundling | `targets: "all"` ⇒ 每次都做 DMG（几分钟） | 默认只出 `.app` + zip；`--dmg` 才出 DMG |
| Android ABI | 每次两个 ABI ⇒ 两次完整 release 构建 | 默认只出 arm64-v8a；`--all-abis` 才出两个 |
| 并行 | mac 与安卓串行（cargo 对 target 目录加独占锁） | 安卓用独立 `CARGO_TARGET_DIR=src-tauri/target-android`，**真正并行** |
| release profile | `lto = true` + `codegen-units = 1`（最慢） | 默认 `thin` LTO + 16 CGU；`--fat-lto` 回到发布级 |

> ⚠️ 默认走 thin LTO（编译快 2~3 倍，二进制略大）。**首次**会因为 profile 变化重建一次
> 发布缓存，之后增量都很快；要发布级产物（fat LTO）加 `--fat-lto`。

### 跨平台（Windows + Android）环境配置与多开

常用环境检查与打包命令：

```bash
npm run env:check          # 一键检查编译环境（Rust/MSVC/JDK/SDK/NDK/target，Windows）
npm run env:install        # 一键安装（MSVC + Rust + JDK17 + 镜像 + target，需管理员，Windows）

npm run android:init       # 生成 Android 工程（首次）
npm run android:build      # Release APK（4 ABI，用于分发压测）
npm run android:build:debug    # Debug APK（本机 + 手机直连调试）

npm run dist:win:portable  # Windows 便携版 → gosslan_<版本>_x64-portable.zip（Windows）
npm run multi:run          # 同机多开 3 个实例模拟多节点（--instance N，Windows）
```

- **多开原理**：`--instance N` 让每个实例使用独立数据库、独立 TCP 端口、独立设备指纹；UDP 端口共享（`SO_REUSEADDR`，unix 上叠加 `SO_REUSEPORT`），从而在单机模拟多节点 Mesh 与离线补发。
- **Android 权限**：局域网（`CHANGE_WIFI_MULTICAST_STATE` 等）+ 蓝牙（`BLUETOOTH_SCAN/CONNECT/ADVERTISE` 等）
  + 前台服务（`FOREGROUND_SERVICE` 与两个类型权限），清单见 `src-tauri/gen/android/app/src/main/AndroidManifest.xml`，
  模板见 `scripts/android/AndroidManifest.xml`。
- **Android 后台可收消息（带条件）**：局域网通道开着期间会跑一个前台服务守住 UDP/TCP/Gossip 的监听，
  代价是一条常驻通知（系统强制），通知里带「停止后台连接」动作。
  条件与全部取舍见 `docs/adr/0022-android-background-messaging-commitment.md`；
  开机不自启、不申请电池优化白名单，Doze 与厂商省电仍会限制网络，所以这里不写"永不掉线"。
  实现在 `src-tauri/gen/android/app/src/main/java/com/gosslan/app/BackgroundService.kt`（服务与通知）
  与 `src-tauri/src/android_background.rs`（Rust 侧启停接线），失效原因读在设置→诊断面板的「后台连接服务」一行。

### 生产打包（Windows x64）

先按改动量维护版本号（一次 bump 同步 `package.json` / `Cargo.toml` / `tauri.conf.json` 三处）：

```bash
npm run version:show    # 查看当前版本
npm run version:patch   # 补丁版本（bug 修复与小改动）
npm run version:minor   # 次版本（新功能，向下兼容）
npm run version:major   # 主版本（破坏性 / 架构级变更）
```

打包 Windows x64 安装包：

```bash
npm run icon            # 首次打包前生成图标集（本仓库已生成）
npm run dist:win        # NSIS 安装包 → gosslan_<版本>_x64-setup.exe
npm run dist:win:msi    # 额外产出 MSI
```

产物位于 `src-tauri/target/release/bundle/nsis/`，文件名形如 `gosslan_<版本>_x64-setup.exe`。

### 用 GitHub Actions 自动出包（无需本地装 Rust/MSVC）

仓库内置三端 workflow（Windows / macOS / Android），推送一个 `v*` 标签即自动构建三端安装包并发布 Release（apk/dmg/exe 三件套）：

```bash
npm run version:patch                 # 例：1.0.0 -> 1.0.1（同步 5 处版本号 + CHANGELOG）
git add -A && git commit -m "release v1.0.1"
git tag v1.0.1
git push origin main && git push origin v1.0.1
```

> GitHub 托管 runner 已预装 Rust / Node / JDK / Android SDK，无需本地环境即可出包。
> 版本发布约定与 CHANGELOG 维护规范详见 [AI_PROJECT_HANDOFF.md §5](AI_PROJECT_HANDOFF.md)。

---

## 🧪 测试

### 统一验证入口（先看这个）

```bash
npm run verify        # 快速层：结构门禁 + 前端断言 + vue-tsc 类型检查，不碰 cargo（秒级）
npm run verify:local  # 本地日常重门禁：只跳过「护栏非空转」，其余照跑（2026-10-26 实测 149.1s）
npm run verify:full   # 完整重门禁：cargo fmt/clippy/test、Rust 清单、**护栏非空转（前端子集）**、Android
```

**默认跑快速层就够日常用**，但它**不等于"编得过"** —— 结束时脚本会列出没跑哪几项。
改过 Rust 代码 / `Cargo.*` / 构建配置，本地跑 `npm run verify:local`（只跳过最长的护栏非空转，
起跑与汇总都会点名）；完整 `verify:full` 留到发版/推送前或交给 CI。

⚠️ **`verify:full` 里那一步护栏扫描只覆盖打了 `frontend` 标签的子集**（全是 `node --test`/脚本；
2026-10-26 同日两次实测：那一步 152.2s / 171.7s，整条 `verify:full` 26 步 288.8s / 383.1s）
—— **cargo 护栏一条都不跑**。
全量（含 Rust 用例，每条要整库重编译一次，单条实测 25~30s ⇒ 整跑 60 分钟以上）要显式加：

```bash
npm run verify:full -- --full        # 本地全量护栏（慢，属于"没人等它"那一档）
python3 scripts/verify-guards.py --lane cargo --shard 0/3   # 只跑某个通道 / 某一片
```

CI 侧全覆盖：`verify.yml` 的 `guards-cargo`（`--lane cargo --shard 0/1/2` 三片并行）+
`guards-web`（`--lane node,script`）并集 = 全部通道，这条覆盖关系由
`scripts/check-ci-guard-coverage.mjs` 现算对账（少一片、少一条腿、或退成 `--only` 子集都会红）。
CI（`verify.yml`）在任意分支每次 push 全跑三条腿，是这套分层的兜底。判据细节见 `AI_RULES.md` §37.1。

### 前端（node 内置测试运行器，零额外依赖，需 Node ≥ 22）

```bash
npm test
```

覆盖核心纯函数与源码守卫（用例数会涨，以命令输出为准）：Gossip 消息去重合并、会话未读统计与排序、主题色派生、文件大小格式化、类名合成。

### 后端（Rust）

```bash
cd src-tauri && cargo test --features bluetooth
```

`--features bluetooth` **不能省**：漏了会有十余条 BLE 用例连同被测代码一起不编译，而测试仍然全绿。

覆盖：E2EE 加解密（X25519 密钥交换 / Ed25519 签名 / ChaCha20-Poly1305）、Gossip 去重与信封签名校验、文件切片乱序重组、SQLite 存储层（好友/消息/离线队列/群组/**删除会话**）、协议 JSON 往返与 TCP 分帧。

此外还有协议级验证工具：`src-tauri/examples/e2e_peer.rs`（无 GUI 对连真实实例，覆盖发现/建链/加密/文件/离线补发）与 `scripts/e2e-dev.sh`（单机双实例全功能验证），详见 [AI_PROJECT_HANDOFF.md §6](AI_PROJECT_HANDOFF.md)。

---

## 🛰️ 架构与协议

### 设备发现（UDP :59991）

- 周期向局域网**广播**（255.255.255.255）与**组播**（239.255.42.99）一次 `announce`，
  携带设备 ID、昵称、TCP 端口、X25519/Ed25519 公钥。
- 广播周期**自适应**：<100 节点 5s、≥100 节点 10s、≥500 节点 20s，并叠加 0–2s 抖动，
  避免 500–1000 节点时的 UDP 风暴与同步惊群。
- **按需探测**：打开「添加好友」时，前端调用 `search_nearby_peers` → Rust 群发一次 `who_has`，
  其它节点单播回复各自 `announce`，约 1.5s 内收集在线节点；启动/日常不持续全网扫描。

### 消息传输（TCP :59992）

- 帧格式：`4 字节大端长度 + JSON 负载`。
- 建链规则：每对节点由 **device_id 字典序较小** 的一方主动拨号，避免重复建链竞态。
- 消息枚举（`protocol.rs`）：`Hello / Heartbeat / UserInfo / FriendRequest / FriendAccept /
  FriendReject / ChatMessage / GroupMessage / Ack / FileOffer / FileAccept / FileChunk / FileDone /
  ShareTreeRequest / ShareTreeResponse / ShareFileRequest / Gossip / RelayFileOffer / RelayChunk / GroupKey`。

### 端到端加密（crypto.rs，强制开启）

- 单聊：发送方用 **X25519(自己私钥, 对方公钥)** 派生共享密钥，`ChaCha20-Poly1305` 加密载荷；
  接收方用 `X25519(自己私钥, 信封中对方公钥)` 派生同一密钥解密。中继节点只能透传密文。
  直发内容带 `enc1:` 前缀标识；解密失败（缺公钥/公钥已更新）写入系统消息提示，不静默丢弃。
- 群聊：创建群时生成随机**群密钥**，用各成员公钥 ECDH 加密后分发（`GroupKey`），消息用群密钥对称加密。
- 签名：每条 Gossip 信封对 `message_id` 做 **Ed25519** 签名，接收方验签防伪造。
- 公钥缺失兜底：发送前自动查好友表 → 在线节点表 → 主动 `who_has` 探测重试；仍缺失则返回明确错误提示。

### Gossip 广播（gossip_engine.rs）

- 信封 `message_id` = SHA-256(sender_id + ts + payload)；**Bloom Filter**（概率去重）+ **LRU**（精确去重）。
- 接收新消息后向随机选取的 `fanout` 个邻居转发（TTL 衰减），实现全网覆盖。

### 大文件中继（file_relay.rs）

- `RelayFileOffer → RelayChunk(seq, ttl) → 重组`。发送方把文件切片按轮询分配给接收方 + 空闲中继节点，
  中继节点二次转发，接收方按 `seq` 乱序重组落盘。

### 离线补发

- 消息**一律**写入 `outbox` 表（INSERT OR IGNORE 按 msg_id 幂等，防半开 TCP 静默丢包）；
  收到对方 Ack 才删行；对方上线（Hello / 心跳）触发 `flush_outbox` 自动补发，接收方以 `msg_id` 去重。
- 直发 / Gossip / 离线补发三路径共用同一确定性 message_id，跨路径幂等去重。

### 系统通知与路由跳转

- 收到消息且**应用处于后台**或**当前会话非发送者**时，前端用 `@tauri-apps/plugin-notification` 触发原生通知（标题=昵称，正文=文本截断 / `[图片]` / `[代码]` / `[文件]`）。
- 通过 `onAction` 监听通知点击：调用 Rust `focus_window`（unminimize + show + set_focus）唤起窗口，随后 `openConversation(conv_id)` 定位会话并清零未读。
- 好友申请 / 通过等生命周期事件仍由 Rust 直接发通知（无需会话上下文）。

### 桌面托盘（tray.rs）

- 点击窗口「×」→ `prevent_close` + 隐藏窗口，进程驻留托盘继续收发消息与通知；
  托盘菜单「显示主窗口 / 退出」，**只有退出才结束进程**；单击托盘图标 / macOS Dock 点击同样恢复窗口。

---

## 🧭 后续路线图（v1.0 之后规划，勿主动实现）

> 以下方向**在 v1.0 正式版之后另行规划**（范围边界见 [AI_RULES.md](AI_RULES.md) §3、
> 验收口径见 [docs/acceptance/1.0-release.md](docs/acceptance/1.0-release.md)）。
> 仅作为已评估过的扩展点记录，**不要因为看到这一节就去实现**。
> 注意：蓝牙 / 跨网段 / 中继 / 群协作 **已经不在此列**（2026-09-20 更正，它们已是 v1.0 本体）；
> 好友指纹安全码校验也从"冻结"改为已排期（见 `AI_RULES.md` §3 与 D 组队列），
> 本节保留的是真正要往后放的东西。

- **前向保密**：静态 X25519 派生长期密钥 → 升级 Noise XX 会话（`snow`），建链握手派生会话密钥
- **好友指纹安全码 / QR 校验**：添加好友完成页当面核对指纹，防中间人 —— 已从"冻结"改为
  **已排期**（安全加固队列），不属于本节意义上的远期项
- **mDNS 第三发现通道**：覆盖跨子网 / 隔离广播域
- ~~蓝牙无配对通道~~ —— **已实现**（ADR-0015：`transport/bluetooth.rs` + `ble_framing` 通用分片，
  三端已发布），留在路线图会误导 AI 以为还要"补分片协议"
- **QUIC 切换**：`transport.rs` 的"分帧读写 + 建链"两原语可替换为 `quinn`，消息分发逻辑无需改动
- **服务端中转** —— **已采用为"可选自托管"**（ADR-0020，2026-09-21）：
  <https://github.com/wenzo001/gosslan-relay-server>。它是**只管组网**的哑管道 —— 按口令准入、把两条连接拼成字节管道，
  不解析帧、不落盘；跨 CGNAT（两侧都没有公网地址）时补一条链路，局域网能连时自然闲置。
  无账号、无注册、官方不运营，所以不构成"产品有个后台"。
  跨网段仍优先靠节点互相中继与手动端点（ADR-0016 / ADR-0014）
- **登录 / 账号体系（远期）**：当前用设备指纹识别用户，未来可在 `device_id` 之上叠加账号绑定，多设备同步

---

## 🔒 隐私与安全

- 聊天数据只存本机 SQLite：**官方不运营任何服务器**，也没有账号。可选的自托管中继
  只搬密文字节、不解析也不存储（ADR-0020），关掉设置里的开关就没有这条链路。
- 端到端加密，中继节点无法解密消息内容；走公网中继时额外套一层记录封装，
  连设备 ID / 昵称 / 群名册 / 文件名这些元数据也不可见，且中继注入或重放任何一帧都会断链。
- 共享目录访问做了路径规范化校验，杜绝目录穿越。
- 如需更强的元数据隐藏，可将单聊的接收方标识从协议中移除（全节点尝试解密，仅接收方成功）。

---

## 👥 参与贡献

感谢所有为本项目提交代码或参与贡献的人。按提交量排序，展示贡献最多的前 10 位：

<a href="https://github.com/wenzo001/gosslan/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=wenzo001/gosslan&max=10" alt="贡献者头像" />
</a>

特别感谢以下外部 PR 贡献者：

- [**Ha1fice**](https://github.com/Ha1fice) — PR #17 · **收藏功能**（微信式独立存储）
- [**yann9**](https://github.com/yann9) — PR #15 · **UI 优化**

想参与贡献？欢迎提交 [Issue](https://github.com/wenzo001/gosslan/issues) 或 [Pull Request](https://github.com/wenzo001/gosslan/pulls)。

---

## 📄 License

MIT © wd.f
