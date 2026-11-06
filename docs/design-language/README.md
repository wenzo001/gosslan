# Gosslan 设计语言参考

> v0.1 · 2026-11-05 · 研究基线与目标态，不是强制规范
> 强制规范仍是 [docs/design-guidelines.md](../design-guidelines.md)。两者冲突时，以 design-guidelines 与当前代码为准，直到本文条目被用户确认并迁入规范。

## 什么时候读

- 要改任何 `bg-[var(--gosslan-*)]`、圆角、阴影、模糊、控件的视觉。
- 新增浮层（菜单、Toast、Dialog、Sheet）或新的输入控件。
- Code review 里判断“这块该不该用玻璃”。
- 讨论“为什么聊天界面不能整片毛玻璃”。

## 谁该读

前端开发、UI 设计、Code Review 负责人。不需要读全篇；按下面的地图跳到对应文件。

## 五条原则

1. **玻璃只属于控制层，不属于内容层。** 标题栏、侧栏、TabBar、浮层可以玻璃；消息列表、气泡、正文、代码块必须实色。这是 Apple HIG 的明确规则，不是风格偏好。
2. **玻璃必须“有东西可采样”。** 背后全是同色不透明面时，`backdrop-filter` 与半透明实色在观感上没有区别；先有环境底色，才有毛玻璃。
3. **层级靠“玻璃层数”控制，不靠模糊半径堆。** 同屏最多 3 层玻璃、8 个玻璃元素；模糊半径 12–24px，上限 24px。
4. **控件收敛到 3 个语义 × 4 个尺寸。** 按钮只有 primary / secondary / danger；输入框只有 1 个底色 × 3 个尺寸。颜色只走 token，不再手写浅灰。
5. **可读性优先于通透。** 正文 4.5:1、大字 3:1、图形与焦点 3:1；系统降低透明度或低端机时，立即回退实色。

## 文档地图

| 文件 | 回答什么问题 |
| --- | --- |
| [liquid-glass.md](./liquid-glass.md) | 玻璃怎么分层、每层什么职责、模糊/透明度具体数值、什么情况禁止、性能红线 |
| [controls.md](./controls.md) | 按钮与输入框的尺寸、状态、颜色、圆角、间距、错误态，以及语义 token 命名 |
| [ambient-motion.md](./ambient-motion.md) | 背景怎么动：候选方案对比、色雾/颗粒/涟漪的数值规格、性能红线、降级与开关、可机器验收的判据 |
| [sources.md](./sources.md) | 每条结论的来源与置信度：官方 / 逆向观察 / 社区共识 / 个人推断 |

## 术语

- **chrome**：窗口框架与导航，包括标题栏、侧栏、会话列表头、移动端 TabBar、输入区外框。
- **content**：对话正文与消息列表、气泡、代码块、图片、设置正文。
- **float**：短暂浮层，包括下拉菜单、右键菜单、Popover、Toast、搜索建议。
- **sheet / modal**：阻塞式浮层，包括 Dialog、ActionSheet、全屏面板。
- **glass-1/2/3**：本文定义的三档玻璃，分别对应 chrome / float / modal。

---

## 附录 A：与现有实现的差距

以下结论均来自当前工作区源码（2026-11-05），行号为当时读数。

### A.1 现有“玻璃”其实只有一层很薄的模糊

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| [style.css](../../src/style.css#L1166-L1177) `.glass` / `.frost` | `blur(6px)` + `saturate(130%)`；`.frost` 底色 `rgba(255,255,255,.85)` / 暗色 `rgba(48,62,88,.9)` | 6px 只够柔化边缘，读起来仍是“脏灰色”；没有 1px 高光、没有边缘描边、没有外阴影层次 |
| `.glass` 的消费者 | 仅 [ImageLightbox.vue](../../src/components/message/ImageLightbox.vue#L356) | 注释说“BaseModal 用”，实际 [BaseModal.vue](../../src/components/BaseModal.vue#L132) 用的是实色 `--gosslan-overlay`，注释已过期 |
| `.frost` 的消费者 | 12 处菜单/Popover/下拉 | 这些浮层背后多半是实色面板，模糊几乎不可见，视觉上仍是半透明实色 |
| [ToastList.vue](../../src/components/ToastList.vue#L30) | 单独 `backdrop-blur-sm` | 没有走 `.frost` / 玻璃 token，参数与浮层不一致 |
| 降级 | [style.css](../../src/style.css#L1708-L1722) 已处理 `prefers-reduced-transparency` 与 `prefers-contrast` | 只覆盖 Chromium；Safari/WKWebView 不支持该媒体查询，macOS 端不会自动降级 |

### A.2 浅灰实色清单（用户所说的“灰色界面”）

| 区域 | 文件与选择器 | Token / 值 |
| --- | --- | --- |
| 应用底色 | [style.css](../../src/style.css#L325) body；暗色 [L411](../../src/style.css#L411)、[L435](../../src/style.css#L435) | `--gosslan-app-bg` `#edf1f6` / `#0b1220`，纯平色，无环境渐变 |
| 会话列表 | [ConversationList.vue](../../src/components/ConversationList.vue#L446) | `--gosslan-list` `#f1f5f9` / `#1e293b` |
| 左侧导航栏 | [NavRail.vue](../../src/components/NavRail.vue#L87) | `--gosslan-rail` `#e2e8f0` / `#16202f` |
| 标题栏 | [TitleBar.vue](../../src/components/TitleBar.vue#L244) | `--gosslan-caption` `#e2e8f0` / `#16202f` |
| 聊天画布 | [ChatWindow.vue](../../src/components/ChatWindow.vue#L1716) | `--gosslan-chat` `#ffffff` / `#0f172a` |
| 消息行/气泡 | [MessageItem.vue](../../src/components/MessageItem.vue#L1594-L1604) | 实色 `--gosslan-panel` / `--gosslan-list` |
| 弹窗卡片 | [BaseModal.vue](../../src/components/BaseModal.vue#L199) | `--gosslan-panel`，实色 |
| ActionSheet | [ActionSheet.vue](../../src/components/ActionSheet.vue#L162) | `--gosslan-panel`，实色 |
| 设置分组 | [SettingsGroup.vue](../../src/components/settings/SettingsGroup.vue#L12) | `--gosslan-panel`，实色 |
| 输入框背景 | 组件里 31 处 `bg-[var(--gosslan-bg)]`、3 处 `bg-[var(--gosslan-field)]`；`<input>` 内为 11 / 1，另有 7 处 `bg-transparent`，输入区卡片用 `--gosslan-panel` | 同一类控件混用页面底色、透明底与 field token |

结论：当前没有“玻璃可采样”的环境层。所有面都是平色，任何 `backdrop-filter` 都只能模糊另一块平色，结果必然接近实色。

### A.3 按钮现状

- 按钮类元素约 280 个 `<button>` + 8 个 `role="button"`；共享组件 `PrimaryBtn` / `SecondaryBtn` / `DangerBtn` 只有 29 处 import，其余是手搓。
- 共享组件定义了 4 个尺寸（`xs` / `dense` / `default` / `large`），但 [SecondaryBtn.vue](../../src/components/ui/SecondaryBtn.vue#L46) 的 `large` 缺 `font-medium`，[PrimaryBtn.vue](../../src/components/ui/PrimaryBtn.vue#L39) 与 [DangerBtn.vue](../../src/components/ui/DangerBtn.vue#L41) 有。
- 手搓按钮里出现 20 种 `px-* py-*` 组合（`px-3 py-1.5` 31 次、`px-4 py-3` 18 次、`px-2.5 py-1` 11 次等）。
- 按钮圆角出现 4 个档位：`radius-md` 91 次、`radius-sm` 62 次、`radius-xs` 9 次、`radius-lg` 9 次。
- 焦点环有全局 `:focus-visible` 2px 规则（[style.css L663-L666](../../src/style.css#L663-L666)），但环色是 55% primary；另有 2 处图标按钮改用 `ring-primary`，覆盖并不统一。

### A.4 输入框现状

- 26 个 `<input>`、2 个 `textarea`；背景出现 4 个家族：`--gosslan-bg` 11 次、`bg-transparent` 7 次、`--gosslan-field` 1 次、输入区卡片 `--gosslan-panel`（contenteditable）；textarea 另有 2 处 `--gosslan-bg`。
- 内距 3 种：`px-3 py-2` 7 次、`px-3 py-1.5` 7 次、`px-2.5 py-1.5` 2 次；字号 2 种：`text-sm` 与 `text-body`。
- 边框 2 种：多数 `border-transparent`，少数 `border-[var(--gosslan-border)]`。
- 焦点：[style.css](../../src/style.css#L668-L682) 的 `input:focus` / `textarea:focus` 规则体是空的，且输入框普遍写 `focus:border-transparent`，键盘用户只能看到光标，没有可见焦点指示。
- 错误态没有共享组件：红色边框、红色 helper、图标三种做法并存，存在只靠颜色表达错误的风险。
- 字号 token 存在双口径：Tailwind `body` 是 13px，CSS `--gosslan-text-body` 是 14px，同名不同值。

### A.5 按优先级排序的改造清单

| 优先级 | 改什么 | 影响面 | 风险 | 需要用户确认视觉 |
| --- | --- | --- | --- | --- |
| P0 | 输入框收敛为 `surface/field` 一个底色 + 3 个尺寸 + 统一边框 | 约 20 个组件 | 暗色下 `field` 比 `bg` 明显更亮，观感变化大 | 是 |
| P0 | 恢复文本输入焦点指示：1px 内描边 + 边框变色，不加外框 | 全部输入框 | 与用户“不要焦点框”的既有偏好冲突 | 是 |
| P0 | chrome 层改真玻璃：标题栏、侧栏、会话列表头、输入区外框 | 全局 | 首次引入环境渐变，观感变化最大；需同时做性能回退 | 是 |
| P1 | `SecondaryBtn` 的 `large` 补 `font-medium` | 1 个组件 | 极低 | 否 |
| P1 | 手搓按钮迁回 `PrimaryBtn` / `SecondaryBtn` / `DangerBtn` | 约 30 处 | 尺寸与内距会被统一，局部布局可能位移 | 是 |
| P1 | 删除 `.glass` 的过期注释，BaseModal 是否玻璃单独决策 | 注释 + 1 个组件 | 低 | 是（若改弹窗） |
| P2 | Toast / 菜单 / Popover 统一走 `glass-2` | 12 处浮层 | 中；浮层背后内容复杂时对比度下降 | 是 |
| P2 | Modal / Sheet 改 `glass-3` + scrim | 3 类浮层 | 中；大面积模糊的性能开销 | 是 |
| P2 | 引入环境底色（极淡的多点渐变） | body 一层 | 低性能开销，但全局色调改变 | 是 |

### A.6 `needs-user-signoff` 汇总

1. 引入环境底色（app background 渐变）。
2. chrome 层使用 `glass-1`（标题栏、侧栏、会话列表头、输入区外框）。
3. 浮层使用 `glass-2`，Modal/Sheet 使用 `glass-3`。
4. 按钮尺寸梯度调整到 24 / 28 / 32 / 36px。
5. 输入框底色从 `--gosslan-bg` 切到 `--gosslan-field`。
6. 文本输入恢复可见焦点指示。
7. 手搓按钮迁回共享组件（会改变局部尺寸与内距）。
8. 圆角归一：文本按钮 `radius-md`、图标按钮 `radius-sm`、大卡片 `radius-lg`。

## 附录 B：内容图容器（源图自带暗垫的已知边界）

**结论：内容图（`object-contain` 的 `<img>`）的元素框必须贴着真实画面走，圆角必须由这一处负责裁剪。**

- 禁止 `w-full` + `object-contain`：`w-full` 把元素框撑成容器满宽/满高，真实像素被 `object-contain` 缩在中间，
  元素上的 `border-radius` 落在**元素框角**上、离**内容角**几百像素 ⇒ 一个像素都裁不到。
- 正确写法：宽度 `auto` + `max-w-full`（竖直居中交给容器的 flex，或 `mx-auto`），让元素框 == 内容框。
- 判据：`scripts/check-ui-runtime.mjs --only=favthumb` 会断言「元素框与内容框宽/高差 ≤1px」，并在真渲染里对四角
  1/2/3px 取样、要求落在「底色↔内容色」线段上（阈值 4 = 实测噪声上限 2.11 的约 2 倍）；源码侧由
  `src/utils/designGuards.ts` 的 `checkContainImageClip`（IP-01）钉住三处：
  收藏详情预览 / 合并记录弹窗图片项 / 消息流图片气泡。

**已知边界（外部素材问题，不是回归）：**

- 有些源图**字节里自带**「圆角窗口 + 深色底」的暗垫 —— 典型是截图工具把窗口圆角和桌面一起拍进去，
  alpha 全 255（不是透明区）。真实样本 `image-172e3789-….png`（2000×1362）四角 ≈ `rgb(36,36,36)`，
  自带圆角 ≈ 宽度的 1.5%。
- 放大到显示尺寸后，源图自带圆角 ≈ 6.3px（423px 显示宽）；MD（8px）只比它大 0.5px 余量，
  2000→423 的重采样的模糊带仍会露出来（实测四角残留 69/109）。所以这类图**必须用 `radius-lg`（12px）**，
  才有约 2.3px 余量把整条带切掉。
- **比例边界**：源图自带圆角比例超过约 **2.8% 宽度**（12px / 423px）时，12px 裁剪不够，暗边仍会露。
  这是外部素材的几何问题，修法是换素材或换更小的显示尺寸，**不是**回归，不要去改圆角判据或阈值。
- 「裁剪只有一处」不等于「加 `isolation`」：这里没有半透明边界参与混合，不需要 `isolation:isolate`，
  也不需要给容器再补一层深色垫底（垫底色一律跟随主题，禁止字面黑）。

