/**
 * 群文件清单的 TanStack Query 策略（纯逻辑，无 Tauri / Vue 依赖）。
 *
 * 为什么单列：清单的**正确性**全压在「按群分键」上 ——
 * 旧实现靠 `load()` 里的 `gid !== props.groupId` 手工守卫挡「A 群的慢响应回填进 B 群」；
 * 交给 Query 之后，响应只会写进发起它的那个 query key，守卫由结构保证。
 * 这里把 key 与失效半径抽出来，好让 node 单测直接拿 QueryClient 验证，
 * 组件里只剩「把 key 绑到 props」这一句。
 */
import type { QueryClient } from "@tanstack/vue-query";
import type { GroupFileEntry } from "@/types";

/** 前缀失效的根键：`invalidateQueries({ queryKey: [GROUP_FILES_QUERY] })` 命中所有群。 */
export const GROUP_FILES_QUERY = "groupFiles";

export const groupFilesKey = (groupId: string) => [GROUP_FILES_QUERY, groupId] as const;

export type GroupFilesFetcher = (groupId: string) => Promise<GroupFileEntry[]>;

/**
 * 每个群一份缓存；staleTime 0 表示「面板每次打开都重拉」（打开 = enabled 变 true）。
 * retry 1 + retryDelay 0：本地 IPC 抖动重试一次即可，不值得让用户等退避；
 * gcTime 5 分钟：关掉面板再打开同一群时先用旧快照占位，后台刷新（旧实现是清空 + 转圈）。
 */
export const GROUP_FILES_QUERY_POLICY = {
  staleTime: 0,
  gcTime: 5 * 60_000,
  retry: 1,
  retryDelay: 0,
} as const;

export function groupFilesQueryOptions(groupId: string, fetcher: GroupFilesFetcher) {
  return {
    queryKey: groupFilesKey(groupId),
    // 捕获调用时的 groupId，而不是回调里再读 props：
    // 即便 queryFn 被延后执行，数据也只会写回它自己的 key。
    queryFn: () => fetcher(groupId),
    ...GROUP_FILES_QUERY_POLICY,
  };
}

/** 文件事件没有群 id ⇒ 面板只失效「当前打开的那一个群」，不重拉所有缓存。 */
export function invalidateGroupFiles(client: QueryClient, groupId?: string | null) {
  return client.invalidateQueries({
    queryKey: groupId ? groupFilesKey(groupId) : [GROUP_FILES_QUERY],
  });
}
