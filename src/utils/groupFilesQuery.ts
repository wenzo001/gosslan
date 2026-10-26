/**
 * 群文件清单的 TanStack Query 策略。
 *
 * 正确性全压在「按群分键」上：旧实现靠 `load()` 里的 `gid !== props.groupId` 手工守卫挡
 * 「A 群的慢响应回填进 B 群」；交给 Query 之后，响应只会写进发起它的那个 query key。
 * 通用策略（重拉/重试/失效半径）见 `panelQuery`，这里只留群文件自己的键与失效半径。
 */
import type { QueryClient } from "@tanstack/vue-query";
import { invalidatePanels, panelKey } from "./panelQuery.ts";

export const GROUP_FILES_QUERY = "groupFiles";

export const groupFilesKey = (groupId: string) => panelKey(GROUP_FILES_QUERY, groupId);

/** 文件事件没有群 id ⇒ 面板只失效「当前打开的那一个群」，不重拉所有缓存。 */
export function invalidateGroupFiles(client: QueryClient, groupId?: string | null) {
  return invalidatePanels(client, GROUP_FILES_QUERY, groupId);
}
