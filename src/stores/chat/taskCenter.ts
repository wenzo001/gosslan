/**
 * 任务中心投影：传输/内容/待发队列/更新下载的**只读拼装**与乐观任务行。
 *
 * 职责边界：不改消息时间线；乐观行只插 `sending` 形状的临时行，`failed` 永远来自后端。
 * 状态（四份台账、错误档、`resendingIds`）仍由 `useChatStore` 创建，这里只写同一批 ref。
 */
import { api } from "@/api";
import { dropByMsgId } from "@/utils/optimistic";
import type { PendingMessageOp } from "@/types";
import type { ChatContext } from "./runtime";

export function createTaskCenterModule(ctx: ChatContext) {
  const {
    refreshGuard,
    asReadError,
    transfers,
    contentTransfers,
    messageOps,
    transfersError,
    contentTransfersError,
    messageOpsError,
    updaterStatus,
    resendingIds,
  } = ctx.state;

  /** 并发触发时只让**最新那次**写回结果（迁入 `refreshGuard`，与上面几个共用同一份实现）。 */
  /**
   * 补拉一次更新状态（设置窗重开、任务中心首帧都靠它 —— 事件只在跃迁时发）。
   *
   * 走 `refreshGuard`：并发补拉时后发先至的旧快照必须丢掉（与 `refreshPeers` 同一条纪律；
   * 直写 `x.value = await api.…()` 是那个族里被点过名的形状）。
   */
  async function refreshUpdaterStatus() {
    const tok = refreshGuard.begin("updater");
    try {
      const st = await api.updaterStatus();
      if (!refreshGuard.isCurrent("updater", tok)) return;
      updaterStatus.value = st;
    } catch {
      // 移动端/权限问题：保持原值（任务中心不列它，设置页也不会假装在下载）
    }
  }

  /**
   * 用户点了「重新发送」并确认过的那几条 msg_id（2026-10-26）。
   *
   * 只用来把任务中心那一行说成「重发中」—— 库里区分不出首次发送与重发（同为 `sending` +
   * 同形的 outbox 行），为一句文案去加一列不值得。⚠️ 它**必须**被剪：每次拉到 `messageOps`
   * 就把已经不在这份台账里的 id 摘掉，否则那条重发成功后，标记会永远留在内存里，
   * 下一次同一 msg_id 再进队列时会凭空显示成「重发中」。
   */
  function markResending(msgId: string) {
    resendingIds.value.add(msgId);
  }

  async function refreshTransfers() {
    const req = refreshGuard.begin("transfers");
    // 三路各自失败各自登记（原写法只有 `getTransfers` 没 catch ⇒ 后端一上抛，`Promise.all`
    // 把另两路**已经读到的**结果一起扔掉）。allSettled 让"谁失败谁进错误档、谁成功谁落地"，
    // 失败那一路保留上一次的值而不是清空。
    const [t, c, m] = await Promise.allSettled([
      api.getTransfers(),
      api.getContentTransfers(),
      api.getPendingMessageOperations(),
    ]);
    const list = t.status === "fulfilled" ? t.value : transfers.value;
    const contents = c.status === "fulfilled" ? c.value : contentTransfers.value;
    const msgOps = m.status === "fulfilled" ? m.value : messageOps.value;
    transfersError.value = t.status === "fulfilled" ? null : asReadError(t.reason);
    contentTransfersError.value = c.status === "fulfilled" ? null : asReadError(c.reason);
    messageOpsError.value = m.status === "fulfilled" ? null : asReadError(m.reason);
    // 后发先至的旧快照必须丢掉：多选发送时每个文件都会 `void refreshTransfers()`，
    // 旧快照里**没有**刚建的那条 transfer ⇒ 覆盖回来后，后续 file-progress 全部落空
    // （见 updateTransferProgress），进度条永久钉在「发送中 0%」——而对端早就收完已读。
    if (!refreshGuard.isCurrent("transfers", req)) return;
    transfers.value = list;
    // 顺带刷新统一内容状态：未完成 / 校验失败的气泡据此显示「点击重试」。
    contentTransfers.value = contents;
    messageOps.value = msgOps;
    // 剪掉已经不在台账里的标记（见上面 `resendingIds` 的注释）。
    if (resendingIds.value.size) {
      const live = new Set(msgOps.map((o) => o.msg_id));
      for (const id of [...resendingIds.value]) if (!live.has(id)) resendingIds.value.delete(id);
    }
  }
  /**
   * 乐观任务中心行（表情回应 / 撤回，5.16.93）。
   *
   * 为什么可以先插一行：这两个动作都已是「先入队、后协商」，点下去**必然**会写进补发队列
   * （除非同步校验失败）。先插的是同一形状的 `sending` 行，等后端快照到达后由
   * `refreshTransfers` 整表替换；失败时只摘这一行（`dropByMsgId` 只认临时 `msg_id`，
   * 「真实先到、迟到回滚」不会把真实行一起删掉）。
   *
   * ⚠️ 它**不是**伪造失败态：`failed` / `fail_code` 永远只来自后端；临时行 `can_cancel=false`，
   * 不给用户一个点了没有意义的取消/重发按钮。
   */
  function optimisticOpRow(
    msgId: string,
    convId: string,
    kind: string,
    nudge = false,
  ): PendingMessageOp {
    const groupId = convId.startsWith("group:") ? convId.slice(6) : null;
    return {
      msg_id: msgId,
      peer_id: groupId ? null : convId,
      group_id: groupId,
      kind,
      waiting_for: groupId ? 0 : 1,
      created_at: Date.now(),
      preview: null,
      peer_offline: false,
      can_cancel: false,
      some_delivered: false,
      failed: false,
      fail_code: null,
      nudge,
    };
  }
  function showOptimisticOp(op: PendingMessageOp) {
    messageOps.value = [op, ...messageOps.value.filter((o) => o.msg_id !== op.msg_id)];
  }
  function dropOptimisticOp(msgId: string) {
    const next = dropByMsgId(messageOps.value, msgId);
    if (next) messageOps.value = next;
  }

  /** 进度/done 事件早于 transfer 行进内存时的一次性补拉（防抖，不放大 IPC）。 */
  let transfersRepairTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleTransfersRepair() {
    if (transfersRepairTimer) return;
    transfersRepairTimer = setTimeout(() => {
      transfersRepairTimer = null;
      void refreshTransfers();
    }, 400);
  }

  /** 换实例 / 重新 init 时拆掉补拉定时器（否则旧闭包会继续刷新已被丢弃的 ref）。 */
  function cancelTransfersRepairTimer() {
    if (transfersRepairTimer) {
      clearTimeout(transfersRepairTimer);
      transfersRepairTimer = null;
    }
  }

  return {
    refreshUpdaterStatus,
    markResending,
    refreshTransfers,
    optimisticOpRow,
    showOptimisticOp,
    dropOptimisticOp,
    scheduleTransfersRepair,
    cancelTransfersRepairTimer,
  };
}
