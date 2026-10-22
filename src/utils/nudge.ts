/** 抖动迟到帧的年龄判定：超过 60 秒的抖动已经没有意义，直接丢掉。 */
export const NUDGE_STALE_MS = 60_000;

export function isStaleNudge(ts: number, now = Date.now()): boolean {
  if (!Number.isFinite(ts) || ts <= 0) return true;
  return now - ts > NUDGE_STALE_MS;
}
