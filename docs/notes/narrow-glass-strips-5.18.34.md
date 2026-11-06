# 窄窗流动背景「白条」缺陷（只存在于 5.18.34）

- 日期：2026-11-06
- 结论：用户报告的「时间分割行/顶栏在窄窗下横贯整宽的不透明白条」**只存在于 5.18.34（`e2be06c5`）**；
  修复提交是 `66d38da9`，已包含在 `main`（`4ee9a1f1`，package 版本 5.18.35）。
  当前最新 tag 仍是 **v5.18.34**，所以线上 5.18.34 用户会看到它，5.18.35 发版即消失。
- 本次**不新增业务代码**：表现层修复与守卫都已存在，只是尚未发版。

## 症状

流动背景（`html[data-ambient="drift"|"static"]`）开启时，消息流里的时间分割行
（`10月27日 16:21` 一类）呈现为一条横贯消息区、甚至横贯整窗的不透明白条。
暗色下同样存在，只是颜色变成 `#0f172a`。`data-frost` 开/关对这条背景没有影响。

## 根因（文件:行 → 成因）

1. `src/style.css` 的 `.ambient-canvas` 在 drift/static 下被改成薄纱：
   `color-mix(in srgb, var(--ambient-canvas-base, var(--gosslan-chat)) 16%, transparent)`；
   只有挂了 `.ambient-canvas-child` 的嵌套容器才会把 `background-color` 清成透明。
2. 5.18.34 的 `src/components/MessageItem.vue` 时间分割线、未读分割线只写了
   `bg-[var(--gosslan-chat)]`，**没有** `tintOn ? '' : 'ambient-canvas-child'`。
   `--gosslan-chat` 亮色是 `#fff`、暗色是 `#0f172a`，于是整行保持实心，
   盖在约 `#f1f3f7`（亮）/ `#101927`（暗）的薄纱画布上。
3. 同一版本 `src/components/chat/ChatHeader.vue` 顶栏同样缺 `.ambient-canvas-child`。
4. 没有 CSS 宽度阈值：5.18.34 在 1280…360 全部档位都漏。窄窗更明显，是因为
   `≤767px` 进入移动布局、聊天列变成全宽，这条白带就从「聊天列内一条」变成「横贯整窗」。

## 证据（两条独立来源）

- 用户截图（771×790）：时间行 `#ffffff`，相邻画布 `#f1f3f7`；撤回提示行是 `#f1f3f7`，
  说明提示行本身没有背景类，不是白条来源。
- 原生 CDP 探针（真实 App → ResponsiveLayout → ChatWindow，13 档 × 亮/暗 × frost 开/关）：
  - `e2be06c5`：分割线 computed `rgb(255, 255, 255)`（暗色 `rgb(15, 23, 42)`），像素 `#ffffff` / `#0f162b`；
  - `4ee9a1f1`：分割线 computed `rgba(0, 0, 0, 0)`，像素与上方画布一致
    （例 390 亮：分割行 `#eef0f4` vs 上方 `#eef0f4`；1280 暗：`#151f2e` vs `#151f2e`）。

## 守卫

`src/utils/designGuards.ts` 的 **AC-08** 要求两种分割线必须带
`ambient-canvas-child`；`src/utils/designGuards.test.ts` 的
`AC-08 反例自证：把时间分割线的条件薄纱摘掉必须红` 会在内存里摘掉该类并断言报红。

## 复现 / 验证命令

```bash
# 反例自证：摘掉 MessageItem.vue 时间分割线的 ambient-canvas-child 后
node --test --experimental-strip-types --disable-warning=ExperimentalWarning src/utils/designGuards.test.ts
# → AC-08 那条变红；git checkout -- src/components/MessageItem.vue 还原后重新跑 → 绿
```

## 移动端

360×640 / 390×844 / 430×932 与桌面窄窗走的是两条布局路径（`max-width:767px` 进移动布局，
聊天全宽、无左侧会话列表）。本次没有改代码，因此移动端不受影响；探针复核读数与
5.18.34 同档位一致（修复只把分割线背景从实心变为透明，两者都沿用同一条薄纱画布）。
