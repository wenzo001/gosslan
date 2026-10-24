/**
 * 好友共享目录树的查询策略。
 *
 * 与群文件面板同一形状（见 `panelQuery`），但多带一件业务事实：
 * **这棵树是谁的**。`snapshot.friendId` 随数据一起缓存，下载时用它而不是当场读
 * `chat.activeConv` —— 切会话那一拍即使旧行还在一帧里，也只会向它自己的主人要文件。
 */
import type { ShareEntry } from "@/types";
import { panelQueryOptions } from "./panelQuery.ts";

export const SHARE_TREE_QUERY = "shareTree";

export interface ShareTreeSnapshot {
  friendId: string;
  entries: ShareEntry[];
  /** 共享方是否因条数上限只回了前 N 条（界面要提示，不能把半个目录当成全部）。 */
  truncated: boolean;
}

export const shareTreeKey = (friendId: string) => [SHARE_TREE_QUERY, friendId] as const;

export function shareTreeQueryOptions(
  friendId: string,
  fetcher: (friendId: string) => Promise<{ entries: ShareEntry[]; truncated: boolean }>,
) {
  return panelQueryOptions<ShareTreeSnapshot>(SHARE_TREE_QUERY, friendId, async (id) => {
    const tree = await fetcher(id);
    return { friendId: id, entries: tree.entries, truncated: tree.truncated };
  });
}
