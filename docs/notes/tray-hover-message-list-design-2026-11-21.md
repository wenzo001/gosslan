# 托盘悬停消息列表（QQ 式）设计稿

> 用户 2026-11-21：Windows 上来消息时右下角图标要闪（已落地在 7.1.67 的
> `tray::flash_unread`），并且「有多个消息时 hover 上面会有一个消息列表，点对应的
> 消息进对应会话」。**本文只写第二半**（悬停列表），因为它是唯一需要新窗口的方案。

## 一、先说清平台事实（决定方案形状）

1. Windows **没有**「任务栏图标 hover 弹出消息列表」这个系统能力。任务栏 hover 出的
   是系统自己的缩略图预览，应用只能往里塞**缩略图工具栏按钮**（最多 7 个、只能是小图标），
   塞不了列表。QQ 那个列表是它自己贴着一个**无边框置顶窗口**画上去的。
2. 托盘图标（Shell_NotifyIcon）只有 `WM_MOUSEMOVE` 级别的 hover 事件，没有"hover 面板"。
3. 所以本功能的本质是：**自己开一个小窗，跟随鼠标位置弹出，失焦/移开就收起**。
   这条在 Tauri 里可行，但坑集中、且都是 Windows 特有的。

## 二、方案

### 2.1 窗口

- 新建一个 `WebviewWindow`（label `tray-peek`）：
  `decorations: false`、`transparent: true`、`always_on_top: true`、`skip_taskbar: true`、
  `resizable: false`、`focus: false`（**关键**：拿到焦点会让托盘失焦，面板立刻自己关掉）。
- 尺寸：宽 320、高 `min(未读会话数 × 56 + 32, 420)`。
- 位置：托盘图标上方居中。`tray-icon` 的 `TrayIconEvent::Move/Enter` 事件带
  **物理像素**坐标，需要除以当前缩放（`window.scale_factor()`）再换算成逻辑坐标；
  面板底边 = 图标 y − 8，右边不要超出屏幕工作区（多显示器按 `monitor_from_point`）。

### 2.2 触发与收起

- `TrayIconEvent::Enter` → `show_peek()`；`Leave` + 150ms 宽限 → `hide_peek()`
  （宽限是为了让鼠标从图标移进面板时不闪断）。面板自己也要发 `pointerenter/leave`
  给主进程，否则鼠标进面板就算"离开托盘"。
- 失焦（`WindowEvent::Focused(false)`）→ 立刻收起。
- `show_main_window()` 里也收起（用户点了别的入口）。

### 2.3 数据

面板**不查库**：内容来自前端已经在内存里的未读状态。做法：
主窗口（隐藏也活着）通过 `emit` 把「未读会话摘要」推给 Rust 侧缓存
（`tray_peek::set_items(Vec<PeekItem>)`：`conv_id / 标题 / 预览文本 / 未读数 / 头像 aria`），
托盘 Enter 时把这份缓存通过 `window.__TAURI__.event` 送给 peek 窗口渲染。

为什么不反过来"面板起来时问主窗口要"：主窗口可能正忙（长事务/大列表渲染），
一问一答会让面板**空白半秒**再长出来，手感很差。

### 2.4 点击

面板里点一条 → `invoke("tray_peek_pick", { convId })` → Rust：
`show_main_window()` + `emit("tray-peek-open", { convId })`；主窗口收到后
`openConversation(convId)`。**复用主窗口已有的路由**（和托盘"点第一条未读"同一个函数），
不在 peek 窗口里再写一份会话切换逻辑。

## 三、坑（每条都会咬人）

| 坑 | 表现 | 对策 |
|---|---|---|
| 面板抢焦点 | 弹出即消失 | `focus: false` + 不调 `set_focus()` |
| 鼠标进面板算"离开托盘" | 面板刚弹出就收起 | 前端 `pointerenter` 通知 Rust 冻结收起计时器，`pointerleave` 再启动 |
| DPI 缩放 | 面板跑到图标外 200px | 坐标一律物理像素进、除 `scale_factor` 后用逻辑像素定位 |
| 任务栏自动隐藏 | 面板压在任务栏下 | 以 `monitor.work_area()` 为边界夹一下 |
| 多显示器 | 副屏图标弹到主屏 | `monitor_from_point(icon_x, icon_y)`，用它自己的 scale |
| 面板里滚动 | 列表超过 7 条要能滚 | 直接复用 `<OverlayScroll>`（**别**引新滚动实现） |
| 主窗口退出 | peek 窗口残留 | `app.exit` 前 `close_peek()`；或让它 `parent(main)` |

## 四、切片（每片都能单独验收）

1. **S1 骨架**：`tray-peek` 窗口 + Enter/Leave 显示收起 + 一个写死的三条假数据。
   验收：鼠标移上去出现、移开消失、不抢焦点、位置贴着图标。
2. **S2 真数据**：主窗口推未读摘要（前端在 `totalUnread` 变化时推一次，300ms 去抖）。
   验收：来两条消息后 hover，面板里就是那两个会话。
3. **S3 点击进会话**：`tray_peek_pick` → 显示主窗口 → 进会话并滚到最新。
   验收：点第二条，主窗口打开且停在该会话底部。
4. **S4 打磨**：DPI / 多显示器 / 任务栏自动隐藏 / 面板内滚动 / 失焦收起。

## 五、工作量与顺序

S1+S2+S3 约 1 个工作日，S4 再半天。**建议先做 S1+S2**：能看见"有哪几条没读"就已经
覆盖了 80% 的诉求，点击跳转 Sprint 里再加。

## 六、与既有实现的关系

- 已有：托盘左键单击 → `openFirstUnreadConversation()`（跳第一条未读）；托盘 tooltip 带
  未读条数；未读红点；7.1.67 起的闪烁。**本功能不替代它们，是并列的第三个入口。**
- 面板的"未读哪几条"必须与 `totalUnread` 同一份口径（`notifications.ts` 的
  `conversations` 过滤 `unread > 0`），否则 hover 出来的条数会与红点对不上。
