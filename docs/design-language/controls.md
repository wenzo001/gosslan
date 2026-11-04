# 按钮与输入控件规格

> 目标是把控件收敛到少数可预测的组合。所有数值都是**目标态**；凡会明显改变观感的条目，在文末标 `needs-user-signoff`。
> 现有 token 定义在 [src/style.css](../../src/style.css#L120-L205)，圆角在 [L273-L287](../../src/style.css#L273-L287)。

## 1. 语义 token 与 Tailwind 映射

只新增语义层，不替换现有 `--gosslan-*` 物理 token；Tailwind 通过 `theme.extend.colors` 映射，组件里仍可继续用任意值写法。

| 语义 token | CSS 变量 | Tailwind | 说明 |
| --- | --- | --- | --- |
| `surface/glass-1` | `--gosslan-glass-1-bg` | `bg-surface-glass-1` | chrome 玻璃 |
| `surface/glass-2` | `--gosslan-glass-2-bg` | `bg-surface-glass-2` | float 玻璃 |
| `surface/glass-3` | `--gosslan-glass-3-bg` | `bg-surface-glass-3` | modal 玻璃 |
| `surface/solid` | `--gosslan-panel` | `bg-surface-solid` | 内容层实色 |
| `surface/field` | `--gosslan-field` | `bg-surface-field` | 输入字段底色 |
| `control/bg-rest` | `transparent` | `bg-control-rest` | 次级按钮静止 |
| `control/bg-hover` | `--gosslan-hover` | `bg-control-hover` | 次级按钮悬停 |
| `control/bg-active` | `--gosslan-pressed` | `bg-control-active` | 次级按钮按下 |
| `control/bg-primary` | `--gosslan-primary-active` | `bg-control-primary` | 主按钮填充 |
| `control/bg-primary-hover` | `--gosslan-primary-hover` | `bg-control-primary-hover` | 主按钮悬停 |
| `control/bg-danger` | `--gosslan-danger` | `bg-control-danger` | 危险按钮填充 |
| `control/fg` | `--gosslan-text` | `text-control-fg` | 控件文字 |
| `control/fg-muted` | `--gosslan-text-2` | `text-control-fg-muted` | 次级文字/placeholder |
| `control/border-rest` | `--gosslan-border` | `border-control-rest` | 输入框静止描边 |
| `control/focus` | `--gosslan-focus-ring` | `ring-control-focus` | 焦点环 |
| `control/danger` | `--gosslan-danger-ink` | `text-control-danger` | 错误文字与描边 |

```js
// tailwind.config.js 的 theme.extend 建议
colors: {
  surface: {
    glass: {
      1: 'var(--gosslan-glass-1-bg)',
      2: 'var(--gosslan-glass-2-bg)',
      3: 'var(--gosslan-glass-3-bg)',
    },
    solid: 'var(--gosslan-panel)',
    field: 'var(--gosslan-field)',
  },
  control: {
    rest: 'transparent',
    hover: 'var(--gosslan-hover)',
    active: 'var(--gosslan-pressed)',
    primary: 'var(--gosslan-primary-active)',
    danger: 'var(--gosslan-danger)',
  },
}
```

不新增第三方 UI 依赖；只用现有 Tailwind + CSS 变量。

## 2. 尺寸梯度

四档，按钮与图标按钮共用高度；高度取整数，避免 `py` + 行高算出 25/29px 这类碎值。

| 尺寸 | 高度 | 横向 padding | 纵向 padding | 字号 / 行高 | 圆角 | 图标 | 图标-文字间距 | 当前对应 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `xs` | 24px | 8px | 4px | 11px / 1.2 | 6px | 14px | 4px | 现有 `xs`（约 20px） |
| `sm` | 28px | 10px | 6px | 12px / 1.2 | 6px | 16px | 6px | 现有 `dense`（约 29px） |
| `md` | 32px | 12px | 8px | 13px / 1.2 | 8px | 16px | 6px | 现有 `default`（约 25px） |
| `lg` | 40px | 16px | 10px | 14px / 1.2 | 8px | 18px | 8px | 现有 `large`（约 30px） |

- 图标按钮是正方形：24 / 28 / 32 / 40，图标 14 / 16 / 16 / 18。
- 触屏最小点击区仍然用 `.tap-safe` 扩到 44px，不靠视觉尺寸硬撑。
- 同一行里只允许相邻两档混用（如 `md` + `lg`），不允许 `xs` 与 `lg` 并排。
- 表单底部主次按钮：主 `lg`，次 `lg`；设置页行内操作 `sm`；工具条图标 `sm` 或 `md`。

## 3. 按钮变体

只保留 3 个语义变体 + 2 个布局变体：

| 变体 | 用途 | 静止 | 悬停 | 按下 | 文字 |
| --- | --- | --- | --- | --- | --- |
| `primary` | 每屏最多 1 个主操作 | `bg-control-primary` | `bg-control-primary-hover` | 同静止 + `brightness(.96)` | 白字 |
| `secondary` | 其余操作 | 透明 + 1px `control/border-rest` | `bg-control-hover` | `bg-control-active` | `control/fg` |
| `danger` | 删除/退出/不可逆 | `bg-control-danger` | `--gosslan-danger-hover` | 同静止 + `brightness(.96)` | 白字 |
| `ghost` | 工具条、图标、行内 | 透明无边框 | `bg-control-hover` | `bg-control-active` | `control/fg-muted` |
| `icon` | 只有图标的按钮 | 透明或 `ghost` | 同 `ghost` | 同 `ghost` | 图标 16/18px |

禁止：

- 一个区块出现两个 `primary`。
- 用 `danger` 表达“取消”；取消永远是 `secondary`。
- 用纯颜色表达危险；危险按钮必须带文字或图标。
- 手写 `bg-[var(--gosslan-primary)]` 当按钮底色；主按钮填充一律 `primary-active`（对比度 4.5:1 已由 token 保证）。

### 3.1 状态

| 状态 | 触发 | 视觉 | 数值 / 备注 |
| --- | --- | --- | --- |
| rest | 默认 | 见上表 | — |
| hover | 指针悬停 | 背景换 hover token | 过渡 120ms；不做位移 |
| active | 按下 | 背景换 active token + `brightness(.96)` | 不做 `scale`，避免行内按钮抖动 |
| focus-visible | 键盘聚焦 | 2px `control/focus` 外环，offset 1px | 已有全局规则 [style.css L663-L666](../../src/style.css#L663-L666)；环与背景 ≥ 3:1 |
| disabled | 不可用 | `opacity: .50`，`cursor: not-allowed` | 仍需保留文字可读；不要只降透明度到看不见 |
| loading | 异步提交 | 保持原宽高，16px spinner + 原文字；`aria-busy="true"` | 禁止宽度塌陷导致布局跳动；`pointer-events: none` |
| error | 仅表单提交失败 | 按钮本身不变；错误落在字段与 helper | — |

### 3.2 焦点环

```css
:where(button, a, [tabindex]):focus-visible {
  outline: 2px solid var(--gosslan-focus-ring);
  outline-offset: 1px;
}
```

- 环颜色当前是 `primary` 55% 透明；在浅色玻璃上可能低于 3:1。建议玻璃上的焦点环改用不透明 `--gosslan-accent-ink`，或加深到 70%。`needs-user-signoff`
- 文本输入不走这条外环，见第 4 节。

## 4. 输入控件

### 4.1 尺寸

| 尺寸 | 高度 | 横向 padding | 字号 | 圆角 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `sm` | 32px | 10px | 12px | 6px | 过滤条、行内搜索 |
| `md` | 36px | 12px | 13px | 8px | 默认；设置项、登录表单 |
| `lg` | 44px | 14px | 14px | 8px | 移动端主表单、独立页面 |

多行输入：

- 最小高度 72px，最大高度 200px；超过后内部滚动。
- 左右 padding 12px，上下 10px，`line-height: 1.5`。
- `resize: none`，由 JS 自增高；最多 6 行。
- 输入区本体必须实色 `surface/field`；外框容器可以是 `glass-1`。

### 4.2 颜色与描边

| 部分 | 亮态 | 暗态 |
| --- | --- | --- |
| 背景 | `--gosslan-field` `#f3f5f8` | `#2a3a52` |
| 文字 | `--gosslan-text` `#0f172a` | `#f1f5f9` |
| placeholder | `--gosslan-text-2` `#475569` | `#94a3b8` |
| 静止描边 | `--gosslan-border` `#e2e8f0` | `#3a4a66` |
| 悬停描边 | 在静止描边上叠 6% 黑/白 | 同 |
| 焦点 | 1px `--gosslan-primary` | 同 |
| 错误 | 1px `--gosslan-danger-ink` `#cc2418` | `#ff5548` |
| 禁用 | `opacity: .62` | 同 |

- 只使用一个底色家族：`surface/field`。禁止再混用 `--gosslan-bg`、`--gosslan-panel`、`--gosslan-list`。
- 输入框本体圆角统一 `radius-md`（8px）；`sm` 可用 `radius-sm`（6px）。
- 前置图标：`padding-left = 12 + 16 + 8 = 36px`；后置图标同理。
- 清除按钮只在有内容时出现，占 28px，不改变输入框高度。

### 4.3 焦点

用户 2026-09-16 明确不要“点击输入框出现主题色方框”。因此目标方案是**不加外框**：

```css
.field:focus {
  border-color: var(--gosslan-primary);
  box-shadow: inset 0 0 0 1px var(--gosslan-primary);
}
```

- 只改 1px 内描边与边框颜色，不产生外部方框、不改变尺寸。
- `textarea` 同理；消息输入框聚焦时只让卡片边框变主题色，不给编辑区画框。
- 该方案仍会改变观感，`needs-user-signoff`；如果用户仍拒绝任何焦点色，则保留当前“无焦点指示”，但必须在 [design-guidelines.md](../design-guidelines.md) 记录这是有意的可访问性例外。

### 4.4 错误态

| 项 | 规格 |
| --- | --- |
| 边框 | 1px `control/danger` |
| helper 文字 | 12px / 1.4，`control/danger`，与字段间距 4px |
| 图标 | 14px 警示图标，与文字间距 4px |
| 语义 | `aria-invalid="true"`，`aria-describedby` 指向 helper |
| 表达 | 不能只靠红色；必须有文字说明或图标 |
| 布局 | helper 出现不推动下方内容超过 4px；预留一行高度或使用绝对定位 |

### 4.5 只读与禁用

- 只读：背景保持 `surface/field`，描边降为 `control/border-rest`，文字正常；可聚焦、可复制。
- 禁用：`opacity: .62`，`cursor: not-allowed`，不响应 hover；标签文字不能被淡化到 4.5:1 以下。

## 5. 对比度下限

| 组合 | 下限 | 依据 |
| --- | --- | --- |
| 控件文字 / 字段背景 | 4.5:1 | WCAG 1.4.3 |
| 13px 次级文字 / 玻璃 | 4.5:1（按合成色测） | WCAG 1.4.3 |
| 大字（≥ 24px 或 ≥ 18.66px bold） | 3:1 | WCAG 1.4.3 |
| 输入框描边、图标、焦点环 | 3:1 | WCAG 1.4.11 |
| placeholder | 4.5:1 | 属于文本 |
| disabled | 豁免，但标签文字不低于 3:1 | WCAG 例外条款 |

## 6. 变体收敛：现状 → 目标

| 控件 | 现状 | 目标 |
| --- | --- | --- |
| 按钮 | 3 个共享语义 × 4 尺寸，但手搓部分带来 20 种 `px/py` 组合、4 个圆角档位，实际视觉组合约 **30** | **3 语义 × 4 尺寸 = 12**，外加 `icon` 4 尺寸、`segmented` 1 种（不计入按钮变体） |
| 输入框 | 4 个底色家族（`bg` / `transparent` / `field` / 输入区 `panel`）、3 种内距、2 种字号、2 种边框，观察到的视觉组合约 **8** | **1 个底色 × 3 尺寸 × 2 个边框状态（rest/error）= 6** |

尺寸梯度上线后，旧尺寸按下表映射：

| 旧 | 新 |
| --- | --- |
| `xs` | `xs` |
| `dense` | `sm` |
| `default` | `md` |
| `large` | `lg`（高度 30 → 40） |

## 7. `needs-user-signoff`

1. 按钮高度从 20/25/29/30px 调整到 24/28/32/40px。
2. 输入框底色统一到 `--gosslan-field`（暗态会明显变亮）。
3. 文本输入恢复 1px 内描边焦点提示。
4. 玻璃上的焦点环改用不透明 `--gosslan-accent-ink`（提高 3:1 余量）。
5. 手搓按钮迁回共享组件后，局部内距与布局会发生位移。
6. `SecondaryBtn` 的 `large` 补 `font-medium`（观感变化很小，但属于像素级改动）。
