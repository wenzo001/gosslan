# Gosslan 视觉与交互规范（UI Design Guidelines）

> Version: 1.0 · 2026-09-10  
> 依据：Apple Human Interface Guidelines 与 WWDC25「Get to know the new design system」  
> 的 **Shape & Concentricity**、语义色与交互态取向（iOS 26 / Liquid Glass 时代）。
>
> **强制条款**：**后续所有新功能，如果没有特殊要求，一律按本规范执行**；  
> code review 时按本文末尾的自查清单核对。要偏离必须显式说明理由并写进改动描述。

---

## 0. 三条总原则（与上面对齐）

1. **形状表达密度与层级**，不是装饰。同一层级用同一档圆角；不要到处都圆。
2. **同心**：嵌套面的内圆角必须与外圆角同源（见 §2.3）。不允许内角被夹扁或外翻。
3. **系统拥有窗口形状**：应用**不自己画窗口圆角**（见 §5）。

---

## 1. 圆角规范

### 1.1 三类形状（先选类，再选值）

| 形状                    | 用在哪                   | 本应用对应                  |
| --------------------- | --------------------- | ---------------------- |
| **固定半径**              | 紧凑、密集的控件（默认选择）        | 列表行、导航项、按钮、菜单项、气泡      |
| **胶囊 `rounded-full`** | 半径 = 高度一半；高强调、需要"可点"感 | 头像、在线状态点、未读徽标、圆形图标按钮   |
| **同心**                | 嵌套面：内圆角 = 外圆角 − 内外间距  | 菜单项在菜单里、格子在选择器里、卡片在面板里 |

> Apple 对 macOS 的补充：**小/中等密度的控件保持圆角矩形即可**，不必强行胶囊化。  
> 因此本应用**没有**把普通按钮改成胶囊——这是有意保留，不是遗漏。

### 1.2 圆角梯度（唯一来源：`src/style.css`）

| Token                   | 值      | 用途                             |
| ----------------------- | ------ | ------------------------------ |
| `--gosslan-radius-xs`   | 4px    | 内联小色块：@提及、行内代码、搜索高亮            |
| `--gosslan-radius-sm`   | 6px    | 紧凑控件：下拉项、工具条按钮、气泡、头像           |
| `--gosslan-radius-md`   | 8px    | 标准控件：列表行、导航项、菜单容器、输入框、设置行、代码卡片 |
| `--gosslan-radius-lg`   | 12px   | 浮层与卡片：弹层、设置分组、大卡片              |
| `--gosslan-radius-xl`   | 16px   | 大面板：模态、资料卡                     |
| `--gosslan-radius-pill` | 9999px | 胶囊（等同 `rounded-full`）          |

语义别名（保留旧名，值统一来自上表）：`--gosslan-avatar-radius`=sm、`--gosslan-item-radius`=md、`--gosslan-bubble-radius`=sm。

**用法**：一律写 `rounded-[var(--gosslan-radius-md)]`，不要写 `rounded-lg` 这类 Tailwind 字面值——  
字面值无法全局调，也看不出"这一档是给谁用的"。方向变体同理：`rounded-t-[var(--gosslan-radius-md)]`。

### 1.3 同心公式（最容易出错的一条）

```
内圆角 = 外圆角 − 内外间距          （结果 < 0 时取 0）
```

| 场景        | 外                 | 间距        | 内（正确）                           |
| --------- | ----------------- | --------- | ------------------------------- |
| 右键菜单项在菜单里 | `rounded-lg` 8px  | `p-1` 4px | **4px（xs）**                     |
| 表情格子在面板里  | `rounded-xl` 12px | `p-2` 8px | **4px（xs）**                     |
| 代码卡片在气泡里  | 气泡 6px（sm）        | 0（卡片贴边）   | **6px（sm）**，即 `rounded-t-[…sm]` |

> 若容器设了 `overflow-hidden`，子元素不画圆角也可以（容器会裁）；但只要子元素自己画了圆角，  
> 就必须按公式取值——否则会出现 Apple 明确禁止的"**内角外翻**"（内比外还圆）。

### 1.4 文字与图标的"视觉对齐"（光学对齐）

排版盒对齐 ≠ 看起来对齐。**半行距会把文字墨迹往下推**：
`font-size: 11px` 的行盒在 `line-height: 1.5` 时是 16.5px，墨迹顶边落在行盒顶下方约 **3.7px**
（中英文同样存在，实测 3.0–4.0px）。当文字与一个**图标/头像并排**时，这个偏移就会读作"文字低了一截"。

规则：

- 并排的图标与文字，**行盒顶 = 图标顶**（flex 行默认就是如此，不要额外加 `items-center` 去"居中"文字行）。
- 需要"贴顶"时，用 **`leading-none`**（行盒 = 字号）消除半行距，而不是用负 margin 硬拽。
- 改行高必然改变行盒高度 → **同时把高度估算法里的常量改掉**（`utils/messageHeight.ts`），
  否则虚拟列表会错位。示例：群聊昵称行 `leading-none`(11) + `mb-[7px]` = 18 = `NICKNAME_ROW` ✓。

### 1.5 红线

- ❌ 新增字面值圆角（`rounded-lg` / `border-radius: 8px`）——必须用 token。
- ❌ 内圆角 ≥ 外圆角（外翻）。反例（本次已修）：菜单容器 8px + `p-1`，菜单项却用 6px。
- ❌ 给**窗口根容器**加圆角（见 §5）。
- ❌ 同一层级混用不同档位（例如列表里既有 6px 又有 8px 的同类行）。

---

## 2. 交互态规范（hover / press / focus）

iOS 的取向：**hover 必须克制**（只做轻微加深/提亮，**不做位移与缩放**——密集列表里位移会让"行在跳"），  
而且**必须有 press 态**，否则按下去像没反应。

| 态         | 规则                           | 实现                                                                        |
| --------- | ---------------------------- | ------------------------------------------------------------------------- |
| **hover** | 中性面加深；危险/警告用语义 token         | `hover:bg-[var(--gosslan-hover)]`、`hover:bg-[var(--gosslan-danger-soft)]` |
| **press** | 全局统一压暗/提亮，不需要逐个写             | `src/style.css` 的 `button:active` / `[role=button]:active` 全局规则           |
| **focus** | 只用键盘时出现焦点环（`:focus-visible`） | 全局规则 + `--gosslan-focus-ring`                                             |

### 2.1 允许的 hover 取值（白名单）

- 中性面：`--gosslan-hover`（面板/列表/菜单项通用）
- 列表与侧栏的专用层：`--gosslan-list-hover`、`--gosslan-rail-hover`（保持三档灰阶层次，不要混用）
- 语义：`--gosslan-danger-soft`、`--gosslan-warning-soft`
- 彩色面上的"提亮"蒙层：`hover:bg-white/15`、`hover:bg-white/20`、`hover:bg-black/5`（**仅限**彩底/图片上的覆盖层）
- 不透明度类：`hover:opacity-80/90/100`（用于图标按钮，不得用于整行）

### 2.2 红线

- ❌ 写死颜色：`hover:bg-[#e81123]`、`hover:bg-red-500/10`、`hover:text-amber-500`（本次已全量替换为语义 token）
- ❌ 只有 hover 没有 press（全局规则已兜底，但自定义组件不得用 `filter` 以外的方式覆盖掉它）
- ❌ hover 做 `translate` / `scale` / 阴影大幅变化

### 2.3 触摸与触觉（"原生手感"）

WebView 默认自带"网页感"，来源就四件事，`src/style.css` 的「原生手感基线」已逐条处理：

| 网页感来源 | 处理方式 |
|---|---|
| 点击时闪一块半透明高亮（Android 最明显） | `-webkit-tap-highlight-color: transparent` |
| 双击缩放判定吃掉首次点击的即时反馈 | `touch-action: manipulation`（**保留捏合缩放**，不禁用缩放本身） |
| 内容滚到头还把整页拖出去再弹回来 | `overscroll-behavior: none`（页面）/ `contain`（滚动容器） |
| hover 的过渡把"按下"拖慢约 150ms | `:active` 里 `transition-duration: 0s` → **按下瞬时、松手平滑** |

**按下反馈的两条铁律**（对应 iOS 的 "press feedback on touch-down"）：

1. **按下必须立即变色**，不能等过渡跑完；松手再平滑回落（`transition-duration` 只在 `:active` 归零）。
2. **`<div>` 形态的可点行同样要有反馈**：本仓约定「写了 `cursor-pointer` 就是可点」，全局规则已覆盖。

**触觉（`src/utils/haptics.ts`）** —— 按 Apple 的触觉词汇与时机，**不是每个点击都给**：

| 时机 | 类型 | 依据（Apple 对应） |
|---|---|---|
| 发送消息 | `light` | 按下即反馈，不等网络结果 |
| 切换会话 | `selection` | 离散选择变化（UISelectionFeedbackGenerator） |
| 长按菜单弹出 | `heavy` | 菜单出现时的重反馈 |
| 成功 / 警告 / 失败 | `success` / `warning` / `error` | 语义结果（对应两段 / 两段 / 三连震） |

平台限制（**不要把它当成 iOS 级触觉**）：

- Android WebView：走 `navigator.vibrate`，**需在 AndroidManifest 声明 `VIBRATE` 权限**；
  粒度只有时长/节奏，拿不到 iOS 的 light/medium/heavy 质感。
- iOS（WKWebView）：**不支持** `navigator.vibrate` → 自动 no-op；真触觉须走原生
  `UIFeedbackGenerator`（Tauri 插件或平台代码，属后续项）。
- 桌面：无此 API → no-op。`prefers-reduced-motion` 下也不触发。

**动效令牌**：`--gosslan-ease`（强 ease-out：起步快、收尾稳，比 Tailwind 默认的 standard
曲线更"跟手"）、`--gosslan-duration-fast`(150ms，轻反馈) / `--gosslan-duration`(240ms，结构性变化)。
Tailwind `.transition` 系列的曲线由本文件统一覆盖。

**点按目标**：触屏上小于 44px 的独立小按钮加 `class="tap-safe"`——只在**垂直**方向扩到 44px，
横向不扩（横向相邻控件彼此会抢点击）。

---

## 3. 配色规范

1. **语义色优先**，且必须同时提供浅/深两套（本应用：`:root` + `.dark`）。

| Token                    | Light                 | Dark                   | 用途                  |
| ------------------------ | --------------------- | ---------------------- | ------------------- |
| `--gosslan-danger`       | `#ff3b30`             | `#ff453a`              | 危险/删除/关闭（Apple 系统红） |
| `--gosslan-danger-soft`  | `rgba(255,59,48,.12)` | `rgba(255,69,58,.18)`  | 危险的浅底 hover         |
| `--gosslan-warning`      | `#ff9500`             | `#ff9f0a`              | 警告（Apple 系统橙）       |
| `--gosslan-warning-soft` | `rgba(255,149,0,.12)` | `rgba(255,159,10,.18)` | 警告的浅底 hover         |

1. **品牌色可被用户改**（`--gosslan-primary`），所以任何地方都不要硬编码主题蓝；  
   需要"跟随主题色"的派生色用 `color-mix(in srgb, var(--gosslan-primary) …)` 或  
   `utils/chatStyle.ts` 里已有的派生函数（它们带对比度校验）。
2. **可读性优先**：文字色与底色的对比度 ≥ 4.5:1（`utils/chatStyle.ts` 已实现校验，不要绕过）。

---

## 4. 骨架屏（首屏）同步规则

`index.html` 的内联骨架样式跑在 bundle 之前，**无法引用 CSS 变量**，因此它是**唯一**允许写字面值的地方：

- 骨架用到的圆角/底色必须在注释里注明对应的 token，**改 token 时同步这里**；
- 骨架**不画窗口圆角**（与 §5 一致），否则启动瞬间会看到"角落跳一下"；
- 骨架的三栏宽度/高度必须与真实布局一致（参见该文件内已有注释）。

---

## 5. 窗口与系统边界（本次修复的根因）

**窗口形状由系统负责，应用不自绘。**

- Windows：DWM 提供圆角（`tauri.conf.json` 的 `shadow: true`…）；**最大化时系统不再圆角**。
- macOS：系统窗口圆角。

因此**不要给根容器加 `rounded-xl`**：应用再画一层，就会与系统边界错位——容器圆角之外那圈  
露出 `body` 底色（亮色 `#edf1f6` ≈ 白），表现为"窗口角上有一道白缝"，hover 成红色后尤其刺眼。  
同理，窗口内的**标题栏按钮不要自己画圆角**：让它被窗口边界裁切，曲线才唯一。

> 这条同时满足 iOS 的"窗口/面板边缘由系统或容器统一负责"取向，也避免了 §1.3 的同心外翻问题。

---

## 6. 自查清单（提交前逐条打勾）

- [ ] 新增/修改的圆角全部用 `--gosslan-radius-*` token，没有字面值
- [ ] 嵌套面按 §1.3 公式取内圆角（内 < 外）
- [ ] hover 只用 §2.1 白名单里的值；没有硬编码十六进制
- [ ] 交互元素有 press 反馈（全局规则已覆盖，确认没有被 `filter`/背景覆盖掉）
- [ ] 新增的可点元素要么是 `<button>`，要么带 `cursor-pointer`（否则按下去没反应）
- [ ] 关键动作按 §2.3 给了对应触觉，且**没有每个点击都给**
- [ ] 触屏上小于 44px 的独立小按钮加了 `tap-safe`
- [ ] 新增动效使用 `--gosslan-ease` 与时长令牌，没有另写曲线
- [ ] 危险/警告色用语义 token，且浅深两套都定义了
- [ ] 没有给窗口根容器或标题栏按钮加圆角
- [ ] **字号取自 §8 的五档标尺（≥11px），字重只用 400/500/600**
- [ ] **交互先改 UI 再 `await`（§9）；数据未到渲染骨架，不闪"空态"；异步路径必有终态**
- [ ] 若改了 token 或布局尺寸，`index.html` 骨架同步更新
- [ ] 布局尺寸变了的话，同步 `utils/previewMetrics.ts` / `messageHeight.ts`（虚拟列表估算）

---

## 7. 本次审计结论（2026-09-10）

已修复：

1. **窗口角白缝**（根因 + 修法见 §5）：根容器 `rounded-xl` 与系统圆角错位；已移除，并同步去掉骨架里的 `12px`。
2. **硬编码危险色**：`#e81123`（关闭键）、`red-500/600`、`amber-500` 等 61 处 → 语义 token（浅深两套）。
3. **同心外翻**：右键菜单项 6px → 4px、表情格子 6px → 4px、代码卡片顶部 8px → 6px。
4. **缺 press 态**：新增全局压暗/提亮规则 + 键盘焦点环。
5. **圆角双词汇表**：99 处 Tailwind 字面圆角类 → token（值 1:1，**零观感变化**，已用产物 CSS 实测核对）。

已知偏差（有意保留，后续按需处理）：

- 高强调按钮未改胶囊（Apple 对 macOS 中等密度控件允许保持圆角矩形）。
- `ConversationList` 的加号下拉菜单项没有圆角（容器 `overflow-hidden` 会裁，功能上正确），  
  若要 hover 有"胶囊项"质感，可补 `rounded-[var(--gosslan-radius-xs)]`。
- 骨架屏仍是字面值（受限于 CSS 变量不可用，见 §4）。

### 7.1 第二轮审计（同日晚）

| 发现 | 处理 |
|---|---|
| **左右两栏头部分隔线不齐**：左栏列表头是 `px-3 py-2` + `h-9` 搜索框 = **52px 且无底边线**，右栏 `ChatHeader` 是 **56px + `border-b`** | 左栏改用同一个 `--gosslan-header-h` + 同款 `border-b` → 分隔线合为一条（渲染实测：两栏同在 y=93.00、亮度一致） |
| 圆角字面值残留 1 处（`MessageCodeBubble` 组件内的 `border-radius: 0 0 8px 8px`） | 改用 `--gosslan-radius-md` |
| 排版散值：`8/9/10px`（低于最小正文档）、`13.5px`（半步值）共 20 处 | 收进标尺：→ `11px` / `13px`（见 §8） |
| **交互审计**：全量核对 store 的 `await api.*`，多数已是乐观更新（`send` 先插 `tmp-*`、`openConversation` 先切 `activeConv`、`removeFriend`/`deleteConversation` 先改本地） | 确认合规；`sendFileTo` 不加乐观气泡是**有意例外**（见 §9.3） |
| **切会话会先闪一句"暂无消息"**（`messages[convId]` 未加载完时是空数组 → 走了空态分支） | 新增加载骨架 + `loadMessages` 失败终态 → 渲染过渡态而非空态（§9.2、§9.4） |

---

## 8. 排版标尺（Text Styles）

按 Apple HIG 的**语义档位**映射（Subheadline / Body / Footnote / Caption1 / Caption2），
**不允许随手写中间值**：

| token | 值 | Apple 档位 | 用在哪 |
|---|---|---|---|
| `--gosslan-text-title` | 15px | Subheadline | 会话标题、群名（最大一级） |
| `--gosslan-text-body` | 14px | Body | 消息正文（= `--gosslan-msg-size`，**用户在设置里可改**） |
| `--gosslan-text-callout` | 13px | Footnote | 列表行标题、输入框、次级正文 |
| `--gosslan-text-footnote` | 12px | Caption1 | 摘要、引用块、辅助说明 |
| `--gosslan-text-caption` | 11px | Caption2 | **正文最小可用字号**：昵称、时间、徽标 |

现有代码里用 Tailwind 名的对应关系：`text-sm` = body(14)、`text-xs` = footnote(12)。

**红线**

- ❌ 字号不在五档内。本次审计已把 `8px / 9px / 10px → 11px`、`13.5px → 13px` 全部收进标尺。
- ❌ 小于 11px 的正文（那是 Apple 的最小正文档；徽标里的数字同样按 11px 处理）。
- ❌ 用 Bold/Black 做正文或列表强调——只用 **Regular(400，默认) / Medium(500) / Semibold(600)**。
- ❌ 负 letter-spacing。
- ❌ 字号随窗口宽度缩放（不要 `vw` 字号）。
- ⚠️ 改字号必须同步行高（成对：11↔16 / 12↔20 / 13↔20 / 14↔22 / 15↔24）以及相关高度估算常量。

**合规现状（本次审计）**：字重只有 medium/semibold 两级 ✓；未使用 tracking 负值 ✓；
`--gosslan-msg-size` 被设置页覆盖属于**有意例外**（用户的阅读偏好优先于标尺）。

---

## 9. UI 优先：不可阻断渲染

**规则：交互事件首先更新 UI，所有 IO 异步且不阻断渲染。数据可以晚到，界面不能等。**

1. **点击 → 同帧出反馈。** 按下有 press（§2.3），选中态/打开态**同步**改，不要 `await` 之后再改。
   范例：`openConversation` 第一行就是 `activeConv.value = id`，之后才异步取消息。
2. **数据未到时渲染"过渡态"，不是"空态"。** 切会话时 `messages[convId]` 还不存在 →
   渲染加载骨架（`ChatWindow` 的 `messagesLoading`），**绝不能先闪一句"暂无消息"**。
3. **乐观更新 + 失败回滚。** 本地状态先改，IPC 失败再回滚并提示。
   范例：发送消息先插入 `tmp-*` 气泡；删除好友先移除行、失败再加回。
   **有意的例外**：文件/图片发送**不加**手工乐观气泡——后端会在返回前同步 emit 完整元数据，
   手工拼的"只有文件名"的记录会与真实记录按 `msg_id` 去重竞态而丢元数据（见 `sendFileTo` 注释）。
4. **异步路径必须有终态。** 成功或失败都要落到一个可渲染的状态，
   否则骨架/加载指示器会永久停留（`loadMessages` 的 `catch` 就是这个作用）。

**性能配套**：反馈只用 paint 级属性（`filter` / 背景色 / `transform`），不触发重排；
长列表一律走 `VirtualList`；语法高亮等重活不得放在点击的同步路径上。
