# 设计交接索引（Design Handoff Index）

> 用途：把「紧凑模式统一设计」这套成果交给开发，**拿到这份就能开工**。
> 状态：设计已评审、画板已对齐真实功能、方案可执行；**代码未改动**（等你确认后按分期落地）。
> 约定：本文所有 `代码路径` 均**相对仓库根**；所有 Markdown 链接**相对本文件所在目录**。

---

## 1. 五分钟上手（开发从这里开始）

```bash
# 1) 看视觉基准（唯一标准，别另造数值）
less docs/COMPACT-STANDARD.md

# 2) 看落地怎么改（分期 + 验收）
less docs/compact-design-landing-plan.md

# 3) 打开设计画布（可点开每张画板看真实界面）
node /tmp/open-artifact-src/artifact-types/design/scripts/cli.mjs open \
  designs/gosslan-compact-canvas --type design --title "Gosslan 紧凑模式统一设计" --json
```

> 画布服务由上面命令在后台启动并打印 `url`；页面里按「01 标准 / 02 桌面核心 / 03 浮层 / 04 辅助窗口 / 05 移动端」五个页签切换。

---

## 2. 必读文档（按顺序，前两份是核心）

| 顺序 | 文档 | 用途 | 状态 |
| --- | --- | --- | --- |
| ① 必读 | [`docs/COMPACT-STANDARD.md`](COMPACT-STANDARD.md) | **唯一视觉/交互标准**：令牌、字号、圆角、密度、九维度规范、验收口径 | 已完成 |
| ② 必读 | [`docs/compact-design-landing-plan.md`](compact-design-landing-plan.md) | **落地实施方案**：P0~P3 分期、每期改哪些文件、验收与复跑命令 | 已完成 |
| ③ 参照 | [`docs/design-guidelines.md`](design-guidelines.md) | 视觉总规范：圆角/交互态/配色/骨架/无障碍/导航（已核对圆角为真值 6/8/10/14/20） | 既有，已同步 |
| ④ 参照 | [`docs/design-language/density-and-scroll.md`](design-language/density-and-scroll.md) | 密度刻度与滚动条规范（DE-02 判据对账源） | 既有，已纠偏 |
| ⑤ 索引 | [`docs/design-language/README.md`](design-language/README.md) | 设计语言文档地图 | 既有，已加新标准入口 |
| ⑥ 边界 | [`../AI_PROJECT_HANDOFF.md`](../AI_PROJECT_HANDOFF.md) · [`../AI_RULES.md`](../AI_RULES.md) | Frozen Core 红线、UI 守卫、提交纪律 | 既有 |

---

## 3. 设计画布（29 张画板，全部已对齐真实功能）

画布根目录：`designs/gosslan-compact-canvas/project/`。每张 `.dc.html` 即一个界面。

### 01 标准与令牌（designs/gosslan-compact-canvas/project/）

| 画板 | 内容 |
| --- | --- |
| `StyleBaseline.dc.html` | 样式与交互统一基准（亮暗色表 + 字号 + 圆角 + 密度 + 交互模式） |
| `Foundations.dc.html` | 设计令牌总览 |
| `Density.dc.html` | 紧凑密度规范 |
| `Components.dc.html` | 控件规格（3 语义 × 4 尺寸） |

### 02 桌面核心

| 画板 | 对应界面 |
| --- | --- |
| `Chats.dc.html` | 会话列表 + 空态（可点 rail 切换） |
| `Conversation.dc.html` | 单聊会话（共享目录 + 设备类型 + 链路） |
| `GroupChat.dc.html` | 群聊会话（成员/文件/任务/同步） |
| `Contacts.dc.html` | 通讯录 |
| `Links.dc.html` | 外部链接 |
| `Favorites.dc.html` | 收藏（两栏） |
| `FriendProfile.dc.html` | 好友资料 |

### 03 浮层与面板

| 画板 | 对应界面 |
| --- | --- |
| `ContextMenu.dc.html` | 消息右键菜单（真实项，无删除） |
| `Search.dc.html` | 聊天记录搜索 |
| `Forward.dc.html` | 转发弹窗 |
| `GroupPanels.dc.html` | 群管理面板 |
| `Network.dc.html` | 网络拓扑 |
| `Modals.dc.html` | 确认弹窗（删好友真实可逆文案） |
| `Composer.dc.html` | 输入区与表情浮层 |

### 04 辅助窗口

| 画板 | 对应界面 |
| --- | --- |
| `Settings.dc.html` | 设置 · 外观（10 分区 + 真实主题色） |
| `SettingsNetwork.dc.html` | 设置 · 网络 |
| `Logs.dc.html` | 运行日志（真实工具条 + 导出诊断包） |
| `StartupError.dc.html` | 启动错误 |
| `Tasks.dc.html` | 群任务（单列分组列表 + 筛选页签 + 两栏详情） |

### 05 移动端与状态

| 画板 | 对应界面 |
| --- | --- |
| `MobileChats.dc.html` | 移动 · 会话列表 |
| `MobileConversation.dc.html` | 移动 · 聊天 |
| `MobileMe.dc.html` | 移动 · 我的 |
| `MobileEmpty.dc.html` | 移动 · 空态 |
| `DarkMode.dc.html` | 暗色主题 |
| `States.dc.html` | 状态与反馈（Toast/骨架/空错态） |

> 索引文件：`designs/gosslan-compact-canvas/project/canvas.json`

---

## 4. 执行计划（详见落地方案 §2）

| 期 | 目标 | 是否动行为 | 关键文件 |
| --- | --- | --- | --- |
| **P0** | 视觉令牌对齐（颜色/圆角/间距换成 token） | 否 | `src/style.css` |
| **P1** | 8 项画板纠偏落组件（标题/页脚/全局搜索/单聊头/右键菜单/删好友/链接/日志） | 轻微 | `ConversationList.vue`、`ResponsiveLayout.vue`、`ChatHeader.vue`、`MessageContextMenu.vue`、`LinksList.vue`、`LogViewer.vue`、`zh-cn.ts` |
| **P2** | 群任务——现状已对，无需改代码 | 否 | `GroupTasksBoard.vue` |
| **P3** | 设置分区补图标/分组/版本 | 轻微 | `SettingsWindow.vue`、`AppearanceSection.vue`、`NetworkSection.vue` |

---

## 5. 验收命令速查（每期提交前跑）

```bash
# 设计守卫（令牌/密度/圆角/骨架同构）
node --test --experimental-strip-types src/utils/designGuards.test.ts

# 运行时几何
node scripts/check-ui-runtime.mjs --only=concentric
node scripts/check-ui-runtime.mjs --only=listmetrics

# 文档引用 + 画布
node scripts/check-doc-citations.mjs
node /tmp/open-artifact-src/artifact-types/design/scripts/cli.mjs check designs/gosslan-compact-canvas

# 本地等价门禁（动过 src/** 必跑，约 3.5 分钟）
npm run verify:local
```

---

## 6. 红线与约定（违反会被守卫拦）

1. **单一标准，不切换**：一套紧凑密度，不加「默认/紧凑」开关。
2. **数值只从 `src/style.css` 取**：组件不写字面量；改布局尺寸必须同步首屏骨架（`SK-04`）与 `messageHeight.ts` / `previewMetrics.ts`。
3. **Frozen Core 不动**：msg_id / E2EE / Outbox / Ack / SQLite schema / 好友 / 文件 / 通知 / Chat UI 既有行为。
4. **提交纪律**：标题行带 `[plan]`/`[impact]`；改设置键值要同步 `types.ts` 与后端 `settings.rs`。
5. **圆角真值**：6/8/10/14/20/22（输入外壳 22、composer 控件 9）；同心 = 外 − 间距。

---

## 7. 待确认（不阻塞 P0/P1）

| 项 | 说明 |
| --- | --- |
| **方案清单已过期（2026-11-20 实测）** | 落地方案 §0.2 已逐项对账：P1/P2/P3 列出的界面改动**代码里全部已存在**，不要再按原表改一遍。真正可做的是 §0.3（已完成的令牌收口）与 §4 提案池 |
| scoped CSS 字号不在守卫面 | `designGuards` ㊿ 只扫 Tailwind 的 `text-[NNpx]`；`<style>` 里的 `font-size: NNpx` 目前靠人审。要机器守住需新增一条扫描（先登记豁免再清零） |
| 半档字号 `fine` / `row` | 按画板登记在 `tailwind.config.js`（12.5 / 14.5）。是否收回 12 / 15 属视觉决策，未动 |
| 群任务「一键复制」 | **已实现**：操作条复制钮，有描述复制"标题+空行+描述"、无描述只复制标题；详情展示层回填标题但编辑态仍空 |
| 任务未读回复红点 | **已实现（本机）**：标题右侧计数 + 打开详情高亮并清零；游标存本机（`utils/todoReplySeen`）。跨设备要加表（schema 变更，须评审） |
| 按任务精准通知 | **本来就已存在**：`todoReplyConcernsMe` 只放行任务关联人（fail-closed），本轮未改 |
| 桌面「我的」页 | 产品当前**没有**此页（点头像直接进设置），画板已删除；若确需新增再单独立项 |
