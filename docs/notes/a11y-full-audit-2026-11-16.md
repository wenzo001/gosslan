# 全量无障碍审计（2026-11-16）

> 背景：用户 2026-11-16 要求「体验收尾，完整全量来一遍」。这一轮做的是**全量静态扫描
> + 把尚未覆盖的维度固化成判据**，而不是仅凭印象补几个 `aria-label`。
>
> ⚠️ **边界**：本轮**没有在真浏览器/读屏器里跑过**（当前环境没有可用的本地浏览器，
> Playwright 后端与 dev server 不在同一网络空间）。所以「0 缺口」指的是**下面列出的
> 静态维度**，不是「完全无障碍」。运行时读屏（VoiceOver / TalkBack / NVDA）仍是 `NOT RUN`。

## 扫了哪些维度、结果如何

| 维度 | 覆盖方式 | 结果 |
|---|---|---|
| 纯图标按钮的可访问名（`aria-label`） | `a11yLabels.ts::findUnlabeledButtons`，全仓判据早已在册 | **0** |
| `<img>` 的 `alt`（含装饰性 `alt=""`） | `a11yLabels.ts::findUnnamedImages`，全仓判据早已在册 | **0** |
| 截断文本 `truncate` + `title` | `designGuards.test.ts` 全仓判据 | **0** |
| 焦点环（`focus-visible:ring` / `ring-inset`） | `designGuards.test.ts` 全仓判据 | **0** |
| 悬停揭示的触屏兜底 | `designGuards.test.ts` 全仓判据 | **0** |
| 文件进度条 `progressbar` / `aria-valuenow` / live region | `designGuards.test.ts` 具名判据 | **0** |
| 加载 / 失败的文字等价物 | `designGuards.test.ts` 判据 | **0** |
| **正数 `tabindex`（破坏自然 Tab 顺序）** | 本轮**新增** `findPositiveTabindex` + 全仓判据 | **0** |
| **可点击的非交互元素缺键盘出口** | 本轮**新增** `findClickableWithoutKeyboard` + 全仓判据 | **0** |
| `<a>` 纯图标链接无可访问名 | 临时脚本扫描 | **0** |
| 表单控件无可访问名且无 `id` 可关联 label | 临时脚本扫描 | **0**（4 处命中全是注释误报或已有 `placeholder`） |

**结论：124 个 `.vue` 里，上述 11 个静态维度全部 0 缺口。**

## 本轮新增的两个判据（防回退）

「0 缺口」如果只是一次性脚本跑出来的，明天有人加一个 `tabindex="1"` 或一个
`<div @click>` 就会静默回退。所以把两个**原本没有判据**的维度固化了：

### 1. `findPositiveTabindex`

- **为什么**：`tabindex="1"`（任何正数）把元素提到所有 `tabindex="0"` 之前，
  且按数值排序 —— 一个正数就能让整页 Tab 顺序 ≠ 视觉顺序。
- **口径**：只判模板里**字面写死的正整数**；动态 `:tabindex="expr"` 不判
  （表达式可能是 `-1`，机械判不出）。`tabindex="0"` / `"-1"` 合法。
- **反例自证**：注入 `tabindex="1"` ⇒ 判据当场红，还原后绿（已实跑）。

### 2. `findClickableWithoutKeyboard`

- **为什么**：`<div @click="…">` / `<span @click="…">` 是典型的「鼠标能用、键盘点不到」。
- **口径**：只看开标签**直接**带 `@click` 的非交互元素（`div/span/li/p/section/tr/img`）；
  有 `role` / `tabindex` / `@keydown` 任一即算有出口；组件标签不判（内部自己负责）。
- **反例自证**：`<div @click>` 被抓；补齐 `role+tabindex+@keydown` 后通过（已实跑）。

两条判据都在 `src/utils/a11yLabels.test.ts`，全仓扫 124 个 `.vue`。

## 没做的事（以及为什么）

- **真浏览器 / 读屏器实测**：当前环境无本地浏览器；Playwright 后端连不上 dev server
  （网络空间隔离）⇒ 做不了 Tab 遍历与读屏验证。这是**最大的未验证面**。
- **对比度的逐像素实测**：现有判据只钉住「主色实底的填充 + 前景成对」（设计 token
  层面），没有跑 axe 之类的自动对比度扫描。
- **`aria-hidden` 语义正确性**：能机械判的只有「可聚焦元素不许 `aria-hidden`」，
  本轮未加这条判据（当前全仓只有装饰性 `<Icon aria-hidden>`，无误用）。

## 复跑命令

```bash
node --experimental-strip-types --test src/utils/a11yLabels.test.ts
npm test
```
