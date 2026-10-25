/**
 * 「取消文件传输」之后该说哪句话 —— 四个分支的唯一判据。
 *
 * 为什么值得单独一家：本机停手 ≠ 对面停手。老端没有 `CONTENT_FEATURE_FILE_CANCEL`
 * 这一位时我们**一条通知都不发**（INV-P24 第 4 条），它会继续传/收到自己的 deadline；
 * 通知也可能送不出去（离线 / 队列满）。这两种情况下界面若只说"已取消"，用户会以为对面也停了。
 * 后端因此把 `notifiedPeer` 一起返回（帧到底有没有进链路），界面只负责选一句准确的话。
 *
 * 第四态 `ledger_pending` 来自 FUNC-02：取消的几笔写现在共处一个事务，任一失败即整体回滚
 * （后端记 `code=CANCEL_COMMIT_FAILED`）。本机确实停了手，但刷新后台账还会显示发送中 ——
 * 这时说"已取消"就是比事实更满，必须单独一句话。它排在 `already_done` 之后、通知之前：
 * 已经送达的单根本没有"取消"这回事，那个结论更根本。
 */
export type CancelOutcome = "already_done" | "ledger_pending" | "local_only" | "notified";

export interface CancelResultView {
  cancelled: boolean;
  alreadyDone: boolean;
  notifiedPeer: boolean;
  /** 台账那一笔写是否真的落地（事务失败 ⇒ false）。 */
  ledgerCommitted: boolean;
}

export function cancelOutcome(res: CancelResultView): CancelOutcome {
  if (res.alreadyDone) return "already_done";
  if (res.ledgerCommitted === false) return "ledger_pending";
  if (!res.notifiedPeer) return "local_only";
  return "notified";
}

/**
 * 取消文件之后该用哪条文案 —— **唯一**映射（任务中心与气泡共用同一套事实）。
 *
 * `wasSent` 由调用方在**发请求之前**读（`row.blockedReason === "waiting_ack"` =
 * 字节已写出、只在等对端确认）。这一格不能省：用户 2026-10-25 的原话是
 * "文件 `sent` 取消措辞"——已经发出去的字节收不回来，只说"已取消"会让人以为对方没收到。
 *
 * 顺序与 `cancelOutcome` 的四档一致：已送达 > 台账没落地 > 对面可能还在传 > 正常取消。
 * 只有最后一档才分 `sent` / 未写出两种说法。
 */
export function fileCancelKey(outcome: CancelOutcome, wasSent: boolean): string {
  switch (outcome) {
    case "already_done":
      return "msg.cancelSend.alreadyDone";
    case "ledger_pending":
      return "transfer.cancelLedgerPending";
    case "local_only":
      return "transfer.cancelLocalOnly";
    default:
      return wasSent ? "transfer.cancelSent" : "task.cancelDone";
  }
}

/**
 * 「取消一条消息」之后该说哪句话 —— 后端结构化结果的**唯一**文案映射。
 *
 * 两个调用方（任务中心与气泡菜单）以前各自 if/else 猜短码，群消息出现
 * `partial_cancelled` 之后那套二元判断必然说错话：用户取消了 5 个未送达成员里的 4 个，
 * 界面只有"已请求取消"和"已送达"两句可用。这里把 7 种结论一次说清，
 * 并带上真实计数（`delivered` / `remaining` 都来自台账）。
 */
export interface MessageCancelNotice {
  key: string;
  params?: Record<string, number>;
  kind: "success" | "info";
}

export function messageCancelNotice(res: {
  outcome: string;
  delivered: number;
  remaining: number;
}): MessageCancelNotice {
  switch (res.outcome) {
    case "partial_cancelled":
      return {
        key: "msg.cancelSend.partial",
        params: { delivered: res.delivered, remaining: res.remaining },
        kind: "success",
      };
    case "cancelled":
      return { key: "msg.cancelSend.requested", kind: "success" };
    case "already_cancelled":
      return { key: "msg.cancelSend.alreadyCancelled", kind: "info" };
    case "already_delivered":
      return { key: "msg.cancelSend.delivered", kind: "info" };
    case "already_failed":
      return { key: "msg.cancelSend.alreadyFailed", kind: "info" };
    case "rejected":
      return { key: "msg.cancelSend.rejected", kind: "info" };
    // not_found 不是错误：消息可能刚被清理。说事实，不报红。
    default:
      return { key: "msg.cancelSend.notFound", kind: "info" };
  }
}

/**
 * 「按成员补发一条群消息」之后该说哪句话 —— `resend_group_delivery` 的唯一文案映射。
 *
 * `online` / `offline` 是后端**当场**算的：在线成员的信封已经进链路，离线的要等他们上线
 * 由 flush 自动补（D4）。界面不许把它说成"已送达" —— 那一刻只是"已投递到链路/已排队"。
 */
export function groupResendNotice(res: {
  outcome: string;
  online: number;
  offline: number;
  remaining: number;
}): MessageCancelNotice {
  switch (res.outcome) {
    case "resent":
      return res.offline > 0
        ? {
            key: "msg.groupResend.queued",
            params: { online: res.online, offline: res.offline },
            kind: "success",
          }
        : { key: "msg.groupResend.done", params: { online: res.online }, kind: "success" };
    case "already_pending":
      return { key: "msg.groupResend.alreadyPending", params: { remaining: res.remaining }, kind: "info" };
    case "already_delivered":
      return { key: "msg.groupResend.allDelivered", kind: "info" };
    // 只剩 failed 行 = 本端已放弃的那批成员：不许悄悄退回"整条重发"（那会给对端一条重复内容）。
    case "already_failed":
      return { key: "msg.groupResend.allDelivered", kind: "info" };
    case "not_found":
      return { key: "msg.cancelSend.notFound", kind: "info" };
    // no_ledger（升级前发出的消息）/ unsupported（文件等）：调用方应退回整条重发。
    case "no_ledger":
      return { key: "msg.groupResend.noLedger", kind: "info" };
    default:
      return { key: "msg.groupResend.unsupported", kind: "info" };
  }
}
