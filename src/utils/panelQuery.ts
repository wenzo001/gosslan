/**
 * 「按主体 id 分键的只读面板」查询策略（纯逻辑，无 Tauri / Vue 运行时依赖）。
 *
 * 这类面板的共同形状：打开时拉一份、开着时随主体（群 / 好友 / 会话）切换重拉、
 * 失败保留旧数据、事件到达时只失效当前主体。旧实现各自手写 loading/failed 与
 * `StaleGuard`；交给 Query 后**按 id 分键**就是那条过期守卫，不需要每个面板再写一遍。
 */
import type { QueryClient } from "@tanstack/vue-query";

/**
 * staleTime 0 ⇒ 每次打开/重开都重拉；
 * retry 1 + retryDelay 0 ⇒ 本地 IPC 抖动只补一次，不让用户等退避；
 * gcTime 5 分钟 ⇒ 切走再切回先用旧快照占位，后台刷新。
 */
export const PANEL_QUERY_POLICY = {
  staleTime: 0,
  gcTime: 5 * 60_000,
  retry: 1,
  retryDelay: 0,
} as const;

export const panelKey = (root: string, id: string) => [root, id] as const;

export function panelQueryOptions<TData>(
  root: string,
  id: string,
  fetcher: (id: string) => Promise<TData>,
) {
  return {
    queryKey: panelKey(root, id),
    // 捕获调用时的 id：即便 queryFn 被延后执行，数据也只写回它自己的 key。
    queryFn: () => fetcher(id),
    ...PANEL_QUERY_POLICY,
  };
}

/** 事件载荷没有主体 id 时由调用方传当前主体；不传则命中整族缓存。 */
export function invalidatePanels(client: QueryClient, root: string, id?: string | null) {
  return client.invalidateQueries({ queryKey: id ? panelKey(root, id) : [root] });
}
