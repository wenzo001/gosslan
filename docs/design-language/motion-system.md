# 全站交互动效规范（motion-system）

> 状态：2026-11-07 起生效。判据在 `src/utils/motionSystem.test.ts`，令牌在 `src/style.css`
> 的「动效阶梯」一节。用户口径：「参考 Apple 的最佳实践与物理直觉 —— 从哪儿来、回哪儿去，
> 遵循物理规律，所有感觉要统一」。
>
> 这份文档是**可执行**的：每一条规则都能对应到一条判据或一个令牌；写新动效时先读 §2/§3，
> 再把 §7 的 checklist 走一遍。

## 1. 三条原则

1. **从哪儿来，回哪儿去**：任何位移类入场都要能回答"它从哪个方向来"；出场沿同一条路径回去，
   不许换方向、不许凭空消失。
2. **物理直觉**：起步快、收尾稳（强 ease-out）；短促变化才允许轻微回弹；大幅位移不用弹簧。
3. **一套语言**：全站只有一组时长档与两条曲线。组件不得自带毫秒数，也不得自造第三条曲线。

## 2. 时长阶梯（唯一来源：CSS 变量）

| 令牌 | 桌面 | 移动（`html.is-mobile`） | 用在哪 |
| --- | --- | --- | --- |
| `--gosslan-duration-instant` | 100ms | 100ms | 按压反馈、颜色过渡的起点 |
| `--gosslan-duration-fast` | 150ms | 150ms | hover / 变色 / 菜单淡入淡出 |
| `--gosslan-duration-fade` | 200ms | 200ms | 只动 opacity 的入场（浮层、回执、遮罩） |
| `--gosslan-duration` | 240ms | **280ms** | 位移类入场（卡片、整页） |
| `--gosslan-duration-exit` | 180ms | **200ms** | 位移类出场 |
| `--gosslan-duration-exit-fast` | 120ms | 120ms | 纯淡出的出场（菜单、遮罩） |
| `--gosslan-duration-slow` | 320ms | **360ms** | 大幅位移（底部抽屉），移动端再抬一档 |

规则：

- **入场、出场分档**：出场永远不长于入场（`exit < duration`）。用户已经决定离开，不该让他等。
- **桌面、移动分档**：只换值，不换档名；组件里禁止出现 `isMobile ? 280 : 240` 这类分叉。
- **物理节奏不是"档"**：`ripple 560ms`、`flash 800ms`、`shake 520ms`、`spin 1s`、ambient 的 72s/96s/120s
  是过程本身的节奏，各有专用令牌或判据白名单，不许挪用到通用场景。

## 3. 来源锚点与返回路径

位移类浮层（卡片 / 整页 / 抽屉 / toast）必须同时具备：

1. **锚点**：`transform-origin` 指向它来的那一侧；对应 `@keyframes` 正上方写
   `/* @motion-origin: <值> */`。
2. **方向**：入场位移方向与锚点一致（从下方来就 `translateY(+n)` → 0）。
3. **返回路径**：出场 keyframes 沿同一轴反向走，时长取 `--gosslan-duration-exit`。

| 浮层 | 锚点 | 入场 | 出场 |
| --- | --- | --- | --- |
| 卡片弹窗 `.gosslan-dialog-card` | `50% 100%` | 下方 8px + `scale(.96)` | 回落下方 4px + `scale(.97)` |
| 整页 `.gosslan-dialog-page` | `100% 50%` | 右侧推入 | 右侧推出 |
| 底部抽屉 `.gosslan-dialog-sheet` | `50% 100%` | 屏幕下沿 | 屏幕下沿 |
| Toast `.gosslan-toast` | `50% 0%` | 顶沿下落 | 顶沿收回 |
| 回执 / 徽标 / 涟漪 | `50% 50%` | 原地缩放 | 原地消失/不播 |

**允许的例外**：只做 opacity 的浮层（下拉菜单、popover、提示条）没有方向，**不加**锚点，
也不许为了"统一"给它补一个缩放。

**禁止**：

- 无来源的缩放（没有 `@motion-origin` 的 `scale` 入场）；
- `scale(0)`（起点不可见，等于凭空出现）；
- 出场换方向（从下进来却向上消失）；
- 弹簧曲线用于位移 > 24px 或时长 > 300ms 的转场。

## 4. 曲线

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--gosslan-ease` | `cubic-bezier(.32,.72,0,1)` | 默认：位移、淡入淡出、展开 |
| `--gosslan-ease-spring` | `cubic-bezier(.34,1.56,.64,1)` | 只给 ≤300ms 的短促变化（按压、徽标、卡片出现） |

新增动效不另写曲线；确需第三条曲线时，先改本节并给出反例。

## 5. `prefers-reduced-motion`

- 退化方式：**去位移、去缩放，保留状态可见**。不是把元素藏掉，也不是把状态改成硬切。
- 做法：全局把 `animation-duration` / `transition-duration` 收到 `0.01ms`；有状态浮层显式
  `animation: none`（最终态由元素默认样式给出）。
- 允许 `display:none` 的只有纯装饰（按压涟漪、背景雾）；有语义的状态（选中、打开、错误、
  未读）在任何档位都必须看得见。
- 带状态的切换（回执单勾→双勾）在 reduce 下保留透明度交叉，只去掉缩放。

## 6. 组件接入

- 组件只挂类名（`.gosslan-dialog-card` / `.gosslan-menu` / `.gosslan-toast` …）或读令牌；
  禁止在 `<style>` / 内联样式里写毫秒数。
- Tailwind 的 `transition-*` / `duration-*` 只用于颜色与 opacity；位移与缩放走上面的类。
- `motion-v` 只承担 CSS 做不到的三类（共享元素、FLIP、手势连续动画），入口仍是
  `src/utils/motion/index.ts`。

## 7. 新增动效 checklist

- [ ] 时长取自 §2 的档，没有裸毫秒；
- [ ] 位移类声明了锚点与返回路径（§3 的表里能对上）；
- [ ] 出场 ≤ 入场；
- [ ] 曲线只有 `--gosslan-ease` / `--gosslan-ease-spring`；
- [ ] reduce 档下状态仍可见；
- [ ] `node --test src/utils/motionSystem.test.ts` 全绿。

## 8. 判据与反例

| # | 断言 | 反例（必须红） |
| --- | --- | --- |
| ① | `style.css` 的 `animation` / `transition` 不含裸毫秒 | 塞 `.rogue { animation: rogue-in 300ms … }` |
| ② | 每个 <1 的 `scale` 入场都有 `@motion-origin`；全文无 `scale(0)` | 删掉某条锚点注释；把 `scale(.96)` 改成 `scale(0)` |
| ③ | `prefers-reduced-motion` 块不把有状态浮层设成 `opacity:0` / `visibility:hidden` / `display:none` | 在 reduce 块里给 dialog 写 `opacity: 0` |

执行：`node --test src/utils/motionSystem.test.ts`（已并入 `npm test`）。
