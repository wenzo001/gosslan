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

/**
 * 排队行的“为什么不动”短码 → i18n key。
 *
 * 后端只回稳定短码（`queue_missing` 等），文案在这里映射；未知短码返回 null，
 * 不许把机器码直接上屏。
 *
 * ⚠️ 这一家同时服务**任务中心**（`utils/taskCenter` 的 `blockedReason` 也用它翻译）：
 * 那三个后加的是任务中心独有的格子 —— `waiting_ack`（字节已写出、等对方回执）、
 * `queued_by_backend`（在本机的补发队列里排着）、`no_source`（群里没人再有这份内容）。
 * 两处共用一份映射是刻意的：同一个短码在气泡和任务中心说同一句话。
 */
export function blockedReasonKey(reason?: string | null): string | null {
  switch (reason) {
    case "queue_missing":
      return "transfer.blocked.queueMissing";
    case "queue_closed":
      return "transfer.blocked.queueClosed";
    case "retry_exhausted":
      return "transfer.blocked.retryExhausted";
    case "waiting_retry":
      return "transfer.blocked.waitingRetry";
    case "peer_offline":
      return "transfer.blocked.peerOffline";
    case "waiting_ack":
      return "transfer.blocked.waitingAck";
    case "queued_by_backend":
      return "transfer.blocked.queuedByBackend";
    case "no_source":
      return "transfer.blocked.noSource";
    default:
      return null;
  }
}

/** 状态行的视觉档位（见 `transferStatusTone`）。 */
export type TransferStatusTone = "muted" | "warn" | "error";

/**
 * 状态行该长多重（10-22 审计 D-4：「停滞」与「失败」此前只差一行字，
 * 而且都是同一种 `opacity-70` 灰色小字 —— 用户扫一眼分不出"还在但慢"和"已经坏了"）。
 *
 * 判据**复用上面那一份分类**，不在调用方另立第二个：`transferDisplayKind` 说什么档就是什么档，
 * 加一态只改 `STATUS_KINDS` 那一处就够（这里也只需要知道分类结果）。
 *
 * - `error`：已经终结而且是坏的（failed / cancelled / 认不出的状态）⇒ 必须看得清写的是什么。
 * - `warn`：还在"活动中"，但**没有在动**（由调用方把"停滞/无进展"这个事实传进来 ——
 *   单看 status 判不出"active 但卡住"，那一格是事件层的事，不许在这里猜）。
 * - `muted`：排队与正常进行中的普通说明。
 *
 * ⚠️ `cancelled` 归到 `error` 档只为了"和成功拉开"，**文案仍然说「已取消」**：
 *    R-34 的教训是别把用户主动取消谎报成失败 —— 颜色不是文案，不许用它改语义。
 */
export function transferStatusTone(
  status?: string | null,
  opts?: { notProgressing?: boolean },
): TransferStatusTone {
  const kind = transferDisplayKind(status);
  if (kind === "failed" || kind === "cancelled" || kind === "unknown") return "error";
  if (kind === "active" && opts?.notProgressing === true) return "warn";
  return "muted";
}
