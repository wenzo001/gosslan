# 密度与滚动条标准（Density & Scroll Standard）

> 状态：**已落地**（2026-11-07，版本 5.18.52）。唯一来源在代码里：
> [`src/style.css`](../../src/style.css) 的「密度刻度」与「滚动条规范」两段。
> 本文是它们的**依据、刻度表与验收表**；数字漂了就由 `DE-02` 判据报红
> （`src/utils/designGuards.test.ts`）。来源编号沿用 [`sources.md`](./sources.md)。

## 0. 一句话口径

**紧凑但井然有序**：只收紧「内距 / 分组间距 / 行高下限」，不压缩字号、不压缩可点区域；
滚动条**独占一条带**，内容与带之间固定留 8px 空隙，thumb 静止可见、三态只在带内变化。

## 1. 来源（可查、带置信度）

| 结论 | 来源 | 置信度 |
| --- | --- | --- |
| 触控端最小可点目标 44×44 pt | [Apple HIG — Layout](https://developer.apple.com/design/human-interface-guidelines/layout)（2024 版，iOS/iPadOS） | A |
| macOS 控件分 regular / small / mini 三档，尺寸随控件类型而定 | [Apple HIG — Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | A |
| 滚动指示器可配置为「始终显示 / 自动 / 滚动时显示」，系统设置会改变是否预留空间 | [Apple HIG — Scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views) | A |
| 4dp 间距栅格；触控目标最小 48dp | [Material 3 — Layout](https://m3.material.io/foundations/layout/understanding-layout/spacing)、[Accessibility](https://m3.material.io/foundations/accessible-design/accessibility-basics)（2024） | A |
| 控件高度 24 / 32 / 40 三档（small / medium / large） | [Fluent 2 — Design tokens](https://fluent2.microsoft.design/)（Microsoft，2023+） | B |
| `window.density.layout = compact`：更短的标题栏、去掉 workbench 部件之间的空隙、收紧面板内部间距 | [VS Code 1.136](https://code.visualstudio.com/updates/v1_136/)、[1.141](https://code.visualstudio.com/updates/v1_141)、[Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout) | A |
| VS Code 资源管理器列表行高约 22px、树缩进约 8px | **参照量级（估算，非官方文档数值）** | E |
| 聊天类产品会话列表行高：Telegram 桌面约 72pt、微信桌面约 64pt | **参照量级（估算）** | E |
| 非文本内容（含滚动条等指示器）对比度 ≥ 3:1 | [WCAG 2.2 SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)（沿用 `sources.md` S22） | A |

> E 档 = 本仓的测量/推断，不是厂商原始参数；用作"量级参照"，不作为验收阈值。

## 2. 刻度表（token 级，全站唯一来源）

| token | 值 | 来源 | 为什么不取相邻值 |
| --- | --- | --- | --- |
| `--gosslan-card-pad` | 12px | Material 4dp 栅格的 3 倍；Fluent medium 控件（32px）上下各留 12 时，单行 20px 文字 ⇒ 44px，恰好 ≥ `row-min-h` | 16px 是旧标准，用户实测"内边距过大"；8px 会让两行文本块失去分组感 |
| `--gosslan-card-pad-inset` | 8px | VS Code 紧凑模式树缩进量级（估算 E） | 12px 与卡片行差距太小，层级拉不开 |
| `--gosslan-section-gap` | 16px | Material 4dp 的 4 倍；VS Code「收紧面板内部间距」后的量级 | 20px 是旧值；12px 会让分组标题与内容粘连 |
| `--gosslan-row-min-h` | 40px | Fluent large 控件 40px；介于 Material 48 与 HIG 44 之间（桌面非触控） | 32px 低于可点下限；48px 与画板 62/64 行高冲突且不紧凑 |
| `--gosslan-gutter` | 8px | VS Code 紧凑缩进量级（E）+ 8px 是本仓既有最小间距档 | 12px 会让滚动带吃掉内容宽度；4px 空隙不足以容纳 2px 焦点环 |
| `--gosslan-scroll-track` | 8px | 本仓既有 `::-webkit-scrollbar` 宽度；macOS 细滚动条量级（E） | 12px 过粗、占内容；6px 时 hover 加宽后仍太细 |
| `--gosslan-scroll-gap` | 8px | = `--gosslan-gutter`（共用一档，不新造） | 见上 |
| `--gosslan-scroll-inset` | 16px | `track + gap`（滚动带 + 空隙） | 标题/页脚/内容共用这条竖线，不能各算一份 |
| `--gosslan-scrollbar-thumb` | 72% | WCAG 1.4.11 ≥3:1 的最小达标值（实测亮 3.35 / 暗 4.30） | 50% 只有 2.18:1（旧值，判红）；88% 与 hover 无差别 |
| `--gosslan-scrollbar-thumb-active` | 88% | hover/拖动加深一档（亮 4.78 / 暗 5.62） | 100% 会盖过轨道层级 |
| `--gosslan-scrollbar-track` | 12% | 低于 thumb 一档但仍可辨（亮 1.18 / 暗 1.27） | 0% 时"带"不可见，用户找不到滚动条；20% 会与 thumb 抢注意力 |
| `--gosslan-scrollbar-min-thumb` | 平台原生（无 token） | `::-webkit-scrollbar-thumb` 不支持最小长度，由 WebKit 自身保证 | 不新造控制不了的 token |

## 3. 三层密度的取舍

| 层 | 是否启用 | 理由 |
| --- | --- | --- |
| 触控端（移动） | **只放宽命中区，不放大内距**：视觉仍用 12/16，命中区用透明扩展补到 ≥44px | HIG 44pt；密度收紧了视觉但手指要准 |
| 桌面常规 | **本仓默认档**（12 / 16 / 40 / 8） | 与画板缩放一致；会话列表与消息流仍是 62/64（画板 + 触控目标） |
| 桌面紧凑（可选档） | **不提供用户开关** | 用户要的是"紧凑但井然有序"，不是"多档让用户选"；再多一档会让 QA 面翻倍而收益极小 |

## 4. 滚动条规范

1. **不占内容**：滚动条只活在 `--gosslan-scroll-track`（8px）的独立带里；
   内容侧另有 `--gosslan-scroll-gap`（8px）⇒ 焦点/hover 环落在空隙内，thumb 不压文字与控件。
   `scrollbar-gutter: stable both-edges` 保证有/无滚动条时内容盒宽度逐像素相等且左右对称。
2. **找得到**：静止态 thumb 就可见（不靠滚动时浮出）；对比度见刻度表。
   轨道低一档但仍可辨，避免"一条白线突然出现"。
3. **带内变化**：hover / 拖动只把内容盒 4px → 6px（`border` 2px → 1px），总宽恒 8px ⇒ **无位移、无抖动**。
4. **可用性**：thumb 最小长度由 WebKit 原生保证；点击轨道翻页、滚轮/触控/键盘（PageUp/Down、Home/End）都由原生滚动行为提供。
5. **不叠加**：全站只用一套原生 `::-webkit-scrollbar`；Firefox 走 `scrollbar-color` 回退；
   不出现"私有滚动条 + 系统滚动条"两层。

## 5. 验收表（逐面板）

| 面板 | 滚动容器 | 独立带 | thumb 宽（静止 / hover） | 静止可见 | 对比（亮 / 暗） | 遮挡内容 |
| --- | --- | --- | --- | --- | --- | --- |
| 设置（独立窗/移动页） | `.gosslan-scroll` | 8px | 4px / 6px | 是 | 3.35 / 4.30 : 1 | 否 |
| 日志 | `.gosslan-scroll` | 8px | 4px / 6px | 是 | 3.35 / 4.30 : 1 | 否 |
| 群任务（列表 + 表单弹层） | `.gosslan-scroll` | 8px | 4px / 6px | 是 | 3.35 / 4.30 : 1 | 否 |
| 群成员 / 好友请求 | `.gosslan-scroll` | 8px | 4px / 6px | 是 | 3.35 / 4.30 : 1 | 否 |
| 搜索 | `.gosslan-scroll` | 8px | 4px / 6px | 是 | 3.35 / 4.30 : 1 | 否 |
| 收藏 | `.gosslan-scroll` | 8px | 4px / 6px | 是 | 3.35 / 4.30 : 1 | 否 |
| 转发 / 群文件 / @提醒 | `.gosslan-scroll` | 8px | 4px / 6px | 是 | 3.35 / 4.30 : 1 | 否 |
| 会话列表 / 消息流 | `.scrollbar-both` | 8px | 4px / 6px | 是 | 3.35 / 4.30 : 1 | 否（行高 62/64 不动） |

> 读数口径：带/thumb 来自 `style.css` 的 token 与 border 计算；对比度按 WCAG 2.x 公式，
> 把 `--gosslan-text-2` 以 72% / 88% / 12% 混到 `--gosslan-panel` 上计算，亮暗两个主题各算一次。
> 复现：`node scripts/check-scroll-contrast.mjs`（见 §7）。

## 6. 判据

- `SC-01`：滚动容器必须挂 `.gosslan-scroll` / `.scrollbar-both`；焦点环必须 `ring-inset`。
- `SC-02`：`track + gap = 16`；`.gosslan-scroll` 必须同时有两侧 gutter 与 `padding-inline`；反例 4 条。
- `DE-01`：密度五档成对、`row-min-h ≥ 40`；反例 2 条。
- `DE-02`：**本文表格里的数字必须与 `style.css` token 逐条相等**；反例是把文档数字改掉。
- `SK-04`：**首屏骨架与真实布局同源**（见 §8）；反例 4 条（骨架写回字面 px、真实组件改回私有数字、
  删 token、骨架引用未定义变量）。

## 7. 复现与截图

```bash
node --test --experimental-strip-types src/utils/designGuards.test.ts   # SC-01/02 + DE-01/02 + SK-04
node scripts/check-scroll-contrast.mjs                                  # 三态对比度读数
node scripts/check-ui-runtime.mjs --only=concentric                     # orb 20 / mark 8·14
```

截图（亮暗 × 特效开）落在 `test-results/ui-2026-11-07/`：设置、日志、群任务的改前/改后，
以及静止 / hover / 拖动三态的滚动条特写。

## 8. 首屏骨架同构（Boot Skeleton Parity）

> 状态：**已落地**（2026-11-07，版本 5.18.77）。用户总要求：「所有 UI 改完之后，
> 把所有界面的骨架图也同步跟现在的 UI 同步」。
>
> **口径**：骨架不是"另一套样式"，而是同一套几何在**首帧**的投影。真实布局改一格，
> 骨架必须跟着改；两边各写一份数字即视为缺陷（`SK-04` 判红）。

### 8.1 为什么不能直接写 `var(--gosslan-*)`

骨架样式由 `vite.config.ts` 的 `gosslan:inline-boot` 插件内联进每个 HTML 的 `<head>`，
**先于** `src/style.css` 执行（后者由模块脚本加载）。首帧那一刻 `--gosslan-*` 还没有定义，
直接引用会全部失效、骨架塌成一堆无高无宽的块。

因此几何走**构建时物化**：

| 步骤 | 位置 | 说明 |
| --- | --- | --- |
| ① 来源 | [`src/style.css`](../../src/style.css) `:root` | 唯一一份 `--gosslan-{title-h, header-h, rail-w, list-w, row-h-desktop, row-h-mobile, row-avatar, row-pad-x, list-title-h, search-h, nav-item, settings-nav-w, toolbar-h, radius-*, bubble-radius}` |
| ② 规则表 | [`src/boot/skeletonTokens.ts`](../../src/boot/skeletonTokens.ts) `BOOT_TOKEN_RULES` | 只声明「谁跟谁同源」与「骨架里必须出现在哪条规则」，**不写数值** |
| ③ 物化 | `vite.config.ts` → `buildBootTokens()` | 读 `style.css`，在 `skeleton.css` 的 `/* GOSSLAN_BOOT_TOKENS */` 处注入 `:root { --boot-*: … }`；任一 token 缺失 → **构建直接失败**，不静默回落 |
| ④ 消费 | [`src/boot/skeleton.css`](../../src/boot/skeleton.css) | 受管几何只许 `var(--boot-*)`，同一规则里出现字面 px 即红 |
| ⑤ 真值 | 各真实组件 | 必须引用与 `--boot-*` 同名的 `--gosslan-*`，否则骨架"同源"到一个没人用的变量，判据空转 |

### 8.2 2026-11-07 对差表（骨架改前 → 真实）

只列**会看得见**的差异；「差」是切到真界面时的位移量。

| # | 界面 | 项 | 骨架改前 | 真实（改后同源） | 差 |
| --- | --- | --- | --- | --- | --- |
| 1 | 主窗 | 窗口标题栏 | 40 | `--gosslan-title-h` 40 | 0（M-1 已修 38→40） |
| 2 | 主窗 rail | 顶部头像 | 42px 头像 + 16 间距 | **没有头像**（本人在标题栏右上） | 首项低 **58px**（+padding 14→12 ⇒ 60） |
| 3 | 主窗 rail | 入口节距 | 22 图形 + gap 16 = **38** | 44 热区 + gap 8 = **52** | 每项 14px，第 4 项累计 **42px** |
| 4 | 主窗列表 | 标题行 | **缺失** | `--gosslan-list-title-h` 50 | 整列会话低 **50px**（审查报的"跳 50px"） |
| 5 | 主窗列表 | 左上圆角 | 12 | **0**（用户：最右栏左上圆角很怪） | 12px |
| 6 | 主窗列表 | 行左右基线 | 12 / 12（列表 padding 承担） | `--gosslan-row-pad-x` 14 / 14 | 各 2px |
| 7 | 主窗列表 | 行高 | 桌面 62 / 移动 62 | 62 / **64** | 移动每行 2px，20 行累计 40px |
| 8 | 主窗列表 | 头像 / 搜索壳高 | 42 / 36 | 42 / 36 | 0 |
| 9 | 主窗列表 | 搜索壳上下留白 | 上 2 + 下 10 = **48** | 上 0 + 下 4 = **40**（`h-10 pb-1`） | 行起点高 **8px** |
| 10 | 主窗列表 | 搜索圆角 | 8 | `--gosslan-radius-md` 10 | 2px |
| 11 | 设置 | 自绘标题栏 | **缺失** | 40（`AuxWindowShell`） | 整屏上移 **40px** |
| 12 | 设置 | 左栏宽 | 176 | `--gosslan-settings-nav-w` 200 | **24px** |
| 13 | 设置 | 左栏内距 / 组间 | 8 / 2（6 条等距，无组标题） | 10 / 12，组标题 11px 字号 × 1.5 行高 = 16.5 + `pb-1` 4，组内 32 无间隙 | 首项位置 + 后续累积 |
| 13b | 设置 | 内容左右基线 | 20 | **16**（`scrollbar-gutter` 8 + `scroll-gap` 8） | 卡片右移 4px，与标题/页脚不在一条竖线 |
| 14 | 设置 | 卡片圆角 | 12 | `--gosslan-radius-lg` 14 | 2px |
| 15 | 日志 | 自绘标题栏 | **缺失** | 40 | 整屏上移 **40px** |
| 16 | 日志 | 工具条高 | 48 | `--gosslan-toolbar-h` 46 | 2px |
| 17 | 日志 | 工具条左块 | 返回键 32 + 标题 96 | live 64 + count 28（真实两个小标签） | 结构差 |
| 18 | 日志 | 工具条内距 / 间距 | 12 / 10 | 14（`px-3.5`）/ 8（`gap-2`） | 2px |
| 19 | 群任务 | 顶栏 | 48、左标题 + 右按钮 | 40、**居中** TitleBar（无按钮） | 8px + 结构差 |
| 20 | 群任务 | 内容内距 / 卡片圆角 | 12 / 12 | 16（`p-4`）/ 14 | 4px / 2px |
| 21 | 预览 | 自绘标题栏 | **缺失** | 40 | 整屏上移 **40px** |
| 22 | 预览 | 外框圆角 | 12 | 14 | 2px |
| 23 | 主窗聊天 | 输入卡 / 气泡圆角 | 22 / 20（字面） | `--gosslan-radius-2xl` 22 / `--gosslan-bubble-radius` 20 | 0（改的是同源，不是数值） |

### 8.3 四类首帧跳位（本次修掉）

1. **列表整体低 50px**：骨架缺 50px 列表标题行（#4）。这是审查报的那一条。
2. **rail 四个入口低 58–60px**：骨架多画了一个不存在的本人头像（#2）。
3. **子窗整屏上移 40px**：设置 / 日志 / 预览三个窗口的自绘 TitleBar 没画（#11 #15 #21）。
4. **群任务顶栏多 8px 且结构不对**：48px「左标题 + 右侧新建」→ 40px 居中 TitleBar（#19）。

移动端另有两条：行高必须 64（#7）、标题栏要叠加 `env(safe-area-inset-top)` 且 rail/chat 不出现。

### 8.4 判据与复现

```bash
node --test src/utils/designGuards.test.ts    # SK-02（结构锚点）+ SK-04（同源，4 条反例）
npm run build                               # 构建期缺 token 会直接失败
```

`SK-04` 反向自证（任一必须红）：把 `.boot-cap` 改回 `height: 40px`、删掉真实组件里的
`--gosslan-list-title-h`、从 `style.css` 删掉 `--gosslan-row-avatar`、骨架里写一个无来源的
`var(--boot-nope)`。

截图（骨架态 vs 加载完成态，1440×900；主窗另有 390×844）：`test-results/skeleton-sync/`，
文件名为 `{index,settings,logs,todos,preview}-{skeleton,loaded}-1440.png` 与
`index-{skeleton,loaded}-390.png`。骨架态用 `--blink-settings=scriptEnabled=false` 冻结首帧，
加载态用 dev server + `--virtual-time-budget=4000`（8000 会撞 10s 的 `UI_READY_TIMEOUT` 失败卡）。
