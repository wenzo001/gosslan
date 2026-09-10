import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { api } from "@/api";
import { loadFilePreview } from "@/utils/filePreview";
import { shouldProbePresence } from "@/utils/mediaAvailability";
import { codeNeedsClamp } from "@/utils/previewMetrics";
import type { FileMeta, MessageRecord } from "@/types";

export type { FileMeta };

/** 文件消息的 msg_id 与 transfer_id 的映射：单聊 "file-{id}"，群文件 "gfile-{id}"。 */
function transferIdOf(msgId: string): string | null {
  if (msgId.startsWith("file-")) return msgId.slice(5);
  if (msgId.startsWith("gfile-")) return msgId.slice(6);
  return null;
}

/**
 * 文件/附件消息的派生状态：元信息、传输进度、本地预览、打开与另存。
 */
export function useMessageFile(
  message: MaybeRefOrGetter<MessageRecord>,
  sendState: MaybeRefOrGetter<string>,
) {
  const app = useAppStore();
  const chat = useChatStore();
  const msg = computed(() => toValue(message));

  const transfer = computed(() => {
    const id = transferIdOf(msg.value.msg_id);
    return id ? (chat.transfers.find((t) => t.id === id) ?? null) : null;
  });

  /** 乐观上屏的文件/图片气泡可能缺 size/path，用传输记录补齐。 */
  const fileMeta = computed<FileMeta | null>(() => {
    if (msg.value.kind !== "file" && msg.value.kind !== "image") return null;
    try {
      const meta = JSON.parse(msg.value.content) as Partial<FileMeta>;
      const t = transfer.value;
      return {
        name: meta.name ?? t?.name ?? "文件",
        path: meta.path ?? t?.path ?? "",
        size: meta.size ?? t?.size ?? 0,
        subtype: meta.subtype ?? (msg.value.kind === "image" ? "image" : "file"),
      };
    } catch {
      return null;
    }
  });

  /** 进度 0~1；无记录（历史消息）返回 null 表示不显示进度条。 */
  const fileProgress = computed(() => {
    const t = transfer.value;
    if (!t || t.status === "done") return null;
    return t.progress;
  });
  const fileStatusText = computed(() => {
    const t = transfer.value;
    if (!t || t.status === "done") return null;
    const pct = Math.round((t.progress ?? 0) * 100);
    return t.direction === "send" ? `发送中 ${pct}%` : `接收中 ${pct}%`;
  });

  const attachmentUrl = ref<string | null>(null);
  const attachmentCode = ref<string | null>(null);
  const previewNote = ref<string | null>(null);
  /**
   * 本地媒体已被「存储清理」删除。
   * 用于把"坏图/打不开"换成明确的「已被清理」提示——否则用户会以为是对端发来的
   * 文件本身有问题，而不是本机为了腾空间删掉了它。
   * 只有后端能**确定**文件已删除时才为真（见 `api.mediaPresent` 的语义）。
   */
  const attachmentMissing = ref(false);

  /** 当 file/image 消息本地路径就绪、未失败、且为 image/code 时可预览。 */
  const previewSubtype = computed<"image" | "code" | null>(() => {
    const meta = fileMeta.value;
    if ((msg.value.kind !== "file" && msg.value.kind !== "image") || !meta || !meta.path) return null;
    if (toValue(sendState) === "failed") return null;
    return meta.subtype === "image" || meta.subtype === "code" ? meta.subtype : null;
  });

  /**
   * 普通文件（subtype=file）没有"读预览"这条路径，因此拿不到可达性信号，
   * 需要单独问一次后端文件还在不在。图片/代码附件由预览读取代劳，不重复探测。
   */
  const needsPresenceProbe = computed(() =>
    shouldProbePresence(msg.value.kind, fileMeta.value),
  );

  async function ensureAttachmentPreview() {
    const sub = previewSubtype.value;
    const meta = fileMeta.value;
    if (sub) {
      const r = await loadFilePreview(msg.value.msg_id, sub, meta?.name ?? "");
      // await 期间该气泡可能已不满足预览条件（切换/失败）→ 丢弃，避免贴到错误气泡。
      if (previewSubtype.value !== sub) return;
      attachmentUrl.value = r.url ?? null;
      attachmentCode.value = r.text ?? null;
      previewNote.value = r.note ?? null;
      attachmentMissing.value = r.missing === true;
      return;
    }
    attachmentUrl.value = null;
    attachmentCode.value = null;
    previewNote.value = null;
    attachmentMissing.value = false;
    if (!needsPresenceProbe.value) return;

    const msgId = msg.value.msg_id;
    const present = await api.mediaPresent(msgId);
    // 同上：期间消息可能已被替换（乐观 → 真实），只在仍指向同一条时落地。
    if (!needsPresenceProbe.value || msg.value.msg_id !== msgId) return;
    attachmentMissing.value = !present;
    if (!present) previewNote.value = "已被清理";
  }

  // 显式读 path/name/subtype：Vue 对 watcher 返回的数组做浅比对，若源里不包含这些字段的读取，
  // optimistic({path:""})→real({path:"/…",name:"x"}) 替换时 msg_id+subtype 不变 → 不触发。
  watch(
    () =>
      [
        previewSubtype.value,
        needsPresenceProbe.value,
        msg.value.msg_id,
        fileMeta.value?.path,
        fileMeta.value?.name,
      ] as const,
    () => void ensureAttachmentPreview(),
    { immediate: true },
  );

  /** 消息流里的代码：inline code 消息取 content，代码附件取本地读到的文本。 */
  const streamCode = computed<string | null>(() => {
    if (msg.value.kind === "code") return msg.value.content;
    return attachmentCode.value;
  });
  const streamCodeClamped = computed(() =>
    streamCode.value ? codeNeedsClamp(streamCode.value) : false,
  );

  /**
   * 文件是否已就绪可打开：本地路径非空**且文件确实还在**
   * （发送方＝源文件；接收方＝传输完成落盘，路径经 file_transfers 持久化）。
   * 只看路径是不够的——「存储清理」删掉文件后消息里的 path 仍然存在，
   * 这时必须显示「已被清理」，而不是让用户点开才发现打不开。
   */
  const fileReady = computed(() => !!fileMeta.value?.path && !attachmentMissing.value);

  async function openFile() {
    const path = fileMeta.value?.path;
    if (!path) {
      app.toast("文件路径不可用", "error");
      return;
    }
    try {
      await openPath(path);
    } catch (e) {
      app.toast(`打开文件失败：${e}`, "error");
    }
  }

  async function saveAs() {
    const source = fileMeta.value?.path;
    const filename = fileMeta.value?.name;
    if (!source || !filename) {
      app.toast("文件路径不可用", "error");
      return;
    }
    try {
      const destination = await save({ defaultPath: filename });
      if (!destination) return; // 用户取消
      await invoke("copy_file", { source, destination });
      app.toast("文件已保存", "success");
    } catch (e) {
      app.toast(`保存文件失败：${e}`, "error");
    }
  }

  return {
    transfer,
    fileMeta,
    fileReady,
    fileProgress,
    fileStatusText,
    attachmentUrl,
    attachmentMissing,
    previewNote,
    previewSubtype,
    streamCode,
    streamCodeClamped,
    openFile,
    saveAs,
  };
}
