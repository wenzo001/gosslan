/**
 * 列表行「长按 = 右键菜单」手势的**唯一实现**（移动端）。
 *
 * 为什么会有这个文件：`ConversationListItem` 与 `FriendListItem` 各自抄过一份完全相同的
 * 计时器 / 位移容差 / click 抑制，两份都在注释里写着"与另一个文件一致"—— 靠注释维持一致
 * 就是下一次漂移的入口。现在阈值与判据在 `utils/pressGesture.ts`（可单测），
 * 事件与计时在这里，组件只绑定三个处理器 + 一个"这次 click 要不要吃掉"。
 *
 * 为什么不用库：`@vueuse/core@14.4.0` 里**没有** `useLongPress`（现读 `node_modules` 确认，
 * 不是印象）；手势包（`@vueuse/gesture`）要新增依赖，且它默认用 pointerdown +
 * `preventDefault`，列表行会因此失去"按住也能滚动"。这里必须保持 `.passive` 的 touch 监听。
 *
 * 两条语义都踩过坑，别改：
 * 1. 位移 > 10px **立刻**取消（横向滑 / 纵向滚都不误弹菜单）；
 * 2. 触发过长按后，**同一次手势**的合成 click 要被吃掉 —— 否则菜单刚弹出就被行点击盖住；
 *    下一次 `touchstart` 会复位，所以不会吃掉用户的下一次点击。
 */
import { onUnmounted } from "vue";
import { haptic } from "@/utils/haptics";
import {
  LONG_PRESS_MS,
  PRESS_MOVE_TOLERANCE,
  movedBeyondTolerance,
  type PressPoint,
} from "@/utils/pressGesture";

export interface PressMenu<T> {
  /** `@touchstart.passive`：绑定行数据与落点，起计时器。 */
  onStart: (payload: T, e: TouchEvent) => void;
  /** `@touchmove.passive`：超出容差即取消。 */
  onMove: (e: TouchEvent) => void;
  /** `@touchend.passive` / `@touchcancel.passive`：清计时器。 */
  clear: () => void;
  /** 行点击入口先问它：长按刚弹过菜单 ⇒ true（这次 click 丢掉并复位）。 */
  consumeSuppressedClick: () => boolean;
}

/**
 * @param open 长按到点时调用；坐标是**按下那一刻**的落点（与右键菜单同一入参）。
 * @param tolerance 位移容差，默认 `PRESS_MOVE_TOLERANCE`（只为测试可注入）。
 */
export function usePressMenu<T>(
  open: (payload: T, x: number, y: number) => void,
  tolerance: number = PRESS_MOVE_TOLERANCE,
): PressMenu<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: PressPoint | null = null;
  let fired = false;

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    start = null;
  }

  function onMove(e: TouchEvent) {
    const t = e.touches[0];
    if (!t || !start) return;
    if (movedBeyondTolerance(start, { x: t.clientX, y: t.clientY }, tolerance)) clear();
  }

  function onStart(payload: T, e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    clear();
    fired = false; // 新手势开始：复位上一次的抑制标记
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      haptic("heavy");
      open(payload, t.clientX, t.clientY);
    }, LONG_PRESS_MS);
  }

  function consumeSuppressedClick(): boolean {
    if (!fired) return false;
    fired = false;
    return true;
  }

  onUnmounted(clear);

  return { onStart, onMove, clear, consumeSuppressedClick };
}
