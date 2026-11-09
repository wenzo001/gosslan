/**
 * 软键盘状态判定（纯函数，供 `useAppStore.watchKeyboard` 调用）。
 *
 * 两种平台行为必须分开：
 * - **Android（adjustResize / edge-to-edge）**：`window.innerHeight` 随键盘一起缩，
 *   布局已经在键盘之上 ⇒ 不能再用「被盖住多少」去补底部间距（补一次就多出一段空隙）。
 *   这里只用「布局高度比基线矮了 >120px」判「键盘弹起」，补量为 0。
 * - **iOS**：布局视口不变，只有 `visualViewport` 缩小 ⇒ 补量 = 被盖住的高度。
 *
 * 基线只在「键盘没弹起」时抬高；转屏（宽度变化）直接重置，避免把横屏变矮当成键盘。
 *
 * 已知边界（审查 2026-11-09）：Android 分屏/自由窗把布局高度压掉 >120px 时也会被判成
 * 键盘弹起（会让 TabBar 收起）。本应用 `screenOrientation="portrait"`，分屏下系统按
 * letterbox/禁用处理；而拿「焦点是否在编辑器」当判据并不可靠（系统面板/硬件键盘也能
 * 触发高度变化），所以先按现状记录，不引入 focus 分支。
 */
export interface KeyboardSample {
  innerHeight: number;
  innerWidth: number;
  /** `window.visualViewport?.height ?? window.innerHeight` */
  vvHeight: number;
  /** `window.visualViewport?.offsetTop ?? 0` */
  vvOffsetTop: number;
}

export interface KeyboardState {
  /** 需要给内容区追加的底部内边距（px）；Android 键盘弹起时恒为 0。 */
  inset: number;
  /** 软键盘是否弹起（用于收起底部导航、去掉安全区留白）。 */
  open: boolean;
  /** 下一次调用要带回来的布局高度基线。 */
  base: number;
  baseWidth: number;
}

export interface KeyboardBaseline {
  base: number;
  baseWidth: number;
}

/** 键盘至少吃掉的布局高度；低于它多半是地址栏/工具栏收缩。 */
export const LAYOUT_SHRINK_PX = 120;
/** `visualViewport` 被盖住多少才算键盘（滤掉地址栏抖动）。 */
export const VISUAL_COVERED_PX = 80;

export function resolveKeyboardState(
  sample: KeyboardSample,
  prev: KeyboardBaseline,
  android: boolean,
): KeyboardState {
  let base = prev.base;
  let baseWidth = prev.baseWidth;
  if (!base || sample.innerWidth !== baseWidth) {
    // 首次 / 转屏：把当前高度当基线，不把这一次的变矮判成键盘。
    base = sample.innerHeight;
    baseWidth = sample.innerWidth;
  }
  const covered = Math.max(
    0,
    Math.round(sample.innerHeight - sample.vvHeight - sample.vvOffsetTop),
  );
  const shrunk = sample.innerHeight < base - LAYOUT_SHRINK_PX;
  if (!shrunk && covered < VISUAL_COVERED_PX) base = Math.max(base, sample.innerHeight);

  // Android 由系统 resize 布局：再用 covered 补一次就会把输入框顶高一段。
  // 只有「没 resize 却真被盖住」的 Android 才退回按 covered 补偿。
  const inset =
    android && shrunk ? 0 : covered >= VISUAL_COVERED_PX ? covered : 0;
  return { inset, open: shrunk || covered >= VISUAL_COVERED_PX, base, baseWidth };
}
