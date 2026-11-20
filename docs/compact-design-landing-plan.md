# 紧凑设计落地实施方案（Design → Code 完整闭环）

> 状态：**评审已完成，方案待执行**（2026-11-20）
> 设计基准：[`docs/COMPACT-STANDARD.md`](COMPACT-STANDARD.md)
> 画布来源：`designs/gosslan-compact-canvas/`（open-artifact Design 画布）
> 本文回答一件事：**这套设计怎么变成代码**——分几期、每期改哪些文件、怎么验收、怎么回滚。
> 原则：**只基于现有功能**。设计稿里出现的每个界面/按钮/文案，都必须能在源码里找到对应；找不到的是提案，单独立项，不进实施。

---

## 0. 本次评审结论（画板处置）

对 33 张画板逐一对照 `src/` 源码后，按"能否指导实现"分四类处置：

| 处置 | 画板 | 说明 |
| --- | --- | --- |
| **保留（高保真）** | StyleBaseline、Foundations、Density、Favorites、MobileChats | 令牌、字号、圆角、密度、收藏两栏、移动列表与源码一致，可直接作唯一视觉基准 |
| **重画（形态错）** | Tasks | 原五列看板是臆造；已改为真实的「统计行 + 4 筛选页签 + 单列分组列表 + 两栏详情」 |
| **修正（局部臆造/画错）** | Chats、Conversation、ContextMenu、Modals、Links、Logs、Settings | 见 §0.1 |
| **删除（桌面无此页/纯提案）** | Me、TaskCardOpt、TaskUnread、TaskDetailCopy | 桌面无「我的」页；后三者是你提的优化提案 —— 2026-11-20 已按真实交互落地（未读回复走本机游标 + 详情内高亮；一键复制进操作条），对应画板因此不进画布，见 §4 |

### 0.1 已修正的关键错误（这些若照画板实现会出 bug）

| 画板 | 原问题 | 已改为 | 源码依据 |
| --- | --- | --- | --- |
| Chats | 标题「消息」/15px；桌面 placeholder「搜索会话、联系人或消息」；臆造「局域网广播」会话；空态只有「添加好友」；缺全局搜索按钮与列表页脚 | 「聊天」/17px；桌面 placeholder「搜索」；换成真实好友会话；空态「发起聊天」+「添加好友」；补全局搜索 + 页脚（传输队列 + 版本） | `ConversationList.vue`、`ResponsiveLayout.vue` |
| Conversation | 标题写单聊、内容却是群聊（群成员/文件/任务/同步历史 + 抖动） | 真单聊：共享目录 + 设备类型 + 链路徽标；无抖动；补列表页脚 | `ChatHeader.vue`、`MessageComposer.vue` |
| ContextMenu | 文本消息上出现「保存图片」；多出「删除」 | 文本消息仅「复制」；删除只在多选批量里；补「定位引用 / 以代码显示」 | `MessageContextMenu.vue` |
| Modals | 删好友写成「移除会话与密钥，无法撤销」（**与事实相反**） | 「聊天记录保留本地，可重新添加」「对方不受影响」 | `zh-cn.ts` 的 `friend.remove.*` |
| Links | 臆造「搜索链接」筛选框；标题「链接」 | 去掉搜索框；标题「外部链接」；补导入/备份/刷新 | `LinksList.vue` |
| Logs | 时间带毫秒；级别小写；target 是臆造分类；只有「导出」 | `HH:MM:SS`；`INFO/WARN/ERROR`；`gosslan::模块` 路径；补刷新/复制/打开目录/导出诊断包 | `LogViewer.vue`、`LogRows.vue` |
| Settings | 主题色用令牌色；外观行文案/顺序有偏 | 真实 6 预置色 `#2f6bff/#00b578/#ff6b35/#8b5cf6/#e53e3e/#0ea5e9` + 自定义入口 | `AppearanceSection.vue` |

### 0.2 开工前实测（2026-11-20 逐项对账代码，必读）

> **结论先行**：P1 / P2 / P3 表里列的界面改动，**代码里已经就是这个形态**。
> 原因是画板当初按源码校正（§0.1 那些"已修正"是把画板改成代码的样子），不是代码待改成画板的样子。
> 照 §2 原表逐条"实现"等于重写同一段代码——风险高、收益零。每项证据如下（行号为当前真值）。

| 项 | 方案原写 | 代码现状（证据位置） | 判定 |
| --- | --- | --- | --- |
| P1-1 列表标题/搜索/空态 | 标题改「聊天」17px、桌面 placeholder 改「搜索」、空态双分支 | `ConversationList.vue:608`（桌面标题行，`text-heading` + `nav.chats`）、`:688`（桌面 `common.search`）、`:808`/`:811`（有好友→`conv.startChat`，无好友→`common.addFriend`） | 已满足 |
| P1-2 列表页脚 | 传输队列 + 版本号，移动端抬到 TabBar 之上 | `ConversationList.vue:973`（`task.center`）、`:998`（`data-app-version`）、`:1116`（容器查询窄栏先隐藏版本号） | 已满足 |
| P1-3 标题栏全局搜索 | 加图标钮，绑定既有搜索 | `ResponsiveLayout.vue:927`（`titlebar.search` + `@click="focusSearch"` + `aria-label`） | 已满足 |
| P1-4 单聊 vs 群聊头部 | 群聊不画头像；单聊显示设备类型 + 链路徽标 | `chat/ChatHeader.vue:107`（头像 `!isGroup`）、`:118`（`deviceType`）、`:129`（对方版本更新标记）、`:143`（`linkState`） | 已满足 |
| P1-5 右键菜单 | 无「删除」；图片才「保存图片」；文本有「以代码/文本显示」 | `message/MessageContextMenu.vue:107`（`v-if="kind === 'image'"` 圈住复制/保存）、`:164`（`renderAsCode`/`renderAsText`）；全文件无 `msg.delete` | 已满足 |
| P1-6 删好友文案 | 改成可逆表述 | `i18n/locales/zh-cn.ts:1750`（聊天记录保留本地，可重新添加）、`:1751`（对方不受影响） | 已满足 |
| P1-7 外部链接页 | 标题「外部链接」；无搜索框 | `i18n/locales/zh-cn.ts:1461`；`LinksList.vue` 无 search 输入 | 已满足 |
| P1-8 日志窗 | `HH:MM:SS`、级别大写、模块路径 target | `LogViewer.vue:120`（时间格式注释与实现同源）、`utils/logFilter.ts:12`（INFO/WARN/ERROR） | 已满足 |
| P2 群任务 | 单列分组 + 筛选页签 + 两栏详情 | `GroupTasksBoard.vue` 现状即画板形态（方案 §2 P2 也写明"本轮不含代码改动"） | 无需改 |
| P3 设置 | 导航图标 + 3 分组 + 底部版本；外观 6 预置色 | `SettingsWindow.vue:181`（`NAV_GROUPS` 三组）、`:298`（每项带 `Icon`）、`:304`（底部版本）；`settings/AppearanceSection.vue:12`（6 个预置色） | 已满足 |

**这张表的用途**：开发拿到方案后先看这里，确认"没有要改的界面"再动手；真正可做的是 §0.3 的令牌收口与 §4 提案池。

### 0.3 实测后的真实剩余（P0 收口，本轮已执行）

原 P0 点名要换的三个色值 `#e6f7ef` / `#fdecef` / `#fff3e0` **在本仓库从未存在**（`git log -S` 无任何提交记录），那句话是错的，已删。
实测真实存在的"第二份数值"只有两类，都在**窗口级兜底横幅**里（这类组件最容易在改版时被漏掉）：

| 类别 | 实例 | 处理 |
| --- | --- | --- |
| 失效色兜底 | `var(--gosslan-danger, #d64545)` ×3、`var(--gosslan-success, #2f9e5f)` ×1（真值分别是 `#cf3546` / `#00aa6f`）；`var(--gosslan-on-primary, #fff)` ×3（**暗色下 token 是深墨，`#fff` 兜底是错的**） | 已全部改为纯 `var(--gosslan-*)`；令牌在 `:root` 与 `.dark` 都定义，兜底永远用不到，删掉即消除第二份真值 |
| 字号/圆角字面量 | Crash / Hang / Recovery / VersionMismatch 四个横幅 + `CodeLangMenu` 共 15 处 `font-size: NNpx` 与 4 处 `border-radius: Npx` | 已按等值映射接上令牌（12→`--gosslan-text-footnote`、13→`-callout`、11→`-caption`；8→`--gosslan-radius-sm`、6→`-xs`），**逐值相等 ⇒ 计算样式零变化** |

**刻意保留的 4 处字面量**（不是漏改，缺令牌或语义特殊）：

| 位置 | 值 | 为什么留 |
| --- | --- | --- |
| `CrashNotice.vue:172` | `18px` | 「×」字形本身的绘制尺寸，不是文字档位 |
| `CodeBlock.vue:151` | `12.5px` | 代码字号，目前没有对应的 CSS 令牌（只有 Tailwind 的 `text-fine`） |
| `settings/ChatStyleSection.vue:110` / `:134` | `11px` / `18px` | 字号滑杆两端的「A」示意字形，表示可调范围的首尾 |

> 守卫联动：`designGuards` ㊺ 会校验"登记为无人消费的令牌今天仍未被消费"。本轮把
> `--gosslan-text-callout` / `-footnote` / `-caption` 接上线后，三格名单已按守卫要求删除，
> 只留 `--gosslan-text-title`（等 265 处内联 `text-[NNpx]` 迁移）。这就是"守卫真能抓住改动"的证据。

---


## 1. 落地总原则（先读，决定后面所有取舍）

1. **单一视觉基准，不切换**：全应用一套紧凑密度，不新增 Default/Compact 开关（与 `COMPACT-STANDARD.md` 一致）。
2. **样式与行为分离**：P0 只改样式值（颜色/圆角/间距/字号），**不碰交互逻辑**；涉及交互的进 P1/P2，逐项验收。
3. **Frozen Core 不动**：msg_id / E2EE / Outbox / Ack / SQLite schema / 好友 / 文件 / 通知 / Chat UI 既有行为（`AI_PROJECT_HANDOFF.md` §7）。
4. **数值只从 `src/style.css` 取**，组件里不写字面量；改布局尺寸必须同步首屏骨架（`SK-04`）与高度估算（`messageHeight.ts` / `previewMetrics.ts`）。
5. **每个改动都可回滚**：按下方分阶段提交，每期独立可验证、可 revert。

---

## 2. 分阶段实施计划

### P0 · 视觉令牌对齐（零行为变更，1 个提交）

| 项 | 内容 |
| --- | --- |
| 目标 | 让代码里的颜色/圆角/间距与 `COMPACT-STANDARD.md` + `StyleBaseline` 完全一致 |
| 改动范围 | `src/style.css`（令牌真值）+ 4 个窗口级兜底横幅与 `CodeLangMenu` 的 scoped CSS。**§0.3 是实测清单**：原表点名的 `#e6f7ef` / `#fdecef` / `#fff3e0` 全仓从未存在，真实剩余是 7 处失效色兜底 + 15 处字号/圆角字面量 |
| 预期收益 | 全局色不再"两张皮"；暗色/亮色同一套语义；为后续所有界面改动提供稳定底座 |
| 依赖 | 无。纯样式，可先做 |
| 风险 | 改 `style.css` 会触发设计守卫；任何几何 token 变动需同步 `index.html` 内联首屏与 `skeletonTokens.ts` |
| 验收 | `node --test --experimental-strip-types src/utils/designGuards.test.ts` 全绿（含 DE-01/DE-02/SK-04）；`node scripts/check-ui-runtime.mjs --only=palette` 通过；1280 亮/暗截图对比无意外变色 |

### P1 · 画板表达纠偏落到组件（行为不变，按画板逐张）

> 前提：P0 完成。每张画板对应一个组件，独立提交，便于定位回归。
>
> ⚠️ **2026-11-20 实测：下列 8 项在代码里已全部满足**（逐项证据见 §0.2）。
> 本表从此只作"画板 ↔ 组件"的对照索引，**不要再按它改一遍代码**；真要动，先看 §0.2 的判定列。

| # | 目标界面 | 改动范围（真实文件） | 验收 |
| --- | --- | --- | --- |
| P1-1 | 会话列表标题/搜索/空态 | `src/components/ConversationList.vue`：标题 `nav.chats`=「聊天」、`text-heading`(17px)；桌面 placeholder=`common.search`；空态按有无好友分支「发起聊天/添加好友」；空态提示「按 ⌘K 搜索，按 ⌘, 打开设置」 | 1280 截图与画板一致；390 移动空态不变 |
| P1-2 | 列表页脚（最普遍漏画） | `ConversationList.vue` 底部固定行：传输队列入口（`task.center`）+ 版本号；桌面在滚动区外，移动抬到 TabBar 之上 | 列表滚动时页脚不动；`v7.x.x` 现读 `version:show` |
| P1-3 | 标题栏全局搜索按钮 | `src/layouts/ResponsiveLayout.vue` 标题栏加「全局搜索」图标钮（`titlebar.search`），绑定既有搜索动作 | 点击开搜索；`aria-label` 齐全 |
| P1-4 | 单聊 vs 群聊头部 | `src/components/chat/ChatHeader.vue`：群聊不画头像、成员数同行；单聊显示设备类型 + 链路徽标 + 版本更新标记 | 两种会话各截一张对比 |
| P1-5 | 右键菜单 | `src/components/message/MessageContextMenu.vue`：确认无「删除」；图片才「保存图片」；文本有「以代码/文本显示」 | 文本/图片各截一张；无 `msg.delete` 词条 |
| P1-6 | 删除好友文案 | `zh-cn.ts` 的 `friend.remove.*` 与 `FriendProfile.vue`：改为可逆表述 | 文案与源码一致，无「无法撤销」 |
| P1-7 | 外部链接页 | `src/components/LinksList.vue`：页头 `links.title`=「外部链接」；确认无搜索框；导入/备份/刷新齐全 | 与画板一致 |
| P1-8 | 日志窗 | `LogViewer.vue`/`LogRows.vue`：时间 `HH:MM:SS`；级别大写；target 用模块路径；「导出诊断包」 | 与画板一致；`--only=logs` 探针 |

### P2 · 群任务按真实形态重做（结构变更，需单独评审）

| 项 | 内容 |
| --- | --- |
| 现状 | `GroupTasksBoard.vue` 已是**单列分组列表 + 4 筛选页签 + 两栏详情**；画板已按此重画 |
| 改动范围 | 画板与现状对齐（本轮不含纯样式改动）；"未读回复/一键复制"已按 §4 落地，跨设备同步另立项 |
| 验收 | 画板 `Tasks.dc.html` 与 `GroupTasksBoard.vue` 逐元素核对；`todo.*` 文案一致 |

### P3 · 设置/网络分区补全（按需，低优先）

| 项 | 内容 |
| --- | --- |
| 现状 | 10 分区名称顺序已一致；差异在**图标、分组标题、左栏版本**与外观分区三处文案/顺序 |
| 改动范围 | `src/components/SettingsWindow.vue`（导航图标 + 「应用/连接与数据/其他」分组 + 底部版本）；`settings/AppearanceSection.vue`（行名「外观」、选项「关闭/减少透明」、顺序 主题色→字体、6 预置色 + 自定义）；`settings/NetworkSection.vue`（跨网段=地址列表、补公网中转/事件链路/蓝牙异常） |
| 风险 | 设置项受 `settingsManifest.ts` 约束；改键值需同步 `types.ts` 与后端 `settings.rs` |
| 验收 | 逐分区截图；`settingsManifest` 测试；改设置后即时生效 |

---

## 3. 完整闭环：每期的验收与回归命令

```bash
# 1) 设计守卫（令牌/密度/圆角/骨架同构）
node --test --experimental-strip-types src/utils/designGuards.test.ts

# 2) 运行时几何（同心圆角/列表竖线/滚动条/日志/Toast）
node scripts/check-ui-runtime.mjs --only=concentric
node scripts/check-ui-runtime.mjs --only=listmetrics
node scripts/check-ui-runtime.mjs --only=logs

# 3) 文档与画布一致性
node scripts/check-doc-citations.mjs
node /tmp/open-artifact-src/artifact-types/design/scripts/cli.mjs check designs/gosslan-compact-canvas

# 4) 本地等价门禁（动过 src/** 必跑，约 3.5 分钟）
npm run verify:local
```

**每期提交纪律**（项目既有约束）：标题行带 `[plan]`/`[impact]`；提交前 `node scripts/check-change-budget.mjs --staged` 看分级；改布局 token 的提交必须同步骨架，否则 `SK-04` 红。

**回归口径**：每期改完，按 `1280 亮 / 1280 暗 / 390 移动` 三档截图，与画板逐屏对比；差异只允许是"实现精度"，不允许是"结构不同"。

---

## 4. 提案池（原「需你先拍板」；2026-11-20 已落地两项，一项查明本就存在）

你之前提的三项群任务优化，落地情况如下（**以本节为现状真值**，别再按"产品尚无"理解）：

| 提案 | 现状 | 还缺什么 |
| --- | --- | --- |
| 详情一键复制（标题+描述，无描述只复制标题） | **已实现**：操作条复制钮；有描述 ⇒ 标题 + 空行 + 描述，无描述 ⇒ 仅标题；详情在**展示层**回填标题，编辑态仍为空 | 无 |
| 任务卡片未读回复红点 | **已实现（本机）**：标题右侧「N 条新回复」，打开详情即清并高亮这几条；游标存本机 `localStorage`（经 `utils/safeStorage`） | 跨设备一致要加「每用户每任务已读游标」到 SQLite（schema 变更，须评审）——界面不用改，只换存储层 |
| 按任务精准系统通知 | **本来就已存在**（早于本轮）：`stores/chat/notifications.ts` 里 `todoReplyConcernsMe` 闸门只放行任务关联人，fail-closed | 无（原文"无任务维度订阅"的判断有误，已更正） |

> 结论：三者都不再阻塞。唯一待立项的是"已读状态跨设备同步"，它属于数据模型工作，不属设计交接。

---

## 5. 交付物与下一步

- **设计基准**：`docs/COMPACT-STANDARD.md`（唯一标准）+ `StyleBaseline` 画板（令牌总表）。
- **画布**：29 张画板，已删除桌面不存在的 `Me`、纯提案的 `TaskCardOpt/TaskUnread/TaskDetailCopy`；`Tasks` 已按真实形态重画；`Chats/Conversation/ContextMenu/Modals/Links/Logs/Settings` 已修正臆造。
- **建议执行顺序**：P0（1 提交）→ P1-1/2/3（用户每天看到的三块）→ P1-4~8 → P3 按需 → 提案池单独立项。

**下一步等你确认**：① 是否按 P0→P1 顺序推进（P0 的令牌收口已完成、零行为变更）；② §4 只剩「已读状态跨设备同步」待立项（数据模型工作，非设计交接）。
