# 玻璃层实现规格（Liquid Glass for Gosslan）

> 本文给的是**Gosslan 的目标规格**，不是 Apple 参数的原样复刻。Apple 没有公开 Liquid Glass 的模糊半径与 alpha 数值，所有数字都是结合本仓可读性、性能预算后的设计决策，置信度见 [sources.md](./sources.md)。
> 标记：`[官方]` 有公开资料明确支持；`[推断]` 本文的设计判断。

## 1. 先判断：这块该不该用玻璃

Apple HIG 的原话是 Liquid Glass 属于 controls / navigation 层，**不要用在 content layer**。`[官方]` 本仓据此划线：

| 层 | 职责 | 材料 | 例子 | 允许玻璃 |
| --- | --- | --- | --- | --- |
| L0 ambient | 应用环境底色 | 不透明、极淡渐变 | body / 窗口底 | 否 |
| L1 content | 用户内容 | 实色 | 消息列表、气泡、代码块、图片、设置正文、表格 | 否 |
| L2 chrome | 持续可见的导航 | `glass-1` | 标题栏、侧栏、会话列表头、移动端 TabBar、输入区外框 | 是 |
| L3 float | 短暂浮层 | `glass-2` | 下拉、右键菜单、Popover、Toast、搜索建议 | 是 |
| L4 modal | 阻塞浮层 | `glass-3` + scrim | Dialog、ActionSheet、全屏面板 | 是 |

三条硬规则：

1. 同屏最多 **3 层玻璃**（L2 / L3 / L4），不允许玻璃套玻璃。
2. 同屏同时可见的玻璃元素最多 **8 个**。
3. 玻璃元素面积不超过视口面积的 **40%**；超过就改实色。

### 1.1 其他成熟体系怎么取舍

| 体系 | 核心做法 | 适合 | 代价 | 本仓采用 |
| --- | --- | --- | --- | --- |
| Liquid Glass（iOS/macOS 26） | 光学玻璃：反射/折射、亮度自适应、regular/clear 两档 | controls / navigation | 参数不公开，逐帧内容感知在 Web 端不可行 | 借分层规则、regular/clear 取舍、35% dimming；不做折射 |
| Material 3 Expressive | 色调面 + 状态层 + motion springs + 形状梯度 | Android 与 Web 控件 | 没有玻璃；层级靠颜色与形状，不靠模糊 | 借状态层与 4 档尺寸/圆角梯度 |
| Windows Mica | 不透明、只采样壁纸一次、长生命周期窗口 | 桌面窗口背景 | Web 无法采样系统壁纸；本身不透明 | 借“长期存在的大面用实色” |
| Windows Acrylic | 半透明 + blur + noise + exclusion blend + tint | context menu / flyout 等短暂表面 | GPU 重；节能/关闭透明时自动降级 | 借“float 才用玻璃”，以及自动回退思路 |
| 主流 Web `backdrop-filter` | 半透明底 + blur + saturate + 1px 描边/高光 + 柔和阴影 | 所有 WebView | 合成层与重绘开销；受 backdrop root 限制 | 本文的落地方式 |

结论：**不照搬任何一家**。本仓取 Liquid Glass 的分层与克制、M3 的状态层与尺寸梯度、Mica/Acrylic 的“长期面 vs 短暂面”划分，用 Web 能做到的四层玻璃实现。


## 2. 三档玻璃的数值规格

### 2.1 光态（light）

| Token | blur | saturate | 背景 | 1px 描边 | 顶部高光 | 外阴影 |
| --- | --- | --- | --- | --- | --- | --- |
| `surface/glass-1` | 16px | 140% | `rgba(255,255,255,.82)` | `rgba(255,255,255,.52)` | `rgba(255,255,255,.60)` | `0 1px 2px rgba(15,23,42,.04), 0 8px 24px rgba(15,23,42,.08)` |
| `surface/glass-2` | 20px | 160% | `rgba(255,255,255,.88)` | `rgba(255,255,255,.60)` | `rgba(255,255,255,.70)` | `0 4px 12px rgba(15,23,42,.10), 0 16px 40px rgba(15,23,42,.12)` |
| `surface/glass-3` | 24px | 140% | `rgba(255,255,255,.94)` | `rgba(255,255,255,.70)` | `rgba(255,255,255,.75)` | `0 24px 64px rgba(15,23,42,.18)` |

### 2.2 暗态（dark）

| Token | blur | saturate | 背景 | 1px 描边 | 顶部高光 | 外阴影 |
| --- | --- | --- | --- | --- | --- | --- |
| `surface/glass-1` | 16px | 140% | `rgba(22,32,47,.78)` | `rgba(248,250,252,.14)` | `rgba(248,250,252,.20)` | `0 1px 2px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.36)` |
| `surface/glass-2` | 20px | 160% | `rgba(48,62,88,.86)` | `rgba(248,250,252,.18)` | `rgba(248,250,252,.24)` | `0 4px 12px rgba(0,0,0,.36), 0 16px 40px rgba(0,0,0,.44)` |
| `surface/glass-3` | 24px | 140% | `rgba(30,41,59,.92)` | `rgba(248,250,252,.20)` | `rgba(248,250,252,.28)` | `0 24px 64px rgba(0,0,0,.50)` |

### 2.3 允许区间

| 参数 | 下限 | 上限 | 说明 |
| --- | --- | --- | --- |
| `blur()` | 12px | 24px | 低于 12px 只是“脏色边缘”，成本和 12px 同量级，属于负优化 `[推断]` |
| `saturate()` | 130% | 170% | 低于 130% 会发灰，高于 170% 会让彩色内容过艳 |
| 亮态背景 alpha | .80（chrome）/ .86（float）/ .92（modal） | .88 / .94 / .96 | 再低会让 13px 次级文字在深色内容上跌破 4.5:1 |
| 暗态背景 alpha | .76 / .84 / .90 | .86 / .92 / .95 | 暗态对亮色媒体更敏感，跨媒体时必须加 scrim |
| 描边 alpha | .12（暗）/ .50（亮） | .22 / .72 | 描边是“玻璃边缘”的主要线索，低于下限会消失 |
| 顶部高光 alpha | .18（暗）/ .55（亮） | .30 / .80 | 只做 1px，不做多行渐变 |
| 外阴影 | — | 模糊 ≤64px，alpha ≤.20 | 阴影只负责脱离背景，不负责“发光” |

### 2.4 regular 与 clear

Apple 明确定义了两个变体 `[官方]`：

- **regular**：模糊并调整背景亮度，保证文字可读；系统多数组件用它，适合 sidebar、popover、alert 这类文字较多的表面。
- **clear**：高度透明，让底层内容保持醒目；只用于浮在照片/视频上的组件；如果底层内容很亮，需要加 **35% 不透明度**的暗色 dimming layer。

本仓的选择：

- `glass-1/2/3` 全部是 **regular 的等价物**，因为聊天界面文字密度高、次要文字多。
- 只有全屏图片/视频查看器上的悬浮按钮可以使用 clear 等价物（背景 alpha ≤ .35 + 35% 黑 scrim），且上面不得放正文。


## 3. 光学做法：四层就够

社区实现通常把玻璃拆成 tint / blur+saturation / edge / shadow 四层，这与本仓可落地的部分一致。`[社区共识]`

```css
.glass-1 {
  background: var(--gosslan-glass-1-bg);
  -webkit-backdrop-filter: saturate(140%) blur(16px);
  backdrop-filter: saturate(140%) blur(16px);
  border: 1px solid var(--gosslan-glass-1-border);
  box-shadow:
    inset 0 1px 0 var(--gosslan-glass-1-highlight),
    inset 0 -1px 0 rgba(0, 0, 0, .04),
    var(--gosslan-glass-1-shadow);
}
```

| 层 | 做法 | 不要做什么 |
| --- | --- | --- |
| 着色（tint） | 用固定主题色半透明底，亮态白、暗态深蓝灰 | 不要用 `background: rgba(255,255,255,.1)` 这类“几乎透明”的值，文字会直接失去对比度 |
| 模糊 + 饱和 | `backdrop-filter: saturate(140%) blur(16px)` | 不要叠加多层 `filter`，不要动画 `backdrop-filter` |
| 边缘高光 | 1px `inset` 顶部高光 + 1px 描边 | 不要用 SVG `feDisplacementMap` 做折射：WebKit 解析但不绘制，且成本高 `[逆向观察]` |
| 外阴影 | 柔和、低 alpha、大模糊 | 不要用彩色发光阴影，玻璃不是霓虹灯 |

### 3.1 关于“内容感知着色”

iOS 26 的 Liquid Glass 会读取底层内容颜色并微调亮度/色调。`[官方]` Web 端没有低成本的“读取背后像素”能力：CSS 的 `backdrop-filter` 只能做滤镜，不能把采样颜色写回变量；JS 采样需要 canvas 读像素，跨源图片还会污染画布。`[推断]`

本仓的替代做法：**按主题固定着色**，不追求逐帧内容感知。允许在 chrome 上叠一层 4%–6% 的 primary tint 表达品牌，但必须用固定 token，不做运行时取色。

### 3.2 玻璃要能被看见

如果背后全是同色不透明面，`backdrop-filter` 与半透明实色在观感上几乎相同。这是本仓当前“看起来是浅灰实色”的根本原因。`[逆向观察]`

因此 L0 必须有一层可采样的环境底色：

- 亮态：`#edf1f6` 基色上叠 2–3 个半径 60–80vw 的极淡 radial-gradient，中心偏移 ±10%，alpha 3%–5%。
- 暗态：`#0b1220` 基色上叠 2 个深蓝/靛青 radial-gradient，alpha 4%–6%。
- 环境层必须 `position: fixed`，不随内容滚动；否则滚动时会看到色斑移动。
- 环境层不参与交互，`pointer-events: none`。

没有这一层，就不要上玻璃；先把底色做好。

## 4. 禁止清单

### 4.1 绝对禁止

- 消息气泡、消息行、会话列表项、代码块、Markdown 正文使用玻璃。
- 玻璃元素内部再放玻璃元素。每个 `backdrop-filter` 元素自身就是 backdrop root，内层只能采到外层内容，会得到一块“假玻璃”。`[官方文档]`
- 祖先元素带 `opacity < 1`、`filter`、`mask`、`clip-path`、`mix-blend-mode` 或对应 `will-change` 时，在其内部用玻璃。这些属性会把祖先变成 backdrop root，模糊直接失效。`[官方文档]`
- 在虚拟滚动列表的列表项上使用玻璃；滚动时每帧重采样，必然掉帧。
- `blur()` 超过 24px，或同屏玻璃元素超过 8 个。WebKit 在 20+ 个 `backdrop-filter` 元素时出现过内存暴涨到数 GB 的缺陷。`[逆向观察]`
- 对 `backdrop-filter` 本身做 transition/keyframes。
- 在玻璃上放强调色文字或链接；对比度不可控。`[官方]`（Windows Acrylic 同样明确禁止）

### 4.2 “看起来像玻璃，但必须是实色”的清单

| 场景 | 必须实色的理由 |
| --- | --- |
| 消息列表与气泡 | 内容层；文字密度高，背景变化会持续破坏可读性 |
| 输入框本体（`input` / `textarea`） | 打字时需要稳定对比度与光标定位；外框可以玻璃，字段本体不行 |
| 代码块、日志、Markdown 正文 | 等宽文字对背景噪声极敏感 |
| 图片/视频全屏查看器 | 内容本身就是主体；玻璃会抢注意力并增加 GPU 开销 |
| 设置正文与表单行 | 长文本 + 大量控件，玻璃会让层级更乱 |
| 错误 / 危险提示 | 语义要求最高对比度，不能随背景变化 |
| Loading skeleton | 动画 + 模糊叠加，成本高且无信息增益 |
| 大面积空白面板（>40% 视口） | 性能与可读性双输 |
| 低端设备 / 降低透明度 / 高对比度模式 | 直接走实色回退 |

> 补充（2026-11-05 表面透明度审计）：**设置卡片（`src/components/settings/SettingsGroup.vue:12`，`bg-[var(--gosslan-panel)]`）属于"内容承载面"，刻意保持实色，不是漏改。** 分区标题、开关行与控件都落在这块面上；背景动效开启时卡片浮在薄纱上，正是预期的层次。同表口径还覆盖任务/待办看板卡片、文件卡与搜索输入框——它们和设置卡片一样是内容面，别再当"该透没透"改一遍。

## 5. 工程规则：玻璃但不卡

### 5.0 各运行时的实际支持

Tauri 2 的 WebView 后端：Windows 用 WebView2（Chromium），macOS/iOS 用 WKWebView（WebKit），Linux 用 WebKitGTK，Android 用 Android WebView（Chromium）。`[官方/已知]`

| 运行环境 | `backdrop-filter` | `prefers-reduced-transparency` | 备注 |
| --- | --- | --- | --- |
| Windows WebView2 | 支持 | 支持（Chromium 118+） | 合成层开销；玻璃元素预算照常执行 |
| macOS / iOS WKWebView | 支持 | **不支持**（Safari 不支持该媒体查询） | 必须提供应用内“减少透明效果”开关 |
| Linux WebKitGTK | 支持 | **不支持** | 同 WebKit；2.54 曾出现 20+ 元素内存暴涨的回归 |
| Android WebView | 支持 | 支持（Chromium 118+） | 低端机注意 GPU 内存与掉帧 |

`backdrop-filter` 本身在 2024-09 进入 Baseline，现代 WebView 都能绘制；真正的差异在**降透明度媒体查询**与**性能预算**，不在“能不能用”。`[官方文档]`

### 5.1 层级与滚动

- 玻璃只放在 `position: fixed` 或 `sticky` 的 chrome 上；不放在滚动容器内部的列表项上。
- 滚动容器（消息列表）保持实色；玻璃 chrome 覆盖在它上方。
- 滚动中的内容如果从玻璃下方经过，玻璃每帧重采样。给 chrome 一个稳定的采样区域：不要让 chrome 的尺寸随滚动变化（避免地址栏式收缩）。
- 滚动边缘加一层 `scroll-edge`：从玻璃底色到透明的 24–40px 渐变，减少文字在边缘处的闪烁。`[官方]`（Apple 的 scroll edge effect 思路）

### 5.2 合成层预算

| 预算 | 数值 | 依据 |
| --- | --- | --- |
| 同屏玻璃层数 | 3 | `[推断]` 可读性 + 合成层数量 |
| 同屏玻璃元素 | 8 | WebKit 20+ 元素内存暴涨的缺陷，留一半余量 `[推断]` |
| 单元素 blur | 12–24px | `[推断]` |
| 单元素面积 | ≤ 40% 视口 | `[推断]` |
| 滚动时新增玻璃 | 0 | 滚动期间不创建/销毁玻璃元素 |

### 5.3 回退策略（按优先级）

1. 用户显式设置“减少透明效果” → 全部实色。由于 Safari/WKWebView 不支持 `prefers-reduced-transparency`，必须提供应用内开关。`[官方文档 + 推断]`
2. `@media (prefers-reduced-transparency: reduce)` → 全部实色。Chromium 118+ 支持；Safari 不支持。`[官方文档]`
3. `@media (prefers-contrast: more)` → 实色 + 更强描边（本仓已有类似规则）。
4. `@media (prefers-reduced-motion: reduce)` → 玻璃保持静态，不做模糊/透明度过渡。
5. 低端设备 → 实色。判据建议：`navigator.hardwareConcurrency <= 4` 或 `navigator.deviceMemory <= 4` 或实测连续掉帧。`[推断]`

回退值：

| Token | 亮态 | 暗态 |
| --- | --- | --- |
| `surface/glass-1-fallback` | `#f7f9fc` | `#16202f` |
| `surface/glass-2-fallback` | `#ffffff` | `#1e293b` |
| `surface/glass-3-fallback` | `#ffffff` | `#1e293b` |

## 6. 可访问性数值

- 正文与 13px 次级文字：对比度 **≥ 4.5:1**。`[官方]` WCAG 1.4.3。
- 大字（≥ 18.66px bold 或 ≥ 24px）：**≥ 3:1**。
- 图形、边框、焦点指示：**≥ 3:1**。`[官方]` WCAG 1.4.11。
- 焦点指示厚度 **2px**，与相邻颜色对比 **≥ 3:1**。`[官方]` WCAG 2.2 的 focus appearance 方向。
- 玻璃上的文字必须按**合成后的颜色**测，不是按 token 原色测。
- 暗态玻璃跨亮色媒体时，禁止把 `text-2` 放在玻璃上；要么加 35% 黑 scrim，要么换实色。`[推断]`

## 7. 建议的 token

```css
:root {
  --gosslan-glass-1-bg: rgba(255, 255, 255, .82);
  --gosslan-glass-1-border: rgba(255, 255, 255, .52);
  --gosslan-glass-1-highlight: rgba(255, 255, 255, .60);
  --gosslan-glass-1-shadow: 0 1px 2px rgba(15, 23, 42, .04), 0 8px 24px rgba(15, 23, 42, .08);
  --gosslan-glass-1-blur: 16px;
  --gosslan-glass-1-saturate: 140%;

  --gosslan-glass-2-bg: rgba(255, 255, 255, .88);
  --gosslan-glass-2-border: rgba(255, 255, 255, .60);
  --gosslan-glass-2-highlight: rgba(255, 255, 255, .70);
  --gosslan-glass-2-shadow: 0 4px 12px rgba(15, 23, 42, .10), 0 16px 40px rgba(15, 23, 42, .12);
  --gosslan-glass-2-blur: 20px;
  --gosslan-glass-2-saturate: 160%;

  --gosslan-glass-3-bg: rgba(255, 255, 255, .94);
  --gosslan-glass-3-border: rgba(255, 255, 255, .70);
  --gosslan-glass-3-highlight: rgba(255, 255, 255, .75);
  --gosslan-glass-3-shadow: 0 24px 64px rgba(15, 23, 42, .18);
  --gosslan-glass-3-blur: 24px;
  --gosslan-glass-3-saturate: 140%;
}
```

Tailwind 映射建议：

| 语义 token | CSS 变量 | Tailwind |
| --- | --- | --- |
| `surface/glass-1` | `--gosslan-glass-1-bg` | `bg-surface-glass-1` |
| `surface/glass-2` | `--gosslan-glass-2-bg` | `bg-surface-glass-2` |
| `surface/glass-3` | `--gosslan-glass-3-bg` | `bg-surface-glass-3` |
| `border/glass-1` | `--gosslan-glass-1-border` | `border-glass-1` |
| `blur/glass-1` | `--gosslan-glass-1-blur` | `backdrop-blur-glass-1` |

## 8. 验收清单

- [ ] 只在 L2/L3/L4 使用玻璃，L1 全部实色。
- [ ] 同屏玻璃元素 ≤ 8，层数 ≤ 3。
- [ ] blur 在 12–24px 之间，没有叠加多层 `filter`。
- [ ] 玻璃祖先没有 `opacity` / `filter` / `mask` / `will-change`。
- [ ] 滚动容器内没有玻璃列表项。
- [ ] 降低透明度、高对比度、低端机三种回退都可用。
- [ ] 亮/暗两种主题下，玻璃上的 13px 文字实测 ≥ 4.5:1。
- [ ] 没有 SVG 折射、没有彩色发光阴影。
