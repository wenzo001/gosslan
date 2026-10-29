/**
 * 群文件投递摘要的缓存核心（**零 `@/` 依赖**，Node 单测可直接加载）。
 *
 * 语义（审计 P1 #19）：
 *  - 键 = `msgId + status`：同一条消息**状态一变就必须重取**；
 *  - 同一键 10s 内的重复挂载复用缓存（虚拟列表回收 → 重新挂载不再打 IPC）；
 *  - 同键并发只发一次（单飞）；
 *  - **失败不缓存**：下一次挂载应重试（这里没有"落盘后自愈"的事件可用）。
 */
import { clearWhenFull } from "./bounded.ts";
import { shouldRunThrottled } from "./defer.ts";
import { createSingleFlight } from "./singleFlight.ts";

export type GroupFileSummary = {
  completed: number;
  failed: number;
  waiting: number;
  cancelled: number;
} | null;

export const GROUP_SUMMARY_TTL_MS = 10_000;
export const GROUP_SUMMARY_CACHE_MAX = 200;

export interface GroupSummaryCache {
  /** `now` 只为测试可控；生产不传（缺省 `Date.now()`）。 */
  load(msgId: string, status: string, now?: number): Promise<GroupFileSummary>;
}

export function createGroupSummaryCache(
  fetchSummary: (transferId: string) => Promise<GroupFileSummary>,
  ttlMs: number = GROUP_SUMMARY_TTL_MS,
  max: number = GROUP_SUMMARY_CACHE_MAX,
): GroupSummaryCache {
  const cache = new Map<string, { at: number; value: GroupFileSummary }>();
  const inflight = createSingleFlight<GroupFileSummary>();
  const keyOf = (msgId: string, status: string) => `${msgId}\u0000${status}`;

  return {
    load(msgId, status, now = Date.now()) {
      const key = keyOf(msgId, status);
      const hit = cache.get(key);
      // 节流口径唯一份在 `defer.ts::shouldRunThrottled`（"还没到点 ⇒ 用缓存"）。
      if (hit && !shouldRunThrottled(now, hit.at, ttlMs)) {
        // LRU：命中即刷新位置
        cache.delete(key);
        cache.set(key, hit);
        return Promise.resolve(hit.value);
      }
      return inflight.run(key, async () => {
        const value = await fetchSummary(msgId.slice(6));
        clearWhenFull(cache, max);
        // `at` 用**传入时刻**（生产是 Date.now，测试可控），别混用两次取时钟。
        cache.set(key, { at: now, value });
        return value;
      });
    },
  };
}
