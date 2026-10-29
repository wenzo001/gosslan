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
