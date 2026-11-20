# Gosslan 紧凑模式统一标准（Compact Mode Standard）

> 状态：**强制 · 单一标准 · 不提供切换开关**（2026-11-20 用户裁决）
> 对标基准：VS Code 1.147.0（commit 8a14f0c，2026-11-17）紧凑模式 + 现代化 UI
> 定位：本文是「紧凑、密度、间距、间距相关布局」这一维度的**唯一执行标准**。
> 数值事实源永远是 [`src/style.css`](../src/style.css) 里的 `--gosslan-*` token；
> 本文只写「用哪个 token、档位含义、怎么验收」，**不复写可被机算的数字**
> （与 `check-doc-numbers.mjs`「能被现算的数字不许留第二份手抄」同一立场）。
>
> 与既有文档的关系（冲突裁决顺序见 §1）：
> - [`docs/design-guidelines.md`](design-guidelines.md) —— 视觉与交互**总规范**（圆角、交互态、配色、骨架、无障碍、导航等），仍然有效。
> - [`docs/design-language/`](design-language/) —— 研究基线与依据（玻璃、控件、动效、密度刻度、UX 约束、来源）。
> - 本文 —— 把上述文档中「密度/紧凑/全局统一」的部分**收敛为一份可执行标准**，并补上对标 VS Code 1.147 的取舍结论。
> - 落地怎么改代码：见 [`docs/compact-design-landing-plan.md`](compact-design-landing-plan.md)（分阶段、含验收与复跑命令）。
> - 交接给开发的完整索引（文档 + 画板 + 执行入口）：见 [`docs/DESIGN-HANDOFF.md`](DESIGN-HANDOFF.md)。
> - 三者的数值必须一致；若发现不一致，动机是本文把漂移纠正，然后同步回各自的唯一事实源。

---

## 1. 裁决顺序与红线（先读这条）

```
稳定性 > 流畅性 > 正确性 > 原生体验 > 安全性 > 可维护性 > 扩展性 > 视觉像不像
```

- **单一标准，不做档位切换**：全应用只有这一套紧凑密度，设置页**不新增**「默认 / 紧凑」开关。
  VS Code 的 `window.density.layout` 是双档设置，本项目按用户裁决只取其中 compact 一档作为默认值，
  理由见 §3.1。任何「再加一档让用户选」的提案都视为违反本标准。
- **Frozen Core 不动**：msg_id / E2EE / Outbox / Ack / SQLite schema / 好友 / 文件 / 通知 /
  **Chat UI 的既有行为**（见 [`AI_PROJECT_HANDOFF.md`](../AI_PROJECT_HANDOFF.md) §7、
  [`AI_RULES.md`](../AI_RULES.md) §31）。本文所有条目只约束**表现层**，不改这些语义。
- **行为优先于像素**：会话行高、TabBar 四项、双 CTA、上传下载入口等既有交互习惯不变
  （对齐 [`docs/design-language/ux-criteria.md`](design-language/ux-criteria.md) 的 G-9）。
- **数值唯一源**：新增或修改任何间距/字号/圆角/高度，先改 token，再改消费方引用；
  禁止在组件里写字面量后回头改文档。

---

## 2. 对标基准：VS Code 1.147  Compact Mode 的准确事实

> 来源：官方 release notes 1.136 / 1.147、官方 Custom Layout 文档、官方博客
> 《现代化 VS Code UI》(2026-10-15)。逐条出处见 §8。

### 2.1 它是什么（一个前提 + 四个机制）

Compact 不是「一个把 UI 变小的开关」，而是 Modern UI 体系下的**布局密度**选项：

| 机制 | 官方设置 | 官方定义 |
| --- | --- | --- |
| 启用前提 | `workbench.experimental.modernUI` | 1.147 仍标记 experimental，官方计划最终退役经典 UI |
| 布局密度 | `window.density.layout: default\|compact` | compact = 去掉面板之间的间距 + 收紧面板内部间距；即时生效、重启保留 |
| 尺寸自定义（1.147 新增） | `workbench.sizeCustomizations` | 面板圆角 0–8px、面板间距 0–16px；**紧凑布局恒为 gapless**，此设置不改控件/标签/原生窗口圆角 |
| 活动栏尺寸 | `workbench.activityBar.compact` | 更窄的活动栏匹配经典外观，释放水平空间；活动栏置顶/置底时不可用 |
| 标签样式（1.147 从编辑器扩展到面板/侧栏） | `workbench.experimental.modernUIEditorTabStyle: connected\|pill` | 连接式：选中标签与下方内容表面连成一体；默认 connected |

> ⚠️ 引用纠偏：官方对 compact 的定义是**两条**（去面板间距、收面板内距）。
> 本仓 [`docs/design-language/density-and-scroll.md`](design-language/density-and-scroll.md) 与
> [`src/style.css`](../src/style.css) 密度注释里写的「三条（含更短的标题栏）」与官方不符——
> 标题栏样式在 VS Code 属 `window.titleBarStyle` 的另一套设置。本次已据实修正（见 §6）。

### 2.2 它遵循的体验原则（这部分比数值更值得借鉴）

1. **信息密度是硬指标**：官方博客原话——「更宽裕却看见更少代码不算改进」。紧凑密度专为小屏、信息密集工作流设计。
2. **共享命名令牌**：间距/尺寸/颜色用命名值而非各组件各写一份，这是「一套令牌支撑多密度与多主题」的前提。
3. **选中态与内容连成一体**：连接式标签的设计理由——让活动文件与它的内容显示为连续区域，恢复清晰的层级提示。
4. **一致性跨窗口**：编辑器窗口与 Agent 窗口共用排版/间距/颜色/标签/控件，切换工作方式时不像换了产品。
5. **不牺牲肌肉记忆与自定义**： Density 可回退、标签样式可切回 pill、经典 UI 过渡期保留。
6. **性能是约束**：官方用组件状态类替换宽泛 CSS 选择器，样式重算时间 −8.2%，并加 lint 规则 + `perf:css` 基准防回归。

### 2.3 本项目的裁剪决策

| 官方做法 | 本项目 | 理由 |
| --- | --- | --- |
| `window.density.layout` 双档切换 | **只取 compact 一档，写死为默认** | 用户裁决「只需要一个样式标准不需要切换」；原 `density-and-scroll.md` §3 也已写明不提供开关 |
| `sizeCustomizations` 圆角/间距自定义 | **不开放给用户** | 圆角与间距是设计系统内部令牌，开放自定义会破坏同心公式与 `designGuards` 守卫 |
| `activityBar.compact` 两档 | **rail 固定一档** | 现有 64px rail + 44px 热区已被守卫钉住，属 Frozen 交互习惯 |
| `connected` / `pill` 标签切换 | **只取连接式的视觉语义**，且只用于「选中态与内容连贯」 | 本项目无编辑器标签；借鉴的是层级逻辑，不是控件 |
| 可停靠面板、多编辑器组、Command Palette、Zen Mode | **不引入** | 产品形态不同（Tauri 一窗一文档，见 [`docs/adr/0018-window-architecture.md`](adr/0018-window-architecture.md)）；属产品形态改造而非体验对齐 |

---

## 3. 全局标准（按维度，逐条可验收）

> 每维度给三列：**标准**（要做什么）、**唯一事实源**（数字/实现在哪）、**验收**（怎么证明没跑偏）。
> 本文不写可被机算的 px 值；需要读数时按 §7 的复跑命令现算。

### 3.1 界面密度与间距

| 标准 | 唯一事实源 | 验收 |
| --- | --- | --- |
| 只有一档紧凑密度：`card-pad` / `card-pad-inset` / `section-gap` / `row-min-h` / `gutter` 五个刻度 | [`src/style.css`](../src/style.css)「密度刻度」段；依据与刻度表见 [`docs/design-language/density-and-scroll.md`](design-language/density-and-scroll.md) | `node --test --experimental-strip-types src/utils/designGuards.test.ts` 的 `DE-01/DE-02` 全绿 |
| 会话列表与消息流**不消费**密度刻度：行高由画板定，同时是触控目标 | `--gosslan-row-h-desktop` / `--gosslan-row-h-mobile` in [`src/style.css`](../src/style.css) | `docs/design-language/density-and-scroll.md` 验收表；390 截图 |
| 内容页不许写卡片级字面量（`px-4 py-3` / `p-4` 等） | `designGuards.findRawCardPadding` | 守卫扫描 0 命中 |
| 面板之间保持 gapless（对标 compact「去掉部件间距」），收紧只发生在面板内部 | 布局外壳 [`src/layouts/ResponsiveLayout.vue`](../src/layouts/ResponsiveLayout.vue) | 1280 亮/暗截图，无多余分隔带 |

### 3.2 字号与排版

| 标准 | 唯一事实源 | 验收 |
| --- | --- | --- |
| 字号分两层：**正文与控件走五档**（`caption` / `footnote` / `callout` / `body` / `title`，**下限 11px**）；**页面级版面档**（`heading` / `page` / `title-lg` / `display`，以及列表行名 `row`、次行 `fine`）必须已在 [`tailwind.config.js`](../tailwind.config.js) 的 `fontSize` 表登记，不许随手写中间值。字重只用 400/500/600；字号与行高成对 | [`src/style.css`](../src/style.css)「排版标尺」段 + [`tailwind.config.js`](../tailwind.config.js) 的 `fontSize`；[`docs/design-guidelines.md`](design-guidelines.md) §8 | 提交前 checklist（design-guidelines §6）；`designGuards` ㊿ 扫生产码的 `text-[NNpx]`（0 处）。⚠️ **scoped CSS 里的 `font-size: NNpx` 不在 ㊿ 的扫描面**（它只认 Tailwind 任意值写法），新增时必须人审 |
| 消息正文字号用户可调（`xs/sm/md/lg/xl`），通过 `--gosslan-msg-size` 覆盖，不改其它档 | `--gosslan-msg-size` in [`src/style.css`](../src/style.css)；`utils/chatStyle.ts` | `⌘=/⌘-` 只挪消息字号，五档边界正确 |
| 不用 `vw` 字号、不用负 letter-spacing、不写 9/10/13.5 这类中间值 | 同上 | 源扫描 |

### 3.3 图标

| 标准 | 唯一事实源 | 验收 |
| --- | --- | --- |
| 唯一出口 [`src/components/ui/Icon.vue`](../src/components/ui/Icon.vue)；造型统一 lucide（24 网格、2px 圆头描边），登记在同目录 `iconRegistry.ts` | `Icon.vue` 组件注释 | 新图标必须进 registry，不许组件内直接 import lucide |
| 尺寸只走消费方 class（`h-4 w-4`=16 / `h-5 w-5`=20 / `size-6`=24 / 导航 23·21）；只有 `:stroke-width` 可局部覆盖 | 同上 | 无 `size` prop 调用 |
| **图标按钮必须有 `aria-label`**（`title` 不算）；选中态靠外层底色，不混填充图标 | [`docs/design-guidelines.md`](design-guidelines.md) §10.2；`utils/a11yLabels.ts` | `designGuards` + `a11yLabels` 全库扫描 0 命中 |

### 3.4 侧边栏 / 导航 / 面板

| 标准 | 唯一事实源 | 验收 |
| --- | --- | --- |
| 桌面三栏：NavRail + 会话列表 + 聊天；移动端单栏 + 底部 TabBar 四项 | [`src/layouts/ResponsiveLayout.vue`](../src/layouts/ResponsiveLayout.vue)、[`src/components/NavRail.vue`](../src/components/NavRail.vue) | G-9：TabBar 四项、会话行高不变 |
| rail 与列表宽度、导航热区走 token，组件只读变量 | `--gosslan-rail-w` / `--gosslan-list-w` / `--gosslan-nav-item` in [`src/style.css`](../src/style.css) | 首屏骨架与实际布局同源（`SK-04`） |
| 面板/浮层只有在**选中态与内容连贯**上借鉴 VS Code 连接式语义；不新增可停靠/拆分面板 | 本文 §2.3 裁剪表 | Code Review：无 dock/split 实现 |
| 辅助窗口（设置/日志/预览/待办）仍是 Tauri 独立单例窗口，非 dockable panel | [`docs/adr/0018-window-architecture.md`](adr/0018-window-architecture.md) | 架构判据 |

### 3.5 选中态与标签（对标点）

| 标准 | 唯一事实源 | 验收 |
| --- | --- | --- |
| 选中项与它所属的内容区视觉连贯（导航选中药丸、列表选中行），层级清晰不脱节 | [`src/components/NavRail.vue`](../src/components/NavRail.vue) 常驻节点 + transform；会话列表选中行 token `--gosslan-list-active` | 1280 亮/暗截图：选中项与内容无割裂感 |
| 不引入编辑器式标签栏、置顶标签、多编辑器组 | 本文 §2.3 | Code Review |

### 3.6 命令入口

| 标准 | 唯一事实源 | 验收 |
| --- | --- | --- |
| 应用级动作走统一分发 `APP_ACTION`（设置 / 加好友 / 搜索 / 日志），原生菜单、快捷键、通知点击同源 | [`src/utils/appActions.ts`](../src/utils/appActions.ts) | `emitAction` 是唯一入口 |
| **不引入 Command Palette / 命令注册表**：产品搜索就是搜索，不是命令面板 | [`docs/architecture/open-source-replacement-matrix.md`](architecture/open-source-replacement-matrix.md) 的 Reka `CommandRoot` 结论 | 无 cmdk 类新依赖（G-4） |
| 自定义右键菜单保持现状，Webview 默认右键在有选区时放行 | [`src/App.vue`](../src/App.vue) 的全局右键处理 | 手动回归 |

### 3.7 状态反馈

| 标准 | 唯一事实源 | 验收 |
| --- | --- | --- |
| Toast 走统一管理器：成功/信息/错误三态，同文案合并 ×N，同屏 ≤2；错误结论 + 一句人话原因 | `utils/toastManager.ts`；G-16；[`docs/design-language/ux-criteria.md`](design-language/ux-criteria.md) | `errors.test.ts` 的 `buildToastText` 护栏 + `--only=toast` 探针 |
| 无传统底部状态栏；连接状态在 ChatHeader 内按链路显示，系统级事件用不压内容的横幅 | [`src/components/chat/ChatHeader.vue`](../src/components/chat/ChatHeader.vue)、[`src/App.vue`](../src/App.vue) 的 `CrashNotice` 等 | 手动回归 |
| 异步交互具备加载/成功/失败/取消四态且不阻塞 UI（对标 VS Code 状态反馈的克制） | G-8 | 探针 + Code Review |
| 状态栏/头部信息密度：间距收紧但不牺牲可读性；不新增第二个强调色 | 本文 §2.2 原则 1；G-12 | 截图对照 |

### 3.8 快捷键

| 标准 | 唯一事实源 | 验收 |
| --- | --- | --- |
| 主修饰键 + 单字符；不抢 ⌘C/V/A/X；alt/shift 按下或输入法组字时放行 | [`src/utils/shortcuts.ts`](../src/utils/shortcuts.ts)、[`src/composables/useShortcuts.ts`](../src/composables/useShortcuts.ts) | 现有常量测试 |
| **⌘K 保持搜索语义，不改成 chord 前缀**（与 VS Code `⌘K Z` 冲突时以本项目为准） | 本文 §1「行为优先于像素」+ 用户裁决 | 手动回归 `⌘K` / `⌘F` 均聚焦搜索 |
| macOS 原生菜单键位（设置 `⌘,`、加好友 `⌘N`、搜索 `⌘F`、关窗 `⌘W`）保持一致 | [`src-tauri/src/menu.rs`](../src-tauri/src/menu.rs) | 原生菜单回归 |
| 不照搬 VS Code 的 Zen / 全屏 / 面板移动等编辑器快捷键 | 本文 §2.3 | Code Review |

### 3.9 动效与无障碍（全局统一的一部分）

| 标准 | 唯一事实源 | 验收 |
| --- | --- | --- |
| 一条 ease、只动 color/bg/border/opacity/transform；同屏 glass ≤3 层 | [`docs/design-language/motion-system.md`](design-language/motion-system.md)、G-14 | `receiptMotion.test.ts`、`designGuards` |
| `prefers-reduced-motion` / `prefers-reduced-transparency` / `forced-colors` / 高对比全覆盖；应用内有对应开关 | [`src/style.css`](../src/style.css) 媒体查询段；[`docs/design-language/theme-contrast.md`](design-language/theme-contrast.md) | 系统设置切换回归 |
| 焦点环走 `--gosslan-focus-ring`，文本输入用 1px 内描边不加外框；`title` 不作为无障碍标签 | [`docs/design-guidelines.md`](design-guidelines.md) §10 | `a11yLabels` + 键盘遍历 |
| 同屏不混线性与填充图标；hover 只做轻微加深，不位移不缩放 | 本文 §3.3、§2.2 | 截图对照 |

---

## 4. 全局统一的一致性矩阵（G-6：桌面/移动/深色同一套语言）

| 维度 | 1280 亮 | 1280 暗 | 390 移动 | 判据 |
| --- | --- | --- | --- | --- |
| 字号档位 | 同一套五档 token | 同 | 同（正文不缩到 11 以下） | `designGuards` |
| 圆角 / 间距 | 同一套 `--gosslan-radius-*` / 密度刻度 | 同 | 同 | `check-ui-runtime.mjs --only=concentric,listmetrics` |
| 控件规格 | 3 语义 × 4 尺寸 | 同 | 触控命中区 `.tap-safe` 补到 44 | [`docs/design-language/controls.md`](design-language/controls.md) |
| 图标尺寸 / 描边 | 16/20/24 · 2px | 同 | 导航 21 | `Icon.vue` |
| 状态反馈 | toast ≤2、同文案合并 | 同 | 390 底部不压页头 | G-16 探针 |

---

## 5. 落地清单（现状 → 目标）

| 项 | 现状 | 目标 | 优先级 |
| --- | --- | --- | --- |
| 紧凑密度五档 token | 已落地（card-pad 12 / inset 8 / section-gap 16 / row-min-h 40 / gutter 8） | 保持；数值只读 `src/style.css` | P0 保持 |
| 标题栏收紧 | 已落地（52px 头部 + 40px caption，历史从 56 收紧） | 保持 | P0 保持 |
| 首屏骨架同源 | 已落地（`SK-04` 构建期物化） | 保持；改任何几何 token 必须同步 | P0 保持 |
| 文档引用偏差（compact「三条」） | `density-and-scroll.md` 与 `style.css` 注释写「三条」，官方为两条 | 本次已据实修正为两条 + 标题栏另属 `titleBarStyle` | P0 纠偏（本次） |
| 总规范圆角表漂移 | `design-guidelines.md` §1.2 写 4/6/8/12/16，实际 token 为 6/8/10/14/20 | 本次已同步为真值，并标注 2xl=22 | P0 纠偏（本次） |
| 窗口级兜底横幅的令牌收口 | Crash / Hang / Recovery / VersionMismatch 四个横幅 + `CodeLangMenu`：15 处字号、4 处圆角字面量，7 处带旧值的色兜底 | 已按等值映射接上令牌（计算样式不变）；剩 4 处语义特殊或缺令牌，已在落地方案 §0.3 注明 | P0 已落地（2026-11-20） |
| 选中态与内容连贯性审视 | 导航药丸 + 列表选中行已存在 | 按 §3.5 复查层级清晰度，仅样式语义微调 | P1 |
| 状态栏信息密度复查 | 无底部状态栏、连接态在头部 | 按 §3.7 复查窄屏容纳量 | P1 |
| 性能护栏（密度改动的防回归） | 有 CSS 选择器 lint 的基础 | 借鉴 VS Code `perf:css` 思路，纳入密度相关改动的验收 | P1 评估 |

---

## 6. 本次纠偏记录（2026-11-20）

审核中发现两处「文档 ≠ 事实」的漂移，均已就地修正（只改文档/注释文字，不改任何 token 值或代码逻辑）：

1. **compact 定义条数**：[`docs/design-language/density-and-scroll.md`](design-language/density-and-scroll.md) 来源表与
   [`src/style.css`](../src/style.css) 密度注释原写「三条（含更短的标题栏）」，官方 1.136 / 1.147 / Custom Layout 文档为两条。已改为两条，并注明标题栏样式另属 `window.titleBarStyle`。
2. **圆角梯度表**：[`docs/design-guidelines.md`](design-guidelines.md) §1.2 原写 4/6/8/12/16px，与 `src/style.css` 实际 token 6/8/10/14/20px 不符。已同步为真值并补 `--gosslan-radius-2xl`（输入外壳 22px）。

两处均不进 `check-doc-numbers.mjs` 的 LIVE_DOCS 对账，也不改 DE-02 对账的刻度表数字行，故不触红；修正后由本文统一引用真值。

---

## 7. 验收命令集（复跑口径）

```bash
# 密度/字号/圆角/骨架：设计守卫（含 DE-01/DE-02/SC/LH/SK-04）
node --test --experimental-strip-types src/utils/designGuards.test.ts

# 运行时几何：同心圆角、列表竖线、分栏把手、滚动条带
node scripts/check-ui-runtime.mjs --only=concentric
node scripts/check-ui-runtime.mjs --only=listmetrics

# 文档数字与引用对账
node scripts/check-doc-numbers.mjs
node scripts/check-doc-citations.mjs

# 文档路径与领域图
node scripts/check-domain-map.mjs

# 全套本地等价门禁（约 3.5 分钟；动过 src/** 时必跑）
npm run verify:local
```

> 截图取证落 `test-results/ui-shots/`，亮暗 × 特效开关；文档历史证据图只读、不覆盖。

---

## 8. 参考来源与信息边界

### 8.1 一手来源

- VS Code 1.136 release notes（layout density 首次引入）：`code.visualstudio.com/updates/v1_136`
- VS Code 1.147 release notes（sizeCustomizations、连接式面板标签）：`code.visualstudio.com/updates/v1_147`
- 官方 Custom Layout 文档（density、activityBar.compact、pinned tabs、布局命令与键位）：`code.visualstudio.com/docs/configure/custom-layout`
- 官方博客《现代化 VS Code UI》，Lee Murray，2026-10-15（体验原则、性能数据、迁移方向）

### 8.2 信息不足处（刻意不写死）

- VS Code **未公开**间距/字号/图标的精确 px 数值表（设计令牌在主题作者文档 `modernUI/README.md`，非用户规范）；状态栏间距只有定性描述。因此本文只借鉴**原则与机制**，不写「照抄某 px」。
- 官方命令行键位在可打印 PDF 内，`⌘⇧P` / `⌘P` 等按长期默认处理，标为参考而非硬约束。

### 8.3 待确认（不阻塞本文执行）

- `density-and-scroll.md` 曾引用「VS Code 1.141」，本轮未抓取该版本 release notes；「更短标题栏」是否在 1.141 出现尚未定论。本次按官方 1.136 与 1.147 一致口径（两条）修正；如后续查得 1.141 原文不同，再据实回调。
