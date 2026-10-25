/**
 * 虚拟列表的高度变化补偿（纯函数，可在 Node 里逐格断言）。
 *
 * 场景：回应条/图片让某一行变高时，**当前帧**的 spacer 还没更新，浏览器原生锚定与
 * 下一帧贴底会各自动作一次 ⇒ 用户看到滚动区上下闪一下。
 * 修法是在 ResizeObserver 回调里先累计同一帧所有行的 delta，再同步写一次 scrollTop。
 *
 * 两条规则：
 * - 贴底且没有刚上滚：补偿**全部** delta，保持贴底；
 * - 非贴底：只补偿**完全在视口上方**的行（它们变高会把下方内容整体往下推），
 *   视口内/下方的行不补偿 —— 用户正在读的内容优先。
 * - 收敛窗口/静默期（hold）不补偿，交给现有的批量贴底。
 */
export interface HeightDelta {
  /** 变高之前这一行的 top（offsets 累加值）。 */
  top: number;
  /** 变高之前的实测/估算高度。 */
  oldHeight: number;
  /** 本次高度变化量（可正可负）。 */
  delta: number;
}

export interface CompensationOptions {
  pinned: boolean;
  recentScrollUp: boolean;
  hold: boolean;
  scrollTop: number;
}

export function compensationFor(
  deltas: readonly HeightDelta[],
  opts: CompensationOptions,
): number {
  if (opts.hold || deltas.length === 0) return 0;
  if (opts.pinned && !opts.recentScrollUp) {
    return deltas.reduce((sum, d) => sum + d.delta, 0);
  }
  // 非贴底：只补“完全在视口上方”的行。0.5px 容差避免亚像素边界抖动。
  return deltas.reduce(
    (sum, d) => (d.top + d.oldHeight <= opts.scrollTop + 0.5 ? sum + d.delta : sum),
    0,
  );
}
