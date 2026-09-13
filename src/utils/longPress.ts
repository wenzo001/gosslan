//! 移动端长按手势的**纯判据**（`node --test` 下可直接单测）。
//!
//! 为什么抽出来：长按这套东西全是"代码看着对、真机上不灵"的坑，而且每一处都踩过：
//!
//! | 真机现象（用户实测） | 根因 |
//! |---|---|
//! | 「长按触发的效果不太灵」 | `@touchmove` 直接接 `cancelLongPress`，手指动 1px 就取消 |
//! | 「按在文字上长按没反应，按到气泡边上才弹」 | 命中 `.gosslan-selectable` 就不起定时器，而正文**整块**都是它 |
//! | 「一放手立马就缩回去了」 | 弹面板那一下抬手指会被 HeadlessUI 的 outside-click 当成"点了外面" |
//!
//! 前两条是**判据**问题（这里），第三条是**事件时序**问题（见 `MessageItem` 里
//! `swallowLongPressRelease` 的说明，这里只用 `shouldSwallowLongPressRelease` 表达规则）。

/**
 * 一次 `touchstart` 的语境（全部由调用方从 DOM / store 取，判据本身不碰 DOM）。
 */
export interface LongPressContext {
  /** 触屏语境（`app.isMobile`）。桌面端没有长按菜单 —— 右键菜单才是主路径。 */
  isMobile: boolean;
  /** 系统消息（居中灰字）：没有任何可操作内容，不该弹菜单。 */
  isSystem: boolean;
  /** 已进入「选择文字」模式：这时长按要交给系统的选区手柄，不能再抢。 */
  selectMode: boolean;
  /** 手指落点命中了 `.gosslan-selectable`（"可选文本"标记）。 */
  hitSelectable: boolean;
  /**
   * 上面那个可选区域**在正文气泡里**（`.gosslan-bubble-text`）。
   *
   * 触屏下它已经被 `@media (pointer: coarse)` 关掉选中（`user-select: none`），
   * 「部分选字」改成菜单里的二级入口（「选择文字」）⇒ 它**不该**再让长按让路。
   * 代码块等其它可选区域仍然真的能选字，那里继续让路。
   */
  insideTextBubble: boolean;
}

/**
 * 这次 `touchstart` 要不要启动长按定时器。
 *
 * ⚠️ 真机坑（用户 2026-09-13 Android）：「长按气泡**有的时候**弹不出来，有的时候又能弹出来」。
 * 原因就是最后一条 —— 正文气泡里那个 `.gosslan-selectable` 类**还在 DOM 上**（桌面端靠它选字），
 * 于是按在文字上（气泡的绝大部分面积）直接 `return`，只有按到 `px-3 py-1.5` 那圈内边距才弹。
 */
export function shouldStartLongPress(c: LongPressContext): boolean {
  if (!c.isMobile) return false; // 桌面端走右键菜单
  if (c.isSystem) return false; // 系统消息没有菜单
  if (c.selectMode) return false; // 「选择文字」模式：长按归系统选区手柄
  // 只给"**当前真的还能选字**的可选区域"让路（例如代码块）：正文气泡在触屏下已不可选
  if (c.hitSelectable && !c.insideTextBubble) return false;
  return true;
}

/**
 * 抬手指那一下要不要**吞掉**（`preventDefault`）。
 *
 * 为什么（用户 2026-09-13 Android）：「弹出 sheet 之后**一放手立马就缩回去了**」。
 * 面板用的是 HeadlessUI `Dialog`，它的 `useOutsideClick` 在 **document 捕获阶段** 挂了
 * `touchend`，判据是"`touchend` 的 target 在不在对话框容器里"；而 touch 事件的 target
 * 在 **`touchstart` 那一刻就固定**成那条消息了 ⇒ 抬手必被判成"点了外面" ⇒ `@close`。
 * （它的 `click` 分支在移动端被 `isMobile()` 短路掉了，所以只有 `touchend` 这条路径。）
 *
 * 处理办法：面板展开期间，在 **window 捕获阶段**拦下这次 `touchend` 并 `preventDefault()`
 * —— HeadlessUI 的判据里有 `if (e.defaultPrevented) return`，于是它不再关面板；
 * 顺带也杀掉了这次 tap 的合成 `click`（不会误触气泡里的链接）。
 *
 * ⚠️ 必须挂 `window`：`document` 上的捕获监听是和它同阶段、同目标注册的，先注册的先跑，
 * 我们后注册的一定排在 HeadlessUI 后面；而捕获路径是 `window → document → … → target`。
 */
export function shouldSwallowLongPressRelease(c: {
  /** 长按那根手指还按着（面板就是这次按压弹出来的）。 */
  openedByHeldPress: boolean;
  /** 面板此刻还开着（关了就没必要吞）。 */
  sheetOpen: boolean;
}): boolean {
  return c.openedByHeldPress && c.sheetOpen;
}
