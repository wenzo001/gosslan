# Gosslan AI Engineering Index

> **入口只有一份**：[`AI_PROJECT_HANDOFF.md`](../AI_PROJECT_HANDOFF.md)（2026-10-21 重写）。
> 本文只做"文档地图"的备查索引，**不要从这里开始读**。

## 阅读顺序（动手前）

1. `AI_RULES.md` —— 工程宪法（不变量 / 禁止事项 / 强制流程 / §35 何时必须停）
2. `docs/protocol-invariants.md` —— 动协议、网络、加密、DB、会话归属时
3. `docs/migration-ledger.md` —— 改一个关注点之前，确认"哪个家在跑数据"
4. `docs/domains.data.mjs` —— 确认改动落在哪个领域（`check-domain-map.mjs` 守门）

## 按需文档（碰到对应领域再读）

| 文档 | 角色 |
|---|---|
| `docs/VERSIONING.md` | 版本号强制规则（发版/提交前必读） |
| `docs/design-guidelines.md` | UI 规范（圆角 / hover / 配色 / 字号令牌） |
| `docs/ARCHITECTURE-MAP.html` | 架构与接口契约图（判"方向对不对"，数字现算） |
| `docs/large-file-split-plan.md` | 大文件拆分计划（护栏锚点风险、下刀顺序） |
| `docs/acceptance/stability-smoke-matrix.md` | 验证覆盖矩阵（判"有没有被测过"） |
| `docs/acceptance/1.0-release.md` | 门禁步数对账的**活文档**（受 `check-doc-numbers.mjs` 管） |
| `docs/adr/` | 架构决策记录（0007 版本化 / 0014 选路 / 0015 BLE / 0020 中继 / 0022 安卓后台承诺…） |
| `docs/aoci-usage.md` | AOCI 认知层工具手册（约束本体在 `AGENTS.md`） |
| `docs/architecture/rc-5.0-report.md` | 5.0 发布候选验收报告（问题清单 / 矩阵 / 结论） |
| `docs/notes/audit-fix-report-2026-10-24.md` | 2026-10-24 审计 18 条缺陷的处置、影响与验证读数（B1–B19） |
| `docs/notes/full-repo-audit-2026-10-29.md` | 2026-10-29 全仓库深度审计：52 条发现（安全 12 / 功能 6 / 稳定性 8 / 重复 16 / 测试 10）、36 条 INV-P 逐条规范对账、修复顺序建议；证据在 `audit-context/` |
| `docs/notes/reka-ui-adoption-audit-2026-11-13.md` | Reka UI 采用现状复核、尚需评估的控件、与 Gosslan 设计目标的匹配度、最佳实践与分阶段计划（只读源码审计，未改业务代码） |
| `docs/notes/external-auth-share-readiness-audit-2026-11-14.md` | 外部快捷认证、内置外链浏览器与网页分享闭环的就绪度审计、风险分级、产品边界和分阶段接入计划（只读源码审阅，未运行测试/真机验收）。⚠️ **带日期的快照**：其中多项此后已按 `external-auth-integration-contract` 调整，判现状一律读那一份 |
| `docs/notes/external-auth-integration-contract-2026-11-14.md` | 外部 RP 集成的**活契约**：术语口径、三层状态机及当前差距、双边撤销、密钥保护、外链/深链边界、RP mock 的限制、错误码口径、版本化约定、可勾选的发布准入清单（未验收项一律 `NOT RUN`） |
| `docs/notes/reuse-and-component-audit-2026-11-13.md` | 组件库与公共能力复审：Todo 日历组件化评估、超时/码点计数等重复项、合理自研边界、最佳实践与分阶段方案（只读审计，未改业务代码） |
| `docs/notes/feature-closure-async-audit-2026-11-13.md` | 功能状态闭环与异步任务审计：乐观更新、进度可视化、取消/撤回/恢复边界、已证实风险及分阶段改进计划（只读源码审阅，未运行测试） |
| `docs/notes/send-cancelled-rca-2026-11-01.md` | 发送端台账假「已取消」根因分析（E2E 判据⑩ `A=cancelled`）：七次同形复现的日志证据链、两个发送家并发 + 取消槽位被顶替的机制、墓碑把真 `done` 静默挡死的锁死层、排除清单、最小修复方案与影响面 —— **只分析，未改码** |
| `docs/notes/layout-check-2026-11-04.md` | 排版核查截图清单：群文件成功态、独立群管理面板的中英截图（`docs/assets/layout-check-2026-11-04/`）、夹具 SQL 与「未覆盖 + 原因」 |
| `docs/templates/` | `BUG_FIX.md` / `ADR.md` |

## 历史档案（不要通读）

- `CHANGELOG.md` —— 版本历史与已修 bug 根因（查"这里以前修过什么"）
- `docs/stability-roadmap.md` —— 稳定版工作地图 + 漂移事故台账（按节查）
- `docs/version-ledger.md` —— `npm run version:ledger` 生成，**别手改**
- `docs/audit/`、`docs/notes/` —— 带日期的审计证据与排障记录
- `docs/archive/` —— 已归档的架构复审、旧计划、旧验收记录（2026-10-21 清理时移入）

## 已删除（2026-10-21）

- `AI_TASK_HANDOFF_20261012.md`（被 `AI_PROJECT_HANDOFF.md` 取代）
- `docs/ARCHITECTURE-EXPLAINED.md`（自标 v4.2.7 快照，行号全漂）
- `docs/P1-image-out-of-sqlite-overview.md`（零引用的交付说明）
- `docs/strong-reminder-plan.md`（被 `docs/acceptance/strong-reminder-final.md` 取代）

## Rule

If a document conflicts with executable code or tests, do not silently choose one. Report the conflict and determine whether the documentation or implementation is stale.
