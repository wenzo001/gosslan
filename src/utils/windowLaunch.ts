/**
 * 「打开独立窗口」的**单飞 + 防抖**判据（纯函数，便于单测）。
 *
 * 为什么需要（用户 2026-09-12 实测）：
 *   - 「连续点几下设置」不应该开出第二个窗口，也不应该把一串 IPC 打进去 ——
 *     每次 `invoke` 都要跨进程进主线程消息循环，而窗口创建本身是重活；
 *   - 按钮要有防抖：即便窗口这次没打开（例如创建失败），连点也不该变成"雪崩"。
 *
 * 判据只有两条：
 *   ① 该窗口**正在打开**（上一次的 invoke 还没回来）⇒ 合并到那一次，直接不发起；
 *   ② 距上次发起不足 `minIntervalMs` ⇒ 视为连点，忽略。
 *
 * 窗口实例的唯一性由后端保证（`ensure_aux_window` 的单例 + 串行创建），
 * 这里只负责"别把请求打爆"和按钮的 pending 反馈。
 */
import { shouldRunThrottled } from "./defer.ts";

/** 同一个窗口两次发起之间的最小间隔：够短（不影响"关掉再开"），又足以吃掉连点。 */
export const WINDOW_LAUNCH_MIN_INTERVAL_MS = 300;

export function shouldLaunchWindow(
  now: number,
  isOpening: boolean,
  lastLaunchAt: number,
  minIntervalMs: number = WINDOW_LAUNCH_MIN_INTERVAL_MS,
): boolean {
  if (isOpening) return false;
  return shouldRunThrottled(now, lastLaunchAt, minIntervalMs);
}

/**
 * 开窗 IPC 的超时上限（用户 2026-11-19「点了没反应」）。
 *
 * 为什么需要：单飞靠 `opening` 这个 Set 防重复，清理在 `finally` 里。若 `open()` 返回的 Promise
 * 永不 settle（IPC 通道丢失 / 页面导航导致 pending 永不回调），`finally` 永不执行 ⇒ `opening`
 * 永久为 true ⇒ 该窗口之后每次点击都被 `shouldLaunchWindow` 的 isOpening 判据吞掉，表现就是
 * "按钮一直转、窗口永远不出来，而且再点也没用"。加一道超时让 Promise 必定 settle。
 *
 * 10s 的取值：WebView2 冷建在慢机上可能几秒，太短会误伤正常开窗；10s 已经远超正常耗时，
 * 又不至于让用户等太久。超时只是**释放单飞、让下一次点击能重试**，不代表窗口一定没开——
 * 后端 `ensure_aux_window` 幂等，晚到的成功建窗不会重复。
 */
export const WINDOW_LAUNCH_TIMEOUT_MS = 10_000;

/** 开窗超时抛出的错误码（前端回退/埋点可认）。 */
export const WINDOW_LAUNCH_TIMEOUT_CODE = "WINDOW_LAUNCH_TIMEOUT";

/** 带超时的 Promise 竞速：超时或原 Promise 先完成都清理定时器，绝不泄漏 timer。 */
export function raceWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  timer: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void },
  code: string = WINDOW_LAUNCH_TIMEOUT_CODE,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const id = timer.set(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`code=${code} window launch timed out (${timeoutMs}ms)`));
    }, timeoutMs);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        timer.clear(id);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        timer.clear(id);
        reject(e);
      },
    );
  });
}
