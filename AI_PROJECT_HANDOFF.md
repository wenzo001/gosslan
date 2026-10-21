# Gosslan 项目全景与开发指南（AI Handoff）

> **本文是 AI 接手本仓库的唯一入口文档**，2026-10-21 全面重写。
> 旧版（v1.0.0 快照）已删除：功能清单/时间线这类"会被时间冲淡"的内容不再在本文里维护，
> 想知道"最近改了什么"直接读 `CHANGELOG.md` 的 `[Unreleased]` + 最新带日期小节。
>
> **权威顺序（冲突时的裁决）**：可执行代码/测试 > `CHANGELOG.md` > `docs/protocol-invariants.md`
> 与 `docs/adr/` > `AI_RULES.md` > 其它文档。文档与代码冲突时**不许静默择一**，
> 报告冲突并判断是文档过时还是实现有 bug（`docs/AI_ENGINEERING_INDEX.md` 末尾同一条规矩）。

---

## 0. 项目一句话

**相闻（Gosslan）**：无服务器的 P2P 局域网即时通讯 —— UDP 发现 + TCP/Gossip/BLE/中继多路径传输 +
X25519+ChaCha20-Poly1305+Ed25519 强制 E2EE + SQLite 持久化 + Vue 3 桌面/移动界面（Tauri 2 壳）。
设备用**设备指纹/ID** 识别（ADR-0021：首启随机生成 + 属性混合，此后只认持久化值），
无账号体系、无中央服务器，数据只存本机。

当前状态：版本号**不要抄在文档里**（会漂）—— 现读 `npm run version:show`；
分支读 `git rev-parse --abbrev-ref HEAD`；最近在干什么读 `CHANGELOG.md` 的 `[Unreleased]` 与最新小节。
5.0 时期已完成一次前端重构与收口（自动化门禁 22/22、UI 探针 496/496、群聊 E2E 37/37 的读数见
`docs/architecture/rc-5.0-report.md`）。剩余未关闭项以该报告 §J.6 与最新 CHANGELOG 为准。

## 1. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面/移动壳 | Tauri 2（Rust 1.98 / tokio） | **只有一个 tokio runtime**；慢活必须 `spawn_blocking` |
| 前端 | Vue 3.5 + Vite + TypeScript | 单入口 `src/entries/main.ts`；多窗口按 `getCurrentWindow().label` 分流 |
| 状态 | Pinia（`useChatStore` / `useAppStore`） | 会话/消息/群/传输归 chat，设置/主题/语言/视口归 app |
| 数据请求 | TanStack Query 5（5 个面板） | 键与失效语义见 `src/utils/panelQuery.ts` 族 |
| UI 原语 | Reka UI（Dialog/Menu/Toast）+ VueUse + lucide-vue-next | **禁止引入 Ant Design Vue 等第二套组件库** |
| 校验 | Zod | IPC 边界与配置解析 |
| 存储 | SQLite（`src-tauri/src/db.rs` + `db/` 分册） | schema 变更写迁移脚本，不手工改库 |

## 2. 目录地图（10 行看懂仓库）

```
src/                    前端（components/ composables/ stores/ utils/ api/ i18n/）
src-tauri/src/          Rust：network/（transport/ble/mesh/file…）、commands/、db/、state.rs、lib.rs
scripts/                门禁与工具（verify.mjs 是"跑哪些检查"的唯一定义；guard_cases/ 是护栏注入用例）
docs/                   规范/台账/ADR（见下节文档地图；archive/ 是历史）
src-tauri/examples/   对连验证示例（e2e_peer / mirror_dial / dual_link）
test-results/           跑测产物（gitignore）；.workbuddy/ 是任务档案（gitignore，禁 commit）
```

## 3. 文档地图（**只读该读的**，这就是本文存在的理由）

### 必读（动手前，按顺序）

| # | 文档 | 什么时候读 |
|---|---|---|
| 1 | `AI_RULES.md` | **每次改代码前**。工程宪法：INV-001~008、L1/L2/L3 任务分级、协议/DB/加密规则、Bug 修复流程、§35 何时必须停、§37 Definition of Done |
| 2 | `docs/protocol-invariants.md` | **动协议/网络/加密/DB/会话归属**时。INV-P01…P35 明细 + 钩子（条数只认 `node scripts/check-invariant-hooks.mjs` 现算） |
| 3 | `docs/migration-ledger.md` | **改一个关注点之前**。半完成迁移中同一关注点常有两个家，先确认"哪个在跑数据" |

### 按需（碰到对应领域再读）

| 文档 | 什么时候读 |
|---|---|
| `docs/domains.data.mjs` | 确认"我改的文件属于哪个领域"（`check-domain-map.mjs` 守门） |
| `docs/VERSIONING.md` | 提交/发版（版本号五处一致 + `Version-Bump` trailer + Change Budget） |
| `docs/design-guidelines.md` | 改 UI（圆角/hover/配色/字号令牌/窗口边界） |
| `docs/ARCHITECTURE-MAP.html` | 判"方向对不对 / 接口该不该新增"（浏览器直接打开；数字是现算的） |
| `docs/large-file-split-plan.md` | 动 >3000 行的大文件前（护栏锚点指着它，见文件头） |
| `docs/acceptance/stability-smoke-matrix.md` | 判"某件事到底有没有被测过"（AUTOMATED/SIMULATED/MANUAL-HARDWARE） |
| `docs/adr/` | 做架构决策前先查有没有已 Accepted 的 ADR（0007 版本化、0014 选路、0015 BLE、0020 中继…） |
| `docs/aoci-usage.md` | 用 AOCI 认知层工具时（约束本体在 `AGENTS.md`） |
| `docs/architecture/rc-5.0-report.md` | 5.0 发布候选的验收报告（问题清单/矩阵/结论，2026-10-21） |
| `docs/acceptance/1.0-release.md` | 门禁步数对账的活文档（受 `check-doc-numbers.mjs` 管，不是"当前目标"） |

### 历史档案（不要通读，只查"当时为什么"）

| 文档 | 性质 |
|---|---|
| `CHANGELOG.md` | 版本历史（含所有已修 bug 的根因）—— 查"这个区域以前修过什么" |
| `docs/stability-roadmap.md` | 稳定版工作地图 + 漂移事故台账（**按节查**，不要通读） |
| `docs/version-ledger.md` | 分类台账（`npm run version:ledger` 生成，**别手改**） |
| `docs/audit/` `docs/notes/` | 带日期的审计证据与排障记录 |
| `docs/architecture/` | 5.0 时期的重构报告与清单（`refactor-5.0-report` 43 万字是取证细节，`rc-5.0-report` 是验收结论；`frontend-inventory` 是生成件） |
| `docs/archive/` | 已归档的架构复审、旧计划、旧验收记录（只作证据） |

### 已删除（2026-10-21 清理，勿再找）

`AI_TASK_HANDOFF_20261012.md`、`docs/ARCHITECTURE-EXPLAINED.md`（自标 v4.2.7 快照、行号全漂）、
`docs/P1-image-out-of-sqlite-overview.md`（零引用的交付说明）、`docs/strong-reminder-plan.md`
（已被 `docs/acceptance/strong-reminder-final.md` 取代）。旧架构复审与旧计划移入 `docs/archive/`。

## 4. 核心机制速览（改这里之前先看对应 ADR / 不变量）

| 机制 | 一句话 | 权威出处 |
|---|---|---|
| 消息 ID | `msg_id` 生成规则**不许改语义**（Frozen Core） | `AI_RULES.md` INV-001 |
| 投递三条路 | 直连 / 离线 outbox 补发 / Gossip 转发，全部按 `msg_id` 去重 | `AI_RULES.md` §9 |
| Outbox | **先入队后投递**；Ack = 已持久化（不是"发出去了"） | INV-003/004 |
| E2EE | X25519 + ChaCha20-Poly1305 + Ed25519，**恒开**，无明文降级 | `docs/protocol-invariants.md` |
| 会话归属 | 群消息会话键只来自 `group_id`；`sender_id` 是"谁说的"不是"说在哪个会话" | **INV-P35** |
| 多路径 | TCP / BLE / 中继 / Gossip，选路见 ADR-0014 | `docs/adr/0014` |
| 慢活 | GB 级哈希/同步/重命名必须 `spawn_blocking`，不许握着库锁 | 不变量台账"慢活"一节 |
| 前端状态 | 会话/消息只归 `useChatStore`；Query 只管 5 个面板 | §1 + `panelQuery.ts` |

## 5. 常用命令

```bash
npm run dev                      # 开发（Tauri）
npm run build                    # 前端静态检查 + 构建（vue-tsc + vite）
npm test                         # 前端全量单测（node --test，零额外依赖）
npm run verify:local             # ★ 本地门禁 22 步（默认跳过最长的护栏全量）
npm run verify:full              # 完整门禁（含护栏全量；CI 的 guards job 也跑它）
npm run test:e2e:group           # 群聊 E2E（双实例停机预置，37 断言）
npm run test:e2e:multi-instance  # 双实例 J1/J2/重启
npm run test:ui-runtime          # UI 运行时探针（本机跑法见下）
npm run dist                     # 一键出包（按平台自动决定）
```

本机跑 UI 探针（宿主里 Chromium 沙箱起不来时，见 `docs/architecture/rc-5.0-report.md` §E.3）：

```bash
GOSSLAN_CHROME="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  GOSSLAN_PROBE_NO_SANDBOX=1 npm run test:ui-runtime
```

## 6. 验证口径（**不要把"没跑"写成"通过"**）

| 层 | 命令 | 覆盖 |
|---|---|---|
| 快速 | `npm test` + `cargo test --features bluetooth` | 单元/契约/护栏注入锚点 |
| 本地全量 | `CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run verify:local` | 22 步：清单/文档/守卫/构建/测试/Android |
| 护栏非空转 | `python3 scripts/verify-guards.py`（可 `--only frontend`） | 每条判据"改坏必须红"（239 条，耗时长） |
| UI 运行时 | `npm run test:ui-runtime` | 496 格真实浏览器探针 |
| 行为 | `npm run test:e2e:*` | 双/三实例真实进程链路 |

⚠️ `npm run build` 在 WorkBuddy 沙箱里会假红（宿主批量删除守卫拦 `dist/assets`）⇒ 取真实读数用
`CODEBUDDY_SAFE_DELETE_ENABLED=0`。CI 无此守卫。

⚠️ **2026-10-21 清理过构建缓存**：`src-tauri/target/`（57G）、`src-tauri/target-android/`（3G）、
`release-artifacts/`、`dist/`、`node_modules/.vite/`、旧的 `test-results/run-*` 全部删除
（都是 gitignore 的可再生件）。**首次 `cargo build` / `cargo test` 会是全量重编（数分钟）**，
这不是坏了。E2E 需要二进制：`cd src-tauri && cargo build --features bluetooth` 后再
`GOSSLAN_E2E_BIN=…/target/debug/gosslan npm run test:e2e:group`。

## 7. Frozen Core（红线，改之前必须停下来问）

1. `msg_id` 生成语义
2. E2EE（X25519 + ChaCha20-Poly1305 + Ed25519）
3. Outbox 规则（先入队后投递；Ack = 持久化）
4. SQLite 表 schema（改动必须带迁移脚本）
5. 好友 / 文件 / 通知 / Chat UI 的既有行为

`AI_RULES.md` §31 Frozen Feature Rule 同一条；`docs/protocol-invariants.md` 是明细。

## 8. 最常见的坑（都是踩过的，别再踩）

| 坑 | 正确做法 |
|---|---|
| macOS BSD `grep` 的 `\|` 是字面竖线 | 用 `grep -E "a|b"` 或 Grep 工具（ripgrep）；读文件用 Read/Python |
| bash 变量后紧跟全角字符会被吃进变量名 | 一律写 `${VAR}`（值静默丢失，不是崩） |
| 同一文件并行 Edit 会竞态 | 同文件多处改动**串行** |
| `code_flat`/去空白后的 `contains("A B C")` 是隐性自等 | 源码形状断言在**原文**上搜 |
| 时间戳手算 | 用 `date -u -j -f "%Y-%m-%d %H:%M:%S" "<UTC>" +%s` |
| `--instance N` 的 device_id 不落库 | 运行时派生 `{base}-i{N}`；测试先读 gosslan.db 取 base |
| 新增 `.test.ts` 不登记 | 必须进 `package.json` 的 `scripts.test`，否则清单守卫红 |
| TS 测试名里的中文引号 `""` | 用 `「」`，否则 `node --test` 整文件 SyntaxError |
| 撞护栏变红就想改护栏 | 先读它的意图注释；正确解法是"分层 + 带理由的白名单 + 白名单自证" |
| `verify.mjs` 子进程 `stdio:inherit` 不落日志 | 门禁红时自己重定向到文件再取用例名 |
| 沙箱里 `npm run build` 假红 | 见 §6 末的 `CODEBUDDY_SAFE_DELETE_ENABLED=0` |
| 验证退出码别看管道 | `node x.mjs >/dev/null; echo $?`（管道取的是最后一个命令的码） |

## 9. 什么时候必须停下来问用户

见 `AI_RULES.md` §35。摘要：需求不清、破坏性变更（删表/改契约/删文件）、超出授权边界、
修复循环 3 轮仍失败、Frozen Core 相关。**不许拿测试质量换绿色，不许拿业务边界换组件统一率。**

## 10. 收尾清单（每个任务结束前）

1. 自审：改动是否超出任务范围、是否引入重复实现
2. `npm test` + 相关 `cargo test`；改动大就跑 `npm run verify:local`
3. 更新 `CHANGELOG.md` 的 `[Unreleased]`（每个条目挂在 `### ` 标题下）
3b. **同步描述了这次改动的文档**（路径/文件搬动/"已实现↔未实现"/面板数与表数这类状态声明）：
   门禁只钉得住硬数字与路径存在性，**语义状态机器判不了** ⇒ 这一步只能靠人做
   （判据：`node scripts/check-doc-citations.mjs` 全绿 + 自查"有没有哪份文档还在讲旧状态"）
4. 涉及协议/DB → 补 `docs/protocol-invariants.md` 的 INV 条目 + 钩子
5. 不 commit / 不 push / 不打 tag，除非用户明确要求
