/**
 * "promise 与超时计时器赛跑、先胜即清计时器"这一层机制（无业务依赖的叶子）。
 *
 * 为什么单独一个家（2026-11-13 组件复审 P2 跟进，ADR 决策 3 记录的清理缺口）：
 * `useAppStore.waitPreviousExit` 原先用裸 `Promise.race`，`p` 先胜时那个 `setTimeout`
 * 不被清除，会在 `ms` 后空触发一次（resolve 进已 settle 的 race，无副作用但计时器泄漏）。
 * 这里把"计时器 + race + 先胜清理"收口；**超时给什么值、错误怎么处理仍是调用方的业务决策**
 * （fallback 由调用方传入）——与 ADR 决策 3 一致，不抹平各 `withTimeout` 的不同契约。
 */

/**
 * 返回 `p` 与"`ms` 毫秒后给 `fallback`"两者中先 settle 的结果；无论谁胜都清掉计时器。
 * `p` 拒绝时错误照常传播（计时器同样被清）。
 */
export function raceWithFallback<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}