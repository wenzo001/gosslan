# Gosslan UI/UX 重新设计 — 第一阶段

> 只做设计，不改业务代码。所有产物在 `designs/gosslan-redesign/` 内，可独立预览与评审。
>
> **状态：v2.2「Pulse」已交付，等待逐项评审。未进入代码重构。** v2 画布 46 块画板（6 个页面）、10+ 个组件预览、2 个可交互原型；v1「Still」34 块画板保留作对照。

## AI 实现交接

- 总入口：[HANDOFF.md](HANDOFF.md) — 给其他 AI / 工程师的实现说明、代码映射、硬规则、验收标准。
- 机器可读索引：[design-manifest.json](design-manifest.json) — 画板 → 路由 → 代码文件 → 状态。
- 分阶段提示词：[docs/ai-prompts.md](docs/ai-prompts.md) — 可直接复制给其他 AI。
- 可上传压缩包：`designs/gosslan-redesign-handoff.zip`。

推荐用法：让对方先读 `HANDOFF.md`，再读 `tokens.json` 和对应画板；不要只发截图。

## v2.2 方向：Pulse（当前）

在 v2.1 的“微信 / QQ / 飞书熟悉感”上，再加三条约束：

- **更紧凑**：桌面会话行 62px、移动 64px、设置行 48px；1000×680 主窗口能放下更多信息。
- **更圆润**：控件 10px、卡片 16px、气泡 20px、抽屉/输入外壳 22px；嵌套圆角按“外圆角 − 间距”同心递减。
- **复杂页面更清楚**：参考 Apple 设置 / 文件 App 的分组卡片和固定槽位；辅助字号 ≥11px，不靠缩小字号塞信息。

完整 rationale 见 [docs/redesign-v2.2-note.md](docs/redesign-v2.2-note.md)；长文本与溢出规则见 [docs/edge-cases.md](docs/edge-cases.md)。

## v2.1 方向：熟悉感（上一版）

面向项目团队私网使用的聊天工具，参考微信 / QQ / 飞书已经形成的肌肉记忆：左 rail + 会话列表 + 聊天，移动端 4 tab + 顶栏「+」。中性灰白表面、系统字体、蓝色主操作、红色未读、绿色在线、金色置顶；自己消息用纯色气泡。文案用大众说法，功能优先于装饰；保留主题色、气泡颜色、字号等可定制项。

完整 rationale 见 [docs/redesign-v2.1-note.md](docs/redesign-v2.1-note.md)。

## v1 基线方向：Still（对照）

Gosslan 是一个**熟人局域网**通讯工具，不是一个需要抢占注意力的公网社区。Still 的目标是让界面退后、让消息向前：

- **暖中性表面**，不用蓝灰玻璃与色雾；层级靠明度差和 1px 发丝线。
- **一个强调色**（钴蓝）只用于动作、选中和自己发送的消息。
- **iMessage 式单聊**：无头像列、36px 单行气泡、2px 组内间距。
- **群聊靠头像与发送者名区分**，不靠两套气泡颜色。
- **统一图标刻度**：1.75px 描边、16/20/22/24 四档尺寸。
- **状态语言**：发送中 / 已发送 / 已读 / 失败 / 暂停 / 离线 / 重试，全部有图标 + 文字。

完整规范见 [design-system/project/README.md](design-system/project/README.md) 与 [design-system/project/tokens.json](design-system/project/tokens.json)。

## 目录

```
designs/gosslan-redesign/
├── README.md                       # 本文件
├── HANDOFF.md                      # AI 实现交接总入口
├── design-manifest.json            # 画板 → 代码的机器可读映射
├── design-canvas/                  # v1 对照画布（claude-design 格式）
│   └── project/
├── design-canvas-pulse/            # v2.2 画布（46 块 / 6 页）
│   └── project/
├── design-system/                  # v1 对照设计系统
│   └── project/
├── design-system-pulse/            # v2.2 设计系统
├── brand/                          # 小院 SVG、App 图标源文件
├── screenshots/                    # 交接用参考截图（非实现规格）
│   └── project/
└── docs/
    ├── audit.md                    # 现有 UI 问题（带代码/截图证据）
    ├── decisions.md                # 新旧差异与设计决策
    ├── feature-coverage.md         # 功能 → 画板覆盖矩阵
    ├── product-gaps.md             # 流程闭环与交互改进
    ├── redesign-v2.1-note.md       # v2.1 为什么从活力转向熟悉
    ├── redesign-v2.2-note.md       # v2.2 紧凑、圆润、苹果式清晰
    ├── edge-cases.md               # 长文本、溢出与密集信息规范
    ├── verification-v2.md          # v2.2 真实执行过的验证与限制
    ├── ai-prompts.md               # 可直接复制给其他 AI 的分阶段提示词
    └── review-checklist.md         # 逐项评审清单
```

## 画板索引

### 基础

| 画板 | 内容 |
| --- | --- |
| `Foundations` | 浅/深两套表面、语义色、字体阶梯、间距、圆角、阴影、图标刻度 |
| `Layout` | 1000×680 三栏、768 窄桌面、390 移动、窗口尺寸与断点 |

### 桌面端（1000×680 为主）

| 画板 | 内容 |
| --- | --- |
| `DesktopChats` | 主界面、rail、会话列表、空会话主区、任务中心入口 |
| `DesktopOneToOne` | 单聊：iMessage 式气泡、回执、引用、图片、文件、未读分隔、回到最新 |
| `DesktopGroupChat` | 群聊：发送者身份、置顶、@提及、群任务卡、逐人已读 |
| `DesktopContacts` | 通讯录列表、好友分组、在线/离线、发起聊天 |
| `DesktopRequests` | 好友申请（收到/发出）、添加好友弹窗 |
| `DesktopGroupInfo` | 群资料抽屉：成员 / 群文件 / 群任务 / 公告 / 退出与转让 |
| `DesktopFavorites` | 收藏列表 + 详情、类型筛选、空状态 |
| `DesktopLinks` | 链接列表、导入 / 导出 / 刷新、独立窗口打开 |
| `DesktopShare` | 好友共享目录：面包屑、文件列表、截断与下载 |
| `DesktopTasks` | 任务中心：文件传输、内容获取、待发送、群历史同步 |
| `DesktopSearch` | 全局消息搜索：结果列 + 会话上下文 + 筛选 |
| `DesktopSettings` | 设置窗口 780×600：双栏、个人资料、外观、聊天样式、通知、网络、存储、关于 |
| `DesktopGroupTasks` | 群任务窗口 780×620：看板、筛选、任务详情、历史 |
| `DesktopLogs` | 日志窗口 760×560：级别、时间窗、合并重复、过滤、导出 |
| `DesktopModals` | 添加好友 / 创建群聊 / 转发 / 图片预览 / 表情选择 |
| `DesktopDark` | 深色聊天 + 深色设置，验证同一套层级 |

### 移动端（390×844）

| 画板 | 内容 |
| --- | --- |
| `MobileChats` | 会话列表、搜索、底栏 4 项、未读 |
| `MobileOneToOne` | 单聊、返回、在线状态、输入区 |
| `MobileGroupChat` | 群聊、@提及、群任务卡、置顶 |
| `MobileContacts` | 通讯录、分组、申请入口 |
| `MobileFriend` | 好友资料：安全码、设备、局域网地址、删除 |
| `MobileRequests` | 好友申请：接受 / 拒绝 / 等待 / 撤回 |
| `MobileFavorites` | 收藏列表 + 类型筛选 |
| `MobileMe` | 我的：头像、昵称、设备、设置/链接/日志入口 |
| `MobileSettings` | 设置首页：4 组 9 项 |
| `MobileSettingsSection` | 设置二级页：外观 + 聊天样式 |
| `MobileSearch` | 全局搜索：输入、筛选、结果 |
| `MobileDark` | 深色会话 + 深色单聊 |
| `MobileStates` | 离线、发送失败、重试、传输暂停 / 失败 |
| `MobileEmpty` | 首次运行空状态、局域网发现状态 |

### 边界情况

| 画板 | 内容 |
| --- | --- |
| `DesktopEdgeCases` | 长会话名/预览/99+、长 URL 与长单词、长文件与错误原因、IPv6/安全码、搜索摘要与设置行、Toast/对话框 |
| `MobileEdgeCases` | 顶栏长标题、64px 会话行、78% 气泡、长 URL、文件卡、长草稿、Toast，以及移动端收束规则 |

### 品牌

| 画板 | 内容 |
| --- | --- |
| `BrandMascot` | 小院吉祥物、构造网格、96/64/32/16 尺寸、5 种状态、字标组合 |
| `AppIcon` | 应用图标母版、macOS/iOS/Android/Windows 四端、尺寸梯、Light/Dark/Tinted |
| `IconSet` | Rounded 2.0 界面图标表（24 枚）、改版前后、24/20/16 尺寸、24 网格解剖 |

### 可交互原型

| 画板 | 交互 |
| --- | --- |
| `PrototypeDesktop` | 列表切换会话 → 打开消息菜单 → 复制 toast → 全局搜索 → 添加好友整页 → 个性化覆盖层 |
| `PrototypeMobile` | 底栏切换 → 顶栏「+」打开添加好友 → 打开会话 → 发送消息 → 表情回应 → 返回 |

## 如何预览

本地服务已启动（需要保持进程运行）：

**v2.2「Pulse」— 微信 / 飞书的熟悉结构 + 苹果式的紧凑圆润（先看这个）**

- 设计画布：http://127.0.0.1:4720/design/4YGLyC5o6LTdAg8AQTmQYq/
- 设计系统：http://127.0.0.1:4730/design-system/lxbMRiMlYpRrrF_U7EfeRs/

**v1「Still」— 对照基线**

- 设计画布：http://127.0.0.1:4720/design/MYAGbqHaNSJhUvuMrGIDS3/
- 设计系统：http://127.0.0.1:4730/design-system/B4vpHPPl9cg06NdWc8XIzz/

v2 画布 6 个页面：`01 Pulse`（核心 + 发现 + 个性化 + 预览窗）、`02 Desktop coverage`、`03 Mobile`、`04 Prototypes`、`05 Edge cases`、`06 Brand`（小院 + 应用图标 + 界面图标）。交互原型在 `04` 页，点击画板上的 **Play**。

重新启动：

```bash
node /tmp/baoyu-design/skills/claude-design/scripts/artifact.mjs open designs/gosslan-redesign/design-canvas-pulse
node /tmp/baoyu-design/skills/claude-design-system/scripts/artifact.mjs open designs/gosslan-redesign/design-system-pulse
```

停止：

```bash
node /tmp/baoyu-design/skills/claude-design/scripts/artifact.mjs stop designs/gosslan-redesign/design-canvas-pulse
node /tmp/baoyu-design/skills/claude-design-system/scripts/artifact.mjs stop designs/gosslan-redesign/design-system-pulse
```

## v2.2 新增与改动

- **品牌**：新增 `06 Brand`：小院吉祥物（蓝院墙 + 奶油拱门 + 绿苗）、跨 macOS/iOS/Android/Windows 的应用图标、Rounded 2.0 界面图标系统（24 枚），桌面、移动端、设置/任务/日志等窗口共用同一套 path，只改尺寸；高频导航/发送/附件图标已替换。
- **密度与圆角**：桌面行高 68→62px、移动 68→64px、设置行约 56→48px；控件 10px、卡片 16px、气泡 20px、抽屉 22px；嵌套圆角同心递减。
- **边界情况**：新增 `05 Edge cases` 两块画板，覆盖长名称、长预览、99+、长 URL、长文件名、IPv6/安全码、两行摘要、Toast、长草稿；核心画板补上 `overflow-wrap:anywhere`、单行省略和固定槽位。
- **复杂页面**：设置/任务/搜索改为分组卡片 + 48px 行 + 固定右侧值；辅助字号下限 11px（密集卡片 10.5px）。
- **方向**：中性灰白底 + 主蓝（飞书/QQ 蓝）+ 未读红 + 在线绿 + 少量置顶金；系统字体（PingFang SC / Microsoft YaHei / Segoe UI）；纯色自己气泡、红色未读、绿色在线。参考微信/QQ/飞书的熟悉感，不做社交化包装。
- **重新设计的核心屏**：Chats（简洁空态 + 添加好友/创建群聊）、1:1（纯色气泡 + 整行输入区）、Group（头像 + 名字 + 任务卡 + 逐人已读）、添加好友（整页列表，替代弹窗，解决“遮罩没盖全”）、个性化（主题色 + 气泡颜色 + 字号 + 实时预览）。
- **补齐的窗口/状态**：1120×820 图片预览窗、560×400 启动错误窗、好友申请冷却态、Flow closures（搜索返回、多选批量、强提醒回执、群文件/任务 tab、链接导入预览、传输完成后的“打开”）。
- **移动端**：4 tab + 顶栏「+」（不默认放 FAB）；整页添加好友；个性化页；深色长按菜单。
- **收束说明**：见 [docs/redesign-v2.1-note.md](docs/redesign-v2.1-note.md)。
- **产品闭环审计**：见 [docs/product-gaps.md](docs/product-gaps.md)，列出 25+ 个流程的“开始/中间/结束/缺口”和 10 条交互改进建议。
- **v2.2 验证**：见 [docs/verification-v2.md](docs/verification-v2.md)。

### v2.2 需要你确认的 4 件事

1. 62px / 64px 行高是否够紧凑？还能再压到 58px，但触控和呼吸感会变差。
2. 气泡 20px、卡片 16px、抽屉 22px 的圆润度是否合适？要不要更圆（气泡 22px）？
3. 辅助字号抬到 11px 后，密集页面是否能接受略少的信息量？
4. 设置 / 任务 / 搜索继续用“分组卡片”，还是更接近 macOS 的整列列表？
5. 「小院」这个形象是否喜欢？表情放在门洞里是否自然，还是要更拟人/更抽象？
6. 收藏图标从星形改为书签是否接受？导航图标整体变粗到 2px 是否合适？

### 仍需产品确认

1. **主题色是否同步给聊天对象？** 现在设计为“只影响本机”；气泡颜色会同步。若主题也要同步，需要改产品契约。
2. 自定义气泡是否允许任意双色？如果允许，需要定义可读性下限；当前默认仍为纯色预设。
3. 好友申请被拒绝时，发送方要不要收到反馈？现在设计为静默 + 冷却。
4. 离线队列在应用退出后是否持久化？设计写了“重连后自动发送”，需要产品确认进程被杀后的行为。

## 范围与边界

**只做设计。** 本目录没有修改任何 Vue / TypeScript / Rust / CSS，也没有改动数据库、协议或业务逻辑。v2.2 验证记录见 [docs/verification-v2.md](docs/verification-v2.md)，v1 对照见 [docs/verification.md](docs/verification.md)。

**工具链。** 使用 `JimLiu/baoyu-design` 的 `claude-design`（画布）与 `claude-design-system`（设计系统）两个技能。技能加载器把这两个技能安装到了仓库的 `.agents/skills/`，并写入 `skills-lock.json`；它们不是业务代码，可随时用 `npx skills add JimLiu/baoyu-design` 复现或删除。

**没有虚构功能。** 以下能力在当前代码中不存在，因此设计中没有加入：账号/登录、云同步、语音/视频通话、语音消息、贴纸、输入中提示、在线时长、已读时间戳、消息编辑、投票 UI、群管理员角色、单聊置顶消息、按会话免打扰、会话归档、星标好友、应用内浏览器。详见 [docs/decisions.md](docs/decisions.md)。

**待确认的重大改动**（已在 decisions 中逐条说明原因与影响）：

1. 桌面列表默认宽度从 250px 调到 320px。
2. 把版本号从列表底部移到「关于」；列表底部改为「任务中心」入口。
3. 设置窗口采用双栏，外观与聊天样式拆成同级分区。
4. 单聊去掉头像列，群聊保留 24px 头像 + 11px 名字。
5. 全局搜索保持独立覆盖层，不做会话内搜索（与现状一致）。
