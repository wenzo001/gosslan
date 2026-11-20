/**
 * 光标可见性判定的纯函数（`MessageComposer` 的 Shift+Enter 换行用它）。
 *
 * 为什么单独抽出来：`contenteditable` 里插完换行后，浏览器**不保证**把新光标滚进
 * 可视区（用户 2026-11-20 实测：光标下去了、显示区没动，最后一行看不见）。
 * 这段"该滚多少"是纯算术，抽出来才能用单测钉住四种边界，
 * 而不是靠在真机上反复点回车碰运气。
 *
 * 坐标一律用 `getBoundingClientRect()` 的视口坐标：caret 矩形与输入框矩形同源，
 * 相减就是**内容坐标下的滚动增量**（`scrollTop` 加它即可）。
 */
export interface CaretBox {
  top: number;
  bottom: number;
}

/**
 * 让 caret 落进可视区需要的滚动增量（px）。
 *
 * - 下沿越界（最常见：回车后光标到了新行）⇒ 返回正值，往下滚。
 * - 上沿越界（在长文本顶部按 Shift+Enter、或删行后光标上移）⇒ 返回负值，往上滚。
 * - `pad` 是视觉余量：贴着边算"可见"的话，光标帧与边框会重叠，看起来仍是没滚到位。
 * - 已在可视区内 ⇒ 0，**不做任何滚动**（否则每敲一个字符整块内容都在抖）。
 */
export function caretScrollDelta(caret: CaretBox, box: CaretBox, pad = 8): number {
  if (caret.bottom > box.bottom - pad) return caret.bottom - box.bottom + pad;
  if (caret.top < box.top + pad) return -(box.top - caret.top + pad);
  return 0;
}
