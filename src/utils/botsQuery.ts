import type { QueryClient } from "@tanstack/vue-query";
import type { BotView } from "../types.ts";

/** 同一窗口的所有机器人入口共用这一键；窗口之间不共享 QueryClient。 */
export const BOTS_QUERY_KEY = ["bots"] as const;
export const BOTS_QUERY_STALE_MS = 30_000;

export function botsQueryOptions(
  fetcher: () => Promise<BotView[]>,
  enabled = true,
) {
  return {
    queryKey: BOTS_QUERY_KEY,
    queryFn: fetcher,
    enabled,
    staleTime: BOTS_QUERY_STALE_MS,
    refetchOnWindowFocus: false,
  };
}

/** 非组件调用也可复用同窗缓存；并发同键由 QueryClient 合并。 */
export function fetchBots(
  client: QueryClient,
  fetcher: () => Promise<BotView[]>,
): Promise<BotView[]> {
  return client.fetchQuery(botsQueryOptions(fetcher));
}

export function invalidateBots(client: QueryClient) {
  return client.invalidateQueries({ queryKey: BOTS_QUERY_KEY });
}
