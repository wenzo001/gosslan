/**
 * 卡顿判定的**计时器**：只决定"什么时候计时"，不碰判定逻辑与阈值（`decideStall` 原样）。
 *
 * ## 为什么需要它
 * 判定用的是 `age = now - op.startedAt`，而 `startedAt` 是 `performance.now()` 口径的墙钟。
 * 窗口隐藏 10 分钟后回来，那条**在前台就已经发起**的 IPC 会瞬间被判成"卡了 10 分钟"
 * ⇒ 一次假停摆横幅。用户拍板的口径（2026-11-05）：隐藏期间**暂停** stall 定时器，
 * 恢复时把隐藏时长整段从判定时钟里扣掉（"重置基线"），并**立即补一次检查**。
 *
 * ## 为什么是"活动时钟"而不是"恢复时清空"
 * 清空（把恢复时刻当成新零点）会把隐藏前已经累积的年龄一起抹掉：一条真卡了 9 秒的操作
 * 在恢复后要再等 10 秒才提示，等于**放宽了判定**。活动时钟只冻结隐藏那一段，
 * 隐藏前的年龄照旧保留 ⇒ 判定逻辑与阈值一个字没改。
 *
 * ## 为什么还要 `activeSince()`
 * 光有"活动时钟"不够：`InflightOp.startedAt` 是**原始墙钟**。若直接拿
 * `now() - startedAt` 去比，隐藏次数越多差值越负（隐藏前的那点可见时间被反复扣掉），
 * 真卡住也永远判不出来。所以调用方必须先把 `startedAt` 过一遍 `activeSince()`，
 * 两端都落在同一个活动时钟上，差值才等于"真正可见的时长"。
 *
 * ## 为什么 interval 在隐藏时 clear、恢复时重建
 * "暂停"就是真的停：窗口隐藏后连 1s 的空回调都不该再跑（待机预算的那条口径）。
 * 防叠加靠 `start()` / `stop()` 的幂等：任一次可见性变化最多只留下一个 interval，
 * 连续隐藏/恢复十次也一样（`stallWatch.test.ts` 有单测兜住）。
 */
export interface StallWatch {
  /** 起 interval；重复调用不会叠加第二个（幂等）；隐藏期间调用是 no-op。 */
  start(): void;
  /** 停 interval；可重复调用。 */
  stop(): void;
  /** 可见性变化：`true` 暂停计时（隐藏），`false` 恢复计时并立即补一次判定。 */
  setHidden(hidden: boolean): void;
  /** 当前活动时刻：隐藏期间不前进。 */
  now(): number;
  /**
   * 把原始墙钟时刻（`performance.now()` 口径，如 `InflightOp.startedAt`）换算到活动时钟。
   *
   * 只记录**最近一段隐藏**的边界：早于它的时刻用"隐藏前累计"近似。
   * 对"在当前可见周期内新起的操作"是精确的；对跨多段隐藏的极老操作会略微低估年龄，
   * 方向是**更不容易误报**，不会把没卡的操作判成卡住。
   */
  activeSince(rawAt: number): number;
}

export interface StallWatchOpts {
  /** 每次"到点"要做的判定（通常读在途操作 + `decideStall`）。 */
  tick: () => void;
  /** 原始墙钟，默认 `performance.now()`。 */
  clock?: () => number;
  intervalMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => number;
  clearIntervalFn?: (id: number) => void;
}

export function createStallWatch(opts: StallWatchOpts): StallWatch {
  const clock = opts.clock ?? (() => performance.now());
  const intervalMs = opts.intervalMs ?? 1000;
  // 默认走 `globalThis` 而不是 `window`：单测跑在 node 里，没有 `window`。
  const setInt = opts.setIntervalFn
    ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms) as unknown as number);
  const clearInt = opts.clearIntervalFn
    ?? ((id: number) => globalThis.clearInterval(id as unknown as ReturnType<typeof setInterval>));

  /** 已经走完的隐藏段累计（ms）。 */
  let frozenMs = 0;
  /** 当前隐藏段的起点；`null` = 可见。 */
  let hiddenAt: number | null = null;
  /** 最近一段隐藏的起点与"它开始之前的累计隐藏量"（用于 `activeSince` 近似）。 */
  let lastHiddenStart = Number.NEGATIVE_INFINITY;
  let lastHiddenBaseOffset = 0;
  let timer: number | undefined;

  function start(): void {
    if (timer !== undefined) return;
    // 隐藏期间不起表：等恢复可见时再起，别让隐藏的窗口空转。
    if (hiddenAt !== null) return;
    timer = setInt(() => {
      // 兜底：即使某个延迟回调恰好落在隐藏期间，也一拍都不判。
      if (hiddenAt !== null) return;
      opts.tick();
    }, intervalMs);
  }

  function stop(): void {
    if (timer === undefined) return;
    clearInt(timer);
    timer = undefined;
  }

  function setHidden(hidden: boolean): void {
    if (hidden) {
      if (hiddenAt !== null) return;
      lastHiddenStart = clock();
      lastHiddenBaseOffset = frozenMs;
      hiddenAt = lastHiddenStart;
      stop();
      return;
    }
    if (hiddenAt === null) return;
    frozenMs += clock() - hiddenAt;
    hiddenAt = null;
    start();
    // 恢复时立即补一次：否则要等下一个 1s 拍才恢复判定。
    opts.tick();
  }

  return {
    start,
    stop,
    setHidden,
    now: () => hiddenAt === null
      // 可见：把历史隐藏段整段扣掉。
      ? clock() - frozenMs
      // 隐藏：时钟停在隐藏那一刻（隐藏期间的"时间"不进入判定）。
      : hiddenAt - frozenMs,
    activeSince(rawAt: number): number {
      // 最近一段隐藏之后（含其内部）的时刻：扣掉全部已完成的隐藏；
      // 更早的时刻：只扣到那一段隐藏开始为止的累计。
      const offset = rawAt >= lastHiddenStart ? frozenMs : lastHiddenBaseOffset;
      return rawAt - offset;
    },
  };
}
