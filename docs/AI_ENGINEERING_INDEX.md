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
| `docs/notes/system-share-target-design-2026-11-15.md` | **系统分享目标**（从别的应用分享到本机）的协议、读取端与平台骨架 —— 为什么协议是「写文件」（扩展与主应用是两个进程）、落地区协议 v1（目录/文件名/JSON/限额/TTL）、读取端把落地区当不可信输入的六道校验（内容与深链**同一把尺子**）、先入队后删文件的顺序、触发时机（启动 + 窗口聚焦）、macOS Share Extension 与 Windows MSIX 的骨架（未编译未验收） |
| `docs/notes/open-extension-api-design-2026-11-15.md` | **开放接口设计稿（未实现，待裁决）**：好友同步 / 定向分享 / 事件推送 —— 通道模型（RP 连不到本机 ⇒ 只有出站 POST 与深链两种）、scope 与 claim 分层（默认全关、未知 scope 整笔拒）、四组接口契约（好友同步载荷不含公钥、定向分享必须用户点确认且目标 fail-closed、事件分「元数据 / 正文」两档）、授权关系先走内存态以避开 SQLite schema 红线、4 条待裁决点（好友边界解锁、是否免确认直发、正文能否外送、「消息同步」是显示还是注入） |
| `docs/notes/platform-keychain-free-path-2026-11-15.md` | **平台密钥库的免费路径与三平台成本表（决策稿，未实现）** —— 纠正「卡在付费证书」的口径：**只有 macOS 需要签名**，Windows（DPAPI）与 Android（Keystore）零成本即可做；macOS 用**免费 Apple Development 证书**即可让 Keychain 的 DR 稳定（不再每次弹授权框），付费的 Developer Program 买的是公证与分发；另给「维持现状 + 导出/恢复」「口令派生加密文件」两条零成本替代路径，以及迁移的三步硬约束（写新 → 验签成功 → 才删旧；密钥库不可用时拒绝签名，绝不回落明文） |
| `docs/notes/rp-key-export-recovery-design-2026-11-15.md` | **已按本文实现（客户端）**：RP 绑定密钥的导出/恢复 —— 文件格式 v1（Argon2id + XChaCha20-Poly1305、头部作 AAD 防降级）、冲突矩阵（不覆盖不同公钥、不复活已撤销）、原子性、与平台密钥库迁移的**先后顺序**（先密钥库 → 再导出 → 最后抹明文）、10 条验收判据 |
| `docs/notes/app-name-and-searchability-2026-11-15.md` | 应用名（中文「小院儿」/ 英文 Gosslan）的**七处资源清单**与各平台可搜索性：Mac/Windows 两个名字都能搜到（机制不同），Android/iOS 是单值标签做不到、以及为什么不采用「第二图标」与「中英混排名」 |
| `docs/notes/external-integration-ux-audit-2026-11-16.md` | 外部接入的**用户操作审计**：登录与分享两条路各要用户点几下、哪一步可省哪一步必须保留；**分类接入**的结论（登录/数据/分享三类独立、接入方可只接一类，速查表在接入指南 §0.2）；已落地项：按 RP 记住「上次允许了什么」⇒ 同一应用再次登录只点一次「批准」（首次仍逐项点头、不勾就不给、撤销即清） |
| `docs/notes/topology-phase2-decision-2026-11-16.md` | 「我的网络」**阶段 2 决策记录**：布局策略（确定性分档网格，不用力模拟）/ 稳定 seed 与局部解碰撞的取舍 / **拖拽位置持久化**（settings 表 `topology_layout_v1`，本机偏好不进协议，只存拖过的节点，读失败不折叠）/ 性能预算实测（500 节点 0.051ms）/ 判据与反证 |\n| `docs/notes/bot-v6-redesign-2026-11-16.md` | **通知机器人 v6 重构方案**：机器人像联系人一样进会话/群（本机假身份，Frozen Core 不动）/ 个人从加好友入口、群从群成员面板（仅管理员/群主）/ 创建时配好中转地址+自动生成密钥 / 详情页看配置/密钥/免打扰/删除 / 服务端独立进程沿用 / 状态机与边界 / 一次性发 6.0.0 |\n| `docs/notes/a11y-full-audit-2026-11-16.md` | **全量无障碍静态审计**：11 个维度（按钮可访问名 / img alt / truncate title / 焦点环 / Tab 顺序 / 键盘出口 / 进度语义 / 加载态文字等价物等）在 124 个 `.vue` 上的实测结果（全 0 缺口）；本轮新增的两条判据（`findPositiveTabindex` / `findClickableWithoutKeyboard`）及**反例自证**；明确边界：真浏览器/读屏实测 `NOT RUN` |\n| `docs/notes/webhook-bot-client-plan-2026-11-16.md` | **通知机器人的客户端实施计划**（服务端已交付）：产品决策（多发送方共用一个 bot / 个人收件箱 / 服务端独立进程）、存储形状（走 settings 表，不动 Frozen Core schema）、命令清单、先落库再 ACK 的顺序、界面结构、7 条判据、这一轮明确不做与风险兜底 |
| `docs/notes/network-topology-visualization-plan-2026-11-16.md` | 网络拓扑可视化改进方案：现有放射布局与去中心化目标的冲突、当前数据能证明/不能证明的关系、邻域图到真实 Mesh 图的分阶段交付、状态边界与验收清单（**阶段 0/1 已实施**，见下一条） |
| `docs/notes/webhook-notification-bot-design-2026-11-16.md` | 通知机器人/Webhook 转发设计：独立于盲 Relay 的 API 与持久队列、单网关取件后经群 Mesh/Gossip 扇出（群成员无需各连 Webhook）、文字/图片接口、bot 密钥、pull/ACK 与离线边界、隐私风险、分阶段实施和验收清单（未实现；Relay Server 外部源码待核实） |
| `docs/notes/network-topology-semantics-2026-11-16.md` | 「我的网络」的**语义表 / 现有字段覆盖表 / 「不可推断关系」清单**（阶段 0 交付物）：每种线的数据来源与禁止暗示、今天**给不了**的字段（远端 peer-peer 边、中间节点身份、边的观测时间）、前端不许做的九件事；阶段 1 的落地对照表 |
| `docs/notes/external-app-device-auth-design-2026-11-13.md` | 设备快捷认证/绑定的**设计稿**（2026-11-13 草案，正文保留当时的方案与取舍）：威胁模型、事务与绑定状态机、claim 最小披露、双方案对比与分阶段计划。**现状读活契约那一份**；本稿已按原地实现，头部的状态横幅写明这条边界 |
| `docs/notes/external-auth-integration-contract-2026-11-14.md` | 外部 RP 集成的**活契约**：术语口径、三层状态机及当前差距、双边撤销、密钥保护、外链/深链边界、RP mock 的限制、错误码口径、版本化约定、可勾选的发布准入清单（未验收项一律 `NOT RUN`） |
| `docs/notes/external-integration-guide-2026-11-14.md` | **给外部接入方看的**接入指南：设备快捷认证（元数据/事务/决策回写字段表、JWS 断言校验步骤、幂等与撤销）与分享到会话（`gosslan://share?…` 参数与限额、用户确认语义、不支持清单）、**没有签名包时的两条粘贴自测入口**、接入自测清单、**错误码与用户可见文案附录**、NOT RUN 边界 |
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
