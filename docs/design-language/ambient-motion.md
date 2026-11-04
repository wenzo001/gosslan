# 背景动态（Ambient Motion）规格

> v0.1 · 2026-11-05 · 目标态规格，不是强制规范
> 上位规范仍是 [docs/design-guidelines.md](../design-guidelines.md)（尤其 §11.3.7 动效五条硬约束）；本文只回答“背景怎么动”，不覆盖内容层动效、消息入场、Toast 动画。
> 分层（L0 ambient / L1 content / L2 chrome / L3 float / L4 modal）沿用 [liquid-glass.md](./liquid-glass.md)。

## 0. 结论（先看这段）

**推荐组合：3 团极慢漂移的主色雾（72 / 96 / 120s，α 4%–6%）+ 1 团静态底洗 + 1 张 α 3% 的静态颗粒 + 只在主按钮按下时的一次局部涟漪。不做全局水波，不用 WebGL，不用 rAF。**

| 项 | 取值 |
| --- | --- |
| 常驻动画元素 | 3 个（3 团漂移色雾）；上限 4 |
| 色团总数 | 4（3 动 + 1 静） |
| 单团透明度 | 亮 4%–6%，暗 5%–8%；同一点最多叠 2 团，合成 ≤10%（暗 ≤12%） |
| 周期 | 72s / 96s / 120s，`ease-in-out` + `alternate`，负延迟错相 |
| 位移动幅 | 平移 ≤3vmax，缩放 1.00→1.05 |
| 颗粒 | 96×96 平铺 PNG，亮 3% / 暗 4%，**不参与任何动画** |
| 涟漪 | 560ms，同时最多 2 个，只在控件内部裁切，不做全屏层 |

**三条性能硬线**（写死在 §4，任何实现不得绕过）：

1. 只允许 `transform` / `opacity` 参与动画；禁止动画 `filter` / `blur` / `background-position` / `box-shadow` / 几何属性。
2. 不允许任何逐帧 JS：无 `requestAnimationFrame` 循环、无 `setInterval`、无 canvas / WebGL；所有位移走 CSS keyframes。
3. `document.hidden` 暂停、`prefers-reduced-motion` 冻结在初始帧；空闲 CPU <1%、滚动 p50 不劣于当前 17ms、常驻动画 ≤3 个。

---

## 1. 候选方案对比

| # | 方案 | 观感 | 成本 | 风险 | 适合谁 |
| --- | --- | --- | --- | --- | --- |
| A | 极慢漂移色雾（mesh gradient drift） | 最接近“高级但不说话”的底色：远看是呼吸的灰，近看才有色相 | 低：3–5 个预栅格化 div，只动 `transform` | 透明度失控会带色偏、出现 banding；色团太多会“花” | **常驻应用背景**（桌面 + 平板） |
| B | 呼吸式光晕 / aurora | 更“有机”、聚焦，暗色下像星空/极光 | 低–中：`opacity` 呼吸 + 少量位移 | 容易变成“呼吸灯”，节律感抢注意力；周期短于 20s 必翻车 | 暗色主题、启动页、空状态页，**不常驻** |
| C1 | 真流体/水波（WebGL / canvas 逐帧） | 最接近苹果演示视频里的“流体壁纸” | 高：GPU 常驻、每帧 fragment 计算、耗电 | 与空闲 CPU 0.09% / 无 rAF 长驻的红线直接冲突；低端机必卡 | 一次性引导页、发布会 demo，**不进入常驻 UI** |
| C2 | 仅交互涟漪（按压/点击） | 有反馈、不占背景，用户主动触发 | 极低：一次 `transform` + `opacity` 短动画 | 全屏铺开会变成“到处都在动”；鼠标端可能显得廉价 | **按钮/发送键的按压反馈** |
| D | 细颗粒 noise | 材质感，压住渐变的色带，让色雾看起来是“实体” | 极低：一张静态贴图，零动画 | α 过高会糊字、显脏；若用 CSS 生成噪点则 CPU 高 | 任何渐变背景的**下层**，3%–4% |
| E | Apple 系统壁纸式“流体壁纸” | 通透、随锁屏/桌面缓慢变化，几乎无循环接缝 | 不可移植：由系统合成器/壁纸进程驱动，WebView 拿不到同层权限 | 在 Tauri WebView 里复制必然降级成“JS 逐帧”，直接撞红线 | 只作**参数参考**：极慢、低对比、无可见接缝 |
| F | Material 3 Expressive 动态色彩 | 主题色驱动的整体色调与形状语言，切换时“有生命” | 低：颜色角色 + 状态转场 | 它是**状态转场**与色彩推导，不是背景常驻动画；当成背景动画会误读 | 跟随用户主题色的**取色规则**（我们的色团就应读 `--gosslan-primary`） |
| G | Windows Mica / Mica Alt 流变 | 安静、几乎察觉不到的壁纸采样，窗口像一块磨砂玻璃 | 低：一次性采样 + noise | 官方 Mica 本身**不平移**；它解决的是“窗口材质”，不是“要有动态” | 桌面窗口框架的**材质**参考；不满足“背景在动”的诉求 |
| H | 滚动视差（parallax，CSS scroll-driven） | 内容滚动时背景轻微跟随，空间感强 | 中：滚动期间持续合成 | 本仓滚动在内层容器，且滚动时再叠一层动画会让帧时间变差；“背景跟着动”也抢注意力 | 营销页、长图页面，**不用于聊天主界面** |

补充说明：

- **E / F / G 不是“第四个候选”，而是“不该抄的部分”**：Apple 的效果由系统合成器承担，M3 Expressive 的动态在色彩角色与状态转场上，Mica 是静态采样。三者共同的可借用结论只有一条：**慢、低对比、没有可见的循环起点**。
- **C1 为什么直接排除**：本仓刚测出空闲 CPU 0.09%、无 rAF 长驻（见 [check-ui-runtime.mjs](../../scripts/check-ui-runtime.mjs) 的 perf 段与长空闲段）。一个常驻 WebGL 背景会把“空闲”从毫秒级变成持续 GPU 占用，这不是调参能救的，是机制冲突。
- **H 为什么排除**：`body` 自身不滚动（滚动都在内层容器），做视差要么监听滚动（JS 逐帧），要么用 `animation-timeline: scroll()`（滚动期间持续合成），两条都会让滚动 p50 变差。

---

## 2. 推荐组合与理由

**A（漂移色雾，打底）+ D（颗粒，压噪）+ C2（按压涟漪）+ 一团静态底洗。**

1. **和现状同构，只升级“会不会动”。** 当前 `html.ambient` 已经是一层极淡的 `radial-gradient`（[style.css](../../src/style.css#L361-L370)）。新方案把它拆成几个预栅格化的 div，用 `transform` 漂移，机制不变、观感上限提高，不引入第二套背景体系。
2. **全部落在合成层上。** 3 个 div 各自栅格化一次，之后每帧只改 `transform`；GPU 合成，不重绘、不重排，空闲时几乎不产生 JS 任务。
3. **正好满足玻璃的“可采样”前提。** [README](./README.md) 原则 2 说玻璃背后必须有东西可采样；色雾是给 `glass-1/2/3` 提供缓慢变化的底，而不是和内容抢戏。
4. **涟漪只在用户主动按下时出现。** 它是反馈，不是背景；生命周期 560ms，天然不会常驻，也不会破坏“空闲 CPU <1%”。

**明确不做全局水波**：需要逐像素扰动 ⇒ WebGL/canvas 逐帧 ⇒ 撞硬线；而且全屏持续变形会让文字边缘“游动”，直接违反“柔和不喧宾夺主”。

---

## 3. 可实施规格

### 3.1 层叠顺序与挂载位置

沿用 [liquid-glass.md](./liquid-glass.md) 的 L0–L4：

| 层 | 内容 | z / 说明 |
| --- | --- | --- |
| L0-a | 漂移色雾 3 团 | `position: fixed; inset: 0; z-index: 0`，`pointer-events: none`，`aria-hidden="true"` |
| L0-b | 静态底洗 1 团 + 颗粒 1 张 | 与 L0-a 同容器，排在色雾之后（更靠近内容） |
| L1 | 消息列表、气泡、正文 | 内容层，实色，不透明 |
| L2 | chrome 玻璃（标题栏/侧栏/TabBar/输入区外框） | 采样 L0 + L1 |
| L3 / L4 | 浮层 / 模态 | 采样下方所有层 |

**硬约束（会被 `backdrop-filter` 的 backdrop root 规则惩罚）：**

- ambient 容器必须是**玻璃元素的兄弟或更外层**，**绝不能成为任何玻璃元素的祖先**。祖先链上出现 `opacity < 1` / `filter` / `mask` / `clip-path` / `mix-blend-mode` / 对应 `will-change` 时，子元素的 `backdrop-filter` 会失效（[MDN backdrop-filter](https://developer.mozilla.org/docs/Web/CSS/backdrop-filter)）。
- ambient 容器直接挂在 `body` 下、`#app` 之前（或之后但 z-index 更低），不要放进任何带 `transform` / `opacity` / `filter` 的布局容器 —— 那些属性既会改 `fixed` 的包含块，也会制造新的 backdrop root。
- 容器本身**不设** `background`、`backdrop-filter`、`filter`；所有颜色在子元素上。容器只负责裁切（`overflow: hidden`）。
- 内容层（`#app`）保持透明底，底色仍由 `body` 承担；ambient 只负责“多出来的那点色”。

### 3.2 色团数量与色相关系

- **总数 4**：3 团参与漂移 + 1 团静态底洗。小屏（`max-width: 599px`）降到 3 团（去掉底洗，漂移团减为 2）。
- **色相只允许两类**：
  1. **主色雾**：由 `--gosslan-primary` 经 `color-mix(... , transparent)` 得到，跟随用户在设置里换的主题色；
  2. **冷中性雾**：饱和度 ≤10% 的灰蓝（亮 `#7c93b3` / 暗 `#5b7fb3`），只负责“深度”，不承担品牌语义。
- **禁止**把 `--gosslan-success` / `--gosslan-warning` / `--gosslan-danger` 放进背景。主题色可以是绿、橙、红、紫任意一档，再叠一个语义色必然撞色；“不撞色”的做法是**不引入第二个品牌色相**，而不是去算色相差。
- **低饱和的实现方式**：不在 HSL 里调 S，而是**低 α**。任何一团的中心 α 都不超过 8%，视觉饱和度自然被底色稀释。
- **色团彼此不重叠超过 2 层**：四个团分配到四角（见 §3.5 的锚点），中心区域允许 1–2 团交叠，交叠处合成 α ≤10%（亮）/ ≤12%（暗）。

### 3.3 透明度区间

| 外观 | 主光 A | 副光 B | 冷雾 C | 底洗 D（静） | 颗粒 | 单点合成上限 |
| --- | --- | --- | --- | --- | --- | --- |
| 亮 | 6% | 4% | 4% | 2% | 3% | 10% |
| 暗 | 8% | 5% | 5% | 3% | 4% | 12% |

- α 是**最终合成值**（`color-mix(in srgb, <色> N%, transparent)` 里的 N 直接取上表），不再乘第二层 `opacity`。实际实现时用 `color-mix` 写在 `radial-gradient` 里即可，不需要额外 `opacity` 属性。
- 超过 8% 的后果不是“更明显”，而是正文对比度开始随底色漂移：对比度契约表是按 `--gosslan-app-bg` 判的，环境层不在这张表里，所以**必须自己守住这条上限**。
- 暗色档比亮色档高 1–3 个百分点，是因为深底上同样的 α 感知更弱；不允许为了“看得见”继续加。

### 3.4 周期、缓动与位移

| 色团 | 周期 | 缓动 | 方向 | 位移（起 → 止） | 缩放 |
| --- | --- | --- | --- | --- | --- |
| A 主光 | 72s | `ease-in-out` + `alternate` | 右下 → 左上 | `translate3d(0, 0, 0)` → `(3vmax, 2vmax, 0)` | 1.00 → 1.05 |
| B 副光 | 96s | 同上 | 左上 → 右下 | `(2.5vmax, 2vmax, 0)` → `(0, 0, 0)` | 1.04 → 1.00 |
| C 冷雾 | 120s | 同上 | 纵向为主 | `(0, 2vmax, 0)` → `(-2vmax, 1vmax, 0)` | 1.00 → 1.03 |
| D 底洗 | — | — | — | 静止 | 1.00 |

- **必须 `alternate`**：单一方向的 `infinite` 会在 72s 处出现一次硬跳；`alternate` 让端点速度归零，接缝不可见。
- **负延迟错相**：`animation-delay: -18s / -42s / -66s`。不要三个都从 0 开始 —— 同相起跑会在前几秒叠成一次“集体呼吸”。
- **位移上限 3vmax**：再大就从“环境”变成“背景在晃”。缩放上限 1.05，超过会让预栅格化的渐变出现轻微软化（可接受），再大就会看出像素。
- **不允许旋转**：低对比团块的旋转在视觉上不可见，只会白增合成开销。
- **不允许动画 `background-position`**：这是最像“漂移”的写法，但它每帧重绘整层，是本方案的**头号禁止项**（见 §4）。

### 3.5 亮 / 暗两套取值

亮色：

| 色团 | 尺寸 | 锚点（中心） | 颜色 |
| --- | --- | --- | --- |
| A 主光 | 74vw × 62vh | 6% -12% | `color-mix(in srgb, var(--gosslan-primary) 6%, transparent)` → 70% 处透明 |
| B 副光 | 68vw × 58vh | 106% 108% | `color-mix(in srgb, var(--gosslan-primary) 4%, transparent)` → 72% 处透明 |
| C 冷雾 | 56vw × 48vh | 88% 18% | `rgba(124, 147, 179, 0.04)` → 70% 处透明 |
| D 底洗 | 84vw × 72vh | 40% 55% | `color-mix(in srgb, var(--gosslan-primary) 2%, transparent)` → 75% 处透明 |

暗色：

| 色团 | 尺寸 | 锚点（中心） | 颜色 |
| --- | --- | --- | --- |
| A 主光 | 74vw × 62vh | 6% -12% | `color-mix(in srgb, var(--gosslan-primary) 8%, transparent)` → 70% 处透明 |
| B 副光 | 68vw × 58vh | 106% 108% | `color-mix(in srgb, var(--gosslan-primary) 5%, transparent)` → 72% 处透明 |
| C 冷雾 | 56vw × 48vh | 88% 18% | `rgba(91, 127, 179, 0.05)` → 70% 处透明 |
| D 底洗 | 84vw × 72vh | 40% 55% | `color-mix(in srgb, var(--gosslan-primary) 3%, transparent)` → 75% 处透明 |

两套外观共用同一组尺寸、锚点、周期与位移，**只换颜色与 α**。这样切主题时不会出现“暗色版突然换了个构图”。

### 3.6 细颗粒 noise

- 资产：一张 **96×96** 的灰度 PNG（或同尺寸 SVG `feTurbulence` 预生成后的位图），平铺；亮色 α 3%，暗色 4%。体积目标 ≤3KB。
- 位置：ambient 容器里**最靠内容的一层**，`pointer-events: none`，**不参与动画**。
- 禁止：运行时生成噪点（`repeating-conic-gradient` 叠几十层、canvas 生成）—— 那会在滚动时反复重绘。
- 禁止：`mix-blend-mode`。它会制造新的合成上下文，也会改 backdrop root；普通 `opacity` 已经够用。

### 3.7 按压涟漪（C2）

- 触发：`pointerdown`，只作用于**主按钮**（primary/danger 实底）与**发送键**；列表行、图标按钮、菜单项**不触发**（它们已有底色按压反馈，见 [design-guidelines §11.3.1](../design-guidelines.md)）。
- 形态：从落点扩散的圆，直径 = `max(控件短边, 240px)`，被控件自身的 `overflow: hidden` + 圆角裁切。**不做全屏涟漪层**。
- 参数：`transform: scale(0.55) → scale(1.25)`，`opacity: 0.12 → 0`，560ms，`cubic-bezier(0.2, 0.7, 0.3, 1)`。
- 并发：同一控件最多 1 个，全屏同时最多 2 个；`prefers-reduced-motion` 下完全不出现。
- 结束即移除 DOM（或复用固定 2 个槽位），不保留空闲节点。

---

## 4. 性能硬线

| # | 硬线 | 判据 | 违反的后果 |
| --- | --- | --- | --- |
| 1 | 动画属性白名单：**只有 `transform` 和 `opacity`** | 每个 `CSSAnimation` 的 `effect.getKeyframes()` 里出现的属性必须 ⊆ `{transform, opacity}` | 动 `filter`/`blur`/`background-position`/`box-shadow`/`width`/`top` 会逐帧重绘，滚动与空闲同时退化；这条没有“少量例外” |
| 2 | **零逐帧 JS**：无 `requestAnimationFrame` 循环、无 `setInterval`、无 canvas/WebGL | 静态扫描 ambient 实现文件中的禁用符号；运行时以空闲 CPU 复核 | 直接破坏“空闲 CPU 0.09% / 无 rAF 长驻”的实测基线 |
| 3 | **预栅格化**：渐变与柔化在 CSS 里一次画好，运行时不做 `filter` / `backdrop-filter` | ambient 容器与其子元素上不出现 `filter`、`backdrop-filter` | 全屏 `backdrop-filter` 是 WebKit 内存暴涨（bug 328065）与掉帧的典型来源 |
| 4 | **隐藏暂停**：`document.hidden === true` 时所有 ambient 动画 `paused` | 钉住 `document.hidden` 后 200ms 内运行中动画数 = 0 | 后台继续跑动画会烧电，也会让长空闲 CPU 判据变红 |
| 5 | **减少动态效果 = 冻结**：`prefers-reduced-motion: reduce` 下 `animation: none`，停在初始帧 | 运行动画数 = 0，且 `transform` 等于 0% 帧矩阵 | 只把时长拉长（如 30s）仍属“在动”，必须判红 |
| 6 | **预算**：空闲 CPU <1%、3s 空闲 ≤600ms、滚动 p50 ≤ 17ms、长帧 ≤10、帧最大 ≤600ms | 复用 `check-ui-runtime.mjs` 的 perf 段与长空闲段 | 任一超线即回退到静态（见 §5） |
| 7 | **层数**：常驻动画元素 ≤3（上限 4）；新增合成层 ≤5（3 动 + 1 静 + 1 颗粒） | DOM 计数 + `getAnimations` 计数 | 合成层过多会挤占 GPU 内存，低端机直接掉帧 |

补充约束：

- `will-change: transform` **只写在 3 个漂移团上**，不写在容器、不写在静态团；动画结束/关闭时移除。
- 容器加 `contain: layout paint`（可选 `strict`），把它和内容层的布局/绘制隔离。
- 三个团的 `animation` 必须挂在**同一个容器内的叶子节点**上，不要让容器的 `opacity` 参与动画（会整层重合成并可能影响上层玻璃的采样）。

---

## 5. 降级与开关

### 5.1 系统偏好降级

| 条件 | 行为 | 依据 |
| --- | --- | --- |
| `prefers-reduced-motion: reduce` | **冻结**：`animation: none`，保留静态色雾（停在初始帧） | 用户要求“少动”，不是“动慢一点” |
| `prefers-reduced-transparency: reduce` | **整层隐藏**：ambient `display: none`，回到纯平色 + 玻璃实底 | 与 [style.css](../../src/style.css#L1828) 的既有降级同一原则 |
| `prefers-contrast: more` | 同“整层隐藏” | 背景带色会让正文对比度随位置漂移 |
| `forced-colors: active` | 整层隐藏 | 系统强制配色下不引入自绘颜色 |
| 窗口 `document.hidden` | `animation-play-state: paused`（不断点、不重建） | 恢复时从原相位继续，避免“回来突然跳一下” |

### 5.2 低端设备

判定（任意一条命中即降为“静态色雾”，不做漂移）：

- `navigator.hardwareConcurrency <= 4`；
- `navigator.deviceMemory <= 4`（Safari 不提供，缺省视为未知，不降级）；
- Android WebView（`userAgent` 含 `; wv`）；
- 视口宽度 < 480px（竖屏手机）：只保留 3 团，且去掉底洗。

**不引入运行时探测器。** 不写“每 30s 采样 CPU、超线自动关”的循环 —— 那本身就是一个常驻定时器，和硬线 2 冲突。低端判定只在启动时做一次，结果写进 `html[data-ambient]`。

### 5.3 与 `html.ambient` 合并成一个设置项

现状：`html.ambient` 是一个**开发者开关**（[style.css](../../src/style.css#L505-L513)），默认关闭，没有 UI。新方案把它变成**用户可见的唯一开关**，内部三态：

| `html[data-ambient]` | 表现 | 谁会拿到 |
| --- | --- | --- |
| `off` | 纯平色（`--gosslan-app-bg`） | 用户关闭；`reduced-transparency` / `contrast` / `forced-colors` |
| `static` | 静态色雾（当前 `html.ambient` 的两团） | 低端设备、小屏、用户选择“静止” |
| `drift` | 3 团漂移 + 颗粒 + 涟漪 | 用户开启（推荐档） |

- **用户只看到两个选项**：`关闭` / `缓慢流动`。`static` 是自动降级档，不单独暴露，避免设置里出现第三个“看起来一样”的选项。
- **放哪**：设置 › 外观（[AppearanceSection.vue](../../src/components/settings/AppearanceSection.vue)），作为「显示模式 / 主题色 / 字体」之后的第四行，复用 `SettingsToggle.vue` + `SettingsRow.vue`。
- **叫什么**：`背景动效`（英文 `Ambient motion`）。副标题写清代价与降级：「极慢的柔光漂移，不影响操作；系统开启“减少动态效果”或低电量模式下自动静止」。
- **默认值**：这是全局观感改动，默认值需要用户点头（见 §9）。在点头前保持 `off`，与现状一致。
- **i18n**：实现时必须中英各一套键（`settings.appearance.ambient.*`），并登记进 `DYNAMIC_PREFIX_WHITELIST` 之外的真实引用面；删除旧键时同提交删干净。
- `html.ambient` 类可以保留为 `static` 的兼容别名，但**不再有新代码写这个类名**，只由设置/降级逻辑写 `data-ambient`。

---

## 6. 实现骨架建议

### 6.1 DOM

```html
<!-- 只在 data-ambient="drift" 且未降级时挂载；其余情况整层不渲染 -->
<div class="ambient" aria-hidden="true">
  <div class="ambient-blob ambient-blob--a"></div>
  <div class="ambient-blob ambient-blob--b"></div>
  <div class="ambient-blob ambient-blob--c"></div>
  <div class="ambient-blob ambient-blob--d"></div>
  <div class="ambient-grain"></div>
</div>
```

### 6.2 CSS 骨架（示意，不是已落地代码）

```css
.ambient {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  contain: layout paint;
}

.ambient-blob {
  position: absolute;
  border-radius: 50%;
  will-change: transform; /* 只给 A/B/C 三个漂移团，D 不加 */
}

/* 预栅格化：柔化写在渐变里，不写 filter: blur() */
.ambient-blob--a {
  width: 74vw; height: 62vh;
  left: 6%; top: -12%; transform: translate(-50%, -50%);
  background: radial-gradient(closest-side,
    color-mix(in srgb, var(--gosslan-primary) 6%, transparent),
    transparent 70%);
  animation: ambient-drift-a 72s ease-in-out -18s infinite alternate;
}

@keyframes ambient-drift-a {
  from { transform: translate(-50%, -50%) translate3d(0, 0, 0) scale(1); }
  to   { transform: translate(-50%, -50%) translate3d(3vmax, 2vmax, 0) scale(1.05); }
}

.dark .ambient-blob--a {
  background: radial-gradient(closest-side,
    color-mix(in srgb, var(--gosslan-primary) 8%, transparent),
    transparent 70%);
}

/* 隐藏页面：暂停而不是销毁，回来续播同一相位 */
html[data-page-hidden="true"] .ambient-blob {
  animation-play-state: paused;
}

/* 减少动态效果：冻结在初始帧，必须 animation: none（不能只拉长时长） */
@media (prefers-reduced-motion: reduce) {
  .ambient-blob { animation: none !important; }
}

/* 降低透明度 / 高对比：整层不渲染 */
@media (prefers-reduced-transparency: reduce) {
  .ambient { display: none; }
}
@media (prefers-contrast: more) {
  .ambient { display: none; }
}
```

JS 只允许一个监听器，不允许循环：

```js
document.addEventListener("visibilitychange", () => {
  document.documentElement.dataset.pageHidden = String(document.hidden);
});
```

### 6.3 同屏动画层数上限

| 类别 | 上限 | 说明 |
| --- | --- | --- |
| 常驻漂移色雾 | 3（硬上限 4） | 每个都是一个合成层 |
| 静态底洗 + 颗粒 | 2（不合成、不运动） | 不进入 `getAnimations` |
| 按压涟漪 | 2（瞬时） | 560ms 后必须移除 |
| 全局空闲动画预算 | 上线前基线 + 3 | 用基线棘轮判，不把既有动画算到 ambient 头上 |

**不要用 `@property` 动画渐变停点**：即使 `--angle` 是数字、可插值，动画它仍然每帧重绘整层渐变，`getKeyframes()` 里也看不到 `transform`/`opacity` —— 属于硬线 1 的实质违反，必须判红。

---

## 7. 验收判据

### 7.1 机器可判定的条目

建议新增 `node scripts/check-ui-runtime.mjs --only=ambient`（复用现有 CDP 探针，不新起一套量具）。

| 编号 | 判据 | 怎么量 | 阈值 | 反例（必须红） |
| --- | --- | --- | --- | --- |
| AM-01 | 色团数量 | `document.querySelectorAll('.ambient-blob').length` | ≤4（<600px 视口 ≤3） | 加第 5 团 ⇒ 红 |
| AM-02 | 常驻动画数 | ambient 子树 `getAnimations({subtree:true})` 里 `playState === "running"` 的数量 | ≤3（硬上限 4） | 把底洗也加动画 ⇒ 4 仍过；加到 5 ⇒ 红 |
| AM-03 | 属性白名单 | 每个动画 `effect.getKeyframes()` 的属性集合 | ⊆ `{transform, opacity}` | 任选一帧改成 `filter: blur(24px)` ⇒ 红 |
| AM-04 | 无逐帧 JS | 源码扫描 ambient 实现文件（`.css` / `.ts`） | 不含 `requestAnimationFrame` / `setInterval` / `getContext(` / `WebGL` / `canvas` | 加一个 rAF 漂移循环 ⇒ 红；同时断言“扫到了目标文件”，防空转 |
| AM-05 | 隐藏暂停 | 钉住 `document.hidden = true` 后 200ms | running 数 = 0；恢复后回到 ≤3 | 删掉 `visibilitychange` 监听 ⇒ 红 |
| AM-06 | 减少动态效果冻结 | `Emulation.setEmulatedMedia` 设 `prefers-reduced-motion: reduce` | 动画数 = 0，且 `transform` 等于 0% 帧矩阵 | 改成 `animation-duration: 30s`（还在动）⇒ 红 |
| AM-07 | 降低透明度 | 模拟 `prefers-reduced-transparency: reduce` | ambient 子树 `display: none`（动画数 0） | 只把 `opacity` 降到 0.2（仍参与采样）⇒ 红 |
| AM-08 | 空闲 CPU | 复用 `GOSSLAN_IDLE_MS=900000` 两段 15 分钟 | 每段 `cpuPct < 1` | 把阈值调大 ⇒ 不允许 |
| AM-09 | 3s 空闲 CPU | 复用 perf 段 `TaskDuration` 增量 | ≤600ms | 实测超线 ⇒ 红 |
| AM-10 | 滚动帧时间 | 复用 perf 段 1.2s 连续滚动 | p50 ≤ max(17, 关闭 ambient 时的 p50 + 2) ms；长帧 ≤10；max ≤600ms | ambient 版 p50 = 20ms ⇒ 红 |
| AM-11 | 长空闲内存 | 复用长空闲段的 GC 后堆增量 | ≤0.5MB | — |
| AM-12 | 首帧无跳变 | 首次挂载后第一帧的 `transform` | 等于 0% 帧，不是 `none` 或位移后的值 | 初始帧写到 `to` 状态 ⇒ 红 |

### 7.2 反例自证（门禁必须能红）

四条 fixture 必须真实跑出 FAIL，否则视为门禁空转：

1. **属性白名单**：把 `ambient-drift-a` 的某帧从 `transform` 改成 `filter: blur(24px)` ⇒ AM-03 红，并打印违规属性名。
2. **数量上限**：DOM 里多加一个 `.ambient-blob` ⇒ AM-01 / AM-02 红。
3. **隐藏暂停**：注释掉 `visibilitychange` 监听 ⇒ AM-05 红（running 数仍为 3）。
4. **冻结而非减速**：把 reduce 块改成只调 `animation-duration` ⇒ AM-06 红。

### 7.3 人工观感验收

- 静止盯着看 10 秒，**说不出“它在动”**，但两帧对比能看出位置差；
- 同屏阅读正文时，注意力不被边缘光团拉走（“柔和不喧宾夺主”的主观对应项）；
- 相隔 30 秒截两帧，像素差 >2/255 的比例 ≤5%（“极慢”的可量化近似）；
- 亮/暗切换时，构图不跳、不换位置，只换色与 α。

---

## 8. 与现有实现的差距

| 项 | 现状（2026-11-05） | 目标 |
| --- | --- | --- |
| 背景动效 | 无。`html.ambient` 是静态两团 `radial-gradient`，默认关闭 | 3 团 CSS 漂移 + 颗粒 + 按压涟漪，按 `data-ambient` 三态 |
| 用户开关 | 无 UI，只能改 DOM 类名 | 设置 › 外观 › 「背景动效」 |
| 降级 | `prefers-reduced-transparency` 只作用于玻璃（[style.css L1828](../../src/style.css#L1828)），没有背景层的降级 | ambient 整层隐藏 + reduce 冻结 + 低端静止 |
| 暂停 | 静态背景无需暂停 | `visibilitychange` 暂停/续播 |
| 量具 | perf 段有滚动/空闲读数，没有动画属性与层数判据 | 新增 `--only=ambient` 与 AM-01…AM-12 |
| 颗粒 | 无 | 96×96 PNG，α 3%/4%，静态 |

升级顺序建议：先落 CSS 骨架与三态开关（不动任何组件）→ 接 `visibilitychange` → 加 `--only=ambient` 判据与四条反例 → 最后再把涟漪接到主按钮（会碰组件，单独一个提交）。

---

## 9. `needs-user-signoff`

1. **默认值**：新方案默认 `开启` 还是继续 `关闭`？（本文建议先关闭，用户点头后再改默认）。
2. **设置项名称与位置**：「设置 › 外观 › 背景动效（Ambient motion）」，两个可见选项 `关闭 / 缓慢流动`。
3. **存在感档位**：α 4%–6%（亮）/ 5%–8%（暗）是否足够“看得见但不抢戏”；这是唯一需要眼睛定的参数，代码可先按本文值落地，再 ±1–2% 调。
4. **涟漪范围**：只给主按钮 + 发送键，还是所有按钮？（本文建议前者，列表行不参与）。
5. **噪点资产**：允许新增一张 ≤3KB 的 96×96 PNG（打包进前端资产），还是要求纯 CSS（纯 CSS 方案会增加重绘，不建议）。
6. **暗色构图**：暗色沿用同一构图只调色，还是允许暗色单独换锚点（本文建议不换，避免主题切换时跳变）。

---

## 10. 来源与置信度

| 结论 | 来源 | 置信度 |
| --- | --- | --- |
| `backdrop-filter` 的 backdrop root 由祖先 `opacity/filter/mask/clip-path/mix-blend-mode` 触发 | MDN `backdrop-filter` | A |
| `prefers-reduced-transparency` 只在 Chromium 系可用，Safari/Firefox 不支持 | MDN 媒体查询 + caniuse | A |
| WebKit 上大量 `backdrop-filter` 元素导致内存暴涨 | WebKit bug 328065 | B |
| Apple 系统级动态壁纸由合成器/壁纸进程驱动，WebView 不可复制 | 公开资料未描述实现；按平台权限推断 | C |
| M3 Expressive 的动态性在弹簧动效、形状与色彩角色，而非常驻背景动画 | Material 3 Expressive 公开文档 | B |
| Windows Mica 为壁纸采样 + noise，静态不位移 | Microsoft Learn：Mica / Acrylic 材质文档 | A |
| 常态漂移周期 60–120s、低 α 是 Web 端“高级感”的社区共识 | Linear / Raycast / Vercel 等站点观察 | C |
| 本仓空闲 CPU 0.09%、无 rAF 长驻、滚动 p50 17ms | 本任务前序会话实测与 `check-ui-runtime.mjs` 读数 | A（本机口径） |
</content>
