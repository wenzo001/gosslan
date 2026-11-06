# 亮色表面诊断：到底是阴影、玻璃，还是别的东西

- 采样日期：2026-11-06
- 工作区：`gosslan-unslop` worktree（分支 `unslop/polish`，起点 `42edc0ea`）；主工作区 `gosslan` 未读写
- 本轮只做诊断与方案，**未改任何业务代码**、未加依赖、未 push、未 bump
- 量具：既有原生 CDP 探针（`Page.captureScreenshot` + `Runtime.evaluate` + `Emulation.setDeviceMetricsOverride`），复用常驻 dev server `127.0.0.1:5288` 与 `GOSSLAN_CHROME` 的 CDP `127.0.0.1:9644`；未安装 Playwright / 内核

## 0. 一句话结论

**不是阴影。** 主要不舒服来自"别的东西"——**色雾 + 16% 薄纱**把 92% 视口的画布压成灰蓝（#eaeef2），并因此把同屏六个"白/灰"面（5 个不同值：237 / 234 / 251 / 246 / 255）拉成多级跳变。玻璃排在第二，但问题**不是层数超标**（实测最多 2 元素 / 8.3% 视口），而是 0.82 纯白在灰底上必然成为"白条"。accent 第三，阴影几乎无关。

贡献排序（按读数，不按观感）：

| 成因 | 占比 | 一句话证据 |
| --- | --- | --- |
| 底色 + 色雾 + 16% 薄纱（"别的东西"） | **≈6 成** | 聊天画布 92.5% 视口最终像素 #eaeef2，比 token `#ffffff` 暗 21 阶；同一画布内中心 #eceff3 ↔ 边缘 #d3d7dd 差 25 阶 |
| 玻璃 chrome | **≈2 成** | 玻璃 0.82 白 → #f6f8fb / #fbfcfd，与画布 #eaeef2 差 12–18 阶；390 TabBar 差 18 阶 |
| accent | **≈1.5 成** | 11px 选中态文字 #3b82f6 on #fcfcfe = **3.59**（<4.5）；默认聚焦的输入卡 934×98（8.9% 视口）整圈 1px accent |
| 阴影 | **≈0.5 成** | 唯一可见暗带在标题栏下沿：#dfe1e6，Δ14，20px 内衰减完；无叠影、方向一致 |

## 1. 复现方式

```
# 1) 运行时判据（仓库既有）
GOSSLAN_CHROME="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  node scripts/check-ui-runtime.mjs --only=ambient

# 2) 表面链/玻璃/阴影/对比/色雾四档采样（一次性探针，放在 /tmp，不进仓库）
node /tmp/lightaudit2.mjs      # → /tmp/light-audit2.json + 6 张截图
node /tmp/pixels.mjs           # 对已存 PNG 做固定坐标离线采样（避免选中元素误差）
node /tmp/profile2.mjs         # 阴影/雾的横向、纵向衰减曲线
node /tmp/de.mjs               # 四档 CIEDE2000 实测 + 薄纱上调后的投影
```

探针均只读页面（`Runtime.evaluate`）与截图，不改仓库文件。PNG 由 Node `zlib.inflateSync` 手解（Chrome 输出 8-bit RGB），逐行反过滤后取像素，不依赖图像库。

## 2. 表面链：计算值 → 最终像素（亮色 1280×800）

| 层 | 来源（`文件:行`） | 声明值 | 最终像素 |
| --- | --- | --- | --- |
| 窗口底 | `src/style.css:117` `--gosslan-bg` / `body background` | `#f1f5f9` + 色雾 | **#edf1f6** |
| 画布·聊天 | `src/style.css:570-571` `html[data-ambient="static"] .ambient-canvas` | `color-mix(in srgb, #ffffff calc(0.16*100%), transparent)` = **16% 白薄纱**；966×772 = **73.2% 视口** | **#eaeef2**（中心）/ **#eceff3** |
| 画布·列表 | 同上，base `#f1f5f9`（`ResponsiveLayout.vue` 列表容器 `ambient-canvas`） | 16% 薄纱；246×772 = 18.6% | **#eaecf1** |
| 列表选中行 | `src/style.css` `--gosslan-list-active: #dbe3ed` | 实色 | #dbe3ed |
| 玻璃 chrome | `src/style.css:342/343/344/345`；`TitleBar.vue:244`、`NavRail.vue:87` | `rgba(255,255,255,.82)` + `saturate(140%) blur(16px)`；2 元素、**8.3% 视口** | TitleBar **#f6f8fb**；NavRail **#fbfcfd** |
| 输入卡 | `MessageComposer` 容器 `bg-[var(--gosslan-panel)]`（`style.css:116`） | `#ffffff` 实色；934×98 = **8.9% 视口** | **#ffffff** |
| 浮层（emoji） | `EmojiPicker` `.frost`（`style.css:352/355`） | `rgba(255,255,255,.85)` + `saturate(160%) blur(20px)`；360×302 = 10.6% | **#fcfdff**（身后画布 #e9edf1） |
| 对方气泡 | `src/utils/chatStyle.ts:115` `LIGHT_OTHER_BUBBLE`、`:31` | `#eeeef0` 实色 | **#eeeef0** |

移动端 390×844：列表画布 **#ebedf2**；聊天画布 **#eef0f4**；TabBar（`ResponsiveLayout.vue:1124` `.frost`）**#fcfcfe**，390×66 = 7.8%。

暗色 1280 对照：titlebar #162132、rail #141e2e、列表 #121927、聊天 #1e293b、自己的气泡 #254e92。**暗色没有同题**（前景/背景分布正常），本轮不作修改对象。

**表面链的量化问题（关键）**：同屏六级白依次是 237（body）→ 234（聊天/列表画布）→ 246/251（chrome）→ 255（输入卡）。相邻跳变 3 / 12 / 5 / 4 / 21 阶，其中"画布 234 ↔ 输入卡 255"（21 阶）与"画布 234 ↔ chrome 251"（17 阶）是全屏最大的两处跳变。人眼读到的"玻璃很假/白条浮着"其实是**白跳变**，不是玻璃层数。

## 3. 玻璃普查（对照 ≤3 层 / ≤8 元素 / ≤40% 视口）

| 场景 | 玻璃元素 | 面积占比 | 判定 |
| --- | --- | --- | --- |
| 亮 1280 聊天 | TitleBar + NavRail | 2 / 8.3% | 未超 |
| 亮 1280 + emoji 浮层 | 上述 2 + `.frost` | 3 / **18.9%** | 未超 |
| 亮 390 列表态 | TabBar | 1 / 7.8% | 未超 |
| 亮 390 聊天态 | 0 | 0% | — |
| 亮 1280 设置页 | TitleBar + 176px 导航 | 2 / 16.8% | 未超 |

判据来源：[liquid-glass.md:22](../../design-language/liquid-glass.md)（面积 ≤40%）、[:131](../../design-language/liquid-glass.md)（同屏元素 ≤8）、三档设计 `glass-1/2/3`（层数 ≤3）。**三条全部通过**——这条常见嫌疑可以排除。

## 4. 阴影与发丝线普查

| 选择器 | 层数 | 内容 | 最大扩散 |
| --- | --- | --- | --- |
| `.glass-1`（亮，`style.css:1518-1525`） | 4 | `inset 0 0 0 1px rgba(255,255,255,.52)`、`inset 0 1px 0 rgba(255,255,255,.60)`、`0 1px 2px rgba(15,23,42,.04)`、`0 8px 24px rgba(15,23,42,.08)` | 24px |
| `.frost` / glass-2（`style.css:1529-1536`） | 4 | `inset 0 0 0 1px rgba(255,255,255,.60)`、`inset 0 1px 0 rgba(255,255,255,.70)`、`0 4px 12px rgba(15,23,42,.10)`、`0 16px 40px rgba(15,23,42,.12)` | 40px |
| glass-3（`liquid-glass.md:45`） | 1 | `0 24px 64px rgba(15,23,42,.18)` | 64px |
| `.glass-1`（暗，`style.css:497`） | 4 | inset .14/.20 + `0 1px 2px rgba(0,0,0,.30)` + `0 8px 24px rgba(0,0,0,.36)` | 24px |

- **无"阴影叠阴影"**：emoji 浮层的 wrapper 上 3 层全是 `rgba(0,0,0,0)`（Tailwind 占位），真实投影只落在子元素 `.frost` 上；`.frost` 的 computed `box-shadow` 仍包含两条 inset 发丝线，说明 Tailwind 的 `shadow-[var(--gosslan-glass-2-shadow)]` **没有覆盖** `.frost` 的发丝线（此前怀疑的"双绘/覆盖"已被 computed style 证否）。
- **方向一致**：所有 drop shadow 均为 `x=0, y>0`，不存在"方向不一导致漂"。
- **唯一可见的阴影**：标题栏下沿 `#dfe1e6`，20px 内回到画布色（Δ14）。
- **设置页那条"沟槽阴影"不是阴影**：对 (195,60)/(195,100) 做 `elementFromPoint` 链扫描，命中的是透明页容器，**链上没有任何 `box-shadow`**；那条 203→233（Δ30）的暗带是 `.ambient-blob--a` 的雾（DOM 取证）。所以按"阴影"去改这里会改错对象。

## 5. 对比度（现算 WCAG 相对亮度）

| 角色 | 前景 / 背景 | 比值 | 结论 |
| --- | --- | --- | --- |
| 正文 | `#0f172a` / 画布 `#eaeef2` | 15.31 | 通过 |
| 正文（对方气泡） | `#0f172a` / `#eeeef0` | 15.41 | 通过 |
| 次要文字 | `#475569` / 列表 `#eaecf1` | **6.92** | 通过（比需要更深） |
| 分割线 | `#e2e8f0` / 列表 `#eaecf1` | **1.13** | 发丝级 |
| 分割线 | `#e2e8f0` / 白 | **1.23** | 发丝级 |
| 按钮描边（设置页 Upload Avatar 1px） | `#e2e8f0` / 白 | **1.23** | 近乎不可见 |
| 占位符（主界面） | `#475569` / 画布 | **6.50** | 过深，与"次要文字"同档，看着像真值 |
| 占位符（设置页实测） | `#9ca3af` / 白 | **2.54** | 过浅，不达 4.5 |
| accent 文字（TabBar 11px 选中态） | `#3b82f6` / `#fcfcfe` | **3.59** | **不达 4.5** |
| accent 描边 | `#3b82f6` / 白 | **3.68** | 达 UI 3:1 |
| accent-ink（已有文字档） | `#2a5eb1` / `#fcfcfe` | **6.15** | 通过 |

来源：`style.css:16`（primary）、`:53`（accent-ink = 72% primary + 28% 黑，注释明确"primary 直接写字亮色 3.7 不够"）、`:129`（divider）、`:139`（text-2）。TabBar 选中态仍用 `text-[var(--gosslan-primary)]`（`ResponsiveLayout.vue:1128/1149/1172`）——已有 accent-ink 却没用上。

## 6. 色雾四档与 tint（亮 1280）

`--ambient-alpha` = 0.20 / 0.30 / 0.40 / 0.48（`style.css:368/381`），`--ambient-veil` = 0.16（`style.css:388`）。

| 采样点 | T1 20% | T2 30% | T3 40% | T4 48% | T1↔T2 ΔE00 |
| --- | --- | --- | --- | --- | --- |
| blob-c (1102,157) | #dcdfe4 | #d3d7dd | #cbd0d5 | #c5c9cf | **1.95** |
| blob-b (1278,798) | #e2e2e4 | #dddddd | #d7d6d4 | #d4d2cf | **1.58** |
| 聊天开阔区（安静中心） | #eceff3 | #eceff3 | #eceff3 | #eceff3 | ≈0 |

tint 混合值：`--ambient-tint` ≈ **#748aad**、`--ambient-tint-cold` ≈ **#888f98**、`--ambient-warm` ≈ **#aea498**（`style.css:391-397`，S 固定 30%）。

两条硬结论：

1. **档位差异只剩 1.58–1.95 ΔE**（AM-13 阈值 1.5，见 `ambient-motion.md:32/427`）。也就是说雾已经压到"刚好可辨"的下限——再把画布调白，这条判据会先红。
2. **同一张画布内，中心 #eceff3 ↔ 边缘 #d3d7dd 差 25 阶**。用户说的"看着难受/脏"里，有很大一块是同一片背景自身不平，而不是某个控件。

## 7. 成因排序（每条都指到读数）

### 7.1 底色 + 色雾 + 薄纱（≈6 成）

- `style.css:570-571`：每个可见区域只留一层 `16%` 白的薄纱；薄纱下面是 84% 的色雾。实测聊天画布 **#eaeef2**（token 是 `#ffffff`，`style.css:115`），列表 **#eaecf1**（token `#f1f5f9`，`:111`）。
- 后果 A：**气泡与画布同色**。`chatStyle.ts:115` 的 `LIGHT_OTHER_BUBBLE = #eeeef0` 是按"画布 = #fff"设计的（对白底 Δ17、ratio 1.159）；现在画布被压到 #eaeef2，实测 **ratio 1.006、Δmax 4**（≈不可见）。`style.css:125` 的 `--gosslan-card: #eeeef0` 同病。
- 后果 B：**六个白面 5 个值**（237 / 234 / 246 / 251 / 255）造成上述 17–21 阶白跳变。
- 后果 C：设置页导航旁的暗带被误读成阴影，实为 `.ambient-blob--a` 的雾（DOM 链上无 shadow）。

### 7.2 玻璃 chrome（≈2 成）

- `style.css:342` `--gosslan-glass-1-bg: rgba(255,255,255,.82)`，落在 84% 雾的画布上：0.82×255 + 0.18×~232 ≈ **251**，而画布是 **234**。白条由此产生，**与层数无关**（2 元素、8.3%，判据全过）。
- 降 alpha 只能砍掉一半：0.82→0.52 把 251 拉到 244（Δ17→Δ10）。要彻底消除白条得降到 ~0.16，那等于"没有玻璃"。白条的亮度由"白色 tint × 不透明度"共同决定，**不是层数问题**。

### 7.3 accent（≈1.5 成）

- `ResponsiveLayout.vue:1128/1149/1172` 的 11px 选中态用 `--gosslan-primary`：**3.59**，不达 4.5（`style.css:53` 已有 accent-ink：#2a5eb1 → 6.15）。
- 默认聚焦的输入卡 934×98（8.9% 视口）整圈 1px `#3b82f6`（`style.css` 的 `.gosslan-composer:focus-within`），在灰底上是全屏最"跳"的一条线。
- 自己的气泡 `#bdd1f0` 占 ~12.8%，但文字对比 11.75，合格，不算问题。

### 7.4 阴影（≈0.5 成）

- 只有标题栏下沿一条 14 阶暗带；机制干净（4 层、方向一致、无叠影）。**不是主因。**

## 8. 方案（A / B / C）

> 共同前提：本轮不改代码；以下都是 token 级、逐条可回退的改动，不新增动画/卡片/渐变。

### A（推荐）—— 修同屏层级与对比，**不动雾与薄纱**

| # | 改动 | 现在 → 改为 | 读数效果 |
| --- | --- | --- | --- |
| A1 | `chatStyle.ts:115` `LIGHT_OTHER_BUBBLE` | `#eeeef0` → **`#dfe3e9`** | 与画布 ratio **1.006 → 1.10**，文字仍 11.40；恢复"灰底上深一档气泡"的常规层级 |
| A2 | `style.css:125` `--gosslan-card` | `#eeeef0` → **`#e0e4e9`** | 与画布 ratio **1.10**；`--gosslan-card-line`（`:127`）已有 0.06 黑边，边界不依赖明度 |
| A3 | `style.css:342` `--gosslan-glass-1-bg`（仅亮色） | `.82` → **`.52`** | chrome **251 → 244**，与画布跳变 **Δ17 → Δ10**；标题栏文字仍 15:1 |
| A4 | `style.css:343` `--gosslan-glass-1-border` | `.52` → **`.72`** | 白条弱化后靠 1px 发丝线立边（看得到、不发亮） |
| A5 | `ResponsiveLayout.vue:1128/1149/1172` 的 `text-[var(--gosslan-primary)]` | → **`text-[var(--gosslan-accent-ink)]`** | **3.59 → 6.15** |
| A6 | 占位符：统一到新增 `--gosslan-placeholder: #5f6b7a` | 主界面 6.50 / 设置页 2.54 → **4.65–5.43** | 同屏规则一致，且两处都过 4.5 |
| A7（可选） | 输入卡默认聚焦描边 | 鼠标聚焦降为 `--gosslan-border`，`:focus-visible` 才保留 accent | 8.9% 视口的 accent 圈只在键盘导航出现 |

- **预期观感**：画布仍是灰蓝（环境身份保留），但气泡从"隐形"变"可辨"、chrome 从"白条"变"浅面 + 发丝线"、accent 只在选中/键盘态出现且达标。
- **风险**：A 不能消除"整体偏灰"——因为那正是 T2 雾 + 薄纱的必然结果；如果用户讨厌的是灰底本身，A 只能算半个解。
- **深色**：只改亮色 token（`.dark` 块 `style.css:421-449` 与 `:494-502` 不动），`chatStyle.ts` dark 行不动。占位符需给暗色补一条覆盖，否则沿用亮色值会偏暗。
- **移动端**：A1/A2/A5 同样受益；A3/A4 影响 390 的 TabBar 白条（`#fcfcfe → ≈#f4f6f8`），与列表 #ebedf2 差 18 → 10。
- **守卫/文档**：不动运行时 AM-13/AM-14/AM-15；但 `liquid-glass.md:43` 的 glass-1 值、`style.css` 顶部 token 注释要同步；`chatStyle` 的气泡预设表要同步（未发现静态判据钉住这两个值）。

### B（中等）—— 薄纱小步上调（0.16 → 0.40），并接受判据重标定

- 改动：`style.css:388` `--ambient-veil: 0.16 → 0.40`（暗色 0.14 不动）。
- 读数预测：聊天画布 #eaeef2 → **#f1f4f6**；气泡 ratio 1.006 → **1.049**；chrome 白条 Δ17 → **Δ10**；设置页雾带 Δ30 → **Δ17**。
- **代价**：实测四档可辨性 **1.58–1.95 → 1.05–1.44**，跌破 AM-13 的 1.5，必须同步改 `ambient-motion.md:141/153/157` 的薄纱表与四档图，并按仓库门禁规则"换参照物不放宽阈值"重新标定。
- 结论：**收益一半、判据要重标定**；且气泡 1.049 仍弱，还得叠加 A1。

### C（激进）—— 亮色实底、雾只留暗色

- 改动：`--ambient-veil` 亮 **1.0** + 亮色隐藏 `.ambient` 层。
- 结果：聊天 #ffffff、列表 #f1f5f9、气泡 ratio **1.159**、chrome 白条消失（0.82 白 on #fff 无差）。
- 代价：亮色环境动效等于删除；AM-13 在亮色失去意义（判据必须改成仅暗色生效），`ambient-motion.md` 与四档图大改；与 2026-11-05 用户看四档图后选定 T2 的决策直接冲突（`ambient-motion.md:220`）。
- 结论：这是**产品决策**，不是"配色优化"。

**推荐 A。** 不选 B：读数证明"可见雾"与"纯白画布"互斥（可行余量只有 1.58–1.95，阈值 1.5），B 用一半收益换一次判据放宽，风险不可归因。不选 C：等于删功能、推翻既定档位决策，越出"配色优化"的范围。

## 9. 截图

均在 `docs/notes/unslop-review-2026-11-06/shots/light-audit/`：

| 场景 | 文件 |
| --- | --- |
| 亮色 1280（会话列表 + 聊天 + 输入区） | `main-1280-light.png` |
| 亮色 390 列表 | `list-390-light.png` |
| 亮色 390 聊天 | `main-390-light.png` |
| 亮色 1280 浮层（emoji 弹层） | `overlay-emoji-1280-light.png` |
| 亮色 1280 设置页 | `settings-1280-light.png` |
| 暗色 1280 对照 | `main-1280-dark.png` |

## 10. 未采信 / 未验证的点

- 亮 390 列表选中行、聊天气泡的个别采样点落在头像/emoji 字形上（如 #768292、#ffba29），已剔除，不作为结论。
- 设置页分段控件出现"白字压白底 1.1"的读数，是采样点落到容器而非选中项（bg 解析错），已剔除；选中态实测为 accent-ink `#2a5eb1` 底。
- 设置页占位符 `#9ca3af` 的**读数**可靠（落在字形上），但**源码位置未定位**（主界面统一用 `placeholder:text-[var(--gosslan-text-2)]`）。A6 落地前需先定位那处输入端。
- 方案 A 的观感收益是**读数推算**（对比/跳变），不是试改后的截图；落地后需重跑 `--only=ambient` + 同口径截图复核。
