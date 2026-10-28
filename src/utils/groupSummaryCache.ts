/**
 * 群文件投递摘要缓存的生产装配（核心逻辑在 `groupSummaryCacheCore`，Node 可测）。
 */
import { api } from "@/api";
import {
  createGroupSummaryCache,
  type GroupFileSummary,
} from "./groupSummaryCacheCore";

export type { GroupFileSummary };

const cache = createGroupSummaryCache((transferId) =>
  api.getGroupFileDeliverySummary(transferId),
);

export function loadGroupFileSummary(
  msgId: string,
  status: string,
): Promise<GroupFileSummary> {
  return cache.load(msgId, status);
}
