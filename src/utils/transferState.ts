/** 文件传输行的界面口径。状态本身的权威定义在 Rust 侧 `file_transfers.status`。 */
export type TransferDisplayKind =
  | "none"
  | "active"
  | "queued"
  | "done"
  | "failed"
  | "cancelled"
  | "unknown";

const STATUS_KINDS: Record<string, TransferDisplayKind> = {
  active: "active",
  pending: "queued",
  done: "done",
  // 发送侧已写出、对端未回执：仍是终态，不能再画活动进度
  sent: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * 没有传输记录（历史消息）返回 "none"；认不出的状态返回 "unknown"。
 * 未知绝不映射成 "done"：把没确认的东西显示成已完成，比多一句"状态未知"贵得多。
 */
export function transferDisplayKind(status?: string | null): TransferDisplayKind {
  if (status === null || status === undefined) return "none";
  return STATUS_KINDS[status] ?? "unknown";
}

/** 只有真正在传的那一态才显示活动进度条。 */
export function transferShowsProgress(status?: string | null): boolean {
  return transferDisplayKind(status) === "active";
}

/** 需要额外说一句的状态对应的 i18n key；完成与无记录不需要。 */
export function transferStatusTextKey(status?: string | null): string | null {
  switch (transferDisplayKind(status)) {
    case "queued":
      return "send.queued";
    case "failed":
      return "msg.sendFailed";
    case "cancelled":
      return "msg.canceled";
    case "unknown":
      return "send.unknownState";
    default:
      return null;
  }
}
