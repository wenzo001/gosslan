/**
 * 任务中心那颗药丸的「拖到四角」纯逻辑。
 *
 * 负责人 2026-10-23 的原话："右下角的那个胶囊的气泡可以移动位置，它一直挡在右下角，
 * 有可能挡到发送界面了……一拨它就可以往 4 个角移动。"
 *
 * 为什么单独一家：几何判定写在组件里就只能靠真机点才知道对错，而这几条全是**能用数说清**的
 * （哪一角、有没有越界、按下与拖动怎么分）。所以这里只做不碰 DOM 的那部分，
 * 指针事件与 CSS 变量留在组件里。
 *
 * 三条例外要说明：
 * 1. **只吸附四角，不记自由坐标**。用户要的是"别挡住输入区"，四个可预期位置够用了；
 *    存自由坐标就要处理窗口缩放、多显示器、越界恢复一整族问题，而收益只是"能停在中间"。
 * 2. **按下 ≠ 拖动**：靠阈值区分（`movedFar`）。没有这道闸，点一下药丸会先被判成拖动，
 *    面板就打不开 —— 那是比"挡路"更糟的回归。
 * 3. **视口读数非法就当没有拖动**（回默认角）：`visualViewport` 在部分 WebView 上会给 0，
 *    拿 0 去算象限会把每一发都算成左上角。
 */

export type PillCorner = "tl" | "tr" | "bl" | "br";

/** 药丸位置的持久化键（跨会话记住：挡住输入区这件事每次都发生在同一个位置）。 */
export const PILL_CORNER_KEY = "taskCenter.corner";

/** 默认右下角 —— 与这一版之前写死的位置一致，老用户升级后看到的还是原来那颗。 */
export const DEFAULT_PILL_CORNER: PillCorner = "br";

/** 超过这个位移才算拖动（像素）。太小会在触屏上把"点一下"误判成拖，太大则手感发黏。 */
export const DRAG_THRESHOLD_PX = 6;

const CORNERS: readonly PillCorner[] = ["tl", "tr", "bl", "br"];

/** 只认那四个值：存储里出现别的字符串（手工改过 / 旧版本遗留）一律回默认角。 */
export function parsePillCorner(raw: string | null | undefined): PillCorner {
  return CORNERS.includes(raw as PillCorner) ? (raw as PillCorner) : DEFAULT_PILL_CORNER;
}

/**
 * 落在哪一角：以视口中线切四象限，取指针所在那一格。
 *
 * 用指针而不是药丸中心：手指拖到哪儿、角就落在哪儿，是"一拨就到那个角"的直接因果；
 * 按中心算会在快贴边时先跳到对角再回来，手感像粘不住。
 */
export function nearestPillCorner(x: number, y: number, vw: number, vh: number): PillCorner {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(vw) || !Number.isFinite(vh)) {
    return DEFAULT_PILL_CORNER;
  }
  if (vw <= 0 || vh <= 0) return DEFAULT_PILL_CORNER;
  return `${y < vh / 2 ? "t" : "b"}${x < vw / 2 ? "l" : "r"}` as PillCorner;
}

/** 位移是否越过拖动阈值（横竖任一超算）。 */
export function movedFar(dx: number, dy: number, threshold: number = DRAG_THRESHOLD_PX): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.abs(dx) > threshold || Math.abs(dy) > threshold;
}

/**
 * 拖动过程中把药丸夹回视口内（含 8px 边距）：吸附只发生在松手那一刻，
 * 中途让一颗半截出屏的药丸跟着手指走，看起来像界面坏了。
 */
export function clampDragBox(
  left: number,
  top: number,
  width: number,
  height: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  const margin = 8;
  const maxLeft = Math.max(margin, vw - width - margin);
  const maxTop = Math.max(margin, vh - height - margin);
  return {
    left: Math.min(maxLeft, Math.max(margin, left)),
    top: Math.min(maxTop, Math.max(margin, top)),
  };
}
