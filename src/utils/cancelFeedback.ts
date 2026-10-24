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
