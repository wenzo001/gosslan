/**
 * 附件与媒体：文件/图片发送、传输停滞标记、进度与终态事件、群文件诊断尾部。
 *
 * 职责边界：只负责"传输这条链路"的前端投影；消息入账复用 `messaging` 的
 * enqueueMessage / 乐观收回，传输台账本身由 `taskCenter` 维护。
 */
import { ref } from "vue";
import { api } from "@/api";
import { t } from "@/i18n";
import type { MessageRecord, FileDoneInfo, FileFailedInfo, FileProgress, FileStalledInfo } from "@/types";
import { invalidateFilePreview } from "@/utils/filePreview";
import { fileFailReasonText } from "@/utils/fileFailReason";
import { findFirstMessageById, replaceMessageAt, transferFailureMsgIds } from "@/utils/messages";
import { progressAdvanced, stallFlagAlive } from "@/utils/transferProgressWatch";
import type { ChatContext } from "./runtime";

export function createMediaModule(ctx: ChatContext) {
  const { app, transfers, messages } = ctx.state;
  const {
    enqueueMessage,
    captureSummary,
    restoreSummaryIfOurs,
    dropOptimistic,
    refreshTransfers,
    scheduleTransfersRepair,
  } = ctx.api;

  /** 统一文件发送：后端自动路由（有直连走直连，无直连自动中继）。 */
  async function sendFileTo(
    convId: string,
    path: string,
    msgId?: string,
    kindHint?: "file" | "image",
  ) {
    if (convId.startsWith("group:")) return null;
    const name = path.split(/[\\/]/).pop() ?? t("common.file");
    // 乐观投影：点下即出现在底部。真实记录（后端返回前同步 emit 的 `message-received`）
    // 带同一个 `local_id`，到达后原地替换；元数据（size/subtype/sha256）以真实记录为准。
    const localId = crypto.randomUUID();
    const kind =
      kindHint ?? (/\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i.test(name) ? "image" : "file");
    const optimistic: MessageRecord = {
      id: -1,
      msg_id: `tmp-${localId}`,
      local_id: localId,
      conv_id: convId,
      sender_id: app.device?.device_id ?? "",
      receiver_id: convId,
      kind,
      content: JSON.stringify({ name, path, size: 0, sha256: "", subtype: kind }),
      ts: Date.now(),
      seq: Number.MAX_SAFE_INTEGER,
      status: "sending",
    };
    enqueueMessage(optimistic);
    const summaryBefore = captureSummary(convId);
    try {
      const id = await api.sendFileAuto(convId, path, msgId, localId);
      void refreshTransfers();
      return id;
    } catch (e) {
      // 拒绝发生在写库之前：库里没有这一行，投影必须**整条收回**（留下就是幽灵消息）。
      // 若真实记录已经先到（替换掉了 `tmp-*`），`dropOptimistic` 找不到它，不会误删。
      dropOptimistic(convId, optimistic.msg_id);
      restoreSummaryIfOurs(convId, optimistic.ts, summaryBefore);
      void refreshTransfers();
      app.toastError(e, t("send.fileFail"));
      return null;
    }
  }

  /** 群文件发送：走群文件链路（Offer → Chunk → Done → CompleteAck）。
   *  群文件气泡/进度展示留待后续阶段，本封装只负责触发后端传输。 */
  async function sendGroupFileTo(groupId: string, path: string, msgId?: string) {
    try {
      const id = await api.sendGroupFile(groupId, path, msgId);
      void refreshTransfers();
      return id;
    } catch (e) {
      app.toastError(e, t("send.groupFileFail"));
      return null;
    }
  }

  /** 粘贴图片发送：data URL → 本地文件 → 文件传输（单聊/群聊复用同一条可靠链路）。
   *  发送初始化失败时删除已保存的孤儿图片。 */
  async function sendImage(convId: string, dataUrl: string) {
    const { path } = await api.saveOutgoingImage(dataUrl);
    try {
      if (convId.startsWith("group:")) {
        // 本机刚生成、刚落盘的图片：没有"被转发的那条消息"，不带 msgId。
        const id = await api.sendGroupFile(convId.slice(6), path);
        void refreshTransfers();
        return id;
      }
      // 单聊走同一条文件链路 ⇒ 与"发文件"共用乐观投影 / 收回 / 摘要回滚。
      const id = await sendFileTo(convId, path, undefined, "image");
      // `sendFileTo` 已在失败时收回投影并给出原因；这里只补"孤儿图片"清理。
      if (id === null) await api.deleteFile(path).catch(() => {});
      return id;
    } catch (e) {
      // 初始化失败：清理孤儿图片，避免 downloads 目录堆积垃圾
      await api.deleteFile(path).catch(() => {});
      app.toastError(e, t("send.imageFail"));
      return null;
    }
  }

  /**
   * 处于「停滞/等待」的 transfer → 原因文案（按 writer 实发判定，后端只在状态翻转时发一次事件）。
   *
   * 为什么单独存而不下到 `transfers[]` 行上：`refreshTransfers()` 会用后端快照**整体替换**
   * 那个数组，行上的临时标记会被无声冲掉；停滞是"这次尝试"的状态，必须活得比快照久。
   *
   * 值就是原因（`undefined` = 普通的链路静默，界面回退到既有的「网络停滞」文案）。
   * 用 Map 而不是 Set：只有蓝牙链路时大文件会"保持 pending 等 LAN"（后端
   * `refuse_reason_for_best_link`），那句原因必须落在同一个集合里 —— 分两处存就一定会有
   * 一边忘了清（表现为"停滞"标签一直挂着）。
   */
  const stalledTransfers = ref<Map<string, { reason?: string; flaggedAt: number }>>(new Map());
  function isTransferStalled(id: string, nowMs: number = Date.now()) {
    const rec = stalledTransfers.value.get(id);
    if (!rec) return false;
    return stallFlagAlive(nowMs, rec.flaggedAt);
  }
  function transferStallReason(id: string, nowMs: number = Date.now()): string | undefined {
    const rec = stalledTransfers.value.get(id);
    if (!rec || !stallFlagAlive(nowMs, rec.flaggedAt)) return undefined;
    return rec.reason;
  }
  function setTransferStalled(
    id: string,
    stalled: boolean,
    reason?: string,
    nowMs: number = Date.now(),
  ) {
    const next = reason ?? undefined;
    const cur = stalledTransfers.value.get(id);
    if (stalled) {
      // **重发也要重新盖章**：持续性停滞（比如"只有蓝牙、等 LAN 回来"）后端每个心跳 flush
      // 会重发一次，那是一次"这条链还在报告同一件事"的活证据。原实现把重发当幂等直接 return，
      // 于是 TTL 一过标记就被判过期 —— 修 D-5 不能顺手把"持续停滞一直显示"这条真实行为弄丢。
      // 值没变时只就地改时间戳、不换整个 Map：显示内容没变，换 Map 只是白白让所有订阅者重算。
      if (cur && cur.reason === next && stallFlagAlive(nowMs, cur.flaggedAt)) {
        cur.flaggedAt = nowMs;
        return;
      }
      const m = new Map(stalledTransfers.value);
      m.set(id, { reason: next, flaggedAt: nowMs });
      // 顺手把过期的邻居带走：这套标记没有别的清扫点，攒着就是"漏一条永远挂着"那一族。
      for (const [k, v] of m) {
        if (!stallFlagAlive(nowMs, v.flaggedAt)) m.delete(k);
      }
      stalledTransfers.value = m;
      return;
    }
    if (!cur) return;
    const m = new Map(stalledTransfers.value);
    m.delete(id);
    stalledTransfers.value = m;
  }
  function onFileStalled(p: FileStalledInfo) {
    setTransferStalled(p.transfer_id, p.stalled, p.reason ?? undefined);
  }

  function updateTransferProgress(p: FileProgress) {
    const t = transfers.value.find((x) => x.id === p.transfer_id);
    if (t) {
      const next = p.total > 0 ? p.received / p.total : 0;
      const advanced = progressAdvanced(typeof t.progress === "number" ? t.progress : null, next);
      t.progress = next;
      // 字节又动了，就是「停滞已经恢复」的正面证据 —— 不必等后端那条 `file-stalled:false`
      // 的翻转事件（审计 D-5：那条一漏，标签就永远挂在一行还在走的进度上）。
      if (advanced && stalledTransfers.value.has(p.transfer_id)) {
        setTransferStalled(p.transfer_id, false);
      }
      return;
    }
    // 找不到行**不能静默丢**：进度是节流发的（250ms 一次），丢掉一次就可能再也没有下一次。
    scheduleTransfersRepair();
  }
  function onFileDone(d: FileDoneInfo) {
    // 终态一律收回「网络停滞」提示：后端只在翻转时发事件，漏一条就会让下次重试显示旧状态。
    setTransferStalled(d.transfer_id, false);
    const t = transfers.value.find((x) => x.id === d.transfer_id);
    if (t) {
      t.status = "done";
      t.path = d.path;
      t.progress = 1;
    } else {
      scheduleTransfersRepair();
    }
    // 字节刚落盘：让这条消息的预览缓存失效 —— 收到图片时可能"消息先到、字节后到"，
    // 在途读预览会得到"仍在接收"；不失效就不会重读，图片只能靠重发才出来。
    invalidateFilePreview(`file-${d.transfer_id}`);
    invalidateFilePreview(`gfile-${d.transfer_id}`);
  }
  /**
   * 群文件投递诊断行的最近留档（10-22 审计 R-28 / D-3）。
   *
   * 后端 `group-file-log` 说的正是「哪个收件人、卡在哪一步」，此前前端无人订阅 ⇒
   * 界面上只有"K 人失败"这个数，原因永远看不到。这里只留**上界 50 行**的环形尾部，
   * 给诊断面板看；不进消息列表、不打 toast（它是排障细节，不该打断每个用户）。
   */
  const groupFileDiag = ref<{ ts: number; line: string }[]>([]);
  const GROUP_FILE_DIAG_MAX = 50;
  function onGroupFileLog(line: string) {
    groupFileDiag.value = [...groupFileDiag.value, { ts: Date.now(), line }].slice(
      -GROUP_FILE_DIAG_MAX,
    );
  }

  function onFileFailed(d: FileFailedInfo) {
    setTransferStalled(d.transfer_id, false);
    // **必须认双前缀**：群文件气泡的 msg_id 是 `gfile-${transfer_id}`（后端 group_file.rs 就这么拼），
    // 而这里此前只拼 `file-` ⇒ 群文件失败时内存里那条永远不落状态，界面继续转圈。
    // 同文件的 onFileCancelled 两个前缀都认、onFileDone 也两个都失效缓存 —— 三条里只有这条漏，
    // 是「群文件永远发送中」的前端那一半（另一半在后端：失败分支不发终态事件）。
    const hit = findFirstMessageById(messages.value, transferFailureMsgIds(d.transfer_id));
    if (hit) {
      messages.value = replaceMessageAt(messages.value, hit.convId, hit.index, {
        ...hit.rec,
        status: "failed",
      });
    }
    app.toast(`${t("send.fileFail")}${t("common.sep.colon")}${fileFailReasonText(d.reason, t)}`, "error");
  }
  return {
    sendFileTo,
    sendGroupFileTo,
    sendImage,
    stalledTransfers,
    isTransferStalled,
    transferStallReason,
    setTransferStalled,
    onFileStalled,
    updateTransferProgress,
    onFileDone,
    onGroupFileLog,
    onFileFailed,
    groupFileDiag,
  };
}
