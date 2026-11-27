import type { Conversation } from "@/types";

/** 冷启动只恢复 store 记住的 last；没有有效 last 时不再猜首条。 */
export function restoreLastConversationId(
  last: string | null | undefined,
  conversations: readonly Conversation[],
): string | null {
  if (!last) return null;
  return conversations.some((c) => c.id === last) ? last : null;
}
