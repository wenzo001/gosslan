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

/** 事件带归属时只失效对应群；无归属调用仍保留显式全量失效能力。 */
export function invalidateGroupFiles(client: QueryClient, groupId?: string | null) {
  return invalidatePanels(client, GROUP_FILES_QUERY, groupId);
}
