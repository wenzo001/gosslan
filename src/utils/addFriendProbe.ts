import { shouldRunThrottled } from "./defer.ts";

/**
 * 「搜索未命中」时是否触发一次按需探测。
 *
 * 背景：添加好友的搜索框只过滤**本机已发现**的节点，跨网段节点要等下一轮发现
 * 才会进来。用户在搜索框里敲 ID 却没结果时，应该主动推一拍 `who_has`
 * （后端会向已配置的 routed 端点单播），而不是让用户盯着空列表等。
 *
 * 约束：低频、按需。这里只回答"该不该发"，真实冷却由调用方持有；
 * 空关键词、有命中、冷却未过都返回 false。
 */
export const SEARCH_MISS_PROBE_COOLDOWN_MS = 10_000;

export interface SearchMissProbeInput {
  /** 搜索框当前关键词（原样，内部自行 trim）。 */
  query: string;
  /** 当前关键词命中的节点数。 */
  matches: number;
  /** 上一次触发探测的时间戳（ms）；从未触发传 0。 */
  lastProbeAt: number;
  /** 当前时间戳（ms），由调用方传入以便测试。 */
  now: number;
}

export function shouldProbeOnSearchMiss(input: SearchMissProbeInput): boolean {
  if (input.query.trim().length === 0) return false;
  if (input.matches > 0) return false;
  return shouldRunThrottled(input.now, input.lastProbeAt, SEARCH_MISS_PROBE_COOLDOWN_MS);
}
