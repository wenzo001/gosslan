/**
 * 「搜索聊天记录」结果页的 TanStack Query 策略。
 *
 * 旧实现手写了一套竞态处理：`seq` 只接受最后一次响应、`searching`、`searchError`、
 * 150ms 防抖与两个 watcher。交给 Query 后，**关键词 / 发送人 / 日期都是 query key 的一部分**，
 * 响应只会写回发起它的那个键 —— 这是"连打时旧响应不能覆盖新结果"那条守卫由库承担的版本。
 * 组件只留交互（进入即搜、回车立刻重搜 / 打开高亮项）。
 */
import { keepPreviousData } from "@tanstack/vue-query";
import type { ChatSearchGroup } from "@/types";
import type { SearchDatePreset } from "./chatSearch.ts";

export const CHAT_SEARCH_QUERY = "chatSearch";

export interface ChatSearchParams {
  /** 已 trim 的关键词；空串 = 不检索（`enabled: false`）。 */
  keyword: string;
  senderId: string | null;
  preset: SearchDatePreset;
}

export const chatSearchKey = (p: ChatSearchParams) =>
  [CHAT_SEARCH_QUERY, p.keyword, p.senderId, p.preset] as const;

export type ChatSearchFetcher = (p: ChatSearchParams) => Promise<ChatSearchGroup[]>;

/**
 * · `retry: 0` —— 检索是用户主动等结果的动作，失败立刻给重试出口（旧实现也没有自动重试）；
 * · `refetchOnWindowFocus/Reconnect: false` —— 这是本地 SQL 检索，不是远端缓存，
 *   窗口回焦时偷偷重扫一遍只会让结果闪；
 * · `keepPreviousData` —— 换筛选/改关键词时旧结果继续显示（旧实现也不在请求开始时清空），
 *   新结果到了再替换；`isPlaceholderData` 让组件能区分"这是上一个键的数据"。
 */
export const CHAT_SEARCH_QUERY_POLICY = {
  staleTime: 0,
  gcTime: 5 * 60_000,
  retry: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
} as const;

export function chatSearchQueryOptions(p: ChatSearchParams, fetcher: ChatSearchFetcher) {
  return {
    queryKey: chatSearchKey(p),
    // 捕获调用时的参数：queryFn 即便延后执行，也只写回它自己的键。
    queryFn: () => fetcher(p),
    ...CHAT_SEARCH_QUERY_POLICY,
  };
}
