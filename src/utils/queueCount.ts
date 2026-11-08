/**
 * 传输队列数字的展示上限（用户 2026-11-08）。
 *
 * 页脚「任务中心 · N」里的 N 是唯一会随运行时长无限增长的可见数字；四位数会把整行撑开、
 * 把左侧标签挤窄。约定：**999 本身照常显示**，1000 起一律 `999+`（不是 999 就截断）。
 *
 * 真实条数不受影响：无障碍标签（`aria-label`）仍读实际值，截断只作用于眼睛看到的那个数。
 */
export const QUEUE_COUNT_MAX = 999;

export function formatQueueCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const whole = Math.floor(n);
  return whole > QUEUE_COUNT_MAX ? `${QUEUE_COUNT_MAX}+` : String(whole);
}
