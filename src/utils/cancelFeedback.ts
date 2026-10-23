/**
 * 「取消文件传输」之后该说哪句话 —— 三个分支的唯一判据。
 *
 * 为什么值得单独一家：本机停手 ≠ 对面停手。老端没有 `CONTENT_FEATURE_FILE_CANCEL`
 * 这一位时我们**一条通知都不发**（INV-P24 第 4 条），它会继续传/收到自己的 deadline；
 * 通知也可能送不出去（离线 / 队列满）。这两种情况下界面若只说"已取消"，用户会以为对面也停了。
 * 后端因此把 `notifiedPeer` 一起返回（帧到底有没有进链路），界面只负责选一句准确的话。
 */
export type CancelOutcome = "already_done" | "local_only" | "notified";

export interface CancelResultView {
  cancelled: boolean;
  alreadyDone: boolean;
  notifiedPeer: boolean;
}

export function cancelOutcome(res: CancelResultView): CancelOutcome {
  if (res.alreadyDone) return "already_done";
  if (!res.notifiedPeer) return "local_only";
  return "notified";
}
