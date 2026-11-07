# 决策：触屏长按正文 = 先弹面板，「选择文字」再进原生选字

- 状态：**已拍板**（用户 2026-11-07 明确保留该做法，不回退）
- 生效版本：5.18.78
- 涉及代码：`src/utils/longPress.ts`、`src/components/MessageItem.vue`、`src/style.css`、`src/components/message/MessageTextBubble.vue`

## 1. 原决定（2026-10-23）

> 触屏下**长按正文 = 系统原生选字**（选区手柄 + 系统复制菜单）；自定义消息面板只在
> **非正文**区域（气泡内边距 / 昵称 / 引用块 / 卡片）长按时出现。

实现方式：`shouldStartLongPress` 命中 `.gosslan-selectable` 直接返回 `false`；
`@media (pointer: coarse)` 里把 `.gosslan-selectable` 显式设为 `user-select: text`，
并让触屏 `contextmenu` 在可选正文上放行给 WebView。

## 2. 新决定（2026-11-07）

> 触屏长按**正文与图片同一套**：先弹自定义消息面板。
> 面板里的「选择文字」是进入系统原生选字的入口；进入后整列（含引用块、代码）重新开放
> `user-select: text`，选区一收起就自动退出该模式。

实现方式：`shouldStartLongPress` 不再看落点是否可选正文；
`@media (pointer: coarse)` 下 `.gosslan-bubble-text` 与 `.gosslan-selectable` 默认
`user-select: none`，只有 `.gosslan-selecting`（「选择文字」打开）才恢复 `text`；
触屏 `contextmenu` 一律拦下，让面板成为唯一入口。

## 3. 原因

用户安卓实测反馈：**「安卓长按文字失效（图片长按仍在）」**。

拆开看是两个事实叠出来的：

1. 正文层默认可选 ⇒ 长按正文时 WebView 直接接管去建选区，自定义面板的 500ms 定时器
   永远不会起（判据里 `hitSelectable` 提前 return）；
2. 安卓 WebView 上这条路径**没有稳定的可见反馈**（选区手柄/工具条时有时无）。
   用户感知不是"换成了系统选字"，而是"这个功能消失了"。

对照面：图片不可选 ⇒ 面板照弹。所以用户看到的差异恰好是"只有文字坏了"。
结论：在安卓上，"原生选字优先"等于把功能做没了；面板优先 + 「选择文字」二级入口
既恢复可见反馈，也没有丢掉原生选字能力。

## 4. 影响面

| 场景 | 变化 |
| --- | --- |
| 触屏长按文字气泡 | **变**：先弹面板（原来直接进系统选字） |
| 触屏长按图片 / 文件 / 卡片 | 不变：仍是面板 |
| 面板「选择文字」 | 新增实际入口：进入 `.gosslan-selecting` 后原生选字/复制可用（原来正文本来就能选，这个按钮是"全选"快捷入口） |
| 桌面右键 | 不变：一律弹自定义菜单；有选区时带「复制选中内容」 |
| 桌面拖选 | 不变：`.gosslan-selectable` / 气泡根 `select-text` 仍开放 |
| 多选模式、系统消息 | 不变：长按不弹面板 |

## 5. 可验证链（源码路径 + 判据）

「选择文字」点下去之后，`user-select` 是否真的开启，按下面 5 环逐环可查：

| # | 环 | 源码位置 | 内容 |
| --- | --- | --- | --- |
| 1 | 面板入口 | `MessageItem.vue`（`message.kind === 'text'` 的按钮，`t("common.selectText")`） | `@click="enterTextSelect"` |
| 2 | 状态位 | `MessageItem.vue` `enterTextSelect()` | `closeActionSheet(); textSelecting.value = true;` |
| 3 | 传参 | `MessageItem.vue` 模板 `:select-mode="textSelecting"` | 传给 `MessageTextBubble` |
| 4 | 类名 | `MessageTextBubble.vue` 气泡根 `:class="selectMode ? 'gosslan-selecting' : ''"` | 落类 |
| 5 | 样式 | `style.css` `@media (pointer: coarse)` 块（`[data-msg-col] .gosslan-selecting *`） | `-webkit-user-select: text; user-select: text; -webkit-touch-callout: default;` |

退出链：`watch(textSelecting)` 挂 `document.selectionchange` → `onSelectingChanged()` 在
选区折叠或为空时把 `textSelecting` 置回 `false`（避免状态残留导致下次长按弹不出面板）。

判据：

- `src/utils/longPress.test.ts`：真值表（触屏正文必须 `true`）+ 结构判据
  （源码再出现 `hitSelectable` / `lastTouchTextCol` 即红）。
- `src/utils/designGuards.test.ts`：触屏选字契约（正文默认 `none`、`.gosslan-selecting`
  才 `text`），并带"旧写法必须被咬住"的反例自证。
- 上述 5 环另有链式判据（缺任一环即红）。

## 6. 真机验证（待真机，本仓库当前无安卓设备）

自动化只能测到 CSS 规则与类名是否接上（浏览器触屏仿真能覆盖 1–4 环，覆盖不了
安卓 WebView 的选区工具条）。真机按下面步骤验收：

1. 安卓 / 鸿蒙设备打开任意含文字消息的会话；
2. 长按文字正文 → 应弹出消息面板（与长按图片一致）；
3. 点「选择文字」→ 应出现系统选区手柄；拖动可选中，系统工具条可复制；
4. 点空白处收起选区 → 再长按同一条，应再次弹面板（验证退出链没有残留）。

第 2、3 步任一不成立，即为回归；先查 `MessageItem.vue` 的 `textSelecting` 与
`MessageTextBubble.vue` 的 `select-mode`，再查 `style.css` 的 coarse 块是否被工具类压回。
